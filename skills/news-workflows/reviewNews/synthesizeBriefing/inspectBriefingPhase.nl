---
description: Attribute the card's publication phase to the captured briefing ID.
args:
  input: NewsBriefingEvidence
returns: NewsReview | null
---
1. For any focus, error means attention / briefing-failed. Cite the observed briefing ID.
2. For publication and digest focus, collecting means waiting / collecting-candidates and summarizing means waiting / briefing-in-progress. Cite the observed briefing ID. A ready card proceeds to evidence review.
3. For credibility or continuity, inspect the supplied candidate evidence even while its briefing is being assembled.
