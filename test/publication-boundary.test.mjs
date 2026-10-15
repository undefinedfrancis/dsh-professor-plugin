/**
 * The GitHub publication boundary, asserted rather than asserted-about.
 *
 * npm-tarball safety and Git-repository safety are different questions with different answers.
 * `tools/verify-distribution.mjs` §4 already proves the *tarball* carries no secret and no real
 * home path, because `package.json#files` is a whitelist that excludes `professor-skills/`,
 * `.serena/` and `docs/` entirely. Nothing about that whitelist constrains what `git add -A` would
 * stage: those three directories are ordinary untracked content, and one `git push` would publish
 * a personal profile, a real course registry, learning-state snapshots and machine-specific paths.
 *
 * So this suite pins the repository side of the boundary directly:
 *
 * - the private directories are ignored (and still on disk — exclusion is not deletion);
 * - the pre-existing ignore rules still hold;
 * - the actual publication set `git ls-files -co --exclude-standard` would publish contains
 *   neither a private path nor a real account path nor a credential;
 * - `npm run verify:publication` is the standing gate that re-checks all of it.
 *
 * @module test/publication-boundary
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Directories that must never reach a public repository. */
const PRIVATE_PATHS = ['professor-skills', '.serena', 'docs/qa']

/** Pre-existing ignore rules that must not regress. */
const PRE_EXISTING = ['.workbuddy/', 'node_modules/', '.DS_Store']

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })

/**
 * True only when this checkout *is* the work tree root.
 *
 * `tools/verify-distribution.mjs` runs this whole suite from the installed copy and requires it
 * to have "无仓库依赖" — no repository dependency. A publication boundary is a property of a git
 * repository, so outside one these cases skip rather than fail: the tarball ships `test/`, and a
 * shipped test that shells out to `git ls-files` would otherwise make `verify:dist` red for a
 * reason that has nothing to do with the distribution.
 *
 * Matching the *root* (not merely "inside some repo") also stops the suite from auditing an outer
 * repository's file list when the package happens to be installed somewhere inside one.
 */
const WORK_TREE_ROOT = (() => {
  try {
    return path.resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: ROOT, encoding: 'utf8',
    }).trim())
  } catch {
    return null
  }
})()
const IN_OWN_WORKTREE = WORK_TREE_ROOT === path.resolve(ROOT)

/** A case that only makes sense inside a git repository. */
const repoTest = (name, fn) => test(name, async (t) => {
  if (!IN_OWN_WORKTREE) {
    t.skip('the publication boundary is a property of a git repository; this copy has none')
    return
  }
  return fn(t)
})

/** True when git reports the path as ignored (exit 0) or not (exit 1). */
const isIgnored = (target) => {
  try {
    git('check-ignore', '-q', target)
    return true
  } catch (error) {
    if (error.status === 1) return false
    throw error
  }
}

repoTest('the private directories are excluded from git publication', () => {
  for (const target of PRIVATE_PATHS) {
    assert.ok(isIgnored(`${target}/publication-probe`),
      `${target} must be git-ignored even when the private directory is absent`)
  }
})

repoTest('exclusion did not delete the private originals', async (t) => {
  // Only the original workspace has private content to preserve. A public clone deliberately
  // contains neither the snapshots nor their local preservation baseline.
  const baseline = path.join(ROOT, 'docs/qa/2026-10-14-offline-release-preparation/hash-before.json')
  if (!(await fs.stat(baseline).catch(() => null))?.isFile()) {
    t.skip('no local preservation baseline; private originals are excluded from public checkouts')
    return
  }
  for (const target of PRIVATE_PATHS) {
    const stat = await fs.stat(path.join(ROOT, target)).catch(() => null)
    assert.ok(stat?.isDirectory(), `${target} must still exist on disk; ignore rules must not delete it`)
  }
  // The specific content the boundary exists to protect.
  const profile = path.join(ROOT, 'professor-skills/Personal-Agent/00_System/PROFILE.md')
  const registry = path.join(ROOT, 'professor-skills/Personal-Agent/01_Learning/Registry/COURSES.md')
  assert.ok((await fs.stat(profile).catch(() => null))?.isFile(), 'the personal profile is preserved locally')
  assert.ok((await fs.stat(registry).catch(() => null))?.isFile(), 'the course registry is preserved locally')
})

repoTest('a fresh public checkout passes without private local originals', async () => {
  const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-public-checkout-'))
  try {
    const listed = git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
      .split('\0').filter(Boolean)
    for (const relative of new Set(listed)) {
      const source = path.join(ROOT, relative)
      if (!(await fs.stat(source).catch(() => null))?.isFile()) continue
      const destination = path.join(copy, relative)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(source, destination)
    }
    execFileSync('git', ['init', '-q'], { cwd: copy })
    const childEnv = { ...process.env }
    delete childEnv.NODE_TEST_CONTEXT
    const help = execFileSync(process.execPath, ['tools/verify-m2b-model.mjs', '--help'], {
      cwd: copy, env: childEnv, encoding: 'utf8',
    })
    assert.match(help, /--evidence-dir=/, 'the public checkout must contain an executable model validator')
    const output = execFileSync(process.execPath, [
      '--test', '--test-name-pattern=^(the private directories are excluded|exclusion did not delete the private originals|the preserved probe records recompute)',
      'test/publication-boundary.test.mjs', 'test/source-grounded-host-tools.test.mjs',
    ], { cwd: copy, env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.match(output, /fail 0/)
  } finally {
    await fs.rm(copy, { recursive: true, force: true })
  }
})

test('the model validator refuses to overwrite an existing readiness record', async () => {
  const evidence = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-readiness-preservation-'))
  try {
    const file = path.join(evidence, 'model-readiness.json')
    const original = '{"historical":"preserve these bytes"}\n'
    await fs.writeFile(file, original)
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    let failure
    try {
      execFileSync(process.execPath, ['tools/verify-m2b-model.mjs', `--evidence-dir=${evidence}`], {
        cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) { failure = error }
    assert.ok(failure, 'an existing readiness record must block before host startup')
    assert.match(String(failure.stderr), /readiness output already exists/)
    assert.equal(await fs.readFile(file, 'utf8'), original)
  } finally {
    await fs.rm(evidence, { recursive: true, force: true })
  }
})

repoTest('the pre-existing ignore rules still hold', () => {
  for (const target of PRE_EXISTING) assert.ok(isIgnored(target), `${target} must remain ignored`)
  assert.ok(isIgnored('some.bak-20260930-152316'), '*.bak-* backups must remain ignored')
  assert.ok(isIgnored('package.tgz'), '*.tgz tarballs must remain ignored')
  assert.ok(isIgnored('.env'), '.env must remain ignored')
})

repoTest('the publication set contains no private path', () => {
  const published = git('ls-files', '-co', '--exclude-standard').trim().split('\n').filter(Boolean)
  assert.ok(published.length > 0, 'the publication set must not be empty — an empty set would pass every scan')
  const offenders = published.filter((file) => PRIVATE_PATHS
    .some((prefix) => file === prefix || file.startsWith(`${prefix}/`)))
  assert.deepEqual(offenders, [], `these paths would be published:\n  ${offenders.join('\n  ')}`)
})

repoTest('the publication set carries no personal learning record, real home path or credential', async () => {
  const published = git('ls-files', '-co', '--exclude-standard').trim().split('\n').filter(Boolean)
  const forbiddenPathMarkers = [
    'Personal-Agent/00_System/PROFILE.md',
    '01_Learning/Registry/Courses/',
    '01_Learning/Knowledge/',
  ]
  const pathOffenders = published.filter((file) => forbiddenPathMarkers.some((marker) => file.includes(marker)))
  assert.deepEqual(pathOffenders, [], `learning records would be published:\n  ${pathOffenders.join('\n  ')}`)

  // A credentials *file* must never be in the set. Naming the file in a comment is not a leak —
  // the gated runner legitimately documents that it reads one — so this is a path check, not a
  // content pattern.
  const credentialFiles = published.filter((file) => path.basename(file).startsWith('.credentials'))
  assert.deepEqual(credentialFiles, [], `a credentials file would be published:\n  ${credentialFiles.join('\n  ')}`)

  // Content scan, not just path scan: a credential or a real account path in a publishable file.
  const placeholderUsers = new Set(['x', 'user', 'username', 'you', 'yourname', 'someone', 'example', 'me', '<user>'])
  const secrets = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
    [/\bsk-[A-Za-z0-9]{20,}\b/, 'an OpenAI-style API key'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
    [/\bghp_[A-Za-z0-9]{20,}\b/, 'a GitHub token'],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
    [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, 'a JWT'],
  ]
  const textExtensions = new Set(['.js', '.mjs', '.json', '.yml', '.yaml', '.md', '.tex', '.txt', '.py', '.sh'])
  const findings = []
  for (const file of published) {
    if (!textExtensions.has(path.extname(file))) continue
    const content = await fs.readFile(path.join(ROOT, file), 'utf8').catch(() => null)
    if (content === null) continue
    for (const [pattern, reason] of secrets) {
      if (pattern.test(content)) findings.push(`${file}: ${reason}`)
    }
    for (const match of content.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) {
      if (!placeholderUsers.has(match[1])) findings.push(`${file}: a real home path naming "${match[1]}"`)
    }
  }
  assert.deepEqual(findings, [], `publishable content leaks private data:\n  ${findings.slice(0, 20).join('\n  ')}`)
})

repoTest('the standing publication gate is wired into package.json and passes', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.scripts?.['verify:publication'],
    'package.json must expose npm run verify:publication so the boundary is checkable on demand')

  const output = execFileSync('node', ['tools/verify-publication.mjs'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, PUBLICATION_FORCE_INCLUDE: '' },
  })
  assert.ok(!/^FAIL/m.test(output), `verify:publication reported failures:\n${output}`)
  assert.match(output, /PASS/, 'the gate must print positive results, not silence')
})

repoTest('the publication gate fails when a private path is forced into the set', () => {
  let output = ''
  let status = 0
  try {
    output = execFileSync('node', ['tools/verify-publication.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PUBLICATION_FORCE_INCLUDE: 'professor-skills/Personal-Agent/00_System/PROFILE.md' },
    })
  } catch (error) {
    status = error.status
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  assert.notEqual(status, 0, 'the gate must exit non-zero when a private file enters the set')
  assert.match(output, /FAIL/, `expected a FAIL line, got:\n${output}`)
})

repoTest('the two secret rule lists have not drifted apart', async () => {
  // `verify-publication.mjs` deliberately duplicates `verify-distribution.mjs`'s SECRETS block so
  // the shipped tarball verifier keeps its exact behaviour and file set. Duplication is only safe
  // if something notices when the two stop agreeing.
  const blockOf = async (file) => {
    const source = await fs.readFile(path.join(ROOT, file), 'utf8')
    const start = source.indexOf('const SECRETS = [')
    assert.notEqual(start, -1, `${file} must declare SECRETS`)
    const end = source.indexOf('\n]', start)
    assert.notEqual(end, -1, `${file} SECRETS block must be closed`)
    return source.slice(start, end + 2)
  }
  const distribution = await blockOf('tools/verify-distribution.mjs')
  const publication = await blockOf('tools/verify-publication.mjs')
  assert.equal(publication, distribution,
    'tools/verify-publication.mjs SECRETS must match tools/verify-distribution.mjs exactly')
})
