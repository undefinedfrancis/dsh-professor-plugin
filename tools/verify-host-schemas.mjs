/**
 * Real-host schema and registration verification for every Professor tool.
 *
 * Why this file exists
 * --------------------
 * The Professor preset failed to load in the real Harness with
 *
 *   professor-runtime (dsh-professor-spike):
 *   unsupported JSON schema: schema.properties.course_id.type must be a single type string
 *   (type arrays are not supported); …
 *
 * The whole suite was green at the time, because every other check ran against the plugin's own
 * fixtures: a fake tool registry never validates a schema, so a schema the host refuses to accept
 * looked fine. This verifier closes that gap by importing the **installed Harness's own** schema
 * validator and tool registry out of `app.asar/dsh/node_modules` and pushing the real tool
 * definitions through them.
 *
 * What it proves
 * --------------
 *  1. the legacy type-array declaration is REJECTED by the real validator, with the host's own
 *     message — so the regression cannot come back silently;
 *  2. every one of the real Professor tool definitions is ACCEPTED by that same validator
 *     (both the advertised `parameters` and the `output.schema`). The definitions are collected
 *     from the plugin's own live registration — never a hand-kept list — so this stage cannot
 *     silently skip a tool that was added later;
 *  3. all 21 register through the **real** `ToolRuntime.register()` and appear in the real
 *     registry's visible set — the exact call site that threw during preset activation;
 *  4. a deliberately broken definition still fails, so (3) cannot pass vacuously;
 *  5. the nullable fields keep their union semantics under the real `validateJsonSchemaValue`
 *     (they accept their documented types and still refuse everything else);
 *  6. the `tool-todo` configuration in this bundle's `cordis.patch.yml` satisfies the installed
 *     plugin's own exported `Config`.
 *
 * Nothing here is mocked except the `systemPrompt` service, which `ToolRuntime` needs only to
 * register its prompt-section renderers; the registration path under test does not touch it.
 *
 * Run it with the harness Node (asar-aware), the same way the other real-host checks run:
 *
 *   npm run verify:host
 *   # or
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     tools/verify-host-schemas.mjs
 *
 * `DSH_HARNESS` overrides the harness bundle root.
 */

import path from 'node:path'
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HARNESS_ROOT = process.env.DSH_HARNESS
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const NODE_MODULES = path.join(HARNESS_ROOT, 'dsh/node_modules')
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PATCH = path.join(REPO, 'cordis.patch.yml')

/** Load one module straight out of the installed harness. */
const loadHarness = (specifier) => import(pathToFileURL(path.join(NODE_MODULES, specifier)).href)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 64 - title.length))}`)

const { Context } = await loadHarness('@deepseek-ai/cordis/lib/index.js')
const tools = await loadHarness('@deepseek-ai/dsh-tools/lib/index.js')
const todo = await loadHarness('@deepseek-ai/dsh-tool-todo/lib/index.js')
const require = createRequire(import.meta.url)
const yaml = require(path.join(NODE_MODULES, 'yaml'))

const { apply } = await import(pathToFileURL(path.join(REPO, 'src/plugin.js')).href)
const { createFakeContext, makeHome, makeExec } = await import(pathToFileURL(path.join(REPO, 'test/helpers/fake-harness.mjs')).href)

/**
 * Turn the current, host-accepted schema back into the shape that was rejected.
 *
 * Every `oneOf` over plain single-type branches is the replacement this change introduced, so
 * rewriting exactly those nodes to `{ type: [...] }` reconstructs the pre-fix declaration without
 * hand-maintaining a second copy of it. The count is returned too, so the check can assert that
 * the reconstruction actually produced violations instead of a schema that was never broken.
 */
function toLegacyTypeArrays(node, found = []) {
  if (Array.isArray(node)) return node.map((entry) => toLegacyTypeArrays(entry, found))
  if (node === null || typeof node !== 'object') return node
  const keys = Object.keys(node)
  const branches = node.oneOf
  const isPlainUnion = Array.isArray(branches)
    && branches.length >= 2
    && keys.length === 1
    && branches.every((branch) => branch !== null
      && typeof branch === 'object'
      && Object.keys(branch).length === 1
      && typeof branch.type === 'string')
  if (isPlainUnion) {
    found.push(branches.map((branch) => branch.type))
    return { type: branches.map((branch) => branch.type) }
  }
  return Object.fromEntries(keys.map((key) => [key, toLegacyTypeArrays(node[key], found)]))
}

// ── 1. Collect the real tool definitions ────────────────────────────────────
section('collect')
const home = await makeHome('professor-host-schemas-')
const fake = createFakeContext({ home, services: {} })
apply(fake.ctx, fake.pluginConfig)

const registered = fake.tools
check(registered.length === 22, 'the plugin registers 22 tools', `${registered.length} registered`)
const names = registered.map((tool) => tool.name)
check(names.every((name) => name.startsWith('professor_')), 'every tool is namespaced professor_*')
check(new Set(names).size === names.length, 'tool names are unique')

// ── 2. The real validator rejects the legacy shape ──────────────────────────
section('legacy rejection (real validator)')
try {
  tools.assertSupportedJsonSchema({ type: 'object', properties: { course_id: { type: ['string', 'null'] } } })
  check(false, 'a type-array schema is rejected', 'the real validator ACCEPTED it')
} catch (error) {
  check(error.name === 'JsonSchemaError', 'a type-array schema throws JsonSchemaError', error.name)
  check(
    /schema\.properties\.course_id\.type must be a single type string \(type arrays are not supported\)/.test(error.message),
    'the rejection is the host\'s own message',
    error.message,
  )
}

let legacyNodes = 0
let rejectedTools = 0
for (const tool of registered) {
  const found = []
  const legacy = toLegacyTypeArrays(tool.output.schema, found)
  if (found.length === 0) continue
  legacyNodes += found.length
  try {
    tools.assertSupportedJsonSchema(legacy)
    check(false, `${tool.name}: legacy output schema is rejected`, 'the real validator ACCEPTED it')
  } catch (error) {
    rejectedTools += 1
    const typeArrayLines = error.violations.filter((line) => line.includes('type arrays are not supported'))
    check(
      typeArrayLines.length === found.length,
      `${tool.name}: all ${found.length} legacy union node(s) are reported`,
      `${typeArrayLines.length} reported`,
    )
  }
}
check(legacyNodes > 0, 'the reconstruction found the legacy union declarations', `${legacyNodes} nodes`)
check(rejectedTools > 0, 'every tool that had a legacy union is now rejected', `${rejectedTools} tools`)

// ── 3. The real validator accepts every current definition ──────────────────
section('acceptance (real validator)')
let parameterProblems = []
let outputProblems = []
for (const tool of registered) {
  try {
    tools.assertSupportedJsonSchema(tool.parameters)
  } catch (error) {
    parameterProblems.push(`${tool.name}: ${error.message}`)
  }
  try {
    tools.assertSupportedJsonSchema(tool.output.schema)
  } catch (error) {
    outputProblems.push(`${tool.name}: ${error.message}`)
  }
}
check(parameterProblems.length === 0, 'all 21 advertised parameter schemas are accepted', parameterProblems.join(' | '))
check(outputProblems.length === 0, 'all 21 output schemas are accepted', outputProblems.join(' | '))

// The PTC / generated-SDK projection must survive too; it degrades to `unknown` on an
// unsupported schema, which would silently hide a tool from the generated SDK.
const projected = registered.map((tool) => ({ name: tool.name, type: tools.jsonSchemaToTs(tool.output.schema) }))
const degraded = projected.filter((entry) => entry.type === 'unknown')
check(degraded.length === 0, 'no output schema degrades to `unknown` in the TS projection', degraded.map((entry) => entry.name).join(', '))

// ── 4. The real registry registers every tool ───────────────────────────────
section('registration (real ToolRuntime)')
const ctx = new Context()
// The only stub: `ToolRuntime` registers prompt-section renderers through this service, and the
// registration path under test never reads it back.
ctx.provide('systemPrompt', {
  tools: () => () => {},
  section: () => () => {},
  getSectionOrder: () => 0,
})
await ctx.plugin(tools.ToolRuntime, { mode: 'native' })

const registerProblems = []
for (const tool of registered) {
  try {
    ctx.tools.register(tool)
  } catch (error) {
    registerProblems.push(`${tool.name}: ${error.name}: ${error.message}`)
  }
}
check(registerProblems.length === 0, 'all 22 tools register on the real ToolRuntime', registerProblems.join(' | '))

const visible = ctx.tools.view(undefined)?.visible
const visibleNames = new Set(visible === undefined ? [] : [...visible.keys()])
const missing = names.filter((name) => !visibleNames.has(name))
check(visibleNames.size >= 22, 'the real registry exposes at least the 22 tools', `${visibleNames.size} visible`)
check(missing.length === 0, 'every Professor tool is visible in the real registry', missing.join(', '))

// Guards against a vacuous pass: registration must still reject a broken definition.
try {
  ctx.tools.register({
    name: 'professor_regression_probe',
    description: 'probe',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: { revision: { type: ['string', 'number', 'null'] } } },
      render: () => [],
    },
  })
  check(false, 'a type-array definition is still refused at register()', 'register() accepted it')
} catch (error) {
  check(error.name === 'JsonSchemaError', 'a type-array definition is still refused at register()', error.name)
}
await ctx.fiber.dispose()

// ── 5. Nullable fields keep their union semantics ───────────────────────────
section('value validation (real validator)')
/**
 * Build one value that satisfies a schema node, so a field can be exercised inside a result that
 * is otherwise complete (the host validates required properties first).
 */
function sampleFor(node) {
  if (Array.isArray(node?.oneOf)) return sampleFor(node.oneOf[0])
  switch (node?.type) {
    case 'string': return 'sample'
    case 'number': return 1
    case 'integer': return 1
    case 'boolean': return true
    case 'array': return []
    case 'object': return {}
    case 'null': return null
    default: return null
  }
}
const sampleResult = (schema) => Object.fromEntries(
  Object.entries(schema.properties ?? {}).map(([key, node]) => [key, sampleFor(node)]),
)

const byName = new Map(registered.map((tool) => [tool.name, tool]))
const valueCases = [
  ['professor_session_status', 'course_id', 'course-1', true],
  ['professor_session_status', 'course_id', null, true],
  ['professor_session_status', 'course_id', 7, false],
  ['professor_session_status', 'course', null, true],
  ['professor_session_status', 'course', { course_id: 'c' }, true],
  ['professor_session_status', 'course', 'nope', false],
  ['professor_state_update', 'revision', 'rev-9', true],
  ['professor_state_update', 'revision', 3, true],
  ['professor_state_update', 'revision', null, true],
  ['professor_state_update', 'revision', true, false],
  ['professor_artifact_create', 'artifact_version', 'v2', true],
  ['professor_artifact_create', 'artifact_version', 2, true],
  ['professor_artifact_create', 'artifact_version', null, true],
  ['professor_artifact_create', 'artifact_version', [], false],
  ['professor_artifact_create', 'format', null, true],
  ['professor_artifact_create', 'directory', null, true],
  ['professor_artifact_create', 'root', null, true],
  ['professor_latex_compile', 'exit_code', 0, true],
  ['professor_latex_compile', 'exit_code', null, true],
  ['professor_latex_compile', 'exit_code', '0', false],
  ['professor_latex_compile', 'blocked_by', 'missing-project', true],
  ['professor_latex_compile', 'blocked_by', null, true],
  // Phase 3 onboarding: the refusal code and the confirmation's decision objects are nullable, and
  // a nullable field is exactly where the legacy type-array declaration used to break the host.
  ['professor_workspace_discover', 'code', null, true],
  ['professor_workspace_discover', 'code', 'PROFESSOR_ONBOARDING_STALE', true],
  ['professor_workspace_discover', 'code', 7, false],
  ['professor_workspace_discover', 'proposal', null, true],
  ['professor_workspace_confirm', 'requires_decision', null, true],
  ['professor_workspace_confirm', 'requires_decision', { kind: 'folder_change' }, true],
  ['professor_workspace_confirm', 'requires_decision', 'connect it', false],
  ['professor_workspace_rebuild', 'code', null, true],
  ['professor_workspace_rebuild', 'code', 'PROFESSOR_ONBOARDING_FAILED', true],
  ['professor_workspace_rebuild', 'code', true, false],
]
for (const [toolName, field, value, expected] of valueCases) {
  const tool = byName.get(toolName)
  const use = { ...sampleResult(tool.output.schema), [field]: value }
  const violations = tools.validateJsonSchemaValue(tool.output.schema, use, toolName)
  const accepted = violations.length === 0
  check(
    accepted === expected,
    `${toolName}.${field} = ${JSON.stringify(value)} is ${expected ? 'accepted' : 'refused'}`,
    accepted ? '' : violations[0] ?? '',
  )
}

// ── 6. The todo configuration matches the installed plugin's own schema ─────
section('todo configuration (installed plugin schema)')
const raw = await readFile(PATCH, 'utf8')
const patchRows = yaml.parse(raw.replace(/!!js\s+/g, ''))
const presetPlugins = patchRows?.[0]?.insert?.find(row => row.id === 'preset-professor')?.config?.plugins ?? []
const todoRow = presetPlugins.find((row) => row?.name === '@deepseek-ai/dsh-tool-todo')
check(todoRow !== undefined, 'cordis.patch.yml still mounts @deepseek-ai/dsh-tool-todo')

const resolvedConfig = (() => {
  try {
    return { ok: true, value: todo.Config({ ...(todoRow?.config ?? {}) }) }
  } catch (error) {
    return { ok: false, error: error.message }
  }
})()
check(
  resolvedConfig.ok === true && resolvedConfig.value.allowParallelInProgress === false,
  'the mounted todo config satisfies the installed Config schema',
  resolvedConfig.ok ? JSON.stringify(resolvedConfig.value) : resolvedConfig.error,
)
try {
  todo.Config({})
  check(false, 'an empty todo config is refused by the installed plugin', 'Config({}) accepted it')
} catch (error) {
  check(
    /\$\.allowParallelInProgress missing required value/.test(error.message),
    'an empty todo config reproduces the reported failure',
    error.message,
  )
}

section('real import outputs (host value validator)')
const registry = path.join(home, 'registry')
await mkdir(path.join(registry, 'Courses'), { recursive: true })
await writeFile(path.join(registry, 'COURSES.md'), '| Course Code | Course Name | Semester | Status | Registry |\n|---|---|---|---|---|\n| CSC3200 | Data Structures | Fall | active | Courses/CSC3200.md |\n')
await writeFile(path.join(registry, 'Courses/CSC3200.md'), `## Course Code\nCSC3200\n## Course Name\nData Structures\n## Semester\nFall\n## Course Root\n${home}/course\n`)
await mkdir(path.join(home, 'course'), { recursive: true })
const exec = makeExec({ cwd: home })
await byName.get('professor_project_init').execute({ project_id: 'host-output-check' }, exec)
const importer = byName.get('professor_course_manage')
for (const dry_run of [true, false, false]) {
  const value = await importer.execute({ action: 'import', registry_dir: registry, dry_run }, exec)
  const lossless = JSON.stringify(value) === JSON.stringify(JSON.parse(JSON.stringify(value)))
    && !Object.values(value).includes(undefined)
  const violations = tools.validateJsonSchemaValue(importer.output.schema, value, importer.name)
  check(lossless && violations.length === 0, `import ${dry_run ? 'preview' : 'apply/repeat'} returns host-compatible JSON`, violations.join('; '))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
