/**
 * End-to-end M8 flow: index → extract → search, through the registered tools.
 *
 * Proves the pipeline the design describes: extract writes chunk stores under
 * `.professor/indexes/chunks/`, updates `extraction_status` on the index, reports unsupported
 * formats honestly, and search returns budgeted, provenance-bearing results without ever writing.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

async function scenario() {
  const home = await makeHome('professor-e2e-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/CSC3200/01_Lectures/lecture-01.md',
    '# Binary Search\n\nBinary search divides a sorted array in half each step.\n\n## Complexity\n\nIt runs in logarithmic time.\n')
  await writeFixture(home, 'courses/term/CSC3200/01_Lectures/lecture-02.md',
    '# Hash Tables\n\nA hash table maps keys to buckets using a hash function.\n')
  await writeFixture(home, 'courses/term/CSC3200/03_Assignments/hw1.md',
    '# Homework 1\n\nImplement binary search and analyse its complexity.\n')
  await writeFixture(home, 'courses/term/GFN1000/L1.pdf', '%PDF-1.4 fake')
  await writeFixture(home, 'courses/term/GFN1000/logo.png', 'png-bytes')

  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })

  await tools.professor_project_init.execute({ project_id: 'term-2026' }, exec)
  await tools.professor_course_manage.execute({
    action: 'register',
    course_code: 'CSC3200',
    display_name: 'DSA',
    term: '2025-2026 Fall',
    source_path: path.join(project, 'CSC3200'),
  }, exec)
  await tools.professor_course_manage.execute({
    action: 'register',
    course_code: 'GFN1000',
    display_name: 'GFN1000',
    term: '2025-2026 Fall',
    source_path: path.join(project, 'GFN1000'),
  }, exec)
  await tools.professor_index_sync.execute({}, exec)

  return { home, project, tools, exec }
}

async function readIndex(project) {
  return JSON.parse(await fs.readFile(path.join(project, '.professor', 'indexes', 'files.json'), 'utf8'))
}

test('extract chunks text, marks unsupported formats, and never touches source material', async () => {
  const s = await scenario()
  const before = await fs.readFile(path.join(s.project, 'CSC3200', '01_Lectures', 'lecture-01.md'), 'utf8')

  const result = await s.tools.professor_extract.execute({}, s.exec)

  assert.equal(result.processed, 5, 'all five indexed files are considered')
  assert.equal(result.extracted, 3, 'the three markdown files extract')
  assert.equal(result.unsupported, 2, 'the PDF (no runner) and the PNG (OCR off) are unsupported')
  assert.ok(result.chunksWritten > 0)

  const unsupportedById = new Map(result.results.filter((entry) => entry.status === 'unsupported').map((entry) => [entry.file_id, entry]))
  assert.equal(unsupportedById.size, 2)
  const pngOutcome = [...unsupportedById.values()].find((entry) => /OCR/.test(entry.reason ?? ''))
  assert.ok(pngOutcome, 'the image failure names OCR as the reason')

  // The index now carries honest extraction statuses.
  const index = await readIndex(s.project)
  const byPath = new Map(index.files.map((record) => [record.relative_path, record]))
  assert.equal(byPath.get('CSC3200/01_Lectures/lecture-01.md').extraction_status, 'extracted')
  assert.equal(byPath.get('GFN1000/logo.png').extraction_status, 'unsupported')
  assert.equal(byPath.get('GFN1000/logo.png').extractor, null)

  // Chunk stores exist under .professor only; source material is byte-identical.
  const chunksDir = path.join(s.project, '.professor', 'indexes', 'chunks')
  const stores = await fs.readdir(chunksDir)
  assert.ok(stores.length >= 3, `chunk stores were written: ${stores.join(', ')}`)
  assert.equal(await fs.readFile(path.join(s.project, 'CSC3200', '01_Lectures', 'lecture-01.md'), 'utf8'), before,
    'source material is never modified')
  await assert.rejects(() => fs.access(path.join(s.project, 'GFN1000', 'logo.png.json')), (error) => error.code === 'ENOENT',
    'no chunk store is written for an unsupported file')
})

test('a second extract run skips already-extracted files unless rebuild is set', async () => {
  const s = await scenario()
  await s.tools.professor_extract.execute({}, s.exec)
  const second = await s.tools.professor_extract.execute({}, s.exec)
  assert.ok(second.skipped >= 3, 'already-extracted files are skipped')
  assert.equal(second.extracted, 0)

  const rebuilt = await s.tools.professor_extract.execute({ rebuild: true }, s.exec)
  assert.ok(rebuilt.extracted >= 3, 'rebuild re-extracts')
})

test('search returns provenance-bearing chunks under the configured budget', async () => {
  const s = await scenario()
  await s.tools.professor_extract.execute({}, s.exec)

  const found = await s.tools.professor_search.execute({ query: 'binary search complexity' }, s.exec)
  assert.ok(found.results.length > 0, 'the lecture is found')
  assert.ok(found.results.length <= 8, 'the default budget (max_chunks: 8) is respected')

  const top = found.results[0]
  assert.match(top.chunk_id, /^c_[0-9a-f]{16}$/)
  assert.equal(top.course_id, 'csc3200')
  assert.ok(['lectures', 'assignments', 'unassigned'].includes(top.category))
  assert.ok(typeof top.relative_path === 'string' && top.relative_path.length > 0, 'provenance includes a path')
  assert.ok(top.start_line >= 1)
  assert.ok(top.score > 0)
  assert.ok(top.matched_terms.includes('binary') || top.matched_terms.includes('search'))
  assert.ok(typeof top.source_note === 'string')

  // Budget: never return more than requested.
  const budgeted = await s.tools.professor_search.execute({ query: 'binary search', max_chunks: 1 }, s.exec)
  assert.equal(budgeted.results.length, 1)
  assert.equal(budgeted.dropped >= 1, true)
  assert.match(budgeted.diagnostics.note, /budget reached/)

  // Course filter keeps other courses out of the results.
  const scoped = await s.tools.professor_search.execute({ query: 'binary', course: 'csc3200' }, s.exec)
  assert.ok(scoped.results.length > 0)
  assert.equal(scoped.results.every((result) => result.course_id === 'csc3200'), true)

  // Category filter.
  const assignments = await s.tools.professor_search.execute({ query: 'binary', category: 'assignments' }, s.exec)
  assert.ok(assignments.results.length >= 1)
  assert.equal(assignments.results.every((result) => result.category === 'assignments'), true)

  // Determinism across calls.
  const first = await s.tools.professor_search.execute({ query: 'binary search' }, s.exec)
  const second = await s.tools.professor_search.execute({ query: 'binary search' }, s.exec)
  assert.deepEqual(first.results.map((result) => result.chunk_id), second.results.map((result) => result.chunk_id))

  // No match: an empty result with a note, not a crash.
  const none = await s.tools.professor_search.execute({ query: 'quantum chromodynamics' }, s.exec)
  assert.equal(none.results.length, 0)
  assert.match(none.diagnostics.note, /no chunk matched/)
})

test('re-extraction is idempotent and rebuild re-chunks', async () => {
  const s = await scenario()
  await s.tools.professor_extract.execute({}, s.exec)
  const second = await s.tools.professor_extract.execute({}, s.exec)
  assert.equal(second.extracted, 0, 'nothing is re-extracted without rebuild')
  assert.equal(second.skipped > 0, true, 'existing chunks are reused')

  const rebuilt = await s.tools.professor_extract.execute({ rebuild: true }, s.exec)
  assert.ok(rebuilt.extracted > 0, 'rebuild forces re-extraction')

  const stores = await fs.readdir(path.join(s.project, '.professor', 'indexes', 'chunks'))
  assert.ok(stores.length >= 3)
})

test('diagnostics reports the extraction capability block honestly', async () => {
  const s = await scenario()
  await s.tools.professor_index_sync.execute({}, s.exec)
  const out = await s.tools.professor_diagnostics.execute({}, s.exec)

  assert.ok(out.extraction, 'diagnostics exposes an extraction block')
  assert.equal(out.extraction.capabilities.ocr, false, 'OCR is declared unavailable')
  assert.equal(out.extraction.capabilities.pdfText, null, 'no PDF backend was injected, so none is claimed')
  assert.equal(out.extraction.capabilities.officePython, false)
  assert.ok(out.extraction.chunkStores, 'chunk store status is reported')
  assert.match(out.extraction.capabilities.note, /OCR is disabled by design/)
  // The unobserved backend must come with its *reason*, and the reason must describe the plugin's
  // own boundary rather than asserting a fact about the machine — otherwise "unsupported" reads as
  // "this computer cannot do it", which is a claim nothing here observed.
  assert.deepEqual(out.extraction.capabilities.unobserved, [
    'pdf: no PDF text backend was observed (an injected runner providing PyMuPDF or Ghostscript txtwrite would enable it)',
    'office: no Python extractor runner was observed (python-docx / python-pptx / openpyxl)',
  ])
  // The plugin-boundary fields describe the plugin's *own* behaviour, so none of them may assert a
  // fact about the host. This is the distinction the audit cares about: an unobserved backend is
  // reported unsupported with a reason, which is honest, whereas "this computer cannot do it" is a
  // claim nothing here observed.
  const boundary = {
    note: out.extraction.capabilities.note,
    gating: out.extraction.capabilities.gating,
    unobserved: out.extraction.capabilities.unobserved,
  }
  assert.doesNotMatch(JSON.stringify(boundary), /on this machine/i,
    'the plugin boundary must not assert an unobserved fact about the host')

  // A probe result is a different kind of claim: it may report what it observed, but only as far as
  // it observed it. An engine path without `available: true` would be evidence with no claim, and
  // `available: true` with no path would be a claim with no evidence. Either way the report is
  // self-consistent, so a machine WITHOUT TeX still produces a valid, honest report.
  const latex = out.extraction.capabilities.latex
  assert.ok(latex, 'the extraction block carries the latex probe')
  assert.equal(latex.path !== null, latex.available,
    'an observed engine always carries its path, and no path is reported for an unobserved one')
  if (latex.available) {
    assert.equal(typeof latex.path, 'string')
    assert.equal(typeof latex.engine, 'string')
  } else {
    assert.equal(latex.engine, null)
    assert.match(latex.note, /DSH_PROFESSOR_LATEX/, 'an absent engine says how to provide one')
  }
})
