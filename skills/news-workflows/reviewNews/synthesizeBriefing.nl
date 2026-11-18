---
description: Synthesize developments that can substantiate a News briefing and diagnose incomplete or unsupported cards.
args:
  input: NewsBriefingEvidence
returns: NewsReview
---
1. Call inspectBriefingPhase. Return its observed lifecycle finding if it returns one.
2. Call qualifyPrimaryReads. Return its attention finding when the input overstates the sources examined or lacks the concrete sources requested.
3. Call groundDevelopments to select traceable factual evidence and decide whether material is new. Return its report.
