/**
 * Project document, YAML subset, and course registry rule tests.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { dumpYamlLite, parseYamlLite, YamlLiteError } from '../src/project/yaml-lite.js'
import {
  courseIdFor, defaultProject, loadProject, PROJECT_SCHEMA_VERSION, saveProject, validateProject,
} from '../src/project/project.js'
import {
  listCourses, registerCourse, resolveCourse, setCourseStatus, summarizeCourses, updateCourse, validateSources,
} from '../src/courses/registry.js'
import { createFsGateway } from '../src/fs/gateway.js'
import { createPathPolicy } from '../src/paths/policy.js'
import { projectPaths } from '../src/paths/roots.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

// --- YAML subset -----------------------------------------------------------

test('the YAML subset round-trips the project shape', () => {
  const document = {
    schema_version: 1,
    project: { id: 'term-2026', name: 'Fall 2026' },
    courses: [
      { course_id: 'csc3200', course_code: 'CSC3200', term: '2025-2026 Fall', display_name: 'Data Structures and Advanced Programming', status: 'active', sources: [{ path: '/courses/CSC3200' }] },
      { course_id: 'gfn1000', course_code: 'GFN1000', term: '2025-2026 Fall', display_name: 'GFN1000', status: 'archived', sources: [] },
    ],
    outputs: { notes_root: '/courses/CSC3200/04_My-Notes/AI-Notes', reviews_root: null },
    indexing: { exclude: ['.git', 'private'], follow_symlinks: false },
    retrieval: { max_sources: 4, max_chunks: 8, prefer_local_course_sources: true },
    notes: { default_format: 'latex', overwrite_policy: 'never', latex_template: null },
    web: { enabled: true, policy: 'conditional' },
  }
  const text = dumpYamlLite(document)
  assert.match(text, /^schema_version: 1$/m)
  assert.match(text, /^ {2}id: term-2026$/m)
  assert.deepEqual(parseYamlLite(text), document)

  // JSON is valid YAML and is accepted as-is.
  assert.deepEqual(parseYamlLite(JSON.stringify(document)), document)
  assert.equal(parseYamlLite(''), null)
})

test('the YAML subset refuses syntax it does not implement, instead of guessing', () => {
  const cases = [
    ['\tkey: value', /tabs/],
    ['key: &anchor value', /unsupported YAML syntax/],
    ['list: [a, b]', /flow collections/],
    ['---\nkey: value', /multi-document/],
    ['key: |\n  block', /unsupported YAML syntax/],
    ['key: "unterminated', /unterminated/],
  ]
  for (const [text, pattern] of cases) {
    assert.throws(() => parseYamlLite(text), (error) => {
      assert.ok(error instanceof YamlLiteError, `${text} should raise YamlLiteError`)
      assert.match(error.message, pattern)
      assert.equal(error.code, 'PROFESSOR_YAML_SUBSET')
      return true
    }, `expected a refusal for ${JSON.stringify(text)}`)
  }
})

// --- project schema --------------------------------------------------------

test('the project document validates and reports precise problems', () => {
  const base = defaultProject({ id: 'term-2026', name: 'Fall 2026' })
  assert.equal(validateProject(base).ok, true)

  const cases = [
    [{ ...base, schema_version: 2 }, /schema_version must be 1/],
    [{ ...base, project: { id: '' } }, /project.id is required/],
    [{ ...base, courses: 'nope' }, /courses must be a list/],
    [{ ...base, courses: [{ course_id: 'a', course_code: 'A', term: 'T', display_name: 'A', sources: [{ path: 'relative' }] }] }, /must be an absolute path/],
    [{ ...base, courses: [{ course_id: 'a', course_code: 'A', term: 'T', display_name: 'A' }, { course_id: 'a', course_code: 'B', term: 'T', display_name: 'B' }] }, /is duplicated/],
    [{ ...base, courses: [{ course_id: 'a', course_code: 'A', term: 'T', display_name: 'A' }, { course_id: 'b', course_code: 'A', term: 'T', display_name: 'A' }] }, /duplicates course_code/],
    [{ ...base, notes: { default_format: 'docx' } }, /notes.default_format/],
    [{ ...base, web: { policy: 'sometimes' } }, /web.policy/],
    [{ ...base, retrieval: { max_sources: 0 } }, /max_sources must be a positive integer/],
  ]
  for (const [document, pattern] of cases) {
    const result = validateProject(document)
    assert.equal(result.ok, false, `expected a failure for ${pattern}`)
    assert.ok(result.errors.some((error) => pattern.test(error)), `missing ${pattern} in ${result.errors.join(' | ')}`)
  }

  // Same course code in two terms is legitimate.
  const twoTerms = {
    ...base,
    courses: [
      { course_id: 'csc3200-2025f', course_code: 'CSC3200', term: '2025-2026 Fall', display_name: 'DSA' },
      { course_id: 'csc3200-2026s', course_code: 'CSC3200', term: '2025-2026 Spring', display_name: 'DSA' },
    ],
  }
  assert.equal(validateProject(twoTerms).ok, true)
})

async function projectScenario() {
  const home = await makeHome('professor-project-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/01_Lectures/lecture-01.pdf', 'material')
  const fake = createFakeContext({ home })
  const writePolicy = createPathPolicy({ roots: [projectPaths(project).base], label: 'write' })
  const session = makeExec({ cwd: project }).agent.session
  return { home, project, fake, writePolicy, session }
}

test('saving a project refuses a changed preimage instead of overwriting concurrent configuration', async () => {
  const s = await projectScenario()
  const gateway = createFsGateway({ ctx: s.fake.ctx })
  const options = { gateway, projectRoot: s.project, session: s.session, writePolicy: s.writePolicy }
  await saveProject({ ...options, document: defaultProject({ id: 'original' }) })
  const original = await loadProject(options)
  await saveProject({ ...options, document: defaultProject({ id: 'concurrent' }) })
  await assert.rejects(saveProject({ ...options, document: original.document, expectedRaw: original.raw }),
    error => error.code === 'PROFESSOR_PROJECT_STALE')
  assert.equal((await loadProject(options)).document.project.id, 'concurrent')
})

test('the project file is create-only, guarded, and refuses a newer schema', async () => {
  const s = await projectScenario()
  const gw = createFsGateway({ ctx: s.fake.ctx, logger: { warn() {} } })

  const first = await saveProject({
    gateway: gw, projectRoot: s.project, document: defaultProject({ id: 'term' }), session: s.session, writePolicy: s.writePolicy, createOnly: true,
  })
  assert.equal(first.operation, 'create')

  await assert.rejects(
    () => saveProject({ gateway: gw, projectRoot: s.project, document: defaultProject({ id: 'other' }), session: s.session, writePolicy: s.writePolicy, createOnly: true }),
    (error) => error.code === 'PROFESSOR_PROJECT_EXISTS',
  )

  // An invalid document is never written (validation runs before anything is read or written).
  await assert.rejects(
    () => saveProject({ gateway: gw, projectRoot: s.project, document: { schema_version: PROJECT_SCHEMA_VERSION }, session: s.session, writePolicy: s.writePolicy }),
    (error) => error.code === 'PROFESSOR_PROJECT_INVALID',
  )

  // The plugin's own write policy fences the path even for a valid document.
  const outside = createPathPolicy({ roots: [path.join(s.home, 'elsewhere')], label: 'write' })
  await assert.rejects(
    () => saveProject({ gateway: gw, projectRoot: s.project, document: defaultProject({ id: 'term' }), session: s.session, writePolicy: outside }),
    (error) => error.code === 'PROFESSOR_PATH_DENIED',
  )

  // A future schema is reported by load and refused by save, leaving the file untouched. This
  // check runs last because, once the file carries a newer schema, every save must fail safe.
  await writeFixture(s.home, 'courses/term/.professor/project.yaml', 'schema_version: 99\nproject:\n  id: from-the-future\n')
  const loaded = await loadProject({ gateway: gw, projectRoot: s.project })
  assert.equal(loaded.unsupported.future, true)
  assert.match(loaded.problems[0], /newer than this plugin supports/)
  await assert.rejects(
    () => saveProject({ gateway: gw, projectRoot: s.project, document: defaultProject({ id: 'term' }), session: s.session, writePolicy: s.writePolicy }),
    (error) => error.code === 'PROFESSOR_PROJECT_UNSUPPORTED',
  )
  const untouched = await s.fake.ctx.fs.readText(await gw.resolveTarget(projectPaths(s.project).projectFile, { cwd: s.project }))
  assert.match(untouched, /from-the-future/)
})

// --- registry rules --------------------------------------------------------

test('registration derives ids and rejects duplicate identity', () => {
  const document = defaultProject({ id: 'term' })
  const first = registerCourse(document, {
    course_code: 'CSC3200', display_name: 'Data Structures and Advanced Programming', term: '2025-2026 Fall', sources: [{ path: '/courses/CSC3200' }],
  })
  assert.equal(first.course.course_id, 'csc3200')
  assert.equal(first.document.courses.length, 1)
  assert.equal(document.courses.length, 0, 'the input document is not mutated')

  assert.throws(
    () => registerCourse(first.document, { course_code: 'csc3200', display_name: 'Again', term: '2025-2026 Fall' }),
    (error) => error.code === 'PROFESSOR_COURSE_EXISTS',
  )
  assert.throws(
    () => registerCourse(first.document, { course_code: 'CSC3200', display_name: 'Same term', term: '2025-2026 Fall', course_id: 'other-id' }),
    (error) => error.code === 'PROFESSOR_COURSE_EXISTS',
  )
  assert.throws(
    () => registerCourse(first.document, { course_code: 'PHY1001', display_name: 'Physics', term: '2025-2026 Fall', sources: [{ path: 'relative/path' }] }),
    (error) => error.code === 'PROFESSOR_COURSE_INVALID',
  )
  assert.throws(() => registerCourse(first.document, { course_code: 'X', display_name: 'X' }), /term is required/)

  // The no-source registration warns rather than failing.
  const noSources = registerCourse(first.document, { course_code: 'STA2001', display_name: 'Statistics', term: '2025-2026 Fall' })
  assert.equal(noSources.warnings.length, 1)
  assert.equal(courseIdFor('CSC 3200'), 'csc-3200')
})

test('resolution never guesses between two terms of the same code', () => {
  let document = defaultProject({ id: 'term' })
  document = registerCourse(document, { course_code: 'CSC3200', display_name: 'DSA', term: '2025-2026 Fall' }).document
  document = registerCourse(document, { course_code: 'CSC3200', display_name: 'DSA', term: '2025-2026 Spring' }).document

  // A fully qualified spelling resolves; a bare code that matches two terms must ask, even though
  // one of those courses happens to carry the bare id.
  assert.equal(resolveCourse(document, 'csc3200-2025-2026-fall').status, 'found')
  assert.equal(resolveCourse(document, 'csc3200-2025-2026-spring').status, 'found')
  assert.equal(resolveCourse(document, 'csc3200').status, 'ambiguous')
  const ambiguous = resolveCourse(document, 'CSC3200')
  assert.equal(ambiguous.status, 'ambiguous')
  assert.equal(ambiguous.candidates.length, 2)
  assert.match(ambiguous.candidates[0].term, /Fall|Spring/)
  assert.equal(resolveCourse(document, 'PHY1001').status, 'missing')
  assert.equal(resolveCourse(defaultProject({ id: 'empty' }), 'CSC3200').status, 'empty')
})

test('updates preserve identity and archiving deletes nothing', () => {
  let document = registerCourse(defaultProject({ id: 'term' }), {
    course_code: 'CSC3200', display_name: 'DSA', term: '2025-2026 Fall', sources: [{ path: '/courses/CSC3200' }],
  }).document

  // The immutable identity is the course_id; the visible code is editable (approved behaviour).
  assert.throws(
    () => updateCourse(document, 'csc3200', { course_id: 'csc3201' }),
    (error) => error.code === 'PROFESSOR_COURSE_IMMUTABLE',
  )

  const recoded = updateCourse(document, 'csc3200', { course_code: 'CS-3200' })
  assert.deepEqual(recoded.changed, ['course_code'])
  assert.equal(recoded.course.course_id, 'csc3200', 'editing the visible code never changes the identity')
  assert.equal(recoded.course.course_code, 'CS-3200')

  const renamed = updateCourse(recoded.document, 'csc3200', { display_name: 'Data Structures' })
  assert.deepEqual(renamed.changed, ['display_name'])
  assert.equal(renamed.course.course_code, 'CS-3200')

  document = registerCourse(renamed.document, { course_code: 'CSC3200', display_name: 'DSA', term: '2025-2026 Spring' }).document
  assert.throws(
    () => updateCourse(document, 'csc3200', { course_code: 'CSC3200', term: '2025-2026 Spring' }),
    (error) => error.code === 'PROFESSOR_COURSE_EXISTS',
    'the same code+term pair may exist only once',
  )

  const archived = setCourseStatus(document, 'csc3200', 'archived').document
  assert.equal(listCourses(archived).find((course) => course.course_id === 'csc3200').status, 'archived')
  assert.equal(listCourses(archived).length, 2, 'archiving keeps every registration')
  assert.equal(listCourses(archived).find((course) => course.course_id === 'csc3200').sources.length, 1, 'archiving keeps source paths')

  const summary = summarizeCourses(archived)
  assert.equal(summary[0].active, false)
  assert.equal(summary[0].sources[0], '/courses/CSC3200')
})

test('source validation reports missing paths without changing the document', async () => {
  const document = registerCourse(defaultProject({ id: 'term' }), {
    course_code: 'CSC3200', display_name: 'DSA', term: '2025-2026 Fall', sources: [{ path: '/courses/CSC3200' }],
  }).document
  const before = JSON.stringify(document)
  const report = await validateSources(document, { isDirectory: async (candidate) => candidate === '/courses/CSC3200' })
  assert.deepEqual(report.problems, [])
  assert.equal(report.courses[0].sources[0].exists, true)

  const missing = await validateSources(document, { isDirectory: async () => false })
  assert.equal(missing.problems.length, 1)
  assert.match(missing.problems[0], /does not exist or is not a directory/)
  assert.equal(JSON.stringify(document), before)
})

test('course code edits follow the documented validation rules and preserve identity', () => {
  let document = registerCourse(defaultProject({ id: 'codes' }), {
    course_code: 'CSC3200', display_name: 'DSA', term: '2025-2026 Fall', sources: [{ path: '/courses/DSA' }],
  }).document
  const before = listCourses(document)[0]

  // Rejected: empty, whitespace-only, overlong, control characters.
  for (const bad of ['', '   ', 'x'.repeat(241), 'CS\u0007T', 'CS\nT', 'CS\u001bT']) {
    assert.throws(
      () => updateCourse(document, 'csc3200', { course_code: bad }),
      (error) => error.code === 'PROFESSOR_COURSE_INVALID',
      JSON.stringify(bad),
    )
  }

  // Accepted with exact preservation: trimming only, no capitalization change, no truncation,
  // and user-defined shapes are legitimate (not restricted to CSC-style).
  for (const [input, expected] of [['  cs-3200 advanced  ', 'cs-3200 advanced'], ['MATH α·分析', 'MATH α·分析'], ['Algo2026#1', 'Algo2026#1']]) {
    const updated = updateCourse(document, 'csc3200', { course_code: input })
    assert.equal(updated.course.course_code, expected, input)
    assert.deepEqual(updated.changed, ['course_code'])
    // Identity and every other field survive byte-for-byte.
    assert.equal(updated.course.course_id, before.course_id)
    assert.deepEqual(updated.course.sources, before.sources)
    assert.deepEqual(updated.course.outputs, before.outputs)
    assert.equal(updated.course.display_name, before.display_name)
    assert.equal(updated.course.term, before.term)
    document = updated.document
  }
})

test('code edits respect the code+term uniqueness rule and keep cross-term codes legal', () => {
  let document = registerCourse(defaultProject({ id: 'codes2' }), {
    course_code: 'CSC3200', display_name: 'Fall', term: '2025-2026 Fall',
  }).document
  document = registerCourse(document, { course_code: 'CSC3200', display_name: 'Spring', term: '2025-2026 Spring' }).document
  // Same code in another term stays legal, and resolution keeps asking rather than picking.
  assert.equal(resolveCourse(document, 'CSC3200').status, 'ambiguous')
  // The same code in a different term stays legal (both courses keep code CSC3200 in two terms).
  const sameCode = updateCourse(document, 'csc3200-2025-2026-spring', { course_code: 'csc3200' })
  assert.equal(sameCode.course.course_code, 'csc3200')
  // Renaming one onto the other's exact code+term pair is refused.
  assert.throws(
    () => updateCourse(document, 'csc3200-2025-2026-spring', { course_code: 'csc3200', term: '2025-2026 Fall' }),
    (error) => error.code === 'PROFESSOR_COURSE_EXISTS',
  )
  // Renaming to a code that collides with another course's code AND term is refused too.
  document = registerCourse(document, { course_code: 'STA2001', display_name: 'Prob', term: '2025-2026 Fall' }).document
  assert.throws(
    () => updateCourse(document, 'sta2001', { course_code: 'CSC3200', term: '2025-2026 Fall' }),
    (error) => error.code === 'PROFESSOR_COURSE_EXISTS',
  )
})

test('updated codes resolve; old codes are not aliases and canonical ids still resolve', () => {
  // An explicit id that is NOT derived from the old code, so the alias rule is observable: when
  // the old code happens to equal the canonical id (the derived-id case), it must keep resolving
  // as the id — that is "canonical id lookup stays valid", not an alias.
  let document = registerCourse(defaultProject({ id: 'codes3' }), {
    course_code: 'CSC3200', course_id: 'dsa-fall', display_name: 'DSA', term: '2025-2026 Fall',
  }).document
  document = updateCourse(document, 'dsa-fall', { course_code: 'CS-3200' }).document
  assert.equal(resolveCourse(document, 'CS-3200').status, 'found')
  assert.equal(resolveCourse(document, 'cs-3200').status, 'found')
  assert.equal(resolveCourse(document, 'dsa-fall').status, 'found', 'the canonical id remains valid')
  assert.equal(resolveCourse(document, 'CSC3200').status, 'missing', 'old visible codes are not permanent aliases')
})
