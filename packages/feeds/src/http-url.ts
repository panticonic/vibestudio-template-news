/**
 * The one URL rule for everything a feed source hands us. Feed documents,
 * autodiscovery pages, OPML files and agent citations are untrusted input, and
 * their URLs are fetched, stored as article identities and opened by the
 * reader. Only web URLs qualify: `javascript:`, `data:`, `file:` and custom
 * protocol handlers are refused rather than resolved. Hosts are not judged —
 * self-hosted feeds on localhost or the LAN are ordinary http(s) feeds.
 */

/**
 * Resolve `raw` (relative to `baseUrl` when given) and return the absolute URL
 * only when its scheme is http or https; otherwise undefined.
 */
export function resolveHttpUrl(raw: string | undefined, baseUrl?: string): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw, baseUrl);
  } catch {
    return undefined;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
}
