/**
 * Phase 1 (M1) — `professor_app` record validation.
 *
 * The defect these tests pin
 * --------------------------
 * `APP_VALUE_SCHEMA.parse()` checked only the outermost `typeof`, so it accepted `NaN`, `Infinity`,
 * `{ x: undefined }`, `{ x: 1n }` and every other value that `JSON.stringify` silently rewrites or
 * drops. That is worse than a missing check here, because the host's **write** path performs no
 * validation at all: the medium would store the mangled value and the corrupt record would only be
 * discovered on the *next* open, when the load path validates it. So the validator must be lossless
 * or refuse.
 *
 * The contract under test: a record is a plain JSON object or array whose entire reachable graph
 * survives `JSON.stringify` → `JSON.parse` unchanged. `null` is accepted anywhere *inside* a record
 * but not as the record itself (it is the medium's "never written" sentinel).
 *
 * The second defect these tests pin
 * --------------------------------
 * The array walker accepted any property name matching `/^(?:0|[1-9]\d*)$/`, which includes
 * `"4294967295"` and everything above it. Those are **not** array indices — they do not affect
 * `length` and `JSON.stringify` omits them — so a member could be dropped while the record was
 * declared valid. Reproduced:
 *
 * ```js
 * const value = []
 * value['4294967295'] = 'lost'
 * validateRecord(value)  // accepted
 * JSON.stringify(value)  // "[]"
 * ```
 *
 * The same walker also read array elements through `array[index]`, which **invokes an accessor's
 * getter** during validation. A validator must inspect descriptors, never run the code it is
 * supposed to be checking.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APP_BOOTSTRAP_KEY,
  APP_VALUE_MAX_DEPTH,
  APP_VALUE_SCHEMA,
  createAppStorage,
  validateRecord,
} from '../src/app/storage.js'

/** Assert the validator refuses `value`, naming a path, and never returns it. */
function assertRefused(value, expected, label) {
  assert.throws(
    () => validateRecord(value),
    (error) => {
      assert.equal(error.name, 'TypeError', `${label}: refuses with a TypeError`)
      assert.equal(error.code, 'PROFESSOR_APP_RECORD_INVALID', `${label}: carries the refusal code`)
      assert.match(error.message, expected, `${label}: names the reason`)
      return true
    },
    label,
  )
  const safe = APP_VALUE_SCHEMA.safeParse(value)
  assert.equal(safe.success, false, `${label}: safeParse agrees instead of throwing`)
}

// --- 1. accepted records ----------------------------------------------------

test('a nested object/array record with permitted nulls is accepted and returned unchanged', () => {
  const record = {
    schema: 'professor.app/1',
    course: null,
    counts: [1, 2, 3],
    nested: { deep: { flag: true, when: null, list: ['a', null, { k: 'v' }] } },
    empty: {},
    emptyList: [],
  }
  assert.equal(validateRecord(record), record, 'the same value comes back, not a copy')
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record, 'the whole graph round-trips exactly')
})

test('a top-level array is a record; a bare null or scalar is not', () => {
  assert.deepEqual(validateRecord([1, 'two', null, { three: 3 }]), [1, 'two', null, { three: 3 }])
  assertRefused(null, /not null or undefined/, 'null record')
  assertRefused(undefined, /not null or undefined/, 'undefined record')
  assertRefused('text', /must be a JSON object or array, got string/, 'string record')
  assertRefused(42, /must be a JSON object or array, got number/, 'number record')
})

test('a boundary-depth record is accepted and one level deeper is refused by the documented policy', () => {
  /** A chain of `{ next: … }` objects `depth` containers deep, ending in a scalar. */
  const chain = (depth) => {
    let node = { leaf: true }
    for (let i = 1; i < depth; i += 1) node = { next: node }
    return node
  }
  // depth counts containers: the record is 1, and each `next` adds one.
  assert.ok(validateRecord(chain(APP_VALUE_MAX_DEPTH)), `depth ${APP_VALUE_MAX_DEPTH} is accepted`)
  assertRefused(chain(APP_VALUE_MAX_DEPTH + 1), new RegExp(`exceeds the supported depth of ${APP_VALUE_MAX_DEPTH}`), 'too deep')
})

// --- 2. values JSON silently rewrites --------------------------------------

test('non-finite numbers are refused at every position', () => {
  assertRefused({ x: Number.NaN }, /non-finite number NaN/, 'NaN member')
  assertRefused({ x: Number.POSITIVE_INFINITY }, /non-finite number Infinity/, 'Infinity member')
  assertRefused({ x: Number.NEGATIVE_INFINITY }, /non-finite number -Infinity/, '-Infinity member')
  assertRefused({ list: [1, Number.NaN] }, /\$\.list\[1\]: non-finite number NaN/, 'NaN inside an array, path named')
  assertRefused({ x: -0 }, /negative zero/, 'negative zero (serialises to 0)')
})

test('nested undefined, BigInt, functions and symbols are refused with their path', () => {
  assertRefused({ a: { b: undefined } }, /\$\.a\.b: undefined is not a JSON value/, 'nested undefined')
  assertRefused({ x: 1n }, /\$\.x: bigint is not a JSON value/, 'BigInt member')
  assertRefused({ x: [10n] }, /\$\.x\[0\]: bigint is not a JSON value/, 'BigInt in an array')
  assertRefused({ x: () => {} }, /\$\.x: function is not a JSON value/, 'function member')
  assertRefused({ x: Symbol('s') }, /\$\.x: symbol is not a JSON value/, 'symbol member')
  assertRefused({ x: [Promise.resolve()] }, /\$\.x\[0\]/, 'nested promise')
})

// --- 3. containers whose shape would change --------------------------------

test('a circular reference is refused rather than reaching the serialiser', () => {
  const record = { name: 'loop' }
  record.self = record
  assertRefused(record, /\$\.self: circular reference/, 'direct cycle')

  const a = { label: 'a' }
  const b = { label: 'b', a }
  a.b = b
  assertRefused(a, /circular reference/, 'indirect cycle')

  // A repeated but non-cyclic reference is legitimate (a DAG), not a cycle.
  const shared = { shared: true }
  assert.deepEqual(validateRecord({ one: shared, two: shared }), { one: shared, two: shared })
})

test('sparse arrays and arrays carrying extra properties are refused', () => {
  /** eslint-disable-next-line no-sparse-arrays -- the hole IS the subject of the test. */
  const sparse = [1, , 3]
  assertRefused({ x: sparse }, /\$\.x\[1\]: sparse array/, 'sparse array')

  const tagged = [1, 2]
  tagged.note = 'extra'
  assertRefused({ x: tagged }, /extra property "note"/, 'array with an extra property')
})

test('objects that serialise into a different shape are refused', () => {
  class Course {
    constructor() { this.id = 'csc3200' }
  }
  assertRefused({ x: new Date(0) }, /not a plain JSON object/, 'Date (becomes a string)')
  assertRefused({ x: new Map() }, /not a plain JSON object/, 'Map (becomes {})')
  assertRefused({ x: new Set([1]) }, /not a plain JSON object/, 'Set (becomes {})')
  assertRefused({ x: /re/g }, /not a plain JSON object/, 'RegExp (becomes {})')
  assertRefused({ x: new Error('boom') }, /not a plain JSON object/, 'Error (becomes {})')
  assertRefused({ x: new Uint8Array([1, 2]) }, /not a plain JSON object/, 'typed array (becomes an index map)')
  assertRefused({ x: new Course() }, /not a plain JSON object/, 'class instance (prototype is lost)')
  assertRefused({ x: new (class Box {})() }, /not a plain JSON object/, 'anonymous class instance')
})

test('property kinds JSON would drop are refused, not silently removed', () => {
  const record = {}
  Object.defineProperty(record, 'hidden', { value: 1, enumerable: false })
  assertRefused(record, /\$\.hidden: a non-enumerable property would be dropped/, 'non-enumerable property')

  const symbolKeyed = { visible: 1 }
  symbolKeyed[Symbol('key')] = 2
  assertRefused(symbolKeyed, /symbol-keyed properties would be dropped/, 'symbol key')

  const accessor = { get computed() { return 1 } }
  assertRefused(accessor, /\$\.computed: an accessor property/, 'accessor property')
})

// --- 3b. array properties that are not elements -----------------------------

/** `2 ** 32 - 2`: the largest index an array can actually have. `2 ** 32 - 1` is *not* an index. */
const MAX_INDEX = 2 ** 32 - 2

/** Escape a literal for use inside a `RegExp`, so a property name can be matched verbatim. */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('a numeric-looking array property that JSON omits is refused, at the index boundary', () => {
  // The reproduction from the acceptance brief. `4294967295` is `2 ** 32 - 1`: it looks like an
  // index and is not one, so it leaves `length` alone and `JSON.stringify` drops it.
  const brief = []
  brief['4294967295'] = 'lost'
  assert.equal(brief.length, 0, 'it really is not an index: the length is untouched')
  assert.equal(JSON.stringify(brief), '[]', 'and JSON really would drop it')
  assertRefused({ list: brief }, /extra property "4294967295"/, '2 ** 32 - 1 in a record')
  assertRefused(brief, /extra property "4294967295"/, '2 ** 32 - 1 as the record itself')

  for (const name of [String(MAX_INDEX + 1), '4294967296', '9999999999', '01', '007', '1.0', '+1', '-1', ' 1', '1e2', '0x2', '1_0']) {
    const tagged = [1, 2, 3]
    tagged[name] = 'dropped'
    assert.equal(tagged.length, 3, `${name}: assigning it does not add an element`)
    assert.equal(JSON.stringify(tagged), '[1,2,3]', `${name}: JSON omits it`)
    assertRefused({ list: tagged }, new RegExp(`extra property ${literal(JSON.stringify(name))}`), `property ${name}`)
  }
})

test('the array-index boundary is exact, and a 2 ** 32 - 1 length is refused in bounded time', () => {
  // `2 ** 32 - 2` is the largest index an array can have, because `length` is capped at `2 ** 32 - 1`
  // and this array really does carry it. It must therefore be treated as an *element*: the refusal
  // has to come from the hole at index 0, not from misreading the index as an extra property. An
  // off-by-one at the boundary would report `extra property "4294967294"` and lose a real member.
  const huge = []
  huge[MAX_INDEX] = 'kept'
  assert.equal(huge.length, MAX_INDEX + 1, 'the length really is 2 ** 32 - 1')

  const started = Date.now()
  assertRefused(
    { huge },
    /sparse array \(a hole serialises as null\)/,
    'the largest real index is an element, so what is refused is the hole',
  )
  assert.ok(Date.now() - started < 1000, `refused in ${Date.now() - started}ms: the hole is found, the whole range is not walked`)
})

test('an array accessor element is refused without ever invoking its getter', () => {
  let reads = 0
  const withGetter = [1, 2, 3]
  Object.defineProperty(withGetter, 1, {
    get() { reads += 1; return 'computed' },
    enumerable: true,
    configurable: true,
  })
  assert.equal(withGetter.length, 3, 'the accessor occupies a real index')
  assertRefused({ list: withGetter }, /\$\.list\[1\]: an accessor element/, 'getter element')
  assert.equal(reads, 0, 'the getter was never invoked: the descriptor is inspected, not the value')

  let writes = 0
  const withSetter = [1, 2, 3]
  Object.defineProperty(withSetter, 0, {
    set() { writes += 1 },
    enumerable: true,
    configurable: true,
  })
  assertRefused({ list: withSetter }, /\$\.list\[0\]: an accessor element/, 'setter-only element')
  assert.equal(writes, 0, 'the setter was never invoked either')

  // The stricter element checks must not weaken the ones that were already there.
  const hidden = [1, 2, 3]
  Object.defineProperty(hidden, 2, { value: 3, enumerable: false, writable: true, configurable: true })
  assertRefused({ list: hidden }, /\$\.list\[2\]: a non-enumerable element/, 'non-enumerable element')

  const symbolTagged = [1]
  symbolTagged[Symbol('tag')] = 2
  assertRefused({ list: symbolTagged }, /symbol-keyed properties would be dropped/, 'symbol-tagged array')
})

test('ordinary arrays are still accepted, including nested, empty and long ones', () => {
  const trimmed = [1, 2, 3]
  trimmed.length = 2 // shrinking loses an element rather than leaving a hole: still lossless
  const record = {
    empty: [],
    one: [null],
    nested: [[1, [2, [3]]], 'a', [{}]],
    dense: Array.from({ length: 1000 }, (_, index) => index),
    trimmed,
    objects: [{ k: 1 }, {}],
  }
  assert.equal(validateRecord(record), record, 'the same value comes back, not a copy')
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record, 'the whole graph round-trips exactly')
  assert.deepEqual(validateRecord([[], [[]], [1, 'two', null, { three: 3 }]]), [[], [[]], [1, 'two', null, { three: 3 }]])
})

test('a null-prototype object is accepted, because it serialises like any other plain object', () => {
  const record = Object.create(null)
  record.owner = 'dsh-professor-spike'
  assert.equal(validateRecord(record), record, 'the same value comes back, not a copy')
  // Compared through the serialiser on purpose: the point is that `JSON.stringify` treats a
  // null-prototype object exactly like an ordinary one. A direct `deepEqual` would compare
  // prototypes and fail on the very difference that is being shown to be irrelevant.
  assert.deepEqual(
    JSON.parse(JSON.stringify(record)),
    { owner: 'dsh-professor-spike' },
    'and it serialises into an ordinary object with the same members',
  )
})

// --- 4. persistence ---------------------------------------------------------

/**
 * A storage service that behaves like the shipped JSON backend: the medium is **text**, `put` writes
 * through a real `JSON.stringify`, and `open()` re-validates every stored record through the declared
 * schema before handing the domain back. That load path is what makes a mangled record a *later*
 * failure instead of an immediate one — so the fake reproduces it faithfully.
 */
function textMediumService() {
  const state = { text: undefined, opens: 0 }

  const readState = () => (state.text === undefined ? { tables: { app: {} } } : JSON.parse(state.text))
  const writeState = (value) => { state.text = JSON.stringify(value) }

  return {
    state,
    ctx: {
      get: (name) => (name === 'storageDomain'
        ? {
          async open(spec) {
            state.opens += 1
            const snapshot = readState()
            for (const [table, tableSpec] of Object.entries(spec.tables ?? {})) {
              for (const [key, raw] of Object.entries(snapshot.tables[table] ?? {})) {
                try {
                  tableSpec.valueSchema.parse(raw)
                } catch (error) {
                  const invalid = new Error(`invalid-record: domain '${spec.name}': stored record '${key}' in table '${table}' does not match its schema`)
                  invalid.code = 'invalid-record'
                  invalid.cause = error
                  throw invalid
                }
              }
            }
            return {
              async close() {},
              table(tableName) {
                return {
                  get: (key) => readState().tables[tableName]?.[key],
                  async put(key, value) {
                    const current = readState()
                    current.tables[tableName] = { ...(current.tables[tableName] ?? {}), [key]: value }
                    writeState(current)
                  },
                  async update(key, transform) {
                    const current = readState()
                    current.tables[tableName] = { ...(current.tables[tableName] ?? {}), [key]: transform(current.tables[tableName]?.[key]) }
                    writeState(current)
                  },
                  get size() { return Object.keys(readState().tables[tableName] ?? {}).length },
                }
              },
            }
          },
        }
        : undefined),
    },
  }
}

test('a valid record survives persistence and a reopen, and nothing is dropped', async () => {
  const medium = textMediumService()
  const first = createAppStorage({ ctx: medium.ctx, readVersion: async () => '0.12.0' })

  const opened = await first.ensureOpen()
  assert.equal(opened.status, 'open', 'the domain opens against a text medium')
  assert.equal(opened.bootstrapped, true, 'and writes its own bootstrap marker')

  const record = {
    schema: 'professor.app/1',
    kind: 'preference',
    note: null,
    tags: ['study', 'exam'],
    nested: { revision: 3, flags: [true, false] },
  }
  await first.writeRecord('preference/lang', record)
  await first.close()

  const text = medium.state.text
  assert.ok(typeof text === 'string' && text.includes('preference/lang'), 'the record really reached the text medium')
  assert.deepEqual(JSON.parse(text).tables.app['preference/lang'], record, 'the stored value is byte-for-byte the record')

  // A FRESH handle over the same bytes: the load path validates every record, so this is the check
  // that a mangled record would fail.
  const second = createAppStorage({ ctx: medium.ctx, readVersion: async () => '0.12.0' })
  const reopened = await second.ensureOpen()
  assert.equal(reopened.status, 'open', 'the domain reopens: the stored records passed validation')
  assert.equal(reopened.bootstrapped, false, 'the existing marker is recognised')
  assert.deepEqual(second.table('app').get('preference/lang'), record, 'the record reads back intact')
  assert.equal(second.table('app').size, 2, 'the bootstrap marker and the preference are both there')
  await second.close()
})

test('writeRecord refuses an invalid record before it reaches the medium', async () => {
  const medium = textMediumService()
  const storage = createAppStorage({ ctx: medium.ctx, readVersion: async () => '0.12.0' })
  await storage.ensureOpen()
  const before = medium.state.text

  await assert.rejects(
    () => storage.writeRecord('bad', { x: Number.NaN }),
    /non-finite number NaN/,
    'the write is refused',
  )
  await assert.rejects(() => storage.writeRecord('bad', { deep: { bad: 1n } }), /bigint is not a JSON value/)
  assert.equal(medium.state.text, before, 'nothing was written, so nothing already stored was touched')
  assert.equal(storage.table('app').get('bad'), undefined, 'the refused key does not exist')
  assert.ok(storage.table('app').get(APP_BOOTSTRAP_KEY), 'the bootstrap marker survived the refusals')
  await storage.close()
})

test('a lossy array is refused before it reaches the medium, leaving stored records untouched', async () => {
  const medium = textMediumService()
  const storage = createAppStorage({ ctx: medium.ctx, readVersion: async () => '0.12.0' })
  await storage.ensureOpen()
  const before = medium.state.text

  const list = [1, 2]
  list['4294967295'] = 'lost'
  await assert.rejects(
    () => storage.writeRecord('preference/lossy', { schema: 'professor.app/1', list }),
    /extra property "4294967295"/,
    'the write is refused, so the mangled array can never poison the next open',
  )

  let reads = 0
  const accessor = [1]
  Object.defineProperty(accessor, 0, { get() { reads += 1; return 1 }, enumerable: true, configurable: true })
  await assert.rejects(
    () => storage.writeRecord('preference/accessor', { schema: 'professor.app/1', list: accessor }),
    /accessor element/,
    'and so is an array whose element is an accessor',
  )
  assert.equal(reads, 0, 'no getter ran while deciding that')

  assert.equal(medium.state.text, before, 'nothing was written, so nothing already stored was changed')
  assert.equal(storage.table('app').get('preference/lossy'), undefined, 'the refused key does not exist')
  assert.equal(storage.table('app').get('preference/accessor'), undefined)
  assert.ok(storage.table('app').get(APP_BOOTSTRAP_KEY), 'the bootstrap marker survived the refusals')
  await storage.close()
})

test('the bootstrap record the plugin actually writes satisfies its own schema', async () => {
  const medium = textMediumService()
  const storage = createAppStorage({ ctx: medium.ctx, readVersion: async () => '0.12.0' })
  await storage.ensureOpen()
  const record = storage.table('app').get(APP_BOOTSTRAP_KEY)
  assert.deepEqual(validateRecord(record), record, 'the shipped marker passes the shipped validator')
  await storage.close()
})
