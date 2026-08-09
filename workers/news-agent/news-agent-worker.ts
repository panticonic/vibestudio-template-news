import {
  AgentWorkerBase,
  RecurringScheduler,
  installMessageTypes,
  type ClonedChannelContext,
  type AgentToolExecutionContext,
  type RespondPolicy,
} from "@workspace/agentic-do";
import { rpc } from "@workspace/runtime/worker";
import type { DurableObjectContext } from "@workspace/runtime/worker";
import type { ActorRef } from "@workspace/agentic-protocol";
import type { DoAlarmSchedule } from "@vibestudio/shared/doDispatcher";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import {
  articleId as canonicalArticleId,
  discoverFeedUrl,
  parseFeed,
  parseOpml,
  fetchFeed,
  type Fetcher,
} from "@workspace/feeds";
import {
  NEWS_DEEPDIVE_SIGNAL,
  type NewsBriefingCardState,
  type NewsDeepDiveRequested,
  type NewsSetupCardState,
  type NewsStoryRef,
} from "@workspace/feeds/card-types";

import { createNewsTables } from "./schema.js";
import {
  BRIEFING_WATCHDOG_MS,
  BRIEFING_WATCHDOG_TICK_MS,
  DEFAULT_BRIEFING_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TOP_K,
  INITIAL_BRIEFING_DELAY_MS,
  MAX_FEEDBACK_SIGNALS,
  booleanArg,
  numberArg,
  record,
  stringArg,
  type FeedbackSignal,
  type NewsChannelMode,
  type NewsChannelState,
} from "./types.js";

const NEWS_AGENT_SCHEMA_BASELINE = 8;
import { NewsSyncEngine } from "./sync-engine.js";
import {
  NEWS_MESSAGE_TYPES,
  NEWS_UI_IMPORTS,
  NEWS_UI_INSTALL_VERSION,
  NewsCards,
  SETUP_CARD_KEY,
  briefingCardKey,
} from "./cards.js";
import {
  NEWS_OPERATIONS,
  advertisedMethods,
  buildOperationIndex,
  toolOperations,
  type NewsHandlers,
  type NewsOperation,
  type NewsOperationContext,
} from "./operations.js";
import {
  NEWS_ANALYST_PROMPT,
  NEWS_SYSTEM_PROMPT,
  buildBriefingPrompt,
  buildDeepDivePrompt,
  buildTriagePrompt,
} from "./prompts.js";

type NewsTool = AgentTool;

const DAY_MS = 24 * 3_600_000;
const NEWS_BASE_LOOP_TOOL_NAMES = new Set([
  "suspend_turn",
  "ask_user",
  "web_search",
  "web_fetch",
  "web_read",
]);
const MAX_SEARCH_STORIES_PER_BRIEFING = 10;
/** Cap feeds added in a single OPML import so a huge export can't hammer hosts. */
const MAX_OPML_FEEDS = 30;
/** Columns (with the feed-title join) behind the reader-facing article shape. */
const ARTICLE_COLUMNS = `a.article_id, a.title, a.canonical_url, a.published_at, a.fetched_at,
  a.briefed_in, a.read, a.saved, a.origin, a.blurb, a.summary, a.source, a.title_sim_key,
  a.triaged, a.category, a.cluster_key, f.title AS feed_title`;
/** How many un-triaged articles a single triage turn processes. */
const TRIAGE_BATCH_SIZE = 50;

/** Next run for the briefing job: anchored to local HH:MM when set. */
function nextBriefingRunAt(now: number, intervalMs: number, atMinutes?: number): number {
  if (atMinutes === undefined || intervalMs % DAY_MS !== 0) return now + intervalMs;
  const anchor = new Date(now);
  anchor.setHours(Math.floor(atMinutes / 60), atMinutes % 60, 0, 0);
  let next = anchor.getTime();
  while (next <= now) next += DAY_MS;
  return next;
}

export class NewsAgentWorker extends AgentWorkerBase implements NewsHandlers {
  // Version 8 is the first supported production shape. Earlier experimental
  // layouts have no proven lossless translation and are rejected intact.
  static override schemaVersion = NEWS_AGENT_SCHEMA_BASELINE;

  protected override schemaProductionBaseline() {
    return {
      version: NEWS_AGENT_SCHEMA_BASELINE,
      name: "news-agent-v8",
    } as const;
  }

  private readonly syncEngine: NewsSyncEngine;
  private readonly scheduler: RecurringScheduler;
  private readonly newsCards: NewsCards;
  private readonly operationIndex: Map<string, NewsOperation>;
  private readonly operationContext: NewsOperationContext;
  private recoveredChannels = new Set<string>();

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    void this.setOwnTitle("News");
    this.syncEngine = new NewsSyncEngine({
      sql: this.sql,
      now: () => this.now(),
      fetcher: this.feedFetcher(),
      sleep: (ms) => this.politenessSleep(ms),
    });
    this.scheduler = new RecurringScheduler({ sql: this.sql });
    this.newsCards = new NewsCards(this.cards);
    this.operationIndex = buildOperationIndex();
    this.operationContext = { handlers: this };
  }

  /** Injectable clock for tests. */
  protected now(): number {
    return Date.now();
  }

  /** Injectable feed transport for tests; undefined = global fetch. */
  protected feedFetcher(): Fetcher | undefined {
    return undefined;
  }

  /** Injectable per-host politeness wait for tests. */
  protected politenessSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private combinedAlarmSchedule(agent: DoAlarmSchedule | null): DoAlarmSchedule | null {
    const recurringWakeAt = this.scheduler.nextWakeAt();
    if (recurringWakeAt === undefined) return agent;
    if (agent === null || recurringWakeAt < agent.wakeAt) {
      return { wakeAt: recurringWakeAt };
    }
    return agent;
  }

  protected override nextAlarmAfterRequest(): DoAlarmSchedule | null {
    return this.combinedAlarmSchedule(super.nextAlarmAfterRequest());
  }

  protected override createTables(): void {
    super.createTables();
    createNewsTables(this.sql);
    RecurringScheduler.createTables(this.sql);
  }

  // ── channel state ──────────────────────────────────────────────────────────

  private ensureChannelState(channelId: string): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO news_channel_state (channel_id, poll_interval_ms, briefing_interval_ms)
       VALUES (?, ?, ?)`,
      channelId,
      DEFAULT_POLL_INTERVAL_MS,
      DEFAULT_BRIEFING_INTERVAL_MS
    );
  }

  private getChannelState(channelId: string): NewsChannelState {
    this.ensureChannelState(channelId);
    const row = this.sql
      .exec(`SELECT * FROM news_channel_state WHERE channel_id = ?`, channelId)
      .toArray()[0]!;
    return {
      channelId,
      pollIntervalMs: Number(row["poll_interval_ms"]) || DEFAULT_POLL_INTERVAL_MS,
      briefingIntervalMs: Number(row["briefing_interval_ms"]) || DEFAULT_BRIEFING_INTERVAL_MS,
      briefingAtMinutes:
        row["briefing_at_minutes"] === null ? undefined : Number(row["briefing_at_minutes"]),
      topK: Number(row["top_k"]) || DEFAULT_TOP_K,
      setupStatus: row["setup_status"] === "configured" ? "configured" : "needs-user-preferences",
      preferencesText: (row["preferences_text"] as string | null) ?? undefined,
      lastBriefingId: (row["last_briefing_id"] as string | null) ?? undefined,
      lastRunAt: (row["last_run_at"] as number | null) ?? undefined,
      lastError: (row["last_error"] as string | null) ?? undefined,
      lastSetupJson: (row["last_setup_json"] as string | null) ?? undefined,
      mode: row["mode"] === "analyst" ? "analyst" : "curator",
      feedbackJson: (row["feedback_json"] as string | null) ?? undefined,
      briefingPaused: Number(row["briefing_paused"]) === 1,
    };
  }

  /** Cheap, side-effect-free mode read (used in the per-turn prompt path). */
  private getMode(channelId: string): NewsChannelMode {
    const row = this.sql
      .exec(`SELECT mode FROM news_channel_state WHERE channel_id = ?`, channelId)
      .toArray()[0];
    return row?.["mode"] === "analyst" ? "analyst" : "curator";
  }

  private setChannelMode(channelId: string, mode: NewsChannelMode): void {
    this.sql.exec(
      `INSERT INTO news_channel_state (channel_id, poll_interval_ms, briefing_interval_ms, setup_status, mode)
       VALUES (?, ?, ?, 'configured', ?)
       ON CONFLICT(channel_id) DO UPDATE SET mode = excluded.mode`,
      channelId,
      DEFAULT_POLL_INTERVAL_MS,
      DEFAULT_BRIEFING_INTERVAL_MS,
      mode
    );
  }

  private saveChannelState(state: NewsChannelState): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO news_channel_state
       (channel_id, poll_interval_ms, briefing_interval_ms, briefing_at_minutes, top_k, setup_status, preferences_text, last_briefing_id, last_run_at, last_error, last_setup_json, mode, feedback_json, briefing_paused)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      state.channelId,
      state.pollIntervalMs,
      state.briefingIntervalMs,
      state.briefingAtMinutes ?? null,
      state.topK,
      state.setupStatus,
      state.preferencesText ?? null,
      state.lastBriefingId ?? null,
      state.lastRunAt ?? null,
      state.lastError ?? null,
      state.lastSetupJson ?? null,
      state.mode,
      state.feedbackJson ?? null,
      state.briefingPaused ? 1 : 0
    );
  }

  // ── reader feedback signals (👍 / 👎 / mute) ───────────────────────────────

  private getFeedback(channelId: string): FeedbackSignal[] {
    const raw = this.getChannelState(channelId).feedbackJson;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as FeedbackSignal[]) : [];
    } catch {
      return [];
    }
  }

  private addFeedback(channelId: string, signal: FeedbackSignal): void {
    const state = this.getChannelState(channelId);
    const existing: FeedbackSignal[] = (() => {
      if (!state.feedbackJson) return [];
      try {
        const parsed = JSON.parse(state.feedbackJson);
        return Array.isArray(parsed) ? (parsed as FeedbackSignal[]) : [];
      } catch {
        return [];
      }
    })();
    // Drop a prior identical signal so repeated taps don't crowd out the window.
    const deduped = existing.filter(
      (entry) => !(entry.reaction === signal.reaction && entry.label === signal.label)
    );
    deduped.push(signal);
    const capped = deduped.slice(-MAX_FEEDBACK_SIGNALS);
    state.feedbackJson = JSON.stringify(capped);
    this.saveChannelState(state);
  }

  /** Recent reader feedback as natural-language lines for the briefing prompt. */
  private feedbackLines(channelId: string): string[] {
    return this.getFeedback(channelId)
      .slice(-12)
      .reverse()
      .map((signal) => {
        const where = signal.source ? ` (${signal.source})` : "";
        if (signal.reaction === "more") return `More like: "${signal.label}"${where}`;
        if (signal.reaction === "less") return `Less like: "${signal.label}"${where}`;
        return `Avoid source: ${signal.label}`;
      });
  }

  // ── agent configuration ───────────────────────────────────────────────────

  protected override getRespondPolicy(): RespondPolicy {
    // A news channel is the user's private 1:1 reader — every message they
    // send is for the agent, so always reply. Background polls are silent
    // (no channel messages) and agent-initiated briefings bypass this path,
    // so "all" never produces unsolicited chatter.
    return "all";
  }

  protected override getAgentPrompt(channelId: string): string {
    return this.getMode(channelId) === "analyst" ? NEWS_ANALYST_PROMPT : NEWS_SYSTEM_PROMPT;
  }

  protected override getLoopTools(
    channelId: string,
    execution?: AgentToolExecutionContext
  ): AgentTool[] {
    const baseTools = super
      .getLoopTools(channelId, execution)
      .filter((tool) => NEWS_BASE_LOOP_TOOL_NAMES.has(tool.name));
    const newsTools = toolOperations().map(
      (op) =>
        ({
          name: op.name,
          label: op.name,
          description: op.description,
          parameters: op.schema,
          execute: async (_toolCallId: string, params: unknown) => {
            if (op.needsRecovery) await this.ensureRecovered(channelId);
            const details = await op.run(this.operationContext, channelId, record(params));
            return {
              content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
              details,
            };
          },
        }) as NewsTool
    );
    return [...baseTools, ...newsTools];
  }

  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown
  ): ParticipantDescriptor {
    const cfg = record(config);
    return {
      handle: typeof cfg["handle"] === "string" ? cfg["handle"] : "news",
      name: typeof cfg["name"] === "string" ? cfg["name"] : "News",
      type: "agent",
      metadata: { provider: "news" },
      methods: [...advertisedMethods(), ...this.getStandardAgentMethods()],
    };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  override async subscribeChannel(
    opts: Parameters<AgentWorkerBase["subscribeChannel"]>[0]
  ): Promise<{ ok: boolean; participantId: string }> {
    const result = await super.subscribeChannel(opts);
    this.ensureChannelState(opts.channelId);
    // Register card types on the (new) channel so inherited/own cards render.
    await this.installChannelUi(opts.channelId);
    // Deep-dive analyst forks are focused analysis threads: no feed polling or
    // setup card. startDeepDive seeds their opening turn explicitly.
    if (this.getMode(opts.channelId) === "analyst") return result;
    await this.publishSetupCard(opts.channelId);
    this.seedJobs(opts.channelId);
    return result;
  }

  private seedJobs(channelId: string): void {
    const state = this.getChannelState(channelId);
    const now = this.now();
    this.scheduler.upsertJob({
      jobId: `poll:${channelId}`,
      channelId,
      intervalMs: state.pollIntervalMs,
      jitterMs: Math.min(60_000, Math.floor(state.pollIntervalMs / 10)),
      nextRunAt: now, // first poll immediately
    });
    this.scheduler.upsertJob({
      jobId: `briefing:${channelId}`,
      channelId,
      intervalMs: state.briefingIntervalMs,
      nextRunAt: nextBriefingRunAt(now, state.briefingIntervalMs, state.briefingAtMinutes),
    });
  }

  // ── deep-dive forks ─────────────────────────────────────────────────────────

  /** A clone copies the parent DO's SQLite wholesale. Strip the parent
   *  channel's curator state/jobs (the clone never holds its subscription) and
   *  pre-mark the forked channel as an analyst thread, so the subscribe the
   *  base runs next skips feed polling and the setup card. */
  protected override async onChannelForked(ctx: ClonedChannelContext): Promise<void> {
    this.scheduler.removeChannel(ctx.oldChannelId);
    this.dropChannelData(ctx.oldChannelId);
    this.setChannelMode(ctx.newChannelId, "analyst");
  }

  private dropChannelData(channelId: string): void {
    for (const table of [
      "news_channel_state",
      "news_feeds",
      "news_topics",
      "news_articles",
      "news_briefings",
    ]) {
      this.sql.exec(`DELETE FROM ${table} WHERE channel_id = ?`, channelId);
    }
  }

  /** Seed a forked deep-dive channel's opening analyst turn. The panel calls
   *  this on the freshly-cloned agent after fork(); idempotent via steeringId. */
  async startDeepDive(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; error?: string }> {
    const input = record(args);
    const url = stringArg(input, "url");
    const title = stringArg(input, "title");
    if (!url || !title) return { ok: false, error: "url and title are required" };
    this.setChannelMode(channelId, "analyst");
    this.scheduler.removeChannel(channelId); // analyst threads never poll/brief
    const source = stringArg(input, "source");
    const briefingTldr = stringArg(input, "briefingTldr");
    const articleId = stringArg(input, "articleId");
    await this.submitAgentInitiatedTurn(
      channelId,
      {
        content: buildDeepDivePrompt({
          title,
          url,
          ...(source ? { source } : {}),
          ...(briefingTldr ? { briefingTldr } : {}),
        }),
      },
      { mode: "sequential", steeringId: `news-deepdive:${channelId}:${articleId ?? url}` }
    );
    return { ok: true };
  }

  override async alarm(): Promise<DoAlarmSchedule | null> {
    const agentAlarm = await super.alarm();
    await this.scheduler.onAlarm(this.now(), async (jobId, channelId) => {
      // Defense in depth: a clone copies the parent's jobs wholesale, and
      // other paths can unsubscribe. A job for a channel we no longer hold a
      // participant on can never publish — retire it instead of churning.
      if (!this.subscriptions.getParticipantId(channelId)) {
        this.scheduler.removeChannel(channelId);
        return;
      }
      if (jobId.startsWith("poll:")) await this.runPoll(channelId);
      else if (jobId.startsWith("briefing:")) {
        // "Vacation": keep polling, but skip the scheduled digest while paused.
        if (!this.getChannelState(channelId).briefingPaused) {
          await this.runBriefing(channelId);
        }
      } else if (jobId.startsWith("watchdog:")) this.runWatchdog(channelId);
    });
    return this.combinedAlarmSchedule(agentAlarm);
  }

  /** Active watchdog tick: flip stalled briefings to error, then retire once
   *  none remain in flight (armed by runBriefing, self-cancels here). */
  private runWatchdog(channelId: string): void {
    this.watchdogStuckBriefings(channelId);
    const stillSummarizing = this.sql
      .exec(
        `SELECT 1 FROM news_briefings WHERE channel_id = ? AND status = 'summarizing' LIMIT 1`,
        channelId
      )
      .toArray();
    if (stillSummarizing.length === 0) {
      this.scheduler.removeJob(`watchdog:${channelId}`);
    }
  }

  /** Entry point for workspace-level `recurring:` jobs (vibestudio.yml). */
  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async runScheduledJob(args: unknown): Promise<{ ok: boolean }> {
    const input = record(args);
    const job = stringArg(input, "job") ?? "briefing";
    for (const channelId of this.subscribedChannelIds()) {
      if (!this.subscriptions.getParticipantId(channelId)) continue;
      if (this.getMode(channelId) === "analyst") continue; // deep-dive threads don't brief
      if (job === "poll") await this.runPoll(channelId);
      else if (!this.getChannelState(channelId).briefingPaused) await this.runBriefing(channelId);
    }
    return { ok: true };
  }

  private subscribedChannelIds(): string[] {
    return this.sql
      .exec(`SELECT channel_id FROM news_channel_state`)
      .toArray()
      .map((row) => String(row["channel_id"]));
  }

  // ── Tier 1: poll ──────────────────────────────────────────────────────────

  private async runPoll(channelId: string, opts?: { force?: boolean }): Promise<void> {
    const state = this.getChannelState(channelId);
    try {
      await this.syncEngine.pollChannel(channelId, opts);
      state.lastRunAt = this.now();
      state.lastError = undefined;
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
    }
    this.saveChannelState(state);
    this.watchdogStuckBriefings(channelId);
    await this.publishSetupCard(channelId);
  }

  /** Flip briefings stuck in "summarizing" (e.g. dead harness turn) to error. */
  private watchdogStuckBriefings(channelId: string): void {
    const cutoff = this.now() - BRIEFING_WATCHDOG_MS;
    const stuck = this.sql
      .exec(
        `SELECT briefing_id FROM news_briefings
         WHERE channel_id = ? AND status = 'summarizing' AND created_at < ?`,
        channelId,
        cutoff
      )
      .toArray();
    for (const row of stuck) {
      const briefingId = String(row["briefing_id"]);
      this.sql.exec(
        `UPDATE news_briefings SET status = 'error' WHERE channel_id = ? AND briefing_id = ?`,
        channelId,
        briefingId
      );
      void this.updateBriefingCard(channelId, briefingId, {
        status: "error",
        lastError: "briefing run did not complete",
      });
    }
  }

  // ── Tier 2: briefing ──────────────────────────────────────────────────────

  private async runBriefing(channelId: string, opts?: { notify?: boolean }): Promise<void> {
    // Fresh articles first; a stale snapshot makes a stale briefing.
    await this.runPoll(channelId);
    // Briefing time also triages the backlog so the reader feed stays curated.
    await this.runTriage(channelId);
    const state = this.getChannelState(channelId);
    const stories = this.syncEngine.rankUnbriefed(channelId, state.topK);
    const scanned = this.syncEngine.countUnbriefed(channelId);
    const topics = this.listTopics(channelId)
      .filter((topic) => topic.enabled)
      .map((topic) => topic.topic);
    if (stories.length === 0 && topics.length === 0) return; // nothing to brief

    const now = this.now();
    const briefingId = `${new Date(now).toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    const card: NewsBriefingCardState = {
      briefingId,
      createdAt: new Date(now).toISOString(),
      status: "summarizing",
      stories,
      articleCountScanned: scanned,
      newSinceLastRun: scanned,
    };
    await this.newsCards.createBriefing(channelId, card);
    // notify defaults on (scheduled/cold-start runs); a manual "Brief me now"
    // passes notify:false so it stays silent for a reader already watching.
    const notify = opts?.notify === false ? 0 : 1;
    this.sql.exec(
      `INSERT OR REPLACE INTO news_briefings (channel_id, briefing_id, created_at, status, story_ids_json, notify)
       VALUES (?, ?, ?, 'summarizing', ?, ?)`,
      channelId,
      briefingId,
      now,
      JSON.stringify(stories.map((story) => story.articleId)),
      notify
    );
    // Arm the self-canceling watchdog so a dead turn surfaces as an error in
    // minutes rather than waiting for the next scheduled poll.
    this.scheduler.upsertJob({
      jobId: `watchdog:${channelId}`,
      channelId,
      intervalMs: BRIEFING_WATCHDOG_TICK_MS,
      nextRunAt: now + BRIEFING_WATCHDOG_TICK_MS,
    });

    const previousTldr = this.previousTldr(channelId, briefingId);
    try {
      await this.submitAgentInitiatedTurn(
        channelId,
        {
          content: buildBriefingPrompt({
            briefingId,
            dateLabel: new Date(now).toDateString(),
            stories,
            followedTopics: topics,
            previousTldr,
            preferencesText: state.preferencesText,
            feedbackLines: this.feedbackLines(channelId),
            articleCountScanned: scanned,
          }),
        },
        { mode: "sequential", steeringId: `news-briefing:${channelId}:${briefingId}` }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sql.exec(
        `UPDATE news_briefings SET status = 'error' WHERE channel_id = ? AND briefing_id = ?`,
        channelId,
        briefingId
      );
      state.lastError = `Briefing could not start: ${message}`;
      this.saveChannelState(state);
      await this.updateBriefingCard(channelId, briefingId, {
        status: "error",
        lastError: state.lastError,
      });
      throw err;
    }
  }

  // ── Tier 1.5: triage ────────────────────────────────────────────────────────

  private countUntriaged(channelId: string): number {
    const row = this.sql
      .exec(
        `SELECT COUNT(*) AS n FROM news_articles
         WHERE channel_id = ? AND triaged = 0 AND read = 0
           AND (briefed_in IS NULL OR briefed_in NOT LIKE 'dropped:%')`,
        channelId
      )
      .toArray()[0];
    return Number(row?.["n"] ?? 0);
  }

  private listCategories(channelId: string): string[] {
    return this.sql
      .exec(
        `SELECT DISTINCT category FROM news_articles
         WHERE channel_id = ? AND category IS NOT NULL AND category != '' LIMIT 24`,
        channelId
      )
      .toArray()
      .map((row) => String(row["category"]));
  }

  /** Submit a triage turn over the un-triaged backlog. Returns false when there
   *  is nothing to triage. The agent answers via the news_triage tool. */
  private async runTriage(channelId: string): Promise<boolean> {
    const rows = this.sql
      .exec(
        `SELECT a.article_id, a.title, a.canonical_url, a.published_at, a.origin, a.blurb, a.summary,
                a.source, f.title AS feed_title
         FROM news_articles a
         LEFT JOIN news_feeds f ON f.channel_id = a.channel_id AND f.feed_id = a.feed_id
         WHERE a.channel_id = ? AND a.triaged = 0 AND a.read = 0
           AND (a.briefed_in IS NULL OR a.briefed_in NOT LIKE 'dropped:%')
         ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.article_id DESC
         LIMIT ?`,
        channelId,
        TRIAGE_BATCH_SIZE
      )
      .toArray();
    if (rows.length === 0) return false;
    const stories = rows.map((row) => ({
      articleId: String(row["article_id"]),
      title: String(row["title"]),
      url: String(row["canonical_url"]),
      origin: String(row["origin"]) === "search" ? "search" : "feed",
      source:
        (row["feed_title"] as string | null) ??
        (row["source"] as string | null) ??
        (String(row["origin"]) === "search" ? "web" : "feed"),
      publishedAt:
        row["published_at"] === null
          ? undefined
          : new Date(Number(row["published_at"])).toISOString(),
      blurb:
        (row["blurb"] as string | null) ?? plainTextSnippet(row["summary"] as string | null, 200),
    }));
    const topics = this.listTopics(channelId)
      .filter((topic) => topic.enabled)
      .map((topic) => topic.topic);
    await this.submitAgentInitiatedTurn(
      channelId,
      {
        content: buildTriagePrompt({
          stories,
          followedTopics: topics,
          existingCategories: this.listCategories(channelId),
        }),
      },
      { mode: "sequential", steeringId: `news-triage:${channelId}:${this.now()}` }
    );
    return true;
  }

  private previousTldr(channelId: string, excludeBriefingId: string): string | undefined {
    const row = this.sql
      .exec(
        `SELECT tldr FROM news_briefings
         WHERE channel_id = ? AND briefing_id != ? AND status = 'ready' AND tldr IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        channelId,
        excludeBriefingId
      )
      .toArray()[0];
    return (row?.["tldr"] as string | null) ?? undefined;
  }

  private briefingState(channelId: string, briefingId: string): NewsBriefingCardState | undefined {
    const row = this.sql
      .exec(
        `SELECT * FROM news_briefings WHERE channel_id = ? AND briefing_id = ?`,
        channelId,
        briefingId
      )
      .toArray()[0];
    if (!row) return undefined;
    const storyIds = JSON.parse(String(row["story_ids_json"] ?? "[]")) as string[];
    return {
      briefingId,
      createdAt: new Date(Number(row["created_at"])).toISOString(),
      status: String(row["status"]) as NewsBriefingCardState["status"],
      tldr: (row["tldr"] as string | null) ?? undefined,
      stories: this.storiesByIds(channelId, storyIds),
      articleCountScanned: storyIds.length,
      newSinceLastRun: 0,
      sourcesRead: row["sources_read"] === null ? undefined : Number(row["sources_read"]),
    };
  }

  private storiesByIds(channelId: string, articleIds: string[]): NewsStoryRef[] {
    const stories: NewsStoryRef[] = [];
    for (const id of articleIds) {
      const row = this.sql
        .exec(
          `SELECT a.*, f.title AS feed_title FROM news_articles a
           LEFT JOIN news_feeds f ON f.channel_id = a.channel_id AND f.feed_id = a.feed_id
           WHERE a.channel_id = ? AND a.article_id = ?`,
          channelId,
          id
        )
        .toArray()[0];
      if (!row) continue;
      stories.push({
        articleId: id,
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
        score: 0,
        blurb: (
          (row["blurb"] as string | null) ??
          (row["summary"] as string | null) ??
          undefined
        )?.slice(0, 280),
        read: Number(row["read"]) === 1,
      });
    }
    return stories;
  }

  private async updateBriefingCard(
    channelId: string,
    briefingId: string,
    patch: Partial<NewsBriefingCardState>
  ): Promise<void> {
    const current = this.briefingState(channelId, briefingId);
    if (!current) return;
    await this.newsCards.updateBriefing(channelId, briefingId, { ...current, ...patch });
  }

  // ── setup card ────────────────────────────────────────────────────────────

  private buildSetupCardState(channelId: string): NewsSetupCardState {
    const state = this.getChannelState(channelId);
    const feeds = this.sql
      .exec(`SELECT * FROM news_feeds WHERE channel_id = ? ORDER BY url`, channelId)
      .toArray()
      .map((row) => ({
        feedId: String(row["feed_id"]),
        url: String(row["url"]),
        title: (row["title"] as string | null) ?? undefined,
        weight: Number(row["weight"]) || 1,
        enabled: Number(row["enabled"]) === 1,
        lastFetchAt:
          row["last_fetch_at"] === null
            ? undefined
            : new Date(Number(row["last_fetch_at"])).toISOString(),
        lastStatus: (row["last_status"] as string | null) ?? undefined,
        failCount: Number(row["fail_count"]) || 0,
      }));
    const followedTopics = this.listTopics(channelId);
    const briefingLabel = state.briefingPaused
      ? "paused"
      : state.briefingAtMinutes !== undefined
        ? `daily at ${String(Math.floor(state.briefingAtMinutes / 60)).padStart(2, "0")}:${String(state.briefingAtMinutes % 60).padStart(2, "0")}`
        : `every ${Math.round(state.briefingIntervalMs / 3_600_000)}h`;
    return {
      status: state.setupStatus,
      feeds,
      followedTopics,
      scheduleSummary: `polls every ${Math.round(state.pollIntervalMs / 60_000)}m, briefing ${briefingLabel}`,
      pollIntervalMs: state.pollIntervalMs,
      briefingIntervalMs: state.briefingIntervalMs,
      briefingAtMinutes: state.briefingAtMinutes,
      briefingPaused: state.briefingPaused,
      preferencesText: state.preferencesText,
      lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : undefined,
      lastError: state.lastError,
    };
  }

  private async publishSetupCard(channelId: string): Promise<void> {
    const payload = this.buildSetupCardState(channelId);
    const state = this.getChannelState(channelId);
    // Dedup on the meaningful fields only. `lastRunAt` ticks on every poll but
    // isn't rendered, so including it would defeat the dedup and re-emit the
    // card constantly.
    const { lastRunAt: _lastRunAt, ...stable } = payload;
    const signature = JSON.stringify(stable);
    if (state.lastSetupJson === signature) return;
    await this.newsCards.publishSetup(channelId, payload);
    state.lastSetupJson = signature;
    this.saveChannelState(state);
  }

  private listTopics(
    channelId: string
  ): Array<{ topic: string; weight: number; enabled: boolean }> {
    return this.sql
      .exec(
        `SELECT topic, weight, enabled FROM news_topics WHERE channel_id = ? ORDER BY topic`,
        channelId
      )
      .toArray()
      .map((row) => ({
        topic: String(row["topic"]),
        weight: Number(row["weight"]) || 1,
        enabled: Number(row["enabled"]) === 1,
      }));
  }

  // ── channel UI installation ───────────────────────────────────────────────

  private localActor(channelId: string): ActorRef & { participantId?: string } {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) throw new Error(`News agent is not subscribed to channel ${channelId}`);
    return {
      kind: "agent",
      id: participantId,
      participantId,
      displayName: "News",
      metadata: { type: "agent", handle: "news", name: "News" },
    };
  }

  private async installChannelUi(channelId: string): Promise<void> {
    await installMessageTypes({
      channel: this.createChannelClient(channelId),
      actor: this.localActor(channelId),
      specs: NEWS_MESSAGE_TYPES,
      imports: NEWS_UI_IMPORTS,
      version: NEWS_UI_INSTALL_VERSION,
      keyPrefix: "news",
      cards: this.cards,
      channelId,
      readFile: async (path) => {
        try {
          const raw = await this.fs.readFile(path, "utf8");
          return typeof raw === "string"
            ? raw
            : raw instanceof Uint8Array
              ? new TextDecoder().decode(raw)
              : null;
        } catch {
          return null;
        }
      },
    });
  }

  private async ensureRecovered(channelId: string): Promise<void> {
    if (this.recoveredChannels.has(channelId)) return;
    this.recoveredChannels.add(channelId);
    const folded = await this.indexOwnCustomMessages(channelId, () => undefined);
    const setup = folded.get("news.setup");
    if (setup && setup.size > 0) {
      const messageId = [...setup.keys()][0]!;
      this.newsCards.adoptRecoveredCard(channelId, SETUP_CARD_KEY, "news.setup", messageId);
    }
    for (const [messageId, value] of folded.get("news.briefing") ?? []) {
      const briefingId = stringArg(record(value), "briefingId");
      if (!briefingId) continue;
      this.newsCards.adoptRecoveredCard(
        channelId,
        briefingCardKey(briefingId),
        "news.briefing",
        messageId
      );
    }
  }

  // ── method dispatch ───────────────────────────────────────────────────────

  override async onMethodCall(
    channelId: string,
    _transportCallId: string,
    methodName: string,
    args: unknown
  ): Promise<{ result: unknown; isError?: boolean }> {
    try {
      const standardResult = await this.handleStandardAgentMethodCall(channelId, methodName, args);
      if (standardResult) return standardResult;

      const op = this.operationIndex.get(methodName);
      if (!op || !op.exposure.includes("method")) {
        return { result: { error: `unknown method: ${methodName}` }, isError: true };
      }
      if (op.needsRecovery) await this.ensureRecovered(channelId);
      const result = await op.run(this.operationContext, channelId, record(args));
      const isError = Boolean(
        result && typeof result === "object" && "error" in (result as Record<string, unknown>)
      );
      return isError ? { result, isError: true } : { result };
    } catch (err) {
      return { result: { error: err instanceof Error ? err.message : String(err) }, isError: true };
    }
  }

  // ── NewsHandlers implementation ───────────────────────────────────────────

  async addFeed(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const url = stringArg(args, "url");
    if (!url) return { error: "url is required" };
    const fetched = await fetchFeed(url, { fetcher: this.feedFetcher() });
    if (fetched.status !== "ok") {
      return {
        error: `feed not reachable: ${fetched.status === "error" ? fetched.error : fetched.status}`,
      };
    }
    // Accept either a feed URL or a normal site URL: if the body isn't a feed,
    // try autodiscovery (<link rel="alternate" type="application/rss+xml">) and
    // re-fetch the advertised feed.
    let feedUrl = url;
    let parsed;
    try {
      parsed = parseFeed(fetched.body, undefined, feedUrl);
    } catch (parseErr) {
      const discovered = discoverFeedUrl(fetched.body, url);
      if (!discovered) {
        return {
          error: `not a feed, and no RSS/Atom link found on the page: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        };
      }
      const refetched = await fetchFeed(discovered, { fetcher: this.feedFetcher() });
      if (refetched.status !== "ok") {
        return {
          error: `discovered feed not reachable: ${refetched.status === "error" ? refetched.error : refetched.status}`,
        };
      }
      try {
        parsed = parseFeed(refetched.body, undefined, discovered);
        feedUrl = discovered;
      } catch (err) {
        return {
          error: `discovered feed not parseable: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    const feedId = (await canonicalArticleId(feedUrl)).slice(0, 16);
    this.sql.exec(
      `INSERT INTO news_feeds (channel_id, feed_id, url, title, weight)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, feed_id) DO UPDATE SET
         url = excluded.url, title = excluded.title, weight = excluded.weight, enabled = 1`,
      channelId,
      feedId,
      feedUrl,
      parsed.title ?? null,
      numberArg(args, "weight") ?? 1.0
    );
    // Ingest right away so the feed visibly works.
    let added = 0;
    for (const item of parsed.items.slice(0, 50)) {
      if (await this.syncEngine.insertArticle(channelId, { ...item, feedId, origin: "feed" })) {
        added += 1;
      }
    }
    await this.markConfigured(channelId);
    await this.publishSetupCard(channelId);
    return {
      feedId,
      title: parsed.title,
      url: feedUrl,
      ...(feedUrl !== url ? { discoveredFrom: url } : {}),
      itemCount: parsed.items.length,
      newArticles: added,
    };
  }

  async importOpml(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const opml = stringArg(args, "opml");
    if (!opml) return { error: "opml is required" };
    const feeds = parseOpml(opml);
    if (feeds.length === 0) return { error: "no feed subscriptions found in the OPML" };
    const slice = feeds.slice(0, MAX_OPML_FEEDS);
    let imported = 0;
    const failed: string[] = [];
    for (const feed of slice) {
      const result = (await this.addFeed(channelId, { url: feed.url })) as Record<string, unknown>;
      if (result["error"]) failed.push(feed.url);
      else imported += 1;
    }
    return {
      imported,
      failed: failed.length,
      total: feeds.length,
      ...(feeds.length > slice.length ? { skipped: feeds.length - slice.length } : {}),
    };
  }

  async removeFeed(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const feedId =
      stringArg(args, "feedId") ??
      (stringArg(args, "url")
        ? (await canonicalArticleId(stringArg(args, "url")!)).slice(0, 16)
        : undefined);
    if (!feedId) return { error: "feedId or url is required" };
    this.sql.exec(`DELETE FROM news_feeds WHERE channel_id = ? AND feed_id = ?`, channelId, feedId);
    await this.publishSetupCard(channelId);
    return { removed: feedId };
  }

  async setFeedEnabled(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const feedId = stringArg(args, "feedId");
    const enabled = booleanArg(args, "enabled");
    if (!feedId || enabled === undefined) return { error: "feedId and enabled are required" };
    this.sql.exec(
      `UPDATE news_feeds SET enabled = ? WHERE channel_id = ? AND feed_id = ?`,
      enabled ? 1 : 0,
      channelId,
      feedId
    );
    await this.publishSetupCard(channelId);
    return { feedId, enabled };
  }

  async followTopic(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const topic = stringArg(args, "topic");
    if (!topic) return { error: "topic is required" };
    this.sql.exec(
      `INSERT INTO news_topics (channel_id, topic, weight, enabled) VALUES (?, ?, ?, 1)
       ON CONFLICT(channel_id, topic) DO UPDATE SET weight = excluded.weight, enabled = 1`,
      channelId,
      topic,
      numberArg(args, "weight") ?? 1.0
    );
    await this.markConfigured(channelId);
    await this.publishSetupCard(channelId);
    return { following: topic };
  }

  async unfollowTopic(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const topic = stringArg(args, "topic");
    if (!topic) return { error: "topic is required" };
    this.sql.exec(`DELETE FROM news_topics WHERE channel_id = ? AND topic = ?`, channelId, topic);
    await this.publishSetupCard(channelId);
    return { unfollowed: topic };
  }

  async setPreferences(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const text = stringArg(args, "text") ?? "";
    const state = this.getChannelState(channelId);
    state.preferencesText = text || undefined;
    this.saveChannelState(state);
    await this.markConfigured(channelId);
    await this.publishSetupCard(channelId);
    return { saved: true, preferencesText: state.preferencesText };
  }

  private async markConfigured(channelId: string): Promise<void> {
    const state = this.getChannelState(channelId);
    if (state.setupStatus === "configured") return;
    state.setupStatus = "configured";
    this.saveChannelState(state);
    // Cold-start delight: the very first time sources are configured, pull the
    // first briefing forward to minutes-from-now instead of a full interval out,
    // so a new reader sees a real digest almost immediately. The job keeps its
    // normal interval, so subsequent runs resume the regular cadence.
    this.scheduler.upsertJob({
      jobId: `briefing:${channelId}`,
      channelId,
      intervalMs: state.briefingIntervalMs,
      nextRunAt: this.now() + INITIAL_BRIEFING_DELAY_MS,
    });
  }

  /** Map a SELECT row (using ARTICLE_COLUMNS) to the reader-facing shape. */
  private mapArticleRow(row: Record<string, unknown>): Record<string, unknown> {
    return {
      articleId: String(row["article_id"]),
      title: String(row["title"]),
      url: String(row["canonical_url"]),
      source:
        (row["feed_title"] as string | null) ??
        (row["source"] as string | null) ??
        (String(row["origin"]) === "search" ? "web" : "feed"),
      // The agent's blurb is a real summary; fall back to a cleaned snippet of
      // the feed item's own description so every row carries some substance.
      blurb:
        (row["blurb"] as string | null) ?? plainTextSnippet(row["summary"] as string | null, 400),
      publishedAt:
        row["published_at"] === null
          ? undefined
          : new Date(Number(row["published_at"])).toISOString(),
      // Epoch ms when WE first ingested it — lets the reader flag "new since
      // your last visit" independent of the story's own publish date.
      fetchedAt: Number(row["fetched_at"]),
      // Agent triage outputs: category (section) + cluster key (same-event group).
      category: (row["category"] as string | null) ?? undefined,
      clusterKey: (row["cluster_key"] as string | null) ?? undefined,
      briefedIn: (row["briefed_in"] as string | null) ?? undefined,
      read: Number(row["read"]) === 1,
      saved: Number(row["saved"]) === 1,
    };
  }

  async listArticles(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const limit = Math.min(numberArg(args, "limit") ?? 30, 200);
    const unbriefedOnly = booleanArg(args, "unbriefedOnly") ?? false;
    const savedOnly = booleanArg(args, "savedOnly") ?? false;
    // The reader passes triagedOnly so nothing un-curated surfaces; the agent's
    // own listing (no flag) still sees everything.
    const triagedOnly = booleanArg(args, "triagedOnly") ?? false;
    // The reader uses untriagedOnly to peek at the not-yet-categorized backlog
    // (so an impatient user can click straight through while triage runs).
    const untriagedOnly = booleanArg(args, "untriagedOnly") ?? false;
    const sinceMs = numberArg(args, "sinceMs");
    const cursor = stringArg(args, "cursor");
    const clauses = ["a.channel_id = ?"];
    const params: unknown[] = [channelId];
    if (savedOnly) {
      clauses.push("a.saved = 1"); // saved is an explicit keep — show it regardless
    } else if (untriagedOnly) {
      clauses.push("a.triaged = 0");
      clauses.push("a.read = 0");
      clauses.push("(a.briefed_in IS NULL OR a.briefed_in NOT LIKE 'dropped:%')");
    } else if (unbriefedOnly) {
      clauses.push("a.briefed_in IS NULL");
    } else {
      // Dropped candidates were explicitly cut from a briefing — never surface
      // them in the reader (they are the opposite of "interesting").
      clauses.push("(a.briefed_in IS NULL OR a.briefed_in NOT LIKE 'dropped:%')");
      if (triagedOnly) clauses.push("a.triaged = 1");
    }
    if (sinceMs !== undefined) {
      clauses.push("a.fetched_at >= ?");
      params.push(sinceMs);
    }
    if (cursor) {
      const match = /^(\d+):([a-f0-9]+)$/.exec(cursor);
      if (!match) return { error: "invalid article cursor" };
      const cursorTime = Number(match[1]);
      const cursorId = match[2];
      clauses.push(
        "(COALESCE(a.published_at, a.fetched_at) < ? OR (COALESCE(a.published_at, a.fetched_at) = ? AND a.article_id < ?))"
      );
      params.push(cursorTime, cursorTime, cursorId);
    }
    const rows = this.sql
      .exec(
        `SELECT ${ARTICLE_COLUMNS}
         FROM news_articles a
         LEFT JOIN news_feeds f ON f.channel_id = a.channel_id AND f.feed_id = a.feed_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.article_id DESC
         LIMIT ?`,
        ...params,
        limit + 1
      )
      .toArray();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      hasMore && last
        ? `${Number(last["published_at"] ?? last["fetched_at"])}:${String(last["article_id"])}`
        : undefined;
    return {
      count: page.length,
      articles: page.map((row) => this.mapArticleRow(row)),
      hasMore,
      nextCursor,
    };
  }

  /** Full-text-ish archive search over ingested articles and past briefing
   *  TLDRs (SQLite LIKE; wildcards in the query are escaped). */
  async searchArchive(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const query = stringArg(args, "query");
    if (!query) return { query: "", articles: [], briefings: [] };
    const limit = Math.min(numberArg(args, "limit") ?? 40, 100);
    const like = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const articleRows = this.sql
      .exec(
        `SELECT ${ARTICLE_COLUMNS}
         FROM news_articles a
         LEFT JOIN news_feeds f ON f.channel_id = a.channel_id AND f.feed_id = a.feed_id
         WHERE a.channel_id = ?
           AND (a.briefed_in IS NULL OR a.briefed_in NOT LIKE 'dropped:%')
           AND (a.title LIKE ? ESCAPE '\\' OR a.blurb LIKE ? ESCAPE '\\'
                OR a.summary LIKE ? ESCAPE '\\' OR a.source LIKE ? ESCAPE '\\')
         ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
         LIMIT ?`,
        channelId,
        like,
        like,
        like,
        like,
        limit
      )
      .toArray();
    const briefingRows = this.sql
      .exec(
        `SELECT briefing_id, created_at, tldr, sources_read FROM news_briefings
         WHERE channel_id = ? AND status = 'ready' AND tldr LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC LIMIT ?`,
        channelId,
        like,
        Math.min(limit, 20)
      )
      .toArray();
    return {
      query,
      articles: articleRows.map((row) => this.mapArticleRow(row)),
      briefings: briefingRows.map((row) => ({
        briefingId: String(row["briefing_id"]),
        createdAt: new Date(Number(row["created_at"])).toISOString(),
        tldr: (row["tldr"] as string | null) ?? undefined,
        sourcesRead: row["sources_read"] === null ? undefined : Number(row["sources_read"]),
      })),
    };
  }

  async setSaved(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const idOrPrefix = stringArg(args, "articleId");
    const saved = booleanArg(args, "saved");
    if (!idOrPrefix || saved === undefined) {
      return { error: "articleId and saved are required" };
    }
    this.sql.exec(
      `UPDATE news_articles SET saved = ? WHERE channel_id = ? AND (article_id = ? OR article_id LIKE ? || '%')`,
      saved ? 1 : 0,
      channelId,
      idOrPrefix,
      idOrPrefix
    );
    return { articleId: idOrPrefix, saved };
  }

  async setBriefingPaused(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const paused = booleanArg(args, "paused");
    if (paused === undefined) return { error: "paused is required" };
    const state = this.getChannelState(channelId);
    state.briefingPaused = paused;
    this.saveChannelState(state);
    await this.publishSetupCard(channelId);
    return { briefingPaused: paused };
  }

  /** Tool handler: record the agent's triage of a batch of stories. */
  async triageStories(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const items = Array.isArray(args["items"]) ? args["items"] : [];
    let triaged = 0;
    let dropped = 0;
    for (const entry of items) {
      const item = record(entry);
      const idOrPrefix = stringArg(item, "articleId");
      if (!idOrPrefix) continue;
      const row = this.sql
        .exec(
          `SELECT article_id FROM news_articles
           WHERE channel_id = ? AND (article_id = ? OR article_id LIKE ? || '%') LIMIT 1`,
          channelId,
          idOrPrefix,
          idOrPrefix
        )
        .toArray()[0];
      if (!row) continue;
      const articleId = String(row["article_id"]);
      if (booleanArg(item, "keep") === false) {
        // Drop noise: mark triaged + hidden so it never surfaces and isn't re-triaged.
        this.sql.exec(
          `UPDATE news_articles SET triaged = 1, read = 1,
             briefed_in = COALESCE(briefed_in, 'dropped:triage')
           WHERE channel_id = ? AND article_id = ?`,
          channelId,
          articleId
        );
        dropped += 1;
        continue;
      }
      this.sql.exec(
        `UPDATE news_articles SET triaged = 1, category = ?, cluster_key = ?, blurb = COALESCE(?, blurb)
         WHERE channel_id = ? AND article_id = ?`,
        stringArg(item, "category") ?? null,
        stringArg(item, "clusterKey") ?? null,
        stringArg(item, "blurb") ?? null,
        channelId,
        articleId
      );
      triaged += 1;
    }
    const remaining = this.countUntriaged(channelId);
    let continued = false;
    if (remaining > 0) {
      try {
        continued = await this.runTriage(channelId);
      } catch (err) {
        const state = this.getChannelState(channelId);
        state.lastError = `Categorization paused: ${err instanceof Error ? err.message : String(err)}`;
        this.saveChannelState(state);
        await this.publishSetupCard(channelId);
      }
    }
    return { triaged, dropped, remaining, continued };
  }

  /** On-demand triage entry point (the reader calls this when it opens with a
   *  backlog). Fires a triage turn if anything is un-triaged. */
  async triageNow(channelId: string, _args: Record<string, unknown>): Promise<unknown> {
    const pending = this.countUntriaged(channelId);
    if (pending === 0) return { started: false, pending: 0 };
    const started = await this.runTriage(channelId);
    return { started, pending };
  }

  async publishBriefing(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const briefingId = stringArg(args, "briefingId");
    const tldr = stringArg(args, "tldr");
    if (!briefingId || !tldr) return { error: "briefingId and tldr are required" };
    const sourcesRead = numberArg(args, "sourcesRead");
    const briefing = this.briefingState(channelId, briefingId);
    if (!briefing) return { error: `unknown briefing: ${briefingId}` };

    const blurbs = new Map<string, string>();
    for (const entry of Array.isArray(args["storyBlurbs"]) ? args["storyBlurbs"] : []) {
      const item = record(entry);
      const id = stringArg(item, "articleId");
      if (id) blurbs.set(id, stringArg(item, "blurb") ?? "");
    }
    const dropped = new Set(
      (Array.isArray(args["droppedArticleIds"]) ? args["droppedArticleIds"] : []).map(String)
    );
    /** Short [id] prefixes from the prompt resolve to full article ids. */
    const resolveId = (idOrPrefix: string, candidates: NewsStoryRef[]): string | undefined =>
      candidates.find(
        (story) => story.articleId === idOrPrefix || story.articleId.startsWith(idOrPrefix)
      )?.articleId;

    const kept: NewsStoryRef[] = [];
    const keptIds = new Set<string>();
    for (const story of briefing.stories) {
      const droppedHit = [...dropped].some(
        (id) => story.articleId === id || story.articleId.startsWith(id)
      );
      if (droppedHit) continue;
      const blurbKey = [...blurbs.keys()].find(
        (id) => story.articleId === id || story.articleId.startsWith(id)
      );
      kept.push({ ...story, blurb: blurbKey ? blurbs.get(blurbKey) || story.blurb : story.blurb });
      keptIds.add(story.articleId);
    }

    // Search-found stories become first-class articles (deduped by URL). The
    // agent is instructed to cite concrete articles; reject the obvious
    // search/listing offenders here as defense in depth.
    let searchStoryCount = 0;
    for (const entry of Array.isArray(args["searchStories"]) ? args["searchStories"] : []) {
      if (searchStoryCount >= MAX_SEARCH_STORIES_PER_BRIEFING) break;
      const item = record(entry);
      const url = stringArg(item, "url");
      const title = stringArg(item, "title");
      if (!url || !title) continue;
      if (!isHttpUrl(url)) continue;
      if (isLikelySearchOrIndexUrl(url)) continue;
      let id: string;
      try {
        id = await canonicalArticleId(url);
      } catch {
        continue;
      }
      if (keptIds.has(id)) continue;
      const source = stringArg(item, "source");
      const blurb = stringArg(item, "blurb");
      await this.syncEngine.insertArticle(channelId, {
        url,
        title,
        origin: "search",
        ...(source ? { source } : {}),
        ...(blurb ? { blurb } : {}),
      });
      keptIds.add(id);
      searchStoryCount += 1;
      kept.push({
        articleId: id,
        url,
        title,
        source: source ?? "web search",
        origin: "search",
        score: 0,
        ...(blurb ? { blurb } : {}),
      });
    }

    const now = this.now();
    this.sql.exec(
      `UPDATE news_briefings SET status = 'ready', tldr = ?, story_ids_json = ?, sources_read = ? WHERE channel_id = ? AND briefing_id = ?`,
      tldr,
      JSON.stringify(kept.map((story) => story.articleId)),
      sourcesRead ?? null,
      channelId,
      briefingId
    );
    for (const story of kept) {
      this.sql.exec(
        `UPDATE news_articles SET briefed_in = ?, blurb = COALESCE(?, blurb), triaged = 1 WHERE channel_id = ? AND article_id = ?`,
        briefingId,
        story.blurb ?? null,
        channelId,
        story.articleId
      );
    }
    for (const id of dropped) {
      this.sql.exec(
        `UPDATE news_articles SET briefed_in = ? WHERE channel_id = ? AND (article_id = ? OR article_id LIKE ? || '%')`,
        `dropped:${briefingId}`,
        channelId,
        id,
        id
      );
    }
    const state = this.getChannelState(channelId);
    state.lastBriefingId = briefingId;
    this.saveChannelState(state);

    await this.newsCards.updateBriefing(channelId, briefingId, {
      briefingId,
      createdAt: briefing.createdAt,
      status: "ready",
      tldr,
      stories: kept,
      articleCountScanned: briefing.articleCountScanned,
      newSinceLastRun: briefing.newSinceLastRun,
      ...(sourcesRead !== undefined ? { sourcesRead } : {}),
    });
    // Only scheduled/cold-start briefings notify; a manual "Brief me now" is silent.
    const notifyRow = this.sql
      .exec(
        `SELECT notify FROM news_briefings WHERE channel_id = ? AND briefing_id = ?`,
        channelId,
        briefingId
      )
      .toArray()[0];
    if (Number(notifyRow?.["notify"] ?? 1) !== 0) {
      this.notifyBriefingReady(kept, sourcesRead);
    }
    return { published: briefingId, storyCount: kept.length, at: new Date(now).toISOString() };
  }

  /** Proactive "your briefing is ready" shell notification. Best-effort — a
   *  notification failure must never fail the briefing. */
  private notifyBriefingReady(stories: NewsStoryRef[], sourcesRead?: number): void {
    if (stories.length === 0) return;
    const headlines = stories.slice(0, 3).map((story) => story.title);
    const more =
      stories.length > headlines.length ? ` +${stories.length - headlines.length} more` : "";
    const readNote =
      sourcesRead && sourcesRead > 0
        ? ` · ${sourcesRead} source${sourcesRead > 1 ? "s" : ""} read`
        : "";
    this.notifications
      .show({
        type: "info",
        title: `📰 Your briefing is ready — ${stories.length} stor${stories.length > 1 ? "ies" : "y"}${readNote}`,
        message: `${headlines.join(" · ")}${more}`,
        ttl: 12_000,
      })
      .catch((err) => console.warn("[NewsAgent] briefing notification failed:", err));
  }

  async briefingHistory(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const limit = Math.min(numberArg(args, "limit") ?? 5, 50);
    const rows = this.sql
      .exec(
        `SELECT briefing_id, created_at, status, tldr, sources_read FROM news_briefings
         WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`,
        channelId,
        limit
      )
      .toArray();
    const channelError = this.getChannelState(channelId).lastError;
    return {
      briefings: rows.map((row) => ({
        briefingId: String(row["briefing_id"]),
        createdAt: new Date(Number(row["created_at"])).toISOString(),
        status: String(row["status"]),
        tldr: (row["tldr"] as string | null) ?? undefined,
        sourcesRead: row["sources_read"] === null ? undefined : Number(row["sources_read"]),
        lastError:
          String(row["status"]) === "error"
            ? (channelError ?? "This briefing did not complete. Try creating it again.")
            : undefined,
      })),
    };
  }

  async setSchedule(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const state = this.getChannelState(channelId);
    const pollIntervalMs = numberArg(args, "pollIntervalMs");
    const briefingIntervalMs = numberArg(args, "briefingIntervalMs");
    if (pollIntervalMs !== undefined) state.pollIntervalMs = Math.max(60_000, pollIntervalMs);
    if (briefingIntervalMs !== undefined)
      state.briefingIntervalMs = Math.max(600_000, briefingIntervalMs);
    if ("briefingAt" in args) {
      const at = args["briefingAt"];
      if (at === null) {
        state.briefingAtMinutes = undefined;
      } else if (typeof at === "string") {
        const match = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
        if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
          return { error: `invalid briefingAt: ${at} (expected "HH:MM")` };
        }
        state.briefingAtMinutes = Number(match[1]) * 60 + Number(match[2]);
        // A local-time anchor implies a daily cadence.
        state.briefingIntervalMs = Math.max(
          DAY_MS,
          state.briefingIntervalMs - (state.briefingIntervalMs % DAY_MS) || DAY_MS
        );
      }
    }
    this.saveChannelState(state);
    this.seedJobsAfterReschedule(channelId, state);
    await this.publishSetupCard(channelId);
    return {
      pollIntervalMs: state.pollIntervalMs,
      briefingIntervalMs: state.briefingIntervalMs,
      briefingAtMinutes: state.briefingAtMinutes,
    };
  }

  private seedJobsAfterReschedule(channelId: string, state: NewsChannelState): void {
    const now = this.now();
    this.scheduler.upsertJob({
      jobId: `poll:${channelId}`,
      channelId,
      intervalMs: state.pollIntervalMs,
      jitterMs: Math.min(60_000, Math.floor(state.pollIntervalMs / 10)),
      nextRunAt: now + state.pollIntervalMs,
    });
    this.scheduler.upsertJob({
      jobId: `briefing:${channelId}`,
      channelId,
      intervalMs: state.briefingIntervalMs,
      nextRunAt: nextBriefingRunAt(now, state.briefingIntervalMs, state.briefingAtMinutes),
    });
  }

  async markRead(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const ids = Array.isArray(args["articleIds"]) ? args["articleIds"].map(String) : [];
    if (ids.length === 0) return { error: "articleIds is required" };
    for (const id of ids) {
      this.sql.exec(
        `UPDATE news_articles SET read = 1 WHERE channel_id = ? AND (article_id = ? OR article_id LIKE ? || '%')`,
        channelId,
        id,
        id
      );
    }
    return { markedRead: ids.length };
  }

  async markAllRead(channelId: string, _args: Record<string, unknown>): Promise<unknown> {
    const row = this.sql
      .exec(
        `SELECT COUNT(*) AS n FROM news_articles
         WHERE channel_id = ? AND triaged = 1 AND read = 0
           AND (briefed_in IS NULL OR briefed_in NOT LIKE 'dropped:%')`,
        channelId
      )
      .toArray()[0];
    const markedRead = Number(row?.["n"] ?? 0);
    this.sql.exec(
      `UPDATE news_articles SET read = 1
       WHERE channel_id = ? AND triaged = 1 AND read = 0
         AND (briefed_in IS NULL OR briefed_in NOT LIKE 'dropped:%')`,
      channelId
    );
    return { markedRead };
  }

  /** Reader tap that teaches curation: more/less of this kind, or mute the
   *  source. Signals are folded into every future briefing prompt; muting also
   *  disables the feed so it stops being polled. */
  async reactToStory(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const idOrPrefix = stringArg(args, "articleId");
    const reaction = stringArg(args, "reaction");
    if (!idOrPrefix || (reaction !== "more" && reaction !== "less" && reaction !== "mute_source")) {
      return { error: "articleId and reaction ('more' | 'less' | 'mute_source') are required" };
    }
    const row = this.sql
      .exec(
        `SELECT a.article_id, a.title, a.feed_id, a.source, a.origin, f.title AS feed_title
         FROM news_articles a
         LEFT JOIN news_feeds f ON f.channel_id = a.channel_id AND f.feed_id = a.feed_id
         WHERE a.channel_id = ? AND (a.article_id = ? OR a.article_id LIKE ? || '%') LIMIT 1`,
        channelId,
        idOrPrefix,
        idOrPrefix
      )
      .toArray()[0];
    if (!row) return { error: `unknown article: ${idOrPrefix}` };
    const articleId = String(row["article_id"]);
    const title = String(row["title"]);
    const source =
      (row["feed_title"] as string | null) ??
      (row["source"] as string | null) ??
      (String(row["origin"]) === "search" ? "web search" : "feed");
    const feedId = (row["feed_id"] as string | null) ?? undefined;
    const now = this.now();
    const shortTitle = title.length > 80 ? `${title.slice(0, 80)}…` : title;

    if (reaction === "mute_source") {
      if (feedId) {
        this.sql.exec(
          `UPDATE news_feeds SET enabled = 0 WHERE channel_id = ? AND feed_id = ?`,
          channelId,
          feedId
        );
      }
      this.addFeedback(channelId, { at: now, reaction: "avoid", label: source, source });
      this.sql.exec(
        `UPDATE news_articles SET read = 1 WHERE channel_id = ? AND article_id = ?`,
        channelId,
        articleId
      );
      await this.publishSetupCard(channelId);
      return { muted: source, feedDisabled: Boolean(feedId) };
    }

    this.addFeedback(channelId, { at: now, reaction, label: shortTitle, source });
    if (reaction === "less") {
      this.sql.exec(
        `UPDATE news_articles SET read = 1 WHERE channel_id = ? AND article_id = ?`,
        channelId,
        articleId
      );
    }
    return { recorded: reaction, articleId };
  }

  async refreshNow(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    await this.runPoll(channelId, { force: true });
    if (booleanArg(args, "briefing")) {
      // Manual "Brief me now" — the reader is right here, so stay silent.
      await this.runBriefing(channelId, { notify: false });
      // A manual briefing runs outside the scheduler (which only realigns jobs
      // it fires), so push the next scheduled briefing to the normal cadence —
      // otherwise an early cold-start slot could fire a duplicate minutes later.
      this.rescheduleNextBriefing(channelId);
      return { polled: true, briefingStarted: true };
    }
    return { polled: true, unbriefed: this.syncEngine.countUnbriefed(channelId) };
  }

  /** Advance the briefing job to its next normal run (cadence/anchor aware). */
  private rescheduleNextBriefing(channelId: string): void {
    const state = this.getChannelState(channelId);
    this.scheduler.upsertJob({
      jobId: `briefing:${channelId}`,
      channelId,
      intervalMs: state.briefingIntervalMs,
      nextRunAt: nextBriefingRunAt(this.now(), state.briefingIntervalMs, state.briefingAtMinutes),
    });
  }

  async requestDeepDive(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const idOrPrefix = stringArg(args, "articleId");
    if (!idOrPrefix) return { error: "articleId is required" };
    const row = this.sql
      .exec(
        `SELECT article_id, canonical_url, title, briefed_in FROM news_articles
         WHERE channel_id = ? AND (article_id = ? OR article_id LIKE ? || '%') LIMIT 1`,
        channelId,
        idOrPrefix,
        idOrPrefix
      )
      .toArray()[0];
    if (!row) return { error: `unknown article: ${idOrPrefix}` };
    const payload: NewsDeepDiveRequested = {
      articleId: String(row["article_id"]),
      url: String(row["canonical_url"]),
      title: String(row["title"]),
      briefingId: (row["briefed_in"] as string | null) ?? undefined,
    };
    const actor = this.localActor(channelId);
    await this.createChannelClient(channelId).publishSignalFact(
      actor.id,
      NEWS_DEEPDIVE_SIGNAL,
      payload,
      `news-deepdive-requested:${payload.articleId}:${this.now()}`
    );
    return { requested: payload };
  }

  async getOverview(channelId: string, _args: Record<string, unknown>): Promise<unknown> {
    const state = this.getChannelState(channelId);
    return {
      setup: this.buildSetupCardState(channelId),
      articleCount: this.syncEngine.countArticles(channelId),
      unbriefedCount: this.syncEngine.countUnbriefed(channelId),
      untriagedCount: this.countUntriaged(channelId),
      lastBriefingId: state.lastBriefingId,
    };
  }
}

// Keep the operations table honest: every operation must resolve at startup.
void NEWS_OPERATIONS;

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const SEARCH_ENGINE_HOSTS = new Set([
  "google.com",
  "news.google.com",
  "bing.com",
  "duckduckgo.com",
  "search.brave.com",
  "search.yahoo.com",
  "yandex.com",
  "baidu.com",
]);

/**
 * Reject obvious non-article URLs the agent should never cite as a source:
 * search-engine result pages, on-site search endpoints, and bare homepages.
 * Conservative on purpose — section/listing pages that look like real article
 * paths are left to the prompt's judgment rather than guessed at here.
 */
function isLikelySearchOrIndexUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (SEARCH_ENGINE_HOSTS.has(host)) return true;
  if (/(^|\/)search(\/|$)/i.test(url.pathname)) return true;
  if (url.searchParams.has("q") || url.searchParams.has("query")) return true;
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "") return true; // bare homepage — not a specific article
  return false;
}

/** Best-effort plain-text snippet from a possibly-HTML feed summary. */
function plainTextSnippet(raw: string | null | undefined, max: number): string | undefined {
  if (!raw) return undefined;
  const text = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}
