---
description: Validate analyst fork attribution before judging primary-source analysis and continuity.
args:
  input: NewsDeepDiveEvidence
returns: NewsReview
---
1. Call traceAnalystFork. If it returns a finding, return it.
2. Call examineAnalysis. Return its report with exact cited IDs.
