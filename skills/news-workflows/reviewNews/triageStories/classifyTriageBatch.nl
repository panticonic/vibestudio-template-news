---
description: Separate useful stories from muted sources and navigation noise using the supplied article material.
args:
  input: NewsTriageEvidence
returns: NewsFinding | null
---
Return exclude-muted-source with the muted article IDs in input order if present. Otherwise return exclude-navigation with the IDs of menu, directory, spam, listing, or contest-navigation material that has no concrete news content. Return null when every article could contribute.
