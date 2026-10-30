# Workflow capability contract

## Purpose

Workflows are optional, versioned process guidance. The runtime must not impose workflow stages or require workflow state to complete ordinary work. Agents should choose or follow a workflow when the user requests one or when it materially helps with a complex deliverable.

## Capability operations

Expose workflows as one coherent capability, not a set of unrelated per-operation permissions:

- `list_workflows(query)` discovers and searches definitions.
- `get_workflow(id, version)` retrieves a definition and immutable version.
- `save_workflow(...)` creates a workflow or saves a new version after checking the current version.
- `activate_workflow(id, version)` attaches the chosen version to a chat as guidance.
- `get_workflow_state()` and `update_workflow_state(state, expected_revision)` read or update optional progress.

An agent profile grants the `workflows` capability. Workflow tools are deferred until needed. State changes are revision-checked and tied to the active chat's selected snapshot. Errors return actionable feedback. The capability does not make a stage, test, review, artifact or evidence requirement mandatory.

## Definition format

Use structured YAML front matter as the source of truth and natural language for guidance. Markdown bodies remain valid overall guidance. Mermaid may be generated for display, but is not the stored model: structured definitions are easier to validate, version, query and safely render.

```yaml
id: research-and-synthesis
version: 1
title: Research and synthesis
description: Gather evidence, analyse it and communicate a supported conclusion.
tags: [research, analysis]
objective: Produce a supported recommendation.
instructions: Follow evidence quality and citation practices relevant to the request.
rules:
  - Prefer primary sources when available.
initial_stage: frame_question
terminal_stages: [communicate_findings]
stages:
  - id: frame_question
    title: Frame the question
    objective: Agree the question and scope before broad collection.
    guide: Confirm assumptions and define what a useful answer will contain.
    rules: [Keep the scope tied to the user's request.]
    transitions:
      - to: gather_evidence
  - id: gather_evidence
    title: Gather evidence
    objective: Collect relevant sources and record limitations.
    guide: Prefer primary sources and note their dates and limitations.
    transitions:
      - to: analyse
  - id: analyse
    title: Analyse
    objective: Compare evidence and identify material gaps.
    transitions:
      - to: gather_evidence
        when: Evidence gap
      - to: communicate_findings
  - id: communicate_findings
    title: Communicate findings
    guide: Present the conclusion with its support and uncertainty.
```

Definitions support an objective, overall instructions and rules, tags, a starting and terminal stage, and stage objectives, guides, rules and outgoing transitions. Transitions can branch or loop; `when` gives optional context for an edge. Legacy `guidance` fields and top-level `from`/`to` transitions are accepted and normalised. The graph guides navigation, but is never a completion gate. Reaching a terminal stage does not imply that the task is complete.

The editor offers a sequential stage list, a Mermaid-style text view and a node designer over the same structured definition. The text view is an authoring convenience, not a second stored format; parsing it preserves each stage's Markdown guide. A named stage list alone is enough to define a workflow; its order derives next-stage links. The text editor reserves `__start__` and `__end__` as endpoint IDs; those markers cannot collide with valid stage IDs. The advanced designer may store optional `position: {x, y}` values on stages so the graph reopens in place; positions are display metadata and do not affect agent execution. The shared canvas uses the same immutable definition sent to agents when a workflow is activated.

## Activation and state

Activation stores an immutable definition/version snapshot with the chat so resumed agents retain the same guidance after the library changes. Optional state records the current stage and provider values. Revision checks prevent concurrent updates from silently overwriting each other. No workflow means no workflow state or process requirements.

## Local library reliability

The local library is versioned Markdown with YAML front matter. Definitions are size-bounded and validated for stage IDs, graph references, starting and terminal stages, duplicate fields and field limits. Writes are serialised per workflow and use atomic replacement. Invalid definitions return a recoverable, actionable error instead of aborting an agent turn.
