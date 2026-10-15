/**
 * Teaching-runtime repair regressions: fewer redundant round trips, turn-scoped depth, and honest
 * first-study behaviour.
 *
 * Each test drives production code — the real tools through `apply`, the real composition and the
 * real injected prompt section — because the claims here are about what the plugin *does*, not
 * about a helper in isolation.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { createAppStorage } from '../src/app/storage.js'
import { createSkillCustomizationStore, customizationKey } from '../src/skills/customization.js'
import { composeSkill } from '../src/skills/compose.js'
import { bundledPreset, BUNDLED_PRESETS, DEFAULT_PRESET_ID } from '../src/skills/presets.js'
import { createSessionMemory } from '../src/memory/session.js'
import { createFsGateway } from '../src/fs/gateway.js'
import { projectPaths } from '../src/paths/roots.js'
import { INDEX_SYNC_TOOL_NAME } from '../src/tools/index-sync.js'
import {
  createFakeContext, createFakeStorageDomain, createScriptedShell, makeHome, writeFixture,
} from './helpers/fake-harness.mjs'

const PROJECT_YAML = `schema_version: 1
project:
  id: term-2026
  name: 'Fall 2026'
courses:
  - course_id: csc4801
    course_code: CSC4801
    term: '2025-2026 Fall'
    display_name: AI-assisted Software Engineering
    status: active
    sources:
      - path: {ROOT}/CSC4801
outputs:
  notes_root: null
  reviews_root: null
indexing:
  exclude: []
  follow_symlinks: false
retrieval:
  max_sources: 4
  max_chunks: 8
  prefer_local_course_sources: true
notes:
  default_format: ask
  overwrite_policy: never
  latex_template: null
web:
  enabled: true
  policy: conditional
`

const PROGRESS = `# Course — Learning Progress

## Current Position

**Current Unit:** Unit 1 — What an agent is
**Current Topic:** tool calls versus plans
**Last Studied:** 2026-10-01
**Recommended Next Step:** re-read page 2 of the first lecture

## Unit Progress

| Unit | Topic / Title | Status | Understanding | Notes |
|---|---|---|---|---|
| Unit 1 | What an agent is | learning | partial | |
`

function toolsByName(fake) {
  return Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
}

/**
 * A bound project with a course, an index and (optionally) real learning state.
 *
 * @returns `{ home, project, fake, tools, exec, stateFile, gateway }`.
 */
async function fixture({ withState = true, services = {}, pluginConfig = {} } = {}) {
  const home = await makeHome('professor-runtime-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/CSC4801/01_Lectures/00_Introduction.pdf', 'stable lecture bytes')
  await writeFixture(
    home, 'courses/term/.professor/project.yaml', PROJECT_YAML.replace('{ROOT}', project),
  )
  const stateDir = projectPaths(project).courseStateDir('csc4801')
  if (withState) {
    await writeFixture(home, path.join('courses/term/.professor/state/courses/csc4801/PROGRESS.md'), PROGRESS)
    await writeFixture(home, path.join('courses/term/.professor/state/courses/csc4801/KNOWLEDGE.md'), '# Knowledge\n')
    await writeFixture(home, path.join('courses/term/.professor/state/courses/csc4801/MISTAKES.md'), '# Mistakes\n')
    await writeFixture(home, path.join('courses/term/.professor/state/courses/csc4801/INDEX.md'), '# Index\n')
  }
  const fake = createFakeContext({ home, services })
  apply(fake.ctx, { ...fake.pluginConfig, ...pluginConfig })
  const tools = toolsByName(fake)
  const exec = {
    agent: {
      session: {
        id: 'session-runtime',
        header: { cwd: project },
        requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
      },
    },
    signal: new AbortController().signal,
  }
  await tools[INDEX_SYNC_TOOL_NAME].execute({ force: true }, exec)
  return {
    home, project, fake, tools, exec, stateDir,
    gateway: createFsGateway({ ctx: fake.ctx, logger: fake.ctx.logger }),
  }
}

/** Count `readText` calls whose target path contains `needle`. */
function countReads(fake, needle) {
  let count = 0
  const original = fake.ctx.fs.readText.bind(fake.ctx.fs)
  fake.ctx.fs.readText = async (target, signal) => {
    if (String(target?.targetKey ?? target?.displayPath ?? '').includes(needle)) count += 1
    return original(target, signal)
  }
  return {
    get value() { return count },
    restore() { fake.ctx.fs.readText = original },
  }
}

// --- Repair B: redundant round trips --------------------------------------------------

test('one complete state read is followed by no further reads of the same files', async () => {
  const s = await fixture()
  const spy = countReads(s.fake, '.professor/state/courses/csc4801')

  const first = await s.tools.professor_state_read.execute({ course: 'csc4801' }, s.exec)
  assert.equal(first.present, true)
  assert.equal(first.summary.files_read, 4)
  assert.equal(first.summary.files_reused, 0)
  const readsAfterFirst = spy.value
  assert.equal(readsAfterFirst, 4, 'a complete read reads each file exactly once')

  // The pattern the live session showed: a full read, then the same four files one at a time.
  for (const file of ['INDEX.md', 'PROGRESS.md', 'KNOWLEDGE.md', 'MISTAKES.md']) {
    const repeat = await s.tools.professor_state_read.execute({ course: 'csc4801', file }, s.exec)
    assert.equal(repeat.present, true)
    assert.equal(repeat.files[file].fresh.unchanged, true, `${file} is served from the session cache`)
    assert.equal(repeat.files[file].fresh.source, 'session cache (fs_version unchanged)')
    assert.equal(repeat.summary.files_read, 0)
    assert.equal(repeat.summary.files_reused, 1)
  }
  assert.equal(spy.value, readsAfterFirst, 'no file content was read again while nothing had changed')

  // Explicit refresh always re-reads, and a changed file invalidates the entry by itself.
  const refreshed = await s.tools.professor_state_read.execute({ course: 'csc4801', refresh: true }, s.exec)
  assert.equal(refreshed.summary.files_read, 4)
  assert.ok(spy.value > readsAfterFirst)

  spy.restore()
})

test('a changed state file invalidates the cached copy without a refresh flag', async () => {
  const s = await fixture()
  await s.tools.professor_state_read.execute({ course: 'csc4801' }, s.exec)
  const target = path.join(s.stateDir, 'PROGRESS.md')
  await fs.writeFile(target, `${PROGRESS}\n**Recommended Next Step:** changed\n`)

  const after = await s.tools.professor_state_read.execute({ course: 'csc4801' }, s.exec)
  assert.equal(after.files['PROGRESS.md'].fresh.unchanged, false, 'a changed version is re-read')
  assert.equal(after.summary.files_read, 1, 'only the file that changed is read again')
  assert.equal(after.summary.files_reused, 3)
  assert.equal(after.files['PROGRESS.md'].fresh.source, 'disk')
})

test('missing learning state is the normal first-study condition, not a recovery loop', async () => {
  const s = await fixture({ withState: false })
  const payload = await s.tools.professor_state_read.execute({ course: 'csc4801' }, s.exec)
  assert.equal(payload.present, false)
  assert.equal(payload.summary.first_study, true)
  assert.equal(payload.summary.has_progress, false)
  assert.match(payload.summary.note, /first-study/)
  assert.match(payload.summary.note, /do not re-read state or rebuild indexes/)
  assert.ok(Object.values(payload.files).every((entry) => entry.present === false))
  assert.deepEqual(payload.warnings, [], 'an unstudied course produces no warning')
})

test('an existing index is verified, never rebuilt, and a changed tree is written', async () => {
  const s = await fixture()
  const indexPath = path.join(s.project, '.professor/indexes/files.json')
  const before = await fs.readFile(indexPath, 'utf8')

  const second = await s.tools[INDEX_SYNC_TOOL_NAME].execute({}, s.exec)
  assert.equal(second.status, 'unchanged')
  assert.equal(second.freshness.written, false)
  assert.equal(second.freshness.verified, true)
  assert.equal(second.freshness.project_digest_match, true)
  assert.equal(second.added, 0)
  assert.equal(second.changed, 0)
  assert.equal(await fs.readFile(indexPath, 'utf8'), before, 'the index file is byte-identical')

  // A new file in a registered source root must still be found on the next call.
  await writeFixture(s.home, 'courses/term/CSC4801/01_Lectures/01_Agents.pdf', 'another lecture')
  const third = await s.tools[INDEX_SYNC_TOOL_NAME].execute({}, s.exec)
  assert.equal(third.status, 'synced')
  assert.equal(third.added, 1, 'verification detects an added file')
  assert.equal(third.freshness.written, true)

  // force always re-derives, whatever the tree says.
  const forced = await s.tools[INDEX_SYNC_TOOL_NAME].execute({ force: true }, s.exec)
  assert.equal(forced.status, 'synced')
  assert.equal(forced.freshness.written, true)
})

// --- Repair B: turn priority ----------------------------------------------------------

/**
 * The injected per-turn course section is the only seam a plugin has on "which turn is this": the
 * host's prompt-assembly context carries `{ scope, signal }` and no messages. What it must not do
 * is issue an unconditional "restore state now" imperative — that is what made a plain greeting
 * launch a teaching workflow after an aborted request.
 */
test('the injected course section states turn priority instead of ordering an unconditional restore', async () => {
  const s = await fixture()
  const bound = await s.tools.professor_session_bind.execute({ course: 'csc4801', reason: 'test' }, s.exec)
  assert.equal(bound.course_id, 'csc4801')

  const memory = createSessionMemory({
    store: { readControl: async () => ({ enabled: true }), readGlobal: async () => ({ present: false, record: null }) },
    gateway: s.gateway,
    policiesFor: () => ({ read: { assert() {} }, write: { assert() {} } }),
    logger: { info() {}, warn() {} },
    isProfessorAgent: () => true,
  })
  const text = await memory.textFor(s.exec.agent)
  assert.match(text, /【Professor 当前课程】/)
  assert.match(text, /【本轮优先级】/)

  // Newest message wins; an interrupted task is not resumed automatically.
  assert.match(text, /最新一条用户消息/)
  assert.match(text, /不要自动续做/)
  // A greeting is a greeting.
  assert.match(text, /问候、寒暄或道别/)
  assert.match(text, /不要调用状态恢复、索引同步、检索或材料读取/)
  // Preparation happens once per stage.
  assert.match(text, /每个阶段只做一次/)
  // The old unconditional imperative is gone.
  assert.doesNotMatch(text, /先恢复这门课程的学习状态/)
  // Whole-material coverage is a plan, not a handful of search hits.
  assert.match(text, /professor_material_read/)
  assert.match(text, /检索命中只是片段/)
})

// --- Repair C: depth and preference composition --------------------------------------

test('an explicit request for a complete detailed explanation outranks a saved brevity preference', () => {
  const saved = { teachingDepth: '简洁，先给关键结论', explanationStyle: '一步一步' }
  const result = composeSkill({ builtIn: 'builtin body', global: saved })

  // The saved preference is still shown, in its own frame, with its documented precedence.
  assert.match(result.content, /teachingDepth: 简洁，先给关键结论/)
  assert.match(result.content, /A current explicit user instruction .* overrides saved preferences/)

  // …and the turn-scope rule says an explicit completeness request wins for that turn.
  assert.match(result.content, /<professor_turn_scope>/)
  assert.match(result.content, /Depth precedence/)
  assert.match(result.content, /complete, detailed, comprehensive or whole-material explanation/)
  assert.match(result.content, /must not truncate, shorten or replace it/)
  assert.match(result.content, /适中 or 简洁/)
})

test('the two teaching shapes are named, and exercises never replace the requested explanation', () => {
  const result = composeSkill({ builtIn: 'body', global: { teachingDepth: '适中，解释关键步骤' } })
  assert.match(result.content, /通讲 \(whole-material explanation\)/)
  assert.match(result.content, /递进互动 \(incremental interactive teaching\)/)
  assert.match(result.content, /never substitute one for the other/)
  assert.match(result.content, /Exercises and follow-up questions may follow the requested explanation once it is complete/)
  assert.match(result.content, /must not open with it, replace it, or cut it short/)
  assert.match(result.content, /never invent a professor’s statements, exam scope or weighting/)
  assert.match(result.content, /never imply complete coverage you did not establish/)
})

test('a turn-scoped depth override is never persisted anywhere', async (t) => {
  const medium = createFakeStorageDomain({ name: 'professor_app' })
  const storage = createAppStorage({
    ctx: { get: () => medium.service }, logger: { warn() {}, info() {} }, readVersion: async () => 'test',
  })
  t.after(() => storage.close())
  const store = createSkillCustomizationStore({ appStorage: storage })
  const skill = 'professor-study'

  const before = await store.read({ skill })
  assert.deepEqual(before, { revision: 0, fields: {} })

  const composed = composeSkill({
    builtIn: 'body',
    global: { teachingDepth: '适中，解释关键步骤' },
    session: { additionalInstructions: 'just this session' },
  })

  // The override lives in the rule text, not in a field that could be written back…
  assert.deepEqual(composed.effective, { teachingDepth: '适中，解释关键步骤' })
  assert.deepEqual(Object.keys(composed).sort(), ['additions', 'content', 'effective'])
  // …and composing changes nothing on disk.
  assert.deepEqual(await store.read({ skill }), { revision: 0, fields: {} })
  assert.equal(
    (medium.stores.get('app') ?? new Map()).has(customizationKey({ skill, scope: null })),
    false,
    'no customization record was written by composition',
  )
})

test('saved preferences keep precedence and switching a preset changes the next composition', () => {
  const global = { teachingDepth: '深入，逐步解释原理和推导', language: 'Chinese' }
  const withCourse = composeSkill({ builtIn: 'body', global, course: { teachingDepth: '简洁' } })
  assert.deepEqual(withCourse.effective, { teachingDepth: '简洁', language: 'Chinese' }, 'course beats global')

  const progressive = composeSkill({ builtIn: 'body', global: bundledPreset(DEFAULT_PRESET_ID).fields })
  const quick = composeSkill({ builtIn: 'body', global: bundledPreset('builtin-quick-answers').fields })
  assert.notEqual(progressive.content, quick.content, 'a different preset composes differently')
  assert.match(progressive.content, /teachingDepth: 深入，逐步解释原理和推导/)
  assert.match(quick.content, /teachingDepth: 简洁，先给关键结论/)

  // A learner's own saved depth must not be replaced by the default preset.
  const own = composeSkill({ builtIn: 'body', global })
  assert.match(own.content, /teachingDepth: 深入，逐步解释原理和推导/)
  assert.doesNotMatch(own.content, /builtin-progressive/)
  assert.equal(BUNDLED_PRESETS.length, 5, 'the five bundled modes still ship')
  // The default preset tells a learner who asked for a full explanation to get one first.
  assert.match(
    bundledPreset(DEFAULT_PRESET_ID).fields.additionalInstructions,
    /先把要求的正文完整讲完，练习与提问放在其后/,
  )
})

// --- Repair A precondition: interpreter selection ------------------------------------

/** A probe that reports Office libraries for the payload interpreter and PyMuPDF for a host one. */
function probingShell() {
  const officeOnly = {
    ok: true, python: '3.12.14',
    modules: { docx: '1.2.0', pptx: '1.0.2', openpyxl: '3.1.5', lxml: '6.1.3' },
    missing: ['fitz', 'pymupdf'],
  }
  const withPdf = {
    ok: true, python: '3.14.0',
    modules: { fitz: '1.28.2', pymupdf: '1.28.2' },
    missing: ['docx', 'pptx', 'openpyxl', 'lxml'],
  }
  const calls = []
  const shell = createScriptedShell((command) => {
    calls.push(command)
    if (command.includes('probe_python.py')) {
      return { stdout: JSON.stringify(command.includes('dsh-primary-runtime') ? officeOnly : withPdf) }
    }
    if (command.includes('--version')) return { stdout: '10.02.0\n' }
    if (command.includes('-h')) return { stdout: 'txtwrite png16m\n' }
    return { stdout: '' }
  })
  return { shell, calls }
}

test('the interpreter chosen for PDF work is one that can actually run PyMuPDF', async () => {
  const { shell, calls } = probingShell()
  const home = await makeHome('professor-interpreter-')
  const fake = createFakeContext({ home, services: { shell } })
  apply(fake.ctx, fake.pluginConfig)
  const tools = toolsByName(fake)
  const exec = { agent: { session: { id: 's', header: { cwd: home } } }, signal: new AbortController().signal }

  const report = await tools.professor_diagnostics.execute({}, exec)
  const caps = report.extraction.capabilities
  assert.equal(caps.pdfText, 'fitz', 'a PDF-capable interpreter is selected, not merely the first responder')
  assert.equal(caps.pdf.backend, 'pymupdf')
  assert.equal(caps.pageRender.available, true)
  assert.equal(caps.pageRender.backend, 'pymupdf')
  assert.equal(caps.officePython, true, 'a different interpreter still covers Office work')
  assert.ok(calls.filter((line) => line.includes('probe_python.py')).length >= 1)
  assert.match(caps.pageRender.writes, /nothing/)
})

test('without a PyMuPDF interpreter the plan says rendering is unavailable instead of failing late', async () => {
  const { shell } = probingShell()
  const home = await makeHome('professor-interpreter-nopdf-')
  // Narrow discovery to the payload interpreter only, which has Office libraries but no PyMuPDF.
  const fake = createFakeContext({ home, services: { shell } })
  apply(fake.ctx, { ...fake.pluginConfig, extractRuntime: { pathDirs: [] } })
  const tools = toolsByName(fake)
  const exec = { agent: { session: { id: 's', header: { cwd: home } } }, signal: new AbortController().signal }

  const report = await tools.professor_diagnostics.execute({}, exec)
  const caps = report.extraction.capabilities
  assert.equal(caps.pdfText, 'ghostscript', 'the documented fallback still applies')
  assert.equal(caps.pageRender.available, false)
  assert.match(caps.pageRender.reason, /importing PyMuPDF/)
  assert.equal(caps.pdf.visual, false, 'text extraction is still never called visual inspection')
  assert.equal(caps.ocr, false)
})

// --- Repair D: observability ---------------------------------------------------------

test('telemetry emits counts and codes only, never content', async () => {
  const s = await fixture()
  await s.tools.professor_state_read.execute({ course: 'csc4801' }, s.exec)
  const logged = s.fake.logs.info.filter((line) => line.includes('professor.telemetry'))
  assert.ok(logged.length > 0, 'the repair instruments the runtime')

  const payloadOf = (line) => JSON.parse(line.slice(line.indexOf('{')))
  const kinds = logged.map((line) => /professor.telemetry (\S+)/.exec(line)?.[1])
  assert.ok(kinds.includes('state.read'), `state.read observed in ${kinds.join(',')}`)

  // Every event is one of the documented kinds, and every field is a bounded count or code.
  const allowedKinds = new Set([
    'skill.loaded', 'material.plan', 'material.render', 'material.suppressed',
    'material.budget', 'state.read', 'index.sync', 'tool.failed',
  ])
  for (const line of logged) {
    const kind = /professor\.telemetry (\S+)/.exec(line)[1]
    assert.ok(allowedKinds.has(kind), `unexpected telemetry kind: ${kind}`)
    const fields = payloadOf(line)
    for (const [key, value] of Object.entries(fields)) {
      assert.match(key, /^[a-z][a-z0-9_]*$/, `${key} is a plain field name`)
      assert.equal(key === 'text' || key === 'content' || key === 'prompt', false, 'no content field')
      if (typeof value === 'string') assert.ok(value.length <= 120, `${key} is bounded`)
      if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} is a count`)
    }
  }
  const stateEvent = payloadOf(logged.find((line) => line.includes('state.read')))
  assert.deepEqual(
    Object.keys(stateEvent).sort(),
    ['cache', 'course', 'first_study', 'files_read'.replace('files_read', 'read'), 'reused'].sort(),
    'the state event carries only counts and codes',
  )
})

test('skill loading reports its composition scope without carrying the skill text', async () => {
  const medium = createFakeStorageDomain({ name: 'professor_app' })
  const s = await fixture({ services: { storageDomain: medium.service } })
  const provider = s.fake.providers[0]('control-scope')
  const definition = await provider.get(
    { locator: { directory: 'professor-study', path: 'x' }, name: 'professor-study' },
    { cwd: s.project, scope: null },
  )
  assert.ok(definition.content.includes('<professor_preferences>'))
  const logged = s.fake.logs.info.filter((line) => line.includes('professor.telemetry skill.loaded'))
  assert.equal(logged.length, 1, 'exactly one load event')
  const fields = JSON.parse(logged[0].slice(logged[0].indexOf('{')))
  assert.deepEqual(Object.keys(fields).sort(), ['chars', 'scope', 'skill'])
  assert.equal(fields.skill, 'professor-study')
  assert.equal(fields.scope, 'customized')
  assert.equal('text' in fields, false)
})

test('the plugin disposes its reading ledger with the fiber and leaves nothing running', async () => {
  const s = await fixture()
  const before = createHash('sha256').update(await fs.readFile(
    path.join(s.project, '.professor/project.yaml'), 'utf8')).digest('hex')

  // A full read cycle while no timer may be scheduled: the reading path is synchronous work
  // around awaited IO, never a background job that outlives the call.
  const scheduled = []
  const originalSetTimeout = globalThis.setTimeout
  const originalSetInterval = globalThis.setInterval
  globalThis.setTimeout = (...args) => { scheduled.push(args[0]); return 0 }
  globalThis.setInterval = (...args) => { scheduled.push(args[0]); return 0 }
  try {
    await s.tools.professor_state_read.execute({ course: 'csc4801' }, s.exec)
    await s.tools[INDEX_SYNC_TOOL_NAME].execute({}, s.exec)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.setInterval = originalSetInterval
  }
  assert.deepEqual(scheduled, [], 'no timer or interval is scheduled by the runtime')

  s.fake.disposeAll()
  assert.deepEqual(scheduled, [], 'disposal schedules nothing either')
  const after = createHash('sha256').update(await fs.readFile(
    path.join(s.project, '.professor/project.yaml'), 'utf8')).digest('hex')
  assert.equal(after, before, 'disposal does not touch the project document')
})
