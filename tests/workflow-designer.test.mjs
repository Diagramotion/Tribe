import test from "node:test";
import assert from "node:assert/strict";
import { flowTextFromWorkflow, isSequentialWorkflow, parseWorkflowFlowText, sequentialWorkflow, validateWorkflowDraft, workflowToDraft } from "../src/domain/workflow-designer.js";

const valid = {
  id: "research-loop", title: "Research loop", description: "Gather and assess evidence.",
  objective: "Make a supported recommendation.", instructions: "Prefer primary sources.",
  initial_stage: "frame", terminal_stages: ["share"],
  stages: [
    { id: "frame", title: "Frame", guide: "Set scope.", transitions: [{ to: "collect", when: "Scope set" }] },
    { id: "collect", title: "Collect", transitions: [{ to: "collect", when: "Evidence gap" }, { to: "share", when: "Enough evidence" }] },
    { id: "share", title: "Share", transitions: [] },
  ],
};

test("workflow validation accepts branches and loops while rejecting broken references", () => {
  assert.deepEqual(validateWorkflowDraft(valid), []);
  const broken = structuredClone(valid);
  broken.stages[1].transitions[0].to = "missing";
  assert.match(validateWorkflowDraft(broken).join(" "), /missing stage/);
});

test("workflow validation reports duplicate stage IDs and invalid endpoints", () => {
  const broken = structuredClone(valid);
  broken.stages[2].id = "collect";
  broken.initial_stage = "absent";
  assert.match(validateWorkflowDraft(broken).join(" "), /used more than once/);
  assert.match(validateWorkflowDraft(broken).join(" "), /Connect Start/);
});

test("sequential stages get implicit next and end connections", () => {
  const stages = sequentialWorkflow(valid.stages);
  assert.deepEqual(stages[0].transitions, [{ to: "collect", when: "" }]);
  assert.deepEqual(stages[2].transitions, []);
  assert.equal(isSequentialWorkflow(stages, "frame", ["share"]), true);
});

test("a simple list of stages is enough to define a workflow", () => {
  const draft = { ...valid, instructions: "", stages: [{ id: "frame", title: "Frame", guide: "", transitions: [] }], initial_stage: "frame", terminal_stages: ["frame"] };
  assert.deepEqual(validateWorkflowDraft(draft), []);
});

test("stored workflow graphs retain transition and Markdown detail", () => {
  const draft = workflowToDraft(valid);
  assert.deepEqual(draft.stages[1].transitions, [
    { to: "collect", when: "Evidence gap" },
    { to: "share", when: "Enough evidence" },
  ]);
  assert.equal(draft.stages[0].guide, "Set scope.");
});

test("Mermaid-style flow text round-trips branches and return paths", () => {
  const text = flowTextFromWorkflow(valid.stages, "frame", ["share"]);
  const parsed = parseWorkflowFlowText(text, valid.stages);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.initial_stage, "frame");
  assert.deepEqual(parsed.terminal_stages, ["share"]);
  assert.deepEqual(parsed.stages[1].transitions, valid.stages[1].transitions);
  assert.equal(parsed.stages[0].guide, "Set scope.");
});

test("reserved text endpoints do not collide with valid stage IDs", () => {
  const stages = [
    { id: "start", title: "Start review", guide: "Keep this Markdown." },
    { id: "finish", title: "Finish", guide: "Done.", transitions: [] },
  ];
  stages[0].transitions = [{ to: "finish", when: "Ready" }];
  const parsed = parseWorkflowFlowText(flowTextFromWorkflow(stages, "start", ["finish"]), stages);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.stages.map((stage) => stage.id), ["start", "finish"]);
  assert.equal(parsed.initial_stage, "start");
  assert.deepEqual(parsed.terminal_stages, ["finish"]);
});

test("text editor reports unsupported syntax without discarding stage data", () => {
  const parsed = parseWorkflowFlowText("flowchart TD\nthis is not a flow", valid.stages);
  assert.match(parsed.errors.join(" "), /Line 2/);
  assert.equal(parsed.stages.length, 0);
});
