---
description: Interpret a loaded News article window with explicit cursor linkage.
args:
  input: NewsReaderEvidence
returns: NewsReview
---
1. Examine the pages in observed order. For a page with hasMore true and no cursor or a cursor equal to its requested cursor, return attention / cursor-stalled citing that page.
2. For adjacent pages whose next and requested cursors do not match, return attention / page-chain-mismatch citing the preceding and following page in that order.
3. If an article is repeated across two pages, return attention / repeated-article with both pages in observed order.
4. With no article IDs or archive briefing IDs in the chain return ready / empty-loaded-view. Otherwise return ready / loaded-more-available if the tail hasMore, or ready / loaded-to-end. Cite all inspected pages in observed order for a valid window.
