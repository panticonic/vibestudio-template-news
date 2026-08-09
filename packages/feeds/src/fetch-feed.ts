/**
 * Polite conditional feed fetching. Generic over the actual transport (pass a
 * `fetcher` for tests or credential-injected fetch) and reusable by any agent
 * that polls external HTTP resources.
 */

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchFeedOptions {
  /** Previously stored ETag; sent as If-None-Match. */
  etag?: string;
  /** Previously stored Last-Modified; sent as If-Modified-Since. */
  lastModified?: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
  userAgent?: string;
}

export type FetchFeedResult =
  | { status: "ok"; body: string; etag?: string; lastModified?: string; httpStatus: number }
  | { status: "not-modified"; httpStatus: 304 }
  | { status: "error"; error: string; httpStatus?: number };

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_USER_AGENT = "Vibestudio-Feeds/0.1 (+https://vibestudio.dev)";

export async function fetchFeed(url: string, options: FetchFeedOptions = {}): Promise<FetchFeedResult> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      accept: "application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, application/json;q=0.9, */*;q=0.8",
      "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
    };
    if (options.etag) headers["if-none-match"] = options.etag;
    if (options.lastModified) headers["if-modified-since"] = options.lastModified;

    const response = await fetcher(url, { headers, redirect: "follow", signal: controller.signal });
    if (response.status === 304) return { status: "not-modified", httpStatus: 304 };
    if (!response.ok) {
      return { status: "error", error: `HTTP ${response.status}`, httpStatus: response.status };
    }
    const body = await response.text();
    return {
      status: "ok",
      body,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
      httpStatus: response.status,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { status: "error", error: aborted ? "timeout" : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Per-host politeness gate: callers ask `delayFor(url, now)` and wait that
 * many ms before fetching (0 = go now). In-memory only — fine for a DO that
 * polls in batches; the durable schedule lives in the caller's tables.
 */
export class HostPoliteness {
  private readonly nextAllowedAt = new Map<string, number>();

  constructor(private readonly minIntervalMs = 30_000) {}

  /** Returns ms to wait before hitting this URL's host, and reserves the slot. */
  delayFor(url: string, now: number): number {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return 0;
    }
    const allowedAt = this.nextAllowedAt.get(host) ?? 0;
    const start = Math.max(now, allowedAt);
    this.nextAllowedAt.set(host, start + this.minIntervalMs);
    return start - now;
  }
}
