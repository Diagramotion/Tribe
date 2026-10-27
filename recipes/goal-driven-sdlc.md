---
id: goal-driven-sdlc
title: "Goal-driven SDLC"
description: "Plan, implement, verify and independently review a bounded engineering outcome."
version: 7
---

Work towards the user's mission goal and the project goal. Clarify material ambiguity before taking an irreversible direction. Treat the project goal as user-owned and never change it.

Have the planner create a small, dependency-aware plan with verifiable acceptance criteria, then call `finalize_plan` to commit those criteria and map each criterion to the plan tasks that deliver or verify it. Every plan task must support at least one criterion. The finalized plan is the boundary between planning and implementation: the runtime rejects work claims until the checkpoint is current. Re-plan when evidence or user input changes the approach; adding or revising a task makes the checkpoint stale, so update the criterion-to-task mapping and finalize the plan again before agents can claim work or repository actions resume. Plan checkpoints and changes are durable events in the shared mission channel. Agents should inspect the board, choose a ready task that fits their role, claim that exact item, and coordinate through channel events rather than hidden delegation. Do not claim the first listed task by default when another eligible task better fits your role.

Before finalising the first plan, the planner must call `complete_discovery` with a concise summary of the repository structure, relevant existing behaviour, constraints and risks, plus the relative paths of files that support those findings. Tribe validates and records each referenced file and its fingerprint. If the repository has no relevant files yet, provide an empty evidence list and explain that in the summary. A discovery checkpoint is durable and required for v7 missions; later discovery changes make the plan stale until it is finalised again.

Repository edits, test runs, deletions and isolated-work integration performed through Tribe's repository tools must be tied to a live claimed plan item. The runtime enforces this requirement; if a claim expires, reclaim eligible work before continuing.

Implement the smallest coherent change. Run relevant checks and attach useful outputs or diffs as mission artifacts. The reviewer must inspect the resulting changes independently, check acceptance criteria and risks, and request fixes when needed. Finish every current plan item before a review checkpoint; the runtime rejects checkpoints while any plan work remains unfinished. After implementation is complete, verify against the latest changes; the reviewer can record a checkpoint only against the latest successful test run. The reviewer records a durable checkpoint with an approved or changes-requested outcome and concise findings. Findings should identify severity, repository path and issue; each finding becomes a ready plan item for the team to self-claim only after the planner updates and re-finalizes the plan. The team completes all new finding tasks before the next verification and review cycle. Re-verify and record a new checkpoint after any fix. Only the reviewer may complete the mission, with a concise summary and evidence that each acceptance criterion is met.

For mission completion, use exactly the acceptance criteria from the latest finalized plan and map each to one or more specific successful test-run events, successful command events or mission artifacts. Do not provide a detached list of claims and evidence IDs; every check must show which source supports it. Use artifact IDs to link directly to reviewable outputs.

For missions using this recipe, completion is gated by the event history: cite the latest successful test run, ensure it occurred after the latest repository change, and record an approved review checkpoint tied to that exact test and change. Complete a reviewer-owned plan item after verification as well. Any later file change requires another successful test run and a subsequent independent review checkpoint. Verification and review therefore form explicit durable checkpoints rather than advisory sequencing.

Request approval for each concrete action that the runtime marks as requiring approval. Do not bundle approvals or infer consent from a prior action.
