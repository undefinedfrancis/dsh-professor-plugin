/**
 * `professor_memory_status` / `professor_memory_read` / `professor_memory_update` — the explicit
 * memory interfaces (Phase 2).
 *
 * Design rules:
 *
 * - **Lossless JSON in, lossless JSON out.** Every result round-trips through the host's tool
 *   output validation; validation problems are reported in `problems` rather than thrown, so the
 *   model (and the verifiers) always receive a machine-readable answer.
 * - **Disabled means disabled.** While memory is disabled, reads withhold content and report the
 *   state honestly; writes are refused without touching anything. The switch itself
 *   (`set_enabled`) stays writable so a disabled user can switch back on.
 * - **Evidence stays separated.** Durable preferences require `explicit-stable` evidence;
 *   learning-state writes keep their own gate in `professor_state_update` (untouched here).
 * - **Memory text is never authority.** These tools manage reference data; they grant nothing and
 *   no memory content can enable a tool action the persona forbids.
 *
 * @module dsh-professor-spike/src/tools/memory
 */

import {
  EVIDENCE_EXPLICIT_STABLE,
  courseMemoryKey,
  courseMemoryNamespace,
} from '../memory/store.js'
import { CONTEXT_BUDGETS } from '../memory/context.js'
import { resolveCourseContext } from '../state/course-context.js'
import { jsonOutput, NO_PARAMETERS, oneOfTypes } from './support.js'

export const MEMORY_STATUS_TOOL_NAME = 'professor_memory_status'
export const MEMORY_READ_TOOL_NAME = 'professor_memory_read'
export const MEMORY_UPDATE_TOOL_NAME = 'professor_memory_update'

const SCOPES = ['global', 'course', 'control']
const ACTIONS = [
  'set_preference', 'clear_preference',
  'set_instructions', 'add_instruction', 'clear_instructions', 'set_recent_topic',
  'set_enabled',
]

/** Convert a coded store error into a structured tool answer (never a bare crash). */
function problemFrom(error, warnings) {
  return {
    problems: [error?.message ?? String(error)],
    code: typeof error?.code === 'string' ? error.code : 'PROFESSOR_MEMORY_INVALID',
    warnings,
  }
}

/** Resolve the course namespace for a course-scope call, or a structured failure. */
async function resolveCourseScope({ resolveProject, gateway, exec, args, signal }) {
  const project = await resolveProject(exec)
  if (project.bound !== true) {
    return {
      failure: {
        problems: [`course memory requires a connected academic folder; ${project.reason ?? 'this workspace is unbound'}`],
        warnings: [],
      },
    }
  }
  const { course, document } = await resolveCourseContext({
    gateway, projectRoot: project.root, signal, exec, courseId: args.course,
  })
  return {
    project,
    course,
    projectId: typeof document?.project?.id === 'string' ? document.project.id : 'unknown-project',
    namespace: courseMemoryNamespace(document?.project?.id, project.root),
  }
}

/**
 * Define `professor_memory_status`.
 *
 * Honest state without content: storage health, enabled/disabled, counts, budgets.
 */
export function defineMemoryStatusTool({ store }) {
  return {
    name: MEMORY_STATUS_TOOL_NAME,
    description: 'Report Professor persistent-memory status without revealing its contents: whether memory is enabled, whether the storage domain is open, how many preferences and course records exist, and the size budgets. Use professor_memory_read to see the records themselves.',
    parameters: NO_PARAMETERS,
    output: jsonOutput({
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        storage: { type: 'object' },
        counts: { type: 'object' },
        budgets: { type: 'object' },
        warnings: { type: 'array' },
        problems: { type: 'array' },
      },
      required: ['enabled', 'storage', 'counts', 'budgets', 'warnings', 'problems'],
    }),

    async execute(_args = {}, _exec) {
      const warnings = []
      try {
        const described = await store.describe()
        return {
          enabled: described.enabled,
          storage: { status: described.storage.status, reason: described.storage.reason, domain: described.storage.domain, version: described.storage.version },
          counts: described.counts,
          budgets: described.budgets,
          context_budgets: CONTEXT_BUDGETS,
          warnings,
          problems: described.problems ?? [],
        }
      } catch (error) {
        return { enabled: true, storage: { status: 'unavailable', reason: error.message, domain: null, version: null }, counts: { global_preferences: 0, course_records: 0 }, budgets: {}, context_budgets: CONTEXT_BUDGETS, warnings, ...problemFrom(error, warnings) }
      }
    },
  }
}

/**
 * Define `professor_memory_read`.
 *
 * Explicit, lossless reads of one scope. Disabled memory reports its state and withholds content.
 */
export function defineMemoryReadTool({ store, resolveProject, gateway }) {
  return {
    name: MEMORY_READ_TOOL_NAME,
    description: 'Read Professor persistent memory. scope "global" returns the durable academic preferences; scope "course" returns this session\'s bound course memory (namespaced by project and course identity — other courses and other projects are never readable through it); scope "control" returns the enabled/disabled state. While memory is disabled the state is reported honestly and the content is withheld. Revision conflicts and corrupt records are reported, never "repaired" by deletion.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: SCOPES, description: 'Which memory record to read.' },
        course: { type: 'string', description: 'Course id or code (scope "course" only; defaults to this session\'s binding).' },
      },
      required: ['scope'],
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        scope: { type: 'string' },
        enabled: { type: 'boolean' },
        present: { type: 'boolean' },
        record: oneOfTypes('object', 'null'),
        revision: oneOfTypes('number', 'null'),
        note: oneOfTypes('string', 'null'),
        warnings: { type: 'array' },
        problems: { type: 'array' },
      },
      required: ['scope', 'enabled', 'present', 'record', 'revision', 'note', 'warnings', 'problems'],
    }),

    async execute(args = {}, exec) {
      const warnings = []
      const scope = args.scope
      try {
        const control = await store.readControl()
        if (control.enabled !== true) {
          return {
            scope,
            enabled: false,
            present: control.present,
            record: null,
            revision: control.revision,
            note: 'persistent memory is disabled: content is withheld and nothing is retrieved automatically. Existing data is preserved; re-enable with scope "control", action "set_enabled".',
            warnings,
            problems: [],
          }
        }

        if (scope === 'control') {
          return {
            scope, enabled: true, present: control.present,
            record: control.present ? control.record : null,
            revision: control.revision,
            note: control.present ? null : 'no control record yet: memory is enabled by default',
            warnings, problems: [],
          }
        }
        if (scope === 'global') {
          const read = await store.readGlobal()
          return {
            scope, enabled: true, present: read.present,
            record: read.record, revision: read.revision,
            note: read.present ? null : 'no durable preferences recorded yet',
            warnings, problems: [],
          }
        }
        // scope === 'course'
        const scoped = await resolveCourseScope({ resolveProject, gateway, exec, args, signal: exec?.signal })
        if (scoped.failure !== undefined) return { scope, enabled: true, present: false, record: null, revision: null, note: null, ...scoped.failure }
        const read = await store.readCourse(scoped.namespace, scoped.course.course_id)
        return {
          scope, enabled: true, present: read.present,
          record: read.record, revision: read.revision,
          note: read.present
            ? `namespaced to project "${scoped.namespace}", course ${scoped.course.course_id}`
            : 'no memory recorded for this course yet',
          warnings, problems: [],
        }
      } catch (error) {
        return { scope, enabled: true, present: false, record: null, revision: null, note: null, ...problemFrom(error, warnings) }
      }
    },
  }
}

/**
 * Define `professor_memory_update`.
 *
 * Explicit, revision-guarded writes. Validation problems come back structured; nothing partial is
 * persisted. After a successful write the calling session's own memory section is refreshed.
 */
export function defineMemoryUpdateTool({ store, resolveProject, gateway, onMemoryChanged, logger }) {
  return {
    name: MEMORY_UPDATE_TOOL_NAME,
    description: 'Update Professor persistent memory, revision-guarded. Durable global preferences require evidence "explicit-stable" — casual or temporary statements are refused, never promoted. Course actions manage stable instructions, the recent topic, and (automatically at session start) the last Professor session. Action "set_enabled" toggles memory; while disabled every other write is refused and no data is deleted. Pass expected_revision from a prior read to avoid losing a concurrent update.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: SCOPES, description: 'Which memory record to change.' },
        action: { type: 'string', enum: ACTIONS, description: 'What to change.' },
        key: { type: 'string', description: 'Preference key (set_preference / clear_preference): lowercase snake_case.' },
        value: { type: 'string', description: 'Value (set_preference) or recent topic (set_recent_topic; empty clears).' },
        evidence: { type: 'string', enum: ['explicit-stable', 'temporary', 'weak', 'strong'], description: 'Durable preferences require "explicit-stable"; anything else is refused.' },
        instruction: { type: 'string', description: 'One stable course instruction (add_instruction).' },
        instructions: { type: 'array', items: { type: 'string' }, description: 'Replacement instruction list (set_instructions).' },
        enabled: { type: 'boolean', description: 'Target state (set_enabled).' },
        reason: { type: 'string', description: 'Why the change is warranted (recorded on the control record for set_enabled).' },
        expected_revision: { type: 'number', description: 'The revision from a prior read; refuses a stale write when the record moved on.' },
        course: { type: 'string', description: 'Course id or code (scope "course" only; defaults to this session\'s binding).' },
      },
      required: ['scope', 'action'],
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        scope: { type: 'string' },
        action: { type: 'string' },
        written: { type: 'boolean' },
        revision: oneOfTypes('number', 'null'),
        record: oneOfTypes('object', 'null'),
        stale: { type: 'boolean' },
        warnings: { type: 'array' },
        problems: { type: 'array' },
      },
      required: ['scope', 'action', 'written', 'revision', 'record', 'stale', 'warnings', 'problems'],
    }),

    async execute(args = {}, exec) {
      const warnings = []
      const scope = args.scope
      const action = args.action
      const expectedRevision = typeof args.expected_revision === 'number' ? args.expected_revision : undefined
      const base = { scope, action, written: false, revision: null, record: null, stale: false, warnings, problems: [] }

      const refresh = async () => {
        if (typeof onMemoryChanged === 'function' && exec?.agent !== undefined) {
          await Promise.resolve(onMemoryChanged(exec.agent)).catch((error) => {
            logger?.warn?.(`memory section refresh failed: ${error?.message ?? String(error)}`)
          })
        }
      }

      try {
        if (scope === 'control') {
          if (action !== 'set_enabled') {
            return { ...base, problems: [`scope "control" only supports action "set_enabled", found "${action}"`] }
          }
          const outcome = await store.setEnabled({ enabled: args.enabled, reason: args.reason, expectedRevision })
          await refresh()
          return { ...base, written: true, revision: outcome.revision, record: outcome.record }
        }

        if (scope === 'global') {
          if (action === 'set_preference') {
            const outcome = await store.setPreference({
              key: args.key, value: args.value, evidence: args.evidence, expectedRevision,
            })
            await refresh()
            return { ...base, written: true, revision: outcome.revision, record: outcome.record }
          }
          if (action === 'clear_preference') {
            const outcome = await store.clearPreference({ key: args.key, expectedRevision })
            await refresh()
            return { ...base, written: outcome.written, revision: outcome.revision, record: outcome.record }
          }
          return { ...base, problems: [`scope "global" supports actions "set_preference" and "clear_preference", found "${action}"`] }
        }

        if (scope === 'course') {
          const scoped = await resolveCourseScope({ resolveProject, gateway, exec, args, signal: exec?.signal })
          if (scoped.failure !== undefined) return { ...base, ...scoped.failure }
          const { namespace, course } = scoped
          const patch = {
            identity: {
              courseCode: course.course_code,
              term: course.term,
              project: { id: scoped.projectId, root: scoped.project.root, namespace },
            },
          }
          if (action === 'add_instruction') patch.addInstruction = args.instruction
          else if (action === 'set_instructions') patch.instructions = args.instructions
          else if (action === 'clear_instructions') patch.instructions = []
          else if (action === 'set_recent_topic') {
            patch.recentTopic = typeof args.value === 'string' && args.value.trim().length > 0 ? args.value : null
          } else {
            return { ...base, problems: [`scope "course" supports instruction and recent-topic actions, found "${action}"`] }
          }
          const outcome = await store.updateCourse(namespace, course.course_id, patch, { expectedRevision })
          await refresh()
          return {
            ...base, written: true, revision: outcome.revision, record: outcome.record,
            ...(outcome.created ? { created: true } : {}),
          }
        }

        return { ...base, problems: [`unknown scope "${scope}"; expected one of ${SCOPES.join(', ')}`] }
      } catch (error) {
        const stale = error?.code === 'PROFESSOR_MEMORY_STALE'
        return { ...base, stale, ...problemFrom(error, warnings) }
      }
    },
  }
}

/** Exported for verifiers and tests: the stable-preference evidence constant. */
export { EVIDENCE_EXPLICIT_STABLE, courseMemoryKey, courseMemoryNamespace }
