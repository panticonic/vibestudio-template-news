---
name: news
description: Agentic news aggregation in three tiers — deterministic feed polling, light agent triage, and deep scheduled briefings via workers/news-agent.
---

# News

News aggregation runs in three tiers:

- **Tier 1, poll** (deterministic, no tokens): the `workers/news-agent`
  Durable Object polls RSS/Atom/JSON feeds, removes duplicates, and stores
  items.
- **Tier 1.5, triage** (light agent work): `runTriage` batches items that
  haven't been triaged into a `news_triage` turn. The turn categorizes them,
  clusters coverage of the same event, writes one-line summaries, and drops
  noise. The reader shows only triaged items (`listArticles triagedOnly`), so
  nothing raw or uncurated appears. Each tool result schedules the next batch
  until the stored backlog is empty. The worker runs this drain; the panel only
  starts or retries it.
- **Tier 2, briefing** (deep agent work): a scheduled or cold-start briefing
  turn web-searches followed topics, reads the top stories, and publishes a
  structured TLDR briefing card. A manual "Brief me now" runs the same turn
  without a notification; scheduled runs send a "ready" notification.

## Pieces

- **Worker**: `workers/news-agent` (`NewsAgentWorker`) stores per-channel
  feeds, followed topics, articles (deduplicated by the sha256 of the
  canonical URL), and briefings.
- **Panel**: `panels/news` is a reader-first UI with Inbox, Saved, Briefings,
  archive search, cursor pagination, explicit request states, a first-run
  source picker, and a single settings dialog. `AgenticChat` mounts only when
  the user opens the assistant drawer; it resolves the workspace-configured
  model and subscribes the agent with it. A story's "Explore" action forks the
  channel with `@workspace/channel-fork` (cloning the agent DO), calls
  `startDeepDive` on the News clone, and opens a focused analysis chat only if
  that call succeeds.
- **Renderers** (this skill): `renderers/news-briefing.tsx` and
  `renderers/news-setup.tsx`. The agent registers them as the `news.briefing`
  and `news.setup` message types when it subscribes.
- **Shared package**: `@workspace/feeds` provides feed parsing, URL
  canonicalization, polite conditional fetching, recency scoring, and the card
  state types (`@workspace/feeds/card-types`).

## Agent surface

A single operations table (`workers/news-agent/operations.ts`) generates the
model tools, the `onMethodCall` methods, and the participant descriptor:

- Tools and methods: `news_add_feed`, `news_import_opml`, `news_remove_feed`,
  `news_follow_topic`, `news_unfollow_topic`, `news_set_preferences`,
  `news_list_articles`, `news_get_briefing_history`.
- Tools only: `news_publish_briefing`, `news_triage`.
- Methods only: `setFeedEnabled`, `setSchedule`, `setBriefingPaused`,
  `markRead`, `markAllRead`, `setSaved`, `searchArchive`, `triageNow`,
  `reactToStory`, `refreshNow`, `requestDeepDive`, `startDeepDive`,
  `getOverview`.

`listArticles` is the cursor-paginated query the reader uses. `startDeepDive`
is a channel method the panel calls on the newly cloned agent after forking.

## Channel modes

A channel is either `curator` (a normal personal news channel that polls feeds,
publishes the setup card, and runs briefings) or `analyst` (a deep-dive fork
focused on one story, with no polling, setup, or onboarding).
`onChannelForked` marks forks as `analyst`, and channel preparation skips the
curator setup card for analyst channels.

## Schedule settings

Missions owns each curator channel's polling and briefing schedules.
Set `pollIntervalMs` (at least 1 minute) independently. For briefings, choose
`briefingIntervalMs` (at least 10 minutes) or a daily `briefingAt` (`"HH:MM"`)
with an explicit IANA `timezone`. These are alternative triggers; combining
an interval with a daily time is rejected before changing either schedule.
Pass `briefingAt: null` to return to interval scheduling. Change schedules
from the setup card or with `setSchedule`.
`setBriefingPaused` pauses scheduled briefings; feed polling and a manual "Brief
me now" keep working. `refreshNow` polls immediately; with `briefing: true` it
also runs a briefing without a notification.
