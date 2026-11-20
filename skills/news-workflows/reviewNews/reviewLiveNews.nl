---
description: Inspect real News state and combine the assigned reader and cadence findings.
args:
  request: NewsLiveRequest
returns: NewsReview
uses: [reviewers/readReader, reviewers/reviewSchedule]
---
1. Call readNewsState once. Retain the returned evidence for each assigned check.
2. If changeIndex is present, take that schedule evidence item and call reconcileCadence with it. Replace the initial observations with its returned final readback.
3. In the original check order, call readReader for each reader evidence item and reviewSchedule for each schedule evidence item. Do not reinterpret the returned findings.
4. Return the findings in the original order. The overall status is the most serious observed among blocked, attention, waiting, and ready, in that order.
