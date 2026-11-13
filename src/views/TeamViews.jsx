import { useEffect, useState } from "react";
import { Archive, MagnifyingGlass, PencilSimple, Plug, Plus, Sparkle, X } from "@phosphor-icons/react";
import { AgentIcon } from "./MissionView.jsx";
import { IconButton } from "../components/WorkspaceSidebar.jsx";
import { SelectControl } from "../components/SelectControl.jsx";
import { runtime } from "../api/runtime.js";
import { agentStatusLabel } from "../domain/labels.js";
import { modelDisplayName, sortModelCatalog } from "../domain/model-catalog.js";
import { createResearchRoleDraft, RESEARCH_ROLE_TEMPLATES } from "../domain/research-role-templates.js";

const skillAcronyms = { ai: "AI", api: "API", cli: "CLI", css: "CSS", gfm: "GFM", html: "HTML", ios: "iOS", mcp: "MCP", pdf: "PDF", sql: "SQL", ui: "UI", url: "URL", ux: "UX" };
const skillSummaries = {
  "design-qa": "Compare a finished interface with its design reference and find visual gaps.",
  explore: "Explore creative directions, campaigns and production ideas from a brief.",
  "figma-code-workflows": "Import HTML or a project into Figma as editable designs or runnable code.",
  "figma-create-new-file": "Create a Figma design, FigJam board or slide deck.",
  "figma-design-to-code": "Turn a Figma design into a responsive frontend.",
  "figma-generate-design": "Create full-page Figma designs using an existing design system.",
  "figma-generate-diagram": "Create diagrams for flows, schemas and system concepts in FigJam.",
  "figma-generate-library": "Build reusable components, variables and design tokens in Figma.",
  "figma-generative-plugins": "Build reusable Figma plugins for creative workflows.",
  "figma-shaders": "Create or refine shader effects and fills in Figma.",
  "figma-spec": "Create, edit and review product and design specifications.",
  "figma-use-figjam": "Create and edit FigJam boards and diagrams.",
  "figma-use-motion": "Translate Figma animations into application code.",
  "figma-use-slides": "Create and edit slide decks in Figma.",
  "get-context": "Clarify the goal, visual direction and interaction needs before design work.",
  index: "Find the right design or research workflow for the task.",
  intake: "Choose a creative workflow from the project brief.",
  "logo-explorer": "Explore logo and visual identity directions.",
  "moodboard-explorer": "Develop mood boards and visual territories for a brand or campaign.",
  "offer-explorer": "Explore product offers and campaign directions.",
  produce: "Create or refine brand, campaign and product assets.",
  spreadsheets: "Create, edit, analyse and visualise spreadsheets.",
};

function skillDisplayName(name) {
  return name.replace(/^artifact-template-/, "").split(/[-_]+/).map((word, index) => {
    const lower = word.toLowerCase();
    return skillAcronyms[lower] ?? (index === 0 ? `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}` : lower);
  }).join(" ");
}

function skillSummary(skill) {
  const curated = skillSummaries[skill.name.toLowerCase()];
  if (curated) return curated;
  const operationalText = /\b(?:mandatory prerequisite|must invoke|must trigger|never call|tool call|MCP tool|call this tool|use \/skill|internal prototype QA helper|critical instructions|exact skill name|both skills should be loaded together|generic code .*clarification)\b/i;
  const operationalStart = /^\s*(?:(?:also|always)\s+)?(?:mandatory\b|use (?:this skill|when|before|only|to discover|skill when)|trigger(?:s)?\b|example prompts\b|you must\b|must\b|never call\b|do not use\b|can be used alongside\b|load alongside\b|route(?:s)? to\b|this skill\b|generic code\b|both skills should\b)/i;
  const sentences = (skill.description ?? "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  const summary = sentences
    .filter((sentence) => !operationalStart.test(sentence) && !operationalText.test(sentence))
    .join(" ")
    .replace(/\*\*?|__?|~~|`/g, "")
    .trim();
  return summary || `Focused guidance for ${skillDisplayName(skill.name)}.`;
}

function agentStatusTone(status) {
  if (["Provider setup failed", "Needs attention"].includes(status)) return "error";
  if (["Not configured", "Waiting for budget", "Waiting for you"].includes(status)) return "attention";
  if (["Working", "Stopping", "Pausing"].includes(status)) return "active";
  if (status === "Ready") return "ready";
  return "neutral";
}

export function SkillsView({ skills }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("All");
  const projectSkills = skills.filter((skill) => skill.source.startsWith("Project"));
  const workspaceSkills = skills.filter((skill) => !skill.source.startsWith("Project"));
  const visibleSkills = skills.filter((skill) => {
    const matchesScope = scope === "All" || (scope === "Project" ? skill.source.startsWith("Project") : !skill.source.startsWith("Project"));
    return matchesScope && `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(query.trim().toLowerCase());
  });
  const skillGroups = [...new Map(visibleSkills.map((skill) => {
    const source = skill.source.replace(/^(User|Workspace)\s*·\s*/, "").replace(/^Codex plugin$/, "Codex plugins");
    return [source, []];
  })).keys()].map((source) => ({
    source,
    skills: visibleSkills.filter((skill) => skill.source.replace(/^(User|Workspace)\s*·\s*/, "").replace(/^Codex plugin$/, "Codex plugins") === source),
  }));
  const emptyMessage = query.trim()
    ? "No skills match this search."
    : scope === "Project"
      ? "No project-specific skills yet."
      : scope === "Workspace"
        ? "No shared workspace skills yet."
        : "No skills available yet. Skills in this project and your local skill folders will appear here.";
  return (
    <section className="tab-panel detail-view skills-view">
      <div className="detail-heading skills-heading"><div><h2 className="visually-hidden">Skills</h2><p>Shared skills work across projects. Repository skills add project-specific guidance.</p></div>{query.trim() && <span className="artifact-count">{visibleSkills.length} results</span>}</div>
      <div className="skills-toolbar">
        <label className="skills-search"><MagnifyingGlass size={16} /><input aria-label="Search skills" onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" value={query} />{query && <button aria-label="Clear search" onClick={() => setQuery("")} type="button"><X size={14} /></button>}</label>
        <div aria-label="Filter skills by scope" className="skills-scope-filter" role="group">
          {[{ label: "All", count: skills.length }, { label: "Workspace", count: workspaceSkills.length }, { label: "Project", count: projectSkills.length }].map((item) => <button aria-pressed={scope === item.label} className={scope === item.label ? "skills-scope--selected" : ""} key={item.label} onClick={() => setScope(item.label)} type="button">{item.label}<small>{item.count}</small></button>)}
        </div>
      </div>
      <div className="skill-groups">
        {skillGroups.map(({ source, skills: groupSkills }) => <section aria-label={`${source} skills`} className="skill-group" key={source}>
          <header className="skill-group-heading"><h2>{source}</h2><span>{groupSkills.length}</span></header>
          <div className="skill-grid">
            {groupSkills.map((skill) => {
              const summary = skillSummary(skill);
              return <article className="skill-card" key={skill.id}>
                <span className="skill-icon">{source.toLowerCase().includes("plugin") ? <Plug size={15} /> : <Sparkle size={15} />}</span>
                <div className="skill-card-copy"><strong aria-label={`${skillDisplayName(skill.name)}, exact skill name ${skill.name}`} title={`Use /skill ${skill.name}`}>{skillDisplayName(skill.name)}</strong>{summary && <p title={summary}>{summary}</p>}</div>
              </article>;
            })}
          </div>
        </section>)}
        {visibleSkills.length === 0 && <div className="column-empty skill-empty">{emptyMessage}</div>}
      </div>
    </section>
  );
}

export function AgentRolesView({ agents, capabilityCatalog = [], agentConfigured, projectAgentIds, onCreate, onUpdate, onArchive, onUpdateProjectTeam, onConnectModel, onManageModels }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [repositoryAccess, setRepositoryAccess] = useState("workspace_write");
  const [capabilities, setCapabilities] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updatingAgentId, setUpdatingAgentId] = useState(null);
  const [modelCatalog, setModelCatalog] = useState([]);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState("");
  const projectScoped = Array.isArray(projectAgentIds);
  const researchCapabilities = ["conversation", "task_coordination", "artifacts", "web"]
    .filter((capability) => capabilityCatalog.some((item) => item.id === capability));

  useEffect(() => {
    let current = true;
    setModelCatalogLoading(true);
    runtime.getModelCatalog().then(({ models = [] }) => {
      if (current) setModelCatalog(models.filter((entry) => entry.allowed && entry.toolCalling !== false));
    }).catch((error) => {
      if (current) setModelCatalogError(error.message || "Could not load allowed models.");
    }).finally(() => {
      if (current) setModelCatalogLoading(false);
    });
    return () => { current = false; };
  }, []);

  const selectedModelMetadata = modelCatalog.find((entry) => entry.id === model);
  const modelEffortsKnown = Array.isArray(selectedModelMetadata?.reasoningEfforts);
  const agentEffortLevels = modelEffortsKnown
    ? selectedModelMetadata.reasoningEfforts
    : ["minimal", "low", "medium", "high", "xhigh", "max"];
  const effortLevelsVerified = Boolean(model && modelEffortsKnown);
  const effortHelperText = model && selectedModelMetadata && modelEffortsKnown && agentEffortLevels.length === 0
    ? "No effort levels are listed for this model."
    : model && !selectedModelMetadata
      ? "Supported levels are unknown for this model. Common values are unverified; check the provider before pinning one."
      : model && !modelEffortsKnown
        ? "This model’s supported levels are unknown. Common values are unverified; check the provider before pinning one."
        : !model
          ? "Leave blank to inherit the chat effort. Common values are unverified until a chat’s effective model is known."
          : "Leave blank to inherit the chat effort; Auto uses the model default. An explicit role effort takes precedence.";

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const definition = { id: id.trim(), name: name.trim(), role: role.trim(), instructions: instructions.trim(), model: model.trim(), effort, repositoryAccess, capabilities };
      const saved = editingId
        ? await onUpdate(editingId, { name: definition.name, role: definition.role, instructions: definition.instructions, model: definition.model, effort: definition.effort, repositoryAccess: definition.repositoryAccess, capabilities: definition.capabilities })
        : await onCreate(definition);
      if (saved) {
        setId("");
        setName("");
        setRole("");
        setInstructions("");
        setModel("");
        setEffort("");
        setRepositoryAccess("workspace_write");
        setCapabilities([]);
        setEditingId(null);
        setFormOpen(false);
      }
    } finally {
      setSaving(false);
    }
  }

  function edit(agent) {
    setEditingId(agent.id);
    setFormOpen(true);
    setId(agent.id);
    setName(agent.name);
    setRole(agent.role);
    setInstructions(agent.instructions);
    setModel(agent.model ?? "");
    setEffort(agent.effort ?? "");
    setRepositoryAccess(agent.repository_access ?? "workspace_write");
    setCapabilities(agent.capabilities ?? []);
    window.requestAnimationFrame(() => document.getElementById("agent-role-form")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function cancelEdit() {
    setEditingId(null);
    setId("");
    setName("");
    setRole("");
    setInstructions("");
    setModel("");
    setEffort("");
    setRepositoryAccess("workspace_write");
    setCapabilities([]);
    setFormOpen(false);
  }

  function applyRoleTemplate(template) {
    const draft = createResearchRoleDraft(
      template.id, agents.map((agent) => agent.id), researchCapabilities,
    );
    if (!draft) return;
    setId(draft.id);
    setName(draft.name);
    setRole(draft.role);
    setInstructions(draft.instructions);
    setModel(draft.model);
    setEffort(draft.effort);
    setRepositoryAccess(draft.repositoryAccess);
    setCapabilities(draft.capabilities);
  }

  return (
    <section className="tab-panel detail-view">
      <div className="detail-heading">
        <div><span className="eyebrow">{projectScoped ? "Project team" : "Workspace roles"}</span><h2>{projectScoped ? "Project team" : "Agent roles"}</h2><p>{projectScoped ? "Choose which reusable roles can work in this project. The Planner leads Deep Research; add focused researchers to the selected team below." : "Create reusable roles with a clear responsibility and the right level of repository access."}</p></div>
        <div className="agent-role-heading-actions"><span className="artifact-count">{projectScoped ? `${projectAgentIds.length} of ${agents.length} in team` : `${agents.length} roles`}</span>{!formOpen && !agentConfigured && <button className="button button--quiet" onClick={onConnectModel} type="button"><Plug size={15} /> Connect model</button>}{!formOpen && <IconButton className="agent-role-add" label="Add role" onClick={() => { setCapabilities([]); setFormOpen(true); }}><Plus size={17} /></IconButton>}</div>
      </div>
      {formOpen && <form className="knowledge-form agent-role-form" id="agent-role-form" onSubmit={submit}>
        <strong>{editingId ? `Edit ${name || editingId}` : "Create a role"}</strong>
        {!editingId && <div className="agent-role-templates"><span>Start with a research template</span><div>{RESEARCH_ROLE_TEMPLATES.map((template) => <button className="agent-role-template" key={template.id} onClick={() => applyRoleTemplate(template)} type="button"><MagnifyingGlass aria-hidden="true" size={15} /><span><strong>{template.name}</strong><small>{template.summary}</small></span></button>)}</div><small>Templates grant web research, shared artifacts and task coordination. Review the grants before saving.</small></div>}
        <div className="agent-role-fields">
          <label>Role key<input autoComplete="off" maxLength={50} onChange={(event) => setId(event.target.value)} pattern="[a-z][a-z0-9_-]*" placeholder="security-auditor" readOnly={Boolean(editingId)} required value={id} /><small>Used in agent-to-agent messages. This key stays fixed after creation.</small></label>
          <label>Name<input maxLength={200} onChange={(event) => setName(event.target.value)} placeholder="Security auditor" required value={name} /></label>
          <label>Role<input maxLength={200} onChange={(event) => setRole(event.target.value)} placeholder="Review security risks" required value={role} /></label>
        </div>
        <fieldset className="agent-tool-permissions">
          <legend>Capabilities</legend>
          <p>Grant groups of related tools. The role’s repository access and approval rules still apply. Image generation and data analysis are off for new roles; image generation may incur provider charges.</p>
          <div className="agent-tool-permission-actions">
            <button className="text-button" onClick={() => setCapabilities(capabilityCatalog.map((item) => item.id))} type="button">Allow all</button>
            <button className="text-button" onClick={() => setCapabilities([])} type="button">Clear all</button>
            <span>{capabilities.length} of {capabilityCatalog.length} allowed</span>
          </div>
          <div className="agent-tool-permission-grid">
            {capabilityCatalog.map((capability) => {
              const checked = capabilities.includes(capability.id);
              return <label className="agent-tool-permission" key={capability.id} title={capability.description}>
                <input aria-label={`Allow ${capability.name}`} checked={checked} onChange={() => setCapabilities((current) => checked ? current.filter((item) => item !== capability.id) : [...current, capability.id])} type="checkbox" />
                <span>{capability.name}</span>
              </label>;
            })}
          </div>
        </fieldset>
        <div className="agent-role-fields">
          <label>Model override (optional)<SelectControl onChange={(nextModel) => {
            setModel(nextModel);
            const nextMetadata = modelCatalog.find((entry) => entry.id === nextModel);
            if (effort && Array.isArray(nextMetadata?.reasoningEfforts) && !nextMetadata.reasoningEfforts.includes(effort)) setEffort("");
          }} options={[{ value: "", label: "Use the chat or workspace model" }, ...sortModelCatalog(modelCatalog.filter((entry) => entry.providerEnabled !== false && entry.allowed && entry.toolCalling !== false)).map((entry) => ({ value: entry.id, label: `${modelDisplayName(entry)} · ${entry.provider}` })), ...(model && !modelCatalog.some((entry) => entry.id === model) ? [{ value: model, label: `${model} · Current override` }] : [])]} size="full" value={model} /><small>{modelCatalogLoading ? "Loading allowed models…" : modelCatalogError ? "Could not load the model list; the saved override is preserved." : "Leave blank to inherit the chat choice; Auto uses the workspace default. A role model override always takes precedence."}</small>{!modelCatalogLoading && modelCatalog.length === 0 && !model && onManageModels && <button className="text-button agent-model-settings-link" onClick={onManageModels} type="button">Open model settings</button>}</label>
          <label>Reasoning effort<SelectControl disabled={Boolean(model && selectedModelMetadata && modelEffortsKnown && agentEffortLevels.length === 0)} onChange={setEffort} options={[{ value: "", label: "Use chat/model default" }, ...agentEffortLevels.map((level) => ({ value: level, label: `${level === "xhigh" ? "Extra high" : level[0].toUpperCase() + level.slice(1)}${effortLevelsVerified ? "" : " · unverified"}` })), ...(effort && !agentEffortLevels.includes(effort) ? [{ value: effort, label: `${effort} · Current override${effortLevelsVerified ? " · not listed" : " · unverified"}` }] : [])]} size="full" value={effort} /><small>{effortHelperText}</small>{!modelCatalogLoading && onManageModels && (!model || !selectedModelMetadata || !modelEffortsKnown) && <button className="text-button agent-model-settings-link" onClick={onManageModels} type="button">Review model capabilities</button>}</label>
        </div>
          <fieldset className="repository-access-picker">
            <legend>Repository access</legend>
            <div className="repository-access-options" role="radiogroup" aria-label="Repository access">
              <label className={`repository-access-option ${repositoryAccess === "read_only" ? "repository-access-option--selected" : ""}`}>
                <input aria-label="Read only" checked={repositoryAccess === "read_only"} name="repository-access" onChange={() => setRepositoryAccess("read_only")} type="radio" value="read_only" />
                <span><strong>Read only</strong><small>Inspect and verify</small></span>
              </label>
              <label className={`repository-access-option ${repositoryAccess === "workspace_write" ? "repository-access-option--selected" : ""}`}>
                <input aria-label="Can edit" checked={repositoryAccess === "workspace_write"} name="repository-access" onChange={() => setRepositoryAccess("workspace_write")} type="radio" value="workspace_write" />
                <span><strong>Can edit</strong><small>Change repository files</small></span>
              </label>
            </div>
            <small>Read-only roles can inspect and verify, but cannot change files or run repository commands.</small>
          </fieldset>
        <label>Instructions<textarea maxLength={20000} onChange={(event) => setInstructions(event.target.value)} placeholder="Describe what this teammate owns, how they should work with others, and what a good result looks like." required rows={5} value={instructions} /></label>
        <div className="agent-role-submit"><div><button className="button button--quiet" disabled={saving} onClick={cancelEdit} type="button">Cancel</button><button className="button button--primary" disabled={saving || !id.trim() || !name.trim() || !role.trim() || !instructions.trim()} type="submit">{saving ? "Saving…" : editingId ? "Save changes" : "Add role"}</button></div></div>
      </form>}
      <div className="agent-role-list">
        {agents.map((agent) => (
          <article className={`agent-role-card${projectScoped ? " agent-role-card--project-team" : ""}`} key={agent.id}>
            <span className={`agent-icon agent-icon--${agent.color}`}><AgentIcon agent={agent} size={18} /></span>
            <div><div className="agent-role-heading"><strong>{agent.name}</strong>{agent.source === "user" && <div className="agent-role-actions"><IconButton className="agent-role-edit-button" label={`Edit ${agent.name}`} onClick={() => edit(agent)}><PencilSimple size={15} /></IconButton><IconButton aria-label={`Archive ${agent.name}`} className="agent-archive-button" label={`Archive ${agent.name}`} onClick={() => onArchive(agent)}><Archive size={15} /></IconButton></div>}</div>{agent.role?.trim() && agent.role.trim().toLocaleLowerCase() !== agent.name.trim().toLocaleLowerCase() && <p>{agent.role}</p>}<small>{agent.source === "user" ? "Custom role" : "Built-in role"} · {agent.model || "Chat or workspace model"}{agent.effort ? ` · ${agent.effort === "xhigh" ? "Extra high" : agent.effort[0].toUpperCase() + agent.effort.slice(1)} effort` : ""} · {agent.repository_access === "read_only" ? "Read only" : "Can edit repository"}</small>
              {agent.instructions && <details><summary>Instructions</summary><pre>{agent.instructions}</pre></details>}
              <details><summary>Capabilities ({agent.capabilities?.length ?? 0})</summary><p>{(agent.capabilities ?? []).map((capabilityId) => capabilityCatalog.find((item) => item.id === capabilityId)?.name ?? capabilityId).join(", ") || "No capabilities are enabled for this role."}</p></details>
            </div>
            {projectScoped && (() => {
              const required = agent.id === "planner" || agent.role.trim().toLowerCase() === "planner";
              const included = projectAgentIds.includes(agent.id);
              return <label className="computer-access-toggle agent-role-team-toggle" title={required ? "The Planner is required for every project" : undefined}>
                <input aria-label={required ? `${agent.name} is required for this project team` : `${included ? "Remove" : "Add"} ${agent.name} ${included ? "from" : "to"} this project team`} checked={included} disabled={required || updatingAgentId === agent.id} onChange={async () => {
                  if (updatingAgentId) return;
                  setUpdatingAgentId(agent.id);
                  const next = included ? projectAgentIds.filter((id) => id !== agent.id) : [...projectAgentIds, agent.id];
                  try { await onUpdateProjectTeam?.(next); }
                  finally { setUpdatingAgentId(null); }
                }} role="switch" type="checkbox" />
                <span aria-hidden="true" className="computer-access-switch" />
                <span className="agent-role-team-label">{required ? "Required" : "In team"}</span>
              </label>;
            })()}
            <span className={`agent-role-status agent-role-status--${agentStatusTone(agent.status)}`}><i aria-hidden="true" />{agentStatusLabel(agent.status)}</span>
          </article>
        ))}
      </div>
    </section>
  );
}
