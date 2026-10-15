/**
 * `npm run verify:publication` — is the **repository** safe to publish?
 *
 * This is a different question from `tools/verify-distribution.mjs` §4, and the difference is the
 * whole point of having a second gate:
 *
 * | | npm tarball | Git repository |
 * |---|---|---|
 * | what limits the contents | `package.json#files`, a **whitelist** | `.gitignore`, an **exclusion list** |
 * | covers `professor-skills/` | yes — not in the whitelist | **no** until explicitly ignored |
 * | covers `.serena/` | yes — not in the whitelist | **no** until explicitly ignored |
 * | covers `docs/qa/` | yes — `docs/` is not shipped | **no** until explicitly ignored |
 * | what it proves | nothing leaks out of the package | nothing leaks out of `git add -A` |
 *
 * A passing `verify:dist` therefore says nothing about a `git push`. This gate closes that gap by
 * reading the exact set `git ls-files --cached --others --exclude-standard` would publish — the
 * tracked files plus the untracked ones that are not ignored — and scanning *that*.
 *
 * The rule lists (`SECRETS`, `PLACEHOLDER_USERS`) are duplicated from
 * `tools/verify-distribution.mjs` rather than extracted, so the shipped verifier keeps its exact
 * behaviour and its exact file set. `test/publication-boundary.test.mjs` fails if the two copies
 * ever drift apart.
 *
 * Test-only escape hatch: `PUBLICATION_FORCE_INCLUDE=<path>` adds a path to the set, so the red
 * path (a private file entering publication) can be exercised without staging anything. An empty
 * value disables it; nothing else honours the variable.
 *
 *   node tools/verify-publication.mjs
 *
 * @module tools/verify-publication
 */

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Directories that must never appear in the publication set. */
export const PRIVATE_PREFIXES = ['professor-skills/', '.serena/', 'docs/qa/', '.workbuddy/']

/** Path fragments that only occur inside the local personal snapshot. */
export const LEARNING_RECORD_MARKERS = [
  'Personal-Agent/00_System/PROFILE.md',
  '01_Learning/Registry/Courses/',
  '01_Learning/Knowledge/',
]

/** Text patterns that must never appear in a publishable file. Mirrors verify-distribution §4. */
export const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'an OpenAI-style API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bghp_[A-Za-z0-9]{20,}\b/, 'a GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, 'a JWT'],
  [/\/Users\/[A-Za-z0-9._-]+/, 'an absolute macOS home path'],
  [/\/home\/[A-Za-z0-9._-]+/, 'an absolute Linux home path'],
]

/** Home-directory spellings that are placeholders rather than somebody's account. */
export const PLACEHOLDER_USERS = new Set([
  'x', 'user', 'username', 'you', 'yourname', 'someone', 'example', 'me', '<user>',
])

/** File junk that must never be committed. */
const JUNK = [/^\.DS_Store$/, /\.bak-/, /\.orig$/, /~$/, /\.tgz$/, /(^|\/)node_modules\//]

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.json', '.yml', '.yaml', '.md', '.tex', '.txt', '.py', '.sh',
])

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

/** False when every home path in the text uses a placeholder account name. */
function hasRealHomePath(text) {
  for (const match of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) {
    if (!PLACEHOLDER_USERS.has(match[1])) return true
  }
  return false
}

/** The exact set `git add -A` would stage: tracked plus untracked-and-not-ignored. */
function publicationSet() {
  let listed
  try {
    listed = execFileSync(
      'git', ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: ROOT, encoding: 'utf8' },
    ).split('\n').filter(Boolean)
  } catch (error) {
    // A publication boundary is a property of a repository. Outside one this gate has nothing to
    // audit, and saying so plainly beats a raw `fatal: not a git repository` traceback.
    console.log('FAIL  not inside a git work tree — a publication boundary only exists in a repository')
    console.log(`      ${(error.stderr ?? error.message).toString().trim().split('\n')[0]}`)
    process.exit(1)
  }
  const forced = (process.env.PUBLICATION_FORCE_INCLUDE ?? '').trim()
  if (forced.length > 0 && !listed.includes(forced)) listed.push(forced)
  return listed
}

const set = publicationSet()

console.log('# 1. the publication set')
check(set.length > 0, 'the set is not empty', `${set.length} paths`)
console.log(`      source: git ls-files --cached --others --exclude-standard`
  + `${process.env.PUBLICATION_FORCE_INCLUDE ? ' + PUBLICATION_FORCE_INCLUDE' : ''}`)

console.log('\n# 2. no private directory')
const privateOffenders = set.filter((file) => PRIVATE_PREFIXES
  .some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix)))
check(privateOffenders.length === 0,
  'professor-skills/, .serena/, docs/qa/ and .workbuddy/ are absent',
  privateOffenders.slice(0, 5).join(' | '))

console.log('\n# 3. no personal profile or learning record')
const recordOffenders = set.filter((file) => LEARNING_RECORD_MARKERS.some((marker) => file.includes(marker)))
check(recordOffenders.length === 0, 'no PROFILE.md, course registry or Knowledge snapshot',
  recordOffenders.slice(0, 5).join(' | '))

console.log('\n# 4. no credentials file')
const credentialFiles = set.filter((file) => path.basename(file).startsWith('.credentials'))
check(credentialFiles.length === 0, 'no .credentials* file in the set', credentialFiles.join(' | '))

console.log('\n# 5. no secret and no real home path in publishable content')
const findings = []
for (const file of set) {
  if (!TEXT_EXTENSIONS.has(path.extname(file))) continue
  const content = await fs.readFile(path.join(ROOT, file), 'utf8').catch(() => null)
  if (content === null) continue
  for (const [pattern, reason] of SECRETS) {
    if (reason === 'an absolute macOS home path' || reason === 'an absolute Linux home path') continue
    if (pattern.test(content)) findings.push(`${file}: ${reason}`)
  }
  if (hasRealHomePath(content)) findings.push(`${file}: an absolute home path naming a real account`)
}
check(findings.length === 0, 'publishable text carries no secret and no real account path',
  findings.slice(0, 5).join(' | '))

console.log('\n# 6. no backup or junk file')
const junk = set.filter((file) => JUNK.some((pattern) => pattern.test(file)))
check(junk.length === 0, 'no .bak / .orig / ~ / .tgz / .DS_Store / node_modules', junk.slice(0, 5).join(' | '))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  verify:publication — ${set.length} paths checked`)
if (failures > 0) process.exitCode = 1
