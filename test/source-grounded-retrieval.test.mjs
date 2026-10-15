/**
 * N2 — grading coverage follows what the model was handed, not what the index holds.
 *
 * The false-pass this pins: four pages indexed, the model handed page 1 only, and the old
 * index-derived context still reported `retrievedPages: [1,2,3,4]` — so a citation to page 2 passed
 * G2 and its claim passed G3 on a page the model never saw. Indexed availability is not retrieval.
 *
 * @module test/source-grounded-retrieval
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  collectDeliveredRetrieval, gradingContextFromDelivery, materialReadEnvelope,
} from './helpers/source-grounded-retrieval.mjs'
import { gradeNote } from './helpers/source-grounded-grading.mjs'
import { buildSourcePdf, pageContent } from './helpers/source-grounded-fixture.mjs'

const FILE_ID = 'f_fixture00000001'

/** A page's own text, as a chunk would carry it. */
function pageText(page) {
  return pageContent(buildSourcePdf(), page)
}

const searchHit = (page, text = pageText(page)) => ({
  name: 'professor_search',
  args: { query: `page ${page}` },
  isError: false,
  result: {
    query: `page ${page}`,
    results: [{
      chunk_id: `c_page${page}`, file_id: FILE_ID, page, heading: `Section ${page}`,
      text, relative_path: 'CSC3200/01_Lectures/week03-hash-tables.pdf', score: 10,
    }],
    dropped: 0,
  },
  result_text: '',
})

/** A successful `material_read(action:"text")`, shaped as the tool actually renders it. */
const materialReadText = (pages) => ({
  name: 'professor_material_read',
  args: { action: 'text', file_id: FILE_ID, from: 1, to: 4 },
  isError: false,
  result: null,
  result_text: [
    'action: text',
    'source: CSC3200/01_Lectures/week03-hash-tables.pdf',
    'coverage: Section coverage: 4 page(s) with complete source body delivered.',
    '',
    JSON.stringify({
      action: 'text',
      source: {
        kind: 'indexed', file_id: FILE_ID, relative_path: 'CSC3200/01_Lectures/week03-hash-tables.pdf',
      },
      content: {
        blocks: pages.map((page) => ({ page: String(page), text: pageText(page), origin: 'source' })),
      },
    }),
  ].join('\n'),
})

/**
 * A note that states the answer key's real claims, each cited to the page the key records.
 *
 * Only page 1 is ever handed to the model, so D1 is groundable and D2/D3/D4 are not — which is
 * exactly the distinction the index-derived context was unable to make.
 */
const noteCitingKeyClaims = () => [
  '# Note',
  '## 材料原文引用',
  'The table doubles its bucket count when the load factor reaches 0.75. '
  + `[source: ${FILE_ID}, page 1]`,
  'Table 1 ranks Linear probing worst at 2.94 average probes, and records primary clustering. '
  + `[source: ${FILE_ID}, page 2]`,
  'The source marks Table 2 as UNCERTAINTY - UNVERIFIED: the figures are not independently '
  + `confirmed. [source: ${FILE_ID}, page 3]`,
  '## 推断\n我的解释。',
  '## 补充\n我的例子。',
].join('\n\n')

const allFourPagesIndexed = () => ({
  fileIds: [FILE_ID],
  retrievedPages: [1, 2, 3, 4],
  retrievedTextByPage: Object.fromEntries([1, 2, 3, 4].map((page) => [page, pageText(page)])),
  sourceRelativePath: 'CSC3200/01_Lectures/week03-hash-tables.pdf',
})

test('the regression: four pages indexed, the model handed page 1 only, page-2 citation fails', () => {
  const note = noteCitingKeyClaims()

  // What the old index-derived context claimed, and why it was wrong.
  const indexed = gradeNote(note, allFourPagesIndexed())
  const indexedG2 = indexed.checks.find((check) => check.id === 'G2-citation-page-is-retrieved')
  const indexedG3 = indexed.checks.find((check) => check.id === 'G3-direct-claims-cited-on-their-page')
  assert.equal(indexedG2.pass, true,
    'control: with index-derived coverage every citation passes G2 — this is the false pass')
  assert.equal(indexedG3.pass, true,
    'control: and every claim is "grounded" on pages the model never received')

  // What the delivered evidence supports.
  const context = gradingContextFromDelivery([searchHit(1)], {
    fileIds: [FILE_ID],
    sourceRelativePath: 'CSC3200/01_Lectures/week03-hash-tables.pdf',
  })
  assert.deepEqual(context.retrievedPages, [1],
    'only page 1 was handed to the model, so only page 1 is coverage')

  const graded = gradeNote(note, context)
  const g2 = graded.checks.find((check) => check.id === 'G2-citation-page-is-retrieved')
  const g3 = graded.checks.find((check) => check.id === 'G3-direct-claims-cited-on-their-page')
  assert.equal(g2.pass, false,
    `a citation to a page the model never received is invented coverage: ${g2.detail}`)
  assert.equal(g3.pass, false,
    `claims on undelivered pages cannot be grounded: ${g3.detail}`)

  const unmetIds = (g3.unmet ?? []).map((entry) => entry.id).sort()
  assert.deepEqual(unmetIds, ['D2', 'D3', 'D4'],
    `only the claims on undelivered pages fail; D1 is on the one page that was delivered: ${JSON.stringify(g3.unmet)}`)
  assert.ok(
    (g3.unmet ?? []).every((entry) => entry.reason === 'cited-page-lacks-the-source-anchor'),
    `G3 names why, and it is the missing delivery rather than a missing claim: ${JSON.stringify(g3.unmet)}`,
  )
})

test('a failed tool call delivers nothing, however many pages the index holds', () => {
  const failed = { ...searchHit(3), isError: true, result: null, result_text: 'Error: boom' }
  const collected = collectDeliveredRetrieval([failed])
  assert.deepEqual(collected.retrievedPages, [], 'a failed call is not a delivery')
  assert.deepEqual(collected.deliveries, [])
  assert.equal(collected.rejected[0]?.reason, 'tool-call-failed')
})

test('a successful search that matches nothing delivers nothing', () => {
  const empty = {
    name: 'professor_search',
    args: { query: 'collision resolution resize threshold hash table' },
    isError: false,
    result: { query: '…', results: [], dropped: 0, warnings: ['course "csc3200" owns no files'] },
    result_text: '',
  }
  const collected = collectDeliveredRetrieval([empty])
  assert.deepEqual(collected.retrievedPages, [])
  assert.equal(collected.rejected[0]?.reason, 'returned-no-source-text')
})

test('material_read bodies and plan excerpts both count, and are tagged apart', () => {
  const body = collectDeliveredRetrieval([materialReadText([1, 2])])
  assert.deepEqual(body.retrievedPages, [1, 2])
  assert.ok(body.deliveries.every((delivery) => delivery.kind === 'body'))

  const plan = {
    name: 'professor_material_read',
    args: { action: 'plan', file_id: FILE_ID },
    isError: false,
    result: null,
    result_text: `action: plan\n\n${JSON.stringify({
      action: 'plan',
      source: { file_id: FILE_ID },
      plan: {
        per_page: [{ page: 3, excerpt: '3. Build Benchmark excerpt', classification: 'text_sufficient' }],
      },
    })}`,
  }
  const planned = collectDeliveredRetrieval([plan])
  assert.deepEqual(planned.retrievedPages, [3])
  assert.equal(planned.deliveries[0].kind, 'excerpt', 'an excerpt is delivered, but it is not a body')
})

test("deliveries from another source never widen this case's coverage", () => {
  const foreign = {
    ...searchHit(2),
    result: { results: [{ chunk_id: 'c_other', file_id: 'f_other0000000000', page: 2, text: 'elsewhere' }] },
  }
  const context = gradingContextFromDelivery([foreign], {
    fileIds: [FILE_ID],
    sourceRelativePath: 'CSC3200/01_Lectures/week03-hash-tables.pdf',
  })
  assert.deepEqual(context.retrievedPages, [], "a hit on another file is not this source's coverage")
  assert.deepEqual(context.deliveries, [])
})

test('non-retrieval tool calls are ignored entirely', () => {
  const collected = collectDeliveredRetrieval([
    { name: 'professor_session_status', args: {}, isError: false, result: { ok: true }, result_text: '{}' },
    { name: 'professor_artifact_create', args: {}, isError: false, result: { created: true }, result_text: '{}' },
  ])
  assert.deepEqual(collected.deliveries, [])
  assert.deepEqual(collected.rejected, [],
    'a tool that never carries source text is not a rejected retrieval')
})

test('the envelope is read out of the rendered text the model actually saw', () => {
  const envelope = materialReadEnvelope(materialReadText([1]).result_text)
  assert.equal(envelope.action, 'text')
  assert.equal(envelope.source.file_id, FILE_ID)
  assert.equal(envelope.content.blocks.length, 1)
  assert.equal(materialReadEnvelope('no json here'), null)
})

test('two calls that return the same page concatenate rather than overwrite', () => {
  const collected = collectDeliveredRetrieval([
    { ...searchHit(1, 'first fragment') },
    { ...searchHit(1, 'second fragment') },
  ])
  assert.deepEqual(collected.retrievedPages, [1])
  assert.match(collected.retrievedTextByPage[1], /first fragment/)
  assert.match(collected.retrievedTextByPage[1], /second fragment/)
})
