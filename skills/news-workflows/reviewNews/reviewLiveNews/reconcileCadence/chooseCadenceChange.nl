---
description: Decide whether an assigned cadence edit should be applied after inspecting its current lane.
args:
  review: NewsReview
  input: NewsScheduleEvidence
returns: NewsCadenceChange
---
Return the exact intent from input for an attention result about a poll, interval, daily, pause, or resume mismatch. Return null for a match or when evidence is waiting or blocked. A manual briefing request never authorizes editing its cadence.
