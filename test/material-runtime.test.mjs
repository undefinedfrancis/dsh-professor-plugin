import test from 'node:test'
import assert from 'node:assert/strict'
import { createMaterialRuntime } from '../src/material/runtime.js'
const gateway = { resolveTarget: async path => path, canonical: path => path }
function extraction(pdf = '/python') { return { capabilities: { pdfInterpreter: pdf, bootstrapInterpreter: '/python312', python: null }, ensureProbed: async () => {}, run: () => {}, render: () => {} } }
test('configured runtimes do not prepare or download', async () => {
  const enhanced = { run: () => {}, info: {} }
  const manager = createMaterialRuntime({ pluginRoot: '/plugin', gateway, extraction: extraction(), enhancement: enhanced, configured: true, shellRun: () => { throw new Error('must not prepare') } })
  const runtime = await manager.runtimeFor({ workspace: '/workspace', action: 'enhance', extension: 'pdf' })
  assert.equal(runtime.enhance, enhanced.run)
  manager.dispose()
})
test('working fast PDF and non-PDF reading never prepare the heavy environment', async () => {
  const manager = createMaterialRuntime({ pluginRoot: '/plugin', gateway, extraction: extraction(), enhancement: { run: () => {}, info: {} }, shellRun: () => { throw new Error('must not prepare') } })
  for (const extension of ['pdf','docx']) await manager.runtimeFor({ workspace: '/workspace', action: 'plan', extension })
})
test('setup failure is honest and does not cache a ready runtime', async () => {
  let calls = 0
  const manager = createMaterialRuntime({ pluginRoot: '/plugin', gateway, extraction: extraction('/python'), enhancement: { run: () => {}, info: {} }, shellRun: async () => { calls++; return { exitCode: 1 } } })
  for (let i = 0; i < 2; i++) {
    const runtime = await manager.runtimeFor({ workspace: '/workspace', action: 'enhance', extension: 'pdf' })
    assert.equal((await runtime.enhance()).status, 'unavailable')
  }
  assert.equal(calls, 2)
})
test('canonical cache symlink escape is rejected before setup', async () => {
  const manager = createMaterialRuntime({ pluginRoot: '/plugin', gateway: { ...gateway, canonical: target => target.includes('.professor-cache') ? '/outside' : target }, extraction: extraction(), enhancement: { info: {} }, shellRun: () => { throw new Error('must not run') } })
  await assert.rejects(manager.runtimeFor({ workspace: '/workspace', action: 'enhance', extension: 'pdf' }), /escapes/)
})
