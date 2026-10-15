import assert from 'node:assert/strict'
import test from 'node:test'
import { createProfessorAppViews } from '../src/app/views.js'
import { createAppStorage } from '../src/app/storage.js'
import { createSkillCustomizationStore } from '../src/skills/customization.js'
import { createMemoryStore, EVIDENCE_EXPLICIT_STABLE } from '../src/memory/store.js'
import { createFakeStorageDomain } from './helpers/fake-harness.mjs'

function fixture(t, overrides = {}) {
  const medium = createFakeStorageDomain({ name: 'professor_app' })
  const storage = createAppStorage({ ctx: { get: () => medium.service }, readVersion: async () => 'test', logger: { info() {}, warn() {} } })
  t.after(() => storage.close())
  const options = {
    catalog: { describe: async () => ({ connected: true, projectRoot: '/academic', unavailable: null,
      courses: [{ course_id: 'csc', course_code: 'CSC3200', display_name: 'Algorithms' }, { course_id: 'sta', course_code: 'STA2001' }] }) },
    registry: { list: async () => [{ sessionId: 'csc-1', courseId: 'csc', status: 'ready' }, { sessionId: 'sta-1', courseId: 'sta', status: 'ready' }] },
    sessionProjectRoot: async () => '/academic',
    customization: createSkillCustomizationStore({ appStorage: storage }),
    memory: { readControl: async () => ({ enabled: true, revision: 0 }) },
    readProject: async () => ({ project: { id: 'academic' } }),
    readIndex: async () => ({ schema_version: 1, generated_at: '2026-10-07', files: [
      { file_id: 'f1', course_id: 'csc', relative_path: 'CSC/Lecture.pdf', category: 'lectures', index_status: 'indexed' },
      { file_id: 'f2', course_id: 'sta', relative_path: 'STA/Intro.pdf', category: 'lectures', index_status: 'indexed' },
    ] }),
    appStorage: storage,
    ...overrides,
  }
  return { storage, options, views: createProfessorAppViews(options) }
}

test('memory settings require revision, preserve records and refresh active sessions', async t => {
  const setup = fixture(t)
  const memory = createMemoryStore({ appStorage: setup.storage })
  await memory.setPreference({ key: 'language', value: 'Chinese', evidence: EVIDENCE_EXPLICIT_STABLE })
  let refreshed = 0
  const views = createProfessorAppViews({ ...setup.options, memory, onMemoryChanged: async () => { refreshed++ } })
  await assert.rejects(views.setMemoryEnabled({ enabled: false }), { code: 'PROFESSOR_VIEW_INVALID' })
  await assert.rejects(views.setMemoryEnabled({ enabled: false, expectedRevision: 0, path: '/tmp' }), { code: 'PROFESSOR_VIEW_INVALID' })
  const off = await views.setMemoryEnabled({ enabled: false, expectedRevision: null })
  assert.equal(off.enabled, false)
  assert.equal(refreshed, 1)
  await assert.rejects(views.setMemoryEnabled({ enabled: true, expectedRevision: null }), { code: 'PROFESSOR_MEMORY_STALE' })
  await views.setMemoryEnabled({ enabled: true, expectedRevision: off.revision })
  assert.equal((await memory.readGlobal()).record.preferences.language.value, 'Chinese')
})

test('saved memory control reports degraded session refresh separately from write failure', async t => {
  const setup = fixture(t)
  const memory = createMemoryStore({ appStorage: setup.storage })
  const views = createProfessorAppViews({ ...setup.options, memory, onMemoryChanged: async () => ({ degraded: true }) })
  const result = await views.setMemoryEnabled({ enabled: false, expectedRevision: null })
  assert.equal(result.refresh, 'failed')
  assert.equal((await memory.readControl()).enabled, false)
})

test('course view isolates indexed materials and recent native metadata', async t => {
  const { views } = fixture(t)
  const data = await views.course({ courseId: 'csc' })
  assert.equal(data.course.course_code, 'CSC3200')
  assert.deepEqual(data.materials.map(row => row.fileId), ['f1'])
  assert.deepEqual(data.recent.map(row => row.sessionId), ['csc-1'])
  assert.equal(data.categories.lectures, 1)
})

test('settings returns current authoritative course choices for connection changes', async t => {
  const { views } = fixture(t)
  const data = await views.settings()
  assert.deepEqual(data.courses.map(row => row.course_id), ['csc', 'sta'])
})

test('missing index and unsupported schema are explicit, not ready', async t => {
  const { views } = fixture(t, { readIndex: async () => null })
  assert.equal((await views.course({ courseId: 'csc' })).index.status, 'missing')
  const unsupported = fixture(t, { readIndex: async () => ({ schema_version: 2, files: [] }) })
  assert.equal((await unsupported.views.course({ courseId: 'csc' })).index.status, 'unsupported')
})

test('unknown course and invalid pagination refuse without guessing', async t => {
  const { views } = fixture(t)
  await assert.rejects(views.course({ courseId: 'missing' }), { code: 'PROFESSOR_VIEW_COURSE_UNKNOWN' })
  await assert.rejects(views.course({ courseId: 'csc', offset: -1 }), { code: 'PROFESSOR_VIEW_INVALID' })
})

test('course customization saves isolate scope and reset inherits global', async t => {
  const { views } = fixture(t)
  const skill = 'professor-study'
  await views.saveCustomization({ skill, fields: { language: 'Chinese' }, expectedRevision: 0 })
  await views.saveCustomization({ skill, courseId: 'csc', fields: { programmingLanguage: 'C++' }, expectedRevision: 0 })
  const csc = await views.settings({ skill, courseId: 'csc' })
  const sta = await views.settings({ skill, courseId: 'sta' })
  assert.equal(csc.overlay.fields.programmingLanguage, 'C++')
  assert.deepEqual(sta.overlay.fields, {})
  assert.equal(sta.global.fields.language, 'Chinese')
  await views.saveCustomization({ skill, courseId: 'csc', reset: true, expectedRevision: 1 })
  assert.deepEqual((await views.settings({ skill, courseId: 'csc' })).overlay.fields, {})
})

test('settings memory failure is explicit and stored preferences are not overwritten', async t => {
  const { views } = fixture(t, { memory: { readControl: async () => { throw new Error('backend unavailable') } } })
  const data = await views.settings({ skill: 'professor-study' })
  assert.equal(data.memory.status, 'unavailable')
  assert.equal(data.memory.enabled, null)
})

test('settings writes require current revision and browser cannot choose namespace', async t => {
  const { views } = fixture(t)
  await views.saveCustomization({ skill: 'professor-study', fields: { language: 'Chinese' }, expectedRevision: 0 })
  await assert.rejects(views.saveCustomization({ skill: 'professor-study', fields: {}, expectedRevision: 0 }), { code: 'PROFESSOR_CUSTOMIZATION_STALE' })
  await assert.rejects(views.settings({ skill: 'professor-study', namespace: 'other-project' }), { code: 'PROFESSOR_VIEW_INVALID' })
  await assert.rejects(views.saveCustomization({ skill: 'professor-study', fields: { language: () => 'drop-me' }, expectedRevision: 1 }), { code: 'PROFESSOR_CUSTOMIZATION_INVALID' })
})

test('material pagination is bounded and reports totals independently of current page', async t => {
  const { views } = fixture(t, { readIndex: async () => ({ schema_version: 1, files: Array.from({ length: 201 }, (_, index) =>
    ({ file_id: `f${index}`, course_id: 'csc', relative_path: `CSC/${index}.pdf`, category: 'lectures', index_status: 'indexed' })) }) })
  const first = await views.course({ courseId: 'csc' })
  assert.equal(first.materials.length, 50)
  assert.equal(first.total, 201)
  assert.equal(first.nextOffset, 50)
  assert.equal((await views.course({ courseId: 'csc', offset: 200 })).nextOffset, null)
})

test('same course identifier in another connected project does not inherit native session history', async t => {
  const { views } = fixture(t, { catalog: { describe: async () => ({ connected: true, projectRoot: '/other-project', unavailable: null,
    courses: [{ course_id: 'csc', course_code: 'CSC3200' }] }) } })
  assert.deepEqual((await views.course({ courseId: 'csc' })).recent, [])
})

test('malformed material entries report a corrupt index rather than indexed success', async t => {
  const { views } = fixture(t, { readIndex: async () => ({ schema_version: 1, files: [{ course_id: 'csc' }] }) })
  const data = await views.course({ courseId: 'csc' })
  assert.equal(data.index.status, 'corrupt')
  assert.equal(data.materials.length, 0)
})

test('read models project bounded display fields instead of copying arbitrary index/course metadata', async t => {
  const { views } = fixture(t, {
    catalog: { describe: async () => ({ connected: true, projectRoot: '/academic', unavailable: null,
      courses: [{ course_id: 'csc', course_code: 'CSC3200', private_metadata: 'x'.repeat(100000) }] }) },
    readIndex: async () => ({ schema_version: 1, files: Array.from({ length: 100 }, (_, index) => ({
      file_id: `f${index}`, course_id: 'csc', relative_path: 'x'.repeat(4000), category: `unknown-${index}`,
      index_status: 'x'.repeat(4000), content: 'secret-body',
    })) }),
  })
  const view = await views.course({ courseId: 'csc' })
  assert.ok(JSON.stringify(view).length < 64000)
  assert.equal(view.course.private_metadata, undefined)
  assert.equal(view.materials[0].content, undefined)
  assert.equal(Object.keys(view.categories).length, 1)
})

test('returned views are detached and unavailable customization is not shown as empty settings', async t => {
  const { views } = fixture(t)
  const first = await views.course({ courseId: 'csc' })
  first.course.course_code = 'changed'
  first.materials[0].name = 'changed'
  const next = await views.course({ courseId: 'csc' })
  assert.equal(next.course.course_code, 'CSC3200')
  assert.equal(next.materials[0].name, 'CSC/Lecture.pdf')
  const failure = Object.assign(new Error('storage unavailable'), { code: 'PROFESSOR_CUSTOMIZATION_UNAVAILABLE' })
  const broken = fixture(t, { customization: { read: async () => { throw failure } } })
  await assert.rejects(broken.views.settings(), { code: 'PROFESSOR_CUSTOMIZATION_UNAVAILABLE' })
})

test('same course ID under a changed project root gets a separate overlay namespace', async t => {
  const { options, views } = fixture(t)
  await views.saveCustomization({ skill: 'professor-study', courseId: 'csc', fields: { programmingLanguage: 'C++' }, expectedRevision: 0 })
  const second = createProfessorAppViews({ ...options, catalog: { describe: async () => ({
    connected: true, projectRoot: '/other-project', unavailable: null, courses: [{ course_id: 'csc' }],
  }) } })
  assert.deepEqual((await second.settings({ skill: 'professor-study', courseId: 'csc' })).overlay.fields, {})
})
