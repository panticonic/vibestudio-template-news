/**
 * Feed parsing for the three formats that cover essentially all feeds in the
 * wild: RSS 2.0 (and the 0.9x/RDF variants close enough to read the same),
 * Atom, and JSON Feed. Returns a normalized {@link ParsedFeed} regardless of
 * input format.
 */

import { XMLParser } from "fast-xml-parser";

export interface FeedItem {
  /** Item link, absolutized against the feed URL when relative. */
  url: string;
  title: string;
  /** Plain-text-ish summary/description when the feed provides one. */
  summary?: string;
  /** Full content HTML when present (content:encoded / atom content). */
  contentHtml?: string;
  /** Epoch ms; undefined when the feed omits or mangles the date. */
  publishedAt?: number;
  author?: string;
  /** Feed-provided unique id (guid / atom id / json feed id). */
  guid?: string;
}

export interface ParsedFeed {
  title?: string;
  /** Feed-declared site link. */
  link?: string;
  items: FeedItem[];
}

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedParseError";
  }
}

/**
 * Parse a feed document. Format is sniffed from the body itself (the
 * `contentType` hint only short-circuits JSON detection) because servers
 * routinely lie about feed content types.
 */
export function parseFeed(body: string, contentType?: string, baseUrl?: string): ParsedFeed {
  const trimmed = body.trimStart();
  if (trimmed.length === 0) throw new FeedParseError("empty feed body");

  const looksJson = trimmed.startsWith("{") || (contentType ?? "").includes("json");
  if (looksJson) return parseJsonFeed(trimmed, baseUrl);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Feeds embed HTML inside CDATA; keep it as raw string content.
    cdataPropName: "__cdata",
    trimValues: true,
  });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    throw new FeedParseError(`invalid XML: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (doc["rss"] !== undefined) return parseRss(doc["rss"] as Record<string, unknown>, baseUrl);
  if (doc["feed"] !== undefined) return parseAtom(doc["feed"] as Record<string, unknown>, baseUrl);
  // RDF (RSS 1.0): channel and items live side by side under rdf:RDF.
  const rdf = doc["rdf:RDF"] ?? doc["RDF"];
  if (rdf !== undefined) return parseRdf(rdf as Record<string, unknown>, baseUrl);
  throw new FeedParseError("unrecognized feed format (no rss/feed/rdf root)");
}

// ── helpers ──────────────────────────────────────────────────────────────────

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Extract text from a fast-xml-parser node that may be a string, number, or {#text, __cdata, @_...}. */
function text(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === "string") return node || undefined;
  if (typeof node === "number") return String(node);
  if (typeof node === "object") {
    const rec = node as Record<string, unknown>;
    const cdata = rec["__cdata"];
    if (typeof cdata === "string" && cdata.length > 0) return cdata;
    const t = rec["#text"];
    if (typeof t === "string" && t.length > 0) return t;
    if (typeof t === "number") return String(t);
  }
  return undefined;
}

function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function absolutize(url: string | undefined, baseUrl?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return undefined;
  }
}

/** Strip tags and collapse whitespace for summaries that arrive as HTML. */
function stripHtml(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const out = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > 0 ? out : undefined;
}

// ── RSS 2.0 ─────────────────────────────────────────────────────────────────

function parseRss(rss: Record<string, unknown>, baseUrl?: string): ParsedFeed {
  const channel = (rss["channel"] ?? {}) as Record<string, unknown>;
  const items: FeedItem[] = [];
  for (const raw of asArray(channel["item"])) {
    const item = raw as Record<string, unknown>;
    const url = absolutize(text(item["link"]), baseUrl);
    const title = text(item["title"]);
    if (!url || !title) continue;
    const guidNode = item["guid"];
    items.push({
      url,
      title,
      summary: stripHtml(text(item["description"])),
      contentHtml: text(item["content:encoded"]),
      publishedAt: parseDate(text(item["pubDate"]) ?? text(item["dc:date"])),
      author: text(item["author"]) ?? text(item["dc:creator"]),
      guid: text(guidNode),
    });
  }
  return {
    title: text(channel["title"]),
    link: absolutize(text(channel["link"]), baseUrl),
    items,
  };
}

// ── RSS 1.0 / RDF ───────────────────────────────────────────────────────────

function parseRdf(rdf: Record<string, unknown>, baseUrl?: string): ParsedFeed {
  const channel = (rdf["channel"] ?? {}) as Record<string, unknown>;
  const items: FeedItem[] = [];
  for (const raw of asArray(rdf["item"])) {
    const item = raw as Record<string, unknown>;
    const url = absolutize(text(item["link"]), baseUrl);
    const title = text(item["title"]);
    if (!url || !title) continue;
    items.push({
      url,
      title,
      summary: stripHtml(text(item["description"])),
      publishedAt: parseDate(text(item["dc:date"])),
      author: text(item["dc:creator"]),
    });
  }
  return { title: text(channel["title"]), link: absolutize(text(channel["link"]), baseUrl), items };
}

// ── Atom ────────────────────────────────────────────────────────────────────

/** Pick the best href from atom link entries: rel="alternate" wins, then no-rel, then first. */
function atomLink(linkNode: unknown): string | undefined {
  const links = asArray(linkNode).map((l) => {
    if (typeof l === "string") return { href: l, rel: undefined };
    const rec = l as Record<string, unknown>;
    return {
      href: typeof rec["@_href"] === "string" ? (rec["@_href"] as string) : undefined,
      rel: typeof rec["@_rel"] === "string" ? (rec["@_rel"] as string) : undefined,
    };
  });
  const alternate = links.find((l) => l.rel === "alternate" && l.href);
  if (alternate) return alternate.href;
  const bare = links.find((l) => l.rel === undefined && l.href);
  if (bare) return bare.href;
  return links.find((l) => l.href)?.href;
}

function parseAtom(feed: Record<string, unknown>, baseUrl?: string): ParsedFeed {
  const items: FeedItem[] = [];
  for (const raw of asArray(feed["entry"])) {
    const entry = raw as Record<string, unknown>;
    const url = absolutize(atomLink(entry["link"]), baseUrl);
    const title = text(entry["title"]);
    if (!url || !title) continue;
    const authorNode = entry["author"];
    const author =
      typeof authorNode === "object" && authorNode !== null
        ? text((authorNode as Record<string, unknown>)["name"])
        : text(authorNode);
    items.push({
      url,
      title,
      summary: stripHtml(text(entry["summary"])),
      contentHtml: text(entry["content"]),
      publishedAt: parseDate(text(entry["published"]) ?? text(entry["updated"])),
      author,
      guid: text(entry["id"]),
    });
  }
  return {
    title: text(feed["title"]),
    link: absolutize(atomLink(feed["link"]), baseUrl),
    items,
  };
}

// ── JSON Feed ───────────────────────────────────────────────────────────────

function parseJsonFeed(body: string, baseUrl?: string): ParsedFeed {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(body) as Record<string, unknown>;
  } catch (err) {
    throw new FeedParseError(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const version = doc["version"];
  if (typeof version !== "string" || !version.includes("jsonfeed.org")) {
    throw new FeedParseError("JSON document is not a JSON Feed (missing jsonfeed.org version)");
  }
  const items: FeedItem[] = [];
  for (const raw of asArray(doc["items"] as unknown[])) {
    const item = raw as Record<string, unknown>;
    const url = absolutize(
      typeof item["url"] === "string" ? (item["url"] as string) : undefined,
      baseUrl,
    );
    const title = typeof item["title"] === "string" ? (item["title"] as string) : undefined;
    if (!url || !title) continue;
    const authors = asArray(item["authors"] as unknown[]) as Array<Record<string, unknown>>;
    items.push({
      url,
      title,
      summary:
        typeof item["summary"] === "string"
          ? (item["summary"] as string)
          : stripHtml(typeof item["content_text"] === "string" ? (item["content_text"] as string) : undefined),
      contentHtml: typeof item["content_html"] === "string" ? (item["content_html"] as string) : undefined,
      publishedAt: parseDate(typeof item["date_published"] === "string" ? (item["date_published"] as string) : undefined),
      author: typeof authors[0]?.["name"] === "string" ? (authors[0]["name"] as string) : undefined,
      guid: typeof item["id"] === "string" ? (item["id"] as string) : undefined,
    });
  }
  return {
    title: typeof doc["title"] === "string" ? (doc["title"] as string) : undefined,
    link: typeof doc["home_page_url"] === "string" ? (doc["home_page_url"] as string) : undefined,
    items,
  };
}
