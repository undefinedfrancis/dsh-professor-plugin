/**
 * Phase 1 acceptance — **a genuinely native general Professor session from the packaged artefact**.
 *
 * Why this is a separate verifier
 * -------------------------------
 * Phase 1's acceptance sentence is exact: *“actual installed package in an isolated real Harness
 * profile **starts a general Professor native session**, persona and six skills are available, no
 * legacy data is read as a requirement, and no course tree is created or guessed.”* The earlier
 * Phase 1 evidence covered everything in that sentence **except the first clause**, and the reports
 * said so while still calling the phase fully verified. That contradiction is what this run resolves.
 *
 * "Native session" is not a metaphor here. `ctx.agents.create()` is the harness's own factory: it
 * prepares a session, persists it through the configured `sessionPersistence` backend, builds an
 * Agent around it and publishes the agent loop. `ctx.agentPresets.select()` then binds the preset the
 * way the runtime does, appending `agent-preset/selected` to the **native session log**, and refuses
 * to do so once a turn has started. Nothing in this file fabricates a session.
 *
 * What this run deliberately does NOT do
 * --------------------------------------
 * It does **not** drive a model turn. That needs a configured model provider plus credentials,
 * network access and spend; a disposable profile has none of those (measured below: no `defaultModel`
 * service is mounted), and copying the user's real credentials or reusing the real desktop profile is
 * exactly the shortcut the brief forbids. The consequences are stated in the claims block at the end
 * rather than hidden: the *model's own behaviour* is unverified. That is a Phase 7/8 requirement, not
 * a Phase 1 one, and it is not being moved there quietly — it is called out below.
 *
 * Run with the harness Node (asar-aware); see the `verify:native-session` script.
 *
 * @module dsh-professor-spike/tools/verify-native-session
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as zlib from 'node:zlib'

import {
  HARNESS_ROOT,
  PACKAGE_NAME,
  createNativeSession,
  createProfessorProfile,
  executeTool,
  nativeSessionLog,
  resultJson,
  resultText,
  selectPreset,
  sessionSurface,
} from './packaged-profile.mjs'

/**
 * The repository under test (this file lives in `<repo>/tools`).
 *
 * `import.meta.url` is already a URL, so it is read through `new URL(...)` — passing it to
 * `pathToFileURL()` would URL-encode it a second time (`…/repo/file:/…/repo`) and hand every child
 * process a `cwd` that does not exist. The symptom is a misleading `spawnSync npm ENOENT`, which
 * looks like "npm is not installed". Section 1 therefore asserts this path exists.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A disposable profile name that cannot collide with a user's own. */
const PROFILE_NAME = 'professor-native-session'

/** The session id this run creates. Deliberately a *general* academic session: no course is bound. */
const SESSION_ID = 'professor-native-acceptance'

/** A second native session that never selects a preset, used as the scoping control. */
const CONTRAST_SESSION_ID = 'professor-native-contrast'

/** The six workflows this bundle ships. */
const EXPECTED_SKILLS = [
  'professor-course-management', 'professor-latex', 'professor-notes',
  'professor-research', 'professor-review', 'professor-study',
]

/** The twenty-one tools the preset contributes (fifteen through M11, the M2 memory trio, and the
 * Phase 3 onboarding trio). */
const EXPECTED_PROFESSOR_TOOLS = [
  'professor_artifact_create', 'professor_artifact_status', 'professor_course_list',
  'professor_course_manage', 'professor_diagnostics', 'professor_extract', 'professor_index_sync',
  'professor_latex_compile', 'professor_material_read', 'professor_memory_read', 'professor_memory_status',
  'professor_memory_update', 'professor_paths', 'professor_project_init', 'professor_search',
  'professor_session_bind', 'professor_session_status', 'professor_state_read',
  'professor_state_update', 'professor_workspace_confirm', 'professor_workspace_discover',
  'professor_workspace_rebuild',
]

/** The preset's persona ships in Chinese and opens with this phrase; a length check alone is weaker. */
const PERSONA_SENTINEL = '你是 Professor'
const PERSONA_MIN_CHARS = 1000

/** One course-required tool, chosen because it must be refused in a course-free session. */
const COURSE_REQUIRED_TOOL = 'professor_state_read'

/** Names that must not appear anywhere in the disposable home: legacy data this plugin never needs. */
const LEGACY_NAMES = new Set(['.hermes', 'Personal-Agent', 'Registry', 'Knowledge', 'PATHS.md', '01_Learning'])

/** Legacy locations a runtime configuration must never resolve to. */
const LEGACY_TOKENS = [/Personal-Agent/, /01_Learning/, /\.hermes/, /PATHS\.md/]

// --- scratch space and an isolated npm cache --------------------------------
//
// Same discipline as the other verifiers: `npm` writes to a global cache by default, so every child
// gets a private one, removed on every exit path including a thrown error.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-native-session-'))
const npmCache = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-native-session-npm-'))
const childEnv = { ...process.env, npm_config_cache: npmCache }

process.on('exit', () => {
  for (const directory of [temp, npmCache]) {
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
const proved = (label) => console.log(`PROVED      ${label}`)
const unverified = (label, why) => console.log(`UNVERIFIED  ${label}  — ${why}`)
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const exists = (candidate) => fs.stat(candidate).then(() => true, () => false)
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', env: childEnv, ...options })
const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])

/** Fingerprint a directory tree: relative path → sha256. */
async function digestTree(root, { exclude = new Set(['.git', '.workbuddy', 'node_modules']) } = {}) {
  const out = new Map()
  async function walk(relative) {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
    for (const entry of entries) {
      if (exclude.has(entry.name)) continue
      const next = relative.length === 0 ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(next)
      else if (entry.isFile()) out.set(next, sha256(await fs.readFile(path.join(root, next))))
    }
  }
  await walk('')
  return out
}

/** Every path under `root` whose *name* is (or is a Markdown form of) one of `names`. */
async function findNamed(root, names) {
  const hits = []
  async function walk(relative) {
    let entries
    try {
      entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const next = relative.length === 0 ? entry.name : `${relative}/${entry.name}`
      if (names.has(entry.name) || names.has(entry.name.replace(/\.md$/i, ''))) hits.push(next)
      if (entry.isDirectory()) await walk(next)
    }
  }
  await walk('')
  return hits
}

/** The real desktop profile's config files, by digest — proof this run never wrote to it. */
async function snapshotRealProfile() {
  const dir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
  const snap = {}
  for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
    const file = path.join(dir, name)
    snap[file] = (await exists(file)) ? sha256(await fs.readFile(file, 'utf8')) : null
  }
  return { dir, snap }
}

/** The runtime configuration files this run actually resolves. */
async function collectRuntimeConfigs(home) {
  const found = []
  const push = async (file) => {
    if (await exists(file)) found.push({ file, text: await fs.readFile(file, 'utf8') })
  }
  await push(path.join(home, 'profiles', PROFILE_NAME, 'package.json'))
  await push(path.join(home, 'profiles', PROFILE_NAME, 'cordis.yml'))
  await push(path.join(home, 'profiles', PROFILE_NAME, 'cordis.patch.yml'))
  for (const bundle of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PACKAGE_NAME]) {
    await push(path.join(home, 'profiles', PROFILE_NAME, 'node_modules', bundle, 'package.json'))
  }
  await push(path.join(home, 'profiles', PROFILE_NAME, 'node_modules', PACKAGE_NAME, 'cordis.patch.yml'))
  return found
}

/** The expected `professor_*` tool set, exactly — sorted on both sides. */
function expectedToolsVisible(visible) {
  return same(visible, [...EXPECTED_PROFESSOR_TOOLS].sort())
}

/**
 * The session directory the native layer created for one session id.
 *
 * The directory name encodes the cwd (`--tmp-…-workspace--`, with non-ASCII escaped), so this
 * searches for the *session id* rather than re-implementing that encoding: a naming scheme nobody
 * promises to keep is not something a verifier should depend on.
 */
async function locateSessionDirectory(sessionsRoot, sessionId) {
  const entries = await fs.readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(sessionsRoot, entry.name, sessionId)
    if (await exists(candidate)) return candidate
  }
  return undefined
}

/** The first line of a native session log — the header event the native layer writes itself. */
async function readSessionHeader(bytes) {
  if (typeof zlib.zstdDecompressSync !== 'function') return undefined
  try {
    const first = zlib.zstdDecompressSync(bytes).toString('utf8')
      .split('\n').find((line) => line.trim().length > 0)
    return first === undefined ? undefined : JSON.parse(first)
  } catch {
    return undefined
  }
}

let verdict = 1

try {
  console.log('Phase 1 acceptance — a native Professor session from the packaged artefact')
  console.log(`host:             ${HARNESS_ROOT}`)
  console.log('claim boundary:   a NATIVE SESSION is created and its own runtime is read; no model turn is run')

  // ─── 1. pack and install the exact artefact ───────────────────────────────
  section('1. the artefact under test')
  // Asserted first on purpose: a wrong root turns every later `cwd` into a spawn ENOENT, and the
  // resulting message blames npm rather than the path. See the REPO doc comment.
  check(await exists(path.join(REPO, 'package.json')), 'the repository root resolved to a real checkout', REPO)
  const packDir = path.join(temp, 'pack')
  await fs.mkdir(packDir, { recursive: true })
  const packed = JSON.parse(run('npm', ['pack', '--pack-destination', packDir, '--json'], { cwd: REPO }))
  check(Array.isArray(packed) && packed.length === 1, 'npm pack produced exactly one tarball')
  const tarball = path.join(packDir, packed[0].filename)
  const tarballBytes = await fs.readFile(tarball)
  const shipped = packed[0].files.map((entry) => `package/${entry.path}`)
  console.log(`tarball: ${packed[0].filename}  sha256:${sha256(tarballBytes).slice(0, 16)}…  ${shipped.length} files`)

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-professor-native-'))
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_DISABLED = '1'
  const workspace = await fs.mkdtemp(path.join(home, 'general-workspace-'))
  const repoBefore = await digestTree(REPO)
  const profileBefore = await snapshotRealProfile()

  const { installedDir } = await createProfessorProfile({ home, profileName: PROFILE_NAME, tarball, run })
  const installedStat = await fs.lstat(installedDir)
  check(installedStat.isDirectory() && !installedStat.isSymbolicLink(),
    'the installed bundle is a real directory, not a symlink')
  const realInstalled = await fs.realpath(installedDir)
  const realRepo = await fs.realpath(REPO)
  check(realInstalled !== realRepo && !realInstalled.startsWith(`${realRepo}${path.sep}`),
    'the installed bundle does not resolve back into the source checkout', realInstalled)
  console.log(`installed: ${installedDir}`)

  // ─── 2. a clean room ─────────────────────────────────────────────────────
  section('2. a clean room')
  const legacyHits = await findNamed(home, LEGACY_NAMES)
  check(legacyHits.length === 0, 'the disposable home contains no Hermes / Personal-Agent / legacy academic data',
    legacyHits.slice(0, 3).join(', '))
  check(!(await exists(path.join(workspace, '.professor'))),
    'the session workspace is NOT an academic folder')
  const workspaceBefore = await fs.readdir(workspace)
  check(workspaceBefore.length === 0, 'the session workspace starts empty', `${workspaceBefore.length} entries`)

  // ─── 3. boot the installed copy ──────────────────────────────────────────
  section('3. boot the installed copy')
  const { bootProfessorProfile } = await import(pathToFileURL(path.join(REPO, 'tools/packaged-profile.mjs')).href)
  const { ctx } = await bootProfessorProfile({ home, profileName: PROFILE_NAME, workspace })
  check(ctx !== undefined, 'the real Cordis loader booted the disposable profile')
  check(ctx.get('agents') !== undefined, 'the host agent factory is mounted (ctx.agents)')
  check(ctx.get('agentPresets') !== undefined, 'the preset registry is mounted (ctx.agentPresets)')
  check(ctx.get('sessionPersistence') !== undefined, 'native session persistence is mounted')
  const defaultModel = ctx.get('defaultModel')
  console.log(`defaultModel: ${defaultModel === undefined ? 'ABSENT (no model is configured in this profile)' : 'present'}`)

  // ─── 4. a genuinely native general Professor session ──────────────────────
  section('4. a genuinely native general Professor session')
  const { handle, agent, session } = await createNativeSession({ ctx, sessionId: SESSION_ID, workspace })
  check(agent?.id === SESSION_ID, 'the host factory created an agent under the requested session id', String(agent?.id))
  const live = ctx.get('sessions').get(SESSION_ID)
  check(live !== undefined, 'the session is live in the native session store')
  check(live?.header?.id === SESSION_ID && live?.header?.cwd === workspace,
    'the native session header records this session and this (non-academic) workspace',
    JSON.stringify({ id: live?.header?.id, cwd: live?.header?.cwd }))
  check(typeof live?.header?.createdAt === 'number', 'the native layer stamped the session header itself')

  const presetBefore = await ctx.get('agentPresets').composedPreset(agent.ctx)
  check(presetBefore === undefined, 'before selection the session is NOT a Professor session', String(presetBefore))

  const committed = await selectPreset({ ctx, agent, presetId: 'professor' })
  check(committed === 'professor', 'the harness committed the professor preset for this session', String(committed))
  const presetAfter = await ctx.get('agentPresets').composedPreset(agent.ctx)
  check(presetAfter === 'professor', 'the live agent now composes the professor preset', String(presetAfter))

  const log = nativeSessionLog(agent)
  const selected = log.filter((event) => event.type === 'agent-preset/selected')
  check(selected.length === 1 && selected[0].data?.agentPreset === 'professor',
    'the NATIVE session log records the preset selection itself',
    JSON.stringify(selected.map((event) => event.data)))

  // ─── 5. the runtime this session resolves for itself ─────────────────────
  section('5. the runtime this session resolves for itself')
  console.log(`reading through the host's own assembleContextFor(agent) — scope: agent`)
  const surface = await sessionSurface({ ctx, agent, workspace })

  check(surface.persona.length >= PERSONA_MIN_CHARS,
    `the session's own prompt carries the Professor persona (>= ${PERSONA_MIN_CHARS} chars)`,
    `${surface.persona.length} chars`)
  check(surface.persona.includes(PERSONA_SENTINEL),
    'the persona is the Professor text, not a generic one', JSON.stringify(surface.persona.slice(0, 40)))
  check(surface.sections.some((entry) => entry.name === 'deployment:persona-prefix'),
    'it arrives as the deployment persona prefix section the host assembles',
    `${surface.sections.length} sections`)

  const professorTools = surface.visibleTools.filter((name) => name.startsWith('professor_'))
  check(expectedToolsVisible(professorTools),
    `all ${EXPECTED_PROFESSOR_TOOLS.length} professor_* tools are visible to this session`,
    `${professorTools.length} professor tools of ${surface.visibleTools.length} total`)
  check(EXPECTED_PROFESSOR_TOOLS.every((name) => surface.assemblyTools.includes(name)),
    'and they are in the tool list the model would be offered',
    `${surface.assemblyTools.length} tools offered`)
  check(same(surface.skills, [...EXPECTED_SKILLS].sort()), 'the six bundled skills are available to this session',
    surface.skills.join(', '))

  const diagnostics = await executeTool({ ctx, agent, name: 'professor_diagnostics', label: 'native-diagnostics' })
  const payload = resultJson(diagnostics)
  check(diagnostics?.isError === false, 'a real tool call through the real pipeline succeeds in this session',
    diagnostics?.error?.message ?? '')
  check(payload?.project?.bound === false, 'the session is genuinely course-free (projectBound false)',
    String(payload?.project?.bound))
  check(payload?.appStorage?.status === 'open',
    'Professor application storage opened inside the native session', String(payload?.appStorage?.status))

  const refused = await executeTool({
    ctx, agent, name: COURSE_REQUIRED_TOOL, args: { course: 'CSC3200' }, label: 'native-refusal',
  })
  check(refused?.isError === true && /no academic folder is connected/.test(resultText(refused) + (refused?.error?.message ?? '')),
    'a course-required tool is refused descriptively with no course connected')

  // ─── 6. the control: a native session with no preset ─────────────────────
  section('6. the control: a native session with no preset')
  const { agent: plain } = await createNativeSession({ ctx, sessionId: CONTRAST_SESSION_ID, workspace })
  const plainSurface = await sessionSurface({ ctx, agent: plain, workspace })
  check(await ctx.get('agentPresets').composedPreset(plain.ctx) === undefined,
    'the control session composes no preset')
  check(!plainSurface.persona.includes(PERSONA_SENTINEL),
    'and does NOT receive the Professor persona',
    `${plainSurface.persona.length} chars: ${JSON.stringify(plainSurface.persona.slice(0, 32))}`)
  check(plainSurface.visibleTools.filter((name) => name.startsWith('professor_')).length === 0,
    'nor any professor_* tool', `${plainSurface.visibleTools.length} tools visible`)
  check(plainSurface.skills.length === 0, 'nor any bundled Professor skill', plainSurface.skills.join(', '))

  // ─── 7. the native session is recorded and durable ───────────────────────
  section('7. the native session is recorded and durable')
  await ctx.get('sessions').flush(session).then(() => true, () => false)
  const sessionsRoot = path.join(home, 'sessions')
  const sessionDir = await locateSessionDirectory(sessionsRoot, SESSION_ID)
  check(sessionDir !== undefined, 'the native layer persisted a session directory of its own',
    sessionDir === undefined ? `not found under ${sessionsRoot}` : sessionDir)
  if (sessionDir !== undefined) {
    const logFile = path.join(sessionDir, 'session.v4.jsonl.zstd')
    const bytes = await fs.readFile(logFile).catch(() => undefined)
    check(bytes !== undefined, 'and wrote the native session log file', path.basename(logFile))
    if (typeof zlib.zstdDecompressSync !== 'function') {
      console.log('NOTE        node:zlib zstd support is unavailable in this runtime; the header event was not decoded')
    } else {
      const header = bytes === undefined ? undefined : await readSessionHeader(bytes)
      check(header?.type === 'session' && header?.id === SESSION_ID,
        'whose own header event names this session',
        header === undefined ? 'could not be decoded' : JSON.stringify(header.id))
      check(header?.cwd === workspace, 'and records the same non-academic workspace', String(header?.cwd))
    }
    console.log('NOTE        the remaining log events stay in the native in-memory log until a turn')
    console.log('            advances persistence; the selection is asserted above from that log.')
  }

  // ─── 8. nothing was created or read that should not have been ────────────
  section('8. course-free, legacy-free')
  const workspaceAfter = await fs.readdir(workspace)
  check(workspaceAfter.length === 0, 'no course tree was created or guessed in the workspace',
    `${workspaceAfter.length} entries`)
  check(!(await exists(path.join(workspace, '.professor'))), 'no .professor/ directory was created')
  const legacyAfter = await findNamed(home, LEGACY_NAMES)
  check(legacyAfter.length === 0, 'still no legacy data anywhere in the disposable home',
    legacyAfter.slice(0, 3).join(', '))

  const configs = await collectRuntimeConfigs(home)
  check(configs.length >= 5, 'every runtime configuration source this run resolves was inspected',
    `${configs.length} files`)
  const legacyReferences = configs.flatMap(({ file, text }) =>
    LEGACY_TOKENS.filter((pattern) => pattern.test(text)).map((pattern) => `${path.basename(file)}: ${pattern}`))
  check(legacyReferences.length === 0,
    'no runtime configuration references a Hermes / Personal-Agent / legacy academic location',
    legacyReferences.join(', '))
  const hostRoot = await fs.realpath(HARNESS_ROOT)
  const foreign = configs.flatMap(({ file, text }) => [...text.matchAll(/"(\/[^"]+)"/g)]
    .map((match) => match[1])
    .filter((candidate) => !candidate.startsWith(home) && !candidate.startsWith(hostRoot))
    .map((candidate) => `${path.basename(file)}: ${candidate}`))
  check(foreign.length === 0, 'and none points outside the disposable home and the host install',
    foreign.slice(0, 3).join(', '))

  // ─── 9. nothing else changed ─────────────────────────────────────────────
  section('9. nothing else changed')
  const repoAfter = await digestTree(REPO)
  const repoDrift = [...repoBefore.keys()].filter((file) => repoAfter.get(file) !== repoBefore.get(file))
  check(repoDrift.length === 0 && repoAfter.size === repoBefore.size,
    'the source checkout is byte-identical after the run', repoDrift.slice(0, 3).join(', '))
  const profileAfter = await snapshotRealProfile()
  check(JSON.stringify(profileAfter.snap) === JSON.stringify(profileBefore.snap),
    'the real desktop profile was not written by this run', profileAfter.dir)
  const tarballAfter = await fs.readFile(tarball)
  check(sha256(tarballAfter) === sha256(tarballBytes), 'the packed artefact was not modified by the install')
  const installedFiles = await digestTree(installedDir)
  check(installedFiles.size === shipped.length,
    'the installed copy still holds exactly the packed files', `${installedFiles.size} of ${shipped.length}`)

  // ─── claims ──────────────────────────────────────────────────────────────
  section('claims: evidence classes')
  proved('native session creation through the host\'s own agent factory (ctx.agents.create)')
  proved('native preset binding, recorded by the native layer as agent-preset/selected')
  proved('the session\'s OWN assembled prompt carries the Professor persona (sentinel + minimum length)')
  proved(`the session's OWN tool view carries all ${EXPECTED_PROFESSOR_TOOLS.length} professor_* tools, and the six skills`)
  proved('a control session with no preset gets none of it — the surface is scoped, not global')
  proved('a real tool call in the native session: course-free diagnostics, and a descriptive refusal')
  unverified('a model turn / the model\'s reply',
    'no model provider is configured in a disposable profile (no defaultModel service is mounted); a turn needs credentials, network and spend')
  unverified('model-driven tool selection',
    'the tool calls above are dispatched by this verifier, not chosen by a model')
  unverified('the Phase 4 sidebar / UI shell',
    'out of scope for Phase 1 by the acceptance brief')
  console.log('NOTE        the model-turn items above are Phase 7/8 requirements, NOT Phase 1 clauses;')
  console.log('            nothing here moves a Phase 1 requirement to a later phase.')

  handle.dispose?.()

  verdict = failures === 0 ? 0 : 1
  await fs.rm(home, { recursive: true, force: true })
  console.log(`\ndisposable home removed: ${home}`)
} catch (error) {
  failures += 1
  console.log(`\nFAIL  the acceptance run threw: ${error?.stack ?? error}`)
  verdict = 1
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} 项失败`)
process.exit(verdict)
