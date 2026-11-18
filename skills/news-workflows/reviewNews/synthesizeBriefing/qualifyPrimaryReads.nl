---
description: Inspect distinct concrete source receipts before grounding a briefing.
args:
  input: NewsBriefingEvidence
returns: NewsReview | null
---
For publication, credibility, and digest focus, compare declaredSourcesRead with the number of distinct URLs in read concrete primary or secondary evidence. If overstated, return attention / source-count-overstated with the briefing ID. A crawl of a listing or a syndicated mirror does not count as an independent read.
If there are claims but no primary read, return attention / primary-read-missing with all claim IDs in their input order. For continuity ignore the aggregate source count, but still require primary material for claims. Otherwise return null.
