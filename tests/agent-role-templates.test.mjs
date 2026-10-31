import assert from "node:assert/strict";
import test from "node:test";
import { createResearchRoleDraft, RESEARCH_ROLE_TEMPLATES as researchRoleTemplates } from "../src/domain/research-role-templates.js";

test("research role templates create reusable read-only roles with focused grants", () => {
  assert.deepEqual(researchRoleTemplates.map(({ name }) => name), ["Researcher", "Evidence reviewer"]);
  for (const template of researchRoleTemplates) {
    const draft = createResearchRoleDraft(template.id, [], [
      "conversation", "task_coordination", "artifacts", "web", "repository_write", "computer_observation",
    ]);
    assert.equal(draft.repositoryAccess, "read_only");
    assert.deepEqual(draft.capabilities, ["conversation", "task_coordination", "artifacts", "web"]);
    assert.match(draft.instructions, /source/i);
  }
});

test("research role templates avoid key collisions when profiles already exist", () => {
  const draft = createResearchRoleDraft("researcher", ["researcher", "researcher-2"], [
    "conversation", "task_coordination", "artifacts", "web",
  ]);
  assert.equal(draft.id, "researcher-3");
  assert.equal(createResearchRoleDraft("unknown", [], []), null);
});
