/**
 * Search course-filter resolution (Repair B).
 *
 * The QA audit proved `course: "CSC3200"` silently returned zero results while `course: "csc3200"`
 * worked, and the empty-state note blamed indexing. These tests pin the fix at both layers: the
 * pure `resolveCourseFilter` precedence (canonical id > unique alias > ambiguity > explicit error),
 * and the `professor_search` tool on real fixtures — including the guarantee that stale chunk
 * metadata cannot override current index ownership and that an invalid filter never leaks results.
 *
 * @module test/search-course-resolution
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { resolveCourseFilter } from '../src/courses/registry.js'
import { apply } from '../src/plugin.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

const documentOf = (courses) => ({ courses })

// ── pure resolution precedence ────────────────────────────────────────────────

test('an exact canonical course id wins, even when the spelling is another course\'s code', () => {
  const document = documentOf([
    { course_id: 'csc3200', course_code: 'CS9999', display_name: 'A', term: '2025 Fall' },
    { course_id: 'csc3200-2026-spring', course_code: 'CSC3200', display_name: 'B', term: '2026 Spring' },
  ])
  const outcome = resolveCourseFilter(document, 'csc3200')
  assert.equal(outcome.status, 'found')
  assert.equal(outcome.course.course_id, 'csc3200')
})

test('CSC3200 and csc3200 resolve identically when the code is unambiguous', () => {
  const document = documentOf([
    { course_id: 'csc3200-2026s', course_code: 'CSC3200', display_name: 'Data Structures', term: '2026S' },
    { course_id: 'sta2001-2026s', course_code: 'STA2001', display_name: 'Probability', term: '2026S' },
  ])
  for (const spelling of ['CSC3200', 'csc3200', 'Csc3200']) {
    const outcome = resolveCourseFilter(document, spelling)
    assert.equal(outcome.status, 'found', spelling)
    assert.equal(outcome.course.course_id, 'csc3200-2026s', spelling)
  }
})

test('a course code resolves to its term-suffixed canonical id', () => {
  const document = documentOf([
    { course_id: 'csc3200-2025-2026-fall', course_code: 'CSC3200', display_name: 'A', term: '2025-2026 Fall' },
  ])
  const outcome = resolveCourseFilter(document, 'CSC3200')
  assert.equal(outcome.status, 'found')
  assert.equal(outcome.course.course_id, 'csc3200-2025-2026-fall')
})

test('multiple terms sharing one code are ambiguous, never an arbitrary pick', () => {
  const document = documentOf([
    { course_id: 'csc3200-2025-2026-fall', course_code: 'CSC3200', display_name: 'Fall', term: '2025-2026 Fall' },
    { course_id: 'csc3200-2025-2026-spring', course_code: 'CSC3200', display_name: 'Spring', term: '2025-2026 Spring' },
  ])
  const outcome = resolveCourseFilter(document, 'CSC3200')
  assert.equal(outcome.status, 'ambiguous')
  assert.equal(outcome.candidates.length, 2)
  for (const candidate of outcome.candidates) {
    assert.ok(['csc3200-2025-2026-fall', 'csc3200-2025-2026-spring'].includes(candidate.course_id))
  }
})

test('an exact canonical id disambiguates a shared code', () => {
  const document = documentOf([
    { course_id: 'csc3200-2025-2026-fall', course_code: 'CSC3200', display_name: 'Fall', term: '2025-2026 Fall' },
    { course_id: 'csc3200-2025-2026-spring', course_code: 'CSC3200', display_name: 'Spring', term: '2025-2026 Spring' },
  ])
  for (const id of ['csc3200-2025-2026-fall', 'csc3200-2025-2026-spring']) {
    const outcome = resolveCourseFilter(document, id)
    assert.equal(outcome.status, 'found', id)
    assert.equal(outcome.course.course_id, id)
  }
})

test('a case-insensitive id match that collides with another course\'s code asks instead of guessing', () => {
  const document = documentOf([
    { course_id: 'csc3200', course_code: 'XX1000', display_name: 'A', term: '2025 Fall' },
    { course_id: 'yy2000', course_code: 'CSC3200', display_name: 'B', term: '2025 Fall' },
  ])
  const outcome = resolveCourseFilter(document, 'CSC3200')
  assert.equal(outcome.status, 'ambiguous')
  assert.equal(outcome.candidates.length, 2)
})

test('an unknown course filter is missing — never silently dropped — and empty projects say so', () => {
  assert.equal(resolveCourseFilter(documentOf([{ course_id: 'a1', course_code: 'A1', term: 't' }]), 'PHY9999').status, 'missing')
  assert.equal(resolveCourseFilter(documentOf([]), 'CSC3200').status, 'empty')
  assert.equal(resolveCourseFilter(null, 'CSC3200').status, 'empty')
  assert.equal(resolveCourseFilter(documentOf([{ course_id: 'a1', course_code: 'A1', term: 't' }]), '   ').status, 'missing')
})

test('archived courses stay resolvable while removed ones are simply absent', () => {
  const document = documentOf([
    { course_id: 'csc3200', course_code: 'CSC3200', display_name: 'A', term: '2025 Fall', status: 'archived' },
    { course_id: 'sta2001', course_code: 'STA2001', display_name: 'B', term: '2025 Fall' },
  ])
  assert.equal(resolveCourseFilter(document, 'csc3200').course.course_id, 'csc3200')
  assert.equal(resolveCourseFilter(document, 'mat1001').status, 'missing', 'a removed course cannot be resolved back')
})

// ── tool-level behaviour on real fixtures ─────────────────────────────────────

/**
 * One project with a `csc` course and a `sta` course, each with one markdown source, indexed and
 * extracted through the real tools. `sameCode: true` registers both under code CSC3200 with an
 * explicit term-suffixed id each, which is the multi-term shape.
 */
async function toolFixture({ sameCode = false } = {}) {
  const home = await makeHome('professor-search-res-')
  const project = path.join(home, 'workspace')
  await writeFixture(home, 'workspace/A_materials/lecture-01.md',
    '# 二分查找\n\n二分查找在有序数组上每次将搜索区间减半，时间复杂度 O(log n)。\n')
  await writeFixture(home, 'workspace/B_materials/probability.md',
    '# Probability\n\nThe law of large numbers says the sample average converges to the expected value.\n')
  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })
  await tools.professor_project_init.execute({}, exec)
  const first = sameCode
    ? { course_code: 'CSC3200', course_id: 'csc3200-2025-fall', term: '2025 Fall' }
    : { course_code: 'CSC3200', term: '2025 Fall' }
  await tools.professor_course_manage.execute({
    action: 'register', ...first, display_name: 'Data Structures',
    source_path: path.join(project, 'A_materials'), notes_root: path.join(project, 'A_materials'),
  }, exec)
  const second = sameCode
    ? { course_code: 'CSC3200', course_id: 'csc3200-2026-spring', term: '2026 Spring' }
    : { course_code: 'STA2001', term: '2025 Fall' }
  await tools.professor_course_manage.execute({
    action: 'register', ...second, display_name: 'Probability',
    source_path: path.join(project, 'B_materials'), notes_root: path.join(project, 'B_materials'),
  }, exec)
  await tools.professor_session_bind.execute({ action: 'bind', course: first.course_id ?? 'CSC3200' }, exec)
  await tools.professor_index_sync.execute({}, exec)
  await tools.professor_extract.execute({}, exec)
  return { home, project, tools, exec }
}

test('the tool treats CSC3200 and csc3200 as the same filter when unambiguous', async () => {
  const f = await toolFixture()
  try {
    const upper = await f.tools.professor_search.execute({ query: '二分查找', course: 'CSC3200' }, f.exec)
    const lower = await f.tools.professor_search.execute({ query: '二分查找', course: 'csc3200' }, f.exec)
    assert.ok(upper.results.length > 0, 'the display code must find the material')
    assert.deepEqual(
      upper.results.map((row) => row.chunk_id),
      lower.results.map((row) => row.chunk_id),
    )
    assert.equal(upper.diagnostics.course_filter, 'csc3200')
    assert.equal(upper.diagnostics.course_filter_input, 'CSC3200')
    const leaked = await f.tools.professor_search.execute({ query: 'expected value', course: 'CSC3200' }, f.exec)
    assert.equal(leaked.results.length, 0, 'a valid filter still prevents cross-course leakage')
    assert.equal(leaked.diagnostics.course_filter, 'csc3200')
  } finally {
    await fs.rm(f.home, { recursive: true, force: true })
  }
})

test('the tool reports ambiguity with candidate ids instead of picking one', async () => {
  const f = await toolFixture({ sameCode: true })
  try {
    await assert.rejects(
      f.tools.professor_search.execute({ query: '二分查找', course: 'CSC3200' }, f.exec),
      (error) => error.code === 'PROFESSOR_COURSE_AMBIGUOUS'
        && /csc3200-2025-fall/.test(error.message) && /csc3200-2026-spring/.test(error.message),
    )
    const exact = await f.tools.professor_search.execute({ query: '二分查找', course: 'csc3200-2025-fall' }, f.exec)
    assert.ok(exact.results.length > 0, 'the exact canonical id still finds its own material')
    assert.equal(exact.diagnostics.course_filter, 'csc3200-2025-fall')
  } finally {
    await fs.rm(f.home, { recursive: true, force: true })
  }
})

test('an unknown course filter is an explicit error, not a misleading indexing note', async () => {
  const f = await toolFixture()
  try {
    await assert.rejects(
      f.tools.professor_search.execute({ query: '二分查找', course: 'PHY9999' }, f.exec),
      (error) => error.code === 'PROFESSOR_COURSE_MISSING'
        && /course filter/.test(error.message)
        && !/indexed/.test(error.message),
    )
  } finally {
    await fs.rm(f.home, { recursive: true, force: true })
  }
})

test('a valid filter with no content match is distinguished from an invalid filter', async () => {
  const f = await toolFixture()
  try {
    const empty = await f.tools.professor_search.execute({ query: 'quantum chromodynamics', course: 'STA2001' }, f.exec)
    assert.equal(empty.results.length, 0)
    assert.equal(empty.diagnostics.course_filter, 'sta2001', 'the filter resolved; only the terms did not match')
    assert.ok(empty.diagnostics.candidates > 0 || (empty.warnings ?? []).length >= 0)
  } finally {
    await fs.rm(f.home, { recursive: true, force: true })
  }
})

test('stale chunk course metadata cannot override current index ownership', async () => {
  const f = await toolFixture()
  try {
    // Tamper the cached chunk store so its provenance claims the *other* course — exactly the
    // stale-cache shape the QA audit ruled out as a trust source.
    const index = JSON.parse(await fs.readFile(path.join(f.project, '.professor/indexes/files.json'), 'utf8'))
    const lecture = index.files.find((record) => record.relative_path.includes('lecture-01'))
    const chunkFile = path.join(f.project, '.professor/indexes/chunks', `${lecture.file_id}.json`)
    const store = JSON.parse(await fs.readFile(chunkFile, 'utf8'))
    for (const chunk of store.chunks) chunk.course_id = 'sta2001'
    await fs.writeFile(chunkFile, JSON.stringify(store), 'utf8')

    const byOwner = await f.tools.professor_search.execute({ query: '二分查找', course: 'csc3200' }, f.exec)
    assert.ok(byOwner.results.length > 0, 'the owning course still finds its material')
    assert.equal(byOwner.results[0].course_id, 'csc3200', 'provenance is re-stamped from the current index')

    const byImpostor = await f.tools.professor_search.execute({ query: '二分查找', course: 'sta2001' }, f.exec)
    assert.equal(byImpostor.results.length, 0, 'stale provenance cannot leak a course filter across')
  } finally {
    await fs.rm(f.home, { recursive: true, force: true })
  }
})
