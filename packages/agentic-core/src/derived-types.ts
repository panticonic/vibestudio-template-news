/**
 * Derived UI types for the chat panel.
 *
 * These shapes are computed from channel messages for component rendering.
 * They live in agentic-core rather than agentic-chat so both the React
 * layer and HeadlessSession can consume them.
 *
 * The agent worker publishes Pi events as persisted channel messages.
 * `useChatCore` builds `ChatMessage[]` from the channel message stream.
 */

import type { Attachment } from "@workspace/pubsub";
import type {
  LifecycleMessageReasonCode,
  MessageModelPayload,
  MessageTier,
  TurnReasonCode,
} from "@workspace/agentic-protocol";
import type { InvocationCardPayload } from "./invocation-card-payload.js";
import type { TaskCardPayload } from "./task-card-payload.js";

export type SandboxSource = { type: "code"; code: string } | { type: "file"; path: string };

export interface InlineUiCardPayload {
  id: string;
  source: SandboxSource;
  imports?: Record<string, string>;
  props?: Record<string, unknown>;
}

export interface ActionBarPayload {
  id?: string;
  source?: SandboxSource;
  imports?: Record<string, string>;
  props?: Record<string, unknown>;
  maxHeight?: number;
  cleared?: boolean;
  result?: { ok: boolean; error?: string };
}

export type CustomMessageDisplayMode = "inline" | "row";

interface BaseMessageTypeDefinition {
  typeId: string;
  imports?: Record<string, string>;
  /** JSON Schema for the card's full state (validated on emit and render). */
  stateSchema?: Record<string, unknown>;
  /** JSON Schema for incremental updates (required when the module reduces). */
  updateSchema?: Record<string, unknown>;
  registeredBy?: {
    kind: string;
    id: string;
    displayName?: string;
    metadata?: Record<string, unknown>;
  };
  updatedAtSeq: number;
}

export interface ActiveMessageTypeDefinition extends BaseMessageTypeDefinition {
  displayMode: CustomMessageDisplayMode;
  source: SandboxSource;
  clearedAtSeq?: number;
  cleared?: false;
}

export interface ClearedMessageTypeDefinition extends BaseMessageTypeDefinition {
  displayMode?: CustomMessageDisplayMode;
  source?: SandboxSource;
  clearedAtSeq: number;
  cleared: true;
}

export type MessageTypeDefinition = ActiveMessageTypeDefinition | ClearedMessageTypeDefinition;
export type ProjectedMessageTypeDefinition = MessageTypeDefinition;

export interface CustomMessageUpdatePayload {
  update: unknown;
  seq: number;
}

/** Payload for an unresolved model-credential connect card. `connectSpec`
 *  is the shared connect-preset props (ModelCredentialSetupProps). */
export interface CredentialRequestCardPayload {
  credKey: string;
  providerId: string;
  connectSpec: Record<string, unknown>;
  modelBaseUrl?: string;
  reason?: string;
  failureCode?: string;
  expiresAt?: string;
  agentParticipantId: string;
}

export interface CustomMessageCardPayload {
  messageId: string;
  typeId: string;
  displayMode: CustomMessageDisplayMode;
  initialState?: unknown;
  updates: CustomMessageUpdatePayload[];
  lastSeq: number;
  /** Card owner — the target for ui.feedback published by the renderer. */
  by?: { kind: string; id: string; displayName?: string };
  /** Owner-published terminal failure; the UI renders a failed-card frame. */
  failed?: boolean;
  error?: { message: string; details?: unknown };
}

export interface ApprovalCardPayload {
  id: string;
  invocationId?: string;
  question?: string;
  status: "requested" | "granted" | "denied";
  granted?: boolean;
  reason?: string;
}

// ===========================================================================
// Fork row (inline "conversation forked" annotation)
// ===========================================================================

/** Inline system-row payload projected from a channel's direct-child forks
 *  (`ChannelViewState.forks`). Rendered as "⑂ <actor> forked from message N". */
export interface ForkRowPayload {
  forkId: string;
  forkedChannelId: string;
  forkedContextId: string;
  forkPointId: number;
  label: string;
  reason: string;
  actor: { kind: string; id: string; displayName?: string };
  createdAtSeq: number;
  archived: boolean;
}

// ===========================================================================
// Pending agents (UI state for spawn-in-progress)
// ===========================================================================

export type PendingAgentStatus = "starting" | "error";

export interface PendingAgent {
  agentId: string;
  status: PendingAgentStatus;
  error?: { message: string; details?: string };
}

// ===========================================================================
// Disconnected agent notification
// ===========================================================================

export interface DisconnectedAgentInfo {
  name: string;
  handle: string;
  panelId?: string;
  agentTypeId?: string;
  type: string;
}

// ===========================================================================
// Dirty repo warning (from agent debug events)
// ===========================================================================

export interface DirtyRepoDetails {
  modified: string[];
  untracked: string[];
  staged: string[];
}

// ===========================================================================
// Lifecycle / recovery notices
// ===========================================================================

export type LifecycleNoticeStatus = "recovered" | "interrupted" | "failed" | "waiting";

export interface LifecycleNotice {
  status: LifecycleNoticeStatus;
  title: string;
  detail?: string;
  reason?: LifecycleMessageReasonCode | TurnReasonCode;
}

export type DiagnosticNoticeSeverity = "info" | "warning" | "error";

export interface DiagnosticNotice {
  messageId?: string;
  code?: string;
  failureCode?: string;
  severity: DiagnosticNoticeSeverity;
  title: string;
  detail?: string;
  reason?: string;
  recoverable?: boolean;
  resetAt?: string;
  retryAfterMs?: number;
}

// ===========================================================================
// ChatMessage (derived from Pi AgentMessage for component rendering)
// ===========================================================================

/**
 * Derived shape consumed by chat UI components. Computed by `useChatCore`
 * from channel envelopes and local UI events.
 */
export interface ChatMessage {
  id: string;
  pubsubId?: number;
  senderId: string;
  content: string;
  contentType?: string;
  /**
   * Durable envelope seq at which this message first appeared (from
   * `ProjectedMessage.seq`). The fork-point locus: "Fork from here" roots at
   * `seq`; "Edit & fork" roots at `seq − 1`. Absent for locally-optimistic
   * rows not yet round-tripped through the log.
   */
  seq?: number;
  /** Explicit supervisor `say` (from `ProjectedMessage.saliency`) — used to
   *  filter the SubagentRunCard's live say feed. */
  saliency?: "say";
  /** Edit-fork provenance: the parent message this seed supersedes in the
   *  child channel. Rendered as a "substituted this turn" annotation. */
  replaces?: { messageId: string; seq: number };
  /** Present on inline fork-annotation rows (`contentType === "fork"`). */
  fork?: ForkRowPayload;
  kind?: "message" | "method" | "system";
  complete?: boolean;
  replyTo?: string;
  mentions?: string[];
  error?: string;
  pending?: boolean;
  /**
   * Salience tier driving how prominently the card renders. "primary" (tier 1)
   * is full presentation; "secondary" (tier 2) is slighter/de-emphasized.
   * Absent ⇒ "primary". See MessageTier.
   */
  tier?: MessageTier;
  model?: MessageModelPayload;
  attachments?: Attachment[];
  senderMetadata?: { name?: string; type?: string; handle?: string };
  disconnectedAgent?: DisconnectedAgentInfo;
  /**
   * Parsed structured payload for derived invocation-card messages.
   * Populated by the shared channel-chat-merge helper; UI components read it
   * directly instead of re-parsing `content`.
   */
  invocation?: InvocationCardPayload;
  /** Durable background-task card, separate from the invocation that launched it. */
  task?: TaskCardPayload;
  inlineUi?: InlineUiCardPayload;
  approval?: ApprovalCardPayload;
  custom?: CustomMessageCardPayload;
  credentialRequest?: CredentialRequestCardPayload;
  lifecycle?: LifecycleNotice;
  diagnostic?: DiagnosticNotice;
  /**
   * Per-recipient delivery state for this message, resolved against the
   * intended-recipient snapshot plus the received/read ack maps. Present when
   * the message has at least one tracked recipient. `read` means an agent
   * recipient folded the message into a model turn ("taken into account"), not
   * a social read receipt.
   */
  receipts?: {
    byParticipant: Record<string, "pending" | "received" | "read">;
    aggregate: "pending" | "partial" | "read";
  };
  /** The author canceled this (still-unread) message; UI renders a tombstone. */
  retracted?: boolean;
  /** Edit count; presence (or `editedAt`) drives the "edited" marker. */
  revision?: number;
  editedAt?: string;
}
