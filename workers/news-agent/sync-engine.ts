import type { SqlStorage } from "@workspace/runtime/worker";
import {
  HostPoliteness,
  articleId,
  canonicalizeUrl,
  fetchFeed,
  parseFeed,
  rankTopK,
  scoreArticle,
  titleSimilarityKey,
  type Fetcher,
} from "@workspace/feeds";
import type { NewsStoryRef } from "@workspace/feeds/card-types";
import { ARTICLE_RETENTION_MS } from "./types.js";

const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 4 * 3_600_000;
/** Cap stored items per feed per poll; feeds replaying huge archives stay sane. */
const MAX_ITEMS_PER_POLL = 100;

export interface NewsSyncEngineDeps {
  sql: SqlStorage;
  now: () => number;
  /** Injectable transport for tests; defaults to global fetch. */
  fetcher?: Fetcher;
  /** Injectable politeness sleeper for tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PollResult {
  feedsPolled: number;
  feedsFailed: number;
  newArticles: number;
}

/**
 * Tier 1 of the two-tier pipeline: deterministic feed ingestion. Fetch due
 * feeds with conditional GETs, parse, canonicalize, dedupe into SQLite, and
 * prune stale unbriefed articles. Zero tokens spent here.
 */
export class NewsSyncEngine {
  private readonly politeness = new HostPoliteness();

  constructor(private readonly deps: NewsSyncEngineDeps) {}

  async pollChannel(channelId: string, opts?: { force?: boolean }): Promise<PollResult> {
    const now = this.deps.now();
    const result: PollResult = { feedsPolled: 0, feedsFailed: 0, newArticles: 0 };
    const feeds = this.deps.sql
      .exec(
        `SELECT feed_id, url, title, etag, last_modified, fail_count, backoff_until
         FROM news_feeds WHERE channel_id = ? AND enabled = 1`,
        channelId
      )
      .toArray();
    for (const feed of feeds) {
      const backoffUntil = Number(feed["backoff_until"] ?? 0);
      if (!opts?.force && backoffUntil > now) continue;
      result.feedsPolled += 1;
      const added = await this.pollFeed(channelId, {
        feedId: String(feed["feed_id"]),
        url: String(feed["url"]),
        etag: (feed["etag"] as string | null) ?? undefined,
        lastModified: (feed["last_modified"] as string | null) ?? undefined,
        failCount: Number(feed["fail_count"] ?? 0),
      });
      if (added === null) result.feedsFailed += 1;
      else result.newArticles += added;
    }
    this.deps.sql.exec(
      `DELETE FROM news_articles
       WHERE channel_id = ? AND saved = 0 AND briefed_in IS NULL AND fetched_at < ?`,
      channelId,
      now - ARTICLE_RETENTION_MS
    );
    return result;
  }

  /** Returns new-article count, or null on fetch/parse failure (backoff applied). */
  private async pollFeed(
    channelId: string,
    feed: { feedId: string; url: string; etag?: string; lastModified?: string; failCount: number }
  ): Promise<number | null> {
    const now = this.deps.now();
    const waitMs = this.politeness.delayFor(feed.url, now);
    if (waitMs > 0) {
      const sleep =
        this.deps.sleep ??
        ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      await sleep(waitMs);
    }

    const fetched = await fetchFeed(feed.url, {
      etag: feed.etag,
      lastModified: feed.lastModified,
      fetcher: this.deps.fetcher,
    });
    if (fetched.status === "not-modified") {
      this.markFeedOk(channelId, feed.feedId, { status: "not-modified" });
      return 0;
    }
    if (fetched.status === "error") {
      this.markFeedFailed(channelId, feed.feedId, feed.failCount, fetched.error);
      return null;
    }

    let parsed;
    try {
      parsed = parseFeed(fetched.body, undefined, feed.url);
    } catch (err) {
      this.markFeedFailed(
        channelId,
        feed.feedId,
        feed.failCount,
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }

    let added = 0;
    for (const item of parsed.items.slice(0, MAX_ITEMS_PER_POLL)) {
      if (await this.insertArticle(channelId, { ...item, feedId: feed.feedId, origin: "feed" })) {
        added += 1;
      }
    }
    this.markFeedOk(channelId, feed.feedId, {
      status: "ok",
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      title: parsed.title,
    });
    return added;
  }

  /** Dedupe-insert one article. Returns true when it was new. */
  async insertArticle(
    channelId: string,
    item: {
      url: string;
      title: string;
      summary?: string;
      author?: string;
      publishedAt?: number;
      feedId?: string;
      origin: "feed" | "search";
      blurb?: string;
      /** Display source/publication for search articles (feed articles use the feed title). */
      source?: string;
    }
  ): Promise<boolean> {
    let canonical: string;
    let id: string;
    try {
      canonical = canonicalizeUrl(item.url);
      id = await articleId(item.url);
    } catch {
      return false; // unparseable URL — drop the item
    }
    const before = this.countArticles(channelId);
    this.deps.sql.exec(
      `INSERT OR IGNORE INTO news_articles
         (channel_id, article_id, feed_id, origin, canonical_url, title, title_sim_key, summary, author, source, published_at, fetched_at, blurb)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      id,
      item.feedId ?? null,
      item.origin,
      canonical,
      item.title,
      titleSimilarityKey(item.title),
      item.summary ?? null,
      item.author ?? null,
      item.source ?? null,
      item.publishedAt ?? null,
      this.deps.now(),
      item.blurb ?? null
    );
    return this.countArticles(channelId) > before;
  }

  /** Rank unbriefed articles for a briefing run. Pure read; no state change. */
  rankUnbriefed(channelId: string, topK: number): NewsStoryRef[] {
    const now = this.deps.now();
    const rows = this.deps.sql
      .exec(
        `SELECT a.article_id, a.canonical_url, a.title, a.summary, a.published_at, a.fetched_at,
                a.origin, a.read, a.blurb, a.source, f.title AS feed_title, f.weight AS feed_weight
         FROM news_articles a
         LEFT JOIN news_feeds f ON f.channel_id = a.channel_id AND f.feed_id = a.feed_id
         WHERE a.channel_id = ? AND a.briefed_in IS NULL AND a.read = 0`,
        channelId
      )
      .toArray();
    const scored = rows.map((row) => {
      const score = scoreArticle({
        publishedAt: row["published_at"] === null ? undefined : Number(row["published_at"]),
        fetchedAt: Number(row["fetched_at"]),
        feedWeight: row["feed_weight"] === null ? 1 : Number(row["feed_weight"]),
        now,
      });
      const summary = (row["summary"] as string | null) ?? undefined;
      const story: NewsStoryRef = {
        articleId: String(row["article_id"]),
        url: String(row["canonical_url"]),
        title: String(row["title"]),
        source:
          (row["feed_title"] as string | null) ??
          (row["source"] as string | null) ??
          (String(row["origin"]) === "search" ? "web search" : "feed"),
        origin: String(row["origin"]) === "search" ? "search" : "feed",
        publishedAt:
          row["published_at"] === null
            ? undefined
            : new Date(Number(row["published_at"])).toISOString(),
        score,
        blurb: ((row["blurb"] as string | null) ?? summary)?.slice(0, 280),
      };
      return story;
    });
    return rankTopK(scored, topK);
  }

  countArticles(channelId: string): number {
    const row = this.deps.sql
      .exec(`SELECT COUNT(*) AS n FROM news_articles WHERE channel_id = ?`, channelId)
      .toArray()[0];
    return Number(row?.["n"] ?? 0);
  }

  countUnbriefed(channelId: string): number {
    const row = this.deps.sql
      .exec(
        `SELECT COUNT(*) AS n FROM news_articles WHERE channel_id = ? AND briefed_in IS NULL`,
        channelId
      )
      .toArray()[0];
    return Number(row?.["n"] ?? 0);
  }

  private markFeedOk(
    channelId: string,
    feedId: string,
    info: { status: string; etag?: string; lastModified?: string; title?: string }
  ): void {
    this.deps.sql.exec(
      `UPDATE news_feeds SET
         last_fetch_at = ?, last_status = ?, fail_count = 0, backoff_until = NULL,
         etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
         title = COALESCE(?, title)
       WHERE channel_id = ? AND feed_id = ?`,
      this.deps.now(),
      info.status,
      info.etag ?? null,
      info.lastModified ?? null,
      info.title ?? null,
      channelId,
      feedId
    );
  }

  private markFeedFailed(
    channelId: string,
    feedId: string,
    priorFailCount: number,
    error: string
  ): void {
    const failCount = priorFailCount + 1;
    const backoff = Math.min(BACKOFF_MAX_MS, Math.pow(2, failCount - 1) * BACKOFF_BASE_MS);
    this.deps.sql.exec(
      `UPDATE news_feeds SET
         last_fetch_at = ?, last_status = ?, fail_count = ?, backoff_until = ?
       WHERE channel_id = ? AND feed_id = ?`,
      this.deps.now(),
      `error: ${error}`.slice(0, 200),
      failCount,
      this.deps.now() + backoff,
      channelId,
      feedId
    );
  }
}
