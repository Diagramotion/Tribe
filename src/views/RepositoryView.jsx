import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { CaretDown, CaretRight, CheckCircle, Code, Eye, FileText, FolderOpen, FolderSimple, TextAlignLeft, X } from "@phosphor-icons/react";
import { imagePointAnchor, isImagePointAnchor } from "../domain/artifact-anchor.js";
import { runtime } from "../api/runtime.js";
import { MarkdownContent } from "../components/MarkdownContent.jsx";
import { ReadOnlyCodeEditor } from "../components/ReadOnlyCodeEditor.jsx";

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

function ArtifactReviewThread({ thread, threadNumber, agents, busy, onReply, onResolve, onReopen }) {
  const [reply, setReply] = useState("");
  return <article className="artifact-review-thread">
    <div className="artifact-review-thread-heading"><span>Review {threadNumber} · {thread.status === "open" ? "Open thread" : "Resolved"}</span><code>{thread.version_hash.slice(0, 10)}</code></div>
    {isImagePointAnchor(thread.anchor) && <p className="artifact-review-location">Pinned at {Math.round(thread.anchor.x * 100)}% across, {Math.round(thread.anchor.y * 100)}% down</p>}
    {thread.comments.map((comment) => <div className="artifact-review-comment" key={comment.id}><strong>{comment.author_id === "user" ? "You" : agents.find((agent) => agent.id === comment.author_id)?.name ?? comment.author_id}</strong><time>{new Date(comment.created_at).toLocaleString()}</time><p>{comment.body}</p></div>)}
    {thread.status === "open" && <div className="artifact-review-thread-actions"><form onSubmit={(event) => { event.preventDefault(); if (reply.trim()) { onReply(thread.id, reply); setReply(""); } }}><input aria-label="Reply to review comment" maxLength={5000} onChange={(event) => setReply(event.target.value)} placeholder="Reply to this thread…" value={reply} /><button className="button button--quiet" disabled={busy || !reply.trim()} type="submit">Reply</button></form><button className="button button--quiet" disabled={busy} onClick={() => onResolve(thread.id)} type="button">Resolve</button></div>}
    {thread.status === "resolved" && <div className="artifact-review-thread-actions"><span className="artifact-review-resolved-by">Resolved{thread.resolved_by ? ` by ${thread.resolved_by === "user" ? "you" : agents.find((agent) => agent.id === thread.resolved_by)?.name ?? thread.resolved_by}` : ""}</span><button className="button button--quiet" disabled={busy} onClick={() => onReopen(thread.id)} type="button">Reopen thread</button></div>}
  </article>;
}

export function RepositoryView({ artifact, project, agents = [], onBrowseRepository, reviewRevision = 0 }) {
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
    return (
      <section className="tab-panel detail-view">
        <div className="detail-heading">
          <div><span className="eyebrow">Shared deliverable</span><h2>{artifact.name}</h2><p>Shared by {artifact.owner} · {artifact.type}</p></div>
          <div className="repository-artifact-actions"><span className="artifact-count">Available in the chat artifacts</span><button className="button button--quiet" onClick={onBrowseRepository} type="button">Browse repository</button></div>
        </div>
        {artifact.previewDataUrl
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
          : artifact.preview !== undefined
          ? <pre className="text-artifact-preview">{artifact.preview}</pre>
          : <div className="column-empty">This file can’t be previewed here.</div>}
        <div className="artifact-context"><CheckCircle size={17} /><span>Shared in the chat by {artifact.owner}.</span></div>
        <section className="artifact-reviews" aria-label="Artifact review">
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
        </section>
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
