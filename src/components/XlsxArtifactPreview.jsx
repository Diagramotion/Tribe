import { useEffect, useMemo, useState } from "react";
import { ArrowLineDown, MagnifyingGlass, PaperPlaneRight } from "@phosphor-icons/react";
import { runtime } from "../api/runtime.js";
import { SelectControl } from "./SelectControl.jsx";

function columnName(index) {
  let number = index + 1;
  let label = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    number = Math.floor((number - 1) / 26);
  }
  return label;
}

function tsvCell(value) {
  return /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function downloadWorkbook(artifact) {
  runtime.getArtifact(artifact.id).then(({ contentBase64 }) => {
    const binary = atob(contentBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: artifact.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = artifact.name;
    link.click();
    URL.revokeObjectURL(url);
  }).catch((error) => console.error("Could not download workbook:", error));
}

export function XlsxArtifactPreview({ artifact, canSendSelection, onUseSelection }) {
  const [sheet, setSheet] = useState("");
  const [sheetQuery, setSheetQuery] = useState("");
  const [headerRows, setHeaderRows] = useState(1);
  const [offset, setOffset] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState(null);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectionError, setSelectionError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    runtime.previewXlsxArtifact(artifact.id, sheet, offset, 50, search, headerRows)
      .then(({ preview: result }) => {
        if (!active) return;
        setPreview(result);
        if (!sheet) setSheet(result.sheet);
      })
      .catch((loadError) => { if (active) setError(loadError.message || "Could not open this worksheet."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [artifact.id, sheet, offset, search, headerRows]);

  useEffect(() => setSelection(null), [artifact.id, sheet, search, headerRows]);
  useEffect(() => setSelectionError(""), [selection]);

  const displayRows = useMemo(() => preview?.rows ?? [], [preview]);
  const mergedCellLayout = useMemo(() => {
    const anchors = new Map();
    const covered = new Set();
    for (const range of preview?.mergedRanges ?? []) {
      const anchorKey = `${range.firstRow}:${range.firstColumn - 1}`;
      anchors.set(anchorKey, {
        rowSpan: range.lastRow - range.firstRow + 1,
        colSpan: range.lastColumn - range.firstColumn + 1,
      });
      for (let row = range.firstRow; row <= range.lastRow; row += 1) {
        for (let column = range.firstColumn; column <= range.lastColumn; column += 1) {
          if (row !== range.firstRow || column !== range.firstColumn) {
            covered.add(`${row}:${column - 1}`);
          }
        }
      }
    }
    return { anchors, covered };
  }, [preview]);

  const selectedCells = useMemo(() => {
    if (!selection || !preview) return null;
    const minRow = Math.min(selection.anchor.rowNumber, selection.focus.rowNumber);
    const maxRow = Math.max(selection.anchor.rowNumber, selection.focus.rowNumber);
    const minColumn = Math.min(selection.anchor.columnIndex, selection.focus.columnIndex);
    const maxColumn = Math.max(selection.anchor.columnIndex, selection.focus.columnIndex);
    const headers = preview.headers.slice(minColumn, maxColumn + 1);
    const range = `${columnName(minColumn)}${minRow}:${columnName(maxColumn)}${maxRow}`;
    const rowCount = maxRow - minRow + 1;
    const columnCount = maxColumn - minColumn + 1;
    return { range, headers, startRow: minRow, rowCount, startColumn: minColumn, columnCount, area: rowCount * columnCount };
  }, [preview, selection]);

  async function shareSelection() {
    if (!selectedCells || selectedCells.area > 2_000 || selectedCells.rowCount > 50 || search || !canSendSelection || selectionLoading) return;
    setSelectionLoading(true);
    setSelectionError("");
    try {
      const { preview: result } = await runtime.previewXlsxArtifact(
        artifact.id, preview.sheet, selectedCells.startRow - preview.headerRows - 1,
        selectedCells.rowCount, "", preview.headerRows,
      );
      const expectedFirstRow = selectedCells.startRow;
      if (result.rows.length !== selectedCells.rowCount || result.rows[0]?.rowNumber !== expectedFirstRow) {
        throw new Error("Could not load every cell in this range.");
      }
      const endColumn = selectedCells.startColumn + selectedCells.columnCount;
      const truncated = result.truncatedCells.some((cell) => {
        const [row, column] = cell.split(":").map(Number);
        return row >= selectedCells.startRow && row < selectedCells.startRow + selectedCells.rowCount
          && column > selectedCells.startColumn && column <= endColumn;
      });
      if (truncated) throw new Error("This range includes a long cell value. Narrow the selection to share it.");
      const values = result.rows.map((row) => row.values.slice(selectedCells.startColumn, endColumn));
      const displayValues = result.rows.map((row) => (row.displayValues ?? row.values).slice(selectedCells.startColumn, endColumn));
      const formulaLines = result.rows.flatMap((row) => (row.formulaInfo ?? [])
        .slice(selectedCells.startColumn, endColumn)
        .map((info, columnIndex) => info ? `${columnName(selectedCells.startColumn + columnIndex)}${row.rowNumber}: ${info.formula}${info.resultMissing ? " (no saved result)" : ""}` : null)
        .filter(Boolean));
      const hasFormattedValues = displayValues.some((row, rowIndex) => row.some((value, columnIndex) => value !== values[rowIndex][columnIndex]));
      const displayText = displayValues.map((row) => row.map(tsvCell).join("\t")).join("\n");
      const storedText = values.map((row) => row.map(tsvCell).join("\t")).join("\n");
      const formulaText = formulaLines.length
        ? `Formula cells:\n${formulaLines.slice(0, 50).join("\n")}${formulaLines.length > 50 ? `\n…and ${formulaLines.length - 50} more formula cells.` : ""}`
        : "";
      await onUseSelection({
        range: selectedCells.range,
        sheet: preview.sheet,
        fileName: artifact.name,
        text: `Column headers: ${selectedCells.headers.map(tsvCell).join("\t")}\n${hasFormattedValues ? `Displayed values:\n${displayText}\nStored values:\n${storedText}` : storedText}${formulaText ? `\n${formulaText}` : ""}`,
      });
    } catch (selectionLoadError) {
      setSelectionError(selectionLoadError.message || "Could not load this cell range.");
    } finally {
      setSelectionLoading(false);
    }
  }

  function chooseCell(rowNumber, columnIndex, extend) {
    const point = { rowNumber, columnIndex };
    setSelection((current) => extend && current
      ? { ...current, focus: point }
      : { anchor: point, focus: point });
  }

  function isSelected(rowNumber, columnIndex) {
    if (!selection) return false;
    return rowNumber >= Math.min(selection.anchor.rowNumber, selection.focus.rowNumber)
      && rowNumber <= Math.max(selection.anchor.rowNumber, selection.focus.rowNumber)
      && columnIndex >= Math.min(selection.anchor.columnIndex, selection.focus.columnIndex)
      && columnIndex <= Math.max(selection.anchor.columnIndex, selection.focus.columnIndex);
  }

  const firstRow = displayRows[0]?.rowNumber ?? 0;
  const lastRow = displayRows.at(-1)?.rowNumber ?? 0;
  return <section aria-label={`${artifact.name} workbook`} className="xlsx-artifact-view">
    <div className="xlsx-artifact-toolbar">
      <label><span>Header rows</span>
        <SelectControl aria-label="Choose header row count" onChange={(value) => { setHeaderRows(Number(value)); setOffset(0); }} options={[1, 2, 3, 4, 5].map((count) => ({ value: count, label: String(count) }))} size="compact" value={headerRows} />
      </label>
      <label><span>Worksheet</span>
        <SelectControl aria-label="Choose worksheet" onChange={(value) => { setSheet(value); setOffset(0); }} options={[...(sheet && !(preview?.sheets ?? []).includes(sheet) ? [{ value: sheet, label: sheet }] : []), ...(preview?.sheets ?? []).map((name) => ({ value: name, label: name }))]} size="regular" value={sheet || preview?.sheet || ""} />
      </label>
      <span className="xlsx-artifact-note">Click a cell, then Shift-click another to select a range.</span>
      {preview?.sheetsTruncated && <form className="xlsx-sheet-name-form" onSubmit={(event) => { event.preventDefault(); const value = sheetQuery.trim(); if (value) { setSheet(value); setOffset(0); } }}>
        <input aria-label="Worksheet name" onChange={(event) => setSheetQuery(event.target.value)} placeholder="Worksheet name" value={sheetQuery} />
        <button className="button button--quiet" disabled={!sheetQuery.trim() || sheetQuery.trim() === sheet} type="submit">Open sheet</button>
      </form>}
      <label className="xlsx-artifact-search"><MagnifyingGlass aria-hidden="true" size={15} /><input aria-label="Search worksheet values" onChange={(event) => setSearchInput(event.target.value)} placeholder="Search worksheet values" type="search" value={searchInput} /></label>
      <div className="xlsx-artifact-actions">
        <button aria-label="Download workbook" className="icon-button" onClick={() => downloadWorkbook(artifact)} title="Download workbook" type="button"><ArrowLineDown size={16} /></button>
      </div>
    </div>
    {preview?.columnsTruncated && <p className="xlsx-artifact-note">Showing the first 100 columns.</p>}
    {preview?.mergedRangesPartial && <p className="xlsx-artifact-note">Merged cells crossing this page or the 100-column preview edge are shown as separate cells.</p>}
    {preview?.mergedRangesTruncated && <p className="xlsx-artifact-note">Only the first 5,000 merged ranges are available in this preview.</p>}
    {error && <div className="xlsx-artifact-empty" role="alert">{error}</div>}
    {!error && loading && <div className="xlsx-artifact-empty" role="status">Loading worksheet…</div>}
    {!error && !loading && preview && <>
      <div className="xlsx-artifact-scroll">
        <table className="xlsx-artifact-table">
          <thead><tr><th className="xlsx-row-number" scope="col">Row</th>{preview.headers.map((header, index) => <th key={`${index}-${header}`} scope="col"><span className="xlsx-column-letter">{columnName(index)}</span><span>{header}</span></th>)}</tr></thead>
          <tbody>{displayRows.map((row) => <tr key={row.rowNumber}>
            <th className="xlsx-row-number" scope="row">{row.rowNumber}</th>
            {row.values.map((value, columnIndex) => {
              const cellLayoutKey = `${row.rowNumber}:${columnIndex}`;
              if (mergedCellLayout.covered.has(cellLayoutKey)) return null;
              const mergedCell = mergedCellLayout.anchors.get(cellLayoutKey);
              const cellKey = `${row.rowNumber}:${columnIndex + 1}`;
              const valueTruncated = preview.truncatedCells.includes(cellKey);
              const displayValue = row.displayValues?.[columnIndex] ?? value;
              const numberFormat = row.numberFormats?.[columnIndex];
              const formulaInfo = row.formulaInfo?.[columnIndex];
              const formulaResultMissing = formulaInfo?.resultMissing === true;
              const cellTitle = formulaResultMissing
                ? `${columnName(columnIndex)}${row.rowNumber} · Formula result has no saved value; the workbook may need recalculation · Formula: ${formulaInfo.formula}`
                : `${columnName(columnIndex)}${row.rowNumber} · Stored value: ${value}${formulaInfo?.formula ? ` · Formula: ${formulaInfo.formula}` : ""}${numberFormat ? ` · Excel format: ${numberFormat}` : ""}${mergedCell ? ` · Merged across ${mergedCell.rowSpan} rows and ${mergedCell.colSpan} columns` : ""}`;
              return <td className={isSelected(row.rowNumber, columnIndex) ? "xlsx-cell--selected" : ""} colSpan={mergedCell?.colSpan} key={columnIndex} rowSpan={mergedCell?.rowSpan}>
                <button aria-pressed={isSelected(row.rowNumber, columnIndex)} disabled={Boolean(search)} onClick={(event) => chooseCell(row.rowNumber, columnIndex, event.shiftKey)} title={search ? "Clear search to select a cell range" : valueTruncated ? "Cell value shortened in preview" : cellTitle} type="button">{formulaResultMissing ? <span className="xlsx-formula-missing">No saved result</span> : displayValue}{valueTruncated ? "…" : ""}</button>
              </td>;
            })}
          </tr>)}</tbody>
        </table>
        {preview.rows.length === 0 && <div className="xlsx-artifact-empty">{search ? "No worksheet values match this search." : "This worksheet has no data rows."}</div>}
      </div>
      <footer className="xlsx-artifact-footer">
        <span>{search ? `${preview.rows.length ? offset + 1 : 0}–${offset + preview.rows.length} of ${preview.matchCount} matches` : firstRow ? `Rows ${firstRow}–${lastRow}` : "No data rows"}{preview.hasMore ? " · more available" : " · end of worksheet"}</span>
        {selectedCells && <span className="xlsx-selection-label">{preview.sheet} · {selectedCells.range}</span>}
        <button className="button button--quiet" disabled={offset === 0 || loading} onClick={() => setOffset((value) => Math.max(0, value - 50))} type="button">Previous</button>
        <button className="button button--quiet" disabled={!preview.hasMore || loading} onClick={() => setOffset((value) => value + preview.rows.length)} type="button">Next</button>
        <button className="button button--quiet" disabled={!selectedCells || selectedCells.area > 2_000 || selectedCells.rowCount > 50 || Boolean(search) || !canSendSelection || selectionLoading} onClick={() => void shareSelection()} title={!canSendSelection ? "Open this workbook from a chat to send a selection." : search ? "Clear search to select a cell range." : selectedCells?.area > 2_000 || selectedCells?.rowCount > 50 ? "Select no more than 50 rows or 2,000 cells at a time." : "Add the selected cells and source context to the chat composer."} type="button"><PaperPlaneRight size={15} /> {selectionLoading ? "Loading selection…" : "Add selection to chat"}</button>
      </footer>
      {selectionError && <p className="xlsx-artifact-note" role="alert">{selectionError}</p>}
      {preview.searchTruncated && <p className="xlsx-artifact-note" role="status">Search stopped after the first 100,000 worksheet rows.</p>}
      {preview.rowLimitReached && !search && <p className="xlsx-artifact-note" role="status">Preview is capped at the first 100,000 worksheet rows.</p>}
    </>}
  </section>;
}
