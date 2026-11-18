---
description: Select a defensible factual development and connect it to the primary source that was read.
args:
  input: NewsBriefingEvidence
returns: NewsReview
---
For digest focus, call buildDigestPlan and return the resulting report. Otherwise follow the single-finding path below.

1. Exclude source receipts whose articleId is muted. If this leaves a claim that only a muted primary read supported, return attention / muted-source-only citing the claim then that receipt.
2. Evidence for a claim must be a concrete primary receipt marked read with the claim ID in supports. When one or more claims lack that evidence, return attention / unsupported-claim citing just the unsupported claim IDs.
3. For continuity focus and no new claim ID, return ready / already-covered citing the retained claims in input order. A new claim alongside a previous claim is ready / material-follow-up. Cite the new claim then its matching primary receipt.
4. For other grounded requests, select the first claim in the order supplied and cite it then the first eligible primary read that supports it, with ready / grounded-development. If the claimant supplied no developments, return ready / no-supported-developments with the briefing ID.
