import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { rpcMethodAuthority } from "@vibestudio/rpc";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { Fetcher } from "@workspace/feeds";
import { articleId } from "@workspace/feeds";
import type { NewsBriefingCardState } from "@workspace/feeds/card-types";

import { NewsAgentWorker } from "./news-agent-worker.js";
import { NEWS_MESSAGE_TYPES } from "./cards.js";
import { ARTICLE_RETENTION_MS, INITIAL_BRIEFING_DELAY_MS } from "./types.js";

const FEED_URL = "https://example.com/feed.xml";

function rss(items: Array<{ title: string; link: string; pubDate?: string }>): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Example Feed</title>
    ${items
      .map(
        (item) =>
          `<item><title>${item.title}</title><link>${item.link}</link>${
            item.pubDate ? `<pubDate>${item.pubDate}</pubDate>` : ""
          }</item>`
      )
      .join("")}
  </channel></rss>`;
}

class TestNewsAgentWorker extends NewsAgentWorker {
  published: Array<{ participantId: string; event: { kind?: string; payload?: unknown } }> = [];
  signals: Array<{ participantId: string; content: string; type?: string }> = [];
  agentInitiatedTurns: Array<{ channelId: string; content: string }> = [];
  /** url → ordered list of responses; last one repeats. */
  feedResponses = new Map<
    string,
    Array<{ status: number; body?: string; headers?: Record<string, string> }>
  >();
  blobs = new Map<string, string>();
  clock: number = 1_750_000_000_000;

  execSqlForTest(query: string, ...args: unknown[]): void {
    this.sql.exec(query, ...args);
  }

  rowsForTest(query: string, ...args: unknown[]): Array<Record<string, unknown>> {
    return this.sql.exec(query, ...args).toArray() as Array<Record<string, unknown>>;
  }

  schedulerForTest() {
    return this["scheduler"];
  }

  schemaProductionBaselineForTest() {
    return this.schemaProductionBaseline();
  }

  loopTools(channelId = "ch-1") {
    return this.getLoopTools(channelId).map((tool) => tool.name);
  }

  seedUserRoster(channelId = "ch-1") {
    this.setStateValue(
      `agent:roster:${channelId}`,
      JSON.stringify([
        {
          participantId: "user:alice",
          ref: { kind: "user", id: "user:alice", participantId: "user:alice" },
          methods: [],
        },
      ])
    );
  }

  /** The exact loop tool object the model loop would dispatch for `name`. */
  loopTool(name: string, channelId = "ch-1") {
    return this.getLoopTools(channelId).find((tool) => tool.name === name);
  }

  async alarmAt(time: number) {
    this.clock = time;
    return this.alarm();
  }

  nextAlarmForTest() {
    return this.nextAlarmAfterRequest();
  }

  protected override now(): number {
    return this.clock;
  }

  protected override politenessSleep(): Promise<void> {
    return Promise.resolve();
  }

  rpcCall = vi.fn(async (_target: string, method: string, args?: unknown[]): Promise<unknown> => {
    if (method === "runtime.resolveContext") return "ctx-1";
    if (method === "workers.resolveService") {
      return { kind: "durable-object", targetId: "do:channel:test" };
    }
    if (method === "workspace.getAgentsMd") return "";
    if (method === "workspace.listSkills") return [];
    if (method === "workspace-state.alarmSet" || method === "workspace-state.alarmClear") {
      return undefined;
    }
    if (method === "fs.readFile") {
      const filePath = String(args?.[0] ?? "");
      if (filePath === "panels/news/renderers/news-setup.tsx") {
        return readFileSync(
          new URL("../../panels/news/renderers/news-setup.tsx", import.meta.url),
          "utf8"
        );
      }
      if (filePath === "panels/news/renderers/news-briefing.tsx") {
        return readFileSync(
          new URL("../../panels/news/renderers/news-briefing.tsx", import.meta.url),
          "utf8"
        );
      }
      throw new Error(`unexpected fs.readFile path: ${filePath}`);
    }
    if (method === "blobstore.putText") {
      const value = String(args?.[0] ?? "");
      const digest = `blob-${this.blobs.size + 1}`;
      this.blobs.set(digest, value);
      return { digest, size: value.length };
    }
    return null;
  });

  protected override get rpc(): never {
    return {
      call: this.rpcCall,
    } as never;
  }

  protected override feedFetcher(): Fetcher {
    return async (url) => {
      const queue = this.feedResponses.get(url);
      if (!queue || queue.length === 0) return new Response("not found", { status: 404 });
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return new Response(next.body ?? null, { status: next.status, headers: next.headers });
    };
  }

  seedSubscription(channelId = "ch-1", participantId = "agent-news") {
    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions
         (channel_id, context_id, revision, subscribed_at, config, relationship_json, participant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      "ctx-1",
      1,
      Date.now(),
      JSON.stringify({ handle: "news" }),
      JSON.stringify({ test: true }),
      participantId
    );
  }

  protected override async submitAgentInitiatedTurn(
    channelId: string,
    input: { content?: string }
  ): Promise<void> {
    this.agentInitiatedTurns.push({ channelId, content: input.content ?? "" });
  }

  protected override createChannelClient() {
    return {
      relationshipState: async () => null,
      join: async (input: { participantId: string }) => ({
        ok: true,
        participantId: input.participantId,
        channelConfig: undefined,
        envelope: { mode: "initial", logEvents: [], snapshots: [], ready: {} },
      }),
      leave: async () => ({ ok: true }),
      getConfig: async () => null,
      getParticipants: async () => [],
      getReplayAfter: async () => ({
        mode: "after",
        logEvents: [],
        snapshots: [],
        ready: { totalCount: 0, envelopeCount: 0 },
      }),
      publishAgenticEvent: async (
        participantId: string,
        event: { kind?: string; payload?: unknown }
      ) => {
        this.published.push({ participantId, event });
        return { id: this.published.length };
      },
      sendSignal: async (participantId: string, content: string, type?: string) => {
        this.signals.push({ participantId, content, type });
      },
      sendSignalEvent: async (participantId: string, contentType: string, payload: unknown) => {
        this.signals.push({ participantId, content: JSON.stringify(payload), type: contentType });
      },
      publishSignalFact: async (
        participantId: string,
        contentType: string,
        payload: unknown
      ) => {
        this.signals.push({ participantId, content: JSON.stringify(payload), type: contentType });
      },
      getMessageType: async (typeId: string) => {
        const spec = NEWS_MESSAGE_TYPES.find((entry) => entry.typeId === typeId);
        if (!spec) return null;
        return {
          typeId: spec.typeId,
          displayMode: spec.displayMode,
          stateSchema: spec.stateSchema,
        };
      },
    } as never;
  }
}

async function makeWorker() {
  const { instance } = await createTestDO(TestNewsAgentWorker, {
    WORKERD_SESSION_ID: "test-session",
    WORKERD_BOOT_GENERATION: "1",
  });
  const worker = instance as TestNewsAgentWorker;
  worker.seedSubscription();
  return worker;
}

async function addExampleFeed(
  worker: TestNewsAgentWorker,
  items: Array<{ title: string; link: string; pubDate?: string }>
) {
  worker.feedResponses.set(FEED_URL, [
    { status: 200, body: rss(items), headers: { etag: '"v1"' } },
  ]);
  return (await worker.addFeed("ch-1", { url: FEED_URL })) as Record<string, unknown>;
}

describe("NewsAgentWorker", () => {
  it("declares version 8 as its production schema baseline", async () => {
    const worker = await makeWorker();
    expect(NewsAgentWorker.schemaVersion).toBe(8);
    expect(worker.schemaProductionBaselineForTest()).toEqual({
      version: 8,
      name: "news-agent-v8",
    });
  });

  it("keeps every channel-scoped news operation off the direct RPC plane", async () => {
    const worker = await makeWorker();
    for (const method of [
      "getOverview",
      "listArticles",
      "briefingHistory",
      "searchArchive",
      "startDeepDive",
      "addFeed",
      "markRead",
      "setSaved",
      "refreshNow",
      "setSchedule",
    ]) {
      expect(rpcMethodAuthority(worker, method)).toBeUndefined();
    }
  });

  it("exposes the web research tools its briefing prompt requires", async () => {
    const worker = await makeWorker();
    worker.seedUserRoster();
    expect(worker.loopTools()).toEqual(
      expect.arrayContaining([
        "suspend_turn",
        "ask_user",
        "web_search",
        "web_fetch",
        "web_read",
        "news_add_feed",
        "news_follow_topic",
        "news_publish_briefing",
      ])
    );
  });

  it("addFeed validates by fetching, ingests immediately, and dedupes across polls", async () => {
    const worker = await makeWorker();
    const result = await addExampleFeed(worker, [
      { title: "First story", link: "https://example.com/a?utm_source=rss" },
      { title: "Second story", link: "https://example.com/b" },
    ]);
    expect(result).toMatchObject({ title: "Example Feed", itemCount: 2, newArticles: 2 });

    // Re-poll the same content: nothing new (URL canonicalization dedupes).
    const poll = (await worker.refreshNow("ch-1", {})) as Record<string, unknown>;
    expect(poll["unbriefed"]).toBe(2);
    const rows = worker.rowsForTest(`SELECT article_id, canonical_url FROM news_articles`);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row["canonical_url"])).toContain("https://example.com/a");
  });

  it("rejects unfetchable or unparseable feeds", async () => {
    const worker = await makeWorker();
    worker.feedResponses.set("https://bad.example/feed", [{ status: 503 }]);
    expect(await worker.addFeed("ch-1", { url: "https://bad.example/feed" })).toMatchObject({
      error: expect.stringContaining("not reachable"),
    });
    worker.feedResponses.set("https://html.example/page", [{ status: 200, body: "<html></html>" }]);
    expect(await worker.addFeed("ch-1", { url: "https://html.example/page" })).toMatchObject({
      error: expect.stringContaining("no RSS/Atom link found"),
    });
  });

  it("autodiscovers a feed when given a site URL instead of a feed URL", async () => {
    const worker = await makeWorker();
    const siteUrl = "https://blog.example/";
    const feedUrl = "https://blog.example/rss.xml";
    worker.feedResponses.set(siteUrl, [
      {
        status: 200,
        body: `<html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head></html>`,
      },
    ]);
    worker.feedResponses.set(feedUrl, [
      { status: 200, body: rss([{ title: "Hello", link: "https://blog.example/hello" }]) },
    ]);
    const result = (await worker.addFeed("ch-1", { url: siteUrl })) as Record<string, unknown>;
    expect(result).toMatchObject({ url: feedUrl, discoveredFrom: siteUrl, newArticles: 1 });
    expect(worker.rowsForTest(`SELECT url FROM news_feeds`)[0]!["url"]).toBe(feedUrl);
  });

  it("applies growing backoff to failing feeds and recovers on success", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [{ title: "A", link: "https://example.com/a" }]);
    worker.feedResponses.set(FEED_URL, [{ status: 500 }]);
    await worker.refreshNow("ch-1", {});
    const failed = worker.rowsForTest(`SELECT fail_count, backoff_until FROM news_feeds`)[0]!;
    expect(Number(failed["fail_count"])).toBe(1);
    expect(Number(failed["backoff_until"])).toBeGreaterThan(worker.clock);

    // force-refresh ignores backoff; second failure doubles it
    await worker.refreshNow("ch-1", {});
    const failed2 = worker.rowsForTest(`SELECT fail_count, backoff_until FROM news_feeds`)[0]!;
    expect(Number(failed2["fail_count"])).toBe(2);
    expect(Number(failed2["backoff_until"]) - worker.clock).toBeGreaterThan(
      Number(failed["backoff_until"]) - worker.clock
    );

    worker.feedResponses.set(FEED_URL, [
      { status: 200, body: rss([{ title: "B", link: "https://example.com/b" }]) },
    ]);
    await worker.refreshNow("ch-1", {});
    const recovered = worker.rowsForTest(`SELECT fail_count, last_status FROM news_feeds`)[0]!;
    expect(Number(recovered["fail_count"])).toBe(0);
    expect(String(recovered["last_status"])).toBe("ok");
  });

  it("subscribeChannel installs UI, publishes the setup card, and seeds jobs without starting a model turn", async () => {
    const worker = await makeWorker();
    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" } as never);

    const kinds = worker.published.map((entry) => entry.event.kind);
    expect(kinds).toContain("messageType.registered");
    expect(kinds).toContain("custom.started"); // setup card

    const jobs = worker.rowsForTest(`SELECT job_id FROM recurring_jobs ORDER BY job_id`);
    expect(jobs.map((row) => row["job_id"])).toEqual(["briefing:ch-1", "poll:ch-1"]);
    const recurringWakeAt = worker.schedulerForTest().nextWakeAt();
    expect(recurringWakeAt).toBeDefined();
    expect(worker.nextAlarmForTest()?.wakeAt).toBeLessThanOrEqual(recurringWakeAt!);

    expect(worker.agentInitiatedTurns).toHaveLength(0);
    // Re-subscribe does not re-prompt.
    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" } as never);
    expect(worker.agentInitiatedTurns).toHaveLength(0);
  });

  it("briefing run creates a summarizing card and a self-contained turn prompt", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [
      {
        title: "Big launch happened",
        link: "https://example.com/launch",
        pubDate: new Date(worker.clock - 3_600_000).toUTCString(),
      },
      {
        title: "Minor update shipped",
        link: "https://example.com/minor",
        pubDate: new Date(worker.clock - 50 * 3_600_000).toUTCString(),
      },
    ]);
    await worker.followTopic("ch-1", { topic: "AI agents" });
    await worker.setPreferences("ch-1", { text: "less crypto, terse blurbs" });
    // Seed a prior briefing for continuity.
    worker.execSqlForTest(
      `INSERT INTO news_briefings (channel_id, briefing_id, created_at, status, tldr, story_ids_json)
       VALUES ('ch-1', 'prev', ?, 'ready', 'Yesterday: the foo merged.', '[]')`,
      worker.clock - 86_400_000
    );

    await worker.refreshNow("ch-1", { briefing: true });

    const briefing = worker.rowsForTest(
      `SELECT briefing_id, status FROM news_briefings WHERE briefing_id != 'prev'`
    )[0]!;
    expect(String(briefing["status"])).toBe("summarizing");

    const turn = worker.agentInitiatedTurns[worker.agentInitiatedTurns.length - 1]!;
    expect(turn.content).toContain("Big launch happened");
    expect(turn.content).toContain("AI agents");
    expect(turn.content).toContain("Yesterday: the foo merged.");
    expect(turn.content).toContain("less crypto, terse blurbs");
    expect(turn.content).toContain(String(briefing["briefing_id"]));
  });

  it("news_publish_briefing finalizes the card, marks stories briefed, and merges search stories", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [
      { title: "Keep me", link: "https://example.com/keep" },
      { title: "Drop me", link: "https://example.com/drop" },
    ]);
    await worker.refreshNow("ch-1", { briefing: true });
    const briefingId = String(
      worker.rowsForTest(`SELECT briefing_id FROM news_briefings`)[0]!["briefing_id"]
    );
    const keepId = await articleId("https://example.com/keep");
    const dropId = await articleId("https://example.com/drop");

    const result = (await worker.publishBriefing("ch-1", {
      briefingId,
      tldr: "**Keep me** shipped.",
      storyBlurbs: [{ articleId: keepId.slice(0, 8), blurb: "It shipped." }],
      droppedArticleIds: [dropId.slice(0, 8)],
      searchStories: [
        {
          url: "https://elsewhere.example/found",
          title: "Found via search",
          blurb: "From topics.",
        },
        {
          url: "https://elsewhere.example/found?utm_source=dup",
          title: "Duplicate via search",
          blurb: "Duplicate should be ignored.",
        },
        {
          url: "file:///tmp/private",
          title: "Not a web citation",
          blurb: "Should be ignored.",
        },
        ...Array.from({ length: 12 }, (_, index) => ({
          url: `https://elsewhere.example/found-${index}`,
          title: `Found ${index}`,
          blurb: "From topics.",
        })),
      ],
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ published: briefingId, storyCount: 11 });

    const articles = worker.rowsForTest(
      `SELECT article_id, briefed_in, blurb, origin FROM news_articles ORDER BY canonical_url`
    );
    const kept = articles.find((row) => row["article_id"] === keepId)!;
    expect(kept["briefed_in"]).toBe(briefingId);
    expect(kept["blurb"]).toBe("It shipped.");
    const droppedRow = articles.find((row) => row["article_id"] === dropId)!;
    expect(String(droppedRow["briefed_in"])).toBe(`dropped:${briefingId}`);
    expect(articles.filter((row) => row["origin"] === "search")).toHaveLength(10);
    expect(articles.some((row) => row["canonical_url"] === "file:///tmp/private")).toBe(false);

    expect(
      worker.rowsForTest(
        `SELECT status, tldr FROM news_briefings WHERE briefing_id = ?`,
        briefingId
      )[0]
    ).toMatchObject({ status: "ready", tldr: "**Keep me** shipped." });

    // Next briefing prompt carries this TLDR forward.
    await worker.refreshNow("ch-1", {});
    worker.feedResponses.set(FEED_URL, [
      { status: 200, body: rss([{ title: "New day", link: "https://example.com/new" }]) },
    ]);
    await worker.refreshNow("ch-1", { briefing: true });
    expect(worker.agentInitiatedTurns[worker.agentInitiatedTurns.length - 1]!.content).toContain(
      "**Keep me** shipped."
    );
  });

  it("rejects search/listing URLs and persists the real source + blurb for search stories", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [{ title: "Keep me", link: "https://example.com/keep" }]);
    await worker.refreshNow("ch-1", { briefing: true });
    const briefingId = String(
      worker.rowsForTest(`SELECT briefing_id FROM news_briefings`)[0]!["briefing_id"]
    );

    const result = (await worker.publishBriefing("ch-1", {
      briefingId,
      tldr: "**Today** in review.",
      searchStories: [
        {
          url: "https://acme.example/articles/the-real-story",
          title: "The real story",
          source: "ACME Times",
          blurb: "A concrete, substantive summary of what happened.",
        },
        // Search-engine result page — must be rejected by the guard.
        {
          url: "https://www.google.com/search?q=ai+news",
          title: "Search results",
          source: "Google",
        },
        // On-site search endpoint — also rejected.
        { url: "https://acme.example/search?query=ai", title: "Site search", source: "ACME" },
      ],
    })) as Record<string, unknown>;
    // Only the concrete article survives (1 feed keep + 1 search = 2).
    expect(result).toMatchObject({ storyCount: 2 });

    const search = worker.rowsForTest(
      `SELECT canonical_url, source, blurb FROM news_articles WHERE origin = 'search'`
    );
    expect(search).toHaveLength(1);
    expect(search[0]!["source"]).toBe("ACME Times");
    expect(search[0]!["blurb"]).toBe("A concrete, substantive summary of what happened.");
    expect(
      worker
        .rowsForTest(`SELECT canonical_url FROM news_articles`)
        .some((row) => String(row["canonical_url"]).includes("/search"))
    ).toBe(false);

    // listArticles surfaces the real source + blurb and hides dropped items.
    const listed = (await worker.listArticles("ch-1", {})) as {
      articles: Array<{ title: string; source: string; blurb?: string }>;
    };
    const real = listed.articles.find((a) => a.title === "The real story")!;
    expect(real.source).toBe("ACME Times");
    expect(real.blurb).toBe("A concrete, substantive summary of what happened.");
  });

  it("pulls the first briefing forward to minutes after the first source is configured", async () => {
    const worker = await makeWorker();
    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" } as never);
    const briefingDue = () =>
      Number(
        worker.rowsForTest(
          `SELECT next_run_at FROM recurring_jobs WHERE job_id = 'briefing:ch-1'`
        )[0]!["next_run_at"]
      );
    // Before any source: the first briefing is a full interval out.
    expect(briefingDue() - worker.clock).toBeGreaterThan(60 * 60_000);
    await addExampleFeed(worker, [{ title: "A", link: "https://example.com/a" }]);
    // After the first source: pulled forward to the cold-start window.
    expect(briefingDue() - worker.clock).toBeLessThanOrEqual(INITIAL_BRIEFING_DELAY_MS);
  });

  it("reactToStory records feedback, mutes the source feed, and folds signals into the next briefing", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [
      { title: "Crypto thing", link: "https://example.com/crypto" },
      { title: "Rust async runtimes", link: "https://example.com/rust" },
      { title: "Neutral thing", link: "https://example.com/neutral" },
    ]);
    const cryptoId = await articleId("https://example.com/crypto");
    const rustId = await articleId("https://example.com/rust");

    await worker.reactToStory("ch-1", { articleId: rustId.slice(0, 8), reaction: "more" });
    const less = (await worker.reactToStory("ch-1", {
      articleId: cryptoId.slice(0, 8),
      reaction: "less",
    })) as Record<string, unknown>;
    expect(less).toMatchObject({ recorded: "less" });
    // "less" marks the story read so ranking skips it.
    expect(
      Number(
        worker.rowsForTest(`SELECT read FROM news_articles WHERE article_id = ?`, cryptoId)[0]![
          "read"
        ]
      )
    ).toBe(1);

    const mute = (await worker.reactToStory("ch-1", {
      articleId: cryptoId.slice(0, 8),
      reaction: "mute_source",
    })) as Record<string, unknown>;
    expect(mute).toMatchObject({ feedDisabled: true });
    expect(Number(worker.rowsForTest(`SELECT enabled FROM news_feeds`)[0]!["enabled"])).toBe(0);

    await worker.refreshNow("ch-1", { briefing: true });
    const turn = worker.agentInitiatedTurns[worker.agentInitiatedTurns.length - 1]!;
    expect(turn.content).toContain("Reader feedback");
    expect(turn.content).toContain("More like:");
    expect(turn.content).toContain("Avoid source:");
  });

  it("records sourcesRead and exposes it on the briefing and its history", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [{ title: "Keep", link: "https://example.com/keep" }]);
    await worker.refreshNow("ch-1", { briefing: true });
    const briefingId = String(
      worker.rowsForTest(`SELECT briefing_id FROM news_briefings`)[0]!["briefing_id"]
    );
    await worker.publishBriefing("ch-1", { briefingId, tldr: "**Lede.**", sourcesRead: 7 });
    expect(
      Number(
        worker.rowsForTest(
          `SELECT sources_read FROM news_briefings WHERE briefing_id = ?`,
          briefingId
        )[0]!["sources_read"]
      )
    ).toBe(7);
    const history = (await worker.briefingHistory("ch-1", {})) as {
      briefings: Array<{ sourcesRead?: number }>;
    };
    expect(history.briefings[0]!.sourcesRead).toBe(7);
  });

  it("flags scheduled briefings to notify but keeps manual 'brief me now' silent", async () => {
    const worker = await makeWorker();
    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" } as never);
    await addExampleFeed(worker, [{ title: "A", link: "https://example.com/a" }]);

    // The cold-start briefing fires via the scheduler alarm → flagged to notify.
    await worker.alarmAt(worker.clock + INITIAL_BRIEFING_DELAY_MS + 1_000);
    // A manual brief-me-now is silent.
    await worker.refreshNow("ch-1", { briefing: true });

    const flags = worker
      .rowsForTest(`SELECT notify FROM news_briefings`)
      .map((row) => Number(row["notify"]));
    expect(flags).toContain(1); // scheduled / cold-start
    expect(flags).toContain(0); // manual
  });

  it("setSaved bookmarks an article and the Saved filter returns it", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [
      { title: "Keep this", link: "https://example.com/a" },
      { title: "Skip this", link: "https://example.com/b" },
    ]);
    const aId = await articleId("https://example.com/a");
    await worker.setSaved("ch-1", { articleId: aId.slice(0, 8), saved: true });
    const saved = (await worker.listArticles("ch-1", { savedOnly: true })) as {
      articles: Array<{ title: string; saved: boolean }>;
    };
    expect(saved.articles).toHaveLength(1);
    expect(saved.articles[0]).toMatchObject({ title: "Keep this", saved: true });
    await worker.setSaved("ch-1", { articleId: aId.slice(0, 8), saved: false });
    expect(
      ((await worker.listArticles("ch-1", { savedOnly: true })) as { articles: unknown[] }).articles
    ).toHaveLength(0);
  });

  it("retention preserves saved articles while pruning stale unsaved articles", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [
      { title: "Keep this", link: "https://example.com/keep" },
      { title: "Let this expire", link: "https://example.com/expire" },
    ]);
    const keepId = await articleId("https://example.com/keep");
    await worker.setSaved("ch-1", { articleId: keepId, saved: true });
    worker.execSqlForTest(
      `UPDATE news_articles SET fetched_at = ? WHERE channel_id = ?`,
      worker.clock - ARTICLE_RETENTION_MS - 1,
      "ch-1"
    );

    await worker.refreshNow("ch-1", {});

    const rows = worker.rowsForTest(
      `SELECT title, saved FROM news_articles WHERE channel_id = ? ORDER BY title`,
      "ch-1"
    );
    expect(rows).toEqual([{ title: "Keep this", saved: 1 }]);
  });

  it("paginates the canonical article query without duplicates", async () => {
    const worker = await makeWorker();
    await addExampleFeed(
      worker,
      Array.from({ length: 25 }, (_, index) => ({
        title: `Story ${index}`,
        link: `https://example.com/story-${index}`,
      }))
    );
    worker.execSqlForTest(`UPDATE news_articles SET triaged = 1 WHERE channel_id = ?`, "ch-1");

    const first = (await worker.listArticles("ch-1", { triagedOnly: true, limit: 10 })) as {
      articles: Array<{ articleId: string }>;
      hasMore: boolean;
      nextCursor: string;
    };
    const second = (await worker.listArticles("ch-1", {
      triagedOnly: true,
      limit: 10,
      cursor: first.nextCursor,
    })) as typeof first;

    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(true);
    expect(
      new Set([...first.articles, ...second.articles].map((item) => item.articleId)).size
    ).toBe(20);
  });

  it("searchArchive matches article fields and past briefing TLDRs", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [
      { title: "Rust async runtimes", link: "https://example.com/rust" },
      { title: "Crypto regulation", link: "https://example.com/crypto" },
    ]);
    await worker.refreshNow("ch-1", { briefing: true });
    const briefingId = String(
      worker.rowsForTest(`SELECT briefing_id FROM news_briefings`)[0]!["briefing_id"]
    );
    await worker.publishBriefing("ch-1", { briefingId, tldr: "## Rust\nBig **Rust** news today." });
    const res = (await worker.searchArchive("ch-1", { query: "rust" })) as {
      articles: Array<{ title: string }>;
      briefings: Array<{ briefingId: string }>;
    };
    expect(res.articles.some((article) => article.title === "Rust async runtimes")).toBe(true);
    expect(res.articles.some((article) => article.title === "Crypto regulation")).toBe(false);
    expect(res.briefings).toHaveLength(1);
  });

  it("pausing skips scheduled briefings but manual brief-me-now still runs", async () => {
    const worker = await makeWorker();
    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" } as never);
    await addExampleFeed(worker, [{ title: "A", link: "https://example.com/a" }]);
    await worker.setBriefingPaused("ch-1", { paused: true });
    // The cold-start briefing slot fires via the alarm → must NOT brief while paused.
    await worker.alarmAt(worker.clock + INITIAL_BRIEFING_DELAY_MS + 1_000);
    expect(worker.rowsForTest(`SELECT briefing_id FROM news_briefings`)).toHaveLength(0);
    // Manual "Brief me now" still works while paused.
    await worker.refreshNow("ch-1", { briefing: true });
    expect(worker.rowsForTest(`SELECT briefing_id FROM news_briefings`).length).toBeGreaterThan(0);
  });

  it("triage categorizes/clusters/drops stories; the reader shows only triaged items", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [
      { title: "Quake hits region", link: "https://a.example/quake" },
      { title: "Earthquake update", link: "https://b.example/quake2" },
      { title: "SEO spam listicle", link: "https://spam.example/x" },
    ]);
    // Nothing is triaged yet → the reader (triagedOnly) shows nothing, but the
    // un-triaged backlog is peekable (for the "Categorizing…" drill-down).
    expect(
      ((await worker.listArticles("ch-1", { triagedOnly: true })) as { articles: unknown[] })
        .articles
    ).toHaveLength(0);
    expect(
      ((await worker.listArticles("ch-1", { untriagedOnly: true })) as { articles: unknown[] })
        .articles
    ).toHaveLength(3);

    const started = (await worker.triageNow("ch-1", {})) as { started: boolean; pending: number };
    expect(started).toMatchObject({ started: true });
    expect(started.pending).toBe(3);

    // Simulate the agent's triage tool call.
    const quakeId = await articleId("https://a.example/quake");
    const quake2Id = await articleId("https://b.example/quake2");
    const spamId = await articleId("https://spam.example/x");
    await worker.triageStories("ch-1", {
      items: [
        {
          articleId: quakeId.slice(0, 8),
          category: "World",
          clusterKey: "quake-2026",
          blurb: "A quake hit.",
        },
        {
          articleId: quake2Id.slice(0, 8),
          category: "World",
          clusterKey: "quake-2026",
          blurb: "Quake aftermath.",
        },
        { articleId: spamId.slice(0, 8), keep: false },
      ],
    });

    const after = (await worker.listArticles("ch-1", { triagedOnly: true })) as {
      articles: Array<{ title: string; category?: string; clusterKey?: string }>;
    };
    // Spam dropped; the two quake stories show with a category and a shared cluster.
    expect(after.articles.map((a) => a.title).sort()).toEqual([
      "Earthquake update",
      "Quake hits region",
    ]);
    expect(after.articles.every((a) => a.category === "World")).toBe(true);
    expect(new Set(after.articles.map((a) => a.clusterKey))).toEqual(new Set(["quake-2026"]));
    // Backlog cleared → a second triageNow is a no-op.
    expect(((await worker.triageNow("ch-1", {})) as { pending: number }).pending).toBe(0);
  });

  it("continues triage until a backlog larger than one batch is drained", async () => {
    const worker = await makeWorker();
    await addExampleFeed(
      worker,
      Array.from({ length: 55 }, (_, index) => ({
        title: `Backlog ${index}`,
        link: `https://example.com/backlog-${index}`,
      }))
    );
    // Feed parsing deliberately bounds one document. Insert the remaining five
    // canonical rows directly so this test targets the triage batch boundary.
    const existing = Number(
      worker.rowsForTest(
        `SELECT COUNT(*) AS n FROM news_articles WHERE channel_id = ?`,
        "ch-1"
      )[0]!["n"]
    );
    for (let index = existing; index < 55; index += 1) {
      const url = `https://example.com/backlog-extra-${index}`;
      worker.execSqlForTest(
        `INSERT INTO news_articles
         (channel_id, article_id, origin, canonical_url, title, fetched_at)
         VALUES (?, ?, 'feed', ?, ?, ?)`,
        "ch-1",
        await articleId(url),
        url,
        `Extra backlog ${index}`,
        worker.clock
      );
    }
    expect((await worker.triageNow("ch-1", {})) as unknown).toMatchObject({
      started: true,
      pending: 55,
    });
    expect(worker.agentInitiatedTurns).toHaveLength(1);

    const ids = worker
      .rowsForTest(
        `SELECT article_id FROM news_articles WHERE channel_id = ? ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 50`,
        "ch-1"
      )
      .map((row) => String(row["article_id"]));
    const first = await worker.triageStories("ch-1", {
      items: ids.map((articleId) => ({ articleId, category: "Latest" })),
    });

    expect(first).toMatchObject({ triaged: 50, remaining: 5, continued: true });
    expect(worker.agentInitiatedTurns).toHaveLength(2);

    const remainingIds = worker
      .rowsForTest(
        `SELECT article_id FROM news_articles WHERE channel_id = ? AND triaged = 0`,
        "ch-1"
      )
      .map((row) => String(row["article_id"]));
    expect(
      await worker.triageStories("ch-1", {
        items: remainingIds.map((articleId) => ({ articleId, category: "Latest" })),
      })
    ).toMatchObject({ triaged: 5, remaining: 0, continued: false });
  });

  it("scheduler alarm drives polls and watchdogs stuck briefings", async () => {
    const worker = await makeWorker();
    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" } as never);
    await addExampleFeed(worker, [{ title: "A", link: "https://example.com/a" }]);

    // Stuck briefing from 31 minutes ago flips to error on the next poll.
    worker.execSqlForTest(
      `INSERT INTO news_briefings (channel_id, briefing_id, created_at, status, story_ids_json)
       VALUES ('ch-1', 'stuck', ?, 'summarizing', '[]')`,
      worker.clock - 31 * 60_000
    );
    await worker.alarmAt(worker.clock + 1); // poll job is due immediately after subscribe
    expect(
      worker.rowsForTest(`SELECT status FROM news_briefings WHERE briefing_id = 'stuck'`)[0]![
        "status"
      ]
    ).toBe("error");

    // The poll job rescheduled itself.
    const next = Number(
      worker.rowsForTest(`SELECT next_run_at FROM recurring_jobs WHERE job_id = 'poll:ch-1'`)[0]![
        "next_run_at"
      ]
    );
    expect(next).toBeGreaterThan(worker.clock);
  });

  it("importOpml bulk-adds the feeds it can validate", async () => {
    const worker = await makeWorker();
    const goodA = "https://example.com/a.xml";
    const goodB = "https://example.com/b.xml";
    const bad = "https://bad.example/feed.xml";
    worker.feedResponses.set(goodA, [
      { status: 200, body: rss([{ title: "A1", link: "https://example.com/a1" }]) },
    ]);
    worker.feedResponses.set(goodB, [
      { status: 200, body: rss([{ title: "B1", link: "https://example.com/b1" }]) },
    ]);
    worker.feedResponses.set(bad, [{ status: 500 }]);

    const opml = `<opml><body>
      <outline title="A" xmlUrl="${goodA}" />
      <outline text="Group"><outline xmlUrl="${goodB}" /><outline xmlUrl="${bad}" /></outline>
    </body></opml>`;
    const result = (await worker.importOpml("ch-1", { opml })) as Record<string, unknown>;
    expect(result).toMatchObject({ imported: 2, failed: 1, total: 3 });
    expect(
      worker.rowsForTest(`SELECT url FROM news_feeds ORDER BY url`).map((r) => r["url"])
    ).toEqual([goodA, goodB]);

    expect(await worker.importOpml("ch-1", { opml: "<opml><body></body></opml>" })).toMatchObject({
      error: expect.stringContaining("no feed subscriptions"),
    });
  });

  it("requestDeepDive resolves id prefixes and emits the typed signal", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [{ title: "Dive story", link: "https://example.com/dive" }]);
    const id = await articleId("https://example.com/dive");

    const result = (await worker.requestDeepDive("ch-1", { articleId: id.slice(0, 8) })) as Record<
      string,
      unknown
    >;
    expect(result["requested"]).toMatchObject({ articleId: id, title: "Dive story" });
    const signal = worker.signals[worker.signals.length - 1]!;
    expect(signal.type).toBe("news.deepdive.requested");
    expect(JSON.parse(signal.content)).toMatchObject({ url: "https://example.com/dive" });

    expect(await worker.requestDeepDive("ch-1", { articleId: "nope" })).toMatchObject({
      error: expect.stringContaining("unknown article"),
    });
  });

  it("onMethodCall routes operations and rejects unknown methods", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [{ title: "A", link: "https://example.com/a" }]);

    const overview = await worker.onMethodCall("ch-1", "call-1", "getOverview", {});
    expect(record(overview.result)["articleCount"]).toBe(1);

    const schedule = await worker.onMethodCall("ch-1", "call-2", "setSchedule", {
      briefingAt: "08:00",
    });
    expect(record(schedule.result)["briefingAtMinutes"]).toBe(480);

    const followed = await worker.onMethodCall("ch-1", "call-3", "news_follow_topic", {
      topic: "distributed systems",
    });
    expect(followed.isError).not.toBe(true);

    const retiredAlias = await worker.onMethodCall("ch-1", "call-4", "followTopic", {
      topic: "legacy",
    });
    expect(retiredAlias.isError).toBe(true);

    const unknown = await worker.onMethodCall("ch-1", "call-5", "fly", {});
    expect(unknown.isError).toBe(true);

    // Tool-only operations are not callable as methods.
    const toolOnly = await worker.onMethodCall("ch-1", "call-6", "news_publish_briefing", {});
    expect(toolOnly.isError).toBe(true);
  });

  it("markRead excludes articles from ranking", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [
      { title: "Read me not", link: "https://example.com/x" },
      { title: "Fresh", link: "https://example.com/y" },
    ]);
    const id = await articleId("https://example.com/x");
    await worker.markRead("ch-1", { articleIds: [id.slice(0, 10)] });
    await worker.refreshNow("ch-1", { briefing: true });
    const turn = worker.agentInitiatedTurns[worker.agentInitiatedTurns.length - 1]!;
    expect(turn.content).toContain("Fresh");
    expect(turn.content).not.toContain("Read me not");
  });

  it("markAllRead applies beyond the currently requested reader page", async () => {
    const worker = await makeWorker();
    await addExampleFeed(
      worker,
      Array.from({ length: 25 }, (_, index) => ({
        title: `Unread ${index}`,
        link: `https://example.com/unread-${index}`,
      }))
    );
    worker.execSqlForTest(`UPDATE news_articles SET triaged = 1 WHERE channel_id = ?`, "ch-1");
    expect(
      (
        (await worker.listArticles("ch-1", { triagedOnly: true, limit: 10 })) as {
          articles: unknown[];
        }
      ).articles
    ).toHaveLength(10);

    expect(await worker.markAllRead("ch-1", {})).toEqual({ markedRead: 25 });
    expect(worker.rowsForTest(`SELECT article_id FROM news_articles WHERE read = 0`)).toHaveLength(
      0
    );
  });

  it("startDeepDive switches a forked channel to analyst mode and seeds an analyst turn", async () => {
    const worker = await makeWorker();
    worker.seedSubscription("fork-1", "agent-fork");
    // A clone copies the parent's jobs wholesale; startDeepDive must clear them.
    worker.execSqlForTest(
      `INSERT INTO recurring_jobs (job_id, channel_id, interval_ms, jitter_ms, next_run_at)
       VALUES ('poll:fork-1', 'fork-1', 1800000, 0, ?)`,
      worker.clock
    );

    const result = await worker.startDeepDive("fork-1", {
      articleId: "abc12345",
      url: "https://example.com/story",
      title: "A consequential story",
      source: "Example",
      briefingTldr: "Yesterday: the thing shipped.",
    });
    expect(result).toMatchObject({ ok: true });

    expect(
      worker.rowsForTest(`SELECT mode FROM news_channel_state WHERE channel_id = 'fork-1'`)[0]![
        "mode"
      ]
    ).toBe("analyst");
    expect(
      worker.rowsForTest(`SELECT job_id FROM recurring_jobs WHERE channel_id = 'fork-1'`)
    ).toHaveLength(0);

    const turn = worker.agentInitiatedTurns[worker.agentInitiatedTurns.length - 1]!;
    expect(turn.channelId).toBe("fork-1");
    expect(turn.content).toContain("A consequential story");
    expect(turn.content).toContain("https://example.com/story");
    expect(turn.content).toContain("Yesterday: the thing shipped.");

    expect(await worker.startDeepDive("fork-1", { url: "" } as never)).toMatchObject({
      ok: false,
      error: expect.stringContaining("required"),
    });
  });

  it("analyst (deep-dive) channels skip curator bootstrap on subscribe", async () => {
    const worker = await makeWorker();
    worker.seedSubscription("an-1", "agent-an");
    worker.execSqlForTest(
      `INSERT INTO news_channel_state (channel_id, poll_interval_ms, briefing_interval_ms, setup_status, mode)
       VALUES ('an-1', 1800000, 86400000, 'configured', 'analyst')`
    );

    await worker.subscribeChannel({ channelId: "an-1", contextId: "ctx-1" } as never);

    const kinds = worker.published.map((entry) => entry.event.kind);
    expect(kinds).toContain("messageType.registered"); // UI still installed
    expect(kinds).not.toContain("custom.started"); // but no setup card
    expect(
      worker.rowsForTest(`SELECT job_id FROM recurring_jobs WHERE channel_id = 'an-1'`)
    ).toHaveLength(0);
    expect(worker.agentInitiatedTurns).toHaveLength(0); // no onboarding
  });

  it("drops scheduler jobs for channels it is no longer subscribed to", async () => {
    const worker = await makeWorker();
    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" } as never);
    // A stale job a clone might carry, for a channel we hold no subscription on.
    worker.execSqlForTest(
      `INSERT INTO recurring_jobs (job_id, channel_id, interval_ms, jitter_ms, next_run_at)
       VALUES ('poll:ghost', 'ghost', 1800000, 0, ?)`,
      worker.clock
    );

    await worker.alarmAt(worker.clock + 1);

    expect(
      worker.rowsForTest(`SELECT job_id FROM recurring_jobs WHERE channel_id = 'ghost'`)
    ).toHaveLength(0);
    expect(
      worker.rowsForTest(`SELECT job_id FROM recurring_jobs WHERE channel_id = 'ch-1'`).length
    ).toBeGreaterThan(0);
  });

  it("arms a self-canceling watchdog that flips a stalled briefing to error", async () => {
    const worker = await makeWorker();
    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" } as never);
    await addExampleFeed(worker, [{ title: "Story", link: "https://example.com/s" }]);

    await worker.refreshNow("ch-1", { briefing: true });
    expect(
      worker.rowsForTest(`SELECT job_id FROM recurring_jobs WHERE job_id = 'watchdog:ch-1'`)
    ).toHaveLength(1);
    const briefingId = String(
      worker.rowsForTest(`SELECT briefing_id FROM news_briefings`)[0]!["briefing_id"]
    );

    await worker.alarmAt(worker.clock + 11 * 60_000);

    expect(
      worker.rowsForTest(`SELECT status FROM news_briefings WHERE briefing_id = ?`, briefingId)[0]![
        "status"
      ]
    ).toBe("error");
    expect(
      worker.rowsForTest(`SELECT job_id FROM recurring_jobs WHERE job_id = 'watchdog:ch-1'`)
    ).toHaveLength(0);
  });

  it("does not re-emit the setup card when only volatile fields change", async () => {
    const worker = await makeWorker();
    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" } as never);
    const setupEmits = () =>
      worker.published.filter(
        (entry) => entry.event.kind === "custom.started" || entry.event.kind === "custom.updated"
      ).length;
    const before = setupEmits();
    // Two polls with no source changes only bump lastRunAt — which is excluded
    // from the dedup signature — so the card must not re-emit.
    await worker.refreshNow("ch-1", {});
    await worker.refreshNow("ch-1", {});
    expect(setupEmits()).toBe(before);
  });

  it("recovers card identities from replay via ensureRecovered", async () => {
    const worker = await makeWorker();
    const folded = new Map<string, Map<string, unknown>>([
      ["news.setup", new Map([["msg-setup", { status: "configured" }]])],
      [
        "news.briefing",
        new Map([["msg-brief", { briefingId: "b-1" } satisfies Partial<NewsBriefingCardState>]]),
      ],
    ]);
    const spy = vi
      .spyOn(
        worker as unknown as { indexOwnCustomMessages: (...args: unknown[]) => unknown },
        "indexOwnCustomMessages"
      )
      .mockResolvedValue(folded as never);

    // requestDeepDive declares needsRecovery; dispatch via onMethodCall runs it.
    await worker.onMethodCall("ch-1", "call-1", "requestDeepDive", { articleId: "missing" });
    expect(spy).toHaveBeenCalledOnce();
    const cards = worker.rowsForTest(
      `SELECT natural_key, message_id FROM custom_cards ORDER BY natural_key`
    );
    expect(cards).toEqual([
      expect.objectContaining({ natural_key: "ch-1:news:briefing:b-1", message_id: "msg-brief" }),
      expect.objectContaining({ natural_key: "ch-1:news:setup", message_id: "msg-setup" }),
    ]);
  });
});

describe("NewsAgentWorker deep-dive fork (postClone integration)", () => {
  it("postClone purges the parent channel and marks the fork an analyst thread", async () => {
    const worker = await makeWorker();
    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" } as never);
    await addExampleFeed(worker, [{ title: "Story A", link: "https://example.com/a" }]);
    // Parent is a configured curator channel with jobs + feeds.
    expect(
      worker.rowsForTest(`SELECT job_id FROM recurring_jobs WHERE channel_id = 'ch-1'`).length
    ).toBeGreaterThan(0);
    expect(
      worker.rowsForTest(`SELECT feed_id FROM news_feeds WHERE channel_id = 'ch-1'`)
    ).toHaveLength(1);

    // Simulate the clone running postClone: parent ch-1 → forked deep-dive channel.
    const publishedBefore = worker.published.length;
    await worker.postClone("parent-key", "fork:ch-1:xyz", "ch-1", 7, "ctx-forked");

    // Parent channel's copied state is purged from the clone.
    expect(
      worker.rowsForTest(`SELECT job_id FROM recurring_jobs WHERE channel_id = 'ch-1'`)
    ).toHaveLength(0);
    expect(
      worker.rowsForTest(`SELECT feed_id FROM news_feeds WHERE channel_id = 'ch-1'`)
    ).toHaveLength(0);
    expect(
      worker.rowsForTest(`SELECT channel_id FROM news_channel_state WHERE channel_id = 'ch-1'`)
    ).toHaveLength(0);

    // The fork is an analyst thread: marked analyst, no curator jobs, no setup card.
    expect(
      worker.rowsForTest(
        `SELECT mode FROM news_channel_state WHERE channel_id = 'fork:ch-1:xyz'`
      )[0]!["mode"]
    ).toBe("analyst");
    expect(
      worker.rowsForTest(`SELECT job_id FROM recurring_jobs WHERE channel_id = 'fork:ch-1:xyz'`)
    ).toHaveLength(0);
    const newSetupCards = worker.published
      .slice(publishedBefore)
      .filter((entry) => entry.event.kind === "custom.started");
    expect(newSetupCards).toHaveLength(0);

    // And the analyst opening turn can be seeded on the fork.
    const turnsBefore = worker.agentInitiatedTurns.length;
    await worker.startDeepDive("fork:ch-1:xyz", { url: "https://example.com/a", title: "Story A" });
    expect(worker.agentInitiatedTurns.length).toBe(turnsBefore + 1);
  });
});

describe("NewsAgentWorker loop tool execution (integration)", () => {
  // The generic model→tool→model→close loop is covered by the agent-loop driver
  // tests. This asserts the news-specific seam: the exact tool object the loop
  // dispatches for a model's news_publish_briefing call runs the real operation
  // and finalizes the briefing (status → ready, stories marked briefed).
  it("the news_publish_briefing loop tool runs the real operation end to end", async () => {
    const worker = await makeWorker();
    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" } as never);
    await addExampleFeed(worker, [{ title: "Story A", link: "https://example.com/a" }]);
    const aid = await articleId("https://example.com/a");
    worker.execSqlForTest(
      `INSERT INTO news_briefings (channel_id, briefing_id, created_at, status, story_ids_json)
       VALUES ('ch-1', 'b-1', ?, 'summarizing', ?)`,
      worker.clock,
      JSON.stringify([aid])
    );

    // Execute the exact loop tool the model would call (tool.execute → op.run →
    // publishBriefing), the same dispatch the agent loop performs.
    const tool = worker.loopTool("news_publish_briefing")!;
    expect(tool).toBeTruthy();
    const result = (await tool.execute("inv-1", {
      briefingId: "b-1",
      tldr: "**Story A** shipped.",
    })) as { content?: Array<{ text?: string }>; details?: { published?: string } };

    expect(
      worker.rowsForTest(`SELECT status, tldr FROM news_briefings WHERE briefing_id = 'b-1'`)[0]
    ).toMatchObject({ status: "ready", tldr: "**Story A** shipped." });
    expect(
      worker.rowsForTest(`SELECT briefed_in FROM news_articles WHERE article_id = ?`, aid)[0]![
        "briefed_in"
      ]
    ).toBe("b-1");
    // The tool hands the model structured details + protocol text.
    expect(result.details?.published).toBe("b-1");
  });
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
