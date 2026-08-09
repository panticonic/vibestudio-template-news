// @vitest-environment jsdom

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PubSubClient } from "@workspace/pubsub";
import { Theme } from "@radix-ui/themes";
import { MessageList } from "./MessageList.js";
import { agentConfigFromSettings, MessageCard } from "./MessageCard.js";
import { channelParticipantId } from "../types.js";
import type { ChatMessage } from "../types.js";
import { useChannelMessages } from "../hooks/useChannelMessages.js";
import {
  appendTrajectoryEventsAndBroadcast,
  assistantMessage,
  createTranscriptHarness,
  invocationCompleted,
  invocationStarted,
} from "../hooks/transcriptTestHarness.js";
import {
  agentToolFailureFromUnknown,
  brandId,
  invocationFailedPayload,
  type AgenticEvent,
  type InvocationId,
} from "@workspace/agentic-protocol";

const hookState = vi.hoisted(() => {
  const scrollElement = {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    addEventListener() {},
    removeEventListener() {},
  };
  const contentElement = {};
  const scrollRef = Object.assign((_node: unknown) => {}, { current: scrollElement });
  const contentRef = Object.assign((_node: unknown) => {}, { current: contentElement });
  return {
    scrollRef,
    contentRef,
    scrollToBottom: vi.fn(() => true),
  };
});

vi.mock("../hooks/useStickToBottom.js", () => ({
  useStickToBottom: () => ({
    scrollRef: hookState.scrollRef,
    contentRef: hookState.contentRef,
    scrollToBottom: hookState.scrollToBottom,
    isAtBottom: true,
    isAtBottomRef: { current: true },
  }),
}));

describe("agent settings parsing", () => {
  it("preserves a wrapped max effort setting", () => {
    expect(
      agentConfigFromSettings(
        {
          model: { value: "openai-codex:gpt-5.6-sol" },
          thinkingLevel: { value: "max" },
        },
        null
      )
    ).toMatchObject({
      model: "openai-codex:gpt-5.6-sol",
      thinkingLevel: "max",
    });
  });
});

function TranscriptView({ client }: { client: PubSubClient }) {
  const { messages } = useChannelMessages(client);
  return (
    <MessageList
      messages={messages}
      participants={{}}
      selfId={channelParticipantId("panel:chat")}
      allParticipants={{}}
    />
  );
}

describe("transcript UX smoke", () => {
  it("renders GAD-published agent messages and exact invocation beads", async () => {
    const harness = await createTranscriptHarness("transcript-ux");
    const panel = harness.connectParticipant({
      id: "panel:chat",
      name: "User",
      type: "panel",
      handle: "alice",
    });

    render(<TranscriptView client={panel} />);
    await act(async () => {
      await panel.ready();
    });

    await act(async () => {
      await appendTrajectoryEventsAndBroadcast(harness, [
        assistantMessage("assistant-visible", "Welcome to Vibestudio."),
        invocationStarted("call-eval", "eval", { code: "read('skills/onboarding/SKILL.md')" }),
        invocationCompleted("call-eval", {
          toolCallId: "call-eval",
          toolName: "eval",
          details: { input: { code: "read('skills/onboarding/SKILL.md')" } },
          content: [{ type: "text", text: "ok" }],
        }),
      ]);
    });

    await waitFor(() => {
      expect(screen.getByText("Welcome to Vibestudio.")).toBeTruthy();
      expect(screen.getByText("Eval")).toBeTruthy();
      expect(document.body.textContent).toContain("code: SKILL.md')");
    });

    panel.close();
  });

  it("preserves exact MCP-style method names and terminal failures", async () => {
    const harness = await createTranscriptHarness("transcript-ux-methods");
    const panel = harness.connectParticipant({
      id: "panel:chat",
      name: "User",
      type: "panel",
      handle: "alice",
    });

    render(<TranscriptView client={panel} />);
    await act(async () => {
      await panel.ready();
    });

    const failed: AgenticEvent<"invocation.failed"> = {
      kind: "invocation.failed",
      actor: { kind: "agent", id: "agent:onboarding", displayName: "Onboarding Agent" },
      causality: { invocationId: brandId<InvocationId>("call-list") },
      payload: invocationFailedPayload("tool_error", "permission denied", {
        error: {
          toolName: "mcp__workspace__ListDirectory",
          details: { input: { path: "src" } },
        },
        terminalReasonCode: "method_failed",
        failure: agentToolFailureFromUnknown(
          { message: "permission denied" },
          { operation: "mcp__workspace__ListDirectory", stage: "test" }
        ),
      }),
      createdAt: new Date().toISOString(),
    };

    await act(async () => {
      await appendTrajectoryEventsAndBroadcast(harness, [failed]);
    });

    await waitFor(() => {
      expect(screen.getByText("List Directory")).toBeTruthy();
      expect(document.body.textContent).toContain("permission denied");
      expect(
        document.body.querySelector('[data-invocation-name="mcp__workspace__ListDirectory"]')
      ).toBeTruthy();
      expect(document.body.querySelector('[data-invocation-status="error"]')).toBeTruthy();
    });

    panel.close();
  });
});

describe("transcript delivery markers", () => {
  const SELF = channelParticipantId("panel:user");
  const senderInfo = { name: "You", type: "panel" as const, handle: "alice" };
  const noop = () => {};

  function renderCard(msg: ChatMessage, participants = {}) {
    return render(
      <Theme>
        <MessageCard
          msg={msg}
          index={0}
          selfId={SELF}
          senderType="panel"
          senderInfo={senderInfo}
          participants={participants}
          mentionLabels={[]}
          isStreaming={false}
          isCopied={false}
          onInterrupt={noop}
          onCopy={noop}
          onClearCopied={noop}
        />
      </Theme>
    );
  }

  it("shows a compact ack badge for self-authored non-retracted messages", () => {
    renderCard(
      {
        id: "m1",
        senderId: "panel:user",
        content: "steer it",
        kind: "message",
        complete: true,
        receipts: { byParticipant: { "agent:alice": "read" }, aggregate: "read" },
      },
      {
        "agent:alice": {
          id: "agent:alice",
          metadata: { name: "Alice", type: "agent", handle: "alice" },
        },
      }
    );
    // Agent recipients are framed as "taken into account".
    expect(screen.getByLabelText(/Alice: taken into account/i)).toBeTruthy();
  });

  it("renders a slim tombstone for retracted messages with no content or badge", () => {
    renderCard({
      id: "m2",
      senderId: "panel:user",
      content: "secret that was canceled",
      kind: "message",
      complete: true,
      retracted: true,
      receipts: { byParticipant: { "agent:alice": "pending" }, aggregate: "pending" },
    });
    expect(screen.getByText("Message canceled")).toBeTruthy();
    // No content and no badge on the tombstone.
    expect(screen.queryByText("secret that was canceled")).toBeNull();
    expect(screen.queryByLabelText(/Delivery|pending|received|read/i)).toBeNull();
  });

  it("shows a quiet 'edited' marker when revision/editedAt is present", () => {
    renderCard({
      id: "m3",
      senderId: "panel:user",
      content: "revised text",
      kind: "message",
      complete: true,
      revision: 1,
      editedAt: "2026-05-21T08:00:00.000Z",
    });
    expect(screen.getByText("edited")).toBeTruthy();
  });
});
