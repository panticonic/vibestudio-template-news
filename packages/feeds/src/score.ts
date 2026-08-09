/**
 * Deterministic article scoring and top-K ranking — Tier 1 of the two-tier
 * pipeline. The LLM only ever sees the top-K output of this ranking, so this
 * is where token cost is controlled.
 */

import { titleSimilarityKey } from "./canonical.js";

export interface ScoreInput {
  /** Epoch ms; falls back to fetchedAt when the feed omits dates. */
  publishedAt?: number;
  fetchedAt: number;
  /** Per-feed user weight, 1.0 = neutral. */
  feedWeight: number;
  now: number;
}

/** Recency half-life: a story loses half its score every 24h. */
const HALF_LIFE_HOURS = 24;

export function scoreArticle(input: ScoreInput): number {
  const ts = input.publishedAt ?? input.fetchedAt;
  const ageHours = Math.max(0, (input.now - ts) / 3_600_000);
  return input.feedWeight * Math.pow(0.5, ageHours / HALF_LIFE_HOURS);
}

export interface RankableArticle {
  articleId: string;
  title: string;
  score: number;
}

export interface RankTopKOptions {
  /** Demote (not drop) stories whose titles collide on the similarity key. */
  demoteSimilarTitles?: boolean;
  /** Multiplier applied to each subsequent member of a title cluster. */
  similarityPenalty?: number;
}

/**
 * Rank by score descending and take the top K. With title demotion on, the
 * highest-scored member of each lookalike cluster keeps its score and later
 * members are multiplied by `similarityPenalty` (default 0.3) before the
 * final cut, so one breaking story doesn't consume the whole briefing.
 */
export function rankTopK<T extends RankableArticle>(
  articles: readonly T[],
  k: number,
  options: RankTopKOptions = {},
): T[] {
  const demote = options.demoteSimilarTitles ?? true;
  const penalty = options.similarityPenalty ?? 0.3;

  const sorted = [...articles].sort((a, b) => b.score - a.score);
  if (!demote) return sorted.slice(0, k);

  const seenKeys = new Map<string, number>();
  const adjusted = sorted.map((article) => {
    const key = titleSimilarityKey(article.title);
    const priorHits = key.length > 0 ? (seenKeys.get(key) ?? 0) : 0;
    if (key.length > 0) seenKeys.set(key, priorHits + 1);
    return { article, effective: article.score * Math.pow(penalty, priorHits) };
  });
  adjusted.sort((a, b) => b.effective - a.effective);
  return adjusted.slice(0, k).map((entry) => entry.article);
}
