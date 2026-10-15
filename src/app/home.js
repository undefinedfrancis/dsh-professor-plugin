/**
 * Professor Home: the backend behind the sidebar entry.
 *
 * Scope, precisely
 * ----------------
 * This module answers three questions and owns nothing else:
 *
 *   - `home()`       — what should Home show right now (continue target, configured courses,
 *                      recent Professor sessions, and an honest empty state);
 *   - `launch()`     — set up a **native** Harness session and hand back its id for official
 *                      client navigation;
 *   - `reopen()`     — is a stored session still something we are willing to navigate to.
 *
 * It deliberately does **not** implement a chat surface, a second conversation store, or a second
 * history: the native session is the conversation. Everything persisted here is *metadata* — which
 * native session belongs to which launch request, under which course and study mode — and it is
 * written through {@link module:src/app/sessions}, which refuses transcripts by construction.
 *
 * Launch order is the contract
 * ----------------------------
 * A launch must not hand the UI a session that is not ready, so the steps are ordered and every
 * step is either idempotent or fatal:
 *
 *   1. validate the request (mode, request id, optional course, optional topic);
 *   2. resolve the course against the **authoritative project document** — never against a name a
 *      caller invented, and never by falling back to "some" course;
 *   3. reserve metadata idempotently (`requestId → sessionId`, so a second click cannot race);
 *   4. create or **recover** the native session under that id (no duplicate on retry);
 *   5. select the `professor` preset;
 *   6. apply the course binding, when a course is involved;
 *   7. hydrate Professor memory/context for the new agent;
 *   8. mark metadata `ready` **only** after every step above succeeded;
 *   9. return the native session id.
 *
 * Anything that fails marks the row `failed` with a bounded reason and rethrows, so the same
 * request can be retried safely on the *same* native session instead of leaking another one.
 *
 * Nothing here submits a model turn.
 *
 * @module dsh-professor-spike/src/app/home
 */

import { readConnectionRecord } from '../workspace/onboarding.js'
import path from 'node:path'
import { STUDY_MODES } from './sessions.js'

/** The Typert namespace the client mounts (`ctx.remote.professorHome`). */
export const PROFESSOR_HOME_NAMESPACE = 'professorHome'

/** The package id every contribution declares, so its endpoints are attributable. */
export const REMOTE_PACKAGE = 'dsh-professor-spike'

/** The preset a Professor session must compose; anything else is not a Professor session. */
export const PROFESSOR_PRESET_ID = 'professor'

/** Study modes and the labels Home renders. One source of truth, shared with the registry. */
export const STUDY_MODE_LABELS = Object.freeze({
  learn: '学习',
  question: '提问',
  assignment: '作业',
  review: '复习',
  exam: '备考',
  free: '自由学习',
})

/** How many recent sessions Home offers. Bounded: this is a list of entry points, not an archive. */
export const HOME_RECENT_LIMIT = 10

/** Longest contribution the topic may make to a generated title. */
const TOPIC_TITLE_LIMIT = 60

/** The registry's own title bound. */
const TITLE_LIMIT = 160

/** Request ids are bounded and filesystem-safe: they become part of a native session id. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

/** Longest accepted topic, before it is folded into a title. */
const TOPIC_LIMIT = 200

function fail(code, message, extra = {}) {
  return Object.assign(Object.assign(new Error(message), { code }), extra)
}

/** A bounded, single-line, control-character-free fragment. */
function sanitizeFragment(value, limit) {
  const collapsed = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed
}

/**
 * The native session id for one launch request.
 *
 * Derived, not allocated: the same request must land on the same native session on retry, which is
 * what makes "no duplicate session per repeated click" true even if the process restarted before
 * the row was marked ready.
 */
export function nativeSessionIdFor(requestId) {
  return `professor-${requestId}`
}

/**
 * Build the (bounded) session title.
 *
 * The topic is **not** persisted as its own field — there is no approved slot for it in the session
 * metadata — so when there is a topic it is folded into the title, sanitized and truncated. With no
 * topic and no course the title is the study mode alone, which is enough to tell sessions apart in
 * a list and never invents a course name.
 */
export function buildSessionTitle({ mode, course = null, topic = '', now = () => new Date() }) {
  const parts = []
  if (course !== null && course !== undefined) {
    parts.push(sanitizeFragment(course.display_name ?? course.course_code ?? course.course_id, 60))
  }
  const cleanTopic = sanitizeFragment(topic, TOPIC_TITLE_LIMIT)
  if (cleanTopic.length > 0) parts.push(cleanTopic)
  parts.push(STUDY_MODE_LABELS[mode] ?? String(mode))
  const title = sanitizeFragment(parts.join(' · '), TITLE_LIMIT)
  if (title.length > 0) return title
  return `${STUDY_MODE_LABELS[mode] ?? String(mode)} ${now().toISOString().slice(0, 10)}`
}

/**
 * The configured courses, read from the authoritative project document.
 *
 * Resolution order matters: the connected academic folder comes from the connection record in
 * application storage, and the courses come from `.professor/project.yaml` inside it. Nothing is
 * inferred from a directory name, and nothing is invented when there is no connected folder — an
 * unconnected installation reports `connected: false` with an empty course list, which Home renders
 * as its course-free empty state.
 *
 * @param options.appStorage - a facet of the shared storage owner.
 * @param options.readCourses - `(projectRoot, signal) => Promise<courses[]>`; see
 *   {@link createFilesystemCourseCatalog}.
 */
export function createCourseCatalog({ appStorage, readCourses }) {
  return {
    /**
     * @returns `{ connected, projectRoot, courses, unavailable, warnings }`.
     */
    async describe() {
      const connection = await readConnectionRecord(appStorage)
      const warnings = []
      const storageBroken = connection.unavailable !== null
      if (storageBroken) {
        warnings.push(`Professor application storage is unavailable, so no academic folder can be resolved: ${connection.unavailable}`)
        return { connected: false, projectRoot: null, courses: [], unavailable: connection.unavailable, warnings }
      }
      if (connection.present && connection.supported !== true) {
        warnings.push(`the workspace connection record uses an unsupported schema (${connection.version ?? 'unknown'}) and has not been changed`)
        return { connected: false, projectRoot: null, courses: [], unavailable: null, warnings }
      }
      const projectRoot = connection.record?.active?.folder ?? null
      if (projectRoot === null) {
        return { connected: false, projectRoot: null, courses: [], unavailable: null, warnings }
      }
      let courses
      try {
        courses = await readCourses(projectRoot)
      } catch (error) {
        warnings.push(`the connected folder's project document could not be read: ${error?.message ?? String(error)}`)
        return { connected: true, projectRoot, courses: [], unavailable: error?.message ?? String(error), warnings }
      }
      return { connected: true, projectRoot, courses, unavailable: null, warnings }
    },
  }
}

/**
 * Create the Home service.
 *
 * Every host interaction arrives through `host`, so the orchestration is unit-testable without the
 * desktop, and nothing here reaches for `ctx` on its own.
 *
 * @param options.appStorage - storage facet that lives as long as Home does.
 * @param options.registry - {@link createSessionRegistry} over the same facet.
 * @param options.catalog - {@link createCourseCatalog}.
 * @param options.host - native access: `createSession`, `findAgent`, `hasSession`, `selectPreset`,
 *   `composedPreset`, `bindCourse`, `hydrate`, `defaultCwd`.
 * @param options.logger - plugin logger.
 * @param options.presetId - overridable for tests; defaults to {@link PROFESSOR_PRESET_ID}.
 */
export function createProfessorHome({
  appStorage, registry, catalog, host, logger, presetId = PROFESSOR_PRESET_ID,
}) {
  /** One in-flight launch per request id: a second click joins it instead of racing it. */
  const inFlight = new Map()
  let disposed = false

  const guard = () => {
    if (disposed) {
      throw fail('PROFESSOR_HOME_DISPOSED', 'Professor Home has been disabled; start Harness again with Professor enabled to continue.')
    }
  }

  /** Refuse (never guess) every mode the session metadata layer does not accept. */
  function parseRequest(request) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw fail('PROFESSOR_HOME_REQUEST_INVALID', 'Expected a launch request.')
    }
    const { requestId, mode, courseId, topic, signal, folder } = request
    if (folder !== undefined && (typeof folder !== 'string' || folder.length > 4096 || !path.isAbsolute(folder) || /[\u0000-\u001f\u007f]/u.test(folder) || mode !== 'free' || courseId != null)) {
      throw fail('PROFESSOR_HOME_REQUEST_INVALID', 'Choose an absolute workspace folder for course setup.')
    }
    if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
      throw fail('PROFESSOR_HOME_REQUEST_INVALID', 'Expected a request id of 8-64 letters, digits, dashes or underscores.')
    }
    if (typeof mode !== 'string' || !STUDY_MODES.includes(mode)) {
      throw fail('PROFESSOR_HOME_REQUEST_INVALID', `Expected a supported study mode (${STUDY_MODES.join(', ')}).`)
    }
    if (courseId !== undefined && courseId !== null && (typeof courseId !== 'string' || courseId.trim().length === 0)) {
      throw fail('PROFESSOR_HOME_REQUEST_INVALID', 'Expected either no course or a course id.')
    }
    if (topic !== undefined && topic !== null && typeof topic !== 'string') {
      throw fail('PROFESSOR_HOME_REQUEST_INVALID', 'Expected the topic to be absent or a string.')
    }
    if (typeof topic === 'string' && topic.length > TOPIC_LIMIT) {
      throw fail('PROFESSOR_HOME_REQUEST_INVALID', `Expected a topic of at most ${TOPIC_LIMIT} characters.`)
    }
    return {
      requestId, mode, courseId: courseId ?? null, topic: typeof topic === 'string' ? topic : '', signal, folder: folder === undefined ? undefined : path.normalize(folder),
    }
  }

  /**
   * Resolve the requested course against the authoritative list.
   *
   * A missing course is fatal for that launch (never silently downgraded to a general session):
   * launching the wrong course would put the teaching in the wrong material.
   */
  async function resolveCourseTarget(courseId, catalogState) {
    if (courseId === null) return null
    if (catalogState.connected !== true) {
      throw fail('PROFESSOR_COURSE_UNAVAILABLE', 'No academic folder is connected, so no course can be selected. Connect a folder first, or start a session without a course.')
    }
    if (catalogState.unavailable !== null) {
      throw fail('PROFESSOR_COURSE_UNAVAILABLE', `The connected folder's courses could not be read: ${catalogState.unavailable}`)
    }
    const course = catalogState.courses.find((entry) => entry.course_id === courseId || entry.course_code === courseId)
    if (course === undefined) {
      const known = catalogState.courses.map((entry) => entry.course_id).join(', ')
      throw fail('PROFESSOR_COURSE_UNKNOWN', `No configured course matches "${courseId}". Known courses: ${known.length > 0 ? known : '(none)'}.`)
    }
    return course
  }

  /** Create the native session, or recover the one this request already created. */
  async function ensureNativeSession({ sessionId, catalogState, folder }) {
    const existing = await host.findAgent(sessionId)
    if (existing !== undefined) return { agent: existing, reused: true }
    const cwd = folder ?? catalogState.projectRoot ?? host.defaultCwd()
    let created
    try {
      created = await host.createSession({ sessionId, cwd })
    } catch (error) {
      throw fail('PROFESSOR_NATIVE_SESSION_UNAVAILABLE', `Harness could not open the study session: ${error?.message ?? String(error)}`)
    }
    const agent = created?.agent ?? created
    if (agent === undefined || agent === null) {
      throw fail('PROFESSOR_NATIVE_SESSION_UNAVAILABLE', 'Harness returned no agent for the new study session.')
    }
    return { agent, reused: false }
  }

  /**
   * Step 5: select the preset when the session is not already a Professor session, then verify it
   * **composes** the preset — claiming success is not evidence.
   *
   * Selecting on a recovered session is deliberate, and safe: {@link ensureNativeSession} only ever
   * recovers an id that {@link nativeSessionIdFor} derived from this very launch request, so it is
   * our own session by construction. Refusing to finish setup there would leave exactly the state a
   * retry exists to repair — created but never completed — permanently unusable. A session with no
   * Professor metadata row cannot be reached by this path at all.
   */
  async function ensurePreset(agent) {
    let composed
    try {
      composed = await host.composedPreset(agent)
    } catch (error) {
      throw fail('PROFESSOR_PRESET_UNAVAILABLE', `The Professor preset could not be read for this session: ${error?.message ?? String(error)}`)
    }
    if (composed === presetId) return composed
    let selected
    try {
      selected = await host.selectPreset(agent, presetId)
    } catch (error) {
      throw fail('PROFESSOR_PRESET_UNAVAILABLE', `Harness refused to select the "${presetId}" preset: ${error?.message ?? String(error)}`)
    }
    const after = await host.composedPreset(agent)
    if (after !== presetId) {
      throw fail('PROFESSOR_PRESET_UNAVAILABLE', `The Professor preset is unavailable: selection returned ${String(selected)} and the session now composes ${String(after)}.`)
    }
    return after
  }

  /** Mark a row failed without letting the bookkeeping error replace the real cause. */
  async function settleFailure(sessionId, error) {
    const message = sanitizeFragment(error?.message ?? String(error), 480)
    try {
      if (typeof sessionId === 'string') await registry.settle(sessionId, { status: 'failed', error: message.length > 0 ? message : 'setup failed' })
    } catch (settleError) {
      logger?.warn?.(`professor home could not record the failed launch: ${settleError?.message ?? String(settleError)}`)
    }
  }

  /**
   * Launch one study session. See §Launch order above.
   *
   * @returns `{ ok, sessionId, requestId, title, mode, courseId, reused, setup, warnings }`.
   * @throws with one of the documented codes; the metadata row is then `failed`, not lost.
   */
  async function launch(request) {
    guard()
    const parsed = parseRequest(request)
    const { requestId, mode, courseId, topic, signal, folder } = parsed
    if (signal?.aborted === true) {
      throw fail('PROFESSOR_LAUNCH_CANCELLED', 'The launch was cancelled before it started.')
    }
    const running = inFlight.get(requestId)
    if (running !== undefined) {
      if (running.signature !== JSON.stringify({ mode, courseId, topic, folder })) {
        throw fail('PROFESSOR_SESSION_CONFLICT', 'This launch request is already preparing different session metadata.')
      }
      return running.promise
    }

    const attempt = (async () => {
      const catalogState = await catalog.describe()
      const course = await resolveCourseTarget(courseId, catalogState)
      const sessionId = nativeSessionIdFor(requestId)
      const previous = await registry.get(sessionId)
      const title = topic.length === 0 && previous !== null
        ? previous.title : buildSessionTitle({ mode, course, topic })
      const row = await registry.reserve({
        requestId, sessionId, courseId: course?.course_id ?? null, title, mode,
      })
      try {
        if (signal?.aborted === true) {
          throw fail('PROFESSOR_LAUNCH_CANCELLED', 'The launch was cancelled while the session was being opened.')
        }
        const { agent, reused } = await ensureNativeSession({ sessionId, catalogState, folder })
        if (folder !== undefined && path.normalize(agent?.session?.header?.cwd ?? '') !== folder) {
          throw fail('PROFESSOR_SESSION_INCOMPATIBLE', 'This setup session belongs to another folder. Scan the selected folder again.')
        }
        if (course !== null && agent?.session?.header?.cwd !== catalogState.projectRoot) {
          throw fail('PROFESSOR_SESSION_INCOMPATIBLE', 'This session belongs to a different academic folder. Start a new study session; no course binding has been changed.')
        }
        const preset = await ensurePreset(agent)
        let bound = null
        if (course !== null) {
          bound = await host.bindCourse({
            agent, projectRoot: catalogState.projectRoot, courseId: course.course_id,
          })
          if (bound !== true) {
            throw fail('PROFESSOR_COURSE_UNAVAILABLE', `The course binding could not be applied to this session (${course.course_id}).`)
          }
        }
        const hydrated = await host.hydrate(agent)
        if (hydrated !== true) throw fail('PROFESSOR_MEMORY_NOT_READY', 'Professor memory could not be prepared. Retry this launch before opening the conversation.')
        guard()
        if (signal?.aborted === true) throw fail('PROFESSOR_LAUNCH_CANCELLED', 'The launch was cancelled during setup.')
        await host.setTitle?.(agent, title)
        await registry.settle(row.sessionId, { status: 'ready' })
        logger?.info?.(`professor home launched ${sessionId} (mode ${mode}${course ? `, course ${course.course_id}` : ''})`)
        return {
          ok: true,
          sessionId,
          requestId,
          title,
          mode,
          courseId: course?.course_id ?? null,
          reused,
          setup: { preset, bound, hydrated, projectRoot: catalogState.projectRoot },
          warnings: catalogState.warnings,
        }
      } catch (error) {
        await settleFailure(row.sessionId, error)
        throw error
      }
    })()
    inFlight.set(requestId, { promise: attempt, signature: JSON.stringify({ mode, courseId, topic, folder }) })
    try {
      return await attempt
    } finally {
      inFlight.delete(requestId)
    }
  }

  /**
   * Home data.
   *
   * A **storage failure is never rendered as an empty Home**: when the session registry cannot be
   * read the result carries `ok: false` with the code and message, and leaves `recent` empty rather
   * than pretending "there are no sessions". Courses are reported independently, because they do
   * not come from the same records.
   */
  async function homeData() {
    guard()
    const catalogState = await catalog.describe()
    const recent = []
    let continueTarget = null
    let failure = null
    try {
      const rows = (await registry.list()).filter(row => row.status !== 'archived').slice(0, HOME_RECENT_LIMIT)
      for (const row of rows) {
        const usable = row.status === 'ready' && await host.hasSession(row.sessionId)
        recent.push({ ...row, usable })
        if (continueTarget === null && usable) continueTarget = { ...row, usable: true }
      }
    } catch (error) {
      failure = { code: error?.code ?? 'PROFESSOR_SESSION_STORAGE_UNAVAILABLE', message: error?.message ?? String(error) }
    }
    const storage = (() => {
      try {
        return appStorage.describe()
      } catch {
        return { status: 'unavailable', reason: 'Professor application storage is not mounted' }
      }
    })()
    const payload = {
      ok: failure === null,
      storage,
      connection: {
        connected: catalogState.connected,
        folder: catalogState.projectRoot,
        unavailable: catalogState.unavailable,
      },
      courses: catalogState.courses.map((course) => ({
        course_id: course.course_id,
        course_code: course.course_code,
        display_name: course.display_name,
        term: course.term ?? null,
        status: course.status ?? 'active',
      })),
      modes: [...STUDY_MODES],
      recent,
      continue: continueTarget,
      warnings: [...catalogState.warnings],
    }
    if (failure !== null) {
      return { ...payload, code: failure.code, message: failure.message, warnings: [...payload.warnings, failure.message] }
    }
    return payload
  }

  /**
   * Validate a stored session before the client navigates to it.
   *
   * Returns successfully only for a session that is (a) known, (b) marked ready, and (c) still
   * present in the native session layer. A session whose native conversation was deleted gets an
   * actionable error instead of a blank panel.
   */
  async function reopen(request = {}) {
    guard()
    const sessionId = request?.sessionId
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0 || sessionId.length > 128) {
      throw fail('PROFESSOR_HOME_REQUEST_INVALID', 'Expected a native session id.')
    }
    const row = await registry.get(sessionId)
    if (row === null) {
      throw fail('PROFESSOR_SESSION_MISSING', 'Professor has no metadata for this session, so it cannot be reopened. Start a new study session.')
    }
    if (row.status === 'archived') throw fail('PROFESSOR_SESSION_ARCHIVED', 'This conversation was cleared from Professor; its native history is archived.')
    if (row.status === 'failed') {
      throw fail('PROFESSOR_SESSION_NOT_READY', `This session's setup did not complete: ${row.error ?? 'unknown reason'}. Retry it from Recent, or start a new study session.`)
    }
    if (row.status !== 'ready') {
      throw fail('PROFESSOR_SESSION_NOT_READY', 'This session is still being prepared. Wait for setup to finish, then retry.')
    }
    if (await host.hasSession(sessionId) !== true) {
      throw fail('PROFESSOR_SESSION_MISSING', `The Harness conversation for this session no longer exists (${sessionId}). Start a new study session.`)
    }
    let agent = await host.findAgent(sessionId)
    if (agent === undefined) {
      const recovered = await host.createSession({ sessionId, cwd: host.defaultCwd() })
      agent = recovered?.agent ?? recovered
    }
    if (agent !== undefined && await host.composedPreset(agent) !== presetId) {
      throw fail('PROFESSOR_SESSION_INCOMPATIBLE', 'This conversation no longer uses Professor. Start a new study session; its existing history has not been changed.')
    }
    if (await host.hydrate(agent) !== true) throw fail('PROFESSOR_MEMORY_NOT_READY', 'Professor memory could not be prepared for this conversation.')
    return {
      ok: true, sessionId, title: row.title, mode: row.mode, courseId: row.courseId,
    }
  }

  /**
   * Clear one registry row: archive the native chat first, hide the Professor row second.
   *
   * Shared by the single-row clear and the bulk clear — one safety kernel, one set of semantics.
   * Returns `{ nativeArchived, nativeMissing, repeat }`; throws coded failures that leave the row
   * untouched. Never treats an unverified existence as absence.
   */
  async function clearRow(row) {
    if (row.status === 'archived') {
      return { nativeArchived: false, nativeMissing: false, repeat: true }
    }
    if (row.status === 'preparing') throw fail('PROFESSOR_SESSION_NOT_READY', 'Wait for conversation setup to finish before clearing it.')
    let nativeArchived = false
    let nativeMissing = false
    // Three states, never collapsed into a boolean: confirmed presence archives the chat,
    // confirmed absence permits stale-row cleanup, and "cannot tell" must fail safely — hiding the
    // row without archiving would silently violate the approved "archive the native chat" behaviour.
    const existence = typeof host.probeSession === 'function'
      ? await host.probeSession(row.sessionId)
      : 'unknown'
    if (existence === 'present') {
      if (typeof host.archiveSession !== 'function') throw fail('PROFESSOR_ARCHIVE_UNAVAILABLE', 'This Harness does not expose native conversation archiving.')
      try {
        // Success may resolve undefined — that is success.
        await host.archiveSession(row.sessionId)
        nativeArchived = true
      } catch (error) {
        if (error?.code === 'PROFESSOR_ARCHIVE_UNAVAILABLE') {
          throw fail('PROFESSOR_ARCHIVE_UNAVAILABLE', error.message)
        }
        if (error?.name === 'WorkspaceUnknownSessionError') {
          // The native conversation vanished between the probe and the archive: the archive API's
          // own definite miss positively establishes absence, so the stale list entry may be
          // tombstoned safely, and nothing recreates the native session.
          nativeMissing = true
        } else if (error?.name === 'WorkspaceActiveSessionError') {
          throw fail('PROFESSOR_SESSION_ACTIVE', 'This conversation is still running. Let it finish or stop it in Harness, then clear it — nothing has been removed.')
        } else {
          throw fail('PROFESSOR_ARCHIVE_FAILED', `Harness refused to archive this conversation: ${error?.message ?? String(error)}. It remains in your Recent list; try again once it is idle.`)
        }
      }
      guard()
    } else if (existence === 'absent') {
      // Positively established absence: a stale list entry whose native conversation is gone. Only
      // this case may skip the archive; the row is removed without recreating anything native.
      nativeMissing = true
    } else {
      throw fail('PROFESSOR_SESSION_EXISTENCE_UNVERIFIED', 'Professor could not verify whether the Harness conversation still exists (the native session query is unavailable), so nothing was cleared. The conversation stays in Recent; try again once Harness responds.')
    }
    await registry.archive(row.sessionId)
    return { nativeArchived, nativeMissing, repeat: false }
  }

  /**
   * Clear one Recent conversation through {@link clearRow}.
   *
   * The approved semantics are "remove from the Professor list and archive the corresponding
   * native Harness chat; history remains recoverable" — this is **not** a permanent deletion, and
   * nothing here may describe it as one.
   */
  async function clearSession(request = {}) {
    guard()
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => !['sessionId', 'confirmed'].includes(key))
      || typeof request.sessionId !== 'string' || !request.sessionId.trim() || request.sessionId.length > 128
      || request.confirmed !== true) throw fail('PROFESSOR_HOME_REQUEST_INVALID', 'Clearing a conversation requires its exact ID and confirmation.')
    const row = await registry.get(request.sessionId)
    if (!row) throw fail('PROFESSOR_SESSION_MISSING', 'This conversation does not belong to Professor.')
    const outcome = await clearRow(row)
    return { ok: true, sessionId: row.sessionId, archived: true, ...outcome }
  }

  // --- bulk clear ------------------------------------------------------------
  // In-memory, short-lived authorisation state. A token binds one backend-owned snapshot of
  // registry rows; an operation is the resumable execution of exactly that snapshot. Both die with
  // the service, so a restart can never expand a confirmed scope to newer conversations.
  const BULK_BATCH = 5
  const BULK_TOKEN_TTL_MS = 120_000
  const BULK_OPERATION_TTL_MS = 300_000
  const bulkTokens = new Map()
  const bulkOperations = new Map()
  let bulkSerial = 0

  function bulkStamp() {
    bulkSerial += 1
    return `${Date.now().toString(36)}-${bulkSerial.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  function pruneBulk(nowMs) {
    for (const [token, entry] of bulkTokens) {
      if (entry.expiresAt <= nowMs || entry.consumed) bulkTokens.delete(token)
    }
    for (const [id, operation] of bulkOperations) {
      if (operation.expiresAt <= nowMs && operation.inFlight === null) bulkOperations.delete(id)
    }
    // Hard bounds: at most a handful of live confirmations/operations ever exist.
    while (bulkTokens.size > 8) bulkTokens.delete(bulkTokens.keys().next().value)
    while (bulkOperations.size > 8) bulkOperations.delete(bulkOperations.keys().next().value)
  }

  /**
   * Backend-owned snapshot of every non-archived registry row — including rows beyond the visible
   * Recent limit. The ids are captured here; the client never supplies targets.
   */
  async function clearAllSnapshot() {
    guard()
    const nowMs = Date.now()
    pruneBulk(nowMs)
    const rows = (await registry.list()).filter(row => row.status !== 'archived')
    const token = `clr-${bulkStamp()}`
    bulkTokens.set(token, {
      ids: rows.map(row => row.sessionId),
      titles: new Map(rows.map(row => [row.sessionId, String(row.title ?? '').slice(0, 80)])),
      createdAt: nowMs,
      expiresAt: nowMs + BULK_TOKEN_TTL_MS,
      consumed: false,
    })
    return {
      ok: true,
      token,
      count: rows.length,
      previews: rows.slice(0, 5).map(row => ({ sessionId: row.sessionId, title: String(row.title ?? '').slice(0, 80) })),
      expiresAt: nowMs + BULK_TOKEN_TTL_MS,
    }
  }

  /** Process the next batch of one confirmed snapshot. Sequential, per-item fault isolation. */
  async function runBulkBatch(operation) {
    const outcomes = []
    while (outcomes.length < BULK_BATCH && operation.index < operation.ids.length) {
      const sessionId = operation.ids[operation.index]
      const title = operation.titles.get(sessionId) ?? ''
      // Exactly one outcome per target, recorded **before** the cursor advances. The registry
      // lookup is inside the per-item fault boundary: a storage fault becomes a failed outcome
      // (the row stays visible and unarchived), never a rejected batch that leaves the cursor
      // past an unaccounted conversation. If anything could still abort before accounting, the
      // cursor has not moved, so the item remains retryable.
      let outcome
      try {
        const row = await registry.get(sessionId)
        if (row === null) {
          outcome = { sessionId, title, status: 'failed', reason: 'Professor has no metadata for this row any more.' }
        } else if (row.status === 'archived') {
          outcome = { sessionId, title, status: 'skipped', reason: 'already cleared' }
        } else if (row.status === 'preparing') {
          // Preparing setup is skipped safely and stays visible for a later explicit attempt.
          outcome = { sessionId, title, status: 'skipped', reason: 'setup is still preparing; clear it later' }
        } else {
          const result = await clearRow(row)
          outcome = { sessionId, title, status: 'cleared', reason: result.nativeMissing ? 'cleared (native conversation was already gone)' : 'cleared (native chat archived)' }
        }
      } catch (error) {
        const code = error?.code ?? ''
        outcome = code === 'PROFESSOR_SESSION_ACTIVE'
          ? { sessionId, title, status: 'skipped', reason: 'still running; finish or stop it, then clear again' }
          : { sessionId, title, status: 'failed', reason: `${error?.message ?? String(error)}${code ? ` (${code})` : ''}`.slice(0, 300) }
      }
      operation.counts[outcome.status] += 1
      outcomes.push(outcome)
      operation.index += 1
    }
    return {
      ok: true,
      operationId: operation.id,
      done: operation.index >= operation.ids.length,
      counts: {
        cleared: operation.counts.cleared,
        skipped: operation.counts.skipped,
        failed: operation.counts.failed,
        remaining: operation.ids.length - operation.index,
      },
      outcomes,
    }
  }

  /** Attach one batch run to an operation; duplicate continuation joins the same run. */
  function startBulkBatch(operation) {
    if (operation.inFlight !== null) return operation.inFlight
    const run = (async () => {
      try {
        return await runBulkBatch(operation)
      } finally {
        operation.inFlight = null
      }
    })()
    // Synchronously recorded, so a double click cannot start a second batch on the same cursor.
    operation.inFlight = run
    return run
  }

  /**
   * Consume a confirmation token exactly once and process the first batch of its snapshot.
   * Replays, expired tokens and foreign tokens are refused; they never widen the snapshot.
   */
  async function clearAllStart(request = {}) {
    guard()
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => key !== 'token')
      || typeof request.token !== 'string' || !request.token.trim() || request.token.length > 128) {
      throw fail('PROFESSOR_HOME_REQUEST_INVALID', 'Bulk clearing requires the snapshot token from clearAllSnapshot.')
    }
    const nowMs = Date.now()
    const entry = bulkTokens.get(request.token)
    if (entry === undefined || entry.consumed) {
      throw fail('PROFESSOR_CLEAR_ALL_TOKEN_INVALID', 'This confirmation is no longer valid. Start again to get a fresh snapshot of the conversations that remain.')
    }
    if (entry.expiresAt <= nowMs) {
      bulkTokens.delete(request.token)
      throw fail('PROFESSOR_CLEAR_ALL_TOKEN_EXPIRED', 'This confirmation expired before it was used. Start again to get a fresh snapshot of the conversations that remain.')
    }
    // Consume exactly once, synchronously, before any await: a duplicate start cannot begin a
    // second operation over the same snapshot.
    entry.consumed = true
    bulkTokens.delete(request.token)
    pruneBulk(nowMs)
    const operation = {
      id: `op-${bulkStamp()}`,
      ids: [...entry.ids],
      titles: entry.titles,
      index: 0,
      counts: { cleared: 0, skipped: 0, failed: 0 },
      createdAt: nowMs,
      expiresAt: nowMs + BULK_OPERATION_TTL_MS,
      inFlight: null,
    }
    bulkOperations.set(operation.id, operation)
    return startBulkBatch(operation)
  }

  /** Continue one confirmed operation at its stored cursor. Duplicate calls join the same batch. */
  async function clearAllContinue(request = {}) {
    guard()
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => key !== 'operationId')
      || typeof request.operationId !== 'string' || !request.operationId.trim() || request.operationId.length > 128) {
      throw fail('PROFESSOR_HOME_REQUEST_INVALID', 'Continuing a bulk clear requires its operation id.')
    }
    const nowMs = Date.now()
    const operation = bulkOperations.get(request.operationId)
    if (operation === undefined) {
      throw fail('PROFESSOR_CLEAR_ALL_OPERATION_INVALID', 'This bulk clear is no longer running. Get a fresh snapshot to clear whatever remains.')
    }
    if (operation.index >= operation.ids.length) {
      // Already complete: report the final counts idempotently, never re-run the snapshot.
      return {
        ok: true, operationId: operation.id, done: true,
        counts: { cleared: operation.counts.cleared, skipped: operation.counts.skipped, failed: operation.counts.failed, remaining: 0 },
        outcomes: [],
      }
    }
    if (operation.expiresAt <= nowMs) {
      bulkOperations.delete(request.operationId)
      throw fail('PROFESSOR_CLEAR_ALL_OPERATION_EXPIRED', 'This bulk clear ran out of time; the conversations it had not reached are untouched. Get a fresh snapshot to clear whatever remains.')
    }
    return startBulkBatch(operation)
  }

  function dispose() {
    disposed = true
    inFlight.clear()
    bulkTokens.clear()
    bulkOperations.clear()
  }

  return {
    namespace: PROFESSOR_HOME_NAMESPACE,
    home: homeData,
    launch,
    reopen,
    clearSession,
    clearAllSnapshot,
    clearAllStart,
    clearAllContinue,
    dispose,
    modes: [...STUDY_MODES],
  }
}
