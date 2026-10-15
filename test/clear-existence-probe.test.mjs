/**
 * Clearing must tri-state native existence through the **production adapter**.
 *
 * The acceptance finding: `createLaunchHost().hasSession()` collapsed "the native session query is
 * unavailable or threw" into `false`, and `clearSession()` treated that as confirmed absence —
 * hiding the Professor row without archiving the native chat. A Home-only fixture that fakes
 * `hasSession: async () => false` cannot reproduce that adapter bug, so these tests wire the real
 * `createLaunchHost` (src/plugin.js) to the real `createProfessorHome` (src/app/home.js) over mock
 * host *services* (sessionQuery / agents / sessions / workspaceRegistry), exactly as the plugin
 * assembles them.
 *
 * @module test/clear-existence-probe
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createCourseCatalog, createProfessorHome } from '../src/app/home.js'
import { createSessionRegistry } from '../src/app/sessions.js'
import { createLaunchHost } from '../src/plugin.js'

/** One stored registry row, exactly as a previous run would have left it. */
function registryWith(sessionId, over = {}) {
  return {
    schema: 'professor.sessions/1',
    sessions: [{
      requestId: 'req-probe00ab',
      sessionId,
      courseId: null,
      title: 'Hash tables · 学习',
      mode: 'learn',
      status: over.status ?? 'ready',
      error: null,
      updatedAt: '2026-10-09T12:00:00.000Z',
    }],
  }
}

/**
 * Production adapter + production Home service over mock host services.
 *
 * `services.persistence` is the mock's ground truth of what native history exists; `sessionQuery`
 * is the *only* discovery channel the probe may use, and it can throw or be absent independently
 * of that ground truth — which is exactly the gap the adapter bug fell into.
 */
function fixture({ sessionId = 'professor-r-probe1', query = 'ok', live = false } = {}) {
  const records = new Map([['sessions:registry', registryWith(sessionId)]])
  const archiveCalls = []
  const services = {}
  services.agents = { get: (id) => (live && id === sessionId ? { id, session: { id } } : undefined) }
  services.sessions = { get: () => undefined }
  services.persistence = new Set(live ? [] : [sessionId]) // ground truth: this native chat exists
  if (query === 'ok') {
    services.sessionQuery = {
      listSessions: async () => [...services.persistence].map((id) => ({ header: { id } })),
    }
  } else if (query === 'throws') {
    services.sessionQuery = { listSessions: async () => { throw new Error('session index is unavailable') } }
  } // query === 'missing': no sessionQuery service at all
  services.workspaceRegistry = {
    async archiveSession(id, options) {
      archiveCalls.push([id, options])
      return undefined // the installed host resolves undefined on success
    },
    async unarchiveSession() {},
  }

  const appStorage = {
    async ensureOpen() { return { status: 'open', reason: null } },
    table: () => ({
      get: (key) => structuredClone(records.get(key)),
      put: async (key, value) => { records.set(key, structuredClone(value)) },
    }),
    writeRecord: async (key, value) => { records.set(key, structuredClone(value)) },
    describe: () => ({ status: 'open', reason: null }),
  }
  const host = createLaunchHost({ ctx: { get: (name) => services[name] }, logger: { info() {}, warn() {} } })
  const registry = createSessionRegistry({ appStorage, now: () => '2026-10-10T00:00:00.000Z' })
  const catalog = createCourseCatalog({ appStorage, readCourses: async () => [] })
  const home = createProfessorHome({ appStorage, registry, catalog, host, logger: { info() {}, warn() {} } })
  return { home, registry, host, services, archiveCalls, sessionId }
}

test('a throwing native session query makes clearing fail safely instead of hiding the row', async () => {
  const f = fixture({ query: 'throws' })
  await assert.rejects(f.home.clearSession({ sessionId: f.sessionId, confirmed: true }),
    { code: 'PROFESSOR_SESSION_EXISTENCE_UNVERIFIED' })
  assert.equal(f.archiveCalls.length, 0, 'nothing was archived')
  assert.equal((await f.registry.get(f.sessionId)).status, 'ready', 'the Professor row is not tombstoned')
  assert.ok(f.services.persistence.has(f.sessionId), 'the native chat is untouched')
})

test('a missing session-query capability also fails safely', async () => {
  const f = fixture({ query: 'missing' })
  assert.equal(await f.host.probeSession(f.sessionId), 'unknown')
  await assert.rejects(f.home.clearSession({ sessionId: f.sessionId, confirmed: true }),
    { code: 'PROFESSOR_SESSION_EXISTENCE_UNVERIFIED' })
  assert.equal(f.archiveCalls.length, 0)
  assert.equal((await f.registry.get(f.sessionId)).status, 'ready')
})

test('a native chat that exists but cannot be discovered is never stale-cleaned', async () => {
  // The chat really exists (mock persistence holds it), but every lookup channel fails: the id is
  // not live and the index query throws. The pre-fix adapter answered `hasSession === false` here
  // and clearSession silently hid the row without archiving.
  const f = fixture({ query: 'throws', live: false })
  assert.ok(f.services.persistence.has(f.sessionId))
  assert.equal(await f.host.probeSession(f.sessionId), 'unknown', 'an undiscoverable chat is unknown, not absent')
  await assert.rejects(f.home.clearSession({ sessionId: f.sessionId, confirmed: true }),
    { code: 'PROFESSOR_SESSION_EXISTENCE_UNVERIFIED' })
  assert.equal(f.archiveCalls.length, 0, 'no archive was attempted on an unverified existence')
  assert.equal((await f.registry.get(f.sessionId)).status, 'ready')
  assert.ok(f.services.persistence.has(f.sessionId), 'the native chat still exists')
})

test('unknown existence preserves Recent and Continue', async () => {
  const f = fixture({ query: 'throws' })
  const before = await f.home.home()
  assert.equal(before.recent.length, 1)
  await assert.rejects(f.home.clearSession({ sessionId: f.sessionId, confirmed: true }),
    { code: 'PROFESSOR_SESSION_EXISTENCE_UNVERIFIED' })
  const after = await f.home.home()
  assert.deepEqual(after.recent, before.recent, 'Recent is unchanged')
  assert.deepEqual(after.continue, before.continue, 'and Continue')
})

test('confirmed absence still permits stale-row cleanup without an archive', async () => {
  const f = fixture({ query: 'ok' })
  f.services.persistence.delete(f.sessionId) // ground truth: the native chat is gone
  assert.equal(await f.host.probeSession(f.sessionId), 'absent')
  const result = await f.home.clearSession({ sessionId: f.sessionId, confirmed: true })
  assert.equal(result.archived, true)
  assert.equal(result.nativeMissing, true)
  assert.equal(result.nativeArchived, false)
  assert.equal(f.archiveCalls.length, 0, 'a positively absent chat needs no archive')
  assert.equal((await f.registry.get(f.sessionId)).status, 'archived')
  assert.equal((await f.home.home()).recent.length, 0)
})

test('successful native archiving is unchanged: present probes archive first, then hide', async () => {
  const f = fixture({ query: 'ok' })
  assert.equal(await f.host.probeSession(f.sessionId), 'present')
  const result = await f.home.clearSession({ sessionId: f.sessionId, confirmed: true })
  assert.equal(result.nativeArchived, true)
  assert.deepEqual(f.archiveCalls, [[f.sessionId, { stopActivity: false }]], 'the exact archive call, never a forced stop')
  assert.equal((await f.registry.get(f.sessionId)).status, 'archived')
  const data = await f.home.home()
  assert.equal(data.recent.length, 0)
  assert.equal(data.continue, null)
  const repeat = await f.home.clearSession({ sessionId: f.sessionId, confirmed: true })
  assert.equal(repeat.repeat, true)
  assert.equal(f.archiveCalls.length, 1, 'the repeat archives nothing')
})

test('the archive API\'s definite miss remains confirmed absence even after a present probe', async () => {
  const f = fixture({ query: 'ok' })
  f.services.workspaceRegistry.archiveSession = async () => {
    const error = new Error('cannot archive session: live sessions and session persistence hold no such session')
    error.name = 'WorkspaceUnknownSessionError'
    throw error
  }
  const result = await f.home.clearSession({ sessionId: f.sessionId, confirmed: true })
  assert.equal(result.nativeMissing, true, 'a vanished chat between probe and archive is safely stale-cleaned')
  assert.equal((await f.registry.get(f.sessionId)).status, 'archived')
})
