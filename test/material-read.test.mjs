/**
 * `professor_material_read`: bounded, non-repetitive material reading.
 *
 * These tests drive the production code path — the real tool, the real extraction service, the real
 * renderer contract and the real ledger — against a scripted shell seam, because the claim under
 * test is the *decision* the plugin makes (reuse vs re-attach, budget vs loop, honest coverage vs
 * invented coverage), not the output of a particular binary.
 *
 * The central regression is reproduced end to end: read a page → the host offloads the image →
 * the same page is requested again → the ledger answers with a summary instead of attaching it a
 * second time.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { createReadingLedger, renderVariant, reuseDecision, SUPPRESSION } from '../src/material/ledger.js'
import {
  buildReadingPlan, compactPlan, coverageStatement, numberingContract, rescopeReadingPlan,
} from '../src/material/plan.js'
import { createFakeContext, createScriptedShell, makeHome, writeFixture } from './helpers/fake-harness.mjs'

// --- fixtures --------------------------------------------------------------------------------------------

/** The project document, with source roots spelled the way the registry expects: absolute. */
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
  - course_id: csc9999
    course_code: GFN1000
    term: '2025-2026 Fall'
    display_name: Unrelated Course
    status: active
    sources:
      - path: ${path.join(project, 'GFN1000')}
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

/** Six physical pages: three with a usable text layer, one thin, two with no text at all. */
const TEXT_PAGES = [
  { page: 1, text: 'CSC4801 Lecture 00 — Introduction to AI-assisted Software Engineering. This course studies how practitioners keep doing software engineering well when code generation is cheap, and where the bottlenecks actually move: requirements, verification, maintenance and the ability to reason about a change.' },
  { page: 2, text: 'Learning outcomes. By the end of the course you should be able to state what an agent is, distinguish a tool call from a plan, and explain why evaluation is a first-class engineering concern rather than an afterthought bolted on at release time.' },
  { page: 3, text: '' },
  { page: 4, text: 'Assessment. Coursework is split between a reading journal, a practical build and a final write-up. The weights are published in the handbook; nothing here invents a weighting.' },
  { page: 5, text: '' },
  { page: 6, text: 'Summary. We moved from the motivation for the course, through what an agent is, to how the work is assessed, and finished with the open questions this lecture deliberately leaves unanswered for now.' },
]

/** Twelve pages: even pages carry a usable text layer, odd pages have none at all. */
const MANY_PAGES = Array.from({ length: 12 }, (_, index) => ({
  page: index + 1,
  text: index % 2 === 0 ? `Page ${index + 1} body. `.repeat(30) : '',
}))

/** A large document, for a request whose selected pages sit far apart. */
const LARGE_PAGES = Array.from({ length: 1200 }, (_, index) => ({
  page: index + 1,
  text: index % 3 === 0 ? `Large page ${index + 1} body. `.repeat(20) : '',
}))

const DEFAULT_PROBE = {
  ok: true,
  python: '3.12.0',
  modules: { fitz: '1.28.2', pymupdf: '1.28.2', docx: '1.2.0', pptx: '1.0.2', openpyxl: '3.1.5', lxml: '6.1.3' },
  missing: [],
}

const b64 = (bytes) => Buffer.alloc(bytes, 0x4a).toString('base64')

/**
 * A scripted shell that answers the probe, the text extractor and the renderer.
 *
 * `ignoreByteBudget` / `extraPages` model a renderer that misbehaves — one that overshoots the
 * budget it was given, or hands back pages nobody asked for. Both are defensive: the real
 * `render_pages.py` honours its budget and renders exactly the list it is given, and the tool has
 * to stay correct even if a backend ever does not.
 */
function scriptedExtraction({
  probe = DEFAULT_PROBE, pages = TEXT_PAGES, imageBytes = 4096, failRender = false,
  ignoreByteBudget = false, extraPages = [], onRender = null, enhancement = null,
} = {}) {
  const calls = []
  const shell = createScriptedShell((command) => {
    calls.push(command)
    if (command.includes('probe_python.py')) return { stdout: JSON.stringify(probe) }
    if (command.includes('enhance_pdf.py')) return { stdout: JSON.stringify(enhancement ?? { ok: false, error: 'unavailable', detail: 'not prepared' }) }
    if (command.includes('extract_pdf.py')) {
      return {
        stdout: JSON.stringify({
          ok: true,
          pages,
          notes: ['pymupdf: text layer only; no page was rendered and no OCR ran'],
        }),
      }
    }
    if (command.includes('extract_office.py')) return { stdout: JSON.stringify({ ok: true, format: 'docx',
      units: [{ kind: 'document', index: 1, title: null, text: '# A Word heading\nWord source body.' }], notes: [] }) }
    if (command.includes('render_pages.py')) {
      if (typeof onRender === 'function') onRender(command)
      if (failRender) return { stdout: JSON.stringify({ ok: false, error: 'malformed', detail: 'scripted failure' }) }
      // Mirrors `render_pages.py`: an explicit `--pages` list wins, and the byte budget is honoured
      // exactly, stopping at the first page that would not fit.
      const explicit = /--pages ([0-9,]+)/.exec(command)?.[1]
      const list = explicit !== undefined
        ? explicit.split(',').map(Number)
        : Array.from(
          { length: Number(/--to (\d+)/.exec(command)?.[1] ?? 1) - Number(/--from (\d+)/.exec(command)?.[1] ?? 1) + 1 },
          (_, index) => Number(/--from (\d+)/.exec(command)?.[1] ?? 1) + index,
        )
      const byteBudget = Number(/--max-total-bytes (\d+)/.exec(command)?.[1] ?? Number.MAX_SAFE_INTEGER)
      const rendered = []
      let total = 0
      let truncated = false
      for (const page of [...list, ...extraPages]) {
        if (!ignoreByteBudget && total + imageBytes > byteBudget) { truncated = true; break }
        total += imageBytes
        rendered.push({ page, width: 1600, height: 900, bytes: imageBytes, b64: b64(imageBytes) })
      }
      return {
        stdout: JSON.stringify({
          ok: true, pages: rendered, truncated, total_pages: pages.length, requested: list, notes: [],
        }),
      }
    }
    if (command.includes('--version')) return { stdout: '10.02.0\n' }
    if (command.includes(' -h') || command.endsWith('-h')) return { stdout: 'txtwrite png16m\n' }
    return { stdout: '' }
  })
  return { shell, calls }
}

function fakeAttachments({ limit = 20 * 1024 * 1024, failOn = [], onCall = null } = {}) {
  const saved = []
  const failures = []
  let counter = 0
  return {
    saved,
    failures,
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
      if (failOn.includes(counter)) {
        failures.push(counter)
        throw new Error(`scripted attachment refusal for attempt ${counter}`)
      }
      const ref = {
        attachmentId: `att_${counter}`,
        mediaType,
        bytes: data.byteLength,
        width: 1600,
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

function materialExec({ cwd, sessionId = 'session-material', aborted = false, controller } = {}) {
  const handle = controller ?? new AbortController()
  if (aborted) handle.abort()
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

/**
 * Build a bound Professor project with one indexed lecture, mounted through `apply`.
 *
 * @returns `{ home, project, fake, tools, exec, fileId, pdfPath, pdfHash, attachment, shellCalls }`.
 */
async function scenario(options = {}) {
  const home = await makeHome('professor-material-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/CSC4801/01_Lectures/00_Introduction.pdf', 'not-a-real-pdf-but-a-stable-source')
  await writeFixture(home, 'courses/term/.professor/project.yaml', projectYaml(project))

  const { shell, calls } = scriptedExtraction(options.extraction ?? {})
  // `attachments: null` simulates a host with no attachment service mounted — a real unsupported
  // integration, not a mock that pretends delivery worked.
  const attachment = options.attachments === null ? null : (options.attachments ?? fakeAttachments())
  const services = {
    shell,
    ...(attachment === null ? {} : { attachments: attachment }),
    llm: options.llm ?? fakeLlm(),
    ...(options.extraServices ?? {}),
  }
  const fake = createFakeContext({ home, services })
  apply(fake.ctx, {
    ...fake.pluginConfig,
    ...(options.pluginConfig ?? {}),
  })
  const tools = toolsByName(fake)
  const exec = materialExec({ cwd: project, sessionId: options.sessionId ?? 'session-material' })
  const indexed = await tools.professor_index_sync.execute({ force: true }, exec)
  const indexFile = JSON.parse(await fs.readFile(path.join(project, '.professor/indexes/files.json'), 'utf8'))
  const record = indexFile.files.find((entry) => entry.relative_path.endsWith('00_Introduction.pdf'))
  assert.ok(record, `the lecture is indexed (${JSON.stringify(indexFile.files.map((entry) => entry.relative_path))})`)
  assert.equal(indexed.status, 'synced')
  const pdfPath = path.join(project, record.relative_path)
  const pdfHash = createHash('sha256').update(await fs.readFile(pdfPath)).digest('hex')
  return {
    home,
    project,
    fake,
    tools,
    exec,
    fileId: record.file_id,
    pdfPath,
    pdfHash,
    attachment,
    shellCalls: calls,
    indexFile,
  }
}

// --- plan ------------------------------------------------------------------------------------------

test('standalone PDF can be read without a project or file index', async () => {
  const home = await makeHome('professor-standalone-')
  try {
    await writeFixture(home, 'lecture.pdf', 'standalone-pdf')
    const { shell } = scriptedExtraction()
    const fake = createFakeContext({ home, services: { shell } })
    apply(fake.ctx, fake.pluginConfig)
    const tool = toolsByName(fake).professor_material_read
    const result = await tool.execute({ path: path.join(home, 'lecture.pdf') }, materialExec({ cwd: home }))
    assert.equal(result.plan.total_pages, TEXT_PAGES.length)
    assert.equal(result.source.authorization, 'configured-read-root')
    await assert.rejects(fs.stat(path.join(home, '.professor')), { code: 'ENOENT' })
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('text action delivers page body beyond the short plan excerpt', async () => {
  const s = await scenario()
  try {
    const result = await s.tools.professor_material_read.execute({ action: 'text', file_id: s.fileId, from: 2, to: 2 }, s.exec)
    assert.equal(result.action, 'text')
    assert.ok(result.content.blocks[0].text.includes('afterthought bolted on at release time'))
    assert.equal(result.content.blocks[0].page, 2)
    assert.equal(result.content.truncated, false)
    assert.equal(s.attachment.saved.length, 0)
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('standalone Markdown returns source text without fabricated pages', async () => {
  const home = await makeHome('professor-standalone-text-')
  try {
    await writeFixture(home, 'reading.md', '# Topic\nA source paragraph for teaching.')
    const fake = createFakeContext({ home })
    apply(fake.ctx, fake.pluginConfig)
    const result = await toolsByName(fake).professor_material_read.execute({ action: 'text', path: path.join(home, 'reading.md') }, materialExec({ cwd: home }))
    assert.equal(result.content.blocks[0].text, '# Topic\nA source paragraph for teaching.')
    assert.equal(result.content.blocks[0].page, undefined)
    assert.equal(result.content.blocks[0].origin, 'source')
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('standalone path outside configured roots is denied before hashing', async () => {
  const home = await makeHome('professor-standalone-denied-')
  const external = await makeHome('professor-external-')
  try {
    await writeFixture(external, 'reading.md', 'Private external text')
    const fake = createFakeContext({ home })
    apply(fake.ctx, fake.pluginConfig)
    await assert.rejects(toolsByName(fake).professor_material_read.execute({ action: 'text', path: path.join(external, 'reading.md') }, materialExec({ cwd: home })), { code: 'PROFESSOR_PATH_DENIED' })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(external, { recursive: true, force: true })
  }
})

test('cached narrow plans retain source body for later ranges', async () => {
  const s = await scenario()
  try {
    await s.tools.professor_material_read.execute({ file_id: s.fileId, from: 2, to: 2 }, s.exec)
    const result = await s.tools.professor_material_read.execute({ action: 'text', file_id: s.fileId, from: 6, to: 6 }, s.exec)
    assert.equal(result.content.blocks.length, 1)
    assert.equal(result.content.blocks[0].page, 6)
    assert.ok(result.content.blocks[0].text.includes('Summary'))
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('long unpaged source can continue without repeating its prefix', async () => {
  const home = await makeHome('professor-text-cursor-')
  try {
    await writeFixture(home, 'reading.md', 'a'.repeat(33000) + 'FINISH')
    const fake = createFakeContext({ home })
    apply(fake.ctx, fake.pluginConfig)
    const tool = toolsByName(fake).professor_material_read
    const exec = materialExec({ cwd: home })
    const first = await tool.execute({ action: 'text', path: path.join(home, 'reading.md') }, exec)
    assert.equal(first.content.next_offset, 32000)
    const second = await tool.execute({ action: 'text', path: path.join(home, 'reading.md'), text_offset: first.content.next_offset }, exec)
    assert.equal(second.content.blocks[0].text, 'a'.repeat(1000) + 'FINISH')
    assert.equal(second.content.truncated, false)
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('source body cache has a global character bound', () => {
  const ledger = createReadingLedger({ maxSourceChars: 10 })
  ledger.storePlan('a', 'one', { source_blocks: [{ text: '12345678' }] })
  ledger.storePlan('b', 'two', { source_blocks: [{ text: 'abcdefgh' }] })
  assert.equal(ledger.planFor('a', 'one').plan, null)
  assert.ok(ledger.planFor('b', 'two').plan)
})

test('image-bearing text pages require visual reading despite plentiful text', () => {
  const plan = buildReadingPlan({ pages: [{ page: 1, text: 'Many words '.repeat(100), visual_features: ['embedded-image'] }] })
  assert.deepEqual(plan.needs_visual, [1])
  assert.deepEqual(plan.per_page[0].visual_features, ['embedded-image'])
})

test('classification is described honestly: thin text is a reason to look, not proof of a chart', () => {
  const plan = buildReadingPlan({ pages: [{ page: 1, text: 'Hi' }, { page: 2, text: 'Many words '.repeat(100) }] })
  assert.deepEqual(plan.needs_visual, [1])
  assert.match(plan.classification_note, /does not prove a chart/i)
  assert.match(plan.classification_note, /text_sufficient does not mean the body has been delivered/i)
  assert.match(plan.classification_note, /action "pages"/i, 'explicit visual inspection stays available for any page')
})

test('scanned PDF plan preserves known physical pages', async () => {
  const s = await scenario({ extraction: { pages: [{ page: 1, text: '' }, { page: 2, text: '' }] } })
  try {
    const result = await s.tools.professor_material_read.execute({ file_id: s.fileId }, s.exec)
    assert.equal(result.plan.total_pages, 2)
    assert.equal(result.plan.per_page.length, 2)
    assert.equal(result.plan.text_layer.available, false)
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('explicit paths retain indexed course ownership and obey course filters', async () => {
  const s = await scenario()
  try {
    await assert.rejects(s.tools.professor_material_read.execute({ path: s.pdfPath, course: 'csc9999' }, s.exec), { code: 'PROFESSOR_COURSE_MISMATCH' })
    const result = await s.tools.professor_material_read.execute({ path: s.pdfPath, course: 'csc4801' }, s.exec)
    assert.equal(result.source.course_id, 'csc4801')
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('empty scanned pages do not stall text continuation', async () => {
  const s = await scenario({ extraction: { pages: [...Array.from({ length: 6 }, (_, i) => ({ page: i + 1, text: '' })), { page: 7, text: 'The actual source body' }] } })
  try {
    const result = await s.tools.professor_material_read.execute({ action: 'text', file_id: s.fileId }, s.exec)
    assert.equal(result.content.blocks[0].page, 7)
    assert.equal(result.content.blocks[0].text, 'The actual source body')
    assert.equal(result.content.truncated, false)
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('standalone DOCX delivers body without inventing page coordinates', async () => {
  const home = await makeHome('professor-word-')
  try {
    await writeFixture(home, 'lecture.docx', 'mock-office-source')
    const { shell, calls } = scriptedExtraction()
    const fake = createFakeContext({ home, services: { shell } })
    apply(fake.ctx, fake.pluginConfig)
    const result = await toolsByName(fake).professor_material_read.execute({ action: 'text', path: path.join(home, 'lecture.docx') }, materialExec({ cwd: home }))
    assert.ok(result.content.blocks[0].text.includes('Word source body'))
    assert.equal(result.content.blocks[0].page, undefined)
    assert.ok(calls.some(command => command.includes('extract_office.py')))
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('enhance action supplies OCR body and leaves learning state untouched', async () => {
  const s = await scenario({ pluginConfig: { enhanceRuntime: { python: '/runtime/python' } },
    extraction: { enhancement: { ok: true, backend: 'docling', pages: [{ page: 3, text: 'Recognized scan body', ocr_completed: true,
      blocks: [{ page: 3, text: 'Recognized scan body', origin: 'ocr', kind: 'paragraph' }] }] } } })
  try {
    const result = await s.tools.professor_material_read.execute({ action: 'enhance', file_id: s.fileId, pages: [3] }, s.exec)
    assert.equal(result.enhancement.status, 'enhanced')
    assert.equal(result.content.blocks[0].origin, 'ocr')
    assert.equal(result.content.blocks[0].text, 'Recognized scan body')
    assert.equal(result.image_delivery.status, 'not-requested')
    await assert.rejects(fs.stat(path.join(s.project, '.professor/state')), { code: 'ENOENT' })
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('large table cells cannot bypass the bounded teaching payload', async () => {
  const text = 'a'.repeat(50000)
  const s = await scenario({ pluginConfig: { enhanceRuntime: { python: '/runtime/python' } },
    extraction: { enhancement: { ok: true, backend: 'docling', pages: [{ page: 3, text,
      blocks: [{ page: 3, text, cells: [[text]], kind: 'table', origin: 'enhanced-extraction' }] }] } } })
  try {
    const result = await s.tools.professor_material_read.execute({ action: 'enhance', file_id: s.fileId, pages: [3] }, s.exec)
    assert.ok(JSON.stringify(result.content).length < 34000)
    assert.equal(result.content.blocks[0].cells_omitted, true)
    assert.equal(result.content.next_offset, 32000)
  } finally { await fs.rm(s.home, { recursive: true, force: true }) }
})

test('a whole-document plan enumerates every physical page and separates visual from text-only', async () => {
  const s = await scenario()
  const plan = await s.tools.professor_material_read.execute({ action: 'plan', file_id: s.fileId }, s.exec)

  assert.equal(plan.plan.scope, 'whole-document')
  assert.equal(plan.plan.total_pages, 6)
  assert.equal(plan.plan.per_page.length, 6, 'every physical page is enumerated, not a search slice')
  assert.deepEqual(plan.plan.text_sufficient, [1, 2, 4, 6])
  assert.deepEqual(plan.plan.needs_visual, [])
  assert.deepEqual(plan.plan.no_text_layer, [3, 5])
  assert.match(plan.plan.whole_document_note, /search hits is not coverage/)
  assert.equal(plan.plan.method, 'text-layer-first')
})

test('a section request is labelled a section and is not reported as whole-document coverage', async () => {
  const s = await scenario()
  const plan = await s.tools.professor_material_read.execute(
    { action: 'plan', file_id: s.fileId, from: 2, to: 4 }, s.exec,
  )
  assert.equal(plan.plan.scope, 'section')
  assert.deepEqual(plan.plan.per_page.map((entry) => entry.page), [2, 3, 4])
  assert.match(plan.plan.section_note, /do not report it as whole-document/)
  assert.match(plan.coverage.statement, /^Section coverage:/)
})

test('physical page numbers stay separate from printed numbering: nothing is guessed', async () => {
  const s = await scenario()
  const plan = await s.tools.professor_material_read.execute({ action: 'plan', file_id: s.fileId }, s.exec)
  assert.deepEqual(plan.numbering, numberingContract())
  assert.equal(plan.numbering.printed, null)
  assert.equal(plan.numbering.correspondence, 'not-established')
  for (const entry of plan.plan.per_page) {
    assert.equal(typeof entry.page, 'number')
    assert.equal('printed_page' in entry, false, 'no printed/footer number is invented')
    assert.equal('footer' in entry, false)
  }
})

test('an ambiguous source is refused: the reader never guesses which lecture was meant', async () => {
  const s = await scenario()
  await assert.rejects(
    () => s.tools.professor_material_read.execute({ action: 'plan' }, s.exec),
    (error) => error.code === 'PROFESSOR_MATERIAL_SOURCE_MISSING',
  )
  await assert.rejects(
    () => s.tools.professor_material_read.execute({ action: 'plan', file_id: s.fileId, path: '/tmp/x.pdf' }, s.exec),
    (error) => error.code === 'PROFESSOR_MATERIAL_SOURCE_INVALID',
  )
})

// --- bounded, non-repetitive reading ------------------------------------------------------

test('repeating the same page read reuses the ledger instead of attaching the image again', async () => {
  const s = await scenario()
  const first = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1, 2] }, s.exec,
  )
  assert.equal(first.image_delivery.images.length, 2, 'the first read delivers the images')
  const rendersAfterFirst = s.shellCalls.filter((line) => line.includes('render_pages.py')).length

  const second = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1, 2] }, s.exec,
  )
  assert.equal(second.image_delivery.images.length, 0, 'an unchanged page at an unchanged variant is not re-attached')
  assert.deepEqual(second.pages.map((entry) => entry.status), ['reused', 'reused'])
  assert.deepEqual(second.pages.map((entry) => entry.suppression), [
    SUPPRESSION.ALREADY_INSPECTED, SUPPRESSION.ALREADY_INSPECTED,
  ])
  assert.equal(second.budget.suppressed, 2)
  assert.equal(
    s.shellCalls.filter((line) => line.includes('render_pages.py')).length,
    rendersAfterFirst,
    'no render process is started for a page that is already on the ledger',
  )
  assert.equal(s.attachment.saved.length, 2, 'the attachment service was never asked for a second copy')
})

/**
 * The regression the live comparison produced, reproduced deterministically:
 * read page → image offloaded → the same page is asked for again → a summary, not a second image.
 */
test('regression: read a page, the host offloads it, the same page is asked for again', async () => {
  const s = await scenario()
  const read = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1] }, s.exec,
  )
  assert.equal(read.image_delivery.images.length, 1)
  const attachmentId = read.image_delivery.images[0].attachment_id

  // What the host does when the request exceeds the image bound: the block stops being an image.
  // Nothing in the plugin's payload depends on the image surviving, only on the text envelope.
  const offloaded = read.pages.map((entry) => ({ ...entry, image: null }))
  assert.equal(offloaded[0].excerpt, TEXT_PAGES[0].text.slice(0, 240).replace(/\s+/g, ' ').trim().slice(0, 240))

  const again = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1], notes: [{ page: 1, text: '课程定位与考核方式' }] },
    s.exec,
  )
  assert.equal(again.image_delivery.images.length, 0, 'the offloaded page is not attached a second time')
  assert.equal(again.pages[0].status, 'reused')
  assert.equal(again.pages[0].note, '课程定位与考核方式')
  assert.ok(again.pages[0].excerpt.length > 0, 'the text excerpt still carries the page content')
  assert.equal(again.pages[0].provenance.source_hash, s.indexFile.files.find((r) => r.file_id === s.fileId).content_hash)

  const status = await s.tools.professor_material_read.execute({ action: 'status', file_id: s.fileId }, s.exec)
  assert.equal(status.coverage.notes_available, 1, 'the note survives without any image being present')
  assert.equal(status.coverage.inspected_count, 1)
  assert.notEqual(status.coverage.statement, '')
  assert.equal(s.attachment.saved.length, 1, `attachment ${attachmentId} was created exactly once`)
})

test('a source change and a higher-resolution variant are both allowed to re-read', async () => {
  const s = await scenario()
  await s.tools.professor_material_read.execute({ action: 'pages', file_id: s.fileId, pages: [1] }, s.exec)

  // Different rendering variant: a genuinely different image, so it is a different identity.
  const higher = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1], max_side: 2000 }, s.exec,
  )
  assert.equal(higher.image_delivery.images.length, 1, 'a different render variant is a different identity')
  assert.equal(higher.budget.justified_rereads, 0, 'a higher-resolution variant needs no justification')
  assert.equal(higher.coverage.inspected_count, 1, 'coverage still shows one inspected page, not two')

  // Changed source: the ledger is keyed on the content hash, so a new hash cannot be "already seen".
  await fs.writeFile(s.pdfPath, 'a-different-source-entirely')
  const afterChange = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1], max_side: 2000 }, s.exec,
  )
  assert.equal(afterChange.image_delivery.images.length, 1)
  assert.notEqual(
    afterChange.source.content_hash,
    s.indexFile.files.find((r) => r.file_id === s.fileId).content_hash,
    'the new source hash is what re-arms the read',
  )
})

test('a justified reread is allowed, and an unjustified one is refused', async () => {
  const s = await scenario()
  await s.tools.professor_material_read.execute({ action: 'pages', file_id: s.fileId, pages: [1] }, s.exec)

  const unjustified = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1], reason: 'i would like to see it again' }, s.exec,
  )
  assert.equal(unjustified.image_delivery.images.length, 0, 'an unknown reason is not a justification')

  const justified = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1], reason: 'unreadable' }, s.exec,
  )
  assert.equal(justified.image_delivery.images.length, 1, 'an unused enum reason may re-attach')
  assert.equal(justified.budget.justified_rereads, 1)
  assert.equal(justified.pages[0].suppression, 'justified:unreadable')
})

test('a note-only record never suppresses a first image delivery', async () => {
  const s = await scenario()
  const noted = await s.tools.professor_material_read.execute(
    { action: 'plan', file_id: s.fileId, notes: [{ page: 1, text: 'seen earlier via another tool' }] }, s.exec,
  )
  assert.equal(noted.coverage.noted_count, 1, 'a note is its own bucket, not an inspection')
  const delivered = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1] }, s.exec,
  )
  assert.equal(delivered.image_delivery.images.length, 1, 'a note does not stand in for an image')
  assert.equal(delivered.coverage.inspected_count, 1)
})

// --- budgets ------------------------------------------------------------------------------

test('a spent image budget terminates with an actionable continuation, never another loop', async () => {
  const s = await scenario({
    pluginConfig: { materialReadBudget: { maxPagesPerCall: 2, maxBytesPerSession: 9000 } },
    extraction: { imageBytes: 4096 },
  })
  const first = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1, 2, 3, 4] }, s.exec,
  )
  assert.equal(first.image_delivery.images.length, 2, 'the per-call page budget is honoured')
  assert.equal(first.pages.length, 4, 'every requested page is reported, none silently dropped')
  assert.ok(first.pages.slice(2).every((entry) => entry.status === 'not-delivered'))
  assert.ok(first.warnings.some((warning) => /per-call page budget/.test(warning)))

  const second = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [3, 4] }, s.exec,
  )
  const third = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [5] }, s.exec,
  )
  for (const payload of [first, second, third]) {
    if (payload.budget.session.bytes.used >= payload.budget.session.bytes.limit) {
      assert.equal(typeof payload.continuation, 'string')
      assert.match(payload.continuation, /budget spent/)
      assert.match(payload.continuation, /did not inspect/)
    }
  }
  assert.ok(third.coverage.unread_count > 0, 'unread pages stay visible after the budget is spent')
  assert.match(third.coverage.statement, /Search hits and earlier notes do not count/)
  assert.ok(s.attachment.saved.length <= 6, `bounded attachments: ${s.attachment.saved.length}`)
})

test('many requested pages never exceed the bounded payload', async () => {
  const s = await scenario({ pluginConfig: { materialReadBudget: { maxPagesPerCall: 3 } } })
  const pages = Array.from({ length: 40 }, (_, index) => index + 1)
  const payload = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages }, s.exec,
  )
  assert.equal(payload.pages.length, 40, 'each requested page gets a row')
  assert.ok(payload.image_delivery.images.length <= 3, 'at most the per-call budget is attached')
  const notDelivered = payload.pages.filter((entry) => entry.status === 'not-delivered')
  assert.equal(notDelivered.length, 40 - payload.image_delivery.images.length)
  assert.ok(payload.warnings.some((warning) => /not attached because/.test(warning)))
  const rendered = s.shellCalls.filter((line) => line.includes('render_pages.py'))
  assert.equal(rendered.length, 1, 'the renderer is invoked once, for an explicit page list')
  assert.ok(/--pages 1,2,3/.test(rendered[0]), `bounded page list: ${rendered[0]}`)
  assert.equal(/--from/.test(rendered[0]), false, 'an explicit list never falls back to a range')
})

test('per-page excerpt rows are bounded while coverage stays complete', async () => {
  const s = await scenario()
  // A plan action bounds the rows it ships; a pages action ships only the rows it is about.
  const plan = await s.tools.professor_material_read.execute({ action: 'plan', file_id: s.fileId }, s.exec)
  assert.equal(plan.plan.per_page_total, plan.plan.per_page.length, 'six pages are under the default cap')
  assert.equal(plan.plan.per_page_truncated, false)

  const pages = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [2, 4] }, s.exec,
  )
  assert.deepEqual(pages.plan.per_page.map((entry) => entry.page), [2, 4], 'only the pages this call is about')
  assert.equal(pages.plan.per_page_truncated, true)
  assert.match(pages.plan.per_page_note, /this call is about/)
  // Coverage still accounts for every page in scope, bounded rows or not.
  assert.equal(pages.coverage.total, 6)

  // The same guarantee holds for a plan that would otherwise be huge.
  const many = buildReadingPlan({
    pages: Array.from({ length: 1200 }, (_, index) => ({ page: index + 1, text: `page ${index + 1} body` })),
    totalPages: 1200,
  })
  const compacted = compactPlan(many)
  assert.equal(compacted.per_page.length, 400)
  assert.equal(compacted.per_page_truncated, true)
  assert.equal(many.per_page.length, 1200, 'the source plan is untouched')
  assert.equal(
    many.text_sufficient.length + many.needs_visual.length + many.no_text_layer.length,
    1200,
    'classification lists are never truncated by the row bound',
  )
})

test('an out-of-range page request is clipped and reported, not thrown', async () => {
  const s = await scenario()
  const payload = await s.tools.professor_material_read.execute(
    { action: 'plan', file_id: s.fileId, from: 4, to: 99 }, s.exec,
  )
  assert.deepEqual(payload.plan.per_page.map((entry) => entry.page), [4, 5, 6])
  assert.ok(payload.plan.warnings.some((warning) => /clipped to 6/.test(warning)))
})

// --- coverage honesty --------------------------------------------------------------------------

test('whole-document coverage never claims unread pages, and search is not coverage', async () => {
  const s = await scenario()
  const payload = await s.tools.professor_material_read.execute({ action: 'status', file_id: s.fileId }, s.exec)
  // Pages 3 and 5 have no text layer and nothing has been inspected yet.
  assert.deepEqual(payload.coverage.unread, [3, 5])
  assert.equal(payload.coverage.inspected_count, 0)
  assert.match(payload.coverage.statement, /2 unread/)
  assert.match(payload.coverage.statement, /do not count as coverage/)
  // The 2026-10-11 repair: pages whose text layer merely classifies `text_sufficient` are NOT
  // accounted for until their source body is delivered. This status call returned bounded
  // excerpts (overviews) for 1/2/4/6 — that is `overview_only`, not reading, and it must not
  // move the delivery percentage. (The old `percent_accounted: 67` claim was the P1 defect.)
  assert.deepEqual(payload.coverage.overview_only, [1, 2, 4, 6])
  assert.equal(payload.coverage.text_complete_count, 0)
  assert.equal(payload.coverage.percent_delivered, 0)
})

test('a source with no page coordinates reports that no coverage can be established', () => {
  const plan = buildReadingPlan({ pages: [], totalPages: null, textAvailable: false, textReason: 'no backend' })
  const coverage = {
    scope: plan.scope,
    inspected: [], text_complete: [], text_partial: [], noted: [], overview_only: [], unread: [], unreadable: [],
    inspected_count: 0, text_complete_count: 0, text_partial_count: 0, noted_count: 0,
    overview_only_count: 0, unread_count: 0, unreadable_count: 0,
    total: 0, percent_delivered: 0,
    body: { delivered_chars: 0, total_chars: 0 },
    notes_available: 0,
  }
  assert.match(coverageStatement(coverage), /No per-page coverage could be established/)
})

// --- delivery gates ------------------------------------------------------------------------------

test('without an attachment service the tool says so instead of pretending to deliver', async () => {
  const s = await scenario({ attachments: null })
  const payload = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1] }, s.exec,
  )
  assert.equal(payload.image_delivery.status, 'unavailable-attachments')
  assert.match(payload.image_delivery.reason, /attachment service/)
  assert.equal(payload.image_delivery.images.length, 0)
  assert.ok(payload.pages.every((entry) => entry.status === 'not-delivered'))
  assert.equal(payload.coverage.inspected_count, 0, 'nothing is marked inspected when nothing was delivered')
})

test('a text-only model route is refused by name, not silently downgraded', async () => {
  const s = await scenario({ llm: fakeLlm({ modalities: ['text'] }) })
  const payload = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1] }, s.exec,
  )
  assert.equal(payload.image_delivery.status, 'unavailable-text-only-model')
  assert.equal(payload.image_delivery.model, 'test-vision-model')
  assert.match(payload.image_delivery.reason, /does not declare image input/)
  assert.equal(payload.image_delivery.images.length, 0)
  assert.equal(payload.plan.text_layer.available, true, 'the text layer is still delivered')
})

test('an unresolved model route is an explicit refusal, never a guess', async () => {
  const s = await scenario({ extraServices: { llm: undefined } })
  // `ctx.get('llm')` now returns undefined, which is what an unsupported host looks like.
  const payload = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1] }, s.exec,
  )
  assert.equal(payload.image_delivery.status, 'unavailable-route-unresolved')
  assert.match(payload.image_delivery.reason, /could not be resolved/)
})

test('a host with no shell reports the text layer as unreadable instead of inventing one', async () => {
  const home = await makeHome('professor-material-noshell-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/CSC4801/01_Lectures/00_Introduction.pdf', 'stable')
  await writeFixture(home, 'courses/term/.professor/project.yaml', projectYaml(project))
  const fake = createFakeContext({ home, services: { attachments: fakeAttachments(), llm: fakeLlm() } })
  apply(fake.ctx, fake.pluginConfig)
  const tools = toolsByName(fake)
  const exec = materialExec({ cwd: project })
  // Index first (it needs no shell for a text-less PDF family? it does not extract), then read.
  await tools.professor_index_sync.execute({ force: true }, exec)
  const index = JSON.parse(await fs.readFile(path.join(project, '.professor/indexes/files.json'), 'utf8'))
  const fileId = index.files.find((entry) => entry.relative_path.endsWith('.pdf')).file_id

  const payload = await tools.professor_material_read.execute({ action: 'plan', file_id: fileId }, exec)
  assert.equal(payload.plan.text_layer.available, false)
  assert.match(payload.plan.text_layer.reason, /no command runner|no PDF text backend/)
  assert.deepEqual(payload.coverage.unread, [], 'without page coordinates nothing is claimed as unread either')
  assert.match(payload.coverage.statement, /No per-page coverage could be established/)

  const pages = await tools.professor_material_read.execute(
    { action: 'pages', file_id: fileId, pages: [1] }, exec,
  )
  assert.equal(pages.image_delivery.images.length, 0)
  assert.equal(pages.plan.text_layer.available, false)
})

// --- safety -------------------------------------------------------------------------------------

test('reading material never touches the source, the index, state or memory', async () => {
  const s = await scenario()
  const digestTreeOf = async (root) => {
    const out = {}
    const walk = async (dir) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name)
        if (entry.isDirectory()) { await walk(target); continue }
        out[path.relative(root, target)] = createHash('sha256').update(await fs.readFile(target)).digest('hex')
      }
    }
    await walk(root)
    return out
  }
  const before = await digestTreeOf(s.project)
  await s.tools.professor_material_read.execute({ action: 'plan', file_id: s.fileId }, s.exec)
  await s.tools.professor_material_read.execute({ action: 'pages', file_id: s.fileId, pages: [1, 2] }, s.exec)
  await s.tools.professor_material_read.execute(
    { action: 'status', file_id: s.fileId, notes: [{ page: 1, text: 'note' }] }, s.exec,
  )
  const after = await digestTreeOf(s.project)
  assert.deepEqual(after, before, 'no file in the project changed, including the source material')
  assert.equal(
    createHash('sha256').update(await fs.readFile(s.pdfPath)).digest('hex'),
    s.pdfHash,
    'the original lecture bytes are unchanged',
  )
})

test('course identity and permission boundaries are unchanged by a material read', async () => {
  const s = await scenario()
  await assert.rejects(
    () => s.tools.professor_material_read.execute(
      { action: 'plan', file_id: s.fileId, course: 'ZZZ9999' }, s.exec,
    ),
    (error) => error.code === 'PROFESSOR_COURSE_MISSING',
    'a file cannot be claimed for a course that does not exist',
  )
  await assert.rejects(
    () => s.tools.professor_material_read.execute(
      { action: 'plan', file_id: s.fileId, course: 'csc9999' }, s.exec,
    ),
    (error) => error.code === 'PROFESSOR_COURSE_MISMATCH',
    'a registered course id that is not this file\'s course is refused, not ignored',
  )
  const paths = await s.tools.professor_paths.execute({}, s.exec)
  assert.equal(paths.projectRoot, s.project)
  assert.ok(paths.readRoots.includes(s.project), 'the read policy is untouched')
  assert.equal(paths.projectBound, true)
})

test('a cancelled material read performs no render, no attachment and no ledger write', async () => {
  const s = await scenario()
  const exec = materialExec({ cwd: s.project, sessionId: 'session-cancelled', aborted: true })
  const rendersBefore = s.shellCalls.filter((line) => line.includes('render_pages.py')).length
  const savedBefore = s.attachment.saved.length
  await assert.rejects(
    () => s.tools.professor_material_read.execute({ action: 'pages', file_id: s.fileId, pages: [1] }, exec),
    (error) => error.code === 'PROFESSOR_CANCELLED',
    'a cancelled read refuses up front rather than answering with partial work',
  )
  assert.equal(
    s.shellCalls.filter((line) => line.includes('render_pages.py')).length,
    rendersBefore,
    'no render process is started for a cancelled call',
  )
  assert.equal(s.attachment.saved.length, savedBefore, 'no image is attached for a cancelled call')

  const status = await s.tools.professor_material_read.execute(
    { action: 'status', file_id: s.fileId },
    materialExec({ cwd: s.project, sessionId: 'session-cancelled' }),
  )
  assert.equal(status.coverage.inspected_count, 0, 'the ledger recorded nothing for the cancelled session')
})

test('the ledger keeps no timers and forgets a session on disposal', () => {
  const ledger = createReadingLedger()
  ledger.beginTurn('s1', 1)
  ledger.recordInspection('s1', { sourceHash: 'h', page: 1, variant: '1600px-q80', status: 'inspected', bytes: 10 })
  assert.equal(ledger.summary('s1').present, true)
  assert.deepEqual(ledger.sessionIds(), ['s1'])
  const scheduled = []
  const original = globalThis.setTimeout
  globalThis.setTimeout = (...args) => { scheduled.push(args[0]); return 0 }
  try {
    ledger.beginTurn('s1', 2)
    ledger.coverage('s1', { sourceHash: 'h', plan: buildReadingPlan({ pages: TEXT_PAGES, totalPages: 6 }), scopePages: [1] })
    ledger.dispose()
  } finally {
    globalThis.setTimeout = original
  }
  assert.deepEqual(scheduled, [], 'the ledger schedules nothing')
  assert.deepEqual(ledger.sessionIds(), [], 'disposal drops every session')
  assert.equal(ledger.summary('s1').present, false)
})

// --- cumulative budgets: reservation, not a stale read --------------------------------

/**
 * The acceptance defect this pins: the selection loop used to call `canSpend({images: 1, bytes: 0})`
 * on every iteration while `turn.images` never moved, so four pages could be chosen into a two-page
 * gap and only charged afterwards — 8 used against a limit of 6. Reservations hold the capacity as
 * it is chosen, so the third page meets a counter that already includes the first two.
 */
test('turn capacity is reserved cumulatively instead of re-read per iteration', async () => {
  const s = await scenario({ extraction: { pages: MANY_PAGES } })
  const first = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1, 3, 5, 7] }, s.exec,
  )
  assert.equal(first.image_delivery.images.length, 4)
  assert.equal(first.budget.turn.images.used, 4)

  const second = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [2, 4, 9, 11] }, s.exec,
  )
  const delivered = second.image_delivery.images.length
  assert.equal(delivered, 2, 'only the two slots the turn still has are spent')
  assert.equal(second.budget.turn.images.used, 6, 'the ceiling is reached exactly, never passed')
  assert.equal(second.budget.turn.images.limit, 6)
  assert.equal(second.budget.turn.images.held, 0, 'nothing is left reserved after the call')
  const refused = second.pages.filter((row) => row.status === 'not-delivered')
  assert.equal(refused.length, 2)
  assert.ok(
    refused.every((row) => row.suppression === SUPPRESSION.IMAGE_LIMIT),
    `an image-count refusal, not a byte one: ${JSON.stringify(refused.map((row) => row.suppression))}`,
  )
  assert.ok(second.warnings.some((warning) => /per-turn image count is spent/.test(warning)))
})

test('an exact byte boundary delivers what fits and refuses the rest', async () => {
  const s = await scenario({
    pluginConfig: { materialReadBudget: { maxBytesPerSession: 8192 } },
    extraction: { imageBytes: 4096 },
  })
  const first = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1, 3] }, s.exec,
  )
  assert.equal(first.image_delivery.images.length, 2, 'two 4096-byte pages fill an 8192-byte session exactly')
  assert.equal(first.budget.session.bytes.used, 8192)
  assert.equal(first.budget.session.bytes.limit, 8192)
  assert.equal(first.budget.exhausted, true)

  const second = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [5] }, s.exec,
  )
  assert.equal(second.image_delivery.images.length, 0)
  assert.equal(second.pages[0].status, 'not-delivered')
  assert.equal(second.pages[0].suppression, SUPPRESSION.BUDGET_EXHAUSTED)
  assert.equal(s.attachment.saved.length, 2, 'nothing past the boundary reaches the attachment service')
  assert.match(second.continuation ?? '', /budget spent/)
  assert.match(second.continuation ?? '', /did not inspect/)
})

test('a page larger than the per-call byte budget is refused before it is attached', async () => {
  const s = await scenario({
    pluginConfig: { materialReadBudget: { maxBytesPerCall: 300_000 } },
    // A renderer that overshoots the budget it was given; the tool must still refuse to deliver.
    extraction: { imageBytes: 1_200_000, ignoreByteBudget: true },
  })
  const payload = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1] }, s.exec,
  )
  assert.equal(payload.image_delivery.images.length, 0)
  assert.equal(payload.pages[0].status, 'not-delivered')
  assert.equal(payload.pages[0].suppression, SUPPRESSION.PAGE_EXCEEDS_BUDGET)
  assert.equal(s.attachment.saved.length, 0, 'an oversized page is never handed to the attachment service')
  assert.equal(payload.budget.session.bytes.used, 0, 'an undeliverable page charges nothing')
  assert.equal(payload.budget.session.bytes.held, 0, 'and reserves nothing afterwards')
  assert.ok(payload.warnings.some((warning) => /image byte budget is spent/.test(warning)))
})

test('a renderer that overproduces never becomes an attachment nobody budgeted', async () => {
  const s = await scenario({ extraction: { extraPages: [2, 4] } })
  const payload = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1, 3] }, s.exec,
  )
  assert.deepEqual(payload.image_delivery.images.map((image) => image.page).sort(), [1, 3],
    'only the requested pages were delivered')
  assert.deepEqual(payload.pages.map((row) => row.page), [1, 3],
    'a page that was never asked for does not get a row either')
  assert.deepEqual(s.attachment.saved.map((entry) => entry.name), ['page-1.jpg', 'page-3.jpg'],
    'the attachment service is called exactly once per budgeted page')
})

test('a refused attachment returns its reservation and charges nothing', async () => {
  const s = await scenario({ attachments: fakeAttachments({ failOn: [1] }) })
  const payload = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1, 3] }, s.exec,
  )
  const failed = payload.pages.find((row) => row.page === 1)
  assert.equal(failed.status, 'not-delivered')
  assert.equal(failed.suppression, SUPPRESSION.ATTACHMENT_FAILED)
  assert.equal(payload.image_delivery.images.length, 1, 'the other page still went through')
  assert.equal(payload.budget.turn.images.used, 1, 'only the delivered page is charged an image slot')
  assert.equal(payload.budget.session.bytes.used, 4096, 'only the delivered page is charged bytes')
  assert.equal(payload.budget.session.bytes.held, 0, 'the failed page holds no capacity')
  assert.equal(payload.budget.turn.images.held, 0)
  assert.deepEqual(payload.coverage.inspected, [3])
  assert.ok(payload.warnings.some((warning) => /could not be attached/.test(warning)))
})

test('the budget block names its cost unit and the base64 request equivalent', async () => {
  const s = await scenario({ extraction: { imageBytes: 4096 } })
  const payload = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1] }, s.exec,
  )
  assert.equal(payload.budget.cost_unit, 'binary-encoded-image-bytes')
  assert.equal(payload.budget.session.bytes.used, 4096)
  assert.equal(payload.budget.request_bytes.unit, 'base64-request-bytes')
  assert.equal(payload.budget.request_bytes.estimate, Math.ceil(4096 / 3) * 4,
    'the same spend expressed in the unit the host bounds the request with')
})

// --- concurrency ----------------------------------------------------------------------

test('concurrent identical page requests render and attach the page once', async () => {
  const s = await scenario()
  const first = await Promise.all([
    s.tools.professor_material_read.execute(
      { action: 'pages', file_id: s.fileId, pages: [1] },
      materialExec({ cwd: s.project, sessionId: 'session-shared' }),
    ),
    s.tools.professor_material_read.execute(
      { action: 'pages', file_id: s.fileId, pages: [1] },
      materialExec({ cwd: s.project, sessionId: 'session-shared' }),
    ),
  ])
  const delivered = first[0].image_delivery.images.length + first[1].image_delivery.images.length
  assert.equal(delivered, 1, 'the same unchanged page is attached exactly once')
  assert.equal(s.attachment.saved.length, 1, 'and the attachment service is called exactly once')
  assert.deepEqual(
    [first[0].pages[0].status, first[1].pages[0].status].sort(),
    ['inspected', 'reused'],
    'one caller gets the image, the other gets the ledger answer',
  )
  const used = Math.max(first[0].budget.turn.images.used, first[1].budget.turn.images.used)
  assert.equal(used, 1, 'the image slot is charged once, not twice')
})

test('concurrent calls near the turn limit cannot both spend the same capacity', async () => {
  const s = await scenario({
    extraction: { pages: MANY_PAGES },
    pluginConfig: { materialReadBudget: { maxImagesPerTurn: 2, maxPagesPerCall: 2 } },
  })
  const [first, second] = await Promise.all([
    s.tools.professor_material_read.execute(
      { action: 'pages', file_id: s.fileId, pages: [1, 3] },
      materialExec({ cwd: s.project, sessionId: 'session-limits' }),
    ),
    s.tools.professor_material_read.execute(
      { action: 'pages', file_id: s.fileId, pages: [5, 7] },
      materialExec({ cwd: s.project, sessionId: 'session-limits' }),
    ),
  ])
  const total = first.image_delivery.images.length + second.image_delivery.images.length
  assert.equal(total, 2, 'two overlapping calls spend one turn ceiling between them')
  assert.equal(s.attachment.saved.length, 2)
  for (const payload of [first, second]) {
    assert.ok(payload.budget.turn.images.used <= 2, `${payload.budget.turn.images.used} <= 2`)
  }
  assert.ok(
    [first, second].some((payload) => payload.pages.every((row) => row.status === 'not-delivered')),
    'the call that ran second reports its refusal instead of pretending it delivered',
  )
})

test('cancellation after the renderer finishes attaches nothing and writes nothing', async () => {
  const controller = new AbortController()
  const s = await scenario({ extraction: { onRender: () => controller.abort() } })
  const exec = materialExec({ cwd: s.project, sessionId: 'session-abort-render', controller })
  const savedBefore = s.attachment.saved.length

  await assert.rejects(
    () => s.tools.professor_material_read.execute(
      { action: 'pages', file_id: s.fileId, pages: [1, 3] }, exec,
    ),
    (error) => error.code === 'PROFESSOR_CANCELLED',
    'a signal that arrives during the render stops the call',
  )
  assert.equal(s.attachment.saved.length, savedBefore, 'nothing is attached after the cancellation')

  const reader = materialExec({ cwd: s.project, sessionId: 'session-abort-render' })
  const status = await s.tools.professor_material_read.execute({ action: 'status', file_id: s.fileId }, reader)
  assert.equal(status.coverage.inspected_count, 0, 'no inspection was recorded')
  assert.equal(status.budget.turn.images.used, 0)
  assert.equal(status.budget.turn.images.held, 0, 'the image slot the call took was returned')
  assert.equal(status.budget.session.bytes.used, 0)
  assert.equal(status.budget.session.bytes.held, 0)

  const report = await s.tools.professor_diagnostics.execute({}, reader)
  assert.equal(report.material_reading.claims, 0, 'no page is left claimed by the abandoned call')
  assert.equal(report.material_reading.held, 0, 'and no capacity is left reserved')
})

test('cancellation during attachment records no inspection and charges nothing', async () => {
  const controller = new AbortController()
  const s = await scenario({
    attachments: fakeAttachments({
      onCall: ({ attempt }) => { if (attempt === 1) controller.abort() },
    }),
  })
  const exec = materialExec({ cwd: s.project, sessionId: 'session-abort-attach', controller })

  await assert.rejects(
    () => s.tools.professor_material_read.execute(
      { action: 'pages', file_id: s.fileId, pages: [1, 3] }, exec,
    ),
    (error) => error.code === 'PROFESSOR_CANCELLED',
    'stored bytes that were never delivered must not become an inspection',
  )
  assert.equal(s.attachment.saved.length, 1, 'only the attachment that was already in flight happened')

  const reader = materialExec({ cwd: s.project, sessionId: 'session-abort-attach' })
  const status = await s.tools.professor_material_read.execute({ action: 'status', file_id: s.fileId }, reader)
  assert.equal(status.coverage.inspected_count, 0, 'coverage does not claim a page the model never received')
  assert.equal(status.budget.session.bytes.used, 0)
  assert.equal(status.budget.session.bytes.held, 0)
  assert.equal(status.budget.turn.images.held, 0)
})

test('the per-session lock serialises one session without blocking another', async () => {
  const ledger = createReadingLedger()
  const order = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const slow = ledger.withLock('s1', async () => {
    order.push('slow-start')
    await gate
    order.push('slow-end')
  })
  const queued = ledger.withLock('s1', async () => { order.push('queued') })
  const other = ledger.withLock('s2', async () => { order.push('other') })

  await other
  assert.equal(order.includes('slow-start'), true, 'the first caller owns the session')
  assert.equal(order.includes('queued'), false, 'a second caller for the same session waits')
  assert.equal(order.includes('other'), true, 'an unrelated session is never queued behind it')

  release()
  await Promise.all([slow, queued])
  assert.deepEqual(order, ['slow-start', 'other', 'slow-end', 'queued'])
  ledger.dispose()
})

test('a reservation holds capacity for its holder alone', () => {
  const ledger = createReadingLedger({ budget: { maxImagesPerTurn: 2 } })
  ledger.beginTurn('s', 1)
  const held = ledger.reserve('s', { images: 2, bytes: 0 })
  assert.equal(held.ok, true)
  const second = ledger.reserve('s', { images: 1, bytes: 0 })
  assert.equal(second.ok, false, 'the held amount already counts against the ceiling')
  assert.equal(second.scope, 'turn')
  assert.equal(second.unit, 'images')
  assert.equal(ledger.canSpend('s', { images: 1 }).ok, false, 'the read-only check agrees')
  ledger.release('s', held.reservation)
  assert.equal(ledger.reserve('s', { images: 1, bytes: 0 }).ok, true, 'released capacity is usable again')
  ledger.dispose()
})

test('a page claim is exclusive until it is released', () => {
  const ledger = createReadingLedger()
  assert.deepEqual(ledger.claimPage('s', { sourceHash: 'h', page: 1 }), { ok: true })
  assert.deepEqual(
    ledger.claimPage('s', { sourceHash: 'h', page: 1 }),
    { ok: false, reason: 'in-flight' },
    'a second attempt on the same physical page is refused before anything is rendered',
  )
  assert.deepEqual(ledger.claimPage('s', { sourceHash: 'h', page: 2 }), { ok: true },
    'a different page is unaffected')
  assert.equal(ledger.activeClaims('s').length, 2)
  assert.equal(ledger.releaseClaim('s', { sourceHash: 'h', page: 1 }), true)
  assert.equal(ledger.releaseClaim('s', { sourceHash: 'h', page: 1 }), false, 'release is idempotent')
  assert.deepEqual(ledger.claimPage('s', { sourceHash: 'h', page: 1 }), { ok: true })
  ledger.dispose()
})

// --- exact page lists ----------------------------------------------------------------

test('a non-contiguous page request renders exactly those pages', async () => {
  const s = await scenario({ extraction: { pages: MANY_PAGES } })
  const payload = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1, 10] }, s.exec,
  )
  assert.deepEqual(payload.image_delivery.images.map((image) => image.page), [1, 10])
  assert.deepEqual(payload.pages.map((row) => row.page), [1, 10])
  const renders = s.shellCalls.filter((line) => line.includes('render_pages.py'))
  assert.equal(renders.length, 1, 'one invocation, for exactly the requested pages')
  assert.ok(/--pages 1,10/.test(renders[0]), `explicit list: ${renders[0]}`)
  assert.equal(/--from/.test(renders[0]), false, 'no capped contiguous range is substituted')
  assert.equal(s.attachment.saved.length, 2, 'pages 2-9 were never rendered, so never attached')
})

test('unsorted and duplicate page requests are normalised', async () => {
  const s = await scenario()
  const payload = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [3, 1, 3, 2, 1] }, s.exec,
  )
  assert.deepEqual(payload.pages.map((row) => row.page), [1, 2, 3], 'ascending, each page once')
  const renders = s.shellCalls.filter((line) => line.includes('render_pages.py'))
  assert.ok(/--pages 1,2,3/.test(renders[0]), `deduplicated and sorted: ${renders[0]}`)
  assert.equal(s.attachment.saved.length, 3)
})

test('invalid page entries are refused with a warning, not silently dropped', async () => {
  const s = await scenario()
  const payload = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1, 'x', 0, -2, 2.5, null] }, s.exec,
  )
  assert.deepEqual(payload.pages.map((row) => row.page), [1], 'only the usable entries are attempted')
  assert.ok(payload.warnings.some((warning) => /not a positive integer and were ignored/.test(warning)),
    JSON.stringify(payload.warnings))
  const renders = s.shellCalls.filter((line) => line.includes('render_pages.py'))
  assert.ok(/--pages 1/.test(renders[0]))
})

test('a page past the end of the document is reported as its own outcome', async () => {
  const s = await scenario()
  const payload = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1, 99] }, s.exec,
  )
  const beyond = payload.pages.find((row) => row.page === 99)
  assert.equal(beyond.status, 'not-delivered')
  assert.equal(beyond.suppression, SUPPRESSION.OUT_OF_RANGE)
  assert.ok(payload.warnings.some((warning) => /beyond the document \(6 page\(s\)\)/.test(warning)))
  const renders = s.shellCalls.filter((line) => line.includes('render_pages.py'))
  assert.equal(/,99|, 99/.test(renders[0]), false, 'an impossible page is never sent to the renderer')
  assert.equal(payload.image_delivery.images.map((image) => image.page).join(','), '1')
})

test('selected pages spanning a large document stay an explicit list', async () => {
  const s = await scenario({ extraction: { pages: LARGE_PAGES } })
  const payload = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: s.fileId, pages: [1, 500, 1200] }, s.exec,
  )
  assert.deepEqual(payload.image_delivery.images.map((image) => image.page), [1, 500, 1200])
  assert.deepEqual(payload.pages.map((row) => row.page), [1, 500, 1200])
  const renders = s.shellCalls.filter((line) => line.includes('render_pages.py'))
  assert.equal(renders.length, 1, 'one render for three pages, not one per page and not one range')
  assert.ok(/--pages 1,500,1200/.test(renders[0]), `explicit list: ${renders[0]}`)
  assert.equal(s.attachment.saved.length, 3, 'nothing between the selected pages is rendered')
  assert.equal(payload.coverage.total, 1200, 'coverage still accounts for the whole document')
  assert.equal(payload.plan.per_page.length, 3, 'only the rows this call is about are shipped')
})

// --- pure helpers ------------------------------------------------------------------------------

test('reuse decisions are keyed on source, page and rendering variant', () => {
  const variant = renderVariant({ maxSide: 1600, quality: 80 })
  assert.equal(variant, '1600px-q80')
  const record = { variant, status: 'inspected' }
  assert.deepEqual(reuseDecision({ existing: record, variant }), { reuse: true, reason: SUPPRESSION.ALREADY_INSPECTED })
  assert.equal(reuseDecision({ existing: record, variant: '2000px-q80' }).reuse, false)
  assert.equal(reuseDecision({ existing: { variant: null, status: 'noted' }, variant }).reuse, false)
  assert.equal(reuseDecision({ existing: undefined, variant }).reuse, false)
  assert.equal(reuseDecision({ existing: record, variant, reason: 'explicit-user-request' }).reuse, false)
})

test('rescoping a cached plan never re-derives character counts from an excerpt', () => {
  const full = buildReadingPlan({ pages: TEXT_PAGES, totalPages: 6 })
  const section = rescopeReadingPlan(full, { from: 2, to: 3 })
  assert.equal(section.scope, 'section')
  assert.deepEqual(section.per_page.map((entry) => entry.page), [2, 3])
  assert.equal(section.per_page[0].text_chars, TEXT_PAGES[1].text.length, 'counts come from the original plan')
  assert.equal(full.per_page.length, 6, 'the cached plan itself is untouched')
})
