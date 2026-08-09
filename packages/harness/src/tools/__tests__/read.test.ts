import { describe, it, expect, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createReadTool } from "../read.js";
import { StubFs } from "./stub-fs.js";

const CWD = "/work/ctx";

describe("createReadTool", () => {
  it("reads a small text file", async () => {
    const fs = new StubFs({ files: { [`${CWD}/hello.txt`]: "hello\nworld" } });
    const readFile = vi.spyOn(fs, "readFile");
    const tool = createReadTool(CWD, fs);
    const result = await tool.execute("call-1", { path: "hello.txt" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "hello\nworld" });
    expect(result.details.path).toBe("hello.txt");
    expect(readFile).toHaveBeenCalledWith(`${CWD}/hello.txt`, "utf8");
  });

  it("injects bounded blame-backed memory for the exact managed text range", async () => {
    const fs = new StubFs({
      files: { ["/packages/example/src/value.ts"]: "first\nsecond\nthird" },
    });
    const readMemory = vi.fn(async () => ({
      status: "attached" as const,
      state: { kind: "event" as const, eventId: "event:current" },
      repositoryId: "repository:example",
      fileId: "file:value",
      path: "packages/example/src/value.ts",
      contentHash: "a".repeat(64),
      range: { start: 6, end: 12 },
      coordinateKind: "utf16" as const,
      episodes: [
        {
          ranges: [{ start: 6, end: 12 }],
          stop: "authored" as const,
          change: { kind: "change" as const, changeId: "change:value" },
          appliedChange: {
            kind: "applied-change" as const,
            appliedChangeId: "applied-change:value",
          },
          workUnit: { kind: "work-unit" as const, workUnitId: "work-unit:value" },
          command: { kind: "command" as const, commandId: "command:value" },
          changeKind: "text-edit" as const,
          counteractsChangeIds: [],
          intent: { text: "Keep the retry budget owned by the caller", tier: "stated" as const },
          authorContextId: "context:author",
          createdAt: "2026-07-01T10:00:00.000Z",
          externalSnapshot: null,
          commit: {
            event: { kind: "event" as const, eventId: "event:value" },
            message: "Preserve caller-owned retries",
            createdAt: "2026-07-01T10:01:00.000Z",
          },
          arrival: null,
        },
      ],
      history: [],
      truncated: false,
    }));
    const tool = createReadTool("/", fs, {
      provenance: {
        vcs: { readMemory } as never,
        context: { contextId: "context:test" },
      },
    });

    const result = await tool.execute("call-memory", {
      path: "packages/example/src/value.ts",
      offset: 2,
      limit: 1,
    });

    expect(readMemory).toHaveBeenCalledWith({
      contextId: "context:test",
      path: "packages/example/src/value.ts",
      expectedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      range: { start: 6, end: 12 },
      episodeLimit: 4,
      historyLimit: 3,
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/^second(?:\n|$)/u),
    });
    expect(result.content[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        "workspace memory · why packages/example/src/value.ts lines 2-2 exist"
      ),
    });
    expect((result.content[1] as { text: string }).text).toContain(
      'stated: "Keep the retry budget owned by the caller"'
    );
    expect((result.content[1] as { text: string }).text).toContain(
      'change {"kind":"change","changeId":"change:value"}'
    );
    expect(result.details).toMatchObject({
      displayedRange: {
        coordinateKind: "utf16",
        start: 6,
        end: 12,
        startLine: 2,
        endLine: 2,
      },
      provenance: { status: "attached", fileId: "file:value" },
    });
  });

  it("keeps managed file content visible when read-time memory is unavailable", async () => {
    const fs = new StubFs({
      files: { ["/packages/example/src/value.ts"]: "export const value = 1;" },
    });
    const tool = createReadTool("/", fs, {
      provenance: {
        vcs: {
          readMemory: vi.fn(async () => {
            throw new Error("semantic projection unavailable");
          }),
        } as never,
        context: { contextId: "context:test" },
      },
    });

    const result = await tool.execute("call-memory-failure", {
      path: "packages/example/src/value.ts",
    });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "export const value = 1;",
    });
    expect(result.content).toHaveLength(1);
    expect(result.details.provenance).toEqual({
      status: "unavailable",
      path: "packages/example/src/value.ts",
      reason: "semantic projection unavailable",
    });
  });

  it("retries a transient runtime transport failure inside the same read invocation", async () => {
    const fs = new StubFs({ files: { [`${CWD}/hello.txt`]: "hello" } });
    const originalReadFile = fs.readFile.bind(fs);
    const readFile = vi
      .spyOn(fs, "readFile")
      .mockRejectedValueOnce(
        new Error(
          "DO dispatch fetch failed: fetch failed (cause: SocketError: other side closed code=UND_ERR_SOCKET)"
        )
      )
      .mockImplementation(originalReadFile);
    const tool = createReadTool(CWD, fs);

    await expect(tool.execute("call-1", { path: "hello.txt" })).resolves.toMatchObject({
      content: [{ type: "text", text: "hello" }],
    });
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("returns a bounded directory listing instead of failing the turn", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/skills/git/SKILL.md`]: "# Git",
        [`${CWD}/skills/README.md`]: "skills",
      },
    });
    const stat = vi.spyOn(fs, "stat");
    const tool = createReadTool(CWD, fs);

    const result = await tool.execute("call-1", { path: "skills" });

    expect(result.details).toMatchObject({
      path: "skills",
      engine: "runtime-fs",
      directory: true,
    });
    expect((result.content[0] as { text: string }).text).toBe("README.md\ngit/");
    expect(stat).not.toHaveBeenCalled();
  });

  it("returns a successful discovery diagnostic with nearby entries for a missing path", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/panel/index.ts`]: "export {};",
        [`${CWD}/panel/package.json`]: "{}",
      },
    });
    const tool = createReadTool(CWD, fs);

    const result = await tool.execute("call-1", {
      path: "panel/index.html",
    });

    expect(result.details).toMatchObject({
      path: "panel/index.html",
      missing: true,
      suggestions: expect.arrayContaining(["index.ts", "package.json"]),
    });
    expect((result.content[0] as { text: string }).text).toContain("Use ls/find");
  });

  it("resolves a unique workspace skill name when its guessed skills/ path is absent", async () => {
    const fs = new StubFs();
    const rpc = {
      call: vi.fn(async (_target: string, method: string) => {
        if (method === "extensions.invoke") {
          const error = new Error("ENOENT: guessed skill path is absent") as Error & {
            code: string;
          };
          error.code = "ENOENT";
          throw error;
        }
        if (method === "workspace.listSkills") {
          return [
            {
              name: "git-bridge",
              dirPath: "extensions/git-bridge",
              skillPath: "extensions/git-bridge/SKILL.md",
            },
          ];
        }
        if (method === "workspace.readSkill") return "# Git Bridge\n";
        throw new Error(`Unexpected RPC ${method}`);
      }),
      stream: vi.fn(async () => new Response()),
    };
    const tool = createReadTool(CWD, fs, { rpc: rpc as never });

    const result = await tool.execute("call-1", {
      path: "skills/git-bridge/SKILL.md",
    });

    expect(result.content[0]).toMatchObject({ type: "text", text: "# Git Bridge\n" });
    expect(result.details).toMatchObject({
      path: "extensions/git-bridge/SKILL.md",
      extensionFallback: "workspace-skill-alias:skills/git-bridge/SKILL.md",
    });
  });

  it("validates and executes the minimal serialized call", async () => {
    const fs = new StubFs({ files: { [`${CWD}/hello.txt`]: "hello\nworld" } });
    const tool = createReadTool(CWD, fs);
    const input = { path: "hello.txt" };

    expect(Value.Check(tool.parameters, input)).toBe(true);
    const result = await tool.execute("call-1", input);
    expect(result.content[0]).toMatchObject({ type: "text", text: "hello\nworld" });
  });

  it("accepts file resource references returned by discovery tools", async () => {
    const fs = new StubFs({ files: { [`${CWD}/hello.txt`]: "hello\nworld" } });
    const tool = createReadTool(CWD, fs);
    const input = { target: "file:hello.txt", kind: "file" as const };

    expect(Value.Check(tool.parameters, input)).toBe(true);
    const result = await tool.execute("call-1", input);
    expect(result.content[0]).toMatchObject({ type: "text", text: "hello\nworld" });
    expect(result.details.path).toBe("hello.txt");
  });

  it("respects offset and limit", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const fs = new StubFs({ files: { [`${CWD}/big.txt`]: lines } });
    const tool = createReadTool(CWD, fs);
    const result = await tool.execute("call-1", {
      path: "big.txt",
      offset: 3,
      limit: 2,
    });
    const text = (result.content[0] as { text: string }).text;
    // Selected slice "line 3\nline 4" plus a continuation hint.
    expect(text).toContain("line 3");
    expect(text).toContain("line 4");
    expect(text).not.toContain("line 5\n");
  });

  it("returns a successful bounded diagnostic when offset is past EOF", async () => {
    const fs = new StubFs({ files: { [`${CWD}/small.txt`]: "one\ntwo" } });
    const tool = createReadTool(CWD, fs);

    const result = await tool.execute("call-1", {
      path: "small.txt",
      offset: 615,
    });

    expect((result.content[0] as { text: string }).text).toContain(
      "Offset 615 is beyond end of file (2 lines total)"
    );
    expect(result.details).toMatchObject({ path: "small.txt", engine: "runtime-fs" });
  });

  it("reads text through the scoped runtime filesystem even when context rpc is available", async () => {
    const fs = new StubFs({ files: { [`${CWD}/big.txt`]: "line 1\nline 2\nline 3\nline 4" } });
    const readFile = vi.spyOn(fs, "readFile");
    const stat = vi.spyOn(fs, "stat");
    const access = vi.spyOn(fs, "access");
    const rpc = {
      call: vi.fn().mockResolvedValue([]),
      stream: vi.fn(async () => new Response()),
    };
    const tool = createReadTool(CWD, fs, { rpc });

    const result = await tool.execute("call-1", {
      path: "big.txt",
      offset: 3,
      limit: 2,
    });

    expect((result.content[0] as { text: string }).text).toBe("line 3\nline 4");
    expect(result.details).toMatchObject({ path: "big.txt", engine: "runtime-fs" });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(stat).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(rpc.call).not.toHaveBeenCalledWith(
      "main",
      "extensions.invoke",
      expect.arrayContaining(["@workspace-extensions/file-tools"])
    );
  });

  it("reads known text files without requiring the optional image extension", async () => {
    const fs = new StubFs({ files: { [`${CWD}/guide.md`]: "approval guide" } });
    const unavailable = Object.assign(new Error("Extension is not installed"), {
      code: "ENOEXT",
    });
    const rpc = {
      call: vi.fn().mockImplementation((_target: string, method: string, args: unknown[]) => {
        if (
          method === "extensions.invoke" &&
          (args as unknown[])[0] === "@workspace-extensions/file-tools"
        ) {
          return Promise.reject(unavailable);
        }
        if (
          method === "extensions.invoke" &&
          (args as unknown[])[0] === "@workspace-extensions/image-service"
        ) {
          return Promise.reject(unavailable);
        }
        return Promise.resolve([]);
      }),
      stream: vi.fn(async () => new Response()),
    };
    const tool = createReadTool(CWD, fs, { rpc });

    await expect(tool.execute("call-1", { path: "guide.md" })).resolves.toMatchObject({
      content: [{ type: "text", text: "approval guide" }],
      details: { path: "guide.md", engine: "runtime-fs" },
    });
    expect(rpc.call).not.toHaveBeenCalledWith(
      "main",
      "extensions.invoke",
      expect.arrayContaining(["@workspace-extensions/image-service"])
    );
  });

  it("keeps image reads on the image-service path", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fs = new StubFs({ files: { [`${CWD}/pic.png`]: pngBytes } });
    const readFile = vi.spyOn(fs, "readFile");
    const rpc = {
      call: vi.fn().mockImplementation((_target: string, method: string, args: unknown[]) => {
        if (method === "extensions.streamingMethods") return Promise.resolve([]);
        const [extensionName, extensionMethod] = args;
        expect(method).toBe("extensions.invoke");
        expect(extensionName).toBe("@workspace-extensions/image-service");
        if (extensionMethod === "detectMimeType") return Promise.resolve("image/png");
        if (extensionMethod === "resize") {
          return Promise.resolve({
            data: Buffer.from(pngBytes).toString("base64"),
            mimeType: "image/png",
            width: 8,
            height: 8,
            originalWidth: 8,
            originalHeight: 8,
            wasResized: false,
          });
        }
        return Promise.resolve(null);
      }),
      stream: vi.fn(async () => new Response()),
    };
    const tool = createReadTool(CWD, fs, { rpc });

    const result = await tool.execute("call-1", { path: "pic.png" });

    const last = result.content[result.content.length - 1] as { type: string; mimeType: string };
    expect(last.type).toBe("image");
    expect(last.mimeType).toBe("image/png");
    expect(readFile).toHaveBeenCalledWith(`${CWD}/pic.png`, undefined);
    expect(rpc.call).not.toHaveBeenCalledWith(
      "main",
      "extensions.invoke",
      expect.arrayContaining(["@workspace-extensions/file-tools", "read"])
    );
  });

  it("magic-sniffs extensionless runtime screenshots as image content", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const screenshotPath = `${CWD}/.tmp/panel-capture-123`;
    const fs = new StubFs({ files: { [screenshotPath]: pngBytes } });
    const readFile = vi.spyOn(fs, "readFile");
    const rpc = {
      call: vi.fn().mockImplementation((_target: string, method: string, args: unknown[]) => {
        if (method === "extensions.streamingMethods") return Promise.resolve([]);
        const [, extensionMethod] = args;
        if (extensionMethod === "detectMimeType") return Promise.resolve("image/png");
        if (extensionMethod === "resize") {
          return Promise.resolve({
            data: Buffer.from(pngBytes).toString("base64"),
            mimeType: "image/png",
            width: 8,
            height: 8,
            originalWidth: 8,
            originalHeight: 8,
            wasResized: false,
          });
        }
        return Promise.resolve(null);
      }),
      stream: vi.fn(async () => new Response()),
    };
    const tool = createReadTool(CWD, fs, { rpc });

    const result = await tool.execute("call-opaque-image", {
      target: "file:/.tmp/panel-capture-123",
      kind: "file",
    });

    expect(result.content).toEqual([
      expect.objectContaining({ type: "image", mimeType: "image/png" }),
    ]);
    expect(result.details).toMatchObject({
      path: screenshotPath,
      mimeType: "image/png",
      originalSize: pngBytes.length,
    });
    expect(readFile).toHaveBeenCalledWith(screenshotPath, undefined);
  });

  it("returns a non-poisoning discovery result when a file is missing", async () => {
    const fs = new StubFs();
    const tool = createReadTool(CWD, fs);
    await expect(tool.execute("call-1", { path: "missing.txt" })).resolves.toMatchObject({
      details: { missing: true, path: "missing.txt" },
    });
  });

  it("returns ImageContent when the image service extension detects an image type", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fs = new StubFs({ files: { [`${CWD}/pic.png`]: pngBytes } });
    const rpc = {
      call: vi.fn().mockImplementation((_target: string, method: string, args: unknown[]) => {
        if (method === "extensions.streamingMethods") return Promise.resolve([]);
        const [extensionName, extensionMethod] = args;
        expect(method).toBe("extensions.invoke");
        expect(extensionName).toBe("@workspace-extensions/image-service");
        if (extensionMethod === "detectMimeType") return Promise.resolve("image/png");
        if (extensionMethod === "resize") {
          return Promise.resolve({
            data: Buffer.from(pngBytes).toString("base64"),
            mimeType: "image/png",
            width: 8,
            height: 8,
            originalWidth: 8,
            originalHeight: 8,
            wasResized: false,
          });
        }
        return Promise.resolve(null);
      }),
      stream: vi.fn(async () => new Response()),
    };
    const tool = createReadTool(CWD, fs, { rpc });
    const result = await tool.execute("call-1", { path: "pic.png" });
    const last = result.content[result.content.length - 1] as { type: string; mimeType: string };
    expect(last.type).toBe("image");
    expect(last.mimeType).toBe("image/png");
  });

  it("aborts when signal is already aborted", async () => {
    const fs = new StubFs({ files: { [`${CWD}/foo.txt`]: "x" } });
    const tool = createReadTool(CWD, fs);
    const ac = new AbortController();
    ac.abort();
    await expect(tool.execute("call-1", { path: "foo.txt" }, ac.signal)).rejects.toThrow(/abort/i);
  });
});
