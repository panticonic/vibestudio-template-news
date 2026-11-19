---
description: Reconcile one expressly authorized cadence lane against persisted News state.
args:
  input: NewsScheduleEvidence
returns: (NewsReaderEvidence | NewsScheduleEvidence)[]
uses: [reviewNews/reviewSchedule]
---
1. Call reviewSchedule with the initial evidence and retain its status.
2. Call chooseCadenceChange with that status and the user's schedule intent.
3. Call newsRead.finishCadence once with the returned change, including null when holding or leaving settings in place. Return its final observations for fresh interpretation.
