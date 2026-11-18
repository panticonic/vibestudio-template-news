---
description: Locate the first incomplete or mismatched News deep-dive handoff.
args:
  input: NewsDeepDiveEvidence
returns: NewsReview | null
---
1. No fork means waiting / fork-unobserved with request ID.
2. A fork outside the requested curator channel, a self-fork, or a fork remaining curator mode means blocked / wrong-fork with request and fork IDs.
3. No start acknowledgement means waiting / analyst-start-unobserved with fork ID. A false acknowledgement means attention / analyst-start-failed with start ID.
4. An acknowledged start on the wrong channel or a different requested article is blocked / analyst-target-mismatch with request then start ID.
5. Otherwise return null to examine source readback.
