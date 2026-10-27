import { useRef, useState } from "react";
import { FolderSimple, GitBranch, X } from "@phosphor-icons/react";
import { IconButton } from "./WorkspaceSidebar.jsx";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { repositoryNameSuggestion } from "../domain/project-setup.js";

export function ProjectCreateDialog({ onClose, onCreate }) {
  const dialogRef = useRef(null);
  const [sourceMode, setSourceMode] = useState("folder");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [parentDirectory, setParentDirectory] = useState("");
  const [projectName, setProjectName] = useState("");
  const [nameIsSuggested, setNameIsSuggested] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useDialogFocus(dialogRef);

  function suggestName(value) {
    if (nameIsSuggested || !projectName.trim()) {
      setProjectName(value);
      setNameIsSuggested(true);
    }
  }

  async function chooseDirectory(title, onSelected) {
    if (!window.__TAURI_INTERNALS__ || pending) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false, title });
      if (typeof selected === "string") {
        setError("");
        onSelected(selected);
      }
    } catch (cause) {
      setError(`Folder picker failed: ${cause.message}`);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await onCreate({ sourceMode, repositoryPath, repositoryUrl, parentDirectory, projectName });
    } catch (cause) {
      setError(cause.message || "The project could not be added.");
    } finally {
      setPending(false);
    }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !pending) onClose();
  }}>
    <form className="mission-dialog project-create-dialog" onSubmit={submit} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="new-project-heading" tabIndex={-1}>
      <div className="dialog-heading"><div><span className="eyebrow">Project</span><h2 id="new-project-heading">Add a project</h2><p>Connect a Git repository. Next, choose a model if needed and start a chat.</p></div><IconButton disabled={pending} label="Close" onClick={onClose}><X size={17} /></IconButton></div>
      <div className="project-source-tabs" role="group" aria-label="Project source">
        <button aria-pressed={sourceMode === "folder"} className={sourceMode === "folder" ? "project-source-tab project-source-tab--active" : "project-source-tab"} onClick={() => { setError(""); setSourceMode("folder"); }} type="button"><FolderSimple size={15} /> Existing folder</button>
        <button aria-pressed={sourceMode === "clone"} className={sourceMode === "clone" ? "project-source-tab project-source-tab--active" : "project-source-tab"} onClick={() => { setError(""); setSourceMode("clone"); }} type="button"><GitBranch size={15} /> Clone repository</button>
      </div>
      {sourceMode === "folder" ? <label>Repository folder<div className="repository-picker-row"><input aria-describedby={!window.__TAURI_INTERNALS__ ? "project-folder-hint" : undefined} autoFocus onChange={(event) => { setError(""); setRepositoryPath(event.target.value); }} placeholder={window.__TAURI_INTERNALS__ ? "Choose a local Git repository" : "Enter a repository path"} value={repositoryPath} /><button className="button button--quiet" disabled={!window.__TAURI_INTERNALS__ || pending} onClick={() => chooseDirectory("Select a Git repository", (value) => { setRepositoryPath(value); suggestName(value.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project"); })} type="button">Browse…</button></div>{!window.__TAURI_INTERNALS__ && <small className="field-hint" id="project-folder-hint">Enter the repository folder path. Browsing is available in the desktop app.</small>}</label> : <>
        <label>Repository address<input autoFocus maxLength={2048} onChange={(event) => { const value = event.target.value; setError(""); setRepositoryUrl(value); suggestName(repositoryNameSuggestion(value)); }} placeholder="https://github.com/owner/repository.git" value={repositoryUrl} /></label>
        <label>Save in<div className="repository-picker-row"><input aria-describedby="clone-parent-hint" onChange={(event) => { setError(""); setParentDirectory(event.target.value); }} placeholder={window.__TAURI_INTERNALS__ ? "Choose a parent folder" : "Enter a parent folder path"} value={parentDirectory} /><button className="button button--quiet" disabled={!window.__TAURI_INTERNALS__ || pending} onClick={() => chooseDirectory("Choose where to save the repository", setParentDirectory)} type="button">Browse…</button></div><small className="field-hint" id="clone-parent-hint">Tribe creates a new folder here. Cloning may take a few minutes.{!window.__TAURI_INTERNALS__ && " Enter a path directly; browsing is available in the desktop app."}</small></label>
      </>}
      <label>Project name<input maxLength={200} onChange={(event) => { setError(""); setProjectName(event.target.value); setNameIsSuggested(false); }} placeholder="Project name" value={projectName} /></label>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button button--quiet" disabled={pending} onClick={onClose} type="button">Cancel</button><button className="button button--primary" disabled={pending || !projectName.trim() || (sourceMode === "folder" ? !repositoryPath.trim() : !repositoryUrl.trim() || !parentDirectory.trim())} type="submit">{pending ? (sourceMode === "clone" ? "Cloning…" : "Adding…") : "Add project"}</button></div>
    </form>
  </div>;
}
