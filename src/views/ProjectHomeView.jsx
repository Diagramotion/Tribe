import { useEffect, useRef, useState } from "react";
import { ArrowUp, CaretDown, CaretRight, Check, ClockCounterClockwise, Flag, FolderSimple, Gear, GitBranch, MagnifyingGlass, Sparkle, UsersThree } from "@phosphor-icons/react";
import { compactChatTitle } from "../domain/chat-title.js";
import { missionStatusLabel } from "../domain/labels.js";
import { insertSlashCommand, slashCommandOptions } from "../domain/slash-commands.js";
import { modelDisplayName, sortModelCatalog } from "../domain/model-catalog.js";
import { runtime } from "../api/runtime.js";

export function ProjectHomeView({ project, missions, skills = [], recipes = [], agents = [], agentConfigured, workspaceModel, onCreateMission, onSelectMission, onConnectModel, onManageModelMetadata, onManageTeam }) {
  const [prompt, setPrompt] = useState("");
  const [activeSlashOption, setActiveSlashOption] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [modelCatalog, setModelCatalog] = useState([]);
  const [catalogDefaultModel, setCatalogDefaultModel] = useState(null);
  const [modelPreference, setModelPreference] = useState("");
  const [effortPreference, setEffortPreference] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelListOpen, setModelListOpen] = useState(false);
  const [modelListSearch, setModelListSearch] = useState("");
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const promptRef = useRef(null);
  const modelMenuRef = useRef(null);
  const modelListSearchRef = useRef(null);
  const slashOptions = slashCommandOptions(prompt, recipes, skills);
  const activeSlashOptionId = `mission-slash-option-${activeSlashOption}`;
  const unavailableStatuses = new Set(["Provider setup failed", "Not configured"]);
  const readyAgents = agentConfigured ? agents.filter((agent) => !unavailableStatuses.has(agent.status)) : [];
  const canStartChat = agentConfigured && readyAgents.length > 0;

  useEffect(() => {
    setPrompt("");
    setSubmitting(false);
    setModelPreference("");
    setEffortPreference("");
    setModelMenuOpen(false);
    setModelListOpen(false);
    setModelListSearch("");
    if (promptRef.current) promptRef.current.style.height = "55px";
  }, [project?.id]);

  useEffect(() => {
    let current = true;
    setModelCatalogLoading(true);
    runtime.getModelCatalog().then(({ models = [], defaultModel = null }) => {
      if (!current) return;
      setModelCatalog(models.filter((model) => model.allowed));
      setCatalogDefaultModel(defaultModel);
    }).catch(() => {
      if (current) { setModelCatalog([]); setCatalogDefaultModel(null); }
    }).finally(() => { if (current) setModelCatalogLoading(false); });
    return () => { current = false; };
  }, [project?.id]);

  useEffect(() => {
    if (!modelMenuOpen) return undefined;
    function dismiss(event) {
      if (event.key === "Escape") {
        if (modelListOpen) setModelListOpen(false);
        else setModelMenuOpen(false);
      } else if (!modelMenuRef.current?.contains(event.target)) {
        setModelMenuOpen(false);
        setModelListOpen(false);
      }
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [modelMenuOpen, modelListOpen]);

  useEffect(() => {
    if (modelListOpen && modelChoices.length > 8) modelListSearchRef.current?.focus();
  }, [modelListOpen]);

  useEffect(() => {
    if (slashOptions.length) document.getElementById(activeSlashOptionId)?.scrollIntoView({ block: "nearest" });
  }, [activeSlashOptionId, slashOptions.length]);

  async function startMission(event) {
    event.preventDefault();
    if (!prompt.trim() || !canStartChat || submitting) return;
    setSubmitting(true);
    try {
      if (await onCreateMission(prompt.trim(), modelPreference || null, effortPreference || null)) setPrompt("");
    } finally {
      setSubmitting(false);
    }
  }

  function selectSlashOption(option) {
    setPrompt((current) => insertSlashCommand(current, option.insert));
    setActiveSlashOption(0);
  }

  function handleComposerKeyDown(event) {
    if (slashOptions.length && event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSlashOption((current) => (current + 1) % slashOptions.length);
      return;
    }
    if (slashOptions.length && event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSlashOption((current) => (current - 1 + slashOptions.length) % slashOptions.length);
      return;
    }
    if (slashOptions.length && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
      event.preventDefault();
      selectSlashOption(slashOptions[activeSlashOption] ?? slashOptions[0]);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) startMission(event);
  }

  const recentMissions = (missions ?? []).filter((item) => !item.archived_at).slice(0, 5);
  const effectiveModel = modelPreference || workspaceModel || catalogDefaultModel;
  const modelChoices = sortModelCatalog(modelCatalog.filter((model) => model.allowed !== false && model.providerEnabled !== false && model.toolCalling !== false), catalogDefaultModel);
  const selectedModelMetadata = modelCatalog.find((model) => model.id === effectiveModel);
  const initialAgent = agents.find((agent) => agent.id === "planner" || agent.name?.toLowerCase() === "planner" || agent.role?.toLowerCase() === "planner") ?? null;
  const initialRunModel = initialAgent?.model || effectiveModel;
  const initialRunModelMetadata = modelCatalog.find((model) => model.id === initialRunModel);
  const visibleModelChoices = modelListSearch.trim()
    ? modelChoices.filter((model) => (modelDisplayName(model) + " " + model.name + " " + model.id + " " + model.provider).toLocaleLowerCase().includes(modelListSearch.trim().toLocaleLowerCase()))
    : modelChoices;
  const supportedEfforts = Array.isArray(initialRunModelMetadata?.reasoningEfforts) ? [...initialRunModelMetadata.reasoningEfforts] : [];
  if (initialAgent?.effort && !supportedEfforts.includes(initialAgent.effort)) supportedEfforts.push(initialAgent.effort);
  const effectiveEffortPreference = initialAgent?.effort || effortPreference;
  const effortSliderValue = effectiveEffortPreference ? Math.max(0, supportedEfforts.indexOf(effectiveEffortPreference) + 1) : 0;
  const effortLabel = effortSliderValue === 0 ? "Auto" : supportedEfforts[effortSliderValue - 1] === "xhigh"
    ? "Extra high" : supportedEfforts[effortSliderValue - 1]?.replace(/^./, (letter) => letter.toUpperCase()) ?? "Auto";
  const currentModelLabel = selectedModelMetadata ? modelDisplayName(selectedModelMetadata) : effectiveModel?.split(":").slice(1).join(":") ?? "Auto";
  const triggerModelLabel = initialAgent?.model
    ? initialRunModelMetadata ? modelDisplayName(initialRunModelMetadata) : initialAgent.model.split(":").slice(1).join(":")
    : currentModelLabel;
  const supportedEffortLabel = (effort) => effort === "xhigh" ? "Extra high" : effort.replace(/^./, (letter) => letter.toUpperCase());
  const providerLabel = (provider) => ({ openai: "OpenAI", anthropic: "Anthropic", google: "Google", azure: "Azure", ollama: "Ollama", xai: "xAI", mistral: "Mistral", meta: "Meta", cohere: "Cohere" }[provider?.toLowerCase()] ?? provider?.replace(/^./, (letter) => letter.toUpperCase()) ?? "Model");
  function modelCapabilitySummary(model) {
    const details = [];
    if (Number.isFinite(model.contextWindow) && model.contextWindow > 0) details.push(new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(model.contextWindow) + " context");
    if (Number.isFinite(model.maxOutputTokens) && model.maxOutputTokens > 0) details.push(new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(model.maxOutputTokens) + " max output");
    const inputMedia = Array.isArray(model.inputModalities) ? model.inputModalities.filter((item) => item !== "text") : [];
    if (inputMedia.length) details.push(inputMedia.map((item) => item.replace(/^./, (letter) => letter.toUpperCase())).join("/") + " input");
    const outputMedia = Array.isArray(model.outputModalities) ? model.outputModalities.filter((item) => item !== "text") : [];
    if (outputMedia.length) details.push(outputMedia.map((item) => item.replace(/^./, (letter) => letter.toUpperCase())).join("/") + " output");
    if (model.toolCalling === true) details.push("Agent tools");
    else if (model.toolCalling === false) details.push("No agent tools");
    if (Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length) details.push(model.reasoningEfforts.length + " effort levels");
    return details.join(" · ") || "Capabilities not reported";
  }
  function changeEffort(value) {
    setEffortPreference(value === 0 ? "" : supportedEfforts[value - 1] ?? "");
  }
  return (
    <section className="project-home">
      <div className="project-home-content">
        <h1>What should we work on?</h1>
        <div className="project-home-team" aria-label="Team for this chat">
          <div className="project-home-team-heading"><UsersThree size={16} /><strong>Team for this chat</strong><span>{!agentConfigured ? "Model setup needed" : agents.length === 0 ? "No agent roles" : `${readyAgents.length} of ${agents.length} ready`}</span>
            {!agentConfigured && <button className="text-button project-home-team-connect" onClick={onConnectModel} type="button">Set up model</button>}
            {agents.length > 0 && agentConfigured && readyAgents.length < agents.length && <button className="text-button project-home-team-connect" onClick={onConnectModel} type="button">Review models</button>}
            <button aria-label="Manage project team" className="icon-button project-home-team-manage" onClick={onManageTeam} title="Manage project team" type="button"><Gear size={15} /></button>
          </div>
          {agents.length > 0 && <div className="project-home-team-list">{agents.map((agent) => {
            const ready = agentConfigured && !unavailableStatuses.has(agent.status);
            const title = !agentConfigured ? agent.name : ready ? `${agent.name} is ready` : `${agent.name}: ${agent.next}`;
            return <span key={agent.id} title={title}><i className={`project-home-team-dot ${agentConfigured ? (ready ? "project-home-team-dot--ready" : "project-home-team-dot--needs-setup") : "project-home-team-dot--unknown"}`} />{agent.name}</span>;
          })}</div>}
          {agents.length === 0 && agentConfigured && <p>No agent roles are available for this project.</p>}
        </div>
        <form className="project-home-composer" onSubmit={startMission}>
          <label className="visually-hidden" htmlFor="new-mission-prompt">Message this project</label>
          {slashOptions.length > 0 && <div className="project-home-slash-menu" id="mission-slash-commands" role="listbox" aria-label="Chat commands">
            <div className="project-home-slash-heading"><span>Commands</span><div><kbd>↑</kbd><kbd>↓</kbd><small>navigate</small><kbd>↵</kbd><small>select</small></div></div>
            {slashOptions.map((option, index) => {
              const kind = option.id === "goal" ? "Goal" : option.id === "workflow" || option.id.startsWith("workflow:") ? "Workflow" : "Skill";
              const Icon = kind === "Goal" ? Flag : kind === "Workflow" ? GitBranch : Sparkle;
              const command = kind === "Goal" ? "/goal" : kind === "Workflow" ? "/workflow" : "/skill";
              return <button aria-selected={index === activeSlashOption} className={index === activeSlashOption ? "project-home-slash-option project-home-slash-option--active" : "project-home-slash-option"} id={`mission-slash-option-${index}`} key={option.id} onClick={() => selectSlashOption(option)} role="option" type="button">
                <span className={`project-home-slash-icon project-home-slash-icon--${kind.toLowerCase()}`}><Icon aria-hidden="true" size={17} weight="regular" /></span>
                <span className="project-home-slash-copy"><span><strong>{option.label}</strong><small>{kind}</small></span><span className="project-home-slash-description">{option.description}</span></span>
                <code>{command}</code>
              </button>;
            })}
          </div>}
          <textarea aria-activedescendant={slashOptions.length ? activeSlashOptionId : undefined} aria-autocomplete="list" aria-controls="mission-slash-commands" aria-expanded={slashOptions.length > 0} autoComplete="off" autoFocus id="new-mission-prompt" maxLength={20000} onChange={(event) => { setPrompt(event.target.value); setActiveSlashOption(0); event.currentTarget.style.height = "55px"; event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 280)}px`; }} onKeyDown={handleComposerKeyDown} placeholder="Ask a question or describe a task…" ref={promptRef} role="combobox" rows={2} value={prompt} />
          <div className="project-home-composer-footer">
            <div className="project-home-composer-context"><span className="project-context-chip"><FolderSimple size={14} />{project?.name || "Project"}</span><span className="project-home-composer-hint">Type <kbd>/</kbd> for commands</span></div>
            <div className="composer-model-menu-wrap" ref={modelMenuRef}>
              <button aria-expanded={modelMenuOpen} aria-haspopup="dialog" aria-label={`Model ${triggerModelLabel}${initialAgent?.model ? `, pinned for ${initialAgent.name}` : ""}, effort ${effortLabel}`} className={"composer-model-trigger" + (modelMenuOpen ? " composer-model-trigger--open" : "")} onClick={() => { setModelListOpen(false); setModelListSearch(""); setModelMenuOpen((open) => !open); }} type="button">
                <Sparkle aria-hidden="true" className="composer-model-trigger-icon" size={15} weight="fill" />
                <span className="composer-model-trigger-copy"><strong>{triggerModelLabel}</strong><small>{effortLabel}</small></span>
                <CaretDown aria-hidden="true" size={12} />
              </button>
              {modelMenuOpen && <section aria-label="Model and effort settings" className="composer-model-popover" role="dialog">
                <div className="composer-model-picker">
                  <span className="composer-model-field-label">{initialAgent?.model ? "Chat model" : "Model"}</span>
                  <button aria-expanded={modelListOpen} aria-haspopup="listbox" className="composer-model-select" disabled={modelChoices.length === 0} onClick={() => { setModelListSearch(""); setModelListOpen((open) => !open); }} type="button">
                    <Sparkle aria-hidden="true" size={15} weight="fill" />
                    <span><strong>{currentModelLabel}</strong><small>{modelPreference ? providerLabel(selectedModelMetadata?.provider) : "Workspace default"}</small></span>
                    <CaretDown aria-hidden="true" size={14} />
                  </button>
                  {modelListOpen && <div className="composer-model-listbox">
                    {modelChoices.length > 8 && <label className="composer-model-search"><MagnifyingGlass aria-hidden="true" size={14} /><input aria-label="Search available models" autoComplete="off" onChange={(event) => setModelListSearch(event.target.value)} placeholder="Find a model" ref={modelListSearchRef} type="search" value={modelListSearch} /></label>}
                    <div aria-label="Available models" className="composer-model-options" role="listbox">
                      <button aria-selected={!modelPreference} className={"composer-model-option" + (!modelPreference ? " composer-model-option--selected" : "")} onClick={() => { setModelPreference(""); setModelListOpen(false); setModelListSearch(""); }} role="option" type="button"><span><strong>Auto</strong><small>Use the workspace default</small></span>{!modelPreference && <Check size={16} />}</button>
                      {visibleModelChoices.map((model) => <button aria-selected={modelPreference === model.id} className={"composer-model-option" + (modelPreference === model.id ? " composer-model-option--selected" : "")} key={model.id} onClick={() => {
                        const nextEffort = model.id === modelPreference || (Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.includes(effortPreference)) ? effortPreference : "";
                        setModelPreference(model.id);
                        setEffortPreference(nextEffort);
                        setModelListOpen(false);
                        setModelListSearch("");
                      }} role="option" title={model.id} type="button"><span><strong>{modelDisplayName(model)}</strong><small className="composer-model-option-details">{providerLabel(model.provider)} <i aria-hidden="true">·</i> {modelCapabilitySummary(model)}</small></span>{modelPreference === model.id && <Check size={16} />}</button>)}
                    </div>
                    {visibleModelChoices.length === 0 && modelListSearch.trim() && <p className="composer-model-no-results">No models match “{modelListSearch.trim()}”.</p>}
                  </div>}
                  {modelChoices.length === 0 && <div className="composer-model-empty"><span>{modelCatalogLoading ? "Loading models…" : "No models enabled."}</span><button onClick={() => { setModelMenuOpen(false); onConnectModel?.(); }} type="button">Open model settings <CaretRight size={12} /></button></div>}
                  {initialAgent?.model && <p className="composer-model-override-note">Planner is pinned to {triggerModelLabel}. This chat choice applies to other roles.</p>}
                </div>
                <div className={"composer-model-effort" + (supportedEfforts.length === 0 ? " composer-model-effort--unavailable" : "")}>
                  <div className="composer-model-effort-heading"><span>Reasoning effort</span><strong>{effortLabel}</strong></div>
                  <div className="composer-model-slider-wrap"><input aria-label="Reasoning effort" aria-valuetext={effortLabel} disabled={Boolean(initialAgent?.effort) || !initialRunModel || supportedEfforts.length === 0} max={supportedEfforts.length} min="0" onChange={(event) => changeEffort(Number(event.target.value))} step="1" style={{ "--effort-progress": (supportedEfforts.length ? (effortSliderValue / supportedEfforts.length) * 100 : 0) + "%" }} type="range" value={effortSliderValue} />{supportedEfforts.length > 0 && <div aria-hidden="true" className="composer-model-slider-marks">{Array.from({ length: supportedEfforts.length + 1 }, (_, index) => <i key={index} style={{ left: (index / supportedEfforts.length) * 100 + "%" }} />)}</div>}</div>
                  {supportedEfforts.length === 0 && <div className="composer-model-effort-unset"><span>{initialRunModelMetadata ? "Effort levels not set for this model" : "Effort capabilities unavailable"}</span>{initialRunModel && <button onClick={() => { setModelMenuOpen(false); onManageModelMetadata?.(initialRunModel); }} type="button">Set options <CaretRight size={12} /></button>}</div>}
                </div>
              </section>}
            </div>
            <button aria-label="Start chat" className="project-home-send" disabled={!prompt.trim() || !canStartChat || submitting} title={submitting ? "Starting chat" : "Start chat"} type="submit"><ArrowUp size={17} /></button>
          </div>
        </form>
        {recentMissions.length > 0 && <div className="project-home-recent">
          <div className="project-home-section-heading"><ClockCounterClockwise size={15} /><span>Recent chats</span></div>
          {recentMissions.map((item) => {
            const statusLabel = missionStatusLabel(item.status);
            return (
              <button aria-label={`Open chat: ${item.title} · ${statusLabel}`} className="project-home-mission" key={item.id} onClick={() => onSelectMission(item.id)} title={`${item.title} · ${statusLabel}`} type="button">
                <span><strong>{compactChatTitle(item.title)}</strong></span>
                <span className={`project-home-mission-status project-home-mission-status--${item.status}`}>
                  <i aria-hidden="true" className="mission-status-dot" />
                  <span>{statusLabel}</span>
                </span>
              </button>
            );
          })}
        </div>}
      </div>
    </section>
  );
}
