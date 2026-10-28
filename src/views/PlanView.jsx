import {
  ArrowSquareOut, CaretRight, ListChecks, PencilSimple, Plus,
} from "@phosphor-icons/react";
import { summariseTeamWork } from "../domain/plan.js";
import { agentStatusLabel } from "../domain/labels.js";

export function PlanView({ workItems, agents, project, mission, agentConfigured, onSelectWork, onEditProjectGoal, onConnectModel }) {
  const columns = ["Ready", "Blocked", "In progress", "In review", "Done"];
  const team = summariseTeamWork(agents, workItems);
  const completedCount = workItems.filter((item) => item.status === "Done").length;
  const activeAgentCount = team.filter((agent) => agent.activeItems.length > 0).length;
  const hasProjectGoal = Boolean(project.goal?.trim());
  const hasDistinctMissionGoal = Boolean(mission.goal?.trim())
    && mission.goal.replace(/[.!?]+$/, "").trim().toLowerCase() !== mission.title?.replace(/[.!?]+$/, "").trim().toLowerCase();
  return (
    <section className={`tab-panel plan-view ${workItems.length === 0 ? "plan-view--empty" : ""}`}>
      <div className="tab-panel-header">
        <div>
          <span className="eyebrow">Project goal</span>
          <h2 className="plan-project-goal">{hasProjectGoal ? project.goal : "No project goal set"}</h2>
          {!hasProjectGoal && <p>Add a shared goal to guide work across this project’s chats.</p>}
          {project.referenceFiles?.length > 0 && <div className="project-reference-list" aria-label="Linked project reference files"><span>Project references</span>{project.referenceFiles.map((path) => <code key={path}>{path}</code>)}</div>}
          {hasDistinctMissionGoal && <details className="plan-mission-context"><summary><CaretRight size={13} />View original chat request</summary><p>{mission.goal}</p></details>}
        </div>
        <div className="plan-heading-actions">
          <button aria-label={hasProjectGoal ? "Edit project goal" : "Set project goal"} className="icon-button" onClick={() => onEditProjectGoal()} title={hasProjectGoal ? "Edit goal" : "Set goal"} type="button">{hasProjectGoal ? <PencilSimple size={15} /> : <Plus size={15} />}</button>
          <span className="plan-updated"><ListChecks size={15} /> Agents maintain this plan</span>
        </div>
      </div>
      {workItems.length > 0 && <section className="team-overview" aria-label="Agent work summary">
        <div className="team-overview-heading">
          <h3>Team activity</h3>
          <span>{activeAgentCount} agents working · {completedCount} of {workItems.length} tasks complete</span>
        </div>
        <div className="team-overview-grid">
          {team.map((agent) => (
            <article className="team-overview-card" key={agent.id}>
              <div className="team-overview-card-heading">
                <span className="small-avatar">{agent.name.slice(0, 1)}</span>
                <span><strong>{agent.name}</strong><small>{agentStatusLabel(agent.runtimeStatus)}</small></span>
              </div>
              {agent.activeItems.length > 0
                ? <div className="team-overview-focus"><span>Working on</span><strong>{agent.activeItems.map((item) => item.title).join(" · ")}</strong></div>
                : <div className="team-overview-focus"><span>Current focus</span><strong>{agent.blockedItems.length ? `Waiting on ${agent.blockedItems[0].title}` : agent.readyCount ? `${agent.readyCount} tasks ready` : agent.totalCount ? "No task in progress" : "No tasks yet"}</strong></div>}
              <div className="team-overview-counts">
                <span>{agent.activeItems.length} active</span>
                <span>{agent.readyCount} ready</span>
                <span className={agent.blockedItems.length ? "team-overview-blocked" : ""}>{agent.blockedItems.length} blocked</span>
                <span>{agent.completedCount} done</span>
              </div>
            </article>
          ))}
        </div>
      </section>}
      {workItems.length === 0 ? <div className="plan-empty plan-empty--state">
        <span className="plan-empty-icon"><ListChecks size={19} /></span>
        <div><h3>No task plan yet</h3><p>{agentConfigured
          ? "The Planner will add tasks here when the work needs them."
          : "Connect a model to let the Planner create tasks. Your chat and project goal are saved."
        }</p></div>
        {!agentConfigured && <button className="button button--quiet" onClick={onConnectModel} type="button">Connect model</button>}
      </div> : <div className="kanban-board">
        {columns.map((column) => {
          const items = workItems.filter((item) => item.status === column);
          return (
            <section className="kanban-column" key={column}>
              <div className="kanban-heading"><span className={`status-dot status-dot--${column.toLowerCase().replaceAll(" ", "-")}`} /><h3>{column}</h3><span>{items.length}</span></div>
              {items.map((item) => (
                <button className="work-card" key={item.id} onClick={() => onSelectWork(item)} type="button">
                  <div className="work-card-top"><span className="work-tag">{item.tag}</span></div>
                  <strong>{item.title}</strong>
                  <p>{item.detail}</p>
                  {item.blockedBy.length > 0 && <span className="work-card-blocked">Waiting for {item.blockedBy.map((id) => item.dependencies.find((dependency) => dependency.id === id)?.title ?? id.slice(0, 8)).join(", ")}</span>}
                  <div className="work-card-footer"><span className="small-avatar">{item.owner.slice(0, 1)}</span><span>{agents.find((agent) => agent.id === item.owner)?.name ?? item.owner}</span><span className="work-card-arrow"><ArrowSquareOut size={14} /></span></div>
                </button>
              ))}
              {items.length === 0 && <div className="column-empty">Nothing in this stage</div>}
            </section>
          );
        })}
      </div>}
    </section>
  );
}

