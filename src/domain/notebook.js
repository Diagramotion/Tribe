import { diffLines } from "diff";

export function notebookSourceText(source) {
  return Array.isArray(source) ? source.join("") : typeof source === "string" ? source : "";
}

export function notebookCellDiff(beforeContent, afterContent) {
  if (typeof beforeContent !== "string" || typeof afterContent !== "string"
      || beforeContent.length > 1_000_000 || afterContent.length > 1_000_000) return null;
  let before;
  let after;
  try {
    before = JSON.parse(beforeContent || "{}");
    after = JSON.parse(afterContent || "{}");
  } catch {
    return null;
  }
  if (!Array.isArray(before?.cells) || !Array.isArray(after?.cells)) return null;

  const beforeIds = new Map();
  const afterIds = new Map();
  for (const [index, cell] of before.cells.entries()) {
    if (typeof cell?.id === "string" && cell.id) beforeIds.set(cell.id, [...(beforeIds.get(cell.id) ?? []), index]);
  }
  for (const [index, cell] of after.cells.entries()) {
    if (typeof cell?.id === "string" && cell.id) afterIds.set(cell.id, [...(afterIds.get(cell.id) ?? []), index]);
  }

  const beforeMatch = new Map();
  const afterMatch = new Map();
  for (const [id, oldIndexes] of beforeIds) {
    const newIndexes = afterIds.get(id);
    if (oldIndexes.length === 1 && newIndexes?.length === 1) {
      beforeMatch.set(oldIndexes[0], newIndexes[0]);
      afterMatch.set(newIndexes[0], oldIndexes[0]);
    }
  }
  // Older notebooks may not have cell IDs. Pair remaining cells by position so edits are still reviewable.
  for (let index = 0; index < Math.min(before.cells.length, after.cells.length); index += 1) {
    if (beforeMatch.has(index) || afterMatch.has(index)) continue;
    if (before.cells[index]?.cell_type !== after.cells[index]?.cell_type) continue;
    beforeMatch.set(index, index);
    afterMatch.set(index, index);
  }

  const changes = [];
  for (const [newIndex, cell] of after.cells.entries()) {
    const oldIndex = afterMatch.get(newIndex);
    const previous = oldIndex === undefined ? null : before.cells[oldIndex];
    const oldSource = notebookSourceText(previous?.source);
    const newSource = notebookSourceText(cell?.source);
    const outputsChanged = JSON.stringify(previous?.outputs ?? []) !== JSON.stringify(cell?.outputs ?? [])
      || (previous?.execution_count ?? null) !== (cell?.execution_count ?? null);
    if (previous && oldSource === newSource && previous.cell_type === cell?.cell_type && !outputsChanged) continue;
    changes.push({
      key: cell?.id || `cell-${newIndex}`,
      index: newIndex,
      cellType: cell?.cell_type ?? "raw",
      status: previous ? "modified" : "added",
      oldSource,
      newSource,
      outputsChanged,
      lines: diffLines(oldSource, newSource).flatMap((part) =>
        (part.value.match(/(?:[^\n]*\n|[^\n]+$)/g) ?? []).map((value) => ({
          kind: part.added ? "added" : part.removed ? "removed" : "context",
          text: value.replace(/\n$/, ""),
        }))),
    });
  }
  for (const [oldIndex, cell] of before.cells.entries()) {
    if (beforeMatch.has(oldIndex)) continue;
    changes.push({
      key: cell?.id || `cell-${oldIndex}`,
      index: oldIndex,
      cellType: cell?.cell_type ?? "raw",
      status: "removed",
      oldSource: notebookSourceText(cell?.source),
      newSource: "",
      outputsChanged: false,
      lines: diffLines(notebookSourceText(cell?.source), "").flatMap((part) =>
        (part.value.match(/(?:[^\n]*\n|[^\n]+$)/g) ?? []).map((value) => ({
          kind: part.added ? "added" : part.removed ? "removed" : "context",
          text: value.replace(/\n$/, ""),
        }))),
    });
  }
  return changes.sort((left, right) => left.index - right.index || left.status.localeCompare(right.status));
}

export function notebookSourceLines(source) {
  return source.match(/(?:[^\n]*\n|[^\n]+$)/g) ?? [];
}

export function updateNotebookCell(notebook, index, source) {
  const editedCell = notebook.cells[index];
  if (!editedCell) return notebook;
  return {
    ...notebook,
    cells: notebook.cells.map((cell, cellIndex) => {
      if (cellIndex === index) {
        return {
          ...cell,
          source: notebookSourceLines(source),
          ...(cell.cell_type === "code" ? { outputs: [], execution_count: null } : {}),
        };
      }
      // Editing code invalidates later results because execution state may have changed.
      if (editedCell.cell_type === "code" && cellIndex > index && cell.cell_type === "code") {
        return { ...cell, outputs: [], execution_count: null };
      }
      return cell;
    }),
  };
}

export function serializeNotebook(notebook) {
  return `${JSON.stringify(notebook, null, 1)}\n`;
}

export function editedNotebookName(path) {
  return path.replace(/\.ipynb$/i, "") + " (edited).ipynb";
}
