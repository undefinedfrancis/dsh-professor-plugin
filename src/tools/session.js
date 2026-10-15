/**
 * Session–course binding tools: `professor_session_bind` (write) and
 * `professor_session_status` (read).
 *
 * The write tool switches this session's binding and appends the change to the record's history;
 * the read tool reports the binding, the resolved course and, when nothing is bound, says so
 * explicitly rather than falling back to any other session's binding.
 *
 * @module dsh-professor-spike/src/tools/session
 */

import { assertUsableProject, loadProject } from '../project/project.js'
import { requireCourse as requireRegisteredCourse, courseById, summarizeCourses } from '../courses/registry.js'
import { sessionId as sessionIdOf } from '../paths/roots.js'
import { readBinding, applyBind, writeBinding } from '../state/course-binding.js'
import { jsonOutput, NO_PARAMETERS, oneOfTypes } from './support.js'

export const SESSION_BIND_TOOL_NAME = 'professor_session_bind'
export const SESSION_STATUS_TOOL_NAME = 'professor_session_status'

/**
 * Load the project or fail with a precise, actionable error.
 *
 * Uses the shared assertion so every tool refuses an absent, malformed, unsupported or invalid
 * document in exactly the same way — and with the same codes.
 */
async function requireProject(options) {
  const { gateway, projectRoot, signal } = options
  const loaded = await loadProject({ gateway, projectRoot, signal })
  return { ...loaded, document: assertUsableProject(loaded) }
}

/**
 * Resolve a course for binding, or fail with `PROFESSOR_COURSE_AMBIGUOUS` / `MISSING`.
 *
 * Delegates to the shared `requireCourse` so the session tools and the state/artifact tools accept
 * exactly the same spellings.
 */
const requireCourse = requireRegisteredCourse

/**
 * Define `professor_session_bind`.
 *
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`; course-owned tools
 *   receive a wrapper that throws `PROFESSOR_PROJECT_MISSING` for an unbound workspace.
 * @param options.gateway - filesystem gateway.
 * @param options.policiesFor - `(projectRoot) => { read, write }`.
 * @param options.logger - plugin logger.
 * @returns the tool definition.
 */
export function defineSessionBindTool(options) {
  const {
    resolveProject, gateway, policiesFor, logger, onBindingChanged,
  } = options

  return {
    name: SESSION_BIND_TOOL_NAME,
    description: 'Bind (or unbind) THIS conversation to a registered course. Each session keeps its own binding file keyed by its session id: no other session is ever read, and unbinding clears this session only. The change is appended to a per-session history so a replay of one session is deterministic.',
    parameters: {
      type: 'object',
      properties: {
        course: { type: 'string', description: 'Course id or course code to bind to. Ambiguous codes are rejected with candidates.' },
        unbind: { type: 'boolean', description: 'Clear this session\'s binding without binding a course.' },
        reason: { type: 'string', description: 'Why the binding changed (e.g. "user-choice"). Recorded in history.' },
      },
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        course_id: oneOfTypes('string', 'null'),
        bound_at: oneOfTypes('string', 'null'),
        changed: { type: 'boolean' },
        entry: { type: 'object' },
        course: oneOfTypes('object', 'null'),
        history_length: { type: 'number' },
        warnings: { type: 'array' },
      },
      required: ['sessionId', 'course_id', 'changed', 'entry', 'history_length', 'warnings'],
    }),

    async execute(args = {}, exec) {
      const project = await resolveProject(exec)
      const policies = policiesFor(project.root)
      const signal = exec?.signal
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) {
        const error = new Error('this tool must be called from an agent session (no session id available)')
        error.code = 'PROFESSOR_BINDING_SESSION_REQUIRED'
        throw error
      }

      const { document } = await requireProject({ gateway, projectRoot: project.root, signal })

      const unbind = args.unbind === true
      if (unbind && args.course !== undefined) {
        const error = new Error('pass either "course" or "unbind", not both')
        error.code = 'PROFESSOR_COURSE_INVALID'
        throw error
      }
      if (!unbind && (typeof args.course !== 'string' || args.course.trim().length === 0)) {
        const error = new Error('pass "course" (id or code) to bind, or "unbind": true to clear')
        error.code = 'PROFESSOR_COURSE_INVALID'
        throw error
      }

      const current = await readBinding({
        gateway, projectRoot: project.root, sessionId, signal,
      })

      let course = null
      if (!unbind) {
        const resolved = courseById(document, args.course) ?? requireCourse(document, args.course)
        course = summarizeCourses({ courses: [resolved] })[0]
      }

      const applied = applyBind({
        record: current.record,
        sessionId,
        courseId: unbind ? null : course.course_id,
        reason: typeof args.reason === 'string' && args.reason.trim().length > 0
          ? args.reason.trim()
          : unbind ? 'explicit-unbind' : 'user-choice',
        at: new Date().toISOString(),
      })

      const written = await writeBinding({
        gateway,
        projectRoot: project.root,
        sessionId,
        record: applied.record,
        session: exec?.agent?.session,
        signal,
        writePolicy: policies.write,
        version: current.observedVersion,
      })

      logger?.info(`session ${sessionId} bound to ${applied.record.course_id ?? 'nothing'} (${applied.entry.reason})`)
      if (typeof onBindingChanged === 'function') await onBindingChanged(exec.agent, signal)

      return {
        sessionId,
        course_id: applied.record.course_id,
        bound_at: applied.record.bound_at,
        changed: applied.changed,
        entry: applied.entry,
        course,
        history_length: applied.record.history.length,
        warnings: [],
      }
    },
  }
}

/**
 * Define `professor_session_status`.
 *
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`; course-owned tools
 *   receive a wrapper that throws `PROFESSOR_PROJECT_MISSING` for an unbound workspace.
 * @param options.gateway - filesystem gateway.
 * @returns the tool definition.
 */
export function defineSessionStatusTool(options) {
  const { resolveProject, gateway } = options

  return {
    name: SESSION_STATUS_TOOL_NAME,
    description: 'Report THIS conversation\'s course binding, the resolved course details, and its binding history. Read-only: it never changes any state and never reads another session\'s binding.',
    parameters: NO_PARAMETERS,
    output: jsonOutput({
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        bound: { type: 'boolean' },
        course_id: oneOfTypes('string', 'null'),
        course: oneOfTypes('object', 'null'),
        history: { type: 'array' },
        projectRoot: { type: 'string' },
        warnings: { type: 'array' },
      },
      required: ['sessionId', 'bound', 'course_id', 'course', 'history', 'projectRoot', 'warnings'],
    }),

    async execute(_args = {}, exec) {
      const project = await resolveProject(exec)
      const signal = exec?.signal
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) {
        const error = new Error('this tool must be called from an agent session (no session id available)')
        error.code = 'PROFESSOR_BINDING_SESSION_REQUIRED'
        throw error
      }

      const loaded = await requireProject({ gateway, projectRoot: project.root, signal })
      const current = await readBinding({
        gateway, projectRoot: project.root, sessionId, signal,
      })

      if (!current.present) {
        return {
          sessionId,
          bound: false,
          course_id: null,
          course: null,
          history: [],
          projectRoot: project.root,
          warnings: ['this session has never bound a course; use professor_session_bind'],
        }
      }

      const record = current.record
      let course = null
      const warnings = []
      if (record.course_id !== null) {
        const selected = courseById(loaded.document, record.course_id)
        if (selected !== undefined) {
          course = summarizeCourses({ courses: [selected] })[0]
        } else {
          warnings.push(`binding points at course_id "${record.course_id}", which is no longer configured (deleted); the binding itself has not been changed`)
        }
      }

      return {
        sessionId,
        bound: record.course_id !== null,
        course_id: record.course_id,
        course,
        history: record.history ?? [],
        projectRoot: project.root,
        warnings,
      }
    },
  }
}
