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

  it("skips malformed preferred URLs while retaining format preference among usable feeds", () => {
    const html = `<head>
      <link rel="alternate" type="application/rss+xml" href="https://[broken">
      <link rel="alternate" type="application/feed+json" href="/feed.json">
      <link rel="alternate" type="application/atom+xml" href="/atom.xml">
    </head>`;
    expect(discoverFeedUrl(html, "https://example.com")).toBe("https://example.com/atom.xml");
  });

  it("never yields a non-web feed URL, falling through to a usable http(s) advertisement", () => {
    const html = `<head>
      <link rel="alternate" type="application/rss+xml" href="file:///etc/passwd">
      <link rel="alternate" type="application/rss+xml" href="data:application/rss+xml,&lt;rss/&gt;">
      <link rel="alternate" type="application/atom+xml" href="javascript:alert(1)">
      <link rel="alternate" type="application/feed+json" href="http://192.168.1.20/feed.json">
    </head>`;
    expect(discoverFeedUrl(html, "http://192.168.1.20/")).toBe("http://192.168.1.20/feed.json");
    expect(
      discoverFeedUrl(
        `<head><link rel="alternate" type="application/rss+xml" href="feed://example.com/rss"></head>`,
        "https://example.com"
      )
    ).toBeNull();
  });

  it("ignores non-feed alternate links and returns null when none match", () => {
    const html = `<head>
      <link rel="alternate" hreflang="fr" href="/fr">
      <link rel="stylesheet" type="application/rss+xml" href="/not-a-feed.css">
    </head>`;
    expect(discoverFeedUrl(html, "https://example.com")).toBeNull();
  });
});
