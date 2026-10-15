/**
 * Syntax gate (M0).
 *
 * `node --check` parses a file without executing it, so this catches a syntax error in a file that
 * a test run might never import — a tool module behind a capability branch, or a verifier nobody
 * ran. It is deliberately a *parse* gate and not a linter: the repository has no linter dependency,
 * and adding one would be a distribution decision rather than a correctness one.
 *
 * Scope: every JavaScript file that the package ships (`src`, `test`, `tools`, the entry point and
 * the root verifier), plus the optional backup copies at the repository root are deliberately
 * excluded — they are historical artefacts, not shipped code (`tools/verify-distribution.mjs`
 * asserts they never reach the tarball).
 *
 *   node tools/verify-syntax.mjs
 */

import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.workbuddy'])

/** Every `.js`/`.mjs` under a directory, excluding dependencies and local tooling state. */
async function collect(dir) {
  const out = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      out.push(...await collect(path.join(dir, entry.name)))
      continue
    }
    if (/\.(js|mjs)$/.test(entry.name)) out.push(path.join(dir, entry.name))
  }
  return out
}

const targets = [
  path.join(ROOT, 'index.js'),
  path.join(ROOT, 'verify-plugin-skills.mjs'),
  ...await collect(path.join(ROOT, 'src')),
  ...await collect(path.join(ROOT, 'test')),
  ...await collect(path.join(ROOT, 'tools')),
]

let failures = 0
const sorted = [...new Set(targets)].sort()
for (const file of sorted) {
  const relative = path.relative(ROOT, file)
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    console.log(`PASS  ${relative}`)
  } catch (error) {
    failures += 1
    const detail = String(error.stderr ?? error.message).trim().split('\n').slice(0, 3).join(' / ')
    console.log(`FAIL  ${relative}  — ${detail}`)
  }
}

console.log(`\n${sorted.length} 个文件已解析${failures > 0 ? `，${failures} 个失败` : ''}`)
console.log(failures === 0 ? 'ALL PASS' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
