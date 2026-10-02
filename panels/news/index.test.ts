// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  stateArgs: {} as Record<string, unknown>,
  never: new Promise<never>(() => {}),
  persistChannel: (() => Promise.resolve()) as () => Promise<void>,
}));

vi.mock("@workspace/runtime", () => ({
  contextId: "ctx-news-test",
  workers: {
    resolveService: async () => ({
      kind: "durable-object",
      targetId: "do:model-settings",
    }),
  },
  openPanel: vi.fn(),
  panel: {
    stateArgs: {
      set: (args: Record<string, unknown>) =>
        args["channelName"] ? fixture.persistChannel() : Promise.resolve(),
    },
  },
  rpc: { selfId: "panel:news-test", call: vi.fn() },
}));
vi.mock("@workspace/runtime/internal/diagnostics", () => ({
  recoveryCoordinator: {},
}));
vi.mock("@workspace/react", () => ({
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
    fixture.persistChannel = () => Promise.resolve();
  });

  it("keeps a stable hook order when the channel state write completes", async () => {
    let accept!: () => void;
    fixture.persistChannel = () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      });
    expect(() => render(createElement(NewsPanel))).not.toThrow();
    expect(screen.getByText("Opening your reader…")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "News" })).toBeNull();
    await act(async () => {
      accept();
    });
    expect(screen.getByRole("heading", { name: "News" })).toBeTruthy();
  });

  it("shows a rejected channel state write and retries through the same bootstrap", async () => {
    let reject!: (cause: Error) => void;
    fixture.persistChannel = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, rejectWrite) => {
            reject = rejectWrite;
          }),
      )
      .mockResolvedValueOnce(undefined);
    render(createElement(NewsPanel));
    await act(async () => {
      reject(new Error("Workspace disconnected"));
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Workspace disconnected",
    );
    expect(screen.queryByText("Opening your reader…")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry startup" }));
    });
    expect(fixture.persistChannel).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "News" })).toBeTruthy();
  });
});
