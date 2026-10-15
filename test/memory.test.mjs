/**
 * Phase 2 (M2) — persistent Professor memory and bounded session context.
 *
 * What is pinned here, mapped to the Phase 2 brief:
 *
 * 1.  **Empty fresh install** — memory starts enabled, empty, and honestly reported.
 * 2.  **Explicit stable preference persistence** — only `explicit-stable` durable-preference
 *     evidence writes a global preference; the record survives a "fresh process" (a new storage
 *     handle over the same medium).
 * 3.  **Temporary statements are not promoted** — casual/temporary/learning evidence refuses a
 *     durable write instead of silently becoming permanent.
 * 4.  **Learning-state evidence gate retained** — `professor_state_update` with `evidence: 'none'`
 *     still writes nothing (the existing PROGRESS/KNOWLEDGE/MISTAKES gate is not weakened).
 * 5.  **Cross-course / cross-project / cross-term isolation** — course memory is namespaced by
 *     stable project identity + course identity; same code in another project or term cannot
 *     collide or leak.
 * 6.  **Unbound general sessions** — hydrate global memory only; never infer a course.
 * 7.  **Concurrent updates and stale revisions** — read-modify-write against an expected revision;
 *     a stale writer is refused and the stored record is preserved.
 * 8.  **Disabled-memory semantics** — no automatic retrieval or persistence, stored data preserved,
 *     the disabled state reported honestly, and re-enabling works.
 * 9.  **Corrupt / newer-schema records** — loud, coded, non-destructive errors; the medium is never
 *     "repaired" by deletion.
 * 10. **Context budgets and deterministic ordering** — bounded sizes, stable sort, omissions
 *     reported.
 * 11. **Two sessions, one store** — per-agent caches share a single storage handle owned by the
 *     plugin lifecycle; dropping one agent never disturbs another's memory.
 * 12. **Persistence across a fresh host process** — simulated at medium level here (a new handle
 *     over the same bytes); the real cross-process proof is `tools/verify-memory-restart.mjs`.
 *
 * These are fake-host contract tests: they prove the plugin's own rules, not the host's. Real-host
 * evidence lives in the verifiers (see `docs/v1/STATUS.md`, Phase 2).
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { createAppStorage } from '../src/app/storage.js'
import { createFsGateway } from '../src/fs/gateway.js'
import { createPathPolicy } from '../src/paths/policy.js'
import {
  CONTEXT_BUDGETS,
  buildMemoryContext,
} from '../src/memory/context.js'
import {
  EVIDENCE_EXPLICIT_STABLE,
  MEMORY_BUDGETS,
  MEMORY_CONTROL_KEY,
  GLOBAL_PREFERENCES_KEY,
  MEMORY_RECORD_SCHEMA,
  courseMemoryKey,
  courseMemoryNamespace,
  createMemoryStore,
} from '../src/memory/store.js'
import { createSessionMemory, MEMORY_SECTION_NAME } from '../src/memory/session.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

test('overlapping preference writes cannot both accept the same revision', async () => {
  const { store, appStorage } = await storeOver(fakeStorageDomain())
  await store.setPreference({ key: 'style', value: 'initial', evidence: EVIDENCE_EXPLICIT_STABLE })
  const originalWrite = appStorage.writeRecord.bind(appStorage)
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let entered
  const started = new Promise(resolve => { entered = resolve })
  appStorage.writeRecord = async (...args) => {
    entered()
    await blocked
    return originalWrite(...args)
  }
  const first = store.setPreference({ key: 'style', value: 'first', evidence: EVIDENCE_EXPLICIT_STABLE, expectedRevision: 1 })
  await started
  const second = store.setPreference({ key: 'language', value: 'Chinese', evidence: EVIDENCE_EXPLICIT_STABLE, expectedRevision: 1 })
  const outcomes = Promise.allSettled([first, second])
  await new Promise(resolve => setImmediate(resolve))
  release()
  const results = await outcomes
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected')?.reason.code, 'PROFESSOR_MEMORY_STALE')
  assert.equal((await store.readGlobal()).record.preferences.style.value, 'first')
  await appStorage.close()
})

const toolsOf = (fake) => Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))

test('refreshAll reports caught hydration failures without throwing or retaining old context', async () => {
  let unavailable = false
  const memory = createSessionMemory({ store: { readControl: async () => { if (unavailable) throw new Error('unavailable'); return { enabled: false } } }, gateway: {}, policiesFor: () => ({}) })
  const agent = { session: { id: 'refresh-diagnostics' } }
  await memory.hydrateAgent(agent)
  unavailable = true
  assert.equal((await memory.refreshAll())?.degraded, true)
})

test('separate memory facets serialize writes over their shared deployment owner', async () => {
  const { store, appStorage } = await storeOver(fakeStorageDomain())
  const queueOwner = {}
  const firstStore = createMemoryStore({ appStorage, queueOwner })
  const secondStore = createMemoryStore({ appStorage, queueOwner })
  await store.setEnabled({ enabled: true, reason: 'initial' })
  const control = await store.readControl()
  const write = appStorage.writeRecord.bind(appStorage)
  let release, entered
  const blocked = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  appStorage.writeRecord = async (...args) => { entered(); await blocked; return write(...args) }
  const first = firstStore.setEnabled({ enabled: false, reason: 'settings', expectedRevision: control.revision })
  await started
  const outcomes = Promise.allSettled([
    first,
    secondStore.setEnabled({ enabled: true, reason: 'native tool', expectedRevision: control.revision }),
  ])
  await new Promise(resolve => setImmediate(resolve))
  release()
  const results = await outcomes
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected')?.reason.code, 'PROFESSOR_MEMORY_STALE')
  assert.equal((await store.readControl()).enabled, false)
  await appStorage.close()
})

test('prompt registration uses the agent-scoped service facade, not the raw service', () => {
  let registered = false
  const memory = createSessionMemory({ store: {}, gateway: {}, policiesFor: () => ({}) })
  const agent = { ctx: { systemPrompt: { section: () => { registered = true; return () => {} } },
    get: () => ({ section: () => { throw new Error('raw service loses the calling scope') } }) } }
  memory.registerForAgent(agent)
  assert.equal(registered, true)
})

test('async host preset membership permits Professor memory rendering', async () => {
  const { store, appStorage } = await storeOver(fakeStorageDomain())
  await store.setPreference({ key: 'language', value: 'Chinese', evidence: EVIDENCE_EXPLICIT_STABLE })
  const memory = createSessionMemory({ store, gateway: {}, policiesFor: () => ({}), isProfessorAgent: async () => true })
  const agent = fakeAgent('/no-project', 'async-professor')
  await memory.hydrateAgent(agent)
  assert.match(await memory.textFor(agent), /Chinese/)
  await appStorage.close()
})

test('async host preset refusal excludes memory from ordinary agents', async () => {
  const { store, appStorage } = await storeOver(fakeStorageDomain())
  await store.setPreference({ key: 'language', value: 'Chinese', evidence: EVIDENCE_EXPLICIT_STABLE })
  const memory = createSessionMemory({ store, gateway: {}, policiesFor: () => ({}), isProfessorAgent: async () => false })
  const agent = fakeAgent('/no-project', 'async-ordinary')
  await memory.hydrateAgent(agent)
  assert.equal(await memory.textFor(agent), '')
  await appStorage.close()
})

test('memory context enforces the total budget including omission footer and header', () => {
  const result = buildMemoryContext({ enabled: true, globalRecord: { preferences: { language: { value: 'Chinese' } } },
    courseRecord: null, learning: null, budgets: { maxChars: 50, maxPreferences: 0 } })
  assert.ok(result.text.length <= 50)
  assert.equal(result.diagnostics.chars, result.text.length)
})

test('disabling memory clears every active session cache without deleting records', async () => {
  const { store, appStorage } = await storeOver(fakeStorageDomain())
  await store.setPreference({ key: 'language', value: 'Chinese', evidence: EVIDENCE_EXPLICIT_STABLE })
  const memory = createSessionMemory({ store, gateway: {}, policiesFor: () => ({}), isProfessorAgent: () => true })
  const a = fakeAgent('/no-project', 'cache-a')
  const b = fakeAgent('/no-project', 'cache-b')
  await memory.hydrateAgent(a)
  await memory.hydrateAgent(b)
  assert.match(await memory.textFor(b), /Chinese/)
  await store.setEnabled({ enabled: false })
  await memory.refreshAll()
  assert.equal(await memory.textFor(a), '')
  assert.equal(await memory.textFor(b), '')
  assert.equal((await store.readGlobal()).record.preferences.language.value, 'Chinese')
  await appStorage.close()
})

/** An in-memory storage domain shaped like the installed host (same shape as portable-core's). */
function fakeStorageDomain() {
  const stores = new Map()
  const domain = {
    async close() {},
    table(name) {
      if (!stores.has(name)) stores.set(name, new Map())
      const store = stores.get(name)
      return {
        get: (key) => store.get(key),
        keys: () => store.keys(),
        async put(key, value) { store.set(key, value) },
        async update(key, transform) { store.set(key, transform(store.get(key))) },
        get size() { return store.size },
      }
    },
  }
  return {
    stores,
    service: {
      async open(spec) {
        for (const [table, tableSpec] of Object.entries(spec.tables ?? {})) {
          for (const [key, raw] of stores.get(table) ?? []) {
            try {
              tableSpec.valueSchema.parse(raw)
            } catch (error) {
              throw Object.assign(
                new Error(`invalid-record: stored record '${key}' in table '${table}' does not match its schema`),
                { code: 'invalid-record', cause: error },
              )
            }
          }
        }
        return domain
      },
    },
  }
}

/** Mount the plugin over a fixture home with an (optional) shared storage medium. */
function mount(home, { storage } = {}) {
  const fake = createFakeContext({
    home,
    ...(storage === undefined ? {} : { services: { storageDomain: storage.service } }),
  })
  apply(fake.ctx, fake.pluginConfig)
  return { fake, tools: toolsOf(fake) }
}

/** A memory store over its own app-storage handle sharing the given medium. */
async function storeOver(storage, now) {
  const appStorage = createAppStorage({ ctx: { get: (name) => (name === 'storageDomain' ? storage.service : undefined) } })
  await appStorage.ensureOpen()
  return { appStorage, store: createMemoryStore({ appStorage, now }) }
}

test('memory status counts host iterable table keys and remains lossless JSON', async () => {
  const { store, appStorage } = await storeOver(fakeStorageDomain())
  await store.updateCourse('test-project', 'csc3200', { recentTopic: 'Hash tables' })
  const status = await store.describe()
  assert.equal(status.counts.course_records, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(status)), status)
  await appStorage.close()
})

/** Build a bound project with courses through the real tools, exactly as a user would. */
async function buildProject(tools, projectRoot, sessionId, projectId, courses) {
  await fs.mkdir(projectRoot, { recursive: true })
  const exec = makeExec({ cwd: projectRoot, sessionId })
  await tools.professor_project_init.execute({ project_id: projectId }, exec)
  for (const course of courses) {
    await tools.professor_course_manage.execute({
      action: 'register',
      course_code: course.code,
      display_name: course.name,
      term: course.term,
      source_path: path.join(projectRoot, course.code),
    }, exec)
    await fs.mkdir(path.join(projectRoot, course.code), { recursive: true })
  }
  return exec
}

/** A read policy factory good enough for hydration's learning-state reads. */
const readPoliciesFor = (projectRoot) => ({
  read: createPathPolicy({ roots: [projectRoot], label: 'read' }),
  write: createPathPolicy({ roots: [], label: 'write' }),
})

const fakeAgent = (cwd, sessionId) => ({ session: { id: sessionId, header: { cwd } } })

test('selected course remains exact with duplicate codes and memory disabled', async () => {
  const home = await makeHome('professor-selected-course-')
  const { fake, tools } = mount(home)
  const root = path.join(home, 'courses')
  const exec = await buildProject(tools, root, 'selected', 'selected-project', [
    { code: 'CSC3200', name: 'Data Structures', term: 'Fall' },
  ])
  await tools.professor_session_bind.execute({ course: 'CSC3200' }, exec)
  await tools.professor_course_manage.execute({ action: 'register', course_code: 'CSC3200', display_name: 'Spring Data Structures', term: 'Spring' }, exec)
  const memory = createSessionMemory({ store: { readControl: async () => ({ enabled: false }) },
    gateway: fakeGatewayFor(fake), policiesFor: readPoliciesFor, isProfessorAgent: () => true })
  const agent = exec.agent
  assert.equal((await memory.resolveCourseContextFor(agent)).course?.course_id, 'csc3200')
  await memory.hydrateAgent(agent)
  const text = await memory.textFor(agent)
  assert.match(text, /csc3200/)
  assert.match(text, /Data Structures/)
  assert.match(text, /不要再次询问/)
  const status = await tools.professor_session_status.execute({}, exec)
  assert.equal(status.course?.course_id, 'csc3200')
  const state = await tools.professor_state_read.execute({}, exec)
  assert.equal(state.course_id, 'csc3200')
  const explicitState = await tools.professor_state_read.execute({ course: 'csc3200' }, exec)
  assert.equal(explicitState.course_id, 'csc3200')
  fake.disposeAll()
})

// --- 1. empty fresh install --------------------------------------------------

test('a fresh install starts with memory enabled, empty and honestly reported', async () => {
  const storage = fakeStorageDomain()
  const home = await makeHome('professor-memory-fresh-')
  const { fake, tools } = mount(home, { storage })

  const status = await tools.professor_memory_status.execute({}, makeExec({ cwd: home }))
  assert.equal(status.enabled, true, 'memory is enabled by default (mechanism available, content empty)')
  assert.equal(status.storage.status, 'open')
  assert.equal(status.counts.global_preferences, 0)
  assert.equal(status.counts.course_records, 0)

  const control = await tools.professor_memory_read.execute({ scope: 'control' }, makeExec({ cwd: home }))
  assert.equal(control.present, false)
  assert.equal(control.enabled, true)

  const global = await tools.professor_memory_read.execute({ scope: 'global' }, makeExec({ cwd: home }))
  assert.equal(global.present, false, 'no preferences are invented on a fresh install')
  assert.equal(global.record, null)
  fake.disposeAll()
})

// --- 2 + 3. durable preference evidence --------------------------------------

test('an explicit stable preference persists; a temporary statement is never promoted', async () => {
  const storage = fakeStorageDomain()
  const home = await makeHome('professor-memory-pref-')
  const { fake, tools } = mount(home, { storage })
  const exec = makeExec({ cwd: home, sessionId: 'session-a' })

  const saved = await tools.professor_memory_update.execute({
    scope: 'global', action: 'set_preference',
    key: 'explanation_language', value: '中文讲解，保留英文术语', evidence: EVIDENCE_EXPLICIT_STABLE,
  }, exec)
  assert.equal(saved.written, true)
  assert.equal(saved.revision, 1)

  for (const evidence of ['temporary', 'weak', 'strong']) {
    const refused = await tools.professor_memory_update.execute({
      scope: 'global', action: 'set_preference',
      key: 'casual', value: 'just this once', evidence,
    }, exec)
    assert.equal(refused.written, false, `evidence "${evidence}" must not become a durable preference`)
    assert.match(refused.problems.join(' '), /explicit-stable|durable/)
  }

  const read = await tools.professor_memory_read.execute({ scope: 'global' }, exec)
  assert.equal(read.present, true)
  assert.equal(read.record.preferences.explanation_language.value, '中文讲解，保留英文术语')
  assert.equal(read.record.preferences.casual, undefined, 'the temporary statement left no trace')
  assert.equal(read.revision, 1)

  // Simulate a fresh host process: a brand-new handle over the same medium.
  fake.disposeAll()
  const { store } = await storeOver(storage)
  const reread = await store.readGlobal()
  assert.equal(reread.present, true)
  assert.equal(reread.record.preferences.explanation_language.value, '中文讲解，保留英文术语')
  assert.equal(reread.revision, 1)
})

test('a preference update requires the observed revision once a record exists', async () => {
  const storage = fakeStorageDomain()
  const { store } = await storeOver(storage)
  await store.setPreference({ key: 'a', value: '1', evidence: EVIDENCE_EXPLICIT_STABLE })
  await assert.rejects(
    () => store.setPreference({ key: 'b', value: '2', evidence: EVIDENCE_EXPLICIT_STABLE }),
    (error) => error.code === 'PROFESSOR_MEMORY_STALE',
    'writing without reading the existing record first is a lost-update hazard and must be refused',
  )
})

// --- 4. learning evidence gate (unchanged) -----------------------------------

test('learning updates are still rejected without evidence', async () => {
  const home = await makeHome('professor-memory-evidence-')
  const { fake, tools } = mount(home)
  const project = path.join(home, 'courses')
  const exec = await buildProject(tools, project, 'session-a', 'term-2026', [
    { code: 'CSC3200', name: 'DSA', term: '2025-2026 Fall' },
  ])

  const refused = await tools.professor_state_update.execute({
    file: 'PROGRESS.md', evidence: 'none', field: 'current_unit', value: 'Unit 9',
    course: 'CSC3200',
  }, exec)
  assert.equal(refused.written, false, 'a lightweight question writes nothing')

  const written = await tools.professor_state_update.execute({
    file: 'PROGRESS.md', evidence: 'strong', field: 'current_unit', value: 'Unit 9',
    reason: 'student solved the checkpoint unaided',
    course: 'CSC3200',
  }, exec)
  assert.equal(written.written, true)
  fake.disposeAll()
})

// --- 5. isolation ------------------------------------------------------------

test('course memory is isolated per course, per project and per term', async () => {
  const storage = fakeStorageDomain()
  const home = await makeHome('professor-memory-iso-')
  const { fake, tools } = mount(home, { storage })

  const projectA = path.join(home, 'term-a')
  const execA = await buildProject(tools, projectA, 'session-a', 'proj-a', [
    { code: 'CSC3200', name: 'DSA', term: '2025-2026 Fall' },
    { code: 'CSC3200', name: 'DSA', term: '2026 Spring' },
    { code: 'STA2001', name: 'Probability', term: '2025-2026 Fall' },
  ])

  // The bare code "CSC3200" spans two terms, so the registry (which never guesses) needs the
  // code-term composite of the fall registration; STA2001 is unambiguous either way.
  await tools.professor_memory_update.execute({
    scope: 'course', action: 'set_recent_topic', course: 'csc3200-2025-2026-fall', value: 'Hash Tables',
  }, execA)
  await tools.professor_memory_update.execute({
    scope: 'course', action: 'set_recent_topic', course: 'STA2001', value: 'Conditional Probability',
  }, execA)

  const readCsc = await tools.professor_memory_read.execute({ scope: 'course', course: 'csc3200-2025-2026-fall' }, execA)
  assert.equal(readCsc.record.recent_topic, 'Hash Tables')
  const readSta = await tools.professor_memory_read.execute({ scope: 'course', course: 'STA2001' }, execA)
  assert.equal(readSta.record.recent_topic, 'Conditional Probability')
  assert.notEqual(readCsc.record.course_id, readSta.record.course_id, 'records are distinct per course identity')
  assert.equal(
    readCsc.record.project.namespace, readSta.record.project.namespace,
    'the namespace is the *project* identity; the course id disambiguates inside it',
  )
  const keysAt = (suffix) => [...(storage.stores.get('app')?.keys() ?? [])]
    .filter((key) => key.startsWith('memory:course:') && key.endsWith(`:${suffix}`))
  assert.equal(keysAt('csc3200').length, 1, 'the fall course keeps the base course_id')
  assert.equal(keysAt('sta2001').length, 1)
  assert.notEqual(keysAt('csc3200')[0], keysAt('sta2001')[0])

  // Same code, another term, same project: its own record (address the spring registration by
  // its stable course_id; the bare code is ambiguous by design — the registry never guesses).
  await tools.professor_memory_update.execute({
    scope: 'course', action: 'set_recent_topic', course: 'csc3200-2026-spring', value: 'Graphs',
  }, execA)
  const readSpring = await tools.professor_memory_read.execute({ scope: 'course', course: 'csc3200-2026-spring' }, execA)
  assert.equal(readSpring.record.recent_topic, 'Graphs')
  assert.equal(keysAt('csc3200-2026-spring').length, 1)
  assert.notEqual(keysAt('csc3200')[0], keysAt('csc3200-2026-spring')[0], 'same code in another term: a different record')

  // Same code, another project: cannot collide.
  const projectB = path.join(home, 'term-b')
  const execB = await buildProject(tools, projectB, 'session-b', 'proj-b', [
    { code: 'CSC3200', name: 'DSA', term: '2025-2026 Fall' },
  ])
  const readB = await tools.professor_memory_read.execute({ scope: 'course', course: 'CSC3200' }, execB)
  assert.equal(readB.present, false, 'a different project starts with its own empty course memory')
  await tools.professor_memory_update.execute({
    scope: 'course', action: 'set_recent_topic', course: 'CSC3200', value: 'Balanced Trees',
  }, execB)
  const readBAgain = await tools.professor_memory_read.execute({ scope: 'course', course: 'CSC3200' }, execB)
  assert.equal(readBAgain.record.recent_topic, 'Balanced Trees')
  const readAAgain = await tools.professor_memory_read.execute({ scope: 'course', course: 'csc3200-2025-2026-fall' }, execA)
  assert.equal(readAAgain.record.recent_topic, 'Hash Tables', 'project A memory is untouched')

  // Namespace shape: stable, and distinct across roots even for identical project ids.
  const ns1 = courseMemoryNamespace('same-id', projectA)
  const ns2 = courseMemoryNamespace('same-id', projectB)
  assert.notEqual(ns1, ns2)
  assert.match(ns1, /^same-id@[0-9a-f]{12}$/)
  assert.equal(courseMemoryKey(ns1, 'csc3200'), `memory:course:${ns1}:csc3200`)
  fake.disposeAll()
})

// --- 6. unbound general session ----------------------------------------------

test('an unbound general session hydrates global memory only and never infers a course', async () => {
  const storage = fakeStorageDomain()
  const home = await makeHome('professor-memory-general-')
  const { fake, tools } = mount(home, { storage })
  const exec = makeExec({ cwd: home, sessionId: 'session-g' })
  await tools.professor_memory_update.execute({
    scope: 'global', action: 'set_preference',
    key: 'explanation_language', value: '中文', evidence: EVIDENCE_EXPLICIT_STABLE,
  }, exec)

  const generalWorkspace = path.join(home, 'loose-workspace')
  await fs.mkdir(generalWorkspace, { recursive: true })
  // A course folder exists nearby — it must never be picked up.
  await buildProject(tools, path.join(home, 'courses'), 'session-other', 'term-2026', [
    { code: 'CSC3200', name: 'DSA', term: '2025-2026 Fall' },
  ])

  const { store } = await storeOver(storage)
  const memory = createSessionMemory({
    store,
    gateway: createFsGateway({ ctx: fake.ctx, logger: fake.ctx.logger }),
    policiesFor: readPoliciesFor,
    logger: { warn: () => {}, info: () => {} },
    isProfessorAgent: () => true,
  })
  const agent = fakeAgent(generalWorkspace, 'session-g')
  const { text, diagnostics } = await memory.hydrateAgent(agent)
  assert.match(text, /explanation_language/, 'global preferences reach the general session')
  assert.equal(diagnostics.general, true, 'the session is reported as general (no course)')
  assert.equal(diagnostics.course, null)
  assert.doesNotMatch(text, /CSC3200|课程记忆/, 'no course memory is inferred')
  fake.disposeAll()
})

/** The gateway facade the plugin builds over ctx.fs (mirrors src/fs/gateway.js usage). */
function fakeGatewayFor(fake) {
  return createFsGateway({ ctx: fake.ctx, logger: fake.ctx.logger })
}

// --- 7. stale revisions -------------------------------------------------------

test('concurrent updates refuse stale revisions and preserve the stored record', async () => {
  const storage = fakeStorageDomain()
  const { store } = await storeOver(storage)
  await store.setPreference({ key: 'style', value: 'step-by-step', evidence: EVIDENCE_EXPLICIT_STABLE })

  const readerA = await store.readGlobal()
  const readerB = await store.readGlobal()
  assert.equal(readerA.revision, 1)

  const byA = await store.setPreference({
    key: 'style', value: 'intuition-first', evidence: EVIDENCE_EXPLICIT_STABLE, expectedRevision: readerA.revision,
  })
  assert.equal(byA.revision, 2)

  await assert.rejects(
    () => store.setPreference({
      key: 'style', value: 'proof-first', evidence: EVIDENCE_EXPLICIT_STABLE, expectedRevision: readerB.revision,
    }),
    (error) => error.code === 'PROFESSOR_MEMORY_STALE',
  )
  const after = await store.readGlobal()
  assert.equal(after.record.preferences.style.value, 'intuition-first', 'the stale writer lost nothing and changed nothing')
  assert.equal(after.revision, 2)
})

// --- 8. disabled semantics ----------------------------------------------------

test('disabled memory retrieves and persists nothing, preserves data, and reports honestly', async () => {
  const storage = fakeStorageDomain()
  const home = await makeHome('professor-memory-off-')
  const { fake, tools } = mount(home, { storage })
  const exec = makeExec({ cwd: home, sessionId: 'session-a' })

  await tools.professor_memory_update.execute({
    scope: 'global', action: 'set_preference',
    key: 'explanation_language', value: '中文', evidence: EVIDENCE_EXPLICIT_STABLE,
  }, exec)

  const disabled = await tools.professor_memory_update.execute({
    scope: 'control', action: 'set_enabled', enabled: false, reason: 'user asked to pause memory',
  }, exec)
  assert.equal(disabled.written, true)

  const read = await tools.professor_memory_read.execute({ scope: 'global' }, exec)
  assert.equal(read.enabled, false)
  assert.equal(read.record, null, 'no automatic retrieval of content while disabled')
  assert.match(read.note ?? read.warnings.join(' '), /disabled|禁用|已停用/i)

  const refused = await tools.professor_memory_update.execute({
    scope: 'global', action: 'set_preference',
    key: 'other', value: 'x', evidence: EVIDENCE_EXPLICIT_STABLE,
  }, exec)
  assert.equal(refused.written, false, 'no persistence while disabled')

  // The stored data is preserved, not deleted.
  const { store } = await storeOver(storage)
  const reread = await store.readGlobal()
  assert.equal(reread.record.preferences.explanation_language.value, '中文')

  // Ordinary conversation stays usable: the control record can be flipped back (revision-guarded,
  // like every other write on an existing record).
  const reenabled = await tools.professor_memory_update.execute({
    scope: 'control', action: 'set_enabled', enabled: true,
    expected_revision: disabled.revision,
  }, exec)
  assert.equal(reenabled.written, true)
  const readAgain = await tools.professor_memory_read.execute({ scope: 'global' }, exec)
  assert.equal(readAgain.enabled, true)
  assert.equal(readAgain.record.preferences.explanation_language.value, '中文')
  fake.disposeAll()
})

test('hydration while disabled assembles an empty section and writes no session metadata', async () => {
  const storage = fakeStorageDomain()
  const home = await makeHome('professor-memory-off-hydrate-')
  const { fake, tools } = mount(home, { storage })
  const exec = await buildProject(tools, path.join(home, 'courses'), 'session-a', 'term-2026', [
    { code: 'CSC3200', name: 'DSA', term: '2025-2026 Fall' },
  ])
  await tools.professor_memory_update.execute({ scope: 'control', action: 'set_enabled', enabled: false }, exec)

  const gateway = fakeGatewayFor(fake)
  const { store } = await storeOver(storage)
  const memory = createSessionMemory({
    store, gateway, policiesFor: readPoliciesFor,
    logger: { warn: () => {}, info: () => {} },
    isProfessorAgent: () => true,
  })
  const agent = fakeAgent(path.join(home, 'courses'), 'session-a')
  const { text, diagnostics } = await memory.hydrateAgent(agent)
  assert.equal(text, '')
  assert.equal(diagnostics.disabled, true)

  // No last_session metadata was persisted while disabled.
  const project = path.join(home, 'courses')
  const loaded = await store.readCourse(courseMemoryNamespace('term-2026', project), 'csc3200')
  assert.equal(loaded.present, false)
  fake.disposeAll()
})

// --- (helper is defined below the tests that use it, hoisted by the module system) ---

// --- 9. corrupt / newer schema ------------------------------------------------

test('corrupt or newer-schema records fail loudly without destructive recovery', async () => {
  const storage = fakeStorageDomain()
  const home = await makeHome('professor-memory-schema-')
  const { fake, tools } = mount(home, { storage })
  const exec = await buildProject(tools, path.join(home, 'courses'), 'session-a', 'term-2026', [
    { code: 'CSC3200', name: 'DSA', term: '2025-2026 Fall' },
  ])
  const project = path.join(home, 'courses')
  const namespace = courseMemoryNamespace('term-2026', project)

  const { appStorage, store } = await storeOver(storage)
  const key = courseMemoryKey(namespace, 'csc3200')

  // A newer-schema record: refused, and left in place.
  await appStorage.writeRecord(key, { schema: 'professor.memory/99', payload: { future: true } })
  await assert.rejects(
    () => store.readCourse(namespace, 'csc3200'),
    (error) => error.code === 'PROFESSOR_MEMORY_UNSUPPORTED_SCHEMA',
  )
  assert.equal(appStorage.table('app').get(key).schema, 'professor.memory/99', 'nothing was deleted')

  // A same-schema record with broken shape: corrupt, non-destructive.
  await appStorage.writeRecord(key, { schema: MEMORY_RECORD_SCHEMA, instructions: 'not-a-list' })
  await assert.rejects(
    () => store.readCourse(namespace, 'csc3200'),
    (error) => error.code === 'PROFESSOR_MEMORY_CORRUPT',
  )
  assert.equal(appStorage.table('app').get(key).instructions, 'not-a-list')

  // Through the tool: the failure is reported as a problem, not a crash, and other scopes still work.
  const viaTool = await tools.professor_memory_read.execute({ scope: 'course', course: 'CSC3200' }, exec)
  assert.equal(viaTool.present, false)
  assert.match(viaTool.problems.join(' '), /corrupt/i)
  const globalStillWorks = await tools.professor_memory_read.execute({ scope: 'global' }, exec)
  assert.equal(globalStillWorks.enabled, true)
  fake.disposeAll()
})

// --- 10. budgets and determinism ----------------------------------------------

test('context assembly is deterministic, bounded and reports omissions', () => {
  const globalRecord = {
    preferences: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`pref_${String(index).padStart(2, '0')}`, {
      value: `value-${index}-`.repeat(40), evidence: EVIDENCE_EXPLICIT_STABLE, updated_at: '2026-10-06T00:00:00.000Z',
    }])),
  }
  const courseRecord = {
    course_code: 'CSC3200', term: '2025-2026 Fall',
    instructions: Array.from({ length: 15 }, (_, index) => `Instruction ${index} `.repeat(30).trim()),
    recent_topic: 'Hash Tables',
    last_session: { session_id: 'session-prev', at: '2026-10-05T12:00:00.000Z' },
  }
  const learning = {
    current_unit: 'Unit 4', current_topic: 'Hash Tables', last_studied: '2026-10-05',
    recommended_next_step: 'Practice open addressing exercises',
    units_in_progress: 3, active_mistakes: 2,
    weak_topics: ['Open addressing clustering', 'Load factor tradeoffs'],
    deep_dives: 1,
  }

  const first = buildMemoryContext({ enabled: true, globalRecord, courseRecord, learning })
  const second = buildMemoryContext({ enabled: true, globalRecord, courseRecord, learning })
  assert.equal(first.text, second.text, 'identical inputs render byte-identical context')

  const { diagnostics } = first
  assert.equal(diagnostics.preferences.included, CONTEXT_BUDGETS.maxPreferences)
  assert.equal(diagnostics.preferences.omitted, 30 - CONTEXT_BUDGETS.maxPreferences)
  assert.equal(diagnostics.instructions.included, CONTEXT_BUDGETS.maxInstructions)
  assert.equal(diagnostics.instructions.omitted, 15 - CONTEXT_BUDGETS.maxInstructions)
  assert.ok(first.text.length <= CONTEXT_BUDGETS.maxChars + 400, 'the render respects the character budget')
  assert.match(first.text, /省略|omitted/i)
  assert.ok(first.text.indexOf('pref_00') < first.text.indexOf('pref_01'), 'preferences render in sorted key order')

  const disabled = buildMemoryContext({ enabled: false, globalRecord, courseRecord, learning })
  assert.equal(disabled.text, '')
  assert.equal(disabled.diagnostics.disabled, true)
})

test('store-level budgets bound record sizes', async () => {
  const storage = fakeStorageDomain()
  const { store } = await storeOver(storage)
  await assert.rejects(
    () => store.setPreference({
      key: 'k', value: 'x'.repeat(MEMORY_BUDGETS.MAX_PREFERENCE_VALUE_CHARS + 1), evidence: EVIDENCE_EXPLICIT_STABLE,
    }),
    (error) => error.code === 'PROFESSOR_MEMORY_INVALID',
  )
  await assert.rejects(
    () => store.setPreference({ key: 'BAD KEY', value: 'x', evidence: EVIDENCE_EXPLICIT_STABLE }),
    (error) => error.code === 'PROFESSOR_MEMORY_INVALID',
  )
})

// --- 11. two sessions, one store ------------------------------------------------

test('two sessions share one storage handle; dropping one keeps the other intact', async () => {
  const storage = fakeStorageDomain()
  const { store } = await storeOver(storage)
  await store.setPreference({ key: 'language', value: '中文', evidence: EVIDENCE_EXPLICIT_STABLE })

  const home = await makeHome('professor-memory-two-')
  const { fake } = mount(home, { storage })
  const memory = createSessionMemory({
    store,
    gateway: fakeGatewayFor(fake),
    policiesFor: readPoliciesFor,
    logger: { warn: () => {}, info: () => {} },
    isProfessorAgent: () => true,
  })

  const workspace = path.join(home, 'ws')
  await fs.mkdir(workspace, { recursive: true })
  const agentA = fakeAgent(workspace, 'session-a')
  const agentB = fakeAgent(workspace, 'session-b')
  const [hydratedA, hydratedB] = await Promise.all([memory.hydrateAgent(agentA), memory.hydrateAgent(agentB)])
  assert.match(hydratedA.text, /language/)
  assert.match(hydratedB.text, /language/)

  memory.dropAgent('session-a')
  assert.equal(await memory.textFor(agentA), '', 'a dropped agent renders nothing')
  assert.match(await memory.textFor(agentB), /language/, 'the surviving session is undisturbed')
  fake.disposeAll()
})

// --- 12. bound course context ---------------------------------------------------

test('a bound course session context includes course memory and the learning summary', async () => {
  const storage = fakeStorageDomain()
  const home = await makeHome('professor-memory-bound-')
  const { fake, tools } = mount(home, { storage })
  const project = path.join(home, 'courses')
  const exec = await buildProject(tools, project, 'session-a', 'term-2026', [
    { code: 'CSC3200', name: 'DSA', term: '2025-2026 Fall' },
  ])
  await tools.professor_session_bind.execute({ course: 'CSC3200' }, exec)
  await tools.professor_state_update.execute({
    file: 'PROGRESS.md', evidence: 'strong', field: 'current_unit', value: 'Unit 4', reason: 'checkpoint solved',
  }, exec)
  await tools.professor_state_update.execute({
    file: 'PROGRESS.md', evidence: 'strong', field: 'recommended_next_step', value: 'Practice open addressing',
  }, exec)
  // Written through a caller with no session id: the plugin's own write-through refresh then
  // hydrates nothing and cannot stamp last_session with its real clock, so the injected clock
  // below is observed exactly.
  const prior = await tools.professor_memory_read.execute({ scope: 'course', course: 'CSC3200' }, exec)
  await tools.professor_memory_update.execute({
    scope: 'course', action: 'add_instruction', course: 'CSC3200', instruction: 'Prefer C++ examples.', expected_revision: prior.revision,
  }, { agent: { session: { header: { cwd: project } } } })

  const { store } = await storeOver(storage)
  const memory = createSessionMemory({
    store,
    gateway: fakeGatewayFor(fake),
    policiesFor: readPoliciesFor,
    logger: { warn: () => {}, info: () => {} },
    isProfessorAgent: () => true,
    now: () => '2026-10-06T08:00:00.000Z',
  })
  const agent = fakeAgent(project, 'session-a')
  const { text, diagnostics } = await memory.hydrateAgent(agent)

  assert.equal(diagnostics.course, 'csc3200')
  assert.match(text, /Prefer C\+\+ examples\./, 'stable course instructions are present')
  assert.match(text, /Unit 4/, 'the learning-state summary is present')
  assert.match(text, /Practice open addressing/, 'the recommended next step is present')

  // Hydration records "last native Professor session" (metadata, not learning state).
  const loaded = await store.readCourse(courseMemoryNamespace('term-2026', project), 'csc3200')
  assert.equal(loaded.record.last_session.session_id, 'session-a')
  assert.equal(loaded.record.last_session.at, prior.record.last_session.at, 'rehydrating the same session preserves its metadata')
  fake.disposeAll()
})

test('a bound session whose course was deleted reports it instead of silently unbinding', async () => {
  const storage = fakeStorageDomain()
  const home = await makeHome('professor-memory-removed-')
  const { fake, tools } = mount(home, { storage })
  const project = path.join(home, 'courses')
  const exec = await buildProject(tools, project, 'session-a', 'term-2026', [
    { code: 'CSC3200', name: 'DSA', term: '2025-2026 Fall' },
  ])
  await tools.professor_session_bind.execute({ course: 'CSC3200' }, exec)

  const { store } = await storeOver(storage)
  const memory = createSessionMemory({
    store,
    gateway: fakeGatewayFor(fake),
    policiesFor: readPoliciesFor,
    logger: { warn: () => {}, info: () => {} },
    isProfessorAgent: () => true,
  })
  const agent = fakeAgent(project, 'session-a')
  const before = await memory.textFor(agent)
  assert.match(before, /【Professor 当前课程】/, 'the bound session starts with its exact course')

  await tools.professor_course_manage.execute({ action: 'delete', course_id: 'csc3200', confirm_delete: true }, exec)

  const after = await memory.textFor(agent)
  assert.doesNotMatch(after, /【Professor 当前课程】/, 'a removed course is never presented as current')
  assert.match(after, /csc3200/, 'the removed course is named')
  assert.match(after, /不再配置/, 'and the session reports it is no longer configured')
  fake.disposeAll()
})

// --- 13. hydration failure never breaks session start ----------------------------

test('a broken project document degrades the memory section instead of throwing', async () => {
  const storage = fakeStorageDomain()
  const home = await makeHome('professor-memory-broken-')
  const { fake } = mount(home, { storage })
  const project = path.join(home, 'courses')
  await writeFixture(home, 'courses/.professor/project.yaml', 'schema_version: 99\nproject:\n  id: future\n')

  const { store } = await storeOver(storage)
  const warnings = []
  const memory = createSessionMemory({
    store,
    gateway: fakeGatewayFor(fake),
    policiesFor: readPoliciesFor,
    logger: { warn: (message) => warnings.push(String(message)), info: () => {} },
    isProfessorAgent: () => true,
  })
  const agent = fakeAgent(project, 'session-a')
  const { text, diagnostics } = await memory.hydrateAgent(agent)
  assert.equal(text, '')
  assert.ok(diagnostics.warnings.length > 0, 'the degradation is reported')
  fake.disposeAll()
})
