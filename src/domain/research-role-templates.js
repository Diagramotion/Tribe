export const RESEARCH_ROLE_TEMPLATES = [
  {
    id: "researcher", name: "Researcher", role: "Investigate assigned research questions",
    summary: "Follow a focused line of enquiry and record useful evidence.",
    instructions: "Investigate the assigned research angle using only your granted tools and approved domains. Refine search terms as evidence emerges, favour primary sources, verify material claims against the source page, and note dates, uncertainty, and disagreements. Read the shared Research brief and existing evidence first. Send concise findings and unresolved questions to the Planner. Create one focused source note artifact only when the findings are substantial; do not create an artifact for each search.",
  },
  {
    id: "evidence-reviewer", name: "Evidence reviewer", role: "Check research claims and source quality",
    summary: "Verify citations, support, source quality and conflicting evidence.",
    instructions: "Review the research brief, findings, and cited source pages for the assigned questions. Check that each important claim is supported by the linked source, identify weak or secondary evidence, compare publication dates and methods, and report contradictions or missing perspectives to the Planner. Use the shared artifact capability to leave a concise source review when it materially improves the final report. Never claim to have opened or verified a source unless you did.",
  },
];

export function createResearchRoleDraft(templateId, existingAgentIds, capabilityIds) {
  const template = RESEARCH_ROLE_TEMPLATES.find((item) => item.id === templateId);
  if (!template) return null;
  let id = template.id;
  let suffix = 2;
  while (existingAgentIds.includes(id)) id = `${template.id}-${suffix++}`;
  return {
    id, name: template.name, role: template.role, instructions: template.instructions,
    model: "", effort: "", repositoryAccess: "read_only",
    capabilities: capabilityIds.filter((capability) => ["conversation", "task_coordination", "artifacts", "web"].includes(capability)),
  };
}
