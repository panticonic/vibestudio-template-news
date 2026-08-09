import { record } from "./types.js";
import { NEWS_METHODS } from "@workspace/feeds";

/**
 * Single source of truth for the news agent's surface: model tools,
 * onMethodCall methods, and the participant descriptor all derive from this
 * table (the gmail-agent operations pattern), so the three surfaces cannot
 * drift.
 */
export interface NewsHandlers {
  addFeed(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  importOpml(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  removeFeed(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  setFeedEnabled(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  followTopic(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  unfollowTopic(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  setPreferences(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  listArticles(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  publishBriefing(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  briefingHistory(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  setSchedule(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  setBriefingPaused(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  markRead(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  markAllRead(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  setSaved(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  reactToStory(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  searchArchive(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  triageStories(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  triageNow(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  refreshNow(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  requestDeepDive(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  startDeepDive(channelId: string, args: Record<string, unknown>): Promise<unknown>;
  getOverview(channelId: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface NewsOperationContext {
  handlers: NewsHandlers;
}

export type NewsOperationExposure = "tool" | "method";

export interface NewsOperation {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  exposure: NewsOperationExposure[];
  needsRecovery?: boolean;
  run: (ctx: NewsOperationContext, channelId: string, args: Record<string, unknown>) => unknown;
}

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false } as const;

export const NEWS_OPERATIONS: NewsOperation[] = [
  {
    name: NEWS_METHODS.addFeed,
    description:
      "Subscribe this channel to an RSS/Atom/JSON feed. The URL is validated by fetching and parsing it once; returns { feedId, title, itemCount }. weight (default 1.0) scales the feed's stories in ranking.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1 },
        weight: { type: "number", minimum: 0.1, maximum: 10 },
      },
      required: ["url"],
      additionalProperties: false,
    },
    exposure: ["tool", "method"],
    run: (ctx, channelId, args) => ctx.handlers.addFeed(channelId, args),
  },
  {
    name: NEWS_METHODS.importOpml,
    description:
      "Bulk-import feed subscriptions from an OPML document (e.g. an export from another reader). Validates and adds each feed; returns { imported, failed, total }.",
    schema: {
      type: "object",
      properties: { opml: { type: "string", minLength: 1 } },
      required: ["opml"],
      additionalProperties: false,
    },
    exposure: ["tool", "method"],
    run: (ctx, channelId, args) => ctx.handlers.importOpml(channelId, args),
  },
  {
    name: NEWS_METHODS.removeFeed,
    description: "Unsubscribe a feed by feedId or url. Already-ingested articles are kept.",
    schema: {
      type: "object",
      properties: { feedId: { type: "string" }, url: { type: "string" } },
      additionalProperties: false,
    },
    exposure: ["tool", "method"],
    run: (ctx, channelId, args) => ctx.handlers.removeFeed(channelId, args),
  },
  {
    name: NEWS_METHODS.setFeedEnabled,
    description: "Pause or resume polling a feed without forgetting its configuration.",
    schema: {
      type: "object",
      properties: { feedId: { type: "string", minLength: 1 }, enabled: { type: "boolean" } },
      required: ["feedId", "enabled"],
      additionalProperties: false,
    },
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.setFeedEnabled(channelId, args),
  },
  {
    name: NEWS_METHODS.followTopic,
    description:
      "Follow a topic: each briefing run web-searches it for fresh stories. Use the user's phrasing ('Rust async runtimes', not just 'Rust').",
    schema: {
      type: "object",
      properties: {
        topic: { type: "string", minLength: 1 },
        weight: { type: "number", minimum: 0.1, maximum: 10 },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    exposure: ["tool", "method"],
    run: (ctx, channelId, args) => ctx.handlers.followTopic(channelId, args),
  },
  {
    name: NEWS_METHODS.unfollowTopic,
    description: "Stop following a topic.",
    schema: {
      type: "object",
      properties: { topic: { type: "string", minLength: 1 } },
      required: ["topic"],
      additionalProperties: false,
    },
    exposure: ["tool", "method"],
    run: (ctx, channelId, args) => ctx.handlers.unfollowTopic(channelId, args),
  },
  {
    name: NEWS_METHODS.setPreferences,
    description:
      "Persist the user's standing curation preferences as natural language in their own words. Replaces the previous text; fold prior preferences in rather than dropping them.",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    exposure: ["tool", "method"],
    run: (ctx, channelId, args) => ctx.handlers.setPreferences(channelId, args),
  },
  {
    name: NEWS_METHODS.listArticles,
    description:
      "List ingested articles, newest first. Returns { count, articles: [{ articleId, title, url, source, blurb, publishedAt, briefedIn, read }] }. Filters: unbriefedOnly, sinceMs (epoch), limit (default 30).",
    schema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 200 },
        unbriefedOnly: { type: "boolean" },
        savedOnly: { type: "boolean" },
        triagedOnly: { type: "boolean" },
        untriagedOnly: { type: "boolean" },
        sinceMs: { type: "number" },
        cursor: { type: "string" },
      },
      additionalProperties: false,
    },
    exposure: ["tool", "method"],
    run: (ctx, channelId, args) => ctx.handlers.listArticles(channelId, args),
  },
  {
    name: NEWS_METHODS.publishBriefing,
    description:
      "Finalize the current briefing run: writes the TLDR and per-story blurbs to the briefing card, marks kept stories as briefed, and records the briefing for day-over-day continuity. Call exactly once per briefing run. Search stories must be canonical http(s) URLs; duplicates and entries beyond the first 10 are ignored. Pass sourcesRead = how many concrete sources you actually fetched/read, for the reader's trust signal.",
    schema: {
      type: "object",
      properties: {
        briefingId: { type: "string", minLength: 1 },
        tldr: { type: "string", minLength: 1 },
        storyBlurbs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              articleId: { type: "string", minLength: 1 },
              blurb: { type: "string" },
            },
            required: ["articleId"],
            additionalProperties: false,
          },
        },
        searchStories: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string", minLength: 1 },
              title: { type: "string", minLength: 1 },
              source: { type: "string" },
              blurb: { type: "string" },
            },
            required: ["url", "title"],
            additionalProperties: false,
          },
        },
        droppedArticleIds: { type: "array", items: { type: "string" } },
        sourcesRead: { type: "number", minimum: 0 },
      },
      required: ["briefingId", "tldr"],
      additionalProperties: false,
    },
    exposure: ["tool"],
    run: (ctx, channelId, args) => ctx.handlers.publishBriefing(channelId, args),
  },
  {
    name: NEWS_METHODS.getBriefingHistory,
    description: "Previous briefings with their TLDRs, newest first. limit defaults to 5.",
    schema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
    exposure: ["tool", "method"],
    run: (ctx, channelId, args) => ctx.handlers.briefingHistory(channelId, args),
  },
  {
    name: NEWS_METHODS.setSchedule,
    description:
      "Reconfigure cadence: pollIntervalMs, briefingIntervalMs, and/or briefingAt ('HH:MM' local anchor for daily briefings; pass null to unanchor).",
    schema: {
      type: "object",
      properties: {
        pollIntervalMs: { type: "number", minimum: 60_000 },
        briefingIntervalMs: { type: "number", minimum: 600_000 },
        briefingAt: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.setSchedule(channelId, args),
  },
  {
    name: NEWS_METHODS.setBriefingPaused,
    description:
      "Pause or resume scheduled briefings ('vacation mode'). While paused, feed polling continues and manual 'Brief me now' still works.",
    schema: {
      type: "object",
      properties: { paused: { type: "boolean" } },
      required: ["paused"],
      additionalProperties: false,
    },
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.setBriefingPaused(channelId, args),
  },
  {
    name: NEWS_METHODS.markRead,
    description: "Mark articles read so ranking skips them.",
    schema: {
      type: "object",
      properties: {
        articleIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 },
      },
      required: ["articleIds"],
      additionalProperties: false,
    },
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.markRead(channelId, args),
  },
  {
    name: NEWS_METHODS.markAllRead,
    description:
      "Mark every currently curated article read. This is a semantic bulk operation and is not limited to one reader page.",
    schema: NO_ARGS,
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.markAllRead(channelId, args),
  },
  {
    name: NEWS_METHODS.setSaved,
    description: "Bookmark (or un-bookmark) an article for the reader's Saved view.",
    schema: {
      type: "object",
      properties: { articleId: { type: "string", minLength: 1 }, saved: { type: "boolean" } },
      required: ["articleId", "saved"],
      additionalProperties: false,
    },
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.setSaved(channelId, args),
  },
  {
    name: NEWS_METHODS.searchArchive,
    description:
      "Search ingested articles and past briefing TLDRs by keyword. Returns { query, articles, briefings }.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.searchArchive(channelId, args),
  },
  {
    name: NEWS_METHODS.triage,
    description:
      "Triage a batch of newly-fetched stories for the reader feed: categorize, cluster same-event coverage, one-line summarize, and drop noise. Call once per triage turn with one item per story. The reader shows a story only after it's triaged.",
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              articleId: { type: "string", minLength: 1 },
              category: { type: "string" },
              clusterKey: { type: "string" },
              blurb: { type: "string" },
              keep: { type: "boolean" },
            },
            required: ["articleId"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    exposure: ["tool"],
    run: (ctx, channelId, args) => ctx.handlers.triageStories(channelId, args),
  },
  {
    name: NEWS_METHODS.triageNow,
    description:
      "Trigger an on-demand triage pass over any un-triaged stories (the reader calls this when it opens with a backlog).",
    schema: NO_ARGS,
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.triageNow(channelId, args),
  },
  {
    name: NEWS_METHODS.reactToStory,
    description:
      "Record a reader's tap on a story so curation learns. reaction: 'more' (surface more like it), 'less' (fewer like it; marks it read), or 'mute_source' (avoid this source and disable its feed). Signals are folded into every future briefing.",
    schema: {
      type: "object",
      properties: {
        articleId: { type: "string", minLength: 1 },
        reaction: { enum: ["more", "less", "mute_source"] },
      },
      required: ["articleId", "reaction"],
      additionalProperties: false,
    },
    exposure: ["method"],
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.reactToStory(channelId, args),
  },
  {
    name: NEWS_METHODS.refreshNow,
    description:
      "Force an immediate feed poll; pass briefing: true to also run a briefing right after.",
    schema: {
      type: "object",
      properties: { briefing: { type: "boolean" } },
      additionalProperties: false,
    },
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.refreshNow(channelId, args),
  },
  {
    name: NEWS_METHODS.requestDeepDive,
    description:
      "Request a deep-dive on a story: appends a durable news.deepdive.requested fact the panel turns into a forked analysis channel.",
    schema: {
      type: "object",
      properties: { articleId: { type: "string", minLength: 1 } },
      required: ["articleId"],
      additionalProperties: false,
    },
    exposure: ["method"],
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.requestDeepDive(channelId, args),
  },
  {
    name: NEWS_METHODS.startDeepDive,
    description:
      "Initialize a freshly-forked news channel as an analyst thread and seed its opening analysis turn.",
    schema: {
      type: "object",
      properties: {
        articleId: { type: "string" },
        url: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        source: { type: "string" },
        briefingTldr: { type: "string" },
      },
      required: ["url", "title"],
      additionalProperties: false,
    },
    exposure: ["method"],
    needsRecovery: true,
    run: (ctx, channelId, args) => ctx.handlers.startDeepDive(channelId, args),
  },
  {
    name: NEWS_METHODS.getOverview,
    description: "Snapshot of feeds, topics, schedule, article counts, and last briefing.",
    schema: NO_ARGS,
    exposure: ["method"],
    run: (ctx, channelId, args) => ctx.handlers.getOverview(channelId, record(args)),
  },
];

export function buildOperationIndex(): Map<string, NewsOperation> {
  const index = new Map<string, NewsOperation>();
  for (const op of NEWS_OPERATIONS) {
    if (index.has(op.name)) throw new Error(`duplicate news operation: ${op.name}`);
    index.set(op.name, op);
  }
  return index;
}

export function toolOperations(): NewsOperation[] {
  return NEWS_OPERATIONS.filter((op) => op.exposure.includes("tool"));
}

/** Methods advertised on the participant descriptor (UI + agent surfaces). */
export function advertisedMethods(): Array<{ name: string; description: string }> {
  return NEWS_OPERATIONS.filter((op) => op.exposure.includes("method")).map((op) => ({
    name: op.name,
    description: op.description.split(". ")[0]!,
  }));
}
