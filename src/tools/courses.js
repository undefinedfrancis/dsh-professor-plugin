/**
 * Course registry tools: `professor_course_list` (read) and `professor_course_manage` (write).
 *
 * Split by privilege rather than by noun: the read tool can answer "what is registered, does it
 * resolve, which files are unassigned" without any chance of mutation, and the write tool performs
 * exactly one operation per call and reports what it changed.
 *
 * @module dsh-professor-spike/src/tools/courses
 */

import path from 'node:path'
import { createHash } from 'node:crypto'

import { assertUsableProject, loadProject, PROJECT_SCHEMA_VERSION, saveProject } from '../project/project.js'
import {
  listCourses, recordRemovedSources, registerCourse, removeCourse, resolveCourse, setCourseStatus,
  summarizeCourses, updateCourse, validateSources,
} from '../courses/registry.js'
import { cleanupCourseIndex } from '../courses/removal.js'
import { importPersonalAgentRegistry } from '../migrations/personal-agent-registry.js'
import {
  appendMigrationLog, digestOf as digestOfText, migrationPlanPath, writeMigrationPlan,
} from '../migrations/log.js'
import { projectPaths, WORKSPACE_ROOT_CANDIDATES } from '../paths/roots.js'
import { deriveMaterialRules } from '../workspace/materials.js'
import { jsonOutput } from './support.js'

export const COURSE_LIST_TOOL_NAME = 'professor_course_list'
export const COURSE_MANAGE_TOOL_NAME = 'professor_course_manage'

/**
 * The **stable** mapping from Personal-Agent registry fields to Professor project fields (M12).
 *
 * This table is the contract a migration plan publishes: a field listed here is carried into the
 * new project (and the plan records the value it produced), and every registry field *not* listed
 * is reported as unmapped rather than silently dropped. Keys are the literal `## Heading` texts in
 * `Registry/Courses/<CODE>.md`, plus `COURSES.md#status` for the column that only exists in the
 * index table.
 */
export const MIGRATION_FIELD_MAP = {
  'COURSES.md#status': 'courses[].status',
  'Course Code': 'courses[].course_code',
  'Course Name': 'courses[].display_name',
  Semester: 'courses[].term',
  'Course Root': 'courses[].sources[].path',
  'Lecture Materials': 'courses[].sources[].category_rules.lectures',
  'Tutorial Materials': 'courses[].sources[].category_rules.tutorials',
  'Assignment Materials': 'courses[].sources[].category_rules.assignments',
  'Additional Course Materials': 'courses[].sources[].category_rules.supplementary (exams only for an explicit exam directory)',
  'AI Notes Output': 'courses[].outputs.notes_root',
  'Default Note Format': 'courses[].notes.default_format (preference; explicit format choice still required)',
  'LaTeX Template': 'courses[].notes.latex_template',
}

const asArray = (value) => (Array.isArray(value) ? value : [])

/**
 * List the *directory* names directly under `directory`, or `[]` when it cannot be read.
 *
 * A missing or unreadable source leaves every category unruled, which is what the previous
 * per-candidate `isDirectory` probe did as well: a rule is never invented for a directory that is
 * not there. Returning `[]` rather than throwing keeps the caller's existing behaviour for a
 * source path that has since been moved or deleted.
 */
async function listDirectoryNames({ gateway, projectRoot, directory, signal }) {
  try {
    const target = await gateway.resolveTarget(directory, { cwd: projectRoot, signal })
    const entries = await gateway.listDir(target, signal)
    return entries.filter((entry) => entry.type === 'directory').map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

/**
 * Derive `category_rules` for a course source root from the conventional material directories.
 *
 * Registration supplies only the root (`source_path`); the material categories the registry
 * distinguishes (`Lecture Materials`, `Tutorial Materials`, `Assignment Materials`,
 * `Additional Course Materials`) map onto the well-known directory names in
 * `src/workspace/materials.js` — the same table Phase 3 onboarding uses, so the two paths cannot
 * drift apart. Only directories that actually exist are recorded, so a rule never points at a path
 * that is not there — a missing directory leaves that category unruled (and its files unassigned)
 * rather than inventing a match.
 *
 * `includeSupplementary: false` keeps this path's output shape exactly as it was before Phase 3:
 * the manual register/update/import routes do not gain a `supplementary` rule. Onboarding derives
 * the same rules *with* supplementary, which is where `06_Code` and `00_Course-Info` are recorded.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.projectRoot - project root (the read cwd).
 * @param options.sourcePath - absolute course root.
 * @param options.signal - cancellation.
 * @returns `{ categoryRules, missing }`.
 */
async function deriveCategoryRules({
  gateway, projectRoot, sourcePath, signal,
}) {
  const names = await listDirectoryNames({
    gateway, projectRoot, directory: sourcePath, signal,
  })
  const { categoryRules, missing } = deriveMaterialRules({ sourcePath, names, includeSupplementary: false })
  return { categoryRules, missing }
}


/** Best-effort unassigned/assignment report derived from the stored index. */
async function indexAssignmentReport({ gateway, projectRoot, document, signal }) {
  const layout = projectPaths(projectRoot)
  const target = await gateway.resolveTarget(layout.filesIndex, { cwd: projectRoot, signal })
  const info = await gateway.stat(target, signal)
  if (info === undefined) return { indexPresent: false }

  let index
  try {
    index = JSON.parse(await gateway.readText(target, signal))
  } catch (error) {
    return { indexPresent: true, error: `index unreadable: ${error.message}` }
  }

  const records = asArray(index.files)
  const indexRoot = typeof index.root === 'string' ? index.root : projectRoot
  const unassigned = records.filter((record) => record.course_id === null || record.course_id === undefined)
  const byCourse = []
  for (const course of listCourses(document)) {
    let count = 0
    for (const source of asArray(course.sources)) {
      const relative = path.relative(indexRoot, source.path)
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue
      const prefix = relative.length === 0 ? '' : `${relative}/`
      count += records.filter((record) => prefix.length === 0 || String(record.relative_path).startsWith(prefix)).length
    }
    byCourse.push({ course_id: course.course_id, matched_files: count })
  }

  return {
    indexPresent: true,
    schemaVersion: index.schema_version ?? null,
    total: records.length,
    unassigned: {
      count: unassigned.length,
      sample: unassigned.slice(0, 10).map((record) => record.relative_path),
    },
    byCourse,
    note: 'Course assignment and virtual classification are written by the indexer in M7; until then records stay unassigned.',
  }
}

/**
 * Define `professor_course_list`.
 *
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`; course-owned tools
 *   receive a wrapper that throws `PROFESSOR_PROJECT_MISSING` for an unbound workspace.
 * @param options.gateway - filesystem gateway.
 * @returns the tool definition.
 */
export function defineCourseListTool(options) {
  const { resolveProject, gateway } = options

  return {
    name: COURSE_LIST_TOOL_NAME,
    description: 'List the registered courses of the current Professor project, resolve one course by id or code, validate every configured source and output path, and report which indexed files are still unassigned. Read-only: it never changes the registry.',
    parameters: {
      type: 'object',
      properties: {
        course: { type: 'string', description: 'Course id or course code to resolve. Ambiguous codes return candidates instead of guessing.' },
        include_archived: { type: 'boolean', description: 'Include archived courses (default false).' },
      },
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        projectRoot: { type: 'string' },
        projectPresent: { type: 'boolean' },
        schemaVersion: { type: 'number' },
        configDigest: { type: 'string' },
        courses: { type: 'array' },
        resolved: { type: 'object' },
        sources: { type: 'array' },
        assignment: { type: 'object' },
        problems: { type: 'array' },
        warnings: { type: 'array' },
      },
      required: ['projectRoot', 'projectPresent', 'schemaVersion', 'courses', 'resolved', 'sources', 'assignment', 'problems', 'warnings'],
    }),

    async execute(args = {}, exec) {
      const project = await resolveProject(exec)
      const signal = exec?.signal
      const loaded = await loadProject({ gateway, projectRoot: project.root, signal })

      if (!loaded.present) {
        return {
          projectRoot: project.root,
          projectPresent: false,
          schemaVersion: PROJECT_SCHEMA_VERSION,
          courses: [],
          resolved: { status: 'no-project' },
          sources: [],
          assignment: { indexPresent: false },
          problems: [],
          warnings: ['no .professor/project.yaml yet: run professor_project_init first'],
        }
      }
      // Same ordering rule as the write tool: a missing, malformed, unsupported or invalid
      // document is refused with a domain error before anything is derived from it.
      const document = assertUsableProject(loaded)
      const all = summarizeCourses(document)
      const courses = args.include_archived === true ? all : all.filter((course) => course.active)

      let resolved = { status: 'not-requested' }
      if (typeof args.course === 'string' && args.course.trim().length > 0) {
        const outcome = resolveCourse(document, args.course)
        resolved = outcome.status === 'found'
          ? { status: 'found', course: summarizeCourses({ courses: [outcome.course] })[0] }
          : outcome
      }

      const validation = await validateSources(document, {
        isDirectory: (candidate) => gateway.isDirectory(candidate, { cwd: project.root, signal }),
      })
      const assignment = await indexAssignmentReport({
        gateway, projectRoot: project.root, document, signal,
      })

      return {
        projectRoot: project.root,
        projectPresent: true,
        schemaVersion: document.schema_version,
        configDigest: createHash('sha256').update(loaded.raw).digest('hex'),
        courses,
        resolved,
        sources: validation.courses,
        assignment,
        problems: validation.problems,
        warnings: loaded.warnings ?? [],
      }
    },
  }
}

async function readTextAt(gateway, absolutePath, projectRoot, signal) {
  const target = await gateway.resolveTarget(absolutePath, { cwd: projectRoot, signal })
  return gateway.readText(target, signal)
}

/**
 * Define `professor_course_manage`.
 *
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`; course-owned tools
 *   receive a wrapper that throws `PROFESSOR_PROJECT_MISSING` for an unbound workspace.
 * @param options.gateway - filesystem gateway.
 * @param options.policiesFor - `(projectRoot) => { read, write }`.
 * @param options.logger - plugin logger.
 * @returns the tool definition.
 */
export function defineCourseManageTool(options) {
  const {
    resolveProject, gateway, policiesFor, outputRootsFor, logger,
  } = options

  return {
    name: COURSE_MANAGE_TOOL_NAME,
    description: 'Register, update, archive/reactivate, delete a course, or import the existing Personal-Agent registry into the current Professor project. An import reads the source registry read-only, returns an explicit migration plan (stable field mapping, per-course source digests, unmapped-field report), is idempotent (a re-run never duplicates a course) and records the plan and outcome under .professor/migrations/; dry_run reports the plan and writes nothing. One operation per call; refuses to overwrite a newer project schema. delete removes only the registration and Professor\'s derived index records for that course — never source material, notes, reviews, learning state, persistent memory or binding history — needs confirm_delete, and marks the course\'s material so a rebuild cannot make it searchable again until the folder is explicitly registered once more.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['register', 'update', 'archive', 'reactivate', 'delete', 'import'],
          description: 'Operation to perform.',
        },
        expected_config_digest: { type: 'string', description: 'Optional SHA-256 of the project document observed before editing; stale edits refuse.' },
        expected_project_root: { type: 'string', description: 'Optional observed project root; switching project refuses the edit.' },
        course_id: { type: 'string', description: 'Stable course id (for update/archive/reactivate/delete).' },
        confirm_delete: { type: 'boolean', description: 'Must be true for action=delete. Confirms removing this registration and its derived index records; source material, notes and learning state are never touched.' },
        course_code: { type: 'string', description: 'Course code, e.g. CSC3200 (register).' },
        display_name: { type: 'string', description: 'Course display name (register/update).' },
        term: { type: 'string', description: 'Term, e.g. "2025-2026 Fall" (register/update).' },
        source_path: { type: 'string', description: 'Absolute path of the course material root (register/update).' },
        notes_root: { type: 'string', description: 'Absolute path where notes for this course should be written (register).' },
        registry_dir: { type: 'string', description: 'Absolute path of the Personal-Agent Registry directory (import; defaults to <workspace>/01_Learning/Registry).' },
        only: { type: 'array', description: 'Import only these course codes.' },
        dry_run: { type: 'boolean', description: 'Report what import would do without writing (import).' },
      },
      required: ['action'],
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        action: { type: 'string' },
        projectRoot: { type: 'string' },
        changed: { type: 'array' },
        course: { type: 'object' },
        imported: { type: 'array' },
        skipped: { type: 'array' },
        dryRun: { type: 'boolean' },
        migration: { type: 'object', description: 'Import only: the explicit migration plan (stable field mapping, per-course source digests, unmapped-field report) and whether the plan and log entry were recorded.' },
        cleanup: { type: 'object', description: 'Delete only: whether the derived index was present, how many records were removed, how many were kept for a surviving course, and whether it was rewritten.' },
        warnings: { type: 'array' },
        problems: { type: 'array' },
      },
      required: ['action', 'projectRoot', 'changed', 'warnings', 'problems'],
    }),

    async execute(args = {}, exec) {
      const action = String(args.action ?? '').trim()
      const project = await resolveProject(exec)
      const signal = exec?.signal

      // The project document must be loaded and validated *before* the write policy is derived:
      // output roots come from the document, and a missing/malformed/unsupported document must
      // never widen (or even define) the writable boundary. Deriving policies from an
      // uninitialised variable was the regression this ordering removes.
      const loaded = await loadProject({ gateway, projectRoot: project.root, signal })
      let document = assertUsableProject(loaded)
      if ((args.expected_config_digest !== undefined && args.expected_config_digest !== createHash('sha256').update(loaded.raw).digest('hex')) ||
          (args.expected_project_root !== undefined && args.expected_project_root !== project.root)) {
        const error = new Error('Project configuration changed; reload courses before editing')
        error.code = 'PROFESSOR_PROJECT_STALE'
        throw error
      }
      const policies = policiesFor(project.root, outputRootsFor(document))

      const warnings = []
      const problems = []
      let course = {}
      let imported = []
      let dryRun = false
      // Present only for `import`: the explicit migration plan, plus how it was recorded.
      let migration
      // Present only for `delete`: how the derived index was cleaned, reported either as part of a
      // successful result or — when the registration itself could not be saved — as the honest
      // record of a partial operation that is safe to retry.
      let cleanup

      if (action === 'register') {
        const sources = []
        if (typeof args.source_path === 'string' && args.source_path.trim().length > 0) {
          const sourcePath = args.source_path.trim()
          if (!(await gateway.isDirectory(sourcePath, { cwd: project.root, signal }))) {
            problems.push(`source path does not exist or is not a directory: ${sourcePath}`)
          } else {
            const { categoryRules } = await deriveCategoryRules({ gateway, projectRoot: project.root, sourcePath, signal })
            sources.push(Object.keys(categoryRules).length > 0 ? { path: sourcePath, category_rules: categoryRules } : { path: sourcePath })
          }
        }
        const result = registerCourse(document, {
          course_id: args.course_id,
          course_code: args.course_code,
          display_name: args.display_name,
          term: args.term,
          sources,
          status: args.status,
        })
        document = result.document
        course = result.course
        warnings.push(...result.warnings)
        if (typeof args.notes_root === 'string' && args.notes_root.trim().length > 0) {
          course.outputs = { ...course.outputs, notes_root: args.notes_root.trim() }
        }
      } else if (action === 'update') {
        const result = updateCourse(document, String(args.course_id ?? ''), {
          course_code: args.course_code,
          display_name: args.display_name,
          term: args.term,
          status: args.status,
          sources: await (async () => {
            if (typeof args.source_path !== 'string' || args.source_path.trim().length === 0) return undefined
            const sourcePath = args.source_path.trim()
            if (!(await gateway.isDirectory(sourcePath, { cwd: project.root, signal }))) return [{ path: sourcePath }]
            const { categoryRules } = await deriveCategoryRules({ gateway, projectRoot: project.root, sourcePath, signal })
            return [Object.keys(categoryRules).length > 0 ? { path: sourcePath, category_rules: categoryRules } : { path: sourcePath }]
          })(),
        })
        document = result.document
        course = result.course
      } else if (action === 'archive' || action === 'reactivate') {
        const result = setCourseStatus(document, String(args.course_id ?? ''), action === 'archive' ? 'archived' : 'active')
        document = result.document
        course = result.course
      } else if (action === 'delete') {
        if (args.confirm_delete !== true) {
          const error = new Error(
            'deleting a course requires confirm_delete: true; it removes the registration and Professor\'s '
            + 'derived index records for this course only — never material, notes or learning state',
          )
          error.code = 'PROFESSOR_COURSE_INVALID'
          throw error
        }
        const removed = removeCourse(document, String(args.course_id ?? ''))
        course = removed.course
        const removedSources = (Array.isArray(course.sources) ? course.sources : [])
          .map((source) => source.path)
        const marked = recordRemovedSources(removed.document, removedSources)

        // The derived index is cleaned *before* the configuration is written, in one guarded atomic
        // write. A failure here changes nothing at all; a failure further down can then only leave a
        // still-registered course without searchable material — retried safely — and never a removed
        // course whose material is still searchable.
        try {
          cleanup = await cleanupCourseIndex({
            gateway,
            projectRoot: project.root,
            document,
            nextDocument: marked,
            removedCourseId: course.course_id,
            removedSources,
            session: exec?.agent?.session,
            signal,
            writePolicy: policies.write,
          })
        } catch (error) {
          return {
            action,
            projectRoot: project.root,
            changed: [],
            course: {},
            imported,
            skipped: [],
            dryRun: false,
            warnings,
            problems: [`nothing was changed: ${error.message}`],
          }
        }
        document = recordRemovedSources(marked, cleanup.extraRemovedSources)
        if (cleanup.chunksRestamped > 0) warnings.push(`re-stamped ${cleanup.chunksRestamped} extracted chunk store(s) to the surviving course`)
        for (const problem of cleanup.chunkProblems ?? []) warnings.push(`chunk provenance could not be refreshed: ${problem}`)
        if (cleanup.indexPresent === false) warnings.push('there is no file index yet, so there was nothing to clean')
        if (cleanup.indexWritten === true) warnings.push(`removed ${cleanup.indexRecordsRemoved} indexed file record(s) for this course`)
        if (cleanup.sharedKept > 0) warnings.push(`${cleanup.sharedKept} indexed file record(s) were kept because a surviving course still covers them`)
        if (cleanup.extraRemovedSources.length > 0) {
          warnings.push(`also marked ${cleanup.extraRemovedSources.length} path(s) a rebuild would otherwise have re-added: ${cleanup.extraRemovedSources.join(', ')}`)
        }
      } else if (action === 'import') {
        const dryRunFlag = args.dry_run === true
        const stamp = Date.now()
        const requested = asArray(args.only)
          .filter((value) => typeof value === 'string' && value.trim().length > 0)
          .map((value) => value.trim())

        let workspace
        for (const candidate of WORKSPACE_ROOT_CANDIDATES) {
          const value = candidate.path()
          if (await gateway.isDirectory(value, { cwd: project.root, signal })) {
            workspace = value
            break
          }
        }
        const registryDir = typeof args.registry_dir === 'string' && args.registry_dir.trim().length > 0
          ? args.registry_dir.trim()
          : workspace === undefined ? undefined : path.join(workspace, '01_Learning', 'Registry')
        if (registryDir === undefined) {
          const error = new Error('cannot locate the Personal-Agent registry: pass registry_dir explicitly')
          error.code = 'PROFESSOR_IMPORT_SOURCE_MISSING'
          throw error
        }
        if (!(await gateway.isDirectory(registryDir, { cwd: project.root, signal }))) {
          const error = new Error(`registry directory not found: ${registryDir}`)
          error.code = 'PROFESSOR_IMPORT_SOURCE_MISSING'
          throw error
        }

        const { entries, report } = await importPersonalAgentRegistry({
          registryDir,
          only: requested,
          readText: (absolutePath) => readTextAt(gateway, absolutePath, project.root, signal),
          listDir: async (absolutePath) => {
            const target = await gateway.resolveTarget(absolutePath, { cwd: project.root, signal })
            return (await gateway.listDir(target, signal)).map((entry) => entry.name)
          },
        })
        warnings.push(...report.warnings)

        imported = []
        // The plan is built from the same loop that performs the registration, so the plan cannot
        // drift from the outcome: every entry records the registry revision it read (source digest)
        // and the decision that was taken for it.
        const planCourses = []
        for (const entry of entries) {
          const courseId = entry.input.course_id
          const unmappedFields = Object.keys(entry.unmapped ?? {})
          const base = {
            course_id: courseId,
            course_code: entry.input.course_code,
            registry: entry.registryPath,
            source_digest: entry.digest,
          }
          if (listCourses(document).some((existing) => existing.course_id === courseId)) {
            // Idempotence: a re-run never registers a duplicate and never rewrites the existing
            // course. It reports `already-registered` and leaves the document byte-identical.
            imported.push({ course_id: courseId, status: 'already-registered' })
            planCourses.push({ ...base, outcome: 'already-registered', unmapped_fields: unmappedFields })
            continue
          }
          for (const source of entry.input.sources ?? []) {
            const { categoryRules } = await deriveCategoryRules({ gateway, projectRoot: project.root, sourcePath: source.path, signal })
            source.category_rules = { ...categoryRules, ...source.category_rules }
          }
          const result = registerCourse(document, entry.input)
          document = result.document
          warnings.push(...result.warnings)
          imported.push({
            course_id: courseId,
            status: 'imported',
            registry: entry.registryPath,
            unmapped_fields: unmappedFields,
          })
          planCourses.push({
            ...base,
            outcome: 'create',
            display_name: entry.input.display_name,
            term: entry.input.term,
            status_value: entry.input.status,
            source_paths: asArray(entry.input.sources).map((source) => source.path),
            notes_root: entry.notesRoot,
            note_format: entry.noteFormat,
            latex_template: entry.latexTemplate,
            unmapped_fields: unmappedFields,
          })
        }
        for (const skipped of report.skipped) {
          imported.push({ course_id: skipped.code, status: 'skipped', reason: skipped.reason })
          planCourses.push({
            course_code: skipped.code,
            outcome: 'skipped',
            reason: skipped.reason,
            unmapped_fields: [],
          })
        }

        // The unmapped report is aggregated by field name (not by course) so a reader can see at a
        // glance which registry fields the Professor schema simply does not carry.
        const byField = new Map()
        for (const entry of planCourses) {
          for (const field of entry.unmapped_fields ?? []) {
            byField.set(field, [...(byField.get(field) ?? []), entry.course_code ?? entry.course_id])
          }
        }
        const unmappedReport = [...byField.entries()]
          .map(([field, codes]) => ({ field, courses: [...new Set(codes)].sort() }))
          .sort((a, b) => a.field.localeCompare(b.field))

        const plan = {
          schema: 'professor.migration.plan/1',
          stamp,
          action: 'import',
          project_root: project.root,
          project_schema_version: document.schema_version,
          registry_dir: registryDir,
          // A digest over (course code + source document digest) pairs: stable across a re-run of
          // an unchanged registry, and different as soon as any registry document changes.
          registry_digest: await digestOfText(
            planCourses.map((entry) => `${entry.course_code ?? ''}:${entry.source_digest ?? ''}`).join('\n'),
          ),
          only: requested,
          dry_run: dryRunFlag,
          source_access: 'read-only (the registry and course material are never written)',
          field_map: MIGRATION_FIELD_MAP,
          courses: planCourses,
          unmapped_fields: unmappedReport,
          outcomes: {
            create: planCourses.filter((entry) => entry.outcome === 'create').length,
            already_registered: planCourses.filter((entry) => entry.outcome === 'already-registered').length,
            skipped: planCourses.filter((entry) => entry.outcome === 'skipped').length,
          },
          warnings: [...report.warnings],
        }

        migration = {
          plan,
          planPath: migrationPlanPath(project.root, stamp),
          planWritten: false,
          logRecorded: false,
          dryRun: dryRunFlag,
        }
        dryRun = dryRunFlag
      } else {
        const error = new Error(`unsupported action "${action}"; expected register, update, archive, reactivate, delete or import`)
        error.code = 'PROFESSOR_COURSE_INVALID'
        throw error
      }

      const changed = action === 'import'
        ? asArray(imported).filter((entry) => entry.status === 'imported').map((entry) => entry.course_id)
        : [course?.course_id].filter(Boolean)

      if (dryRun) {
        // A dry run returns the plan it *would* apply and writes nothing at all — no
        // project.yaml, no plan file, no log line.
        return {
          action,
          projectRoot: project.root,
          changed,
          course,
          imported,
          skipped: [],
          dryRun: true,
          warnings,
          problems,
          ...(migration === undefined ? {} : { migration }),
        }
      }

      let written
      try {
        written = await saveProject({
          gateway,
          projectRoot: project.root,
          document,
          session: exec?.agent?.session,
          signal,
          writePolicy: policies.write,
          expectedRaw: loaded.raw,
        })
      } catch (error) {
        if (action === 'delete') {
          // The derived index is already clean; only the registration is still on disk. Reporting
          // that plainly is what lets the same guarded deletion be retried to completion instead of
          // leaving an operator to guess whether the course went away.
          return {
            action,
            projectRoot: project.root,
            changed: [],
            course: {},
            imported,
            skipped: [],
            dryRun: false,
            warnings,
            cleanup,
            problems: [
              `the course registration was not removed (${error.code ?? 'error'}: ${error.message}); `
              + 'its derived index records were already cleaned, so running this deletion again is safe',
            ],
          }
        }
        // A refused write is recorded rather than swallowed: an operator auditing the migration
        // sees the failure, not just an absent log entry.
        if (migration !== undefined) {
          await appendMigrationLog({
            gateway,
            projectRoot: project.root,
            entry: {
              schema: 'professor.migration.log/1',
              at: new Date().toISOString(),
              stamp: migration.plan.stamp,
              action: 'import',
              outcome: 'failed',
              reason: error.message,
              registry_dir: migration.plan.registry_dir,
              dry_run: false,
            },
            session: exec?.agent?.session,
            signal,
            writePolicy: policies.write,
          })
        }
        throw error
      }
      logger?.info(`course registry updated (${action}); project.yaml at ${written.path}`)

      if (migration !== undefined) {
        try {
          const planWrite = await writeMigrationPlan({
            gateway,
            projectRoot: project.root,
            plan: migration.plan,
            session: exec?.agent?.session,
            signal,
            writePolicy: policies.write,
          })
          migration.planPath = planWrite.path
          migration.planWritten = true
        } catch (error) {
          warnings.push(`migration plan could not be recorded: ${error.message}`)
        }

        // `applied` vs `no-op` is what makes a re-run legible: importing an unchanged registry
        // writes a `no-op` line instead of an identical-looking `applied` line.
        const logged = await appendMigrationLog({
          gateway,
          projectRoot: project.root,
          entry: {
            schema: 'professor.migration.log/1',
            at: new Date().toISOString(),
            stamp: migration.plan.stamp,
            action: 'import',
            outcome: changed.length > 0 ? 'applied' : 'no-op',
            plan: migration.planWritten ? migration.planPath : null,
            registry_dir: migration.plan.registry_dir,
            registry_digest: migration.plan.registry_digest,
            courses_created: changed,
            courses_already_registered: asArray(imported)
              .filter((entry) => entry.status === 'already-registered').map((entry) => entry.course_id),
            courses_skipped: asArray(imported).filter((entry) => entry.status === 'skipped').map((entry) => entry.course_id),
            dry_run: false,
          },
          session: exec?.agent?.session,
          signal,
          writePolicy: policies.write,
        })
        migration.logRecorded = logged.recorded === true
        if (!migration.logRecorded) warnings.push(`migration log not updated: ${logged.reason}`)
      }

      return {
        action,
        projectRoot: project.root,
        changed,
        course,
        imported,
        skipped: [],
        dryRun: false,
        warnings: [...warnings, ...(written.warnings ?? [])],
        problems,
        ...(cleanup === undefined ? {} : { cleanup }),
        ...(migration === undefined ? {} : { migration }),
      }
    },
  }
}
