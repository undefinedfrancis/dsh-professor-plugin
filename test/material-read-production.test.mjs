/**
 * `professor_material_read` against the **real** extraction and render backends.
 *
 * Everything else about this tool is covered against a scripted shell; this file is the one that
 * proves the production path end to end: a real PDF, the real interpreter discovery, the real
 * `extract_pdf.py`, the real `render_pages.py`, and real JPEG bytes handed to an attachment
 * service. A renderer that has never actually rendered is exactly the kind of thing a mock suite
 * would happily call green.
 *
 * It skips — loudly, never silently — on a machine where no interpreter imports PyMuPDF.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { buildPdfBytes } from './helpers/fixtures.mjs'
import { createFakeContext, createFakeShell, makeHome, writeFixture } from './helpers/fake-harness.mjs'

const PROJECT_YAML = (project) => `schema_version: 1
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

/** A real two-page PDF with a genuine text layer on both pages. */
const LECTURE = buildPdfBytes({
  pages: [
    [
      'Lecture 00 — Introduction',
      'This course studies how practitioners keep doing software engineering well when code generation is cheap.',
      'Agents call tools; plans are sequences of steps; a plan is not a tool call.',
      'Assessment weights come from the handbook and are never invented here.',
    ].join('\n'),
    [
      'Learning outcomes',
      'By the end of this lecture you should be able to distinguish a tool call from a plan, and to state why',
      'evaluation is a first-class engineering concern rather than an afterthought bolted on at release time.',
      'Treat evaluation as engineering: measure, record, and act on what you measured.',
    ].join('\n'),
    [
      'Open questions',
      'This lecture deliberately leaves three questions unanswered so that the seminar can take them up.',
      'Write them down now; they are the backbone of the second half of the course and of the exam.',
      'Nothing on this page is a claim about assessment weighting — that lives in the handbook.',
    ].join('\n'),
  ],
})

/**
 * Real intrinsic dimensions of a baseline JPEG, read from its SOF marker.
 *
 * The attachment service decodes an image to learn its size (and may downscale it), so a fake that
 * returns zeros would hide a broken payload. Parsing the header keeps the fake honest: if the bytes
 * are not a well-formed JPEG, this test fails where it should.
 */
function jpegSize(data) {
  let offset = 2
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue }
    const marker = data[offset + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
    const length = data.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return { width: 0, height: 0 }
}

function fakeAttachments() {
  const saved = []
  let counter = 0
  return {
    saved,
    imageLimits: {
      maxImageBytes: 20 * 1024 * 1024,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 200 * 1024 * 1024,
      maxImagePixels: 64_000_000,
      maxImageDimension: 8192,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    async saveImage({ data, mediaType, name }) {
      counter += 1
      const size = mediaType === 'image/jpeg' ? jpegSize(data) : { width: 0, height: 0 }
      const ref = {
        attachmentId: `att_${counter}`, mediaType, bytes: data.byteLength,
        width: size.width, height: size.height, name,
      }
      saved.push({ ...ref, data })
      return ref
    },
  }
}

async function scenario() {
  const home = await makeHome('professor-material-prod-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/CSC4801/01_Lectures/00_Introduction.pdf', LECTURE)
  await writeFixture(home, 'courses/term/.professor/project.yaml', PROJECT_YAML(project))

  const shell = createFakeShell({ cwd: home, timeoutMs: 60_000 })
  const attachments = fakeAttachments()
  const fake = createFakeContext({
    home,
    services: {
      shell,
      attachments,
      llm: { async resolveModelInfo() { return { inputModalities: ['text', 'image'] } } },
    },
  })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = {
    agent: {
      session: {
        id: 'session-material-prod',
        header: { cwd: project },
        requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-vision-model' } }),
      },
    },
    signal: new AbortController().signal,
  }
  return { home, project, fake, tools, exec, shell, attachments }
}

test('a real PDF is planned from its text layer and its pages are rendered to real JPEG bytes', async (t) => {
  const s = await scenario()
  await s.tools.professor_index_sync.execute({ force: true }, s.exec)
  const index = JSON.parse(await fs.readFile(
    path.join(s.project, '.professor/indexes/files.json'), 'utf8'))
  const record = index.files.find((entry) => entry.relative_path.endsWith('00_Introduction.pdf'))
  assert.ok(record, 'the lecture is indexed')
  const sourcePath = path.join(s.project, record.relative_path)
  const before = await fs.readFile(sourcePath)

  const report = await s.tools.professor_diagnostics.execute({}, s.exec)
  const pageRender = report.extraction.capabilities.pageRender
  if (pageRender.available !== true) {
    t.skip(`no interpreter imports PyMuPDF here (${pageRender.reason})`)
    return
  }
  assert.equal(pageRender.backend, 'pymupdf')
  assert.match(pageRender.writes, /nothing/)

  const plan = await s.tools.professor_material_read.execute(
    { action: 'plan', file_id: record.file_id }, s.exec,
  )
  assert.equal(plan.plan.total_pages, 3, 'the real extractor reported all three physical pages')
  assert.equal(plan.plan.per_page.length, 3)
  assert.ok(plan.plan.per_page[0].text_chars > 20, `page 1 has a real text layer (${plan.plan.per_page[0].text_chars})`)
  assert.equal(plan.plan.text_layer.available, true)
  assert.equal(plan.plan.no_text_layer.length, 0, 'neither page is a scanned page')
  assert.equal(
    plan.plan.text_sufficient.length + plan.plan.needs_visual.length,
    3,
    'every page is classified from its real text length',
  )

  // Non-contiguous on purpose: the real renderer must produce pages 1 and 3 and nothing between
  // them. A capped `--from 1 --to 3` would render page 2 and still never deliver page 3.
  const read = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: record.file_id, pages: [1, 3] }, s.exec,
  )
  assert.equal(read.image_delivery.status, 'delivered')
  assert.deepEqual(read.image_delivery.images.map((image) => image.page), [1, 3],
    'exactly the two requested pages came back from the real renderer')
  const renderCommand = s.shell.calls.find((line) => line.includes('render_pages.py'))
  assert.ok(/--pages 1,3/.test(renderCommand), `explicit list reached the real script: ${renderCommand}`)
  assert.equal(/--from/.test(renderCommand), false)
  for (const image of read.image_delivery.images) {
    assert.ok(image.bytes > 0 && image.width > 0 && image.height > 0,
      `a real JPEG with real dimensions: ${JSON.stringify(image)}`)
    assert.ok(image.width <= 2048 && image.height <= 2048,
      'the rendered page stays inside the host normalization cap')
    const stored = s.attachments.saved.find((entry) => entry.attachmentId === image.attachment_id)
    assert.equal(stored.mediaType, 'image/jpeg')
    // JPEG SOI marker: these are real encoded images, not placeholders.
    assert.deepEqual([...stored.data.subarray(0, 3)], [0xff, 0xd8, 0xff])
  }
  assert.deepEqual(read.coverage.inspected, [1, 3], 'coverage lists what was actually delivered')
  assert.match(read.coverage.statement, /Whole-document coverage/)

  // The 2026-10-11 repair: prove the REAL rendered JPEGs reach the model-facing projection —
  // JPEG generation and attachment metadata alone are not delivery. The host calls
  // `output.render(args, value)`; its blocks must carry one image block per delivered page.
  const blocks = s.tools.professor_material_read.output.render({ action: 'pages' }, read)
  assert.equal(blocks.length, 3, 'one JSON/text envelope plus two image blocks')
  assert.equal(blocks[0].type, 'text')
  for (const [index, block] of blocks.slice(1).entries()) {
    assert.equal(block.type, 'image', `block ${index + 1} is an image block`)
    const ref = block.attachment
    assert.equal(typeof ref.attachmentId, 'string')
    assert.equal(ref.mediaType, 'image/jpeg')
    assert.ok(Number.isFinite(ref.bytes) && ref.bytes > 0)
    assert.ok(Number.isFinite(ref.width) && ref.width > 0)
    assert.ok(Number.isFinite(ref.height) && ref.height > 0)
    const stored = s.attachments.saved.find((entry) => entry.attachmentId === ref.attachmentId)
    assert.ok(stored, 'the block references the attachment the renderer produced')
    assert.deepEqual([...stored.data.subarray(0, 3)], [0xff, 0xd8, 0xff], 'and its bytes are real JPEG')
  }

  // A second identical request reuses the ledger: no second render, no second attachment.
  const renders = s.shell.calls.filter((line) => line.includes('render_pages.py')).length
  const again = await s.tools.professor_material_read.execute(
    { action: 'pages', file_id: record.file_id, pages: [1, 3] }, s.exec,
  )
  assert.equal(again.image_delivery.images.length, 0)
  assert.equal(again.budget.suppressed, 2)
  assert.equal(s.shell.calls.filter((line) => line.includes('render_pages.py')).length, renders)
  assert.equal(s.attachments.saved.length, 2)

  // The source and the rest of the course material are byte-identical afterwards.
  assert.deepEqual(await fs.readFile(sourcePath), before, 'the lecture PDF is untouched')
  assert.equal(
    createHash('sha256').update(before).digest('hex'),
    createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex'),
  )
  const stray = (await fs.readdir(s.project)).filter((name) => name.endsWith('.png') || name.endsWith('.jpg'))
  assert.deepEqual(stray, [], 'no rendered image is left anywhere in the course folder')
})
