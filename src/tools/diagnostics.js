/**
 * `professor_diagnostics` — one coherent health endpoint (M12).
 *
 * It reports only facts it can actually observe, and it separates three things that are easy to
 * confuse: *capabilities* (what this machine can do), *state* (what exists on disk right now), and
 * *limitations* (what the plugin deliberately does not do). A missing dependency is reported as a
 * missing dependency, never as a silent success.
 *
 * It never emits environment dumps, file contents, prompts, credentials or full user state: the
 * report is bounded, redaction-free because nothing sensitive is collected in the first place.
 *
 * @module dsh-professor-spike/src/tools/diagnostics
 */

import { projectPaths } from '../paths/roots.js'
import { loadProject, PROJECT_SCHEMA_VERSION } from '../project/project.js'
import { summarizeCapabilities } from '../extract/capabilities.js'
import { countChunks } from './extract.js'
import { jsonOutput, NO_PARAMETERS } from './support.js'

export const DIAGNOSTICS_TOOL_NAME = 'professor_diagnostics'

/**
 * Features that are designed but not implemented — the honest short list.
 *
 * Every entry is a real limitation on the current implementation. A capability that is now wired
 * end to end is removed rather than left behind as an empty placeholder: PDF text extraction,
 * page provenance, Office text extraction and slide coordinates all left this list when the
 * production runners were connected and proven by an end-to-end scenario.
 *
 * What stays is what is genuinely still missing, and each entry says *why* it is missing.
 */
export const NOT_IMPLEMENTED = [
  {
    feature: 'standalone image OCR and real Windows/Linux host enhancement acceptance',
    milestone: 'not complete; PDF OCR uses material_read enhance with automatic hash-locked workspace runtime preparation or an explicit prepared runtime',
  },
  {
    feature: 'automated visual interpretation: professor_material_read can rasterise bounded pages and record which ones reached the caller, but this plugin runs no vision model and never claims a page was understood on its own',
    milestone: 'interpretation is the caller’s job; the reading ledger reports what was delivered, not what was understood',
  },
  {
    feature: 'DOCX page numbers: reading OOXML is structural, and pagination exists only after a layout engine runs (which would still differ from Word)',
    milestone: 'not planned (a DOCX unit is cited by document order and heading, not by page)',
  },
]

const asArray = (value) => (Array.isArray(value) ? value : [])

/**
 * Define the tool.
 *
 * @param options.plugin - `{ name }` (version is read at call time).
 * @param options.readVersion - `async () => string` resolving this package's version.
 * @param options.pluginRoot - plugin package directory.
 * @param options.skillsDir - bundled skills directory.
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`; course-owned tools
 *   receive a wrapper that throws `PROFESSOR_PROJECT_MISSING` for an unbound workspace.
 * @param options.resolveRoots - root-variable resolver.
 * @param options.gateway - filesystem gateway.
 * @param options.skillCatalog - `async () => { provider, names }`.
 * @param options.watcher - the shared skills watcher (health reporting).
 * @param options.indexSummary - `async (projectRoot, signal) => object|null`.
 * @param options.capabilities - probed capability map.
 * @param options.ensureProbed - `async (signal) => capabilities`; runs the backend probe once.
 * @param options.runnerWired - whether the shell seam is available.
 * @param options.readConflicts - `async (projectRoot, signal) => object`.
 * @param options.artifactRoots - `(document, projectRoot) => object`.
 * @param options.readBinding - `async ({ projectRoot, sessionId, signal }) => object`.
 * @param options.migrationStatus - `async (projectRoot, signal) => object`.
 * @param options.readMigrationLog - `async (projectRoot, signal) => object`.
 * @param options.appStorage - Professor application storage handle (`describe()`/`ensureOpen()`).
 * @param options.memoryStatus - `async () => object`; the persistent-memory store snapshot
 *   (enabled switch, counts, budgets — never record contents).
 * @param options.workspaceStatus - `async (observed) => { connection, readiness }`; the Phase 3
 *   academic-folder connection record plus the four-state readiness block. Receives what this call
 *   already observed, so it adds no disk read of its own.
 * @returns the tool definition.
 */
export function defineDiagnosticsTool(options) {
  const {
    plugin, pluginRoot, skillsDir, resolveProject, resolveRoots, gateway, skillCatalog, watcher,
    indexSummary, readVersion, capabilities = {}, runnerWired = false, readConflicts,
    artifactRoots, readBinding, migrationStatus, ensureProbed, appStorage, memoryStatus,
    workspaceStatus, materialReading,
  } = options

  return {
    name: DIAGNOSTICS_TOOL_NAME,
    description:
      'Report Professor plugin health: version, whether an academic folder is connected, project root and schema health, session binding, course registry, index and chunk-store status, '
      + 'the extraction capability matrix, LaTeX capability, artifact output health, unresolved roots, watcher health, recent state conflicts, '
      + 'migration status, Professor application storage, persistent-memory status, and the remaining limitations. Use it when something looks wrong before assuming a path or a capability.',
    parameters: NO_PARAMETERS,
    output: jsonOutput({
      type: 'object',
      properties: {
        plugin: { type: 'object' },
        runtime: { type: 'object' },
        project: { type: 'object' },
        session: { type: 'object' },
        sandbox: { type: 'object' },
        skills: { type: 'object' },
        index: { type: 'object' },
        chunks: { type: 'object' },
        extraction: { type: 'object' },
        material_reading: { type: 'object' },
        latex: { type: 'object' },
        artifacts: { type: 'object' },
        state: { type: 'object' },
        migration: { type: 'object' },
        roots: { type: 'object' },
        appStorage: { type: 'object' },
        memory: { type: 'object' },
        workspace: { type: 'object' },
        warnings: { type: 'array' },
        limitations: { type: 'array' },
        notImplemented: { type: 'array' },
      },
      required: [
        'plugin', 'runtime', 'project', 'session', 'sandbox', 'skills', 'index', 'chunks',
        'extraction', 'material_reading', 'latex', 'artifacts', 'state', 'migration', 'roots',
        'appStorage', 'memory', 'workspace', 'warnings', 'limitations', 'notImplemented',
      ],
    }),

    async execute(_args, exec) {
      const warnings = []
      const session = exec?.agent?.session
      const project = await resolveProject(exec)
      const bound = project.bound === true
      const signal = exec?.signal
      if (!bound) {
        // The single most common "something looks wrong" in a course-free session: it is not
        // wrong, there is simply nothing connected yet. Say exactly that, with the fix.
        warnings.push(
          `no academic folder is connected to this workspace (${project.reason}); `
          + 'Professor works as a general academic assistant, and course tools stay refused until a folder is connected',
        )
      }
      // Diagnosing "which extractor is available" is the whole point of the capability block, so
      // diagnostics is allowed to run the probe — once per plugin instance, and never more. A probe
      // that throws is a reported warning, not a broken health endpoint.
      if (typeof ensureProbed === 'function') {
        try {
          await ensureProbed(signal)
        } catch (error) {
          warnings.push(`extraction capability probe failed: ${error.message}`)
        }
      }
      // Every disk observation is guarded by this one question. A context without a filesystem
      // service is not a broken project — it is a context that cannot *see* the project, and the
      // report says exactly that instead of throwing or pretending the project is absent.
      const fsAvailable = gateway.available
      if (!fsAvailable) {
        warnings.push('the Harness filesystem service (ctx.fs) is unavailable: on-disk project state cannot be observed in this context')
      }
      const resolved = await resolveRoots({ cwd: project.root })

      const unresolved = Object.entries(resolved.roots)
        .filter(([, info]) => info.value === null)
        .map(([key, info]) => ({ key, source: info.source }))
      if (unresolved.length > 0) {
        warnings.push(`unresolved root variables: ${unresolved.map((entry) => entry.key).join(', ')}`)
      }

      // --- skills -------------------------------------------------------------------------
      let skills = { provider: null, skillsDir, count: 0, watcher: null }
      try {
        const provider = await skillCatalog()
        skills = {
          provider: provider.provider,
          skillsDir,
          count: provider.names.length,
          names: provider.names,
          watcher: watcher === undefined ? null : { healthy: watcher.healthy, reason: watcher.reason },
        }
        if (watcher !== undefined && watcher.healthy === false) {
          warnings.push(`skill hot-reload degraded: ${watcher.reason}`)
        }
      } catch (error) {
        warnings.push(`skill provider unavailable: ${error.message}`)
      }

      // --- project + schema health --------------------------------------------------------
      let loaded = { present: false, document: null, unsupported: null, problems: [], warnings: [] }
      if (fsAvailable) {
        try {
          loaded = await loadProject({ gateway, projectRoot: project.root, signal })
        } catch (error) {
          loaded = { present: false, document: null, unsupported: null, problems: [`project.yaml unreadable: ${error.message}`], warnings: [] }
          warnings.push(`project.yaml unreadable: ${error.message}`)
        }
      }
      let projectFile = fsAvailable ? 'absent' : 'unobservable'
      if (fsAvailable) {
        try {
          const target = await gateway.resolveTarget(projectPaths(project.root).projectFile, { cwd: project.root, signal })
          const info = await gateway.stat(target, signal)
          projectFile = info === undefined ? 'absent' : 'present'
        } catch (error) {
          projectFile = `unreadable: ${error.message}`
        }
      }
      if (projectFile === 'absent') {
        warnings.push('project.yaml is not present yet: the project has not been initialised')
      } else if (projectFile.startsWith('unreadable')) {
        warnings.push(`project.yaml could not be read: ${projectFile}`)
      }

      const schemaHealth = {
        present: loaded.present,
        supported: loaded.present && loaded.unsupported === null && loaded.document !== null,
        schemaVersion: loaded.document?.schema_version ?? null,
        expectedVersion: PROJECT_SCHEMA_VERSION,
        problems: asArray(loaded.problems),
      }
      if (loaded.unsupported !== null) {
        warnings.push(`project.yaml schema is unsupported: ${loaded.problems[0]}`)
      } else if (schemaHealth.present && asArray(loaded.problems).length > 0) {
        warnings.push(`project.yaml failed validation: ${asArray(loaded.problems).join('; ')}`)
      }

      const document = schemaHealth.supported ? loaded.document : null
      const courses = asArray(document?.courses)
      const courseRegistry = {
        total: courses.length,
        active: courses.filter((course) => (course.status ?? 'active') === 'active').length,
        archived: courses.filter((course) => course.status === 'archived').length,
        source_paths: courses.reduce((sum, course) => sum + asArray(course.sources).length, 0),
      }

      // --- session binding ----------------------------------------------------------------
      let binding = { sessionId: session?.id ?? null, bound: false, course_id: null }
      if (fsAvailable && typeof session?.id === 'string' && typeof readBinding === 'function') {
        try {
          const current = await readBinding({ projectRoot: project.root, sessionId: session.id, signal })
          binding = {
            sessionId: session.id,
            bound: current.present && current.record?.course_id !== null,
            course_id: current.present ? (current.record?.course_id ?? null) : null,
            history_length: current.present ? asArray(current.record?.history).length : 0,
          }
        } catch (error) {
          warnings.push(`session binding unreadable: ${error.message}`)
        }
      }

      // --- index + chunks -----------------------------------------------------------------
      let index = { present: false }
      if (fsAvailable) {
        try {
          const summary = await indexSummary(project.root, signal)
          if (summary !== null && summary !== undefined) index = { present: true, ...summary }
        } catch (error) {
          warnings.push(`index unreadable: ${error.message}`)
        }
      }

      let chunks = { present: false }
      if (fsAvailable) {
        try {
          const counted = await countChunks({ gateway, projectRoot: project.root, signal })
          chunks = { present: counted.files > 0, ...counted }
        } catch (error) {
          warnings.push(`chunk store unreadable: ${error.message}`)
        }
      }

      // --- artifacts ----------------------------------------------------------------------
      let artifacts = { roots: {}, problems: [] }
      if (document !== null && typeof artifactRoots === 'function') {
        try {
          const roots = artifactRoots(document, project.root)
          const summarized = {}
          for (const [kind, info] of Object.entries(roots)) {
            summarized[kind] = {
              root: info.root,
              source: info.source,
              configured: info.configured === true,
              inside_source: info.insideSource ?? null,
              problems: asArray(info.problems),
            }
            for (const problem of asArray(info.problems)) warnings.push(`artifact root (${kind}): ${problem}`)
          }
          artifacts = { roots: summarized, problems: [] }
        } catch (error) {
          artifacts = { roots: {}, problems: [error.message] }
          warnings.push(`artifact roots unavailable: ${error.message}`)
        }
      }

      // --- state conflicts + migration ----------------------------------------------------
      let state = { conflicts: { present: false, entries: [] } }
      if (fsAvailable && typeof readConflicts === 'function') {
        try {
          state = { conflicts: await readConflicts(project.root, signal) }
        } catch (error) {
          warnings.push(`conflict log unreadable: ${error.message}`)
        }
      } else {
        state = {
          conflicts: {
            present: false,
            entries: [],
            note: 'concurrent state writes are refused at write time and surfaced as stale: true',
          },
        }
      }

      let migration = { status: 'unknown' }
      if (fsAvailable && typeof migrationStatus === 'function') {
        try {
          migration = await migrationStatus(project.root, signal)
        } catch (error) {
          migration = { status: 'unreadable', problems: [error.message] }
        }
      }

      // --- Professor application storage --------------------------------------------------
      // Opened on demand (this call may be the first thing that needs it) and reported as a state,
      // never as an exception: a host with no storage service must still describe itself.
      const storage = appStorage === undefined
        ? { status: 'unavailable', reason: 'application storage is not wired into this diagnostics call' }
        : await appStorage.ensureOpen()
      if (storage.status === 'unavailable') {
        warnings.push(`Professor application storage is unavailable: ${storage.reason}`)
      }

      // --- persistent memory (M2) ---------------------------------------------------------
      // Counts and the enabled switch only — record contents never appear in a health report.
      let memory = {
        enabled: true,
        counts: { global_preferences: 0, course_records: 0 },
        note: 'persistent memory is not wired into this diagnostics call',
      }
      if (typeof memoryStatus === 'function') {
        try {
          memory = await memoryStatus()
        } catch (error) {
          warnings.push(`persistent memory status unavailable: ${error.message}`)
        }
      }

      // --- workspace connection + readiness (Phase 3) -------------------------------------
      // Deliberately separate from `project.bound`. `bound` answers "is there a `.professor/` here?",
      // which a hand-made project.yaml also satisfies; the connection record answers "did the user
      // connect this folder through onboarding?", and readiness answers "is the derived work done?".
      // A folder can be bound and never onboarded, so collapsing the three would overstate the state.
      let workspace = { connection: null, readiness: null }
      if (typeof workspaceStatus === 'function') {
        try {
          workspace = await workspaceStatus({
            projectRoot: project.root,
            bound,
            fsAvailable,
            configurationSaved: schemaHealth.supported,
            courseCount: courses.length,
            index,
            chunks,
          })
        } catch (error) {
          warnings.push(`workspace connection unreadable: ${error.message}`)
        }
      }
      if (workspace.connection?.unavailable !== null && workspace.connection?.unavailable !== undefined) {
        warnings.push(`the workspace connection record could not be read: ${workspace.connection.unavailable}`)
      }
      if (workspace.connection?.present === true && workspace.connection.supported === false) {
        warnings.push(
          `the stored workspace connection uses schema ${JSON.stringify(workspace.connection.version ?? null)}, `
          + 'which this plugin does not support; it is reported as-is and never rewritten',
        )
      }

      return {
        plugin: {
          name: plugin.name,
          version: readVersion === undefined ? 'unknown' : await readVersion(),
          root: pluginRoot,
          preset: 'professor',
          preset_scoped: true,
        },
        runtime: {
          registered_by: 'the professor preset only (ordinary agents receive no professor_* tools or skills)',
          shell_runner: runnerWired ? 'wired (ctx.shell)' : 'absent (LaTeX compilation is reported as not attempted)',
          extraction_runner: runnerWired
            ? 'wired (ctx.shell): PDF text via PyMuPDF or Ghostscript, Office text via the bundled Python interpreter'
            : 'absent (no shell seam in this context, so PDF and Office extraction are reported unsupported)',
        },
        project: {
          root: project.root,
          source: project.source,
          // `bound` is the difference between "Professor is pointed at your courses" and "this is a
          // general academic session"; every course-owned tool reads the same flag.
          bound,
          connected: bound,
          reason: project.reason ?? null,
          projectFile,
          schemaHealth,
          courses: courseRegistry,
          outputs: {
            notes_root: document?.outputs?.notes_root ?? null,
            reviews_root: document?.outputs?.reviews_root ?? null,
          },
        },
        session: {
          id: session?.id ?? null,
          cwd: session?.header?.cwd ?? null,
          binding,
        },
        sandbox: {
          fsAvailable: gateway.available,
          fsSandboxMode: gateway.sandboxMode ?? null,
          callPolicy: gateway.sessionPolicy(session) ?? null,
        },
        skills,
        index,
        chunks,
        extraction: {
          capabilities: summarizeCapabilities(capabilities),
          chunkStores: chunks,
          // Extraction and visual inspection are different capabilities and are reported separately:
          // a backend that produced text has proved nothing about how the page looks.
          visualInspection: 'rendering exists (professor_material_read rasterises a bounded page range in memory), '
            + 'but this plugin never interprets the pixels: a page counts as inspected only when the reading ledger '
            + 'shows an image was delivered or the caller recorded a note for it',
        },
        // Reading state for *this* session only: counts and codes, never material content.
        material_reading: typeof materialReading === 'function'
          ? (() => { try { return materialReading(exec) } catch (error) { return { present: false, error: String(error?.message ?? error) } } })()
          : { present: false, reason: 'no reading ledger is mounted in this context' },
        latex: {
          ...summarizeCapabilities(capabilities).latex,
          runner: runnerWired ? 'wired' : 'absent',
        },
        artifacts,
        state,
        migration,
        roots: resolved.roots,
        appStorage: storage,
        memory,
        workspace,
        warnings,
        limitations: NOT_IMPLEMENTED,
        notImplemented: NOT_IMPLEMENTED,
      }
    },
  }
}
