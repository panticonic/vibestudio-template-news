/**
 * Minimal OPML parser — extracts feed subscriptions (outline elements carrying
 * an `xmlUrl`) from an OPML document, walking nested outline groups. Used for
 * bulk feed import. Deliberately lenient: returns [] rather than throwing on
 * malformed input so a paste box degrades gracefully.
 */
import { XMLParser } from "fast-xml-parser";

export interface OpmlFeed {
  title?: string;
  url: string;
}

export function parseOpml(body: string): OpmlFeed[] {
  const trimmed = (body ?? "").trim();
  if (!trimmed) return [];
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
  });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }

  const feeds: OpmlFeed[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node) return;
    for (const item of Array.isArray(node) ? node : [node]) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const rawUrl = rec["@_xmlUrl"] ?? rec["@_xmlurl"] ?? rec["@_xmlURL"];
      if (typeof rawUrl === "string") {
        const url = rawUrl.trim();
        if (url && !seen.has(url)) {
          seen.add(url);
          const title = rec["@_title"] ?? rec["@_text"];
          feeds.push({ url, ...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}) });
        }
      }
      if (rec["outline"]) walk(rec["outline"]); // nested groups
    }
  };

  const opml = (doc["opml"] ?? doc) as Record<string, unknown>;
  const bodyNode = (opml["body"] ?? opml) as Record<string, unknown>;
  walk(bodyNode["outline"]);
  return feeds;
}
