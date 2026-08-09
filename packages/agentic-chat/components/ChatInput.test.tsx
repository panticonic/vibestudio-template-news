// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Theme } from "@radix-ui/themes";
import { makeTestCatalogEntry } from "@workspace/model-catalog/testing";
import { ChatInput } from "./ChatInput";
import { ChatProvider } from "../context/ChatProvider";
import type {
  ChatContextValue,
  ChatInputContextValue,
  FlushNarration,
  PrimaryActionIntent,
  UndoableAction,
} from "../types";

beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList
  );
});

interface Harness {
  onSendMessage: ReturnType<typeof vi.fn>;
  onInputChange: ReturnType<typeof vi.fn>;
  flushOutboxAndInterrupt: ReturnType<typeof vi.fn>;
  undoLastAction: ReturnType<typeof vi.fn>;
}

function renderInput(
  opts: {
    input?: string;
    agentBusy?: boolean;
    hasOpenTurn?: boolean;
    primaryActionIntent?: PrimaryActionIntent;
    flushNarration?: FlushNarration;
    undoableAction?: UndoableAction;
    pendingSendCount?: number;
    context?: Partial<ChatContextValue>;
    inputContext?: Partial<ChatInputContextValue>;
  } = {}
): Harness {
  const onSendMessage = vi.fn(async () => {});
  const onInputChange = vi.fn();
  const flushOutboxAndInterrupt = vi.fn(async () => {});
  const undoLastAction = vi.fn();

  const ctx = {
    connected: true,
    allParticipants: {},
    participants: {},
    selfId: "user-1" as ChatContextValue["selfId"],
    agentBusy: opts.agentBusy ?? false,
    hasOpenTurn: opts.hasOpenTurn ?? false,
    primaryActionIntent: opts.primaryActionIntent ?? "send",
    flushOutboxAndInterrupt,
    flushNarration: opts.flushNarration,
    undoableAction: opts.undoableAction,
    undoLastAction,
    pendingSendCount: opts.pendingSendCount ?? 0,
    modelCatalog: null,
    onCallMethodResult: vi.fn(async () => ({})),
    ...opts.context,
  } as unknown as ChatContextValue;

  const inputCtx = {
    input: opts.input ?? "hello",
    pendingImages: [],
    onInputChange,
    onSendMessage,
    onImagesChange: vi.fn(),
    replyTo: null,
    replyToMessage: null,
    setReplyTo: vi.fn(),
    ...opts.inputContext,
  } as unknown as ChatInputContextValue;

  render(
    <Theme>
      <ChatProvider value={ctx} inputValue={inputCtx}>
        <ChatInput />
      </ChatProvider>
    </Theme>
  );
  return { onSendMessage, onInputChange, flushOutboxAndInterrupt, undoLastAction };
}

function textarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
}

async function keyDown(init: KeyboardEventInit & { key: string }): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(textarea(), init);
  });
}

describe("ChatInput keyboard shortcuts", () => {
  it("Enter sends with default mode (no after-turn metadata)", async () => {
    const { onSendMessage } = renderInput();
    await keyDown({ key: "Enter" });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    const [, options] = onSendMessage.mock.calls[0]!;
    expect(options?.metadata?.deliverAfterTurn).toBeUndefined();
  });

  it("Shift+Enter does NOT send (newline)", async () => {
    const { onSendMessage } = renderInput();
    await keyDown({ key: "Enter", shiftKey: true });
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  // "Send & interrupt" was removed: interrupting is now the separate flush-queue
  // control. Cmd/Ctrl+Enter just sends (default mode), never flushing.
  it("Ctrl+Enter sends (default mode, no interrupt/flush)", async () => {
    const { onSendMessage, flushOutboxAndInterrupt } = renderInput({ agentBusy: true });
    await keyDown({ key: "Enter", ctrlKey: true });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    const [, options] = onSendMessage.mock.calls[0]!;
    expect(options?.metadata?.deliverAfterTurn).toBeUndefined();
    expect(flushOutboxAndInterrupt).not.toHaveBeenCalled();
  });

  it("Cmd+Enter (metaKey) also sends (default mode, no flush)", async () => {
    const { onSendMessage, flushOutboxAndInterrupt } = renderInput({ agentBusy: true });
    await keyDown({ key: "Enter", metaKey: true });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    expect(flushOutboxAndInterrupt).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+Enter sends after the turn (deliverAfterTurn metadata)", async () => {
    const { onSendMessage } = renderInput({ agentBusy: true, hasOpenTurn: true });
    await keyDown({ key: "Enter", ctrlKey: true, shiftKey: true });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    const [, options] = onSendMessage.mock.calls[0]!;
    expect(options?.metadata?.deliverAfterTurn).toBe(true);
  });

  it("Ctrl+Shift+Enter falls back to default send when no turn is open", async () => {
    const { onSendMessage } = renderInput({ agentBusy: true, hasOpenTurn: false });
    await keyDown({ key: "Enter", ctrlKey: true, shiftKey: true });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    const [, options] = onSendMessage.mock.calls[0]!;
    expect(options?.metadata?.deliverAfterTurn).toBeUndefined();
  });

  it("Escape flushes (advance pipeline) only when composer empty and agent busy", async () => {
    const { flushOutboxAndInterrupt } = renderInput({ input: "", agentBusy: true });
    await keyDown({ key: "Escape" });
    expect(flushOutboxAndInterrupt).toHaveBeenCalledTimes(1);
  });

  it("Escape does NOT flush when the composer has text", async () => {
    const { flushOutboxAndInterrupt } = renderInput({ input: "draft", agentBusy: true });
    await keyDown({ key: "Escape" });
    expect(flushOutboxAndInterrupt).not.toHaveBeenCalled();
  });
});

describe("ChatInput /model command", () => {
  it("preserves current agent behavior settings when switching models", async () => {
    const onReplaceAgent = vi.fn(async () => {});
    const onCallMethodResult = vi.fn(async () => ({
      model: "openai-codex:gpt-5.5",
      thinkingLevel: "max",
      approvalLevel: 1,
      respondPolicy: "from-participants",
      respondFrom: ["user-1"],
    }));
    const modelCatalog = {
      providers: [],
      models: [
        makeTestCatalogEntry({
          ref: "local:lfm2.5-1.2b",
          id: "lfm2.5-1.2b",
          name: "LFM2.5 1.2B",
          provider: "local",
          baseUrl: "http://127.0.0.1:43117/v1",
          auth: "loopback",
          availability: { state: "ready", detail: "running" },
        }),
      ],
    };

    const { onInputChange } = renderInput({
      input: "/model local",
      context: {
        selfId: "user-1" as ChatContextValue["selfId"],
        participants: {
          "agent-1": {
            id: "agent-1",
            metadata: { type: "agent", handle: "ai-chat" },
          },
        } as unknown as ChatContextValue["participants"],
        modelCatalog,
        onReplaceAgent,
        onCallMethodResult,
      },
    });

    await keyDown({ key: "Enter" });

    await waitFor(() => expect(onReplaceAgent).toHaveBeenCalledTimes(1));
    expect(onCallMethodResult).toHaveBeenCalledWith("agent-1", "getAgentSettings", {});
    expect(onReplaceAgent).toHaveBeenCalledWith("agent-1", undefined, {
      model: "local:lfm2.5-1.2b",
      handle: "ai-chat",
      thinkingLevel: "max",
      approvalLevel: 1,
      respondPolicy: "from-participants",
      respondFrom: ["user-1"],
    });
    expect(onInputChange).toHaveBeenCalledWith("");
  });
});

describe("ChatInput send-button intent", () => {
  // The primary send control is icon-only; intent is exposed via aria-label.
  it("idle shows the Send intent", () => {
    renderInput({ agentBusy: false, primaryActionIntent: "send" });
    expect(screen.getByLabelText(/^Send \(/)).toBeTruthy();
  });

  it("agent busy shows the Steer intent", () => {
    renderInput({ agentBusy: true, primaryActionIntent: "steer" });
    expect(screen.getByLabelText(/^Steer \(/)).toBeTruthy();
  });

  it("keeps send options available for attachment when the composer is empty", () => {
    renderInput({ input: "" });
    const primary = screen.getByLabelText(/^Send \(/).closest("button");
    const options = screen.getByLabelText("Send options").closest("button");
    expect(primary?.hasAttribute("disabled")).toBe(true);
    expect(options?.hasAttribute("disabled")).toBe(false);
  });
});

describe("ChatInput narration / undo / ghost", () => {
  it("renders the flush narration pill with an aria-live region", () => {
    renderInput({ flushNarration: { text: "Delivered 2 steers", remaining: 0 } });
    const pill = screen.getByText("Delivered 2 steers");
    expect(pill).toBeTruthy();
    expect(pill.closest('[aria-live="polite"]')).toBeTruthy();
  });

  it("renders the undo snackbar and fires undoLastAction", () => {
    const { undoLastAction } = renderInput({
      undoableAction: { kind: "cancel", messageIds: ["m1"], expiresAt: Date.now() + 5000 },
    });
    fireEvent.click(screen.getByText("Undo"));
    expect(undoLastAction).toHaveBeenCalledTimes(1);
  });

  it("shows the Sending… ghost while a send is in flight", () => {
    renderInput({ pendingSendCount: 1 });
    expect(screen.getByText("Sending…")).toBeTruthy();
  });
});
