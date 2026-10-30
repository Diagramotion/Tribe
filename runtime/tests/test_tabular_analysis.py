from __future__ import annotations

import io
import unittest

from openpyxl import Workbook

from tribe_runtime.tabular_analysis import preview_xlsx_artifact, profile_tabular_artifact


XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _workbook_with_stacked_headers_and_merges() -> bytes:
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "Sales"
    worksheet.append(["Sales", None, "Context", None])
    worksheet.merge_cells("A1:B1")
    worksheet.merge_cells("C1:D1")
    worksheet.append(["Q1", "Q2", "Region", "Total"])
    worksheet.append([10, 20, "West", "=SUM(A3:B3)"])
    worksheet.append([11, 21, None, "=SUM(A4:B4)"])
    worksheet.merge_cells("C3:C4")
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


class XlsxPreviewTests(unittest.TestCase):
    def test_stacked_headers_merge_headings_and_formula_metadata_are_preserved(self) -> None:
        content = _workbook_with_stacked_headers_and_merges()

        preview = preview_xlsx_artifact(
            "sales.xlsx", XLSX_MEDIA_TYPE, content, header_rows=2,
        )
        profile = profile_tabular_artifact(
            "sales.xlsx", XLSX_MEDIA_TYPE, content, header_rows=2,
        )

        self.assertEqual(preview["headers"], [
            "Sales · Q1", "Sales · Q2", "Context · Region", "Context · Total",
        ])
        self.assertEqual(profile["columns"][0]["name"], "Sales · Q1")
        self.assertEqual(preview["rows"][0]["rowNumber"], 3)
        self.assertEqual(preview["mergedRanges"], [{
            "firstRow": 3, "lastRow": 4, "firstColumn": 3, "lastColumn": 3,
        }])
        formula = preview["rows"][0]["formulaInfo"][3]
        self.assertEqual(formula["formula"], "=SUM(A3:B3)")
        self.assertTrue(formula["resultMissing"])

    def test_header_row_count_is_bounded(self) -> None:
        with self.assertRaisesRegex(ValueError, "between 1 and 5"):
            preview_xlsx_artifact(
                "sales.xlsx", XLSX_MEDIA_TYPE, _workbook_with_stacked_headers_and_merges(),
                header_rows=6,
            )


if __name__ == "__main__":
    unittest.main()
