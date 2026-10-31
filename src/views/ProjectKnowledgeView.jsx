import { useLayoutEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, Archive, Check, FileText, Plus, X } from "@phosphor-icons/react";
import { IconButton } from "../components/WorkspaceSidebar.jsx";
import { formatTime } from "../domain/activity.js";

export function ProjectKnowledgeView({ entries, proposals, migration = {}, onResolveMigration, onSave, onReview, onArchive, onRestore }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const addButtonRef = useRef(null);
  const titleInputRef = useRef(null);
  const previousFormOpen = useRef(false);

  useLayoutEffect(() => {
    if (formOpen) titleInputRef.current?.focus();
    else if (previousFormOpen.current) addButtonRef.current?.focus();
    previousFormOpen.current = formOpen;
  }, [formOpen]);

  async function submit(event) {
    event.preventDefault();
    if (!title.trim() || !content.trim() || saving) return;
    setSaving(true);
    try {
      const saved = await onSave(title.trim(), content.trim());
      if (saved) {
        setTitle("");
        setContent("");
        setFormOpen(false);
      }
    } finally { setSaving(false); }
  }
  const pendingProposals = proposals.filter((proposal) => proposal.status === "pending");
  const activeEntries = entries.filter((entry) => entry.status === "active");
  const migrationConflicts = migration.conflicts ?? [];
  const reviewedMigration = migration.reviewed ?? [];

  return (
    <section className="tab-panel detail-view knowledge-view">
      <div className="detail-heading knowledge-heading"><div className="knowledge-heading-actions">{(activeEntries.length > 0 || pendingProposals.length > 0) && <span className="artifact-count">{activeEntries.length} saved · {pendingProposals.length} to review</span>}<button ref={addButtonRef} aria-label={formOpen ? "Cancel adding note" : "Add project memory"} className="icon-button knowledge-add-button" onClick={() => setFormOpen((current) => !current)} title={formOpen ? "Cancel adding note" : "Add memory"} type="button">{formOpen ? <X size={15} /> : <Plus size={15} />}</button></div></div>
      {formOpen && <form className="knowledge-form" onSubmit={submit}>
        <input ref={titleInputRef} aria-label="Memory title" maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="Short title" value={title} />
        <textarea aria-label="Memory content" maxLength={20000} onChange={(event) => setContent(event.target.value)} placeholder="Stable project facts, conventions or decisions" rows={3} value={content} />
        <div><button className="button button--primary" disabled={!title.trim() || !content.trim() || saving} type="submit">{saving ? "Saving…" : "Save note"}</button></div>
      </form>}
      {pendingProposals.length > 0 && <div className="knowledge-proposals"><div className="command-list-heading"><h3>Agent suggestions</h3><span>Review before saving</span></div>
        {pendingProposals.map((proposal) => <article className="knowledge-proposal" key={proposal.id}><div className="knowledge-proposal-heading"><strong>{proposal.title}</strong><small>{proposal.proposed_by} · from {proposal.source_mission_title} · {formatTime(proposal.created_at)}</small></div><p>{proposal.content}</p><div className="knowledge-proposal-actions"><button className="button button--quiet" onClick={() => onReview(proposal.id, "dismiss")} type="button">Dismiss</button><button className="button button--primary" onClick={() => onReview(proposal.id, "accept")} type="button"><Check size={14} /> Save to project memory</button></div></article>)}
      </div>}
      {migrationConflicts.length > 0 && <section className="knowledge-migration" aria-labelledby="knowledge-migration-heading">
        <div className="command-list-heading"><h3 id="knowledge-migration-heading">Review saved versions</h3><span>{migrationConflicts.length} need review</span></div>
        <p>Some older project memories differ from the current versions. Choose which version to keep for each one.</p>
        {migrationConflicts.map((conflict) => <article className="knowledge-proposal knowledge-migration-conflict" key={`${conflict.project_id}:${conflict.entry_id}`}>
          <div className="knowledge-proposal-heading"><strong>{conflict.title}</strong><small>Different in {conflict.fields.join(", ")}</small></div>
          <div className="knowledge-migration-versions">
            <div><strong>Current version</strong><p>{conflict.smriti.unavailable_reason || conflict.smriti.content || "No content"}</p></div>
            <div><strong>Previously saved version</strong><p>{conflict.legacy.content || "No content"}</p></div>
          </div>
          {conflict.smriti.unavailable_reason && <p className="knowledge-migration-scope-note">This memory belongs to another project. You can copy the previously saved version into this project without changing the other project's memory.</p>}
          <div className="knowledge-proposal-actions">
            {conflict.smriti.unavailable_reason
              ? <button className="button button--primary" onClick={() => onResolveMigration(conflict.entry_id, "copy_legacy_to_project")} type="button">Copy saved version into this project</button>
              : <><button className="button button--quiet" onClick={() => onResolveMigration(conflict.entry_id, "keep_smriti")} type="button">Keep current</button>
                <button className="button button--primary" onClick={() => onResolveMigration(conflict.entry_id, "use_legacy")} type="button">Use previously saved</button></>}
          </div>
        </article>)}
      </section>}
      {migration.missing?.length > 0 && <p className="settings-note">{migration.missing.some((item) => item.retired)
        ? "A previously saved memory is missing from project memory and needs manual recovery."
        : `${migration.missing.length} older ${migration.missing.length === 1 ? "memory is" : "memories are"} still being copied and will be checked again automatically.`}</p>}
      {reviewedMigration.length > 0 && <details className="knowledge-migration-history"><summary>Reviewed versions · {reviewedMigration.length}</summary>{reviewedMigration.map((item) => <p key={`${item.entry_id}:${item.reviewed_at}`}>{item.title} · {item.resolution === "keep_smriti" ? "Kept current version" : item.resolution === "copy_legacy_to_project" ? "Copied saved version into this project" : "Used previously saved version"} · {formatTime(item.reviewed_at)}</p>)}</details>}
      <div className={`knowledge-list ${entries.length === 0 && pendingProposals.length === 0 && !formOpen ? "knowledge-list--empty" : ""}`}>
        {entries.map((entry) => <article className={`knowledge-entry ${entry.status === "archived" ? "knowledge-entry--archived" : ""}`} key={entry.id}><div><span className="knowledge-entry-meta"><strong>{entry.title}</strong><small>{entry.status === "archived" ? "Archived" : `Added by ${entry.created_by}`} · {entry.source_mission_title ? `from ${entry.source_mission_title} · ` : ""}Updated {formatTime(entry.updated_at)}</small></span>{entry.status === "active" ? <IconButton className="knowledge-archive-button" label={`Archive ${entry.title}`} onClick={() => onArchive(entry.id)} title="Archive note"><Archive size={15} /></IconButton> : <IconButton className="knowledge-archive-button" label={`Restore ${entry.title}`} onClick={() => onRestore(entry.id)} title="Restore note"><ArrowCounterClockwise size={15} /></IconButton>}</div><p>{entry.content}</p></article>)}
        {entries.length === 0 && pendingProposals.length === 0 && !formOpen && <div className="knowledge-empty"><span className="knowledge-empty-icon"><FileText size={20} /></span><strong>No memories yet</strong><p>Add a convention or decision to give every chat the same project context.</p></div>}
      </div>
    </section>
  );
}
