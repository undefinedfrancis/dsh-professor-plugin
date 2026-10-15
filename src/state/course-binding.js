/**
 * Per-session course binding.
 *
 * ## Why this is a project-side file and not a session event
 *
 * The v3 design (§4.6) specifies that binding changes append a custom session event
 * (`professor/course-bound`) to the Harness session log. That is **unimplementable** in the
 * installed Harness and the deviation is documented in `docs/AUDIT.md §3`:
 *
 * - `KNOWN_SESSION_EVENT_TYPES` in `dsh-session` is a closed 54-entry set with no plugin
 *   extension type and no wildcard;
 * - `Session.append()` exposes only `{type, seq, time, data}` plus `surfaceOp`/`sourceEventSeqs`
 *   — it has no `ignorable` channel;
 * - `dsh-session-persistence.validateStoredEvents()` **throws** on a non-ignorable event outside
 *   the set, and it runs during the JSONL backend's `open()`/`verify()`. Appending a custom event
 *   would therefore make the whole session log un-restorable after a restart.
 *
 * So the binding is stored **per project, keyed by the session id**, at
 * `.professor/state/sessions/<session_id>.json`:
 *
 * - one file per session ⇒ no cross-session write contention and no shared mutable row;
 * - absence of a file means "this session has never bound a course", which is a legitimate state
 *   that must be reported as such — **never** silently inherited from another session;
 * - switches are recorded in an append-only `history[]` so a replay of one session is
 *   deterministic and every change is attributable;
 * - the file lives inside `.professor/state/`, which is already inside the plugin's write policy
 *   and the Harness `workspace-write` sandbox.
 *
 * Writes go through the filesystem gateway with `replaceIfVersion` (read → compare → write), so a
 * concurrent update cannot be silently lost.
 *
 * @module dsh-professor-spike/src/state/course-binding
 */

import path from 'node:path'

import { projectPaths, sessionId as sessionIdOf } from '../paths/roots.js'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function fail(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * The binding file for one session.
 *
 * The session id is a filesystem-safe component (no separators) but is still sanitised so a
 * malformed id cannot escape `state/sessions/`.
 *
 * @returns the absolute path of the session's binding file.
 */
export function bindingFileFor(projectRoot, id) {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw fail('session id is required to locate a course binding', 'PROFESSOR_BINDING_SESSION_REQUIRED')
  }
  // Reject anything that could escape `state/sessions/` instead of silently rewriting it: a
  // sanitised-but-accepted id would make "this session's file" mean something the caller did not
  // intend, which is exactly the ambiguity the no-fallback invariant exists to prevent.
  if (/[\\/]/.test(id) || id.includes('..')) {
    throw fail(`session id must not contain path separators or ".." (got "${id}")`, 'PROFESSOR_BINDING_SESSION_REQUIRED')
  }
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(projectPaths(projectRoot).sessionsDir, `${safe}.json`)
}

/**
 * Validate a binding record.
 *
 * @param value - the parsed record.
 * @returns `{ ok, errors }`; never throws.
 */
export function validateBinding(value) {
  const errors = []
  if (!isPlainObject(value)) return { ok: false, errors: ['binding record must be a mapping'] }
  if (value.session_id !== undefined && typeof value.session_id !== 'string') errors.push('session_id must be a string')
  if (value.course_id !== undefined && value.course_id !== null && typeof value.course_id !== 'string') {
    errors.push('course_id must be a string or null')
  }
  if (value.bound_at !== undefined && value.bound_at !== null && typeof value.bound_at !== 'string') {
    errors.push('bound_at must be an ISO-8601 string or null')
  }
  if (value.reason !== undefined && value.reason !== null && typeof value.reason !== 'string') {
    errors.push('reason must be a string or null')
  }
  if (value.history !== undefined && !Array.isArray(value.history)) errors.push('history must be a list')
  for (const [index, entry] of (Array.isArray(value.history) ? value.history : []).entries()) {
    if (!isPlainObject(entry)) {
      errors.push(`history[${index}] must be a mapping`)
      continue
    }
    if (entry.course_id !== undefined && entry.course_id !== null && typeof entry.course_id !== 'string') {
      errors.push(`history[${index}].course_id must be a string or null`)
    }
    if (entry.at !== undefined && entry.at !== null && typeof entry.at !== 'string') {
      errors.push(`history[${index}].at must be an ISO-8601 string or null`)
    }
    if (entry.reason !== undefined && entry.reason !== null && typeof entry.reason !== 'string') {
      errors.push(`history[${index}].reason must be a string or null`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Create an empty binding record for a session.
 *
 * @returns the record; `course_id` starts as `null` and must be bound explicitly.
 */
export function emptyBinding(id) {
  return {
    session_id: id,
    course_id: null,
    bound_at: null,
    reason: null,
    history: [],
  }
}

/**
 * Read this session's binding, without ever consulting any other session.
 *
 * This is the no-fallback invariant: there is exactly one lookup key (`session id`) and the
 * answer is either this session's record, `null` when nothing is written yet, or an error when
 * the file exists but is unusable. No other session, no cached projection, no environment default.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.projectRoot - absolute project root.
 * @param options.sessionId - the calling session id.
 * @param options.signal - cancellation.
 * @returns `{ present, record }`; `present: false` means this session has never bound a course.
 * @throws when the file exists but cannot be parsed or fails validation.
 */
export async function readBinding(options) {
  const { gateway, projectRoot, sessionId, signal } = options
  const file = bindingFileFor(projectRoot, sessionId)
  const target = await gateway.resolveTarget(file, { cwd: projectRoot, signal })
  const info = await gateway.stat(target, signal)
  if (info === undefined) return { present: false, record: null }

  const raw = await gateway.readText(target, signal)
  const observedVersion = info.version
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw fail(`binding file for session ${sessionId} is corrupt: ${error.message}`, 'PROFESSOR_BINDING_CORRUPT')
  }
  const validation = validateBinding(parsed)
  if (!validation.ok) {
    throw fail(`binding file for session ${sessionId} is invalid: ${validation.errors.join('; ')}`, 'PROFESSOR_BINDING_CORRUPT')
  }
  return { present: true, record: parsed, observedVersion }
}

/**
 * Write a binding record for one session, guarded against a concurrent update.
 *
 * `version` is the fs version observed when the record was read. When `version` is undefined and
 * the file already exists, this is a lost update waiting to happen, so it refuses rather than
 * silently overwriting.
 *
 * @returns the gateway write outcome.
 * @throws with `code = 'PROFESSOR_BINDING_STALE'` when the file changed since it was read.
 */
export async function writeBinding(options) {
  const {
    gateway, projectRoot, sessionId, record, session, signal, writePolicy, version,
  } = options

  const validation = validateBinding(record)
  if (!validation.ok) {
    throw fail(`refusing to write an invalid binding: ${validation.errors.join('; ')}`, 'PROFESSOR_BINDING_CORRUPT')
  }
  if (writePolicy === undefined || typeof writePolicy.assert !== 'function') {
    throw fail('refusing to write a binding without a write policy', 'PROFESSOR_PATH_DENIED')
  }

  const file = bindingFileFor(projectRoot, sessionId)
  const target = await gateway.resolveTarget(file, { cwd: projectRoot, signal })
  const info = await gateway.stat(target, signal)
  const expected = info === undefined
    ? { kind: 'createIfAbsent' }
    : version === undefined
      ? null
      : { kind: 'replaceIfVersion', version }

  if (expected === null) {
    throw fail(
      `binding file for session ${sessionId} already exists but was not read in this call; re-read before writing`,
      'PROFESSOR_BINDING_STALE',
    )
  }

  try {
    return await gateway.writeFile({
      filePath: file,
      cwd: projectRoot,
      content: `${JSON.stringify(record, null, 2)}\n`,
      session,
      signal,
      writePolicy,
      expected,
    })
  } catch (error) {
    if (error?.code === 'FS_STALE_VERSION' || error?.code === 'PROFESSOR_BINDING_STALE') {
      const wrapped = new Error(`binding for session ${sessionId} changed concurrently: ${error.message}`)
      wrapped.code = 'PROFESSOR_BINDING_STALE'
      wrapped.cause = error
      throw wrapped
    }
    throw error
  }
}

/**
 * Apply a bind/unbind operation to a record, producing the next record plus its history entry.
 *
 * History is append-only: switching away from a course never rewrites the past, so a replay of
 * the session reproduces every step.
 *
 * @param options.record - the current record (or `null` for a first bind).
 * @param options.courseId - the course to bind, or `null` to unbind.
 * @param options.reason - why (e.g. `user-choice`, `explicit-unbind`).
 * @param options.at - ISO timestamp; injected for deterministic tests.
 * @returns `{ record, entry, changed }`.
 */
export function applyBind(options) {
  const { record, courseId, reason, at } = options
  const previous = record ?? emptyBinding(record?.session_id ?? options.sessionId)
  const previousCourse = previous.course_id ?? null
  const nextCourse = courseId === undefined ? null : courseId

  const entry = {
    from: previousCourse,
    to: nextCourse,
    reason: reason ?? null,
    at: at ?? null,
  }
  const changed = previousCourse !== nextCourse

  const next = {
    ...previous,
    session_id: options.sessionId,
    course_id: nextCourse,
    bound_at: nextCourse === null ? null : at ?? previous.bound_at ?? null,
    reason: nextCourse === null ? null : reason ?? previous.reason ?? null,
    history: [...(Array.isArray(previous.history) ? previous.history : []), entry],
  }
  return { record: next, entry, changed }
}
