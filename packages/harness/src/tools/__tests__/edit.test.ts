import { describe, expect, it } from "vitest";
import { createEditTool } from "../edit.js";
import { StubFs } from "./stub-fs.js";
import { StubVcs } from "./stub-vcs.js";

const CWD = "/";
const authority = { contextId: "context:test", commandId: "command:edit" };

describe("canonical edit tool", () => {
  it("resolves exact file identity and records a guarded semantic change", async () => {
    const vcs = new StubVcs({ files: { "meta/a.ts": "const x = 1;\n" } });
    const tool = createEditTool(CWD, vcs, authority);
    const result = await tool.execute("invocation:1", {
      path: "meta/a.ts",
      oldText: "1",
      newText: "42",
      intent: "Align the fixture with the revised protocol version",
    });

    expect(vcs.read("meta/a.ts")).toBe("const x = 42;\n");
    expect(vcs.lastEditInput).toMatchObject({
      contextId: "context:test",
      expectedWorkingHead: { kind: "event", eventId: "event:committed" },
      commandId: "command:edit",
      intentSummary: "Align the fixture with the revised protocol version",
      changes: [
        {
          kind: "text-edit",
          repositoryId: "repository:meta",
          fileId: "file:meta/a.ts",
          edits: [{ start: 10, end: 11, text: "42" }],
        },
      ],
    });
    expect(result.details.storage).toBe("vcs");
    expect(tool.description).toContain('vcs({ operation: "revert"');
  });

  it("reports ambiguous text without mutating", async () => {
    const vcs = new StubVcs({ files: { "meta/a.ts": "foo\nfoo\n" } });
    const tool = createEditTool(CWD, vcs, authority);
    const result = await tool.execute("invocation:2", {
      path: "meta/a.ts",
      oldText: "foo",
      newText: "bar",
    });
    expect(result.details).toMatchObject({ diagnostic: "ambiguous", matchCount: 2 });
    expect(vcs.lastEditInput).toBeUndefined();
  });

  it("uses unchanged replacement context only for matching, not authorship", async () => {
    const vcs = new StubVcs({
      files: {
        "meta/a.ts":
          'export const value = "baseline";\nexport const neighbor = "untouched";\n',
      },
    });
    const tool = createEditTool(CWD, vcs, authority);
    await tool.execute("invocation:context", {
      path: "meta/a.ts",
      oldText: 'export const value = "baseline";\nexport const neighbor = "untouched";',
      newText: 'export const value = "edited";\nexport const neighbor = "untouched";',
    });

    expect(vcs.read("meta/a.ts")).toBe(
      'export const value = "edited";\nexport const neighbor = "untouched";\n'
    );
    expect(vcs.lastEditInput?.changes[0]).toMatchObject({
      kind: "text-edit",
      edits: [{ start: 22, end: 30, text: "edited" }],
    });
  });

  it("keeps non-repository scratch edits on the scoped filesystem", async () => {
    const vcs = new StubVcs();
    const fs = new StubFs({ files: { ".tmp/note.txt": "before" } });
    const tool = createEditTool(CWD, vcs, authority, fs);
    const result = await tool.execute("invocation:3", {
      path: ".tmp/note.txt",
      oldText: "before",
      newText: "after",
    });
    await expect(fs.readFile(".tmp/note.txt", "utf8")).resolves.toBe("after");
    expect(result.details.storage).toBe("scratch");
  });
});
