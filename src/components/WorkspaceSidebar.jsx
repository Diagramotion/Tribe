import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CaretDown, CaretRight, ChatCircleDots, ClockCounterClockwise, DotsThree,
  FileText, FolderOpen, FolderSimple, Gear, GitBranch, Globe, PaintBrush, Plus, PushPin, Sparkle, Trash,
} from "@phosphor-icons/react";
import tribeMark from "../assets/tribe-mark.svg";
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

function ExplorerRowButton({ leading, trailing, className = "", children, ...props }) {
  return (
    <button className={`explorer-row-button ${className}`.trim()} type="button" {...props}>
      {leading && <span className="explorer-row-leading" aria-hidden="true">{leading}</span>}
      <span className="explorer-row-label">{children}</span>
      {trailing}
    </button>
  );
}

export function Sidebar({ activeTab, collapsed, onNavigate, onSelectProject, onSelectMission, onSelectGeneralChat, onCreateGeneralChat, selectedGeneralChat, generalChats = [], onCreateProject, onCreateMission, onOpenProjectSettings, onArchiveMission, onRestoreMission, onDeleteMission, onDeleteProject, project, mission, projects }) {
  const pinnedStorageKey = "tribe.sidebar.pinned-items";
  const [expandedProjects, setExpandedProjects] = useState(() => new Set(project?.id ? [project.id] : []));
  const [expandedArchived, setExpandedArchived] = useState(new Set());
  const [projectQuery, setProjectQuery] = useState("");
  const [openMenu, setOpenMenu] = useState(null);
  const [showAllRecentChats, setShowAllRecentChats] = useState(false);
  const [pinnedItems, setPinnedItems] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(pinnedStorageKey) ?? "[]");
      return Array.isArray(saved) ? saved.filter((item) => typeof item === "string") : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try { window.localStorage.setItem(pinnedStorageKey, JSON.stringify(pinnedItems)); } catch { /* Pins remain available for this session. */ }
  }, [pinnedItems]);
  function isPinned(type, id) { return pinnedItems.includes(`${type}:${id}`); }
  function togglePin(type, id) {
    const key = `${type}:${id}`;
    setPinnedItems((current) => current.includes(key) ? current.filter((item) => item !== key) : [key, ...current]);
  }
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
    { label: "Browser", icon: Globe, tab: "Browser" },
    { label: "Scheduled tasks", icon: ClockCounterClockwise, tab: "WorkspaceSchedules" },
    { label: "Design systems", icon: PaintBrush, tab: "DesignSystems" },
    { label: "Skills", icon: Sparkle, tab: "Skills" },
    { label: "Workflows", icon: GitBranch, tab: "Recipes" },
  ];
  const query = projectQuery.trim().toLowerCase();
  const visibleProjects = [...projects]
    .filter((item) => `${item.name} ${item.repository} ${(item.missions ?? []).map((session) => session.title).join(" ")}`.toLowerCase().includes(query))
    .sort((a, b) => Number(isPinned("project", b.id)) - Number(isPinned("project", a.id)) || pinnedItems.indexOf(`project:${a.id}`) - pinnedItems.indexOf(`project:${b.id}`));
  const sortedGeneralChats = [...generalChats]
    .filter((chat) => chat.title.toLowerCase().includes(query))
    .sort((a, b) => {
      const aPin = pinnedItems.indexOf(`chat:${a.id}`);
      const bPin = pinnedItems.indexOf(`chat:${b.id}`);
      if (aPin !== -1 || bPin !== -1) return aPin === -1 ? 1 : bPin === -1 ? -1 : aPin - bPin;
      return Date.parse(b.updated_at ?? b.updatedAt ?? b.created_at ?? "") - Date.parse(a.updated_at ?? a.updatedAt ?? a.created_at ?? "");
    });
  const pinnedChats = sortedGeneralChats.filter((chat) => isPinned("chat", chat.id));
  const unpinnedChats = sortedGeneralChats.filter((chat) => !isPinned("chat", chat.id));
  const recentChatLimit = 5;
  const recentChats = query || showAllRecentChats
    ? sortedGeneralChats
    : [...pinnedChats, ...unpinnedChats.slice(0, recentChatLimit), ...(selectedGeneralChat && !isPinned("chat", selectedGeneralChat.id) && !unpinnedChats.slice(0, recentChatLimit).some((chat) => chat.id === selectedGeneralChat.id) ? [sortedGeneralChats.find((chat) => chat.id === selectedGeneralChat.id)].filter(Boolean) : [])];
  const hiddenRecentChatCount = query ? 0 : Math.max(0, sortedGeneralChats.length - recentChats.length);

  return (
    <aside className={`sidebar ${collapsed ? "sidebar--collapsed" : ""}`}>
      <div className="brand-row">
        <span className="brand-mark" aria-hidden="true"><img alt="" src={tribeMark} /></span>
        {!collapsed && <span className="brand-name">Tribe</span>}
      </div>

      {!collapsed && <section className="project-explorer" aria-label="Project explorer">
        <div className="project-explorer-heading"><span className="sidebar-section-label">Project explorer</span><button aria-label="Add project" className="explorer-add" onClick={onCreateProject} title="Add project" type="button"><Plus size={15} /></button></div>
        <input aria-label="Find projects and chats" className="project-explorer-search" onChange={(event) => setProjectQuery(event.target.value)} placeholder="Find projects and chats" value={projectQuery} />
        <ExplorerRowButton className="explorer-new-chat-row" leading={<ChatCircleDots size={15} />} onClick={onCreateGeneralChat}>New chat</ExplorerRowButton>
        <div className="project-explorer-list">
          {sortedGeneralChats.length > 0 && <div className="explorer-general-chats">
            <span className="sidebar-section-label">Recent chats</span>
            {recentChats.map((chat) => <div className="explorer-chat-row explorer-chat-row--recent" key={chat.id}>
              <ExplorerRowButton aria-current={selectedGeneralChat?.id === chat.id ? "page" : undefined} className={`explorer-mission ${selectedGeneralChat?.id === chat.id ? "explorer-mission--selected" : ""}`} leading={<ChatCircleDots className="explorer-general-chat-icon" size={15} />} onClick={() => onSelectGeneralChat(chat.id)} title={chat.title} trailing={isPinned("chat", chat.id) && <PushPin aria-label="Pinned" className="explorer-pin-indicator" size={12} weight="fill" />}>
                {chat.title}
              </ExplorerRowButton>
              <div className="explorer-menu-wrap">
                <button aria-expanded={openMenu?.key === `general-chat-${chat.id}`} aria-label={`More actions for ${chat.title}`} className="explorer-menu-trigger" onClick={(event) => toggleMenu(`general-chat-${chat.id}`, event)} title={`More actions for ${chat.title}`} type="button"><DotsThree size={17} weight="bold" /></button>
                {openMenu?.key === `general-chat-${chat.id}` && createPortal(<div aria-label={`Actions for ${chat.title}`} className="explorer-context-menu" onClick={(event) => event.stopPropagation()} role="group" style={{ left: openMenu.left, top: openMenu.top }}>
                  <button onClick={() => { setOpenMenu(null); onSelectGeneralChat(chat.id); }} type="button"><ChatCircleDots size={15} />Open chat</button>
                  <button onClick={() => { setOpenMenu(null); togglePin("chat", chat.id); }} type="button"><PushPin size={15} />{isPinned("chat", chat.id) ? "Unpin chat" : "Pin chat"}</button>
                </div>, document.body)}
              </div>
            </div>)}
            {hiddenRecentChatCount > 0 && <button aria-expanded={showAllRecentChats} className="explorer-show-more" onClick={() => setShowAllRecentChats(true)} type="button">Show {hiddenRecentChatCount} more</button>}
            {!query && showAllRecentChats && sortedGeneralChats.length > recentChatLimit && <button className="explorer-show-more" onClick={() => setShowAllRecentChats(false)} type="button">Show fewer</button>}
          </div>}
          <div className="explorer-projects-heading"><span className="sidebar-section-label">Projects</span></div>
          {visibleProjects.map((item) => <div className="explorer-project" key={item.id}>
            <div className={`explorer-project-row ${project.id === item.id ? "explorer-project-row--selected" : ""}`}>
              <ExplorerRowButton aria-current={project.id === item.id ? "page" : undefined} aria-expanded={expandedProjects.has(item.id)} aria-label={`${item.name} · ${expandedProjects.has(item.id) ? "Collapse" : "Expand"} chats`} className={`explorer-project-button ${project.id === item.id ? "explorer-project-button--selected" : ""}`} leading={expandedProjects.has(item.id) ? <FolderOpen size={15} /> : <FolderSimple size={15} />} onClick={() => { if (project.id !== item.id) onSelectProject(item); toggleProject(item.id); }} title={item.name} trailing={<>{isPinned("project", item.id) && <PushPin aria-label="Pinned" className="explorer-pin-indicator" size={12} weight="fill" />}<small aria-label={`${item.missions?.length ?? 0} chats`} title={`${item.missions?.length ?? 0} chats`}>{item.missions?.length ?? 0}</small></>}>
                {item.name}
              </ExplorerRowButton>
              <div className="explorer-menu-wrap">
                <button aria-expanded={openMenu?.key === `project-${item.id}`} aria-label={`More actions for ${item.name}`} className="explorer-menu-trigger" onClick={(event) => { event.stopPropagation(); toggleMenu(`project-${item.id}`, event); }} title={`More actions for ${item.name}`} type="button"><DotsThree size={17} weight="bold" /></button>
                {openMenu?.key === `project-${item.id}` && createPortal(<div aria-label={`Actions for ${item.name}`} className="explorer-context-menu" onClick={(event) => event.stopPropagation()} role="group" style={{ left: openMenu.left, top: openMenu.top }}>
                  <button onClick={() => { setOpenMenu(null); onCreateMission(item); }} type="button"><ChatCircleDots size={15} />New chat</button>
                  <button onClick={() => { setOpenMenu(null); onOpenProjectSettings?.(item, openMenu?.trigger); }} type="button"><Gear size={15} />Project settings</button>
                  {item.repository && <button onClick={() => { setOpenMenu(null); onSelectProject(item); onNavigate("Code"); }} type="button"><FolderSimple size={15} />Open repository</button>}
                  <button onClick={() => { setOpenMenu(null); togglePin("project", item.id); }} type="button"><PushPin size={15} />{isPinned("project", item.id) ? "Unpin project" : "Pin project"}</button>
                  <div className="explorer-context-menu-divider" />
                  <button className="explorer-context-menu-danger" onClick={() => { setOpenMenu(null); onDeleteProject(item.id); }} type="button"><Trash size={15} />Delete project</button>
                </div>, document.body)}
              </div>
            </div>
            {expandedProjects.has(item.id) && <div className="explorer-missions">
              {[...(item.missions ?? []).filter((session) => !session.archived_at)].sort((a, b) => {
                const aPin = pinnedItems.indexOf(`chat:${a.id}`);
                const bPin = pinnedItems.indexOf(`chat:${b.id}`);
                if (aPin !== -1 || bPin !== -1) return aPin === -1 ? 1 : bPin === -1 ? -1 : aPin - bPin;
                return Date.parse(b.updated_at ?? b.updatedAt ?? b.created_at ?? "") - Date.parse(a.updated_at ?? a.updatedAt ?? a.created_at ?? "");
              }).map((session) => {
                const statusLabel = missionStatusLabel(session.status);
                const displayTitle = compactChatTitle(session.title);
                return <div className="explorer-chat-row" key={session.id}>
                <ExplorerRowButton aria-current={mission?.id === session.id ? "page" : undefined} aria-label={`Open chat: ${displayTitle} · ${statusLabel}`} className={`explorer-mission ${mission?.id === session.id ? "explorer-mission--selected" : ""}`} leading={<i aria-hidden="true" className={`explorer-mission-dot explorer-mission-dot--${session.status}`} />} onClick={() => onSelectMission(session.id, item)} title={`${session.title} · ${statusLabel}`} trailing={isPinned("chat", session.id) && <PushPin aria-label="Pinned" className="explorer-pin-indicator" size={12} weight="fill" />}>
                  {displayTitle}
                </ExplorerRowButton>
                <div className="explorer-menu-wrap">
                  <button aria-expanded={openMenu?.key === `chat-${session.id}`} aria-label={`More actions for ${displayTitle}`} className="explorer-menu-trigger" onClick={(event) => toggleMenu(`chat-${session.id}`, event)} title={`More actions for ${displayTitle}`} type="button"><DotsThree size={17} weight="bold" /></button>
                  {openMenu?.key === `chat-${session.id}` && createPortal(<div className="explorer-context-menu" role="menu" style={{ left: openMenu.left, top: openMenu.top }}>
                    <button onClick={() => { setOpenMenu(null); onSelectMission(session.id, item); }} role="menuitem" type="button"><ChatCircleDots size={15} />Open chat</button>
                    <button onClick={() => { setOpenMenu(null); onCreateMission(item); }} role="menuitem" type="button"><Plus size={15} />New chat in {item.name}</button>
                    <button onClick={() => { setOpenMenu(null); togglePin("chat", session.id); }} role="menuitem" type="button"><PushPin size={15} />{isPinned("chat", session.id) ? "Unpin chat" : "Pin chat"}</button>
                    <button onClick={() => { setOpenMenu(null); onArchiveMission(session.id); }} role="menuitem" type="button"><ClockCounterClockwise size={15} />{session.status === "active" ? "Pause and archive chat" : "Archive chat"}</button>
                    <button className="explorer-context-menu-danger" onClick={() => { setOpenMenu(null); onDeleteMission(session.id); }} role="menuitem" type="button"><Trash size={15} />Delete permanently</button>
                  </div>, document.body)}
                </div>
              </div>;
              })}
              {(item.missions ?? []).some((session) => session.archived_at) && <>
                <button aria-expanded={expandedArchived.has(item.id)} className="explorer-archived-toggle" onClick={() => setExpandedArchived((current) => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; })} type="button">{expandedArchived.has(item.id) ? <CaretDown size={13} /> : <CaretRight size={13} />} Archived chats <small>{item.missions.filter((session) => session.archived_at).length}</small></button>
                {expandedArchived.has(item.id) && (item.missions ?? []).filter((session) => session.archived_at).map((session) => <div className="explorer-chat-row" key={session.id}>
                  <ExplorerRowButton aria-current={mission?.id === session.id ? "page" : undefined} aria-label={`Open archived chat: ${compactChatTitle(session.title)}`} className={`explorer-mission explorer-mission--archived ${mission?.id === session.id ? "explorer-mission--selected" : ""}`} leading={<i aria-hidden="true" className="explorer-mission-dot explorer-mission-dot--archived" />} onClick={() => onSelectMission(session.id, item)} title={`${session.title} · Archived`}>
                    {compactChatTitle(session.title)}
                  </ExplorerRowButton>
                  <div className="explorer-menu-wrap"><button aria-expanded={openMenu?.key === `chat-${session.id}`} aria-label={`More actions for ${session.title}`} className="explorer-menu-trigger" onClick={(event) => toggleMenu(`chat-${session.id}`, event)} title={`More actions for ${session.title}`} type="button"><DotsThree size={17} weight="bold" /></button>
                    {openMenu?.key === `chat-${session.id}` && createPortal(<div className="explorer-context-menu" role="menu" style={{ left: openMenu.left, top: openMenu.top }}>
                      <button onClick={() => { setOpenMenu(null); onCreateMission(item); }} role="menuitem" type="button"><Plus size={15} />New chat in {item.name}</button>
                      <button onClick={() => { setOpenMenu(null); togglePin("chat", session.id); }} role="menuitem" type="button"><PushPin size={15} />{isPinned("chat", session.id) ? "Unpin chat" : "Pin chat"}</button>
                      <button onClick={() => { setOpenMenu(null); onRestoreMission(session.id); }} role="menuitem" type="button"><ClockCounterClockwise size={15} />Restore chat</button>
                      <button className="explorer-context-menu-danger" onClick={() => { setOpenMenu(null); onDeleteMission(session.id); }} role="menuitem" type="button"><Trash size={15} />Delete permanently</button>
                    </div>, document.body)}
                  </div>
                </div>)}
              </>}
            </div>}
          </div>)}
          {projects.length === 0 && <div className="explorer-empty"><strong>No projects yet</strong><span>Add a workspace folder or start a general chat.</span></div>}
          {projects.length > 0 && visibleProjects.length === 0 && <p className="explorer-empty">No projects match “{projectQuery}”.</p>}
        </div>
      </section>}

      <nav className="sidebar-nav" aria-label="Workspace navigation">
        {collapsed && <div aria-label="Quick actions" className="sidebar-nav-group sidebar-nav-group--quick" role="group">
          <button aria-label="New chat" className="nav-item" onClick={onCreateGeneralChat} title="New chat" type="button"><ChatCircleDots size={19} /></button>
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

