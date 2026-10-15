/**
 * Client half of the Professor Home Typed Remote contribution.
 *
 * The transport boundary is the point: what the browser may *send* is validated here with strict
 * codecs (the gateway refuses to mount a contribution whose inputs are loose), and what the browser
 * receives is validated host-side in `src/app/remote.js`. Nothing about this file opens a socket —
 * the transport is the host gateway, whose admission and dispatch decisions are the host's.
 *
 * There are no values to decode beyond simple bounds, so — like the host face — this module ships no
 * schema library: each codec is one `parse` function.
 *
 * @module dsh-professor-spike/client/remote
 */

export const REMOTE_PACKAGE = 'dsh-professor-spike'
export const PROFESSOR_HOME_NAMESPACE = 'professorHome'

const STUDY_MODES = ['learn', 'question', 'assignment', 'review', 'exam', 'free']

function strict(typeSymbol, parse) {
  return { mode: 'strict', typeSymbol, create: () => ({ parse }) }
}

function refuse(detail) {
  throw new TypeError(`professorHome client rejected its own payload: ${detail}`)
}

const LAUNCH_REQUEST = strict(`${REMOTE_PACKAGE}#launchRequest`, (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a launch request must be a plain object')
  for (const key of Object.keys(value)) {
    if (!['requestId', 'mode', 'courseId', 'topic', 'folder'].includes(key)) refuse(`unexpected launch field "${key}"`)
  }
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(value.requestId)) refuse('requestId must be 8-64 safe characters')
  if (typeof value.mode !== 'string' || !STUDY_MODES.includes(value.mode)) refuse(`mode must be one of ${STUDY_MODES.join(', ')}`)
  if (value.courseId != null && (typeof value.courseId !== 'string' || value.courseId.length === 0 || value.courseId.length > 128)) refuse('courseId must be absent, null or a bounded string')
  if (value.topic != null && (typeof value.topic !== 'string' || value.topic.length > 200)) refuse('the topic must be absent or at most 200 characters')
  if (value.folder !== undefined && (typeof value.folder !== 'string' || value.folder.length === 0 || value.folder.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value.folder) || value.mode !== 'free' || value.courseId != null)) refuse('invalid setup folder')
  return value
})

const REOPEN_REQUEST = strict(`${REMOTE_PACKAGE}#reopenRequest`, (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a reopen request must be a plain object')
  for (const key of Object.keys(value)) if (key !== 'sessionId') refuse(`unexpected reopen field "${key}"`)
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0 || value.sessionId.length > 128) refuse('sessionId must be a bounded non-empty string')
  return value
})

const CLEAR_REQUEST = strict(`${REMOTE_PACKAGE}#clearRequest`, (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a clear request must be a plain object')
  for (const key of Object.keys(value)) if (!['sessionId', 'confirmed'].includes(key)) refuse(`unexpected clear field "${key}"`)
  if (typeof value.sessionId !== 'string' || value.sessionId.trim().length === 0 || value.sessionId.length > 128) refuse('sessionId must be a bounded non-empty string')
  if (value.confirmed !== true) refuse('clearing requires confirmed: true')
  return { sessionId: value.sessionId, confirmed: true }
})

const CLEAR_ALL_SNAPSHOT_REQUEST = strict(`${REMOTE_PACKAGE}#clearAllSnapshotRequest`, (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0) refuse('a snapshot request takes no fields')
  return {}
})

const CLEAR_ALL_START_REQUEST = strict(`${REMOTE_PACKAGE}#clearAllStartRequest`, (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a bulk clear start must be a plain object')
  for (const key of Object.keys(value)) if (key !== 'token') refuse(`unexpected bulk field "${key}"`)
  if (typeof value.token !== 'string' || value.token.trim().length === 0 || value.token.length > 128) refuse('token must be a bounded non-empty string')
  return { token: value.token }
})

const CLEAR_ALL_CONTINUE_REQUEST = strict(`${REMOTE_PACKAGE}#clearAllContinueRequest`, (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a bulk clear continuation must be a plain object')
  for (const key of Object.keys(value)) if (key !== 'operationId') refuse(`unexpected bulk field "${key}"`)
  if (typeof value.operationId !== 'string' || value.operationId.trim().length === 0 || value.operationId.length > 128) refuse('operationId must be a bounded non-empty string')
  return { operationId: value.operationId }
})

const PRESET_DEFINITION_ENVELOPE = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a preset definition must be a plain object')
  for (const key of Object.keys(value)) if (!['id', 'name', 'description', 'fields', 'version', 'provenance'].includes(key)) refuse(`unexpected preset field "${key}"`)
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id)) refuse('preset id must be lowercase letters, digits and dashes')
  if (typeof value.name !== 'string' || value.name.trim().length === 0 || value.name.length > 80) refuse('preset name must be at most 80 characters')
  if (typeof value.description !== 'string' || value.description.trim().length === 0 || value.description.length > 240) refuse('preset description must be at most 240 characters')
  if (value.fields === null || typeof value.fields !== 'object' || Array.isArray(value.fields)) refuse('preset fields must be a plain object')
  if (JSON.stringify(value.fields).length > 8192) refuse('preset fields exceed the wire budget')
  if (!Number.isSafeInteger(value.version) || value.version < 1) refuse('preset version must be a positive integer')
  if (value.provenance !== undefined && (typeof value.provenance !== 'string' || value.provenance.length > 240)) refuse('preset provenance must be at most 240 characters')
  return value
}

const PRESET_LIBRARY_REQUEST = strict(`${REMOTE_PACKAGE}#presetLibraryRequest`, (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a preset library request must be a plain object')
  for (const key of Object.keys(value)) if (!['skill', 'courseId'].includes(key)) refuse(`unexpected preset field "${key}"`)
  if (value.skill !== undefined && (typeof value.skill !== 'string' || value.skill.length > 80)) refuse('invalid skill selector')
  if (value.courseId != null && (typeof value.courseId !== 'string' || value.courseId.trim().length === 0 || value.courseId.length > 128)) refuse('invalid course selector')
  return value
})

const PRESET_SAVE_REQUEST = strict(`${REMOTE_PACKAGE}#presetSaveRequest`, (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a preset save request must be a plain object')
  for (const key of Object.keys(value)) if (!['definition', 'expectedRevision'].includes(key)) refuse(`unexpected preset field "${key}"`)
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) refuse('a safe expectedRevision is required')
  PRESET_DEFINITION_ENVELOPE(value.definition)
  return value
})

const PRESET_DELETE_REQUEST = strict(`${REMOTE_PACKAGE}#presetDeleteRequest`, (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a preset delete request must be a plain object')
  for (const key of Object.keys(value)) if (!['presetId', 'expectedRevision', 'confirmed'].includes(key)) refuse(`unexpected preset field "${key}"`)
  if (typeof value.presetId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.presetId)) refuse('invalid preset id')
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) refuse('a safe expectedRevision is required')
  if (value.confirmed !== true) refuse('deleting a preset requires confirmed: true')
  return value
})

const PRESET_APPLY_REQUEST = strict(`${REMOTE_PACKAGE}#presetApplyRequest`, (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('a preset apply request must be a plain object')
  for (const key of Object.keys(value)) if (!['presetId', 'courseId', 'expectedRevision'].includes(key)) refuse(`unexpected preset field "${key}"`)
  if (typeof value.presetId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.presetId)) refuse('invalid preset id')
  if (value.courseId != null && (typeof value.courseId !== 'string' || value.courseId.trim().length === 0 || value.courseId.length > 128)) refuse('invalid course selector')
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) refuse('a safe expectedRevision is required')
  return value
})

/**
 * Result codecs.
 *
 * A contribution is invalid without them: the registry validates `descriptor.result` before it will
 * mount anything, and its codec is what decodes the reply. Results are host-owned — `src/app/remote.js`
 * is where their shape is decided — so the client only asserts the invariant that matters on this
 * side of the wire: a reply is a bounded plain object, never a container the UI would render raw.
 */
function result(typeSymbol) {
  return strict(typeSymbol, (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse(`the ${typeSymbol} reply must be a plain object`)
    if (JSON.stringify(value).length > 64 * 1024) refuse('the reply exceeds the 64 KiB wire budget')
    return value
  })
}

const HOME_RESULT = result(`${REMOTE_PACKAGE}#homeResult`)
const LAUNCH_RESULT = result(`${REMOTE_PACKAGE}#launchResult`)
const REOPEN_RESULT = result(`${REMOTE_PACKAGE}#reopenResult`)
const CLEAR_RESULT = result(`${REMOTE_PACKAGE}#clearResult`)
const CLEAR_ALL_RESULT = result(`${REMOTE_PACKAGE}#clearAllResult`)
const PRESET_RESULT = result(`${REMOTE_PACKAGE}#presetResult`)
const VIEW_REQUEST = strict(`${REMOTE_PACKAGE}#viewRequest`, value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 65536) refuse('invalid view request')
  for (const key of Object.keys(value)) if (!['courseId', 'skill', 'offset', 'fields', 'expectedRevision', 'reset'].includes(key)) refuse('unexpected view field')
  if (value.courseId != null && (typeof value.courseId !== 'string' || !value.courseId.trim() || value.courseId.length > 128)) refuse('invalid course selector')
  if (value.skill !== undefined && (typeof value.skill !== 'string' || value.skill.length > 80)) refuse('invalid skill selector')
  for (const key of ['offset', 'expectedRevision']) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) refuse('invalid revision or offset')
  if (value.reset !== undefined && typeof value.reset !== 'boolean') refuse('invalid reset')
  if (value.fields !== undefined && (value.fields === null || typeof value.fields !== 'object' || Array.isArray(value.fields))) refuse('invalid fields')
  return value
})

const MATERIAL_REQUEST = strict(`${REMOTE_PACKAGE}#materialRequest`, value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['requestId', 'courseId', 'fileId', 'mode'].includes(key)) ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(value.requestId ?? '') || !['courseId', 'fileId'].every(key => typeof value[key] === 'string' && value[key].trim() && value[key].length <= 128) || !['learn', 'question'].includes(value.mode)) refuse('invalid material launch')
  return value
})
const COMMAND_REQUEST = strict(`${REMOTE_PACKAGE}#commandRequest`, value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 65536 ||
        Object.keys(value).some(function (key) { return ['sessionId', 'action', 'args'].indexOf(key) === -1 }) ||
        typeof value.sessionId !== 'string' || !value.sessionId.trim() || value.sessionId.length > 128 ||
        ['discover', 'confirm', 'rebuild', 'diagnostics', 'courses', 'manageCourse'].indexOf(value.action) === -1 ||
        !value.args || typeof value.args !== 'object' || Array.isArray(value.args)) refuse('invalid workspace command')
      return value
    })
const MEMORY_REQUEST = strict(`${REMOTE_PACKAGE}#memoryRequest`, value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(function (key) { return ['enabled', 'expectedRevision'].indexOf(key) === -1 }) ||
        typeof value.enabled !== 'boolean' || !Object.prototype.hasOwnProperty.call(value, 'expectedRevision') ||
        (value.expectedRevision !== null && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1))) refuse('invalid memory control request')
      return value
    })
/** The client contribution the browser bundle mounts with `ctx.remote.$mount(...)`. */
export const TYPERT_REMOTE = {
  package: REMOTE_PACKAGE,
  descriptors: [
    {
      id: `${REMOTE_PACKAGE}#home/read`,
      service: PROFESSOR_HOME_NAMESPACE,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'home',
      invocation: { kind: 'direct' },
      parameters: [],
      result: HOME_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#launch/create`,
      service: PROFESSOR_HOME_NAMESPACE,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'launch',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: LAUNCH_REQUEST }],
      result: LAUNCH_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#reopen/validate`,
      service: PROFESSOR_HOME_NAMESPACE,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'reopen',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: REOPEN_REQUEST }],
      result: REOPEN_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#clear/archive`,
      service: PROFESSOR_HOME_NAMESPACE,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'clearSession',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: CLEAR_REQUEST }],
      result: CLEAR_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#clear-all/snapshot`,
      service: PROFESSOR_HOME_NAMESPACE,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'clearAllSnapshot',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: CLEAR_ALL_SNAPSHOT_REQUEST }],
      result: CLEAR_ALL_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#clear-all/start`,
      service: PROFESSOR_HOME_NAMESPACE,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'clearAllStart',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: CLEAR_ALL_START_REQUEST }],
      result: CLEAR_ALL_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#clear-all/continue`,
      service: PROFESSOR_HOME_NAMESPACE,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'clearAllContinue',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: CLEAR_ALL_CONTINUE_REQUEST }],
      result: CLEAR_ALL_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#presets/library`,
      service: PROFESSOR_HOME_NAMESPACE,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'presetLibrary',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: PRESET_LIBRARY_REQUEST }],
      result: PRESET_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#presets/save`,
      service: PROFESSOR_HOME_NAMESPACE,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'presetSave',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: PRESET_SAVE_REQUEST }],
      result: PRESET_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#presets/delete`,
      service: PROFESSOR_HOME_NAMESPACE,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'presetDelete',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: PRESET_DELETE_REQUEST }],
      result: PRESET_RESULT,
    },
    {
      id: `${REMOTE_PACKAGE}#presets/apply`,
      service: PROFESSOR_HOME_NAMESPACE,
      namespace: PROFESSOR_HOME_NAMESPACE,
      method: 'presetApply',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: PRESET_APPLY_REQUEST }],
      result: PRESET_RESULT,
    },
    { id: `${REMOTE_PACKAGE}#views/setMemoryEnabled`, service: PROFESSOR_HOME_NAMESPACE, namespace: PROFESSOR_HOME_NAMESPACE, method: 'setMemoryEnabled',
      invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: MEMORY_REQUEST }], result: HOME_RESULT },
    { id: `${REMOTE_PACKAGE}#views/workspaceCommand`, service: PROFESSOR_HOME_NAMESPACE, namespace: PROFESSOR_HOME_NAMESPACE, method: 'workspaceCommand',
      invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: COMMAND_REQUEST }], result: HOME_RESULT },
    { id: `${REMOTE_PACKAGE}#views/launchMaterial`, service: PROFESSOR_HOME_NAMESPACE, namespace: PROFESSOR_HOME_NAMESPACE, method: 'launchMaterial',
      invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: MATERIAL_REQUEST }], result: HOME_RESULT },
    ...['course', 'settings', 'saveCustomization'].map(method => ({
      id: `${REMOTE_PACKAGE}#views/${method}`, service: PROFESSOR_HOME_NAMESPACE, namespace: PROFESSOR_HOME_NAMESPACE,
      method, invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: VIEW_REQUEST }], result: HOME_RESULT,
    })),
  ],
}

export default TYPERT_REMOTE
