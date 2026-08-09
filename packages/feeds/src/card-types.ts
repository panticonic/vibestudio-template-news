/**
 * Shared news card payload contracts.
 *
 * TS interfaces are imported by both the news-agent worker (emission) and the
 * skill renderers (consumption). The matching JSON Schema documents are
 * registered with the channel message types so the platform validates card
 * states at emission and fold time. Schemas are deliberately permissive
 * (`additionalProperties: true`, minimal `required`) so renderers tolerate
 * extra fields while still catching shape mistakes.
 */

// ── Story refs ──────────────────────────────────────────────────────────────

export interface NewsStoryRef {
  /** sha256 hex of the canonical URL — the article identity everywhere. */
  articleId: string;
  url: string;
  title: string;
  /** Feed title, or "web search" for topic-followed stories. */
  source: string;
  /** "feed" for RSS-ingested stories, "search" for topic-followed ones. */
  origin: "feed" | "search";
  /** ISO timestamp when known. */
  publishedAt?: string;
  score: number;
  /** One-liner: LLM blurb after Tier 2, feed summary before. */
  blurb?: string;
  read?: boolean;
}

// ── Briefing card ───────────────────────────────────────────────────────────

export type NewsBriefingStatus = "collecting" | "summarizing" | "ready" | "error";

export interface NewsBriefingCardState {
  briefingId: string;
  createdAt: string;
  status: NewsBriefingStatus;
  /** LLM TLDR markdown; absent until Tier 2 completes. */
  tldr?: string;
  stories: NewsStoryRef[];
  articleCountScanned: number;
  newSinceLastRun: number;
  /** How many concrete sources the agent actually fetched/read for this digest. */
  sourcesRead?: number;
  lastError?: string;
}

// ── Setup card ──────────────────────────────────────────────────────────────

export interface NewsFeedInfo {
  feedId: string;
  url: string;
  title?: string;
  weight: number;
  enabled: boolean;
  lastFetchAt?: string;
  lastStatus?: string;
  failCount: number;
}

export interface NewsTopicInfo {
  topic: string;
  weight: number;
  enabled: boolean;
}

export type NewsSetupStatus = "needs-user-preferences" | "configured";

export interface NewsSetupCardState {
  status: NewsSetupStatus;
  feeds: NewsFeedInfo[];
  followedTopics: NewsTopicInfo[];
  /** Human-readable, e.g. "polls every 30m, briefing daily at 08:00". */
  scheduleSummary: string;
  pollIntervalMs: number;
  briefingIntervalMs: number;
  /** Local-time anchor for daily briefings (minutes after midnight), when set. */
  briefingAtMinutes?: number;
  /** Scheduled briefings paused ("vacation"); manual briefing still works. */
  briefingPaused?: boolean;
  preferencesText?: string;
  lastRunAt?: string;
  lastError?: string;
}

// ── Signals ─────────────────────────────────────────────────────────────────

/** Signal-event contentType for deep-dive requests (story tap → channel fork). */
export const NEWS_DEEPDIVE_SIGNAL = "news.deepdive.requested";

export interface NewsDeepDiveRequested {
  articleId: string;
  url: string;
  title: string;
  briefingId?: string;
}

// ── JSON Schemas (registered with the channel message types) ───────────────

const STORY_REF_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    articleId: { type: "string" },
    url: { type: "string" },
    title: { type: "string" },
    source: { type: "string" },
    origin: { enum: ["feed", "search"] },
    publishedAt: { type: "string" },
    score: { type: "number" },
    blurb: { type: "string" },
    read: { type: "boolean" },
  },
  required: ["articleId", "url", "title"],
};

export const NEWS_BRIEFING_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    briefingId: { type: "string" },
    createdAt: { type: "string" },
    status: { enum: ["collecting", "summarizing", "ready", "error"] },
    tldr: { type: "string" },
    stories: { type: "array", items: STORY_REF_SCHEMA },
    articleCountScanned: { type: "number" },
    newSinceLastRun: { type: "number" },
    sourcesRead: { type: "number" },
    lastError: { type: "string" },
  },
  required: ["briefingId", "status", "stories"],
};

export const NEWS_SETUP_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    status: { enum: ["needs-user-preferences", "configured"] },
    feeds: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          feedId: { type: "string" },
          url: { type: "string" },
          title: { type: "string" },
          weight: { type: "number" },
          enabled: { type: "boolean" },
          lastFetchAt: { type: "string" },
          lastStatus: { type: "string" },
          failCount: { type: "number" },
        },
        required: ["feedId", "url"],
      },
    },
    followedTopics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          topic: { type: "string" },
          weight: { type: "number" },
          enabled: { type: "boolean" },
        },
        required: ["topic"],
      },
    },
    scheduleSummary: { type: "string" },
    pollIntervalMs: { type: "number" },
    briefingIntervalMs: { type: "number" },
    briefingAtMinutes: { type: "number" },
    briefingPaused: { type: "boolean" },
    preferencesText: { type: "string" },
    lastRunAt: { type: "string" },
    lastError: { type: "string" },
  },
  required: ["status", "feeds", "pollIntervalMs"],
};
