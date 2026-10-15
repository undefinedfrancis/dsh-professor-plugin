/**
 * Real-boot verification for the Professor preset (M3): **composition**, not activation.
 *
 * What this proves — and what it does NOT
 * ---------------------------------------
 * `tools/verify-profile-composition.mjs` composes the patch layers by calling `applyEntryPatches`
 * itself. That proves the patch *composes*; it does not prove the loader *boots* it. The acceptance
 * note for M3 says "线上加载需重启后验证" — online loading must be verified after a restart — and this
 * verifier is that check: the real `dsh` launcher, cold, twice, over one disposable profile.
 *
 * It is still a COMPOSITION check. `--dump-config` prints the composed tree and exits; it never
 * instantiates a plugin, so it cannot see a tool schema the host refuses, a child row the host
 * rejects against its own config schema, or any other activation failure. That gap is real: the
 * preset once composed perfectly here while the desktop UI showed "Failed to load". Do not cite
 * this script as proof that the preset starts. Runtime activation is covered by
 * `tools/verify-preset-activation.mjs` (the real loader mounts the real tree) and the schema /
 * registration path by `tools/verify-host-schemas.mjs`.
 *
 * It hands the bundle to the real `dsh` CLI inside a **disposable Harness home**, so the real
 * loader performs the whole sequence on its own: bundle resolution (install anchor, then profile),
 * manifest read, `evaluatePluginCompatibility`, patch loading, and composition.
 *
 *   1. `mktemp -d`                          → a disposable `$DSH_HOME`; nothing outside it is written
 *   2. `dsh --from-default-profile headless --profile <name>`
 *                                           → the loader initializes a real profile from a shipped
 *                                             template, then dumps it
 *   3. declare the bundle                    → a `link:` dependency + a `dsh.profile.bundles` entry
 *   4. `dsh --profile <name> --dump-config`  → the REAL loader composes the tree
 *   5. assert the preset mounts the runtime plugin, and no deployment-level row does
 *   6. `--dump-config` again in a new process → a restart reproduces the tree byte for byte
 *
 * What "restart" means here: two separate `dsh` processes, each booting the loader from cold, over
 * the same profile. Identical output means the composition is a pure function of the patch layers —
 * no boot-order state, no accumulation, no drift.
 *
 * Safety: the disposable home is removed on exit, and the verifier snapshots the *real* profile's
 * `package.json` and `cordis.patch.yml` before and after to prove it never touched them. The Hermes
 * profile and the Personal-Agent registry are not referenced at all.
 *
 * Run it with the harness Node (asar-aware):
 *
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     tools/verify-runtime-boot.mjs
 *
 * `DSH_BIN` overrides the `dsh` launcher path; `DSH_HOME` from the environment is deliberately
 * ignored (the verifier always uses its own disposable home).
 */

import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const APP_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const APP_NODE_MODULES = path.join(APP_ASAR, 'dsh/node_modules')
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const DSH_BIN = process.env.DSH_BIN ?? '/usr/local/bin/dsh'
const PACKAGE_NAME = 'dsh-professor-spike'
const PROFILE_NAME = 'professor-boot-check'

/** The rows the preset must mount, in the designed order (see `cordis.patch.yml`). */
const EXPECTED_PRESET_PLUGINS = [
  ['persona', '@deepseek-ai/dsh-persona'],
  ['professor-runtime', PACKAGE_NAME],
  ['tool-fs', '@deepseek-ai/dsh-tool-fs'],
  ['tool-fs-search', '@deepseek-ai/dsh-tool-fs-search'],
  ['tool-bash', '@deepseek-ai/dsh-tool-bash'],
  ['tool-web', '@deepseek-ai/dsh-tool-web'],
  ['tool-ask-user', '@deepseek-ai/dsh-tool-ask-user'],
  ['tool-todo', '@deepseek-ai/dsh-tool-todo'],
  ['present', '@deepseek-ai/dsh-tool-present'],
  ['tool-skill', '@deepseek-ai/dsh-tool-skill'],
  ['compaction', 'cordis:group'],
]

/** Rows the design deliberately leaves out of the Professor tool surface. */
const FORBIDDEN_PRESET_PLUGINS = [
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-tool-plan',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-plugin-manager',
]

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}
const skip = (label, detail = '') => console.log(`SKIP  ${label}${detail ? `  — ${detail}` : ''}`)

// --- harness YAML (same instance the loader uses) --------------------------
const require = createRequire(import.meta.url)
let yaml
try {
  yaml = require(path.join(APP_NODE_MODULES, 'yaml'))
} catch (error) {
  console.error(`cannot load the harness YAML parser from ${APP_NODE_MODULES}: ${error.message}`)
  console.error('run this verifier with the harness Node: ELECTRON_RUN_AS_NODE=1 ".../DeepSeek Harness" tools/verify-runtime-boot.mjs')
  process.exit(1)
}

/**
 * Parse a `--dump-config` dump into an entry list.
 *
 * The dump interleaves `# == <bundle>` provenance comments and renders loader expressions as
 * `!!js …`. Composition never evaluates them, so the tag is neutralized and the plain schema reads
 * the row structure faithfully — the same approach `verify-profile-composition.mjs` uses for patch
 * files.
 */
const parseDump = (text) => yaml.parse(text.replace(/!!js\s+/g, ''))

const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
const exists = (candidate) => fs.stat(candidate).then(() => true).catch(() => false)

/** Run the real launcher against an explicit home, so the caller's `DSH_HOME` can never leak in. */
function runDsh(home, args) {
  const env = { ...process.env, DSH_HOME: home }
  delete env.DSH_PROFILE
  const result = spawnSync(DSH_BIN, args, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '').split('\n')
      .filter((line) => !/node_main\.cc:153|Node\.js environment variables are disabled/.test(line))
      .join('\n'),
    error: result.error,
  }
}

/** Snapshot the real profile's manifest + user patch, so we can prove they were never written. */
async function snapshotRealProfile() {
  const realHome = path.join(os.homedir(), '.dsh')
  const profileDir = path.join(realHome, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
  const files = ['package.json', 'cordis.patch.yml'].map((name) => path.join(profileDir, name))
  const snap = {}
  for (const file of files) {
    snap[file] = (await exists(file)) ? digest(await fs.readFile(file, 'utf8')) : null
  }
  return { profileDir, snap }
}

// --- the run ---------------------------------------------------------------
const before = await snapshotRealProfile()
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-professor-boot-'))
console.log(`disposable Harness home: ${home}`)
console.log(`real profile snapshot:   ${before.profileDir}\n`)

let verdict = 1
try {
  // 1. The loader initializes a real profile from a shipped template. This also proves the profile
  //    shape our bundle is layered onto is the shipped one, not something hand-rolled here.
  const init = runDsh(home, ['--from-default-profile', 'headless', '--profile', PROFILE_NAME, '--dump-config'])
  if (init.error) throw init.error
  check(init.status === 0, 'the loader initialized a profile from the shipped headless template',
    `exit ${init.status}`)
  const profileDir = path.join(home, 'profiles', PROFILE_NAME)
  check(await exists(path.join(profileDir, 'package.json')), 'the disposable profile has a manifest')

  const baselineParsed = parseDump(init.stdout)
  check(Array.isArray(baselineParsed), 'the baseline dump parses as an entry list',
    `${baselineParsed.length} roots`)
  const baselineNames = new Set(baselineParsed.map((row) => row?.name))
  check(!baselineNames.has(PACKAGE_NAME),
    'before the bundle is declared, nothing in the tree is the professor plugin')

  // 2. Declare the bundle exactly the way a user would: a dependency plus a bundles entry. The link
  //    keeps the run offline and deterministic; the loader's own `resolveBundleDir` then finds it
  //    through the profile directory anchor.
  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.dependencies = { ...manifest.dependencies, [PACKAGE_NAME]: `link:${REPO}` }
  const previouslyDeclared = manifest.dsh.profile.bundles.includes(PACKAGE_NAME)
  if (!previouslyDeclared) manifest.dsh.profile.bundles.push(PACKAGE_NAME)
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  check(!previouslyDeclared, 'the template did not already declare the professor bundle (so step 2 is meaningful)')

  const nodeModules = path.join(profileDir, 'node_modules')
  await fs.mkdir(nodeModules, { recursive: true })
  const link = path.join(nodeModules, PACKAGE_NAME)
  await fs.rm(link, { recursive: true, force: true })
  await fs.symlink(REPO, link, 'junction')
  check(await exists(path.join(link, 'package.json')), 'the bundle resolves from the profile directory',
    `link:${REPO}`)

  // 3. Boot the real loader. A bundle the loader cannot read, that declares no dsh.bundle, or whose
  //    peers the profile does not exempt is silently *skipped* — its patch layer would be missing,
  //    which is exactly what the header check below catches.
  const boot1 = runDsh(home, ['--profile', PROFILE_NAME, '--dump-config'])
  if (boot1.error) throw boot1.error
  check(boot1.status === 0, 'the real loader booted the profile with the bundle declared',
    `exit ${boot1.status}`)
  if (boot1.status !== 0) console.log(boot1.stderr.slice(0, 2000))
  check(!/is skipped|skippedBundles|cannot resolve profile bundle/.test(boot1.stderr),
    'the loader reported no skipped bundle', boot1.stderr.trim().split('\n')[0] ?? '')

  const headers = boot1.stdout.split('\n').filter((line) => line.startsWith('# == '))
  check(headers.some((line) => line.includes(`# == ${PACKAGE_NAME}`)),
    'the bundle contributed its own patch layer to the composition', `# == ${PACKAGE_NAME}`)
  // Other bundles are legitimately patched by their siblings; ours must stand alone, because the
  // preset is *inserted* by this bundle and nothing else may reach into that layer.
  const oursPatched = headers.filter((line) => line.includes(PACKAGE_NAME) && line.includes('patched by'))
  check(oursPatched.length === 0,
    'no other bundle patched the professor layer (the preset is inserted, never overridden)',
    oursPatched.join(' | '))

  const tree = parseDump(boot1.stdout)
  check(Array.isArray(tree), 'the boot dump parses as an entry list', `${tree.length} roots`)
  check(tree.length === baselineParsed.length + 2,
    'the bundle adds exactly a UI backend and an academic preset',
    `${baselineParsed.length} → ${tree.length}`)

  // 4. Isolation: exactly one preset row inserts `professor`, and the runtime plugin lives only there.
  const presets = tree.filter((row) => row?.name === '@deepseek-ai/dsh-agent-preset')
  const professor = presets.filter((row) => row?.config?.id === 'professor')
  check(professor.length === 1, 'exactly one row inserts the professor preset', `${professor.length} found`)
  const preset = professor[0]
  check(preset?.id === 'preset-professor', 'the loader assigned the preset-professor id', String(preset?.id))
  check(tree.filter((row) => row?.id === 'preset-professor').length === 1,
    'no other row claims the preset-professor id')
  check(preset?.config?.order === 20, 'the preset keeps its designed order', String(preset?.config?.order))

  const children = Array.isArray(preset?.config?.plugins) ? preset.config.plugins : []
  const childIds = children.map((row) => row?.id)
  check(JSON.stringify(childIds) === JSON.stringify(EXPECTED_PRESET_PLUGINS.map(([id]) => id)),
    'the preset mounts exactly the designed rows, in order', childIds.join(', '))
  check(JSON.stringify(children.map((row) => row?.name)) === JSON.stringify(EXPECTED_PRESET_PLUGINS.map(([, name]) => name)),
    'every mounted row keeps its designed plugin name')

  const mountedNames = new Set(children.map((row) => row?.name))
  const missing = FORBIDDEN_PRESET_PLUGINS.filter((name) => mountedNames.has(name))
  check(missing.length === 0, 'the tool surface excludes the rows the design leaves out', missing.join(', '))

  const runtimeRows = tree.filter((row) => row?.name === PACKAGE_NAME)
  check(runtimeRows.length === 1 && runtimeRows[0].id === 'professor-app' && runtimeRows[0].config?.app === true,
    'the only global Professor row is explicitly UI-only', `${runtimeRows.length} top-level rows`)

  // The flattened child list, so a nested row cannot smuggle a forbidden plugin in through a group.
  const flattened = children.flatMap(function walk(row) {
    if (row?.group === true && Array.isArray(row.config)) return [row, ...row.config.flatMap(walk)]
    return [row]
  })
  const flattenedNames = new Set(flattened.map((row) => row?.name))
  check(FORBIDDEN_PRESET_PLUGINS.every((name) => !flattenedNames.has(name)),
    'no nested group re-introduces an excluded plugin')
  check(flattenedNames.has(PACKAGE_NAME), 'the runtime plugin is mounted inside the preset')

  // 5. The restart: a second cold process must reproduce the composition exactly.
  const boot2 = runDsh(home, ['--profile', PROFILE_NAME, '--dump-config'])
  check(boot2.status === 0, 'the second boot (restart) succeeded', `exit ${boot2.status}`)
  check(boot1.stdout === boot2.stdout,
    'a restart reproduces the composed tree byte for byte',
    `boot1=${digest(boot1.stdout)} boot2=${digest(boot2.stdout)}`)

  // A restart must not accumulate: the profile manifest is unchanged by booting, and the bundle
  // contributes exactly one layer each time.
  const afterManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  check(JSON.stringify(afterManifest) === JSON.stringify(manifest),
    'booting never rewrites the profile manifest (no accumulation on restart)')
  check(boot2.stdout.split('\n').filter((line) => line === `# == ${PACKAGE_NAME}`).length === 1,
    'the bundle still contributes exactly one layer after the restart')

  // 6. The disposable home is the only thing that was written.
  const after = await snapshotRealProfile()
  const touched = Object.keys(before.snap).filter((file) => before.snap[file] !== after.snap[file])
  if (Object.values(before.snap).every((value) => value === null)) {
    skip('the real profile was never touched', 'no real profile on this machine to compare against')
  } else {
    check(touched.length === 0, 'the real Harness profile was not written by any of this',
      touched.length > 0 ? touched.join(', ') : before.profileDir)
  }

  console.log('\npreset-professor mounts:')
  for (const row of children) console.log(`  ${String(row?.id).padEnd(20)} ${row?.name}`)

  verdict = failures === 0 ? 0 : 1
} finally {
  await fs.rm(home, { recursive: true, force: true })
  console.log(`\ndisposable home removed: ${home}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} 项失败`)
process.exit(verdict)
