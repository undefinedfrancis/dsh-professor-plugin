/**
 * Real-host verification for Professor's OWN application storage (`professor_app`).
 *
 * Why this is not `verify-harness-api.mjs`
 * ----------------------------------------
 * `verify-harness-api.mjs` proves the host *has* a storage domain by opening a throwaway domain
 * whose table declares `valueSchema: z.string()`. That answers "is the API there?" but not "does the
 * spec the plugin actually ships work?" — and it never reopens the domain, which is exactly the gap
 * that hid a real defect: the plugin used to ship `tables: { app: {} }`, which opens, accepts writes,
 * and then REFUSES TO REOPEN once anything is persisted (the loader calls `valueSchema.parse(raw)`
 * for every stored record; with no schema that is `undefined.parse(raw)`, reported as
 * `invalid-record`). This verifier is the one that caught it, so it keeps the reopen path.
 *
 * It hands the REAL `createAppStorage()` — the function `src/plugin.js` calls at mount — the REAL
 * storage service, inside a disposable Harness home, and checks the whole contract the module
 * documents in `src/app/storage.js`:
 *
 *   - the shipped spec opens as-is (one table, whose `valueSchema` implements the host's `parse()`
 *     contract, with NO schema-library dependency);
 *   - the first open bootstraps exactly one `bootstrap` record and reports `status: 'open'`;
 *   - the bytes land in the host's documented location (`<DSH_HOME>/storages/professor_app.json`),
 *     never inside the package and never inside an academic folder;
 *   - a FRESH handle over the same bytes reopens the domain and finds the marker already there,
 *     without rewriting it (the regression above);
 *   - a second CONCURRENT open is refused by the backend rather than silently double-mounted;
 *   - an arbitrary record round-trips through the plugin's own table handle;
 *   - `close()` releases the handle and is safe to call twice;
 *   - a host WITHOUT `ctx.storageDomain` reports `status: 'unavailable'` and does not throw —
 *     a general Professor session must still start.
 *
 * Isolation
 * ---------
 * Everything runs in a fresh `mktemp -d` `DSH_HOME`, removed on exit. The user's real profile
 * (`~/.dsh/profiles/desktop`) is snapshotted before and after to prove it is never written, and no
 * user session, course tree or old Registry/Knowledge file is opened.
 *
 * Run it with the harness Node (asar-aware):
 *
 *   npm run verify:app-storage
 *   # or
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     tools/verify-app-storage.mjs
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
const PROFILE_NAME = 'professor-app-storage-check'
const INSTALL_ANCHOR = path.join(NODE_MODULES, '@deepseek-ai/dsh/package.json')

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

// The plugin's own modules are plain ESM on disk — imported directly, not through the profile link,
// so the verifier exercises the exact source a developer is editing.
const storageModule = await import(pathToFileURL(path.join(REPO, 'src/app/storage.js')).href)
const {
  createAppStorage,
  APP_DOMAIN_SPEC,
  APP_DOMAIN_NAME,
  APP_DOMAIN_VERSION,
  APP_STORAGE_OWNER,
  APP_RECORD_SCHEMA,
  APP_BOOTSTRAP_KEY,
} = storageModule

const ownPackage = JSON.parse(await fs.readFile(path.join(REPO, 'package.json'), 'utf8'))
const readVersion = async () => ownPackage.version

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-professor-app-storage-'))
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

  const profile = appBoot.loadProfile('professor-app-storage', PROFILE_NAME, INSTALL_ANCHOR, home, { userLayer: true })
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
  const patches = appBoot.readProfilePatches('professor-app-storage', profileContext, profile)

  section('mount (real Cordis loader)')
  let preparingHost
  const ctx = await activationDeadline(() => appBoot.boot('professor-app-storage', rootConfig, patches, async (hostCtx) => {
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

  // ── the shipped spec ──────────────────────────────────────────────────────
  section('shipped domain spec')
  check(APP_DOMAIN_NAME === 'professor_app', 'the domain name is the documented single domain', APP_DOMAIN_NAME)
  check(
    /^[a-z][a-z0-9_]*$/.test(APP_DOMAIN_SPEC.name),
    'the domain name satisfies the backend unit-name rule (/^[a-z][a-z0-9_]*$/)',
    APP_DOMAIN_SPEC.name,
  )
  check(APP_DOMAIN_VERSION === 1, 'the domain version is 1', String(APP_DOMAIN_VERSION))
  check(
    JSON.stringify(Object.keys(APP_DOMAIN_SPEC.tables)) === JSON.stringify(['app']),
    'the spec declares exactly the one table',
    JSON.stringify(Object.keys(APP_DOMAIN_SPEC.tables)),
  )
  // The host's loader calls `tableSpec.valueSchema.parse(raw)` for every stored record. A table
  // without a valueSchema opens once and then refuses to reopen — so the schema is mandatory.
  const schema = APP_DOMAIN_SPEC.tables.app.valueSchema
  check(
    typeof schema?.parse === 'function',
    'the table declares a valueSchema implementing the host\'s parse() contract (no schema dependency)',
    typeof schema,
  )
  check(
    schema?.parse({ any: 'json value' })?.any === 'json value',
    'the validator returns a JSON record unchanged',
  )
  let refusedNull = false
  try { schema?.parse(null) } catch { refusedNull = true }
  check(refusedNull, 'the validator refuses a value the JSON medium could not round-trip')

  // ── the plugin's own handle against the real service ──────────────────────
  section('createAppStorage() against the real ctx.storageDomain')
  const warnings = []
  const logger = { warn: (message) => warnings.push(String(message)), info: () => {}, debug: () => {} }

  const storage = createAppStorage({ ctx, logger, readVersion })
  check(storage.spec === APP_DOMAIN_SPEC, 'the handle exposes the frozen spec it will open')

  const opened = await storage.ensureOpen()
  check(opened.status === 'open', 'ensureOpen() reports the domain open', JSON.stringify({ status: opened.status, reason: opened.reason }))
  check(opened.bootstrapped === true, 'the first open bootstrapped the domain')
  check(opened.reason === null, 'an open domain reports no reason', String(opened.reason))
  check(opened.owner === APP_STORAGE_OWNER, 'the snapshot names the owning package', String(opened.owner))
  check(
    Array.isArray(opened.tables) && opened.tables.includes('app'),
    'the snapshot lists the declared table',
    JSON.stringify(opened.tables),
  )
  check(
    typeof opened.defaultPathHint === 'string' && opened.defaultPathHint.includes('professor_app'),
    'the snapshot documents the host\'s default location as a hint',
    String(opened.defaultPathHint),
  )

  // ── where the bytes actually landed ───────────────────────────────────────
  section('portable storage location')
  const domainFile = path.join(home, 'storages', `${APP_DOMAIN_NAME}.json`)
  const landed = await exists(domainFile)
  check(landed, 'the host wrote the domain into $DSH_HOME/storages/, not the package or a course folder', domainFile)
  check(
    !(await exists(path.join(REPO, 'storages'))) && !(await exists(path.join(REPO, `${APP_DOMAIN_NAME}.json`))),
    'nothing was written inside the plugin package',
  )
  if (landed) {
    const parsed = JSON.parse(await fs.readFile(domainFile, 'utf8'))
    const record = JSON.stringify(parsed)
    check(record.includes(APP_BOOTSTRAP_KEY), 'the persisted file carries the bootstrap marker')
    check(record.includes(APP_STORAGE_OWNER), 'the persisted file attributes the domain to this plugin')
  }

  // ── the bootstrap record's shape ──────────────────────────────────────────
  section('bootstrap record')
  const table = storage.table('app')
  check(table !== undefined, 'storage.table("app") returns the live table handle')
  const bootstrap = table?.get?.(APP_BOOTSTRAP_KEY)
  check(bootstrap !== undefined && bootstrap !== null, 'the bootstrap record is readable')
  check(bootstrap?.schema === APP_RECORD_SCHEMA, 'the bootstrap record carries the record schema tag', String(bootstrap?.schema))
  check(bootstrap?.owner === APP_STORAGE_OWNER, 'the bootstrap record carries the owner', String(bootstrap?.owner))
  check(bootstrap?.domain === APP_DOMAIN_NAME, 'the bootstrap record carries the domain name', String(bootstrap?.domain))
  check(bootstrap?.domain_version === APP_DOMAIN_VERSION, 'the bootstrap record carries the domain version', String(bootstrap?.domain_version))
  check(bootstrap?.plugin_version === ownPackage.version, 'the bootstrap record carries this package\'s version', String(bootstrap?.plugin_version))
  check(typeof bootstrap?.created_at === 'string' && bootstrap.created_at.length > 0, 'the bootstrap record carries a creation timestamp', String(bootstrap?.created_at))

  // ── arbitrary records round-trip through the plugin's handle ─────────────
  section('record round-trip')
  const probe = { schema: APP_RECORD_SCHEMA, note: 'app-storage probe', at: new Date().toISOString() }
  await table.put('probe', probe)
  const readBack = table.get('probe')
  check(
    readBack !== undefined && readBack.note === probe.note,
    'an arbitrary record round-trips through the plugin table handle',
  )
  check(table.size >= 2, 'the table reports its size including the new record', String(table.size))

  // ── concurrent open: the shipped backend does not allow it ───────────────
  //
  // A real finding, pinned here so a future regression is noticed: while a domain is open, the
  // shipped JSON backend refuses a second `open()` of the SAME domain name (`open-failed: …`). The
  // plugin's own lazy-open makes this a non-issue in practice — one instance owns one domain per
  // process — but the behaviour is documented rather than assumed.
  section('concurrent open is refused by the backend')
  const concurrentWarnings = []
  const concurrent = createAppStorage({
    ctx,
    logger: { warn: (message) => concurrentWarnings.push(String(message)), info: () => {}, debug: () => {} },
    readVersion,
  })
  const concurrentOpen = await concurrent.ensureOpen()
  check(
    concurrentOpen.status === 'unavailable',
    'a second concurrent open() of the same domain is refused, not silently double-mounted',
    JSON.stringify({ status: concurrentOpen.status, reason: concurrentOpen.reason }),
  )
  check(
    concurrent.table('app') === undefined,
    'a refused concurrent open offers no table handle',
  )
  await concurrent.close()

  // ── idempotence: a handle opened AFTER close finds the marker ────────────
  section('idempotence (reopen after close)')
  const createdAta = bootstrap?.created_at
  await storage.close()
  const second = createAppStorage({ ctx, logger, readVersion })
  const reopened = await second.ensureOpen()
  check(reopened.status === 'open', 'a handle opened after close opens the same domain', JSON.stringify({ status: reopened.status, reason: reopened.reason }))
  check(reopened.bootstrapped === false, 'the reopen recognises the existing marker and does not re-bootstrap')
  const bootstrapAgain = second.table('app')?.get?.(APP_BOOTSTRAP_KEY)
  check(bootstrapAgain?.created_at === createdAta, 'the original bootstrap record is left untouched', String(bootstrapAgain?.created_at))
  await second.close()

  // ── close is clean and repeatable ─────────────────────────────────────────
  section('close')
  await storage.close()
  check(true, 'close() is safe to call twice')
  check(storage.table('app') === undefined, 'the table handle is gone after close')
  check(warnings.length === 0, 'no warnings were emitted during a healthy run', warnings.join(' | '))
  check(concurrentWarnings.length === 0, 'the refused concurrent open emitted no warning (a refusal is a reported state, not an error)', concurrentWarnings.join(' | '))

  // ── degradation: a host without storageDomain must not fail the session ──
  section('degradation (no ctx.storageDomain)')
  const bareWarnings = []
  const bare = createAppStorage({
    ctx: { get: () => undefined },
    logger: { warn: (message) => bareWarnings.push(String(message)), info: () => {}, debug: () => {} },
    readVersion,
  })
  const unavailable = await bare.ensureOpen()
  check(unavailable.status === 'unavailable', 'a host without storageDomain reports "unavailable", never throws', String(unavailable.status))
  check(
    typeof unavailable.reason === 'string' && unavailable.reason.includes('storageDomain'),
    'the reason names the missing service so the diagnostic is actionable',
    String(unavailable.reason),
  )
  check(bare.table('app') === undefined, 'no table handle is offered when the domain could not open')
  await bare.close()
  check(true, 'close() is safe on a handle that never opened')

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
