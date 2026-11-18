import { NEWS_METHODS } from "./news-methods.js";
import {
  newsArchiveSearchResultSchema,
  newsArticlePageResultSchema,
  newsOverviewResultSchema,
} from "./news-results.js";

type NewsReadMethod =
  | typeof NEWS_METHODS.getOverview
  | typeof NEWS_METHODS.listArticles
  | typeof NEWS_METHODS.searchArchive;

type NewsAssignment = Readonly<{ channelId: string; participantId: string }>;
type ReaderReadback = {
  id: string;
  channelId: string;
  participantId: string;
  value: unknown;
};

/** Implemented by the caller using its channel-bound News participant capability. */
type NewsReadCall = (
  method: NewsReadMethod,
  args: Record<string, unknown>,
) => Promise<ReaderReadback>;
type ReaderView =
  | { kind: "inbox" | "saved" | "backlog"; cursors: readonly (string | null)[] }
  | { kind: "archive"; query: string };

function checkAssignment(assignment: NewsAssignment, receipt: ReaderReadback) {
  if (
    receipt.channelId !== assignment.channelId ||
    receipt.participantId !== assignment.participantId
  )
    throw new Error(
      "News readback belongs to a different participant or channel.",
    );
  if (!receipt.id) throw new Error("News readback is missing its evidence ID.");
  return receipt;
}

/** Capture read-only evidence for the same reader and request. The trusted caller supplies transport attribution. */
export async function captureNewsReaderReadback(
  assignment: NewsAssignment,
  call: NewsReadCall,
  goal: string,
  view: ReaderView,
) {
  const overviewReceipt = checkAssignment(
    assignment,
    await call(NEWS_METHODS.getOverview, {}),
  );
  const overview = newsOverviewResultSchema.parse(overviewReceipt.value);
  const feeds = overview.setup.feeds.filter((feed) => feed.enabled);
  const pages = [];
  if (view.kind === "archive") {
    const receipt = checkAssignment(
      assignment,
      await call(NEWS_METHODS.searchArchive, { query: view.query }),
    );
    const result = newsArchiveSearchResultSchema.parse(receipt.value);
    if (result.query !== view.query)
      throw new Error("News archive readback belongs to a different query.");
    pages.push({
      id: receipt.id,
      requestedCursor: null,
      nextCursor: null,
      hasMore: false,
      articleIds: result.articles.map((article) => article.articleId),
      briefingIds: result.briefings.map((briefing) => briefing.briefingId),
    });
  } else {
    const filter =
      view.kind === "saved"
        ? { savedOnly: true }
        : view.kind === "backlog"
          ? { untriagedOnly: true }
          : { triagedOnly: true };
    for (const cursor of view.cursors) {
      const receipt = checkAssignment(
        assignment,
        await call(NEWS_METHODS.listArticles, {
          ...filter,
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      const page = newsArticlePageResultSchema.parse(receipt.value);
      pages.push({
        id: receipt.id,
        requestedCursor: cursor,
        nextCursor: page.nextCursor ?? null,
        hasMore: page.hasMore,
        articleIds: page.articles.map((article) => article.articleId),
      });
    }
  }
  return {
    kind: "reader" as const,
    goal,
    view: view.kind,
    activity: "idle" as const,
    overview: {
      id: overviewReceipt.id,
      setup: overview.setup.status,
      articleCount: overview.articleCount,
      untriagedCount: overview.untriagedCount,
      enabledFeeds: feeds.length,
      failedFeeds: feeds.filter((feed) => feed.failCount > 0).length,
    },
    pages,
  };
}
