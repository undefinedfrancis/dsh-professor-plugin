import assert from 'node:assert/strict'
import test from 'node:test'
import { professorRemoteDescriptors, registerProfessorRemote } from '../src/app/remote.js'

test('workspace command endpoint has a bounded strict envelope', () => {
  const descriptor = professorRemoteDescriptors().find(row => row.method === 'workspaceCommand')
  assert.ok(descriptor)
  const parse = descriptor.parameters[0].codec.create().parse
  assert.throws(() => parse({ sessionId: 'owned', action: 'shell', args: {} }))
  assert.throws(() => parse({ sessionId: 'owned', action: 'discover', args: {}, namespace: 'other' }))
})

test('memory control remote refuses missing revision and unrelated fields', () => {
  const descriptor = professorRemoteDescriptors().find(row => row.method === 'setMemoryEnabled')
  assert.ok(descriptor)
  const parse = descriptor.parameters[0].codec.create().parse
  assert.deepEqual(parse({ enabled: false, expectedRevision: null }), { enabled: false, expectedRevision: null })
  for (const args of [{ enabled: false }, { enabled: 'false', expectedRevision: 0 }, { enabled: false, expectedRevision: 0, courseId: 'csc' }]) assert.throws(() => parse(args))
})

test('the clear endpoint requires exactly one session id and explicit confirmation', () => {
  const descriptor = professorRemoteDescriptors().find(row => row.method === 'clearSession')
  assert.ok(descriptor, 'the clearSession endpoint must be published')
  assert.equal(descriptor.id, 'dsh-professor-spike#clear/archive')
  assert.equal(descriptor.result.mode, 'strict')
  const parse = descriptor.parameters[0].codec.create().parse
  assert.deepEqual(parse({ sessionId: 'professor-r-abc123', confirmed: true }), { sessionId: 'professor-r-abc123', confirmed: true })
  for (const args of [
    { sessionId: 'professor-r-abc123' },
    { sessionId: 'professor-r-abc123', confirmed: false },
    { sessionId: 'professor-r-abc123', confirmed: 'true' },
    { sessionId: '  ', confirmed: true },
    { sessionId: '', confirmed: true },
    { sessionId: 42, confirmed: true },
    { sessionId: 'x'.repeat(129), confirmed: true },
    { sessionId: 'professor-r-abc123', confirmed: true, force: true },
    { sessionId: 'professor-r-abc123', confirmed: true, path: '/etc/passwd' },
  ]) assert.throws(() => parse(args), TypeError, JSON.stringify(args))
})

test('the clear handler delegates to the injected home service only', async () => {
  const received = []
  const registration = registerProfessorRemote({
    scope: { provide() {}, get: () => ({ register: () => () => {} }) },
    home: { clearSession: async (request) => { received.push(request); return { ok: true, sessionId: request.sessionId, archived: true } } },
    views: {},
  })
  assert.deepEqual(await registration.service.clearSession({ sessionId: 'professor-r-abc123', confirmed: true }),
    { ok: true, sessionId: 'professor-r-abc123', archived: true })
  assert.deepEqual(received, [{ sessionId: 'professor-r-abc123', confirmed: true }])
})

test('view and settings writes have strict codecs rejecting arbitrary paths and selectors', () => {
  const descriptors = professorRemoteDescriptors()
  for (const method of ['course', 'settings', 'saveCustomization']) {
    const descriptor = descriptors.find(row => row.method === method)
    assert.ok(descriptor, `missing ${method}`)
    assert.equal(descriptor.parameters[0].codec.mode, 'strict')
    const parse = descriptor.parameters[0].codec.create().parse
    assert.throws(() => parse({ path: '/arbitrary', namespace: 'other' }))
    assert.throws(() => parse({ courseId: 42 }))
  }
})

test('registered view handlers delegate to the existing injected service without a new namespace', async () => {
  const calls = []
  const registration = registerProfessorRemote({ scope: { provide() {}, get: () => ({ register: () => () => calls.push('withdraw') }) },
    home: {}, views: { course: async args => ({ course: args }), settings: async () => ({ memory: { enabled: true } }),
      saveCustomization: async args => ({ revision: args.expectedRevision + 1 }) } })
  assert.deepEqual(await registration.service.course({ courseId: 'csc' }), { course: { courseId: 'csc' } })
  assert.equal((await registration.service.saveCustomization({ expectedRevision: 1 })).revision, 2)
  assert.equal(registration.namespace, 'professorHome')
  registration.withdraw()
  assert.deepEqual(calls, ['withdraw'])
})

test('bulk clear endpoints accept only snapshot tokens and operation handles', () => {
  const descriptors = professorRemoteDescriptors()
  const snapshot = descriptors.find(row => row.method === 'clearAllSnapshot')
  assert.ok(snapshot)
  const parseSnapshot = snapshot.parameters[0].codec.create().parse
  assert.deepEqual(parseSnapshot({}), {})
  for (const args of [{ token: 'x' }, { ids: [] }, null, []]) assert.throws(() => parseSnapshot(args), TypeError)

  const start = descriptors.find(row => row.method === 'clearAllStart')
  const parseStart = start.parameters[0].codec.create().parse
  assert.deepEqual(parseStart({ token: 'clr-abc' }), { token: 'clr-abc' })
  for (const args of [{}, { token: '' }, { token: 'x'.repeat(129) }, { token: 'a', ids: ['s1'] }, { sessionIds: ['s1'] }]) {
    assert.throws(() => parseStart(args), TypeError, JSON.stringify(args))
  }

  const next = descriptors.find(row => row.method === 'clearAllContinue')
  const parseNext = next.parameters[0].codec.create().parse
  assert.deepEqual(parseNext({ operationId: 'op-abc' }), { operationId: 'op-abc' })
  for (const args of [{}, { operationId: '' }, { operationId: 'x'.repeat(129) }, { operationId: 'op-abc', cursor: 3 }]) {
    assert.throws(() => parseNext(args), TypeError, JSON.stringify(args))
  }
})

test('preset endpoints are strict: no arbitrary fields, revisions required, delete confirmed', () => {
  const descriptors = professorRemoteDescriptors()
  const parseOf = (method) => descriptors.find(row => row.method === method).parameters[0].codec.create().parse

  const parseLibrary = parseOf('presetLibrary')
  assert.deepEqual(parseLibrary({ skill: 'professor-study' }), { skill: 'professor-study' })
  assert.throws(() => parseLibrary({ path: '/etc' }), TypeError)

  const parseSave = parseOf('presetSave')
  const definition = { id: 'mine-1', name: 'N', description: 'D', fields: { teachingDepth: 'x' }, version: 1 }
  assert.deepEqual(parseSave({ definition, expectedRevision: 0 }).definition.id, 'mine-1')
  for (const args of [
    { definition },
    { definition, expectedRevision: -1 },
    { definition: { ...definition, id: 'Bad' }, expectedRevision: 0 },
    { definition: { ...definition, name: 'n'.repeat(81) }, expectedRevision: 0 },
    { definition: { ...definition, description: 'd'.repeat(241) }, expectedRevision: 0 },
    { definition: { ...definition, version: 0 }, expectedRevision: 0 },
    { definition: { ...definition, provenance: 'p'.repeat(241) }, expectedRevision: 0 },
    { definition: { ...definition, extra: 1 }, expectedRevision: 0 },
  ]) assert.throws(() => parseSave(args), TypeError, JSON.stringify(args).slice(0, 60))

  const parseDelete = parseOf('presetDelete')
  assert.deepEqual(parseDelete({ presetId: 'mine-1', expectedRevision: 3, confirmed: true }).presetId, 'mine-1')
  for (const args of [
    { presetId: 'mine-1', expectedRevision: 3 },
    { presetId: 'mine-1', expectedRevision: 3, confirmed: false },
    { presetId: 'builtin-progressive', expectedRevision: 3, confirmed: true, force: true },
  ]) assert.throws(() => parseDelete(args), TypeError)

  const parseApply = parseOf('presetApply')
  assert.deepEqual(parseApply({ presetId: 'builtin-progressive', expectedRevision: 2 }), { presetId: 'builtin-progressive', expectedRevision: 2 })
  for (const args of [
    { presetId: 'builtin-progressive' },
    { presetId: 'builtin-progressive', expectedRevision: 2, fields: {} },
    { presetId: 'X', expectedRevision: 2 },
  ]) assert.throws(() => parseApply(args), TypeError)
})

test('preset and bulk handlers delegate to the injected services without new namespaces', async () => {
  const calls = []
  const registration = registerProfessorRemote({
    scope: { provide() {}, get: () => ({ register: () => () => {} }) },
    home: {
      clearAllSnapshot: async () => ({ ok: true, token: 'clr-1', count: 2, previews: [], expiresAt: 0 }),
      clearAllStart: async (request) => ({ ok: true, operationId: 'op-1', done: true, counts: { cleared: 1, skipped: 0, failed: 0, remaining: 0 }, outcomes: [] }),
      clearAllContinue: async () => { throw new Error('must not be called for a finished run') },
    },
    views: {
      presetLibrary: async (request) => ({ bundled: [], user: [], userRevision: 0, applied: null }),
      presetSave: async (request) => { calls.push(['save', request]); return { revision: 1 } },
      presetDelete: async (request) => { calls.push(['delete', request]); return { revision: 2 } },
      presetApply: async (request) => { calls.push(['apply', request]); return { overlayRevision: 1, applied: null } },
    },
  })
  assert.equal(registration.namespace, 'professorHome')
  assert.equal((await registration.service.clearAllStart({ token: 'clr-1' })).operationId, 'op-1')
  await registration.service.presetSave({ definition: { id: 'm-1', name: 'n', description: 'd', fields: {}, version: 1 }, expectedRevision: 0 })
  await registration.service.presetDelete({ presetId: 'm-1', expectedRevision: 1, confirmed: true })
  await registration.service.presetApply({ presetId: 'builtin-progressive', expectedRevision: 0 })
  assert.deepEqual(calls.map(entry => entry[0]), ['save', 'delete', 'apply'])
  assert.equal(registration.namespace, 'professorHome')
})
