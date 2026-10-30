import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { CaretDown, CaretLeft, CaretRight, Code, Eye, FileText, FolderOpen, FolderSimple, TextAlignLeft, X } from "@phosphor-icons/react";
import { findTextQuoteRange, imagePointAnchor, isImagePointAnchor, isTextQuoteAnchor, textQuoteAnchor } from "../domain/artifact-anchor.js";
import { runtime } from "../api/runtime.js";
import { MarkdownContent } from "../components/MarkdownContent.jsx";
import { ReadOnlyCodeEditor } from "../components/ReadOnlyCodeEditor.jsx";
import { TabularArtifactPreview } from "../components/TabularArtifactPreview.jsx";
import { XlsxArtifactPreview } from "../components/XlsxArtifactPreview.jsx";
import { PdfArtifactPreview } from "../components/PdfArtifactPreview.jsx";
import { MediaArtifactPreview } from "../components/MediaArtifactPreview.jsx";
import { playableMediaKind } from "../domain/artifact-preview.js";

function RepositoryTree({ entries, expandedPaths, directories, activePath, depth = 0, onToggle, onOpenFile }) {
  return entries?.map((item) => {
    const expanded = expandedPaths.has(item.path);
    const directory = item.kind === "directory";
    return <Fragment key={item.path}>
      <button
        aria-expanded={directory ? expanded : undefined}
        className={`repository-tree-entry ${activePath === item.path ? "repository-tree-entry--selected" : ""} ${directory ? "repository-tree-entry--directory" : ""}`}
        onClick={() => directory ? onToggle(item.path) : onOpenFile(item.path)}
        style={{ "--tree-depth": depth }}
        title={item.name}
        type="button"
      >
        <span className="repository-tree-caret">{directory ? expanded ? <CaretDown size={12} /> : <CaretRight size={12} /> : null}</span>
        <span className="repository-entry-icon">{directory ? expanded ? <FolderOpen size={15} /> : <FolderSimple size={15} /> : <FileText size={14} />}</span>
        <span className="repository-tree-name">{item.name}</span>
      </button>
      {directory && expanded && <div className="repository-tree-children">
        {directories[item.path]?.entries?.length
          ? <RepositoryTree entries={directories[item.path].entries} expandedPaths={expandedPaths} directories={directories} activePath={activePath} depth={depth + 1} onToggle={onToggle} onOpenFile={onOpenFile} />
          : <span className="repository-tree-empty">{directories[item.path] ? "Empty folder" : "Loading…"}</span>}
      </div>}
    </Fragment>;
  });
}

function fileName(file) {
  return file?.name ?? file?.path?.split("/").at(-1) ?? "";
}

function editedArtifactName(name) {
  const edited = name.replace(/(\.[^.]+)$/, " (edited)$1");
  return edited === name ? `${name} (edited).txt` : edited;
}

function ArtifactReviewThread({ thread, threadNumber, agents, busy, onReply, onResolve, onReopen }) {
  const [reply, setReply] = useState("");
  return <article className="artifact-review-thread">
    <div className="artifact-review-thread-heading"><span>Comment {threadNumber} · {thread.status === "open" ? "Open" : "Resolved"}</span></div>
    {isTextQuoteAnchor(thread.anchor) && <p className="artifact-review-location">“{thread.anchor.quote}”</p>}
    {isImagePointAnchor(thread.anchor) && <p className="artifact-review-location">Pinned at {Math.round(thread.anchor.x * 100)}% across, {Math.round(thread.anchor.y * 100)}% down</p>}
    {thread.comments.map((comment) => <div className="artifact-review-comment" key={comment.id}><strong>{comment.author_id === "user" ? "You" : agents.find((agent) => agent.id === comment.author_id)?.name ?? comment.author_id}</strong><time>{new Date(comment.created_at).toLocaleString()}</time><p>{comment.body}</p></div>)}
    {thread.status === "open" && <div className="artifact-review-thread-actions"><form onSubmit={(event) => { event.preventDefault(); if (reply.trim()) { onReply(thread.id, reply); setReply(""); } }}><input aria-label="Reply to review comment" maxLength={5000} onChange={(event) => setReply(event.target.value)} placeholder="Reply to this thread…" value={reply} /><button className="button button--quiet" disabled={busy || !reply.trim()} type="submit">Reply</button></form><button className="button button--quiet" disabled={busy} onClick={() => onResolve(thread.id)} type="button">Resolve</button></div>}
    {thread.status === "resolved" && <div className="artifact-review-thread-actions"><span className="artifact-review-resolved-by">Resolved{thread.resolved_by ? ` by ${thread.resolved_by === "user" ? "you" : agents.find((agent) => agent.id === thread.resolved_by)?.name ?? thread.resolved_by}` : ""}</span><button className="button button--quiet" disabled={busy} onClick={() => onReopen(thread.id)} type="button">Reopen thread</button></div>}
  </article>;
}

export function RepositoryView({ artifact, project, missionId, agents = [], onBrowseRepository, onArtifactSaved, onUseSpreadsheetSelection, reviewRevision = 0 }) {
  const [directories, setDirectories] = useState({});
  const [expandedPaths, setExpandedPaths] = useState(new Set([""]));
  const [fileTabs, setFileTabs] = useState([]);
  const [activeFilePath, setActiveFilePath] = useState("");
  const [markdownPreviewPaths, setMarkdownPreviewPaths] = useState(new Set());
  const repositoryImageCache = useRef(new Map());
  const resolveRepositoryImage = useCallback((path) => {
    if (!project.id) return Promise.resolve(null);
    if (!repositoryImageCache.current.has(path)) {
      repositoryImageCache.current.set(path, runtime.browseProject(project.id, path)
        .then(({ entry }) => entry.previewDataUrl ?? null)
        .catch(() => null));
    }
    return repositoryImageCache.current.get(path);
  }, [project.id]);
  const [wordWrapByPath, setWordWrapByPath] = useState({});
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [loadingDirectories, setLoadingDirectories] = useState(new Set());
  const [loadingFiles, setLoadingFiles] = useState(new Set());
  const activeExtension = activeFilePath.split(".").at(-1)?.toLowerCase();
  const defaultWordWrap = ["md", "mdx", "markdown", "rst", "txt"].includes(activeExtension);
  const wordWrap = Object.hasOwn(wordWrapByPath, activeFilePath) ? wordWrapByPath[activeFilePath] : defaultWordWrap;
  const [error, setError] = useState("");
  const [reviewThreads, setReviewThreads] = useState([]);
  const [reviewText, setReviewText] = useState("");
  const [reviewAnchor, setReviewAnchor] = useState(null);
  const [pinMode, setPinMode] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [editingArtifact, setEditingArtifact] = useState(false);
  const [tableSourceOpen, setTableSourceOpen] = useState(false);
  const [artifactDraft, setArtifactDraft] = useState("");
  const [savingArtifact, setSavingArtifact] = useState(false);
  const [artifactEditError, setArtifactEditError] = useState("");
  const [commentNavigatorOpen, setCommentNavigatorOpen] = useState(false);
  const [activeReviewIndex, setActiveReviewIndex] = useState(0);
  const [commentDrafts, setCommentDrafts] = useState([]);
  const [postingCommentDrafts, setPostingCommentDrafts] = useState(false);
  const [commentPopover, setCommentPopover] = useState(null);
  const [commentNavigatorPosition, setCommentNavigatorPosition] = useState(null);
  const selectionRangeRef = useRef(null);
  const commentNavigatorRef = useRef(null);
  const commentToggleRef = useRef(null);
  useEffect(() => {
    setEditingArtifact(false);
    setTableSourceOpen(false);
    setArtifactDraft(artifact?.preview ?? "");
    setArtifactEditError("");
    setCommentDrafts([]);
    setCommentNavigatorOpen(false);
    setCommentPopover(null);
    selectionRangeRef.current = null;
  }, [artifact?.id, artifact?.preview]);

  async function saveArtifactCopy() {
    if (!artifact || !missionId || savingArtifact) return;
    setSavingArtifact(true);
    setArtifactEditError("");
    try {
      const bytes = new TextEncoder().encode(artifactDraft);
      let binary = "";
      for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
      const result = await runtime.uploadArtifact(missionId, editedArtifactName(artifact.name), artifact.type || "text/plain", btoa(binary));
      await onArtifactSaved?.(result);
      setEditingArtifact(false);
    } catch (saveError) {
      setArtifactEditError(saveError.message || "The edited copy could not be saved.");
    } finally {
      setSavingArtifact(false);
    }
  }

  function downloadArtifactDraft() {
    if (!artifact) return;
    const blob = new Blob([artifactDraft], { type: artifact.type || "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = editedArtifactName(artifact.name);
    anchor.click();
    URL.revokeObjectURL(url);
  }
  async function loadReviews() {
    if (!artifact?.id) return;
    try {
      const result = await runtime.listArtifactReviews(artifact.id);
      setReviewThreads(result.threads ?? []);
      setReviewError("");
    } catch (loadError) {
      setReviewError(loadError.message);
    }
  }
  useEffect(() => {
    setReviewThreads([]);
    setReviewText("");
    setReviewAnchor(null);
    setPinMode(false);
    setReviewError("");
    setActiveReviewIndex(0);
    if (artifact?.id) void loadReviews();
  }, [artifact?.id, reviewRevision]);
  async function addReviewComment(body, threadId = null, anchor = null) {
    if (!body.trim() || reviewBusy) return;
    setReviewBusy(true);
    setReviewError("");
    try {
      await runtime.addArtifactReviewComment(artifact.id, body, threadId, threadId ? null : anchor);
      if (!threadId) {
        setReviewText("");
        setReviewAnchor(null);
      }
      await loadReviews();
    } catch (saveError) {
      setReviewError(saveError.message);
    } finally {
      setReviewBusy(false);
    }
  }
  async function resolveReview(threadId) {
    setReviewBusy(true);
    setReviewError("");
    try {
      await runtime.resolveArtifactReviewThread(threadId);
      await loadReviews();
    } catch (resolveError) {
      setReviewError(resolveError.message);
    } finally {
      setReviewBusy(false);
    }
  }
  async function reopenReview(threadId) {
    setReviewBusy(true);
    setReviewError("");
    try {
      await runtime.reopenArtifactReviewThread(threadId);
      await loadReviews();
    } catch (reopenError) {
      setReviewError(reopenError.message);
    } finally {
      setReviewBusy(false);
    }
  }

  function placeCommentPopover(range, anchor) {
    const rect = range.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 24);
    const height = 242;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
    const below = rect.bottom + 10;
    const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, rect.top - height - 10);
    setCommentPopover({ anchor, left, top });
  }

  function captureTextSelection(event) {
    if (!artifact || artifact.previewTruncated || commentPopover) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || range.collapsed || !event.currentTarget.contains(range.commonAncestorContainer)) return;
    const anchor = textQuoteAnchor(event.currentTarget, selection);
    if (!anchor) {
      setReviewError("Select a shorter passage to anchor a comment.");
      return;
    }
    selectionRangeRef.current = range.cloneRange();
    setReviewError("");
    setReviewText("");
    setCommentNavigatorOpen(false);
    placeCommentPopover(range, anchor);
  }

  function closeCommentPopover() {
    setCommentPopover(null);
    selectionRangeRef.current = null;
  }

  function openCommentNavigator() {
    const trigger = commentToggleRef.current;
    const scope = trigger?.closest(".project-tool-pane") ?? trigger?.closest(".detail-view");
    const bounds = scope?.getBoundingClientRect();
    if (bounds) {
      const width = Math.max(260, Math.min(380, bounds.width - 24));
      setCommentNavigatorPosition({ left: Math.max(12, bounds.right - width - 12), top: Math.max(68, bounds.top + 8), width });
    }
    setCommentNavigatorOpen(true);
  }

  function toggleCommentNavigator() {
    if (commentNavigatorOpen) setCommentNavigatorOpen(false);
    else openCommentNavigator();
  }

  useEffect(() => {
    if (!commentPopover) return undefined;
    const reposition = () => {
      const range = selectionRangeRef.current;
      if (range) placeCommentPopover(range, commentPopover.anchor);
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [commentPopover?.anchor]);

  useEffect(() => {
    if (!commentNavigatorOpen) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!commentNavigatorRef.current?.contains(event.target) && !commentToggleRef.current?.contains(event.target)) setCommentNavigatorOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [commentNavigatorOpen]);

  function navigateReview(index) {
    if (index < 0 || index >= reviewThreads.length) return;
    setActiveReviewIndex(index);
    const thread = reviewThreads[index];
    if (isTextQuoteAnchor(thread.anchor)) {
      const page = document.getElementById(`artifact-page-${artifact.id}`);
      const range = findTextQuoteRange(page, thread.anchor);
      if (range) {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        range.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    } else if (isImagePointAnchor(thread.anchor)) {
      const pin = document.querySelector(`[data-review-thread="${thread.id}"]`);
      if (pin) { pin.scrollIntoView({ behavior: "smooth", block: "center" }); pin.focus({ preventScroll: true }); }
    }
  }

  async function postCommentDrafts() {
    if (postingCommentDrafts || !commentDrafts.length) return;
    setPostingCommentDrafts(true);
    setReviewError("");
    const failed = [];
    for (const draft of commentDrafts) {
      try { await runtime.addArtifactReviewComment(artifact.id, draft.body, null, draft.anchor); }
      catch (error) { failed.push({ ...draft, error: error.message }); }
    }
    setCommentDrafts(failed);
    await loadReviews();
    if (failed.length) setReviewError(`${failed.length} comment${failed.length === 1 ? "" : "s"} could not be posted. Your drafts are still here.`);
    setPostingCommentDrafts(false);
  }
  useEffect(() => {
    let current = true;
    repositoryImageCache.current.clear();
    setDirectories({});
    setExpandedPaths(new Set([""]));
    setFileTabs([]);
    setActiveFilePath("");
    setMarkdownPreviewPaths(new Set());
    setWordWrapByPath({});
    setError("");
    setLoadingRoot(Boolean(project.id));
    if (project.id) runtime.browseProject(project.id, "").then(({ entry: root }) => {
      if (!current) return;
      setDirectories({ "": root });
      const readme = root.entries?.find((entry) => entry.kind === "file" && /^readme\.md$/i.test(entry.name));
      if (readme) runtime.browseProject(project.id, readme.path).then(({ entry: file }) => {
        if (current) {
          setFileTabs([file]);
          setActiveFilePath(file.path);
        }
      }).catch((loadError) => { if (current) setError(loadError.message); });
    }).catch((loadError) => {
      if (current) setError(loadError.message);
    }).finally(() => { if (current) setLoadingRoot(false); });
    return () => { current = false; };
  }, [project.id]);
  if (artifact) {
    const extension = artifact.name.split(".").at(-1)?.toLowerCase();
    const markdownArtifact = ["md", "mdx", "markdown"].includes(extension) || artifact.type?.includes("markdown");
    const textArtifact = artifact.preview !== undefined && !artifact.previewDataUrl;
    const xlsxArtifact = extension === "xlsx" || artifact.type?.split(";", 1)[0]?.trim().toLowerCase() === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const pdfArtifact = extension === "pdf" || artifact.type?.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
    const mediaKind = playableMediaKind(artifact.type);
    return (
      <section className="tab-panel detail-view">
        <div className="detail-heading">
          <div><span className="eyebrow">{markdownArtifact ? "Markdown document" : artifact.tableText !== undefined ? "Data table" : xlsxArtifact ? "Spreadsheet" : pdfArtifact ? "PDF document" : mediaKind === "audio" ? "Audio file" : mediaKind === "video" ? "Video file" : artifact.preview !== undefined ? "Text document" : "Shared file"}</span><h2>{artifact.name}</h2><p>Shared by {artifact.owner}</p></div>
          <div className="repository-artifact-actions"><button className="button button--quiet" onClick={onBrowseRepository} type="button">Browse repository</button></div>
        </div>
        {xlsxArtifact
          ? <XlsxArtifactPreview artifact={artifact} canSendSelection={Boolean(missionId)} onUseSelection={(selection) => onUseSpreadsheetSelection?.({ ...selection, artifact })} />
          : pdfArtifact
          ? <PdfArtifactPreview artifact={artifact} />
          : mediaKind
          ? <MediaArtifactPreview artifact={artifact} />
          : artifact.previewDataUrl
          ? <figure className="artifact-image-preview">
            <div className={`artifact-image-stage ${pinMode ? "artifact-image-stage--pinning" : ""}`} onClick={(event) => {
              if (!pinMode) return;
              const point = imagePointAnchor(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
              if (point) { setReviewAnchor(point); setPinMode(false); }
            }}>
              <img alt={`Preview of ${artifact.name}`} draggable="false" src={artifact.previewDataUrl} />
              {reviewThreads.map((thread, index) => isImagePointAnchor(thread.anchor) && <button
                aria-label={`Review comment ${index + 1} at ${Math.round(thread.anchor.x * 100)} percent across, ${Math.round(thread.anchor.y * 100)} percent down`}
                className={`artifact-image-pin ${thread.status === "resolved" ? "artifact-image-pin--resolved" : ""}`}
                data-review-thread={thread.id}
                key={thread.id}
                onClick={(event) => {
                  event.stopPropagation();
                  const target = document.getElementById(`artifact-review-${thread.id}`);
                  target?.scrollIntoView({ behavior: "smooth", block: "center" });
                  target?.focus({ preventScroll: true });
                }}
                style={{ left: `${thread.anchor.x * 100}%`, top: `${thread.anchor.y * 100}%` }}
                type="button">{index + 1}</button>)}
              {reviewAnchor && <span aria-hidden="true" className="artifact-image-pin artifact-image-pin--draft" style={{ left: `${reviewAnchor.x * 100}%`, top: `${reviewAnchor.y * 100}%` }}>+</span>}
            </div>
            <figcaption>{artifact.name} · {artifact.type}</figcaption>
          </figure>
          : artifact.tableText !== undefined && !tableSourceOpen
          ? <TabularArtifactPreview delimiter={artifact.tableDelimiter ?? ","} fileName={artifact.name} onViewSource={() => setTableSourceOpen(true)} text={artifact.tableText} />
          : artifact.preview !== undefined
          ? <section className="artifact-document">
            <div className="artifact-document-toolbar">
              <span>{editingArtifact ? "Source editor" : markdownArtifact ? "Document preview" : "Text preview"}</span>
              <div className="artifact-document-actions">
              {artifact.tableText !== undefined && tableSourceOpen && <button className="button button--quiet" onClick={() => setTableSourceOpen(false)} type="button">View table</button>}
              {textArtifact && <button aria-controls={`artifact-review-navigator-${artifact.id}`} aria-expanded={commentNavigatorOpen} className="button button--quiet" disabled={editingArtifact} onClick={toggleCommentNavigator} ref={commentToggleRef} type="button">Comments{reviewThreads.length || commentDrafts.length ? ` · ${reviewThreads.length + commentDrafts.length}` : ""}</button>}
              {editingArtifact ? <>
                <button className="button button--quiet" disabled={savingArtifact} onClick={() => { setEditingArtifact(false); setArtifactDraft(artifact.preview); }} type="button">Discard</button>
                <button className="button button--primary" disabled={savingArtifact || artifactDraft === artifact.preview} onClick={() => missionId ? void saveArtifactCopy() : downloadArtifactDraft()} type="button">{savingArtifact ? "Saving…" : missionId ? "Save as new artifact" : "Download edited copy"}</button>
              </> : artifact.previewTruncated ? <span>Preview shortened · editing unavailable</span> : <button className="button button--quiet" onClick={() => { closeCommentPopover(); setCommentNavigatorOpen(false); setEditingArtifact(true); }} type="button">Edit source</button>}
              </div>
            </div>
            {textArtifact && reviewError && <p className="artifact-review-inline-error" role="status">{reviewError}</p>}
            {artifactEditError && <p className="canvas-error" role="alert">{artifactEditError}</p>}
            {editingArtifact
              ? <div className="artifact-source-editor"><ReadOnlyCodeEditor ariaLabel={`${artifact.name} source editor`} content={artifactDraft} editable key={artifact.id} maxLength={256 * 1024} onChange={setArtifactDraft} path={artifact.name} wrapLines={markdownArtifact || ["txt", "log"].includes(extension)} /></div>
              : <article aria-label={`${artifact.name} document`} className={`artifact-page${markdownArtifact ? " artifact-page--markdown message-markdown" : " artifact-page--text"}`} id={`artifact-page-${artifact.id}`} onKeyUp={captureTextSelection} onMouseUp={captureTextSelection} tabIndex={0}>
                {markdownArtifact ? <MarkdownContent>{artifact.preview}</MarkdownContent> : <div>{artifact.preview}</div>}
              </article>}
            {commentPopover && <form className="artifact-selection-composer" onSubmit={(event) => {
              event.preventDefault();
              if (!reviewText.trim()) return;
              setCommentDrafts((current) => [...current, { id: crypto.randomUUID(), anchor: commentPopover.anchor, body: reviewText.trim() }]);
              openCommentNavigator();
              setReviewText("");
              closeCommentPopover();
            }} onKeyDown={(event) => { if (event.key === "Escape") closeCommentPopover(); }} role="dialog" aria-label="Comment on selected text" style={{ left: commentPopover.left, top: commentPopover.top }}>
              <div className="artifact-selection-quote">{commentPopover.anchor.quote}</div>
              <textarea aria-label="Write a comment on the selected text" autoFocus maxLength={5000} onChange={(event) => setReviewText(event.target.value)} placeholder="Write a comment…" value={reviewText} />
              <div><button className="button button--quiet" onClick={closeCommentPopover} type="button">Cancel</button><button className="button button--primary" disabled={!reviewText.trim()} type="submit">Add to review</button></div>
            </form>}
            {commentNavigatorOpen && <section aria-label="Artifact comments" className="artifact-review-navigator" id={`artifact-review-navigator-${artifact.id}`} ref={commentNavigatorRef} role="dialog" style={commentNavigatorPosition ?? undefined}>
              <header><button aria-label="Previous comment" className="icon-button" disabled={!reviewThreads.length} onClick={() => navigateReview((activeReviewIndex - 1 + reviewThreads.length) % reviewThreads.length)} type="button"><CaretLeft size={15} /></button><strong>{reviewThreads.length ? `Comment ${Math.min(activeReviewIndex + 1, reviewThreads.length)} of ${reviewThreads.length}` : "Comments"}</strong><button aria-label="Next comment" className="icon-button" disabled={!reviewThreads.length} onClick={() => navigateReview((activeReviewIndex + 1) % reviewThreads.length)} type="button"><CaretRight size={15} /></button><button aria-label="Close comments" className="icon-button" onClick={() => setCommentNavigatorOpen(false)} type="button"><X size={14} /></button></header>
              {reviewThreads.length > 0 && <>
                <nav aria-label="Comment list" className="artifact-review-navigator-list">{reviewThreads.map((thread, index) => <button aria-current={index === activeReviewIndex ? "true" : undefined} key={thread.id} onClick={() => navigateReview(index)} type="button"><span>{thread.comments[0]?.body ?? "Comment"}</span><small>{thread.status === "open" ? "Open" : "Resolved"}</small></button>)}</nav>
                {reviewThreads[activeReviewIndex] && <ArtifactReviewThread agents={agents} busy={reviewBusy} onReply={(threadId, body) => void addReviewComment(body, threadId)} onResolve={(threadId) => void resolveReview(threadId)} onReopen={(threadId) => void reopenReview(threadId)} thread={reviewThreads[activeReviewIndex]} threadNumber={activeReviewIndex + 1} />}
              </>}
              {commentDrafts.length > 0 && <div className="artifact-review-drafts"><strong>{commentDrafts.length} draft{commentDrafts.length === 1 ? "" : "s"}</strong>{commentDrafts.map((draft) => <div className="artifact-review-draft" key={draft.id}><small>“{draft.anchor.quote}”</small><textarea aria-label="Edit draft comment" onChange={(event) => setCommentDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, body: event.target.value } : item))} value={draft.body} /><button aria-label="Remove draft comment" className="icon-button" onClick={() => setCommentDrafts((current) => current.filter((item) => item.id !== draft.id))} type="button"><X size={13} /></button></div>)}</div>}
              {reviewError && <p className="artifact-review-inline-error" role="alert">{reviewError}</p>}
              {reviewThreads.length === 0 && commentDrafts.length === 0 && <p className="artifact-review-navigator-empty">Select text to leave a comment anchored to the document.</p>}
              {commentDrafts.length > 0 && <button className="button button--primary artifact-review-post-all" disabled={postingCommentDrafts} onClick={() => void postCommentDrafts()} type="button">{postingCommentDrafts ? "Posting…" : `Post ${commentDrafts.length} comment${commentDrafts.length === 1 ? "" : "s"}`}</button>}
            </section>}
          </section>
          : <div className="column-empty">This file can’t be previewed here.</div>}
        {!textArtifact && <section className="artifact-reviews" aria-label="Artifact review">
          <div className="artifact-reviews-heading"><div><h3>Review</h3><p>Comments stay attached to this version of the artifact.</p></div><span>{reviewThreads.filter((thread) => thread.status === "open").length} open</span></div>
          {reviewError && <p className="settings-error" role="alert">{reviewError}</p>}
          <div className="artifact-review-threads">
            {reviewThreads.map((thread, index) => <div id={`artifact-review-${thread.id}`} key={thread.id} tabIndex={-1}><ArtifactReviewThread agents={agents} busy={reviewBusy} onReply={(threadId, body) => void addReviewComment(body, threadId)} onResolve={(threadId) => void resolveReview(threadId)} onReopen={(threadId) => void reopenReview(threadId)} thread={thread} threadNumber={index + 1} /></div>)}
            {reviewThreads.length === 0 && <p className="artifact-reviews-empty">No review comments yet. Start a thread for feedback on this artifact.</p>}
          </div>
          <form className="artifact-review-composer" onSubmit={(event) => { event.preventDefault(); void addReviewComment(reviewText, null, reviewAnchor); }}>
            {artifact.previewDataUrl && <div className="artifact-review-anchor-controls">
              <button aria-pressed={pinMode} className={`button ${pinMode ? "button--primary" : "button--quiet"}`} onClick={() => setPinMode((value) => !value)} type="button">{pinMode ? "Click the preview to place a pin" : reviewAnchor ? "Choose a different location" : "Pin a location on the preview"}</button>
              {reviewAnchor && <button className="button button--quiet" onClick={() => setReviewAnchor(null)} type="button">Remove pin</button>}
            </div>}
            <textarea aria-label="Add a review comment" maxLength={5000} onChange={(event) => setReviewText(event.target.value)} placeholder={reviewAnchor ? "Comment on this location…" : "Add a review comment…"} value={reviewText} />
            <button className="button button--primary" disabled={reviewBusy || !reviewText.trim()} type="submit">Start thread</button>
          </form>
        </section>}
      </section>
    );
  }
  const root = directories[""];
  const activeFile = fileTabs.find((item) => item.path === activeFilePath);
  const isMarkdownFile = /\.(md|mdx|markdown)$/i.test(activeFilePath);
  const showMarkdownPreview = isMarkdownFile && markdownPreviewPaths.has(activeFilePath);
  async function toggleDirectory(path) {
    if (expandedPaths.has(path)) {
      setExpandedPaths((current) => { const next = new Set(current); next.delete(path); return next; });
      return;
    }
    setExpandedPaths((current) => new Set(current).add(path));
    if (directories[path] || loadingDirectories.has(path)) return;
    setLoadingDirectories((current) => new Set(current).add(path));
    try {
      const { entry: directory } = await runtime.browseProject(project.id, path);
      if (directory.kind === "directory") setDirectories((current) => ({ ...current, [path]: directory }));
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoadingDirectories((current) => { const next = new Set(current); next.delete(path); return next; });
    }
  }
  async function openFile(path) {
    const existing = fileTabs.find((item) => item.path === path);
    if (existing) { setActiveFilePath(path); return; }
    setLoadingFiles((current) => new Set(current).add(path));
    setError("");
    try {
      const { entry: file } = await runtime.browseProject(project.id, path);
      setFileTabs((current) => current.some((item) => item.path === path) ? current : [...current, file]);
      setActiveFilePath(path);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoadingFiles((current) => { const next = new Set(current); next.delete(path); return next; });
    }
  }
  function closeFile(path) {
    const tabIndex = fileTabs.findIndex((item) => item.path === path);
    const nextTabs = fileTabs.filter((item) => item.path !== path);
    setFileTabs(nextTabs);
    if (activeFilePath === path) setActiveFilePath(nextTabs[Math.min(tabIndex, nextTabs.length - 1)]?.path ?? "");
  }
  return (
    <section className="tab-panel detail-view repository-view">
      {!project.id ? <div className="column-empty">Add or select a Git project to browse its repository.</div> : <div className="repository-browser">
        {error && <p className="settings-error" role="alert">{error}</p>}
        <div className="repository-workbench">
          <aside aria-label="Repository files" className="repository-explorer" title={project.repository}>
            <div className="repository-tree">
              {loadingRoot ? <div className="repository-tree-empty">Loading files…</div> : root?.entries?.length
                ? <RepositoryTree entries={root.entries} expandedPaths={expandedPaths} directories={directories} activePath={activeFilePath} onToggle={toggleDirectory} onOpenFile={openFile} />
                : <div className="repository-tree-empty">No files to show.</div>}
            </div>
          </aside>
          <section aria-label="File preview" className="repository-editor-panel">
            <div className="repository-file-tab-bar">
              <div aria-label="Open files" className="repository-file-tabs" role="tablist">
                {fileTabs.map((file) => <div className={`repository-file-tab ${activeFilePath === file.path ? "repository-file-tab--selected" : ""}`} key={file.path}>
                  <button aria-selected={activeFilePath === file.path} className="repository-file-tab-select" onClick={() => setActiveFilePath(file.path)} role="tab" title={file.path} type="button"><Code size={14} /><span>{fileName(file)}</span></button>
                  <button aria-label={`Close ${fileName(file)}`} className="repository-file-tab-close" onClick={() => closeFile(file.path)} title={`Close ${fileName(file)}`} type="button"><X size={13} /></button>
                </div>)}
              </div>
              {isMarkdownFile && <button
                aria-label={showMarkdownPreview ? "Show Markdown source" : "Show Markdown preview"}
                aria-pressed={showMarkdownPreview}
                className="repository-preview-toggle"
                onClick={() => setMarkdownPreviewPaths((current) => {
                  const next = new Set(current);
                  if (next.has(activeFilePath)) next.delete(activeFilePath);
                  else next.add(activeFilePath);
                  return next;
                })}
                title={showMarkdownPreview ? "Show source" : "Show rendered Markdown"}
                type="button"
              >{showMarkdownPreview ? <Code size={16} /> : <Eye size={16} />}</button>}
            </div>
            <div className="repository-editor-content">
              {activeFile?.tooLarge ? <div className="repository-empty-editor">This file is larger than the 1 MB preview limit.</div>
                : activeFile?.binary ? <div className="repository-empty-editor">Binary files can’t be previewed here.</div>
                  : activeFile && showMarkdownPreview ? <div className="repository-markdown-preview"><div className="message-markdown"><MarkdownContent onOpenRepositoryFile={(path) => void openFile(path)} onResolveRepositoryImage={resolveRepositoryImage} repositoryBasePath={activeFile.path}>{activeFile.content ?? ""}</MarkdownContent></div></div>
                    : activeFile ? <ReadOnlyCodeEditor content={activeFile.content ?? ""} path={activeFile.path} wrapLines={wordWrap} />
                    : <div className="repository-empty-editor"><FolderOpen size={26} /><span>{loadingFiles.size ? "Opening file…" : "Select a file to preview"}</span><small>Choose a file from the explorer to open it in a tab.</small></div>}
            </div>
            <div className="repository-status-bar"><span>{activeFile?.path ?? project.repository ?? "Repository"}</span><span>{activeFile && `${(activeFile.size / 1024).toFixed(1)} KB`}</span>{activeFile && !showMarkdownPreview && <button aria-label={wordWrap ? "Turn off word wrap" : "Turn on word wrap"} aria-pressed={wordWrap} className="repository-wrap-toggle" onClick={() => setWordWrapByPath((current) => ({ ...current, [activeFilePath]: !wordWrap }))} title={wordWrap ? "Turn off word wrap" : "Turn on word wrap"} type="button"><TextAlignLeft size={14} /></button>}<span>Read only</span></div>
          </section>
        </div>
        {root?.truncated && <p className="repository-truncated">Showing the first 300 items in each folder.</p>}
      </div>}
    </section>
  );
}
