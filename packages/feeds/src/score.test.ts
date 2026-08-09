import { describe, expect, it } from "vitest";
import { rankTopK, scoreArticle } from "./score.js";

const HOUR = 3_600_000;
const NOW = 1_750_000_000_000;

describe("scoreArticle", () => {
  it("scores fresher articles higher", () => {
    const fresh = scoreArticle({ publishedAt: NOW - HOUR, fetchedAt: NOW, feedWeight: 1, now: NOW });
    const stale = scoreArticle({ publishedAt: NOW - 48 * HOUR, fetchedAt: NOW, feedWeight: 1, now: NOW });
    expect(fresh).toBeGreaterThan(stale);
  });

  it("halves the score every 24 hours", () => {
    const now1 = scoreArticle({ publishedAt: NOW, fetchedAt: NOW, feedWeight: 1, now: NOW });
    const day = scoreArticle({ publishedAt: NOW - 24 * HOUR, fetchedAt: NOW, feedWeight: 1, now: NOW });
    expect(day).toBeCloseTo(now1 / 2, 6);
  });

  it("scales linearly with feed weight", () => {
    const w1 = scoreArticle({ publishedAt: NOW, fetchedAt: NOW, feedWeight: 1, now: NOW });
    const w3 = scoreArticle({ publishedAt: NOW, fetchedAt: NOW, feedWeight: 3, now: NOW });
    expect(w3).toBeCloseTo(w1 * 3, 6);
  });

  it("falls back to fetchedAt when publishedAt is missing and clamps future dates", () => {
    const fallback = scoreArticle({ fetchedAt: NOW - HOUR, feedWeight: 1, now: NOW });
    expect(fallback).toBeLessThan(1);
    const future = scoreArticle({ publishedAt: NOW + 10 * HOUR, fetchedAt: NOW, feedWeight: 1, now: NOW });
    expect(future).toBe(1);
  });
});

describe("rankTopK", () => {
  const article = (articleId: string, title: string, score: number) => ({ articleId, title, score });

  it("returns the top K by score", () => {
    const ranked = rankTopK(
      [article("a", "Alpha", 0.2), article("b", "Beta", 0.9), article("c", "Gamma", 0.5)],
      2,
      { demoteSimilarTitles: false },
    );
    expect(ranked.map((a) => a.articleId)).toEqual(["b", "c"]);
  });

  it("demotes near-duplicate titles so one story does not fill the briefing", () => {
    const ranked = rankTopK(
      [
        article("a", "OpenAI releases GPT-6", 0.9),
        article("b", "GPT-6 released by OpenAI", 0.85),
        article("c", "Completely different story", 0.4),
      ],
      2,
    );
    // Without demotion the dupe (b, 0.85) would beat c (0.4); with it, c wins the second slot.
    expect(ranked.map((a) => a.articleId)).toEqual(["a", "c"]);
  });

  it("keeps the highest-scored member of a duplicate cluster undemoted", () => {
    const ranked = rankTopK(
      [article("a", "Same story here", 0.9), article("b", "same Story, here!", 0.8)],
      2,
    );
    expect(ranked[0]!.articleId).toBe("a");
  });
});
