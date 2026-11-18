---
description: Inspect real News state and combine the assigned reader and cadence findings.
args:
  request: NewsLiveRequest
returns: NewsReview
uses: [reviewNews/readReader, reviewNews/reviewSchedule]
---
1. Call readNewsState once. Retain the returned evidence for each assigned check.
2. In the original check order, call readReader for each reader evidence item and reviewSchedule for each schedule evidence item. Do not reinterpret the returned findings.
3. Return the findings in the original order. The overall status is the most serious observed among blocked, attention, waiting, and ready, in that order.
