import { describe, expect, it } from "vitest";
import { FeedParseError, parseFeed } from "./parse.js";

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example News</title>
    <link>https://example.com</link>
    <item>
      <title>First story</title>
      <link>https://example.com/first</link>
      <description><![CDATA[<p>An <b>HTML</b> summary &amp; more</p>]]></description>
      <content:encoded><![CDATA[<article>Full body</article>]]></content:encoded>
      <pubDate>Wed, 11 Jun 2025 09:30:00 GMT</pubDate>
      <dc:creator>Jane Doe</dc:creator>
      <guid isPermaLink="false">tag:example.com,2025:first</guid>
    </item>
    <item>
      <title>Relative link story</title>
      <link>/second</link>
    </item>
    <item>
      <title>No link — skipped</title>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <link rel="self" href="https://example.org/feed.xml"/>
  <link rel="alternate" href="https://example.org/"/>
  <entry>
    <title>Atom entry</title>
    <link rel="alternate" href="https://example.org/posts/1"/>
    <id>urn:uuid:1</id>
    <published>2025-06-10T12:00:00Z</published>
    <summary>Short summary</summary>
    <content type="html">&lt;p&gt;body&lt;/p&gt;</content>
    <author><name>Alice</name></author>
  </entry>
  <entry>
    <title>Single bare link</title>
    <link href="https://example.org/posts/2"/>
    <updated>2025-06-09T08:00:00Z</updated>
  </entry>
</feed>`;

const JSON_FEED = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  title: "JSON Example",
  home_page_url: "https://example.net",
  items: [
    {
      id: "jf-1",
      url: "https://example.net/a",
      title: "JSON item",
      summary: "json summary",
      content_html: "<p>html</p>",
      date_published: "2025-06-11T00:00:00Z",
      authors: [{ name: "Bob" }],
    },
    { id: "jf-2", title: "missing url — skipped" },
  ],
});

describe("parseFeed", () => {
  it("parses RSS 2.0 with CDATA, content:encoded, and dc:creator", () => {
    const feed = parseFeed(RSS2, "application/rss+xml", "https://example.com/feed");
    expect(feed.title).toBe("Example News");
    expect(feed.items).toHaveLength(2);
    const first = feed.items[0]!;
    expect(first.url).toBe("https://example.com/first");
    expect(first.title).toBe("First story");
    expect(first.summary).toBe("An HTML summary & more");
    expect(first.contentHtml).toBe("<article>Full body</article>");
    expect(first.publishedAt).toBe(Date.parse("Wed, 11 Jun 2025 09:30:00 GMT"));
    expect(first.author).toBe("Jane Doe");
    expect(first.guid).toBe("tag:example.com,2025:first");
  });

  it("absolutizes relative item links against the feed URL", () => {
    const feed = parseFeed(RSS2, undefined, "https://example.com/feed");
    expect(feed.items[1]!.url).toBe("https://example.com/second");
  });

  it("parses Atom, preferring rel=alternate links", () => {
    const feed = parseFeed(ATOM);
    expect(feed.title).toBe("Atom Example");
    expect(feed.link).toBe("https://example.org/");
    expect(feed.items).toHaveLength(2);
    const entry = feed.items[0]!;
    expect(entry.url).toBe("https://example.org/posts/1");
    expect(entry.author).toBe("Alice");
    expect(entry.publishedAt).toBe(Date.parse("2025-06-10T12:00:00Z"));
    // entry without <published> falls back to <updated>
    expect(feed.items[1]!.publishedAt).toBe(Date.parse("2025-06-09T08:00:00Z"));
  });

  it("parses JSON Feed", () => {
    const feed = parseFeed(JSON_FEED, "application/feed+json");
    expect(feed.title).toBe("JSON Example");
    expect(feed.items).toHaveLength(1);
    const item = feed.items[0]!;
    expect(item.url).toBe("https://example.net/a");
    expect(item.author).toBe("Bob");
    expect(item.guid).toBe("jf-1");
  });

  it("sniffs JSON feeds without a content-type hint", () => {
    const feed = parseFeed(JSON_FEED);
    expect(feed.items).toHaveLength(1);
  });

  it("tolerates items missing optional fields", () => {
    const feed = parseFeed(RSS2);
    const bare = feed.items.find((i) => i.title === "Relative link story");
    // No baseUrl: relative link can't absolutize, item is dropped
    expect(bare).toBeUndefined();
  });

  it("throws FeedParseError on empty body", () => {
    expect(() => parseFeed("   ")).toThrow(FeedParseError);
  });

  it("throws FeedParseError on non-feed XML", () => {
    expect(() => parseFeed("<html><body>hi</body></html>")).toThrow(FeedParseError);
  });

  it("throws FeedParseError on JSON that is not a JSON Feed", () => {
    expect(() => parseFeed('{"hello": "world"}')).toThrow(FeedParseError);
  });
});
