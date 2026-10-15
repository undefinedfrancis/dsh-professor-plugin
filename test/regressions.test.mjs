/**
 * Regression tests for the "write policy derived before the project document was loaded" defect
 * class (see docs/AUDIT.md).
 *
 * Three tools constructed their path policies from a binding that did not exist yet
 * (`outputRootsFor(loaded.document)` before `loaded`, `outputRootsFor(document)` before
 * `document`, and `outputRootsFor(loaded.document)` where `loaded` was never declared at all).
 * Each threw `ReferenceError: Cannot access '…' before initialization`, which made indexing,
 * course registration and state updates unusable while every offline verifier stayed green.
 *
 * What these tests lock in:
 *  - a tool either does the right thing or fails with a *domain* error carrying a stable code;
 *  - it never surfaces a JavaScript temporal-dead-zone `ReferenceError`;
 *  - an absent, malformed, unsupported or invalid project document never widens the writable
 *    boundary, and is never silently rewritten;
 *  - an *unbound* workspace (no `.professor/` at all) is refused rather than written into, so a
 *    general Professor session can never create a course tree in a directory the user never
 *    connected (Phase 1).
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

const PROJECT_FILE = '.professor/project.yaml'
const MATERIAL = '01_Lectures/lecture-01.md'

/** Mount the plugin and return its tools plus a project directory inside the fixture. */
async function mount(home, projectRelative) {
  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const project = path.join(home, projectRelative)
  await fs.mkdir(project, { recursive: true })
  await writeFixture(home, path.join(projectRelative, MATERIAL), 'course material')
  return { fake, tools, project, exec: makeExec({ cwd: project }) }
}

/** True for the class of error this file exists to prevent. */
function isUninitializedAccess(error) {
  return error instanceof ReferenceError || /before initialization/.test(String(error?.message ?? ''))
}

/** Assert a call rejects with a specific domain code — and never with a TDZ ReferenceError. */
async function expectDomainError(run, code) {
  try {
    await run()
  } catch (error) {
    assert.equal(isUninitializedAccess(error), false,
      `a tool must never throw an uninitialized-binding ReferenceError: ${error?.message}`)
    assert.equal(error.code, code,
      `expected domain code ${code}, got ${error?.code ?? '(none)'} — ${error?.message}`)
    return
  }
  assert.fail(`expected the call to fail with ${code}`)
}

const REGISTER = { action: 'register', course_code: 'CSC3200', display_name: 'Data Structures', term: '2025-2026 Fall' }
const STATE_WRITE = { file: 'PROGRESS.md', evidence: 'strong', field: 'current_unit', value: 'Unit 1' }

/** Every directory named `.professor` anywhere under `root` — i.e. every course tree created. */
async function professorDirs(root) {
  const found = []
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const target = path.join(dir, entry.name)
      if (entry.name === '.professor') found.push(target)
      await walk(target)
    }
  }
  await walk(root)
  return found
}

test('an absent project.yaml yields domain errors, never a ReferenceError', async () => {
  const home = await makeHome('professor-regression-')
  const { tools, exec } = await mount(home, 'courses/term')

  await expectDomainError(() => tools.professor_course_manage.execute(REGISTER, exec), 'PROFESSOR_PROJECT_MISSING')
  await expectDomainError(() => tools.professor_session_bind.execute({ course: 'CSC3200' }, exec), 'PROFESSOR_PROJECT_MISSING')
  await expectDomainError(() => tools.professor_state_update.execute(STATE_WRITE, exec), 'PROFESSOR_PROJECT_MISSING')

  const listed = await tools.professor_course_list.execute({}, exec)
  assert.equal(listed.projectPresent, false, 'the read tool reports absence instead of throwing')

  // Indexing used to be "the exception": it ran anyway and reported every file unassigned. Since
  // Phase 1 it is not. Running it here would create `.professor/indexes/` inside a workspace the
  // user never connected, which is exactly the "guessed course tree" the v1 plan forbids. An
  // unbound workspace is therefore refused with the same domain code — and the three tests below
  // still prove indexing degrades to *unassigned* for a project that exists but cannot be read.
  await expectDomainError(() => tools.professor_index_sync.execute({}, exec), 'PROFESSOR_PROJECT_MISSING')
  assert.deepEqual(await professorDirs(home), [],
    'a refused call must not leave a `.professor/` tree behind')
})

test('a malformed project.yaml is refused by writers and degrades indexing to unassigned', async () => {
  const home = await makeHome('professor-regression-')
  const { tools, project, exec } = await mount(home, 'courses/term')
  // A tab indent is outside the supported YAML subset, so the document is unparseable.
  const malformed = 'schema_version: 1\nproject:\n\tid: broken\n'
  await writeFixture(home, path.join('courses/term', PROJECT_FILE), malformed)

  await expectDomainError(() => tools.professor_course_manage.execute(REGISTER, exec), 'PROFESSOR_PROJECT_UNSUPPORTED')
  await expectDomainError(() => tools.professor_state_update.execute(STATE_WRITE, exec), 'PROFESSOR_PROJECT_UNSUPPORTED')

  const indexed = await tools.professor_index_sync.execute({}, exec)
  assert.equal(indexed.unassigned, indexed.total)
  assert.equal(await fs.readFile(path.join(project, PROJECT_FILE), 'utf8'), malformed,
    'indexing never rewrites the document it could not read')
})

test('an unsupported schema is refused everywhere and is never overwritten by indexing', async () => {
  const home = await makeHome('professor-regression-')
  const { tools, project, exec } = await mount(home, 'courses/term')
  const future = 'schema_version: 2\nproject:\n  id: from-the-future\n  name: From The Future\ncourses: []\n'
  await writeFixture(home, path.join('courses/term', PROJECT_FILE), future)

  await expectDomainError(() => tools.professor_course_manage.execute(REGISTER, exec), 'PROFESSOR_PROJECT_UNSUPPORTED')
  await expectDomainError(() => tools.professor_course_list.execute({}, exec), 'PROFESSOR_PROJECT_UNSUPPORTED')
  await expectDomainError(() => tools.professor_session_bind.execute({ course: 'x' }, exec), 'PROFESSOR_PROJECT_UNSUPPORTED')
  await expectDomainError(() => tools.professor_state_update.execute(STATE_WRITE, exec), 'PROFESSOR_PROJECT_UNSUPPORTED')

  const indexed = await tools.professor_index_sync.execute({}, exec)
  assert.equal(indexed.unassigned, indexed.total)
  assert.equal(await fs.readFile(path.join(project, PROJECT_FILE), 'utf8'), future,
    'indexing leaves a newer schema byte-for-byte intact')
})

test('a parseable but invalid project document never becomes the basis for a write', async () => {
  const home = await makeHome('professor-regression-')
  const { tools, project, exec } = await mount(home, 'courses/term')
  // Parses fine, but has no project.id: validation must reject it before any policy is derived.
  const invalid = 'schema_version: 1\nproject:\n  name: nameless\ncourses: []\noutputs:\n  notes_root: /tmp/should-never-be-used\n'
  await writeFixture(home, path.join('courses/term', PROJECT_FILE), invalid)

  await expectDomainError(() => tools.professor_course_manage.execute(REGISTER, exec), 'PROFESSOR_PROJECT_INVALID')
  await expectDomainError(() => tools.professor_state_update.execute(STATE_WRITE, exec), 'PROFESSOR_PROJECT_INVALID')

  const indexed = await tools.professor_index_sync.execute({}, exec)
  assert.equal(indexed.unassigned, indexed.total, 'an invalid document is not used to classify material')
  assert.equal(await fs.readFile(path.join(project, PROJECT_FILE), 'utf8'), invalid)
})

test('every mutating tool refuses an invalid document with the same domain code', async () => {
  const home = await makeHome('professor-regression-')
  const { tools, exec } = await mount(home, 'courses/term')
  await writeFixture(home, path.join('courses/term', PROJECT_FILE), 'schema_version: 1\nproject: {}\n')

  for (const [name, args] of [
    ['professor_course_manage', REGISTER],
    ['professor_state_update', STATE_WRITE],
    ['professor_session_bind', { course: 'CSC3200' }],
  ]) {
    await expectDomainError(() => tools[name].execute(args, exec), 'PROFESSOR_PROJECT_INVALID')
  }
})

/**
 * A second instance of the same defect class: *the same contract implemented twice*.
 *
 * The session tools resolved a course by id **or code**, but the state and artifact tools matched
 * the id alone — so `course: "CSC3200"` bound a session fine and then failed with
 * `PROFESSOR_COURSE_MISSING` when the user asked for a note, even though every one of those tool
 * schemas says "Course id or code". Both now go through the shared `requireCourse`, and this test
 * pins the contract across the whole surface so it cannot drift again.
 */
test('every tool that takes a course accepts an id or a code, and never guesses at ambiguity', async () => {
  const home = await makeHome('professor-regression-')
  const { tools, project, exec } = await mount(home, 'courses/term')
  await tools.professor_project_init.execute({}, exec)
  await tools.professor_course_manage.execute(
    { ...REGISTER, source_path: path.join(project, '01_Lectures') },
    exec,
  )

  const artifact = { kind: 'note', course: 'CSC3200', title: 'First Note', format: 'markdown' }
  const created = await tools.professor_artifact_create.execute(artifact, exec)
  assert.equal(created.course_id, 'csc3200', 'a course code resolves to the derived id')
  assert.equal(created.files.length, 1)

  // The same course, spelled as the stored id, the bare code in lower case, the upper-case code,
  // and the `code-term` composite: all four are documented spellings and all four must resolve.
  for (const spelling of ['csc3200', 'CSC3200', 'csc3200-2025-2026-fall', 'CSC3200-2025-2026-fall']) {
    const read = await tools.professor_state_read.execute({ course: spelling }, exec)
    assert.equal(read.course_id, 'csc3200', `"${spelling}" must resolve to the registered course`)
    await tools.professor_state_update.execute(
      { ...STATE_WRITE, course: spelling },
      exec,
    ).catch((error) => {
      // A write may legitimately be refused for another reason, but never for "not registered".
      assert.notEqual(error.code, 'PROFESSOR_COURSE_MISSING',
        `"${spelling}" must not be reported as unregistered: ${error.message}`)
    })
  }

  // A second term of the same code makes the bare code ambiguous: the tool must say so and name the
  // candidates rather than picking one.
  await tools.professor_course_manage.execute(
    { ...REGISTER, term: '2026-2027 Fall', source_path: path.join(project, '01_Lectures') },
    exec,
  )
  await expectDomainError(
    () => tools.professor_artifact_create.execute(artifact, exec),
    'PROFESSOR_COURSE_AMBIGUOUS',
  )
  await expectDomainError(
    () => tools.professor_state_read.execute({ course: 'CSC3200' }, exec),
    'PROFESSOR_COURSE_AMBIGUOUS',
  )
  // ...and the composite spelling still resolves, because it names the term. Two terms of one code
  // get two distinct ids: the first keeps the bare `csc3200`, the second is qualified by its term.
  const unambiguous = await tools.professor_state_read.execute({ course: 'CSC3200-2026-2027-fall' }, exec)
  assert.equal(unambiguous.course_id, 'csc3200-2026-2027-fall',
    'the code-term composite selects the term it names')
  const firstTerm = await tools.professor_state_read.execute({ course: 'csc3200-2025-2026-fall' }, exec)
  assert.equal(firstTerm.course_id, 'csc3200',
    'the first term keeps the bare id, so the composite still reaches it')
})
