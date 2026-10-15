/** Explicitly opted-in, four-request maximum test using the user's current model route.
 * Credentials are read only into memory, never copied into the disposable profile or report.
 */
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createProfessorProfile, bootProfessorProfile, createNativeSession, selectPreset,
  loadHarness, sessionSurface, executeTool } from './packaged-profile.mjs'

if (!process.argv.includes('--allow-model-calls')) throw new Error('explicit --allow-model-calls authorization is required')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const actualHome = process.env.DSH_REAL_HOME ?? path.join(os.homedir(), '.dsh')
const output = process.env.PROFESSOR_MODEL_REPORT ?? path.join(os.tmpdir(), 'professor-material-model-report.json')
const repairAndVision = process.argv.includes('--repair-and-vision')
const limit = repairAndVision ? 2 : 4
let priorRequests = 0
let priorTests = []
let priorSetupAttempts = []
try { const previous = JSON.parse(await fs.readFile(output, 'utf8')); priorRequests = previous.requests ?? 0; priorTests = (previous.tests ?? []).filter(test => test.name !== 'image-delivery'); priorSetupAttempts = [...(previous.setup_attempts ?? []), ...(previous.tests ?? []).filter(test => test.name === 'image-delivery')] } catch { /* fresh report */ }
if (priorRequests >= limit) throw new Error('this report has already exhausted its authorized request budget')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-material-model-'))
const { parse, stringify } = await loadHarness('yaml/dist/index.js')
const patches = parse(await fs.readFile(path.join(actualHome, 'profiles/desktop/cordis.patch.yml'), 'utf8'))
const entries = []
function walk(value) { if (!value || typeof value !== 'object') return; if (value.name) entries.push(value); for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child) }
walk(patches)
const selection = entries.find(e => e.name === '@deepseek-ai/dsh-agent-default-model')?.config
const config = entries.find(e => e.name === '@deepseek-ai/dsh-llm-pi-ai')?.config
if (!selection || !config?.providers?.[selection.provider]) throw new Error('current model route could not be resolved')
const route = { ...config.providers[selection.provider], retryPolicy: { mode: 'normal', maxRetries: 0 } }
const ref = route.apiKeyEnv
const secrets = parse(await fs.readFile(path.join(actualHome, '.credentials.yaml'), 'utf8'))
const key = secrets.refs?.[ref]
if (typeof key !== 'string' || !key) throw new Error('the selected route has no readable existing credential reference')
const report = { route: { provider: selection.provider, model: selection.model }, requests: priorRequests, tests: priorTests, setup_attempts: priorSetupAttempts, complete: false, stage: 'profile-setup' }
let ctx
let deadline
try {
  const run = (cmd, args, options = {}) => execFileSync(cmd, args, { ...options, env: { ...process.env, npm_config_cache: path.join(temp, 'npm-cache') }, stdio: 'pipe', timeout: 120000 })
  run('npm', ['pack', '--pack-destination', temp], { cwd: root })
  report.stage = 'profile-install'
  const tarball = path.join(temp, (await fs.readdir(temp)).find(name => name.endsWith('.tgz')))
  const profile = await createProfessorProfile({ home: temp, profileName: 'model-acceptance', tarball, run })
  await fs.writeFile(path.join(profile.profileDir, 'cordis.patch.yml'), stringify([
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { [selection.provider]: route } } },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: selection },
  ]))
  const workspace = path.join(temp, 'synthetic-material')
  await fs.mkdir(workspace)
  const textPath = path.join(workspace, 'lesson.md')
  await fs.writeFile(textPath, '# Binary search\nA sorted array permits discarding half the remaining candidates after each comparison. For n=8 the worst-case search uses four comparisons including the final candidate. The time bound is O(log n).\n')
  const boot = await bootProfessorProfile({ home: temp, profileName: 'model-acceptance', workspace })
  ctx = boot.ctx
  report.stage = 'credential-binding'
  const credentials = ctx.get('credentials')
  if (!credentials) throw new Error('host credential service is unavailable')
  const previous = credentials.resolve.bind(credentials)
  credentials.resolve = async name => name === ref ? { value: key } : previous(name)
  report.stage = 'model-resolution'
  const llm = ctx.get('llm')
  const info = await llm.resolveModelInfo(selection.provider, selection.model)
  report.input_modalities = info.inputModalities
  report.stage = 'native-session'
  const { agent } = await createNativeSession({ ctx, sessionId: `material-model-${path.basename(temp)}`, workspace })
  // This verifier calls llm.stream directly, so no agent turn populates its request header.
  // Bind the exact resolved route for the native image gate as well as the model request.
  Object.assign(agent.options, selection)
  await selectPreset({ ctx, agent })
  const surface = await sessionSurface({ ctx, agent, workspace })
  const definitions = await ctx.get('skills').list({ scope: agent, cwd: workspace })
  const candidate = definitions.find(item => item.name === 'professor-study')
  const skill = await ctx.get('skills').get(candidate.name, { scope: agent, cwd: workspace })
  if (!skill?.content) throw new Error('professor-study skill was not loaded')
  const system = `${surface.persona}\n\n${skill?.content ?? ''}\nThis is a synthetic acceptance test. Follow the user request. Use only the listed tool and never write files.`
  const api = await loadHarness('@deepseek-ai/dsh-llm/lib/index.js')
  const user = text => api.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  async function call(messages, tools = []) {
    if (report.requests >= limit) throw new Error('authorized request budget exhausted')
    report.requests += 1
    report.stage = `model-request-${report.requests}`
    await fs.writeFile(output, JSON.stringify(report, null, 2))
    const controller = new AbortController()
    deadline = setTimeout(() => controller.abort(), 60000)
    const blocks = []
    let finish
    for await (const chunk of llm.stream({ ...selection, system, messages, tools, maxTokens: 1400,
      signal: controller.signal, sessionId: agent.id })) {
      if (chunk.type === 'block-end') blocks.push(chunk.block)
      if (chunk.type === 'finish') finish = chunk.reason
    }
    clearTimeout(deadline)
    if (finish?.kind === 'error' || finish?.kind === 'aborted') throw new Error(`model request ${report.requests} failed (${finish.kind})`)
    return { blocks, finish }
  }
  const descriptor = ctx.get('tools').view(agent).visible.get('professor_material_read')
  if (repairAndVision) {
    if (!priorTests.some(test => test.name === 'unreadable-honesty-retest')) {
    const honesty = await call([user('合成验收：我没有提供任何文件、文件名、页码或公式文本。关键公式完全无法辨认，也没有其他来源。请用普通文字说明能确认什么、不能确认什么，不要虚构文件或工具调用。')])
    const honestText = honesty.blocks.filter(block => block.type === 'text').map(block => block.text).join('')
    report.tests.push({ name: 'unreadable-honesty-retest', text: honestText,
      pass: /无法|不能|不清|辨认/.test(honestText) && !/<tool_call>|<function=|lecture\d+\.pdf/.test(honestText) })
    }
    const python = process.env.DSH_PROFESSOR_ENHANCE_PYTHON
    if (!python) throw new Error('prepared Python is required to generate the synthetic image fixture')
    run(python, [path.join(root, 'test/helpers/material-enhance-fixtures.py'), '--out', workspace])
    const imageResult = await executeTool({ ctx, agent, name: 'professor_material_read',
      args: { action: 'pages', path: path.join(workspace, 'scanned.pdf'), pages: [1] }, label: 'vision-fixture' })
    const images = imageResult.content.filter(block => block.type === 'image')
    if (!images.length) {
      report.setup_attempts.push({ name: 'image-delivery', pass: false, detail: imageResult.content.filter(block => block.type === 'text').map(block => block.text).join('') })
      throw new Error('native material reader delivered no image')
    }
    const visual = await call([api.createUserMessage({ content: [
      { type: 'text', text: '这是合成验收图像。直接读取图中英文、中文和公式，说明你实际看到了什么；看不清的地方明确说，不要推测。' }, ...images,
    ], source: { kind: 'user' } })])
    const visualText = visual.blocks.filter(block => block.type === 'text').map(block => block.text).join('')
    report.tests.push({ name: 'native-image-interpretation', images_delivered: images.length, text: visualText,
      pass: /Scanned/i.test(visualText) && /扫描件/.test(visualText) && /1\.414/.test(visualText) && /mc/.test(visualText) })
  } else {
  const messages = [user(`请读取 ${textPath}，然后直接用中文讲解二分查找为什么是 O(log n)。不要初始化课程，不要写文件。`)]
  let explained = false
  for (let step = 0; step < 3; step += 1) {
    const response = await call(messages, [{ name: 'professor_material_read', description: descriptor.description, parameters: descriptor.parameters }])
    messages.push(api.createAssistantMessage({ content: response.blocks, source: { kind: 'model', ...selection } }))
    const calls = response.blocks.filter(block => block.type === 'tool-call')
    if (!calls.length) {
      const text = response.blocks.filter(block => block.type === 'text').map(block => block.text).join('')
      report.tests.push({ name: 'read-then-teach', text, pass: /log|对数/.test(text) && /一半|折半|half/.test(text) && text.length > 100 })
      explained = true
      break
    }
    if (calls.length > 2) throw new Error('unexpected tool-call fanout')
    for (const block of calls) {
      if (block.name !== 'professor_material_read') throw new Error('unexpected tool')
      const args = JSON.parse(block.arguments)
      if (args.path !== textPath) throw new Error('model selected an unexpected file')
      const result = await executeTool({ ctx, agent, name: block.name, args, label: `model-${report.requests}` })
      report.tests.push({ name: 'tool-action', action: args.action ?? 'plan', pass: !result.isError })
      messages.push(api.createToolResultMessage({ callId: block.id, content: result.content, isError: result.isError === true }))
    }
  }
  if (!explained) report.tests.push({ name: 'read-then-teach', pass: false, reason: 'no teaching within three requests' })
  if (report.requests < 4) {
    const response = await call([user('合成验收：当前材料中的关键公式完全无法辨认，也没有其他来源。请解释你能确认什么、不能确认什么，不要猜测公式或声称已读懂。')])
    const text = response.blocks.filter(block => block.type === 'text').map(block => block.text).join('')
    report.tests.push({ name: 'unreadable-honesty', text, pass: /无法|不能|不清|辨认/.test(text) && !/公式是/.test(text) })
  }
  }
  report.complete = report.tests.every(test => test.pass)
  await fs.writeFile(output, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ route: report.route, requests: report.requests, complete: report.complete, report: output }))
} catch (error) {
  report.failure = 'acceptance failed; see sanitized test results, no credential or transport details retained'
  report.error_type = error?.name ?? 'Error'
  report.error_code = typeof error?.code === 'string' ? error.code : null
  report.exit_status = typeof error?.status === 'number' ? error.status : null
  // Before adapter registration, setup errors cannot contain request transport headers.
  if (['profile-setup', 'profile-install'].includes(report.stage)) report.setup_error = String(error?.message ?? '').split(key).join('[redacted]').slice(0, 1500)
  await fs.writeFile(output, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ route: report.route, requests: report.requests, complete: false, report: output }))
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  await Promise.race([ctx?.fiber?.dispose?.(), new Promise(resolve => setTimeout(resolve, 5000))])
  await fs.rm(temp, { recursive: true, force: true })
}
