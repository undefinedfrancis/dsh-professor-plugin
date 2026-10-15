/**
 * Real preset-activation verification: does `preset-professor` actually MOUNT in the installed
 * Harness, and does the preset registry report it as usable?
 *
 * Why `--dump-config` is not enough
 * ---------------------------------
 * `tools/verify-runtime-boot.mjs` proves the patch *composes*: the loader reads every bundle layer,
 * applies the patch, and prints the same tree twice. It never instantiates a plugin. A tool whose
 * `output.schema` the host refuses — or a required child row the host rejects on its own config
 * schema — composes perfectly and then fails to load, which is exactly what happened:
 *
 *   Settings → Agent Presets showed "Failed to load" while every dump-based check was green.
 *
 * So this verifier boots the real thing: it hands the composed tree to the real Cordis loader
 * (`@deepseek-ai/dsh-app-boot#boot`, the same entry point `dsh <profile>` uses) and then reads the
 * **real preset registry** the way the Settings UI does.
 *
 * Why the `web` template
 * ----------------------
 * The preset plane lives in the `dsh-web-app` bundle (`@deepseek-ai/dsh-agent-preset-registry` +
 * `@deepseek-ai/dsh-agent-preset`); the one-shot `headless` template does not include it. The
 * disposable profile is therefore initialised from the shipped `web` template, so the host
 * services the preset's children inject are the real ones — no hand-rolled service stubs.
 *
 * Isolation
 * ---------
 * Everything happens inside a fresh `mktemp -d` `DSH_HOME`, removed on exit. The user's real
 * profile (`~/.dsh/profiles/desktop`) is never opened: this script never reads or writes it, and
 * it snapshots that directory before and after to prove it.
 *
 * Run it with the harness Node (asar-aware):
 *
 *   npm run verify:activation
 *   # or
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     tools/verify-preset-activation.mjs
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { activationDeadline, hostActivationDiagnostic } from './activation-deadline.mjs'

const HARNESS_ROOT = process.env.DSH_HARNESS
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const NODE_MODULES = path.join(HARNESS_ROOT, 'dsh/node_modules')
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PACKAGE_NAME = 'dsh-professor-spike'
const PROFILE_NAME = 'professor-activation-check'
const INSTALL_ANCHOR = path.join(NODE_MODULES, '@deepseek-ai/dsh/package.json')

/** Every `professor_*` tool the runtime plugin must end up registering. */
const EXPECTED_PROFESSOR_TOOLS = [
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

/** Children of the preset that must ALSO have activated, so a partially mounted preset fails. */
const EXPECTED_CHILD_TOOLS = [
  'todo_write',
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
  'ask_user_question',
  'present',
  'skill',
]

/** The six workflows this bundle ships (`skills/<name>/SKILL.md`). */
const EXPECTED_SKILLS = [
  'professor-course-management',
  'professor-study',
  'professor-notes',
  'professor-review',
  'professor-research',
  'professor-latex',
]

/** `SKILL_PROVIDER_NAME` in `src/skills/provider.js`: a provider name, never a skill in its own right. */
const SKILL_PROVIDER_INTERNAL_NAME = 'professor-bundled'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 64 - title.length))}`)
const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
const exists = (candidate) => fs.stat(candidate).then(() => true).catch(() => false)

/** Snapshot the REAL desktop profile so we can prove this run never wrote to it. */
async function snapshotRealProfile() {
  const dir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
  const files = ['package.json', 'cordis.patch.yml']
  const snap = {}
  for (const name of files) {
    const file = path.join(dir, name)
    snap[file] = (await exists(file)) ? digest(await fs.readFile(file, 'utf8')) : null
  }
  return { dir, snap }
}

const loadHarness = (specifier) => import(pathToFileURL(path.join(NODE_MODULES, specifier)).href)

// ── disposable home ─────────────────────────────────────────────────────────
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-professor-activation-'))
// Resolved per call by the harness, so setting it before any harness module is imported is enough.
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_DISABLED = '1'

const before = await snapshotRealProfile()
console.log(`disposable Harness home: ${home}`)
console.log(`real profile snapshot:   ${before.dir}`)

let verdict = 1
try {
  const appBoot = await loadHarness('@deepseek-ai/dsh-app-boot/lib/index.js')
  const cmdline = await loadHarness('@deepseek-ai/dsh-cmdline/lib/index.js')
  const launchEnv = await loadHarness('@deepseek-ai/dsh-launch-environment/lib/index.js')

  // The installed launch-environment service is a layered reader (`get` / `getFrom`), not a plain
  // object: `dsh` passes `loadLayeredEnv('dsh')` here, and the LLM adapters and the directory
  // picker read it during their own activation. A raw `process.env` fails all four of them.
  const environment = appBoot.loadLayeredEnv('dsh')

  section('compose (real loader inputs)')
  const profileDir = path.join(home, 'profiles', PROFILE_NAME)
  appBoot.initProfile(profileDir, appBoot.PROFILE_TEMPLATES.web.bundles)

  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.dependencies = { ...manifest.dependencies, [PACKAGE_NAME]: `link:${REPO}` }
  if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) manifest.dsh.profile.bundles.push(PACKAGE_NAME)
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  check(
    manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app'),
    'the disposable profile keeps the shipped web host plane (preset registry included)',
  )

  const nodeModules = path.join(profileDir, 'node_modules')
  await fs.mkdir(nodeModules, { recursive: true })
  const link = path.join(nodeModules, PACKAGE_NAME)
  await fs.rm(link, { recursive: true, force: true })
  await fs.symlink(REPO, link, 'junction')
  check(await exists(path.join(link, 'package.json')), 'the bundle resolves from the profile directory', `link:${REPO}`)

  // The loader reads this root entry list; the empty tree is what every bundle patches over.
  const rootConfig = path.join(profileDir, 'cordis.yml')
  await fs.writeFile(rootConfig, '[]\n')

  const profile = appBoot.loadProfile('professor-activation', PROFILE_NAME, INSTALL_ANCHOR, home, { userLayer: true })
  appBoot.reportSkippedBundles('professor-activation', profile)
  const layers = profile.layers.map((layer) => layer.packageName)
  check(layers.includes(PACKAGE_NAME), 'the loader registered the professor bundle layer', layers.join(', '))

  const resolution = await appBoot.createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile })
  const profileContext = {
    name: PROFILE_NAME,
    dir: profile.dir,
    patchPath: profile.patchPath,
    installAnchor: INSTALL_ANCHOR,
    startedBundles: layers,
    cwd: process.cwd(),
    home,
    overlays: [],
    telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
  }
  const patches = appBoot.readProfilePatches('professor-activation', profileContext, profile)

  // ── mount the real tree ───────────────────────────────────────────────────
  section('mount (real Cordis loader)')
  let preparingHost
  const ctx = await activationDeadline(() => appBoot.boot('professor-activation', rootConfig, patches, async (hostCtx) => {
    preparingHost = hostCtx
    hostCtx.provide('profileContext', profileContext)
    hostCtx.provide(launchEnv.DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    await hostCtx.plugin(appBoot.PluginPackages, { resolution })
    // `--no-open`/`--port 0` keep the disposable web host plane from launching a browser or
    // contending for the real app's port; the preset registry is mounted either way.
    cmdline.provideCmdline(hostCtx, {
      args: ['--no-open', '--port', '0'],
      exit: () => {},
      ready: { onReady: () => () => {} },
    })
  }), { diagnostic: () => hostActivationDiagnostic(preparingHost) })
  check(ctx.fiber?.state === 2, 'the composed tree reached the active state', String(ctx.fiber?.state))
  check(ctx.get('loader') !== undefined, 'the loader service is present')
  check(ctx.get('agentPresets') !== undefined, 'the real preset registry is mounted')
  check(ctx.get('tools') !== undefined, 'the real tool registry is mounted')

  // ── read the registry the way Settings → Agent Presets does ───────────────
  //
  // `list()` is exactly what the Settings page renders, and `broken` is exactly the line it shows
  // as "Failed to load". `compositionInventory()` reports each declared child row's live state.
  section('preset registry (read-only)')
  const presets = await ctx.get('agentPresets').list()
  const professor = presets.find((row) => row.id === 'professor')
  check(professor !== undefined, 'the professor preset is declared', presets.map((row) => row.id).join(', '))
  check(professor?.name === 'Professor', 'the preset keeps its display name', String(professor?.name))
  check(professor?.broken === undefined, 'the professor preset is NOT marked broken', String(professor?.broken ?? ''))
  check(professor?.order === 20, 'the preset keeps its designed order', String(professor?.order))

  // `resolve` is what the new-session mode picker calls before offering a preset.
  const resolutionResult = await ctx.get('agentPresets').resolve('professor')
  check(resolutionResult?.id === 'professor', 'the picker can resolve the professor preset')
  check(resolutionResult?.broken === undefined, 'resolving it reports no diagnostic', String(resolutionResult?.broken ?? ''))

  const inventory = await ctx.get('agentPresets').compositionInventory()
  const entry = inventory.find((row) => row.id === 'professor')
  check(entry !== undefined, 'the professor preset has a composition inventory entry')
  const rows = Array.isArray(entry?.rows) ? entry.rows : []
  check(rows.length > 0, 'the inventory lists the preset\'s declared child rows', `${rows.length} rows`)
  const notActive = rows.filter((row) => row.fiberState !== 2)
  check(notActive.length === 0, 'every child row reached the active state', notActive.map((row) => `${row.entryId}=${row.fiberState}`).join(', '))
  const unresolved = rows.filter((row) => row.enabled !== true)
  check(unresolved.length === 0, 'no child row is left disabled or conditional', unresolved.map((row) => row.entryId).join(', '))
  console.log(`      child rows: ${rows.map((row) => `${row.entryId}(${row.fiberState})`).join(' ')}`)

  // ── the preset's own tool surface actually registered ─────────────────────
  //
  // The preset's children register into the preset's OWN scope (that is the whole point of the
  // roster: a deployment-level view must not see them), so the global `view(undefined)` is
  // legitimately empty here. `livePresetMounts()` is the registry's exported handle on the
  // standing composition, and its `key` is the scope the children registered under.
  section('preset tool surface')
  const { livePresetMounts } = await loadHarness('@deepseek-ai/dsh-agent-preset-registry/lib/index.js')
  const mounts = livePresetMounts(ctx.fiber)
  check(mounts.length > 0, 'the registry holds a live mount for the running composition', `${mounts.length} mount(s)`)
  const mount = mounts.find((candidate) => candidate.presetId === 'professor')
  check(mount !== undefined, 'the live mount is the professor preset', mounts.map((m) => m.presetId).join(', '))

  const toolsService = ctx.get('tools')
  const visibleNames = new Set()
  for (const scope of [mount?.key, mount?.tree?.ctx, mount?.fiber?.ctx]) {
    if (scope === undefined) continue
    try {
      const view = toolsService.view(scope)
      for (const name of view?.visible?.keys() ?? []) visibleNames.add(name)
    } catch (error) {
      console.log(`      (scope probe failed: ${error.message})`)
    }
  }
  check(visibleNames.size > 0, 'the preset scope exposes a tool surface', `${visibleNames.size} tools`)
  const missingProfessor = EXPECTED_PROFESSOR_TOOLS.filter((name) => !visibleNames.has(name))
  check(missingProfessor.length === 0, `all ${EXPECTED_PROFESSOR_TOOLS.length} professor tools are registered`, missingProfessor.join(', '))

  // A subset check alone is not an inventory: a tool that vanished must fail as loudly as one that
  // was never added, so compare the visible `professor_*` set exactly.
  const visibleProfessor = [...visibleNames].filter((name) => name.startsWith('professor_')).sort()
  const expectedProfessor = [...EXPECTED_PROFESSOR_TOOLS].sort()
  const symmetricDifference = visibleProfessor
    .filter((name) => !expectedProfessor.includes(name))
    .concat(expectedProfessor.filter((name) => !visibleProfessor.includes(name)))
  check(
    symmetricDifference.length === 0,
    `exactly the ${expectedProfessor.length} expected professor_* tools are visible`,
    `visible=${visibleProfessor.length} unexpected/missing=${JSON.stringify(symmetricDifference)}`,
  )

  const missingChildren = EXPECTED_CHILD_TOOLS.filter((name) => !visibleNames.has(name))
  check(missingChildren.length === 0, 'the required child plugins activated too', missingChildren.join(', '))

  console.log(`\nregistered tool surface (${visibleNames.size}):`)
  console.log(`  ${[...visibleNames].sort().join('\n  ')}`)

  // ── the preset's bundled skills are discoverable through the real registry ──
  //
  // Tools are only half of "the persona and the six workflows are available": the skills this bundle
  // ships are delivered by a provider the plugin registers into ITS OWN scope, so a deployment-level
  // view legitimately sees none of them. Reading the real `ctx.skills` registry with the preset's
  // scope is what proves a Professor session actually receives them.
  section('preset skill surface')
  const skillsService = ctx.get('skills')
  check(skillsService !== undefined, 'the real skill registry is mounted')
  const discovered = new Set()
  for (const scope of [mount?.key, mount?.tree?.ctx, mount?.fiber?.ctx]) {
    if (scope === undefined) continue
    try {
      const listed = await skillsService.list({ scope, cwd: home })
      for (const entry of listed) discovered.add(entry.name)
    } catch (error) {
      console.log(`      (skill scope probe failed: ${error.message})`)
    }
  }
  const discoveredSkills = [...discovered].sort()
  // A workspace with NO academic folder and NO legacy data: exactly the case the v1 brief calls out.
  const missingSkills = EXPECTED_SKILLS.filter((name) => !discoveredSkills.includes(name))
  check(
    missingSkills.length === 0,
    `all ${EXPECTED_SKILLS.length} bundled skills are discoverable in the preset scope`,
    missingSkills.length === 0 ? discoveredSkills.join(', ') : `missing ${missingSkills.join(', ')}`,
  )
  check(
    discoveredSkills.includes(SKILL_PROVIDER_INTERNAL_NAME) === false,
    'the provider name itself is not leaked as a skill',
  )

  await ctx.fiber.dispose()
  check(true, 'the disposable tree disposed cleanly')

  // ── isolation ─────────────────────────────────────────────────────────────
  section('isolation')
  const after = await snapshotRealProfile()
  const touched = Object.keys(before.snap).filter((file) => before.snap[file] !== after.snap[file])
  if (Object.values(before.snap).every((value) => value === null)) {
    console.log('SKIP  the real profile was never touched  — no desktop profile on this machine')
  } else {
    check(touched.length === 0, 'the real desktop profile was not written by this run', touched.join(', '))
  }

  verdict = failures === 0 ? 0 : 1
} finally {
  await fs.rm(home, { recursive: true, force: true })
  console.log(`\ndisposable home removed: ${home}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} 项失败`)
process.exit(verdict)
