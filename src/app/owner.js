/**
 * The single owner of the Professor application-storage domain.
 *
 * Why this module exists
 * ----------------------
 * The host refuses a concurrent open of the same storage domain (`already-open`), and there is
 * exactly one `professor_app` domain. Before Phase 4 there was one consumer — the preset-scoped
 * Professor runtime — so letting the row that needed storage open its own handle was harmless.
 * Professor Home needs the same records from a row that is mounted **outside** any preset (the UI
 * exists before a Professor session does), and two independent handles would mean whichever row
 * lost the race could not read or write its own data.
 *
 * So ownership is one object per deployment, shared by reference:
 *
 *   - the **app row** (deployment level, no tools/skills) owns the domain and serves Home;
 *   - the **runtime row** (inside the `professor` preset) consumes a facet of the same domain for
 *     memory and onboarding;
 *   - if no app row is mounted (a host that only ever uses the preset, or a future layout change),
 *     the runtime row still creates its own owner, so the old single-consumer behaviour is intact.
 *
 * **Refcounting, not caching.** A consumer {@link acquire}s a facet and releases it with the row's
 * own lifetime. The domain is closed when the last consumer releases it, and reopened on the next
 * acquire, so disabling the plugin releases the handle instead of leaking it, while enabling it
 * again finds the same records (close releases the handle; it never deletes anything).
 *
 * **Disposal is terminal.** A facet whose lifetime ended, or whose owner was disposed, refuses
 * further work with {@link APP_OWNER_DISPOSED_CODE} rather than returning empty data. That is the
 * difference between "storage failed" (reported through {@link describe}) and "this caller no
 * longer exists" (reported by throwing): neither may be silently rendered as an empty result.
 *
 * @module dsh-professor-spike/src/app/owner
 */

import { createAppStorage } from './storage.js'

/** The cordis service name the owner publishes under. */
export const APP_OWNER_SERVICE = 'professorAppStorage'

/**
 * Raised when a caller uses a facet after its own release, or after the owner was disposed.
 *
 * Distinct from every storage availability error on purpose: this is a lifecycle error, so retrying
 * the same call forever cannot fix it.
 */
export const APP_OWNER_DISPOSED_CODE = 'PROFESSOR_APP_STORAGE_DISPOSED'

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * Create the shared owner.
 *
 * @param options.ctx - cordis context (used when no `createStorage` is injected).
 * @param options.logger - plugin logger.
 * @param options.readVersion - `() => Promise<string>`; this package's version, recorded once.
 * @param options.now - clock (tests).
 * @param options.createStorage - factory returning one {@link createAppStorage} handle; injected so
 *   tests can count real opens against the host-faithful fake domain.
 * @returns `{ describe, acquire, stats, dispose }`.
 */
export function createAppStorageOwner(options = {}) {
  const { ctx, logger, readVersion, now, createStorage } = options

  let disposed = false
  let acquisitions = 0
  /** Live facets, in acquisition order. Membership is the refcount. */
  const consumers = new Set()

  const storage = typeof createStorage === 'function'
    ? createStorage()
    : createAppStorage({
      ctx, logger, readVersion, ...(now === undefined ? {} : { now }),
    })

  /** Refuse when this facet's lifetime ended or the owner was disposed. */
  function current(facet) {
    if (disposed || facet.alive !== true) {
      throw fail(APP_OWNER_DISPOSED_CODE, 'Professor application storage has already been released; refusing to answer from a disposed handle')
    }
    return facet
  }

  /** Owner-level snapshot: what mounted, who consumes it, and what the storage reports. */
  function describe() {
    return {
      service: APP_OWNER_SERVICE,
      consumers: consumers.size,
      acquisitions,
      disposed,
      storage: storage.describe(),
    }
  }

  /**
   * Release one facet. Idempotent: a second release is a no-op rather than a double decrement that
   * would close a domain another consumer is still using.
   */
  async function release(facet) {
    if (facet.alive !== true) return describe()
    facet.alive = false
    consumers.delete(facet)
    // The last consumer owns closing the domain. Everyone else's release touches nothing.
    if (consumers.size === 0) await storage.close()
    return describe()
  }

  /**
   * Take one consumer's handle on the shared storage.
   *
   * The facet mirrors {@link createAppStorage}'s own surface, so existing consumers (memory,
   * onboarding, the session registry) need no change beyond where the handle came from.
   *
   * @param label - who is acquiring; reported in diagnostics.
   * @returns the facet (`{ ensureOpen, table, writeRecord, describe, release, label }`).
   * @throws with {@link APP_OWNER_DISPOSED_CODE} when the owner has already been disposed.
   */
  function acquire(label = 'unknown') {
    if (disposed) {
      throw fail(APP_OWNER_DISPOSED_CODE, 'Professor application storage has been disposed; no further consumers can attach')
    }
    acquisitions += 1
    const facet = { label, alive: true }

    facet.describe = () => {
      current(facet)
      return storage.describe()
    }
    facet.ensureOpen = async () => {
      current(facet)
      const snapshot = await storage.ensureOpen()
      // The open is a round-trip through the host; this facet may have ended while it was in
      // flight. Reporting success from a dead handle would resurrect disposed state.
      current(facet)
      return snapshot
    }
    facet.writeRecord = async (key, record) => {
      current(facet)
      const snapshot = await storage.writeRecord(key, record)
      current(facet)
      return snapshot
    }
    // Deliberately synchronous and lenient while the domain is merely *unopened*: returning
    // `undefined` is what lets every caller surface "storage unavailable" instead of an empty result.
    // Only a released/disposed caller throws.
    facet.table = (name) => {
      current(facet)
      return storage.table(name)
    }
    facet.release = () => release(facet)

    consumers.add(facet)
    return facet
  }

  /**
   * Tear the owner down: invalidate every facet, then release the domain exactly once.
   *
   * Order matters — `disposed` is set **before** the awaited close, so no operation can slip between
   * the decision and the release and act as though storage were still owned.
   */
  async function dispose() {
    if (disposed) return describe()
    disposed = true
    for (const facet of [...consumers]) facet.alive = false
    consumers.clear()
    await storage.close()
    return describe()
  }

  return { describe, acquire, dispose }
}
