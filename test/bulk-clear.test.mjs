/**
 * Bulk conversation clearing: one confirmation over a backend-owned snapshot, sequential
 * per-item clearing through the same safety kernel as the single-row clear.
 *
 * These are Home-service tests over a behavioural fake host (tri-state probe, recording archive
 * calls). Adapter-level existence semantics are integrated separately in
 * `test/clear-existence-probe.test.mjs`; the fake here mirrors that contract so the bulk
 * classification rules (cleared/skipped/failed) are pinned in isolation.
 *
 * @module test/bulk-clear
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { HOME_RECENT_LIMIT, createCourseCatalog, createProfessorHome } from '../src/app/home.js'
import { createSessionRegistry } from '../src/app/sessions.js'

const SCHEMA = 'professor.sessions/1'

function row(sessionId, over = {}) {
  return {
    requestId: over.requestId ?? `req-${sessionId}`,
    sessionId,
    courseId: over.courseId ?? null,
    title: over.title ?? `会话 ${sessionId}`,
    mode: over.mode ?? 'learn',
    status: over.status ?? 'ready',
    error: over.error ?? null,
    updatedAt: over.updatedAt ?? '2026-10-09T12:00:00.000Z',
  }
}

/**
 * One Home service over an in-memory app domain and a recording fake host.
 *
 * `options.rows` seeds the registry; `options.failures` drives per-item behaviour; `live` is the
 * set of session ids whose native chat exists (everything else is a positively absent native
 * unless `failures.probeUnknown` forces the unknown state).
 */
function fixture(options = {}) {
  const records = new Map()
  if (options.rows) records.set('sessions:registry', { schema: SCHEMA, sessions: options.rows })
  if (options.extraRecords) for (const [key, value] of options.extraRecords) records.set(key, structuredClone(value))
  const failures = { ...(options.failures ?? {}) }
  const live = new Set(options.live ?? (options.rows ?? []).map(entry => entry.sessionId))
  const calls = []
  const record = (name, detail) => calls.push(detail === undefined ? name : `${name}:${detail}`)
  const host = {
    async createSession({ sessionId, cwd }) {
      record('createSession', sessionId)
      const agent = { id: sessionId, session: { id: sessionId, header: { cwd } }, presets: [] }
      live.add(sessionId)
      return { agent, session: agent.session }
    },
    findAgent(sessionId) { return live.has(sessionId) ? { id: sessionId, session: { id: sessionId } } : undefined },
    async hasSession(sessionId) { return live.has(sessionId) },
    async probeSession(sessionId) {
      record('probeSession', sessionId)
      if (failures.probeUnknown) return 'unknown'
      return live.has(sessionId) ? 'present' : 'absent'
    },
    async archiveSession(sessionId) {
      record('archiveSession', sessionId)
      if (failures.archive) throw new Error('native archive refused')
      if (failures.archiveActive) {
        const error = new Error(`cannot archive session '${sessionId}': the session is active (agent-run)`)
        error.name = 'WorkspaceActiveSessionError'
        throw error
      }
      live.delete(sessionId) // archiving moves the chat out of the live set; history "remains"
      return undefined
    },
    async selectPreset(agent, presetId) { agent.presets.push(presetId); return presetId },
    async composedPreset(agent) { return agent?.presets?.at(-1) },
    async bindCourse() { return true },
    async hydrate() { return true },
    defaultCwd: () => '/tmp/general-workspace',
    async setTitle() {},
  }
  const appStorage = {
    async ensureOpen() { return { status: 'open', reason: null } },
    table: () => ({ get: (key) => structuredClone(records.get(key)), put: async (key, value) => { records.set(key, structuredClone(value)) } }),
    writeRecord: async (key, value) => { record('write', key); records.set(key, structuredClone(value)) },
    describe: () => ({ status: 'open', reason: null }),
  }
  const registryRaw = createSessionRegistry({ appStorage, now: () => '2026-10-10T00:00:00.000Z' })
  // Injectable lookup fault: `failures.getThrowsFor` makes exactly that row's registry.get fail,
  // which is the acceptance finding's mid-batch storage fault.
  const registry = {
    ...registryRaw,
    get: async (sessionId) => {
      if (failures.getThrowsFor === sessionId) {
        record('getThrow', sessionId)
        throw new Error('storage read refused')
      }
      return registryRaw.get(sessionId)
    },
  }
  const catalog = createCourseCatalog({ appStorage, readCourses: async () => [] })
  const home = createProfessorHome({ appStorage, registry, catalog, host, logger: { info() {}, warn() {} } })
  return { home, registry, registryRaw, host, records, calls, failures, live }
}

/** Drive one bulk clear to completion and collect every batch result. */
async function drain(home, token) {
  const batches = [await home.clearAllStart({ token })]
  while (!batches.at(-1).done) batches.push(await home.clearAllContinue({ operationId: batches[0].operationId }))
  return batches
}

test('the snapshot covers every non-archived row beyond the visible Recent limit', async () => {
  const rows = []
  for (let index = 0; index < HOME_RECENT_LIMIT + 4; index++) {
    rows.push(row(`professor-r-bulk${index}`, { updatedAt: `2026-10-10T${String(23 - index).padStart(2, '0')}:00:00.000Z` }))
  }
  rows.push(row('professor-r-oldarch', { status: 'archived', updatedAt: '2026-10-01T00:00:00.000Z' }))
  const f = fixture({ rows })
  const data = await f.home.home()
  assert.equal(data.recent.length, HOME_RECENT_LIMIT, 'the list shows only the limit')
  const snapshot = await f.home.clearAllSnapshot()
  assert.equal(snapshot.count, HOME_RECENT_LIMIT + 4, 'the snapshot includes rows the list hides')
  assert.equal(snapshot.previews.length <= 5, true)
})

test('native-only or foreign sessions are never in the snapshot', async () => {
  const f = fixture({ rows: [row('professor-r-one')], live: ['professor-r-one', 'some-native-chat'] })
  const snapshot = await f.home.clearAllSnapshot()
  assert.equal(snapshot.count, 1, 'only registry rows are targeted')
  const batches = await drain(f.home, snapshot.token)
  const touched = batches.flatMap(b => b.outcomes).map(o => o.sessionId)
  assert.deepEqual(touched, ['professor-r-one'])
  assert.ok(f.live.has('some-native-chat'), 'the native-only chat was never archived')
})

test('a conversation created after the snapshot is not swept up', async () => {
  const f = fixture({ rows: [row('professor-r-first')] })
  const snapshot = await f.home.clearAllSnapshot()
  await f.registry.reserve({ requestId: 'req-later00ab', sessionId: 'professor-r-later', courseId: null, title: '后来的对话', mode: 'learn' })
  await drain(f.home, snapshot.token)
  assert.equal((await f.home.home()).recent.some(entry => entry.sessionId === 'professor-r-later'), true,
    'the later conversation is still listed')
  assert.equal((await f.registry.get('professor-r-first')).status, 'archived')
})

test('a snapshot alone performs no mutation (cancel-before-confirm is a no-op)', async () => {
  const f = fixture({ rows: [row('professor-r-one')] })
  await f.home.clearAllSnapshot()
  assert.equal(f.calls.some(call => call.startsWith('archiveSession')), false, 'no archive before confirmation')
  assert.equal((await f.registry.get('professor-r-one')).status, 'ready')
})

test('the snapshot reports the exact count that confirmation commits to', async () => {
  const f = fixture({ rows: [row('a1'), row('a2'), row('a3', { status: 'preparing' })] })
  const snapshot = await f.home.clearAllSnapshot()
  assert.equal(snapshot.count, 3, 'preparing rows are in scope (skipped later), counted up front')
})

test('a duplicate start is rejected and cannot consume the snapshot twice', async () => {
  const f = fixture({ rows: [row('professor-r-one')] })
  const snapshot = await f.home.clearAllSnapshot()
  const first = await f.home.clearAllStart({ token: snapshot.token })
  assert.equal(first.done, true)
  await assert.rejects(f.home.clearAllStart({ token: snapshot.token }), { code: 'PROFESSOR_CLEAR_ALL_TOKEN_INVALID' })
  assert.equal(f.calls.filter(call => call.startsWith('archiveSession')).length, 1)
})

test('concurrent continuations join one batch instead of double-processing', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => row(`professor-r-c${index}`))
  const f = fixture({ rows })
  const snapshot = await f.home.clearAllSnapshot()
  const started = await f.home.clearAllStart({ token: snapshot.token })
  assert.equal(started.outcomes.length, 5, 'one bounded batch per call')
  const [left, right] = await Promise.all([
    f.home.clearAllContinue({ operationId: started.operationId }),
    f.home.clearAllContinue({ operationId: started.operationId }),
  ])
  // Either the duplicate joined the same run (identical outcomes) or the second hit the completed
  // idempotent report — never a second processing pass over the same cursor.
  const archives = f.calls.filter(call => call.startsWith('archiveSession')).length
  assert.equal(archives, 8, 'each row archived exactly once')
  assert.equal(left.operationId, right.operationId)
  const done = await f.home.clearAllContinue({ operationId: started.operationId })
  assert.equal(done.done, true)
  assert.equal(done.counts.remaining, 0)
})

test('mixed outcomes are reported truthfully and independent targets continue', async () => {
  const rows = [
    row('professor-r-ok'),
    row('professor-r-prep', { status: 'preparing' }),
    row('professor-r-active'),
    row('professor-r-dead'), // absent native: stale-row cleanup
    row('professor-r-fail'),
    row('professor-r-unknown'),
  ]
  const f = fixture({
    rows,
    live: ['professor-r-ok', 'professor-r-active', 'professor-r-fail', 'professor-r-unknown'],
    failures: { archiveActive: false, probeUnknown: false },
  })
  // Per-item failure injection: only the one target's archive refuses.
  const original = f.host.archiveSession
  f.host.archiveSession = async (sessionId) => {
    if (sessionId === 'professor-r-fail') throw new Error('native archive refused')
    return original.call(f.host, sessionId)
  }
  // The unknown row: flip the probe just for it.
  const originalProbe = f.host.probeSession
  f.host.probeSession = async (sessionId) => (sessionId === 'professor-r-unknown' ? 'unknown' : originalProbe.call(f.host, sessionId))
  const snapshot = await f.home.clearAllSnapshot()
  const batches = await drain(f.home, snapshot.token)
  const outcomes = batches.flatMap(batch => batch.outcomes)
  const byId = Object.fromEntries(outcomes.map(entry => [entry.sessionId, entry]))
  assert.equal(byId['professor-r-ok'].status, 'cleared')
  assert.equal(byId['professor-r-prep'].status, 'skipped', 'preparing is skipped safely')
  assert.equal(byId['professor-r-active'].status, 'cleared', 'idle at probe time: the fake host archives')
  assert.equal(byId['professor-r-dead'].status, 'cleared', 'positively absent native: stale-row cleanup counts as cleared')
  assert.equal(byId['professor-r-fail'].status, 'failed', 'an archive refusal is a failure, not success')
  assert.equal(byId['professor-r-unknown'].status, 'failed', 'unknown existence fails safely')
  assert.match(byId['professor-r-unknown'].reason, /PROFESSOR_SESSION_EXISTENCE_UNVERIFIED/)
  const final = batches.at(-1).counts
  assert.deepEqual(final, { cleared: 3, skipped: 1, failed: 2, remaining: 0 })
  // Independent targets were not abandoned after the failures.
  assert.equal((await f.registry.get('professor-r-ok')).status, 'archived')
  assert.equal((await f.registry.get('professor-r-fail')).status, 'ready', 'a failed row is preserved')
  assert.equal((await f.registry.get('professor-r-unknown')).status, 'ready', 'an unknown-existence row is preserved')
  assert.equal((await f.registry.get('professor-r-prep')).status, 'preparing')
})

test('an active conversation is skipped, never forcibly stopped', async () => {
  const f = fixture({ rows: [row('professor-r-active')], live: ['professor-r-active'], failures: { archiveActive: true } })
  const snapshot = await f.home.clearAllSnapshot()
  const batches = await drain(f.home, snapshot.token)
  assert.equal(batches[0].outcomes[0].status, 'skipped')
  assert.match(batches[0].outcomes[0].reason, /finish or stop/)
  assert.equal((await f.registry.get('professor-r-active')).status, 'ready')
})

test('unknown existence in bulk never hides an unarchived chat', async () => {
  const f = fixture({ rows: [row('professor-r-maybe')], live: ['professor-r-maybe'], failures: { probeUnknown: true } })
  const snapshot = await f.home.clearAllSnapshot()
  const batches = await drain(f.home, snapshot.token)
  assert.equal(batches[0].outcomes[0].status, 'failed')
  assert.equal(f.live.has('professor-r-maybe'), true, 'the native chat is untouched')
  const data = await f.home.home()
  assert.equal(data.recent.length, 1, 'and the row stays in Recent')
})

test('an archive failure preserves the row for a later explicit retry', async () => {
  const f = fixture({ rows: [row('professor-r-fail')], live: ['professor-r-fail'], failures: { archive: true } })
  const snapshot = await f.home.clearAllSnapshot()
  const batches = await drain(f.home, snapshot.token)
  assert.equal(batches[0].counts.failed, 1)
  assert.equal((await f.registry.get('professor-r-fail')).status, 'ready')
  // The retry path is a fresh snapshot + confirmation, exactly as the UI offers.
  f.failures.archive = false
  const retry = await f.home.clearAllSnapshot()
  assert.equal(retry.count, 1, 'the fresh snapshot sees exactly the remaining rows')
  const second = await drain(f.home, retry.token)
  assert.equal(second.at(-1).counts.cleared, 1)
})

test('token validation: unknown, replayed and expired tokens never widen the scope', async t => {
  const f = fixture({ rows: [row('professor-r-one')] })
  await assert.rejects(f.home.clearAllStart({ token: 'clr-nope' }), { code: 'PROFESSOR_CLEAR_ALL_TOKEN_INVALID' })
  await assert.rejects(f.home.clearAllStart({ request: {} }), { code: 'PROFESSOR_HOME_REQUEST_INVALID' })

  t.mock.timers.enable({ apis: ['Date'], now: 0 })
  const snapshot = await f.home.clearAllSnapshot()
  t.mock.timers.tick(120_001) // past the confirmation TTL
  await assert.rejects(f.home.clearAllStart({ token: snapshot.token }), { code: 'PROFESSOR_CLEAR_ALL_TOKEN_EXPIRED' })
  assert.equal(f.calls.some(call => call.startsWith('archiveSession')), false)
  assert.equal((await f.registry.get('professor-r-one')).status, 'ready', 'expiry touched nothing')
})

test('an expired operation stops at its cursor and never expands to new conversations', async t => {
  const rows = Array.from({ length: 6 }, (_, index) => row(`professor-r-e${index}`))
  const f = fixture({ rows })
  t.mock.timers.enable({ apis: ['Date'], now: 0 })
  const snapshot = await f.home.clearAllSnapshot()
  const started = await f.home.clearAllStart({ token: snapshot.token })
  assert.equal(started.outcomes.length, 5)
  await f.registry.reserve({ requestId: 'req-later00cd', sessionId: 'professor-r-later', courseId: null, title: '后来', mode: 'learn' })
  t.mock.timers.tick(300_001) // the operation runs out of time before finishing
  await assert.rejects(f.home.clearAllContinue({ operationId: started.operationId }), { code: 'PROFESSOR_CLEAR_ALL_OPERATION_EXPIRED' })
  assert.equal((await f.registry.get('professor-r-later')).status, 'preparing', 'the later row is untouched (still just reserved)')
  assert.equal((await f.registry.get('professor-r-e5')).status, 'ready', 'the unreached row is untouched')
  assert.equal((await f.registry.get('professor-r-e0')).status, 'archived')
})

test('bulk clearing keeps tombstones and native recovery; unrelated records are untouched', async () => {
  const unrelated = { schema: 'professor.workspace/1', active: { folder: '/academic', revision: 1, project_id: 'p1', connected_at: 'x' }, history: [] }
  const f = fixture({
    rows: [row('professor-r-one', { requestId: 'req-keep00ab' })],
    extraRecords: [['workspace:connection', unrelated]],
    live: ['professor-r-one'],
  })
  const snapshot = await f.home.clearAllSnapshot()
  await drain(f.home, snapshot.token)
  // Native archive call is the supported one; the fake host recorded the id and kept history.
  assert.equal(f.calls.includes('archiveSession:professor-r-one'), true)
  assert.equal(f.live.has('professor-r-one'), false, 'archived out of the live set (recoverable state, not deletion)')
  // Tombstone: the original launch request cannot resurrect the cleared conversation.
  await assert.rejects(f.registry.reserve({ requestId: 'req-keep00ab', sessionId: 'professor-r-one', courseId: null, title: 'x', mode: 'learn' }),
    { code: 'PROFESSOR_SESSION_ARCHIVED' })
  // Unrelated course/workspace data is byte-identical.
  assert.deepEqual(f.records.get('workspace:connection'), unrelated)
  // Persistence across a service restart.
  const restarted = fixture({ rows: [row('professor-r-one', { requestId: 'req-keep00ab', status: 'archived' })], extraRecords: [['workspace:connection', unrelated]] })
  const data = await restarted.home.home()
  assert.equal(data.recent.length, 0)
  assert.equal(data.continue, null)
})

test('a registry lookup failure mid-batch is accounted, keeps the row, and never skips silently', async () => {
  const rows = Array.from({ length: 7 }, (_, index) => row(`professor-r-g${index}`))
  const f = fixture({ rows })
  const snapshot = await f.home.clearAllSnapshot()
  assert.equal(snapshot.count, 7)
  // The lookup for g1 (inside the first batch) fails once, mid-batch.
  f.failures.getThrowsFor = 'professor-r-g1'
  const first = await f.home.clearAllStart({ token: snapshot.token })
  assert.equal(first.done, false)
  assert.equal(first.outcomes.length, 5, 'the batch keeps going after the per-item failure')
  const firstById = Object.fromEntries(first.outcomes.map(entry => [entry.sessionId, entry]))
  assert.equal(firstById['professor-r-g1'].status, 'failed', 'the lookup failure is a failed outcome, not a vanished item')
  assert.match(firstById['professor-r-g1'].reason, /storage read refused/)
  assert.deepEqual(first.counts, { cleared: 4, skipped: 0, failed: 1, remaining: 2 })
  // The failed row is visible and unarchived; nothing was mutated for it.
  f.failures.getThrowsFor = null
  assert.equal((await f.registry.get('professor-r-g1')).status, 'ready')
  assert.equal(f.live.has('professor-r-g1'), true, 'its native chat is untouched')
  // Continuation covers every remaining target — no silent skip of anything.
  const second = await f.home.clearAllContinue({ operationId: first.operationId })
  assert.equal(second.done, true)
  assert.deepEqual(second.counts, { cleared: 6, skipped: 0, failed: 1, remaining: 0 })
  const all = [...first.outcomes, ...second.outcomes]
  assert.equal(all.length, 7, 'every snapshot target received exactly one accounted outcome')
  assert.equal(new Set(all.map(entry => entry.sessionId)).size, 7, 'and no target appears twice')
  // A fresh confirmed attempt retries the remaining row.
  const retry = await f.home.clearAllSnapshot()
  assert.equal(retry.count, 1, 'the fresh snapshot sees exactly the failed row')
  const retryRun = await drain(f.home, retry.token)
  assert.equal(retryRun.at(-1).counts.cleared, 1)
  assert.equal((await f.registry.get('professor-r-g1')).status, 'archived')
})

test('a lookup failure that aborts before accounting leaves the cursor retryable', async () => {
  const rows = Array.from({ length: 3 }, (_, index) => row(`professor-r-h${index}`))
  const f = fixture({ rows })
  const snapshot = await f.home.clearAllSnapshot()
  // The per-item boundary accounts lookup faults as failed outcomes (visible in the results);
  // a later fresh attempt can still clear the row, and no target is ever lost or duplicated.
  f.failures.getThrowsFor = 'professor-r-h0'
  const first = await f.home.clearAllStart({ token: snapshot.token })
  assert.equal(first.outcomes.filter(entry => entry.sessionId === 'professor-r-h0').length, 1)
  assert.equal(first.outcomes.filter(entry => entry.sessionId === 'professor-r-h0')[0].status, 'failed')
  f.failures.getThrowsFor = null
  const second = await f.home.clearAllContinue({ operationId: first.operationId })
  assert.equal(second.done, true)
  const seen = [...first.outcomes, ...second.outcomes].map(entry => entry.sessionId).sort()
  assert.deepEqual(seen, ['professor-r-h0', 'professor-r-h1', 'professor-r-h2'], 'no target lost or duplicated')
  const retry = await f.home.clearAllSnapshot()
  assert.equal(retry.count, 1)
  await drain(f.home, retry.token)
  assert.equal((await f.registry.get('professor-r-h0')).status, 'archived')
})
