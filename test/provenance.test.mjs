/**
 * M9 provenance tests: SourceRef validity, page/slide coordinates, practice-origin labelling,
 * and artifact citation assembly.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import {
  findProvenanceConflicts, formatSourceRef, makeSourceRef, PRACTICE_ORIGIN_LABELS,
  PRACTICE_ORIGINS, sourceRefFromChunk, SOURCE_TYPES, validateSourceRef,
} from '../src/provenance/source-ref.js'
import { buildCitations, checkCitations, renderCitationSection } from '../src/provenance/attach.js'
import { chunkDocument } from '../src/extract/chunk.js'
import { extractFile } from '../src/extract/extract.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'
import { createFsGateway } from '../src/fs/gateway.js'

test('source classes and practice origins are the ones the design defines', () => {
  assert.deepEqual([...SOURCE_TYPES].sort(), ['external_web_source', 'local_course_source', 'model_inference', 'user_provided'])
  assert.deepEqual([...PRACTICE_ORIGINS], ['original', 'adapted', 'generated'])
  assert.equal(PRACTICE_ORIGIN_LABELS.original, '原题')
  assert.equal(PRACTICE_ORIGIN_LABELS.adapted, '改编题')
  assert.equal(PRACTICE_ORIGIN_LABELS.generated, '新编练习')
})

test('a SourceRef includes only known fields and rejects invalid coordinates', () => {
  const ref = makeSourceRef({
    sourceType: 'local_course_source',
    fileId: 'f_abc',
    relativePath: 'CSC3200/lectures/week-03.pdf',
    page: 12,
    section: 'Hash Tables',
    chunkId: 'c_deadbeefdeadbeef',
  })
  assert.deepEqual(ref, {
    source_type: 'local_course_source',
    file_id: 'f_abc',
    relative_path: 'CSC3200/lectures/week-03.pdf',
    page: 12,
    section: 'Hash Tables',
    chunk_id: 'c_deadbeefdeadbeef',
  })
  assert.equal(Object.hasOwn(ref, 'slide'), false, 'an unknown slide is omitted, never null-guessed')

  // No page: the field is absent, not 0 or null.
  const noPage = makeSourceRef({ sourceType: 'local_course_source', fileId: 'f_abc' })
  assert.equal(Object.hasOwn(noPage, 'page'), false)

  for (const bad of [
    () => makeSourceRef({ sourceType: 'not_a_type' }),
    () => makeSourceRef({ sourceType: 'local_course_source', page: 0 }),
    () => makeSourceRef({ sourceType: 'local_course_source', page: -3 }),
    () => makeSourceRef({ sourceType: 'local_course_source', page: '12' }),
    () => makeSourceRef({ sourceType: 'local_course_source' }),
    () => makeSourceRef({ sourceType: 'external_web_source', fileId: 'f_abc' }),
  ]) {
    assert.throws(bad, (error) => error.code === 'PROFESSOR_PROVENANCE_INVALID')
  }
  assert.equal(makeSourceRef({ sourceType: 'external_web_source', url: 'https://example.org' }).url, 'https://example.org')
})

test('practice origin is required for practice items and forbidden otherwise', () => {
  for (const origin of PRACTICE_ORIGINS) {
    const ref = makeSourceRef({ sourceType: 'local_course_source', fileId: 'f_a', origin, practice: true })
    assert.equal(ref.origin, origin)
    assert.equal(ref.practice, true)
  }

  assert.throws(
    () => makeSourceRef({ sourceType: 'local_course_source', fileId: 'f_a', practice: true }),
    (error) => error.code === 'PROFESSOR_PROVENANCE_INVALID',
    'a practice reference with no origin is invalid',
  )
  assert.throws(
    () => makeSourceRef({ sourceType: 'local_course_source', fileId: 'f_a', origin: 'generated' }),
    (error) => error.code === 'PROFESSOR_PROVENANCE_INVALID',
    'a plain lecture reference must not carry an origin',
  )
  assert.throws(
    () => makeSourceRef({ sourceType: 'local_course_source', fileId: 'f_a', origin: 'invented', practice: true }),
    (error) => error.code === 'PROFESSOR_PROVENANCE_INVALID',
    'an unknown origin is rejected',
  )
})

test('formatting states the source class where it matters', () => {
  assert.equal(
    formatSourceRef(makeSourceRef({ sourceType: 'local_course_source', relativePath: 'a/b.pdf', page: 3 })),
    'a/b.pdf p.3',
  )
  assert.equal(
    formatSourceRef(makeSourceRef({ sourceType: 'local_course_source', relativePath: 'x.md', section: 'Intro' })),
    'x.md § Intro',
  )
  assert.match(formatSourceRef(makeSourceRef({ sourceType: 'external_web_source', url: 'https://e.org', title: 'T' })), /\[external\]/)
  assert.match(formatSourceRef(makeSourceRef({ sourceType: 'model_inference' })), /model inference/)
  assert.match(formatSourceRef(makeSourceRef({ sourceType: 'user_provided' })), /user-provided/)
  assert.match(
    formatSourceRef(makeSourceRef({ sourceType: 'local_course_source', relativePath: 'q.md', origin: 'generated', practice: true })),
    /\[新编练习\]/,
    'a generated practice item labels itself',
  )
})

test('a PDF backend that reports pages produces page-carrying chunks', () => {
  // Long enough that each page becomes its own chunk, so each citation points at its own page.
  const pageOne = Array.from({ length: 30 }, (_, index) => `Page one line ${index}.`).join('\n')
  const pageTwo = Array.from({ length: 30 }, (_, index) => `Page two line ${index}.`).join('\n')
  const text = `${pageOne}\n${pageTwo}`
  const { chunks } = chunkDocument({
    text,
    fileId: 'f_pdf',
    maxChars: 400,
    pages: [{ page: 1, text: pageOne }, { page: 2, text: pageTwo }],
  })

  assert.ok(chunks.length >= 2, 'the document splits into several chunks')
  assert.ok(chunks.some((chunk) => chunk.page === 1), 'a chunk starting on page 1 records page 1')
  assert.ok(chunks.some((chunk) => chunk.page === 2), 'a chunk starting on page 2 records page 2')
  for (const chunk of chunks) {
    if (chunk.page !== null) assert.ok(chunk.page >= 1, 'page is a positive 1-based integer')
  }

  // Without page data, page stays null (unknown), never a guess.
  const noPages = chunkDocument({ text, fileId: 'f_pdf', maxChars: 400 })
  assert.equal(noPages.chunks.every((chunk) => chunk.page === null), true)
})

test('extractFile passes structured page data through from a runner', async () => {
  const home = await makeHome('professor-prov-')
  await writeFixture(home, 'courses/term/deck.pdf', '%PDF-1.4 body')
  const fake = createFakeContext({ home })
  const gateway = createFsGateway({ ctx: fake.ctx, logger: { warn() {} } })
  const target = await gateway.resolveTarget('courses/term/deck.pdf', { cwd: home })

  const outcome = await extractFile({
    gateway,
    target,
    extension: 'pdf',
    capabilities: { pdfText: 'fitz' },
    run: async () => ({
      text: 'alpha page one\nbeta page two',
      pages: [
        { page: 1, text: 'alpha page one' },
        { page: 2, text: 'beta page two' },
      ],
    }),
  })
  assert.equal(outcome.status, 'extracted')
  assert.equal(outcome.extractor, 'pdf-fitz')
  assert.equal(outcome.pages.length, 2)
  assert.equal(outcome.pages[1].page, 2)
})

test('conflicting page coordinates are detected, not merged', () => {
  const sameFile = [
    makeSourceRef({ sourceType: 'local_course_source', fileId: 'f_a', page: 3 }),
    makeSourceRef({ sourceType: 'local_course_source', fileId: 'f_a', page: 7 }),
    makeSourceRef({ sourceType: 'local_course_source', fileId: 'f_a', page: 3 }),
  ]
  const conflicts = findProvenanceConflicts(sameFile)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].key, 'file:f_a')
  assert.equal(conflicts[0].refs.length, 3)

  const consistent = [
    makeSourceRef({ sourceType: 'local_course_source', fileId: 'f_a', page: 3 }),
    makeSourceRef({ sourceType: 'local_course_source', fileId: 'f_a', page: 3 }),
    makeSourceRef({ sourceType: 'local_course_source', fileId: 'f_b', page: 1 }),
  ]
  assert.equal(findProvenanceConflicts(consistent).length, 0, 'same page, no conflict')

  const sectionConflict = [
    makeSourceRef({ sourceType: 'local_course_source', fileId: 'f_a', chunkId: 'c_1', section: 'Intro' }),
    makeSourceRef({ sourceType: 'local_course_source', fileId: 'f_a', chunkId: 'c_1', section: 'Outro' }),
  ]
  assert.equal(findProvenanceConflicts(sectionConflict).length, 1)
  assert.equal(findProvenanceConflicts(sectionConflict)[0].key, 'chunk:c_1')
})

test('an artifact citation block is assembled, labelled, and conflict-surfaced', () => {
  const chunks = [
    { chunk_id: 'c_1', file_id: 'f_a', relative_path: 'CSC3200/lecture.md', heading: 'Trees', page: null, start_line: 1, end_line: 3, text: 'x' },
    { chunk_id: 'c_2', file_id: 'f_a', relative_path: 'CSC3200/lecture.md', heading: 'Trees', page: null, start_line: 4, end_line: 6, text: 'y' },
  ]

  const plain = buildCitations({ chunks })
  assert.equal(plain.refs.length, 2)
  assert.equal(plain.hasExternal, false)
  assert.equal(checkCitations(plain).ok, true)

  const section = renderCitationSection(plain)
  assert.match(section, /## 资料依据/)
  assert.match(section, /CSC3200\/lecture\.md § Trees/)
  assert.equal(/external/.test(section), false, 'no external label when nothing is external')

  // Practice origins attach only to the chunks named in the map.
  const practice = buildCitations({
    chunks,
    practiceOrigins: { c_2: 'generated' },
  })
  assert.equal(practice.refs.find((ref) => ref.chunk_id === 'c_2').origin, 'generated')
  assert.equal(practice.refs.find((ref) => ref.chunk_id === 'c_1').origin, undefined)
  assert.match(renderCitationSection(practice), /\[新编练习\]/)

  // A malformed origin never gets into the artifact.
  const bad = buildCitations({ chunks, practiceOrigins: { c_1: 'invented' } })
  assert.equal(bad.refs.find((ref) => ref.chunk_id === 'c_1'), undefined)

  // Conflicts are rendered, not swallowed.
  const conflicting = buildCitations({
    chunks: [
      { chunk_id: 'c_9', file_id: 'f_z', relative_path: 'a.md', heading: 'H', page: 1, text: 'a' },
      { chunk_id: 'c_9', file_id: 'f_z', relative_path: 'a.md', heading: 'H', page: 4, text: 'a' },
    ],
  })
  assert.ok(conflicting.conflicts.length > 0)
  assert.match(renderCitationSection(conflicting), /来源冲突/)
  assert.match(renderCitationSection(conflicting), /未静默合并/)
})

test('sourceRefFromChunk carries page and slide through when the chunk knows them', () => {
  const withPage = sourceRefFromChunk({
    chunk_id: 'c_1', file_id: 'f_a', relative_path: 'x.pdf', heading: 'H', page: 12, slide: null,
  })
  assert.equal(withPage.page, 12)
  assert.equal(Object.hasOwn(withPage, 'slide'), false, 'an unknown slide is omitted')

  const withSlide = sourceRefFromChunk({
    chunk_id: 'c_2', file_id: 'f_b', relative_path: 'x.pptx', heading: 'H', slide: 5, page: null,
  })
  assert.equal(withSlide.slide, 5)
  assert.equal(Object.hasOwn(withSlide, 'page'), false)
})

test('end to end: extracted chunks reach search with provenance intact', async () => {
  const home = await makeHome('professor-prov-e2e-')
  const project = path.join(home, 'courses', 'term')
  await writeFixture(home, 'courses/term/CSC3200/01_Lectures/week-03.md',
    '# Hash Tables\n\nA hash table maps keys to buckets.\n\n## Complexity\n\nLookup is constant time on average.\n')

  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })

  await tools.professor_project_init.execute({ project_id: 'term' }, exec)
  await tools.professor_course_manage.execute({
    action: 'register', course_code: 'CSC3200', display_name: 'DSA', term: 'F', source_path: path.join(project, 'CSC3200'),
  }, exec)
  await tools.professor_index_sync.execute({}, exec)
  await tools.professor_extract.execute({}, exec)

  const found = await tools.professor_search.execute({ query: 'hash table buckets' }, exec)
  assert.ok(found.results.length > 0)
  const top = found.results[0]

  const ref = sourceRefFromChunk(top)
  assert.equal(ref.source_type, 'local_course_source')
  assert.equal(ref.course_id, undefined, 'SourceRef has no course field by design; course lives on the chunk')
  assert.equal(typeof ref.file_id, 'string')
  assert.equal(typeof ref.relative_path, 'string')
  assert.equal(ref.page, undefined, 'a markdown file has no pages; the field is omitted, not guessed')
  assert.equal(checkCitations(buildCitations({ chunks: found.results })).ok, true)

  const index = JSON.parse(await fs.readFile(path.join(project, '.professor', 'indexes', 'files.json'), 'utf8'))
  const record = index.files.find((entry) => entry.relative_path === 'CSC3200/01_Lectures/week-03.md')
  assert.equal(record.extraction_status, 'extracted')
  assert.equal(typeof record.file_id, 'string')
})
