---
name: workflow-authoring
description: Create or revise reusable Tribe workflows from a user's goal, process description, or existing workflow guidance.
---

# Workflow authoring

Use this skill when the user asks to create, improve, or save a reusable workflow. A workflow is optional guidance for future chats, not a runtime gate.

## Shape the workflow

- Start with the user's outcome and existing process. Do not impose review, testing, evidence, approval, or fixed-stage checkpoints unless the user asks for them or the work clearly needs them.
- Prefer a short sequential stage list. Use branches or return paths only when the described process needs them.
- If the user describes outcomes without a clear order, make a reasonable sequential draft and state the assumption. Ask one concise question only when the answer changes the workflow materially.
- Give each stage a short title and practical Markdown guidance. Put workflow-wide context and principles in `instructions`; put only stage-specific direction in that stage's `guide`.
- Use stable lowercase IDs and explicit transitions for complex flows. Include `initial_stage` and `terminal_stages` when defining a graph.
- Keep every stage optional guidance; agents retain judgement to move between stages as the work requires.

## Save and revise

- Search `list_workflows` before creating a new one to avoid duplicates.
- Read the workflow with `get_workflow` before revising it. Pass its current version as `expected_version` to `save_workflow`; if a version conflict is returned, reread and reconcile instead of overwriting.
- For a new workflow use a concise, stable ID, title, summary, objective, overall instructions, and structured stages. Set `expected_version` to `0` when explicitly creating a new ID.
- Save only when the user asked to create or revise the workflow. Do not save an exploratory draft without that request.
- After saving, report the workflow name and version and briefly describe its stage or branch shape.

## Example stage

```json
{
  "id": "research",
  "title": "Research",
  "objective": "Build a grounded view of the question.",
  "guide": "### Gather evidence\n\nPrioritise primary sources and record uncertainty.",
  "rules": [],
  "transitions": [{"to": "recommend", "when": "Evidence is sufficient"}]
}
```
