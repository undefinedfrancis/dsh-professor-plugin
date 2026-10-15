#!/usr/bin/env python3
"""Read-only structured text extraction for the Professor plugin (DOCX / PPTX / XLSX).

Contract with the Node side
---------------------------
* exactly one JSON object on stdout, followed by a newline;
* exit status is always 0 for a *classified* outcome. A non-zero exit is reserved for an
  interpreter-level failure (missing library, unreadable script), which the caller reports as
  `backend-unavailable`;
* nothing is ever written: every library is opened read-only, no macro is executed, and no
  formula is evaluated or recalculated. A formula is reported as the formula text it is;
* no pagination, no rendering, no layout, no visual interpretation. DOCX has no page numbers
  without rendering, so DOCX units carry no page coordinate — an unknown coordinate is omitted
  rather than invented.

Output shape
------------
    {"ok": true,  "format": "pptx", "units": [{"kind": "slide", "index": 1,
                                              "title": "...", "text": "...", "notes": "..."}],
                   "notes": ["..."]}
    {"ok": false, "error": "encrypted" | "malformed" | "unavailable", "detail": "..."}

`index` is one-based and means what `kind` says: the document (DOCX), the slide number (PPTX),
the sheet position in workbook order (XLSX). `notes` is a human-readable diagnostic list, never
extracted content.
"""

from __future__ import annotations

import argparse
import json
import sys

# Kept in step with `MAX_TEXT_BYTES` on the Node side; the caller caps again, and reports the cap.
DEFAULT_MAX_CHARS = 4 * 1024 * 1024
DEFAULT_LIMITS = {
    "max_sheets": 24,
    "max_rows": 2000,
    "max_cols": 64,
    "max_cells": 20000,
}


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")


def is_encrypted_container(path: str) -> bool:
    """An OOXML package is a ZIP; an encrypted Office document is an OLE/CFB container."""
    try:
        with open(path, "rb") as handle:
            head = handle.read(8)
    except OSError:
        return False
    return head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")


def _cell(cell) -> str:
    return cell.text.strip().replace("\n", " ")


def _table_rows(table) -> list[str]:
    rows = []
    for row in table.rows:
        cells = [_cell(cell) for cell in row.cells]
        if any(cells):
            rows.append("| " + " | ".join(cells) + " |")
    return rows


def docx_units(path: str, max_chars: int) -> tuple[list, list]:
    import docx

    document = docx.Document(path)
    blocks: list[str] = []
    headings = 0
    tables = 0
    for block in document.iter_inner_content():
        name = type(block).__name__
        if name == "Paragraph":
            text = block.text.strip()
            if not text:
                continue
            style = (block.style.name or "") if block.style is not None else ""
            level = None
            if style == "Title":
                level = 1
            elif style.startswith("Heading "):
                suffix = style.split(" ", 1)[1].strip()
                if suffix.isdigit():
                    level = max(1, min(6, int(suffix)))
            if level is not None:
                headings += 1
                blocks.append("#" * level + " " + text)
            else:
                blocks.append(text)
        elif name == "Table":
            tables += 1
            rows = _table_rows(block)
            if rows:
                blocks.append("\n".join(rows))
    text = "\n\n".join(blocks)
    notes = [f"docx: {headings} heading(s) and {tables} table(s) in document order",
             "docx: no page coordinate (structurally read from XML; the document was not rendered)"]
    if len(text) > max_chars:
        return [], notes + [f"docx: text exceeded the {max_chars}-character cap and was not extracted"]
    if not text.strip():
        return [], notes + ["docx: no text content"]
    return [{"kind": "document", "index": 1, "title": None, "text": text}], notes


def pptx_units(path: str, max_chars: int, include_notes: bool) -> tuple[list, list]:
    from pptx import Presentation

    presentation = Presentation(path)
    units: list[dict] = []
    notes: list[str] = []
    notes_seen = 0
    for number, slide in enumerate(presentation.slides, start=1):
        title = None
        try:
            placeholder = slide.shapes.title
            if placeholder is not None and placeholder.has_text_frame:
                title = placeholder.text_frame.text.strip() or None
        except (AttributeError, KeyError, ValueError):
            title = None
        blocks: list[str] = []
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False):
                value = shape.text_frame.text.strip()
                if value and value != (title or ""):
                    blocks.append(value)
            if getattr(shape, "has_table", False):
                blocks.extend(_table_rows(shape.table))
        unit = {"kind": "slide", "index": number, "title": title, "text": "\n\n".join(blocks)}
        if include_notes:
            speaker_notes = ""
            if getattr(slide, "has_notes_slide", False):
                frame = slide.notes_slide.notes_text_frame
                speaker_notes = (frame.text if frame is not None else "").strip()
            if speaker_notes:
                notes_seen += 1
                unit["notes"] = speaker_notes
        units.append(unit)

    notes.append(f"pptx: {len(units)} slide(s)")
    if include_notes:
        notes.append(f"pptx: speaker notes requested and found on {notes_seen} slide(s)")
    else:
        notes.append("pptx: speaker notes excluded (not requested)")
    notes.append("pptx: text only; images, charts, equations, transitions and layout were not inspected")

    total = sum(len(unit.get("text", "")) + len(unit.get("notes", "")) for unit in units)
    if total > max_chars:
        return [], notes + [f"pptx: text exceeded the {max_chars}-character cap and was not extracted"]
    if not any(unit.get("text") or unit.get("title") for unit in units):
        return [], notes + ["pptx: no text content"]
    return units, notes


def xlsx_units(path: str, max_chars: int, limits: dict) -> tuple[list, list]:
    from openpyxl import load_workbook

    # read_only streams rows instead of materialising the sheet; keep_links=False avoids touching
    # external workbooks. data_only=False so a formula stays a formula.
    workbook = load_workbook(path, read_only=True, data_only=False, keep_links=False)
    try:
        names = list(workbook.sheetnames)
        units: list[dict] = []
        notes: list[str] = []
        truncated: list[str] = []
        selected = names[: limits["max_sheets"]]
        if len(names) > len(selected):
            truncated.append(f"workbook sheets capped at {limits['max_sheets']} of {len(names)}")
        cells_seen = 0
        chars_seen = 0
        for sheet_index, name in enumerate(selected, start=1):
            sheet = workbook[name]
            rows: list[str] = []
            for row_index, row in enumerate(sheet.iter_rows(values_only=False), start=1):
                if row_index > limits["max_rows"]:
                    truncated.append(f"sheet '{name}': rows capped at {limits['max_rows']}")
                    break
                if cells_seen >= limits["max_cells"]:
                    truncated.append(f"total cells capped at {limits['max_cells']}")
                    break
                cells: list[str] = []
                for column_index, cell in enumerate(row, start=1):
                    if column_index > limits["max_cols"]:
                        truncated.append(f"sheet '{name}': columns capped at {limits['max_cols']}")
                        break
                    value = cell.value
                    if value is None:
                        continue
                    cells_seen += 1
                    # A formula is reproduced as written; nothing here recalculates it.
                    cells.append(value if isinstance(value, str) and value.startswith("=")
                                 else str(value).replace("\n", " ").strip())
                if any(cells):
                    line = "| " + " | ".join(cells) + " |"
                    chars_seen += len(line) + 1
                    rows.append(line)
                if chars_seen > max_chars:
                    truncated.append(f"text capped at {max_chars} characters")
                    break
            units.append({"kind": "sheet", "index": sheet_index, "title": name, "text": "\n".join(rows)})
            if cells_seen >= limits["max_cells"] or chars_seen > max_chars:
                break

        notes.append(f"xlsx: {len(units)} sheet(s) extracted of {len(names)} in workbook order")
        notes.append(f"xlsx: {cells_seen} non-empty cell(s) read")
        notes.append("xlsx: formulas are reported as formulas and were not recalculated")
        notes.append("xlsx: macros were neither read nor executed; the workbook was not modified")
        notes.extend(f"xlsx: {item}" for item in truncated)
        if not any(unit["text"].strip() for unit in units):
            return [], notes + ["xlsx: no cell values in the used region"]
        return units, notes
    finally:
        workbook.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--format", required=True, choices=["docx", "pptx", "xlsx"])
    parser.add_argument("--path", required=True)
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS)
    parser.add_argument("--max-sheets", type=int, default=DEFAULT_LIMITS["max_sheets"])
    parser.add_argument("--max-rows", type=int, default=DEFAULT_LIMITS["max_rows"])
    parser.add_argument("--max-cols", type=int, default=DEFAULT_LIMITS["max_cols"])
    parser.add_argument("--max-cells", type=int, default=DEFAULT_LIMITS["max_cells"])
    parser.add_argument("--include-notes", action="store_true")
    args = parser.parse_args()

    if is_encrypted_container(args.path):
        emit({"ok": False, "error": "encrypted",
              "detail": "OLE/CFB container: the document is encrypted or password-protected"})
        return 0

    limits = {
        "max_sheets": args.max_sheets,
        "max_rows": args.max_rows,
        "max_cols": args.max_cols,
        "max_cells": args.max_cells,
    }
    try:
        if args.format == "docx":
            units, notes = docx_units(args.path, args.max_chars)
        elif args.format == "pptx":
            units, notes = pptx_units(args.path, args.max_chars, args.include_notes)
        else:
            units, notes = xlsx_units(args.path, args.max_chars, limits)
    except ImportError as error:
        emit({"ok": False, "error": "unavailable", "detail": f"{type(error).__name__}: {error}"})
        return 0
    except Exception as error:  # noqa: BLE001 - every failure is classified, never a traceback
        emit({"ok": False, "error": "malformed", "detail": f"{type(error).__name__}: {error}"})
        return 0

    emit({"ok": True, "format": args.format, "units": units, "notes": notes})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
