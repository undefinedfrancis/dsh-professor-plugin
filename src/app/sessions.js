/** Metadata only. Harness remains the sole owner of native conversation history. */
export const SESSION_REGISTRY_KEY = 'sessions:registry'
export const SESSION_REGISTRY_SCHEMA = 'professor.sessions/1'
export const STUDY_MODES = Object.freeze(['learn', 'question', 'assignment', 'review', 'exam', 'free'])
const fields = ['requestId', 'sessionId', 'courseId', 'title', 'mode', 'status', 'error', 'updatedAt']

function failure(code, message) {
  return Object.assign(new Error(message), { code })
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}
function text(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value)
}
function validInput(value) {
  return object(value) && Object.keys(value).length === 5
    && Object.keys(value).every(key => ['requestId', 'sessionId', 'courseId', 'title', 'mode'].includes(key))
    && text(value.requestId, 128) && text(value.sessionId, 128)
    && (value.courseId === null || text(value.courseId, 128))
    && text(value.title, 160) && STUDY_MODES.includes(value.mode)
}
function validRow(row) {
  if (!object(row) || Object.keys(row).length !== fields.length || !Object.keys(row).every(key => fields.includes(key))) return false
  const { requestId, sessionId, courseId, title, mode } = row
  return validInput({ requestId, sessionId, courseId, title, mode })
    && ['preparing', 'ready', 'failed', 'archived'].includes(row.status)
    && (row.status === 'failed' ? text(row.error, 500) : row.error === null)
    && typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt))
}
function readRecord(value) {
  if (value === undefined || value === null) return { schema: SESSION_REGISTRY_SCHEMA, sessions: [] }
  if (!object(value) || Object.keys(value).length !== 2 || value.schema !== SESSION_REGISTRY_SCHEMA
    || !Array.isArray(value.sessions) || !value.sessions.every(validRow)
    || new Set(value.sessions.map(row => row.sessionId)).size !== value.sessions.length
    || new Set(value.sessions.map(row => row.requestId)).size !== value.sessions.length) {
    throw failure('PROFESSOR_SESSION_CORRUPT', 'Professor session metadata is invalid or incompatible; it has not been changed.')
  }
  return structuredClone(value)
}

/** One instance per shared application owner. Serializes writes without caching stale storage. */
export function createSessionRegistry({ appStorage, now = () => new Date().toISOString() }) {
  let pending = Promise.resolve()
  const serial = operation => {
    const result = pending.then(operation)
    pending = result.catch(() => {})
    return result
  }
  async function read() {
    await appStorage.ensureOpen()
    const table = appStorage.table('app')
    if (!table) throw failure('PROFESSOR_SESSION_STORAGE_UNAVAILABLE', 'Professor session metadata storage is unavailable.')
    return readRecord(table.get(SESSION_REGISTRY_KEY))
  }
  async function write(record) {
    // Validate writes with the same contract as reopen; never make next startup fail.
    readRecord(record)
    await appStorage.writeRecord(SESSION_REGISTRY_KEY, record)
  }
  return Object.freeze({
    reserve(input) {
      return serial(async () => {
        if (!validInput(input)) throw failure('PROFESSOR_SESSION_INVALID', 'Expected bounded session metadata, an optional course ID and a supported study mode.')
        const record = await read()
        const previous = record.sessions.find(row => row.requestId === input.requestId)
        if (previous) {
          if (previous.status === 'archived') throw failure('PROFESSOR_SESSION_ARCHIVED', 'This conversation was cleared from Professor. Start a new conversation.')
          if (Object.keys(input).some(key => previous[key] !== input[key])) {
            throw failure('PROFESSOR_SESSION_CONFLICT', 'This launch request already belongs to different session metadata.')
          }
          if (previous.status === 'failed') {
            Object.assign(previous, { status: 'preparing', error: null, updatedAt: now() })
            await write(record)
          }
          return structuredClone(previous)
        }
        if (record.sessions.some(row => row.sessionId === input.sessionId)) {
          throw failure('PROFESSOR_SESSION_CONFLICT', 'This native session ID already belongs to another launch request.')
        }
        const row = { ...input, status: 'preparing', error: null, updatedAt: now() }
        record.sessions.push(row)
        await write(record)
        return structuredClone(row)
      })
    },
    settle(sessionId, outcome) {
      return serial(async () => {
        if (!object(outcome) || Object.keys(outcome).some(key => !['status', 'error'].includes(key))
          || !['ready', 'failed'].includes(outcome.status)
          || (outcome.status === 'failed' ? !text(outcome.error, 500) : outcome.error != null)) {
          throw failure('PROFESSOR_SESSION_INVALID', 'A completed setup is ready, or failed with a bounded error message.')
        }
        const record = await read()
        const row = record.sessions.find(item => item.sessionId === sessionId)
        if (!row) throw failure('PROFESSOR_SESSION_MISSING', 'Professor has no metadata for this native session.')
        Object.assign(row, { status: outcome.status, error: outcome.error ?? null, updatedAt: now() })
        await write(record)
        return structuredClone(row)
      })
    },
    list() {
      return serial(async () => (await read()).sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    },
    get(sessionId) {
      return serial(async () => (await read()).sessions.find(row => row.sessionId === sessionId) ?? null)
    },
    archive(sessionId) {
      return serial(async () => {
        const record = await read()
        const row = record.sessions.find(item => item.sessionId === sessionId)
        if (!row) throw failure('PROFESSOR_SESSION_MISSING', 'This conversation does not belong to Professor.')
        Object.assign(row, { status: 'archived', error: null, updatedAt: now() })
        await write(record)
      })
    },
  })
}
