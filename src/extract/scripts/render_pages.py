#!/usr/bin/env python3
"""Bounded page rasterisation for `professor_material_read`.

Renders an explicit set of physical pages of a PDF to JPEG **in memory** and prints base64.
Nothing is written to disk: the caller receives the bytes, hands them to the Harness attachment
service and drops them, so no rendered image is ever stored next to course material and no image
cache outlives the call.

Pages are addressed either as an explicit list (`--pages 1,10,500`) or as a contiguous range
(`--from/--to`). The explicit list is what the tool uses, because a request for pages 1 and 10 must
not silently render 1-4 and skip 10, and must not spend its page and byte budget on pages 2-9 that
nobody asked for. Pages are rendered in ascending order, so a byte budget that runs out stops at a
deterministic point and the caller can name exactly which requested pages were not produced.

The source PDF is opened read-only. No OCR runs and no text is interpreted — this script's only
job is pixels. Page numbers are *physical* 1-based positions in the file; printed/footer numbering
is not parsed and is never inferred here.

Output (one JSON object on stdout):

    {"ok": true, "pages": [{"page": 3, "width": 1600, "height": 900, "bytes": 41234, "b64": "..."}],
     "truncated": false, "total_pages": 55, "requested": [3], "notes": ["..."]}
    {"ok": false, "error": "unavailable" | "encrypted" | "malformed" | "range", "detail": "..."}

Exit status is 0 whenever the script itself ran, whatever it found; the plugin classifies the
result from the JSON, exactly like the text-extraction backends.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys

DEFAULT_MAX_SIDE = 1600
DEFAULT_QUALITY = 80
DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024
# One invocation renders a bounded handful of pages: the caller pages through a lecture instead of
# asking for the whole document as images in a single request.
MAX_PAGES_PER_RUN = 16
# Never honour a byte budget below this: the caller's remaining capacity may be a few hundred
# bytes, and honouring it literally would encode nothing at all. The caller checks its own remaining
# capacity against this same floor before it renders, so nothing is ever rendered that the caller
# already knew it could not deliver.
MIN_TOTAL_BYTES = 1024


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")


def import_pymupdf():
    """Return the PyMuPDF module under whichever name this interpreter exposes."""
    try:
        import pymupdf  # modern name
        return pymupdf
    except ImportError:
        pass
    try:
        import fitz as pymupdf  # documented legacy alias
        return pymupdf
    except ImportError as error:
        raise ImportError(f"PyMuPDF is not importable: {error}") from error


def to_rgb(pixmap, fitz_module):
    """JPEG needs 3 channels; a CMYK or grayscale pixmap is converted rather than rejected."""
    try:
        if pixmap.colorspace is None or pixmap.colorspace.n != 3:
            return fitz_module.Pixmap(fitz_module.csRGB, pixmap)
    except Exception:  # noqa: BLE001 - conversion is best effort; the original still encodes
        return pixmap
    return pixmap


def parse_pages_list(raw: str) -> list[int]:
    """`--pages 1,10,500` -> [1, 10, 500], de-duplicated and ascending.

    Ascending order is deliberate: when the byte budget runs out the caller must be able to say
    exactly which requested pages were not produced, and that answer has to be stable.
    """
    pages: set[int] = set()
    for chunk in raw.split(","):
        token = chunk.strip()
        if not token:
            continue
        value = int(token)
        if value >= 1:
            pages.add(value)
    return sorted(pages)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True)
    parser.add_argument("--pages", dest="pages_list", type=str, default=None,
                        help="comma-separated explicit 1-based physical page numbers")
    parser.add_argument("--from", dest="from_page", type=int, default=1)
    parser.add_argument("--to", dest="to_page", type=int, default=1)
    parser.add_argument("--max-side", type=int, default=DEFAULT_MAX_SIDE)
    parser.add_argument("--quality", type=int, default=DEFAULT_QUALITY)
    parser.add_argument("--max-total-bytes", type=int, default=DEFAULT_MAX_TOTAL_BYTES)
    args = parser.parse_args()

    explicit = args.pages_list is not None
    notes: list[str] = []
    try:
        wanted = parse_pages_list(args.pages_list) if explicit else None
    except ValueError:
        emit({"ok": False, "error": "range",
              "detail": "--pages must be a comma-separated list of page numbers"})
        return 0
    if explicit and not wanted:
        emit({"ok": False, "error": "range",
              "detail": "--pages contained no positive page number"})
        return 0
    if not explicit:
        first = max(1, args.from_page)
        wanted = list(range(first, max(first, args.to_page) + 1))
        if len(wanted) > MAX_PAGES_PER_RUN:
            notes.append(f"range capped at {MAX_PAGES_PER_RUN} pages per call")
            wanted = wanted[:MAX_PAGES_PER_RUN]

    try:
        fitz = import_pymupdf()
    except ImportError as error:
        emit({"ok": False, "error": "unavailable", "detail": str(error)})
        return 0

    quality = min(95, max(1, args.quality))
    max_side = max(64, args.max_side)
    budget = max(MIN_TOTAL_BYTES, args.max_total_bytes)

    pages: list[dict] = []
    truncated = False
    total_bytes = 0
    count = 0

    try:
        with fitz.open(args.path) as document:
            if document.needs_pass:
                emit({"ok": False, "error": "encrypted",
                      "detail": "the PDF is password-protected; no password was supplied"})
                return 0
            count = document.page_count
            if count == 0:
                emit({"ok": False, "error": "range", "detail": "the PDF has no pages"})
                return 0
            in_range = [page for page in wanted if page <= count]
            beyond = [page for page in wanted if page > count]
            if beyond:
                notes.append(
                    f"page(s) {', '.join(str(page) for page in beyond)} beyond the document "
                    f"({count} page(s)); not rendered"
                )
            if not in_range:
                emit({"ok": False, "error": "range",
                      "detail": f"no requested page is within the document ({count} page(s))"})
                return 0
            selected = in_range
            if len(selected) > MAX_PAGES_PER_RUN:
                truncated = True
                selected = selected[:MAX_PAGES_PER_RUN]
                notes.append(f"pages capped at {MAX_PAGES_PER_RUN} per call")

            for page_number in selected:
                page = document.load_page(page_number - 1)
                rect = page.rect
                longest = max(rect.width, rect.height, 1.0)
                zoom = max_side / longest
                # In-memory rasterisation: no temp file, no output directory, no side effects.
                pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
                pixmap = to_rgb(pixmap, fitz)
                try:
                    encoded = pixmap.tobytes("jpeg", jpg_quality=quality)
                except TypeError:
                    # Older PyMuPDF builds accept no quality argument; the size budget still holds.
                    encoded = pixmap.tobytes("jpeg")
                    notes.append("jpeg quality argument unsupported by this PyMuPDF build")
                if total_bytes + len(encoded) > budget:
                    truncated = True
                    notes.append(
                        f"byte budget of {budget} reached after {len(pages)} page(s); "
                        "the remaining requested pages were not rendered"
                    )
                    break
                total_bytes += len(encoded)
                pages.append({
                    "page": page_number,
                    "width": pixmap.width,
                    "height": pixmap.height,
                    "bytes": len(encoded),
                    "b64": base64.b64encode(encoded).decode("ascii"),
                })
            notes.append(
                f"pymupdf: rendered {len(pages)} page(s) of {count}; physical 1-based page numbers, "
                "printed/footer numbering not parsed"
            )
    except Exception as error:  # noqa: BLE001 - every failure is classified
        emit({"ok": False, "error": "malformed", "detail": f"{type(error).__name__}: {error}"})
        return 0

    emit({
        "ok": True,
        "pages": pages,
        "truncated": truncated,
        "total_pages": count,
        "requested": wanted,
        "notes": notes,
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
