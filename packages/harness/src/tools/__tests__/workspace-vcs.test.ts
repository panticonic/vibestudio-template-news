import { describe, expect, it, vi } from "vitest";
import { createWorkspaceVcsTool, type ToolWorkflowVcs } from "../workspace-vcs.js";

function fixture() {
  const working = { kind: "application" as const, applicationId: "application:working" };
  const status = vi.fn<ToolWorkflowVcs["status"]>(async () => ({
    contextId: "context:test",
    committed: { kind: "event" as const, eventId: "event:committed" },
    workingHead: working,
    clean: false,
    mainEventId: "event:main",
    mainRelation: "ahead" as const,
    workingCounts: { applications: 2, workUnits: 2, changes: 3 },
    integrating: [],
  }));
  const compare = vi.fn(async (input: Parameters<ToolWorkflowVcs["compare"]>[0]) => ({
    target: input.target,
    source: input.source,
    base: { kind: "event" as const, eventId: "event:base" },
    resolution: { complete: false, remainingCoordinateCount: 1, concluded: false },
    counts: { adopt: 1, convergent: 0, composed: 0, conflict: 0, resolved: 0 },
    intentCounts: { merged: 0, settled: 0, split: 0, contested: 0, pending: 1 },
    coordinates: [
      {
        coordinate: { kind: "file" as const, id: "file:source" },
        paths: {
          base: "packages/demo/a.ts",
          ours: "packages/demo/a.ts",
          theirs: "packages/demo/a.ts",
        },
        status: "adopt" as const,
        aspects: [
          {
            aspect: "content" as const,
            base: { hash: "blob:base" },
            ours: { hash: "blob:base" },
            theirs: { hash: "blob:source" },
            status: "adopt" as const,
          },
        ],
        attribution: {
          ours: [],
          theirs: [{ changeId: "change:source", workUnitId: "work:source" }],
        },
        resolutions: ["theirs" as const, "ours" as const, "current" as const],
        summary: "adopt file packages/demo/a.ts",
      },
    ],
    intents: [
      {
        workUnitId: "work:source",
        side: "theirs" as const,
        intent: { text: "Update the source", tier: "stated" as const },
        coordinates: [{ kind: "file" as const, id: "file:source" }],
        state: "pending" as const,
      },
    ],
    intentsTruncated: false,
    nextCursor: null,
  }));
  const merge = vi.fn(async (input: Parameters<ToolWorkflowVcs["merge"]>[0]) => ({
    status: "working" as const,
    commandId: input.commandId,
    contextId: input.contextId,
    workUnitId: "work:merge",
    applicationId: "application:merge",
    changeCount: 0,
    changeIds: [],
    incorporatedChangeCount: 1,
    incorporatedChangeIds: ["change:source"],
    decisionIds: ["decision:merge"],
    workingHead: { kind: "application" as const, applicationId: "application:merge" },
    decisionId: "decision:merge",
    outcomes: [],
    resolution: { complete: true, remainingCoordinateCount: 0, concluded: true },
    intents: [
      {
        workUnitId: "work:source",
        side: "theirs" as const,
        state: "merged" as const,
        intent: { text: "Update the source", tier: "stated" as const },
        coordinates: [{ kind: "file" as const, id: "file:source" }],
      },
    ],
    intentsTruncated: false,
    counts: { adopt: 0, convergent: 0, composed: 0, conflict: 0, resolved: 1 },
    conflicts: [],
    nextConflictCursor: null,
    composed: [
      {
        coordinate: { kind: "file" as const, id: "file:source" },
        ours: { text: "Preserve the local validation", tier: "stated" as const },
        theirs: { text: "Update the source", tier: "stated" as const },
      },
    ],
  }));
  const revert = vi.fn();
  const commit = vi.fn(async (input: Parameters<ToolWorkflowVcs["commit"]>[0]) => ({
    contextId: input.contextId,
    event: { kind: "event" as const, eventId: "event:integrated" },
    committedApplicationIds: ["application:working"],
    integrationSourceEventIds: ["event:source"],
  }));
  const discard = vi.fn(async (input: Parameters<ToolWorkflowVcs["discard"]>[0]) => ({
    contextId: input.contextId,
    workingHead: { kind: "event" as const, eventId: "event:committed" },
    discardedApplicationIds: ["application:first", "application:working"],
  }));
  const blame = vi.fn<ToolWorkflowVcs["blame"]>(async (input) => ({
    state: input.state,
    fileId: input.fileId,
    coordinateKind: "utf16" as const,
    spans: [
      {
        start: input.range.start,
        end: input.range.end,
        change: { kind: "change", changeId: "change:origin" },
        appliedChange: {
          kind: "applied-change",
          appliedChangeId: "applied-change:origin",
        },
        workUnit: { kind: "work-unit", workUnitId: "work-unit:origin" },
        workUnitId: "work-unit:origin",
        tier: "stated",
        command: { kind: "command", commandId: "command:origin" },
        path: [],
        stop: "authored",
      },
    ],
    nextCursor: null,
  }));
  const push = vi.fn(async (input: Parameters<ToolWorkflowVcs["push"]>[0]) => ({
    contextId: input.contextId,
    eventId: input.expectedCommittedEventId,
    mainEventId: input.expectedCommittedEventId,
    effectId: "effect:push",
    appliedAt: "2026-07-15T00:00:00.000Z",
  }));
  const resolveRepository = vi.fn(async () => ({
    state: working,
    repositoryId: "repository:packages/demo",
    repoPath: "packages/demo",
  }));
  const vcs = {
    status,
    compare,
    merge,
    revert,
    commit,
    discard,
    blame,
    push,
    resolveRepository,
    neighbors: vi.fn(async () => ({
      root: working,
      edges: [
        {
          kind: "contains-repository" as const,
          from: working,
          to: {
            kind: "repository" as const,
            state: working,
            repositoryId: "repository:packages/demo",
          },
        },
      ],
      nextCursor: null,
    })),
    inspect: vi.fn(async (input) => ({
      root: input.node,
      node: {
        kind: "repository" as const,
        state: working,
        value: {
          kind: "present" as const,
          repositoryId: "repository:packages/demo",
          repoPath: "packages/demo",
          manifestId: "manifest:demo",
        },
      },
      edges: [],
      hasMoreEdges: false,
    })),
    readFile: vi.fn(async () => ({
      repositoryId: "repository:packages/demo",
      fileId: "file:demo",
      repoPath: "packages/demo",
      path: "a.ts",
      contentHash: "blob:demo",
      mode: 0o644,
      content: { kind: "text" as const, text: "hello" },
    })),
  } as unknown as ToolWorkflowVcs;
  return {
    vcs,
    status,
    compare,
    merge,
    commit,
    discard,
    blame,
    push,
    working,
  };
}

describe("workspace VCS agent tool", () => {
  it("orients and compares from the current working state", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:orient",
    });

    const status = await tool.execute("call:status", { operation: "status" });
    expect(status.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("dirty"),
    });

    const compared = await tool.execute("call:compare", {
      operation: "compare",
      sourceEventId: "event:source",
    });
    expect(f.compare).toHaveBeenCalledWith(
      expect.objectContaining({
        target: f.working,
        source: { kind: "event", eventId: "event:source" },
      })
    );
    expect(compared.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("file:file:source"),
    });
  });

  it("compares the local working application directly against protected main", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:local-compare",
    });

    const compared = await tool.execute("call:local-compare", {
      operation: "compare",
      view: "local",
    });

    expect(f.compare).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "event", eventId: "event:main" },
        source: f.working,
      })
    );
    expect(compared.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Local working state relative to protected main"),
    });
  });

  it("exposes one compare command schema with both explicit source selectors", () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:compare-schema",
    });
    const compareBranches = (tool.parameters as { anyOf: Array<Record<string, unknown>> }).anyOf
      .filter((branch) => JSON.stringify(branch).includes('"const":"compare"'));

    expect(compareBranches).toHaveLength(1);
    expect(JSON.stringify(compareBranches[0])).toContain('"sourceEventId"');
    expect(JSON.stringify(compareBranches[0])).toContain('"view"');
  });

  it("rejects an ambiguous compare selector before reading semantic state", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:ambiguous-compare",
    });

    await expect(
      tool.execute("call:ambiguous-compare", {
        operation: "compare",
        view: "local",
        sourceEventId: "event:source",
      })
    ).rejects.toThrow(/exactly one source selector/);
    expect(f.status).not.toHaveBeenCalled();
    expect(f.compare).not.toHaveBeenCalled();
  });

  it("leaves filesystem browsing to the dedicated filesystem tools", () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:schema",
    });
    const contract = JSON.stringify({
      description: tool.description,
      parameters: tool.parameters,
    });

    expect(contract).toContain(
      "Browse and edit ordinary paths with the dedicated filesystem tools"
    );
    expect(contract).not.toContain('"const":"listDirectory"');
    expect(contract).not.toContain('"const":"listFiles"');
  });

  it("inspects and pages exact typed semantic roots without lower-level service fields", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:walk",
    });
    const root = {
      kind: "repository" as const,
      state: f.working,
      repositoryId: "repository:packages/demo",
    };

    const inspected = await tool.execute("call:inspect", {
      operation: "inspect",
      root,
      limit: 7,
    });
    expect(f.vcs.inspect).toHaveBeenCalledWith({ node: root, edgeLimit: 7 });
    expect(inspected.details).toMatchObject({ operation: "inspect", result: { root } });

    const neighbors = await tool.execute("call:neighbors", {
      operation: "neighbors",
      root,
      after: "cursor:next",
      limit: 9,
    });
    expect(f.vcs.neighbors).toHaveBeenCalledWith({
      root,
      cursor: "cursor:next",
      limit: 9,
    });
    expect(neighbors.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("contains-repository"),
    });
  });

  it("records one exact coordinate merge decision", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:merge",
    });
    const result = await tool.execute("call:merge", {
      operation: "merge",
      sourceEventId: "event:source",
      coordinates: [{ kind: "file", id: "file:source" }],
      intent: "Merge the source behavior after coordinate review",
    });
    expect(f.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: "context:test",
        expectedWorkingHead: f.working,
        source: { kind: "event", eventId: "event:source" },
        coordinates: [{ kind: "file", id: "file:source" }],
        intentSummary: "Merge the source behavior after coordinate review",
      })
    );
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(
        /Resolution: complete=true; concluded=true; remaining=0[\s\S]*Intent: theirs\/merged[\s\S]*Composed: file:file:source/
      ),
    });
  });

  it("passes an exact current-value resolution at the observed working head", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:reconcile",
    });

    await tool.execute("call:resolve", {
      operation: "merge",
      sourceEventId: "event:source",
      resolutions: [
        {
          coordinate: { kind: "file", id: "file:source" },
          resolution: "current",
          rationale: "The authored file preserves both intended behaviors.",
        },
      ],
    });

    expect(f.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: "context:test",
        expectedWorkingHead: f.working,
        source: { kind: "event", eventId: "event:source" },
        resolutions: [
          {
            coordinate: { kind: "file", id: "file:source" },
            resolution: "current",
            rationale: "The authored file preserves both intended behaviors.",
          },
        ],
      })
    );
  });

  it("passes an explicit ours resolution without filesystem evidence lookup", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:decline",
    });

    await tool.execute("call:decline", {
      operation: "merge",
      sourceEventId: "event:source",
      resolutions: [
        {
          coordinate: { kind: "file", id: "file:source" },
          resolution: "ours",
        },
      ],
    });
    expect(f.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        resolutions: [{ coordinate: { kind: "file", id: "file:source" }, resolution: "ours" }],
      })
    );
    expect(f.vcs.readFile).not.toHaveBeenCalled();
  });

  it("resolves a friendly file path for bounded blame", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:blame",
    });
    expect(JSON.stringify(tool.parameters)).toContain("This is not a line number");
    const result = await tool.execute("call:blame", {
      operation: "blame",
      path: "packages/demo/a.ts",
      start: 1,
      end: 4,
    });
    expect(f.blame).toHaveBeenCalledWith(
      expect.objectContaining({
        state: f.working,
        repositoryId: "repository:packages/demo",
        fileId: "file:demo",
        range: { start: 1, end: 4 },
      })
    );
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("command:origin"),
    });
  });

  it("discards the whole local chain from the live head with the invocation command", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:discard",
    });

    const result = await tool.execute("call:discard", { operation: "discard" });

    expect(f.discard).toHaveBeenCalledWith({
      contextId: "context:test",
      expectedWorkingHead: f.working,
      commandId: "command:discard",
    });
    expect(result.details).toEqual({
      operation: "discard",
      result: {
        contextId: "context:test",
        workingHead: { kind: "event", eventId: "event:committed" },
        discardedApplicationIds: ["application:first", "application:working"],
      },
    });
  });

  it("reports committed integration sources only after the clean commit is verified", async () => {
    const f = fixture();
    const onIntegrationSourcesCommitted = vi.fn();
    f.status.mockResolvedValueOnce({
      ...(await f.status({ contextId: "context:test" })),
      workingHead: f.working,
    });
    f.status.mockResolvedValueOnce({
      contextId: "context:test",
      committed: { kind: "event", eventId: "event:integrated" },
      workingHead: { kind: "event", eventId: "event:integrated" },
      clean: true,
      mainEventId: "event:main",
      mainRelation: "ahead",
      workingCounts: { applications: 0, workUnits: 0, changes: 0 },
      integrating: [],
    });
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:commit",
      onIntegrationSourcesCommitted,
    });

    await tool.execute("call:commit", { operation: "commit", message: "Integrate source" });

    expect(onIntegrationSourcesCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ integrationSourceEventIds: ["event:source"] })
    );
  });

  it("routes an incomplete integration refusal back to its supervised run", async () => {
    const f = fixture();
    f.commit.mockRejectedValueOnce(
      Object.assign(new Error("integration incomplete"), {
        errorData: {
          code: "IntegrationIncomplete",
          source: { kind: "event", eventId: "event:source" },
        },
      })
    );
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:commit",
      integrationSourceResolver: (sourceEventId) =>
        sourceEventId === "event:source" ? { runId: "run:child" } : null,
    });

    await expect(
      tool.execute("call:commit", { operation: "commit", message: "Integrate source" })
    ).rejects.toMatchObject({
      code: "IntegrationIncomplete",
      message: expect.stringContaining('merge_subagent({runId:"run:child"'),
      errorData: { runId: "run:child", recoveryTool: "merge_subagent" },
    });
  });

  it("points an import-terminal span to its exact inspectable boundary", async () => {
    const f = fixture();
    f.blame.mockResolvedValueOnce({
      state: f.working,
      fileId: "file:demo",
      coordinateKind: "utf16",
      spans: [
        {
          start: 0,
          end: 5,
          change: { kind: "change", changeId: "change:import" },
          appliedChange: {
            kind: "applied-change",
            appliedChangeId: "applied-change:import",
          },
          workUnit: { kind: "work-unit", workUnitId: "work-unit:import" },
          workUnitId: "work-unit:import",
          tier: "stated",
          command: { kind: "command", commandId: "command:import" },
          path: [],
          stop: "import-boundary",
        },
      ],
      nextCursor: null,
    });
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:blame-import",
    });

    const result = await tool.execute("call:blame-import", {
      operation: "blame",
      path: "packages/demo/a.ts",
    });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        'pass these typed roots unchanged to provenance: inspect terminal change {"kind":"change","changeId":"change:import"}, then owning import work unit {"kind":"work-unit","workUnitId":"work-unit:import"} for the exact external snapshot; earlier coordinate authorship is unknown'
      ),
    });
    expect(result.details).toMatchObject({
      result: {
        spans: [
          {
            change: { kind: "change", changeId: "change:import" },
            appliedChange: {
              kind: "applied-change",
              appliedChangeId: "applied-change:import",
            },
            workUnit: { kind: "work-unit", workUnitId: "work-unit:import" },
            command: { kind: "command", commandId: "command:import" },
          },
        ],
      },
    });
  });

  it("pushes with the exact committed and protected-main observations", async () => {
    const f = fixture();
    const tool = createWorkspaceVcsTool("/", f.vcs, {
      contextId: "context:test",
      commandId: "command:push",
    });
    await tool.execute("call:push", { operation: "push" });
    expect(f.push).toHaveBeenCalledWith({
      commandId: "command:push",
      contextId: "context:test",
      expectedCommittedEventId: "event:committed",
      expectedMainEventId: "event:main",
    });
  });
});
