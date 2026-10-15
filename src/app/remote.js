const MATERIAL_REQUEST = codec(`${REMOTE_PACKAGE}#materialRequest`, value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['requestId', 'courseId', 'fileId', 'mode'].includes(key)) ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(value.requestId ?? '') || !['courseId', 'fileId'].every(key => typeof value[key] === 'string' && value[key].trim() && value[key].length <= 128) || !['learn', 'question'].includes(value.mode)) reject('invalid material launch')
  return value
})
const COMMAND_REQUEST = codec(`${REMOTE_PACKAGE}#commandRequest`, value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 65536 ||
        Object.keys(value).some(function (key) { return ['sessionId', 'action', 'args'].indexOf(key) === -1 }) ||
        typeof value.sessionId !== 'string' || !value.sessionId.trim() || value.sessionId.length > 128 ||
        ['discover', 'confirm', 'rebuild', 'diagnostics', 'courses', 'manageCourse'].indexOf(value.action) === -1 ||
        !value.args || typeof value.args !== 'object' || Array.isArray(value.args)) reject('invalid workspace command')
      return value
    })
const MEMORY_REQUEST = codec(`${REMOTE_PACKAGE}#memoryRequest`, value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(function (key) { return ['enabled', 'expectedRevision'].indexOf(key) === -1 }) ||
        typeof value.enabled !== 'boolean' || !Object.prototype.hasOwnProperty.call(value, 'expectedRevision') ||
        (value.expectedRevision !== null && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1))) reject('invalid memory control request')
      return value
    })
/**
 * The official Typed Remote contribution Professor Home publishes.
 *
 * Why this exists instead of an HTTP endpoint
 * -------------------------------------------
 * The obvious way to give a browser UI some data is to start a local server. That would also be the
 * worst option available: it would mean an unauthenticated port doing privileged work, owned by a
 * plugin, outside every access-control decision the host makes. This module uses the host's own
 * instead:
 *
 *   - the **service** is a normal Cordis service (`professorHome`) provided on our own scope;
 *   - the **face** is registered through `ctx.get('typert').register({ package, face: 'host', … })`,
 *     the same call every official client package makes;
 *   - the **transport** is the host gateway, whose dispatch and admission are the host's;
 *   - `tools/verify-ui-bridge.mjs` proved on the installed host that an unregistered method cannot
 *     be reached afterwards and that a `strict` codec rejects unexpected shapes.
 *
 * Nothing here listens on a port, and withdrawing the registration removes every endpoint (same
 * probe, same evidence). The client half lives in `client/remote.js`, which the browser bundle
 * mounts through `ctx.remote.$mount(...)`.
 *
 * @module dsh-professor-spike/src/app/remote
 */

import { PROFESSOR_HOME_NAMESPACE, PROFESSOR_PRESET_ID, REMOTE_PACKAGE, STUDY_MODE_LABELS } from './home.js'
import { STUDY_MODES } from './sessions.js'

/** The cordis service key every descriptor points at. */
export const HOME_SERVICE_KEY = PROFESSOR_HOME_NAMESPACE

const MAX_TOPIC = 200
const MAX_ID = 128

/** A hand-written strict codec: this package declares no host dependencies, so no schema library ships. */
function codec(typeSymbol, parse) {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({ parse }),
  }
}

function reject(payload) {
  throw new TypeError(`professorHome received an unexpected payload: ${payload}`)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

/** Every value跨界 arriving from the browser is bounded, so a corrupt client cannot write anything. */
function bounded(value) {
  try {
    return JSON.stringify(value ?? null).length <= 64 * 1024
  } catch {
    return false
  }
}

/** `<requestId>`: 8-64 filesystem-safe characters, because it becomes part of a native session id. */
const REQUEST_ID = codec('dsh-professor-spike#requestId', (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) reject('requestId must be 8-64 letters, digits, dashes or underscores')
  return value
})

/** One of the six supported study modes — anything else never reaches the orchestrator. */
const STUDY_MODE = codec('dsh-professor-spike#studyMode', (value) => {
  if (typeof value !== 'string' || !STUDY_MODES.includes(value)) reject(`study mode must be one of ${STUDY_MODES.join(', ')}`)
  return value
})

/** `null` (general session) or a non-empty course id. Never `''`, never a number. */
const OPTIONAL_ID = codec('dsh-professor-spike#optionalId', (value) => {
  if (value === null) return null
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_ID) reject('a course id must be a non-empty string of at most 128 characters')
  return value
})

/** The optional topic. Bounded, and never a container — it is folded into a title, not stored raw. */
const OPTIONAL_TOPIC = codec('dsh-professor-spike#optionalTopic', (value) => {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string' || value.length > MAX_TOPIC) reject(`the topic must be a string of at most ${MAX_TOPIC} characters`)
  return value
})

/** `{ requestId, mode, courseId?, topic? }` — exactly these keys. */
const LAUNCH_REQUEST = codec('dsh-professor-spike#launchRequest', (value) => {
  if (!isPlainObject(value)) reject('a launch request must be a plain object')
  const allowed = new Set(['requestId', 'mode', 'courseId', 'topic', 'folder'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) reject(`unexpected launch field "${key}"`)
  if (value.folder !== undefined && (typeof value.folder !== 'string' || value.folder.length === 0 || value.folder.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value.folder) || value.mode !== 'free' || value.courseId != null)) reject('invalid setup folder')
  return {
    requestId: REQUEST_ID.create().parse(value.requestId),
    mode: STUDY_MODE.create().parse(value.mode),
    courseId: OPTIONAL_ID.create().parse(value.courseId ?? null),
    topic: OPTIONAL_TOPIC.create().parse(value.topic ?? ''),
    ...(value.folder === undefined ? {} : { folder: value.folder }),
  }
})

/** `{ sessionId }` — exactly this key; no payload may ride along into a reopen. */
const REOPEN_REQUEST = codec('dsh-professor-spike#reopenRequest', (value) => {
  if (!isPlainObject(value)) reject('a reopen request must be a plain object')
  const allowed = new Set(['sessionId'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) reject(`unexpected reopen field "${key}"`)
  const sessionId = value.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0 || sessionId.length > MAX_ID) {
    reject('sessionId must be a non-empty string of at most 128 characters')
  }
  return { sessionId }
})

/** `{ sessionId, confirmed: true }` — the only shape a clear may arrive in. */
const CLEAR_REQUEST = codec('dsh-professor-spike#clearRequest', (value) => {
  if (!isPlainObject(value)) reject('a clear request must be a plain object')
  const allowed = new Set(['sessionId', 'confirmed'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) reject(`unexpected clear field "${key}"`)
  const sessionId = value.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0 || sessionId.length > MAX_ID) {
    reject('sessionId must be a non-empty string of at most 128 characters')
  }
  if (value.confirmed !== true) reject('clearing requires confirmed: true')
  return { sessionId, confirmed: true }
})

/** `{}` — a snapshot request carries no fields at all; targets are chosen server-side. */
const CLEAR_ALL_SNAPSHOT_REQUEST = codec('dsh-professor-spike#clearAllSnapshotRequest', (value) => {
  if (!isPlainObject(value) || Object.keys(value).length !== 0) reject('a snapshot request takes no fields')
  return {}
})

/** `{ token }` — the single-use confirmation from the backend-owned snapshot. */
const CLEAR_ALL_START_REQUEST = codec('dsh-professor-spike#clearAllStartRequest', (value) => {
  if (!isPlainObject(value)) reject('a bulk clear start must be a plain object')
  for (const key of Object.keys(value)) if (key !== 'token') reject(`unexpected bulk field "${key}"`)
  if (typeof value.token !== 'string' || value.token.trim().length === 0 || value.token.length > MAX_ID) {
    reject('token must be a non-empty string of at most 128 characters')
  }
  return { token: value.token }
})

/** `{ operationId }` — continuation rides on the stored cursor of one confirmed snapshot. */
const CLEAR_ALL_CONTINUE_REQUEST = codec('dsh-professor-spike#clearAllContinueRequest', (value) => {
  if (!isPlainObject(value)) reject('a bulk clear continuation must be a plain object')
  for (const key of Object.keys(value)) if (key !== 'operationId') reject(`unexpected bulk field "${key}"`)
  if (typeof value.operationId !== 'string' || value.operationId.trim().length === 0 || value.operationId.length > MAX_ID) {
    reject('operationId must be a non-empty string of at most 128 characters')
  }
  return { operationId: value.operationId }
})

/** One preset definition envelope; field budgets are enforced again in the library module. */
const PRESET_DEFINITION = (value) => {
  if (!isPlainObject(value)) reject('a preset definition must be a plain object')
  const allowed = new Set(['id', 'name', 'description', 'fields', 'version', 'provenance'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) reject(`unexpected preset field "${key}"`)
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id)) reject('preset id must be lowercase letters, digits and dashes')
  if (typeof value.name !== 'string' || value.name.trim().length === 0 || value.name.length > 80) reject('preset name must be at most 80 characters')
  if (typeof value.description !== 'string' || value.description.trim().length === 0 || value.description.length > 240) reject('preset description must be at most 240 characters')
  if (!isPlainObject(value.fields)) reject('preset fields must be a plain object')
  if (JSON.stringify(value.fields).length > 8192) reject('preset fields exceed the wire budget')
  if (!Number.isSafeInteger(value.version) || value.version < 1) reject('preset version must be a positive integer')
  if (value.provenance !== undefined && (typeof value.provenance !== 'string' || value.provenance.length > 240)) reject('preset provenance must be at most 240 characters')
  return value
}

const PRESET_LIBRARY_REQUEST = codec('dsh-professor-spike#presetLibraryRequest', (value) => {
  if (!isPlainObject(value)) reject('a preset library request must be a plain object')
  const allowed = new Set(['skill', 'courseId'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) reject(`unexpected preset field "${key}"`)
  if (value.skill !== undefined && (typeof value.skill !== 'string' || value.skill.length > 80)) reject('invalid skill selector')
  if (value.courseId != null) OPTIONAL_ID.create().parse(value.courseId)
  return value
})

const PRESET_SAVE_REQUEST = codec('dsh-professor-spike#presetSaveRequest', (value) => {
  if (!isPlainObject(value)) reject('a preset save request must be a plain object')
  const allowed = new Set(['definition', 'expectedRevision'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) reject(`unexpected preset field "${key}"`)
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) reject('a safe expectedRevision is required')
  PRESET_DEFINITION(value.definition)
  return value
})

const PRESET_DELETE_REQUEST = codec('dsh-professor-spike#presetDeleteRequest', (value) => {
  if (!isPlainObject(value)) reject('a preset delete request must be a plain object')
  const allowed = new Set(['presetId', 'expectedRevision', 'confirmed'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) reject(`unexpected preset field "${key}"`)
  if (typeof value.presetId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.presetId)) reject('invalid preset id')
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) reject('a safe expectedRevision is required')
  if (value.confirmed !== true) reject('deleting a preset requires confirmed: true')
  return value
})

const PRESET_APPLY_REQUEST = codec('dsh-professor-spike#presetApplyRequest', (value) => {
  if (!isPlainObject(value)) reject('a preset apply request must be a plain object')
  const allowed = new Set(['presetId', 'courseId', 'expectedRevision'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) reject(`unexpected preset field "${key}"`)
  if (typeof value.presetId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.presetId)) reject('invalid preset id')
  if (value.courseId != null) OPTIONAL_ID.create().parse(value.courseId)
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) reject('a safe expectedRevision is required')
  return value
})

/** Results are plain lossless-JSON values and bounded; nothing else crosses the wire. */
const HOME_RESULT = codec('dsh-professor-spike#homeResult', (value) => {
  if (!isPlainObject(value) || !bounded(value)) reject('the Home payload must be a bounded plain object')
  return value
})

const LAUNCH_RESULT = codec('dsh-professor-spike#launchResult', (value) => {
  if (!isPlainObject(value) || !bounded(value)) reject('a launch result must be a bounded plain object')
  return value
})

const REOPEN_RESULT = codec('dsh-professor-spike#reopenResult', (value) => {
  if (!isPlainObject(value) || !bounded(value)) reject('a reopen result must be a bounded plain object')
  return value
})

const CLEAR_RESULT = codec('dsh-professor-spike#clearResult', (value) => {
  if (!isPlainObject(value) || !bounded(value)) reject('a clear result must be a bounded plain object')
  return value
})

const CLEAR_ALL_RESULT = codec('dsh-professor-spike#clearAllResult', (value) => {
  if (!isPlainObject(value) || !bounded(value)) reject('a bulk clear result must be a bounded plain object')
  return value
})

const PRESET_RESULT = codec('dsh-professor-spike#presetResult', (value) => {
  if (!isPlainObject(value) || !bounded(value)) reject('a preset result must be a bounded plain object')
  return value
})

const VIEW_REQUEST = codec('dsh-professor-spike#viewRequest', (value) => {
  if (!isPlainObject(value) || !bounded(value)) reject('view request must be a bounded plain object')
  const allowed = ['courseId', 'skill', 'offset', 'fields', 'expectedRevision', 'reset']
  for (const key of Object.keys(value)) if (!allowed.includes(key)) reject(`unexpected view field "${key}"`)
  if (value.courseId != null) OPTIONAL_ID.create().parse(value.courseId)
  if (value.skill !== undefined && (typeof value.skill !== 'string' || value.skill.length > 80)) reject('invalid skill selector')
  for (const key of ['offset', 'expectedRevision']) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) reject(`invalid ${key}`)
  if (value.reset !== undefined && typeof value.reset !== 'boolean') reject('reset must be boolean')
  if (value.fields !== undefined && !isPlainObject(value.fields)) reject('fields must be a plain object')
  return value
})

/**
 * The three endpoints Professor Home publishes.
 *
 * `invocation: { kind: 'direct' }` for each: these are ordinary request/response calls, not streams.
 */
export function professorRemoteDescriptors() {
  return [
    {
      id: `${REMOTE_PACKAGE}#home/read`,
      service: HOME_SERVICE_KEY,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'home',
      invocation: { kind: 'direct' },
      parameters: [],
      result: HOME_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#launch/create`,
      service: HOME_SERVICE_KEY,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'launch',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: LAUNCH_REQUEST }],
      result: LAUNCH_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#reopen/validate`,
      service: HOME_SERVICE_KEY,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'reopen',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: REOPEN_REQUEST }],
      result: REOPEN_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#clear/archive`,
      service: HOME_SERVICE_KEY,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'clearSession',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: CLEAR_REQUEST }],
      result: CLEAR_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#clear-all/snapshot`,
      service: HOME_SERVICE_KEY,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'clearAllSnapshot',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: CLEAR_ALL_SNAPSHOT_REQUEST }],
      result: CLEAR_ALL_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#clear-all/start`,
      service: HOME_SERVICE_KEY,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'clearAllStart',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: CLEAR_ALL_START_REQUEST }],
      result: CLEAR_ALL_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#clear-all/continue`,
      service: HOME_SERVICE_KEY,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'clearAllContinue',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: CLEAR_ALL_CONTINUE_REQUEST }],
      result: CLEAR_ALL_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#presets/library`,
      service: HOME_SERVICE_KEY,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'presetLibrary',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: PRESET_LIBRARY_REQUEST }],
      result: PRESET_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#presets/save`,
      service: HOME_SERVICE_KEY,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'presetSave',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: PRESET_SAVE_REQUEST }],
      result: PRESET_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#presets/delete`,
      service: HOME_SERVICE_KEY,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'presetDelete',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: PRESET_DELETE_REQUEST }],
      result: PRESET_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#presets/apply`,
      service: HOME_SERVICE_KEY,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'presetApply',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: PRESET_APPLY_REQUEST }],
      result: PRESET_RESULT,
    },
    { id: `${REMOTE_PACKAGE}#views/setMemoryEnabled`, service: HOME_SERVICE_KEY, namespace: PROFESSOR_HOME_NAMESPACE, method: 'setMemoryEnabled',
      invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: MEMORY_REQUEST }], result: HOME_RESULT },
    { id: `${REMOTE_PACKAGE}#views/workspaceCommand`, service: HOME_SERVICE_KEY, namespace: PROFESSOR_HOME_NAMESPACE, method: 'workspaceCommand',
      invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: COMMAND_REQUEST }], result: HOME_RESULT },
    { id: `${REMOTE_PACKAGE}#views/launchMaterial`, service: HOME_SERVICE_KEY, namespace: PROFESSOR_HOME_NAMESPACE, method: 'launchMaterial',
      invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: MATERIAL_REQUEST }], result: HOME_RESULT },
    ...['course', 'settings', 'saveCustomization'].map(method => ({
      id: `${REMOTE_PACKAGE}#views/${method}`, service: HOME_SERVICE_KEY, namespace: PROFESSOR_HOME_NAMESPACE,
      method, invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: VIEW_REQUEST }], result: HOME_RESULT,
    })),
  ]
}

/**
 * Register the Professor Home Remote on one scope.
 *
 * @param options.scope - the cordis scope the service is provided on (usually `ctx.extend()`).
 * @param options.home - {@link createProfessorHome}.
 * @param options.logger - plugin logger.
 * @returns `{ withdraw, service, serviceKey, namespace, descriptors }` where `withdraw` removes
 *   every endpoint again. Safe to call when the host offers no Typert registry: nothing is then
 *   reachable, and the absence is reported.
 */
export function registerProfessorRemote({ scope, home, views, commands, materials, logger }) {
  const service = {
    home: () => home.home(),
    launch: (request) => home.launch(request),
    reopen: (request) => home.reopen(request),
    clearSession: (request) => home.clearSession(request),
    clearAllSnapshot: () => home.clearAllSnapshot(),
    clearAllStart: (request) => home.clearAllStart(request),
    clearAllContinue: (request) => home.clearAllContinue(request),
    presetLibrary: (request) => views.presetLibrary(request),
    presetSave: (request) => views.presetSave(request),
    presetDelete: (request) => views.presetDelete(request),
    presetApply: (request) => views.presetApply(request),
    course: request => views.course(request),
    settings: request => views.settings(request),
    saveCustomization: request => views.saveCustomization(request),
    setMemoryEnabled: request => views.setMemoryEnabled(request),
    workspaceCommand: request => commands.run(request),
    launchMaterial: request => materials.launch(request),
  }
  // The generated host faces every official package ships carry exactly this triple, and it is how
  // the gateway finds the implementation behind a namespace.
  service.typertRemote = Object.freeze({ service, serviceKey: HOME_SERVICE_KEY, namespace: PROFESSOR_HOME_NAMESPACE })
  service.modes = [...STUDY_MODES]
  service.modeLabels = { ...STUDY_MODE_LABELS }
  service.presetId = PROFESSOR_PRESET_ID

  const descriptors = professorRemoteDescriptors()
  const published = { home: false, provided: false }
  let withdraw = () => {}

  try {
    if (typeof scope?.provide === 'function') {
      scope.provide(HOME_SERVICE_KEY, service)
      published.provided = true
    }
    const typert = scope?.get?.('typert')
    if (typert !== undefined && typeof typert.register === 'function') {
      withdraw = typert.register({
        package: REMOTE_PACKAGE,
        face: 'host',
        schemas: [],
        invocations: descriptors,
      })
      published.home = true
    } else {
      logger?.warn?.('this host exposes no Typert registry, so Professor Home has no reachable endpoints')
    }
  } catch (error) {
    logger?.warn?.(`professor Home remote registration failed: ${error?.message ?? String(error)}`)
  }

  function dispose() {
    try {
      withdraw?.()
    } catch (error) {
      logger?.warn?.(`withdrawing the professor Home endpoints failed: ${error?.message ?? String(error)}`)
    }
  }

  return { ...published, withdraw: dispose, service, serviceKey: HOME_SERVICE_KEY, namespace: PROFESSOR_HOME_NAMESPACE, descriptors }
}
