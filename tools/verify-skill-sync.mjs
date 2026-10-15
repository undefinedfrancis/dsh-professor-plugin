/**
 * Skill synchronisation / divergence verifier.
 *
 * The six bundled skills are a deliberate distillation of the Hermes + Personal-Agent sources, so
 * byte comparison is meaningless. Instead `tools/skill-sources.json` declares, per skill, a set of
 * two-sided checks:
 *
 *   - `sourceAnchor` must still match the SOURCE file — if the upstream rule changed, the port must
 *     be re-reviewed, and this verifier fails loudly rather than drifting silently;
 *   - `pluginPattern` must match the bundled skill — if a behaviour was dropped during a refactor,
 *     this fails too.
 *
 * It also enforces the catalogue's shape: exactly the six promised skills, valid frontmatter, and
 * no excluded/legacy skill sneaking back in.
 *
 * Since Phase 1 it enforces **portability** as well, from the manifest's `portability` block: the
 * delivered prose is what the model actually reads, so a skill that tells the model to read or
 * write a Hermes / Personal-Agent location is a fresh-install failure even though it parses fine. A
 * legacy location is therefore legal only inside a `## … Optional …` section that the manifest
 * declares, and the bundled persona may not contain one at all.
 *
 * Usage:
 *   node tools/verify-skill-sync.mjs                 # sources resolved from the local machine
 *   node tools/verify-skill-sync.mjs --skill professor-notes
 *
 * A source that is not installed is reported as SKIP (the machine may not have the dependency
 * workspace); a source that exists but no longer matches is a FAIL.
 */

import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SKILLS_DIR = path.join(HERE, 'skills')
const MAP_FILE = path.join(HERE, 'tools', 'skill-sources.json')

const EXPECTED = [
  'professor-course-management',
  'professor-latex',
  'professor-notes',
  'professor-research',
  'professor-review',
  'professor-study',
]
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LEGACY_NAMES = [
  'study-session', 'notes-manage', 'courses-manage', 'latex-notes-quality',
  'web-research-evidence', 'course-manager', 'algorithm-coach', 'hermes-routing',
  'agent-handoff', 'project-discovery', 'project-orchestrator', 'project-verification',
  'safe-opencode-execution',
]

let failures = 0
let skips = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}
const skip = (label, detail) => {
  skips += 1
  console.log(`SKIP  ${label}${detail ? `  — ${detail}` : ''}`)
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const asStringArray = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [])

const args = process.argv.slice(2)
const onlyIndex = args.indexOf('--skill')
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined

const sourceMap = JSON.parse(await fs.readFile(MAP_FILE, 'utf8'))

/** Expand the placeholders the mapping uses so the file stays machine-independent. */
function expand(declared) {
  const personalAgentRoot = process.env.PERSONAL_AGENT_ROOT ?? path.join(os.homedir(), 'Personal-Agent')
  const soul = path.join(os.homedir(), '.hermes', 'profiles', 'professor', 'SOUL.md')
  const expanded = declared
    .replaceAll('${PERSONAL_AGENT_ROOT}', personalAgentRoot)
    .replaceAll('${PROFESSOR_SOUL}', soul)
  // A relative entry is a path inside the dependency workspace.
  return path.isAbsolute(expanded) ? expanded : path.join(personalAgentRoot, expanded)
}

async function readIfPresent(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

// --- catalogue shape -------------------------------------------------------
const entries = (await fs.readdir(SKILLS_DIR, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => entry.name)
  .sort()
check(
  JSON.stringify(entries) === JSON.stringify([...EXPECTED].sort()),
  'the bundle ships exactly the six Professor skills',
  entries.join(', '),
)

const strays = entries.filter((name) => LEGACY_NAMES.includes(name))
check(strays.length === 0, 'no legacy or excluded skill is bundled', strays.join(', '))

const mapped = Object.keys(sourceMap.skills).sort()
check(JSON.stringify(mapped) === JSON.stringify([...EXPECTED].sort()), 'every bundled skill has a source mapping', mapped.join(', '))

// --- per-skill checks ------------------------------------------------------
for (const name of EXPECTED) {
  if (only !== undefined && only !== name) continue
  const skillFile = path.join(SKILLS_DIR, name, 'SKILL.md')
  const content = await readIfPresent(skillFile)
  if (content === undefined) {
    check(false, `${name}: SKILL.md exists`)
    continue
  }

  // Frontmatter contract (the registry validates these too).
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(content)
  const declaredName = frontmatter === null ? undefined : /^name:\s*(\S+)\s*$/m.exec(frontmatter[1])?.[1]
  const description = frontmatter === null ? undefined : /\ndescription:\s*([\s\S]*?)(?=\n[a-z-]+:|\s*$)/.exec(frontmatter[1])?.[1]?.trim()
  check(declaredName === name, `${name}: frontmatter name matches the directory`, String(declaredName))
  check(SKILL_NAME.test(name), `${name}: kebab-case`)
  check(typeof description === 'string' && description.length > 40, `${name}: has a usable description`, `${description?.length ?? 0} chars`)

  const mapping = sourceMap.skills[name]
  const sourceTexts = []
  for (const declared of mapping.sources) {
    const file = expand(declared)
    const text = await readIfPresent(file)
    if (text === undefined) {
      skip(`${name}: source not installed`, path.basename(file))
      continue
    }
    sourceTexts.push({ file, text })
  }

  for (const item of mapping.checks) {
    const pluginPattern = new RegExp(item.pluginPattern)
    check(pluginPattern.test(content), `${name}: survives in the plugin — ${item.label}`)

    if (sourceTexts.length === 0) continue
    const anchor = new RegExp(item.sourceAnchor, 'i')
    const hit = sourceTexts.find(({ text }) => anchor.test(text))
    if (hit === undefined) {
      check(false, `${name}: upstream anchor still present — ${item.label}`,
        `/${item.sourceAnchor}/ not found; upstream changed, re-review the port`)
    }
  }

  const divergences = Array.isArray(mapping.divergences) ? mapping.divergences : []
  check(divergences.length > 0, `${name}: documents its intentional divergences`, `${divergences.length} noted`)
}

// --- portability -----------------------------------------------------------
/**
 * Split a skill into `## …` sections, so "is this legacy reference mandatory?" is answerable.
 *
 * The `## ` level is used deliberately: the operational rules live there, and a token inside a
 * deeper subsection still belongs to the top-level section that owns it.
 */
function sections(markdown) {
  const out = []
  let current = { heading: '(preamble)', lines: [] }
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading !== null) {
      out.push(current)
      current = { heading: heading[1].trim(), lines: [] }
      continue
    }
    current.lines.push(line)
  }
  out.push(current)
  return out
}

const isOptionalSection = (heading) => /optional/i.test(heading)

const portability = isPlainObject(sourceMap.portability) ? sourceMap.portability : {}
const legacyTokens = asStringArray(portability.legacyTokens)

for (const name of EXPECTED) {
  if (only !== undefined && only !== name) continue
  const content = await readIfPresent(path.join(SKILLS_DIR, name, 'SKILL.md'))
  if (content === undefined) continue

  const offenders = new Set()
  const optionals = []
  for (const section of sections(content)) {
    const body = section.lines.join('\n')
    if (isOptionalSection(section.heading)) {
      optionals.push({ heading: section.heading, body })
      continue
    }
    for (const token of legacyTokens) {
      if (body.includes(token)) offenders.add(`${token} (in "${section.heading}")`)
    }
  }
  check(offenders.size === 0, `${name}: names no legacy location outside an optional section`,
    [...offenders].join(', '))

  // A declared allowance must really exist and really be where the legacy reference lives: an
  // allowance nothing uses is a stale claim, and a legacy token in an *undeclared* optional section
  // is how a "temporary" exception becomes permanent.
  const declared = asStringArray(portability.optionalSections?.[name])
  for (const section of optionals) {
    if (!declared.includes(section.heading)) {
      check(false, `${name}: optional section is not declared in the manifest`, section.heading)
    }
  }
  for (const heading of declared) {
    const found = optionals.find((section) => section.heading === heading)
    check(found !== undefined, `${name}: the declared optional section exists`, heading)
    if (found === undefined) continue
    const uses = legacyTokens.filter((token) => found.body.includes(token))
    check(uses.length > 0, `${name}: "${heading}" really is the optional exception`, uses.join(', ') || 'no legacy token inside')
  }
}

// The persona ships with the skills and is read on every turn, so it gets no exception: a
// "constitution" that points at a folder the user does not have is the same defect as a skill that
// does, and it is the one every session sees first.
{
  const personaFile = typeof portability.personaFile === 'string' ? portability.personaFile : undefined
  if (personaFile === undefined) {
    check(false, 'the manifest declares which file carries the bundled persona')
  } else {
    const persona = await readIfPresent(path.join(HERE, personaFile))
    check(persona !== undefined, `the bundled persona (${personaFile}) is present`)
    if (persona !== undefined) {
      const hits = asStringArray(portability.personaMayNotContain).filter((token) => persona.includes(token))
      check(hits.length === 0, `${personaFile}: the persona names no legacy location`, hits.join(', '))
    }
  }
}

// --- exclusions ------------------------------------------------------------
for (const entry of sourceMap.excluded ?? []) {
  const file = expand(entry.source)
  const present = await readIfPresent(file) !== undefined
  const bundled = entries.includes(path.basename(path.dirname(entry.source)))
  if (present) check(!bundled, `excluded source stays out of the bundle: ${path.basename(path.dirname(entry.source))}`, entry.reason)
  else skip(`excluded source not installed: ${path.basename(path.dirname(entry.source))}`, entry.reason)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} 项失败`}${skips > 0 ? ` (${skips} skipped: sources not installed on this machine)` : ''}`)
process.exit(failures === 0 ? 0 : 1)
