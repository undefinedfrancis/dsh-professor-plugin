/**
 * Synthetic real-format fixtures, built at test time.
 *
 * Two rules shaped this module:
 *
 * 1. **No binary fixtures are committed.** A `.docx` in the repository would be a binary blob no
 *    reviewer can read, and the distribution contract deliberately keeps fixture dumps out of the
 *    tarball. Everything here is *generated* into a temporary directory instead, so what a test
 *    asserts against is reproducible from this source.
 * 2. **Nothing personal, nothing copyrighted.** The PDF is assembled byte by byte from literal
 *    strings in this file; the Office documents are written by a short script with hardcoded
 *    academic-placeholder content (Big-O notation, amortised analysis, recursion). No course
 *    material, no personal data and no third-party document is involved.
 *
 * The PDF builder is pure JavaScript, so the PDF tests never depend on a Python or Ghostscript
 * being installed. The Office builders need `python-docx` / `python-pptx` / `openpyxl`; when the
 * bundled interpreter cannot be found the integration tests skip with an explicit reason while the
 * contract tests keep running against deterministic injected output.
 *
 * @module test/helpers/fixtures
 */

import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  PROBE_SCRIPT, existingCandidates, parsePythonProbe, pythonCandidates,
} from '../../src/extract/runtime.js'

/** Escape a literal PDF string. */
function pdfEscape(text) {
  return String(text).replace(/([\\()])/g, '\\$1')
}

/**
 * Build a minimal but genuinely valid PDF with a real text layer.
 *
 * The structure is: catalog, page tree, one base font, and two objects per page (the page and its
 * content stream). Nothing time- or machine-dependent is written, so the bytes are identical on
 * every run — which is what lets a test assert that re-extraction is deterministic.
 *
 * @param options.pages - an array of page texts; each string becomes one page, one line per `\n`.
 * @param options.width / options.height - MediaBox size.
 * @returns the file bytes as a `Buffer`.
 */
export function buildPdfBytes(options = {}) {
  const { pages = [], width = 612, height = 792 } = options
  const bodies = new Map()
  const pageIds = pages.map((_, index) => 4 + index * 2)

  bodies.set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  bodies.set(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  bodies.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')

  pages.forEach((text, index) => {
    const pageId = 4 + index * 2
    const contentId = pageId + 1
    const lines = String(text).split('\n')
    const operators = ['BT', '/F1 14 Tf', '72 720 Td']
    lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) operators.push('0 -22 Td')
      operators.push(`(${pdfEscape(line)}) Tj`)
    })
    operators.push('ET')
    const content = Buffer.from(`${operators.join('\n')}\n`, 'latin1')
    bodies.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] `
      + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`)
    bodies.set(contentId, { stream: content })
  })

  return assemblePdf(bodies)
}

/**
 * Build a valid PDF whose single page has **no text layer** — the scanned-document shape.
 *
 * The page paints a filled rectangle and writes no text operator at all, so every text backend
 * legitimately reports empty output. That is what makes it the right fixture for asserting the
 * plugin reports `unsupported` (with OCR named) rather than a partial read.
 */
export function buildScannedPdfBytes(options = {}) {
  const { width = 612, height = 792 } = options
  const bodies = new Map()
  bodies.set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  bodies.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  bodies.set(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] `
    + '/Resources << >> /Contents 4 0 R >>')
  const content = Buffer.from('0.2 0.2 0.2 rg\n72 72 468 648 re f\n', 'latin1')
  bodies.set(4, { stream: content })
  return assemblePdf(bodies)
}

/** Serialise objects into a PDF file with a correct xref table. */
function assemblePdf(bodies) {
  const out = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets = new Map()
  let length = out[0].length

  for (const id of [...bodies.keys()].sort((a, b) => a - b)) {
    const body = bodies.get(id)
    const head = Buffer.from(`${id} 0 obj\n`, 'latin1')
    let payload
    if (typeof body === 'string') {
      payload = Buffer.from(`${body}\nendobj\n`, 'latin1')
    } else {
      // A stream's /Length must count the bytes between `stream\n` and `\nendstream`.
      const open = Buffer.from(`<< /Length ${body.stream.length} >>\nstream\n`, 'latin1')
      payload = Buffer.concat([open, body.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')])
    }
    offsets.set(id, length)
    out.push(head, payload)
    length += head.length + payload.length
  }

  const maxId = Math.max(...bodies.keys())
  const xrefOffset = length
  const xref = [`xref\n0 ${maxId + 1}\n`, '0000000000 65535 f \n']
  for (let id = 1; id <= maxId; id += 1) {
    xref.push(`${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`)
  }
  xref.push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
  out.push(Buffer.from(xref.join(''), 'latin1'))

  return Buffer.concat(out)
}

/** Write a generated fixture, creating parents. */
export async function writeFixtureFile(directory, relative, content) {
  const target = path.join(directory, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
  return target
}

/** The interpreter this machine's Harness payload actually provides, probed for real. */
export function bundledPython(options = {}) {
  const candidates = existingCandidates(pythonCandidates({ env: options.env ?? process.env }))
  const script = options.probeScript ?? path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', '..', PROBE_SCRIPT,
  )
  for (const candidate of candidates.slice(0, 4)) {
    try {
      const stdout = execFileSync(candidate.path, [script], { encoding: 'utf8', timeout: 20_000 })
      const probe = parsePythonProbe(stdout)
      if (probe !== null) return { path: candidate.path, source: candidate.source, probe }
    } catch {
      // try the next candidate; an interpreter that cannot run the probe is simply not usable
    }
  }
  return null
}

/** Whether the probed interpreter can import all three Office libraries. */
export function hasOfficeModules(python) {
  const modules = python?.probe?.modules ?? {}
  return typeof modules.docx === 'string' && typeof modules.pptx === 'string' && typeof modules.openpyxl === 'string'
}

/** The script that writes the three Office fixtures. Content is placeholder academic material. */
export const OFFICE_FIXTURE_SCRIPT = `
import sys
from pathlib import Path

out = Path(sys.argv[1])

from docx import Document
document = Document()
document.add_heading("Big-O Notation", level=1)
document.add_paragraph("Big-O notation describes the growth of work as the input grows.")
document.add_heading("Examples", level=2)
document.add_paragraph("A linear scan over n items is O(n).")
table = document.add_table(rows=2, cols=2)
table.cell(0, 0).text = "Structure"
table.cell(0, 1).text = "Lookup"
table.cell(1, 0).text = "Hash table"
table.cell(1, 1).text = "O(1) average"
document.save(str(out / "lecture.docx"))

from pptx import Presentation
presentation = Presentation()
layout = presentation.slide_layouts[1]
first = presentation.slides.add_slide(layout)
first.shapes.title.text = "Amortised Analysis"
first.placeholders[1].text = "A dynamic array append costs O(1) amortised."
first.notes_slide.notes_text_frame.text = "Remind students about the doubling argument."
second = presentation.slides.add_slide(layout)
second.shapes.title.text = "Recursion"
second.placeholders[1].text = "A recursive function calls itself on a smaller input."
presentation.save(str(out / "lecture.pptx"))

from openpyxl import Workbook
workbook = Workbook()
revenue = workbook.active
revenue.title = "Revenue"
revenue.append(["Quarter", "Revenue"])
revenue.append(["Q1", 12])
revenue.append(["Q2", 18])
revenue.append(["Total", "=SUM(B2:B3)"])
notes = workbook.create_sheet("Notes")
notes.append(["Note"])
notes.append(["amortised cost"])
workbook.save(str(out / "figures.xlsx"))
print("fixtures written")
`

/**
 * Write the DOCX / PPTX / XLSX fixtures into `directory`.
 *
 * @param directory - destination directory.
 * @param options.python - a probed interpreter; when omitted the bundled one is probed for.
 * @returns `{ docx, pptx, xlsx, python }` or `null` when no usable interpreter is present.
 */
export async function writeOfficeFixtures(directory, options = {}) {
  const python = options.python ?? bundledPython(options)
  if (python === null || !hasOfficeModules(python)) return null
  await fs.mkdir(directory, { recursive: true })
  execFileSync(python.path, ['-', directory], {
    input: OFFICE_FIXTURE_SCRIPT,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return {
    python,
    docx: path.join(directory, 'lecture.docx'),
    pptx: path.join(directory, 'lecture.pptx'),
    xlsx: path.join(directory, 'figures.xlsx'),
  }
}
