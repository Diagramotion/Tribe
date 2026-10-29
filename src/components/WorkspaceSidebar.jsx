import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CaretDown, CaretRight, ChatCircleDots, ClockCounterClockwise, DotsThree,
  FileText, FolderOpen, FolderSimple, Gear, GitBranch, Plus, Sparkle, Trash, UsersThree,
} from "@phosphor-icons/react";
import { compactChatTitle } from "../domain/chat-title.js";
import { missionStatusLabel } from "../domain/labels.js";

export function IconButton({ label, className = "", children, ...props }) {
  return (
    <button
      aria-label={label}
      className={`icon-button ${className}`.trim()}
      title={label}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

export function Sidebar({ activeTab, collapsed, onNavigate, onSelectProject, onSelectMission, onCreateProject, onCreateMission, onOpenProjectSettings, onArchiveMission, onRestoreMission, onDeleteMission, onDeleteProject, project, mission, projects }) {
  const [expandedProjects, setExpandedProjects] = useState(() => new Set(project?.id ? [project.id] : []));
  const [expandedArchived, setExpandedArchived] = useState(new Set());
  const [projectQuery, setProjectQuery] = useState("");
  const [openMenu, setOpenMenu] = useState(null);
  function toggleMenu(key, event) {
    if (openMenu?.key === key) { setOpenMenu(null); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 220;
    setOpenMenu({ key, trigger: event.currentTarget, left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 190)) });
  }
  function toggleProject(itemId) {
    setExpandedProjects((current) => {
      const next = new Set(current);
      next.has(itemId) ? next.delete(itemId) : next.add(itemId);
      return next;
    });
  }
  useEffect(() => {
    function dismissMenu(event) {
      if (event.type === "pointerdown" && event.target.closest?.(".explorer-menu-trigger, .explorer-context-menu")) return;
      setOpenMenu(null);
    }
    function dismissOnEscape(event) { if (event.key === "Escape") setOpenMenu(null); }
    document.addEventListener("pointerdown", dismissMenu);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("resize", dismissMenu);
    window.addEventListener("scroll", dismissMenu, true);
    return () => {
      document.removeEventListener("pointerdown", dismissMenu);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("resize", dismissMenu);
      window.removeEventListener("scroll", dismissMenu, true);
    };
  }, []);
  const workspaceItems = [
    { label: "Skills", icon: Sparkle, tab: "Skills" },
    { label: "Workflows", icon: GitBranch, tab: "Recipes" },
  ];
  const visibleProjects = projects.filter((item) => `${item.name} ${item.repository} ${(item.missions ?? []).map((session) => session.title).join(" ")}`.toLowerCase().includes(projectQuery.trim().toLowerCase()));

  return (
    <aside className={`sidebar ${collapsed ? "sidebar--collapsed" : ""}`}>
      <div className="brand-row">
        <span className="brand-mark" aria-hidden="true"><UsersThree size={23} weight="fill" /></span>
        {!collapsed && <span className="brand-name">Tribe</span>}
      </div>

      {!collapsed && <section className="project-explorer" aria-label="Project explorer">
        <div className="project-explorer-heading"><span className="sidebar-section-label">Project explorer</span><button aria-label="Add project" className="explorer-add" onClick={onCreateProject} title="Add project" type="button"><Plus size={15} /></button></div>
        <input aria-label="Filter projects" className="project-explorer-search" onChange={(event) => setProjectQuery(event.target.value)} placeholder="Find a project" value={projectQuery} />
        {project.id && <button className="explorer-new-mission project-new-mission" onClick={() => onCreateMission(project)} type="button"><ChatCircleDots size={15} /> New chat</button>}
        <div className="project-explorer-list">
          {visibleProjects.map((item) => <div className="explorer-project" key={item.id}>
            <div className={`explorer-project-row ${project.id === item.id ? "explorer-project-row--selected" : ""}`} onClick={() => toggleProject(item.id)}>
              <button aria-label={`${expandedProjects.has(item.id) ? "Collapse" : "Expand"} ${item.name}`} aria-expanded={expandedProjects.has(item.id)} className="explorer-disclosure" type="button">{expandedProjects.has(item.id) ? <FolderOpen size={15} /> : <FolderSimple size={15} />}</button>
              <button aria-current={project.id === item.id ? "page" : undefined} className={`explorer-project-button ${project.id === item.id ? "explorer-project-button--selected" : ""}`} onClick={() => onSelectProject(item)} title={item.repository} type="button"><span>{item.name}</span><small>{item.missions?.length ?? 0}</small></button>
              <div className="explorer-menu-wrap">
                <button aria-expanded={openMenu?.key === `project-${item.id}`} aria-label={`More actions for ${item.name}`} className="explorer-menu-trigger" onClick={(event) => { event.stopPropagation(); toggleMenu(`project-${item.id}`, event); }} title={`More actions for ${item.name}`} type="button"><DotsThree size={17} weight="bold" /></button>
                {openMenu?.key === `project-${item.id}` && createPortal(<div className="explorer-context-menu" onClick={(event) => event.stopPropagation()} role="menu" style={{ left: openMenu.left, top: openMenu.top }}>
                  <button onClick={() => { setOpenMenu(null); onCreateMission(item); }} role="menuitem" type="button"><ChatCircleDots size={15} />New chat</button>
                  <button onClick={() => { setOpenMenu(null); onOpenProjectSettings?.(item, openMenu?.trigger); }} role="menuitem" type="button"><Gear size={15} />Project settings</button>
                  {item.repository && <button onClick={() => { setOpenMenu(null); onSelectProject(item); onNavigate("Code"); }} role="menuitem" type="button"><FolderSimple size={15} />Open repository</button>}
                  <div className="explorer-context-menu-divider" />
                  <button className="explorer-context-menu-danger" onClick={() => { setOpenMenu(null); onDeleteProject(item.id); }} role="menuitem" type="button"><Trash size={15} />Delete project</button>
                </div>, document.body)}
              </div>
            </div>
            {expandedProjects.has(item.id) && <div className="explorer-missions">
              {(item.missions ?? []).filter((session) => !session.archived_at).map((session) => {
                const statusLabel = missionStatusLabel(session.status);
                const displayTitle = compactChatTitle(session.title);
                return <div className="explorer-chat-row" key={session.id}>
                <button aria-current={mission?.id === session.id ? "page" : undefined} aria-label={`Open chat: ${displayTitle} · ${statusLabel}`} className={`explorer-mission ${mission?.id === session.id ? "explorer-mission--selected" : ""}`} onClick={() => onSelectMission(session.id, item)} title={`${session.title} · ${statusLabel}`} type="button"><i aria-hidden="true" className={`explorer-mission-dot explorer-mission-dot--${session.status}`} /><span>{displayTitle}</span></button>
                <div className="explorer-menu-wrap">
                  <button aria-expanded={openMenu?.key === `chat-${session.id}`} aria-label={`More actions for ${displayTitle}`} className="explorer-menu-trigger" onClick={(event) => toggleMenu(`chat-${session.id}`, event)} title={`More actions for ${displayTitle}`} type="button"><DotsThree size={17} weight="bold" /></button>
                  {openMenu?.key === `chat-${session.id}` && createPortal(<div className="explorer-context-menu" role="menu" style={{ left: openMenu.left, top: openMenu.top }}>
                    <button onClick={() => { setOpenMenu(null); onSelectMission(session.id, item); }} role="menuitem" type="button"><ChatCircleDots size={15} />Open chat</button>
                    <button onClick={() => { setOpenMenu(null); onCreateMission(item); }} role="menuitem" type="button"><Plus size={15} />New chat in {item.name}</button>
                    <button onClick={() => { setOpenMenu(null); onArchiveMission(session.id); }} role="menuitem" type="button"><ClockCounterClockwise size={15} />{session.status === "active" ? "Pause and archive chat" : "Archive chat"}</button>
                    <button className="explorer-context-menu-danger" onClick={() => { setOpenMenu(null); onDeleteMission(session.id); }} role="menuitem" type="button"><Trash size={15} />Delete permanently</button>
                  </div>, document.body)}
                </div>
              </div>;
              })}
              {(item.missions ?? []).some((session) => session.archived_at) && <>
                <button aria-expanded={expandedArchived.has(item.id)} className="explorer-archived-toggle" onClick={() => setExpandedArchived((current) => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; })} type="button">{expandedArchived.has(item.id) ? <CaretDown size={13} /> : <CaretRight size={13} />} Archived chats <small>{item.missions.filter((session) => session.archived_at).length}</small></button>
                {expandedArchived.has(item.id) && (item.missions ?? []).filter((session) => session.archived_at).map((session) => <div className="explorer-chat-row" key={session.id}>
                  <button aria-current={mission?.id === session.id ? "page" : undefined} aria-label={`Open archived chat: ${compactChatTitle(session.title)}`} className={`explorer-mission explorer-mission--archived ${mission?.id === session.id ? "explorer-mission--selected" : ""}`} onClick={() => onSelectMission(session.id, item)} title={`${session.title} · Archived`} type="button"><i className="explorer-mission-dot explorer-mission-dot--archived" /><span>{compactChatTitle(session.title)}</span></button>
                  <div className="explorer-menu-wrap"><button aria-expanded={openMenu?.key === `chat-${session.id}`} aria-label={`More actions for ${session.title}`} className="explorer-menu-trigger" onClick={(event) => toggleMenu(`chat-${session.id}`, event)} title={`More actions for ${session.title}`} type="button"><DotsThree size={17} weight="bold" /></button>
                    {openMenu?.key === `chat-${session.id}` && createPortal(<div className="explorer-context-menu" role="menu" style={{ left: openMenu.left, top: openMenu.top }}>
                      <button onClick={() => { setOpenMenu(null); onCreateMission(item); }} role="menuitem" type="button"><Plus size={15} />New chat in {item.name}</button>
                      <button onClick={() => { setOpenMenu(null); onRestoreMission(session.id); }} role="menuitem" type="button"><ClockCounterClockwise size={15} />Restore chat</button>
                      <button className="explorer-context-menu-danger" onClick={() => { setOpenMenu(null); onDeleteMission(session.id); }} role="menuitem" type="button"><Trash size={15} />Delete permanently</button>
                    </div>, document.body)}
                  </div>
                </div>)}
              </>}
            </div>}
          </div>)}
          {projects.length === 0 && <div className="explorer-empty"><strong>No projects yet</strong><span>Add a Git repository to create a project and start a chat.</span></div>}
          {projects.length > 0 && visibleProjects.length === 0 && <p className="explorer-empty">No projects match “{projectQuery}”.</p>}
        </div>
      </section>}

      <nav className="sidebar-nav" aria-label="Workspace navigation">
        {collapsed && <div aria-label="Quick actions" className="sidebar-nav-group sidebar-nav-group--quick" role="group">
          <button aria-label={project.id ? "New chat" : "Choose a project to start a chat"} className="nav-item" disabled={!project.id} onClick={() => onCreateMission(project)} title={project.id ? "New chat" : "Choose a project to start a chat"} type="button"><ChatCircleDots size={19} /></button>
        </div>}
        <div aria-label="Workspace" className="sidebar-nav-group sidebar-nav-group--workspace" role="group">
          {!collapsed && <span className="sidebar-section-label sidebar-nav-heading">Workspace</span>}
          {workspaceItems.map(({ label, icon: Icon, tab }) => (
            <button
              className={`nav-item ${activeTab === tab ? "nav-item--selected" : ""}`}
              key={label}
              onClick={() => onNavigate(tab)}
              title={collapsed ? label : undefined}
              type="button"
            >
              <Icon size={19} weight={activeTab === tab ? "fill" : "regular"} />
              {!collapsed && <span>{label}</span>}
            </button>
          ))}
        </div>
      </nav>

      <div className="sidebar-footer">
        <button
          aria-label="Settings"
          className={`nav-item ${activeTab === "Settings" ? "nav-item--selected" : ""}`}
          onClick={() => onNavigate("Settings")}
          title={collapsed ? "Settings" : undefined}
          type="button"
        >
          <Gear size={19} weight={activeTab === "Settings" ? "fill" : "regular"} />
          {!collapsed && <span>Settings</span>}
        </button>
      </div>

    </aside>
  );
}

