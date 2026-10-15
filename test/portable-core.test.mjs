/**
 * Phase 1 (M1) — course-free bootstrap: a general Professor session must work with **no academic
 * folder connected**, and must never create or guess a course tree.
 *
 * Three things are pinned here:
 *
 * 1. **Root binding is explicit.** The conversation workspace is a Professor project root only when
 *    it actually is one (`.professor/` present) or when `DSH_PROFESSOR_PROJECT` says so. Otherwise
 *    the workspace is *unbound*: reporting tools say so, and every course-required tool refuses with
 *    a domain error instead of reading or writing a directory the user never chose. "The server
 *    happened to start in this directory" is not permission.
 * 2. **A general session still works.** Booting the plugin needs no storage service, no shell, no
 *    TeX, no Office backend and no course folder. Diagnostics/memory plumbing report what they could
 *    not observe rather than failing the mount.
 * 3. **Professor-owned application storage exists and is independent of any course.** It lives in
 *    the host's storage domain (never in the package, never in the academic folder), and its absence
 *    is reported honestly instead of being papered over.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { APP_DOMAIN_NAME, APP_DOMAIN_VERSION, createAppStorage } from '../src/app/storage.js'
import { assertProjectBound, resolveProjectRoot } from '../src/paths/roots.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

const REQUIRED_ECOSYSTEM = 'PROFESSOR_PROJECT_MISSING'

/** Tool name → arguments that would mutate or read course-owned state. */
const COURSE_REQUIRED = [
  ['professor_state_read', {}],
  ['professor_state_update', { file: 'PROGRESS.md', evidence: 'strong', field: 'current_unit', value: 'Unit 1' }],
  ['professor_index_sync', {}],
  ['professor_search', { query: 'anything' }],
  ['professor_extract', {}],
  ['professor_artifact_create', { kind: 'note', title: 'A Note', format: 'markdown' }],
  ['professor_artifact_status', {}],
  ['professor_course_manage', { action: 'register', course_code: 'CSC3200', display_name: 'DSA', term: 'F' }],
  ['professor_session_bind', { course: 'CSC3200' }],
  ['professor_latex_compile', { title: 'A Note' }],
]

const toolsOf = (fake) => Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))

/** Mount the plugin over a fixture home and return its tools. */
function mount(home, services) {
  const fake = createFakeContext({ home, ...(services === undefined ? {} : { services }) })
  apply(fake.ctx, fake.pluginConfig)
  return { fake, tools: toolsOf(fake) }
}

/** Every directory named `.professor` anywhere under `root`. */
async function professorDirs(root) {
  const found = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const target = path.join(dir, entry.name)
      if (entry.name === '.professor') found.push(target)
      await walk(target)
    }
  }
  await walk(root)
  return found
}

/** An in-memory stand-in for `ctx.storageDomain`, shaped like the installed one. */
function fakeStorageDomain() {
  const calls = { open: [], closed: 0 }
  const stores = new Map()
  const domain = {
    async close() {
      calls.closed += 1
    },
    table(name) {
      if (!stores.has(name)) stores.set(name, new Map())
      const store = stores.get(name)
      return {
        get: (key) => store.get(key),
        async put(key, value) {
          store.set(key, value)
        },
        async update(key, transform) {
          store.set(key, transform(store.get(key)))
        },
        get size() {
          return store.size
        },
      }
    },
  }
  return {
    calls,
    stores,
    service: {
      async open(spec) {
        calls.open.push(spec)
        // Faithful to the installed host: the domain layer validates **every stored record** against
        // the declared schema before it hands the domain back (`dsh-storage-domain/lib/index.js`
        // calls `tableSpec.valueSchema.parse(raw)` in its open-time `loadAll` loop). A table declared
        // without a `valueSchema` therefore opens once, accepts writes, and then refuses to reopen —
        // the real host reports that as `invalid-record`. Reproducing the load path here keeps the
        // regression that motivated `APP_VALUE_SCHEMA` cheap to catch.
        for (const [table, tableSpec] of Object.entries(spec.tables ?? {})) {
          for (const [key, raw] of stores.get(table) ?? []) {
            try {
              tableSpec.valueSchema.parse(raw)
            } catch (error) {
              throw Object.assign(
                new Error(`invalid-record: domain '${spec.name}': stored record '${key}' in table '${table}' does not match its schema`),
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

// --- 1. root binding is explicit -------------------------------------------

test('a workspace is a Professor root only when it holds .professor/, or an override names it', async () => {
  const home = await makeHome('professor-binding-')

  const loose = path.join(home, 'loose')
  await fs.mkdir(loose, { recursive: true })
  const overridden = await resolveProjectRoot(makeExec({ cwd: loose }), {
    env: { DSH_PROFESSOR_PROJECT: '/custom/project' },
  })
  assert.deepEqual(overridden, { root: '/custom/project', source: 'env:DSH_PROFESSOR_PROJECT', bound: true, reason: null })

  const unbound = await resolveProjectRoot(makeExec({ cwd: loose }), { env: {} })
  assert.equal(unbound.bound, false, 'a workspace with no .professor/ is not a Professor root')
  assert.equal(unbound.root, loose, 'the candidate is still reported, so the caller can name it')
  assert.equal(unbound.source, 'session-cwd')
  assert.match(unbound.reason, /\.professor/)

  await fs.mkdir(path.join(loose, '.professor'), { recursive: true })
  const bound = await resolveProjectRoot(makeExec({ cwd: loose }), { env: {} })
  assert.equal(bound.bound, true, 'the .professor/ marker is what makes a workspace a root')
  assert.equal(bound.root, loose)
  assert.equal(bound.source, 'session-cwd')
  assert.equal(bound.reason, null)

  // The override is trusted without touching the disk (a folder may not exist yet).
  const missing = await resolveProjectRoot(makeExec({ cwd: loose }), {
    env: { DSH_PROFESSOR_PROJECT: path.join(home, 'not-created-yet') },
  })
  assert.equal(missing.bound, true, 'an explicit override is authoritative even before the folder exists')
})

test('an unbound workspace yields a domain error that names the workspace and the fix', async () => {
  const home = await makeHome('professor-binding-')
  const loose = path.join(home, 'loose')
  await fs.mkdir(loose, { recursive: true })

  const project = await resolveProjectRoot(makeExec({ cwd: loose }), { env: {} })
  assert.throws(() => assertProjectBound(project), (error) => {
    assert.equal(error.code, REQUIRED_ECOSYSTEM, 'the refusal reuses the established domain code')
    assert.ok(error.message.includes(loose), 'the message names the workspace that is not a academic folder')
    assert.match(error.message, /professor_project_init/, 'the message says what to do next')
    return true
  })

  // A bound project passes through untouched.
  await fs.mkdir(path.join(loose, '.professor'), { recursive: true })
  const boundProject = await resolveProjectRoot(makeExec({ cwd: loose }), { env: {} })
  assert.equal(assertProjectBound(boundProject), boundProject)
})

test('resolveProjectRoot still refuses to guess when there is no conversation workspace', async () => {
  await assert.rejects(() => resolveProjectRoot({}, { env: {} }), /carries no conversation workspace/)
  await assert.rejects(
    () => resolveProjectRoot(makeExec({ cwd: undefined }), { env: {} }),
    /no conversation workspace/,
  )
})

// --- 2. no course tree is created or guessed -------------------------------

test('a general session with no academic folder refuses course work and creates no course tree', async () => {
  const home = await makeHome('professor-nocourse-')
  const project = path.join(home, 'loose')
  await writeFixture(home, 'loose/notes/todo.md', '# loose notes')
  const { fake, tools } = mount(home)
  const exec = makeExec({ cwd: project, sessionId: 'session-general' })

  for (const [name, args] of COURSE_REQUIRED) {
    await assert.rejects(
      () => tools[name].execute(args, exec),
      (error) => {
        assert.notEqual(error instanceof ReferenceError, true, `${name} must fail with a domain error`)
        assert.equal(error.code, REQUIRED_ECOSYSTEM, `${name} must refuse course work when unbound`)
        assert.match(error.message, /professor_project_init/, `${name} must say how to connect a folder`)
        return true
      },
      `${name} must refuse an unbound workspace`,
    )
  }

  assert.deepEqual(await professorDirs(home), [],
    'no .professor/ tree may be created in a workspace the user never connected')
  assert.equal(fake.logs.warn.length, 0, 'a refusal is not a host warning')
  fake.disposeAll()
})

test('reporting tools describe an unbound session instead of failing', async () => {
  const home = await makeHome('professor-nocourse-')
  const project = path.join(home, 'loose')
  await writeFixture(home, 'loose/notes/todo.md', '# loose notes')
  const { fake, tools } = mount(home)
  const exec = makeExec({ cwd: project, sessionId: 'session-general' })

  const paths = await tools.professor_paths.execute({}, exec)
  assert.equal(paths.projectBound, false)
  assert.equal(paths.projectRoot, project, 'the candidate workspace is reported')
  assert.match(paths.projectRootReason, /\.professor/)
  assert.deepEqual(paths.writeRoots, [], 'nothing is writable while unbound')
  assert.equal(paths.readRoots.includes(project), false,
    'the unconnected workspace is not granted as a read root')

  const listed = await tools.professor_course_list.execute({}, exec)
  assert.equal(listed.projectPresent, false, 'the course list answers "none connected" instead of failing')
  assert.deepEqual(listed.courses, [])

  const report = await tools.professor_diagnostics.execute({}, exec)
  assert.equal(report.project.bound, false)
  assert.match(report.project.reason, /\.professor/)
  assert.ok(report.warnings.some((message) => /academic folder|courses connected/.test(message)),
    `diagnostics must warn that no academic folder is connected: ${report.warnings.join(' | ')}`)

  fake.disposeAll()
})

test('a sibling course tree is never inherited by an unbound session', async () => {
  const home = await makeHome('professor-sibling-')
  const loose = path.join(home, 'loose')
  await fs.mkdir(loose, { recursive: true })
  // A real, initialised Professor project next door — with a course and learning state.
  await writeFixture(home, 'courseA/.professor/project.yaml', [
    'schema_version: 1',
    'project:',
    '  id: course-a',
    'courses:',
    '  - course_id: csc3200',
    '    course_code: CSC3200',
    '    display_name: Data Structures',
    '    term: 2025-2026 Fall',
    '    sources: []',
    '',
  ].join('\n'))
  await writeFixture(home, 'courseA/.professor/state/courses/csc3200/PROGRESS.md', '# 1. Current Position\n\n- Unit 9\n')

  const { fake, tools } = mount(home)
  const exec = makeExec({ cwd: loose, sessionId: 'session-general' })

  await assert.rejects(() => tools.professor_state_read.execute({}, exec),
    (error) => error.code === REQUIRED_ECOSYSTEM)
  const paths = await tools.professor_paths.execute({}, exec)
  assert.equal(paths.projectBound, false, 'a neighbouring project is not this session\'s project')
  assert.equal(paths.projectRoot, loose)
  fake.disposeAll()
})

test('professor_project_init is the one explicit opt-in and unbinds the rest of the surface afterwards', async () => {
  const home = await makeHome('professor-nocourse-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/CSC3200/01_Lectures/l1.md', '# L1')
  const { fake, tools } = mount(home)
  const exec = makeExec({ cwd: project, sessionId: 'session-general' })

  const created = await tools.professor_project_init.execute({ project_id: 'term-2026' }, exec)
  assert.equal(created.created, true)
  assert.equal(created.schemaVersion, 1)
  assert.match(await fs.readFile(path.join(project, '.professor/project.yaml'), 'utf8'), /schema_version: 1/)

  // With the marker in place the same session is bound, and the course surface works.
  const bound = await tools.professor_paths.execute({}, exec)
  assert.equal(bound.projectBound, true)
  assert.deepEqual(bound.writeRoots, [path.join(project, '.professor')])

  await tools.professor_course_manage.execute({
    action: 'register', course_code: 'CSC3200', display_name: 'DSA', term: 'F',
    source_path: path.join(project, 'CSC3200'),
  }, exec)
  const indexed = await tools.professor_index_sync.execute({}, exec)
  assert.ok(indexed.total >= 1, 'indexing works once the folder is connected')
  const read = await tools.professor_state_read.execute({ course: 'CSC3200' }, exec)
  assert.equal(read.present, false, 'no learning state is invented for a fresh course')
  fake.disposeAll()
})

// --- 3. Professor-owned application storage --------------------------------

test('Professor application storage opens its own versioned domain and bootstraps once', async () => {
  const fakeStorage = fakeStorageDomain()
  const home = await makeHome('professor-storage-')
  const storage = createAppStorage({
    ctx: { get: (name) => (name === 'storageDomain' ? fakeStorage.service : undefined) },
  })

  assert.equal(storage.describe().status, 'unopened')

  const opened = await storage.ensureOpen()
  assert.equal(opened.status, 'open')
  assert.equal(opened.domain, APP_DOMAIN_NAME)
  assert.equal(opened.version, APP_DOMAIN_VERSION)
  assert.equal(opened.scope, 'application')
  assert.equal(opened.owner, 'dsh-professor-spike')
  assert.equal(opened.bootstrapped, true)

  assert.equal(fakeStorage.calls.open.length, 1)
  const spec = fakeStorage.calls.open[0]
  assert.equal(spec.name, APP_DOMAIN_NAME)
  assert.equal(spec.version, APP_DOMAIN_VERSION)
  assert.deepEqual(Object.keys(spec.tables), ['app'], 'the plugin declares exactly one table')
  // The spec MUST carry a `valueSchema`: the host calls `valueSchema.parse(raw)` for every record it
  // loads, so a schema-less table opens once and then refuses to reopen once anything is persisted.
  assert.equal(
    typeof spec.tables.app.valueSchema?.parse,
    'function',
    'the table declares a valueSchema implementing the host\'s parse() contract',
  )
  assert.equal(spec.tables.app.valueSchema.parse({ any: 'json value' }).any, 'json value')
  assert.throws(
    () => spec.tables.app.valueSchema.parse(null),
    /the record itself must be a JSON object or array/,
    'the validator refuses a value the medium could not round-trip',
  )
  // The JSON backend enforces `/^[a-z][a-z0-9_]*$/`; a hyphenated name makes `open()` fail.
  assert.match(spec.name, /^[a-z][a-z0-9_]*$/, 'the domain name is accepted by the shipped JSON backend')

  const record = fakeStorage.stores.get('app').get('bootstrap')
  assert.equal(record.owner, 'dsh-professor-spike')
  assert.equal(record.schema, 'professor.app/1')
  assert.equal(record.domain_version, APP_DOMAIN_VERSION)
  assert.ok(typeof record.created_at === 'string' && record.created_at.length > 0)

  // Opening twice is a no-op: the bootstrap record keeps its original creation time.
  await storage.ensureOpen()
  assert.equal(fakeStorage.calls.open.length, 1, 'the domain is opened exactly once per instance')
  assert.equal(fakeStorage.stores.get('app').get('bootstrap').created_at, record.created_at)

  await storage.close()
  assert.equal(fakeStorage.calls.closed, 1, 'close() releases the handle')
  await fs.rm(home, { recursive: true, force: true })
})

test('application storage survives a reopen and keeps the original bootstrap marker', async () => {
  // The regression this guards: a schema-less table opens, accepts writes, and then cannot be
  // reopened, because the host validates stored records on load. It is deliberately a SECOND handle
  // over the SAME bytes — the first open alone proves nothing.
  const fakeStorage = fakeStorageDomain()

  const first = createAppStorage({
    ctx: { get: (name) => (name === 'storageDomain' ? fakeStorage.service : undefined) },
  })
  const opened = await first.ensureOpen()
  assert.equal(opened.status, 'open')
  assert.equal(opened.bootstrapped, true)
  const createdAta = fakeStorage.stores.get('app').get('bootstrap').created_at
  await first.close()

  const second = createAppStorage({
    ctx: { get: (name) => (name === 'storageDomain' ? fakeStorage.service : undefined) },
  })
  const reopened = await second.ensureOpen()
  assert.equal(reopened.status, 'open', 'a fresh handle can reopen the persisted domain')
  assert.equal(reopened.bootstrapped, false, 'the existing marker is recognised, not rewritten')
  assert.equal(fakeStorage.stores.get('app').get('bootstrap').created_at, createdAta)
  assert.equal(fakeStorage.calls.open.length, 2, 'the reopen really did call the host again')
  await second.close()
})

test('application storage reports an unobservable host honestly instead of throwing', async () => {
  const absent = createAppStorage({ ctx: {} })
  const reported = await absent.ensureOpen()
  assert.equal(reported.status, 'unavailable')
  assert.match(reported.reason, /storageDomain/)
  assert.equal(reported.bootstrapped, false)
  await absent.close()

  const failing = createAppStorage({
    ctx: {
      get: () => ({
        async open() {
          const error = new Error('backend-not-found: no backend is routed for this domain')
          error.code = 'backend-not-found'
          throw error
        },
      }),
    },
  })
  const refused = await failing.ensureOpen()
  assert.equal(refused.status, 'unavailable')
  assert.match(refused.reason, /backend-not-found/)
  // A failed open is memoised too: a broken backend must not be retried on every tool call.
  await failing.ensureOpen()
  assert.equal(refused.status, 'unavailable')
  await failing.close()
})

test('the mounted plugin reports its application storage through diagnostics', async () => {
  const fakeStorage = fakeStorageDomain()
  const home = await makeHome('professor-storage-')
  const project = path.join(home, 'loose')
  await fs.mkdir(project, { recursive: true })
  const { fake, tools } = mount(home, { storageDomain: fakeStorage.service })
  const exec = makeExec({ cwd: project, sessionId: 'session-general' })

  const report = await tools.professor_diagnostics.execute({}, exec)
  assert.equal(report.appStorage.status, 'open')
  assert.equal(report.appStorage.domain, APP_DOMAIN_NAME)
  assert.equal(report.appStorage.owner, 'dsh-professor-spike')
  assert.equal(report.appStorage.scope, 'application')
  assert.equal(fakeStorage.stores.get('app').get('bootstrap').owner, 'dsh-professor-spike',
    'a general session bootstraps its own storage even with no course connected')

  fake.disposeAll()
})

test('diagnostics state an absent storage service without failing the session', async () => {
  const home = await makeHome('professor-storage-')
  const project = path.join(home, 'loose')
  await fs.mkdir(project, { recursive: true })
  const { fake, tools } = mount(home)
  const exec = makeExec({ cwd: project, sessionId: 'session-general' })

  const report = await tools.professor_diagnostics.execute({}, exec)
  assert.equal(report.appStorage.status, 'unavailable')
  assert.ok(typeof report.appStorage.reason === 'string' && report.appStorage.reason.length > 0)
  fake.disposeAll()
})

// --- 4. optional backends degrade, boot never depends on them --------------

test('a host with no shell, no Office bridge and no TeX still mounts the full surface', async () => {
  const home = await makeHome('professor-bare-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/CSC3200/01_Lectures/lecture-01.pdf', '%PDF-1.4')
  const { fake, tools } = mount(home)
  const exec = makeExec({ cwd: project, sessionId: 'session-general' })

  // Nothing in the mount path needs a service that may be absent.
  assert.equal(fake.tools.length, 22)
  assert.equal(fake.providers.length, 1)
  assert.deepEqual(fake.logs.warn, [], 'booting on a bare host is not a degradation')

  await tools.professor_project_init.execute({ project_id: 'term' }, exec)
  await tools.professor_course_manage.execute({
    action: 'register', course_code: 'CSC3200', display_name: 'DSA', term: 'F',
    source_path: path.join(project, 'CSC3200'),
  }, exec)
  await tools.professor_index_sync.execute({}, exec)

  const extraction = await tools.professor_extract.execute({}, exec)
  assert.equal(extraction.extracted, 0, 'no PDF text is claimed without an observed backend')
  assert.ok(extraction.unsupported >= 1,
    `a PDF with no available backend is unsupported, never a silent partial read: ${JSON.stringify(extraction.results)}`)

  const report = await tools.professor_diagnostics.execute({}, exec)
  assert.equal(report.extraction.capabilities.pdf.text, false, 'the PDF backend is reported as not observed')
  assert.equal(report.extraction.capabilities.ocr, false, 'OCR stays off by design')
  assert.ok(report.extraction.capabilities.pdf.reason.length > 0, 'the reason is stated, not implied')
  // LaTeX is *probed*, so its verdict differs per machine; the contract is the shape and the note.
  assert.equal(typeof report.latex.available, 'boolean')
  assert.equal(report.latex.engine === null || typeof report.latex.engine === 'string', true)
  assert.ok(typeof report.latex.note === 'string' && report.latex.note.length > 0,
    'a LaTeX verdict always carries the observation it is based on')
  assert.ok(report.notImplemented.length > 0, 'the remaining limitations are still listed')

  fake.disposeAll()
})
