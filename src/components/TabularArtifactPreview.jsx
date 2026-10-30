import { useMemo, useState } from "react";
import { ArrowLineDown, Code, MagnifyingGlass } from "@phosphor-icons/react";

const MAX_PREVIEW_ROWS = 5000;
const PAGE_SIZE = 50;

function parseDelimitedText(source, delimiter) {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let truncated = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell.length === 0) quoted = true;
    else if (character === delimiter) {
      row.push(cell);
      cell = "";
    } else if (character === "\r" || character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      if (rows.length > MAX_PREVIEW_ROWS + 1) {
        truncated = true;
        break;
      }
    } else cell += character;
  }
  if (!truncated && (cell.length > 0 || row.length > 0)) {
    row.push(cell);
    rows.push(row);
  }
  if (rows.length > MAX_PREVIEW_ROWS + 1) {
    rows.length = MAX_PREVIEW_ROWS + 1;
    truncated = true;
  }
  const sourceHeaders = rows.shift() ?? [];
  const headers = sourceHeaders.map((header, index) => header.trim() || `Column ${index + 1}`);
  return {
    headers,
    rows: rows.filter((values) => values.some((value) => value !== "")),
    truncated,
  };
}

function compareCells(left, right) {
  if (left === "") return right === "" ? 0 : 1;
  if (right === "") return -1;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function downloadTable(text, fileName) {
  const type = fileName.toLowerCase().endsWith(".tsv") ? "text/tab-separated-values;charset=utf-8" : "text/csv;charset=utf-8";
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function TabularArtifactPreview({ text, fileName, delimiter, truncated = false, onViewSource }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState({ column: -1, descending: false });
  const [page, setPage] = useState(0);
  const parsed = useMemo(() => parseDelimitedText(text, delimiter), [text, delimiter]);
  const filteredRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    let rows = query
      ? parsed.rows.filter((values) => values.some((value) => value.toLocaleLowerCase().includes(query)))
      : parsed.rows;
    if (sort.column >= 0) {
      rows = [...rows].sort((left, right) => {
        const result = compareCells(left[sort.column] ?? "", right[sort.column] ?? "");
        return sort.descending ? -result : result;
      });
    }
    return rows;
  }, [parsed.rows, search, sort]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleRows = filteredRows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const firstRow = filteredRows.length ? currentPage * PAGE_SIZE + 1 : 0;
  const lastRow = Math.min((currentPage + 1) * PAGE_SIZE, filteredRows.length);

  function sortColumn(column) {
    setSort((current) => ({
      column,
      descending: current.column === column ? !current.descending : false,
    }));
    setPage(0);
  }

  return <section aria-label={`${fileName} table`} className="tabular-artifact-view">
    <div className="tabular-artifact-toolbar">
      <label className="tabular-artifact-search">
        <MagnifyingGlass aria-hidden="true" size={15} />
        <input aria-label="Search table values" onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="Search values" type="search" value={search} />
      </label>
      <div className="tabular-artifact-actions">
        <span>{filteredRows.length.toLocaleString()} rows{parsed.truncated || truncated ? " · preview limited" : ""}</span>
        <button aria-label="Download table file" className="icon-button" onClick={() => downloadTable(text, fileName)} title="Download table file" type="button"><ArrowLineDown size={16} /></button>
        <button aria-label="View source" className="icon-button" onClick={onViewSource} title="View source" type="button"><Code size={16} /></button>
      </div>
    </div>
    {parsed.headers.length === 0
      ? <div className="tabular-artifact-empty">This file has no table header.</div>
      : <div className="tabular-artifact-scroll">
        <table className="tabular-artifact-table">
          <thead><tr>{parsed.headers.map((header, index) => <th aria-sort={sort.column === index ? sort.descending ? "descending" : "ascending" : "none"} key={`${index}-${header}`} scope="col"><button onClick={() => sortColumn(index)} title={`Sort by ${header}`} type="button"><span>{header}</span><small>{sort.column === index ? sort.descending ? "↓" : "↑" : "↕"}</small></button></th>)}</tr></thead>
          <tbody>{visibleRows.map((values, rowIndex) => <tr key={`${currentPage * PAGE_SIZE + rowIndex}-${values[0]}`}>{parsed.headers.map((header, columnIndex) => <td key={`${columnIndex}-${header}`}>{values[columnIndex] ?? ""}</td>)}</tr>)}</tbody>
        </table>
        {visibleRows.length === 0 && <div className="tabular-artifact-empty">No rows match this search.</div>}
      </div>}
    <footer className="tabular-artifact-pagination">
      <span>{firstRow}–{lastRow} of {filteredRows.length.toLocaleString()}</span>
      <button aria-label="Previous table page" className="button button--quiet" disabled={currentPage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} type="button">Previous</button>
      <button aria-label="Next table page" className="button button--quiet" disabled={currentPage + 1 >= pageCount} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} type="button">Next</button>
    </footer>
  </section>;
}
