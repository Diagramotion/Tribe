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

const sdlcMission = { recipe_id: "goal-driven-sdlc", recipe_version: 6, status: "active" };
const phaseLabel = (mission, work, context) => missionPhase(mission, work, context)?.label ?? null;

test("mission stage follows the current finalized plan and unfinished team work", () => {
  assert.equal(phaseLabel(sdlcMission, [], {}), "Planning");
  const plan = { planFinalizedSequence: 4 };
  assert.equal(phaseLabel(sdlcMission, [{ owner: "builder", status: "Ready" }], plan), "Building");
  assert.equal(phaseLabel(sdlcMission, [], { ...plan, latestPlanChangeSequence: 5 }), "Planning");
});

test("v7 goal-driven missions require durable discovery before planning", () => {
  const mission = { ...sdlcMission, recipe_version: 7 };
  assert.equal(phaseLabel(mission, [], {}), "Discovery");
  assert.equal(phaseLabel(mission, [], { discovery: { id: "discovery-1", sequence: 2 } }), "Planning");
  assert.equal(phaseLabel(mission, [], {
    discovery: { id: "discovery-2", sequence: 5 }, planFinalizedSequence: 4,
  }), "Planning");
});

test("mission stage waits for verification after implementation completes", () => {
  const work = [{ owner: "builder", status: "Done" }];
  const plan = { planFinalizedSequence: 1 };
  assert.equal(phaseLabel(sdlcMission, work, plan), "Checking");
  assert.equal(phaseLabel(sdlcMission, work, {
    ...plan,
    latestChange: { id: "change-1", sequence: 2 },
    latestSuccessfulTest: { id: "test-1", sequence: 3 },
  }), "Review");
});

test("mission stage requires review after the latest successful test and change", () => {
  const work = [{ owner: "builder", status: "Done" }];
  const context = {
    planFinalizedSequence: 1,
    latestChange: { id: "change-1", sequence: 2 },
    latestSuccessfulTest: { id: "test-1", sequence: 3 },
    latestReview: {
      id: "review-1", sequence: 4, disposition: "approved",
      verificationEventId: "test-1", changeEventId: "change-1",
    },
  };
  assert.equal(phaseLabel(sdlcMission, work, context), "Ready to finish");
  assert.equal(phaseLabel(sdlcMission, work, {
    ...context, latestChange: { id: "change-2", sequence: 5 },
  }), "Checking");
});

test("reviewer-owned work remains in review and other recipes have no SDLC stage", () => {
  const context = {
    planFinalizedSequence: 1,
    latestSuccessfulTest: { id: "test-1", sequence: 2 },
  };
  assert.equal(phaseLabel(sdlcMission, [{ owner: "reviewer", status: "Ready" }], context), "Review");
  assert.equal(phaseLabel({ recipe_id: "bug-fix", status: "active" }, [], {}), null);
  assert.equal(phaseLabel({ ...sdlcMission, status: "completed" }, [], {}), "Complete");
});

test("live SDLC evidence advances the compact context without retaining event history", () => {
  let context = {};
  const add = (type, sequence, id, payload = {}) => {
    context = advanceMissionWorkflowContext(context, { type, sequence, id, payload });
  };
  add("sdlc.discovery.completed", 0, "discovery", {
    summary: "The repository has a Python API and a small React application.", evidence: [],
  });
  assert.equal(context.discovery.id, "discovery");
  add("plan.finalized", 1, "plan");
  add("repo.file.changed", 2, "change");
  add("repo.test_run.completed", 3, "failed-test", { exitCode: 1 });
  assert.equal(context.latestSuccessfulTest, undefined);
  add("repo.test_run.completed", 4, "test", { exitCode: 0 });
  assert.equal(context.latestTest.id, "test");
  add("review.checkpoint.recorded", 5, "review", {
    disposition: "approved", verificationEventId: "test", changeEventId: "change",
  });
  assert.equal(phaseLabel(sdlcMission, [], context), "Ready to finish");
  add("repo.test_run.completed", 6, "failed-after-review", { exitCode: 2 });
  assert.equal(phaseLabel(sdlcMission, [], context), "Checking");
  add("repo.test_run.completed", 7, "recheck", { exitCode: 0 });
  assert.equal(phaseLabel(sdlcMission, [], context), "Review");
  add("repo.worktree.integrated", 8, "integrated");
  assert.equal(phaseLabel(sdlcMission, [], context), "Checking");
});

test("mission refreshes preserve newer workflow evidence when responses omit or lag it", () => {
  const current = {
    id: "mission-1",
    status: "active",
    recipe_id: "goal-driven-sdlc",
    workflow_context: {
      planFinalizedSequence: 4,
      latestPlanChangeSequence: 3,
      latestChange: { id: "change-2", sequence: 8 },
      latestTest: { id: "test-2", sequence: 9, exitCode: 0 },
      latestSuccessfulTest: { id: "test-2", sequence: 9 },
      latestReview: {
        id: "review-1", sequence: 10, disposition: "approved",
        verificationEventId: "test-2", changeEventId: "change-2",
      },
    },
  };
  const omitted = preserveMissionWorkflowContext(current, {
    id: "mission-1", status: "paused", recipe_id: current.recipe_id,
  });
  assert.equal(phaseLabel(omitted, [], omitted.workflow_context), "Ready to finish");

  const lagging = mergeMissionWorkflowContext(current.workflow_context, {
    planFinalizedSequence: 4,
    latestChange: { id: "change-1", sequence: 7 },
    latestTest: { id: "test-failed", sequence: 11, exitCode: 1 },
  });
  assert.equal(lagging.latestChange.id, "change-2");
  assert.equal(lagging.latestTest.id, "test-failed");
  assert.equal(phaseLabel(sdlcMission, [], lagging), "Checking");
  assert.equal(lagging.latestReview.id, "review-1");
  assert.equal(preserveMissionWorkflowContext(current, { id: "mission-2" }).workflow_context, undefined);
});
