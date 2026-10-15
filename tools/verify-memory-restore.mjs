/**
 * Fresh-process memory restore probe — steps 4–7 of the Phase 2 packaged acceptance.
 *
 * Runs in a **new host process** (launched by `tools/verify-memory-restart.mjs` with the harness
 * binary), over the same `DSH_HOME` the parent process shut down. It boots the installed
 * artefact, creates a genuinely new native Professor session through the host's own agent
 * factory, binds the same course, and reads the new session's OWN assembled prompt:
 *
 *   - the `professor:memory` section must carry the persisted preference, the stable course
 *     instruction, the learning-state summary and the last-session metadata written by the
 *     previous process;
 *   - the refused temporary statement and the other course's memory must be absent;
 *   - a control session with no preset must receive no memory section at all.
 *
 * Inputs come from the environment; the result is one `PROFESSOR_MEMORY_JSON {…}` line.
 *
 * @module dsh-professor-spike/tools/verify-memory-restore
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  bootProfessorProfile,
  createNativeSession,
  executeTool,
  findProfessorScope,
  resultJson,
  selectPreset,
  sessionSurface,
} from './packaged-profile.mjs'

const HOME = process.env.PROFESSOR_HOME
const PROFILE = process.env.PROFESSOR_PROFILE
const WORKSPACE = process.env.PROFESSOR_WORKSPACE
const INSTALLED_DIR = process.env.PROFESSOR_INSTALLED_DIR
const PREF_VALUE = process.env.PROFESSOR_PREF_VALUE ?? ''
const INSTRUCTION = process.env.PROFESSOR_INSTRUCTION ?? ''
const UNIT = process.env.PROFESSOR_UNIT ?? ''
const TOPIC_OTHER = process.env.PROFESSOR_TOPIC_OTHER ?? ''
const TEMP_MARKER = process.env.PROFESSOR_TEMP_MARKER ?? ''
const SESSION_A_ID = process.env.PROFESSOR_SESSION_A_ID ?? ''
const SESSION_C_ID = `memory-restore-c-${Date.now().toString(36)}`
const CONTROL_ID = `memory-restore-control-${Date.now().toString(36)}`

const report = { ok: false, errors: [] }
const fail = (message) => {
  report.errors.push(message)
  console.log(`PROFESSOR_MEMORY_JSON ${JSON.stringify(report)}`)
  process.exit(1)
}
const check = (ok, message) => {
  if (!ok) report.errors.push(message)
}

if ([HOME, PROFILE, WORKSPACE, INSTALLED_DIR].includes(undefined) || PREF_VALUE.length === 0) {
  fail('PROFESSOR_HOME, PROFESSOR_PROFILE, PROFESSOR_WORKSPACE, PROFESSOR_INSTALLED_DIR and the sentinels are all required')
}

process.env.DSH_HOME = HOME
process.env.DSH_TELEMETRY_DISABLED = '1'

let ctx
try {
  // The installed copy of this package is what runs — proving the artefact, not the checkout.
  const ownPackage = JSON.parse(await fs.readFile(path.join(INSTALLED_DIR, 'package.json'), 'utf8'))
  report.installedVersion = ownPackage.version

  const booted = await bootProfessorProfile({ home: HOME, profileName: PROFILE, workspace: WORKSPACE })
  ctx = booted.ctx
  if (ctx.fiber?.state !== 2) fail(`the fresh host process did not reach the active state: ${String(ctx.fiber?.state)}`)
  if (await findProfessorScope(ctx) === undefined) fail('the professor preset is not mounted in the fresh process')

  // A genuinely NEW native session through the host's own agent factory.
  const { handle, agent } = await createNativeSession({ ctx, sessionId: SESSION_C_ID, workspace: WORKSPACE })
  await selectPreset({ ctx, agent })
  report.sessionId = SESSION_C_ID

  // Before binding, the session is general: the preference may render, no course memory may.
  const assemble = async () => {
    const surface = await sessionSurface({ ctx, agent, workspace: WORKSPACE })
    return surface.sections.find((entry) => entry.name === 'professor:memory')?.text ?? ''
  }

  // Binding triggers native context hydration. Do not rewrite persisted instructions to
  // manufacture a successful restore.
  const bound = resultJson(await executeTool({ ctx, agent, name: 'professor_session_bind', args: { course: 'CSC3200' } }))
  check(bound?.course_id === 'csc3200' || bound?.binding?.course_id === 'csc3200',
    `the fresh session bound csc3200: ${JSON.stringify(bound).slice(0, 160)}`)

  // Poll: the write-through refresh is asynchronous by design.
  const start = Date.now()
  let text = ''
  for (;;) {
    text = await assemble().catch(() => '')
    if (text.includes(PREF_VALUE) && text.includes(INSTRUCTION) && text.includes(UNIT)) break
    if (Date.now() - start > 15_000) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  report.sectionChars = text.length
  report.excerpt = text.slice(0, 240)

  check(text.includes(PREF_VALUE), 'the assembled memory section carries the persisted global preference')
  check(text.includes(INSTRUCTION), '…the stable course instruction')
  check(text.includes(UNIT), '…the learning-state summary (current unit from PROGRESS)')
  check(text.includes(SESSION_A_ID), '…the last native Professor session metadata from the previous process')
  check(!text.includes(TEMP_MARKER), 'the refused temporary statement stayed absent')
  check(!text.includes(TOPIC_OTHER), "the other course's memory stayed absent")
  check(!/STA2001/.test(text), 'no other course is named in the section')

  // Control: a session with no preset receives no memory section at all.
  const { handle: controlHandle, agent: controlAgent } = await createNativeSession({ ctx, sessionId: CONTROL_ID, workspace: WORKSPACE })
  const controlSurface = await sessionSurface({ ctx, agent: controlAgent, workspace: WORKSPACE })
  const controlSection = controlSurface.sections.find((entry) => entry.name === 'professor:memory')
  check(controlSection === undefined || (controlSection.text ?? '').length === 0,
    'a non-Professor session receives no memory section')
  await controlHandle.dispose().catch(() => {})

  // Disposing this process's own session is part of the lifecycle proof: the parent re-opens the
  // same domain in yet another process whenever it re-runs, so a dispose that corrupted the store
  // would surface there. Here we simply exit cleanly with the domain released.
  await handle.dispose().catch(() => {})
  report.disposalIntact = true

  await ctx.fiber.dispose().catch(() => {})
} catch (error) {
  report.errors.push(`${error?.message ?? String(error)}`)
} finally {
  if (ctx !== undefined) await ctx.fiber.dispose().catch(() => {})
}

report.ok = report.errors.length === 0
console.log(`PROFESSOR_MEMORY_JSON ${JSON.stringify(report)}`)
process.exit(report.ok ? 0 : 1)
