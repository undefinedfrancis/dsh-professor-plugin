import assert from 'node:assert/strict'
import test from 'node:test'
import { createMaterialLauncher } from '../src/app/material-launch.js'

function fixture(overrides = {}) {
  const calls = []
  const context = { projectRoot: '/academic', courseId: 'csc', fileId: 'file-one', relativePath: 'CSC/lecture.txt', contentHash: 'a'.repeat(64), observedVersion: 'v1' }
  const launcher = createMaterialLauncher({ validator: { validate: async () => context },
    home: { launch: async request => { calls.push(request); return { sessionId: 'owned' } } }, sessionProjectRoot: async () => '/academic', ...overrides })
  return { launcher, calls, context }
}
const request = { requestId: 'material-request-001', courseId: 'csc', fileId: 'file-one', mode: 'learn' }

test('material launch validates before and after native setup, returning no arbitrary path authority', async () => {
  const { launcher, calls } = fixture()
  const result = await launcher.launch(request)
  assert.equal(result.sessionId, 'owned')
  assert.equal(result.relativePath, 'CSC/lecture.txt')
  assert.equal(calls[0].courseId, 'csc')
  assert.equal(calls[0].topic, 'Material file-one')
  assert.equal(result.readyForDraft, true)
})
test('unknown browser fields and unsupported modes never create a native session', async () => {
  const { launcher, calls } = fixture()
  await assert.rejects(launcher.launch({ ...request, path: '/outside' }), { code: 'PROFESSOR_MATERIAL_INVALID' })
  await assert.rejects(launcher.launch({ ...request, mode: 'shell' }), { code: 'PROFESSOR_MATERIAL_INVALID' })
  assert.equal(calls.length, 0)
})
test('changed material or wrong native project never returns ready context', async () => {
  let checks = 0
  const { launcher, context } = fixture({ validator: { validate: async () => ({ ...context, observedVersion: ++checks === 1 ? 'v1' : 'v2' }) } })
  await assert.rejects(launcher.launch(request), { code: 'PROFESSOR_MATERIAL_CHANGED' })
  await assert.rejects(fixture({ sessionProjectRoot: async () => '/other' }).launcher.launch(request), { code: 'PROFESSOR_MATERIAL_CHANGED' })
})
test('disposal during validation prevents native creation', async () => {
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const { launcher, calls, context } = fixture({ validator: { validate: async () => { entered(); await blocked; return context } } })
  const work = launcher.launch(request); await started; launcher.dispose(); release()
  await assert.rejects(work, { name: 'AbortError' })
  assert.equal(calls.length, 0)
})
test('disposal cancels already-running native setup through the Home signal', async () => {
  let entered, observed
  const started = new Promise(resolve => { entered = resolve })
  const { launcher } = fixture({ home: { launch: request => new Promise((resolve, reject) => {
    observed = request.signal; entered()
    request.signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })
    if (!request.signal) resolve({ sessionId: 'owned' })
  }) } })
  const work = launcher.launch(request); await started
  assert.ok(observed, 'native setup needs the material lifecycle signal')
  launcher.dispose(); await assert.rejects(work, { name: 'AbortError' })
})
