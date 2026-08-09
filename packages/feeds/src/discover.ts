/**
 * RSS/Atom autodiscovery: given an HTML page, find the feed it advertises via
 * `<link rel="alternate" type="application/rss+xml" href="…">`. Lets a user paste
 * a normal site URL (e.g. "arstechnica.com") instead of hunting for the feed URL.
 *
 * Deliberately a tolerant lexical scan, not a DOM parse — pages in the wild are
 * rarely well-formed XML, and we only need the autodiscovery <link> tags.
 */

const FEED_LINK_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
  "application/json",
]);

const LINK_TAG_RE = /<link\b[^>]*>/gi;
const REL_ALTERNATE_RE = /\brel\s*=\s*["']?[^"'>]*\balternate\b/i;
const TYPE_RE = /\btype\s*=\s*["']([^"']+)["']/i;
const HREF_RE = /\bhref\s*=\s*["']([^"']+)["']/i;

/**
 * Return the best feed URL advertised by an HTML page (absolutized against
 * `baseUrl`), or null if the page advertises none. Prefers RSS, then Atom,
 * then JSON feeds.
 */
export function discoverFeedUrl(html: string, baseUrl: string): string | null {
  const candidates: Array<{ href: string; type: string }> = [];
  // Only scan the <head> when we can find it cheaply; fall back to the whole
  // document. Autodiscovery links are required to be in <head> anyway.
  const headEnd = html.search(/<\/head>/i);
  const scope = headEnd >= 0 ? html.slice(0, headEnd) : html;

  let match: RegExpExecArray | null;
  LINK_TAG_RE.lastIndex = 0;
  while ((match = LINK_TAG_RE.exec(scope)) !== null) {
    const tag = match[0];
    if (!REL_ALTERNATE_RE.test(tag)) continue;
    const type = (TYPE_RE.exec(tag)?.[1] ?? "").toLowerCase().trim();
    if (!FEED_LINK_TYPES.has(type)) continue;
    const href = HREF_RE.exec(tag)?.[1];
    if (href) candidates.push({ href, type });
  }
  if (candidates.length === 0) return null;

  const pick =
    candidates.find((c) => c.type.includes("rss")) ??
    candidates.find((c) => c.type.includes("atom")) ??
    candidates[0]!;
  try {
    return new URL(pick.href, baseUrl).toString();
  } catch {
    return null;
  }
}
