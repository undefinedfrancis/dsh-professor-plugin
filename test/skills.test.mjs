/**
 * Skill provider contract, frontmatter parsing, and watcher behaviour.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { invocationPolicy, parseFrontmatter } from '../src/skills/frontmatter.js'
import { BUNDLED_SKILL_RANK, createBundledSkillProvider, readBundledSkill, SKILL_PROVIDER_NAME } from '../src/skills/provider.js'
import { createSkillsWatcher, WATCHER_DEGRADED_PREFIX } from '../src/skills/watcher.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const EXPECTED_BUNDLED = [
  'professor-course-management', 'professor-latex', 'professor-notes',
  'professor-research', 'professor-review', 'professor-study',
]

function collectingLogger() {
  const warnings = []
  return { warnings, warn: (message) => warnings.push(message), info: () => {}, debug: () => {} }
}

test('frontmatter parsing covers plain, quoted and folded values', () => {
  const plain = parseFrontmatter('---\nname: study-session\ndescription: Teach a course.\n---\n\n# Body\n')
  assert.equal(plain.data.name, 'study-session')
  assert.equal(plain.data.description, 'Teach a course.')
  // The body starts right after the closing fence, so it keeps the blank separator line — the
  // same shape the Harness parser returns.
  assert.equal(plain.body, '\n# Body\n')

  const folded = parseFrontmatter('---\nname: x\ndescription: >\n  first line\n  second line\n\n  new paragraph\n---\nbody')
  assert.equal(folded.data.description, 'first line second line\nnew paragraph')

  const literal = parseFrontmatter('---\nname: x\ndescription: |\n  kept\n  lines\n---\nbody')
  assert.equal(literal.data.description, 'kept\nlines')

  const quoted = parseFrontmatter('---\nname: "x-y"\ndescription: \'quoted\'\n---\nbody')
  assert.equal(quoted.data.name, 'x-y')
  assert.equal(quoted.data.description, 'quoted')

  assert.equal(parseFrontmatter('no frontmatter here'), undefined)
  assert.equal(parseFrontmatter('---\nname: x\n'), undefined, 'unterminated frontmatter is rejected')
})

test('invocation policy mirrors the Harness defaults and canonical keys', () => {
  assert.deepEqual(invocationPolicy({}), { modelInvocable: true, userInvocable: true })
  assert.deepEqual(invocationPolicy({ 'disable-model-invocation': true }), { modelInvocable: false, userInvocable: true })
  assert.deepEqual(invocationPolicy({ 'disable-model-invocation': 'yes' }), { modelInvocable: false, userInvocable: true })
  assert.deepEqual(invocationPolicy({ 'user-invocable': false }), { modelInvocable: true, userInvocable: false })
  assert.deepEqual(invocationPolicy({ 'user-invocable': 'off' }), { modelInvocable: true, userInvocable: false })
})

async function makeSkillsFixture() {
  const home = await makeHome('professor-skills-')
  const skillsDir = path.join(home, 'skills')
  await writeFixture(home, 'skills/good-one/SKILL.md', '---\nname: good-one\ndescription: First good skill.\n---\n\n# One\n${COURSE_ROOT}/x\n')
  await writeFixture(home, 'skills/good-two/SKILL.md', '---\nname: good-two\ndescription: >\n  Folded description\n  across lines.\n---\n\n# Two\n')
  await writeFixture(home, 'skills/good-three/SKILL.md', '---\nname: good-three\ndescription: Third.\ndisable-model-invocation: true\n---\n\n# Three\n${UNKNOWN_VAR}/y\n')
  await writeFixture(home, 'skills/bad-description/SKILL.md', '---\nname: bad-description\n---\n\n# No description\n')
  await writeFixture(home, 'skills/Bad-Name/SKILL.md', '---\nname: Bad-Name\ndescription: Not kebab case.\n---\n\n# Bad\n')
  await writeFixture(home, 'skills/not-a-skill/readme.txt', 'plain file, no SKILL.md')
  return { home, skillsDir }
}

test('provider returns registry-valid candidates and isolates malformed skills', async () => {
  const { skillsDir } = await makeSkillsFixture()
  const logger = collectingLogger()
  const provider = createBundledSkillProvider({ ctx: {}, skillsDir, logger })

  assert.equal(provider.name, SKILL_PROVIDER_NAME)
  const candidates = await provider.list()
  assert.ok(Array.isArray(candidates), 'a complete scan returns a plain array')

  assert.deepEqual(candidates.map((candidate) => candidate.name).sort(), ['good-one', 'good-three', 'good-two'])
  for (const candidate of candidates) {
    assert.match(candidate.name, SKILL_NAME)
    assert.ok(candidate.description.length > 0)
    assert.equal(candidate.provider, SKILL_PROVIDER_NAME)
    assert.equal(candidate.source, 'bundled')
    assert.equal(candidate.rank, BUNDLED_SKILL_RANK)
    assert.equal(typeof candidate.invocation.modelInvocable, 'boolean')
    assert.equal(typeof candidate.invocation.userInvocable, 'boolean')
    assert.equal(typeof candidate.path, 'string')
    assert.equal(typeof candidate.locator.directory, 'string')
  }

  assert.equal(candidates.find((c) => c.name === 'good-three').invocation.modelInvocable, false)
  assert.equal(logger.warnings.length, 3, 'malformed skills warn instead of killing the provider')
  assert.ok(logger.warnings.some((message) => message.includes('bad-description')), 'missing description is reported')
  assert.ok(logger.warnings.some((message) => message.includes('Bad-Name')), 'non-kebab name is reported')
  assert.ok(logger.warnings.some((message) => message.includes('not-a-skill')), 'a directory without SKILL.md is reported')
})

test('provider get() returns a valid definition and substitutes resolved roots', async () => {
  const { skillsDir } = await makeSkillsFixture()
  const provider = createBundledSkillProvider({ ctx: {}, skillsDir, logger: collectingLogger() })
  const candidates = await provider.list()
  const one = candidates.find((candidate) => candidate.name === 'good-one')

  const definition = await provider.get(one, { cwd: '/srv/course' })
  assert.equal(definition.name, 'good-one')
  assert.equal(definition.provider, SKILL_PROVIDER_NAME)
  assert.equal(definition.resourceBase.kind, 'directory')
  assert.equal(definition.source, 'bundled')
  assert.ok(definition.content.includes('/srv/course/x'), 'COURSE_ROOT is substituted from the call cwd')
  assert.equal(definition.content.startsWith('---'), false, 'frontmatter is stripped from content')

  const three = candidates.find((candidate) => candidate.name === 'good-three')
  const unresolved = await provider.get(three, { cwd: '/srv/course' })
  assert.ok(unresolved.content.includes('${UNKNOWN_VAR}'), 'unresolved variables keep their placeholder')

  assert.equal(await provider.get({ name: 'nope' }, {}), undefined)
})

test('provider reports an incomplete catalog instead of throwing', async () => {
  const home = await makeHome('professor-skills-')
  const notADirectory = await writeFixture(home, 'skills.txt', 'not a directory')
  const logger = collectingLogger()
  const provider = createBundledSkillProvider({ ctx: {}, skillsDir: notADirectory, logger })

  const result = await provider.list()
  assert.equal(result.complete, false)
  assert.deepEqual(result.candidates, [])
  assert.equal(logger.warnings.length, 1)

  const missing = createBundledSkillProvider({ ctx: {}, skillsDir: path.join(home, 'absent'), logger })
  assert.deepEqual(await missing.list(), [], 'an absent skills directory is an empty catalog, not an error')
})

test('the bundled skills directory satisfies the contract end to end', async () => {
  const skillsDir = path.join(import.meta.dirname, '..', 'skills')
  const logger = collectingLogger()
  const provider = createBundledSkillProvider({ ctx: {}, skillsDir, logger })
  const candidates = await provider.list()

  assert.deepEqual(candidates.map((candidate) => candidate.name).sort(), EXPECTED_BUNDLED)
  assert.deepEqual(logger.warnings, [])

  for (const candidate of candidates) {
    const definition = await provider.get(candidate, { cwd: '/tmp/course' })
    assert.equal(definition.name, candidate.name)
    assert.ok(definition.content.length > 200)
    assert.equal(definition.content.startsWith('---'), false)
    const info = await fs.stat(path.join(definition.resourceBase.path, 'SKILL.md'))
    assert.equal(info.isFile(), true)
  }
})

test('readBundledSkill rejects unsafe directory names', async () => {
  const { skillsDir } = await makeSkillsFixture()
  assert.equal(await readBundledSkill(skillsDir, '../escape'), undefined)
  assert.equal(await readBundledSkill(skillsDir, '.hidden'), undefined)
  assert.equal(await readBundledSkill(skillsDir, 'missing'), undefined)
})

test('watcher coalesces bursts, triggers once, and survives EMFILE', async () => {
  const listeners = []
  let closed = false
  const watchFn = (dir, options, listener) => {
    assert.equal(options.recursive, undefined, 'the watcher must not be recursive (descriptor pressure)')
    listeners.push(listener)
    return { on: () => {}, close: () => { closed = true } }
  }

  const logger = collectingLogger()
  let calls = 0
  const watcher = createSkillsWatcher({
    dir: '/skills',
    logger,
    debounceMs: 10,
    watchFn,
    onChange: () => { calls += 1 },
  })

  assert.equal(watcher.healthy, true)
  assert.equal(listeners.length, 1, 'exactly one watcher descriptor')

  listeners[0]()
  listeners[0]()
  listeners[0]()
  assert.equal(calls, 0, 'events are debounced')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(calls, 1, 'a burst produces one invalidation')

  watcher.flushPending()
  assert.equal(calls, 2, 'flushPending bypasses the debounce')
  watcher.close()
  assert.equal(closed, true)

  watcher.flushPending()
  assert.equal(calls, 2, 'a closed watcher stops invalidating')

  const failing = createSkillsWatcher({
    dir: '/skills',
    logger,
    watchFn: () => { const error = new Error('too many open files, watch'); error.code = 'EMFILE'; throw error },
    onChange: () => { throw new Error('must not be called') },
  })
  assert.equal(failing.healthy, false)
  assert.match(failing.reason, /EMFILE/)
  assert.equal(logger.warnings.length, 1, 'the failure is reported once, without throwing')
  assert.ok(logger.warnings[0].includes(WATCHER_DEGRADED_PREFIX),
    'the degradation is tagged so it is never mistaken for a provider defect')
})

test('the plugin mounts one injectable watcher and reports degradation honestly', async () => {
  const home = await makeHome('professor-watcher-')

  // (a) A healthy host: exactly one watcher, no degradation warning, torn down with the fiber.
  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  assert.equal(fake.watch.stats.opened, 1, 'one watcher per plugin instance')
  assert.equal(fake.logs.warn.filter((message) => message.includes(WATCHER_DEGRADED_PREFIX)).length, 0,
    'a healthy watcher logs nothing')
  const diagnostics = fake.tools.find((tool) => tool.name === 'professor_diagnostics')
  const healthyReport = await diagnostics.execute({}, makeExec({ cwd: home }))
  assert.equal(healthyReport.skills.watcher.healthy, true)
  assert.equal(healthyReport.skills.watcher.reason, 'watching')
  fake.disposeAll()
  assert.equal(fake.watch.stats.closed, 1, 'the watcher is disposed with the plugin fiber')

  // (b) A host whose descriptor budget is exhausted: reported honestly, distinguishable from a
  // provider defect, never fatal to the plugin or its tools.
  const broken = createFakeContext({ home })
  const failingWatch = () => { const error = new Error('too many open files, watch'); error.code = 'EMFILE'; throw error }
  apply(broken.ctx, { watchFn: failingWatch })
  const degraded = broken.logs.warn.filter((message) => message.includes(WATCHER_DEGRADED_PREFIX))
  assert.equal(degraded.length, 1, 'degradation is reported exactly once')
  assert.match(degraded[0], /EMFILE/)
  // Compared against the healthy instance rather than a hardcoded number: the invariant is
  // "degradation removes nothing", and it must hold whatever the tool surface grows to.
  assert.equal(broken.tools.length, fake.tools.length, 'degradation never removes tools')
  assert.equal(broken.tools.length, 22, 'the M11 + M2 + Phase 3 + material-reader tool surface is registered in full')
  const brokenReport = await broken.tools.find((tool) => tool.name === 'professor_diagnostics')
    .execute({}, makeExec({ cwd: home }))
  assert.equal(brokenReport.skills.watcher.healthy, false)
  assert.ok(brokenReport.warnings.some((message) => message.includes('hot-reload degraded')),
    'diagnostics surfaces the degradation to the caller')
})
