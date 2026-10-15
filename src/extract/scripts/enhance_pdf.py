#!/usr/bin/env python3
"""Bounded, local PDF OCR/structure extraction. Never downloads models or writes source files."""
from __future__ import annotations

import argparse
import contextlib
import importlib.metadata
import hashlib
import json
import os
import sys
import socket
from pathlib import Path

OCR_MODELS = {
    "PP-OCRv6_det_small.onnx": "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx": "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
    "PP-OCRv6_rec_small.onnx": "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
}


def disable_network():
    original = socket.socket.connect
    def local_only(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6):
            raise OSError("network is disabled during material recognition")
        return original(sock, address)
    socket.socket.connect = local_only


def emit(value):
    sys.__stdout__.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True)
    parser.add_argument("--pages", required=True)
    parser.add_argument("--backend", choices=("docling", "pdfium"), default="docling")
    parser.add_argument("--artifacts")
    args = parser.parse_args()
    try:
        selected = [int(p) for p in args.pages.split(",")]
        if not 1 <= len(selected) <= 6 or len(set(selected)) != len(selected) or min(selected) < 1:
            raise ValueError("one to six distinct positive physical pages are required")
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        disable_network()
        required = {"docling-slim": "2.137.0", "rapidocr": "3.10.0"}
        for distribution, expected in required.items():
            actual = importlib.metadata.version(distribution)
            if actual != expected:
                emit({"ok": False, "error": "unavailable", "detail": f"{distribution} {actual} is not the validated version {expected}"})
                return
        # Library progress and warnings must never corrupt the stdout JSON protocol.
        with contextlib.redirect_stdout(sys.stderr):
            import fitz
            import rapidocr
            models = Path(rapidocr.__file__).parent / "models"
            for name, expected in OCR_MODELS.items():
                candidate = models / name
                if not candidate.is_file() or hashlib.sha256(candidate.read_bytes()).hexdigest() != expected:
                    emit({"ok": False, "error": "unavailable", "detail": f"verified local OCR model is missing or corrupt: {name}"})
                    return
            from docling.document_converter import DocumentConverter, PdfFormatOption
            from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
            from docling.datamodel.base_models import InputFormat
            from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
            opts = PdfPipelineOptions()
            opts.do_ocr = True
            opts.do_table_structure = True
            opts.ocr_options = RapidOcrOptions(lang=["iso:zh"],
                det_model_path=str(models / "PP-OCRv6_det_small.onnx"),
                cls_model_path=str(models / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"),
                rec_model_path=str(models / "PP-OCRv6_rec_small.onnx"))
            if args.artifacts:
                opts.artifacts_path = args.artifacts
            if args.backend == "docling":
                from docling.backend.docling_parse_backend import ThreadedDoclingParseDocumentBackend
                backend = ThreadedDoclingParseDocumentBackend
            else:
                backend = PyPdfiumDocumentBackend
            converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts, backend=backend)})
            pages = []
            with fitz.open(args.path) as source:
                if source.needs_pass:
                    raise ValueError("password-protected PDF is not supported")
                if max(selected) > source.page_count:
                    raise ValueError("requested physical page exceeds document length")
                for number in selected:
                    page = source.load_page(number - 1)
                    has_text = bool(page.get_text("text").strip())
                    result = converter.convert(args.path, page_range=(number, number))
                    document = result.document
                    blocks = []
                    for item, _level in document.iterate_items():
                        if getattr(item, "prov", None) and any(p.page_no != number for p in item.prov):
                            raise ValueError("backend returned a mismatched physical page")
                        text = getattr(item, "text", None)
                        cells = None
                        if hasattr(item, "export_to_dataframe"):
                            frame = item.export_to_dataframe(doc=document)
                            cells = [[str(c) for c in frame.columns], *[[str(c) for c in row] for row in frame.values.tolist()]]
                            text = "\n".join(" | ".join(row) for row in cells)
                        if text:
                            block = {"kind": str(getattr(item, "label", "text")), "text": text,
                                     "page": number, "origin": "enhanced-extraction" if has_text else "ocr"}
                            if cells is not None:
                                block["cells"] = cells
                            blocks.append(block)
                    # One structure fallback: use actual text positions for tables the layout
                    # model missed. Keep original text and label the inferred cell geometry.
                    if has_text and not any(block.get("cells") for block in blocks):
                        candidates = page.find_tables(vertical_strategy="lines", horizontal_strategy="lines").tables
                        method = "pymupdf-lines"
                        if not candidates:
                            candidates = page.find_tables(vertical_strategy="text", horizontal_strategy="text",
                                                          min_words_vertical=3, min_words_horizontal=1).tables
                            method = "pymupdf-text-alignment"
                        for table in candidates:
                            cells = [[str(cell or "") for cell in row] for row in table.extract()]
                            cells = [row for row in cells if any(cell.strip() for cell in row)]
                            if len(cells) < 2 or min(sum(bool(cell.strip()) for cell in row) for row in cells) < 2:
                                continue
                            blocks.append({"kind": "table", "page": number,
                                           "text": "\n".join(" | ".join(row) for row in cells),
                                           "cells": cells, "bbox": list(table.bbox),
                                           "origin": "enhanced-extraction", "method": method,
                                           "inferred_structure": method == "pymupdf-text-alignment"})
                    body = "\n\n".join(block["text"] for block in blocks)
                    pages.append({"page": number, "text": body, "blocks": blocks,
                                  "ocr_completed": not has_text and bool(body),
                                  "unresolved": [] if body else ["no readable content was recovered"]})
            versions = {name: importlib.metadata.version(name) for name in ("docling-slim", "rapidocr")}
        warnings = ["enhanced extraction is not visual interpretation; diagrams require page-image review"]
        if any(block.get("inferred_structure") for page in pages for block in page["blocks"]):
            warnings.append("table cell grouping was inferred from text alignment; verify against the page image")
        payload = {"ok": True, "backend": args.backend, "versions": versions, "pages": pages,
                   "warnings": warnings}
        if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > 4 * 1024 * 1024:
            raise ValueError("enhancement exceeded the 4 MiB output budget")
        emit(payload)
    except ImportError as error:
        emit({"ok": False, "error": "unavailable", "detail": str(error)})
    except Exception as error:
        emit({"ok": False, "error": "failed", "detail": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    main()
