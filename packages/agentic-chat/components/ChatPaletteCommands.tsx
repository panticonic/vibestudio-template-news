/**
 * Contributes the chat panel's commands to the app-level command palette
 * (Cmd/Ctrl+K). Lives inside `<ChatProvider>` so it can read the live delivery
 * state and actions straight from the chat context — the single place that has
 * them — and registers ONE state-aware command set (two `usePaletteCommands`
 * calls in the same panel would clobber each other's registration).
 *
 * The set is state-aware on purpose: the palette only offers what is actually
 * actionable right now (flush only while something is queued/in-flight, cancel
 * only with queued messages, undo only inside the undo window), so the delivery
 * model — the same "now vs. next", "nothing happens invisibly" semantics as the
 * composer — is reachable by keyboard without hunting for the right gesture.
 *
 * Failed sends restore their draft to the composer rather than leaving a
 * separate retriable outbox entry.
 */
import { useMemo } from "react";
import { usePaletteCommands } from "@workspace/react";
import { useChatContext } from "../context/ChatContext";
import { deriveActiveOutbox } from "./Outbox";

type ChatCommand = { id: string; label: string; hint?: string; section: string };

const SECTION = "Chat";

export function ChatPaletteCommands() {
  const {
    onNewConversation,
    messages,
    selfId,
    participants,
    agentBusy,
    pendingSendCount,
    flushOutboxAndInterrupt,
    cancelPendingMessage,
    undoableAction,
    undoLastAction,
  } = useChatContext();

  const queuedMessageIds = useMemo(
    () => deriveActiveOutbox(messages, selfId, participants).map((message) => message.id),
    [messages, selfId, participants]
  );
  const queuedCount = queuedMessageIds.length;
  const canFlush = agentBusy || queuedCount > 0 || pendingSendCount > 0;
  const canUndo = !!undoableAction && !!undoLastAction;

  const commands = useMemo<ChatCommand[]>(() => {
    const cmds: ChatCommand[] = [];
    if (onNewConversation) {
      cmds.push({ id: "chat-new-conversation", label: "New conversation", section: SECTION });
    }
    if (canFlush) {
      cmds.push({
        id: "chat-flush",
        label: "Send queued now & interrupt",
        hint: "Esc",
        section: SECTION,
      });
    }
    if (queuedCount > 0) {
      cmds.push({
        id: "chat-cancel-queued",
        label: queuedCount > 1 ? `Cancel ${queuedCount} queued messages` : "Cancel queued message",
        section: SECTION,
      });
    }
    if (canUndo) {
      cmds.push({ id: "chat-undo", label: "Undo last send action", section: SECTION });
    }
    return cmds;
  }, [onNewConversation, canFlush, queuedCount, canUndo]);

  usePaletteCommands(commands, (id) => {
    switch (id) {
      case "chat-new-conversation":
        onNewConversation?.();
        break;
      case "chat-flush":
        void flushOutboxAndInterrupt();
        break;
      case "chat-cancel-queued":
        // Snapshot first — cancelling mutates the underlying set. Consecutive
        // cancels accumulate into one undoable action (see useChatCore).
        for (const messageId of queuedMessageIds) void cancelPendingMessage(messageId);
        break;
      case "chat-undo":
        undoLastAction?.();
        break;
    }
  });

  return null;
}
