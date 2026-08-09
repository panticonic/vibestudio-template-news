/** Compact agent workflow over the canonical semantic VCS methods. */

import { Type } from "@sinclair/typebox";
import { canonicalJson, sha256HexSyncText } from "@vibestudio/content-addressing";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import type {
  VcsCommitResult,
  VcsDiscardResult,
  VcsInspectResult,
  VcsNeighborsResult,
  VcsSemanticNodeRef,
  VcsStatusResult,
  VcsWorkingMutationResult,
} from "@vibestudio/service-schemas/vcs";
import { driveMerge, renderCompareReview, renderMergeReview } from "../merge-driver.js";
import { semanticRootSchema } from "./provenance.js";
import { resolveToolFile } from "../semantic-file-resolution.js";
import {
  resolveToolWorkingState,
  toVcsPath,
  toolCommandId,
  toolContextId,
  type ToolVcs,
  type ToolMutationContext,
} from "./tool-vcs.js";

const coordinateSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("file"), id: Type.String({ minLength: 1 }) },
    { additionalProperties: false }
  ),
  Type.Object(
    { kind: Type.Literal("repository"), id: Type.String({ minLength: 1 }) },
    { additionalProperties: false }
  ),
]);

const workspaceVcsSchema = Type.Union([
  Type.Object({ operation: Type.Literal("status") }, { additionalProperties: false }),
  Type.Object(
    {
      operation: Type.Literal("inspect"),
      root: semanticRootSchema,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      operation: Type.Literal("neighbors"),
      root: semanticRootSchema,
      after: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      operation: Type.Literal("compare"),
      sourceEventId: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Exact incoming committed event; omit when view is local.",
        })
      ),
      view: Type.Optional(
        Type.Literal("local", {
          description:
            "Compare the complete current working state, including uncommitted applications, against protected main; omit when sourceEventId is present.",
        })
      ),
      status: Type.Optional(Type.Literal("conflict")),
      after: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      operation: Type.Literal("merge"),
      sourceEventId: Type.String({ minLength: 1 }),
      coordinates: Type.Optional(Type.Array(coordinateSchema, { maxItems: 500 })),
      resolutions: Type.Optional(
        Type.Union([
          Type.Array(
            Type.Object(
              {
                coordinate: coordinateSchema,
                resolution: Type.Union([
                  Type.Literal("composed"),
                  Type.Literal("theirs"),
                  Type.Literal("ours"),
                  Type.Literal("current"),
                ]),
                rationale: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
              },
              { additionalProperties: false }
            ),
            { maxItems: 500 }
          ),
          Type.Object(
            {
              allRemaining: Type.Object(
                {
                  resolution: Type.Union([Type.Literal("ours"), Type.Literal("current")]),
                  rationale: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
                },
                { additionalProperties: false }
              ),
            },
            { additionalProperties: false }
          ),
        ])
      ),
      intent: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      operation: Type.Literal("revert"),
      changeIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 200 }),
      intent: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      operation: Type.Literal("commit"),
      message: Type.String({
        minLength: 1,
        description: "Durable intent summary for the one atomic workspace event.",
      }),
      intent: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false }
  ),
  Type.Object({ operation: Type.Literal("discard") }, { additionalProperties: false }),
  Type.Object(
    {
      operation: Type.Literal("blame"),
      path: Type.String({ minLength: 1 }),
      start: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Zero-based UTF-16 content offset (byte offset for binary); omit start and end to blame the full file. This is not a line number.",
        })
      ),
      end: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Exclusive zero-based UTF-16 content offset (byte offset for binary); omit start and end to blame the full file. This is not a line number.",
        })
      ),
      after: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    },
    { additionalProperties: false }
  ),
  Type.Object({ operation: Type.Literal("push") }, { additionalProperties: false }),
]);

export type WorkspaceVcsToolInput =
  | { operation: "status" }
  | { operation: "inspect"; root: VcsSemanticNodeRef; limit?: number }
  | { operation: "neighbors"; root: VcsSemanticNodeRef; after?: string; limit?: number }
  | {
      operation: "compare";
      sourceEventId?: string;
      view?: "local";
      status?: "conflict";
      after?: string;
      limit?: number;
    }
  | {
      operation: "merge";
      sourceEventId: string;
      coordinates?: Array<{ kind: "file" | "repository"; id: string }>;
      resolutions?:
        | Array<{
            coordinate: { kind: "file" | "repository"; id: string };
            resolution: "composed" | "theirs" | "ours" | "current";
            rationale?: string;
          }>
        | { allRemaining: { resolution: "ours" | "current"; rationale?: string } };
      intent?: string;
    }
  | { operation: "revert"; changeIds: string[]; intent?: string }
  | { operation: "commit"; message: string; intent?: string }
  | { operation: "discard" }
  | {
      operation: "blame";
      path: string;
      start?: number;
      end?: number;
      after?: string;
      limit?: number;
    }
  | { operation: "push" };

export interface WorkspaceVcsToolDetails {
  operation: WorkspaceVcsToolInput["operation"];
  result: unknown;
  status?: VcsStatusResult;
  roots?: VcsSemanticNodeRef[];
}

export type ToolWorkflowVcs = Pick<
  ToolVcs,
  | "status"
  | "inspect"
  | "neighbors"
  | "compare"
  | "merge"
  | "revert"
  | "commit"
  | "discard"
  | "blame"
  | "push"
  | "resolveRepository"
  | "readFile"
>;

function mutationText(verb: string, result: VcsWorkingMutationResult): string {
  return (
    `${verb} in ${result.applicationId}; work unit ${result.workUnitId}; ` +
    `${result.changeCount} authored and ${result.incorporatedChangeCount} incorporated changes ` +
    `(${result.changeIds.length} authored and ${result.incorporatedChangeIds.length} incorporated in preview).` +
    (result.changeIds.length > 0 ? ` Authored changes: ${result.changeIds.join(", ")}.` : "") +
    (result.incorporatedChangeIds.length > 0
      ? ` Incorporated changes: ${result.incorporatedChangeIds.join(", ")}.`
      : "")
  );
}

function edgeText(result: Pick<VcsInspectResult | VcsNeighborsResult, "edges">): string[] {
  return result.edges.map(
    (edge) =>
      `${edge.kind} · ${JSON.stringify(edge.from)} → ${JSON.stringify(edge.to)}` +
      (edge.summary ? ` · ${edge.summary}` : "")
  );
}

export function createWorkspaceVcsTool(
  cwd: string,
  vcs: ToolWorkflowVcs,
  context: ToolMutationContext
): AgentTool<typeof workspaceVcsSchema, WorkspaceVcsToolDetails> {
  return {
    name: "vcs",
    label: "vcs",
    description:
      "Inspect and change semantic workspace history: compare intent and coordinate net effects (use compare view:'local' for working state relative to protected main), merge, review composed results, revert, commit, discard, blame, or push. Browse and edit ordinary paths with the dedicated filesystem tools.",
    parameters: workspaceVcsSchema,
    execute: async (
      _toolCallId,
      input,
      signal
    ): Promise<AgentToolResult<WorkspaceVcsToolDetails>> => {
      if (signal?.aborted) throw new Error("Operation aborted");
      const contextId = toolContextId(context);
      // AgentTool invokes execute only after validating the TypeBox union.
      const command = input as WorkspaceVcsToolInput;

      if (command.operation === "status") {
        const result = await vcs.status({ contextId });
        const integrationText = result.integrating
          .map((entry) => {
            const source =
              entry.source.kind === "event" ? entry.source.eventId : entry.source.deltaId;
            const state =
              entry.remainingCoordinateCount === 0 && entry.concluded
                ? "complete"
                : entry.mergeableCoordinateCount > 0
                  ? "integrating"
                  : "needs-decision";
            const consequence = entry.stale
              ? "snapshot is stale; commit will revalidate exactly"
              : state === "complete"
                ? "ready to commit"
                : "commit will refuse until complete";
            return `${state} ${entry.source.kind}:${source} — ${entry.remainingCoordinateCount} coordinates unaccounted, ${entry.conflictCoordinateCount} conflicts; ${consequence}`;
          })
          .join("\n");
        return resultOf(
          command.operation,
          `Context ${contextId} is ${result.clean ? "clean" : "dirty"}; ` +
            `${result.mainRelation} main at ${result.mainEventId}; committed ${stateLabel(result.committed)}; ` +
            `working ${stateLabel(result.workingHead)} (${result.workingCounts.applications} applications, ` +
            `${result.workingCounts.changes} changes).` +
            (integrationText ? `\n${integrationText}` : ""),
          result
        );
      }

      if (command.operation === "inspect") {
        const result = await vcs.inspect({
          node: command.root,
          edgeLimit: command.limit ?? 25,
        });
        const lines = [
          `Inspected ${JSON.stringify(result.root)} · ${JSON.stringify(result.node)}`,
          ...edgeText(result),
        ];
        if (result.hasMoreEdges) {
          lines.push(
            "More direct edges exist: use neighbors with this unchanged root to page them."
          );
        }
        return resultOf(command.operation, lines.join("\n"), result);
      }

      if (command.operation === "neighbors") {
        const result = await vcs.neighbors({
          root: command.root,
          ...(command.after ? { cursor: command.after } : {}),
          limit: command.limit ?? 25,
        });
        const lines = edgeText(result);
        if (result.nextCursor) {
          lines.push(`More edges: rerun neighbors with after=${result.nextCursor}`);
        }
        return resultOf(
          command.operation,
          lines.join("\n") || `No direct edges for ${JSON.stringify(result.root)}`,
          result
        );
      }

      if (command.operation === "compare") {
        const localView = command.view === "local";
        const sourceEventId = command.sourceEventId;
        if (localView === (sourceEventId !== undefined)) {
          throw new Error(
            "Compare requires exactly one source selector: view:'local' for current working state, or sourceEventId for incoming committed work."
          );
        }
        const status = localView ? await vcs.status({ contextId }) : null;
        const target = localView
          ? ({ kind: "event", eventId: status!.mainEventId } as const)
          : await resolveToolWorkingState(vcs, context);
        const source = sourceEventId
          ? ({ kind: "event", eventId: sourceEventId } as const)
          : status!.workingHead;
        const result = await vcs.compare({
          target,
          source,
          ...(command.status ? { statusFilter: command.status } : {}),
          ...(command.after ? { cursor: command.after } : {}),
          limit: command.limit ?? 100,
        });
        return resultOf(
          command.operation,
          `${localView ? "Local working state relative to protected main.\n" : ""}${renderCompareReview(result)}`,
          result
        );
      }

      if (command.operation === "merge") {
        const expectedWorkingHead = await resolveToolWorkingState(vcs, context);
        const baseCommandId = toolCommandId(context);
        const source = { kind: "event" as const, eventId: command.sourceEventId };
        const driven = await driveMerge({
          vcs,
          contextId,
          expectedWorkingHead,
          source,
          ...(command.coordinates ? { coordinates: command.coordinates } : {}),
          ...(command.resolutions ? { resolutions: command.resolutions } : {}),
          ...(command.intent ? { intentSummary: command.intent } : {}),
          headline: `Merge ${command.sourceEventId}`,
          commandIdForPage: ({ expectedWorkingHead: pageHead }) =>
            `${baseCommandId}:merge:${sha256HexSyncText(canonicalJson({ contextId, expectedWorkingHead: pageHead, source, coordinates: command.coordinates, resolutions: command.resolutions, intentSummary: command.intent }))}`,
        });
        return resultOf(
          command.operation,
          renderMergeReview(driven.review),
          driven
        );
      }

      if (command.operation === "revert") {
        const expectedWorkingHead = await resolveToolWorkingState(vcs, context);
        const result = await vcs.revert({
          contextId,
          expectedWorkingHead,
          commandId: toolCommandId(context),
          changeIds: command.changeIds,
          ...(command.intent ? { intentSummary: command.intent } : {}),
        });
        return resultOf(
          command.operation,
          mutationText("Reverted semantic changes", result),
          result
        );
      }

      if (command.operation === "commit") {
        const message = command.message.trim();
        if (!message) throw new Error("vcs commit requires a non-empty message");
        const expectedWorkingHead = await resolveToolWorkingState(vcs, context);
        let result: VcsCommitResult;
        try {
          result = await vcs.commit({
            contextId,
            expectedWorkingHead,
            commandId: toolCommandId(context),
            message,
            ...(command.intent ? { intentSummary: command.intent } : {}),
          });
        } catch (error) {
          const failure = error as {
            code?: unknown;
            errorData?: { code?: unknown; source?: { kind?: unknown; eventId?: unknown } };
          };
          const source = failure.errorData?.source;
          if (
            (failure.code === "IntegrationIncomplete" ||
              failure.errorData?.code === "IntegrationIncomplete") &&
            source?.kind === "event" &&
            typeof source.eventId === "string"
          ) {
            const run = context.integrationSourceResolver?.(source.eventId);
            if (run) {
              const message =
                `Integration of subagent ${run.runId} is incomplete. ` +
                `Call merge_subagent({runId:"${run.runId}", resolutions:{allRemaining:{resolution:"ours"}}}) to decline the remainder, ` +
                `or merge_subagent({runId:"${run.runId}", resolutions:{allRemaining:{resolution:"current", rationale:"…"}}}) after reviewing the combined parent state.`;
              throw Object.assign(new Error(message), {
                code: "IntegrationIncomplete",
                errorData: {
                  ...failure.errorData,
                  code: "IntegrationIncomplete",
                  runId: run.runId,
                  recoveryTool: "merge_subagent",
                },
              });
            }
          }
          throw error;
        }
        if (result.event.kind !== "event") throw new Error("vcs commit returned a non-event state");
        const status = await vcs.status({ contextId });
        if (
          !status.clean ||
          status.committed.kind !== "event" ||
          status.committed.eventId !== result.event.eventId ||
          status.workingHead.kind !== "event" ||
          status.workingHead.eventId !== result.event.eventId
        ) {
          throw new Error("vcs commit did not leave the context clean at the committed event");
        }
        context.onIntegrationSourcesCommitted?.(result);
        return {
          content: [
            {
              type: "text",
              text:
                `Committed workspace event ${result.event.eventId} locally with ` +
                `${result.committedApplicationIds.length} application${result.committedApplicationIds.length === 1 ? "" : "s"}; ` +
                "the context is clean at that event. Protected main was not changed; publication is a separate vcs push operation.",
            },
          ],
          details: { operation: command.operation, result, status },
        };
      }

      if (command.operation === "discard") {
        const expectedWorkingHead = await resolveToolWorkingState(vcs, context);
        const result: VcsDiscardResult = await vcs.discard({
          contextId,
          expectedWorkingHead,
          commandId: toolCommandId(context),
        });
        return resultOf(
          command.operation,
          `Discarded ${result.discardedApplicationIds.length} local application${result.discardedApplicationIds.length === 1 ? "" : "s"}; working state is now ${stateLabel(result.workingHead)}.`,
          result
        );
      }

      if (command.operation === "blame") {
        const state = await resolveToolWorkingState(vcs, context);
        const workspacePath = toVcsPath(command.path, cwd);
        const file = await resolveToolFile(vcs, state, workspacePath);
        if (!file) throw new Error(`No managed file at ${command.path}`);
        const contentLength =
          file.content.kind === "text"
            ? file.content.text.length
            : Buffer.from(file.content.base64, "base64").byteLength;
        const start = command.start ?? 0;
        const end = command.end ?? contentLength;
        if (end < start || end > contentLength) {
          throw new Error(`blame range ${start}..${end} is outside 0..${contentLength}`);
        }
        const result = await vcs.blame({
          state,
          repositoryId: file.repositoryId,
          fileId: file.fileId,
          range: { start, end },
          ...(command.after ? { cursor: command.after } : {}),
          limit: command.limit ?? 100,
        });
        const lines = result.spans.map(
          (span) =>
            `${span.start}..${span.end} · ${span.stop} · ` +
            `change ${JSON.stringify(span.change)} · applied change ${JSON.stringify(span.appliedChange)} · ` +
            `work ${JSON.stringify(span.workUnit)} · command ${JSON.stringify(span.command)}` +
            (span.stop === "import-boundary"
              ? ` · pass these typed roots unchanged to provenance: inspect terminal change ${JSON.stringify(span.change)}, then owning import work unit ${JSON.stringify(span.workUnit)} for the exact external snapshot; earlier coordinate authorship is unknown`
              : "")
        );
        if (result.nextCursor)
          lines.push(`More spans: rerun blame with after=${result.nextCursor}`);
        return resultOf(
          command.operation,
          lines.join("\n") || `No blame spans for ${workspacePath}`,
          result
        );
      }

      if (command.operation !== "push") {
        throw new Error("Unsupported vcs operation");
      }
      const status = await vcs.status({ contextId });
      if (status.committed.kind !== "event") throw new Error("Committed state is not an event");
      const result = await vcs.push({
        commandId: toolCommandId(context),
        contextId,
        expectedCommittedEventId: status.committed.eventId,
        expectedMainEventId: status.mainEventId,
      });
      return resultOf(
        command.operation,
        `Published ${result.eventId} as protected main ${result.mainEventId}.`,
        result
      );
    },
  };
}

function stateLabel(
  state: { kind: "event"; eventId: string } | { kind: "application"; applicationId: string }
) {
  return state.kind === "event" ? state.eventId : state.applicationId;
}

function resultOf(
  operation: WorkspaceVcsToolInput["operation"],
  text: string,
  result: unknown
): AgentToolResult<WorkspaceVcsToolDetails> {
  return {
    content: [{ type: "text", text }],
    details: { operation, result },
  };
}
