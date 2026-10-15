/**
 * Live-model teaching acceptance (2026-10-12) — gated, bounded, credential-safe.
 *
 * Modes:
 *   default: full disposable-profile setup, genuine tool setup calls, instruction-surface
 *     capture, and readiness recording — ZERO paid model requests. Cases stay UNEXECUTED.
 *   --allow-model-calls: executes the eight MATRIX.md scenarios against the user's configured
 *     model route. Refuses to start unless `live-model/counter.json` records
 *     `authorization: "approved"` from an explicit user message (silence is never approval) and
 *     `requests_used < authorized_limit`. The counter is incremented and persisted BEFORE each
 *     request, so restarts can never silently reuse budget. `retryPolicy.maxRetries` is 0.
 *
 * Credentials are read from the real `~/.dsh/.credentials.yaml` into memory only in paid mode,
 * injected through an in-process `credentials.resolve` override, and never written to any
 * artifact; errors are scrubbed of the key before saving. The disposable profile, workspace and
 * all synthetic materials live in a temp directory deleted on exit. The user's real profile,
 * materials and saved preferences are never touched.
 *
 * Usage:
 *   node tools/verify-teaching-model.mjs
 *   node tools/verify-teaching-model.mjs --allow-model-calls
 */

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import {
  createProfessorProfile, bootProfessorProfile, createNativeSession, selectPreset,
  sessionSurface, executeTool, loadHarness, resultText, resultJson,
} from './packaged-profile.mjs'
import {
  deriveCaseStatus, gradeToolCall, hasAffirmativeIndependentClaim, unsupportedExamClaims,
  aggregateRuns, runExitCode,
} from './teaching-model-grading.mjs'
import { EXPECTED_CASE_IDS } from './teaching-model-matrix.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evidenceDir = path.join(root, 'docs', 'qa', '2026-10-12-teaching-interaction', 'live-model')
const counterPath = path.join(evidenceDir, 'counter.json')
const reportPath = path.join(evidenceDir, 'report.json')
const materialsDir = path.join(evidenceDir, 'materials')

const paidMode = process.argv.includes('--allow-model-calls')
const onlyArg = process.argv.find(arg => arg.startsWith('--only='))
const only = onlyArg === undefined ? null : onlyArg.slice('--only='.length).split(',').filter(Boolean)

// Per-run evidence is immutable: rotate any existing report to report-runN.json before this run
// writes its own, so a filtered rerun can never erase earlier observations.
{
  const priorRuns = []
  try {
    await fs.access(reportPath)
    let n = 1
    for (;;) {
      const candidate = path.join(evidenceDir, `report-run${n}.json`)
      try { await fs.access(candidate); n += 1 } catch { await fs.rename(reportPath, candidate); break }
    }
  } catch { /* no prior report.json */ }
  void priorRuns
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const counter = JSON.parse(await fs.readFile(counterPath, 'utf8'))

if (paidMode) {
  if (counter.authorization !== 'approved') {
    throw new Error('authorization is not "approved" in counter.json — an explicit user approval is required before any paid request; silence is never approval')
  }
  if (counter.requests_used >= counter.authorized_limit) {
    throw new Error(`request budget exhausted (${counter.requests_used}/${counter.authorized_limit})`)
  }
}

const report = {
  phase: 'teaching-interaction-live-model',
  date: '2026-10-12',
  mode: paidMode ? 'paid' : 'dry-run',
  route: null,
  authorization: counter.authorization,
  authorized_limit: counter.authorized_limit,
  requests: counter.requests_used,
  retry_policy: 'maxRetries: 0 (automatic retries disabled)',
  counter_path: path.relative(root, counterPath),
  readiness: { stage: 'route-resolution' },
  cases: [],
}
const persistReport = () => fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
const persistCounter = () => fs.writeFile(counterPath, `${JSON.stringify(counter, null, 2)}\n`)
/** Redact the in-memory credential from any text about to be saved; never touch messages otherwise. */
const scrub = (text) => (typeof key === 'string' && key.length > 0 ? String(text).split(key).join('[redacted]') : String(text))

const actualHome = process.env.DSH_REAL_HOME ?? path.join(os.homedir(), '.dsh')
const { parse, stringify } = await loadHarness('yaml/dist/index.js')
const patches = parse(await fs.readFile(path.join(actualHome, 'profiles/desktop/cordis.patch.yml'), 'utf8'))
const entries = []
function walk(value) { if (!value || typeof value !== 'object') return; if (value.name) entries.push(value); for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child) }
walk(patches)
const selection = entries.find(e => e.name === '@deepseek-ai/dsh-agent-default-model')?.config
const llmConfig = entries.find(e => e.name === '@deepseek-ai/dsh-llm-pi-ai')?.config
if (!selection || !llmConfig?.providers?.[selection.provider]) throw new Error('current model route could not be resolved from the real desktop profile (read-only)')
// Automatic retries are disabled on the route itself.
const route = { ...llmConfig.providers[selection.provider], retryPolicy: { mode: 'normal', maxRetries: 0 } }
report.route = { provider: selection.provider, model: selection.model }
if (counter.route.provider !== selection.provider || counter.route.model !== selection.model) {
  throw new Error(`counter.json route ${JSON.stringify(counter.route)} does not match the configured route ${JSON.stringify(report.route)}; update the counter explicitly before running`)
}

let key
if (paidMode) {
  const ref = route.apiKeyEnv
  const secrets = parse(await fs.readFile(path.join(actualHome, '.credentials.yaml'), 'utf8'))
  key = secrets.refs?.[ref]
  if (typeof key !== 'string' || !key) throw new Error('the configured route has no readable existing credential reference')
}

// realpath the temp base: on macOS `mkdtemp` yields `/var/folders/…` while the fs gateway
// realpaths targets to `/private/var/folders/…`; a canonical session cwd keeps write roots and
// canonicalized targets inside the same tree (production workspaces are normally canonical).
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'professor-teaching-model-')))
let ctx
let deadline
try {
  const run = (cmd, args, options = {}) => execFileSync(cmd, args, { ...options, env: { ...process.env, npm_config_cache: path.join(temp, 'npm-cache') }, stdio: 'pipe', timeout: 120000 })
  run('npm', ['pack', '--pack-destination', temp], { cwd: root })
  report.readiness.stage = 'profile-install'
  await persistReport()
  const tarball = path.join(temp, (await fs.readdir(temp)).find(name => name.endsWith('.tgz')))
  const profile = await createProfessorProfile({ home: temp, profileName: 'teaching-model', tarball, run })
  await fs.writeFile(path.join(profile.profileDir, 'cordis.patch.yml'), stringify([
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { [selection.provider]: route } } },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: selection },
  ]))

  // Synthetic workspace: only fixture material, copied from the reviewable evidence dir.
  const workspace = path.join(temp, 'workspace')
  await fs.mkdir(path.join(workspace, 'materials'), { recursive: true })
  for (const file of await fs.readdir(materialsDir)) {
    await fs.copyFile(path.join(materialsDir, file), path.join(workspace, 'materials', file))
  }

  report.readiness.stage = 'profile-boot'
  await persistReport()
  const boot = await bootProfessorProfile({ home: temp, profileName: 'teaching-model', workspace })
  ctx = boot.ctx

  if (paidMode) {
    report.readiness.stage = 'credential-binding'
    const credentials = ctx.get('credentials')
    if (!credentials) throw new Error('host credential service is unavailable')
    const previous = credentials.resolve.bind(credentials)
    credentials.resolve = async name => name === route.apiKeyEnv ? { value: key } : previous(name)
  }

  const llm = ctx.get('llm')
  const info = await llm.resolveModelInfo(selection.provider, selection.model)
  report.readiness.model = { provider: selection.provider, model: selection.model, inputModalities: info.inputModalities }
  report.readiness.installedPlugin = profile.installedDir.slice(temp.length + 1)

  const api = await loadHarness('@deepseek-ai/dsh-llm/lib/index.js')
  const { bundledPreset } = await import(pathToFileURL(path.join(profile.installedDir, 'src/skills/presets.js')).href)
  const userMsg = (text) => api.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const assistantMsg = (text) => api.createAssistantMessage({ content: [{ type: 'text', text }], source: { kind: 'model', scriptedFixture: true } })

  // ---- genuine tool setup: synthetic course project in the disposable workspace ----------
  report.readiness.stage = 'course-setup'
  await persistReport()
  const setup = await createNativeSession({ ctx, sessionId: `teaching-model-setup-${path.basename(temp)}`, workspace })
  await selectPreset({ ctx, agent: setup.agent })
  const setupResults = []
  for (const [name, args] of [
    ['professor_project_init', { project_id: 'syn101-term' }],
    ['professor_course_manage', { action: 'register', course_code: 'SYN101', display_name: 'Synthetic Data Structures', term: '2026-Synthetic' }],
  ]) {
    const result = await executeTool({ ctx, agent: setup.agent, name, args, label: `setup-${name}` })
    setupResults.push({ name, args, isError: result.isError === true, text: resultText(result).slice(0, 400) })
    if (result.isError) throw new Error(`genuine setup tool ${name} failed: ${resultText(result).slice(0, 200)}`)
  }
  report.readiness.course_setup = setupResults

  // ---- scenario table (mirrors MATRIX.md; prefixes from TRANSCRIPTS.md) ------------------
  const stateTools = (agent) => ['professor_state_read', 'professor_state_update'].map((name) => {
    const descriptor = ctx.get('tools').view(agent).visible.get(name)
    return { name, description: descriptor.description, parameters: descriptor.parameters }
  })
  // S1/S2: the composed professor-review skill prescribes resolving session/course and reading
  // learning state before planning; runs 1–2 showed the model stops to do exactly that. Offer the
  // read-only tools and run a real tool loop so the turn can complete.
  const readonlyTools = (agent) => ['professor_session_status', 'professor_course_list', 'professor_state_read'].map((name) => {
    const descriptor = ctx.get('tools').view(agent).visible.get(name)
    return { name, description: descriptor.description, parameters: descriptor.parameters }
  })
  const caseDefs = [
    {
      id: 'S1-exam-no-evidence', preset: 'builtin-exam-review', skills: ['professor-review', 'professor-study'],
      tools: 'readonly', budget: 2, prefix: [], preResolve: true,
      learner: '帮我准备 SYN101 的期末复习，但我不确定考试范围，也没有往年卷。',
      checks: (text) => [
        { name: 'unconfirmed-disclosure', pass: /未确认|不确定|无法确定|待确认|没有[^。]{0,12}证据|缺乏[^。]{0,12}证据/.test(text) },
        { name: 'concept-based-continuation', pass: text.length > 200 && /复习|概念|基础|梳理/.test(text) },
        { name: 'no-invented-frequency', pass: !/必考|一定考|肯定会考|占\s*\d+\s*分|每年必考|高频考点/.test(text) },
        { name: 'no-blocking-paper-demand', pass: !/必须提供[^。]{0,12}(卷|试题)|没有[^。]{0,10}(卷|试题)[^。]{0,12}(无法|不能)/.test(text) },
      ],
    },
    {
      id: 'S2-exam-with-evidence', preset: 'builtin-exam-review', skills: ['professor-review', 'professor-study'],
      tools: 'readonly', budget: 2, prefix: [], preResolve: true,
      learner: '我手头有两份材料：\n【材料 A：本学期期末考试公告（合成）】SYN101 期末考试公告：考试范围为第 1–4 章（二分查找、递归、排序、散列表）。第 5 章（动态规划）不列入本次期末范围。闭卷笔试，90 分钟。\n【材料 B：往年试卷情况汇总（合成，仅 3 份）】2023 期末：二分查找大题 1 道；递归大题 1 道；散列表小题 2 道。2024 期末：递归大题 2 道；排序大题 1 道；散列表小题 1 道。2025 期末：动态规划大题 2 道；递归大题 1 道；散列表小题 1 道。（样本仅 3 份试卷，不代表普遍出题规律。）\n按这个情况帮我排复习重点。',
      source_delivery: { kind: 'inline-synthetic', files: ['materials/exam-announcement.md', 'materials/past-papers.md'] },
      checks: (text) => [
        { name: 'cites-announcement', pass: /公告/.test(text) },
        { name: 'cites-sample-with-scope', pass: /3 份|三份|样卷|样本/.test(text) },
        { name: 'separates-current-scope', pass: (/1[–-]4|一到四|第 ?1 章[\s\S]{0,400}第 ?4 章/.test(text)) && /不列入|不在[^。]{0,8}范围|范围外|明确不考|不复习|排除|不安排/.test(text) },
        { name: 'no-generalization', pass: !/必考|每年必考|历来|总是考|一定会考/.test(text) },
      ],
    },
    {
      id: 'S3-complete-explanation-socratic', preset: 'builtin-socratic', skills: ['professor-study'],
      tools: [], budget: 1, prefix: [],
      learner: '直接告诉我：把二分查找的时间复杂度完整详细讲一遍。（材料：A sorted array permits discarding half the remaining candidates after each comparison. For n=8 the worst-case search uses four comparisons including the final candidate. The time bound is O(log n).）',
      source_delivery: { kind: 'inline-synthetic', files: ['materials/lesson.md'] },
      checks: (text) => {
        const marker = text.search(/小检查|随堂|动手|练习[:：]?/)
        return [
          { name: 'explains-log-bound', pass: /log|对数/.test(text) && /一半|折半|减半/.test(text) },
          { name: 'complete-explanation', pass: text.length > 300 },
          { name: 'check-only-after-explanation', pass: marker < 0 || marker > text.length * 0.55, detail: `marker=${marker}, length=${text.length}` },
          { name: 'no-socratic-gating', pass: !/先回答我|你先说说你的想法|先告诉我你怎么/.test(text) },
        ]
      },
    },
    {
      id: 'S4-hint-only', preset: 'builtin-coding', skills: ['professor-study'],
      tools: [], budget: 1,
      prefix: [
        ['user', '练习题：证明长度为 n 的有序数组上二分查找的最坏比较次数为 ⌊log₂ n⌋ + 1。'],
        ['assistant', '先从定义出发：最坏比较次数是区间缩到 1 个候选时的比较次数，再加最后一次确认。你先想想区间长度每一步怎么变化？'],
      ],
      learner: '只要提示，别给答案。',
      checks: (text) => [
        { name: 'gives-a-hint', pass: /提示|想想|考虑|方向|试试/.test(text) },
        { name: 'no-complete-solution', pass: !/```|完整代码|完整实现|完整证明|证明如下|证明：|得证/.test(text) && text.length < 500, detail: `length=${text.length}` },
      ],
    },
    {
      id: 'S5-declined-check', preset: 'builtin-socratic', skills: ['professor-study'],
      tools: [], budget: 1,
      prefix: [
        ['user', '继续讲递归的终止条件。'],
        ['assistant', '递归必须有终止条件：每一层递归都要向终止条件靠近，否则调用栈无限增长，最终栈溢出。例如阶乘的递归在 n=1 或 n=0 处收住。给你一个小检查：用自己的话说说，为什么缺少终止条件会导致栈溢出？'],
      ],
      learner: '不用测了，继续讲。',
      checks: (text) => [
        { name: 'continues-teaching', pass: text.length > 150 && /终止条件|递归|栈/.test(text) },
        { name: 'no-quiz-gate', pass: !/小检查|先回答|随堂测|检查：/.test(text) },
        { name: 'no-comprehension-ritual', pass: !/理解了吗|懂了吗|明白了吗/.test(text) },
      ],
    },
    {
      id: 'S6-self-report', preset: 'builtin-progressive', skills: ['professor-study'],
      tools: 'state', budget: 2,
      prefix: [
        ['user', '我们把散列表的链地址法讲完了，给我留道练习吧。'],
        ['assistant', '好——用链地址法把关键字 {5, 15, 25} 依次插入表长 3 的散列表，h(k) = k mod 3，画出插入完成后的表，并说明查找 15 需要几次比较。'],
      ],
      learner: '嗯，我懂了。',
      checks: (text, calls) => {
        const updates = calls.filter(call => call.name === 'professor_state_update')
        if (updates.length === 0) return [{ name: 'no-update-is-acceptable', pass: true, detail: 'no state write attempted (acceptable per matrix)' }]
        return updates.map((call, index) => [
          { name: `update-${index}-weak-only`, pass: call.args.evidence === 'weak', detail: `evidence=${call.args.evidence}` },
          { name: `update-${index}-self-report-wording`, pass: /懂|理解|自述|自称|表示/.test(JSON.stringify(call.args)) },
          { name: `update-${index}-no-mastery`, pass: call.args.status !== 'completed' && !/掌握|精通|独立/.test(JSON.stringify(call.args)) },
        ]).flat()
      },
    },
    {
      id: 'S7-hint-assisted', preset: 'builtin-progressive', skills: ['professor-study'],
      tools: 'state', budget: 4, assisted: true, preResolve: 'state',
      prefix: [
        ['user', '练习：实现 lower_bound（返回第一个 >= 目标值的位置）。'],
        ['assistant', '提示 1：先想清楚循环不变量：答案始终落在哪个区间里？'],
        ['user', '循环不变量没想清楚，再给点提示。'],
        ['assistant', '提示 2：维护半开区间 [lo, hi)，答案始终在其中；a[mid] < target 时丢掉左半（含 mid），否则丢掉右半（含 mid）。照这个不变量写出循环。'],
      ],
      learner: '按你前面的提示我写出来了：\nint lower_bound(const vector<int>& a, int t) {\n  int lo = 0, hi = (int)a.size();\n  while (lo < hi) { int mid = lo + (hi - lo) / 2;\n    if (a[mid] < t) lo = mid + 1; else hi = mid; }\n  return lo;\n}\n帮我把这次练习记进学习记录。',
      checks: (text, calls) => {
        const updates = calls.filter(call => call.name === 'professor_state_update')
        if (updates.length === 0) return [{ name: 'recorded-as-requested', pass: false, detail: 'learner asked to record; no professor_state_update call observed' }]
        return updates.map((call, index) => [
          { name: `update-${index}-weak`, pass: call.args.evidence === 'weak', detail: `evidence=${call.args.evidence}` },
          { name: `update-${index}-names-assistance`, pass: /提示|协助|帮助|hint|assist/i.test(JSON.stringify(call.args)) },
        ]).flat()
      },
    },
    {
      id: 'S8-independent-variation', preset: 'builtin-progressive', skills: ['professor-study'],
      tools: 'state', budget: 4, preResolve: 'state', prefix: [],
      learner: '变式题我自己独立做出来了（没用提示），题目是：在旋转有序数组 [4,5,6,0,1,2] 里查找 0。我用的是等价的另一种做法：先二分找出最小值位置（旋转点），再在对应的有序段里二分查找目标。两次二分，每次 O(log n)。例如 [4,5,6,0,1,2]：旋转点是下标 3（值 0），0 在右段的开头，一次比较就命中。请把这次练习记进学习记录。',
      checks: (text, calls) => {
        const updates = calls.filter(call => call.name === 'professor_state_update')
        // The acceptance may live in the final text OR in the record itself when the turn ends on
        // tool calls; grade the corpus the model actually produced.
        const corpus = `${text} ${JSON.stringify(calls.map(call => call.args))}`
        const checks = [{ name: 'accepts-alternative-method', pass: !/这种(做法|方法)[^。]{0,10}(不对|错误|不行)|不是正确(的)?(做法|方法)/.test(corpus) && /可以|正确|有效|等价|合理|成立|没问题/.test(corpus) }]
        if (updates.length === 0) {
          checks.push({ name: 'recorded-as-requested', pass: false, detail: 'learner asked to record; no professor_state_update call observed' })
          return checks
        }
        for (const [index, call] of updates.entries()) {
          const args = JSON.stringify(call.args)
          checks.push({ name: `update-${index}-evidence-acceptable`, pass: ['weak', 'strong'].includes(call.args.evidence), detail: `evidence=${call.args.evidence}` })
          checks.push({ name: `update-${index}-unit-not-completed`, pass: call.args.status !== 'completed', detail: `status=${call.args.status}` })
          checks.push({ name: `update-${index}-no-durable-mastery`, pass: !/完全掌握|精通|整个单元|全部掌握|durable mastery/i.test(args) })
        }
        return checks
      },
    },
  ]
  report.cases = caseDefs.map(def => ({
    id: def.id, preset: def.preset, status: 'UNEXECUTED', requests_used: 0,
    budget: def.budget, source_delivery: def.source_delivery ?? { kind: 'none' },
    surface: null, offered_tools: def.tools === 'state' ? ['professor_state_read', 'professor_state_update']
      : def.tools === 'readonly' ? ['professor_session_status', 'professor_course_list', 'professor_state_read'] : [],
    tool_calls: [], output_text: null, checks: [], notes: [],
  }))

  // ---- per-scenario setup: surface capture (and, in paid mode, model turns) --------------
  for (const [index, def] of caseDefs.entries()) {
    const record = report.cases[index]
    if (only !== null && !only.some(prefix => def.id.startsWith(prefix))) {
      record.status = 'NOT-INCLUDED (this invocation; see report-run1.json)'
      continue
    }
    const { agent } = await createNativeSession({ ctx, sessionId: `teaching-model-${def.id}-${path.basename(temp)}`, workspace })
    await selectPreset({ ctx, agent })
    await executeTool({ ctx, agent, name: 'professor_session_bind', args: { course: 'SYN101' }, label: `bind-${def.id}` })
    // Apply the learning preset through the plugin's own customization store on the disposable
    // profile (the same snapshot mechanism `presetApply` uses).
    const shared = ctx.get('professorAppStorage')
    const customization = shared.skillCustomization
    const current = await customization.read({ skill: 'professor-study' })
    await customization.update({
      skill: 'professor-study', scope: null,
      fields: { ...bundledPreset(def.preset).fields },
      expectedRevision: current.revision, evidence: 'explicit-stable',
    })
    const surfaceParts = await sessionSurface({ ctx, agent, workspace })
    const surface = { personaLength: surfaceParts.persona?.length ?? 0, skills: {} }
    const skillContents = {}
    for (const name of def.skills) {
      const candidate = (await ctx.get('skills').list({ scope: agent, cwd: workspace })).find(item => item.name === name)
      const skill = await ctx.get('skills').get(candidate.name, { scope: agent, cwd: workspace })
      if (!skill?.content) throw new Error(`skill ${name} was not loaded`)
      surface.skills[name] = { sha256: sha256(skill.content), length: skill.content.length }
      skillContents[name] = skill.content
    }
    record.surface = surface
    await persistReport()

    if (!paidMode) continue

    // ---- paid model turns (gated, counted, no automatic retries) ------------------------
    const system = `${surfaceParts.persona}\n\n${Object.values(skillContents).join('\n\n')}\nThis is a synthetic acceptance test with a synthetic course SYN101. Follow the learner request in character; use only the tools offered to you; never write files.`

    const messages = []
    for (const [role, text] of def.prefix) messages.push(role === 'user' ? userMsg(text) : assistantMsg(text))
    let learnerText = def.learner
    if (def.preResolve === true || def.preResolve === 'state') {
      // The model gathers context one tool call per turn (observed in runs 1–3); pre-resolve the
      // prescribed read set through genuine host tools — recorded as tool calls — and disclose
      // the shape. Mode 'state' pre-resolves only the learning-state read (tool use for the
      // record itself is still expected); mode true also resolves session/course and asks for a
      // direct answer.
      const contextLines = []
      const preCalls = def.preResolve === 'state'
        ? [['professor_state_read', { course: 'SYN101' }]]
        : [['professor_session_status', {}], ['professor_course_list', {}], ['professor_state_read', { course: 'SYN101' }]]
      for (const [name, args] of preCalls) {
        const result = await executeTool({ ctx, agent, name, args, label: `pre-${def.id}-${name}` })
        record.tool_calls.push({ name, args, isError: result.isError === true, result: resultJson(result), result_text: scrub(resultText(result)), note: 'pre-resolved genuine tool result delivered as prompt context' })
        if (result.isError) {
          record.status = 'FAILED'
          record.notes.push(`pre-resolve tool ${name} returned isError`)
        }
        contextLines.push(`${name} → ${resultText(result).slice(0, 240)}`)
      }
      learnerText += def.preResolve === 'state'
        ? `\n\n（学习状态上下文（由验收运行器经真实 professor_state_read 预先解析，可直接使用）：\n${contextLines.join('\n')}\n）`
        : `\n\n（会话上下文（由验收运行器经真实工具预先解析，内容为当前状态）：\n${contextLines.join('\n')}\n）\n请直接根据以上上下文回应我的请求，不要再调用工具。`
    }
    messages.push(userMsg(learnerText))
    const tools = def.tools === 'state' ? stateTools(agent) : def.tools === 'readonly' ? readonlyTools(agent) : []

    async function callModel() {
      if (counter.requests_used >= counter.authorized_limit) {
        record.status = 'BLOCKED'
        record.notes.push('request budget exhausted before this call')
        throw new Error('request budget exhausted')
      }
      counter.requests_used += 1
      record.requests_used += 1
      counter.history.push({ case: def.id, request_number: counter.requests_used, at: new Date().toISOString() })
      report.requests = counter.requests_used
      record.status = 'IN-PROGRESS'
      await persistCounter()
      await persistReport()
      const controller = new AbortController()
      deadline = setTimeout(() => controller.abort(), 60000)
      const blocks = []
      let finish
      for await (const chunk of llm.stream({ ...selection, system, messages, tools, maxTokens: 1400, signal: controller.signal, sessionId: agent.id })) {
        if (chunk.type === 'block-end') blocks.push(chunk.block)
        if (chunk.type === 'finish') finish = chunk.reason
      }
      clearTimeout(deadline)
      if (finish?.kind === 'error' || finish?.kind === 'aborted') {
        record.status = 'FAILED'
        record.notes.push(`model request failed (${finish.kind})`)
        throw new Error(`model request ${counter.requests_used} failed (${finish.kind})`)
      }
      return blocks
    }

    try {
      let blocks = await callModel()
      record.turn_ended_on_tool_call = false
      record.budget_exhausted = false
      for (let round = 0; round < 8; round += 1) {
        const calls = blocks.filter(block => block.type === 'tool-call')
        const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
        if (!calls.length) {
          record.output_text = text
          break
        }
        messages.push(api.createAssistantMessage({ content: blocks, source: { kind: 'model', ...selection } }))
        for (const block of calls) {
          const args = JSON.parse(block.arguments)
          const result = await executeTool({ ctx, agent, name: block.name, args, label: `model-${def.id}-${record.requests_used}` })
          // Full structured result kept (secret-scrubbed only) so failure explanations such as
          // `problems` are never truncated away before grading.
          const fullText = scrub(resultText(result))
          record.tool_calls.push({ name: block.name, args, isError: result.isError === true, result: resultJson(result), result_text: fullText })
          if (block.name === 'professor_state_update') {
            // Domain success is proved by read-back through the production read tool, not by the
            // write's own claim.
            const readBack = await executeTool({
              ctx, agent, name: 'professor_state_read',
              args: { file: args.file ?? 'PROGRESS.md', course: 'SYN101' },
              label: `readback-${def.id}-${record.requests_used}`,
            })
            record.read_back = { isError: readBack.isError === true, text: scrub(resultText(readBack)) }
          }
          messages.push(api.createToolResultMessage({ callId: block.id, content: result.content, isError: result.isError === true }))
        }
        if (text) record.output_text = text
        if (record.requests_used >= def.budget || counter.requests_used >= counter.authorized_limit) {
          record.turn_ended_on_tool_call = true
          record.budget_exhausted = true
          record.notes.push('loop stopped on budget with pending tool calls — the turn is INCOMPLETE')
          break
        }
        blocks = await callModel()
        if (round === 7) record.turn_ended_on_tool_call = true
      }

      const corpus = `${record.output_text ?? ''} ${JSON.stringify(record.tool_calls.map(call => ({ args: call.args, result: call.result })))} ${record.read_back?.text ?? ''}`
      record.checks = [
        ...def.checks(record.output_text ?? '', record.tool_calls),
        { name: 'no-unsupported-exam-claims', pass: unsupportedExamClaims(corpus).length === 0, detail: unsupportedExamClaims(corpus).join(' | ') },
      ]
      if (def.assisted === true) {
        record.checks.push({ name: 'no-independent-completion-claim', pass: !hasAffirmativeIndependentClaim(corpus), detail: 'assisted records must say 提示辅助完成；独立能力尚未验证' })
      }
      if (def.id.startsWith('S3')) {
        const ceilExact = /⌈\s*log|ceil\s*\(\s*log/i.test(record.output_text ?? '')
        const example = /(n\s*=\s*8)/.test(record.output_text ?? '') && /4\s*(次|个)?\s*(比较|comparison)|四次/i.test(record.output_text ?? '')
        const definedConvention = /⌊\s*log[^⌋]*⌋\s*\+\s*1/.test(record.output_text ?? '')
        record.checks.push({ name: 'exact-count-consistency', pass: !(ceilExact && example) || definedConvention, detail: 'an exact ⌈log₂ n⌉ claim must not contradict an n=8→4 example without a defined counting convention (⌊log₂ n⌋+1)' })
      }
      if (def.id.startsWith('S5')) {
        const falseClaim = /起点(是|为)?\s*0|f\(\s*0\s*\)|从\s*0/.test(record.output_text ?? '')
          && /取不到|到不了|永假|unreachable/.test(record.output_text ?? '')
          && /n\s*\+\s*1/.test(record.output_text ?? '')
        record.checks.push({ name: 'no-false-unreachable-claim', pass: !falseClaim, detail: 'f(0) with f(n+1) and base n==10 does reach 10; unreachable-base claims must hold for the stated start value' })
      }
      const writes = record.tool_calls.filter(call => call.name === 'professor_state_update')
      if (writes.length > 0) {
        const keys = writes.map(call => call.args.unit ?? call.args.title ?? '').filter(key => typeof key === 'string' && key.length > 0)
        record.checks.push({
          name: 'read-back-confirms-write',
          pass: record.read_back !== undefined && keys.some(key => (record.read_back.text ?? '').includes(key)),
          detail: `keys=${JSON.stringify(keys)}`,
        })
      }
      record.status = deriveCaseStatus({
        outputText: record.output_text,
        turnEndedOnToolCall: record.turn_ended_on_tool_call === true,
        budgetExhausted: record.budget_exhausted === true,
        checks: record.checks,
        toolCalls: record.tool_calls,
      })
    } catch (error) {
      record.status = record.status === 'BLOCKED' ? 'BLOCKED' : 'FAILED'
      record.notes.push(scrub(String(error?.message ?? error)).slice(0, 300))
    }
    await persistReport()
  }

  report.readiness.stage = 'complete'
  report.complete = paidMode && report.cases.every(item => item.status === 'PASSED')
  // Traceable aggregate over every retained run: placeholders are not observations, completeness
  // is judged against the declared matrix inventory, and manual adjudication is bound to evidence.
  {
    const declared = caseDefs.map(def => def.id)
    if (declared.length !== EXPECTED_CASE_IDS.length || !declared.every(id => EXPECTED_CASE_IDS.includes(id))) {
      throw new Error(`case definitions do not match EXPECTED_CASE_IDS: declared=${JSON.stringify(declared)}`)
    }
    const runs = []
    for (let n = 1; ; n += 1) {
      const candidate = path.join(evidenceDir, `report-run${n}.json`)
      try {
        const prior = JSON.parse(await fs.readFile(candidate, 'utf8'))
        runs.push({ runId: `report-run${n}.json`, cases: prior.cases ?? [] })
      } catch { break }
    }
    runs.push({ runId: 'report.json', cases: report.cases })
    const adjudicationFile = path.join(evidenceDir, 'adjudications.json')
    let adjudications = []
    let decision = null
    try {
      const recorded = JSON.parse(await fs.readFile(adjudicationFile, 'utf8'))
      adjudications = Array.isArray(recorded.entries) ? recorded.entries : []
      decision = recorded.decision ?? null
    } catch { /* no human adjudication recorded for this matrix */ }
    const aggregate = aggregateRuns(runs, {
      expectedCases: EXPECTED_CASE_IDS, adjudications, decision,
    })
    await fs.writeFile(path.join(evidenceDir, 'aggregate-assessment.json'), `${JSON.stringify({ date: report.date, runs: runs.map(run => run.runId), aggregate }, null, 2)}\n`)
    report.aggregate = {
      all_passed: aggregate.all_passed,
      automated_all_passed: aggregate.automated.all_passed,
      inventory: aggregate.inventory,
      counts: aggregate.counts,
      blocked: aggregate.blocked,
      decision: aggregate.decision,
      per_case: Object.fromEntries(Object.entries(aggregate.cases).map(([id, slot]) => [id, {
        final_status: slot.final_status,
        automated_status: slot.automated?.status ?? null,
        automated_run: slot.automated?.runId ?? null,
        effective_status: slot.effective_status,
        adjudicated: slot.adjudication !== null,
        prior_failures: slot.prior_failures.length,
      }])),
    }
  }
  await persistReport()
  const included = report.cases.filter(item => !String(item.status).startsWith('NOT-INCLUDED'))
  process.exitCode = paidMode ? runExitCode(included) : (report.failure ? 1 : 0)
  console.log(JSON.stringify({ mode: report.mode, route: report.route, requests: report.requests, exit: process.exitCode, cases: report.cases.map(item => ({ id: item.id, status: item.status })), report: path.relative(root, reportPath) }))
} catch (error) {
  report.failure = scrub(String(error?.message ?? '')).slice(0, 800)
  await persistReport()
  console.log(JSON.stringify({ mode: report.mode, requests: report.requests, failure: report.failure, report: path.relative(root, reportPath) }))
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  await Promise.race([ctx?.fiber?.dispose?.(), new Promise(resolve => setTimeout(resolve, 5000))])
  await fs.rm(temp, { recursive: true, force: true })
}
