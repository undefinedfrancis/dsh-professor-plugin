/**
 * Packaged Phase 3 acceptance: academic-folder onboarding and derived indexing, end to end.
 *
 * What this proves, and why it needs a packaged profile
 * ----------------------------------------------------
 * `test/onboarding.test.mjs` pins the plugin's own rules against a fake host, where the filesystem,
 * the sandbox and the tool registry are stand-ins. That is the right place for contract tests, but it
 * cannot answer the Phase 3 acceptance question, which is about the **installed artefact** on the
 * **real host**: can a user connect an academic folder without editing YAML and without importing a
 * legacy registry, and does the derived index behave incrementally afterwards?
 *
 * So this run packs the repository, installs *that exact tarball* into a disposable Harness profile,
 * boots the real Cordis loader, and drives the new entry points through the **real tool pipeline** —
 * guards, schema validation, policy and projection included. It never imports the checkout at
 * runtime and never calls a plugin function directly.
 *
 * The ten steps, mapped to the brief's §7
 * ---------------------------------------
 *   1.  **discover without YAML** — a fixture academic folder is proposed read-only, and discovery
 *       creates no `.professor/` and touches no byte of the folder.
 *   2.  **confirm / edit** — only the confirmed folders are registered; an ambiguous folder is given
 *       an explicit identity by the caller; one folder is excluded.
 *   3.  **apply** — `.professor/project.yaml` exists and every accepted course is in it.
 *   4.  **index + extract** — the four readiness states are reported separately and all four are met.
 *   5.  **search + provenance** — material is searchable with an honest `relative_path`, course and
 *       category, and the excluded folder is not a source.
 *   6.  **add / change / remove** — the index reports one added, one changed and one missing record.
 *   7.  **incremental** — unchanged extraction is reused, the changed file is re-extracted, the
 *       superseded text is gone and the removed material is not searchable.
 *   8.  **rebuild** — `professor_workspace_rebuild` re-derives the indexes and leaves the
 *       configuration, the learning state and every original byte for byte unchanged.
 *   9.  **restart** — a **fresh host process** (`tools/verify-onboarding-restore.mjs`, run from the
 *       installed copy) finds the connection record, re-resolves the recorded folder, and proves it
 *       wrote by leaving a record of its own.
 *  10.  **nothing changed** — the fixture sources, the source checkout, the packed artefact, the
 *       installed copies and the real desktop profile are all fingerprinted before and after.
 *
 * ## What this run does NOT claim
 *
 * It drives no model turn: no provider is configured in a disposable profile, and starting one would
 * mean network access and spend. Tool calls here are dispatched by this verifier, so "the model
 * chooses to call `professor_workspace_confirm`" is *not* proved — it is printed as `UNVERIFIED`.
 *
 * Run it with the harness Node (asar-aware):
 *
 *   npm run verify:onboarding
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import {
  HARNESS_BIN,
  HARNESS_ROOT,
  PACKAGE_NAME,
  attachSession,
  bootProfessorProfile,
  createProfessorProfile,
  executeTool,
  findProfessorScope,
  resultJson,
  resultText,
  visibleTools,
} from './packaged-profile.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_NAME = 'professor-onboarding-acceptance'
const RESTORE_SCRIPT = 'tools/verify-onboarding-restore.mjs'

/** Every `professor_*` tool the packaged plugin must register, including the Phase 3 trio. */
const EXPECTED_TOOLS = [
  'professor_artifact_create',
  'professor_artifact_status',
  'professor_course_list',
  'professor_course_manage',
  'professor_diagnostics',
  'professor_extract',
  'professor_index_sync',
  'professor_latex_compile',
  'professor_material_read',
  'professor_memory_read',
  'professor_memory_status',
  'professor_memory_update',
  'professor_paths',
  'professor_project_init',
  'professor_search',
  'professor_session_bind',
  'professor_session_status',
  'professor_state_read',
  'professor_state_update',
  'professor_workspace_confirm',
  'professor_workspace_discover',
  'professor_workspace_rebuild',
]

/** Names that must not appear anywhere in the disposable home: legacy data this plugin never needs. */
const LEGACY_NAMES = ['.hermes', 'Personal-Agent', 'Registry', 'registry.json', 'Knowledge', 'Knowledge.md', 'PATHS.md', 'SOUL.md', '01_Learning']

/** Legacy locations a runtime configuration must never resolve to. */
const LEGACY_TOKENS = [/\.hermes\b/, /Personal-Agent/, /PERSONAL_AGENT_ROOT/, /PATHS\.md/, /01_Learning/]

/** One global preference the restart probe writes, so the parent can prove the child really wrote. */
const RESTART_PREFERENCE_KEY = 'onboarding_restart_probe'
const RESTART_PREFERENCE_VALUE = `written-by-child-${Date.now()}`

// --- scratch space and an isolated npm cache --------------------------------
//
// Same discipline as the other packaged verifiers: `npm` writes to a global cache by default, which
// on a shared machine can be unusable. Every child gets a private cache, removed on every exit path.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-onboarding-'))
const npmCache = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-onboarding-npm-'))
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
const unverified = (label, why) => console.log(`UNVERIFIED  ${label}  — ${why}`)
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const exists = (candidate) => fs.stat(candidate).then(() => true, () => false)
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', env: childEnv, ...options })

/** Write one fixture file, creating its parents. */
async function writeFixture(root, relative, content) {
  const target = path.join(root, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf8')
  return target
}

/**
 * Fingerprint every source file under `root`, excluding Professor's own derived state.
 *
 * `.professor/` is Professor-owned derived state, never source material, so it is deliberately out of
 * the invariance claim — everything else must be byte-identical.
 */
async function digestSources(root, { exclude = new Set(['.professor']) } = {}) {
  const out = new Map()
  async function walk(relative) {
    let entries
    try {
      entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
    } catch {
      return
    }
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

/** Fingerprint a whole tree, used to prove the checkout and the installed copies never changed. */
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

/** Every path under `root` whose *name* matches one of `names`. */
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

/** The configuration a boot actually resolves, scanned for legacy references. */
async function configurationSources(home, profiles, installedDirs) {
  const files = []
  for (const profileName of profiles) {
    const dir = path.join(home, 'profiles', profileName)
    files.push(path.join(dir, 'package.json'), path.join(dir, 'cordis.yml'))
  }
  for (const installedDir of installedDirs) files.push(path.join(installedDir, 'cordis.patch.yml'))
  const out = []
  for (const file of files) {
    if (await exists(file)) out.push({ file, text: await fs.readFile(file, 'utf8') })
  }
  return out
}

/** Call one tool through the real pipeline and require a structured payload. */
async function callTool({ ctx, agent, name, args = {}, label = name }) {
  const result = await executeTool({ ctx, agent, name, args, label })
  const payload = resultJson(result)
  return { result, payload, isError: result.isError === true, text: resultText(result) }
}

let verdict = 1
try {
  // ─── 0. fingerprints before anything runs ──────────────────────────────────
  section('fingerprints before the run')
  const repoBefore = await digestTree(REPO)
  const profileBefore = await snapshotRealProfile()
  console.log(`source checkout:   ${REPO} (${repoBefore.size} files)`)
  console.log(`real profile:      ${profileBefore.dir}`)
  console.log(`private npm cache: ${npmCache}`)

  // ─── 1. pack the exact artefact ───────────────────────────────────────────
  section('1. pack the exact artefact')
  const packDir = path.join(temp, 'pack')
  await fs.mkdir(packDir, { recursive: true })
  const packed = JSON.parse(run('npm', ['pack', '--pack-destination', packDir, '--json'], { cwd: REPO }))
  check(Array.isArray(packed) && packed.length === 1, 'npm pack produced exactly one tarball')
  const tarball = path.join(packDir, packed[0].filename)
  const tarballDigest = sha256(await fs.readFile(tarball))
  const shipped = packed[0].files.map((entry) => `package/${entry.path}`)
  check(packed[0].version === JSON.parse(await fs.readFile(path.join(REPO, 'package.json'), 'utf8')).version,
    'the tarball version matches package.json', packed[0].version)
  check(shipped.includes('package/tools/verify-onboarding-restore.mjs'),
    'the restart probe is shipped inside the tarball')
  check(shipped.includes('package/src/workspace/onboarding.js'),
    'the onboarding service is shipped inside the tarball')
  console.log(`tarball: ${packed[0].filename}  sha256:${tarballDigest.slice(0, 16)}…  ${shipped.length} files`)

  // ─── 2. install it into a disposable profile ──────────────────────────────
  section('2. install the exact artefact into a disposable profile')
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-professor-onboarding-')))
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_DISABLED = '1'
  console.log(`disposable Harness home: ${home}`)

  // The academic folder *is* the session workspace, which is what a user's Professor session looks
  // like when they open their course folder. It also keeps every write inside the sandbox's own
  // workspace root, so nothing here depends on a widened permission.
  const academic = path.join(home, 'courses')
  await fs.mkdir(academic, { recursive: true })

  const { installedDir, manifest } = await createProfessorProfile({
    home, profileName: PROFILE_NAME, tarball, run,
  })
  check(await exists(path.join(installedDir, 'package.json')), 'the bundle is present in the profile node_modules')
  const installedStat = await fs.lstat(installedDir)
  check(installedStat.isDirectory() && !installedStat.isSymbolicLink(), 'the installed bundle is a real directory, not a symlink')
  const realInstalled = await fs.realpath(installedDir)
  const realRepo = await fs.realpath(REPO)
  check(!realInstalled.startsWith(`${realRepo}${path.sep}`) && realInstalled !== realRepo,
    'the installed bundle does not resolve back into the source checkout', realInstalled)
  check(manifest.dsh.profile.bundles.includes(PACKAGE_NAME), 'the bundle is registered in the profile bundle list')

  const mismatched = []
  for (const entry of shipped) {
    const relative = entry.slice('package/'.length)
    const installedPath = path.join(installedDir, relative)
    if (!(await exists(installedPath))) { mismatched.push(`${relative} (missing)`); continue }
    const [inRepo, inInstalled] = await Promise.all([fs.readFile(path.join(REPO, relative)), fs.readFile(installedPath)])
    if (sha256(inRepo) !== sha256(inInstalled)) mismatched.push(relative)
  }
  check(mismatched.length === 0, `all ${shipped.length} packed files are byte-identical after installation`,
    mismatched.slice(0, 3).join(', '))

  // The tool names come from the *installed* artefact, so a rename cannot pass by coincidence: the
  // surface the real registry exposes is checked against what the shipped module exports.
  const installedOnboarding = await import(pathToFileURL(path.join(installedDir, 'src/workspace/onboarding.js')).href)
  const REBUILD_TOOL = installedOnboarding.WORKSPACE_REBUILD_TOOL_NAME
  const exportedNames = [
    installedOnboarding.WORKSPACE_DISCOVER_TOOL_NAME,
    installedOnboarding.WORKSPACE_CONFIRM_TOOL_NAME,
    installedOnboarding.WORKSPACE_REBUILD_TOOL_NAME,
  ].sort()
  check(exportedNames.join(',') === 'professor_workspace_confirm,professor_workspace_discover,professor_workspace_rebuild',
    'the installed module exports the three onboarding tool names', exportedNames.join(','))
  check(installedOnboarding.WORKSPACE_RECORD_SCHEMA === 'professor.workspace/1',
    'the installed module declares the connection-record schema', String(installedOnboarding.WORKSPACE_RECORD_SCHEMA))

  // ─── 3. the fixture academic folder ───────────────────────────────────────
  section('3. the fixture academic folder (nothing is hand-written for the plugin)')
  const FIXTURE = [
    ['CSC3200/01_Lectures/lecture01.txt', 'alphamarker\n'],
    ['CSC3200/03_Assignments/hw1.txt', 'assignment one\n'],
    ['STA2001/01_Lectures/lecture01.txt', 'keepmarker\n'],
    ['PHY1001/05_Exams/midterm.txt', 'midtermmarker\n'],
    ['PHY1001/00_Course-Info/syllabus.txt', 'syllabus text\n'],
    ['PHY1001/06_Code/vector.txt', 'vector code\n'],
    ['Algorithms/01_Lectures/lecture01.txt', 'algorithms lecture\n'],
    ['Photos/cover.png', 'not a document\n'],
    ['Archive/data.bin', 'binary blob\n'],
  ]
  for (const [relative, content] of FIXTURE) await writeFixture(academic, relative, content)
  const sourcesBeforeDiscovery = await digestSources(academic)
  check(sourcesBeforeDiscovery.size === FIXTURE.length, 'the fixture folder holds exactly its source files',
    `${sourcesBeforeDiscovery.size}`)
  const legacyHits = await findNamed(home, new Set(LEGACY_NAMES))
  check(legacyHits.length === 0, 'the disposable home contains no Hermes / Personal-Agent / Registry / Knowledge artefact',
    legacyHits.slice(0, 5).join(', '))

  // ─── 4. boot the real host ────────────────────────────────────────────────
  section('4. boot the real Harness and attach a live session')
  const booted = await bootProfessorProfile({ home, profileName: PROFILE_NAME, workspace: academic })
  const { ctx, layers } = booted
  check(ctx.fiber?.state === 2, 'the composed tree reached the active state', String(ctx.fiber?.state))
  check(layers.includes(PACKAGE_NAME), 'the loader registered the bundle layer', layers.join(', '))

  const scope = await findProfessorScope(ctx)
  check(scope !== undefined, 'the registry holds a live mount for the running composition')
  const tools = visibleTools(ctx, scope)
  const missingTools = EXPECTED_TOOLS.filter((name) => !tools.includes(name))
  check(missingTools.length === 0, `all ${EXPECTED_TOOLS.length} professor tools are registered`, missingTools.join(', '))

  const { agent } = attachSession({ ctx, scope, workspace: academic })
  const call = (name, args, label = name) => callTool({ ctx, agent, name, args, label })

  // ─── 5. step 1: discover without YAML ─────────────────────────────────────
  section('5. step 1 — discover, read-only, with no project.yaml anywhere')
  check(!(await exists(path.join(academic, '.professor'))), 'there is no .professor directory before discovery')
  const discovery = await call(installedOnboarding.WORKSPACE_DISCOVER_TOOL_NAME, { folder: academic })
  check(discovery.isError !== true, 'professor_workspace_discover executes', discovery.text.slice(0, 200))
  const proposal = discovery.payload?.proposal ?? null
  check(discovery.payload?.ok === true && proposal !== null, 'discovery returns a proposal',
    JSON.stringify(discovery.payload?.problems ?? []))
  check(proposal?.fingerprint?.length === 64, 'the proposal carries a sha256 fingerprint', String(proposal?.fingerprint?.length))
  check(proposal?.schema === 'professor.onboarding/1', 'the proposal declares its contract version', String(proposal?.schema))

  const candidateAt = (relative) => (proposal?.candidates ?? []).find((entry) => entry.relative_path === relative)
  for (const code of ['CSC3200', 'STA2001', 'PHY1001']) {
    const candidate = candidateAt(code)
    check(candidate?.kind === 'course' && candidate?.confidence === 'high' && candidate?.proposed?.course_code === code,
      `${code} is proposed as a high-confidence course`, JSON.stringify(candidate?.proposed ?? null))
  }
  const ambiguous = candidateAt('Algorithms')
  check(ambiguous?.needs_confirmation === true && ambiguous?.proposed?.course_code === null,
    'an ambiguous folder is proposed as a question with no invented identity',
    JSON.stringify(ambiguous?.proposed ?? null))
  check(candidateAt('Photos')?.kind === 'unrelated', 'a folder with no document-like file is reported as unrelated',
    String(candidateAt('Photos')?.kind))
  const exams = candidateAt('PHY1001')?.categories?.exams ?? []
  const supplementary = (candidateAt('PHY1001')?.categories?.supplementary ?? []).map((entry) => entry.name).sort()
  check(exams.map((entry) => entry.name).join(',') === '05_Exams', 'an explicit exam directory is classified as exams',
    exams.map((entry) => entry.name).join(','))
  check(supplementary.join(',') === '00_Course-Info,06_Code',
    '06_Code and 00_Course-Info are supplementary, never exams', supplementary.join(','))
  check(!(await exists(path.join(academic, '.professor'))),
    'discovery created no .professor directory — it cannot have written anything')
  const afterDiscovery = await digestSources(academic)
  check(JSON.stringify([...afterDiscovery]) === JSON.stringify([...sourcesBeforeDiscovery]),
    'every fixture source file is byte-identical after discovery')

  // ─── 6. step 2–3: confirm, edit, apply ────────────────────────────────────
  section('6. steps 2-3 — confirm the proposal, edit one identity, exclude one folder')
  const confirmation = await call(installedOnboarding.WORKSPACE_CONFIRM_TOOL_NAME, {
    proposal,
    selections: [
      { relative_path: 'CSC3200', action: 'include' },
      { relative_path: 'STA2001', action: 'include' },
      { relative_path: 'PHY1001', action: 'include' },
      { relative_path: 'Algorithms', action: 'include', course_code: 'CS2210', display_name: 'Algorithms' },
      { relative_path: 'Archive', action: 'exclude' },
    ],
  }, 'confirm')
  check(confirmation.isError !== true, 'professor_workspace_confirm executes', confirmation.text.slice(0, 200))
  const applied = confirmation.payload ?? {}
  check(applied.ok === true && applied.applied === true, 'the confirmed onboarding was applied',
    JSON.stringify(applied.problems ?? []))
  const registered = (applied.courses?.registered ?? []).map((entry) => entry.course_code).sort()
  check(registered.join(',') === 'CS2210,CSC3200,PHY1001,STA2001',
    'exactly the confirmed folders were registered, including the edited identity', registered.join(','))
  check((applied.courses?.preserved ?? []).length === 0, 'nothing was reported as already registered on a first run')
  const pending = (applied.courses?.pending ?? []).map((entry) => entry.relative_path)
  check(!pending.includes('Algorithms'), 'the edited folder is no longer pending', pending.join(','))
  const excluded = (applied.courses?.excluded ?? []).map((entry) => entry.relative_path)
  check(excluded.join(',') === 'Archive', 'the excluded folder is reported as excluded', excluded.join(','))

  const projectFile = path.join(academic, '.professor', 'project.yaml')
  check(await exists(projectFile), 'the configuration was saved to .professor/project.yaml', projectFile)
  const projectText = await fs.readFile(projectFile, 'utf8')
  for (const code of ['CSC3200', 'STA2001', 'PHY1001', 'CS2210']) {
    check(projectText.includes(`course_code: ${code}`), `${code} is in the persisted configuration`)
  }
  check(/indexing:/.test(projectText) && projectText.includes('Archive'),
    'the excluded folder is persisted through the existing indexing.exclude escape hatch')

  // ─── 7. step 4: the four readiness states ─────────────────────────────────
  section('7. step 4 — index and extraction, reported as four separate states')
  const readiness = applied.readiness ?? {}
  check(readiness.configuration?.saved === true, 'readiness: the configuration is saved')
  check(readiness.index?.complete === true, 'readiness: the file index is complete',
    JSON.stringify(readiness.index ?? null))
  check(readiness.extraction?.complete === true, 'readiness: extraction is complete',
    JSON.stringify(readiness.extraction ?? null))
  check(readiness.searchable === true, 'readiness: the material is searchable')
  check(Array.isArray(readiness.partial) && readiness.partial.length === 0, 'readiness: nothing is partial',
    (readiness.partial ?? []).join(' | '))
  check(readiness.retry === null, 'readiness: no retry is needed', String(readiness.retry))
  const expectedSourceCount = FIXTURE.filter(([relative]) => !relative.startsWith('Archive/')).length
  check((readiness.index?.total ?? 0) === expectedSourceCount, 'the index covers every non-excluded fixture file',
    `${readiness.index?.total} of ${expectedSourceCount}`)
  check(readiness.index?.excluded >= 1, 'the excluded folder was kept out of the index',
    `excluded=${readiness.index?.excluded}`)

  // ─── 8. step 5: search with honest provenance ─────────────────────────────
  section('8. step 5 — the material is searchable with honest provenance')
  const examSearch = await call('professor_search', { query: 'midtermmarker' }, 'search-exam')
  const examHit = examSearch.payload?.results?.[0] ?? null
  check(examSearch.payload?.results?.length === 1, 'the exam material is found exactly once',
    JSON.stringify(examSearch.payload?.diagnostics ?? null))
  check(examHit?.relative_path === 'PHY1001/05_Exams/midterm.txt', 'the hit names its real source file',
    String(examHit?.relative_path))
  check(examHit?.course_id === 'phy1001', 'the hit carries the course it belongs to', String(examHit?.course_id))
  check(examHit?.category === 'exams', 'the hit carries its category', String(examHit?.category))

  const archiveSearch = await call('professor_search', { query: 'binary blob' }, 'search-excluded')
  check((archiveSearch.payload?.results ?? []).length === 0,
    'the excluded folder is not searchable — exclusion is persisted, not merely reported',
    JSON.stringify(archiveSearch.payload?.results ?? []))

  // ─── 9. step 6–7: add, change, remove → incremental ───────────────────────
  section('9. steps 6-7 — add / change / remove, then an incremental re-run')
  await writeFixture(academic, 'CSC3200/01_Lectures/lecture02.txt', 'brandnewmarker\n')
  await writeFixture(academic, 'CSC3200/01_Lectures/lecture01.txt', 'betamarker\n')
  await fs.rm(path.join(academic, 'STA2001/01_Lectures/lecture01.txt'))
  const sourcesAfterEdits = await digestSources(academic)
  check(sourcesAfterEdits.size === FIXTURE.length, 'the fixture still holds the same number of files after the edits',
    `${sourcesAfterEdits.size}`)

  const secondDiscovery = await call(installedOnboarding.WORKSPACE_DISCOVER_TOOL_NAME, { folder: academic }, 'rediscover')
  check(secondDiscovery.payload?.ok === true, 'the folder can be re-discovered',
    JSON.stringify(secondDiscovery.payload?.problems ?? []))
  const incremental = await call(installedOnboarding.WORKSPACE_CONFIRM_TOOL_NAME, {
    proposal: secondDiscovery.payload.proposal,
    selections: [
      { relative_path: 'CSC3200', action: 'include' },
      { relative_path: 'STA2001', action: 'include' },
      { relative_path: 'PHY1001', action: 'include' },
      { relative_path: 'Algorithms', action: 'include', course_code: 'CS2210', display_name: 'Algorithms' },
    ],
  }, 'incremental')
  const second = incremental.payload ?? {}
  check(second.ok === true, 'the incremental confirmation succeeded', JSON.stringify(second.problems ?? []))
  check(second.readiness?.index?.added === 1, 'the index reports exactly one added file', String(second.readiness?.index?.added))
  check(second.readiness?.index?.changed === 1, 'the index reports exactly one changed file', String(second.readiness?.index?.changed))
  check(second.readiness?.index?.missing === 1, 'the index keeps the removed file as missing rather than deleting it',
    String(second.readiness?.index?.missing))
  check(second.readiness?.index?.reused > 0, 'unchanged records are reused', String(second.readiness?.index?.reused))
  check(second.readiness?.extraction?.extracted === 2, 'only the added and the changed file were re-extracted',
    String(second.readiness?.extraction?.extracted))
  check(second.readiness?.extraction?.skipped > 0, 'unchanged extraction was reused, not repeated',
    String(second.readiness?.extraction?.skipped))
  check((second.courses?.preserved ?? []).length === 4, 'the four registered courses were preserved, not duplicated',
    JSON.stringify((second.courses?.preserved ?? []).map((entry) => entry.course_code)))

  const fresh = await call('professor_search', { query: 'betamarker' }, 'search-fresh')
  check(fresh.payload?.results?.length === 1, 'the rewritten material is searchable',
    JSON.stringify(fresh.payload?.diagnostics ?? null))
  check(fresh.payload?.results?.[0]?.relative_path === 'CSC3200/01_Lectures/lecture01.txt',
    'the hit is the rewritten file', String(fresh.payload?.results?.[0]?.relative_path))
  const superseded = await call('professor_search', { query: 'alphamarker' }, 'search-superseded')
  check((superseded.payload?.results ?? []).length === 0,
    'the superseded text is gone, not merely outranked', JSON.stringify(superseded.payload?.results ?? []))
  const removed = await call('professor_search', { query: 'keepmarker' }, 'search-removed')
  check((removed.payload?.results ?? []).length === 0, 'removed material is not searchable',
    JSON.stringify(removed.payload?.results ?? []))
  const added = await call('professor_search', { query: 'brandnewmarker' }, 'search-added')
  check(added.payload?.results?.length === 1, 'the added material is searchable')

  // ─── 10. step 8: rebuild re-derives indexes only ──────────────────────────
  section('10. step 8 — an explicit rebuild touches only derived data')
  // Something the user owns, created through the plugin's own tools rather than by hand. The course
  // id is the one onboarding actually minted, not a string this verifier assumed.
  const cscId = (applied.courses?.registered ?? []).find((entry) => entry.course_code === 'CSC3200')?.course_id
  check(typeof cscId === 'string' && cscId.length > 0, 'onboarding minted a course id', String(cscId))
  const bind = await call('professor_session_bind', { course: cscId }, 'bind')
  check(bind.isError !== true, 'a session can be bound to a course', bind.text.slice(0, 160))
  const stateWrite = await call('professor_state_update', {
    file: 'PROGRESS.md', evidence: 'strong', field: 'current_unit', value: 'Unit 1',
  }, 'state')
  check(stateWrite.payload?.written === true, 'a learning-state file was written', stateWrite.text.slice(0, 160))
  const memoryWrite = await call('professor_memory_update', {
    scope: 'global', action: 'set_preference', key: 'onboarding_probe', value: 'rebuild-safe', evidence: 'explicit-stable',
  }, 'memory')
  check(memoryWrite.payload?.written === true, 'a global preference was written', memoryWrite.text.slice(0, 160))

  const configBeforeRebuild = await fs.readFile(projectFile, 'utf8')
  const stateFile = path.join(academic, '.professor', 'state', 'courses', cscId, 'PROGRESS.md')
  check(await exists(stateFile), 'the learning state lives under the course id onboarding minted', stateFile)
  const stateBeforeRebuild = await fs.readFile(stateFile, 'utf8')
  const rebuild = await call(REBUILD_TOOL, {}, 'rebuild')
  const rebuilt = rebuild.payload ?? {}
  check(rebuild.isError !== true && rebuilt.ok === true, 'professor_workspace_rebuild succeeds',
    JSON.stringify(rebuilt.problems ?? []))
  check(rebuilt.readiness?.index?.complete === true, 'the rebuild left a complete index',
    JSON.stringify(rebuilt.readiness?.index ?? null))
  check(rebuilt.readiness?.extraction?.complete === true, 'the rebuild left complete extraction',
    JSON.stringify(rebuilt.readiness?.extraction ?? null))
  check(rebuilt.index?.rebuilt === true && rebuilt.extraction?.rebuilt === true,
    'the rebuild really re-derived both layers rather than reporting the previous run')
  check(await fs.readFile(projectFile, 'utf8') === configBeforeRebuild,
    'the rebuild left the configuration byte-identical')
  check(await fs.readFile(stateFile, 'utf8') === stateBeforeRebuild,
    'the rebuild left the learning state byte-identical')
  const rebuildSearch = await call('professor_search', { query: 'betamarker' }, 'search-after-rebuild')
  check(rebuildSearch.payload?.results?.length === 1, 'the material is searchable after a rebuild',
    JSON.stringify(rebuildSearch.payload?.diagnostics ?? null))
  const memoryAfterRebuild = await call('professor_memory_read', { scope: 'global' }, 'memory-after-rebuild')
  check(memoryAfterRebuild.payload?.record?.preferences?.onboarding_probe?.value === 'rebuild-safe',
    'the rebuild never disposes memory — it is not derived index data',
    JSON.stringify(memoryAfterRebuild.payload?.record?.preferences ?? null))

  // ─── 11. step 9: a fresh host process ─────────────────────────────────────
  section('11. step 9 — restart: a fresh host process finds the connection')
  const restoreScript = path.join(installedDir, RESTORE_SCRIPT)
  check(await exists(restoreScript), 'the restart probe ships inside the installed package', restoreScript)
  await ctx.fiber.dispose()
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
        PROFESSOR_WORKSPACE: academic,
        PROFESSOR_INSTALLED_DIR: installedDir,
        PROFESSOR_EXPECTED_FOLDER: await fs.realpath(academic),
        PROFESSOR_RESTART_KEY: RESTART_PREFERENCE_KEY,
        PROFESSOR_RESTART_VALUE: RESTART_PREFERENCE_VALUE,
        PROFESSOR_CONFLICT_CODE: 'PROFESSOR_ONBOARDING_CONFLICT',
      },
      timeout: 180_000,
    })
  } catch (error) {
    childOk = false
    childStdout = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`
  }
  const childLine = childStdout.split('\n').find((line) => line.startsWith('PROFESSOR_ONBOARDING_JSON '))
  const child = childLine === undefined ? null : JSON.parse(childLine.slice('PROFESSOR_ONBOARDING_JSON '.length))
  check(childOk && child !== null, 'the fresh host process exited 0 and reported',
    (child?.errors ?? [childStdout.slice(-300)]).join(' | '))
  check(child?.professorToolCount === EXPECTED_TOOLS.length, 'the fresh process mounted the full Professor tool surface',
    String(child?.toolCount))
  check(child?.connected === true, 'diagnostics in the fresh process reports a connected folder')
  check(child?.connectionSupported === true, 'the connection record has the schema this build understands',
    String(child?.connectionVersion))
  check(child?.recordedFolder === await fs.realpath(academic),
    'the recorded folder survived the restart', String(child?.recordedFolder))
  check(child?.discoverSource === 'connection',
    'discovery in the fresh process resolves the recorded folder rather than the session cwd',
    String(child?.discoverSource))
  check(child?.proposalHasCourses === true, 'the fresh process proposes the connected courses again')
  check(child?.conflictCode === 'PROFESSOR_ONBOARDING_CONFLICT' && child?.conflictApplied === false,
    'a confirmation against a stale revision is refused and applies nothing',
    `${child?.conflictCode} applied=${child?.conflictApplied}`)
  check(child?.preferenceWritten === true, 'the fresh process wrote a record of its own through the medium')
  const persistedMemory = JSON.parse(await fs.readFile(path.join(home, 'storages', 'professor_app.json'), 'utf8'))
  const childPreference = persistedMemory.tables?.app?.['memory:global']?.preferences?.[RESTART_PREFERENCE_KEY]
  check(childPreference?.value === RESTART_PREFERENCE_VALUE,
    'the record written by the fresh process is in the durable medium, not only in that process',
    JSON.stringify(childPreference ?? null))

  // ─── 12. step 10: nothing changed ────────────────────────────────────────
  section('12. step 10 — nothing changed')
  const afterEdits = await digestSources(academic)
  const drifted = [...sourcesAfterEdits.entries()].filter(([file, digest]) => afterEdits.get(file) !== digest).map(([file]) => file)
  const appeared = [...afterEdits.keys()].filter((file) => !sourcesAfterEdits.has(file))
  check(drifted.length === 0 && appeared.length === 0,
    'onboarding, extraction and a rebuild left every fixture source file byte-identical',
    [...drifted, ...appeared].slice(0, 5).join(', '))
  check(afterEdits.size === FIXTURE.length, 'no source file was added or manufactured by the plugin',
    `${afterEdits.size} files`)

  const repoAfter = await digestTree(REPO)
  const repoChanged = [...repoBefore.entries()].filter(([file, digest]) => repoAfter.get(file) !== digest).map(([file]) => file)
  const repoAdded = [...repoAfter.keys()].filter((file) => !repoBefore.has(file))
  check(repoChanged.length === 0 && repoAdded.length === 0, 'the source checkout is byte-identical after the run',
    [...repoChanged, ...repoAdded].slice(0, 5).join(', '))

  const installedAfter = await digestTree(installedDir)
  check(installedAfter.size === shipped.length, 'the installed copy still holds exactly the packed files',
    `${installedAfter.size} of ${shipped.length}`)
  check(sha256(await fs.readFile(tarball)) === tarballDigest, 'the packed artefact was not modified by the install')

  const profileAfter = await snapshotRealProfile()
  const touched = Object.keys(profileBefore.snap).filter((file) => profileBefore.snap[file] !== profileAfter.snap[file])
  if (Object.values(profileBefore.snap).every((value) => value === null)) {
    console.log('SKIP  the real desktop profile was never touched  — no desktop profile on this machine')
  } else {
    check(touched.length === 0, 'the real desktop profile was not written by this run', touched.join(', '))
  }

  const configs = await configurationSources(home, [PROFILE_NAME], [installedDir])
  check(configs.length === 3, 'every runtime configuration source was inspected', `${configs.length} files`)
  const legacyReferences = []
  for (const { file, text } of configs) {
    for (const pattern of LEGACY_TOKENS) {
      if (pattern.test(text)) legacyReferences.push(`${path.basename(file)}: ${pattern}`)
    }
  }
  check(legacyReferences.length === 0,
    'no runtime configuration references a Hermes / Personal-Agent / legacy-academic location',
    legacyReferences.join(', '))

  // ─── 13. what this run does and does not prove ───────────────────────────
  section('claims: evidence classes')
  console.log('PROVED (registration/activation): the installed artefact registers the preset and 22 tools,')
  console.log('       including the Phase 3 onboarding trio, on the real host.')
  console.log('PROVED (real execution): discovery, confirmation, indexing, extraction, search, incremental')
  console.log('       re-runs, an explicit rebuild and a fresh-process restart, all dispatched through the')
  console.log('       real tool pipeline against a real filesystem.')
  unverified('a native conversation turn', 'no model provider is configured in a disposable profile; a turn needs network access and spend')
  unverified('model-driven tool selection', 'tool calls here are dispatched by this verifier, not chosen by a model')
  unverified('the thin Settings UI', 'Phase 3 builds the backend contract the UI will call; the UI itself is a later phase')
  unverified('a filesystem watcher', 'incremental work is an explicit on-demand comparison, never a live watch — see PROJECT_MEMORY.md')

  verdict = failures === 0 ? 0 : 1
  await ctx.fiber.dispose().catch(() => {})
  await fs.rm(home, { recursive: true, force: true })
  console.log(`\ndisposable home removed: ${home}`)
} catch (error) {
  failures += 1
  console.log(`\nFAIL  the acceptance run threw: ${error?.stack ?? error}`)
  verdict = 1
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} 项失败`)
process.exit(verdict)
