/**
 * Production extraction: the real runner, the real provenance chain, and the honest failures.
 *
 * Two kinds of test live here and they are deliberately kept apart:
 *
 * - **integration / end-to-end** — a genuine Ghostscript and a genuine bundled Python are executed
 *   through the real shell seam, and the assertion is about the artefact on disk and the citation
 *   the model would see. These skip with an explicit reason when the machine has no backend, so
 *   they never silently pass as a mock;
 * - **contract** — `chunkDocument` coordinate mapping, unit ordering, classification. Pure, always
 *   runs, and covers the branches a real backend on this machine would not reach (ambiguity, an
 *   encrypted container, a capture that overflowed).
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { chunkDocument } from '../src/extract/chunk.js'
import { existingCandidates, ghostscriptCandidates } from '../src/extract/runtime.js'
import { buildCitations, renderCitationSection } from '../src/provenance/attach.js'
import { formatSourceRef, sourceRefFromChunk } from '../src/provenance/source-ref.js'
import {
  createFakeContext, createFakeShell, createScriptedShell, makeExec, makeHome, writeFixture,
} from './helpers/fake-harness.mjs'
import {
  buildPdfBytes, buildScannedPdfBytes, bundledPython, hasOfficeModules, writeOfficeFixtures,
} from './helpers/fixtures.mjs'

// --- environment detection (never assumed: probed) -----------------------------------------

const GHOSTSCRIPT = existingCandidates(ghostscriptCandidates({ env: process.env, pathDirs: [] }))[0] ?? null
const PYTHON = bundledPython()

/** Real Ghostscript availability, proved by running it rather than by finding a file name. */
function ghostscriptVersion() {
  if (GHOSTSCRIPT === null) return null
  try {
    return execFileSync(GHOSTSCRIPT.path, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim()
  } catch {
    return null
  }
}

const GS_VERSION = ghostscriptVersion()

/** Long, heading-bearing page bodies, so a page produces more than one chunk. */
function pageBody(title, markers) {
  return [`# ${title}`, '', ...markers.flatMap((marker) => [`Paragraph about ${marker} with enough words to fill a chunk.`, ''])].join('\n')
}

const TWO_PAGE_PDF = buildPdfBytes({
  pages: [
    pageBody('Alpha Section', ['algebra', 'algorithms', 'amortised cost', 'asymptotic bounds', 'arrays', 'abstraction']),
    pageBody('Beta Section', ['binary search', 'balanced trees', 'breadth first search', 'big-O notation', 'buckets']),
  ],
})

const LONGER_PAGE = 4200

/** A workbook far larger than the configured cap, to prove truncation is reported and bounded. */
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

async function readText(file) {
  return fs.readFile(file, 'utf8')
}

/**
 * SHA-256 of every file under a tree, so "the source was not modified" is byte-exact.
 *
 * `exclude` names top-level directories that are *plugin output* rather than source: `.professor`
 * (index + chunk stores) always, and the artifact root where a test deliberately writes a note.
 * Excluding them is not a loophole — the claim being tested is that extraction never writes to the
 * material it reads — and `fileDigest` below makes the claim about the source document itself.
 */
async function digestTree(root, options = {}) {
  const exclude = new Set(options.exclude ?? ['.professor'])
  const digest = createHash('sha256')
  const walk = async (current) => {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const target = path.join(current, entry.name)
      const relative = path.relative(root, target)
      if (exclude.has(relative.split(path.sep)[0])) continue
      if (entry.isDirectory()) await walk(target)
      else if (!entry.isSymbolicLink()) digest.update(relative).update(await fs.readFile(target))
    }
  }
  await walk(root)
  return digest.digest('hex')
}

/** SHA-256 of one file, so "this PDF is byte-identical" is proved about the PDF itself. */
async function fileDigest(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

/** A project with the given files, a real shell, and a bound course — the shape every test needs. */
async function projectWith(files, options = {}) {
  const home = await makeHome('professor-extract-prod-')
  const project = path.join(home, 'csc3200')
  for (const [relative, content] of Object.entries(files)) {
    await writeFixture(home, path.join('csc3200', relative), content)
  }
  const shell = options.shell ?? createFakeShell({ cwd: home, timeoutMs: options.timeoutMs ?? 60_000 })
  const fake = createFakeContext({ home, services: { shell } })
  apply(fake.ctx, { ...fake.pluginConfig, ...(options.pluginConfig ?? {}) })
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })
  await tools.professor_project_init.execute({}, exec)
  await tools.professor_course_manage.execute({
    action: 'register', course_code: 'CSC3200', display_name: 'Data Structures',
    term: '2025-2026 Fall', source_path: project, notes_root: path.join(project, 'AI-Notes'),
  }, exec)
  await tools.professor_session_bind.execute({ action: 'bind', course: 'CSC3200' }, exec)
  // Every test below starts from an indexed project: a file has to be in the index before it can
  // be extracted, so the index is part of the fixture rather than a step each test repeats.
  await tools.professor_index_sync.execute({}, exec)
  return { home, project, fake, tools, exec, shell }
}

// --- contract: coordinate mapping -----------------------------------------------------------

test('a chunk inside one page carries that page; a chunk across pages carries an honest range', () => {
  const text = 'alpha line\n\nbeta line\n\ngamma line'
  const pages = [
    { page: 1, text: 'alpha line' },
    { page: 2, text: 'beta line\n\ngamma line' },
  ]
  const { chunks } = chunkDocument({ text, fileId: 'f_doc', pages, maxChars: 1000, minChars: 1 })
  assert.equal(chunks.length, 1, 'this short document is one chunk')
  assert.equal(chunks[0].page, 1, 'the citation starts where the chunk starts')
  assert.deepEqual(chunks[0].page_range, [1, 2], 'and the extent is a range, not a single page')

  const within = chunkDocument({
    text: 'page one only',
    fileId: 'f_doc',
    pages: [{ page: 7, text: 'page one only' }],
    minChars: 1,
  })
  assert.equal(within.chunks[0].page, 7)
  assert.equal(within.chunks[0].page_range, undefined, 'a single-page chunk carries no range')
  assert.equal(within.chunks[0].coordinate_ambiguous, undefined)
})

test('a chunk whose extent leaves the known pages is marked ambiguous, not attributed to one page', () => {
  // The backend reported pages 1 and 2, but the document text continues past page 2's text.
  const text = 'alpha\n\nbeta\n\ntrailing content nobody mapped'
  const pages = [{ page: 1, text: 'alpha' }, { page: 2, text: 'beta' }]
  const { chunks } = chunkDocument({ text, fileId: 'f_doc', pages, minChars: 1, maxChars: 1000 })
  assert.equal(chunks[0].page, 1)
  assert.equal(chunks[0].page_range, undefined, 'no range is invented for an unmapped tail')
  assert.equal(chunks[0].coordinate_ambiguous, true, 'the extent is marked instead of guessed')
})

test('no pages at all means no coordinate at all', () => {
  const { chunks } = chunkDocument({ text: 'just text', fileId: 'f_doc', pages: null, minChars: 1 })
  assert.equal(chunks[0].page, null)
  assert.equal(chunks[0].slide, null)
  assert.equal(chunks[0].page_range, undefined)
  assert.equal(chunks[0].coordinate_ambiguous, undefined)
})

test('slide coordinates work the same way, and never masquerade as pages', () => {
  const text = 'slide one body\n\nslide two body'
  const pages = [{ slide: 1, text: 'slide one body' }, { slide: 2, text: 'slide two body' }]
  const { chunks } = chunkDocument({ text, fileId: 'f_deck', pages, minChars: 1, maxChars: 1000 })
  assert.equal(chunks[0].slide, 1)
  assert.equal(chunks[0].page, null, 'a slide number is not a page number')
  assert.deepEqual(chunks[0].slide_range, [1, 2])
})

test('a deterministic backend produces byte-identical chunks on every run', () => {
  const pages = [{ page: 1, text: 'one' }, { page: 2, text: 'two' }]
  const first = chunkDocument({ text: 'one\n\ntwo', fileId: 'f_x', pages, minChars: 1 })
  const second = chunkDocument({ text: 'one\n\ntwo', fileId: 'f_x', pages, minChars: 1 })
  assert.deepEqual(first.chunks, second.chunks)
})

// --- contract: the failure vocabulary -------------------------------------------------------

test('with no runnable backend at all, extraction is unsupported with the reason, never failed', async () => {
  // Every command exits 127 as if the binary did not exist, which is what an empty host looks like.
  const shell = createScriptedShell(() => ({ exitCode: 127, stderr: 'command not found' }))
  const f = await projectWith({ 'notes/lecture.pdf': TWO_PAGE_PDF }, { shell })

  const outcome = await f.tools.professor_extract.execute({}, f.exec)
  assert.equal(outcome.unsupported, 1)
  assert.equal(outcome.failed, 0, 'an absent backend is not a failure of the document')
  assert.equal(outcome.capabilities.pdf.text, false)
  assert.equal(outcome.capabilities.pdf.backend, null)
  assert.match(outcome.results[0].reason, /no PDF text backend was observed/)
  assert.equal(outcome.capabilities.probe.attempted, true, 'the probe really ran; it just found nothing')
})

test('a backend timeout is a failure with the deadline named, not an empty document', async () => {
  const shell = createScriptedShell((line) => {
    if (line.includes('probe_python.py')) {
      return { stdout: JSON.stringify({ ok: true, python: '3.12.14', modules: { fitz: '1.24.9', docx: '1.2.0', pptx: '1.0.2', openpyxl: '3.1.5' }, missing: [] }) }
    }
    if (line.includes('.pdf')) return { timedOut: true, exitCode: null }
    return { exitCode: 0 }
  })
  const f = await projectWith({ 'notes/lecture.pdf': TWO_PAGE_PDF }, { shell })
  const outcome = await f.tools.professor_extract.execute({}, f.exec)
  assert.equal(outcome.failed, 1)
  assert.equal(outcome.unsupported, 0, 'a timeout is not "unsupported": the backend exists and stopped')
  assert.match(outcome.results[0].reason, /timed out after \d+ms/)
})

test('an oversized capture is refused rather than parsed from a truncated envelope', async () => {
  const shell = createScriptedShell((line) => {
    if (line.includes('probe_python.py')) {
      return { stdout: JSON.stringify({ ok: true, python: '3.12.14', modules: { fitz: '1.24.9' }, missing: [] }) }
    }
    return { stdout: '{"ok":true,"pages":', truncated: true }
  })
  const f = await projectWith({ 'notes/lecture.pdf': TWO_PAGE_PDF }, { shell })
  const outcome = await f.tools.professor_extract.execute({}, f.exec)
  assert.equal(outcome.failed, 1)
  assert.match(outcome.results[0].reason, /capture cap/)
})

test('an encrypted Office document is unsupported, and is never reported as empty text', async () => {
  const shell = createScriptedShell((line) => {
    if (line.includes('probe_python.py')) {
      return { stdout: JSON.stringify({ ok: true, python: '3.12.14', modules: { docx: '1.2.0', pptx: '1.0.2', openpyxl: '3.1.5' }, missing: [] }) }
    }
    return { stdout: JSON.stringify({ ok: false, error: 'encrypted', detail: 'OLE/CFB container' }) }
  })
  const f = await projectWith({ 'notes/secret.docx': 'not really a docx' }, { shell })
  const outcome = await f.tools.professor_extract.execute({}, f.exec)
  assert.equal(outcome.unsupported, 1)
  assert.match(outcome.results[0].reason, /encrypted or password-protected/)
})

test('a malformed document is a failure with the parser reason, not an empty extraction', async () => {
  const shell = createScriptedShell((line) => {
    if (line.includes('probe_python.py')) {
      return { stdout: JSON.stringify({ ok: true, python: '3.12.14', modules: { docx: '1.2.0' }, missing: [] }) }
    }
    return { stdout: JSON.stringify({ ok: false, error: 'malformed', detail: 'PackageNotFoundError' }) }
  })
  const f = await projectWith({ 'notes/broken.docx': 'not a zip' }, { shell })
  const outcome = await f.tools.professor_extract.execute({}, f.exec)
  assert.equal(outcome.failed, 1)
  assert.match(outcome.results[0].reason, /parsing failure/)
})

test('a source file outside the approved read roots is refused before any process starts', async () => {
  const home = await makeHome('professor-extract-escape-')
  const project = path.join(home, 'csc3200')
  const outside = path.join(home, 'elsewhere')
  await writeFixture(home, path.join('elsewhere', 'lecture.pdf'), TWO_PAGE_PDF)
  await writeFixture(home, path.join('csc3200', 'keep.md'), '# Keep\n\ncontent')
  const shell = createFakeShell({ cwd: home })
  const fake = createFakeContext({ home, services: { shell } })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })
  await tools.professor_project_init.execute({}, exec)
  await tools.professor_course_manage.execute({
    action: 'register', course_code: 'CSC3200', display_name: 'DSA', term: 'T', source_path: outside,
  }, exec)

  // The course was registered against a root outside the project, so the read policy must refuse it
  // rather than letting a process open the file.
  await tools.professor_index_sync.execute({}, exec)
  const outcome = await tools.professor_extract.execute({}, exec)
  const refused = outcome.results.filter((entry) => entry.status === 'failed')
  for (const entry of refused) assert.match(entry.reason, /outside the approved read roots/)
  const ranOnPdf = shell.calls.some((line) => line.includes('elsewhere'))
  assert.equal(ranOnPdf, false, 'no command was ever started with the out-of-bounds path')
})

// --- integration: PDF through the real runner ------------------------------------------------

test('a real PDF reaches chunks, search, SourceRef and an artifact citation with real page numbers', async (t) => {
  if (GS_VERSION === null) {
    t.skip(`no Ghostscript on this machine (looked in ${ghostscriptCandidates({ env: process.env, pathDirs: [] }).map((entry) => entry.path).slice(0, 4).join(', ')})`)
    return
  }
  // Pin interpreter discovery to the payload python (which has no PyMuPDF) so this test really
  // exercises the Ghostscript path rather than whichever interpreter happens to sit on PATH. The
  // PyMuPDF path has its own test.
  const f = await projectWith({ 'lectures/two-page.pdf': TWO_PAGE_PDF }, { pluginConfig: { extractRuntime: { pathDirs: [] } } })
  const pdfPath = path.join(f.project, 'lectures/two-page.pdf')
  const sourceBefore = await digestTree(f.project, { exclude: ['.professor', 'AI-Notes'] })
  const pdfBefore = await fileDigest(pdfPath)

  const indexed = await f.tools.professor_index_sync.execute({}, f.exec)
  assert.equal(indexed.total, 1)

  const extracted = await f.tools.professor_extract.execute({}, f.exec)
  assert.equal(extracted.extracted, 1, `the PDF extracted (results: ${JSON.stringify(extracted.results)})`)
  assert.equal(extracted.unsupported, 0)
  assert.equal(extracted.failed, 0)
  assert.equal(extracted.results[0].extractor, 'pdf-ghostscript')
  assert.equal(extracted.capabilities.pdf.text, true, 'the capability block reports the observed backend')
  assert.equal(extracted.capabilities.pdf.backend, 'ghostscript')
  assert.equal(extracted.capabilities.pdf.pageCoordinates, true)
  assert.equal(extracted.capabilities.pdf.visual, false, 'text extraction is not visual inspection')
  assert.equal(extracted.capabilities.pdf.ocr, false)

  const stores = await fs.readdir(path.join(f.project, '.professor/indexes/chunks'))
  assert.equal(stores.length, 1)
  const store = JSON.parse(await readText(path.join(f.project, '.professor/indexes/chunks', stores[0])))
  const pages = new Set(store.chunks.map((chunk) => chunk.page))
  assert.deepEqual([...pages].sort((a, b) => a - b), [1, 2],
    'both real pages reached the chunks; no synthetic page number was added')
  assert.ok(store.chunks.every((chunk) => Number.isInteger(chunk.page) && chunk.page >= 1))

  // A chunk that sits inside one page carries exactly that page.
  const single = store.chunks.find((chunk) => chunk.page_range === undefined && chunk.coordinate_ambiguous !== true)
  assert.ok(single, 'at least one chunk lies inside a single page')

  const found = await f.tools.professor_search.execute({ query: 'amortised cost asymptotic bounds' }, f.exec)
  assert.ok(found.results.length > 0)
  const hit = found.results[0]
  assert.equal(hit.page, 1, 'the search result carries the page the backend reported')
  assert.ok(hit.page_range === null || Array.isArray(hit.page_range))

  const ref = sourceRefFromChunk(hit)
  assert.equal(ref.page, 1)
  assert.match(formatSourceRef(ref), /p\.1/)

  const citations = buildCitations({ chunks: found.results })
  assert.ok(citations.refs.length > 0)
  const rendered = renderCitationSection(citations)
  assert.match(rendered, /资料依据/)
  assert.match(rendered, /p\.\d/, 'the rendered citation block carries a real page number')

  // The whole chain, through the tool the model would call.
  const artifact = await f.tools.professor_artifact_create.execute({
    kind: 'note', title: 'Page Provenance Note', format: 'markdown',
    sections: [{ heading: 'Explanation', body: 'Amortised analysis averages the cost.' }],
    source_chunks: found.results,
  }, f.exec)
  assert.equal(artifact.created, true, `artifact problems: ${artifact.problems?.join('; ')}`)
  const body = await readText(path.join(artifact.root, artifact.directory, artifact.filename))
  assert.match(body, /资料依据/, 'the artifact carries the citation block')
  assert.match(body, /p\.\d/, 'and the block preserves the real page number')

  // Nothing in the source tree changed, and re-extraction is byte-identical.
  assert.equal(await fileDigest(pdfPath), pdfBefore, 'the source PDF is byte-identical')
  assert.equal(await digestTree(f.project, { exclude: ['.professor', 'AI-Notes'] }), sourceBefore,
    'no file in the course material tree was touched')
  await f.tools.professor_extract.execute({ rebuild: true }, f.exec)
  const again = JSON.parse(await readText(path.join(f.project, '.professor/indexes/chunks', stores[0])))
  assert.deepEqual(again.chunks, store.chunks, 're-extraction is deterministic')
})

test('a PDF with no text layer is unsupported, names OCR, and writes no chunks', async (t) => {
  if (GS_VERSION === null) {
    t.skip('no Ghostscript on this machine')
    return
  }
  const f = await projectWith({ 'lectures/scanned.pdf': buildScannedPdfBytes() })
  await f.tools.professor_index_sync.execute({}, f.exec)
  const outcome = await f.tools.professor_extract.execute({}, f.exec)
  assert.equal(outcome.extracted, 0)
  assert.equal(outcome.unsupported, 1)
  assert.equal(outcome.failed, 0, 'an empty text layer is not a parse failure')
  assert.match(outcome.results[0].reason, /no text layer/)
  assert.match(outcome.results[0].reason, /OCR is disabled/)
  const chunkDir = path.join(f.project, '.professor/indexes/chunks')
  const entries = await fs.readdir(chunkDir).catch(() => [])
  assert.deepEqual(entries, [], 'no chunk store is written for a document with no text')
})

// --- integration: Office through the real runner ---------------------------------------------

test('a real DOCX is extracted in document order with its headings and table text', async (t) => {
  if (PYTHON === null || !hasOfficeModules(PYTHON)) {
    t.skip('no bundled Python with python-docx / python-pptx / openpyxl on this machine')
    return
  }
  const fixtures = await writeOfficeFixtures(await makeHome('professor-office-'))
  const bytes = await fs.readFile(fixtures.docx)
  const f = await projectWith({ 'notes/lecture.docx': bytes })
  const sourceBefore = await digestTree(f.project)

  await f.tools.professor_index_sync.execute({}, f.exec)
  const outcome = await f.tools.professor_extract.execute({}, f.exec)
  assert.equal(outcome.extracted, 1, JSON.stringify(outcome.results))
  assert.equal(outcome.results[0].extractor, 'office-docx')

  const store = await readStore(f.project)
  const text = store.chunks.map((chunk) => chunk.text).join('\n')
  const headings = store.chunks.map((chunk) => chunk.heading).filter(Boolean)
  // The chunker consumes a heading line as the section title, so a heading is *cited* through
  // `chunk.heading` rather than repeated inside `chunk.text` — that is what the assertion checks.
  assert.ok(headings.includes('Big-O Notation'), `the level-1 heading survives: ${headings.join(' | ')}`)
  assert.ok(headings.includes('Examples'), `the level-2 heading survives: ${headings.join(' | ')}`)
  assert.ok(headings.indexOf('Big-O Notation') < headings.indexOf('Examples'),
    'document order is preserved: the first heading comes before the second')
  assert.match(text, /growth of work/, 'the body paragraph is present')
  assert.match(text, /linear scan over n items/, 'the second paragraph is present')
  assert.match(text, /\| Hash table \| O\(1\) average \|/, 'the table row is present as table text')
  assert.ok(store.chunks.every((chunk) => chunk.page === null),
    'structural OOXML reading knows no page numbers, so none is claimed')
  assert.equal(Math.min(...store.chunks.map((chunk) => chunk.start_line)) >= 1, true,
    'structural line coordinates are real and one-based')
  assert.equal(outcome.capabilities.office.docx, true)
  assert.equal(outcome.capabilities.office.backend, 'bundled-python')

  assert.equal(await digestTree(f.project), sourceBefore, 'the DOCX is byte-identical after extraction')
})

test('a real PPTX keeps every slide number through to search and citations', async (t) => {
  if (PYTHON === null || !hasOfficeModules(PYTHON)) {
    t.skip('no bundled Python with python-pptx on this machine')
    return
  }
  const fixtures = await writeOfficeFixtures(await makeHome('professor-office-'))
  const f = await projectWith({ 'slides/lecture.pptx': await fs.readFile(fixtures.pptx) })
  await f.tools.professor_index_sync.execute({}, f.exec)
  const outcome = await f.tools.professor_extract.execute({}, f.exec)
  assert.equal(outcome.extracted, 1, JSON.stringify(outcome.results))
  assert.ok(outcome.capabilities.office.slideCoordinates === true, 'slide coordinates were observed')

  const store = await readStore(f.project)
  assert.deepEqual([...new Set(store.chunks.map((chunk) => chunk.slide))].sort((a, b) => a - b), [1, 2],
    'both real slides reached the chunks')
  assert.ok(store.chunks.every((chunk) => chunk.page === null), 'a slide is not a page')

  const found = await f.tools.professor_search.execute({ query: 'amortised analysis doubling argument' }, f.exec)
  const hit = found.results.find((result) => result.slide === 1)
  assert.ok(hit, `a slide-1 chunk is searchable (slide numbers: ${found.results.map((result) => result.slide).join(',')})`)
  assert.match(hit.heading, /Slide 1/)
  assert.match(formatSourceRef(sourceRefFromChunk(hit)), /slide 1/, 'the citation names the slide')

  const citations = buildCitations({ chunks: found.results })
  assert.match(renderCitationSection(citations), /slide \d/, 'the artifact block preserves slide numbers')
})

test('a real XLSX keeps sheet identity and reports formulas without recalculating them', async (t) => {
  if (PYTHON === null || !hasOfficeModules(PYTHON)) {
    t.skip('no bundled Python with openpyxl on this machine')
    return
  }
  const fixtures = await writeOfficeFixtures(await makeHome('professor-office-'))
  const f = await projectWith({ 'sheets/figures.xlsx': await fs.readFile(fixtures.xlsx) })
  await f.tools.professor_index_sync.execute({}, f.exec)
  const outcome = await f.tools.professor_extract.execute({}, f.exec)
  assert.equal(outcome.extracted, 1, JSON.stringify(outcome.results))

  const store = await readStore(f.project)
  const headings = store.chunks.map((chunk) => chunk.heading).filter(Boolean)
  assert.ok(headings.some((heading) => /Sheet 1: Revenue/.test(heading)), `sheet names survive: ${headings.join(' | ')}`)
  assert.ok(headings.some((heading) => /Sheet 2: Notes/.test(heading)))
  const text = store.chunks.map((chunk) => chunk.text).join('\n')
  assert.match(text, /=SUM\(B2:B3\)/, 'the formula is reported as a formula')
  assert.match(text, /amortised cost/, 'the second sheet\'s content is present')
  assert.ok(!/\b30\b/.test(text), 'the formula total was not computed anywhere')
  assert.equal(outcome.capabilities.office.xlsx, true)
})

test('an oversized workbook is bounded and the truncation is reported explicitly', async (t) => {
  if (PYTHON === null || !hasOfficeModules(PYTHON)) {
    t.skip('no bundled Python with openpyxl on this machine')
    return
  }
  const home = await makeHome('professor-oversize-')
  const oversized = path.join(home, 'huge.xlsx')
  execFileSync(PYTHON.path, ['-', oversized], { input: OVERSIZED_WORKBOOK_SCRIPT, encoding: 'utf8', timeout: 60_000 })

  const f = await projectWith({ 'sheets/huge.xlsx': await fs.readFile(oversized) })
  await f.tools.professor_index_sync.execute({}, f.exec)
  const outcome = await f.tools.professor_extract.execute({}, f.exec)
  assert.equal(outcome.extracted, 1, JSON.stringify(outcome.results))
  assert.ok(Array.isArray(outcome.results[0].truncated) && outcome.results[0].truncated.length > 0,
    'the cap is reported rather than applied silently')
  assert.ok(outcome.results[0].truncated.some((note) => /rows capped|cell/i.test(note)))
  assert.equal(outcome.warnings.length > 0, true, 'and it surfaces as a warning on the tool result')

  // Bounded means bounded: the store cannot hold the whole 4000-row sheet.
  const store = await readStore(f.project)
  const text = store.chunks.map((chunk) => chunk.text).join('\n')
  assert.ok(!/value 3999/.test(text), 'the far end of the sheet was not read')
  assert.ok(text.includes('value 1'), 'but the used region really was read')
})

/** Read the single chunk store a one-file project produced. */
async function readStore(projectRoot) {
  const directory = path.join(projectRoot, '.professor/indexes/chunks')
  const entries = await fs.readdir(directory)
  assert.equal(entries.length, 1, `expected one chunk store, found ${entries.join(', ')}`)
  return JSON.parse(await readText(path.join(directory, entries[0])))
}

// --- integration: the capability report describes what really happened -----------------------

test('diagnostics reports the observed backends, and keeps OCR and visual inspection separate', async (t) => {
  if (GS_VERSION === null) {
    t.skip('no Ghostscript on this machine')
    return
  }
  const f = await projectWith({ 'lectures/two-page.pdf': TWO_PAGE_PDF }, { pluginConfig: { extractRuntime: { pathDirs: [] } } })
  const report = await f.tools.professor_diagnostics.execute({}, f.exec)

  const pdf = report.extraction.capabilities.pdf
  assert.equal(pdf.text, true)
  assert.equal(pdf.backend, 'ghostscript')
  assert.equal(pdf.visual, false, 'no page is rendered, so nothing visual is claimed')
  assert.equal(pdf.ocr, false)
  assert.equal(report.extraction.visualInspection.startsWith('rendering exists'), true,
    'rendering and visual interpretation stay separate claims')

  const probe = report.extraction.capabilities.probe
  assert.equal(probe.attempted, true)
  assert.equal(probe.ghostscript.available, true)
  assert.equal(probe.ghostscript.version, GS_VERSION)
  assert.equal(typeof probe.ghostscript.path, 'string', 'the observed binary carries its path')

  const features = report.notImplemented.map((entry) => entry.feature).join(' | ')
  assert.match(features, /OCR/i, 'OCR is still declared unavailable')
  assert.match(features, /visual/i, 'visual inspection is still declared unavailable')
  assert.doesNotMatch(features, /Office \(docx\/pptx\/xlsx\) text extraction without an injected Python runner/)
  assert.doesNotMatch(features, /PowerPoint slide coordinates/)
})

test('the probe is memoized: extraction and diagnostics share one observation', async (t) => {
  if (GS_VERSION === null) {
    t.skip('no Ghostscript on this machine')
    return
  }
  const f = await projectWith({ 'lectures/two-page.pdf': TWO_PAGE_PDF })
  await f.tools.professor_index_sync.execute({}, f.exec)
  await f.tools.professor_extract.execute({}, f.exec)
  const afterExtract = f.shell.calls.length
  await f.tools.professor_diagnostics.execute({}, f.exec)
  const probeCalls = f.shell.calls.filter((line) => line.includes('--version') || line.includes('probe_python.py'))
  assert.equal(probeCalls.length <= 4, true, `the probe ran once, not once per tool call (${probeCalls.length} probe commands)`)
  assert.ok(afterExtract > 0)
  void LONGER_PAGE
})
