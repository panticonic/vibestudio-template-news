/**
 * The channel method names shared by the News worker and its reader panel.
 *
 * Keep the names and the result schemas in the small feeds package rather
 * than duplicating wire contracts in a worker and browser bundle. The worker
 * uses them when building and validating its operation table; the panel uses
 * the same schemas when decoding participant results.
 */
export const NEWS_METHODS = {
  addFeed: "news_add_feed",
  importOpml: "news_import_opml",
  removeFeed: "news_remove_feed",
  setFeedEnabled: "setFeedEnabled",
  followTopic: "news_follow_topic",
  unfollowTopic: "news_unfollow_topic",
  setPreferences: "news_set_preferences",
  listArticles: "news_list_articles",
  publishBriefing: "news_publish_briefing",
  getBriefingHistory: "news_get_briefing_history",
  setSchedule: "setSchedule",
  setBriefingPaused: "setBriefingPaused",
  markRead: "markRead",
  markAllRead: "markAllRead",
  setSaved: "setSaved",
  searchArchive: "searchArchive",
  triage: "news_triage",
  triageNow: "triageNow",
  reactToStory: "reactToStory",
  refreshNow: "refreshNow",
  requestDeepDive: "requestDeepDive",
  startDeepDive: "startDeepDive",
  getOverview: "getOverview",
} as const;

export type NewsMethodName = (typeof NEWS_METHODS)[keyof typeof NEWS_METHODS];
