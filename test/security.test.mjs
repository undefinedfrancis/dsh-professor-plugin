/**
 * Filesystem gateway and boundary tests — §11 "Path and sandbox behavior".
 *
 * Every fixture lives in its own temporary directory; the real Personal-Agent workspace and real
 * course material are never touched.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createFsGateway } from '../src/fs/gateway.js'
import { createPathPolicy } from '../src/paths/policy.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

async function scenario(options = {}) {
  const home = await makeHome()
  const project = path.join(home, 'courses', 'term')
  await fs.mkdir(path.join(project, '01_Lectures'), { recursive: true })
  await fs.mkdir(path.join(project, '.professor'), { recursive: true })
  await writeFixture(home, 'courses/term/01_Lectures/lecture-01.pdf', 'original material')

  const fake = createFakeContext({ home, mode: options.mode ?? 'workspace-write' })
  const gateway = createFsGateway({ ctx: fake.ctx, logger: { warn: (message) => fake.logs.warn.push(message) } })
  const writePolicy = createPathPolicy({ roots: [path.join(project, '.professor')], label: 'write' })
  const readPolicy = createPathPolicy({ roots: [project], label: 'read' })

  return {
    home, project, fake, gateway, writePolicy, readPolicy,
    session: makeExec({ cwd: project }).agent.session,
  }
}

test('writes inside the project succeed and create parent directories', async () => {
  const s = await scenario()
  const result = await s.gateway.writeFile({
    filePath: path.join(s.project, '.professor', 'indexes', 'files.json'),
    cwd: s.project,
    content: '{}\n',
    session: s.session,
    writePolicy: s.writePolicy,
  })

  assert.equal(result.operation, 'create')
  assert.equal(await fs.readFile(result.canonicalPath, 'utf8'), '{}\n')
})

test('writes outside the project are refused by the plugin policy', async () => {
  const s = await scenario()
  await assert.rejects(
    () => s.gateway.writeFile({
      filePath: path.join(s.home, 'Personal-Agent', '01_Learning', 'x.json'),
      cwd: s.project,
      content: 'x',
      session: s.session,
      writePolicy: s.writePolicy,
    }),
    (error) => error.code === 'PROFESSOR_PATH_DENIED',
  )
  assert.equal(await fs.stat(path.join(s.home, 'Personal-Agent')).catch(() => undefined), undefined)
})

test('source material inside the project is not writable', async () => {
  const s = await scenario()
  await assert.rejects(
    () => s.gateway.writeFile({
      filePath: path.join(s.project, '01_Lectures', 'lecture-01.pdf'),
      cwd: s.project,
      content: 'destroyed',
      session: s.session,
      writePolicy: s.writePolicy,
    }),
    (error) => error.code === 'PROFESSOR_PATH_DENIED',
  )
  assert.equal(await fs.readFile(path.join(s.project, '01_Lectures', 'lecture-01.pdf'), 'utf8'), 'original material')
})

test('traversal spellings are refused', async () => {
  const s = await scenario()
  await assert.rejects(
    () => s.gateway.writeFile({
      filePath: path.join('..', '..', 'escape.json'),
      cwd: path.join(s.project, '.professor'),
      content: 'x',
      session: s.session,
      writePolicy: s.writePolicy,
    }),
    (error) => error.code === 'PROFESSOR_PATH_DENIED' && /"\.\." segment/.test(error.message),
  )
})

test('a symlink inside the allowed root cannot be used to escape it', async () => {
  const s = await scenario()
  const outside = path.join(s.home, 'outside')
  await fs.mkdir(outside, { recursive: true })
  await fs.symlink(outside, path.join(s.project, '.professor', 'link'))

  await assert.rejects(
    () => s.gateway.writeFile({
      filePath: path.join(s.project, '.professor', 'link', 'escape.json'),
      cwd: s.project,
      content: 'x',
      session: s.session,
      writePolicy: s.writePolicy,
    }),
    (error) => error.code === 'PROFESSOR_PATH_DENIED',
  )
  assert.equal(await fs.stat(path.join(outside, 'escape.json')).catch(() => undefined), undefined)
})

test('a read-only sandbox denies the write with a clear message and leaves no partial file', async () => {
  const s = await scenario({ mode: 'read-only' })
  const target = path.join(s.project, '.professor', 'indexes', 'files.json')

  await assert.rejects(
    () => s.gateway.writeFile({
      filePath: target,
      cwd: s.project,
      content: '{}',
      session: s.session,
      writePolicy: s.writePolicy,
    }),
    (error) => {
      assert.equal(error.code, 'FS_SANDBOX_DENIED')
      assert.match(error.message, /denied by the Harness sandbox/)
      return true
    },
  )
  assert.equal(await fs.stat(target).catch(() => undefined), undefined)
  const leftovers = (await fs.readdir(path.join(s.project, '.professor', 'indexes')).catch(() => []))
    .filter((name) => name.includes('.tmp'))
  assert.deepEqual(leftovers, [], 'no temporary files may survive a denied write')
})

test('createIfAbsent refuses to clobber an existing artifact', async () => {
  const s = await scenario()
  const target = path.join(s.project, '.professor', 'indexes', 'files.json')
  await writeFixture(s.home, 'courses/term/.professor/indexes/files.json', '{}')

  await assert.rejects(
    () => s.gateway.writeFile({
      filePath: target,
      cwd: s.project,
      content: '{"replaced":true}',
      session: s.session,
      writePolicy: s.writePolicy,
      expected: { kind: 'createIfAbsent' },
    }),
    (error) => error.code === 'FS_NOT_OBSERVED' && /already exists/.test(error.message),
  )
  assert.equal(await fs.readFile(target, 'utf8'), '{}')
})

test('a concurrent update is detected instead of silently losing data', async () => {
  const s = await scenario()
  const target = path.join(s.project, '.professor', 'indexes', 'files.json')
  await writeFixture(s.home, 'courses/term/.professor/indexes/files.json', 'first')

  const resolved = await s.gateway.resolveTarget(target, { cwd: s.project })
  const observed = await s.gateway.stat(resolved)

  // Another writer changes the file after it was observed.
  await fs.writeFile(target, 'second-writer-changed-it', 'utf8')

  await assert.rejects(
    () => s.gateway.writeFile({
      filePath: target,
      cwd: s.project,
      content: 'third',
      session: s.session,
      writePolicy: s.writePolicy,
      expected: { kind: 'replaceIfVersion', version: observed.version },
    }),
    (error) => error.code === 'FS_STALE_VERSION' && /concurrent update/.test(error.message),
  )
  assert.equal(await fs.readFile(target, 'utf8'), 'second-writer-changed-it')
})

test('the gateway refuses to write without a policy or without the fs service', async () => {
  const s = await scenario()
  await assert.rejects(
    () => s.gateway.writeFile({
      filePath: path.join(s.project, '.professor', 'x.json'),
      cwd: s.project,
      content: 'x',
      session: s.session,
    }),
    /without a write policy/,
  )

  const bare = createFsGateway({ ctx: { logger: {} } })
  assert.equal(bare.available, false)
  await assert.rejects(
    () => bare.resolveTarget('/tmp/x'),
    /refusing to fall back to node:fs/,
  )
})

test('the gateway stamps the per-call sandbox policy from the session', async () => {
  const s = await scenario()
  const policy = s.gateway.sessionPolicy(s.session)
  assert.equal(policy.mode, 'workspace-write')
  assert.equal(policy.workspaceRoot, s.project)
  assert.equal(policy.sessionId, 'session-test')

  // Without a session the policy service still answers (deployment fallback), never undefined.
  assert.ok(s.gateway.sessionPolicy(undefined).workspaceRoot)
})
