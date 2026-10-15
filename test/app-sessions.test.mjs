import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionRegistry } from '../src/app/sessions.js'

function fixture(initial) {
  const records = new Map(initial ? [['sessions:registry', initial]] : [])
  const storage = {
    async ensureOpen() {},
    table() { return { get: key => structuredClone(records.get(key)) } },
    async writeRecord(key, value) { records.set(key, structuredClone(value)) },
  }
  return { records, storage, registry: createSessionRegistry({ appStorage: storage, now: () => '2026-10-07T00:00:00.000Z' }) }
}
const input = { requestId: 'req-1', sessionId: 'native-1', courseId: null, title: 'Study session', mode: 'free' }

test('reserve persists metadata only and reopens without conversation content', async () => {
  const { registry, storage, records } = fixture()
  const row = await registry.reserve(input)
  assert.equal(row.status, 'preparing')
  assert.equal(row.courseId, null)
  assert.deepEqual(Object.keys(row).sort(), ['courseId', 'error', 'mode', 'requestId', 'sessionId', 'status', 'title', 'updatedAt'].sort())
  await registry.settle(row.sessionId, { status: 'ready' })
  const reopened = createSessionRegistry({ appStorage: storage })
  assert.equal((await reopened.get('native-1')).status, 'ready')
  assert.equal(records.size, 1)
})
test('same request is idempotent under concurrent reservations', async () => {
  const { registry } = fixture()
  const rows = await Promise.all(Array.from({ length: 12 }, () => registry.reserve(input)))
  assert.equal((await registry.list()).length, 1)
  assert.ok(rows.every(row => row.sessionId === 'native-1'))
})
test('conflicting request payload refuses rather than changing the course', async () => {
  const { registry } = fixture()
  await registry.reserve(input)
  await assert.rejects(registry.reserve({ ...input, courseId: 'CSC3200' }), { code: 'PROFESSOR_SESSION_CONFLICT' })
  assert.equal((await registry.get('native-1')).courseId, null)
})
test('session ID cannot belong to two requests', async () => {
  const { registry } = fixture()
  await registry.reserve(input)
  await assert.rejects(registry.reserve({ ...input, requestId: 'req-2' }), { code: 'PROFESSOR_SESSION_CONFLICT' })
})
test('failed setup retry retains original native ID and clears its error', async () => {
  const { registry } = fixture()
  await registry.reserve(input)
  await registry.settle('native-1', { status: 'failed', error: 'Preset unavailable' })
  const retry = await registry.reserve(input)
  assert.equal(retry.sessionId, 'native-1')
  assert.equal(retry.status, 'preparing')
  assert.equal(retry.error, null)
})
test('unknown native ID cannot silently create metadata', async () => {
  const { registry } = fixture()
  assert.equal(await registry.get('deleted-native'), null)
  await assert.rejects(registry.settle('deleted-native', { status: 'ready' }), { code: 'PROFESSOR_SESSION_MISSING' })
})
test('readers receive detached rows', async () => {
  const { registry } = fixture()
  await registry.reserve(input)
  const rows = await registry.list()
  rows[0].title = 'Mutated'
  assert.equal((await registry.get('native-1')).title, input.title)
})
test('refuses unsupported modes, unbounded input and conversation payloads', async () => {
  const { registry } = fixture()
  for (const change of [{ mode: 'coding' }, { title: 'x'.repeat(161) }, { requestId: '' }, { messages: [] }, { topic: 'raw transcript' }, { courseId: '' }]) {
    await assert.rejects(registry.reserve({ ...input, ...change }), { code: 'PROFESSOR_SESSION_INVALID' })
  }
  assert.deepEqual(await registry.list(), [])
})
test('corrupt stored registry is refused and never overwritten', async () => {
  const corrupted = { schema: 'professor.sessions/99', sessions: [] }
  const { registry, records } = fixture(corrupted)
  await assert.rejects(registry.list(), { code: 'PROFESSOR_SESSION_CORRUPT' })
  await assert.rejects(registry.reserve(input), { code: 'PROFESSOR_SESSION_CORRUPT' })
  assert.deepEqual(records.get('sessions:registry'), corrupted)
})
test('unavailable storage does not return false empty state', async () => {
  const registry = createSessionRegistry({ appStorage: { async ensureOpen() {}, table() {} } })
  await assert.rejects(registry.list(), { code: 'PROFESSOR_SESSION_STORAGE_UNAVAILABLE' })
})
test('invalid settlement cannot mark incomplete setup ready', async () => {
  const { registry } = fixture()
  await registry.reserve(input)
  await assert.rejects(registry.settle('native-1', { status: 'ready', error: 'still broken' }), { code: 'PROFESSOR_SESSION_INVALID' })
  await assert.rejects(registry.settle('native-1', { status: 'failed' }), { code: 'PROFESSOR_SESSION_INVALID' })
  assert.equal((await registry.get('native-1')).status, 'preparing')
})
