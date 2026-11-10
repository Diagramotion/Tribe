import { useEffect, useRef, useState } from "react";
import {
  ArrowClockwise, BellSimple, CalendarBlank, CheckCircle, CircleNotch, ClipboardText, ClockCounterClockwise, GlobeHemisphereWest, Pause, PencilSimple, Play, Plus, Stop, TerminalWindow, WarningCircle, X,
} from "@phosphor-icons/react";
import { SelectControl } from "../components/SelectControl.jsx";
import { schedulePresentation } from "../domain/schedules.js";
import { cronFields, hourWindowFromCron, monthlyDayFromCron, scheduleCronExpression, selectedDaysFromCron, WEEKDAYS } from "../domain/schedule-recurrence.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";

const scheduleTemplates = [
  { title: "Daily research brief", description: "Get a sourced roundup of a topic you choose.", prompt: "Research the latest developments on [topic]. Summarise the important changes and include links to your sources.", cadence: "daily", icon: GlobeHemisphereWest },
  { title: "Weekly project review", description: "Check recent progress, open work and blockers.", prompt: "Review this project's recent progress, open work and blockers. Summarise what changed and recommend the next steps.", cadence: "weekly", icon: ClipboardText },
  { title: "Follow a topic", description: "Check for meaningful updates and explain why they matter.", prompt: "Look for meaningful updates about [topic]. If anything changed, explain why it matters and include sources.", cadence: "weekdays", icon: BellSimple },
  { title: "Plan the week", description: "Review project priorities and prepare a concise plan.", prompt: "Review this project's priorities and prepare a concise plan for the coming week.", cadence: "weekly", icon: CalendarBlank },
  { title: "Investigate failing tests", description: "Start a review when a project chat records a failed test run.", prompt: "Investigate the failed test run. Identify the likely cause, the smallest useful fix, and any follow-up verification needed.", cadence: "event", triggerEventType: "repo.test_run.completed", icon: WarningCircle },
];
const eventTriggerOptions = [
  { value: "repo.test_run.completed", label: "A test run fails" },
  { value: "repo.file.changed", label: "A repository file changes" },
  { value: "mission.completed", label: "A chat completes" },
  { value: "artifact.created", label: "An artifact is created" },
  { value: "github.workflow_run.failed", label: "A GitHub Actions run fails" },
];
const hourOptions = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: `${String(hour).padStart(2, "0")}:00` }));
const clockHourOptions = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour).padStart(2, "0"), label: String(hour).padStart(2, "0") }));
const minuteOptions = Array.from({ length: 60 }, (_, minute) => ({ value: String(minute).padStart(2, "0"), label: String(minute).padStart(2, "0") }));
const cronFieldLabels = ["Minute", "Hour", "Day of month", "Month", "Day of week"];
const cronFieldHints = ["0–59", "0–23", "1–31", "1–12 or JAN–DEC", "0–6 or SUN–SAT"];

function externalTriggerStatusMessage(code) {
  if (code === "github_actions_local_rate_budget") {
    return "Tribe is spacing checks across repositories to stay within GitHub’s shared request limit.";
  }
  if (code === "github_actions_requires_project_web_access") {
    return "Enable project web access for api.github.com to resume checks.";
  }
  if (code === "github_actions_rate_limited_or_forbidden") {
    return "GitHub declined the request. The next check will retry later.";
  }
  if (code === "github_repository_not_found_or_private") {
    return "The repository was not found or is private. Tribe can check public repositories only.";
  }
  return "The latest GitHub check failed. Tribe will try again.";
}

const runStatusLabels = {
  queued: "Queued",
  running: "Running",
  paused: "Chat paused",
  blocked: "Waiting for you",
  completed: "Completed",
  cancelled: "Stopped",
  failed: "Needs attention",
};

function ScheduleTimeFields({ label, value, onChange }) {
  const [hour = "09", minute = "00"] = (value || "09:00").split(":");
  return <div className="schedule-time-fields">
    <SelectControl className="schedule-select--time-part" label={`${label} hour`} onChange={(nextHour) => onChange(`${nextHour}:${minute}`)} options={clockHourOptions} size="compact" value={hour} />
    <span aria-hidden="true">:</span>
    <SelectControl className="schedule-select--time-part" label={`${label} minute`} onChange={(nextMinute) => onChange(`${hour}:${nextMinute}`)} options={minuteOptions} size="compact" value={minute} />
  </div>;
}

export function EventTriggerFailureQueue({ workspace, failures, total, hasMore, loading, loadingMore, error, actionId, onRefresh, onLoadMore, onRetry, onDismiss }) {
  return <section aria-label="Event trigger failures" className="schedule-failure-queue">
    <header><div><h3>Event runs needing review</h3><p>{total === 0 ? "No failed event runs need review." : `${total} failed event ${total === 1 ? "run" : "runs"} across ${workspace ? "your projects" : "this project"}.`}</p></div>
      <button aria-label="Refresh event failures" className="artifact-refresh" disabled={loading} onClick={onRefresh} type="button">{loading ? <CircleNotch className="spin" size={15} /> : <ArrowClockwise size={15} />}</button>
    </header>
    {error && <p className="schedule-history-error" role="alert">{error}</p>}
    {loading && failures.length === 0
      ? <p className="schedule-failure-empty" role="status">Loading event failures…</p>
      : failures.length === 0
        ? <p className="schedule-failure-empty">No failed event runs need review.</p>
        : <div className="schedule-failure-list">{failures.map((failure) => <article className="schedule-failure-item" key={failure.id}>
          <div className="schedule-failure-copy"><strong>{failure.schedule_title}</strong><small>{workspace ? `${failure.project_name} · ` : ""}{eventTriggerOptions.find((option) => option.value === failure.trigger_event_type)?.label ?? "Event trigger"} · {failure.event_source_mission_title ?? "Source chat unavailable"}</small><small>Run in {failure.mission_title} · {new Date(failure.started_at).toLocaleString()}</small>
            {failure.retry_of_run_id && <small>{failure.retry_kind === "automatic" ? "Automatic retry attempt." : "This is a failed retry attempt."}</small>}
            {failure.error && <small className="schedule-run-error">{failure.error}</small>}
            {!failure.can_retry && <small>Retry is unavailable while the schedule or chat needs attention.</small>}
          </div>
          <div className="schedule-failure-actions">
            <button className="button button--quiet" disabled={!failure.can_retry || actionId === failure.id} onClick={() => onRetry(failure)} type="button">{actionId === failure.id ? "Working…" : "Retry"}</button>
            <button className="button button--quiet" disabled={actionId === failure.id} onClick={() => onDismiss(failure)} type="button">Dismiss</button>
          </div>
        </article>)}</div>}
    {hasMore && <button className="button button--quiet schedule-history-more" disabled={loadingMore} onClick={onLoadMore} type="button">{loadingMore ? "Loading…" : `Load older failures · ${failures.length} of ${total}`}</button>}
  </section>;
}

export function RunsView({ mission, runs, agentRequests = [], onStop }) {
  return <section className="tab-panel detail-view command-view">
    {!mission && <div className="column-empty">Choose a chat to see its runs.</div>}
    {runs.length > 0 && <div className="command-list-heading"><h3>Run history</h3><span>{runs.length} {runs.length === 1 ? "run" : "runs"}</span></div>}
    <div className={`command-run-list ${runs.length === 0 ? "command-run-list--empty" : ""}`}>{runs.length === 0 && <div className="command-empty"><span><TerminalWindow size={20} /></span><div><strong>No runs yet</strong><p>Ask the team to run tests or another repository task in chat. Results will appear here.</p></div></div>}
      {runs.map((run) => <article className="command-run" key={run.id}>
        <div className={`command-run-status command-run-status--${run.status}`} aria-label={runStatusLabels[run.status] ?? "Status unavailable"}>{run.status === "running" ? <CircleNotch className="spin" size={17} /> : run.status === "completed" ? <CheckCircle size={17} /> : <WarningCircle size={17} />}</div>
        <div className="command-run-body"><div className="command-run-meta"><code>{run.argv.join(" ")}</code><span>{runStatusLabels[run.status] ?? "Status unavailable"}</span></div><small>Started {new Date(run.started_at).toLocaleString()}</small>{run.output && <details className="command-output" open={run.status === "running"}><summary>Show run output</summary><pre>{run.output}</pre></details>}</div>
        {run.status === "running" && <button aria-label="Stop run" className="icon-button" onClick={() => onStop(run.id)} title="Stop run" type="button"><Stop size={14} /></button>}
      </article>)}
    </div>
    {mission && <details className="command-output agent-request-diagnostics">
      <summary>Model requests · {agentRequests.length}</summary>
      <p>Input tokens add up across requests. Context messages show the history size sent for each request; they are not a token estimate.</p>
      {agentRequests.length > 0 && <div className="agent-request-list">{agentRequests.map((request) => <div className="agent-request-row" key={request.request_key}>
        <span>{request.agent_id}</span><code title={request.model ?? "Model unavailable"}>{request.model ?? "Model unavailable"}</code>
        <span>{request.context_message_count == null ? "Context unavailable" : `${new Intl.NumberFormat().format(request.context_message_count)} messages`}</span>
        {request.compaction_receipt_count > 0 && <span>{request.compaction_receipt_count} history {request.compaction_receipt_count === 1 ? "receipt" : "receipts"}</span>}
        <span>{new Intl.NumberFormat().format(request.input_tokens)} in · {new Intl.NumberFormat().format(request.output_tokens)} out</span>
        <small>{new Date(request.created_at).toLocaleString()}</small>
      </div>)}</div>}
    </details>}
  </section>;
}

function localDateTime(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

export function SchedulesView({ project, projects = [], schedules, agentsConfigured, workspace = false, desktopNotificationsOn = false, onEnableDesktopNotifications, onTestDesktopNotifications, onCreate, onEdit, onAction, onLoadMoreRuns, onRetryEventRun }) {
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dialogRef = useRef(null);
  const [selectedProjectId, setSelectedProjectId] = useState(project?.id ?? projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState("daily");
  const [triggerEventType, setTriggerEventType] = useState("repo.test_run.completed");
  const [eventPathPattern, setEventPathPattern] = useState("");
  const [eventExternalRepository, setEventExternalRepository] = useState("");
  const [eventAutoRetryLimit, setEventAutoRetryLimit] = useState("0");
  const [deliveryTime, setDeliveryTime] = useState("09:00");
  const [weeklyDays, setWeeklyDays] = useState(["1"]);
  const [monthlyDay, setMonthlyDay] = useState("1");
  const [hourlyStartHour, setHourlyStartHour] = useState("9");
  const [hourlyEndHour, setHourlyEndHour] = useState("17");
  const [cronParts, setCronParts] = useState(["0", "9", "*", "*", "MON-FRI"]);
  const [targetMissionId, setTargetMissionId] = useState("");
  const [eventSourceMissionId, setEventSourceMissionId] = useState("");
  const [editingTargetUnavailable, setEditingTargetUnavailable] = useState(false);
  const [runAt, setRunAt] = useState(() => {
    const value = new Date(Date.now() + 60 * 60 * 1000);
    value.setMinutes(0, 0, 0);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}T${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  });
  const [editingId, setEditingId] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState("");
  const [editingTimezone, setEditingTimezone] = useState("");
  const [pending, setPending] = useState(false);
  const [loadedRunPages, setLoadedRunPages] = useState({});
  const [loadingHistory, setLoadingHistory] = useState({});
  const [historyErrors, setHistoryErrors] = useState({});
  const [eventFailures, setEventFailures] = useState([]);
  const [eventFailureTotal, setEventFailureTotal] = useState(0);
  const [eventFailuresHaveMore, setEventFailuresHaveMore] = useState(false);
  const [eventFailuresLoading, setEventFailuresLoading] = useState(false);
  const [eventFailuresLoadingMore, setEventFailuresLoadingMore] = useState(false);
  const [eventFailuresError, setEventFailuresError] = useState("");
  const [eventFailureActionId, setEventFailureActionId] = useState("");
  const firstPageEventFailureIds = useRef(new Set());
  const [requestingNotifications, setRequestingNotifications] = useState(false);
  const [testingNotifications, setTestingNotifications] = useState(false);
  const selectedProject = project?.id === selectedProjectId
    ? project
    : projects.find((item) => item.id === selectedProjectId);
  const targetChats = (selectedProject?.missions ?? []).filter((item) => !item.archived_at);
  const scheduleTimezone = editingTimezone || localTimezone || "UTC";
  const eventRunRevision = schedules.filter((schedule) => schedule.cadence === "event")
    .map((schedule) => `${schedule.id}:${(schedule.runs ?? []).map((run) => `${run.id}:${run.status}`).join(",")}`)
    .join("|");
  useDialogFocus(dialogRef, formOpen);

  useEffect(() => {
    if (project?.id) setSelectedProjectId(project.id);
    else if (workspace && !projects.some((item) => item.id === selectedProjectId)) {
      setSelectedProjectId(projects[0]?.id ?? "");
    }
  }, [project?.id, workspace, projects, selectedProjectId]);

  function mergeEventFailurePage(result, preserveOlder = false) {
    const firstPage = result.failures ?? [];
    setEventFailures((current) => {
      const freshIds = new Set(firstPage.map((item) => item.id));
      const older = preserveOlder
        ? current.filter((item) => !firstPageEventFailureIds.current.has(item.id) && !freshIds.has(item.id))
        : [];
      firstPageEventFailureIds.current = freshIds;
      return [...firstPage, ...older];
    });
    setEventFailureTotal(result.total ?? 0);
    setEventFailuresHaveMore(Boolean(result.has_more));
  }

  const eventFailureProjectId = workspace ? "" : project?.id;
  useEffect(() => {
    if (!workspace && !eventFailureProjectId) return undefined;
    let current = true;
    setEventFailuresLoading(true);
    import("../api/runtime.js").then(({ runtime }) => runtime.listEventTriggerFailures(eventFailureProjectId)).then((result) => {
      if (!current) return;
      mergeEventFailurePage(result, true);
      setEventFailuresError("");
    }).catch((error) => {
      if (current) setEventFailuresError(error.message || "Event failures could not be loaded.");
    }).finally(() => { if (current) setEventFailuresLoading(false); });
    return () => { current = false; };
  }, [eventFailureProjectId, eventRunRevision, workspace]);

  async function refreshEventFailures() {
    setEventFailuresLoading(true);
    setEventFailuresError("");
    try {
      const { runtime } = await import("../api/runtime.js");
      const result = await runtime.listEventTriggerFailures(eventFailureProjectId);
      mergeEventFailurePage(result, false);
    } catch (error) {
      setEventFailuresError(error.message || "Event failures could not be loaded.");
    } finally {
      setEventFailuresLoading(false);
    }
  }

  async function loadMoreEventFailures() {
    if (eventFailuresLoadingMore || !eventFailuresHaveMore) return;
    const cursor = eventFailures.at(-1);
    if (!cursor) return;
    setEventFailuresLoadingMore(true);
    setEventFailuresError("");
    try {
      const { runtime } = await import("../api/runtime.js");
      const result = await runtime.listEventTriggerFailures(
        eventFailureProjectId, cursor.started_at, cursor.id,
      );
      setEventFailures((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...(result.failures ?? []).filter((item) => !seen.has(item.id))];
      });
      setEventFailureTotal(result.total ?? eventFailureTotal);
      setEventFailuresHaveMore(Boolean(result.has_more));
    } catch (error) {
      setEventFailuresError(error.message || "Older event failures could not be loaded.");
    } finally {
      setEventFailuresLoadingMore(false);
    }
  }

  async function retryQueuedEventFailure(failure) {
    setEventFailureActionId(failure.id);
    try {
      const queued = await onRetryEventRun?.(failure.project_id, failure.schedule_id, failure.id);
      if (queued) await refreshEventFailures();
    } finally {
      setEventFailureActionId("");
    }
  }

  async function dismissQueuedEventFailure(failure) {
    setEventFailureActionId(failure.id);
    setEventFailuresError("");
    try {
      const { runtime } = await import("../api/runtime.js");
      await runtime.dismissEventTriggerFailure(failure.project_id, failure.schedule_id, failure.id);
      await refreshEventFailures();
    } catch (error) {
      setEventFailuresError(error.message || "This event failure could not be dismissed.");
    } finally {
      setEventFailureActionId("");
    }
  }

  async function loadMoreRuns(schedule, runs) {
    if (!onLoadMoreRuns || loadingHistory[schedule.id]) return;
    const cursor = runs.at(-1);
    if (!cursor) return;
    setLoadingHistory((current) => ({ ...current, [schedule.id]: true }));
    setHistoryErrors((current) => ({ ...current, [schedule.id]: "" }));
    try {
      const result = await onLoadMoreRuns(schedule.id, cursor.started_at, cursor.id, 10);
      setLoadedRunPages((current) => {
        const previous = current[schedule.id] ?? schedule.runs ?? [];
        const seen = new Set(previous.map((run) => run.id));
        return {
          ...current,
          [schedule.id]: [...previous, ...result.runs.filter((run) => !seen.has(run.id))],
        };
      });
    } catch (error) {
      setHistoryErrors((current) => ({ ...current, [schedule.id]: error.message || "Run history could not be loaded." }));
    } finally {
      setLoadingHistory((current) => ({ ...current, [schedule.id]: false }));
    }
  }
  async function submit(event) {
    event.preventDefault();
    setPending(true);
    const cronExpression = scheduleCronExpression({ cadence, deliveryTime, weeklyDays, monthlyDay, hourlyStartHour, hourlyEndHour, cronParts });
    const result = editingId
      ? await onEdit(editingProjectId || selectedProjectId, editingId, title.trim(), prompt.trim(), cadence, editingTimezone, deliveryTime, cadence === "once" ? runAt : null, cronExpression, targetMissionId, cadence === "event" ? triggerEventType : "", cadence === "event" ? eventSourceMissionId : "", cadence === "event" && triggerEventType === "repo.file.changed" ? eventPathPattern.trim() : "", cadence === "event" ? Number(eventAutoRetryLimit) : 0, cadence === "event" && triggerEventType === "github.workflow_run.failed" ? eventExternalRepository.trim() : "")
      : await onCreate(project?.id ?? selectedProjectId, title.trim(), prompt.trim(), cadence, deliveryTime, cadence === "once" ? runAt : null, cronExpression, targetMissionId, cadence === "event" ? triggerEventType : "", cadence === "event" ? eventSourceMissionId : "", cadence === "event" && triggerEventType === "repo.file.changed" ? eventPathPattern.trim() : "", cadence === "event" ? Number(eventAutoRetryLimit) : 0, cadence === "event" && triggerEventType === "github.workflow_run.failed" ? eventExternalRepository.trim() : "");
    setPending(false);
    if (result) {
        setTitle(""); setPrompt(""); setEditingId(null); setEditingTimezone(""); setEditingProjectId(""); setTargetMissionId(""); setEventSourceMissionId(""); setTriggerEventType("repo.test_run.completed"); setEventPathPattern(""); setEventExternalRepository(""); setEventAutoRetryLimit("0");
      setEditingTargetUnavailable(false);
      setFormOpen(false);
    }
  }
  async function enableNotifications() {
    if (!onEnableDesktopNotifications || requestingNotifications) return;
    setRequestingNotifications(true);
    try { await onEnableDesktopNotifications(); }
    finally { setRequestingNotifications(false); }
  }
  async function testNotifications() {
    if (!onTestDesktopNotifications || testingNotifications) return;
    setTestingNotifications(true);
    try { await onTestDesktopNotifications(); }
    finally { setTestingNotifications(false); }
  }
  function startEditing(schedule) {
    const scheduleProject = project?.id === schedule.project_id
      ? project
      : projects.find((item) => item.id === schedule.project_id);
    setEditingId(schedule.id);
    setFormOpen(true);
    setEditingProjectId(schedule.project_id ?? project?.id ?? "");
    if (schedule.project_id) setSelectedProjectId(schedule.project_id);
    setEditingTimezone(schedule.timezone);
    setTitle(schedule.title);
    setPrompt(schedule.prompt);
    setWeeklyDays(["1"]);
    setMonthlyDay("1");
    setHourlyStartHour("9");
    setHourlyEndHour("17");
    const existingCron = schedule.cron_expression ?? "";
    const parsedCron = cronFields(existingCron);
    let editorCadence = schedule.cadence;
    if (existingCron && schedule.cadence === "weekly") {
      const days = selectedDaysFromCron(existingCron);
      if (days) setWeeklyDays(days);
      else editorCadence = "cron";
    } else if (existingCron && schedule.cadence === "monthly") {
      const day = monthlyDayFromCron(existingCron);
      if (day) setMonthlyDay(String(day));
      else editorCadence = "cron";
    } else if (existingCron && schedule.cadence === "hourly") {
      const window = hourWindowFromCron(existingCron);
      if (window) {
        setHourlyStartHour(String(window[0]));
        setHourlyEndHour(String(window[1]));
      } else editorCadence = "cron";
    } else if (existingCron && !["cron", "weekly", "monthly", "hourly"].includes(schedule.cadence)) {
      editorCadence = "cron";
    }
    if (editorCadence === "cron" && parsedCron) setCronParts(parsedCron);
    setCadence(editorCadence);
    setDeliveryTime(schedule.delivery_time);
    setTargetMissionId(schedule.target_mission_id ?? "");
    setEventSourceMissionId(schedule.event_source_mission_id ?? "");
    setTriggerEventType(schedule.trigger_event_type ?? "repo.test_run.completed");
    setEventPathPattern(schedule.event_path_pattern ?? "");
    setEventExternalRepository(schedule.event_external_repository ?? "");
    setEventAutoRetryLimit(String(schedule.event_auto_retry_limit ?? 0));
    setEditingTargetUnavailable(Boolean(schedule.target_mission_id
      && !(scheduleProject?.missions ?? []).some((item) => item.id === schedule.target_mission_id && !item.archived_at)));
    const suggestedRetryAt = new Date(Date.now() + 60 * 60 * 1000);
    suggestedRetryAt.setMinutes(0, 0, 0);
    setRunAt(localDateTime(
      schedule.status === "failed" && schedule.cadence === "once"
        ? suggestedRetryAt.toISOString() : schedule.next_run_at,
      schedule.timezone,
    ));
  }
  function openTemplate(template) {
    setEditingId(null);
    setTitle(template.title);
    setPrompt(template.prompt);
    setCadence(template.cadence);
    setTriggerEventType(template.triggerEventType ?? "repo.test_run.completed");
    setEventPathPattern("");
    setEventExternalRepository("");
    setEventAutoRetryLimit("0");
    setDeliveryTime("09:00");
    setWeeklyDays(["1"]);
    setMonthlyDay("1");
    setHourlyStartHour("9");
    setHourlyEndHour("17");
    setCronParts(["0", "9", "*", "*", "MON-FRI"]);
    setTargetMissionId("");
    setEventSourceMissionId("");
    setFormOpen(true);
  }
  function openNewSchedule() {
    setEditingId(null);
    setTitle("");
    setPrompt("");
    setCadence("daily");
    setTriggerEventType("repo.test_run.completed");
    setEventPathPattern("");
    setEventExternalRepository("");
    setEventAutoRetryLimit("0");
    setDeliveryTime("09:00");
    setWeeklyDays(["1"]);
    setMonthlyDay("1");
    setHourlyStartHour("9");
    setHourlyEndHour("17");
    setCronParts(["0", "9", "*", "*", "MON-FRI"]);
    setTargetMissionId("");
    setEventSourceMissionId("");
    setFormOpen(true);
  }
  function closeForm() {
    if (pending) return;
    setFormOpen(false);
    setEditingId(null);
    setEditingTimezone("");
    setEditingProjectId("");
    setTargetMissionId("");
    setEventPathPattern("");
    setEventExternalRepository("");
    setEventAutoRetryLimit("0");
    setTitle("");
    setPrompt("");
    setDeliveryTime("09:00");
    setCadence("daily");
    setWeeklyDays(["1"]);
    setMonthlyDay("1");
    setHourlyStartHour("9");
    setHourlyEndHour("17");
    setCronParts(["0", "9", "*", "*", "MON-FRI"]);
  }
  function handleDialogKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeForm();
    }
  }
  function toggleWeekday(day) {
    setWeeklyDays((current) => current.includes(day)
      ? current.length === 1 ? current : current.filter((value) => value !== day)
      : [...current, day]);
  }
  return <section className="tab-panel detail-view command-view schedule-view">
    <div className="detail-heading schedule-heading">
      <p>{workspace ? "Manage scheduled chats across your projects." : "Schedule a project chat to run once or repeat."} Tribe must be open with a connected model; paused chats and chats waiting for you hold their next run.</p>
      <div className="schedule-heading-actions">
        {workspace && typeof window !== "undefined" && window.__TAURI_INTERNALS__ && <div className="schedule-notification-control">
        {desktopNotificationsOn
          ? <><span>Desktop notifications enabled</span><button className="button button--quiet" disabled={testingNotifications} onClick={testNotifications} type="button">{testingNotifications ? "Sending…" : "Test notification"}</button></>
          : <button className="button button--quiet" disabled={requestingNotifications} onClick={enableNotifications} type="button"><BellSimple size={15} />{requestingNotifications ? "Requesting…" : "Enable desktop notifications"}</button>}
        </div>}
        {!formOpen && schedules.length > 0 && <button className="button button--primary" onClick={openNewSchedule} type="button"><Plus size={15} />New scheduled task</button>}
      </div>
    </div>
    {schedules.length === 0 && <div className="schedule-empty-state">
      <span className="schedule-empty-icon"><ClockCounterClockwise size={25} /></span>
      <h2>Schedule a task</h2>
      <p>Set up a recurring project check or a one-off task. Your schedules stay attached to their project.</p>
      <div className="schedule-template-grid">{scheduleTemplates.map((template) => {
        const TemplateIcon = template.icon;
        return <button className="schedule-template" key={template.title} onClick={() => openTemplate(template)} type="button">
          <span className="schedule-template-icon"><TemplateIcon size={18} /></span>
          <span><strong>{template.title}</strong><small>{template.description}</small></span>
        </button>;
      })}</div>
      <button className="button button--quiet schedule-start-from-scratch" onClick={openNewSchedule} type="button">Create from scratch</button>
    </div>}
    {formOpen && <div className="dialog-backdrop schedule-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeForm(); }} role="presentation">
      <form aria-labelledby="schedule-dialog-title" aria-modal="true" className="mission-dialog schedule-dialog" onKeyDown={handleDialogKeyDown} onSubmit={submit} ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="dialog-heading"><div><h2 id="schedule-dialog-title">{editingId ? "Edit scheduled task" : "Schedule a task"}</h2></div><button aria-label="Close" className="icon-button" disabled={pending} onClick={closeForm} type="button"><X size={17} /></button></div>
        {workspace && <div className="schedule-select-field schedule-select-field--project"><span>Project</span><SelectControl className="schedule-select--project" disabled={Boolean(editingId) || projects.length === 0} label="Project" onChange={setSelectedProjectId} options={projects.length ? projects.map((item) => ({ value: item.id, label: item.name })) : [{ value: "", label: "No projects available", disabled: true }]} size="full" value={selectedProjectId} /></div>}
        <label htmlFor="schedule-title">Task name<input autoFocus data-dialog-initial-focus id="schedule-title" maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Daily research brief" value={title} /></label>
        <label htmlFor="schedule-prompt">Instructions<textarea id="schedule-prompt" maxLength={10000} placeholder="What should the agents do?" rows={4} onChange={(event) => setPrompt(event.target.value)} value={prompt} /></label>
        <div className="schedule-timing-controls">
          <div className="schedule-select-row"><span>Repeat</span><SelectControl label="Repeat" onChange={setCadence} options={[{ value: "once", label: "Once" }, { value: "hourly", label: "Hourly" }, { value: "daily", label: "Daily" }, { value: "weekdays", label: "Weekdays" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }, { value: "cron", label: "Custom cron" }, { value: "event", label: "When an event occurs" }]} size="regular" value={cadence} /></div>
          {cadence === "event" && <div className="schedule-event-trigger">
            <div className="schedule-select-row"><span>Trigger</span><SelectControl label="Trigger" onChange={(value) => { setTriggerEventType(value); if (value !== "repo.file.changed") setEventPathPattern(""); if (value !== "github.workflow_run.failed") setEventExternalRepository(""); }} options={eventTriggerOptions} size="regular" value={triggerEventType} /></div>
            <p>{triggerEventType === "github.workflow_run.failed" ? "Tribe checks the public repository every 15 minutes while this device is open. Only run metadata is read; logs and source code are not fetched." : "Tribe watches this chat’s local activity. It coalesces matching events while a run is active and limits each trigger to one run every five minutes."}</p>
            {triggerEventType === "github.workflow_run.failed" && <label className="schedule-event-path-filter" htmlFor="schedule-event-github-repository"><span>Public GitHub repository</span><input autoComplete="url" id="schedule-event-github-repository" maxLength={300} onChange={(event) => setEventExternalRepository(event.target.value)} placeholder="owner/repository" spellCheck="false" value={eventExternalRepository} /><small>Enter owner/repository or a github.com repository URL. Project web access must allow api.github.com.</small></label>}
            <div className="schedule-select-field"><span>{triggerEventType === "github.workflow_run.failed" ? "Record events in chat" : "Watch chat"}</span><SelectControl className="schedule-select--target" label={triggerEventType === "github.workflow_run.failed" ? "Record events in chat" : "Watch chat"} onChange={(nextValue) => { setEventSourceMissionId(nextValue); if (nextValue === targetMissionId) setTargetMissionId(""); }} options={[{ value: "", label: "Choose a chat", disabled: true }, ...(selectedProject?.missions ?? []).filter((item) => !item.archived_at).map((item) => ({ value: item.id, label: item.title }))]} size="full" value={eventSourceMissionId} /></div>
            {triggerEventType === "repo.file.changed" && <label className="schedule-event-path-filter" htmlFor="schedule-event-path-pattern"><span>Path filter (optional)</span><input autoComplete="off" id="schedule-event-path-pattern" maxLength={500} onChange={(event) => setEventPathPattern(event.target.value)} placeholder="src/*.py" spellCheck="false" value={eventPathPattern} /><small>Use * and ? wildcards in a project-relative path. Leave blank to watch every file.</small></label>}
            <div className="schedule-select-row"><span>Automatic retries</span><SelectControl label="Automatic retries" onChange={setEventAutoRetryLimit} options={[{ value: "0", label: "Off · review failures" }, { value: "1", label: "Up to 1 retry" }, { value: "2", label: "Up to 2 retries" }]} size="regular" value={eventAutoRetryLimit} /></div>
            <p>Automatic retries run only when the attempt failed before a tool started or a final reply was produced. Other failures stay in Event runs for review. Retries wait 30 seconds, then 1 minute, and use the same role grants and approval mode.</p>
          </div>}
          {cadence === "once" && <div className="schedule-select-row schedule-one-off-row"><label htmlFor="schedule-run-date">Run at</label><div className="schedule-one-off-controls"><input aria-label="Run date" id="schedule-run-date" onChange={(event) => { const date = event.target.value; setRunAt(date ? `${date}T${runAt.slice(11, 16) || "09:00"}` : ""); }} type="date" value={runAt.slice(0, 10)} /><ScheduleTimeFields label="Run time" onChange={(time) => { const date = runAt.slice(0, 10); if (date) setRunAt(`${date}T${time}`); }} value={runAt.slice(11, 16)} /></div></div>}
          {cadence === "hourly" && <div className="schedule-hour-window"><div className="schedule-hour-select"><span>From</span><SelectControl className="schedule-select--hour" label="Start hour" onChange={setHourlyStartHour} options={hourOptions} size="narrow" value={hourlyStartHour} /></div><span aria-hidden="true">to</span><div className="schedule-hour-select"><span className="visually-hidden">To</span><SelectControl className="schedule-select--hour" label="End hour" onChange={setHourlyEndHour} options={hourOptions} size="narrow" value={hourlyEndHour} /></div></div>}
          {cadence === "weekly" && <div aria-label="Days of the week" className="schedule-weekdays" role="group">{WEEKDAYS.map((day) => <button aria-label={day.name} aria-pressed={weeklyDays.includes(day.value)} className={weeklyDays.includes(day.value) ? "schedule-weekday schedule-weekday--selected" : "schedule-weekday"} key={day.value} onClick={() => toggleWeekday(day.value)} type="button">{day.short}</button>)}</div>}
          {cadence === "monthly" && <div className="schedule-select-row"><span>Day of month</span><SelectControl className="schedule-select--day" label="Day of month" onChange={setMonthlyDay} options={Array.from({ length: 31 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))} size="compact" value={monthlyDay} /></div>}
          {["daily", "weekdays", "weekly", "monthly"].includes(cadence) && <div className="schedule-select-row"><span>Time</span><ScheduleTimeFields label="Run time" onChange={setDeliveryTime} value={deliveryTime} /></div>}
          {cadence === "cron" && <label className="schedule-timezone-row"><span>Timezone</span><span>{scheduleTimezone}</span></label>}
          {cadence === "cron" && <div className="schedule-cron-fields">{cronParts.map((part, index) => <label key={cronFieldLabels[index]} htmlFor={`schedule-cron-field-${index}`}><span>{cronFieldLabels[index]}</span><input autoComplete="off" id={`schedule-cron-field-${index}`} maxLength={32} onChange={(event) => setCronParts((current) => current.map((value, field) => field === index ? event.target.value : value))} placeholder={cronFieldHints[index]} spellCheck="false" value={part} /></label>)}</div>}
           <small>{cadence === "event" ? "Runs on this device while Tribe is open." : cadence === "hourly" ? "Runs at each hour in the window, including both ends; an earlier end time continues overnight." : cadence === "weekly" ? "Choose one or more days. Runs at the selected local time." : cadence === "monthly" ? "Runs on this date each month; months without that date are skipped." : cadence === "cron" ? "Five fields: minute, hour, day of month, month, day of week. Supports lists, ranges, steps and names such as JAN or MON." : `Local time${scheduleTimezone ? ` · ${scheduleTimezone}` : ""}`}</small>
        </div>
        <details className="schedule-advanced"><summary>Advanced</summary>
         <div className="schedule-select-field"><span>Run in</span><SelectControl className="schedule-select--target" label="Run in" onChange={(nextValue) => { setTargetMissionId(nextValue); setEditingTargetUnavailable(false); }} options={[{ value: "", label: "A new chat" }, ...(editingTargetUnavailable ? [{ value: targetMissionId, label: "Selected chat unavailable · choose another" }] : []), ...targetChats.filter((item) => cadence !== "event" || item.id !== eventSourceMissionId).map((item) => ({ value: item.id, label: `${item.title}${item.status === "completed" ? " · completed" : item.status === "paused" ? " · paused" : ""}` }))]} size="full" value={targetMissionId} /></div>
          {cadence === "cron" && <p>Examples: <code>0 9 * * MON-FRI</code> for weekdays at 09:00, or <code>*/15 8-17 * * 1-5</code> every 15 minutes on weekdays.</p>}
        </details>
         <div className="dialog-actions"><button className="button button--quiet" disabled={pending} onClick={closeForm} type="button">Cancel</button><button className="button button--primary" disabled={!(project?.id ?? selectedProjectId) || pending || !title.trim() || !prompt.trim() || (cadence === "once" && !runAt) || (cadence === "weekly" && weeklyDays.length === 0) || (cadence === "cron" && cronParts.some((part) => !part.trim())) || (cadence === "event" && (!eventSourceMissionId || targetMissionId === eventSourceMissionId || (triggerEventType === "github.workflow_run.failed" && !eventExternalRepository.trim())))} type="submit">{pending ? "Saving…" : editingId ? "Save changes" : "Create"}</button></div>
      </form>
    </div>}
    {schedules.some((schedule) => schedule.cadence === "event") && <EventTriggerFailureQueue
      actionId={eventFailureActionId}
      error={eventFailuresError}
      failures={eventFailures}
      hasMore={eventFailuresHaveMore}
      loading={eventFailuresLoading}
      loadingMore={eventFailuresLoadingMore}
      onDismiss={dismissQueuedEventFailure}
      onLoadMore={loadMoreEventFailures}
      onRefresh={refreshEventFailures}
      onRetry={retryQueuedEventFailure}
      total={eventFailureTotal}
      workspace={workspace}
    />}
    {schedules.length > 0 && <div className="command-list-heading"><h3>Your schedules</h3><span>{schedules.length} {schedules.length === 1 ? "schedule" : "schedules"}</span></div>}
    {schedules.length > 0 && <div className="command-run-list">
      {schedules.map((schedule) => {
        const { oneOffInProgress, statusLabel, nextRun } = schedulePresentation(schedule, agentsConfigured);
        const baseRuns = schedule.runs ?? [];
        const olderRuns = loadedRunPages[schedule.id] ?? baseRuns;
        const baseRunIds = new Set(baseRuns.map((run) => run.id));
        const runs = [...baseRuns, ...olderRuns.filter((run) => !baseRunIds.has(run.id))];
        const totalRuns = Math.max(schedule.runs_total ?? baseRuns.length, runs.length);
        return <article className="command-run" key={schedule.id}>
          <div className="command-run-status command-run-status--completed"><ClockCounterClockwise size={17} /></div>
          <div className="command-run-body">
            <div className="command-run-meta"><strong>{schedule.title}</strong><span>{statusLabel} · {schedule.cadence === "cron" ? "Custom" : schedule.cadence === "event" ? "Event trigger" : schedule.cadence}</span></div>
            {schedule.cron_expression && <small className="schedule-expression">{schedule.cron_expression}</small>}
            {workspace && <small>Project · {schedule.project_name}</small>}
            {schedule.cadence === "event" && <small>{eventTriggerOptions.find((option) => option.value === schedule.trigger_event_type)?.label ?? "When a project event occurs"} · {schedule.event_external_repository ? `${schedule.event_external_repository} · recorded in ` : ""}{schedule.event_source_mission_title ?? "Source chat unavailable"}{schedule.event_path_pattern ? ` · ${schedule.event_path_pattern}` : ""}{schedule.event_auto_retry_limit ? ` · Up to ${schedule.event_auto_retry_limit} automatic retries before work starts` : ""}</small>}
            {schedule.event_external_error && <small className="schedule-run-error">{externalTriggerStatusMessage(schedule.event_external_error)}</small>}
            {schedule.target_mission_id && <small>Chat · {schedule.target_mission_title ?? "Unavailable"}{schedule.target_mission_archived_at ? " · archived" : ""}</small>}
            <small>{nextRun}</small>
            <p>{schedule.prompt}</p>
            {totalRuns > 0 && <details className="schedule-history">
              <summary>Previous runs · {runs.length} of {totalRuns}</summary>
              {runs.map((run) => <div className="schedule-history-row" key={run.id}>
                <span>{runStatusLabels[run.status] ?? "Status unavailable"}</span>
                <span>{run.mission_title}</span>
                <small>{run.status === "queued" ? "Queued" : "Started"} {new Date(run.started_at).toLocaleString()}{run.finished_at ? ` · ended ${new Date(run.finished_at).toLocaleString()}` : run.status === "paused" ? " · paused" : run.status === "blocked" ? " · needs your input" : run.status === "queued" ? " · waiting for an agent" : run.status === "failed" ? " · failed" : run.status === "cancelled" ? " · stopped" : " · in progress"}</small>
                {run.status === "failed" && run.error && <small className="schedule-run-error">{run.error}</small>}
                {run.retry_of_run_id && <small>{run.retry_kind === "automatic" ? "Automatic retry attempt." : "This is a failed retry attempt."}</small>}
                {schedule.cadence === "event" && run.status === "failed" && run.source_event_sequence != null
                  && (run.has_retry
                    ? <small>This failed run already has a retry.</small>
                    : run.failure_reviewed
                      ? <small>This failure was dismissed after review.</small>
                      : <small>Needs review in Event runs.</small>)}
              </div>)}
              {historyErrors[schedule.id] && <p className="schedule-history-error" role="alert">{historyErrors[schedule.id]}</p>}
              {runs.length < totalRuns && <button className="button button--quiet schedule-history-more" disabled={loadingHistory[schedule.id]} onClick={() => loadMoreRuns(schedule, runs)} type="button">{loadingHistory[schedule.id] ? "Loading…" : "Load older runs"}</button>}
            </details>}
          </div>
          <div className="schedule-actions">
            <button aria-label={`Edit ${schedule.title}`} className="icon-button" disabled={schedule.runs?.some((run) => ["queued", "running", "paused", "blocked"].includes(run.status))} onClick={() => startEditing(schedule)} title="Edit schedule" type="button"><PencilSimple size={14} /></button>
            {!oneOffInProgress && <>
              {schedule.status === "active" && <button aria-label="Pause schedule" className="icon-button" onClick={() => onAction(schedule.project_id ?? project?.id, schedule.id, "pause")} title="Pause schedule" type="button"><Pause size={14} /></button>}
              {schedule.status === "paused" && <button aria-label="Resume schedule" className="icon-button" onClick={() => onAction(schedule.project_id ?? project?.id, schedule.id, "resume")} title="Resume schedule" type="button"><Play size={14} /></button>}
              {["active", "failed"].includes(schedule.status) && <button aria-label={schedule.status === "failed" ? "Retry schedule" : "Run schedule now"} className="icon-button" onClick={() => onAction(schedule.project_id ?? project?.id, schedule.id, "run-now")} title={schedule.status === "failed" ? "Retry now" : "Run now"} type="button"><ArrowClockwise size={14} /></button>}
              {["active", "paused"].includes(schedule.status) && <button aria-label="Cancel schedule" className="icon-button" onClick={() => onAction(schedule.project_id ?? project?.id, schedule.id, "cancel")} title="Cancel schedule" type="button"><X size={14} /></button>}
            </>}
          </div>
        </article>;
      })}
    </div>}
  </section>;
}

