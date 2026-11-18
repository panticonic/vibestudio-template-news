---
description: Decide whether the channel and its observed pause state satisfy the requested News operation.
args:
  input: NewsScheduleEvidence
returns: NewsReview | null
---
An analyst channel belongs to focused analysis and is blocked / analyst-schedule-unavailable with owner ID. In curator mode, manual requests are ready / manual-available with owner ID, including when scheduled briefings are paused. Pause and resume intents compare the owner's observed pause flag. Return ready / pause-confirmed for a paused owner after a pause request, ready / resume-confirmed when unpaused after resume, or attention / pause-state-mismatch for the other cases. For cadence return null.
