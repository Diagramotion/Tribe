import { useEffect, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { MarkdownContent } from "../components/MarkdownContent.jsx";

export function WorkflowsView({ recipes, onSave }) {
  const [selected, setSelected] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [recipeId, setRecipeId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!editorOpen && !recipes.some((recipe) => recipe.id === selected)) {
      setSelected(recipes[0]?.id ?? null);
    }
  }, [recipes, selected, editorOpen]);

  function edit(recipe = null) {
    setSelected(recipe?.id ?? null);
    setRecipeId(recipe?.id ?? "");
    setTitle(recipe?.title ?? "");
    setDescription(recipe?.description ?? "");
    setInstructions(recipe?.instructions ?? "");
    setError("");
    setEditorOpen(true);
  }

  function showRecipe(recipe) {
    setSelected(recipe.id);
    setEditorOpen(false);
  }

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const saved = await onSave({ id: recipeId, title, description, instructions });
      setSelected(saved.id);
      setEditorOpen(false);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return <section className="detail-view recipes-view">
    <div className="section-heading"><div><span className="eyebrow">Reusable workflows</span><h2 className="visually-hidden">Workflows</h2><p>Choose a workflow when you start a chat. Running chats keep the version they started with.</p></div><button className="button button--primary" onClick={() => edit()} type="button"><Plus size={15} /> New workflow</button></div>
    <div className="recipes-layout">
      <div className="recipe-list" aria-label="Workflows">{recipes.map((recipe) => <button aria-pressed={selected === recipe.id && !editorOpen} className={`recipe-list-item ${selected === recipe.id && !editorOpen ? "recipe-list-item--active" : ""}`} key={recipe.id} onClick={() => showRecipe(recipe)} type="button"><span><strong>{recipe.title}</strong><small>{recipe.description}</small></span><em>v{recipe.version}</em></button>)}{recipes.length === 0 && <div className="recipe-list-empty"><strong>No workflows yet</strong><span>Create reusable instructions for chats that follow a repeatable process.</span></div>}</div>
      {editorOpen ? <form className="recipe-editor" onSubmit={submit}>
        <div className="recipe-editor-heading"><div><span className="eyebrow">{selected ? "Edit workflow" : "Create workflow"}</span><h3>{selected ? title || "Untitled workflow" : "New workflow"}</h3></div>{selected && <span className="recipe-source">{recipes.find((item) => item.id === selected)?.source === "builtin" ? "Built in · your changes create a copy" : "Your workflow"}</span>}</div>
        <label>Workflow ID<input disabled={Boolean(selected)} maxLength={64} onChange={(event) => setRecipeId(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-"))} placeholder="e.g. release-readiness" value={recipeId} /></label>
        <label>Name<input maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="Release readiness" value={title} /></label>
        <label>Summary<input maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="Prepare and verify a release candidate." value={description} /></label>
        <label>Workflow guidance<textarea maxLength={20000} onChange={(event) => setInstructions(event.target.value)} placeholder="Describe the phases, evidence and review expected." rows={12} value={instructions} /></label>
        {error && <p className="recipe-error" role="alert">{error}</p>}
        <div className="recipe-editor-actions"><small>Saving creates a new version. Running chats keep the version they started with.</small><div><button className="button button--quiet" disabled={saving} onClick={() => setEditorOpen(false)} type="button">Cancel</button><button className="button button--primary" disabled={saving || !recipeId.trim() || !title.trim() || !description.trim() || !instructions.trim()} type="submit">{saving ? "Saving…" : selected ? "Save new version" : "Create workflow"}</button></div></div>
      </form> : selected ? (() => {
        const recipe = recipes.find((item) => item.id === selected);
        if (!recipe) return null;
        return <article className="recipe-detail">
          <header className="recipe-detail-heading"><div><span className="eyebrow">{recipe.source === "builtin" ? "Built-in workflow" : "Your workflow"} · v{recipe.version}</span><h3>{recipe.title}</h3><p>{recipe.description}</p></div><button className="button button--quiet" onClick={() => edit(recipe)} type="button">Edit workflow</button></header>
          <div className="recipe-detail-body"><MarkdownContent>{recipe.instructions}</MarkdownContent></div>
        </article>;
      })() : <div className="recipe-detail recipe-detail--empty"><strong>Choose a workflow</strong><span>Review its guidance or create one for a repeatable chat process.</span><button className="button button--quiet" onClick={() => edit()} type="button"><Plus size={15} /> Create workflow</button></div>}
    </div>
  </section>;
}
