import test from "node:test";
import assert from "node:assert/strict";
import { summariseTeamWork } from "../src/domain/plan.js";
import {
  advanceMissionWorkflowContext,
  mergeMissionWorkflowContext,
  missionPhase,
  preserveMissionWorkflowContext,
} from "../src/domain/mission-phase.js";

test("team summary rolls up each role's claimed, ready, blocked and completed work", () => {
  const agents = [
    { id: "builder", name: "Builder", role: "Implement changes", status: "Working" },
    { id: "reviewer", name: "Reviewer", role: "Review changes", status: "Waiting for you" },
  ];
  const work = [
    { owner: "builder", status: "In progress", title: "Build endpoint" },
    { owner: "builder", status: "Ready", title: "Add docs" },
    { owner: "reviewer", status: "Blocked", title: "Review release" },
    { owner: "reviewer", status: "Done", title: "Review schema" },
    { owner: "Unclaimed", status: "Ready", title: "Record decision" },
  ];

  const summary = summariseTeamWork(agents, work);

  assert.deepEqual(summary.map(({ id }) => id), ["builder", "reviewer", "unassigned"]);
  assert.equal(summary[0].activeItems[0].title, "Build endpoint");
  assert.equal(summary[0].readyCount, 1);
  assert.equal(summary[1].blockedItems[0].title, "Review release");
  assert.equal(summary[1].completedCount, 1);
  assert.equal(summary[2].readyCount, 1);
});

test("team summary keeps work owned by roles that are no longer registered", () => {
  const summary = summariseTeamWork([], [
    { owner: "archived_reviewer", status: "Done", title: "Prior review" },
  ]);
  assert.equal(summary[0].name, "archived_reviewer");
  assert.equal(summary[0].runtimeStatus, "Agent unavailable");
  assert.equal(summary[0].completedCount, 1);
});

const researchWorkflow = {
  id: "research-map", version: 3, objective: "Produce a supported recommendation.",
  stages: [
    { id: "frame", title: "Frame the question", objective: "Set scope.", guide: "Agree the question." },
    { id: "gather", title: "Gather evidence", objective: "Collect useful sources.",
      transitions: [{ to: "frame", when: "A material gap appears" }] },
    { id: "deliver", title: "Deliver findings", guide: "Explain the result." },
  ],
};
const workflowChat = {
  recipe_id: researchWorkflow.id, recipe_version: researchWorkflow.version,
  recipe_snapshot: researchWorkflow, status: "active",
};
const phaseLabel = (mission, context = {}) => missionPhase(mission, [], context)?.label ?? null;

test("workflow progress comes from its selected definition, not a fixed SDLC tracker", () => {
  const phase = missionPhase(workflowChat, [], {});
  assert.equal(phase.stageId, null);
  assert.equal(phase.label, "Not started");
  assert.equal(phase.detail, researchWorkflow.objective);
  assert.equal(phaseLabel({ recipe_id: "", status: "active" }), null);
});

test("workflow state updates select the workflow-defined stage and guidance", () => {
  const context = advanceMissionWorkflowContext({}, {
    type: "workflow.state.updated", id: "event-1", sequence: 4,
    payload: { revision: 2, state: { stage_id: "gather", values: { sources: 3 } } },
  });
  const phase = missionPhase(workflowChat, [], context);
  assert.equal(phase.stageId, "gather");
  assert.equal(phase.label, "Gather evidence");
  assert.equal(phase.detail, "Collect useful sources.");
  assert.deepEqual(phase.state, { stage_id: "gather", values: { sources: 3 } });
  assert.equal(phase.revision, 2);
});

test("legacy stage events and unknown workflow stage IDs remain readable", () => {
  const context = advanceMissionWorkflowContext({}, {
    type: "workflow.stage.changed", id: "event-1", sequence: 4,
    payload: { stageId: "deliver", title: "Deliver findings" },
  });
  assert.equal(phaseLabel(workflowChat, context), "Deliver findings");
  const unknown = advanceMissionWorkflowContext({}, {
    type: "workflow.state.updated", id: "event-2", sequence: 5,
    payload: { revision: 1, state: { stage_id: "future-stage" } },
  });
  assert.equal(phaseLabel(workflowChat, unknown), "Unknown workflow stage");
});

test("workflow context merges by event sequence and stays scoped to one chat", () => {
  const older = advanceMissionWorkflowContext({}, {
    type: "workflow.state.updated", id: "event-old", sequence: 4,
    payload: { revision: 1, state: { stage_id: "frame" } },
  });
  const newer = advanceMissionWorkflowContext({}, {
    type: "workflow.state.updated", id: "event-new", sequence: 8,
    payload: { revision: 2, state: { stage_id: "gather" } },
  });
  const merged = mergeMissionWorkflowContext(newer, older);
  assert.equal(merged.state.id, "event-new");
  assert.equal(phaseLabel(workflowChat, merged), "Gather evidence");

  const current = { id: "chat-1", recipe_id: workflowChat.recipe_id, workflow_context: newer };
  const omitted = preserveMissionWorkflowContext(current, { id: "chat-1", status: "paused" });
  assert.equal(phaseLabel(workflowChat, omitted.workflow_context), "Gather evidence");
  assert.equal(preserveMissionWorkflowContext(current, { id: "chat-2" }).workflow_context, undefined);
});

test("chat completion does not infer progress or require a terminal workflow stage", () => {
  const phase = missionPhase({ ...workflowChat, status: "completed" }, [], {});
  assert.equal(phase.label, "Not started");
  assert.equal(phase.chatCompleted, true);
});
