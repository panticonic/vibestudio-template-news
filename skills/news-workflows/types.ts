import type { Untrusted } from "./newsTrust.js";

export type NewsFinding = { code: string; evidenceIds: string[] };
export type NewsReview = {
  status: "ready" | "attention" | "waiting" | "blocked";
  findings: NewsFinding[];
};

export type NewsReaderPage = {
  id: string;
  requestedCursor: string | null;
  nextCursor: string | null;
  hasMore: boolean;
  articleIds: string[];
  briefingIds?: string[];
};
export type NewsReaderEvidence = {
  kind: "reader";
  goal: string;
  view: "inbox" | "saved" | "archive" | "backlog";
  overview: {
    id: string;
    setup: "needs-user-preferences" | "configured";
    articleCount: number;
    untriagedCount: number;
    enabledFeeds: number;
    failedFeeds: number;
  };
  activity: "idle" | "loading" | "retryable-error";
  pages: NewsReaderPage[];
};

export type NewsTriageArticle = {
  id: string;
  headline: Untrusted<string>;
  text: Untrusted<string>;
  source: string;
};
export type NewsTriageEvidence = {
  kind: "triage";
  goal: string;
  articles: NewsTriageArticle[];
  categories: string[];
  followedTopics: string[];
  mutedSources: string[];
};

export type NewsClaim = { id: string; text: Untrusted<string> };
export type NewsSource = {
  id: string;
  articleId: string;
  url: string;
  type: "primary" | "syndication" | "secondary" | "listing";
  read: boolean;
  supports: string[];
};
export type NewsBriefingEvidence = {
  kind: "briefing";
  goal: string;
  briefingId: string;
  phase: "collecting" | "summarizing" | "ready" | "error";
  declaredSourcesRead: number;
  sources: NewsSource[];
  claims: NewsClaim[];
  previousClaimIds: string[];
  mutedArticleIds: string[];
  focus: "publication" | "credibility" | "continuity" | "digest";
};

export type NewsDeepDiveEvidence = {
  kind: "deep-dive";
  goal: string;
  request: { id: string; articleId: string; curatorChannel: string };
  fork: {
    id: string;
    analystChannel: string;
    originalChannel: string;
    mode: "analyst" | "curator";
  } | null;
  start: {
    id: string;
    channel: string;
    articleId: string;
    accepted: boolean;
  } | null;
  sources: NewsSource[];
  disputedClaims: { id: string; sourceIds: string[] }[];
  briefingId: string | null;
};

export type NewsScheduleEvidence = {
  kind: "schedule";
  goal: string;
  owner: { id: string; mode: "curator" | "analyst"; paused: boolean };
  poll: { id: string; intervalMs: number } | null;
  briefing: {
    id: string;
    kind: "interval" | "daily";
    intervalMs: number | null;
    at: string | null;
    timezone: string | null;
  } | null;
  intent:
    | { kind: "poll"; intervalMs: number }
    | { kind: "interval"; intervalMs: number }
    | { kind: "daily"; at: string; timezone: string }
    | { kind: "pause" }
    | { kind: "resume" }
    | { kind: "manual" };
};

export type NewsReviewRequest =
  | NewsReaderEvidence
  | NewsTriageEvidence
  | NewsBriefingEvidence
  | NewsDeepDiveEvidence
  | NewsScheduleEvidence;

export type NewsLiveCheck =
  | { kind: "reader"; view: "inbox" | "saved" | "backlog" }
  | { kind: "reader"; view: "archive"; query: string }
  | { kind: "schedule"; intent: NewsScheduleEvidence["intent"] };
export type NewsGoalChange =
  | { kind: "poll"; intervalMs: number }
  | { kind: "interval"; intervalMs: number }
  | { kind: "daily"; at: string; timezone: string }
  | { kind: "pause" }
  | { kind: "resume" };
export type NewsCadenceChange = NewsGoalChange | null;
export type NewsLiveRequest = {
  kind: "live";
  goal: string;
  checks: NewsLiveCheck[];
  changeIndex?: number;
};
export type NewsWorkflowRequest = NewsReviewRequest | NewsLiveRequest;

export type NewsCadenceSnapshot = {
  owner: NewsScheduleEvidence["owner"];
  poll: NewsScheduleEvidence["poll"];
  briefing: NewsScheduleEvidence["briefing"];
};
export type NewsReaderSelection =
  | { kind: "inbox" | "saved" | "backlog" }
  | { kind: "archive"; query: string };
export type NewsScheduleIntent = NewsScheduleEvidence["intent"];
export type NewsGoalPlan = {
  readers: NewsReaderSelection[];
  changes: NewsScheduleIntent[];
  checks: NewsScheduleIntent[];
};
export type NewsGoalApply = {
  status: "applied" | "state-changed" | "unchanged" | "denied";
  cadence: NewsCadenceSnapshot;
};
export type NewsGoalScheduleFinding = {
  intent: NewsScheduleIntent;
  review: NewsReview;
};
export type NewsGoalCadenceResult = {
  cadence: NewsCadenceSnapshot;
  blocked: boolean;
  changed: boolean;
  findings: NewsGoalScheduleFinding[];
};
export type NewsUserGoalReport = {
  status: "reviewed" | "changed" | "blocked";
  cadence: NewsCadenceSnapshot;
  readers: { selection: NewsReaderSelection; review: NewsReview }[];
  schedule: NewsGoalScheduleFinding[];
};
