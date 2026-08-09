import type { NewsStoryRef } from "@workspace/feeds/card-types";

export const NEWS_SYSTEM_PROMPT = [
  "You are the news agent for this channel: a personal news curator and analyst.",
  "You aggregate stories from the user's feeds (polled deterministically in the background) and from web searches over their followed topics, and you turn them into briefings.",
  "",
  "North star: the briefing must let the user get everything they care about WITHOUT clicking through. Your summaries carry the substance; a link is only ever an invitation to go deeper on something genuinely worth their time.",
  "",
  "Tools (compose them; prefer few targeted calls):",
  "- news_publish_briefing: finalize a briefing card with your TLDR and per-story blurbs. Call it exactly once per briefing run.",
  "- news_list_articles: page through ingested articles (filters: unbriefed, since).",
  "- news_add_feed / news_remove_feed: manage the RSS/Atom/JSON-feed subscriptions.",
  "- news_follow_topic / news_unfollow_topic: manage topics covered via web search each briefing.",
  "- news_set_preferences: persist the user's standing curation preferences in their own words ('more open source, less crypto, terse blurbs'). Apply them in every briefing.",
  "- news_get_briefing_history: previous briefings and their TLDRs.",
  "- web_search / web_fetch / web_read: discover stories on followed topics and READ their actual content for substance.",
  "",
  "Sourcing rules (this is the whole point — follow them strictly):",
  "- Every link you surface must be a SPECIFIC, concrete primary source: one article, paper, post, release, or announcement that a curious reader would actually want open.",
  "- NEVER surface a search-results page, a search-engine query URL, a site homepage, a section/tag/listing/'/recent' index, or a generic aggregator ('Daily AI News', 'Today in tech', 'live updates' hubs). The user can run searches themselves — they want the real sources, not pointers to more searching.",
  "- Use web_search only to DISCOVER candidates. Then web_fetch the underlying article and cite ITS canonical URL — never the search URL or the listing page it appeared on.",
  "- Read before you write: web_fetch the stories you intend to feature so your summary reflects their real content. Never summarize from a headline alone.",
  "",
  "Briefing runs:",
  "- A briefing turn arrives as a self-contained prompt with the ranked candidate stories, followed topics, the previous TLDR, the user's preferences, and any reader feedback (👍/👎/mute taps). Everything you need is in the prompt; do not ask questions mid-run.",
  "- Honor reader feedback signals: they outrank generic preferences, and 'avoid source' is a hard exclusion.",
  "- Go deep: web_fetch the most important stories to read them (aim for the top ~6-8 across feeds and topics — depth beats breadth). web_search each followed topic, then web_fetch the 1-2 most substantive concrete articles it surfaces (not the search page).",
  "- Write summaries that stand on their own: what happened, the load-bearing specifics (names, numbers, what's new), and why it matters — not 'an article about X'.",
  "- Every search-discovered story you keep must include its canonical article URL and a real source/publication name in news_publish_briefing.searchStories, plus a substantive blurb. Do not cite claims that are not present in the candidate metadata, search result, or fetched page.",
  "- Fold in at most 10 genuinely new, concrete search stories. Drop duplicates by canonical URL, syndicated copies, search/listing pages, and stories already represented by feed candidates.",
  "- Note follow-ups: when a story continues something from the previous TLDR, say so.",
  "- Finish by calling news_publish_briefing once. Keep chat commentary to a short intro line; the card is the artifact.",
  "",
  "Conversation style:",
  "- The chat is for curation conversation: 'less crypto please' → news_set_preferences; 'follow Rust' → news_follow_topic; 'add the HN feed' → news_add_feed.",
  "- When this channel is a fork created from a story deep-dive, act as an analyst on that story: web_fetch the article, search context, relate it to the briefing it came from.",
  "- Routine polls are silent; never narrate background syncs.",
  "- Keep answers concise. Never invent stories or URLs.",
].join("\n");

/**
 * Analyst role for deep-dive forks. The channel was forked from a story tap, so
 * it carries the briefing history as context but should behave as a focused
 * analyst on one story rather than a curator. No feed/schedule management here.
 */
export const NEWS_ANALYST_PROMPT = [
  "You are a news analyst. This channel was forked from a single story in the user's news briefing so you can dig into it deeply.",
  "Your job: research the story and give the user a substantive, trustworthy analysis — not a curation chat.",
  "",
  "- Lead with a tight 2-3 sentence summary of what happened and why it matters, then go deep.",
  "- Use web_fetch to read the primary source, and web_search to gather context, corroboration, and reactions. Prefer primary sources; flag uncertainty and disagreement.",
  "- Relate the story to the briefing it came from when relevant.",
  "- Answer the user's follow-up questions conversationally. Never invent facts, quotes, or URLs; cite the links you actually read.",
  "- Do not manage feeds, topics, schedules, or briefings here — this is a focused analysis thread.",
].join("\n");

export interface DeepDivePromptInput {
  title: string;
  url: string;
  source?: string;
  /** TLDR of the briefing this story came from, for continuity. */
  briefingTldr?: string;
}

/** Self-contained opening turn for a deep-dive analyst fork. */
export function buildDeepDivePrompt(input: DeepDivePromptInput): string {
  const lines = [
    `Deep-dive this story for the user:`,
    `- Title: ${input.title}`,
    `- URL: ${input.url}`,
  ];
  if (input.source) lines.push(`- Source: ${input.source}`);
  if (input.briefingTldr) {
    lines.push("", "It appeared in this briefing (for continuity):", input.briefingTldr);
  }
  lines.push(
    "",
    "Steps: web_fetch the URL for the primary text, web_search for context, corroboration, and notable reactions (a few targeted queries). Then write a tight summary followed by a deeper analysis: what's new, what's contested, what it means, and what to watch next. Cite the links you read. Then invite the user's questions."
  );
  return lines.join("\n");
}

export interface TriageStoryInput {
  articleId: string;
  title: string;
  url: string;
  source: string;
  publishedAt?: string;
  blurb?: string;
}

export interface TriagePromptInput {
  stories: TriageStoryInput[];
  followedTopics: string[];
  /** Categories already in use, so the agent reuses them instead of inventing dupes. */
  existingCategories: string[];
}

/**
 * Tier-1.5 triage: a light, broad pass so the reader only ever shows
 * agent-processed items. The agent categorizes, clusters (same-event), and
 * one-line-summarizes each new story, and drops noise — distinct from the
 * heavier Tier-2 briefing, which deeply synthesizes the most important stories.
 */
export function buildTriagePrompt(input: TriagePromptInput): string {
  const lines: string[] = [
    "Triage these newly-fetched stories for the reader feed. The reader shows a story ONLY after you process it here, so categorize every one.",
    "",
  ];
  if (input.followedTopics.length > 0) {
    lines.push(`The user follows: ${input.followedTopics.join(", ")}.`, "");
  }
  if (input.existingCategories.length > 0) {
    lines.push(
      `Reuse these existing categories when one fits (keep the overall set small): ${input.existingCategories.join(", ")}.`,
      ""
    );
  }
  lines.push("Stories:");
  for (const story of input.stories) {
    const meta = [story.source, story.publishedAt?.slice(0, 16)].filter(Boolean).join(", ");
    lines.push(`- [${story.articleId.slice(0, 8)}] ${story.title} (${meta}) ${story.url}`);
    if (story.blurb) lines.push(`  ${story.blurb}`);
  }
  lines.push(
    "",
    "Call news_triage exactly once, with one item per story above:",
    "- articleId: the [id] prefix above.",
    "- category: a short section name. Reuse an existing/followed-topic category where it fits; coin a new one only when needed. Keep the total set small and stable.",
    "- clusterKey: a short shared key for stories about the SAME underlying event (so duplicate coverage collapses into one). Omit for standalone stories.",
    "- blurb: one tight sentence capturing what the story actually says (not 'an article about X').",
    "- keep: false for spam, navigation/search/listing pages, non-stories, or redundant duplicates you don't want shown at all.",
    "No chat commentary — just the tool call."
  );
  return lines.join("\n");
}

export interface BriefingPromptInput {
  briefingId: string;
  dateLabel: string;
  stories: NewsStoryRef[];
  followedTopics: string[];
  previousTldr?: string;
  preferencesText?: string;
  /** Recent reader feedback (👍/👎/mute) as natural-language lines to honor. */
  feedbackLines?: string[];
  articleCountScanned: number;
}

/**
 * Self-contained Tier-2 prompt (the scheduled run is a fresh turn — nothing
 * may rely on prior conversation context).
 */
export function buildBriefingPrompt(input: BriefingPromptInput): string {
  const lines: string[] = [
    `Compose the news briefing for ${input.dateLabel}. This is briefing run ${input.briefingId}; its card is already on the channel in "summarizing" state.`,
    "",
  ];
  if (input.preferencesText) {
    lines.push("User preferences (honor these):", input.preferencesText, "");
  }
  if (input.feedbackLines && input.feedbackLines.length > 0) {
    lines.push(
      "Reader feedback from story taps (most recent first — weight these heavily; 'avoid source' is a hard exclusion):",
      ...input.feedbackLines.map((line) => `- ${line}`),
      ""
    );
  }
  if (input.previousTldr) {
    lines.push(
      "Previous briefing TLDR (for continuity — flag follow-ups, do not repeat covered stories unless they developed):",
      input.previousTldr,
      ""
    );
  }
  if (input.followedTopics.length > 0) {
    lines.push(
      `Followed topics — web_search each for stories from the last day and fold genuinely new ones in: ${input.followedTopics.join(", ")}`,
      ""
    );
  }
  lines.push(
    `Candidate stories (top ${input.stories.length} of ${input.articleCountScanned} scanned, ranked by source weight and recency):`
  );
  for (const story of input.stories) {
    const meta = [story.source, story.publishedAt?.slice(0, 16)].filter(Boolean).join(", ");
    lines.push(`- [${story.articleId.slice(0, 8)}] ${story.title} (${meta}) ${story.url}`);
    if (story.blurb) lines.push(`  ${story.blurb}`);
  }
  lines.push(
    "",
    "Steps:",
    "1. Pick the stories worth the user's time (drop duplicates, noise, and anything already well-covered; honor preferences).",
    "2. Go deep: web_fetch the most important candidate stories to read their real content (aim for the top ~6-8). For each followed topic, web_search it, then web_fetch the 1-2 most substantive CONCRETE articles it surfaces — cite those specific articles, never a search page, homepage, listing/'recent' index, or aggregator.",
    "3. Call news_publish_briefing exactly once with:",
    `   - briefingId: "${input.briefingId}"`,
    "   - tldr: a comprehensive, self-contained markdown digest the user can read WITHOUT clicking through. Structure it as: a one-line **lede** naming the single most important development; then 2-5 themed sections, each a `## Heading` followed by 1-3 tight bullets that synthesize what actually happened with the load-bearing specifics (names, numbers, what's new, why it matters); end with a `## Worth watching` section noting follow-ups from the previous TLDR. Bold the load-bearing nouns.",
    "   - storyBlurbs: a substantive 2-3 sentence summary per kept story (its real content, not 'an article about X'), keyed by the [articleId] prefixes above (full ids are fine too)",
    "   - searchStories: at most 10 concrete, canonical, non-duplicate articles you found via topic search — each {url: the specific article (NOT a search/listing/home page), title, source: the publication name, blurb: 2-3 substantive sentences}",
    "   - droppedArticleIds: candidates you cut",
    "   - sourcesRead: how many concrete sources you actually web_fetched/read this run (your honest count — it's shown to the reader as a trust signal)",
    "4. End with one short chat line pointing at the briefing card. No long prose in chat."
  );
  return lines.join("\n");
}
