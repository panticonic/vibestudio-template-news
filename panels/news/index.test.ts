// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
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
  rpc: { selfId: "panel:news-test", call: vi.fn() },
}));
vi.mock("@workspace/runtime/internal/diagnostics", () => ({
  recoveryCoordinator: {},
}));
vi.mock("@workspace/react", async () => ({
  ...(await vi.importActual<typeof import("@workspace/react")>(
    "@workspace/react",
  )),
  useHostCommands: () => undefined,
  usePanelTheme: () => "dark",
  usePanelThemeConfig: () => ({}),
  useStateArgs: () => fixture.stateArgs,
}));
vi.mock("@workspace/agentic-chat", () => ({
  AgenticChat: () => createElement("div", null, "Agent chat"),
  ErrorBoundary: ({ children }: { children: ReactNode }) => children,
  FULL_AGENTIC_CHAT_FEATURES: [],
  markdownComponents: {},
}));
vi.mock("@workspace/agentic-core", () => ({
  createPanelImportLoader: () => async () => ({ bundle: "", format: "cjs" }),
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

import NewsPanel from "./index";

describe("NewsPanel bootstrap", () => {
  beforeEach(() => {
    fixture.stateArgs = {};
  });

  it("keeps a stable hook order when bootstrap supplies the channel", () => {
    expect(() => render(createElement(NewsPanel))).not.toThrow();
    expect(screen.getByRole("heading", { name: "News" })).toBeTruthy();
  });
});
