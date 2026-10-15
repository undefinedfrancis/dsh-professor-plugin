/**
 * Phase 2 (M2) packaged acceptance — persistent Professor memory across a real host restart.
 *
 * The question this verifier answers is the one a same-process test cannot: after the host shuts
 * down, does a genuinely NEW native Professor session retrieve what the previous process
 * persisted — and only that?
 *
 * Parent process (this script), against the **installed** artefact in a disposable profile:
 *
 *   1. store a durable global preference (evidence `explicit-stable`) and a temporary statement
 *      that must be refused (never promoted);
 *   2. bind a course, write an evidence-gated learning result, a stable course instruction and a
 *      recent topic; write a *different* course's memory as the leak control;
 *   3. shut the host down (`ctx.fiber.dispose()`);
 *   4. boot a **fresh host process** (`tools/verify-memory-restore.mjs`, the shipped restore
 *      probe, run with the harness binary), which creates a new native Professor session, binds
 *      the same course and reads its OWN assembled prompt;
 *   5. the probe asserts the assembled `professor:memory` section carries the preference, the
 *      instruction, the learning summary and the last-session metadata — and that the temporary
 *      statement and the other course's memory are absent.
 *
 * Multi-session storage ownership (Phase 2 task 5) is proven here in the parent before the
 * restart: two native Professor sessions hydrate from the one shared store, and disposing the
 * first leaves the second's assembled memory intact. (The host's refusal of a concurrent second
 * `open()` of the same domain is proven by `verify-app-storage` / `verify-packaged-acceptance`.)
 *
 * Run with the harness Node (asar-aware) — see the `verify:memory-restart` script.
 *
 * @module dsh-professor-spike/tools/verify-memory-restart
 */

import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { promises as fs, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  HARNESS_BIN,
  createNativeSession,
  selectPreset,
  bootProfessorProfile,
  createProfessorProfile,
  executeTool as dispatchTool,
  findProfessorScope,
  resultJson,
  resultText,
  sessionSurface,
} from './packaged-profile.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_NAME = 'professor-memory-restart'

/** Stable sentinels: unique per run, natural language where the product surface is natural. */
const RUN = `${Date.now().toString(36)}`
const PREF_KEY = 'explanation_language'
const PREF_VALUE = `记忆恢复验收·中文讲解·restore-${RUN}`
const INSTRUCTION = `Prefer C++ examples. [memory-acceptance-${RUN}]`
const RECENT_TOPIC = `Hash Tables [memory-acceptance-${RUN}]`
const UNIT = `Unit 4 [memory-acceptance-${RUN}]`
const NEXT_STEP = `Practice open addressing [memory-acceptance-${RUN}]`
const OTHER_COURSE = 'STA2001'
const OTHER_TOPIC = `Conditional Probability [other-course-must-not-leak-${RUN}]`
const TEMP_MARKER = `temp-must-never-persist-${RUN}`
const SESSION_A_ID = `memory-acceptance-s1-${RUN}`
const SESSION_B_ID = `memory-acceptance-s2-${RUN}`

// --- scratch space and an isolated npm cache --------------------------------
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-memory-'))
const npmCache = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-memory-npm-'))
const childEnv = { ...process.env, npm_config_cache: npmCache }
let disposableHome
let hostContext

process.on('exit', () => {
  for (const directory of [temp, npmCache, disposableHome].filter(Boolean)) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // A leftover temp directory is not a failure; nothing useful can be done from an exit handler.
    }
  }
})

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 68 - title.length))}`)
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', env: childEnv, ...options })
const exists = (candidate) => fs.stat(candidate).then(() => true, () => false)
async function executeTool(options) {
  const result = await dispatchTool(options)
  if (result?.isError) throw new Error(`${options.name}: ${resultText(result)}`)
  return result
}

/** Poll a probe until it returns truthy — the write-through refresh is asynchronous by design. */
async function waitFor(label, probe, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await probe().catch(() => null)
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** The assembled `professor:memory` section text for one native agent (through the host's own assembler). */
async function memorySection(ctx, agent) {
  const surface = await sessionSurface({ ctx, agent, workspace: agent.session?.header?.cwd ?? '' })
  if (!surface.sections.some(entry => entry.name === 'professor:memory')) {
    throw new Error(`memory section not registered: ${surface.sections.map(entry => entry.name).join(', ')}`)
  }
  return surface.sections.find((entry) => entry.name === 'professor:memory')?.text ?? ''
}

try {
  // ─── 1–2. pack the artefact and install it into a disposable profile ──────
  section('1. pack the exact artefact')
  const packDir = path.join(temp, 'pack')
  await fs.mkdir(packDir, { recursive: true })
  const packed = JSON.parse(run('npm', ['pack', '--pack-destination', packDir, '--json'], { cwd: REPO }))
  check(Array.isArray(packed) && packed.length === 1, 'npm pack produced exactly one tarball')
  const tarball = path.join(packDir, packed[0].filename)

  section('2. install into a disposable profile and boot the real host')
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-professor-memory-')))
  disposableHome = home
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_DISABLED = '1'
  const workspace = path.join(home, 'workspace')
  await fs.mkdir(workspace, { recursive: true })
  console.log(`disposable Harness home: ${home}`)

  const { installedDir } = await createProfessorProfile({ home, profileName: PROFILE_NAME, tarball, run })
  check(await exists(path.join(installedDir, 'package.json')), 'the bundle is installed as a real directory', installedDir)

  const booted = await bootProfessorProfile({ home, profileName: PROFILE_NAME, workspace })
  const { ctx } = booted
  hostContext = ctx
  check(ctx.fiber?.state === 2, 'the composed tree reached the active state', String(ctx.fiber?.state))
  check(await findProfessorScope(ctx) !== undefined, 'the professor preset is mounted')

  // ─── steps 1–2 (parent): persist memory, learning state and the leak controls ─
  section('persist: preference, evidence-gated learning, course memory, controls')
  const { handle: handleA, agent: agentA } = await createNativeSession({ ctx, sessionId: SESSION_A_ID, workspace })
  await selectPreset({ ctx, agent: agentA })
  check(true, `native Professor session A created (${SESSION_A_ID})`)

  const initResult = await executeTool({ ctx, agent: agentA, name: 'professor_project_init', args: { project_id: 'memory-acceptance' } })
  const init = resultJson(initResult)
  if (initResult.isError || init?.created !== true) throw new Error(`project initialization failed: ${resultText(initResult)}`)
  check(init.created === true, 'the workspace became a bound academic folder')

  for (const [code, name] of [['CSC3200', 'Data Structures'], [OTHER_COURSE, 'Probability']]) {
    await fs.mkdir(path.join(workspace, code), { recursive: true })
    const registered = resultJson(await executeTool({
      ctx, agent: agentA, name: 'professor_course_manage',
      args: { action: 'register', course_code: code, display_name: name, term: '2025-2026 Fall', source_path: path.join(workspace, code) },
    }))
    check(registered?.problems === undefined || registered.problems.length === 0, `course ${code} registered`, JSON.stringify(registered?.problems ?? ''))
  }

  const bound = resultJson(await executeTool({ ctx, agent: agentA, name: 'professor_session_bind', args: { course: 'CSC3200' } }))
  check(bound?.course_id === 'csc3200' || bound?.binding?.course_id === 'csc3200', 'session A is bound to csc3200', JSON.stringify(bound).slice(0, 120))

  // Step 1 of the brief: a durable preference (explicit-stable) — and a temporary statement refused.
  const pref = resultJson(await executeTool({
    ctx, agent: agentA, name: 'professor_memory_update',
    args: { scope: 'global', action: 'set_preference', key: PREF_KEY, value: PREF_VALUE, evidence: 'explicit-stable' },
  }))
  check(pref?.written === true && pref?.revision === 1, 'a durable global preference was written (revision 1)')

  const temporaryResult = resultJson(await executeTool({
    ctx, agent: agentA, name: 'professor_memory_update',
    args: { scope: 'global', action: 'set_preference', key: 'scratch_pad', value: TEMP_MARKER, evidence: 'temporary' },
  }))
  check(temporaryResult?.written === false && (temporaryResult?.problems ?? []).join(' ').includes('explicit-stable'),
    'a temporary statement is refused, not promoted')

  // Step 2 of the brief: an evidence-gated learning result and stable course memory.
  const learned = resultJson(await executeTool({
    ctx, agent: agentA, name: 'professor_state_update',
    args: { file: 'PROGRESS.md', evidence: 'strong', field: 'current_unit', value: UNIT, reason: 'checkpoint solved unaided' },
  }))
  check(learned?.written === true, 'an evidence-gated learning result was written', JSON.stringify(learned))
  const next = resultJson(await executeTool({
    ctx, agent: agentA, name: 'professor_state_update',
    args: { file: 'PROGRESS.md', evidence: 'strong', field: 'recommended_next_step', value: NEXT_STEP },
  }))
  check(next?.written === true, 'the recommended next step was written', JSON.stringify(next))

  const courseBeforeInstruction = resultJson(await executeTool({ ctx, agent: agentA, name: 'professor_memory_read', args: { scope: 'course' } }))
  const instructed = resultJson(await executeTool({
    ctx, agent: agentA, name: 'professor_memory_update',
    args: { scope: 'course', action: 'add_instruction', instruction: INSTRUCTION, expected_revision: courseBeforeInstruction.revision },
  }))
  check(instructed?.written === true, 'a stable course instruction was written', JSON.stringify(instructed))
  const topic = resultJson(await executeTool({
    ctx, agent: agentA, name: 'professor_memory_update',
    args: { scope: 'course', action: 'set_recent_topic', value: RECENT_TOPIC, expected_revision: instructed.revision },
  }))
  check(topic?.written === true, 'the recent topic was written', JSON.stringify(topic))

  const other = resultJson(await executeTool({
    ctx, agent: agentA, name: 'professor_memory_update',
    args: { scope: 'course', course: OTHER_COURSE, action: 'set_recent_topic', value: OTHER_TOPIC },
  }))
  check(other?.written === true, `the other course's memory was written (${OTHER_COURSE} — the leak control)`)

  // The write-through refresh is asynchronous: poll the agent's OWN assembled prompt.
  const sectionA = await waitFor('session A memory section', async () => {
    const text = await memorySection(ctx, agentA)
    return text.includes(PREF_VALUE) && text.includes(INSTRUCTION) && text.includes(UNIT) ? text : null
  })
  check(sectionA.includes(PREF_VALUE), 'session A assembles its own prompt with the durable preference')
  check(sectionA.includes(INSTRUCTION), '…with the stable course instruction')
  check(sectionA.includes(UNIT), '…with the learning-state summary')
  check(!sectionA.includes(TEMP_MARKER), '…without the refused temporary statement')
  check(!sectionA.includes(OTHER_TOPIC), "…without the other course's topic (per-course isolation inside one project)")

  // ─── task 5 (parent): two sessions, one store; disposing one keeps the other ──
  section('multi-session storage ownership (two native sessions, one store)')
  const { handle: handleB, agent: agentB } = await createNativeSession({ ctx, sessionId: SESSION_B_ID, workspace })
  await selectPreset({ ctx, agent: agentB })
  const sectionB = await waitFor('session B memory section', async () => {
    const text = await memorySection(ctx, agentB)
    return text.includes(PREF_VALUE) ? text : null
  })
  check(sectionB.includes(PREF_VALUE), 'session B (same workspace, no binding) assembles the global preference')
  check(!sectionB.includes(INSTRUCTION) && !sectionB.includes(UNIT),
    'session B infers no course: no course memory leaks into an unbound session')

  await handleA.dispose()
  check(true, 'session A disposed')
  const sectionBAfter = await memorySection(ctx, agentB)
  check(sectionBAfter.includes(PREF_VALUE), 'disposing session A left session B memory intact (one shared store, per-agent caches)')

  // ─── step 3: shut the host down ───────────────────────────────────────────
  await handleB.dispose().catch(() => {})
  await ctx.fiber.dispose()
  check(true, 'the first host process shut down cleanly (storage released with the plugin fiber)')

  // ─── steps 4–7: a fresh host process restores the memory ──────────────────
  section('restart: a fresh host process assembles the persisted memory')
  const restoreScript = path.join(installedDir, 'tools', 'verify-memory-restore.mjs')
  check(await exists(restoreScript), 'the restore probe ships inside the installed package', restoreScript)

  let childStdout = ''
  let childOk = true
  try {
    childStdout = execFileSync(HARNESS_BIN, [restoreScript], {
      encoding: 'utf8',
      env: {
        ...childEnv,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
        PROFESSOR_HOME: home,
        PROFESSOR_PROFILE: PROFILE_NAME,
        PROFESSOR_WORKSPACE: workspace,
        PROFESSOR_INSTALLED_DIR: installedDir,
        PROFESSOR_PREF_VALUE: PREF_VALUE,
        PROFESSOR_INSTRUCTION: INSTRUCTION,
        PROFESSOR_UNIT: UNIT,
        PROFESSOR_TOPIC_OTHER: OTHER_TOPIC,
        PROFESSOR_TEMP_MARKER: TEMP_MARKER,
        PROFESSOR_SESSION_A_ID: SESSION_A_ID,
      },
      timeout: 180_000,
    })
  } catch (error) {
    childOk = false
    childStdout = String(error.stdout ?? error.message)
  }
  const childLine = childStdout.split('\n').find((line) => line.startsWith('PROFESSOR_MEMORY_JSON '))
  const childReport = childLine === undefined ? null : JSON.parse(childLine.slice('PROFESSOR_MEMORY_JSON '.length))
  check(childOk && childReport !== null, 'the fresh host process exited 0 and reported', childReport?.errors?.join(' | ') ?? childStdout.slice(-200))
  check(childReport?.ok === true, 'the fresh session retrieved the persisted memory and nothing else',
    (childReport?.errors ?? []).join(' | '))
  check(childReport?.disposalIntact === true, 'and a disposed sibling session changed nothing in the new process')

  section('claims: evidence classes')
  console.log(`${failures === 0 ? 'PROVED' : 'NOT PROVED'} (real host, installed artefact): durable preference + evidence-gated learning +`)
  console.log('  course memory persist across a genuine host-process restart; a fresh native Professor')
  console.log('  session assembles them through the host\'s own prompt assembly; temporary statements')
  console.log('  and other courses\' memory stay absent; two sessions share one store and dispose independently.')
  console.log('UNVERIFIED  a model turn — no model provider is configured in a disposable profile;')
  console.log('            tool calls here are dispatched by this verifier, not chosen by a model.')

  await fs.rm(home, { recursive: true, force: true }).catch(() => {})
} catch (error) {
  failures += 1
  console.log(`FAIL  the memory restart run crashed — ${error?.message ?? String(error)}`)
} finally {
  await hostContext?.fiber?.dispose?.().catch(() => {})
}

process.exit(failures === 0 ? 0 : 1)
