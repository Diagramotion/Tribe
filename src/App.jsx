import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowCounterClockwise,
  ArrowSquareOut,
  Archive,
  BellSimple,
  CaretDown,
  CaretRight,
  ChartLine,
  ChatCircleDots,
  Check,
  ClockCounterClockwise,
  CircleNotch,
  Code,
  DownloadSimple,
  DotsThreeVertical,
  DotsSixVertical,
  DesktopTower,
  FileText,
  Flask,
  FolderSimple,
  Globe,
  Gear,
  GitDiff,
  GitBranch,
  ListChecks,
  MagnifyingGlass,
  Paperclip,
  PaperPlaneRight,
  Pause,
  Play,
  Plus,
  ShieldCheck,
  SquaresFour,
  SidebarSimple,
  Trash,
  UsersThree,
  WarningCircle,
  Wrench,
  X,
} from "@phosphor-icons/react";
import {
  initialAgents,
  tabs,
} from "./data/workspace.js";
import { runtime } from "./api/runtime.js";
import {
  desktopNotificationsEnabled as getDesktopNotificationsEnabled,
  enableDesktopNotifications,
  sendDesktopNotification,
  sendTestDesktopNotification,
} from "./api/desktop-notifications.js";
import { inlineImagePreview, playableMediaKind } from "./domain/artifact-preview.js";
import { scheduleRunNotifications } from "./domain/schedules.js";
import { chatTitleFromPrompt, compactChatTitle } from "./domain/chat-title.js";
import { captureSelectedWindow } from "./domain/computerCapture.js";
import {
  advanceMissionWorkflowContext,
  missionPhase,
  preserveMissionWorkflowContext,
} from "./domain/mission-phase.js";
import { projectSetupError } from "./domain/project-setup.js";
import { parseMissionPrompt } from "./domain/slash-commands.js";
import { modelDisplayName, sortModelCatalog } from "./domain/model-catalog.js";
import { IconButton, Sidebar } from "./components/WorkspaceSidebar.jsx";
import { SelectControl } from "./components/SelectControl.jsx";
import { AddRemoteServiceForm } from "./components/AddRemoteServiceForm.jsx";
import { useDialogFocus } from "./hooks/useDialogFocus.js";
import { ViewErrorBoundary } from "./components/ViewErrorBoundary.jsx";
import { AgentActivityView, ArtifactList, MissionView } from "./views/MissionView.jsx";
import { GeneralChatView } from "./views/GeneralChatView.jsx";
import {
  filterConversationMessages, filterTimelineMessages, formatTime, mapArtifact, mapInteraction, mapTestRun, mapTestRuns, mapWorkItem,
  mergeTimelineMessages, restoreAgentActivity, timelineEntries, timelineEntry, updateWorkItems,
} from "./domain/activity.js";

const providerNames = {
  openai: "OpenAI", anthropic: "Anthropic", google: "Google Gemini", groq: "Groq",
  mistral: "Mistral", deepseek: "DeepSeek", openrouter: "OpenRouter", xai: "xAI",
  cerebras: "Cerebras", cohere: "Cohere", fireworks: "Fireworks", together: "Together AI",
  ollama: "Ollama",
};
const agentColours = { planner: "violet", builder: "blue", reviewer: "teal" };
const CanvasView = lazy(() => import("./views/CanvasView.jsx").then((module) => ({ default: module.CanvasView })));
const ProjectCreateDialog = lazy(() => import("./components/ProjectCreateDialog.jsx").then((module) => ({ default: module.ProjectCreateDialog })));
const ProjectSettingsDialog = lazy(() => import("./components/ProjectSettingsDialog.jsx").then((module) => ({ default: module.ProjectSettingsDialog })));
const SettingsView = lazy(() => import("./views/SettingsView.jsx").then((module) => ({ default: module.SettingsView })));
const RunsView = lazy(() => import("./views/BackgroundWorkViews.jsx").then((module) => ({ default: module.RunsView })));
const SchedulesView = lazy(() => import("./views/BackgroundWorkViews.jsx").then((module) => ({ default: module.SchedulesView })));
const AgentRolesView = lazy(() => import("./views/TeamViews.jsx").then((module) => ({ default: module.AgentRolesView })));
const SkillsView = lazy(() => import("./views/TeamViews.jsx").then((module) => ({ default: module.SkillsView })));
const PlanView = lazy(() => import("./views/PlanView.jsx").then((module) => ({ default: module.PlanView })));
const ArtifactsView = lazy(() => import("./views/ArtifactsView.jsx").then((module) => ({ default: module.ArtifactsView })));
const RepositoryView = lazy(() => import("./views/RepositoryView.jsx").then((module) => ({ default: module.RepositoryView })));
const GitChangesView = lazy(() => import("./views/GitChangesView.jsx").then((module) => ({ default: module.GitChangesView })));
const ProjectHomeView = lazy(() => import("./views/ProjectHomeView.jsx").then((module) => ({ default: module.ProjectHomeView })));
const ProjectKnowledgeView = lazy(() => import("./views/ProjectKnowledgeView.jsx").then((module) => ({ default: module.ProjectKnowledgeView })));
const InteractiveAccessView = lazy(() => import("./views/InteractiveAccessView.jsx").then((module) => ({ default: module.InteractiveAccessView })));
const TestRunsView = lazy(() => import("./views/TestRunsView.jsx").then((module) => ({ default: module.TestRunsView })));
const WorkflowsView = lazy(() => import("./views/WorkflowsView.jsx").then((module) => ({ default: module.WorkflowsView })));
const BrowserView = lazy(() => import("./views/BrowserView.jsx").then((module) => ({ default: module.BrowserView })));
const secondaryPaneTools = [
  { id: "Browser", label: "Browser", icon: Globe },
  { id: "Activity", label: "Agent activity", icon: UsersThree },
  { id: "Plan", label: "Plan", icon: ListChecks },
  { id: "Tests", label: "Tests", icon: Flask },
  { id: "Runs", label: "Runs", icon: ClockCounterClockwise },
  { id: "Code", label: "Repository", icon: FolderSimple },
  { id: "Browser", label: "Browser", icon: Globe },
  { id: "Git", label: "Git changes", icon: GitBranch },
  { id: "Artifacts", label: "Artifacts", icon: SquaresFour },
  { id: "Preview", label: "Artifact preview", icon: FileText },
];
function MissionWorkflowProgress({ stages, currentStageId, currentTitle, title, state, completed }) {
  if (!Array.isArray(stages) || stages.length === 0) return null;
  const hasCompletionTracking = Array.isArray(state?.values?.completed_stage_ids);
  const completedStages = new Set(hasCompletionTracking ? state.values.completed_stage_ids : []);
  const completedCount = stages.filter((stage) => completedStages.has(stage.id)).length;
  const progressLabel = hasCompletionTracking
    ? `${completedCount} of ${stages.length} stages complete`
    : "Stage completion not recorded";
  const statusLabel = completed
    ? currentStageId ? `Chat complete · last stage: ${currentTitle}` : "Chat complete · no stage recorded"
    : currentTitle;
  return <section aria-label={`${title} workflow · ${completed ? "Chat complete" : currentTitle}`} className="mission-workflow-progress">
    <div className="mission-workflow-progress-heading">
      <span className="mission-workflow-name"><GitBranch size={14} />{title}</span>
      <strong aria-atomic="true" aria-live="polite">{statusLabel}</strong>
      <span className="mission-workflow-count">{progressLabel}</span>
    </div>
    <ol aria-label="Workflow stages">
      {stages.map((stage, index) => {
        const complete = completedStages.has(stage.id);
        const current = stage.id === currentStageId;
        return <li aria-current={current && !completed ? "step" : undefined} className={`${complete ? "mission-workflow-step--complete" : ""} ${current ? "mission-workflow-step--current" : ""}`.trim()} key={stage.id}>
          <span aria-hidden="true" className="mission-workflow-step-marker">{complete ? <Check size={11} weight="bold" /> : index + 1}</span>
          <span>{stage.title}</span>
        </li>;
      })}
    </ol>
  </section>;
}

function runtimeConnectionLabel(status) {
  if (status === "connected") return "Runtime connected";
  if (status === "offline") return "Runtime offline";
  return status === "connecting" ? "Connecting to runtime" : "Reconnecting to runtime";
}

function runtimeConnectionText(status) {
  if (status === "offline") return "Offline";
  if (status === "connecting") return "Connecting";
  if (status === "reconnecting") return "Reconnecting";
  return "";
}

function initialSecondaryPaneWidth() {
  if (typeof window === "undefined") return 480;
  try {
    const value = Number(window.localStorage.getItem("tribe.secondary-pane-width"));
    const sidebarWidth = Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width")) || 248;
    const availableWidth = Math.max(640, window.innerWidth - sidebarWidth);
    const maxWidth = maxSecondaryPaneWidth(availableWidth);
    if (Number.isFinite(value) && value >= 320) return value === 820 && maxWidth > 820 ? maxWidth : value;
    return maxWidth;
  } catch { return 480; }
}
function maxSecondaryPaneWidth(availableWidth) {
  return Math.max(320, availableWidth - 400);
}
function modelProvider(model) {
  return model.trim().toLowerCase().split(":", 1)[0];
}

const emptyUsage = { totals: { runs: 0, requests: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: null, priced_runs: 0, unpriced_runs: 0 }, byModel: [], byAgent: [], monthToDate: { period: null, completedRuns: 0, pricedRuns: 0, unpricedRuns: 0, estimatedCostUsd: null, tokens: 0 }, budget: { monthlyTokenLimit: null, maxRunCostUsd: null, maxRunTokens: null, usedTokens: 0, reservedTokens: 0, unknownTokens: 0, remainingTokens: null } };

function hasMcpServer(configText, serverName) {
  try {
    return Boolean(JSON.parse(configText)?.mcpServers?.[serverName]);
  } catch {
    return false;
  }
}

function mcpServerEntries(configText) {
  try {
    return Object.entries(JSON.parse(configText)?.mcpServers ?? {});
  } catch {
    return [];
  }
}

function Toast({ text, onDismiss }) {
  if (!text) return null;
  return <div className="toast" role="status"><Check size={16} />{text}<IconButton label="Dismiss" onClick={onDismiss}><X size={15} /></IconButton></div>;
}

function SecondaryPaneTabs({ selected, openTabs, onSelect, onClose, onNewBrowserTab, onReorder, browserTabs = [], badges = {}, tools = secondaryPaneTools }) {
  const selectedTabRef = useRef(null);
  const dragKeyRef = useRef(null);
  useLayoutEffect(() => {
    selectedTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected, openTabs]);

  function reorderFromKeyboard(event, key) {
    if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    onReorder(key, event.key === "ArrowLeft" ? -1 : 1);
  }

  return <div className="secondary-pane-tabs-layout">
  <nav aria-label="Workspace pages" className="secondary-pane-tabs" role="tablist">
    {openTabs.map((tab) => {
      const isBrowser = tab.kind === "browser";
      const browserTab = isBrowser ? browserTabs.find((item) => item.id === tab.id) : null;
      const tool = isBrowser ? null : tools.find((item) => item.id === tab.id);
      if (isBrowser && !browserTab || !isBrowser && !tool) return null;
      const label = isBrowser ? (browserTab.title || "New tab") : tool.label;
      const Icon = isBrowser ? Globe : tool.icon;
      const isSelected = selected === tab.key;
      return <div className={`secondary-pane-tab-item${isBrowser ? " secondary-pane-tab-item--browser" : ""}${isSelected ? " secondary-pane-tab-item--selected" : ""}`} key={tab.key} ref={isSelected ? selectedTabRef : null} draggable onDragStart={(event) => { dragKeyRef.current = tab.key; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", tab.key); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const from = dragKeyRef.current || event.dataTransfer.getData("text/plain"); if (from) onReorder(from, tab.key); dragKeyRef.current = null; }} onDragEnd={() => { dragKeyRef.current = null; }}>
        <button aria-label={label} aria-selected={isSelected} className={`icon-button secondary-pane-tab ${isSelected ? "secondary-pane-tab--selected" : ""}`} onClick={() => onSelect(tab)} onKeyDown={(event) => reorderFromKeyboard(event, tab.key)} role="tab" title={`${label} · Drag to reorder; Alt+Left/Right to move`} type="button">
          {isBrowser && browserTab.favicon ? <img alt="" className="secondary-pane-tab-favicon" src={browserTab.favicon} /> : <Icon size={17} weight={isSelected && !isBrowser ? "fill" : "regular"} />}
          <span>{label}</span>
          {!isBrowser && badges[tab.id] > 0 && <span aria-label={`${badges[tab.id]} ${label.toLowerCase()}`} className="secondary-tool-badge">{badges[tab.id] > 99 ? "99+" : badges[tab.id]}</span>}
        </button>
        <IconButton className="secondary-pane-tab-close" label={`Close ${label}`} onClick={() => onClose(tab)}><X size={13} /></IconButton>
      </div>;
    })}
  </nav>
    <IconButton className="secondary-pane-new-browser-tab" label="New browser tab" onClick={onNewBrowserTab}><Plus size={16} /></IconButton>
  </div>;
}

function ConfirmationDialog({ confirmation, onCancel, onConfirm }) {
  const dialogRef = useRef(null);
  const destructive = confirmation.tone === "danger";
  useDialogFocus(dialogRef);

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }

  return <div className="dialog-backdrop confirmation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }} role="presentation">
    <section aria-describedby={`confirmation-message${confirmation.detail ? " confirmation-detail" : ""}`} aria-labelledby="confirmation-title" aria-modal="true" className={`mission-dialog confirmation-dialog ${destructive ? "confirmation-dialog--danger" : ""}`} onKeyDown={handleKeyDown} ref={dialogRef} role={destructive ? "alertdialog" : "dialog"} tabIndex={-1}>
      <div className="confirmation-heading">
        {destructive && <span aria-hidden="true" className="confirmation-icon"><WarningCircle size={18} /></span>}
        <div><span className="eyebrow">{confirmation.eyebrow ?? "Confirm action"}</span><h2 id="confirmation-title">{confirmation.title}</h2></div>
      </div>
      <p className="confirmation-copy" id="confirmation-message">{confirmation.message}</p>
      {confirmation.detail && <p className="confirmation-detail" id="confirmation-detail">{confirmation.detail}</p>}
      <div className="dialog-actions"><button className="button button--quiet" onClick={onCancel} type="button">Cancel</button><button className={`button ${destructive ? "button--danger" : "button--primary"}`} onClick={onConfirm} type="button">{confirmation.confirmLabel ?? "Confirm"}</button></div>
    </section>
  </div>;
}

function mcpSecretNames(raw) {
  try {
    const config = JSON.parse(raw);
    const references = new Set();
    Object.values(config.mcpServers ?? {}).forEach((server) => {
      ["env", "headers"].forEach((field) => {
        Object.values(server?.[field] ?? {}).forEach((value) => {
          const match = typeof value === "string" ? value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/) : null;
          if (match) references.add(match[1]);
        });
      });
    });
    return [...references].sort();
  } catch {
    return [];
  }
}

function parseReferenceFiles(raw) {
  return [...new Set(raw.split(/[\n,]/).map((path) => path.trim()).filter(Boolean))];
}

function addReferenceFile(current, path) {
  return [...new Set([...parseReferenceFiles(current), path])].join("\n");
}

export function App() {
  const [activeTab, setActiveTab] = useState("Mission");
  const [collapsed, setCollapsed] = useState(false);
  const [messages, setMessages] = useState([]);
  const [hasOlderEvents, setHasOlderEvents] = useState(false);
  const [loadingOlderEvents, setLoadingOlderEvents] = useState(false);
  const [agents, setAgents] = useState([]);
  const [capabilityCatalog, setCapabilityCatalog] = useState([]);
  const [agentDirectory, setAgentDirectory] = useState("");
  const [artifacts, setArtifacts] = useState([]);
  const [projectArtifacts, setProjectArtifacts] = useState([]);
  const [artifactSearch, setArtifactSearch] = useState("");
  const [artifactCursor, setArtifactCursor] = useState(null);
  const [artifactTotal, setArtifactTotal] = useState(0);
  const [artifactHasMore, setArtifactHasMore] = useState(false);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactLoadingMore, setArtifactLoadingMore] = useState(false);
  const [artifactError, setArtifactError] = useState("");
  const [artifactRefreshNonce, setArtifactRefreshNonce] = useState(0);
  const [artifactReviewRevision, setArtifactReviewRevision] = useState(0);
  const [canvasRefreshNonce, setCanvasRefreshNonce] = useState(0);
  const [canvasDocuments, setCanvasDocuments] = useState([]);
  const [missionCanvasDocuments, setMissionCanvasDocuments] = useState([]);
  const [linkingCanvasDocumentId, setLinkingCanvasDocumentId] = useState(null);
  const [skills, setSkills] = useState([]);
  const [knowledge, setKnowledge] = useState([]);
  const [knowledgeProposals, setKnowledgeProposals] = useState([]);
  const [knowledgeMigration, setKnowledgeMigration] = useState({ missing: [], conflicts: [], reviewed: [] });
  const [interactions, setInteractions] = useState([]);
  const [globalInteractions, setGlobalInteractions] = useState([]);
  const [computerRequests, setComputerRequests] = useState([]);
  const [activeComputerRequest, setActiveComputerRequest] = useState(null);
  const [pendingComputerObservation, setPendingComputerObservation] = useState(null);
  const [computerCaptureBusy, setComputerCaptureBusy] = useState(false);
  const [computerCaptureAction, setComputerCaptureAction] = useState("");
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [chatViewsOpen, setChatViewsOpen] = useState(false);
  const [workItemsState, setWorkItems] = useState([]);
  const [isolatedWorkspaces, setIsolatedWorkspaces] = useState([]);
  const [selectedArtifact, setSelectedArtifact] = useState(null);
  const [projectPaneTab, setProjectPaneTab] = useState("");
  const [openProjectPaneTabs, setOpenProjectPaneTabs] = useState([]);
  const [browserWorkspaceState, setBrowserWorkspaceState] = useState({ tabs: [], activeTabId: null });
  const browserWorkspaceStateRef = useRef(browserWorkspaceState);
  const browserWorkspaceOpenPromiseRef = useRef(null);
  const selectedWorkspaceTab = openProjectPaneTabs.find((tab) => tab.key === projectPaneTab) ?? null;
  const selectedWorkspaceView = selectedWorkspaceTab?.kind === "view" ? selectedWorkspaceTab.id : selectedWorkspaceTab?.kind === "browser" ? "Browser" : "";
  const [projectGitEnabled, setProjectGitEnabled] = useState(false);
  const [projectGitChangeCount, setProjectGitChangeCount] = useState(0);
  const [projectPaneOpen, setProjectPaneOpen] = useState(false);
  const [secondaryPaneWidth, setSecondaryPaneWidth] = useState(initialSecondaryPaneWidth);
  const [workspacePaneAvailableWidth, setWorkspacePaneAvailableWidth] = useState(0);
  const [paneResizing, setPaneResizing] = useState(false);
  const projectPaneTools = projectGitEnabled ? secondaryPaneTools : secondaryPaneTools.filter((tool) => tool.id !== "Git");
  const chatViewMenuTools = projectPaneTools.filter((tool) => tool.id !== "Preview");
  const paneResizeRef = useRef(null);
  const workspacePaneRef = useRef(null);
  useLayoutEffect(() => {
    if (!projectPaneOpen || !workspacePaneRef.current) return undefined;
    const element = workspacePaneRef.current;
    const measure = () => setWorkspacePaneAvailableWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [projectPaneOpen]);
  const maxWorkspacePaneWidth = workspacePaneAvailableWidth > 0
    ? maxSecondaryPaneWidth(workspacePaneAvailableWidth)
    : 820;
  const visibleWorkspacePaneWidth = Math.min(secondaryPaneWidth, maxWorkspacePaneWidth);
  useEffect(() => {
    if (!projectPaneOpen || workspacePaneAvailableWidth <= 0) return;
    const previousWorkspaceMaximum = maxSecondaryPaneWidth(workspacePaneAvailableWidth);
    const previousCollapsedSidebarMaximum = maxSecondaryPaneWidth(window.innerWidth - 48);
    if (Math.abs(secondaryPaneWidth - previousWorkspaceMaximum) <= 4
        || Math.abs(secondaryPaneWidth - previousCollapsedSidebarMaximum) <= 4) {
      setSecondaryPaneWidth(maxSecondaryPaneWidth(workspacePaneAvailableWidth));
    }
  }, [projectPaneOpen, secondaryPaneWidth, workspacePaneAvailableWidth]);
  useEffect(() => {
    try { window.localStorage.setItem("tribe.secondary-pane-width", String(Math.round(secondaryPaneWidth))); } catch { /* Layout preferences are optional. */ }
  }, [secondaryPaneWidth]);

  function chooseSecondaryPane(tab) {
    if (tab === "Browser") {
      const currentBrowserState = browserWorkspaceStateRef.current;
      const browserTab = currentBrowserState.tabs.find((item) => item.id === currentBrowserState.activeTabId) ?? currentBrowserState.tabs[0];
      if (browserTab) selectBrowserWorkspaceTab(browserTab.id);
      else void openBrowserWorkspace();
      return;
    }
    if (tab === "Code") {
      setSelectedArtifact(null);
      setSelectedCanvasDocument(null);
    }
    const key = `view:${tab}`;
    setOpenProjectPaneTabs((current) => current.some((item) => item.key === key) ? current : [...current, { key, kind: "view", id: tab }]);
    setProjectPaneTab(key);
    setProjectPaneOpen(true);
  }

  const handleBrowserWorkspaceState = useCallback((next) => {
    browserWorkspaceStateRef.current = next;
    setBrowserWorkspaceState(next);
    setOpenProjectPaneTabs((current) => {
      const presentIds = new Set((next.tabs ?? []).map((item) => item.id));
      const retained = current.filter((item) => item.kind !== "browser" || presentIds.has(item.id));
      const known = new Set(retained.filter((item) => item.kind === "browser").map((item) => item.id));
      for (const browserTab of next.tabs ?? []) {
        if (!known.has(browserTab.id)) retained.push({ key: `browser:${browserTab.id}`, kind: "browser", id: browserTab.id });
      }
      return retained;
    });
    setProjectPaneTab((current) => current.startsWith("browser:") && next.activeTabId ? `browser:${next.activeTabId}` : current);
    if ((next.tabs ?? []).length === 0) {
      setProjectPaneTab((current) => current.startsWith("browser:") ? "" : current);
    }
  }, []);

  async function openBrowserWorkspace() {
    const bridge = window.tribeDesktopBrowser;
    if (!bridge) return;
    if (browserWorkspaceOpenPromiseRef.current) return browserWorkspaceOpenPromiseRef.current;
    const opening = bridge.open("workspace").then((next) => {
      handleBrowserWorkspaceState(next);
      const activeId = next.activeTabId ?? next.tabs?.find((tab) => tab.active)?.id;
      if (activeId) setProjectPaneTab(`browser:${activeId}`);
      setProjectPaneOpen(true);
      return next;
    }).catch((error) => {
      notify(`The browser workspace could not be opened: ${error.message}`);
      return null;
    }).finally(() => {
      if (browserWorkspaceOpenPromiseRef.current === opening) browserWorkspaceOpenPromiseRef.current = null;
    });
    browserWorkspaceOpenPromiseRef.current = opening;
    return opening;
  }

  async function createBrowserWorkspaceTab() {
    const bridge = window.tribeDesktopBrowser;
    if (!bridge) return;
    try {
      const next = await bridge.newTab("workspace");
      handleBrowserWorkspaceState(next);
      const activeId = next.activeTabId ?? next.tabs?.find((tab) => tab.active)?.id;
      if (activeId) setProjectPaneTab(`browser:${activeId}`);
      setProjectPaneOpen(true);
    } catch (error) { notify(`A browser tab could not be opened: ${error.message}`); }
  }

  async function selectBrowserWorkspaceTab(tabId) {
    const bridge = window.tribeDesktopBrowser;
    setProjectPaneTab(`browser:${tabId}`);
    setProjectPaneOpen(true);
    if (!bridge) return;
    try { handleBrowserWorkspaceState(await bridge.selectTab("workspace", tabId)); }
    catch (error) { notify(`The browser tab could not be selected: ${error.message}`); }
  }

  function selectSecondaryPaneTab(tab) {
    if (tab.kind === "browser") return void selectBrowserWorkspaceTab(tab.id);
    setProjectPaneTab(tab.key);
    setProjectPaneOpen(true);
  }

  function closeSecondaryPaneTab(tab) {
    const index = openProjectPaneTabs.findIndex((item) => item.key === tab.key);
    if (tab.kind === "browser") {
      const wasSelected = projectPaneTab === tab.key;
      void (async () => {
        const next = await window.tribeDesktopBrowser?.closeTab("workspace", tab.id);
        if (!next) return;
        handleBrowserWorkspaceState(next);
        if (wasSelected && next.tabs.length === 0) {
          const remaining = openProjectPaneTabs.filter((item) => item.key !== tab.key);
          const fallback = remaining[Math.min(index, remaining.length - 1)] ?? null;
          if (fallback) selectSecondaryPaneTab(fallback);
          else setProjectPaneOpen(false);
        }
      })();
      return;
    }
    const nextTabs = openProjectPaneTabs.filter((item) => item.key !== tab.key);
    setOpenProjectPaneTabs(nextTabs);
    if (tab.id === "Preview") {
      setSelectedArtifact(null);
      setSelectedCanvasDocument(null);
    }
    if (projectPaneTab === tab.key) {
      const nextTab = nextTabs[Math.min(index, nextTabs.length - 1)] ?? null;
      if (nextTab) selectSecondaryPaneTab(nextTab);
      else { setProjectPaneTab(""); setProjectPaneOpen(false); }
    }
  }

  function reorderWorkspaceTabs(from, toOrDelta) {
    setOpenProjectPaneTabs((current) => {
      const fromIndex = current.findIndex((item) => item.key === from);
      if (fromIndex < 0) return current;
      const toIndex = typeof toOrDelta === "number"
        ? Math.max(0, Math.min(current.length - 1, fromIndex + toOrDelta))
        : current.findIndex((item) => item.key === toOrDelta);
      if (toIndex < 0 || toIndex === fromIndex) return current;
      const next = [...current];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      return next;
    });
  }

  function openMissionWorkspaceTool(tab) {
    chooseSecondaryPane(tab);
    setChatViewsOpen(false);
  }

  function openAgentActivity() {
    openMissionWorkspaceTool("Activity");
  }

  useEffect(() => {
    if (!chatViewsOpen) return undefined;
    const dismiss = (event) => {
      if (event.type === "pointerdown" && event.target.closest?.(".chat-views-menu-wrap")) return;
      setChatViewsOpen(false);
    };
    const dismissOnEscape = (event) => { if (event.key === "Escape") setChatViewsOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [chatViewsOpen]);

  function startSecondaryPaneResize(event) {
    if (event.button !== 0) return;
    const container = event.currentTarget.closest(".workspace-body--split");
    if (!container) return;
    event.preventDefault();
    paneResizeRef.current = container;
    setPaneResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveSecondaryPaneResize(event) {
    const container = paneResizeRef.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const maximum = maxSecondaryPaneWidth(bounds.width);
    const nextWidth = Math.max(320, Math.min(maximum, bounds.right - event.clientX));
    setSecondaryPaneWidth(Math.round(nextWidth));
  }

  function stopSecondaryPaneResize() { paneResizeRef.current = null; setPaneResizing(false); }

  function nudgeSecondaryPaneWidth(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const container = event.currentTarget.closest(".workspace-body--split");
    const availableWidth = container?.clientWidth ?? 1448;
    const maximum = maxSecondaryPaneWidth(availableWidth);
    setSecondaryPaneWidth((width) => {
      const currentWidth = Math.min(width, maximum);
      if (event.key === "Home") return 320;
      if (event.key === "End") return maximum;
      return Math.max(320, Math.min(maximum, currentWidth + (event.key === "ArrowRight" ? 24 : -24)));
    });
  }
  const [selectedCanvasDocument, setSelectedCanvasDocument] = useState(null);
  const [canvasDiscussionSplit, setCanvasDiscussionSplit] = useState(false);
  const [composerDraft, setComposerDraft] = useState(null);
  const [mission, setMissionState] = useState(null);
  const [showNewChat, setShowNewChat] = useState(false);
  const [generalChats, setGeneralChats] = useState([]);
  const [selectedGeneralChat, setSelectedGeneralChat] = useState(null);
  const setMission = useCallback((update) => setMissionState((current) => {
    const next = typeof update === "function" ? update(current) : update;
    return preserveMissionWorkflowContext(current, next);
  }), []);
  const [missions, setMissions] = useState([]);
  const [projects, setProjects] = useState([]);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const projectCreateReturnFocusRef = useRef(null);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const projectSettingsReturnFocusRef = useRef(null);
  const [projectSettingsSection, setProjectSettingsSection] = useState("team");
  const [projectGoalInput, setProjectGoalInput] = useState("");
  const [projectGoalReferenceFilesInput, setProjectGoalReferenceFilesInput] = useState("");
  const [projectGoalError, setProjectGoalError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [workspaceSettingsSection, setWorkspaceSettingsSection] = useState("workspace");
  const [workspaceSettingsModelId, setWorkspaceSettingsModelId] = useState(null);
  const [settingsMode, setSettingsMode] = useState("model");
  const [modelInput, setModelInput] = useState("");
  const [modelBaseUrlInput, setModelBaseUrlInput] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const [providerModels, setProviderModels] = useState(null);
  const [providerModelsDiscovering, setProviderModelsDiscovering] = useState(false);
  const [mcpConfigInput, setMcpConfigInput] = useState('{\n  "mcpServers": {}\n}');
  const [mcpSavedConfig, setMcpSavedConfig] = useState('{\n  "mcpServers": {}\n}');
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpChecks, setMcpChecks] = useState({});
  const [mcpBrowserInstall, setMcpBrowserInstall] = useState({});
  const [mcpOAuthStatuses, setMcpOAuthStatuses] = useState({});
  const [mcpSecretValues, setMcpSecretValues] = useState({});
  const [mcpSecretStatus, setMcpSecretStatus] = useState({});
  const [project, setProject] = useState({ id: undefined, name: "" });
  useEffect(() => {
    let active = true;
    setProjectGitEnabled(false);
    setProjectGitChangeCount(0);
    if (!project.id) return () => { active = false; };
    const refreshGitStatus = () => runtime.getProjectGitStatus(project.id).then((status) => {
      if (!active) return;
      const enabled = Boolean(status.isGit);
      setProjectGitEnabled(enabled);
      setProjectGitChangeCount(enabled ? (status.files?.length ?? 0) : 0);
    }).catch(() => {
      if (!active) return;
      setProjectGitEnabled(false);
      setProjectGitChangeCount(0);
    });
    void refreshGitStatus();
    const timer = window.setInterval(refreshGitStatus, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [project.id]);
  useEffect(() => {
    if (projectGitEnabled || !openProjectPaneTabs.some((tab) => tab.kind === "view" && tab.id === "Git")) return;
    const nextTabs = openProjectPaneTabs.filter((tab) => !(tab.kind === "view" && tab.id === "Git"));
    setOpenProjectPaneTabs(nextTabs);
    if (selectedWorkspaceView === "Git") {
      const nextTab = nextTabs.at(-1) ?? null;
      if (nextTab) selectSecondaryPaneTab(nextTab);
      else { setProjectPaneTab(""); setProjectPaneOpen(false); }
    }
  }, [projectGitEnabled, projectPaneTab, selectedWorkspaceView, openProjectPaneTabs]);
  const [runtimeStatus, setRuntimeStatus] = useState("connecting");
  const [agentRuntime, setAgentRuntime] = useState({ enabled: false });
  const [toast, setToast] = useState("");
  const [activeWork, setActiveWork] = useState(null);
  const [runs, setRuns] = useState([]);
  const [commandRuns, setCommandRuns] = useState([]);
  const [agentRequests, setAgentRequests] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [workspaceSchedules, setWorkspaceSchedules] = useState([]);
  const [desktopNotificationsOn, setDesktopNotificationsOn] = useState(false);
  const [webAccess, setWebAccess] = useState({ enabled: false, allowedDomains: [] });
  const [interactiveAccess, setInteractiveAccess] = useState({ enabled: false });
  const [computerAccess, setComputerAccess] = useState({ enabled: false });
  const [recipes, setRecipes] = useState([]);
  const [usage, setUsage] = useState(emptyUsage);
  const [query, setQuery] = useState("");
  const [headerSearchOpen, setHeaderSearchOpen] = useState(false);
  const [missionControlPending, setMissionControlPending] = useState(false);
  const fileInputRef = useRef(null);
  const headerSearchInputRef = useRef(null);
  const pendingAttachmentCallbackRef = useRef(null);
  const cursorRef = useRef(0);
  const toastTimeoutRef = useRef(null);
  const oldestEventSequenceRef = useRef(null);
  const loadedMissionIdRef = useRef(null);
  const missionPausedRef = useRef(false);
  const missionCompletedRef = useRef(false);
  const agentDefinitionsRef = useRef(initialAgents);
  const pendingInteractionAgentsRef = useRef(new Map());
  const scheduleRunStatusesRef = useRef(null);
  const confirmationResolverRef = useRef(null);
  const confirmationFocusRef = useRef(null);
  useLayoutEffect(() => {
    if (headerSearchOpen) headerSearchInputRef.current?.focus();
  }, [headerSearchOpen]);
  const preferredInteractionRef = useRef(null);
  const artifactQueryVersionRef = useRef(0);
  const computerRequestDialogRef = useRef(null);
  const computerPreviewDialogRef = useRef(null);
  const agentSettingsDialogRef = useRef(null);
  useDialogFocus(computerRequestDialogRef, Boolean(activeComputerRequest));
  useDialogFocus(computerPreviewDialogRef, Boolean(pendingComputerObservation));
  useDialogFocus(agentSettingsDialogRef, settingsOpen);
  const activeInteraction = interactions[0] ?? null;
  const queuedInteractions = interactions.slice(1);

  function requestConfirmation(request) {
    if (confirmationResolverRef.current) confirmationResolverRef.current(false);
    confirmationFocusRef.current = document.activeElement;
    return new Promise((resolve) => {
      confirmationResolverRef.current = resolve;
      setConfirmation(request);
    });
  }

  function finishConfirmation(accepted) {
    const resolve = confirmationResolverRef.current;
    confirmationResolverRef.current = null;
    const previousFocus = confirmationFocusRef.current;
    confirmationFocusRef.current = null;
    setConfirmation(null);
    resolve?.(accepted);
    window.requestAnimationFrame(() => {
      if (previousFocus?.isConnected) previousFocus.focus();
    });
  }
  const isMissionTab = tabs.includes(activeTab);
  const splitBrowserTitlebarActive = Boolean(projectPaneOpen && mission && isMissionTab && selectedWorkspaceTab?.kind === "browser");
  const browserTitlebarActive = activeTab === "Browser" || splitBrowserTitlebarActive;
  const isGlobalWorkspaceTab = ["Browser", "WorkspaceSchedules", "Skills", "Recipes", "Settings"].includes(activeTab);
  const isProjectWorkspace = Boolean(project.id)
    && ["Code", "Git", "Artifacts", "Schedules", "Skills", "Agents", "Knowledge", "Recipes"].includes(activeTab);
  const unavailableAgentStatuses = new Set(["Not configured", "Provider setup failed"]);
  const projectAgents = Array.isArray(project.agentIds)
    ? agents.filter((agent) => project.agentIds.includes(agent.id))
    : agents;
  const readyAgentCount = projectAgents.filter((agent) => !unavailableAgentStatuses.has(agent.status)).length;
  const noAgentsReady = projectAgents.length > 0 && readyAgentCount === 0;
  const requiresProject = !selectedGeneralChat && (isMissionTab || ["Code", "Git", "Artifacts", "Schedules", "Knowledge"].includes(activeTab));
  const activeWorkspaceLabel = ({
    Browser: "Browser",
    Code: "Repository",
    Git: "Git changes",
    Artifacts: "Artifacts",
    Schedules: "Schedules",
    WorkspaceSchedules: "Scheduled tasks",
    Knowledge: "Project memory",
    Skills: "Skills",
    Recipes: "Workflows",
    Agents: "Agent roles",
    Settings: "Settings",
  })[activeTab] ?? activeTab;

  useEffect(() => {
    if (activeTab !== "Recipes" && !mission?.recipe_id && mission) return;
    let current = true;
    runtime.listRecipes().then((result) => { if (current) setRecipes(result.recipes); })
      .catch((error) => { if (current) notify(`Workflows could not be loaded: ${error.message}`); });
    return () => { current = false; };
  }, [activeTab, mission?.id, mission?.recipe_id]);

  useEffect(() => {
    if (!project.id) {
      setWebAccess({ enabled: false, allowedDomains: [] });
      setInteractiveAccess({ enabled: false });
      setComputerAccess({ enabled: false });
      return undefined;
    }
    let current = true;
    runtime.getWebAccess(project.id).then((result) => {
      if (current) setWebAccess(result.webAccess);
    }).catch((error) => {
      if (current) notify(`Web research policy could not be loaded: ${error.message}`);
    });
    return () => { current = false; };
  }, [project.id]);
  useEffect(() => {
    if (!project.id) return undefined;
    let current = true;
    runtime.getInteractiveAccess(project.id).then((result) => {
      if (current) setInteractiveAccess(result.interactiveAccess);
    }).catch((error) => {
      if (current) notify(`Interactive app settings could not be loaded: ${error.message}`);
    });
    return () => { current = false; };
  }, [project.id]);
  useEffect(() => {
    if (!project.id) return undefined;
    let current = true;
    setComputerAccess({ enabled: false });
    runtime.getComputerAccess(project.id).then((result) => {
      if (current) setComputerAccess(result.computerAccess);
    }).catch((error) => {
      if (current) notify(`Computer access could not be loaded: ${error.message}`);
    });
    return () => { current = false; };
  }, [project.id]);
  const workflowPhase = useMemo(
    () => missionPhase(mission, workItemsState, mission?.workflow_context),
    [mission, workItemsState],
  );
  const workflowSnapshot = useMemo(() => {
    try {
      const snapshot = typeof mission?.recipe_snapshot === "string"
        ? JSON.parse(mission.recipe_snapshot) : mission?.recipe_snapshot;
      return snapshot?.id ? snapshot : recipes.find((recipe) => recipe.id === mission?.recipe_id) ?? null;
    } catch {
      return recipes.find((recipe) => recipe.id === mission?.recipe_id) ?? null;
    }
  }, [mission?.recipe_id, mission?.recipe_snapshot, recipes]);
  async function refreshPendingRequests() {
    const [interactionsResult, observationsResult] = await Promise.allSettled([
      runtime.listPendingInteractions(), runtime.listComputerRequests(),
    ]);
    if (interactionsResult.status === "fulfilled") {
      setGlobalInteractions(interactionsResult.value.interactions.map(mapInteraction));
    }
    if (observationsResult.status === "fulfilled") {
      setComputerRequests(observationsResult.value.requests);
    }
  }

  async function startComputerObservation(request) {
    if (computerCaptureBusy || pendingComputerObservation) return;
    setComputerCaptureBusy(true);
    setComputerCaptureAction("capturing");
    let capturePromise;
    try {
      // Start the OS picker directly from the user's click so WebView gesture gating is preserved.
      capturePromise = captureSelectedWindow();
      const { request: claimed } = await runtime.claimComputerRequest(request.id, request.completionToken);
      const observation = await capturePromise;
      setComputerRequests((current) => current.filter((item) => item.id !== request.id));
      setActiveComputerRequest(null);
      setPendingComputerObservation({ request, observation, completionToken: claimed.completionToken });
    } catch (error) {
      void capturePromise?.catch(() => {});
      await runtime.cancelComputerRequest(request.id, request.completionToken).catch(() => {});
      setComputerRequests((current) => current.filter((item) => item.id !== request.id));
      setActiveComputerRequest(null);
      notify(error.message || "Window observation was cancelled.");
    } finally {
      setComputerCaptureBusy(false);
      setComputerCaptureAction("");
      void refreshPendingRequests();
    }
  }

  async function shareComputerObservation() {
    const pending = pendingComputerObservation;
    if (!pending || computerCaptureBusy) return;
    setComputerCaptureBusy(true);
    setComputerCaptureAction("sharing");
    try {
      await runtime.completeComputerRequest(pending.request.id, {
        ...pending.observation,
        completionToken: pending.completionToken,
      });
      notify(`Window shared with ${pending.request.agentName} for this request`);
    } catch (error) {
      await runtime.cancelComputerRequest(pending.request.id, pending.completionToken).catch(() => {});
      notify(error.message || "The window request expired before it could be shared.");
    } finally {
      setPendingComputerObservation(null);
      setComputerCaptureBusy(false);
      setComputerCaptureAction("");
      void refreshPendingRequests();
    }
  }

  async function saveComputerObservationAsArtifact() {
    const pending = pendingComputerObservation;
    if (!pending || pending.artifactId || computerCaptureBusy) return;
    setComputerCaptureBusy(true);
    setComputerCaptureAction("saving");
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const { artifact, event: createdEvent } = await runtime.uploadArtifact(
        pending.request.missionId,
        `Window observation ${timestamp}.png`,
        "image/png",
        pending.observation.imageBase64,
      );
      const mapped = mapArtifact(artifact);
      setArtifacts((current) => current.some((item) => item.id === mapped.id) ? current : [mapped, ...current]);
      applyEvent(createdEvent);
      setPendingComputerObservation((current) => current ? { ...current, artifactId: mapped.id } : current);
      notify("Screenshot saved to artifacts. You can still decide whether to share it with the agent.");
    } catch (error) {
      notify(`Screenshot was not saved: ${error.message}`);
    } finally {
      setComputerCaptureBusy(false);
      setComputerCaptureAction("");
    }
  }

  async function discardComputerObservation() {
    const pending = pendingComputerObservation;
    if (!pending || computerCaptureBusy) return;
    setComputerCaptureBusy(true);
    setComputerCaptureAction("discarding");
    try {
      await runtime.cancelComputerRequest(pending.request.id, pending.completionToken);
      notify("Screenshot discarded; nothing was shared with the agent");
    } catch (error) {
      notify(error.message || "The window request has expired.");
    } finally {
      setPendingComputerObservation(null);
      setComputerCaptureBusy(false);
      setComputerCaptureAction("");
      void refreshPendingRequests();
    }
  }

  async function cancelComputerObservation(request) {
    try {
      await runtime.cancelComputerRequest(request.id, request.completionToken);
    } catch { /* Expired requests have already woken the waiting agent. */ }
    setComputerRequests((current) => current.filter((item) => item.id !== request.id));
    setActiveComputerRequest(null);
    notify("Window observation cancelled");
  }

  useEffect(() => {
    refreshPendingRequests();
    const timer = window.setInterval(refreshPendingRequests, 2500);
    return () => window.clearInterval(timer);
  }, []);

  function applyEvent(event) {
    cursorRef.current = Math.max(cursorRef.current, event.sequence ?? 0);
    if (event.type === "mission.workflow.selected") {
      const workflow = event.payload?.workflow;
      if (workflow?.id) {
        const workflowMission = {
          recipe_id: workflow.id, recipe_version: workflow.version,
          recipe_snapshot: JSON.stringify(workflow), workflow_context: null,
        };
        setMission((current) => current?.id === event.missionId ? { ...current, ...workflowMission } : current);
        setMissions((current) => current.map((item) => item.id === event.missionId
          ? { ...item, ...workflowMission } : item));
      }
    }
    setMission((current) => current?.id === event.missionId && current.recipe_id
      ? { ...current, workflow_context: advanceMissionWorkflowContext(current.workflow_context, event) }
      : current);
    const message = timelineEntry(event, agentDefinitionsRef.current);
    if (message) setMessages((current) => mergeTimelineMessages(current, [message]));
    if (event.type === "agent.provider.failed" || event.type === "agent.provider.ready") {
      const failed = event.type === "agent.provider.failed";
      setAgents((current) => current.map((agent) => agent.id === event.payload.agentId
        ? { ...agent, status: failed ? "Provider setup failed" : "Ready",
          next: failed ? event.payload.error : `Using ${event.payload.model}` }
        : agent));
    }
    if (event.type === "mission.paused" || event.type === "mission.resumed") {
      const paused = event.type === "mission.paused";
      const resumedBackground = !paused && event.payload?.background === true;
      missionPausedRef.current = paused;
      missionCompletedRef.current = false;
      setMission((current) => current?.id === event.missionId ? { ...current, status: paused ? "paused" : "active" } : current);
      setMissions((current) => current.map((item) => item.id === event.missionId
        ? { ...item, status: paused ? "paused" : "active" }
        : paused || item.background || resumedBackground ? item : { ...item, status: "paused" }));
      if (paused) setAgents((current) => current.map((agent) => ({
        ...agent,
        status: pendingInteractionAgentsRef.current.has(agent.id)
          ? "Waiting for you"
          : ["Working", "Pausing"].includes(agent.status) ? "Pausing" : "Paused",
        next: pendingInteractionAgentsRef.current.has(agent.id) ? "Waiting for your response" : "Chat paused by you",
      })));
      else setAgents((current) => current.map((agent) => ({
        ...agent,
        status: pendingInteractionAgentsRef.current.has(agent.id) ? "Waiting for you" : "Ready",
        next: pendingInteractionAgentsRef.current.has(agent.id) ? "Waiting for your response" : "Ready for the next task",
      })));
    }
    if (event.type === "mission.completed") {
      missionCompletedRef.current = true;
      setMission((current) => current?.id === event.missionId ? { ...current, status: "completed" } : current);
      setMissions((current) => current.map((item) => item.id === event.missionId ? { ...item, status: "completed" } : item));
      setAgents((current) => current.map((agent) => ({ ...agent, status: "Complete", next: "Chat completed" })));
    }
    if (event.type === "mission.blocked") {
      setMission((current) => current?.id === event.missionId
        ? { ...current, blocked_reason: event.payload.reason, blocked_at: event.createdAt }
        : current);
      setMissions((current) => current.map((item) => item.id === event.missionId
        ? { ...item, blocked_reason: event.payload.reason, blocked_at: event.createdAt }
        : item));
    }
    if (event.type === "mission.unblocked") {
      setMission((current) => current?.id === event.missionId
        ? { ...current, blocked_reason: null, blocked_at: null }
        : current);
      setMissions((current) => current.map((item) => item.id === event.missionId
        ? { ...item, blocked_reason: null, blocked_at: null }
        : item));
    }
    if (event.type === "plan.item.created" || event.type === "plan.item.claimed" || event.type === "plan.item.updated") {
      const item = mapWorkItem(event.payload.workItem);
      if (event.type === "plan.item.claimed") {
        setAgents((current) => current.map((agent) => agent.id === event.actorId
          ? { ...agent, status: missionPausedRef.current ? "Pausing" : "Working", activity: item.title,
            next: missionPausedRef.current ? "Finishing the current action before pausing" : "Working on this plan item" }
          : agent));
      }
      setWorkItems((current) => updateWorkItems(current, item));
    }
    if (event.type === "plan.item.completed") {
      const item = mapWorkItem(event.payload.workItem);
      setWorkItems((current) => updateWorkItems(current, item));
      setAgents((current) => current.map((agent) => agent.id === event.actorId
        ? { ...agent, activity: agent.role, status: missionPausedRef.current ? "Paused" : "Ready",
          next: missionPausedRef.current ? "Chat paused by you" : "Ready for the next task" }
        : agent));
    }
    if (event.type === "agent.activity") {
      if (missionCompletedRef.current) return;
      const waiting = pendingInteractionAgentsRef.current.has(event.actorId);
      setAgents((current) => current.map((agent) => agent.id === event.actorId
        ? { ...agent, status: waiting ? "Waiting for you" : missionPausedRef.current
          ? event.payload.status === "Working" ? "Pausing" : "Paused" : event.payload.status,
          next: waiting ? "Waiting for your response" : missionPausedRef.current
            ? "Chat paused by you" : event.payload.status === "Waiting for budget"
              ? "Monthly usage limit reached. Review the limit in Settings." : event.payload.status === "Working"
                ? "Working through the team plan" : "Ready for the next task" }
        : agent));
    }
    if (event.type === "agent.tool.started" || event.type === "agent.tool.completed") {
      if (missionCompletedRef.current) return;
      const tool = event.payload.toolName.replaceAll("_", " ");
      const detail = event.payload.summary ? ` · ${event.payload.summary}` : "";
      setAgents((current) => current.map((agent) => agent.id === event.actorId
        ? { ...agent,
          status: pendingInteractionAgentsRef.current.has(agent.id)
            ? "Waiting for you" : missionPausedRef.current ? "Pausing" : "Working",
          activity: event.type.endsWith("started") ? `${tool}${detail}` : agent.activity,
          next: event.type.endsWith("started") ? `Using ${tool}` : `${tool} finished`,
        }
        : agent));
    }
    if (event.type === "artifact.created") {
      const item = mapArtifact(event.payload.artifact);
      setArtifacts((current) => current.some((existing) => existing.id === item.id) ? current : [item, ...current]);
    }
    if (event.type.startsWith("artifact.review.")) {
      setArtifactReviewRevision((revision) => revision + 1);
    }
    if (event.type.startsWith("canvas.")) {
      setCanvasRefreshNonce((revision) => revision + 1);
    }
    if (event.type === "repo.worktree.discarded") {
      setIsolatedWorkspaces((current) => current.filter((workspace) => workspace.agent_id !== event.payload.agentId));
    }
    if (event.type === "knowledge.entry.saved") {
      const entry = event.payload.entry;
      setKnowledge((current) => current.some((item) => item.id === entry.id)
        ? current.map((item) => item.id === entry.id ? entry : item)
        : [...current, entry]);
    }
    if (event.type === "knowledge.proposed") {
      const proposal = event.payload.proposal;
      setKnowledgeProposals((current) => current.some((item) => item.id === proposal.id) ? current : [proposal, ...current]);
    }
    if (event.type === "knowledge.proposal.reviewed") {
      const { proposal, entry } = event.payload;
      setKnowledgeProposals((current) => current.map((item) => item.id === proposal.id ? proposal : item));
      if (entry) setKnowledge((current) => current.some((item) => item.id === entry.id)
        ? current.map((item) => item.id === entry.id ? entry : item) : [...current, entry]);
    }
    if (event.type === "knowledge.entry.archived" || event.type === "knowledge.entry.restored") {
      const entry = event.payload.entry;
      setKnowledge((current) => current.map((item) => item.id === entry.id ? entry : item));
    }
    if (event.type === "repo.test_run.started" || event.type === "repo.test_run.completed") {
      const run = mapTestRun(event);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    }
    if ((event.type === "repo.command.started" || event.type === "repo.command.completed")
      && mission?.id === event.missionId) {
      runtime.listCommands(event.missionId).then(({ runs: current }) => {
        if (loadedMissionIdRef.current === event.missionId) setCommandRuns(current);
      }).catch(() => {});
    }
    if (event.type.startsWith("interaction.") && event.type.endsWith(".requested")) {
      refreshPendingRequests();
      const item = mapInteraction(event.payload.interaction);
      const waiting = pendingInteractionAgentsRef.current.get(item.agent) ?? new Set();
      waiting.add(item.id);
      pendingInteractionAgentsRef.current.set(item.agent, waiting);
      setAgents((current) => current.map((agent) => agent.id === item.agent
        ? { ...agent, status: "Waiting for you", next: `Waiting for ${item.type === "approval" ? "approval" : "your answer"}` }
        : agent));
      setInteractions((current) => current.some((existing) => existing.id === item.id) ? current : [...current, item]);
    }
    if (event.type === "computer.observation.requested") {
      void refreshPendingRequests();
      setAgents((current) => current.map((agent) => agent.id === event.actorId
        ? { ...agent, status: "Waiting for you", next: "Waiting for a window selection" }
        : agent));
    }
    if (["computer.observation.completed", "computer.observation.cancelled"].includes(event.type)) {
      void refreshPendingRequests();
      const agentId = event.actorId === "user" ? event.payload.agentId : event.actorId;
      setAgents((current) => current.map((agent) => agent.id === agentId
        ? { ...agent, status: "Working", next: "Reviewing the observation result" }
        : agent));
    }
    if (event.type.startsWith("interaction.") && event.type.endsWith(".resolved")) {
      refreshPendingRequests();
      const resolved = event.payload.interaction;
      const waiting = pendingInteractionAgentsRef.current.get(resolved.requested_by);
      waiting?.delete(resolved.id);
      if (waiting?.size === 0) pendingInteractionAgentsRef.current.delete(resolved.requested_by);
      setInteractions((current) => current.filter((item) => item.id !== resolved.id));
      if (!pendingInteractionAgentsRef.current.has(resolved.requested_by)) {
        setAgents((current) => current.map((agent) => agent.id === resolved.requested_by
          ? { ...agent, status: "Ready", next: "Reviewing your response" }
          : agent));
      }
    }
  }

  useEffect(() => {
    if (selectedGeneralChat) return undefined;
    let alive = true;
    let unsubscribe = () => {};
    const load = async () => {
      try {
        const data = await runtime.bootstrap(project.id, mission?.id, showNewChat);
        if (!alive) return;
        let initialEvents = data.events ?? [];
        let hasMoreEvents = Boolean(data.hasMoreEvents);
        let earliestSequence = initialEvents[0]?.sequence ?? null;
        while (data.mission?.id && earliestSequence !== null && hasMoreEvents
            && !initialEvents.some((event) => event.type === "message.created" && event.actorId === "user")) {
          try {
            const page = await runtime.eventsBefore(data.mission.id, earliestSequence);
            const nextEarliestSequence = page.events?.[0]?.sequence;
            if (!Number.isSafeInteger(nextEarliestSequence) || nextEarliestSequence >= earliestSequence) {
              hasMoreEvents = false;
              break;
            }
            initialEvents = [...page.events, ...initialEvents];
            earliestSequence = nextEarliestSequence;
            hasMoreEvents = Boolean(page.hasMore);
          } catch {
            break;
          }
        }
        if (!alive) return;
        setProject(data.project ?? { id: undefined, name: "" });
        setMission(data.mission);
        missionPausedRef.current = data.mission?.status === "paused";
        missionCompletedRef.current = data.mission?.status === "completed" || Boolean(data.mission?.archived_at);
        setProjects(data.projects);
        setGeneralChats(data.generalChats ?? []);
        setAgentRuntime(data.agentRuntime);
        setAgentDirectory(data.agentDirectory ?? "");
        setCapabilityCatalog(data.capabilityCatalog ?? []);
        setMissions(data.missions);
        const pendingByAgent = new Map();
        for (const item of data.interactions) {
          const agentRequests = pendingByAgent.get(item.requested_by) ?? new Set();
          agentRequests.add(item.id);
          pendingByAgent.set(item.requested_by, agentRequests);
        }
        pendingInteractionAgentsRef.current = pendingByAgent;
        const initialAgents = data.agents.map((agent) => ({
          ...agent,
          status: data.agentRuntime.agentErrors?.[agent.id] ? "Provider setup failed" : data.mission?.status === "completed" ? "Complete" : pendingByAgent.has(agent.id) ? "Waiting for you" : data.mission?.status === "paused" ? "Paused" : data.workItems.some((item) => item.owner === agent.id && item.status === "claimed") ? "Working" : data.agentRuntime.enabled ? "Ready" : "Not configured",
          activity: data.workItems.find((item) => item.owner === agent.id && item.status === "claimed")?.title ?? agent.role,
          next: data.agentRuntime.agentErrors?.[agent.id] ?? (agent.model ? `Using ${agent.model}` : data.mission?.status === "completed" ? "Mission completed" : pendingByAgent.has(agent.id) ? "Waiting for your response" : data.mission?.status === "paused" ? "Mission paused by you" : data.agentRuntime.enabled ? "Ready for the next task" : "Connect a model to start this agent"),
          color: agentColours[agent.id] ?? "blue",
        }));
        setAgents(restoreAgentActivity(
          initialAgents, data.events, new Set(pendingByAgent.keys()), data.mission?.status,
        ));
        agentDefinitionsRef.current = data.agents;
        setMessages(timelineEntries(initialEvents, data.agents));
        oldestEventSequenceRef.current = earliestSequence;
        loadedMissionIdRef.current = data.mission?.id ?? null;
        setHasOlderEvents(hasMoreEvents);
        setLoadingOlderEvents(false);
        setRuns(mapTestRuns(data.events));
        setCommandRuns(data.commandRuns ?? []);
        const mappedInteractions = data.interactions.map(mapInteraction);
        const preferredInteractionId = preferredInteractionRef.current;
        const preferredIndex = mappedInteractions.findIndex((item) => item.id === preferredInteractionId);
        if (preferredIndex > 0) mappedInteractions.unshift(...mappedInteractions.splice(preferredIndex, 1));
        if (preferredIndex >= 0) preferredInteractionRef.current = null;
        setInteractions(mappedInteractions);
        refreshPendingRequests();
        setWorkItems(data.workItems.map(mapWorkItem));
        setIsolatedWorkspaces(data.isolatedWorkspaces ?? []);
        setArtifacts(data.artifacts.map(mapArtifact));
        setKnowledge(data.knowledge);
        setKnowledgeProposals(data.knowledgeProposals ?? []);
        setKnowledgeMigration(data.knowledgeMigration ?? { missing: [], conflicts: [], reviewed: [] });
        if (!data.project) {
          setSkills([]);
          setRuntimeStatus("connected");
          return;
        }
        const discovered = await runtime.listSkills(data.project.id, data.mission?.id);
        if (!alive) return;
        setSkills(discovered.skills);
        cursorRef.current = data.cursor;
        setRuntimeStatus("connected");
        if (data.mission) unsubscribe = runtime.subscribe(data.mission.id, data.cursor, applyEvent, setRuntimeStatus);
      } catch {
        if (alive) setRuntimeStatus("offline");
      }
    };
    load();
    return () => { alive = false; unsubscribe(); };
  }, [project.id, mission?.id, showNewChat, selectedGeneralChat]);

  useEffect(() => {
    if (!mission?.id) { setCommandRuns([]); setAgentRequests([]); return undefined; }
    let alive = true;
    const refresh = async () => {
      try {
        const [{ runs: current }, { requests }] = await Promise.all([
          runtime.listCommands(mission.id), runtime.listAgentRequests(mission.id),
        ]);
        if (alive) {
          setCommandRuns(current);
          setAgentRequests(requests);
        }
      } catch { /* Command history will refresh when the runtime reconnects. */ }
    };
    refresh();
    if (activeTab !== "Runs" && !(projectPaneOpen && selectedWorkspaceView === "Runs")) return () => { alive = false; };
    const timer = window.setInterval(refresh, 1200);
    return () => { alive = false; window.clearInterval(timer); };
  }, [mission?.id, activeTab, projectPaneOpen, projectPaneTab]);

  useEffect(() => {
    if (!project.id) { setSchedules([]); return undefined; }
    let alive = true;
    const refresh = async () => {
      try { const result = await runtime.listSchedules(project.id); if (alive) setSchedules(result.schedules); } catch { /* Keep the cached schedule list while reconnecting. */ }
    };
    refresh();
    if (activeTab !== "Schedules" && !(projectPaneOpen && selectedWorkspaceView === "Schedules") && !(projectSettingsOpen && projectSettingsSection === "schedules")) return () => { alive = false; };
    const timer = window.setInterval(refresh, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [project.id, activeTab, projectPaneOpen, projectPaneTab, projectSettingsOpen, projectSettingsSection]);

  useEffect(() => {
    let alive = true;
    void getDesktopNotificationsEnabled().then((enabled) => {
      if (alive) setDesktopNotificationsOn(enabled);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const result = await runtime.listSchedules();
        if (!alive) return;
        const { nextStatuses, notifications } = scheduleRunNotifications(
          scheduleRunStatusesRef.current, result.schedules,
        );
        scheduleRunStatusesRef.current = nextStatuses;
        setWorkspaceSchedules(result.schedules);
        for (const notification of notifications) {
          const prefix = notification.projectName ? `${notification.projectName}: ` : "";
          const title = notification.missionTitle || "Scheduled chat";
          const needsInput = notification.status === "blocked";
          const failed = notification.status === "failed";
          notify(needsInput ? `${prefix}${title} needs your input.`
            : failed ? `${prefix}${title} needs attention. Open the chat to continue.`
              : `${prefix}${title} completed.`);
          void sendDesktopNotification(
            needsInput ? "Scheduled chat needs your input"
              : failed ? "Scheduled chat needs attention" : "Scheduled chat completed",
            needsInput ? "Open Tribe to continue the chat."
              : failed ? "Open Tribe to review the failure and continue." : "Open Tribe to review the result.",
          );
        }
      } catch { /* Keep the last workspace schedule list while reconnecting. */ }
    };
    void refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!project.id) { setUsage(emptyUsage); return undefined; }
    let alive = true;
    const refresh = async () => {
      try { const result = await runtime.getUsage(project.id); if (alive) setUsage(result.usage); } catch { /* Usage data is available again when the runtime reconnects. */ }
    };
    refresh();
    if (activeTab !== "Settings") return () => { alive = false; };
    const timer = window.setInterval(refresh, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [project.id, activeTab]);

  useEffect(() => {
    const version = ++artifactQueryVersionRef.current;
    if (!project.id || (activeTab !== "Artifacts" && !(projectPaneOpen && selectedWorkspaceView === "Artifacts") && !(projectSettingsOpen && projectSettingsSection === "artifacts"))) {
      if (!project.id) setProjectArtifacts([]);
      return undefined;
    }
    let alive = true;
    setArtifactLoading(true);
    setArtifactLoadingMore(false);
    setArtifactError("");
    setProjectArtifacts([]);
    setArtifactCursor(null);
    setArtifactTotal(0);
    setArtifactHasMore(false);
    runtime.listProjectArtifacts(project.id, { query: artifactSearch, limit: 50 }).then((page) => {
      if (!alive || version !== artifactQueryVersionRef.current) return;
      setProjectArtifacts(page.artifacts.map(mapArtifact));
      setArtifactCursor(page.nextCursor);
      setArtifactTotal(page.total);
      setArtifactHasMore(page.hasMore);
    }).catch((error) => {
      if (alive && version === artifactQueryVersionRef.current) setArtifactError(error.message);
    }).finally(() => {
      if (alive && version === artifactQueryVersionRef.current) setArtifactLoading(false);
    });
    return () => { alive = false; };
  }, [project.id, activeTab, projectPaneOpen, projectPaneTab, projectSettingsOpen, projectSettingsSection, artifactSearch, artifactRefreshNonce]);

  useEffect(() => {
    let alive = true;
    if (!project.id) {
      setCanvasDocuments([]);
      return () => { alive = false; };
    }
    runtime.listCanvasDocuments(project.id).then(({ documents = [] }) => {
      if (alive) setCanvasDocuments(documents);
    }).catch((error) => {
      if (alive) notify(`Documents could not be loaded: ${error.message}`);
    });
    return () => { alive = false; };
  }, [project.id, canvasRefreshNonce]);

  useEffect(() => {
    let alive = true;
    if (!mission?.id) {
      setMissionCanvasDocuments([]);
      return () => { alive = false; };
    }
    runtime.listMissionCanvasDocuments(mission.id).then(({ documents = [] }) => {
      if (alive) setMissionCanvasDocuments(documents);
    }).catch((error) => {
      if (alive) notify(`Mission documents could not be loaded: ${error.message}`);
    });
    return () => { alive = false; };
  }, [mission?.id, canvasRefreshNonce]);

  const visibleMessages = useMemo(() => {
    const titles = new Map(workItemsState.map((item) => [item.workItemId, item.title]));
    return filterTimelineMessages(messages, { query })
      .map((message) => ({ ...message, workItemTitle: titles.get(message.workItemId) ?? message.workItemTitle }));
  }, [messages, query, workItemsState]);
  const conversationMessages = useMemo(() => filterConversationMessages(visibleMessages, messages), [visibleMessages, messages]);
  const executionMessages = useMemo(() => {
    const titles = new Map(workItemsState.map((item) => [item.workItemId, item.title]));
    return messages.map((message) => ({ ...message, workItemTitle: titles.get(message.workItemId) ?? message.workItemTitle }));
  }, [messages, workItemsState]);

  const notify = useCallback((text) => {
    setToast(text);
    window.clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = window.setTimeout(() => setToast(""), 3200);
  }, []);

  async function requestDesktopNotifications() {
    const enabled = await enableDesktopNotifications();
    setDesktopNotificationsOn(enabled);
    notify(enabled ? "Desktop notifications are enabled." : "Desktop notifications were not enabled.");
    return enabled;
  }

  async function testDesktopNotifications() {
    const sent = await sendTestDesktopNotification();
    notify(sent ? "Test notification sent." : "Could not send a test notification.");
    return sent;
  }

  async function sendMessage(text, recipient = null, canvasContext = null, attachments = [], options = {}) {
    if (!mission) return;
    if (mission.archived_at) {
      notify("Restore this chat before posting to its channel.");
      return false;
    }
    if (canvasContext?.missionId && canvasContext.missionId !== mission.id) {
      notify("This document belongs to another chat. Reopen it from that chat before sending.");
      return false;
    }
    try {
      const { event } = await runtime.sendMessage(mission.id, text, recipient, canvasContext ? {
        artifactId: canvasContext.artifactId, revision: canvasContext.revision,
        selectedText: canvasContext.selectedText ?? "",
      } : null, attachments.map(({ id }) => id), options);
      applyEvent(event);
      notify(agentRuntime.enabled
        ? "Message sent to the team."
        : "Message saved. Connect a model for the team to respond.");
      return true;
    } catch (error) {
      notify(`Message was not saved: ${error.message}`);
      return false;
    }
  }

  async function saveMissionModelPreferences(model, effort) {
    if (!mission) return;
    try {
      const { mission: updated } = await runtime.setMissionModelPreferences(
        mission.id, model || null, effort || null,
      );
      setMission((current) => current?.id === updated.id ? updated : current);
      setMissions((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (error) {
      const message = ({
        model_not_allowed: "Allow this model in Settings before selecting it for a chat.",
        model_does_not_support_agent_tools: "This model cannot use Tribe’s agent tools.",
        model_effort_not_supported: "This model does not support that reasoning effort.",
      })[error.message] ?? error.message;
      notify(`Model preference could not be saved: ${message}`);
      throw new Error(message);
    }
  }

  async function recoverAgentRun(agentId) {
    return sendMessage(
      "My previous run failed or was interrupted. Inspect the current repository, recent tool activity and plan state before continuing. Verify whether any side effects already happened; do not repeat an operation until its current outcome is clear. Identify the cause, then resume the mission from the current state and report what you found.",
      agentId,
    );
  }

  async function stopAgentRun(agent) {
    if (!mission?.id) return;
    try {
      await runtime.stopAgentRun(mission.id, agent.id);
      notify(`${agent.name} is stopping. Check the activity for any partial changes.`);
    } catch (error) {
      notify(`Could not stop ${agent.name}: ${error.message}`);
    }
  }

  async function loadOlderEvents(beforeMerge) {
    const missionId = mission?.id;
    const before = oldestEventSequenceRef.current;
    if (!missionId || before === null || loadingOlderEvents) return;
    setLoadingOlderEvents(true);
    try {
      const page = await runtime.eventsBefore(missionId, before);
      if (loadedMissionIdRef.current !== missionId) return;
      oldestEventSequenceRef.current = page.events[0]?.sequence ?? before;
      setHasOlderEvents(Boolean(page.hasMore));
      const olderMessages = timelineEntries(page.events, agentDefinitionsRef.current);
      beforeMerge?.(olderMessages);
      setMessages((current) => mergeTimelineMessages(current, olderMessages));
      return olderMessages;
    } catch (error) {
      notify(`Earlier activity could not be loaded: ${error.message}`);
    } finally {
      setLoadingOlderEvents(false);
    }
  }

  function activateGeneralChat(chat) {
    setProjectPaneOpen(false);
    setOpenProjectPaneTabs([]);
    setProjectPaneTab("");
    setCanvasDiscussionSplit(false);
    setSelectedCanvasDocument(null);
    setShowNewChat(false);
    setProject({ id: undefined, name: "" });
    setMissions([]);
    setMission(null);
    setSelectedGeneralChat(chat);
    setActiveTab("Mission");
  }

  async function createGeneralChat() {
    try {
      const { chat } = await runtime.createGeneralChat();
      setGeneralChats((current) => [chat, ...current]);
      activateGeneralChat(chat);
    } catch (error) {
      notify(`Chat could not be created: ${error.message}`);
    }
  }

  async function selectGeneralChat(chatId) {
    try {
      const { chat } = await runtime.getGeneralChat(chatId);
      activateGeneralChat(chat);
    } catch (error) {
      notify(`Chat could not be opened: ${error.message}`);
    }
  }

  async function sendGeneralChatMessage(text, options = {}) {
    if (!selectedGeneralChat) return "general_chat_not_found";
    const { chat, responseError } = await runtime.sendGeneralChatMessage(selectedGeneralChat.id, text, options);
    setSelectedGeneralChat(chat);
    setGeneralChats((current) => [chat, ...current.filter((item) => item.id !== chat.id)]);
    return responseError;
  }

  async function setGeneralChatModelPreference(modelPreference) {
    if (!selectedGeneralChat) return;
    const { chat } = await runtime.setGeneralChatModelPreference(selectedGeneralChat.id, modelPreference);
    setSelectedGeneralChat(chat);
    setGeneralChats((current) => current.map((item) => item.id === chat.id ? chat : item));
  }

  async function createMission(initialPrompt, modelPreference = null, effortPreference = null, options = {}) {
    const parsed = parseMissionPrompt(initialPrompt, recipes, skills);
    if (parsed.error) {
      notify(parsed.error);
      return false;
    }
    const goal = parsed.text.trim();
    if (!project.id || !goal) return false;
    setSelectedGeneralChat(null);
    const title = chatTitleFromPrompt(goal);
    try {
      const { mission: created } = await runtime.createMission(
        project.id, title, goal, parsed.recipeId, goal, parsed.selectedSkills,
        modelPreference, effortPreference, parsed.recipeVersion, options,
      );
      const pauseActive = (items) => items.map((item) => item.status === "active" && !item.archived_at
        ? { ...item, status: "paused" } : item);
      setMissions((current) => [created, ...pauseActive(current)]);
      setProjects((current) => current.map((item) => item.id === project.id
        ? { ...item, missions: [created, ...pauseActive(item.missions ?? [])] }
        : item));
      setShowNewChat(false);
      setProjectPaneOpen(false);
      setMission(created);
      setActiveTab("Mission");
      notify("Chat started.");
      return true;
    } catch (error) {
      notify(`Mission was not created: ${error.message}`);
      return false;
    }
  }

  async function createAgentDefinition(definition, projectId = null) {
    try {
      const { agent, agentDirectory: directory, projectAgentIds } = await runtime.createAgent(definition, projectId);
      setAgentDirectory(directory);
      setAgents((current) => [...current, {
        ...agent,
        status: agentRuntime.enabled ? "Ready" : "Not configured",
        activity: agent.role,
        next: agentRuntime.enabled ? "Ready for the next task" : "Connect a model to start this agent",
        color: "blue",
      }]);
      if (projectId && projectAgentIds) {
        setProject((current) => current.id === projectId ? { ...current, agentIds: projectAgentIds } : current);
        setProjects((current) => current.map((item) => item.id === projectId ? { ...item, agentIds: projectAgentIds } : item));
      }
      notify("Agent role saved");
      return true;
    } catch (error) {
      const detail = error.message === "agent_model_must_be_allowed"
        ? "Choose a model that is allowed in Settings → Models."
        : error.message === "agent_model_does_not_support_tools"
          ? "Choose a model that supports agent tools."
          : error.message === "agent_effort_not_supported_by_model"
            ? "Choose an effort level supported by this model, or leave effort on Auto."
          : error.message;
      notify(`Agent role was not saved: ${detail}`);
      return false;
    }
  }

  async function updateProjectTeam(agentIds) {
    if (!project.id) return false;
    try {
      const result = await runtime.updateProjectTeam(project.id, agentIds);
      setProject((current) => current.id === project.id ? { ...current, agentIds: result.agentIds } : current);
      setProjects((current) => current.map((item) => item.id === project.id
        ? { ...item, agentIds: result.agentIds } : item));
      return true;
    } catch (error) {
      notify(`Project team was not updated: ${error.message}`);
      return false;
    }
  }

  async function updateAgentDefinition(id, definition) {
    try {
      const { agent } = await runtime.updateAgent(id, definition);
      setAgents((current) => current.map((item) => item.id === id ? {
        ...item,
        ...agent,
        status: item.status === "Working" ? "Restarting" : item.status,
        activity: agent.role,
        next: item.status === "Working" ? "Waiting for the current agent call to finish" : item.next,
        color: item.color,
      } : item));
      notify("Role updated. Agents will use it after their current turn.");
      return true;
    } catch (error) {
      const detail = error.message === "agent_model_must_be_allowed"
        ? "Choose a model that is allowed in Settings → Models."
        : error.message === "agent_model_does_not_support_tools"
          ? "Choose a model that supports agent tools."
          : error.message === "agent_effort_not_supported_by_model"
            ? "Choose an effort level supported by this model, or leave effort on Auto."
          : error.message;
      notify(`Agent role was not updated: ${detail}`);
      return false;
    }
  }

  async function archiveAgentDefinition(agent) {
    const accepted = await requestConfirmation({
      eyebrow: "Archive role",
      title: `Archive ${agent.name}?`,
      message: "This role will stop receiving new work after its current agent calls finish. You can restore it later.",
      confirmLabel: "Archive role",
    });
    if (!accepted) return;
    try {
      await runtime.archiveAgent(agent.id);
      setAgents((current) => current.filter((item) => item.id !== agent.id));
      notify(`${agent.name} archived`);
    } catch (error) {
      notify(`Agent role was not archived: ${error.message}`);
    }
  }

  async function selectMission(missionId, selectedProject) {
    if (!missionId) return;
    setSelectedGeneralChat(null);
    const switchingProject = selectedProject && selectedProject.id !== project.id;
    if (switchingProject) {
      setProjectPaneOpen(false);
      setOpenProjectPaneTabs([]);
      setProjectPaneTab("");
      setCanvasDiscussionSplit(false);
      setSelectedCanvasDocument(null);
      setComposerDraft(null);
      setShowNewChat(false);
      setProject(selectedProject);
      setMissions(selectedProject.missions ?? []);
      setActiveTab("Mission");
    }
    if (composerDraft?.canvasDocument?.missionId !== missionId) setComposerDraft(null);
    const target = switchingProject
      ? (selectedProject.missions ?? []).find((item) => item.id === missionId)
      : missions.find((item) => item.id === missionId);
    if (switchingProject && !target) {
      notify("This chat is no longer available in that project.");
      return false;
    }
    if (target?.archived_at) {
      missionPausedRef.current = target.status === "paused";
      missionCompletedRef.current = true;
      setShowNewChat(false);
      setMission(target);
      return true;
    }
    if (target?.status === "completed") {
      missionPausedRef.current = false;
      missionCompletedRef.current = true;
      setShowNewChat(false);
      setMission(target);
      return true;
    }
    if (target?.status === "active") {
      missionPausedRef.current = false;
      missionCompletedRef.current = false;
      setShowNewChat(false);
      setMission(target);
      return true;
    }
    if (target?.status === "paused") {
      missionPausedRef.current = true;
      missionCompletedRef.current = false;
      setShowNewChat(false);
      setMission(target);
      return true;
    }
    try {
      const { mission: selected } = await runtime.activateMission(missionId);
      missionPausedRef.current = selected.status === "paused";
      missionCompletedRef.current = selected.status === "completed";
      setMissions((current) => current.map((item) => item.id === missionId ? selected
        : selected.background || item.background ? item : { ...item, status: "paused" }));
      setShowNewChat(false);
      setMission(selected);
      return true;
    } catch (error) {
      notify(`Mission could not be resumed: ${error.message}`);
      return false;
    }
  }

  async function openPendingInteraction(interaction) {
    setRequestsOpen(false);
    setShowNewChat(false);
    setCanvasDiscussionSplit(false);
    setActiveTab("Mission");
    preferredInteractionRef.current = interaction.id;
    if (interaction.missionId === mission?.id) {
      if (interactions.some((item) => item.id === interaction.id)) {
        activateInteraction(interaction.id);
        return;
      }
      try {
        const data = await runtime.bootstrap(project.id, mission.id);
        const pending = data.interactions.map(mapInteraction);
        const selectedIndex = pending.findIndex((item) => item.id === interaction.id);
        if (selectedIndex > 0) pending.unshift(...pending.splice(selectedIndex, 1));
        preferredInteractionRef.current = null;
        if (selectedIndex < 0) notify("This request is no longer waiting for you");
        setInteractions(pending);
      } catch (error) {
        preferredInteractionRef.current = null;
        notify(`Request could not be opened: ${error.message}`);
      }
      return;
    }
    const selected = {
      id: interaction.missionId,
      project_id: interaction.projectId,
      title: interaction.missionTitle,
      goal: interaction.missionGoal,
      status: interaction.missionStatus,
    };
    missionPausedRef.current = selected.status === "paused";
    setProject(projects.find((item) => item.id === interaction.projectId) ?? {
      id: interaction.projectId, name: interaction.projectName,
    });
    setMission(selected);
  }

  async function pauseCurrentMission() {
    if (!mission?.id || mission.status !== "active" || missionControlPending) return;
    setMissionControlPending(true);
    try {
      const { mission: paused } = await runtime.pauseMission(mission.id);
      missionPausedRef.current = true;
      setMission(paused);
      setMissions((current) => current.map((item) => item.id === paused.id ? paused : item));
      setAgents((current) => current.map((agent) => ({
        ...agent,
        status: pendingInteractionAgentsRef.current.has(agent.id)
          ? "Waiting for you" : ["Working", "Pausing"].includes(agent.status) ? "Pausing" : "Paused",
        next: pendingInteractionAgentsRef.current.has(agent.id) ? "Waiting for your response"
          : ["Working", "Pausing"].includes(agent.status) ? "Finishing the current action before pausing" : "Chat paused by you",
      })));
      notify("Chat paused. Agents will finish any in-flight action before stopping.");
    } catch (error) {
      notify(`Chat could not be paused: ${error.message}`);
    } finally {
      setMissionControlPending(false);
    }
  }

  async function resumeCurrentMission() {
    if (!mission?.id || mission.status === "active" || missionControlPending) return;
    setMissionControlPending(true);
    try {
      const { mission: resumed } = await runtime.activateMission(mission.id);
      if (!resumed) return;
      missionPausedRef.current = false;
      missionCompletedRef.current = resumed.status === "completed";
      setMissions((current) => current.map((item) => item.id === resumed.id ? resumed
        : resumed.background || item.background ? item : { ...item, status: "paused" }));
      setShowNewChat(false);
      setMission(resumed);
      notify("Chat resumed. The team is back to work.");
    } catch (error) {
      notify(`Chat could not be resumed: ${error.message}`);
    } finally {
      setMissionControlPending(false);
    }
  }

  async function archiveCurrentMission(targetMissionId = mission?.id) {
    let target = missions.find((item) => item.id === targetMissionId) ?? (mission?.id === targetMissionId ? mission : null);
    if (!target?.id || target.archived_at || missionControlPending) return;
    const action = target.status === "active" ? "Pause and archive" : "Archive";
    if (!(await requestConfirmation({
      eyebrow: "Archive chat",
      title: `${action} “${target.title}”?`,
      message: "Its conversation, plan, files and history will be kept. You can restore it later.",
      confirmLabel: action,
    }))) return;
    setMissionControlPending(true);
    try {
      if (target.status === "active") {
        const { mission: paused } = await runtime.pauseMission(target.id);
        target = paused;
        if (mission?.id === paused.id) {
          missionPausedRef.current = true;
          setMission(paused);
        }
        setMissions((current) => current.map((item) => item.id === paused.id ? paused : item));
      }
      const { mission: archived } = await runtime.archiveMission(target.id);
      if (mission?.id === archived.id) {
        missionCompletedRef.current = true;
        setMission(archived);
      }
      setMissions((current) => current.map((item) => item.id === archived.id ? archived : item));
      setProjects((current) => current.map((item) => ({ ...item, missions: (item.missions ?? []).map((entry) => entry.id === archived.id ? archived : entry) })));
      notify("Chat archived. Its history and files are still available.");
    } catch (error) {
      notify(`Chat could not be archived: ${error.message}`);
    } finally {
      setMissionControlPending(false);
    }
  }

  async function restoreCurrentMission(targetMissionId = mission?.id) {
    const target = missions.find((item) => item.id === targetMissionId) ?? (mission?.id === targetMissionId ? mission : null);
    if (!target?.id || !target.archived_at || missionControlPending) return;
    setMissionControlPending(true);
    try {
      const { mission: restored } = await runtime.restoreMission(target.id);
      if (mission?.id === restored.id) {
        missionPausedRef.current = restored.status === "paused";
        missionCompletedRef.current = restored.status === "completed";
        setMission(restored);
      }
      setMissions((current) => current.map((item) => item.id === restored.id ? restored : item));
      setProjects((current) => current.map((item) => ({ ...item, missions: (item.missions ?? []).map((entry) => entry.id === restored.id ? restored : entry) })));
      notify("Chat restored. Its previous status has been preserved.");
    } catch (error) {
      notify(`Chat could not be restored: ${error.message}`);
    } finally {
      setMissionControlPending(false);
    }
  }

  async function deleteMissionWithConfirmation(targetMissionId) {
    let target = missions.find((item) => item.id === targetMissionId)
      ?? projects.flatMap((item) => item.missions ?? []).find((item) => item.id === targetMissionId);
    if (!target?.id || missionControlPending) return;
    if (!(await requestConfirmation({
      eyebrow: "Delete chat",
      title: `Permanently delete “${target.title}”?`,
      message: target.archived_at
        ? "This removes the conversation, plan, chat files and history."
        : "This removes the conversation, plan, chat files and history. The chat will be paused and archived first.",
      detail: "Files in the project repository will remain. If work is still running or isolated changes need review, Tribe will keep the chat archived until it is safe to delete. This cannot be undone.",
      confirmLabel: "Delete chat",
      tone: "danger",
    }))) return;
    setMissionControlPending(true);
    try {
      if (!target.archived_at) {
        if (target.status === "active") {
          const { mission: paused } = await runtime.pauseMission(target.id);
          target = paused;
          if (mission?.id === paused.id) {
            missionPausedRef.current = true;
            setMission(paused);
          }
          setMissions((current) => current.map((item) => item.id === paused.id ? paused : item));
          setProjects((current) => current.map((item) => ({ ...item, missions: (item.missions ?? []).map((entry) => entry.id === paused.id ? paused : entry) })));
        }
        const { mission: archived } = await runtime.archiveMission(target.id);
        target = archived;
        if (mission?.id === archived.id) {
          missionCompletedRef.current = true;
          setMission(archived);
        }
        setMissions((current) => current.map((item) => item.id === archived.id ? archived : item));
        setProjects((current) => current.map((item) => ({ ...item, missions: (item.missions ?? []).map((entry) => entry.id === archived.id ? archived : entry) })));
      }
      await runtime.deleteMission(target.id);
      setMissions((current) => current.filter((item) => item.id !== target.id));
      setProjects((current) => current.map((item) => ({
        ...item,
        missions: (item.missions ?? []).filter((entry) => entry.id !== target.id),
      })));
      if (mission?.id === target.id) {
        missionCompletedRef.current = false;
        missionPausedRef.current = false;
        setMission(null);
        setShowNewChat(true);
        setActiveTab("Mission");
      }
      notify("Chat permanently deleted.");
    } catch (error) {
      const message = error.message === "discard_isolated_work_before_deleting"
        ? "Discard isolated work before deleting this chat."
        : error.message === "chat_has_unfinished_work"
          ? "Resolve pending requests and stop running work before deleting this chat."
        : error.message === "archive_chat_before_deleting"
            ? "Archive this chat before deleting it."
            : `Chat could not be deleted: ${error.message}`;
      notify(message);
    } finally {
      setMissionControlPending(false);
    }
  }

  async function deleteProject(targetProjectId) {
    const target = projects.find((item) => item.id === targetProjectId);
    if (!target?.id || missionControlPending) return;
    const chatCount = target.missions?.length ?? 0;
    const chatCopy = `${chatCount} ${chatCount === 1 ? "chat" : "chats"}`;
    const confirmed = await requestConfirmation({
      eyebrow: "Delete project",
      title: `Delete “${target.name}”?`,
      message: `This removes the project and its ${chatCopy}, including guidance, plans, artifacts, schedules and saved project connections.`,
      detail: "The repository folder and files will stay untouched. This cannot be undone.",
      confirmLabel: "Delete project",
      tone: "danger",
    });
    if (!confirmed) return;
    setMissionControlPending(true);
    try {
      const result = await runtime.deleteProject(target.id);
      const remaining = projects.filter((item) => item.id !== target.id);
      setProjects(remaining);
      if (project.id === target.id) {
        const nextProject = remaining[0] ?? { id: undefined, name: "" };
        setCanvasDiscussionSplit(false);
        setSelectedCanvasDocument(null);
        setComposerDraft(null);
        setProject(nextProject);
        setMissions(nextProject.missions ?? []);
        setMission(null);
        setShowNewChat(false);
        setMessages([]);
        setArtifacts([]);
        setProjectArtifacts([]);
        setKnowledge([]);
        setKnowledgeProposals([]);
        setWorkItems([]);
        setRuns([]);
        setCommandRuns([]);
        setSchedules([]);
        setActiveTab("Mission");
      }
      notify(result.credentialCleanup === "incomplete"
        ? "Project deleted, but some saved service sign-ins could not be cleared."
        : "Project and its chats deleted. Repository files were kept.");
    } catch (error) {
      const message = error.message === "project_has_unfinished_work"
        ? "Stop active work, resolve pending requests and discard isolated work before deleting this project."
        : `Project could not be deleted: ${error.message}`;
      notify(message);
    } finally {
      setMissionControlPending(false);
    }
  }

  async function createProject({ sourceMode, repositoryPath, repositoryUrl, parentDirectory, projectName }) {
    try {
      const result = sourceMode === "clone"
        ? await runtime.cloneProject(repositoryUrl.trim(), parentDirectory.trim(), projectName.trim())
        : await runtime.createProject(repositoryPath.trim(), projectName.trim());
      const addedProject = { ...result.project, missions: [] };
      setSelectedGeneralChat(null);
      setProjects((current) => [addedProject, ...current]);
      setProject(addedProject);
      setMission(null);
      setShowNewChat(false);
      setMissions([]);
      setMessages([]);
      setArtifacts([]);
      setWorkItems([]);
      setInteractions([]);
      setActiveTab("Mission");
      closeProjectCreate();
      notify(agentRuntime.enabled
        ? "Project added. Start a chat whenever you’re ready."
        : "Project added. Connect a model to start your first chat.");
    } catch (error) {
      const message = projectSetupError(error);
      throw new Error(message, { cause: error });
    }
  }

  function openProjectSettings(targetProject = project, section = "team", returnFocusElement = document.activeElement) {
    projectSettingsReturnFocusRef.current = returnFocusElement;
    if (targetProject?.id && targetProject.id !== project.id) {
      setProjectPaneOpen(false);
      setCanvasDiscussionSplit(false);
      setSelectedCanvasDocument(null);
      setProject(targetProject);
      setMissions(targetProject.missions ?? []);
      setMission(null);
      setActiveTab("Mission");
    }
    setProjectGoalInput(targetProject?.goal ?? "");
    setProjectGoalReferenceFilesInput((targetProject?.referenceFiles ?? []).join("\n"));
    setProjectGoalError("");
    setProjectSettingsSection(section);
    setProjectSettingsOpen(true);
  }

  function openProjectCreate(returnFocusElement = document.activeElement) {
    projectCreateReturnFocusRef.current = returnFocusElement;
    setCreateProjectOpen(true);
  }

  function closeProjectCreate() {
    setCreateProjectOpen(false);
    window.requestAnimationFrame(() => {
      const target = projectCreateReturnFocusRef.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
      projectCreateReturnFocusRef.current = null;
    });
  }

  function closeProjectSettings() {
    setProjectSettingsOpen(false);
    window.requestAnimationFrame(() => {
      const target = projectSettingsReturnFocusRef.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
      projectSettingsReturnFocusRef.current = null;
    });
  }

  function openWorkspaceSettings(section = "workspace", modelId = null) {
    setWorkspaceSettingsSection(section);
    setWorkspaceSettingsModelId(modelId);
    setWorkspaceSettingsOpen(true);
  }

  function closeWorkspaceSettings() {
    setWorkspaceSettingsOpen(false);
    setWorkspaceSettingsModelId(null);
  }

  function openProjectGoalEditor(targetProject = project) { openProjectSettings(targetProject, "guidance"); }

  async function saveProjectGoal(event) {
    event.preventDefault();
    if (!project.id || !projectGoalInput.trim()) return;
    try {
      const { project: updated } = await runtime.updateProjectGoal(project.id, mission?.id ?? "", projectGoalInput.trim(), parseReferenceFiles(projectGoalReferenceFilesInput));
      setProject(updated);
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      setProjectSettingsOpen(false);
      notify("Project goal saved");
    } catch (error) {
      setProjectGoalError(error.message || "Project goal could not be saved");
    }
  }

  async function chooseProjectReferenceFiles(repositoryPath, setReferenceFiles = setNewProjectReferenceFiles) {
    if ((!window.__TAURI_INTERNALS__ && !window.tribeDesktop) || !repositoryPath.trim()) return;
    try {
      const options = { defaultPath: repositoryPath.trim(), multiple: true, title: "Choose project reference files" };
      const selected = window.tribeDesktop
        ? await window.tribeDesktop.openDialog(options)
        : await (await import("@tauri-apps/plugin-dialog")).open(options);
      if (!selected) return;
      const root = repositoryPath.trim().replace(/[\\/]+$/, "").replaceAll("\\", "/");
      const paths = (Array.isArray(selected) ? selected : [selected]).map((path) => {
        const normalised = path.replaceAll("\\", "/");
        if (!normalised.startsWith(`${root}/`)) {
          throw new Error("Choose files inside the selected repository.");
        }
        return normalised.slice(root.length + 1);
      });
      setReferenceFiles((current) => [...new Set([...parseReferenceFiles(current), ...paths])].join("\n"));
    } catch (error) {
      setSettingsError(error.message || "Reference files could not be selected.");
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    setSettingsError("");
    try {
      const { agents: status } = await runtime.configureAgents(modelInput, apiKeyInput, modelBaseUrlInput);
      setAgentRuntime(status);
      setAgents((current) => current.map((agent) => ({ ...agent,
        status: status.enabled ? "Ready" : "Not configured",
        next: status.enabled ? "Ready for the next task" : status.error ?? "Connect a model to start this agent",
      })));
      setApiKeyInput("");
      setSettingsOpen(false);
      setMcpSecretValues({});
      notify(status.enabled ? "Model connected. Agents are ready to work." : status.error ?? "Settings saved.");
    } catch (error) {
      setSettingsError(error.message);
    }
  }

  async function setWorkspaceDefaultModel(model, baseUrl = "") {
    try {
      const { agents: status } = await runtime.configureAgents(model, "", baseUrl);
      setAgentRuntime(status);
      setAgents((current) => current.map((agent) => ({ ...agent,
        status: status.enabled ? "Ready" : "Not configured",
        next: status.enabled ? "Ready for the next task" : status.error ?? "Connect a model to start this agent",
      })));
      notify(status.enabled ? "Workspace default model changed. Agents are ready to work." : status.error ?? "Workspace default model saved.");
      return true;
    } catch (error) {
      notify(`Workspace default model could not be changed: ${error.message}`);
      return false;
    }
  }

  function changeModelProvider(provider) {
    const separator = modelInput.indexOf(":");
    const modelName = separator < 0 ? modelInput : modelInput.slice(separator + 1);
    setModelInput(`${provider}:${modelName}`);
    setApiKeyInput("");
    setModelBaseUrlInput("");
    setProviderModels(null);
  }

  function changeModelName(modelName) {
    const provider = modelProvider(modelInput) || "openai";
    setModelInput(`${provider}:${modelName}`);
  }

  async function discoverAvailableModels() {
    const provider = modelProvider(modelInput) || "openai";
    setProviderModelsDiscovering(true);
    setSettingsError("");
    try {
      const { models } = await runtime.listProviderModels(provider, apiKeyInput, modelBaseUrlInput);
      let savedCatalog = [];
      try { ({ models: savedCatalog = [] } = await runtime.getModelCatalog()); } catch { /* Discovery should still work if saved metadata is unavailable. */ }
      const savedById = new Map(savedCatalog.map((model) => [model.id, model]));
      const modelOptions = models.map((model) => {
        const saved = savedById.get(`${provider}:${model.id}`);
        return { ...model, displayName: saved?.displayName, providerModelId: model.id, provider, id: `${provider}:${model.id}`, allowed: saved?.allowed ?? false };
      });
      const ordered = sortModelCatalog(modelOptions, modelInput);
      setProviderModels(ordered.map((model) => ({ ...model, id: model.providerModelId })));
      if (models.length === 0) setSettingsError("The provider returned no available models.");
    } catch (error) {
      setProviderModels([]);
      const messages = {
        ollama_unavailable: "Ollama was not found on this device. Start Ollama, then try again.",
        provider_model_discovery_unsupported: "This provider does not expose a compatible model list. Enter a model ID below.",
        provider_models_unauthorized: "The provider rejected this key. Check it and try again.",
        provider_models_unavailable: "Could not reach the provider. Check the service URL and try again.",
        provider_models_invalid_response: "The provider returned an unsupported model list. Enter a model ID below.",
      };
      setSettingsError(messages[error.message] ?? `Could not find models: ${error.message}`);
    } finally {
      setProviderModelsDiscovering(false);
    }
  }

  async function openAgentSettings(mode = "model", presetModel = null, presetBaseUrl = null, presetApiKey = "") {
    setSettingsMode(mode);
    setModelInput(presetModel ?? agentRuntime.model ?? "");
    setModelBaseUrlInput(presetBaseUrl ?? agentRuntime.baseUrl ?? "");
    setApiKeyInput(presetApiKey);
    setProviderModels(null);
    setSettingsError("");
    setMcpConfigInput('{\n  "mcpServers": {}\n}');
    setMcpSavedConfig('{\n  "mcpServers": {}\n}');
    setMcpChecks({});
    setMcpOAuthStatuses({});
    setMcpSecretStatus({});
    setMcpSecretValues({});
    setSettingsOpen(true);
    if (!project.id) return;
    try {
      const { config, secretStatus } = await runtime.getMcpConfig(project.id);
      const serialisedConfig = JSON.stringify(config, null, 2);
      setMcpConfigInput(serialisedConfig);
      setMcpSavedConfig(serialisedConfig);
      setMcpSecretStatus(secretStatus ?? {});
      setMcpSecretValues({});
      const oauthServers = Object.entries(config.mcpServers ?? {}).filter(([, definition]) => definition.oauth);
      const statuses = await Promise.all(oauthServers.map(async ([name]) => {
        try { return [name, await runtime.mcpOAuthStatus(project.id, name)]; }
        catch { return [name, { state: "needs_sign_in" }]; }
      }));
      setMcpOAuthStatuses(Object.fromEntries(statuses));
    } catch (error) {
      setSettingsError(`Could not load MCP servers: ${error.message}`);
    }
  }

  function closeAgentSettings() {
    setSettingsOpen(false);
    setMcpSecretValues({});
  }

  async function addRemoteMcpServer({ serviceKey, endpoint, authMode, oauthScopes, headerName, headerValue, credentialName }) {
    if (!project.id || mcpSaving) return false;
    let config;
    try {
      config = JSON.parse(mcpConfigInput);
    } catch {
      setSettingsError("Fix the advanced connection settings before adding a service.");
      return false;
    }
    const servers = config?.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      setSettingsError("The connection settings must contain an mcpServers object.");
      return false;
    }
    if (Object.keys(servers).length >= 50) {
      setSettingsError("This project has reached the 50 service limit.");
      return false;
    }
    if (Object.hasOwn(servers, serviceKey)) {
      setSettingsError("A service with that name already exists.");
      return false;
    }
    const definition = { url: endpoint };
    if (authMode === "oauth") definition.oauth = { scopes: oauthScopes };
    if (headerValue) definition.headers = { [headerName]: "${" + credentialName + "}" };
    const nextConfig = { ...config, mcpServers: { ...servers, [serviceKey]: definition } };
    setMcpSaving(true);
    setSettingsError("");
    let configSaved = false;
    try {
      const response = await runtime.saveMcpConfig(project.id, nextConfig);
      configSaved = true;
      const serialisedConfig = JSON.stringify(response.config, null, 2);
      setMcpConfigInput(serialisedConfig);
      setMcpSavedConfig(serialisedConfig);
      setMcpSecretStatus(response.secretStatus ?? {});
      setMcpChecks((current) => ({ ...current, [serviceKey]: null }));
      if (authMode === "oauth") setMcpOAuthStatuses((current) => ({ ...current, [serviceKey]: { state: "needs_sign_in" } }));
      if (headerValue) {
        const saved = await runtime.saveMcpSecrets(project.id, { [credentialName]: headerValue });
        setMcpSecretStatus(saved.secretStatus ?? {});
      }
      setMcpSecretValues({});
      notify(authMode === "oauth"
        ? "Service added. Sign in and check its connection to make tools available."
        : "Service added. Check its connection to see available tools.");
      return true;
    } catch (error) {
      setSettingsError(configSaved
        ? "The service was added, but its access token could not be saved securely. The token is ready below; save it under Server credentials."
        : error.message);
      if (configSaved && headerValue && credentialName) {
        setMcpSecretValues((current) => ({ ...current, [credentialName]: headerValue }));
        return true;
      }
      return false;
    } finally {
      setMcpSaving(false);
    }
  }

  async function saveMcpConfig(configOverride = null) {
    if (!project.id) return;
    setSettingsError("");
    let config;
    try {
      config = configOverride ?? JSON.parse(mcpConfigInput);
    } catch {
      setSettingsError("MCP configuration must be valid JSON.");
      return;
    }
    setMcpSaving(true);
    try {
      const response = await runtime.saveMcpConfig(project.id, config);
      const serialisedConfig = JSON.stringify(response.config, null, 2);
      setMcpConfigInput(serialisedConfig);
      setMcpSavedConfig(serialisedConfig);
      setMcpSecretStatus(response.secretStatus ?? {});
      setMcpSecretValues({});
      notify("Tool connections saved. Changes apply on the next agent turn.");
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setMcpSaving(false);
    }
  }

  async function installPlaywrightBrowser() {
    if (!project.id) return;
    setMcpSaving(true);
    setSettingsError("");
    try {
      const response = await runtime.installPlaywrightBrowser(project.id);
      const serialisedConfig = JSON.stringify(response.config, null, 2);
      setMcpConfigInput(serialisedConfig);
      setMcpSavedConfig(serialisedConfig);
      setMcpSecretStatus(response.secretStatus ?? {});
      notify("Playwright browser tools added · they start on the next agent turn");
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setMcpSaving(false);
    }
  }

  async function checkMcpServer(serverName) {
    if (!project.id || mcpConfigInput !== mcpSavedConfig) return;
    const isOAuth = Boolean(mcpServerEntries(mcpConfigInput).find(([name]) => name === serverName)?.[1]?.oauth);
    setMcpChecks((current) => ({ ...current, [serverName]: { ...(current[serverName] ?? {}), loading: true, error: "" } }));
    try {
      const result = await runtime.checkMcpServer(project.id, serverName);
      setMcpChecks((current) => ({ ...current, [serverName]: { loading: false, tools: result.tools, preflight: result.preflight, error: "" } }));
      if (isOAuth) {
        setMcpOAuthStatuses((current) => ({ ...current, [serverName]: { state: "connected" } }));
      }
    } catch (error) {
      setMcpChecks((current) => ({ ...current, [serverName]: { loading: false, tools: null, error: error.message } }));
      if (isOAuth) {
        setMcpOAuthStatuses((current) => ({ ...current, [serverName]: { state: "needs_sign_in" } }));
      }
    }
  }

  async function installPlaywrightChromium() {
    if (!project.id || mcpBrowserInstall[project.id]?.loading) return;
    const projectId = project.id;
    setMcpBrowserInstall((current) => ({ ...current, [projectId]: { loading: true, installed: false, error: "" } }));
    try {
      await runtime.installPlaywrightChromium(projectId);
      setMcpBrowserInstall((current) => ({ ...current, [projectId]: { loading: false, installed: true, error: "" } }));
    } catch (error) {
      setMcpBrowserInstall((current) => ({ ...current, [projectId]: { loading: false, installed: false, error: error.message } }));
    }
  }

  async function forgetMcpOAuth(serverName) {
    if (!project.id || mcpSaving) return;
    setMcpSaving(true);
    setSettingsError("");
    try {
      const status = await runtime.forgetMcpOAuth(project.id, serverName);
      setMcpOAuthStatuses((current) => ({ ...current, [serverName]: status }));
      setMcpChecks((current) => ({ ...current, [serverName]: null }));
      notify("Service sign-in removed from this device.");
    } catch (error) {
      setSettingsError(`Could not remove service sign-in: ${error.message}`);
    } finally {
      setMcpSaving(false);
    }
  }

  function updateMcpServer(serverName, update) {
    try {
      const config = JSON.parse(mcpConfigInput);
      const current = config.mcpServers?.[serverName];
      if (!current) return;
      config.mcpServers[serverName] = update(current);
      setMcpConfigInput(JSON.stringify(config, null, 2));
    } catch {
      setSettingsError("Fix the advanced connection settings before changing these tools.");
    }
  }

  async function saveMcpSecrets() {
    if (!project.id) return;
    const secrets = Object.fromEntries(Object.entries(mcpSecretValues).filter(([, value]) => value));
    if (!Object.keys(secrets).length) return;
    setMcpSaving(true);
    setSettingsError("");
    try {
      const { secretStatus } = await runtime.saveMcpSecrets(project.id, secrets);
      setMcpSecretStatus(secretStatus);
      setMcpSecretValues({});
      notify("Tool credentials saved securely.");
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setMcpSaving(false);
    }
  }

  async function forgetMcpSecret(name) {
    if (!project.id) return;
    setMcpSaving(true);
    setSettingsError("");
    try {
      const { secretStatus } = await runtime.saveMcpSecrets(project.id, { [name]: "" });
      setMcpSecretStatus(secretStatus);
      setMcpSecretValues((current) => ({ ...current, [name]: "" }));
      notify(`${name} credentials removed.`);
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setMcpSaving(false);
    }
  }

  async function saveKnowledge(title, content) {
    try {
      const { entry } = await runtime.saveKnowledge(project.id, mission?.id ?? null, title, content);
      setKnowledge((current) => current.some((item) => item.id === entry.id)
        ? current.map((item) => item.id === entry.id ? entry : item)
        : [...current, entry]);
      notify("Project memory saved");
      return true;
    } catch (error) {
      notify(`Knowledge was not saved: ${error.message}`);
      return false;
    }
  }

  async function reviewKnowledgeProposal(proposalId, decision) {
    try {
      const { proposal, entry } = await runtime.reviewKnowledgeProposal(proposalId, decision);
      setKnowledgeProposals((current) => current.map((item) => item.id === proposal.id ? proposal : item));
      if (entry) setKnowledge((current) => current.some((item) => item.id === entry.id)
        ? current.map((item) => item.id === entry.id ? entry : item) : [...current, entry]);
      notify(decision === "accept" ? "Added to project memory." : "Suggestion dismissed.");
    } catch (error) {
      notify(`Memory proposal could not be reviewed: ${error.message}`);
    }
  }

  async function resolveKnowledgeMigration(entryId, decision) {
    try {
      const { migration } = await runtime.resolveKnowledgeMigration(project.id, entryId, decision);
      setKnowledgeMigration(migration);
      if (decision !== "keep_smriti") {
        const { knowledge: entries } = await runtime.listKnowledge(project.id);
        setKnowledge(entries);
      }
      notify(decision === "keep_smriti"
        ? "Kept the Smriti version; review recorded."
        : decision === "copy_legacy_to_project"
          ? "Copied the saved version into this project's memory."
          : "Imported the Tribe version into project memory.");
    } catch (error) {
      notify(`Memory conflict could not be resolved: ${error.message}`);
    }
  }

  async function archiveKnowledge(entryId) {
    if (!mission) return;
    try {
      const { entry } = await runtime.archiveKnowledge(entryId, mission.id);
      setKnowledge((current) => current.map((item) => item.id === entry.id ? entry : item));
      notify("Project memory archived.");
    } catch (error) {
      notify(`Project memory could not be archived: ${error.message}`);
    }
  }

  async function restoreKnowledge(entryId) {
    if (!mission) return;
    try {
      const { entry } = await runtime.restoreKnowledge(entryId, mission.id);
      setKnowledge((current) => current.map((item) => item.id === entry.id ? entry : item));
      notify("Project memory restored.");
    } catch (error) {
      notify(`Project memory could not be restored: ${error.message}`);
    }
  }

  async function saveUsageBudget(monthlyTokensLimit, maxRunCostUsd, maxRunTokens) {
    if (!project.id) return;
    try {
      await runtime.setUsageBudget(project.id, monthlyTokensLimit, maxRunCostUsd, maxRunTokens);
      const result = await runtime.getUsage(project.id);
      setUsage(result.usage);
      notify(monthlyTokensLimit == null && maxRunCostUsd == null ? "Usage limits removed" : "Usage limits saved");
    } catch (error) {
      notify(`Budget was not saved: ${error.message}`);
    }
  }

  async function exportBackup() {
    const { blob, filename } = await runtime.exportBackup();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Workspace backup downloaded");
  }

  async function importBackup(file) {
    return runtime.importBackup(file);
  }

  async function exportProjectAudit() {
    if (!project.id) throw new Error("Choose a project before exporting its history");
    const { blob, filename } = await runtime.exportProjectAudit(project.id);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Project history downloaded");
  }

  async function resolveInteraction(decision, accessScope = null) {
    if (!activeInteraction) return;
    const resolution = activeInteraction.type === "approval"
      ? decision === "Approved once" ? "approved_once" : "denied"
      : `answered: ${decision}`;
    try {
      const { interaction } = await runtime.resolveInteraction(activeInteraction.id, resolution, accessScope);
      if (interaction.event) applyEvent(interaction.event);
      if (interaction.unblocked_event) applyEvent(interaction.unblocked_event);
      refreshPendingRequests();
      notify(activeInteraction.type === "approval"
        ? resolution === "denied" ? "Action declined."
          : accessScope === "chat" ? "Public web access allowed for this chat."
            : accessScope === "project" ? "Public web access allowed for this project."
              : accessScope === "workspace" ? "Public web access allowed across this workspace."
                : "Action approved once."
        : `Answer sent to ${activeInteraction.agent}.`);
    } catch (error) {
      notify(`Decision was not saved: ${error.message}`);
    }
  }

  async function reviewMissionOutcome(outcome, notes) {
    if (!mission?.id) return false;
    try {
      const { event } = await runtime.reviewMissionOutcome(mission.id, outcome, notes);
      applyEvent(event);
      notify("Chat outcome saved.");
      return true;
    } catch (error) {
      notify(`Outcome was not saved: ${error.message}`);
      return false;
    }
  }

  async function discardIsolation(workspace) {
    const agentName = agents.find((agent) => agent.id === workspace.agent_id)?.name ?? workspace.agent_id;
    const pendingApproval = workspace.state === "pending_approval";
    const accepted = await requestConfirmation({
      eyebrow: "Discard isolated work",
      title: `Discard ${agentName}’s work?`,
      message: "Any changes not integrated into the project will be lost.",
      detail: `Target: ${workspace.path}${pendingApproval ? " · The pending integration approval will also be cancelled." : ""}`,
      confirmLabel: "Discard work",
      tone: "danger",
    });
    if (!accepted || !mission) return;
    try {
      await runtime.discardIsolatedWork(mission.id, workspace.agent_id);
      setIsolatedWorkspaces((current) => current.filter((item) => item.agent_id !== workspace.agent_id));
      notify(`Discarded ${agentName}'s isolated work`);
    } catch (error) {
      notify(error.message || "Could not discard isolated work");
    }
  }

  function activateInteraction(id) {
    setInteractions((current) => {
      const selectedIndex = current.findIndex((item) => item.id === id);
      if (selectedIndex <= 0) return current;
      return [current[selectedIndex], ...current.filter((item) => item.id !== id)];
    });
  }

  async function selectArtifact(artifactOrId) {
    if (!artifactOrId) {
      openProjectSettings(project, "artifacts");
      return;
    }
    const artifact = typeof artifactOrId === "string"
      ? artifacts.find((item) => item.id === artifactOrId)
      : artifactOrId;
    if (!artifact) return;
    setSelectedArtifact({ ...artifact, preview: undefined, previewDataUrl: undefined });
    if (projectPaneOpen || (mission && isMissionTab)) chooseSecondaryPane("Preview");
    else setActiveTab("Code");
    const extension = artifact.name.split(".").pop()?.toLowerCase();
    if (extension === "xlsx" || artifact.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return;
    const isPdf = extension === "pdf" || artifact.type?.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
    if (isPdf) return;
    if (playableMediaKind(artifact.type)) return;
    try {
      const { contentBase64 } = await runtime.getArtifact(artifact.id);
      const bytes = Uint8Array.from(atob(contentBase64), (character) => character.charCodeAt(0));
      const extension = artifact.name.split(".").pop()?.toLowerCase();
      const textExtensions = new Set(["md", "txt", "json", "yaml", "yml", "log", "diff", "patch", "csv", "tsv", "js", "jsx", "ts", "tsx", "py", "rs", "html", "css", "xml", "toml", "sql", "sh"]);
      if (artifact.type.startsWith("text/") || textExtensions.has(extension)) {
        const content = new TextDecoder().decode(bytes);
        const isDelimited = extension === "csv" || extension === "tsv"
          || artifact.type === "text/csv" || artifact.type === "application/csv" || artifact.type === "text/tab-separated-values";
        setSelectedArtifact({
          ...artifact,
          preview: content.length > 100_000 ? `${content.slice(0, 100_000)}\n\n[Preview truncated]` : content,
          previewTruncated: content.length > 100_000,
          tableText: isDelimited ? content : undefined,
          tableDelimiter: extension === "tsv" || artifact.type === "text/tab-separated-values" ? "\t" : ",",
        });
      } else {
        setSelectedArtifact({
          ...artifact,
          preview: undefined,
          previewDataUrl: inlineImagePreview(artifact.type, contentBase64) ?? undefined,
        });
      }
    } catch (error) {
      notify(`Artifact could not be opened: ${error.message}`);
    }
  }

  async function prepareSpreadsheetSelection({ artifact, sheet, range, text }) {
    if (!artifact?.missionId) {
      notify("This workbook is not linked to a chat, so its selection cannot be sent.");
      return;
    }
    if (artifact.missionId !== mission?.id) {
      const opened = await selectMission(artifact.missionId, project);
      if (!opened) return;
    }
    setComposerDraft({
      token: `${Date.now()}-${Math.random()}`,
      text: `Analyse these selected spreadsheet cells.\n\nSource workbook: ${artifact.name}\nWorksheet: ${sheet}\nRange: ${range}\n\n${text}`,
      attachments: [{ id: artifact.id, name: artifact.name, mediaType: artifact.type, size: artifact.size }],
    });
    setActiveTab("Mission");
  }

  async function onArtifactSaved(result) {
    const mapped = mapArtifact(result.artifact);
    setArtifacts((current) => [mapped, ...current.filter((item) => item.id !== mapped.id)]);
    if (result.event) applyEvent(result.event);
    await selectArtifact(mapped);
    notify(`Saved ${mapped.name} as a new artifact.`);
  }

  async function createCanvasDocument() {
    if (!mission?.id) {
      notify("Open a mission before creating a shared document.");
      return;
    }
    try {
      const { document } = await runtime.createCanvasDocument(mission.id);
      const sharedDocument = { ...document, mission_title: mission.title, project_id: project.id, access_mission_id: mission.id };
      setCanvasDocuments((current) => [sharedDocument, ...current.filter((item) => item.id !== document.id)]);
      openCanvasDocument(sharedDocument);
    } catch (error) {
      notify(`Document could not be created: ${error.message}`);
    }
  }

  function openCanvasDocument(document) {
    setSelectedCanvasDocument(document);
    if (projectPaneOpen || (mission && isMissionTab)) chooseSecondaryPane("Preview");
    else if (!canvasDiscussionSplit) setActiveTab("Artifacts");
  }

  async function updateCanvasDocumentLink(document, linked) {
    if (!mission?.id) {
      notify("Choose a chat before linking a document.");
      return;
    }
    if (linkingCanvasDocumentId) return;
    setLinkingCanvasDocumentId(document.id);
    try {
      const result = linked
        ? await runtime.unlinkCanvasDocument(mission.id, document.id)
        : await runtime.linkCanvasDocument(mission.id, document.id);
      if (result.event) applyEvent(result.event);
      const { documents = [] } = await runtime.listMissionCanvasDocuments(mission.id);
      setMissionCanvasDocuments(documents);
      setCanvasRefreshNonce((value) => value + 1);
      notify(linked ? "Document removed from this mission." : "Document linked to this mission.");
    } catch (error) {
      notify(`Document link could not be updated: ${error.message}`);
    } finally {
      setLinkingCanvasDocumentId(null);
    }
  }

  async function discussCanvasDocument(context) {
    if (context.missionId !== mission?.id) {
      const opened = await selectMission(context.missionId);
      if (!opened) return;
    }
    setComposerDraft({
      token: `${Date.now()}-${Math.random()}`,
      text: "Please help me with this document: ",
      canvasDocument: context,
    });
    setSelectedCanvasDocument((current) => current ? { ...current, revision: context.revision } : current);
    setCanvasDiscussionSplit(true);
    setProjectPaneOpen(false);
    setActiveTab("Mission");
  }

  async function loadMoreProjectArtifacts() {
    if (!project.id || !artifactCursor || !artifactHasMore || artifactLoadingMore) return;
    const version = artifactQueryVersionRef.current;
    setArtifactLoadingMore(true);
    setArtifactError("");
    try {
      const page = await runtime.listProjectArtifacts(project.id, {
        query: artifactSearch, cursor: artifactCursor, limit: 50,
      });
      if (version !== artifactQueryVersionRef.current) return;
      setProjectArtifacts((current) => {
        const seen = new Set(current.map((artifact) => artifact.id));
        return [...current, ...page.artifacts.map(mapArtifact).filter((artifact) => !seen.has(artifact.id))];
      });
      setArtifactCursor(page.nextCursor);
      setArtifactTotal(page.total);
      setArtifactHasMore(page.hasMore);
    } catch (error) {
      if (version === artifactQueryVersionRef.current) setArtifactError(error.message);
    } finally {
      if (version === artifactQueryVersionRef.current) setArtifactLoadingMore(false);
    }
  }

  function attachFile(onAttached) {
    pendingAttachmentCallbackRef.current = onAttached;
    fileInputRef.current?.click();
  }

  async function handleFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!mission) return;
    event.target.value = "";
    if (file.size > 10_000_000) {
      notify("Files must be smaller than 10 MB");
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let start = 0; start < bytes.length; start += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
      }
      const { artifact, event: createdEvent } = await runtime.uploadArtifact(mission.id, file.name, file.type, btoa(binary));
      const mapped = mapArtifact(artifact);
      setArtifacts((current) => current.some((item) => item.id === mapped.id) ? current : [mapped, ...current]);
      applyEvent(createdEvent);
      pendingAttachmentCallbackRef.current?.({
        id: mapped.id, name: mapped.name, mediaType: mapped.type, size: file.size,
      });
      notify(`Added ${file.name} to this mission.`);
    } catch (error) {
      notify(`Artifact was not saved: ${error.message}`);
    } finally {
      pendingAttachmentCallbackRef.current = null;
    }
  }

  function selectWork(item) {
    setActiveWork(item);
  }

  async function stopBackgroundCommand(runId) {
    try {
      await runtime.stopCommand(runId);
      const { runs: current } = await runtime.listCommands(mission.id);
      setCommandRuns(current);
    } catch (error) {
      notify(`Command could not stop: ${error.message}`);
    }
  }

  async function refreshScheduleLists(projectId) {
    const [current, all] = await Promise.all([
      runtime.listSchedules(projectId), runtime.listSchedules(),
    ]);
    if (project.id === projectId) setSchedules(current.schedules);
    setWorkspaceSchedules(all.schedules);
  }

  async function createSchedule(projectId, title, prompt, cadence, deliveryTime, runAt, cronExpression, targetMissionId) {
    try {
      await runtime.createSchedule(projectId, title, prompt, cadence,
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", deliveryTime, runAt, cronExpression, targetMissionId);
      await refreshScheduleLists(projectId);
      notify("Schedule created.");
      return true;
    } catch (error) {
      notify(`Schedule could not be saved: ${error.message}`);
      return false;
    }
  }

  async function editSchedule(projectId, id, title, prompt, cadence, timezone, deliveryTime, runAt, cronExpression, targetMissionId) {
    try {
      await runtime.editSchedule(projectId, id, title, prompt, cadence, timezone, deliveryTime, runAt, cronExpression, targetMissionId);
      await refreshScheduleLists(projectId);
      notify("Schedule updated.");
      return true;
    } catch (error) {
      notify(`Schedule could not be updated: ${error.message}`);
      return false;
    }
  }

  async function updateSchedule(projectId, id, action) {
    try {
      await runtime.updateSchedule(projectId, id, action);
      await refreshScheduleLists(projectId);
      notify(action === "run-now" ? "Chat started from schedule." : `Schedule ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"}.`);
    } catch (error) { notify(`Schedule could not be updated: ${error.message}`); }
  }

  async function loadScheduleRuns(id, beforeStartedAt, beforeId, limit) {
    return runtime.getScheduleRuns(id, beforeStartedAt, beforeId, limit);
  }

  async function saveWorkflowRecipe(recipe) {
    const result = await runtime.saveRecipe(recipe);
    const refreshed = await runtime.listRecipes();
    setRecipes(refreshed.recipes);
    notify(`Saved ${result.recipe.title} · version ${result.recipe.version}`);
    return result.recipe;
  }

  async function saveWebAccess(enabled, allowedDomains) {
    if (!project.id) return;
    try {
      const result = await runtime.setWebAccess(project.id, enabled, allowedDomains);
      setWebAccess(result.webAccess);
      notify("Project web research policy saved");
    } catch (error) {
      notify(`Web research policy was not saved: ${error.message}`);
      throw error;
    }
  }

  async function saveComputerAccess(enabled) {
    if (!project.id) return;
    const result = await runtime.setComputerAccess(project.id, enabled);
    setComputerAccess(result.computerAccess);
    notify(enabled ? "Agents can request window observations" : "Computer use turned off for this project");
  }

  async function saveInteractiveAccess(enabled) {
    if (!project.id) return;
    const result = await runtime.setInteractiveAccess(project.id, enabled);
    setInteractiveAccess(result.interactiveAccess);
    notify(enabled ? "Interactive apps enabled for this project" : "Interactive apps turned off for this project");
  }

  function renderMissionView() {
    if (selectedGeneralChat) return <GeneralChatView chat={selectedGeneralChat} getModelCatalog={runtime.getModelCatalog} onModelPreferenceChange={setGeneralChatModelPreference} onSend={sendGeneralChatMessage} onConnectModel={() => openWorkspaceSettings("models")} onOpenWebSearch={() => openWorkspaceSettings("web-search")} />;
    if (!mission) return <ProjectHomeView agentConfigured={agentRuntime.enabled} agents={projectAgents} workspaceModel={agentRuntime.model} onConnectModel={() => openWorkspaceSettings("models")} onCreateMission={createMission} onEditProjectGoal={openProjectGoalEditor} onManageModelMetadata={(modelId) => openWorkspaceSettings("models", modelId)} onManageTeam={() => openProjectSettings(project, "team")} onSelectMission={selectMission} project={project} missions={missions} recipes={recipes} skills={skills} />;
    return <MissionView
      mission={mission}
      interactiveResponsesEnabled={interactiveAccess.enabled}
      onShareInteractiveAction={(artifactId, recipient, action, data) => runtime.shareInteractiveAction(mission.id, artifactId, recipient, action, data).then(() => notify("App result shared with the agent"))}
      activeInteraction={activeInteraction}
      runtimeStatus={runtimeStatus}
      workspaceModel={agentRuntime.model}
      agents={projectAgents}
      agentDefinitions={agents}
      artifacts={artifacts}
      messages={conversationMessages}
      onOpenAgentActivity={openAgentActivity}
      query={query}
      hasOlderEvents={hasOlderEvents}
      loadingOlderEvents={loadingOlderEvents}
      onLoadOlderEvents={loadOlderEvents}
      onActivateInteraction={activateInteraction}
      onAttach={attachFile}
      onResolve={resolveInteraction}
      onSelectArtifact={selectArtifact}
      onOpenCanvas={(reference) => openCanvasDocument({
        id: reference.artifactId, mission_id: mission.id, mission_title: mission.title,
        access_mission_id: mission.id, project_id: project.id, revision: reference.revision,
      })}
      composerDraft={composerDraft}
      onComposerDraftConsumed={(token) => setComposerDraft((current) => current?.token === token ? null : current)}
      onSend={sendMessage}
      onSaveModelPreferences={saveMissionModelPreferences}
      onConnectModel={() => openWorkspaceSettings("models")}
      onManageModelMetadata={(modelId) => openWorkspaceSettings("models", modelId)}
      onManageTeam={() => openProjectSettings(project, "team")}
      onOpenUsageSettings={() => openWorkspaceSettings("data")}
      onRecoverAgent={recoverAgentRun}
      onStopAgentRun={stopAgentRun}
      queuedInteractions={queuedInteractions}
      isolatedWorkspaces={isolatedWorkspaces}
      onDiscardIsolation={discardIsolation}
      onReviewOutcome={reviewMissionOutcome}
      workItems={workItemsState}
    />;
  }

  function renderProjectTool(tab, paneVisible = true) {
    if (tab === "Browser") return <BrowserView onStateChange={handleBrowserWorkspaceState} projects={projects} visible={paneVisible && !createProjectOpen && !projectSettingsOpen && !settingsOpen && !workspaceSettingsOpen && !confirmation} />;
    if (tab === "Activity") return <AgentActivityView
      agents={projectAgents}
      messages={executionMessages}
      missionId={mission?.id}
      hasOlderEvents={hasOlderEvents}
      loadingOlderEvents={loadingOlderEvents}
      onLoadOlderEvents={loadOlderEvents}
    />;
    if (tab === "Plan") return <PlanView agents={projectAgents} project={project} mission={mission} agentConfigured={agentRuntime.enabled} workItems={workItemsState} onSelectWork={selectWork} onEditProjectGoal={openProjectGoalEditor} onConnectModel={() => openAgentSettings("model")} />;
    if (tab === "Tests") return <TestRunsView runs={runs} />;
    if (tab === "Runs") return <RunsView agentRequests={agentRequests} mission={mission} onStop={stopBackgroundCommand} runs={commandRuns} />;
    if (tab === "Code") return <RepositoryView artifact={selectedArtifact} missionId={selectedArtifact?.missionId ?? mission?.id} agents={agents} project={project} reviewRevision={artifactReviewRevision} onArtifactSaved={onArtifactSaved} onUseSpreadsheetSelection={prepareSpreadsheetSelection} onBrowseRepository={() => { setSelectedArtifact(null); setSelectedCanvasDocument(null); }} />;
    if (tab === "Browser") return <Suspense fallback={<div className="tab-panel column-empty">Opening browser…</div>}><BrowserView agents={projectAgents} mission={mission} onOpenWebsiteSettings={() => openWorkspaceSettings("connections")} /></Suspense>;
    if (tab === "Git") return <GitChangesView project={project} />;
    if (tab === "Preview" && selectedCanvasDocument) return <ViewErrorBoundary backLabel="Back to artifacts" key={`preview:${selectedCanvasDocument.id}`} onBack={() => { setSelectedCanvasDocument(null); chooseSecondaryPane("Artifacts"); }} title="Document preview couldn't be opened"><Suspense fallback={<div className="tab-panel column-empty">Opening shared document…</div>}><CanvasView
      document={selectedCanvasDocument}
      refreshKey={canvasRefreshNonce}
      requestConfirmation={requestConfirmation}
      onBack={() => setSelectedCanvasDocument(null)}
      onDiscuss={(reference) => void discussCanvasDocument({ ...reference, missionId: selectedCanvasDocument.access_mission_id ?? selectedCanvasDocument.mission_id })}
    /></Suspense></ViewErrorBoundary>;
    if (tab === "Preview" && selectedArtifact) return <RepositoryView artifact={selectedArtifact} missionId={selectedArtifact?.missionId ?? mission?.id} agents={agents} project={project} reviewRevision={artifactReviewRevision} onArtifactSaved={onArtifactSaved} onUseSpreadsheetSelection={prepareSpreadsheetSelection} onBrowseRepository={() => { setSelectedArtifact(null); setProjectPaneTab("Code"); }} />;
    if (tab === "Preview") return <div className="project-preview-empty"><FileText size={22} /><strong>No preview selected</strong><span>Select a file in Project artifacts to view it beside the chat.</span></div>;
    if (tab === "Schedules") return <SchedulesView agentsConfigured={agentRuntime.enabled} project={project} schedules={schedules} onCreate={createSchedule} onEdit={editSchedule} onAction={updateSchedule} onLoadMoreRuns={loadScheduleRuns} />;
    if (tab === "Knowledge") return <ProjectKnowledgeView entries={knowledge} proposals={knowledgeProposals} migration={knowledgeMigration} onResolveMigration={resolveKnowledgeMigration} onSave={saveKnowledge} onReview={reviewKnowledgeProposal} onArchive={archiveKnowledge} onRestore={restoreKnowledge} />;
    if (tab === "Artifacts" && selectedCanvasDocument && !projectPaneOpen) return <ViewErrorBoundary backLabel="Back to artifacts" key={`artifacts:${selectedCanvasDocument.id}`} onBack={() => setSelectedCanvasDocument(null)} title="Document preview couldn't be opened"><Suspense fallback={<div className="tab-panel column-empty">Opening shared document…</div>}><CanvasView
      document={selectedCanvasDocument}
      refreshKey={canvasRefreshNonce}
      requestConfirmation={requestConfirmation}
      onBack={() => setSelectedCanvasDocument(null)}
      onDiscuss={(reference) => void discussCanvasDocument({ ...reference, missionId: selectedCanvasDocument.access_mission_id ?? selectedCanvasDocument.mission_id })}
    /></Suspense></ViewErrorBoundary>;
    if (tab === "Artifacts") return <ArtifactsView
      artifacts={projectArtifacts}
      canvasDocuments={canvasDocuments}
      total={artifactTotal}
      query={artifactSearch}
      loading={artifactLoading}
      loadingMore={artifactLoadingMore}
      hasMore={artifactHasMore}
      error={artifactError}
      onQueryChange={setArtifactSearch}
      onLoadMore={loadMoreProjectArtifacts}
      onRefresh={() => setArtifactRefreshNonce((value) => value + 1)}
      onSelectArtifact={selectArtifact}
      onCreateCanvas={createCanvasDocument}
      projectName={project.name}
      missionId={mission?.id}
      linkedCanvasDocumentIds={missionCanvasDocuments.map((document) => document.id)}
      linkingCanvasDocumentId={linkingCanvasDocumentId}
      onToggleCanvasLink={updateCanvasDocumentLink}
      onSelectCanvas={(document) => openCanvasDocument({
        ...document,
        project_id: project.id,
        access_mission_id: mission?.id && missionCanvasDocuments.some((item) => item.id === document.id)
          ? mission.id : document.mission_id,
      })}
    />;
    return null;
  }

  function renderProjectSettingsSection(section) {
    if (section === "team") return <AgentRolesView agents={agents} capabilityCatalog={capabilityCatalog} projectAgentIds={project.agentIds ?? agents.map((agent) => agent.id)} agentConfigured={agentRuntime.enabled} onCreate={(definition) => createAgentDefinition(definition, project.id)} onUpdate={updateAgentDefinition} onArchive={archiveAgentDefinition} onUpdateProjectTeam={updateProjectTeam} onConnectModel={() => openAgentSettings("model")} onManageModels={() => { setProjectSettingsOpen(false); openWorkspaceSettings("models"); }} />;
    if (section === "interactive") return <InteractiveAccessView onSave={saveInteractiveAccess} policy={interactiveAccess} projectName={project.name} />;
    if (section === "guidance") return <form className="project-settings-guidance" onSubmit={saveProjectGoal}>
      <label>Project goal<textarea autoFocus maxLength={10000} onChange={(event) => setProjectGoalInput(event.target.value)} rows={5} value={projectGoalInput} /></label>
      <div className="reference-files-heading"><label htmlFor="project-reference-files">Repository files<small id="project-reference-files-help">One repository-relative path per line.{!window.__TAURI_INTERNALS__ && " In the browser preview, enter paths here; file selection is available in the desktop app."}</small></label><div><IconButton label="Add README.md" onClick={() => setProjectGoalReferenceFilesInput((current) => addReferenceFile(current, "README.md"))}><Plus size={15} /></IconButton>{window.__TAURI_INTERNALS__ && project.repository && <IconButton label="Choose repository files" onClick={() => chooseProjectReferenceFiles(project.repository, setProjectGoalReferenceFilesInput)}><FolderSimple size={15} /></IconButton>}</div></div>
      <textarea aria-describedby="project-reference-files-help" className="project-reference-files" id="project-reference-files" maxLength={2000} onChange={(event) => setProjectGoalReferenceFilesInput(event.target.value)} placeholder={"README.md\nAGENTS.md\ndocs/architecture.md"} rows={3} value={projectGoalReferenceFilesInput} />
      {projectGoalError && <p className="settings-error" role="alert">{projectGoalError}</p>}
      <div className="dialog-actions"><button className="button button--primary" disabled={!projectGoalInput.trim()} type="submit">Save project guidance</button></div>
    </form>;
    if (section === "knowledge") return <ProjectKnowledgeView entries={knowledge} proposals={knowledgeProposals} migration={knowledgeMigration} onResolveMigration={resolveKnowledgeMigration} onSave={saveKnowledge} onReview={reviewKnowledgeProposal} onArchive={archiveKnowledge} onRestore={restoreKnowledge} />;
    if (section === "schedules") return <SchedulesView agentsConfigured={agentRuntime.enabled} project={project} schedules={schedules} onCreate={createSchedule} onEdit={editSchedule} onAction={updateSchedule} onLoadMoreRuns={loadScheduleRuns} />;
    if (section === "artifacts") return <ArtifactsView
      artifacts={projectArtifacts}
      canvasDocuments={canvasDocuments}
      total={artifactTotal}
      query={artifactSearch}
      loading={artifactLoading}
      loadingMore={artifactLoadingMore}
      hasMore={artifactHasMore}
      error={artifactError}
      onQueryChange={setArtifactSearch}
      onLoadMore={loadMoreProjectArtifacts}
      onRefresh={() => setArtifactRefreshNonce((value) => value + 1)}
      onSelectArtifact={(artifact) => { setProjectSettingsOpen(false); void selectArtifact(artifact); }}
      onCreateCanvas={createCanvasDocument}
      projectName={project.name}
      missionId={mission?.id}
      linkedCanvasDocumentIds={missionCanvasDocuments.map((document) => document.id)}
      linkingCanvasDocumentId={linkingCanvasDocumentId}
      onToggleCanvasLink={updateCanvasDocumentLink}
      onSelectCanvas={(document) => { setProjectSettingsOpen(false); openCanvasDocument({ ...document, project_id: project.id, access_mission_id: mission?.id && missionCanvasDocuments.some((item) => item.id === document.id) ? mission.id : document.mission_id }); }}
    />;
    return null;
  }

  function renderTab() {
    if (activeTab === "Browser") return <BrowserView onStateChange={handleBrowserWorkspaceState} projects={projects} visible={!createProjectOpen && !projectSettingsOpen && !settingsOpen && !workspaceSettingsOpen && !confirmation} />;
    if (activeTab === "WorkspaceSchedules") return <SchedulesView
      agentsConfigured={agentRuntime.enabled}
      desktopNotificationsOn={desktopNotificationsOn}
      projects={projects}
      schedules={workspaceSchedules}
      workspace
      onEnableDesktopNotifications={requestDesktopNotifications}
      onTestDesktopNotifications={testDesktopNotifications}
      onCreate={createSchedule}
      onEdit={editSchedule}
      onAction={updateSchedule}
      onLoadMoreRuns={loadScheduleRuns}
    />;
    if (isMissionTab && !mission) return renderMissionView();
    if (isMissionTab && mission) return renderMissionView();
    if (["Code", "Git", "Artifacts", "Schedules", "Knowledge"].includes(activeTab)) return renderProjectTool(activeTab);
    if (activeTab === "Mission" && canvasDiscussionSplit && selectedCanvasDocument) return <div className="canvas-discussion-split">
      <div className="canvas-discussion-channel">{renderMissionView()}</div>
      <div className="canvas-discussion-document"><ViewErrorBoundary backLabel="Return to chat" key={`discussion:${selectedCanvasDocument.id}`} onBack={() => { setCanvasDiscussionSplit(false); setSelectedCanvasDocument(null); }} title="Document couldn't be opened"><Suspense fallback={<div className="tab-panel column-empty">Opening shared document…</div>}><CanvasView
        document={selectedCanvasDocument}
        refreshKey={canvasRefreshNonce}
        requestConfirmation={requestConfirmation}
        backLabel="Close document"
        onBack={() => { setCanvasDiscussionSplit(false); setSelectedCanvasDocument(null); }}
        onDiscuss={(reference) => void discussCanvasDocument({ ...reference, missionId: selectedCanvasDocument.access_mission_id ?? selectedCanvasDocument.mission_id })}
      /></Suspense></ViewErrorBoundary></div>
    </div>;
    if (activeTab === "Skills") return <SkillsView skills={skills} />;
    if (activeTab === "Agents") return <AgentRolesView agents={agents} capabilityCatalog={capabilityCatalog} agentConfigured={agentRuntime.enabled} onCreate={createAgentDefinition} onUpdate={updateAgentDefinition} onArchive={archiveAgentDefinition} onConnectModel={() => openAgentSettings("model")} onManageModels={() => openWorkspaceSettings("models")} />;
    if (activeTab === "Knowledge") return <ProjectKnowledgeView entries={knowledge} proposals={knowledgeProposals} migration={knowledgeMigration} onResolveMigration={resolveKnowledgeMigration} onSave={saveKnowledge} onReview={reviewKnowledgeProposal} onArchive={archiveKnowledge} onRestore={restoreKnowledge} />;
    if (activeTab === "Recipes") return <WorkflowsView recipes={recipes} onSave={saveWorkflowRecipe} onListVersions={runtime.listRecipeVersions} onGetVersion={runtime.getRecipeVersion} />;
    return renderMissionView();
  }

  return (
    <div className={`app-shell ${window.tribeDesktop ? "app-shell--electron" : ""} ${collapsed ? "app-shell--sidebar-collapsed" : ""}`}>
      <Sidebar
        activeTab={workspaceSettingsOpen ? "Settings" : projectPaneOpen ? (selectedWorkspaceView === "Preview" ? "Artifacts" : selectedWorkspaceView) : activeTab}
        collapsed={collapsed}
        mission={mission}
        onNavigate={(tab) => {
          if (tab === "Settings") { setProjectPaneOpen(false); openWorkspaceSettings(); return; }
          if (tab === "Browser" && mission) { setActiveTab("Mission"); chooseSecondaryPane("Browser"); return; }
          if (tab === "Code") {
            if (mission) { setActiveTab("Mission"); chooseSecondaryPane("Code"); }
            else { setProjectPaneOpen(false); setSelectedArtifact(null); setSelectedCanvasDocument(null); setActiveTab("Code"); }
            return;
          }
          if (tab === "Git") {
            if (mission) { setActiveTab("Mission"); chooseSecondaryPane("Git"); }
            else { setProjectPaneOpen(false); setActiveTab("Git"); }
            return;
          }
          setProjectPaneOpen(false);
          setActiveTab(tab);
        }}
        onSelectProject={(selected) => { setSelectedGeneralChat(null); setProjectPaneOpen(false); setOpenProjectPaneTabs([]); setProjectPaneTab(""); setCanvasDiscussionSplit(false); setSelectedCanvasDocument(null); setComposerDraft(null); setShowNewChat(false); setProject(selected); setMissions(selected.missions ?? []); setMission(null); setActiveTab("Mission"); }}
        onSelectMission={(missionId, selectedProject) => { setSelectedGeneralChat(null); setCanvasDiscussionSplit(false); setSelectedCanvasDocument(null); setActiveTab("Mission"); void selectMission(missionId, selectedProject); }}
        onSelectGeneralChat={selectGeneralChat}
        onCreateGeneralChat={createGeneralChat}
        selectedGeneralChat={selectedGeneralChat}
        generalChats={generalChats}
        onCreateProject={(event) => openProjectCreate(event.currentTarget)}
        onCreateMission={(selected = project) => { setSelectedGeneralChat(null); setProjectPaneOpen(false); if (selected.id !== project.id) { setProject(selected); setMissions(selected.missions ?? []); } setShowNewChat(true); setMission(null); setActiveTab("Mission"); }}
        onOpenProjectSettings={(target, returnFocusElement) => openProjectSettings(target, "team", returnFocusElement)}
        onArchiveMission={archiveCurrentMission}
        onRestoreMission={restoreCurrentMission}
              onDeleteMission={deleteMissionWithConfirmation}
        onDeleteProject={deleteProject}
        project={{ ...project, missions }}
        projects={projects.map((item) => item.id === project.id ? { ...item, missions } : item)}
      />
      <main className={`main-area ${isMissionTab && mission ? "main-area--mission-workspace" : ""} ${isProjectWorkspace ? "main-area--project-workspace" : ""} ${activeTab === "Browser" ? "main-area--browser-workspace" : ""} ${activeTab === "Code" ? "main-area--repository" : ""} ${isMissionTab && mission && activeTab === "Mission" ? "main-area--conversation" : ""} ${selectedGeneralChat ? "main-area--general-chat" : ""} ${projectPaneOpen && mission && isMissionTab ? "main-area--project-pane-open" : ""} ${isMissionTab && mission && activeTab === "Mission" && canvasDiscussionSplit && selectedCanvasDocument ? "main-area--canvas-discussion" : ""} ${isMissionTab && !mission && !selectedGeneralChat && activeTab === "Mission" ? "main-area--project-home" : ""}`} style={{ "--secondary-pane-width": `${visibleWorkspacePaneWidth}px` }}>
        <header aria-label={browserTitlebarActive ? "Browser workspace" : undefined} className={`topbar${window.tribeDesktop?.platform === "darwin" ? " topbar--electron-mac" : ""}${browserTitlebarActive ? " topbar--browser" : ""}${projectPaneOpen && mission && isMissionTab ? " topbar--split-workspace" : ""}`}>
          <div className="topbar-main">
          <div className="topbar-leading">
            <IconButton aria-pressed={collapsed} className="topbar-sidebar-toggle" label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => setCollapsed((value) => !value)}><SidebarSimple size={18} /></IconButton>
          {activeTab !== "Browser" && <div className="breadcrumb">
            <span className="breadcrumb-project" title={isGlobalWorkspaceTab ? "Workspace" : project.name || (selectedGeneralChat ? "Chats" : "Tribe")}>
              <FolderSimple aria-hidden="true" className="breadcrumb-project-icon" size={17} />
              {(!project.id || isGlobalWorkspaceTab) && <strong>{isGlobalWorkspaceTab ? "Workspace" : project.name || (selectedGeneralChat ? "Chats" : "Tribe")}</strong>}
            </span>
            <span className="breadcrumb-chat" title={isMissionTab ? selectedGeneralChat?.title ?? mission?.title ?? "New chat" : activeWorkspaceLabel}>
              {isMissionTab && <ChatCircleDots aria-hidden="true" className="breadcrumb-chat-icon" size={16} />}
              <span className="breadcrumb-chat-label">{isMissionTab ? compactChatTitle(selectedGeneralChat?.title ?? mission?.title ?? "New chat") : activeWorkspaceLabel}</span>
            </span>
            {isMissionTab && mission && <span aria-label={runtimeConnectionLabel(runtimeStatus)} className={`runtime-connection-indicator runtime-connection-indicator--${runtimeStatus}`} role="status" title={runtimeConnectionLabel(runtimeStatus)}>
              <i />{runtimeConnectionText(runtimeStatus) && <span>{runtimeConnectionText(runtimeStatus)}</span>}
            </span>}
          </div>}
          </div>
          <div className="topbar-actions">
            <div className="request-menu-wrap">
              <IconButton aria-expanded={requestsOpen} className={`request-menu-button ${globalInteractions.length || computerRequests.length ? "request-menu-button--pending" : ""}`} label={`Needs you${globalInteractions.length + computerRequests.length ? ` · ${globalInteractions.length + computerRequests.length} waiting` : ""}`} onClick={() => setRequestsOpen((value) => !value)}>
                <BellSimple size={16} />{(globalInteractions.length + computerRequests.length) > 0 && <span>{globalInteractions.length + computerRequests.length}</span>}
              </IconButton>
              {requestsOpen && <div className="request-menu" role="menu">
                <div className="request-menu-heading"><strong>Needs you</strong><span>{globalInteractions.length + computerRequests.length} pending</span></div>
                {globalInteractions.map((item) => <button className="request-menu-item" key={item.id} onClick={() => openPendingInteraction(item)} role="menuitem" type="button">
                  <span className={item.type === "approval" ? "request-icon request-icon--approval" : "request-icon"}>{item.type === "approval" ? <Trash size={15} /> : <WarningCircle size={16} />}</span>
                  <span className="request-menu-copy"><strong>{item.type === "approval" ? "Approval needed" : "Clarification needed"}</strong><span>{item.title}</span>{item.type === "approval" && <code>{item.target}</code>}<small>{item.projectName} · {item.missionTitle}</small></span>
                  <CaretRight size={14} />
                </button>)}
                {computerRequests.map((item) => <button className="request-menu-item" key={item.id} onClick={() => { setRequestsOpen(false); setActiveComputerRequest(item); }} role="menuitem" type="button">
                  <span className="request-icon request-icon--approval"><DesktopTower size={15} /></span>
                  <span className="request-menu-copy"><strong>Window access needed</strong><span>{item.purpose}</span><small>{item.agentName} · {item.projectName} · {item.missionTitle}</small></span>
                  <CaretRight size={14} />
                </button>)}
                {globalInteractions.length + computerRequests.length === 0 && <p className="request-menu-empty">No requests are waiting.</p>}
              </div>}
            </div>
            {isMissionTab && mission && <>
              <label className={`search-box${headerSearchOpen ? " search-box--expanded" : ""}`}><MagnifyingGlass size={16} /><input aria-label="Search channel" onBlur={() => { if (!query) setHeaderSearchOpen(false); }} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setHeaderSearchOpen(false); event.currentTarget.blur(); } }} placeholder="Search channel" ref={headerSearchInputRef} value={query} /><kbd>⌘ K</kbd></label>
              {!headerSearchOpen && <IconButton aria-label="Search channel" className="search-box-trigger" label="Search channel" onClick={() => setHeaderSearchOpen(true)}><MagnifyingGlass size={16} /></IconButton>}
            </>}
            {isMissionTab && mission && <div className="mission-header-controls">
              {mission.status === "completed" && !mission.archived_at && <span className="mission-status mission-status--completed" role="status"><i className="status-pulse" />Completed</span>}
              {noAgentsReady && <IconButton className="mission-control-button mission-control-button--setup" label={`Connect a model · ${readyAgentCount} of ${agents.length} agents ready`} onClick={() => openAgentSettings("model")}><WarningCircle size={16} /></IconButton>}
              {!mission.archived_at && mission.status !== "completed" && <IconButton className="mission-control-button" disabled={missionControlPending} label={missionControlPending ? "Updating chat" : mission.status === "paused" ? "Resume chat" : "Pause agents"} onClick={mission.status === "paused" ? resumeCurrentMission : pauseCurrentMission}>
                {missionControlPending ? <CircleNotch className="spin" size={16} /> : mission.status === "paused" ? <Play size={16} weight="fill" /> : <Pause size={16} weight="fill" />}
              </IconButton>}
              {mission.archived_at ? <IconButton className="mission-control-button" disabled={missionControlPending} label={missionControlPending ? "Restoring chat" : "Restore chat"} onClick={restoreCurrentMission}>{missionControlPending ? <CircleNotch className="spin" size={16} /> : <ArrowCounterClockwise size={16} />}</IconButton>
                : mission.status !== "active" && <IconButton className="mission-control-button" disabled={missionControlPending} label="Archive chat" onClick={archiveCurrentMission}><Archive size={16} /></IconButton>}
            </div>}
            {isMissionTab && mission && <div className="chat-views-menu-wrap">
              <IconButton aria-expanded={chatViewsOpen} aria-haspopup="menu" className="chat-views-menu-button" label="Open chat views" onClick={() => setChatViewsOpen((value) => !value)}><DotsThreeVertical size={18} weight="bold" /></IconButton>
              {chatViewsOpen && <div className="chat-views-menu" role="menu">
                <div className="chat-views-menu-heading">Open in pane</div>
                {chatViewMenuTools.map(({ id, label, icon: Icon }) => <button aria-current={openProjectPaneTabs.some((tab) => tab.kind === "view" && tab.id === id) ? "true" : undefined} className="chat-views-menu-item" key={id} onClick={() => openMissionWorkspaceTool(id)} role="menuitem" type="button">
                  <Icon size={16} />
                  <span>{label}</span>
                  {openProjectPaneTabs.some((tab) => tab.kind === "view" && tab.id === id) && <Check aria-label="Open" size={15} />}
                </button>)}
              </div>}
            </div>}
          </div>
          </div>
          {projectPaneOpen && mission && isMissionTab && <div className="topbar-secondary-tabs">
            <SecondaryPaneTabs badges={{ Git: projectGitChangeCount, Artifacts: artifactTotal, Preview: selectedArtifact ? 1 : 0 }} onClose={closeSecondaryPaneTab} openTabs={openProjectPaneTabs} selected={projectPaneTab} tools={projectPaneTools} browserTabs={browserWorkspaceState.tabs} onNewBrowserTab={createBrowserWorkspaceTab} onReorder={reorderWorkspaceTabs} onSelect={selectSecondaryPaneTab} />
          </div>}
          {activeTab === "Browser" && <div className="topbar-secondary-tabs"><SecondaryPaneTabs badges={{}} browserTabs={browserWorkspaceState.tabs} onNewBrowserTab={createBrowserWorkspaceTab} onReorder={reorderWorkspaceTabs} onSelect={selectSecondaryPaneTab} onClose={closeSecondaryPaneTab} openTabs={openProjectPaneTabs.filter((tab) => tab.kind === "browser")} selected={browserWorkspaceState.activeTabId ? `browser:${browserWorkspaceState.activeTabId}` : projectPaneTab} tools={projectPaneTools} /></div>}
        </header>

        <div className={`workspace-body ${projectPaneOpen && mission && isMissionTab ? "workspace-body--split" : ""} ${paneResizing ? "workspace-body--resizing" : ""}`} ref={workspacePaneRef} style={{ "--secondary-pane-width": `${visibleWorkspacePaneWidth}px` }}>
        <div className="workspace-primary">

        {mission && (mission.blocked_reason || mission.recipe_id || workflowPhase) && <div className="mission-context-row">
          {mission.blocked_reason && <div className="mission-blocked-notice"><WarningCircle size={15} /><span>{mission.blocked_reason}</span><small>Waiting for your response</small></div>}
          {mission.recipe_id && <MissionWorkflowProgress
            completed={mission.status === "completed"}
            currentStageId={workflowPhase?.stageId ?? mission.workflow_context?.stage?.stageId}
            currentTitle={workflowPhase?.label ?? mission.workflow_context?.stage?.title ?? "Not started"}
            stages={workflowSnapshot?.stages}
            state={workflowPhase?.state ?? mission.workflow_context?.state?.state}
            title={workflowSnapshot?.title ?? recipes.find((recipe) => recipe.id === mission.recipe_id)?.title ?? mission.recipe_id}
          />}
          {mission.recipe_id && !workflowSnapshot?.stages?.length && <span className="mission-workflow-chip">Workflow · {workflowSnapshot?.title ?? mission.recipe_id}</span>}
        </div>}

        <div className="tab-content">{requiresProject && !project.id ? <section className="empty-workspace">
          <span className="eyebrow">A local workspace for engineering work</span>
          <h2>Start with a project folder</h2>
          <p>Choose an existing folder, including an empty one, or clone a Git repository. Your project and chat history stay on this device.</p>
          <button className="button button--primary" onClick={(event) => openProjectCreate(event.currentTarget)} type="button"><FolderSimple size={16} /> Add a project</button>
          <div className="empty-workspace-links">
            <button className="empty-workspace-link" onClick={() => openWorkspaceSettings("models")} type="button"><Gear size={16} /><span><strong>Connect a model</strong><small>Choose a hosted or local model before starting agents.</small></span><CaretRight size={15} /></button>
            <button className="empty-workspace-link" onClick={() => setActiveTab("Recipes")} type="button"><ListChecks size={16} /><span><strong>Explore workflows</strong><small>The default workflow plans, builds, verifies and reviews mission work.</small></span><CaretRight size={15} /></button>
          </div>
          <small className="empty-workspace-footnote">Choose a project in the sidebar to see its missions and project tools.</small>
        </section> : <Suspense fallback={<div aria-live="polite" className="tab-panel column-empty" role="status">Opening view…</div>}>{renderTab()}</Suspense>}</div>
        </div>
        {projectPaneOpen && mission && isMissionTab && <>
          <div aria-label="Resize chat and workspace pane" aria-orientation="vertical" aria-valuemax={maxWorkspacePaneWidth} aria-valuemin={320} aria-valuenow={Math.round(visibleWorkspacePaneWidth)} aria-valuetext={`Workspace pane ${Math.round(visibleWorkspacePaneWidth)} pixels wide`} className="secondary-pane-resizer" onKeyDown={nudgeSecondaryPaneWidth} onLostPointerCapture={stopSecondaryPaneResize} onPointerCancel={stopSecondaryPaneResize} onPointerDown={startSecondaryPaneResize} onPointerMove={moveSecondaryPaneResize} onPointerUp={stopSecondaryPaneResize} role="separator" tabIndex={0}><DotsSixVertical aria-hidden="true" size={16} weight="bold" /></div>
          <aside aria-label={`${projectPaneTools.find((tool) => tool.id === selectedWorkspaceView)?.label ?? "Workspace tools"} pane`} className="project-tool-pane" id="secondary-workspace-pane">
            <div className="project-tool-pane-body">
              {openProjectPaneTabs.some((tab) => tab.kind === "browser") && <div className="browser-pane-retained" hidden={selectedWorkspaceTab?.kind !== "browser"}>{renderProjectTool("Browser", selectedWorkspaceTab?.kind === "browser")}</div>}
              {selectedWorkspaceTab?.kind === "view" && renderProjectTool(selectedWorkspaceTab.id)}
            </div>
          </aside>
        </>}
        </div>
        {activeWork && <div className="work-selection" role="status">Selected task: {activeWork.title}<button onClick={() => setActiveWork(null)} type="button" aria-label="Dismiss"><X size={14} /></button></div>}
        <input aria-hidden="true" ref={fileInputRef} className="visually-hidden" onChange={handleFile} tabIndex={-1} type="file" />
        {activeComputerRequest && <div className="dialog-backdrop computer-observation-backdrop" role="presentation">
          <section aria-labelledby="computer-observation-heading" aria-modal="true" className="mission-dialog computer-observation-dialog" ref={computerRequestDialogRef} role="dialog" tabIndex={-1}>
            <div className="dialog-heading"><div><span className="eyebrow">Window request</span><h2 id="computer-observation-heading">Share one window</h2></div><IconButton disabled={computerCaptureBusy} label="Close request" onClick={() => cancelComputerObservation(activeComputerRequest)}><X size={17} /></IconButton></div>
            <p><strong>{activeComputerRequest.agentName}</strong> needs a visual check in <strong>{activeComputerRequest.missionTitle}</strong>.</p>
            <div className="computer-observation-purpose"><span>Reason</span><p>{activeComputerRequest.purpose}</p></div>
            <p className="settings-note">Tribe captures one window only. You can review the screenshot before sharing it with the agent or saving it to artifacts.</p>
            <div className="dialog-actions"><button className="button button--quiet" disabled={computerCaptureBusy} onClick={() => cancelComputerObservation(activeComputerRequest)} type="button">Cancel request</button><button className="button button--primary" disabled={computerCaptureBusy || Boolean(pendingComputerObservation)} onClick={() => startComputerObservation(activeComputerRequest)} type="button">{pendingComputerObservation ? "Review screenshot first" : computerCaptureBusy ? "Waiting for window…" : "Choose a window"}</button></div>
          </section>
        </div>}
        {pendingComputerObservation && <div className="dialog-backdrop computer-observation-backdrop" role="presentation">
          <section aria-labelledby="computer-observation-preview-heading" aria-modal="true" className="mission-dialog computer-observation-dialog" ref={computerPreviewDialogRef} role="dialog" tabIndex={-1}>
            <div className="dialog-heading"><div><span className="eyebrow">Review before sharing</span><h2 id="computer-observation-preview-heading">Share this screenshot?</h2></div><IconButton disabled={computerCaptureBusy} label="Discard screenshot" onClick={discardComputerObservation}><X size={17} /></IconButton></div>
            <p><strong>{pendingComputerObservation.request.agentName}</strong> requested a visual check in <strong>{pendingComputerObservation.request.missionTitle}</strong>.</p>
            <div className="computer-observation-purpose"><span>Selected window</span><p>{pendingComputerObservation.observation.windowTitle || pendingComputerObservation.observation.application || "Selected application window"}</p></div>
            <div className="computer-observation-preview"><img alt="Preview of the selected application window" src={`data:image/png;base64,${pendingComputerObservation.observation.imageBase64}`} /></div>
            <p className="settings-note">Share sends this screenshot to {pendingComputerObservation.request.agentName} for this step. Saving it to artifacts is a separate choice.</p>
            <div className="computer-observation-actions"><button className="button button--quiet" disabled={computerCaptureBusy} onClick={discardComputerObservation} type="button">{computerCaptureAction === "discarding" ? "Cancelling…" : "Discard and cancel"}</button><button className="button button--quiet" disabled={computerCaptureBusy || Boolean(pendingComputerObservation.artifactId)} onClick={saveComputerObservationAsArtifact} type="button">{computerCaptureAction === "saving" ? "Saving…" : pendingComputerObservation.artifactId ? "Saved to artifacts" : "Save to artifacts"}</button><button className="button button--primary" disabled={computerCaptureBusy} onClick={shareComputerObservation} type="button">{computerCaptureAction === "sharing" ? "Sharing…" : "Share with agent"}</button></div>
          </section>
        </div>}
        {createProjectOpen && <Suspense fallback={null}><ProjectCreateDialog onClose={closeProjectCreate} onCreate={createProject} /></Suspense>}
        {settingsOpen && (
          <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeAgentSettings(); }}>
            <section className="mission-dialog agent-settings-dialog" ref={agentSettingsDialogRef} role="dialog" aria-modal="true" aria-labelledby="agent-settings-heading" tabIndex={-1}>
              <div className="dialog-heading"><div><span className="eyebrow">{settingsMode === "mcp" ? `Project tools · ${project.name}` : "Workspace default"}</span><h2 id="agent-settings-heading">{settingsMode === "mcp" ? "Manage tool connections" : agentRuntime.configured ? "Change default model" : "Choose a default model"}</h2></div><IconButton label="Close" onClick={closeAgentSettings}><X size={17} /></IconButton></div>
              {settingsMode === "model" && <form className="model-settings-form" id="model-settings-form" onSubmit={saveSettings}>
                <p className="settings-note">Chats use this model when no chat preference is set. An explicit agent-role choice takes priority over the chat selection. Agents may send mission details and repository content to the provider; credentials are saved securely on this device.</p>
                <div className="ollama-discovery">
                  <div><strong>Find available models</strong><small>Search this provider’s catalogue. Ollama and OpenAI-compatible providers are supported.</small></div>
                  <button className="button button--quiet" disabled={providerModelsDiscovering} onClick={discoverAvailableModels} type="button">{providerModelsDiscovering ? "Searching…" : "Find models"}</button>
                </div>
                {providerModels?.length > 0 && <label>Available models<SelectControl aria-label="Available models" onChange={(value) => { if (value) setModelInput(`${modelProvider(modelInput) || "openai"}:${value}`); }} options={[{ value: "", label: "Choose a model" }, ...providerModels.map((model) => ({ value: model.id, label: `${modelDisplayName(model)}${model.contextWindow ? ` · ${new Intl.NumberFormat().format(model.contextWindow)} context` : ""}` }))]} size="full" value={modelInput.includes(":") && modelProvider(modelInput) === (modelProvider(modelInput) || "openai") ? modelInput.slice(modelInput.indexOf(":") + 1) : ""} /></label>}
                <label>Provider<input autoFocus list="tribe-model-providers" onChange={(event) => changeModelProvider(event.target.value)} placeholder="openai" value={modelProvider(modelInput) || "openai"} /><datalist id="tribe-model-providers">{Object.entries(providerNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</datalist><small>Popular providers are listed. You can enter another provider name.</small></label>
                <label>Model<input onChange={(event) => changeModelName(event.target.value)} placeholder={modelProvider(modelInput) === "openrouter" ? "provider/model-name" : "Model name"} value={modelInput.includes(":") ? modelInput.slice(modelInput.indexOf(":") + 1) : modelInput} /></label>
                <>
                  <label>Service URL (optional)<input autoComplete="url" onChange={(event) => setModelBaseUrlInput(event.target.value)} placeholder="https://provider.example/v1 or http://localhost:4000/v1" value={modelBaseUrlInput} /></label>
                  <small>Leave blank to use the provider default. Local HTTP endpoints are allowed; remote endpoints must use HTTPS.</small>
                  <label>{providerNames[modelProvider(modelInput)] ? `${providerNames[modelProvider(modelInput)]} API key${modelProvider(modelInput) === "ollama" ? " (optional for local Ollama)" : ""}` : "Provider API key"}<input autoComplete="off" onChange={(event) => setApiKeyInput(event.target.value)} placeholder={modelProvider(modelInput) === "ollama" ? "Optional for local Ollama" : agentRuntime.configured && modelProvider(agentRuntime.model ?? "") === modelProvider(modelInput) ? "Saved securely · leave blank to keep" : modelBaseUrlInput.trim() ? "Optional if the endpoint allows it" : "API key or existing credentials"} type="password" value={apiKeyInput} /><small>Leave blank to use credentials already available on this device.</small></label>
                  {modelBaseUrlInput.trim() && <small>Some custom endpoints allow connections without a key. Tribe checks whether this provider supports custom service URLs.</small>}
                </>
                {modelInput.toLowerCase().startsWith("ollama:") && <p className="settings-note">Tribe connects to Ollama on this device by default. To use a different address, set <code>TRIBE_OLLAMA_BASE_URL</code>.</p>}
              </form>}
              {settingsMode === "mcp" && <section className="mcp-settings" aria-labelledby="mcp-settings-heading">
                <div className="mcp-settings-heading"><div><h3 id="mcp-settings-heading">Tool connections</h3><p className="settings-note">Add tools agents can use in {project.name}. Actions that change data ask for your approval.</p></div><div className="mcp-heading-actions"><button className="button button--quiet" disabled={mcpSaving || !project.id || mcpConfigInput === mcpSavedConfig} onClick={() => saveMcpConfig()} type="button">{mcpSaving ? "Saving…" : "Save changes"}</button><button className="button button--quiet" disabled={mcpSaving || !project.id || hasMcpServer(mcpConfigInput, "playwright")} onClick={installPlaywrightBrowser} type="button">Add browser tools</button></div></div>
                <p className="settings-note">Browser tools run in an isolated headless session. The first browser launch may download Chromium; install it ahead of time here if you prefer. Agents can inspect pages without approval; opening pages, clicking, typing and inspecting network requests require approval. Code execution is disabled.</p>
                <div className="mcp-server-list">
                  <AddRemoteServiceForm onAdd={addRemoteMcpServer} saving={mcpSaving} secretNames={mcpSecretNames(mcpConfigInput)} serverNames={mcpServerEntries(mcpConfigInput).map(([name]) => name)} />
                  {mcpServerEntries(mcpConfigInput).length === 0 && <div className="mcp-empty">No other tools connected. Add local services in advanced settings, or add browser tools above.</div>}
                  {mcpServerEntries(mcpConfigInput).map(([name, definition]) => {
                    const check = mcpChecks[name];
                    const isPlaywright = name === "playwright" && definition.command === "npx" && (definition.args ?? []).some((argument) => argument.startsWith("@playwright/mcp@"));
                    const browserInstall = mcpBrowserInstall[project.id];
                    const disabledTools = new Set(definition.disabledTools ?? []);
                    return <article className="mcp-server-card" key={name}>
                      <div className="mcp-server-card-heading"><div><strong>{name}</strong><small>{definition.command ? `Local · ${definition.command}` : `Remote · ${definition.url}`}</small></div><label className="mcp-enable-toggle"><input aria-label={`${name} enabled`} checked={!definition.disabled} onChange={(event) => updateMcpServer(name, (server) => ({ ...server, disabled: !event.target.checked }))} role="switch" type="checkbox" /><span aria-hidden="true" className="mcp-enable-switch" />Enabled</label></div>
                      <div className="mcp-server-card-actions"><button className="button button--quiet" disabled={mcpSaving || check?.loading || mcpConfigInput !== mcpSavedConfig} onClick={() => checkMcpServer(name)} type="button">{check?.loading ? (definition.oauth ? "Signing in…" : "Checking…") : definition.oauth ? "Sign in and check" : "Check connection"}</button>{isPlaywright && <button className="button button--quiet" disabled={browserInstall?.loading || mcpConfigInput !== mcpSavedConfig} onClick={installPlaywrightChromium} type="button">{browserInstall?.loading ? "Installing Chromium…" : "Install Chromium"}</button>}{definition.oauth && <><span className={`mcp-oauth-state mcp-oauth-state--${mcpOAuthStatuses[name]?.state ?? "unknown"}`}>{mcpOAuthStatuses[name]?.state === "connected" ? "Signed in on this device" : "Sign-in needed"}</span>{mcpOAuthStatuses[name]?.state === "connected" && <button className="button button--quiet" disabled={mcpSaving} onClick={() => forgetMcpOAuth(name)} type="button">Forget sign-in</button>}<small>{mcpOAuthStatuses[name]?.state === "connected" ? "Forget removes saved credentials here; revoke access with the service to end its grant." : "Your browser will open to request access when you sign in."}</small></>}{mcpConfigInput !== mcpSavedConfig && <small>Save changes before checking.</small>}</div>
                      {isPlaywright && browserInstall?.installed && <p className="mcp-preflight-status" role="status">Chromium is installed on this device.</p>}
                      {isPlaywright && browserInstall?.error && <p className="mcp-check-error" role="status">Couldn’t install Chromium · {browserInstall.error}</p>}
                      {check?.error && <p className="mcp-check-error" role="status">Connection failed · {check.error}</p>}
                      {check?.preflight?.ready && <p className="mcp-preflight-status" role="status">Playwright opened its browser successfully with Node.js {check.preflight.nodeVersion}.</p>}
                      {check?.tools && <div className="mcp-tool-list"><div className="mcp-tool-list-heading">Available tools · {check.tools.length}</div>{check.tools.length === 0 && <small>This server did not advertise any tools.</small>}{check.tools.map((tool) => <label className="mcp-tool-row" key={tool.name}><input checked={!disabledTools.has(tool.name)} onChange={(event) => updateMcpServer(name, (server) => ({ ...server, disabledTools: event.target.checked ? (server.disabledTools ?? []).filter((item) => item !== tool.name) : [...new Set([...(server.disabledTools ?? []), tool.name])] }))} type="checkbox" /><span><strong>{tool.name}</strong><small>{tool.description || (tool.readOnly ? "Read-only tool" : "Actions require approval")}</small></span>{tool.readOnly && <em>Read-only</em>}</label>)}</div>}
                    </article>;
                  })}
                </div>
                <details className="mcp-advanced-config"><summary>Advanced connection settings (JSON)</summary><textarea aria-label="Tool connection settings" className="mcp-config-input" onChange={(event) => setMcpConfigInput(event.target.value)} spellCheck="false" value={mcpConfigInput} /></details>
                {mcpSecretNames(mcpConfigInput).length > 0 && <div className="mcp-secret-list">
                  <strong>Server credentials</strong>
                  <p className="settings-note">Credentials are saved separately and supplied when the connection starts.</p>
                  {mcpSecretNames(mcpConfigInput).map((name) => <div className="mcp-secret-row" key={name}>
                    <label>{name}<input autoComplete="new-password" onChange={(event) => setMcpSecretValues((current) => ({ ...current, [name]: event.target.value }))} placeholder={mcpSecretStatus[name] === "environment" ? "Provided by the app environment" : mcpSecretStatus[name] === "keychain" ? "Saved securely · enter to replace" : "Required"} type="password" value={mcpSecretValues[name] ?? ""} /></label>
                    {mcpSecretStatus[name] === "keychain" && <button className="button button--quiet" disabled={mcpSaving} onClick={() => forgetMcpSecret(name)} type="button">Forget</button>}
                  </div>)}
                  <button className="button button--quiet" disabled={mcpSaving || !Object.values(mcpSecretValues).some(Boolean)} onClick={saveMcpSecrets} type="button">{mcpSaving ? "Saving…" : "Save credentials"}</button>
                </div>}
              </section>}
              {settingsError && <p className="settings-error" role="alert">{settingsError}</p>}
              {agentRuntime.error && <div className="settings-runtime-diagnostic"><p className="settings-note" role="status">The current model is not ready. Check its provider, model name and credentials.</p><details><summary>Technical details</summary><pre>{agentRuntime.error}</pre></details></div>}
              <div className="dialog-actions"><button className="button button--quiet" onClick={closeAgentSettings} type="button">{settingsMode === "mcp" ? "Done" : "Cancel"}</button>{settingsMode === "model" && <button className="button button--primary" disabled={!modelInput.split(":").slice(1).join(":").trim()} form="model-settings-form" type="submit">Save and connect</button>}</div>
            </section>
          </div>
        )}
        {projectSettingsOpen && <Suspense fallback={null}><ProjectSettingsDialog onClose={closeProjectSettings} onSectionChange={setProjectSettingsSection} project={project} section={projectSettingsSection}>{renderProjectSettingsSection}</ProjectSettingsDialog></Suspense>}
        {workspaceSettingsOpen && <Suspense fallback={null}><SettingsView agentRuntime={agentRuntime} usage={usage} webAccess={webAccess} computerAccess={computerAccess} onSaveUsageBudget={saveUsageBudget} onSaveWebAccess={saveWebAccess} onSaveComputerAccess={saveComputerAccess} onConfigureModel={(modelId, baseUrl, apiKey) => openAgentSettings("model", modelId, baseUrl, apiKey)} onSetWorkspaceDefault={setWorkspaceDefaultModel} onManageMcp={() => openAgentSettings("mcp")} onExportBackup={exportBackup} onImportBackup={importBackup} onExportAudit={exportProjectAudit} onClose={closeWorkspaceSettings} initialSection={workspaceSettingsSection} initialModelId={workspaceSettingsModelId} project={project} runtimeStatus={runtimeStatus} /></Suspense>}
      </main>
      <Toast onDismiss={() => setToast("")} text={toast} />
      {confirmation && <ConfirmationDialog confirmation={confirmation} onCancel={() => finishConfirmation(false)} onConfirm={() => finishConfirmation(true)} />}
    </div>
  );
}
