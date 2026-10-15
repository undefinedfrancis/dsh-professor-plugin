/**
 * Extraction backends: how a command is built, and how its output is read back (M8 follow-up).
 *
 * Everything here is pure: a function either turns arguments into an argv, or turns captured
 * stdout into a structured result. No process is spawned, no file is opened, so the whole backend
 * surface is testable against recorded output — which is how the contract tests cover a backend
 * that this machine does not have.
 *
 * Two rules the callers depend on:
 *
 * - **argv, never interpolated shell.** The Harness shell seam takes a command *string*
 *   (`ShellExecRequest.command`, verified against the installed build), so an argv is quoted into
 *   one with `argvToCommand`, which single-quotes every argument that is not provably inert. A
 *   value can therefore never be read as a second command however it was spelled;
 * - **no invented coordinates.** A backend that does not report pages returns `pages: null`, and
 *   the caller then omits the coordinate rather than guessing one.
 *
 * @module dsh-professor-spike/src/extract/backend
 */

/** Result states an Office extraction can end in. */
export const OFFICE_STATES = [
  'extracted', 'empty', 'truncated', 'encrypted', 'malformed', 'timeout', 'unavailable',
]

/** Characters that are safe in a shell word without quoting. */
const INERT = /^[A-Za-z0-9._/:@%+=,-]+$/

/**
 * Quote one argument for a POSIX shell.
 *
 * @param value - the argument.
 * @returns a single shell word that expands to exactly `value` and nothing else.
 * @throws {Error} `PROFESSOR_EXTRACT_ARGV_INVALID` for a NUL byte, which no shell word can carry.
 */
export function shellQuote(value) {
  const text = String(value)
  if (text.includes('\0')) {
    const error = new Error('an extraction argument contains a NUL byte')
    error.code = 'PROFESSOR_EXTRACT_ARGV_INVALID'
    throw error
  }
  if (text.length === 0) return "''"
  if (INERT.test(text)) return text
  return `'${text.replace(/'/g, "'\\''")}'`
}

/**
 * Turn an argv into a shell command line.
 *
 * @param argv - `[command, ...args]`.
 * @returns the quoted command line.
 * @throws {Error} `PROFESSOR_EXTRACT_ARGV_INVALID` when the argv is empty.
 */
export function argvToCommand(argv, { platform = process.platform } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    const error = new Error('an extraction command needs at least a program name')
    error.code = 'PROFESSOR_EXTRACT_ARGV_INVALID'
    throw error
  }
  if (platform === 'win32') {
    const words = argv.map(value => {
      const text = String(value)
      if (text.includes('\0') || /[\r\n]/.test(text)) {
        const error = new Error('a PowerShell argument contains an unsupported control character')
        error.code = 'PROFESSOR_EXTRACT_ARGV_INVALID'
        throw error
      }
      return `'${text.replace(/'/g, "''")}'`
    })
    return `& ${words.join(' ')}`
  }
  return argv.map(shellQuote).join(' ')
}

// --- Ghostscript (PDF text) --------------------------------------------------

/**
 * Build the Ghostscript text-extraction argv.
 *
 * `-dSAFER` blocks the PostScript program from opening or writing any file, `-dNOPAUSE -dBATCH`
 * make the run non-interactive, `-dTextFormat=1` selects the structured (`<page>`/`<line>`/`<char>`)
 * rendering, and `--` ends option parsing so a path can never be read as a flag. `-dFirstPage` /
 * `-dLastPage` bound the work; the text cap is enforced again on our side.
 *
 * @param options.binary - absolute `gs` path.
 * @param options.sourcePath - canonical path of the PDF (read-only).
 * @param options.maxPages - page bound (omitted when not a positive integer).
 * @param options.firstPage - 1-based first page (default 1).
 * @returns `{ argv, timeoutMs, backend: 'ghostscript', structured: true }`.
 */
export function buildGhostscriptPlan(options) {
  const { binary, sourcePath, maxPages, firstPage = 1 } = options
  const argv = [
    binary,
    '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
    '-sDEVICE=txtwrite',
    '-dTextFormat=1',
    '-sOutputFile=-',
  ]
  if (Number.isInteger(firstPage) && firstPage > 1) argv.push(`-dFirstPage=${firstPage}`)
  if (Number.isInteger(maxPages) && maxPages > 0) {
    argv.push(`-dLastPage=${firstPage + maxPages - 1}`)
  }
  argv.push('--', sourcePath)
  return { argv, backend: 'ghostscript', structured: true }
}

/** Decode the handful of character references Ghostscript's `txtwrite` markup emits. */
export function decodeMarkupText(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits) => safeCodePoint(Number.parseInt(digits, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function safeCodePoint(code) {
  if (!Number.isInteger(code) || code < 0 || code > 0x10FFFF) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * Read Ghostscript's `TextFormat=1` markup into one text block per page.
 *
 * @param stdout - captured stdout.
 * @returns `{ pages: { page, text }[], structured: true }`, or `{ pages: null, structured: false }`
 *   when the output carries no page markup at all (an older device, or a plain-text fallback).
 */
export function parseGhostscriptStructured(stdout) {
  const markup = String(stdout ?? '')
  const pages = []
  const pagePattern = /<page>([\s\S]*?)<\/page>/g
  let pageMatch
  while ((pageMatch = pagePattern.exec(markup)) !== null) {
    const body = pageMatch[1]
    const lines = []
    const linePattern = /<line>([\s\S]*?)<\/line>/g
    let lineMatch
    while ((lineMatch = linePattern.exec(body)) !== null) {
      let text = ''
      const charPattern = /<char\b[^>]*\bc="([^"]*)"[^>]*\/>/g
      let charMatch
      while ((charMatch = charPattern.exec(lineMatch[1])) !== null) text += decodeMarkupText(charMatch[1])
      lines.push(text)
    }
    pages.push({ page: pages.length + 1, text: lines.join('\n') })
  }
  if (pages.length === 0) return { pages: null, structured: false }
  return { pages, structured: true }
}

// --- Python-backed backends (PyMuPDF, Office) --------------------------------

/**
 * Build the PyMuPDF argv. The interpreter runs a script from this package, so the argv has three
 * inert-looking parts and exactly one document path.
 *
 * @returns `{ argv, backend: 'pymupdf', structured: true }`.
 */
export function buildPymupdfPlan(options) {
  const { python, scriptPath, sourcePath, maxPages, maxChars } = options
  const argv = [python, scriptPath, '--path', sourcePath]
  if (Number.isInteger(maxPages) && maxPages > 0) argv.push('--max-pages', String(maxPages))
  if (Number.isInteger(maxChars) && maxChars > 0) argv.push('--max-chars', String(maxChars))
  return { argv, backend: 'pymupdf', structured: true }
}

/**
 * Build the Office argv.
 *
 * @param options.python - interpreter path.
 * @param options.scriptPath - `extract_office.py` path inside this package.
 * @param options.format - `docx` | `pptx` | `xlsx`.
 * @param options.sourcePath - canonical document path (opened read-only by the script).
 * @param options.limits - `{ maxChars, maxSheets, maxRows, maxCols, maxCells }` overrides.
 * @param options.includeNotes - include PPTX speaker notes (default false: they are author-private).
 * @returns `{ argv, backend: 'office-python', structured: true }`.
 */
export function buildOfficePlan(options) {
  const { python, scriptPath, format, sourcePath, limits = {}, includeNotes = false } = options
  const argv = [python, scriptPath, '--format', format, '--path', sourcePath]
  for (const [flag, key] of [
    ['--max-chars', 'maxChars'], ['--max-sheets', 'maxSheets'], ['--max-rows', 'maxRows'],
    ['--max-cols', 'maxCols'], ['--max-cells', 'maxCells'],
  ]) {
    const value = limits[key]
    if (Number.isInteger(value) && value > 0) argv.push(flag, String(value))
  }
  // Off by default: speaker notes are not slide content, so including them is opt-in.
  if (includeNotes === true) argv.push('--include-notes')
  return { argv, backend: 'office-python', structured: true }
}

/**
 * Read one JSON object out of a backend's stdout.
 *
 * The scripts print exactly one line of JSON, but a probe or a warning could precede it, so the
 * object is located rather than assumed at offset 0.
 *
 * @param stdout - captured stdout.
 * @returns the parsed object, or `null` when stdout carries none.
 */
export function parseJsonObject(stdout) {
  const text = String(stdout ?? '').trim()
  if (text.length === 0) return null
  const start = text.indexOf('{')
  if (start < 0) return null
  const end = text.lastIndexOf('}')
  if (end < start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Normalise a PyMuPDF script result.
 *
 * @returns `{ ok: true, pages }` or `{ ok: false, error, detail }`.
 */
export function readPymupdfResult(stdout) {
  const parsed = parseJsonObject(stdout)
  if (parsed === null) return { ok: false, error: 'parse-failed', detail: 'the PDF backend produced no readable result' }
  if (parsed.ok !== true) {
    return { ok: false, error: String(parsed.error ?? 'failed'), detail: String(parsed.detail ?? '') }
  }
  const pages = (Array.isArray(parsed.pages) ? parsed.pages : [])
    .map((entry) => ({ page: Number(entry?.page), text: String(entry?.text ?? ''),
      ...(Array.isArray(entry?.visual_features) ? { visual_features: entry.visual_features.filter(value => ['embedded-image', 'vector-drawing'].includes(value)) } : {}),
    }))
    .filter((entry) => Number.isInteger(entry.page) && entry.page >= 1)
  return { ok: true, pages, notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [] }
}

/**
 * Normalise an Office script result.
 *
 * @returns `{ ok: true, units, notes }` or `{ ok: false, error, detail }`.
 */
export function readOfficeResult(stdout) {
  const parsed = parseJsonObject(stdout)
  if (parsed === null) return { ok: false, error: 'parse-failed', detail: 'the Office backend produced no readable result' }
  if (parsed.ok !== true) {
    return { ok: false, error: String(parsed.error ?? 'failed'), detail: String(parsed.detail ?? '') }
  }
  const units = (Array.isArray(parsed.units) ? parsed.units : []).map((entry) => ({
    kind: String(entry?.kind ?? 'unknown'),
    index: Number(entry?.index),
    title: entry?.title === null || entry?.title === undefined ? null : String(entry.title),
    text: String(entry?.text ?? ''),
    notes: entry?.notes === undefined ? null : String(entry.notes),
  })).filter((entry) => Number.isInteger(entry.index) && entry.index >= 1)
  return { ok: true, units, notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [] }
}

/**
 * Build the page-render argv.
 *
 * Rendering is a *separate* script from text extraction on purpose: it must never write a file,
 * so the script rasterises in memory and prints base64, and the caller is given the byte budget
 * it must stay inside (`--max-total-bytes`) rather than discovering a capture cap afterwards.
 *
 * @param options.python - interpreter path (must be one that imports PyMuPDF).
 * @param options.scriptPath - `render_pages.py` path inside this package.
 * @param options.sourcePath - canonical PDF path (opened read-only by the script).
 * @param options.pages - explicit 1-based physical page numbers (ascending, de-duplicated). When
 *   present this is what gets rendered, and `from`/`to` are ignored: a request for pages 1 and 10
 *   must not become a capped 1-4 that drops 10 and spends the byte budget on pages 2-9.
 * @param options.from / options.to - inclusive 1-based physical page range (legacy form).
 * @param options.maxSide - long-edge bound in pixels.
 * @param options.quality - JPEG quality.
 * @param options.maxTotalBytes - total encoded bytes the output may contain.
 * @returns `{ argv, backend: 'pymupdf-render' }`.
 */
export function buildRenderPlan(options) {
  const {
    python, scriptPath, sourcePath, pages, from, to, maxSide, quality, maxTotalBytes,
  } = options
  const argv = [python, scriptPath, '--path', sourcePath]
  const explicit = Array.isArray(pages)
    ? [...new Set(pages.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 1))]
      .sort((left, right) => left - right)
    : []
  if (explicit.length > 0) {
    argv.push('--pages', explicit.join(','))
  } else {
    argv.push(
      '--from', String(Math.max(1, Number(from) || 1)),
      '--to', String(Math.max(1, Number(to) || 1)),
    )
  }
  argv.push(
    '--max-side', String(Math.max(64, Number(maxSide) || 1600)),
    '--quality', String(Math.min(95, Math.max(1, Number(quality) || 80))),
    '--max-total-bytes', String(Math.max(1024, Number(maxTotalBytes) || 2 * 1024 * 1024)),
  )
  return { argv, backend: 'pymupdf-render' }
}

/**
 * Normalise a page-render result.
 *
 * `data` stays a `Buffer` here: the renderer output is decoded once, at this boundary, and the
 * tool decides whether it is ever handed to an attachment service.
 *
 * @returns `{ ok: true, pages, truncated }` or `{ ok: false, error, detail }`.
 */
export function readRenderResult(stdout) {
  const parsed = parseJsonObject(stdout)
  if (parsed === null) return { ok: false, error: 'parse-failed', detail: 'the render backend produced no readable result' }
  if (parsed.ok !== true) {
    return { ok: false, error: String(parsed.error ?? 'failed'), detail: String(parsed.detail ?? '') }
  }
  const pages = (Array.isArray(parsed.pages) ? parsed.pages : [])
    .map((entry) => {
      const page = Number(entry?.page)
      const data = typeof entry?.b64 === 'string' ? Buffer.from(entry.b64, 'base64') : null
      return {
        page,
        width: Number(entry?.width),
        height: Number(entry?.height),
        bytes: data === null ? 0 : data.byteLength,
        data,
      }
    })
    .filter((entry) => Number.isInteger(entry.page) && entry.page >= 1 && entry.data !== null && entry.data.byteLength > 0)
  return {
    ok: true,
    pages,
    truncated: parsed.truncated === true,
    totalPages: Number.isInteger(parsed.total_pages) ? parsed.total_pages : null,
    notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [],
  }
}

/** Map a backend error token onto the plugin's own vocabulary. */
export function classifiedReason(error, detail, backend) {
  const suffix = detail && detail.length > 0 ? `: ${detail}` : ''
  switch (error) {
    case 'encrypted':
      return `unsupported: the document is encrypted or password-protected${suffix}`
    case 'unavailable':
      return `${backend} is unavailable in the selected runtime${suffix}`
    case 'too-large':
      return `the extracted content exceeded the configured cap${suffix}`
    case 'parse-failed':
      return `the ${backend} output could not be parsed${suffix}`
    default:
      return `the ${backend} backend reported a parsing failure${suffix}`
  }
}
