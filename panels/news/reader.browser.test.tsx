import { createElement, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "@vitest/browser/context";
import "@radix-ui/themes/styles.css";
import "@workspace/ui/themes/vibestudio.css";
import { NEWS_METHODS } from "@workspace/feeds";
import type { ArticleRow } from "./components";
const fixture = vi.hoisted(() => ({
  call: vi.fn(),
  stateArgs: { channelName: "reader", agentKey: "reader-agent" },
  emit: (_event: unknown) => {},
  close: () => {},
}));
vi.mock("@workspace/runtime", () => ({
  contextId: "ctx-reader",
  workers: {
    resolveService: async () => ({
      kind: "durable-object",
      targetId: "models",
    }),
  },
  credentials: { listStoredCredentials: async () => [] },
  openPanel: vi.fn(),
  panel: { stateArgs: { patch: vi.fn(async () => undefined) } },
  rpc: {
    selfId: "reader-panel",
    call: async () => ({ defaultModel: "openai-codex:gpt-6-luna" }),
  },
}));
vi.mock("@workspace/runtime/internal/diagnostics", () => ({
  recoveryCoordinator: {},
}));
vi.mock("@workspace/react", () => ({
  useHostCommands: () => undefined,
  usePanelTheme: () => "light",
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
  launchAgentIntoChannel: async () => ({
    subscription: { participantId: "analyst" },
  }),
  parseSignalEvent: () => null,
  unwrapChatMethodResult: (result: unknown) => result,
}));
vi.mock("@workspace/channel-fork", () => ({ forkConversation: vi.fn() }));
vi.mock("@workspace/pubsub", () => ({
  connectViaRpc: () => {
    let closed = false;
    let wake: (() => void) | undefined;
    const queued: unknown[] = [];
    fixture.emit = (event) => {
      queued.push(event);
      wake?.();
    };
    const close = () => {
      closed = true;
      wake?.();
    };
    fixture.close = close;
    return {
      ready: async () => undefined,
      callMethod: (_participant: string, method: string, args: unknown) => ({
        result: fixture.call(method, args),
      }),
      async *events() {
        while (!closed) {
          if (!queued.length)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          while (queued.length) yield queued.shift();
        }
      },
      close,
    };
  },
}));
import NewsPanel from "./index";
let articles: ArticleRow[];
let rejectSave = false;
const titles = [
  "Orchids bloom underground",
  "Telescopes detect ancient galaxies",
  "Ocean currents reshape coastlines",
  "Violin makers restore rare instruments",
  "Mountain wildlife returns",
  "Electric ferries cross fjords",
];
beforeEach(() => {
  rejectSave = false;
  articles = titles.map((title, index) => ({
    articleId: `story-${index}`,
    title,
    url: `https://example.test/story-${index}`,
    source: "Review feed",
    origin: "feed",
    clusterKey: `cluster-${index}`,
    publishedAt: new Date(1700000000000 - index * 1000).toISOString(),
    read: false,
    saved: true,
  }));
  fixture.call
    .mockReset()
    .mockImplementation(
      async (
        method: string,
        args: { cursor?: string; savedOnly?: boolean },
      ) => {
        if (method === NEWS_METHODS.getOverview)
          return {
            setup: {
              status: "ready",
              feeds: [
                {
                  feedId: "feed",
                  title: "Review feed",
                  url: "https://example.test/rss",
                  enabled: true,
                },
              ],
              followedTopics: [],
              scheduleSummary: "Manual refresh",
              pollIntervalMs: 0,
              briefingIntervalMs: 0,
            },
            articleCount: articles.length,
            unbriefedCount: 0,
            untriagedCount: 0,
          };
        if (method === NEWS_METHODS.getBriefingHistory)
          return { briefings: [] };
        if (method === NEWS_METHODS.listArticles) {
          const rows = args.savedOnly
            ? articles.filter((article) => article.saved)
            : articles;
          const offset = args.cursor ? Number(args.cursor) : 0;
          return {
            articles: rows.slice(offset, offset + 3),
            hasMore: offset + 3 < rows.length,
            nextCursor: String(offset + 3),
          };
        }
        if (method === NEWS_METHODS.setSaved && rejectSave)
          throw new Error("Saving denied by the account");
        return { ok: true };
      },
    );
});
afterEach(() => {
  cleanup();
  fixture.close();
});
it("preserves loaded pages and the selected older story through a live refresh", async () => {
  await page.viewport(390, 1000);
  render(<NewsPanel />);
  await screen.findByRole("link", { name: titles[2] });
  fireEvent.click(screen.getByRole("button", { name: /Load older stories/ }));
  await screen.findByRole("link", { name: titles[5] });
  const reader = document.querySelector(".news-reader") as HTMLElement;
  reader.focus();
  for (let i = 0; i < 4; i++) fireEvent.keyDown(reader, { key: "j" });
  expect(
    document.querySelector('.news-story[data-selected="true"]')?.textContent,
  ).toContain(titles[4]);
  articles.unshift({
    ...articles[0]!,
    articleId: "new-head",
    clusterKey: "new-head",
    title: "Archaeologists uncover a hidden city",
    publishedAt: new Date(1700000010000).toISOString(),
  });
  fixture.emit({
    type: "agentic.trajectory.v1/event",
    payload: { kind: "custom.updated" },
  });
  await screen.findByRole("link", {
    name: "Archaeologists uncover a hidden city",
  });
  expect(screen.getByRole("link", { name: titles[5] })).toBeTruthy();
  expect(
    document.querySelector('.news-story[data-selected="true"]')?.textContent,
  ).toContain(titles[4]);
  expect(document.querySelectorAll(".news-story")).toHaveLength(7);
  await page.screenshot();
});

it("keeps a channel invalidation that arrives while a reader refresh is finishing", async () => {
  render(<NewsPanel />);
  await screen.findByRole("link", { name: titles[0] });
  const baselineOverviewReads = fixture.call.mock.calls.filter(
    ([method]) => method === NEWS_METHODS.getOverview,
  ).length;
  const originalCall = fixture.call.getMockImplementation();
  expect(originalCall).toBeDefined();

  let releaseRefresh: (() => void) | undefined;
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  let blockNextOverview = true;
  fixture.call.mockImplementation((method, args) => {
    if (method === NEWS_METHODS.getOverview && blockNextOverview) {
      blockNextOverview = false;
      return new Promise((resolve, reject) => {
        releaseRefresh = () => {
          void originalCall!(method, args).then(resolve, reject);
        };
        markRefreshStarted();
      });
    }
    return originalCall!(method, args);
  });

  const event = {
    type: "agentic.trajectory.v1/event",
    payload: { kind: "custom.updated" },
  };
  fixture.emit(event);
  await refreshStarted;
  fixture.emit(event);
  releaseRefresh!();

  await waitFor(() =>
    expect(
      fixture.call.mock.calls.filter(([method]) => method === NEWS_METHODS.getOverview),
    ).toHaveLength(baselineOverviewReads + 2),
  );
});

it("retains a Saved story and its action after a rejected unsave", async () => {
  render(<NewsPanel />);
  await screen.findByRole("link", { name: titles[0] });
  fireEvent.click(screen.getByRole("radio", { name: "Saved" }));
  const story = (await screen.findByRole("link", { name: titles[0] })).closest(
    "article",
  )!;
  rejectSave = true;
  const remove = within(story).getByRole("button", {
    name: `Remove ${titles[0]}`,
  });
  fireEvent.click(remove);
  await screen.findByText(/Saving denied by the account/);
  await waitFor(() =>
    expect(
      (
        within(story).getByRole("button", {
          name: `Remove ${titles[0]}`,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(screen.getByRole("link", { name: titles[0] })).toBeTruthy();
  expect(remove.getAttribute("aria-pressed")).toBe("true");
});

it("announces keyboard selection and returns focus after accepted Saved removal", async () => {
  await page.viewport(320, 1000);
  render(<NewsPanel />);
  await screen.findByRole("link", { name: titles[0] });
  const reader = screen.getByRole("region", { name: "News reader" });
  expect(reader.getAttribute("tabindex")).toBe("0");
  reader.focus();
  await userEvent.keyboard("j");
  await waitFor(() =>
    expect(
      screen.getByText(`Selected story: ${titles[1]}`).getAttribute("role"),
    ).toBe("status"),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Saved" }));
  const remove = await screen.findByRole("button", {
    name: `Remove ${titles[0]}`,
  });
  remove.focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: titles[0] })).toBeNull(),
  );
  expect(document.activeElement).toBe(reader);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(321);
});
