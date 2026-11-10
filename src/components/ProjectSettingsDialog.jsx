import { useEffect, useRef, useState } from "react";
import { FileText, SquaresFour, UsersThree, ClockCounterClockwise, Sparkle, ShieldCheck, ChartLineUp, X } from "@phosphor-icons/react";
import { IconButton } from "./WorkspaceSidebar.jsx";
import { useDialogFocus } from "../hooks/useDialogFocus.js";

const sections = [
  { id: "team", label: "Team", icon: UsersThree, description: "Review roles available to this project. Custom role definitions are shared across projects." },
  { id: "approvals", label: "Approvals", icon: ShieldCheck, description: "Choose when agents need your approval before acting." },
  { id: "guidance", label: "Guidance", icon: FileText, description: "Set the project goal and the repository files agents should read." },
  { id: "datasets", label: "Datasets", icon: ChartLineUp, description: "Choose which local tables agents with Data analysis access may inspect." },
  { id: "knowledge", label: "Memory", icon: FileText, description: "Manage durable project memory and review suggestions." },
  { id: "artifacts", label: "Artifacts", icon: SquaresFour, description: "Browse files and shared documents created in this project." },
  { id: "interactive", label: "Interactive apps", icon: Sparkle, description: "Choose whether agents can create interactive tools in chat replies." },
  { id: "schedules", label: "Schedules", icon: ClockCounterClockwise, description: "Schedule recurring work for this project." },
];

export function ProjectSettingsDialog({ project, section, onSectionChange, onClose, children }) {
  const dialogRef = useRef(null);
  const tabsRef = useRef(null);
  const [activeSection, setActiveSection] = useState(section ?? "team");
  const [tabOrientation, setTabOrientation] = useState("vertical");
  useDialogFocus(dialogRef);
  useEffect(() => setActiveSection(section ?? "team"), [section]);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 680px)");
    if (!media) return undefined;
    const updateOrientation = () => setTabOrientation(media.matches ? "horizontal" : "vertical");
    updateOrientation();
    media.addEventListener?.("change", updateOrientation);
    return () => media.removeEventListener?.("change", updateOrientation);
  }, []);
  useEffect(() => {
    document.getElementById(`project-settings-tab-${activeSection}`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeSection, tabOrientation]);
  useEffect(() => {
    function onKeyDown(event) { if (event.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const selected = sections.find((item) => item.id === activeSection) ?? sections[0];
  function selectSection(id) {
    setActiveSection(id);
    onSectionChange?.(id);
  }
  function handleTabKeyDown(event, index) {
    const forwardKey = tabOrientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    const backwardKey = tabOrientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    if (event.key !== forwardKey && event.key !== backwardKey) return;
    event.preventDefault();
    const offset = event.key === forwardKey ? 1 : -1;
    const next = sections[(index + offset + sections.length) % sections.length];
    selectSection(next.id);
    tabsRef.current?.querySelector(`#project-settings-tab-${next.id}`)?.focus();
  }
  return <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
    <section aria-labelledby="project-settings-title" aria-modal="true" className="settings-dialog project-settings-dialog" ref={dialogRef} role="dialog" tabIndex={-1}>
      <header className="settings-dialog-header"><div><span className="eyebrow">Project</span><h2 id="project-settings-title">{project.name} settings</h2><p>Manage this project’s team, guidance and work.</p></div><IconButton label="Close project settings" onClick={onClose}><X size={17} /></IconButton></header>
      <div className="settings-dialog-body">
        <nav aria-label="Project settings sections" aria-orientation={tabOrientation} className="settings-section-nav" ref={tabsRef} role="tablist">
          {sections.map(({ id, label, icon: Icon }, index) => <button aria-controls="project-settings-panel" aria-selected={activeSection === id} className={`settings-section-tab ${activeSection === id ? "settings-section-tab--active" : ""}`} id={`project-settings-tab-${id}`} key={id} onClick={() => selectSection(id)} onKeyDown={(event) => handleTabKeyDown(event, index)} role="tab" tabIndex={activeSection === id ? 0 : -1} type="button"><Icon size={16} /><span>{label}</span></button>)}
        </nav>
        <div aria-labelledby={`project-settings-tab-${activeSection}`} className="settings-section-panel project-settings-panel" id="project-settings-panel" role="tabpanel">
          <div className="settings-section-heading"><h3>{selected.label}</h3><p>{selected.description}</p></div>
          {children(activeSection)}
        </div>
      </div>
    </section>
  </div>;
}
