---
description: Locate the current setup, refresh, or triage condition before interpreting reader pages.
args:
  input: NewsReaderEvidence
returns: NewsReview | null
---
Use the following order for the single most immediate condition. Cite the overview ID for each finding.
1. Latest activity retryable-error is attention / reader-request-failed. Latest activity loading is waiting / reader-loading. Stored pages can predate that request.
2. Setup needs-user-preferences is waiting / preferences-needed. Offer the configured reader only after that phase.
3. An inbox or backlog request with a positive backlog and no visible article rows is waiting / triage-pending. The worker drains triage. A saved view is independent of triage.
4. If every enabled feed is failing and the newest requested inbox page has no rows, return attention / enabled-feeds-failing.
5. With no pages, return waiting / reader-page-unobserved. Otherwise return null so the caller can inspect the pages.
