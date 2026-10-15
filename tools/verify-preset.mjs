/**
 * Offline validator for this bundle's `cordis.patch.yml` (the Professor preset declaration).
 *
 * Run it with the harness's own Node so the YAML dialect and the installed package inventory are
 * the real ones:
 *
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     tools/verify-preset.mjs
 *
 * Checks, in order of importance:
 *  - the patch inserts exactly one preset and nothing else (no deployment-level plugin row, which
 *    would leak Professor behaviour to ordinary sessions);
 *  - the preset carries the schema the loader requires (`id`, `plugins`), plus `name`,
 *    `description`, `order`;
 *  - every plugin row has a non-empty string `name`; group rows carry a nested row list;
 *  - every `@deepseek-ai/*` name actually exists in the installed Harness, and every local name
 *    resolves to this package — a typo would otherwise surface only as a `broken` preset at boot;
 *  - the runtime plugin is mounted INSIDE the preset, not globally;
 *  - no machine-specific absolute path is embedded anywhere in the patch.
 */

import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PATCH = path.join(HERE, 'cordis.patch.yml')
const PACKAGE_JSON = path.join(HERE, 'package.json')
const HARNESS_NODE_MODULES = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules'

const require = createRequire(import.meta.url)
function loadYaml() {
  for (const candidate of ['yaml', path.join(HARNESS_NODE_MODULES, 'yaml')]) {
    try {
      return require(candidate)
    } catch {
      // try the next anchor
    }
  }
  throw new Error('the `yaml` parser is unavailable; run this script with the harness Node')
}

const yaml = loadYaml()
let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

const raw = await fs.readFile(PATCH, 'utf8')
const manifest = JSON.parse(await fs.readFile(PACKAGE_JSON, 'utf8'))

// The loader parses bundle patches with `yaml.JSON_SCHEMA.extend(JsExpr)`; `!!js` scalars are a
// first-class node there. Plain parsing would reject the tag, so neutralize it for structure checks.
const parsed = yaml.parse(raw.replace(/!!js\s+/g, ''))

check(Array.isArray(parsed), 'patch top level is a list')
check(parsed.length === 1, 'patch declares exactly one top-level entry', `${parsed.length} entries`)
check(Object.hasOwn(parsed[0] ?? {}, 'insert'), 'the single entry is an insert')
check(parsed[0]?.id === undefined, 'no deployment-level row is declared (isolation)')

const inserted = parsed[0]?.insert ?? []
check(inserted.length === 2, 'exactly one UI backend and one preset are inserted', `${inserted.length} rows`)
const appRow = inserted.find(row => row.id === 'professor-app')
check(appRow?.name === 'dsh-professor-spike' && appRow?.config?.app === true, 'global row is explicitly UI-only')
const presetRow = inserted.find(row => row.id === 'preset-professor') ?? {}

check(presetRow.name === '@deepseek-ai/dsh-agent-preset', 'inserted row declares an agent preset', String(presetRow.name))
check(typeof presetRow.id === 'string' && presetRow.id.startsWith('preset-'), 'preset loader row id follows the preset-<id> convention', String(presetRow.id))

const config = presetRow.config ?? {}
check(typeof config.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.id), 'preset id is kebab-case', String(config.id))
check(config.id === presetRow.id.replace(/^preset-/, ''), 'preset id matches its loader row id')
check(typeof config.name === 'string' && config.name.length > 0, 'preset has a display name', String(config.name))
check(typeof config.description === 'string' && config.description.length > 0, 'preset has a description')
check(typeof config.order === 'number', 'preset has a numeric order', String(config.order))
check(Array.isArray(config.plugins) && config.plugins.length > 0, 'preset lists plugins', `${config.plugins?.length ?? 0} rows`)

// --- row validation -------------------------------------------------------
function collectRows(rows, prefix = '') {
  const collected = []
  for (const row of rows) {
    const label = `${prefix}${row?.id ?? '(no id)'}`
    collected.push({ row, label })
    if (row?.group === true && Array.isArray(row.config)) collected.push(...collectRows(row.config, `${label}/`))
  }
  return collected
}

const rows = collectRows(config.plugins ?? [])
let rowProblems = 0
for (const { row, label } of rows) {
  if (typeof row?.name !== 'string' || row.name.length === 0) {
    rowProblems += 1
    console.log(`FAIL  row ${label} has no usable name`)
  }
  if (row?.group === true && !Array.isArray(row.config)) {
    rowProblems += 1
    console.log(`FAIL  group ${label} has no nested row list`)
  }
}
check(rowProblems === 0, `${rows.length} preset rows have usable names and group shapes`)

const appears = (name) => rows.some(({ row }) => row.name === name)
check(appears('dsh-professor-spike'), 'the runtime plugin is mounted inside the preset')
check(!raw.includes(`- id: professor-spike\n      name: dsh-professor-spike`), 'the old global plugin row is gone')
check(appears('@deepseek-ai/dsh-tool-skill'), 'the model-facing skill loader is mounted')
check(appears('@deepseek-ai/dsh-tool-fs'), 'filesystem tools are mounted')
check(appears('@deepseek-ai/dsh-tool-bash') || appears('@deepseek-ai/dsh-tool-pwsh'), 'a shell tool is mounted (LaTeX compile gate)')
check(!appears('@deepseek-ai/dsh-skill-filesystem'), 'no extra skill provider competes with the bundled one')

// `@deepseek-ai/dsh-tool-todo` requires `allowParallelInProgress`; a bare row makes the whole
// preset fail to load ("invalid config: $.allowParallelInProgress missing required value"), which
// the desktop UI reports as "Failed to load". The real schema check lives in
// `tools/verify-host-schemas.mjs`; this is the offline guard that needs no harness.
const todoRow = rows.find(({ row }) => row.name === '@deepseek-ai/dsh-tool-todo')?.row
check(todoRow !== undefined, '@deepseek-ai/dsh-tool-todo is mounted')
check(
  typeof todoRow?.config?.allowParallelInProgress === 'boolean',
  'the todo row supplies the boolean its plugin schema requires',
  JSON.stringify(todoRow?.config ?? null),
)

// --- resolvability --------------------------------------------------------
const harnessRoot = path.join(HARNESS_NODE_MODULES, '@deepseek-ai')
let missing = []
for (const { row } of rows) {
  const name = row.name
  if (name === 'cordis:group') continue
  const packageName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name
  if (packageName === manifest.name) continue
  if (packageName.startsWith('@deepseek-ai/')) {
    const exists = await fs.stat(path.join(HARNESS_NODE_MODULES, packageName)).then(() => true).catch(() => false)
    if (!exists) missing.push(packageName)
    continue
  }
  const local = await fs.stat(path.join(HERE, '..', 'node_modules', packageName)).then(() => true).catch(() => false)
  if (!local) missing.push(`${packageName} (local)`)
}
check(missing.length === 0, 'every referenced plugin exists in this installation', missing.join(', '))

// --- machine independence -------------------------------------------------
const absolutePaths = raw.match(/(?:^|[\s'"`])\/(?:Users|home|private|Applications)\/[^\s'"`]*/g) ?? []
check(absolutePaths.length === 0, 'no machine-specific absolute path in the patch', absolutePaths.slice(0, 3).join(' '))

// --- persona ---------------------------------------------------------------
const persona = rows.find(({ row }) => row.name === '@deepseek-ai/dsh-persona')
const prefix = persona?.row?.config?.prefix ?? ''
check(typeof prefix === 'string' && prefix.length > 200, 'persona policy is present and substantive', `${prefix.length} chars`)
for (const [needle, label] of [
  ['教授材料', 'source priority'],
  ['绝不编造', 'no fabrication rule'],
  ['只读', 'original material is read-only'],
  ['轻量提问', 'lightweight questions do not mutate state'],
  ['请选择笔记格式', 'note format gate'],
  ['原题', 'practice question labelling'],
  ['未实现', 'capability honesty'],
]) {
  check(prefix.includes(needle), `persona covers: ${label}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
