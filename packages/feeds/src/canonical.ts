/**
 * URL canonicalization and identity for cross-feed article dedup. The same
 * story arrives from different feeds with different tracking params, hosts
 * casing, and trailing slashes; canonicalization collapses those so the
 * sha256 of the canonical URL is a stable article id.
 */

/** Query params that never change page identity. */
const TRACKING_PARAM_RE =
  /^(utm_[a-z]+|ref|ref_src|fbclid|gclid|msclkid|mc_cid|mc_eid|igshid|si|source|cmpid|ocid|smid)$/i;

export function canonicalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "http:" ? "https:" : parsed.protocol;
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  if (
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "http:" && parsed.port === "80")
  ) {
    parsed.port = "";
  }

  const keep: Array<[string, string]> = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    if (!TRACKING_PARAM_RE.test(key)) keep.push([key, value]);
  }
  keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  parsed.search = "";
  for (const [key, value] of keep) parsed.searchParams.append(key, value);

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}

/** Stable article id: sha256 hex of the canonical URL. Web Crypto, workerd-safe. */
export async function articleId(url: string): Promise<string> {
  const canonical = canonicalizeUrl(url);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Near-duplicate key for titles: lowercase, strip punctuation, drop stopwords,
 * sort the remaining tokens. Two outlets covering the same story usually
 * collide on this key; it is intentionally coarse — used to *demote* lookalike
 * stories in ranking, never to delete articles.
 */
const TITLE_STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "and", "or", "is",
  "are", "was", "were", "with", "by", "from", "as", "its", "it", "this",
  "that", "after", "over", "into", "amid", "how", "why", "what",
]);

/** Crude suffix stemming so "releases"/"released"/"releasing" collide. */
function stem(token: string): string {
  if (token.length <= 4) return token;
  return token.replace(/(?:ing|ed|es|s)$/, "");
}

export function titleSimilarityKey(title: string): string {
  const tokens = title
    .toLowerCase()
    .replace(/['’‘"“”]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !TITLE_STOPWORDS.has(t))
    .map(stem);
  return [...new Set(tokens)].sort().join(" ");
}
