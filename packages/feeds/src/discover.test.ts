import { describe, expect, it } from "vitest";
import { discoverFeedUrl } from "./discover.js";

describe("discoverFeedUrl", () => {
  it("finds an RSS autodiscovery link and absolutizes it", () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" title="Feed" href="/index.xml">
    </head><body>…</body></html>`;
    expect(discoverFeedUrl(html, "https://example.com/blog")).toBe("https://example.com/index.xml");
  });

  it("prefers RSS over Atom over JSON when several are advertised", () => {
    const html = `<head>
      <link rel="alternate" type="application/feed+json" href="https://x.com/feed.json">
      <link rel="alternate" type="application/atom+xml" href="https://x.com/atom.xml">
      <link rel="alternate" type="application/rss+xml" href="https://x.com/rss.xml">
    </head>`;
    expect(discoverFeedUrl(html, "https://x.com")).toBe("https://x.com/rss.xml");
  });

  it("ignores non-feed alternate links and returns null when none match", () => {
    const html = `<head>
      <link rel="alternate" hreflang="fr" href="/fr">
      <link rel="stylesheet" type="application/rss+xml" href="/not-a-feed.css">
    </head>`;
    expect(discoverFeedUrl(html, "https://example.com")).toBeNull();
  });
});
