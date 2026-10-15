/**
 * M7 classification tests: course assignment, virtual categories, and the reporting the index
 * exposes for them.
 *
 * The classifier is deliberately data-only — a record is attached to a course only through a
 * registered source root or an explicit category rule, and anything else stays `unassigned`.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { classifyRecords, createClassifier, summarizeClassification, UNASSIGNED } from '../src/indexer/classify.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

function classifierFor({ courses, indexRoot = '/proj' }) {
  return createClassifier({ document: { courses }, indexRoot })
}

const CSC3200 = {
  course_id: 'csc3200',
  sources: [
    {
      path: '/proj/CSC3200',
      category_rules: {
        lectures: ['/proj/CSC3200/01_Lectures'],
        assignments: ['/proj/CSC3200/03_Assignments'],
      },
    },
  ],
}

test('a file matches a category rule before a bare source root', () => {
  const classify = classifierFor({ courses: [CSC3200] })

  const lecture = classify('CSC3200/01_Lectures/week-01.pdf')
  assert.equal(lecture.course_id, 'csc3200')
  assert.equal(lecture.category, 'lectures')
  assert.equal(lecture.classification_source, 'category-rule')
  assert.equal(lecture.classification_confidence, 1)

  const other = classify('CSC3200/misc/readme.md')
  assert.equal(other.course_id, 'csc3200')
  assert.equal(other.category, UNASSIGNED, 'inside the root but under no rule')
  assert.equal(other.classification_source, 'source-root')
  assert.equal(other.classification_confidence, 1)
})

test('nothing outside a registered source is ever attached to a course', () => {
  const classify = classifierFor({ courses: [CSC3200] })

  for (const candidate of [
    'GFN1000/L1.pdf',
    'CSC3200-other/notes.md', // sibling prefix must not match
    'CSC3200/../CSC3200-other/notes.md',
    'random.txt',
  ]) {
    const outcome = classify(candidate)
    assert.equal(outcome.course_id, null, `${candidate} must stay unassigned`)
    assert.equal(outcome.category, UNASSIGNED)
    assert.equal(outcome.classification_source, 'none')
    assert.equal(outcome.classification_confidence, 0)
  }
})

test('a sibling directory sharing a name prefix is not matched', () => {
  const classify = classifierFor({ courses: [CSC3200] })
  // `CSC3200-archive` must not be treated as inside `CSC3200`.
  assert.equal(classify('CSC3200-archive/old.pdf').course_id, null)
  assert.equal(classify('CSC3200/01_Lectures/week-01.pdf').course_id, 'csc3200')
})

test('the most specific rule wins, deterministically, regardless of registration order', () => {
  const courses = [
    {
      course_id: 'aaa',
      sources: [{ path: '/proj', category_rules: { lectures: ['/proj/CSC3200'] } }],
    },
    {
      course_id: 'bbb',
      sources: [{ path: '/proj/CSC3200/01_Lectures', category_rules: { lectures: ['/proj/CSC3200/01_Lectures'] } }],
    },
  ]
  const forward = createClassifier({ document: { courses }, indexRoot: '/proj' })
  const reversed = createClassifier({ document: { courses: [...courses].reverse() }, indexRoot: '/proj' })
  const file = 'CSC3200/01_Lectures/week-01.pdf'

  assert.equal(forward(file).course_id, 'bbb', 'the longest (most specific) rule wins')
  assert.deepEqual(forward(file), reversed(file), 'registration order must not change the result')

  // A file under CSC3200 but not under 01_Lectures falls back to the wider rule.
  assert.equal(forward('CSC3200/other.pdf').course_id, 'aaa')
})

test('a source outside the index root contributes no rules', () => {
  const classify = classifierFor({
    courses: [{ course_id: 'far', sources: [{ path: '/elsewhere/Course' }] }],
  })
  assert.equal(classify('Course/notes.md').course_id, null, 'an unreachable source matches nothing')
})

test('classifyRecords writes the four fields and counts by course', () => {
  const classify = classifierFor({ courses: [CSC3200] })
  const records = [
    { relative_path: 'CSC3200/01_Lectures/week-01.pdf' },
    { relative_path: 'CSC3200/03_Assignments/hw1.md' },
    { relative_path: 'GFN1000/L1.pdf' },
    // A record left over from an earlier run still gets reclassified from the current document.
    { relative_path: 'CSC3200/misc/readme.md', course_id: 'stale', category: 'stale' },
  ]

  const stats = classifyRecords(records, classify)
  assert.deepEqual(stats.byCourse, { csc3200: 3 })
  assert.equal(stats.unassigned, 1)
  assert.equal(stats.assigned, 3)

  assert.deepEqual(records.map((record) => record.category), ['lectures', 'assignments', UNASSIGNED, UNASSIGNED])
  assert.equal(records[3].course_id, 'csc3200', 'a stale assignment is corrected from the current document')
  assert.equal(records[3].classification_source, 'source-root')
  for (const record of records) {
    assert.equal(typeof record.classification_source, 'string')
    assert.equal(typeof record.classification_confidence, 'number')
  }
})

test('the summary reports every bucket, including the empty ones', () => {
  const classify = classifierFor({ courses: [CSC3200] })
  const summary = summarizeClassification([
    { relative_path: 'CSC3200/01_Lectures/week-01.pdf', course_id: 'csc3200', category: 'lectures', classification_source: 'category-rule' },
    { relative_path: 'GFN1000/L1.pdf', course_id: null, category: UNASSIGNED, classification_source: 'none' },
  ])

  assert.equal(summary.total, 2)
  assert.equal(summary.unassigned, 1)
  // Zero-hit buckets are present so a consumer never reads `undefined` for a real count.
  assert.equal(summary.bySource['source-root'], 0)
  assert.equal(summary.bySource['category-rule'], 1)
  assert.equal(summary.bySource.none, 1)
  assert.equal(summary.byCategory.tutorials, 0)
  assert.deepEqual(summary.byCourse, { csc3200: 1 })
  assert.equal(summary.note, null)

  const nothing = summarizeClassification([
    { relative_path: 'x.md', course_id: null, category: UNASSIGNED, classification_source: 'none' },
  ])
  assert.match(nothing.note, /no file matched/)
})

test('classification is derived only from the project document, end to end', async () => {
  const home = await makeHome('professor-classify-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/CSC3200/01_Lectures/lecture-01.pdf', 'lecture')
  await writeFixture(home, 'courses/term/CSC3200/03_Assignments/hw1.md', 'hw')
  await writeFixture(home, 'courses/term/CSC3200/misc/notes.md', 'loose file under the root')
  await writeFixture(home, 'courses/term/GFN1000/L1.pdf', 'gfn')

  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })

  // No project yet: indexing is refused outright. It used to run and report every record
  // unassigned, but running it creates `.professor/indexes/` inside a workspace the user never
  // connected — the "guessed course tree" the v1 plan forbids. The "unassignable material stays
  // unassigned" behaviour is asserted right after, against a project that really exists.
  await assert.rejects(
    () => tools.professor_index_sync.execute({}, exec),
    (error) => error.code === 'PROFESSOR_PROJECT_MISSING',
    'an unbound workspace must refuse indexing rather than create a course tree',
  )

  await tools.professor_project_init.execute({ project_id: 'term-2026' }, exec)

  // A project that registers no matching source leaves every record unassigned rather than guessed.
  const bare = await tools.professor_index_sync.execute({}, exec)
  assert.equal(bare.assigned, 0)
  assert.equal(bare.unassigned, 4)
  assert.match(bare.classification.note, /no file matched/)

  await tools.professor_course_manage.execute({
    action: 'register',
    course_code: 'CSC3200',
    display_name: 'DSA',
    term: '2025-2026 Fall',
    source_path: path.join(project, 'CSC3200'),
  }, exec)

  const sync = await tools.professor_index_sync.execute({}, exec)
  assert.equal(sync.assigned, 3, 'all three CSC3200 files are under the registered root')
  assert.equal(sync.unassigned, 1, 'the GFN1000 file has no registered source')
  assert.equal(sync.classification.byCategory.lectures, 1)
  assert.equal(sync.classification.byCategory.assignments, 1)
  assert.equal(sync.classification.byCategory[UNASSIGNED], 2, 'one root-only match plus the unregistered file')
  assert.deepEqual(sync.classification.byCourse, { csc3200: 3 })

  // Archived courses still classify: archiving hides a course from the listing, it does not
  // orphan its material in the index.
  await tools.professor_course_manage.execute({ action: 'archive', course_id: 'csc3200' }, exec)
  const archived = await tools.professor_index_sync.execute({}, exec)
  assert.equal(archived.assigned, 3, 'archiving keeps the source registration intact')
})
