/**
 * Model catalog shared types.
 *
 * The workspace model-settings service is the single authority on what a
 * model IS (`modelSpec` — the journaled pi-ai Model literal) and whether it
 * is USABLE right now (`availability`). Availability is worker-computed and
 * shared by every consumer — picker, agent config, fallback logic, CLI
 * (design docs/local-models-extension-design.md §7.1; this deliberately
 * replaces the old panel-side connection heuristic). The snapshot carries
 * availability STATES, never credential material, audiences, or the local
 * loopback api-key — specs are secret-free by construction (§6.1).
 */

export const MODEL_SETTINGS_SERVICE_PROTOCOL = "vibestudio.models.v1";
/** Workspace config field holding the full default agent config (model + behavior). */
export const WORKSPACE_DEFAULT_AGENT_CONFIG_FIELD = "defaultAgentConfig";
export const DEFAULT_AGENT_MODEL_REF = "openai-codex:gpt-5.6-sol";
/** The local provider id and its bundled, explicitly installable fallback. */
export const LOCAL_PROVIDER_ID = "local";
export const LOCAL_FALLBACK_MODEL_REF = "local:lfm2.5-1.2b";
export const LOCAL_MODELS_EXTENSION_ID = "@workspace-extensions/local-models";

/** Enabled effort levels the agent harness accepts (excludes pi's "off"). */
export type AgentThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Workspace-wide defaults applied to NEW agents — model plus behavior. Persisted
 * as a single workspace config field, written ONLY via an explicit "Save as
 * defaults" action (never as a side-effect of adding/spawning an agent).
 */
export interface DefaultAgentConfig {
  /** Default model ref ("provider:modelId"). */
  model: string;
  /** Default reasoning effort (reasoning models only). */
  thinkingLevel?: AgentThinkingLevel;
  /** Default autonomy (0 = Manual, 1 = Auto-safe, 2 = Full-auto). */
  approvalLevel?: 0 | 1 | 2;
}

export interface ModelCatalogProvider {
  id: string;
  label: string;
  /** Distinct base URLs across this provider's models (can be >1). */
  baseUrls: string[];
  /** Recommended onboarding/default model for this provider, when known. */
  recommendedModelRef: string | null;
  /**
   * Summary only: a connect preset exists AND at least one non-templated model
   * baseUrl. The per-model `connectable` flag is authoritative for the UI.
   */
  connectable: boolean;
}

/** How the executor authenticates calls to this model (design §6.3). */
export type ModelAuthMode = "url-bound" | "loopback";

/**
 * Serializable pi-ai `Model` literal — journaled with every request so replay
 * never depends on the installed registry (design §6.2). Secret-free: rides
 * catalog snapshots and the journal. Mirrors agent-loop's AgentModelSpec.
 */
export interface PiModelSpec {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

/** Live usability of a model (design §7.1) — worker-computed, shared by all
 *  consumers. Cloud: an active credential, a renewable expired credential, or
 *  the deterministic inference runtime used by system tests. Local: extension
 *  server state via models.changed events. */
export type ModelAvailability =
  | { state: "ready"; detail?: "running" | "credentialed" | "deterministic-test" }
  | { state: "startable"; detail: "will-load-on-use" }
  | {
      state: "needs-setup";
      detail: "no-credential" | "credential-expired" | "not-installed";
    }
  | { state: "starting" }
  | {
      state: "downloading";
      progress: number;
      phase: "active" | "queued" | "paused";
      receivedBytes: number;
      totalBytes: number | null;
    }
  | { state: "error"; message: string };

export interface ModelCatalogEntry {
  /** Stable "provider:modelId" form used as the agent's `model` config. */
  ref: string;
  id: string;
  name: string;
  provider: string;
  /** Per-model base URL — used for credential matching. */
  baseUrl: string;
  reasoning: boolean;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Local measured throughput on this hardware, when benchmarked. */
  tokensPerSec?: number | null;
  /** Model-supported subset of the enabled agent thinking levels. */
  thinkingLevels: AgentThinkingLevel[];
  /** baseUrl contains "{...}" placeholders → not quick-connectable. */
  templatedBaseUrl: boolean;
  /** Authoritative: a connect preset exists for the provider AND !templatedBaseUrl. */
  connectable: boolean;
  /** Part of the curated flagship-newest recommended set. */
  recommended: boolean;
  /** Explicit auth mode (design §6.3). */
  auth: ModelAuthMode;
  /** Live availability (design §7.1) — the picker's primary axis. */
  availability: ModelAvailability;
  /** The pi-ai Model this entry materializes to (design §6.2). */
  modelSpec: PiModelSpec;
  /** Gates tool schemas at config time (design §6.4). */
  capabilities: { tools: boolean };
}

export interface ModelCatalog {
  providers: ModelCatalogProvider[];
  models: ModelCatalogEntry[];
}

/** Whether a model can be assigned to an agent without another setup step. */
export function isModelUsable(
  model: Pick<ModelCatalogEntry, "availability"> | null | undefined
): boolean {
  return model?.availability.state === "ready" || model?.availability.state === "startable";
}

export interface ModelSettingsSnapshot {
  catalog: ModelCatalog;
  /** Resolved/validated default model (equals `defaultAgentConfig.model`). */
  defaultModel: string;
  defaultModelSource: "workspace" | "fallback";
  /** Why the stored default was bypassed: absent from the catalog entirely,
   *  or present but not currently usable (design §8). */
  defaultModelFallbackReason?: "missing" | "unavailable";
  invalidDefaultModel?: string;
  /** Full default agent config (model + behavior) applied to new agents. */
  defaultAgentConfig: DefaultAgentConfig;
}
