/** Versioned preference overlays in the existing app domain. No skill/resource file writes. */
export const CUSTOMIZATION_SCHEMA = 'professor.customization/1'
export const CUSTOMIZABLE_SKILLS = Object.freeze([
  'professor-study', 'professor-notes', 'professor-review',
  'professor-research', 'professor-latex', 'professor-course-management',
])
const bounds = Object.freeze({ language: 120, explanationStyle: 240, teachingDepth: 120,
  programmingLanguage: 120, additionalInstructions: 2048 })
const queues = new WeakMap()
const plain = value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const fail = (suffix, message) => Object.assign(new Error(message), { code: `PROFESSOR_CUSTOMIZATION_${suffix}` })
const invalid = message => { throw fail('INVALID', message) }
const text = (value, limit, name) => {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid(`${name} must be bounded text without non-whitespace control characters`)
  return value.trim()
}

export function validateCustomizationFields(fields) {
  if (!plain(fields) || Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !Object.hasOwn(bounds, key))) invalid('Unknown customization field or invalid fields mapping')
  const result = {}
  for (const name of Object.keys(bounds)) {
    if (!Object.hasOwn(fields, name)) continue
    const descriptor = Object.getOwnPropertyDescriptor(fields, name)
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid('Customization fields must be plain data')
    const value = text(descriptor.value, bounds[name], name)
    if (value !== '') result[name] = value
  }
  return result
}

export function customizationKey({ skill, scope = null }) {
  if (!CUSTOMIZABLE_SKILLS.includes(skill)) invalid('Unknown bundled skill')
  let location = null
  if (scope !== null) {
    if (!plain(scope) || Object.keys(scope).length !== 2 || !Object.hasOwn(scope, 'namespace') || !Object.hasOwn(scope, 'courseId')) invalid('Course scope requires namespace and immutable courseId')
    const namespace = text(scope.namespace, 240, 'namespace')
    const courseId = text(scope.courseId, 120, 'courseId')
    if (!namespace || !courseId) invalid('Empty course scope')
    location = [namespace, courseId]
  }
  return `customization:${JSON.stringify([skill, location])}`
}

function decode(raw) {
  if (raw === undefined || raw === null) return { revision: 0, fields: {} }
  if (!plain(raw) || typeof raw.schema !== 'string') throw fail('CORRUPT', 'Customization record has no schema')
  if (raw.schema !== CUSTOMIZATION_SCHEMA) throw fail('UNSUPPORTED_SCHEMA', 'Customization schema is unsupported; record left untouched')
  if (Object.keys(raw).sort().join(',') !== 'fields,revision,schema' || !Number.isSafeInteger(raw.revision) || raw.revision < 1) throw fail('CORRUPT', 'Invalid customization revision or record fields')
  let fields
  try { fields = validateCustomizationFields(raw.fields) } catch { throw fail('CORRUPT', 'Invalid stored customization fields; record left untouched') }
  return { revision: raw.revision, fields }
}

export function createSkillCustomizationStore({ appStorage, queueOwner = appStorage }) {
  async function table() {
    const snapshot = await appStorage.ensureOpen()
    if (snapshot?.status !== 'open') throw fail('UNAVAILABLE', snapshot?.reason ?? 'Customization storage unavailable')
    const value = appStorage.table('app')
    if (typeof value?.get !== 'function') throw fail('UNAVAILABLE', 'Customization storage has no table')
    return value
  }
  function serialized(operation) {
    const pending = (queues.get(queueOwner) ?? Promise.resolve()).then(operation)
    queues.set(queueOwner, pending.catch(() => {}))
    return pending
  }
  async function read(selector) {
    const key = customizationKey(selector)
    return decode((await table()).get(key))
  }
  function update(args) {
    // Snapshot caller-owned arguments synchronously, before any await/queue boundary.
    let key, fields, revision
    try {
      key = customizationKey(args)
      fields = validateCustomizationFields(args.fields)
      revision = args.expectedRevision
      if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) invalid('A safe expectedRevision is required')
      if (args.evidence !== 'explicit-stable') invalid('Saving customization requires explicit-stable user intent')
    } catch (error) { return Promise.reject(error) }
    return serialized(async () => {
      const current = decode((await table()).get(key))
      if (current.revision !== revision) throw fail('STALE', 'Customization changed; reload before saving')
      const next = { schema: CUSTOMIZATION_SCHEMA, revision: revision + 1, fields }
      await appStorage.writeRecord(key, next)
      return { revision: next.revision, fields: { ...fields } }
    })
  }
  return { read, update, reset: args => update({ ...args, fields: {} }) }
}
