#!/usr/bin/env python3
"""Structured PDF text extraction through PyMuPDF, when the interpreter provides it.

This is the *preferred* structured backend (segment 1 of the plugin's documented preference order).
It is optional: when `fitz` cannot be imported the plugin falls back to Ghostscript, and reports
which backend it actually used.

The source PDF is opened read-only. Nothing is written, no page is rendered, no image is decoded
and no OCR is attempted: a page with no text layer simply yields empty text and the per-page
coordinates stay exact.

Output (one JSON object on stdout):

    {"ok": true, "pages": [{"page": 1, "text": "..."}], "notes": ["..."]}
    {"ok": false, "error": "unavailable" | "malformed" | "timeout", "detail": "..."}
"""

from __future__ import annotations

import argparse
import json
import sys

DEFAULT_MAX_CHARS = 4 * 1024 * 1024
DEFAULT_MAX_PAGES = 2000


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True)
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS)
    parser.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES)
    args = parser.parse_args()

    try:
        import fitz  # PyMuPDF
    except ImportError as error:
        emit({"ok": False, "error": "unavailable", "detail": f"PyMuPDF is not importable: {error}"})
        return 0

    pages: list[dict] = []
    notes: list[str] = []
    total = 0
    try:
        # `Document(path)` opens a file handle; the context manager closes it on every path.
        with fitz.open(args.path) as document:
            if document.needs_pass:
                emit({"ok": False, "error": "encrypted",
                      "detail": "the PDF is password-protected; no password was supplied"})
                return 0
            count = document.page_count
            for index in range(min(count, args.max_pages)):
                # `get_text('text')` reads the existing text layer only; it never renders or OCRs.
                page = document.load_page(index)
                text = page.get_text("text")
                visual_features = []
                if page.get_images():
                    visual_features.append("embedded-image")
                if page.get_drawings():
                    visual_features.append("vector-drawing")
                total += len(text)
                pages.append({"page": index + 1, "text": text,
                              "visual_features": visual_features})
                if total > args.max_chars:
                    emit({"ok": False, "error": "too-large",
                          "detail": f"extracted text exceeded the {args.max_chars}-character cap"})
                    return 0
            notes.append(f"pymupdf: {len(pages)} page(s) of {count}")
            if count > args.max_pages:
                notes.append(f"pymupdf: pages capped at {args.max_pages} of {count}")
            notes.append("pymupdf: text layer only; no page was rendered and no OCR ran")
    except Exception as error:  # noqa: BLE001 - every failure is classified
        emit({"ok": False, "error": "malformed", "detail": f"{type(error).__name__}: {error}"})
        return 0

    emit({"ok": True, "pages": pages, "notes": notes})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
