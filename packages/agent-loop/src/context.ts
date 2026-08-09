/**
 * buildModelContext (WS1 §1.4.1 / §2.4.1, pure): convert the folded session
 * entries into a model message array. Replaces buildSessionContext +
 * TrajectoryBackedSessionStorage — the log IS the session.
 */

import type { AgentState, SessionEntry } from "./state.js";

export interface ModelMessage {
  role: "user" | "assistant" | "toolResult";
  content?: unknown;
  blocks?: unknown[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export function buildModelContext(
  state: AgentState,
  contextThroughSeq: number = Number.POSITIVE_INFINITY
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const entry of state.entries) {
    if (entry.seq > contextThroughSeq) break;
    messages.push(modelMessageFromEntry(entry, state.selfId));
  }
  return messages;
}

/** Speaker label for an attributed (non-self) message — handle/name, else the id. */
function participantLabel(ref: {
  displayName?: string;
  metadata?: Record<string, unknown>;
  id: string;
}): string {
  if (typeof ref.displayName === "string" && ref.displayName) return ref.displayName;
  const handle = ref.metadata?.["handle"];
  if (typeof handle === "string" && handle) return handle;
  return ref.id;
}

/** Flatten an assistant message's blocks to its visible text (for attributed context). */
function assistantBlocksToText(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const raw of blocks) {
    if (raw && typeof raw === "object") {
      const block = raw as Record<string, unknown>;
      if (block["type"] === "text") {
        const text = typeof block["content"] === "string" ? block["content"] : block["text"];
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return parts.join("\n").trim() || "(no text content)";
}

function modelMessageFromEntry(entry: SessionEntry, selfId?: string): ModelMessage {
  switch (entry.kind) {
    case "user": {
      const interaction = entry.metadata?.interaction;
      return {
        role: "user",
        content: interaction
          ? {
              message: entry.content,
              interaction,
            }
          : entry.content,
      };
    }
    case "assistant": {
      // Another participant's message (e.g. a different agent in the channel) is presented
      // as an attributed `user` message, NOT as this agent's own prior `assistant` turn —
      // otherwise the model reads other agents' messages as its own voice and continues them.
      const author = entry.senderRef;
      if (selfId && author?.id && author.id !== selfId) {
        return {
          role: "user",
          content: `[${participantLabel(author)}]: ${assistantBlocksToText(entry.blocks)}`,
        };
      }
      return { role: "assistant", blocks: entry.blocks };
    }
    case "tool-result":
      return {
        role: "toolResult",
        toolCallId: entry.invocationId,
        toolName: entry.name,
        content: entry.result,
        isError: entry.isError,
      };
    case "note":
      return { role: "user", content: { note: entry.text } };
  }
}
