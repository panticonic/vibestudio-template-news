/**
 * AgentWorkerBase — workspace-default channel agent DO base.
 *
 * The reusable event-sourced vessel lives in `AgentVesselBase`; this subclass
 * binds the workspace defaults (model, credential presets) and the standard
 * agent method roster.
 */

import { createRpcFs, type DurableObjectContext } from "@workspace/runtime/worker";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createProvenanceTool,
  createWriteTool,
  createMoveFileTool,
  createCopyFileTool,
  createWorkspaceVcsTool,
  createSuspendTurnTool,
  createEvalTool,
  createDocsSearchTool,
  createDocsOpenTool,
  createWorkspaceServiceTool,
  createWebTools,
  createToolVcs,
  loadVibestudioResources,
} from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { AgentTurnContextPolicy, ThinkingLevel } from "@workspace/agent-loop";
import { ids } from "@workspace/agent-loop";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import type { RpcClient } from "@vibestudio/rpc";
import type { VcsCommitResult } from "@vibestudio/service-schemas/vcs";
import { SUPPORTED_IMAGE_TYPES } from "@workspace/pubsub";
import {
  AgentVesselBase,
  subagentRunHandle,
  type AgentPromptResources,
  type AgentToolExecutionContext,
  type ApprovalLevel,
} from "./agent-vessel.js";
import { AgentHeartbeatLoop, type AgentHeartbeatLoopDeps } from "./agent-heartbeat-loop.js";
import { readSayAttachments } from "./say-attachments.js";
import {
  DEFAULT_APPROVAL_LEVEL,
  DEFAULT_MODEL,
  DEFAULT_RESPOND_POLICY,
  DEFAULT_THINKING_LEVEL,
  OPENAI_CODEX_ACCOUNT_CLAIM,
  PROVIDER_CREDENTIAL_SETUPS,
} from "./agent-config.js";
import type { RespondPolicy } from "@workspace/agent-loop";

type StandardAgentMethodName =
  | "pause"
  | "resume"
  | "scheduleResumeAtReset"
  | "credentialConnected"
  | "connectModelCredential"
  | "setModel"
  | "setThinkingLevel"
  | "setApprovalLevel"
  | "setRespondPolicy"
  | "refreshPromptArtifacts"
  | "getAgentSettings"
  | "getModelExecutionEvidence"
  | "getDebugState"
  | "inspectMethodSuspensions";

type StandardAgentMethodOptions = {
  include?: readonly StandardAgentMethodName[];
  exclude?: readonly StandardAgentMethodName[];
};

export function hasAskableUser(roster: readonly { ref: { kind: string } }[]): boolean {
  return roster.some((participant) => participant.ref.kind === "user");
}

function requireBoundMutationInvocation(): never {
  throw new Error("A semantic mutation cannot execute without a bound trajectory invocation");
}

export abstract class AgentWorkerBase extends AgentVesselBase {
  private promptResourceCache: AgentPromptResources | null = null;
  private promptResourceLoad: Promise<AgentPromptResources> | null = null;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected override getDefaultModel(): string {
    return DEFAULT_MODEL;
  }

  protected override getDefaultThinkingLevel(): ThinkingLevel {
    return DEFAULT_THINKING_LEVEL as ThinkingLevel;
  }

  protected override getDefaultApprovalLevel(): ApprovalLevel {
    return DEFAULT_APPROVAL_LEVEL as ApprovalLevel;
  }

  protected override getDefaultRespondPolicy(): RespondPolicy {
    return DEFAULT_RESPOND_POLICY as RespondPolicy;
  }

  protected override getModelCredentialSetupProps(
    providerId: string
  ): Record<string, unknown> | null {
    return (
      (PROVIDER_CREDENTIAL_SETUPS as Record<string, Record<string, unknown>>)[providerId] ?? null
    );
  }

  protected override async loadPromptResources(_channelId: string): Promise<AgentPromptResources> {
    if (this.promptResourceCache) return this.promptResourceCache;
    if (this.promptResourceLoad) return this.promptResourceLoad;

    const load = loadVibestudioResources({ rpc: this.rpc })
      .then(
        (resources): AgentPromptResources => ({
          workspacePrompt: resources.systemPrompt,
          skillIndex: resources.skillIndex,
        })
      )
      .then((value) => {
        this.promptResourceCache = value;
        return value;
      })
      .finally(() => {
        if (this.promptResourceLoad === load) this.promptResourceLoad = null;
      });
    this.promptResourceLoad = load;
    return load;
  }

  protected override invalidatePromptResources(_channelId?: string): void {
    this.promptResourceCache = null;
    this.promptResourceLoad = null;
  }

  protected createHeartbeatLoop(options: {
    namespace: string;
    defaultPromptText?: string;
    evaluate: AgentHeartbeatLoopDeps["evaluate"];
    channelId: () => string | null;
    registry?: {
      participantHandle?: () => string | null;
      enabled?: boolean;
    };
  }): AgentHeartbeatLoop {
    const sourceId = `heartbeat:${options.namespace.replace(/[^a-zA-Z0-9_]/gu, "_")}`;
    const loop = new AgentHeartbeatLoop({
      sql: this.sql,
      namespace: options.namespace,
      defaultPromptText: options.defaultPromptText,
      evaluate: options.evaluate,
      scheduleWakeAt: (id, timeMs) => this.scheduleAgentAlarm(id, timeMs),
      clearWake: (id) => this.clearAgentAlarm(id),
      isTurnInFlight: () => {
        const channelId = options.channelId();
        return channelId ? this.driver.hasOpenTurn(channelId) : false;
      },
      enqueueTurn: async (turn) => {
        const channelId = options.channelId();
        if (!channelId) throw new Error(`heartbeat ${options.namespace} has no bound channel`);
        const content =
          turn.kind === "prompt"
            ? turn.promptText
            : (options.defaultPromptText ?? "Continue this heartbeat turn.");
        const contextPolicy = await this.resolveHeartbeatContextPolicy(turn.decision.contextPolicy);
        await this.submitAgentInitiatedTurn(
          channelId,
          { content },
          {
            mode: "sequential",
            steeringId: `${sourceId}:${turn.trigger.kind}:${Date.now()}`,
            origin: "heartbeat",
            delivery: turn.decision.delivery ?? "none",
            ...(turn.decision.ackToken ? { ackToken: turn.decision.ackToken } : {}),
            ...(turn.decision.silentOk !== undefined ? { silentOk: turn.decision.silentOk } : {}),
            contextPolicy,
          }
        );
        if (options.registry?.enabled !== false) {
          await this.registerGenericHeartbeat(options.namespace, channelId, loop, options);
        }
      },
    });
    this.registerAgentAlarmSource({
      id: sourceId,
      nextWakeAt: () => loop.nextWakeAt(),
      fire: async (now) => {
        await loop.onAlarm(now);
        const channelId = options.channelId();
        if (channelId && options.registry?.enabled !== false) {
          await this.registerGenericHeartbeat(options.namespace, channelId, loop, options);
        }
      },
    });
    return loop;
  }

  private async registerGenericHeartbeat(
    namespace: string,
    channelId: string,
    loop: AgentHeartbeatLoop,
    options?: {
      registry?: {
        participantHandle?: () => string | null;
      };
    }
  ): Promise<void> {
    const state = loop.getState();
    const ref = this.identity.ref;
    await this.rpc
      .call("main", "workspace-state.heartbeatRegister", [
        {
          name: `${namespace}-${channelId}`,
          source: ref.source,
          className: ref.className,
          objectKey: ref.objectKey,
          channelId,
          participantHandle: options?.registry?.participantHandle?.() ?? null,
          kind: "code-owned",
          status: state.status,
          nextRunAt: state.nextRunAt,
          lastWakeAt: state.lastWakeAt || null,
          lastActionSummary: state.lastActionSummary || null,
          lastError: state.lastError || null,
          specHash: state.specHash || null,
          updatedAt: Date.now(),
        },
      ])
      .catch((err) => {
        console.warn("[AgentWorkerBase] heartbeat registry update failed:", err);
      });
  }

  private async resolveHeartbeatContextPolicy(
    decisionPolicy?: AgentTurnContextPolicy
  ): Promise<AgentTurnContextPolicy> {
    const contextPolicy: AgentTurnContextPolicy = {
      mode: "heartbeat",
      includeWorkspacePrompt: false,
      includeSkillIndex: false,
      tokenBudget: 12_000,
      ...decisionPolicy,
    };
    if (contextPolicy.promptFile) {
      try {
        const fs = createRpcFs(this.rpc as never);
        const path = contextPolicy.promptFile.startsWith("/")
          ? contextPolicy.promptFile
          : `/${contextPolicy.promptFile}`;
        const raw = await fs.readFile(path, "utf8");
        contextPolicy.promptFileContent = typeof raw === "string" ? raw : raw.toString("utf8");
      } catch (err) {
        console.warn(
          "[AgentWorkerBase] failed to read heartbeat promptFile:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    return contextPolicy;
  }

  /** The six workerd-clean file tools over the agent's context folder
   *  (fs RPC scopes paths to the caller's context). Without them, agents
   *  whose prompts say `read(".../SKILL.md")` can only flail. */
  protected override getLoopTools(
    channelId: string,
    execution?: AgentToolExecutionContext
  ): AgentTool[] {
    const toolRpc = execution?.rpc ?? this.rpc;
    const fs = createRpcFs(toolRpc as never);
    const cwd = "/";
    // Reads come from the materialized working tree (fs RPC, scoped to the
    // caller's context); writes go through the canonical semantic VCS so the
    // exact working state is authoritative and disk is its projection.
    const vcs = createToolVcs(<T>(method: string, methodArgs: unknown[]) =>
      toolRpc.call<T>("main", method, methodArgs)
    );
    const session = channelTrajectoryFor(channelId);
    const contextId = () => this.subscriptions.getContextId(channelId);
    // Tool registries are also built without an invocation to expose schemas
    // to the model. Defer the fail-closed check until a mutation executes.
    const mutationContext = {
      contextId,
      commandId: execution?.commandId ?? requireBoundMutationInvocation,
      integrationSourceResolver: (sourceEventId: string) => {
        const run = this.subagentRuns.getBySourceEvent(sourceEventId);
        return run ? { runId: run.runId } : null;
      },
      onIntegrationSourcesCommitted: (result: VcsCommitResult) => {
        if (result.event.kind !== "event") return;
        for (const sourceEventId of result.integrationSourceEventIds) {
          const run = this.subagentRuns.getBySourceEvent(sourceEventId);
          if (!run) continue;
          this.subagentRuns.setSemanticIntegrationSnapshot(run.runId, {
            state: "complete",
            sourceEventId,
            committedEventId: result.event.eventId,
            stale: false,
          });
        }
      },
    };
    const base = [
      createReadTool(cwd, fs, {
        rpc: toolRpc,
        provenance: { vcs, context: { contextId } },
      }),
      createProvenanceTool(cwd, {
        vcs,
        contextId,
        session: { logId: session.logId, head: session.head },
      }),
      createLsTool(cwd, fs),
      createGrepTool(cwd, fs, { rpc: toolRpc }),
      createFindTool(cwd, fs, { rpc: toolRpc }),
      createEditTool(cwd, vcs, mutationContext, fs),
      createWriteTool(cwd, vcs, mutationContext, fs),
      createMoveFileTool(cwd, vcs, mutationContext, fs),
      createCopyFileTool(cwd, vcs, mutationContext, fs),
      createWorkspaceVcsTool(cwd, vcs, mutationContext),
      createEvalTool(
        <T>(method: string, methodArgs: unknown[]) => toolRpc.call<T>("main", method, methodArgs),
        // Scope the agent's EvalDO per channel (matches the old per-(channel,panel) scope),
        // so one multi-channel agent doesn't share REPL scope/db across unrelated chats.
        { subKey: channelId }
      ),
      // Capability discovery: search/open the caller-aware catalog (services
      // and runtime APIs) with typed schemas + access rules.
      createDocsSearchTool(<T>(method: string, methodArgs: unknown[]) =>
        toolRpc.call<T>("main", method, methodArgs)
      ),
      createDocsOpenTool(<T>(method: string, methodArgs: unknown[]) =>
        toolRpc.call<T>("main", method, methodArgs)
      ),
      createWorkspaceServiceTool(vcs, mutationContext, {
        validateConfig: (content) =>
          toolRpc.call("main", "workspace.validateConfig", [content]).then(() => undefined),
      }),
      createSuspendTurnTool({
        guard: async ({ reason }) => {
          if (reason !== "waiting_for_background") return { suspend: true };
          return this.guardBackgroundSuspension(channelId);
        },
      }),
      ...(hasAskableUser(this.rosterSnapshot(channelId)) ? [this.createAskUserTool()] : []),
      ...createWebTools({
        rpc: {
          call: (target, method, args) => toolRpc.call(target, method, args),
        },
        recordIngestion: (entry) =>
          toolRpc.call("main", "contextIntegrity.ingest", [entry]).then(() => undefined),
        hasCredentialForOrigin: async (origin) => {
          try {
            const credential = await this.rpc.call<unknown>(
              "main",
              "credentials.resolveCredential",
              [{ url: origin }]
            );
            return credential != null;
          } catch {
            return false;
          }
        },
      }),
    ] as unknown as AgentTool[];
    // The generalized `say` tool (carries saliency:"say"; the config-level
    // publishPolicy governs whether model narration also publishes) + the
    // subagent supervision surface. The child-side `complete` tool is added
    // ONLY when this agent is itself a subagent.
    return [
      ...base,
      this.createSetTitleTool(channelId),
      this.createSayTool(channelId, fs),
      ...this.createSubagentTools(channelId, toolRpc),
    ];
  }

  /**
   * Title the conversation itself, not whichever UI happens to be connected.
   * The channel config is durable and observable, so headless/task channels
   * and any later panel attachment see the same title.
   */
  protected createSetTitleTool(channelId: string): AgentTool<never> {
    return {
      name: "set_title",
      label: "set_title",
      description: "Set the conversation title",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The new title" },
        },
        required: ["title"],
      } as never,
      execute: async (_toolCallId, params) => {
        const title = (params as { title?: unknown }).title;
        if (typeof title !== "string" || title.trim().length === 0) {
          throw new Error("set_title requires a non-empty title");
        }
        const normalized = title.trim();
        await this.createChannelClient(channelId).updateConfig({
          title: normalized,
          titleExplicit: true,
        });
        return {
          content: [{ type: "text", text: `set conversation title to ${normalized}` }],
          details: { title: normalized },
        };
      },
    };
  }

  /** The generalized `say` tool: an explicit, deliberate channel utterance
   *  (saliency:"say"). Its messageId is derived from the tool-call id, so a
   *  redriven invocation re-sends the SAME message (dedup), never a duplicate.
   *  `attachments` names image files in the agent's working tree (the same fs
   *  the read/write tools use), so a captured screenshot reaches the user by
   *  path — the bytes never travel through the model. */
  protected createSayTool(channelId: string, fs: ReturnType<typeof createRpcFs>): AgentTool<never> {
    return {
      name: "say",
      label: "say",
      description:
        "Send a concise, deliberate message to the channel. This is the explicit way to surface text to participants (e.g. when the agent publishes only on demand). " +
        `To show the user an image (e.g. a screenshot you captured), save it as a file and list its path in attachments; supported types: ${SUPPORTED_IMAGE_TYPES.join(", ")}.`,
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Message text to send to the channel." },
          replyTo: { type: "string", description: "Optional message id this is replying to." },
          mentions: {
            type: "array",
            items: { type: "string" },
            description: "Optional participant IDs to mention.",
          },
          attachments: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional image file paths (in your working tree) to attach, e.g. screenshots. Rendered inline in the chat.",
          },
        },
        required: ["content"],
      } as never,
      execute: async (toolCallId, params) => {
        const input = params as {
          content?: unknown;
          replyTo?: unknown;
          mentions?: unknown;
          attachments?: unknown;
        };
        if (typeof input.content !== "string" || input.content.trim().length === 0) {
          throw new Error("say requires non-empty content");
        }
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) throw new Error("agent is not subscribed to the channel");
        const paths = Array.isArray(input.attachments)
          ? input.attachments.filter((path): path is string => typeof path === "string")
          : [];
        const attachments = await readSayAttachments(fs, paths);
        const descriptor = this.getEffectiveParticipantInfo(
          channelId,
          this.subscriptions.getConfig(channelId)
        );
        const messageId = `say:${toolCallId}`;
        // A subagent's deliberate `say` is, per §9, an utterance intended for
        // its supervisor. The supervisor observes the task channel with
        // delivery interest "addressed", so carry the parent in the audience
        // explicitly — otherwise the say stays in the task log without ever
        // creating supervisor work.
        const parentParticipantId = this.subagentIdentity()?.parentParticipantId;
        await this.createChannelClient(channelId).send(participantId, messageId, input.content, {
          saliency: "say",
          senderMetadata: {
            ...descriptor.metadata,
            name: descriptor.name,
            type: descriptor.type,
            handle: descriptor.handle,
          },
          replyTo: typeof input.replyTo === "string" ? input.replyTo : undefined,
          mentions: Array.isArray(input.mentions)
            ? input.mentions.filter((mention): mention is string => typeof mention === "string")
            : undefined,
          ...(parentParticipantId
            ? { to: [{ kind: "participant", participantId: parentParticipantId }] }
            : {}),
          attachments: attachments.length > 0 ? attachments : undefined,
        });
        const attachmentNote =
          attachments.length > 0
            ? ` with ${attachments.length} attachment${attachments.length === 1 ? "" : "s"} (${attachments.map((attachment) => attachment.name).join(", ")})`
            : "";
        return {
          content: [{ type: "text", text: `sent message ${messageId}${attachmentNote}` }],
          details: { messageId, attachments: attachments.map((attachment) => attachment.name) },
        };
      },
    };
  }

  /** The subagent tool surface: parent-side supervision (spawn/send/inspect/
   *  integrate/read/cancel) plus the child-side `complete` terminal trigger
   *  (advertised only to subagents). The vessel implements the spawn mechanics
   *  in the local-tool executor (it never reaches the `execute` below — see
   *  AgentVesselBase.runDeferredSpawn). */
  private createSubagentTools(channelId: string, toolRpc: RpcClient): AgentTool[] {
    const tools: AgentTool[] = [
      {
        name: "spawn_subagent",
        label: "spawn_subagent",
        description:
          "Delegate separable work to a child agent in its own durable task channel and retained child context. Returns a runId once launch succeeds; the spawn invocation does not stay open for the child's lifetime. Use for independent investigation, parallel work, or isolated edits; do small linear work yourself. mode:'fresh' seeds a child from task; mode:'fork' starts from your current trajectory and can share context-window cache. Track the runId exactly, continue useful foreground work, and steer only with new instructions. After terminal delivery, review the retained result and decide from the user's goal whether to integrate it; inspection-only and comparison tasks may deliberately leave it unintegrated. Detailed activity remains on the canonical child transcript. Terminal results immediately free execution capacity and remain inspectable, readable, and mergeable; no cleanup tool is required. Use cancel_subagent only to stop a live run. If siblings remain live, continue foreground work or suspend_turn({ reason:'waiting_for_background' }) again. The child finishes only by calling complete.",
        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["fresh", "fork"],
              description:
                "'fresh' = new agent seeded via the task; 'fork' = branch from your trajectory, useful when the child needs your current context and can benefit from the shared context window cache.",
            },
            task: {
              type: "string",
              description:
                "The child's durable authoritative assignment, restated by the runtime on every model call. Include goal, relevant files/docs/skills, constraints, expected output, progress expectations, done criteria, and what to do if blocked.",
            },
            config: {
              type: "object",
              description:
                "Optional child runtime config. This object is the ONLY way to select a different " +
                "child model or reasoning level; mentioning a model inside `task` does not configure " +
                "the child. Omit config only when inheriting the parent's effective settings is " +
                "intentional. For 'pi' children use model and thinkingLevel " +
                "('minimal'|'low'|'medium'|'high'|'xhigh'|'max'), plus optional approvalLevel, " +
                "respondPolicy, handle, and system-prompt settings. Do not use effort for Pi. " +
                "For external kinds it maps to the launcher's CLI — claude-code supports model " +
                "(alias like 'opus'/'sonnet' or a full model name), effort " +
                "('low'|'medium'|'high'|'xhigh'|'max'), permissionMode ('auto' by default — the " +
                "child runs autonomously; also 'acceptEdits'|'bypassPermissions'|'manual'|'dontAsk'|'plan'), " +
                "fallbackModel, and maxBudgetUsd (number). Unknown keys are ignored.",
              properties: {
                model: { type: "string" },
                thinkingLevel: {
                  type: "string",
                  enum: ["minimal", "low", "medium", "high", "xhigh", "max"],
                  description: "Pi child reasoning level. External launchers ignore this field.",
                },
                effort: {
                  type: "string",
                  enum: ["low", "medium", "high", "xhigh", "max"],
                  description: "External-launcher effort. Pi children ignore this field.",
                },
                approvalLevel: { type: "integer", minimum: 0, maximum: 3 },
                respondPolicy: { type: "string" },
                handle: { type: "string" },
                permissionMode: { type: "string" },
                fallbackModel: { type: "string" },
                maxBudgetUsd: { type: "number", exclusiveMinimum: 0 },
              },
              additionalProperties: true,
            },
            label: { type: "string", description: "Optional short label for the run." },
            agentKind: {
              type: "string",
              description:
                "Reasoning engine for the child (default 'pi', an in-process agent). Any other value names an external launcher extension @workspace-extensions/<agentKind>; the task is required and the launched child reports progress, completes, and integrates its committed changes exactly like a 'pi' subagent.",
            },
          },
          required: ["mode", "task"],
        } as never,
        execute: async () => {
          throw new Error("spawn_subagent is handled by the local-tool executor");
        },
      } as AgentTool,
      {
        name: "send_to_subagent",
        label: "send_to_subagent",
        description:
          "Send steering or new information directly to the exact child participant. Use this to correct course or add context, not to poll for progress.",
        parameters: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description:
                "The exact subagent runId or any sufficiently long unique prefix; the display ellipsis is optional.",
            },
            message: { type: "string", description: "Message to send to the subagent." },
          },
          required: ["runId", "message"],
        } as never,
        execute: async (toolCallId, params) => {
          const p = params as { runId?: unknown; message?: unknown };
          return this.sendToSubagent(
            toolCallId,
            String(p.runId ?? ""),
            String(p.message ?? ""),
            channelId
          );
        },
      } as AgentTool,
      {
        name: "inspect_subagent",
        label: "inspect_subagent",
        description:
          "Inspects a supervised child's runtime or semantic workspace state; it never exposes the model's private context window. Use the bounded parent-relative 'diff' when the user's goal is to inspect, review, or compare child work without integrating it. No inspection preflight is required before merge_subagent when the goal instead calls for integration. Use 'status', 'diff'/'log', or an exact repo-prefixed file path. 'runtime' is only for external-agent diagnostics; read_subagent returns what the child said. Do not poll a live child with this tool; suspend_turn wakes on terminal delivery.",
        parameters: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description:
                "The exact subagent runId or any sufficiently long unique prefix; the display ellipsis is optional.",
            },
            query: {
              type: "string",
              description:
                "'status' | 'diff' | 'log' | 'runtime' | an exact repo-prefixed file path (default 'status').",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              description: "Maximum diff/log records to return (default 20).",
            },
            cursor: {
              type: "string",
              description: "Opaque nextCursor from an earlier diff/log page.",
            },
          },
          required: ["runId"],
        } as never,
        execute: async (_toolCallId, params) => {
          const p = params as {
            runId?: unknown;
            query?: unknown;
            limit?: unknown;
            cursor?: unknown;
          };
          return this.inspectSubagent(
            String(p.runId ?? ""),
            String(p.query ?? "status"),
            channelId,
            {
              limit:
                typeof p.limit === "number" && Number.isInteger(p.limit)
                  ? Math.max(1, Math.min(100, p.limit))
                  : 20,
              cursor: typeof p.cursor === "string" && p.cursor ? p.cursor : undefined,
            }
          );
        },
      } as AgentTool,
      {
        name: "merge_subagent",
        label: "merge_subagent",
        description:
          "Merge a subagent's committed net effect into your local working state when the user's goal calls for incorporating that child work. It derives exact child/parent status and comparison without an inspect preflight. Do not call it for inspection-only, comparison, or deliberately unintegrated tasks. Returns model-visible resolution, intents, a composed-review checklist, and coordinate conflicts. Pass resolutions after editing a truthful combined result or choosing ours/theirs. This does not commit or publish your work.",
        parameters: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description:
                "The exact subagent runId or any sufficiently long unique prefix; the display ellipsis is optional.",
            },
            resolutions: {
              oneOf: [
                {
                  type: "array",
                  maxItems: 500,
                  items: {
                    type: "object",
                    properties: {
                      coordinate: {
                        type: "object",
                        properties: {
                          kind: { enum: ["file", "repository"] },
                          id: { type: "string", minLength: 1 },
                        },
                        required: ["kind", "id"],
                        additionalProperties: false,
                      },
                      resolution: { enum: ["composed", "theirs", "ours", "current"] },
                      rationale: { type: "string", minLength: 1, maxLength: 2000 },
                    },
                    required: ["coordinate", "resolution"],
                    additionalProperties: false,
                  },
                },
                {
                  type: "object",
                  properties: {
                    allRemaining: {
                      type: "object",
                      properties: {
                        resolution: { enum: ["ours", "current"] },
                        rationale: { type: "string", minLength: 1, maxLength: 2000 },
                      },
                      required: ["resolution"],
                      additionalProperties: false,
                    },
                  },
                  required: ["allRemaining"],
                  additionalProperties: false,
                },
              ],
            },
            intent: {
              type: "string",
              minLength: 1,
              maxLength: 2000,
              description:
                "Why this integration is being performed, when that purpose adds information beyond the child request.",
            },
          },
          required: ["runId"],
        } as never,
        execute: async (_toolCallId, params) => {
          const p = params as { runId?: unknown; resolutions?: unknown; intent?: unknown };
          return this.mergeSubagent(
            String(p.runId ?? ""),
            channelId,
            p.resolutions && typeof p.resolutions === "object" ? (p.resolutions as never) : [],
            typeof p.intent === "string" ? p.intent : undefined,
            toolRpc
          );
        },
      } as AgentTool,
      {
        name: "read_subagent",
        label: "read_subagent",
        description:
          "Read the canonical subagent task transcript after a cursor. Returns messages plus nextSeq. Use it for deliberate catch-up or debugging; suspend_turn({ reason:'waiting_for_background' }) parks the parent when only live background execution remains. Use inspect_subagent for child files, status, semantic diff, and runtime diagnostics.",
        parameters: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description:
                "The exact subagent runId or any sufficiently long unique prefix; the display ellipsis is optional.",
            },
            afterSeq: {
              type: "number",
              description: "Return messages after this channel seq (default 0).",
            },
          },
          required: ["runId"],
        } as never,
        execute: async (_toolCallId, params) => {
          const p = params as { runId?: unknown; afterSeq?: unknown };
          return this.readSubagent(
            String(p.runId ?? ""),
            typeof p.afterSeq === "number" ? p.afterSeq : 0,
            channelId
          );
        },
      } as AgentTool,
      {
        name: "cancel_subagent",
        label: "cancel_subagent",
        description:
          "Cancel a subagent that is still starting or running. Cancellation fences execution and records a retained terminal result; it does not delete the agent, context, transcript, or workspace.",
        parameters: {
          type: "object",
          properties: {
            runId: {
              type: "string",
              description:
                "The exact subagent runId or any sufficiently long unique prefix; the display ellipsis is optional.",
            },
            reason: {
              type: "string",
              description: "Why execution is being cancelled.",
            },
          },
          required: ["runId"],
        } as never,
        execute: async (_toolCallId, params) => {
          const p = params as { runId?: unknown; reason?: unknown };
          return this.cancelSubagent(
            String(p.runId ?? ""),
            typeof p.reason === "string" ? p.reason : "cancelled by supervisor",
            channelId,
            toolRpc
          );
        },
      } as AgentTool,
    ];
    if (this.isSubagent()) {
      tools.push({
        name: "complete",
        label: "complete",
        description:
          "Finish this subagent run exactly once and hand your report back to the parent. This is the explicit terminal trigger: ordinary final text, turn closure, and idle are NOT terminal. Use outcome:'failed' when blocked or unable to complete, with a report explaining what was tried and whether partial work exists.",
        parameters: {
          type: "object",
          properties: {
            report: { type: "string", description: "Your final report to the parent." },
            outcome: {
              type: "string",
              enum: ["success", "failed"],
              description: "Run outcome (default 'success').",
            },
          },
          required: ["report"],
        } as never,
        execute: async (_toolCallId, params) => {
          const p = params as { report?: unknown; outcome?: unknown };
          return this.completeAsSubagent(
            String(p.report ?? ""),
            p.outcome === "failed" ? "failed" : "success"
          );
        },
      } as AgentTool);
    }
    return tools;
  }

  private createAskUserTool(): AgentTool {
    return {
      name: "ask_user",
      label: "ask_user",
      description:
        "Ask the user a concise question and wait for their response. Use this only when the answer is needed to continue.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "Question to show the user." },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional short options; mutually exclusive unless multiSelect is true.",
          },
          allowFreeform: {
            type: "boolean",
            description:
              "Whether the user may type a custom answer. Defaults to true for option prompts; set false to require one of the options.",
          },
          multiSelect: {
            type: "boolean",
            description:
              "Whether multiple options may be selected. When true, the prompt shows checkboxes and an explicit submit button.",
          },
          to: {
            type: "string",
            description:
              "Optional exact channel human target: a user:<id> participant id or @handle from the roster. Omit to ask every human; an unknown target fails closed and is never broadcast.",
          },
        },
        required: ["question"],
      } as never,
      execute: async () => {
        throw new Error("ask_user requires a channel user participant");
      },
    } as AgentTool;
  }

  protected override getModelCredentialTokenClaims(
    providerId: string,
    credential: import("@workspace/runtime/credentials").StoredCredentialSummary
  ): Record<string, unknown> {
    if (providerId !== "openai-codex") return {};
    const accountId =
      credential.accountIdentity?.providerUserId ?? credential.metadata?.["accountId"];
    return accountId ? { [OPENAI_CODEX_ACCOUNT_CLAIM]: { chatgpt_account_id: accountId } } : {};
  }

  protected getStandardAgentMethods(
    opts?: StandardAgentMethodOptions
  ): NonNullable<ParticipantDescriptor["methods"]> {
    const methods: NonNullable<ParticipantDescriptor["methods"]> = [
      { name: "pause", description: "Pause the current AI turn" },
      { name: "resume", description: "Resume after pause" },
      {
        name: "scheduleResumeAtReset",
        description: "Schedule a paused model turn to resume when its usage limit resets",
      },
      { name: "credentialConnected", description: "Resume after model credential connection" },
      {
        name: "connectModelCredential",
        description: "Connect a model credential for the current provider",
      },
      { name: "setModel", description: "Set the live model in provider:model format" },
      {
        name: "setThinkingLevel",
        description: "Set live effort level: minimal, low, medium, high, xhigh, or max",
      },
      {
        name: "setApprovalLevel",
        description: "Set live approval level: 0=manual, 1=auto-safe, 2=full-auto",
      },
      {
        name: "setRespondPolicy",
        description: "Set live chattiness policy and optional participant allow-list",
      },
      {
        name: "refreshPromptArtifacts",
        description: "Reload workspace prompt resources and refresh model prompt/tool artifacts",
      },
      {
        name: "getAgentSettings",
        description:
          "Read effective primary/fallback model routing, effort, approval, and chattiness settings",
      },
      {
        name: "getModelExecutionEvidence",
        description:
          "Read durable provider/model routing and aggregate usage evidence for this channel",
      },
      { name: "getDebugState", description: "Read agent DO persisted and in-memory debug state" },
      {
        name: "inspectMethodSuspensions",
        description: "Inspect the pending effect outbox (dispatch cache over the log)",
      },
    ];
    const include = opts?.include ? new Set<string>(opts.include) : null;
    const exclude = opts?.exclude ? new Set<string>(opts.exclude) : null;
    return methods.filter(
      (method) => (!include || include.has(method.name)) && !exclude?.has(method.name)
    );
  }
}
