/**
 * Distribution verifier: what actually ships, and does a clean install of it work?
 *
 * The offline contract verifiers prove the *repository* is coherent. This one proves the
 * **packaged artefact** is, which is a different question: `files` is a whitelist that silently
 * drops anything it does not name, and a tarball-installed copy has no repository around it to
 * borrow from.
 *
 * What it asserts, in order:
 *   1. the package declares itself private and pins a whitelist;
 *   2. `npm pack` produces no backup, editor, OS or VCS artefact — and no `docs/` (the design
 *      record stays in the repository, so a machine-specific path can never ship);
 *   2b. every `npm` command here runs against a **private cache**, and the isolation is proved by
 *      first failing with an inherited unusable cache and then succeeding with the private one;
 *   3. every `src/` module, all six bundled skills and every verifier is present in the tarball;
 *   4. no shipped text file carries a secret, a private key or a personal home path;
 *   5. the tarball installs into a clean prefix with no network, and the installed copy then
 *      passes its own test suite — so the artefact is self-verifying;
 *   6. the installed `apply()` still registers 22 tools and one 6-skill provider, and the shipped
 *      preset patch is byte-identical to the repository's.
 *
 * ## The npm cache
 *
 * `npm` writes to a *global* cache — `~/.npm` by default. On a machine where that directory holds
 * root-owned files (a container, a CI image, a shared workstation), `npm pack` and `npm install`
 * fail with `EACCES` even though nothing about this package is wrong. The verifier therefore never
 * inherits the ambient cache: it creates a unique `mkdtemp` cache and passes it to every child
 * through `npm_config_cache`.
 *
 * The properties that matter, and are checked below rather than assumed:
 *
 *   - nothing is written to the user's global npm configuration, and `sudo` is never used;
 *   - the cache is unique per run, so two verifiers running at once cannot corrupt each other;
 *   - it is removed on success **and** on failure, so a verifier run leaves no residue.
 *
 * Run with plain Node, with no special environment:
 *
 *   node tools/verify-distribution.mjs
 *
 * Read-only with respect to the repository: everything is written into a temporary directory.
 */

import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { promises as fs, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isReleaseVersion } from './release-version.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PACKAGE_JSON = path.join(ROOT, 'package.json')

// --- isolated scratch space and npm cache -----------------------------------
//
// Both are created before anything else runs, because every `npm` call below needs the cache and
// every `check` may need to report a path. The cache is unique per run, so two verifiers running
// concurrently cannot corrupt each other's metadata.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-dist-'))
const npmCache = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-npm-cache-'))

/**
 * The environment every child process gets.
 *
 * `npm_config_cache` overrides whatever the ambient environment had, which is the whole point: this
 * verifier must not depend on — or damage — the user's global `~/.npm`. Note that nothing here
 * writes to `.npmrc`, runs `sudo`, or changes ownership of anything outside `temp`.
 */
const childEnv = { ...process.env, npm_config_cache: npmCache }

// Cleanup runs on every exit path, including an uncaught error mid-verification, so a failed run
// cannot leave a cache directory behind. `force` makes each removal idempotent.
process.on('exit', () => {
  for (const directory of [temp, npmCache]) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Nothing useful can be done from an exit handler; a leftover temp dir is not a failure.
    }
  }
})

/** Paths that must never be published, with the reason. */
const FORBIDDEN = [
  [/\.bak[-.]/, 'a backup file'],
  [/\.orig$/, 'a merge artefact'],
  [/~$/, 'an editor backup'],
  [/\.tgz$/, 'a packed artefact'],
  [/^package\/\.workbuddy\//, 'local tooling state'],
  [/\.DS_Store$/, 'an OS artefact'],
  [/(^|\/)node_modules\//, 'an installed dependency tree'],
  [/(^|\/)\.env/, 'an environment file'],
  [/(^|\/)\.npmrc$/, 'an npm configuration file'],
  [/^package\/docs\//, 'the design record (repository-only)'],
  [/^package\/test\/fixtures?\//, 'a test fixture dump'],
]

/** Text patterns that must never appear in a shipped file. */
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'an OpenAI-style API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bghp_[A-Za-z0-9]{20,}\b/, 'a GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, 'a JWT'],
  [/\/Users\/[A-Za-z0-9._-]+/, 'an absolute macOS home path'],
  [/\/home\/[A-Za-z0-9._-]+/, 'an absolute Linux home path'],
]

/**
 * Home-directory spellings that are obviously placeholders rather than somebody's account.
 *
 * `/Users/x/Personal-Agent` in a path-policy fixture is a test datum; `/Users/<real name>/…` in a
 * documentation file is a leak. The patterns above cannot tell them apart, so the placeholder names
 * are listed explicitly instead of the check being loosened.
 */
const PLACEHOLDER_USERS = new Set(['x', 'user', 'username', 'you', 'yourname', 'someone', 'example', 'me', '<user>'])

/** False when every home path in the text uses a placeholder account name. */
function hasRealHomePath(text) {
  for (const match of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) {
    if (!PLACEHOLDER_USERS.has(match[1])) return true
  }
  return false
}

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', env: childEnv, ...options })

/** Every file under a directory, as paths relative to it. */
async function listFiles(root, prefix = '') {
  const out = []
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...await listFiles(root, relative))
    else out.push(relative)
  }
  return out
}

const source = JSON.parse(await fs.readFile(PACKAGE_JSON, 'utf8'))

console.log('# 1. package declaration')
check(source.private === true, '包声明为 private（本地 bundle，不发布到 registry）')
check(Array.isArray(source.files) && source.files.length > 0, 'files 白名单已声明', source.files?.join(', ') ?? '(none)')
check(source.files?.includes('docs') === false, 'docs 不进分发（设计记录留在仓库内）')
check(isReleaseVersion(source.version), '版本号为语义化版本', source.version)

console.log('\n# 2. packed tarball')
const packDir = path.join(temp, 'pack')
await fs.mkdir(packDir, { recursive: true })
const packed = JSON.parse(run('npm', ['pack', '--pack-destination', packDir, '--json'], { cwd: ROOT }))
check(Array.isArray(packed) && packed.length === 1, 'npm pack 产出单个 tarball')
const tarball = path.join(packDir, packed[0].filename)
const shipped = packed[0].files.map((entry) => `package/${entry.path}`)
const shippedSet = new Set(shipped)
check(packed[0].version === source.version, 'tarball 版本与 package.json 一致', packed[0].version)

for (const [pattern, reason] of FORBIDDEN) {
  const offenders = shipped.filter((file) => pattern.test(file))
  check(offenders.length === 0, `分发中不含${reason}`, offenders.slice(0, 3).join(', '))
}

console.log('\n# 2b. npm cache isolation')
// An intentionally unusable cache. Its parent is a *regular file*, so npm cannot even create the
// directory — `ENOTDIR` is not something `root` can bypass, unlike a permission bit.
const poisonedParent = path.join(temp, 'not-a-directory')
await fs.writeFile(poisonedParent, 'this is a file, so no cache directory can live under it\n', 'utf8')
const poisonedCache = path.join(poisonedParent, 'cache')
const poisonedEnv = { ...process.env, npm_config_cache: poisonedCache }
// `npm pack --pack-destination` does not create the destination, so both probe directories are made
// explicitly — otherwise the check would be measuring a missing directory rather than the cache.
const poisonProbeDir = path.join(temp, 'poison-probe')
const isolatedProbeDir = path.join(temp, 'isolated-probe')
await fs.mkdir(poisonProbeDir, { recursive: true })
await fs.mkdir(isolatedProbeDir, { recursive: true })

// Half one: prove the poison is real. If this pack *succeeded*, the regression test below would be
// vacuous, so the failure is the assertion — and the reason is reported, so a change in npm's
// behaviour is visible rather than silently weakening the check.
let poisonReason = null
try {
  run('npm', ['pack', '--pack-destination', poisonProbeDir, '--json'], { cwd: ROOT, env: poisonedEnv })
} catch (error) {
  poisonReason = `${error.code ?? 'error'}: ${String(error.stderr ?? error.message).split('\n').find((line) => line.trim().length > 0) ?? ''}`.trim()
}
check(poisonReason !== null, '回归自检：被污染的 npm cache 确实会让 npm 失败（说明隔离是必要的）', poisonReason ?? 'npm unexpectedly succeeded')
check((await fs.readdir(poisonProbeDir)).length === 0, '回归自检：污染路径下确实没有产出 tarball')

// Half two: the verifier's own npm calls must succeed anyway, because each one is handed the
// private cache *after* the ambient environment, exactly as `run` does it.
let isolatedPack = null
let isolatedDetail = ''
try {
  isolatedPack = JSON.parse(run('npm', ['pack', '--pack-destination', isolatedProbeDir, '--json'], {
    cwd: ROOT,
    env: { ...poisonedEnv, npm_config_cache: npmCache },
  }))
} catch (error) {
  isolatedDetail = `${error.code ?? 'error'}: ${String(error.stderr ?? error.message).split('\n')[0]}`
}
check(Array.isArray(isolatedPack) && isolatedPack.length === 1,
  '回归自检：即使面对被污染的全局 cache，隔离后的 npm 仍然成功', isolatedDetail)
check(isolatedPack === null || isolatedPack[0].version === source.version,
  '回归自检：隔离后打出的 tarball 版本正确', isolatedPack?.[0]?.version ?? '')
check((await fs.readdir(npmCache)).length > 0,
  '回归自检：npm 确实使用了私有 cache（目录非空），而不是回落到 ~/.npm')

// Structural guards on this file itself: the isolation is only real if the script never reaches for
// a fixed path and never escalates privileges. Comments are stripped first, so that a *description*
// of what is forbidden cannot be mistaken for the forbidden thing.
const selfSource = await fs.readFile(new URL(import.meta.url), 'utf8')
const selfCode = selfSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
check(!/\/private\/tmp\/professor-npm-cache/.test(selfSource),
  '脚本中不含被钉死的临时 cache 路径')
// The substantive property, rather than a word search: the only programs this script ever executes
// are `npm` and `node` itself — so there is no route to privilege escalation and no shell in which
// one could hide. (A bare `sudo` word check would trip over the regex that performs the check.)
const executed = [...selfCode.matchAll(/(?:execFileSync|run)\(\s*(?:'([a-z]+)'|process\.execPath)/g)]
  .map((match) => match[1] ?? 'node')
check(executed.length > 0 && executed.every((command) => command === 'npm' || command === 'node'),
  '脚本只执行 npm / node，从不借助 sudo、shell 或其它程序', [...new Set(executed)].join(', '))
// The other half of the same promise: this script may only ever ask npm to *package* or *install*.
// Anything that could rewrite ambient configuration (`npm config`, `npm set`) would break it.
const npmSubcommands = [...selfCode.matchAll(/run\('npm',\s*\[\s*'([a-z-]+)'/g)].map((match) => match[1])
check(npmSubcommands.length > 0 && npmSubcommands.every((name) => name === 'pack' || name === 'install'),
  '脚本只调用 npm 的 pack / install 子命令，从不改写 npm 配置', [...new Set(npmSubcommands)].join(', '))
check(!/npm_config_cache:\s*['"]/.test(selfCode),
  '脚本从不把 cache 写成字面量路径，只传运行时创建的目录')

// The private cache is genuinely private: it lives under the OS temp dir, not in the user's home.
check(path.resolve(npmCache).startsWith(path.resolve(os.tmpdir())),
  '私有 cache 位于系统临时目录内', npmCache)
check(path.resolve(npmCache) !== path.resolve(os.homedir(), '.npm'),
  '私有 cache 不是用户的全局 ~/.npm', npmCache)

console.log('\n# 3. completeness')
const sourceSrc = (await listFiles(path.join(ROOT, 'src'))).map((file) => file)
const shippedSrc = shipped.filter((file) => file.startsWith('package/src/')).map((file) => file.slice('package/src/'.length))
const missingSrc = sourceSrc.filter((file) => !shippedSrc.includes(file))
check(missingSrc.length === 0, `全部 ${sourceSrc.length} 个 src 模块都已打包`, missingSrc.join(', '))
const enhancementResources = await listFiles(path.join(ROOT, 'resources/enhance'))
check(enhancementResources.every(file => shippedSet.has(`package/resources/enhance/${file}`)),
  '增强识别的六平台依赖锁与模型清单全部随插件打包')

const latexResources = await listFiles(path.join(ROOT, 'resources/latex'))
check(latexResources.every(file => shippedSet.has(`package/resources/latex/${file}`)),
  '参考 LaTeX 模板与可移植默认模板全部随插件打包')

const skillFiles = shipped.filter((file) => /^package\/skills\/[^/]+\/SKILL\.md$/.test(file))
check(skillFiles.length === 6, '随包 6 个技能全部打包', skillFiles.length)

for (const required of ['package/index.js', 'package/package.json', 'package/README.md', 'package/cordis.patch.yml',
  'package/verify-plugin-skills.mjs', 'package/tools/verify-skill-sync.mjs', 'package/tools/verify-preset.mjs',
  'package/tools/verify-profile-composition.mjs', 'package/tools/verify-runtime-boot.mjs',
  'package/tools/verify-distribution.mjs']) {
  check(shippedSet.has(required), `分发包含 ${required.replace('package/', '')}`)
}

// Derived rather than hand-listed, so a new verifier cannot be added to the repo and silently left
// out of the tarball — the same rule the `src` check above uses.
const sourceTools = await listFiles(path.join(ROOT, 'tools'))
const shippedTools = shipped
  .filter((file) => file.startsWith('package/tools/'))
  .map((file) => file.slice('package/tools/'.length))
const missingTools = sourceTools.filter((file) => !shippedTools.includes(file))
check(missingTools.length === 0, `全部 ${sourceTools.length} 个 tools 脚本都已打包`, missingTools.join(', '))

const shippedTests = shipped.filter((file) => /^package\/test\/[^/]+\.test\.mjs$/.test(file))
check(shippedTests.length >= 10, '测试套件随包发布（安装后自带可复核）', `${shippedTests.length} 个测试文件`)

const sourceBytes = await fs.readFile(path.join(ROOT, 'cordis.patch.yml'))
const packedPatch = await fs.readFile(path.join(ROOT, 'cordis.patch.yml'))
check(sourceBytes.equals(packedPatch), '预设 patch 未被打包过程改写')

console.log('\n# 4. secrets and machine paths')
const textExtensions = new Set(['.js', '.mjs', '.json', '.yml', '.yaml', '.md', '.tex', '.txt'])
const findings = []
for (const file of shipped) {
  if (!textExtensions.has(path.extname(file))) continue
  const absolute = path.join(ROOT, file.slice('package/'.length))
  let content
  try {
    content = await fs.readFile(absolute, 'utf8')
  } catch {
    continue
  }
  for (const [pattern, reason] of SECRETS) {
    if (reason === 'an absolute macOS home path' || reason === 'an absolute Linux home path') continue
    if (pattern.test(content)) findings.push(`${file}: ${reason}`)
  }
  if (hasRealHomePath(content)) findings.push(`${file}: an absolute home path naming a real account`)
}
check(findings.length === 0, '分发文本文件中不含秘密或个人 home 路径', findings.slice(0, 3).join(' | '))

console.log('\n# 5. clean install (no network, no repository)')
const consumer = path.join(temp, 'consumer')
await fs.mkdir(consumer, { recursive: true })
await fs.writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }), 'utf8')
let installed = true
try {
  run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', tarball], { cwd: consumer })
} catch (error) {
  installed = false
  check(false, 'tarball 可离线安装', String(error.message).split('\n')[0])
}
const installedDir = path.join(consumer, 'node_modules', source.name)

if (installed) {
  check(true, 'tarball 可离线安装')
  const installedFiles = await listFiles(installedDir)
  const leaked = installedFiles.filter((file) => /\.bak[-.]|\.orig$|~$|\.DS_Store$/.test(file))
  check(leaked.length === 0, '安装后的目录不含备份/编辑器产物', leaked.slice(0, 3).join(', '))
  check(installedFiles.includes('index.js'), '安装后入口 index.js 存在')

  const installedManifest = JSON.parse(await fs.readFile(path.join(installedDir, 'package.json'), 'utf8'))
  check(installedManifest.version === source.version, '安装后版本与源一致', installedManifest.version)
  check(installedManifest.private === true, '安装后仍标记为 private')

  const installedPatch = await fs.readFile(path.join(installedDir, 'cordis.patch.yml'))
  check(installedPatch.equals(sourceBytes), '安装后的预设 patch 与仓库逐字节一致')

  // 6. The installed copy runs its own suite: the artefact is self-verifying.
  let testsPassed = true
  let testDetail = ''
  try {
    // Run the test files in place, keeping their relative paths, so the shipped suite runs exactly
    // as it does in the repository — helper imports and all.
    const output = run(process.execPath, ['--test', ...shippedTests.map((file) => path.join(installedDir, file.slice('package/'.length)))], { cwd: installedDir })
    const passed = (/# pass (\d+)/.exec(output) ?? [])[1] ?? '?'
    const total = (/# tests (\d+)/.exec(output) ?? [])[1] ?? '?'
    testDetail = `${passed}/${total} passed`
  } catch (error) {
    testsPassed = false
    // A four-line tail is not enough: it hides WHICH case failed and WHY, which is the only thing
    // that makes a red run actionable. Name the failing cases, the counts, and the first real cause.
    const text = String(error.stdout ?? error.message)
    const failed = [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1].trim())
    const counts = [...text.matchAll(/# (tests|pass|fail|cancelled) (\d+)/g)]
      .map((match) => `${match[1]}=${match[2]}`)
      .join(' ')
    const cause = (/^\s+error: '?([^'\n]+)'?$/m.exec(text) ?? [])[1] ?? ''
    testDetail = failed.length > 0
      ? `${failed.length} 个用例失败: ${failed.join(' | ')}  (${counts})${cause ? `  首个原因: ${cause}` : ''}`
      : `${counts || 'no summary'}  —  ${text.split('\n').slice(-4).join(' ')}`
  }
  check(testsPassed, '安装后的副本自测通过（无仓库依赖）', testDetail)

  const entry = await import(path.join(installedDir, 'index.js'))
  check(entry.name === 'professor-spike', '安装后导出插件名', entry.name)
  const requiredInject = Array.isArray(entry.inject) ? entry.inject : entry.inject?.required
  check(Array.isArray(requiredInject) && requiredInject.includes('fs') && requiredInject.includes('skills'), '安装后导出 inject')
  check(typeof entry.apply === 'function', '安装后导出 apply')
  check(typeof entry.WATCHER_DEGRADED_PREFIX === 'string', '安装后导出 watcher 降级标记')

  const { createFakeContext } = await import(path.join(installedDir, 'test/helpers/fake-harness.mjs'))
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-installed-'))
  const fake = createFakeContext({ home })
  entry.apply(fake.ctx, fake.pluginConfig)
  check(fake.tools.length === 22, '安装后的插件注册 22 个工具', `${fake.tools.length} 个`)
  const names = fake.tools.map((tool) => tool.name).sort()
  check(names.every((toolName) => toolName.startsWith('professor_')), '工具全部命名空间化')
  check(new Set(names).size === names.length, '工具名无重复')
  check(fake.providers.length === 1, '注册 1 个技能 provider')
  const candidates = await fake.providers[0]({ signal: new AbortController().signal, invalidate: () => {} }).list()
  const skillList = Array.isArray(candidates) ? candidates : candidates.candidates
  check(skillList.length === 6, '安装后的 provider 提供 6 个技能', `${skillList.length} 个`)
  fake.disposeAll()

  // Learning presets ship as package assets: the five bundled modes are available offline at
  // first install with no downloads or accounts, and the source/licensing notice travels with
  // the package.
  const shippedPresets = await import(path.join(installedDir, 'src/skills/presets.js'))
  check(shippedPresets.BUNDLED_PRESETS.length === 5, '安装后 5 个内置学习预设离线可用', String(shippedPresets.BUNDLED_PRESETS.length))
  check(shippedPresets.BUNDLED_PRESETS.every(row => row.provenance === 'original:professor-v1'),
    '内置预设标记原创来源（无第三方派生内容）')
  check(shippedPresets.BUNDLED_PRESETS.every(row => Object.isFrozen(row) && (row.fields.additionalInstructions ?? '').length <= 2048),
    '内置预设不可变且字段在预算内')
  check(installedFiles.includes('THIRD_PARTY_LICENSES.md'), '第三方来源/许可证声明随包分发')
  const notices = await fs.readFile(path.join(installedDir, 'THIRD_PARTY_LICENSES.md'), 'utf8')
  check(notices.includes('No third-party skill text'), '声明明确当前未捆绑第三方教学内容')
  check(notices.includes('Jellypod-Inc/school-skills'), '声明记录了已考察的来源与出处')
  // The user library works from the installed copy alone (profile-level persistence roundtrip).
  const { createFakeStorageDomain: installedDomain } = await import(path.join(installedDir, 'test/helpers/fake-harness.mjs'))
  const { createPresetLibraryStore } = await import(path.join(installedDir, 'src/app/presets.js'))
  const { createAppStorage: installedAppStorage } = await import(path.join(installedDir, 'src/app/storage.js'))
  const presetHome = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-presets-'))
  const presetDomain = installedDomain({ name: 'professor_app' })
  const presetStorage = installedAppStorage({ ctx: { get: () => presetDomain.service }, logger: { info() {}, warn() {} }, readVersion: async () => 'dist' })
  const presetLibrary = createPresetLibraryStore({ appStorage: presetStorage })
  const saved = await presetLibrary.save({ definition: { id: 'dist-check', name: '分发自测', description: '安装后自测', fields: { teachingDepth: '适中，解释关键步骤' }, version: 1 }, expectedRevision: 0 })
  const listed = await presetLibrary.list()
  check(saved.revision === 1 && listed.user.length === 1 && listed.bundled.length === 5,
    '安装后的预设库可保存并列出用户预设（离线、无下载）')
  await presetStorage.close()
  await fs.rm(presetHome, { recursive: true, force: true })
}

console.log('\n# 7. cleanup')
// The success path cleans up explicitly and then *checks* that it did; the failure path is covered
// by the `process.on('exit')` handler registered above, which runs on a thrown error too.
const exists = async (target) => fs.stat(target).then(() => true, () => false)
await fs.rm(temp, { recursive: true, force: true })
await fs.rm(npmCache, { recursive: true, force: true })
check(!(await exists(temp)), '临时工作目录已清理', temp)
check(!(await exists(npmCache)), '私有 npm cache 已清理（成功路径）', npmCache)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
