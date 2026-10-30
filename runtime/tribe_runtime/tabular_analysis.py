"""Bounded, deterministic profiling for tabular chat attachments."""

from __future__ import annotations

import csv
import io
import re
from collections import Counter
from datetime import date, datetime, time, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from io import BytesIO
from typing import Any, Iterator
from zipfile import ZipFile

MAX_FILE_BYTES = 12 * 1024 * 1024
MAX_ROWS = 100_000
MAX_COLUMNS = 300
MAX_TRACKED_VALUES = 5_000
MAX_PIVOT_COLUMNS = 50
MAX_XLSX_ARCHIVE_ITEMS = 5_000
MAX_XLSX_EXPANDED_BYTES = 128 * 1024 * 1024
MAX_XLSX_MEMBER_BYTES = 64 * 1024 * 1024
XLSX_PREVIEW_ROWS = 50
XLSX_PREVIEW_COLUMNS = 100
XLSX_PREVIEW_CELL_CHARS = 1_000


def _open_tabular_artifact(
    name: str, media_type: str, content: bytes, sheet_name: str = "", header_rows: int = 1,
) -> tuple[str, list[str], Iterator[list[str]], list[str], bool]:
    if not isinstance(header_rows, int) or isinstance(header_rows, bool) or not 1 <= header_rows <= 5:
        raise ValueError("Header rows must be between 1 and 5.")
    media_type = media_type.lower().split(";", 1)[0]
    suffix = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    if not isinstance(content, bytes) or not content or len(content) > MAX_FILE_BYTES:
        raise ValueError("The spreadsheet file must be between 1 byte and 12 MB.")

    is_xlsx = suffix == "xlsx" or media_type == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if is_xlsx:
        return _open_xlsx_artifact(content, sheet_name, header_rows=header_rows)
    if header_rows != 1:
        raise ValueError("Multiple header rows are available only for XLSX workbooks.")
    if media_type not in {"text/csv", "text/tab-separated-values", "application/csv"} and suffix not in {"csv", "tsv"}:
        raise ValueError("This tool supports CSV, TSV and XLSX files.")
    if sheet_name:
        raise ValueError("Choose a sheet only for an XLSX workbook.")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError("The CSV/TSV file must use UTF-8 text encoding.") from None

    if media_type == "text/tab-separated-values" or suffix == "tsv":
        delimiter = "\t"
    else:
        try:
            delimiter = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|").delimiter
        except csv.Error:
            delimiter = ","
    try:
        stream = io.StringIO(text, newline="")
        reader = csv.reader(stream, delimiter=delimiter, strict=True)
        source_headers = next(reader, None)
    except csv.Error as error:
        raise ValueError(f"Could not parse the CSV/TSV header: {error}") from None
    if not source_headers:
        raise ValueError("The CSV/TSV file has no header row.")
    if len(source_headers) > MAX_COLUMNS:
        raise ValueError(f"The CSV/TSV file has more than {MAX_COLUMNS} columns.")

    headers: list[str] = []
    occurrences: Counter[str] = Counter()
    for index, raw_header in enumerate(source_headers, start=1):
        base = raw_header.strip()[:160] or f"Column {index}"
        occurrences[base] += 1
        headers.append(base if occurrences[base] == 1 else f"{base} ({occurrences[base]})")
    return ("TSV" if delimiter == "\t" else "CSV"), headers, _closing_csv_reader(stream, reader), [], False


def _closing_csv_reader(stream: io.StringIO, reader: Iterator[list[str]]) -> Iterator[list[str]]:
    try:
        yield from reader
    finally:
        stream.close()


def _spreadsheet_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    return str(value)


def _xlsx_display_value(value: Any, number_format: str) -> str:
    """Render common Excel date, percentage, currency and decimal formats safely."""
    raw = _spreadsheet_value(value)
    if value is None or isinstance(value, bool):
        return raw
    if isinstance(value, datetime):
        return value.date().isoformat() if value.time() == time.min else value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, (date, time)):
        return value.isoformat()
    if not number_format or number_format.casefold() == "general":
        return raw
    sections = number_format.split(";")
    section = sections[1] if str(raw).startswith("-") and len(sections) > 1 else sections[0]
    clean = re.sub(r"\[[^\]]*\]", "", section)
    clean = re.sub(r'"[^"]*"', "", clean)
    clean = re.sub(r"\\.", "", clean)
    pattern = re.search(r"[0#?][0#?,]*(?:\.([0#?]+))?", clean)
    if not pattern or re.search(r"[Ee][+-]?0", clean):
        return raw
    try:
        amount = Decimal(raw)
    except InvalidOperation:
        return raw
    if not amount.is_finite():
        return raw
    if str(raw).startswith("-") and len(sections) > 1:
        amount = abs(amount)
    percent = "%" in re.sub(r'"[^"]*"', "", section)
    if percent:
        amount *= 100
    decimals = len(pattern.group(1) or "")
    rounded = amount.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)
    integer_pattern = pattern.group(0).split(".", 1)[0]
    integer_text = f"{abs(rounded):,.{decimals}f}" if "," in integer_pattern else f"{abs(rounded):.{decimals}f}"
    if pattern.group(1) and all(char in "#?" for char in pattern.group(1)):
        integer_text = integer_text.rstrip("0").rstrip(".")
    negative = amount < 0
    currency = next((symbol for symbol in ("$", "€", "£", "¥", "₹") if symbol in section), "")
    formatted = f"{currency}{integer_text}{'%' if percent else ''}"
    if negative and "(" in section and ")" in section:
        return f"({formatted})"
    return f"-{formatted}" if negative else formatted


class _WorkbookRows:
    def __init__(
        self,
        workbook: Any,
        rows: Iterator[tuple[Any, ...]],
        include_formats: bool = False,
        formula_workbook: Any = None,
        formula_rows: Iterator[tuple[Any, ...]] | None = None,
        merged_ranges: list[dict[str, int]] | None = None,
        merged_ranges_truncated: bool = False,
    ) -> None:
        self.workbook = workbook
        self.rows = rows
        self.include_formats = include_formats
        self.formula_workbook = formula_workbook
        self.formula_rows = formula_rows
        self.merged_ranges = merged_ranges or []
        self.merged_ranges_truncated = merged_ranges_truncated
        self.closed = False

    def __iter__(self) -> _WorkbookRows:
        return self

    def __next__(self) -> list[Any]:
        try:
            row = next(self.rows)
        except StopIteration:
            self.close()
            raise
        formula_row = None
        if self.formula_rows is not None:
            formula_row = next(self.formula_rows, None)
            if formula_row is None:
                self.close()
                raise ValueError("Could not match worksheet formulas with their saved values.")
        if not self.include_formats:
            return [_spreadsheet_value(value) for value in row]
        cells = []
        for index, cell in enumerate(row):
            value = getattr(cell, "value", None)
            number_format = str(getattr(cell, "number_format", "General") or "General")
            formula_cell = formula_row[index] if formula_row is not None and index < len(formula_row) else None
            formula = (
                getattr(formula_cell, "value", None)
                if getattr(formula_cell, "data_type", None) == "f"
                else None
            )
            cells.append({
                "value": _spreadsheet_value(value),
                "display": _xlsx_display_value(value, number_format),
                "numberFormat": "" if number_format.casefold() == "general" else number_format[:120],
                "formula": str(formula)[:500] if formula else "",
                "formulaResultMissing": bool(formula) and value is None,
            })
        return cells

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        close = getattr(self.rows, "close", None)
        if callable(close):
            close()
        self.workbook.close()
        if self.formula_workbook is not None:
            self.formula_workbook.close()


def _xlsx_merged_ranges(worksheet: Any) -> tuple[list[dict[str, int]], bool]:
    """Read bounded merge metadata from the worksheet XML without loading its cells into memory."""
    from defusedxml.ElementTree import iterparse
    from openpyxl.utils.cell import range_boundaries

    merged_ranges: list[dict[str, int]] = []
    truncated = False
    with worksheet._get_source() as source:
        events = iterparse(source, events=("start", "end"))
        _event, root = next(events)
        for event, element in events:
            if event != "end":
                continue
            tag = element.tag.rsplit("}", 1)[-1]
            if tag == "sheetData":
                root.clear()
            elif tag == "mergeCell":
                reference = element.attrib.get("ref", "")
                try:
                    min_column, min_row, max_column, max_row = range_boundaries(reference)
                except (TypeError, ValueError):
                    continue
                if min_column is None or min_row is None or max_column is None or max_row is None:
                    continue
                merged_ranges.append({
                    "firstRow": min_row, "lastRow": max_row,
                    "firstColumn": min_column, "lastColumn": max_column,
                })
                if len(merged_ranges) > 5_000:
                    merged_ranges.pop()
                    truncated = True
                    break
                element.clear()
            elif tag == "row":
                element.clear()
    return merged_ranges, truncated


def _open_xlsx_artifact(
    content: bytes, sheet_name: str, include_formats: bool = False, header_rows: int = 1,
) -> tuple[str, list[str], Iterator[list[Any]], list[str], bool]:
    if not isinstance(header_rows, int) or isinstance(header_rows, bool) or not 1 <= header_rows <= 5:
        raise ValueError("Header rows must be between 1 and 5.")
    try:
        with ZipFile(BytesIO(content)) as archive:
            members = archive.infolist()
            if len(members) > MAX_XLSX_ARCHIVE_ITEMS:
                raise ValueError(f"The XLSX workbook has more than {MAX_XLSX_ARCHIVE_ITEMS:,} archive entries.")
            expanded_size = sum(member.file_size for member in members)
            if expanded_size > MAX_XLSX_EXPANDED_BYTES or any(member.file_size > MAX_XLSX_MEMBER_BYTES for member in members):
                raise ValueError("The expanded XLSX workbook exceeds the 128 MB analysis limit.")
        from openpyxl import load_workbook
        from openpyxl.xml import DEFUSEDXML

        if not DEFUSEDXML:
            raise ValueError("Secure XLSX parsing is unavailable because the XML safeguards are disabled.")
        workbook = load_workbook(
            BytesIO(content), read_only=True, data_only=True, keep_links=False,
        )
    except ValueError:
        raise
    except Exception as error:
        raise ValueError(f"Could not open this XLSX workbook: {str(error)[:180]}") from None

    available_sheets = workbook.sheetnames
    if not available_sheets:
        workbook.close()
        raise ValueError("The XLSX workbook has no worksheets.")
    selected_sheet = sheet_name or available_sheets[0]
    if selected_sheet not in available_sheets:
        workbook.close()
        raise ValueError(f"Unknown worksheet '{selected_sheet}'. Available sheets: {', '.join(available_sheets[:40])}")
    worksheet = workbook[selected_sheet]
    # Ignore unreliable dimension metadata and enforce our own limits while streaming XML rows.
    worksheet.reset_dimensions()
    merged_ranges, merged_ranges_truncated = _xlsx_merged_ranges(worksheet)
    if any(
        merged["firstRow"] <= header_rows and merged["lastColumn"] > MAX_COLUMNS
        for merged in merged_ranges
    ):
        workbook.close()
        raise ValueError(f"The selected worksheet has more than {MAX_COLUMNS} columns.")
    rows = worksheet.iter_rows(values_only=not include_formats)
    source_header_rows = []
    try:
        for _ in range(header_rows):
            source_header = next(rows, None)
            if source_header is None:
                break
            source_header_rows.append(source_header)
    except Exception as error:
        workbook.close()
        raise ValueError(f"Could not read worksheet data: {str(error)[:180]}") from None
    if not source_header_rows:
        workbook.close()
        raise ValueError("The selected worksheet has no header row.")
    if len(source_header_rows) != header_rows:
        workbook.close()
        raise ValueError("The selected worksheet has fewer rows than the chosen header rows.")
    source_header_rows = [list(row) for row in source_header_rows]
    for merged in merged_ranges:
        if merged["firstRow"] > header_rows:
            continue
        anchor_row_index = merged["firstRow"] - 1
        anchor_column_index = merged["firstColumn"] - 1
        if anchor_row_index >= header_rows:
            continue
        anchor_row = source_header_rows[anchor_row_index]
        anchor = anchor_row[anchor_column_index] if anchor_column_index < len(anchor_row) else None
        if anchor is None:
            continue
        for row_index in range(anchor_row_index, min(header_rows, merged["lastRow"])):
            header_row = source_header_rows[row_index]
            if len(header_row) < merged["lastColumn"]:
                header_row.extend([None] * (merged["lastColumn"] - len(header_row)))
            for column_index in range(anchor_column_index, merged["lastColumn"]):
                if row_index == anchor_row_index and column_index == anchor_column_index:
                    continue
                existing = header_row[column_index]
                existing_value = getattr(existing, "value", existing)
                if existing_value is None or existing_value == "":
                    header_row[column_index] = anchor
    if max(map(len, source_header_rows)) > MAX_COLUMNS:
        workbook.close()
        raise ValueError(f"The selected worksheet has more than {MAX_COLUMNS} columns.")
    headers = []
    occurrences: Counter[str] = Counter()
    column_count = max(map(len, source_header_rows))
    for index in range(column_count):
        parts = []
        for header_row in source_header_rows:
            raw_header = header_row[index] if index < len(header_row) else None
            if include_formats:
                raw_header = getattr(raw_header, "value", None)
            value = _spreadsheet_value(raw_header).strip()
            if value and (not parts or value != parts[-1]):
                parts.append(value)
        base = " · ".join(parts)[:160] or f"Column {index + 1}"
        occurrences[base] += 1
        headers.append(base if occurrences[base] == 1 else f"{base} ({occurrences[base]})")
    sheet_labels = available_sheets[:40]
    formula_workbook = None
    formula_rows = None
    if include_formats:
        try:
            formula_workbook = load_workbook(
                BytesIO(content), read_only=True, data_only=False, keep_links=False,
            )
            formula_worksheet = formula_workbook[selected_sheet]
            formula_worksheet.reset_dimensions()
            formula_rows = formula_worksheet.iter_rows()
            for _ in range(header_rows):
                next(formula_rows, None)
        except Exception as error:
            workbook.close()
            if formula_workbook is not None:
                formula_workbook.close()
            raise ValueError(f"Could not read worksheet formulas: {str(error)[:180]}") from None
    reader = _WorkbookRows(
        workbook, rows, include_formats=include_formats,
        formula_workbook=formula_workbook, formula_rows=formula_rows,
        merged_ranges=merged_ranges, merged_ranges_truncated=merged_ranges_truncated,
    )
    return "XLSX", headers, reader, sheet_labels, len(available_sheets) > len(sheet_labels)


def preview_xlsx_artifact(
    name: str, media_type: str, content: bytes, sheet_name: str = "",
    offset: int = 0, limit: int = XLSX_PREVIEW_ROWS, search: str = "", header_rows: int = 1,
) -> dict[str, Any]:
    """Return one bounded worksheet page while preserving Excel row coordinates."""
    media_type = media_type.lower().split(";", 1)[0]
    suffix = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    if suffix != "xlsx" and media_type != "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        raise ValueError("This preview supports XLSX workbooks.")
    if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= MAX_ROWS:
        raise ValueError("The worksheet preview offset is invalid.")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= XLSX_PREVIEW_ROWS:
        raise ValueError(f"The worksheet preview page size must be between 1 and {XLSX_PREVIEW_ROWS} rows.")
    if not isinstance(header_rows, int) or isinstance(header_rows, bool) or not 1 <= header_rows <= 5:
        raise ValueError("Header rows must be between 1 and 5.")
    if not isinstance(search, str) or len(search) > 200:
        raise ValueError("Worksheet search must be 200 characters or fewer.")
    search = search.strip().casefold()

    _, headers, reader, sheets, sheets_truncated = _open_xlsx_artifact(
        content, sheet_name, include_formats=True, header_rows=header_rows,
    )
    visible_headers = headers[:XLSX_PREVIEW_COLUMNS]
    rows: list[dict[str, Any]] = []
    truncated_cells: list[str] = []
    has_more = False
    scanned_rows = 0
    match_count = 0
    search_truncated = False
    row_limit_reached = False
    try:
        for index, row in enumerate(reader):
            if index >= MAX_ROWS:
                search_truncated = True
                row_limit_reached = True
                break
            scanned_rows = index + 1
            visible_cells = row[:len(visible_headers)]
            if search and not any(
                search in cell["value"].casefold() or search in cell["display"].casefold()
                for cell in visible_cells
            ):
                continue
            if match_count >= offset and len(rows) < limit:
                values = []
                display_values = []
                number_formats = []
                formula_info = []
                for column_index in range(len(visible_headers)):
                    cell = row[column_index] if column_index < len(row) else {"value": "", "display": "", "numberFormat": ""}
                    value = cell["value"]
                    display = cell["display"]
                    if len(value) > XLSX_PREVIEW_CELL_CHARS or len(display) > XLSX_PREVIEW_CELL_CHARS:
                        truncated_cells.append(f"{index + 2}:{column_index + 1}")
                        value = value[:XLSX_PREVIEW_CELL_CHARS]
                        display = display[:XLSX_PREVIEW_CELL_CHARS]
                    values.append(value)
                    display_values.append(display)
                    number_formats.append(cell["numberFormat"])
                    formula_info.append({
                        "formula": cell["formula"],
                        "resultMissing": cell["formulaResultMissing"],
                    } if cell["formula"] else None)
                rows.append({
                    "rowNumber": index + header_rows + 1,
                    "values": values,
                    "displayValues": display_values,
                    "numberFormats": number_formats,
                    "formulaInfo": formula_info,
                })
            elif match_count >= offset + limit:
                has_more = True
                if not search:
                    break
            match_count += 1
    finally:
        close = getattr(reader, "close", None)
        if callable(close):
            close()
    first_visible_row = rows[0]["rowNumber"] if rows else None
    last_visible_row = rows[-1]["rowNumber"] if rows else None
    visible_merged_ranges = []
    merged_ranges_partial = False
    for merged in getattr(reader, "merged_ranges", ()):
        if merged["lastRow"] <= header_rows or first_visible_row is None:
            continue
        intersects_page = (
            merged["firstRow"] <= last_visible_row
            and merged["lastRow"] >= first_visible_row
            and merged["firstColumn"] <= len(visible_headers)
        )
        if not intersects_page:
            continue
        if (merged["firstRow"] >= first_visible_row
                and merged["lastRow"] <= last_visible_row
                and merged["firstColumn"] >= 1
                and merged["lastColumn"] <= len(visible_headers)):
            visible_merged_ranges.append(merged)
        else:
            merged_ranges_partial = True
    return {
        "sheet": sheet_name or (sheets[0] if sheets else ""),
        "sheets": sheets,
        "sheetsTruncated": sheets_truncated,
        "headers": visible_headers,
        "headerRows": header_rows,
        "mergedRanges": visible_merged_ranges,
        "mergedRangesPartial": merged_ranges_partial,
        "mergedRangesTruncated": getattr(reader, "merged_ranges_truncated", False),
        "columnsTruncated": len(headers) > len(visible_headers),
        "rows": rows,
        "offset": offset,
        "hasMore": has_more,
        "search": search,
        "matchCount": match_count if search else None,
        "scannedRows": scanned_rows if search else None,
        "searchTruncated": search_truncated if search else False,
        "rowLimitReached": row_limit_reached,
        "truncatedCells": truncated_cells,
    }


def _validated_rows(reader: Iterator[list[str]], width: int) -> Iterator[list[str]]:
    row_count = 0
    scanned_rows = 0
    try:
        for row in reader:
            scanned_rows += 1
            if scanned_rows > MAX_ROWS:
                raise ValueError(f"The table has more than {MAX_ROWS:,} scanned rows, including blank rows.")
            if not row or not any(str(value).strip() for value in row):
                continue
            row_count += 1
            if len(row) > width:
                raise ValueError(f"Data row {row_count + 1} has more values than the header.")
            row.extend([""] * (width - len(row)))
            yield row
    except ValueError:
        raise
    except csv.Error as error:
        raise ValueError(f"Could not parse the tabular data: {error}") from None
    except Exception as error:
        raise ValueError(f"Could not parse the worksheet rows: {str(error)[:180]}") from None
    finally:
        close = getattr(reader, "close", None)
        if callable(close):
            close()


def _number(value: str) -> Decimal | None:
    try:
        number = Decimal(value)
    except InvalidOperation:
        return None
    return number if number.is_finite() else None


def _comparable_value(value: str) -> tuple[str, Decimal | datetime] | None:
    number = _number(value.strip())
    if number is not None:
        return "number", number
    text = value.strip()
    try:
        parsed_datetime = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed_date = date.fromisoformat(text)
        except ValueError:
            return None
        parsed_datetime = datetime.combine(parsed_date, time.min)
    if parsed_datetime.tzinfo is not None:
        parsed_datetime = parsed_datetime.astimezone(timezone.utc).replace(tzinfo=None)
    return "date", parsed_datetime


def _bucket_date(value: str, interval: str) -> str | None:
    comparable = _comparable_value(value)
    if comparable is None or comparable[0] != "date":
        return None
    parsed = comparable[1]
    if not isinstance(parsed, datetime):
        return None
    if interval == "day":
        return parsed.date().isoformat()
    if interval == "week":
        iso = parsed.isocalendar()
        return f"{iso.year}-W{iso.week:02d}"
    if interval == "month":
        return f"{parsed.year:04d}-{parsed.month:02d}"
    if interval == "quarter":
        quarter = (parsed.month - 1) // 3 + 1
        return f"{parsed.year:04d}-Q{quarter}"
    if interval == "year":
        return f"{parsed.year:04d}"
    raise ValueError("Choose a date bucket of day, week, month, quarter or year.")


def _matches_filter(value: str, operator: str, expected: str | None,
                    comparable: tuple[str, Decimal | datetime] | None) -> bool:
    value = value.strip()
    if operator == "blank":
        return not value
    if operator == "not_blank":
        return bool(value)
    if expected is None:
        return False
    if operator == "eq":
        return value == expected
    if operator == "neq":
        return value != expected
    if operator == "contains":
        return expected.casefold() in value.casefold()
    if comparable is None:
        return False
    current = _comparable_value(value)
    if current is None or current[0] != comparable[0]:
        return False
    if operator == "gt":
        return current[1] > comparable[1]
    if operator == "gte":
        return current[1] >= comparable[1]
    if operator == "lt":
        return current[1] < comparable[1]
    if operator == "lte":
        return current[1] <= comparable[1]
    return False


def profile_tabular_artifact(
    name: str, media_type: str, content: bytes, sheet_name: str = "", header_rows: int = 1,
) -> dict[str, Any]:
    """Return schema, missingness, numeric summaries, ISO date ranges and common categories."""
    file_format, headers, reader, available_sheets, sheets_truncated = _open_tabular_artifact(
        name, media_type, content, sheet_name, header_rows,
    )

    columns = [{
        "name": header, "nonEmpty": 0, "missing": 0, "numeric": True,
        "numericCount": 0, "numericTotal": Decimal(0), "minimum": None, "maximum": None,
        "dateCandidate": True, "dateCount": 0,
        "dateMinimum": None, "dateMinimumText": None,
        "dateMaximum": None, "dateMaximumText": None,
        "values": Counter(), "valuesCapped": False,
    } for header in headers]
    row_count = 0
    for row in _validated_rows(reader, len(columns)):
        row_count += 1
        for column, raw_value in zip(columns, row, strict=True):
            value = raw_value.strip()
            if not value:
                column["missing"] += 1
                continue
            column["nonEmpty"] += 1
            if value in column["values"]:
                column["values"][value] += 1
            elif len(column["values"]) < MAX_TRACKED_VALUES:
                column["values"][value] = 1
            else:
                column["valuesCapped"] = True
            number = _number(value)
            if number is None:
                column["numeric"] = False
                comparable = _comparable_value(value)
                if comparable is None or comparable[0] != "date":
                    column["dateCandidate"] = False
                    continue
                parsed_date = comparable[1]
                column["dateCount"] += 1
                if column["dateMinimum"] is None or parsed_date < column["dateMinimum"]:
                    column["dateMinimum"] = parsed_date
                    column["dateMinimumText"] = value
                if column["dateMaximum"] is None or parsed_date > column["dateMaximum"]:
                    column["dateMaximum"] = parsed_date
                    column["dateMaximumText"] = value
                continue
            column["dateCandidate"] = False
            column["numericCount"] += 1
            column["numericTotal"] += number
            column["minimum"] = number if column["minimum"] is None else min(column["minimum"], number)
            column["maximum"] = number if column["maximum"] is None else max(column["maximum"], number)

    if row_count == 0:
        raise ValueError("The selected table has a header but no data rows.")

    summaries = []
    for column in columns:
        numeric = column["numeric"] and column["numericCount"] > 0
        date_typed = (not numeric and column["dateCandidate"]
                      and column["dateCount"] == column["nonEmpty"] and column["dateCount"] > 0)
        summary: dict[str, Any] = {
            "name": column["name"],
            "type": "number" if numeric else "date" if date_typed else "category",
            "nonEmpty": column["nonEmpty"],
            "missing": column["missing"],
            "uniqueValues": len(column["values"]),
            "uniqueValuesCapped": column["valuesCapped"],
        }
        if numeric:
            summary.update({
                "minimum": str(column["minimum"]),
                "maximum": str(column["maximum"]),
                "mean": str(column["numericTotal"] / column["numericCount"]),
            })
        elif date_typed:
            summary.update({
                "minimum": column["dateMinimumText"],
                "maximum": column["dateMaximumText"],
            })
        else:
            summary["mostCommon"] = [
                {"value": value[:160], "valueTruncated": len(value) > 160, "count": count}
                for value, count in column["values"].most_common(10)
            ]
        summaries.append(summary)

    summary = {
        "fileName": name,
        "format": file_format,
        "rows": row_count,
        "columns": summaries,
        "limits": {"rowLimit": MAX_ROWS, "uniqueValuesPerColumn": MAX_TRACKED_VALUES},
    }
    if file_format == "XLSX":
        summary.update({
            "sheetName": sheet_name or available_sheets[0],
            "headerRows": header_rows,
            "availableSheets": available_sheets,
            "sheetListTruncated": sheets_truncated,
            "formulaValueNote": "Formula cells use cached workbook values and may be blank if the workbook has not been recalculated.",
        })
    return summary


def aggregate_tabular_artifact(
    name: str,
    media_type: str,
    content: bytes,
    *,
    group_by: str,
    aggregation: str,
    value_column: str = "",
    filter_column: str = "",
    filter_value: str = "",
    limit: int = 25,
    sheet_name: str = "",
    date_bucket: str = "",
    header_rows: int = 1,
) -> dict[str, Any]:
    """Return bounded group counts or numeric aggregates from one attached table."""
    if aggregation not in {"count", "sum", "mean", "min", "max", "quartiles"}:
        raise ValueError("Choose count, sum, mean, min, max or quartiles aggregation.")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 50:
        raise ValueError("The result limit must be between 1 and 50 groups.")
    if not isinstance(date_bucket, str) or date_bucket not in {"", "day", "week", "month", "quarter", "year"}:
        raise ValueError("Choose a date bucket of day, week, month, quarter or year.")
    if date_bucket and not group_by:
        raise ValueError("Choose a date column with group_by when using a date bucket.")
    file_format, headers, reader, available_sheets, sheets_truncated = _open_tabular_artifact(
        name, media_type, content, sheet_name, header_rows,
    )
    positions = {header: index for index, header in enumerate(headers)}
    try:
        if group_by not in positions:
            raise ValueError(f"Unknown grouping column. Available columns: {', '.join(headers)}")
        if filter_column and filter_column not in positions:
            raise ValueError(f"Unknown filter column. Available columns: {', '.join(headers)}")
        if aggregation != "count" and value_column not in positions:
            raise ValueError(f"Choose a numeric value column. Available columns: {', '.join(headers)}")
    except ValueError:
        close = getattr(reader, "close", None)
        if callable(close):
            close()
        raise

    grouped: dict[str, dict[str, Any]] = {}
    matched_rows = 0
    included_values = 0
    skipped_values = 0
    date_values_skipped = 0
    for row in _validated_rows(reader, len(headers)):
        if filter_column and row[positions[filter_column]].strip() != filter_value:
            continue
        matched_rows += 1
        raw_key = row[positions[group_by]].strip()
        if date_bucket:
            key = _bucket_date(raw_key, date_bucket)
            if key is None:
                date_values_skipped += 1
                continue
        else:
            key = raw_key or "(blank)"
        group = grouped.get(key)
        if group is None:
            if len(grouped) >= MAX_TRACKED_VALUES:
                raise ValueError(f"The grouping column has more than {MAX_TRACKED_VALUES:,} distinct values. Filter the data or choose another column.")
            group = {"rows": 0, "total": Decimal(0), "minimum": None, "maximum": None,
                     "values": 0, "numericValues": []}
            grouped[key] = group
        group["rows"] += 1
        if aggregation == "count":
            continue
        raw_value = row[positions[value_column]].strip()
        number = _number(raw_value) if raw_value else None
        if number is None:
            skipped_values += 1
            continue
        included_values += 1
        group["values"] += 1
        group["total"] += number
        group["minimum"] = number if group["minimum"] is None else min(group["minimum"], number)
        group["maximum"] = number if group["maximum"] is None else max(group["maximum"], number)
        if aggregation == "quartiles":
            group["numericValues"].append(number)

    if matched_rows == 0:
        raise ValueError("No rows matched the selected filter.")
    if date_bucket and date_values_skipped == matched_rows:
        raise ValueError("No matched rows contain a valid ISO date or time in the grouping column.")
    results = []
    for key, group in grouped.items():
        if aggregation == "count":
            result = Decimal(group["rows"])
        elif group["values"] == 0:
            continue
        elif aggregation == "quartiles":
            sorted_values = sorted(group["numericValues"])

            def percentile(fraction: Decimal) -> Decimal:
                position = Decimal(len(sorted_values) - 1) * fraction
                lower_index = int(position)
                upper_index = min(lower_index + 1, len(sorted_values) - 1)
                remainder = position - lower_index
                return sorted_values[lower_index] + (sorted_values[upper_index] - sorted_values[lower_index]) * remainder

            quartiles = {
                "min": sorted_values[0], "q1": percentile(Decimal("0.25")),
                "median": percentile(Decimal("0.5")), "q3": percentile(Decimal("0.75")),
                "max": sorted_values[-1],
            }
            result = quartiles["median"]
        elif aggregation == "sum":
            result = group["total"]
        elif aggregation == "mean":
            result = group["total"] / group["values"]
        elif aggregation == "min":
            result = group["minimum"]
        else:
            result = group["maximum"]
        numeric = float(result)
        result_row = {
            "group": key[:160],
            "groupTruncated": len(key) > 160,
            "value": numeric if abs(numeric) <= 1e15 else None,
            "rows": group["rows"],
            "valuesUsed": group["values"] if aggregation != "count" else group["rows"],
            "_sortValue": result,
        }
        if aggregation == "quartiles":
            result_row.update({
                **{name: (float(value) if abs(float(value)) <= 1e15 else None)
                   for name, value in quartiles.items()},
                "decimalValues": {name: str(value) for name, value in quartiles.items()},
            })
        else:
            result_row["decimalValue"] = str(result)
        results.append(result_row)

    if date_bucket:
        results.sort(key=lambda item: item["group"])
    else:
        results.sort(key=lambda item: item["_sortValue"], reverse=True)
    for result in results:
        result.pop("_sortValue")
    summary = {
        "fileName": name,
        "format": file_format,
        "groupBy": group_by,
        "dateBucket": date_bucket or None,
        "aggregation": aggregation,
        "valueColumn": value_column or None,
        "filter": {"column": filter_column, "equals": filter_value} if filter_column else None,
        "matchedRows": matched_rows,
        "numericValuesUsed": included_values if aggregation != "count" else matched_rows,
        "numericValuesSkipped": skipped_values,
        "dateValuesSkipped": date_values_skipped,
        "groupsReturned": min(limit, len(results)),
        "groupsMatched": len(grouped),
        "groupsTotal": len(results),
        "groups": results[:limit],
    }
    chart_points = [
        {"x": item["group"], "y": item["value"]}
        for item in results[:limit]
        if item["value"] is not None
    ]
    if chart_points and aggregation != "quartiles":
        summary["chartData"] = {
            "series": [{"name": aggregation, "data": chart_points}],
            "groupsIncluded": len(chart_points),
            "categoriesIncluded": 1,
            "truncated": len(chart_points) < len(results) or len(results) > limit,
        }
    if file_format == "XLSX":
        summary.update({
            "sheetName": sheet_name or available_sheets[0],
            "headerRows": header_rows,
            "availableSheets": available_sheets,
            "sheetListTruncated": sheets_truncated,
            "formulaValueNote": "Formula cells use cached workbook values and may be blank if the workbook has not been recalculated.",
        })
    if aggregation == "quartiles":
        summary["quantileMethod"] = "linear interpolation at (n - 1) × p"
    return summary


def transform_tabular_artifact(
    name: str,
    media_type: str,
    content: bytes,
    *,
    filters: list[dict[str, str]] | None = None,
    columns: list[str] | None = None,
    sort_by: str = "",
    descending: bool = False,
    group_by: str = "",
    pivot_by: str = "",
    aggregation: str = "none",
    value_column: str = "",
    limit: int = 1000,
    sheet_name: str = "",
    date_bucket: str = "",
    header_rows: int = 1,
) -> tuple[bytes, dict[str, Any]]:
    """Apply bounded filters, projection, sorting or grouping and return a CSV plus replayable operation metadata."""
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 5000:
        raise ValueError("The output row limit must be between 1 and 5,000.")
    if not isinstance(descending, bool):
        raise TypeError("Sort direction must be a boolean value.")
    if not isinstance(date_bucket, str) or date_bucket not in {"", "day", "week", "month", "quarter", "year"}:
        raise ValueError("Choose a date bucket of day, week, month, quarter or year.")
    if not isinstance(header_rows, int) or isinstance(header_rows, bool) or not 1 <= header_rows <= 5:
        raise ValueError("Header rows must be between 1 and 5.")
    if date_bucket and not group_by:
        raise ValueError("Choose a date column with group_by when using a date bucket.")
    if aggregation not in {"none", "count", "sum", "mean", "min", "max"}:
        raise ValueError("Choose no grouping, count, sum, mean, min or max.")
    if bool(group_by) != (aggregation != "none"):
        raise ValueError("Choose both a grouping column and aggregation, or neither.")
    if aggregation != "none" and len(columns or []) > 0:
        raise ValueError("Column selection is applied before grouping; choose either grouping or selected columns.")
    if pivot_by and (not group_by or pivot_by == group_by or aggregation not in {"count", "sum", "mean"}):
        raise ValueError("Pivoting needs distinct row and column fields, with count, sum or mean aggregation.")
    if pivot_by and sort_by:
        raise ValueError("Pivot rows are ordered by their row label; omit the separate sort column.")
    if filters is None:
        filters = []
    if not isinstance(filters, list) or len(filters) > 20:
        raise ValueError("Use at most 20 exact-match filters.")

    file_format, headers, reader, _available_sheets, _sheets_truncated = _open_tabular_artifact(
        name, media_type, content, sheet_name, header_rows,
    )
    positions = {header: index for index, header in enumerate(headers)}
    normalised_filters: list[dict[str, str]] = []
    filter_rules: list[tuple[int, str, str | None, tuple[str, Decimal | datetime] | None]] = []
    for item in filters:
        if not isinstance(item, dict):
            reader.close() if callable(getattr(reader, "close", None)) else None
            raise TypeError("Each filter must be an object with a column and operator.")
        if set(item) == {"column", "equals"}:
            column = item["column"]
            operator = "eq"
            expected = item["equals"]
        elif set(item) in ({"column", "operator"}, {"column", "operator", "value"}):
            column = item["column"]
            operator = item["operator"]
            expected = item.get("value")
        else:
            reader.close() if callable(getattr(reader, "close", None)) else None
            raise ValueError("Each filter must contain only a column, operator and optional value.")
        if (not isinstance(column, str) or column not in positions
                or not isinstance(operator, str)
                or operator not in {"eq", "neq", "contains", "gt", "gte", "lt", "lte", "blank", "not_blank"}
                or (expected is not None and not isinstance(expected, str))):
            reader.close() if callable(getattr(reader, "close", None)) else None
            raise ValueError("A filter refers to an unknown column or has an invalid operator or value.")
        if operator in {"blank", "not_blank"} and expected is not None:
            reader.close() if callable(getattr(reader, "close", None)) else None
            raise ValueError("Blank filters do not take a value.")
        if operator not in {"blank", "not_blank"} and expected is None:
            reader.close() if callable(getattr(reader, "close", None)) else None
            raise ValueError("This filter operator requires a value.")
        comparable = None
        if operator in {"gt", "gte", "lt", "lte"}:
            comparable = _comparable_value(expected or "")
            if comparable is None:
                reader.close() if callable(getattr(reader, "close", None)) else None
                raise ValueError("Range filters need a number or an ISO date such as 2026-10-30.")
        normalised = {"column": column, "operator": operator}
        if expected is not None:
            normalised["value"] = expected
        normalised_filters.append(normalised)
        filter_rules.append((positions[column], operator, expected, comparable))
    selected_columns = list(columns or headers)
    if not selected_columns or len(set(selected_columns)) != len(selected_columns) or any(
        column not in positions for column in selected_columns
    ):
        reader.close() if callable(getattr(reader, "close", None)) else None
        raise ValueError("Choose one or more distinct columns from the source table.")
    if sort_by and sort_by not in positions:
        reader.close() if callable(getattr(reader, "close", None)) else None
        raise ValueError("The sort column is not in the source table.")
    if sort_by and columns and sort_by not in selected_columns:
        reader.close() if callable(getattr(reader, "close", None)) else None
        raise ValueError("Include the sort column in the selected output columns.")
    if group_by and group_by not in positions:
        reader.close() if callable(getattr(reader, "close", None)) else None
        raise ValueError("The grouping column is not in the source table.")
    if pivot_by and pivot_by not in positions:
        reader.close() if callable(getattr(reader, "close", None)) else None
        raise ValueError("The pivot column is not in the source table.")
    if aggregation != "count" and aggregation != "none" and value_column not in positions:
        reader.close() if callable(getattr(reader, "close", None)) else None
        raise ValueError("Choose a numeric value column for this aggregation.")

    input_rows = 0
    matched_rows = 0
    skipped_values = 0
    range_filter_values_skipped = 0
    sort_buffer_bytes = 0
    output_rows: list[list[str]] = []
    groups: dict[str, dict[str, Any]] = {}
    pivot_categories: set[str] = set()
    pivot_groups: dict[str, dict[str, dict[str, Any]]] = {}
    matched_group_count = 0
    date_values_skipped = 0
    for row in _validated_rows(reader, len(headers)):
        input_rows += 1
        row_matches = True
        for index, operator, expected, comparable in filter_rules:
            current = row[index]
            if operator in {"gt", "gte", "lt", "lte"}:
                parsed_current = _comparable_value(current)
                if parsed_current is None or comparable is None or parsed_current[0] != comparable[0]:
                    range_filter_values_skipped += 1
                    row_matches = False
                    break
            if not _matches_filter(current, operator, expected, comparable):
                row_matches = False
                break
        if not row_matches:
            continue
        matched_rows += 1
        if aggregation == "none":
            selected_row = [row[positions[column]] for column in selected_columns]
            if sort_by:
                sort_buffer_bytes += sum(len(value.encode("utf-8")) for value in selected_row)
                if sort_buffer_bytes > 24_000_000:
                    raise ValueError("Sorting this result would exceed the 24 MB memory limit. Add filters or select fewer columns.")
                output_rows.append(selected_row)
            elif len(output_rows) < limit:
                output_rows.append(selected_row)
            continue
        if pivot_by:
            raw_row_key = row[positions[group_by]].strip()
            if date_bucket:
                row_key = _bucket_date(raw_row_key, date_bucket)
                if row_key is None:
                    date_values_skipped += 1
                    continue
            else:
                row_key = raw_row_key or "(blank)"
            column_key = row[positions[pivot_by]].strip() or "(blank)"
            if column_key not in pivot_categories:
                if len(pivot_categories) >= MAX_PIVOT_COLUMNS:
                    raise ValueError(f"The pivot column has more than {MAX_PIVOT_COLUMNS} distinct values. Add a filter or choose another column.")
                pivot_categories.add(column_key)
            row_group = pivot_groups.setdefault(row_key, {})
            cell = row_group.setdefault(column_key, {
                "rows": 0, "values": 0, "total": Decimal(0),
            })
            cell["rows"] += 1
            if aggregation == "count":
                continue
            number = _number(row[positions[value_column]].strip())
            if number is None:
                skipped_values += 1
                continue
            cell["values"] += 1
            cell["total"] += number
            continue
        raw_key = row[positions[group_by]].strip()
        if date_bucket:
            key = _bucket_date(raw_key, date_bucket)
            if key is None:
                date_values_skipped += 1
                continue
        else:
            key = raw_key or "(blank)"
        group = groups.get(key)
        if group is None:
            if len(groups) >= MAX_TRACKED_VALUES:
                raise ValueError(f"The grouping column has more than {MAX_TRACKED_VALUES:,} distinct values. Add a filter or choose another column.")
            group = {"rows": 0, "values": 0, "total": Decimal(0), "minimum": None, "maximum": None}
            groups[key] = group
        group["rows"] += 1
        if aggregation == "count":
            continue
        number = _number(row[positions[value_column]].strip())
        if number is None:
            skipped_values += 1
            continue
        group["values"] += 1
        group["total"] += number
        group["minimum"] = number if group["minimum"] is None else min(group["minimum"], number)
        group["maximum"] = number if group["maximum"] is None else max(group["maximum"], number)

    if matched_rows == 0:
        raise ValueError("No rows matched the selected filters.")
    if date_bucket and date_values_skipped == matched_rows:
        raise ValueError("No matched rows contain a valid ISO date or time in the grouping column.")
    if aggregation == "none":
        if sort_by:
            sort_index = selected_columns.index(sort_by)
            def sort_key(row: list[str]) -> tuple[int, Decimal | str]:
                value = row[sort_index]
                number = _number(value)
                return (0, number) if number is not None else (1, value.casefold())
            output_rows.sort(key=sort_key, reverse=descending)
        output_headers = selected_columns
        output_rows = output_rows[:limit]
    elif pivot_by:
        ordered_categories = sorted(pivot_categories, key=str.casefold)
        ordered_groups = sorted(pivot_groups, key=str.casefold, reverse=descending)
        matched_group_count = len(ordered_groups)
        ordered_groups = ordered_groups[:limit]
        output_headers = [group_by, *[f"{pivot_by}={value}" for value in ordered_categories]]
        output_rows = []
        for key in ordered_groups:
            cells = pivot_groups[key]
            values = []
            for category in ordered_categories:
                cell = cells.get(category)
                if aggregation == "count":
                    values.append(str(cell["rows"] if cell else 0))
                elif not cell or cell["values"] == 0:
                    values.append("")
                elif aggregation == "sum":
                    values.append(str(cell["total"]))
                else:
                    values.append(str(cell["total"] / cell["values"]))
            output_rows.append([key, *values])
    else:
        output_headers = [group_by, "value", "rows", "values_used"]
        grouped_rows: list[tuple[Decimal, list[str]]] = []
        for key, group in groups.items():
            if aggregation == "count":
                value = Decimal(group["rows"])
                values_used = group["rows"]
            elif group["values"] == 0:
                continue
            elif aggregation == "sum":
                value = group["total"]
                values_used = group["values"]
            elif aggregation == "mean":
                value = group["total"] / group["values"]
                values_used = group["values"]
            elif aggregation == "min":
                value = group["minimum"]
                values_used = group["values"]
            else:
                value = group["maximum"]
                values_used = group["values"]
            grouped_rows.append((value, [key, str(value), str(group["rows"]), str(values_used)]))
        if date_bucket:
            grouped_rows.sort(key=lambda item: item[1][0], reverse=descending)
        else:
            grouped_rows.sort(key=lambda item: (item[0], item[1][0].casefold()), reverse=descending)
        matched_group_count = len(grouped_rows)
        output_rows = [row for _, row in grouped_rows[:limit]]

    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(output_headers)
    writer.writerows(output_rows)
    csv_bytes = stream.getvalue().encode("utf-8")
    if len(csv_bytes) > 9_000_000:
        raise ValueError("The transformed CSV exceeds the 9 MB output limit. Reduce the output row limit or select fewer columns.")
    operation = {
        "filters": normalised_filters,
        "columns": selected_columns if aggregation == "none" else [],
        "sortBy": sort_by,
        "descending": descending,
        "groupBy": group_by,
        "dateBucket": date_bucket,
        "pivotBy": pivot_by,
        "aggregation": aggregation,
        "valueColumn": value_column,
        "limit": limit,
        "sheetName": sheet_name,
        "headerRows": header_rows,
    }
    summary = {
        "format": file_format,
        "inputRows": input_rows,
        "matchedRows": matched_rows,
        "outputRows": len(output_rows),
        "outputColumns": output_headers,
        "numericValuesSkipped": skipped_values,
        "dateValuesSkipped": date_values_skipped,
        "rangeFilterValuesSkipped": range_filter_values_skipped,
        "truncated": (matched_rows > len(output_rows) if aggregation == "none"
                       else matched_group_count > len(output_rows)),
        "operation": operation,
    }
    if pivot_by:
        chart_categories = ordered_groups[:30]
        chart_series = []
        for category in ordered_categories[:8]:
            points = []
            for key in chart_categories:
                cell = pivot_groups[key].get(category)
                if not cell:
                    if aggregation == "count":
                        value = 0
                    else:
                        continue
                elif aggregation == "count":
                    value = cell["rows"]
                elif cell["values"] == 0:
                    continue
                elif aggregation == "sum":
                    value = cell["total"]
                else:
                    value = cell["total"] / cell["values"]
                numeric = float(value)
                if abs(numeric) <= 1e15:
                    points.append({"x": key[:160], "y": numeric})
            if points:
                chart_series.append({"name": f"{pivot_by}={category}"[:160], "data": points})
        if chart_series:
            summary["chartData"] = {
                "series": chart_series,
                "groupsIncluded": len(chart_categories),
                "categoriesIncluded": len(chart_series),
                "truncated": (matched_group_count > len(chart_categories)
                              or len(ordered_categories) > 8
                              or len(chart_series) < min(8, len(ordered_categories))),
            }
    elif aggregation != "none":
        chart_points = []
        for row in output_rows[:240]:
            number = _number(row[1])
            if number is None or abs(float(number)) > 1e15:
                continue
            chart_points.append({"x": row[0][:160], "y": float(number)})
        if chart_points:
            summary["chartData"] = {
                "series": [{"name": aggregation, "data": chart_points}],
                "groupsIncluded": len(chart_points),
                "categoriesIncluded": 1,
                "truncated": matched_group_count > len(chart_points),
            }
    return csv_bytes, summary
