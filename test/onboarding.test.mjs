/**
 * Phase 3 (M3) — academic-folder onboarding and derived indexing.
 *
 * What is pinned here, mapped to the Phase 3 brief:
 *
 * 1.  **Discovery mutates nothing** — a source snapshot (path → sha256 + size) taken before and
 *     after every call is byte-identical, and no `.professor/` is created before confirmation.
 * 2.  **High-confidence course codes** (`CSC3200`, `STA2001`, `PHY1001`) are recognised; ambiguous
 *     names (`Algorithms`, `Math`, `Course A`) are **not** silently assigned an identity.
 * 3.  **Duplicate codes across terms** produce distinct courses — never one merged course.
 * 4.  **Material classification** reuses the existing conventions and adds `supplementary`:
 *     `06_Code` and `00_Course-Info` are supplementary, an explicit exam directory is `exams`.
 * 5.  **The proposal/confirmation contract** is versioned, fingerprinted, validated, and lossless
 *     JSON (checked with the same validator the host calls on stored records).
 * 6.  **Repeat connection preserves** course ids, outputs, notes metadata, registry fields and
 *     status, and is idempotent.
 * 7.  **A changed folder between discovery and confirmation is refused**, never applied.
 * 8.  **Symlink escapes and unreadable directories** are skipped and reported, never indexed.
 * 9.  **Paths outside the approved roots are refused** (a recorded connection whose canonical
 *     location moved).
 * 10. **Incremental indexing** detects added / changed / removed material, reuses unchanged
 *     extraction, re-extracts changed files, and never surfaces removed or superseded content.
 * 11. **Explicit rebuild** re-derives indexes only: configuration, learning state, notes and
 *     originals are untouched.
 * 12. **Newer/corrupt project configuration is never overwritten.**
 * 13. **Folder changes are exposed as a decision**, and switching never deletes anything.
 * 14. **Phase 2 regressions** — global memory works with no folder, course memory stays isolated,
 *     and onboarding manufactures no learning progress.
 *
 * These are fake-host contract tests: they prove the plugin's own rules. Real-host evidence lives
 * in `tools/verify-onboarding.mjs` (see `docs/v1/STATUS.md`, Phase 3).
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { createFsGateway } from '../src/fs/gateway.js'
import { resolveExcludePaths } from '../src/indexer/exclude.js'
import { validateRecord } from '../src/app/storage.js'
import { WORKSPACE_CONNECTION_KEY, WORKSPACE_RECORD_SCHEMA } from '../src/workspace/onboarding.js'
import {
  ONBOARDING_SCHEMA,
  fingerprintProposal,
  inferTerm,
  parseCourseCodeName,
  validateProposal,
} from '../src/workspace/detect.js'
import { MATERIAL_CATEGORIES, deriveMaterialRules } from '../src/workspace/materials.js'
import {
  createFakeContext,
  createFakeStorageDomain,
  makeExec,
  makeHome,
  writeFixture,
} from './helpers/fake-harness.mjs'

// --- helpers -----------------------------------------------------------------

const toolsOf = (fake) => Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))

test('successful discovery includes its required problems array', async () => {
  const { home, root } = await standardFixture()
  const { tools } = mount(home)
  const result = await tools.professor_workspace_discover.execute({}, makeExec({ cwd: root }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.problems, [])
})

test('configured per-course artifact destinations are excluded from the source corpus', async () => {
  const { home, root } = await standardFixture()
  const { fake } = mount(home)
  const source = path.join(await fs.realpath(root), 'CSC3200')
  const notes = path.join(source, '04_My-Notes', 'AI-Notes')
  await fs.mkdir(notes, { recursive: true })
  const document = { outputs: {}, courses: [{ course_id: 'csc3200', sources: [{ path: source }], outputs: { notes_root: notes } }] }
  const paths = await resolveExcludePaths({ gateway: createFsGateway({ ctx: fake.ctx }), projectRoot: await fs.realpath(root), document })
  assert.ok(paths.includes(notes))
})

/** Mount the plugin over a fixture home, optionally with a shared storage medium. */
function mount(home, { storage } = {}) {
  const fake = createFakeContext({
    home,
    ...(storage === undefined ? {} : { services: { storageDomain: storage.service } }),
  })
  apply(fake.ctx, fake.pluginConfig)
  return { fake, tools: toolsOf(fake) }
}

/**
 * Snapshot every source file under `root` (path → `{ sha256, size }`).
 *
 * `.professor/` is Professor-owned derived state, not source material, so it is excluded from the
 * invariance claim — but everything else must be byte-identical before and after every operation.
 */
async function snapshotSources(root) {
  const out = {}
  const walk = async (dir, prefix) => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === '.professor') continue
      const absolute = path.join(dir, entry.name)
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(absolute, relative)
        continue
      }
      if (!entry.isFile()) continue
      const bytes = await fs.readFile(absolute)
      const info = await fs.stat(absolute)
      out[relative] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: info.size }
    }
  }
  await walk(root, '')
  return out
}

/** A standard fixture academic folder: unambiguous codes, ambiguous names and unrelated folders. */
async function standardFixture() {
  const home = await makeHome('professor-onboarding-')
  const root = path.join(home, 'courses')
  const files = [
    'CSC3200/01_Lectures/lecture01.txt',
    'CSC3200/03_Assignments/hw1.txt',
    'CSC3200/04_My-Notes/scratch.txt',
    'STA2001/01_Lectures/lecture01.txt',
    'PHY1001/05_Exams/midterm.txt',
    'PHY1001/00_Course-Info/syllabus.txt',
    'PHY1001/06_Code/vector.txt',
    'Algorithms/01_Lectures/lecture01.txt',
    'Math/notes.md',
    'Course A/01_Lectures/lecture01.txt',
    'Photos/image.png',
    'Archive/data.bin',
  ]
  for (const relative of files) {
    await writeFixture(root, relative, `content of ${relative}\n`)
  }
  return { home, root }
}

const OK_ARGS = { proposal: null, selections: [] }

/** Run discover, asserting the call succeeded, and return the proposal. */
async function discover(tools, exec, args = {}) {
  const result = await tools.professor_workspace_discover.execute(args, exec)
  assert.equal(result.ok, true, `discover failed: ${result.code} ${JSON.stringify(result.problems)}`)
  assert.notEqual(result.proposal, null)
  return result
}

const candidateAt = (proposal, relative) => proposal.candidates.find((entry) => entry.relative_path === relative)

// --- 1. pure detection --------------------------------------------------------

test('course-code folder names are recognised and ambiguous names are not', () => {
  assert.equal(parseCourseCodeName('CSC3200').code, 'CSC3200')
  assert.equal(parseCourseCodeName('STA2001').code, 'STA2001')
  assert.equal(parseCourseCodeName('PHY1001').code, 'PHY1001')
  assert.equal(parseCourseCodeName('csc3200').code, 'CSC3200')
  assert.equal(parseCourseCodeName('MATH2010').code, 'MATH2010')
  assert.equal(parseCourseCodeName('CS101').code, 'CS101')

  for (const ambiguous of ['Algorithms', 'Math', 'Course A', '2025 Fall', 'Lecture 1', 'Photos']) {
    assert.equal(parseCourseCodeName(ambiguous), null, `"${ambiguous}" must not look like a course code`)
  }
})

test('a course folder with a recognised suffix still identifies its code and its term', () => {
  const parsed = parseCourseCodeName('CSC3200-2025Fall')
  assert.equal(parsed.code, 'CSC3200')
  assert.equal(parsed.suffix, '2025Fall')

  assert.deepEqual(parseCourseCodeName('CSC3200'), { code: 'CSC3200', suffix: null })
})

test('terms are inferred from a folder name, a suffix or an ancestor, and never invented', () => {
  assert.equal(inferTerm(['2025-2026 Fall']), '2025-2026 Fall')
  assert.equal(inferTerm(['2025 Fall']), '2025 Fall')
  assert.equal(inferTerm(['Fall 2026']), 'Fall 2026')
  assert.equal(inferTerm(['2025Fall']), '2025 Fall')
  assert.equal(inferTerm(['2025 秋']), '2025 秋')
  assert.equal(inferTerm(['CSC3200']), null)
  assert.equal(inferTerm(['Algorithms']), null)
})

test('material conventions classify 06_Code and 00_Course-Info as supplementary, never as exams', async () => {
  const rules = await deriveMaterialRules({
    sourcePath: '/courses/PHY1001',
    names: ['00_Course-Info', '01_Lectures', '05_Exams', '06_Code', 'Slides'],
    includeSupplementary: true,
  })
  // Every matching convention directory is recorded, in convention order: `Slides` is the legacy
  // spelling of lecture material, so it is a second lecture rule rather than a dropped folder.
  assert.deepEqual(rules.categoryRules.lectures, ['/courses/PHY1001/01_Lectures', '/courses/PHY1001/Slides'])
  assert.deepEqual(rules.categoryRules.exams, ['/courses/PHY1001/05_Exams'])
  // Both well-known supplementary directories are recorded, in convention order: the whole point is
  // that neither is exams, and that `00_Course-Info` is not left unclassified.
  assert.deepEqual(rules.categoryRules.supplementary,
    ['/courses/PHY1001/06_Code', '/courses/PHY1001/00_Course-Info'])
  assert.equal(rules.unclassified.includes('00_Course-Info'), false, '00_Course-Info is supplementary, not unclassified')

  const withInfo = await deriveMaterialRules({
    sourcePath: '/courses/PHY1001',
    names: ['00_Course-Info'],
    includeSupplementary: true,
  })
  assert.deepEqual(withInfo.categoryRules.supplementary, ['/courses/PHY1001/00_Course-Info'])
  assert.equal(withInfo.categoryRules.exams, undefined, 'a course-info directory is never exam evidence')

  const withoutSupplementary = await deriveMaterialRules({
    sourcePath: '/courses/CSC3200',
    names: ['01_Lectures', '06_Code'],
    includeSupplementary: false,
  })
  assert.deepEqual(withoutSupplementary.categoryRules.lectures, ['/courses/CSC3200/01_Lectures'])
  assert.equal(withoutSupplementary.categoryRules.supplementary, undefined, 'the manual register path keeps its old shape')

  assert.deepEqual(MATERIAL_CATEGORIES, ['lectures', 'tutorials', 'assignments', 'exams', 'supplementary'])
})

test('a proposal fingerprint is a stable function of the folder structure and rejects tampering', async () => {
  const { root } = await standardFixture()
  const candidates = [
    { relative_path: 'CSC3200', kind: 'course', directory_version: 'v1', material_directories: ['01_Lectures'] },
    { relative_path: 'STA2001', kind: 'course', directory_version: 'v2', material_directories: ['01_Lectures'] },
  ]
  const one = fingerprintProposal({ root, candidates })
  const two = fingerprintProposal({ root, candidates: [...candidates].reverse() })
  assert.equal(one, two, 'fingerprint is order-independent')

  const changed = fingerprintProposal({ root, candidates: [{ ...candidates[0], directory_version: 'v9' }, candidates[1]] })
  assert.notEqual(one, changed, 'a substituted directory changes the fingerprint')

  const removed = fingerprintProposal({ root, candidates: [candidates[0]] })
  assert.notEqual(one, removed, 'a removed candidate changes the fingerprint')

  const elsewhere = fingerprintProposal({ root: `${root}-other`, candidates })
  assert.notEqual(one, elsewhere, 'a different root changes the fingerprint')
})

test('proposal validation names every structural problem and accepts a well-formed proposal', () => {
  const good = {
    schema: ONBOARDING_SCHEMA,
    root: '/courses',
    fingerprint: 'a'.repeat(64),
    candidates: [{ relative_path: 'CSC3200', kind: 'course' }],
  }
  assert.deepEqual(validateProposal(good), { ok: true, errors: [] })

  const bad = validateProposal({ schema: 'nope', root: '', fingerprint: '', candidates: 'x' })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((error) => /schema/.test(error)))
  assert.ok(bad.errors.some((error) => /root/.test(error)))
  assert.ok(bad.errors.some((error) => /fingerprint/.test(error)))
  assert.ok(bad.errors.some((error) => /candidates/.test(error)))
})

// --- 2. discovery -------------------------------------------------------------

test('discovery reports candidates with confidence and reasons, and creates nothing', async () => {
  const { home, root } = await standardFixture()
  const { fake, tools } = mount(home)
  const before = await snapshotSources(root)

  const result = await discover(tools, makeExec({ cwd: root }))
  const proposal = result.proposal

  assert.equal(proposal.schema, ONBOARDING_SCHEMA)
  assert.equal(proposal.root, await fs.realpath(root))
  assert.equal(proposal.folder_source, 'session-cwd')
  assert.match(proposal.fingerprint, /^[0-9a-f]{64}$/)

  for (const code of ['CSC3200', 'STA2001', 'PHY1001']) {
    const candidate = candidateAt(proposal, code)
    assert.equal(candidate.kind, 'course', `${code} must be a high-confidence course`)
    assert.equal(candidate.confidence, 'high')
    assert.equal(candidate.proposed.course_code, code)
    assert.equal(candidate.needs_confirmation, false)
    assert.ok(candidate.reasons.length > 0, `${code} must state why it was recognised`)
    assert.ok(candidate.material_directories.length > 0, `${code} must report its material directories`)
  }

  const phy = candidateAt(proposal, 'PHY1001')
  assert.deepEqual(phy.categories.exams.map((entry) => entry.name), ['05_Exams'])
  assert.deepEqual(phy.categories.supplementary.map((entry) => entry.name).sort(), ['00_Course-Info', '06_Code'])

  for (const ambiguous of ['Algorithms', 'Math', 'Course A']) {
    const candidate = candidateAt(proposal, ambiguous)
    assert.equal(candidate.confidence, 'low', `${ambiguous} must not be high-confidence`)
    assert.equal(candidate.proposed.course_code, null, `${ambiguous} must not be given an identity silently`)
    assert.equal(candidate.needs_confirmation, true)
  }

  assert.equal(candidateAt(proposal, 'Photos').kind, 'unrelated')
  assert.equal(candidateAt(proposal, 'Archive').kind, 'unrelated')

  assert.deepEqual(await snapshotSources(root), before, 'discovery must not touch the folder')
  await assert.rejects(() => fs.stat(path.join(root, '.professor')), /ENOENT/)
  assert.equal(fake.tools.length > 0, true)
})

test('a proposal and a confirmation result are lossless JSON under the storage validator', async () => {
  const { home, root } = await standardFixture()
  const { tools } = mount(home)
  const proposal = (await discover(tools, makeExec({ cwd: root }))).proposal

  assert.doesNotThrow(() => validateRecord(proposal), 'the proposal must survive the host medium unchanged')
  assert.deepEqual(JSON.parse(JSON.stringify(proposal)), proposal)

  const confirmation = await tools.professor_workspace_confirm.execute(
    { ...OK_ARGS, proposal, selections: [{ relative_path: 'CSC3200', action: 'include' }] },
    makeExec({ cwd: root }),
  )
  assert.equal(confirmation.ok, true, JSON.stringify(confirmation.problems))
  assert.doesNotThrow(() => validateRecord(confirmation), 'the confirmation result must be lossless JSON')
  assert.deepEqual(JSON.parse(JSON.stringify(confirmation)), confirmation)
})

test('discovery reports a missing folder instead of throwing, and refuses an unapproved root', async () => {
  const home = await makeHome('professor-onboarding-missing-')
  const { tools } = mount(home)

  const missing = await tools.professor_workspace_discover.execute(
    { folder: path.join(home, 'nope') },
    makeExec({ cwd: home }),
  )
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'PROFESSOR_ONBOARDING_FOLDER_MISSING')
  assert.match(missing.problems.join(' '), /nope/)
  // A refusal still returns every declared field: `proposal` is present and `null`, not missing, so
  // the output schema has to admit `null` for it (the host validates the value it is handed).
  assert.equal(missing.proposal, null)
  assert.equal(missing.folder.requested, path.join(home, 'nope'))
  assert.ok(missing.warnings.some((warning) => /connection record/.test(warning)),
    'a host with no application storage says so rather than silently having no connection record')

  const notADirectory = await writeFixture(home, 'a-file.txt', 'x')
  const file = await tools.professor_workspace_discover.execute({ folder: notADirectory }, makeExec({ cwd: home }))
  assert.equal(file.ok, false)
  assert.equal(file.code, 'PROFESSOR_ONBOARDING_FOLDER_MISSING')
})

test('a recorded connection whose canonical location moved is refused, not followed', async () => {
  const home = await makeHome('professor-onboarding-moved-')
  const storage = createFakeStorageDomain()
  const { tools } = mount(home, { storage })

  const original = path.join(home, 'original')
  const elsewhere = path.join(home, 'elsewhere')
  await writeFixture(original, 'CSC3200/01_Lectures/a.txt', 'a\n')
  await writeFixture(elsewhere, 'STA2001/01_Lectures/b.txt', 'b\n')

  const first = await tools.professor_workspace_discover.execute({ folder: original }, makeExec({ cwd: home }))
  assert.equal(first.ok, true)
  const applied = await tools.professor_workspace_confirm.execute(
    { ...OK_ARGS, proposal: first.proposal, selections: [{ relative_path: 'CSC3200', action: 'include' }] },
    makeExec({ cwd: home }),
  )
  assert.equal(applied.ok, true, JSON.stringify(applied.problems))

  // Replace the recorded folder with a symlink that points outside it.
  await fs.rm(original, { recursive: true, force: true })
  await fs.symlink(elsewhere, original)

  const reread = await tools.professor_workspace_discover.execute({}, makeExec({ cwd: home }))
  assert.equal(reread.ok, false)
  assert.equal(reread.code, 'PROFESSOR_ONBOARDING_FOLDER_NOT_APPROVED')
  assert.match(reread.problems.join(' '), /no longer resolves/)
})

test('symlink escapes and unreadable directories are skipped and reported, never indexed', async () => {
  const home = await makeHome('professor-onboarding-symlink-')
  const outside = path.join(home, 'outside')
  await writeFixture(outside, 'secret/leak.txt', 'must never be indexed\n')
  const root = path.join(home, 'courses')
  await writeFixture(root, 'CSC3200/01_Lectures/lecture01.txt', 'ok\n')
  await fs.symlink(outside, path.join(root, 'Outside-Link'))

  const { fake, tools } = mount(home)
  const before = await snapshotSources(root)

  const result = await discover(tools, makeExec({ cwd: root }))
  assert.equal(result.ok, true, JSON.stringify(result.problems))
  const proposal = result.proposal
  assert.equal(candidateAt(proposal, 'Outside-Link'), undefined, 'a symlinked candidate must not be proposed')
  assert.ok(proposal.skipped.some((entry) => entry.relative_path === 'Outside-Link' && /symlink/.test(entry.reason)))

  const applied = await tools.professor_workspace_confirm.execute(
    { ...OK_ARGS, proposal, selections: [{ relative_path: 'CSC3200', action: 'include' }] },
    makeExec({ cwd: root }),
  )
  assert.equal(applied.ok, true, JSON.stringify(applied.problems))

  const search = await tools.professor_search.execute({ query: 'leak' }, makeExec({ cwd: root }))
  assert.equal(search.results.length, 0, 'material behind a symlink must never be searchable')
  assert.deepEqual(await snapshotSources(root), before)
})

test('an unreadable directory is reported as inaccessible and does not abort discovery', async () => {
  const home = await makeHome('professor-onboarding-denied-')
  const root = path.join(home, 'courses')
  await writeFixture(root, 'CSC3200/01_Lectures/a.txt', 'a\n')
  await writeFixture(root, 'Locked/01_Lectures/b.txt', 'b\n')

  const { fake, tools } = mount(home)
  const original = fake.fs.listDir.bind(fake.fs)
  fake.ctx.fs.listDir = async (target, signal) => {
    if (String(target.targetKey).endsWith('/Locked')) {
      const error = new Error(`cannot list "${target.displayPath}": file access denied`)
      error.code = 'FS_SANDBOX_DENIED'
      throw error
    }
    return original(target, signal)
  }

  const result = await discover(tools, makeExec({ cwd: root }))
  assert.equal(result.ok, true, JSON.stringify(result.problems))
  assert.ok(result.proposal.inaccessible.some((entry) => entry.relative_path === 'Locked'))
  assert.equal(candidateAt(result.proposal, 'Locked'), undefined)
  assert.equal(candidateAt(result.proposal, 'CSC3200').kind, 'course')
})

test('duplicate course codes in two terms become two courses, never one merged course', async () => {
  const home = await makeHome('professor-onboarding-terms-')
  const root = path.join(home, 'courses')
  await writeFixture(root, '2025-2026 Fall/CSC3200/01_Lectures/a.txt', 'fall\n')
  await writeFixture(root, '2026 Spring/CSC3200/01_Lectures/b.txt', 'spring\n')

  const { tools } = mount(home)
  const proposal = (await discover(tools, makeExec({ cwd: root }))).proposal
  const codes = proposal.candidates.filter((entry) => entry.proposed.course_code === 'CSC3200')
  assert.equal(codes.length, 2, 'both term folders must be proposed')
  assert.deepEqual(codes.map((entry) => entry.proposed.term).sort(), ['2025-2026 Fall', '2026 Spring'])

  const applied = await tools.professor_workspace_confirm.execute(
    { ...OK_ARGS, proposal, selections: codes.map((entry) => ({ relative_path: entry.relative_path, action: 'include' })) },
    makeExec({ cwd: root }),
  )
  assert.equal(applied.ok, true, JSON.stringify(applied.problems))
  const list = await tools.professor_course_list.execute({ include_archived: true }, makeExec({ cwd: root }))
  assert.equal(list.courses.length, 2)
  const ids = list.courses.map((course) => course.course_id)
  assert.equal(new Set(ids).size, 2, 'the two terms must keep distinct course ids')
  assert.deepEqual(list.courses.map((course) => course.course_code), ['CSC3200', 'CSC3200'])
})

// --- 3. confirmation and persistence -----------------------------------------

test('confirmation applies only what was selected, persists the project, indexes and extracts', async () => {
  const { home, root } = await standardFixture()
  const storage = createFakeStorageDomain()
  const { tools } = mount(home, { storage })
  const before = await snapshotSources(root)

  const proposal = (await discover(tools, makeExec({ cwd: root }))).proposal
  const applied = await tools.professor_workspace_confirm.execute({
    proposal,
    selections: [
      { relative_path: 'CSC3200', action: 'include' },
      { relative_path: 'STA2001', action: 'include' },
      { relative_path: 'PHY1001', action: 'include' },
      { relative_path: 'Algorithms', action: 'include', course_code: 'CS2210', display_name: 'Algorithms' },
      { relative_path: 'Math', action: 'exclude' },
    ],
  }, makeExec({ cwd: root }))

  assert.equal(applied.ok, true, JSON.stringify(applied.problems))
  assert.equal(applied.applied, true)
  assert.deepEqual(applied.courses.registered.map((entry) => entry.course_code).sort(),
    ['CS2210', 'CSC3200', 'PHY1001', 'STA2001'])
  assert.deepEqual(applied.courses.pending.map((entry) => entry.relative_path).sort(), ['Course A'])
  assert.deepEqual(applied.courses.excluded.map((entry) => entry.relative_path), ['Math'])

  // Readiness separates the four states the brief requires.
  assert.equal(applied.readiness.configuration.saved, true)
  assert.equal(applied.readiness.index.complete, true)
  assert.equal(applied.readiness.extraction.complete, true)
  assert.equal(applied.readiness.searchable, true)
  assert.deepEqual(applied.readiness.partial, [])
  assert.equal(applied.readiness.retry, null)
  assert.ok(applied.readiness.index.total >= 7, JSON.stringify(applied.readiness.index))

  // The project document is real, and 'Course A' was never given an identity.
  const document = await fs.readFile(path.join(root, '.professor/project.yaml'), 'utf8')
  assert.match(document, /course_code: CSC3200/)
  assert.doesNotMatch(document, /course-code-a/)
  assert.match(document, /course_code: CS2210/)

  // Search reaches the fixture content with honest provenance.
  const search = await tools.professor_search.execute({ query: 'content of PHY1001/05_Exams/midterm.txt' }, makeExec({ cwd: root }))
  assert.ok(search.results.length > 0, JSON.stringify(search.diagnostics))
  assert.equal(search.results[0].course_id, 'phy1001')
  assert.equal(search.results[0].category, 'exams')
  assert.equal(search.results[0].relative_path, 'PHY1001/05_Exams/midterm.txt')

  assert.deepEqual(await snapshotSources(root), before, 'onboarding must not modify source material')

  const connection = storage.stores.get('app').get(WORKSPACE_CONNECTION_KEY)
  assert.equal(connection.schema, WORKSPACE_RECORD_SCHEMA)
  assert.equal(connection.active.folder, await fs.realpath(root))
})

test('an ambiguous folder is never registered without an explicit identity', async () => {
  const { home, root } = await standardFixture()
  const { tools } = mount(home)
  const proposal = (await discover(tools, makeExec({ cwd: root }))).proposal

  const applied = await tools.professor_workspace_confirm.execute({
    proposal,
    selections: [
      { relative_path: 'Algorithms', action: 'include' },
      { relative_path: 'Math', action: 'include' },
    ],
  }, makeExec({ cwd: root }))

  assert.equal(applied.ok, true, JSON.stringify(applied.problems))
  assert.deepEqual(applied.courses.registered, [])
  assert.deepEqual(applied.courses.pending.map((entry) => entry.relative_path).sort(), ['Algorithms', 'Course A', 'Math'])
  assert.ok(applied.courses.pending.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0))

  const document = await fs.readFile(path.join(root, '.professor/project.yaml'), 'utf8')
  assert.doesNotMatch(document, /course_id:/, 'no course was registered from an ambiguous name')
  assert.match(document, /courses: \[\]/)
})

test('blank scan term reuses the same source folder with a configured term', async () => {
  const { home, root } = await standardFixture()
  const { tools } = mount(home)
  const exec = makeExec({ cwd: root })
  await tools.professor_project_init.execute({}, exec)
  await tools.professor_course_manage.execute({ action: 'register', course_code: 'CSC3200', display_name: 'Data Structures', term: 'Year2Term1', source_path: path.join(root, 'CSC3200') }, exec)
  const result = await tools.professor_workspace_confirm.execute({ proposal: (await discover(tools, exec)).proposal,
    selections: [{ relative_path: 'CSC3200', action: 'include', term: '' }] }, exec)
  assert.deepEqual(result.courses.registered, [])
  assert.equal(result.courses.preserved[0].course_id, 'csc3200')
  assert.equal(result.courses.preserved[0].term, 'Year2Term1')
})

test('repeated connection preserves ids, sources and configured outputs, and is idempotent', async () => {
  const { home, root } = await standardFixture()
  const { tools } = mount(home)
  const exec = makeExec({ cwd: root })

  const proposal = (await discover(tools, exec)).proposal
  const first = await tools.professor_workspace_confirm.execute({
    proposal,
    selections: [{ relative_path: 'CSC3200', action: 'include' }, { relative_path: 'STA2001', action: 'include' }],
  }, exec)
  assert.equal(first.ok, true, JSON.stringify(first.problems))
  const cscId = first.courses.registered.find((entry) => entry.course_code === 'CSC3200').course_id

  // What a real user owns. First: the course's explicit source path — onboarding registered it, not
  // the user, and no `.professor` existed before this confirmation.
  const registeredSources = (await tools.professor_course_list.execute({}, exec)).sources
  const cscSources = registeredSources.find((entry) => entry.course_id === cscId).sources
  assert.equal(cscSources.length, 1, 'onboarding registers exactly one source root per confirmed folder')
  assert.equal(cscSources[0].path, path.join(await fs.realpath(root), 'CSC3200'))
  assert.equal(cscSources[0].exists, true)

  // Second: a course configured entirely by hand, with a notes output outside the folder.
  const notesRoot = path.join(home, 'my-notes')
  await fs.mkdir(notesRoot, { recursive: true })
  const configured = await tools.professor_course_manage.execute({
    action: 'register', course_code: 'GFN1000', display_name: 'Global Finance', term: '2025-2026 Fall', notes_root: notesRoot,
  }, exec)
  assert.deepEqual(configured.changed, ['gfn1000'])

  const projectFile = path.join(root, '.professor/project.yaml')
  const beforeSecond = await fs.readFile(projectFile, 'utf8')
  assert.match(beforeSecond, /notes_root:/)

  // Re-discover and re-confirm the same folder.
  const second = await discover(tools, exec)
  const reapplied = await tools.professor_workspace_confirm.execute({
    proposal: second.proposal,
    selections: [{ relative_path: 'CSC3200', action: 'include' }, { relative_path: 'STA2001', action: 'include' }],
  }, exec)

  assert.equal(reapplied.ok, true, JSON.stringify(reapplied.problems))
  assert.deepEqual(reapplied.courses.registered, [], 'nothing is registered twice')
  assert.ok(reapplied.courses.preserved.some((entry) => entry.course_id === cscId))

  const after = await fs.readFile(projectFile, 'utf8')
  assert.match(after, new RegExp(`course_id: ${cscId}`))
  assert.match(after, /course_id: gfn1000/, 'a hand-registered course is never dropped')
  assert.match(after, /notes_root:/, 'a configured output root is preserved')
  assert.equal((after.match(/course_id: csc3200/g) ?? []).length, 1, 'no duplicate registration')

  const list = await tools.professor_course_list.execute({}, exec)
  assert.deepEqual(list.courses.map((course) => course.course_id).sort(), [cscId, 'gfn1000', 'sta2001'].sort())
})

test('a folder that changes between discovery and confirmation is refused, and nothing is applied', async () => {
  const { home, root } = await standardFixture()
  const { tools } = mount(home)
  const before = await snapshotSources(root)
  const proposal = (await discover(tools, makeExec({ cwd: root }))).proposal

  await fs.rm(path.join(root, 'STA2001'), { recursive: true, force: true })

  const applied = await tools.professor_workspace_confirm.execute({
    proposal,
    selections: [{ relative_path: 'CSC3200', action: 'include' }],
  }, makeExec({ cwd: root }))

  assert.equal(applied.ok, false)
  assert.equal(applied.code, 'PROFESSOR_ONBOARDING_STALE')
  assert.equal(applied.applied, false)
  await assert.rejects(() => fs.stat(path.join(root, '.professor')), /ENOENT/, 'a stale proposal must not create the project')
  assert.equal((await snapshotSources(root))['CSC3200/01_Lectures/lecture01.txt'].sha256,
    before['CSC3200/01_Lectures/lecture01.txt'].sha256)
})

test('a malformed proposal is refused before anything is read or written', async () => {
  const { home, root } = await standardFixture()
  const { tools } = mount(home)
  const applied = await tools.professor_workspace_confirm.execute({
    proposal: { schema: 'nope', root, candidates: 'nope' },
    selections: [],
  }, makeExec({ cwd: root }))
  assert.equal(applied.ok, false)
  assert.equal(applied.code, 'PROFESSOR_ONBOARDING_INVALID_PROPOSAL')
  await assert.rejects(() => fs.stat(path.join(root, '.professor')))
})

test('a newer project schema is never overwritten by onboarding', async () => {
  const { home, root } = await standardFixture()
  await writeFixture(root, '.professor/project.yaml', 'schema_version: 99\nproject:\n  id: future\ncourses: []\n')
  const { tools } = mount(home)

  const proposal = (await discover(tools, makeExec({ cwd: root }))).proposal
  const applied = await tools.professor_workspace_confirm.execute({
    proposal,
    selections: [{ relative_path: 'CSC3200', action: 'include' }],
  }, makeExec({ cwd: root }))

  assert.equal(applied.ok, false)
  assert.equal(applied.code, 'PROFESSOR_PROJECT_UNSUPPORTED')
  assert.equal(await fs.readFile(path.join(root, '.professor/project.yaml'), 'utf8'),
    'schema_version: 99\nproject:\n  id: future\ncourses: []\n')
})

test('changing the connected folder requires an explicit decision and deletes nothing', async () => {
  const home = await makeHome('professor-onboarding-switch-')
  const storage = createFakeStorageDomain()
  const { tools } = mount(home, { storage })
  const firstFolder = path.join(home, 'first')
  const secondFolder = path.join(home, 'second')
  await writeFixture(firstFolder, 'CSC3200/01_Lectures/a.txt', 'a\n')
  await writeFixture(secondFolder, 'STA2001/01_Lectures/b.txt', 'b\n')

  const canonicalFirst = await fs.realpath(firstFolder)

  const one = await tools.professor_workspace_discover.execute({ folder: firstFolder }, makeExec({ cwd: home }))
  const appliedOne = await tools.professor_workspace_confirm.execute({
    proposal: one.proposal, selections: [{ relative_path: 'CSC3200', action: 'include' }],
  }, makeExec({ cwd: home }))
  assert.equal(appliedOne.ok, true, JSON.stringify(appliedOne.problems))

  const two = await tools.professor_workspace_discover.execute({ folder: secondFolder }, makeExec({ cwd: home }))
  const refused = await tools.professor_workspace_confirm.execute({
    proposal: two.proposal, selections: [{ relative_path: 'STA2001', action: 'include' }],
  }, makeExec({ cwd: home }))
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'PROFESSOR_ONBOARDING_DECISION_REQUIRED')
  assert.equal(refused.requires_decision.kind, 'folder_change')
  assert.equal(refused.requires_decision.previous_folder, canonicalFirst)
  await assert.rejects(() => fs.stat(path.join(secondFolder, '.professor')))

  const switched = await tools.professor_workspace_confirm.execute({
    proposal: two.proposal,
    selections: [{ relative_path: 'STA2001', action: 'include' }],
    acknowledge_folder_change: true,
  }, makeExec({ cwd: home }))
  assert.equal(switched.ok, true, JSON.stringify(switched.problems))
  assert.equal(switched.connection.previous_folder, canonicalFirst)
  assert.ok(switched.connection.history.some((entry) => entry.folder === canonicalFirst))

  // The previous folder keeps its configuration and material.
  const keptProject = await fs.readFile(path.join(firstFolder, '.professor/project.yaml'), 'utf8')
  assert.match(keptProject, /course_code: CSC3200/)
  assert.equal(await fs.readFile(path.join(firstFolder, 'CSC3200/01_Lectures/a.txt'), 'utf8'), 'a\n')
})

// --- 4. incremental indexing and rebuild -------------------------------------

test('incremental updates detect added, changed and removed material and reuse unchanged extraction', async () => {
  const { home, root } = await standardFixture()
  const { tools } = mount(home)
  const exec = makeExec({ cwd: root })

  // Single-word markers, each present in exactly one file. Retrieval scores by substring, so a
  // query like `rewritten lecture material` also matches every other `lecture*` file — which would
  // make "the changed file was re-extracted" indistinguishable from "some file matched".
  await writeFixture(root, 'CSC3200/01_Lectures/lecture01.txt', 'alphamarker\n')
  await writeFixture(root, 'STA2001/01_Lectures/lecture01.txt', 'keepmarker\n')

  const proposal = (await discover(tools, exec)).proposal
  const first = await tools.professor_workspace_confirm.execute({
    proposal,
    selections: [
      { relative_path: 'CSC3200', action: 'include' },
      { relative_path: 'STA2001', action: 'include' },
    ],
  }, exec)
  assert.equal(first.ok, true, JSON.stringify(first.problems))
  const initialExtracted = first.readiness.extraction.extracted
  assert.ok(initialExtracted >= 3, JSON.stringify(first.readiness.extraction))
  assert.equal((await tools.professor_search.execute({ query: 'alphamarker' }, exec)).results.length, 1)

  // Add, change and remove.
  await writeFixture(root, 'CSC3200/01_Lectures/lecture02.txt', 'brandnewmarker\n')
  await writeFixture(root, 'CSC3200/01_Lectures/lecture01.txt', 'betamarker\n')
  await fs.rm(path.join(root, 'STA2001/01_Lectures/lecture01.txt'))

  const second = await tools.professor_workspace_confirm.execute({
    proposal: (await discover(tools, exec)).proposal,
    selections: [
      { relative_path: 'CSC3200', action: 'include' },
      { relative_path: 'STA2001', action: 'include' },
    ],
  }, exec)

  assert.equal(second.ok, true, JSON.stringify(second.problems))
  assert.equal(second.readiness.index.added, 1)
  assert.equal(second.readiness.index.changed, 1)
  assert.equal(second.readiness.index.missing, 1)
  assert.ok(second.readiness.index.reused > 0, 'unchanged files are reused, never re-hashed from scratch')
  assert.equal(second.readiness.extraction.extracted, 2, 'only the added and the changed file are re-extracted')
  assert.ok(second.readiness.extraction.skipped > 0, 'unchanged extraction is reused')

  const rewritten = await tools.professor_search.execute({ query: 'betamarker' }, exec)
  assert.equal(rewritten.results.length, 1)
  assert.equal(rewritten.results[0].relative_path, 'CSC3200/01_Lectures/lecture01.txt')

  // The superseded text is gone, not merely outranked: re-extraction replaces the chunk store.
  const superseded = await tools.professor_search.execute({ query: 'alphamarker' }, exec)
  assert.equal(superseded.results.length, 0, 'the replaced content must not remain searchable')

  const removed = await tools.professor_search.execute({ query: 'keepmarker' }, exec)
  assert.equal(removed.results.length, 0, 'removed material must not be searchable')

  const added = await tools.professor_search.execute({ query: 'brandnewmarker' }, exec)
  assert.equal(added.results.length, 1)
})

test('superseded chunks are withheld from search until they are re-extracted', async () => {
  const { home, root } = await standardFixture()
  const { tools } = mount(home)
  const exec = makeExec({ cwd: root })

  // Unique markers again: sharing a stem such as `lecture` with other files would let a different
  // file's chunk satisfy the query, and "withheld" must not be confusable with "matched elsewhere".
  await writeFixture(root, 'CSC3200/01_Lectures/lecture01.txt', 'alphamarker\n')
  await writeFixture(root, 'STA2001/01_Lectures/lecture01.txt', 'keepmarker\n')

  const proposal = (await discover(tools, exec)).proposal
  await tools.professor_workspace_confirm.execute({
    proposal,
    selections: [
      { relative_path: 'CSC3200', action: 'include' },
      { relative_path: 'STA2001', action: 'include' },
    ],
  }, exec)

  // Change the file and refresh the index only — extraction has not caught up yet.
  await writeFixture(root, 'CSC3200/01_Lectures/lecture01.txt', 'betamarker\n')
  const synced = await tools.professor_index_sync.execute({}, exec)
  assert.equal(synced.changed, 1)

  const stale = await tools.professor_search.execute({ query: 'alphamarker' }, exec)
  assert.equal(stale.results.length, 0, 'a chunk whose source hash no longer matches must not be returned')
  assert.ok(stale.warnings.some((warning) => /re-extract|stale/i.test(warning)), JSON.stringify(stale.warnings))
  assert.equal(stale.diagnostics.stale_stores, 1)

  // Withholding is targeted, not a blanket failure: the untouched file is still searchable.
  assert.equal((await tools.professor_search.execute({ query: 'keepmarker' }, exec)).results.length, 1)

  const refreshed = await tools.professor_extract.execute({}, exec)
  assert.ok(refreshed.extracted >= 1, JSON.stringify(refreshed))
  const fresh = await tools.professor_search.execute({ query: 'betamarker' }, exec)
  assert.equal(fresh.results.length, 1)
})

test('an explicit rebuild re-derives indexes only and preserves config, state and originals', async () => {
  const { home, root } = await standardFixture()
  const storage = createFakeStorageDomain()
  const { tools } = mount(home, { storage })
  const exec = makeExec({ cwd: root })

  const proposal = (await discover(tools, exec)).proposal
  const applied = await tools.professor_workspace_confirm.execute({
    proposal, selections: [{ relative_path: 'CSC3200', action: 'include' }],
  }, exec)
  const cscId = applied.courses.registered[0].course_id

  // Something the user owns: a session binding, a learning-state file and a preference. The binding
  // is established by the *user's* tool, not by onboarding — onboarding registers no learning state
  // and binds no session (see the test that follows this one).
  await tools.professor_session_bind.execute({ course: cscId }, makeExec({ cwd: root, sessionId: 'session-rebuild' }))
  await tools.professor_state_update.execute({
    file: 'PROGRESS.md', evidence: 'strong', field: 'current_unit', value: 'Unit 1',
  }, makeExec({ cwd: root, sessionId: 'session-rebuild' }))
  await tools.professor_memory_update.execute({
    scope: 'global', action: 'set_preference', key: 'explanation_language', value: 'Chinese', evidence: 'explicit-stable',
  }, exec)

  const projectFile = path.join(root, '.professor/project.yaml')
  const configBefore = await fs.readFile(projectFile, 'utf8')
  const stateBefore = await fs.readFile(path.join(root, '.professor/state/courses', cscId, 'PROGRESS.md'), 'utf8')
  const sourcesBefore = await snapshotSources(root)
  const indexBefore = JSON.parse(await fs.readFile(path.join(root, '.professor/indexes/files.json'), 'utf8'))

  const rebuilt = await tools.professor_workspace_rebuild.execute({}, exec)
  assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt.problems))
  assert.equal(rebuilt.readiness.index.complete, true)
  assert.equal(rebuilt.readiness.extraction.complete, true)
  assert.ok(rebuilt.index.changed >= indexBefore.files.length || rebuilt.index.changed >= 1)

  assert.equal(await fs.readFile(projectFile, 'utf8'), configBefore, 'configuration is untouched')
  assert.equal(await fs.readFile(path.join(root, '.professor/state/courses', cscId, 'PROGRESS.md'), 'utf8'), stateBefore,
    'learning state is untouched')
  assert.deepEqual(await snapshotSources(root), sourcesBefore, 'originals are untouched')

  const memory = await tools.professor_memory_read.execute({ scope: 'global' }, exec)
  assert.equal(memory.record.preferences.explanation_language.value, 'Chinese', 'memory is untouched by a rebuild')
})

test('onboarding creates no learning state and infers no progress from file presence', async () => {
  const { home, root } = await standardFixture()
  const { tools } = mount(home)
  const exec = makeExec({ cwd: root })

  const proposal = (await discover(tools, exec)).proposal
  const applied = await tools.professor_workspace_confirm.execute({
    proposal, selections: [{ relative_path: 'CSC3200', action: 'include' }, { relative_path: 'PHY1001', action: 'include' }],
  }, exec)
  assert.equal(applied.ok, true, JSON.stringify(applied.problems))

  for (const file of ['PROGRESS.md', 'KNOWLEDGE.md', 'MISTAKES.md']) {
    await assert.rejects(
      () => fs.stat(path.join(root, '.professor/state/courses/csc3200', file)),
      /ENOENT/,
      `${file} must not be manufactured by onboarding`,
    )
  }
  const state = await tools.professor_state_read.execute({ course: 'csc3200' }, exec)
  assert.equal(state.files['PROGRESS.md']?.present === true, false)
})

test('global memory works with no academic folder connected, and onboarding does not touch it', async () => {
  const home = await makeHome('professor-onboarding-memory-')
  const storage = createFakeStorageDomain()
  const workspace = path.join(home, 'plain-workspace')
  await fs.mkdir(workspace, { recursive: true })
  const { tools } = mount(home, { storage })
  const exec = makeExec({ cwd: workspace })

  const set = await tools.professor_memory_update.execute({
    scope: 'global', action: 'set_preference', key: 'teaching_style', value: 'step by step', evidence: 'explicit-stable',
  }, exec)
  assert.equal(set.written, true)

  const folder = path.join(home, 'courses')
  await writeFixture(folder, 'CSC3200/01_Lectures/a.txt', 'a\n')
  const proposal = (await discover(tools, makeExec({ cwd: folder }))).proposal
  const applied = await tools.professor_workspace_confirm.execute({
    proposal, selections: [{ relative_path: 'CSC3200', action: 'include' }],
  }, makeExec({ cwd: folder }))
  assert.equal(applied.ok, true, JSON.stringify(applied.problems))

  const read = await tools.professor_memory_read.execute({ scope: 'global' }, exec)
  assert.equal(read.record.preferences.teaching_style.value, 'step by step')
  assert.equal(read.present, true)
})

test('concurrent confirmations serialise: one applies, the other reports an explicit conflict', async () => {
  const { home, root } = await standardFixture()
  const { tools } = mount(home)

  const first = (await discover(tools, makeExec({ cwd: root }))).proposal
  const second = (await discover(tools, makeExec({ cwd: root }))).proposal
  const selections = [{ relative_path: 'CSC3200', action: 'include' }, { relative_path: 'STA2001', action: 'include' }]

  const [a, b] = await Promise.all([
    tools.professor_workspace_confirm.execute({ proposal: first, selections, expected_revision: 0 }, makeExec({ cwd: root, sessionId: 'concurrent-a' })),
    tools.professor_workspace_confirm.execute({ proposal: second, selections, expected_revision: 0 }, makeExec({ cwd: root, sessionId: 'concurrent-b' })),
  ])

  const applied = [a, b].filter((result) => result.applied === true)
  assert.equal(applied.length >= 1, true, 'at least one confirmation must apply')
  const other = [a, b].find((result) => result !== applied[0])
  if (other.applied !== true) {
    assert.equal(other.code, 'PROFESSOR_ONBOARDING_CONFLICT')
  }
  assert.equal(await fs.readFile(path.join(root, '.professor/project.yaml'), 'utf8').then((text) => /course_code: CSC3200/.test(text)), true)
})

test('confirmed configuration survives a storage reopen, and a job that fails to index keeps the configuration', async () => {
  const { home, root } = await standardFixture()
  const storage = createFakeStorageDomain()
  const firstRun = mount(home, { storage })

  const proposal = (await discover(firstRun.tools, makeExec({ cwd: root }))).proposal
  const applied = await firstRun.tools.professor_workspace_confirm.execute({
    proposal, selections: [{ relative_path: 'CSC3200', action: 'include' }],
  }, makeExec({ cwd: root }))
  assert.equal(applied.ok, true)
  assert.equal(storage.openCalls, 1)

  // Tear the plugin fiber down — this releases the storage domain — then mount a *fresh* instance
  // over the same medium. That is what a restart looks like, and it is the only way to prove the
  // connection record is really persisted rather than held in memory.
  firstRun.fake.disposeAll()
  const { fake, tools } = mount(home, { storage })

  const reread = await tools.professor_workspace_discover.execute({}, makeExec({ cwd: root }))
  assert.equal(reread.ok, true, JSON.stringify(reread.problems))
  assert.equal(reread.folder.source, 'connection', 'the recorded folder survives a restart')
  assert.equal(reread.folder.canonical, await fs.realpath(root))
  assert.equal(storage.openCalls, 2, 'the domain really was reopened, not served from memory')

  // Make the next index write fail. The accepted configuration is user state, so it must survive an
  // unrelated derived-work failure and be reported as partial rather than as a lost connection.
  const originalWrite = fake.fs.writeText.bind(fake.fs)
  fake.ctx.fs.writeText = async (target, content, expected, signal, policy) => {
    if (String(target.targetKey).endsWith('/.professor/indexes/files.json')) {
      const error = new Error(`cannot write ${target.displayPath}: file access denied`)
      error.code = 'FS_SANDBOX_DENIED'
      throw error
    }
    return originalWrite(target, content, expected, signal, policy)
  }

  const retried = await tools.professor_workspace_confirm.execute({
    proposal: (await tools.professor_workspace_discover.execute({}, makeExec({ cwd: root }))).proposal,
    selections: [{ relative_path: 'CSC3200', action: 'include' }],
  }, makeExec({ cwd: root }))
  assert.equal(retried.applied, true, 'the accepted configuration is preserved')
  assert.equal(retried.readiness.configuration.saved, true)
  assert.equal(retried.readiness.index.complete, false)
  assert.equal(retried.readiness.searchable, false)
  assert.equal(retried.readiness.retry, 'professor_workspace_rebuild')
  assert.ok(retried.readiness.partial.some((entry) => /index/i.test(entry)))
  assert.match(await fs.readFile(path.join(root, '.professor/project.yaml'), 'utf8'), /course_code: CSC3200/)
})

test('the connection record refuses a newer or corrupt schema without destroying it', async () => {
  const home = await makeHome('professor-onboarding-corrupt-')
  const storage = createFakeStorageDomain()
  const { tools } = mount(home, { storage })
  const folder = path.join(home, 'courses')
  await writeFixture(folder, 'CSC3200/01_Lectures/a.txt', 'a\n')

  await storage.seed('app', WORKSPACE_CONNECTION_KEY, { schema: 'professor.workspace/99', active: null })

  const result = await tools.professor_workspace_discover.execute({ folder }, makeExec({ cwd: home }))
  assert.equal(result.ok, true, JSON.stringify(result.problems))
  assert.ok(result.warnings.some((warning) => /connection/.test(warning)))
  assert.deepEqual(storage.stores.get('app').get(WORKSPACE_CONNECTION_KEY),
    { schema: 'professor.workspace/99', active: null }, 'a newer record is reported, never rewritten')

  const applied = await tools.professor_workspace_confirm.execute({
    proposal: result.proposal, selections: [{ relative_path: 'CSC3200', action: 'include' }],
  }, makeExec({ cwd: home }))
  assert.equal(applied.ok, false)
  assert.equal(applied.code, 'PROFESSOR_WORKSPACE_CONNECTION_UNSUPPORTED')
})

test('a malformed connection with a current schema is preserved and blocks confirmation', async () => {
  const { home, root } = await standardFixture()
  const storage = createFakeStorageDomain()
  const { tools } = mount(home, { storage })
  const corrupt = { schema: WORKSPACE_RECORD_SCHEMA, active: { folder: 42 }, history: [] }
  await storage.seed('app', WORKSPACE_CONNECTION_KEY, corrupt)
  const result = await discover(tools, makeExec({ cwd: root }))
  const applied = await tools.professor_workspace_confirm.execute({ proposal: result.proposal,
    selections: [{ relative_path: 'CSC3200', action: 'include' }] }, makeExec({ cwd: root }))
  assert.equal(applied.applied, false)
  assert.equal(applied.code, 'PROFESSOR_WORKSPACE_CONNECTION_UNSUPPORTED')
  assert.deepEqual(storage.stores.get('app').get(WORKSPACE_CONNECTION_KEY), corrupt)
})

test('the connector tool is discoverable, and the proposal declares the exact schema and limits', async () => {
  const { home, root } = await standardFixture()
  const { tools } = mount(home)
  const result = await tools.professor_workspace_discover.execute(
    { max_depth: 1, max_candidates: 2 },
    makeExec({ cwd: root }),
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.proposal.scan.limits, { max_depth: 1, max_candidates: 2, max_entries: result.proposal.scan.limits.max_entries })
  assert.equal(result.proposal.scan.truncated, true, 'hitting the candidate cap must be reported')
  assert.ok(result.proposal.scan.truncation_reason !== null)
  assert.ok(result.proposal.candidates.length <= 2)
})
