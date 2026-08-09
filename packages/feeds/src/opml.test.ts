import { describe, expect, it } from "vitest";
import { parseOpml } from "./opml.js";

describe("parseOpml", () => {
  it("extracts feeds from flat and nested outlines, de-duped", () => {
    const opml = `<?xml version="1.0"?>
      <opml version="2.0"><body>
        <outline text="HN" title="Hacker News" xmlUrl="https://hnrss.org/frontpage" />
        <outline text="Tech">
          <outline text="The Verge" xmlUrl="https://www.theverge.com/rss/index.xml" />
          <outline text="dup" xmlUrl="https://hnrss.org/frontpage" />
        </outline>
        <outline text="no-feed-here" />
      </body></opml>`;
    const feeds = parseOpml(opml);
    expect(feeds).toEqual([
      { url: "https://hnrss.org/frontpage", title: "Hacker News" },
      { url: "https://www.theverge.com/rss/index.xml", title: "The Verge" },
    ]);
  });

  it("returns [] for empty or malformed input", () => {
    expect(parseOpml("")).toEqual([]);
    expect(parseOpml("not xml at all <<<")).toEqual([]);
    expect(parseOpml("<opml><body></body></opml>")).toEqual([]);
  });
});
