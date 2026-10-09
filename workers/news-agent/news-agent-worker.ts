import { Type } from "@panticonic/pi-ai";
import { copyJson, type Context } from "@panticonic/pi-chord";
import { BACKGROUND_CONTEXT } from "@panticonic/pi-chord/context";
import type {
  ToolRegistration,
  SettledSubmissionRecord,
} from "@panticonic/pi-durable";
import type { AgentProductMetadata } from "@workspace/agentic-core/agent-product-metadata";
import { withRpcAbortSignal, type RpcClient } from "@vibestudio/rpc";
import {
  createMissionsClient,
  type MissionRecord,
  type MissionTrigger,
} from "@vibestudio/automation/mission";
import { canonicalCronTimeZone } from "@vibestudio/automation/cronSchedule";
import { createRpcFs } from "@workspace/runtime/worker/rpc-fs";
import {
  AgentWorkerBase,
  installMessageTypes,
  type ClonedChannelContext,
  type RespondPolicy,
  CardManager,
} from "@workspace/agentic-do";
import type { DurableObjectContext } from "@workspace/runtime/worker";
import type { ActorRef } from "@workspace/agentic-protocol";
import type { ParticipantDescriptor } from "@workspace/harness";
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
  DEFAULT_BRIEFING_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TOP_K,
  MAX_FEEDBACK_SIGNALS,
  booleanArg,
  numberArg,
  record,
  stringArg,
  type FeedbackSignal,
  type NewsChannelMode,
  type NewsChannelState,
} from "./types.js";

const NEWS_AGENT_SCHEMA_BASELINE = 1;
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
  type NewsEffects,
} from "./operations.js";
import {
  NEWS_ANALYST_PROMPT,
  NEWS_SYSTEM_PROMPT,
  buildBriefingPrompt,
  buildDeepDivePrompt,
  buildTriagePrompt,
} from "./prompts.js";

const NEWS_BASE_TOOL_NAMES = new Set([
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

export class NewsAgentWorker extends AgentWorkerBase implements NewsHandlers {
  static override schemaVersion = NEWS_AGENT_SCHEMA_BASELINE;

  private readonly syncEngine: NewsSyncEngine;
  private readonly newsCards: NewsCards;
  private readonly operationIndex: Map<string, NewsOperation>;
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
    this.newsCards = new NewsCards(this.cards);
    this.operationIndex = buildOperationIndex();
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

  protected override async createAgentTables(): Promise<void> {
    await super.createAgentTables();
    createNewsTables(this.sql);
  }

  // ── channel state ──────────────────────────────────────────────────────────

  private ensureChannelState(channelId: string): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO news_channel_state (channel_id) VALUES (?)`,
      channelId,
    );
  }

  private getChannelState(channelId: string): NewsChannelState {
    this.ensureChannelState(channelId);
    const row = this.sql
      .exec(`SELECT * FROM news_channel_state WHERE channel_id = ?`, channelId)
      .toArray()[0]!;
    return {
      channelId,
      topK: Number(row["top_k"]) || DEFAULT_TOP_K,
      setupStatus:
        row["setup_status"] === "configured"
          ? "configured"
          : "needs-user-preferences",
      preferencesText: (row["preferences_text"] as string | null) ?? undefined,
      lastBriefingId: (row["last_briefing_id"] as string | null) ?? undefined,
      lastRunAt: (row["last_run_at"] as number | null) ?? undefined,
      lastError: (row["last_error"] as string | null) ?? undefined,
      lastSetupJson: (row["last_setup_json"] as string | null) ?? undefined,
      mode: row["mode"] === "analyst" ? "analyst" : "curator",
      feedbackJson: (row["feedback_json"] as string | null) ?? undefined,
    };
  }

  /** Cheap, side-effect-free mode read (used in the per-turn prompt path). */
  private getMode(channelId: string): NewsChannelMode {
    const row = this.sql
      .exec(
        `SELECT mode FROM news_channel_state WHERE channel_id = ?`,
        channelId,
      )
      .toArray()[0];
    return row?.["mode"] === "analyst" ? "analyst" : "curator";
  }

  private setChannelMode(channelId: string, mode: NewsChannelMode): void {
    this.sql.exec(
      `INSERT INTO news_channel_state (channel_id, setup_status, mode)
       VALUES (?, 'configured', ?)
       ON CONFLICT(channel_id) DO UPDATE SET mode = excluded.mode`,
      channelId,
      mode,
    );
  }

  private saveChannelState(state: NewsChannelState): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO news_channel_state
       (channel_id, top_k, setup_status, preferences_text, last_briefing_id, last_run_at, last_error, last_setup_json, mode, feedback_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      state.channelId,
      state.topK,
      state.setupStatus,
      state.preferencesText ?? null,
      state.lastBriefingId ?? null,
      state.lastRunAt ?? null,
      state.lastError ?? null,
      state.lastSetupJson ?? null,
      state.mode,
      state.feedbackJson ?? null,
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
      (entry) =>
        !(entry.reaction === signal.reaction && entry.label === signal.label),
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
        if (signal.reaction === "more")
          return `More like: "${signal.label}"${where}`;
        if (signal.reaction === "less")
          return `Less like: "${signal.label}"${where}`;
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
    return this.getMode(channelId) === "analyst"
      ? NEWS_ANALYST_PROMPT
      : NEWS_SYSTEM_PROMPT;
  }

  private boundNewsEffects(
    rpc: RpcClient,
    context: Context,
    metadata?: AgentProductMetadata,
  ): NewsEffects {
    const cards = new CardManager({
      sql: this.sql,
      createChannelClient: (id) => this.createChannelClient(id, rpc),
      getParticipantId: (id) => this.subscriptions.getParticipantId(id),
      getActor: () => ({ kind: "agent", id: this.participantId() }),
      getAgentId: () => this.objectKey,
    });
    const fetcher = this.feedFetcher() ?? fetch;
    return {
      cards: new NewsCards(cards),
      manager: cards,
      rpc,
      fetcher: async (url, init) => {
        const signal = context.abortSignal;
        signal?.throwIfAborted();
        try {
          return await fetcher(url, {
            ...init,
            signal:
              signal && init?.signal
                ? AbortSignal.any([signal, init.signal])
                : (signal ?? init?.signal),
          });
        } catch (error) {
          signal?.throwIfAborted();
          throw error;
        }
      },
      signal: context.abortSignal,
      metadata,
    };
  }

  protected override async getTools(
    channelId: string,
  ): Promise<ToolRegistration[]> {
    const baseTools = (await super.getTools(channelId)).filter((tool) =>
      NEWS_BASE_TOOL_NAMES.has(tool.name),
    );
    const newsTools: ToolRegistration[] = toolOperations().map((op) => ({
      name: op.name,
      version: 1,
      description: op.description,
      parameters: Type.Unsafe<Record<string, unknown>>(op.schema),
      executionData: { channelId },
      execute: async (args, api, context) => {
        if (record(api.executionData)["channelId"] !== channelId)
          throw new Error("News tool changed its original channel binding");
        const execution = await this.bindNativeToolExecution(api, context);
        const effects = this.boundNewsEffects(
          execution.rpc,
          context,
          execution.metadata,
        );
        if (op.needsRecovery) await this.ensureRecovered(channelId, effects);
        const details = copyJson(
          await op.run({ handlers: this, effects }, channelId, record(args)),
          { omitUndefinedProperties: true },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    }));
    return [...baseTools, ...newsTools];
  }

  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown,
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

  protected override async prepareNativeChannelProduct(
    channelId: string,
    configuration: unknown,
    fork: ClonedChannelContext | null,
    context: Context,
  ): Promise<void> {
    await super.prepareNativeChannelProduct(
      channelId,
      configuration,
      fork,
      context,
    );
    const effects = this.boundNewsEffects(
      context.abortSignal
        ? withRpcAbortSignal(this.rpc, context.abortSignal)
        : this.rpc,
      context,
    );
    this.ensureChannelState(channelId);
    await this.installChannelUi(channelId, effects);
    if (this.getMode(channelId) !== "analyst")
      await this.ensureNewsSchedules(channelId, effects);
    if (this.getMode(channelId) !== "analyst")
      await this.publishSetupCard(channelId, effects);
  }

  private scheduleId(channelId: string, kind: "poll" | "briefing"): string {
    return `news:${this.objectKey}:${channelId}:${kind}`;
  }

  private async readNewsSchedules(channelId: string, effects?: NewsEffects) {
    const missions = createMissionsClient(effects?.rpc ?? this.rpc);
    const [poll, briefing] = await Promise.all([
      missions.getDefault(this.scheduleId(channelId, "poll")),
      missions.getDefault(this.scheduleId(channelId, "briefing")),
    ]);
    return { missions, poll, briefing };
  }

  /** Missions is the sole schedule owner; reopening never overwrites edits. */
  private async ensureNewsSchedules(
    channelId: string,
    effects?: NewsEffects,
    initialState: {
      poll: "active" | "paused";
      briefing: "active" | "paused";
    } = { poll: "active", briefing: "active" },
  ) {
    const current = await this.readNewsSchedules(channelId, effects);
    const definitions = [
      {
        kind: "poll" as const,
        name: "Refresh News",
        summary: "Refresh this reader's feeds.",
        trigger: () =>
          ({
            kind: "schedule",
            everyMs: DEFAULT_POLL_INTERVAL_MS,
          }) as MissionTrigger,
        briefing: false,
      },
      {
        kind: "briefing" as const,
        name: "News briefing",
        summary: "Prepare this reader's news briefing.",
        trigger: () =>
          ({
            kind: "schedule",
            everyMs: DEFAULT_BRIEFING_INTERVAL_MS,
          }) as MissionTrigger,
        briefing: true,
      },
    ];
    for (const definition of definitions) {
      if (current[definition.kind]) continue;
      await this.provisionChannelAutomation(
        this.scheduleId(channelId, definition.kind),
        channelId,
        {
          name: definition.name,
          summary: definition.summary,
          action: {
            kind: "tool",
            tool: "refreshNow",
            args: { briefing: definition.briefing },
          },
          trigger: definition.trigger(),
          state: initialState[definition.kind],
          operations: [],
        },
        effects?.rpc ?? this.rpc,
      );
    }
    return this.readNewsSchedules(channelId, effects);
  }

  private dailyBriefingTrigger(
    minutes: number,
    timezone?: string,
  ): MissionTrigger {
    if (!timezone)
      throw new Error(
        "A daily News briefing requires an explicit IANA timezone.",
      );
    return {
      kind: "cron",
      expression: `${minutes % 60} ${Math.floor(minutes / 60)} * * *`,
      timezone: canonicalCronTimeZone(timezone),
    };
  }

  private scheduleProjection(
    poll: MissionRecord | null,
    briefing: MissionRecord | null,
  ) {
    const describe = (mission: MissionRecord | null) => {
      if (!mission) return "not scheduled";
      if (mission.state !== "active") return mission.state;
      const trigger = mission.charter.trigger;
      if (trigger.kind === "manual") return "manual";
      if (trigger.kind === "cron")
        return `${trigger.expression} (${trigger.timezone})`;
      return `every ${Math.round(trigger.everyMs / 60_000)}m`;
    };
    const pollTrigger = poll?.charter.trigger;
    const briefTrigger = briefing?.charter.trigger;
    const daily =
      briefTrigger?.kind === "cron"
        ? /^(\d+) (\d+) \* \* \*$/.exec(briefTrigger.expression)
        : null;
    return {
      scheduleSummary: `feeds ${describe(poll)}; briefing ${describe(briefing)}`,
      pollIntervalMs:
        pollTrigger?.kind === "schedule" ? pollTrigger.everyMs : undefined,
      briefingIntervalMs:
        briefTrigger?.kind === "schedule" ? briefTrigger.everyMs : undefined,
      briefingAtMinutes: daily
        ? Number(daily[2]) * 60 + Number(daily[1])
        : undefined,
      timezone:
        briefTrigger?.kind === "cron" ? briefTrigger.timezone : undefined,
      briefingPaused: !briefing || briefing.state !== "active",
    };
  }

  // ── deep-dive forks ─────────────────────────────────────────────────────────

  /** A knowledge fork starts with fresh execution and curator storage.
   * Mark its new channel as an analyst thread before subscription setup. */
  protected override async onChannelForked(
    ctx: ClonedChannelContext,
  ): Promise<void> {
    this.setChannelMode(ctx.newChannelId, "analyst");
  }

  /** Seed a forked deep-dive channel's opening analyst turn. The panel calls
   *  this on the fresh agent after fork(); idempotent via steeringId. */
  async startDeepDive(
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    const input = record(args);
    const url = stringArg(input, "url");
    const title = stringArg(input, "title");
    if (!url || !title)
      return { ok: false, error: "url and title are required" };
    this.setChannelMode(channelId, "analyst");
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
      { steeringId: `news-deepdive:${channelId}:${articleId ?? url}` },
    );
    return { ok: true };
  }

  // ── Tier 1: poll ──────────────────────────────────────────────────────────

  private async runPoll(
    channelId: string,
    opts?: { force?: boolean },
    effects?: NewsEffects,
  ): Promise<void> {
    const state = this.getChannelState(channelId);
    try {
      const result = await this.syncEngine.pollChannel(channelId, {
        ...opts,
        fetcher: effects?.fetcher,
        signal: effects?.signal,
      });
      // Skipped feeds retain their own failure state. A no-op poll cannot
      // declare recovery from a failure or advance the successful-sync time.
      if (result.feedsPolled > result.feedsFailed) state.lastRunAt = this.now();
      const failed = this.sql
        .exec(
          "SELECT COUNT(*) AS count FROM news_feeds WHERE channel_id = ? AND enabled = 1 AND fail_count > 0",
          channelId,
        )
        .toArray()[0];
      const count = Number(failed?.["count"] ?? 0);
      state.lastError =
        count > 0
          ? `${count} ${count === 1 ? "feed could" : "feeds could"} not refresh. Open Sources for the failure details.`
          : undefined;
    } catch (err) {
      effects?.signal?.throwIfAborted();
      state.lastError = err instanceof Error ? err.message : String(err);
      this.saveChannelState(state);
      try {
        await this.publishSetupCard(channelId, effects);
      } catch (cardError) {
        throw new AggregateError(
          [err, cardError],
          "News polling failed and its setup card could not be updated.",
          { cause: err },
        );
      }
      throw err;
    }
    this.saveChannelState(state);
    await this.publishSetupCard(channelId, effects);
  }

  private briefingErrorKey(channelId: string, briefingId: string): string {
    return `news:briefing-error:${JSON.stringify([channelId, briefingId])}`;
  }

  private async failBriefing(
    channelId: string,
    briefingId: string,
    message: string,
  ): Promise<void> {
    const pending = this.sql
      .exec(
        "SELECT status FROM news_briefings WHERE channel_id = ? AND briefing_id = ?",
        channelId,
        briefingId,
      )
      .toArray()[0];
    if (pending?.["status"] === "error") {
      await this.updateBriefingCard(channelId, briefingId, {
        status: "error",
        lastError:
          this.getStateValue(this.briefingErrorKey(channelId, briefingId)) ??
          message,
      });
      return;
    }
    if (pending?.["status"] !== "summarizing") return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE news_briefings SET status = 'error' WHERE channel_id = ? AND briefing_id = ?",
        channelId,
        briefingId,
      );
      this.setStateValue(this.briefingErrorKey(channelId, briefingId), message);
    });
    await this.updateBriefingCard(channelId, briefingId, {
      status: "error",
      lastError: message,
    });
  }

  protected override async onNativeInputSettled(
    channelId: string,
    submission: SettledSubmissionRecord,
    metadata: AgentProductMetadata | undefined,
    context: Context,
  ): Promise<void> {
    await super.onNativeInputSettled(channelId, submission, metadata, context);
    if (metadata?.domain?.kind !== "news.briefing") return;
    const briefingId = stringArg(record(metadata.domain.data), "briefingId");
    if (!briefingId)
      throw new Error("News briefing input has no original briefing binding");
    const detail =
      submission.status === "unanswered" ? submission.detail : undefined;
    const original =
      typeof detail === "string"
        ? detail
        : stringArg(record(detail), "message");
    const message =
      original ||
      `Briefing input ended (${submission.status === "unanswered" ? submission.reason : "answered"}) without publishing a briefing.`;
    await this.failBriefing(channelId, briefingId, message);
  }

  // ── Tier 2: briefing ──────────────────────────────────────────────────────

  private async runBriefing(
    channelId: string,
    opts?: { notify?: boolean },
    effects?: NewsEffects,
  ): Promise<void> {
    // Fresh articles first; a stale snapshot makes a stale briefing.
    await this.runPoll(channelId, undefined, effects);
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
      notify,
    );
    const steeringId = `news-briefing:${channelId}:${briefingId}`;
    const previousTldr = this.previousTldr(channelId, briefingId);
    try {
      effects?.signal?.throwIfAborted();
      await (effects?.cards ?? this.newsCards).createBriefing(channelId, card);
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
        { steeringId, domain: { kind: "news.briefing", data: { briefingId } } },
        { ...BACKGROUND_CONTEXT, abortSignal: effects?.signal },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.failBriefing(
        channelId,
        briefingId,
        `Briefing could not start: ${message}`,
      );
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
        channelId,
      )
      .toArray()[0];
    return Number(row?.["n"] ?? 0);
  }

  private listCategories(channelId: string): string[] {
    return this.sql
      .exec(
        `SELECT DISTINCT category FROM news_articles
         WHERE channel_id = ? AND category IS NOT NULL AND category != '' LIMIT 24`,
        channelId,
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
        TRIAGE_BATCH_SIZE,
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
        (row["blurb"] as string | null) ??
        plainTextSnippet(row["summary"] as string | null, 200),
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
      { steeringId: `news-triage:${channelId}:${this.now()}` },
    );
    return true;
  }

  private previousTldr(
    channelId: string,
    excludeBriefingId: string,
  ): string | undefined {
    const row = this.sql
      .exec(
        `SELECT tldr FROM news_briefings
         WHERE channel_id = ? AND briefing_id != ? AND status = 'ready' AND tldr IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        channelId,
        excludeBriefingId,
      )
      .toArray()[0];
    return (row?.["tldr"] as string | null) ?? undefined;
  }

  private briefingState(
    channelId: string,
    briefingId: string,
  ): NewsBriefingCardState | undefined {
    const row = this.sql
      .exec(
        `SELECT * FROM news_briefings WHERE channel_id = ? AND briefing_id = ?`,
        channelId,
        briefingId,
      )
      .toArray()[0];
    if (!row) return undefined;
    const storyIds = JSON.parse(
      String(row["story_ids_json"] ?? "[]"),
    ) as string[];
    return {
      briefingId,
      createdAt: new Date(Number(row["created_at"])).toISOString(),
      status: String(row["status"]) as NewsBriefingCardState["status"],
      tldr: (row["tldr"] as string | null) ?? undefined,
      lastError:
        this.getStateValue(this.briefingErrorKey(channelId, briefingId)) ??
        undefined,
      stories: this.storiesByIds(channelId, storyIds),
      articleCountScanned: storyIds.length,
      newSinceLastRun: 0,
      sourcesRead:
        row["sources_read"] === null ? undefined : Number(row["sources_read"]),
    };
  }

  private storiesByIds(
    channelId: string,
    articleIds: string[],
  ): NewsStoryRef[] {
    const stories: NewsStoryRef[] = [];
    for (const id of articleIds) {
      const row = this.sql
        .exec(
          `SELECT a.*, f.title AS feed_title FROM news_articles a
           LEFT JOIN news_feeds f ON f.channel_id = a.channel_id AND f.feed_id = a.feed_id
           WHERE a.channel_id = ? AND a.article_id = ?`,
          channelId,
          id,
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
    patch: Partial<NewsBriefingCardState>,
  ): Promise<void> {
    const current = this.briefingState(channelId, briefingId);
    if (!current) return;
    await this.newsCards.updateBriefing(channelId, briefingId, {
      ...current,
      ...patch,
    });
  }

  // ── setup card ────────────────────────────────────────────────────────────

  private async buildSetupCardState(
    channelId: string,
    effects?: NewsEffects,
  ): Promise<NewsSetupCardState> {
    const state = this.getChannelState(channelId);
    const feeds = this.sql
      .exec(
        `SELECT * FROM news_feeds WHERE channel_id = ? ORDER BY url`,
        channelId,
      )
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
    const { poll, briefing } = await this.readNewsSchedules(channelId, effects);
    return {
      status: state.setupStatus,
      feeds,
      followedTopics,
      ...this.scheduleProjection(poll, briefing),
      preferencesText: state.preferencesText,
      lastRunAt: state.lastRunAt
        ? new Date(state.lastRunAt).toISOString()
        : undefined,
      lastError: state.lastError,
    };
  }

  private async publishSetupCard(
    channelId: string,
    effects?: NewsEffects,
  ): Promise<void> {
    const payload = await this.buildSetupCardState(channelId, effects);
    const state = this.getChannelState(channelId);
    // Dedup on the meaningful fields only. `lastRunAt` ticks on every poll but
    // isn't rendered, so including it would defeat the dedup and re-emit the
    // card constantly.
    const { lastRunAt: _lastRunAt, ...stable } = payload;
    const signature = JSON.stringify(stable);
    if (state.lastSetupJson === signature) return;
    await (effects?.cards ?? this.newsCards).publishSetup(channelId, payload);
    state.lastSetupJson = signature;
    this.saveChannelState(state);
  }

  private listTopics(
    channelId: string,
  ): Array<{ topic: string; weight: number; enabled: boolean }> {
    return this.sql
      .exec(
        `SELECT topic, weight, enabled FROM news_topics WHERE channel_id = ? ORDER BY topic`,
        channelId,
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
    if (!participantId)
      throw new Error(`News agent is not subscribed to channel ${channelId}`);
    return {
      kind: "agent",
      id: participantId,
      participantId,
      displayName: "News",
      metadata: { type: "agent", handle: "news", name: "News" },
    };
  }

  private async installChannelUi(
    channelId: string,
    effects: NewsEffects,
  ): Promise<void> {
    const fs = createRpcFs(effects.rpc);
    await installMessageTypes({
      channel: this.createChannelClient(channelId, effects.rpc),
      actor: this.localActor(channelId),
      specs: NEWS_MESSAGE_TYPES,
      imports: NEWS_UI_IMPORTS,
      version: NEWS_UI_INSTALL_VERSION,
      keyPrefix: "news",
      cards: effects.manager,
      channelId,
      readFile: async (path) => {
        const raw = await fs.readFile(path, "utf8");
        return typeof raw === "string"
          ? raw
          : raw instanceof Uint8Array
            ? new TextDecoder().decode(raw)
            : null;
      },
    });
  }

  private async ensureRecovered(
    channelId: string,
    effects?: NewsEffects,
  ): Promise<void> {
    if (this.recoveredChannels.has(channelId)) return;
    const folded = await this.indexOwnCustomMessages(
      channelId,
      () => undefined,
      effects?.rpc ?? this.rpc,
    );
    const setup = folded.get("news.setup");
    if (setup && setup.size > 0) {
      const messageId = [...setup.keys()][0]!;
      (effects?.cards ?? this.newsCards).adoptRecoveredCard(
        channelId,
        SETUP_CARD_KEY,
        "news.setup",
        messageId,
      );
    }
    for (const [messageId, value] of folded.get("news.briefing") ?? []) {
      const briefingId = stringArg(record(value), "briefingId");
      if (!briefingId) continue;
      (effects?.cards ?? this.newsCards).adoptRecoveredCard(
        channelId,
        briefingCardKey(briefingId),
        "news.briefing",
        messageId,
      );
    }
    this.recoveredChannels.add(channelId);
  }

  // ── method dispatch ───────────────────────────────────────────────────────

  protected override async handleAgentMethodCall(
    channelId: string,
    methodName: string,
    args: unknown,
    signal: AbortSignal,
    transportCallId: string,
  ): Promise<{ result: unknown; isError?: boolean }> {
    const standardResult = await this.handleStandardAgentMethodCall(
      channelId,
      methodName,
      args,
      signal,
      transportCallId,
    );
    if (standardResult) return standardResult;

    const op = this.operationIndex.get(methodName);
    if (!op || !op.exposure.includes("method")) {
      return {
        result: { error: `unknown method: ${methodName}` },
        isError: true,
      };
    }
    const effects = this.boundNewsEffects(
      withRpcAbortSignal(this.rpc, signal),
      { ...BACKGROUND_CONTEXT, abortSignal: signal },
    );
    if (op.needsRecovery) await this.ensureRecovered(channelId, effects);
    signal.throwIfAborted();
    const result = await op.run(
      { handlers: this, effects },
      channelId,
      record(args),
    );
    const isError = Boolean(
      result &&
      typeof result === "object" &&
      "error" in (result as Record<string, unknown>),
    );
    return isError ? { result, isError: true } : { result };
  }

  // ── NewsHandlers implementation ───────────────────────────────────────────

  async addFeed(
    channelId: string,
    args: Record<string, unknown>,
    effects?: NewsEffects,
  ): Promise<unknown> {
    const url = stringArg(args, "url");
    if (!url) return { error: "url is required" };
    const fetched = await fetchFeed(url, {
      fetcher: effects?.fetcher ?? this.feedFetcher(),
    });
    effects?.signal?.throwIfAborted();
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
      const refetched = await fetchFeed(discovered, {
        fetcher: effects?.fetcher ?? this.feedFetcher(),
      });
      effects?.signal?.throwIfAborted();
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
      numberArg(args, "weight") ?? 1.0,
    );
    // Ingest right away so the feed visibly works.
    let added = 0;
    for (const item of parsed.items.slice(0, 50)) {
      if (
        await this.syncEngine.insertArticle(channelId, {
          ...item,
          feedId,
          origin: "feed",
        })
      ) {
        added += 1;
      }
    }
    await this.markConfigured(channelId);
    await this.publishSetupCard(channelId, effects);
    return {
      feedId,
      title: parsed.title,
      url: feedUrl,
      ...(feedUrl !== url ? { discoveredFrom: url } : {}),
      itemCount: parsed.items.length,
      newArticles: added,
    };
  }

  async importOpml(
    channelId: string,
    args: Record<string, unknown>,
    effects?: NewsEffects,
  ): Promise<unknown> {
    const opml = stringArg(args, "opml");
    if (!opml) return { error: "opml is required" };
    const feeds = parseOpml(opml);
    if (feeds.length === 0)
      return { error: "no feed subscriptions found in the OPML" };
    const slice = feeds.slice(0, MAX_OPML_FEEDS);
    let imported = 0;
    const failed: string[] = [];
    for (const feed of slice) {
      const result = (await this.addFeed(
        channelId,
        {
          url: feed.url,
        },
        effects,
      )) as Record<string, unknown>;
      if (result["error"]) failed.push(feed.url);
      else imported += 1;
    }
    return {
      imported,
      failed: failed.length,
      total: feeds.length,
      ...(feeds.length > slice.length
        ? { skipped: feeds.length - slice.length }
        : {}),
    };
  }

  async removeFeed(
    channelId: string,
    args: Record<string, unknown>,
    effects?: NewsEffects,
  ): Promise<unknown> {
    const feedId =
      stringArg(args, "feedId") ??
      (stringArg(args, "url")
        ? (await canonicalArticleId(stringArg(args, "url")!)).slice(0, 16)
        : undefined);
    if (!feedId) return { error: "feedId or url is required" };
    this.sql.exec(
      `DELETE FROM news_feeds WHERE channel_id = ? AND feed_id = ?`,
      channelId,
      feedId,
    );
    await this.publishSetupCard(channelId, effects);
    return { removed: feedId };
  }

  async setFeedEnabled(
    channelId: string,
    args: Record<string, unknown>,
    effects?: NewsEffects,
  ): Promise<unknown> {
    const feedId = stringArg(args, "feedId");
    const enabled = booleanArg(args, "enabled");
    if (!feedId || enabled === undefined)
      return { error: "feedId and enabled are required" };
    this.sql.exec(
      `UPDATE news_feeds SET enabled = ? WHERE channel_id = ? AND feed_id = ?`,
      enabled ? 1 : 0,
      channelId,
      feedId,
    );
    await this.publishSetupCard(channelId, effects);
    return { feedId, enabled };
  }

  async followTopic(
    channelId: string,
    args: Record<string, unknown>,
    effects?: NewsEffects,
  ): Promise<unknown> {
    const topic = stringArg(args, "topic");
    if (!topic) return { error: "topic is required" };
    this.sql.exec(
      `INSERT INTO news_topics (channel_id, topic, weight, enabled) VALUES (?, ?, ?, 1)
       ON CONFLICT(channel_id, topic) DO UPDATE SET weight = excluded.weight, enabled = 1`,
      channelId,
      topic,
      numberArg(args, "weight") ?? 1.0,
    );
    await this.markConfigured(channelId);
    await this.publishSetupCard(channelId, effects);
    return { following: topic };
  }

  async unfollowTopic(
    channelId: string,
    args: Record<string, unknown>,
    effects?: NewsEffects,
  ): Promise<unknown> {
    const topic = stringArg(args, "topic");
    if (!topic) return { error: "topic is required" };
    this.sql.exec(
      `DELETE FROM news_topics WHERE channel_id = ? AND topic = ?`,
      channelId,
      topic,
    );
    await this.publishSetupCard(channelId, effects);
    return { unfollowed: topic };
  }

  async setPreferences(
    channelId: string,
    args: Record<string, unknown>,
    effects?: NewsEffects,
  ): Promise<unknown> {
    const text = stringArg(args, "text") ?? "";
    const state = this.getChannelState(channelId);
    state.preferencesText = text || undefined;
    this.saveChannelState(state);
    await this.markConfigured(channelId);
    await this.publishSetupCard(channelId, effects);
    return { saved: true, preferencesText: state.preferencesText };
  }

  private async markConfigured(channelId: string): Promise<void> {
    const state = this.getChannelState(channelId);
    if (state.setupStatus === "configured") return;
    state.setupStatus = "configured";
    this.saveChannelState(state);
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
        (row["blurb"] as string | null) ??
        plainTextSnippet(row["summary"] as string | null, 400),
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

  async listArticles(
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
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
      clauses.push(
        "(a.briefed_in IS NULL OR a.briefed_in NOT LIKE 'dropped:%')",
      );
    } else if (unbriefedOnly) {
      clauses.push("a.briefed_in IS NULL");
    } else {
      // Dropped candidates were explicitly cut from a briefing — never surface
      // them in the reader (they are the opposite of "interesting").
      clauses.push(
        "(a.briefed_in IS NULL OR a.briefed_in NOT LIKE 'dropped:%')",
      );
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
        "(COALESCE(a.published_at, a.fetched_at) < ? OR (COALESCE(a.published_at, a.fetched_at) = ? AND a.article_id < ?))",
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
        limit + 1,
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
   *  TLDRs, using literal case-insensitive substring matching. */
  async searchArchive(
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const query = stringArg(args, "query");
    if (!query) return { query: "", articles: [], briefings: [] };
    const limit = Math.min(numberArg(args, "limit") ?? 40, 100);
    const articleRows = this.sql
      .exec(
        `SELECT ${ARTICLE_COLUMNS}
         FROM news_articles a
         LEFT JOIN news_feeds f ON f.channel_id = a.channel_id AND f.feed_id = a.feed_id
         WHERE a.channel_id = ?
           AND (a.briefed_in IS NULL OR a.briefed_in NOT LIKE 'dropped:%')
           AND (instr(lower(a.title), lower(?)) > 0 OR instr(lower(a.blurb), lower(?)) > 0
                OR instr(lower(a.summary), lower(?)) > 0 OR instr(lower(a.source), lower(?)) > 0)
         ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
         LIMIT ?`,
        channelId,
        query,
        query,
        query,
        query,
        limit,
      )
      .toArray();
    const briefingRows = this.sql
      .exec(
        `SELECT briefing_id, created_at, tldr, sources_read FROM news_briefings
         WHERE channel_id = ? AND status = 'ready' AND instr(lower(tldr), lower(?)) > 0
         ORDER BY created_at DESC LIMIT ?`,
        channelId,
        query,
        Math.min(limit, 20),
      )
      .toArray();
    return {
      query,
      articles: articleRows.map((row) => this.mapArticleRow(row)),
      briefings: briefingRows.map((row) => ({
        briefingId: String(row["briefing_id"]),
        createdAt: new Date(Number(row["created_at"])).toISOString(),
        tldr: (row["tldr"] as string | null) ?? undefined,
        sourcesRead:
          row["sources_read"] === null
            ? undefined
            : Number(row["sources_read"]),
      })),
    };
  }

  /** Article identifiers are literal identities, never SQL wildcard patterns.
   * Model tools may abbreviate an ID only when that prefix identifies one row. */
  private resolveArticleId(
    channelId: string,
    idOrPrefix: string,
  ): string | null {
    const rows = this.sql
      .exec(
        `SELECT article_id FROM news_articles
       WHERE channel_id = ? AND substr(article_id, 1, length(?)) = ? LIMIT 2`,
        channelId,
        idOrPrefix,
        idOrPrefix,
      )
      .toArray();
    if (rows.length > 1)
      throw new Error(
        `Ambiguous article ID: ${idOrPrefix}. Use the full article ID.`,
      );
    return rows[0] ? String(rows[0]["article_id"]) : null;
  }

  async setSaved(
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const idOrPrefix = stringArg(args, "articleId");
    const saved = booleanArg(args, "saved");
    if (!idOrPrefix || saved === undefined) {
      return { error: "articleId and saved are required" };
    }
    const id = this.resolveArticleId(channelId, idOrPrefix);
    if (!id) return { error: `unknown article: ${idOrPrefix}` };
    this.sql.exec(
      `UPDATE news_articles SET saved = ? WHERE channel_id = ? AND article_id = ?`,
      saved ? 1 : 0,
      channelId,
      id,
    );
    return { articleId: id, saved };
  }

  async setBriefingPaused(
    channelId: string,
    args: Record<string, unknown>,
    effects?: NewsEffects,
  ): Promise<unknown> {
    const paused = booleanArg(args, "paused");
    if (paused === undefined) return { error: "paused is required" };
    const { missions, briefing } = await this.ensureNewsSchedules(
      channelId,
      effects,
      { poll: "active", briefing: paused ? "paused" : "active" },
    );
    if (!briefing)
      throw new Error("News briefing schedule was not admitted by its owner.");
    if (paused) await missions.pause(briefing.missionId);
    else await missions.resume(briefing.missionId);
    await this.publishSetupCard(channelId, effects);
    return { briefingPaused: paused };
  }

  /** Tool handler: record the agent's triage of a batch of stories. */
  async triageStories(
    channelId: string,
    args: Record<string, unknown>,
    effects?: NewsEffects,
  ): Promise<unknown> {
    const items = Array.isArray(args["items"]) ? args["items"] : [];
    let triaged = 0;
    let dropped = 0;
    for (const entry of items) {
      const item = record(entry);
      const idOrPrefix = stringArg(item, "articleId");
      if (!idOrPrefix) continue;
      const articleId = this.resolveArticleId(channelId, idOrPrefix);
      if (!articleId) continue;
      if (booleanArg(item, "keep") === false) {
        // Drop noise: mark triaged + hidden so it never surfaces and isn't re-triaged.
        this.sql.exec(
          `UPDATE news_articles SET triaged = 1, read = 1,
             briefed_in = COALESCE(briefed_in, 'dropped:triage')
           WHERE channel_id = ? AND article_id = ?`,
          channelId,
          articleId,
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
        articleId,
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
        await this.publishSetupCard(channelId, effects);
        throw err;
      }
    }
    return { triaged, dropped, remaining, continued };
  }

  /** On-demand triage entry point (the reader calls this when it opens with a
   *  backlog). Fires a triage turn if anything is un-triaged. */
  async triageNow(
    channelId: string,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    const pending = this.countUntriaged(channelId);
    if (pending === 0) return { started: false, pending: 0 };
    const started = await this.runTriage(channelId);
    return { started, pending };
  }

  async publishBriefing(
    channelId: string,
    args: Record<string, unknown>,
    effects?: NewsEffects,
  ): Promise<unknown> {
    const briefingId = stringArg(args, "briefingId");
    const tldr = stringArg(args, "tldr");
    if (!briefingId || !tldr)
      return { error: "briefingId and tldr are required" };
    const sourcesRead = numberArg(args, "sourcesRead");
    const briefing = this.briefingState(channelId, briefingId);
    if (!briefing) return { error: `unknown briefing: ${briefingId}` };
    if (briefing.status === "ready") {
      await this.deliverReadyBriefing(channelId, briefing, effects);
      return {
        published: briefingId,
        storyCount: briefing.stories.length,
        at: briefing.createdAt,
      };
    }
    if (briefing.status !== "summarizing")
      return {
        error: `Briefing ${briefingId} is ${briefing.status} and cannot be published.`,
      };

    const blurbs = new Map<string, string>();
    for (const entry of Array.isArray(args["storyBlurbs"])
      ? args["storyBlurbs"]
      : []) {
      const item = record(entry);
      const id = stringArg(item, "articleId");
      if (id) blurbs.set(id, stringArg(item, "blurb") ?? "");
    }
    const dropped = new Set(
      (Array.isArray(args["droppedArticleIds"])
        ? args["droppedArticleIds"]
        : []
      ).map(String),
    );
    const kept: NewsStoryRef[] = [];
    const keptIds = new Set<string>();
    for (const story of briefing.stories) {
      const droppedHit = [...dropped].some(
        (id) => story.articleId === id || story.articleId.startsWith(id),
      );
      if (droppedHit) continue;
      const blurbKey = [...blurbs.keys()].find(
        (id) => story.articleId === id || story.articleId.startsWith(id),
      );
      kept.push({
        ...story,
        blurb: blurbKey ? blurbs.get(blurbKey) || story.blurb : story.blurb,
      });
      keptIds.add(story.articleId);
    }

    // Search-found stories become first-class articles (deduped by URL). The
    // agent is instructed to cite concrete articles; reject the obvious
    // search/listing offenders here as defense in depth.
    let searchStoryCount = 0;
    for (const entry of Array.isArray(args["searchStories"])
      ? args["searchStories"]
      : []) {
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
    const published = this.ctx.storage.transactionSync(() => {
      const committed = this.sql
        .exec(
          `UPDATE news_briefings SET status = 'ready', tldr = ?, story_ids_json = ?, sources_read = ? WHERE channel_id = ? AND briefing_id = ? AND status = 'summarizing' RETURNING briefing_id`,
          tldr,
          JSON.stringify(kept.map((story) => story.articleId)),
          sourcesRead ?? null,
          channelId,
          briefingId,
        )
        .toArray();
      if (committed.length === 0) return false;
      for (const story of kept) {
        this.sql.exec(
          `UPDATE news_articles SET briefed_in = ?, blurb = COALESCE(?, blurb), triaged = 1 WHERE channel_id = ? AND article_id = ?`,
          briefingId,
          story.blurb ?? null,
          channelId,
          story.articleId,
        );
      }
      for (const prefix of dropped) {
        const id = this.resolveArticleId(channelId, prefix);
        if (!id) continue;
        this.sql.exec(
          `UPDATE news_articles SET briefed_in = ? WHERE channel_id = ? AND article_id = ?`,
          `dropped:${briefingId}`,
          channelId,
          id,
        );
      }
      const state = this.getChannelState(channelId);
      state.lastBriefingId = briefingId;
      this.saveChannelState(state);

      return true;
    });
    if (!published)
      return { error: `Briefing ${briefingId} ended before publication.` };
    const ready = this.briefingState(channelId, briefingId);
    if (!ready || ready.status !== "ready")
      throw new Error("Committed briefing disappeared before delivery");
    await this.deliverReadyBriefing(channelId, ready, effects);
    return {
      published: briefingId,
      storyCount: kept.length,
      at: new Date(now).toISOString(),
    };
  }

  private async deliverReadyBriefing(
    channelId: string,
    briefing: NewsBriefingCardState,
    effects?: NewsEffects,
  ): Promise<void> {
    await (effects?.cards ?? this.newsCards).updateBriefing(
      channelId,
      briefing.briefingId,
      briefing,
    );
    const notify = this.sql
      .exec(
        "SELECT notify FROM news_briefings WHERE channel_id = ? AND briefing_id = ?",
        channelId,
        briefing.briefingId,
      )
      .toArray()[0];
    if (Number(notify?.["notify"] ?? 1) !== 0)
      await this.notifyBriefingReady(
        channelId,
        briefing.briefingId,
        briefing.stories,
        briefing.sourcesRead,
        effects,
      );
  }

  /**
   * A finished briefing is exactly the thing a phone is for: the run happened
   * while nobody was watching. It escalates to the channel's owner at the
   * `inbox` rung — durable entry plus push, no screen seized — and the deep
   * link opens this channel focused on the briefing card that already exists
   * there. A manual "Brief me now" never reaches here: the reader is already
   * looking at the panel that ran it.
   *
   * The canonical briefing survives delivery failure. Its original invocation
   * remains failed until the same card and notification delivery is repaired.
   */
  private async notifyBriefingReady(
    channelId: string,
    briefingId: string,
    stories: NewsStoryRef[],
    sourcesRead?: number,
    effects?: NewsEffects,
  ): Promise<void> {
    if (stories.length === 0) return;
    const owner = this.channelOwnerUserId(channelId);
    if (!owner) return;
    const headlines = stories.slice(0, 3).map((story) => story.title);
    const more =
      stories.length > headlines.length
        ? `\n\n_+${stories.length - headlines.length} more_`
        : "";
    const readNote =
      sourcesRead && sourcesRead > 0
        ? ` · ${sourcesRead} source${sourcesRead > 1 ? "s" : ""} read`
        : "";
    await this.escalateNotify(
      {
        userId: owner,
        channelId,
        messageId: briefingCardKey(briefingId),
        senderParticipantId: this.participantId(),
        senderHandle: "news",
        rung: "inbox",
        title: `Your briefing is ready — ${stories.length} stor${stories.length > 1 ? "ies" : "y"}${readNote}`,
        message: `${headlines.map((headline) => `- ${headline}`).join("\n")}${more}`,
      },
      effects?.rpc ?? this.rpc,
    );
  }

  /** The single person on this channel, when there is one. See the messaging
   *  plan's `owner` rule: a channel with several people has no unambiguous
   *  owner, and guessing one is how a briefing reaches the wrong reader. */
  private channelOwnerUserId(channelId: string): string | null {
    const users = this.rosterSnapshot(channelId).filter(
      (entry) => entry.ref.kind === "user",
    );
    if (users.length !== 1) return null;
    const id = users[0]?.ref.participantId ?? users[0]?.participantId ?? "";
    return id.startsWith("user:") ? id.slice("user:".length) : id || null;
  }

  async briefingHistory(
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const limit = Math.min(numberArg(args, "limit") ?? 5, 50);
    const rows = this.sql
      .exec(
        `SELECT briefing_id, created_at, status, tldr, sources_read FROM news_briefings
         WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`,
        channelId,
        limit,
      )
      .toArray();
    return {
      briefings: rows.map((row) => ({
        briefingId: String(row["briefing_id"]),
        createdAt: new Date(Number(row["created_at"])).toISOString(),
        status: String(row["status"]),
        tldr: (row["tldr"] as string | null) ?? undefined,
        sourcesRead:
          row["sources_read"] === null
            ? undefined
            : Number(row["sources_read"]),
        lastError:
          String(row["status"]) === "error"
            ? (this.getStateValue(
                this.briefingErrorKey(channelId, String(row["briefing_id"])),
              ) ?? "This briefing did not complete. Try creating it again.")
            : undefined,
      })),
    };
  }

  async setSchedule(
    channelId: string,
    args: Record<string, unknown>,
    effects?: NewsEffects,
  ): Promise<unknown> {
    const interval = (key: string, minimum: number): number | undefined => {
      if (!(key in args)) return undefined;
      const value = numberArg(args, key);
      if (
        value === undefined ||
        !Number.isSafeInteger(value) ||
        value < minimum
      )
        throw new Error(
          `${key} must be an integer of at least ${minimum} milliseconds.`,
        );
      return value;
    };
    const pollIntervalMs = interval("pollIntervalMs", 60_000);
    const briefingIntervalMs = interval("briefingIntervalMs", 600_000);
    let minutes: number | undefined;
    if (args["briefingAt"] !== undefined && args["briefingAt"] !== null) {
      const at = args["briefingAt"];
      const match =
        typeof at === "string" ? /^(\d{1,2}):(\d{2})$/.exec(at.trim()) : null;
      if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
        throw new Error("briefingAt must be a valid HH:MM time.");
      minutes = Number(match[1]) * 60 + Number(match[2]);
    }
    if (minutes !== undefined && briefingIntervalMs !== undefined)
      throw new Error("Choose either briefingIntervalMs or a daily briefingAt.");
    // Validate user input before provisioning or editing either owner row.
    const requestedTimezone = stringArg(args, "timezone");
    if (requestedTimezone) canonicalCronTimeZone(requestedTimezone);
    const existing = await this.readNewsSchedules(channelId, effects);
    const dailyTrigger =
      minutes === undefined
        ? undefined
        : this.dailyBriefingTrigger(
            minutes,
            requestedTimezone ??
              (existing.briefing?.charter.trigger.kind === "cron"
                ? existing.briefing.charter.trigger.timezone
                : undefined),
          );
    const { missions, poll, briefing } = await this.ensureNewsSchedules(
      channelId,
      effects,
    );
    if (!poll || !briefing)
      throw new Error("News schedules were not admitted by their owner.");
    let trigger: MissionTrigger | undefined;
    if (minutes !== undefined) {
      trigger = dailyTrigger;
    } else if (
      briefingIntervalMs !== undefined ||
      args["briefingAt"] === null
    ) {
      trigger = {
        kind: "schedule",
        everyMs: briefingIntervalMs ?? DEFAULT_BRIEFING_INTERVAL_MS,
      };
    } else if (requestedTimezone && briefing.charter.trigger.kind === "cron") {
      trigger = {
        ...briefing.charter.trigger,
        timezone: canonicalCronTimeZone(requestedTimezone),
      };
    }
    if (pollIntervalMs !== undefined)
      await missions.edit(poll.missionId, {
        charter: {
          ...poll.charter,
          trigger: { kind: "schedule", everyMs: pollIntervalMs },
        },
      });
    if (trigger)
      await missions.edit(briefing.missionId, {
        charter: { ...briefing.charter, trigger },
      });
    await this.publishSetupCard(channelId, effects);
    const current = await this.readNewsSchedules(channelId, effects);
    return this.scheduleProjection(current.poll, current.briefing);
  }

  async markRead(
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const ids = Array.isArray(args["articleIds"])
      ? args["articleIds"].map(String)
      : [];
    if (ids.length === 0) return { error: "articleIds is required" };
    const resolved = ids.map((id) => this.resolveArticleId(channelId, id));
    if (resolved.some((id) => !id))
      return { error: "An article no longer exists" };
    for (const id of resolved) {
      this.sql.exec(
        `UPDATE news_articles SET read = 1 WHERE channel_id = ? AND article_id = ?`,
        channelId,
        id,
      );
    }
    return { markedRead: resolved.length };
  }

  async markAllRead(
    channelId: string,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    const row = this.sql
      .exec(
        `SELECT COUNT(*) AS n FROM news_articles
         WHERE channel_id = ? AND triaged = 1 AND read = 0
           AND (briefed_in IS NULL OR briefed_in NOT LIKE 'dropped:%')`,
        channelId,
      )
      .toArray()[0];
    const markedRead = Number(row?.["n"] ?? 0);
    this.sql.exec(
      `UPDATE news_articles SET read = 1
       WHERE channel_id = ? AND triaged = 1 AND read = 0
         AND (briefed_in IS NULL OR briefed_in NOT LIKE 'dropped:%')`,
      channelId,
    );
    return { markedRead };
  }

  /** Reader tap that teaches curation: more/less of this kind, or mute the
   *  source. Signals are folded into every future briefing prompt; muting also
   *  disables the feed so it stops being polled. */
  async reactToStory(
    channelId: string,
    args: Record<string, unknown>,
    effects?: NewsEffects,
  ): Promise<unknown> {
    const idOrPrefix = stringArg(args, "articleId");
    const reaction = stringArg(args, "reaction");
    if (
      !idOrPrefix ||
      (reaction !== "more" && reaction !== "less" && reaction !== "mute_source")
    ) {
      return {
        error:
          "articleId and reaction ('more' | 'less' | 'mute_source') are required",
      };
    }
    const resolvedId = this.resolveArticleId(channelId, idOrPrefix);
    if (!resolvedId) return { error: `unknown article: ${idOrPrefix}` };
    const row = this.sql
      .exec(
        `SELECT a.article_id, a.title, a.feed_id, a.source, a.origin, f.title AS feed_title
         FROM news_articles a
         LEFT JOIN news_feeds f ON f.channel_id = a.channel_id AND f.feed_id = a.feed_id
         WHERE a.channel_id = ? AND a.article_id = ?`,
        channelId,
        resolvedId,
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
          feedId,
        );
      }
      this.addFeedback(channelId, {
        at: now,
        reaction: "avoid",
        label: source,
        source,
      });
      this.sql.exec(
        `UPDATE news_articles SET read = 1 WHERE channel_id = ? AND article_id = ?`,
        channelId,
        articleId,
      );
      await this.publishSetupCard(channelId, effects);
      return { muted: source, feedDisabled: Boolean(feedId) };
    }

    this.addFeedback(channelId, {
      at: now,
      reaction,
      label: shortTitle,
      source,
    });
    if (reaction === "less") {
      this.sql.exec(
        `UPDATE news_articles SET read = 1 WHERE channel_id = ? AND article_id = ?`,
        channelId,
        articleId,
      );
    }
    return { recorded: reaction, articleId };
  }

  async refreshNow(
    channelId: string,
    args: Record<string, unknown>,
    effects?: NewsEffects,
  ): Promise<unknown> {
    await this.runPoll(channelId, { force: true }, effects);
    if (booleanArg(args, "briefing")) {
      // Manual "Brief me now" — the reader is right here, so stay silent.
      await this.runBriefing(
        channelId,
        { notify: effects?.metadata?.origin === "scheduled" },
        effects,
      );
      return { polled: true, briefingStarted: true };
    }
    return {
      polled: true,
      unbriefed: this.syncEngine.countUnbriefed(channelId),
    };
  }

  async requestDeepDive(
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const idOrPrefix = stringArg(args, "articleId");
    if (!idOrPrefix) return { error: "articleId is required" };
    const resolvedId = this.resolveArticleId(channelId, idOrPrefix);
    if (!resolvedId) return { error: `unknown article: ${idOrPrefix}` };
    const row = this.sql
      .exec(
        `SELECT article_id, canonical_url, title, briefed_in FROM news_articles
         WHERE channel_id = ? AND article_id = ?`,
        channelId,
        resolvedId,
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
      `news-deepdive-requested:${payload.articleId}:${this.now()}`,
    );
    return { requested: payload };
  }

  async getOverview(
    channelId: string,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    const state = this.getChannelState(channelId);
    return {
      setup: await this.buildSetupCardState(channelId),
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
function plainTextSnippet(
  raw: string | null | undefined,
  max: number,
): string | undefined {
  if (!raw) return undefined;
  const text = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}
