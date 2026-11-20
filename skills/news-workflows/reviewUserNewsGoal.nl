---
description: Diagnose or update a live News reader and its schedules under the user's requested scope.
args:
  goal: string
returns: NewsUserGoalReport
budget: { maxTurns: 20 }
uses: [reviewers/readReader, reviewers/reviewSchedule]
---
1. Observe the current News cadence with newsGoal.observeCadence. Call planNewsGoal with the user goal and that observation.
2. When the plan requests changes, call reconcileNewsGoal with the goal, plan changes and the latest cadence. Keep its final cadence, change findings and blocked status. Otherwise keep the originally observed cadence.
3. For each planned reader view, call newsGoal.readReader. Use readReader on the returned evidence to assess the view. Retain its selection and actual review.
4. For each planned comparison, call reviewSchedule with the final cadence as schedule evidence, the original goal, and that comparison's intent. Return those findings with the change findings. Keep all evidence IDs and the final cadence exactly as observed. Return blocked if the requested change was blocked, changed if a write was confirmed, otherwise reviewed.
