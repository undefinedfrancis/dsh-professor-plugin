#!/usr/bin/env python3
"""Report which extraction libraries this interpreter can actually import.

The Professor plugin never assumes an interpreter can extract anything because its file name looks
right. It runs this probe once per plugin instance and reports exactly what the interpreter said.

Prints one JSON object on stdout:

    {"ok": true, "python": "3.12.14", "modules": {"fitz": "1.24.9", "docx": "1.2.0", ...},
     "missing": ["fitz"]}

Exit status is 0 whenever the probe itself ran, whatever it found.
"""

from __future__ import annotations

import json
import sys

# Library -> the import name the plugin will use. `fitz` is PyMuPDF's documented legacy alias on
# the versions the workspace payload ships; `pymupdf` is the modern name and is accepted as well.
LIBRARIES = {
    "fitz": "fitz",
    "pymupdf": "pymupdf",
    "docx": "python-docx",
    "pptx": "python-pptx",
    "openpyxl": "openpyxl",
    "lxml": "lxml",
}


def main() -> int:
    found: dict[str, str] = {}
    missing: list[str] = []
    for module, distribution in LIBRARIES.items():
        try:
            imported = __import__(module)
        except Exception:  # noqa: BLE001 - a probe records absence, it never fails
            missing.append(module)
            continue
        version = getattr(imported, "__version__", None)
        if version is None:
            version = getattr(imported, "version", None)
        if isinstance(version, tuple):
            version = ".".join(str(part) for part in version)
        found[module] = str(version) if version else distribution

    sys.stdout.write(json.dumps({
        "ok": True,
        "python": ".".join(str(part) for part in sys.version_info[:3]),
        "modules": found,
        "missing": missing,
    }, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
