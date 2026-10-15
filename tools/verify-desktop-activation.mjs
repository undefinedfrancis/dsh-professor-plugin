/**
 * Real-profile activation verification: does the `professor` preset activate inside the
 * composition the DESKTOP APP actually runs?
 *
 * What this adds over `verify-preset-activation.mjs`
 * ------------------------------------------------
 * `tools/verify-preset-activation.mjs` boots a disposable profile seeded from the shipped `web`
 * template. That proves the preset mounts, but the profile it mounts in is *synthesised*: its
 * bundle list is `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + this plugin.
 *
 * The desktop app does not run that. `~/.dsh/profiles/desktop/package.json` composes five bundles
 * — base, web-app, `@deepseek-ai/dsh-experimental-agent-team-profile`, `dsh-permission-rules`, and
 * `dsh-professor-spike` — and then applies that profile's own `cordis.patch.yml`. A bundle that
 * activates cleanly on its own can still fail once another bundle's plugins are in the tree, so
 * "the template composition activates" is not the same claim as "the app's composition activates".
 *
 * This verifier therefore reproduces the desktop profile's composition inputs EXACTLY — bundle
 * list and profile patch layer read from `~/.dsh/profiles/desktop` — and boots them with the real
 * Cordis loader, then reads the real preset registry the way Settings → Agent Presets does.
 *
 * Read-only with respect to the real profile
 * ------------------------------------------
 * Nothing is written to `~/.dsh`. The bundles are *read* from the real profile's `package.json`
 * and `cordis.patch.yml`; the tree itself is built in a fresh `mktemp -d` `DSH_HOME` that is
 * removed on exit. Packages the app ships inside `app.asar` resolve from the install anchor; the
 * two the profile installs itself are symlinked in from the real profile's `node_modules`
 * (read-only links, and `removeLinkProjections` only ever unlinks harness-owned projections).
 * The real profile's config files are digested before and after to prove the run never wrote them.
 *
 * Run it with the harness Node (asar-aware):
 *
 *   npm run verify:desktop
 *   # or
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     tools/verify-desktop-activation.mjs
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
const INSTALL_ANCHOR = path.join(NODE_MODULES, '@deepseek-ai/dsh/package.json')

const PACKAGE_NAME = 'dsh-professor-spike'
const REAL_HOME = path.join(os.homedir(), '.dsh')
const REAL_PROFILE_DIR = path.join(REAL_HOME, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
const PROFILE_NAME = 'desktop'

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

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 64 - title.length))}`)
const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
const exists = (candidate) => fs.stat(candidate).then(() => true).catch(() => false)
const loadHarness = (specifier) => import(pathToFileURL(path.join(NODE_MODULES, specifier)).href)

/** Digest the real profile's config so we can prove this run left it alone. */
async function snapshotRealProfile() {
  const files = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml']
  const snap = {}
  for (const name of files) {
    const file = path.join(REAL_PROFILE_DIR, name)
    snap[file] = (await exists(file)) ? digest(await fs.readFile(file, 'utf8')) : null
  }
  return snap
}

if (!(await exists(path.join(REAL_PROFILE_DIR, 'package.json')))) {
  console.log(`SKIP  no desktop profile at ${REAL_PROFILE_DIR}`)
  process.exit(0)
}

const realManifest = JSON.parse(await fs.readFile(path.join(REAL_PROFILE_DIR, 'package.json'), 'utf8'))
const realBundles = realManifest?.dsh?.profile?.bundles ?? []
const realDependencies = Object.keys(realManifest?.dependencies ?? {})
if (realBundles.length === 0) {
  console.log(`SKIP  ${REAL_PROFILE_DIR}/package.json declares no bundles`)
  process.exit(0)
}

console.log(`real profile:   ${REAL_PROFILE_DIR}`)
console.log(`real bundles:   ${realBundles.join(', ')}`)

// ── disposable home ─────────────────────────────────────────────────────────
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-professor-desktop-'))
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_DISABLED = '1'
const before = await snapshotRealProfile()
console.log(`disposable home: ${home}`)

let verdict = 1
try {
  const appBoot = await loadHarness('@deepseek-ai/dsh-app-boot/lib/index.js')
  const cmdline = await loadHarness('@deepseek-ai/dsh-cmdline/lib/index.js')
  const launchEnv = await loadHarness('@deepseek-ai/dsh-launch-environment/lib/index.js')
  const environment = appBoot.loadLayeredEnv('dsh')

  // ── replicate the desktop profile's composition inputs ────────────────────
  section('compose (the desktop profile\'s own inputs)')
  const profileDir = path.join(home, 'profiles', PROFILE_NAME)
  appBoot.initProfile(profileDir, realBundles)

  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  check(
    JSON.stringify(manifest.dsh.profile.bundles) === JSON.stringify(realBundles),
    'the disposable profile declares the same bundles, in the same order',
    manifest.dsh.profile.bundles.join(', '),
  )

  // The profile's own patch layer is part of the composition — copy it verbatim.
  const realPatch = path.join(REAL_PROFILE_DIR, 'cordis.patch.yml')
  if (await exists(realPatch)) {
    const text = await fs.readFile(realPatch, 'utf8')
    await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), text)
    check(true, 'the profile patch layer was copied from the real profile', `${text.length} bytes`)
  } else {
    check(false, 'the real profile has a cordis.patch.yml to copy')
  }

  // Everything the app ships resolves from the install anchor. Whatever the profile installed
  // itself must be linked in from the real profile's node_modules (read-only).
  const nodeModules = path.join(profileDir, 'node_modules')
  await fs.mkdir(nodeModules, { recursive: true })
  const linked = []
  for (const name of new Set([...realBundles, ...realDependencies])) {
    if (await exists(path.join(NODE_MODULES, name))) continue
    const source = name === PACKAGE_NAME
      ? REPO
      : path.join(REAL_PROFILE_DIR, 'node_modules', name)
    if (!(await exists(source))) continue
    const target = path.join(nodeModules, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.rm(target, { recursive: true, force: true })
    await fs.symlink(source, target, 'dir')
    linked.push(name)
  }
  check(true, 'profile-installed packages were linked in from the real profile', linked.join(', ') || '(none needed)')

  const missing = []
  for (const name of realBundles) {
    const resolvable = (await exists(path.join(NODE_MODULES, name)))
      || (await exists(path.join(nodeModules, name)))
    if (!resolvable) missing.push(name)
  }
  check(missing.length === 0, 'every real bundle is resolvable, so none can be skipped', missing.join(', '))

  await fs.writeFile(path.join(profileDir, 'cordis.yml'), '[]\n')

  const profile = appBoot.loadProfile('desktop-activation', PROFILE_NAME, INSTALL_ANCHOR, home, { userLayer: true })
  appBoot.reportSkippedBundles('desktop-activation', profile)
  const layers = profile.layers.map((layer) => layer.packageName)
  check(layers.includes(PACKAGE_NAME), 'the loader registered the professor bundle layer', layers.join(', '))
  const absent = realBundles.filter((name) => !layers.includes(name))
  check(absent.length === 0, 'every bundle the desktop profile declares became a real layer', absent.join(', '))

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
  const patches = appBoot.readProfilePatches('desktop-activation', profileContext, profile)

  // ── mount the real tree ───────────────────────────────────────────────────
  section('mount (real Cordis loader)')
  let preparingHost
  const ctx = await activationDeadline(() => appBoot.boot('desktop-activation', path.join(profileDir, 'cordis.yml'), patches, async (hostCtx) => {
    preparingHost = hostCtx
    hostCtx.provide('profileContext', profileContext)
    hostCtx.provide(launchEnv.DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    await hostCtx.plugin(appBoot.PluginPackages, { resolution })
    cmdline.provideCmdline(hostCtx, {
      args: ['--no-open', '--port', '0'],
      exit: () => {},
      ready: { onReady: () => () => {} },
    })
  }), { diagnostic: () => hostActivationDiagnostic(preparingHost) })
  check(ctx.fiber?.state === 2, 'the desktop profile\'s composed tree reached the active state', String(ctx.fiber?.state))
  check(ctx.get('agentPresets') !== undefined, 'the real preset registry is mounted')
  check(ctx.get('tools') !== undefined, 'the real tool registry is mounted')

  // ── read the registry the way Settings → Agent Presets does ───────────────
  section('preset registry (read-only)')
  const presets = await ctx.get('agentPresets').list()
  const professor = presets.find((row) => row.id === 'professor')
  check(professor !== undefined, 'the professor preset is declared', presets.map((row) => row.id).join(', '))
  check(professor?.name === 'Professor', 'the preset keeps its display name', String(professor?.name))
  check(professor?.broken === undefined, 'the professor preset is NOT marked broken', String(professor?.broken ?? ''))
  check(professor?.order === 20, 'the preset keeps its designed order', String(professor?.order))

  const resolved = await ctx.get('agentPresets').resolve('professor')
  check(resolved?.id === 'professor', 'the new-session mode picker can resolve the preset')
  check(resolved?.broken === undefined, 'resolving it reports no diagnostic', String(resolved?.broken ?? ''))

  const inventory = await ctx.get('agentPresets').compositionInventory()
  const entry = inventory.find((row) => row.id === 'professor')
  check(entry !== undefined, 'the professor preset has a composition inventory entry')
  const rows = Array.isArray(entry?.rows) ? entry.rows : []
  check(rows.length === 13, 'the inventory lists all 13 declared child rows', `${rows.length} rows`)
  const notActive = rows.filter((row) => row.fiberState !== 2)
  check(notActive.length === 0, 'every child row reached the active state', notActive.map((row) => `${row.entryId}=${row.fiberState}`).join(', '))
  const unresolved = rows.filter((row) => row.enabled !== true)
  check(unresolved.length === 0, 'no child row is left disabled or conditional', unresolved.map((row) => row.entryId).join(', '))

  // ── the preset's own tool surface actually registered ─────────────────────
  section('preset tool surface')
  const { livePresetMounts } = await loadHarness('@deepseek-ai/dsh-agent-preset-registry/lib/index.js')
  const mounts = livePresetMounts(ctx.fiber)
  const mount = mounts.find((candidate) => candidate.presetId === 'professor')
  check(mount !== undefined, 'the registry holds a live mount for the professor preset', mounts.map((m) => m.presetId).join(', '))

  const toolsService = ctx.get('tools')
  const visibleNames = new Set()
  for (const scope of [mount?.key, mount?.tree?.ctx, mount?.fiber?.ctx]) {
    if (scope === undefined) continue
    try {
      const view = toolsService.view(scope)
      for (const name of view?.visible?.keys() ?? []) visibleNames.add(name)
    } catch { /* scope probe is best-effort */ }
  }
  const missingProfessor = EXPECTED_PROFESSOR_TOOLS.filter((name) => !visibleNames.has(name))
  check(missingProfessor.length === 0, `all ${EXPECTED_PROFESSOR_TOOLS.length} professor tools are registered`, missingProfessor.join(', '))
  const missingChildren = EXPECTED_CHILD_TOOLS.filter((name) => !visibleNames.has(name))
  check(missingChildren.length === 0, 'the required child plugins activated too', missingChildren.join(', '))
  console.log(`      tool surface: ${visibleNames.size} tools`)

  await ctx.fiber.dispose()
  check(true, 'the disposable tree disposed cleanly')

  // ── isolation ─────────────────────────────────────────────────────────────
  section('isolation')
  const after = await snapshotRealProfile()
  const touched = Object.keys(before).filter((file) => before[file] !== after[file])
  check(touched.length === 0, 'the real desktop profile was not written by this run', touched.join(', '))

  verdict = failures === 0 ? 0 : 1
} finally {
  await fs.rm(home, { recursive: true, force: true })
  console.log(`\ndisposable home removed: ${home}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} 项失败`)
process.exit(verdict)
