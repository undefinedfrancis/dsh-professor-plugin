/**
 * Composition root: wires the plugin's modules into a Cordis plugin.
 *
 * Responsibilities kept here (and nowhere else): service injection, module construction, tool
 * registration, skill-provider registration, and lifecycle teardown. Behaviour lives in the
 * modules under `src/`.
 *
 * @module dsh-professor-spike/src/plugin
 */

import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createLogger } from './logging.js'
import { createTelemetry } from './telemetry.js'
import { createAppStorage } from './app/storage.js'
import { createProfessorHome, createCourseCatalog } from './app/home.js'
import { createProfessorAppViews } from './app/views.js'
import { createProfessorCommands } from './app/commands.js'
import { createMaterialValidator } from './app/materials.js'
import { createMaterialLauncher } from './app/material-launch.js'
import { readConnectionRecord } from './workspace/onboarding.js'
import { APP_OWNER_SERVICE, createAppStorageOwner } from './app/owner.js'
import { registerProfessorRemote } from './app/remote.js'
import { createSessionRegistry } from './app/sessions.js'
import { createFsGateway } from './fs/gateway.js'
import { assertUsableProject, loadProject } from './project/project.js'
import { summarizeCourses } from './courses/registry.js'
import { writeBinding, readBinding, applyBind } from './state/course-binding.js'
import { createMemoryStore } from './memory/store.js'
import { createSessionMemory } from './memory/session.js'
import { createPathPolicy } from './paths/policy.js'
import {
  allowedRoots, assertProjectBound, projectPaths, resolveProjectRoot, resolveRootVariables,
  sessionId as sessionIdOf,
} from './paths/roots.js'
import { createBundledSkillProvider, SKILL_PROVIDER_NAME } from './skills/provider.js'
import { createSkillsWatcher } from './skills/watcher.js'
import { createSkillCustomizationStore } from './skills/customization.js'
import { bundledPreset, DEFAULT_PRESET_ID } from './skills/presets.js'
import { createPresetLibraryStore } from './app/presets.js'
import { defineArtifactCreateTool, defineArtifactStatusTool, artifactRootsOf } from './tools/artifacts.js'
import { defineCourseListTool, defineCourseManageTool } from './tools/courses.js'
import { defineExtractTool, runExtraction } from './tools/extract.js'
import { defineLatexCompileTool } from './tools/latex.js'
import { defineMaterialReadTool } from './tools/material-read.js'
import { createReadingLedger } from './material/ledger.js'
import { createEnhancementService } from './material/enhance.js'
import { createMaterialRuntime } from './material/runtime.js'
import { defineSearchTool } from './tools/search.js'
import { probeLatex, summarizeLatex } from './latex/capabilities.js'
import { createShellRunner } from './latex/runner.js'
import { createExtractionService } from './extract/runner.js'
import { readMigrationStatus } from './migrations/log.js'
import { readConflicts } from './state/conflicts.js'
import { defineDiagnosticsTool } from './tools/diagnostics.js'
import { defineMemoryReadTool, defineMemoryStatusTool, defineMemoryUpdateTool } from './tools/memory.js'
import { defineIndexSyncTool, readIndexSummary, runIndexSync } from './tools/index-sync.js'
import { definePathsTool } from './tools/paths.js'
import { defineProjectInitTool } from './tools/project-init.js'
import { defineSessionBindTool, defineSessionStatusTool } from './tools/session.js'
import { defineStateReadTool, defineStateUpdateTool } from './tools/state.js'
import {
  createWorkspaceOnboarding,
  defineWorkspaceConfirmTool,
  defineWorkspaceDiscoverTool,
  defineWorkspaceRebuildTool,
} from './workspace/onboarding.js'

/** Cordis plugin name. */
export const name = 'professor-spike'

/** Services this plugin needs before it can apply. */
export const inject = ['tools', 'fs', 'skills', 'systemPrompt']

/** Absolute directory of this package (used to locate the bundled skills). */
export function pluginRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)))
}

/**
 * Read this package's own version so diagnostics never report a stale hardcoded string.
 *
 * Reads a file inside the plugin's own package (same documented exception as the skills directory:
 * user data always goes through the filesystem gateway).
 *
 * @returns the version string, or `'unknown'`.
 */
async function readOwnVersion(root) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Attach to the single shared application-storage owner.
 *
 * There is one `professor_app` domain and the host refuses a second concurrent open of it, so the
 * UI backend (mounted at deployment level) and the Professor runtime (mounted inside the preset)
 * must consume **one** handle. The row that gets here first creates and publishes it; the other
 * acquires a consumer facet. See `src/app/owner.js`.
 *
 * @returns `{ owner, storage, owns, shared? }` where `storage` is the facet this row must use.
 */
const deploymentOwners = new WeakMap()
export function resolveSharedOwner({ ctx, root, logger, label }) {
  const deployment = ctx.root ?? ctx
  const existing = (() => {
    try {
      return deploymentOwners.get(deployment) ?? (typeof ctx?.get === 'function' ? ctx.get(APP_OWNER_SERVICE) : undefined)
    } catch {
      return undefined
    }
  })()

  if (existing !== undefined && existing !== null && typeof existing.acquire === 'function') {
    return { owner: existing, storage: existing.acquire(label), owns: false, shared: existing }
  }

  const owner = createAppStorageOwner({
    ctx, logger, readVersion: () => readOwnVersion(root),
  })

  // Published as a *facade* rather than the raw owner, because the two rows need one more thing in
  // common than the domain: whichever row owns the per-session memory handle must be able to hand it
  // to the row that launches sessions. One object, one owner, one handshake.
  const shared = {
    owner: existing ?? owner,
    acquire: (consumer) => owner.acquire(consumer),
    describe: () => owner.describe(),
    sessionMemory: null,
    /** Called by the Professor runtime row; `null` until a runtime row is mounted. */
    setSessionMemory(handle) { this.sessionMemory = handle ?? null },
    async dispose() { await owner.dispose() },
  }
  deploymentOwners.set(deployment, shared)
  if (deployment !== ctx && typeof deployment.effect === 'function') {
    deployment.effect(() => () => shared.dispose(), 'professor:deployment-storage')
  }
  try {
    if (typeof ctx?.provide === 'function') ctx.provide(APP_OWNER_SERVICE, shared)
  } catch (error) {
    logger?.warn?.(`professor could not publish the shared application storage: ${error?.message ?? String(error)}`)
  }
  return { owner, storage: shared.acquire(label), owns: true, shared }
}

/**
 * Build the native-session accessors {@link createProfessorHome} needs.
 *
 * Every host service is resolved **lazily, per call**, because this row mounts before the services a
 * launch uses exist, and nothing here is allowed to fail at apply — a missing agent factory is a
 * launch-time error with an actionable message, never a broken boot.
 *
 * @param options.shared - the storage facade, read live so the runtime row's memory handle, once it
 *   mounts, is what a later launch hydrates with.
 */
export function createLaunchHost({ ctx, logger, shared, gateway }) {
  const service = (name) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }
  /** A short-lived set of persisted session ids, so Home does not replay logs to answer "does it exist?" */
  const persistedIds = async (signal) => {
    const query = service('sessionQuery') ?? service('sessionsQuery')
    if (query === undefined || typeof query.listSessions !== 'function') return null
    try {
      const rows = await query.listSessions(signal)
      const ids = new Set((rows ?? []).map((row) => row?.header?.id).filter((value) => typeof value === 'string'))
      return ids
    } catch {
      return null
    }
  }

  return {
    async createSession({ sessionId, cwd }) {
      const agents = service('agents')
      if (agents === undefined || typeof agents.create !== 'function') {
        throw new Error('the Harness agent factory (ctx.agents) is unavailable')
      }
      const ids = await persistedIds()
      if (ids?.has(sessionId)) {
        const controller = service('sessionController')
        if (!controller?.resolveAgent) throw new Error('Harness native session restoration is unavailable')
        // The controller restores the persisted preset and model selection before publishing.
        const restored = await controller.resolveAgent(sessionId)
        if (restored.error) throw restored.error
        return restored
      }
      const workspaces = service('workspaceRegistry')
      if (!workspaces) throw new Error('Harness workspace registry is unavailable')
      const workspace = await workspaces.resolveByPath(cwd) ?? await workspaces.create(cwd)
      const controller = service('sessionController')
      if (typeof controller?.create === 'function' && typeof controller?.resolveAgent === 'function') {
        // The controller installs session-local model selection and the preset during setup.
        await controller.create({ sessionId, workspaceId: workspace.id, agentPreset: 'professor' })
        const handle = await controller.resolveAgent(sessionId)
        if (handle.error) throw handle.error
        return handle
      }
      const handle = await agents.create({ sessionId, meta: { cwd: workspace.path } })
      await workspace.attachSession(sessionId)
      return handle
    },

    findAgent(sessionId) {
      try {
        return service('agents')?.get?.(sessionId)
      } catch {
        return undefined
      }
    },

    async hasSession(sessionId) {
      try {
        if (this.findAgent(sessionId) !== undefined) return true
        if (service('sessions')?.get?.(sessionId) !== undefined) return true
      } catch {
        // A probe that throws is not evidence of absence; fall through to the persisted index.
      }
      const ids = await persistedIds()
      return ids === null ? false : ids.has(sessionId)
    },

    /**
     * Strict tri-state existence probe for **clearing**: `'present'`, `'absent'` or `'unknown'`.
     *
     * `hasSession` above is deliberately lenient for its callers (launch/reopen treat a false as
     * "not usable right now" and fail safe with an error either way), but clearing must not confuse
     * "the session query is unavailable" with "the conversation is gone": the latter authorises
     * stale-row cleanup without an archive, and a wrong `'absent'` there would hide the row while
     * leaving the native chat unarchived. Only a clean, complete listing that omits the id — with
     * every live probe also failing to find it — is `'absent'`.
     */
    async probeSession(sessionId) {
      let liveProbeFailed = false
      try {
        if (this.findAgent(sessionId) !== undefined) return 'present'
        if (service('sessions')?.get?.(sessionId) !== undefined) return 'present'
      } catch {
        liveProbeFailed = true
      }
      const ids = await persistedIds()
      // `null` means the authoritative persistence query is missing or threw: nothing is known.
      if (ids === null) return 'unknown'
      if (ids.has(sessionId)) return 'present'
      // A throwing live probe never upgrades to a confirmed absence.
      return liveProbeFailed ? 'unknown' : 'absent'
    },

    /**
     * Archive one native conversation — the supported workspaceRegistry operation, never a delete.
     *
     * `stopActivity: false` is deliberate and required: a running conversation is refused by the
     * host instead of being forcibly stopped, and the durable archive set keeps the native history
     * recoverable (`unarchiveSession` restores it). Success resolves `undefined`, which is success.
     */
    async archiveSession(sessionId) {
      const workspaces = service('workspaceRegistry')
      if (workspaces === undefined || typeof workspaces.archiveSession !== 'function') {
        const error = new Error('Harness workspace registry does not expose conversation archiving')
        error.code = 'PROFESSOR_ARCHIVE_UNAVAILABLE'
        throw error
      }
      await workspaces.archiveSession(sessionId, { stopActivity: false })
    },

    async selectPreset(agent, presetId) {
      const presets = service('agentPresets')
      if (presets === undefined || typeof presets.select !== 'function') {
        throw new Error('the Harness preset registry (ctx.agentPresets) is unavailable')
      }
      return presets.select(agent, presetId)
    },

    async composedPreset(agent) {
      try {
        return await service('agentPresets')?.composedPreset?.(agent?.ctx ?? agent)
      } catch (error) {
        logger?.warn?.(`reading this session's preset failed: ${error?.message ?? String(error)}`)
        return undefined
      }
    },

    /**
     * Bind the launched session to its course through the **same** binding file the
     * `professor_session_bind` tool writes, so nothing about how a course is attached differs
     * between "the user asked" and "the user clicked a course in Home".
     */
    async bindCourse({ agent, projectRoot, courseId }) {
      const sessionId = agent?.session?.id ?? agent?.id
      if (typeof sessionId !== 'string' || projectRoot === null || projectRoot === undefined) return false
      const current = await readBinding({ gateway, projectRoot, sessionId })
        .catch(() => ({ present: false, record: null, observedVersion: undefined }))
      if (current.present === true && current.record?.course_id === courseId) return true
      const applied = applyBind({
        record: current.record ?? null,
        sessionId,
        courseId,
        reason: 'home-launch',
        at: new Date().toISOString(),
      })
      await writeBinding({
        gateway,
        projectRoot,
        sessionId,
        record: applied.record,
        session: agent?.session,
        version: current.observedVersion,
        writePolicy: createPathPolicy({ roots: [projectPaths(projectRoot).base], label: 'write' }),
      })
      logger?.info?.(`professor home bound ${sessionId} to ${courseId}`)
      return true
    },

    /** Hydrate through whichever row owns the memory handle; report honestly when none is mounted. */
    async hydrate(agent) {
      const memory = shared?.sessionMemory
      if (memory === null || memory === undefined || typeof memory.refreshAgent !== 'function') return false
      try {
        await memory.refreshAgent(agent)
        return true
      } catch (error) {
        logger?.warn?.(`professor memory hydration failed: ${error?.message ?? String(error)}`)
        return false
      }
    },

    defaultCwd() {
      try {
        const fromProfile = service('profileContext')?.cwd
        if (typeof fromProfile === 'string' && fromProfile.length > 0) return fromProfile
      } catch {
        // Fall through to this process's own working directory.
      }
      return process.cwd()
    },

    async setTitle(agent, title) {
      const titles = service('sessionTitle')
      if (!titles?.rename) throw new Error('Harness session title service is unavailable')
      await titles.rename(agent.session, title)
    },
  }
}

/**
 * Mount the **Professor application backend**.
 *
 * This is the row Professor's sidebar entry talks to. It owns no academic surface on purpose: an
 * ordinary coding session must not gain tools, skills or a persona because a UI exists.
 */
function applyApp({ ctx, logger, root }) {
  const { owner, storage, shared } = resolveSharedOwner({
    ctx, root, logger, label: 'professor-home',
  })
  const gateway = createFsGateway({ ctx, logger })
  const registry = createSessionRegistry({ appStorage: storage })

  const catalog = createCourseCatalog({
    appStorage: storage,
    // The connected folder's project document is the single authority for courses — read through
    // the Harness filesystem service, never through `node:fs`, and never guessed from a directory
    // name. When the service is absent the catalog says so, and Home shows a course-free state.
    readCourses: async (projectRoot) => {
      if (gateway.available !== true) throw new Error('the Harness filesystem service (ctx.fs) is unavailable')
      const loaded = await loadProject({ gateway, projectRoot })
      return summarizeCourses(assertUsableProject(loaded))
    },
  })

  const host = createLaunchHost({ ctx, logger, shared, gateway })
  const home = createProfessorHome({ appStorage: storage, registry, catalog, host, logger })
  const commands = createProfessorCommands({ registry,
    resolveAgent: async sessionId => {
      await home.reopen({ sessionId })
      return ctx.get('agents')?.get(sessionId)
    },
    composedPreset: agent => host.composedPreset(agent),
    readConnectionRevision: async () => {
      const connection = await readConnectionRecord(storage)
      if (connection.unavailable || (connection.present && !connection.supported)) throw new Error('Academic connection is unavailable')
      return connection.record?.active?.revision ?? 0
    },
    execute: request => ctx.get('tools').execute(request),
  })
  const readIndex = async projectRoot => {
    const target = await gateway.resolveTarget(projectPaths(projectRoot).filesIndex, { cwd: projectRoot })
    if (await gateway.stat(target) === undefined) return null
    return JSON.parse(await gateway.readText(target))
  }
  const sessionProjectRoot = async sessionId => {
    const live = ctx.get('sessions')?.get(sessionId)
    if (live) return live.header?.cwd ?? null
    const rows = await ctx.get('sessionQuery')?.listSessions()
    return rows?.find(row => row.header?.id === sessionId)?.header?.cwd ?? null
  }
  const materials = createMaterialLauncher({ home, sessionProjectRoot,
    validator: createMaterialValidator({ catalog, readIndex, gateway,
      policiesFor: projectRoot => ({ read: createPathPolicy({ roots: [projectRoot], label: 'read' }) }) }),
  })
  const views = createProfessorAppViews({ catalog, registry,
    customization: createSkillCustomizationStore({ appStorage: storage, queueOwner: shared }),
    memory: createMemoryStore({ appStorage: storage, queueOwner: shared }),
    onMemoryChanged: () => shared.sessionMemory?.refreshAll(),
    readProject: async projectRoot => assertUsableProject(await loadProject({ gateway, projectRoot })),
    readIndex, sessionProjectRoot, appStorage: storage, queueOwner: shared,
  })
  const remote = registerProfessorRemote({ scope: typeof ctx.extend === 'function' ? ctx.extend() : ctx, home, views, commands, materials, logger })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => {
      remote.withdraw()
      commands.dispose()
      materials.dispose()
      home.dispose()
      await storage.release()
    }, 'professor-spike:professor-home')
  }

  logger.info('professor application backend mounted (shared storage owner, session registry, Home remote)')
  return { home, registry, remote, storage, owner }
}

/**
 * Apply the plugin.
 *
 * ## Two modes, one ownership model
 *
 * `config.app === true` mounts the **Professor application backend**: shared storage ownership, the
 * session registry, the course catalog, the launch orchestration and its official Typed Remote
 * endpoints — and **no tools, no skills and no persona**, so an ordinary coding session gains
 * nothing from it. Everything else (the academic surface) mounts only inside the `professor` preset,
 * exactly as before.
 *
 * Both modes share one application-storage owner and, when both are mounted, the runtime registers
 * its per-session memory handle so a launch can hydrate before the UI navigates.
 *
 * @param ctx - Cordis context with `tools`, `fs` and `skills` (runtime mode only).
 * @param config - optional plugin config (read defensively; no schemastery dependency):
 *   `{ watcherDebounceMs?: number, extraReadRoots?: string[], app?: boolean,
 *   materialReadBudget?: object, extractRuntime?: { pathDirs?, homedir?, isFile? } }`.
 */
export function apply(ctx, config = {}) {
  const logger = createLogger(ctx)
  // Privacy-conscious diagnostics: counts and codes only, never material content.
  const telemetry = createTelemetry({ logger, enabled: config.diagnostics !== false })
  const root = pluginRoot()
  const skillsDir = path.join(root, 'skills')
  const gateway = createFsGateway({ ctx, logger })

  if (config.app === true) return applyApp({ ctx, config, logger, root, gateway })

  const { storage: appStorage, shared } = resolveSharedOwner({
    ctx, root, logger, label: 'professor-runtime',
  })

  /**
   * Build the read/write policies for one project root.
   *
   * Read: the project workspace, the plugin's own package resources, and configured extras.
   *
   * Write: the project's `.professor/` directory **plus any explicitly configured output root**
   * (`outputs.notes_root` / `outputs.reviews_root` in project.yaml). The design allows a write
   * inside `.professor/` or an explicitly configured output root, and notes must land in the AI
   * Notes Output the registry declares — but nothing else is writable, so course material is
   * never a legal target even if a path points at it.
   *
   * `outputRoots` is injected because only the plugin can read the project document; callers pass
   * `document.outputs` through after loading it.
   *
   * **Unbound workspaces (Phase 1).** When the workspace is not a Professor academic folder
   * (`bound: false`) the session workspace is dropped from both lists: no read root, no write root.
   * The course-owned tools already refuse such a call before they reach here, so this is the second
   * line of defence — it means a future tool that forgets its guard still cannot create a
   * `.professor/` tree in a directory the user never connected. `bound: true` restores the normal
   * policy, and is what `professor_project_init` passes when it deliberately creates the project.
   */
  const policiesFor = (projectRoot, outputRoots = [], { bound = true } = {}) => {
    const configured = [...outputRoots]
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
    const readRoots = bound
      ? [projectRoot, root, ...allowedRoots(), ...(config.extraReadRoots ?? [])]
      : [root, ...allowedRoots(), ...(config.extraReadRoots ?? [])]
    return {
      read: createPathPolicy({
        roots: readRoots,
        label: 'read',
      }),
      write: createPathPolicy({
        roots: bound ? [projectPaths(projectRoot).base, ...configured] : [],
        label: 'write',
      }),
    }
  }

  /** Read the configured output roots from the project document (empty when absent/unusable). */
  const outputRootsFor = (document) => ([
    document?.outputs?.notes_root,
    document?.outputs?.reviews_root,
    ...(document?.courses ?? []).flatMap((course) => [course.outputs?.notes_root, course.outputs?.reviews_root]),
  ])

  const resolveProject = (exec) => resolveProjectRoot(exec)

  /**
   * Resolve the project for a course-owned tool, refusing an unbound workspace.
   *
   * Kept separate from `resolveProject` rather than folded into it: `professor_paths`,
   * `professor_diagnostics`, `professor_course_list` and `professor_project_init` must all *work*
   * without a project (the first two to report that fact, the third to answer "no courses
   * connected", the fourth to create one). Everything else needs a folder and must say so.
   */
  const requireCourseProject = async (exec) => assertProjectBound(await resolveProjectRoot(exec))

  // --- application storage ----------------------------------------------------
  // Professor-owned persistence for a session with no academic folder, consumed through the *shared*
  // owner (`appStorage` above): the UI backend and this runtime must never hold the domain twice,
  // and the host refuses a concurrent open of the same name.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => {
      await appStorage.release()
    }, 'professor-spike:app-storage')
  }

  // --- persistent memory (Phase 2) --------------------------------------------
  // Exactly one memory store per plugin lifecycle, over the Phase 1 `professor_app` domain — no
  // second storage system, no per-session stores (the host refuses a concurrent open of the same
  // domain, so a single handle is both necessary and sufficient). Every session's memory section
  // renders from a per-agent cache hydrated at `agent/created`; disposing one agent drops only
  // its cache entry.
  const memoryStore = createMemoryStore({ appStorage, queueOwner: shared })

  const isProfessorAgent = async (agent) => {
    try {
      return await ctx.get('agentPresets')?.composedPreset?.(agent?.ctx) === 'professor'
    } catch {
      return false
    }
  }

  const sessionMemory = createSessionMemory({
    store: memoryStore,
    gateway,
    policiesFor,
    logger,
    isProfessorAgent,
  })

  // Hand this row's per-session memory to whoever owns the shared app-level object, so a Home launch
  // can hydrate the memory of the session it just created *before* the UI navigates to it. The
  // profile does not own a second copy: publishing it here is the whole handshake.
  if (shared !== undefined && typeof shared.setSessionMemory === 'function') {
    shared.setSessionMemory(sessionMemory)
    ctx.effect?.(() => () => {
      if (shared.sessionMemory === sessionMemory) shared.setSessionMemory(null)
    }, 'professor-spike:shared-memory')
  }

  // --- extraction capabilities ------------------------------------------------
  // The capability object is live: `createExtractionService` fills it in from a real probe, and
  // diagnostics and `professor_extract` read the same reference. Probing is **lazy** — it happens on
  // the first extraction or diagnostics call, never at apply — so a session that never extracts
  // spawns nothing and the boot path stays deterministic. Until a probe actually runs, every backend
  // is `null`/`false`: an unobserved capability is reported unavailable with its reason rather than
  // assumed from a file name.
  const runner = createShellRunner(ctx)
  const extraction = createExtractionService({
    shellRun: runner,
    pluginRoot: root,
    env: process.env,
    logger,
    // The app's own read-only carrier, derived rather than hardcoded, so no machine-specific path
    // is embedded in this package.
    resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined,
    includeSpeakerNotes: config.includeSpeakerNotes === true,
    ...(config.extractLimits === undefined ? {} : { limits: config.extractLimits }),
    ...(config.extractTimeouts === undefined ? {} : { timeouts: config.extractTimeouts }),
    // Interpreter discovery seam: which candidate locations to consider. An operator (and the
    // production tests, which pin the Ghostscript path on purpose) can narrow the search without
    // touching the machine. Omitted entirely, discovery behaves exactly as documented.
    ...(config.extractRuntime?.pathDirs === undefined ? {} : { pathDirs: config.extractRuntime.pathDirs }),
    ...(config.extractRuntime?.homedir === undefined ? {} : { homedir: config.extractRuntime.homedir }),
    ...(config.extractRuntime?.isFile === undefined ? {} : { isFile: config.extractRuntime.isFile }),
  })
  const capabilities = extraction.capabilities
  capabilities.officeToPdf = typeof ctx.get === 'function' && ctx.get('officeToPdf') !== undefined
  // Probed by looking for a TeX binary on the host. Reported, never assumed: a machine without
  // TeX says so, and `professor_latex_compile` re-probes at call time.
  capabilities.latex = summarizeLatex(probeLatex())

  // --- bounded material reading -------------------------------------------------
  // One reading ledger for the plugin's lifetime. It lives in process memory only — no file, no
  // cache directory — so nothing about a lecture can outlive the session that read it, and the
  // disposal below is what guarantees a torn-down plugin leaves no state (and no timers: the ledger
  // schedules nothing) behind. Budgets are the plugin's own ceilings, deliberately well inside the
  // host's request-image bound, so the loop a live comparison exposed is stopped by construction
  // rather than discovered after the fact.
  const materialLedger = createReadingLedger({
    budget: config.materialReadBudget ?? {},
  })
  const enhancement = createEnhancementService({
    pluginRoot: root, shellRun: runner,
    python: config.enhanceRuntime?.python ?? process.env.DSH_PROFESSOR_ENHANCE_PYTHON,
    artifactsPath: config.enhanceRuntime?.artifactsPath ?? process.env.DSH_PROFESSOR_ENHANCE_ARTIFACTS,
    backend: config.enhanceRuntime?.backend ?? 'docling',
  })
  capabilities.enhancement = enhancement.info
  const materialRuntime = createMaterialRuntime({ pluginRoot: root, shellRun: runner, gateway, extraction, enhancement,
    configured: Boolean(config.enhanceRuntime?.python ?? process.env.DSH_PROFESSOR_ENHANCE_PYTHON) })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { materialLedger.dispose(); enhancement.dispose(); materialRuntime.dispose() }, 'professor-spike:material-ledger')
  }

  // --- academic-folder onboarding (Phase 3) ------------------------------------
  // The backend a thin Settings UI calls: discover -> confirm -> apply -> index -> extract, with no
  // YAML hand-editing and no legacy-registry import. Nothing here runs at `apply`; a course-free
  // session is untouched until a caller actually asks to connect a folder.
  //
  // It deliberately drives the *same* services the tools expose (`registerCourse` into the same
  // `.professor/project.yaml`, `runIndexSync`, `runExtraction`) rather than a parallel registry or
  // index — there is one project document and one derived index in this plugin.
  const onboarding = createWorkspaceOnboarding({
    gateway,
    resolveProject,
    requireProject: requireCourseProject,
    policiesFor,
    outputRootsFor,
    runIndex: (options) => runIndexSync({
      gateway, policiesFor, outputRootsFor, logger, ...options,
    }),
    runExtract: (options) => runExtraction({
      gateway,
      policiesFor,
      capabilities,
      run: extraction.run,
      ensureProbed: extraction.ensureProbed,
      ...options,
    }),
    appStorage,
    logger,
  })

  // --- skills ---------------------------------------------------------------
  const customizationStore = createSkillCustomizationStore({ appStorage, queueOwner: shared })
  const presetLibrary = createPresetLibraryStore({ appStorage, queueOwner: shared })
  // Reuse the existing deployment facade: a new preset-provided service would require a new
  // isolate realm and prevent native preset selection on this host.
  shared.skillCustomization = customizationStore
  ctx.effect?.(() => () => {
    if (shared.skillCustomization === customizationStore) shared.skillCustomization = null
  }, 'professor-spike:shared-customization')
  const provider = createBundledSkillProvider({
    ctx,
    skillsDir,
    logger,
    onEvent: (kind, fields) => telemetry(kind, fields),
    resolveRoots: resolveRootVariables,
    resolveCustomization: async (skill, lookup) => {
      const global = (await customizationStore.read({ skill })).fields
      const agent = lookup.scope
      const studyScope = async () => {
        if (!agent?.session || !await isProfessorAgent(agent)) return { global, course: {}, untouched: Object.keys(global).length === 0 }
        const context = await sessionMemory.resolveCourseContextFor(agent, lookup.signal)
        if (context.course === null || context.namespace === null) return { global, course: {}, untouched: Object.keys(global).length === 0 }
        const course = (await customizationStore.read({ skill, scope: {
          namespace: context.namespace, courseId: context.course.course_id,
        } })).fields
        return { global, course, untouched: Object.keys(global).length === 0 && Object.keys(course).length === 0 }
      }
      const resolved = await studyScope()
      // A never-touched profile composes the default learning mode (循序讲解) as ordinary
      // preferences — written nowhere, never into material folders, and replaced field-by-field
      // the moment the learner saves anything of their own.
      if (skill === 'professor-study' && resolved.untouched) {
        try {
          const applied = await presetLibrary.readApplied({ skill })
          if (applied === null) {
            return Object.keys(resolved.course).length === 0
              ? { global: { ...bundledPreset(DEFAULT_PRESET_ID).fields } }
              : { global: { ...bundledPreset(DEFAULT_PRESET_ID).fields }, course: resolved.course }
          }
        } catch {
          // Library unreadable: fall through to the untouched composition rather than fail the skill.
        }
      }
      return { global: resolved.global, course: resolved.course }
    },
  })

  const controls = new Set()
  const watcher = createSkillsWatcher({
    dir: skillsDir,
    logger,
    debounceMs: typeof config.watcherDebounceMs === 'number' ? config.watcherDebounceMs : 250,
    // Injectable so tests and the offline verifier can exercise the skill contract without
    // opening a real directory watch: the contract is "one debounced watcher per instance, with
    // honest degradation", not "the host must have a spare file descriptor".
    ...(typeof config.watchFn === 'function' ? { watchFn: config.watchFn } : {}),
    onChange: () => {
      for (const control of controls) {
        try {
          control.invalidate?.()
        } catch (error) {
          logger?.warn(`skill catalog invalidation failed: ${error.message}`)
        }
      }
    },
  })

  if (typeof ctx.skills?.registerProvider === 'function') {
    ctx.skills.registerProvider((control) => {
      if (control !== undefined) {
        controls.add(control)
        control.signal?.addEventListener?.('abort', () => {
          controls.delete(control)
          if (controls.size === 0) watcher.close()
        }, { once: true })
      }
      return provider
    })
    logger.info(`skill provider "${SKILL_PROVIDER_NAME}" registered from ${skillsDir}`)
  } else {
    logger.warn('ctx.skills unavailable; bundled skills were not registered')
  }

  // One watcher per plugin instance, torn down with the plugin fiber.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => watcher.close(), 'professor-spike:skills-watcher')
  }

  // --- tools ----------------------------------------------------------------
  // Four tools resolve leniently (`resolveProject`): they are the ones that must answer a general,
  // course-free session. Everything else resolves strictly, so an unbound workspace is refused with
  // one descriptive domain error instead of a policy denial or, worse, a silent write.
  const tools = [
    definePathsTool({
      pluginRoot: root,
      skillsDir,
      resolveProject,
      resolveRoots: resolveRootVariables,
      policiesFor,
      gateway,
      appStorage,
    }),
    defineDiagnosticsTool({
      plugin: { name },
      readVersion: () => readOwnVersion(root),
      pluginRoot: root,
      skillsDir,
      resolveProject,
      resolveRoots: resolveRootVariables,
      gateway,
      watcher,
      appStorage,
      skillCatalog: async () => {
        const candidates = await provider.list()
        const list = Array.isArray(candidates) ? candidates : candidates.candidates
        return { provider: SKILL_PROVIDER_NAME, names: list.map((candidate) => candidate.name) }
      },
      indexSummary: (projectRoot, signal) => readIndexSummary({ gateway, projectRoot, signal }),
      capabilities,
      ensureProbed: extraction.ensureProbed,
      // Diagnostics observes; it never writes. Each callback is a bounded read of something that
      // already exists on disk, and a read that fails degrades to a warning rather than throwing.
      runnerWired: runner !== undefined,
      readConflicts: (projectRoot, signal) => readConflicts({ gateway, projectRoot, signal }),
      artifactRoots: (document, projectRoot) => artifactRootsOf(document, projectRoot),
      readBinding: (options) => readBinding({ gateway, ...options }),
      migrationStatus: (projectRoot, signal) => readMigrationStatus({ gateway, projectRoot, signal }),
      memoryStatus: () => memoryStore.describe(),
      // The connection record lives in application storage, and readiness is derived from what
      // diagnostics has already observed on disk — this callback adds no new disk reads of its own.
      // The reading ledger for this session: counts only, never page content.
      materialReading: (toolExec) => ({
        ...materialLedger.summary(sessionIdOf(toolExec) ?? 'no-session'),
        budget: materialLedger.budget,
      }),
      workspaceStatus: async ({
        projectRoot, bound, fsAvailable, configurationSaved, courseCount, index, chunks,
      }) => {
        const connection = await onboarding.readConnection()
        return {
          connection: {
            present: connection.present,
            supported: connection.supported,
            version: connection.version ?? connection.record?.schema ?? null,
            active: connection.supported === true ? connection.record?.active ?? null : null,
            history_length: Array.isArray(connection.record?.history) ? connection.record.history.length : 0,
            unavailable: connection.unavailable ?? null,
          },
          // Readiness answers "is this folder usable yet?" — which is not the same question as
          // `project.bound`, so it is reported separately and never inferred from a folder's name.
          readiness: bound !== true || fsAvailable !== true
            ? null
            : onboarding.buildReadiness({
              projectRoot,
              configurationSaved,
              courseCount,
              index: {
                complete: index?.present === true && index?.supported !== false,
                present: index?.present === true,
                files: index?.fileCount ?? null,
                generated_at: index?.generatedAt ?? null,
              },
              extraction: {
                complete: chunks?.present === true,
                searchable: chunks?.present === true,
                chunk_files: chunks?.files ?? 0,
                chunks: chunks?.chunks ?? 0,
              },
            }),
        }
      },
    }),
    defineIndexSyncTool({
      resolveProject: requireCourseProject,
      gateway,
      policiesFor,
      outputRootsFor,
      logger,
    }),
    defineProjectInitTool({
      resolveProject,
      gateway,
      // The one deliberate exception: initialising the project is how a workspace *becomes* a
      // Professor academic folder, so this call is given write access to the workspace it creates
      // the project in. It stays create-only and never rewrites an existing document.
      policiesFor: (projectRoot) => policiesFor(projectRoot, [], { bound: true }),
      logger,
    }),
    defineCourseListTool({
      resolveProject,
      gateway,
    }),
    defineCourseManageTool({
      resolveProject: requireCourseProject,
      gateway,
      policiesFor,
      outputRootsFor,
      logger,
    }),
    defineSessionBindTool({
      onBindingChanged: (agent, signal) => sessionMemory.refreshAgent(agent, signal),
      resolveProject: requireCourseProject,
      gateway,
      policiesFor,
      logger,
    }),
    // Onboarding (Phase 3). `discover` resolves leniently — it is how a course-free session starts
    // connecting a folder — while `confirm` and `rebuild` are strict, because both mutate state
    // that only exists inside a connected folder.
    defineWorkspaceDiscoverTool({ resolveProject, onboarding }),
    defineWorkspaceConfirmTool({ onboarding }),
    defineWorkspaceRebuildTool({ onboarding }),
    defineSessionStatusTool({
      resolveProject: requireCourseProject,
      gateway,
    }),
    defineExtractTool({
      resolveProject: requireCourseProject,
      gateway,
      policiesFor,
      capabilities,
      run: extraction.run,
      ensureProbed: extraction.ensureProbed,
      logger,
    }),
    defineSearchTool({
      resolveProject: requireCourseProject,
      gateway,
    }),
    defineMaterialReadTool({
      resolveProject,
      gateway,
      policiesFor,
      capabilities,
      run: extraction.run,
      render: extraction.render,
      enhance: enhancement.run,
      runtimeFor: materialRuntime.runtimeFor,
      ensureProbed: extraction.ensureProbed,
      ledger: materialLedger,
      ctx,
      logger,
      telemetry,
      ...(config.materialReadBudget === undefined ? {} : { budget: config.materialReadBudget }),
    }),
    defineStateReadTool({
      resolveProject: requireCourseProject,
      gateway,
      telemetry,
    }),
    defineStateUpdateTool({
      resolveProject: requireCourseProject,
      gateway,
      policiesFor,
      outputRootsFor,
      logger,
    }),
    defineArtifactCreateTool({
      resolveProject: requireCourseProject,
      gateway,
      policiesFor,
      outputRootsFor,
      logger,
    }),
    defineArtifactStatusTool({
      resolveProject: requireCourseProject,
      gateway,
    }),
    defineLatexCompileTool({
      resolveProject: requireCourseProject,
      gateway,
      runner,
      policiesFor,
      outputRootsFor,
      logger,
    }),
    // Memory tools resolve leniently (`resolveProject`): course-scope calls report an unbound
    // workspace as a structured problem, while global/control scope works in any session.
    defineMemoryStatusTool({ store: memoryStore }),
    defineMemoryReadTool({
      store: memoryStore,
      resolveProject,
      gateway,
    }),
    defineMemoryUpdateTool({
      store: memoryStore,
      resolveProject,
      gateway,
      onMemoryChanged: () => sessionMemory.refreshAll(),
      logger,
    }),
  ]

  for (const tool of tools) ctx.tools.register(tool)
  logger.info(`registered ${tools.length} tools (${tools.map((tool) => tool.name.replace(/^professor_/, '')).join(', ')})`)

  // Memory hydration listens for agent lifecycle events; a host without agent events still gets
  // the tools, only the automatic prompt section is absent (logged once by `attach`).
  sessionMemory.attach(ctx)
}
