import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowDown, ArrowLeft, ArrowUp, ClockCounterClockwise, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { IconButton } from "../components/WorkspaceSidebar.jsx";
import { MarkdownContent } from "../components/MarkdownContent.jsx";
import { flowTextFromWorkflow, isSequentialWorkflow, parseWorkflowFlowText, sequentialWorkflow, validateWorkflowDraft, workflowToDraft } from "../domain/workflow-designer.js";

function WorkflowNode({ data, selected }) {
  return <div className={`workflow-flow-node ${selected ? "workflow-flow-node--selected" : ""}`}>
    <Handle type="target" position={Position.Left} />
    <span className="workflow-flow-node-kind">Stage</span>
    <strong>{data.title}</strong>
    {data.guide ? <small>Markdown guidance</small> : <small>Add a description</small>}
    <Handle type="source" position={Position.Right} />
  </div>;
}

function WorkflowEndpointNode({ data }) {
  const isStart = data.label === "Start";
  return <div className={`workflow-flow-endpoint ${isStart ? "workflow-flow-endpoint--start" : "workflow-flow-endpoint--end"}`}>
    {!isStart && <Handle type="target" position={Position.Left} />}
    <strong>{data.label}</strong>
    {isStart && <Handle type="source" position={Position.Right} />}
  </div>;
}

const nodeTypes = { workflowStage: WorkflowNode, workflowEndpoint: WorkflowEndpointNode };

function WorkflowDesigner({ stages, initialStage, terminalStages, onChange, onSelectStage, onSelectEdge }) {
  const stagePositions = stages.map((stage) => stage.position).filter(Boolean);
  const maxX = Math.max(stages.length > 1 ? 800 : 560, ...stagePositions.map((point) => point.x + 240));
  const nodes = useMemo(() => {
    const stageNodes = stages.map((stage, index) => ({
      id: stage.id,
      type: "workflowStage",
      position: stage.position ?? { x: 260 + (index % 2) * 280, y: 56 + Math.floor(index / 2) * 150 },
      data: { title: stage.title || stage.id, guide: stage.guide },
    }));
    return [
      { id: "start", type: "workflowEndpoint", position: { x: 24, y: 72 }, data: { label: "Start" }, deletable: false, draggable: false },
      ...stageNodes,
      { id: "finish", type: "workflowEndpoint", position: { x: maxX, y: 72 }, data: { label: "End" }, deletable: false, draggable: false },
    ];
  }, [stages, maxX]);
  const edges = useMemo(() => {
    const result = [];
    if (initialStage) result.push({ id: `start-${initialStage}`, source: "start", target: initialStage, markerEnd: { type: MarkerType.ArrowClosed }, type: "smoothstep", data: { initial: true, to: initialStage } });
    for (const stage of stages) {
      for (const [index, transition] of (stage.transitions ?? []).entries()) {
        const edge = typeof transition === "string" ? { to: transition, when: "" } : transition;
        result.push({ id: `${stage.id}-${edge.to}-${index}`, source: stage.id, target: edge.to,
          label: edge.when, markerEnd: { type: MarkerType.ArrowClosed }, type: "smoothstep", data: { from: stage.id, to: edge.to, when: edge.when, index } });
      }
      if (terminalStages.includes(stage.id)) result.push({ id: `${stage.id}-finish`, source: stage.id, target: "finish", markerEnd: { type: MarkerType.ArrowClosed }, type: "smoothstep", data: { terminal: true, from: stage.id } });
    }
    return result;
  }, [stages, initialStage, terminalStages]);

  function connect(connection) {
    if (!connection.source || !connection.target || connection.source === "finish" || connection.target === "start") return;
    if (connection.source === "start") {
      if (connection.target !== "finish") onChange({ initial_stage: connection.target });
      return;
    }
    if (connection.target === "finish") {
      onChange({ terminal_stages: [...new Set([...terminalStages, connection.source])] });
      return;
    }
    onChange({ stages: stages.map((stage) => stage.id === connection.source
      ? { ...stage, transitions: [...(stage.transitions ?? []), { to: connection.target, when: "" }] }
      : stage) });
  }

  function deleteElements({ nodes: deletedNodes = [], edges: deletedEdges = [] }) {
    const removed = new Set(deletedNodes.filter((node) => node.type === "workflowStage").map((node) => node.id));
    let nextStages = stages.filter((stage) => !removed.has(stage.id)).map((stage) => ({
      ...stage, transitions: (stage.transitions ?? []).filter((edge) => !removed.has(typeof edge === "string" ? edge : edge.to)),
    }));
    const deleted = new Set(deletedEdges.map((edge) => edge.id));
    for (const stage of nextStages) stage.transitions = stage.transitions.filter((edge, index) => !deleted.has(`${stage.id}-${typeof edge === "string" ? edge : edge.to}-${index}`));
    const nextInitial = removed.has(initialStage) ? (nextStages[0]?.id ?? "") : initialStage;
    const nextTerminals = terminalStages.filter((id) => !removed.has(id));
    onChange({ stages: nextStages, initial_stage: nextInitial, terminal_stages: nextTerminals });
  }

  return <div className="workflow-designer">
    <div className="workflow-designer-canvas" aria-label="Workflow flow designer">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.18 }}
        minZoom={0.25} maxZoom={1.5} deleteKeyCode={["Backspace", "Delete"]} onConnect={connect}
        onNodeClick={(_, node) => { if (node.type === "workflowStage") onSelectStage(node.id); }}
        onEdgeClick={(_, edge) => { if (edge.data) onSelectEdge(edge.data); }}
        onNodesDelete={(deletedNodes) => deleteElements({ nodes: deletedNodes })}
        onEdgesDelete={(deletedEdges) => deleteElements({ edges: deletedEdges })}
        onNodeDragStop={(_, node) => {
          if (node.type === "workflowStage") onChange({ stages: stages.map((stage) => stage.id === node.id ? { ...stage, position: node.position } : stage) });
        }}>
        <Background color="var(--line-subtle)" gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
    <div className="workflow-designer-help">Drag between handles to connect stages. Select a stage or connection to edit it.</div>
  </div>;
}

function stageIdFromTitle(title, index, stages) {
  const base = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 55) || `stage-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (stages.some((stage) => stage.id === id)) id = `${base.slice(0, 58)}-${suffix++}`;
  return id;
}

function stageName(stages, id) {
  return stages.find((stage) => stage.id === id)?.title || id || "Missing stage";
}

export function WorkflowsView({ recipes, onSave, onListVersions, onGetVersion }) {
  const returnFocusRef = useRef(null);
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
  const [terminalStages, setTerminalStages] = useState([]);
  const [stages, setStages] = useState([]);
  const [authoringMode, setAuthoringMode] = useState("stages");
  const [flowText, setFlowText] = useState("");
  const [flowTextError, setFlowTextError] = useState("");
  const [designerSelection, setDesignerSelection] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [validationErrors, setValidationErrors] = useState([]);
  const [versions, setVersions] = useState([]);
  const [viewVersion, setViewVersion] = useState(null);
  const [loadingVersion, setLoadingVersion] = useState(false);
  const draft = { id: recipeId, title, description, objective: objective || description, instructions, rules, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), initial_stage: initialStage, terminal_stages: terminalStages, stages };
  const sequential = isSequentialWorkflow(stages, initialStage, terminalStages);

  useEffect(() => {
    if (!editorOpen && !recipes.some((recipe) => recipe.id === selected)) setSelected(recipes[0]?.id ?? null);
  }, [recipes, selected, editorOpen]);

  useEffect(() => {
    if (!selected || editorOpen || !onListVersions) return undefined;
    let current = true;
    onListVersions(selected).then((result) => { if (current) setVersions(result.versions ?? []); })
      .catch(() => { if (current) setVersions([recipes.find((recipe) => recipe.id === selected)?.version].filter(Boolean)); });
    return () => { current = false; };
  }, [selected, editorOpen, onListVersions, recipes]);

  useEffect(() => {
    if (validationErrors.length) setValidationErrors(validateWorkflowDraft(draft));
  }, [recipeId, title, description, objective, instructions, rules, tags, initialStage, terminalStages, stages]);

  useLayoutEffect(() => {
    if (editorOpen) { nameFieldRef.current?.focus(); return; }
    const returnFocus = returnFocusRef.current;
    if (returnFocus?.isConnected) returnFocus.focus();
    else document.querySelector(".recipes-view .recipe-detail-heading [aria-label='Edit workflow']")?.focus();
    returnFocusRef.current = null;
  }, [editorOpen, selected]);

  function edit(recipe = null, event) {
    returnFocusRef.current = event?.currentTarget ?? document.activeElement;
    setSelected(recipe?.id ?? null);
    const value = workflowToDraft(recipe);
    setRecipeId(value.id); setTitle(value.title); setDescription(value.description); setObjective(value.objective);
    setInstructions(value.instructions); setRules(value.rules); setTags(value.tags.join(", "));
    setInitialStage(value.initial_stage);
    setTerminalStages(value.terminal_stages.length ? value.terminal_stages : value.stages.filter((stage) => !(stage.transitions ?? []).length).map((stage) => stage.id));
    setStages(value.stages);
    const isSequential = isSequentialWorkflow(value.stages, value.initial_stage, value.terminal_stages.length ? value.terminal_stages : value.stages.filter((stage) => !(stage.transitions ?? []).length).map((stage) => stage.id));
    setAuthoringMode(isSequential ? "stages" : "designer");
    setFlowText(flowTextFromWorkflow(value.stages, value.initial_stage, value.terminal_stages));
    setFlowTextError(""); setDesignerSelection(value.stages[0] ? { type: "stage", id: value.stages[0].id } : null);
    setError(""); setValidationErrors([]); setViewVersion(null); setEditorOpen(true);
  }

  function updateTitle(value) {
    setTitle(value);
    if (selected) return;
    let base = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 54) || "workflow";
    if (base.length < 2) base = `${base}-flow`;
    let nextId = base;
    let suffix = 2;
    while (recipes.some((recipe) => recipe.id === nextId)) nextId = `${base}-${suffix++}`;
    setRecipeId(nextId);
  }

  function showRecipe(recipe, event) {
    returnFocusRef.current = event.currentTarget;
    setSelected(recipe.id); setViewVersion(null); setError(""); setEditorOpen(false);
    if (onListVersions) onListVersions(recipe.id).then((result) => setVersions(result.versions ?? [])).catch(() => setVersions([recipe.version]));
  }

  async function showVersion(version) {
    setError("");
    if (!selected || version === recipes.find((item) => item.id === selected)?.version) { setViewVersion(null); return; }
    setLoadingVersion(true);
    try { const result = await onGetVersion(selected, version); setViewVersion(result.recipe ?? result); }
    catch (loadError) { setError(`Version could not be loaded: ${loadError.message}`); }
    finally { setLoadingVersion(false); }
  }

  function updateGraph(change) {
    if (change.stages) setStages(change.stages);
    if (Object.hasOwn(change, "initial_stage")) setInitialStage(change.initial_stage);
    if (change.terminal_stages) setTerminalStages(change.terminal_stages);
    setFlowTextError("");
  }

  function applyFlowText() {
    const parsed = parseWorkflowFlowText(flowText, stages);
    if (parsed.errors.length) { setFlowTextError(parsed.errors.join(" ")); return false; }
    setStages(parsed.stages); setInitialStage(parsed.initial_stage); setTerminalStages(parsed.terminal_stages);
    setDesignerSelection(parsed.stages[0] ? { type: "stage", id: parsed.stages[0].id } : null); setFlowTextError("");
    return true;
  }

  function selectMode(nextMode) {
    if (nextMode === "stages" && !sequential) return;
    if (authoringMode === "text" && flowText !== flowTextFromWorkflow(stages, initialStage, terminalStages)) {
      if (!applyFlowText()) return;
    }
    if (authoringMode === "stages" && nextMode !== "stages") {
      const graphStages = sequentialWorkflow(stages);
      setStages(graphStages);
      setInitialStage(graphStages[0]?.id ?? "");
      setTerminalStages(graphStages.length ? [graphStages.at(-1).id] : []);
    }
    if (nextMode === "text") setFlowText(flowTextFromWorkflow(stages, initialStage, terminalStages));
    if (nextMode === "designer") setDesignerSelection((current) => (
      current && ((current.type === "stage" && stages.some((stage) => stage.id === current.id)) || current.type === "edge")
        ? current
        : (stages[0] ? { type: "stage", id: stages[0].id } : null)
    ));
    setAuthoringMode(nextMode); setFlowTextError("");
  }

  function convertToSequential() {
    let currentStages = stages;
    if (authoringMode === "text") {
      const parsed = parseWorkflowFlowText(flowText, stages);
      if (parsed.errors.length) { setFlowTextError(parsed.errors.join(" ")); return; }
      currentStages = parsed.stages;
    }
    const next = sequentialWorkflow(currentStages);
    setStages(next); setInitialStage(next[0]?.id ?? ""); setTerminalStages(next.length ? [next.at(-1).id] : []);
    setAuthoringMode("stages"); setFlowTextError("");
  }

  async function submit(event) {
    event.preventDefault();
    let sourceStages = stages;
    let sourceInitial = initialStage;
    let sourceTerminals = terminalStages;
    if (authoringMode === "text") {
      const parsed = parseWorkflowFlowText(flowText, stages);
      if (parsed.errors.length) { setFlowTextError(parsed.errors.join(" ")); return; }
      sourceStages = parsed.stages; sourceInitial = parsed.initial_stage; sourceTerminals = parsed.terminal_stages;
      setStages(sourceStages); setInitialStage(sourceInitial); setTerminalStages(sourceTerminals);
    }
    const finalStages = authoringMode === "stages" ? sequentialWorkflow(stages) : sourceStages;
    const finalInitial = authoringMode === "stages" ? finalStages[0]?.id ?? "" : sourceInitial;
    const finalTerminals = authoringMode === "stages" && finalStages.length ? [finalStages.at(-1).id] : sourceTerminals;
    const errors = validateWorkflowDraft({ ...draft, stages: finalStages, initial_stage: finalInitial, terminal_stages: finalTerminals });
    setValidationErrors(errors);
    if (errors.length) return;
    setSaving(true); setError("");
    try {
      const saved = await onSave({
        id: recipeId, title, description, objective: objective || description, instructions,
        expected_version: selected ? (recipes.find((recipe) => recipe.id === selected)?.version ?? 0) : 0,
        rules: rules.map((rule) => rule.trim()).filter(Boolean),
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        initial_stage: finalInitial || undefined,
        terminal_stages: finalTerminals,
        stages: finalStages.map((stage) => ({
          id: stage.id.trim(), title: stage.title.trim(), objective: stage.objective.trim(), guide: stage.guide.trim(),
          rules: (stage.rules ?? []).map((rule) => rule.trim()).filter(Boolean),
          transitions: (stage.transitions ?? []).filter((edge) => (typeof edge === "string" ? edge : edge.to)).map((edge) => typeof edge === "string" ? { to: edge, when: "" } : ({ to: edge.to, when: edge.when.trim() })),
          ...(stage.position ? { position: stage.position } : {}),
        })),
      });
      setSelected(saved.id); setViewVersion(null);
      setVersions(onListVersions ? await onListVersions(saved.id).then((result) => result.versions ?? []).catch(() => [saved.version]) : [saved.version]);
      setEditorOpen(false);
    } catch (saveError) { setError(saveError.message); }
    finally { setSaving(false); }
  }

  function patchStage(stageId, patch) {
    setStages((current) => current.map((stage) => stage.id === stageId ? { ...stage, ...patch } : stage));
  }

  return <section className="detail-view recipes-view">
    {!editorOpen && <div className="section-heading"><div><span className="eyebrow">Reusable workflows</span><h2 className="visually-hidden">Workflows</h2><p>Choose a workflow when you start a chat. Running chats keep the version they started with.</p></div><IconButton className="button--primary" label="New workflow" onClick={(event) => edit(null, event)}><Plus size={16} /></IconButton></div>}
    <div className={`recipes-layout ${editorOpen ? "recipes-layout--editing" : ""}`}>
      {!editorOpen && <nav className="recipe-list" aria-label="Workflows">{recipes.map((recipe) => <button aria-current={selected === recipe.id ? "page" : undefined} className={`recipe-list-item ${selected === recipe.id ? "recipe-list-item--active" : ""}`} key={recipe.id} onClick={(event) => showRecipe(recipe, event)} type="button"><span><strong>{recipe.title}</strong><small>{recipe.description}</small></span><em>v{recipe.version}</em></button>)}{recipes.length === 0 && <div className="recipe-list-empty"><strong>No workflows yet</strong><span>Create reusable instructions for chats that follow a repeatable process.</span></div>}</nav>}
      {editorOpen ? <form className="recipe-editor recipe-editor--expanded" onSubmit={submit}>
        <div className="recipe-editor-heading"><div><span className="eyebrow">{selected ? "Edit workflow" : "Create workflow"}</span><h3>{selected ? title || "Untitled workflow" : "New workflow"}</h3>{selected && <span className="recipe-source">{recipes.find((item) => item.id === selected)?.source === "builtin" ? "Built in · your changes create a copy" : "Your workflow"}</span>}</div><IconButton label="Back to workflows" onClick={() => setEditorOpen(false)}><ArrowLeft size={16} /></IconButton></div>
        <div className="workflow-metadata">
          <label>Name<input maxLength={120} onChange={(event) => updateTitle(event.target.value)} placeholder="Release readiness" ref={nameFieldRef} value={title} /></label>
          <label>Description<input maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="Describe what this workflow helps agents do." value={description} /></label>
        </div>
        <details className="workflow-global-details">
          <summary><span>Workflow-wide guidance and tags</span><small>Optional context and discovery labels</small><span className="workflow-global-details-show">Show</span><span className="workflow-global-details-hide">Hide</span></summary>
          <div className="workflow-global-details-fields">
            <label>Overall guidance<textarea maxLength={20000} onChange={(event) => setInstructions(event.target.value)} placeholder="Give agents context and principles. Stage-specific steps belong below." rows={3} value={instructions} /></label>
            <label>Tags<input maxLength={2000} onChange={(event) => setTags(event.target.value)} placeholder="research, analysis" value={tags} /><small>Comma-separated labels used when finding a workflow.</small></label>
          </div>
        </details>
        <fieldset className="recipe-stages"><legend>Stages and flow</legend><p>Start with a simple ordered list. Switch to text or the designer for branches and return paths.</p>
          <div className="workflow-authoring-modes" role="tablist" aria-label="Workflow editor">
            <button aria-selected={authoringMode === "stages"} className={authoringMode === "stages" ? "is-active" : ""} disabled={!sequential && authoringMode !== "stages"} onClick={() => selectMode("stages")} role="tab" type="button">Stages</button>
            <button aria-selected={authoringMode === "text"} className={authoringMode === "text" ? "is-active" : ""} onClick={() => selectMode("text")} role="tab" type="button">Text</button>
            <button aria-selected={authoringMode === "designer"} className={authoringMode === "designer" ? "is-active" : ""} onClick={() => selectMode("designer")} role="tab" type="button">Designer</button>
          </div>
          {!sequential && authoringMode !== "stages" && <button className="button button--quiet workflow-convert-sequential" onClick={convertToSequential} type="button">Convert to sequential stages</button>}
          {authoringMode === "stages" ? <div className="recipe-stage-list" role="tabpanel" aria-label="Sequential stages">
              {stages.map((stage, index) => <fieldset className="recipe-stage-row" key={stage.id || index}>
              <legend><span>{index + 1}</span> Stage</legend>
              <div className="recipe-stage-actions"><IconButton disabled={index === 0} label={`Move ${stage.title || `stage ${index + 1}`} up`} onClick={() => setStages((current) => { const next = [...current]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}><ArrowUp size={14} /></IconButton><IconButton disabled={index === stages.length - 1} label={`Move ${stage.title || `stage ${index + 1}`} down`} onClick={() => setStages((current) => { const next = [...current]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; return next; })}><ArrowDown size={14} /></IconButton><IconButton label={`Remove ${stage.title || `stage ${index + 1}`}`} onClick={() => setStages((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash size={14} /></IconButton></div>
              <label>Stage name<input maxLength={80} onChange={(event) => patchStage(stage.id, { title: event.target.value })} placeholder={`Stage ${index + 1}`} value={stage.title} /></label>
              <label>Markdown description<textarea maxLength={8000} onChange={(event) => patchStage(stage.id, { guide: event.target.value })} placeholder="What should happen in this stage?" rows={3} value={stage.guide} /></label>
            </fieldset>)}
            {stages.length < 20 && <button className="button button--quiet recipe-add-stage" onClick={() => {
              const id = stageIdFromTitle("", stages.length, stages);
              const next = [...stages, { id, title: "", objective: "", guide: "", rules: [], transitions: [] }];
              setStages(next); setInitialStage(initialStage || next[0]?.id || ""); setTerminalStages([id]);
              setDesignerSelection({ type: "stage", id });
            }} type="button"><Plus size={14} />Add stage</button>}
          </div> : authoringMode === "text" ? <div className="workflow-text-editor" role="tabpanel">
            <label>Flow syntax<textarea aria-describedby="workflow-text-help" maxLength={20000} onChange={(event) => setFlowText(event.target.value)} spellCheck="false" value={flowText} /></label>
            <small id="workflow-text-help">Mermaid-style syntax: <code>research[Research] --&gt;|Needs changes| draft</code>. Connect <code>__start__</code> to the first stage and a stage to <code>__end__</code> to mark the end. Edit stage descriptions in Stages or Designer.</small>
            <button className="button button--quiet" onClick={applyFlowText} type="button">Apply text to workflow</button>
            {flowTextError && <p className="recipe-error" role="alert">{flowTextError}</p>}
          </div> : <div className="workflow-designer-panel" role="tabpanel">
            <div className="workflow-designer-toolbar"><button className="button button--quiet" disabled={stages.length >= 20} onClick={() => {
              const id = stageIdFromTitle("", stages.length, stages);
              const stage = { id, title: `Stage ${stages.length + 1}`, objective: "", guide: "", rules: [], transitions: [], position: { x: 280 + (stages.length % 2) * 260, y: 80 + Math.floor(stages.length / 2) * 150 } };
              updateGraph({ stages: [...stages, stage], initial_stage: initialStage || id, terminal_stages: terminalStages.length ? terminalStages : [id] });
              setSelectedStage(id);
            }} type="button"><Plus size={14} />Add stage</button><span>Branches and loops are optional guidance, not enforced gates.</span></div>
            <div className="workflow-designer-layout">
              <WorkflowDesigner stages={stages} initialStage={initialStage} terminalStages={terminalStages} onChange={updateGraph}
                onSelectStage={(id) => setDesignerSelection({ type: "stage", id })}
                onSelectEdge={(data) => setDesignerSelection({ type: "edge", data })} />
              <aside className="workflow-designer-inspector" aria-label="Selected node or connection details">
                {designerSelection?.type === "stage" && stages.some((stage) => stage.id === designerSelection.id) ? (() => {
                  const stage = stages.find((item) => item.id === designerSelection.id);
                  return <>
                    <div className="workflow-inspector-heading"><div><span className="eyebrow">Stage</span><strong>{stage.title}</strong></div><IconButton label="Remove stage" onClick={() => {
                      const remaining = stages.filter((item) => item.id !== stage.id).map((item) => ({ ...item, transitions: item.transitions.filter((edge) => (typeof edge === "string" ? edge : edge.to) !== stage.id) }));
                      updateGraph({ stages: remaining, initial_stage: initialStage === stage.id ? (remaining[0]?.id ?? "") : initialStage, terminal_stages: terminalStages.filter((id) => id !== stage.id) });
                      setDesignerSelection(remaining[0] ? { type: "stage", id: remaining[0].id } : null);
                    }}><Trash size={14} /></IconButton></div>
                    <label>Stage name<input maxLength={80} onChange={(event) => patchStage(stage.id, { title: event.target.value })} value={stage.title} /></label>
                    <label>Markdown description<textarea maxLength={8000} onChange={(event) => patchStage(stage.id, { guide: event.target.value })} placeholder="What should happen in this stage?" rows={6} value={stage.guide} /></label>
                  </>;
                })() : designerSelection?.type === "edge" ? (() => {
                  const edge = designerSelection.data;
                  const fromStage = stages.find((stage) => stage.id === edge.from);
                  const transition = fromStage?.transitions?.[edge.index];
                  return <>
                    <div className="workflow-inspector-heading"><div><span className="eyebrow">Connection</span><strong>{edge.initial ? "Start" : fromStage?.title || "Stage"} → {edge.initial ? stageName(stages, edge.to) : edge.terminal ? "End" : stageName(stages, edge.to)}</strong></div></div>
                    {edge.initial ? <p>Connect Start to a different stage to change where this flow begins.</p> : edge.terminal ? <p>This path ends the workflow here.</p> : <label>When does this happen?<input maxLength={500} placeholder="e.g. Needs changes" value={typeof transition === "string" ? "" : transition?.when ?? ""} onChange={(event) => patchStage(edge.from, { transitions: fromStage.transitions.map((item, index) => index === edge.index ? { to: typeof item === "string" ? item : item.to, when: event.target.value } : item) })} /></label>}
                    {!edge.initial && <button className="button button--quiet workflow-remove-connection" onClick={() => {
                      if (edge.terminal) updateGraph({ terminal_stages: terminalStages.filter((id) => id !== edge.from) });
                      else patchStage(edge.from, { transitions: fromStage.transitions.filter((_, index) => index !== edge.index) });
                      setDesignerSelection(null);
                    }} type="button"><Trash size={14} />Remove connection</button>}
                  </>;
                })() : <div className="workflow-inspector-empty"><strong>Select a stage or connection</strong><span>Its description or condition will appear here.</span></div>}
              </aside>
            </div>
          </div>}
        </fieldset>
        {(error || validationErrors.length > 0) && <div className="recipe-error" role="alert">{error && <p>{error}</p>}{validationErrors.length > 0 && <ul>{validationErrors.map((item) => <li key={item}>{item}</li>)}</ul>}</div>}
        <div className="recipe-editor-actions"><small>Saving creates a new version. Chats keep the exact version they started with.</small><div><button className="button button--primary" disabled={saving} type="submit">{saving ? "Saving…" : selected ? "Save new version" : "Create workflow"}</button></div></div>
      </form> : selected ? (() => {
        const latestRecipe = recipes.find((item) => item.id === selected);
        const recipe = viewVersion ?? latestRecipe;
        if (!recipe) return null;
        return <article className="recipe-detail">
          <header className="recipe-detail-heading"><div><span className="eyebrow">{recipe.source === "builtin" ? "Built-in workflow" : "Your workflow"} · v{recipe.version}{recipe.version === latestRecipe?.version ? " · Current" : " · Saved version"}</span><h3>{recipe.title}</h3><p>{recipe.description}</p></div><IconButton disabled={recipe.version !== latestRecipe?.version && recipe.source !== "builtin"} label="Edit workflow" onClick={(event) => edit(latestRecipe, event)}><PencilSimple size={16} /></IconButton></header>
          <div className="workflow-history"><span><ClockCounterClockwise size={14} />Version history</span>{(versions.length ? versions : [latestRecipe?.version ?? recipe.version]).map((version) => <button aria-pressed={recipe.version === version} className={recipe.version === version ? "workflow-version--active" : ""} disabled={loadingVersion} key={version} onClick={() => showVersion(version)} type="button">v{version}</button>)}{loadingVersion && <small>Loading…</small>}</div>
          {error && <p className="recipe-error" role="alert">{error}</p>}
          <p className="workflow-activation-hint">Start a new chat with <code>/workflow {recipe.id}{recipe.version === latestRecipe?.version ? "" : `@v${recipe.version}`}</code>. This chat will keep version {recipe.version}.</p>
          <p className="recipe-objective"><strong>Objective</strong> {recipe.objective ?? recipe.description}</p>
          {recipe.rules?.length > 0 && <ul className="recipe-rules">{recipe.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul>}
          {recipe.stages?.length > 0 && <ol aria-label="Workflow stages" className="recipe-detail-stages">{recipe.stages.map((stage) => <li key={stage.id}><strong>{stage.title}</strong>{stage.objective && <span>{stage.objective}</span>}{stage.guide && <div><MarkdownContent>{stage.guide}</MarkdownContent></div>}{stage.transitions?.length > 0 && <small>Next: {stage.transitions.map((edge) => typeof edge === "string" ? edge : `${edge.to}${edge.when ? ` · ${edge.when}` : ""}`).join(", ")}</small>}</li>)}</ol>}
          <div className="recipe-detail-body"><MarkdownContent>{recipe.instructions}</MarkdownContent></div>
        </article>;
      })() : <div className="recipe-detail recipe-detail--empty"><strong>Choose a workflow</strong><span>Review its guidance for repeatable chats.</span></div>}
    </div>
  </section>;
}
