---
description: Plan a briefing digest across multiple proposed claims, distinguishing developments to retain and those to qualify.
args:
  input: NewsBriefingEvidence
returns: NewsReview
---
1. Traverse the claims in supplied order. For each claim find the first inspected concrete primary source that supports it and whose article is unmuted.
2. An eligible claim already in previousClaimIds is already-covered and cites the claim ID only. An eligible new claim is grounded-development and cites the claim and chosen source.
3. For a claim with primary proof only in a muted source, emit muted-source-only with the claim then that receipt. For any other unsupported claim, emit unsupported-claim with the claim ID only.
4. A muted or unsupported claim means the digest needs attention. Otherwise the evidence plan is ready. Retain the entire sequence of findings so the next editor can distinguish accepted, repeated, and unsupported material. If no claims were supplied return ready / no-supported-developments with the card ID.
