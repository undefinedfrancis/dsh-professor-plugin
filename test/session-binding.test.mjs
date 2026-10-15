/**
 * Session–course binding tests (M6).
 *
 * The invariants under test come from `docs/AUDIT.md §3`: no cross-session fallback, one file per
 * session, append-only history, guarded writes, and deterministic replay.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import {
  applyBind, bindingFileFor, emptyBinding, readBinding, validateBinding, writeBinding,
} from '../src/state/course-binding.js'
import { projectPaths } from '../src/paths/roots.js'
import { createPathPolicy } from '../src/paths/policy.js'
import { createFsGateway } from '../src/fs/gateway.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

async function scenario() {
  const home = await makeHome('professor-bind-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/CSC3200/L1.pdf', 'material')
  await writeFixture(home, 'courses/term/GFN1000/L1.pdf', 'material')

  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const writePolicy = createPathPolicy({ roots: [projectPaths(project).base], label: 'write' })

  const init = await tools.professor_project_init.execute({ project_id: 'term-2026' }, makeExec({ cwd: project }))
  await tools.professor_course_manage.execute({
    action: 'register', course_code: 'CSC3200', display_name: 'DSA', term: '2025-2026 Fall',
    source_path: path.join(project, 'CSC3200'),
  }, makeExec({ cwd: project }))
  await tools.professor_course_manage.execute({
    action: 'register', course_code: 'GFN1000', display_name: 'GFN1000', term: '2025-2026 Fall',
    source_path: path.join(project, 'GFN1000'),
  }, makeExec({ cwd: project }))

  return { home, project, fake, tools, writePolicy, init }
}

const bindFile = (project, sessionId) => path.join(projectPaths(project).sessionsDir, `${sessionId}.json`)

test('each session keeps its own binding; no fallback to another session', async () => {
  const s = await scenario()

  const sessionA = makeExec({ cwd: s.project, sessionId: 'session-A' })
  const sessionB = makeExec({ cwd: s.project, sessionId: 'session-B' })

  // Session B first reports "never bound" — never inherits anything from session A.
  const statusB = await s.tools.professor_session_status.execute({}, sessionB)
  assert.equal(statusB.bound, false)
  assert.equal(statusB.course_id, null)
  assert.deepEqual(statusB.history, [])
  assert.match(statusB.warnings[0], /never bound a course/)

  // Session A binds.
  const bindA = await s.tools.professor_session_bind.execute({ course: 'CSC3200' }, sessionA)
  assert.equal(bindA.course_id, 'csc3200')
  assert.equal(bindA.changed, true)

  // B is still untouched: reading B again reports unbound, and B's file does not exist.
  const statusB2 = await s.tools.professor_session_status.execute({}, sessionB)
  assert.equal(statusB2.bound, false)
  await assert.rejects(() => fs.access(bindFile(s.project, 'session-B')), (error) => error.code === 'ENOENT')

  // Two separate files exist, each keyed by its own session id.
  await fs.access(bindFile(s.project, 'session-A'))
  const aRecord = JSON.parse(await fs.readFile(bindFile(s.project, 'session-A'), 'utf8'))
  assert.equal(aRecord.session_id, 'session-A')
  assert.equal(aRecord.course_id, 'csc3200')
})

test('binding history is append-only and switching courses never rewrites the past', async () => {
  const s = await scenario()
  const session = makeExec({ cwd: s.project, sessionId: 'session-A' })

  const first = await s.tools.professor_session_bind.execute({ course: 'CSC3200', reason: 'user-choice' }, session)
  assert.equal(first.history_length, 1)

  const second = await s.tools.professor_session_bind.execute({ course: 'GFN1000', reason: 'user-switch' }, session)
  assert.equal(second.changed, true)
  assert.equal(second.course_id, 'gfn1000')
  assert.equal(second.history_length, 2)

  const third = await s.tools.professor_session_bind.execute({ course: 'CSC3200', reason: 'back' }, session)
  assert.equal(third.history_length, 3)

  const record = JSON.parse(await fs.readFile(bindFile(s.project, 'session-A'), 'utf8'))
  assert.deepEqual(record.history.map((entry) => [entry.from, entry.to]), [
    [null, 'csc3200'],
    ['csc3200', 'gfn1000'],
    ['gfn1000', 'csc3200'],
  ])
  assert.equal(record.course_id, 'csc3200')
  assert.equal(record.history[0].reason, 'user-choice')

  // Unbinding appends and clears only this session's binding.
  const unbound = await s.tools.professor_session_bind.execute({ unbind: true }, session)
  assert.equal(unbound.changed, true)
  assert.equal(unbound.course_id, null)
  assert.equal(unbound.history_length, 4)
  const after = JSON.parse(await fs.readFile(bindFile(s.project, 'session-A'), 'utf8'))
  assert.equal(after.course_id, null)
  assert.equal(after.history.length, 4, 'unbinding appends, never truncates history')
})

test('replaying one session reproduces its binding steps exactly', async () => {
  const s = await scenario()
  const session = makeExec({ cwd: s.project, sessionId: 'session-A' })

  const steps = [
    { course: 'CSC3200' },
    { course: 'GFN1000' },
    { course: 'CSC3200' },
    { unbind: true },
    { course: 'GFN1000' },
  ]
  for (const step of steps) await s.tools.professor_session_bind.execute(step, session)

  // Read the final state, then replay from empty: the two must be identical.
  const finalRecord = JSON.parse(await fs.readFile(bindFile(s.project, 'session-A'), 'utf8'))
  const replayed = steps.reduce(
    (record, step, index) => applyBind({
      record,
      sessionId: 'session-A',
      courseId: step.unbind === true ? null : step.course.replace('CSC3200', 'csc3200').replace('GFN1000', 'gfn1000'),
      reason: 'replay',
      at: `t${index}`,
    }).record,
    emptyBinding('session-A'),
  )
  assert.deepEqual(replayed.history.map((entry) => [entry.from, entry.to]), finalRecord.history.map((entry) => [entry.from, entry.to]))
  assert.equal(replayed.course_id, finalRecord.course_id)
})

test('concurrent writes cannot silently lose an update (version-guarded)', async () => {
  const s = await scenario()
  const gateway = createFsGateway({ ctx: s.fake.ctx, logger: { warn() {} } })

  const target = await gateway.resolveTarget(bindFile(s.project, 'session-A'), { cwd: s.project })
  const created = await writeBinding({
    gateway,
    projectRoot: s.project,
    sessionId: 'session-A',
    record: emptyBinding('session-A'),
    writePolicy: s.writePolicy,
    version: undefined,
  })
  assert.equal(created.operation, 'create')

  // Reader A observes the current version, then B writes first.
  const readerA = await readBinding({ gateway, projectRoot: s.project, sessionId: 'session-A' })
  const versionA = readerA.observedVersion
  await writeBinding({
    gateway,
    projectRoot: s.project,
    sessionId: 'session-A',
    record: applyBind({ record: readerA.record, sessionId: 'session-A', courseId: 'csc3200', reason: 'B', at: 't' }).record,
    writePolicy: s.writePolicy,
    version: versionA,
  })

  // A now tries to write with its stale version: must be refused, not silently overwrite.
  await assert.rejects(
    () => writeBinding({
      gateway,
      projectRoot: s.project,
      sessionId: 'session-A',
      record: applyBind({ record: readerA.record, sessionId: 'session-A', courseId: 'gfn1000', reason: 'A', at: 't2' }).record,
      writePolicy: s.writePolicy,
      version: versionA,
    }),
    (error) => error.code === 'PROFESSOR_BINDING_STALE',
  )

  // The file still reflects B's write.
  const after = JSON.parse(await fs.readFile(bindFile(s.project, 'session-A'), 'utf8'))
  assert.equal(after.course_id, 'csc3200')
  void target
})

test('writing without a write policy, or with an invalid record, is refused', async () => {
  const s = await scenario()
  const gateway = createFsGateway({ ctx: s.fake.ctx, logger: { warn() {} } })

  await assert.rejects(
    () => writeBinding({
      gateway, projectRoot: s.project, sessionId: 'session-A', record: emptyBinding('session-A'), version: undefined,
    }),
    (error) => error.code === 'PROFESSOR_PATH_DENIED',
  )

  await assert.rejects(
    () => writeBinding({
      gateway,
      projectRoot: s.project,
      sessionId: 'session-A',
      record: { history: 'not-a-list' },
      writePolicy: s.writePolicy,
      version: undefined,
    }),
    (error) => error.code === 'PROFESSOR_BINDING_CORRUPT',
  )

  // A corrupt file on disk is reported, not silently replaced.
  await writeFixture(s.home, 'courses/term/.professor/state/sessions/session-C.json', '{ not json')
  await assert.rejects(
    () => readBinding({ gateway, projectRoot: s.project, sessionId: 'session-C' }),
    (error) => error.code === 'PROFESSOR_BINDING_CORRUPT',
  )
})

test('binding requires a session, and rejects ambiguous or missing courses', async () => {
  const s = await scenario()

  // No session id on the exec → hard error, not a fallback to a default session.
  const noSession = { agent: { session: { header: { cwd: s.project } } } }
  await assert.rejects(
    () => s.tools.professor_session_bind.execute({ course: 'CSC3200' }, noSession),
    (error) => error.code === 'PROFESSOR_BINDING_SESSION_REQUIRED',
  )
  await assert.rejects(
    () => s.tools.professor_session_status.execute({}, noSession),
    (error) => error.code === 'PROFESSOR_BINDING_SESSION_REQUIRED',
  )

  const session = makeExec({ cwd: s.project, sessionId: 'session-A' })
  await assert.rejects(
    () => s.tools.professor_session_bind.execute({ course: 'PHY1001' }, session),
    (error) => error.code === 'PROFESSOR_COURSE_MISSING',
  )
  await assert.rejects(
    () => s.tools.professor_session_bind.execute({}, session),
    (error) => error.code === 'PROFESSOR_COURSE_INVALID',
  )
  await assert.rejects(
    () => s.tools.professor_session_bind.execute({ course: 'CSC3200', unbind: true }, session),
    (error) => error.code === 'PROFESSOR_COURSE_INVALID',
  )
})

test('the binding file path is sanitised and validateBinding is exact', () => {
  assert.throws(() => bindingFileFor('/proj', ''), (error) => error.code === 'PROFESSOR_BINDING_SESSION_REQUIRED')
  assert.throws(() => bindingFileFor('/proj', '../escape'), (error) => error.code === 'PROFESSOR_BINDING_SESSION_REQUIRED')
  // Only safe characters; a traversal attempt would be neutralised, and here it throws first.
  assert.throws(() => bindingFileFor('/proj', 'a/b'), (error) => error.code === 'PROFESSOR_BINDING_SESSION_REQUIRED')
  assert.throws(() => bindingFileFor('/proj', 'x/../y'), (error) => error.code === 'PROFESSOR_BINDING_SESSION_REQUIRED')
  assert.equal(bindingFileFor('/proj', 'a b-c.d'), path.join('/proj/.professor/state/sessions', 'a_b-c.d.json'))

  const base = emptyBinding('s1')
  assert.equal(validateBinding(base).ok, true)
  assert.equal(validateBinding({ ...base, history: 'x' }).ok, false)
  assert.equal(validateBinding({ ...base, course_id: 5 }).ok, false)
  assert.equal(validateBinding({ ...base, history: [{ course_id: 1 }] }).ok, false)
  assert.equal(validateBinding(null).ok, false)
})

test('the documented fallback is absent: no other session, cache or env default is consulted', async () => {
  const s = await scenario()
  // Write a tempting "default" binding for a session that does not exist, plus an unrelated one.
  await writeFixture(s.home, 'courses/term/.professor/state/sessions/default.json', JSON.stringify(emptyBinding('default')))
  await writeFixture(s.home, 'courses/term/.professor/state/sessions/session-A.json', JSON.stringify(emptyBinding('session-A')))

  const session = makeExec({ cwd: s.project, sessionId: 'session-Z' })
  const status = await s.tools.professor_session_status.execute({}, session)
  assert.equal(status.sessionId, 'session-Z')
  assert.equal(status.bound, false, 'session Z must not inherit from "default" or "A"')

  const source = await fs.readFile(path.join(s.fake.pluginRoot ?? '', ''), 'utf8').catch(() => '')
  void source
})
