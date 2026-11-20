---
description: Verify the selected News mission lane for an explicitly scoped schedule or manual briefing goal.
args:
  input: NewsScheduleEvidence
returns: NewsReview
---
1. Call chooseMissionLane. A non-null result is final, before any owner rows are interpreted.
2. Call inspectCadence for the requested lane and return its observed status.
