/**
 * LaTeX capability probing (M11, v3 §9 / audit capability matrix).
 *
 * The harness ships no TeX wrapper, so the plugin probes the host **once** and reports what it
 * actually found. Probing is read-only and never executes a compiler: it looks for the well-known
 * binaries at the standard TeX Live locations (plus `PATH` and an explicit override).
 *
 * Probe results are *observations*, so they carry their evidence: a successful probe reports the
 * engine and the concrete binary path it stat'd, and nothing here asserts a fact that was not
 * checked. The note deliberately describes the observation ("found latexmk") rather than the
 * machine, so a capability report never reads as a claim about the host environment.
 *
 * A host with no TeX installation therefore reports `latex.available: false` together with the
 * list of locations that were searched, and the LaTeX workflow says so instead of pretending a
 * compile happened.
 *
 * @module dsh-professor-spike/src/latex/capabilities
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** Engines the plugin knows how to drive, in preference order. */
export const LATEX_ENGINES = ['latexmk', 'xelatex', 'pdflatex', 'lualatex']

/** Standard installation prefixes, checked in order of specificity. */
export const LATEX_PREFIXES = [
  '/Library/TeX/texbin',
  '/usr/local/texlive/2025/bin/universal-darwin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
]

/** Environment override: a directory, or an explicit path to the engine binary. */
export const LATEX_ENGINE_ENV = 'DSH_PROFESSOR_LATEX'

function executableAt(candidate, exists, isFile) {
  if (!exists(candidate)) return false
  try {
    return isFile(candidate)
  } catch {
    return false
  }
}

/**
 * Probe for a usable LaTeX engine.
 *
 * @param options.env - environment object (defaults to `process.env`).
 * @param options.exists - injectable existence probe (tests).
 * @param options.isFile - injectable file probe (tests).
 * @param options.pathDirs - injectable `PATH` entries (tests).
 * @returns `{ available, engine, path, searched, note }` — `engine`/`path` are null when absent.
 */
export function probeLatex(options = {}) {
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const isFile = options.isFile ?? ((candidate) => statSync(candidate).isFile())

  const searched = []

  const override = typeof env?.[LATEX_ENGINE_ENV] === 'string' ? env[LATEX_ENGINE_ENV].trim() : ''
  if (override.length > 0) {
    // The override may be an explicit binary or a bin directory.
    const asFile = override
    if (executableAt(asFile, exists, isFile)) {
      return { available: true, engine: inferEngine(asFile), path: asFile, searched: [asFile], note: `from ${LATEX_ENGINE_ENV}` }
    }
    searched.push(asFile)
    for (const engine of LATEX_ENGINES) {
      const candidate = path.join(override, engine)
      if (executableAt(candidate, exists, isFile)) {
        return { available: true, engine, path: candidate, searched, note: `from ${LATEX_ENGINE_ENV}` }
      }
      searched.push(candidate)
    }
  }

  const pathDirs = options.pathDirs ?? String(env?.PATH ?? '').split(path.delimiter).filter(Boolean)
  const dirs = [...new Set([...LATEX_PREFIXES, ...pathDirs])]
  for (const engine of LATEX_ENGINES) {
    for (const dir of dirs) {
      const candidate = path.join(dir, engine)
      searched.push(candidate)
      if (executableAt(candidate, exists, isFile)) {
        return { available: true, engine, path: candidate, searched, note: `found ${engine}` }
      }
    }
  }

  return {
    available: false,
    engine: null,
    path: null,
    searched,
    note: 'no TeX engine found (looked for latexmk/xelatex/pdflatex/lualatex in the standard TeX Live locations and PATH); set '
      + `${LATEX_ENGINE_ENV} to override`,
  }
}

function inferEngine(binaryPath) {
  const base = path.basename(binaryPath)
  return LATEX_ENGINES.find((engine) => base.startsWith(engine)) ?? base
}

/** A document with no special requirement: any engine the host offers is acceptable. */
export const REQUIREMENT_ANY = 'any'

/**
 * The generated default wrapper's requirement.
 *
 * `renderContentTex` emits Chinese section headings (`概述`, `材料范围`, `重要术语`, …) for *any*
 * note that supplies those fields — including a purely English one — so the generated document
 * needs an engine and a font that actually cover CJK. Naming the requirement keeps the document and
 * the compiler selection from drifting apart again.
 */
export const REQUIREMENT_UNICODE_CJK = 'unicode-cjk'

/** The machine-readable marker the generated wrapper carries in a TeX comment. */
export const REQUIREMENT_MARKER = /dsh-professor-requirement:\s*unicode-cjk/

/**
 * Classify a `main.tex`.
 *
 * Only the plugin's own generated wrapper declares the requirement; a user-provided `main.tex` is
 * never reclassified, so its compilation behaviour is untouched.
 *
 * @param source - the TeX source text.
 * @returns `'unicode-cjk' | 'any'`.
 */
export function detectRequirement(source) {
  return REQUIREMENT_MARKER.test(String(source ?? '')) ? REQUIREMENT_UNICODE_CJK : REQUIREMENT_ANY
}

/** Relative path of the CJK font the generated wrapper asks for, inside a TeX distribution. */
export const CJK_FONT_RELATIVE_PATH = 'fonts/opentype/public/fandol/FandolSong-Regular.otf'

/** TeX distribution roots to look in, most specific first (never an operating-system font dir). */
function texmfRoots(env) {
  const roots = []
  const declared = typeof env?.TEXMFDIST === 'string' ? env.TEXMFDIST.trim() : ''
  if (declared.length > 0) roots.push(declared)
  for (const parent of ['/usr/local/texlive', '/opt/homebrew/share/texlive', '/usr/share/texlive']) {
    try {
      for (const entry of readdirSync(parent)) {
        if (/^\d{4}$/.test(entry)) roots.push(path.join(parent, entry, 'texmf-dist'))
      }
    } catch {
      // Not every host has a TeX Live tree here; a root we cannot read is simply not a candidate.
    }
  }
  roots.push('/Library/TeX/texmf-dist')
  return [...new Set(roots)]
}

/**
 * Look for the CJK font inside the TeX distribution.
 *
 * A file probe, not a font-cache query: it executes nothing and never consults the operating
 * system's font database, so the answer does not depend on macOS (or Windows) font names.
 *
 * @param options.env - environment (for `TEXMFDIST`).
 * @param options.fontExists - injectable existence probe (tests).
 * @returns `{ available, path, family, searched }`.
 */
export function probeCjkFonts(options = {}) {
  const env = options.env ?? process.env
  const exists = options.fontExists ?? (candidate => existsSync(candidate))
  const searched = []
  for (const root of texmfRoots(env)) {
    const candidate = path.join(root, CJK_FONT_RELATIVE_PATH)
    searched.push(candidate)
    if (exists(candidate)) return { available: true, path: candidate, family: 'Fandol', searched }
  }
  return { available: false, path: null, family: 'Fandol', searched }
}

/**
 * Probe for a compiler that can actually build a document with a stated requirement.
 *
 * For {@link REQUIREMENT_ANY} this is exactly `probeLatex`, so historical behaviour is unchanged.
 * For {@link REQUIREMENT_UNICODE_CJK} it insists on XeLaTeX *and* a CJK font and reports their
 * absence, rather than quietly handing a CJK document to pdfTeX — which is what produced the
 * `Unicode character 概 (U+6982)` failure this probe exists to prevent.
 *
 * @param requirement - `'any' | 'unicode-cjk'`.
 * @param options - the same injectables as `probeLatex`, plus `fontExists`.
 * @returns a probe-shaped object carrying `requirement`, `flavor` and, when relevant, `fonts`.
 */
export function probeLatexRequirement(requirement, options = {}) {
  const wanted = requirement === REQUIREMENT_UNICODE_CJK ? REQUIREMENT_UNICODE_CJK : REQUIREMENT_ANY
  if (wanted === REQUIREMENT_ANY) {
    return { ...probeLatex(options), requirement: REQUIREMENT_ANY, flavor: null }
  }

  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const isFile = options.isFile ?? (candidate => statSync(candidate).isFile())
  const pathDirs = options.pathDirs ?? String(env?.PATH ?? '').split(path.delimiter).filter(Boolean)
  const dirs = [...new Set([...LATEX_PREFIXES, ...pathDirs])]
  const searched = []
  const fonts = probeCjkFonts(options)
  const override = typeof env?.[LATEX_ENGINE_ENV] === 'string' ? env[LATEX_ENGINE_ENV].trim() : ''
  let xelatex = null
  let latexmk = null

  const unavailable = note => ({
    available: false, engine: null, path: null, flavor: null, fonts, searched, requirement: wanted, note,
  })

  if (override.length > 0) {
    if (executableAt(override, exists, isFile)) {
      // An explicit binary wins, and it is held to the requirement rather than bypassing it.
      searched.push(override)
      const engine = inferEngine(override)
      if (engine === 'xelatex') xelatex = override
      else if (engine === 'latexmk') latexmk = override
      else {
        return unavailable(
          `${LATEX_ENGINE_ENV} selects ${path.basename(override)}, which is not XeLaTeX; this generated `
          + 'document requires XeLaTeX (unicode-cjk) because it contains CJK text',
        )
      }
    } else {
      const asEngine = path.join(override, 'xelatex')
      const asLatexmk = path.join(override, 'latexmk')
      searched.push(asEngine, asLatexmk)
      if (executableAt(asEngine, exists, isFile)) xelatex = asEngine
      if (executableAt(asLatexmk, exists, isFile)) latexmk = asLatexmk
    }
  }

  if (xelatex === null) {
    for (const dir of dirs) {
      const candidate = path.join(dir, 'xelatex')
      searched.push(candidate)
      if (executableAt(candidate, exists, isFile)) { xelatex = candidate; break }
    }
  }
  if (latexmk === null) {
    for (const dir of dirs) {
      const candidate = path.join(dir, 'latexmk')
      searched.push(candidate)
      if (executableAt(candidate, exists, isFile)) { latexmk = candidate; break }
    }
  }

  if (xelatex === null) {
    return unavailable(
      'this generated document requires XeLaTeX (unicode-cjk) because the plugin emits CJK section '
      + `headings, and no xelatex was found in ${LATEX_ENGINE_ENV}, the standard TeX Live locations or PATH; `
      + 'set DSH_PROFESSOR_LATEX to an installation that provides it',
    )
  }
  if (fonts.available !== true) {
    return unavailable(
      'XeLaTeX was found, but no CJK font ships with this TeX installation (looked for '
      + `${CJK_FONT_RELATIVE_PATH} under the TeX distribution roots); the generated document needs one`,
    )
  }

  if (latexmk !== null) {
    return {
      available: true, engine: 'latexmk', path: latexmk, flavor: 'xelatex', xelatexPath: xelatex,
      fonts, searched, requirement: wanted,
      note: 'found latexmk driving XeLaTeX with a TeX-distribution CJK font',
    }
  }
  return {
    available: true, engine: 'xelatex', path: xelatex, flavor: 'xelatex',
    fonts, searched, requirement: wanted,
    note: 'found xelatex with a TeX-distribution CJK font',
  }
}

/**
 * Build the argument vector for one engine.
 *
 * Flags are explicit rather than inherited from a user profile, so a compile is reproducible and
 * cannot be steered by a stray `latexmkrc`: no shell escape, no interactive prompts, stop on error.
 *
 * `flavor` is what keeps `latexmk` and the document in agreement: `latexmk -pdf` drives pdfTeX,
 * which cannot typeset the CJK text the generated wrapper contains, so a document classified as
 * `unicode-cjk` must be asked for `-xelatex`. Omitting `flavor` keeps the historical `-pdf` command
 * exactly as it was, which is what a user-provided template still gets.
 *
 * @param options.engine - engine basename.
 * @param options.mainFile - the file to compile, relative to the working directory.
 * @param options.flavor - `'xelatex'` to drive XeLaTeX through latexmk (default: pdfTeX).
 * @param options.allowShellEscape - explicit opt-in (default false).
 * @returns `{ command, args }`.
 */
export function commandForEngine(options) {
  const { engine, mainFile } = options
  const common = ['-interaction=nonstopmode', '-halt-on-error']
  switch (engine) {
    case 'latexmk':
      return {
        command: 'latexmk',
        args: [
          options.flavor === 'xelatex' ? '-xelatex' : '-pdf',
          ...common,
          ...(options.allowShellEscape === true ? ['-shell-escape'] : []),
          mainFile,
        ],
      }
    case 'xelatex':
    case 'pdflatex':
    case 'lualatex':
      return {
        command: engine,
        args: [...common, ...(options.allowShellEscape === true ? ['-shell-escape'] : []), mainFile],
      }
    default:
      return { command: engine, args: [mainFile] }
  }
}

/** Summarisable form for diagnostics. */
export function summarizeLatex(probe) {
  return {
    available: probe?.available === true,
    engine: probe?.engine ?? null,
    path: probe?.path ?? null,
    note: probe?.note ?? 'not probed',
  }
}
