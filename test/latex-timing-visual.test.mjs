/**
 * Stage 4: measurable durations, precise visual-coverage reporting, and an inspection flag that
 * never forces a pointless recompile.
 *
 * What these tests pin:
 *   1. `professor_artifact_create` reports `timings.create_ms` — this tool's own creation path;
 *   2. `professor_latex_compile` reports `timings.preflight_ms` / `timings.compile_ms` — the tool's
 *      stages only, never labelled as model-generation time;
 *   3. visual review states the pages actually inspected against the pages the compiler reported:
 *      six of sixteen pages is a `partial` review, not acceptance;
 *   4. recording an inspection against a byte-identical source does NOT recompile, while any edit
 *      to the source does — proven by the recorded shell calls.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { createFsGateway } from '../src/fs/gateway.js'
import { resolveProjectRoot } from '../src/paths/roots.js'
import { defineLatexCompileTool } from '../src/tools/latex.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

const AVAILABLE = { available: true, engine: 'pdflatex', path: '/usr/bin/pdflatex', searched: [], note: 'test probe' }
const PAGES_LINE = 'Output written on main.pdf (16 pages, 123456 bytes).\n'

function projectDocument({ material }) {
  return `schema_version: 1
project:
  id: term-2026
  name: 'Fall 2026'
courses:
  - course_id: csc3200
    course_code: CSC3200
    term: '2025-2026 Fall'
    display_name: Data Structures
    status: active
    sources:
      - path: ${material}
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
  default_format: latex
  overwrite_policy: never
  latex_template: null
web:
  enabled: true
  policy: conditional
`
}

async function fixture() {
  const home = await makeHome('professor-timing-')
  const project = path.join(home, 'term')
  const material = path.join(project, 'CSC3200')
  await writeFixture(home, 'term/CSC3200/01_Lectures/lecture-01.md', 'lecture material')
  await writeFixture(home, 'term/.professor/project.yaml', projectDocument({ material }))

  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })
  await tools.professor_session_bind.execute({ course: 'csc3200' }, exec)
  return { home, project, fake, tools, exec }
}

/** Compile tool with a recording runner that produces a fake 16-page PDF. */
function compileTool(f) {
  const calls = []
  const runner = async (spec) => {
    calls.push(spec)
    await fs.writeFile(path.join(spec.workdir, 'main.pdf'), '%PDF-1.4 fake 16 pages\n', 'utf8')
    return {
      runnerFailed: false, exitCode: 0, signal: null, timedOut: false, timeoutMs: spec.timeoutMs ?? null,
      stdout: PAGES_LINE, stderr: '',
    }
  }
  const tool = defineLatexCompileTool({
    resolveProject: (exec) => resolveProjectRoot(exec),
    gateway: createFsGateway({ ctx: f.fake.ctx }),
    runner,
    probeLatex: () => AVAILABLE,
    probeFor: () => AVAILABLE,
  })
  return { tool, calls }
}

const DIR = ['csc3200', 'recursion']

async function createdFixture() {
  const f = await fixture()
  const created = await f.tools.professor_artifact_create.execute({
    kind: 'note', title: 'Recursion', format: 'latex',
    sections: [{ heading: '递归结构', body: 'base case。' }],
  }, f.exec)
  assert.equal(created.created, true)
  return { ...f, created }
}

// --- timings -------------------------------------------------------------------

test('artifact creation reports its own measured duration, scoped to the tool call', async () => {
  const f = await fixture()
  const latex = await f.tools.professor_artifact_create.execute({
    kind: 'note', title: 'Timed', format: 'latex', sections: [{ heading: 'A', body: 'b' }],
  }, f.exec)
  assert.equal(typeof latex.timings?.create_ms, 'number')
  assert.ok(Number.isFinite(latex.timings.create_ms) && latex.timings.create_ms >= 0,
    `create_ms must be a measured duration, got ${latex.timings?.create_ms}`)

  const markdown = await f.tools.professor_artifact_create.execute({
    kind: 'note', title: 'Timed MD', format: 'markdown', sections: [{ heading: 'A', body: 'b' }],
  }, f.exec)
  assert.equal(typeof markdown.timings?.create_ms, 'number')

  const refused = await f.tools.professor_artifact_create.execute({ kind: 'note', title: 'Timed' }, f.exec)
  assert.equal(typeof refused.timings?.create_ms, 'number', 'even a refused call reports its duration')
})

test('compile timings cover preflight and compile separately and are null when not run', async () => {
  const f = await createdFixture()
  const { tool } = compileTool(f)

  const attempted = await tool.execute({ directory: DIR.join('/') }, f.exec)
  assert.equal(attempted.attempted, true)
  assert.equal(typeof attempted.timings.preflight_ms, 'number')
  assert.ok(attempted.timings.preflight_ms >= 0)
  assert.equal(typeof attempted.timings.compile_ms, 'number')
  assert.ok(attempted.timings.compile_ms >= 0)
})

test('a blocked compile still measures preflight and leaves compile null', async () => {
  const f = await createdFixture()
  const calls = []
  const tool = defineLatexCompileTool({
    resolveProject: (exec) => resolveProjectRoot(exec),
    gateway: createFsGateway({ ctx: f.fake.ctx }),
    runner: async (spec) => { calls.push(spec); throw new Error('never reached') },
    probeLatex: () => ({ available: false, engine: null, path: null, searched: [], note: 'no TeX' }),
    probeFor: () => ({ available: false, engine: null, path: null, searched: [], note: 'no TeX' }),
  })
  const report = await tool.execute({ directory: DIR.join('/') }, f.exec)
  assert.equal(report.verdict, 'compiler_unavailable')
  assert.equal(typeof report.timings.preflight_ms, 'number')
  assert.equal(report.timings.compile_ms, null, 'nothing compiled, so no compile duration is claimed')
  assert.equal(calls.length, 0)
})

// --- visual coverage -----------------------------------------------------------

test('visual review reports the pages actually inspected against the pages produced', async () => {
  const f = await createdFixture()

  const raw = compileTool(f)
  const produced = await raw.tool.execute({ directory: DIR.join('/') }, f.exec)
  assert.equal(produced.verdict, 'compilation_succeeded')
  assert.equal(produced.pdf.pages, 16, 'the page count comes from the compiler\'s own summary line')
  assert.equal(produced.pdf.visual_review, 'none', 'an un-inspected PDF has no visual review')
  assert.equal(produced.diagnostics.pages, 16)

  const six = await raw.tool.execute({
    directory: DIR.join('/'), visually_inspected: true, inspected_pages: 6,
  }, f.exec)
  assert.equal(six.pdf.pages, 16)
  assert.equal(six.pdf.inspected_pages, 6)
  assert.equal(six.pdf.visual_review, 'partial',
    'six inspected pages of sixteen is a partial review, never full acceptance')

  const all = compileTool(f)
  await all.tool.execute({ directory: DIR.join('/') }, f.exec)
  const full = await all.tool.execute({
    directory: DIR.join('/'), visually_inspected: true, inspected_pages: 16,
  }, f.exec)
  assert.equal(full.pdf.visual_review, 'full')

  const unstated = compileTool(f)
  await unstated.tool.execute({ directory: DIR.join('/') }, f.exec)
  const vague = await unstated.tool.execute({ directory: DIR.join('/'), visually_inspected: true }, f.exec)
  assert.equal(vague.pdf.visual_review, 'unscoped',
    'an inspection that does not state its pages cannot claim full coverage')
})

// --- recording an inspection without recompiling ---------------------------------

test('recording an inspection never recompiles an unchanged source — but an edit does', async () => {
  const f = await createdFixture()
  const { tool, calls } = compileTool(f)

  const first = await tool.execute({ directory: DIR.join('/') }, f.exec)
  assert.equal(first.attempted, true)
  assert.equal(first.reused_prior_compile, false)
  assert.equal(calls.length, 1)

  // The model inspected all 16 pages and reports that: no new compile may run for the flag alone.
  const inspected = await tool.execute({
    directory: DIR.join('/'), visually_inspected: true, inspected_pages: 16,
  }, f.exec)
  assert.equal(calls.length, 1, 'the unchanged source must not be recompiled to record an inspection')
  assert.equal(inspected.attempted, false)
  assert.equal(inspected.reused_prior_compile, true)
  assert.equal(inspected.verdict, 'compilation_succeeded')
  assert.equal(inspected.pdf.inspected, true)
  assert.equal(inspected.pdf.inspected_pages, 16)
  assert.equal(inspected.pdf.visual_review, 'full')
  assert.equal(inspected.pdf.pages, 16)
  assert.equal(inspected.timings.compile_ms, null, 'no compile ran, so no compile duration is claimed')
  assert.match(inspected.summary, /was visually inspected by the caller/)
  assert.match(inspected.summary, /without recompiling/i)

  // A changed body invalidates the record: the source must be compiled again.
  await fs.writeFile(path.join(f.project, '.professor', 'notes', ...DIR, 'content.tex'),
    '\\section*{递归结构}\n\nchanged body\n', 'utf8')
  const edited = await tool.execute({
    directory: DIR.join('/'), visually_inspected: true, inspected_pages: 6,
  }, f.exec)
  assert.equal(calls.length, 2, 'a changed source is compiled again')
  assert.equal(edited.attempted, true)
  assert.equal(edited.reused_prior_compile, false)
  assert.equal(edited.pdf.visual_review, 'none', 'old attestation does not cover a freshly changed PDF')

  // And a plain compile of unchanged source still runs when no inspection is claimed.
  const again = await tool.execute({ directory: DIR.join('/') }, f.exec)
  assert.equal(again.attempted, true, 'a compile request without an inspection flag always compiles')
  assert.equal(calls.length, 3)
})

test('inspection cannot reuse a PDF replaced after the recorded compile', async () => {
  const f = await createdFixture()
  const { tool, calls } = compileTool(f)
  await tool.execute({ directory: DIR.join('/') }, f.exec)
  await fs.writeFile(path.join(f.project, '.professor', 'notes', ...DIR, 'main.pdf'), '%PDF replacement', 'utf8')
  const report = await tool.execute({ directory: DIR.join('/'), visually_inspected: true, inspected_pages: 6 }, f.exec)
  assert.equal(calls.length, 2)
  assert.equal(report.reused_prior_compile, false)
})

test('a shell rejection retains a complete PDF result and classifies macOS write denials', async () => {
  const f = await createdFixture()
  const make = runner => defineLatexCompileTool({
    resolveProject: exec => resolveProjectRoot(exec), gateway: createFsGateway({ ctx: f.fake.ctx }),
    runner, probeLatex: () => AVAILABLE, probeFor: () => AVAILABLE,
  })
  const rejected = await make(async () => ({ runnerFailed: true, reason: 'denied' }))
    .execute({ directory: DIR.join('/') }, f.exec)
  assert.equal(rejected.pdf.produced, false)
  const denied = await make(async () => ({ exitCode: 1, stdout: '', stderr: 'xelatex12705.fls: Operation not permitted' }))
    .execute({ directory: DIR.join('/') }, f.exec)
  assert.equal(denied.failure_class, 'environment')
})
