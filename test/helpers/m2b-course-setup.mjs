/**
 * The course-setup and preflight sequence the M2b case depends on, shared by the formal runner,
 * the zero-cost preparation and the regression tests so the three cannot drift apart.
 *
 * Why this exists as one module rather than three copies
 * -----------------------------------------------------
 * Registering a course **without** `source_path` succeeds: every tool returns an `isError: false`
 * envelope, the project is written, the file is indexed and extracted. What it does *not* do is
 * associate the material with the course — the course keeps an empty source list, the index record
 * stays `course_id: null` / `category: unassigned`, and because `professor_search` filters on
 * `record.course_id`, a course-scoped search returns nothing. A case built that way has nothing to
 * ground against, and the only sign of it would be a paid request spent on an empty context.
 *
 * So the setup is expressed once here, and {@link verifyCourseMaterial} is the preflight that reads
 * back **actual tool results and the index on disk** — never an envelope's `isError` — and names
 * every condition that must hold before any request is spent.
 *
 * Contract for `execute`: `async (name, args) => payload`, returning the tool's parsed JSON payload
 * and **throwing** on a tool error. The packaged runner supplies a wrapper around
 * `executeTool`/`resultJson`; a test supplies `tools[name].execute(args, exec)`. Both behave the
 * same way, which is what lets the preflight be exercised for free.
 *
 * @module test/helpers/m2b-course-setup
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { COURSE_CODE, COURSE_ID, SOURCE_RELATIVE_PATH } from './source-grounded-fixture.mjs'

/** The query the preflight uses to prove course-scoped retrieval returns the source itself. */
export const RETRIEVAL_PREFLIGHT_QUERY = 'average probes clustering linear probing'

/**
 * The ordered production-tool steps that build the M2b project.
 *
 * `source_path` is a **directory**, and it is the parameter that associates the material with the
 * course. It is not optional for this case: `professor_course_manage` accepts a registration
 * without it and silently produces a course that owns no material.
 *
 * @param options.materialRoot - absolute path of the course material root (the directory).
 * @param options.projectId - project id for `professor_project_init`.
 */
export function courseSetupSteps({ materialRoot, projectId = 'm2b-term' }) {
  return [
    ['professor_project_init', { project_id: projectId }],
    ['professor_course_manage', {
      action: 'register',
      course_code: COURSE_CODE,
      display_name: 'Synthetic Data Structures',
      term: '2026-Synthetic',
      source_path: materialRoot,
    }],
    ['professor_index_sync', {}],
    ['professor_extract', {}],
    ['professor_session_bind', { course: COURSE_ID }],
  ]
}

/**
 * Run the setup steps in order, stopping at the first failure.
 *
 * @returns `{ ok, steps, results }` — `steps` records each tool by name with its error text, and
 *   `results` holds each tool's parsed payload so callers can quote real tool output.
 */
export async function runCourseSetup({ execute, materialRoot, projectId = 'm2b-term' }) {
  const steps = []
  const results = {}
  for (const [name, args] of courseSetupSteps({ materialRoot, projectId })) {
    let payload = null
    let problem = null
    try {
      payload = await execute(name, args)
    } catch (error) {
      problem = error?.message ?? String(error)
    }
    const isError = problem !== null || payload === null || payload === undefined
    steps.push({ name, isError, problem: isError ? (problem ?? 'tool returned no payload') : null })
    results[name] = payload
    if (isError) break
  }
  return { ok: steps.every((step) => step.isError === false), steps, results }
}

/**
 * Preflight: read back what the setup actually produced, from tool results and the index on disk.
 *
 * Every condition here is one an authorized M2b run would otherwise discover only after spending a
 * request. Nothing is inferred from an `isError: false` envelope, and nothing is derived from the
 * setup's own report of success.
 *
 * @param options.execute - the tool bridge described above.
 * @param options.workspace - the project root, so the index can be read back from disk.
 * @param options.materialRoot - the directory that must be registered on the course.
 * @param options.independentHash - a sha256 computed by the caller, never taken from a tool.
 * @returns `{ ok, problems, evidence }`.
 */
export async function verifyCourseMaterial({
  execute, workspace, materialRoot, independentHash,
  sourceRelativePath = SOURCE_RELATIVE_PATH, courseId = COURSE_ID,
  query = RETRIEVAL_PREFLIGHT_QUERY,
}) {
  const problems = []
  const evidence = {
    query, source_relative_path: sourceRelativePath, course_id: courseId,
    independent_sha256: independentHash,
  }

  // ---- exactly one selected course, owning the material ---------------------------------
  const listed = await execute('professor_course_list', {})
  const courses = Array.isArray(listed?.courses) ? listed.courses : []
  const selected = courses.filter((course) => course.active !== false && course.status !== 'archived')
  evidence.course_list = {
    courses: courses.map((course) => ({
      course_id: course.course_id,
      status: course.status,
      source_count: course.source_count,
      sources: course.sources,
    })),
    assignment: listed?.assignment ?? null,
    problems: listed?.problems ?? [],
  }
  if (selected.length !== 1) {
    problems.push(`expected exactly one selected course, found ${selected.length} `
      + `(${courses.map((course) => course.course_id).join(', ') || 'none'})`)
  } else if (selected[0].course_id !== courseId) {
    problems.push(`the selected course is ${JSON.stringify(selected[0].course_id)}, expected `
      + `${JSON.stringify(courseId)}`)
  } else if (!Array.isArray(selected[0].sources) || !selected[0].sources.includes(materialRoot)) {
    problems.push(`course ${courseId} does not own the material root: its registered sources are `
      + `${JSON.stringify(selected[0].sources ?? null)}, expected to include ${materialRoot}`)
  }
  const unassignedCount = listed?.assignment?.unassigned?.count ?? null
  if (typeof unassignedCount === 'number' && unassignedCount > 0) {
    problems.push(`${unassignedCount} indexed file(s) are unassigned to any course `
      + `(${JSON.stringify(listed.assignment.unassigned.sample ?? [])}); the source is not bound to `
      + 'the course the case is scoped to')
  }
  if (Array.isArray(listed?.problems) && listed.problems.length > 0) {
    problems.push(`professor_course_list reports problems: ${listed.problems.join('; ')}`)
  }

  // ---- the session is bound to that same course ------------------------------------------
  const status = await execute('professor_session_status', {})
  evidence.session_status = {
    bound: status?.bound ?? null, course_id: status?.course_id ?? null,
  }
  if (status?.bound !== true || status?.course_id !== courseId) {
    problems.push(`the session is not bound to ${courseId}: bound=${JSON.stringify(status?.bound ?? null)} `
      + `course_id=${JSON.stringify(status?.course_id ?? null)}`)
  }

  // ---- the index record itself: id, hash, course ------------------------------------------
  const indexFile = path.join(workspace, '.professor', 'indexes', 'files.json')
  let record = null
  try {
    const document = JSON.parse(await fs.readFile(indexFile, 'utf8'))
    const records = Array.isArray(document.files) ? document.files : Object.values(document.files ?? {})
    record = records.find((entry) => entry.relative_path === sourceRelativePath) ?? null
  } catch (error) {
    problems.push(`the index could not be read back from ${indexFile}: ${error.message}`)
  }
  evidence.index_record = record === null ? null : {
    file_id: record.file_id,
    content_hash: record.content_hash,
    course_id: record.course_id,
    category: record.category ?? null,
    index_status: record.index_status ?? null,
    extraction_status: record.extraction_status ?? null,
  }
  if (record === null) {
    problems.push(`the index holds no record for ${sourceRelativePath}`)
  } else {
    if (!/^f_/.test(String(record.file_id))) {
      problems.push(`the index record has no stable file id: ${JSON.stringify(record.file_id)}`)
    }
    if (record.content_hash !== independentHash) {
      problems.push(`the index content hash ${JSON.stringify(record.content_hash)} does not equal the `
        + `independently computed ${JSON.stringify(independentHash)}`)
    }
    if (record.course_id !== courseId) {
      problems.push(`the index record's course_id is ${JSON.stringify(record.course_id)}, expected `
        + `${JSON.stringify(courseId)} — the file is indexed but not assigned to the course`)
    }
    if (record.index_status !== 'indexed') {
      problems.push(`index_status is ${JSON.stringify(record.index_status)}, expected "indexed"`)
    }
  }

  // ---- a course-scoped search actually returns the source --------------------------------
  //
  // A hit is citable only if it carries a coordinate the note can quote. A PDF chunk carries a
  // page; a markdown chunk has no page at all and is cited by line range. Requiring a page here
  // would reject a perfectly grounded markdown case, so the preflight requires *a* coordinate and
  // records which kind it got — which is also what stops a hit with no usable position from being
  // credited as delivered coverage.
  const search = await execute('professor_search', { query, course: courseId })
  const hits = Array.isArray(search?.results) ? search.results : []
  const onSource = record === null ? [] : hits.filter((hit) => hit.file_id === record.file_id)
  const coordinateOf = (hit) => {
    if (Number.isInteger(hit.page) && hit.page >= 1) return { kind: 'page', value: hit.page }
    if (Array.isArray(hit.page_range) && hit.page_range.length > 0) {
      return { kind: 'page_range', value: hit.page_range }
    }
    if (Number.isInteger(hit.slide) && hit.slide >= 1) return { kind: 'slide', value: hit.slide }
    if (Number.isInteger(hit.start_line) && hit.start_line >= 1) {
      return { kind: 'lines', value: `${hit.start_line}-${hit.end_line ?? hit.start_line}` }
    }
    return null
  }
  evidence.retrieval = {
    total_hits: hits.length,
    hits_on_source: onSource.map((hit) => ({
      chunk_id: hit.chunk_id, coordinate: coordinateOf(hit),
    })),
    returned_pages: [...new Set(onSource.map((hit) => hit.page).filter(Number.isInteger))]
      .sort((a, b) => a - b),
  }
  if (onSource.length === 0) {
    problems.push(`a course-scoped search for ${JSON.stringify(query)} returned ${hits.length} hit(s) `
      + `and none of them were ${sourceRelativePath}; the case would have nothing to ground against`)
  } else if (!onSource.every((hit) => coordinateOf(hit) !== null)) {
    problems.push('a retrieval hit for the source carries no citable coordinate (no page, page '
      + 'range, slide or line range), so it cannot be credited as delivered coverage')
  }

  return { ok: problems.length === 0, problems, evidence }
}
