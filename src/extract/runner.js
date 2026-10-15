/**
 * The production extraction runner (M8 follow-up).
 *
 * This is the module that turns "the plugin can read bytes" into "the plugin can extract a PDF
 * page, a slide and a worksheet". It is deliberately one module with three responsibilities, all
 * of which are about *reality* rather than about behaviour:
 *
 * 1. **Probe.** Every backend is discovered and then *executed* once, through the approved shell
 *    seam, before it is claimed. A candidate that exists but cannot import its library is reported
 *    unavailable with the reason it gave. Nothing is inferred from a file name or a version string.
 * 2. **Run.** One extraction = one argv built by `backend.js`, executed with a bounded timeout and
 *    a bounded capture, and classified into exactly one of: extracted, truncated, empty,
 *    unsupported (encrypted / no text layer / no backend), or failed (timeout / cancelled /
 *    parse error). A partial read is never promoted to a success.
 * 3. **Report.** The capability map this module maintains is the same object diagnostics and
 *    `professor_extract` read, so the report can only ever describe something that ran.
 *
 * Boundaries that hold unconditionally:
 *
 * - the source document is opened **read-only** by a process that is told to never write
 *   (`-dSAFER` for Ghostscript; an explicitly read-only library call for Office);
 * - every path is validated against the caller's read policy *before* a process is started, and
 *   the argv is quoted rather than interpolated;
 * - **no OCR engine is wired**, so a page with no text layer is `unsupported`, never guessed at;
 * - `render()` produces **pixels only**: it rasterises a bounded page range in memory and returns
 *   bytes. It reads nothing, interprets nothing, and never lets this module claim that anything
 *   was *visually inspected* — that claim belongs to whoever looked at the image.
 *
 * @module dsh-professor-spike/src/extract/runner
 */

import path from 'node:path'

import { MAX_TEXT_BYTES } from './extract.js'
import {
  buildGhostscriptPlan, buildOfficePlan, buildPymupdfPlan, buildRenderPlan, classifiedReason,
  parseGhostscriptStructured, readOfficeResult, readPymupdfResult, readRenderResult,
} from './backend.js'
import { noOfficeBackendReason, officeFormatAvailable } from './capabilities.js'
import {
  OFFICE_MODULES, OFFICE_MODULE_LIST, OFFICE_SCRIPT, PDF_MODULES, PDF_SCRIPT, PROBE_SCRIPT,
  RENDER_SCRIPT, existingCandidates, firstLine, ghostscriptCandidates, hasTxtwriteDevice,
  parseGhostscriptVersion, parsePythonProbe, pythonCandidates,
} from './runtime.js'

/** Deadline for one probe execution; a hung interpreter must not stall diagnostics. */
export const PROBE_TIMEOUT_MS = 20_000
/** Deadline for one PDF extraction. */
export const PDF_TIMEOUT_MS = 60_000
/** Deadline for one Office extraction; a large workbook is still bounded. */
export const OFFICE_TIMEOUT_MS = 60_000
/** Deadline for one bounded page-render call. */
export const RENDER_TIMEOUT_MS = 60_000
/** Bound on the text a single extraction may produce, mirrored by the backend scripts. */
export const MAX_EXTRACT_BYTES = MAX_TEXT_BYTES
/** Bytes captured from a backend's stdout; the JSON envelope has to fit inside it. */
export const EXTRACT_CAPTURE_BYTES = MAX_EXTRACT_BYTES + 512 * 1024
/**
 * Bytes captured from the render script's stdout.
 *
 * The renderer prints base64, which is 4/3 of the encoded payload, so this is sized from the
 * render byte budget rather than from the text cap — a truncated JSON envelope would otherwise be
 * misread as a backend failure instead of as "you asked for too many pages at once".
 */
export const RENDER_CAPTURE_BYTES = 3 * 1024 * 1024
/** Upper bound on pages taken from one PDF. */
export const MAX_PDF_PAGES = 2000
/**
 * Upper bound on interpreters probed per plugin instance.
 *
 * Probing now *continues* past an interpreter that merely runs the probe, until one actually has
 * the libraries a task needs, so this cap is a cost bound rather than a "first responder wins"
 * rule. Four is enough for the documented candidate order to reach a host `PATH` interpreter.
 */
export const MAX_PROBED_INTERPRETERS = 4

/** Bounds applied to an XLSX read, so a huge workbook is reported truncated rather than read. */
export const DEFAULT_OFFICE_LIMITS = {
  maxChars: MAX_EXTRACT_BYTES,
  maxSheets: 24,
  maxRows: 2000,
  maxCols: 64,
  maxCells: 20000,
}

/**
 * A hermetic capability self-test for Ghostscript's structured output.
 *
 * It renders nothing and reads no file: it asks Ghostscript to run a one-line PostScript program
 * that paints a blank page, and observes whether the `txtwrite` device answered in its structured
 * (`<page>`-bearing) form. That is an observation about the installed build, not an assumption
 * from a version number.
 */
export const GHOSTSCRIPT_STRUCTURED_PROBE = [
  '-q', '-dBATCH', '-dNOPAUSE', '-dSAFER',
  '-sDEVICE=txtwrite', '-dTextFormat=1', '-sOutputFile=-',
  '-c', '<</PageSize [612 792]>> setpagedevice showpage',
]

function unsupported(reason, extra = {}) {
  return { status: 'unsupported', reason, extractor: null, ...extra }
}

function failed(reason, extra = {}) {
  return { status: 'failed', reason, ...extra }
}

/** Classify a shell outcome that never reached the backend's own JSON. */
function shellFailure(result, backend) {
  if (result?.runnerFailed === true) {
    return failed(`${backend} could not be started: ${result.reason}`)
  }
  if (result?.timedOut === true) {
    return failed(`${backend} timed out after ${result.timeoutMs ?? '?'}ms and was stopped`)
  }
  if (result?.aborted === true || (result?.signal !== null && result?.signal !== undefined)) {
    return failed(`${backend} was cancelled before it finished`)
  }
  if (result?.stdoutTruncated === true || result?.stderrTruncated === true) {
    return failed(`${backend} produced more output than the ${EXTRACT_CAPTURE_BYTES}-byte capture cap; the result cannot be trusted`)
  }
  if (result?.sandbox?.denied === true) {
    return failed(`${backend} was denied by the sandbox (${result.sandbox.mode ?? 'unknown mode'})`)
  }
  return null
}

function normalizePages(rawPages) {
  return rawPages
    .map((entry) => ({
      page: Number.isInteger(entry.page) ? entry.page : null,
      slide: Number.isInteger(entry.slide) ? entry.slide : null,
      text: String(entry.text ?? ''),
      ...(Array.isArray(entry.visual_features) ? { visual_features: entry.visual_features } : {}),
    }))
    .filter((entry) => entry.page !== null || entry.slide !== null)
}

/**
 * Build the extraction service.
 *
 * @param options.shellRun - the shell seam adapter (`createShellRunner`), or `undefined`.
 * @param options.pluginRoot - this package's directory (locates the bundled scripts).
 * @param options.env - environment (defaults to `process.env`).
 * @param options.logger - plugin logger.
 * @param options.resourcesPath - `process.resourcesPath` when running inside the app.
 * @param options.homedir - home directory (tests).
 * @param options.pathDirs - `PATH` entries (tests).
 * @param options.isFile - injectable executable probe (tests).
 * @param options.includeSpeakerNotes - include PPTX speaker notes in extracted text (default false).
 * @param options.limits - Office bounds overrides.
 * @param options.timeouts - `{ probe, pdf, office }` overrides.
 * @param options.capabilities - an existing capability object to fill in (defaults to a new one).
 * @returns `{ capabilities, ensureProbed, run, probeState, scriptPaths }`.
 */
export function createExtractionService(options = {}) {
  const {
    shellRun,
    pluginRoot,
    env = process.env,
    logger,
    resourcesPath,
    homedir,
    pathDirs,
    isFile,
    includeSpeakerNotes = false,
    limits = {},
    timeouts = {},
    capabilities = {},
  } = options

  const scriptPaths = {
    probe: path.join(pluginRoot, PROBE_SCRIPT),
    pdf: path.join(pluginRoot, PDF_SCRIPT),
    office: path.join(pluginRoot, OFFICE_SCRIPT),
    render: path.join(pluginRoot, RENDER_SCRIPT),
  }
  const officeLimits = { ...DEFAULT_OFFICE_LIMITS, ...limits }
  const probeTimeoutMs = timeouts.probe ?? PROBE_TIMEOUT_MS
  const pdfTimeoutMs = timeouts.pdf ?? PDF_TIMEOUT_MS
  const officeTimeoutMs = timeouts.office ?? OFFICE_TIMEOUT_MS
  const renderTimeoutMs = timeouts.render ?? RENDER_TIMEOUT_MS

  // Live capability object: diagnostics and the extract tool read this same reference, so a probe
  // result can only ever describe something that actually ran.
  capabilities.probe = { attempted: false, at: null, reason: null, tried: [] }
  capabilities.python = null
  capabilities.ghostscript = null
  capabilities.pdfText ??= null
  capabilities.pdfBackend ??= null
  capabilities.pdfPages ??= null
  capabilities.pdfPageCoordinates ??= null
  capabilities.pdfInterpreter ??= null
  capabilities.officeInterpreter ??= null
  capabilities.bootstrapInterpreter ??= null
  capabilities.render ??= null
  capabilities.officePython ??= false
  capabilities.officeModules ??= {}
  capabilities.slideCoordinates ??= null

  const state = { probePromise: null, probed: false }

  const shellAvailable = typeof shellRun === 'function'

  /** Whether a probe report shows an interpreter that can run `extract_pdf.py` / `render_pages.py`. */
  const probeHasPdf = (probe) => PDF_MODULES.some((name) => typeof probe?.modules?.[name] === 'string')
  /** Whether a probe report shows an interpreter that can run `extract_office.py`. */
  const probeHasOffice = (probe) => OFFICE_MODULE_LIST.every((name) => typeof probe?.modules?.[name] === 'string')

  /**
   * Probe candidate interpreters, keeping every one that actually answered.
   *
   * Selection used to stop at the first interpreter that merely *ran* the probe — which, on a
   * machine where the Harness payload ships Office libraries but no PyMuPDF, meant the payload
   * won and PDF text extraction reported "no backend" even though a perfectly good interpreter sat
   * one rank later on `PATH`. The probe now keeps going until one candidate covers PDF work and
   * another covers Office work (or the candidates run out), so each job gets an interpreter that
   * can do it. Nothing is claimed from a file name: a candidate still has to import the library.
   *
   * @returns `{ probed: [{ candidate, probe }], tried: [{ path, source, reason }] }`.
   */
  async function probeInterpreters(signal) {
    const candidates = existingCandidates(
      pythonCandidates({ env, resourcesPath, homedir, pathDirs }),
      { isFile },
    )
    const tried = []
    const probed = []
    for (const candidate of candidates.slice(0, MAX_PROBED_INTERPRETERS)) {
      const result = await shellRun({
        command: candidate.path,
        args: [scriptPaths.probe],
        timeoutMs: probeTimeoutMs,
        signal,
      })
      const failure = shellFailure(result, `python (${candidate.source})`)
      if (failure !== null) {
        tried.push({ path: candidate.path, source: candidate.source, reason: failure.reason })
        continue
      }
      const probe = parsePythonProbe(result.stdout)
      if (probe === null) {
        tried.push({ path: candidate.path, source: candidate.source, reason: 'the interpreter did not return a probe report' })
        continue
      }
      probed.push({ candidate, probe })
      if (probeHasPdf(probe) && probeHasOffice(probe)
        && probed.some(entry => /^3\.12(?:\.|\s|$)/.test(entry.probe.python ?? ''))) break
    }
    return { probed, tried }
  }

  /** Probe Ghostscript: version, device list, and one real structured-output run. */
  async function probeGhostscript(signal) {
    const candidates = existingCandidates(
      ghostscriptCandidates({ env, pathDirs }),
      { isFile },
    )
    const tried = []
    for (const candidate of candidates.slice(0, MAX_PROBED_INTERPRETERS)) {
      const versionRun = await shellRun({ command: candidate.path, args: ['--version'], timeoutMs: probeTimeoutMs, signal })
      const versionFailure = shellFailure(versionRun, 'ghostscript')
      if (versionFailure !== null) {
        tried.push({ path: candidate.path, source: candidate.source, reason: versionFailure.reason })
        continue
      }
      const version = parseGhostscriptVersion(versionRun.stdout) ?? firstLine(versionRun.stdout) ?? null
      if (version === null) {
        tried.push({ path: candidate.path, source: candidate.source, reason: 'ghostscript did not report a version' })
        continue
      }

      const helpRun = await shellRun({ command: candidate.path, args: ['-h'], timeoutMs: probeTimeoutMs, signal })
      // `gs -h` writes the banner and device list to stdout; accept stderr too, since some builds
      // split them, but never invent a device that was not named.
      const txtwrite = hasTxtwriteDevice(`${helpRun?.stdout ?? ''}\n${helpRun?.stderr ?? ''}`)

      const structuredRun = await shellRun({
        command: candidate.path,
        args: GHOSTSCRIPT_STRUCTURED_PROBE,
        timeoutMs: probeTimeoutMs,
        signal,
      })
      const structured = /<page>/.test(String(structuredRun?.stdout ?? ''))

      if (!txtwrite) {
        tried.push({ path: candidate.path, source: candidate.source, reason: 'this build has no txtwrite device' })
        continue
      }
      return {
        candidate,
        probe: { version, txtwrite, structured, structuredReason: structured ? null : 'the build answered in plain text rather than structured markup' },
        tried,
      }
    }
    return { candidate: null, probe: null, tried }
  }

  /**
   * Probe every backend once and record only what was observed.
   *
   * Called lazily — never at plugin apply — so a session that never extracts pays nothing, and the
   * boot path never spawns a process.
   */
  async function probeNow(signal) {
    capabilities.probe.attempted = true
    capabilities.probe.at = null
    const tried = []
    if (!shellAvailable) {
      capabilities.probe.reason = 'the Harness shell seam (ctx.shell) is not available in this context, '
        + 'so no external extraction backend could be executed or claimed'
      capabilities.probe.tried = tried
      logger?.info?.('extraction backends not probed: no shell seam in this context')
      return capabilities
    }

    const python = await probeInterpreters(signal)
    tried.push(...python.tried)
    const answered = python.probed
    capabilities.bootstrapInterpreter = answered.find(entry => /^3\.12(?:\.|\s|$)/.test(entry.probe.python ?? ''))?.candidate.path ?? null
    // One interpreter per job, chosen by what it can actually import — never by rank alone.
    const pdfMatch = answered.find((entry) => probeHasPdf(entry.probe))
    const officeMatch = answered.find((entry) => probeHasOffice(entry.probe))
    const chosen = pdfMatch ?? officeMatch ?? answered[0] ?? null

    if (chosen !== null) {
      const modules = chosen.probe.modules ?? {}
      capabilities.python = {
        available: true,
        path: chosen.candidate.path,
        source: chosen.candidate.source,
        version: chosen.probe.python,
        modules,
        missing: chosen.probe.missing,
        // Which job this interpreter was selected for, so a report never implies it does both.
        selectedFor: pdfMatch === chosen ? 'pdf' : officeMatch === chosen ? 'office' : 'fallback',
      }
      capabilities.pdfInterpreter = pdfMatch === undefined ? null : pdfMatch.candidate.path
      capabilities.officeInterpreter = officeMatch === undefined ? null : officeMatch.candidate.path
      // Rendering needs the same library as PDF text, so it is gated on the PDF interpreter —
      // a Ghostscript-only machine can still extract text but cannot rasterise a page.
      capabilities.render = capabilities.pdfInterpreter === null ? null : 'pymupdf'

      const pdfModules = (pdfMatch ?? chosen).probe.modules ?? {}
      capabilities.pdfText = typeof pdfModules.fitz === 'string' ? 'fitz' : null
      capabilities.pdfBackend = typeof pdfModules.fitz === 'string' ? 'pymupdf' : null
      capabilities.pdfPages = capabilities.pdfBackend
      // Our own page-indexed script produces one entry per page, so page coordinates are a
      // property of the backend we would run, not a hope about the document.
      capabilities.pdfPageCoordinates = capabilities.pdfBackend === null ? null : true

      const officeModules = (officeMatch ?? chosen).probe.modules ?? {}
      capabilities.officeModules = Object.fromEntries(
        Object.entries(OFFICE_MODULES).map(([format, module]) => [format, typeof officeModules[module] === 'string']),
      )
      capabilities.officePython = officeMatch !== undefined
        && Object.values(capabilities.officeModules).every(Boolean)
      capabilities.slideCoordinates = capabilities.officeModules.pptx === true
    } else {
      capabilities.python = {
        available: false,
        searched: python.tried.map((entry) => ({ path: entry.path, source: entry.source, reason: entry.reason })),
      }
      capabilities.pdfInterpreter = null
      capabilities.officeInterpreter = null
      capabilities.render = null
      if (python.tried.length > 0) {
        capabilities.probe.reason = `no usable Python interpreter was found (${python.tried.length} candidate(s) rejected)`
      }
    }

    if (capabilities.pdfBackend === null) {
      const gs = await probeGhostscript(signal)
      tried.push(...gs.tried)
      if (gs.candidate !== null) {
        capabilities.ghostscript = {
          available: true,
          path: gs.candidate.path,
          source: gs.candidate.source,
          version: gs.probe.version,
          txtwrite: gs.probe.txtwrite,
          structured: gs.probe.structured,
          ...(gs.probe.structuredReason === null ? {} : { structuredReason: gs.probe.structuredReason }),
        }
        capabilities.pdfText = 'ghostscript'
        capabilities.pdfBackend = 'ghostscript'
        capabilities.pdfPages = capabilities.pdfBackend
        capabilities.pdfPageCoordinates = gs.probe.structured
      } else {
        capabilities.ghostscript = {
          available: false,
          searched: gs.tried.map((entry) => ({ path: entry.path, source: entry.source, reason: entry.reason })),
        }
        capabilities.pdfText = null
        capabilities.pdfBackend = null
        capabilities.pdfPages = null
        capabilities.pdfPageCoordinates = null
      }
    }

    capabilities.probe.tried = tried
    if (capabilities.probe.reason === null) {
      capabilities.probe.reason = capabilities.pdfBackend === null && capabilities.officePython !== true
        ? 'no extraction backend responded to a real probe on this machine'
        : null
    }
    capabilities.probe.at = new Date().toISOString()
    logger?.info?.(
      `extraction backends: pdf=${capabilities.pdfBackend ?? 'none'}`
      + ` office=${capabilities.officePython ? 'bundled-python' : 'none'}`
      + ` render=${capabilities.render ?? 'none'}`
      + ` (pdf=${capabilities.pdfInterpreter ?? 'none'} office=${capabilities.officeInterpreter ?? 'none'})`,
    )
    return capabilities
  }

  /** Memoized probe: one execution per plugin instance, shared by diagnostics and extraction. */
  async function ensureProbed(signal) {
    if (state.probed) return capabilities
    if (state.probePromise === null) {
      state.probePromise = probeNow(signal).catch((error) => {
        capabilities.probe.reason = `probing failed: ${error.message}`
        logger?.warn?.(`extraction probe failed: ${error.message}`)
        return capabilities
      }).finally(() => {
        state.probed = true
      })
    }
    return state.probePromise
  }

  /** Extract a PDF through whichever backend was observed. */
  async function extractPdf({ sourcePath, signal }) {
    const backend = capabilities.pdfBackend
    if (backend === null) {
      return unsupported(
        'no PDF text backend was observed in this runtime (a bundled Python with PyMuPDF, or Ghostscript with the txtwrite device, would enable it); OCR is disabled by design',
      )
    }

    const planSpec = backend === 'pymupdf'
      ? buildPymupdfPlan({
        // The interpreter selected *for PDF work*, not merely the first one that answered the
        // probe: on a machine where the payload has no PyMuPDF those are different paths.
        python: capabilities.pdfInterpreter ?? capabilities.python.path,
        scriptPath: scriptPaths.pdf,
        sourcePath,
        maxPages: MAX_PDF_PAGES,
        maxChars: MAX_EXTRACT_BYTES,
      })
      : buildGhostscriptPlan({ binary: capabilities.ghostscript.path, sourcePath, maxPages: MAX_PDF_PAGES })

    const result = await shellRun({
      command: planSpec.argv[0],
      args: planSpec.argv.slice(1),
      timeoutMs: pdfTimeoutMs,
      stdoutMaxBytes: EXTRACT_CAPTURE_BYTES,
      captureBytes: EXTRACT_CAPTURE_BYTES,
      signal,
    })
    const failure = shellFailure(result, backend)
    if (failure !== null) return failure

    if (backend === 'pymupdf') {
      const parsed = readPymupdfResult(result.stdout)
      if (!parsed.ok) {
        if (parsed.error === 'unavailable' || parsed.error === 'encrypted') {
          return unsupported(`PyMuPDF cannot read this PDF: ${parsed.detail}`)
        }
        return failed(`the PDF backend could not parse this document: ${parsed.detail}`)
      }
      const pages = normalizePages(parsed.pages)
      const text = pages.map((page) => page.text).join('\n')
      if (text.trim().length === 0) {
        return unsupported('the PDF has no text layer on any page (a scanned document); OCR is disabled by design, so nothing was extracted rather than guessed', { pages })
      }
      capabilities.pdfPageCoordinates = true
      return {
        status: 'extracted',
        extractor: 'pdf-fitz',
        text,
        pages,
        bytes: text.length,
        notes: parsed.notes,
      }
    }

    const structured = parseGhostscriptStructured(result.stdout)
    if (structured.structured) {
      const pages = normalizePages(structured.pages)
      const text = pages.map((page) => page.text).join('\n')
      if (text.trim().length === 0) {
        return unsupported('the PDF has no text layer on any page (a scanned document); OCR is disabled by design, so nothing was extracted rather than guessed')
      }
      capabilities.pdfPageCoordinates = true
      return {
        status: 'extracted',
        extractor: 'pdf-ghostscript',
        text,
        pages,
        bytes: text.length,
      }
    }

    // Unstructured fallback: an older build that answered in plain text. Text is still worth
    // having, but the page coordinate is *unknown*, so it is omitted rather than approximated.
    const plain = String(result.stdout ?? '').replace(/\r\n?/g, '\n').trim()
    if (result.exitCode !== 0 && plain.length === 0) {
      return failed(`Ghostscript could not read this PDF (exit ${result.exitCode}): ${firstLine(result.stderr) ?? 'no diagnostic'}`)
    }
    if (plain.length === 0) {
      return unsupported('the PDF has no text layer on any page (a scanned document); OCR is disabled by design, so nothing was extracted rather than guessed')
    }
    capabilities.pdfPageCoordinates = false
    return {
      status: 'extracted',
      extractor: 'pdf-ghostscript',
      text: plain,
      pages: null,
      bytes: plain.length,
      notes: ['ghostscript answered in plain text, so page numbers are not available for this document'],
    }
  }

  /** Extract a DOCX, PPTX or XLSX through the bundled interpreter. */
  async function extractOffice({ extension, sourcePath, signal }) {
    // Gated per format: an interpreter with python-docx but no python-pptx can read a DOCX, and
    // saying otherwise would report a capability as missing that was actually observed.
    if (officeFormatAvailable(capabilities, extension) !== true) {
      return unsupported(noOfficeBackendReason(extension))
    }
    const format = extension
    const planSpec = buildOfficePlan({
      python: capabilities.officeInterpreter ?? capabilities.python.path,
      scriptPath: scriptPaths.office,
      format,
      sourcePath,
      limits: officeLimits,
      includeNotes: includeSpeakerNotes === true && format === 'pptx',
    })
    const result = await shellRun({
      command: planSpec.argv[0],
      args: planSpec.argv.slice(1),
      timeoutMs: officeTimeoutMs,
      stdoutMaxBytes: EXTRACT_CAPTURE_BYTES,
      captureBytes: EXTRACT_CAPTURE_BYTES,
      signal,
    })
    const failure = shellFailure(result, 'office-python')
    if (failure !== null) return failure

    const parsed = readOfficeResult(result.stdout)
    if (!parsed.ok) {
      const reason = classifiedReason(parsed.error, parsed.detail, 'the Office backend')
      return parsed.error === 'encrypted' || parsed.error === 'unavailable'
        ? unsupported(reason)
        : failed(reason)
    }

    const units = parsed.units
    const truncation = (parsed.notes ?? []).filter((note) => /cap|exceeded/i.test(note))
    // Build the document text so that each unit's own block appears verbatim inside it; that is
    // what lets the chunker map a chunk back onto a slide number instead of guessing one.
    const segments = units
      .map((unit) => ({ ...unit, block: renderUnit(unit, format) }))
      .filter((segment) => segment.block.trim().length > 0)
    const text = segments.map((segment) => segment.block).join('\n\n')

    if (text.trim().length === 0) {
      return unsupported(`${format}: the document opened but carries no text content (an empty or image-only document); no OCR ran`)
    }

    // Only a format that really has the coordinate publishes one. DOCX has no page numbers without
    // rendering and XLSX has sheets (carried by the heading), so neither invents a page.
    const pages = format === 'pptx'
      ? normalizePages(segments.map((segment) => ({ slide: segment.index, page: null, text: segment.block })))
      : null
    if (format === 'pptx') capabilities.slideCoordinates = true

    return {
      status: 'extracted',
      extractor: `office-${format}`,
      text,
      pages,
      truncated: truncation,
      bytes: text.length,
      notes: parsed.notes,
    }
  }

  /**
   * Rasterise a bounded physical page range into in-memory JPEG bytes.
   *
   * This is the visual counterpart of `extractPdf` and is deliberately narrow: a page range, a
   * long-edge bound, a quality and a total byte budget, all enforced by the script as well as by
   * the caller. Nothing is written anywhere — the script prints base64, this parses it, and the
   * caller decides whether the bytes ever reach an attachment service.
   *
   * @param options.sourcePath - canonical PDF path (read policy is checked by the caller).
   * @returns an outcome: `{ status: 'rendered', pages, truncated, ... }`, `unsupported` or `failed`.
   */
  async function renderPageImages(options = {}) {
    const {
      sourcePath, pages, from, to, maxSide, quality, maxTotalBytes, signal,
    } = options
    if (!shellAvailable) {
      return unsupported('the Harness shell seam (ctx.shell) is not available in this context, so no page can be rendered')
    }
    if (capabilities.render !== 'pymupdf' || capabilities.pdfInterpreter === null) {
      return unsupported(
        'page rendering needs an interpreter that imports PyMuPDF; none was observed in this runtime '
        + '(set DSH_PROFESSOR_PYTHON to an interpreter that has PyMuPDF, or install PyMuPDF for the '
        + 'interpreter this plugin discovered)',
      )
    }
    const planSpec = buildRenderPlan({
      python: capabilities.pdfInterpreter,
      scriptPath: scriptPaths.render,
      sourcePath,
      // An explicit page list wins over a range: exactly the pages the caller asked for, in
      // ascending order, with nothing rendered in between them.
      ...(Array.isArray(pages) && pages.length > 0 ? { pages } : { from, to }),
      maxSide,
      quality,
      maxTotalBytes,
    })
    const result = await shellRun({
      command: planSpec.argv[0],
      args: planSpec.argv.slice(1),
      timeoutMs: renderTimeoutMs,
      stdoutMaxBytes: RENDER_CAPTURE_BYTES,
      captureBytes: RENDER_CAPTURE_BYTES,
      signal,
    })
    const failure = shellFailure(result, 'pymupdf-render')
    if (failure !== null) return failure

    const parsed = readRenderResult(result.stdout)
    if (!parsed.ok) {
      const reason = classifiedReason(parsed.error, parsed.detail, 'the render backend')
      return parsed.error === 'encrypted' || parsed.error === 'unavailable'
        ? unsupported(reason)
        : failed(reason)
    }
    return {
      status: 'rendered',
      extractor: 'pymupdf-render',
      pages: parsed.pages,
      truncated: parsed.truncated === true,
      totalPages: parsed.totalPages,
      bytes: parsed.pages.reduce((sum, page) => sum + page.bytes, 0),
      notes: parsed.notes,
    }
  }

  /**
   * Render pages, with the same read gate every extraction gets: the source must be inside the
   * caller's approved read roots *before* a process is started on it.
   *
   * @param spec - `{ target, pages?, from?, to?, maxSide, quality, maxTotalBytes, signal }`.
   *   `pages` is an explicit list and takes precedence over `from`/`to`.
   * @param readPolicy - the caller's read policy.
   */
  async function render(spec, readPolicy) {
    const {
      target, pages, from, to, maxSide, quality, maxTotalBytes, signal, spelling,
    } = spec ?? {}
    if (!shellAvailable) {
      return unsupported('the Harness shell seam (ctx.shell) is not available in this context, so no page can be rendered')
    }
    await ensureProbed(signal)
    const sourcePath = typeof target?.targetKey === 'string'
      ? target.targetKey
      : (typeof target?.displayPath === 'string' ? target.displayPath : null)
    if (sourcePath === null || sourcePath.length === 0) {
      return failed('the source path could not be resolved to a real file')
    }
    if (readPolicy !== undefined && typeof readPolicy.assert === 'function') {
      try {
        readPolicy.assert(typeof spelling === 'string' && spelling.length > 0 ? spelling : sourcePath, sourcePath)
      } catch (error) {
        return failed(`the source file is outside the approved read roots: ${error.message}`)
      }
    }
    return renderPageImages({ sourcePath, pages, from, to, maxSide, quality, maxTotalBytes, signal })
  }

  /**
   * Run one extraction.
   *
   * @param spec.plan - the plan from `planExtraction`.
   * @param spec.target - the resolved Harness target of the source file.
   * @param spec.extension - lower-case extension.
   * @param spec.spelling - the caller's spelling of the path (traversal checking).
   * @param spec.signal - cancellation.
   * @param readPolicy - the caller's read policy; the source must be inside it.
   * @returns an `extractFile` outcome.
   */
  async function run(spec, readPolicy) {
    const { plan, target, extension, signal, spelling } = spec ?? {}
    if (!shellAvailable) {
      return unsupported('no command runner available for this format in this context')
    }
    await ensureProbed(signal)

    const sourcePath = typeof target?.targetKey === 'string'
      ? target.targetKey
      : (typeof target?.displayPath === 'string' ? target.displayPath : null)
    if (sourcePath === null || sourcePath.length === 0) {
      return failed('the source path could not be resolved to a real file')
    }

    // The read gate runs before any process starts, so a path outside the approved read roots — or
    // one spelled with `..` — is refused without ever reaching a backend.
    if (readPolicy !== undefined && typeof readPolicy.assert === 'function') {
      try {
        readPolicy.assert(typeof spelling === 'string' && spelling.length > 0 ? spelling : sourcePath, sourcePath)
      } catch (error) {
        return failed(`the source file is outside the approved read roots: ${error.message}`)
      }
    }

    const family = plan?.family
    if (family === 'pdf') return extractPdf({ sourcePath, signal })
    if (family === 'office') return extractOffice({ extension, sourcePath, signal })
    return unsupported(`no extraction runner is wired for the "${family ?? 'unknown'}" format family`)
  }

  return {
    capabilities,
    ensureProbed,
    run,
    render,
    scriptPaths,
    /** For tests and diagnostics: whether a probe has completed. */
    get probeState() {
      return { ...capabilities.probe, completed: state.probed }
    },
  }
}

/**
 * Render one Office unit as the block that appears in the combined document text.
 *
 * The heading is part of the block on purpose: the chunker splits on headings, so every chunk
 * belonging to a slide or a sheet sits under a heading that names it, and the coordinate mapping
 * stays honest even when a slide's body is empty.
 */
export function renderUnit(unit, format) {
  if (format === 'pptx') {
    const title = unit.title ?? (unit.text.trim().length > 0 ? null : '(untitled)')
    const heading = `## Slide ${unit.index}${title === null ? '' : `: ${title}`}`
    const body = unit.text.trim()
    const notes = unit.notes === null || unit.notes === '' ? '' : `### Speaker notes\n\n${unit.notes}`
    return [heading, body, notes].filter((part) => part.length > 0).join('\n\n')
  }
  if (format === 'xlsx') {
    const heading = `## Sheet ${unit.index}: ${unit.title ?? '(unnamed)'}`
    const body = unit.text.trim()
    return [heading, body].filter((part) => part.length > 0).join('\n\n')
  }
  // docx: the extracted markdown already carries the document's own headings.
  return unit.text.trim()
}
