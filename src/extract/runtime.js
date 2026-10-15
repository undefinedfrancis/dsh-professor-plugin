/**
 * Discovery of the runtimes a real extraction backend needs (M8 follow-up).
 *
 * The plugin never assumes an interpreter exists because a file name looks right, and it never
 * requires a *global* installation when the Harness already ships a bundled payload. Discovery
 * therefore has two stages:
 *
 * 1. **this module** — enumerate the documented candidate locations and keep the ones that are
 *    really there, using the same injectable filesystem probes the LaTeX prober uses;
 * 2. **the runner** — actually *execute* the candidate once (import probe / `--version`) and report
 *    only what came back. A candidate that exists but cannot import `openpyxl` is reported
 *    unavailable with that reason, never as a capability.
 *
 * Candidate order, most privileged first:
 *
 * | rank | source | why |
 * |---|---|---|
 * | 1 | `DSH_PROFESSOR_PYTHON` / `DSH_PROFESSOR_GS` | an explicit operator override always wins |
 * | 2 | `DSH_PRIMARY_RUNTIME` | an immutable carrier (container layer) that declares its own payload |
 * | 3 | `$DSH_HOME/dsh-runtimes/dsh-primary-runtime` | where the Desktop app installs the shared payload |
 * | 4 | `<process.resourcesPath>/runtime/primary-runtime` | the app's own read-only carrier |
 * | 5 | `PATH` | a host interpreter, used only if it really imports the libraries |
 *
 * Rank 4 is derived from `process.resourcesPath` rather than a hardcoded application path, so no
 * machine-specific path is ever embedded in the source, and an app installed anywhere still works.
 *
 * @module dsh-professor-spike/src/extract/runtime
 */

import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Explicit interpreter override (directory or executable). */
export const PYTHON_ENV = 'DSH_PROFESSOR_PYTHON'
/** Explicit Ghostscript override (directory or executable). */
export const GHOSTSCRIPT_ENV = 'DSH_PROFESSOR_GS'
/** A carrier payload directory (`runtime.json` + `dependencies/`). */
export const PRIMARY_RUNTIME_ENV = 'DSH_PRIMARY_RUNTIME'

/** Environment variable naming the Harness home. */
const DSH_HOME_ENV = 'DSH_HOME'

/** Relative layout inside a primary-runtime payload. */
const PYTHON_IN_PAYLOAD = ['dependencies', 'python', 'bin']
const GHOSTSCRIPT_NAMES = ['gs']

/** Absolute locations Ghostscript is conventionally installed at, checked after PATH-shape guesses. */
export const GHOSTSCRIPT_PREFIXES = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']

/** Libraries the Office backend needs, per format: extension → the module the script imports. */
export const OFFICE_MODULES = { docx: 'docx', pptx: 'pptx', xlsx: 'openpyxl' }

/**
 * The *distribution* name of each Office library, per format.
 *
 * Kept beside `OFFICE_MODULES` so the two never drift: a diagnostic that says "python-docx is
 * missing" is actionable, whereas one that says "docx is missing" is not.
 */
export const OFFICE_PACKAGES = { docx: 'python-docx', pptx: 'python-pptx', xlsx: 'openpyxl' }

/** The interpreter's own probe script, relative to the package root. */
export const PROBE_SCRIPT = path.join('src', 'extract', 'scripts', 'probe_python.py')
/** PDF extraction script (PyMuPDF path), relative to the package root. */
export const PDF_SCRIPT = path.join('src', 'extract', 'scripts', 'extract_pdf.py')
/** Office extraction script, relative to the package root. */
export const OFFICE_SCRIPT = path.join('src', 'extract', 'scripts', 'extract_office.py')
/** Page-render script (in-memory rasterisation), relative to the package root. */
export const RENDER_SCRIPT = path.join('src', 'extract', 'scripts', 'render_pages.py')

/** Modules a candidate interpreter must import to be chosen for PDF text (and page rendering). */
export const PDF_MODULES = ['fitz']
/** Modules an interpreter must import to be chosen for Office extraction. */
export const OFFICE_MODULE_LIST = ['docx', 'pptx', 'openpyxl']

/** The Harness home, honouring `DSH_HOME` exactly as the loader does. */
export function dshHome(env = process.env) {
  const configured = env?.[DSH_HOME_ENV]
  if (typeof configured === 'string' && configured.trim().length > 0) return path.resolve(configured.trim())
  return path.join(os.homedir(), '.dsh')
}

/**
 * Candidate interpreters, most privileged first.
 *
 * @param options.env - environment (`DSH_PROFESSOR_PYTHON`, `DSH_PRIMARY_RUNTIME`, `DSH_HOME`).
 * @param options.resourcesPath - `process.resourcesPath` when running inside the app.
 * @param options.homedir - home directory (tests).
 * @param options.pathDirs - `PATH` entries (tests).
 * @param options.platform - `process.platform` (tests).
 * @returns `{ path, source }[]`, de-duplicated, in preference order.
 */
export function pythonCandidates(options = {}) {
  const env = options.env ?? process.env
  const home = options.homedir ?? os.homedir()
  const platform = options.platform ?? process.platform
  const binary = platform === 'win32' ? 'python.exe' : 'python3'
  const candidates = []
  const push = (candidate, source) => {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) return
    const resolved = path.resolve(candidate.trim())
    if (!candidates.some((entry) => entry.path === resolved)) candidates.push({ path: resolved, source })
  }

  /** An override may name the executable itself or the directory that holds it. */
  const pushOverride = (value, source) => {
    if (typeof value !== 'string' || value.trim().length === 0) return
    const raw = value.trim()
    const looksLikeBinary = /(?:^|[/\\])(python[0-9.]*|python)(?:\.exe)?$/i.test(raw)
    if (looksLikeBinary) push(raw, source)
    else {
      push(path.join(raw, binary), source)
      push(path.join(raw, 'bin', binary), source)
    }
  }

  pushOverride(env?.[PYTHON_ENV], `env:${PYTHON_ENV}`)

  const payloads = [
    [env?.[PRIMARY_RUNTIME_ENV], `env:${PRIMARY_RUNTIME_ENV}`],
    [path.join(dshHome(env), 'dsh-runtimes', 'dsh-primary-runtime'), 'dsh-home-payload'],
    [typeof options.resourcesPath === 'string' && options.resourcesPath.length > 0
      ? path.join(options.resourcesPath, 'runtime', 'primary-runtime')
      : undefined, 'app-resources-payload'],
  ]
  for (const [directory, source] of payloads) {
    if (typeof directory !== 'string' || directory.length === 0) continue
    if (platform === 'win32') {
      push(path.join(directory, 'dependencies', 'python', binary), source)
      push(path.join(directory, 'dependencies', 'python', 'Scripts', binary), source)
    }
    push(path.join(directory, ...PYTHON_IN_PAYLOAD, binary), source)
  }

  const pathDirs = options.pathDirs ?? String(env?.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const directory of [...new Set(pathDirs)]) push(path.join(directory, binary), 'path')
  push(path.join(home, '.local', 'bin', binary), 'user-local')

  return candidates
}

/**
 * Candidate Ghostscript executables, most privileged first.
 *
 * @param options - same shape as {@link pythonCandidates}, plus `names` for Windows variants.
 * @returns `{ path, source }[]`.
 */
export function ghostscriptCandidates(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const names = options.names ?? (platform === 'win32' ? ['gswin64c', 'gswin32c'] : GHOSTSCRIPT_NAMES)
  const candidates = []
  const push = (candidate, source) => {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) return
    const resolved = path.resolve(candidate.trim())
    if (!candidates.some((entry) => entry.path === resolved)) candidates.push({ path: resolved, source })
  }

  const override = typeof env?.[GHOSTSCRIPT_ENV] === 'string' ? env[GHOSTSCRIPT_ENV].trim() : ''
  if (override.length > 0) {
    const looksLikeBinary = names.some((name) => override.endsWith(name) || override.endsWith(`${name}.exe`))
    if (looksLikeBinary) push(override, `env:${GHOSTSCRIPT_ENV}`)
    else for (const name of names) push(path.join(override, name), `env:${GHOSTSCRIPT_ENV}`)
  }

  const pathDirs = options.pathDirs ?? String(env?.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const directory of [...new Set([...pathDirs, ...GHOSTSCRIPT_PREFIXES])]) {
    for (const name of names) push(path.join(directory, name), 'path')
  }
  return candidates
}

/**
 * Keep the candidates that are really present, preserving order.
 *
 * @param candidates - `{ path, source }[]`.
 * @param options.exists - injectable existence probe.
 * @param options.isFile - injectable executable-ish probe.
 * @returns `{ path, source }[]`.
 */
export function existingCandidates(candidates, options = {}) {
  // `node:fs` is deliberate here: this probes the *machine's own runtimes*, not user data, and it
  // is only a cheap pre-filter — the shell seam is what actually executes a candidate.
  const exists = options.exists ?? existsSync
  const isFile = options.isFile ?? ((candidate) => statSync(candidate).isFile())
  return candidates.filter((candidate) => {
    if (!exists(candidate.path)) return false
    try {
      return isFile(candidate.path)
    } catch {
      return false
    }
  })
}

/**
 * Parse the interpreter probe's JSON.
 *
 * @param stdout - captured stdout.
 * @returns `{ ok, python, modules, missing }` or `null` when the output is not the probe's shape.
 */
export function parsePythonProbe(stdout) {
  const text = String(stdout ?? '').trim()
  if (text.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(text.slice(text.indexOf('{')))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.modules !== 'object') return null
  return {
    ok: parsed.ok === true,
    python: typeof parsed.python === 'string' ? parsed.python : null,
    modules: parsed.modules ?? {},
    missing: Array.isArray(parsed.missing) ? parsed.missing : [],
  }
}

/**
 * Parse a Ghostscript version banner (`gs --version` prints a bare version, `gs -h` prints a
 * banner and device list).
 *
 * @param stdout - captured stdout.
 * @returns the version string, or null.
 */
export function parseGhostscriptVersion(stdout) {
  const text = String(stdout ?? '')
  const banner = /Ghostscript\s+([0-9][0-9.]*)/i.exec(text)
  if (banner !== null) return banner[1]
  const bare = /^\s*([0-9]+\.[0-9]{2}(?:\.[0-9]+)?)\s*$/.exec(text)
  return bare === null ? null : bare[1]
}

/** Whether a `gs -h` device listing advertises the `txtwrite` device. */
export function hasTxtwriteDevice(stdout) {
  return /(^|\s)txtwrite(\s|$)/.test(String(stdout ?? ''))
}

/** Strip a version banner's trailing noise so diagnostics stay one line. */
export function firstLine(text) {
  const value = String(text ?? '').trim()
  const index = value.indexOf('\n')
  return index < 0 ? value : value.slice(0, index).trim()
}
