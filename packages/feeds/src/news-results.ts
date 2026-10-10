import { z } from "zod";
import type { NewsSetupCardState } from "./card-types.js";

const article = z.object({
  articleId: z.string(),
  title: z.string(),
  url: z.string(),
  source: z.string(),
  origin: z.enum(["feed", "search"]),
  blurb: z.string().optional(),
  publishedAt: z.string().optional(),
  fetchedAt: z.number().optional(),
  category: z.string().optional(),
  clusterKey: z.string().optional(),
  briefedIn: z.string().optional(),
  read: z.boolean(),
  saved: z.boolean().optional(),
});

const briefing = z.object({
  briefingId: z.string(),
  createdAt: z.string(),
  status: z.string(),
  tldr: z.string().optional(),
  sourcesRead: z.number().optional(),
  lastError: z.string().optional(),
});

export const newsArticleResultSchema = article;
export const newsBriefingResultSchema = briefing;
export const newsOverviewResultSchema = z.object({
  setup: z
    .object({
      status: z.enum(["needs-user-preferences", "configured"]),
      feeds: z.array(
        z.object({
          feedId: z.string(),
          url: z.string(),
          title: z.string().optional(),
          weight: z.number(),
          enabled: z.boolean(),
          lastFetchAt: z.string().optional(),
          lastStatus: z.string().optional(),
          failCount: z.number(),
        }),
      ),
      followedTopics: z.array(
        z.object({
          topic: z.string(),
          weight: z.number(),
          enabled: z.boolean(),
        }),
      ),
      scheduleSummary: z.string(),
      pollIntervalMs: z.number().optional(),
      briefingIntervalMs: z.number().optional(),
      briefingAtMinutes: z.number().optional(),
      timezone: z.string().optional(),
      briefingPaused: z.boolean().optional(),
      preferencesText: z.string().optional(),
      lastRunAt: z.string().optional(),
      lastError: z.string().optional(),
    })
    .passthrough()
    .transform((value): NewsSetupCardState => value),
  articleCount: z.number(),
  unbriefedCount: z.number(),
  untriagedCount: z.number(),
  lastBriefingId: z.string().optional(),
});
export const newsArticlePageResultSchema = z.object({
  count: z.number(),
  articles: z.array(article),
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),
});
export const newsBriefingHistoryResultSchema = z.object({
  briefings: z.array(briefing),
});
export const newsArchiveSearchResultSchema = z.object({
  query: z.string(),
  articles: z.array(article),
  briefings: z.array(briefing),
});

export type NewsArticleResult = z.infer<typeof newsArticleResultSchema>;
export type NewsBriefingResult = z.infer<typeof newsBriefingResultSchema>;
export type NewsOverviewResult = z.infer<typeof newsOverviewResultSchema>;
export type NewsArticlePageResult = z.infer<typeof newsArticlePageResultSchema>;
export type NewsBriefingHistoryResult = z.infer<
  typeof newsBriefingHistoryResultSchema
>;
export type NewsArchiveSearchResult = z.infer<
  typeof newsArchiveSearchResultSchema
>;
