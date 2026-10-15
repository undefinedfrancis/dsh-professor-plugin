/**
 * Bounded, project-aware preflight: what a compile would otherwise discover the expensive way.
 *
 * The historical check read only the main driver, so a missing `content.tex`, an escaped
 * `\textbackslash{}\begin{tabular}` that would print as text, an unbalanced environment in the
 * body, or an undefined `\cancel` all surfaced only after a full compile (if at all). This module
 * walks the driver's *declared* inputs and checks the generated body before any process runs.
 *
 * Bounds and honesty:
 *
 * - **traversal is bounded and stays inside the artifact directory** (canonical containment, so a
 *   symlink escape collapses first) and inside the caller's authorized read policy when one is
 *   supplied. A reference that points outside is *skipped and reported*, never followed;
 * - files, depth and bytes are capped ({@link PREFLIGHT_LIMITS}); hitting a cap is reported as a
 *   note, never silently ignored;
 * - this is a **bounded structural check** — environments, declared inputs, escaped markup and
 *   package usage — and never a claim that the TeX is valid. The compiler stays the authority.
 *
 * @module dsh-professor-spike/src/latex/preflight
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

import { isInside } from '../paths/policy.js'
import { renderMainTex } from '../artifacts/latex.js'
import { environmentBalance, ESCAPED_MARKUP, maskIgnorable } from './scan.js'

/** Every bound the preflight enforces, exported so the report can state them. */
export const PREFLIGHT_LIMITS = {
  maxFiles: 24,
  maxDepth: 4,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxStyleFiles: 8,
}

/**
 * Commands that silently become "undefined control sequence" when their package is never loaded.
 *
 * A deliberately short, high-confidence list: a package may also be loaded by a class or by a file
 * the preflight could not scan, so a hit here is reported as a *problem* only when the scan was
 * complete (see `uncertain` below), and as a warning otherwise. `cancel` is first because it is
 * the documented case: skipping it silently leaves `\cancel` undefined.
 */
export const REQUIRED_PACKAGES = [
  { pkg: 'cancel', alt: [], probe: /\\cancel\w*\s*[{[]/ },
  { pkg: 'tikz', alt: [], probe: /\\begin\s*\{tikzpicture\}|\\tikz\s*[{[]/ },
  { pkg: 'tcolorbox', alt: [], probe: /\\begin\s*\{tcolorbox\}|\\tcbox\s*[{[]/ },
  { pkg: 'booktabs', alt: [], probe: /\\toprule\b|\\midrule\b|\\bottomrule\b/ },
  { pkg: 'tabularx', alt: [], probe: /\\begin\s*\{tabularx\}/ },
  { pkg: 'siunitx', alt: [], probe: /\\SI\s*[{[]|\\qty\s*[{[]/ },
  { pkg: 'graphicx', alt: [], probe: /\\includegraphics\b/ },
  { pkg: 'xcolor', alt: ['color'], probe: /\\textcolor\s*[{[]|\\colorbox\s*[{[]|\\definecolor\b|\\color\s*[{[]/ },
  { pkg: 'amsmath', alt: [], probe: /\\begin\s*\{align\*?\}|\\begin\s*\{gather\*?\}|\\begin\s*\{multline\*?\}|\\begin\s*\{aligned\}|\\dfrac\s*[{[]/ },
]

const INPUT_TOKEN = /\\(?:input|include)\s*\{([^}]*)\}/g
const GRAPHICS_TOKEN = /\\includegraphics(?:\s*\[[^\]]*\])?\s*\{([^}]*)\}/g
const CLASS_TOKEN = /\\(?:documentclass|LoadClass)(?:\s*\[[^\]]*\])?\s*\{([^}]*)\}/g
const PACKAGE_TOKEN = /\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{([^}]*)\}/g

const GRAPHICS_EXTENSIONS = ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps']

/** Is this reference spelled with a traversal or as an absolute path? */
function isOutsideSpelling(ref) {
  return path.isAbsolute(ref) || ref.split(/[\\/]+/).includes('..')
}

/** Collect comma-separated package names into a lower-cased set. */
function addPackages(into, list) {
  for (const raw of String(list ?? '').split(',')) {
    const name = raw.trim().toLowerCase()
    if (name.length > 0) into.add(name)
  }
}

/** Every `\usepackage`/`\RequirePackage` declared by one masked source. */
function packagesIn(masked) {
  const found = []
  PACKAGE_TOKEN.lastIndex = 0
  let match
  while ((match = PACKAGE_TOKEN.exec(masked)) !== null) found.push(match[1])
  return found
}

/**
 * Run the bounded preflight over the generated project.
 *
 * @param options.gateway - filesystem gateway (the Harness `ctx.fs` boundary, never `node:fs`).
 * @param options.projectRoot - resolution base.
 * @param options.directory - absolute artifact project directory.
 * @param options.mainFile - the driver's file name, relative to the directory.
 * @param options.mainSource - the driver's already-read text (no second read).
 * @param options.readPolicy - optional `createPathPolicy` read policy; when supplied, every read is
 *   asserted against it in addition to the artifact-directory containment.
 * @param options.signal / options.exec - as usual.
 * @returns `{ ok, files, problems, warnings, notes, digest, packages, bounded, limits }`.
 */
export async function preflightProject(options) {
  const {
    gateway, projectRoot, directory, mainFile, mainSource, readPolicy, signal,
    limits = PREFLIGHT_LIMITS,
  } = options

  const problems = []
  const warnings = []
  const notes = []
  const files = []
  const loadedPackages = new Set()
  const requiredBy = new Map() // package -> Set of file names that use it
  const hash = createHash('sha256')
  const seen = new Set()
  let bytesTotal = 0
  let bounded = false
  let hasLocalStyles = false
  const queuedStyles = new Set()
  let uncertainDependencies = false
  const mainMasked = maskIgnorable(mainSource)
  const plainArticle = /\\documentclass(?:\s*\[[^\]]*\])?\s*\{article\}/.test(mainMasked)
  const trustedDefault = String(mainSource) === renderMainTex()
  const reservedReads = new Set([path.resolve(directory, mainFile)])
  let reservedBytes = Buffer.byteLength(String(mainSource ?? ''), 'utf8')

  // Reserve both queued and already scanned inputs before any content read. Otherwise a driver
  // with hundreds of inputs can fill the pending queue long before the dequeue limits apply.
  const reserveRead = (resolved) => {
    const key = gateway.canonical(resolved.target)
    if (reservedReads.has(key)) return false
    const size = Number.isFinite(resolved.info.size) && resolved.info.size >= 0
      ? resolved.info.size : limits.maxFileBytes
    if (reservedReads.size >= limits.maxFiles || size > limits.maxFileBytes
      || reservedBytes + size > limits.maxTotalBytes) {
      bounded = true
      notes.push(`bounded: not reading ${resolved.name} (pending file/byte budget reached)`)
      return false
    }
    reservedReads.add(key)
    reservedBytes += size
    return true
  }

  // Containment is decided on canonical paths: symlink escapes collapse before this check runs.
  let directoryKey
  try {
    directoryKey = gateway.canonical(await gateway.resolveTarget(directory, { cwd: projectRoot, signal }))
  } catch (error) {
    return {
      ok: false,
      files,
      problems: [`the artifact directory could not be resolved: ${error.message}`],
      warnings,
      notes,
      digest: null,
      packages: { loaded: [], required: [] },
      bounded: false,
      limits,
    }
  }

  /**
   * Resolve one declared reference to a readable file inside the artifact directory.
   * @returns `{ target, name }`, or `{ skipped: reason }`.
   */
  const resolveInside = async (ref, extension = '.tex') => {
    const trimmed = String(ref ?? '').trim()
    if (trimmed.length === 0) return { skipped: 'an empty reference' }
    if (/[\\{}#$]/.test(trimmed)) return { skipped: `${trimmed} is a dynamic TeX reference; resolution is left to the compiler` }
    if (isOutsideSpelling(trimmed)) {
      return { skipped: `${trimmed} points outside the artifact directory (bounded preflight only follows references inside it)` }
    }
    const candidates = trimmed.endsWith(extension) ? [trimmed] : [`${trimmed}${extension}`, trimmed]
    let firstCanonical = null
    for (const candidate of candidates) {
      const absolute = path.resolve(directory, candidate)
      let target
      try {
        target = await gateway.resolveTarget(absolute, { cwd: projectRoot, signal })
      } catch {
        continue
      }
      const canonical = gateway.canonical(target)
      firstCanonical ??= canonical
      if (!isInside(directoryKey, canonical)) {
        return { skipped: `${trimmed} resolves outside the artifact directory (bounded preflight only follows references inside it)` }
      }
      if (readPolicy !== undefined && typeof readPolicy.contains === 'function' && !readPolicy.contains(canonical)) {
        return { skipped: `${trimmed} is outside the authorized read roots` }
      }
      const info = await gateway.stat(target, signal)
      if (info !== undefined && info.type !== 'directory') return { target, name: candidate, info }
    }
    if (firstCanonical !== null && !isInside(directoryKey, firstCanonical)) {
      return { skipped: `${trimmed} resolves outside the artifact directory (bounded preflight only follows references inside it)` }
    }
    return { missing: trimmed }
  }

  const queue = [{ name: mainFile, text: String(mainSource ?? ''), depth: 0, isMain: true }]
  const graphicsToCheck = []

  while (queue.length > 0) {
    const file = queue.shift()
    if (seen.has(file.name)) continue
    if (files.length >= limits.maxFiles || bytesTotal >= limits.maxTotalBytes) {
      bounded = true
      notes.push(`bounded: stopped after ${files.length} files / ${bytesTotal} bytes (preflight limit reached)`)
      break
    }
    seen.add(file.name)

    const fileBytes = Buffer.byteLength(file.text, 'utf8')
    if (fileBytes > limits.maxFileBytes || bytesTotal + fileBytes > limits.maxTotalBytes) {
      bounded = true
      notes.push(`${file.name} exceeds the per-file preflight limit and was not scanned`)
      continue
    }
    bytesTotal += fileBytes
    files.push({ name: file.name, bytes: fileBytes })
    hash.update(`${file.name}\u0000${file.text}\u0000`)

    const masked = maskIgnorable(file.text)
    if (/\\csname\b/.test(masked)) {
      uncertainDependencies = true
      notes.push(`${file.name}: dynamic control-sequence construction prevents dependency verification`)
    }
    if (/\\(?:input|include)\b(?!\s*\{)|\\(?:import|subimport|InputIfFileExists|IfFileExists|includeonly|graphicspath)\b/.test(masked)) {
      uncertainDependencies = true
      notes.push(`${file.name}: dependency syntax is outside the bounded literal-input scan`)
    }

    const declaredPackages = packagesIn(masked)
    for (const list of declaredPackages) addPackages(loadedPackages, list)
    const styleRefs = declaredPackages.flatMap(list => list.split(',').map(name => ({ name: name.trim(), extension: '.sty' })))
    CLASS_TOKEN.lastIndex = 0
    let classMatch
    while ((classMatch = CLASS_TOKEN.exec(masked)) !== null) {
      styleRefs.push({ name: classMatch[1].trim(), extension: '.cls' })
      if (!['article', 'report', 'book'].includes(classMatch[1].trim())) uncertainDependencies = true
    }
    if (/\\(?:newcommand|renewcommand|def|let|if[a-zA-Z]+)\b/.test(masked)
      && !(trustedDefault && (file.isMain || file.name === 'professor-metadata.tex'))) uncertainDependencies = true
    for (const ref of styleRefs) {
      const resolved = await resolveInside(ref.name, ref.extension)
      if (resolved.skipped !== undefined) { notes.push(`not inspected: ${resolved.skipped}`); continue }
      if (resolved.missing !== undefined) continue // Distribution dependencies are left to the compiler.
      hasLocalStyles = true
      if (queuedStyles.has(resolved.name)) continue
      if (file.depth >= limits.maxDepth || queuedStyles.size >= limits.maxStyleFiles) {
        bounded = true
        notes.push(`bounded: not following local dependency ${resolved.name}`)
        continue
      }
      queuedStyles.add(resolved.name)
      if (!reserveRead(resolved)) continue
      try {
        const text = await gateway.readText(resolved.target, signal)
        queue.push({ name: resolved.name, text, depth: file.depth + 1, isMain: false, isStyle: true })
      } catch (error) { notes.push(`could not read ${resolved.name}: ${error.message}`) }
    }

    // Escaped markup: text that was escaped on render and will print literally.
    for (const pattern of ESCAPED_MARKUP) {
      if (pattern.test(masked)) {
        problems.push(
          `escaped markup in ${file.name}: \\textbackslash…\\begin{…} is escaped text, not typesetting — `
          + 'put the raw LaTeX in `body_tex` (format "latex") or edit the generated output copy; '
          + 'otherwise the environment prints as text',
        )
        break
      }
    }

    // Environment balance belongs to the body files; the driver's own balance is the static check's.
    if (file.isMain !== true && file.isStyle !== true) {
      const { unbalanced, unclosed } = environmentBalance(masked)
      if (unbalanced.length > 0) problems.push(`${file.name}: unbalanced environments: ${unbalanced.join(', ')}`)
      if (unclosed.length > 0) problems.push(`${file.name}: environments never closed: ${unclosed.join(', ')}`)
    }

    // Declared inputs: existence is checked, traversal never followed.
    INPUT_TOKEN.lastIndex = 0
    let match
    const refs = []
    while ((match = INPUT_TOKEN.exec(masked)) !== null) refs.push(match[1])

    GRAPHICS_TOKEN.lastIndex = 0
    while ((match = GRAPHICS_TOKEN.exec(masked)) !== null) graphicsToCheck.push({ from: file.name, ref: match[1] })

    for (const ref of refs) {
      if (file.depth >= limits.maxDepth) {
        bounded = true
        notes.push(`bounded: not following ${ref} from ${file.name} (depth limit ${limits.maxDepth})`)
        continue
      }
      const resolved = await resolveInside(ref)
      if (resolved.skipped !== undefined) {
        notes.push(`not inspected: ${resolved.skipped}`)
        continue
      }
      if (resolved.missing !== undefined) {
        problems.push(
          `${file.name} declares \\input{${resolved.missing}} but `
          + `${resolved.missing.endsWith('.tex') ? resolved.missing : `${resolved.missing}.tex`} does not exist in the artifact directory`,
        )
        continue
      }
      if (!reserveRead(resolved)) continue
      let text
      try {
        text = await gateway.readText(resolved.target, signal)
      } catch (error) {
        notes.push(`could not read ${resolved.name}: ${error.message}`)
        continue
      }
      queue.push({ name: resolved.name, text, depth: file.depth + 1, isMain: false })
    }

    // Required packages are collected now and judged after the whole (bounded) scan.
    for (const rule of REQUIRED_PACKAGES) {
      if (rule.probe.test(masked)) {
        if (!requiredBy.has(rule.pkg)) requiredBy.set(rule.pkg, new Set())
        requiredBy.get(rule.pkg).add(file.name)
      }
    }
  }

  // Graphics references: a warning only — a distribution-wide search path may still resolve them.
  for (const { from, ref } of graphicsToCheck) {
    if (isOutsideSpelling(ref)) {
      notes.push(`not inspected: ${ref} (graphics reference from ${from} points outside the artifact directory)`)
      continue
    }
    const candidates = GRAPHICS_EXTENSIONS.map((extension) => path.resolve(directory, `${ref}${extension}`))
    let found = false
    for (const candidate of candidates) {
      try {
        const target = await gateway.resolveTarget(candidate, { cwd: projectRoot, signal })
        if (!isInside(directoryKey, gateway.canonical(target))) continue
        const info = await gateway.stat(target, signal)
        if (info !== undefined && info.type !== 'directory') { found = true; break }
      } catch {
        // Unresolvable candidates are treated as absent.
      }
    }
    if (!found) warnings.push(`graphics ${ref} (used by ${from}) was not found in the artifact directory`)
  }

  // Judge package usage. `uncertain` (a skipped/truncated read, or a bounded scan) downgrades the
  // finding to a warning: a class or an unscanned file may still load the package.
  const uncertain = bounded || notes.length > 0
  const packages = { loaded: [...loadedPackages].sort(), required: [...requiredBy.keys()].sort() }
  for (const [pkg, sources] of requiredBy) {
    const rule = REQUIRED_PACKAGES.find((entry) => entry.pkg === pkg)
    const satisfied = loadedPackages.has(pkg) || (rule?.alt ?? []).some((name) => loadedPackages.has(name))
    if (satisfied) continue
    const message = `the scanned sources use ${[...sources].join(', ')} but never load the ${pkg} package: `
      + `add \\usepackage{${pkg}} to the driver, or the compile fails with an undefined command`
    const certainCancel = pkg === 'cancel' && plainArticle && !hasLocalStyles && !uncertainDependencies
      && (trustedDefault || loadedPackages.size === 0)
    if (uncertain || !certainCancel) warnings.push(`package requirement not verified (${message})`)
    else problems.push(message)
  }

  return {
    ok: problems.length === 0,
    files,
    problems,
    warnings,
    notes,
    digest: hash.digest('hex'),
    packages,
    bounded,
    cacheable: !bounded && notes.length === 0 && graphicsToCheck.length === 0
      && !hasLocalStyles && !uncertainDependencies && warnings.length === 0,
    limits,
  }
}
