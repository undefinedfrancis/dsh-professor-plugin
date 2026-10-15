/**
 * The versioned Professor project document (`.professor/project.yaml`).
 *
 * Responsibilities: defaults, validation, safe loading and guarded saving. Two rules from the
 * design are enforced here rather than left to callers:
 *
 * - **a newer schema is never overwritten** — loading reports `unsupported` and saving refuses;
 * - **every write is guarded** — the save path goes through the filesystem gateway with
 *   `createIfAbsent` for a first write and `replaceIfVersion` for an update, so a concurrent edit
 *   cannot be lost silently.
 *
 * @module dsh-professor-spike/src/project/project
 */

import { projectPaths } from '../paths/roots.js'
import { dumpYamlLite, parseYamlLite } from './yaml-lite.js'

/** Schema version this plugin writes and understands. */
export const PROJECT_SCHEMA_VERSION = 1

/** Allowed enumerated values. */
export const NOTE_FORMATS = ['latex', 'markdown', 'ask']
export const OVERWRITE_POLICIES = ['never', 'versioned', 'allow']
export const WEB_POLICIES = ['conditional', 'never', 'always']
export const COURSE_STATUSES = ['active', 'archived']

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isAbsolutePath = (value) => typeof value === 'string' && value.startsWith('/')

/** Turn a course code into a stable, path-safe course id. */
export function courseIdFor(courseCode) {
  return String(courseCode)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Build a complete project document with defaults applied.
 *
 * @param options.id - project id (kebab-case).
 * @param options.name - display name.
 * @returns the document.
 */
export function defaultProject(options = {}) {
  const id = options.id ?? 'professor-project'
  return {
    schema_version: PROJECT_SCHEMA_VERSION,
    project: { id, name: options.name ?? id },
    courses: [],
    outputs: { notes_root: null, reviews_root: null },
    indexing: { exclude: [], follow_symlinks: false },
    retrieval: { max_sources: 4, max_chunks: 8, prefer_local_course_sources: true },
    notes: { default_format: 'ask', overwrite_policy: 'never', latex_template: null },
    web: { enabled: true, policy: 'conditional' },
  }
}

/**
 * Validate a project document.
 *
 * @param document - the parsed document.
 * @returns `{ ok, errors, warnings }` — never throws.
 */
export function validateProject(document) {
  const errors = []
  const warnings = []

  if (!isPlainObject(document)) {
    return { ok: false, errors: ['project document must be a mapping'], warnings }
  }
  if (document.schema_version !== PROJECT_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${PROJECT_SCHEMA_VERSION}, found ${JSON.stringify(document.schema_version)}`)
  }
  if (!isPlainObject(document.project) || typeof document.project.id !== 'string' || document.project.id.trim().length === 0) {
    errors.push('project.id is required')
  } else if (!KEBAB.test(document.project.id)) {
    warnings.push(`project.id "${document.project.id}" is not kebab-case`)
  }

  if (document.courses !== undefined && !Array.isArray(document.courses)) {
    errors.push('courses must be a list')
  }
  const ids = new Set()
  const codeTerm = new Set()
  for (const [index, course] of (Array.isArray(document.courses) ? document.courses : []).entries()) {
    const where = `courses[${index}]`
    if (!isPlainObject(course)) {
      errors.push(`${where} must be a mapping`)
      continue
    }
    for (const field of ['course_id', 'course_code', 'term', 'display_name']) {
      if (typeof course[field] !== 'string' || course[field].trim().length === 0) {
        errors.push(`${where}.${field} is required`)
      }
    }
    if (typeof course.course_id === 'string') {
      if (!KEBAB.test(course.course_id)) errors.push(`${where}.course_id "${course.course_id}" must be kebab-case`)
      if (ids.has(course.course_id)) errors.push(`${where}.course_id "${course.course_id}" is duplicated`)
      ids.add(course.course_id)
    }
    if (typeof course.course_code === 'string' && typeof course.term === 'string') {
      const key = `${course.course_code}::${course.term}`
      if (codeTerm.has(key)) errors.push(`${where} duplicates course_code "${course.course_code}" in term "${course.term}"`)
      codeTerm.add(key)
    }
    if (course.sources !== undefined && !Array.isArray(course.sources)) {
      errors.push(`${where}.sources must be a list`)
    }
    for (const [sourceIndex, source] of (Array.isArray(course.sources) ? course.sources : []).entries()) {
      const sourceWhere = `${where}.sources[${sourceIndex}]`
      if (!isPlainObject(source)) {
        errors.push(`${sourceWhere} must be a mapping`)
        continue
      }
      if (!isAbsolutePath(source.path)) errors.push(`${sourceWhere}.path must be an absolute path`)
      if (source.category_rules !== undefined && !isPlainObject(source.category_rules)) {
        errors.push(`${sourceWhere}.category_rules must be a mapping`)
      }
    }
    if (course.status !== undefined && !COURSE_STATUSES.includes(course.status)) {
      errors.push(`${where}.status must be one of ${COURSE_STATUSES.join(' | ')}`)
    }
  }

  const outputs = document.outputs
  if (outputs !== undefined && !isPlainObject(outputs)) errors.push('outputs must be a mapping')
  for (const key of ['notes_root', 'reviews_root']) {
    const value = outputs?.[key]
    if (value !== null && value !== undefined && typeof value !== 'string') errors.push(`outputs.${key} must be a string or null`)
  }

  const indexing = document.indexing
  if (indexing !== undefined && !isPlainObject(indexing)) errors.push('indexing must be a mapping')
  if (indexing?.exclude !== undefined && !Array.isArray(indexing.exclude)) errors.push('indexing.exclude must be a list')
  if (indexing?.follow_symlinks !== undefined && typeof indexing.follow_symlinks !== 'boolean') {
    errors.push('indexing.follow_symlinks must be a boolean')
  }
  // The deletion markers are written only by this plugin, so they are validated strictly: a stray
  // value here would silently widen or silently disable what a rebuild keeps out of the index.
  if (indexing?.removed_sources !== undefined) {
    if (!Array.isArray(indexing.removed_sources)) errors.push('indexing.removed_sources must be a list')
    else if (indexing.removed_sources.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
      errors.push('indexing.removed_sources must contain non-empty path strings')
    }
  }

  const retrieval = document.retrieval
  if (retrieval !== undefined && !isPlainObject(retrieval)) errors.push('retrieval must be a mapping')
  for (const key of ['max_sources', 'max_chunks']) {
    const value = retrieval?.[key]
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) errors.push(`retrieval.${key} must be a positive integer`)
  }

  const notes = document.notes
  if (notes !== undefined && !isPlainObject(notes)) errors.push('notes must be a mapping')
  if (notes?.default_format !== undefined && !NOTE_FORMATS.includes(notes.default_format)) {
    errors.push(`notes.default_format must be one of ${NOTE_FORMATS.join(' | ')}`)
  }
  if (notes?.overwrite_policy !== undefined && !OVERWRITE_POLICIES.includes(notes.overwrite_policy)) {
    errors.push(`notes.overwrite_policy must be one of ${OVERWRITE_POLICIES.join(' | ')}`)
  }

  const web = document.web
  if (web !== undefined && !isPlainObject(web)) errors.push('web must be a mapping')
  if (web?.enabled !== undefined && typeof web.enabled !== 'boolean') errors.push('web.enabled must be a boolean')
  if (web?.policy !== undefined && !WEB_POLICIES.includes(web.policy)) {
    errors.push(`web.policy must be one of ${WEB_POLICIES.join(' | ')}`)
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Load the project document.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.projectRoot - absolute project root.
 * @param options.signal - cancellation.
 * @returns `{ present, document, raw, problems, unsupported }` where `unsupported` is set when the
 *   file carries a schema this plugin must not touch.
 */
export async function loadProject(options) {
  const { gateway, projectRoot, signal } = options
  const layout = projectPaths(projectRoot)
  const target = await gateway.resolveTarget(layout.projectFile, { cwd: projectRoot, signal })
  const info = await gateway.stat(target, signal)
  if (info === undefined) return { present: false, document: null, raw: null, problems: [], unsupported: null }

  let raw
  try {
    raw = await gateway.readText(target, signal)
  } catch (error) {
    return { present: true, document: null, raw: null, problems: [`project.yaml is unreadable: ${error.message}`], unsupported: null }
  }

  let document
  try {
    document = parseYamlLite(raw)
  } catch (error) {
    return {
      present: true,
      document: null,
      raw,
      problems: [`project.yaml is not valid in the supported subset: ${error.message}`],
      unsupported: null,
    }
  }

  const version = isPlainObject(document) ? document.schema_version : undefined
  if (version !== PROJECT_SCHEMA_VERSION) {
    const future = typeof version === 'number' && version > PROJECT_SCHEMA_VERSION
    return {
      present: true,
      document,
      raw,
      problems: [
        future
          ? `project.yaml uses schema_version ${version}, newer than this plugin supports (${PROJECT_SCHEMA_VERSION}); refusing to touch it`
          : `project.yaml uses schema_version ${JSON.stringify(version)}; this plugin writes ${PROJECT_SCHEMA_VERSION} and will not overwrite it`,
      ],
      unsupported: { version, future },
    }
  }

  const validation = validateProject(document)
  return { present: true, document, raw, observedVersion: info.version, problems: validation.errors, warnings: validation.warnings, unsupported: null }
}

/**
 * Turn a `loadProject` result into a usable document, or throw a precise domain error.
 *
 * Every tool that derives a write policy from the project — or that mutates it — must go through
 * this instead of re-implementing the three branches. The rules it enforces are the ones the
 * design depends on:
 *
 * - an **absent** document is `PROFESSOR_PROJECT_MISSING` (never guessed into existence);
 * - an **unparseable** or **newer-schema** document is `PROFESSOR_PROJECT_UNSUPPORTED` (never
 *   overwritten, never a source of output roots);
 * - a document that parses but **fails validation** is `PROFESSOR_PROJECT_INVALID` (a corrupt
 *   document must not widen the writable boundary).
 *
 * The stable `code` is what lets callers — and the regression suite — tell an intended refusal
 * apart from a JavaScript `ReferenceError`.
 *
 * @param loaded - the result of {@link loadProject}.
 * @returns the validated document.
 * @throws {Error} with `code` ∈ {PROFESSOR_PROJECT_MISSING, PROFESSOR_PROJECT_UNSUPPORTED,
 *   PROFESSOR_PROJECT_INVALID}.
 */
export function assertUsableProject(loaded) {
  if (!loaded?.present) {
    const error = new Error('no .professor/project.yaml yet: run professor_project_init first')
    error.code = 'PROFESSOR_PROJECT_MISSING'
    throw error
  }
  if (loaded.document === null || loaded.unsupported !== null) {
    const error = new Error(loaded.problems?.[0] ?? 'project.yaml could not be read')
    error.code = 'PROFESSOR_PROJECT_UNSUPPORTED'
    throw error
  }
  const problems = Array.isArray(loaded.problems) ? loaded.problems : []
  if (problems.length > 0) {
    const error = new Error(`project.yaml is not valid: ${problems.join('; ')}`)
    error.code = 'PROFESSOR_PROJECT_INVALID'
    throw error
  }
  return loaded.document
}

/**
 * Save the project document through the gateway.
 *
 * @throws {Error} with `code = 'PROFESSOR_PROJECT_UNSUPPORTED'` when the file on disk carries a
 *   schema this plugin must not overwrite, and with `code = 'PROFESSOR_PROJECT_INVALID'` when the
 *   document fails validation.
 */
export async function saveProject(options) {
  const {
    gateway, projectRoot, document, session, signal, createOnly = false,
  } = options

  const validation = validateProject(document)
  if (!validation.ok) {
    const error = new Error(`refusing to write an invalid project document: ${validation.errors.join('; ')}`)
    error.code = 'PROFESSOR_PROJECT_INVALID'
    throw error
  }

  const current = await loadProject({ gateway, projectRoot, signal })
  if (Object.hasOwn(options, 'expectedRaw') && current.raw !== options.expectedRaw) {
    const error = new Error('project.yaml changed since it was read; refusing to overwrite concurrent configuration')
    error.code = 'PROFESSOR_PROJECT_STALE'
    throw error
  }
  if (current.unsupported !== null) {
    const error = new Error(current.problems[0])
    error.code = 'PROFESSOR_PROJECT_UNSUPPORTED'
    throw error
  }
  if (createOnly && current.present) {
    const error = new Error('refusing to re-initialise: .professor/project.yaml already exists')
    error.code = 'PROFESSOR_PROJECT_EXISTS'
    throw error
  }

  const layout = projectPaths(projectRoot)
  const writePolicy = options.writePolicy
  if (writePolicy === undefined) {
    const error = new Error('refusing to save the project without a write policy')
    error.code = 'PROFESSOR_PATH_DENIED'
    throw error
  }

  const written = await gateway.writeFile({
    filePath: layout.projectFile,
    cwd: projectRoot,
    content: dumpYamlLite(document),
    session,
    signal,
    writePolicy,
    expected: current.present ? { kind: 'replaceIfVersion', version: current.observedVersion } : { kind: 'createIfAbsent' },
  })

  return { path: written.canonicalPath, operation: written.operation, version: written.version, warnings: validation.warnings }
}
