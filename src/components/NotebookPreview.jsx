import { useEffect, useState } from "react";
import { FloppyDisk, PencilSimple, Play, Stop, X } from "@phosphor-icons/react";
import { runtime } from "../api/runtime.js";
import { SelectControl } from "./SelectControl.jsx";
import { editedNotebookName, notebookSourceText, serializeNotebook, updateNotebookCell } from "../domain/notebook.js";
import { ReadOnlyCodeEditor } from "./ReadOnlyCodeEditor.jsx";
import { MarkdownContent } from "./MarkdownContent.jsx";

function outputText(output) {
  const data = output?.data ?? {};
  const text = output?.text ?? data["text/plain"];
  return Array.isArray(text) ? text.join("") : typeof text === "string" ? text : "";
}

function parseNotebook(content) {
  try {
    const notebook = JSON.parse(content);
    if (!notebook || !Array.isArray(notebook.cells)) throw new Error("This file does not contain a notebook cell list.");
    return { notebook, error: "" };
  } catch (parseError) {
    return {
      notebook: null,
      error: parseError instanceof SyntaxError ? "This notebook file contains invalid JSON." : parseError.message,
    };
  }
}

function NotebookOutput({ output }) {
  const data = output?.data ?? {};
  const png = data["image/png"];
  const jpeg = data["image/jpeg"];
  const image = typeof png === "string" ? `data:image/png;base64,${png}`
    : typeof jpeg === "string" ? `data:image/jpeg;base64,${jpeg}` : "";
  if (image) return <figure className="notebook-output-image"><img alt="Notebook output" src={image} /></figure>;
  const markdown = data["text/markdown"];
  const markdownSource = Array.isArray(markdown) ? markdown.join("") : typeof markdown === "string" ? markdown : "";
  if (markdownSource) return <div className="notebook-output-markdown"><MarkdownContent>{markdownSource}</MarkdownContent></div>;
  const text = outputText(output) || [output?.ename, output?.evalue].filter(Boolean).join(": ") || "This rich output format is not supported in the notebook preview.";
  return <pre className={`notebook-output-text${output?.output_type === "error" ? " is-error" : ""}`}>{text}</pre>;
}

function commandQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function NotebookPreview({ content, path, projectId, missionId, onSaveNotebook, onRefreshNotebook }) {
  const [initial] = useState(() => parseNotebook(content));
  const [notebook, setNotebook] = useState(initial.notebook);
  const [error, setError] = useState(initial.error);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [confirmRun, setConfirmRun] = useState(false);
  const [confirmSetup, setConfirmSetup] = useState(false);
  const [executionRun, setExecutionRun] = useState(null);
  const [executionPurpose, setExecutionPurpose] = useState("notebook");
  const [runError, setRunError] = useState("");
  const [notebookEnvironments, setNotebookEnvironments] = useState([]);
  const [selectedEnvironment, setSelectedEnvironment] = useState(".venv");
  const [environmentError, setEnvironmentError] = useState("");

  useEffect(() => {
    if (!projectId) return undefined;
    let live = true;
    runtime.listNotebookEnvironments(projectId).then(({ environments = [] }) => {
      if (!live) return;
      setNotebookEnvironments(environments);
      setSelectedEnvironment((current) => environments.some((item) => item.id === current && item.jupyterAvailable)
        ? current
        : environments.find((item) => item.jupyterAvailable)?.id
          ?? environments.find((item) => item.uvSetupAvailable || item.pipenvSetupAvailable
            || item.poetrySetupAvailable)?.id ?? ".venv");
      setEnvironmentError("");
    }).catch((loadError) => {
      if (live) setEnvironmentError(loadError.message || "Notebook environments could not be checked.");
    });
    return () => { live = false; };
  }, [projectId]);

  useEffect(() => {
    if (!executionRun?.id || executionRun.status !== "running") return undefined;
    let live = true;
    let timer;
    const poll = async () => {
      try {
        const { runs = [] } = await runtime.listCommands(missionId);
        const latest = runs.find((item) => item.id === executionRun.id);
        if (!live || !latest) return;
        setExecutionRun(latest);
        if (latest.status === "completed") {
          if (executionPurpose === "setup") {
            const { environments = [] } = await runtime.listNotebookEnvironments(projectId);
            if (!live) return;
            setNotebookEnvironments(environments);
            setSelectedEnvironment((current) => environments.some((item) => item.id === current && item.jupyterAvailable)
              ? current
              : environments.find((item) => item.jupyterAvailable)?.id ?? ".venv");
            const jupyterReady = environments.some((item) => item.id === selectedEnvironment && item.jupyterAvailable);
            setRunError(!jupyterReady ? "Jupyter is not available in the selected project environment." : "");
            setEnvironmentError("");
          } else await onRefreshNotebook?.();
          return;
        }
        if (latest.status === "failed" || latest.status === "cancelled") {
          if (executionPurpose === "setup" && latest.status === "failed" && live) {
            setRunError("Jupyter setup failed. Open Runs to inspect the command output.");
          }
          return;
        }
      } catch (pollError) {
        if (live) setRunError(pollError.message || "Could not check notebook execution status.");
      }
      if (live) timer = window.setTimeout(poll, 1200);
    };
    timer = window.setTimeout(poll, 700);
    return () => { live = false; window.clearTimeout(timer); };
  }, [executionRun?.id, executionRun?.status, executionPurpose, missionId, onRefreshNotebook, projectId]);

  useEffect(() => {
    const parsed = parseNotebook(content);
    if (parsed.notebook) {
      setNotebook(parsed.notebook);
      setError("");
      setSaveError("");
      setEditing(false);
      setEdited(false);
    } else {
      setNotebook(null);
      setError(parsed.error);
    }
  }, [content, path]);

  if (error) return <div className="notebook-preview-error" role="alert">{error}</div>;
  if (!notebook) return <div aria-busy="true" className="notebook-preview-error">Opening notebook…</div>;
  const cells = notebook.cells;
  const kernel = notebook.metadata?.kernelspec?.display_name ?? notebook.metadata?.kernelspec?.name;
  const selectedEnvironmentAvailable = notebookEnvironments.some((item) => item.id === selectedEnvironment && item.jupyterAvailable);
  const selectedEnvironmentDetails = notebookEnvironments.find((item) => item.id === selectedEnvironment);
  const notebookSetupManager = selectedEnvironment === ".venv" && selectedEnvironmentDetails?.uvSetupAvailable ? "uv"
      : selectedEnvironment === ".venv" && selectedEnvironmentDetails?.pipenvSetupAvailable ? "pipenv"
        : selectedEnvironment === ".venv" && selectedEnvironmentDetails?.poetrySetupAvailable ? "poetry" : "";
  const notebookSetupCommand = {
    uv: "uv add --dev jupyter",
    pipenv: "pipenv install --dev jupyter",
    poetry: "poetry add --group dev jupyter",
  }[notebookSetupManager];
  const notebookSetupEnvironment = ".venv";
  const canSetupJupyter = Boolean(missionId && notebookSetupManager
    && !selectedEnvironmentAvailable);
  const setupButtonLabel = `Set up Jupyter with ${notebookSetupManager}`;
  const setupEnvironmentLabel = selectedEnvironment;
  function updateCell(index, source) {
    setNotebook((current) => updateNotebookCell(current, index, source));
    setEdited(true);
  }
  async function saveNotebook() {
    if (!edited || saving) return;
    const notebookName = editedNotebookName(path.split("/").at(-1));
    const serialised = serializeNotebook(notebook);
    setSaving(true);
    try {
      if (onSaveNotebook) await onSaveNotebook(notebookName, serialised);
      else {
        const href = URL.createObjectURL(new Blob([serialised], { type: "application/x-ipynb+json" }));
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = notebookName;
        anchor.click();
        URL.revokeObjectURL(href);
      }
      setEdited(false);
      setEditing(false);
      setSaveError("");
    } catch (saveFailure) {
      setSaveError(saveFailure.message || "The notebook copy could not be saved.");
    } finally {
      setSaving(false);
    }
  }
  async function runNotebook() {
    if (!missionId || edited || executionRun?.status === "running") return;
    setRunError("");
    setConfirmRun(false);
    try {
      const relativePath = path.replaceAll("\\", "/");
      const command = `jupyter nbconvert --to notebook --execute --inplace ${commandQuote(relativePath)}`;
      setExecutionPurpose("notebook");
      const run = await runtime.startCommand(missionId, command, { jupyterEnvironment: selectedEnvironment });
      setExecutionRun(run);
    } catch (startError) {
      const message = startError.message || "Could not start notebook execution.";
      setRunError(message === "executable_not_found:jupyter"
        ? `Jupyter is unavailable in ${selectedEnvironment || "the selected environment"}. Add it to the project environment and lock it before running notebooks.`
        : message);
    }
  }
  async function runNotebookSetup() {
    if (!missionId || !canSetupJupyter || executionRun?.status === "running") return;
    setRunError("");
    setConfirmSetup(false);
    try {
      setExecutionPurpose("setup");
      const run = await runtime.startCommand(missionId, notebookSetupCommand, {
        notebookSetupEnvironment, notebookSetupManager,
      });
      setExecutionRun(run);
    } catch (setupError) {
      setRunError(setupError.message || "Could not start Jupyter setup.");
    }
  }
  async function stopNotebook() {
    if (!executionRun?.id) return;
    try {
      const run = await runtime.stopCommand(executionRun.id);
      if (run) setExecutionRun(run);
    } catch (stopError) {
      setRunError(stopError.message || "Could not stop notebook execution.");
    }
  }
  return <section aria-label={`Notebook preview: ${path}`} className="notebook-preview">
    <header className="notebook-preview-heading">
      <div><strong>{path.split("/").at(-1)}</strong><span>{cells.length} {cells.length === 1 ? "cell" : "cells"}{kernel ? ` · ${kernel}` : ""}{edited ? " · Unsaved edits" : ""}</span></div>
      <div className="notebook-preview-actions">
        {missionId && <div className="notebook-environment-control">
          <span>Environment</span>
          <SelectControl
            disabled={!notebookEnvironments.some((item) => item.jupyterAvailable || item.uvSetupAvailable
              || item.pipenvSetupAvailable || item.poetrySetupAvailable)}
            label="Notebook environment"
            onChange={setSelectedEnvironment}
            options={notebookEnvironments.map((item) => {
              const setupAvailable = item.uvSetupAvailable || item.pipenvSetupAvailable
                || item.poetrySetupAvailable;
              return { value: item.id, label: `${item.label}${item.jupyterAvailable ? "" : " · unavailable"}`, disabled: !item.jupyterAvailable && !setupAvailable };
            })}
            size="compact"
            value={selectedEnvironment}
          />
        </div>}
        {missionId && (executionRun?.status === "running"
          ? <><span className="notebook-preview-readonly">{executionPurpose === "setup" ? "Setting up Jupyter…" : "Running locally…"}</span><button className="button button--quiet" onClick={() => void stopNotebook()} type="button"><Stop size={14} />Stop</button></>
          : <><button className="button button--quiet" disabled={editing || edited || !selectedEnvironmentAvailable} onClick={() => { setRunError(""); setConfirmRun(true); }} type="button"><Play size={14} />{executionRun?.status === "completed" ? "Run again" : "Run all cells"}</button>{executionRun && <span className="notebook-preview-readonly">{executionPurpose === "setup" && executionRun.status === "completed" ? "Environment ready" : executionRun.status === "completed" ? "Completed" : executionRun.status === "cancelled" ? "Stopped" : "Failed"}{executionRun.exit_code !== undefined && executionRun.exit_code !== null ? ` · exit ${executionRun.exit_code}` : ""}</span>}</>)}
        {editing ? <><button className="button button--quiet" disabled={saving} onClick={() => { try { setNotebook(JSON.parse(content)); setEdited(false); setEditing(false); setSaveError(""); } catch { /* Initial content was validated above. */ } }} type="button"><X size={14} />Discard edits</button><button className="button button--primary" disabled={!edited || saving} onClick={() => void saveNotebook()} type="button"><FloppyDisk size={14} />{saving ? "Saving…" : onSaveNotebook ? "Save shared copy" : "Download edited copy"}</button></> : <button className="button button--quiet" onClick={() => setEditing(true)} type="button"><PencilSimple size={14} />Edit cells</button>}
      </div>
    </header>
    {missionId && !selectedEnvironmentAvailable && <div className="notebook-environment-hint" role={environmentError ? "alert" : "status"}>
      <span>{environmentError || (selectedEnvironmentDetails?.locked
        ? "Add Jupyter to the selected locked environment to enable execution."
        : "Add a Python lockfile and Jupyter to .venv or venv before running notebook cells.")}</span>
      {canSetupJupyter && <button className="button button--quiet" disabled={executionRun?.status === "running"} onClick={() => { setRunError(""); setConfirmSetup(true); }} type="button">{setupButtonLabel}</button>}
      {selectedEnvironmentDetails?.locked && !canSetupJupyter && <small>Tribe can detect this environment after Jupyter is installed in it.</small>}
    </div>}
    {saveError && <p className="notebook-save-error" role="alert">{saveError}</p>}
    {runError && <p className="notebook-save-error" role="alert">{runError}</p>}
    {confirmRun && <div aria-label="Confirm notebook execution" aria-modal="true" className="notebook-run-confirm" role="dialog"><div><strong>Run this notebook locally?</strong><p>Tribe will use {selectedEnvironment} and run every code cell as your account, with access to project files and network services. Cells may change files or contact external services. Run only a notebook you trust.</p><div><button className="button button--quiet" onClick={() => setConfirmRun(false)} type="button">Cancel</button><button className="button button--primary" onClick={() => void runNotebook()} type="button"><Play size={14} />Run notebook</button></div></div></div>}
      {confirmSetup && <div aria-label="Confirm Jupyter setup" aria-modal="true" className="notebook-run-confirm" role="dialog"><div><strong>{`Set up Jupyter in ${setupEnvironmentLabel}?`}</strong><p>Tribe will run <code>{notebookSetupCommand}</code> in this project. This updates its dependency manifest and lockfile, downloads dependencies and changes the project. Review the command before continuing.</p><div><button className="button button--quiet" onClick={() => setConfirmSetup(false)} type="button">Cancel</button><button className="button button--primary" onClick={() => void runNotebookSetup()} type="button"><Play size={14} />Set up Jupyter</button></div></div></div>}
    <div className="notebook-cells">{cells.map((cell, index) => {
      const source = notebookSourceText(cell.source);
      if (cell.cell_type === "markdown") return <article className="notebook-cell notebook-cell--markdown" key={cell.id ?? index}>
        <span className="notebook-cell-index" aria-label={`Cell ${index + 1}`}>{index + 1}</span>
        <div className="notebook-cell-body"><div className="message-markdown"><MarkdownContent>{source}</MarkdownContent></div>{editing && <div className="notebook-cell-editor"><span>Markdown source</span><ReadOnlyCodeEditor ariaLabel={`Edit Markdown cell ${index + 1}`} content={source} editable key={`${cell.id ?? index}-markdown`} maxLength={200_000} onChange={(value) => updateCell(index, value)} path={`${path}.md`} wrapLines /></div>}</div>
      </article>;
      if (cell.cell_type === "code") return <article className="notebook-cell notebook-cell--code" key={cell.id ?? index}>
        <span className="notebook-cell-index" aria-label={`Cell ${index + 1}`}>{index + 1}</span>
        <div className="notebook-cell-body">{editing ? <ReadOnlyCodeEditor ariaLabel={`Edit code cell ${index + 1}`} content={source} editable key={`${cell.id ?? index}-code`} maxLength={200_000} onChange={(value) => updateCell(index, value)} path={`${path}.py`} /> : <pre className="notebook-code-source"><code>{source}</code></pre>}
          {(cell.outputs ?? []).map((output, outputIndex) => <NotebookOutput key={`${cell.id ?? index}-output-${outputIndex}`} output={output} />)}
        </div>
      </article>;
      return <article className="notebook-cell notebook-cell--raw" key={cell.id ?? index}><span className="notebook-cell-index" aria-label={`Cell ${index + 1}`}>{index + 1}</span><div className="notebook-cell-body">{editing ? <ReadOnlyCodeEditor ariaLabel={`Edit raw cell ${index + 1}`} content={source} editable key={`${cell.id ?? index}-raw`} maxLength={200_000} onChange={(value) => updateCell(index, value)} path={`${path}.txt`} wrapLines /> : <pre className="notebook-code-source"><code>{source}</code></pre>}</div></article>;
    })}</div>
  </section>;
}
