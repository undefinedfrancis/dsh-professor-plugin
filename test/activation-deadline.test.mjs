import test from 'node:test'
import assert from 'node:assert/strict'
import { activationDeadline, hostActivationDiagnostic } from '../tools/activation-deadline.mjs'

test('activation deadline returns a successful host result', async () => {
  assert.equal(await activationDeadline(async () => 'ready', { timeoutMs: 100 }), 'ready')
})

test('activation deadline preserves the original activation error', async () => {
  const error = new Error('invalid preset')
  await assert.rejects(activationDeadline(async () => { throw error }), (actual) => actual === error)
})

test('activation deadline rejects a stalled host with actionable diagnostics', async () => {
  await assert.rejects(
    activationDeadline(() => new Promise((resolve) => setTimeout(resolve, 30)), {
      timeoutMs: 5,
      diagnostic: async () => 'webserver: listen EPERM',
    }),
    /activation timed out.*webserver: listen EPERM/s,
  )
})

test('host diagnostics report failed and pending rows without printing configuration', async () => {
  const ctx = { get: () => ({ entries: () => [
    { id: 'webserver', options: { secret: 'do-not-print' }, fiber: { state: 3, await: async () => { throw new Error('listen EPERM') } } },
    { id: 'connection', fiber: { state: 0 } },
    { id: 'ready', fiber: { state: 2 } },
    { id: 'disabled', disabled: true, fiber: { state: 0 } },
  ] }) }
  assert.equal(await hostActivationDiagnostic(ctx), 'webserver: listen EPERM; connection: activation pending')
  assert.match(await hostActivationDiagnostic(undefined), /check local listener permissions/)
})
