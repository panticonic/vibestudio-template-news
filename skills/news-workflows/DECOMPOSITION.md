# News review workflows

This package turns the News reader skill and worker procedures into a readback workflow. The caller assigns the reader channel and supplies evidence from its participant, panel, or briefing. The program returns findings with the original evidence IDs. A normal News user still owns feed, topic, schedule, and briefing mutations.

| Policy | Natural-language stages | Exact boundary |
| --- | --- | --- |
| Diagnose the reader | Triage the setup and backlog, then interpret the cursor or requested view. | Decode the existing overview and article-page wire schemas from one News participant. |
| Curate a triage batch | Assess category and inclusion, then group coverage of the same event or recognize an update. | Input IDs identify ingested articles. The result remains a review of the batch. |
| Synthesize a briefing | Choose which factual developments to keep, ground individual claims in inspected primary sources, then judge continuity. | Evidence carries IDs of the actual read receipts and factual claims. Unread pages and search listings cannot support a retained claim. |
| Diagnose a focused analyst fork | Verify target attribution before checking the analyst turn, primary source, continuity, or contested assertions. | Preserve the observed fork IDs, start acknowledgement and readback. |
| Review schedules | Choose the intended lane and interpret its current delivery state without inferring a write. | Polls, briefing intervals, daily anchors and the pause flag come from the persisted owner readback. |

Related cases carry source groups. Each world states a concrete user goal, evidence, and an independently authored verdict. The verifier compares qualified evidence and finding codes across the entire result and rejects missing, altered, reordered, or repeated effects where they matter.

The live workflow reads an owned News participant through its existing channel
methods. Setup and reader evidence come from the worker's persisted state.
Schedule evidence is joined to the two exact Missions owner rows. The model
delegates reader and schedule interpretation to the original subtrees and
combines their findings in assignment order. Fixture operations, including
changes to schedule and preferences, stay with the managed harness.

Cadence reconciliation starts by observing the curator and both installed
Missions owners. The selected schedule check defines the user's authority.
A reconciliation lambda reviews the current lane through the same schedule
subtree used by read-only reviews, then delegates the decision to apply,
hold, or confirm the existing state. The service enforces the assigned write
bound, invokes the existing News operation, and reads the owners again.
Reader and schedule interpretation then runs over the final observation.
Qualification compares both snapshots and requires the other schedule lane,
the pause flag, and the owner identities to survive edits that leave them
outside the selected scope.

## Goal-only News work

The shared Vibestudio root mounts this installed package and offers
`reviewUserNewsGoal` beside other workspace skills. The call receives the user
goal. The schedule and reader observations come from the owned News participant
and its actual Missions owners.

| Procedure | Implementation |
| --- | --- |
| Select relevant reader views, comparisons, and any requested writes | The `planNewsGoal` child interprets the goal and the current cadence. |
| Distinguish a missing preference, an empty view, and unfinished triage | The existing `reviewers/readReader` tree interprets each observed page. |
| Check a cadence constraint before considering a write | The existing `reviewers/reviewSchedule` tree interprets the requested lane and its exact current state. |
| Choose whether to apply a change, reread after a conflict, or keep the existing value | The reconciliation subtree calls the existing schedule reviewer for the observed and resulting states. |
| Connect to the installed participant and protect its mutation boundary | TypeScript checks ownership, exact allowed lanes, current observation, and persistent readback. |
| Verify the finished outcome | The managed test reads actual News and Mission state independently and checks the report against its bound receipts. Test goals, setup operations and outcome criteria stay separate. |
