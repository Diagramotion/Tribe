const skillSlug = (name) => name.toLowerCase().normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function slashCommandOptions(input, recipes = [], skills = []) {
  const match = input.match(/(?:^|\s)\/([a-z-]*)(?:\s+([^\s]*))?$/i);
  if (!match) return [];
  const command = match[1].toLowerCase();
  const argument = match[2]?.toLowerCase() ?? "";
  const hasArgumentSlot = /\s$/.test(input);
  const commands = [
    { id: "goal", label: "Goal mode", description: "Plan, build, verify and review a larger outcome.", insert: "/goal " },
    { id: "workflow", label: "Choose a workflow", description: "Use saved guidance to shape how this chat is handled.", insert: "/workflow " },
    { id: "skill", label: "Choose a skill", description: "Add a specialised capability for this chat.", insert: "/skill " },
    ...recipes.filter((recipe) => recipe.id !== "goal-driven-sdlc").map((recipe) => ({
      id: `workflow:${recipe.id}`, label: recipe.title,
      description: `${recipe.description} · v${recipe.version}`, insert: `/workflow ${recipe.id} `,
    })),
    ...skills.map((skill) => ({
      id: `skill:${skill.id}`, label: skill.name,
      description: skill.description, insert: `/skill ${skillSlug(skill.name)} `,
    })),
  ];
  const commandGroups = commands.filter((item) => item.id === "goal"
    || (item.id === "workflow" && commands.some((option) => option.id.startsWith("workflow:")))
    || (item.id === "skill" && commands.some((option) => option.id.startsWith("skill:"))));
  if (!command) return commandGroups;
  if (command === "goal") return hasArgumentSlot ? [] : commands.filter((item) => item.id === "goal");
  if (command === "workflow") {
    const workflows = commands.filter((item) => item.id.startsWith("workflow:"));
    if (hasArgumentSlot) return argument ? [] : workflows;
    return workflows.filter((item) => item.insert.toLowerCase().includes(argument));
  }
  if (command === "skill") {
    const availableSkills = commands.filter((item) => item.id.startsWith("skill:"));
    if (hasArgumentSlot) return argument ? [] : availableSkills;
    return availableSkills.filter((item) => item.insert.toLowerCase().includes(argument));
  }
  return hasArgumentSlot ? [] : commandGroups.filter((item) => item.insert.slice(1).trim().toLowerCase().startsWith(command));
}

export function insertSlashCommand(input, insert) {
  return input.replace(/(?:^|\s)\/[a-z-]*(?:\s+[^\s]*)?$/i, (match) => {
    const prefix = match.match(/^\s*/)?.[0] ?? "";
    return `${prefix}${insert}`;
  });
}

export function parseMissionPrompt(input, recipes = [], skills = []) {
  let text = input;
  let recipeId = null;
  let selectedWorkflowVersion = null;
  const selectedSkills = [];
  const goalMatches = [...text.matchAll(/(?:^|\s)\/goal(?=\s|$)/gi)];
  const workflowMatches = [...text.matchAll(/(?:^|\s)\/workflow\s+([a-z0-9_-]+)(?:@v?(\d+))?(?=\s|$)/gi)];
  const skillMatches = [...text.matchAll(/(?:^|\s)\/skill\s+([a-z0-9-]+)(?=\s|$)/gi)];
  if (goalMatches.length + workflowMatches.length > 1 || (goalMatches.length && workflowMatches.length)) {
    return { error: "Choose either goal mode or one workflow." };
  }
  if (workflowMatches.length) {
    recipeId = workflowMatches.at(-1)[1];
    const rawVersion = workflowMatches.at(-1)[2];
    if (rawVersion && (!Number.isSafeInteger(Number(rawVersion)) || Number(rawVersion) < 1)) {
      return { error: "Choose a valid saved workflow version." };
    }
    const recipeVersion = rawVersion ? Number(rawVersion) : null;
    if (!recipes.some((recipe) => recipe.id === recipeId)) return { error: "That workflow is not available in this project." };
    if (recipeVersion) selectedWorkflowVersion = recipeVersion;
  } else if (goalMatches.length) {
    recipeId = "goal-driven-sdlc";
  }
  for (const match of skillMatches) {
    const skill = skills.find((item) => skillSlug(item.name) === match[1].toLowerCase());
    if (!skill) return { error: `Skill “${match[1]}” is not available in this project.` };
    selectedSkills.push(skill.id);
  }
  text = text
    .replace(/(?:^|\s)\/goal(?=\s|$)/gi, " ")
    .replace(/(?:^|\s)\/workflow\s+[a-z0-9_-]+(?:@v?\d+)?(?=\s|$)/gi, " ")
    .replace(/(?:^|\s)\/skill\s+[a-z0-9-]+(?=\s|$)/gi, " ")
    .replace(/[ \t]+/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
  if (!text) return { error: "Add a message after the slash command." };
  return { text, recipeId, recipeVersion: selectedWorkflowVersion ?? null, selectedSkills: [...new Set(selectedSkills)] };
}
