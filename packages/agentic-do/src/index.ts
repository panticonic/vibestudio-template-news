/**
 * @workspace/agentic-do — Composable agent modules for Durable Objects.
 *
 * Agent DOs extend AgentWorkerBase (AgentVesselBase + workspace defaults).
 * Turn semantics live entirely in the pure `@workspace/agent-loop`; this
 * package contributes the impure driver (outbox, fold cache, executors) and
 * the DO surface. Non-agent DOs (e.g. PubSub channel DOs) extend
 * DurableObjectBase directly.
 */

export { AgentWorkerBase } from "./agent-worker-base.js";
export { AgentVesselBase } from "./agent-vessel.js";
export type {
  AgentSettings,
  AgentInitiatedTurnOptions,
  AgentAlarmSource,
  AgentToolExecutionContext,
  ApprovalLevel,
  ClonedChannelContext,
  CustomMessageReducer,
} from "./agent-vessel.js";
export {
  DEFAULT_APPROVAL_LEVEL,
  DEFAULT_MODEL,
  DEFAULT_RESPOND_POLICY,
  DEFAULT_THINKING_LEVEL,
  OPENAI_CODEX_ACCOUNT_CLAIM,
  PROVIDER_CREDENTIAL_SETUPS,
} from "./agent-config.js";
export type { ModelCredentialSetupProps } from "./agent-config.js";
export type { RespondPolicy } from "@workspace/agent-loop";
export { AgentLoopDriver } from "./agent-loop-driver.js";
export { EffectOutbox } from "./effect-outbox.js";
export { FoldCache } from "./fold-cache.js";
export * from "./effect-executors/index.js";
export { DOIdentity } from "./identity.js";
export { SubscriptionManager } from "./subscription-manager.js";
export { ChannelClient } from "./channel-client.js";
export {
  CardManager,
  CardTypeNotRegisteredError,
  CardValidationError,
} from "./custom-cards.js";
export type { CustomMessageHandle } from "./custom-cards.js";
export { FeedbackIngest, formatFeedbackNote } from "./feedback-ingest.js";
export { AgentHeartbeatLoop } from "./agent-heartbeat-loop.js";
export type {
  AgentHeartbeatLoopDeps,
  HeartbeatDecision,
  HeartbeatEvaluationContext,
  HeartbeatStartOptions,
  HeartbeatState,
  HeartbeatStatus,
  HeartbeatTickResult,
  HeartbeatTrigger,
  HeartbeatTurnRequest,
} from "./agent-heartbeat-loop.js";
export { RecurringScheduler } from "./recurring-scheduler.js";
export type { RecurringJob, RecurringSchedulerDeps } from "./recurring-scheduler.js";
export { installMessageTypes } from "./ui-install.js";
export type { ActionBarSpec, InstallMessageTypesOptions, MessageTypeSpec } from "./ui-install.js";
// Registration-time renderer lint (re-exported so agent workers don't need a
// direct agentic-core dependency just for this).
export { DEFAULT_HOST_MODULES, lintRendererSource } from "@workspace/agentic-core";
export type { RendererLintIssue } from "@workspace/agentic-core";
