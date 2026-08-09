/** Friendly graph-walking tool over the canonical `vcs.neighbors` primitive. */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import { vcsSemanticNodeRefSchema, type VcsSemanticNodeRef } from "@vibestudio/service-schemas/vcs";
import { splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import type { ToolVcs } from "./tool-vcs.js";
import { resolveToolFile } from "../semantic-file-resolution.js";
import { resolveToolWorkingState, toVcsPath } from "./tool-vcs.js";
import {
  renderProvenanceBlock,
  type CanonicalProvenanceHistory,
  type CanonicalProvenanceInspection,
  type CanonicalProvenanceResult,
} from "./provenance-format.js";

const ORIENTATION_EDGE_LIMIT = 5;

const stateRootSchema = Type.Union([
  Type.Object({ kind: Type.Literal("event"), eventId: Type.String() }),
  Type.Object({ kind: Type.Literal("application"), applicationId: Type.String() }),
]);

export const semanticRootSchema = Type.Union(
  [
    Type.Object({ kind: Type.Literal("event"), eventId: Type.String() }),
    Type.Object({ kind: Type.Literal("application"), applicationId: Type.String() }),
    Type.Object({ kind: Type.Literal("applied-change"), appliedChangeId: Type.String() }),
    Type.Object({ kind: Type.Literal("work-unit"), workUnitId: Type.String() }),
    Type.Object({ kind: Type.Literal("change"), changeId: Type.String() }),
    Type.Object({ kind: Type.Literal("decision"), decisionId: Type.String() }),
    Type.Object({ kind: Type.Literal("command"), commandId: Type.String() }),
    Type.Object({
      kind: Type.Literal("file"),
      state: stateRootSchema,
      repositoryId: Type.String(),
      fileId: Type.String(),
    }),
    Type.Object({
      kind: Type.Literal("repository"),
      state: stateRootSchema,
      repositoryId: Type.String(),
    }),
    Type.Object({
      kind: Type.Literal("trajectory"),
      logId: Type.String(),
      head: Type.String(),
    }),
    Type.Object({
      kind: Type.Literal("trajectory-invocation"),
      logId: Type.String(),
      head: Type.String(),
      invocationId: Type.String(),
    }),
    Type.Object({
      kind: Type.Literal("trajectory-turn"),
      logId: Type.String(),
      head: Type.String(),
      turnId: Type.String(),
    }),
    Type.Object({
      kind: Type.Literal("trajectory-message"),
      logId: Type.String(),
      head: Type.String(),
      messageId: Type.String(),
    }),
  ],
  {
    description:
      "Exact typed semantic root returned by provenance details or either endpoint of a returned edge. Copy it unchanged, especially for trajectory nodes.",
  }
);

const provenanceSchema = Type.Object({
  target: Type.Optional(
    Type.Union(
      [
        Type.String({
          description:
            'Existing managed file path (not an intermediate directory), exact repository root, "session", or semantic shorthand such as "workspace-event:...", "applied-change:...", "change:...", or "decision:...". A service, tool, package name, or general topic is not a target.',
        }),
        semanticRootSchema,
      ],
      {
        description:
          "A friendly string or one exact typed root returned by provenance details or an edge endpoint. Pass typed roots unchanged.",
      }
    )
  ),
  after: Type.Optional(
    Type.String({
      description:
        "Exact nextCursor from the preceding provenance result. Reuse it only with that result's unchanged target.",
    })
  ),
});

export type ProvenanceToolInput = Static<typeof provenanceSchema>;
export interface ProvenanceToolDetails {
  target: string;
  root: VcsSemanticNodeRef;
  node: CanonicalProvenanceInspection["node"];
  adjacency: CanonicalProvenanceResult["edges"];
  history?: CanonicalProvenanceHistory["entries"];
  historyNextCursor?: string;
  edges: number;
  nextCursor?: string;
}

export interface ProvenanceToolDiagnostic {
  diagnostic: "invalid-target";
  target: string;
  acceptedTargets: readonly [
    "session",
    "managed repository or file path",
    "event/application/applied-change/work-unit/change/decision/command identity",
    "exact typed root",
  ];
}

export interface WorkspacePathProvenanceDeps {
  vcs: Pick<ToolVcs, "status" | "resolveRepository" | "neighbors" | "inspect" | "readFile">;
  contextId: string | (() => string);
  session: { logId: string; head: string };
}

export interface ProvenanceToolDeps {
  vcs: Pick<
    ToolVcs,
    "status" | "resolveRepository" | "neighbors" | "inspect" | "readFile" | "history"
  >;
  contextId: string | (() => string);
  session: { logId: string; head: string };
}

function contextIdOf(deps: WorkspacePathProvenanceDeps): string {
  return typeof deps.contextId === "function" ? deps.contextId() : deps.contextId;
}

function semanticRootForTarget(
  target: string,
  session: WorkspacePathProvenanceDeps["session"]
): VcsSemanticNodeRef {
  if (target.startsWith("event:") || target.startsWith("workspace-event:")) {
    return { kind: "event", eventId: target };
  }
  if (target.startsWith("application:")) return { kind: "application", applicationId: target };
  if (target.startsWith("applied-change:")) {
    return { kind: "applied-change", appliedChangeId: target };
  }
  if (target.startsWith("work-unit:")) return { kind: "work-unit", workUnitId: target };
  if (target.startsWith("change:")) return { kind: "change", changeId: target };
  if (target.startsWith("decision:")) return { kind: "decision", decisionId: target };
  if (target.startsWith("command:")) return { kind: "command", commandId: target };
  if (target === "session") return { kind: "trajectory", ...session };
  if (target.startsWith("trajectory")) {
    throw new Error(
      "Trajectory nodes require the exact typed target with kind, logId, head, and invocationId/turnId/messageId as applicable; copy the complete edge endpoint into target"
    );
  }
  throw new Error(
    `Provenance target must be a workspace path, session, or event/application/applied-change/work-unit/change/decision/command identity; received ${target}`
  );
}

function invalidTargetResult(target: string, message: string) {
  const acceptedTargets = [
    "session",
    "managed repository or file path",
    "event/application/applied-change/work-unit/change/decision/command identity",
    "exact typed root",
  ] as const;
  return {
    content: [
      {
        type: "text" as const,
        text: `${message}\nUse "session", an existing managed repository/file path, a returned semantic identity, or an exact typed root. Service and tool names are not provenance targets.`,
      },
    ],
    details: {
      diagnostic: "invalid-target" as const,
      target,
      acceptedTargets,
    },
  };
}

function parseRoot(input: unknown): VcsSemanticNodeRef {
  const parsed = vcsSemanticNodeRefSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new Error(`Invalid typed semantic root: ${parsed.error.issues[0]?.message ?? "unknown"}`);
}

function rootLabel(root: VcsSemanticNodeRef): string {
  switch (root.kind) {
    case "event":
      return root.eventId;
    case "external-delta":
      return root.deltaId;
    case "application":
      return root.applicationId;
    case "applied-change":
      return root.appliedChangeId;
    case "work-unit":
      return root.workUnitId;
    case "change":
      return root.changeId;
    case "decision":
      return root.decisionId;
    case "command":
      return root.commandId;
    case "file":
      return `${root.repositoryId}/${root.fileId}`;
    case "repository":
      return root.repositoryId;
    case "trajectory":
      return `${root.logId}@${root.head}`;
    case "trajectory-invocation":
      return `${root.invocationId} @ ${root.logId}@${root.head}`;
    case "trajectory-turn":
      return `${root.turnId} @ ${root.logId}@${root.head}`;
    case "trajectory-message":
      return `${root.messageId} @ ${root.logId}@${root.head}`;
  }
}

export async function neighborsForWorkspacePath(
  cwd: string,
  deps: WorkspacePathProvenanceDeps,
  rawPath: string,
  options: { cursor?: string; limit?: number } = {}
): Promise<{
  label: string;
  root: Extract<VcsSemanticNodeRef, { kind: "file" | "repository" }>;
  result: CanonicalProvenanceResult;
}> {
  const workspacePath = toVcsPath(rawPath, cwd);
  const workingHead = await resolveToolWorkingState(deps.vcs, {
    contextId: () => contextIdOf(deps),
  });
  const split = splitRepoPath(workspacePath);
  if (!split) throw new Error(`${workspacePath} is not inside a workspace repository`);
  if (!split.repoRelPath) {
    const repository = await deps.vcs.resolveRepository({
      state: workingHead,
      repoPath: split.repoPath,
    });
    if (!repository) {
      throw new Error(`Repository ${split.repoPath} is not present in the working state`);
    }
    const root: Extract<VcsSemanticNodeRef, { kind: "repository" }> = {
      kind: "repository",
      state: workingHead,
      repositoryId: repository.repositoryId,
    };
    const result = await deps.vcs.neighbors({
      root,
      limit: options.limit ?? 10,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
    return { label: workspacePath, root, result };
  }
  const file = await resolveToolFile(deps.vcs, workingHead, workspacePath);
  if (!file) {
    throw new Error(
      `No file identity at ${workspacePath} in the working state. Provenance paths must name an existing managed file or an exact repository root; use ls for intermediate directories.`
    );
  }
  const root: Extract<VcsSemanticNodeRef, { kind: "file" }> = {
    kind: "file",
    state: workingHead,
    repositoryId: file.repositoryId,
    fileId: file.fileId,
  };
  const result = await deps.vcs.neighbors({
    root,
    limit: options.limit ?? 10,
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
  return { label: workspacePath, root, result };
}

function toolResult(
  target: string,
  inspection: CanonicalProvenanceInspection,
  result: CanonicalProvenanceResult,
  history: CanonicalProvenanceHistory | undefined,
  continuation: NonNullable<Parameters<typeof renderProvenanceBlock>[0]["continuation"]>
) {
  const details: ProvenanceToolDetails = {
    target,
    root: inspection.root,
    node: inspection.node,
    adjacency: result.edges,
    ...(history
      ? {
          history: history.entries,
          ...(history.nextCursor ? { historyNextCursor: history.nextCursor } : {}),
        }
      : {}),
    edges: result.edges.length,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
  return {
    content: [
      {
        type: "text" as const,
        text:
          renderProvenanceBlock({ label: target, inspection, history, result, continuation }) ??
          `prov · ${target} · unavailable`,
      },
    ],
    details,
  };
}

export function createProvenanceTool(
  cwd: string,
  deps: ProvenanceToolDeps
): AgentTool<typeof provenanceSchema, ProvenanceToolDetails | ProvenanceToolDiagnostic> {
  return {
    name: "provenance",
    label: "provenance",
    executionMode: "parallel",
    description:
      'Inspect "session", an exact semantic identity/root, or an existing managed repository/file path and walk one bounded adjacency page. Service/tool/package names are not targets. Managed files also include a small exact change-history preview.',
    parameters: provenanceSchema,
    execute: async (_toolCallId, input) => {
      const cursor = typeof input.after === "string" && input.after ? input.after : undefined;
      if (input.target && typeof input.target === "object") {
        const root = parseRoot(input.target);
        const [inspection, neighbors, history] = await Promise.all([
          deps.vcs.inspect({ node: root, edgeLimit: 1 }),
          deps.vcs.neighbors({
            root,
            limit: ORIENTATION_EDGE_LIMIT,
            ...(cursor ? { cursor } : {}),
          }),
          root.kind === "file"
            ? deps.vcs.history({ root, direction: "past", limit: 5 })
            : Promise.resolve(undefined),
        ]);
        return toolResult(rootLabel(root), inspection, neighbors, history, {
          kind: "root",
          root,
          includeCursor: true,
        });
      }
      const target = String(input.target ?? "session").trim() || "session";
      const path = target.startsWith("file:") ? target.slice(5) : target;
      if (splitRepoPath(path)) {
        const page = await neighborsForWorkspacePath(cwd, deps, path, {
          cursor,
          limit: ORIENTATION_EDGE_LIMIT,
        });
        const [inspection, history] = await Promise.all([
          deps.vcs.inspect({ node: page.root, edgeLimit: 1 }),
          page.root.kind === "file"
            ? deps.vcs.history({ root: page.root, direction: "past", limit: 5 })
            : Promise.resolve(undefined),
        ]);
        return toolResult(page.label, inspection, page.result, history, {
          kind: "target",
          target: page.label,
          includeCursor: true,
        });
      }
      let root: VcsSemanticNodeRef;
      try {
        root = semanticRootForTarget(target, deps.session);
      } catch (error) {
        return invalidTargetResult(
          target,
          error instanceof Error ? error.message : `Invalid provenance target: ${target}`
        );
      }
      const [inspection, neighbors] = await Promise.all([
        deps.vcs.inspect({ node: root, edgeLimit: 1 }),
        deps.vcs.neighbors({
          root,
          limit: ORIENTATION_EDGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        }),
      ]);
      return toolResult(target, inspection, neighbors, undefined, {
        kind: "root",
        root,
        includeCursor: true,
      });
    },
  };
}
