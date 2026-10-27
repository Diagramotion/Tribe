import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, GitBranch, GitDiff, FileText } from "@phosphor-icons/react";
import { runtime } from "../api/runtime.js";

function changeLabel(status) {
  if (status === "??") return "U";
  if (status.includes("A")) return "A";
  if (status.includes("D")) return "D";
  if (status.includes("R")) return "R";
  if (status.includes("C")) return "C";
  return "M";
}

function decorateDiff(diff) {
  let oldLine = null;
  let newLine = null;
  return diff.split(/(?<=\n)/).map((line, index) => {
    const content = line.replace(/\n$/, "");
    const hunk = content.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { index, content, kind: "hunk", oldLine: "", newLine: "" };
    }
    const kind = content.startsWith("+") && !content.startsWith("+++") ? "added"
      : content.startsWith("-") && !content.startsWith("---") ? "removed"
        : content.startsWith("diff ") || content.startsWith("index ") || content.startsWith("---") || content.startsWith("+++") ? "meta" : "";
    const decorated = { index, content: content || " ", kind, oldLine: "", newLine: "" };
    if (kind === "added") {
      decorated.newLine = newLine ?? "";
      if (newLine !== null) newLine += 1;
    } else if (kind === "removed") {
      decorated.oldLine = oldLine ?? "";
      if (oldLine !== null) oldLine += 1;
    } else if (!kind && oldLine !== null && newLine !== null) {
      decorated.oldLine = oldLine++;
      decorated.newLine = newLine++;
    }
    return decorated;
  });
}

export function GitChangesView({ project }) {
  const [status, setStatus] = useState(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [diff, setDiff] = useState("");
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState("");
  const lastDiffTarget = useRef({ projectId: "", path: "" });

  const refresh = useCallback(async () => {
    if (!project?.id) return;
    try {
      const next = await runtime.getProjectGitStatus(project.id);
      setStatus(next);
      setSelectedPath((current) => next.files.some((file) => file.path === current) ? current : next.files[0]?.path ?? "");
      setError("");
    } catch (loadError) { setError(loadError.message); }
    finally { setLoading(false); }
  }, [project?.id]);

  useEffect(() => {
    setStatus(null);
    setSelectedPath("");
    setDiff("");
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let current = true;
    const targetChanged = lastDiffTarget.current.projectId !== project?.id || lastDiffTarget.current.path !== selectedPath;
    lastDiffTarget.current = { projectId: project?.id ?? "", path: selectedPath };
    if (!project?.id || !selectedPath) { setDiff(""); setDiffLoading(false); return undefined; }
    if (targetChanged) { setDiff(""); setDiffLoading(true); }
    runtime.getProjectGitDiff(project.id, selectedPath).then((result) => {
      if (current) { setDiff(result.diff); setError(""); }
    }).catch((loadError) => { if (current) { if (targetChanged) setDiff(""); setError(loadError.message); } })
      .finally(() => { if (current) setDiffLoading(false); });
    return () => { current = false; };
  }, [project?.id, selectedPath, status]);

  return <section aria-label="Git changes" className="git-changes-view">
    <header className="git-changes-toolbar">
      <span><GitBranch size={14} />{status?.branch || "Git changes"}</span>
      <button aria-label="Refresh changes" className="icon-button" onClick={() => { setLoading(true); void refresh(); }} title="Refresh changes" type="button"><ArrowClockwise size={15} /></button>
    </header>
    {error && <p className="git-changes-error" role="alert">{error}</p>}
    {loading && !status ? <div className="git-changes-empty">Loading changes…</div> : !status?.isGit
      ? <div className="git-changes-empty">This project is not connected to Git.</div>
      : status.files.length === 0
        ? <div className="git-changes-empty"><GitDiff size={20} /><strong>Working tree clean</strong><span>No changed files.</span></div>
        : <div className="git-changes-content">
          <nav aria-label="Changed files" className="git-changes-file-list">
            <div className="git-changes-section-title">Changes <span>{status.files.length}</span></div>
            {status.files.map((file) => <button aria-current={selectedPath === file.path ? "true" : undefined} className={`git-changes-file ${selectedPath === file.path ? "git-changes-file--selected" : ""}`} key={file.path} onClick={() => setSelectedPath(file.path)} title={file.path} type="button">
              <FileText size={14} /><span>{file.path}</span><small className={`git-change-status git-change-status--${changeLabel(file.status).toLowerCase()}`}>{changeLabel(file.status)}</small>
            </button>)}
          </nav>
          <div className="git-diff-panel">
            <div className="git-diff-heading"><span title={selectedPath}>{selectedPath || "Select a file"}</span>{selectedPath && <small>{status.files.find((file) => file.path === selectedPath)?.staged ? "Staged" : "Unstaged"}</small>}</div>
            {diffLoading ? <div className="git-changes-empty">Loading diff…</div> : <div aria-label={`${selectedPath} diff`} className="git-diff-content" role="region" tabIndex={0}>{diff
              ? decorateDiff(diff).map((line) => <div className={`git-diff-line ${line.kind ? `git-diff-line--${line.kind}` : ""}`} key={line.index}>
                <span aria-hidden="true" className="git-diff-number">{line.oldLine}</span>
                <span aria-hidden="true" className="git-diff-number">{line.newLine}</span>
                <span aria-hidden="true" className="git-diff-marker">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}</span>
                <code>{line.content}</code>
              </div>)
              : "Select a changed file to inspect its diff."}</div>}
          </div>
        </div>}
  </section>;
}
