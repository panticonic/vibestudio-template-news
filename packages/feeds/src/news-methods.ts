/**
 * The channel method names shared by the News worker and its reader panel.
 *
 * Keep this contract in the small feeds package rather than duplicating
 * string literals in a worker and a browser bundle. The worker uses it when
 * building its operation table; the panel uses it when making calls.
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
