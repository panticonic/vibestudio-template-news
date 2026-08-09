import { describe, expect, it } from "vitest";
import { articleId, canonicalizeUrl, titleSimilarityKey } from "./canonical.js";

describe("canonicalizeUrl", () => {
  const cases: Array<[string, string]> = [
    ["http://www.Example.com/Story/", "https://example.com/Story"],
    ["https://example.com/a?utm_source=x&utm_medium=y&id=5", "https://example.com/a?id=5"],
    ["https://example.com/a?b=2&a=1", "https://example.com/a?a=1&b=2"],
    ["https://example.com/a#section", "https://example.com/a"],
    ["https://example.com/a?fbclid=abc&gclid=def&ref=tw", "https://example.com/a"],
    ["https://example.com:443/a", "https://example.com/a"],
    ["https://example.com/", "https://example.com/"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      expect(canonicalizeUrl(input)).toBe(expected);
    });
  }

  it("collapses tracking-param and www variants to the same canonical form", () => {
    const a = canonicalizeUrl("https://www.example.com/story?utm_campaign=rss");
    const b = canonicalizeUrl("http://example.com/story/");
    expect(a).toBe(b);
  });
});

describe("articleId", () => {
  it("is a stable sha256 hex of the canonical URL", async () => {
    const a = await articleId("https://www.example.com/story?utm_source=feed");
    const b = await articleId("http://example.com/story/");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different pages", async () => {
    expect(await articleId("https://example.com/a")).not.toBe(await articleId("https://example.com/b"));
  });
});

describe("titleSimilarityKey", () => {
  it("collides for retitled versions of the same story", () => {
    const a = titleSimilarityKey("OpenAI Releases the GPT-6 Model");
    const b = titleSimilarityKey("GPT-6 model released by OpenAI");
    expect(a).toBe(b);
  });

  it("differs for unrelated stories", () => {
    expect(titleSimilarityKey("Apple ships new laptop")).not.toBe(
      titleSimilarityKey("SpaceX launches new rocket"),
    );
  });

  it("ignores punctuation and case", () => {
    expect(titleSimilarityKey("Hello, World!")).toBe(titleSimilarityKey("hello world"));
  });
});
