---
description: Choose verified evidence for a focused analyst turn and flag a recorded dispute.
args:
  input: NewsDeepDiveEvidence
returns: NewsReview
---
1. Find a primary read for the exact article in the request. Without it return attention / primary-story-missing with the request ID.
2. If a reported dispute has at least two distinct concrete read sources in its sourceIds, return attention / contested-development citing that dispute ID followed by the first two qualifying source IDs.
3. Otherwise return ready / focused-analysis, citing the primary source ID then the briefing ID if it exists.
