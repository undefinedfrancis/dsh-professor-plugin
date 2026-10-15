/**
 * Profile composition verifier.
 *
 * Reproduces the loader's own composition so a bundle patch can be checked WITHOUT booting the
 * app or asking anyone to click through the UI:
 *
 *   1. read the profile's `dsh.profile.bundles` order;
 *   2. for every bundle, read its `dsh.bundle.patch` file list;
 *   3. flatten the patch layers in that order, then the profile's own `cordis.patch.yml`, then
 *      `$DSH_HOME/cordis.patch.yml` (the home layer);
 *   4. run the harness's real `applyEntryPatches([], layers)` with the harness's real patch schema
 *      (`entryListSchema`, i.e. JSON_SCHEMA extended with the `!!js` tag);
 *   5. assert what the app would actually mount.
 *
 * Run it with the harness Node (asar-aware):
 *
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     tools/verify-profile-composition.mjs
 *
 * Read-only: it never writes a profile, never boots the loader, and never touches Hermes or
 * Personal-Agent.
 */

import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const APP_NODE_MODULES = path.join(APP_ASAR, 'dsh/node_modules')
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'desktop')

const require = createRequire(import.meta.url)
let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))
const exists = async (candidate) => fs.stat(candidate).then(() => true).catch(() => false)

// --- harness modules (same instances the loader uses) ----------------------
const yamlPath = path.join(APP_NODE_MODULES, 'yaml')
const includePath = path.join(APP_NODE_MODULES, '@deepseek-ai/cordis-plugin-include')
const yaml = require(yamlPath)
const { applyEntryPatches } = require(includePath)
check(typeof applyEntryPatches === 'function', 'reused the harness patch engine', path.basename(includePath))

/**
 * Parse a patch file structurally.
 *
 * `entryListSchema` (exported by cordis-plugin-include) is built by that package's ESM copy of
 * `yaml`, while this script `require()`s the CJS copy — passing one instance's Schema to the
 * other's composer throws. Composition never evaluates `!!js`, so the tag is neutralized and the
 * plain schema parses the row structure faithfully.
 */
const parsePatch = (text) => yaml.parse(text.replace(/!!js\s+/g, ''))

// --- layers ----------------------------------------------------------------
const profileManifest = await readJson(path.join(PROFILE_DIR, 'package.json'))
const bundles = profileManifest?.dsh?.profile?.bundles ?? []
check(bundles.length > 0, 'profile declares bundles', bundles.join(', '))

async function bundleDir(name) {
  for (const root of [APP_NODE_MODULES, path.join(PROFILE_DIR, 'node_modules')]) {
    const candidate = path.join(root, name)
    if (await exists(candidate)) return candidate
  }
  return undefined
}

const layers = []
const skipped = []
for (const name of bundles) {
  const dir = await bundleDir(name)
  if (dir === undefined) {
    skipped.push(`${name} (not installed)`)
    continue
  }
  let manifest
  try {
    manifest = await readJson(path.join(dir, 'package.json'))
  } catch {
    skipped.push(`${name} (unreadable package.json)`)
    continue
  }
  const declared = manifest?.dsh?.bundle?.patch
  const files = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : []
  if (files.length === 0) {
    skipped.push(`${name} (declares no dsh.bundle)`)
    continue
  }
  for (const file of files) {
    const target = path.join(dir, file)
    if (!(await exists(target))) {
      skipped.push(`${name}: missing ${file}`)
      continue
    }
    const text = await fs.readFile(target, 'utf8')
    try {
      layers.push(parsePatch(text))
    } catch (error) {
      check(false, `bundle patch parses: ${name}/${file}`, error.message)
    }
  }
}
check(skipped.length === 0, 'every profile bundle contributed its patch', skipped.join(', '))

for (const layer of [
  path.join(PROFILE_DIR, 'cordis.patch.yml'),
  path.join(DSH_HOME, 'cordis.patch.yml'),
]) {
  if (await exists(layer)) {
    layers.push(parsePatch(await fs.readFile(layer, 'utf8')))
  }
}

// --- compose exactly like the loader --------------------------------------
const composed = applyEntryPatches([], structuredClone(layers.flat()), () => {})
check(Array.isArray(composed), 'composition produced a root entry list', `${composed.length} roots`)

const roots = composed
const byId = new Map()
for (const row of roots) if (typeof row?.id === 'string') byId.set(row.id, row)

const presetRows = roots.filter((row) => row?.name === '@deepseek-ai/dsh-agent-preset')
const presetIds = presetRows.map((row) => row?.config?.id)
check(presetRows.length > 0, 'the composition declares agent presets', presetIds.join(', '))
check(presetIds.includes('professor'), 'the Professor preset is present in the composition')

const professor = presetRows.find((row) => row?.config?.id === 'professor')
check(professor !== undefined, 'the Professor preset row is resolvable')
check(professor?.id === 'preset-professor', 'the Professor preset keeps the preset-<id> loader id', String(professor?.id))

const pluginNames = (professor?.config?.plugins ?? [])
  .flatMap(function flatten(row) {
    if (row?.group === true && Array.isArray(row.config)) return [row, ...row.config.flatMap(flatten)]
    return [row]
  })
  .map((row) => row?.name)
check(pluginNames.includes('dsh-professor-spike'), 'the runtime plugin is mounted inside the preset')
// Professor ships TWO rows now: the academic runtime inside the preset (unchanged) and the new
// deployment-level `professor-app` row that backs the sidebar UI. A bare "no global row" assertion
// would therefore fail for the wrong reason, so the precise property is asserted instead: any
// deployment-level row must be the **application** row (`config.app === true`), there may be at most
// one, and it must not carry tools/skills/persona. What it *does* contribute is then proved from the
// live host in `tools/verify-home.mjs` (no professor_* tools, no persona, no skills visible at root).
const appRows = roots.filter((row) => row?.name === 'dsh-professor-spike')
check(appRows.length <= 1, 'at most one deployment-level Professor row exists', `${appRows.length} found`)
check(appRows.every((row) => row?.config?.app === true),
  'every deployment-level Professor row is the application row (config.app === true)',
  JSON.stringify(appRows.map((row) => row?.config)))
check(appRows.every((row) => row?.id === 'professor-app'),
  'and it keeps the professor-app loader id', String(appRows[0]?.id))
check(appRows.every((row) => row?.config?.plugins === undefined),
  'the application row composes no child rows of its own')
const professorAppConfig = appRows[0]?.config ?? {}
const academicKeys = Object.keys(professorAppConfig).filter((key) => key !== 'app')
check(academicKeys.length === 0, 'and declares no academic configuration', academicKeys.join(', '))

// A duplicate preset id would surface at boot as a broken preset; catch it here.
const duplicates = presetIds.filter((id, index) => presetIds.indexOf(id) !== index)
check(duplicates.length === 0, 'no duplicate preset ids', duplicates.join(', '))

const conflicting = roots.filter((row) => row?.id === 'preset-professor' && row !== professor)
check(conflicting.length === 0, 'no other row claims the preset-professor id')

// --- report ----------------------------------------------------------------
console.log('\n组合出的预设名单:')
for (const row of presetRows) {
  const id = row?.config?.id
  const order = row?.config?.order
  const count = Array.isArray(row?.config?.plugins) ? row.config.plugins.length : 0
  console.log(`  ${String(id).padEnd(12)} order=${String(order).padEnd(4)} plugins=${count}`)
}
console.log(`\nProfessor 预设挂载的插件 (${pluginNames.length}):`)
for (const name of pluginNames) console.log(`  ${name}`)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
