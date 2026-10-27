import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CaretDown, CaretLeft, CaretRight, Check, ChartLine, CircleNotch, Cpu, DesktopTower, DownloadSimple, FolderSimple, Image as ImageIcon, MagnifyingGlass, PencilSimple, Plug, Plus, Sparkle, SpeakerHigh, Star, TerminalWindow, TextT, VideoCamera,
  ShieldCheck, UploadSimple, X,
} from "@phosphor-icons/react";
import openaiLogo from "../assets/model-providers/openai.svg";
import anthropicLogo from "../assets/model-providers/anthropic.svg";
import googleLogo from "../assets/model-providers/google-gemini.svg";
import groqLogo from "../assets/model-providers/groq.svg";
import mistralLogo from "../assets/model-providers/mistral.svg";
import deepseekLogo from "../assets/model-providers/deepseek.svg";
import openrouterLogo from "../assets/model-providers/openrouter.svg";
import xaiLogo from "../assets/model-providers/xai.svg";
import cerebrasLogo from "../assets/model-providers/cerebras.svg";
import cohereLogo from "../assets/model-providers/cohere.svg";
import fireworksLogo from "../assets/model-providers/fireworks.svg";
import togetherLogo from "../assets/model-providers/together-ai.svg";
import ollamaLogo from "../assets/model-providers/ollama.svg";
import { IconButton } from "../components/WorkspaceSidebar.jsx";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { runtime } from "../api/runtime.js";
import { formatUsd } from "../domain/activity.js";
import { modelDisplayName, sortModelCatalog } from "../domain/model-catalog.js";

const settingsSections = [
  { id: "workspace", label: "Workspace", icon: FolderSimple },
  { id: "models", label: "Models", icon: Sparkle },
  { id: "connections", label: "Connections", icon: Plug },
  { id: "commands", label: "Command tools", icon: TerminalWindow },
  { id: "desktop", label: "Desktop access", icon: DesktopTower },
  { id: "data", label: "Usage & data", icon: ChartLine },
];
const modelProviderLabels = { openai: "OpenAI", anthropic: "Anthropic", google: "Google Gemini", groq: "Groq", mistral: "Mistral", deepseek: "DeepSeek", openrouter: "OpenRouter", xai: "xAI", cerebras: "Cerebras", cohere: "Cohere", fireworks: "Fireworks", together: "Together AI", ollama: "Ollama" };
const modelProviders = Object.keys(modelProviderLabels);
const modelProviderLogos = { openai: openaiLogo, anthropic: anthropicLogo, google: googleLogo, groq: groqLogo, mistral: mistralLogo, deepseek: deepseekLogo, openrouter: openrouterLogo, xai: xaiLogo, cerebras: cerebrasLogo, cohere: cohereLogo, fireworks: fireworksLogo, together: togetherLogo, ollama: ollamaLogo };
const lightModelProviderLogos = new Set(["xai", "cohere"]);
const DEFAULT_AGENT_RUN_TOKEN_LIMIT = 128_000;

function UsageBreakdown({ heading, items, nameKey }) {
  return <section className="usage-breakdown">
    <h4>{heading}</h4>
    {!items.length && <p className="settings-note">No completed runs this month.</p>}
    {items.slice(0, 5).map((item) => {
      const totalRuns = item.pricedRuns + item.unpricedRuns;
      const pricing = item.estimatedCostUsd == null ? "No estimate" : formatUsd(item.estimatedCostUsd);
      const priceCount = item.unpricedRuns > 0
        ? `${item.pricedRuns} priced · ${item.unpricedRuns} unpriced`
        : `${item.pricedRuns} priced`;
      return <div className="usage-breakdown-row" key={item[nameKey]}>
        <span title={item[nameKey]}>{item[nameKey]}</span>
        <span>{pricing} · {totalRuns} {totalRuns === 1 ? "run" : "runs"} ({priceCount})</span>
      </div>;
    })}
    {items.length > 5 && <p className="settings-note">Showing the five highest estimated totals.</p>}
  </section>;
}

function ModelCatalog({ models, onModelsChange, onToggle, onSetDefault, defaultModelId, defaultModelSaving, providerConnectionsLoading, toggleBusy, error, onError, initialModelId = null }) {
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const initialEditorOpened = useRef("");
  const orderedModels = sortModelCatalog(models, defaultModelId);
  const visibleModels = search.trim()
    ? orderedModels.filter((model) => `${modelDisplayName(model)} ${model.name} ${model.id} ${model.provider}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
    : orderedModels;
  function edit(model) {
    setEditingId(model.id);
    setDraft({
      displayName: model.displayName ?? "",
      contextWindow: model.contextWindow ?? "",
      maxOutputTokens: model.maxOutputTokens ?? "",
      inputModalities: model.inputModalities?.map((value) => String(value).toLowerCase()) ?? [],
      outputModalities: model.outputModalities?.map((value) => String(value).toLowerCase()) ?? [],
      toolCalling: model.toolCalling == null ? "" : String(model.toolCalling),
      reasoningEfforts: model.reasoningEfforts ?? [],
      inputPricePerMillionUsd: model.inputPricePerMillionUsd ?? "",
      outputPricePerMillionUsd: model.outputPricePerMillionUsd ?? "",
    });
    onError("");
  }
  useEffect(() => {
    if (!initialModelId || initialEditorOpened.current === initialModelId) return;
    const model = models.find((entry) => entry.id === initialModelId);
    if (!model) return;
    initialEditorOpened.current = initialModelId;
    edit(model);
    requestAnimationFrame(() => document.getElementById(`model-catalog-${encodeURIComponent(model.id)}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [initialModelId, models]);
  async function save(event, model) {
    event.preventDefault();
    if (saving) return;
    const integerOrNull = (value) => value === "" ? null : Number(value);
    const metadata = {
      displayName: draft.displayName.trim(),
      contextWindow: integerOrNull(draft.contextWindow),
      maxOutputTokens: integerOrNull(draft.maxOutputTokens),
      inputModalities: draft.inputModalities.length ? draft.inputModalities : null,
      outputModalities: draft.outputModalities.length ? draft.outputModalities : null,
      toolCalling: draft.toolCalling === "" ? null : draft.toolCalling === "true",
      reasoningEfforts: draft.reasoningEfforts.length ? draft.reasoningEfforts : null,
      inputPricePerMillionUsd: draft.inputPricePerMillionUsd === "" ? null : draft.inputPricePerMillionUsd,
      outputPricePerMillionUsd: draft.outputPricePerMillionUsd === "" ? null : draft.outputPricePerMillionUsd,
    };
    setSaving(true);
    onError("");
    try {
      const { models: updated } = await runtime.updateModelMetadata(model.id, metadata);
      onModelsChange(updated);
      setEditingId(null);
      setDraft(null);
    } catch (saveError) {
      onError(`Model details could not be saved: ${saveError.message}`);
    } finally {
      setSaving(false);
    }
  }
  async function resetProviderData(model) {
    if (saving) return;
    setSaving(true);
    onError("");
    try {
      const { models: updated } = await runtime.updateModelMetadata(model.id, { resetProviderData: true });
      onModelsChange(updated);
      setEditingId(null);
      setDraft(null);
    } catch (resetError) {
      onError(`Provider details could not be restored: ${resetError.message}`);
    } finally {
      setSaving(false);
    }
  }
  const setField = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const modalities = ["text", "image", "audio", "video"];
  const modalityLabel = { text: "Text", image: "Image", audio: "Audio", video: "Video" };
  const modalityIcon = { text: TextT, image: ImageIcon, audio: SpeakerHigh, video: VideoCamera };
  const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const effortLabel = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
  return <>
    {models.length > 8 && <label className="model-catalog-search"><MagnifyingGlass aria-hidden="true" size={15} /><input aria-label="Search model catalogue" autoComplete="off" onChange={(event) => setSearch(event.target.value)} placeholder="Find a model or provider" type="search" value={search} /></label>}
    <div className="model-catalog-list">{visibleModels.length ? visibleModels.map((model) => <article className="model-catalog-entry" id={`model-catalog-${encodeURIComponent(model.id)}`} key={model.id}>
      <div className="model-catalog-row"><div className="model-catalog-copy"><strong>{modelDisplayName(model)}</strong><code>{model.id}</code><small>{[
        model.contextWindow && `${new Intl.NumberFormat().format(model.contextWindow)} context`,
        model.maxOutputTokens && `${new Intl.NumberFormat().format(model.maxOutputTokens)} max output`,
        model.inputModalities?.length && `Input: ${model.inputModalities.join(", ")}`,
        model.outputModalities?.length && `Output: ${model.outputModalities.join(", ")}`,
        model.reasoningEfforts?.length && `Effort: ${model.reasoningEfforts.join(", ")}`,
        model.inputPricePerMillionUsd != null && `Input $${model.inputPricePerMillionUsd}/M`,
        model.outputPricePerMillionUsd != null && `Output $${model.outputPricePerMillionUsd}/M`,
      ].filter(Boolean).join(" · ") || "Capabilities not reported by this provider"}</small><small>Details: {model.metadataSource || "unknown"}{model.metadataUpdatedAt ? " · edited" : ""}</small></div><div className="model-catalog-actions">{model.id === defaultModelId ? <span className="model-default-badge"><Check size={12} weight="bold" />Default</span> : <IconButton disabled={!model.allowed || model.toolCalling === false || Boolean(defaultModelSaving) || providerConnectionsLoading} label={defaultModelSaving === model.id ? `Setting ${model.name} as the workspace default` : providerConnectionsLoading ? "Loading provider settings" : !model.allowed ? `Allow ${model.name} before setting it as the default` : model.toolCalling === false ? `${model.name} cannot use agent tools` : `Set ${model.name} as the workspace default`} onClick={() => onSetDefault(model)}>{defaultModelSaving === model.id ? <CircleNotch className="spin" size={15} /> : <Star size={15} />}</IconButton>}<IconButton label={`Edit capabilities for ${model.name}`} onClick={() => editingId === model.id ? setEditingId(null) : edit(model)}><PencilSimple size={15} /></IconButton><button aria-checked={Boolean(model.allowed)} aria-label={`${model.allowed ? "Disallow" : "Allow"} ${model.name}`} className={`model-catalog-switch ${model.allowed ? "model-catalog-switch--on" : ""}`} disabled={toggleBusy === model.id} onClick={() => onToggle(model)} role="switch" type="button"><span /></button></div></div>
      {editingId === model.id && draft && <form className="model-metadata-form" onSubmit={(event) => save(event, model)}>
        <label className="model-metadata-display-name">Display name<input maxLength="120" onChange={(event) => setField("displayName", event.target.value)} placeholder={model.name} value={draft.displayName} /><small>Shown in model selectors. The provider model ID stays unchanged.</small></label>
        <label>Context window<input min="1" onChange={(event) => setField("contextWindow", event.target.value)} placeholder="Unknown" type="number" value={draft.contextWindow} /></label>
        <label>Maximum output<input min="1" onChange={(event) => setField("maxOutputTokens", event.target.value)} placeholder="Unknown" type="number" value={draft.maxOutputTokens} /></label>
        <h4 className="model-metadata-heading">Capabilities and pricing</h4>
        <p className="model-metadata-note">Leave values blank when the provider has not reported them.</p>
        {[["inputModalities", "Input modalities"], ["outputModalities", "Output modalities"]].map(([field, label]) => {
          const options = [...new Set([...modalities, ...draft[field]])];
          return <fieldset className="model-capability-options" key={field}><legend>{label}</legend><div>{options.map((modality) => { const Icon = modalityIcon[modality]; const labelText = modalityLabel[modality] ?? modality; return <button aria-label={`${labelText} ${field === "inputModalities" ? "input" : "output"}`} aria-pressed={draft[field].includes(modality)} className={`model-modality-option${draft[field].includes(modality) ? " model-modality-option--selected" : ""}`} key={modality} onClick={() => setDraft((current) => ({ ...current, [field]: current[field].includes(modality) ? current[field].filter((item) => item !== modality) : [...current[field], modality] }))} title={`${labelText} ${field === "inputModalities" ? "input" : "output"}`} type="button">{Icon ? <Icon aria-hidden="true" size={16} /> : labelText}</button>; })}</div></fieldset>;
        })}
        <label>Tool calling<select onChange={(event) => setField("toolCalling", event.target.value)} value={draft.toolCalling}><option value="">Unknown</option><option value="true">Supported</option><option value="false">Not supported</option></select></label>
        <fieldset className="model-effort-options"><legend>Supported effort levels</legend><div>{efforts.map((effort) => <button aria-pressed={draft.reasoningEfforts.includes(effort)} className={`model-effort-option${draft.reasoningEfforts.includes(effort) ? " model-effort-option--selected" : ""}`} key={effort} onClick={() => setDraft((current) => ({ ...current, reasoningEfforts: current.reasoningEfforts.includes(effort) ? current.reasoningEfforts.filter((item) => item !== effort) : efforts.filter((item) => current.reasoningEfforts.includes(item) || item === effort) }))} type="button">{effortLabel[effort]}</button>)}</div></fieldset>
        <label>Input price per million tokens<input min="0" onChange={(event) => setField("inputPricePerMillionUsd", event.target.value)} placeholder="Unknown" step="any" type="number" value={draft.inputPricePerMillionUsd} /></label>
        <label>Output price per million tokens<input min="0" onChange={(event) => setField("outputPricePerMillionUsd", event.target.value)} placeholder="Unknown" step="any" type="number" value={draft.outputPricePerMillionUsd} /></label>
        <div className="model-metadata-actions"><button className="button button--quiet" disabled={saving} onClick={() => void resetProviderData(model)} type="button">Restore provider details</button><span /><button className="button button--quiet" disabled={saving} onClick={() => { setEditingId(null); setDraft(null); }} type="button">Cancel</button><button className="button button--quiet" disabled={saving} type="submit">{saving ? "Saving…" : "Save details"}</button></div>
      </form>}
    </article>) : <p className="model-catalog-no-results">No models match “{search.trim()}”.</p>}</div>
    {error && <p className="recipe-error" role="alert">{error}</p>}
  </>;
}

function MonthToDateUsage({ usage }) {
  const month = usage.monthToDate ?? {};
  const tokens = Number.isFinite(Number(month.tokens)) ? Number(month.tokens) : 0;
  const unpricedRuns = Number.isFinite(Number(month.unpricedRuns)) ? Number(month.unpricedRuns) : 0;
  const remainingTokens = usage.budget.remainingTokens;
  return <>
    <div className="usage-metrics usage-metrics--month" aria-label="Usage this month">
      <div><span>Estimated spend</span><strong>{formatUsd(month.estimatedCostUsd)}</strong></div>
      <div><span>Tokens used</span><strong>{new Intl.NumberFormat().format(tokens)}</strong></div>
      <div><span>Tokens left</span><strong>{remainingTokens == null ? "No limit" : new Intl.NumberFormat().format(remainingTokens)}</strong></div>
      <div><span>Runs without an estimate</span><strong>{unpricedRuns}</strong></div>
    </div>
    {unpricedRuns > 0 && <p className="usage-unpriced-note">The estimate excludes {unpricedRuns} {unpricedRuns === 1 ? "run" : "runs"} with no provider price data.</p>}
    <div className="usage-breakdown-grid">
      <UsageBreakdown heading="By model" items={month.byModel ?? []} nameKey="model" />
      <UsageBreakdown heading="By role" items={month.byAgent ?? []} nameKey="agent" />
    </div>
  </>;
}

export function SettingsView({ project, runtimeStatus, agentRuntime, usage, webAccess, computerAccess, onSaveUsageBudget, onSaveWebAccess, onSaveComputerAccess, onConfigureModel, onSetWorkspaceDefault, onManageMcp, onExportBackup, onImportBackup, onExportAudit, onClose, initialSection = "workspace", initialModelId = null }) {
  const [budgetInput, setBudgetInput] = useState("");
  const [runCostInput, setRunCostInput] = useState("");
  const [runTokenInput, setRunTokenInput] = useState(String(DEFAULT_AGENT_RUN_TOKEN_LIMIT));
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [webEnabled, setWebEnabled] = useState(false);
  const [webDomains, setWebDomains] = useState("");
  const [webSaving, setWebSaving] = useState(false);
  const [webError, setWebError] = useState("");
  const [computerEnabled, setComputerEnabled] = useState(false);
  const [computerSaving, setComputerSaving] = useState(false);
  const [computerError, setComputerError] = useState("");
  const [providerChecking, setProviderChecking] = useState(false);
  const [providerCheck, setProviderCheck] = useState(null);
  const [providerConnections, setProviderConnections] = useState([]);
  const [providerConnectionsLoading, setProviderConnectionsLoading] = useState(false);
  const [providerFormOpen, setProviderFormOpen] = useState(false);
  const [connectionProvider, setConnectionProvider] = useState(() => agentRuntime.model?.split(":", 1)[0] || "openai");
  const [customProviderMode, setCustomProviderMode] = useState(() => !modelProviders.includes(agentRuntime.model?.split(":", 1)[0] || "openai"));
  const [connectionApiKey, setConnectionApiKey] = useState("");
  const [connectionBaseUrl, setConnectionBaseUrl] = useState("");
  const [connectionSaving, setConnectionSaving] = useState(false);
  const [defaultModelSaving, setDefaultModelSaving] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [manualModelSetupRequired, setManualModelSetupRequired] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState("");
  const [modelCatalog, setModelCatalog] = useState([]);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState("");
  const [modelToggleBusy, setModelToggleBusy] = useState(null);
  const providerCheckRequest = useRef(0);
  const [backupPending, setBackupPending] = useState(false);
  const [backupError, setBackupError] = useState("");
  const [restoreFile, setRestoreFile] = useState(null);
  const [restoreReview, setRestoreReview] = useState(false);
  const settingsDialogRef = useRef(null);
  const restoreDialogRef = useRef(null);
  const [restorePending, setRestorePending] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const [restoreStaged, setRestoreStaged] = useState(null);
  const [auditPending, setAuditPending] = useState(false);
  useDialogFocus(settingsDialogRef);
  useDialogFocus(restoreDialogRef, restoreReview);
  const [auditError, setAuditError] = useState("");
  const [desktopAccess, setDesktopAccess] = useState(null);
  const [desktopAccessError, setDesktopAccessError] = useState("");
  const [desktopAccessChecking, setDesktopAccessChecking] = useState(false);
  const [commandTools, setCommandTools] = useState([]);
  const [commandToolInput, setCommandToolInput] = useState("");
  const [commandToolsLoading, setCommandToolsLoading] = useState(false);
  const [commandToolsSaving, setCommandToolsSaving] = useState(false);
  const [commandToolsError, setCommandToolsError] = useState("");
  const [activeSection, setActiveSection] = useState(() => settingsSections.some(({ id }) => id === initialSection) ? initialSection : "workspace");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [expandedProviders, setExpandedProviders] = useState(() => new Set());
  const [providerSearch, setProviderSearch] = useState("");
  const [providerToggleBusy, setProviderToggleBusy] = useState("");
  useEffect(() => {
    providerCheckRequest.current += 1;
    setProviderChecking(false);
    setProviderCheck(null);
  }, [project.id, agentRuntime.model]);
  useEffect(() => {
    if (activeSection !== "models") return undefined;
    let current = true;
    setModelCatalogLoading(true);
    setModelCatalogError("");
    setProviderConnectionsLoading(true);
    runtime.getModelCatalog().then(({ models = [] }) => {
      if (current) {
        setModelCatalog(models);
      }
    }).catch((error) => {
      if (current) setModelCatalogError(error.message || "Could not load available models.");
    }).finally(() => {
      if (current) setModelCatalogLoading(false);
    });
    runtime.getProviders().then(({ providers = [] }) => {
      if (current) {
        setProviderConnections(providers);
        const preferredProvider = agentRuntime.model?.split(":", 1)[0] || providers[0]?.id || "openai";
        setSelectedProvider(preferredProvider);
        setExpandedProviders(new Set([preferredProvider]));
        setConnectionProvider(preferredProvider);
        setConnectionBaseUrl(providers.find((provider) => provider.id === preferredProvider)?.baseUrl ?? "");
        setProviderFormOpen(false);
      }
    }).catch((error) => {
      if (current) setConnectionError(error.message || "Could not load provider connections.");
    }).finally(() => {
      if (current) setProviderConnectionsLoading(false);
    });
    return () => { current = false; };
  }, [activeSection, agentRuntime.model]);
  useEffect(() => {
    setBudgetInput(usage.budget.monthlyTokenLimit == null ? "" : String(usage.budget.monthlyTokenLimit));
    setRunCostInput(usage.budget.maxRunCostUsd == null ? "" : String(usage.budget.maxRunCostUsd));
    setRunTokenInput(usage.budget.maxRunTokens == null ? String(DEFAULT_AGENT_RUN_TOKEN_LIMIT) : String(usage.budget.maxRunTokens));
  }, [usage.budget.monthlyTokenLimit, usage.budget.maxRunCostUsd, usage.budget.maxRunTokens]);
  useEffect(() => {
    setWebEnabled(webAccess.enabled);
    setWebDomains(webAccess.allowedDomains.join("\n"));
  }, [project.id, webAccess]);
  useEffect(() => {
    setComputerEnabled(Boolean(computerAccess?.enabled));
  }, [project.id, computerAccess]);
  useEffect(() => {
    if (activeSection !== "commands" || !project.id) return;
    let cancelled = false;
    setCommandToolsLoading(true);
    setCommandToolsError("");
    runtime.getProjectCommandTools(project.id).then(({ executables }) => {
      if (!cancelled) setCommandTools(executables);
    }).catch((error) => {
      if (!cancelled) setCommandToolsError(error.message || "Could not load command tools.");
    }).finally(() => {
      if (!cancelled) setCommandToolsLoading(false);
    });
    return () => { cancelled = true; };
  }, [activeSection, project.id]);
  async function saveBudget(event) {
    event.preventDefault();
    if (budgetInput && (!/^\d+$/.test(budgetInput) || Number(budgetInput) < 1)) return;
    if (runCostInput && (!Number.isFinite(Number(runCostInput)) || Number(runCostInput) <= 0 || Number(runCostInput) > 1_000_000)) return;
    if (runTokenInput && (!/^\d+$/.test(runTokenInput) || Number(runTokenInput) < 1 || Number(runTokenInput) > 1_000_000_000)) return;
    setBudgetSaving(true);
    await onSaveUsageBudget(budgetInput ? Number(budgetInput) : null, runCostInput || null, runTokenInput ? Number(runTokenInput) : null);
    setBudgetSaving(false);
  }
  async function toggleModel(model) {
    setModelToggleBusy(model.id);
    setModelCatalogError("");
    try {
      const { models } = await runtime.setModelAllowed(model.id, !model.allowed);
      setModelCatalog(models.map((updated) => ({ ...updated, providerEnabled: modelCatalog.find((entry) => entry.id === updated.id)?.providerEnabled ?? true })));
    } catch (error) {
      const messages = {
        model_is_pinned_by_agent: "This model is pinned in an agent profile. Change that profile before disallowing it.",
        workspace_default_model_must_remain_allowed: "The workspace default model must remain allowed.",
      };
      setModelCatalogError(messages[error.message] ?? `Model access could not be updated: ${error.message}`);
    } finally {
      setModelToggleBusy(null);
    }
  }
  async function toggleProvider(connection) {
    const enabled = connection.enabled === false;
    setProviderToggleBusy(connection.id);
    setConnectionError("");
    try {
      const { connection: updated } = await runtime.setProviderEnabled(connection.id, enabled);
      setProviderConnections((current) => current.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
      setModelCatalog((current) => current.map((model) => model.provider === updated.id ? { ...model, providerEnabled: enabled } : model));
    } catch (error) {
      setConnectionError(error.message === "provider_is_in_use"
        ? "Choose another workspace default and remove this provider from agent profiles before turning it off."
        : `Provider could not be updated: ${error.message}`);
    } finally {
      setProviderToggleBusy("");
    }
  }
  async function connectProvider(event) {
    event.preventDefault();
    if (connectionSaving) return;
    setConnectionSaving(true);
    setConnectionError("");
    setManualModelSetupRequired(false);
    setConnectionNotice("");
    try {
      const result = await runtime.connectProvider(
        connectionProvider.trim().toLowerCase(), connectionApiKey, connectionBaseUrl,
      );
      setProviderConnections((current) => [
        ...current.filter((item) => item.id !== result.connection.id),
        { ...result.connection, enabled: result.connection.enabled !== false, modelCount: result.catalog.filter((model) => model.provider === result.connection.id).length },
      ].sort((a, b) => a.id.localeCompare(b.id)));
      setModelCatalog(result.catalog.map((model) => ({ ...model, providerEnabled: true })));
      setSelectedProvider(result.connection.id);
      setConnectionProvider(result.connection.id);
      setConnectionBaseUrl(result.connection.baseUrl ?? connectionBaseUrl);
      setConnectionApiKey("");
      setProviderFormOpen(false);
      setConnectionNotice(`Found ${result.models.length} models. Allow a model below, then set it as the workspace default from its row.`);
    } catch (error) {
      const messages = {
        provider_model_discovery_unsupported: "This provider does not expose a compatible model list. Add a model manually with its model ID.",
        provider_models_unauthorized: "The provider rejected this key. Check it and try again.",
        provider_models_unavailable: "Could not reach the provider. Check the service URL and try again.",
        provider_custom_url_unsupported: "This provider does not accept a custom service URL.",
      };
      setManualModelSetupRequired(error.message === "provider_model_discovery_unsupported");
      setConnectionError(messages[error.message] ?? error.message);
    } finally {
      setConnectionSaving(false);
    }
  }
  async function fetchProviderModels() {
    if (!selectedProviderConnection || connectionSaving) return;
    setConnectionSaving(true);
    setConnectionError("");
    setConnectionNotice("");
    try {
      const result = await runtime.connectProvider(selectedProviderId, "", selectedProviderConnection.baseUrl ?? "");
      setProviderConnections((current) => current.map((item) => item.id === result.connection.id
        ? { ...item, ...result.connection, enabled: result.connection.enabled !== false, modelCount: result.catalog.filter((model) => model.provider === result.connection.id).length }
        : item));
      setModelCatalog(result.catalog.map((model) => ({ ...model, providerEnabled: selectedProviderConnection.enabled !== false })));
      setConnectionNotice(`Found ${result.models.length} models.`);
    } catch (error) {
      const messages = {
        provider_model_discovery_unsupported: "This provider does not expose a compatible model list. Add a model manually with its model ID.",
        provider_models_unauthorized: "The provider rejected the saved key. Edit the connection to replace it.",
        provider_models_unavailable: "Could not reach the provider. Check the service URL and try again.",
      };
      setManualModelSetupRequired(error.message === "provider_model_discovery_unsupported");
      setConnectionError(messages[error.message] ?? error.message);
    } finally {
      setConnectionSaving(false);
    }
  }
  async function setWorkspaceDefault(model) {
    const connection = providerConnections.find((entry) => entry.id === model.provider);
    setDefaultModelSaving(model.id);
    try {
      const currentProvider = agentRuntime.model?.split(":", 1)[0];
      const baseUrl = connection?.baseUrl ?? (currentProvider === model.provider ? agentRuntime.baseUrl ?? "" : "");
      await onSetWorkspaceDefault(model.id, baseUrl);
    } finally {
      setDefaultModelSaving("");
    }
  }
  async function saveWebAccess(event) {
    event.preventDefault();
    setWebSaving(true);
    setWebError("");
    try {
      await onSaveWebAccess(webEnabled, webDomains.split(/[\n,]/).map((domain) => domain.trim()).filter(Boolean));
    } catch (error) {
      setWebError(error.message);
    } finally {
      setWebSaving(false);
    }
  }
  async function saveComputerAccess(event) {
    event.preventDefault();
    setComputerSaving(true);
    setComputerError("");
    try {
      await onSaveComputerAccess(computerEnabled);
    } catch (error) {
      setComputerError(error.message || "Computer access could not be saved.");
    } finally {
      setComputerSaving(false);
    }
  }
  async function saveCommandTools(nextTools) {
    setCommandToolsSaving(true);
    setCommandToolsError("");
    try {
      const { executables } = await runtime.saveProjectCommandTools(project.id, nextTools);
      setCommandTools(executables);
      return true;
    } catch (error) {
      setCommandToolsError(error.message || "Command tools could not be saved.");
      return false;
    } finally {
      setCommandToolsSaving(false);
    }
  }
  async function addCommandTool(event) {
    event.preventDefault();
    const executable = commandToolInput.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(executable) || commandTools.includes(executable)) return;
    if (await saveCommandTools([...commandTools, executable])) setCommandToolInput("");
  }
  async function checkProvider() {
    const requestId = ++providerCheckRequest.current;
    setProviderChecking(true);
    setProviderCheck(null);
    try {
      const { check } = await runtime.checkProvider();
      if (providerCheckRequest.current === requestId) setProviderCheck(check);
    } catch (error) {
      if (providerCheckRequest.current === requestId) setProviderCheck({ ok: false, error: error.message });
    } finally {
      if (providerCheckRequest.current === requestId) setProviderChecking(false);
    }
  }
  function configureModel(modelId = null, baseUrl = "", apiKey = "") {
    providerCheckRequest.current += 1;
    setProviderChecking(false);
    setProviderCheck(null);
    if (modelId) onConfigureModel(modelId, baseUrl, apiKey);
    else onConfigureModel();
  }
  async function checkDesktopAccess() {
    setDesktopAccessChecking(true);
    setDesktopAccessError("");
    try {
      setDesktopAccess(await invoke("probe_desktop_access"));
    } catch (error) {
      setDesktopAccessError(error instanceof Error ? error.message : "Could not check desktop access.");
    } finally {
      setDesktopAccessChecking(false);
    }
  }
  async function openDesktopPrivacySettings(capability) {
    setDesktopAccessError("");
    try {
      await invoke("open_desktop_privacy_settings", { capability });
    } catch (error) {
      setDesktopAccessError(error instanceof Error ? error.message : "Could not open system settings.");
    }
  }
  async function downloadBackup() {
    setBackupPending(true);
    setBackupError("");
    try {
      await onExportBackup();
    } catch (error) {
      setBackupError(error.message);
    } finally {
      setBackupPending(false);
    }
  }
  async function restoreWorkspace() {
    if (!restoreFile) return;
    setRestorePending(true);
    setRestoreError("");
    try {
      const result = await onImportBackup(restoreFile);
      setRestoreStaged(result.workspace);
      setRestoreReview(false);
      setRestoreFile(null);
    } catch (error) {
      setRestoreError(error.message);
    } finally {
      setRestorePending(false);
    }
  }
  async function downloadAudit() {
    setAuditPending(true);
    setAuditError("");
    try {
      await onExportAudit();
    } catch (error) {
      setAuditError(error.message);
    } finally {
      setAuditPending(false);
    }
  }
  const workspaceStatus = runtimeStatus === "connected" ? "Ready"
    : runtimeStatus === "offline" ? "Offline"
      : runtimeStatus === "reconnecting" ? "Reconnecting" : "Starting";
  const workspaceDescription = runtimeStatus === "offline"
? "The local workspace is offline. Your saved projects and chat history remain on this device."
    : runtimeStatus === "reconnecting"
      ? "Reconnecting to the local workspace on this device."
      : runtimeStatus === "connected"
? "Your projects and chat history stay on this device."
        : "Starting the local workspace on this device.";
  const selectedSection = settingsSections.find((section) => section.id === activeSection) ?? settingsSections[0];
  const providerReadiness = providerChecking
    ? { tone: "checking", label: "Checking connection" }
    : providerCheck
      ? !providerCheck.ok
        ? { tone: "error", label: "Connection failed" }
        : providerCheck.toolCalling
          ? { tone: "ready", label: "Ready for agents" }
          : { tone: "attention", label: "Tool support needed" }
      : agentRuntime.enabled
        ? { tone: "ready", label: "Ready for agents" }
        : agentRuntime.configured
          ? { tone: "attention", label: "Needs attention" }
          : { tone: "disconnected", label: "Not connected" };
  const allowedAgentModels = modelCatalog.filter((model) => model.providerEnabled !== false && model.allowed && model.toolCalling !== false);
  const providerRows = [...new Set([...modelProviders, ...providerConnections.map((item) => item.id)])]
    .filter((id) => `${modelProviderLabels[id] ?? id} ${id}`.toLowerCase().includes(providerSearch.trim().toLowerCase()))
    .map((id) => providerConnections.find((item) => item.id === id) ?? { id, status: "not_configured", modelCount: 0, enabled: false });
  const selectedProviderId = connectionProvider.trim().toLowerCase();
  const selectedProviderConnection = providerConnections.find((connection) => connection.id === selectedProviderId);
  const providerUsesLocalService = selectedProviderId === "ollama";
  const savedProviderCredential = Boolean(selectedProviderConnection?.credentialAvailable);
  const providerHasSavedConnection = Boolean(selectedProviderConnection && selectedProviderConnection.status !== "not_configured");
  const addingCustomProvider = customProviderMode && !selectedProvider;
  const providerFormTitle = addingCustomProvider
    ? "Add custom provider"
    : `${providerHasSavedConnection ? "Edit" : "Connect"} ${modelProviderLabels[selectedProviderId] ?? selectedProviderId}`;
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (restoreReview) setRestoreReview(false);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, restoreReview]);
  return <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
    <section className="settings-dialog" aria-modal="true" aria-labelledby="settings-title" ref={settingsDialogRef} role="dialog" tabIndex={-1}>
      <header className="settings-dialog-header"><div><span className="eyebrow">Workspace</span><h2 id="settings-title">Settings</h2><p>Manage models, access and local data.</p></div><IconButton label="Close settings" onClick={onClose}><X size={17} /></IconButton></header>
      <div className="settings-dialog-body">
        <nav className="settings-section-nav" aria-label="Settings sections" role="tablist" aria-orientation="vertical">
          {settingsSections.map(({ id, label, icon: Icon }) => <button aria-controls="settings-section-panel" aria-selected={activeSection === id} className={`settings-section-tab ${activeSection === id ? "settings-section-tab--active" : ""}`} id={`settings-tab-${id}`} key={id} onClick={() => setActiveSection(id)} role="tab" type="button"><Icon size={16} /><span>{label}</span></button>)}
        </nav>
        <div aria-labelledby={`settings-tab-${activeSection}`} className={`settings-section-panel${activeSection === "models" && selectedModelId ? " settings-section-panel--model-detail" : ""}`} id="settings-section-panel" role="tabpanel">
          <div className={`settings-section-heading${activeSection === "models" ? " settings-section-heading--models" : ""}`}><h3>{selectedSection.label}</h3>{activeSection !== "models" && <p>{settingsDescription(activeSection, project.name)}</p>}</div>
          {activeSection === "workspace" && <section className="settings-card"><div className="settings-card-heading"><span className="settings-symbol"><DesktopTower size={18} /></span><div><h3>This device</h3><p>{workspaceDescription}</p></div></div><span className={`settings-device-status settings-device-status--${runtimeStatus}`}><i />{workspaceStatus}</span></section>}
          {activeSection === "models" && <div className="model-default-summary"><span className="settings-symbol"><Sparkle size={17} /></span><div><strong>Workspace default</strong><small>{agentRuntime.configured ? agentRuntime.model : "Auto · used when a chat or role has no model override"}</small></div><span aria-live="polite" className={`provider-readiness provider-readiness--${providerReadiness.tone}`} role="status"><i aria-hidden="true" />{providerReadiness.label}</span><div className="provider-actions">{allowedAgentModels.length > 0 && <button className="button button--quiet" onClick={() => { const model = modelCatalog.find((entry) => entry.id === agentRuntime.model) ?? allowedAgentModels[0]; setSelectedProvider(model.provider); setSelectedModelId(model.id); setProviderFormOpen(false); }} type="button">{agentRuntime.configured ? "Change" : "Choose"}</button>}<button className="button button--quiet" disabled={!agentRuntime.configured || providerChecking} onClick={checkProvider} type="button">{providerChecking ? "Testing…" : "Test"}</button></div></div>}
          {activeSection === "models" && <section className="settings-card provider-connections-card model-settings-workspace" id="provider-connections-card">
            <div className="provider-connections-heading"><div className="settings-card-heading"><span className="settings-symbol"><Plug size={17} /></span><div><h3>Providers</h3></div></div>{!providerConnectionsLoading && <IconButton label="Add custom provider" onClick={() => {
              setConnectionProvider("");
              setSelectedProvider("");
              setCustomProviderMode(true);
              setConnectionBaseUrl("");
              setConnectionApiKey("");
              setConnectionError("");
              setConnectionNotice("");
              setProviderFormOpen(true);
            }}><Plus size={17} /></IconButton>}</div>
            <div className="provider-explorer">
              <label className="model-catalog-search"><MagnifyingGlass aria-hidden="true" size={15} /><input aria-label="Find a provider" onChange={(event) => setProviderSearch(event.target.value)} placeholder="Find a provider" type="search" value={providerSearch} /></label>
              {providerConnectionsLoading && providerConnections.length === 0 && !providerFormOpen && <p className="settings-note">Loading saved provider connections…</p>}
              <div className="provider-connection-list" aria-label="Providers">{providerRows.map((connection) => {
                const configured = connection.status !== "not_configured";
                const providerModels = sortModelCatalog(modelCatalog.filter((model) => model.provider === connection.id), agentRuntime.model);
                const expanded = expandedProviders.has(connection.id);
                return <section className={`provider-tree-node${selectedProvider === connection.id ? " provider-tree-node--selected" : ""}`} key={connection.id}>
                  <div className="provider-connection-row">
                    {providerModels.length > 0 && <button aria-label={`${expanded ? "Collapse" : "Expand"} models for ${modelProviderLabels[connection.id] ?? connection.id}`} className="provider-tree-caret" onClick={() => setExpandedProviders((current) => { const next = new Set(current); if (next.has(connection.id)) next.delete(connection.id); else next.add(connection.id); return next; })} type="button">{expanded ? <CaretDown size={14} /> : <CaretRight size={14} />}</button>}
                    <button aria-current={selectedProvider === connection.id && !selectedModelId ? "true" : undefined} className="provider-row-select" onClick={() => { setSelectedProvider(connection.id); setSelectedModelId(""); setExpandedProviders(providerModels.length ? new Set([connection.id]) : new Set()); setCustomProviderMode(!modelProviders.includes(connection.id)); setConnectionProvider(connection.id); setConnectionBaseUrl(connection.baseUrl ?? ""); setConnectionApiKey(""); setConnectionError(""); setConnectionNotice(""); setProviderFormOpen(false); }} type="button"><span className="provider-brand-icon">{modelProviderLogos[connection.id] ? <img alt="" className={lightModelProviderLogos.has(connection.id) ? "provider-brand-logo--light" : undefined} src={modelProviderLogos[connection.id]} /> : <Cpu size={18} />}</span><span><strong>{modelProviderLabels[connection.id] ?? connection.id}</strong><small>{configured ? `${connection.modelCount} ${connection.modelCount === 1 ? "model" : "models"}` : "Not configured"}</small></span></button>
                  </div>
                  {expanded && providerModels.map((model) => <button className={`provider-tree-model${selectedModelId === model.id ? " provider-tree-model--selected" : ""}`} key={model.id} onClick={() => { setSelectedProvider(connection.id); setSelectedModelId(model.id); setExpandedProviders(new Set([connection.id])); setProviderFormOpen(false); }} title={model.id} type="button"><i className="provider-model-dot" /><span>{modelDisplayName(model)}</span>{model.id === agentRuntime.model && <Star size={12} weight="fill" />}</button>)}
                </section>;
              })}</div>
            </div>
            <div className="provider-detail-panel">
            {providerFormOpen && <form className="provider-connection-form" onSubmit={connectProvider}>
              <div className="provider-connection-form-heading"><h4>{providerFormTitle}</h4><IconButton label="Close provider form" onClick={() => { setConnectionError(""); setConnectionNotice(""); setProviderFormOpen(false); }}><X size={15} /></IconButton></div>
              <label>{customProviderMode ? "Provider ID" : "Provider"}{customProviderMode ? <input aria-label="Provider ID" autoComplete="off" maxLength="100" onChange={(event) => {
                const nextProvider = event.target.value;
                if (nextProvider.trim().toLowerCase() !== connectionProvider.trim().toLowerCase()) {
                  setConnectionApiKey("");
                  setConnectionBaseUrl("");
                }
                setConnectionProvider(nextProvider);
              }} placeholder="e.g. azure" required value={connectionProvider} /> : <span className="provider-form-name">{modelProviderLabels[selectedProviderId] ?? selectedProviderId}</span>}</label>
              <label>Service URL<input autoComplete="url" onChange={(event) => setConnectionBaseUrl(event.target.value)} placeholder="Provider default" value={connectionBaseUrl} /><small>Optional. Remote endpoints must use HTTPS.</small></label>
              {providerUsesLocalService ? <small className="provider-connection-key-note">No API key needed for a local Ollama service.</small> : <label>API key{savedProviderCredential ? " (optional)" : ""}<input autoComplete="off" onChange={(event) => setConnectionApiKey(event.target.value)} placeholder={savedProviderCredential ? "Leave blank to keep the saved key" : "Enter API key"} type="password" value={connectionApiKey} /></label>}
              <div className="provider-connection-actions"><button className="button button--primary" disabled={connectionSaving || !connectionProvider.trim()} type="submit">{connectionSaving ? "Connecting…" : providerHasSavedConnection ? "Save and fetch models" : "Connect and fetch models"}</button><button className="button button--quiet" disabled={connectionSaving || !connectionProvider.trim()} onClick={() => { configureModel(`${connectionProvider.trim().toLowerCase()}:`, connectionBaseUrl, connectionApiKey); setConnectionApiKey(""); }} type="button"><Plus size={14} />Add model manually</button></div>
            </form>}
            {connectionError && <div className="provider-connection-error" role="alert"><p className="recipe-error">{connectionError}</p>{manualModelSetupRequired && <button className="button button--quiet" onClick={() => { configureModel(`${connectionProvider.trim().toLowerCase()}:`, connectionBaseUrl, connectionApiKey); setConnectionApiKey(""); }} type="button">Enter model ID manually</button>}</div>}
            {connectionNotice && <p className="provider-check provider-check--ok" role="status">{connectionNotice}</p>}
            {!providerFormOpen && !selectedModelId && selectedProvider && <section className="provider-selected-detail" aria-label={`${modelProviderLabels[selectedProvider] ?? selectedProvider} settings`}>
              <div className="provider-selected-heading"><span className="provider-brand-icon provider-brand-icon--large">{modelProviderLogos[selectedProvider] ? <img alt="" className={lightModelProviderLogos.has(selectedProvider) ? "provider-brand-logo--light" : undefined} src={modelProviderLogos[selectedProvider]} /> : <Cpu size={20} />}</span><div><h3>{modelProviderLabels[selectedProvider] ?? selectedProvider}</h3><small>{selectedProviderConnection?.status === "not_configured" || !selectedProviderConnection ? "Not configured" : selectedProviderConnection.baseUrl || "Provider default endpoint"}</small></div><button aria-checked={selectedProviderConnection?.enabled !== false} aria-label={`${selectedProviderConnection?.enabled === false ? "Enable" : "Disable"} ${modelProviderLabels[selectedProvider] ?? selectedProvider}`} className={`model-catalog-switch${selectedProviderConnection?.enabled !== false ? " model-catalog-switch--on" : ""}`} disabled={!selectedProviderConnection || selectedProviderConnection.status === "not_configured" || providerToggleBusy === selectedProvider} onClick={() => selectedProviderConnection && void toggleProvider(selectedProviderConnection)} role="switch" type="button"><span /></button></div>
              <div className="provider-overview-actions"><button className="button button--quiet" onClick={() => { setConnectionProvider(selectedProvider); setConnectionBaseUrl(selectedProviderConnection?.baseUrl ?? ""); setConnectionApiKey(""); setConnectionError(""); setConnectionNotice(""); setCustomProviderMode(!modelProviders.includes(selectedProvider)); setProviderFormOpen(true); }} type="button"><PencilSimple size={14} />{selectedProviderConnection?.status === "not_configured" ? "Configure" : "Edit connection"}</button><button className="button button--quiet" disabled={!selectedProviderConnection || selectedProviderConnection.status === "not_configured" || connectionSaving} onClick={() => void fetchProviderModels()} type="button">{connectionSaving ? "Fetching…" : "Fetch models"}</button><button className="button button--quiet" onClick={() => { configureModel(`${selectedProvider}:`, selectedProviderConnection?.baseUrl ?? "", ""); }} type="button"><Plus size={14} />Add model manually</button></div>
              <div className="provider-models-heading"><h4>Models</h4><span>{modelCatalog.filter((model) => model.provider === selectedProvider).length}</span></div>
              {modelCatalogLoading ? <p className="settings-note">Loading models…</p> : <ModelCatalog models={modelCatalog.filter((model) => model.provider === selectedProvider)} onModelsChange={setModelCatalog} onToggle={toggleModel} onSetDefault={setWorkspaceDefault} defaultModelId={agentRuntime.model} defaultModelSaving={defaultModelSaving} providerConnectionsLoading={providerConnectionsLoading} toggleBusy={modelToggleBusy} error={modelCatalogError} onError={setModelCatalogError} initialModelId={initialModelId} />}
            </section>}
            </div>
          </section>}
          {activeSection === "models" && selectedModelId && <section aria-labelledby="allowed-models-heading" className="settings-card model-catalog-card model-selected-detail" id="model-catalog-card">
            <div className="model-detail-heading"><button aria-label="Back to providers" className="model-back-button" onClick={() => setSelectedModelId("")} type="button"><CaretLeft size={16} /></button><h3 id="allowed-models-heading">{modelDisplayName(modelCatalog.find((model) => model.id === selectedModelId))}</h3><small>{modelProviderLabels[selectedProvider] ?? selectedProvider}</small></div>
            {modelCatalogLoading ? <p className="settings-note">Loading model catalogue…</p> : <ModelCatalog models={modelCatalog.filter((model) => model.id === selectedModelId)} onModelsChange={setModelCatalog} onToggle={toggleModel} onSetDefault={setWorkspaceDefault} defaultModelId={agentRuntime.model} defaultModelSaving={defaultModelSaving} providerConnectionsLoading={providerConnectionsLoading} toggleBusy={modelToggleBusy} error={modelCatalogError} onError={setModelCatalogError} initialModelId={initialModelId} />}
          </section>}
          {activeSection === "connections" && <>
            <section className="settings-card"><div className="settings-card-heading"><span className="settings-symbol"><Plug size={17} /></span><div><h3>Connected services</h3><p>{project.name ? `Services agents can use in ${project.name}. Changes that affect data need your approval.` : "Choose a project to manage its connected services."}</p></div></div><button className="button button--quiet" disabled={!project.id} onClick={onManageMcp} type="button">Manage connections</button></section>
            <section className="settings-card"><div className="settings-card-heading"><span className="settings-symbol"><MagnifyingGlass size={17} /></span><div><h3>Web and browser access</h3><p>Allow agents to research public websites or use the project’s browser. Search, page fetches and browser actions still follow approval rules.</p></div></div><form className="usage-budget-form web-access-form" onSubmit={saveWebAccess}><label className="web-access-toggle"><button aria-checked={webEnabled} className="web-access-switch" disabled={!project.id} onClick={() => setWebEnabled((enabled) => !enabled)} role="switch" type="button"><span /></button><span>Allow website access</span></label><label htmlFor="web-allowed-domains">Allowed websites <small>Enter exact hostnames, one per line. Browser access is unavailable until at least one is listed.</small></label><textarea disabled={!project.id} id="web-allowed-domains" onChange={(event) => setWebDomains(event.target.value)} placeholder="docs.python.org\nreact.dev" rows={3} value={webDomains} /><p className="settings-note">Browser site limits are a guardrail; redirects can leave the list. Navigation and changes in the browser still need your approval.</p>{webError && <p className="recipe-error" role="alert">{webError}</p>}<div className="web-access-footer"><button className="button button--quiet" disabled={!project.id || webSaving} type="submit">{webSaving ? "Saving…" : "Save website settings"}</button></div></form></section>
          </>}
          {activeSection === "commands" && <section className="settings-card command-tools-card"><div className="settings-card-heading"><span className="settings-symbol"><TerminalWindow size={17} /></span><div><h3>Project command tools</h3><p>Choose extra executables for background runs in {project.name || "this project"}. Tribe runs each command in the repository folder with your account's file and network access.</p></div></div>{!project.id ? <p className="settings-note">Choose a project to manage its command tools.</p> : <><form className="command-tools-form" onSubmit={addCommandTool}><label htmlFor="project-command-tool">Executable name</label><div><input autoComplete="off" id="project-command-tool" maxLength={128} onChange={(event) => setCommandToolInput(event.target.value)} placeholder="terraform, gh, or a tool on PATH" value={commandToolInput} /><button className="button button--quiet" disabled={commandToolsSaving || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(commandToolInput.trim()) || commandTools.includes(commandToolInput.trim())} type="submit">Add tool</button></div><small>Enter a command name only, without a path or arguments. You start each background run.</small></form>{commandToolsError && <p className="recipe-error" role="alert">{commandToolsError}</p>}{commandToolsLoading ? <p className="settings-note">Loading command tools…</p> : commandTools.length ? <ul className="command-tool-list">{commandTools.map((executable) => <li key={executable}><code>{executable}</code><button className="text-button" disabled={commandToolsSaving} onClick={() => saveCommandTools(commandTools.filter((item) => item !== executable))} type="button">Remove</button></li>)}</ul> : <p className="settings-note">No extra tools approved. Tribe's built-in command set remains available.</p>}</>}</section>}
          {activeSection === "desktop" && <><section className="settings-card desktop-access-card"><div className="settings-card-heading"><span className="settings-symbol"><DesktopTower size={17} /></span><div><h3>Desktop access</h3><p>Check whether this device can support app inspection. This check does not capture the screen or control apps.</p></div></div><button className="button button--quiet" disabled={!window.__TAURI_INTERNALS__ || desktopAccessChecking} onClick={checkDesktopAccess} type="button">{desktopAccessChecking ? "Checking…" : "Check access"}</button>{!window.__TAURI_INTERNALS__ && <p className="settings-note">Available in the desktop app.</p>}{desktopAccessError && <p className="recipe-error" role="alert">{desktopAccessError}</p>}{desktopAccess && <div className="desktop-access-results" role="status"><p><strong>Screen capture</strong><span>{formatPermission(desktopAccess.screenCapture.permission)}</span><small>{desktopAccess.screenCapture.detail}</small>{desktopAccess.platform === "macos" && <button className="button button--quiet desktop-access-settings-link" onClick={() => openDesktopPrivacySettings("screen_capture")} type="button">Open Screen Recording settings</button>}</p><p><strong>Accessibility</strong><span>{formatPermission(desktopAccess.accessibility.permission)}</span><small>{desktopAccess.accessibility.detail}</small>{desktopAccess.platform === "macos" && <button className="button button--quiet desktop-access-settings-link" onClick={() => openDesktopPrivacySettings("accessibility")} type="button">Open Accessibility settings</button>}</p>{desktopAccess.adapterAvailable ? <p className="settings-note">One-shot window screenshots use the macOS system picker. Accessibility data and app controls are not available.</p> : <p className="settings-note">Window selection depends on this app’s WebView on this platform. Packaged support is not yet verified; accessibility data and app controls are not available.</p>}</div>}</section><section className="settings-card computer-access-card"><div className="settings-card-heading"><span className="settings-symbol"><DesktopTower size={17} /></span><div><h3>Computer use for this project</h3><p>Let agents ask to inspect a window you choose. Each request opens the system picker; Tribe never captures in the background.</p></div></div><form className="computer-access-form" onSubmit={saveComputerAccess}><label className="computer-access-toggle"><input checked={computerEnabled} disabled={!project.id} onChange={(event) => setComputerEnabled(event.target.checked)} role="switch" type="checkbox" /><span className="computer-access-switch" aria-hidden="true" /><span>Allow agents to request a window observation</span></label>{computerError && <p className="recipe-error" role="alert">{computerError}</p>}<button className="button button--quiet" disabled={!project.id || computerSaving || computerEnabled === Boolean(computerAccess?.enabled)} type="submit">{computerSaving ? "Saving…" : "Save access"}</button></form></section></>}
          {activeSection === "data" && <>
            <section className="settings-card"><div className="settings-card-heading"><span className="settings-symbol"><ChartLine size={17} /></span><div><h3>Usage limits</h3><p>Set token and cost limits for {project.name || "this project"}.</p></div></div><MonthToDateUsage usage={usage} /><form className="usage-budget-form" onSubmit={saveBudget}><label htmlFor="agent-run-token-limit">Maximum tokens per agent run <small>Default is {DEFAULT_AGENT_RUN_TOKEN_LIMIT.toLocaleString()}. Increase this for longer requests; the model’s context window still applies.</small></label><input id="agent-run-token-limit" max="1000000000" min="1" onChange={(event) => setRunTokenInput(event.target.value)} placeholder={String(DEFAULT_AGENT_RUN_TOKEN_LIMIT)} type="number" value={runTokenInput} /><label htmlFor="monthly-token-limit">Monthly token limit <small>Leave blank for no monthly limit.</small></label><input id="monthly-token-limit" min="1" onChange={(event) => setBudgetInput(event.target.value)} placeholder="No limit" type="number" value={budgetInput} /><label htmlFor="agent-run-cost-limit">Cost per agent run (USD) <small>Leave blank for no run cost ceiling.</small></label><input id="agent-run-cost-limit" max="1000000" min="0.000001" onChange={(event) => setRunCostInput(event.target.value)} placeholder="No limit" step="any" type="number" value={runCostInput} /><small className="budget-limit-note">Best-effort provider estimate. Unpriced models cannot be capped, and the request that crosses a limit may still be billed.</small><div><button className="button button--quiet" disabled={budgetSaving || !project.id} type="submit">{budgetSaving ? "Saving…" : "Save limits"}</button></div></form></section>
            <section className="settings-card"><div className="settings-card-heading"><span className="settings-symbol"><FolderSimple size={17} /></span><div><h3>Project activity</h3><p>{project.name ? `Download messages and agent updates from ${project.name}.` : "Choose a project to export its activity."} The export contains activity and artifact metadata, not file contents.</p></div></div>{auditError && <p className="recipe-error" role="alert">{auditError}</p>}<button className="button button--quiet" disabled={!project.id || auditPending || runtimeStatus !== "connected"} onClick={downloadAudit} type="button"><DownloadSimple size={15} />{auditPending ? "Preparing export…" : "Download activity"}</button></section>
            <section className="settings-card"><div className="settings-card-heading"><span className="settings-symbol"><ShieldCheck size={17} /></span><div><h3>Workspace backup</h3><p>Includes projects, chat activity, plans, shared files and agent conversation context. Repository files and saved credentials are excluded.</p></div></div>{backupError && <p className="recipe-error" role="alert">{backupError}</p>}<button className="button button--quiet" disabled={backupPending || runtimeStatus !== "connected"} onClick={downloadBackup} type="button"><DownloadSimple size={15} />{backupPending ? "Preparing backup…" : "Download backup"}</button></section>
            <section className="settings-card"><div className="settings-card-heading"><span className="settings-symbol"><UploadSimple size={17} /></span><div><h3>Restore a workspace</h3><p>Import a Tribe backup. Agent roles, workflows and connected-service settings on this device are kept.</p></div></div>
              <div className="restore-file-row"><label className="button button--quiet restore-file-button"><UploadSimple size={14} />Choose backup<input accept=".tribe-backup,application/octet-stream" aria-label="Choose a Tribe workspace backup" className="restore-file-input" key={restoreFile?.name ?? "empty"} onChange={(event) => { setRestoreError(""); setRestoreFile(event.target.files?.[0] ?? null); setRestoreStaged(null); }} type="file" /></label><span>{restoreFile?.name ?? "No backup selected"}</span></div>
              {restoreError && <p className="recipe-error" role="alert">{restoreError}</p>}
              {restoreStaged ? <p className="restore-staged-note" role="status">Backup checked ({restoreStaged.projects} projects, {restoreStaged.missions} chats). Quit and reopen Tribe to finish restoring it. Your current workspace remains in place until then.</p> : <><small className="settings-note">Restoring replaces projects, chats, plans and artifacts. The backup is checked before Tribe schedules the change. Maximum file size: 6 GB.</small><button className="button button--quiet" disabled={!restoreFile || restorePending || runtimeStatus !== "connected"} onClick={() => setRestoreReview(true)} type="button">Review restore</button></>}
            </section>
          </>}
        </div>
      </div>
    </section>
    {restoreReview && <div className="dialog-backdrop restore-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !restorePending) setRestoreReview(false); }} role="presentation"><section aria-labelledby="restore-confirm-title" aria-modal="true" className="mission-dialog restore-confirm-dialog" ref={restoreDialogRef} role="alertdialog" tabIndex={-1}><div className="dialog-heading"><div><span className="eyebrow">Replace local workspace</span><h2 id="restore-confirm-title">Restore this backup?</h2></div><IconButton disabled={restorePending} label="Close" onClick={() => setRestoreReview(false)}><X size={17} /></IconButton></div><p className="restore-confirm-copy"><strong>{restoreFile?.name}</strong> will replace the projects, chats, plans, activity and shared artifacts on this device. Existing agent roles, workflows and connected-service definitions will be kept. Model credentials stay in your device keychain.</p><p className="restore-confirm-copy">Tribe checks the backup before applying it after restart. Active chats, agent runs, commands and scheduled runs must be finished before restoring.</p>{restoreError && <p className="recipe-error" role="alert">{restoreError}</p>}<div className="dialog-actions"><button className="button button--quiet" disabled={restorePending} onClick={() => setRestoreReview(false)} type="button">Cancel</button><button className="button button--primary" disabled={restorePending || runtimeStatus !== "connected"} onClick={restoreWorkspace} type="button">{restorePending ? "Checking backup…" : "Restore and shut down"}</button></div></section></div>}
  </div>;
}

function settingsDescription(section, projectName) {
  return ({
    workspace: "Local storage and app status for this device.",
    models: "Connect a provider, allow an agent-ready model, then set the workspace default.",
    connections: projectName ? `Services and web access for ${projectName}.` : "Choose a project to configure its services.",
    commands: projectName ? `Choose background command tools for ${projectName}.` : "Choose a project to configure its command tools.",
    desktop: "Review the permissions needed for computer-use features.",
    data: "Set usage limits and manage workspace exports.",
  })[section];
}

function formatPermission(permission) {
  const labels = {
    granted: "Permission granted",
    required: "Permission needed",
    user_selection_required: "Choose a window when starting",
    not_required: "No separate permission",
    unsupported: "Not supported on this device",
    unknown: "Could not check",
  };
  return labels[permission] ?? "Not checked";
}

