/**
 * The twenty-eight end-to-end scenarios, executed against real temporary fixtures.
 *
 * This is the "does it actually work" gate, as opposed to the unit suites, which check one module
 * at a time. Every scenario here drives the *tools* the way a session would — in the order a
 * session would — and asserts on observable effects (files on disk, domain error codes, provenance
 * fields) rather than on internal calls. Fixtures are real directories under the OS temp dir and
 * each scenario gets a fresh one, so nothing can leak between scenarios.
 *
 * Scenarios 19–28 cover the production extraction path, and they are written to be **honest about
 * the machine they run on**: a scenario whose backend is absent reports `SKIP` with the reason it
 * looked for rather than passing on a mock. A mock-only pass would be worse than a skip, because it
 * would claim a production integration that was never exercised.
 *
 * Scope note: two properties are deliberately *not* re-derived here, because deriving them offline
 * would be a weaker test than the one already in place:
 *
 *   - the preset really mounts inside the real loader → `npm run verify:boot` (real `dsh`, cold
 *     start, twice) and `npm run verify:composition` (the loader's own `applyEntryPatches`);
 *   - the packaged tarball installs and self-tests → `node tools/verify-distribution.mjs`.
 *
 * Scenario 2 therefore checks the patch *source* structurally and says so, rather than pretending
 * to boot.
 *
 *   node tools/verify-e2e.mjs
 */

import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { apply } from '../src/plugin.js'
import { existingCandidates, ghostscriptCandidates, pythonCandidates } from '../src/extract/runtime.js'
import { formatSourceRef, sourceRefFromChunk } from '../src/provenance/source-ref.js'
import {
  createFakeContext, createFakeShell, createScriptedShell, makeExec, makeHome, writeFixture,
} from '../test/helpers/fake-harness.mjs'
import {
  buildPdfBytes, buildScannedPdfBytes, bundledPython, hasOfficeModules, writeOfficeFixtures,
} from '../test/helpers/fixtures.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * The backends this machine actually has, established by *running* them.
 *
 * Nothing below is inferred from a file name: a candidate that exists but answers nothing is not a
 * backend, and a scenario that needs one is skipped rather than quietly satisfied by a stub.
 */
const GHOSTSCRIPT_BIN = existingCandidates(ghostscriptCandidates({ env: process.env, pathDirs: [] }))[0] ?? null
const GHOSTSCRIPT_VERSION = GHOSTSCRIPT_BIN === null
  ? null
  : (() => {
    try {
      return execFileSync(GHOSTSCRIPT_BIN.path, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim()
    } catch {
      return null
    }
  })()
const BUNDLED_PYTHON = bundledPython()
const OFFICE_MODULES_PRESENT = BUNDLED_PYTHON !== null && hasOfficeModules(BUNDLED_PYTHON)

const NO_GHOSTSCRIPT = 'no Ghostscript on this machine'
  + ` (looked in ${ghostscriptCandidates({ env: process.env, pathDirs: [] }).map((entry) => entry.path).slice(0, 4).join(', ')})`
const NO_OFFICE = 'no bundled Python with python-docx / python-pptx / openpyxl on this machine'
  + ` (probed ${existingCandidates(pythonCandidates({ env: process.env })).length} interpreter candidate(s))`

/** A scenario that cannot run here. Reported and counted separately — never as a pass. */
const SKIP = Symbol('skip')
const skip = (reason) => ({ [SKIP]: reason })

// --- fixture ---------------------------------------------------------------

const LECTURE = '01_Lectures/lecture-01.md'
const TUTORIAL = '02_Tutorials/tutorial-01.md'
const NOTES = '01_Lectures/typed-notes.md'

/**
 * Every scratch directory a scenario creates, so the runner can remove them again.
 *
 * Without this the verifier leaked one temporary home per fixture — around thirty per run. That is
 * not merely untidy: the harness brokers filesystem access per directory, so an unbounded number of
 * live scratch roots is a real resource the process keeps holding, and a long run starts failing on
 * directories nobody asked about. Each scenario's home is now removed as soon as it finishes,
 * whether it passed or failed.
 */
const scratchDirs = []

/** `makeHome`, but tracked for cleanup. */
async function scratchHome(prefix) {
  const directory = await makeHome(prefix)
  scratchDirs.push(directory)
  return directory
}

/** Remove every scratch directory created since the last sweep. */
async function sweepScratch() {
  for (const directory of scratchDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

/** Build a fresh course workspace with three text sources inside a private temp home. */
async function fixture(options = {}) {
  const home = await scratchHome('professor-e2e-')
  const project = path.join(home, 'csc3200')
  await writeFixture(home, path.join('csc3200', LECTURE),
    '# Big-O notation\n\nBig-O notation describes the growth of work as the input grows.\n\n## Examples\n\nLinear scan is O(n).')
  await writeFixture(home, path.join('csc3200', TUTORIAL),
    '# Recursion\n\nA recursive function calls itself on a smaller input.\n\n```python\ndef fact(n):\n    return 1 if n == 0 else n * fact(n - 1)\n```')
  await writeFixture(home, path.join('csc3200', NOTES),
    '# Typed notes\n\nAmortised analysis averages the cost over a sequence of operations.')
  const fake = createFakeContext({ home, ...(options.services === undefined ? {} : { services: options.services }) })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  return { home, project, fake, tools, exec: makeExec({ cwd: project }), shell: options.services?.shell }
}

/** A registered + bound course, which most scenarios need as a starting point. */
async function readyFixture(options = {}) {
  const f = await fixture(options)
  await f.tools.professor_project_init.execute({}, f.exec)
  await f.tools.professor_course_manage.execute({
    action: 'register',
    course_code: 'CSC3200',
    display_name: 'Data Structures',
    term: '2025-2026 Fall',
    source_path: f.project,
    notes_root: path.join(f.project, 'Notes'),
  }, f.exec)
  await f.tools.professor_session_bind.execute({ action: 'bind', course: 'CSC3200' }, f.exec)
  return f
}

/**
 * A registered + bound course whose single source is one binary document, with the real shell seam
 * and a pre-run index — the shape every extraction scenario below starts from.
 */
async function documentFixture(relativePath, content, options = {}) {
  const home = await scratchHome('professor-extract-e2e-')
  const project = path.join(home, 'csc3200')
  await writeFixture(home, path.join('csc3200', relativePath), content)
  const shell = options.shell ?? createFakeShell({ cwd: home, timeoutMs: 60_000 })
  const fake = createFakeContext({ home, services: { shell } })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })
  await tools.professor_project_init.execute({}, exec)
  await tools.professor_course_manage.execute({
    action: 'register', course_code: 'CSC3200', display_name: 'Data Structures',
    term: '2025-2026 Fall', source_path: project, notes_root: path.join(project, 'AI-Notes'),
  }, exec)
  await tools.professor_session_bind.execute({ action: 'bind', course: 'CSC3200' }, exec)
  await tools.professor_index_sync.execute({}, exec)
  return {
    home, project, fake, tools, exec, shell,
    source: path.join(project, relativePath),
    chunksDir: path.join(project, '.professor/indexes/chunks'),
  }
}

/** The single chunk store a one-document project produced. */
async function readStore(fixture_) {
  const entries = await fs.readdir(fixture_.chunksDir)
  assert.equal(entries.length, 1, `expected one chunk store, found ${entries.join(', ')}`)
  return JSON.parse(await fs.readFile(path.join(fixture_.chunksDir, entries[0]), 'utf8'))
}

/** A page body long enough to become its own chunk, so a page number is unambiguous. */
const pageBody = (title, markers) => [`# ${title}`, '',
  ...markers.flatMap((marker) => [`Paragraph about ${marker} with enough words to fill a chunk.`, ''])].join('\n')

const TWO_PAGE_PDF = buildPdfBytes({
  pages: [
    pageBody('Alpha Section', ['algebra', 'algorithms', 'amortised cost', 'asymptotic bounds', 'arrays', 'abstraction']),
    pageBody('Beta Section', ['binary search', 'balanced trees', 'breadth first search', 'big-O notation', 'buckets']),
  ],
})

/** A workbook far past the row cap, to prove a huge sheet is bounded rather than read. */
const OVERSIZED_WORKBOOK_SCRIPT = `
import sys
from openpyxl import Workbook
workbook = Workbook()
sheet = workbook.active
sheet.title = "Huge"
sheet.append(["Index", "Value"])
for index in range(0, 4000):
    sheet.append([index, "value %d" % index])
workbook.save(sys.argv[1])
`

/** SHA-256 of every file under a tree, so "nothing changed" is byte-exact. */
async function digestTree(root, { skip: shouldSkip = () => false } = {}) {
  const digest = createHash('sha256')
  const walk = async (current) => {
    const entries = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      const relative = path.relative(root, target)
      if (shouldSkip(relative)) continue
      if (entry.isDirectory()) {
        await walk(target)
        continue
      }
      if (entry.isSymbolicLink()) continue
      digest.update(relative).update(await fs.readFile(target))
    }
  }
  await walk(root)
  return digest.digest('hex')
}

/** Only the course material: the plugin's own index, and the note root a scenario writes into. */
const MATERIAL_ONLY = { skip: (relative) => relative.startsWith('.professor') || relative.split(path.sep)[0] === 'Notes' }

/** Run `fn` and return the thrown error, failing if it does not throw. */
async function refuse(fn) {
  try {
    await fn()
  } catch (error) {
    return error
  }
  assert.fail('expected this call to be refused')
}

const projectFile = (f) => path.join(f.project, '.professor', 'project.yaml')
const readIfPresent = async (file) => {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

// --- the scenarios ---------------------------------------------------------

const SCENARIOS = [

  ['1. the plugin mounts its full surface and nothing else', async () => {
    const f = await fixture()
    assert.equal(f.tools.professor_project_init !== undefined, true)

    const names = f.fake.tools.map((tool) => tool.name)
    assert.equal(names.length, 22, `expected 22 tools, got ${names.length}`)
    assert.equal(new Set(names).size, 22, 'tool names are unique')
    for (const name of names) assert.match(name, /^professor_[a-z_]+$/, `${name} is namespaced`)

    // A provider is registered exactly once, and it offers the six bundled skills.
    assert.equal(f.fake.providers.length, 1, 'one skill provider per plugin instance')
    const provider = f.fake.providers[0]({ resolveRoots: async () => ({}) })
    const candidates = await provider.list()
    assert.equal(candidates.length, 6, `expected 6 skills, got ${candidates.length}`)
    for (const candidate of candidates) assert.match(candidate.name, /^professor-/)

    f.fake.disposeAll()
  }],

  ['2. the bundle declares only a preset, never a deployment-level plugin', async () => {
    // Structural check on the patch source (the real mount is proven by verify:boot / verify:composition).
    const patch = await fs.readFile(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
    const inserts = patch.split('\n').filter((line) => /^\s*-\s*insert:\s*$/.test(line))
    assert.equal(inserts.length, 1, 'the patch performs exactly one insert')

    const insertColumns = patch.split('\n').filter((line) => /^\s*-\s*insert:/.test(line)).map((line) => line.search(/\S/))
    assert.equal(insertColumns[0], 0, 'the insert is a top-level row')
    assert.match(patch, /@deepseek-ai\/dsh-agent-preset/)
    assert.match(patch, /id: preset-professor/)
    assert.doesNotMatch(patch, /^\s*-\s*id:\s*professor-spike\s*$/m,
      'the old deployment-level mount row is gone')

    // The plugin name must appear *deeper* than the insert list, i.e. inside the preset's plugins,
    // and never as a sibling of the preset itself.
    const pluginLines = patch.split('\n')
      .map((line, index) => ({ line, index, column: line.search(/\S/) }))
      .filter((entry) => /name:\s*dsh-professor-spike/.test(entry.line))
    assert.equal(pluginLines.length, 1, 'the plugin is named exactly once')
    assert.ok(pluginLines[0].column > insertColumns[0] + 2,
      'the plugin row is nested inside the preset, not a deployment-level row')
  }],

  ['3. project init is create-only and refuses a second call', async () => {
    const f = await fixture()
    const first = await f.tools.professor_project_init.execute({}, f.exec)
    assert.equal(first.created, true)
    assert.equal(first.schemaVersion, 1)
    const before = await fs.readFile(projectFile(f), 'utf8')
    assert.match(before, /schema_version: 1/)

    const second = await f.tools.professor_project_init.execute({}, f.exec)
    assert.equal(second.created, false, 'a second init must not create anything')
    assert.equal(second.alreadyPresent, true)
    assert.equal(await fs.readFile(projectFile(f), 'utf8'), before,
      'the existing document is byte-identical after the refused init')
  }],

  ['4. courses register, list and resolve by code; duplicates are rejected', async () => {
    const f = await fixture()
    await f.tools.professor_project_init.execute({}, f.exec)
    const registered = await f.tools.professor_course_manage.execute({
      action: 'register',
      course_code: 'CSC3200',
      display_name: 'Data Structures',
      term: '2025-2026 Fall',
      source_path: f.project,
    }, f.exec)
    assert.deepEqual(registered.changed, ['csc3200'])
    assert.equal(registered.course.course_id, 'csc3200', 'the id is derived from the code')
    assert.equal(registered.course.sources.length, 1, 'the source root was recorded')

    // Registering the same identity again is refused rather than silently duplicated.
    const duplicate = await f.tools.professor_course_manage.execute({
      action: 'register',
      course_code: 'CSC3200',
      display_name: 'Data Structures',
      term: '2025-2026 Fall',
      source_path: f.project,
    }, f.exec).then(() => undefined, (error) => error)
    assert.ok(duplicate !== undefined, 'a duplicate identity is refused')
    assert.equal(duplicate.code, 'PROFESSOR_COURSE_EXISTS',
      'a duplicate identity gets its own code, distinct from malformed input')

    const listed = await f.tools.professor_course_list.execute({}, f.exec)
    assert.equal(listed.projectPresent, true)
    assert.equal(listed.courses.length, 1)
    assert.equal(listed.courses[0].course_code, 'CSC3200')

    // Resolution accepts the documented spellings, and reports the matched course.
    const byCode = await f.tools.professor_course_list.execute({ course: 'CSC3200' }, f.exec)
    assert.equal(byCode.resolved.status, 'found')
    assert.equal(byCode.resolved.course.course_id, 'csc3200')
  }],

  ['5. a session binding never leaks to another session', async () => {
    const f = await readyFixture()
    const other = makeExec({ cwd: f.project, sessionId: 'session-other' })

    // Session A is bound; session B is not, and must say so rather than fall back.
    const bound = await f.tools.professor_session_status.execute({}, f.exec)
    assert.equal(bound.bound, true)
    assert.equal(bound.course_id, 'csc3200')

    const unboundStatus = await f.tools.professor_session_status.execute({}, other)
    assert.equal(unboundStatus.bound, false, 'the other session reports no binding')
    assert.equal(unboundStatus.course_id, null)
    assert.equal(unboundStatus.history.length, 0, 'and no history is inherited')

    const error = await refuse(() => f.tools.professor_state_update.execute(
      { file: 'PROGRESS.md', evidence: 'strong', field: 'current_unit', value: 'Unit 1' }, other,
    ))
    assert.equal(error.code, 'PROFESSOR_STATE_COURSE_REQUIRED',
      'an unbound session fails loudly instead of inheriting')

    // The other session's own state file was never created, and A's binding is unchanged.
    const sessions = await fs.readdir(path.join(f.project, '.professor/state/sessions'))
    assert.deepEqual(sessions, ['session-test.json'],
      'only the bound session has a binding file, and its history is append-only')
  }],

  ['6. indexing is incremental, deterministic, and never edit source material', async () => {
    const f = await readyFixture()
    const sourcesBefore = await digestTree(f.project, { skip: (r) => r.startsWith('.professor') })

    const first = await f.tools.professor_index_sync.execute({}, f.exec)
    assert.equal(first.total, 3, 'the three text sources were indexed')
    assert.equal(first.added, 3)
    assert.equal(first.assigned, 3, 'the registered source root assigned every file')
    assert.equal(first.unassigned, 0)

    // Indexing itself must not have touched a single byte of course material.
    assert.equal(await digestTree(f.project, { skip: (r) => r.startsWith('.professor') }), sourcesBefore,
      'course material is byte-identical after indexing')

    const second = await f.tools.professor_index_sync.execute({}, f.exec)
    assert.equal(second.added, 0, 'a second sync adds nothing')
    assert.equal(second.reused, 3, 'unchanged files are reused')
    assert.equal(second.changed, 0)

    // Deleting a file marks the record missing instead of dropping it. The deletion is deliberate,
    // so the source digest is re-taken afterwards and the "unchanged" claim is made before it.
    await fs.rm(path.join(f.project, TUTORIAL))
    const third = await f.tools.professor_index_sync.execute({}, f.exec)
    assert.equal(third.missing, 1, 'the vanished file is marked missing')
    const index = JSON.parse(await fs.readFile(path.join(f.project, '.professor/indexes/files.json'), 'utf8'))
    assert.equal(index.files.length, 3, 'no record is deleted')

    // And the surviving sources still hold exactly the bytes they were written with.
    assert.equal(await fs.readFile(path.join(f.project, LECTURE), 'utf8'),
      '# Big-O notation\n\nBig-O notation describes the growth of work as the input grows.\n\n## Examples\n\nLinear scan is O(n).',
      'the lecture file is byte-identical')
    assert.equal(await fs.readFile(path.join(f.project, NOTES), 'utf8'),
      '# Typed notes\n\nAmortised analysis averages the cost over a sequence of operations.',
      'the typed-notes file is byte-identical')
  }],

  ['7. extraction chunks text sources and is idempotent', async () => {
    const f = await readyFixture()
    await f.tools.professor_index_sync.execute({}, f.exec)
    const first = await f.tools.professor_extract.execute({}, f.exec)
    assert.equal(first.extracted, 3, 'all three text files were extracted')
    assert.equal(first.unsupported, 0)
    assert.ok(first.chunksWritten > 0)

    const stores = await fs.readdir(path.join(f.project, '.professor/indexes/chunks'))
    assert.ok(stores.length >= 3, `one chunk store per file, got ${stores.length}`)

    const second = await f.tools.professor_extract.execute({}, f.exec)
    assert.equal(second.extracted, 0, 'nothing is re-extracted without rebuild')
    assert.equal(second.skipped, 3)
  }],

  ['8. search is budgeted and every hit carries provenance', async () => {
    const f = await readyFixture()
    await f.tools.professor_index_sync.execute({}, f.exec)
    await f.tools.professor_extract.execute({}, f.exec)

    const found = await f.tools.professor_search.execute({ query: 'Big-O notation growth' }, f.exec)
    assert.ok(found.results.length > 0, 'the query matched something')
    const hit = found.results[0]
    for (const field of ['chunk_id', 'file_id', 'course_id', 'category', 'start_line', 'end_line', 'relative_path']) {
      assert.ok(hit[field] !== undefined, `a hit carries ${field}`)
    }
    assert.equal(hit.course_id, 'csc3200', 'the hit knows its course')
    assert.equal(hit.page ?? null, null, 'an unknown page is omitted rather than invented')

    const nothing = await f.tools.professor_search.execute({ query: 'quantum chromodynamics' }, f.exec)
    assert.equal(nothing.results.length, 0)
    assert.match(nothing.diagnostics.note, /no chunk matched/)
  }],

  ['9. unsupported formats are reported honestly, with OCR off', async () => {
    const f = await fixture()
    await writeFixture(f.home, path.join('csc3200', 'slides.pdf'), '%PDF-1.4 not really a pdf')
    await writeFixture(f.home, path.join('csc3200', 'figure.png'), 'not really a png')
    await writeFixture(f.home, path.join('csc3200', 'sheet.docx'), 'not really a docx')
    await f.tools.professor_project_init.execute({}, f.exec)
    await f.tools.professor_course_manage.execute({
      action: 'register', course_code: 'CSC3200', display_name: 'Data Structures',
      term: '2025-2026 Fall', source_path: f.project,
    }, f.exec)
    await f.tools.professor_index_sync.execute({}, f.exec)
    const outcome = await f.tools.professor_extract.execute({}, f.exec)

    assert.equal(outcome.unsupported, 3, 'pdf, png and docx are all unsupported')
    for (const result of outcome.results.filter((entry) => entry.status === 'unsupported')) {
      assert.ok(typeof result.reason === 'string' && result.reason.length > 0, 'each is refused with a reason')
    }
    assert.equal(outcome.capabilities.ocr, false)
    assert.equal(outcome.capabilities.pdfText, null, 'no PDF backend is claimed')

    // The reasons must describe the plugin's own boundary, not assert an unobserved host fact.
    const boundary = JSON.stringify({
      note: outcome.capabilities.note,
      gating: outcome.capabilities.gating,
      unobserved: outcome.capabilities.unobserved,
    })
    assert.doesNotMatch(boundary, /on this machine/i)
    assert.ok(outcome.capabilities.unobserved.length >= 2, 'the unobserved backends are named with reasons')
  }],

  ['10. a lightweight question writes no state at all', async () => {
    const f = await readyFixture()
    const stateDir = path.join(f.project, '.professor/state')
    const before = await digestTree(stateDir)

    const planned = await f.tools.professor_state_update.execute({
      file: 'PROGRESS.md', evidence: 'none', field: 'current_unit', value: 'ignore me',
    }, f.exec)
    assert.equal(planned.changed ?? planned.written ?? false, false, 'evidence none plans no change')

    assert.equal(await digestTree(stateDir), before, 'nothing on disk changed for a lightweight question')
  }],

  ['11. strong evidence writes, and a repeat unit merges instead of duplicating', async () => {
    const f = await readyFixture()
    const written = await f.tools.professor_state_update.execute({
      file: 'PROGRESS.md', evidence: 'strong', field: 'current_unit', value: 'Unit 1: complexity',
    }, f.exec)
    assert.equal(written.written, true, 'strong evidence writes')
    assert.equal(written.updated, true)

    const progressPath = path.join(f.project, '.professor/state/courses/csc3200/PROGRESS.md')
    assert.match(await fs.readFile(progressPath, 'utf8'), /Unit 1: complexity/)

    // The same unit is merged on its entry_id, not appended as a second row.
    const unit = { file: 'PROGRESS.md', evidence: 'strong', kind: 'unit', unit: 'Unit 2: graphs', title: 'Graphs' }
    const firstUnit = await f.tools.professor_state_update.execute({ ...unit, value: 'partial' }, f.exec)
    assert.equal(firstUnit.written, true, `the unit row is written (problems: ${firstUnit.problems?.join('; ')})`)
    const secondUnit = await f.tools.professor_state_update.execute({ ...unit, value: 'solid' }, f.exec)
    assert.equal(secondUnit.written, true)
    const body = await fs.readFile(progressPath, 'utf8')
    // The unit is rendered as one table row; a second row would mean it was appended.
    assert.equal((body.match(/\| Unit 2: graphs \|/g) ?? []).length, 1,
      'the unit has exactly one table row, so the second update merged in place')
    assert.match(body, /solid/, 'the merged row carries the newer value')

    // A mistake is deduplicated by identity and its occurrence counter grows.
    const mistake = { file: 'MISTAKES.md', evidence: 'strong', kind: 'mistake', title: 'Average vs amortised' }
    await f.tools.professor_state_update.execute({ ...mistake, body: 'confused the two' }, f.exec)
    await f.tools.professor_state_update.execute({ ...mistake, body: 'still confused' }, f.exec)
    const mistakes = await fs.readFile(path.join(f.project, '.professor/state/courses/csc3200/MISTAKES.md'), 'utf8')
    assert.equal((mistakes.match(/Average vs amortised/g) ?? []).length, 1,
      'the mistake is recorded once, with its occurrence count raised instead')

    // KNOWLEDGE.md is read-only here, and says so in its refusal rather than failing opaquely.
    const refused = await f.tools.professor_state_update.execute({
      file: 'KNOWLEDGE.md', evidence: 'strong', kind: 'concept', title: 'Big-O', body: 'growth of work',
    }, f.exec)
    assert.equal(refused.written, false, 'KNOWLEDGE.md is not writable by this tool')
    assert.ok(refused.problems.some((problem) => /read-only/i.test(problem)),
      `the refusal explains that the file is read-only: ${refused.problems.join('; ')}`)
  }],

  ['12. the note format gate asks when the format was not requested', async () => {
    const f = await readyFixture()
    const asked = await f.tools.professor_artifact_create.execute({
      kind: 'note', title: 'Ambiguous Format',
    }, f.exec)
    assert.equal(asked.format_required, true, 'no format means the tool must ask')
    assert.equal(asked.created, false, 'nothing is written when the format is unknown')
    assert.ok(asked.options.length >= 2, 'the caller is offered the formats')
    assert.match(asked.question ?? '', /格式|format/i)

    const explicit = await f.tools.professor_artifact_create.execute({
      kind: 'note', title: 'Explicit Markdown', format: 'markdown',
    }, f.exec)
    assert.equal(explicit.format_required, false)
    assert.equal(explicit.created, true)
    assert.equal(explicit.format_source, 'explicit-request')
    assert.match(explicit.files[0].relative, /\.md$/)
  }],

  ['13. an unsafe output root is refused rather than written to', async () => {
    const f = await fixture()
    await f.tools.professor_project_init.execute({}, f.exec)
    // Point the notes root at the plugin's own state directory.
    const document = await fs.readFile(projectFile(f), 'utf8')
    await fs.writeFile(projectFile(f), document.replace(
      /outputs:\n(\s*)notes_root:[^\n]*\n/,
      `outputs:\n$1notes_root: ${JSON.stringify(path.join(f.project, '.professor/state'))}\n`,
    ))
    await f.tools.professor_course_manage.execute({
      action: 'register', course_code: 'CSC3200', display_name: 'Data Structures',
      term: '2025-2026 Fall', source_path: f.project,
    }, f.exec)
    await f.tools.professor_session_bind.execute({ action: 'bind', course: 'CSC3200' }, f.exec)

    const error = await refuse(() => f.tools.professor_artifact_create.execute(
      { kind: 'note', title: 'Should Not Land', format: 'markdown' }, f.exec,
    ))
    assert.equal(error.code, 'PROFESSOR_ARTIFACT_ROOT_UNSAFE',
      `writing into .professor/state must be refused, got ${error.code}: ${error.message}`)
    assert.equal(await readIfPresent(path.join(f.project, '.professor/state/csc3200/Should Not Land.md')),
      undefined, 'nothing was written')
  }],

  ['14. an existing artifact is never silently overwritten', async () => {
    const f = await readyFixture()
    // A note's content is a structured `sections` list, not a free-form body.
    const args = {
      kind: 'note',
      title: 'Repeatable Note',
      format: 'markdown',
      sections: [{ heading: 'Explanation', body: 'the first version' }],
    }
    const first = await f.tools.professor_artifact_create.execute(args, f.exec)
    assert.equal(first.created, true)
    // `root` is absolute; `directory` and `filename` are relative to it.
    const target = path.join(first.root, first.directory, first.filename)
    assert.equal((await fs.readFile(target, 'utf8')).includes('the first version'), true)

    // Default policy is `never`: the second attempt is refused and the original is untouched.
    const second = await f.tools.professor_artifact_create.execute({
      ...args, sections: [{ heading: 'Explanation', body: 'the second version' }],
    }, f.exec)
    assert.equal(second.created, false, 'the default policy refuses to overwrite')
    const afterRefusal = await fs.readFile(target, 'utf8')
    assert.equal(afterRefusal.includes('the first version'), true,
      'the original content survives the refused overwrite')
    assert.equal(afterRefusal.includes('the second version'), false,
      'not one byte of the refused content reached the file')

    // An explicit versioned write keeps both, as a new file.
    const versioned = await f.tools.professor_artifact_create.execute({
      ...args,
      sections: [{ heading: 'Explanation', body: 'the second version' }],
      overwrite: { policy: 'versioned' },
    }, f.exec)
    assert.equal(versioned.created, true, 'an explicit versioned policy is honoured')
    assert.match(versioned.filename, /-v2\.md$/, 'the second version gets a -v2 suffix')
    assert.equal((await fs.readFile(target, 'utf8')).includes('the first version'), true,
      'the first version still stands')
  }],

  ['15. an exam review carries its sections, labels and provenance', async () => {
    const f = await readyFixture()
    const review = await f.tools.professor_artifact_create.execute({
      kind: 'review',
      title: 'Midterm Review',
      format: 'markdown',
      confirmed_scope: ['lectures 1-6', 'tutorials 1-3'],
      unconfirmed_scope: ['lecture 7 was not covered in class'],
      weak_points: ['amortised analysis'],
      important_topics: ['recursion'],
      high_frequency: ['asymptotic notation'],
      recurring_mistakes: ['confusing average and amortised cost'],
      unresolved: ['the proof of the amortised bound is still hand-wavy'],
      practice: [
        { question: 'Why is a dynamic array append O(1) amortised?', origin: 'original' },
        { question: 'Adapt: prove the recursion depth bound.', origin: 'adapted' },
        { question: 'New: derive the recurrence for merge sort.', origin: 'generated' },
      ],
      source_chunks: [{ relative_path: LECTURE }],
    }, f.exec)
    assert.equal(review.created, true, `the review was written (problems: ${review.problems?.join('; ')})`)

    const body = await fs.readFile(path.join(review.root, review.directory, review.filename), 'utf8')
    for (const heading of ['已确认考试范围', '薄弱点', '重点与难点', '高频基础', '未确认范围', '未解决清单']) {
      assert.ok(body.includes(heading), `the review renders the "${heading}" section`)
    }
    assert.ok(body.includes('原题'), 'a professor original is labelled 原题')
    assert.ok(body.includes('改编题'), 'an adapted question is labelled 改编题')
    assert.ok(body.includes('新编练习'), 'a generated question is labelled 新编练习')
    assert.match(body, /资料依据/, 'the provenance block is present')
    assert.equal(review.citations.refs, 1)
  }],

  ['16. a LaTeX note project is generated, and compilation never overclaims', async () => {
    const f = await readyFixture()
    await writeFixture(f.home, 'template/main.tex', '\\documentclass{article}\\begin{document}\\input{content.tex}\\end{document}')
    const document = await fs.readFile(projectFile(f), 'utf8')
    await fs.writeFile(projectFile(f), document.replace(
      /notes:\n(\s*)latex_template:[^\n]*\n/,
      `notes:\n$1latex_template: ${JSON.stringify(path.join(f.home, 'template'))}\n`,
    ))

    const project = await f.tools.professor_artifact_create.execute({
      kind: 'note', title: 'Recursion Notes', format: 'latex', body: 'A recursive function calls itself.',
    }, f.exec)
    assert.equal(project.created, true)

    const directory = path.join(project.root, project.directory)
    const produced = await fs.readdir(directory)
    assert.ok(produced.some((name) => name.endsWith('.tex')), `a .tex file was produced: ${produced.join(', ')}`)
    assert.ok(produced.some((name) => name === 'main.tex'), 'the template entry point was copied')

    // The shared template is read-only: its bytes are unchanged.
    assert.equal(await fs.readFile(path.join(f.home, 'template/main.tex'), 'utf8'),
      '\\documentclass{article}\\begin{document}\\input{content.tex}\\end{document}')

    // Compilation without a shell seam must not claim success.
    const compiled = await f.tools.professor_latex_compile.execute({ directory }, f.exec)
    assert.ok(['source_generated', 'compiler_unavailable', 'compilation_failed', 'compilation_succeeded']
      .includes(compiled.verdict), `verdict is from the honest vocabulary, got ${compiled.verdict}`)
    if (compiled.verdict !== 'compilation_succeeded') {
      assert.equal(compiled.pdf.produced, false, 'a non-success verdict never reports a PDF')
    }
    assert.equal(compiled.pdf.inspected, false,
      'the plugin never claims to have visually inspected a PDF it did not inspect')
  }],

  ['17. migration is read-only, dry-runnable, idempotent, and audited', async () => {
    const f = await fixture()
    await f.tools.professor_project_init.execute({}, f.exec)
    const registry = path.join(f.home, '01_Learning/Registry')
    // The upstream registry is a Markdown table plus one `## Field` document per course — not YAML.
    await writeFixture(f.home, '01_Learning/Registry/COURSES.md',
      '# Active Courses\n\n'
      + '| Course Code | Course Name | Semester | Status | Registry |\n'
      + '|---|---|---|---|---|\n'
      + `| CSC4200 | Advanced Algorithms | 2026-2027 Fall | active | Courses/CSC4200.md |\n\n`
      + '# Archived Courses\n')
    await writeFixture(f.home, '01_Learning/Registry/Courses/CSC4200.md',
      '# Course Configuration\n\n# 1. Course Identity\n\n'
      + '## Course Code\n```\nCSC4200\n```\n\n'
      + '## Course Name\n```\nAdvanced Algorithms\n```\n\n'
      + '## Semester\n```\n2026-2027 Fall\n```\n\n'
      + '## Status\n```\nactive\n```\n\n'
      + '# 2. External Course Workspace\n\n'
      + `## Course Root\n\`\`\`\n${f.project}\n\`\`\`\n\n`
      + `## AI Notes Output\n\`\`\`\n${path.join(f.project, 'Notes')}\n\`\`\`\n\n`
      + '# 4. Preferences\n\n## Default Note Format\n```\nMarkdown\n```\n')
    const registryBefore = await digestTree(registry)

    // Dry run writes nothing at all.
    const dry = await f.tools.professor_course_manage.execute({
      action: 'import', registry_dir: registry, dry_run: true,
    }, f.exec)
    assert.equal(dry.migration.dryRun, true)
    assert.equal(dry.migration.planWritten, false, 'a dry run writes no plan')
    assert.ok(dry.migration.plan.courses.length >= 1, 'the plan still reports what it would do')
    assert.equal(await readIfPresent(path.join(f.project, '.professor/migrations')), undefined,
      'a dry run creates no migrations directory')

    // The real run writes a plan and an audit-log entry, and imports the course.
    const applied = await f.tools.professor_course_manage.execute({
      action: 'import', registry_dir: registry,
    }, f.exec)
    assert.equal(applied.migration.planWritten, true)
    assert.equal(applied.migration.logRecorded, true)
    assert.ok(applied.changed.includes('csc4200'), `the course was imported: ${applied.changed.join(', ')}`)
    const logDirectory = path.join(f.project, '.professor/migrations')
    const logFiles = await fs.readdir(logDirectory)
    assert.ok(logFiles.some((name) => name.includes('log')), `a migration log exists: ${logFiles.join(', ')}`)
    assert.equal(await digestTree(registry), registryBefore, 'the source registry is byte-identical')

    // Re-running is a no-op that is still recorded.
    const again = await f.tools.professor_course_manage.execute({
      action: 'import', registry_dir: registry,
    }, f.exec)
    assert.equal(again.changed.length, 0, 'a second import changes nothing')
    const listed = await f.tools.professor_course_list.execute({}, f.exec)
    assert.equal(listed.courses.length, 1, 'the course was imported exactly once')

    const diagnostics = await f.tools.professor_diagnostics.execute({}, f.exec)
    assert.ok(diagnostics.migration.status !== undefined, 'diagnostics reports migration status')
    assert.ok(diagnostics.migration.plans >= 1, 'and counts the recorded plan')
  }],

  ['18. diagnostics is honest, bounded, and agrees with the package version', async () => {
    const f = await readyFixture()
    await f.tools.professor_index_sync.execute({}, f.exec)
    const report = await f.tools.professor_diagnostics.execute({}, f.exec)

    const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
    assert.equal(report.plugin.version, manifest.version, 'the reported version is the package version')
    assert.equal(report.plugin.preset_scoped, true)
    assert.equal(report.skills.count, 6)
    assert.equal(report.skills.watcher.healthy, true)

    // Every field the milestone asks for is present.
    for (const key of ['project', 'session', 'sandbox', 'skills', 'index', 'chunks', 'extraction',
      'latex', 'artifacts', 'state', 'migration', 'roots', 'warnings', 'limitations', 'notImplemented']) {
      assert.ok(report[key] !== undefined, `diagnostics exposes ${key}`)
    }

    // The limitations list is honest in both directions.
    assert.ok(report.notImplemented.length > 0)
    const features = report.notImplemented.map((entry) => entry.feature).join(' | ')
    assert.match(features, /OCR/i)
    assert.doesNotMatch(features, /learning state|note and review/i,
      'a completed milestone must not still be listed as missing')

    // And it never carries a secret, an env dump, a prompt, or file contents.
    const serialized = JSON.stringify(report)
    assert.doesNotMatch(serialized,
      /"(env|environment|process_env|api_key|apiKey|secret|token|prompt|contents?|state_contents)"\s*:/i)
    assert.doesNotMatch(serialized, /-----BEGIN [A-Z ]*PRIVATE KEY-----/)
  }],

  // --- production extraction: real backends, real coordinates, honest failures ----------------

  ['19. a real PDF is extracted through the production runner, with page coordinates', async () => {
    if (GHOSTSCRIPT_VERSION === null) return skip(NO_GHOSTSCRIPT)
    const f = await documentFixture('lectures/two-page.pdf', TWO_PAGE_PDF)
    const before = await digestTree(f.project, MATERIAL_ONLY)
    const pdfBytes = await fs.readFile(f.source)

    const outcome = await f.tools.professor_extract.execute({}, f.exec)
    assert.equal(outcome.extracted, 1, `the PDF extracted: ${JSON.stringify(outcome.results)}`)
    assert.equal(outcome.unsupported, 0)
    assert.equal(outcome.failed, 0)
    // Interpreter selection prefers PyMuPDF when an interpreter actually imports it and falls back
    // to Ghostscript otherwise; which one this machine provides is an observation, not a promise,
    // so the assertion pins the *pairing* rather than one spelling.
    const extractor = outcome.results[0].extractor
    assert.ok(['pdf-fitz', 'pdf-ghostscript'].includes(extractor), `the observed backend is named: ${extractor}`)
    assert.ok(outcome.results[0].chunks > 0, 'chunks were written')

    const pdf = outcome.capabilities.pdf
    assert.equal(pdf.text, true, 'the text capability describes what ran')
    assert.equal(pdf.backend, extractor === 'pdf-fitz' ? 'pymupdf' : 'ghostscript')
    // Rendering is reported separately from text extraction and from visual inspection.
    assert.equal(outcome.capabilities.pageRender !== undefined, true, 'page rendering has its own block')
    assert.equal(pdf.visual, false, 'extraction is not visual inspection')
    assert.equal(pdf.pageCoordinates, true, 'real page numbers are available')
    assert.equal(pdf.ocr, false, 'OCR stays disabled')

    const store = await readStore(f)
    const pages = [...new Set(store.chunks.map((chunk) => chunk.page))].sort((a, b) => a - b)
    assert.deepEqual(pages, [1, 2], 'both real pages reached the chunks; none was synthesised')
    assert.ok(store.chunks.every((chunk) => Number.isInteger(chunk.page) && chunk.page >= 1))

    // The source PDF is byte-identical: extraction reads, never writes.
    assert.equal(createHash('sha256').update(await fs.readFile(f.source)).digest('hex'),
      createHash('sha256').update(pdfBytes).digest('hex'), 'the PDF is byte-identical')
    assert.equal(await digestTree(f.project, MATERIAL_ONLY), before, 'no course material changed')
  }],

  ['20. a search hit carries the page the backend reported, not a guess', async () => {
    if (GHOSTSCRIPT_VERSION === null) return skip(NO_GHOSTSCRIPT)
    const f = await documentFixture('lectures/two-page.pdf', TWO_PAGE_PDF)
    await f.tools.professor_extract.execute({}, f.exec)

    // Vocabulary that only exists on page two, so a page-1 answer would be a wrong answer.
    const pageTwo = await f.tools.professor_search.execute({ query: 'binary search balanced trees buckets' }, f.exec)
    assert.ok(pageTwo.results.length > 0, 'the page-two vocabulary is searchable')
    assert.equal(pageTwo.results[0].page, 2, 'the hit is attributed to the page it is really on')
    assert.match(formatSourceRef(sourceRefFromChunk(pageTwo.results[0])), /p\.2/)

    const pageOne = await f.tools.professor_search.execute({ query: 'amortised cost asymptotic bounds arrays' }, f.exec)
    assert.equal(pageOne.results[0].page, 1)

    // An unknown coordinate is omitted, never invented: the markdown sources have no pages.
    const g = await readyFixture()
    await g.tools.professor_index_sync.execute({}, g.exec)
    await g.tools.professor_extract.execute({}, g.exec)
    const text = await g.tools.professor_search.execute({ query: 'Big-O notation growth' }, g.exec)
    assert.equal(text.results[0].page ?? null, null, 'a text file claims no page number')
  }],

  ['21. a real DOCX is extracted in document order, with no page claimed', async () => {
    if (!OFFICE_MODULES_PRESENT) return skip(NO_OFFICE)
    const fixtures = await writeOfficeFixtures(await scratchHome('professor-e2e-office-'))
    const f = await documentFixture('notes/lecture.docx', await fs.readFile(fixtures.docx))
    const before = await digestTree(f.project, MATERIAL_ONLY)

    const outcome = await f.tools.professor_extract.execute({}, f.exec)
    assert.equal(outcome.extracted, 1, JSON.stringify(outcome.results))
    assert.equal(outcome.results[0].extractor, 'office-docx')

    const store = await readStore(f)
    const headings = store.chunks.map((chunk) => chunk.heading).filter(Boolean)
    assert.ok(headings.includes('Big-O Notation'), `the first heading survives: ${headings.join(' | ')}`)
    assert.ok(headings.includes('Examples'), `the nested heading survives: ${headings.join(' | ')}`)
    assert.ok(headings.indexOf('Big-O Notation') < headings.indexOf('Examples'), 'document order is kept')
    const text = store.chunks.map((chunk) => chunk.text).join('\n')
    assert.match(text, /growth of work/, 'the body paragraph is present')
    assert.match(text, /\| Hash table \| O\(1\) average \|/, 'table text is present as table text')
    assert.ok(store.chunks.every((chunk) => chunk.page === null),
      'a DOCX has no page numbers without rendering, so none is invented')

    assert.equal(outcome.capabilities.office.docx, true)
    assert.equal(outcome.capabilities.office.backend, 'bundled-python')
    assert.equal(await digestTree(f.project, MATERIAL_ONLY), before, 'the DOCX is byte-identical')
  }],

  ['22. a real PPTX keeps every slide number through to the citation', async () => {
    if (!OFFICE_MODULES_PRESENT) return skip(NO_OFFICE)
    const fixtures = await writeOfficeFixtures(await scratchHome('professor-e2e-office-'))
    const f = await documentFixture('slides/lecture.pptx', await fs.readFile(fixtures.pptx))

    const outcome = await f.tools.professor_extract.execute({}, f.exec)
    assert.equal(outcome.extracted, 1, JSON.stringify(outcome.results))
    assert.equal(outcome.capabilities.office.pptx, true)
    assert.equal(outcome.capabilities.office.slideCoordinates, true, 'slide coordinates were observed')

    const store = await readStore(f)
    const slides = [...new Set(store.chunks.map((chunk) => chunk.slide))].sort((a, b) => a - b)
    assert.deepEqual(slides, [1, 2], 'both real slides reached the chunks')
    assert.ok(store.chunks.every((chunk) => chunk.page === null), 'a slide number is not a page number')

    const found = await f.tools.professor_search.execute({ query: 'amortised analysis doubling argument' }, f.exec)
    const hit = found.results.find((result) => result.slide === 1)
    assert.ok(hit, `a slide-1 chunk is searchable (slides seen: ${found.results.map((r) => r.slide).join(',')})`)
    assert.match(hit.heading, /Slide 1/, 'the heading names the slide')
    assert.match(formatSourceRef(sourceRefFromChunk(hit)), /slide 1/, 'the citation names the slide')

    // Speaker notes are off unless asked for: content appearing in a citation by accident would be
    // a privacy and an accuracy problem both.
    const allText = store.chunks.map((chunk) => chunk.text).join('\n')
    assert.doesNotMatch(allText, /doubling argument/, 'speaker notes were not extracted by default')
  }],

  ['23. a real XLSX keeps sheet identity and reports formulas without recalculating', async () => {
    if (!OFFICE_MODULES_PRESENT) return skip(NO_OFFICE)
    const fixtures = await writeOfficeFixtures(await scratchHome('professor-e2e-office-'))
    const f = await documentFixture('sheets/figures.xlsx', await fs.readFile(fixtures.xlsx))

    const outcome = await f.tools.professor_extract.execute({}, f.exec)
    assert.equal(outcome.extracted, 1, JSON.stringify(outcome.results))
    assert.equal(outcome.capabilities.office.xlsx, true)

    const store = await readStore(f)
    const headings = store.chunks.map((chunk) => chunk.heading).filter(Boolean)
    assert.ok(headings.some((heading) => /Sheet 1: Revenue/.test(heading)), `sheet 1 is named: ${headings.join(' | ')}`)
    assert.ok(headings.some((heading) => /Sheet 2: Notes/.test(heading)), 'sheet 2 is named')
    const text = store.chunks.map((chunk) => chunk.text).join('\n')
    assert.match(text, /=SUM\(B2:B3\)/, 'the formula is reported as the formula it is')
    assert.match(text, /amortised cost/, "the second sheet's content is present")
    assert.doesNotMatch(text, /\|\s*30\s*\|/, 'the formula total was not computed anywhere')
  }],

  ['24. a scanned PDF is unsupported, names OCR, and writes no chunks', async () => {
    if (GHOSTSCRIPT_VERSION === null) return skip(NO_GHOSTSCRIPT)
    const f = await documentFixture('lectures/scanned.pdf', buildScannedPdfBytes())

    const outcome = await f.tools.professor_extract.execute({}, f.exec)
    assert.equal(outcome.extracted, 0, 'nothing was extracted')
    assert.equal(outcome.unsupported, 1)
    assert.equal(outcome.failed, 0, 'an empty text layer is not a parse failure')
    assert.match(outcome.results[0].reason, /no text layer/)
    assert.match(outcome.results[0].reason, /OCR is disabled/)
    assert.equal(outcome.capabilities.pdf.ocr, false, 'OCR is still reported as disabled')
    assert.equal(outcome.capabilities.pdf.visual, false, 'and nothing was rendered')
    assert.deepEqual(await fs.readdir(f.chunksDir).catch(() => []), [],
      'no chunk store is written for a document with no text')
  }],

  ['25. with no backend at all, extraction is unsupported rather than failed', async () => {
    // Every command exits 127 as if the binary were not there — what an empty host looks like.
    const shell = createScriptedShell(() => ({ exitCode: 127, stderr: 'command not found' }))
    const f = await documentFixture('lectures/two-page.pdf', TWO_PAGE_PDF, { shell })

    const outcome = await f.tools.professor_extract.execute({}, f.exec)
    assert.equal(outcome.unsupported, 1, 'the document is unsupported, not failed')
    assert.equal(outcome.failed, 0, 'an absent backend is not a failure of the document')
    assert.equal(outcome.capabilities.pdf.text, false)
    assert.equal(outcome.capabilities.pdf.backend, null)
    assert.match(outcome.results[0].reason, /no PDF text backend was observed/)
    assert.equal(outcome.capabilities.probe.attempted, true, 'the probe really ran; it found nothing')
    assert.ok(outcome.capabilities.probe.reason !== null, 'and the failure to observe is reported')

    const report = await f.tools.professor_diagnostics.execute({}, f.exec)
    assert.equal(report.extraction.capabilities.pdf.text, false,
      'diagnostics agrees with the extract tool about the same probe')
  }],

  ['26. a backend timeout is a failure with the deadline named', async () => {
    const shell = createScriptedShell((command) => {
      if (command.includes('probe_python.py')) {
        return { stdout: JSON.stringify({ ok: true, python: '3.12.14', modules: { fitz: '1.24.9' }, missing: [] }) }
      }
      // The argv is shell-quoted into one command line, so the path is not at the very end of the
      // string — a suffix match would silently miss and turn this into a different failure.
      if (/\.pdf/.test(command)) return { timedOut: true, exitCode: null }
      return { exitCode: 0 }
    })
    const f = await documentFixture('lectures/two-page.pdf', TWO_PAGE_PDF, { shell })

    const outcome = await f.tools.professor_extract.execute({}, f.exec)
    assert.equal(outcome.failed, 1, `a backend that stopped is a failure (got ${JSON.stringify(outcome.results)})`)
    assert.equal(outcome.unsupported, 0, 'the backend exists, so this is not "unsupported"')
    assert.match(outcome.results[0].reason, /timed out after \d+ms/)
    assert.deepEqual(await fs.readdir(f.chunksDir).catch(() => []), [],
      'a failed extraction writes no chunks')
  }],

  ['27. an oversized workbook is bounded, and the truncation is reported', async () => {
    if (!OFFICE_MODULES_PRESENT) return skip(NO_OFFICE)
    const scratch = await scratchHome('professor-e2e-oversize-')
    const oversized = path.join(scratch, 'huge.xlsx')
    execFileSync(BUNDLED_PYTHON.path, ['-', oversized], {
      input: OVERSIZED_WORKBOOK_SCRIPT, encoding: 'utf8', timeout: 60_000,
    })
    const f = await documentFixture('sheets/huge.xlsx', await fs.readFile(oversized))

    const outcome = await f.tools.professor_extract.execute({}, f.exec)
    assert.equal(outcome.extracted, 1, JSON.stringify(outcome.results))
    assert.ok(Array.isArray(outcome.results[0].truncated) && outcome.results[0].truncated.length > 0,
      'the cap is reported rather than applied silently')
    assert.ok(outcome.results[0].truncated.some((note) => /rows capped|cell/i.test(note)),
      `the report names what was capped: ${outcome.results[0].truncated.join(' | ')}`)
    assert.ok(outcome.warnings.length > 0, 'and it surfaces as a warning on the tool result')

    // Bounded means bounded: the far end of a 4000-row sheet never enters the store.
    const store = await readStore(f)
    const text = store.chunks.map((chunk) => chunk.text).join('\n')
    assert.doesNotMatch(text, /value 3999/, 'the far end of the sheet was not read')
    assert.match(text, /value 1\b/, 'but the used region really was read')
    assert.ok(text.length < 4 * 1024 * 1024, 'and the extracted text stayed inside the ceiling')
  }],

  ['28. artifact citations preserve the real page and slide coordinates', async () => {
    if (GHOSTSCRIPT_VERSION === null) return skip(NO_GHOSTSCRIPT)
    const f = await documentFixture('lectures/two-page.pdf', TWO_PAGE_PDF)
    await f.tools.professor_extract.execute({}, f.exec)

    const found = await f.tools.professor_search.execute({ query: 'binary search balanced trees' }, f.exec)
    assert.equal(found.results[0].page, 2)
    const ref = sourceRefFromChunk(found.results[0])
    assert.equal(ref.page, 2, 'the SourceRef carries the page')
    assert.match(formatSourceRef(ref), /p\.2/)

    const artifact = await f.tools.professor_artifact_create.execute({
      kind: 'note',
      title: 'Page Provenance Note',
      format: 'markdown',
      sections: [{ heading: 'Explanation', body: 'Binary search halves the search space each step.' }],
      source_chunks: found.results,
    }, f.exec)
    assert.equal(artifact.created, true, `artifact problems: ${artifact.problems?.join('; ')}`)

    const body = await fs.readFile(path.join(artifact.root, artifact.directory, artifact.filename), 'utf8')
    assert.match(body, /资料依据/, 'the citation block is present')
    assert.match(body, /p\.2/, 'and it preserves the real page number')

    // The same route for a slide deck, when one can be produced here.
    if (OFFICE_MODULES_PRESENT) {
      const fixtures = await writeOfficeFixtures(await scratchHome('professor-e2e-office-'))
      const deck = await documentFixture('slides/lecture.pptx', await fs.readFile(fixtures.pptx))
      await deck.tools.professor_extract.execute({}, deck.exec)
      const slides = await deck.tools.professor_search.execute({ query: 'recursive function smaller input' }, deck.exec)
      const slideHit = slides.results.find((result) => result.slide === 2)
      assert.ok(slideHit, `a slide-2 chunk is searchable (slides: ${slides.results.map((r) => r.slide).join(',')})`)
      const deckNote = await deck.tools.professor_artifact_create.execute({
        kind: 'note', title: 'Slide Provenance Note', format: 'markdown',
        sections: [{ heading: 'Explanation', body: 'Recursion reduces the problem size each call.' }],
        source_chunks: slides.results,
      }, deck.exec)
      assert.equal(deckNote.created, true)
      const deckBody = await fs.readFile(path.join(deckNote.root, deckNote.directory, deckNote.filename), 'utf8')
      assert.match(deckBody, /slide 2/, 'the artifact block preserves the real slide number')
    }
  }],

]

// --- runner ----------------------------------------------------------------

let failures = 0
let skipped = 0
console.log(`Professor end-to-end scenarios (${SCENARIOS.length})\n`)
for (const [name, run] of SCENARIOS) {
  try {
    const outcome = await run()
    if (outcome !== null && typeof outcome === 'object' && outcome[SKIP] !== undefined) {
      skipped += 1
      console.log(`SKIP  ${name}`)
      console.log(`      ${outcome[SKIP]}`)
      continue
    }
    console.log(`PASS  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL  ${name}`)
    console.log(`      ${String(error?.message ?? error).split('\n').join('\n      ')}`)
    if (error?.code !== undefined) console.log(`      code: ${error.code}`)
  } finally {
    // Every scenario's scratch home is removed as soon as the scenario ends — on success, on skip
    // and on failure alike — so a run holds a bounded number of live directories from start to end.
    await sweepScratch()
  }
}

const passed = SCENARIOS.length - failures - skipped
console.log(`\n${passed}/${SCENARIOS.length} 通过${skipped > 0 ? `（${skipped} 项因缺少后端跳过）` : ''}`)
console.log(failures === 0 ? 'ALL PASS' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
