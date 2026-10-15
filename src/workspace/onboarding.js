/**
 * Academic-folder onboarding: discovery, confirmation, persistence and derived indexing.
 *
 * This is the **backend** a thin Settings UI (Phase 4/6) calls. It exists so that connecting an
 * academic folder never requires editing YAML or importing a legacy registry: a caller discovers,
 * shows the proposal to a human, and applies what the human confirmed.
 *
 * ## The four states a caller must be able to tell apart
 *
 * The brief is explicit that "connected" is ambiguous, so {@link buildReadiness} reports them
 * separately rather than collapsing them into one boolean:
 *
 * | state | field |
 * |---|---|
 * | configuration saved | `readiness.configuration.saved` |
 * | index complete | `readiness.index.complete` |
 * | extraction complete | `readiness.extraction.complete` |
 * | material searchable | `readiness.searchable` |
 *
 * plus `readiness.partial` naming everything that is not complete and `readiness.retry`, which
 * names the tool that safely retries the derived work (`professor_workspace_rebuild`). A confirmed
 * configuration is **never** rolled back because indexing failed: the user's decision is preserved
 * and the derived state is reported as partial.
 *
 * ## What is deliberately not here
 *
 * - **No second registry and no second index.** Courses are registered through
 *   `src/courses/registry.js` into the same `.professor/project.yaml`, and indexing/extraction
 *   reuse `runIndexSync` / `runExtraction` — the exact services the tools expose.
 * - **No source mutation.** Onboarding writes only `project.yaml`, `.professor/indexes/**` and one
 *   record in the plugin's own application storage. Originals are never renamed, moved or rewritten.
 * - **No learning state.** A confirmation produces configuration and derived indexes only; it never
 *   manufactures `PROGRESS.md` or infers progress from file presence.
 * - **No watcher.** Incremental work is an explicit, on-demand comparison of fs versions and content
 *   hashes. Calling a full scan a "watcher" would overstate what is implemented.
 *
 * @module dsh-professor-spike/src/workspace/onboarding
 */

import path from 'node:path'

import { listCourses, registerCourse } from '../courses/registry.js'
import {
  defaultProject, loadProject, PROJECT_SCHEMA_VERSION, saveProject,
} from '../project/project.js'
import { resolveExcludePaths } from '../indexer/exclude.js'
import { jsonOutput, NO_PARAMETERS, oneOfTypes } from '../tools/support.js'
import { buildProposal, normalizeScanLimits, scanFolder, validateProposal } from './detect.js'
import { deriveMaterialRules } from './materials.js'

/** Application-storage key of the workspace connection record. */
export const WORKSPACE_CONNECTION_KEY = 'workspace:connection'

/** Schema tag of the connection record. A bump requires an explicit migration. */
export const WORKSPACE_RECORD_SCHEMA = 'professor.workspace/1'

/** Recorded owner, so a stray record in the shared `professor_app` medium can be attributed. */
export const WORKSPACE_OWNER = 'dsh-professor-spike'

/** Tool names. Exported so a verifier never hardcodes a string that could drift. */
export const WORKSPACE_DISCOVER_TOOL_NAME = 'professor_workspace_discover'
export const WORKSPACE_CONFIRM_TOOL_NAME = 'professor_workspace_confirm'
export const WORKSPACE_REBUILD_TOOL_NAME = 'professor_workspace_rebuild'

/** Stable domain codes. A caller branches on these, never on a message. */
export const ONBOARDING_CODES = Object.freeze({
  FOLDER_MISSING: 'PROFESSOR_ONBOARDING_FOLDER_MISSING',
  FOLDER_NOT_APPROVED: 'PROFESSOR_ONBOARDING_FOLDER_NOT_APPROVED',
  STALE: 'PROFESSOR_ONBOARDING_STALE',
  INVALID_PROPOSAL: 'PROFESSOR_ONBOARDING_INVALID_PROPOSAL',
  CONFLICT: 'PROFESSOR_ONBOARDING_CONFLICT',
  DECISION_REQUIRED: 'PROFESSOR_ONBOARDING_DECISION_REQUIRED',
  CONNECTION_UNSUPPORTED: 'PROFESSOR_WORKSPACE_CONNECTION_UNSUPPORTED',
  FAILED: 'PROFESSOR_ONBOARDING_FAILED',
})

/** Term recorded when a folder path names no term. Never invented, and visible as unspecified. */
export const UNSPECIFIED_TERM = 'unspecified'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)

/** Turn a folder name into a kebab-case project id (or the documented fallback). */
function projectIdFor(canonicalFolder) {
  const slug = String(path.basename(canonicalFolder) ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'professor-project'
}

/** Render any thrown value as one actionable line, keeping the domain code when there is one. */
function describeFsError(error) {
  const code = error?.code ?? null
  const message = String(error?.message ?? error ?? 'unknown error')
  return code === null ? message : `${code}: ${message}`
}

/** The identity a candidate should be registered under, or `null` when it is still a question. */
function identityFor(candidate, selection) {
  const code = nonEmpty(selection?.course_code) ?? nonEmpty(candidate?.proposed?.course_code)
  if (code === null) return null
  return {
    course_code: code,
    display_name: nonEmpty(selection?.display_name) ?? nonEmpty(candidate?.proposed?.display_name) ?? code,
    term: nonEmpty(selection?.term) ?? nonEmpty(candidate?.proposed?.term) ?? UNSPECIFIED_TERM,
  }
}

/**
 * Build the readiness block.
 *
 * @param options.projectRoot - the connected folder.
 * @param options.configurationSaved - whether `project.yaml` was written this run.
 * @param options.courseCount - registered courses after the run.
 * @param options.index - `{ complete, ...counts }` or `{ complete: false, error }`.
 * @param options.extraction - `{ complete, searchable, ...counts }` or `{ complete: false, error }`.
 * @returns the readiness block described in the module header.
 */
export function buildReadiness(options) {
  const {
    projectRoot, configurationSaved, courseCount, index, extraction,
  } = options
  const partial = []
  if (index?.complete !== true) partial.push(`index: ${index?.error ?? 'not built'}`)
  if (extraction?.complete !== true) partial.push(`extraction: ${extraction?.error ?? 'not run'}`)
  const searchable = index?.complete === true && extraction?.searchable === true
  if (index?.complete === true && extraction?.complete === true && searchable !== true) {
    partial.push('search: extraction produced no chunk store, so nothing is searchable yet')
  }
  return {
    configuration: {
      saved: configurationSaved === true,
      project_root: projectRoot,
      courses: courseCount,
      path: path.join(projectRoot, '.professor', 'project.yaml'),
    },
    index: index ?? { complete: false, error: 'not attempted' },
    extraction: extraction ?? { complete: false, error: 'not attempted' },
    searchable,
    states: {
      configuration: configurationSaved === true ? 'saved' : 'not-saved',
      index: index?.complete === true ? 'complete' : 'failed',
      extraction: extraction?.complete === true ? 'complete' : 'failed',
      searchable: searchable === true ? 'searchable' : 'not-searchable',
    },
    partial,
    retry: partial.length > 0 ? WORKSPACE_REBUILD_TOOL_NAME : null,
  }
}

/**
 * Create the onboarding service for one plugin instance.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.resolveProject - lenient resolver (`async (exec) => { root, source, bound, reason }`).
 * @param options.requireProject - strict resolver; throws `PROFESSOR_PROJECT_MISSING` when unbound.
 * @param options.policiesFor - `(projectRoot, outputRoots) => { read, write }`.
 * @param options.outputRootsFor - `(document) => string[]`.
 * @param options.runIndex - `async ({ projectRoot, rebuild, session, signal }) => payload`.
 * @param options.runExtract - `async ({ projectRoot, rebuild, session, signal }) => payload`.
 * @param options.appStorage - Professor application storage handle (optional).
 * @param options.logger - plugin logger.
 * @param options.now - injectable clock (tests).
 * @returns `{ discover, confirm, rebuild, readConnection, readiness }`.
 */

/**
 * Read the workspace connection record from application storage.
 *
 * Module-level — and therefore reusable by Professor Home — because a second copy of this
 * validation would be a second copy that can drift: this is the one place that decides whether a
 * stored record is *understood*, and every reader must answer the same way (an unsupported schema
 * is reported, never rewritten, by any caller).
 *
 * @param appStorage - an application-storage handle (or any facet of the shared owner).
 * @returns `{ present, supported, record, unavailable, version? }`.
 */
export async function readConnectionRecord(appStorage) {
  if (appStorage === undefined) {
    return { present: false, supported: true, record: null, unavailable: 'application storage is not wired into this call' }
  }
  let status
  try {
    status = await appStorage.ensureOpen()
  } catch (error) {
    return { present: false, supported: true, record: null, unavailable: describeFsError(error) }
  }
  if (status?.status !== 'open') {
    return { present: false, supported: true, record: null, unavailable: status?.reason ?? 'application storage is unavailable' }
  }
  const table = appStorage.table('app')
  if (table === undefined || typeof table.get !== 'function') {
    return { present: false, supported: true, record: null, unavailable: 'application storage exposed no usable table' }
  }
  const raw = table.get(WORKSPACE_CONNECTION_KEY)
  if (raw === undefined || raw === null) return { present: false, supported: true, record: null, unavailable: null }
  const validConnection = isPlainObject(raw) && raw.schema === WORKSPACE_RECORD_SCHEMA
    && isPlainObject(raw.active) && typeof raw.active.folder === 'string' && path.isAbsolute(raw.active.folder)
    && Number.isInteger(raw.active.revision) && raw.active.revision >= 1
    && Array.isArray(raw.history) && raw.history.every(entry => isPlainObject(entry)
      && typeof entry.folder === 'string' && path.isAbsolute(entry.folder))
  if (!validConnection) {
    return {
      present: true,
      supported: false,
      record: raw,
      unavailable: null,
      version: isPlainObject(raw) ? raw.schema ?? null : null,
    }
  }
  return { present: true, supported: true, record: raw, unavailable: null }
}

export function createWorkspaceOnboarding(options) {
  const {
    gateway, resolveProject, requireProject, policiesFor, outputRootsFor,
    runIndex, runExtract, appStorage, logger, now = () => new Date().toISOString(),
  } = options

  /**
   * Serialise mutations inside this plugin instance.
   *
   * Onboarding mutates the project registry and the derived indexes, so two overlapping
   * confirmations must not interleave (read-modify-write on `project.yaml`, and a second
   * `createIfAbsent` that cannot tell a lost race from a real conflict). The chain is
   * per-instance and never rejects, so one failed confirmation cannot poison the next.
   */
  let tail = Promise.resolve()
  const serialize = (work) => {
    const run = tail.then(work, work)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Read the workspace connection record without ever rewriting an unsupported one. */
  const readConnection = () => readConnectionRecord(appStorage)

  /** Write the connection record, appending the previous folder to `history` rather than losing it. */
  async function writeConnection({ folder, projectId, previous }) {
    const existing = await readConnection()
    const history = Array.isArray(existing.record?.history) ? [...existing.record.history] : []
    const previousActive = isPlainObject(existing.record?.active) ? existing.record.active : null
    const sameFolder = previousActive !== null && previousActive.folder === folder
    if (previous !== null && previous !== folder) {
      history.push({
        folder: previous,
        project_id: previousActive?.project_id ?? null,
        disconnected_at: now(),
        reason: 'folder-change',
      })
    }
    const record = {
      schema: WORKSPACE_RECORD_SCHEMA,
      owner: WORKSPACE_OWNER,
      updated_at: now(),
      active: {
        folder,
        project_id: projectId,
        connected_at: sameFolder ? previousActive?.connected_at ?? now() : now(),
        revision: (Number.isInteger(previousActive?.revision) ? previousActive.revision : 0) + 1,
      },
      history,
    }
    await appStorage.writeRecord(WORKSPACE_CONNECTION_KEY, record)
    return record
  }

  /** Canonical paths inside the folder that must never be treated as course material. */
  async function exclusionsFor(projectRoot, signal) {
    const loaded = await loadProject({ gateway, projectRoot, signal }).catch(() => null)
    const usable = loaded !== null
      && loaded.present === true
      && loaded.document !== null
      && loaded.unsupported === null
      && (loaded.problems ?? []).length === 0
    return resolveExcludePaths({
      gateway, projectRoot, document: usable ? loaded.document : null, signal,
    })
  }

  /** Resolve a folder spelling to its canonical path and whether it really is a directory. */
  async function resolveFolder({ folder, cwd, signal }) {
    const target = await gateway.resolveTarget(folder, { cwd, signal })
    const canonical = gateway.canonical(target)
    const info = await gateway.stat(target, signal).catch(() => undefined)
    return { target, canonical, isDirectory: info?.type === 'directory', info }
  }

  // --- discovery -----------------------------------------------------------------

  async function discover(args = {}, exec) {
    const signal = exec?.signal
    const cwd = exec?.agent?.session?.header?.cwd
    const warnings = []
    const requested = nonEmpty(args.folder)

    const connection = await readConnection()
    if (connection.unavailable !== null) {
      warnings.push(`the workspace connection record could not be read: ${connection.unavailable}`)
    }
    if (connection.present && connection.supported !== true) {
      warnings.push(
        `the stored workspace connection uses schema ${JSON.stringify(connection.version)}, which this plugin `
        + `does not support (it understands ${WORKSPACE_RECORD_SCHEMA}); the record is reported as-is and never rewritten`,
      )
    }

    let folder = requested
    let folderSource = requested === null ? null : 'argument'
    if (folder === null) {
      const recorded = connection.supported === true ? nonEmpty(connection.record?.active?.folder) : null
      if (recorded !== null) {
        folder = recorded
        folderSource = 'connection'
      }
    }
    if (folder === null) {
      // No folder argument and no recorded connection: fall back to this session's workspace.
      //
      // This one case deliberately *propagates* rather than being reported as a folder finding. "The
      // folder you named does not exist" is a recoverable discovery result; "this call carries no
      // conversation workspace at all" is a caller error, and every other course-owned tool refuses
      // it the same way. Reporting it as `PROFESSOR_ONBOARDING_FOLDER_MISSING` would dress up a
      // programming mistake as a user-facing condition — and would let a rootless call look like a
      // successful scan of nothing.
      const project = await resolveProject(exec)
      folder = project.root
      folderSource = project.source
    }

    const fromConnection = folderSource === 'connection'
    const recordedCanonical = fromConnection ? nonEmpty(connection.record?.active?.folder) : null

    let resolved
    try {
      resolved = await resolveFolder({ folder, cwd, signal })
    } catch (error) {
      return {
        ok: false,
        code: ONBOARDING_CODES.FOLDER_MISSING,
        problems: [`the folder ${folder} could not be resolved: ${describeFsError(error)}`],
        proposal: null,
        folder: { requested: folder, canonical: null, source: folderSource },
        warnings,
      }
    }

    const folderInfo = {
      requested: folder,
      canonical: resolved.canonical,
      source: folderSource,
    }

    if (fromConnection && recordedCanonical !== null && resolved.canonical !== recordedCanonical) {
      return {
        ok: false,
        code: ONBOARDING_CODES.FOLDER_NOT_APPROVED,
        problems: [
          `the recorded academic folder ${folder} no longer resolves to the directory that was connected `
          + `(${recordedCanonical}); it now resolves to ${resolved.canonical}. Reconnect the folder explicitly `
          + 'instead of following a stale record.',
        ],
        proposal: null,
        folder: folderInfo,
        warnings,
      }
    }
    if (resolved.isDirectory !== true) {
      return {
        ok: false,
        code: ONBOARDING_CODES.FOLDER_MISSING,
        problems: [
          `the folder ${folder} does not exist or is not a directory`
          + (resolved.info === undefined ? '' : ` (found ${resolved.info.type})`),
        ],
        proposal: null,
        folder: folderInfo,
        warnings,
      }
    }

    const limits = normalizeScanLimits(args)
    const excludePaths = await exclusionsFor(resolved.canonical, signal)
    const scan = await scanFolder({
      gateway,
      target: resolved.target,
      root: resolved.canonical,
      limits,
      excludePaths,
      signal,
    })

    return {
      ok: true,
      code: null,
      proposal: buildProposal({ root: resolved.canonical, folderSource, scan }),
      folder: { ...folderInfo, excluded_paths: excludePaths },
      problems: [],
      warnings,
    }
  }

  // --- confirmation --------------------------------------------------------------

  /** A structured refusal that changed nothing. */
  const refused = (code, problems, extras = {}, warnings = []) => ({
    ok: false,
    applied: false,
    code,
    problems,
    warnings,
    ...extras,
  })

  async function confirmLocked(args, exec) {
    const proposal = args.proposal
    const signal = exec?.signal
    const session = exec?.agent?.session
    const cwd = session?.header?.cwd
    const warnings = []

    // (a) Re-read the folder and re-derive the proposal. This happens *before* anything is written,
    //     so a folder that changed (or was substituted) leaves the workspace untouched.
    const resolved = await resolveFolder({ folder: proposal.root, cwd, signal })
    if (resolved.isDirectory !== true) {
      return refused(ONBOARDING_CODES.FOLDER_NOT_APPROVED, [
        `the proposed folder ${proposal.root} is no longer a readable directory; nothing was applied`,
      ], {}, warnings)
    }

    const limits = normalizeScanLimits(proposal.scan?.limits ?? {})
    const excludePaths = await exclusionsFor(resolved.canonical, signal)
    const scan = await scanFolder({
      gateway,
      target: resolved.target,
      root: resolved.canonical,
      limits,
      excludePaths,
      signal,
    })
    const fresh = buildProposal({ root: resolved.canonical, folderSource: proposal.folder_source, scan })
    if (fresh.fingerprint !== proposal.fingerprint) {
      return refused(ONBOARDING_CODES.STALE, [
        'the folder changed between discovery and confirmation, so the proposal is no longer current and '
        + 'nothing was applied. Run professor_workspace_discover again and confirm the fresh proposal.',
      ], { expected_fingerprint: proposal.fingerprint, current_fingerprint: fresh.fingerprint }, warnings)
    }

    // (b) The connection record gates folder changes and blocks onboarding while it carries a schema
    //     this plugin must not touch.
    const connection = await readConnection()
    if (connection.unavailable !== null) {
      warnings.push(`the workspace connection record could not be read: ${connection.unavailable}`)
    }
    if (connection.present && connection.supported !== true) {
      return refused(ONBOARDING_CODES.CONNECTION_UNSUPPORTED, [
        `the stored workspace connection uses schema ${JSON.stringify(connection.version)}, which this plugin `
        + `does not support (it understands ${WORKSPACE_RECORD_SCHEMA}). Refusing to overwrite it: remove or `
        + 'migrate that record first.',
      ], {}, warnings)
    }

    const previousFolder = connection.supported === true ? nonEmpty(connection.record?.active?.folder) : null
    if (previousFolder !== null && previousFolder !== resolved.canonical && args.acknowledge_folder_change !== true) {
      return refused(ONBOARDING_CODES.DECISION_REQUIRED, [
        `${resolved.canonical} is a different academic folder from the connected one (${previousFolder}). `
        + 'Connecting it is a decision, not a side effect.',
      ], {
        requires_decision: {
          kind: 'folder_change',
          previous_folder: previousFolder,
          candidate_folder: resolved.canonical,
          question: `Connect ${resolved.canonical} and leave ${previousFolder} as it is?`,
          options: [
            'connect the new folder (call again with acknowledge_folder_change: true)',
            'keep the connected folder (do nothing)',
          ],
          consequence:
            'the previous folder keeps its configuration, its learning state, its notes and every original file; '
            + 'nothing is deleted, and switching back is the same decision in reverse',
        },
      }, warnings)
    }

    const expectedRevision = Number.isInteger(args.expected_revision) ? args.expected_revision : null
    if (expectedRevision !== null && connection.supported === true && connection.record !== null) {
      const current = Number.isInteger(connection.record?.active?.revision) ? connection.record.active.revision : 0
      if (current !== expectedRevision) {
        return refused(ONBOARDING_CODES.CONFLICT, [
          `another confirmation already applied (connection revision ${current}), so this one was applied against `
          + 'stale expectations and did nothing. Re-read the workspace state and retry.',
        ], { current_revision: current }, warnings)
      }
    }

    // (c) Build the project document. An existing document is preserved; only a newer schema stops us.
    const loaded = await loadProject({ gateway, projectRoot: resolved.canonical, signal })
    if (loaded.unsupported !== null) {
      return refused('PROFESSOR_PROJECT_UNSUPPORTED', loaded.problems, {}, warnings)
    }
    let document
    let created = false
    if (loaded.present) {
      if (loaded.document === null || (loaded.problems ?? []).length > 0) {
        return refused('PROFESSOR_PROJECT_INVALID', loaded.problems, {}, warnings)
      }
      document = loaded.document
    } else {
      document = defaultProject({
        id: projectIdFor(resolved.canonical),
        name: path.basename(resolved.canonical),
      })
      created = true
    }

    // (d) Apply the confirmed selections. Nothing is registered from an unconfirmed identity, and a
    //     course that is already registered is preserved rather than duplicated.
    const selections = new Map()
    for (const entry of (Array.isArray(args.selections) ? args.selections : [])) {
      if (!isPlainObject(entry)) continue
      const relativePath = nonEmpty(entry.relative_path)
      if (relativePath === null) continue
      selections.set(relativePath, {
        action: entry.action === 'exclude' ? 'exclude' : 'include',
        course_code: entry.course_code,
        display_name: entry.display_name,
        term: entry.term,
      })
    }

    const registered = []
    const preserved = []
    const pending = []
    const excluded = []

    for (const candidate of fresh.candidates) {
      const selection = selections.get(candidate.relative_path) ?? null
      if (selection !== null && selection.action === 'exclude') {
        const absolute = path.join(resolved.canonical, candidate.relative_path)
        // "Exclude" means what it says: the folder leaves the *source corpus*, not merely this
        // confirmation. It is recorded in the project's own `indexing.exclude` list — the documented
        // escape hatch that `resolveExcludePaths` already feeds to the indexer and to the discovery
        // scan — rather than a private list that the next `professor_index_sync` would ignore.
        const declared = Array.isArray(document.indexing?.exclude) ? document.indexing.exclude : []
        if (!declared.includes(absolute)) {
          document.indexing = { ...(document.indexing ?? {}), exclude: [...declared, absolute] }
        }
        excluded.push({
          relative_path: candidate.relative_path,
          name: candidate.proposed?.display_name ?? candidate.relative_path,
          path: absolute,
          reason: 'excluded by the user in this confirmation; recorded in indexing.exclude',
        })
        continue
      }
      // A high-confidence folder that the user simply did not mention is not registered, and is not
      // reported as pending either — silence is not a question.
      if (selection === null && candidate.needs_confirmation !== true) continue

      const identity = identityFor(candidate, selection)
      if (identity === null) {
        pending.push({
          relative_path: candidate.relative_path,
          name: candidate.proposed?.display_name ?? candidate.relative_path,
          proposed_course_code: candidate.proposed?.course_code ?? null,
          reason: [
            ...(Array.isArray(candidate.reasons) ? candidate.reasons : []),
            'supply course_code (and optionally display_name/term) in the selection to register this folder',
          ].join('; '),
        })
        continue
      }

      const absolute = path.join(resolved.canonical, candidate.relative_path)
      const existing = listCourses(document).find((course) => (
        String(course.course_code).toLowerCase() === identity.course_code.toLowerCase()
        && (String(course.term).toLowerCase() === identity.term.toLowerCase()
          || (identity.term === UNSPECIFIED_TERM && course.sources?.some(source =>
            path.resolve(resolved.canonical, source.path) === absolute)))
      ))
      if (existing !== undefined) {
        // Repeated connection preserves the user's course id, sources, outputs and status.
        preserved.push({
          course_id: existing.course_id,
          course_code: existing.course_code,
          term: existing.term,
          relative_path: candidate.relative_path,
          reason: 'already registered for this course code and term; left exactly as it is',
        })
        continue
      }

      const rules = deriveMaterialRules({
        sourcePath: absolute,
        names: Array.isArray(candidate.material_directories) ? candidate.material_directories : [],
        includeSupplementary: true,
      })
      try {
        const result = registerCourse(document, {
          course_code: identity.course_code,
          display_name: identity.display_name,
          term: identity.term,
          sources: [{
            path: absolute,
            ...(Object.keys(rules.categoryRules).length > 0 ? { category_rules: rules.categoryRules } : {}),
          }],
        })
        document = result.document
        registered.push({
          course_id: result.course.course_id,
          course_code: result.course.course_code,
          term: result.course.term,
          relative_path: candidate.relative_path,
          categories: Object.keys(rules.categoryRules),
        })
        for (const warning of result.warnings) warnings.push(`${candidate.relative_path}: ${warning}`)
      } catch (error) {
        warnings.push(`course ${identity.course_code} was not registered: ${describeFsError(error)}`)
      }
    }

    // (e) Persist the accepted configuration. From here on the user's decision exists on disk and is
    //     never rolled back because derived work failed.
    const policies = policiesFor(resolved.canonical, outputRootsFor(document))
    try {
      await saveProject({
        gateway,
        projectRoot: resolved.canonical,
        document,
        session,
        signal,
        writePolicy: policies.write,
        createOnly: created,
        expectedRaw: loaded.raw,
      })
    } catch (error) {
      const code = error?.code === 'FS_STALE_VERSION' || error?.code === 'FS_NOT_OBSERVED' || error?.code === 'PROFESSOR_PROJECT_EXISTS' || error?.code === 'PROFESSOR_PROJECT_STALE'
        ? ONBOARDING_CODES.CONFLICT
        : error?.code ?? ONBOARDING_CODES.FAILED
      return refused(code, [
        code === ONBOARDING_CODES.CONFLICT
          ? `project.yaml changed while this confirmation was running (${describeFsError(error)}); nothing was `
            + 'overwritten. Re-read the workspace state and retry.'
          : describeFsError(error),
      ], {}, warnings)
    }

    // (f) Derived state: index, then extraction. Each failure is reported, never hidden.
    // `force: true` is deliberate: confirming a folder is an explicit user action that may have
    // changed which files belong to which course, so the index is always re-derived here rather
    // than accepted as "verified unchanged". The unchanged short-circuit exists for routine calls
    // (a teaching request), not for the one call that just rewrote the configuration.
    let index
    try {
      const payload = await runIndex({ projectRoot: resolved.canonical, force: true, session, signal })
      index = {
        complete: true,
        total: payload.total,
        added: payload.added,
        changed: payload.changed,
        reused: payload.reused,
        missing: payload.missing,
        skipped: payload.skipped,
        excluded: payload.excluded,
        assigned: payload.assigned,
        unassigned: payload.unassigned,
      }
    } catch (error) {
      index = { complete: false, error: describeFsError(error) }
      warnings.push(`the file index could not be built: ${index.error}`)
    }

    let extraction = { complete: false, error: 'not attempted: the file index is not complete' }
    if (index.complete === true) {
      try {
        const payload = await runExtract({ projectRoot: resolved.canonical, session, signal })
        extraction = {
          complete: payload.failed === 0,
          processed: payload.processed,
          extracted: payload.extracted,
          reExtracted: payload.reExtracted,
          unsupported: payload.unsupported,
          failed: payload.failed,
          skipped: payload.skipped,
          chunks: payload.chunksWritten,
          searchable: payload.extracted + payload.skipped > 0,
          ...(payload.failed === 0 ? {} : { error: `${payload.failed} file(s) failed to extract` }),
        }
        if (payload.failed > 0) {
          warnings.push(`${payload.failed} file(s) failed to extract; run ${'professor_extract'} for the per-file reasons`)
        }
      } catch (error) {
        extraction = { complete: false, error: describeFsError(error) }
        warnings.push(`extraction could not run: ${extraction.error}`)
      }
    }

    // (g) Record the connection. A failure here is reported but does not undo the configuration.
    let connectionResult = null
    if (appStorage === undefined) {
      warnings.push('the workspace connection record was not saved: application storage is not wired into this call')
    } else {
      try {
        const record = await writeConnection({
          folder: resolved.canonical,
          projectId: document.project?.id ?? null,
          previous: previousFolder,
        })
        connectionResult = {
          previous_folder: previousFolder,
          active: record.active,
          history: record.history,
        }
      } catch (error) {
        warnings.push(`the workspace connection record could not be written: ${describeFsError(error)}`)
      }
    }

    const readiness = buildReadiness({
      projectRoot: resolved.canonical,
      configurationSaved: true,
      courseCount: listCourses(document).length,
      index,
      extraction,
    })

    logger?.info(
      `onboarding: ${registered.length} registered, ${preserved.length} preserved, ${pending.length} pending, `
      + `${excluded.length} excluded; index complete=${index.complete}, extraction complete=${extraction.complete}`,
    )

    return {
      ok: true,
      applied: true,
      code: null,
      projectRoot: resolved.canonical,
      project: {
        created,
        path: path.join(resolved.canonical, '.professor', 'project.yaml'),
        schema_version: document.schema_version ?? PROJECT_SCHEMA_VERSION,
      },
      courses: {
        registered, preserved, pending, excluded,
        total: listCourses(document).length,
      },
      index,
      extraction,
      readiness,
      connection: connectionResult,
      requires_decision: null,
      warnings,
      problems: [],
    }
  }

  async function confirm(args = {}, exec) {
    // A confirmation writes `project.yaml` and the derived index through the calling session's
    // policy seam, so a call with no conversation workspace is refused the same way every other
    // writing tool refuses it — before the proposal is even inspected.
    //
    // Note *which* resolver: it is the lenient one, and deliberately. `requireProject` would demand
    // an existing `.professor/`, but creating that file is exactly what this call does, so the
    // strict resolver would make onboarding impossible. What is required is a workspace, not an
    // already-initialised project.
    await resolveProject(exec)

    const validation = validateProposal(args?.proposal)
    if (!validation.ok) {
      return refused(ONBOARDING_CODES.INVALID_PROPOSAL, validation.errors)
    }
    return serialize(() => confirmLocked(args, exec).catch((error) => refused(
      error?.code ?? ONBOARDING_CODES.FAILED,
      [describeFsError(error)],
    )))
  }

  // --- explicit rebuild ----------------------------------------------------------

  async function rebuild(args = {}, exec) {
    const signal = exec?.signal
    const session = exec?.agent?.session
    const warnings = []
    return serialize(async () => {
      // Strict resolution, and the refusal propagates: a rebuild has nothing to re-derive without a
      // connected folder, and a course-free session must learn that rather than receive an empty
      // success. See the matching note in `discover`.
      const project = await requireProject(exec)

      // A rebuild re-derives only the indexes. Configuration, learning state, notes and originals are
      // untouched, and the rebuild flag is what makes this provable: every record is re-derived from
      // the source rather than reused.
      let index
      try {
        const payload = await runIndex({ projectRoot: project.root, rebuild: true, session, signal })
        const rederived = payload.added + payload.changed
        index = {
          complete: true,
          rebuilt: true,
          total: payload.total,
          added: payload.added,
          // A rebuild re-derives every record, so `changed` reports how many records this run rewrote
          // (with `reused: 0`). `rederived` is the same number under a name that says so.
          changed: rederived,
          rederived,
          reused: payload.reused,
          missing: payload.missing,
          skipped: payload.skipped,
          excluded: payload.excluded,
          assigned: payload.assigned,
          unassigned: payload.unassigned,
        }
      } catch (error) {
        index = { complete: false, error: describeFsError(error) }
        warnings.push(`the file index could not be rebuilt: ${index.error}`)
      }

      let extraction = { complete: false, error: 'not attempted: the file index is not complete' }
      if (index.complete === true) {
        try {
          const payload = await runExtract({
            projectRoot: project.root, rebuild: true, session, signal,
          })
          extraction = {
            complete: payload.failed === 0,
            rebuilt: true,
            processed: payload.processed,
            extracted: payload.extracted,
            reExtracted: payload.reExtracted,
            unsupported: payload.unsupported,
            failed: payload.failed,
            skipped: payload.skipped,
            chunks: payload.chunksWritten,
            searchable: payload.extracted + payload.skipped > 0,
            ...(payload.failed === 0 ? {} : { error: `${payload.failed} file(s) failed to extract` }),
          }
        } catch (error) {
          extraction = { complete: false, error: describeFsError(error) }
          warnings.push(`extraction could not run: ${extraction.error}`)
        }
      }

      const loaded = await loadProject({ gateway, projectRoot: project.root, signal })
      const courseCount = loaded.present && loaded.document !== null && loaded.unsupported === null
        && (loaded.problems ?? []).length === 0
        ? listCourses(loaded.document).length
        : null

      return {
        ok: index.complete === true && extraction.complete === true,
        code: index.complete === true && extraction.complete === true ? null : ONBOARDING_CODES.FAILED,
        projectRoot: project.root,
        index,
        extraction,
        readiness: buildReadiness({
          projectRoot: project.root,
          configurationSaved: loaded.present === true,
          courseCount,
          index,
          extraction,
        }),
        problems: [],
        warnings,
      }
    })
  }

  return {
    discover, confirm, rebuild, readConnection, buildReadiness,
  }
}

// --- tool definitions -----------------------------------------------------------

/** Declare the discovery tool. */
export function defineWorkspaceDiscoverTool(options) {
  const { resolveProject, onboarding } = options
  return {
    name: WORKSPACE_DISCOVER_TOOL_NAME,
    description: 'Discover the academic structure of a folder without changing anything: validate the folder, scan it read-only within explicit limits, and propose courses with a confidence, the reasons for each, the material directories found, and a fingerprint. High-confidence course codes (CSC3200, STA2001, PHY1001) are proposed; ambiguous folders (Algorithms, Math, Course A) are proposed as questions with no identity. Symlinks are never followed and unreadable directories are reported, not silently skipped. Nothing is written until a proposal is confirmed, and no .professor directory is created here.',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Absolute path of the academic folder. Defaults to the connected folder, then to this session\'s workspace.' },
        max_depth: { type: 'number', description: 'Maximum directory depth to scan (default 6, maximum 32).' },
        max_candidates: { type: 'number', description: 'Maximum candidates to propose (default 200).' },
        max_entries: { type: 'number', description: 'Maximum directory entries to visit (default 20000).' },
      },
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        code: oneOfTypes('string', 'null'),
        // Nullable, not merely optional: a discovery that was refused *does* report
        // `proposal: null`, and the host validates the value it receives against this schema.
        proposal: oneOfTypes('object', 'null'),
        folder: { type: 'object' },
        warnings: { type: 'array' },
        problems: { type: 'array' },
      },
      required: ['ok', 'code', 'proposal', 'folder', 'warnings', 'problems'],
    }),
    async execute(args = {}, exec) {
      return onboarding.discover(args, exec)
    },
  }
}

/** Declare the confirmation tool. */
export function defineWorkspaceConfirmTool(options) {
  const { onboarding } = options
  return {
    name: WORKSPACE_CONFIRM_TOOL_NAME,
    description: 'Apply a discovered proposal after the user has confirmed it: re-validate the folder against the proposal fingerprint (refusing a stale proposal), register only the selected courses with an explicit identity, leave ambiguous folders pending, preserve courses and outputs that already exist, save .professor/project.yaml, then build the initial file index and extract supported material. Reports four states separately (configuration saved, index complete, extraction complete, searchable) plus what is partial and the tool that safely retries it. A different academic folder requires an explicit decision (acknowledge_folder_change) and never deletes the previous folder\'s configuration, state or files. Refuses to overwrite a newer project or connection schema.',
    parameters: {
      type: 'object',
      properties: {
        proposal: { type: 'object', description: 'The proposal returned by professor_workspace_discover, unchanged.' },
        selections: { type: 'array', description: 'One entry per folder: { relative_path, action: "include" | "exclude", course_code?, display_name?, term? }. A folder of an ambiguous identity needs course_code to be registered.' },
        acknowledge_folder_change: { type: 'boolean', description: 'Connect a folder different from the connected one (default false: the call returns a decision instead).' },
        expected_revision: { type: 'number', description: 'Optional optimistic check against the connection revision; a mismatch is refused, never applied.' },
      },
      required: ['proposal'],
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        applied: { type: 'boolean' },
        code: oneOfTypes('string', 'null'),
        projectRoot: { type: 'string' },
        project: { type: 'object' },
        courses: { type: 'object' },
        index: { type: 'object' },
        extraction: { type: 'object' },
        readiness: { type: 'object' },
        connection: oneOfTypes('object', 'null'),
        requires_decision: oneOfTypes('object', 'null'),
        warnings: { type: 'array' },
        problems: { type: 'array' },
      },
      required: ['ok', 'applied', 'code', 'warnings', 'problems'],
    }),
    async execute(args = {}, exec) {
      return onboarding.confirm(args, exec)
    },
  }
}

/** Declare the rebuild tool. */
export function defineWorkspaceRebuildTool(options) {
  const { onboarding } = options
  return {
    name: WORKSPACE_REBUILD_TOOL_NAME,
    description: 'Re-derive the connected folder\'s derived indexes from scratch: re-hash every indexed file and re-extract every supported material, without touching project.yaml, learning state, notes, memory or any original file. Use it after a failed index or extraction, or when a result looks inconsistent. Rebuilds only derived data — memory is never disposable index data.',
    parameters: NO_PARAMETERS,
    output: jsonOutput({
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        code: oneOfTypes('string', 'null'),
        projectRoot: { type: 'string' },
        index: { type: 'object' },
        extraction: { type: 'object' },
        readiness: { type: 'object' },
        problems: { type: 'array' },
        warnings: { type: 'array' },
      },
      required: ['ok', 'code', 'warnings'],
    }),
    async execute(args = {}, exec) {
      return onboarding.rebuild(args, exec)
    },
  }
}
