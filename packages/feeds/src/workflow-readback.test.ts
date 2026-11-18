import { describe, expect, it } from "vitest";
import { NEWS_METHODS } from "./news-methods.js";
import { captureNewsReaderReadback } from "./workflow-readback.js";

const scope = { channelId: "editor-reader", participantId: "news-agent" };
const overview = {
  setup: {
    status: "configured",
    feeds: [
      {
        feedId: "enabled",
        url: "https://fixture.invalid/confirmed",
        enabled: true,
        failCount: 2,
        weight: 1,
      },
      {
        feedId: "disabled",
        url: "https://fixture.invalid/offline",
        enabled: false,
        failCount: 3,
        weight: 1,
      },
    ],
    followedTopics: [],
    scheduleSummary: "polls every 30m",
  },
  articleCount: 8,
  untriagedCount: 5,
  unbriefedCount: 7,
};
const row = {
  articleId: "article-1",
  title: "One article",
  url: "https://fixture.invalid/first",
  source: "Feed A",
  origin: "feed",
  read: false,
};

describe("scoped News workflow readback", () => {
  it("uses the existing inbox filter and preserves cursors and enabled feed errors", async () => {
    const requests: unknown[] = [];
    const evidence = await captureNewsReaderReadback(
      scope,
      async (method, args) => {
        requests.push([method, args]);
        const value =
          method === NEWS_METHODS.getOverview
            ? overview
            : {
                articles: [
                  {
                    ...row,
                    articleId: args["cursor"] ? "article-2" : "article-1",
                  },
                ],
                count: 1,
                nextCursor: args["cursor"] ? undefined : "154:abc",
                hasMore: !args["cursor"],
              };
        return { ...scope, id: `receipt-${requests.length}`, value };
      },
      "Did the inbox reach the end?",
      { kind: "inbox", cursors: [null, "154:abc"] },
    );
    expect(requests).toEqual([
      [NEWS_METHODS.getOverview, {}],
      [NEWS_METHODS.listArticles, { triagedOnly: true }],
      [NEWS_METHODS.listArticles, { triagedOnly: true, cursor: "154:abc" }],
    ]);
    expect(evidence.overview).toMatchObject({
      enabledFeeds: 1,
      failedFeeds: 1,
      untriagedCount: 5,
    });
    expect(evidence.pages).toMatchObject([
      {
        id: "receipt-2",
        requestedCursor: null,
        nextCursor: "154:abc",
        articleIds: ["article-1"],
      },
      {
        id: "receipt-3",
        requestedCursor: "154:abc",
        nextCursor: null,
        articleIds: ["article-2"],
      },
    ]);
  });

  it("preserves matching briefing-only archive hits", async () => {
    const evidence = await captureNewsReaderReadback(
      scope,
      async (method) => ({
        ...scope,
        id: method,
        value:
          method === NEWS_METHODS.getOverview
            ? overview
            : {
                query: "window",
                articles: [],
                briefings: [
                  {
                    briefingId: "daily-id",
                    createdAt: "2026-08-01",
                    status: "ready",
                  },
                ],
              },
      }),
      "Check the archive results.",
      { kind: "archive", query: "window" },
    );
    expect(evidence.pages).toMatchObject([
      { articleIds: [], briefingIds: ["daily-id"] },
    ]);
  });

  it("rejects a different assignment before interpreting its result", async () => {
    await expect(
      captureNewsReaderReadback(
        scope,
        async () => ({
          ...scope,
          channelId: "another-channel",
          id: "foreign-page",
          value: "unrelated",
        }),
        "What loaded?",
        { kind: "inbox", cursors: [null] },
      ),
    ).rejects.toThrow("different participant or channel");
  });

  it("rejects an archive response from an older query", async () => {
    await expect(
      captureNewsReaderReadback(
        scope,
        async (method) => ({
          ...scope,
          id: method,
          value:
            method === NEWS_METHODS.getOverview
              ? overview
              : {
                  query: "old query",
                  articles: [],
                  briefings: [],
                },
        }),
        "Check current search.",
        { kind: "archive", query: "updated query" },
      ),
    ).rejects.toThrow("different query");
  });
});
