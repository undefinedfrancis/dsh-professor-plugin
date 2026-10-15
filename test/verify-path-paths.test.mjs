/**
 * The URL→filesystem path bug, caught two ways.
 *
 * `path.dirname(new URL(import.meta.url).pathname)` is wrong in a way that is invisible on a
 * normal checkout. `.pathname` is the **percent-encoded** URL path, so a repository living at
 * `/tmp/professor review path/` yields `/tmp/professor%20review%20path` — a directory that does not
 * exist. The verifier then either throws `ENOENT` or, worse, walks an empty tree and reports its
 * checks as passing over zero files. A Chinese character is the same failure with UTF-8 percent
 * encoding. `fileURLToPath()` is the conversion that decodes back to the real filesystem path.
 *
 * Both halves matter:
 *
 * 1. a **static** scan, so a future file cannot reintroduce the pattern;
 * 2. a **dynamic** run of the real verification entry points from a disposable copy whose path
 *    contains **both** a space and Chinese characters. Testing a helper is not enough — the point
 *    is that the actual scripts, with their actual `ROOT` derivations, resolve correctly.
 *
 * The dynamic half also guards the second-order failure: a verifier that "passes" because it found
 * nothing. The parsed-file count is compared against an independent walk of the copy, so an empty
 * scan cannot look like success.
 *
 * @module test/verify-path-paths
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// Keep test-generated evidence outside the checkout: host verifiers fingerprint source trees,
// and a public checkout deliberately has no private QA evidence directory.
const EVIDENCE_PATH = process.env.PROFESSOR_PATH_EVIDENCE
  ?? path.join(os.tmpdir(), `professor-path-verification-${process.pid}.json`)

/** Directories whose source must not derive a path from a URL pathname. */
const SCAN_DIRS = ['tools', 'test', 'src', 'client', 'docs/qa']

/** The real verification entry points exercised from the spaced/Chinese copy. */
const VERIFIERS = [
  { script: 'tools/verify-syntax.mjs', reportsCount: true },
  { script: 'verify-plugin-skills.mjs', reportsCount: false },
  { script: 'tools/verify-skill-sync.mjs', reportsCount: false },
]

const SKIP_DIRS = new Set(['node_modules', '.git', '.workbuddy'])

/** Every `.js`/`.mjs` under `dir`, excluding dependencies and local tooling state. */
async function collect(dir) {
  const out = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...await collect(path.join(dir, entry.name)))
      continue
    }
    if (/\.(js|mjs)$/.test(entry.name)) out.push(path.join(dir, entry.name))
  }
  return out
}

test('no source derives a filesystem path from a URL pathname', async () => {
  const offenders = []
  for (const dir of SCAN_DIRS) {
    for (const file of await collect(path.join(ROOT, dir))) {
      const lines = (await fs.readFile(file, 'utf8')).split('\n')
      lines.forEach((line, index) => {
        // Strip quoted string contents first: a test may legitimately *assert* that some source
        // does not contain the pattern, and only executable code can reintroduce the defect.
        const code = line
          .replace(/'(?:\\.|[^'\\])*'/g, "''")
          .replace(/"(?:\\.|[^"\\])*"/g, '""')
          .replace(/`(?:\\.|[^`\\])*`/g, '``')
        if (!code.includes('import.meta.url')) return
        if (!code.includes('.pathname')) return
        // Prose may also quote the buggy pattern in order to explain it.
        const trimmed = line.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
        offenders.push(`${path.relative(ROOT, file)}:${index + 1}: ${trimmed}`)
      })
    }
  }
  assert.deepEqual(offenders, [],
    `these lines percent-encode the filesystem path and break in a spaced/Chinese checkout:\n`
    + `  ${offenders.join('\n  ')}`)
})

test('the real verifiers run from a copy whose path has a space and Chinese characters', async (t) => {
  // The copy is enumerated with `git ls-files`, so this case only exists inside a work tree.
  // `tools/verify-distribution.mjs` runs the shipped suite from the installed copy, where there is
  // no repository — the static case above still runs there and still catches the defect.
  let listed = []
  try {
    listed = execFileSync(
      'git', ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: ROOT, encoding: 'utf8' },
    ).split('\n').filter(Boolean)
  } catch {
    t.skip('no git work tree to enumerate; the static case still covers this file')
    return
  }

  const prefix = path.join(await fs.realpath(os.tmpdir()), 'professor 中文 检查 path ')
  const copyRoot = await fs.mkdtemp(prefix)
  const evidence = { copy_path: copyRoot, copy_removed: false, runs: [] }

  try {
    assert.ok(copyRoot.includes(' '), 'the disposable copy must contain a space')
    assert.match(copyRoot, /[一-鿿]/, 'the disposable copy must contain a Chinese character')

    // Copy exactly the publication set — the same files a fresh checkout would have.
    for (const rel of listed) {
      const source = path.join(ROOT, rel)
      const stat = await fs.stat(source).catch(() => null)
      if (stat === null || !stat.isFile()) continue
      const destination = path.join(copyRoot, rel)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(source, destination)
    }

    // Independent expectation: what the syntax gate *should* parse in this copy.
    const expectedFiles = new Set([
      path.join(copyRoot, 'index.js'),
      path.join(copyRoot, 'verify-plugin-skills.mjs'),
      ...await collect(path.join(copyRoot, 'src')),
      ...await collect(path.join(copyRoot, 'test')),
      ...await collect(path.join(copyRoot, 'tools')),
    ])
    assert.ok(expectedFiles.size > 0, 'the copy must contain source — an empty copy would pass every scan')

    for (const verifier of VERIFIERS) {
      let stdout = ''
      let exitCode = 0
      try {
        stdout = execFileSync(process.execPath, [verifier.script], {
          cwd: copyRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
        })
      } catch (error) {
        exitCode = error.status ?? 1
        stdout = `${error.stdout ?? ''}${error.stderr ?? ''}`
      }
      const run = { script: verifier.script, exit_code: exitCode }
      if (verifier.reportsCount) {
        const parsed = Number(/(\d+)\s+个文件已解析/.exec(stdout)?.[1] ?? Number.NaN)
        run.parsed_files = parsed
        assert.equal(exitCode, 0,
          `${verifier.script} failed from ${copyRoot}:\n${stdout.split('\n').slice(-6).join('\n')}`)
        assert.ok(Number.isFinite(parsed) && parsed > 0,
          `the syntax gate reported ${JSON.stringify(parsed)} files — a percent-encoded ROOT `
          + 'resolves to a directory that does not exist, and an empty scan is not a pass')
        assert.equal(parsed, expectedFiles.size,
          `the syntax gate parsed ${parsed} files but the copy holds ${expectedFiles.size}`)
      } else {
        assert.equal(exitCode, 0,
          `${verifier.script} failed from ${copyRoot}:\n${stdout.split('\n').slice(-6).join('\n')}`)
        assert.ok(!/^FAIL/m.test(stdout),
          `${verifier.script} reported failures from the spaced/Chinese copy:\n${stdout}`)
      }
      evidence.runs.push(run)
    }

    await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true })
    await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`)
    t.diagnostic(`evidence: ${path.relative(ROOT, EVIDENCE_PATH)}`)
  } finally {
    await fs.rm(copyRoot, { recursive: true, force: true })
    evidence.copy_removed = true
    if (evidence.runs.length > 0) {
      await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true })
      await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`)
    }
  }
})
