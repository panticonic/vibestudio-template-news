---
description: Reconcile one requested News lane against fresh owner state.
args:
  goal: string
  intent: NewsScheduleIntent
  cadence: NewsCadenceSnapshot
returns: NewsGoalCadenceResult
budget: { maxTurns: 18 }
uses: [reviewers/reviewSchedule]
---
1. Form schedule evidence by adding kind schedule, the goal and intent to the current cadence. Call reviewSchedule. If it is ready, return with no write. If it is blocked or cannot be applied to an observed owner, return blocked with that finding.
2. For a scoped change, call newsGoal.apply with the cadence owner ID and change intent. When state-changed is returned, review the returned cadence with the same intent. If already ready return it without another operation, otherwise retry against the new owner ID only when the change is still justified.
3. Review the final cadence with reviewSchedule. Keep the actual snapshot and its review. Return changed only for a confirmed applied operation. Return blocked when an authorized requested state could not be confirmed. Include the finding as the single entry in findings, with its intent.
