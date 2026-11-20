---
description: Choose which live News checks and actions the goal calls for.
args:
  goal: string
  cadence: NewsCadenceSnapshot
returns: NewsGoalPlan
---
1. Decide what the user needs to know or change. Choose reader views only for requested reader information. Use inbox for current stories, saved for the user's saved stories, backlog for unfinished triage and archive with a search query for historical news.
2. Choose each requested state change in the order needed. Include conditional state changes here so the reconciliation stage can confirm the existing state or check what is supported. Keep polling, unattended briefing cadence, and briefing pause state independent. A daily time needs the requested timezone or the observed timezone when the goal preserves it. Convert intervals to milliseconds.
3. Put hypotheses and conditions the user asks you to check in checks. A manual intent checks availability without starting a briefing. Leave changes empty when the user wants a read-only review. Preserve any stated limits on scope and timing.
