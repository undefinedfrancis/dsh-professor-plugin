/**
 * M10 learning-state tests: tolerant parsing, merge-by-id, concurrency safety, the
 * lightweight-question invariant, and compression.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

test('field-update plans omit absent optional values for lossless host JSON', () => {
  const result = planStateUpdate({ courseId: 'csc3200', evidence: 'strong',
    change: { file: 'PROGRESS.md', field: 'current_unit', value: 'Unit 4', unit: undefined, topic: undefined, question: undefined } })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

import { apply } from '../src/plugin.js'
import {
  parseIndexMaterials, parseKnowledge, parseMistakes, parseProgress, unitEntryId,
} from '../src/state/parse.js'
import {
  compressState, DEFAULT_LINE_BUDGET, entryIdFor, evidencePermitsWrite, lineCount, mergeEntry,
  mergeMistakes, planStateUpdate, validateStateUpdate,
} from '../src/state/write.js'
import { createFsGateway } from '../src/fs/gateway.js'
import { createPathPolicy } from '../src/paths/policy.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

// --- tolerant parsing -------------------------------------------------------

test('fields are read without leaking emphasis markers, across real shapes', () => {
  // The real PROGRESS files use `**Label:** value` with the closing ** AFTER the colon.
  const text = [
    '# CSC3200 — Learning Progress',
    '## Current Position',
    '**Current Unit:** Lecture 07 — Structs (completed)  ',
    '**Current Topic:** OOP basics',
    '**Last Studied:** 2026-09-29',
    '**Recommended Next Step:** Lecture 08 — Stacks',
    '',
    '## Exam Preparation State',
    '**Exam Mode:** inactive',
  ].join('\n')

  const parsed = parseProgress(text)
  assert.equal(parsed.current_unit, 'Lecture 07 — Structs (completed)', 'no leading ** in the value')
  assert.equal(parsed.current_topic, 'OOP basics')
  assert.equal(parsed.last_studied, '2026-09-29')
  assert.equal(parsed.recommended_next_step, 'Lecture 08 — Stacks')
  assert.equal(parsed.exam_mode, 'inactive')
  assert.equal(parsed.present, true)
})

test('headings match by content, tolerating level and numbering drift', () => {
  const levelTwo = parseProgress([
    '# X', '## Current Position', '**Recommended Next Step:** A',
  ].join('\n'))
  const levelOne = parseProgress([
    '# X', '# 1. Current Position', '**Recommended Next Step:** A',
  ].join('\n'))
  assert.equal(levelTwo.recommended_next_step, 'A')
  assert.equal(levelOne.recommended_next_step, 'A', 'the template form parses too')

  const divesL1 = parseMistakes(['# X', '# 3. Requested Deep Dives', '| Date | Topic | Question (paraphrased) | Cause of difficulty | Suggested review action |', '|---|---|---|---|---|', '| 2026-09-22 | Pointer | Why? | Confusion | Re-trace |'].join('\n'))
  const divesL2 = parseMistakes(['# X', '## Requested Deep Dives', '| Date | Topic | Question (paraphrased) | Cause of difficulty | Suggested review action |', '|---|---|---|---|---|', '| 2026-09-22 | Pointer | Why? | Confusion | Re-trace |'].join('\n'))
  assert.equal(divesL1.deep_dives.length, 1, 'level-1 numbered heading')
  assert.equal(divesL2.deep_dives.length, 1, 'level-2 heading (real CSC3200 shape)')
  assert.equal(divesL1.deep_dives[0].topic, 'Pointer')
  assert.equal(divesL1.deep_dives[0].question, 'Why?')
  assert.equal(divesL1.deep_dives[0].review_action, 'Re-trace')
})

test('tables parse including single-character separator cells', () => {
  // The real INDEX.md uses `|---|---|---|` (three dashes per cell).
  const text = [
    '# X', '## File Inventory', '### 01_Lectures',
    '| Unit | Type | Title | Source | AI Note | Status |',
    '|---|---|---|---|---|---|',
    '| Lecture 01 | Lecture | Intro | `01_Lectures/a.pdf` | `AI-Notes/a.md` | studied |',
  ].join('\n')
  const rows = parseIndexMaterials(text)
  assert.equal(rows.length, 1, 'the separator row is skipped, the data row is not')
  assert.equal(rows[0].unit, 'Lecture 01')
  assert.equal(rows[0].status, 'studied')
})

test('knowledge entries and mistakes structure are preserved verbatim', () => {
  const knowledge = parseKnowledge([
    '# CSC — Agent Knowledge',
    '# 3. Core Concepts',
    '## Prefix Sum (前缀和)',
    'Definition:',
    '`PRE[i]` stores the sum.',
    '',
    '## Value Semantics',
    'Body here.',
  ].join('\n'))
  const core = knowledge.sections.find((section) => /Core Concepts/.test(section.heading))
  assert.ok(core, 'the Core Concepts section is found')
  assert.equal(core.concepts.length, 2, 'both concepts are captured')
  assert.equal(core.concepts[0].title, 'Prefix Sum (前缀和)')
  assert.match(core.concepts[0].body, /PRE\[i\]/)

  const mistakes = parseMistakes([
    '# X', '## Active Mistakes',
    '## Big-O vs Theta',
    'Confused O and Theta.',
    '',
    '# 2. Weak Topics',
    '| Topic | Weakness | Recommended Reinforcement |',
    '|---|---|---|',
    '| Recursion | Base case | Drill |',
  ].join('\n'))
  assert.equal(mistakes.active_mistakes.length, 1, 'the entry under Active Mistakes is captured')
  assert.equal(mistakes.active_mistakes[0].title, 'Big-O vs Theta')
  assert.equal(mistakes.weak_topics.length, 1, 'the next numbered section stops the mistake scan')
})

// --- the lightweight-question invariant ------------------------------------

test('evidence "none" plans no change, and nothing may be written for it', () => {
  assert.equal(evidencePermitsWrite('none'), false)
  assert.equal(evidencePermitsWrite('weak'), true)
  assert.equal(evidencePermitsWrite('strong'), true)

  const plan = planStateUpdate({ courseId: 'csc3200', evidence: 'none', reason: 'lightweight question' })
  assert.equal(plan.writable, false, 'a lightweight question is never writable')
  assert.equal(plan.plan.changes.length, 0, 'no changes are planned')
  assert.match(plan.plan.note, /lightweight question/)

  // Even with an entry supplied, evidence none wins.
  const forced = planStateUpdate({
    courseId: 'csc3200',
    evidence: 'none',
    entry: { file: 'PROGRESS.md', title: 'Unit', body: 'x' },
  })
  assert.equal(forced.writable, false)
  assert.equal(forced.plan.changes.length, 0)

  // And a plan that claims changes with no evidence is invalid.
  const invalid = validateStateUpdate({ evidence: 'none', changes: [{ file: 'PROGRESS.md', title: 'x' }] })
  assert.equal(invalid.ok, false)
  assert.match(invalid.errors.join(' '), /does not permit/)
})

test('evidence strong plans a change and validates', () => {
  const { writable, plan } = planStateUpdate({
    courseId: 'csc3200',
    evidence: 'strong',
    reason: 'solved the practice set',
    entry: { file: 'PROGRESS.md', title: 'Lecture 08', body: 'studied' },
  })
  assert.equal(writable, true)
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0].entry_id, entryIdFor('csc3200', 'Lecture 08'))
  assert.equal(validateStateUpdate(plan).ok, true)
  assert.equal(validateStateUpdate({ evidence: 'bogus', changes: [] }).ok, false)
})

// --- merge by entry_id ------------------------------------------------------

test('merging by entry_id updates in place instead of appending duplicates', () => {
  const id = entryIdFor('csc3200', 'Big-O vs Theta')
  const first = mergeEntry([], { entry_id: id, title: 'Big-O vs Theta', body: 'v1' })
  assert.equal(first.created, true)
  assert.equal(first.entries.length, 1)

  const second = mergeEntry(first.entries, { entry_id: id, title: 'Big-O vs Theta', body: 'v1' })
  assert.equal(second.created, false, 'the same entry is not created twice')
  assert.equal(second.entries.length, 1, 'no duplicate row')
  assert.equal(second.entries[0].body, 'v1', 'identical content does not duplicate')

  const third = mergeEntry(second.entries, { entry_id: id, title: 'Big-O vs Theta', body: 'v2' })
  assert.equal(third.entries.length, 1, 'still one row')
  assert.match(third.entries[0].body, /v1/, 'the earlier body is preserved by default')
  assert.match(third.entries[0].body, /v2/, 'the new body is appended')

  const overwritten = mergeEntry(third.entries, { entry_id: id, title: 'Big-O vs Theta', body: 'v3' }, { overwrite: true })
  assert.equal(overwritten.entries[0].body, 'v3', 'overwrite replaces deliberately')
})

test('mistake occurrences increment; deep dives dedupe on topic+question', () => {
  const first = mergeMistakes({ active_mistakes: [], deep_dives: [] }, {
    kind: 'mistake', course_id: 'csc3200', title: 'Big-O vs Theta', body: 'confused', last_seen: '2026-09-30',
  })
  assert.equal(first.created, true)
  assert.equal(first.active_mistakes[0].occurrences, 1)

  const again = mergeMistakes(first, {
    kind: 'mistake', course_id: 'csc3200', title: 'Big-O vs Theta', body: 'confused again', last_seen: '2026-10-01',
  })
  assert.equal(again.created, false, 'the same mistake is not duplicated')
  assert.equal(again.updated, true)
  assert.equal(again.active_mistakes.length, 1)
  assert.equal(again.active_mistakes[0].occurrences, 2, 'the occurrence counter grows')
  assert.equal(again.active_mistakes[0].last_seen, '2026-10-01')

  const dive1 = mergeMistakes(again, { kind: 'deep-dive', topic: 'Pointers', question: 'Why?' })
  const dive2 = mergeMistakes(dive1, { kind: 'deep-dive', topic: 'Pointers', question: 'Why?' })
  assert.equal(dive2.deep_dives.length, 1, 'the same deep dive is recorded once')
  const dive3 = mergeMistakes(dive2, { kind: 'deep-dive', topic: 'Pointers', question: 'When?' })
  assert.equal(dive3.deep_dives.length, 2, 'a different question is a new deep dive')
})

// --- compression ------------------------------------------------------------

test('compression keeps state present-tense and bounded, never deletes history', () => {
  const now = () => Date.parse('2026-10-01T00:00:00Z')
  const data = {
    progress: {
      units: [
        { unit: 'L01' }, { unit: 'L01' }, { unit: 'L01' }, { unit: 'L02' },
      ],
    },
    mistakes: {
      active_mistakes: [
        { title: 'rare', occurrences: 1 },
        { title: 'chronic', occurrences: 5 },
      ],
      resolved_mistakes: [],
      deep_dives: [
        { date: '2026-07-01', topic: 'old' },
        { date: '2026-09-28', topic: 'recent' },
      ],
    },
  }

  const { data: out, removed } = compressState(data, { now })
  assert.equal(out.progress.units.length, 2, 'duplicate unit rows collapse')
  assert.equal(removed > 0, true, 'compression reports what it dropped')
  assert.equal(out.mistakes.active_mistakes.length, 1, 'the chronic mistake moves out of active')
  assert.equal(out.mistakes.active_mistakes[0].title, 'rare')
  assert.equal(out.mistakes.resolved_mistakes.length, 1, 'history is marked resolved, not deleted')
  assert.equal(out.mistakes.resolved_mistakes[0].title, 'chronic')
  assert.equal(out.mistakes.deep_dives.length, 1, 'stale deep dives are dropped')
  assert.equal(out.mistakes.deep_dives[0].topic, 'recent')

  assert.ok(DEFAULT_LINE_BUDGET > 100, 'the budget is a real line budget')
  assert.equal(lineCount('a\nb\nc'), 3)
})

// --- end to end -------------------------------------------------------------

async function scenario() {
  const home = await makeHome('professor-state-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/CSC3200/01_Lectures/l1.md', '# L1\ncontent')
  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project, sessionId: 'session-A' })
  await tools.professor_project_init.execute({ project_id: 'term' }, exec)
  await tools.professor_course_manage.execute({
    action: 'register', course_code: 'CSC3200', display_name: 'DSA', term: 'F', source_path: path.join(project, 'CSC3200'),
  }, exec)
  await tools.professor_session_bind.execute({ course: 'CSC3200' }, exec)
  return { home, project, fake, tools, exec }
}

test('a lightweight question writes nothing; strong evidence writes and is guarded', async () => {
  const s = await scenario()
  const stateFile = path.join(s.project, '.professor/state/courses/csc3200/PROGRESS.md')

  await assert.rejects(() => fs.access(stateFile), (error) => error.code === 'ENOENT', 'no state yet')

  // Lightweight question: no write, no file created.
  const lightweight = await s.tools.professor_state_update.execute({
    file: 'PROGRESS.md', evidence: 'none', reason: 'quick definition question', title: 'X', body: 'y',
  }, s.exec)
  assert.equal(lightweight.writable, false, 'a lightweight question is never writable')
  assert.equal(lightweight.written, false)
  await assert.rejects(() => fs.access(stateFile), (error) => error.code === 'ENOENT',
    'the file is not created by a lightweight question')

  // Strong evidence: writes a field.
  const wrote = await s.tools.professor_state_update.execute({
    file: 'PROGRESS.md', evidence: 'strong', reason: 'finished lecture 1', field: 'current_unit', value: 'Lecture 01',
  }, s.exec)
  assert.equal(wrote.writable, true)
  assert.equal(wrote.written, true)
  const text = await fs.readFile(stateFile, 'utf8')
  assert.match(text, /\*\*Current Unit:\*\* Lecture 01/)

  // Reading restores it.
  const read = await s.tools.professor_state_read.execute({}, s.exec)
  assert.equal(read.present, true)
  assert.equal(read.summary.current_unit, 'Lecture 01')
  assert.match(read.summary.note, /continue from recommended_next_step/)

  // Dry run reports without touching the file.
  const before = await fs.readFile(stateFile, 'utf8')
  const dry = await s.tools.professor_state_update.execute({
    file: 'PROGRESS.md', evidence: 'strong', field: 'current_unit', value: 'Lecture 02', dry_run: true,
  }, s.exec)
  assert.equal(dry.written, false)
  assert.equal(dry.dryRun, true)
  assert.equal(await fs.readFile(stateFile, 'utf8'), before, 'dry run does not write')
})

test('two sessions on the same course cannot silently lose an update', async () => {
  const s = await scenario()
  const stateFile = path.join(s.project, '.professor/state/courses/csc3200/MISTAKES.md')

  const sessionA = makeExec({ cwd: s.project, sessionId: 'session-A' })
  const sessionB = makeExec({ cwd: s.project, sessionId: 'session-B' })
  await s.tools.professor_session_bind.execute({ course: 'CSC3200' }, sessionA)
  await s.tools.professor_session_bind.execute({ course: 'CSC3200' }, sessionB)

  const first = await s.tools.professor_state_update.execute({
    file: 'MISTAKES.md', evidence: 'strong', kind: 'mistake', title: 'Big-O vs Theta', body: 'confused',
  }, sessionA)
  assert.equal(first.written, true)
  const afterFirst = await fs.readFile(stateFile, 'utf8')

  // A concurrent writer that read the file BEFORE this write holds a stale version.
  const staleVersion = 'not-the-current-version'

  // Session B writes the same file with a stale observation: the gateway refuses, not loses.
  // Simulate by writing with the version read before A's write.
  const gateway = createFsGateway({ ctx: s.fake.ctx, logger: { warn() {} } })
  await assert.rejects(
    () => gateway.writeFile({
      filePath: path.join(s.project, '.professor/state/courses/csc3200/MISTAKES.md'),
      cwd: s.project,
      content: 'stale content',
      session: sessionB.agent.session,
      writePolicy: createPathPolicy({ roots: [path.join(s.project, '.professor')], label: 'write' }),
      expected: { kind: 'replaceIfVersion', version: staleVersion },
    }),
    (error) => error.code === 'PROFESSOR_PATH_DENIED' || error.code === 'FS_STALE_VERSION',
    'a stale write is refused, never silently applied',
  )
  assert.equal(await fs.readFile(stateFile, 'utf8'), afterFirst, 'the newer state survives')

  // Session B re-reads and merges instead: the mistake occurrence increments.
  const read = await s.tools.professor_state_read.execute({ file: 'MISTAKES.md' }, sessionB)
  assert.equal(read.present, true)
  const second = await s.tools.professor_state_update.execute({
    file: 'MISTAKES.md', evidence: 'strong', kind: 'mistake', title: 'Big-O vs Theta', body: 'confused again',
  }, sessionB)
  assert.equal(second.written, true, 'after re-reading, the write succeeds')
  const merged = await fs.readFile(stateFile, 'utf8')
  assert.match(merged, /Big-O vs Theta/)
  assert.equal((merged.match(/Big-O vs Theta/g) || []).length, 1, 'the mistake is one row, not two')
})

test('state is per course and per project, never inherited across sessions', async () => {
  const s = await scenario()
  await s.tools.professor_state_update.execute({
    file: 'PROGRESS.md', evidence: 'strong', field: 'current_unit', value: 'Lecture 01',
  }, s.exec)

  // A different session with no binding cannot read state (must not fall back).
  const other = makeExec({ cwd: s.project, sessionId: 'session-Z' })
  await assert.rejects(
    () => s.tools.professor_state_read.execute({}, other),
    (error) => error.code === 'PROFESSOR_STATE_COURSE_REQUIRED',
    'an unbound session gets no state by inheritance',
  )

  // And an explicit unknown course is rejected.
  await assert.rejects(
    () => s.tools.professor_state_read.execute({ course: 'PHY1001' }, s.exec),
    (error) => error.code === 'PROFESSOR_COURSE_MISSING',
  )
})

/**
 * A unit update must survive a write/re-read round trip.
 *
 * `parseProgress` and the renderer disagreed about identity: the table has no id column (that is
 * the upstream shape), the parser therefore produced rows without an `entry_id`, and the merge key
 * was built from the course id — which the *next* parse could not reproduce. So `mergeEntry` found
 * nothing to update and appended an identical row every time a unit was touched. The merge logic
 * itself was correct and unit-tested; only the round trip was broken, which is exactly the kind of
 * defect an end-to-end pass catches and a module test cannot.
 */
test('repeated updates to one unit merge in place across a write and re-read', async () => {
  const s = await scenario()
  const stateFile = path.join(s.project, '.professor/state/courses/csc3200/PROGRESS.md')
  const unit = { file: 'PROGRESS.md', evidence: 'strong', kind: 'unit', unit: 'Unit 2: graphs', title: 'Graphs' }

  const first = await s.tools.professor_state_update.execute({ ...unit, value: 'partial' }, s.exec)
  assert.equal(first.written, true, `the unit row is written: ${first.problems?.join('; ')}`)

  const second = await s.tools.professor_state_update.execute({ ...unit, value: 'solid' }, s.exec)
  assert.equal(second.written, true)

  const text = await fs.readFile(stateFile, 'utf8')
  assert.equal((text.match(/\| Unit 2: graphs \|/g) ?? []).length, 1,
    'the unit occupies exactly one table row after two updates')
  assert.match(text, /solid/, 'the merged row carries the latest understanding')

  // And the id the parser derives is the id the writer used, so a third update still merges.
  const parsed = parseProgress(text)
  assert.equal(parsed.units.length, 1)
  assert.equal(parsed.units[0].entry_id, unitEntryId('Unit 2: graphs'))

  const third = await s.tools.professor_state_update.execute({ ...unit, value: 'partial' }, s.exec)
  assert.equal(third.written, true)
  const after = await fs.readFile(stateFile, 'utf8')
  assert.equal((after.match(/\| Unit 2: graphs \|/g) ?? []).length, 1, 'still exactly one row')
})

/**
 * `professor_state_update` must not advertise a shape it refuses.
 *
 * The schema listed all four state files and a `concept` kind, while the implementation can only
 * rewrite PROGRESS.md and MISTAKES.md (those have renderers; KNOWLEDGE.md and INDEX.md are parse
 * only). A model following the published schema got a refusal for a shape the schema had just
 * offered. This pins the advertised contract to the implemented one, in both directions.
 */
test('the state update schema advertises only shapes the implementation accepts', async () => {
  const s = await scenario()
  const properties = s.tools.professor_state_update.parameters.properties
  const files = properties.file.enum
  assert.deepEqual(files, ['PROGRESS.md', 'MISTAKES.md'],
    'only the files with renderers are offered as writable')
  assert.doesNotMatch(files.join(' '), /KNOWLEDGE|INDEX/,
    'a read-only file must not appear as a writable target')

  const kinds = properties.kind.enum
  assert.deepEqual(kinds, ['mistake', 'deep-dive', 'field', 'unit'])
  assert.equal(kinds.includes('concept'), false,
    'the unimplemented `concept` kind must not be advertised')

  // Every advertised file/kind combination is actually accepted. A refusal here would mean the
  // schema lied again, so the assertion reads the refusal reason rather than just "it threw".
  const accepted = [
    { file: 'PROGRESS.md', kind: 'unit', unit: 'Unit 1', title: 'Unit one', evidence: 'strong' },
    { file: 'MISTAKES.md', kind: 'mistake', title: 'Off by one', body: 'loop bounds', evidence: 'strong' },
    { file: 'MISTAKES.md', kind: 'deep-dive', topic: 'Pointers', question: 'Why?', evidence: 'strong' },
    { file: 'PROGRESS.md', field: 'current_unit', value: 'Unit 1', evidence: 'strong' },
  ]
  for (const args of accepted) {
    const outcome = await s.tools.professor_state_update.execute(args, s.exec)
    assert.deepEqual(outcome.problems, [],
      `${args.file}/${args.kind ?? args.field} must be an accepted shape, got: ${outcome.problems?.join('; ')}`)
    assert.equal(outcome.written, true)
  }

  // A read-only target still refuses, and now says *why* in terms the caller can act on.
  const refused = await s.tools.professor_state_update.execute({
    file: 'KNOWLEDGE.md', evidence: 'strong', kind: 'concept', title: 'Big-O', body: 'growth',
  }, s.exec)
  assert.equal(refused.written, false)
  assert.equal(refused.problems.length, 1)
  assert.match(refused.problems[0], /read-only/i)
  assert.match(refused.problems[0], /professor_state_read/)
})
