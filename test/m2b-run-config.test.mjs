/**
 * Offline regressions for the M2b run configuration: what goes into the model's input, how a turn
 * is classified from the host's own finish reason, which paths may be trusted, and what counts as
 * delivered.
 *
 * None of these make a model request. The installed `SKILL.md` bodies are read from disk, and the
 * long-title path check drives the real `professor_artifact_create` tool through the fake harness.
 *
 * @module test/m2b-run-config
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { slugify } from '../src/artifacts/paths.js'
import { COURSE_ID } from './helpers/source-grounded-fixture.mjs'
import { runCourseSetup } from './helpers/m2b-course-setup.mjs'
import {
  ARTIFACT_TOKEN_ALLOWANCE, INSTRUCTION_MODES, REQUIRED_M2B_TOOLS, TABLE_FINISHING_MARKERS,
  TABLE_PLACEHOLDER, artifactPathsFromCreate, assessDelivery, buildInstructionSurface,
  classifyTurnOutcome, guidanceReadinessProblems, instructionSurfaceProblems, parseToolArguments,
  requestTextProblems,
  normalizeInstructionMode, validateToolBatch, consumeModelStream, artifactGradingText,
  compilationFactsForCase,
} from './helpers/m2b-run-config.mjs'
import { createFakeContext, makeExec, makeHome } from './helpers/fake-harness.mjs'

const SKILLS_DIR = new URL('../skills/', import.meta.url)
const readSkill = (name) => fs.readFile(new URL(`${name}/SKILL.md`, SKILLS_DIR), 'utf8')

test('documented instruction flags resolve to their recorded modes and reject unknown values', () => {
  assert.equal(normalizeInstructionMode('native'), INSTRUCTION_MODES.NATIVE)
  assert.equal(normalizeInstructionMode('supplied-skill-text'), INSTRUCTION_MODES.SUPPLIED)
  assert.equal(normalizeInstructionMode(INSTRUCTION_MODES.NATIVE), INSTRUCTION_MODES.NATIVE)
  assert.throws(() => normalizeInstructionMode('typo'), /unknown instruction mode/)
})

test('a malformed later tool call prevents the entire response batch from executing', () => {
  const calls = [
    { name: 'edit', arguments: '{"path":"returned.tex"}' },
    { name: 'edit', arguments: '{"path":' },
  ]
  const batch = validateToolBatch(calls, { finish: { kind: 'tool-calls' }, offeredTools: ['edit'] })
  assert.equal(batch.ok, false)
  assert.deepEqual(batch.calls, [])
  assert.match(batch.reason, /not parseable JSON/)
  assert.equal(validateToolBatch(calls.slice(0, 1), {
    finish: { kind: 'max-tokens' }, offeredTools: ['edit'],
  }).ok, false)
  assert.equal(validateToolBatch(calls.slice(0, 1), {
    finish: { kind: 'tool-calls' }, offeredTools: ['read'],
  }).ok, false)
  const valid = validateToolBatch(calls.slice(0, 1), {
    finish: { kind: 'tool-calls' }, offeredTools: ['edit'],
  })
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.calls[0].args, { path: 'returned.tex' })
})

test('a completed stream preserves its blocks, finish reason and usage', async () => {
  const attempt = {}
  async function* completeStream() {
    yield { type: 'block-end', block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' }, usage: { outputTokens: 1 } }
  }
  const result = await consumeModelStream({
    openStream: () => completeStream(), attempt, maxTokens: 8000, persistAttempt: async () => {},
  })
  assert.deepEqual(result.blocks, [{ type: 'text', text: 'done' }])
  assert.deepEqual(attempt.finish_reason, { kind: 'stop' })
  assert.deepEqual(attempt.usage, { outputTokens: 1 })
})

test('a stream exception persists the charged attempt metadata before propagating', async () => {
  const attempt = {}
  const snapshots = []
  async function* brokenStream() {
    yield { type: 'usage', usage: { outputTokens: 23 } }
    throw new Error('connection lost')
  }
  await assert.rejects(consumeModelStream({
    openStream: () => brokenStream(), attempt, maxTokens: 8000,
    persistAttempt: async () => snapshots.push(structuredClone(attempt)),
  }), /connection lost/)
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].max_tokens, 8000)
  assert.equal(snapshots[0].finish_reason, null)
  assert.deepEqual(snapshots[0].usage, { outputTokens: 23 })
  assert.equal(snapshots[0].stream_error, 'connection lost')
})

test('only readable artifact text is eligible for note grading', () => {
  assert.equal(artifactGradingText([]), null)
  assert.equal(artifactGradingText(['']), null)
  assert.equal(artifactGradingText(['table content', 'citation']), 'table content\ncitation')
})

test('a PDF compiled for one note cannot count as compilation of another note', () => {
  const compile = { artifact_case_id: 'M2', pdf: { produced: true, path: '/output/M2/main.pdf' } }
  const visual = { artifact_case_id: 'M2', inspected: true }
  assert.deepEqual(compilationFactsForCase('M2b', compile, visual), {
    compiled: null, visuallyAccepted: null,
  })
  assert.deepEqual(compilationFactsForCase('M2', compile, visual), {
    compiled: true, visuallyAccepted: true,
  })
})

// ------------------------------------------------------------------ instruction surface ----

test('the installed notes and LaTeX skills actually contain the table-finishing guidance', async () => {
  const notes = await readSkill('professor-notes')
  const latex = await readSkill('professor-latex')
  for (const [name, text] of [['professor-notes', notes], ['professor-latex', latex]]) {
    for (const marker of TABLE_FINISHING_MARKERS) {
      assert.ok(text.includes(marker), `${name} must state ${JSON.stringify(marker)}`)
    }
  }
  // And the assertion the runner uses must pass on the genuine installed text.
  assert.deepEqual(instructionSurfaceProblems({ system: `${notes}\n${latex}`, userMessage: '' }), [],
    'the real installed skill bodies carry every marker')
})

test('a persona-only system prompt is reported as missing the guidance', () => {
  const persona = 'You are the Professor assistant for a synthetic acceptance test.'
  const surface = buildInstructionSurface({ sections: [], persona })
  assert.equal(surface.mode, INSTRUCTION_MODES.NATIVE)
  const problems = instructionSurfaceProblems({ system: surface.system, userMessage: '' })
  assert.equal(problems.length, 1, JSON.stringify(problems))
  for (const marker of TABLE_FINISHING_MARKERS) {
    assert.ok(problems[0].includes(marker), `the problem must name the missing marker ${marker}`)
  }
})

test('supplied skill text is a separate mode and is labelled as not native activation', async () => {
  const notes = await readSkill('professor-notes')
  const latex = await readSkill('professor-latex')
  const supplied = buildInstructionSurface({
    sections: [{ name: 'deployment:persona-prefix', text: 'You are the Professor assistant.' }],
    persona: 'fallback',
    suppliedSkillText: [notes, latex],
    suppliedSkillNames: ['professor-notes', 'professor-latex'],
  })
  assert.equal(supplied.mode, INSTRUCTION_MODES.SUPPLIED)
  assert.match(supplied.modeLabel, /NOT evidence about native automatic skill activation/)
  assert.deepEqual(supplied.suppliedSkills, ['professor-notes', 'professor-latex'])
  assert.deepEqual(instructionSurfaceProblems({ system: supplied.system, userMessage: '' }), [],
    'the supplied mode does carry the guidance — it just is not native activation')
  assert.ok(supplied.system.includes('explicitly supplied skill text (not native activation)'))

  // The same assembled sections alone, without the supplied bodies, are the native mode.
  const native = buildInstructionSurface({
    sections: [{ name: 'deployment:persona-prefix', text: 'You are the Professor assistant.' }],
    persona: 'fallback',
  })
  assert.equal(native.mode, INSTRUCTION_MODES.NATIVE)
  assert.notEqual(native.system, supplied.system)
  assert.equal(native.suppliedSkills.length, 0)
})

test('assembled sections are used verbatim as the system prompt', () => {
  const surface = buildInstructionSurface({
    sections: [
      { name: 'persona', text: 'First section.' },
      { name: 'tools', text: 'Second section.' },
      { name: 'empty', text: '' },
    ],
    persona: 'fallback persona',
  })
  assert.equal(surface.system, 'First section.\n\nSecond section.')
  assert.deepEqual(surface.sectionNames, ['persona', 'tools'])
  assert.notEqual(surface.system, 'fallback persona')
})

test('the artifact token allowance is large enough to hold a full artifact call', () => {
  // The first phase used 2,000 and produced artifact tool calls that never completed.
  assert.ok(ARTIFACT_TOKEN_ALLOWANCE >= 8000,
    `the allowance must fit full tool-argument JSON, found ${ARTIFACT_TOKEN_ALLOWANCE}`)
  assert.ok(ARTIFACT_TOKEN_ALLOWANCE > 2000, 'the allowance that truncated the first phase is raised')
})

// ------------------------------------------------------------------ turn classification ----

test('a token-limited turn is INCOMPLETE even when it produced introductory text', () => {
  const introductory = '好的，我先读取资料……'
  const limited = classifyTurnOutcome({ finish: { kind: 'max-tokens' }, finalText: introductory })
  assert.equal(limited.status, 'INCOMPLETE')
  assert.match(limited.reason, /max-tokens/)
  assert.match(limited.reason, /cut off by the output allowance/)
})

test('a turn that ends by requesting tool calls is INCOMPLETE, never OBSERVED', () => {
  const pending = classifyTurnOutcome({ finish: { kind: 'tool-calls' }, finalText: 'Creating now…' })
  assert.equal(pending.status, 'INCOMPLETE')
  assert.match(pending.reason, /never concluded/)
})

test('OBSERVED requires the host to have reported stop', () => {
  const observed = classifyTurnOutcome({ finish: { kind: 'stop' }, finalText: 'Done.' })
  assert.equal(observed.status, 'OBSERVED')

  const empty = classifyTurnOutcome({ finish: { kind: 'stop' }, finalText: '   ' })
  assert.equal(empty.status, 'NO-RESPONSE')

  const failed = classifyTurnOutcome({ finish: { kind: 'error' }, finalText: 'partial' })
  assert.equal(failed.status, 'FAILED')

  const unknown = classifyTurnOutcome({ finish: { kind: 'something-new' }, finalText: 'text' })
  assert.equal(unknown.status, 'INCOMPLETE', 'an unrecognized finish must never be read as success')

  const absent = classifyTurnOutcome({ finish: null, finalText: 'text' })
  assert.equal(absent.status, 'INCOMPLETE', 'a missing finish reason is not a passing finish')
})

test('malformed partial tool JSON is refused instead of executed', () => {
  const truncated = parseToolArguments('{"kind":"note","title":"CSC3200 wide tab')
  assert.equal(truncated.ok, false)
  assert.match(truncated.reason, /not parseable JSON/)

  assert.deepEqual(parseToolArguments(''), { ok: false, reason: 'the tool call carried no argument text' })
  assert.equal(parseToolArguments('[1,2]').ok, false, 'an array is not a tool argument object')
  assert.equal(parseToolArguments('null').ok, false)

  const good = parseToolArguments('{"kind":"note","title":"short"}')
  assert.equal(good.ok, true)
  assert.deepEqual(good.args, { kind: 'note', title: 'short' })
})

// ------------------------------------------------------------------ returned paths ---------

test('a long title yields the truncated directory, and only the returned path may be used', async () => {
  const home = await makeHome('professor-m2b-longtitle-')
  const workspace = path.join(home, 'term')
  const materialRoot = path.join(workspace, 'CSC3200')
  await fs.mkdir(materialRoot, { recursive: true })
  await fs.writeFile(path.join(materialRoot, 'lecture.md'), '# Hash Tables\n\nAvg probes 2.94.\n')

  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: workspace })
  const execute = async (name, args) => tools[name].execute(args, exec)

  const setup = await runCourseSetup({ execute, materialRoot })
  assert.equal(setup.ok, true, JSON.stringify(setup.steps))

  // The exact title the live run was told to expect — 78 characters.
  const title = 'csc3200-week03-collision-resolution-and-resize-thresholds-latex-m2b-2026-10-13'
  assert.ok(title.length > 64, `the title must exceed the slugify limit, found ${title.length}`)

  const created = await execute('professor_artifact_create', {
    kind: 'note', title, course: COURSE_ID, format: 'latex',
    summary: 'Long-title path regression; never graded.',
  })
  assert.equal(created.created, true, JSON.stringify(created.problems ?? []))

  // slugify truncates at 64: the directory a reader would predict from the title does not exist.
  const expectedSlug = slugify(title)
  assert.equal(expectedSlug.length, 64, 'the slug really is truncated at 64 characters')
  assert.notEqual(created.directory, title,
    'the requested title is NOT the directory, so predicting it would be wrong')
  assert.ok(created.directory.endsWith(expectedSlug),
    `the tool returned ${JSON.stringify(created.directory)}, expected a slug ending ${expectedSlug}`)

  // Only the returned evidence may be used — and it must actually resolve on disk.
  const collected = artifactPathsFromCreate(created, { workspace })
  assert.deepEqual(collected.problems, [], JSON.stringify(collected.problems))
  assert.ok(collected.paths.length >= 1, 'at least one returned file path')
  assert.equal(collected.directory, created.directory)

  const contentTex = collected.paths.find((entry) => entry.path.endsWith('content.tex'))
  assert.ok(contentTex, `no content.tex among ${JSON.stringify(collected.paths)}`)
  const text = await fs.readFile(contentTex.path, 'utf8')
  assert.ok(text.length > 0, 'the returned path reads back real content')

  // The naive prediction from the full title does not resolve — which is why it must never be sent.
  await assert.rejects(
    () => fs.readFile(path.join(workspace, '.professor', 'notes', COURSE_ID, title, 'content.tex'), 'utf8'),
    (error) => error.code === 'ENOENT',
    'the predicted path from the untruncated title does not exist',
  )
})

// ------------------------------------------------------------------ delivery labelling -----

test('a missing artifact is a delivery failure, not a reason to grade the chat reply', () => {
  const result = assessDelivery({ createdPaths: [], contents: [], indexRegistration: ['a/INDEX.md'] })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => problem.includes('no artifact was delivered')))
  assert.equal(result.facts.artifact_delivered, false)
})

test('an artifact still holding TABLE_PLACEHOLDER is incomplete', () => {
  const result = assessDelivery({
    createdPaths: ['/w/notes/x/content.tex'],
    contents: [`${TABLE_PLACEHOLDER}\nSome prose.`],
    indexRegistration: ['a/INDEX.md'],
  })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => problem.includes(TABLE_PLACEHOLDER)))
  assert.equal(result.facts.table_placeholder_present, true)
  assert.equal(result.facts.artifact_delivered, true,
    'the file exists — it is the content that is incomplete')
})

test('an empty INDEX registration list is not successful registration', () => {
  const result = assessDelivery({
    createdPaths: ['/w/notes/x/content.tex'],
    contents: ['A complete four-column table.'],
    indexRegistration: [],
  })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => problem.includes('empty')))
  assert.equal(result.facts.index_registered, false)
})

test('registration, model output, compilation and visual acceptance stay separate facts', () => {
  const clean = assessDelivery({
    createdPaths: ['/w/notes/x/content.tex'],
    contents: ['A complete four-column table.'],
    indexRegistration: ['csc3200/notes/x/'],
    compiled: true,
    visuallyAccepted: false,
  })
  assert.deepEqual(clean.problems, [], JSON.stringify(clean.problems))
  assert.equal(clean.ok, true)
  assert.equal(clean.facts.compiled, true)
  assert.equal(clean.facts.visually_accepted, false,
    'compilation alone must not read as visual acceptance')
  assert.match(clean.facts.note, /separate facts/)
})

// ---------------------------------------------------------- pre-request readiness ----------

/**
 * The distinction the 2026-10-13 probe measured: the agent's assembled system prompt does **not**
 * contain the skill bodies (0/3 guidance markers), because the host loads a skill on demand
 * through its `skill` tool. So in native mode "the guidance is available" means *reachable* — the
 * skill tool is on offer and the host resolves bodies that carry the markers — not that the
 * markers were already pasted into the prompt. In supplied mode the runner pastes them itself,
 * and then they must literally be in the input.
 */
test('native mode is ready only when the skill tool is offered and the loaded bodies carry the guidance', async () => {
  const body = `${await readSkill('professor-notes')}\n${await readSkill('professor-latex')}`
  assert.ok(body.length > 0, 'the installed skill bodies must be readable from disk')

  assert.deepEqual(guidanceReadinessProblems({
    mode: INSTRUCTION_MODES.NATIVE,
    system: 'persona only',
    userMessage: 'write the note',
    resolvedSkillContents: [body],
    offeredTools: [...REQUIRED_M2B_TOOLS, 'skill'],
  }), [], 'reachable guidance with the skill tool on offer is ready')

  const withoutSkillTool = guidanceReadinessProblems({
    mode: INSTRUCTION_MODES.NATIVE,
    system: 'persona only',
    userMessage: 'write the note',
    resolvedSkillContents: [body],
    offeredTools: REQUIRED_M2B_TOOLS,
  })
  assert.equal(withoutSkillTool.length, 1, JSON.stringify(withoutSkillTool))
  assert.match(withoutSkillTool[0], /skill/,
    'without the host skill tool the guidance is unreachable, whatever the registry can resolve')

  const withoutBodies = guidanceReadinessProblems({
    mode: INSTRUCTION_MODES.NATIVE,
    system: 'persona only',
    userMessage: 'write the note',
    resolvedSkillContents: [],
    offeredTools: [...REQUIRED_M2B_TOOLS, 'skill'],
  })
  assert.equal(withoutBodies.length, 1, JSON.stringify(withoutBodies))
  assert.match(withoutBodies[0], /table-finishing/)
})

test('supplied mode requires the markers in the input actually sent', async () => {
  const body = `${await readSkill('professor-notes')}\n${await readSkill('professor-latex')}`
  const surface = buildInstructionSurface({
    sections: [{ name: 'deployment:persona-prefix', text: 'persona only' }],
    suppliedSkillText: [body],
    suppliedSkillNames: ['professor-notes', 'professor-latex'],
  })
  assert.equal(surface.mode, INSTRUCTION_MODES.SUPPLIED)
  assert.match(surface.modeLabel, /NOT evidence about native/)

  assert.deepEqual(guidanceReadinessProblems({
    mode: surface.mode,
    system: surface.system,
    userMessage: 'write the note',
    resolvedSkillContents: [body],
    offeredTools: [...REQUIRED_M2B_TOOLS, 'skill'],
  }), [], 'supplied text that carries the markers is ready')

  const missing = guidanceReadinessProblems({
    mode: surface.mode,
    system: 'persona only',
    userMessage: 'write the note',
    resolvedSkillContents: [body],
    offeredTools: [...REQUIRED_M2B_TOOLS, 'skill'],
  })
  assert.equal(missing.length, 1, JSON.stringify(missing))
  assert.match(missing[0], /table-finishing/)
})

test('every required tool missing from the offer is named', () => {
  const problems = guidanceReadinessProblems({
    mode: INSTRUCTION_MODES.NATIVE,
    system: 'x',
    userMessage: 'x',
    resolvedSkillContents: ['content.tex \\begin{tabular} sections[].body'],
    offeredTools: ['professor_artifact_create'],
  })
  const named = problems.join(' ')
  for (const tool of REQUIRED_M2B_TOOLS) {
    if (tool === 'professor_artifact_create') continue
    assert.ok(named.includes(tool), `the problem list must name the missing tool ${tool}`)
  }
  assert.ok(problems.some((problem) => problem.includes('read')),
    'a missing host read/edit tool blocks the finishing workflow exactly as it did on 2026-10-13')
})

test('a request naming a predicted artifact path is refused', async () => {
  const workspace = path.join(await makeHome('professor-m2b-predict-'), 'term')
  const predicted = path.join(workspace, '.professor', 'notes', COURSE_ID, 'some-title', 'content.tex')
  assert.equal(requestTextProblems({ text: `edit ${predicted}`, workspace }).length, 1,
    'a path predicted from a title must not appear in a model request — slugify truncates at 64')

  assert.deepEqual(
    requestTextProblems({ text: 'create the note, then edit whatever artifact_create returns', workspace }),
    [],
    'instructing the model to use returned evidence is fine',
  )
})
