import test from 'node:test'
import assert from 'node:assert/strict'
import { createLaunchHost } from '../src/plugin.js'

test('native launch uses the session controller that installs model selection before publishing', async () => {
  const requests = []
  const agent = { session: { id: 'professor-model', header: { cwd: '/tmp/course' } } }
  const services = {
    agents: { create: async () => { throw new Error('must use the controller') } },
    sessionQuery: { listSessions: async () => [] },
    workspaceRegistry: { resolveByPath: async () => ({ id: 'workspace-course', path: '/tmp/course' }) },
    sessionController: {
      create: async request => { requests.push(request); return { sessionId: request.sessionId } },
      resolveAgent: async () => ({ agent }),
    },
  }
  const host = createLaunchHost({ ctx: { get: name => services[name] } })
  assert.equal((await host.createSession({ sessionId: 'professor-model', cwd: '/tmp/course' })).agent, agent)
  assert.deepEqual(requests, [{ sessionId: 'professor-model', workspaceId: 'workspace-course', agentPreset: 'professor' }])
})

test('persisted native headers remain discoverable after restart and deletion is fresh', async () => {
  let rows = [{ header: { id: 'professor-old' } }]
  const host = createLaunchHost({ ctx: { get: name => name === 'sessionQuery' ? { listSessions: async () => rows } : undefined } })
  assert.equal(await host.hasSession('professor-old'), true)
  rows = []
  assert.equal(await host.hasSession('professor-old'), false)
})

test('launch uses native cwd option and resumes a persisted ID instead of recreating it', async () => {
  const calls = []
  const services = {
    agents: { create: async options => { calls.push(['create', options]); return {} }, resume: async options => { calls.push(['resume', options]); return {} } },
    sessionController: { resolveAgent: async id => { calls.push(['resume', id]); return { agent: {} } } },
    sessionQuery: { listSessions: async () => [{ header: { id: 'professor-old' } }] },
    workspaceRegistry: { resolveByPath: async () => ({ path: '/tmp/course', attachSession: async () => {} }) },
  }
  const host = createLaunchHost({ ctx: { get: name => services[name] } })
  await host.createSession({ sessionId: 'professor-new', cwd: '/tmp/course' })
  await host.createSession({ sessionId: 'professor-old', cwd: '/tmp/course' })
  assert.deepEqual(calls, [['create', { sessionId: 'professor-new', meta: { cwd: '/tmp/course' } }], ['resume', 'professor-old']])
})

test('a newly launched native session is attached to its actual workspace', async () => {
  const attached = []
  const services = {
    agents: { create: async () => ({ agent: {} }) },
    sessionQuery: { listSessions: async () => [] },
    workspaceRegistry: { resolveByPath: async () => ({ path: '/tmp/course', attachSession: async id => attached.push(id) }) },
  }
  const host = createLaunchHost({ ctx: { get: name => services[name] } })
  await host.createSession({ sessionId: 'professor-new', cwd: '/tmp/course' })
  assert.deepEqual(attached, ['professor-new'])
})

test('archiving a native conversation calls workspaceRegistry with stopActivity: false and accepts an undefined return', async () => {
  const calls = []
  const services = {
    workspaceRegistry: {
      resolveByPath: async () => ({ id: 'w', path: '/tmp/course' }),
      async archiveSession(sessionId, options) {
        calls.push([sessionId, options])
        return undefined // the installed host resolves undefined on success
      },
    },
  }
  const host = createLaunchHost({ ctx: { get: name => services[name] } })
  assert.equal(await host.archiveSession('professor-r-abc123'), undefined)
  assert.deepEqual(calls, [['professor-r-abc123', { stopActivity: false }]])
})

test('a host without the workspace archive capability reports an explicit coded error', async () => {
  const services = { workspaceRegistry: { resolveByPath: async () => ({ id: 'w', path: '/tmp/course' }) } }
  const host = createLaunchHost({ ctx: { get: name => services[name] } })
  await assert.rejects(host.archiveSession('professor-r-abc123'), { code: 'PROFESSOR_ARCHIVE_UNAVAILABLE' })
  const withoutRegistry = createLaunchHost({ ctx: { get: () => undefined } })
  await assert.rejects(withoutRegistry.archiveSession('professor-r-abc123'), { code: 'PROFESSOR_ARCHIVE_UNAVAILABLE' })
})

test('host archive refusals propagate with their workspace error names intact', async () => {
  const services = {
    workspaceRegistry: {
      async archiveSession() {
        const error = new Error('cannot archive session: the session is active (agent-run)')
        error.name = 'WorkspaceActiveSessionError'
        throw error
      },
    },
  }
  const host = createLaunchHost({ ctx: { get: name => services[name] } })
  await assert.rejects(host.archiveSession('professor-r-abc123'), { name: 'WorkspaceActiveSessionError' })
})
