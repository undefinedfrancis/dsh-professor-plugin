/**
 * The user learning-preset library: profile-level, versioned, in the existing app storage domain.
 *
 * Strictly separate from the immutable bundled definitions in `src/skills/presets.js` and from the
 * customization overlay itself: activating a preset copies a validated **snapshot** into the
 * overlay (via the existing customization store), and applied-preset metadata is its own additive
 * record — old customization records stay byte-compatible and are never rewritten here.
 *
 * Corrupt or unsupported stored data is reported and left untouched. Nothing here writes to the
 * user's course-material folders.
 *
 * @module dsh-professor-spike/src/app/presets
 */

import { validateCustomizationFields, customizationKey } from '../skills/customization.js'
import { BUILTIN_IDS, BUILTIN_ID_PREFIX, bundledPreset, BUNDLED_PRESETS, DEFAULT_PRESET_ID } from '../skills/presets.js'

export const PRESET_LIBRARY_SCHEMA = 'professor.presets/1'
export const PRESET_APPLIED_SCHEMA = 'professor.preset-applied/1'
export const USER_PRESET_LIMIT = 50

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const queues = new WeakMap()
const plain = value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const fail = (suffix, message) => Object.assign(new Error(message), { code: `PROFESSOR_PRESETS_${suffix}` })
const invalid = message => { throw fail('INVALID', message) }
const text = (value, limit, name, { allowEmpty = false } = {}) => {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    invalid(`${name} must be bounded text without control characters`)
  }
  const trimmed = value.trim()
  if (!allowEmpty && trimmed === '') invalid(`${name} must not be empty`)
  return trimmed
}

/**
 * Validate one user preset definition and return a detached, normalized copy.
 *
 * Names (80) and descriptions (240) are enforced exactly as documented; teaching fields go through
 * the existing customization validator, so `additionalInstructions` keeps its 2048 budget and is
 * **rejected**, never silently truncated, when over it.
 */
export function validatePresetDefinition(definition) {
  if (!plain(definition)) invalid('A preset definition must be a plain object')
  const allowed = ['id', 'name', 'description', 'fields', 'version', 'provenance']
  if (Reflect.ownKeys(definition).some(key => typeof key !== 'string' || !allowed.includes(key))) {
    invalid('Unexpected preset definition field')
  }
  const id = text(definition.id, 64, 'id')
  if (!ID_PATTERN.test(id)) invalid('Preset id must be lowercase letters, digits and dashes')
  if (id.startsWith(BUILTIN_ID_PREFIX) || BUILTIN_IDS.includes(id) || bundledPreset(id) !== undefined) {
    invalid('Builtin preset ids are reserved; copy the builtin under a new id instead')
  }
  const name = text(definition.name, 80, 'name')
  const description = text(definition.description, 240, 'description')
  if (definition.version === undefined || !Number.isSafeInteger(definition.version) || definition.version < 1) {
    invalid('Preset version must be a positive integer')
  }
  let fields
  try {
    fields = validateCustomizationFields(definition.fields)
  } catch {
    throw fail('INVALID', 'Preset teaching fields failed validation; nothing was truncated')
  }
  const result = { id, name, description, fields, version: definition.version }
  if (definition.provenance !== undefined) result.provenance = text(definition.provenance, 240, 'provenance', { allowEmpty: true })
  return result
}

function decodeLibrary(raw) {
  if (raw === undefined || raw === null) return { revision: 0, presets: [] }
  if (!plain(raw) || typeof raw.schema !== 'string') throw fail('CORRUPT', 'Preset library has no schema')
  if (raw.schema !== PRESET_LIBRARY_SCHEMA) throw fail('UNSUPPORTED_SCHEMA', 'Preset library schema is unsupported; record left untouched')
  if (Object.keys(raw).sort().join(',') !== 'presets,revision,schema'
    || !Number.isSafeInteger(raw.revision) || raw.revision < 1
    || !Array.isArray(raw.presets) || raw.presets.length > USER_PRESET_LIMIT) {
    throw fail('CORRUPT', 'Invalid preset library record; record left untouched')
  }
  const presets = []
  const seen = new Set()
  for (const entry of raw.presets) {
    let definition
    try { definition = validatePresetDefinition(entry) } catch {
      throw fail('CORRUPT', 'Invalid stored preset definition; record left untouched')
    }
    if (seen.has(definition.id)) throw fail('CORRUPT', 'Duplicate preset id in stored library; record left untouched')
    seen.add(definition.id)
    presets.push(definition)
  }
  return { revision: raw.revision, presets }
}

function decodeApplied(raw) {
  if (raw === undefined || raw === null) return null
  if (!plain(raw) || typeof raw.schema !== 'string') throw fail('CORRUPT', 'Applied-preset metadata has no schema')
  if (raw.schema !== PRESET_APPLIED_SCHEMA) throw fail('UNSUPPORTED_SCHEMA', 'Applied-preset metadata schema is unsupported; record left untouched')
  if (Object.keys(raw).sort().join(',') === 'cleared,schema' && raw.cleared === true) return null
  if (Object.keys(raw).sort().join(',') !== 'fields,overlayRevision,presetId,presetVersion,schema'
    || typeof raw.presetId !== 'string' || raw.presetId.length === 0 || raw.presetId.length > 64
    || !Number.isSafeInteger(raw.presetVersion) || raw.presetVersion < 1
    || !Number.isSafeInteger(raw.overlayRevision) || raw.overlayRevision < 1) {
    throw fail('CORRUPT', 'Invalid applied-preset metadata; record left untouched')
  }
  let fields
  try { fields = validateCustomizationFields(raw.fields) } catch {
    throw fail('CORRUPT', 'Invalid applied-preset snapshot; record left untouched')
  }
  return { presetId: raw.presetId, presetVersion: raw.presetVersion, overlayRevision: raw.overlayRevision, fields }
}

/**
 * Profile-level library + applied-preset metadata over the existing app storage.
 *
 * @param options.appStorage - the shared app storage facade.
 * @param options.queueOwner - serialisation owner shared with other writers of this domain.
 */
export function createPresetLibraryStore({ appStorage, queueOwner = appStorage }) {
  async function table() {
    const snapshot = await appStorage.ensureOpen()
    if (snapshot?.status !== 'open') throw fail('UNAVAILABLE', snapshot?.reason ?? 'Preset storage unavailable')
    const value = appStorage.table('app')
    if (typeof value?.get !== 'function') throw fail('UNAVAILABLE', 'Preset storage has no table')
    return value
  }
  function serialized(operation) {
    const pending = (queues.get(queueOwner) ?? Promise.resolve()).then(operation)
    queues.set(queueOwner, pending.catch(() => {}))
    return pending
  }
  const KEY = 'presets:library'

  async function list() {
    const library = decodeLibrary((await table()).get(KEY))
    return {
      revision: library.revision,
      bundled: BUNDLED_PRESETS.map(preset => ({ ...preset, fields: { ...preset.fields } })),
      user: library.presets,
      defaultPresetId: DEFAULT_PRESET_ID,
    }
  }

  /** Create or update one user definition. Saving never activates it. */
  function save(args) {
    let definition, expectedRevision
    try {
      definition = validatePresetDefinition(args?.definition)
      expectedRevision = args?.expectedRevision
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) invalid('A safe expectedRevision is required')
    } catch (error) { return Promise.reject(error) }
    return serialized(async () => {
      const current = decodeLibrary((await table()).get(KEY))
      if (current.revision !== expectedRevision) throw fail('STALE', 'The preset library changed; reload before saving')
      const existing = current.presets.findIndex(row => row.id === definition.id)
      const presets = [...current.presets]
      if (existing === -1) {
        if (presets.length >= USER_PRESET_LIMIT) throw fail('LIMIT', `The library already holds ${USER_PRESET_LIMIT} presets; delete one before saving another`)
        presets.push(definition)
      } else {
        presets[existing] = definition
      }
      const next = { schema: PRESET_LIBRARY_SCHEMA, revision: expectedRevision + 1, presets }
      await appStorage.writeRecord(KEY, next)
      return { revision: next.revision, saved: { ...definition, fields: { ...definition.fields } } }
    })
  }

  /** Delete one user definition. The applied overlay snapshot is intentionally untouched. */
  function remove(args) {
    let presetId, expectedRevision
    try {
      presetId = text(args?.presetId, 64, 'presetId')
      expectedRevision = args?.expectedRevision
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) invalid('A safe expectedRevision is required')
      if (args?.confirmed !== true) invalid('Deleting a preset requires explicit confirmation')
    } catch (error) { return Promise.reject(error) }
    return serialized(async () => {
      const current = decodeLibrary((await table()).get(KEY))
      if (current.revision !== expectedRevision) throw fail('STALE', 'The preset library changed; reload before deleting')
      const presets = current.presets.filter(row => row.id !== presetId)
      if (presets.length === current.presets.length) throw fail('MISSING', 'No user preset with this id')
      const next = { schema: PRESET_LIBRARY_SCHEMA, revision: expectedRevision + 1, presets }
      await appStorage.writeRecord(KEY, next)
      return { revision: next.revision, removed: presetId }
    })
  }

  /** Applied-preset metadata lives under its own key; customization records are never rewritten. */
  function appliedKey(selector) {
    return `presetApplied:${customizationKey(selector)}`
  }
  async function readApplied(selector) {
    return decodeApplied((await table()).get(appliedKey(selector)))
  }
  function writeApplied(selector, record) {
    return serialized(async () => {
      if (record === null) {
        // The storage domain only stores JSON objects: retire the marker explicitly instead of
        // writing a null record.
        await appStorage.writeRecord(appliedKey(selector), { schema: PRESET_APPLIED_SCHEMA, cleared: true })
        return null
      }
      const normalized = decodeApplied({ ...record, schema: PRESET_APPLIED_SCHEMA })
      await appStorage.writeRecord(appliedKey(selector), { schema: PRESET_APPLIED_SCHEMA, ...normalized })
      return normalized
    })
  }

  return { list, save, remove, readApplied, writeApplied }
}

export { BUNDLED_PRESETS, DEFAULT_PRESET_ID, bundledPreset }
