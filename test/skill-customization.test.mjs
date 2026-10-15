import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppStorage } from '../src/app/storage.js'
import { createFakeStorageDomain } from './helpers/fake-harness.mjs'
import { createAppStorageOwner } from '../src/app/owner.js'
import { createSkillCustomizationStore, customizationKey } from '../src/skills/customization.js'

function fixture(t) {
  const medium = createFakeStorageDomain({ name: 'professor_app' })
  const storage = createAppStorage({ ctx: { get: () => medium.service }, logger: { warn() {}, info() {} }, readVersion: async () => 'test' })
  t.after(() => storage.close())
  return { storage, medium, store: createSkillCustomizationStore({ appStorage: storage }) }
}
const skill = 'professor-study'
const mutation = (fields, rest = {}) => ({ skill, scope: null, fields, expectedRevision: 0, evidence: 'explicit-stable', ...rest })

test('a global overlay survives closing and reopening the existing app domain', async t => {
  const { store, storage } = fixture(t)
  assert.deepEqual(await store.read({ skill }), { revision: 0, fields: {} })
  await store.update(mutation({ teachingDepth: 'detailed', language: 'Chinese' }))
  await storage.close()
  const restored = createSkillCustomizationStore({ appStorage: storage })
  assert.equal((await restored.read({ skill })).fields.language, 'Chinese')
})

test('course, project and global scopes never collide', async t => {
  const { store } = fixture(t)
  await store.update(mutation({ programmingLanguage: 'Python' }))
  const first = { namespace: 'project-a@root1', courseId: 'CSC3200' }
  await store.update(mutation({ programmingLanguage: 'C++' }, { scope: first }))
  assert.equal((await store.read({ skill, scope: first })).fields.programmingLanguage, 'C++')
  assert.deepEqual((await store.read({ skill, scope: { ...first, namespace: 'project-b@root2' } })).fields, {})
  assert.deepEqual((await store.read({ skill, scope: { ...first, courseId: 'STA2001' } })).fields, {})
  assert.equal((await store.read({ skill })).fields.programmingLanguage, 'Python')
})

test('two concurrent stores cannot both accept the same revision', async t => {
  const { store, storage } = fixture(t)
  const sibling = createSkillCustomizationStore({ appStorage: storage })
  const outcomes = await Promise.allSettled([
    store.update(mutation({ language: 'Chinese' })),
    sibling.update(mutation({ language: 'English' })),
  ])
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(outcomes.find(row => row.status === 'rejected').reason.code, 'PROFESSOR_CUSTOMIZATION_STALE')
})

test('different runtime facets serialize delayed writes under their shared deployment owner', async t => {
  const { storage } = fixture(t)
  const owner = createAppStorageOwner({ createStorage: () => storage })
  const a = owner.acquire('runtime-a'), b = owner.acquire('runtime-b')
  t.after(() => owner.dispose())
  const first = createSkillCustomizationStore({ appStorage: a, queueOwner: owner })
  const second = createSkillCustomizationStore({ appStorage: b, queueOwner: owner })
  const write = storage.writeRecord.bind(storage)
  let enter, resume
  const entered = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { resume = resolve })
  storage.writeRecord = async (...args) => { enter(); await gate; return write(...args) }
  const pending = first.update(mutation({ language: 'Chinese' }))
  await entered
  const other = second.update(mutation({ language: 'English' }))
  const outcomes = Promise.allSettled([pending, other])
  await new Promise(resolve => setImmediate(resolve))
  resume()
  const rows = await outcomes
  assert.equal(rows.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(rows.find(row => row.status === 'rejected').reason.code, 'PROFESSOR_CUSTOMIZATION_STALE')
  await a.release()
  assert.equal((await second.read({ skill })).fields.language, 'Chinese')
})

test('reset retains a monotonic revision, not a delete/recreate ABA', async t => {
  const { store } = fixture(t)
  await store.update(mutation({ language: 'Chinese' }))
  const reset = await store.reset(mutation({}, { expectedRevision: 1 }))
  assert.deepEqual(reset, { revision: 2, fields: {} })
  await assert.rejects(store.update(mutation({ language: 'English' })), { code: 'PROFESSOR_CUSTOMIZATION_STALE' })
})

test('reads and mutation inputs are detached from stored settings', async t => {
  const { store } = fixture(t)
  const input = mutation({ language: 'Chinese' })
  const saved = await store.update(input)
  input.fields.language = 'English'
  saved.fields.language = 'French'
  const read = await store.read({ skill })
  assert.equal(read.fields.language, 'Chinese')
  read.fields.language = 'Japanese'
  assert.equal((await store.read({ skill })).fields.language, 'Chinese')
})

test('invalid settings or nonexplicit evidence refuse without writing', async t => {
  const { store } = fixture(t)
  for (const args of [
    mutation({ language: 'x'.repeat(121) }), mutation({ additionalInstructions: 'x'.repeat(2049) }),
    mutation({ unknownPolicy: 'grant filesystem permission' }), mutation({ language: '\u0000' }),
    mutation({ language: 'Chinese' }, { evidence: 'temporary' }),
    mutation({}, { skill: 'unknown-skill' }), mutation({}, { expectedRevision: -1 }),
    mutation({}, { scope: { namespace: 'project', courseId: '' } }),
    mutation(Object.create({ language: 'Chinese' })),
  ]) await assert.rejects(store.update(args), { code: 'PROFESSOR_CUSTOMIZATION_INVALID' })
  assert.deepEqual(await store.read({ skill }), { revision: 0, fields: {} })
})

test('newer schema and corrupt records are refused without overwrite', async t => {
  const { store, storage } = fixture(t)
  await storage.ensureOpen()
  const key = customizationKey({ skill })
  for (const raw of [
    { schema: 'professor.customization/2', revision: 1, fields: {} },
    { schema: 'professor.customization/1', revision: 'broken', fields: {} },
    { schema: 'professor.customization/1', revision: 1, fields: { permissions: 'all' } },
  ]) {
    await storage.writeRecord(key, raw)
    await assert.rejects(store.read({ skill }), error => /UNSUPPORTED_SCHEMA|CORRUPT/.test(error.code))
    await assert.rejects(store.update(mutation({ language: 'Chinese' })))
    assert.deepEqual(storage.table('app').get(key), raw)
  }
})

test('scope tuple encoding does not admit separator collisions', () => {
  assert.notEqual(customizationKey({ skill, scope: { namespace: 'a:b', courseId: 'c' } }),
    customizationKey({ skill, scope: { namespace: 'a', courseId: 'b:c' } }))
})

test('unavailable storage is not presented as empty customization', async () => {
  const store = createSkillCustomizationStore({ appStorage: { ensureOpen: async () => ({ status: 'unavailable', reason: 'offline' }) } })
  await assert.rejects(store.read({ skill }), { code: 'PROFESSOR_CUSTOMIZATION_UNAVAILABLE' })
})
