/**
 * Channel boundary types still used by `@workspace/agentic-do` and the
 * worker DO base. Everything harness-protocol-related has been deleted —
 * Pi runs in-process now.
 */

/** Usage metrics returned after a completed turn. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Attachment on a channel message — canonical format for all transports. */
export interface Attachment {
  /** Stable ID for binary frame correlation. */
  id: string;
  /** Derived convenience: "image" | "file". */
  type?: string;
  /** Base64-encoded content. */
  data: string;
  mimeType: string;
  filename?: string;
  /** Byte size for binary frame slicing. */
  size: number;
}

/** Channel event — canonical format for all transports (WS + DO). */
export interface ChannelEvent {
  id: number;
  messageId: string;
  type: string;
  payload: unknown;
  senderId: string;
  senderMetadata?: Record<string, unknown>;
  /** Content type from the payload (e.g., "typing" for typing indicators). */
  contentType?: string;
  ts: number;
  attachments?: Attachment[];
  /** Host-attested content provenance from the durable channel envelope. */
  contentClass?: "internal" | "external";
  externalKeys?: string[];
  /** Durable envelope annotations (policy folds — e.g. agentHops). */
  annotations?: Record<string, unknown>;
}

/** Options for sending a channel message through a Durable Object-backed service. */
export interface SendMessageOptions {
  contentType?: string;
  senderMetadata?: Record<string, unknown>;
  replyTo?: string;
  idempotencyKey?: string;
  attachments?: Array<{ data: string; mimeType: string }>;
}

/** Input for starting a new agent turn. */
export interface TurnInput {
  content: string;
  senderId: string;
  context?: string;
  attachments?: Attachment[];
}

/** Channel participant identity — returned by subscribeChannel(). */
export interface ParticipantDescriptor {
  /** Stable, unique-within-channel handle. */
  handle: string;
  name: string;
  type: string;
  metadata?: Record<string, unknown>;
  methods?: Array<{
    name: string;
    description: string;
    parameters?: unknown;
  }>;
}

/** Result from unsubscribing a channel. */
export interface UnsubscribeResult {
  ok: true;
}
