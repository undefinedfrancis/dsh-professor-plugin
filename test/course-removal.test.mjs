/**
 * Course deletion: registration removal, derived-index removal, rebuild non-resurrection, re-add.
 *
 * What is pinned here, mapped to the approved deletion semantics
 * (`docs/superpowers/plans/2026-10-09-delete-and-polish.md`):
 *
 * 1. **Registration only** — deleting drops the course from the project document; every other
 *    registration is untouched and the input document is never mutated in place.
 * 2. **Derived data only** — the removed course's index records disappear, so Professor search
 *    cannot return them; a surviving course that shares the same source keeps its records.
 * 3. **Originals are sacred** — course material bytes, notes, learning state, course memory and
 *    binding history are unchanged.
 * 4. **A rebuild must not resurrect it** — the deleted source roots are recorded separately from
 *    the user's own `indexing.exclude`, and a later index build drops the folder's unassigned
 *    records instead of promoting them into a searchable corpus.
 * 5. **Explicit re-add works** — registering the same material folder clears its tombstone, and
 *    the user's unrelated exclusions survive.
 * 6. **Guarded** — the deletion is refused without an explicit confirmation and refuses a stale
 *    configuration digest.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import {
  listCourses, recordRemovedSources, registerCourse, removeCourse,
} from '../src/courses/registry.js'
import { planCourseIndexRemoval } from '../src/courses/removal.js'
import { removedSourcePrefixes } from '../src/indexer/exclude.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

async function hashTree(root) {
  const out = {}
  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(target)
      else out[path.relative(root, target)] = sha256(await fs.readFile(target))
    }
  }
  await walk(root)
  return out
}

/** Two registered courses plus one that shares a source directory with the first. */
async function scenario() {
  const home = await makeHome('professor-removal-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/CSC3200/01_Lectures/lecture-01.md',
    '# Binary Search\n\nBinary search divides a sorted array in half.\n')
  await writeFixture(home, 'courses/term/CSC3200/03_Assignments/hw1.md',
    '# Homework 1\n\nImplement a lexer for the toy language.\n')
  await writeFixture(home, 'courses/term/GFN1000/notes.md',
    '# Grading\n\nThe portfolio counts for forty percent.\n')

  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })

  await tools.professor_project_init.execute({ project_id: 'term-2026' }, exec)
  await tools.professor_course_manage.execute({
    action: 'register', course_code: 'CSC3200', display_name: 'DSA', term: '2025-2026 Fall',
    source_path: path.join(project, 'CSC3200'),
  }, exec)
  await tools.professor_course_manage.execute({
    action: 'register', course_code: 'GFN1000', display_name: 'GFN', term: '2025-2026 Fall',
    source_path: path.join(project, 'GFN1000'),
  }, exec)
  // A second registration whose source is a sub-directory of CSC3200: deleting CSC3200 must not
  // take this course's indexing with it.
  await tools.professor_course_manage.execute({
    action: 'register', course_code: 'LAB3200', display_name: 'Lab', term: '2025-2026 Fall',
    source_path: path.join(project, 'CSC3200', '01_Lectures'),
  }, exec)
  await tools.professor_index_sync.execute({}, exec)
  await tools.professor_extract.execute({}, exec)

  return { home, project, tools, exec, fake }
}

const readIndex = async (project) => JSON.parse(await fs.readFile(path.join(project, '.professor', 'indexes', 'files.json'), 'utf8'))
const readProject = async (project) => fs.readFile(path.join(project, '.professor', 'project.yaml'), 'utf8')
const indexPaths = async (project) => (await readIndex(project)).files.map((record) => record.relative_path)

// --- registry ---------------------------------------------------------------

test('removing a course drops only its registration and records a removal marker', async () => {
  const document = {
    schema_version: 1,
    project: { id: 'p', name: 'p' },
    courses: [
      { course_id: 'csc3200', course_code: 'CSC3200', term: 'T', display_name: 'DSA', status: 'active', sources: [{ path: '/a/CSC3200' }] },
      { course_id: 'gfn1000', course_code: 'GFN1000', term: 'T', display_name: 'GFN', status: 'archived', sources: [{ path: '/a/GFN1000' }] },
    ],
    indexing: { exclude: ['/a/keep-out'], follow_symlinks: false },
  }

  const { document: next, course } = removeCourse(document, 'csc3200')
  assert.equal(course.course_id, 'csc3200')
  assert.deepEqual(listCourses(next).map((entry) => entry.course_id), ['gfn1000'])
  assert.equal(listCourses(document).length, 2, 'the input document is never mutated')
  assert.deepEqual(next.indexing.exclude, ['/a/keep-out'], "the user's own exclusions are untouched")

  const marked = recordRemovedSources(next, course.sources.map((source) => source.path))
  assert.deepEqual(marked.indexing.removed_sources, ['/a/CSC3200'])
  assert.deepEqual(marked.indexing.exclude, ['/a/keep-out'])

  assert.throws(() => removeCourse(document, 'missing'), { code: 'PROFESSOR_COURSE_MISSING' })
  assert.deepEqual(recordRemovedSources(next, ['/a/CSC3200', '/a/other']).indexing.removed_sources,
    ['/a/CSC3200', '/a/other'], 'markers are deduplicated and stable')
})

test('re-registering covered material clears its marker and keeps unrelated exclusions', () => {
  const base = {
    schema_version: 1,
    project: { id: 'p', name: 'p' },
    courses: [],
    indexing: { exclude: ['/a/keep-out'], follow_symlinks: false, removed_sources: ['/a/CSC3200', '/a/older'] },
  }

  const same = registerCourse(base, {
    course_code: 'CSC3200', display_name: 'DSA', term: '2025-2026 Fall', sources: [{ path: '/a/CSC3200' }],
  })
  assert.equal(same.document.indexing.removed_sources?.includes('/a/CSC3200'), false)
  assert.deepEqual(same.document.indexing.removed_sources, ['/a/older'])
  assert.deepEqual(same.document.indexing.exclude, ['/a/keep-out'])

  const nested = registerCourse(base, {
    course_code: 'LAB3200', display_name: 'Lab', term: '2025-2026 Fall', sources: [{ path: '/a/CSC3200/01_Lectures' }],
  })
  assert.deepEqual(nested.document.indexing.removed_sources, ['/a/CSC3200', '/a/older'],
    'registering a sub-folder does not re-open the rest of a deleted folder')

  assert.deepEqual(base.indexing.removed_sources, ['/a/CSC3200', '/a/older'], 'the input is never mutated')
})

// --- index planner ----------------------------------------------------------

test('the removal planner drops exclusively owned records and keeps shared ones with the survivor', () => {
  const document = {
    schema_version: 1,
    project: { id: 'p', name: 'p' },
    courses: [
      { course_id: 'csc3200', course_code: 'CSC3200', term: 'T', display_name: 'DSA', status: 'active', sources: [{ path: '/p/CSC3200' }] },
      { course_id: 'gfn1000', course_code: 'GFN1000', term: 'T', display_name: 'GFN', status: 'active', sources: [{ path: '/p/GFN1000' }] },
      { course_id: 'lab3200', course_code: 'LAB3200', term: 'T', display_name: 'Lab', status: 'active', sources: [{ path: '/p/CSC3200/01_Lectures' }] },
    ],
  }
  const nextDocument = { ...document, courses: document.courses.filter((course) => course.course_id !== 'csc3200') }
  const index = {
    root: '/p',
    files: [
      { file_id: 'f_a', relative_path: 'CSC3200/03_Assignments/hw1.md', course_id: 'csc3200', category: 'assignments' },
      { file_id: 'f_b', relative_path: 'CSC3200/01_Lectures/lecture-01.md', course_id: 'csc3200', category: 'unassigned' },
      { file_id: 'f_c', relative_path: 'GFN1000/notes.md', course_id: 'gfn1000', category: 'unassigned' },
      { file_id: 'f_d', relative_path: 'stray.md', course_id: null, category: 'unassigned' },
    ],
  }

  const plan = planCourseIndexRemoval({
    document, nextDocument, removedCourseId: 'csc3200', removedSources: ['/p/CSC3200'], index, indexRoot: '/p',
  })
  assert.deepEqual(plan.removedFileIds, ['f_a'], 'only the exclusively owned record goes')
  assert.deepEqual(plan.remaining.map((record) => record.file_id), ['f_b', 'f_c', 'f_d'])
  assert.equal(plan.remaining.find((record) => record.file_id === 'f_b').course_id, 'lab3200',
    'a shared source stays searchable under the surviving course')
  assert.equal(plan.remaining.find((record) => record.file_id === 'f_c').course_id, 'gfn1000',
    'an untouched course keeps its assignment')
  assert.equal(plan.remaining.find((record) => record.file_id === 'f_d').course_id, null,
    'records that were never assigned are left alone')
  assert.deepEqual(plan.extraRemovedSources, [], 'a source root already covers everything removed')
  assert.deepEqual(index.files.map((record) => record.file_id), ['f_a', 'f_b', 'f_c', 'f_d'],
    'the input index is never mutated')
})

test('a stale assignment outside the registered sources is marked so a rebuild cannot revive it', () => {
  const document = {
    schema_version: 1,
    project: { id: 'p', name: 'p' },
    courses: [
      { course_id: 'csc3200', course_code: 'CSC3200', term: 'T', display_name: 'DSA', status: 'active', sources: [{ path: '/p/CSC3200' }] },
    ],
  }
  const nextDocument = { ...document, courses: [] }
  const index = {
    root: '/p',
    files: [{ file_id: 'f_stale', relative_path: 'old-location/notes.md', course_id: 'csc3200', category: 'unassigned' }],
  }

  const plan = planCourseIndexRemoval({
    document, nextDocument, removedCourseId: 'csc3200', removedSources: ['/p/CSC3200'], index, indexRoot: '/p',
  })
  assert.deepEqual(plan.removedFileIds, ['f_stale'])
  assert.deepEqual(plan.extraRemovedSources, ['/p/old-location/notes.md'])
  assert.deepEqual(removedSourcePrefixes({ document: recordRemovedSources(nextDocument, plan.extraRemovedSources), indexRoot: '/p' }),
    ['old-location/notes.md'])
})

test('a deleted stale root-level record stays excluded without excluding its neighbours', () => {
  const document = { courses: [{ course_id: 'old', sources: [{ path: '/p/old' }] }] }
  const nextDocument = { courses: [] }
  const plan = planCourseIndexRemoval({ document, nextDocument, removedCourseId: 'old',
    removedSources: ['/p/old'], indexRoot: '/p', index: { files: [
      { file_id: 'removed', relative_path: 'lecture.md', course_id: 'old' },
      { file_id: 'neighbour', relative_path: 'other.md', course_id: null },
    ] } })
  assert.deepEqual(plan.extraRemovedSources, ['/p/lecture.md'])
  assert.deepEqual(plan.remaining.map((record) => record.file_id), ['neighbour'])
})

test('search uses the surviving index assignment even when chunk provenance is stale', async () => {
  const s = await scenario()
  const before = await readIndex(s.project)
  const shared = before.files.find((record) => record.relative_path.endsWith('lecture-01.md'))
  // Simulate a failed chunk re-stamp: only the authoritative index is updated.
  shared.course_id = 'gfn1000'
  shared.category = 'supplementary'
  await fs.writeFile(path.join(s.project, '.professor', 'indexes', 'files.json'), JSON.stringify(before))
  const result = await s.tools.professor_search.execute({ query: 'binary search', course: 'gfn1000', category: 'supplementary' }, s.exec)
  assert.ok(result.results.length > 0)
  assert.ok(result.results.every((row) => row.course_id === 'gfn1000' && row.category === 'supplementary'))
})

test('deletion and rebuild exclude a stale root-level file while preserving unrelated material', async () => {
  const s = await scenario()
  await writeFixture(s.home, 'courses/term/old-lecture.md', '# Old lecture\n\nRoot-level legacy material.\n')
  await writeFixture(s.home, 'courses/term/independent.md', '# Independent\n\nUnassigned material.\n')
  await s.tools.professor_index_sync.execute({}, s.exec)
  const index = await readIndex(s.project)
  index.files.find((record) => record.relative_path === 'old-lecture.md').course_id = 'csc3200'
  await fs.writeFile(path.join(s.project, '.professor', 'indexes', 'files.json'), JSON.stringify(index))
  const before = await hashTree(s.project)
  await s.tools.professor_course_manage.execute({ action: 'delete', course_id: 'csc3200', confirm_delete: true }, s.exec)
  await s.tools.professor_index_sync.execute({ rebuild: true }, s.exec)
  const paths = await indexPaths(s.project)
  assert.ok(!paths.includes('old-lecture.md'))
  assert.ok(paths.includes('independent.md'))
  const after = await hashTree(s.project)
  assert.equal(after['old-lecture.md'], before['old-lecture.md'])
  assert.equal(after['independent.md'], before['independent.md'])
})

// --- tools ------------------------------------------------------------------

test('deleting a course removes its registration and its searchable material only', async () => {
  const s = await scenario()
  const materialBefore = await hashTree(path.join(s.project, 'CSC3200'))
  const gfnBefore = await hashTree(path.join(s.project, 'GFN1000'))

  const found = await s.tools.professor_search.execute({ query: 'lexer toy language' }, s.exec)
  assert.ok(found.results.length > 0, 'the fixture is searchable before deletion')

  const outcome = await s.tools.professor_course_manage.execute({
    action: 'delete', course_id: 'csc3200', confirm_delete: true,
  }, s.exec)
  assert.deepEqual(outcome.changed, ['csc3200'])

  const listed = await s.tools.professor_course_list.execute({ include_archived: true }, s.exec)
  assert.deepEqual(listed.courses.map((course) => course.course_id).sort(), ['gfn1000', 'lab3200'])

  const paths = await indexPaths(s.project)
  assert.ok(!paths.some((relative) => relative === 'CSC3200/03_Assignments/hw1.md'),
    'the exclusively owned record is gone from the index')
  assert.ok(paths.some((relative) => relative === 'CSC3200/01_Lectures/lecture-01.md'),
    'the shared source stays indexed for the surviving course')
  assert.ok(paths.some((relative) => relative === 'GFN1000/notes.md'), 'the other course is untouched')

  const gone = await s.tools.professor_search.execute({ query: 'lexer toy language' }, s.exec)
  assert.equal(gone.results.length, 0, 'removed material is not returned by search')
  const shared = await s.tools.professor_search.execute({ query: 'binary search' }, s.exec)
  assert.ok(shared.results.length > 0, 'shared material is still searchable')
  assert.ok(shared.results.every((row) => row.course_id === 'lab3200'),
    'and it now reports the surviving course', JSON.stringify(shared.results.map((row) => row.course_id)))

  assert.deepEqual(await hashTree(path.join(s.project, 'CSC3200')), materialBefore, 'course material is byte-identical')
  assert.deepEqual(await hashTree(path.join(s.project, 'GFN1000')), gfnBefore, 'other material is byte-identical')
})

test('a later rebuild does not resurrect the deleted folder as an unassigned corpus', async () => {
  const s = await scenario()
  await s.tools.professor_course_manage.execute({ action: 'delete', course_id: 'csc3200', confirm_delete: true }, s.exec)
  await s.tools.professor_index_sync.execute({ rebuild: true }, s.exec)

  const paths = await indexPaths(s.project)
  assert.ok(!paths.some((relative) => relative.startsWith('CSC3200/03_Assignments/')),
    'the deleted course folder is not re-added as unassigned material', JSON.stringify(paths))
  assert.ok(paths.some((relative) => relative === 'CSC3200/01_Lectures/lecture-01.md'),
    'the shared sub-directory is still indexed')
  const shared = await s.tools.professor_search.execute({ query: 'binary search' }, s.exec)
  assert.ok(shared.results.length > 0)

  const document = await readProject(s.project)
  const marker = /removed_sources:\n((?:\s+- .*\n)+)/.exec(document)
  assert.ok(marker, 'the deleted source root is recorded as a removal marker')
  assert.match(marker[1].trim(), /CSC3200'$/, 'the marker names the whole source root', marker[1].trim())
  assert.ok(!marker[1].includes('01_Lectures'), 'markers never name a shared child directory')
})

test('explicitly re-registering the same folder restores its course and its indexing', async () => {
  const s = await scenario()
  await s.tools.professor_course_manage.execute({ action: 'delete', course_id: 'csc3200', confirm_delete: true }, s.exec)
  assert.ok(!(await indexPaths(s.project)).some((relative) => relative.startsWith('CSC3200/03_Assignments/')))

  await s.tools.professor_course_manage.execute({
    action: 'register', course_code: 'CSC3200', display_name: 'DSA again', term: '2025-2026 Fall',
    source_path: path.join(s.project, 'CSC3200'),
  }, s.exec)
  await s.tools.professor_index_sync.execute({ rebuild: true }, s.exec)

  const listed = await s.tools.professor_course_list.execute({ include_archived: true }, s.exec)
  assert.ok(listed.courses.some((course) => course.course_id === 'csc3200'))
  assert.ok((await indexPaths(s.project)).some((relative) => relative.startsWith('CSC3200/03_Assignments/')),
    'the material is indexed again after an explicit re-add')
  assert.ok((await s.tools.professor_search.execute({ query: 'lexer toy language' }, s.exec)).results.length > 0)
  assert.doesNotMatch(await readProject(s.project), /removed_sources:/, 'the marker was cleared by the re-add')
})

test('deletion keeps learning state, bindings, notes and the user exclusions byte-identical', async () => {
  const s = await scenario()
  await s.tools.professor_session_bind.execute({ course: 'CSC3200' }, s.exec)
  await s.tools.professor_state_update.execute({
    file: 'PROGRESS.md', evidence: 'strong', field: 'current_unit', value: 'Unit 4', reason: 'checkpoint solved',
  }, s.exec)
  await writeFixture(s.home, 'courses/term/CSC3200/04_My-Notes/mine.md', 'my own notes')
  // Everything except `indexes/`: the derived index is exactly what deletion is allowed to change.
  const state = path.join(s.project, '.professor', 'state')
  const before = await hashTree(state)
  const notesBefore = sha256(await fs.readFile(path.join(s.project, 'CSC3200', '04_My-Notes', 'mine.md')))

  await s.tools.professor_course_manage.execute({ action: 'delete', course_id: 'csc3200', confirm_delete: true }, s.exec)

  assert.deepEqual(await hashTree(state), before, 'learning state and binding history are untouched')
  assert.equal(sha256(await fs.readFile(path.join(s.project, 'CSC3200', '04_My-Notes', 'mine.md'))), notesBefore)
})

test('deletion refuses without an explicit confirmation and refuses a stale digest', async () => {
  const s = await scenario()
  await assert.rejects(s.tools.professor_course_manage.execute({ action: 'delete', course_id: 'csc3200' }, s.exec),
    { code: 'PROFESSOR_COURSE_INVALID' })
  await assert.rejects(s.tools.professor_course_manage.execute(
    { action: 'delete', course_id: 'csc3200', confirm_delete: 'yes' }, s.exec), { code: 'PROFESSOR_COURSE_INVALID' })
  await assert.rejects(s.tools.professor_course_manage.execute(
    { action: 'delete', course_id: 'unknown', confirm_delete: true }, s.exec), { code: 'PROFESSOR_COURSE_MISSING' })

  const observed = await s.tools.professor_course_list.execute({ include_archived: true }, s.exec)
  await assert.rejects(s.tools.professor_course_manage.execute({
    action: 'delete', course_id: 'csc3200', confirm_delete: true,
    expected_config_digest: 'f'.repeat(64), expected_project_root: s.project,
  }, s.exec), { code: 'PROFESSOR_PROJECT_STALE' })
  await assert.rejects(s.tools.professor_course_manage.execute({
    action: 'delete', course_id: 'csc3200', confirm_delete: true,
    expected_config_digest: observed.configDigest, expected_project_root: '/elsewhere',
  }, s.exec), { code: 'PROFESSOR_PROJECT_STALE' })

  const listed = await s.tools.professor_course_list.execute({ include_archived: true }, s.exec)
  assert.equal(listed.courses.length, 3, 'a refused deletion changes nothing')
})
