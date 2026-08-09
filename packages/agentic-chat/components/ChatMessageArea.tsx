import { useMemo } from "react";
import type { ReactNode } from "react";
import { Flex, Spinner, Text } from "@radix-ui/themes";
import { useChatContext } from "../context/ChatContext";
import { useChatInputActions } from "../context/ChatInputContext";
import { AgentSetupInline } from "./AgentSetupInline";
import { FirstRunCard } from "./FirstRunCard";
import { MessageList } from "./MessageList";
import { deriveActiveOutbox } from "./Outbox";
import { SignalPills } from "./SignalPills";
import { pendingReviewNotice } from "@vibestudio/shared/authority/reviewPending";

export interface ChatMessageAreaProps {
  /** Override default message card rendering */
  renderMessage?: (...args: Parameters<NonNullable<import("./MessageList").MessageListProps["renderMessage"]>>) => ReactNode;
  /** Override default inline group rendering */
  renderInlineGroup?: (...args: Parameters<NonNullable<import("./MessageList").MessageListProps["renderInlineGroup"]>>) => ReactNode;
}

/**
 * Message list area with load-earlier button.
 * Reads from ChatContext and passes to MessageList.
 */
export function ChatMessageArea({ renderMessage, renderInlineGroup }: ChatMessageAreaProps = {}) {
  const {
    connected,
    messages,
    participants,
    selfId,
    allParticipants,
    inlineUiComponents,
    messageTypeComponents,
    hasMoreHistory,
    loadingMore,
    onLoadEarlierMessages,
    onInterrupt,
    onCancelInvocation,
    onFocusPanel,
    onReloadPanel,
    chat,
    browserHandoffCaller,
    clientRef,
    deferredAgent,
    connectionError,
  } = useChatContext();
  const { setReplyTo } = useChatInputActions();

  const mdxActions = useMemo(() => ({
    publishMessage: async (content: string) => {
      await chat.send(content);
    },
  }), [chat]);

  // Hide exactly the active-outbox set (messages live in the queue OR the
  // transcript, never both — so a fresh send doesn't flash here and then bounce
  // to the queue). deriveActiveOutbox already keeps the right things visible:
  //  - no recipient (sent before any agent joined) → not deliverable → visible;
  //  - offline recipient → excluded → visible with an "agent offline" marker,
  //    self-resolving on return;
  //  - read messages → no longer pending → visible (graduated from the queue).
  // Until connected (replay complete), the Outbox is suppressed, so don't hide
  // anything here either — otherwise a transiently-pending historical message
  // would vanish from BOTH places mid-replay.
  const transcriptMessages = useMemo(() => {
    if (!connected) return messages;
    const hiddenIds = new Set(deriveActiveOutbox(messages, selfId, participants).map((m) => m.id));
    return hiddenIds.size > 0 ? messages.filter((m) => !hiddenIds.has(m.id)) : messages;
  }, [connected, messages, selfId, participants]);

  // Empty-transcript surface. While the spawned agent is starting, show an
  // accurate status (the pre-send queue below the composer shows the spinner
  // + the queued messages themselves). Otherwise, once replay has settled
  // (`connected`) on a genuinely empty channel, show the first-run narrative
  // card (item 9) — gating on `connected` avoids flashing it mid-replay for an
  // existing conversation. MessageList only mounts this when there are zero
  // items, so it self-hides the moment the first message lands.
  const emptyState = useMemo<ReactNode>(() => {
    const pending = pendingReviewNotice(connectionError?.cause ?? connectionError);
    if (pending) {
      return (
        <Flex role="status" aria-live="polite" align="center" justify="center" gap="2" direction="column" style={{ height: "100%", padding: 16, textAlign: "center" }}>
          <Text size="2" weight="medium">Waiting for workspace review</Text>
          <Text color="gray" size="2">{pending.message}</Text>
        </Flex>
      );
    }
    if (deferredAgent?.launching) {
      return (
        <Flex role="status" aria-live="polite" align="center" justify="center" style={{ height: "100%" }}>
          <Text color="gray" size="2">
            Preparing your agent…
          </Text>
        </Flex>
      );
    }
    return connected ? <FirstRunCard /> : (
      <Flex role="status" aria-live="polite" align="center" justify="center" gap="2" style={{ height: "100%" }}>
        <Spinner size="1" />
        <Text color="gray" size="2">Loading conversation…</Text>
      </Flex>
    );
  }, [connectionError, deferredAgent?.launching, connected]);

  // Before the first agent exists, the message canvas hosts the inline setup
  // (armed config) instead of an empty transcript.
  if (deferredAgent?.setupActive) {
    return (
      <Flex direction="column" gap="1" style={{ minHeight: 0, flexGrow: 1 }}>
        <SignalPills client={clientRef.current} />
        <AgentSetupInline />
      </Flex>
    );
  }

  return (
    <Flex direction="column" gap="1" style={{ minHeight: 0, flexGrow: 1 }}>
      <SignalPills client={clientRef.current} />
      <MessageList
        emptyState={emptyState}
        messages={transcriptMessages}
        participants={participants}
        selfId={selfId}
        allParticipants={allParticipants}
        inlineUiComponents={inlineUiComponents}
        messageTypeComponents={messageTypeComponents}
        chat={chat as unknown as Record<string, unknown>}
        browserHandoffCaller={browserHandoffCaller}
        hasMoreHistory={hasMoreHistory}
        loadingMore={loadingMore}
        onLoadEarlierMessages={onLoadEarlierMessages}
        onInterrupt={onInterrupt}
        onCancelInvocation={onCancelInvocation}
        onFocusPanel={onFocusPanel}
        onReloadPanel={onReloadPanel}
        onReply={setReplyTo}
        mdxActions={mdxActions}
        renderMessage={renderMessage}
        renderInlineGroup={renderInlineGroup}
      />
    </Flex>
  );
}
