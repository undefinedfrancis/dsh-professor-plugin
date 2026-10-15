/**
 * The browser bundle's contract.
 *
 * The bundle cannot be built here (there is no bundler in this repository), so instead of pretending
 * to render it, this suite **executes** it the way the host's client module system does: provide a
 * `window.__ModuleLoader__`, materialize the factory with a `require` stub, and interrogate what the
 * module actually exported and what `apply()` actually registered.
 *
 * That catches the two failures worth catching cheaply: a face whose shape the loader would reject,
 * and a wire contract that drifted from its ESM twin in `client/remote.js`.
 *
 * @module test/client-bundle
 */

import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import TYPERT_REMOTE from '../client/remote.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = path.join(REPO, 'client', 'client.js')

/** Materialize the bundle exactly as `@deepseek-ai/dsh-client-modules` would. */
async function loadBundle(reactOverride) {
  const registrations = []
  const win = { __ModuleLoader__: { load: (entry) => registrations.push(entry) } }
  const source = await readFile(BUNDLE, 'utf8')
  const factory = new Function('window', 'globalThis', source)(win, win)
  assert.ok(win.__ModuleLoader__.load === win.__ModuleLoader__.load)
  assert.equal(registrations.length, 1, 'executing the bundle registers exactly one module')
  const entry = registrations[0]
  const require = (specifier) => {
    if (specifier === 'react') return reactOverride ?? { createElement: (...args) => ({ type: args[0], props: args[1] ?? {} }) }
    throw new Error(`unexpected require(${specifier}) in the bundle`)
  }
  entry.exports = entry.factory(require)
  return { entry, exports: entry.exports }
}

/** A fake client Cordis context recording every contribution. */
function fakeClientContext(remoteImpl = {}) {
  const record = { mounted: [], panels: [], slots: [], sidebar: [], opened: [], retired: [], warns: [], fibers: [], disposedFibers: [] }
  const remote = {
    async $mount(contribution) {
      record.mounted.push(contribution)
      return async () => { record.mounted.pop() }
    },
    // The client Remote face resolves a **result envelope**, never the bare value — this fake mirrors
    // that, so a component that forgot to unwrap fails here instead of in a real browser.
    professorHome: {
      home: async () => {
        record.homeReads = (record.homeReads ?? 0) + 1
        return { ok: true, value: remoteImpl.home ?? { ok: true, courses: [], recent: [], continue: null, connection: { connected: false } } }
      },
      launch: async (request) => {
        record.launched = [...(record.launched ?? []), request]
        return { ok: true, value: remoteImpl.launchResult ?? { ok: true, sessionId: 'professor-r-abc', title: '会话', mode: request.mode, courseId: request.courseId ?? null } }
      },
      reopen: async (request) => {
        record.reopened = request
        if (remoteImpl.reopenFails) {
          const error = new Error('this Professor session no longer exists')
          error.code = 'PROFESSOR_SESSION_MISSING'
          return { ok: false, error }
        }
        return { ok: true, value: { ok: true, sessionId: request.sessionId } }
      },
      clearSession: async (request) => {
        record.cleared = [...(record.cleared ?? []), request]
        if (remoteImpl.clearGate) await remoteImpl.clearGate
        if (remoteImpl.clearFails) {
          const error = new Error('Harness refused to archive this conversation: native archive refused.')
          error.code = 'PROFESSOR_ARCHIVE_FAILED'
          return { ok: false, error }
        }
        return { ok: true, value: { ok: true, sessionId: request.sessionId, archived: true } }
      },
      clearAllSnapshot: async () => {
        record.bulkSnapshots = (record.bulkSnapshots ?? 0) + 1
        return { ok: true, value: remoteImpl.bulkSnapshot ?? { ok: true, token: 'clr-tok1', count: 2, previews: [], expiresAt: 0 } }
      },
      clearAllStart: async (request) => {
        record.bulkStarts = [...(record.bulkStarts ?? []), request]
        if (remoteImpl.bulkStartGate) await remoteImpl.bulkStartGate
        if (remoteImpl.bulkStartFails) {
          const error = new Error('This confirmation is no longer valid.')
          error.code = 'PROFESSOR_CLEAR_ALL_TOKEN_INVALID'
          return { ok: false, error }
        }
        return { ok: true, value: remoteImpl.bulkFirstBatch ?? { ok: true, operationId: 'op-1', done: true,
          counts: { cleared: 2, skipped: 0, failed: 0, remaining: 0 }, outcomes: [] } }
      },
      clearAllContinue: async (request) => {
        record.bulkContinues = [...(record.bulkContinues ?? []), request]
        return { ok: true, value: remoteImpl.bulkNextBatch ?? { ok: true, operationId: 'op-1', done: true,
          counts: { cleared: 2, skipped: 0, failed: 0, remaining: 0 }, outcomes: [] } }
      },
      presetLibrary: async () => ({ ok: true, value: remoteImpl.presetBlock ?? { bundled: [], user: [], userRevision: 0,
        defaultPresetId: 'builtin-progressive', applied: null, overlay: {}, overlayRevision: 0, automaticDefault: true } }),
      presetSave: async (request) => { record.presetSaves = [...(record.presetSaves ?? []), request]; return { ok: true, value: { revision: 1 } } },
      presetDelete: async (request) => { record.presetDeletes = [...(record.presetDeletes ?? []), request]; return { ok: true, value: { revision: 2 } } },
      presetApply: async (request) => { record.presetApplies = [...(record.presetApplies ?? []), request]; return { ok: true, value: { overlayRevision: 1, applied: { presetId: request.presetId, presetVersion: 1, overlayRevision: 1, state: 'preset' } } } },
    },
  }
  const ctx = {
    logger: { warn: (message) => record.warns.push(message), info: () => {} },
    remote,
    sessions: { refresh: async () => { record.refreshed = true } },
    slots: {
      // The host keys slot contributions by their `name`: `main` is a keyed main panel, everything
      // else (here `sidebar.panellist`) is a contribution to that slot. Lumping them together would
      // make "one panel" untestable, so the fake separates them the way the host does.
      register: (spec, component) => {
        const bucket = spec.name === 'main' ? record.panels : record.slots
        const entry = { spec, component }
        bucket.push(entry)
        return () => { bucket.splice(bucket.indexOf(entry), 1) }
      },
      inject: (slot, factory) => { record.sidebar.push({ slot, entry: factory() }); return () => { record.sidebar.pop() } },
    },
    layout: { retirePanel: (id) => record.retired.push(id), selectPanel: (id) => record.selected = id },
    uiWorkspace: { openSession: (sessionId) => record.opened.push(sessionId) },
    // The UI fibre: the host starts it as soon as the services it declares exist. `remote.professorHome`
    // exists here because `apply` mounted the contribution first — which is exactly why the UI cannot
    // live in the outer fibre (see the "installs the UI on a child fibre" test).
    plugin: (plugin) => {
      assert.equal(typeof plugin.apply, 'function', 'cordis accepts a plugin object with `apply`')
      const child = { ...ctx, plugin: ctx.plugin }
      record.fibers.push(plugin)
      const teardown = plugin.apply(child)
      const fiber = Promise.resolve()
      fiber.dispose = async () => {
        if (typeof teardown === 'function') await teardown()
        record.disposedFibers.push(plugin.name)
      }
      return fiber
    },
  }
  return { ctx, record }
}

test('the bundle registers itself as an official client module', async () => {
  const { entry, exports } = await loadBundle()
  assert.equal(entry.id, 'dsh-professor-spike', 'the id must be the package name the loader resolves')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'layout', 'uiWorkspace', 'remote', 'sessions'])
  assert.equal(exports.PANEL_ID, 'professor-home')
  assert.deepEqual(exports.STUDY_MODES, ['learn', 'question', 'assignment', 'review', 'exam', 'free'])
})

test('Home renders labelled course and topic controls, not only their labels', async () => {
  let stateIndex = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: initial => [stateIndex++ === 0
      ? { status: 'ready', data: { courses: [], recent: [], connection: { connected: false } }, error: null }
      : initial, () => {}],
    useEffect() {},
    useRef: initial => ({ current: initial }),
  }
  const { exports } = await loadBundle(react)
  const { ctx, record } = fakeClientContext()
  const dispose = await exports.apply(ctx)
  const component = record.panels[0].component()
  const tree = component.type(component.props)
  const nodes = []
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    nodes.push(node)
    walk(node.props?.children)
  }
  walk(tree)
  assert.ok(nodes.some(node => node.type === 'select' && node.props.id === 'professor-home-course'))
  assert.ok(nodes.some(node => node.type === 'input' && node.props.id === 'professor-home-topic'))
  await dispose()
})

test('navigation failure retries the original launch token rather than creating another conversation', async () => {
  const values = []
  let index = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const at = index++
      if (!(at in values)) values[at] = at === 0 ? { status: 'ready', data: { courses: [], recent: [] }, error: null } : initial
      return [values[at], next => { values[at] = next }]
    },
    useRef(initial) { const at = index++; return values[at] ??= { current: initial } },
    useEffect() {},
  }
  const { exports } = await loadBundle(react)
  const { ctx, record } = fakeClientContext()
  let refreshes = 0
  ctx.sessions.refresh = async () => { if (refreshes++ === 0) throw new Error('catalog unavailable') }
  const dispose = await exports.apply(ctx)
  function launchButton() {
    index = 0
    const component = record.panels[0].component()
    const root = component.type(component.props)
    let button
    function walk(node) {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!node || typeof node !== 'object') return
      if (node.props?.['data-professor-action'] === 'launch') button = node
      walk(node.props?.children)
    }
    walk(root)
    return button
  }
  await launchButton().props.onClick()
  await launchButton().props.onClick()
  assert.equal(record.launched.length, 2)
  assert.equal(record.launched[0].requestId, record.launched[1].requestId)
  await dispose()
})

test('Home course action launches that exact course without a second selection step', async () => {
  const values = []; let index = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const at = index++; return [values[at] ??= at === 0 ? { status: 'ready', data: { courses: [{ course_id: 'archived-copy', course_code: 'CSC3200', status: 'archived', active: false }, { course_id: 'csc3200', course_code: 'CSC3200', display_name: 'Data Structures' }], recent: [] }, error: null } : initial, value => { values[at] = value }] },
    useRef(initial) { const at = index++; return values[at] ??= { current: initial } }, useEffect() {},
  }
  const { exports } = await loadBundle(react)
  const { ctx, record } = fakeClientContext()
  const dispose = await exports.apply(ctx)
  const panel = record.panels[0].component(); const root = panel.type(panel.props)
  let button; let courseActions = 0
  const walk = node => { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return; if (node.props?.['data-professor-action'] === 'use-course') { button = node; courseActions++ } walk(node.props?.children) }
  walk(root)
  assert.equal(courseActions, 1, 'archived courses remain in settings, not the study launcher')
  await button.props.onClick()
  assert.equal(record.launched?.[0]?.courseId, 'csc3200')
  assert.equal(record.launched[0].mode, 'learn')
  await dispose()
})

test('the bundle never reaches for a CDN or the network', async () => {
  const source = await readFile(BUNDLE, 'utf8')
  assert.ok(!/https?:\/\//.test(source), 'the bundle contains no URL')
  assert.ok(!/\bimport\s*\(/.test(source), 'and performs no dynamic import')
})

test('settings page renders labelled preference inputs and real save/reset actions', async () => {
  let stateIndex = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: initial => [stateIndex++ === 0 ? { data: { overlay: { revision: 0, fields: {} }, global: { fields: {} }, memory: { enabled: true, status: 'available' } }, error: null } : initial, () => {}],
    useEffect() {}, useRef: initial => ({ current: initial }),
  }
  const { exports } = await loadBundle(react)
  assert.equal(typeof exports.ProfessorDetails, 'function')
  const tree = exports.ProfessorDetails({ page: 'settings', courses: [], api: {}, onBack() {} })
  const nodes = []
  const walk = node => { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return; nodes.push(node); walk(node.props?.children) }
  walk(tree)
  for (const key of ['language', 'explanationStyle', 'teachingDepth']) {
    assert.ok(nodes.some(node => node.type === 'select' && node.props?.id === 'professor-preference-' + key))
  }
  const advanced = nodes.find(node => node.type === 'details' && node.props?.className === 'professor-home__advanced')
  assert.ok(advanced && advanced.props.open !== true, 'advanced settings are collapsed initially')
  assert.ok(nodes.some(node => node.props?.['data-professor-action'] === 'save-customization'))
  assert.ok(nodes.some(node => node.props?.['data-professor-action'] === 'reset-customization'))
  assert.ok(nodes.some(node => node.props?.['data-professor-action'] === 'toggle-memory'))
})

test('material handoff appends a native reference through retained input without sending a message', async () => {
  const { exports } = await loadBundle()
  assert.equal(typeof exports.prepareMaterialDraft, 'function')
  const inserted = [], opened = []
  const input = { addFiles: (refs, ids) => { inserted.push({ refs, ids }); return true }, submit: () => { throw new Error('must not send') } }
  const ctx = { sessions: { refresh: async () => {}, using: async (id, options, operation) => ({ ok: true, value: await operation({ binding: { ctx: { session: id } } }) }) },
    get: name => name === 'conversation' ? { input: { for: () => input } } : null,
    uiWorkspace: { openSession: id => opened.push(id) }, layout: { selectPanel() {} } }
  await exports.prepareMaterialDraft(ctx, { sessionId: 'owned', relativePath: 'CSC/Lecture one.txt', readyForDraft: true })
  assert.equal(inserted[0].refs[0].ref, '@"CSC/Lecture one.txt"')
  assert.deepEqual(inserted[0].ids, [])
  assert.deepEqual(opened, ['owned'])
})
test('material codecs refuse unexpected browser paths with a domain TypeError', async () => {
  const { exports } = await loadBundle()
  for (const face of [exports.TYPERT_REMOTE, TYPERT_REMOTE]) {
    const codec = face.descriptors.find(row => row.method === 'launchMaterial').parameters[0].codec.create()
    assert.throws(() => codec.parse({ requestId: 'material-request', courseId: 'csc', fileId: 'f', mode: 'learn', path: '/outside' }), TypeError)
  }
})
test('withdrawal during native session refresh refuses draft mutation', async () => {
  const { exports } = await loadBundle(); let active = true, retained = 0
  const ctx = { sessions: { refresh: async () => { active = false }, using: async () => { retained++ } } }
  await assert.rejects(exports.prepareMaterialDraft(ctx, { sessionId: 'owned', relativePath: 'CSC/lecture.txt', readyForDraft: true }, () => active))
  assert.equal(retained, 0)
})
test('leaving a course page prevents late material draft mutation and navigation', async () => {
  const values = []; let index = 0, cleanup, effectStarted = false, release, opened = 0
  const data = { course: { course_id: 'csc', course_code: 'CSC' }, index: { status: 'indexed' }, total: 1,
    materials: [{ fileId: 'f1', name: 'lecture.txt', category: 'lectures' }], recent: [], nextOffset: null }
  const blocked = new Promise(resolve => { release = resolve })
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const at = index++; if (!(at in values)) values[at] = at === 0 ? { data, error: null } : initial; return [values[at], value => { values[at] = value }] },
    useRef(initial) { const at = index++; return values[at] ??= { current: initial } },
    useEffect(effect) { if (!effectStarted) { effectStarted = true; cleanup = effect() } },
  }
  const { exports } = await loadBundle(react)
  const props = { page: 'course', courseId: 'csc', api: { course: async () => data, launchMaterial: async () => { await blocked; return { sessionId: 'owned' } }, openMaterial: async () => { opened++ } } }
  function render() {
    index = 0; let button
    const walk = node => { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return; if (node.props['data-professor-action'] === 'study-material-f1') button = node; walk(node.props.children) }
    walk(exports.ProfessorDetails(props)); return button
  }
  render(); await new Promise(resolve => setImmediate(resolve))
  const work = render().props.onClick(); cleanup(); release(); await work
  assert.equal(opened, 0)
})

test('settings section navigation retains drafts and a single mounted workspace', async () => {
  const values = []; let index = 0
  const data = { overlay: { revision: 0, fields: {} }, global: { fields: {} }, memory: { enabled: true, status: 'available' } }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const at = index++; if (!(at in values)) values[at] = at === 0 ? { data, error: null } : initial; return [values[at], value => { values[at] = value }] },
    useRef(initial) { const at = index++; return values[at] ??= { current: initial } }, useEffect() {},
  }
  const { exports } = await loadBundle(react)
  function render() {
    index = 0; const nodes = []
    const walk = node => { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return; nodes.push(node); walk(node.props?.children) }
    walk(exports.ProfessorDetails({ page: 'settings', courses: [], api: {}, onBack() {} })); return nodes
  }
  let nodes = render()
  nodes.find(node => node.props.id === 'professor-preference-language').props.onChange({ target: { value: '保留草稿' } })
  for (const section of ['workspace', 'memory', 'preferences']) {
    nodes = render()
    const button = nodes.find(node => node.props['data-professor-section'] === section)
    assert.ok(button, `missing ${section} navigation`)
    button.props.onClick(); nodes = render()
    assert.equal(nodes.find(node => node.props['data-professor-section'] === section).props['aria-pressed'], true)
    assert.equal(nodes.find(node => node.props.id === 'professor-panel-' + section).props.hidden, false)
    assert.equal(nodes.filter(node => node.type === exports.ProfessorWorkspaceSettings).length, 1)
  }
  assert.equal(render().find(node => node.props.id === 'professor-preference-language').props.value, '保留草稿')
})

test('course retry retains its token while switching study mode creates a distinct intent', async () => {
  const values = [], requests = []
  let index = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const at = index++; if (!(at in values)) values[at] = at === 0 ? { data: { course: { course_id: 'csc', course_code: 'CSC3200' }, index: { status: 'missing' }, materials: [], recent: [], total: 0, nextOffset: null }, error: null } : initial; return [values[at], value => { values[at] = value }] },
    useRef(initial) { const at = index++; return values[at] ??= { current: initial } }, useEffect() {},
  }
  const { exports } = await loadBundle(react)
  const props = { page: 'course', courseId: 'csc', onBack() {}, api: { launch: async request => { requests.push(request); throw new Error('temporary failure') } } }
  function button(action) {
    index = 0
    const root = exports.ProfessorDetails(props)
    let target
    const walk = node => { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return; if (node.props?.['data-professor-action'] === action) target = node; walk(node.props?.children) }
    walk(root); return target
  }
  await button('study-course').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  await button('study-course').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  await button('ask-course').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests[0].requestId, requests[1].requestId)
  assert.notEqual(requests[1].requestId, requests[2].requestId)
})

test('memory toggle retains unsaved preference fields and blocks duplicate clicks', async () => {
  const data = { overlay: { revision: 0, fields: {} }, global: { fields: {} }, memory: { enabled: true, status: 'available', revision: null } }
  const values = [], requests = []
  let index = 0, release
  const blocked = new Promise(resolve => { release = resolve })
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const at = index++; if (!(at in values)) values[at] = at === 0 ? { data, error: null } : initial; return [values[at], value => { values[at] = value }] },
    useRef(initial) { const at = index++; return values[at] ??= { current: initial } }, useEffect() {},
  }
  const { exports } = await loadBundle(react)
  const props = { page: 'settings', courses: [], api: {
    setMemoryEnabled: async args => { requests.push(args); await blocked; return { enabled: false, revision: 1, refresh: 'complete' } },
    settings: async () => ({ ...data, memory: { enabled: false, status: 'available', revision: 1 } }),
  } }
  function node(predicate) {
    index = 0
    let found
    const walk = value => { if (Array.isArray(value)) return value.forEach(walk); if (!value || typeof value !== 'object') return; if (predicate(value)) found = value; walk(value.props?.children) }
    walk(exports.ProfessorDetails(props)); return found
  }
  const language = () => node(value => value.props?.id === 'professor-preference-language')
  language().props.onChange({ target: { value: 'unsaved draft' } })
  const toggle = node(value => value.props?.['data-professor-action'] === 'toggle-memory')
  const first = toggle.props.onClick()
  toggle.props.onClick()
  release(); await first
  assert.deepEqual(requests, [{ enabled: false, expectedRevision: null }])
  assert.equal(language().props.value, 'unsaved draft')
})

test('course form uses observed token and explicit archive acknowledgment', async () => {
  const values = [], calls = []; let index = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const at = index++; if (!(at in values)) values[at] = initial; return [values[at], value => { values[at] = typeof value === 'function' ? value(values[at]) : value }] },
    useRef(initial) { const at = index++; return values[at] ??= { current: initial } }, useEffect() {},
  }
  const { exports } = await loadBundle(react)
  const props = { api: { home: async () => ({ courses: [], recent: [] }), workspaceCommand: async request => {
    calls.push(request); return request.action === 'courses' ? { courseToken: 'observed', courses: [{ course_id: 'csc', course_code: 'CSC', display_name: 'Original', term: 'T', active: true }, { course_id: 'alg', course_code: 'ALG', display_name: 'Algorithms', term: 'T', active: true }] } : { changed: ['csc'], problems: [] }
  } } }
  function node(predicate) {
    index = 0; let found
    const walk = value => { if (Array.isArray(value)) return value.forEach(walk); if (!value || typeof value !== 'object') return; if (predicate(value)) found = value; walk(value.props?.children) }
    walk(exports.ProfessorWorkspaceSettings(props)); return found
  }
  const action = name => node(value => value.props['data-professor-action'] === name)
  values[0] = { connection: { connected: true }, courses: [], recent: [] }
  values[1] = { sessionId: 'owned', folder: '/academic' }
  assert.ok(action('load-managed-courses'), 'course list must be an explicit operation')
  await action('load-managed-courses').props.onClick()
  node(value => value.props.id === 'professor-course-name-alg').props.onChange({ target: { value: 'Other course draft' } })
  await action('archive-course-csc').props.onClick()
  assert.equal(calls.filter(call => call.action === 'manageCourse').length, 0)
  node(value => value.props.id === 'professor-archive-csc').props.onChange({ target: { checked: true } })
  await action('archive-course-csc').props.onClick()
  const submitted = calls.find(call => call.action === 'manageCourse')
  assert.deepEqual(submitted.args, { courseToken: 'observed', courseId: 'csc', operation: 'archive' })
  assert.equal(node(value => value.props.id === 'professor-course-name-alg').props.value, 'Other course draft')
})

test('folder picker prepares its session internally and preserves explicit course confirmation', async () => {
  const values = [], calls = []
  let index = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const at = index++; if (!(at in values)) values[at] = initial; return [values[at], value => { values[at] = typeof value === 'function' ? value(values[at]) : value }] },
    useRef(initial) { const at = index++; return values[at] ??= { current: initial } }, useEffect() {},
  }
  const { exports } = await loadBundle(react)
  assert.equal(typeof exports.ProfessorWorkspaceSettings, 'function')
  let launches = 0
  const props = { api: { pickFolder: async () => '/academic', launch: async () => { launches++; return { sessionId: 'owned' } }, home: async () => ({ recent: [{ sessionId: 'owned', title: 'Setup', status: 'ready' }], courses: [] }),
    workspaceCommand: async request => { calls.push(request); return request.action === 'discover' ? { ok: true, proposalToken: 'server-token', proposal: { root: '/academic', candidates: [
      { relative_path: 'CSC3200', confidence: 'high', proposed: { course_code: 'CSC3200' } },
      { relative_path: 'Algorithms', confidence: 'low', proposed: {} },
    ] } } : request.action === 'courses' ? { courseToken: 'fresh', courses: [] } : { ok: true, applied: true, readiness: { configuration: { saved: true }, index: { complete: true }, extraction: { complete: true }, searchable: true } } },
  } }
  function node(predicate) {
    index = 0; let found
    const walk = value => { if (Array.isArray(value)) return value.forEach(walk); if (!value || typeof value !== 'object') return; if (predicate(value)) found = value; walk(value.props?.children) }
    walk(exports.ProfessorWorkspaceSettings(props)); return found
  }
  const action = name => node(value => value.props?.['data-professor-action'] === name)
  const field = id => node(value => value.props?.id === id)
  assert.equal(field('professor-workspace-session'), undefined)
  await action('choose-workspace-folder').props.onClick()
  assert.equal(field('professor-workspace-folder').props.value, '/academic')
  await action('discover-workspace').props.onClick()
  assert.equal(field('professor-candidate-choice-1').props.value, 'exclude')
  field('professor-candidate-code-1').props.onChange({ target: { value: 'ALG1001' } })
  field('professor-candidate-choice-1').props.onChange({ target: { value: 'include' } })
  await action('confirm-workspace').props.onClick()
  assert.equal(calls[1].args.proposalToken, 'server-token')
  assert.equal(launches, 1, 'scan and save reuse the internally prepared session')
  assert.equal(calls[0].sessionId, 'owned')
  assert.equal(calls[2].action, 'courses', 'saved courses load automatically')
  assert.equal(calls[1].args.proposal, undefined)
  assert.deepEqual(calls[1].args.selections[1], { relative_path: 'Algorithms', action: 'include', course_code: 'ALG1001' })
})

test('workspace form does not submit an included course without an explicit code', async () => {
  const values = []; let index = 0, calls = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const at = index++; if (!(at in values)) values[at] = initial; return [values[at], value => { values[at] = typeof value === 'function' ? value(values[at]) : value }] },
    useRef(initial) { const at = index++; return values[at] ??= { current: initial } }, useEffect() {},
  }
  const { exports } = await loadBundle(react)
  const props = { api: { launch: async () => ({ sessionId: 'owned' }), home: async () => ({ recent: [], courses: [] }), workspaceCommand: async () => { calls++; return { ok: true, proposalToken: 'token', proposal: { root: '/academic', candidates: [{ relative_path: 'Algorithms', confidence: 'low', proposed: {} }] } } } } }
  function node(predicate) {
    index = 0; let found
    const walk = value => { if (Array.isArray(value)) return value.forEach(walk); if (!value || typeof value !== 'object') return; if (predicate(value)) found = value; walk(value.props?.children) }
    walk(exports.ProfessorWorkspaceSettings(props)); return found
  }
  const action = name => node(value => value.props?.['data-professor-action'] === name)
  node(value => value.props?.id === 'professor-workspace-folder').props.onChange({ target: { value: '/academic' } })
  await action('discover-workspace').props.onClick()
  node(value => value.props?.id === 'professor-candidate-choice-0').props.onChange({ target: { value: 'include' } })
  await action('confirm-workspace').props.onClick()
  assert.equal(calls, 1)
})

test('workspace diagnostics display observable health and limitations instead of only completion', async () => {
  let index = 0
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: initial => [index++ === 5 ? { busy: false, message: '', result: { plugin: { version: 'test' }, project: { connected: true, projectFile: 'present', schemaHealth: { supported: true }, courses: { total: 2 } }, runtime: { shell_runner: 'wired' }, memory: { enabled: false }, limitations: [{ feature: 'OCR unavailable' }] } } : initial, () => {}],
    useRef: initial => ({ current: initial }), useEffect() {} }
  const { exports } = await loadBundle(react)
  const tree = exports.ProfessorWorkspaceSettings({ api: {} })
  const strings = []
  const walk = value => { if (Array.isArray(value)) return value.forEach(walk); if (typeof value === 'string') strings.push(value); else if (value && typeof value === 'object') walk(value.props?.children) }
  walk(tree)
  assert.ok(strings.join('\n').includes('OCR unavailable'))
  assert.ok(strings.join('\n').includes('课程数：2'))
})

test('folder confirmation invalidates old course drafts and reloads global settings', async () => {
  const values = [], requests = []; let index = 0, writes = 0
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const at = index++; if (!(at in values)) values[at] = at === 0 ? { data: { overlay: { revision: 1, fields: { language: 'old course draft' } }, global: { fields: {} }, memory: { enabled: true, status: 'available' } }, error: null } : initial; return [values[at], value => { values[at] = typeof value === 'function' ? value(values[at]) : value }] },
    useRef(initial) { const at = index++; return values[at] ??= { current: initial } }, useEffect() {} }
  const { exports } = await loadBundle(react)
  const props = { page: 'settings', courseId: 'same-id', courses: [], api: { saveCustomization: async () => { writes++; return {} }, settings: async args => { requests.push(args); return { overlay: { revision: 0, fields: {} }, global: { fields: {} }, memory: { enabled: true, status: 'available' }, courses: [] } } } }
  function node(predicate) {
    index = 0; let found
    const walk = value => { if (Array.isArray(value)) return value.forEach(walk); if (!value || typeof value !== 'object') return; if (predicate(value)) found = value; walk(value.props?.children) }
    walk(exports.ProfessorDetails(props)); return found
  }
  const workspace = node(value => value.type === exports.ProfessorWorkspaceSettings)
  const previousSave = node(value => value.props?.['data-professor-action'] === 'save-customization')
  assert.equal(typeof workspace.props.onConnectionChanging, 'function')
  workspace.props.onConnectionChanging()
  await previousSave.props.onClick()
  assert.equal(writes, 0, 'even a previously rendered save handler is synchronously locked')
  assert.ok(node(value => value.type === exports.ProfessorWorkspaceSettings), 'workspace form survives while preference state is invalidated')
  assert.equal(node(value => value.props?.['data-professor-action'] === 'save-customization'), undefined)
  await workspace.props.onConnectionChanged()
  assert.equal(requests[0].courseId, null)
  assert.equal(node(value => value.props?.id === 'professor-settings-scope').props.value, '')
})

test('the mounted contribution matches client/remote.js exactly', async () => {
  const { exports } = await loadBundle()
  const shape = (contribution) => ({
    package: contribution.package,
    descriptors: contribution.descriptors.map((descriptor) => ({
      id: descriptor.id,
      service: descriptor.service,
      namespace: descriptor.namespace,
      method: descriptor.method,
      invocation: descriptor.invocation,
      parameters: descriptor.parameters.map((parameter) => ({
        name: parameter.name,
        wire: parameter.wire,
        source: parameter.source,
        strict: parameter.codec?.mode,
        typeSymbol: parameter.codec?.typeSymbol,
      })),
      result: descriptor.result && {
        strict: descriptor.result.mode,
        typeSymbol: descriptor.result.typeSymbol,
      },
    })),
  })
  assert.deepEqual(shape(exports.TYPERT_REMOTE), shape(TYPERT_REMOTE))
})

test('every descriptor survives the registry validation the host runs before mounting', async () => {
  // Regression: an invocation without a `result` codec is rejected by the client Typert registry
  // with `Cannot read properties of undefined (reading 'mode')`, which surfaces in the browser only
  // as "web boot: 1 entry did not activate — dsh-professor-spike: failed". Nothing short of loading
  // the real page noticed it, so the registry's own rules are reproduced here.
  const validateCodec = (codec, subject) => {
    assert.ok(codec !== undefined, `${subject} must carry a codec`)
    assert.ok(codec.mode === 'strict' || codec.mode === 'src-json', `${subject} codec mode`)
    assert.ok(typeof codec.typeSymbol === 'string' && codec.typeSymbol.length > 0, `${subject} type symbol`)
    assert.equal(typeof codec.create, 'function', `${subject} codec factory`)
    assert.equal(typeof codec.create().parse, 'function', `${subject} codec parser`)
  }
  const { exports } = await loadBundle()
  for (const contribution of [exports.TYPERT_REMOTE, TYPERT_REMOTE]) {
    for (const descriptor of contribution.descriptors) {
      assert.ok(descriptor.id.length > 0)
      assert.match(descriptor.namespace, /^[A-Za-z0-9_-]+$/)
      assert.match(descriptor.method, /^[A-Za-z0-9_-]+$/)
      validateCodec(descriptor.result, `${descriptor.id} result`)
      const wires = new Set()
      for (const parameter of descriptor.parameters) {
        assert.ok(!wires.has(parameter.wire), `${descriptor.id} repeats a wire field`)
        wires.add(parameter.wire)
        validateCodec(parameter.codec, `${descriptor.id} parameter ${parameter.name}`)
      }
    }
  }
})

test('every input leaving the browser carries a strict codec', async () => {
  const { exports } = await loadBundle()
  for (const descriptor of TYPERT_REMOTE.descriptors) {
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict', `${descriptor.id} must validate strictly`)
      assert.equal(typeof parameter.codec.create().parse, 'function')
    }
  }
  // and the strict codecs actually reject the shapes they claim to
  const launchCodec = TYPERT_REMOTE.descriptors[1].parameters[0].codec.create().parse
  assert.throws(() => launchCodec({ requestId: 'short', mode: 'coding' }), TypeError)
  assert.throws(() => launchCodec({ requestId: 'r-abcdef12', mode: 'learn', messages: [] }), TypeError)
  assert.deepEqual(launchCodec({ requestId: 'r-abcdef12', mode: 'exam' }), { requestId: 'r-abcdef12', mode: 'exam' })
  const reopenCodec = TYPERT_REMOTE.descriptors[2].parameters[0].codec.create().parse
  assert.throws(() => reopenCodec({ sessionId: 'x', transcript: [] }), TypeError)
})

test('apply mounts the endpoints, then the panel and the sidebar entry', async () => {
  const { exports } = await loadBundle()
  const { ctx, record } = fakeClientContext()
  const dispose = await exports.apply(ctx)
  assert.equal(record.mounted.length, 1, 'the Typed Remote contribution is mounted')
  assert.equal(record.panels.length, 1)
  assert.equal(record.panels[0].spec.name, 'main')
  assert.equal(record.panels[0].spec.key, 'professor-home')
  assert.equal(record.sidebar.length, 1)
  assert.equal(record.sidebar[0].slot, 'sidebar.panellist')
  await dispose()
  assert.equal(record.mounted.length, 0, 'disabling removes the endpoints')
  assert.equal(record.panels.length, 0, 'and the panel registration')
  assert.equal(record.sidebar.length, 0, 'and the sidebar entry')
  assert.deepEqual(record.retired, ['professor-home'])
})

test('the UI is installed on a child fibre that owns the namespace dependency', async () => {
  const { exports } = await loadBundle()
  assert.equal(
    exports.inject.includes('remote.professorHome'), false,
    'the outer fibre mounts the namespace, so declaring it as a dependency parks the plugin forever',
  )
  const { ctx, record } = fakeClientContext()
  const dispose = await exports.apply(ctx)
  assert.equal(record.fibers.length, 1, 'exactly one child fibre')
  assert.deepEqual(record.fibers[0].inject, ['remote.professorHome'])
  await dispose()
  assert.deepEqual(record.disposedFibers, ['professor-home:ui'], 'and disabling disposes it')
})

test('a launch navigates through the official native-session service', async () => {
  const { exports } = await loadBundle()
  const { ctx, record } = fakeClientContext()
  const dispose = await exports.apply(ctx)
  const api = record.panels[0].spec.inject().api
  const result = await api.launch({ requestId: 'r-abcdef12', mode: 'review', courseId: null, topic: null })
  assert.equal(result.sessionId, 'professor-r-abc', 'the value inside the result envelope, not the envelope')
  await api.open(result.sessionId)
  assert.equal(record.refreshed, true)
  assert.equal(record.selected, null)
  assert.deepEqual(record.opened, ['professor-r-abc'], 'and nothing sent HTTP anywhere')
  await dispose()
})

test('a Remote failure envelope is surfaced, never rendered as if it were data', async () => {
  // Regression: the client face resolves `{ ok: false, error }` instead of rejecting, so a Home that
  // read the envelope as its payload rendered `undefined` rows and the slot crashed.
  const { exports } = await loadBundle()
  const { ctx, record } = fakeClientContext({ reopenFails: true })
  const dispose = await exports.apply(ctx)
  const api = record.panels[0].spec.inject().api
  await assert.rejects(api.reopen({ sessionId: 'professor-missing' }), (error) => error.code === 'PROFESSOR_SESSION_MISSING')
  await dispose()
})

test('a Remote reply that never arrives becomes a retryable error, not a busy state forever', async () => {
  const { exports } = await loadBundle()
  const previous = exports.REMOTE_TIMEOUT_MS
  exports.REMOTE_TIMEOUT_MS = 15
  const { ctx, record } = fakeClientContext()
  ctx.remote.professorHome.home = () => new Promise(() => {})
  const dispose = await exports.apply(ctx)
  const api = record.panels[0].spec.inject().api
  await assert.rejects(api.home(), (error) => error.code === 'gateway/timeout')
  exports.REMOTE_TIMEOUT_MS = previous
  await dispose()
})

test('a failing mount unwinds without leaving a half-registered UI', async () => {
  const { exports } = await loadBundle()
  const { ctx, record } = fakeClientContext()
  ctx.remote.$mount = async () => { throw new Error('namespace already mounted') }
  await assert.rejects(exports.apply(ctx))
  assert.equal(record.panels.length, 0)
  assert.equal(record.sidebar.length, 0)
})

test('a host without a Remote mount degrades loudly instead of pretending', async () => {
  const { exports } = await loadBundle()
  const { ctx, record } = fakeClientContext()
  ctx.remote.$mount = undefined
  const dispose = await exports.apply(ctx)
  assert.equal(record.warns.length, 1)
  assert.match(record.warns[0], /no Remote mount/)
  await dispose()
})

/** Depth-first search over the element tree a fake-React render produced. */
function findNode(tree, predicate) {
  let found = null
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    if (predicate(node)) found = node
    walk(node.props && node.props.children)
  }
  walk(tree)
  return found
}

const actionOf = (tree, action) => findNode(tree, (node) => node.props && node.props['data-professor-action'] === action)
const dialogOf = (tree) => findNode(tree, (node) => node.props && node.props.request && node.props.request.action === 'confirm-delete-course')

test('Home offers deletion only behind a confirmation that names the course and refuses on cancel', async () => {
  const calls = []
  let index = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const at = index++
      if (!(at in values)) values[at] = at === 0
        ? { status: 'ready', error: null, data: {
          courses: [{ course_id: 'csc3200', course_code: 'CSC3200', display_name: '数据结构', term: '2025-2026 Fall' }],
          recent: [], continue: null, connection: { connected: true, folder: '/academic' } } }
        : initial
      return [values[at], (next) => { values[at] = typeof next === 'function' ? next(values[at]) : next }]
    },
    useRef(initial) { const at = index++; return (values[at] ??= { current: initial }) },
    useEffect() {},
  }
  const values = []
  const { exports } = await loadBundle(react)
  const homePayload = { ok: true,
    courses: [{ course_id: 'csc3200', course_code: 'CSC3200', display_name: '数据结构', term: '2025-2026 Fall' }],
    recent: [], continue: null, connection: { connected: true, folder: '/academic' } }
  const { ctx, record } = fakeClientContext({ home: homePayload })
  ctx.remote.professorHome.workspaceCommand = async (request) => {
    calls.push(request)
    return { ok: true, value: request.action === 'courses'
      ? { courseToken: 'snapshot-token', courses: [{ course_id: 'csc3200', course_code: 'CSC3200', display_name: '数据结构', term: '2025-2026 Fall', active: true }] }
      : { changed: ['csc3200'], problems: [] } }
  }
  const dispose = await exports.apply(ctx)
  const render = () => { index = 0; const element = record.panels[0].component(); return element.type(element.props) }

  const card = findNode(render(), (node) => node.props && node.props['data-professor-action'] === 'delete-course-csc3200')
  assert.ok(card, 'Home exposes a delete control on the course card')
  assert.equal(card.props['aria-label'], '删除课程 数据结构', 'the control names its exact target')
  assert.equal(card.props.className.includes('quiet'), true, 'deletion is visually secondary to Start learning')

  await card.props.onClick()
  const dialogElement = dialogOf(render())
  assert.ok(dialogElement, 'asking opens the confirmation')
  const dialog = dialogElement.type(dialogElement.props)
  const strings = []
  const collect = (node) => {
    if (Array.isArray(node)) return node.forEach(collect)
    if (node === null || node === undefined || node === false) return
    if (typeof node === 'string' || typeof node === 'number') { strings.push(String(node)); return }
    if (typeof node !== 'object') return
    collect(node.props && node.props.children)
  }
  collect(dialog)
  assert.ok(strings.join('\n').includes('数据结构'), 'the dialog names the exact course')
  assert.ok(strings.join('\n').includes('课程原始文件、笔记、复习资料'), 'the dialog states that course files are unaffected')
  const dialogBox = findNode(dialog, (node) => node.props && node.props.role === 'dialog')
  assert.ok(dialogBox, 'the confirmation is an accessible dialog')
  assert.equal(dialogBox.props['aria-modal'], 'true')
  assert.ok(dialogBox.props['aria-labelledby'], 'the dialog is labelled by its title')
  const buttons = [{ focus() { doc.activeElement = this } }, { focus() { doc.activeElement = this } }]
  const doc = { activeElement: buttons[1] }
  const container = { ownerDocument: doc, querySelectorAll: () => buttons }
  let prevented = false
  dialogBox.props.onKeyDown({ key: 'Tab', shiftKey: false, currentTarget: container,
    preventDefault() { prevented = true }, stopPropagation() {} })
  assert.equal(doc.activeElement, buttons[0], 'Tab wraps within the confirmation instead of reaching the background')
  assert.equal(prevented, true)
  dialogBox.props.onKeyDown({ key: 'Tab', shiftKey: true, currentTarget: container,
    preventDefault() {}, stopPropagation() {} })
  assert.equal(doc.activeElement, buttons[1], 'Shift-Tab wraps backwards within the confirmation')

  await actionOf(dialog, 'confirm-cancel').props.onClick()
  assert.equal(calls.length, 0, 'cancel performs no mutation at all')
  assert.equal((record.launched ?? []).length, 0, 'and prepares no session')
  assert.ok(!dialogOf(render()), 'the dialog closes')

  await card.props.onClick()
  const openedElement = dialogOf(render())
  const inFlight = actionOf(openedElement.type(openedElement.props), 'confirm-delete-course').props.onClick()
  // A second click can arrive before React commits the busy-state render.
  const duplicateFlight = actionOf(openedElement.type(openedElement.props), 'confirm-delete-course').props.onClick()
  assert.equal((record.launched ?? []).length, 1, 'two clicks before a re-render still prepare only one session')
  const busyElement = dialogOf(render())
  assert.equal(busyElement.props.busy, true, 'the confirmation reports its busy state')
  await actionOf(busyElement.type(busyElement.props), 'confirm-delete-course').props.onClick()
  assert.equal((record.launched ?? []).length, 1, 'the duplicate click prepared no second session')
  await inFlight
  await duplicateFlight

  assert.equal(record.launched[0].folder, '/academic', 'the guarded command runs against the connected folder')
  assert.equal(record.launched[0].mode, 'free')
  assert.deepEqual(calls.map((call) => call.action), ['courses', 'manageCourse'])
  assert.deepEqual(calls[1].args, { courseToken: 'snapshot-token', courseId: 'csc3200', operation: 'delete', confirmDelete: true })
  assert.ok(!dialogOf(render()), 'a confirmed deletion closes the dialog')
  await dispose()
})

test('course management confirms deletion, keeps other drafts and refuses without confirmation', async () => {
  const values = [], calls = []
  let index = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const at = index++
      if (!(at in values)) values[at] = at === 0 ? { connection: { connected: true }, courses: [], recent: [] } : initial
      return [values[at], (next) => { values[at] = typeof next === 'function' ? next(values[at]) : next }]
    },
    useRef(initial) { const at = index++; return (values[at] ??= { current: initial }) },
    useEffect() {},
  }
  const { exports } = await loadBundle(react)
  const props = {
    api: {
      home: async () => ({ connection: { connected: true }, courses: [], recent: [] }),
      launch: async () => ({ sessionId: 'owned' }),
      workspaceCommand: async (request) => {
        calls.push(request)
        return request.action === 'courses'
          ? { courseToken: 'observed', courses: [
            { course_id: 'csc', course_code: 'CSC', display_name: 'Original', term: 'T', active: true },
            { course_id: 'alg', course_code: 'ALG', display_name: 'Algorithms', term: 'T', active: false },
          ] }
          : { changed: [request.args.courseId], problems: [] }
      },
    },
  }
  const render = () => { index = 0; return exports.ProfessorWorkspaceSettings(props) }
  await actionOf(render(), 'load-managed-courses').props.onClick()

  const loaded = render()
  const draftField = findNode(loaded, (node) => node.props && node.props.id === 'professor-course-name-alg')
  draftField.props.onChange({ target: { value: 'Other course draft' } })

  const target = actionOf(render(), 'delete-course-csc')
  assert.ok(target, 'an active registration offers deletion')
  assert.ok(actionOf(render(), 'delete-course-alg'), 'an archived registration offers deletion too')
  await target.props.onClick()

  const dialogElement = dialogOf(render())
  const dialog = dialogElement.type(dialogElement.props)
  assert.match(actionOf(dialog, 'confirm-delete-course').props['aria-label'], /删除课程：Original/)
  await actionOf(dialog, 'confirm-cancel').props.onClick()
  assert.equal(calls.filter((call) => call.action === 'manageCourse').length, 0, 'cancel performs no mutation')

  await actionOf(render(), 'delete-course-csc').props.onClick()
  await actionOf(dialogOf(render()).type(dialogOf(render()).props), 'confirm-delete-course').props.onClick()
  const mutation = calls.find((call) => call.action === 'manageCourse')
  assert.deepEqual(mutation.args, { courseToken: 'observed', courseId: 'csc', operation: 'delete', confirmDelete: true },
    'the browser sends the observed token, the exact id and an explicit confirmation')
  assert.ok(!dialogOf(render()), 'the dialog closes on success')

  const after = render()
  const survivor = findNode(after, (node) => node.props && node.props.id === 'professor-course-name-alg')
  assert.ok(survivor, 'the other registration is still listed')
  assert.equal(survivor.props.value, 'Other course draft', "the other course's unsaved draft survived the deletion")
})

const clearDialogOf = (tree) => findNode(tree, (node) => node.props && node.props.request && node.props.request.action === 'confirm-clear-conversation')

/** The Recent-clearing UI contract: archive semantics, exact target, one confirmation, one lock. */
function clearHarness(remoteImpl, recentRow) {
  const values = []
  let index = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const at = index++
      if (!(at in values)) values[at] = at === 0
        ? { status: 'ready', error: null, data: {
          courses: [], recent: [recentRow], continue: null, connection: { connected: false } } }
        : initial
      return [values[at], (next) => { values[at] = typeof next === 'function' ? next(values[at]) : next }]
    },
    useRef(initial) { const at = index++; return (values[at] ??= { current: initial }) },
    useEffect() {},
  }
  return { react, values, reset: () => { index = 0 } }
}

const RECENT_ROW = {
  requestId: 'req-clear01ab', sessionId: 'professor-r-clear1', courseId: null,
  title: 'Hash tables · 学习', mode: 'learn', status: 'ready', error: null,
  updatedAt: '2026-10-09T12:00:00.000Z', usable: true,
}

test('each Recent row offers Clear beside Open, behind one shared confirmation with archive semantics', async () => {
  const remoteImpl = { home: { ok: true, courses: [], recent: [RECENT_ROW], continue: null, connection: { connected: false } } }
  const harness = clearHarness(remoteImpl, RECENT_ROW)
  const { exports } = await loadBundle(harness.react)
  const { ctx, record } = fakeClientContext(remoteImpl)
  const dispose = await exports.apply(ctx)
  const render = () => { harness.reset(); const element = record.panels[0].component(); return element.type(element.props) }

  const tree = render()
  const open = actionOf(tree, 'reopen')
  const clear = actionOf(tree, 'clear-conversation')
  assert.ok(open, 'the existing Open action remains')
  assert.ok(clear, 'every settled Recent row gains a clear action')
  assert.equal(clear.props['aria-label'], '清除对话 Hash tables · 学习', 'the control names its exact target')
  assert.equal(clear.props.className.includes('quiet'), true, 'clearing is visually secondary to Open')

  await clear.props.onClick()
  const dialogElement = clearDialogOf(render())
  assert.ok(dialogElement, 'asking opens the shared confirmation')
  assert.equal(dialogElement.props.title, '清除此对话？')
  assert.equal(dialogElement.props.confirmLabel, '清除对话')
  assert.equal(dialogElement.props.busyLabel, '正在清除…')
  const strings = []
  const collect = (node) => {
    if (Array.isArray(node)) return node.forEach(collect)
    if (node === null || node === undefined || node === false) return
    if (typeof node === 'string' || typeof node === 'number') { strings.push(String(node)); return }
    if (typeof node !== 'object') return
    collect(node.props && node.props.children)
  }
  collect(dialogElement.type(dialogElement.props))
  const text = strings.join('\n')
  assert.ok(text.includes('最近对话和继续学习中移除'), 'the dialog states removal from Recent and Continue')
  assert.ok(text.includes('归档') && text.includes('恢复'), 'the dialog states archiving, not deletion, and that history is recoverable')
  assert.ok(text.includes('材料、索引、笔记、持久记忆和学习进度都不会改变'), 'the dialog states materials and memory are untouched')
  assert.ok(text.includes('正在运行的对话需要先结束或由你停止'), 'the dialog states the active-conversation precondition')

  await actionOf(dialogElement.type(dialogElement.props), 'confirm-cancel').props.onClick()
  assert.equal((record.cleared ?? []).length, 0, 'cancel sends no mutation request')
  assert.ok(!clearDialogOf(render()), 'the dialog closes')

  const reopenedDialog = clearDialogOf(render())
  assert.ok(!reopenedDialog)
  await dispose()
})

test('confirming a clear sends exactly the session id with confirmed:true and refreshes both lists', async () => {
  const remoteImpl = { home: { ok: true, courses: [], recent: [RECENT_ROW], continue: null, connection: { connected: false } } }
  const harness = clearHarness(remoteImpl, RECENT_ROW)
  const { exports } = await loadBundle(harness.react)
  const { ctx, record } = fakeClientContext(remoteImpl)
  const dispose = await exports.apply(ctx)
  const render = () => { harness.reset(); const element = record.panels[0].component(); return element.type(element.props) }

  await actionOf(render(), 'clear-conversation').props.onClick()
  const dialogElement = clearDialogOf(render())
  await actionOf(dialogElement.type(dialogElement.props), 'confirm-clear-conversation').props.onClick()
  assert.deepEqual(record.cleared, [{ sessionId: 'professor-r-clear1', confirmed: true }],
    'the confirmation sends the exact id and the confirmed flag, nothing else')
  assert.equal(record.refreshed, true, 'the native session list is refreshed through the supported host API')
  assert.ok(record.homeReads >= 1, 'Professor Home re-reads after the clear')
  assert.ok(!clearDialogOf(render()), 'the dialog closes on success')
  await dispose()
})

test('a double click on the clear confirmation starts only one operation', async () => {
  let release
  const remoteImpl = {
    home: { ok: true, courses: [], recent: [RECENT_ROW], continue: null, connection: { connected: false } },
    clearGate: new Promise((resolve) => { release = resolve }),
  }
  const harness = clearHarness(remoteImpl, RECENT_ROW)
  const { exports } = await loadBundle(harness.react)
  const { ctx, record } = fakeClientContext(remoteImpl)
  const dispose = await exports.apply(ctx)
  const render = () => { harness.reset(); const element = record.panels[0].component(); return element.type(element.props) }

  await actionOf(render(), 'clear-conversation').props.onClick()
  const dialog = clearDialogOf(render()).type(clearDialogOf(render()).props)
  const first = actionOf(dialog, 'confirm-clear-conversation').props.onClick()
  const second = actionOf(dialog, 'confirm-clear-conversation').props.onClick()
  assert.equal(record.cleared.length, 1, 'the synchronous lock admits exactly one operation')
  release()
  await Promise.all([first, second].map((promise) => Promise.resolve(promise)))
  assert.equal(record.cleared.length, 1)
  await dispose()
})

test('a refused clear keeps the dialog open with the reason and allows a safe retry', async () => {
  const remoteImpl = {
    home: { ok: true, courses: [], recent: [RECENT_ROW], continue: null, connection: { connected: false } },
    clearFails: true,
  }
  const harness = clearHarness(remoteImpl, RECENT_ROW)
  const { exports } = await loadBundle(harness.react)
  const { ctx, record } = fakeClientContext(remoteImpl)
  const dispose = await exports.apply(ctx)
  const render = () => { harness.reset(); const element = record.panels[0].component(); return element.type(element.props) }

  await actionOf(render(), 'clear-conversation').props.onClick()
  await actionOf(clearDialogOf(render()).type(clearDialogOf(render()).props), 'confirm-clear-conversation').props.onClick()
  const dialogElement = clearDialogOf(render())
  assert.ok(dialogElement, 'the dialog stays open on failure')
  const alert = findNode(dialogElement.type(dialogElement.props), (node) => node.props && node.props.role === 'alert')
  assert.ok(alert && String(alert.props.children).includes('native archive refused'), 'the real reason is shown where the decision was made')

  remoteImpl.clearFails = false
  await actionOf(dialogElement.type(dialogElement.props), 'confirm-clear-conversation').props.onClick()
  assert.equal(record.cleared.length, 2, 'the confirm button retries safely')
  assert.ok(!clearDialogOf(render()), 'and the dialog closes on success')
  await dispose()
})

test('clear codecs refuse unexpected browser payloads', async () => {
  const { exports } = await loadBundle()
  for (const face of [exports.TYPERT_REMOTE, TYPERT_REMOTE]) {
    const codec = face.descriptors.find(row => row.method === 'clearSession').parameters[0].codec.create()
    assert.throws(() => codec.parse({ sessionId: 'professor-r-abc', confirmed: true, force: true }), TypeError)
    assert.throws(() => codec.parse({ sessionId: 'professor-r-abc' }), TypeError)
    assert.deepEqual(codec.parse({ sessionId: 'professor-r-abc', confirmed: true }), { sessionId: 'professor-r-abc', confirmed: true })
  }
})

test('Clear all sits beside the Recent heading and its confirmation explains archiving, not deletion', async () => {
  const remoteImpl = { home: { ok: true, courses: [], recent: [RECENT_ROW], continue: null, connection: { connected: false } } }
  const harness = clearHarness(remoteImpl, RECENT_ROW)
  const { exports } = await loadBundle(harness.react)
  const { ctx, record } = fakeClientContext(remoteImpl)
  const dispose = await exports.apply(ctx)
  const render = () => { harness.reset(); const element = record.panels[0].component(); return element.type(element.props) }

  const button = actionOf(render(), 'clear-all-conversations')
  assert.ok(button, 'the bulk action is offered beside the Recent heading')
  assert.equal(button.props['aria-label'], '清除全部 Professor 最近对话')

  await button.props.onClick()
  const dialogElement = findNode(render(), (node) => node.props && node.props.request && node.props.request.action === 'confirm-clear-all-conversations')
  assert.ok(dialogElement, 'one shared confirmation')
  assert.equal(dialogElement.props.title, '清除 2 条对话？', 'the title carries the exact backend-owned count')
  const strings = []
  const collect = (node) => {
    if (Array.isArray(node)) return node.forEach(collect)
    if (node === null || node === undefined || node === false) return
    if (typeof node === 'string' || typeof node === 'number') { strings.push(String(node)); return }
    if (typeof node !== 'object') return
    collect(node.props && node.props.children)
  }
  collect(dialogElement.type(dialogElement.props))
  const text = strings.join('\n')
  assert.ok(text.includes('归档') && text.includes('恢复'), 'archived, recoverable — not permanent deletion')
  assert.ok(text.includes('材料、索引、笔记、持久记忆和学习进度都不会改变'))
  assert.ok(text.includes('正在运行或仍在准备的对话会跳过'), 'running/preparing conversations may remain')
  assert.ok(text.includes('新建的对话不会被包含'), 'the snapshot scope is closed')

  await actionOf(dialogElement.type(dialogElement.props), 'confirm-cancel').props.onClick()
  assert.equal(record.bulkStarts ?? null, null, 'cancel sends zero mutation requests')
  assert.equal(record.bulkSnapshots, 1, 'only the read-only snapshot was taken')
  await dispose()
})

test('confirming Clear all walks the confirmed snapshot through bounded batches, once', async () => {
  const remoteImpl = {
    home: { ok: true, courses: [], recent: [RECENT_ROW], continue: null, connection: { connected: false } },
    bulkSnapshot: { ok: true, token: 'clr-tok1', count: 7, previews: [], expiresAt: 0 },
    bulkFirstBatch: { ok: true, operationId: 'op-1', done: false,
      counts: { cleared: 5, skipped: 0, failed: 0, remaining: 2 }, outcomes: [] },
    bulkNextBatch: { ok: true, operationId: 'op-1', done: true,
      counts: { cleared: 6, skipped: 1, failed: 0, remaining: 0 }, outcomes: [{ sessionId: 's9', title: 'T', status: 'skipped', reason: 'still running; finish or stop it, then clear again' }] },
  }
  const harness = clearHarness(remoteImpl, RECENT_ROW)
  const { exports } = await loadBundle(harness.react)
  const { ctx, record } = fakeClientContext(remoteImpl)
  const dispose = await exports.apply(ctx)
  const render = () => { harness.reset(); const element = record.panels[0].component(); return element.type(element.props) }

  await actionOf(render(), 'clear-all-conversations').props.onClick()
  const dialog = findNode(render(), (node) => node.props && node.props.request && node.props.request.action === 'confirm-clear-all-conversations')
  const confirm = actionOf(dialog.type(dialog.props), 'confirm-clear-all-conversations')
  const firstClick = confirm.props.onClick()
  const secondClick = actionOf(dialog.type(dialog.props), 'confirm-clear-all-conversations').props.onClick()
  await Promise.all([firstClick, secondClick])
  assert.deepEqual(record.bulkStarts, [{ token: 'clr-tok1' }], 'one start for the exact confirmed snapshot')
  assert.deepEqual(record.bulkContinues, [{ operationId: 'op-1' }], 'continuation rides the same operation handle')
  const result = findNode(render(), (node) => node.props && node.props.role === 'status' && node.props.className && node.props.className.includes('bulk-result'))
  assert.ok(result, 'completion counts are shown')
  assert.equal(record.refreshed, true, 'the native session list is refreshed')
  await dispose()
})

test('partial bulk failure keeps remaining rows visible with reasons and a safe retry', async () => {
  const remoteImpl = {
    home: { ok: true, courses: [], recent: [RECENT_ROW], continue: null, connection: { connected: false } },
    bulkSnapshot: { ok: true, token: 'clr-tok1', count: 3, previews: [], expiresAt: 0 },
    bulkFirstBatch: { ok: true, operationId: 'op-1', done: true,
      counts: { cleared: 1, skipped: 0, failed: 2, remaining: 0 },
      outcomes: [
        { sessionId: 's1', title: '已清除的', status: 'cleared', reason: 'cleared (native chat archived)' },
        { sessionId: 's2', title: '失败甲', status: 'failed', reason: 'Harness refused to archive this conversation: busy (PROFESSOR_ARCHIVE_FAILED)' },
        { sessionId: 's3', title: '失败乙', status: 'failed', reason: 'could not verify existence (PROFESSOR_SESSION_EXISTENCE_UNVERIFIED)' },
      ] },
  }
  const harness = clearHarness(remoteImpl, RECENT_ROW)
  const { exports } = await loadBundle(harness.react)
  const { ctx, record } = fakeClientContext(remoteImpl)
  const dispose = await exports.apply(ctx)
  const render = () => { harness.reset(); const element = record.panels[0].component(); return element.type(element.props) }

  await actionOf(render(), 'clear-all-conversations').props.onClick()
  const dialog = findNode(render(), (node) => node.props && node.props.request && node.props.request.action === 'confirm-clear-all-conversations')
  await actionOf(dialog.type(dialog.props), 'confirm-clear-all-conversations').props.onClick()
  const result = findNode(render(), (node) => node.props && node.props.role === 'status' && node.props.className && node.props.className.includes('bulk-result'))
  assert.ok(result, 'partial success is not reported as universal success')
  const strings = []
  const collect = (node) => {
    if (Array.isArray(node)) return node.forEach(collect)
    if (node === null || node === undefined || node === false) return
    if (typeof node === 'string' || typeof node === 'number') { strings.push(String(node)); return }
    if (typeof node !== 'object') return
    collect(node.props && node.props.children)
  }
  collect(result)
  const text = strings.join('\n')
  assert.ok(text.includes('已清除 1 条，跳过 0 条，失败 2 条'), 'truthful aggregate counts')
  assert.ok(text.includes('失败甲') && text.includes('PROFESSOR_ARCHIVE_FAILED'), 'failure reasons are actionable')
  assert.ok(text.includes('失败乙'))
  assert.ok(actionOf(result, 'clear-all-retry'), 'a safe retry for remaining rows is offered')
  // The retry takes a fresh snapshot and needs a new confirmation — never a silent replay.
  await actionOf(result, 'clear-all-retry').props.onClick()
  assert.equal(record.bulkSnapshots, 2, 'retry reads a fresh snapshot of whatever remains')
  assert.equal(record.bulkStarts.length, 1, 'and starts nothing without the new confirmation')
  await dispose()
})

test('the preset library previews, applies explicitly, and never activates a saved definition', async () => {
  const presetBlock = {
    bundled: [{ id: 'builtin-progressive', name: '循序讲解', description: '先讲清概念。', version: 1,
      fields: { teachingDepth: '适中，解释关键步骤', additionalInstructions: '循序渐进的顺序教学' } }],
    user: [{ id: 'mine-1', name: '我的讲法', description: '适合我。', version: 1, fields: { additionalInstructions: '每步都给一个小例子。' } }],
    userRevision: 3, defaultPresetId: 'builtin-progressive',
    applied: null, overlay: { language: '中文' }, overlayRevision: 4, automaticDefault: false,
  }
  const values = []; let index = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const at = index++
      if (!(at in values)) values[at] = at === 0
        ? { status: 'ready', error: null, data: { courses: [], recent: [], continue: null, connection: { connected: false },
          presets: presetBlock, overlay: { fields: presetBlock.overlay, revision: 4 }, global: { fields: {}, revision: 0 }, memory: { status: 'available', enabled: true, revision: 1 } } }
        : initial
      return [values[at], (next) => { values[at] = typeof next === 'function' ? next(values[at]) : next }]
    },
    useRef(initial) { const at = index++; return (values[at] ??= { current: initial }) },
    useEffect() {},
  }
  const { exports } = await loadBundle(react)
  const { ctx, record } = fakeClientContext({
    home: { ok: true, courses: [], recent: [], continue: null, connection: { connected: false } },
    presetBlock,
  })
  const dispose = await exports.apply(ctx)
  const tree = exports.ProfessorDetails({ page: 'settings', courses: [], api: {
    settings: async () => ({ courses: [], overlay: { fields: presetBlock.overlay, revision: 4 }, global: { fields: {}, revision: 0 },
      memory: { status: 'available', enabled: true, revision: 1 }, presets: presetBlock, connection: { connected: false } }),
    presetApply: async (request) => { record.presetApplies = [...(record.presetApplies ?? []), request]; return { overlayRevision: 5, applied: { presetId: request.presetId, presetVersion: 1, overlayRevision: 5, state: 'preset' } } },
    presetSave: async (request) => { record.presetSaves = [...(record.presetSaves ?? []), request]; return { revision: 4 } },
    saveCustomization: async () => ({ revision: 5, fields: {} }),
  }, onBack() {} })

  // Locate the LearningPresets element in the settings tree and expand it exactly once.
  let presetElement = null
  const locate = (node) => {
    if (Array.isArray(node)) return node.forEach(locate)
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'function' && node.type.name === 'LearningPresets') presetElement = node
    locate(node.props && node.props.children)
  }
  locate(tree)
  assert.ok(presetElement, 'the preset section is part of the settings page')
  const presetTree = presetElement.type(presetElement.props)
  const nodes = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    nodes.push(node)
    walk(node.props && node.props.children)
  }
  walk(presetTree)
  const text = []
  const collect = (node) => {
    if (Array.isArray(node)) return node.forEach(collect)
    if (node === null || node === undefined || node === false) return
    if (typeof node === 'string' || typeof node === 'number') { text.push(String(node)); return }
    if (typeof node !== 'object') return
    collect(node.props && node.props.children)
  }
  collect(presetTree)
  assert.ok(text.join('\n').includes('学习预设'), 'the preset section renders above basic preferences')
  assert.ok(nodes.some(node => node.props && node.props['data-professor-action'] === 'apply-preset-builtin-progressive'), 'each definition offers 使用此预设')
  assert.ok(nodes.some(node => node.props && node.props['data-professor-action'] === 'apply-preset-mine-1'))
  assert.ok(nodes.some(node => node.props && node.props['data-professor-action'] === 'new-preset'), '新建预设 is offered')
  assert.ok(nodes.some(node => node.props && node.props['data-professor-action'] === 'copy-preset-builtin-progressive'), 'builtins can be copied')
  assert.equal(nodes.some(node => node.props && node.props['data-professor-action'] === 'delete-preset-builtin-progressive'), false, 'builtins cannot be deleted')
  assert.ok(nodes.some(node => node.props && node.props['data-professor-action'] === 'delete-preset-mine-1'), 'user definitions can be deleted')
  assert.ok(nodes.some(node => node.props && node.props['data-professor-action'] === 'restore-automatic'), '恢复自动 is available')
  assert.equal(record.presetApplies ?? null, null, 'rendering never activates anything')

  const applyButton = nodes.find(node => node.props && node.props['data-professor-action'] === 'apply-preset-builtin-progressive')
  await applyButton.props.onClick()
  assert.deepEqual(record.presetApplies, [{ presetId: 'builtin-progressive', courseId: null, expectedRevision: 4 }],
    'activation is explicit and revision-guarded')
  await dispose()
})

test('copying a built-in preset generates a valid non-reserved id that production validation accepts and saves', async () => {
  const { createFakeStorageDomain } = await import('./helpers/fake-harness.mjs')
  const { createAppStorage } = await import('../src/app/storage.js')
  const { createPresetLibraryStore, validatePresetDefinition } = await import('../src/app/presets.js')
  const { BUNDLED_PRESETS } = await import('../src/skills/presets.js')

  const medium = createFakeStorageDomain({ name: 'professor_app' })
  const storage = createAppStorage({ ctx: { get: () => medium.service }, logger: { warn() {}, info() {} }, readVersion: async () => 'test' })
  const store = createPresetLibraryStore({ appStorage: storage })
  const builtinSnapshot = JSON.parse(JSON.stringify(BUNDLED_PRESETS))

  const values = []; let index = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const at = index++
      if (!(at in values)) values[at] = initial
      return [values[at], (next) => { values[at] = typeof next === 'function' ? next(values[at]) : next }]
    },
    useRef(initial) { const at = index++; return (values[at] ??= { current: initial }) },
    useEffect() {},
  }
  const { exports } = await loadBundle(react)

  // The library block, re-read from the production store after every save (as load() does).
  const savedDefinitions = []
  const block = async () => {
    const listed = await store.list()
    return {
      bundled: BUNDLED_PRESETS.map((preset) => ({ ...preset, fields: { ...preset.fields } })),
      user: listed.user, userRevision: listed.revision, defaultPresetId: 'builtin-progressive',
      applied: null, overlay: {}, overlayRevision: 0, automaticDefault: false,
    }
  }
  let props = {
    presets: await block(), busy: false, applyingId: null, messageOf: (error) => String(error.message || error),
    onApply: async () => {}, onRestoreAutomatic: async () => {}, onDelete: async () => {},
    onSave: async (definition) => {
      // UI output enters the production validation/store path unchanged.
      validatePresetDefinition(definition)
      await store.save({ definition, expectedRevision: (await store.list()).revision })
      savedDefinitions.push(definition)
      props = Object.assign({}, props, { presets: await block() })
    },
  }
  const render = () => { index = 0; return exports.LearningPresets(props) }
  const findAction = (tree, action) => findNode(tree, (node) => node.props && node.props['data-professor-action'] === action)

  // 1. Copy a built-in: the generated id keeps validity and drops the reserved builtin- prefix.
  await findAction(render(), 'copy-preset-builtin-progressive').props.onClick()
  let tree = render()
  const idInput = findNode(tree, (node) => node.props && node.props.id === 'professor-preset-id')
  const generated = idInput.props.value
  assert.equal(generated, 'progressive', 'the reserved prefix is stripped to derive a plain user id')
  assert.equal(/^builtin-/.test(generated), false, 'built-in protection: the copy is not a reserved id')
  validatePresetDefinition({ id: generated, name: '循序讲解', description: '先讲清概念，再给例子，最后配一小段练习，按你的节奏逐步深入。',
    fields: { ...BUNDLED_PRESETS[0].fields }, version: 1 })

  // 2. Save with the generated id retained — production validation and store accept it.
  await findAction(render(), 'save-preset').props.onClick()
  assert.equal(savedDefinitions.length, 1)
  assert.equal(savedDefinitions[0].id, generated, 'the generated id is retained through save')
  const listed = await store.list()
  assert.equal(listed.user.length, 1)
  assert.equal(listed.user[0].id, generated)
  assert.deepEqual(JSON.parse(JSON.stringify(BUNDLED_PRESETS)), builtinSnapshot, 'the built-in definition is unchanged')
  assert.ok(BUNDLED_PRESETS.every((preset) => Object.isFrozen(preset)), 'built-ins stay immutable')

  // 3. Repeated copy must not collide with the first one.
  await findAction(render(), 'copy-preset-builtin-progressive').props.onClick()
  tree = render()
  const secondId = findNode(tree, (node) => node.props && node.props.id === 'professor-preset-id').props.value
  assert.equal(secondId, 'progressive-copy', 'a repeated copy advances to a free id instead of overwriting')
  assert.notEqual(secondId, generated)
  await findAction(render(), 'save-preset').props.onClick()
  assert.equal((await store.list()).user.length, 2)

  // 4. Collisions with existing user ids are avoided at generation, and a hand-edited collision
  //    is refused rather than silently overwriting another preset.
  props = Object.assign({}, props, {
    presets: Object.assign(await block(), { user: [...(await block()).user, { id: 'progressive-copy-2', name: '占位', description: '已占用。', fields: {}, version: 1 }] }),
  })
  await findAction(render(), 'copy-preset-builtin-progressive').props.onClick()
  tree = render()
  const thirdId = findNode(tree, (node) => node.props && node.props.id === 'professor-preset-id').props.value
  assert.equal(thirdId, 'progressive-copy-3', 'taken ids are skipped')

  const savesBefore = savedDefinitions.length
  const idField = findNode(render(), (node) => node.props && node.props.id === 'professor-preset-id')
  idField.props.onChange({ target: { value: 'progressive-copy-2' } })
  tree = render()
  await findAction(tree, 'save-preset').props.onClick()
  tree = render()
  const alert = findNode(tree, (node) => node.props && node.props.role === 'alert')
  assert.ok(alert && String(alert.props.children).includes('已被占用'), 'the collision is reported, not executed')
  assert.equal(savedDefinitions.length, savesBefore, 'no save request was sent for the colliding id')

  await storage.close()
})

test('the launcher course dropdown shows codes, keeps canonical ids as values, and distinguishes duplicates', async () => {
  const courses = [
    { course_id: 'csc3001', course_code: 'CSC3001', display_name: '非常非常长的计算机导论课程名称', term: 'Year1Term1', status: 'active' },
    { course_id: 'legacy-1', course_code: '', display_name: 'Legacy Course Name', term: null, status: 'active' },
    { course_id: 'csc3200-2025f', course_code: 'CSC3200', display_name: 'DSA Fall', term: 'Year2Term1', status: 'active' },
    { course_id: 'csc3200-2026s', course_code: 'CSC3200', display_name: 'DSA Spring', term: 'Year2Term2', status: 'active' },
    { course_id: 'sta-dup-a', course_code: 'STA2001', display_name: 'Prob A', term: 'SameTerm', status: 'active' },
    { course_id: 'sta-dup-b', course_code: 'sta2001', display_name: 'Prob B', term: 'SameTerm', status: 'active' },
    { course_id: 'mat-no-term-1', course_code: 'MAT100', display_name: 'Calc 1', term: '', status: 'active' },
    { course_id: 'mat-no-term-2', course_code: 'MAT100', display_name: 'Calc 2', term: null, status: 'active' },
  ]
  const remoteImpl = { home: { ok: true, courses, recent: [], continue: null, connection: { connected: true, folder: '/academic' } } }
  const values = []; let index = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const at = index++
      if (!(at in values)) values[at] = at === 0
        ? { status: 'ready', error: null, data: remoteImpl.home } : initial
      return [values[at], (next) => { values[at] = typeof next === 'function' ? next(values[at]) : next }]
    },
    useRef(initial) { const at = index++; return (values[at] ??= { current: initial }) },
    useEffect() {},
  }
  const { exports } = await loadBundle(react)
  const { ctx, record } = fakeClientContext(remoteImpl)
  const dispose = await exports.apply(ctx)
  const render = () => { index = 0; const element = record.panels[0].component(); return element.type(element.props) }
  const select = findNode(render(), (node) => node.props && node.props.id === 'professor-home-course')
  assert.ok(select, 'the launcher course dropdown renders')
  const options = [select.props.children].flat(Infinity)
  const labelOf = (value) => Array.isArray(value) ? value.join('') : value
  const byValue = Object.fromEntries(options.map((option) => [option.props.value, labelOf(option.props.children)]))
  assert.equal(byValue[''], '不指定课程')
  assert.equal(byValue.csc3001, 'CSC3001', 'the code is the label, not the long display name')
  assert.equal(byValue['legacy-1'], 'legacy-1', 'a legacy course without a code falls back to its id, never the name')
  assert.equal(byValue['csc3200-2025f'], 'CSC3200 · Year2Term1', 'duplicate codes are disambiguated with the term')
  assert.equal(byValue['csc3200-2026s'], 'CSC3200 · Year2Term2')
  assert.equal(byValue['sta-dup-a'], 'STA2001 · sta-dup-a', 'duplicate code+term falls back to the stable id discriminator')
  assert.equal(byValue['sta-dup-b'], 'sta2001 · sta-dup-b', 'case-insensitive code duplicates are distinguished too')
  assert.equal(byValue['mat-no-term-1'], 'MAT100 · mat-no-term-1', 'missing terms use the id discriminator')
  assert.equal(byValue['mat-no-term-2'], 'MAT100 · mat-no-term-2')
  // Values are always the immutable ids — the editable code never rides along as a value.
  for (const option of options) assert.ok(option.props.value === '' || courses.some((row) => row.course_id === option.props.value))
  await dispose()
})

test('the configured-course editor saves the course code and retains drafts on failure', async () => {
  const values = [], calls = []; let index = 0
  let failNext = true
  let serverRows = [{ course_id: 'csc3200', course_code: 'CSC3200', display_name: 'DSA', term: 'Year2Term1', active: true }]
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const at = index++; if (!(at in values)) values[at] = initial; return [values[at], value => { values[at] = typeof value === 'function' ? value(values[at]) : value }] },
    useRef(initial) { const at = index++; return values[at] ??= { current: initial } }, useEffect() {},
  }
  const { exports } = await loadBundle(react)
  const props = { api: {
    home: async () => ({ courses: [], recent: [], connection: { connected: true, folder: '/academic' } }),
    workspaceCommand: async (request) => {
      calls.push(request)
      if (request.action === 'courses') return { courseToken: 'tok-1', courses: serverRows }
      if (request.action === 'manageCourse') {
        if (failNext) { failNext = false; throw new Error('storage write refused') }
        serverRows = serverRows.map((entry) => entry.course_id === request.args.courseId
          // The production registry trims and stores exactly; the mock mirrors that contract.
          ? Object.assign({}, entry, { course_code: request.args.courseCode === undefined ? entry.course_code : String(request.args.courseCode).trim() }) : entry)
        return { changed: [request.args.courseId], problems: [] }
      }
      return {}
    },
  } }
  function node(predicate) {
    index = 0; let found
    const walk = value => { if (Array.isArray(value)) return value.forEach(walk); if (!value || typeof value !== 'object') return; if (predicate(value)) found = value; walk(value.props?.children) }
    walk(exports.ProfessorWorkspaceSettings(props)); return found
  }
  const action = name => node(value => value.props['data-professor-action'] === name)
  values[0] = { connection: { connected: true, folder: '/academic' }, courses: [], recent: [] }
  values[1] = { sessionId: 'owned', folder: '/academic' }

  await action('load-managed-courses').props.onClick()
  const codeInput = node(value => value.props.id === 'professor-course-code-csc3200')
  assert.ok(codeInput, 'the editor offers a 课程编号 field')
  assert.equal(codeInput.props.value, 'CSC3200')
  codeInput.props.onChange({ target: { value: ' CS-3200 ' } })

  // Failed save: the draft stays in the field verbatim and nothing persists.
  await action('save-course-csc3200').props.onClick()
  const draft = node(value => value.props.id === 'professor-course-code-csc3200')
  assert.equal(draft.props.value, ' CS-3200 ', 'a failed save retains the user\'s draft verbatim')
  assert.equal(serverRows[0].course_code, 'CSC3200', 'and persists nothing')

  // The retry succeeds and carries the field through the managed update command.
  await action('save-course-csc3200').props.onClick()
  const update = calls.filter(call => call.action === 'manageCourse').at(-1)
  assert.equal(update.args.courseCode, ' CS-3200 ', 'the field reaches the managed update command')
  const saved = node(value => value.props.id === 'professor-course-code-csc3200')
  assert.equal(saved.props.value, 'CS-3200', 'the refreshed row shows the trimmed, saved code')

  // The launcher label follows the updated registry value.
  const pValues = []; let pIndex = 0
  const react2 = {
    createElement: react.createElement,
    useState(initial) { const at = pIndex++; if (!(at in pValues)) pValues[at] = at === 0 ? { status: 'ready', error: null, data: { courses: [{ course_id: 'csc3200', course_code: 'CS-3200', display_name: 'DSA', term: 'Year2Term1', status: 'active' }], recent: [], continue: null, connection: { connected: true, folder: '/academic' } } } : initial; return [pValues[at], value => { pValues[at] = typeof value === 'function' ? value(pValues[at]) : value }] },
    useRef(initial) { const at = pIndex++; return pValues[at] ??= { current: initial } }, useEffect() {},
  }
  const second = await loadBundle(react2)
  const { ctx: ctx2, record: record2 } = fakeClientContext()
  await second.exports.apply(ctx2)
  pIndex = 0
  const element = record2.panels[0].component()
  const homeTree = element.type(element.props)
  const select = findNode(homeTree, (node2) => node2.props && node2.props.id === 'professor-home-course')
  const option = [select.props.children].flat(Infinity).find(entry => entry.props.value === 'csc3200')
  assert.equal(Array.isArray(option.props.children) ? option.props.children.join('') : option.props.children, 'CS-3200', 'the launcher label updates after a successful save')
})
