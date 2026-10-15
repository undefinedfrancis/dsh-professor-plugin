/**
 * Session sandbox-policy propagation through the shared shell runner (regression suite).
 *
 * Confirmed gap under test: the installed `@deepseek-ai/dsh-tool-bash` resolves the *standing*
 * policy of the calling session (`ctx.sandboxPolicy.resolve({ session: exec.agent.session })`) and
 * passes it in its shell request, while the plugin's shared runner used to collect `shellEnv` and
 * stop there. Without the stamp the sandbox executor falls back to `ctx.sandboxPolicy.resolve()`
 * — no session, therefore the *deployment* fallback root instead of the session workspace — which
 * is a strong explanation for write denials inside the conversation workspace.
 *
 * What these tests pin:
 *   1. the policy is resolved with the calling session and travels into `shell.resolve`;
 *   2. selecting an output `workdir` never widens the policy (the session root wins, as in bash);
 *   3. a host without the policy service still runs — no throw, no fabricated policy;
 *   4. an executor that does not advertise confinement never receives a policy (mirror of the
 *      host tool, which only stamps when `sandboxMode` is defined);
 *   5. a policy resolver that throws surfaces as an explicit runner failure, never as silence.
 *
 * The omission is confirmed; its responsibility for the original PHY1001 write denial remains a
 * hypothesis until reproduced in that session — see docs/qa/2026-10-15-latex-flow-audit/REPORT.md.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply } from '../src/plugin.js'
import { createShellRunner } from '../src/latex/runner.js'
import { createFakeContext, makeExec, makeHome } from './helpers/fake-harness.mjs'

/** A recording shell seam that advertises confinement like `SandboxBashExecutor` does. */
function recordingShell(options = {}) {
  const sandboxMode = Object.hasOwn(options, 'sandboxMode') ? options.sandboxMode : 'workspace-write'
  const resolveCalls = []
  const executeCalls = []
  return {
    resolveCalls,
    executeCalls,
    sandboxMode,
    resolve(request) {
      resolveCalls.push(request)
      return { ...request }
    },
    async execute(spec) {
      executeCalls.push(spec)
      return {
        result: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs ?? null,
          stdout: { text: 'ok', truncated: false },
          stderr: { text: '', truncated: false },
          sandbox: { mode: spec.sandboxPolicy?.mode ?? null, denied: false },
        }),
      }
    },
  }
}

/** A recording policy service shaped like `dsh-sandbox-policy`'s `resolve()`. */
function recordingPolicy({ mode = 'workspace-write', root = '/fallback/deployment', onResolve } = {}) {
  const calls = []
  return {
    calls,
    resolve(request = {}) {
      calls.push(request)
      onResolve?.(request)
      return {
        mode,
        workspaceRoot: request.session?.header?.cwd ?? root,
        ...(request.session === undefined ? {} : { sessionId: request.session.id }),
      }
    },
  }
}

function contextWith({ shell, sandboxPolicy }) {
  const services = { shell }
  if (sandboxPolicy !== undefined) services.sandboxPolicy = sandboxPolicy
  return {
    get: (name) => services[name],
  }
}

test('the runner stamps the calling session\'s standing sandbox policy onto the shell request', async () => {
  const shell = recordingShell()
  const sandboxPolicy = recordingPolicy({ root: '/fallback/deployment' })
  const run = createShellRunner(contextWith({ shell, sandboxPolicy }))
  assert.equal(typeof run, 'function')

  const exec = makeExec({ cwd: '/ws/session-workspace' })
  const result = await run({ command: 'xelatex main.tex', workdir: '/ws/session-workspace/.professor/notes/x', exec })

  assert.equal(result.runnerFailed, false, 'propagation must not break a healthy run')

  assert.equal(sandboxPolicy.calls.length, 1, 'exactly one standing-policy resolution per call')
  const request = sandboxPolicy.calls[0]
  assert.equal(request.session, exec.agent.session, 'the policy is resolved with the calling session')
  assert.equal(request.session.header.cwd, '/ws/session-workspace')

  assert.equal(shell.resolveCalls.length, 1)
  const shellRequest = shell.resolveCalls[0]
  assert.ok(Object.hasOwn(shellRequest, 'sandboxPolicy'), 'sandboxPolicy must reach shell.resolve')
  assert.deepEqual(shellRequest.sandboxPolicy, {
    mode: 'workspace-write',
    workspaceRoot: '/ws/session-workspace',
    sessionId: 'session-test',
  })
  assert.equal(shellRequest.sandboxPolicy.workspaceRoot, '/ws/session-workspace',
    'the policy root is the session workspace')
  assert.notEqual(shellRequest.sandboxPolicy.workspaceRoot, shellRequest.workdir,
    'selecting an output directory must never widen or replace the policy root')
})

test('a host without the policy service still runs: no throw, no fabricated policy', async () => {
  const shell = recordingShell()
  const run = createShellRunner(contextWith({ shell }))
  assert.equal(typeof run, 'function', 'a missing policy service must not disable the runner')

  const exec = makeExec({ cwd: '/ws/session-workspace' })
  const result = await run({ command: 'true', workdir: '/ws/session-workspace', exec })
  assert.equal(result.runnerFailed, false)
  assert.equal(result.exitCode, 0)

  const shellRequest = shell.resolveCalls[0]
  assert.equal(Object.hasOwn(shellRequest, 'sandboxPolicy'), false,
    'nothing may be stamped when the service does not exist — the executor keeps its own fallback')
})

test('an executor that does not advertise confinement never receives a policy', async () => {
  // Mirrors `dsh-tool-bash`, which only resolves/stamps when `shell.sandboxMode` is defined.
  const shell = recordingShell({ sandboxMode: undefined })
  const sandboxPolicy = recordingPolicy()
  const run = createShellRunner(contextWith({ shell, sandboxPolicy }))

  const result = await run({ command: 'true', exec: makeExec({ cwd: '/ws/session-workspace' }) })
  assert.equal(result.runnerFailed, false)
  assert.equal(Object.hasOwn(shell.resolveCalls[0], 'sandboxPolicy'), false,
    'an unconfined executor must be left exactly as it was')
})

test('an agentless call resolves the deployment policy, never a made-up one', async () => {
  const shell = recordingShell()
  const sandboxPolicy = recordingPolicy({ root: '/fallback/deployment' })
  const run = createShellRunner(contextWith({ shell, sandboxPolicy }))

  const withoutExec = await run({ command: 'true' })
  assert.equal(withoutExec.runnerFailed, false)
  assert.deepEqual(sandboxPolicy.calls[0], {}, 'no session means the deployment fallback, as in bash')

  const execNoAgent = { signal: undefined }
  const withoutAgent = await run({ command: 'true', exec: execNoAgent })
  assert.equal(withoutAgent.runnerFailed, false)
  assert.deepEqual(sandboxPolicy.calls[1], {})
  assert.equal(shell.resolveCalls[1].sandboxPolicy.workspaceRoot, '/fallback/deployment')
})

test('a policy resolver that throws is an explicit runner failure, not silent fallback', async () => {
  const shell = recordingShell()
  const sandboxPolicy = {
    resolve() { throw new Error('session projection unavailable') },
  }
  const run = createShellRunner(contextWith({ shell, sandboxPolicy }))

  const result = await run({ command: 'true', exec: makeExec({ cwd: '/ws' }) })
  assert.equal(result.runnerFailed, true)
  assert.match(result.reason, /sandbox policy could not be resolved/)
  assert.match(result.reason, /session projection unavailable/)
  assert.equal(shell.resolveCalls.length, 0, 'no request is sent under an unknown policy')
})

// --- consumer audit: shared-runner callers that never pass an `exec` -------------

test('extraction probes keep the pre-change request: deployment fallback, no session stamp drift', async () => {
  // Audit evidence for requirement 1: `src/extract/runner.js`, `src/material/prepare.js` and
  // `src/material/enhance.js` call the shared runner WITHOUT an `exec`, so the standing policy is
  // resolved with `{}` — byte-identical to the executor's own `ctx.sandboxPolicy.resolve()`
  // fallback it already applied before this change. Only the LaTeX compile path passes `exec`,
  // and only that path gains the session stamp.
  const { createExtractionService } = await import('../src/extract/runner.js')
  const shell = recordingShell()
  const sandboxPolicy = recordingPolicy({ root: '/fallback/deployment' })
  const runner = createShellRunner(contextWith({ shell, sandboxPolicy }))
  const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

  const service = createExtractionService({
    shellRun: runner,
    pluginRoot,
    env: { PATH: '/fixture/bin' },
    pathDirs: ['/fixture/bin'],
    isFile: (candidate) => String(candidate).endsWith('python3'),
  })
  await service.ensureProbed()

  assert.ok(shell.executeCalls.length >= 1, 'the probe must actually reach the seam')
  assert.deepEqual(sandboxPolicy.calls, shell.executeCalls.map(() => ({})),
    'no extraction call carries a session: the deployment fallback is resolved, exactly as before')
  for (const request of shell.resolveCalls) {
    assert.deepEqual(request.sandboxPolicy, {
      mode: 'workspace-write',
      workspaceRoot: '/fallback/deployment',
    })
  }
})

// --- end-to-end: the compile tool reaches the seam with the session policy -----

test('professor_latex_compile passes the session policy through the real runner', async () => {
  const home = await makeHome('professor-policy-e2e-')
  const shell = recordingShell()
  const fake = createFakeContext({ home, services: { shell } })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))

  const project = path.join(home, 'term')
  await fs.mkdir(path.join(project, '.professor'), { recursive: true })
  await fs.mkdir(path.join(project, 'CSC3200', '01_Lectures'), { recursive: true })
  await fs.writeFile(path.join(project, 'CSC3200', '01_Lectures', 'lecture-01.md'), 'x', 'utf8')
  const exec = makeExec({ cwd: project })
  await fs.writeFile(path.join(project, '.professor', 'project.yaml'), `schema_version: 1
project:
  id: term-2026
  name: 'Fall 2026'
courses:
  - course_id: csc3200
    course_code: CSC3200
    term: '2025-2026 Fall'
    display_name: Data Structures
    status: active
    sources:
      - path: ${path.join(project, 'CSC3200')}
outputs:
  notes_root: null
  reviews_root: null
indexing:
  exclude: []
  follow_symlinks: false
retrieval:
  max_sources: 4
  max_chunks: 8
  prefer_local_course_sources: true
notes:
  default_format: latex
  overwrite_policy: never
  latex_template: null
web:
  enabled: true
  policy: conditional
`, 'utf8')

  await tools.professor_session_bind.execute({ course: 'csc3200' }, exec)
  const created = await tools.professor_artifact_create.execute({
    kind: 'note', title: 'Recursion', format: 'latex',
    sections: [{ heading: '递归', body: 'base case。' }],
  }, exec)
  assert.equal(created.created, true)

  // Deterministic probe regardless of the machine: a fixture "TeX installation" that satisfies
  // the unicode-cjk requirement (engine + a TeX-distribution CJK font). The seam itself is the
  // recording shell above, so nothing is actually compiled here — the verdicts live in
  // latex.test.mjs; this test only pins what reaches the shell request.
  const texbin = await fs.mkdtemp(path.join(home, 'texbin-'))
  const texmf = await fs.mkdtemp(path.join(home, 'texmf-'))
  await fs.writeFile(path.join(texbin, 'latexmk'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await fs.writeFile(path.join(texbin, 'xelatex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const fontDir = path.join(texmf, 'fonts', 'opentype', 'public', 'fandol')
  await fs.mkdir(fontDir, { recursive: true })
  await fs.writeFile(path.join(fontDir, 'FandolSong-Regular.otf'), 'fixture font', 'utf8')

  const previousEnv = { ...process.env }
  process.env.DSH_PROFESSOR_LATEX = texbin
  process.env.TEXMFDIST = texmf
  try {
    const compile = tools.professor_latex_compile
    // Only exercise the seam contract here: the document verdicts live in latex.test.mjs.
    const report = await compile.execute({ directory: created.directory }, exec)
    assert.ok(['compilation_succeeded', 'compilation_failed'].includes(report.verdict),
      `expected an attempted compile, got ${report.verdict}: ${report.summary}`)
  } finally {
    process.env.DSH_PROFESSOR_LATEX = previousEnv.DSH_PROFESSOR_LATEX
    process.env.TEXMFDIST = previousEnv.TEXMFDIST
    if (process.env.DSH_PROFESSOR_LATEX === undefined) delete process.env.DSH_PROFESSOR_LATEX
    if (process.env.TEXMFDIST === undefined) delete process.env.TEXMFDIST
  }

  assert.equal(shell.resolveCalls.length, 1, 'one shell request per compile attempt')
  const request = shell.resolveCalls[0]
  assert.ok(Object.hasOwn(request, 'sandboxPolicy'), 'the compile request carries the session policy')
  assert.equal(request.sandboxPolicy.workspaceRoot, project,
    'workspace-rooted on the session workspace, not on the artifact output directory')
  assert.equal(request.sandboxPolicy.mode, 'workspace-write')
  assert.equal(request.sandboxPolicy.sessionId, 'session-test')
  assert.equal(request.workdir, path.join(project, '.professor', 'notes', created.directory),
    'the artifact directory stays the working directory — only the policy is session-derived')
})
