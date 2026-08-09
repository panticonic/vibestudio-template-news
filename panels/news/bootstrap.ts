/** Pure bootstrap + presentation helpers, unit-testable without the runtime. */

export function requireNewsContextId(runtimeContextId: string | undefined): string {
  const contextId = runtimeContextId?.trim();
  if (!contextId) throw new Error("News panel runtime has no workspace context");
  return contextId;
}

/**
 * Stable, format-safe digest of a contextId (djb2 → base36). Deterministic and
 * bounded, so the reader's channel/agent ids are a pure function of the panel's
 * context rather than a random value that must be remembered in stateArgs.
 */
export function hashContext(contextId: string): string {
  let hash = 5381;
  for (let i = 0; i < contextId.length; i += 1) {
    hash = ((hash << 5) + hash + contextId.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Derive the reader's channel + agent ids deterministically from the panel's
 * contextId. Because a panel keeps its contextId across reloads (it persists in
 * the panel tree), any reload — even one that lost its stateArgs — re-resolves
 * the SAME reader DO and channel. Different contexts (the usual per-panel case)
 * get independent readers.
 */
export function newsChannelName(contextId: string): string {
  return `news-${hashContext(contextId)}`;
}

export function newsAgentKey(contextId: string): string {
  return `news-agent-${hashContext(contextId)}`;
}

/**
 * Reader data changes are represented by custom card events. Invocation
 * lifecycle events are deliberately excluded: a refresh triggered by the
 * reader's own RPC calls would otherwise create a self-sustaining refresh
 * storm.
 */
export function isNewsReaderDataEvent(event: { type?: string; payload?: unknown }): boolean {
  if (event.type !== "agentic.trajectory.v1/event") return false;
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const kind = (payload as { kind?: unknown }).kind;
  return kind === "custom.started" || kind === "custom.updated";
}

/** Curated one-click feeds for the empty-state quick start. */
export interface SuggestedFeed {
  label: string;
  url: string;
  blurb: string;
}

export const SUGGESTED_FEEDS: SuggestedFeed[] = [
  { label: "Hacker News", url: "https://hnrss.org/frontpage", blurb: "Tech & startups" },
  {
    label: "Ars Technica",
    url: "https://feeds.arstechnica.com/arstechnica/index",
    blurb: "Tech, science, policy",
  },
  { label: "The Verge", url: "https://www.theverge.com/rss/index.xml", blurb: "Tech & culture" },
  { label: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", blurb: "World news" },
  {
    label: "NASA",
    url: "https://www.nasa.gov/feed/",
    blurb: "Space & science",
  },
];

/** Curated one-click topics (web-searched each briefing). */
export const SUGGESTED_TOPICS: string[] = [
  "artificial intelligence",
  "open source software",
  "space exploration",
  "climate technology",
  "startups & venture capital",
];

/** Compact relative age like "now" / "3h" / "2d" for a timestamp. */
export function relativeAge(iso: string | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}
