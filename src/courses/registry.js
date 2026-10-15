/**
 * Course registry operations over the project document.
 *
 * Pure functions: every operation takes a document and returns a new document plus a report. IO
 * (saving, probing source directories) belongs to the tools that call them, which keeps the rules
 * unit-testable without a filesystem.
 *
 * Identity rules:
 * - `course_id` is the stable key referenced by state, notes and reviews; it is derived from the
 *   course code on registration and is immutable afterwards;
 * - `course_code` + `term` must be unique, but the same code in two terms is legitimate;
 * - resolution never guesses: an ambiguous code returns candidates and asks.
 *
 * @module dsh-professor-spike/src/courses/registry
 */

import { courseIdFor, COURSE_STATUSES } from '../project/project.js'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isAbsolutePath = (value) => typeof value === 'string' && value.startsWith('/')

/** Slug used to disambiguate a course id when the same code appears in more than one term. */
function slugify(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function clone(document) {
  return JSON.parse(JSON.stringify(document))
}

function fail(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Every spelling that identifies a course: its id, its code, and the `code-term` composite a user
 * may reasonably type when one code spans two terms.
 */
function matchKeys(course) {
  const termSlug = slugify(course.term)
  const keys = new Set([
    String(course.course_id).toLowerCase(),
    String(course.course_code).toLowerCase(),
  ])
  if (termSlug.length > 0) {
    keys.add(`${String(course.course_code).toLowerCase()}-${termSlug}`)
    keys.add(`${String(course.course_id).toLowerCase()}-${termSlug}`)
  }
  return keys
}

/** Every course, in document order. */
export function listCourses(document) {
  return Array.isArray(document?.courses) ? document.courses : []
}

/** Persisted bindings and UI selections contain stable ids, not ambiguous code queries. */
export function courseById(document, id) {
  return listCourses(document).find(course => course.course_id === id)
}

/**
 * Find courses matching a query (course id or course code, case-insensitive).
 *
 * @returns matching courses, in document order.
 */
export function findCourses(document, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle.length === 0) return []
  return listCourses(document).filter((course) => matchKeys(course).has(needle))
}

/**
 * Resolve a course by id or code.
 *
 * @returns `{ status: 'found', course }`, `{ status: 'ambiguous', candidates }`,
 *   `{ status: 'missing' }`, or `{ status: 'empty' }` when the project has no courses yet.
 */
export function resolveCourse(document, query) {
  const courses = listCourses(document)
  if (courses.length === 0) return { status: 'empty' }

  // Only the number of distinct matches matters: a bare code that also happens to be the first
  // term's id is still ambiguous once it matches more than one course, and ambiguity must ask.
  const matches = findCourses(document, query)
  if (matches.length === 1) return { status: 'found', course: matches[0] }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      candidates: matches.map((course) => ({
        course_id: course.course_id,
        course_code: course.course_code,
        term: course.term,
        display_name: course.display_name,
      })),
    }
  }
  return { status: 'missing' }
}

/**
 * Resolve a search course **filter** with the precedence a filter needs, unlike {@link resolveCourse}.
 *
 * Why a separate entry point: `resolveCourse` asks whenever a query matches more than one course,
 * which is right for "which course do you mean?" — but a search filter that *is* a canonical
 * `course_id` must not be re-interpreted as an ambiguous code just because another course happens
 * to use that spelling as its code. The precedence here is:
 *
 * 1. an exact canonical `course_id` match wins outright;
 * 2. otherwise, a case-insensitive `course_id` match wins when the query identifies no other course
 *    through its code or `code-term` composite ("where safe" — id collisions cannot happen;
 *    id-vs-alias collisions can, and those ask);
 * 3. otherwise a unique alias (code, `code-term`, `id-term`) resolves to its canonical id;
 * 4. multiple remaining matches are `'ambiguous'` with safe candidate identifiers — never a guess;
 * 5. no match is `'missing'` — an unknown filter is an error, never silently dropped.
 *
 * Archived courses remain resolvable (they are still registered); removed courses are simply
 * absent and therefore `'missing'` — resolution never resurrects a registration.
 *
 * @param document - the project document.
 * @param query - the raw `course` filter a caller supplied.
 * @returns `{ status: 'found', course }`, `{ status: 'ambiguous', candidates }`,
 *   `{ status: 'missing' }`, or `{ status: 'empty' }` when the project has no courses yet.
 */
export function resolveCourseFilter(document, query) {
  const needle = String(query ?? '').trim()
  if (needle.length === 0) return { status: 'missing' }
  const courses = listCourses(document)
  if (courses.length === 0) return { status: 'empty' }

  const exactId = courses.filter((course) => course.course_id === needle)
  if (exactId.length === 1) return { status: 'found', course: exactId[0] }
  if (exactId.length > 1) return { status: 'ambiguous', candidates: summarizeCandidates(exactId) }

  const lower = needle.toLowerCase()
  const idMatches = courses.filter((course) => String(course.course_id).toLowerCase() === lower)
  const aliases = findCourses(document, needle)
  if (idMatches.length === 1 && aliases.every((course) => course === idMatches[0])) {
    // The query identifies this course and no other — a case-insensitive id match is safe.
    return { status: 'found', course: idMatches[0] }
  }

  // The query also reaches another course through its code or composite: only the union decides,
  // and a genuine overlap is ambiguous rather than an arbitrary pick.
  const matches = idMatches.length > 0 ? unionById(idMatches, aliases) : aliases
  if (matches.length === 1) return { status: 'found', course: matches[0] }
  if (matches.length > 1) return { status: 'ambiguous', candidates: summarizeCandidates(matches) }
  return { status: 'missing' }
}

function summarizeCandidates(courses) {
  return courses.map((course) => ({
    course_id: course.course_id,
    course_code: course.course_code,
    term: course.term,
    display_name: course.display_name,
  }))
}

function unionById(left, right) {
  const seen = new Set(left.map((course) => course.course_id))
  return [...left, ...right.filter((course) => !seen.has(course.course_id))]
}

/**
 * Resolve a course by id or code, or throw the coded domain error.
 *
 * The single place that turns `resolveCourse`'s status vocabulary into errors. Every tool family
 * that accepts a course argument must go through this: an earlier revision had the session tools
 * accept a course *code* while the state and artifact tools matched the *id* only, so
 * `course: "CSC3200"` worked for binding and failed for notes — a documented contract ("Course id
 * or code") that only half the surface honoured.
 *
 * @param document - the project document.
 * @param query - a course id or code.
 * @returns the matched course.
 * @throws `PROFESSOR_COURSE_MISSING` when nothing matches, `PROFESSOR_COURSE_AMBIGUOUS` when more
 *   than one does. Ambiguity is never resolved by guessing.
 */
export function requireCourse(document, query) {
  const outcome = resolveCourse(document, query)
  if (outcome.status === 'found') return outcome.course
  if (outcome.status === 'empty') {
    const error = new Error('no courses are registered yet: use professor_course_manage to register one first')
    error.code = 'PROFESSOR_COURSE_MISSING'
    throw error
  }
  if (outcome.status === 'ambiguous') {
    const detail = outcome.candidates
      .map((candidate) => `${candidate.course_id} (${candidate.course_code}, ${candidate.term})`)
      .join(', ')
    const error = new Error(`"${query}" is ambiguous: ${detail}. Pass an unambiguous course_id.`)
    error.code = 'PROFESSOR_COURSE_AMBIGUOUS'
    throw error
  }
  const error = new Error(`course "${query}" is not registered`)
  error.code = 'PROFESSOR_COURSE_MISSING'
  throw error
}

/**
 * Register a course.
 *
 * @param document - the project document.
 * @param input - `{ course_code, display_name, term, course_id?, sources?, notes_root?, status? }`.
 * @returns `{ document, course, warnings }` with a new document; the input is not mutated.
 * @throws when identity is missing, duplicated, or a source path is not absolute.
 */
export function registerCourse(document, input) {
  if (!isPlainObject(input)) throw fail('course registration requires an object', 'PROFESSOR_COURSE_INVALID')
  const courseCode = typeof input.course_code === 'string' ? input.course_code.trim() : ''
  const displayName = typeof input.display_name === 'string' ? input.display_name.trim() : ''
  const term = typeof input.term === 'string' ? input.term.trim() : ''
  if (courseCode.length === 0) throw fail('course_code is required', 'PROFESSOR_COURSE_INVALID')
  if (displayName.length === 0) throw fail('display_name is required', 'PROFESSOR_COURSE_INVALID')
  if (term.length === 0) throw fail('term is required (for example "2025-2026 Fall")', 'PROFESSOR_COURSE_INVALID')

  const courses = listCourses(document)
  const taken = (candidate) => courses.some((course) => String(course.course_id).toLowerCase() === candidate.toLowerCase())

  let courseId
  if (typeof input.course_id === 'string' && input.course_id.trim().length > 0) {
    courseId = input.course_id.trim()
    if (taken(courseId)) throw fail(`course_id "${courseId}" is already registered`, 'PROFESSOR_COURSE_EXISTS')
  } else {
    // The same course code may legitimately appear in several terms, so the derived id is
    // disambiguated by term rather than colliding. An explicit course_id always wins.
    const base = courseIdFor(courseCode)
    const termSlug = slugify(term)
    courseId = base
    if (base.length === 0) throw fail(`cannot derive a course_id from "${courseCode}"`, 'PROFESSOR_COURSE_INVALID')
    if (taken(base)) {
      const disambiguated = termSlug.length > 0 ? `${base}-${termSlug}` : ''
      if (disambiguated.length === 0 || taken(disambiguated)) {
        throw fail(
          `course_id "${base}" is already registered and a term-specific id could not be derived; `
          + 'pass an explicit course_id',
          'PROFESSOR_COURSE_EXISTS',
        )
      }
      courseId = disambiguated
    }
  }
  const sameCodeTerm = courses.find((course) => (
    String(course.course_code).toLowerCase() === courseCode.toLowerCase()
    && String(course.term).toLowerCase() === term.toLowerCase()
  ))
  if (sameCodeTerm !== undefined) {
    throw fail(
      `course "${courseCode}" is already registered for term "${term}" as ${sameCodeTerm.course_id}; `
      + 'update that registration instead of creating a duplicate',
      'PROFESSOR_COURSE_EXISTS',
    )
  }

  const status = input.status ?? 'active'
  if (!COURSE_STATUSES.includes(status)) {
    throw fail(`status must be one of ${COURSE_STATUSES.join(' | ')}`, 'PROFESSOR_COURSE_INVALID')
  }

  const sources = []
  for (const source of Array.isArray(input.sources) ? input.sources : []) {
    if (!isPlainObject(source) || !isAbsolutePath(source.path)) {
      throw fail('every source needs an absolute "path"', 'PROFESSOR_COURSE_INVALID')
    }
    sources.push(isPlainObject(source.category_rules) ? { path: source.path, category_rules: source.category_rules } : { path: source.path })
  }

  const course = {
    course_id: courseId,
    course_code: courseCode,
    term,
    display_name: displayName,
    status,
    sources,
    ...(isPlainObject(input.outputs) ? { outputs: clone(input.outputs) } : {}),
    ...(isPlainObject(input.notes) ? { notes: clone(input.notes) } : {}),
    ...(Array.isArray(input.registry_fields) ? { registry_fields: clone(input.registry_fields) } : {}),
  }

  const next = clone(document)
  next.courses = [...listCourses(next), course]

  const warnings = []
  if (sources.length === 0) warnings.push('no source path registered: the course has no material to index yet')
  // Declaring these sources is an explicit decision to index them again, so any marker they cover
  // (including one left by a deleted registration of the very same folder) is cleared.
  return { document: clearCoveredRemovedSources(next, sources.map((source) => source.path)), course, warnings }
}

/**
 * Update mutable fields of a course. Identity (`course_id`, `course_code`) is immutable: rewriting
 * it would orphan the state, notes and reviews that reference the id.
 *
 * @returns `{ document, course, changed }`.
 */
export function updateCourse(document, courseId, patch) {
  if (!isPlainObject(patch)) throw fail('update requires an object', 'PROFESSOR_COURSE_INVALID')
  // `course_id` is the immutable identity referenced by bindings, indexes, notes, state and
  // preference scopes. `course_code` is the *visible* label the learner may edit: changing it
  // never touches any of those records, because they all key on the id.
  const immutable = ['course_id'].filter((field) => patch[field] !== undefined)
  if (immutable.length > 0) {
    throw fail(`${immutable.join(', ')} cannot be changed by an update; archive the course and register the correct identity instead`, 'PROFESSOR_COURSE_IMMUTABLE')
  }

  const next = clone(document)
  const course = listCourses(next).find((entry) => entry.course_id === courseId)
  if (course === undefined) throw fail(`course "${courseId}" is not registered`, 'PROFESSOR_COURSE_MISSING')

  const changed = []
  if (patch.display_name !== undefined) {
    if (typeof patch.display_name !== 'string' || patch.display_name.trim().length === 0) {
      throw fail('display_name must be a non-empty string', 'PROFESSOR_COURSE_INVALID')
    }
    course.display_name = patch.display_name.trim()
    changed.push('display_name')
  }
  if (patch.course_code !== undefined) {
    // Documented rules: surrounding whitespace trimmed; empty/whitespace-only rejected; at most
    // 240 characters (the managed-course identity bound used across the command layer); no control
    // characters. Nothing else is normalized — user-defined codes keep their capitalization and
    // shape exactly as entered (no CSC-style requirement, no silent truncation).
    if (typeof patch.course_code !== 'string') {
      throw fail('course_code must be a string', 'PROFESSOR_COURSE_INVALID')
    }
    const trimmed = patch.course_code.trim()
    if (trimmed.length === 0) throw fail('course_code must not be empty or whitespace', 'PROFESSOR_COURSE_INVALID')
    if (trimmed.length > 240) throw fail('course_code must be at most 240 characters', 'PROFESSOR_COURSE_INVALID')
    if (/[\x00-\x1f\x7f]/u.test(trimmed)) throw fail('course_code must not contain control characters', 'PROFESSOR_COURSE_INVALID')
    course.course_code = trimmed
    changed.push('course_code')
  }
  if (patch.term !== undefined) {
    if (typeof patch.term !== 'string' || patch.term.trim().length === 0) {
      throw fail('term must be a non-empty string', 'PROFESSOR_COURSE_INVALID')
    }
    course.term = patch.term.trim()
    changed.push('term')
  }
  if (patch.course_code !== undefined || patch.term !== undefined) {
    // The registry's one label-uniqueness rule: the same code (case-insensitive) in the same term
    // (case-insensitive) may exist only once. The same code across different terms stays legal,
    // and resolution keeps reporting it as ambiguous rather than picking one.
    const clash = listCourses(next).some((entry) => (
      entry.course_id !== courseId
      && String(entry.course_code).toLowerCase() === String(course.course_code).toLowerCase()
      && String(entry.term).toLowerCase() === String(course.term).toLowerCase()
    ))
    if (clash) throw fail(`another registration already covers ${course.course_code} in term "${course.term}"`, 'PROFESSOR_COURSE_EXISTS')
  }
  if (patch.status !== undefined) {
    if (!COURSE_STATUSES.includes(patch.status)) {
      throw fail(`status must be one of ${COURSE_STATUSES.join(' | ')}`, 'PROFESSOR_COURSE_INVALID')
    }
    course.status = patch.status
    changed.push('status')
  }
  if (patch.sources !== undefined) {
    if (!Array.isArray(patch.sources)) throw fail('sources must be a list', 'PROFESSOR_COURSE_INVALID')
    const sources = []
    for (const source of patch.sources) {
      if (!isPlainObject(source) || !isAbsolutePath(source.path)) {
        throw fail('every source needs an absolute "path"', 'PROFESSOR_COURSE_INVALID')
      }
      sources.push(isPlainObject(source.category_rules) ? { path: source.path, category_rules: source.category_rules } : { path: source.path })
    }
    course.sources = sources
    changed.push('sources')
  }

  // Only an explicit source change speaks for the material roots; renaming or archiving a course
  // must never silently lift a marker left by a deleted registration.
  const result = patch.sources === undefined ? next : clearCoveredRemovedSources(next, course.sources.map((source) => source.path))
  return { document: result, course, changed }
}

/**
 * Archive (or reactivate) a course. Nothing is deleted: material, notes, reviews and state stay
 * exactly where they are.
 */
export function setCourseStatus(document, courseId, status) {
  return updateCourse(document, courseId, { status })
}

// --- deletion ----------------------------------------------------------------
//
// Deleting a course removes the *registration* and marks the material it owned so a later index
// rebuild cannot bring it back as an unassigned, searchable corpus. Everything else — source files,
// notes, reviews, learning state, course memory and binding history — is untouched, because none of
// it lives in this document.

/** The document key holding the source roots whose material must not re-enter the index. */
export const REMOVED_SOURCES_KEY = 'removed_sources'

/** `parent` covers `child`: the same path, or `child` beneath `parent` (posix separators). */
function coversPath(parent, child) {
  return child === parent || child.startsWith(`${parent}/`)
}

/**
 * Record source roots whose material a deleted course used to own.
 *
 * The list is minimal: a path already covered by a shorter one is dropped, so markers never
 * accumulate redundantly. The user's own `indexing.exclude` is a different list and is never
 * written here — deletion and user exclusions must not be able to affect each other.
 *
 * @param document - the project document (not mutated).
 * @param paths - absolute paths to remember.
 * @returns a new document; an empty result removes the key entirely so re-adding is observable.
 */
export function recordRemovedSources(document, paths) {
  const incoming = (Array.isArray(paths) ? paths : [])
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
  const existing = Array.isArray(document?.indexing?.[REMOVED_SOURCES_KEY])
    ? document.indexing[REMOVED_SOURCES_KEY].filter((value) => typeof value === 'string' && value.length > 0)
    : []

  // Shortest first, so a covering root is kept and anything it already covers is dropped.
  const merged = [...new Set([...existing, ...incoming])]
    .sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0))
  const minimal = merged.filter((candidate, index) => (
    index === 0 || !merged.slice(0, index).some((kept) => coversPath(kept, candidate))
  )).sort()

  const next = clone(document)
  if (minimal.length === 0) {
    if (isPlainObject(next.indexing)) delete next.indexing[REMOVED_SOURCES_KEY]
    return next
  }
  next.indexing = { ...(isPlainObject(next.indexing) ? next.indexing : {}), [REMOVED_SOURCES_KEY]: minimal }
  return next
}

/**
 * Drop the markers a newly declared set of source roots makes obsolete.
 *
 * A marker is cleared only when a new source **covers** it: re-adding the same folder clears its own
 * marker, and registering a parent folder clears the markers beneath it. Registering a *sub-folder*
 * deliberately leaves the rest of a deleted folder excluded, and a course that merely lives inside a
 * deleted folder's marker never clears it.
 */
function clearCoveredRemovedSources(document, sourcePaths) {
  const markers = Array.isArray(document?.indexing?.[REMOVED_SOURCES_KEY])
    ? document.indexing[REMOVED_SOURCES_KEY]
    : []
  if (markers.length === 0) return document
  const sources = sourcePaths.filter((value) => typeof value === 'string' && value.length > 0)
  const keep = markers.filter((marker) => !sources.some((source) => coversPath(source, marker)))
  if (keep.length === markers.length) return document

  const next = clone(document)
  if (keep.length === 0) delete next.indexing[REMOVED_SOURCES_KEY]
  else next.indexing = { ...(next.indexing ?? {}), [REMOVED_SOURCES_KEY]: keep }
  return next
}

/**
 * Remove one course registration.
 *
 * Nothing else changes: other courses, outputs, notes configuration and every learning artefact
 * stay exactly as they were. The caller records the removed source roots with
 * {@link recordRemovedSources} and cleans the derived index before saving — see
 * `docs/superpowers/plans/2026-10-09-delete-and-polish.md` for the ordering.
 *
 * @returns `{ document, course }` with a new document; the input is not mutated.
 * @throws `PROFESSOR_COURSE_MISSING` when no such course is registered.
 */
export function removeCourse(document, courseId) {
  const next = clone(document)
  const course = listCourses(next).find((entry) => entry.course_id === courseId)
  if (course === undefined) throw fail(`course "${courseId}" is not registered`, 'PROFESSOR_COURSE_MISSING')
  next.courses = listCourses(next).filter((entry) => entry.course_id !== courseId)
  return { document: next, course }
}

/** ASCII table of the registered courses, for tool output. */
export function summarizeCourses(document) {
  return listCourses(document).map((course) => ({
    course_id: course.course_id,
    course_code: course.course_code,
    term: course.term,
    display_name: course.display_name,
    status: course.status ?? 'active',
    active: (course.status ?? 'active') === 'active',
    source_count: Array.isArray(course.sources) ? course.sources.length : 0,
    sources: (Array.isArray(course.sources) ? course.sources : []).map((source) => source.path),
    outputs: course.outputs ?? {},
    notes: course.notes ?? {},
    registry_fields: course.registry_fields ?? [],
  }))
}

/**
 * Validate every registered source path.
 *
 * @param options.isDirectory - injectable probe (`async (path) => boolean`).
 * @returns per-course reports plus a flat list of problems.
 */
export async function validateSources(document, { isDirectory }) {
  const courses = []
  const problems = []
  for (const course of listCourses(document)) {
    const sources = []
    for (const source of Array.isArray(course.sources) ? course.sources : []) {
      const exists = await isDirectory(source.path)
      sources.push({ path: source.path, exists })
      if (!exists) problems.push(`${course.course_id}: source path does not exist or is not a directory: ${source.path}`)
    }
    const outputs = []
    for (const [key, value] of Object.entries(document.outputs ?? {})) {
      if (value === null || value === undefined) continue
      const exists = await isDirectory(value)
      outputs.push({ key, path: value, exists })
      if (!exists) problems.push(`${course.course_id}: outputs.${key} does not exist: ${value}`)
    }
    courses.push({ course_id: course.course_id, sources, outputs })
  }
  return { courses, problems }
}
