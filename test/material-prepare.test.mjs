import assert from 'node:assert/strict'
import test from 'node:test'
import { createPreparationService } from '../src/material/prepare.js'

test('preparation stays inside a canonical workspace and uses a hash-locked resource manifest', async () => {
  const calls = []
  const prepare = createPreparationService({ pluginRoot: '/plugin', shellRun: async spec => {
    calls.push(spec)
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, python: '/workspace/.professor-cache/enhance/env/bin/python', artifacts: '/workspace/.professor-cache/enhance/models' }) }
  } })
  const out = await prepare({ workspace: '/workspace', destination: '/workspace/.professor-cache/enhance', basePython: '/python', platform: 'darwin-arm64' })
  assert.equal(out.status, 'prepared')
  assert.ok(calls[0].args.includes('/plugin/resources/enhance/requirements/darwin-arm64.lock'))
  assert.equal(calls[0].timeoutMs, 600000)
})
test('preparation refuses a destination outside the workspace', async () => {
  const prepare = createPreparationService({ pluginRoot: '/plugin', shellRun: () => { throw new Error('must not run') } })
  await assert.rejects(prepare({ workspace: '/workspace', destination: '/outside', basePython: '/python', platform: 'darwin-arm64' }), /workspace/)
})
test('concurrent preparations are single-flight and failures are not called ready', async () => {
  let calls = 0
  const prepare = createPreparationService({ pluginRoot: '/plugin', shellRun: async () => {
    calls += 1
    await new Promise(resolve => setTimeout(resolve, 10))
    return { exitCode: 0, stdout: '{"ok":false,"detail":"missing resource"}' }
  } })
  const spec = { workspace: '/workspace', destination: '/workspace/.professor-cache/enhance', basePython: '/python', platform: 'linux-x64' }
  const results = await Promise.all([prepare(spec), prepare(spec)])
  assert.equal(calls, 1)
  assert.ok(results.every(r => r.status === 'unavailable'))
})

test('Python setup repairs corrupt state and abandoned process locks without network', async () => {
  const { execFileSync } = await import('node:child_process')
  const output = execFileSync(process.env.DSH_PROFESSOR_ENHANCE_PYTHON ?? 'python3', ['test/helpers/material-prepare-fixture.py', 'src/extract/scripts/prepare_enhance.py'], { encoding: 'utf8' })
  assert.match(output, /recover without network/)
})
