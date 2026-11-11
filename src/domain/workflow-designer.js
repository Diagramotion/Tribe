export const workflowIdPattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const START_MARKER = "__start__";
const END_MARKER = "__end__";

export function workflowToDraft(workflow = null) {
  const stages = (workflow?.stages ?? []).map((stage) => ({
    id: stage.id ?? "",
    title: stage.title ?? "",
    objective: stage.objective ?? "",
    guide: stage.guide ?? "",
    rules: [...(stage.rules ?? [])],
    position: stage.position ? { ...stage.position } : undefined,
    transitions: (stage.transitions ?? []).map((edge) => typeof edge === "string"
      ? { to: edge, when: "" }
      : { to: edge.to ?? "", when: edge.when ?? "" }),
  }));
  return {
    id: workflow?.id ?? "",
    title: workflow?.title ?? "",
    description: workflow?.description ?? "",
    objective: workflow?.objective ?? workflow?.description ?? "",
    instructions: workflow?.instructions ?? "",
    rules: [...(workflow?.rules ?? [])],
    tags: [...(workflow?.tags ?? [])],
    initial_stage: workflow?.initial_stage ?? stages[0]?.id ?? "",
    terminal_stages: [...(workflow?.terminal_stages ?? [])],
    stages,
  };
}

export function isSequentialWorkflow(stages, initialStage, terminalStages) {
  if (!stages.length) return true;
  if (initialStage !== stages[0]?.id || terminalStages.length !== 1 || terminalStages[0] !== stages.at(-1)?.id) return false;
  return stages.every((stage, index) => {
    const expected = index < stages.length - 1 ? [stages[index + 1].id] : [];
    return (stage.transitions ?? []).length === expected.length
      && (stage.transitions ?? []).every((edge, edgeIndex) => (typeof edge === "string" ? edge : edge.to) === expected[edgeIndex]);
  });
}

export function sequentialWorkflow(stages) {
  return stages.map((stage, index) => ({
    ...stage,
    transitions: index < stages.length - 1 ? [{ to: stages[index + 1].id, when: "" }] : [],
  }));
}

export function flowTextFromWorkflow(stages, initialStage, terminalStages) {
  const lines = ["flowchart TD"];
  for (const stage of stages) lines.push(`  ${stage.id}[${JSON.stringify(stage.title || stage.id)}]`);
  lines.splice(1, 0, `  ${START_MARKER}([Start])`);
  lines.push(`  ${END_MARKER}([End])`);
  if (initialStage) lines.push(`  ${START_MARKER} --> ${initialStage}`);
  for (const stage of stages) {
    for (const edge of stage.transitions ?? []) {
      const to = typeof edge === "string" ? edge : edge.to;
      const when = typeof edge === "string" ? "" : edge.when;
      lines.push(`  ${stage.id} -->${when ? `|${when.replaceAll("|", "\\|")}|` : ""} ${to}`);
    }
  }
  for (const id of terminalStages) lines.push(`  ${id} --> ${END_MARKER}`);
  return lines.join("\n");
}

export function parseWorkflowFlowText(source, currentStages = []) {
  const errors = [];
  const definitions = new Map();
  const edges = [];
  const ensureNode = (id, title = "") => {
    if (id === START_MARKER || id === END_MARKER) return;
    if (!workflowIdPattern.test(id)) { errors.push(`“${id}” is not a valid stage ID.`); return; }
    if (!definitions.has(id)) definitions.set(id, title || id);
    else if (title) definitions.set(id, title);
  };
  const skipSpaces = (line, offset) => { while (offset < line.length && /\s/.test(line[offset])) offset += 1; return offset; };
  const readNode = (line, offset) => {
    const start = offset;
    while (offset < line.length && /[a-zA-Z0-9_-]/.test(line[offset])) offset += 1;
    if (offset === start) return null;
    const id = line.slice(start, offset);
    let label = "";
    if (line[offset] === "[") {
      const end = line.indexOf("]", offset + 1);
      if (end < 0) return null;
      label = line.slice(offset + 1, end);
      offset = end + 1;
    } else if (line.startsWith("([", offset)) {
      const end = line.indexOf("])" , offset + 2);
      if (end < 0) return null;
      label = line.slice(offset + 2, end);
      offset = end + 2;
    }
    return { id, label, offset };
  };
  const decodeLabel = (id, rawLabel) => {
    let label = rawLabel;
    try { if (label.startsWith('"') || label.startsWith("'")) label = JSON.parse(label.startsWith("'") ? `"${label.slice(1, -1).replaceAll('"', '\\"')}"` : label); }
    catch { errors.push(`Could not read the label for “${id}”.`); }
    return { id, label: String(label) };
  };
  const parseNode = (line) => {
    const node = readNode(line, skipSpaces(line, 0));
    if (!node || skipSpaces(line, node.offset) !== line.length) return null;
    return decodeLabel(node.id, node.label);
  };
  const parseEdge = (line) => {
    let offset = skipSpaces(line, 0);
    const from = readNode(line, offset);
    if (!from) return null;
    offset = skipSpaces(line, from.offset);
    if (!line.startsWith("-->", offset)) return null;
    offset = skipSpaces(line, offset + 3);
    let when = "";
    if (line[offset] === "|") {
      offset += 1;
      let branch = "";
      let closed = false;
      while (offset < line.length) {
        if (line[offset] === "\\" && line[offset + 1] === "|") { branch += "|"; offset += 2; }
        else if (line[offset] === "|") { offset += 1; closed = true; break; }
        else branch += line[offset++];
      }
      if (!closed) return null;
      when = branch.trim();
    }
    offset = skipSpaces(line, offset);
    const to = readNode(line, offset);
    if (!to || skipSpaces(line, to.offset) !== line.length) return null;
    return { from: decodeLabel(from.id, from.label), to: decodeLabel(to.id, to.label), when };
  };
  for (const [lineIndex, raw] of String(source ?? "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("%%") || /^flowchart\s+(TD|TB|LR|RL|BT)$/i.test(line)) continue;
    const parsedEdge = parseEdge(line);
    if (parsedEdge) {
      const { from, to } = parsedEdge;
      ensureNode(from.id, from.label);
      ensureNode(to.id, to.label);
      edges.push({ from: from.id, to: to.id, when: parsedEdge.when });
      continue;
    }
    const node = parseNode(line);
    if (node) { ensureNode(node.id, node.label); continue; }
    errors.push(`Line ${lineIndex + 1} is not supported. Use “stage[Title] -->|Condition| next_stage”.`);
  }
  const starts = edges.filter((edge) => edge.from === START_MARKER).map((edge) => edge.to).filter((id) => id !== END_MARKER);
  const terminal = new Set(edges.filter((edge) => edge.to === END_MARKER).map((edge) => edge.from));
  const transitions = new Map([...definitions.keys()].map((id) => [id, []]));
  for (const edge of edges) {
    if (edge.from === START_MARKER || edge.to === END_MARKER) continue;
    if (!definitions.has(edge.from) || !definitions.has(edge.to)) { errors.push(`Transition “${edge.from} → ${edge.to}” refers to a missing stage.`); continue; }
    transitions.get(edge.from).push({ to: edge.to, when: edge.when });
  }
  if (starts.length > 1) errors.push("Connect Start to one first stage.");
  const currentById = new Map(currentStages.map((stage) => [stage.id, stage]));
  const stages = [...definitions].map(([id, title]) => ({
    ...(currentById.get(id) ?? { objective: "", guide: "", rules: [] }),
    id, title, transitions: transitions.get(id),
  }));
  return {
    stages,
    initial_stage: starts[0] ?? stages[0]?.id ?? "",
    terminal_stages: [...terminal],
    errors: [...new Set(errors)],
  };
}

export function validateWorkflowDraft(draft) {
  const errors = [];
  const id = String(draft.id ?? "").trim();
  if (!workflowIdPattern.test(id)) errors.push("Use a workflow ID with 2–64 lowercase letters, digits, underscores or hyphens.");
  if (!String(draft.title ?? "").trim()) errors.push("Add a workflow name.");
  if (!String(draft.description ?? "").trim()) errors.push("Add a short summary.");
  if (!String(draft.objective ?? "").trim()) errors.push("Add an objective.");
  const stages = Array.isArray(draft.stages) ? draft.stages : [];
  if (stages.length > 20) errors.push("A workflow can have up to 20 stages.");
  const ids = new Set();
  for (const [index, stage] of stages.entries()) {
    const stageId = String(stage.id ?? "").trim();
    if (!workflowIdPattern.test(stageId)) errors.push(`Stage ${index + 1} needs a valid ID.`);
    else if (ids.has(stageId)) errors.push(`Stage ID “${stageId}” is used more than once.`);
    ids.add(stageId);
    if (!String(stage.title ?? "").trim()) errors.push(`Stage ${index + 1} needs a title.`);
  }
  if (stages.length) {
    if (!ids.has(String(draft.initial_stage ?? "").trim())) errors.push("Connect Start to a stage.");
    const terminals = Array.isArray(draft.terminal_stages) ? draft.terminal_stages : [];
    if (!terminals.length) errors.push("Connect at least one stage to End.");
    for (const terminal of terminals) if (!ids.has(terminal)) errors.push(`Ending stage “${terminal}” does not exist.`);
    for (const stage of stages) for (const edge of stage.transitions ?? []) {
      if (!ids.has(String(edge.to ?? "").trim())) errors.push(`Transition from “${stage.title || stage.id}” points to a missing stage.`);
    }
  }
  if (!String(draft.instructions ?? "").trim() && !stages.some((stage) => String(stage.guide ?? "").trim()) && !stages.length) {
    errors.push("Add at least one stage or some overall guidance.");
  }
  return [...new Set(errors)];
}
