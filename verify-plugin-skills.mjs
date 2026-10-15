/**
 * 离线校验 Professor 插件自带的技能 provider。
 *
 *   node verify-plugin-skills.mjs [--plugin /path/to/plugin]
 *
 * 校验规则逐条对应 @deepseek-ai/dsh-skill 的 validateCandidate / validateInvocation /
 * validateDefinition（见 DSH 源码）。之所以要离线校验：注册表把「候选不合法」视为
 * provider 失败并**跳过整个 provider**，一个坏 frontmatter 会让 12 个技能全部消失。
 */

import { pathToFileURL } from 'node:url'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const EXPECTED = [
  'professor-course-management', 'professor-latex', 'professor-notes',
  'professor-research', 'professor-review', 'professor-study',
]

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

function validateInvocation(invocation, subject) {
  if (invocation === undefined) return
  if (typeof invocation !== 'object' || invocation === null || Array.isArray(invocation)) {
    throw new Error(`${subject}: invocation 必须是对象`)
  }
  if (typeof invocation.modelInvocable !== 'boolean') throw new Error(`${subject}: invocation.modelInvocable 必须为布尔`)
  if (typeof invocation.userInvocable !== 'boolean') throw new Error(`${subject}: invocation.userInvocable 必须为布尔`)
}

function validateCandidate(candidate, providerName) {
  if (typeof candidate.name !== 'string') throw new Error('name 不是字符串')
  if (!SKILL_NAME.test(candidate.name)) throw new Error(`非法技能名 "${candidate.name}"`)
  if (typeof candidate.description !== 'string') throw new Error(`"${candidate.name}" description 不是字符串`)
  if (candidate.description.length === 0) throw new Error(`"${candidate.name}" description 为空`)
  validateInvocation(candidate.invocation, candidate.name)
  if (candidate.whenToUse !== undefined && typeof candidate.whenToUse !== 'string') throw new Error(`"${candidate.name}" whenToUse 不是字符串`)
  if (typeof candidate.source !== 'string') throw new Error(`"${candidate.name}" source 不是字符串`)
  if (typeof candidate.rank !== 'number' || !Number.isFinite(candidate.rank)) throw new Error(`"${candidate.name}" rank 非法`)
  if (typeof candidate.provider !== 'string') throw new Error(`"${candidate.name}" provider 不是字符串`)
  if (candidate.provider !== providerName) throw new Error(`"${candidate.name}" provider 不匹配 (${candidate.provider})`)
  if (candidate.path !== undefined && typeof candidate.path !== 'string') throw new Error(`"${candidate.name}" path 不是字符串`)
}

function validateDefinition(skill) {
  if (typeof skill.name !== 'string' || !SKILL_NAME.test(skill.name)) throw new Error('definition.name 非法')
  if (typeof skill.description !== 'string' || skill.description.length === 0) throw new Error(`${skill.name}: description 非法`)
  validateInvocation(skill.invocation, skill.name)
  if (typeof skill.source !== 'string') throw new Error(`${skill.name}: source 非法`)
  if (typeof skill.provider !== 'string') throw new Error(`${skill.name}: provider 非法`)
  if (typeof skill.content !== 'string') throw new Error(`${skill.name}: content 不是字符串`)
  if (skill.path !== undefined && typeof skill.path !== 'string') throw new Error(`${skill.name}: path 非法`)
}

const args = process.argv.slice(2)
const flag = args.indexOf('--plugin')

/** 默认插件目录：脚本与 index.js 同级（复制进插件后）时取自身，否则取上级（tools/ 布局）。 */
async function resolveDefaultPlugin() {
  for (const candidate of [import.meta.dirname, path.resolve(import.meta.dirname, '..')]) {
    try {
      await fs.stat(path.join(candidate, 'index.js'))
      await fs.stat(path.join(candidate, 'package.json'))
      return candidate
    } catch {
      // 试下一个候选
    }
  }
  return process.cwd()
}

const plugin = flag >= 0 ? path.resolve(args[flag + 1]) : await resolveDefaultPlugin()

console.log(`插件目录: ${plugin}\n`)

// —— 挂载插件，捕获 provider 工厂 ——
const captured = { tools: [], providers: [], warnings: [] }
const ctx = {
  logger: { warn: (message) => captured.warnings.push(message) },
  tools: { register: (tool) => captured.tools.push(tool) },
  skills: { registerProvider: (create) => captured.providers.push(create) },
}
const pluginUrl = pathToFileURL(path.join(plugin, 'index.js')).href
const module = await import(pluginUrl)

// Distinguishing expected capability degradation from a provider defect is the whole point of the
// marker: the plugin tags "hot-reload unavailable on this host" with it, and this verifier only
// treats un-tagged warnings as provider failures.
const WATCHER_DEGRADED_PREFIX = module.WATCHER_DEGRADED_PREFIX ?? 'skills-watcher:'

// Deterministic watcher. The skill contract is "one debounced watcher per instance, with honest
// degradation" — not "the host must have a spare file descriptor". A real `fs.watch` degrades
// under EMFILE, and counting that as a provider failure would make this verifier depend on host
// resources. The stub exercises the same lifecycle without opening a descriptor.
const watchStats = { opened: 0, closed: 0 }
const watchFn = () => {
  watchStats.opened += 1
  return { on: () => {}, close: () => { watchStats.closed += 1 } }
}
module.apply(ctx, { watchFn })

const EXPECTED_TOOLS = [
  'professor_artifact_create', 'professor_artifact_status',
  'professor_course_list', 'professor_course_manage', 'professor_diagnostics',
  'professor_extract', 'professor_index_sync', 'professor_latex_compile',
  'professor_material_read',
  'professor_memory_read', 'professor_memory_status', 'professor_memory_update',
  'professor_paths', 'professor_project_init', 'professor_search',
  'professor_session_bind', 'professor_session_status',
  'professor_state_read', 'professor_state_update',
  'professor_workspace_confirm', 'professor_workspace_discover', 'professor_workspace_rebuild',
]
check(captured.tools.length === EXPECTED_TOOLS.length, `注册了 ${EXPECTED_TOOLS.length} 个工具`, `实际 ${captured.tools.length}`)
check(
  JSON.stringify(captured.tools.map((tool) => tool.name).sort()) === JSON.stringify(EXPECTED_TOOLS),
  '工具集与预期一致（收敛后的非重复工具面）',
  captured.tools.map((tool) => tool.name).join(', '),
)
check(captured.providers.length === 1, '注册了 1 个技能 provider', `实际 ${captured.providers.length}`)
if (captured.providers.length !== 1) process.exit(1)

// 扫描类工具不得接受自由形式的 root：写入目标只能来自会话/注册表
const indexTool = captured.tools.find((tool) => tool.name === 'professor_index_sync')
check(
  indexTool !== undefined && Object.hasOwn(indexTool.parameters?.properties ?? {}, 'root') === false,
  '索引工具没有自由形式的 root 参数',
)

const abort = new AbortController()
const control = { signal: abort.signal, invalidate: () => {} }
const provider = captured.providers[0](control)
check(provider.name === 'professor-bundled', `provider 名称为 professor-bundled`, provider.name)
check(typeof provider.list === 'function', 'provider.list 存在')
check(typeof provider.get === 'function', 'provider.get 存在')

// —— list() 必须返回数组或 { candidates, complete } ——
const output = await provider.list({})
const candidates = Array.isArray(output) ? output : output?.candidates
check(Array.isArray(candidates), 'list() 返回数组或 {candidates, complete}')
if (!Array.isArray(candidates)) process.exit(1)
if (!Array.isArray(output)) {
  check(typeof output.complete === 'boolean', 'complete 为布尔', String(output.complete))
}

// —— 逐条按注册表的规则校验 ——
let invalid = 0
for (const candidate of candidates) {
  try {
    validateCandidate(candidate, provider.name)
  } catch (error) {
    invalid += 1
    console.log(`FAIL  候选不合法: ${error.message}`)
  }
}
check(invalid === 0, `${candidates.length} 个候选全部通过 validateCandidate`)

const names = candidates.map((candidate) => candidate.name).sort()
check(JSON.stringify(names) === JSON.stringify(EXPECTED), '技能名与预期 6 个完全一致',
  names.length === EXPECTED.length ? '' : `实际 ${names.length} 个`)
const missing = EXPECTED.filter((name) => !names.includes(name))
const extra = names.filter((name) => !EXPECTED.includes(name))
if (missing.length > 0) console.log(`      缺少: ${missing.join(', ')}`)
if (extra.length > 0) console.log(`      多出: ${extra.join(', ')}`)

check(new Set(names).size === names.length, '技能名无重复')

// Split warnings by class. A malformed candidate (bad frontmatter, non-kebab name, missing
// SKILL.md) is a provider defect and must fail. A watcher that could not start is expected
// capability degradation and must not.
const watcherWarnings = captured.warnings.filter((message) => message.includes(WATCHER_DEGRADED_PREFIX))
const providerWarnings = captured.warnings.filter((message) => !message.includes(WATCHER_DEGRADED_PREFIX))
check(providerWarnings.length === 0, '无 provider 警告（宿主资源类降级单独归类）', providerWarnings.join(' | ') || '无')

// Prove the classifier is genuinely sensitive rather than blanket-silencing: a watcher that cannot
// start must be reported *with* the marker, and the marker must keep it out of the provider bucket.
{
  const watcherUrl = pathToFileURL(path.join(plugin, 'src/skills/watcher.js')).href
  const { createSkillsWatcher } = await import(watcherUrl)
  const seen = []
  const degraded = createSkillsWatcher({
    dir: path.join(plugin, 'skills'),
    logger: { warn: (message) => seen.push(message) },
    watchFn: () => { const error = new Error('too many open files, watch'); error.code = 'EMFILE'; throw error },
    onChange: () => { throw new Error('a degraded watcher must never invalidate') },
  })
  check(degraded.healthy === false && /EMFILE/.test(degraded.reason), 'EMFILE 被如实报告为 watcher 降级', degraded.reason)
  const tagged = seen.filter((message) => message.includes(WATCHER_DEGRADED_PREFIX))
  check(tagged.length === 1, '降级日志恰好报告一次并带稳定标记', `${tagged.length} 条`)
  check(seen.filter((message) => !message.includes(WATCHER_DEGRADED_PREFIX)).length === 0,
    '降级不会被误判成 provider 警告')
  degraded.close()
}

// —— get() 必须返回合法 definition，且与候选同名 ——
let definitionProblems = 0
for (const candidate of candidates) {
  const definition = await provider.get(candidate, {})
  try {
    validateDefinition(definition)
    if (definition.name !== candidate.name) throw new Error('name 与候选不一致')
    if (!definition.content.includes('\n') || definition.content.length < 200) throw new Error('content 过短')
    if (definition.content.startsWith('---')) throw new Error('content 未剥离 frontmatter')
    if (definition.resourceBase?.kind !== 'directory') throw new Error('resourceBase 不是目录')
    const info = await fs.stat(definition.resourceBase.path)
    if (!info.isDirectory()) throw new Error('resourceBase 路径不是目录')
    if (!(await fs.stat(path.join(definition.resourceBase.path, 'SKILL.md'))).isFile()) throw new Error('缺 SKILL.md')
  } catch (error) {
    definitionProblems += 1
    console.log(`FAIL  get("${candidate.name}") 不合法: ${error.message}`)
  }
}
check(definitionProblems === 0, `${candidates.length} 个 get() 全部返回合法 skill 定义`)

// —— 根变量解析与注入：插件必须自己把 ${VAR} 变成真实路径 ——
// 用一个临时目录充当“当前对话的工作区”，这样断言不依赖本机任何固定路径。
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-verify-'))
const exec = { agent: { session: { header: { cwd: fixture } } } }
const pathsTool = captured.tools.find((tool) => tool.name === 'professor_paths')
check(pathsTool !== undefined, 'professor_paths 工具存在')
const paths = pathsTool === undefined ? { roots: {}, workspaceRoot: '' } : await pathsTool.execute({}, exec)

check(typeof paths.workspaceRoot === 'string' && paths.workspaceRoot.length > 0, '解析到 workspaceRoot', paths.workspaceRoot || '(空)')
check(paths.roots?.COURSE_ROOT?.value === fixture, 'COURSE_ROOT 落到会话工作区',
  `${paths.roots?.COURSE_ROOT?.value} (${paths.roots?.COURSE_ROOT?.source})`)

const resolved = Object.entries(paths.roots ?? {}).filter(([, info]) => typeof info.value === 'string' && info.value.length > 0)
check(resolved.length >= 1, '至少解析出一个根变量',
  resolved.map(([key, info]) => `${key}=${info.value}(${info.source})`).join('  ') || '(无)')

let leftoverPlaceholders = 0
let injected = 0
for (const candidate of candidates) {
  const definition = await provider.get(candidate, { cwd: fixture })
  for (const [key, info] of resolved) {
    if (definition.content.includes('${' + key + '}')) {
      leftoverPlaceholders += 1
      console.log(`FAIL  ${definition.name}: ${key} 已解析却仍是占位符`)
    }
    if (definition.content.includes(info.value)) injected += 1
  }
}
check(leftoverPlaceholders === 0, '已解析的变量没有残留占位符')
check(injected > 0, '根变量已注入真实路径', `${injected} 处`)

// 断言从「技能里实际用到的变量」推导，而不是假定某个变量一定被用到：
// 目前随包技能只引用 PERSONAL_AGENT_ROOT 与 PROJECTS_ROOT，
// ${COURSE_ROOT} 只出现在不随包发布的依赖载荷（Registry / Knowledge）里。
const rawTexts = await Promise.all(candidates.map((candidate) => fs.readFile(candidate.locator.path, 'utf8')))
const contents = await Promise.all(candidates.map(async (candidate) => (await provider.get(candidate, { cwd: fixture })).content))
const usedKeys = ['PERSONAL_AGENT_ROOT', 'COURSE_ROOT', 'PROJECTS_ROOT'].filter((key) => rawTexts.some((text) => text.includes('${' + key + '}')))
check(usedKeys.length > 0, '技能里确有根变量引用', usedKeys.join(', '))

const resolvableUsed = usedKeys.filter((key) => typeof paths.roots?.[key]?.value === 'string' && paths.roots[key].value.length > 0)
const injectedUsed = resolvableUsed.filter((key) => contents.some((content) => content.includes(paths.roots[key].value)))
check(injectedUsed.length === resolvableUsed.length, '技能实际用到且已解析的变量都已注入',
  `${injectedUsed.join(', ')} / ${resolvableUsed.join(', ')}`)

// —— 未解析的变量必须原样保留，而不是被清空或猜成别的路径 ——
const unresolvedKeys = Object.entries(paths.roots ?? {}).filter(([, info]) => info.value === null).map(([key]) => key)
let unresolvedKept = true
if (unresolvedKeys.length > 0) {
  for (const candidate of candidates) {
    const definition = await provider.get(candidate, { cwd: fixture })
    for (const key of unresolvedKeys) {
      if (!definition.content.includes('${' + key + '}') && definition.content.includes('${' + key)) unresolvedKept = false
    }
  }
}
check(unresolvedKept, `未解析变量保持占位符${unresolvedKeys.length > 0 ? ` (${unresolvedKeys.join(', ')})` : '（本机全部已解析）'}`)
check(candidates.every((candidate) => candidate.source === 'bundled'), 'source 统一为 bundled')
check(candidates.every((candidate) => candidate.rank === 600), 'rank 统一为 600 (BUNDLED_SKILL_RANK)')
check(candidates.every((candidate) => candidate.invocation.modelInvocable === true), '默认 modelInvocable = true')
check(candidates.every((candidate) => candidate.invocation.userInvocable === true), '默认 userInvocable = true')
check(captured.tools.every((tool) => typeof tool.execute === 'function'), `${EXPECTED_TOOLS.length} 个工具都有 execute`)

// 诊断工具必须诚实列出尚未实现的能力，而不是假装具备
const diagnosticsTool = captured.tools.find((tool) => tool.name === 'professor_diagnostics')
const diagnostics = diagnosticsTool === undefined
  ? { notImplemented: [], warnings: [] }
  : await diagnosticsTool.execute({}, exec)
const notImplementedList = diagnostics.notImplemented ?? []
check(notImplementedList.length > 0, '诊断工具列出未实现能力', `${notImplementedList.length} 项`)
const notImplementedFeatures = notImplementedList.map((entry) => entry.feature).join(' | ')
// 两个方向都要成立：仍然真实的限制必须在列（无 OCR 引擎 / 无 Office runner / 无幻灯片坐标 /
// 无 PDF 视觉校验），已完成的里程碑（M10 学习状态、M11 笔记与复习件/LaTeX）不得继续挂在清单上。
check(/OCR|slide coordinates|Office|visual verification/i.test(notImplementedFeatures),
  '未实现清单仍覆盖真实残留的限制')
check(!/learning state|note and review/i.test(notImplementedFeatures),
  '已完成的里程碑不得继续留在未实现清单')
check(Array.isArray(diagnostics.warnings), '诊断工具返回 warnings 数组')
check(
  JSON.stringify(diagnostics).includes('REDACTED') === false
  && JSON.stringify(diagnostics).length < 20000,
  '诊断输出不含秘密/环境转储（体积受限、无环境变量字段）',
)
// 没有 ctx.fs 的上下文里，诊断必须如实说“看不到”，而不是抛错或谎称项目不存在。
check(diagnostics.sandbox?.fsAvailable === false, '无文件系统服务时被如实报告')
check(diagnostics.project?.projectFile === 'unobservable', '无文件系统服务时不臆断 project.yaml 的存在性')

// 释放 watcher，避免校验进程留下描述符（旧版本从不 abort）
abort.abort()
check(watchStats.opened === 1, '每个插件实例只开启一个 watcher', `${watchStats.opened} 个`)
check(watchStats.closed === 1, '校验结束已关闭 watcher（无描述符泄漏）', `${watchStats.closed} 个已关闭`)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
