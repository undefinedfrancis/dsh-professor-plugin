import assert from 'node:assert/strict'
import test from 'node:test'
import { createProfessorCommands } from '../src/app/commands.js'

function fixture(overrides = {}) {
  const calls = []
  const agent = { session: { id: 'owned', header: { cwd: '/academic' } } }
  const proposal = { root: '/academic', candidates: [{ relative_path: 'CSC3200' }] }
  const commands = createProfessorCommands({
    registry: { get: async id => id === 'owned' ? { status: 'ready' } : null },
    resolveAgent: async () => agent, composedPreset: async () => 'professor',
    readConnectionRevision: async () => 2,
    execute: async args => { calls.push(args); return { content: [{ text: JSON.stringify(args.name.endsWith('discover') ? { ok: true, proposal } : { ok: true, applied: true }) }] } },
    ...overrides,
  })
  return { commands, calls, agent }
}

test('commands reject arbitrary actions and unowned sessions before executing tools', async () => {
  const { commands, calls } = fixture()
  await assert.rejects(commands.run({ sessionId: 'owned', action: 'shell', args: {} }), { code: 'PROFESSOR_COMMAND_INVALID' })
  await assert.rejects(commands.run({ sessionId: 'coding', action: 'discover', args: {} }), { code: 'PROFESSOR_COMMAND_SESSION' })
  await assert.rejects(commands.run({ sessionId: 'owned', action: 'discover', args: { command: 'anything' } }), { code: 'PROFESSOR_COMMAND_INVALID' })
  assert.equal(calls.length, 0)
})

test('course management uses a consumed server-held snapshot, never browser paths or ids outside it', async () => {
  const calls = []
  const { commands } = fixture({ execute: async request => {
    calls.push(request)
    const payload = request.name === 'professor_course_list' ? { projectPresent: true, projectRoot: '/academic', configDigest: 'a'.repeat(64), courses: [{ course_id: 'csc', course_code: 'CSC', display_name: 'Course', term: 'T', active: true }] } : { changed: ['csc'], problems: [], warnings: [] }
    return { content: [{ text: JSON.stringify(payload) }] }
  } })
  const observed = await commands.run({ sessionId: 'owned', action: 'courses', args: {} })
  assert.equal(typeof observed.courseToken, 'string')
  await assert.rejects(commands.run({ sessionId: 'owned', action: 'manageCourse', args: { courseToken: observed.courseToken, courseId: 'other', operation: 'archive' } }), { code: 'PROFESSOR_COMMAND_INVALID' })
  await commands.run({ sessionId: 'owned', action: 'manageCourse', args: { courseToken: observed.courseToken, courseId: 'csc', operation: 'update', displayName: 'Edited', term: 'T2' } })
  assert.equal(calls[1].arguments.expected_project_root, '/academic')
  assert.equal(calls[1].arguments.expected_config_digest, 'a'.repeat(64))
  assert.equal(calls[1].arguments.course_id, 'csc')
  await assert.rejects(commands.run({ sessionId: 'owned', action: 'manageCourse', args: { courseToken: observed.courseToken, courseId: 'csc', operation: 'archive' } }), { code: 'PROFESSOR_COMMAND_PROPOSAL' })
})

test('confirmation uses a server-owned proposal tied to the original native session', async () => {
  const { commands, calls, agent } = fixture()
  const found = await commands.run({ sessionId: 'owned', action: 'discover', args: {} })
  assert.equal(typeof found.proposalToken, 'string')
  found.proposal.root = '/tampered'
  await assert.rejects(commands.run({ sessionId: 'owned', action: 'confirm', args: { proposal: found.proposal } }), { code: 'PROFESSOR_COMMAND_INVALID' })
  await commands.run({ sessionId: 'owned', action: 'confirm', args: { proposalToken: found.proposalToken, selections: [{ relative_path: 'CSC3200', action: 'include' }] } })
  const dispatched = calls[1]
  assert.equal(dispatched.name, 'professor_workspace_confirm')
  assert.equal(dispatched.agent, agent)
  assert.equal(dispatched.arguments.proposal.root, '/academic')
  assert.equal(dispatched.arguments.expected_revision, 2)
  await assert.rejects(commands.run({ sessionId: 'owned', action: 'confirm', args: { proposalToken: found.proposalToken, selections: [] } }), { code: 'PROFESSOR_COMMAND_PROPOSAL' })
})

test('course snapshots reject changed connections, expiry, browser paths and editable ids', async () => {
  let time = 0, revision = 2
  const { commands, calls } = fixture({ now: () => time, readConnectionRevision: async () => revision,
    execute: async request => { calls.push(request); return { content: [{ text: JSON.stringify({ projectPresent: true, projectRoot: '/academic', configDigest: 'b'.repeat(64), courses: [{ course_id: 'csc' }] }) }] } } })
  const observed = await commands.run({ sessionId: 'owned', action: 'courses', args: {} })
  const input = { sessionId: 'owned', action: 'manageCourse', args: { courseToken: observed.courseToken, courseId: 'csc', operation: 'archive' } }
  for (const forbidden of ['source_path', 'course_id', 'expected_project_root', 'course_code']) {
    await assert.rejects(commands.run({ ...input, args: { ...input.args, [forbidden]: '/tamper' } }), { code: 'PROFESSOR_COMMAND_INVALID' })
  }
  revision = 3
  await assert.rejects(commands.run(input), { code: 'PROFESSOR_COMMAND_PROPOSAL' })
  revision = 2; time = 16 * 60 * 1000
  await assert.rejects(commands.run(input), { code: 'PROFESSOR_COMMAND_PROPOSAL' })
  assert.equal(calls.length, 1)
})

test('course deletion requires an explicit confirmation on the same guarded snapshot', async () => {
  const calls = []
  const { commands } = fixture({ execute: async request => {
    calls.push(request)
    const payload = request.name === 'professor_course_list'
      ? { projectPresent: true, projectRoot: '/academic', configDigest: 'c'.repeat(64), courses: [{ course_id: 'csc' }] }
      : { changed: ['csc'], problems: [], warnings: [] }
    return { content: [{ text: JSON.stringify(payload) }] }
  } })
  const observed = await commands.run({ sessionId: 'owned', action: 'courses', args: {} })
  const base = { courseToken: observed.courseToken, courseId: 'csc' }

  await assert.rejects(commands.run({ sessionId: 'owned', action: 'manageCourse', args: { ...base, operation: 'delete' } }), { code: 'PROFESSOR_COMMAND_INVALID' })
  await assert.rejects(commands.run({ sessionId: 'owned', action: 'manageCourse', args: { ...base, operation: 'delete', confirmDelete: 'yes' } }), { code: 'PROFESSOR_COMMAND_INVALID' })
  assert.equal(calls.length, 1, 'a refused deletion never reaches the native tool')

  await commands.run({ sessionId: 'owned', action: 'manageCourse', args: { ...base, operation: 'delete', confirmDelete: true } })
  const dispatched = calls[1]
  assert.equal(dispatched.name, 'professor_course_manage')
  assert.equal(dispatched.arguments.action, 'delete')
  assert.equal(dispatched.arguments.confirm_delete, true)
  assert.equal(dispatched.arguments.expected_config_digest, 'c'.repeat(64))
  assert.equal(dispatched.arguments.expected_project_root, '/academic')
  assert.equal(dispatched.arguments.course_id, 'csc')
  assert.equal(dispatched.arguments.source_path, undefined, 'the browser never supplies a path')

  await assert.rejects(commands.run({ sessionId: 'owned', action: 'manageCourse', args: { ...base, operation: 'archive', confirmDelete: true } }), { code: 'PROFESSOR_COMMAND_INVALID' })
})

test('preset switches refuse even a registered ready session', async () => {
  const commands = createProfessorCommands({ registry: { get: async () => ({ status: 'ready' }) }, resolveAgent: async () => ({ session: { id: 'owned' } }), composedPreset: async () => 'coding', execute: () => { throw new Error('must not dispatch') } })
  await assert.rejects(commands.run({ sessionId: 'owned', action: 'diagnostics', args: {} }), { code: 'PROFESSOR_COMMAND_SESSION' })
})

test('unknown selections refuse and a disposed command service cannot execute', async () => {
  const { commands, calls } = fixture()
  const found = await commands.run({ sessionId: 'owned', action: 'discover', args: {} })
  await assert.rejects(commands.run({ sessionId: 'owned', action: 'confirm', args: { proposalToken: found.proposalToken, selections: [{ relative_path: '../outside', action: 'include' }] } }), { code: 'PROFESSOR_COMMAND_INVALID' })
  commands.dispose()
  await assert.rejects(commands.run({ sessionId: 'owned', action: 'discover', args: {} }), { code: 'PROFESSOR_COMMAND_UNAVAILABLE' })
  assert.equal(calls.length, 1)
})

test('expired proposals and changed connection revisions never dispatch confirmation', async () => {
  let time = 0, revision = 0
  const { commands, calls } = fixture({ now: () => time, readConnectionRevision: async () => revision })
  const found = await commands.run({ sessionId: 'owned', action: 'discover', args: {} })
  revision = 1
  await assert.rejects(commands.run({ sessionId: 'owned', action: 'confirm', args: { proposalToken: found.proposalToken, selections: [] } }), { code: 'PROFESSOR_COMMAND_PROPOSAL' })
  revision = 0; time = 16 * 60 * 1000
  await assert.rejects(commands.run({ sessionId: 'owned', action: 'confirm', args: { proposalToken: found.proposalToken, selections: [] } }), { code: 'PROFESSOR_COMMAND_PROPOSAL' })
  assert.equal(calls.length, 1)
})

test('proposal cache is bounded and evicts the oldest proposal', async () => {
  const { commands } = fixture()
  const first = await commands.run({ sessionId: 'owned', action: 'discover', args: {} })
  let last
  for (let i = 0; i < 20; i++) last = await commands.run({ sessionId: 'owned', action: 'discover', args: {} })
  await assert.rejects(commands.run({ sessionId: 'owned', action: 'confirm', args: { proposalToken: first.proposalToken, selections: [] } }), { code: 'PROFESSOR_COMMAND_PROPOSAL' })
  assert.equal((await commands.run({ sessionId: 'owned', action: 'confirm', args: { proposalToken: last.proposalToken, selections: [] } })).applied, true)
})

test('tool pipeline failure preserves refusal and does not poison subsequent commands', async () => {
  let fail = true
  const { commands } = fixture({ execute: async () => fail ? { isError: true, content: [{ text: 'permission denied' }] } : { content: [{ text: '{"ok":true}' }] } })
  await assert.rejects(commands.run({ sessionId: 'owned', action: 'diagnostics', args: {} }), { code: 'PROFESSOR_COMMAND_TOOL' })
  fail = false
  assert.equal((await commands.run({ sessionId: 'owned', action: 'diagnostics', args: {} })).ok, true)
})

test('disposal while waiting for session ownership prevents later native writes', async () => {
  let release, entered
  const blocked = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const { commands, calls } = fixture({ registry: { get: async () => { entered(); await blocked; return { status: 'ready' } } } })
  const work = commands.run({ sessionId: 'owned', action: 'rebuild', args: {} })
  await started
  commands.dispose(); release()
  await assert.rejects(work, { code: 'PROFESSOR_COMMAND_UNAVAILABLE' })
  assert.equal(calls.length, 0)
})

test('disposal aborts already running native tool work', async () => {
  let signal, entered
  const started = new Promise(resolve => { entered = resolve })
  const { commands } = fixture({ execute: args => new Promise(resolve => {
    signal = args.signal; entered()
    signal.addEventListener('abort', () => resolve({ content: [{ text: '{"ok":false}' }] }), { once: true })
  }) })
  const work = commands.run({ sessionId: 'owned', action: 'rebuild', args: {} })
  await started; commands.dispose()
  assert.equal(signal.aborted, true)
  await assert.rejects(work, { code: 'PROFESSOR_COMMAND_UNAVAILABLE' })
})
