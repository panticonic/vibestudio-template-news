// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  stateArgs: {} as Record<string, unknown>,
  never: new Promise<never>(() => {}),
}));

vi.mock("@workspace/runtime", () => ({
  contextId: "ctx-news-test",
  createDurableObjectServiceClient: () => ({ call: async () => null }),
  openPanel: vi.fn(),
  panel: { stateArgs: { set: vi.fn() } },
  rpc: {
    selfId: "panel:news-test",
    call: vi.fn(),
  },
}));

vi.mock("@workspace/runtime/internal/diagnostics", () => ({ recoveryCoordinator: {} }));

vi.mock("@workspace/react", async () => {
  const actual = await vi.importActual<typeof import("@workspace/react")>("@workspace/react");
  return {
    ...actual,
    usePanelTheme: () => "dark",
    useStateArgs: () => fixture.stateArgs,
  };
});

vi.mock("@workspace/ui/panel", () => ({ useAppTheme: () => ({}) }));

vi.mock("@workspace/agentic-chat", () => ({
  AgenticChat: () => <div>Agent chat</div>,
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  markdownComponents: {},
}));

vi.mock("@workspace/agentic-core", () => ({
  createPanelSandboxConfig: () => ({}),
  launchAgentIntoChannel: () => fixture.never,
  parseSignalEvent: () => null,
}));

vi.mock("@workspace/pubsub", () => ({
  connectViaRpc: () => ({
    ready: () => fixture.never,
    async *events() {},
    close: vi.fn(),
  }),
}));

vi.mock("@workspace/channel-fork", () => ({ forkConversation: vi.fn() }));

import NewsPanel from "./index.js";

describe("NewsPanel bootstrap", () => {
  beforeEach(() => {
    fixture.stateArgs = {};
  });

  it("keeps a stable hook order when bootstrap supplies the channel", () => {
    // Bootstrap derives and stores a channel from the context in its first
    // effect. That state transition used to cross an early return which skipped
    // the palette hooks, triggering React's "Rendered more hooks" invariant.
    expect(() => render(<NewsPanel />)).not.toThrow();
    expect(screen.getByRole("heading", { name: "News" })).toBeTruthy();
  });
});
