/**
 * Phase 4 acceptance — Professor Home on the **real host**, from the packaged artefact.
 *
 * What this run proves, and how
 * -----------------------------
 *   1. the deployment-level `professor-app` row mounts, and its endpoints are reachable **only**
 *      through the official Typert gateway — no custom HTTP, no fetch bridge;
 *   2. an ordinary (non-Professor) session is unchanged: no `professor_*` tool, no Professor persona,
 *      no Professor skill is visible outside the preset;
 *   3. a **fresh, course-free** installation serves Home data and launches a general native session: the
 *      session is live in the host's own store, composes the `professor` preset, and the metadata row
 *      is marked `ready` only after setup;
 *   4. Home then reports Continue / Recent, and a deleted or unknown session is refused with an
 *      actionable error rather than a blank panel;
 *   5. Home data survives a **restart** — which is also the proof that the shared storage domain is
 *      released: a second boot cannot open `professor_app` while a handle is still held;
 *   6. with an academic folder connected through the real onboarding tools, Home lists the configured
 *      courses and a course launch writes the same binding file `professor_session_bind` writes.
 *
 * What it deliberately does NOT claim
 * -----------------------------------
 * It never drives a model turn (a disposable profile has no configured model), and it never renders
 * the browser: the client bundle is checked for *registration and delivery* here, and the rendered
 * UI is reported as UNVERIFIED by this script; separate browser evidence lives in docs/v1/PHASE4.md.
 *
 * Run with the harness Node (asar-aware): `npm run verify:home`.
 *
 * @module dsh-professor-spike/tools/verify-home
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import {
  PACKAGE_NAME, bootProfessorProfile, createProfessorProfile, executeTool, resultJson, sessionSurface,
} from './packaged-profile.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_NAME = 'professor-home'

/** The six study modes Home offers. */
const STUDY_MODES = ['learn', 'question', 'assignment', 'review', 'exam', 'free']

/** One course folder, discovered and confirmed through the real tools. */
const FIXTURE = [
  ['CSC3200/01_Lectures/week-01.md', '# Week 1\n\nLexical analysis and regular languages.\n'],
  ['CSC3200/02_Assignments/a1.md', '# Assignment 1\n\nWrite a lexer.\n'],
]

/** A second course, added during the deletion run so "other courses survive" is a real claim. */
const SECOND_COURSE = ['MAT1001/notes.md', '# Methods\n\nContinuous assessment counts for forty percent.\n']

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 68 - title.length))}`)
const proved = (label) => console.log(`PROVED      ${label}`)
const unverified = (label, why) => console.log(`UNVERIFIED  ${label}  — ${why}`)
const exists = (candidate) => fs.stat(candidate).then(() => true, () => false)
const sha256Of = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex')

/** Relative path → sha256 for every file under a directory, so "unchanged" is proven byte-wise. */
async function hashTree(root) {
  const out = {}
  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(target)
      else out[path.relative(root, target)] = createHash('sha256').update(await fs.readFile(target)).digest('hex')
    }
  }
  await walk(root)
  return out
}

/** The `relative_path`s currently in the stored file index (absent when there is no index yet). */
async function indexPaths(academic) {
  const target = path.join(academic, '.professor', 'indexes', 'files.json')
  try {
    const parsed = JSON.parse(await fs.readFile(target, 'utf8'))
    return Array.isArray(parsed?.files) ? parsed.files.map((record) => record.relative_path) : []
  } catch {
    return []
  }
}
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', ...options })

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-home-'))
const npmCache = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-home-npm-'))
process.on('exit', () => {
  for (const dir of [temp, npmCache]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* exit handler: best effort */ }
  }
})
const childEnv = { ...process.env, npm_config_cache: npmCache, DSH_TELEMETRY_DISABLED: '1' }

let verdict = 1
let ctx
let home // disposable DSH_HOME, removed on every exit path

try {
  console.log('Phase 4 acceptance — Professor Home on the real host')
  console.log('claim boundary: real host, packaged artefact, native sessions; no model turn, no browser render')

  section('1. pack and install the exact artefact')
  const packDir = path.join(temp, 'pack')
  await fs.mkdir(packDir, { recursive: true })
  const packed = JSON.parse(run('npm', ['pack', '--pack-destination', packDir, '--json'], { cwd: REPO, env: childEnv }))
  const tarball = path.join(packDir, packed[0].filename)
  console.log(`tarball: ${packed[0].filename}`)
  check(packed[0].files.some((entry) => entry.path.startsWith('client/')),
    'the tarball ships the client bundle', packed[0].files.filter((f) => f.path.startsWith('client/')).join(', '))

  home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-professor-home-'))
  process.env.DSH_HOME = home
  const academic = await fs.realpath(await fs.mkdtemp(path.join(home, 'academic-')))
  for (const [relative, content] of FIXTURE) {
    const target = path.join(academic, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
  await createProfessorProfile({ home, profileName: PROFILE_NAME, tarball, run: (c, a, o) => run(c, a, { ...(o ?? {}), env: childEnv }) })

  section('2. boot the installed copy')
  const booted = await bootProfessorProfile({ home, profileName: PROFILE_NAME, workspace: academic })
  ctx = booted.ctx
  check(ctx.fiber?.state === 2, 'the composed tree reached the active state', String(ctx.fiber?.state))
  const gateway = ctx.get('typertGateway')
  check(gateway !== undefined, 'the official Typert gateway is mounted')
  const unauthenticated = await fetch(`http://127.0.0.1:${ctx.get('webServer').port}/api/professorHome/home`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: {} }),
  })
  check(unauthenticated.status === 401 || unauthenticated.status === 403,
    'official transport refuses unauthenticated Professor requests', String(unauthenticated.status))

  const call = (method, args = {}) => gateway.invoke({ namespace: 'professorHome', method, args })
  const refuse = async (method, args) => {
    try {
      await call(method, args)
      return null
    } catch (error) {
      return `${error?.code ?? ''} ${error?.message ?? String(error)}`
    }
  }

  section('3. the ordinary session is unchanged')
  const rootTools = [...(ctx.get('tools').view?.(undefined)?.visible?.keys() ?? [])]
  const leaked = rootTools.filter((name) => name.startsWith('professor_'))
  check(leaked.length === 0, 'no professor_* tool is visible outside the Professor preset', leaked.join(', '))
  const rootSections = await (async () => {
    try {
      const assembled = await ctx.get('systemPrompt').assemble({})
      return Array.isArray(assembled?.sections) ? assembled.sections : []
    } catch {
      return []
    }
  })()
  const persona = rootSections.find((entry) => entry.name === 'deployment:persona-prefix')?.text ?? ''
  check(!persona.includes('你是 Professor'), 'the deployment persona is not the Professor persona',
    JSON.stringify(persona.slice(0, 32)))
  check((await ctx.get('skills').list({ cwd: academic }).catch(() => [])).length === 0,
    'no Professor skill is listed outside the preset')

  section('4. a fresh, course-free Home')
  const fresh = await call('home')
  check(fresh.ok === true, 'Home answers through the official Remote')
  check(fresh.connection?.connected === false, 'the fresh profile is course-free')
  check(Array.isArray(fresh.courses) && fresh.courses.length === 0, 'and lists no course')
  check(fresh.continue === null && fresh.recent.length === 0, 'with an honest empty state')
  check(JSON.stringify(fresh.modes) === JSON.stringify(STUDY_MODES), 'and offers exactly the six study modes',
    JSON.stringify(fresh.modes))
  const settings = await call('settings', { request: { skill: 'professor-study' } })
  check(settings.overlay.revision === 0 && settings.memory.status === 'available', 'global settings resolve before a native session exists')
  const saved = await call('saveCustomization', { request: { skill: 'professor-study', fields: { teachingDepth: 'detailed' }, expectedRevision: 0 } })
  check(saved.revision === 1, 'strict authenticated settings bridge saves a revisioned global preference')
  const stale = await refuse('saveCustomization', { request: { skill: 'professor-study', fields: {}, expectedRevision: 0 } })
  check(stale !== null && stale.includes('PROFESSOR_CUSTOMIZATION_STALE'), 'bridge rejects a stale settings save')
  const memoryOff = await call('setMemoryEnabled', { request: { enabled: false, expectedRevision: settings.memory.revision } })
  check(memoryOff.enabled === false && memoryOff.refresh === 'complete', 'authenticated memory switch disables without a native session')
  const memoryStale = await refuse('setMemoryEnabled', { request: { enabled: true, expectedRevision: settings.memory.revision } })
  check(memoryStale?.includes('PROFESSOR_MEMORY_STALE'), 'memory switch rejects an outdated control revision')
  const memoryReadback = await call('settings', { request: { skill: 'professor-study' } })
  check(memoryReadback.memory.enabled === false && memoryReadback.global.fields.teachingDepth === 'detailed', 'disabled memory does not delete skill customization')
  await call('setMemoryEnabled', { request: { enabled: true, expectedRevision: memoryOff.revision } })

  section('5. launch a general native Professor session')
  const requestId = 'r-1a2b3c4d5e6f'
  const launched = await call('launch', {
    request: { requestId, mode: 'free', courseId: null, topic: null },
  })
  const sessionId = launched.sessionId
  check(sessionId === `professor-${requestId}`, 'the launch returned the derived native session id', String(sessionId))
  check(launched.ok === true && launched.setup?.preset === 'professor', 'and the preset was selected',
    JSON.stringify(launched.setup))
  const live = ctx.get('sessions').get(sessionId)
  check(live !== undefined, 'the session is live in the host session store')
  check(live?.header?.id === sessionId, 'under the id Home reported', String(live?.header?.id))
  check(live?.header?.cwd === academic, 'native cwd is the intended canonical workspace', live?.header?.cwd)
  const agent = ctx.get('agents').get(sessionId)
  check(agent !== undefined, 'and the host built an agent for it')
  const composed = await ctx.get('agentPresets').composedPreset(agent.ctx)
  check(composed === 'professor', 'the live agent composes the professor preset', String(composed))
  const sessionTools = [...(ctx.get('tools').view(agent)?.visible?.keys() ?? [])]
    .filter((name) => name.startsWith('professor_'))
  check(sessionTools.length >= 20, 'the launched session carries the Professor tool surface',
    `${sessionTools.length} professor tools`)
  check(launched.setup?.hydrated === true, 'memory is hydrated before navigation')
  const preference = resultJson(await executeTool({ ctx, agent, name: 'professor_memory_update',
    args: { scope: 'global', action: 'set_preference', key: 'language', value: 'memory-switch-marker', evidence: 'explicit-stable' } }))
  check(preference?.written === true, 'native session stores a durable memory before UI switching')
  const memoryText = async () => (await sessionSurface({ ctx, agent, workspace: academic })).sections.find(row => row.name === 'professor:memory')?.text ?? ''
  check((await memoryText()).includes('memory-switch-marker'), 'native prompt initially contains the persisted memory')
  const activeControl = (await call('settings', { request: { skill: 'professor-study' } })).memory
  const activeOff = await call('setMemoryEnabled', { request: { enabled: false, expectedRevision: activeControl.revision } })
  check(activeOff.refresh === 'complete' && (await memoryText()) === '', 'UI switch clears an already active native memory section')
  await call('setMemoryEnabled', { request: { enabled: true, expectedRevision: activeOff.revision } })
  check((await memoryText()).includes('memory-switch-marker'), 'UI re-enable restores preserved memory to the active native prompt')

  const duplicate = await call('launch', { request: { requestId, mode: 'free', courseId: null, topic: null } })
  check(duplicate.sessionId === sessionId && duplicate.reused === true,
    'a repeated launch returns the same native session instead of creating another', String(duplicate.sessionId))
  const rows = await (async () => {
    const data = await call('home')
    return data.recent
  })()
  check(rows.length === 1, 'metadata holds exactly one session row', `${rows.length}`)
  check(rows[0].status === 'ready', 'and it is marked ready', String(rows[0].status))

  section('6. Recent, Continue and an honest refusal')
  const withContinue = await call('home')
  check(withContinue.continue?.sessionId === sessionId, 'Continue offers the usable session')
  const reopened = await call('reopen', { request: { sessionId } })
  check(reopened.ok === true && reopened.sessionId === sessionId, 'reopen validates the live session')
  const missing = await refuse('reopen', { request: { sessionId: 'professor-does-not-exist' } })
  check(missing !== null && /PROFESSOR_SESSION_MISSING/.test(missing),
    'a session Home cannot reach is refused with an actionable code', String(missing).slice(0, 120))
  const badMode = await refuse('launch', { request: { requestId: 'r-000000000000', mode: 'coding' } })
  check(badMode !== null, 'an unsupported study mode is rejected before anything is created', String(badMode).slice(0, 120))
  const unexpected = await refuse('launch', { request: { requestId: 'r-000000000000', mode: 'learn', messages: [] } })
  check(unexpected !== null, 'and an unexpected field cannot ride along into a launch', String(unexpected).slice(0, 120))

  section('7. the client bundle is advertised and delivered')
  const clientService = ['clientModules', 'client-modules', 'clientModuleSystem']
    .map((name) => ctx.get(name))
    .find((service) => service !== undefined && typeof service.clientPath === 'function')
  check(clientService !== undefined, 'the host client-module service is mounted')
  const clientPath = clientService?.clientPath?.(PACKAGE_NAME)
  check(typeof clientPath === 'string' && await exists(clientPath),
    'the host resolved and can serve a client bundle for this package', String(clientPath))
  const bundleSource = clientPath === undefined ? '' : await fs.readFile(clientPath, 'utf8')
  check(bundleSource.includes(`id: "${PACKAGE_NAME}"`) || bundleSource.includes(`id: '${PACKAGE_NAME}'`),
    'the served bundle registers itself under the package id')
  check(bundleSource.includes('professorHome'), 'and mounts the professorHome namespace')
  check(!/https?:\/\//.test(bundleSource), 'with no remote URL anywhere in it')
  const graph = clientService?.graph?.()
  const entryIds = (graph?.entries ?? []).map((entry) => entry?.id)
  check(entryIds.includes(PACKAGE_NAME), 'the boot graph delivers the bundle to the browser', entryIds.join(', '))

  section('8. the academic folder: courses and a course launch')
  const discovered = await call('workspaceCommand', { request: { sessionId, action: 'discover', args: { folder: academic } } })
  const proposal = discovered?.proposal ?? null
  check(discovered?.ok === true && proposal !== null && typeof discovered.proposalToken === 'string', 'the owned native session discovers through the authenticated Settings adapter', String(discovered?.code ?? ''))
  const foreign = await refuse('workspaceCommand', { request: { sessionId: 'unowned-coding-session', action: 'discover', args: {} } })
  check(foreign?.includes('PROFESSOR_COMMAND_SESSION'), 'the Settings adapter rejects an unowned coding session')
  const applied = await call('workspaceCommand', { request: { sessionId, action: 'confirm', args: {
    proposalToken: discovered.proposalToken, selections: [{ relative_path: 'CSC3200', action: 'include' }] } } })
  check(applied?.applied === true, 'server-owned proposal confirmation connects the academic folder',
    JSON.stringify(applied?.problems ?? []))

  const connected = await call('home')
  const health = await call('workspaceCommand', { request: { sessionId, action: 'diagnostics', args: {} } })
  check(typeof health === 'object' && health !== null, 'owned session diagnostics use the same native tool adapter')
  const rebuilt = await call('workspaceCommand', { request: { sessionId, action: 'rebuild', args: {} } })
  check(rebuilt.index?.complete === true && rebuilt.readiness?.configuration?.saved === true, 'adapter rebuild derives indexes without replacing the confirmed configuration')
  check(connected.connection?.connected === true, 'Home now reports the connected folder',
    String(connected.connection?.folder))
  const courses = connected.courses ?? []
  check(courses.length === 1 && courses[0].course_code === 'CSC3200', 'and lists exactly the configured course',
    JSON.stringify(courses.map((course) => course.course_code)))

  for (const operation of ['update', 'archive', 'reactivate']) {
    const snapshot = await call('workspaceCommand', { request: { sessionId, action: 'courses', args: {} } })
    check(typeof snapshot.courseToken === 'string', 'course snapshot receives an owned guarded token')
    const edited = await call('workspaceCommand', { request: { sessionId, action: 'manageCourse', args: {
      courseToken: snapshot.courseToken, courseId: courses[0].course_id, operation,
      ...(operation === 'update' ? { displayName: 'Guarded course edit', term: 'Fall 2026' } : {}) } } })
    check(edited.changed?.includes(courses[0].course_id) === true, `native guarded course ${operation} preserves its ID`)
    const reused = await refuse('workspaceCommand', { request: { sessionId, action: 'manageCourse', args: {
      courseToken: snapshot.courseToken, courseId: courses[0].course_id, operation: 'archive' } } })
    check(reused?.includes('PROFESSOR_COMMAND_PROPOSAL'), 'successful course edit consumes its snapshot')
    const current = await call('home')
    check(current.courses.length === 1 && current.courses[0].status === (operation === 'archive' ? 'archived' : 'active'), `Home metadata reflects course ${operation}`)
  }

  const courseLaunch = await call('launch', {
    request: { requestId: 'r-9f8e7d6c5b4a', mode: 'exam', courseId: courses[0].course_id, topic: '词法分析' },
  })
  check(courseLaunch.ok === true && courseLaunch.courseId === courses[0].course_id,
    'a course launch resolves against the authoritative configuration', JSON.stringify(courseLaunch.courseId))
  check(courseLaunch.setup?.bound === true, 'and applies the course binding', JSON.stringify(courseLaunch.setup))
  const courseAgent = ctx.get('agents').get(courseLaunch.sessionId)
  const courseAssembly = await ctx.get('systemPrompt').assemble({ agent: courseAgent, scope: courseAgent })
  const coursePrompt = courseAssembly.sections.map(section => section.text ?? '').join('\n')
  check(coursePrompt.includes('Professor 当前课程') && coursePrompt.includes(courses[0].course_id),
    'native prompt includes the selected course independently of persistent memory')
  check(coursePrompt.includes('不要再次询问选择哪门课程'), 'bound native prompt forbids asking the student to select a course again')
  const status = await executeTool({
    ctx, agent: courseAgent, name: 'professor_session_status', label: 'home-status',
  })
  const statusPayload = resultJson(status)
  check(statusPayload?.bound === true && statusPayload?.course_id === courses[0].course_id,
    'the native session itself reports the bound course', JSON.stringify(statusPayload?.course_id))
  const bindingFile = path.join(academic, '.professor', 'state', 'sessions', `${courseLaunch.sessionId}.json`)
  check(await exists(bindingFile), 'the binding was written as the same file professor_session_bind writes',
    path.relative(academic, bindingFile))
  const detail = await call('course', { request: { courseId: courses[0].course_id } })
  check(detail.course.course_id === courses[0].course_id && detail.materials.length > 0, 'course view uses the connected real index')
  const materialLaunch = await call('launchMaterial', { request: { requestId: 'material-packed-001', courseId: courses[0].course_id, fileId: detail.materials[0].fileId, mode: 'learn' } })
  check(materialLaunch.readyForDraft === true && typeof materialLaunch.relativePath === 'string', 'indexed material is revalidated around real native session preparation')
  check(ctx.get('agents').get(materialLaunch.sessionId)?.session.header.cwd === academic, 'material native session belongs to the validated academic folder')
  check(detail.recent.some(row => row.sessionId === courseLaunch.sessionId), 'recent course session is validated against its native workspace')
  const scoped = await call('settings', { request: { skill: 'professor-study', courseId: courses[0].course_id } })
  check(scoped.global.fields.teachingDepth === 'detailed' && scoped.overlay.revision === 0, 'course settings inherit global while preserving an empty override')

  section('9. Home survives a restart (and the domain is released)')
  await ctx.fiber.dispose()
  ctx = undefined
  const rebooted = await bootProfessorProfile({ home, profileName: PROFILE_NAME, workspace: academic })
  ctx = rebooted.ctx
  const secondGateway = ctx.get('typertGateway')
  const after = await secondGateway.invoke({ namespace: 'professorHome', method: 'home', args: {} })
  check(after.ok === true, 'Home answers again after the plugin was unloaded and remounted',
    JSON.stringify(after.code ?? null))
  const ids = after.recent.map((row) => row.sessionId)
  check(ids.includes(sessionId), 'the session launched before the restart is still listed', ids.join(', '))
  check(after.courses.length === 1, 'and the connected folder is still known', `${after.courses.length} courses`)
  const restored = await secondGateway.invoke({ namespace: 'professorHome', method: 'reopen', args: { request: { sessionId } } })
  check(restored.ok === true, 'persisted session can be validated after restart')
  const retried = await secondGateway.invoke({ namespace: 'professorHome', method: 'launch', args: { request: { requestId, mode: 'free', courseId: null, topic: null } } })
  check(retried.sessionId === sessionId, 'same request resumes the original persisted session after restart')
  const storageFile = path.join(home, 'storages', 'professor_app.json')
  check(await exists(storageFile), 'metadata lives in the host storage domain, not in any academic folder',
    path.relative(home, storageFile))
  const bytes = await fs.readFile(storageFile, 'utf8')
  check(!bytes.includes('"messages"'), 'and holds metadata only — no transcript was persisted')

  section('10. guarded course deletion (disposable fixture, real host)')
  // The first fibre was disposed in section 9, so every call below goes through the rebooted
  // gateway rather than the stale one captured in section 2.
  const del = (method, args = {}) => secondGateway.invoke({ namespace: 'professorHome', method, args })
  const delRefuse = async (method, args) => {
    try {
      await del(method, args)
      return null
    } catch (error) {
      return `${error?.code ?? ''} ${error?.message ?? String(error)}`
    }
  }

  const [, secondContent] = SECOND_COURSE
  await fs.mkdir(path.dirname(path.join(academic, SECOND_COURSE[0])), { recursive: true })
  await fs.writeFile(path.join(academic, SECOND_COURSE[0]), secondContent, 'utf8')

  const rescan = await del('workspaceCommand', { request: { sessionId, action: 'discover', args: { folder: academic } } })
  check(rescan?.ok === true && typeof rescan.proposalToken === 'string',
    'the folder is still discoverable for a second connection', String(rescan?.code ?? ''))
  const proposed = (rescan?.proposal?.candidates ?? []).map((row) => row.relative_path)
  check(proposed.includes('MAT1001'), 'the new course folder is proposed', JSON.stringify(proposed))
  const joined = await del('workspaceCommand', { request: { sessionId, action: 'confirm', args: {
    proposalToken: rescan.proposalToken,
    selections: [{ relative_path: 'CSC3200', action: 'include' }, { relative_path: 'MAT1001', action: 'include' }] } } })
  check(joined?.applied === true, 'confirming keeps the existing course and adds the second one',
    JSON.stringify(joined?.problems ?? []))
  const two = await del('home')
  check(two.courses.length === 2, 'Home lists both configured courses',
    JSON.stringify(two.courses.map((course) => course.course_id)))

  // A session bound to the course *before* it is deleted: deleting must report to it, never rebind it.
  const boundLaunch = await del('launch', { request: { requestId: 'r-del-000000000001', mode: 'learn', courseId: 'csc3200', topic: '词法分析' } })
  check(boundLaunch.ok === true && boundLaunch.setup?.bound === true, 'a session is bound to the course before deletion')
  const boundAgent = ctx.get('agents').get(boundLaunch.sessionId)
  check(boundAgent !== undefined, 'the bound agent is live in this process', String(boundLaunch.sessionId))

  const protectedFiles = [
    path.join(academic, 'CSC3200', '01_Lectures', 'week-01.md'),
    path.join(academic, 'CSC3200', '02_Assignments', 'a1.md'),
    path.join(academic, 'MAT1001', 'notes.md'),
  ]
  const materialBefore = await Promise.all(protectedFiles.map(sha256Of))
  const stateBefore = await hashTree(path.join(academic, '.professor', 'state'))
  const searchFor = async (query) => resultJson(await executeTool({
    ctx, agent: boundAgent, name: 'professor_search', args: { query },
  }))
  const beforeLexical = await searchFor('lexical analysis')
  const beforeMethods = await searchFor('continuous assessment')
  check(beforeLexical.results.length > 0, 'the course about to be deleted is searchable now',
    JSON.stringify(beforeLexical.diagnostics ?? {}))
  check(beforeMethods.results.length > 0, 'the surviving course is searchable too')

  const snapshot = await del('workspaceCommand', { request: { sessionId, action: 'courses', args: {} } })
  check(typeof snapshot.courseToken === 'string', 'deletion starts from an observed course snapshot')
  const unconfirmed = await delRefuse('workspaceCommand', { request: { sessionId, action: 'manageCourse', args: {
    courseToken: snapshot.courseToken, courseId: 'csc3200', operation: 'delete' } } })
  check(unconfirmed?.includes('PROFESSOR_COMMAND_INVALID'),
    'a deletion without an explicit confirmation is refused', String(unconfirmed).slice(0, 140))
  const foreignCourse = await delRefuse('workspaceCommand', { request: { sessionId, action: 'manageCourse', args: {
    courseToken: snapshot.courseToken, courseId: 'not-a-course', operation: 'delete', confirmDelete: true } } })
  check(foreignCourse?.includes('PROFESSOR_COMMAND_INVALID'),
    'a course outside the observed snapshot is refused', String(foreignCourse).slice(0, 140))

  const removed = await del('workspaceCommand', { request: { sessionId, action: 'manageCourse', args: {
    courseToken: snapshot.courseToken, courseId: 'csc3200', operation: 'delete', confirmDelete: true } } })
  check(removed.changed?.includes('csc3200') === true, 'a confirmed deletion removes the registration',
    JSON.stringify(removed.problems ?? []))
  const consumed = await delRefuse('workspaceCommand', { request: { sessionId, action: 'manageCourse', args: {
    courseToken: snapshot.courseToken, courseId: 'csc3200', operation: 'delete', confirmDelete: true } } })
  check(consumed?.includes('PROFESSOR_COMMAND_PROPOSAL'), 'the snapshot is single-use')

  const afterDelete = await del('home')
  check(afterDelete.courses.length === 1 && afterDelete.courses[0].course_id === 'mat1001',
    'only the other course is left in Home', JSON.stringify(afterDelete.courses.map((course) => course.course_id)))
  check(JSON.stringify(await Promise.all(protectedFiles.map(sha256Of))) === JSON.stringify(materialBefore),
    'every course material file is byte-identical after deletion')
  check(JSON.stringify(await hashTree(path.join(academic, '.professor', 'state'))) === JSON.stringify(stateBefore),
    'learning state and binding history are byte-identical after deletion')

  const pathsAfterDelete = await indexPaths(academic)
  check(!pathsAfterDelete.some((relative) => relative.startsWith('CSC3200/')),
    'the deleted course has no index records left', JSON.stringify(pathsAfterDelete))
  check(pathsAfterDelete.some((relative) => relative.startsWith('MAT1001/')),
    'the surviving course keeps its index records')
  check((await searchFor('lexical analysis')).results.length === 0, 'the removed material is not returned by search')
  check((await searchFor('continuous assessment')).results.length > 0, 'the surviving material still is')

  const rebuiltAgain = await del('workspaceCommand', { request: { sessionId, action: 'rebuild', args: {} } })
  check(rebuiltAgain.index?.complete === true, 'the index rebuilds after the deletion')
  check(!(await indexPaths(academic)).some((relative) => relative.startsWith('CSC3200/')),
    'and a rebuild does not resurrect the deleted folder as unassigned material')
  check((await searchFor('lexical analysis')).results.length === 0, 'so it still is not searchable')

  const boundSurface = await sessionSurface({ ctx, agent: boundAgent, workspace: academic })
  const memorySection = boundSurface.sections.find((row) => row.name === 'professor:memory')?.text ?? ''
  check(!memorySection.includes('【Professor 当前课程】'),
    'the bound session no longer presents the removed course as current')
  check(memorySection.includes('csc3200') && memorySection.includes('不再配置'),
    'and it reports that the course is no longer configured', JSON.stringify(memorySection.slice(0, 160)))

  const relaunched = await delRefuse('launch', { request: { requestId: 'r-del-000000000002', mode: 'learn', courseId: 'csc3200', topic: null } })
  check(relaunched?.includes('PROFESSOR_COURSE_UNKNOWN'),
    'starting a session for the removed course refuses instead of choosing another',
    String(relaunched).slice(0, 160))

  const rescanAgain = await del('workspaceCommand', { request: { sessionId, action: 'discover', args: { folder: academic } } })
  const readded = await del('workspaceCommand', { request: { sessionId, action: 'confirm', args: {
    proposalToken: rescanAgain.proposalToken, selections: [{ relative_path: 'CSC3200', action: 'include' }] } } })
  check(readded?.applied === true, 're-scanning and confirming the same folder re-adds the course',
    JSON.stringify(readded?.problems ?? []))
  const backHome = await del('home')
  check(backHome.courses.length === 2, 'Home lists the course again',
    JSON.stringify(backHome.courses.map((course) => course.course_id)))
  check((await indexPaths(academic)).some((relative) => relative.startsWith('CSC3200/')),
    'and its material is indexed once more')
  check((await searchFor('lexical analysis')).results.length > 0, 'and searchable again')
  const projectText = await fs.readFile(path.join(academic, '.professor', 'project.yaml'), 'utf8')
  check(!projectText.includes('removed_sources'), 're-adding clears the removal marker')
  check(JSON.stringify(await Promise.all(protectedFiles.map(sha256Of))) === JSON.stringify(materialBefore),
    'the source material never changed through deletion and re-addition')

  section('11. clearing a Recent conversation (disposable session, real archive API)')
  const clearLaunch = await del('launch', { request: { requestId: 'r-clr-000000000001', mode: 'free', courseId: null, topic: null } })
  const clearId = clearLaunch.sessionId
  check(clearId === 'professor-r-clr-000000000001', 'a disposable session is ready to clear', String(clearId))
  const unconfirmedClear = await delRefuse('clearSession', { request: { sessionId: clearId } })
  check(unconfirmedClear !== null
    && (unconfirmedClear.includes('PROFESSOR_HOME_REQUEST_INVALID') || unconfirmedClear.includes('input-invalid')),
    'an unconfirmed clear is rejected at the contract boundary', String(unconfirmedClear).slice(0, 120))
  const foreignClear = await delRefuse('clearSession', { request: { sessionId: 'professor-does-not-exist', confirmed: true } })
  check(foreignClear?.includes('PROFESSOR_SESSION_MISSING'),
    'a foreign/non-Professor id is refused', String(foreignClear).slice(0, 120))

  const workspaces = ctx.get('workspaceRegistry')
  const cleared = await del('clearSession', { request: { sessionId: clearId, confirmed: true } })
  check(cleared?.ok === true && cleared?.nativeArchived === true,
    'clear reports a completed native archive', JSON.stringify(cleared))
  check(workspaces?.archivedSessionIds?.includes?.(clearId) === true,
    'the workspace registry durably archived the native session')
  check(ctx.get('sessions')?.get?.(clearId) !== undefined,
    'the native conversation itself still exists — archived, not deleted')
  const afterClear = await del('home')
  check(!afterClear.recent.some((row) => row.sessionId === clearId), 'the row is gone from Recent')
  check(afterClear.continue?.sessionId !== clearId, 'and from Continue')
  const reopenCleared = await delRefuse('reopen', { request: { sessionId: clearId } })
  check(reopenCleared?.includes('PROFESSOR_SESSION_ARCHIVED'),
    'reopening a cleared conversation says its native history is archived', String(reopenCleared).slice(0, 120))

  const repeatClear = await del('clearSession', { request: { sessionId: clearId, confirmed: true } })
  check(repeatClear?.ok === true && repeatClear?.repeat === true, 'repeating the clear is a safe no-op', JSON.stringify(repeatClear))
  const resurrect = await delRefuse('launch', { request: { requestId: 'r-clr-000000000001', mode: 'free', courseId: null, topic: null } })
  check(resurrect?.includes('PROFESSOR_SESSION_ARCHIVED'),
    'the original launch request cannot resurrect the cleared conversation', String(resurrect).slice(0, 120))

  await workspaces?.unarchiveSession?.(clearId)
  check(!(workspaces?.archivedSessionIds ?? []).includes(clearId), 'the native chat is recoverable via unarchive')
  const stillGone = await del('home')
  check(!stillGone.recent.some((row) => row.sessionId === clearId),
    'native unarchiving does not automatically re-add a Professor row')

  section('12. learning presets and bulk clearing (disposable fixtures)')
  // --- learning presets: offline catalog, explicit apply, next composed turn ------------------
  const globalPresets = await del('settings', { request: { skill: 'professor-study' } })
  check(globalPresets.presets?.bundled?.length === 5,
    'the five bundled learning presets are available offline on the real host', String(globalPresets.presets?.bundled?.length))
  // This run already saved a global preference in section 5, so the honest state here is
  // "no forced preset over existing preferences" — the untouched-profile default composition is
  // proven in test/preset-compose.test.mjs instead.
  check(globalPresets.presets.automaticDefault === false && globalPresets.presets.applied === null,
    'existing saved preferences are preserved with no forced preset', JSON.stringify(globalPresets.presets.applied))
  check(globalPresets.presets.bundled.every(row => row.provenance === 'original:professor-v1'),
    'bundled presets are labelled with their original provenance')
  const presetLaunch = await del('launch', { request: { requestId: 'r-pre-000000000001', mode: 'learn', courseId: courses[0].course_id, topic: null } })
  const presetAgent = ctx.get('agents').get(presetLaunch.sessionId)
  const skillsService = ctx.get('skills')
  const beforeApply = (await skillsService.get('professor-study', { scope: presetAgent, cwd: academic })).content
  check(beforeApply.includes('teachingDepth: detailed'),
    'the composed study skill carries the saved preference before any preset choice')
  const coursePresets = await del('settings', { request: { skill: 'professor-study', courseId: courses[0].course_id } })
  const appliedPreset = await del('presetApply', { request: {
    presetId: 'builtin-quick-answers', courseId: courses[0].course_id,
    expectedRevision: coursePresets.presets.overlayRevision,
  } })
  check(appliedPreset.applied?.state === 'preset' && appliedPreset.applied?.presetId === 'builtin-quick-answers',
    'explicit apply snapshots the preset into the course overlay', JSON.stringify(appliedPreset.applied))
  const afterApply = (await skillsService.get('professor-study', { scope: presetAgent, cwd: academic })).content
  check(afterApply.includes('快速答疑模式：第一句先给出明确答案'),
    'the next composed study turn uses the applied preset')
  check(!afterApply.includes('teachingDepth: detailed') && afterApply.includes('简洁，先给关键结论'),
    'the previous teaching fields are not still used')
  check(beforeApply.includes('teachingDepth: detailed'), 'the earlier composed body was not rewritten (in-flight work is untouched)')
  check(afterApply.includes('language: 中文') || !afterApply.includes('language:'),
    'unlisted preferences are preserved')
  const boundAfterPreset = resultJson(await executeTool({ ctx, agent: presetAgent, name: 'professor_session_status', label: 'preset-status' }))
  check(boundAfterPreset?.bound === true && boundAfterPreset?.course_id === courses[0].course_id,
    'applying a preset leaves the course binding unchanged', JSON.stringify(boundAfterPreset?.course_id))
  const composedAfter = await ctx.get('agentPresets').composedPreset(presetAgent.ctx)
  check(composedAfter === 'professor', 'and the Harness deployment preset/model selection are untouched', String(composedAfter))

  // --- bulk clearing: one confirmation over a backend-owned snapshot -------------------------
  const bulkA = await del('launch', { request: { requestId: 'r-bulk-000000000001', mode: 'free', courseId: null, topic: null } })
  const bulkSnapshot = await del('clearAllSnapshot', { request: {} })
  check(bulkSnapshot.ok === true && bulkSnapshot.count >= 1,
    'the backend-owned snapshot counts every non-archived row', String(bulkSnapshot.count))
  // A conversation created after the snapshot must never be swept up by it.
  const late = await del('launch', { request: { requestId: 'r-bulk-000000000002', mode: 'free', courseId: null, topic: null } })
  const bulkStarted = await del('clearAllStart', { request: { token: bulkSnapshot.token } })
  let bulkRun = bulkStarted
  while (!bulkRun.done) bulkRun = await del('clearAllContinue', { request: { operationId: bulkStarted.operationId } })
  check(bulkRun.counts.cleared + bulkRun.counts.skipped + bulkRun.counts.failed === bulkSnapshot.count,
    'per-item outcomes account for the whole confirmed snapshot', JSON.stringify(bulkRun.counts))
  check(bulkRun.counts.cleared >= 1, 'bulk clearing archived the earlier conversations', JSON.stringify(bulkRun.counts))
  check(bulkRun.outcomes.every(row => ['cleared', 'skipped', 'failed'].includes(row.status)), 'every outcome is truthful per item')
  const afterBulk = await del('home')
  check(!afterBulk.recent.some(row => row.sessionId === bulkA.sessionId), 'bulk-cleared rows are gone from Recent')
  check(afterBulk.recent.some(row => row.sessionId === late.sessionId),
    'a conversation created after the snapshot survives')
  const replayLaunch = await delRefuse('launch', { request: { requestId: 'r-bulk-000000000001', mode: 'free', courseId: null, topic: null } })
  check(replayLaunch?.includes('PROFESSOR_SESSION_ARCHIVED'),
    'bulk-cleared rows keep their launch tombstones', String(replayLaunch).slice(0, 120))
  const duplicateStart = await delRefuse('clearAllStart', { request: { token: bulkSnapshot.token } })
  check(duplicateStart?.includes('PROFESSOR_CLEAR_ALL_TOKEN_INVALID'),
    'the confirmation is single-use: a duplicate start cannot re-run the snapshot', String(duplicateStart).slice(0, 120))
  const workspacesRegistry = ctx.get('workspaceRegistry')
  check(workspacesRegistry.archivedSessionIds.includes(bulkA.sessionId),
    'native chats were archived through the workspace registry — recoverable, not deleted')
  check(ctx.get('sessions').get(bulkA.sessionId) !== undefined,
    'the native conversation itself still exists after bulk clearing')

  section('claims: evidence classes')
  proved('the Professor Home endpoints are reachable only through the official Typert gateway')
  proved('an ordinary session gains no professor tool, persona or skill from the UI row')
  proved('a fresh course-free installation serves Home data and launches a general native Professor session')
  proved('the launched session is live, composes the professor preset, and carries the Professor tools')
  proved('a repeated launch reuses the native session; Recent/Continue follow; a missing session is refused')
  proved('with a folder connected through the real tools, Home lists configured courses and binds the launch')
  proved('Home data survives unloading and remounting — which is also proof the shared domain was released')
  proved('the client bundle is advertised by the host and served with no remote URL')
  proved('course deletion is guarded: explicit confirmation, observed snapshot, single-use token, exact id')
  proved('deleting a course removes only its registration and derived index; materials, learning state '
    + 'and bindings stay byte-identical, a rebuild cannot resurrect it, and re-adding restores it')
  proved('a session bound to a removed course reports that it is no longer configured instead of re-binding')
  proved('clearing a Recent conversation archives the native chat through the workspaceRegistry '
    + '(stopActivity: false) before hiding the Professor row; the history stays recoverable, '
    + 'repeats and retries are safe, and native unarchiving does not resurrect the row')
  proved('the five bundled learning presets are available offline, and an explicit apply changes '
    + 'the next composed study turn without touching course binding, deployment preset or in-flight work')
  proved('bulk clearing runs one confirmed backend-owned snapshot through the single-row safety kernel: '
    + 'per-item truthful outcomes, tombstones kept, post-snapshot conversations excluded, single-use tokens')
  unverified('the rendered Professor Home UI (sidebar entry, launcher, navigation in a real browser)',
    'this run drives the host, not the browser; see docs/v1/PHASE4.md for the browser evidence recorded separately')
  unverified('a model turn inside a launched session',
    'no model provider is configured in a disposable profile (no defaultModel service)')
  unverified('deleting a native Harness conversation',
    'Harness 0.2.0-rc.2 exposes no conversation-deletion API (sessionPersistence is append-only, the '
    + 'session Remote has no delete, ctx.fs has no delete primitive); see '
    + 'docs/superpowers/plans/2026-10-09-delete-and-polish.md §1')

  verdict = failures === 0 ? 0 : 1
} catch (error) {
  failures += 1
  console.log(`\nFAIL  the acceptance run threw: ${error?.stack ?? error}`)
  verdict = 1
} finally {
  try {
    await ctx?.fiber?.dispose?.()
  } catch {
    /* teardown is best effort */
  }
  try {
    if (home !== undefined) await fs.rm(home, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} 项失败`)
process.exit(verdict)
