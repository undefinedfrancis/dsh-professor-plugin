/**
 * Delivery-truth regressions for `professor_material_read`.
 *
 * These tests pin the two P1 defects the 2026-10-11 functional audit found and the unit suite
 * missed, because nothing ever exercised the tool's *model-facing projection* or treated
 * "excerpt returned" as different from "source body delivered":
 *
 * 1. Image blocks never reached the model: the projection lived on the tool definition's top-level
 *    `render`, while the installed Harness calls `output.render` (`@deepseek-ai/dsh-tools`
 *    `createSuccessResult` → `tool.output.render(exec.arguments, value)`), so results carried only
 *    a JSON text block even when `image_delivery.status` said `delivered`.
 * 2. Coverage claimed full reading from an overview: any `text_sufficient` page counted as
 *    `text_only` (and toward `percent_accounted`) after a plan that shipped only a 240-character
 *    excerpt, with no `action: text` body delivery at all.
 *
 * Every projection assertion goes through the **actual** `tool.output.render`, never a hand-kept
 * copy of it, and the expected image block shape is the one the host's own `read_image` tool emits
 * (`{ type: 'image', attachment: { attachmentId, mediaType, bytes, width, height, name? } }`).
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { createReadingLedger, SUPPRESSION, reuseDecision } from '../src/material/ledger.js'
import { buildReadingPlan, coverageStatement } from '../src/material/plan.js'
import { createFakeContext, createScriptedShell, makeHome, writeFixture } from './helpers/fake-harness.mjs'

// --- fixtures ------------------------------------------------------------------

function projectYaml(project) {
  return `schema_version: 1
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
      - path: ${path.join(project, 'CSC4801')}
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
}

const DEFAULT_PROBE = {
  ok: true,
  python: '3.12.0',
  modules: { fitz: '1.28.2', pymupdf: '1.28.2', docx: '1.2.0', pptx: '1.0.2', openpyxl: '3.1.5', lxml: '6.1.3' },
  missing: [],
}

const b64 = (bytes) => Buffer.alloc(bytes, 0x4a).toString('base64')

/** A shell that answers the probe, the text extractor, the renderer, enhancement and office. */
function scriptedExtraction({ pages, imageBytes = 4096, onRender = null, onExtract = null, enhancement = null, office = null } = {}) {
  const calls = []
  const shell = createScriptedShell((command) => {
    calls.push(command)
    if (command.includes('probe_python.py')) return { stdout: JSON.stringify(DEFAULT_PROBE) }
    if (command.includes('enhance_pdf.py')) {
      return { stdout: JSON.stringify(enhancement ?? { ok: false, error: 'unavailable', detail: 'not prepared' }) }
    }
    if (command.includes('extract_office.py')) {
      return { stdout: JSON.stringify(office ?? { ok: false, error: 'unavailable', detail: 'no office backend' }) }
    }
    if (command.includes('extract_pdf.py')) {
      if (typeof onExtract === 'function') onExtract(command)
      return {
        stdout: JSON.stringify({
          ok: true,
          pages,
          notes: ['pymupdf: text layer only; no page was rendered and no OCR ran'],
        }),
      }
    }
    if (command.includes('render_pages.py')) {
      if (typeof onRender === 'function') onRender(command)
      const explicit = /--pages ([0-9,]+)/.exec(command)?.[1]
      const list = explicit.split(',').map(Number)
      return {
        stdout: JSON.stringify({
          ok: true,
          pages: list.map((page) => ({ page, width: 1600, height: 900, bytes: imageBytes, b64: b64(imageBytes) })),
          truncated: false, total_pages: pages.length, requested: list, notes: [],
        }),
      }
    }
    return { stdout: '' }
  })
  return { shell, calls }
}

/**
 * An attachment service that can return a deliberately unusable reference once, then behave.
 *
 * The host's image blocks carry `{ attachmentId, mediaType, bytes, width, height }`; a reference
 * whose width is not a finite number cannot become a valid block, and the tool must report the
 * page as not-delivered instead of emitting a broken block or claiming delivery.
 */
function fakeAttachments({ limit = 20 * 1024 * 1024, failOn = [], brokenOn = [], onCall = null } = {}) {
  const saved = []
  let counter = 0
  return {
    saved,
    imageLimits: {
      maxImageBytes: limit,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 200 * 1024 * 1024,
      maxImagePixels: 64_000_000,
      maxImageDimension: 8192,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    async saveImage({ data, mediaType, name }) {
      counter += 1
      if (typeof onCall === 'function') onCall({ attempt: counter, data, name })
      if (failOn.includes(counter)) throw new Error(`scripted attachment refusal for attempt ${counter}`)
      const broken = brokenOn.includes(counter)
      const ref = {
        attachmentId: `att_${counter}`,
        mediaType,
        bytes: data.byteLength,
        width: broken ? Number.NaN : 1600,
        height: 900,
        name,
      }
      saved.push(ref)
      return ref
    },
  }
}

function fakeLlm({ modalities = ['text', 'image'] } = {}) {
  return {
    async resolveModelInfo(provider, model) {
      return { inputModalities: modalities, provider, model }
    },
  }
}

function materialExec({ cwd, sessionId = 'session-delivery', controller } = {}) {
  const handle = controller ?? new AbortController()
  return {
    agent: {
      session: {
        id: sessionId,
        header: { cwd },
        requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-vision-model' } }),
      },
    },
    signal: handle.signal,
  }
}

function toolsByName(fake) {
  return Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
}

/** A one-page source of exactly 1000 characters: the audit's minimal reproduction. */
const ONE_PAGE_1000 = [{ page: 1, text: 'L'.repeat(1000) }]

/** Eight short pages: more than the per-call page cap of the text action (6 blocks). */
const EIGHT_PAGES = Array.from({ length: 8 }, (_, index) => ({
  page: index + 1,
  text: `Body of page ${index + 1}.`,
}))

/** One long page whose body spans several bounded text responses. */
const LONG_PAGE = [{ page: 1, text: 'x'.repeat(40000) }]

const SIX_PAGES = [
  { page: 1, text: 'Page one body '.repeat(10) },
  { page: 2, text: 'Page two body '.repeat(10) },
  { page: 3, text: '' },
  { page: 4, text: 'Page four body '.repeat(10) },
  { page: 5, text: '' },
  { page: 6, text: 'Page six body '.repeat(10) },
]

async function scenario(options = {}) {
  const home = await makeHome('professor-delivery-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/CSC4801/01_Lectures/00_Introduction.pdf', options.sourceText ?? 'stable-source-bytes')
  await writeFixture(home, 'courses/term/.professor/project.yaml', projectYaml(project))

  const { shell, calls } = scriptedExtraction({
    pages: options.pages ?? SIX_PAGES,
    ...(options.extraction ?? {}),
  })
  const attachment = options.attachments === null ? null : (options.attachments ?? fakeAttachments())
  const services = {
    shell,
    ...(attachment === null ? {} : { attachments: attachment }),
    llm: options.llm ?? fakeLlm(),
    ...(options.extraServices ?? {}),
  }
  const fake = createFakeContext({ home, services })
  apply(fake.ctx, { ...fake.pluginConfig, ...(options.pluginConfig ?? {}) })
  const tools = toolsByName(fake)
  const exec = materialExec({ cwd: project, sessionId: options.sessionId ?? 'session-delivery' })
  await tools.professor_index_sync.execute({ force: true }, exec)
  const indexFile = JSON.parse(await fs.readFile(path.join(project, '.professor/indexes/files.json'), 'utf8'))
  const record = indexFile.files.find((entry) => entry.relative_path.endsWith('00_Introduction.pdf'))
  assert.ok(record, 'the lecture is indexed')
  return {
    home, project, fake, tools, exec,
    fileId: record.file_id,
    pdfPath: path.join(project, record.relative_path),
    attachment,
    shellCalls: calls,
  }
}

/**
 * Assert one projected block is a host-valid image block, and return its attachment.
 *
 * The shape is the contract the installed Harness uses for its own `read_image` tool:
 * `output.render` returns `{ type: 'image', attachment: { attachmentId, mediaType, bytes,
 * width, height, name? } }`.
 */
function assertImageBlock(block, label) {
  assert.equal(block.type, 'image', `${label}: block type`)
  assert.equal(typeof block.attachment, 'object', `${label}: attachment object`)
  const ref = block.attachment
  assert.equal(typeof ref.attachmentId, 'string', `${label}: attachmentId is a string`)
  assert.ok(ref.attachmentId.length > 0, `${label}: attachmentId is non-empty`)
  assert.ok(
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType),
    `${label}: mediaType is a supported image type (${ref.mediaType})`,
  )
  assert.ok(Number.isFinite(ref.bytes) && ref.bytes >= 0, `${label}: bytes is a finite number`)
  assert.ok(Number.isFinite(ref.width) && ref.width > 0, `${label}: width is a finite positive number`)
  assert.ok(Number.isFinite(ref.height) && ref.height > 0, `${label}: height is a finite positive number`)
  return ref
}

// --- P1-1: images must reach the model-facing result ----------------------------

test('the output renderer emits one envelope plus one image block per delivered page', async () => {
  const s = await scenario()
  try {
    const value = await s.tools.professor_material_read.execute(
      { action: 'pages', file_id: s.fileId, pages: [1, 2] }, s.exec,
    )
    assert.equal(value.image_delivery.images.length, 2, 'two pages were attached')

    // THE regression: the host calls `output.render`, not the definition-level `render`.
    const tool = s.tools.professor_material_read
    assert.equal(typeof tool.output.render, 'function', 'the tool declares output.render')
    const blocks = tool.output.render({ action: 'pages' }, value)
    assert.equal(blocks.length, 3, `one text envelope plus two image blocks (got ${blocks.map((b) => b.type).join(',')})`)
    assert.equal(blocks[0].type, 'text')
    assert.ok(blocks[0].text.includes('"action"'), 'the envelope keeps the structured JSON')
    const [first, second] = blocks.slice(1).map((block, index) => assertImageBlock(block, `page ${index + 1}`))
    assert.deepEqual(
      [first.attachmentId, second.attachmentId],
      value.image_delivery.images.map((image) => image.attachment_id),
      'the emitted blocks reference exactly the attachments this call reports as delivered',
    )
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('plan, text and status results emit no image blocks', async () => {
  const s = await scenario()
  try {
    const tool = s.tools.professor_material_read
    for (const args of [
      { action: 'plan', file_id: s.fileId },
      { action: 'text', file_id: s.fileId, from: 1, to: 1 },
      { action: 'status', file_id: s.fileId },
    ]) {
      const value = await tool.execute(args, s.exec)
      const blocks = tool.output.render(args, value)
      assert.equal(blocks.length, 1, `${args.action}: a single envelope block`)
      assert.equal(blocks[0].type, 'text', `${args.action}: no image blocks`)
    }
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('refused attachments never produce successful delivery claims', async () => {
  const s = await scenario({ attachments: fakeAttachments({ failOn: [1, 2] }) })
  try {
    const value = await s.tools.professor_material_read.execute(
      { action: 'pages', file_id: s.fileId, pages: [1, 2] }, s.exec,
    )
    assert.equal(value.image_delivery.images.length, 0)
    assert.notEqual(value.image_delivery.status, 'delivered', 'nothing was delivered, so nothing claims delivered')
    assert.equal(value.image_delivery.status, 'available-not-delivered')
    assert.ok(value.pages.every((row) => row.status === 'not-delivered'))
    const blocks = s.tools.professor_material_read.output.render({ action: 'pages' }, value)
    assert.equal(blocks.filter((block) => block.type === 'image').length, 0, 'no image block for a refused attachment')
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('unusable attachment metadata is refused instead of emitting a broken image block', async () => {
  // The first saveImage returns width: NaN — not a value a valid image block can carry (the host
  // rejects non-lossless JSON). The tool must demote the page to not-delivered and leave the
  // ledger clean, so the next call can deliver once the service behaves.
  const attachments = fakeAttachments({ brokenOn: [1] })
  const s = await scenario({ attachments })
  try {
    const first = await s.tools.professor_material_read.execute(
      { action: 'pages', file_id: s.fileId, pages: [1] }, s.exec,
    )
    assert.equal(first.image_delivery.images.length, 0)
    assert.notEqual(first.image_delivery.status, 'delivered')
    assert.equal(first.pages[0].status, 'not-delivered')
    assert.ok(
      first.pages[0].suppression === SUPPRESSION.ATTACHMENT_FAILED
      || first.pages[0].suppression === SUPPRESSION.ATTACHMENT_INVALID,
      `an attachment failure, not a delivery: ${first.pages[0].suppression}`,
    )
    assert.ok(first.warnings.some((warning) => /could not be attached|reference/i.test(warning)))
    const blocks = s.tools.professor_material_read.output.render({ action: 'pages' }, first)
    assert.equal(blocks.filter((block) => block.type === 'image').length, 0)

    const second = await s.tools.professor_material_read.execute(
      { action: 'pages', file_id: s.fileId, pages: [1] }, s.exec,
    )
    assert.equal(second.image_delivery.images.length, 1,
      'a page whose earlier attachment was unusable is not permanently suppressed')
    assert.equal(second.image_delivery.status, 'delivered')
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('an image that never reached the model-facing result is not permanently suppressed', async () => {
  // Page 1 attaches and settles, then the caller aborts during page 2's attachment. The ledger
  // must not treat page 1 as inspected: the model never received a result containing its image.
  const controller = new AbortController()
  const attachments = fakeAttachments({
    onCall: ({ attempt }) => { if (attempt === 2) controller.abort() },
  })
  const s = await scenario({ attachments })
  try {
    await assert.rejects(
      () => s.tools.professor_material_read.execute(
        { action: 'pages', file_id: s.fileId, pages: [1, 2] },
        materialExec({ cwd: s.project, sessionId: 'session-mid', controller }),
      ),
      (error) => error.code === 'PROFESSOR_CANCELLED',
    )
    const reader = materialExec({ cwd: s.project, sessionId: 'session-mid' })
    const status = await s.tools.professor_material_read.execute({ action: 'status', file_id: s.fileId }, reader)
    assert.equal(status.coverage.inspected_count, 0, 'nothing was emitted, so nothing is inspected')

    const again = await s.tools.professor_material_read.execute(
      { action: 'pages', file_id: s.fileId, pages: [1] },
      materialExec({ cwd: s.project, sessionId: 'session-mid' }),
    )
    assert.equal(again.image_delivery.images.length, 1,
      'the unemitted page is attached again instead of being suppressed as already delivered')
    assert.equal(again.pages[0].status, 'inspected')
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('successful delivery is recorded only after the projection gate, not at attachment time', async () => {
  const ledger = createReadingLedger()
  // A record written but never emitted must never suppress a re-read: `reuseDecision` only
  // suppresses inspections the model-facing result actually carried.
  ledger.recordInspection('s', { sourceHash: 'h', page: 1, variant: 'v', status: 'inspected', emitted: false, bytes: 10 })
  assert.equal(reuseDecision({ existing: ledger.find('s', { sourceHash: 'h', page: 1 }), variant: 'v' }).reuse, false,
    'a stored-but-unemitted inspection does not suppress')
  ledger.recordInspection('s', { sourceHash: 'h', page: 1, variant: 'v', status: 'inspected', emitted: true, bytes: 10 })
  assert.equal(reuseDecision({ existing: ledger.find('s', { sourceHash: 'h', page: 1 }), variant: 'v' }).reuse, true,
    'once emitted, the safe reuse behaviour is unchanged')
  ledger.dispose()
})

// --- P1-2: coverage tracks body delivery, not classification --------------------

test('a 1000-character page with a 240-character overview is NOT reported as fully read', async () => {
  const s = await scenario({ pages: ONE_PAGE_1000 })
  try {
    const plan = await s.tools.professor_material_read.execute({ action: 'plan', file_id: s.fileId }, s.exec)
    assert.ok(plan.plan.per_page[0].excerpt.length <= 240, 'the plan ships only a bounded excerpt')
    assert.equal(plan.plan.per_page[0].text_chars, 1000)

    const status = await s.tools.professor_material_read.execute({ action: 'status', file_id: s.fileId }, s.exec)
    assert.equal(status.coverage.text_complete_count, 0, 'an excerpt is not the source body')
    assert.equal(status.coverage.text_partial_count, 0)
    assert.deepEqual(status.coverage.overview_only, [1], 'the page has only its overview returned')
    assert.equal(status.coverage.percent_delivered, 0, 'nothing body-complete or visually delivered yet')
    assert.ok(
      !/answered from the text layer/.test(status.coverage.statement),
      `the statement must not claim text-layer coverage from an excerpt: ${status.coverage.statement}`,
    )
    assert.match(status.coverage.statement, /excerpt|overview/)
    assert.ok(status.continuation === null || /action "text"|source body/.test(status.continuation),
      `the continuation directs body retrieval: ${status.continuation}`)
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('a partial text response does not report full-page coverage; completing it does', async () => {
  const s = await scenario({ pages: LONG_PAGE })
  try {
    const first = await s.tools.professor_material_read.execute({ action: 'text', file_id: s.fileId }, s.exec)
    assert.equal(first.content.truncated, true)
    assert.equal(first.content.next_offset, first.content.characters, 'continuation offsets are preserved')
    assert.deepEqual(first.coverage.text_partial, [1], 'part of the body is delivered, not all of it')
    assert.equal(first.coverage.text_complete_count, 0)
    assert.equal(first.coverage.percent_delivered, 0)
    assert.ok(first.coverage.body.delivered_chars < first.coverage.body.total_chars)

    const second = await s.tools.professor_material_read.execute(
      { action: 'text', file_id: s.fileId, text_offset: first.content.next_offset }, s.exec,
    )
    assert.equal(second.content.truncated, false)
    assert.equal(second.content.next_offset, null)
    assert.deepEqual(second.coverage.text_complete, [1], 'every segment delivered makes the page complete')
    assert.equal(second.coverage.percent_delivered, 100)
    assert.equal(second.coverage.body.delivered_chars, second.coverage.body.total_chars)
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('overlapping and repeated reads do not inflate coverage', async () => {
  const s = await scenario({ pages: LONG_PAGE })
  try {
    const first = await s.tools.professor_material_read.execute({ action: 'text', file_id: s.fileId }, s.exec)
    const delivered = first.coverage.body.delivered_chars
    const repeat = await s.tools.professor_material_read.execute({ action: 'text', file_id: s.fileId }, s.exec)
    assert.equal(repeat.coverage.body.delivered_chars, delivered, 're-reading the same range adds nothing')
    assert.deepEqual(repeat.coverage.text_partial, [1], 'still one page, still partial')

    const done = await s.tools.professor_material_read.execute(
      { action: 'text', file_id: s.fileId, text_offset: first.content.next_offset }, s.exec,
    )
    assert.deepEqual(done.coverage.text_complete, [1])
    const again = await s.tools.professor_material_read.execute({ action: 'text', file_id: s.fileId }, s.exec)
    assert.deepEqual(again.coverage.text_complete, [1])
    assert.equal(again.coverage.body.delivered_chars, done.coverage.body.total_chars,
      'a full re-read stays exactly one full body')
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('a narrow requested range does not imply whole-document coverage', async () => {
  const s = await scenario({ pages: SIX_PAGES })
  try {
    const section = await s.tools.professor_material_read.execute(
      { action: 'text', file_id: s.fileId, from: 2, to: 2 }, s.exec,
    )
    assert.equal(section.plan.scope, 'section')
    assert.deepEqual(section.coverage.text_complete, [2], 'only the requested page is body-delivered')

    const whole = await s.tools.professor_material_read.execute({ action: 'status', file_id: s.fileId }, s.exec)
    assert.equal(whole.coverage.scope, 'whole-document')
    assert.deepEqual(whole.coverage.text_complete, [2], 'the other pages are still undelivered')
    assert.equal(whole.coverage.text_complete_count, 1)
    assert.ok(whole.coverage.percent_delivered > 0 && whole.coverage.percent_delivered < 100,
      `a section read does not report whole-document completion: ${whole.coverage.percent_delivered}`)
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('a source content change invalidates previous coverage', async () => {
  const s = await scenario({ pages: ONE_PAGE_1000 })
  try {
    await s.tools.professor_material_read.execute({ action: 'text', file_id: s.fileId }, s.exec)
    const before = await s.tools.professor_material_read.execute({ action: 'status', file_id: s.fileId }, s.exec)
    assert.deepEqual(before.coverage.text_complete, [1])

    await writeFixture(s.home, 'courses/term/CSC4801/01_Lectures/00_Introduction.pdf', 'different-source-bytes')
    const after = await s.tools.professor_material_read.execute(
      { action: 'status', file_id: s.fileId, refresh: true }, s.exec,
    )
    assert.equal(after.coverage.text_complete_count, 0, 'delivery against the old bytes says nothing about the new ones')
    assert.equal(after.coverage.inspected_count, 0)
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('text beyond the per-call page cap is not silently claimed as delivered', async () => {
  const s = await scenario({ pages: EIGHT_PAGES })
  try {
    const first = await s.tools.professor_material_read.execute({ action: 'text', file_id: s.fileId }, s.exec)
    assert.equal(first.content.blocks.length, 6, 'the per-call bound is preserved')
    assert.equal(first.coverage.text_complete_count, 6, 'only what was returned counts as delivered')
    assert.equal(first.content.next_offset !== null, true, 'the remainder is reachable')

    const second = await s.tools.professor_material_read.execute(
      { action: 'text', file_id: s.fileId, text_offset: first.content.next_offset }, s.exec,
    )
    assert.equal(second.coverage.text_complete_count, 8, 'bounded continuation finishes the document')
    assert.equal(second.content.next_offset, null)
    assert.equal(second.coverage.percent_delivered, 100)
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('cancellation during extraction records no body text as delivered', async () => {
  const controller = new AbortController()
  const s = await scenario({
    pages: ONE_PAGE_1000,
    extraction: { onExtract: () => controller.abort() },
  })
  try {
    await assert.rejects(
      () => s.tools.professor_material_read.execute(
        { action: 'text', file_id: s.fileId },
        materialExec({ cwd: s.project, sessionId: 'session-text-cancel', controller }),
      ),
      (error) => error.code === 'PROFESSOR_CANCELLED',
    )
    const status = await s.tools.professor_material_read.execute(
      { action: 'status', file_id: s.fileId },
      materialExec({ cwd: s.project, sessionId: 'session-text-cancel' }),
    )
    assert.equal(status.coverage.text_complete_count, 0)
    assert.equal(status.coverage.text_partial_count, 0)
    assert.equal(status.coverage.body.delivered_chars, 0, 'nothing was returned to the model')
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('an empty page cannot claim body coverage and does not stall delivery of the rest', async () => {
  const s = await scenario({ pages: SIX_PAGES })
  try {
    const result = await s.tools.professor_material_read.execute({ action: 'text', file_id: s.fileId }, s.exec)
    assert.deepEqual(result.coverage.text_complete, [1, 2, 4, 6], 'every non-empty body is delivered')
    assert.equal(result.coverage.text_partial_count, 0)
    assert.ok(!result.coverage.text_complete.includes(3) && !result.coverage.text_complete.includes(5),
      'an empty page has no body to deliver, so it is never text-complete')
    assert.deepEqual(result.coverage.unread, [3, 5], 'empty pages still need visual inspection')
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('unpaged sources report document body delivery without inventing page coverage', async () => {
  const home = await makeHome('professor-delivery-md-')
  try {
    await writeFixture(home, 'reading.md', '# Topic\n' + 'body '.repeat(200))
    const fake = createFakeContext({ home })
    apply(fake.ctx, fake.pluginConfig)
    const tool = toolsByName(fake).professor_material_read
    const exec = materialExec({ cwd: home })
    const partial = await tool.execute({ action: 'text', path: path.join(home, 'reading.md') }, exec)
    assert.equal(partial.content.blocks[0].page, undefined)
    assert.equal(partial.coverage.total, 0, 'no per-page coverage is invented')
    assert.match(partial.coverage.statement, /No per-page coverage could be established/)
    assert.ok(partial.coverage.document_body.delivered_chars > 0)
    assert.equal(partial.coverage.document_body.complete, true, 'the one document block was delivered whole')
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('coverage terminology distinguishes delivery from comprehension', async () => {
  const s = await scenario({ pages: ONE_PAGE_1000 })
  try {
    const status = await s.tools.professor_material_read.execute({ action: 'status', file_id: s.fileId }, s.exec)
    const terms = status.coverage.terminology
    assert.equal(typeof terms, 'object')
    assert.match(terms.inspected, /delivered|included/i)
    assert.match(terms.inspected, /not (proof|comprehension)|does not prove/i,
      'delivery is explicitly not comprehension')
    assert.match(terms.overview_only, /excerpt|overview/i)
    assert.match(terms.text_complete, /complete source body|entire source body/i)
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

// --- multi-block body coverage -------------------------------------------------
//
// The 2026-10-11 acceptance withheld sign-off because delivery intervals were block-local while
// the ledger keyed tracking per page (or per document). One fully delivered block could therefore
// mark a whole page `text_complete` even when sibling blocks were never returned, and a later
// block with a different length erased the tracking of earlier ones. These regressions pin the
// repaired contract: bodies are aggregated across EVERY source block under stable page/document
// body identities with cumulative offsets, and enhanced versus plain-text bodies never share
// intervals.

/** One OCR/enhanced source block on a physical page. */
const ocrBlock = (page, text) => ({ page, text, kind: 'paragraph', origin: 'ocr' })

/** An `enhance_pdf.py` reply carrying exactly these blocks on one page. */
const enhanceResult = (page, blocks) => ({
  ok: true,
  backend: 'docling',
  pages: [{ page, text: blocks.map((block) => block.text).join('\n\n'), ocr_completed: true, blocks }],
})

/** `count` blocks of exactly `blockChars` characters each, numbered so they are distinguishable. */
const numberedBlocks = (page, count, blockChars) => Array.from({ length: count }, (_, index) => {
  const label = `${index + 1}:`
  return ocrBlock(page, label + 'x'.repeat(blockChars - label.length))
})

test('more than six blocks on one page: the first response stays partial until every block is delivered', async () => {
  const s = await scenario({
    extraction: { pages: [{ page: 1, text: 'Plain extraction body' }], enhancement: enhanceResult(1, numberedBlocks(1, 10, 100)) },
    pluginConfig: { enhanceRuntime: { python: '/runtime/python' } },
  })
  try {
    const first = await s.tools.professor_material_read.execute({ action: 'enhance', file_id: s.fileId, pages: [1] }, s.exec)
    assert.equal(first.content.blocks.length, 6, 'the per-call block bound is preserved')
    assert.equal(first.content.truncated, true, 'the first response remains partial')
    assert.equal(first.content.next_offset, 600)
    assert.deepEqual(first.coverage.text_complete, [], 'six delivered blocks are not the whole 10-block page body')
    assert.deepEqual(first.coverage.text_partial, [1])
    assert.deepEqual(first.coverage.body, { delivered_chars: 600, total_chars: 1000 },
      'coverage aggregates every block of the page body at cumulative offsets')

    const second = await s.tools.professor_material_read.execute(
      { action: 'enhance', file_id: s.fileId, pages: [1], text_offset: first.content.next_offset }, s.exec,
    )
    assert.equal(second.content.blocks.length, 4, 'the remaining blocks arrive on continuation')
    assert.equal(second.content.next_offset, null)
    assert.deepEqual(second.coverage.text_complete, [1], 'the page completes only once every block arrived')
    assert.deepEqual(second.coverage.body, { delivered_chars: 1000, total_chars: 1000 })
    assert.equal(second.coverage.percent_delivered, 100)
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('a block crossing the 32000-character response limit is split without losing or double-counting coverage', async () => {
  const blocks = [ocrBlock(1, 'a'.repeat(5000)), ocrBlock(1, 'b'.repeat(40000)), ocrBlock(1, 'c'.repeat(1000))]
  const s = await scenario({
    extraction: { pages: [{ page: 1, text: 'Plain extraction body' }], enhancement: enhanceResult(1, blocks) },
    pluginConfig: { enhanceRuntime: { python: '/runtime/python' } },
  })
  try {
    const first = await s.tools.professor_material_read.execute({ action: 'enhance', file_id: s.fileId, pages: [1] }, s.exec)
    assert.equal(first.content.characters, 32000)
    assert.equal(first.content.next_offset, 32000, 'the crossing block leaves a continuation cursor')
    assert.equal(first.content.blocks.length, 2)
    assert.equal(first.content.blocks[0].text, 'a'.repeat(5000))
    assert.equal(first.content.blocks[1].text, 'b'.repeat(27000), 'the crossing block is cut at the response limit')
    assert.deepEqual(first.coverage.text_partial, [1])
    assert.deepEqual(first.coverage.body, { delivered_chars: 32000, total_chars: 46000 },
      'the split block counts its delivered interval against the full page body')

    const second = await s.tools.professor_material_read.execute(
      { action: 'enhance', file_id: s.fileId, pages: [1], text_offset: first.content.next_offset }, s.exec,
    )
    assert.equal(second.content.blocks[0].text, 'b'.repeat(13000), 'the crossing block continues exactly where it stopped')
    assert.equal(second.content.blocks[1].text, 'c'.repeat(1000))
    assert.equal(second.content.truncated, false)
    assert.deepEqual(second.coverage.text_complete, [1])
    assert.deepEqual(second.coverage.body, { delivered_chars: 46000, total_chars: 46000 })
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('continuation completes coverage only after every required block is delivered', async () => {
  const s = await scenario({
    extraction: { pages: [{ page: 1, text: 'Plain extraction body' }], enhancement: enhanceResult(1, numberedBlocks(1, 15, 100)) },
    pluginConfig: { enhanceRuntime: { python: '/runtime/python' } },
  })
  try {
    const first = await s.tools.professor_material_read.execute({ action: 'enhance', file_id: s.fileId, pages: [1] }, s.exec)
    assert.deepEqual(first.coverage.body, { delivered_chars: 600, total_chars: 1500 })
    assert.deepEqual(first.coverage.text_partial, [1])

    const second = await s.tools.professor_material_read.execute(
      { action: 'enhance', file_id: s.fileId, pages: [1], text_offset: first.content.next_offset }, s.exec,
    )
    assert.deepEqual(second.coverage.text_complete, [], 'twelve of fifteen blocks is still not the complete body')
    assert.deepEqual(second.coverage.text_partial, [1])
    assert.deepEqual(second.coverage.body, { delivered_chars: 1200, total_chars: 1500 })

    const third = await s.tools.professor_material_read.execute(
      { action: 'enhance', file_id: s.fileId, pages: [1], text_offset: second.content.next_offset }, s.exec,
    )
    assert.deepEqual(third.coverage.text_complete, [1], 'the final blocks complete the page')
    assert.deepEqual(third.coverage.body, { delivered_chars: 1500, total_chars: 1500 })
    assert.equal(third.coverage.percent_delivered, 100)
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('repeated and overlapping delivery neither inflates coverage nor erases earlier blocks', async () => {
  const s = await scenario({
    extraction: { pages: [{ page: 1, text: 'Plain extraction body' }], enhancement: enhanceResult(1, numberedBlocks(1, 8, 100)) },
    pluginConfig: { enhanceRuntime: { python: '/runtime/python' } },
  })
  try {
    const first = await s.tools.professor_material_read.execute({ action: 'enhance', file_id: s.fileId, pages: [1] }, s.exec)
    assert.deepEqual(first.coverage.body, { delivered_chars: 600, total_chars: 800 })

    const repeat = await s.tools.professor_material_read.execute({ action: 'enhance', file_id: s.fileId, pages: [1] }, s.exec)
    assert.deepEqual(repeat.coverage.body, { delivered_chars: 600, total_chars: 800 },
      're-reading the same range adds nothing')
    assert.deepEqual(repeat.coverage.text_partial, [1])

    const tail = await s.tools.professor_material_read.execute(
      { action: 'enhance', file_id: s.fileId, pages: [1], text_offset: 700 }, s.exec,
    )
    assert.deepEqual(tail.coverage.body, { delivered_chars: 700, total_chars: 800 },
      'a later disjoint block adds its own interval without erasing the earlier six')
    assert.deepEqual(tail.coverage.text_partial, [1], 'the undelivered block 7 keeps the page partial')

    const gap = await s.tools.professor_material_read.execute(
      { action: 'enhance', file_id: s.fileId, pages: [1], text_offset: 600 }, s.exec,
    )
    assert.deepEqual(gap.coverage.body, { delivered_chars: 800, total_chars: 800 })
    assert.deepEqual(gap.coverage.text_complete, [1], 'filling the gap completes the page')

    const again = await s.tools.professor_material_read.execute({ action: 'enhance', file_id: s.fileId, pages: [1] }, s.exec)
    assert.deepEqual(again.coverage.body, { delivered_chars: 800, total_chars: 800 },
      'a full re-read inflates nothing')
    assert.deepEqual(again.coverage.text_complete, [1])
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('multiple blocks in an unpaged document aggregate document body coverage', async () => {
  const home = await makeHome('professor-delivery-deck-')
  try {
    await writeFixture(home, 'deck.pptx', 'mock-office-source')
    const { shell } = scriptedExtraction({
      office: {
        ok: true,
        format: 'pptx',
        units: Array.from({ length: 7 }, (_, index) => ({
          kind: 'slide', index: index + 1, title: null, text: `Slide ${index + 1} body text.`,
        })),
        notes: ['pptx: 7 slide(s)'],
      },
    })
    const fake = createFakeContext({ home, services: { shell } })
    apply(fake.ctx, fake.pluginConfig)
    const tool = toolsByName(fake).professor_material_read
    const exec = materialExec({ cwd: home })
    const deck = path.join(home, 'deck.pptx')

    const first = await tool.execute({ action: 'text', path: deck }, exec)
    assert.equal(first.content.blocks.length, 6, 'slide bodies are separate source blocks of the document')
    assert.equal(first.content.truncated, true)
    assert.equal(first.coverage.total, 0, 'no per-page coverage is invented for a deck')
    assert.equal(first.coverage.document_body.complete, false,
      'six of seven slide blocks is not the complete document body')
    assert.equal(first.coverage.document_body.delivered_chars, first.content.characters)
    assert.ok(first.coverage.document_body.total_chars > first.coverage.document_body.delivered_chars)

    const second = await tool.execute({ action: 'text', path: deck, text_offset: first.content.next_offset }, exec)
    assert.equal(second.content.blocks.length, 1, 'the last slide block arrives on continuation')
    assert.equal(second.coverage.document_body.complete, true,
      'document coverage completes only after every slide block was delivered')
    assert.equal(second.coverage.document_body.delivered_chars, second.coverage.document_body.total_chars)
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('switching between enhanced and plain-text bodies does not reuse incompatible intervals', async () => {
  // The enhanced body concatenates to EXACTLY the plain body text ('x' × 40000): equal lengths and
  // equal content are precisely what must not merge. Only the body version (enhanced vs plain)
  // separates them.
  const blocks = Array.from({ length: 8 }, () => ocrBlock(1, 'x'.repeat(5000)))
  const s = await scenario({
    extraction: { pages: [{ page: 1, text: 'x'.repeat(40000) }], enhancement: enhanceResult(1, blocks) },
    pluginConfig: { enhanceRuntime: { python: '/runtime/python' } },
  })
  try {
    const plain1 = await s.tools.professor_material_read.execute({ action: 'text', file_id: s.fileId }, s.exec)
    assert.deepEqual(plain1.coverage.body, { delivered_chars: 32000, total_chars: 40000 })
    assert.deepEqual(plain1.coverage.text_partial, [1])

    const enhanced1 = await s.tools.professor_material_read.execute({ action: 'enhance', file_id: s.fileId, pages: [1] }, s.exec)
    assert.equal(enhanced1.content.next_offset, 30000, 'six of eight enhanced blocks were returned')
    assert.deepEqual(enhanced1.coverage.text_partial, [1],
      'a partial enhanced body is not complete even though an equal-length plain body was partly delivered')
    assert.deepEqual(enhanced1.coverage.body, { delivered_chars: 30000, total_chars: 40000 },
      'plain-body intervals never count against the enhanced body')

    const enhanced2 = await s.tools.professor_material_read.execute(
      { action: 'enhance', file_id: s.fileId, pages: [1], text_offset: enhanced1.content.next_offset }, s.exec,
    )
    assert.deepEqual(enhanced2.coverage.text_complete, [1], 'the enhanced body completes from its own blocks alone')

    const plain2 = await s.tools.professor_material_read.execute({ action: 'text', file_id: s.fileId }, s.exec)
    assert.deepEqual(plain2.coverage.text_partial, [1],
      'a complete enhanced body does not leak into the plain version')
    assert.deepEqual(plain2.coverage.body, { delivered_chars: 32000, total_chars: 40000 })

    const plain3 = await s.tools.professor_material_read.execute(
      { action: 'text', file_id: s.fileId, text_offset: plain2.content.next_offset }, s.exec,
    )
    assert.deepEqual(plain3.coverage.text_complete, [1])
    assert.deepEqual(plain3.coverage.body, { delivered_chars: 40000, total_chars: 40000 })
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

// --- pure ledger/plan units -----------------------------------------------------

test('text delivery intervals merge and never double-count', () => {
  const ledger = createReadingLedger()
  ledger.recordTextDelivery('s', {
    sourceHash: 'h',
    segments: [
      { page: 1, bodyId: 'source:one', start: 0, end: 300, length: 1000 },
      { page: 1, bodyId: 'source:one', start: 250, end: 600, length: 1000 },
    ],
  })
  let view = ledger.coverage('s', { sourceHash: 'h', plan: buildReadingPlan({ pages: [{ page: 1, text: 't'.repeat(1000) }], totalPages: 1 }), scopePages: [1] })
  assert.deepEqual(view.text_partial, [1], 'overlapping segments merge into one partial delivery')
  assert.equal(view.body.delivered_chars, 600)
  ledger.recordTextDelivery('s', {
    sourceHash: 'h',
    segments: [
      { page: 1, bodyId: 'source:one', start: 600, end: 1000, length: 1000 },
      { page: 1, bodyId: 'source:one', start: 0, end: 1000, length: 1000 },
    ],
  })
  view = ledger.coverage('s', { sourceHash: 'h', plan: buildReadingPlan({ pages: [{ page: 1, text: 't'.repeat(1000) }], totalPages: 1 }), scopePages: [1] })
  assert.deepEqual(view.text_complete, [1])
  assert.equal(view.body.delivered_chars, 1000, 'a complete re-read inflates nothing')
  ledger.dispose()
})

test('a body whose identity changed between reads restarts delivery tracking', () => {
  const ledger = createReadingLedger()
  ledger.recordTextDelivery('s', { sourceHash: 'h', segments: [{ page: 1, bodyId: 'source:old', start: 0, end: 400, length: 400 }] })
  ledger.recordTextDelivery('s', { sourceHash: 'h', segments: [{ page: 1, bodyId: 'source:new', start: 0, end: 100, length: 900 }] })
  const view = ledger.coverage('s', { sourceHash: 'h', plan: buildReadingPlan({ pages: [{ page: 1, text: 't'.repeat(900) }], totalPages: 1 }), scopePages: [1] })
  assert.deepEqual(view.text_partial, [1], 'stale intervals of a different body are discarded')
  assert.equal(view.body.delivered_chars, 100)
  ledger.dispose()
})

test('equal-length bodies with different identities never merge', () => {
  const ledger = createReadingLedger()
  ledger.recordTextDelivery('s', { sourceHash: 'h', segments: [{ page: 1, bodyId: 'source:one', start: 0, end: 100, length: 1000 }] })
  ledger.recordTextDelivery('s', { sourceHash: 'h', segments: [{ page: 1, bodyId: 'enhanced:two', start: 0, end: 100, length: 1000 }] })
  const view = ledger.coverage('s', { sourceHash: 'h', plan: buildReadingPlan({ pages: [{ page: 1, text: 't'.repeat(1000) }], totalPages: 1 }), scopePages: [1] })
  assert.deepEqual(view.text_partial, [1])
  assert.equal(view.body.delivered_chars, 100,
    'two equal-length blocks of different bodies cover 100 characters, not 200 and never the page')
  ledger.dispose()
})

test('a body version resumes its own intervals and never adopts another version\'s', () => {
  const ledger = createReadingLedger()
  const plan = buildReadingPlan({ pages: [{ page: 1, text: 'x'.repeat(40000) }], totalPages: 1 })
  ledger.recordTextDelivery('s', { sourceHash: 'h', segments: [{ page: 1, bodyId: 'source:plain', start: 0, end: 32000, length: 40000 }] })
  ledger.recordTextDelivery('s', { sourceHash: 'h', segments: [{ page: 1, bodyId: 'enhanced:ocr', start: 0, end: 30000, length: 40000 }] })
  let view = ledger.coverage('s', { sourceHash: 'h', plan, scopePages: [1] })
  assert.deepEqual(view.text_partial, [1], 'the enhanced version is only partial despite the equal-length plain intervals')
  assert.equal(view.body.delivered_chars, 30000, 'plain intervals never count against the enhanced body')
  ledger.recordTextDelivery('s', { sourceHash: 'h', segments: [{ page: 1, bodyId: 'source:plain', start: 32000, end: 40000, length: 40000 }] })
  view = ledger.coverage('s', { sourceHash: 'h', plan, scopePages: [1] })
  assert.deepEqual(view.text_complete, [1], 'returning to the plain body resumes exactly its own intervals')
  assert.equal(view.body.delivered_chars, 40000)
  ledger.dispose()
})

test('coverage statement never claims a page is read from classification alone', () => {
  const plan = buildReadingPlan({ pages: ONE_PAGE_1000, totalPages: 1 })
  const block = {
    scope: plan.scope,
    inspected: [], text_complete: [], text_partial: [], noted: [], overview_only: [1], unreadable: [], unread: [],
    inspected_count: 0, text_complete_count: 0, text_partial_count: 0, noted_count: 0,
    overview_only_count: 1, unreadable_count: 0, unread_count: 0,
    total: 1, percent_delivered: 0,
    body: { delivered_chars: 0, total_chars: 1000 },
    notes_available: 0,
  }
  const statement = coverageStatement(block)
  assert.match(statement, /0 page image/)
  assert.match(statement, /excerpt|overview/)
  assert.ok(!/answered from the text layer/.test(statement))
  assert.ok(!/100/.test(statement) || /0%|0 page/.test(statement), 'no 100% claim is possible here')
})
