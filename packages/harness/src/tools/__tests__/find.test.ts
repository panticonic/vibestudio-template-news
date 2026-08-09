import { describe, it, expect, vi } from "vitest";
import { createFindTool } from "../find.js";
import { StubFs } from "./stub-fs.js";

const CWD = "/work/ctx";

describe("createFindTool", () => {
  it("returns actionable guidance when the pattern is omitted", async () => {
    const tool = createFindTool(CWD, new StubFs());
    const result = await tool.execute("call-1", {});
    expect((result.content[0] as { text: string }).text).toContain("No find pattern supplied");
  });

  it("finds files matching a glob", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/a.ts`]: "x",
        [`${CWD}/b.md`]: "x",
        [`${CWD}/sub/c.ts`]: "x",
      },
    });
    const tool = createFindTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "**/*.ts" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.ts");
    expect(text).toContain("sub/c.ts");
    expect(text).not.toContain("b.md");
  });

  it("returns 'No files found' when nothing matches", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "x" } });
    const tool = createFindTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "*.md" });
    expect((result.content[0] as { text: string }).text).toBe("No files found matching pattern");
  });

  it("returns a diagnostic empty result for a missing exploratory search root", async () => {
    const tool = createFindTool(CWD, new StubFs({ files: {} }));
    const result = await tool.execute("call-1", {
      path: "packages/missing",
      pattern: "*.ts",
    });

    expect((result.content[0] as { text: string }).text).toContain(
      "No files found matching pattern (search path does not exist: packages/missing)"
    );
    expect(result.details).toMatchObject({
      engine: "runtime-fs",
      missingSearchPath: "packages/missing",
    });
  });

  it("includes hidden (dot) files", async () => {
    const fs = new StubFs({
      files: { [`${CWD}/.hidden`]: "x", [`${CWD}/visible`]: "x" },
    });
    const tool = createFindTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "*" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(".hidden");
  });

  it("uses the context-scoped host glob when RPC is available", async () => {
    const fs = new StubFs({ files: { [`${CWD}/src/a.ts`]: "x" } });
    const stat = vi.spyOn(fs, "stat");
    const rpc = {
      call: vi.fn().mockResolvedValue([`${CWD}/src/a.ts`]),
      stream: vi.fn(async () => new Response()),
    };
    const tool = createFindTool(CWD, fs, { rpc });

    const result = await tool.execute("call-1", { pattern: "**/*.ts", path: ".", limit: 10 });

    expect((result.content[0] as { text: string }).text).toBe("src/a.ts");
    expect(rpc.call).toHaveBeenCalledWith(
      "main",
      "fs.glob",
      ["**/*.ts", { path: CWD }],
      undefined
    );
    expect(stat).not.toHaveBeenCalled();
  });

  it("bounds host glob results without issuing per-directory RPC calls", async () => {
    const fs = new StubFs({ files: { [`${CWD}/src/a.ts`]: "x" } });
    const rpc = {
      call: vi
        .fn()
        .mockResolvedValue([`${CWD}/src/a.ts`, `${CWD}/src/b.ts`, `${CWD}/src/c.ts`]),
    };
    const tool = createFindTool(CWD, fs, { rpc: rpc as never });

    const result = await tool.execute("call-1", { pattern: "**/*.ts", limit: 2 });

    expect((result.content[0] as { text: string }).text).toContain("src/a.ts");
    expect((result.content[0] as { text: string }).text).toContain("src/b.ts");
    expect((result.content[0] as { text: string }).text).not.toContain("src/c.ts");
    expect(result.details).toMatchObject({
      engine: "runtime-fs",
      resultLimitReached: 2,
    });
    expect(rpc.call).toHaveBeenCalledTimes(1);
  });
});
