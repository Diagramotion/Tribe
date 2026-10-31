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
];
const hourOptions = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: `${String(hour).padStart(2, "0")}:00` }));
const clockHourOptions = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour).padStart(2, "0"), label: String(hour).padStart(2, "0") }));
const minuteOptions = Array.from({ length: 60 }, (_, minute) => ({ value: String(minute).padStart(2, "0"), label: String(minute).padStart(2, "0") }));
const cronFieldLabels = ["Minute", "Hour", "Day of month", "Month", "Day of week"];
const cronFieldHints = ["0–59", "0–23", "1–31", "1–12 or JAN–DEC", "0–6 or SUN–SAT"];

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

export function SchedulesView({ project, projects = [], schedules, agentsConfigured, workspace = false, desktopNotificationsOn = false, onEnableDesktopNotifications, onTestDesktopNotifications, onCreate, onEdit, onAction, onLoadMoreRuns }) {
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dialogRef = useRef(null);
  const [selectedProjectId, setSelectedProjectId] = useState(project?.id ?? projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState("daily");
  const [deliveryTime, setDeliveryTime] = useState("09:00");
  const [weeklyDays, setWeeklyDays] = useState(["1"]);
  const [monthlyDay, setMonthlyDay] = useState("1");
  const [hourlyStartHour, setHourlyStartHour] = useState("9");
  const [hourlyEndHour, setHourlyEndHour] = useState("17");
  const [cronParts, setCronParts] = useState(["0", "9", "*", "*", "MON-FRI"]);
  const [targetMissionId, setTargetMissionId] = useState("");
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
  const [requestingNotifications, setRequestingNotifications] = useState(false);
  const [testingNotifications, setTestingNotifications] = useState(false);
  const selectedProject = project?.id === selectedProjectId
    ? project
    : projects.find((item) => item.id === selectedProjectId);
  const targetChats = (selectedProject?.missions ?? []).filter((item) => !item.archived_at);
  const scheduleTimezone = editingTimezone || localTimezone || "UTC";
  useDialogFocus(dialogRef, formOpen);

  useEffect(() => {
    if (project?.id) setSelectedProjectId(project.id);
    else if (workspace && !projects.some((item) => item.id === selectedProjectId)) {
      setSelectedProjectId(projects[0]?.id ?? "");
    }
  }, [project?.id, workspace, projects, selectedProjectId]);

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
      ? await onEdit(editingProjectId || selectedProjectId, editingId, title.trim(), prompt.trim(), cadence, editingTimezone, deliveryTime, cadence === "once" ? runAt : null, cronExpression, targetMissionId)
      : await onCreate(project?.id ?? selectedProjectId, title.trim(), prompt.trim(), cadence, deliveryTime, cadence === "once" ? runAt : null, cronExpression, targetMissionId);
    setPending(false);
    if (result) {
      setTitle(""); setPrompt(""); setEditingId(null); setEditingTimezone(""); setEditingProjectId(""); setTargetMissionId("");
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
    setDeliveryTime("09:00");
    setWeeklyDays(["1"]);
    setMonthlyDay("1");
    setHourlyStartHour("9");
    setHourlyEndHour("17");
    setCronParts(["0", "9", "*", "*", "MON-FRI"]);
    setTargetMissionId("");
    setFormOpen(true);
  }
  function openNewSchedule() {
    setEditingId(null);
    setTitle("");
    setPrompt("");
    setCadence("daily");
    setDeliveryTime("09:00");
    setWeeklyDays(["1"]);
    setMonthlyDay("1");
    setHourlyStartHour("9");
    setHourlyEndHour("17");
    setCronParts(["0", "9", "*", "*", "MON-FRI"]);
    setTargetMissionId("");
    setFormOpen(true);
  }
  function closeForm() {
    if (pending) return;
    setFormOpen(false);
    setEditingId(null);
    setEditingTimezone("");
    setEditingProjectId("");
    setTargetMissionId("");
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
          <div className="schedule-select-row"><span>Repeat</span><SelectControl label="Repeat" onChange={setCadence} options={[{ value: "once", label: "Once" }, { value: "hourly", label: "Hourly" }, { value: "daily", label: "Daily" }, { value: "weekdays", label: "Weekdays" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }, { value: "cron", label: "Custom cron" }]} size="regular" value={cadence} /></div>
          {cadence === "once" && <div className="schedule-select-row schedule-one-off-row"><label htmlFor="schedule-run-date">Run at</label><div className="schedule-one-off-controls"><input aria-label="Run date" id="schedule-run-date" onChange={(event) => { const date = event.target.value; setRunAt(date ? `${date}T${runAt.slice(11, 16) || "09:00"}` : ""); }} type="date" value={runAt.slice(0, 10)} /><ScheduleTimeFields label="Run time" onChange={(time) => { const date = runAt.slice(0, 10); if (date) setRunAt(`${date}T${time}`); }} value={runAt.slice(11, 16)} /></div></div>}
          {cadence === "hourly" && <div className="schedule-hour-window"><div className="schedule-hour-select"><span>From</span><SelectControl className="schedule-select--hour" label="Start hour" onChange={setHourlyStartHour} options={hourOptions} size="narrow" value={hourlyStartHour} /></div><span aria-hidden="true">to</span><div className="schedule-hour-select"><span className="visually-hidden">To</span><SelectControl className="schedule-select--hour" label="End hour" onChange={setHourlyEndHour} options={hourOptions} size="narrow" value={hourlyEndHour} /></div></div>}
          {cadence === "weekly" && <div aria-label="Days of the week" className="schedule-weekdays" role="group">{WEEKDAYS.map((day) => <button aria-label={day.name} aria-pressed={weeklyDays.includes(day.value)} className={weeklyDays.includes(day.value) ? "schedule-weekday schedule-weekday--selected" : "schedule-weekday"} key={day.value} onClick={() => toggleWeekday(day.value)} type="button">{day.short}</button>)}</div>}
          {cadence === "monthly" && <div className="schedule-select-row"><span>Day of month</span><SelectControl className="schedule-select--day" label="Day of month" onChange={setMonthlyDay} options={Array.from({ length: 31 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))} size="compact" value={monthlyDay} /></div>}
          {["daily", "weekdays", "weekly", "monthly"].includes(cadence) && <div className="schedule-select-row"><span>Time</span><ScheduleTimeFields label="Run time" onChange={setDeliveryTime} value={deliveryTime} /></div>}
          {cadence === "cron" && <label className="schedule-timezone-row"><span>Timezone</span><span>{scheduleTimezone}</span></label>}
          {cadence === "cron" && <div className="schedule-cron-fields">{cronParts.map((part, index) => <label key={cronFieldLabels[index]} htmlFor={`schedule-cron-field-${index}`}><span>{cronFieldLabels[index]}</span><input autoComplete="off" id={`schedule-cron-field-${index}`} maxLength={32} onChange={(event) => setCronParts((current) => current.map((value, field) => field === index ? event.target.value : value))} placeholder={cronFieldHints[index]} spellCheck="false" value={part} /></label>)}</div>}
          <small>{cadence === "hourly" ? "Runs at each hour in the window, including both ends; an earlier end time continues overnight." : cadence === "weekly" ? "Choose one or more days. Runs at the selected local time." : cadence === "monthly" ? "Runs on this date each month; months without that date are skipped." : cadence === "cron" ? "Five fields: minute, hour, day of month, month, day of week. Supports lists, ranges, steps and names such as JAN or MON." : `Local time${scheduleTimezone ? ` · ${scheduleTimezone}` : ""}`}</small>
        </div>
        <details className="schedule-advanced"><summary>Advanced</summary>
          <div className="schedule-select-field"><span>Run in</span><SelectControl className="schedule-select--target" label="Run in" onChange={(nextValue) => { setTargetMissionId(nextValue); setEditingTargetUnavailable(false); }} options={[{ value: "", label: "A new chat" }, ...(editingTargetUnavailable ? [{ value: targetMissionId, label: "Selected chat unavailable · choose another" }] : []), ...targetChats.map((item) => ({ value: item.id, label: `${item.title}${item.status === "completed" ? " · completed" : item.status === "paused" ? " · paused" : ""}` }))]} size="full" value={targetMissionId} /></div>
          {cadence === "cron" && <p>Examples: <code>0 9 * * MON-FRI</code> for weekdays at 09:00, or <code>*/15 8-17 * * 1-5</code> every 15 minutes on weekdays.</p>}
        </details>
        <div className="dialog-actions"><button className="button button--quiet" disabled={pending} onClick={closeForm} type="button">Cancel</button><button className="button button--primary" disabled={!(project?.id ?? selectedProjectId) || pending || !title.trim() || !prompt.trim() || (cadence === "once" && !runAt) || (cadence === "weekly" && weeklyDays.length === 0) || (cadence === "cron" && cronParts.some((part) => !part.trim()))} type="submit">{pending ? "Saving…" : editingId ? "Save changes" : "Create"}</button></div>
      </form>
    </div>}
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
            <div className="command-run-meta"><strong>{schedule.title}</strong><span>{statusLabel} · {schedule.cadence === "cron" ? "Custom" : schedule.cadence}</span></div>
            {schedule.cron_expression && <small className="schedule-expression">{schedule.cron_expression}</small>}
            {workspace && <small>{schedule.project_name}</small>}
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
              </div>)}
              {historyErrors[schedule.id] && <p className="schedule-history-error" role="alert">{historyErrors[schedule.id]}</p>}
              {runs.length < totalRuns && <button className="button button--quiet schedule-history-more" disabled={loadingHistory[schedule.id]} onClick={() => loadMoreRuns(schedule, runs)} type="button">{loadingHistory[schedule.id] ? "Loading…" : "Load older runs"}</button>}
            </details>}
          </div>
          <div className="schedule-actions">
            <button aria-label={`Edit ${schedule.title}`} className="icon-button" disabled={schedule.runs?.some((run) => ["running", "paused", "blocked"].includes(run.status))} onClick={() => startEditing(schedule)} title="Edit schedule" type="button"><PencilSimple size={14} /></button>
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

