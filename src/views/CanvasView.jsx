import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChatCircleDots, DownloadSimple } from "@phosphor-icons/react";
import { canvasFilename, downloadCanvasDocument, downloadCanvasSvg, renderCanvasDiagramSvg } from "../domain/canvas-export.js";
import { applySelectedHunks, reviewDiff } from "../domain/canvas-diff.js";
import { selectedCanvasText } from "../domain/canvas-selection.js";
import { runtime } from "../api/runtime.js";
import { DiagramPreview } from "../components/DiagramPreview.jsx";
import { IconButton } from "../components/WorkspaceSidebar.jsx";
import { MarkdownContent } from "../components/MarkdownContent.jsx";

function CanvasPreview({ document, onTextSelection }) {
  function captureSelection(event) {
    const quote = selectedCanvasText(event.currentTarget, window.getSelection());
    if (quote) onTextSelection?.(quote);
  }

  if (document.kind === "markdown") return <article className={`canvas-markdown${document.body.trim() ? "" : " canvas-markdown--empty"}`} onKeyUp={captureSelection} onMouseUp={captureSelection}>{document.body.trim() ? <MarkdownContent>{document.body}</MarkdownContent> : <p className="canvas-empty">Nothing to preview yet.</p>}</article>;
  if (document.kind === "diagram") return <div className="canvas-diagram" onKeyUp={captureSelection} onMouseUp={captureSelection}><DiagramPreview source={document.body} /></div>;
  return <pre className={`canvas-preview canvas-preview--${document.kind}`} onKeyUp={captureSelection} onMouseUp={captureSelection}>{document.body}</pre>;
}

function CommentThread({ missionId, documentId, thread, onRefresh }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submitReply(event) {
    event.preventDefault();
    if (!reply.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await runtime.addCanvasComment(missionId, documentId, { threadId: thread.id, body: reply });
      setReply("");
      await onRefresh();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  }
  async function resolve() {
    setBusy(true);
    setError("");
    try {
      await runtime.resolveCanvasComment(missionId, thread.id);
      await onRefresh();
    } catch (resolveError) {
      setError(resolveError.message);
    } finally {
      setBusy(false);
    }
  }
  return <article className="canvas-thread">
    <header><span>{thread.resolved_at ? "Resolved" : thread.assignee ? `Assigned to @${thread.assignee}` : "Open comment"}</span><small>Revision {thread.base_revision}</small></header>
    {thread.quote && <blockquote>{thread.quote}</blockquote>}
    {thread.comments.map((comment) => <div className="canvas-comment" key={comment.id}>
      <strong>{comment.author === "user" ? "You" : comment.author}</strong>
      <time>{new Date(comment.created_at).toLocaleString()}</time>
      <p>{comment.body}</p>
    </div>)}
    {error && <p className="canvas-error" role="alert">{error}</p>}
    {!thread.resolved_at && <div className="canvas-thread-actions">
      <form onSubmit={(event) => void submitReply(event)}><input aria-label="Reply to comment" maxLength={8192} onChange={(event) => setReply(event.target.value)} placeholder="Reply to this thread…" value={reply} /><button className="button button--quiet" disabled={busy || !reply.trim()} type="submit">Reply</button></form>
      <button className="button button--quiet" disabled={busy} onClick={() => void resolve()} type="button">Resolve</button>
    </div>}
  </article>;
}

export function CanvasView({ document: summary, refreshKey = 0, onBack, backLabel = "Back to artifacts", onDiscuss, requestConfirmation = async () => false }) {
  const accessMissionId = summary?.access_mission_id ?? summary?.mission_id;
  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftBaseRevision, setDraftBaseRevision] = useState(null);
  const [recoveredDraft, setRecoveredDraft] = useState(null);
  const [viewRevision, setViewRevision] = useState(null);
  const [historyContent, setHistoryContent] = useState(null);
  const [mode, setMode] = useState("edit");
  const [selection, setSelection] = useState({ quote: "", startOffset: null, endOffset: null });
  const [commentBody, setCommentBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [reviewingProposalId, setReviewingProposalId] = useState(null);
  const [selectedHunks, setSelectedHunks] = useState([]);
  const [saving, setSaving] = useState(false);
  const [svgExporting, setSvgExporting] = useState(false);
  const [error, setError] = useState("");
  const dirtyRef = useRef(false);
  const draftStorageKey = summary?.id && accessMissionId
    ? `tribe.canvas.draft:${summary.project_id ?? summary.mission_id}:${summary.id}` : "";

  async function loadDetail({ preserveDraft = true } = {}) {
    if (!summary?.id || !accessMissionId) return;
    const { document } = await runtime.getCanvasDocument(accessMissionId, summary.id);
    setDetail(document);
    if (!preserveDraft || !dirtyRef.current) {
      setDraft(document.current);
      setDraftBaseRevision(document.revision);
      setRecoveredDraft(null);
      dirtyRef.current = false;
      try { if (draftStorageKey) window.sessionStorage.removeItem(draftStorageKey); } catch { /* Storage may be unavailable. */ }
      try { window.sessionStorage.removeItem(`tribe.canvas.draft:${summary.mission_id}:${summary.id}`); } catch { /* Storage may be unavailable. */ }
    }
  }

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDraft(null);
    setViewRevision(null);
    setHistoryContent(null);
    setRecoveredDraft(null);
    setError("");
    dirtyRef.current = false;
    if (summary?.id && accessMissionId) {
      runtime.getCanvasDocument(accessMissionId, summary.id).then(({ document }) => {
        if (!alive) return;
        setDetail(document);
        const requestedRevision = summary.revision;
        if (Number.isInteger(requestedRevision) && requestedRevision > 0
            && requestedRevision !== document.revision) {
          runtime.getCanvasVersion(accessMissionId, document.id, requestedRevision).then(({ version }) => {
            if (!alive) return;
            setViewRevision(requestedRevision);
            setHistoryContent(version);
            setMode("preview");
          }).catch((versionError) => {
            if (alive) setError(versionError.message);
          });
        }
        try {
          const legacyDraftKey = `tribe.canvas.draft:${summary.mission_id}:${summary.id}`;
          const cached = window.sessionStorage.getItem(draftStorageKey)
            ?? window.sessionStorage.getItem(legacyDraftKey);
          const restored = cached ? JSON.parse(cached) : null;
          if (restored?.draft && typeof restored.draft.body === "string"
              && typeof restored.draft.title === "string") {
            const baseRevision = Number.isInteger(restored.baseRevision) && restored.baseRevision > 0
              ? restored.baseRevision : document.revision;
            setDraft(restored.draft);
            setDraftBaseRevision(baseRevision);
            setRecoveredDraft({ baseRevision, currentRevision: document.revision });
            dirtyRef.current = true;
          } else {
            setDraft(document.current);
            setDraftBaseRevision(document.revision);
          }
        } catch {
          setDraft(document.current);
          setDraftBaseRevision(document.revision);
        }
      }).catch((loadError) => {
        if (alive) setError(loadError.message);
      });
    }
    return () => { alive = false; };
  }, [summary?.id, accessMissionId, summary?.revision]);

  useEffect(() => {
    if (!draft || !dirtyRef.current || !draftStorageKey) return;
    try {
      window.sessionStorage.setItem(draftStorageKey, JSON.stringify({ draft, baseRevision: draftBaseRevision ?? detail?.revision }));
    } catch { /* The in-memory draft remains editable if browser storage is unavailable. */ }
  }, [draft, draftBaseRevision, draftStorageKey]);

  useEffect(() => {
    if (refreshKey && detail) void loadDetail({ preserveDraft: true }).catch((loadError) => setError(loadError.message));
  }, [refreshKey]);

  async function save(content = draft) {
    if (!detail || !content || saving) return;
    setSaving(true);
    setError("");
    try {
      await runtime.saveCanvasDocument(accessMissionId, detail.id, content, draftBaseRevision ?? detail.revision);
      dirtyRef.current = false;
      setRecoveredDraft(null);
      try { window.sessionStorage.removeItem(draftStorageKey); } catch { /* Storage may be unavailable. */ }
      try { window.sessionStorage.removeItem(`tribe.canvas.draft:${summary.mission_id}:${summary.id}`); } catch { /* Storage may be unavailable. */ }
      setViewRevision(null);
      setHistoryContent(null);
      await loadDetail({ preserveDraft: false });
    } catch (saveError) {
      setError(saveError.message === "canvas_revision_conflict"
        ? "This document changed elsewhere. Your draft is preserved; reload the latest revision before saving again."
        : saveError.message);
      if (saveError.message === "canvas_revision_conflict") {
        try {
          const { document: latest } = await runtime.getCanvasDocument(accessMissionId, detail.id);
          setDetail(latest);
          setRecoveredDraft({ baseRevision: draftBaseRevision ?? detail.revision, currentRevision: latest.revision });
        } catch { /* The original draft and its base revision remain available. */ }
      }
    } finally {
      setSaving(false);
    }
  }

  async function reviewProposal(proposalId, decision, acceptedContent = null) {
    setSaving(true);
    setError("");
    try {
      await runtime.reviewCanvasProposal(accessMissionId, proposalId, decision, acceptedContent);
      setReviewingProposalId(null);
      await loadDetail({ preserveDraft: true });
    } catch (reviewError) {
      setError(reviewError.message === "canvas_proposal_stale"
        ? "This proposal is based on an older revision and must be reviewed against the latest document."
        : reviewError.message);
      await loadDetail({ preserveDraft: true });
    } finally {
      setSaving(false);
    }
  }

  function toggleProposalReview(proposal) {
    if (reviewingProposalId === proposal.id) {
      setReviewingProposalId(null);
      return;
    }
    const diff = reviewDiff(detail.current.body, proposal.body);
    setSelectedHunks(diff.hunks.map((hunk) => hunk.id));
    setReviewingProposalId(proposal.id);
  }

  function acceptProposal(proposal) {
    const diff = reviewDiff(detail.current.body, proposal.body);
    const reviewing = reviewingProposalId === proposal.id;
    const metadataChanged = proposal.title !== detail.current.title
      || proposal.kind !== detail.current.kind || proposal.language !== detail.current.language;
    if (reviewing && !diff.truncated && diff.hunks.length > 0 && selectedHunks.length === 0 && !metadataChanged) {
      setError("Select at least one change to apply, or dismiss this proposal.");
      return;
    }
    let body = proposal.body;
    if (reviewing && !diff.truncated) {
      try {
        body = applySelectedHunks(detail.current.body, proposal.body, selectedHunks);
      } catch (applyError) {
        setError(applyError.message);
        return;
      }
    }
    void reviewProposal(proposal.id, "accept", {
      title: proposal.title, kind: proposal.kind, language: proposal.language, body,
    });
  }

  function discussDocument() {
    if (dirtyRef.current) {
      setError("Save your changes before starting a discussion about this revision.");
      return;
    }
    if (new TextEncoder().encode(selection.quote).length > 4096) {
      setError("Select a shorter passage before starting a discussion. The attached passage can be up to 4 KB.");
      return;
    }
    onDiscuss?.({
      artifactId: detail.id, title: detail.title, revision: detail.revision,
      selectedText: selection.quote,
    });
  }

  function selectPreviewText(quote) {
    setSelection({ quote, startOffset: null, endOffset: null });
  }

  async function loadVersion(revision) {
    if (!revision || revision === detail.revision) {
      setViewRevision(null);
      setHistoryContent(null);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const { version } = await runtime.getCanvasVersion(accessMissionId, detail.id, revision);
      setViewRevision(revision);
      setHistoryContent(version);
    } catch (versionError) {
      setError(versionError.message);
    } finally {
      setSaving(false);
    }
  }

  async function addComment(event) {
    event.preventDefault();
    if (!detail || !commentBody.trim() || saving) return;
    if (dirtyRef.current) {
      setError("Save your document edits before anchoring a comment to this revision.");
      return;
    }
    if (new TextEncoder().encode(selection.quote).length > 4096) {
      setError("Select a shorter passage before commenting. The attached passage can be up to 4 KB.");
      return;
    }
    const revision = viewRevision ?? detail.revision;
    setSaving(true);
    setError("");
    try {
      await runtime.addCanvasComment(accessMissionId, detail.id, {
        body: commentBody,
        baseRevision: revision,
        quote: selection.quote,
        startOffset: selection.startOffset,
        endOffset: selection.endOffset,
        assignee: assignee.trim() || null,
      });
      setCommentBody("");
      setAssignee("");
      setSelection({ quote: "", startOffset: null, endOffset: null });
      await loadDetail({ preserveDraft: true });
    } catch (commentError) {
      setError(commentError.message);
    } finally {
      setSaving(false);
    }
  }

  async function reloadLatest() {
    if (dirtyRef.current && !(await requestConfirmation({
      eyebrow: "Reload document",
      title: "Replace your unsaved edits?",
      message: "Loading the latest revision will discard your unsaved document changes.",
      confirmLabel: "Load latest revision",
      tone: "danger",
    }))) return;
    await loadDetail({ preserveDraft: false });
    setViewRevision(null);
    setHistoryContent(null);
    setError("");
  }

  async function discardDraft() {
    if (!detail || !(await requestConfirmation({
      eyebrow: "Discard draft",
      title: "Discard your unsaved changes?",
      message: "Your latest saved revision will stay unchanged.",
      confirmLabel: "Discard changes",
      tone: "danger",
    }))) return;
    setDraft(detail.current);
    setDraftBaseRevision(detail.revision);
    setRecoveredDraft(null);
    setError("");
    dirtyRef.current = false;
    try { window.sessionStorage.removeItem(draftStorageKey); } catch { /* Storage may be unavailable. */ }
    try { window.sessionStorage.removeItem(`tribe.canvas.draft:${summary.mission_id}:${summary.id}`); } catch { /* Storage may be unavailable. */ }
  }

  async function exportDiagramSvg(document, filename) {
    if (svgExporting) return;
    setSvgExporting(true);
    setError("");
    try {
      const svg = await renderCanvasDiagramSvg(document);
      downloadCanvasSvg(svg, filename);
    } catch (exportError) {
      setError(exportError.message || "The diagram could not be exported as SVG.");
    } finally {
      setSvgExporting(false);
    }
  }

  if (!detail || !draft) return <section className="tab-panel detail-view canvas-view"><IconButton label={backLabel} onClick={onBack}><ArrowLeft size={16} /></IconButton>{error ? <p className="canvas-error">{error}</p> : <div className="column-empty">Loading document…</div>}</section>;
  const historical = viewRevision !== null;
  const shown = historical ? historyContent : draft;
  const pending = detail.proposals.filter((proposal) => proposal.status === "pending");
  const exportDocument = (historical ? shown : draft) ?? detail.current;
  const exportFilename = canvasFilename(exportDocument, {
    revision: historical ? viewRevision : detail.revision,
    draft: !historical && dirtyRef.current,
  });
  return <section className="tab-panel detail-view canvas-view">
    <div className="canvas-topbar"><IconButton label={backLabel} onClick={onBack}><ArrowLeft size={16} /></IconButton><span>{detail.kind} · Revision {viewRevision ?? detail.revision}</span>
      <IconButton disabled={!onDiscuss} label="Discuss in chat" onClick={discussDocument}><ChatCircleDots size={16} /></IconButton>
      <IconButton label={`Download ${dirtyRef.current && !historical ? "draft" : "document"}`} onClick={() => downloadCanvasDocument(exportDocument, exportFilename)}><DownloadSimple size={16} /></IconButton>
      {exportDocument.kind === "diagram" && <IconButton disabled={svgExporting} label={svgExporting ? "Preparing SVG" : "Download SVG"} onClick={() => void exportDiagramSvg(exportDocument, canvasFilename(exportDocument, { revision: historical ? viewRevision : detail.revision, draft: !historical && dirtyRef.current, format: "svg" }))}><DownloadSimple size={16} /></IconButton>}
      <label>History <select aria-label="Document revision history" onChange={(event) => void loadVersion(Number(event.target.value))} value={viewRevision ?? detail.revision}>{detail.versions.map((version) => <option key={version.revision} value={version.revision}>Revision {version.revision} · {version.author}</option>)}</select></label>
      {historical ? <button className="button button--primary" disabled={saving} onClick={() => { setDraft(historyContent); dirtyRef.current = true; setViewRevision(null); setHistoryContent(null); }} type="button">Restore as new revision</button>
        : <button className="button button--primary" disabled={saving || !dirtyRef.current} onClick={() => void save()} type="button">{saving ? "Saving…" : "Save changes"}</button>}
    </div>
    <div className="canvas-title-row"><div><span className="eyebrow">Shared document · {summary.mission_title}</span><input aria-label="Document title" disabled={historical} maxLength={240} onChange={(event) => { setDraft({ ...draft, title: event.target.value }); dirtyRef.current = true; }} value={historical ? shown.title : draft.title} /></div><div className="canvas-mode-switch"><button aria-pressed={mode === "edit"} className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")} type="button">Edit</button><button aria-pressed={mode === "preview"} className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")} type="button">Preview</button></div></div>
    {recoveredDraft && <div className={`canvas-draft-recovery ${recoveredDraft.baseRevision !== recoveredDraft.currentRevision ? "canvas-draft-recovery--stale" : ""}`} role="status">
      <div><strong>Unsaved changes recovered</strong><span>{recoveredDraft.baseRevision === recoveredDraft.currentRevision
        ? `Restored from revision ${recoveredDraft.baseRevision}.`
        : `Based on revision ${recoveredDraft.baseRevision}; the current document is revision ${recoveredDraft.currentRevision}. Saving will be rejected until you reload the latest revision.`}</span></div>
      <button className="button button--quiet" onClick={() => setRecoveredDraft(null)} type="button">Keep draft</button>
      {historical && <button className="button button--quiet" onClick={() => { setViewRevision(null); setHistoryContent(null); setMode("edit"); }} type="button">View recovered draft</button>}
      {recoveredDraft.baseRevision !== recoveredDraft.currentRevision && <button className="button button--quiet" onClick={() => downloadCanvasDocument(draft, canvasFilename(draft, { draft: true }))} type="button">Download draft</button>}
      <button className="button button--quiet" onClick={() => void discardDraft()} type="button">Discard draft</button>
    </div>}
    {error && <div className="canvas-error" role="alert">{error} {error.includes("draft is preserved") && <button className="button button--quiet" onClick={() => void reloadLatest()} type="button">Reload latest</button>}</div>}
    {mode === "edit" && !historical
      ? <textarea aria-label="Document content" className="canvas-editor" maxLength={256 * 1024} onChange={(event) => { setDraft({ ...draft, body: event.target.value }); dirtyRef.current = true; }} onSelect={(event) => { const { selectionStart, selectionEnd, value } = event.target; const quote = value.slice(selectionStart, selectionEnd); setSelection(quote ? { quote, startOffset: selectionStart, endOffset: selectionEnd } : { quote: "", startOffset: null, endOffset: null }); }} placeholder="Write your document in Markdown…" value={draft.body} />
      : <CanvasPreview document={shown} onTextSelection={selectPreviewText} />}
    {pending.length > 0 && <section className="canvas-proposals"><div className="canvas-section-heading"><div><h3>Proposed changes</h3><p>Agent edits need your review before becoming the current version.</p></div><span>{pending.length} pending</span></div>
      {pending.map((proposal) => {
        const diff = reviewingProposalId === proposal.id ? reviewDiff(detail.current.body, proposal.body) : null;
        const metadataChanged = proposal.title !== detail.current.title
          || proposal.kind !== detail.current.kind || proposal.language !== detail.current.language;
        return <article className="canvas-proposal" key={proposal.id}>
          <header><strong>{proposal.title}</strong><span>{proposal.author} · Based on revision {proposal.base_revision}</span></header>
          <div className="canvas-proposal-actions">
            <button className="button button--quiet" onClick={() => toggleProposalReview(proposal)} type="button">{diff ? "Hide changes" : "Review changes"}</button>
            <button className="button button--quiet" disabled={saving} onClick={() => void reviewProposal(proposal.id, "dismiss")} type="button">Dismiss</button>
            <button className="button button--primary" disabled={saving || proposal.base_revision !== detail.revision || Boolean(diff && !diff.truncated && diff.hunks.length > 0 && selectedHunks.length === 0 && !metadataChanged)} onClick={() => acceptProposal(proposal)} type="button">{proposal.base_revision !== detail.revision ? "Out of date" : diff && !diff.truncated ? "Apply selected changes" : "Accept full revision"}</button>
          </div>
          {diff && <div aria-label="Proposed document changes" className="canvas-proposal-diff">
            <div className="canvas-proposal-diff-heading"><strong>{diff.added} additions</strong><strong>{diff.removed} removals</strong>{diff.hunks.length > 0 && <span>{diff.hunks.length} change groups</span>}</div>
            {diff.hunks.map((hunk) => <section className="canvas-diff-hunk" key={hunk.id}>
              <label><input checked={selectedHunks.includes(hunk.id)} disabled={diff.truncated || proposal.base_revision !== detail.revision} onChange={(event) => setSelectedHunks((current) => event.target.checked ? [...current, hunk.id] : current.filter((id) => id !== hunk.id))} type="checkbox" /><span>Change {hunk.id + 1}</span><small>{hunk.added} added · {hunk.removed} removed</small></label>
              <pre>{hunk.visibleLines.map((line, index) => <code className={`canvas-diff-line canvas-diff-line--${line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context"}`} key={`${index}-${line}`}>{line || " "}{"\n"}</code>)}</pre>
            </section>)}
            {diff.truncated && <div className="canvas-diff-truncated">This change is too large for selective review. Check the full documents below before accepting the complete revision.</div>}
            {diff.hunks.length === 0 && <p className="canvas-diff-empty">No text changes in this proposal.</p>}
            <details className="canvas-proposal-full"><summary>Compare full documents</summary><div><section><small>Current revision {detail.revision}</small><pre>{detail.current.body}</pre></section><section><small>Proposed revision</small><pre>{proposal.body}</pre></section></div></details>
          </div>}
        </article>;
      })}
    </section>}
    <section className="canvas-comments"><div className="canvas-section-heading"><div><h3>Comments</h3><p>Comments stay anchored to the revision and text they refer to.</p></div><span>{detail.threads.filter((thread) => !thread.resolved_at).length} open</span></div>
      {detail.threads.map((thread) => <CommentThread documentId={detail.id} key={thread.id} missionId={accessMissionId} onRefresh={() => loadDetail({ preserveDraft: true })} thread={thread} />)}
      <form className="canvas-comment-composer" onSubmit={(event) => void addComment(event)}>{selection.quote && <blockquote>“{selection.quote}”</blockquote>}{dirtyRef.current && <p className="canvas-comment-note">Save your edits before adding a comment to this revision.</p>}<textarea aria-label="Add a document comment" maxLength={8192} onChange={(event) => setCommentBody(event.target.value)} placeholder="Add a comment…" value={commentBody} /><div><input aria-label="Assign comment to an agent" maxLength={80} onChange={(event) => setAssignee(event.target.value)} placeholder="Assign to an agent, e.g. @reviewer" value={assignee} /><button className="button button--primary" disabled={saving || dirtyRef.current || !commentBody.trim()} type="submit">Comment</button></div></form>
    </section>
  </section>;
}
