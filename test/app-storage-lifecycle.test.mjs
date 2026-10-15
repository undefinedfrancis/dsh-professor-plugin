/**
 * Phase 1 (M1) — application-storage **lifecycle** regressions.
 *
 * The defect these tests pin
 * --------------------------
 * `ensureOpen()` started `open()` and stored the pending promise. `close()` then cleared `opening`
 * but could not see the domain, because `open()` had not published it yet. When the host's `open()`
 * finally resolved, the old attempt published the domain and set `status = 'open'` — **after** the
 * handle had been closed. Result: the storage resurrected itself and the acquired domain was never
 * released.
 *
 * These tests drive the interleavings with explicit deferred promises rather than timing guesses,
 * because the whole defect is about *who wins when two operations overlap*.
 *
 * The second defect these tests pin
 * --------------------------------
 * `close()` invalidated the current epoch, then awaited `handle.close()` and **unconditionally** set
 * `status = 'closed'` afterwards. The release is a round-trip through the host, and a caller may
 * legitimately reopen while it is in flight, so that write overwrote a *newer* lifecycle's state:
 * reproduce by opening handle A, starting `close()` on A and keeping its release pending, opening
 * and completing a new handle B, then letting A's release finish — the storage reported `closed`
 * while B was still live and reachable through `table()`.
 *
 * Required properties (from the Phase 1 acceptance brief):
 *   1. closing during an in-flight open cannot resurrect the closed handle;
 *   2. a domain acquired after cancellation is released exactly once;
 *   3. concurrent `ensureOpen()` calls share the intended opening;
 *   4. repeated `close()` calls are safe;
 *   5. an explicit reopen after a completed close works;
 *   6. an old pending operation cannot overwrite a newer operation's state;
 *   7. bootstrap writes do not continue after the handle has been invalidated;
 *   8. cleanup failures are reported honestly;
 *   9. an old **close** completion cannot overwrite a newer lifecycle's status, reason, bootstrap
 *      information or handle — and a release that fails while a newer lifecycle is live is still
 *      reported without corrupting it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { APP_BOOTSTRAP_KEY, createAppStorage } from '../src/app/storage.js'

/** A promise plus its setters, so a test can decide exactly when an await resumes. */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * A storage service whose `open()` returns a promise the test resolves by hand — this is what makes
 * the "close() while open() is pending" interleaving reproducible instead of racy.
 *
 * The store is **shared across opens**, because the real medium is persistent: opening the same
 * domain name again hands back the same bytes. Handing back a fresh empty store per `open()` would
 * model a different, brand-new domain, and would make the reopen cases below assert the wrong thing.
 * Each handle still gets its own `writes` log and its own `close()` bookkeeping, since those are
 * per-handle observations rather than part of the medium.
 *
 * With `deferClose`, a handle's `close()` returns a promise the test settles by hand (through
 * `domain.closeGate`), which is what makes "a release that is still in flight when the next
 * lifecycle starts" reproducible instead of racy. Without it the release settles immediately, so the
 * earlier cases read exactly as before.
 */
function pendingService(options = {}) {
  const { deferClose = false } = options
  const calls = { open: [], openCount: 0, closed: [] }
  const guards = []
  const store = new Map()

  function makeDomain(label) {
    const writes = []
    const domain = {
      label,
      store,
      writes,
      /** Set to a {@link deferred} on a deferred release, so the test owns when it completes. */
      closeGate: null,
      async close() {
        calls.closed.push(label)
        if (!deferClose) return
        const gate = deferred()
        domain.closeGate = gate
        return gate.promise
      },
      table() {
        return {
          get: (key) => store.get(key),
          async put(key, value) {
            writes.push({ key, value })
            store.set(key, value)
          },
          async update(key, transform) {
            store.set(key, transform(store.get(key)))
          },
          get size() {
            return store.size
          },
        }
      },
    }
    return domain
  }

  const ctx = {
    get(name) {
      if (name !== 'storageDomain') return undefined
      return {
        open(spec) {
          calls.openCount += 1
          calls.open.push(spec)
          const gate = deferred()
          const handle = { gate, domain: makeDomain(`open#${calls.openCount}`) }
          guards.push(handle)
          return gate.promise.then(() => handle.domain)
        },
      }
    },
  }

  return { ctx, calls, guards }
}

/** Flush microtasks until `predicate()` holds, so an interleaving test never depends on timing. */
async function waitUntil(predicate, turns = 50) {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('waitUntil: the awaited step never happened')
}

/** A context whose storage service is absent, for the degradation path. */
const absentCtx = { get: () => undefined }

test('close() during an in-flight open cannot resurrect the closed handle', async () => {
  const { ctx, calls, guards } = pendingService()
  const storage = createAppStorage({ ctx })

  const opening = storage.ensureOpen()
  // The handle is mid-open and has published nothing yet.
  assert.equal(storage.describe().status, 'opening', 'describe() is honest about the in-flight open')
  assert.equal(storage.table('app'), undefined, 'no table handle exists before the domain is adopted')

  await storage.close()

  // Now the host finally grants a domain. It must be released, not adopted.
  guards[0].gate.resolve()
  const snapshot = await opening

  assert.notEqual(snapshot.status, 'open', 'a cancelled open never reports the handle as open')
  assert.equal(storage.table('app'), undefined, 'no table handle is exposed after close()')
  assert.deepEqual(calls.closed, ['open#1'], 'the late domain was released')
  assert.equal(guards[0].domain.store.size, 0, 'no bootstrap record was written into the late domain')
})

test('a domain acquired after cancellation is released exactly once', async () => {
  const { ctx, calls, guards } = pendingService()
  const storage = createAppStorage({ ctx })

  const opening = storage.ensureOpen()
  await storage.close()
  guards[0].gate.resolve()
  await opening

  // A second close() must not release anything again.
  await storage.close()
  assert.deepEqual(calls.closed, ['open#1'], 'released exactly once, and repeated close() is safe')
})

test('concurrent ensureOpen() calls share one opening operation', async () => {
  const { ctx, calls, guards } = pendingService()
  const storage = createAppStorage({ ctx })

  const first = storage.ensureOpen()
  const second = storage.ensureOpen()
  assert.equal(calls.openCount, 1, 'the second caller joins the first attempt instead of opening again')

  guards[0].gate.resolve()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.status, 'open')
  assert.equal(b.status, 'open')
  assert.equal(calls.openCount, 1, 'still exactly one host open()')
  assert.equal(storage.describe().bootstrapped, true, 'the bootstrap ran once')
})

test('the bootstrap marker is written once and an explicit reopen finds it', async () => {
  const { ctx, calls, guards } = pendingService()
  const storage = createAppStorage({ ctx, readVersion: async () => '9.9.9' })

  const first = storage.ensureOpen()
  guards[0].gate.resolve()
  const openedOnce = await first
  assert.equal(openedOnce.status, 'open')
  assert.equal(openedOnce.bootstrapped, true)
  const record = guards[0].domain.store.get(APP_BOOTSTRAP_KEY)
  assert.equal(record.plugin_version, '9.9.9', 'the bootstrap record carries the plugin version')
  const createdAt = record.created_at

  await storage.close()
  assert.equal(storage.describe().status, 'closed')

  // Reopen after a completed close: a fresh host open() runs, and it must NOT rewrite the marker.
  const second = storage.ensureOpen()
  assert.equal(calls.openCount, 2, 'the reopen really asked the host again')
  guards[1].gate.resolve()
  const reopened = await second
  assert.equal(reopened.status, 'open')
  assert.equal(reopened.bootstrapped, false, 'the existing marker is recognised, not rewritten')
  assert.equal(guards[1].domain.store.get(APP_BOOTSTRAP_KEY).created_at, createdAt)
  assert.deepEqual(calls.closed, ['open#1'], 'the first domain was released by close()')
})

test('an older pending open cannot overwrite a newer open\u2019s state', async () => {
  const { ctx, calls, guards } = pendingService()
  const storage = createAppStorage({ ctx })

  const stale = storage.ensureOpen()      // attempt A (will be cancelled)
  await storage.close()

  const fresh = storage.ensureOpen()      // attempt B (current)
  assert.equal(calls.openCount, 2)

  // Resolve the OLD attempt first: it must not touch the state of the newer one.
  guards[0].gate.resolve()
  await stale
  assert.equal(storage.describe().status, 'opening', 'the stale completion left the current attempt alone')
  assert.equal(storage.table('app'), undefined, 'the stale domain was never adopted')

  guards[1].gate.resolve()
  const current = await fresh
  assert.equal(current.status, 'open')
  assert.equal(storage.table('app')?.size, 1, 'the current attempt owns the live table')

  await storage.close()
  assert.deepEqual(calls.closed, ['open#1', 'open#2'], 'each acquired domain was released exactly once')
})

test('a stale close completion cannot overwrite a newer lifecycle', async () => {
  const { ctx, calls, guards } = pendingService({ deferClose: true })
  const storage = createAppStorage({ ctx })

  // 1. Open handle A and let it settle.
  const openingA = storage.ensureOpen()
  guards[0].gate.resolve()
  const a = await openingA
  assert.equal(a.status, 'open')
  assert.equal(a.bootstrapped, true, 'the first open wrote the marker')

  // 2. Start closing A and keep A's release in flight.
  const closingA = storage.close()
  assert.equal(guards[0].domain.closeGate !== null, true, 'A\u2019s release is pending')
  assert.equal(storage.table('app'), undefined, 'the handle being closed is already unreachable')

  // 3. A new lifecycle starts AND completes while A is still being released.
  const openingB = storage.ensureOpen()
  assert.equal(calls.openCount, 2, 'the reopen asked the host again')
  guards[1].gate.resolve()
  const b = await openingB
  assert.equal(b.status, 'open', 'handle B is open')
  assert.equal(b.bootstrapped, false, 'B found the marker A had already written')
  assert.equal(storage.table('app').size, 1, 'B owns a live table')
  assert.equal(storage.describe().status, 'open', 'and the storage reports B, not A')

  // 4. A's release finally finishes. It belongs to a superseded lifecycle, so it must change NOTHING.
  guards[0].domain.closeGate.resolve()
  await closingA

  const after = storage.describe()
  assert.equal(after.status, 'open', 'the stale close did not overwrite B\u2019s status')
  assert.equal(after.reason, null, 'nor B\u2019s reason')
  assert.equal(after.bootstrapped, false, 'nor B\u2019s bootstrap information')
  assert.equal(after.domain, 'professor_app', 'the domain description is still the live one')

  // B must still be *usable*, not merely described as open.
  await storage.writeRecord('note/1', { schema: 'professor.app/1', text: 'written after the stale close' })
  assert.deepEqual(
    storage.table('app').get('note/1'),
    { schema: 'professor.app/1', text: 'written after the stale close' },
    'the record goes to B and reads back from B',
  )
  assert.equal(storage.table('app').size, 2, 'B still holds the marker and the new record')
  assert.deepEqual(calls.closed, ['open#1'], 'only A was released, and exactly once')

  // The newer lifecycle still owns the release of the newer handle.
  const closingB = storage.close()
  guards[1].domain.closeGate.resolve()
  await closingB
  assert.deepEqual(calls.closed, ['open#1', 'open#2'], 'B was released exactly once, by its own close()')
  assert.equal(storage.describe().status, 'closed', 'and now the storage really is closed')
})

test('a failed release on a superseded lifecycle is reported without corrupting the newer one', async () => {
  const warnings = []
  const { ctx, calls, guards } = pendingService({ deferClose: true })
  const storage = createAppStorage({ ctx, logger: { warn: (m) => warnings.push(String(m)) } })

  const openingA = storage.ensureOpen()
  guards[0].gate.resolve()
  await openingA

  const closingA = storage.close()
  const openingB = storage.ensureOpen()
  guards[1].gate.resolve()
  const b = await openingB
  assert.equal(b.status, 'open')

  // A's release fails, after B is already the current lifecycle.
  guards[0].domain.closeGate.reject(Object.assign(new Error('backend refused to release the unit'), { code: 'unit-busy' }))
  await closingA

  assert.equal(warnings.length, 1, 'the cleanup failure is reported exactly once')
  assert.match(warnings[0], /unit-busy|backend refused to release the unit/)
  assert.equal(storage.describe().status, 'open', 'the failure did not overwrite B\u2019s status')
  assert.equal(storage.describe().reason, null, 'nor invent a reason for B')
  assert.deepEqual(calls.closed, ['open#1'], 'and it did not release B as a side effect')

  await storage.writeRecord('note/2', { schema: 'professor.app/1', ok: true })
  assert.deepEqual(storage.table('app').get('note/2'), { schema: 'professor.app/1', ok: true }, 'B is still usable')
})

test('a bootstrap write does not continue once the handle is invalidated', async () => {
  const { ctx, calls, guards } = pendingService()
  const versionGate = deferred()
  let versionAsked = false
  const storage = createAppStorage({
    ctx,
    readVersion: () => {
      versionAsked = true
      return versionGate.promise
    },
  })

  const opening = storage.ensureOpen()
  guards[0].gate.resolve()              // the domain is adopted, and bootstrap() starts
  await waitUntil(() => versionAsked)   // ...and is now parked on readVersion()

  await storage.close()                 // close() lands while the bootstrap is awaiting the version
  versionGate.resolve('9.9.9')          // bootstrap may now continue — but it must not

  const snapshot = await opening
  assert.notEqual(snapshot.status, 'open', 'the invalidated open never reports itself as open')
  assert.deepEqual(guards[0].domain.writes, [], 'no record was written after the handle was invalidated')
  assert.deepEqual(calls.closed, ['open#1'], 'the adopted domain was still released exactly once')
})

test('a cleanup failure is reported honestly instead of being swallowed', async () => {
  const warnings = []
  const ctx = {
    get: (name) => (name === 'storageDomain'
      ? {
        async open() {
          // A domain that opens and bootstraps perfectly well, and only refuses to be released —
          // so the release warning is the *only* warning this test can observe.
          const store = new Map()
          return {
            async close() {
              const error = new Error('backend refused to release the unit')
              error.code = 'unit-busy'
              throw error
            },
            table: () => ({
              get: (key) => store.get(key),
              async put(key, value) { store.set(key, value) },
              async update(key, transform) { store.set(key, transform(store.get(key))) },
              get size() { return store.size },
            }),
          }
        },
      }
      : undefined),
  }
  const storage = createAppStorage({ ctx, logger: { warn: (m) => warnings.push(String(m)) } })

  const snapshot = await storage.ensureOpen()
  assert.equal(snapshot.status, 'open', 'the domain opened; the only failure is the release')
  assert.equal(snapshot.bootstrapped, true, 'the marker was written, so no bootstrap warning is due')
  await storage.close()

  assert.equal(warnings.length, 1, 'the cleanup failure is reported exactly once')
  assert.match(warnings[0], /unit-busy|backend refused to release the unit/)
})

test('an unavailable host still degrades gracefully, and close() remains safe', async () => {
  const warnings = []
  const storage = createAppStorage({ ctx: absentCtx, logger: { warn: (m) => warnings.push(String(m)) } })

  const snapshot = await storage.ensureOpen()
  assert.equal(snapshot.status, 'unavailable')
  assert.equal(snapshot.bootstrapped, false)
  await storage.close()
  await storage.close()
  assert.equal(warnings.length, 0, 'a missing service is a reported state, not a warning')
  assert.equal(storage.table('app'), undefined)
})
