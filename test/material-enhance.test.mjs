import assert from 'node:assert/strict'
import test from 'node:test'
import { createEnhancementService } from '../src/material/enhance.js'

function fixture(reply = { ok: true, backend: 'docling', pages: [{ page: 2, text: 'OCR body', blocks: [] }] }) {
  const calls = []
  const service = createEnhancementService({ pluginRoot: '/plugin', python: '/runtime/python',
    shellRun: async spec => { calls.push(spec); return { exitCode: 0, stdout: JSON.stringify(reply) } } })
  return { service, calls }
}
const policy = { assert: (_spelling, canonical) => canonical }

test('enhancement processes only selected pages through the host shell', async () => {
  const { service, calls } = fixture()
  const result = await service.run({ sourcePath: '/course/source.pdf', pages: [2], sourceHash: 'abc', readPolicy: policy })
  assert.equal(result.status, 'enhanced')
  assert.deepEqual(result.pages.map(p => p.page), [2])
  assert.ok(calls[0].args.includes('2'))
  assert.equal(calls[0].timeoutMs, 120000)
})
test('unauthorized enhancement never starts a process', async () => {
  const { service, calls } = fixture()
  await assert.rejects(service.run({ sourcePath: '/denied.pdf', pages: [1], readPolicy: { assert() { throw new Error('denied') } } }), /denied/)
  assert.equal(calls.length, 0)
})
test('enhancement refuses more than six pages before invoking the backend', async () => {
  const { service, calls } = fixture()
  await assert.rejects(service.run({ sourcePath: '/source.pdf', pages: [1,2,3,4,5,6,7], readPolicy: policy }), /six/)
  assert.equal(calls.length, 0)
})
test('enhancement reports unavailable and malformed output honestly', async () => {
  const absent = createEnhancementService({ pluginRoot: '/plugin' })
  assert.equal((await absent.run({ sourcePath: '/source.pdf', pages: [1], readPolicy: policy })).status, 'unavailable')
  const { service } = fixture({ ok: true, pages: [{ page: 99, text: 'Wrong page' }] })
  assert.equal((await service.run({ sourcePath: '/source.pdf', pages: [2], readPolicy: policy })).status, 'failed')
})
test('enhancement cache invalidates for source changes and never caches failures', async () => {
  const { service, calls } = fixture()
  const spec = { sourcePath: '/source.pdf', pages: [2], sourceHash: 'a', readPolicy: policy }
  await service.run(spec); await service.run(spec)
  assert.equal(calls.length, 1)
  await service.run({ ...spec, sourceHash: 'b' })
  assert.equal(calls.length, 2)
})
