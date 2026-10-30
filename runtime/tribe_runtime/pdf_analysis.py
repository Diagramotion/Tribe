"""Bounded text extraction from searchable PDFs attached to a chat."""

from __future__ import annotations

import math
import threading
from io import BytesIO
from typing import Any

MAX_PDF_BYTES = 20 * 1024 * 1024
MAX_PDF_PAGES = 10_000
MAX_PDF_PREVIEW_PIXELS = 8_000_000
MAX_PDF_PREVIEW_SIDE_PIXELS = 5_000
MAX_PAGES_PER_READ = 10
MAX_CHARS_PER_PAGE = 6_000
MAX_TOTAL_CHARS = 24_000
MAX_TABLES_PER_READ = 8
MAX_TABLES_PER_PAGE = 3
MAX_TABLE_ROWS = 30
MAX_TABLE_COLUMNS = 20
MAX_TABLE_CELL_CHARS = 300
MAX_TABLE_TOTAL_CHARS = 24_000
MAX_OCR_PAGES_PER_READ = 5
MAX_OCR_PIXELS_PER_PAGE = 18_000_000
MAX_OCR_PIXELS_PER_READ = 36_000_000
MAX_OCR_SIDE_PIXELS = 10_000
MAX_OCR_TOTAL_CHARS = 24_000
MAX_OCR_CHARS_PER_PAGE = 6_000
_OCR_LOCK = threading.Lock()
_OCR_ENGINE: Any = None
_OCR_LANGUAGE = ""
OCR_LANGUAGES = (
    "en", "ch", "chinese_cht", "japan", "fr", "de", "es", "it", "pt", "nl", "vi", "tr",
)


def _validate_pdf_attachment(
    name: str, media_type: str, content: bytes, page_start: int, page_end: int,
) -> None:
    suffix = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    media_type = media_type.lower().split(";", 1)[0]
    if suffix != "pdf" and media_type != "application/pdf":
        raise ValueError("Choose a PDF file attached to this chat.")
    if not isinstance(content, bytes) or not content or len(content) > MAX_PDF_BYTES:
        raise ValueError("The PDF must be between 1 byte and 20 MB.")
    if (not isinstance(page_start, int) or isinstance(page_start, bool)
            or not isinstance(page_end, int) or isinstance(page_end, bool)
            or page_start < 1 or page_end < page_start):
        raise ValueError("Choose a valid page range starting at page 1 or later.")
    if page_end - page_start + 1 > MAX_PAGES_PER_READ:
        raise ValueError(f"Read no more than {MAX_PAGES_PER_READ} pages at a time.")


def extract_pdf_pages(
    name: str,
    media_type: str,
    content: bytes,
    *,
    page_start: int = 1,
    page_end: int = 10,
) -> dict[str, Any]:
    """Extract layout-oriented text from a bounded page range of an attached PDF."""
    _validate_pdf_attachment(name, media_type, content, page_start, page_end)

    from pypdf import PdfReader, apply_configuration

    reader = None
    try:
        with apply_configuration(
            maximum_declared_stream_length=32 * 1024 * 1024,
            array_based_stream_maximum_output_length=32 * 1024 * 1024,
            jbig2_maximum_output_length=32 * 1024 * 1024,
            lzw_maximum_output_length=32 * 1024 * 1024,
            run_length_maximum_output_length=32 * 1024 * 1024,
            zlib_maximum_output_length=32 * 1024 * 1024,
            brotli_maximum_output_length=32 * 1024 * 1024,
            stream_decoding_work_maximum_length=100 * 1024 * 1024,
            stream_parsing_work_maximum_count=500_000,
            page_tree_maximum_entries=MAX_PDF_PAGES,
            page_tree_maximum_page_entries=MAX_PDF_PAGES,
        ):
            reader = PdfReader(
                BytesIO(content), strict=False,
                root_object_recovery_limit=10_000,
                xref_stream_maximum_entries=250_000,
            )
            if reader.is_encrypted:
                raise ValueError("This PDF is password-protected and cannot be read without its password.")
            page_count = len(reader.pages)
            if page_count > MAX_PDF_PAGES:
                raise ValueError(f"The PDF has more than {MAX_PDF_PAGES:,} pages.")
            if page_start > page_count:
                raise ValueError(f"The PDF has {page_count} pages; the selected range starts after the last page.")

            pages = []
            remaining = MAX_TOTAL_CHARS
            for index in range(page_start - 1, min(page_end, page_count)):
                if remaining <= 0:
                    break
                extracted = reader.pages[index].extract_text(extraction_mode="layout") or ""
                limit = min(MAX_CHARS_PER_PAGE, remaining)
                text = extracted[:limit]
                pages.append({
                    "page": index + 1,
                    "text": text,
                    "characters": len(text),
                    "truncated": len(extracted) > len(text),
                })
                remaining -= len(text)

            pages_without_text = [page["page"] for page in pages if not page["text"].strip()]
            return {
                "fileName": name,
                "pageCount": page_count,
                "pages": pages,
                "pagesWithoutExtractableText": pages_without_text,
                "visualReviewOrOcrMayBeNeeded": bool(pages_without_text),
                "rangeTruncated": len(pages) < min(page_end, page_count) - page_start + 1,
                "limits": {
                    "maxPagesPerRead": MAX_PAGES_PER_READ,
                    "maxCharactersPerPage": MAX_CHARS_PER_PAGE,
                    "maxCharactersTotal": MAX_TOTAL_CHARS,
                },
            }
    except ValueError:
        raise
    except Exception as error:
        raise ValueError(f"Could not extract text from this PDF: {str(error)[:180]}") from None
    finally:
        if reader is not None:
            reader.close()


def render_pdf_page(
    name: str,
    media_type: str,
    content: bytes,
    *,
    page_number: int = 1,
) -> tuple[bytes, int]:
    """Rasterise one PDF page to a bounded PNG for a safe local preview."""
    _validate_pdf_attachment(name, media_type, content, page_number, page_number)
    try:
        import pypdfium2 as pdfium
    except ImportError:
        raise ValueError("PDF page preview is unavailable in this runtime.") from None

    document = None
    page = None
    bitmap = None
    image = None
    try:
        # PDFium is not thread-safe; share the OCR rendering lock.
        with _OCR_LOCK:
            try:
                document = pdfium.PdfDocument(content)
                page_count = len(document)
                if page_count > MAX_PDF_PAGES:
                    raise ValueError(f"The PDF has more than {MAX_PDF_PAGES:,} pages.")
                if page_number > page_count:
                    raise ValueError(f"The PDF has {page_count} pages; page {page_number} is out of range.")
                page = document[page_number - 1]
                width, height = page.get_size()
                if width <= 0 or height <= 0:
                    raise ValueError(f"Page {page_number} has invalid dimensions.")
                scale = min(
                    2.0,
                    math.sqrt(MAX_PDF_PREVIEW_PIXELS / (width * height)),
                    MAX_PDF_PREVIEW_SIDE_PIXELS / max(width, height),
                )
                if scale <= 0:
                    raise ValueError(f"Page {page_number} is too large to preview.")
                bitmap = page.render(
                    scale=scale, draw_annots=False, may_draw_forms=False, limit_image_cache=True,
                )
                image = bitmap.to_pil()
                output = BytesIO()
                image.save(output, format="PNG", optimize=True)
                return output.getvalue(), page_count
            finally:
                if image is not None:
                    image.close()
                if bitmap is not None:
                    bitmap.close()
                if page is not None:
                    page.close()
                if document is not None:
                    document.close()
    except ValueError:
        raise
    except Exception as error:  # noqa: BLE001 - PDFium errors vary by file and platform
        raise ValueError(f"Could not render PDF page {page_number}: {str(error)[:180]}") from None


def extract_pdf_tables(
    name: str,
    media_type: str,
    content: bytes,
    *,
    page_start: int = 1,
    page_end: int = 10,
) -> dict[str, Any]:
    """Extract bounded, heuristic table rows from a page range of an attached PDF."""
    _validate_pdf_attachment(name, media_type, content, page_start, page_end)
    from pypdf import PdfReader, apply_configuration

    reader = None
    try:
        with apply_configuration(
            maximum_declared_stream_length=32 * 1024 * 1024,
            array_based_stream_maximum_output_length=32 * 1024 * 1024,
            jbig2_maximum_output_length=32 * 1024 * 1024,
            lzw_maximum_output_length=32 * 1024 * 1024,
            run_length_maximum_output_length=32 * 1024 * 1024,
            zlib_maximum_output_length=32 * 1024 * 1024,
            brotli_maximum_output_length=32 * 1024 * 1024,
            stream_decoding_work_maximum_length=100 * 1024 * 1024,
            stream_parsing_work_maximum_count=500_000,
            page_tree_maximum_entries=MAX_PDF_PAGES,
            page_tree_maximum_page_entries=MAX_PDF_PAGES,
        ):
            reader = PdfReader(
                BytesIO(content), strict=False,
                root_object_recovery_limit=10_000,
                xref_stream_maximum_entries=250_000,
            )
            if reader.is_encrypted:
                raise ValueError("This PDF is password-protected and cannot be read without its password.")
            page_count = len(reader.pages)
            if page_count > MAX_PDF_PAGES:
                raise ValueError(f"The PDF has more than {MAX_PDF_PAGES:,} pages.")
            if page_start > page_count:
                raise ValueError(f"The PDF has {page_count} pages; the selected range starts after the last page.")
    except ValueError:
        raise
    except Exception as error:
        raise ValueError(f"Could not inspect this PDF: {str(error)[:180]}") from None
    finally:
        if reader is not None:
            reader.close()

    from pdfplumber import open as open_pdf

    try:
        tables = []
        pages_without_tables = []
        remaining_chars = MAX_TABLE_TOTAL_CHARS
        tables_truncated = False
        with open_pdf(BytesIO(content)) as pdf:
            for page_index in range(page_start - 1, min(page_end, page_count)):
                page = pdf.pages[page_index]
                strategy = "lines"
                found = page.find_tables({
                    "vertical_strategy": "lines",
                    "horizontal_strategy": "lines",
                })
                if not found:
                    strategy = "aligned text"
                    found = page.find_tables({
                        "vertical_strategy": "text",
                        "horizontal_strategy": "text",
                    })
                if not found:
                    pages_without_tables.append(page_index + 1)
                    continue

                if len(found) > MAX_TABLES_PER_PAGE:
                    tables_truncated = True
                for table_index, table in enumerate(found[:MAX_TABLES_PER_PAGE], start=1):
                    if len(tables) >= MAX_TABLES_PER_READ or remaining_chars <= 0:
                        tables_truncated = True
                        break
                    extracted = table.extract()
                    non_blank_rows = [
                        row for row in extracted if any((cell or "").strip() for cell in row)
                    ]
                    column_count = max((len(row) for row in extracted), default=0)
                    rows = []
                    cells_truncated = False
                    for row in non_blank_rows[:MAX_TABLE_ROWS]:
                        bounded_row = []
                        for cell in row[:MAX_TABLE_COLUMNS]:
                            value = (cell or "").strip()
                            if len(value) > MAX_TABLE_CELL_CHARS:
                                value = value[:MAX_TABLE_CELL_CHARS]
                                cells_truncated = True
                            if len(value) > remaining_chars:
                                value = value[:remaining_chars]
                                cells_truncated = True
                            value = value[:remaining_chars]
                            remaining_chars -= len(value)
                            bounded_row.append(value)
                            if remaining_chars <= 0:
                                break
                        rows.append(bounded_row)
                        if remaining_chars <= 0:
                            break
                    rows_truncated = len(non_blank_rows) > MAX_TABLE_ROWS
                    columns_truncated = column_count > MAX_TABLE_COLUMNS
                    tables_truncated = tables_truncated or rows_truncated or columns_truncated or cells_truncated
                    tables.append({
                        "page": page_index + 1,
                        "table": table_index,
                        "detectionStrategy": strategy,
                        "rows": rows,
                        "rowsDetected": len(non_blank_rows),
                        "blankRowsSkipped": len(extracted) - len(non_blank_rows),
                        "columnsDetected": column_count,
                        "rowsTruncated": rows_truncated,
                        "columnsTruncated": columns_truncated,
                        "cellTextTruncated": cells_truncated,
                    })
                if len(tables) >= MAX_TABLES_PER_READ or remaining_chars <= 0:
                    break

        pages_with_tables = {table["page"] for table in tables}
        return {
            "fileName": name,
            "pageCount": page_count,
            "tables": tables,
            "pagesWithoutTables": [
                page for page in pages_without_tables if page not in pages_with_tables
            ],
            "tableResultsTruncated": tables_truncated,
            "tableRowsAreHeuristic": True,
            "limits": {
                "maxPagesPerRead": MAX_PAGES_PER_READ,
                "maxTablesPerRead": MAX_TABLES_PER_READ,
                "maxRowsPerTable": MAX_TABLE_ROWS,
                "maxColumnsPerTable": MAX_TABLE_COLUMNS,
                "maxCharactersTotal": MAX_TABLE_TOTAL_CHARS,
            },
        }
    except ValueError:
        raise
    except Exception as error:
        raise ValueError(f"Could not extract tables from this PDF: {str(error)[:180]}") from None


def ocr_pdf_pages(
    name: str,
    media_type: str,
    content: bytes,
    *,
    page_start: int = 1,
    page_end: int = 5,
    language: str = "en",
) -> dict[str, Any]:
    """Render and locally OCR a bounded range of pages from an attached PDF."""
    _validate_pdf_attachment(name, media_type, content, page_start, page_end)
    if page_end - page_start + 1 > MAX_OCR_PAGES_PER_READ:
        raise ValueError(f"Read no more than {MAX_OCR_PAGES_PER_READ} pages with OCR at a time.")
    if language not in OCR_LANGUAGES:
        raise ValueError(f"Choose one of the supported OCR languages: {', '.join(OCR_LANGUAGES)}.")

    try:
        import pypdfium2 as pdfium
        from rapidocr import EngineType, ModelType, OCRVersion, RapidOCR
    except ImportError as error:
        missing = "PDF rendering" if error.name == "pypdfium2" else "local OCR"
        raise ValueError(f"{missing.capitalize()} is unavailable in this runtime.") from None

    global _OCR_ENGINE, _OCR_LANGUAGE
    document = None
    pages: list[dict[str, Any]] = []
    total_pixels = 0
    remaining_chars = MAX_OCR_TOTAL_CHARS
    try:
        # PDFium is not thread-safe; serialize rendering and OCR when independent agents run together.
        with _OCR_LOCK:
            document = pdfium.PdfDocument(content)
            page_count = len(document)
            if page_count > MAX_PDF_PAGES:
                raise ValueError(f"The PDF has more than {MAX_PDF_PAGES:,} pages.")
            if page_start > page_count:
                raise ValueError(f"The PDF has {page_count} pages; the selected range starts after the last page.")
            if _OCR_ENGINE is None or _OCR_LANGUAGE != language:
                _OCR_ENGINE = RapidOCR(params={
                    "Det.engine_type": EngineType.ONNXRUNTIME,
                    "Det.model_type": ModelType.SMALL,
                    "Det.ocr_version": OCRVersion.PPOCRV6,
                    "Rec.engine_type": EngineType.ONNXRUNTIME,
                    "Rec.model_type": ModelType.SMALL,
                    "Rec.ocr_version": OCRVersion.PPOCRV6,
                    "Rec.lang_type": language,
                })
                _OCR_LANGUAGE = language

            for index in range(page_start - 1, min(page_end, page_count)):
                if remaining_chars <= 0 or total_pixels >= MAX_OCR_PIXELS_PER_READ:
                    break
                page = document[index]
                bitmap = None
                image = None
                try:
                    width, height = page.get_size()
                    if width <= 0 or height <= 0:
                        raise ValueError(f"Page {index + 1} has invalid dimensions.")
                    remaining_pixels = min(
                        MAX_OCR_PIXELS_PER_PAGE,
                        MAX_OCR_PIXELS_PER_READ - total_pixels,
                    )
                    scale = min(
                        2.5, math.sqrt(remaining_pixels / (width * height)),
                        MAX_OCR_SIDE_PIXELS / max(width, height),
                    )
                    if scale < 0.5:
                        raise ValueError(f"Page {index + 1} is too large to render within the OCR pixel limit.")
                    pixel_width = math.ceil(width * scale)
                    pixel_height = math.ceil(height * scale)
                    pixels = pixel_width * pixel_height
                    if pixels > remaining_pixels or max(pixel_width, pixel_height) > MAX_OCR_SIDE_PIXELS:
                        raise ValueError(f"Page {index + 1} is too large to render within the OCR pixel limit.")
                    bitmap = page.render(
                        scale=scale, grayscale=True, draw_annots=False,
                        may_draw_forms=False, limit_image_cache=True,
                    )
                    image = bitmap.to_pil()
                    result = _OCR_ENGINE(image)
                    texts = getattr(result, "txts", None) or []
                    scores = getattr(result, "scores", None) or []
                    lines: list[str] = []
                    confidences: list[float] = []
                    low_confidence_lines = 0
                    for line_index, raw_text in enumerate(texts):
                        line = str(raw_text).strip()
                        if not line:
                            continue
                        lines.append(line)
                        try:
                            score = float(scores[line_index])
                        except (IndexError, TypeError, ValueError):
                            continue
                        if math.isfinite(score):
                            confidences.append(score)
                            if score < 0.6:
                                low_confidence_lines += 1
                    extracted = "\n".join(lines)
                    text = extracted[:min(MAX_OCR_CHARS_PER_PAGE, remaining_chars)]
                    pages.append({
                        "page": index + 1,
                        "text": text,
                        "characters": len(text),
                        "meanConfidence": round(sum(confidences) / len(confidences), 3) if confidences else None,
                        "lowConfidenceLineCount": low_confidence_lines,
                        "lowConfidence": bool(lines) and (not confidences or low_confidence_lines > 0),
                        "renderedPixels": pixels,
                        "truncated": len(extracted) > len(text),
                    })
                    total_pixels += pixels
                    remaining_chars -= len(text)
                finally:
                    if image is not None:
                        image.close()
                    if bitmap is not None:
                        bitmap.close()
                    page.close()

        pages_without_text = [page["page"] for page in pages if not page["text"].strip()]
        return {
            "fileName": name,
            "pageCount": page_count,
            "pages": pages,
            "pagesWithoutRecognisedText": pages_without_text,
            "ocrEngine": "RapidOCR · local CPU",
            "language": language,
            "reviewNote": "OCR text can contain recognition errors. Verify important names, figures and table values against the rendered page.",
            "rangeTruncated": len(pages) < min(page_end, page_count) - page_start + 1,
            "limits": {
                "maxPagesPerRead": MAX_OCR_PAGES_PER_READ,
                "maxPixelsPerPage": MAX_OCR_PIXELS_PER_PAGE,
                "maxPixelsTotal": MAX_OCR_PIXELS_PER_READ,
                "maxCharactersPerPage": MAX_OCR_CHARS_PER_PAGE,
                "maxCharactersTotal": MAX_OCR_TOTAL_CHARS,
            },
        }
    except ValueError:
        raise
    except Exception as error:  # noqa: BLE001 - PDFium and OCR library errors vary
        raise ValueError(f"Could not OCR these PDF pages: {str(error)[:180]}") from None
    finally:
        if document is not None:
            document.close()
