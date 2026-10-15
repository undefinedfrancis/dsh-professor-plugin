/**
 * Course context resolution shared by the state and artifact tools (M10/M11).
 *
 * Both the learning-state tools and the artifact tools need to answer the same question the same
 * way: *which course is this call about?* The answer is either the explicit argument or **this
 * session's own binding** — never another session's, never a cached projection, never a guess.
 *
 * Extracted into its own module so the two tool families cannot drift apart: the rules (project
 * must be usable, an explicit course must be registered, an unbound session fails loudly) live in
 * exactly one place.
 *
 * @module dsh-professor-spike/src/state/course-context
 */

import { projectPaths, sessionId as sessionIdOf } from '../paths/roots.js'
import { assertUsableProject, loadProject } from '../project/project.js'
import { requireCourse, courseById } from '../courses/registry.js'
import { readBinding } from './course-binding.js'

/**
 * Resolve the project document and the course an operation applies to.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.projectRoot - absolute project root.
 * @param options.signal - cancellation.
 * @param options.exec - tool-execution context (for the session id).
 * @param options.courseId - explicit course id/code, when the caller supplied one.
 * @returns `{ document, course, projectRoot }`.
 * @throws `PROFESSOR_PROJECT_MISSING` | `PROFESSOR_PROJECT_UNSUPPORTED` | `PROFESSOR_PROJECT_INVALID`
 *   | `PROFESSOR_STATE_COURSE_REQUIRED` | `PROFESSOR_COURSE_MISSING`.
 */
export async function resolveCourseContext(options) {
  const { gateway, projectRoot, signal, exec, courseId } = options
  const loaded = await loadProject({ gateway, projectRoot, signal })
  const document = assertUsableProject(loaded)

  let resolved = typeof courseId === 'string' && courseId.trim().length > 0 ? courseId.trim() : null
  if (resolved === null) {
    const sessionId = sessionIdOf(exec)
    if (sessionId === undefined) {
      const error = new Error('no course argument and no session id to bind to; pass course explicitly')
      error.code = 'PROFESSOR_STATE_COURSE_REQUIRED'
      throw error
    }
    const binding = await readBinding({ gateway, projectRoot, sessionId, signal })
    if (!binding.present || binding.record.course_id === null) {
      const error = new Error('this session has no course binding; run professor_session_bind first, or pass course')
      error.code = 'PROFESSOR_STATE_COURSE_REQUIRED'
      throw error
    }
    resolved = binding.record.course_id
    const course = courseById(document, resolved)
    if (course === undefined) {
      const error = new Error(
        `bound course id "${resolved}" is no longer configured (it may have been deleted); `
        + 're-add the course from its material folder, or start a new session',
      )
      error.code = 'PROFESSOR_COURSE_MISSING'
      throw error
    }
    return { document, course, projectRoot }
  }

  // The course argument is an *id or a code* (that is what every tool schema promises), so it goes
  // through the shared resolver rather than an id-only lookup; a binding always holds a real id.
  // Ambiguity is surfaced, never guessed: two terms of the same code must ask.
  const course = courseById(document, resolved) ?? requireCourse(document, resolved)
  return { document, course, projectRoot }
}

/** Read one course state file with its fs version, or `undefined` when absent. */
export async function readStateFile(options) {
  const { gateway, projectRoot, courseId, file, signal } = options
  const target = await gateway.resolveTarget(projectPaths(projectRoot).courseStateFile(courseId, file), {
    cwd: projectRoot, signal,
  })
  const info = await gateway.stat(target, signal)
  if (info === undefined) return undefined
  return { text: await gateway.readText(target, signal), version: info.version, target }
}

/** The four state files a course may carry. */
export const STATE_FILES = ['PROGRESS.md', 'KNOWLEDGE.md', 'MISTAKES.md', 'INDEX.md']
