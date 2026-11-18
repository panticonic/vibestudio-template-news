---
description: Group genuine coverage overlap while preserving substantive updates and relevant reader categories.
args:
  input: NewsTriageEvidence
returns: NewsFinding
---
1. A later report with a concrete decision, measured new result, or outcome distinct from earlier coverage is retain-update. Cite earlier then later.
2. Two reports on the same event with no material new facts are cluster-same-event. Cite both in input order.
3. Articles on independent events from one topic are keep-separate. Cite all in input order.
4. For one retained article return reuse-category if an existing category clearly fits, or propose-category if the relevant topic has no category. Cite the article ID.
