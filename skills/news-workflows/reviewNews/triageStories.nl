---
description: Decide what an ingested News candidate contributes to the reader feed.
args:
  input: NewsTriageEvidence
returns: NewsReview
---
1. Call classifyTriageBatch to drop non-stories and muted sources. If that stage returns a finding, return it as attention.
2. Otherwise call reconcileCoverage. Return its finding as ready, with cited article IDs. Keep existing categories when compatible with the observed story.
