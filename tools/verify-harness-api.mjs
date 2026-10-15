/**
 * Phase 0 feasibility probe: does the INSTALLED Harness actually expose the host and client
 * extension APIs Professor v1 depends on?
 *
 * Why this exists
 * ---------------
 * `verify-preset-activation.mjs` proves the Professor *preset* mounts and that its tools register.
 * That is not the same question as "can a plugin add an independent sidebar entry, a settings page,
 * a persisted domain, and a native session?" — the Professor v1 plan needs those, and inventing them
 * would be a design failure. This probe boots the same real Cordis loader in a disposable home and
 * asks the live context for each service the v1 architecture depends on, then exercises the
 * smallest real operation for the ones that carry data:
 *
 *   - service presence (layout/slots are client-side; on the host the relevant faces are
 *     clientModules, webServer, storageDomain, agentPresets, sessions, sessionPersistence, ...)
 *   - `ctx.clientModules.graph()` — the `dsh.client` browser-plugin roster actually scanned
 *   - `ctx.sessions.create()` / `.list()` — a real native session can be created
 *   - `ctx.agentPresets.resolve('professor')` — a preset can be resolved before any agent starts
 *   - `ctx.storageDomain.open(spec)` + table roundtrip — versioned plugin-owned persistence works
 *
 * Isolation
 * ---------
 * Everything runs in a fresh `mktemp -d` `DSH_HOME`, removed on exit. The user's real profile
 * (`~/.dsh/profiles/desktop`) is snapshotted before and after to prove it is never written, and no
 * user session, course tree or old Registry/Knowledge file is opened.
 *
 * Run with the harness Node (asar-aware):
 *
 *   npm run verify:api
 *   # or
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     tools/verify-harness-api.mjs
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
const PROFILE_NAME = 'professor-api-check'
const INSTALL_ANCHOR = path.join(NODE_MODULES, '@deepseek-ai/dsh/package.json')

/** Host services the v1 architecture depends on, grouped so a failure names the milestone. */
const REQUIRED_SERVICES = [
  ['clientModules', 'M4 — browser plugin roster / dsh.client scan'],
  ['webServer', 'M4/M7 — HTTP carrier for plugin routes'],
  ['storageDomain', 'M2 — versioned plugin-owned persistence'],
  ['storage', 'M2 — storage hub'],
  ['agentPresets', 'M5 — resolve/select the Professor runtime'],
  ['sessions', 'M5 — create the native Harness session'],
  ['sessionPersistence', 'M5 — durable session storage'],
  ['sessionTitle', 'M5 — explicit session titles'],
  ['sessionQuery', 'M5 — list/recent Professor sessions'],
  ['workspaceRegistry', 'M3/M5 — academic folder as a workspace'],
  ['settings', 'M7 — plugin config forms'],
  ['configEditor', 'M7 — persist plugin config through the profile'],
  ['commands', 'M5 — human-command entry points'],
  ['tools', 'M1 — tool registry'],
  ['skills', 'M1 — skill provider registry'],
  ['fs', 'M1/M3 — filesystem provider'],
  ['sandboxPolicy', 'M1 — read/write authority per session'],
]

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
  const files = ['package.json', 'cordis.patch.yml', 'cordis.yml']
  const snap = {}
  for (const name of files) {
    const file = path.join(dir, name)
    snap[file] = (await exists(file)) ? digest(await fs.readFile(file, 'utf8')) : null
  }
  return { dir, snap }
}

const loadHarness = (specifier) => import(pathToFileURL(path.join(NODE_MODULES, specifier)).href)

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-professor-api-'))
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
  const environment = appBoot.loadLayeredEnv('dsh')

  section('compose (real loader inputs)')
  const profileDir = path.join(home, 'profiles', PROFILE_NAME)
  appBoot.initProfile(profileDir, appBoot.PROFILE_TEMPLATES.web.bundles)

  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.dependencies = { ...manifest.dependencies, [PACKAGE_NAME]: `link:${REPO}` }
  if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) manifest.dsh.profile.bundles.push(PACKAGE_NAME)
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const nodeModules = path.join(profileDir, 'node_modules')
  await fs.mkdir(nodeModules, { recursive: true })
  const link = path.join(nodeModules, PACKAGE_NAME)
  await fs.rm(link, { recursive: true, force: true })
  await fs.symlink(REPO, link, 'junction')

  const rootConfig = path.join(profileDir, 'cordis.yml')
  await fs.writeFile(rootConfig, '[]\n')

  const profile = appBoot.loadProfile('professor-api', PROFILE_NAME, INSTALL_ANCHOR, home, { userLayer: true })
  const layers = profile.layers.map((layer) => layer.packageName)
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
  const patches = appBoot.readProfilePatches('professor-api', profileContext, profile)

  section('mount (real Cordis loader)')
  let preparingHost
  const ctx = await activationDeadline(() => appBoot.boot('professor-api', rootConfig, patches, async (hostCtx) => {
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
  check(ctx.fiber?.state === 2, 'the composed tree reached the active state', String(ctx.fiber?.state))

  section('required host services')
  for (const [key, why] of REQUIRED_SERVICES) {
    const service = ctx.get(key)
    check(service !== undefined, `ctx.${key} is mounted`, service === undefined ? `missing (needed for ${why})` : why)
  }

  section('M4 — browser plugin roster (dsh.client scan)')
  const clientModules = ctx.get('clientModules')
  if (clientModules !== undefined) {
    const graph = clientModules.graph()
    const entries = graph?.entries ?? []
    check(Array.isArray(entries) && entries.length > 0, 'clientModules.graph() lists browser plugin entries', `${entries.length} entries`)
    const withBundle = entries.filter((entry) => typeof clientModules.clientPath(entry.id ?? entry.name) === 'string')
    check(withBundle.length > 0, 'at least one entry resolves an installed client bundle path', `${withBundle.length} resolvable`)
    const sample = withBundle.slice(0, 5).map((entry) => entry.id ?? entry.name)
    console.log(`      sample client entries: ${sample.join(', ')}`)
  }

  section('M5 — native session creation')
  const sessions = ctx.get('sessions')
  if (sessions !== undefined) {
    const session = sessions.create(undefined, { meta: { cwd: home } })
    check(session !== undefined, 'ctx.sessions.create() returns a session')
    const live = sessions.list()
    check(live.some((candidate) => candidate.id === session.id), 'the created session is in the live store')
    console.log(`      created session id: ${session.id}`)
  }

  section('M5 — preset resolution before first turn')
  const presets = ctx.get('agentPresets')
  if (presets !== undefined) {
    const resolved = await presets.resolve('professor')
    check(resolved?.id === 'professor', 'ctx.agentPresets.resolve("professor") resolves', String(resolved?.id))
    check(resolved?.broken === undefined, 'the resolved preset reports no activation failure', String(resolved?.broken ?? ''))
  }

  section('M2 — versioned plugin-owned persistence (ctx.storageDomain)')
  const storageDomain = ctx.get('storageDomain')
  if (storageDomain !== undefined) {
    // `@deepseek-ai/schemastery` ships an ESM entry at `lib/index.mjs` (its `import` export).
    const schemastery = await import(pathToFileURL(path.join(NODE_MODULES, '@deepseek-ai/schemastery/lib/index.mjs')).href)
    const z = schemastery.default ?? schemastery
    let domain
    try {
      domain = await storageDomain.open({
        // The JSON backend enforces `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` — lowercase, no hyphens.
        name: 'professor_probe',
        version: 1,
        tables: { entries: { valueSchema: z.string() } },
      })
      check(true, 'ctx.storageDomain.open() accepted a versioned domain spec')
      const table = domain.table('entries')
      await table.put('probe', 'ok')
      check(table.get('probe') === 'ok', 'a table value round-trips inside the disposable home')
      check(table.size === 1, 'the table reports its size', String(table.size))
    } catch (error) {
      check(false, 'ctx.storageDomain.open() accepted a versioned domain spec', error.message)
    } finally {
      if (domain !== undefined) await domain.close().catch(() => {})
    }
  }

  await ctx.fiber.dispose()
  check(true, 'the disposable tree disposed cleanly')

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
