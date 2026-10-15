/**
 * M8 tests: extraction capability gating, chunking, and budgeted retrieval.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import {
  backendFamilyFor, planExtraction, summarizeCapabilities,
} from '../src/extract/capabilities.js'
import { extractFile, normalizeForChunking } from '../src/extract/extract.js'
import { chunkDocument, splitSections } from '../src/extract/chunk.js'

test('a divider directly after an ATX heading does not become an undefined setext title', () => {
  const result = chunkDocument({ text: '# Lecture\n---\nCourse content', fileId: 'f_divider' })
  assert.ok(result.chunks.length > 0)
})
import { retrieve, queryTerms } from '../src/extract/retrieval.js'
import { readChunkStore } from '../src/extract/store.js'
import { createFsGateway } from '../src/fs/gateway.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

const NO_CAPS = { pdfText: null, pdfPages: null, officePython: false, officeToPdf: false, latex: null }
const FULL_CAPS = { pdfText: 'fitz', pdfPages: 'ghostscript', officePython: true, officeToPdf: true, latex: 'latexmk' }

test('extension families map to the right backend, and images/opaque formats are refused', () => {
  assert.equal(backendFamilyFor('md'), 'text')
  assert.equal(backendFamilyFor('PDF'), 'pdf')
  assert.equal(backendFamilyFor('docx'), 'office')
  assert.equal(backendFamilyFor('png'), 'image')
  assert.equal(backendFamilyFor('zip'), 'opaque')
  assert.equal(backendFamilyFor('weird'), 'unknown')

  assert.equal(planExtraction({ extension: 'md', capabilities: NO_CAPS }).supported, true)
  assert.equal(planExtraction({ extension: 'pdf', capabilities: NO_CAPS }).supported, false)
  assert.match(planExtraction({ extension: 'pdf', capabilities: NO_CAPS }).reason, /no PDF text backend/)

  const image = planExtraction({ extension: 'png', capabilities: FULL_CAPS })
  assert.equal(image.supported, false, 'OCR stays off even with every other backend present')
  assert.match(image.reason, /OCR is disabled/)

  const opaque = planExtraction({ extension: 'zip', capabilities: FULL_CAPS })
  assert.equal(opaque.supported, false)
  assert.match(opaque.reason, /opaque binary/)
})

test('the capability summary states OCR is off, whatever else is available', () => {
  const summary = summarizeCapabilities(FULL_CAPS)
  assert.equal(summary.ocr, false)
  assert.equal(summary.pdfText, 'fitz')
  assert.equal(summary.officePython, true)
  assert.match(summary.note, /OCR is disabled by design/)
  assert.equal(summarizeCapabilities(NO_CAPS).pdfText, null)
})

test('text extraction reads through the gateway and normalises cleanly', async () => {
  const home = await makeHome('professor-extract-')
  await writeFixture(home, 'courses/term/note.md', '﻿# Title\r\n\r\nBody   \n\n\n\nEnd')
  const fake = createFakeContext({ home })
  const gateway = createFsGateway({ ctx: fake.ctx, logger: { warn() {} } })
  const target = await gateway.resolveTarget('courses/term/note.md', { cwd: home })

  const outcome = await extractFile({
    gateway, target, extension: 'md', capabilities: NO_CAPS,
  })
  assert.equal(outcome.status, 'extracted')
  assert.equal(outcome.extractor, 'text-reader')
  assert.equal(outcome.text.charCodeAt(0) === 0xFEFF, false, 'BOM is stripped at extraction time')

  // Newline/blank-line normalisation belongs to the chunking stage, so extraction stays faithful
  // to the bytes it read and the chunker alone defines the boundary rules.
  assert.equal(outcome.text.includes('\r'), true, 'raw CRLF survives extraction (faithful read)')
  const normalized = normalizeForChunking(outcome.text)
  assert.equal(normalized.includes('\r'), false, 'CRLF is normalised for chunking')
  assert.equal(normalized.includes('\n\n\n'), false, 'blank-line runs are collapsed')
})

test('an unsupported format is reported as unsupported, never as a partial read', async () => {
  const home = await makeHome('professor-extract-unsup-')
  await writeFixture(home, 'courses/term/scan.png', 'binary-ish')
  const fake = createFakeContext({ home })
  const gateway = createFsGateway({ ctx: fake.ctx, logger: { warn() {} } })
  const target = await gateway.resolveTarget('courses/term/scan.png', { cwd: home })

  const outcome = await extractFile({
    gateway, target, extension: 'png', capabilities: FULL_CAPS,
  })
  assert.equal(outcome.status, 'unsupported')
  assert.equal(outcome.text, undefined, 'no text is invented')
  assert.match(outcome.reason, /OCR is disabled/)
})

test('a non-text backend with no command runner is unsupported, not failed', async () => {
  const home = await makeHome('professor-extract-norunner-')
  await writeFixture(home, 'courses/term/deck.pdf', '%PDF-1.4')
  const fake = createFakeContext({ home })
  const gateway = createFsGateway({ ctx: fake.ctx, logger: { warn() {} } })
  const target = await gateway.resolveTarget('courses/term/deck.pdf', { cwd: home })

  const outcome = await extractFile({
    gateway, target, extension: 'pdf', capabilities: FULL_CAPS, // no `run` supplied
  })
  assert.equal(outcome.status, 'unsupported')
  assert.match(outcome.reason, /no command runner/)
})

test('sections split on headings, including LaTeX commands and fenced code', () => {
  const text = [
    '# First', 'alpha', '## Nested', 'beta',
    '', '\\section{Second}', 'gamma',
    '', '```js', '# not a heading', 'const x = 1', '```',
  ].join('\n')
  const sections = splitSections(text)
  const headings = sections.map((section) => section.heading)
  // The fenced block starts no new section: it belongs to the `\section{Second}` section.
  assert.deepEqual(headings, ['First', 'Nested', 'Second'])
  const secondSection = sections.at(-1)
  assert.ok(secondSection.lines.some((line) => line.includes('# not a heading')),
    'a heading inside a code fence does not start a section')
  assert.ok(secondSection.lines.some((line) => line.includes('const x = 1')),
    'the code block stays with its section')
})

test('chunking is deterministic, bounded, and keeps code blocks whole', () => {
  const long = ['# Doc', '']
  for (let index = 0; index < 60; index += 1) long.push(`Paragraph ${index} with some words to fill the chunk size.`, '')
  long.push('```', 'print("never split me")', '```')
  const text = long.join('\n')

  const first = chunkDocument({ text, fileId: 'f_abc' })
  const second = chunkDocument({ text, fileId: 'f_abc' })
  assert.deepEqual(first.chunks.map((chunk) => chunk.chunk_id), second.chunks.map((chunk) => chunk.chunk_id),
    'same content produces the same chunk ids')
  assert.deepEqual(first.chunks, second.chunks, 'chunking is fully deterministic')

  for (const chunk of first.chunks) {
    assert.match(chunk.chunk_id, /^c_[0-9a-f]{16}$/)
    assert.equal(chunk.file_id, 'f_abc')
    assert.ok(chunk.start_line >= 1)
    assert.ok(chunk.end_line >= chunk.start_line)
    assert.equal(chunk.page, null)
    assert.equal(chunk.slide, null)
  }
  const codeChunk = first.chunks.find((chunk) => chunk.text.includes('never split me'))
  assert.ok(codeChunk, 'the code block survives as a chunk')
  assert.match(codeChunk.text, /```[\s\S]*never split me[\s\S]*```/, 'the fence is not left open')

  const capped = chunkDocument({ text, fileId: 'f_abc', maxChunks: 2 })
  assert.equal(capped.chunks.length, 2, 'the hard cap is respected')
  assert.ok(capped.dropped > 0, 'dropped chunks are reported')
})

test('query terms drop noise and deduplicate', () => {
  assert.deepEqual(queryTerms('the  a  binary search tree'), ['the', 'binary', 'search', 'tree'])
  assert.deepEqual(queryTerms('tree tree'), ['tree'])
  assert.deepEqual(queryTerms(''), [])
})

test('retrieval respects filters and the hard budget, deterministically', () => {
  const chunks = [
    { chunk_id: 'c_01', file_id: 'f_a', course_id: 'csc3200', category: 'lectures', heading: 'Binary search', text: 'binary search tree', start_line: 1, end_line: 2 },
    { chunk_id: 'c_02', file_id: 'f_a', course_id: 'csc3200', category: 'lectures', heading: 'Trees', text: 'a binary tree has nodes', start_line: 5, end_line: 6 },
    { chunk_id: 'c_03', file_id: 'f_b', course_id: 'csc3200', category: 'assignments', heading: 'Homework', text: 'implement binary search', start_line: 1, end_line: 1 },
    { chunk_id: 'c_04', file_id: 'f_c', course_id: 'gfn1000', category: 'lectures', heading: 'Other', text: 'binary appears here too', start_line: 1, end_line: 1 },
  ]

  const all = retrieve({ chunks, query: 'binary search', maxChunks: 8, maxSources: 4 })
  assert.ok(all.results.length >= 3)
  assert.equal(all.dropped, 0)
  for (const result of all.results) {
    assert.ok(result.score > 0)
    assert.ok(Array.isArray(result.matched_terms))
    assert.ok(result.matched_terms.includes('binary'))
    assert.equal(typeof result.course_id, 'string')
    assert.ok(result.start_line >= 1, 'every result carries provenance')
  }

  // Course filter narrows before scoring, so another course can never occupy a slot.
  const scoped = retrieve({ chunks, query: 'binary', maxChunks: 8, maxSources: 4, courseFilter: 'csc3200' })
  assert.equal(scoped.results.every((result) => result.course_id === 'csc3200'), true)
  assert.equal(scoped.filtered.byCourse, 1)

  // Category filter.
  const byCategory = retrieve({ chunks, query: 'binary', maxChunks: 8, maxSources: 4, categoryFilter: 'assignments' })
  assert.equal(byCategory.results.length, 1)
  assert.equal(byCategory.results[0].category, 'assignments')

  // Hard budget: never exceed maxChunks, and say what was dropped.
  const budgeted = retrieve({ chunks, query: 'binary search', maxChunks: 2, maxSources: 4 })
  assert.equal(budgeted.results.length, 2, 'the budget is never exceeded')
  assert.ok(budgeted.dropped >= 1)
  assert.match(budgeted.diagnostics.note, /budget reached/)

  // Distinct-source cap.
  const limited = retrieve({ chunks, query: 'binary', maxChunks: 8, maxSources: 1 })
  assert.equal(new Set(limited.results.map((result) => result.file_id)).size, 1)
  assert.ok(limited.dropped >= 1)

  // Determinism: two runs, identical order.
  const again = retrieve({ chunks, query: 'binary search', maxChunks: 8, maxSources: 4 })
  assert.deepEqual(again.results.map((result) => result.chunk_id), all.results.map((result) => result.chunk_id))

  // No match: empty results plus an explanatory note, not an error.
  const none = retrieve({ chunks, query: 'quantum chromodynamics', maxChunks: 8 })
  assert.equal(none.results.length, 0)
  assert.match(none.diagnostics.note, /no chunk matched/)
})
