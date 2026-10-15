/**
 * Professor persistent memory — versioned, validated records over the application storage domain.
 *
 * What this module is
 * -------------------
 * The Phase 2 memory store. It defines exactly three record kinds, all tagged
 * {@link MEMORY_RECORD_SCHEMA} and all living in the **same** `professor_app` domain Phase 1
 * established (one table, one owner, one lifecycle — no second storage system, no conversation
 * database):
 *
 * | Kind | Key | Content |
 * |---|---|---|
 * | Global preferences | `memory:global` | Explicit **stable** academic preferences only |
 * | Course memory | `memory:course:<namespace>:<course_id>` | Stable instructions, recent topic, last native Professor session |
 * | Control | `memory:control` | The enabled/disabled switch |
 *
 * What this module deliberately is not
 * ------------------------------------
 * - **Not a transcript store.** Conversation messages are never written here.
 * - **Not a second learning-state system.** PROGRESS / KNOWLEDGE / MISTAKES stay where they are
 *   (`.professor/state/courses/…`, evidence-gated through `professor_state_update`). Course memory
 *   holds *metadata* (recent topic, last session, stable instructions), never learning claims.
 * - **Not a silent promoter.** A durable preference requires `explicit-stable` evidence; anything
 *   weaker (a casual "just this once") is refused with a named reason instead of becoming
 *   permanent.
 *
 * Namespacing
 * -----------
 * Course memory is namespaced by **stable project identity plus location**: the project id from
 * `.professor/project.yaml` and a short hash of the resolved project root. Identical course codes
 * in different projects or terms therefore cannot collide; moving/renaming the academic folder
 * starts a fresh namespace (the old records are preserved, never deleted — see
 * {@link courseMemoryNamespace}).
 *
 * Revision discipline
 * -------------------
 * Every record carries a monotonic integer `revision`. A mutation names the revision it read
 * (`expectedRevision`); a mismatch refuses with `PROFESSOR_MEMORY_STALE` **before** anything is
 * written. After `await appStorage.ensureOpen()` the table's `get()` is synchronous, so the
 * read-check-write sequence contains no `await` and cannot interleave with itself inside one
 * process. The host refuses a concurrent `open()` of the same domain, so there is exactly one
 * writer per process by construction.
 *
 * Failure codes (all errors carry `.code`)
 * ---------------------------------------
 * `PROFESSOR_MEMORY_DISABLED` / `PROFESSOR_MEMORY_STALE` / `PROFESSOR_MEMORY_INVALID` /
 * `PROFESSOR_MEMORY_CORRUPT` / `PROFESSOR_MEMORY_UNSUPPORTED_SCHEMA` /
 * `PROFESSOR_MEMORY_UNAVAILABLE`.
 *
 * @module dsh-professor-spike/src/memory/store
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

/** Schema tag of every record this module writes. A bump requires an explicit migration. */
export const MEMORY_RECORD_SCHEMA = 'professor.memory/1'

/** Record key of the global-preferences record. */
export const GLOBAL_PREFERENCES_KEY = 'memory:global'

/** Record key of the enabled/disabled control record. */
export const MEMORY_CONTROL_KEY = 'memory:control'

/** Prefix of every course-memory record key. */
export const COURSE_KEY_PREFIX = 'memory:course:'

/**
 * The only evidence that authorises a durable global preference.
 *
 * Deliberately distinct from the learning-state evidence vocabulary (`none`/`weak`/`strong`):
 * "the student solved a problem" is learning evidence, not durable-preference evidence, and must
 * never be promoted into one.
 */
export const EVIDENCE_EXPLICIT_STABLE = 'explicit-stable'

/** Record-size bounds, enforced before anything reaches the medium. */
export const MEMORY_BUDGETS = Object.freeze({
  /** Maximum number of global preference keys. */
  MAX_PREFERENCE_KEYS: 50,
  /** Maximum characters of one preference value. */
  MAX_PREFERENCE_VALUE_CHARS: 500,
  /** Maximum stable instructions kept per course. */
  MAX_INSTRUCTIONS: 20,
  /** Maximum characters of one instruction. */
  MAX_INSTRUCTION_CHARS: 500,
  /** Maximum characters of the recent-topic field. */
  MAX_RECENT_TOPIC_CHARS: 200,
  /** Maximum characters of a session id recorded on a course. */
  MAX_SESSION_ID_CHARS: 120,
})

const PREFERENCE_KEY = /^[a-z][a-z0-9_]{0,47}$/
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function fail(message, code, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

/**
 * The course-memory namespace for one project.
 *
 * `<projectId>@<hash12(resolved root)>`. The project id is the human-stable identity; the root
 * hash disambiguates two different folders that happen to reuse one id (the default
 * `professor-project`, for instance). Renaming the folder changes the hash and therefore starts a
 * fresh namespace — the old records stay in the medium untouched, which the diagnostics surface
 * through {@link createMemoryStore}'s `describe()`.
 *
 * @param projectId - the id from `.professor/project.yaml`.
 * @param projectRoot - the resolved academic folder path.
 * @returns the namespace string.
 */
export function courseMemoryNamespace(projectId, projectRoot) {
  const id = typeof projectId === 'string' && projectId.trim().length > 0 ? projectId.trim() : 'unknown-project'
  const hash = createHash('sha256').update(path.resolve(String(projectRoot))).digest('hex').slice(0, 12)
  return `${id}@${hash}`
}

/** The storage key of one course's memory record. */
export function courseMemoryKey(namespace, courseId) {
  return `${COURSE_KEY_PREFIX}${namespace}:${courseId}`
}

/** True when a storage key belongs to a course-memory record. */
export function isCourseMemoryKey(key) {
  return typeof key === 'string' && key.startsWith(COURSE_KEY_PREFIX)
}

/** Parse the namespace and course id back out of a course-memory key (diagnostics only). */
export function parseCourseMemoryKey(key) {
  if (!isCourseMemoryKey(key)) return undefined
  const rest = key.slice(COURSE_KEY_PREFIX.length)
  const splitAt = rest.lastIndexOf(':')
  if (splitAt <= 0) return undefined
  return { namespace: rest.slice(0, splitAt), courseId: rest.slice(splitAt + 1) }
}

// --- record validation --------------------------------------------------------

/**
 * The shared schema-tag gate: a record written by a newer plugin is *unsupported*, a record that
 * does not even carry the tag is *corrupt*. Neither is ever rewritten or deleted here.
 */
function assertSchemaTag(record, where) {
  if (!isPlainObject(record)) {
    throw fail(`${where} is not a record (got ${record === null ? 'null' : typeof record})`, 'PROFESSOR_MEMORY_CORRUPT')
  }
  if (typeof record.schema !== 'string') {
    throw fail(`${where} carries no schema tag; refusing to interpret it`, 'PROFESSOR_MEMORY_CORRUPT')
  }
  if (record.schema !== MEMORY_RECORD_SCHEMA) {
    throw fail(
      `${where} uses schema "${record.schema}", which this plugin (${MEMORY_RECORD_SCHEMA}) does not understand; the record is left untouched`,
      'PROFESSOR_MEMORY_UNSUPPORTED_SCHEMA',
    )
  }
}

/** Validate the preferences map of a global record. */
function validatePreferences(preferences, errors) {
  if (!isPlainObject(preferences)) {
    errors.push('preferences must be a mapping')
    return
  }
  for (const [key, entry] of Object.entries(preferences)) {
    if (!PREFERENCE_KEY.test(key)) errors.push(`preference key "${key}" must match ${PREFERENCE_KEY}`)
    if (!isPlainObject(entry)) {
      errors.push(`preferences.${key} must be a mapping`)
      continue
    }
    if (typeof entry.value !== 'string') errors.push(`preferences.${key}.value must be a string`)
    if (entry.evidence !== EVIDENCE_EXPLICIT_STABLE) {
      errors.push(`preferences.${key}.evidence must be "${EVIDENCE_EXPLICIT_STABLE}"`)
    }
  }
}

/** Validate a parsed global-preferences record (beyond the schema tag). */
function validateGlobalRecord(record, where) {
  const errors = []
  if (record.kind !== 'global_preferences') errors.push(`kind must be "global_preferences", found ${JSON.stringify(record.kind)}`)
  if (!Number.isInteger(record.revision) || record.revision < 1) errors.push('revision must be a positive integer')
  if (typeof record.updated_at !== 'string') errors.push('updated_at must be a string')
  validatePreferences(record.preferences, errors)
  return errors
}

/** Validate a parsed course-memory record. */
function validateCourseRecord(record, where) {
  const errors = []
  if (record.kind !== 'course_memory') errors.push(`kind must be "course_memory", found ${JSON.stringify(record.kind)}`)
  if (!Number.isInteger(record.revision) || record.revision < 1) errors.push('revision must be a positive integer')
  if (typeof record.updated_at !== 'string') errors.push('updated_at must be a string')
  if (typeof record.course_id !== 'string' || record.course_id.length === 0) errors.push('course_id must be a non-empty string')
  if (!isPlainObject(record.project) || typeof record.project.namespace !== 'string') {
    errors.push('project.namespace must be a string')
  }
  if (record.instructions !== undefined) {
    if (!Array.isArray(record.instructions) || record.instructions.some((item) => typeof item !== 'string')) {
      errors.push('instructions must be a list of strings')
    }
  }
  if (record.recent_topic !== undefined && record.recent_topic !== null && typeof record.recent_topic !== 'string') {
    errors.push('recent_topic must be a string or null')
  }
  if (record.last_session !== undefined && record.last_session !== null && !isPlainObject(record.last_session)) {
    errors.push('last_session must be a mapping or null')
  }
  return errors
}

/** Validate a parsed control record. */
function validateControlRecord(record) {
  const errors = []
  if (record.kind !== 'memory_control') errors.push(`kind must be "memory_control", found ${JSON.stringify(record.kind)}`)
  if (!Number.isInteger(record.revision) || record.revision < 1) errors.push('revision must be a positive integer')
  if (typeof record.updated_at !== 'string') errors.push('updated_at must be a string')
  if (typeof record.enabled !== 'boolean') errors.push('enabled must be a boolean')
  return errors
}

/** Read-side assertion with a kind-specific shape check. Never destructive. */
function assertRecord(record, kind, where) {
  assertSchemaTag(record, where)
  const errors = kind === 'global'
    ? validateGlobalRecord(record, where)
    : kind === 'course'
      ? validateCourseRecord(record, where)
      : validateControlRecord(record)
  if (errors.length > 0) {
    throw fail(`${where} is corrupt: ${errors.join('; ')}`, 'PROFESSOR_MEMORY_CORRUPT')
  }
  return record
}

/**
 * Create the memory store over one application-storage handle.
 *
 * @param options.appStorage - the {@link createAppStorage} handle (Phase 1); every write goes
 *   through its validated `writeRecord()`.
 * @param options.queueOwner - shared deployment identity when storage has multiple facets;
 *   defaults to the storage handle. All stores for one deployment must use the same identity.
 * @param options.now - clock (tests); defaults to ISO timestamps.
 */
const mutationQueues = new WeakMap()

export function createMemoryStore({ appStorage, queueOwner = appStorage, now = () => new Date().toISOString() }) {
  // The host does not offer compare-and-swap. Serialize the entire read/revision/write
  // transaction, including the memory-control check, across this shared lifecycle.
  /** Synchronous raw read of one key, or undefined. Throws when the storage is not open. */
  function rawGet(key) {
    const table = appStorage.table('app')
    if (table === undefined || typeof table.get !== 'function') {
      throw fail('professor application storage is not open, so memory cannot be read', 'PROFESSOR_MEMORY_UNAVAILABLE')
    }
    return table.get(key)
  }

  async function open() {
    const snapshot = await appStorage.ensureOpen()
    if (snapshot.status !== 'open') {
      throw fail(`professor memory is unavailable: ${snapshot.reason ?? 'storage did not open'}`, 'PROFESSOR_MEMORY_UNAVAILABLE')
    }
    return snapshot
  }

  /** Write-side gate shared by every mutation. */
  async function guardWrite() {
    await open()
    const control = rawGet(MEMORY_CONTROL_KEY)
    if (control !== undefined) {
      assertRecord(control, 'control', 'the memory control record')
      if (control.enabled !== true) {
        throw fail(
          'persistent memory is disabled: no memory write is performed. Re-enable with professor_memory_update (scope control, action set_enabled) — existing data is preserved',
          'PROFESSOR_MEMORY_DISABLED',
        )
      }
    }
  }

  /**
   * The revision guard: a mutation names the revision it read.
   *
   * When a record already exists, omitting `expectedRevision` is a lost-update hazard (the caller
   * never saw the current state), so it is refused exactly like a stale one. When the record does
   * not exist yet, `expectedRevision` must be absent (there is nothing to be stale against).
   */
  function guardRevision(current, expectedRevision, where) {
    if (current === undefined) {
      if (expectedRevision !== undefined) {
        throw fail(`${where} does not exist but a revision was named; re-read and retry`, 'PROFESSOR_MEMORY_STALE')
      }
      return 1
    }
    if (expectedRevision === undefined) {
      throw fail(`${where} already exists; read it first and pass its revision — an unguarded update could silently lose a concurrent write`, 'PROFESSOR_MEMORY_STALE')
    }
    if (expectedRevision !== current.revision) {
      throw fail(
        `${where} changed concurrently: expected revision ${expectedRevision}, found ${current.revision}. Re-read and retry`,
        'PROFESSOR_MEMORY_STALE',
      )
    }
    return current.revision + 1
  }

  async function write(key, record) {
    await appStorage.writeRecord(key, record)
    return record
  }

  const store = {
    /** The schema tag this store writes. */
    schema: MEMORY_RECORD_SCHEMA,

    /** Read the control record; absence means "enabled" (a fresh install has content, not a switch). */
    async readControl() {
      await open()
      const record = rawGet(MEMORY_CONTROL_KEY)
      if (record === undefined) return { present: false, enabled: true, record: null, revision: null }
      assertRecord(record, 'control', 'the memory control record')
      return { present: true, enabled: record.enabled, record, revision: record.revision }
    },

    /** True when memory is enabled (the default when no control record exists). */
    async isEnabled() {
      return (await this.readControl().catch(() => ({ enabled: true }))).enabled
    },

    /** Read the global-preferences record. */
    async readGlobal() {
      await open()
      const record = rawGet(GLOBAL_PREFERENCES_KEY)
      if (record === undefined) return { present: false, record: null, revision: null }
      assertRecord(record, 'global', 'the global preferences record')
      return { present: true, record, revision: record.revision }
    },

    /** Read one course's memory record. */
    async readCourse(namespace, courseId) {
      await open()
      const key = courseMemoryKey(namespace, courseId)
      const record = rawGet(key)
      if (record === undefined) return { present: false, record: null, revision: null }
      assertRecord(record, 'course', `the course memory record ${key}`)
      return { present: true, record, revision: record.revision }
    },

    /**
     * Set (or replace) one durable global preference.
     *
     * Requires {@link EVIDENCE_EXPLICIT_STABLE}; anything else is refused before the record is
     * touched, which is what makes "a temporary statement must not silently become permanent" an
     * executable rule rather than advice.
     */
    async setPreference({ key, value, evidence, expectedRevision }) {
      if (typeof key !== 'string' || !PREFERENCE_KEY.test(key)) {
        throw fail(`preference key must match ${PREFERENCE_KEY}`, 'PROFESSOR_MEMORY_INVALID')
      }
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw fail('preference value must be a non-empty string', 'PROFESSOR_MEMORY_INVALID')
      }
      if (value.length > MEMORY_BUDGETS.MAX_PREFERENCE_VALUE_CHARS) {
        throw fail(`preference value exceeds ${MEMORY_BUDGETS.MAX_PREFERENCE_VALUE_CHARS} characters`, 'PROFESSOR_MEMORY_INVALID')
      }
      if (evidence !== EVIDENCE_EXPLICIT_STABLE) {
        throw fail(
          `a durable global preference requires evidence "${EVIDENCE_EXPLICIT_STABLE}"; got ${JSON.stringify(evidence)}. `
          + 'A casual or temporary statement must not become permanent — pass it as a session instruction instead',
          'PROFESSOR_MEMORY_INVALID',
        )
      }
      await guardWrite()
      const current = rawGet(GLOBAL_PREFERENCES_KEY)
      if (current !== undefined) assertRecord(current, 'global', 'the global preferences record')
      const revision = guardRevision(current, expectedRevision, 'the global preferences record')

      const preferences = { ...(current?.preferences ?? {}) }
      if (Object.keys(preferences).length >= MEMORY_BUDGETS.MAX_PREFERENCE_KEYS && !(key in preferences)) {
        throw fail(`the global preference map is full (${MEMORY_BUDGETS.MAX_PREFERENCE_KEYS} keys)`, 'PROFESSOR_MEMORY_INVALID')
      }
      preferences[key] = { value: value.trim(), evidence, updated_at: now() }
      const record = {
        schema: MEMORY_RECORD_SCHEMA,
        kind: 'global_preferences',
        revision,
        updated_at: now(),
        preferences,
      }
      await write(GLOBAL_PREFERENCES_KEY, record)
      return { written: true, revision, record }
    },

    /** Remove one preference key (absence of the key is not an error). */
    async clearPreference({ key, expectedRevision }) {
      if (typeof key !== 'string' || !PREFERENCE_KEY.test(key)) {
        throw fail(`preference key must match ${PREFERENCE_KEY}`, 'PROFESSOR_MEMORY_INVALID')
      }
      await guardWrite()
      const current = rawGet(GLOBAL_PREFERENCES_KEY)
      if (current === undefined) return { written: false, revision: null, record: null }
      assertRecord(current, 'global', 'the global preferences record')
      if (!(key in (current.preferences ?? {}))) {
        return { written: false, revision: current.revision, record: current }
      }
      const revision = guardRevision(current, expectedRevision, 'the global preferences record')
      const preferences = { ...current.preferences }
      delete preferences[key]
      const record = {
        schema: MEMORY_RECORD_SCHEMA,
        kind: 'global_preferences',
        revision,
        updated_at: now(),
        preferences,
      }
      await write(GLOBAL_PREFERENCES_KEY, record)
      return { written: true, revision, record }
    },

    /**
     * Patch one course's memory record (created on first write).
     *
     * @param patch.instructions - replaces the whole instruction list when present.
     * @param patch.addInstruction - appends one instruction (deduplicated).
     * @param patch.recentTopic - sets or clears (null) the recent topic.
     * @param patch.lastSession - `{ session_id, at }` session metadata, or null.
     * @param patch.identity - `{ courseCode, term, project }` recorded on creation.
     */
    async updateCourse(namespace, courseId, patch = {}, { expectedRevision } = {}) {
      if (typeof namespace !== 'string' || namespace.length === 0 || namespace.length > 200) {
        throw fail('a non-empty namespace is required', 'PROFESSOR_MEMORY_INVALID')
      }
      if (typeof courseId !== 'string' || courseId.length === 0 || courseId.length > 120) {
        throw fail('a non-empty course id is required', 'PROFESSOR_MEMORY_INVALID')
      }
      await guardWrite()
      const key = courseMemoryKey(namespace, courseId)
      const current = rawGet(key)
      if (current !== undefined) assertRecord(current, 'course', `the course memory record ${key}`)
      const revision = guardRevision(current, expectedRevision, `the course memory record ${key}`)

      let instructions = current?.instructions ?? []
      if (patch.instructions !== undefined) {
        if (!Array.isArray(patch.instructions) || patch.instructions.some((item) => typeof item !== 'string')) {
          throw fail('instructions must be a list of strings', 'PROFESSOR_MEMORY_INVALID')
        }
        instructions = patch.instructions.map((item) => item.trim()).filter((item) => item.length > 0)
      }
      if (patch.addInstruction !== undefined) {
        const instruction = typeof patch.addInstruction === 'string' ? patch.addInstruction.trim() : ''
        if (instruction.length === 0) throw fail('addInstruction must be a non-empty string', 'PROFESSOR_MEMORY_INVALID')
        if (!instructions.includes(instruction)) instructions = [...instructions, instruction]
      }
      if (instructions.length > MEMORY_BUDGETS.MAX_INSTRUCTIONS) {
        throw fail(`a course keeps at most ${MEMORY_BUDGETS.MAX_INSTRUCTIONS} instructions`, 'PROFESSOR_MEMORY_INVALID')
      }
      for (const instruction of instructions) {
        if (instruction.length > MEMORY_BUDGETS.MAX_INSTRUCTION_CHARS) {
          throw fail(`an instruction exceeds ${MEMORY_BUDGETS.MAX_INSTRUCTION_CHARS} characters`, 'PROFESSOR_MEMORY_INVALID')
        }
      }

      let recentTopic = current?.recent_topic ?? null
      if (patch.recentTopic !== undefined) {
        if (patch.recentTopic !== null && typeof patch.recentTopic !== 'string') {
          throw fail('recentTopic must be a string or null', 'PROFESSOR_MEMORY_INVALID')
        }
        recentTopic = patch.recentTopic === null || patch.recentTopic.trim().length === 0
          ? null
          : patch.recentTopic.trim()
      }
      if (recentTopic !== null && recentTopic.length > MEMORY_BUDGETS.MAX_RECENT_TOPIC_CHARS) {
        throw fail(`recent_topic exceeds ${MEMORY_BUDGETS.MAX_RECENT_TOPIC_CHARS} characters`, 'PROFESSOR_MEMORY_INVALID')
      }

      let lastSession = current?.last_session ?? null
      if (patch.lastSession !== undefined) {
        if (patch.lastSession !== null && !isPlainObject(patch.lastSession)) {
          throw fail('lastSession must be a mapping or null', 'PROFESSOR_MEMORY_INVALID')
        }
        lastSession = patch.lastSession
      }

      const created = current === undefined
      const record = {
        schema: MEMORY_RECORD_SCHEMA,
        kind: 'course_memory',
        revision,
        updated_at: now(),
        course_id: courseId,
        project: current?.project ?? patch.identity?.project ?? { namespace },
        course_code: current?.course_code ?? patch.identity?.courseCode ?? null,
        term: current?.term ?? patch.identity?.term ?? null,
        instructions,
        recent_topic: recentTopic,
        last_session: lastSession,
      }
      assertRecord(record, 'course', `the course memory record ${key}`)
      await write(key, record)
      return { written: true, created, revision, record }
    },

    /**
     * Enable or disable persistent memory.
     *
     * This is the one mutation that stays legal while memory is disabled — otherwise a disabled
     * user could never switch back on. Disabling never deletes stored records.
     */
    async setEnabled({ enabled, reason, expectedRevision }) {
      if (typeof enabled !== 'boolean') {
        throw fail('enabled must be a boolean', 'PROFESSOR_MEMORY_INVALID')
      }
      await open()
      const current = rawGet(MEMORY_CONTROL_KEY)
      if (current !== undefined) assertRecord(current, 'control', 'the memory control record')
      const revision = guardRevision(current, expectedRevision, 'the memory control record')
      const record = {
        schema: MEMORY_RECORD_SCHEMA,
        kind: 'memory_control',
        revision,
        updated_at: now(),
        enabled,
        reason: typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : null,
      }
      await write(MEMORY_CONTROL_KEY, record)
      return { written: true, revision, record }
    },

    /** A bounded, honest snapshot for diagnostics and the status tool. */
    async describe() {
      const control = await this.readControl().catch((error) => ({ present: false, enabled: true, error: error.code }))
      // Asking for status is itself a read: open lazily so a healthy host reports `open`, while a
      // host without a storage domain keeps its honest `unopened` report plus a named problem.
      let storage = appStorage.describe()
      if (storage.status !== 'open') {
        try {
          await open()
          storage = appStorage.describe()
        } catch (error) {
          control.error = control.error ?? error.code
        }
      }
      let globalCount = 0
      let courseKeys = 0
      try {
        const global = rawGet(GLOBAL_PREFERENCES_KEY)
        if (global !== undefined) {
          assertRecord(global, 'global', 'the global preferences record')
          globalCount = Object.keys(global.preferences ?? {}).length
        }
        const table = appStorage.table('app')
        if (table !== undefined && typeof table.keys === 'function') {
          courseKeys = Array.from(table.keys()).filter(isCourseMemoryKey).length
        }
      } catch {
        // A corrupt record must not break the status report; the read tools name it precisely.
      }
      return {
        storage,
        enabled: control.enabled !== false,
        controlPresent: control.present === true,
        counts: { global_preferences: globalCount, course_records: courseKeys },
        budgets: { ...MEMORY_BUDGETS },
        ...(control.error !== undefined ? { problems: [control.error] } : {}),
      }
    },
  }
  for (const name of ['setPreference', 'clearPreference', 'updateCourse', 'setEnabled']) {
    const mutate = store[name].bind(store)
    store[name] = (...args) => {
      const outcome = (mutationQueues.get(queueOwner) ?? Promise.resolve()).then(() => mutate(...args))
      mutationQueues.set(queueOwner, outcome.catch(() => {}))
      return outcome
    }
  }
  return store
}
