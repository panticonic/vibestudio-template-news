---
description: Match the observed owner lane to the requested poll interval or briefing cadence.
args:
  input: NewsScheduleEvidence
returns: NewsReview
---
1. For poll, the minimum is 60000 milliseconds. Below it return blocked / poll-interval-too-short citing owner ID. If no poll row, return waiting / poll-unobserved with owner ID. Otherwise return ready / poll-confirmed for the exact interval, or attention / poll-mismatch, citing the poll ID.
2. For briefing interval, the minimum is 600000 milliseconds. Below it return blocked / briefing-interval-too-short with owner ID. No observed briefing is waiting / briefing-unobserved with owner ID. For interval intent confirm both the kind and exact milliseconds. For daily intent confirm the daily kind, local clock time and timezone together. An exact match is ready / briefing-confirmed. A mismatch is attention / briefing-mismatch. Cite the briefing ID.
