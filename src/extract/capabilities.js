/**
 * Capability detection for extraction (M8).
 *
 * Extraction never assumes: every backend is probed before it is used, and a format with no
 * available backend is reported `unsupported` rather than being faked with a partial read. The
 * matrix below is the plugin's own boundary (`docs/AUDIT.md` records the host survey it came from):
 *
 * | format | backend | availability |
 * |---|---|---|
 * | text/markdown/latex/csv/json/source | none (read bytes) | always |
 * | PDF → text | `fitz` (PyMuPDF), else `gs -sDEVICE=txtwrite` | probed |
 * | PDF → page pixels | `render_pages.py` under PyMuPDF, in memory, byte-bounded | probed |
 * | DOCX / PPTX / XLSX | bundled Python (`python-docx`, `python-pptx`, `openpyxl`) | probed |
 * | Office → PDF | `ctx.officeToPdf` (host service) | injected |
 * | LaTeX compile | `latexmk` / `xelatex` via shell | probed (M11) |
 * | OCR | — | **disabled by design**: the plugin wires no OCR engine, so a scanned PDF or image with no text layer is `unsupported`, never silently mislabelled |
 *
 * Rendering produces pixels and nothing else: no OCR runs on them and no claim of visual
 * inspection is made by this module. That claim belongs to whoever actually looks at the image.
 *
 * Probing uses the Harness shell capability and the injected workspace-dependency paths; it does
 * not shell out from plugin code directly, so the sandbox and the read policy still apply.
 *
 * @module dsh-professor-spike/src/extract/capabilities
 */

import { OFFICE_MODULES, OFFICE_PACKAGES } from './runtime.js'

/** Extraction states a record may carry. */
export const EXTRACTION_STATES = ['pending', 'extracted', 'partial', 'unsupported', 'failed']

/** Text-like formats the plugin reads without any external tool. */
export const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'tex', 'ltx', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml',
  'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'go', 'rs', 'rb', 'php',
  'sh', 'bash', 'sql', 'html', 'css', 'ini', 'cfg', 'conf', 'log', 'r', 'm', 'swift', 'kt',
])

/** Office container formats. */
export const OFFICE_EXTENSIONS = new Set(['docx', 'pptx', 'xlsx'])

/** Formats that are images (metadata only; OCR is disabled). */
export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'svg'])

/** Format that needs a PDF text backend. */
export const PDF_EXTENSIONS = new Set(['pdf'])

/**
 * The one sentence this plugin uses when no PDF text backend was observed.
 *
 * Exported rather than repeated: the same reason is reported by `planExtraction`, by the runner and
 * by the capability summary, and three slightly different sentences for one fact is how a report
 * starts to disagree with itself.
 */
export const NO_PDF_BACKEND_REASON = 'no PDF text backend was observed in this runtime'
  + ' (a bundled Python with PyMuPDF, or Ghostscript with the txtwrite device, would enable it);'
  + ' OCR is disabled by design'

/**
 * The reason no Office backend can read one format.
 *
 * Per format on purpose: an interpreter with `python-docx` but no `python-pptx` really can read a
 * DOCX, so "Office is unavailable" would both overstate and understate what was observed. The
 * message names the missing distribution so it is actionable.
 */
export function noOfficeBackendReason(extension) {
  const pip = OFFICE_PACKAGES[extension] ?? 'the matching library'
  return `no Office extractor for ${extension} was observed in this runtime`
    + ` (the Python backend needs ${pip}); the document was not read by an approximation`
}

/**
 * Whether an Office format has a usable backend in this capability map.
 *
 * `officeModules` is the precise shape the probe fills in. A map that only carries the older
 * `officePython` flag is honoured as "all three were available", so an older caller keeps working;
 * a map carrying neither claims nothing.
 */
export function officeFormatAvailable(capabilities, extension) {
  const modules = capabilities?.officeModules
  if (modules !== null && typeof modules === 'object') return modules[extension] === true
  return capabilities?.officePython === true
}

/** Files this plugin will not extract at all (executables, archives, media with no text layer). */
export const OPAQUE_EXTENSIONS = new Set([
  'zip', 'tar', 'gz', 'dmg', 'exe', 'bin', 'app', 'so', 'dylib', 'dll', 'mp4', 'mp3', 'mov',
  'wav', 'wav', 'ttf', 'otf', 'woff', 'woff2', 'sqlite', 'db',
])

/**
 * Classify a file extension into a backend family.
 *
 * @param extension - lower-case extension without the dot.
 * @returns `'text' | 'pdf' | 'office' | 'image' | 'opaque' | 'unknown'`.
 */
export function backendFamilyFor(extension) {
  const ext = String(extension ?? '').toLowerCase().replace(/^\./, '')
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (PDF_EXTENSIONS.has(ext)) return 'pdf'
  if (OFFICE_EXTENSIONS.has(ext)) return 'office'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (OPAQUE_EXTENSIONS.has(ext)) return 'opaque'
  return 'unknown'
}

/**
 * Decide whether a file can be extracted, given the probed capabilities.
 *
 * @param options.extension - lower-case extension.
 * @param options.capabilities - the probed capability map.
 * @returns `{ supported: boolean, family, extractor, reason? }`.
 */
export function planExtraction({ extension, capabilities }) {
  const family = backendFamilyFor(extension)
  switch (family) {
    case 'text':
      return { supported: true, family, extractor: 'text-reader' }
    case 'pdf':
      if (capabilities.pdfText === 'fitz') return { supported: true, family, extractor: 'pdf-fitz' }
      if (capabilities.pdfText === 'ghostscript') return { supported: true, family, extractor: 'pdf-ghostscript' }
      return { supported: false, family, extractor: null, reason: NO_PDF_BACKEND_REASON }
    case 'office':
      if (officeFormatAvailable(capabilities, extension)) {
        return { supported: true, family, extractor: `office-${extension}` }
      }
      return { supported: false, family, extractor: null, reason: noOfficeBackendReason(extension) }
    case 'image':
      return {
        supported: false,
        family,
        extractor: null,
        reason: 'images expose no text layer and OCR is disabled by design; metadata only',
      }
    case 'opaque':
      return { supported: false, family, extractor: null, reason: 'opaque binary container; no text extraction is attempted' }
    default:
      return { supported: false, family, extractor: null, reason: 'unrecognised format' }
  }
}

/**
 * Summarise a capability map for diagnostics and tool output.
 *
 * Three kinds of statement are kept apart, because conflating them is exactly the dishonesty this
 * plugin exists to avoid:
 *
 * - **observed backends** — an entry under `pdf`/`office` is populated only from a probe that
 *   really executed the candidate and read its answer. A backend that was never probed stays
 *   `null`, never `true`;
 * - **the plugin's own boundary** — "nothing is extracted unless a backend was observed" is a
 *   statement about this plugin, and `gating` says so;
 * - **the remaining limitation** — OCR is `false` unconditionally because no OCR engine is wired,
 *   and `visual` stays `false`: rendering can produce pixels, but nothing in this plugin looks at
 *   them, so no "visually inspected" claim is ever made here. Whether a page was actually seen is
 *   reported separately by the reading ledger (`pageRender` below covers *rendering* only).
 *
 * The older flat fields (`pdfText`, `officePython`, `latex`, …) are kept: callers and the
 * distribution contract depend on them, and the audit's rule is that a capability report grows
 * rather than silently changes shape.
 *
 * @param capabilities - the probed map.
 * @returns a stable, serialisable summary including an explicit `ocr: false`.
 */
export function summarizeCapabilities(capabilities) {
  const pdfText = capabilities.pdfText ?? null
  const officePython = capabilities.officePython === true
  const pdfBackend = capabilities.pdfBackend ?? (pdfText === null ? null : pdfText)
  // Per format, so "docx: true, pptx: false" is a possible and honest report. The older
  // `officeModules`-less shape is folded in through the same predicate `planExtraction` uses.
  const officeFormats = {
    docx: officeFormatAvailable(capabilities, 'docx'),
    pptx: officeFormatAvailable(capabilities, 'pptx'),
    xlsx: officeFormatAvailable(capabilities, 'xlsx'),
  }
  const officeAny = officeFormats.docx || officeFormats.pptx || officeFormats.xlsx
  // A blanket reason would contradict a `docx: true` beside it, so it is only stated when no
  // format at all could be read.
  const officeReason = officeAny
    ? null
    : 'no Python extractor was observed in this runtime'
      + ` (${Object.values(OFFICE_PACKAGES).join(' / ')}); a bundled or workspace interpreter is used when one`
      + ' is present, and none was'
  const officeUnobserved = Object.keys(OFFICE_MODULES)
    .filter((format) => officeFormats[format] !== true)
    .map((format) => `office:${format}: no extractor was observed (needs ${OFFICE_PACKAGES[format]})`)

  const renderBackend = capabilities.render ?? null

  return {
    // --- the required shape: one block per family, describing observed reality ----
    pdf: {
      text: pdfText !== null,
      backend: pdfBackend,
      pageCoordinates: capabilities.pdfPageCoordinates ?? null,
      // `visual` means "the plugin inspected the pixels", which it never does. Rendering is a
      // separate, honestly-named capability reported under `pageRender`.
      visual: false,
      ocr: false,
      ...(pdfText === null ? { reason: NO_PDF_BACKEND_REASON } : {}),
    },
    office: {
      docx: officeFormats.docx,
      pptx: officeFormats.pptx,
      xlsx: officeFormats.xlsx,
      backend: officePython || officeAny ? 'bundled-python' : null,
      slideCoordinates: capabilities.slideCoordinates ?? null,
      ...(officeReason === null ? {} : { reason: officeReason }),
    },

    // --- page rasterisation (bounded, in memory, never interpreted) ------------------
    enhancement: capabilities.enhancement ?? { configured: false, last_status: 'not-run', auto_provisioned: false },
    pageRender: {
      available: renderBackend !== null,
      backend: renderBackend,
      interpreter: capabilities.pdfInterpreter ?? null,
      bounds: 'in-memory JPEG, at most 16 pages per call, long-edge and total-byte budgets applied by the script',
      writes: 'nothing: no file is created and no image is persisted by the renderer',
      ...(renderBackend === null
        ? { reason: 'no interpreter importing PyMuPDF was observed in this runtime, so pages cannot be rasterised' }
        : {}),
    },

    // --- the established flat fields, unchanged --------------------------------
    pdfText,
    pdfPages: capabilities.pdfPages ?? null,
    officePython,
    officeToPdf: capabilities.officeToPdf === true,
    latex: capabilities.latex ?? null,
    ocr: false,
    note: 'OCR is disabled by design: no OCR engine is wired, so a scanned PDF or image with no text layer is reported unsupported rather than guessed at.',
    // Only backends that were *observed* are claimed. The gate is the plugin's own boundary, not a
    // statement about the host: nothing is extracted unless a runner/service was injected.
    gating: 'nothing is extracted unless a backend was observed; this plugin runs no external extractor itself, '
      + 'so an unobserved backend is reported unsupported with its reason rather than attempted',
    // How the observation was made, so "unavailable" can be read as a result rather than a policy.
    probe: {
      attempted: capabilities.probe?.attempted === true,
      at: capabilities.probe?.at ?? null,
      reason: capabilities.probe?.reason ?? null,
      python: summarizeInterpreter(capabilities.python),
      ghostscript: summarizeGhostscript(capabilities.ghostscript),
    },
    ...(pdfText === null || officeUnobserved.length > 0
      ? { unobserved: [
        ...(pdfText === null ? ['pdf: no PDF text backend was observed (an injected runner providing PyMuPDF or Ghostscript txtwrite would enable it)'] : []),
        ...(officeUnobserved.length === Object.keys(OFFICE_MODULES).length
          ? ['office: no Python extractor runner was observed (python-docx / python-pptx / openpyxl)']
          : officeUnobserved),
      ] }
      : {}),
  }
}

/** A bounded description of the interpreter probe, or null when Python was never the answer. */
function summarizeInterpreter(python) {
  if (python === null || python === undefined) return null
  if (python.available !== true) {
    return {
      available: false,
      searched: Array.isArray(python.searched) ? python.searched.length : 0,
      reasons: Array.isArray(python.searched) ? python.searched.slice(0, 3).map((entry) => `${entry.source}: ${entry.reason}`) : [],
    }
  }
  return {
    available: true,
    path: python.path,
    source: python.source,
    version: python.version ?? null,
    has: Object.keys(python.modules ?? {}),
    missing: python.missing ?? [],
  }
}

/** A bounded description of the Ghostscript probe, or null when it was never needed. */
function summarizeGhostscript(ghostscript) {
  if (ghostscript === null || ghostscript === undefined) return null
  if (ghostscript.available !== true) {
    return {
      available: false,
      searched: Array.isArray(ghostscript.searched) ? ghostscript.searched.length : 0,
      reasons: Array.isArray(ghostscript.searched) ? ghostscript.searched.slice(0, 3).map((entry) => `${entry.source}: ${entry.reason}`) : [],
    }
  }
  return {
    available: true,
    path: ghostscript.path,
    source: ghostscript.source,
    version: ghostscript.version ?? null,
    txtwrite: ghostscript.txtwrite === true,
    structured: ghostscript.structured === true,
    ...(ghostscript.structuredReason === undefined ? {} : { structuredReason: ghostscript.structuredReason }),
  }
}
