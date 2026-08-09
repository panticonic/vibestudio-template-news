import type { SqlStorage } from "@workspace/runtime/worker";

/**
 * Production-baseline News tables (see NewsAgentWorker.schemaVersion).
 * Future shape changes require an ordered migration; earlier experimental
 * layouts are rejected intact because no lossless historical translation is
 * known.
 */
export function createNewsTables(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS news_channel_state (
      channel_id TEXT PRIMARY KEY,
      poll_interval_ms INTEGER NOT NULL,
      briefing_interval_ms INTEGER NOT NULL,
      briefing_at_minutes INTEGER,
      top_k INTEGER NOT NULL DEFAULT 12,
      setup_status TEXT NOT NULL DEFAULT 'needs-user-preferences',
      preferences_text TEXT,
      last_briefing_id TEXT,
      last_run_at INTEGER,
      last_error TEXT,
      last_setup_json TEXT,
      -- 'curator' (normal personal channel) or 'analyst' (deep-dive fork):
      -- analyst channels skip feed polling and the setup card.
      mode TEXT NOT NULL DEFAULT 'curator',
      -- JSON array of capped reader feedback signals (👍/👎/mute) folded into
      -- each briefing prompt so curation visibly learns from taps.
      feedback_json TEXT,
      -- 1 → scheduled/cold-start briefings are paused ("vacation"); manual
      -- "Brief me now" and feed polling still run.
      briefing_paused INTEGER NOT NULL DEFAULT 0
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS news_feeds (
      channel_id TEXT NOT NULL,
      feed_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      weight REAL NOT NULL DEFAULT 1.0,
      enabled INTEGER NOT NULL DEFAULT 1,
      etag TEXT,
      last_modified TEXT,
      last_fetch_at INTEGER,
      last_status TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0,
      backoff_until INTEGER,
      PRIMARY KEY (channel_id, feed_id)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS news_topics (
      channel_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (channel_id, topic)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS news_articles (
      channel_id TEXT NOT NULL,
      article_id TEXT NOT NULL,
      feed_id TEXT,
      origin TEXT NOT NULL DEFAULT 'feed',
      canonical_url TEXT NOT NULL,
      title TEXT NOT NULL,
      title_sim_key TEXT,
      summary TEXT,
      author TEXT,
      -- Display source for non-feed (search) articles: the publication name the
      -- agent attributed the story to. Feed articles derive their source from
      -- the joined feed title instead.
      source TEXT,
      published_at INTEGER,
      fetched_at INTEGER NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      -- Reader bookmark: 1 → kept in the "Saved" view regardless of read state.
      saved INTEGER NOT NULL DEFAULT 0,
      briefed_in TEXT,
      blurb TEXT,
      -- Agent triage (Tier 1.5): the reader only shows triaged items, so nothing
      -- raw/un-curated surfaces. triaged=1 once the agent has categorized it.
      triaged INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      -- Agent-assigned key shared by stories about the SAME event (semantic
      -- clustering, unlike the lexical title_sim_key used only for dedup).
      cluster_key TEXT,
      PRIMARY KEY (channel_id, article_id)
    )
  `);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_news_articles_unbriefed
     ON news_articles(channel_id, briefed_in, fetched_at)`
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_news_articles_triaged
     ON news_articles(channel_id, triaged, fetched_at)`
  );
  sql.exec(`
    CREATE TABLE IF NOT EXISTS news_briefings (
      channel_id TEXT NOT NULL,
      briefing_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      tldr TEXT,
      story_ids_json TEXT NOT NULL DEFAULT '[]',
      card_message_id TEXT,
      -- Count of concrete sources the agent fetched/read for this briefing.
      sources_read INTEGER,
      -- 1 → fire a "ready" notification on publish (scheduled/cold-start runs);
      -- 0 → stay silent (a manual "Brief me now" the reader is already watching).
      notify INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (channel_id, briefing_id)
    )
  `);
}
