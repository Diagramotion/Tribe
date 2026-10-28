import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { IconButton } from "../components/WorkspaceSidebar.jsx";
import { MarkdownContent } from "../components/MarkdownContent.jsx";

const workflowIdPattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export function WorkflowsView({ recipes, onSave }) {
  const returnFocusRef = useRef(null);
  const idFieldRef = useRef(null);
  const nameFieldRef = useRef(null);
  const [selected, setSelected] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [recipeId, setRecipeId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [objective, setObjective] = useState("");
  const [instructions, setInstructions] = useState("");
  const [rules, setRules] = useState([]);
  const [tags, setTags] = useState("");
  const [initialStage, setInitialStage] = useState("");
  const [terminalStages, setTerminalStages] = useState("");
  const [stages, setStages] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const invalidRecipeId = recipeId.length > 0 && !workflowIdPattern.test(recipeId);

  useEffect(() => {
    if (!editorOpen && !recipes.some((recipe) => recipe.id === selected)) {
      setSelected(recipes[0]?.id ?? null);
    }
  }, [recipes, selected, editorOpen]);

  useLayoutEffect(() => {
    if (editorOpen) {
      (selected ? nameFieldRef.current : idFieldRef.current)?.focus();
      return;
    }
    const returnFocus = returnFocusRef.current;
    if (returnFocus?.isConnected) returnFocus.focus();
    else document.querySelector(".recipes-view .recipe-detail-heading [aria-label='Edit workflow']")?.focus();
    returnFocusRef.current = null;
  }, [editorOpen, selected]);

  function edit(recipe = null, event) {
    returnFocusRef.current = event?.currentTarget ?? document.activeElement;
    setSelected(recipe?.id ?? null);
    setRecipeId(recipe?.id ?? "");
    setTitle(recipe?.title ?? "");
    setDescription(recipe?.description ?? "");
    setObjective(recipe?.objective ?? recipe?.description ?? "");
    setInstructions(recipe?.instructions ?? "");
    setRules(recipe?.rules ?? []);
    setTags((recipe?.tags ?? []).join(", "));
    setInitialStage(recipe?.initial_stage ?? recipe?.stages?.[0]?.id ?? "");
    setTerminalStages((recipe?.terminal_stages ?? []).join(", "));
    setStages((recipe?.stages ?? []).map((stage) => ({
      id: stage.id ?? "", title: stage.title ?? "", objective: stage.objective ?? "",
      guide: stage.guide ?? "", rules: stage.rules ?? [],
      transitions: (stage.transitions ?? []).map((edge) => typeof edge === "string"
        ? edge : `${edge.to}${edge.when ? ` | ${edge.when}` : ""}`).join("\n"),
    })));
    setError("");
    setEditorOpen(true);
  }

  function showRecipe(recipe, event) {
    returnFocusRef.current = event.currentTarget;
    setSelected(recipe.id);
    setEditorOpen(false);
  }

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const usedIds = new Set();
      const saved = await onSave({
        id: recipeId, title, description, objective, instructions,
        rules: rules.map((rule) => rule.trim()).filter(Boolean),
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        initial_stage: initialStage.trim() || undefined,
        terminal_stages: terminalStages.trim()
          ? terminalStages.split(",").map((stageId) => stageId.trim()).filter(Boolean)
          : undefined,
        stages: stages.map((stage, index) => {
          const base = (stage.id.trim() || stage.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `stage-${index + 1}`;
          let id = base.slice(0, 64);
          let suffix = 2;
          while (usedIds.has(id)) id = `${base.slice(0, 58)}-${suffix++}`;
          usedIds.add(id);
          return {
            id, title: stage.title.trim(), objective: stage.objective.trim(), guide: stage.guide.trim(),
            rules: stage.rules.map((rule) => rule.trim()).filter(Boolean),
            transitions: stage.transitions.split("\n").map((line) => {
              const [to, ...when] = line.split("|");
              return { to: to.trim(), when: when.join("|").trim() };
            }).filter((transition) => transition.to),
          };
        }).filter((stage) => stage.title),
      });
      setSelected(saved.id);
      setEditorOpen(false);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return <section className="detail-view recipes-view">
    <div className="section-heading"><div><span className="eyebrow">Reusable workflows</span><h2 className="visually-hidden">Workflows</h2><p>Choose a workflow when you start a chat. Running chats keep the version they started with.</p></div><IconButton className="button--primary" label="New workflow" onClick={(event) => edit(null, event)}><Plus size={16} /></IconButton></div>
    <div className="recipes-layout">
      <div className="recipe-list" aria-label="Workflows">{recipes.map((recipe) => <button aria-pressed={selected === recipe.id && !editorOpen} className={`recipe-list-item ${selected === recipe.id && !editorOpen ? "recipe-list-item--active" : ""}`} key={recipe.id} onClick={(event) => showRecipe(recipe, event)} type="button"><span><strong>{recipe.title}</strong><small>{recipe.description}</small></span><em>v{recipe.version}</em></button>)}{recipes.length === 0 && <div className="recipe-list-empty"><strong>No workflows yet</strong><span>Create reusable instructions for chats that follow a repeatable process.</span></div>}</div>
      {editorOpen ? <form className="recipe-editor" onSubmit={submit}>
        <div className="recipe-editor-heading"><div><span className="eyebrow">{selected ? "Edit workflow" : "Create workflow"}</span><h3>{selected ? title || "Untitled workflow" : "New workflow"}</h3></div>{selected && <span className="recipe-source">{recipes.find((item) => item.id === selected)?.source === "builtin" ? "Built in · your changes create a copy" : "Your workflow"}</span>}</div>
        <label>Workflow ID<input aria-describedby={invalidRecipeId ? "workflow-id-error" : undefined} aria-invalid={invalidRecipeId || undefined} disabled={Boolean(selected)} maxLength={64} onChange={(event) => setRecipeId(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-"))} placeholder="e.g. release-readiness" ref={idFieldRef} value={recipeId} />{invalidRecipeId && <small className="field-hint field-hint--error" id="workflow-id-error">Use 2–64 lowercase letters or digits, underscores or hyphens, starting with a letter or number.</small>}</label>
        <label>Name<input maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="Release readiness" ref={nameFieldRef} value={title} /></label>
        <label>Summary<input maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="Prepare and verify a release candidate." value={description} /></label>
        <label>Objective<textarea maxLength={2000} onChange={(event) => setObjective(event.target.value)} placeholder="What outcome should this workflow guide agents towards?" rows={3} value={objective} /></label>
        <label>Overall guidance<textarea maxLength={20000} onChange={(event) => setInstructions(event.target.value)} placeholder="Give agents context, principles and process guidance." rows={8} value={instructions} /></label>
        <label>Overall rules<textarea maxLength={6000} onChange={(event) => setRules(event.target.value.split("\n"))} placeholder="One rule per line; leave empty when there are no extra rules." rows={3} value={rules.join("\n")} /></label>
        <label>Tags<input maxLength={2000} onChange={(event) => setTags(event.target.value)} placeholder="research, analysis" value={tags} /><small>Comma-separated labels used when finding a workflow.</small></label>
        <label>Starting stage<input maxLength={64} onChange={(event) => setInitialStage(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-"))} placeholder="Defaults to the first stage" value={initialStage} /><small>Use the stage ID below.</small></label>
        <label>Ending stages<input maxLength={1400} onChange={(event) => setTerminalStages(event.target.value)} placeholder="Comma-separated stage IDs; inferred from stages with no outgoing transitions" value={terminalStages} /></label>
        <fieldset className="recipe-stages"><legend>Progress stages</legend><p>Define the stages agents will report as work moves through this workflow.</p>
          {stages.map((stage, index) => <fieldset className="recipe-stage-row" key={index}>
            <legend>Stage {index + 1}</legend>
            <label>Stage ID<input maxLength={64} onChange={(event) => setStages((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-") } : item))} placeholder="research" value={stage.id} /></label>
            <label>Title<input maxLength={80} onChange={(event) => setStages((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item))} placeholder={`Stage ${index + 1}`} value={stage.title} /></label>
            <label>Objective<input maxLength={2000} onChange={(event) => setStages((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, objective: event.target.value } : item))} placeholder="What should this stage accomplish?" value={stage.objective} /></label>
            <label>Guidance<textarea maxLength={8000} onChange={(event) => setStages((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, guide: event.target.value } : item))} placeholder="How should agents approach this stage?" rows={3} value={stage.guide} /></label>
            <label>Rules<textarea maxLength={3000} onChange={(event) => setStages((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, rules: event.target.value.split("\n") } : item))} placeholder="One stage-specific rule per line." rows={2} value={stage.rules.join("\n")} /></label>
            <label>Transitions<textarea maxLength={8000} onChange={(event) => setStages((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, transitions: event.target.value } : item))} placeholder="One per line: stage-id | optional condition" rows={3} value={stage.transitions} /><small>Transitions guide navigation; they are not enforced.</small></label>
            <IconButton label={`Remove stage ${index + 1}`} onClick={() => setStages((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash size={15} /></IconButton>
          </fieldset>)}
          {stages.length < 20 && <button className="button button--quiet recipe-add-stage" onClick={() => setStages((current) => [...current, { id: "", title: "", objective: "", guide: "", rules: [], transitions: "" }])} type="button"><Plus size={14} />Add stage</button>}
        </fieldset>
        {error && <p className="recipe-error" role="alert">{error}</p>}
        <div className="recipe-editor-actions"><small>Saving creates a new version. Running chats keep the version they started with.</small><div><button className="button button--quiet" disabled={saving} onClick={() => setEditorOpen(false)} type="button">Cancel</button><button className="button button--primary" disabled={saving || !workflowIdPattern.test(recipeId) || !title.trim() || !description.trim() || !(instructions.trim() || stages.some((stage) => stage.guide.trim()))} type="submit">{saving ? "Saving…" : selected ? "Save new version" : "Create workflow"}</button></div></div>
      </form> : selected ? (() => {
        const recipe = recipes.find((item) => item.id === selected);
        if (!recipe) return null;
        return <article className="recipe-detail">
          <header className="recipe-detail-heading"><div><span className="eyebrow">{recipe.source === "builtin" ? "Built-in workflow" : "Your workflow"} · v{recipe.version}</span><h3>{recipe.title}</h3><p>{recipe.description}</p></div><IconButton label="Edit workflow" onClick={(event) => edit(recipe, event)}><PencilSimple size={16} /></IconButton></header>
          <p className="recipe-objective"><strong>Objective</strong> {recipe.objective ?? recipe.description}</p>
          {(recipe.tags?.length > 0 || recipe.initial_stage || recipe.terminal_stages?.length > 0) && <p className="recipe-workflow-meta">{recipe.tags?.length > 0 && <span>Tags: {recipe.tags.join(", ")}</span>}{recipe.initial_stage && <span>Starts: {recipe.stages?.find((stage) => stage.id === recipe.initial_stage)?.title ?? recipe.initial_stage}</span>}{recipe.terminal_stages?.length > 0 && <span>Ends: {recipe.terminal_stages.map((stageId) => recipe.stages?.find((stage) => stage.id === stageId)?.title ?? stageId).join(", ")}</span>}</p>}
          {recipe.rules?.length > 0 && <ul className="recipe-rules">{recipe.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul>}
          {recipe.stages?.length > 0 && <ol aria-label="Workflow stages" className="recipe-detail-stages">{recipe.stages.map((stage) => <li key={stage.id}><strong>{stage.title}</strong>{stage.objective && <span>{stage.objective}</span>}{stage.guide && <p>{stage.guide}</p>}{stage.rules?.length > 0 && <ul>{stage.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul>}{stage.transitions?.length > 0 && <small>Next: {stage.transitions.map((edge) => typeof edge === "string" ? edge : `${edge.to}${edge.when ? ` · ${edge.when}` : ""}`).join(", ")}</small>}</li>)}</ol>}
          <div className="recipe-detail-body"><MarkdownContent>{recipe.instructions}</MarkdownContent></div>
        </article>;
      })() : <div className="recipe-detail recipe-detail--empty"><strong>Choose a workflow</strong><span>Review its guidance for repeatable chats.</span></div>}
    </div>
  </section>;
}
