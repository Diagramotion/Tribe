# Dynamic delegation and sub-agents backlog

## Status

Backlog only. No dynamic spawning or child-agent runtime is implemented or promised for the first release. Complete the local product and reliability work first.

## Why this needs a fit decision

Tribe already has a persistent team of role-based consumers that self-claim durable plan items and communicate through the mission channel. Per-run children could speed up bounded research or independent implementation, but could also duplicate the planner, fragment the shared conversation, compete for repository writes, increase model spend, and make ownership and recovery harder to understand.

Before implementation, compare the delegation and hand-off primitives in the then-current Pydantic AI release with Tribe's event, claim, permission, cancellation, and recovery contracts. Use framework capabilities where they fit; do not build a parallel orchestration layer merely to expose a new label in the UI.

### Framework baseline to verify

The runtime lock currently pins `pydantic-ai-harness==0.61.0` and `pydantic-ai-slim==2.61.0`. The Harness documentation for the current release describes three relevant primitives:

- `SubAgents` provides named child agents, per-child call/token/time limits, usage forwarding, and typed start/end events. It can load Markdown or TOML agent definitions from disk.
- `DelegationTasks` extends delegation with stable child task identity, foreground/background execution, resume/cancel/steer, parent reports, and persisted child metadata/history with optional `StepPersistence` checkpoints.
- `DynamicWorkflow` lets a model compose bounded specialist calls, including parallel fan-out, within one tool call.

These are plausible execution primitives, not an automatic fit. The agent worker in Tribe currently owns the event consumer, plan claim, workspace and deferred-approval interaction. Pydantic's default dependency forwarding would give children the parent's dependency object; inheriting its workspace and active plan-item claim would permit ambiguous write ownership. Framework child events are also not yet mission events, and framework child history does not by itself give Tribe a searchable project timeline or replayable product audit. Prototype against the exact locked version and inspect its failure/restart behaviour before selecting a primitive. See [SubAgents](https://pydantic.dev/docs/ai/harness/subagents/), [Dynamic Workflow](https://pydantic.dev/docs/ai/harness/dynamic-workflow/) and [capability overview](https://pydantic.dev/docs/ai/capabilities/overview/).

### Preliminary fit

| Mechanism | Tribe fit | Boundary to preserve |
| --- | --- | --- |
| Existing role consumers | Default for project work, planning and parallel implementation. They already self-claim durable plan items and publish to the mission channel. | Improve their recovery, wake-up and ownership semantics instead of creating a child for work that belongs on the board. |
| Harness `SubAgents` | Best first prototype for an on-demand, read-only specialist opinion whose concise result returns to its parent. Its named roster, per-child limits and typed events remove much of the custom delegation plumbing. | Keep it foreground and non-recursive initially. Persist correlated child lifecycle events in Tribe; do not expose raw child reasoning as a second channel. |
| Harness `DelegationTasks` | Candidate for long-running research that must outlive one parent model call; its managed sessions provide child identity, reports, cancellation and persistence hooks. | Verify recovery across Tribe process exit, database restore and framework upgrades. Framework files/checkpoints must not become a second source of product truth. |
| Harness `DynamicWorkflow` | Potentially useful for a bounded, scripted fan-out-and-join inside one task. | It is not the ambient team topology. A single model-authored workflow tool call would hide intermediate work unless Tribe forwards typed lifecycle and result events. |

This is a pilot recommendation, not a release decision. The candidate value is an ad-hoc specialist consultation; routine project work remains with the standing consumers. A read-only parallel review is the comparison case. Defer dynamic workflow choreography unless a measured task materially improves over explicit delegation or existing plan claims.

“Dynamic agent” and “sub-agent” are not yet product requirements. First distinguish three mechanisms: a standing role consumer claiming a durable plan item; a bounded child run delegated by a parent for a result; and a dynamically selected specialist/model/tool profile within an existing run. They have different persistence and UX costs and must not be combined under one feature label.

Pydantic AI's agent/tool delegation and Pydantic Graph's parallel branches may help execute a bounded workflow, but neither should be assumed to provide Tribe's durable child-run identity, event history, task lease, approval boundary, restart recovery, or UI lineage. Verify the current framework APIs and persistence support at decision time, then wrap only the missing lifecycle around them. Keep provider access behind Tribe's existing provider abstraction so this feature does not couple delegation to a single model SDK.

## Fit assessment

Evaluate a small set of real workflows:

- specialist consultation that returns a concise finding to the requesting agent;
- parallel research or review tasks with independent outputs;
- parallel repository changes, only where file ownership and integration are explicit;
- delegation that continues after the parent pauses, fails, or restarts.

For each, compare quality, latency, cost, context duplication, user comprehension, and recovery complexity against the existing role consumers. Record which workflows justify children and which should remain plan items claimed by the standing team.

Include a prototype with at least one real task from each promising workflow. Measure whether the parent can use the result without replaying a second full conversation, whether work survives app restart, and whether the user can locate child work from the parent mission timeline and artifacts. A child that only makes an agent appear more active is not sufficient product value.

The initial fit hypothesis is to keep normal plan execution with the standing role consumers. If a prototype demonstrates material value, test a read-only specialist consultation first, with one bounded child and a concise returned finding. Test parallel read-only review separately. Do not use children for parallel repository edits in the first prototype: Tribe already has durable plan-item claims and isolated-work integration, while child workspace ownership and approval lineage are unresolved. Test `DynamicWorkflow` only if it improves a concrete task over explicit parent tool calls; scripted fan-out is not inherently better team collaboration.

## Design requirements if accepted

- A child is a durable run with parent/child lineage, a named objective, bounded lifetime, and a result the parent can inspect before acting on it.
- Delegation has explicit depth, child-count, time, token/spend, and retry limits. Recursive spawning is off unless separately justified.
- Child permissions are inherited only as an upper bound and may be narrowed; a child cannot gain tools, repository scope, or approval authority the parent lacks.
- Plan-item claims and workspace write ownership remain exclusive and durable. Parallel child edits need explicit file/task ownership or isolated workspaces and a reviewed integration step.
- Read-only children receive a genuinely restricted dependency/tool surface, not just a prompt telling them not to write. Do not pass a parent's live work-item claim, mutable tool-call maps, or approval state into a child unless the child has a distinct durable identity and policy context.
- Child messages, tool activity, approvals, artifacts, completion, and failures remain attributable in the mission UI. The user can tell who delegated, what the child is doing, and what result returned without following duplicate raw reasoning streams.
- Persist the parent run, child task ID, child run IDs, parent-child relationship, assigned objective, model selection, budget, outcome and checkpoint reference in Tribe's event/projection model. Framework telemetry alone is not the user-facing audit trail.
- Parent and child cancellation, app restart, provider failure, unknown side effects, and partial results have defined durable recovery behaviour.
- Delegation cannot bypass individual action approvals, audit events, project budgets, or user stop controls.
- The feature remains distinct from distributed collaboration: children initially run under one local Tribe installation and identity.

## Decision gate

Write a short architecture decision record after the fit assessment. It must choose among: existing role consumers only; bounded non-recursive child runs; or a framework-native pattern with Tribe persistence around it. Include a prototype result and failure/restart evidence before moving this item into implementation. The first accepted scope should be non-recursive; any recursive spawning requires separate evidence, budgets, UI design and approval. Recheck the pinned Harness APIs and event semantics at that gate because its current 0.x release can change between minor versions.
