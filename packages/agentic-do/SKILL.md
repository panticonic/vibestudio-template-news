---
name: agentic-do
description: Work on @workspace/agentic-do agent runtime behavior, including model/provider defaults, live session tuning, and subagent delegation/supervision tools.
---

# Agentic DO

Use this skill when work is specific to the `@workspace/agentic-do` package: the
standard agent runtime, model/provider defaults, credential setup wiring, live
agent session knobs, or the subagent tool surface.

Read the local reference that matches the task before editing:

- [Agent tuning](references/agent-tuning.md) for default model/provider changes,
  model credential setup, thinking effort, approval, and response policy.
- [Subagents](references/subagents.md) for `spawn_subagent`, child task channels,
  child context inspection, semantic integration, cancellation, and retained terminal results.
- [Failures and diagnostics](references/failures-and-diagnostics.md) for the
  canonical tool-failure envelope, primary/cleanup ordering, bounded invocation
  diagnostic packets, and paged outside-lineage explanation.

Keep package boundaries explicit. Core runtime mechanics live in this package;
projection/rendering details can live in sibling packages such as
`../agentic-core` or `../agentic-protocol`, and the standard chat worker lives
under `../../workers/agent-worker`.
