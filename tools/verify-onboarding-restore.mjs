/**
 * Fresh-process restart probe — the "shut down and come back" half of Phase 3 acceptance.
 *
 * Why a separate process
 * ----------------------
 * Nothing inside one process can tell "the connection was persisted" apart from "the handle is still
 * in memory". Only a **new process** booting the same `DSH_HOME` answers the question the brief
 * actually asks: after the host restarts, does Professor still know which academic folder the user
 * connected, and does it still treat it as connected?
 *
 * It boots the real Harness from the **installed** package (never the source checkout), mounts the
 * preset, and then:
 *
 *   - reports the tool surface it mounted, so the parent can check the Phase 3 trio survives packaging;
 *   - reads `professor_diagnostics`, whose `project` and `workspace` blocks are the runtime's own
 *     answer about the connection and the four readiness states;
 *   - calls `professor_workspace_discover` with **no folder argument**, which is the real proof: the
 *     only way it can name the folder is by reading the persisted connection record;
 *   - calls `professor_workspace_confirm` with a deliberately stale `expected_revision`, which must be
 *     refused — a conflict applies nothing, so this proves the revision survived *without* mutating
 *     the restored state;
 *   - writes one global preference through the plugin's own storage, so the parent can prove this
 *     process wrote to the medium rather than only reading it.
 *
 * Inputs come from the environment (`PROFESSOR_*`), so the parent controls isolation without
 * command-line parsing. The result is printed as a single `PROFESSOR_ONBOARDING_JSON {...}` line.
 *
 * @module dsh-professor-spike/tools/verify-onboarding-restore
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  attachSession, bootProfessorProfile, executeTool, findProfessorScope, resultJson, visibleTools,
} from './packaged-profile.mjs'

const HOME = process.env.PROFESSOR_HOME
const PROFILE = process.env.PROFESSOR_PROFILE
const WORKSPACE = process.env.PROFESSOR_WORKSPACE
const INSTALLED_DIR = process.env.PROFESSOR_INSTALLED_DIR
const EXPECTED_FOLDER = process.env.PROFESSOR_EXPECTED_FOLDER
const RESTART_KEY = process.env.PROFESSOR_RESTART_KEY ?? 'onboarding_restart_probe'
const RESTART_VALUE = process.env.PROFESSOR_RESTART_VALUE ?? 'written-by-child'

const report = { ok: false, stage: 'start', errors: [] }
const fail = (stage, message) => {
  report.stage = stage
  report.errors.push(message)
  console.log(`PROFESSOR_ONBOARDING_JSON ${JSON.stringify(report)}`)
  process.exit(1)
}

if (HOME === undefined || PROFILE === undefined || WORKSPACE === undefined
  || INSTALLED_DIR === undefined || EXPECTED_FOLDER === undefined) {
  fail('arguments', 'PROFESSOR_HOME, PROFESSOR_PROFILE, PROFESSOR_WORKSPACE, PROFESSOR_INSTALLED_DIR and PROFESSOR_EXPECTED_FOLDER are all required')
}

process.env.DSH_HOME = HOME
process.env.DSH_TELEMETRY_DISABLED = '1'

let ctx
try {
  report.stage = 'boot'
  // The installed copy of this package is what runs — proving the artefact, not the checkout.
  const onboardingModule = await import(pathToFileURL(path.join(INSTALLED_DIR, 'src/workspace/onboarding.js')).href)
  report.moduleSourceFile = pathToFileURL(path.join(INSTALLED_DIR, 'src/workspace/onboarding.js')).pathname

  const booted = await bootProfessorProfile({ home: HOME, profileName: PROFILE, workspace: WORKSPACE })
  ctx = booted.ctx
  report.layers = booted.layers

  const scope = await findProfessorScope(ctx)
  if (scope === undefined) fail('boot', 'the professor preset is not mounted in this composition')
  const toolNames = visibleTools(ctx, scope)
  report.toolCount = toolNames.length
  report.professorToolCount = toolNames.filter(name => name.startsWith('professor_')).length
  report.onboardingTools = [
    onboardingModule.WORKSPACE_DISCOVER_TOOL_NAME,
    onboardingModule.WORKSPACE_CONFIRM_TOOL_NAME,
    onboardingModule.WORKSPACE_REBUILD_TOOL_NAME,
  ].filter((name) => toolNames.includes(name))

  const { agent } = attachSession({ ctx, scope, workspace: WORKSPACE })
  const call = async (name, args) => {
    const result = await executeTool({
      ctx,
      agent,
      name,
      args,
      label: `restart-${name}`,
    })
    return { result, payload: resultJson(result), isError: result.isError === true }
  }

  // --- the runtime's own answer about the connection -------------------------------------------
  report.stage = 'diagnostics'
  const diagnostics = await call('professor_diagnostics', {})
  if (diagnostics.isError === true || diagnostics.payload === null) {
    fail('diagnostics', 'professor_diagnostics did not return a structured payload')
  }
  const workspaceBlock = diagnostics.payload.workspace ?? {}
  report.connected = diagnostics.payload.project?.bound === true
  report.connectionPresent = workspaceBlock.connection?.present === true
  report.connectionSupported = workspaceBlock.connection?.supported === true
  report.connectionVersion = workspaceBlock.connection?.version ?? null
  report.recordedFolder = workspaceBlock.connection?.active?.folder ?? null
  report.recordedRevision = workspaceBlock.connection?.active?.revision ?? null
  report.historyLength = workspaceBlock.connection?.history_length ?? null
  report.readinessSaved = workspaceBlock.readiness?.configuration?.saved === true
  report.readinessIndexComplete = workspaceBlock.readiness?.index?.complete === true
  report.readinessExtractionComplete = workspaceBlock.readiness?.extraction?.complete === true
  report.readinessSearchable = workspaceBlock.readiness?.searchable === true

  // --- discovery with no folder argument: only the record can name the folder -------------------
  report.stage = 'discover'
  const discovery = await call(onboardingModule.WORKSPACE_DISCOVER_TOOL_NAME, {})
  if (discovery.isError === true || discovery.payload === null) {
    fail('discover', 'professor_workspace_discover did not return a structured payload')
  }
  report.discoverOk = discovery.payload.ok === true
  report.discoverSource = discovery.payload.folder?.source ?? null
  report.discoverFolder = discovery.payload.folder?.canonical ?? null
  report.proposalHasCourses = (discovery.payload.proposal?.candidates ?? []).some((entry) => (
    entry.kind === 'course' && entry.proposed?.course_code === 'CSC3200'
  ))

  // --- a stale revision must be refused, and a refusal applies nothing --------------------------
  report.stage = 'conflict'
  if (discovery.payload.proposal !== null) {
    const conflict = await call(onboardingModule.WORKSPACE_CONFIRM_TOOL_NAME, {
      proposal: discovery.payload.proposal,
      selections: [{ relative_path: 'CSC3200', action: 'include' }],
      expected_revision: 0,
    })
    report.conflictCode = conflict.payload?.code ?? null
    report.conflictApplied = conflict.payload?.applied === true
  }

  // --- write through the medium, so the parent can prove this process wrote ---------------------
  report.stage = 'write'
  const observed = await call('professor_memory_read', { scope: 'global' })
  const write = await call('professor_memory_update', {
    scope: 'global',
    action: 'set_preference',
    key: RESTART_KEY,
    value: RESTART_VALUE,
    evidence: 'explicit-stable',
    expected_revision: observed.payload?.revision,
  })
  report.preferenceWritten = write.payload?.written === true

  report.stage = 'done'
} catch (error) {
  report.errors.push(`${report.stage}: ${error?.message ?? String(error)}`)
} finally {
  if (ctx !== undefined) await ctx.fiber.dispose().catch(() => {})
}

report.ok = report.errors.length === 0
  && report.connected === true
  && report.conflictApplied === false
  && report.preferenceWritten === true
console.log(`PROFESSOR_ONBOARDING_JSON ${JSON.stringify(report)}`)
process.exit(report.ok ? 0 : 1)
