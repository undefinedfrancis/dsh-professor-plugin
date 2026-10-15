/**
 * Academic-folder detection: course codes, terms, a bounded read-only scan and the proposal
 * contract a user confirms.
 *
 * Everything here is either **pure** (`parseCourseCodeName`, `inferTerm`, `fingerprintProposal`,
 * `validateProposal`) or **read-only** (`scanFolder`). Discovery is deliberately incapable of
 * writing: the only mutations in Phase 3 live in `src/workspace/onboarding.js`, behind an explicit
 * confirmation.
 *
 * ## Why a fingerprint and not "the same folder"
 *
 * A proposal is shown to a human, and humans take time. Between discovery and confirmation the
 * folder may gain, lose or replace a directory — or the user may have pointed the proposal at a
 * different folder entirely. Every proposal therefore carries a `fingerprint`: a sha256 over the
 * root plus the *sorted* list of `(relative path, kind, directory version, material directories)`.
 * It is order-independent (the same folder always hashes the same way) and sensitive to a
 * substitution, an addition or a removal. `onboarding.confirm` re-scans and refuses with
 * `PROFESSOR_ONBOARDING_STALE` if it changed, **before** anything is written.
 *
 * ## What detection never does
 *
 * - It never assigns a course identity to an ambiguous folder: `Algorithms`, `Math` and `Course A`
 *   are reported with `proposed.course_code: null` and `needs_confirmation: true`.
 * - It never follows a symlink, so a link inside the folder cannot read outside it.
 * - It never walks *past* a course-code directory — its subdirectories are material, not courses.
 * - It never reports a folder it could not read as empty: an unreadable directory is listed under
 *   `inaccessible` with the reason the filesystem gave.
 *
 * @module dsh-professor-spike/src/workspace/detect
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

import { EXCLUDED_DIRECTORIES, PROJECT_DIRECTORY } from '../indexer/index.js'
import { deriveMaterialRules, isMaterialDirectoryName, isMaterialDocumentName } from './materials.js'

/** Schema tag of the proposal/confirmation contract. A bump requires an explicit migration. */
export const ONBOARDING_SCHEMA = 'professor.onboarding/1'

/** Scan limits a discovery call runs under, and the defaults when the caller names none. */
export const DEFAULT_SCAN_LIMITS = Object.freeze({
  max_depth: 6,
  max_candidates: 200,
  max_entries: 20000,
})

/** Hard ceilings, so a caller cannot ask for an unbounded walk through a tool argument. */
const LIMIT_BOUNDS = Object.freeze({
  max_depth: [1, 32],
  max_candidates: [1, 5000],
  max_entries: [1, 200000],
})

/** `<letters><digits>` — the shape a course code has. */
const COURSE_CODE = /^([A-Za-z]{2,6})(\d{2,4})$/

/** A course code, optionally followed by a `-2025Fall`-style suffix. */
const CODE_WITH_SUFFIX = /^([A-Za-z]{2,6}\d{2,4})(?:[-_\s]+(.+))?$/

/** Term words, English and Chinese. */
const TERM_WORDS = Object.freeze(['spring', 'summer', 'fall', 'autumn', 'winter', '春', '夏', '秋', '冬', '学期', '学年'])

/** A plausible calendar year inside a longer name. */
const TERM_YEAR = /(?:19|20)\d{2}/

/** A name that is *only* a year, or only a year range. */
const BARE_YEAR = /^(?:19|20)\d{2}$/
const YEAR_RANGE = /^(?:19|20)\d{2}\s*[-–—/]\s*(?:19|20)\d{2}$/

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)

/**
 * Parse a directory name as a course code.
 *
 * Anchored at the start and restricted to `2–6 letters + 2–4 digits`, which is what keeps
 * `Algorithms`, `Math`, `Course A`, `Lecture 1`, `Photos` and `2025 Fall` out. `2025 Fall` matters
 * most: a term folder must never be mistaken for a course, and it is the case a looser pattern (any
 * digits, anywhere) would get wrong.
 *
 * @param name - the directory name.
 * @returns `{ code, suffix }` with the code upper-cased, or `null` when the name is not a code.
 */
export function parseCourseCodeName(name) {
  const value = typeof name === 'string' ? name.trim() : ''
  if (value.length === 0) return null
  const match = CODE_WITH_SUFFIX.exec(value)
  if (match === null) return null
  if (!COURSE_CODE.test(match[1])) return null
  const suffix = nonEmpty(match[2] ?? null)
  return { code: match[1].toUpperCase(), suffix }
}

/** Normalise a candidate term name: `2025Fall` reads as `2025 Fall`, and runs of whitespace collapse. */
function normalizeTermName(raw) {
  return String(raw).trim().replace(/(\d)([A-Za-z])/g, '$1 $2').replace(/\s+/g, ' ')
}

/**
 * Infer a term from folder names, never inventing one.
 *
 * Named candidates are tried in the order given, so a caller passes the most specific name first
 * (an explicit `-2025Fall` suffix, then the nearest ancestor). A name is a term only when it is a
 * bare year or year range, or contains a plausible year **and** a term word — so `CSC3200` (whose
 * digits are not a year) and `Algorithms` are both rejected, while `2025-2026 Fall`, `Fall 2026`,
 * `2025Fall` and `2025 秋` are accepted.
 *
 * @param names - candidate names, most specific first.
 * @returns the normalised term, or `null` when nothing looked like one.
 */
export function inferTerm(names) {
  const list = Array.isArray(names) ? names : [names]
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const value = normalizeTermName(raw)
    if (value.length === 0) continue
    if (BARE_YEAR.test(value) || YEAR_RANGE.test(value)) return value
    if (!TERM_YEAR.test(value)) continue
    const lower = value.toLowerCase()
    if (TERM_WORDS.some((word) => lower.includes(word))) return value
  }
  return null
}

/** Clamp caller-supplied scan limits into the documented bounds. */
export function normalizeScanLimits(args = {}) {
  const limits = {}
  for (const [key, [min, max]] of Object.entries(LIMIT_BOUNDS)) {
    const requested = args?.[key]
    const value = Number.isInteger(requested) ? requested : DEFAULT_SCAN_LIMITS[key]
    limits[key] = Math.min(Math.max(value, min), max)
  }
  return limits
}

/**
 * Fingerprint a proposal: a stable, order-independent digest of the folder's structure.
 *
 * @param options.root - the canonical folder path.
 * @param options.candidates - the proposed candidates (only four fields are read).
 * @returns a 64-character lowercase sha256 hex string.
 */
export function fingerprintProposal(options = {}) {
  const root = String(options.root ?? '')
  const candidates = Array.isArray(options.candidates) ? options.candidates : []
  const lines = candidates.map((candidate) => [
    String(candidate?.relative_path ?? ''),
    String(candidate?.kind ?? ''),
    String(candidate?.directory_version ?? ''),
    (Array.isArray(candidate?.material_directories) ? [...candidate.material_directories].sort() : []).join(','),
  ].join('\u0000'))
  lines.sort()
  return createHash('sha256').update(`${root}\n${lines.join('\n')}`).digest('hex')
}

/**
 * Validate the structure of a proposal before anything reads the filesystem.
 *
 * Returns every structural problem it finds rather than the first, so a malformed proposal is
 * actionable in one pass.
 *
 * @returns `{ ok, errors }` — never throws.
 */
export function validateProposal(proposal) {
  const errors = []
  if (!isPlainObject(proposal)) {
    return { ok: false, errors: ['proposal must be an object'] }
  }
  if (proposal.schema !== ONBOARDING_SCHEMA) {
    errors.push(`schema must be "${ONBOARDING_SCHEMA}", found ${JSON.stringify(proposal.schema ?? null)}`)
  }
  if (typeof proposal.root !== 'string' || proposal.root.trim().length === 0 || !proposal.root.startsWith('/')) {
    errors.push('root must be a non-empty absolute path')
  }
  if (typeof proposal.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(proposal.fingerprint)) {
    errors.push('fingerprint must be a 64-character lowercase sha256 hex string')
  }
  if (!Array.isArray(proposal.candidates)) {
    errors.push('candidates must be an array')
  } else {
    for (const [index, candidate] of proposal.candidates.entries()) {
      if (!isPlainObject(candidate) || nonEmpty(candidate.relative_path) === null) {
        errors.push(`candidates[${index}].relative_path is required`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

/** A short, actionable description of a filesystem refusal. */
function describeFsError(error) {
  const code = error?.code ?? null
  const message = String(error?.message ?? error ?? 'unknown error')
  if (code === 'FS_SANDBOX_DENIED') return `file access denied (${code}): ${message}`
  if (code === 'FS_NOT_FOUND') return `not found (${code}): ${message}`
  return code === null ? message : `${code}: ${message}`
}

/** Ancestor directory names of a relative path, nearest first. */
function ancestorsOf(relativePath) {
  return String(relativePath).split('/').slice(0, -1).reverse()
}

/** Material directory names directly under a list of entry names. */
const materialNamesIn = (names) => names.filter(isMaterialDirectoryName)

/**
 * Read one directory's *direct* children without recursing into it.
 *
 * Used for a recognised course directory: its children are material, so the scan records which of
 * them match a convention (for the proposed `category_rules`) but never proposes them as courses.
 * An unreadable course directory is reported rather than treated as empty — and `readable: false` is
 * carried back so the proposal can say "this could not be read" instead of "no material directory
 * was found", which would be a claim about a listing that never happened.
 */
async function peekDirectory(options) {
  const {
    gateway, target, relativePath, state, signal,
  } = options
  let entries
  try {
    entries = await gateway.listDir(target, signal)
  } catch (error) {
    state.inaccessible.push({ relative_path: relativePath, reason: describeFsError(error) })
    return { names: [], materialDirectories: [], documents: 0, readable: false }
  }
  const names = []
  let documents = 0
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.type === 'directory') {
      if (state.excluded.size > 0 && state.excluded.has(gateway.canonical(entry.target))) continue
      names.push(entry.name)
      continue
    }
    if (entry.type === 'file' && isMaterialDocumentName(entry.name)) documents += 1
  }
  names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  return { names, materialDirectories: materialNamesIn(names), documents, readable: true }
}

/**
 * Walk one folder, read-only, inside the caller's limits.
 *
 * `state` accumulates everything the walk observed: courses, skips, unreadable directories and the
 * counters behind `scan.truncated`. Nothing is thrown for an unreadable directory — a folder the
 * process may not list is a *finding*, not a reason to abandon the whole discovery.
 */
async function walk(options) {
  const {
    gateway, target, relativePath, name, depth, limits, state, signal,
  } = options
  const node = {
    relativePath,
    name,
    depth,
    version: null,
    documents: 0,
    subdirectories: [],
  }

  const info = await gateway.stat(target, signal).catch(() => undefined)
  node.version = info?.version === undefined ? null : String(info.version)

  let entries
  try {
    entries = await gateway.listDir(target, signal)
  } catch (error) {
    state.inaccessible.push({ relative_path: relativePath, reason: describeFsError(error) })
    return node
  }

  const sorted = [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of sorted) {
    // Dot-entries are never course material: `.professor`, `.git`, caches and editor state.
    if (entry.name.startsWith('.')) continue
    if (state.entries >= limits.max_entries) {
      state.truncate(`entry cap (${limits.max_entries}) reached`)
      break
    }
    state.entries += 1

    const childRelative = relativePath.length === 0 ? entry.name : `${relativePath}/${entry.name}`

    if (entry.type === 'directory') {
      if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.name === PROJECT_DIRECTORY) {
        state.skipped.push({ relative_path: childRelative, reason: 'excluded directory (never a course source)' })
        continue
      }
      if (state.excluded.size > 0 && state.excluded.has(gateway.canonical(entry.target))) {
        state.skipped.push({
          relative_path: childRelative,
          reason: 'configured output directory: generated notes are never course input',
        })
        continue
      }
    }

    // `listDir` reports a symlink's *target* type, so a link inside the folder would otherwise be
    // walked as if it were inside it. An `lstat` per entry is what makes "never follow a symlink"
    // true rather than aspirational.
    const linkInfo = await gateway.lstat(childRelative, { cwd: state.root, signal }).catch(() => undefined)
    if (linkInfo?.type === 'symlink') {
      state.skipped.push({
        relative_path: childRelative,
        reason: 'symlink (never followed: it may point outside the approved folder)',
      })
      continue
    }

    if (entry.type === 'directory') {
      const parsed = parseCourseCodeName(entry.name)
      if (parsed !== null) {
        const peek = await peekDirectory({ gateway, target: entry.target, relativePath: childRelative, state, signal })
        state.courses.push({
          relativePath: childRelative,
          name: entry.name,
          parsed,
          version: entry.version === undefined || entry.version === null ? null : String(entry.version),
          depth: depth + 1,
          materialDirectories: peek.materialDirectories,
          documents: peek.documents,
          readable: peek.readable,
        })
        // A course directory's children are material. Descending would propose `01_Lectures` as a
        // second course, which is exactly the mistake this stops.
        continue
      }
      if (depth + 1 > limits.max_depth) {
        state.truncate(`depth cap (${limits.max_depth}) reached`)
        continue
      }
      const child = await walk({
        gateway, target: entry.target, relativePath: childRelative, name: entry.name, depth: depth + 1, limits, state, signal,
      })
      node.subdirectories.push(child)
      continue
    }

    if (entry.type === 'file' && isMaterialDocumentName(entry.name)) node.documents += 1
  }

  return node
}

/**
 * Turn the walked tree (plus the courses recognised during the walk) into proposal candidates.
 *
 * Three rules decide what becomes a candidate, and each exists because the alternative would be a
 * *lie* rather than merely a different presentation:
 *
 * 1. **A directory the walk could not list is never proposed.** It is unknown, not empty; proposing
 *    it as `unrelated` would assert "no material was found here" about a folder nothing observed.
 *    It is reported under `inaccessible` instead.
 * 2. **A directory that contains a recognised course is a grouping folder** (`2025-2026 Fall`) and is
 *    never proposed as a course of its own — but it is still descended into, so a term folder holding
 *    two courses proposes both.
 * 3. **A directory that is itself proposed is not descended into.** Its children are that folder's
 *    material, exactly as a course directory's children are: `Algorithms` is one question, and
 *    `Algorithms/01_Lectures` is the answer to it, not a second question. This is what keeps a
 *    confirmed `Algorithms` from leaving a stray pending entry behind.
 *
 * "Looks academic" is judged from a directory's **direct** children — a conventional material
 * directory, or document-like files sitting straight in it. A subtree count would misread a plain
 * container (`Fall 2025/`, holding `Algorithms/` and `Math/`) as academic and then refuse to descend
 * into it, hiding the two real folders inside.
 */
function collectCandidates({ state, root, limits, truncatedReasons }) {
  const candidates = []
  const coursePaths = state.courses.map((entry) => entry.relativePath)
  const unreadable = new Set(state.inaccessible.map((entry) => entry.relative_path))

  for (const course of state.courses) {
    const absolute = path.join(root, course.relativePath)
    const materialDirectories = course.materialDirectories
    const rules = deriveMaterialRules({ sourcePath: absolute, names: materialDirectories, includeSupplementary: true })
    candidates.push({
      relative_path: course.relativePath,
      kind: 'course',
      confidence: 'high',
      directory_version: course.version,
      material_directories: materialDirectories,
      categories: rules.categories,
      depth: course.depth,
      needs_confirmation: false,
      proposed: {
        course_code: course.parsed.code,
        display_name: course.name,
        term: inferTerm([course.parsed.suffix, ...ancestorsOf(course.relativePath)]),
      },
      reasons: [
        `folder name "${course.name}" parses as the course code ${course.parsed.code}`,
        course.readable === false
          ? 'the folder could not be listed, so its material directories are reported as unknown rather than empty'
          : materialDirectories.length > 0
            ? `${materialDirectories.length} material director${materialDirectories.length === 1 ? 'y' : 'ies'} recognised: ${materialDirectories.join(', ')}`
            : 'no conventional material directory was found; the course is still recognised by its code alone',
      ],
    })
  }

  const visit = (node) => {
    for (const child of node.subdirectories) {
      if (unreadable.has(child.relativePath)) continue

      const nestedCourse = coursePaths.some((relative) => (
        relative === child.relativePath || relative.startsWith(`${child.relativePath}/`)
      ))
      if (nestedCourse) {
        visit(child)
        continue
      }

      const materialDirectories = materialNamesIn(child.subdirectories.map((entry) => entry.name))
      // Direct children only — see the module note above on why a subtree count is wrong here.
      const documents = child.documents
      const absolute = path.join(root, child.relativePath)
      const rules = deriveMaterialRules({ sourcePath: absolute, names: materialDirectories, includeSupplementary: true })
      const looksAcademic = materialDirectories.length > 0 || documents > 0
      const name = child.name.length > 0 ? child.name : child.relativePath

      candidates.push({
        relative_path: child.relativePath,
        kind: looksAcademic ? 'possible-course' : 'unrelated',
        confidence: 'low',
        directory_version: child.version,
        material_directories: materialDirectories,
        categories: rules.categories,
        depth: child.depth,
        needs_confirmation: looksAcademic,
        proposed: {
          // Never an identity: an ambiguous folder is proposed as a *question*, not as a course.
          course_code: null,
          display_name: name,
          term: inferTerm(ancestorsOf(child.relativePath)),
        },
        reasons: looksAcademic
          ? [
            `folder name "${name}" contains no course code`,
            materialDirectories.length > 0
              ? `material structure found: ${materialDirectories.join(', ')}`
              : `${documents} document-like file(s) found directly in the folder`,
            'an identity must be confirmed or edited before this folder is registered',
          ]
          : [
            `folder name "${name}" contains no course code`,
            'no material directory and no document-like file was found, so this folder is reported as unrelated',
          ],
      })

      // Rule 3: a proposed folder is the unit the user confirms; its contents are its material.
      if (looksAcademic) continue
      visit(child)
    }
  }
  visit(state.rootNode)

  candidates.sort((left, right) => (left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0))
  if (candidates.length > limits.max_candidates) {
    truncatedReasons.push(`candidate cap (${limits.max_candidates}) reached`)
    candidates.length = limits.max_candidates
  }
  return candidates
}

/**
 * Scan a folder, read-only, and build the proposal a user confirms.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.target - resolved target of the folder.
 * @param options.root - canonical folder path.
 * @param options.limits - scan limits (see {@link normalizeScanLimits}).
 * @param options.excludePaths - canonical paths never treated as course material (configured
 *   output roots: generated notes must not be re-detected as input).
 * @param options.signal - cancellation.
 * @returns `{ candidates, skipped, inaccessible, scan }`.
 */
export async function scanFolder(options) {
  const {
    gateway, target, root, limits = DEFAULT_SCAN_LIMITS, excludePaths = [], signal,
  } = options

  const truncatedReasons = []
  const state = {
    root,
    entries: 0,
    courses: [],
    skipped: [],
    inaccessible: [],
    excluded: new Set(excludePaths),
    rootNode: null,
    truncate: (reason) => {
      if (!truncatedReasons.includes(reason)) truncatedReasons.push(reason)
    },
  }

  state.rootNode = await walk({
    gateway, target, relativePath: '', name: '', depth: 0, limits, state, signal,
  })

  const candidates = collectCandidates({ state, root, limits, truncatedReasons })

  return {
    candidates,
    skipped: state.skipped,
    inaccessible: state.inaccessible,
    scan: {
      limits: { ...limits },
      truncated: truncatedReasons.length > 0,
      truncation_reason: truncatedReasons[0] ?? null,
      entries_scanned: state.entries,
      candidates_found: candidates.length,
    },
  }
}

/** Build a complete proposal document from a scan. */
export function buildProposal(options) {
  const { root, folderSource, scan } = options
  return {
    schema: ONBOARDING_SCHEMA,
    root,
    folder_source: folderSource ?? null,
    fingerprint: fingerprintProposal({ root, candidates: scan.candidates }),
    candidates: scan.candidates,
    skipped: scan.skipped,
    inaccessible: scan.inaccessible,
    scan: scan.scan,
  }
}
