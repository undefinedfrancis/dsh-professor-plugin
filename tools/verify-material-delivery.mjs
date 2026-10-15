/**
 * Real-host model-facing delivery verification for `professor_material_read`.
 *
 * Why this file exists
 * --------------------
 * The 2026-10-11 functional audit found the tool's image projection wired to a definition-level
 * `render` field while the installed Harness materializes results through `tool.output.render`
 * (`@deepseek-ai/dsh-tools` `createSuccessResult`), so `tool/result` content carried only text
 * even when `image_delivery.status` claimed `delivered`. Unit tests can call `output.render`
 * directly; this verifier closes the remaining gap by pushing the REAL tool through the REAL
 * `ToolRuntime.execute()` pipeline — policy stages, body dispatch, output-schema validation,
 * `output.render`, content materialization — and asserting on the FINAL `result.content` blocks,
 * which are the same frozen snapshot `tools/result` observers receive.
 *
 * What it proves
 * --------------
 *  1. a `pages` result for two delivered pages carries exactly one text envelope plus TWO valid
 *     image blocks (`{ type: 'image', attachment: { attachmentId, mediaType, bytes, width,
 *     height } }` — the host's own `read_image` block shape), referencing the attachments the
 *     attachment service stored;
 *  2. `plan` / `text` / `status` results carry no image blocks;
 *  3. a refused or unusable attachment produces no image block and no `delivered` claim;
 *  4. overview excerpts do not report full reading (`percent_delivered` stays 0);
 *  5. when a real PDF backend is available, real rendered JPEG bytes ride the same pipeline into
 *     real image blocks (loudly skipped otherwise).
 *
 * Everything runs against isolated temporary homes and synthetic fixtures — never real course
 * material, user profiles, or `~/.dsh`. No paid model calls.
 *
 * Run it with the harness Node (asar-aware), like the other real-host checks:
 *
 *   npm run verify:material
 *   # or
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     tools/verify-material-delivery.mjs
 *
 * `DSH_HARNESS` overrides the harness bundle root.
 */

import path from 'node:path'
import { promises as fs } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HARNESS_ROOT = process.env.DSH_HARNESS
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const NODE_MODULES = path.join(HARNESS_ROOT, 'dsh/node_modules')
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const loadHarness = (specifier) => import(pathToFileURL(path.join(NODE_MODULES, specifier)).href)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 64 - title.length))}`)

const { Context } = await loadHarness('@deepseek-ai/cordis/lib/index.js')
const toolsRuntime = await loadHarness('@deepseek-ai/dsh-tools/lib/index.js')

const { apply } = await import(pathToFileURL(path.join(REPO, 'src/plugin.js')).href)
const { createFakeContext, createScriptedShell, makeHome, writeFixture } = await import(
  pathToFileURL(path.join(REPO, 'test/helpers/fake-harness.mjs')).href,
)

// --- synthetic fixtures ---------------------------------------------------------

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

const PROBE = {
  ok: true,
  python: '3.12.0',
  modules: { fitz: '1.28.2', pymupdf: '1.28.2', docx: '1.2.0', pptx: '1.0.2', openpyxl: '3.1.5', lxml: '6.1.3' },
  missing: [],
}

const PAGES = [
  { page: 1, text: 'Page one body for the delivery verification. '.repeat(4) },
  { page: 2, text: 'Page two body for the delivery verification. '.repeat(4) },
  { page: 3, text: '' },
]

const b64 = (bytes) => Buffer.alloc(bytes, 0x4a).toString('base64')

function scriptedShell() {
  return createScriptedShell((command) => {
    if (command.includes('probe_python.py')) return { stdout: JSON.stringify(PROBE) }
    if (command.includes('extract_pdf.py')) {
      return { stdout: JSON.stringify({ ok: true, pages: PAGES, notes: [] }) }
    }
    if (command.includes('render_pages.py')) {
      const list = (/--pages ([0-9,]+)/.exec(command)?.[1] ?? '').split(',').map(Number)
      return {
        stdout: JSON.stringify({
          ok: true,
          pages: list.map((page) => ({ page, width: 1600, height: 900, bytes: 4096, b64: b64(4096) })),
          truncated: false, total_pages: PAGES.length, requested: list, notes: [],
        }),
      }
    }
    return { stdout: '' }
  })
}

function fakeAttachments({ broken = [] } = {}) {
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
      const ref = {
        attachmentId: `att_${counter}`,
        mediaType,
        bytes: data.byteLength,
        width: broken.includes(counter) ? Number.NaN : 1600,
        height: 900,
        name,
      }
      saved.push(ref)
      return ref
    },
  }
}

/** Host-valid image block shape — the contract the host's own `read_image` emits. */
function isValidImageBlock(block) {
  const ref = block?.attachment
  return block?.type === 'image'
    && typeof ref?.attachmentId === 'string' && ref.attachmentId.length > 0
    && typeof ref?.mediaType === 'string' && ref.mediaType.length > 0
    && Number.isFinite(ref?.bytes) && ref.bytes >= 0
    && Number.isFinite(ref?.width) && ref.width > 0
    && Number.isFinite(ref?.height) && ref.height > 0
}

/** Pull the structured JSON payload out of the tool's text envelope (`describe` + blank line + JSON). */
function envelopeJson(text) {
  const index = text.indexOf('\n\n{')
  return JSON.parse(text.slice(index + 2))
}

// --- scenario ------------------------------------------------------------------

/**
 * Build a bound project with one indexed lecture and register the REAL tool definition on a REAL
 * `ToolRuntime`. Returns helpers to dispatch through the host pipeline.
 */
async function scenario({ attachments } = {}) {
  const home = await makeHome('professor-verify-delivery-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/CSC4801/01_Lectures/00_Introduction.pdf', 'synthetic-source-bytes')
  await writeFixture(home, 'courses/term/.professor/project.yaml', PROJECT_YAML(project))

  const fake = createFakeContext({
    home,
    services: {
      shell: scriptedShell(),
      attachments,
      llm: { async resolveModelInfo() { return { inputModalities: ['text', 'image'] } } },
    },
  })
  apply(fake.ctx, fake.pluginConfig)
  const byName = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))

  // Index through the tool's own (direct) execution: the index is plumbing for the material read,
  // not what this verifier is about.
  const setupExec = {
    agent: {
      session: {
        id: 'verify-material-delivery-setup',
        header: { cwd: project },
        requestHeader: () => ({ config: { provider: 'verify-provider', model: 'verify-vision-model' } }),
      },
    },
    signal: new AbortController().signal,
  }
  await byName.professor_index_sync.execute({ force: true }, setupExec)
  const index = JSON.parse(await fs.readFile(path.join(project, '.professor/indexes/files.json'), 'utf8'))
  const record = index.files.find((entry) => entry.relative_path.endsWith('00_Introduction.pdf'))

  // The real host pipeline: real ToolRuntime, real policy stages, real output materialization.
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
    getSectionOrder: () => 0,
  })
  await ctx.plugin(toolsRuntime.ToolRuntime, { mode: 'native' })
  ctx.tools.register(byName.professor_material_read)

  const agent = {
    session: {
      id: 'verify-material-delivery',
      header: { cwd: project },
      requestHeader: () => ({ config: { provider: 'verify-provider', model: 'verify-vision-model' } }),
    },
  }
  let call = 0
  const dispatch = (args) => ctx.tools.execute({
    callId: `verify-material-${(call += 1)}`,
    name: 'professor_material_read',
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })

  return { home, project, ctx, dispatch, fileId: record.file_id, byName, setupExec }
}

// --- 1. two delivered pages → one envelope + two image blocks -------------------

section('pages: image blocks through the REAL ToolRuntime pipeline')
{
  const attachments = fakeAttachments()
  const s = await scenario({ attachments })
  try {
    const result = await s.dispatch({ action: 'pages', file_id: s.fileId, pages: [1, 2] })
    check(result.isError === false, 'pages dispatch succeeds through the real pipeline', result.error?.message ?? '')
    const blocks = result.content ?? []
    const images = blocks.filter((block) => block.type === 'image')
    const texts = blocks.filter((block) => block.type === 'text')
    check(texts.length === 1, 'exactly one text envelope block', `${texts.length} text block(s)`)
    check(images.length === 2, 'exactly two image blocks for two delivered pages', `${images.length} image block(s)`)
    check(blocks.every((block) => block.type === 'text' || block.type === 'image'),
      'every block is a model-facing text or image block', blocks.map((block) => block.type).join(','))
    check(images.every(isValidImageBlock), 'every image block matches the host image contract')
    const ids = images.map((block) => block.attachment.attachmentId)
    check(
      ids.every((id) => attachments.saved.some((ref) => ref.attachmentId === id)),
      'image blocks reference the attachments the attachment service stored',
      ids.join(','),
    )
    const payload = envelopeJson(texts[0].text)
    check(payload.image_delivery.status === 'delivered', 'the envelope claims delivered only with image blocks present',
      payload.image_delivery.status)
    check(
      ids.join(',') === payload.image_delivery.images.map((image) => image.attachment_id).join(','),
      'the envelope and the image blocks agree on what was delivered',
    )
    // The host validated `result.value` against the real output schema inside `createSuccessResult`
    // (it would be an error result otherwise); re-validate explicitly as recorded evidence.
    const violations = toolsRuntime.validateJsonSchemaValue(
      s.byName.professor_material_read.output.schema, result.value, 'professor_material_read',
    )
    check(violations.length === 0, 'the delivered value satisfies the real output schema', violations.join('; '))
  } finally {
    await fs.rm(s.home, { recursive: true, force: true })
    await s.ctx.fiber.dispose()
  }
}

// --- 2. plan / text / status carry no image blocks ------------------------------

section('plan/text/status: no image blocks')
{
  const s = await scenario({ attachments: fakeAttachments() })
  try {
    // Status BEFORE any body delivery: excerpt rows are overviews, never reading.
    const early = await s.dispatch({ action: 'status', file_id: s.fileId })
    const earlyPayload = envelopeJson(early.content[0].text)
    check(earlyPayload.coverage.percent_delivered === 0,
      'an overview excerpt never reports the body as read (percent_delivered stays 0)',
      `percent_delivered=${earlyPayload.coverage.percent_delivered}`)
    check(Array.isArray(earlyPayload.coverage.overview_only) && earlyPayload.coverage.overview_only.length > 0,
      'excerpt-only pages are reported as overview_only', JSON.stringify(earlyPayload.coverage.overview_only))
    for (const args of [
      { action: 'plan', file_id: s.fileId },
      { action: 'text', file_id: s.fileId, from: 1, to: 1 },
      { action: 'status', file_id: s.fileId },
    ]) {
      const result = await s.dispatch(args)
      const images = (result.content ?? []).filter((block) => block.type === 'image')
      check(result.isError === false && images.length === 0 && (result.content ?? []).length === 1,
        `${args.action}: one text block, zero image blocks`,
        `isError=${result.isError} blocks=${(result.content ?? []).map((block) => block.type).join(',')}`)
    }
    // After the one-page text call, exactly that page is delivered — the rest is not implied.
    const after = await s.dispatch({ action: 'status', file_id: s.fileId })
    const afterPayload = envelopeJson(after.content[0].text)
    check(
      JSON.stringify(afterPayload.coverage.text_complete) === '[1]' && afterPayload.coverage.percent_delivered === 33,
      'a narrow text delivery marks only its own page complete',
      `text_complete=${JSON.stringify(afterPayload.coverage.text_complete)} percent_delivered=${afterPayload.coverage.percent_delivered}`,
    )
  } finally {
    await fs.rm(s.home, { recursive: true, force: true })
    await s.ctx.fiber.dispose()
  }
}

// --- 3. refused / unusable attachments never claim delivery --------------------

section('refused attachments: no blocks, no delivered claim')
{
  const s = await scenario({ attachments: fakeAttachments({ broken: [1, 2] }) })
  try {
    const result = await s.dispatch({ action: 'pages', file_id: s.fileId, pages: [1, 2] })
    const blocks = result.content ?? []
    const images = blocks.filter((block) => block.type === 'image')
    check(result.isError === false, 'the call still answers (with an honest refusal, not an error)')
    check(images.length === 0, 'unusable attachment references produce zero image blocks', `${images.length} image(s)`)
    const payload = envelopeJson(blocks.find((block) => block.type === 'text').text)
    check(payload.image_delivery.status !== 'delivered', 'no successful delivery claim',
      payload.image_delivery.status)
    check(payload.pages.every((row) => row.status === 'not-delivered'), 'every page row says not-delivered')
  } finally {
    await fs.rm(s.home, { recursive: true, force: true })
    await s.ctx.fiber.dispose()
  }
}

// --- 4. real PDF + real JPEG bytes, when a PDF backend exists -------------------

section('real PDF: real JPEG bytes in real pipeline image blocks')
{
  const home = await makeHome('professor-verify-delivery-real-')
  try {
    const project = path.join(home, 'courses', 'term')
    const { buildPdfBytes } = await import(pathToFileURL(path.join(REPO, 'test/helpers/fixtures.mjs')).href)
    const lecture = buildPdfBytes({
      pages: [
        ['Real page one', 'Body one for the delivery verification with enough text to classify.'].join('\n'),
        ['Real page two', 'Body two for the delivery verification with enough text to classify.'].join('\n'),
      ],
    })
    await writeFixture(home, 'courses/term/CSC4801/01_Lectures/00_Introduction.pdf', lecture)
    await writeFixture(home, 'courses/term/.professor/project.yaml', PROJECT_YAML(project))

    const { createFakeShell } = await import(pathToFileURL(path.join(REPO, 'test/helpers/fake-harness.mjs')).href)
    const attachments = fakeAttachments()
    const fake = createFakeContext({
      home,
      services: {
        shell: createFakeShell({ cwd: home, timeoutMs: 60_000 }),
        attachments,
        llm: { async resolveModelInfo() { return { inputModalities: ['text', 'image'] } } },
      },
    })
    apply(fake.ctx, fake.pluginConfig)
    const byName = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
    const setupExec = {
      agent: {
        session: {
          id: 'verify-real-setup',
          header: { cwd: project },
          requestHeader: () => ({ config: { provider: 'verify-provider', model: 'verify-vision-model' } }),
        },
      },
      signal: new AbortController().signal,
    }
    await byName.professor_index_sync.execute({ force: true }, setupExec)
    const index = JSON.parse(await fs.readFile(path.join(project, '.professor/indexes/files.json'), 'utf8'))
    const record = index.files.find((entry) => entry.relative_path.endsWith('00_Introduction.pdf'))

    const report = await byName.professor_diagnostics.execute({}, setupExec)
    const pageRender = report.extraction.capabilities.pageRender
    if (pageRender.available !== true) {
      console.log(`SKIP  no interpreter imports PyMuPDF here (${pageRender.reason})`)
    } else {
      const ctx = new Context()
      ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 })
      await ctx.plugin(toolsRuntime.ToolRuntime, { mode: 'native' })
      ctx.tools.register(byName.professor_material_read)
      const agent = {
        session: {
          id: 'verify-real-delivery',
          header: { cwd: project },
          requestHeader: () => ({ config: { provider: 'verify-provider', model: 'verify-vision-model' } }),
        },
      }
      const result = await ctx.tools.execute({
        callId: 'verify-material-real-1',
        name: 'professor_material_read',
        arguments: { action: 'pages', file_id: record.file_id, pages: [1, 2] },
        agent,
        signal: new AbortController().signal,
      })
      const blocks = result.content ?? []
      const images = blocks.filter((block) => block.type === 'image')
      check(result.isError === false, 'real PDF pages dispatch succeeds', result.error?.message ?? '')
      check(images.length === 2, 'two real pages → two image blocks', `${images.length} image(s)`)
      check(images.every(isValidImageBlock), 'real image blocks match the host image contract')
      for (const block of images) {
        const stored = attachments.saved.find((ref) => ref.attachmentId === block.attachment.attachmentId)
        check(
          stored !== undefined && block.attachment.mediaType === 'image/jpeg' && block.attachment.bytes > 0,
          `page image ${block.attachment.attachmentId} is a real JPEG attachment`,
          `${block.attachment.mediaType} ${block.attachment.bytes} bytes`,
        )
      }
      await ctx.fiber.dispose()
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
