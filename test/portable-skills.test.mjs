/**
 * Phase 1 (M1) — self-contained identity: the shipped skills and the bundled persona must not
 * direct a *mandatory* operation at a Hermes / Personal-Agent / legacy-Registry location.
 *
 * Why this file exists
 * --------------------
 * The six Professor skills and the persona prefix are the plugin's "constitution". They were ported
 * from a Hermes workspace that lived in `~/Personal-Agent` with `01_Learning/Registry`,
 * `01_Learning/Knowledge` and a `06_Shared` template library. The port kept those paths as if they
 * were still authoritative, which quietly made "install the plugin on a fresh computer" a lie: the
 * skills told the model to read and write files that a new user does not have.
 *
 * The rule enforced here is the one the v1 plan states:
 *
 *   - a *mandatory* operation (registering a course, initialising learning state, resolving a
 *     template, writing a note) is addressed through Professor-owned state and `professor_*` tools;
 *   - a legacy path may appear only inside a section explicitly marked `Optional`, where it is an
 *     explicit, user-initiated import of pre-existing Hermes data.
 *
 * The check is textual on purpose. `verify-plugin-skills.mjs` proves the skills are *structurally*
 * loadable; nothing proved their *prose* was portable, and prose is what the model actually reads.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const PACKAGE_ROOT = path.join(import.meta.dirname, '..')
const SKILLS_DIR = path.join(PACKAGE_ROOT, 'skills')
const PATCH_FILE = path.join(PACKAGE_ROOT, 'cordis.patch.yml')

const EXPECTED_SKILLS = [
  'professor-course-management',
  'professor-latex',
  'professor-notes',
  'professor-research',
  'professor-review',
  'professor-study',
]

/**
 * Location tokens that only exist inside a Hermes / Personal-Agent workspace. None of them is part
 * of the plugin package, so a mandatory operation must never name one.
 */
const LEGACY_TOKENS = [
  '01_Learning',
  'Knowledge/',
  'Registry/COURSES',
  'Registry/Courses/',
  'COURSES_TEMPLATE',
  '00_System',
  'PATHS.md',
  'Personal-Agent',
  '06_Shared',
  '05_Skills',
  '04_Agents',
  '${PERSONAL_AGENT_ROOT}',
  '${PROJECTS_ROOT}',
]

/** A `## …` section is "optional" when its heading says so; legacy paths are legal only there. */
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

const isOptional = (heading) => /optional/i.test(heading)

/** Every legacy token found outside an `Optional` section, as `token (heading)` strings. */
function mandatoryLegacyUses(markdown) {
  const found = []
  for (const section of sections(markdown)) {
    if (isOptional(section.heading)) continue
    const body = section.lines.join('\n')
    for (const token of LEGACY_TOKENS) {
      if (body.includes(token)) found.push(`${token} (in "${section.heading}")`)
    }
  }
  return [...new Set(found)]
}

const read = (file) => fs.readFile(file, 'utf8')

// --- the bundled skills -----------------------------------------------------

test('every bundled skill is addressed through Professor-owned state, not a legacy workspace', async () => {
  for (const name of EXPECTED_SKILLS) {
    const markdown = await read(path.join(SKILLS_DIR, name, 'SKILL.md'))
    const offenders = mandatoryLegacyUses(markdown)
    assert.deepEqual(offenders, [],
      `${name} still directs a mandatory operation at a legacy location: ${offenders.join(', ')}`)
  }
})

test('the course-management skill drives the Professor tools instead of hand-editing a registry', async () => {
  const markdown = await read(path.join(SKILLS_DIR, 'professor-course-management', 'SKILL.md'))

  // The v1 authority is the Professor project document plus the professor_* tool surface. Every
  // operation the skill documents must be expressible through those tools.
  for (const tool of [
    'professor_project_init',
    'professor_course_manage',
    'professor_course_list',
    'professor_session_bind',
    'professor_index_sync',
    'professor_state_read',
    'professor_state_update',
    'professor_paths',
  ]) {
    assert.ok(markdown.includes(tool), `course-management must route through ${tool}`)
  }

  // The five operation names the source-sync manifest pins must survive the rewrite.
  for (const operation of ['REGISTER', 'SYNC', 'LOCATE', 'UPDATE', 'ARCHIVE']) {
    assert.ok(markdown.includes(operation), `the ${operation} operation must survive`)
  }

  // The invariants the source-sync verifier anchors on must survive too.
  assert.match(markdown, /a table only/)
  assert.match(markdown, /Delete nothing/)
  assert.match(markdown, /Never reset a studied unit/)
  assert.match(markdown, /Never copy course material/)
  assert.match(markdown, /active \| completed \| archived/)
  assert.match(markdown, /AI Notes Output/)
})

test('the course-management skill keeps a legacy import only as an explicit optional workflow', async () => {
  const markdown = await read(path.join(SKILLS_DIR, 'professor-course-management', 'SKILL.md'))
  const optional = sections(markdown).filter((section) => isOptional(section.heading))
  assert.ok(optional.length >= 1, 'the legacy import must live in an explicitly Optional section')
  const optionalBody = `${optional.map((section) => section.lines.join('\n')).join('\n')}`
  assert.ok(optionalBody.includes('${PERSONAL_AGENT_ROOT}'),
    'the optional section names the legacy registry through the documented root variable')
  assert.match(optionalBody, /professor_course_manage/, 'the import still runs through the tool')
})

test('the LaTeX skill uses a configured template and never falls back to a legacy shared library', async () => {
  const markdown = await read(path.join(SKILLS_DIR, 'professor-latex', 'SKILL.md'))
  assert.deepEqual(mandatoryLegacyUses(markdown), [],
    'the LaTeX workflow must not name a legacy template location')
  assert.ok(!markdown.includes('06_Shared'),
    'the shared Personal-Agent template library must not appear anywhere in the skill')
  // The self-contained path is what a fresh install has: a course template when one validates,
  // otherwise the plugin's own generation contract with no external scaffolding.
  assert.match(markdown, /self-contained|without a template|no template/i,
    'the skill must state what happens when no template is configured')
})

// --- the bundled persona ----------------------------------------------------

test('the bundled persona carries the Professor constitution without a legacy path', async () => {
  const patch = await read(PATCH_FILE)

  for (const token of LEGACY_TOKENS) {
    assert.ok(!patch.includes(token),
      `cordis.patch.yml still references the legacy location ${token}`)
  }
  for (const token of ['/Users/', '/home/', 'C:\\']) {
    assert.ok(!patch.includes(token), `cordis.patch.yml embeds a machine-specific path (${token})`)
  }
})

test('the bundled persona states the rules a fresh install depends on', async () => {
  const patch = await read(PATCH_FILE)

  // Identity + authority are Professor-owned: the project document and the professor_* tools.
  assert.match(patch, /professor_project_init|professor_course_list/,
    'the persona must point at the Professor tools as the authority')
  assert.match(patch, /没有连接|courses connected|未连接/,
    'the persona must say what to do when no academic folder is connected')
  assert.ok(!/注册表\s*→\s*INDEX/.test(patch),
    'the persona must not restore context through the legacy registry → INDEX chain')
  assert.match(patch, /\.professor\/project\.yaml/,
    'the persona must name the Professor project document as the authority')

  // The pre-existing, non-negotiable behaviours must survive the rewrite.
  for (const [needle, label] of [
    ['教授材料', 'source priority'],
    ['绝不编造', 'no fabrication rule'],
    ['只读', 'original material is read-only'],
    ['轻量提问', 'lightweight questions do not mutate state'],
    ['请选择笔记格式', 'note format gate'],
    ['原题', 'practice question labelling'],
    ['未实现', 'capability honesty'],
  ]) {
    assert.ok(patch.includes(needle), `the persona must still cover: ${label}`)
  }

  // Rewriting the persona must not shrink it into a stub.
  assert.ok(patch.length > 3000, 'the persona is still substantive')
})
