/**
 * Packaged-installation acceptance: does the **artefact a user installs** work on the real Harness?
 *
 * Why this is a different question from every other verifier here
 * --------------------------------------------------------------
 * `verify:harness` composes the bundle from the *source checkout* through a `link:` dependency, so a
 * resource that is missing from the tarball still resolves for the developer. `files` is a whitelist
 * that silently drops whatever it does not name, and an installed copy has no repository around it
 * to borrow from. This verifier closes that gap by refusing to touch the checkout at runtime:
 *
 *   1. **pack** — `npm pack` the repository into a private scratch directory, and fingerprint the
 *      exact tarball (sha256 + the shipped file list) so "that artefact" is unambiguous;
 *   2. **install** — `npm install` *that tarball* into a disposable Harness profile, so the package
 *      lands as a real directory in the profile's own `node_modules`. It is then asserted to be a
 *      copy rather than a symlink, to resolve outside the checkout, and to be byte-identical to the
 *      packed sources;
 *   3. **clean room** — the disposable home is asserted to contain no legacy Hermes profile, no
 *      `Personal-Agent` tree, no Registry/Knowledge file, no manually installed Professor skill and
 *      no academic folder. Nothing is installed by hand anywhere;
 *   4. **boot the real host** — the real Cordis loader, the real preset registry, the real tool and
 *      skill registries, in that disposable profile;
 *   5. **activation** — preset `professor` declared and not broken, the persona present **in the
 *      preset's scope of the assembled system prompt** (read from the host's own
 *      `ctx.systemPrompt.assemble()`, and asserted *not* to leak into the global prompt), all six
 *      bundled skills discoverable, all 21 Professor tools plus the preset's child tools registered;
 *   6. **runtime resource resolution** — the *runtime's own* answer (`professor_diagnostics`) must
 *      name the installed package directory for `plugin.root`/`skillsDir`, never the checkout;
 *   7. **course-free behaviour** — diagnostics and paths report the unbound state honestly, a
 *      course-required tool is *refused* naming the workspace and the `.professor/` marker it looked
 *      for, and nothing is created on disk. The refusal's documented code
 *      (`PROFESSOR_PROJECT_MISSING`) is asserted against the installed module, because the tool
 *      pipeline flattens a failure to `{ message }` and does not expose the code to the caller —
 *      a real limitation, recorded rather than papered over;
 *   8. **storage ownership** — the *mounted plugin* opens `professor_app` for real (its diagnostics
 *      reports `appStorage.status: 'open'`), the bytes land in the disposable home, and a second
 *      concurrent open of the same domain is refused with `already-open` rather than silently
 *      double-mounted;
 *   9. **durability** — a second profile installs the same tarball but does **not** mount the
 *      plugin, precisely because that backend refuses the concurrent open; the installed module then
 *      persists a valid record, refuses an invalid one without damaging what is stored, and closes;
 *  10. **restart** — a **fresh host process** (`tools/verify-packaged-restore.mjs`, run from the
 *      installed copy) boots the same home and restores the record byte-for-byte, and persists one
 *      of its own so the parent can prove it wrote rather than merely read;
 *  11. **nothing changed** — the real desktop profile, the real personal directories, the packed
 *      artefact, the installed package and the source checkout are all fingerprinted before and
 *      after and asserted unchanged.
 *
 * ## What last watched out for — evidence classes
 *
 * This run produces **registration/activation evidence** (registry reads, resolved file paths) and
 * **real execution evidence** (tool calls dispatched through the real pipeline, a real host process
 * restart). It does **not** drive a native conversation or a model turn: no model provider is
 * configured in a disposable profile, and starting one would mean network access and spend. Those
 * requirements are therefore printed as `UNVERIFIED` rather than implied by a probe — see §Claims.
 *
 * Run it with the harness Node (asar-aware):
 *
 *   npm run verify:packaged
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
  PERSONA_PREFIX_SECTION,
  assembleSections,
  attachSession,
  bootProfessorProfile,
  createProfessorProfile,
  executeTool,
  findProfessorScope,
  resultJson,
  resultText,
  sectionText,
  visibleSkills,
  visibleTools,
} from './packaged-profile.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_NAME = 'professor-packaged-acceptance'

/** Every `professor_*` tool the runtime plugin must register. */
const EXPECTED_TOOLS = [
  'professor_paths',
  'professor_diagnostics',
  'professor_index_sync',
  'professor_project_init',
  'professor_course_list',
  'professor_course_manage',
  'professor_session_bind',
  'professor_session_status',
  'professor_extract',
  'professor_search',
  'professor_state_read',
  'professor_state_update',
  'professor_artifact_create',
  'professor_artifact_status',
  'professor_latex_compile',
  'professor_memory_status',
  'professor_memory_read',
  'professor_memory_update',
  'professor_material_read',
  'professor_workspace_discover',
  'professor_workspace_confirm',
  'professor_workspace_rebuild',
]

/** Children of the preset that must also have activated, so a partially mounted preset fails. */
const EXPECTED_CHILD_TOOLS = ['todo_write', 'bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_fetch', 'web_search', 'ask_user_question', 'present', 'skill']

/** The six workflows this bundle ships. */
const EXPECTED_SKILLS = ['professor-course-management', 'professor-study', 'professor-notes', 'professor-review', 'professor-research', 'professor-latex']

/** A provider name is not a skill; leaking it would look like a seventh workflow. */
const SKILL_PROVIDER_INTERNAL_NAME = 'professor-bundled'

/** One course-required tool, chosen because it must be refused in a course-free workspace. */
const COURSE_REQUIRED_TOOL = 'professor_state_read'

/** Tool-error code `src/paths/roots.js#assertProjectBound` raises for an unbound workspace. */
const NO_PROJECT_CODE = 'PROFESSOR_PROJECT_MISSING'

/** Names that must not appear anywhere in the disposable home: legacy data this plugin never needs. */
const LEGACY_NAMES = ['.hermes', 'Personal-Agent', 'Registry', 'registry.json', 'Knowledge', 'Knowledge.md', 'PATHS.md', 'SOUL.md', '01_Learning']

const RECORD_KEY = 'acceptance/roundtrip'
const CHILD_KEY = 'acceptance/restored-by-child'
const CHILD_TOKEN = `child-${Date.now()}`

// --- scratch space and an isolated npm cache --------------------------------
//
// The same discipline as `tools/verify-distribution.mjs`: `npm` writes to a global cache by default
// (`~/.npm`), which on a shared or containerised machine can be root-owned and unusable. Every child
// therefore gets a unique private cache, removed on every exit path including a thrown error.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-packaged-'))
const npmCache = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-packaged-npm-'))
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

/** Fingerprint a directory tree: relative path → sha256. Skips VCS and local tooling state. */
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

/** Every bundled skill file under `root` (`skills/professor-<name>/SKILL.md`), so a hand-installed skill can be spotted. */
async function findProfessorSkills(root) {
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
      if (entry.isDirectory()) await walk(next)
      else if (/\/skills\/professor-[^/]+\/SKILL\.md$/.test(`/${next}`)) hits.push(next)
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

/**
 * The real legacy locations this plugin must never need.
 *
 * These are **observed, never asserted**. They are live directories owned by other processes on this
 * machine (`~/.hermes` is written by an unrelated gateway — `gateway_state.json`, `kanban.db-wal`,
 * `cron` — and its `mtime` advances every second on its own), so an `mtime` comparison would fail
 * for reasons that have nothing to do with this run. The claim that this run does not depend on them
 * is instead proved twice over: statically, by scanning the configuration the run uses for any
 * reference to a legacy location; and dynamically, by booting a home that contains none of them.
 */
async function observeRealLegacy() {
  const targets = [
    path.join(os.homedir(), '.hermes', 'profiles', 'professor'),
    path.join(os.homedir(), 'Personal-Agent'),
  ]
  const observed = {}
  for (const target of targets) {
    const present = await exists(target)
    observed[target] = present ? 'present (not read, not written)' : 'absent'
  }
  return observed
}

/** Tokens that name legacy data this plugin must not reference from its configuration. */
const LEGACY_TOKENS = [/\.hermes\b/, /Personal-Agent/, /PERSONAL_AGENT_ROOT/, /PATHS\.md/, /01_Learning/, /06_Shared/]

/**
 * The configuration a boot actually resolves: both disposable profiles' manifests and root entry
 * trees, plus the installed bundle's own patch. Prose inside a bundled skill is deliberately out of
 * scope — `professor-course-management` names legacy locations **inside a declared Optional
 * migration section**, which `verify-skill-sync` governs. What must be clean is the runtime wiring.
 */
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

let verdict = 1
try {
  // ─── 0. fingerprints before anything runs ──────────────────────────────────
  section('fingerprints before the run')
  const repoBefore = await digestTree(REPO)
  const profileBefore = await snapshotRealProfile()
  console.log(`source checkout:  ${REPO} (${repoBefore.size} files)`)
  console.log(`real profile:     ${profileBefore.dir}`)
  console.log(`private npm cache: ${npmCache}`)

  // ─── 1. pack the exact artefact ───────────────────────────────────────────
  section('1. pack')
  const packDir = path.join(temp, 'pack')
  await fs.mkdir(packDir, { recursive: true })
  const packed = JSON.parse(run('npm', ['pack', '--pack-destination', packDir, '--json'], { cwd: REPO }))
  check(Array.isArray(packed) && packed.length === 1, 'npm pack produced exactly one tarball')
  const tarball = path.join(packDir, packed[0].filename)
  const tarballBytes = await fs.readFile(tarball)
  const tarballDigest = sha256(tarballBytes)
  const shipped = packed[0].files.map((entry) => `package/${entry.path}`)
  check(packed[0].version === JSON.parse(await fs.readFile(path.join(REPO, 'package.json'), 'utf8')).version,
    'the tarball version matches package.json', packed[0].version)
  console.log(`tarball: ${packed[0].filename}  sha256:${tarballDigest.slice(0, 16)}…  ${shipped.length} files`)

  // ─── 2. install that tarball into a disposable profile ────────────────────
  section('2. install the exact artefact')
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-professor-packaged-'))
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_DISABLED = '1'
  console.log(`disposable Harness home: ${home}`)

  const workspace = path.join(home, 'workspace')
  await fs.mkdir(workspace, { recursive: true })

  const { installedDir, manifest, profileDir } = await createProfessorProfile({
    home, profileName: PROFILE_NAME, tarball, run,
  })
  check(await exists(path.join(installedDir, 'package.json')), 'the bundle is present in the profile node_modules', installedDir)
  const installedStat = await fs.lstat(installedDir)
  check(installedStat.isDirectory() && !installedStat.isSymbolicLink(), 'the installed bundle is a real directory, not a symlink')
  const realInstalled = await fs.realpath(installedDir)
  check(!realInstalled.startsWith(`${await fs.realpath(REPO)}${path.sep}`) && realInstalled !== await fs.realpath(REPO),
    'the installed bundle does not resolve back into the source checkout', realInstalled)
  check(manifest.dependencies?.[PACKAGE_NAME]?.startsWith('file:'),
    'the profile declares the bundle as a file: dependency on the tarball', String(manifest.dependencies?.[PACKAGE_NAME]))
  check(manifest.dsh.profile.bundles.includes(PACKAGE_NAME), 'the bundle is registered in the profile bundle list')
  console.log(`installed: ${installedDir}`)

  // Byte-for-byte: every file in the tarball must be exactly what landed on disk.
  const mismatched = []
  for (const entry of shipped) {
    const relative = entry.slice('package/'.length)
    const installedPath = path.join(installedDir, relative)
    if (!(await exists(installedPath))) { mismatched.push(`${relative} (missing)`); continue }
    const [inRepo, inInstalled] = await Promise.all([fs.readFile(path.join(REPO, relative)), fs.readFile(installedPath)])
    if (sha256(inRepo) !== sha256(inInstalled)) mismatched.push(relative)
  }
  check(mismatched.length === 0, `all ${shipped.length} packed files are byte-identical after installation`, mismatched.slice(0, 3).join(', '))

  // Everything below drives the **installed** copy, never the checkout.
  const installedManifest = JSON.parse(await fs.readFile(path.join(installedDir, 'package.json'), 'utf8'))
  const storageModule = await import(pathToFileURL(path.join(installedDir, 'src/app/storage.js')).href)
  const storageDomainName = storageModule.APP_DOMAIN_NAME
  const storageWarnings = []
  check(storageModule.APP_DOMAIN_NAME === 'professor_app', 'the installed module declares the single domain',
    String(storageModule.APP_DOMAIN_NAME))
  check(installedManifest.version === JSON.parse(await fs.readFile(path.join(REPO, 'package.json'), 'utf8')).version,
    'the installed manifest version matches the checkout', installedManifest.version)

  // ─── 3. clean room ────────────────────────────────────────────────────────
  section('3. clean room (no legacy data, no hand-installed skills, no academic folder)')
  const legacyHits = await findNamed(home, new Set(LEGACY_NAMES))
  check(legacyHits.length === 0, 'the disposable home contains no Hermes / Personal-Agent / Registry / Knowledge artefact',
    legacyHits.slice(0, 5).join(', '))
  const skillHits = await findProfessorSkills(home)
  const foreignSkills = skillHits.filter((hit) => !path.join(home, hit).startsWith(`${installedDir}${path.sep}`))
  check(foreignSkills.length === 0, 'the only Professor skills present are the ones inside the installed package',
    foreignSkills.slice(0, 5).join(', '))
  check(skillHits.length === 6, 'exactly the six bundled skills exist, all inside the installed package', `${skillHits.length}`)
  check(!(await exists(path.join(home, 'storages', 'professor_app.json'))), 'the disposable home starts with no Professor storage file')
  check((await fs.readdir(workspace)).length === 0, 'the workspace starts empty — there is no academic folder to rely on')

  // ─── 4–5. boot the real host and check activation ─────────────────────────
  section('4. boot the real Harness from the installed package')
  const booted = await bootProfessorProfile({ home, profileName: PROFILE_NAME, workspace })
  const { ctx, layers } = booted
  check(ctx.fiber?.state === 2, 'the composed tree reached the active state', String(ctx.fiber?.state))
  check(layers.includes(PACKAGE_NAME), 'the loader registered the bundle layer', layers.join(', '))
  check(ctx.get('agentPresets') !== undefined, 'the real preset registry is mounted')
  check(ctx.get('tools') !== undefined, 'the real tool registry is mounted')
  check(ctx.get('skills') !== undefined, 'the real skill registry is mounted')

  section('5. activation (preset, persona, skills, tools)')
  const presets = await ctx.get('agentPresets').list()
  const professor = presets.find((row) => row.id === 'professor')
  check(professor !== undefined, 'the professor preset is declared', presets.map((row) => row.id).join(', '))
  check(professor?.name === 'Professor', 'the preset keeps its display name', String(professor?.name))
  check(professor?.broken === undefined, 'the preset is NOT marked broken', String(professor?.broken ?? ''))
  check(professor?.order === 20, 'the preset keeps its designed order', String(professor?.order))

  const scope = await findProfessorScope(ctx)
  check(scope !== undefined, 'the registry holds a live mount for the running composition')

  // The persona is a *scoped* contribution to the system prompt, not a field on the registry row:
  // `@deepseek-ai/dsh-persona` is a scope-only row that shadows the deployment persona inside the
  // preset. Reading the host's own assembled prompt is the strongest evidence available without a
  // model turn, and it also proves the scoping — an ordinary agent must NOT receive it.
  const presetSections = await assembleSections(ctx, scope)
  const presetPersona = sectionText(presetSections, PERSONA_PREFIX_SECTION)
  const globalSections = await assembleSections(ctx, undefined)
  const globalPersona = sectionText(globalSections, PERSONA_PREFIX_SECTION)
  check(presetPersona.trim().length > 200, 'the preset scope carries a non-trivial persona payload',
    `${presetPersona.trim().length} chars`)
  check(/Professor/.test(presetPersona), 'the assembled persona names the Professor role')
  check(/通用学术助手/.test(presetPersona), 'the assembled persona states the course-free (general academic) mode')
  check(presetPersona !== globalPersona && !/Professor/.test(globalPersona),
    'the persona is scoped to the preset: the global prompt keeps the ordinary coding persona',
    `global persona: ${globalPersona.trim().slice(0, 60)}`)
  check(presetSections.length >= globalSections.length,
    'the preset scope composes at least as many prompt sections as the global scope',
    `${presetSections.length} vs ${globalSections.length}`)

  const rows = (await ctx.get('agentPresets').compositionInventory()).find((row) => row.id === 'professor')?.rows ?? []
  check(rows.length > 0, 'the preset declares child rows', `${rows.length} rows`)
  check(rows.every((row) => row.fiberState === 2), 'every declared child row reached the active state',
    rows.filter((row) => row.fiberState !== 2).map((row) => `${row.entryId}=${row.fiberState}`).join(', '))
  check(rows.some((row) => row.entryId === 'persona' && row.fiberState === 2),
    'the persona row itself activated inside the preset', rows.map((row) => row.entryId).join(', '))
  check(rows.some((row) => row.entryId === 'professor-runtime' && row.fiberState === 2),
    'the Professor runtime row activated inside the preset')

  const tools = visibleTools(ctx, scope)
  const missingTools = EXPECTED_TOOLS.filter((name) => !tools.includes(name))
  check(missingTools.length === 0, `all ${EXPECTED_TOOLS.length} professor tools are registered`, missingTools.join(', '))
  const missingChildren = EXPECTED_CHILD_TOOLS.filter((name) => !tools.includes(name))
  check(missingChildren.length === 0, 'the preset\'s required child tools activated too', missingChildren.join(', '))

  const skills = await visibleSkills(ctx, scope, workspace)
  const missingSkills = EXPECTED_SKILLS.filter((name) => !skills.includes(name))
  check(missingSkills.length === 0, `all ${EXPECTED_SKILLS.length} bundled skills are discoverable via the real registry`,
    missingSkills.length === 0 ? skills.join(', ') : `missing ${missingSkills.join(', ')}`)
  check(!skills.includes(SKILL_PROVIDER_INTERNAL_NAME), 'the provider name is not leaked as a skill')

  // ─── 6–7. real tool execution: resource resolution, course-free behaviour ──
  section('6. the runtime resolves resources from the installed package')
  const realInstalledResolved = path.join(await fs.realpath(installedDir))
  const { agent } = attachSession({ ctx, scope, workspace })

  const diagnostics = await executeTool({ ctx, agent, name: 'professor_diagnostics', label: 'diagnostics' })
  check(diagnostics.isError !== true, 'professor_diagnostics executes in a course-free workspace', resultText(diagnostics).slice(0, 160))
  const diagnosticsJson = resultJson(diagnostics)
  check(diagnosticsJson !== null, 'the diagnostics payload is structured JSON')
  check(diagnosticsJson?.plugin?.root === realInstalledResolved,
    'the runtime reports the INSTALLED package directory as the plugin root',
    `${String(diagnosticsJson?.plugin?.root)} (expected ${realInstalledResolved})`)
  check(diagnosticsJson?.plugin?.root !== REPO, 'the runtime does not report the source checkout as the plugin root')

  const paths = await executeTool({ ctx, agent, name: 'professor_paths', label: 'paths' })
  const pathsJson = resultJson(paths)
  check(paths.isError !== true, 'professor_paths executes in a course-free workspace')
  check(pathsJson?.pluginRoot === realInstalledResolved, 'professor_paths reports the installed plugin root',
    String(pathsJson?.pluginRoot))
  check(typeof pathsJson?.skillsDir === 'string' && pathsJson.skillsDir.startsWith(`${realInstalledResolved}${path.sep}`),
    'professor_paths resolves the skills directory inside the installed package', String(pathsJson?.skillsDir))
  check(pathsJson?.projectBound === false, 'professor_paths reports the workspace as unbound', String(pathsJson?.projectBound))

  section('7. course-free diagnostics and safe refusal')
  check(diagnosticsJson?.project?.bound === false, 'diagnostics reports project.bound === false',
    JSON.stringify(diagnosticsJson?.project))
  const storageBlock = diagnosticsJson?.appStorage
  check(storageBlock !== undefined, 'diagnostics reports an application-storage block', JSON.stringify(storageBlock)?.slice(0, 200))
  check(storageBlock?.status === 'open', 'diagnostics reports application storage as open', String(storageBlock?.status))
  const warnings = Array.isArray(diagnosticsJson?.warnings) ? diagnosticsJson.warnings : []
  check(warnings.some((line) => /no academic folder is connected/i.test(String(line))),
    'diagnostics warns honestly that no academic folder is connected')

  const refused = await executeTool({ ctx, agent, name: COURSE_REQUIRED_TOOL, args: { course_id: 'csc3200' }, label: 'refusal' })
  check(refused.isError === true, `${COURSE_REQUIRED_TOOL} is refused in an unbound workspace`)
  check(/no academic folder is connected/i.test(resultText(refused)),
    'the refusal names the missing academic folder', resultText(refused).slice(0, 140))
  check(new RegExp(`no \\.professor/ directory there`).test(resultText(refused)),
    'the refusal names the marker it looked for (.professor/) rather than guessing a root')
  check(/never guess a course root/i.test(resultText(refused)),
    'the refusal tells the caller not to guess a course root')
  // The pipeline flattens a tool failure to `{ message }`, so the *documented code* is not
  // observable through a tool result — a real finding, recorded rather than papered over. The code
  // the runtime wrapper propagates internally is asserted against the installed module below.
  const rootsModule = await import(pathToFileURL(path.join(installedDir, 'src/paths/roots.js')).href)
  let refusalCode = null
  try {
    rootsModule.assertProjectBound({ bound: false, root: workspace })
  } catch (error) {
    refusalCode = error.code
  }
  check(refusalCode === NO_PROJECT_CODE,
    `the installed module raises the documented code ${NO_PROJECT_CODE} for an unbound workspace`, String(refusalCode))

  const lenient = await executeTool({ ctx, agent, name: 'professor_course_list', args: {}, label: 'lenient' })
  check(lenient.isError !== true, 'a lenient tool still answers in a course-free workspace', resultText(lenient).slice(0, 140))
  check((await fs.readdir(workspace)).length === 0, 'no tool created anything in the unbound workspace',
    (await fs.readdir(workspace)).join(', '))
  check(!(await exists(path.join(workspace, '.professor'))), 'no .professor/ tree was guessed into existence')

  // ─── 8. the mounted plugin opens its own application storage ──────────────
  section('8. application storage, opened by the mounted plugin')
  const domainFile = path.join(home, 'storages', `${storageDomainName}.json`)
  check(await exists(domainFile), 'the host wrote the domain into the disposable home', domainFile)
  check(!(await exists(path.join(REPO, 'storages'))) && !(await exists(path.join(REPO, `${storageDomainName}.json`))),
    'nothing was written inside the source checkout')
  const persisted = JSON.parse(await fs.readFile(domainFile, 'utf8'))
  const marker = persisted.tables.app.bootstrap
  check(marker !== undefined, 'the persisted domain carries the bootstrap marker')
  check(marker?.owner === 'dsh-professor-spike', 'the persisted marker attributes the domain to this plugin', String(marker?.owner))
  check(marker?.plugin_version === installedManifest.version,
    'the persisted marker records the installed package version', String(marker?.plugin_version))

  // The plugin holds this domain for the lifetime of the mounted tree. The shipped backend refuses a
  // second concurrent `open()` of the same name (`already-open`), so the durability run below uses a
  // profile where the plugin is installed but not mounted rather than fighting its own subject.
  const secondOpen = storageModule.createAppStorage({
    ctx,
    logger: { warn: (message) => storageWarnings.push(String(message)), info: () => {}, debug: () => {} },
    readVersion: async () => installedManifest.version,
  })
  const conflicted = await secondOpen.ensureOpen()
  check(conflicted.status === 'unavailable' && /already-open/.test(String(conflicted.reason)),
    'a second concurrent open of the same domain is refused by the backend, not silently double-mounted',
    JSON.stringify({ status: conflicted.status, reason: conflicted.reason }))
  await secondOpen.close()
  check(storageWarnings.length === 0, 'no warnings were emitted during a healthy run', storageWarnings.join(' | '))

  await ctx.fiber.dispose()
  check(true, 'the first host process shut down cleanly')

  // ─── 9. durability: open, persist, refuse, close ──────────────────────────
  section('9. durability (installed module, host without the plugin mounted)')
  const storageProfile = `${PROFILE_NAME}-storage`
  const storageInstall = await createProfessorProfile({
    home, profileName: storageProfile, tarball, run, registerBundle: false,
  })
  const storageBoot = await bootProfessorProfile({ home, profileName: storageProfile, workspace })
  const storageCtx = storageBoot.ctx
  check(storageCtx.fiber?.state === 2, 'the storage profile booted without mounting the plugin',
    storageBoot.layers.join(', '))
  check(!storageBoot.layers.includes(PACKAGE_NAME), 'the plugin really is not mounted in the storage profile')

  const durableModule = await import(pathToFileURL(path.join(storageInstall.installedDir, 'src/app/storage.js')).href)
  const durableWarnings = []
  const durable = durableModule.createAppStorage({
    ctx: storageCtx,
    logger: { warn: (message) => durableWarnings.push(String(message)), info: () => {}, debug: () => {} },
    readVersion: async () => installedManifest.version,
  })
  const durableOpened = await durable.ensureOpen()
  check(durableOpened.status === 'open', 'the installed module opens professor_app against the real host',
    JSON.stringify({ status: durableOpened.status, reason: durableOpened.reason }))
  check(durableOpened.bootstrapped === false,
    'it recognises the marker the mounted plugin wrote rather than re-bootstrapping')
  check(durable.table('app').get('bootstrap')?.created_at === marker?.created_at,
    'the marker is the same record, so this is the same persistent domain')

  const storedRecord = {
    schema: durableModule.APP_RECORD_SCHEMA,
    owner: durableModule.APP_STORAGE_OWNER,
    note: 'packaged acceptance round-trip',
    tags: ['acceptance', 'restart'],
    nested: { depth: 2, flags: [true, false, null] },
  }
  await durable.writeRecord(RECORD_KEY, storedRecord)
  check(JSON.stringify(durable.table('app').get(RECORD_KEY)) === JSON.stringify(storedRecord),
    'the record reads back from the live table unchanged')

  let refusal = null
  try {
    await durable.writeRecord('acceptance/invalid', { x: Number.NaN })
  } catch (error) {
    refusal = error
  }
  check(refusal?.code === 'PROFESSOR_APP_RECORD_INVALID', 'an invalid record is refused before persistence', String(refusal?.code))
  check(JSON.stringify(durable.table('app').get(RECORD_KEY)) === JSON.stringify(storedRecord),
    'the refused write left the stored record untouched')

  await durable.close()
  check(durable.describe().status === 'closed', 'close() reports the handle closed')
  check(durableWarnings.length === 0, 'no warnings were emitted while writing', durableWarnings.join(' | '))

  const persistedText = await fs.readFile(domainFile, 'utf8')
  check(JSON.parse(persistedText).tables.app[RECORD_KEY].note === storedRecord.note,
    'the record is in the durable medium, not only in memory')

  await storageCtx.fiber.dispose()
  check(true, 'the storage host process shut down cleanly')

  // ─── 10. a fresh host process must restore it ─────────────────────────────
  section('10. restart: a fresh host process restores the record')
  const restoreScript = storageInstall.installedDir + '/tools/verify-packaged-restore.mjs'
  check(await exists(restoreScript), 'the restore probe ships inside the installed package', restoreScript)
  let childStdout = ''
  let childOk = true
  try {
    childStdout = execFileSync(HARNESS_BIN, [path.join(storageInstall.installedDir, 'tools/verify-packaged-restore.mjs')], {
      encoding: 'utf8',
      env: {
        ...childEnv,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
        PROFESSOR_HOME: home,
        PROFESSOR_PROFILE: storageProfile,
        PROFESSOR_WORKSPACE: workspace,
        PROFESSOR_INSTALLED_DIR: storageInstall.installedDir,
        PROFESSOR_RECORD_KEY: RECORD_KEY,
        PROFESSOR_CHILD_KEY: CHILD_KEY,
        PROFESSOR_CHILD_TOKEN: CHILD_TOKEN,
      },
      timeout: 120_000,
    })
  } catch (error) {
    childOk = false
    childStdout = String(error.stdout ?? error.message)
  }
  const childLine = childStdout.split('\n').find((line) => line.startsWith('PROFESSOR_RESTORE_JSON '))
  const childReport = childLine === undefined ? null : JSON.parse(childLine.slice('PROFESSOR_RESTORE_JSON '.length))
  check(childOk && childReport !== null, 'the fresh host process exited 0 and reported', childReport?.errors?.join(' | ') ?? '')
  check(childReport?.status === 'open', 'the fresh process reopened professor_app', String(childReport?.status))
  check(childReport?.bootstrapped === false, 'the fresh process found the existing marker instead of rewriting it')
  check(childReport?.bootstrapPresent === true, 'the bootstrap record survived the restart')
  check(JSON.stringify(childReport?.record) === JSON.stringify(storedRecord),
    'the record survived the restart byte-for-byte',
    JSON.stringify(childReport?.record)?.slice(0, 200))
  check(childReport?.childRecordWritten === true, 'the fresh process persisted a record of its own')
  check(childReport?.storageSourceFile === path.join(storageInstall.installedDir, 'src/app/storage.js'),
    'the fresh process loaded the storage module from the installed package', String(childReport?.storageSourceFile))
  check(JSON.parse(await fs.readFile(domainFile, 'utf8')).tables.app[CHILD_KEY]?.token === CHILD_TOKEN,
    'the record written by the fresh process is in the durable medium')

  // ─── 11. nothing changed ──────────────────────────────────────────────────
  section('11. nothing changed')
  const repoAfter = await digestTree(REPO)
  const changed = [...repoBefore.entries()].filter(([file, digest]) => repoAfter.get(file) !== digest).map(([file]) => file)
  const added = [...repoAfter.keys()].filter((file) => !repoBefore.has(file))
  check(changed.length === 0 && added.length === 0, 'the source checkout is byte-identical after the run',
    [...changed, ...added].slice(0, 5).join(', '))

  const installedAfter = await digestTree(installedDir)
  const storageInstalledAfter = await digestTree(storageInstall.installedDir)
  check(installedAfter.size === shipped.length && storageInstalledAfter.size === shipped.length,
    'both installed copies still hold exactly the packed files',
    `${installedAfter.size} and ${storageInstalledAfter.size} of ${shipped.length}`)
  check(sha256(await fs.readFile(tarball)) === tarballDigest, 'the packed artefact was not modified by the install')

  const profileAfter = await snapshotRealProfile()
  const touched = Object.keys(profileBefore.snap).filter((file) => profileBefore.snap[file] !== profileAfter.snap[file])
  if (Object.values(profileBefore.snap).every((value) => value === null)) {
    console.log('SKIP  the real desktop profile was never touched  — no desktop profile on this machine')
  } else {
    check(touched.length === 0, 'the real desktop profile was not written by this run', touched.join(', '))
  }

  // The runtime configuration this run actually resolved must contain no legacy reference at all.
  const configs = await configurationSources(home, [PROFILE_NAME, storageProfile], [installedDir, storageInstall.installedDir])
  // 2 profiles × (package.json + cordis.yml), plus one cordis.patch.yml per installed copy.
  check(configs.length === 6, 'every runtime configuration source was inspected', `${configs.length} files`)
  const legacyReferences = []
  for (const { file, text } of configs) {
    for (const pattern of LEGACY_TOKENS) {
      if (pattern.test(text)) legacyReferences.push(`${path.basename(file)}: ${pattern}`)
    }
  }
  check(legacyReferences.length === 0,
    'no runtime configuration references a Hermes / Personal-Agent / legacy-academic location',
    legacyReferences.join(', '))
  const hostInstallRoot = await fs.realpath(HARNESS_ROOT)
  const foreignPaths = configs.flatMap(({ file, text }) => [...text.matchAll(/"(\/[^"]+)"/g)]
    .map((match) => match[1])
    .filter((candidate) => !candidate.startsWith(home) && !candidate.startsWith(hostInstallRoot))
    .map((candidate) => `${path.basename(file)}: ${candidate}`))
  check(foreignPaths.length === 0,
    'no runtime configuration points outside the disposable home and the host install',
    foreignPaths.slice(0, 3).join(', '))

  const legacyObserved = await observeRealLegacy()
  for (const [target, state] of Object.entries(legacyObserved)) {
    console.log(`OBSERVED (not asserted) ${target}: ${state}`)
  }

  // ─── claims: what this run does and does not prove ────────────────────────
  section('claims: evidence classes')
  console.log('PROVED (registration/activation evidence): the installed artefact registers the bundle,')
  console.log('       the preset, the persona, 6 skills and 22 tools on the real host.')
  console.log('PROVED (real execution evidence): tool calls dispatched through the real pipeline, a')
  console.log('       refusal with its documented code, and a real host-process restart restoring state.')
  unverified('a native conversation turn', 'no model provider is configured in a disposable profile; a turn needs network access and spend')
  unverified('model-driven tool selection', 'tool calls here are dispatched by this verifier, not chosen by a model')
  unverified('the Phase 4 sidebar / UI shell', 'out of scope for Phase 1 by the acceptance brief')

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
