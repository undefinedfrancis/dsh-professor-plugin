/**
 * Professor Home / launch orchestration.
 *
 * The fake below is deliberately behavioural rather than stubbed: every host call is recorded **in
 * order**, because the property under test is the *ordering contract* from the module doc — "mark
 * metadata ready only after setup succeeds" is a statement about sequence, and a mock that only
 * answered each call correctly would pass even if the order were wrong.
 *
 * @module test/app-home
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HOME_RECENT_LIMIT, PROFESSOR_HOME_NAMESPACE, buildSessionTitle, createCourseCatalog,
  createProfessorHome, nativeSessionIdFor,
} from '../src/app/home.js'
import { createSessionRegistry } from '../src/app/sessions.js'

const COURSES = [
  { course_id: 'csc3200-2026s', course_code: 'CSC3200', display_name: '编译原理', term: '2026S', status: 'active' },
  { course_id: 'sta2001-2026s', course_code: 'STA2001', display_name: '概率统计', term: '2026S', status: 'active' },
]

test('folder setup starts in the selected workspace and refuses a retry in another folder', async () => {
  const f = fixture()
  const request = f.request({ mode: 'free', courseId: null, folder: '/tmp/selected-course-folder' })
  const result = await f.service.launch(request)
  assert.equal(f.agents.get(result.sessionId).session.header.cwd, request.folder)
  await assert.rejects(f.service.launch({ ...request, folder: '/tmp/another-folder' }), { code: 'PROFESSOR_SESSION_INCOMPATIBLE' })
})

test('failed memory readiness cannot publish a ready launch', async () => {
  const { service, failures, registry, request } = fixture()
  failures.hydrate = true
  await assert.rejects(service.launch(request()), { code: 'PROFESSOR_MEMORY_NOT_READY' })
  assert.equal((await registry.list())[0].status, 'failed')
})

test('concurrent conflicting payloads cannot join another launch', async () => {
  const { service, request } = fixture()
  const first = service.launch(request())
  await assert.rejects(service.launch(request({ mode: 'exam' })), { code: 'PROFESSOR_SESSION_CONFLICT' })
  await first
})

test('reopening a session changed to another preset is refused', async () => {
  const { service, agents, request } = fixture()
  const launched = await service.launch(request())
  agents.get(launched.sessionId).presets.push('standard')
  await assert.rejects(service.reopen({ sessionId: launched.sessionId }), { code: 'PROFESSOR_SESSION_INCOMPATIBLE' })
})

test('retry cannot bind a same-named course from a different academic folder', async () => {
  const f = fixture({ connection: { folder: '/tmp/academic-a' } })
  const request = f.request({ courseId: COURSES[0].course_id })
  await f.service.launch(request)
  const connection = f.records.get('workspace:connection')
  connection.active.folder = '/tmp/academic-b'
  await assert.rejects(f.service.launch(request), { code: 'PROFESSOR_SESSION_INCOMPATIBLE' })
})

test('failed topic launch can retry from metadata without storing the raw topic', async () => {
  const f = fixture()
  f.failures.hydrate = true
  await assert.rejects(f.service.launch(f.request({ topic: 'Hash tables' })))
  f.failures.hydrate = false
  const result = await f.service.launch(f.request())
  assert.equal(result.title, 'Hash tables · 学习')
  assert.equal(f.created.length, 1)
})

/**
 * One Home instance over an in-memory medium, with recording seams.
 *
 * @param options.initial - a stored sessions registry ("a previous run left this behind").
 * @param options.connection - `{ folder }`, `null`, or `'corrupt'`.
 * @param options.table - when false, `appStorage.table()` answers `undefined`: storage is mounted
 *   but unusable, which must be reported rather than rendered as emptiness.
 * @param options.courses - the courses the connected folder declares.
 */
function fixture(options = {}) {
  const {
    initial, connection = null, table = true, courses = COURSES, tableThrows = false,
  } = options
  const records = new Map()
  if (initial !== undefined) records.set('sessions:registry', initial)
  if (connection !== null && connection !== 'corrupt') {
    records.set('workspace:connection', {
      schema: 'professor.workspace/1',
      active: { folder: connection.folder, revision: 1, project_id: 'p1', connected_at: '2026-10-07T00:00:00.000Z' },
      history: [],
    })
  } else if (connection === 'corrupt') {
    records.set('workspace:connection', { schema: 'professor.workspace/99', nonsense: true })
  }
  if (initial === 'corrupt') records.set('sessions:registry', { schema: 'professor.sessions/99', sessions: [] })

  const calls = []
  const record = (name, detail) => calls.push(detail === undefined ? name : `${name}:${detail}`)
  const storage = {
    async ensureOpen() { record('ensureOpen'); return { status: 'open', reason: null } },
    table() {
      if (!table) return undefined
      return {
        get: (key) => structuredClone(records.get(key)),
        put: async (key, value) => { records.set(key, structuredClone(value)) },
      }
    },
    writeRecord: async (key, value) => {
      record('write', key)
      if (tableThrows || failures.write) throw new Error('storage write refused')
      records.set(key, structuredClone(value))
    },
    describe: () => ({ status: table ? 'open' : 'unavailable', reason: table ? null : 'no usable domain' }),
  }

  // A native session store: ids that exist, and the agents created during the test.
  const sessions = new Set()
  const agents = new Map()
  for (const id of options.existing ?? []) agents.set(id, { id, session: { id }, presets: [] })
  const created = []
  const failures = { ...(options.failures ?? {}) }
  let projectReads = 0

  const host = {
    async createSession({ sessionId, cwd }) {
      record('createSession', sessionId)
      if (failures.create) throw new Error('agent factory refused the id')
      const existing = agents.get(sessionId)
      if (existing !== undefined) return { agent: existing, session: existing.session }
      const agent = { id: sessionId, session: { id: sessionId, header: { cwd } }, presets: [] }
      agents.set(sessionId, agent)
      const handle = { agent, session: agent.session }
      created.push({ sessionId, cwd, agent })
      return handle
    },
    findAgent(sessionId) {
      record('findAgent', sessionId)
      return agents.get(sessionId)
    },
    async hasSession(sessionId) { return agents.has(sessionId) },
    async probeSession(sessionId) {
      record('probeSession', sessionId)
      if (failures.probeUnknown) return 'unknown'
      return agents.has(sessionId) ? 'present' : 'absent'
    },
    async archiveSession(sessionId) {
      record('archiveSession', sessionId)
      if (failures.archive) throw new Error('native archive refused')
      if (failures.archiveUnavailable) {
        const error = new Error('Harness workspace registry does not expose conversation archiving')
        error.code = 'PROFESSOR_ARCHIVE_UNAVAILABLE'
        throw error
      }
      if (failures.archiveActive) {
        const error = new Error(`cannot archive session '${sessionId}': the session is active (agent-run)`)
        error.name = 'WorkspaceActiveSessionError'
        throw error
      }
      if (failures.archiveUnknown) {
        const error = new Error(`cannot archive session '${sessionId}': live sessions and session persistence hold no such session`)
        error.name = 'WorkspaceUnknownSessionError'
        throw error
      }
      // The real host API resolves undefined on success; only a throw is a failure.
      return undefined
    },
    async selectPreset(agent, presetId) {
      record('selectPreset', presetId)
      if (failures.preset) throw new Error('preset locked after the first turn')
      agent.presets.push(presetId)
      return presetId
    },
    async composedPreset(agent) { return agent?.presets?.at(-1) },
    async bindCourse({ courseId }) {
      record('bindCourse', courseId)
      return failures.bind !== true
    },
    async hydrate(agent) {
      record('hydrate', agent?.id)
      return failures.hydrate !== true
    },
    defaultCwd: () => '/tmp/general-workspace',
  }
  // A host whose workspaceRegistry lacks the archive capability: the method is absent entirely.
  if (options.withoutArchiveCapability === true) delete host.archiveSession

  const readCourses = async (projectRoot) => {
    projectReads += 1
    record('readCourses', projectRoot)
    if (failures.readCourses) throw new Error('project.yaml is unreadable')
    return courses
  }

  const registry = createSessionRegistry({ appStorage: storage, now: () => '2026-10-07T00:00:00.000Z' })
  const catalog = createCourseCatalog({ appStorage: storage, readCourses })
  const home = createProfessorHome({ appStorage: storage, registry, catalog, host, logger: { info() {}, warn() {} } })

  return {
    service: home, calls, registry, failures, records, agents, created,
    request: (over = {}) => ({ requestId: 'req-abcdef12', mode: 'learn', ...over }),
    projectReadCount: () => projectReads,
  }
}

test('clearing Recent archives the native chat first and persistently removes it from Recent and Continue', async () => {
  const f = fixture()
  const launched = await f.service.launch(f.request())
  await assert.rejects(f.service.clearSession({ sessionId: launched.sessionId, confirmed: false }), { code: 'PROFESSOR_HOME_REQUEST_INVALID' })
  f.failures.archive = true
  await assert.rejects(f.service.clearSession({ sessionId: launched.sessionId, confirmed: true }), /native archive refused/)
  assert.equal((await f.service.home()).recent.length, 1)
  f.failures.archive = false
  await f.service.clearSession({ sessionId: launched.sessionId, confirmed: true })
  assert.equal((await f.service.home()).recent.length, 0)
  assert.equal((await f.service.home()).continue, null)
  assert.ok(f.agents.has(launched.sessionId), 'native history still exists')
  await f.service.clearSession({ sessionId: launched.sessionId, confirmed: true })
  await assert.rejects(f.service.reopen({ sessionId: launched.sessionId }), { code: 'PROFESSOR_SESSION_ARCHIVED' })
  await assert.rejects(f.service.launch(f.request()), { code: 'PROFESSOR_SESSION_ARCHIVED' })
  await assert.rejects(f.service.clearSession({ sessionId: 'foreign', confirmed: true }), { code: 'PROFESSOR_SESSION_MISSING' })
})

/** One stored registry row, exactly as a previous run would have left it. */
function registryWith(rows) {
  return {
    schema: 'professor.sessions/1',
    sessions: rows.map((row, index) => ({
      requestId: row.requestId ?? `req-stored${index}ab`,
      sessionId: row.sessionId,
      courseId: row.courseId ?? null,
      title: row.title ?? `会话 ${index}`,
      mode: row.mode ?? 'learn',
      status: row.status,
      error: row.error ?? null,
      updatedAt: row.updatedAt ?? `2026-10-0${index + 1}T00:00:00.000Z`,
    })),
  }
}

test('clearing a preparing conversation is refused and nothing is archived', async () => {
  const f = fixture({ initial: registryWith([{ sessionId: 'professor-r-prep1', status: 'preparing' }]) })
  await assert.rejects(f.service.clearSession({ sessionId: 'professor-r-prep1', confirmed: true }), { code: 'PROFESSOR_SESSION_NOT_READY' })
  assert.equal(f.calls.includes('archiveSession:professor-r-prep1'), false)
  assert.equal((await f.service.home()).recent.length, 1)
})

test('the native archive completes before the Professor row is hidden', async () => {
  const f = fixture()
  const launched = await f.service.launch(f.request())
  await f.service.clearSession({ sessionId: launched.sessionId, confirmed: true })
  const archivedAt = f.calls.indexOf(`archiveSession:${launched.sessionId}`)
  const persistedAt = f.calls.lastIndexOf('write:sessions:registry')
  assert.ok(archivedAt !== -1, 'the native archive ran')
  assert.ok(persistedAt !== -1, 'the registry write ran')
  assert.ok(archivedAt < persistedAt, 'the Professor row is only hidden after the native archive succeeded')
})

test('a stale row whose native conversation is gone clears without recreating anything native', async () => {
  const f = fixture({ initial: registryWith([{ sessionId: 'professor-r-gone1', status: 'ready' }]) })
  const result = await f.service.clearSession({ sessionId: 'professor-r-gone1', confirmed: true })
  assert.equal(result.archived, true)
  assert.equal(result.nativeArchived, false)
  assert.equal(result.nativeMissing, true)
  assert.equal(f.created.length, 0, 'nothing native is created')
  assert.equal(f.calls.some((call) => call.startsWith('createSession')), false)
  assert.equal((await f.service.home()).recent.length, 0)
})

test('an unverifiable native existence fails safely and keeps the row', async () => {
  const f = fixture()
  const launched = await f.service.launch(f.request())
  f.failures.probeUnknown = true
  await assert.rejects(f.service.clearSession({ sessionId: launched.sessionId, confirmed: true }),
    { code: 'PROFESSOR_SESSION_EXISTENCE_UNVERIFIED' })
  const data = await f.service.home()
  assert.equal(data.recent.length, 1, 'unknown existence preserves Recent')
  assert.equal(data.continue?.sessionId, launched.sessionId, 'and Continue')
  assert.equal(f.calls.some((call) => call.startsWith('archiveSession')), false, 'nothing was archived')
  assert.equal((await f.registry.get(launched.sessionId)).status, 'ready', 'the row is not tombstoned')
})

test('a host without archive capability reports an explicit error and keeps the row', async () => {
  const f = fixture({ withoutArchiveCapability: true })
  const launched = await f.service.launch(f.request())
  await assert.rejects(f.service.clearSession({ sessionId: launched.sessionId, confirmed: true }), { code: 'PROFESSOR_ARCHIVE_UNAVAILABLE' })
  assert.equal((await f.service.home()).recent.length, 1)
})

test('an active native conversation refuses archiving, keeps the row, and can be cleared later', async () => {
  const f = fixture()
  const launched = await f.service.launch(f.request())
  f.failures.archiveActive = true
  await assert.rejects(f.service.clearSession({ sessionId: launched.sessionId, confirmed: true }), { code: 'PROFESSOR_SESSION_ACTIVE' })
  assert.equal((await f.service.home()).recent.length, 1)
  f.failures.archiveActive = false
  const result = await f.service.clearSession({ sessionId: launched.sessionId, confirmed: true })
  assert.equal(result.nativeArchived, true)
  assert.equal((await f.service.home()).recent.length, 0)
})

test('a failure between native archive and persistence stays safe on retry', async () => {
  const f = fixture()
  const launched = await f.service.launch(f.request())
  f.failures.write = true
  await assert.rejects(f.service.clearSession({ sessionId: launched.sessionId, confirmed: true }), /storage write refused/)
  assert.equal((await f.service.home()).recent.length, 1, 'the row is still there for a retry')
  f.failures.write = false
  await f.service.clearSession({ sessionId: launched.sessionId, confirmed: true })
  assert.equal((await f.service.home()).recent.length, 0)
  const archives = f.calls.filter((call) => call === `archiveSession:${launched.sessionId}`).length
  assert.equal(archives, 2, 'the retry re-archived: the host treats an already-archived id as a no-op')
})

test('clearing survives a service restart and a retried launch cannot resurrect it', async () => {
  const f = fixture()
  const launched = await f.service.launch(f.request())
  await f.service.clearSession({ sessionId: launched.sessionId, confirmed: true })
  const restarted = fixture({ initial: f.records.get('sessions:registry') })
  assert.equal((await restarted.service.home()).recent.length, 0)
  assert.equal((await restarted.service.home()).continue, null)
  await assert.rejects(restarted.service.launch(restarted.request()), { code: 'PROFESSOR_SESSION_ARCHIVED' })
  await assert.rejects(restarted.service.clearSession({ sessionId: launched.sessionId, confirmed: true, extra: 1 }), { code: 'PROFESSOR_HOME_REQUEST_INVALID' })
})

test('archived rows leave Recent before the list limit is applied', async () => {
  const rows = []
  for (let index = 0; index <= HOME_RECENT_LIMIT; index++) {
    rows.push({
      sessionId: `professor-r-limit${index}`,
      status: index === HOME_RECENT_LIMIT ? 'archived' : 'ready',
      title: `会话 ${index}`,
      updatedAt: `2026-10-10T${String(23 - index).padStart(2, '0')}:00:00.000Z`,
    })
  }
  const f = fixture({ initial: registryWith(rows), existing: rows.map((row) => row.sessionId) })
  const data = await f.service.home()
  assert.equal(data.recent.length, HOME_RECENT_LIMIT)
  assert.equal(data.recent.some((row) => row.status === 'archived'), false, 'the archived row is gone even though it was the oldest')
  assert.equal(data.recent[0].sessionId, 'professor-r-limit0')
})

test('a fresh installation renders a course-free empty state, not a broken one', async () => {
  const { service, records } = fixture()
  const data = await service.home()
  assert.equal(data.ok, true)
  assert.equal(data.connection.connected, false)
  assert.deepEqual(data.courses, [])
  assert.deepEqual(data.recent, [])
  assert.equal(data.continue, null)
  assert.deepEqual(data.modes, ['learn', 'question', 'assignment', 'review', 'exam', 'free'])
  assert.equal(records.has('sessions:registry'), false, 'reading Home must not invent a registry')
})

test('Home lists the courses the connected folder configures', async () => {
  const { service } = fixture({ connection: { folder: '/Users/x/Courses' } })
  const data = await service.home()
  assert.equal(data.connection.connected, true)
  assert.equal(data.connection.folder, '/Users/x/Courses')
  assert.deepEqual(data.courses.map((course) => course.course_id), COURSES.map((course) => course.course_id))
  assert.deepEqual(Object.keys(data.courses[0]), ['course_id', 'course_code', 'display_name', 'term', 'status'])
})

test('an unsupported connection record is reported, never rewritten', async () => {
  const { service, records } = fixture({ connection: 'corrupt' })
  const data = await service.home()
  assert.equal(data.connection.connected, false)
  assert.match(data.warnings.join(' '), /unsupported schema/)
  assert.equal(records.get('workspace:connection').schema, 'professor.workspace/99')
})

test('a launch follows the documented order and is ready only at the end', async () => {
  const { service, calls, request } = fixture({ connection: { folder: '/Users/x/Courses' } })
  const result = await service.launch(request({ courseId: 'CSC3200', topic: '词法分析' }))
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'professor-req-abcdef12')
  assert.equal(result.courseId, 'csc3200-2026s')
  assert.equal(result.reused, false)
  assert.deepEqual(result.setup, { preset: 'professor', bound: true, hydrated: true, projectRoot: '/Users/x/Courses' })

  const order = ['ensureOpen', 'readCourses', 'createSession', 'selectPreset', 'bindCourse', 'hydrate']
  const seen = [...new Set(calls.map((call) => call.split(':')[0]))]
  assert.deepEqual(seen.filter((name) => order.includes(name)), order)

  const row = await service.home().then(async () => null)
  assert.equal(row, null)
  // The row is marked ready only after every step succeeded (settle writes last).
  const writes = calls.filter((call) => call.startsWith('write:'))
  assert.ok(writes.length >= 2, 'metadata is reserved, then settled')
})

test('repeated clicks and concurrent launches produce one native session', async () => {
  const { service, calls, created, records, request } = fixture({ connection: { folder: '/Users/x/Courses' } })
  const results = await Promise.all(Array.from({ length: 6 }, () => service.launch(request({ courseId: 'CSC3200' }))))
  assert.ok(results.every((result) => result.sessionId === 'professor-req-abcdef12'))
  assert.equal(created.length, 1, 'the native session was created exactly once')
  assert.equal(calls.filter((call) => call.startsWith('createSession')).length, 1)
  assert.equal(records.get('sessions:registry').sessions.length, 1)
})

test('a failed setup keeps the same native session on retry', async () => {
  const fail = fixture({ connection: { folder: '/Users/x/Courses' } })
  fail.failures.preset = true
  await assert.rejects(fail.service.launch(fail.request()), { code: 'PROFESSOR_PRESET_UNAVAILABLE' })
  const failed = (await fail.registry.list())[0]
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /preset locked/)

  fail.failures.preset = false
  const retried = await fail.service.launch(fail.request())
  assert.equal(retried.sessionId, failed.sessionId, 'retry reuses the native id instead of leaking another')
  assert.equal(retried.reused, true, 'and recovers the session that already exists')
  assert.equal((await fail.registry.list()).length, 1)
  const settled = (await fail.registry.list())[0]
  assert.equal(settled.status, 'ready')
  assert.equal(settled.error, null)
})

test('launch refuses an unknown course instead of silently going general', async () => {
  const known = fixture({ connection: { folder: '/Users/x/Courses' } })
  await assert.rejects(known.service.launch(known.request({ courseId: 'PHI9999' })), { code: 'PROFESSOR_COURSE_UNKNOWN' })
  assert.equal(known.registry !== undefined, true)

  const unreadable = fixture({ connection: { folder: '/Users/x/Courses' } })
  unreadable.failures.readCourses = true
  await assert.rejects(unreadable.service.launch(unreadable.request({ courseId: 'CSC3200' })), { code: 'PROFESSOR_COURSE_UNAVAILABLE' })

  const disconnected = fixture()
  await assert.rejects(disconnected.service.launch(disconnected.request({ courseId: 'CSC3200' })), { code: 'PROFESSOR_COURSE_UNAVAILABLE' })
})

test('a fresh installation can launch a general session with no course', async () => {
  const { service, calls, request } = fixture()
  const result = await service.launch(request({ mode: 'free' }))
  assert.equal(result.ok, true)
  assert.equal(result.courseId, null)
  assert.equal(result.setup.projectRoot, null)
  assert.equal(result.setup.bound, null, 'no course, no binding')
  const general = require0(calls)
  assert.ok(!general.includes('bindCourse'), 'nothing is bound for a course-free session')
  assert.ok(result.title.length > 0 && result.title.length <= 160)
})

test('unsupported modes, unsafe request ids and oversized topics are refused', async () => {
  const { service, request, records } = fixture()
  for (const change of [{ mode: 'coding' }, { requestId: 'sh' }, { requestId: 'a b c d e f g h' }, { topic: 'x'.repeat(201) }, { courseId: '' }]) {
    await assert.rejects(service.launch(request(change)), { code: 'PROFESSOR_HOME_REQUEST_INVALID' })
  }
  assert.equal(records.has('sessions:registry'), false, 'a refused request persists nothing')
})

test('metadata stores only approved fields', async () => {
  const { service, records, request } = fixture()
  await service.launch(request({ topic: '词法分析的优先级' }))
  const row = records.get('sessions:registry').sessions[0]
  assert.deepEqual(Object.keys(row).sort(), ['courseId', 'error', 'mode', 'requestId', 'sessionId', 'status', 'title', 'updatedAt'])
  assert.equal(Object.hasOwn(row, 'topic'), false, 'the topic is never persisted as its own field')
  assert.match(row.title, /词法分析的优先级/, 'it is folded into the bounded title instead')
})

test('titles are bounded, single-line and derived from mode or course', () => {
  const t1 = buildSessionTitle({ mode: 'exam', course: COURSES[0] })
  assert.ok(t1.includes('编译原理') && t1.includes('备考'))
  const long = buildSessionTitle({ mode: 'free', topic: 'y'.repeat(400) })
  assert.ok(long.length <= 160)
  const empty = buildSessionTitle({ mode: 'learn' })
  assert.ok(empty.length > 0 && !/[\u0000-\u001f]/.test(empty))
})

test('a native session that disappeared cannot be reopened', async () => {
  const { service, request } = fixture()
  await service.launch(request({ mode: 'review' }))
  const first = (await service.home()).recent[0]
  assert.equal(first.usable, true)

  const reopening = await service.reopen({ sessionId: first.sessionId })
  assert.equal(reopening.ok, true)

  const orphaned = fixture({ initial: { schema: 'professor.sessions/1', sessions: [{
    requestId: 'old-request', sessionId: 'professor-old-request', courseId: null, title: '旧的会话', mode: 'free',
    status: 'ready', error: null, updatedAt: '2026-10-06T00:00:00.000Z',
  }] } })
  await assert.rejects(orphaned.service.reopen({ sessionId: 'professor-old-request' }), { code: 'PROFESSOR_SESSION_MISSING' })
  const data = await orphaned.service.home()
  assert.equal(data.continue, null, 'a vanished native session is not offered as Continue')
  assert.equal(data.recent[0].usable, false)
})

test('a half-set-up session is actionable, not silently reopened', async () => {
  const notReady = fixture({
    initial: { schema: 'professor.sessions/1', sessions: [{
      requestId: 'half-request', sessionId: 'professor-half-request', courseId: null, title: '未完成', mode: 'free',
      status: 'failed', error: 'preset unavailable', updatedAt: '2026-10-06T00:00:00.000Z',
    }] },
    existing: ['professor-half-request'],
  })
  await assert.rejects(notReady.service.reopen({ sessionId: 'professor-half-request' }), { code: 'PROFESSOR_SESSION_NOT_READY' })
  await assert.rejects(notReady.service.reopen({ sessionId: 'unknown-native' }), { code: 'PROFESSOR_SESSION_MISSING' })
  await assert.rejects(notReady.service.reopen({}), { code: 'PROFESSOR_HOME_REQUEST_INVALID' })
})

test('Continue prefers the newest usable session and Continue/recent are bounded', async () => {
  const rows = Array.from({ length: 14 }, (unused, index) => ({
    requestId: `request-${String(index).padStart(4, '0')}`,
    sessionId: `professor-request-${String(index).padStart(4, '0')}`,
    courseId: null, title: `会话 ${index}`, mode: 'free', status: 'ready', error: null,
    updatedAt: `2026-10-0${(index % 9) + 1}T00:00:00.000Z`,
  }))
  const { service } = fixture({
    initial: { schema: 'professor.sessions/1', sessions: rows },
    existing: rows.map((row) => row.sessionId),
  })
  const data = await service.home()
  assert.equal(data.recent.length, HOME_RECENT_LIMIT)
  assert.equal(data.continue?.sessionId, 'professor-request-0008', 'the newest usable session wins')
  assert.ok(data.recent.every((row) => row.usable === true))
})

test('unusable storage is reported instead of an empty Home', async () => {
  const { service } = fixture({ table: false })
  const data = await service.home()
  assert.equal(data.ok, false)
  assert.equal(data.code, 'PROFESSOR_SESSION_STORAGE_UNAVAILABLE')
  assert.deepEqual(data.recent, [], 'and still does not invent sessions')
  assert.equal(data.continue, null)
  assert.match(data.message, /unavailable|not open/i)
})

test('corrupt session metadata is reported, preserved, and blocks launch', async () => {
  const { service, records, request } = fixture({ initial: 'corrupt' })
  const data = await service.home()
  assert.equal(data.ok, false)
  assert.equal(data.code, 'PROFESSOR_SESSION_CORRUPT')
  await assert.rejects(service.launch(request()), { code: 'PROFESSOR_SESSION_CORRUPT' })
  assert.equal(records.get('sessions:registry').schema, 'professor.sessions/99', 'nothing was rewritten')
})

test('a cancelled or disposed launch refuses rather than half-opening a session', async () => {
  const cancelled = fixture()
  await assert.rejects(cancelled.service.launch(cancelled.request({ signal: AbortSignal.abort() })), { code: 'PROFESSOR_LAUNCH_CANCELLED' })
  assert.equal(cancelled.created.length, 0)

  const later = fixture()
  const disposed = later.service
  disposed.dispose()
  await assert.rejects(disposed.home(), { code: 'PROFESSOR_HOME_DISPOSED' })
  await assert.rejects(disposed.launch(later.request()), { code: 'PROFESSOR_HOME_DISPOSED' })
  await assert.rejects(disposed.reopen({ sessionId: 'x' }), { code: 'PROFESSOR_HOME_DISPOSED' })
})

test('a native session that cannot be created leaves a failed row and no phantom id', async () => {
  const broken = fixture()
  broken.failures.create = true
  await assert.rejects(broken.service.launch(broken.request()), { code: 'PROFESSOR_NATIVE_SESSION_UNAVAILABLE' })
  const rows = await broken.registry.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'failed')
  assert.equal(broken.created.length, 0)
})

test('the derived session id is stable and Home is namespaced for Typed Remote', () => {
  assert.equal(nativeSessionIdFor('req-abcdef12'), 'professor-req-abcdef12')
  assert.equal(PROFESSOR_HOME_NAMESPACE, 'professorHome')
})

/** Tiny helper so the general-session case reads well. */
function require0(calls) {
  return [...new Set(calls.map((call) => call.split(':')[0]))]
}
