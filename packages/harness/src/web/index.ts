/**
 * Vibestudio Web Tools Extension
 *
 * Registers three Pi tools:
 *   - `web_search` — Discovery via DuckDuckGo (zero-config) or an
 *     auto-selected keyed provider when the user has configured one
 *     in the credentials system.
 *   - `web_fetch` — Fetches a URL, extracts main content with Mozilla
 *     Readability, converts to markdown, stores the full result in the
 *     content-addressed blobstore, and returns `{ url, title, digest, size, head }`.
 *   - `web_read` — Reads a byte range of a previously-fetched blob by digest
 *     so the agent can drill into large pages without re-fetching.
 *
 * Designed for a "good basic experience" with zero setup: DDG works from
 * any residential IP. To upgrade to Tavily / Brave / Exa, the agent
 * registers a credential via the `@workspace-skills/web-research` skill;
 * the harness never sees the API key — it just fetches the provider URL
 * and the credentialed fetcher attaches auth based on URL audience.
 */
import type { AgentTool } from "@workspace/pi-core";
import { Buffer } from "node:buffer";
import { searchDuckDuckGo } from "./duckduckgo.js";
import { searchTavily } from "./tavily.js";
import { searchBrave } from "./brave.js";
import { searchExa } from "./exa.js";
import { extractPage } from "./extract.js";
import { selectSearchProvider, type CredentialPresenceProbe } from "./provider.js";
export type WebRpcCaller = <T = unknown>(target: string, method: string, args: unknown[]) => Promise<T>;
export interface WebToolsDeps {
    /** RPC client for blobstore put/range reads. */
    rpc: {
        call: WebRpcCaller;
    };
    /** Monotone session-latch recorder. It must settle before content is returned to the model. */
    recordIngestion?: (entry: { key: string; via: string; classification: "external" | "derived" }) => Promise<void>;
    /**
     * Asks the host whether a credential exists for a given provider origin
     * (e.g. `https://api.tavily.com/`). The host implements this by querying
     * the credentials runtime — the harness never sees the credential value.
     * Without this hook the extension stays on DuckDuckGo.
     */
    hasCredentialForOrigin?: CredentialPresenceProbe;
    /**
     * Override for the global fetch. In production the host wires a
     * binary-safe credentialed fetcher (`main:credentials.proxyFetch`)
     * that auto-attaches auth by URL-audience matching and carries
     * response bodies as bytes so PDFs/images round-trip intact. Tests
     * pass plain mocks.
     */
    fetcher?: typeof fetch;
    /** Length of the head excerpt included inline with `web_fetch` results. */
    headLength?: number;
    /** TTL (ms) for the URL→digest session memo. Default 10 minutes; 0 disables. */
    urlCacheTtlMs?: number;
    /** Override for `Date.now()` — used in tests. */
    now?: () => number;
    /** Minimum gap (ms) between successive requests to the same hostname. 0 disables. */
    perHostGapMs?: number;
    /** Override for sleep — used in tests. */
    sleep?: (ms: number) => Promise<void>;
}
const DEFAULT_HEAD_LENGTH = 5000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_READ_LIMIT = 8000;
const MAX_READ_LIMIT = 32000;
const DEFAULT_URL_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_URL_CACHE_ENTRIES = 200;
/** Minimum gap between successive requests to the same hostname (politeness). */
const DEFAULT_PER_HOST_GAP_MS = 250;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const SEARCH_PARAMETERS = {
    type: "object",
    properties: {
        query: { type: "string", description: "Search query string." },
        max_results: {
            type: "integer",
            description: `How many results to return (1-${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT}).`,
            minimum: 1,
            maximum: MAX_SEARCH_LIMIT,
        },
    },
    required: ["query"],
};
const FETCH_PARAMETERS = {
    type: "object",
    properties: {
        url: { type: "string", description: "Absolute URL (http:// or https://) to fetch." },
    },
    required: ["url"],
};
const READ_PARAMETERS = {
    type: "object",
    properties: {
        digest: {
            type: "string",
            description: "sha256 digest returned by an earlier web_fetch call.",
        },
        offset: {
            type: "integer",
            description: "Byte offset to start reading from (default 0).",
            minimum: 0,
        },
        limit: {
            type: "integer",
            description: `Maximum number of bytes to read (default ${DEFAULT_READ_LIMIT}, max ${MAX_READ_LIMIT}).`,
            minimum: 1,
            maximum: MAX_READ_LIMIT,
        },
    },
    required: ["digest"],
};
export function createWebTools(deps: WebToolsDeps): AgentTool[] {
    const rawFetcher = (deps.fetcher ?? fetch) as typeof fetch;
    const headLength = Math.max(500, deps.headLength ?? DEFAULT_HEAD_LENGTH);
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const urlCacheTtlMs = deps.urlCacheTtlMs ?? DEFAULT_URL_CACHE_TTL_MS;
    const perHostGapMs = Math.max(0, deps.perHostGapMs ?? DEFAULT_PER_HOST_GAP_MS);
    const urlCache = new Map<string, {
        digest: string;
        size: number;
        title: string;
        expiresAt: number;
    }>();
    const hostLastFetch = new Map<string, number>();
    async function politeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
        if (perHostGapMs > 0) {
            const host = hostnameOf(input);
            if (host) {
                const last = hostLastFetch.get(host) ?? 0;
                const wait = last + perHostGapMs - now();
                if (wait > 0)
                    await sleep(wait);
                hostLastFetch.set(host, now());
            }
        }
        return rawFetcher(input as never, init);
    }
    const fetcher = politeFetch as unknown as typeof fetch;
    function urlCacheGet(url: string): {
        digest: string;
        size: number;
        title: string;
    } | null {
        const entry = urlCache.get(url);
        if (!entry)
            return null;
        if (entry.expiresAt <= now()) {
            urlCache.delete(url);
            return null;
        }
        return { digest: entry.digest, size: entry.size, title: entry.title };
    }
    function urlCacheSet(url: string, digest: string, size: number, title: string): void {
        if (urlCacheTtlMs <= 0)
            return;
        if (urlCache.size >= MAX_URL_CACHE_ENTRIES) {
            // Drop the oldest entry; insertion order preserves least-recently-set.
            const firstKey = urlCache.keys().next().value;
            if (firstKey !== undefined)
                urlCache.delete(firstKey);
        }
        urlCache.set(url, { digest, size, title, expiresAt: now() + urlCacheTtlMs });
    }
    const tools: AgentTool[] = [];
    // Tool definitions below keep the registerTool shape they had as a Pi
    // extension; the registrar now just collects them into the returned list.
    const pi = {
        registerTool(tool: {
            name: string;
            label: string;
            description: string;
            parameters: unknown;
            execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
        }): void {
            tools.push(tool as unknown as AgentTool);
        },
    };
    {
        pi.registerTool({
            name: "web_search",
            label: "Web Search",
            description: "Search the open web. Returns a list of { title, url, snippet }. Uses DuckDuckGo by default; auto-upgrades to Tavily / Brave / Exa when the user has registered a credential for one of those providers (see the web-research skill).",
            parameters: SEARCH_PARAMETERS as never,
            execute: async (_toolCallId, params, signal) => {
                const { query, max_results } = params as {
                    query: string;
                    max_results?: number;
                };
                if (!query || typeof query !== "string") {
                    throw new Error("web_search: 'query' is required");
                }
                const limit = clampInt(max_results, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
                const provider = await selectSearchProvider(deps.hasCredentialForOrigin);
                const t0 = now();
                const results = await runProvider(provider, query, limit, deps, withAbort(fetcher, signal));
                if (deps.recordIngestion) {
                    const domains = [...new Set(results.map((result) => hostnameOf(result.url)).filter((host): host is string => Boolean(host)))];
                    await Promise.all(domains.map((host) => deps.recordIngestion!({ key: `web:${host}`, via: `web-search:${provider}`, classification: "external" })));
                }
                const elapsedMs = now() - t0;
                const text = formatSearchResults(results, provider, query);
                return {
                    content: [{ type: "text" as const, text }],
                    details: {
                        provider,
                        query,
                        count: results.length,
                        results,
                        elapsed_ms: elapsedMs,
                    },
                };
            },
        });
        pi.registerTool({
            name: "web_fetch",
            label: "Web Fetch",
            description: "Fetch a URL, extract its main content as markdown, and cache the full result in the blobstore. Returns the cleaned title, a head excerpt, and a digest. Use web_read with the digest to read more of the cached page without re-fetching.",
            parameters: FETCH_PARAMETERS as never,
            execute: async (_toolCallId, params, signal) => {
                const { url } = params as {
                    url: string;
                };
                if (!url || typeof url !== "string") {
                    throw new Error("web_fetch: 'url' is required");
                }
                if (!/^https?:\/\//iu.test(url)) {
                    throw new Error("web_fetch: 'url' must start with http:// or https://");
                }
                const sourceHost = hostnameOf(url);
                if (!sourceHost) throw new Error("web_fetch: URL has no canonical host");
                const t0 = now();
                const cached = urlCacheGet(url);
                if (cached) {
                    const headSlice = await readUtf8BlobRange(deps.rpc, cached.digest, 0, headLength);
                    if (headSlice !== null) {
                        await deps.recordIngestion?.({ key: `web:${sourceHost}`, via: "web-fetch-cache", classification: "external" });
                        const truncated = cached.size > headSlice.bytes;
                        const summary = [
                            `# ${cached.title}`,
                            url,
                            "",
                            `Cached as digest ${cached.digest} (${cached.size} bytes, served from session cache).`,
                            truncated
                                ? `Showing the first ${headSlice.bytes} of ${cached.size} bytes. Use web_read({ digest, offset, limit }) to read more.`
                                : "Full content shown below.",
                            "",
                            headSlice.text,
                        ].join("\n");
                        return {
                            content: [{ type: "text" as const, text: summary }],
                            details: {
                                url,
                                title: cached.title,
                                digest: cached.digest,
                                size: cached.size,
                                head_length: headSlice.bytes,
                                truncated,
                                served_from_cache: true,
                                elapsed_ms: now() - t0,
                            },
                        };
                    }
                    // Blob was pruned out from under us; fall through and re-fetch.
                }
                const page = await extractPage(url, withAbort(fetcher, signal) as never, signal);
                await deps.recordIngestion?.({ key: `web:${sourceHost}`, via: "web-fetch", classification: "external" });
                const stored = await deps.rpc.call<{
                    digest: string;
                    size: number;
                }>("main", "blobstore.putText", [page.markdown]);
                urlCacheSet(url, stored.digest, stored.size, page.title);
                const head = utf8Prefix(page.markdown, headLength);
                const truncated = stored.size > head.byteLength;
                const summary = [
                    `# ${page.title}`,
                    page.url,
                    "",
                    `Cached as digest ${stored.digest} (${stored.size} bytes).`,
                    truncated
                        ? `Showing the first ${head.byteLength} of ${stored.size} bytes. Use web_read({ digest, offset, limit }) to read more.`
                        : "Full content shown below.",
                    "",
                    head.text,
                ].join("\n");
                return {
                    content: [{ type: "text" as const, text: summary }],
                    details: {
                        url: page.url,
                        title: page.title,
                        digest: stored.digest,
                        size: stored.size,
                        head_length: head.byteLength,
                        truncated,
                        served_from_cache: false,
                        elapsed_ms: now() - t0,
                        content_type: page.contentType,
                    },
                };
            },
        });
        pi.registerTool({
            name: "web_read",
            label: "Web Read",
            description: "Read a byte range of a page previously cached by web_fetch. Identify the page by the digest returned from web_fetch.",
            parameters: READ_PARAMETERS as never,
            execute: async (_toolCallId, params) => {
                const { digest, offset, limit } = params as {
                    digest: string;
                    offset?: number;
                    limit?: number;
                };
                if (!digest || typeof digest !== "string") {
                    throw new Error("web_read: 'digest' is required");
                }
                const off = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);
                const len = clampInt(limit, 1, MAX_READ_LIMIT, DEFAULT_READ_LIMIT);
                const slice = await readUtf8BlobRange(deps.rpc, digest, off, len);
                if (slice === null) {
                    throw new Error(`web_read: no cached blob found for digest ${digest}`);
                }
                return {
                    content: [{ type: "text" as const, text: slice.text }],
                    details: {
                        digest,
                        offset: off,
                        limit: len,
                        bytes: slice.bytes,
                        next_offset: off + slice.bytes,
                    },
                };
            },
        });
    }
    return tools;
}
async function runProvider(provider: import("./types.js").ProviderName, query: string, limit: number, _deps: WebToolsDeps, fetcher: typeof fetch): Promise<import("./types.js").SearchResult[]> {
    switch (provider) {
        case "tavily":
            return searchTavily(query, limit, fetcher as never);
        case "brave":
            return searchBrave(query, limit, fetcher as never);
        case "exa":
            return searchExa(query, limit, fetcher as never);
        case "duckduckgo":
        default:
            return searchDuckDuckGo(query, limit, fetcher as never);
    }
}
function hostnameOf(input: string | URL | Request): string | null {
    try {
        if (typeof input === "string")
            return new URL(input).hostname;
        if (input instanceof URL)
            return input.hostname;
        if (input && typeof input === "object" && "url" in input) {
            return new URL((input as {
                url: string;
            }).url).hostname;
        }
        return null;
    }
    catch {
        return null;
    }
}
async function readUtf8BlobRange(rpc: WebToolsDeps["rpc"], digest: string, offset: number, limit: number): Promise<{
    text: string;
    bytes: number;
} | null> {
    const range = await rpc.call<{ bytesBase64: string } | null>("main", "blobstore.getRangeBytes", [
        digest,
        offset,
        limit,
    ]);
    if (range === null)
        return null;
    return decodeUtf8BlobRange(Buffer.from(range.bytesBase64, "base64"));
}
function decodeUtf8BlobRange(bytes: Uint8Array): {
    text: string;
    bytes: number;
} {
    let start = 0;
    while (start < bytes.length && isUtf8Continuation(bytes[start]!))
        start++;
    let end = start;
    while (end < bytes.length) {
        const width = completeUtf8SequenceLength(bytes, end);
        if (width <= 0)
            break;
        end += width;
    }
    return { text: textDecoder.decode(bytes.subarray(start, end)), bytes: end };
}
function completeUtf8SequenceLength(bytes: Uint8Array, offset: number): number {
    const first = bytes[offset]!;
    const width = expectedUtf8SequenceLength(first);
    if (width === 0 || offset + width > bytes.length)
        return 0;
    for (let i = 1; i < width; i++) {
        if (!isUtf8Continuation(bytes[offset + i]!))
            return 0;
    }
    return width;
}
function expectedUtf8SequenceLength(first: number): number {
    if (first <= 0x7f)
        return 1;
    if (first >= 0xc2 && first <= 0xdf)
        return 2;
    if (first >= 0xe0 && first <= 0xef)
        return 3;
    if (first >= 0xf0 && first <= 0xf4)
        return 4;
    return 0;
}
function isUtf8Continuation(byte: number): boolean {
    return (byte & 0xc0) === 0x80;
}
function utf8Prefix(text: string, maxBytes: number): { text: string; byteLength: number } {
    const bytes = textEncoder.encode(text);
    if (bytes.byteLength <= maxBytes)
        return { text, byteLength: bytes.byteLength };
    let end = Math.max(0, Math.min(text.length, maxBytes));
    while (end > 0 && textEncoder.encode(text.slice(0, end)).byteLength > maxBytes)
        end--;
    if (end > 0) {
        const last = text.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff)
            end--;
    }
    const prefix = text.slice(0, end);
    return { text: prefix, byteLength: textEncoder.encode(prefix).byteLength };
}
function withAbort(fetcher: typeof fetch, outer?: AbortSignal): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort(new Error(`web tool fetch timed out after ${DEFAULT_FETCH_TIMEOUT_MS}ms`));
        }, DEFAULT_FETCH_TIMEOUT_MS);
        const abort = () => controller.abort(outer?.reason ?? new Error("web tool aborted"));
        if (outer) {
            if (outer.aborted)
                abort();
            else
                outer.addEventListener("abort", abort, { once: true });
        }
        const initSignal = init?.signal;
        const abortInit = () => controller.abort(initSignal?.reason ?? new Error("web tool fetch aborted"));
        if (initSignal) {
            if (initSignal.aborted)
                abortInit();
            else
                initSignal.addEventListener("abort", abortInit, { once: true });
        }
        try {
            return await fetcher(input as never, { ...init, signal: controller.signal });
        }
        finally {
            clearTimeout(timeout);
            outer?.removeEventListener("abort", abort);
            initSignal?.removeEventListener("abort", abortInit);
        }
    }) as typeof fetch;
}
function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
    if (typeof raw !== "number" || !Number.isFinite(raw))
        return fallback;
    const n = Math.trunc(raw);
    if (n < min)
        return min;
    if (n > max)
        return max;
    return n;
}
function formatSearchResults(results: Array<{
    title: string;
    url: string;
    snippet: string;
}>, provider: string, query: string): string {
    if (results.length === 0) {
        return `No results for "${query}" (provider: ${provider}).`;
    }
    const lines: string[] = [`Web search results for "${query}" (provider: ${provider}):`, ""];
    for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        lines.push(`${i + 1}. ${r.title}`);
        lines.push(`   ${r.url}`);
        if (r.snippet)
            lines.push(`   ${r.snippet}`);
        lines.push("");
    }
    return lines.join("\n");
}
export type { SearchResult, ProviderName } from "./types.js";
export type { CredentialPresenceProbe } from "./provider.js";
