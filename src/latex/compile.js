/**
 * LaTeX compilation with an honest verdict (M11, v3 §9.6).
 *
 * The verdict vocabulary is deliberately explicit, because the design forbids claiming more than
 * was observed:
 *
 * | verdict | meaning |
 * |---|---|
 * | `source_generated` | the source exists but no compilation was attempted (no runner, or the static pre-checks / preflight blocked it) |
 * | `compiler_unavailable` | the probe found no TeX engine (its search list is reported in `warnings`) |
 * | `compilation_failed` | a compile ran and did not produce a PDF |
 * | `compilation_succeeded` | a compile ran, exited 0, and the PDF was found on disk |
 *
 * Compilation success is never the same claim as *visual* correctness: `pdf.produced` is set from a
 * real `stat` of the output file, while `pdf.inspected` is only ever true when the caller states it
 * inspected the rendered pages (`inspected_by: 'caller-attestation'`). A PDF produced and not
 * inspected is reported exactly that way.
 *
 * Two further axes keep a failure actionable without over-claiming:
 *
 * - **`failure_class`** separates `environment` (sandbox/permission denial, missing compiler,
 *   missing TeX package, seam failure — repairing the document cannot help; the summary says so)
 *   from `document` (the source itself), `timeout`, and `null` on success. A static check and a
 *   bounded preflight run *before* any process starts; neither ever claims to validate TeX syntax.
 * - **`timings`** (`preflight_ms`, `compile_ms`) measure *this tool's own stages* — never model
 *   generation, never the end-to-end conversation — and **`diagnostics`** extracts a concise error
 *   list while the full `stdout`/`stderr` evidence is preserved verbatim.
 *
 * @module dsh-professor-spike/src/latex/compile
 */

import path from 'node:path'
import { createHash } from 'node:crypto'

import { commandForEngine, REQUIREMENT_UNICODE_CJK, summarizeLatex } from './capabilities.js'
import { preflightProject, PREFLIGHT_LIMITS } from './preflight.js'
import { environmentBalance, maskIgnorable, SHELL_ESCAPE } from './scan.js'

/** Max lines kept in the concise diagnostics (the full streams are returned separately). */
const MAX_DIAGNOSTIC_LINES = 8
const MAX_DIAGNOSTIC_LINE = 300

/**
 * Static pre-checks on a generated `.tex` file.
 *
 * Comments and verbatim/code content are masked first (see `src/latex/scan.js`), so a commented-out
 * environment or a literal `\begin{itemize}` inside a listing is never mistaken for structure.
 *
 * Catches the mistakes that would otherwise waste a compile: a missing `\documentclass`, an
 * unbalanced environment, and — importantly — shell escape, which is refused unless the caller
 * opted in explicitly.
 *
 * @param source - the TeX source.
 * @returns `{ ok, problems, warnings }`.
 */
export function staticCheck(source) {
  const text = String(source ?? '')
  const masked = maskIgnorable(text)
  const problems = []
  const warnings = []
  const { unbalanced, unclosed } = environmentBalance(masked)

  if (!/\\documentclass\b/.test(masked)) problems.push('the source has no \\documentclass; it is not a complete document')
  if (unbalanced.length > 0) problems.push(`unbalanced environments: ${unbalanced.join(', ')}`)
  if (unclosed.length > 0) problems.push(`environments never closed: ${unclosed.join(', ')}`)

  if (SHELL_ESCAPE.test(masked)) {
    problems.push('the source requests shell escape (\\write18 / \\input{|…}), which this plugin never enables by default')
  }
  if (/\\usepackage\s*\{minted\}/.test(masked)) {
    warnings.push('minted requires shell escape; it will fail under the plugin\'s compile flags')
  }
  if (text.trim().length === 0) problems.push('the source is empty')
  if (!/\\begin\{document\}/.test(masked)) warnings.push('no \\begin{document} found')

  return { ok: problems.length === 0, problems, warnings }
}

/** Page count from the compiler's own summary line, or null when it printed none. */
export function pagesFromOutput(output) {
  const match = /Output written on [^\n]*\((\d+) pages?/.exec(String(output ?? ''))
  return match === null ? null : Number(match[1])
}

/**
 * A concise, bounded error list for a failed compile.
 *
 * The full `stdout`/`stderr` are returned separately and verbatim; this exists so a caller can act
 * without reading a 400-line log, not instead of it.
 */
export function diagnosticsFrom(output, stderr) {
  const lines = `${output ?? ''}\n${stderr ?? ''}`.split('\n')
  const errors = []
  for (const raw of lines) {
    if (errors.length >= MAX_DIAGNOSTIC_LINES) break
    const line = raw.trim()
    if (line.startsWith('!') || /LaTeX Error:|Package \S+ Error:/.test(line)) {
      errors.push(line.slice(0, MAX_DIAGNOSTIC_LINE))
    }
  }
  return { errors, pages: pagesFromOutput(output) }
}

/** Patterns that mark the failure as environmental: the write (or the tool) was refused. */
const WRITE_DENIAL = /operation not permitted|couldn.t write to temporary file|permission denied|FS_SANDBOX_DENIED|read-only file system|I can't write on file|cannot create[^'\n]*\.(?:aux|log|fls|out)/i
/** A `.sty`/class/font the distribution does not provide: an environment gap, not a bad source. */
const MISSING_TEX_FILE = /(?:LaTeX Error:\s*File|Unable to find the requested file|cannot find the file)\s*[`']?([^`'\s]+\.(?:sty|cls|fd|tfm|otf|ttf|pfb|map))/

/**
 * Classify a non-successful outcome so a repair loop is never aimed at the wrong target.
 *
 * @returns `{ failure_class, environmentReason }` where `failure_class` is
 *   `'environment' | 'document' | 'timeout'`.
 */
function classifyFailure({ run, timedOut }) {
  if (run?.runnerFailed === true) {
    return { failure_class: 'environment', environmentReason: `the shell seam failed: ${run.reason ?? 'unknown runner failure'}` }
  }
  if (timedOut === true) return { failure_class: 'timeout', environmentReason: null }
  if (run?.sandbox?.denied === true) {
    return { failure_class: 'environment', environmentReason: `the sandbox denied the run (mode ${run.sandbox.mode ?? 'unknown'})` }
  }
  const output = `${run?.stdout ?? ''}\n${run?.stderr ?? ''}`
  if (WRITE_DENIAL.test(output)) {
    return { failure_class: 'environment', environmentReason: 'the sandbox/permission denied a write' }
  }
  const missing = MISSING_TEX_FILE.exec(output)
  if (missing !== null) {
    return { failure_class: 'environment', environmentReason: `the TeX distribution does not provide ${missing[1]}` }
  }
  return { failure_class: 'document', environmentReason: null }
}

function visualCoverage(pdf, inspection) {
  const count = inspection?.pages
  const scoped = Number.isInteger(count) && count > 0
    && (pdf.pages === null || pdf.pages === undefined || count <= pdf.pages)
  const inspected = pdf.produced === true && inspection?.inspected === true
  return { ...pdf, inspected, inspected_by: inspected ? 'caller-attestation' : null,
    inspected_pages: inspected && scoped ? count : null,
    visual_review: !inspected ? 'none' : !scoped || !Number.isInteger(pdf.pages) ? 'unscoped'
      : count === pdf.pages ? 'full' : 'partial',
  }
}

const EMPTY_PDF = { produced: false, path: null, bytes: null, inspected: false, inspected_by: null }

/**
 * Compile an artifact's main `.tex` file.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.projectRoot - resolution base.
 * @param options.directory - absolute artifact project directory.
 * @param options.mainFile - main file name, relative to the directory.
 * @param options.probe - a value from `probeLatex`.
 * @param options.runner - a runner from `createShellRunner`, or undefined.
 * @param options.timeoutMs - compile deadline.
 * @param options.allowShellEscape - explicit opt-in (default false).
 * @param options.readPolicy - optional read policy bounding the preflight's file walk.
 * @param options.visualInspection - `{ inspected: boolean, pages?: number }` caller attestation.
 * @param options.signal / options.exec - as usual.
 * @returns the verdict report.
 */
export async function compileLatex(options) {
  const {
    gateway, projectRoot, directory, mainFile, probe, runner, signal,
  } = options

  const problems = []
  const warnings = []
  const staticResult = { ok: null, problems: [], warnings: [] }
  const preflightResult = {
    ok: null, files: [], problems: [], warnings: [], notes: [], digest: null,
    packages: { loaded: [], required: [] }, bounded: false, limits: PREFLIGHT_LIMITS, duration_ms: null,
  }
  const timings = { preflight_ms: null, compile_ms: null }
  const stageStarted = () => performance.now()

  /** Assemble the report so every branch carries the same evidence shape. */
  const report = (extra) => ({
    pdf: { ...EMPTY_PDF },
    reused_prior_compile: false,
    failure_class: null,
    diagnostics: { errors: [], pages: null },
    preflight: preflightResult,
    timings: { ...timings },
    sandbox: null,
    ...extra,
  })

  const skip = (fields) => report({
    attempted: false,
    engine: probe?.engine ?? null,
    command: null,
    exitCode: null,
    timedOut: false,
    signal: null,
    stdout: '',
    stderr: '',
    pdf: { ...EMPTY_PDF },
    static: staticResult,
    warnings,
    ...fields,
  })

  // 1. Read the source and run the static checks, then the bounded body/dependency preflight.
  const preflightClock = stageStarted()
  const mainPath = path.join(directory, mainFile)
  let source
  try {
    const target = await gateway.resolveTarget(mainPath, { cwd: projectRoot, signal })
    const info = await gateway.stat(target, signal)
    if (info === undefined) {
      timings.preflight_ms = Math.round(performance.now() - preflightClock)
      preflightResult.duration_ms = timings.preflight_ms
      return skip({
        verdict: 'source_generated',
        blocked_by: 'missing-source',
        failure_class: 'document',
        problems: [`${mainFile} does not exist in ${directory}`],
        summary: 'the generated project has no main source file; nothing was compiled',
      })
    }
    source = await gateway.readText(target, signal)
  } catch (error) {
    timings.preflight_ms = Math.round(performance.now() - preflightClock)
    preflightResult.duration_ms = timings.preflight_ms
    return skip({
      verdict: 'source_generated',
      blocked_by: 'unreadable-source',
      failure_class: 'environment',
      problems: [`could not read ${mainFile}: ${error.message}`],
      summary: 'the generated source could not be read; nothing was compiled',
    })
  }

  const checked = staticCheck(source)
  Object.assign(staticResult, checked)
  warnings.push(...checked.warnings)
  if (!checked.ok) {
    problems.push(...checked.problems)
    timings.preflight_ms = Math.round(performance.now() - preflightClock)
    preflightResult.duration_ms = timings.preflight_ms
    return skip({
      verdict: 'source_generated',
      blocked_by: 'static-check',
      failure_class: 'document',
      problems,
      summary: `the source failed the static pre-checks (${checked.problems.join('; ')}); compilation was not attempted`,
    })
  }

  // The generated body plus every declared input that stays inside the artifact directory.
  const preflight = await preflightProject({
    gateway, projectRoot, directory, mainFile, mainSource: source, signal,
    ...(options.readPolicy === undefined ? {} : { readPolicy: options.readPolicy }),
  })
  timings.preflight_ms = Math.round(performance.now() - preflightClock)
  Object.assign(preflightResult, preflight, { duration_ms: timings.preflight_ms })
  warnings.push(...preflight.warnings)
  if (!preflight.ok) {
    problems.push(...preflight.problems)
    return skip({
      verdict: 'source_generated',
      blocked_by: 'preflight',
      failure_class: 'document',
      problems,
      summary: `the project failed the bounded preflight (${preflight.problems.join('; ')}); `
        + 'compilation was not attempted — this is a structural check, not a full TeX validation',
    })
  }

  // 2. Compiler availability.
  if (probe?.available !== true || typeof probe.path !== 'string') {
    return skip({
      verdict: 'compiler_unavailable',
      blocked_by: 'no-compiler',
      failure_class: 'environment',
      engine: null,
      problems,
      warnings: [...warnings, summarizeLatex(probe).note],
      summary: 'no TeX engine was found by the probe; the source was generated but was not compiled',
    })
  }

  // 3. Runner availability. Without the shell seam there is no honest way to claim a compile.
  if (typeof runner !== 'function') {
    return skip({
      verdict: 'source_generated',
      blocked_by: 'no-runner',
      failure_class: 'environment',
      engine: probe.engine,
      problems,
      summary: `the source was generated and ${probe.engine} is available, but no shell runner is wired, so compilation was not attempted`,
    })
  }

  // A visual attestation can reuse only a successful compile from this tool instance,
  // with the same bounded source fingerprint, options and actual PDF bytes.
  const cache = options.compileCache
  const cacheKey = JSON.stringify([mainPath, probe.engine, probe.path, probe.flavor, options.allowShellEscape === true])
  const pdfFingerprint = async (pdfPath) => {
    try {
      const target = await gateway.resolveTarget(pdfPath, { cwd: projectRoot, signal })
      const info = await gateway.stat(target, signal)
      if (!info || info.type === 'directory' || info.size > 32 * 1024 * 1024) return null
      return createHash('sha256').update(await gateway.readBytes(target, signal, 32 * 1024 * 1024)).digest('hex')
    } catch { return null }
  }
  const prior = cache?.get(cacheKey)
  if (options.visualInspection?.inspected === true && prior && preflight.cacheable !== false
      && !preflight.bounded && preflight.notes.length === 0 && prior.digest === preflight.digest
      && await pdfFingerprint(prior.report.pdf.path) === prior.pdfDigest) {
    return { ...prior.report, attempted: false, reused_prior_compile: true,
      preflight: preflightResult, timings: { ...timings },
      pdf: visualCoverage(prior.report.pdf, options.visualInspection),
      summary: 'compilation succeeded previously; its unchanged PDF was visually inspected by the caller without recompiling',
    }
  }
  cache?.delete(cacheKey)

  // 4. Compile through the seam. `flavor` comes from the probe that was resolved for this
  // document's requirement: a generated default is classified `unicode-cjk` and must be driven by
  // XeLaTeX, while a user-provided template keeps the historical `-pdf` command untouched.
  if (options.requirement === REQUIREMENT_UNICODE_CJK) {
    warnings.push(
      `generated default wrapper (unicode-cjk): compiled with ${probe.engine}`
      + `${probe.flavor ? ` driving ${probe.flavor}` : ''} — ${summarizeLatex(probe).note}`,
    )
  }
  const { command, args } = commandForEngine({
    engine: probe.engine,
    flavor: probe.flavor,
    mainFile,
    allowShellEscape: options.allowShellEscape === true,
  })
  const quoted = `'${probe.path.replace(/'/g, "'\\''")}'`
  const commandLine = [quoted, ...args.map((arg) => (arg.includes(' ') ? `'${arg}'` : arg))].join(' ')
  const compileClock = stageStarted()
  const run = await runner({
    command: commandLine,
    workdir: directory,
    timeoutMs: options.timeoutMs,
    onExpiry: 'kill',
    signal: options.signal,
    exec: options.exec,
  })
  timings.compile_ms = Math.round(performance.now() - compileClock)

  const stdout = run.stdout ?? ''
  const stderr = run.stderr ?? ''

  if (run.runnerFailed === true) {
    const classified = classifyFailure({ run, timedOut: false })
    const environment = `compilation was blocked by the environment (${classified.environmentReason}) — `
      + 'this is not a document error: do not repair the document for this blocker'
    return report({
      verdict: 'compilation_failed',
      attempted: true,
      blocked_by: null,
      failure_class: classified.failure_class,
      engine: probe.engine,
      command: commandLine,
      exitCode: null,
      timedOut: false,
      signal: null,
      stdout,
      stderr,
      diagnostics: diagnosticsFrom(stdout, stderr),
      static: staticResult,
      problems: [...problems, run.reason ?? 'the shell runner failed', environment],
      warnings,
      summary: `${environment}: ${run.reason ?? 'shell runner failure'}`,
    })
  }

  // 5. Look for the produced PDF. `produced` comes from a real stat, never from the exit code.
  const pdfName = `${mainFile.replace(/\.tex$/, '')}.pdf`
  let pdfInfo
  try {
    const pdfTarget = await gateway.resolveTarget(path.join(directory, pdfName), { cwd: projectRoot, signal })
    pdfInfo = await gateway.stat(pdfTarget, signal)
  } catch {
    pdfInfo = undefined
  }
  const produced = pdfInfo !== undefined && pdfInfo.type !== 'directory'
  // An attestation supplied before this new run cannot inspect its future output.
  const inspection = undefined
  const inspected = false
  if (options.visualInspection?.inspected === true) warnings.push(
    'A fresh compile invalidates the previous visual attestation; inspect this PDF and record it in a subsequent call.',
  )
  const diagnostics = diagnosticsFrom(stdout, stderr)

  const failed = run.exitCode !== 0 || run.timedOut === true || !produced
  const failureNotes = []
  if (run.timedOut === true) failureNotes.push(`the compiler exceeded its ${run.timeoutMs ?? 'configured'} ms deadline`)
  if (run.exitCode !== null && run.exitCode !== 0) failureNotes.push(`the compiler exited with code ${run.exitCode}`)
  if (!produced) failureNotes.push(`no ${pdfName} was produced`)

  const classified = failed ? classifyFailure({ run, timedOut: run.timedOut === true }) : { failure_class: null, environmentReason: null }
  let summary
  if (!failed) {
    summary = inspected
      ? 'compilation succeeded and the produced PDF was visually inspected by the caller'
      : 'compilation succeeded and a PDF was produced, but it was NOT visually inspected — compilation is not a claim about visual correctness'
  } else if (classified.failure_class === 'environment') {
    summary = `compilation was blocked by the environment (${classified.environmentReason}) — not a document error: `
      + `do not repair the document for this blocker; ${failureNotes.join('; ')}`
  } else if (classified.failure_class === 'timeout') {
    summary = `compilation failed: ${failureNotes.join('; ')}`
  } else {
    summary = `compilation failed: ${failureNotes.join('; ')}`
  }

  const result = report({
    verdict: failed ? 'compilation_failed' : 'compilation_succeeded',
    attempted: true,
    blocked_by: null,
    failure_class: classified.failure_class,
    engine: probe.engine,
    command: commandLine,
    exitCode: run.exitCode,
    timedOut: run.timedOut === true,
    signal: run.signal ?? null,
    stdout,
    stderr,
    diagnostics,
    sandbox: run.sandbox ?? null,
    pdf: visualCoverage({
      pages: diagnostics.pages,
      produced,
      path: produced ? path.join(directory, pdfName) : null,
      bytes: produced ? (pdfInfo.size ?? null) : null,
      inspected,
      inspected_by: inspected ? 'caller-attestation' : null,
      ...(inspected && Number.isInteger(inspection?.pages) ? { inspected_pages: inspection.pages } : {}),
    }, failed ? undefined : inspection),
    static: staticResult,
    problems: failed && classified.failure_class === 'environment' && classified.environmentReason !== null
      ? [...problems, ...failureNotes, `environment blocker: ${classified.environmentReason} — do not repair the document`]
      : [...problems, ...failureNotes],
    warnings,
    summary,
  })
  if (!failed && preflight.cacheable !== false && !preflight.bounded && preflight.notes.length === 0 && cache) {
    const pdfDigest = await pdfFingerprint(result.pdf.path)
    if (pdfDigest !== null) {
      if (cache.size >= 32) cache.delete(cache.keys().next().value)
      cache.set(cacheKey, { digest: preflight.digest, pdfDigest, report: result })
    }
  }
  return result
}
