---
description: Diagnose setup, loading, backlog, and reader navigation in an authorized News panel.
args:
  input: NewsReaderEvidence
returns: NewsReview
---
1. Call diagnoseReaderState. Return its finding when it describes the current blocker or phase.
2. For a loaded view with evidence pages, call inspectReaderPages. Return its exact finding and status.
