/**
 * Professor application storage — the plugin's own persistence, independent of any course.
 *
 * Why this module exists
 * ----------------------
 * Everything Professor remembers used to live either inside a course folder (`.professor/state/…`,
 * which requires a connected folder) or nowhere at all. The v1 requirement is that a *fresh*
 * install works with no academic folder connected: a general academic session must still be able to
 * keep its own state, and that state must be neither course material nor a file inside the plugin
 * package.
 *
 * The supported mechanism is the Harness storage domain (`ctx.storageDomain`), verified on the
 * installed host in `docs/v1/HARNESS_API_AUDIT.md` §6 and again by `tools/verify-app-storage.mjs`:
 *
 * ```text
 * ctx.storageDomain.open({ name, version, tables }) -> Domain
 * domain.table(name) -> { get, put, update, delete, size }   // get() is synchronous
 * domain.close()
 * ```
 *
 * Ownership and location
 * ----------------------
 * The plugin declares exactly one domain, `professor_app`, at version 1. Where the bytes land is
 * the **host's** routing decision, not this package's: a domain plugin maps a domain name to a
 * backend, and the shipped JSON backend writes `<DSH_HOME>/storages/<domain>.json` (so
 * `~/.dsh/storages/professor_app.json` by default, and `$DSH_HOME/storages/professor_app.json` in a
 * disposable profile). `defaultPathHint` reports that documented default; it is a *hint*, and this
 * module never reads or writes that path itself.
 *
 * Degradation
 * -----------
 * Opening is **lazy**, never part of `apply`: a host whose storage service is missing, unrouted or
 * broken must still start a Professor session, and must say what it could not observe. Failure is
 * memoised so a broken backend is reported once rather than retried on every tool call.
 *
 * @module dsh-professor-spike/src/app/storage
 */

/** The single domain this plugin owns. Must match the backend's `/^[a-z][a-z0-9_]*$/` unit name. */
export const APP_DOMAIN_NAME = 'professor_app'

/** Domain schema version. A bump requires an explicit migration; the host refuses a mismatch. */
export const APP_DOMAIN_VERSION = 1

/** Identifier recorded in the bootstrap record, so a stray domain file can be attributed. */
export const APP_STORAGE_OWNER = 'dsh-professor-spike'

/** Schema tag of the records this module writes. */
export const APP_RECORD_SCHEMA = 'professor.app/1'

/** The one row written at first open, so an initialised domain is distinguishable from an empty one. */
export const APP_BOOTSTRAP_KEY = 'bootstrap'

/**
 * Maximum nesting depth of a stored record.
 *
 * The medium is JSON, and a record is walked on every open. The bound exists so a pathological
 * record cannot turn "load the domain" into unbounded work, and so a storage bug is a clear refusal
 * at write time rather than a stack overflow somewhere else. Depth counts **containers**: the record
 * itself is depth 1, its members are depth 2, and so on. A container at depth `n` is therefore
 * admitted when `n <= APP_VALUE_MAX_DEPTH`, and the scalars it holds may sit at depth
 * `n + 1`. 32 is far beyond anything this plugin stores (the bootstrap record is depth 2) while
 * still admitting comfortably nested note metadata.
 */
export const APP_VALUE_MAX_DEPTH = 32

/**
 * The accepted record shape, as one sentence: **a plain JSON object or array, whose entire reachable
 * graph round-trips through `JSON.stringify`/`JSON.parse` without losing or inventing anything.**
 *
 * That "lossless" clause is the whole contract, and it is stricter than `typeof value === 'object'`:
 *
 * | Refused | Why |
 * |---|---|
 * | `undefined`, `BigInt`, `Function`, `Symbol` | not JSON types at all; `JSON.stringify` drops or renames them |
 * | `NaN`, `±Infinity` | serialise to `null`, so the stored value is a **different** value |
 * | `-0` | serialises to `0`; the sign is silently coerced away |
 * | `Date`, `Map`, `Set`, `RegExp`, `Error`, typed arrays, class instances | not plain objects; each serialises into a *different shape* (a string, `{}`, …) |
 * | a circular reference | `JSON.stringify` throws, so the medium never sees the value |
 * | a sparse array | holes serialise to `null` |
 * | an array property that is not a real index (`"4294967295"`, `"1e2"`, `"01"`) | not an element at all — it does not count towards `length` and the serialiser omits it, so the stored array would be a *different* array |
 * | symbol keys, non-enumerable properties, accessors | dropped or re-evaluated by the serialiser; an accessor (on an object **or** an array) is refused from its descriptor, so its getter is never invoked |
 * | nesting past {@link APP_VALUE_MAX_DEPTH} | bounded by policy, see above |
 *
 * **Null policy.** `null` is a legitimate JSON value and is accepted **anywhere inside** a record.
 * It is refused as the *record itself*, because `null` is the medium's "never written" sentinel for
 * the global slot (`dsh-storage-domain` rejects a global schema that accepts `null` for exactly this
 * reason), so a record that *is* `null` could not be told apart from an absent one on reopen. The
 * plugin's records are always objects, so nothing is lost by refusing a bare `null`.
 *
 * **What it deliberately does not do.** It does not validate *fields*: it does not know that
 * `created_at` should be a timestamp. That stays with the module that owns each record, which can
 * say something useful about which field was wrong. This validator answers one question only — can
 * the medium hold this value without changing it?
 *
 * ## Why this exists instead of a schema library
 *
 * The host's `valueSchema` contract is narrow and exact: it is treated as a zod-like object and the
 * loader calls **one** method on it — `valueSchema.parse(raw)` (`dsh-storage-domain/lib/index.js`,
 * the open-time `loadAll` loop; `defineDomain` does not inspect `valueSchema` at all, and the write
 * path never validates). The plugin therefore implements that one method rather than taking a
 * dependency: it declares no host packages, so `import '@deepseek-ai/schemastery'` from a profile
 * bundle would not resolve.
 *
 * Because the host's **write** path does no validation, an invalid record would land in the medium
 * intact and only explode on the *next* open — the failure mode that made the missing `valueSchema`
 * so hard to see. Writes therefore go through {@link createAppStorage}'s `writeRecord`, which
 * validates first and refuses before anything reaches the medium.
 *
 * ## `invalidRecords: 'backup-and-skip'` is deliberately NOT declared
 *
 * The domain layer honours that policy only when the opened unit exposes `backupRecord`, and the
 * shipped JSON backend exposes it **only** on the `per-record` layout. This domain uses the default
 * `single` layout (one `<DSH_HOME>/storages/professor_app.json`), whose unit has no `backupRecord`,
 * so declaring the policy would be a no-op that reads like a safety net. It is left off rather than
 * claimed. A future phase that needs it must also switch the layout and prove it on the real host.
 */

/** A JSON object literally: `{}` or `Object.create(null)`. Anything else has its own serialisation. */
function isPlainObject(value) {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** A short human description, used only in error messages. */
function describeValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value !== 'object') return typeof value
  const name = value?.constructor?.name
  return name === undefined || name === 'Object' || name === '' ? 'an object' : `a ${name}`
}

/** Build the refusal. `path` is a JSON-path so the offending member is named, not just the record. */
function refuse(path, detail) {
  const error = new TypeError(`professor_app record is not losslessly JSON-serialisable at ${path}: ${detail}`)
  error.code = 'PROFESSOR_APP_RECORD_INVALID'
  error.path = path
  return error
}

/**
 * The largest index an array can actually have: `2 ** 32 - 2`.
 *
 * An array's `length` is capped at `2 ** 32 - 1`, so the highest index that can ever exist is one
 * below that. `"4294967295"` — one *more* — is **not** an index: it is an ordinary string property
 * that merely looks numeric, so it does not count towards `length` and `JSON.stringify` drops it
 * without a word. Reproduced:
 *
 * ```js
 * const value = []
 * value['4294967295'] = 'lost'
 * validateRecord(value)  // accepted, before the fix
 * JSON.stringify(value)  // "[]" — the member is gone
 * ```
 */
const MAX_ARRAY_INDEX = 4294967294

/** A canonical array-index property name: no sign, no leading zero, no exponent, no whitespace. */
const CANONICAL_ARRAY_INDEX = /^(?:0|[1-9]\d*)$/

/** Walk one array: no holes, no extra properties, no symbol keys, no accessors, every element valid. */
function walkArray(array, path, depth, ancestors) {
  if (Object.getOwnPropertySymbols(array).length > 0) {
    throw refuse(path, 'symbol-keyed properties would be dropped by JSON')
  }
  for (const name of Object.getOwnPropertyNames(array)) {
    if (name === 'length') continue
    // A property name is an *element* only when it is a canonical index the array can actually have.
    // `"4294967295"`, `"1e2"` and `"01"` are not indices — they leave `length` alone and
    // `JSON.stringify` omits them — so accepting one would mean storing a different array than the
    // caller handed in. See {@link MAX_ARRAY_INDEX}.
    const index = Number(name)
    if (!CANONICAL_ARRAY_INDEX.test(name) || index > MAX_ARRAY_INDEX || index >= array.length) {
      throw refuse(path, `array carries an extra property ${JSON.stringify(name)} that JSON would drop`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(array, name)
    if (descriptor?.enumerable !== true) {
      throw refuse(`${path}[${name}]`, 'a non-enumerable element would be dropped by JSON')
    }
    // Descriptors are inspected here and the elements are read further down, in that order and on
    // purpose: an element defined as an accessor must be refused **without invoking its getter**.
    // Running the code under validation, and then trusting a value a later read need not reproduce,
    // is not a validation strategy — the getter can have side effects, and what it returns is not
    // necessarily what the serialiser would see.
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw refuse(`${path}[${name}]`, 'an accessor element cannot be serialised faithfully (its getter is never invoked to inspect it)')
    }
  }
  for (let index = 0; index < array.length; index += 1) {
    if (!Object.hasOwn(array, index)) {
      throw refuse(`${path}[${index}]`, 'sparse array (a hole serialises as null)')
    }
    walk(array[index], `${path}[${index}]`, depth + 1, ancestors)
  }
}

/** Walk one object: a plain object only, every own property enumerable, no accessors. */
function walkObject(object, path, depth, ancestors) {
  if (!isPlainObject(object)) {
    throw refuse(path, `${describeValue(object)} is not a plain JSON object`)
  }
  if (Object.getOwnPropertySymbols(object).length > 0) {
    throw refuse(path, 'symbol-keyed properties would be dropped by JSON')
  }
  for (const key of Object.getOwnPropertyNames(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor?.enumerable !== true) {
      throw refuse(`${path}.${key}`, 'a non-enumerable property would be dropped by JSON')
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw refuse(`${path}.${key}`, 'an accessor property cannot be serialised faithfully')
    }
    walk(object[key], `${path}.${key}`, depth + 1, ancestors)
  }
}

function walk(value, path, depth, ancestors) {
  if (value === null) return
  const type = typeof value
  if (type === 'string' || type === 'boolean') return
  if (type === 'number') {
    if (!Number.isFinite(value)) throw refuse(path, `non-finite number ${String(value)}`)
    if (Object.is(value, -0)) throw refuse(path, 'negative zero does not survive a JSON round-trip')
    return
  }
  if (type !== 'object') {
    throw refuse(path, `${type} is not a JSON value`)
  }
  // The bound is checked here, on the value that is *about to be descended into*, so it counts
  // containers exactly as documented. Checking it before the scalar cases above would also count
  // the innermost leaf, refusing a record that is one level short of the documented limit.
  if (depth > APP_VALUE_MAX_DEPTH) {
    throw refuse(path, `nesting exceeds the supported depth of ${APP_VALUE_MAX_DEPTH}`)
  }
  if (ancestors.has(value)) throw refuse(path, 'circular reference')
  ancestors.add(value)
  if (Array.isArray(value)) walkArray(value, path, depth, ancestors)
  else walkObject(value, path, depth, ancestors)
  ancestors.delete(value)
}

/**
 * Validate a record against {@link APP_VALUE_SCHEMA}'s contract.
 *
 * @param value - the candidate record.
 * @returns the same value, unchanged.
 * @throws {TypeError} with `code === 'PROFESSOR_APP_RECORD_INVALID'` and a JSON-path `path`.
 */
export function validateRecord(value) {
  if (value === null || value === undefined) {
    throw refuse('$', 'the record itself must be a JSON object or array, not null or undefined')
  }
  if (typeof value !== 'object') {
    throw refuse('$', `the record itself must be a JSON object or array, got ${typeof value}`)
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw refuse('$', `the record itself must be a plain JSON object or array, got ${describeValue(value)}`)
  }
  walk(value, '$', 1, new Set())
  return value
}

/** The host-facing schema object. See the long note above for the contract it implements. */
export const APP_VALUE_SCHEMA = Object.freeze({
  /**
   * @param raw - a record as the medium stored it, or a record about to be written.
   * @returns the same value.
   * @throws {TypeError} when the value is not losslessly JSON-serialisable.
   */
  parse(raw) {
    return validateRecord(raw)
  },

  /** The non-throwing form of {@link APP_VALUE_SCHEMA.parse}. */
  safeParse(raw) {
    try {
      return { success: true, data: APP_VALUE_SCHEMA.parse(raw) }
    } catch (error) {
      return { success: false, error }
    }
  },
})


/**
 * The domain spec, passed to `ctx.storageDomain.open()` unchanged.
 *
 * ## `valueSchema` is *required*, not optional — verified the hard way
 *
 * An earlier version of this module shipped `tables: { app: {} }`, on the reading that a bare table
 * opened and round-tripped a record. It does — but only **within one `open()`**. The host's domain
 * layer validates every stored record when it loads the unit (`dsh-storage-domain/lib/index.js`:
 * `tableSpec.valueSchema.parse(raw)`); with no schema that call is `undefined.parse(raw)`, which is
 * caught and rethrown as
 *
 * ```text
 * invalid-record: domain 'professor_app': stored record 'bootstrap' in table 'app' does not match its schema
 * ```
 *
 * so the domain opens, accepts writes, and then **refuses to reopen once anything has been
 * persisted** — application storage that works until the next process start. `tools/verify-app-storage.mjs`
 * proves the reopen path against the real host, which is what caught it.
 *
 * The plugin still takes **no schema-library dependency**: it declares no host packages, and a bare
 * `@deepseek-ai/schemastery` import from a profile bundle does not resolve. It ships
 * {@link APP_VALUE_SCHEMA} instead.
 */
export const APP_DOMAIN_SPEC = Object.freeze({
  name: APP_DOMAIN_NAME,
  version: APP_DOMAIN_VERSION,
  tables: { app: { valueSchema: APP_VALUE_SCHEMA } },
})

/** The shipped JSON backend's documented default location, relative to the Harness home. */
const DEFAULT_PATH_HINT = '$DSH_HOME/storages/professor_app.json'

/**
 * Create the application-storage handle for one plugin instance.
 *
 * ## Lifecycle
 *
 * Opening is lazy and the handle is **re-entrant**: every mutation is guarded by a monotonic
 * `epoch`, and an attempt may only touch state while its own epoch is still current.
 *
 * The defect this exists to prevent (reproduced, then fixed, in
 * `test/app-storage-lifecycle.test.mjs`): `ensureOpen()` starts the host's `open()` and stores the
 * pending promise; `close()` ran while that promise was pending and could not see the domain,
 * because no domain had been published yet. When the host finally granted one, the abandoned attempt
 * published it and set `status = 'open'` — **after** the handle had been closed — so the storage
 * resurrected itself and the acquired domain was never released.
 *
 * The second defect this exists to prevent (also reproduced, then fixed, in
 * `test/app-storage-lifecycle.test.mjs`): `close()` invalidated the epoch, awaited `handle.close()`
 * and then **unconditionally** wrote `status = 'closed'`. Because the release is a round-trip
 * through the host, a caller can reopen while it is in flight, so that late write overwrote a
 * *newer* lifecycle's status, reason and bootstrap information while the newer handle was still live
 * and reachable through `table()`.
 *
 * The rules, in one place:
 *
 *   - `epoch` is bumped by every `close()` and claimed by every new attempt, so an abandoned attempt
 *     can neither adopt a domain nor write a status;
 *   - **whoever clears `domain` owns releasing it**, so a handle is released exactly once — either by
 *     `close()`, or by the abandoned attempt that never published it, never by both;
 *   - **a lifecycle writes state only while its own epoch is current.** For `close()` that means the
 *     status is claimed *synchronously*, before the release is awaited, and nothing is written after
 *     it; for an open attempt it means every completion after an `await` — the domain, the status,
 *     the reason and the bootstrap information — is gated on the epoch. The `close()` method below
 *     carries the reproduction;
 *   - the bootstrap re-checks its epoch after every `await`, so a close during the version read or
 *     the write stops the write instead of continuing against a released handle;
 *   - concurrent `ensureOpen()` calls join the attempt for the current epoch instead of opening twice.
 *
 * @param options.ctx - the Cordis context (only `get('storageDomain')` is used, lazily).
 * @param options.logger - plugin logger (degradation and cleanup failures are reported, never thrown).
 * @param options.readVersion - `async () => string`; this package's version, recorded once.
 * @param options.now - clock (tests); defaults to `new Date().toISOString()`.
 * @returns `{ spec, describe, ensureOpen, table, writeRecord, close }`.
 */
export function createAppStorage(options = {}) {
  const { ctx, logger, readVersion, now = () => new Date().toISOString() } = options

  /** Monotonic attempt counter. See §Lifecycle above. */
  let epoch = 0
  /** The adopted host handle, or `undefined`. Only a published domain lives here. */
  let domain
  /** `{ epoch, promise }` — the in-flight (or completed) open for one epoch. */
  let opening
  let bootstrapped = false
  let status = 'unopened'
  let reason = null

  /** The storage-domain service, or undefined. Never throws: a probing context is not an error. */
  function resolveService() {
    try {
      if (typeof ctx?.get === 'function') {
        const viaGet = ctx.get('storageDomain')
        if (viaGet !== undefined) return viaGet
      }
      return ctx?.storageDomain
    } catch {
      return undefined
    }
  }

  /** A synchronous snapshot of what is known right now. Safe to call before and after opening. */
  function describe() {
    return {
      scope: 'application',
      owner: APP_STORAGE_OWNER,
      domain: APP_DOMAIN_NAME,
      version: APP_DOMAIN_VERSION,
      tables: Object.keys(APP_DOMAIN_SPEC.tables),
      status,
      reason,
      bootstrapped,
      defaultPathHint: DEFAULT_PATH_HINT,
      location: 'Harness storage domain (routed by the host; never inside the plugin package and never inside an academic folder)',
    }
  }

  /**
   * Release one acquired domain handle.
   *
   * A failure here is reported, never swallowed — a domain that refused to close is a fact the
   * operator needs, and it must not be presented as a clean shutdown.
   */
  async function releaseHandle(handle, cause) {
    if (handle === undefined || handle === null) return
    if (typeof handle.close !== 'function') {
      logger?.warn?.(`professor application storage was handed a domain without close() ${cause}`)
      return
    }
    try {
      await handle.close()
    } catch (error) {
      logger?.warn?.(`professor application storage could not release the domain ${cause}: ${error?.message ?? String(error)}`)
    }
  }

  /**
   * Write the ownership marker, once. Existing records are never rewritten.
   *
   * `isCurrent` is re-checked after **every** await, so a `close()` that lands during the version read
   * stops the write rather than letting it proceed against a released handle. A write already handed
   * to the host cannot be recalled; that case surfaces as a rejected write and is reported.
   */
  async function bootstrap(isCurrent, table) {
    const existing = table?.get?.(APP_BOOTSTRAP_KEY)
    if (existing !== undefined && existing !== null) return false
    const pluginVersion = typeof readVersion === 'function'
      ? await readVersion().catch(() => 'unknown')
      : 'unknown'
    if (!isCurrent()) return false
    await table.put(APP_BOOTSTRAP_KEY, {
      schema: APP_RECORD_SCHEMA,
      owner: APP_STORAGE_OWNER,
      domain: APP_DOMAIN_NAME,
      domain_version: APP_DOMAIN_VERSION,
      created_at: now(),
      plugin_version: pluginVersion,
    })
    return true
  }

  /** One open attempt. `myEpoch` is the epoch it claimed; it may only act while that is current. */
  async function openFor(myEpoch) {
    const isCurrent = () => myEpoch === epoch

    const service = resolveService()
    if (service === undefined || typeof service.open !== 'function') {
      if (isCurrent()) {
        status = 'unavailable'
        reason = 'ctx.storageDomain is not mounted on this host, so Professor application storage is unavailable'
      }
      return describe()
    }

    let acquired
    try {
      acquired = await service.open(APP_DOMAIN_SPEC)
    } catch (error) {
      if (isCurrent()) {
        status = 'unavailable'
        reason = `${error?.code ?? 'open-failed'}: ${error?.message ?? String(error)}`
        domain = undefined
      }
      return describe()
    }

    if (acquired === undefined || acquired === null || typeof acquired.table !== 'function') {
      if (isCurrent()) {
        status = 'unavailable'
        reason = 'open-failed: the storage service returned no usable domain handle'
        domain = undefined
      }
      // A handle that is not a domain cannot be closed; nothing was published, so nothing leaks.
      return describe()
    }

    // The handle exists from here on. If this attempt was cancelled while the host was opening, the
    // handle must be released and must never be adopted or reported as open.
    if (!isCurrent()) {
      await releaseHandle(acquired, 'acquired after the handle was closed')
      return describe()
    }

    // Publish. Nothing awaits between the check above and this line, so `close()` cannot interleave:
    // from here on, `close()` is the owner of the release.
    domain = acquired

    try {
      // The assignment is gated on the epoch for the same reason `close()` claims its status
      // synchronously: this `await` can outlive the attempt that started it, and a superseded
      // attempt must not overwrite the bootstrap information of the lifecycle that replaced it.
      const wrote = await bootstrap(isCurrent, acquired.table('app'))
      if (isCurrent()) bootstrapped = wrote
    } catch (error) {
      // The domain opened but its marker could not be written. The storage stays usable for reads and
      // the caller learns why the marker is missing, rather than silently having no marker.
      logger?.warn?.(`professor application storage opened but could not be bootstrapped: ${error?.message ?? String(error)}`)
    }

    // A close() that landed during the bootstrap already released this handle; do not double-release.
    if (!isCurrent()) return describe()

    status = 'open'
    reason = null
    return describe()
  }

  return {
    spec: APP_DOMAIN_SPEC,

    describe,

    /**
     * Open the domain if it is not open yet.
     *
     * Concurrent callers join the attempt for the current epoch. Once an attempt has resolved, later
     * calls return that same result without asking the host again (so a broken backend is reported
     * once, not retried on every tool call) until a `close()` starts a new epoch.
     *
     * @returns a promise of {@link describe}'s snapshot. Never rejects: an unavailable host is a
     *   reported state, not an exception, because a general Professor session must still work.
     */
    async ensureOpen() {
      if (opening !== undefined && opening.epoch === epoch) return opening.promise
      const myEpoch = epoch
      if (status === 'unopened' || status === 'closed') {
        status = 'opening'
        reason = null
      }
      const promise = openFor(myEpoch)
      opening = { epoch: myEpoch, promise }
      return promise
    },

    /** A table handle, or `undefined` when the domain is not open. */
    table(name) {
      if (domain === undefined || typeof domain.table !== 'function') return undefined
      return domain.table(name)
    },

    /**
     * Validate a record and write it through the host handle.
     *
     * This is the **validated** write path every future writer must use: the host's write path performs
     * no schema validation, so an invalid record would reach the medium intact and only explode on the
     * *next* open. `table()` remains available as a raw escape hatch for probe code.
     *
     * @returns the same snapshot shape as {@link describe}.
     * @throws {TypeError} when the record is not losslessly JSON-serialisable (nothing is written).
     */
    async writeRecord(key, record) {
      validateRecord(record)
      const table = this.table('app')
      if (table === undefined) {
        const error = new Error('professor application storage is not open, so no record was written')
        error.code = 'storage-not-open'
        throw error
      }
      await table.put(key, record)
      return describe()
    },

    /**
     * Release the domain handle and invalidate any in-flight attempt.
     *
     * Safe when nothing was opened, safe to call twice, and safe to call while an open is pending —
     * in that last case the abandoned attempt releases whatever the host grants it.
     *
     * ## Why the status is claimed *before* the release is awaited, and never after
     *
     * The release is a round-trip through the host, and a caller may legitimately reopen while it is
     * in flight. An earlier version set `status = 'closed'` **after** `await handle.close()`, which
     * meant a *superseded* close could overwrite a *newer* lifecycle's state — reproduced in
     * `test/app-storage-lifecycle.test.mjs` ("a stale close completion cannot overwrite a newer
     * lifecycle"): open A, start `close()` on A and keep its release pending, open and complete B,
     * then let A's release finish — the storage reported `closed` while B was still live and
     * reachable through `table()`.
     *
     * Writing the status in the synchronous part instead makes ownership unambiguous: nothing can
     * interleave between the epoch bump and the write, the write happens while this close is the
     * lifecycle in force, and the `await` afterwards touches no state at all. It is also the honest
     * report from the caller's point of view, because `table()` stops resolving at that same moment.
     * A failed release is surfaced through the logger — never by corrupting the status of the
     * lifecycle that may have replaced this one.
     */
    async close() {
      epoch += 1
      opening = undefined
      const handle = domain
      domain = undefined

      if (handle !== undefined && handle !== null) {
        status = 'closed'
        reason = null
        await releaseHandle(handle, 'during close')
        return
      }
      if (status === 'open' || status === 'opening') {
        status = 'closed'
        reason = null
      }
    },
  }
}

