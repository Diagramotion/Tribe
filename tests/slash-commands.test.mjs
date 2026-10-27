import test from "node:test";
import assert from "node:assert/strict";
import { insertSlashCommand, parseMissionPrompt, slashCommandOptions } from "../src/domain/slash-commands.js";

const recipes = [
  { id: "goal-driven-sdlc", title: "Goal-driven SDLC", description: "Plan and verify." },
  { id: "bug-fix", title: "Bug fix", description: "Fix a defect." },
];
const skills = [
  { id: "skill-123", name: "Analytics Dashboard", description: "Build dashboards." },
];

test("plain chat has no mode or skill directives", () => {
  assert.deepEqual(parseMissionPrompt("Explain this project", recipes, skills), {
    text: "Explain this project", recipeId: null, selectedSkills: [],
  });
});

test("goal, workflow and skill slash commands are removed from the user message", () => {
  assert.deepEqual(parseMissionPrompt("/goal /skill analytics-dashboard Improve onboarding", recipes, skills), {
    text: "Improve onboarding", recipeId: "goal-driven-sdlc", selectedSkills: ["skill-123"],
  });
  assert.deepEqual(parseMissionPrompt("/workflow bug-fix Fix the login regression", recipes, skills), {
    text: "Fix the login regression", recipeId: "bug-fix", selectedSkills: [],
  });
});

test("slash menu lists commands and inserts at the active token", () => {
  const options = slashCommandOptions("/workflow ", recipes, skills);
  assert.equal(options.length, 1);
  assert.equal(options.some((option) => option.insert === "/workflow bug-fix "), true);
  assert.equal(insertSlashCommand("/workflow bug", "/workflow bug-fix "), "/workflow bug-fix ");
  assert.deepEqual(slashCommandOptions("/workflow bug-fix ", recipes, skills), []);
});

test("ambiguous or unknown directives fail before mission creation", () => {
  assert.match(parseMissionPrompt("/goal /workflow bug-fix Fix this", recipes, skills).error, /either goal mode/);
  assert.match(parseMissionPrompt("/workflow missing Fix this", recipes, skills).error, /not available/);
  assert.match(parseMissionPrompt("/skill unknown Fix this", recipes, skills).error, /not available/);
});
