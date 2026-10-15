/**
 * Shared application-storage ownership.
 *
 * Every case here is driven through the **real** `createAppStorage` handle on the host-faithful fake
 * domain from `test/helpers/fake-harness.mjs`, because the property under test is not the owner's
 * arithmetic — it is that only one `professor_app` domain is ever open, which is a fact the medium
 * enforces (`already-open`). A stubbed storage could not fail, so it could not prove anything.
 *
 * @module test/app-owner
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createFakeStorageDomain } from './helpers/fake-harness.mjs'
import { createAppStorage } from '../src/app/storage.js'
import { createSessionRegistry } from '../src/app/sessions.js'
import { resolveSharedOwner } from '../src/plugin.js'
import {
  APP_OWNER_DISPOSED_CODE, APP_OWNER_SERVICE, createAppStorageOwner,
} from '../src/app/owner.js'

/**
 * One owner over one fake medium, with the open/close evidence a test needs.
 *
 * `openCalls` comes from the fake domain (a real open through `storageDomain.open`), and `opens` is
 * observed again through `describe().storage.status`, so both the medium and our own handle are
 * witnesses.
 */
function fixture({ failOpen = false } = {}) {
  const medium = createFakeStorageDomain({ name: 'professor_app' })
  const domainStub = {
    get(name) { return name === 'storageDomain' ? medium.service : undefined },
  }
  const owners = []
  const owner = createAppStorageOwner({
    ctx: domainStub,
    logger: { info() {}, warn() {} },
    readVersion: async () => '0.12.0',
    createStorage: () => {
      const service = failOpen
        ? { open: async () => { throw Object.assign(new Error('open-failed: broken backend'), { code: 'open-failed' }) } }
        : medium.service
      return createAppStorage({
        ctx: { get: (name) => (name === 'storageDomain' ? service : undefined) },
        logger: { info() {}, warn() {} },
        readVersion: async () => '0.12.0',
      })
    },
  })
  owners.push(owner)
  return { medium, owner }
}

test('two consumers share one open domain', async () => {
  const { medium, owner } = fixture()
  const runtime = owner.acquire('preset-runtime')
  const ui = owner.acquire('professor-home')
  await runtime.ensureOpen()
  const snapshot = await ui.ensureOpen()
  assert.equal(snapshot.status, 'open')
  assert.equal(medium.openCalls, 1, 'the medium saw exactly one open for two consumers')
  assert.equal(owner.describe().consumers, 2)
})

test('releasing one consumer leaves the other usable', async () => {
  const { medium, owner } = fixture()
  const first = owner.acquire('first')
  const second = owner.acquire('second')
  await first.ensureOpen()
  await second.ensureOpen()

  await first.release()
  assert.equal(medium.openCalls, 0 + 1, 'the domain was not reopened by the release')
  await second.writeRecord('shared', { hello: 'professor' })
  assert.deepEqual(second.table('app').get('shared'), { hello: 'professor' })
  assert.equal(second.describe().status, 'open')
  assert.equal(owner.describe().consumers, 1)
})

test('the final release closes the handle and a later acquire reopens it', async () => {
  const { medium, owner } = fixture()
  const first = owner.acquire('first')
  const second = owner.acquire('second')
  await first.ensureOpen()
  await second.ensureOpen()

  await first.release()
  await second.release()
  assert.equal(owner.describe().consumers, 0)
  assert.equal(owner.describe().storage.status, 'closed')
  assert.equal(medium.openCalls, 1)

  const third = owner.acquire('third')
  await third.ensureOpen()
  assert.equal(medium.openCalls, 2, 'a new consumer opens the domain again rather than failing')
  assert.equal(owner.describe().storage.status, 'open')
})

test('disable and re-enable does not destroy persisted records', async () => {
  const { owner } = fixture()
  const before = owner.acquire('before-restart')
  await before.ensureOpen()
  await before.writeRecord('bootstrap', {
    schema: 'professor.app/1', owner: 'dsh-professor-spike', domain: 'professor_app',
    domain_version: 1, created_at: '2026-10-07T00:00:00.000Z', plugin_version: '0.12.0',
  })
  await before.writeRecord('sessions:registry', {
    schema: 'professor.sessions/1',
    sessions: [{
      requestId: 'req-1', sessionId: 'professor-req-1', courseId: null, title: 'Study session',
      mode: 'free', status: 'ready', error: null, updatedAt: '2026-10-07T00:00:00.000Z',
    }],
  })
  await before.release()

  const after = owner.acquire('after-restart')
  const row = await createSessionRegistry({ appStorage: after }).get('professor-req-1')
  assert.equal(row.status, 'ready', 'the record survived a full release/reopen cycle')
  const marker = after.table('app').get('bootstrap')
  assert.equal(marker.plugin_version, '0.12.0', 'the bootstrap marker is read back, not rewritten')
  assert.equal(after.describe().bootstrapped, false, 'and reopening does not re-bootstrap an initialised domain')
})

test('a double release cannot close a domain another consumer still holds', async () => {
  const { owner } = fixture()
  const first = owner.acquire('first')
  const second = owner.acquire('second')
  await first.ensureOpen()
  await second.ensureOpen()
  await first.release()
  await first.release()
  await first.release()
  assert.equal(owner.describe().consumers, 1)
  assert.ok(second.table('app'), 'the remaining consumer still has a table')
})

test('an in-flight open cannot resurrect disposed state', async () => {
  const { owner } = fixture()
  const facet = owner.acquire('ui')
  const pending = facet.ensureOpen()
  await owner.dispose()
  await assert.rejects(pending, { code: APP_OWNER_DISPOSED_CODE })
  assert.equal(owner.describe().consumers, 0)
  assert.equal(owner.describe().disposed, true)
  assert.equal(owner.describe().storage.status, 'closed', 'the domain was released, not adopted after disposal')
  assert.throws(() => owner.acquire('late'), { code: APP_OWNER_DISPOSED_CODE })
})

test('a released facet refuses work instead of answering from nothing', async () => {
  const { owner } = fixture()
  const facet = owner.acquire('ui')
  await facet.ensureOpen()
  await facet.release()
  await assert.rejects(facet.ensureOpen(), { code: APP_OWNER_DISPOSED_CODE })
  assert.throws(() => facet.table('app'), { code: APP_OWNER_DISPOSED_CODE })
  await assert.rejects(facet.writeRecord('k', { ok: true }), { code: APP_OWNER_DISPOSED_CODE })
})

test('a storage failure is reported, never rendered as empty data', async () => {
  const { owner } = fixture({ failOpen: true })
  const facet = owner.acquire('ui')
  const snapshot = await facet.ensureOpen()
  assert.equal(snapshot.status, 'unavailable')
  assert.match(snapshot.reason, /open-failed/)
  assert.equal(facet.table('app'), undefined, 'a broken backend yields no table, so callers must report')
  await assert.rejects(
    createSessionRegistry({ appStorage: facet }).list(),
    { code: 'PROFESSOR_SESSION_STORAGE_UNAVAILABLE' },
  )
  assert.notDeepEqual(await createSessionRegistry({ appStorage: facet }).list().catch(() => 'refused'), [])
})

test('the owner publishes the service name consumers look it up by', () => {
  assert.equal(APP_OWNER_SERVICE, 'professorAppStorage')
  const { owner } = fixture()
  assert.equal(owner.describe().service, APP_OWNER_SERVICE)
})

test('deployment owner survives creator withdrawal and serves a remounted Home', async () => {
  const medium = createFakeStorageDomain({ name: 'professor_app' })
  const disposers = []
  const deployment = { effect: (factory) => disposers.push(factory()) }
  const context = () => ({ root: deployment, get: (name) => name === 'storageDomain' ? medium.service : undefined, provide() {} })
  const options = { root: process.cwd(), logger: { info() {}, warn() {} } }
  const home = resolveSharedOwner({ ...options, ctx: context(), label: 'home' })
  const runtime = resolveSharedOwner({ ...options, ctx: context(), label: 'runtime' })
  await home.storage.ensureOpen()
  await home.storage.release()
  await runtime.storage.writeRecord('owner-proof', { retained: true })
  const remount = resolveSharedOwner({ ...options, ctx: context(), label: 'home-remount' })
  assert.equal(remount.shared, home.shared)
  assert.deepEqual(remount.storage.table('app').get('owner-proof'), { retained: true })
  assert.equal(medium.openCalls, 1)
  assert.equal(disposers.length, 1)
  await runtime.storage.release()
  await remount.storage.release()
  await disposers[0]()
  assert.throws(() => home.shared.acquire('late'), { code: APP_OWNER_DISPOSED_CODE })
})
