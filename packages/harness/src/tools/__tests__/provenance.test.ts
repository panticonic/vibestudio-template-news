import { describe, expect, it, vi } from "vitest";
import {
  createProvenanceTool,
  type ProvenanceToolDeps,
  type ProvenanceToolDetails,
  type ProvenanceToolDiagnostic,
} from "../provenance.js";

const working = { kind: "event" as const, eventId: "event:working" };

function detailsOf(result: {
  details: ProvenanceToolDetails | ProvenanceToolDiagnostic;
}): ProvenanceToolDetails {
  if ("diagnostic" in result.details) {
    throw new Error(`Expected provenance details, received ${result.details.diagnostic}`);
  }
  return result.details;
}

function fixture() {
  const status = vi.fn(async () => ({
    contextId: "context:1",
    committed: working,
    workingHead: working,
    clean: true,
    mainEventId: "event:main",
    mainRelation: "at" as const,
    workingCounts: { applications: 0, workUnits: 0, changes: 0 },
    integrating: [],
  }));
  const neighbors = vi.fn(async (input: Parameters<ProvenanceToolDeps["vcs"]["neighbors"]>[0]) => {
    if (input.root.kind === "event") {
      return {
        root: input.root,
        edges: [
          {
            kind: "contains-repository" as const,
            from: input.root,
            to: {
              kind: "repository" as const,
              state: input.root,
              repositoryId: "repository:packages/foo",
            },
          },
        ],
        nextCursor: null,
      };
    }
    if (input.root.kind === "work-unit") {
      return {
        root: input.root,
        edges: [
          {
            kind: "authored-change" as const,
            from: input.root,
            to: { kind: "change" as const, changeId: "change:1" },
          },
        ],
        nextCursor: "cursor:next",
      };
    }
    if (input.root.kind === "applied-change") {
      return {
        root: input.root,
        edges: [
          {
            kind: "realizes-change" as const,
            from: input.root,
            to: { kind: "change" as const, changeId: "change:1" },
          },
        ],
        nextCursor: null,
      };
    }
    if (input.root.kind === "command") {
      if (input.root.commandId === "command:direct") {
        return { root: input.root, edges: [], nextCursor: null };
      }
      return {
        root: input.root,
        edges: [
          {
            kind: "caused-by" as const,
            from: input.root,
            to: {
              kind: "trajectory-invocation" as const,
              logId: "log:1",
              head: "head:1",
              invocationId: "invocation:1",
            },
          },
        ],
        nextCursor: null,
      };
    }
    if (input.root.kind === "trajectory-invocation") {
      return {
        root: input.root,
        edges: [
          {
            kind: "part-of-turn" as const,
            from: input.root,
            to: {
              kind: "trajectory-turn" as const,
              logId: input.root.logId,
              head: input.root.head,
              turnId: "turn:1",
            },
          },
          {
            kind: "part-of-trajectory" as const,
            from: input.root,
            to: { kind: "trajectory" as const, logId: input.root.logId, head: input.root.head },
          },
        ],
        nextCursor: null,
      };
    }
    if (input.root.kind === "trajectory-turn") {
      return {
        root: input.root,
        edges: [
          {
            kind: "triggered-by" as const,
            from: input.root,
            to: {
              kind: "trajectory-message" as const,
              logId: input.root.logId,
              head: input.root.head,
              messageId: "message:prompt",
            },
          },
        ],
        nextCursor: null,
      };
    }
    if (input.root.kind === "trajectory-message") {
      return {
        root: input.root,
        edges: [
          {
            kind: "triggered-by" as const,
            from: {
              kind: "trajectory-turn" as const,
              logId: input.root.logId,
              head: input.root.head,
              turnId: "turn:1",
            },
            to: input.root,
          },
        ],
        nextCursor: null,
      };
    }
    return {
      root: input.root,
      edges: [
        {
          kind: "caused-by" as const,
          from: input.root,
          to: { kind: "command" as const, commandId: "command:1" },
        },
      ],
      nextCursor: "cursor:next",
    };
  });
  const inspect = vi.fn(
    async (
      input: Parameters<ProvenanceToolDeps["vcs"]["inspect"]>[0]
    ): ReturnType<ProvenanceToolDeps["vcs"]["inspect"]> => {
      const common = { root: input.node, edges: [], hasMoreEdges: false };
      switch (input.node.kind) {
        case "external-delta":
          return {
            ...common,
            node: {
              kind: "external-delta" as const,
              value: {
                deltaId: input.node.deltaId,
                workUnitId: "work-unit:external",
                repositoryId: "repository:foo",
                repoPath: "packages/foo",
                oldSnapshot: `snapshot:${"1".repeat(64)}`,
                newSnapshot: `snapshot:${"2".repeat(64)}`,
                changeCount: 1,
                changeIds: ["change:external"],
                status: "active" as const,
              },
            },
          };
        case "repository":
          return {
            ...common,
            node: {
              kind: "repository" as const,
              state: input.node.state,
              value: {
                kind: "present" as const,
                repositoryId: input.node.repositoryId,
                repoPath: "packages/foo",
                manifestId: "manifest:1",
              },
            },
          };
        case "file":
          return {
            ...common,
            node: {
              kind: "file" as const,
              state: input.node.state,
              value: {
                kind: "placed" as const,
                fileId: input.node.fileId,
                repositoryId: input.node.repositoryId,
                path: "bar.ts",
                contentHash: "blob:1",
                mode: 0o644,
                contentKind: "text" as const,
                byteLength: 7,
                coordinateExtent: 7,
              },
            },
          };
        case "trajectory":
          return { ...common, node: { kind: "trajectory" as const, value: input.node } };
        case "work-unit":
          return {
            ...common,
            node: {
              kind: "work-unit" as const,
              value: {
                workUnitId: input.node.workUnitId,
                commandId: "command:1",
                kind: "edit" as const,
                authoredChangeCount: 1,
                authoredChangeIds: ["change:1"],
                incorporatedChangeCount: 0,
                incorporatedChangeIds: [],
                decisionCount: 0,
                decisionIds: [],
                intent: { text: "Rename the public entry point", tier: "stated" as const },
                intentSummary: "Rename the public entry point",
                authorContextId: "context:1",
                triggerEvidence: null,
                externalSnapshot: null,
                contentClass: "internal" as const,
                externalKeys: [],
                normalizationProtocol: "normalization:1",
                createdAt: "2026-07-15T10:00:00.000Z",
              },
            },
          };
        case "command":
          return {
            ...common,
            node: {
              kind: "command" as const,
              value: {
                commandId: input.node.commandId,
                workspaceId: "workspace:1",
                contextId: "context:1",
                method: "vcs.edit",
                status: "complete" as const,
                result: { kind: "work-unit" as const, workUnitId: "work-unit:1" },
                createdAt: "2026-07-15T10:00:00.000Z",
                completedAt: "2026-07-15T10:00:01.000Z",
              },
            },
          };
        case "trajectory-invocation":
          return {
            ...common,
            node: {
              kind: "trajectory-invocation" as const,
              value: {
                logId: input.node.logId,
                head: input.node.head,
                invocationId: input.node.invocationId,
                turnId: "turn:1",
                name: "provenance",
                status: "complete",
                terminalOutcome: "success",
                requestRef: {
                  protocol: "vibestudio.blob-ref.v1",
                  digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  size: 48,
                  encoding: "json",
                  originalBytes: 48,
                },
                startedEventId: "trajectory-event:start",
                completedEventId: "trajectory-event:complete",
              },
            },
          };
        case "trajectory-turn":
          return {
            ...common,
            node: {
              kind: "trajectory-turn" as const,
              value: {
                logId: input.node.logId,
                head: input.node.head,
                turnId: input.node.turnId,
                triggerMessageId: "message:prompt",
                openedAt: "2026-07-15T10:00:00.000Z",
                closedAt: "2026-07-15T10:00:01.000Z",
                summary: "Move the parser without losing its identity",
                ordinal: 1,
              },
            },
          };
        case "trajectory-message":
          return {
            ...common,
            node: {
              kind: "trajectory-message" as const,
              value: {
                logId: input.node.logId,
                head: input.node.head,
                messageId: input.node.messageId,
                turnId: "turn:1",
                role: "user",
                status: "completed",
                startedEventId: null,
                completedEventId: "trajectory-event:prompt",
                sourceMessageId: "channel-message:prompt",
                senderRef: { kind: "user", id: "user:alice", participantId: "user:alice" },
                textBlocks: [{ blockId: "block:prompt", content: "Move the parser" }],
              },
            },
          };
        case "change":
          return {
            ...common,
            node: {
              kind: "change" as const,
              value: {
                changeId: input.node.changeId,
                authoredByWorkUnitId: "work-unit:1",
                operation: 0,
                kind: "text-edit" as const,
                effects: [
                  {
                    kind: "content" as const,
                    fileId: "file:bar",
                    beforeContentHash: "blob:before",
                    afterContentHash: "blob:after",
                  },
                ],
                counteractsChangeIds: [],
                effectDigest: "digest:1",
                normalizationProtocol: "normalization:1",
              },
            },
          };
        case "applied-change":
          return {
            ...common,
            node: {
              kind: "applied-change" as const,
              value: {
                appliedChangeId: input.node.appliedChangeId,
                applicationId: "application:1",
                changeId: "change:1",
                ordinal: 0,
                appliedEffects: [
                  {
                    kind: "content" as const,
                    fileId: "file:bar",
                    beforeContentHash: "blob:before",
                    afterContentHash: "blob:after",
                  },
                ],
                resultPredicate: null,
              },
            },
          };
        case "decision":
          return {
            ...common,
            node: {
              kind: "decision" as const,
              value: {
                decisionId: input.node.decisionId,
                intent: { text: "Keep the current implementation", tier: "stated" as const },
                sourceIntents: [],
                sourceState: working,
                targetBasis: working,
                entries: [
                  {
                    coordinate: { kind: "file" as const, id: "file:source" },
                    resolution: "ours" as const,
                    accountedSourceChangeIds: ["change:source"],
                    rationale: "Not relevant to this context",
                  },
                ],
              },
            },
          };
        case "event":
        case "application":
          throw new Error(`unused ${input.node.kind} inspection fixture`);
      }
    }
  );
  const readFile = vi.fn(async () => ({
    repositoryId: "repository:packages/foo",
    fileId: "file:bar",
    repoPath: "packages/foo",
    path: "bar.ts",
    contentHash: "blob:1",
    authoredChangeId: "change:1",
    authoredByWorkUnitId: "work:1",
    contentClass: "internal" as const,
    externalKeys: [],
    mode: 0o644,
    content: { kind: "text" as const, text: "content" },
  }));
  const resolveRepository = vi.fn(
    async (input: Parameters<ProvenanceToolDeps["vcs"]["resolveRepository"]>[0]) => ({
      state: input.state,
      repositoryId: "repository:packages/foo",
      repoPath: "packages/foo",
    })
  );
  const history = vi.fn(async (input: Parameters<ProvenanceToolDeps["vcs"]["history"]>[0]) => ({
    root: input.root,
    entries: [
      {
        node: { kind: "change" as const, changeId: "change:file-edit" },
        createdAt: "2026-07-15T10:00:00.000Z",
        summary: "Explain the public entry point",
      },
    ],
    nextCursor: "cursor:history",
  }));
  const value: ProvenanceToolDeps = {
    vcs: { status, resolveRepository, neighbors, inspect, readFile, history },
    contextId: "context:1",
    session: { logId: "log:1", head: "head:1" },
  };
  return { value, status, resolveRepository, neighbors, inspect, readFile, history };
}

describe("createProvenanceTool", () => {
  it("resolves a friendly repository path to its typed repository node", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:repository", { target: "packages/foo" });

    expect(f.resolveRepository).toHaveBeenCalledWith({
      state: working,
      repoPath: "packages/foo",
    });
    expect(f.neighbors).toHaveBeenLastCalledWith({
      root: {
        kind: "repository",
        state: working,
        repositoryId: "repository:packages/foo",
      },
      limit: 5,
    });
    expect(f.inspect).toHaveBeenCalledWith({
      node: {
        kind: "repository",
        state: working,
        repositoryId: "repository:packages/foo",
      },
      edgeLimit: 1,
    });
    expect(f.readFile).not.toHaveBeenCalled();
    expect(f.history).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      target: "packages/foo",
      root: {
        kind: "repository",
        repositoryId: "repository:packages/foo",
      },
    });
  });

  it("resolves a friendly file path to a typed file node and pages neighbors", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:1", { target: "packages/foo/bar.ts" });

    expect(f.neighbors).toHaveBeenLastCalledWith({
      root: {
        kind: "file",
        state: working,
        repositoryId: "repository:packages/foo",
        fileId: "file:bar",
      },
      limit: 5,
    });
    expect(result.details).toMatchObject({ target: "packages/foo/bar.ts", edges: 1 });
    expect(f.inspect).toHaveBeenCalledWith({
      node: {
        kind: "file",
        state: working,
        repositoryId: "repository:packages/foo",
        fileId: "file:bar",
      },
      edgeLimit: 1,
    });
    expect(f.history).toHaveBeenCalledWith({
      root: {
        kind: "file",
        state: working,
        repositoryId: "repository:packages/foo",
        fileId: "file:bar",
      },
      direction: "past",
      limit: 5,
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain('past · change:file-edit · "Explain the public entry point"');
    expect(text).toContain(
      'more file history → vcs.history({"root":{"kind":"file","state":{"kind":"event","eventId":"event:working"},"repositoryId":"repository:packages/foo","fileId":"file:bar"},"direction":"past","cursor":"cursor:history","limit":5})'
    );
    expect(result.details).toMatchObject({
      history: [
        {
          node: { kind: "change", changeId: "change:file-edit" },
          summary: "Explain the public entry point",
        },
      ],
      historyNextCursor: "cursor:history",
    });
  });

  it("resolves a repository-root path without pretending it is a file", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:repo", { target: "packages/foo" });

    const root = {
      kind: "repository" as const,
      state: working,
      repositoryId: "repository:packages/foo",
    };
    expect(f.resolveRepository).toHaveBeenCalledWith({
      state: working,
      repoPath: "packages/foo",
    });
    expect(f.neighbors).toHaveBeenLastCalledWith({ root, limit: 5 });
    expect(f.inspect).toHaveBeenCalledWith({ node: root, edgeLimit: 1 });
    expect(f.readFile).not.toHaveBeenCalled();
    expect(f.history).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ target: "packages/foo", root });
  });

  it("walks the exact session trajectory node", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    await tool.execute("call:2", { target: "session" });
    expect(f.neighbors).toHaveBeenCalledWith({
      root: { kind: "trajectory", logId: "log:1", head: "head:1" },
      limit: 5,
    });
  });

  it("accepts the canonical workspace-event identity returned by VCS status", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);

    await expect(
      tool.execute("call:workspace-event", {
        target: "workspace-event:abc123",
      })
    ).rejects.toThrow("unused event inspection fixture");

    expect(f.value.vcs.inspect).toHaveBeenCalledWith({
      node: { kind: "event", eventId: "workspace-event:abc123" },
      edgeLimit: 1,
    });
  });

  it("converts a supported semantic shorthand", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    await tool.execute("call:3", { target: "change:42" });
    expect(f.neighbors).toHaveBeenCalledWith({
      root: { kind: "change", changeId: "change:42" },
      limit: 5,
    });
    await tool.execute("call:applied", { target: "applied-change:42" });
    expect(f.neighbors).toHaveBeenCalledWith({
      root: { kind: "applied-change", appliedChangeId: "applied-change:42" },
      limit: 5,
    });
  });

  it("passes an exact typed node through unchanged with its cursor", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const root = { kind: "decision" as const, decisionId: "decision:1" };
    await tool.execute("call:4", { target: root, after: "cursor:1" });
    expect(f.neighbors).toHaveBeenCalledWith({ root, limit: 5, cursor: "cursor:1" });
  });

  it("renders work-unit intent before exact adjacency and retains its endpoints", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:work", { target: "work-unit:1" });
    const details = detailsOf(result);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain(
      'node · work-unit · edit · stated: "Rename the public entry point" · command command:1'
    );
    expect(text).toContain(
      '{"kind":"work-unit","workUnitId":"work-unit:1"} —authored-change→ {"kind":"change","changeId":"change:1"}'
    );
    expect(text.indexOf("node ·")).toBeLessThan(text.indexOf("—authored-change→"));
    expect(details.adjacency).toEqual([
      {
        kind: "authored-change",
        from: { kind: "work-unit", workUnitId: "work-unit:1" },
        to: { kind: "change", changeId: "change:1" },
      },
    ]);
  });

  it("renders command state and trajectory-invocation metadata", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const command = await tool.execute("call:command", { target: "command:1" });
    const invocation = await tool.execute("call:invocation", {
      target: {
        kind: "trajectory-invocation",
        logId: "log:1",
        head: "head:1",
        invocationId: "invocation:1",
      },
    });
    const commandText = command.content[0]?.type === "text" ? command.content[0].text : "";
    const invocationText = invocation.content[0]?.type === "text" ? invocation.content[0].text : "";

    expect(commandText).toContain("node · command · vcs.edit · complete · context context:1");
    expect(invocationText).toContain(
      'node · trajectory-invocation · name "provenance" · status complete · turn turn:1 · outcome success'
    );
    expect(invocationText).toContain(
      'request aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa · json · 48 bytes · read services.blobstore.getText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")'
    );
    expect(invocationText).toContain(
      '{"kind":"trajectory-invocation","logId":"log:1","head":"head:1","invocationId":"invocation:1"} —part-of-trajectory→ {"kind":"trajectory","logId":"log:1","head":"head:1"}'
    );
    expect(invocationText.indexOf("node ·")).toBeLessThan(
      invocationText.indexOf("—part-of-trajectory→")
    );
  });

  it("renders a direct command as an honest causal endpoint", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:direct", { target: "command:direct" });
    const details = detailsOf(result);
    const rendered = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(rendered).toContain("node · command · vcs.edit · complete · context context:1");
    expect(details.root).toEqual({ kind: "command", commandId: "command:direct" });
    expect(details.adjacency).toEqual([]);
    expect(rendered).not.toContain("trajectory-invocation");
  });

  it("renders the exact intent-bearing turn and triggering message", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const turn = await tool.execute("call:turn", {
      target: {
        kind: "trajectory-turn",
        logId: "log:1",
        head: "head:1",
        turnId: "turn:1",
      },
    });
    const message = await tool.execute("call:message", {
      target: {
        kind: "trajectory-message",
        logId: "log:1",
        head: "head:1",
        messageId: "message:prompt",
      },
    });
    const turnDetails = detailsOf(turn);
    const turnText = turn.content[0]?.type === "text" ? turn.content[0].text : "";
    const messageText = message.content[0]?.type === "text" ? message.content[0].text : "";

    expect(turnText).toContain(
      "node · trajectory-turn · ordinal 1 · trigger message:prompt · summary"
    );
    expect(messageText).toContain(
      'node · trajectory-message · role user · status completed · turn turn:1 · source channel-message:prompt · sender user:user:alice participant user:alice · text "Move the parser"'
    );
    expect(turnDetails.root).toEqual({
      kind: "trajectory-turn",
      logId: "log:1",
      head: "head:1",
      turnId: "turn:1",
    });
    expect(turnDetails.adjacency).toContainEqual({
      kind: "triggered-by",
      from: turnDetails.root,
      to: {
        kind: "trajectory-message",
        logId: "log:1",
        head: "head:1",
        messageId: "message:prompt",
      },
    });
  });

  it("returns a corrective diagnostic for non-target vocabulary", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    await expect(tool.execute("call:5", { target: "outcome:42" })).resolves.toMatchObject({
      details: {
        diagnostic: "invalid-target",
        target: "outcome:42",
      },
    });
    await expect(tool.execute("call:service", { target: "vcs" })).resolves.toMatchObject({
      details: {
        diagnostic: "invalid-target",
        target: "vcs",
      },
    });
  });

  it("guides ambiguous trajectory labels toward exact typed roots", async () => {
    const f = fixture();
    const tool = createProvenanceTool("/", f.value);
    const result = await tool.execute("call:trajectory-label", {
      target: "trajectory-message:message:prompt",
    });
    expect(result).toMatchObject({
      details: {
        diagnostic: "invalid-target",
        target: "trajectory-message:message:prompt",
      },
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Trajectory nodes require the exact typed target");
  });
});
