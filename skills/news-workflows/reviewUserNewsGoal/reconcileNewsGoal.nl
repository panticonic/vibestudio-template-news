---
description: Apply only the requested News changes, rereading each affected cadence from its owner.
args:
  goal: string
  changes: NewsScheduleIntent[]
  cadence: NewsCadenceSnapshot
returns: NewsGoalCadenceResult
budget: { maxTurns: 20 }
---
1. Keep the latest cadence and an initially empty findings list.
2. In order, call reconcileNewsLane with each change intent and current cadence. Append its exact finding and keep its latest cadence for the next instruction. Stop applying changes on a blocked result.
3. Return the final cadence, whether a change was blocked, whether any write was confirmed, and the accumulated findings.
