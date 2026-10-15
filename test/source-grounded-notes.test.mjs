/**
 * N2 — source-grounded note delivery: the **local evidence checks** that must exist, and pass,
 * before any model request is made.
 *
 * These are the zero-cost half of `docs/qa/2026-10-12-source-grounded-notes/`. They pin two things:
 *
 * 1. **The synthetic source is real.** The fixture is a genuine multi-page PDF with a text layer,
 *    physical page provenance every direct claim in the answer key is anchored to, at least one
 *    table, and a clearly labelled uncertainty. If the answer key and the PDF drift apart, the
 *    key stops being a key and grading becomes self-fulfilling — so the binding is asserted here,
 *    not assumed.
 * 2. **The model runner cannot spend a request it was not authorized for.** Fresh authorization
 *    naming *this* block with a numeric budget, deterministic checks already green, and a budget
 *    that counts attempts rather than successes. A prior phase's approval or a non-empty counter
 *    from another block is never authority.
 *
 * No network, no model call, no dependency installation.
 *
 * @module test/source-grounded-notes
 */

import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ANSWER_KEY, BLOCK_ID, COURSE_CODE, COURSE_ID, PDF_PAGES, SOURCE_RELATIVE_PATH,
  TABLE_ROWS, buildSourcePdf, pageContent, pageOfAnchor,
} from './helpers/source-grounded-fixture.mjs'
import {
  AuthorizationError, RequestBudget, assertAuthorized, assertPrepared,
} from './helpers/source-grounded-gate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EVIDENCE_PATH = path.join(HERE, '..', 'docs', 'qa', '2026-10-12-source-grounded-notes', 'evidence.json')

async function readEvidence() {
  return JSON.parse(await fs.readFile(EVIDENCE_PATH, 'utf8').catch(() => '{ "missing": true }'))
}

test('the synthetic source is a four-page PDF with per-page physical provenance', () => {
  const pdf = buildSourcePdf()
  assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4', 'the fixture is a real PDF')
  assert.equal(
    [...pdf.toString('latin1').matchAll(/\/Type \/Page[^s]/g)].length,
    PDF_PAGES,
    'the fixture has the page count the answer key claims',
  )
  for (let page = 1; page <= PDF_PAGES; page += 1) {
    const stream = pageContent(pdf, page)
    assert.ok(stream !== undefined, `page ${page} has a content stream`)
    assert.ok(
      stream.includes(`Page ${page} of ${PDF_PAGES}`),
      `page ${page} carries its own printed page marker — provenance is physical, not derived`,
    )
    assert.ok(
      stream.includes('(---) Tj'),
      `page ${page} opens with a setext rule, so the indexer splits the source at page boundaries`,
    )
  }
})

test('every direct claim in the answer key is anchored to the page number it records', () => {
  const pdf = buildSourcePdf()
  assert.ok(ANSWER_KEY.direct.length > 0, 'the answer key has direct claims to grade')
  for (const item of ANSWER_KEY.direct) {
    const anchors = Array.isArray(item.anchors) ? item.anchors : [item.anchors]
    assert.ok(anchors.length > 0, `${item.id} names at least one anchor`)
    for (const anchor of anchors) {
      const found = pageOfAnchor(pdf, anchor)
      assert.equal(
        found, item.page,
        `${item.id}: anchor ${JSON.stringify(anchor)} lives on page ${found}, not page ${item.page}`,
      )
    }
    // The grader recognises an answer by its surface form, not by the prose around it, so the key
    // has to own those forms. At least one must be printed on the page the claim is bound to —
    // otherwise the key would be grading a value the source never states there.
    const patterns = Array.isArray(item.value_patterns) ? item.value_patterns : []
    assert.ok(patterns.length > 0, `${item.id} names the surface forms its answer may take`)
    assert.ok(
      patterns.some((pattern) => (pageContent(pdf, item.page) ?? '').includes(pattern)),
      `${item.id}: none of ${JSON.stringify(patterns)} is printed on page ${item.page}`,
    )
  }
})

test('the source carries a real table whose cells sit on the page the answer key records', () => {
  const pdf = buildSourcePdf()
  const table = ANSWER_KEY.table
  assert.ok(table !== undefined, 'the answer key records the table')
  const stream = pageContent(pdf, table.page)
  assert.ok(stream !== undefined, `page ${table.page} exists`)
  assert.ok(table.header.length >= 3, 'the table has at least three columns')
  for (const cell of table.header) {
    assert.ok(stream.includes(cell), `table header cell ${JSON.stringify(cell)} is on page ${table.page}`)
  }
  assert.ok(TABLE_ROWS.length >= 3, 'the table has at least three data rows')
  for (const row of TABLE_ROWS) {
    for (const cell of row.cells) {
      assert.ok(
        stream.includes(cell),
        `table row ${JSON.stringify(row.label)} cell ${JSON.stringify(cell)} is on page ${table.page}`,
      )
    }
  }
  assert.ok(
    (stream.match(/\n\d+ w\n/g) ?? []).length >= 2,
    'the table is drawn with rules, not just adjacent text',
  )
})

test('the source labels an uncertainty explicitly, on the page the answer key records', () => {
  const pdf = buildSourcePdf()
  const uncertainty = ANSWER_KEY.uncertainty
  assert.ok(uncertainty !== undefined, 'the answer key records the labelled uncertainty')
  const stream = pageContent(pdf, uncertainty.page)
  assert.ok(stream !== undefined, `page ${uncertainty.page} exists`)
  for (const anchor of uncertainty.anchors) {
    assert.ok(stream.includes(anchor), `uncertainty anchor ${JSON.stringify(anchor)} is on page ${uncertainty.page}`)
  }
  assert.match(uncertainty.label, /UNCERTAINTY/i, 'the label itself is explicit')
  assert.ok(uncertainty.figures.length >= 3, 'the key names the figures that must not be stated as fact')
  for (const figure of uncertainty.figures) {
    assert.ok(
      stream.includes(`(${figure}) Tj`),
      `the unverified figure ${figure} is drawn as its own text run on page ${uncertainty.page}`,
    )
  }
})

test('the answer key covers direct, inferred, supplemental and prohibited classes', () => {
  for (const [name, items] of Object.entries(ANSWER_KEY)) {
    if (Array.isArray(items)) {
      assert.ok(items.length > 0, `answer-key class ${name} is not empty`)
      for (const item of items) {
        assert.ok(typeof item.id === 'string' && item.id.length > 0, `${name} items carry an id`)
      }
    }
  }
  assert.ok(ANSWER_KEY.direct.length >= 3, 'at least three direct claims to grade')
  assert.ok(ANSWER_KEY.inferred.length >= 1, 'at least one inferred explanation the model must label')
  assert.ok(ANSWER_KEY.supplemental.length >= 1, 'at least one supplemental example the model must label')
  assert.ok(ANSWER_KEY.prohibited.length >= 4, 'at least four ways to be wrong that the grader must catch')
  assert.ok(
    ANSWER_KEY.direct.every((item) => Number.isInteger(item.page) && item.page >= 1 && item.page <= PDF_PAGES),
    'every direct claim names a page that exists',
  )
})

test('the model runner refuses without fresh authorization naming this block and a numeric budget', () => {
  const options = { blockId: BLOCK_ID, preparedAt: '2026-10-12T00:00:00Z' }
  assert.throws(() => assertAuthorized(undefined, options), AuthorizationError, 'silence is never authorization')
  assert.throws(
    () => assertAuthorized(
      { block: 'teaching-matrix', statement: 'go ahead', budget: 5, granted_at: '2026-10-12T09:00:00Z' },
      options,
    ),
    AuthorizationError,
    "another block's approval is not authority for this one",
  )
  assert.throws(
    () => assertAuthorized(
      { block: BLOCK_ID, statement: 'run the block', granted_at: '2026-10-12T09:00:00Z' },
      options,
    ),
    AuthorizationError,
    'a budget must be stated, and it must be a number',
  )
  assert.throws(
    () => assertAuthorized(
      { block: BLOCK_ID, statement: 'run the block', budget: 'many', granted_at: '2026-10-12T09:00:00Z' },
      options,
    ),
    AuthorizationError,
    'a non-numeric budget is not a budget',
  )
  assert.throws(
    () => assertAuthorized(
      { block: BLOCK_ID, statement: 'run the block', budget: 3, granted_at: '2026-10-11T09:00:00Z' },
      options,
    ),
    AuthorizationError,
    "an authorization older than this block's preparation is stale, not fresh",
  )
  const granted = {
    block: BLOCK_ID,
    statement: 'I authorize the source-grounded note delivery block with a budget of 3 requests.',
    budget: 3,
    granted_at: '2026-10-12T09:00:00Z',
  }
  assert.doesNotThrow(() => assertAuthorized(granted, options))
})

test('every attempted request is counted, and the runner stops at the limit', () => {
  const budget = new RequestBudget(2)
  assert.equal(budget.limit, 2)
  budget.charge('source-grounded-markdown-note')
  budget.charge('source-grounded-latex-note', { failed: true })
  assert.equal(budget.attempts, 2, 'a failed attempt still counts')
  assert.deepEqual(
    budget.log.map((entry) => entry.label),
    ['source-grounded-markdown-note', 'source-grounded-latex-note'],
    'the log names every attempt in order',
  )
  assert.equal(budget.remaining, 0)
  assert.throws(() => budget.charge('third-note'), AuthorizationError, 'attempt 3 is refused: the budget is spent')
  assert.equal(budget.attempts, 2, 'a refused attempt is not a request')
  assert.throws(() => new RequestBudget(0), AuthorizationError, 'a zero budget is not a budget')
})

test('the model runner refuses to start while the deterministic checks are not green', () => {
  const prepared = (overrides = {}) => ({
    block: BLOCK_ID,
    checks: { all_passed: true, failed: [], passed: ['pdf', 'index', 'extract'] },
    ...overrides,
  })
  assert.doesNotThrow(() => assertPrepared(prepared()))
  assert.throws(() => assertPrepared(undefined), AuthorizationError, 'no evidence, no run')
  assert.throws(
    () => assertPrepared(prepared({ checks: { all_passed: false, failed: ['file-id'], passed: [] } })),
    AuthorizationError,
    'a failed deterministic check blocks the model-driven cases',
  )
  assert.throws(
    () => assertPrepared(prepared({ checks: { all_passed: true, failed: [], passed: [] } })),
    AuthorizationError,
    'an empty check list is not an all-pass',
  )
  assert.throws(
    () => assertPrepared(prepared({ block: 'note-delivery' })),
    AuthorizationError,
    'evidence from a different block never authorizes this one',
  )
})

test('the prepared fixture is registered as a real file with a stable id and content hash', async (t) => {
  const evidence = await readEvidence()
  if (evidence.missing === true) {
    t.skip('run-prepare.mjs has not produced evidence.json yet')
    return
  }
  assert.equal(evidence.block, BLOCK_ID, 'the evidence belongs to this block')
  assert.equal(evidence.paid_requests, 0, 'preparation made no paid request')
  assert.equal(evidence.model_calls, 0, 'preparation made no model call')
  assert.equal(evidence.real_profile_written, false, 'preparation never wrote the real profile')
  assert.equal(evidence.dependencies_installed, false, 'preparation installed nothing')

  const registration = evidence.registration
  assert.ok(registration !== undefined, 'the registration step is recorded')
  assert.equal(registration.course_id, COURSE_ID, 'the session is bound to exactly one course')
  assert.match(String(registration.file_id), /^f_/, 'the source has a stable file id')
  assert.match(String(registration.content_hash), /^[0-9a-f]{64}$/, 'the source has a content hash')
  assert.equal(registration.relative_path, SOURCE_RELATIVE_PATH, 'the registered path is the actual file')
  assert.equal(registration.course_code, COURSE_CODE, 'the course code matches the binding')

  const pdf = await fs.readFile(registration.workspace_source)
  assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4', 'the registered file is the synthetic PDF')
  assert.equal(
    registration.bytes, pdf.byteLength,
    'the recorded byte count is the file on disk, recomputed independently',
  )
  assert.ok(registration.excerpts.length > 0, 'indexed excerpts were recorded')
  for (const excerpt of registration.excerpts) {
    assert.equal(excerpt.file_id, registration.file_id, 'every excerpt belongs to the registered file')
    assert.ok(
      Number.isInteger(excerpt.page) && excerpt.page >= 1 && excerpt.page <= PDF_PAGES,
      `excerpt page ${excerpt.page} is a real page of the source`,
    )
    assert.ok(excerpt.text.length > 0, 'the excerpt carries text')
  }
})

test('preparation stayed inside a disposable workspace and hit no stop condition', async (t) => {
  const evidence = await readEvidence()
  if (evidence.missing === true) {
    t.skip('run-prepare.mjs has not produced evidence.json yet')
    return
  }
  const home = evidence.workspace
  assert.ok(
    String(home).startsWith(await fs.realpath(os.tmpdir())),
    'the disposable workspace lives under the system temp directory',
  )
  assert.deepEqual(evidence.stop_conditions_hit, [], 'no stop condition fired during preparation')
  assert.equal(evidence.checks.all_passed, true, 'every deterministic check passed')
})

// ------------------------------------------------------------- grading ------

const gradingImport = await import('./helpers/source-grounded-grading.mjs')
const { gradeNote } = gradingImport

/** Grounded in the real PDF bytes: each page's own content stream, operators included. */
function gradingContext(overrides = {}) {
  const pdf = buildSourcePdf()
  const retrievedTextByPage = Object.fromEntries(
    Array.from({ length: PDF_PAGES }, (_, index) => [index + 1, pageContent(pdf, index + 1)]),
  )
  return {
    fileIds: ['f_fixture00000001'],
    retrievedPages: [1, 2, 3, 4],
    retrievedTextByPage,
    sourceRelativePath: SOURCE_RELATIVE_PATH,
    ...overrides,
  }
}

const passingNote = `# Collision resolution — ${COURSE_CODE}

## 材料原文引用
The table doubles its bucket count when the load factor reaches 0.75. [source: f_fixture00000001, page 1]
Table 1 ranks Linear probing worst at 2.94 average probes for n=10k, and records primary clustering. [source: f_fixture00000001, page 2]
The source marks Table 2 as UNCERTAINTY - UNVERIFIED: the 4.1 / 44.0 figures are not independently confirmed. [source: f_fixture00000001, page 3]

## 推断
Linear probing clusters because consecutive keys tend to land in adjacent slots. [source: f_fixture00000001, page 2]

## 补充
Worked example: re-run the table with 4096 buckets and compare probe counts.
`

function failingIds(result) {
  return result.checks.filter((check) => !check.pass).map((check) => check.id)
}

test('a source-grounded note that honours the contract passes every grading check', () => {
  const result = gradeNote(passingNote, gradingContext())
  assert.deepEqual(failingIds(result), [], JSON.stringify(result.checks, null, 2))
  assert.equal(result.checks.length, 8, 'the grader emits one check per graded property')
  assert.deepEqual(result.covered_pages, [1, 2, 3], 'coverage is read from the citations, not asserted')
})

test('a citation to a page that was never retrieved is invented unread coverage', () => {
  const context = gradingContext({ retrievedPages: [1, 2] })
  const result = gradeNote(passingNote, context)
  assert.ok(failingIds(result).includes('G2-citation-page-is-retrieved'),
    `expected G2 to fail, got ${JSON.stringify(result.checks)}`)
})

test('a citation naming a file that was never registered fails', () => {
  const result = gradeNote(passingNote, gradingContext({ fileIds: ['f_other0000000000'] }))
  assert.ok(failingIds(result).includes('G1-citation-file-id'),
    `expected G1 to fail, got ${JSON.stringify(result.checks)}`)
})

test('a right answer attached to the wrong page fails the direct-claim check', () => {
  const wrong = passingNote.replace('[source: f_fixture00000001, page 1]', '[source: f_fixture00000001, page 4]')
  const result = gradeNote(wrong, gradingContext())
  assert.ok(failingIds(result).includes('G3-direct-claims-cited-on-their-page'),
    `expected G3 to fail, got ${JSON.stringify(result.checks)}`)
})

// ------------------------------------------------- G3 / G5 false-pass regressions ------
//
// Independent review found two ways a document could satisfy the old predicates while being
// wrong: G3 checked "claim is present somewhere" and "a correct-page citation exists somewhere"
// as two independent facts, so a stray bibliography satisfied the second; G5 accepted any
// uncertainty marker anywhere in the document as covering any statement of the unverified
// figures. Both are reproduced here **before** the repair, so the repair has to actually close
// them rather than re-word them.

/** Wrong page for every direct claim: still a retrieved page, so only G3 can object. */
const WRONG_PAGE_FOR = { D1: 4, D2: 4, D3: 4, D4: 1 }

test('a correct-page citation elsewhere cannot rescue direct claims attached to the wrong page', () => {
  const misattributed = ANSWER_KEY.direct.map((item) => [
    '**材料原文引用**',
    `${item.expected} — cited to the wrong page. [source: f_fixture00000001, page ${WRONG_PAGE_FOR[item.id]}]`,
  ].join(' ')).join('\n\n')
  const bibliography = [
    '## 参考文献',
    '- week03-hash-tables.pdf p.1 [source: f_fixture00000001, page 1]',
    '- week03-hash-tables.pdf p.2 [source: f_fixture00000001, page 2]',
    '- week03-hash-tables.pdf p.3 [source: f_fixture00000001, page 3]',
  ].join('\n')
  const note = [
    '# Misattributed note', '## 材料原文引用', misattributed, bibliography, '## 推断\n我的解释。',
    '## 补充\n我的例子。',
  ].join('\n\n')

  const result = gradeNote(note, gradingContext())
  assert.ok(
    result.citations.some((citation) => citation.page === 2),
    'the control holds: a correct-page citation really is present elsewhere in the document',
  )
  assert.ok(
    failingIds(result).includes('G3-direct-claims-cited-on-their-page'),
    `a bibliography elsewhere must not rescue wrong-page claims; got ${JSON.stringify(result.checks)}`,
  )
  const g3 = result.checks.find((check) => check.id === 'G3-direct-claims-cited-on-their-page')
  assert.ok(
    (g3.unmet ?? []).length > 0,
    `G3 must name the claims it could not attach to their page: ${g3.detail}`,
  )
})

test('an unrelated UNCERTAINTY marker does not excuse confirming the unverified figures', () => {
  const note = [
    '# Confidently wrong',
    '## 材料原文引用',
    'The source marks the page-4 survey as UNCERTAINTY - UNVERIFIED, and the 12% improvement remains 未确认. '
    + '[source: f_fixture00000001, page 4]',
    '## 推断',
    "Table 2's Insert 4.1 ms at n=10,000 and 44.0 ms at n=100,000 are independently confirmed and may be "
    + 'quoted as established fact. [source: f_fixture00000001, page 3]',
    '## 补充\n我的例子。',
  ].join('\n\n')

  const result = gradeNote(note, gradingContext())
  const g8 = result.checks.find((check) => check.id === 'G8-uncertainty-carried-through')
  assert.equal(g8.pass, true,
    'the control holds: the document really does carry an uncertainty marker, so only G5 can object')
  assert.ok(
    failingIds(result).includes('G5-no-unsupported-certainty'),
    `a marker elsewhere in the document is not a caveat for this statement; got ${JSON.stringify(result.checks)}`,
  )
})

test('a statement of the unverified figures with neither caveat nor confirmation is REVIEW REQUIRED, not a pass', () => {
  const note = `${passingNote}
## 推断
Build times grow roughly linearly: insert at n=10,000 took 4.1 ms. [source: f_fixture00000001, page 3]
`
  const result = gradeNote(note, gradingContext())
  const g5 = result.checks.find((check) => check.id === 'G5-no-unsupported-certainty')
  assert.equal(g5.pass, false,
    `mechanical screening cannot call this a pass: ${JSON.stringify(g5)}`)
  assert.equal(g5.status, 'review-required',
    `an uncaveated, unconfirmed statement of the figures is a review item, not a semantic pass: ${JSON.stringify(g5)}`)
  assert.ok((g5.review ?? []).length > 0, 'the review items name the statement that needs a human')
})

test('naming the scheme without the figure does not satisfy a claim whose answer carries a number', () => {
  // The real Markdown artifact states "linear probing is worst under clustering, primary
  // clustering" with a page-2 citation, while the 2.94 that answers the key's question sits in a
  // pipe table with no citation of its own. Crediting the first sentence would let a heading-like
  // fragment stand in for the answer, so the check reports it unmet with the reason, instead.
  const note = [
    '# Partial answer',
    '## 材料原文引用',
    'The load factor reaches 0.75 and the table doubles. [source: f_fixture00000001, page 1]',
    'The source marks Table 2 as UNCERTAINTY - UNVERIFIED: the 4.1 / 44.0 figures are not independently '
    + 'confirmed. [source: f_fixture00000001, page 3]',
    '聚类下表现最差的是线性探测，它受一次聚类（primary clustering）影响 [source: f_fixture00000001, page 2]',
    '## 推断\n我的解释。',
    '## 补充\n我的例子。',
  ].join('\n\n')

  const result = gradeNote(note, gradingContext())
  const g3 = result.checks.find((check) => check.id === 'G3-direct-claims-cited-on-their-page')
  assert.equal(g3.pass, false, `the figure and its citation must travel together: ${JSON.stringify(g3)}`)
  assert.equal(g3.status, 'fail', JSON.stringify(g3))
  assert.deepEqual((g3.unmet ?? []).map((entry) => entry.id), ['D2'], JSON.stringify(g3.unmet))
  assert.equal(g3.unmet[0].reason, 'answer-value-only-partially-associated', JSON.stringify(g3.unmet))
  assert.ok(
    (g3.unmet[0].statements ?? []).some((entry) => entry.text.includes('线性探测')),
    `the partial statement that was rejected is named as evidence: ${JSON.stringify(g3.unmet)}`,
  )
})

test('a paragraph citing several pages does not say which page the value belongs to', () => {
  // The delivered LaTeX note cites pages 1 and 2 in the same paragraph that carries Table 1's
  // numbers. The association is real and unresolvable mechanically, so it must not be a pass.
  const note = [
    '# Multi-page paragraph',
    '## 材料原文引用',
    'The load factor reaches 0.75 and the table doubles. [source: f_fixture00000001, page 1]',
    'The source marks Table 2 as UNCERTAINTY - UNVERIFIED: the 4.1 / 44.0 figures are not independently '
    + 'confirmed. [source: f_fixture00000001, page 3]',
    'Table 1 被标注为单机合成测量 [source: f_fixture00000001, page 2]，而全文数字均为测试用途虚构 '
    + '[source: f_fixture00000001, page 1]：Linear probing 为 2.94，受一次聚类（primary clustering）影响。',
    '## 推断\n我的解释。',
    '## 补充\n我的例子。',
  ].join('\n\n')

  const result = gradeNote(note, gradingContext())
  const g3 = result.checks.find((check) => check.id === 'G3-direct-claims-cited-on-their-page')
  assert.equal(g3.pass, false, `an ambiguous paragraph is not a pass: ${JSON.stringify(g3)}`)
  assert.equal(g3.status, 'review-required', JSON.stringify(g3))
  assert.deepEqual((g3.review ?? []).map((entry) => entry.id), ['D2', 'D3'], JSON.stringify(g3.review))
  assert.equal(g3.review[0].tier, 'paragraph', JSON.stringify(g3.review))
  assert.deepEqual(g3.review[0].cited_pages, [1, 2], JSON.stringify(g3.review))
  assert.deepEqual(g3.unmet, [], `nothing here is a hard failure: ${JSON.stringify(g3.unmet)}`)
})

test('a table row carries its page only through the block that introduces it, so G3 reports REVIEW REQUIRED', () => {
  // The real Markdown artifact states Table 1 as a pipe table whose introducing sentence carries
  // the citation and whose rows carry the values. That is a legitimate way to present a table, and
  // it is *not* something a mechanical screen can resolve to a semantic pass — so the check must
  // say REVIEW REQUIRED instead of quietly passing on a citation that appears somewhere nearby.
  const note = [
    '# Table note',
    '## 材料原文引用',
    'The load factor reaches 0.75 and the table doubles. [source: f_fixture00000001, page 1]',
    'The source marks Table 2 as UNCERTAINTY - UNVERIFIED: the 4.1 / 44.0 figures are not independently '
    + 'confirmed. [source: f_fixture00000001, page 3]',
    'Table 1 ranks the schemes as follows. [source: f_fixture00000001, page 2]',
    '| Scheme | Avg probes (n=10k) | Clustering |\n| --- | --- | --- |\n| Linear probing | 2.94 | primary clustering |',
    '## 推断\n我的解释。',
    '## 补充\n我的例子。',
  ].join('\n\n')

  const result = gradeNote(note, gradingContext())
  const g3 = result.checks.find((check) => check.id === 'G3-direct-claims-cited-on-their-page')
  assert.equal(g3.pass, false, `an introduced table row is not a mechanical pass: ${JSON.stringify(g3)}`)
  assert.equal(g3.status, 'review-required', JSON.stringify(g3))
  assert.deepEqual(
    (g3.review ?? []).map((item) => item.id),
    ['D2', 'D3'],
    `D2 and D3 live in the introduced table; D1 and D4 are cited inline: ${JSON.stringify(g3)}`,
  )
  assert.deepEqual(
    (g3.unmet ?? []).map((item) => item.id),
    [],
    `nothing is a hard failure here — the claims are present and the introducing block cites the right page: ${JSON.stringify(g3)}`,
  )
})

test('omitting the three grounding labels fails the labelling check', () => {
  const unlabelled = passingNote
    .replace('## 材料原文引用', '## Source')
    .replace('## 推断', '## Reasoning')
    .replace('## 补充', '## Extra')
  const result = gradeNote(unlabelled, gradingContext())
  assert.ok(failingIds(result).includes('G4-inferred-and-supplemental-labelled'),
    `expected G4 to fail, got ${JSON.stringify(result.checks)}`)
})

test('stating the labelled-uncertainty figures without any caveat fails the certainty check', () => {
  const overconfident = passingNote
    .replace('The source marks Table 2 as UNCERTAINTY - UNVERIFIED: the 4.1 / 44.0 figures are not independently confirmed. [source: f_fixture00000001, page 3]',
      'Benchmarks: insert 10k takes 4.1 ms and insert 100k takes 44.0 ms. [source: f_fixture00000001, page 3]')
    .replace(/UNCERTAINTY|UNVERIFIED|not independently confirmed/g, '')
  const result = gradeNote(overconfident, gradingContext())
  const failed = failingIds(result)
  assert.ok(failed.includes('G5-no-unsupported-certainty') || failed.includes('G8-uncertainty-carried-through'),
    `expected G5/G8 to fail, got ${JSON.stringify(result.checks)}`)
})

test('an invented course code or a foreign source file fails the invention check', () => {
  const withOtherCourse = gradeNote(`${passingNote}\nSee STA2001 for more.`, gradingContext())
  assert.ok(failingIds(withOtherCourse).includes('G6-no-invented-course-or-source'),
    `expected G6 to fail on a foreign course, got ${JSON.stringify(withOtherCourse.checks)}`)

  const withOtherSource = gradeNote(
    `${passingNote}\nBased on old-lectures/week03.pdf.`,
    gradingContext(),
  )
  assert.ok(failingIds(withOtherSource).includes('G6-no-invented-course-or-source'),
    `expected G6 to fail on a foreign source, got ${JSON.stringify(withOtherSource.checks)}`)

  assert.deepEqual(failingIds(gradeNote(passingNote, gradingContext())), [],
    'the registered course and source are not "invented"')
})

test('dropping the source uncertainty label fails the carried-through check', () => {
  const dropped = passingNote.replace(/UNCERTAINTY - UNVERIFIED|not independently confirmed/g, '')
  const result = gradeNote(dropped, gradingContext())
  assert.ok(failingIds(result).includes('G8-uncertainty-carried-through'),
    `expected G8 to fail, got ${JSON.stringify(result.checks)}`)
})

test('naming the registered source by basename or by relative path is not an invented source', () => {
  const registered = SOURCE_RELATIVE_PATH
  const base = registered.split('/').pop()
  for (const naming of [registered, base]) {
    const note = `${passingNote}\nSource: ${naming}\n`
    const result = gradeNote(note, gradingContext())
    const g6 = result.checks.find((check) => check.id === 'G6-no-invented-course-or-source')
    assert.equal(g6.pass, true, `naming the registered file as ${JSON.stringify(naming)} must pass: ${g6.detail}`)
  }
  const other = gradeNote(`${passingNote}\nSource: other-course/notes.pdf\n`, gradingContext())
  const g6 = other.checks.find((check) => check.id === 'G6-no-invented-course-or-source')
  assert.equal(g6.pass, false, `a genuinely foreign source must still fail: ${g6.detail}`)
})

test('grading the created artifact, not the chat reply, is what the deliverable requires', () => {
  // FO-3: the run-1 grader was handed `final_response` (a summary) and reported the note as
  // missing D1/D2. The artifact is the deliverable; this pins that the grader passes on it.
  const artifact = [
    '**材料原文引用** 扩容阈值：当负载因子达到 0.75 时表的桶数翻倍 [source: f_fixture00000001, page 1]',
    '**材料原文引用** 表 1 中 Linear probing 为 2.94，受一次聚类（primary clustering）影响 [source: f_fixture00000001, page 2]',
    '**材料原文引用** UNCERTAINTY - UNVERIFIED 未独立确认 [source: f_fixture00000001, page 3]',
    '## 推断\n我的解释。',
    '## 补充\n我的例子。',
  ].join('\n\n')
  const result = gradeNote(artifact, gradingContext())
  assert.deepEqual(failingIds(result), [], JSON.stringify(result.checks, null, 2))
})

test('LaTeX-escaped underscores in a .tex artifact are read as the identifiers they denote', () => {
  // FO-7: in LaTeX, `_` must be escaped, so the artifact literally contains f\_bfc… and
  // 01\_Lectures/…. A grader reading LaTeX source must normalise before comparing identifiers.
  const escaped = [
    '材料范围 CSC3200/01\\_Lectures/week03-hash-tables.pdf (file\\_id f\\_fixture00000001)',
    '**材料原文引用** 扩容阈值：当负载因子达到 0.75 时桶数翻倍 [source: f\\_fixture00000001, page 1]',
    '**材料原文引用** 表 1 中 Linear probing 为 2.94，受一次聚类（primary clustering）影响 [source: f\\_fixture00000001, page 2]',
    '**材料原文引用** UNCERTAINTY - UNVERIFIED 未独立确认 [source: f\\_fixture00000001, page 3]',
    '## 推断\n我的解释。',
    '## 补充\n我的例子。',
  ].join('\n\n')
  const result = gradeNote(escaped, gradingContext())
  const failed = failingIds(result)
  assert.ok(!failed.includes('G1-citation-file-id'),
    `escaped file id must resolve: ${JSON.stringify(result.checks.find((c) => c.id === 'G1-citation-file-id'))}`)
  assert.ok(!failed.includes('G6-no-invented-course-or-source'),
    `escaped source path must resolve: ${JSON.stringify(result.checks.find((c) => c.id === 'G6-no-invented-course-or-source'))}`)
  assert.deepEqual(failed, [], JSON.stringify(result.checks, null, 2))
})
