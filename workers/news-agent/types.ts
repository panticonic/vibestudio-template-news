export const DEFAULT_POLL_INTERVAL_MS = 30 * 60_000;
export const DEFAULT_BRIEFING_INTERVAL_MS = 24 * 3_600_000;
export const DEFAULT_TOP_K = 12;
/** Keep at most this many reader feedback signals; oldest fall off. */
export const MAX_FEEDBACK_SIGNALS = 24;
/** Prune unbriefed articles older than this during polls. */
export const ARTICLE_RETENTION_MS = 14 * 24 * 3_600_000;
/** A briefing older than this is marked errored on the next reader operation. */
export const BRIEFING_WATCHDOG_MS = 10 * 60_000;

/** Channel role: a normal personal news channel, or a deep-dive analyst fork. */
export type NewsChannelMode = "curator" | "analyst";

/** A reader's tap on a story: teaches curation what to surface more/less of. */
export interface FeedbackSignal {
  /** epoch ms when recorded. */
  at: number;
  reaction: "more" | "less" | "avoid";
  /** Story title (more/less) or source name (avoid), already truncated. */
  label: string;
  /** Source/publication the story came from, when known. */
  source?: string;
}

export interface NewsChannelState {
  channelId: string;
  pollIntervalMs: number;
  briefingIntervalMs: number;
  /** Local-time anchor (minutes after midnight) for daily briefings. */
  briefingAtMinutes?: number;
  topK: number;
  setupStatus: "needs-user-preferences" | "configured";
  preferencesText?: string;
  lastBriefingId?: string;
  lastRunAt?: number;
  lastError?: string;
  lastSetupJson?: string;
  mode: NewsChannelMode;
  /** Raw JSON of FeedbackSignal[] (parsed on demand). */
  feedbackJson?: string;
  /** Scheduled briefings paused ("vacation"); manual briefing still works. */
  briefingPaused: boolean;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberArg(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function booleanArg(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}
