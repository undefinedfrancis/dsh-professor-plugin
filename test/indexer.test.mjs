/**
 * Indexer and tool-level end-to-end tests.
 *
 * Covers the §11 "Indexing" and "Project and course registry"-adjacent categories that exist in
 * this milestone: first scan, unchanged rescan, modified/added/moved/deleted files, hidden and
 * operational exclusions, determinism, symlink policy, unsupported schema versions, and the
 * guarantee that original material is byte-for-byte unchanged.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply } from '../src/plugin.js'
import { FILE_INDEX_SCHEMA_VERSION, fileIdFor } from '../src/indexer/index.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

const MATERIAL = [
  '01_Lectures/lecture-01.pdf',
  '01_Lectures/lecture-02.pptx',
  '03_Assignments/hw1.md',
]

async function projectFixture() {
  const home = await makeHome('professor-project-')
  const project = path.join(home, 'courses', 'term')
  for (const relative of MATERIAL) await writeFixture(home, path.join('courses/term', relative), `content of ${relative}`)
  await writeFixture(home, 'courses/term/.hidden/secret.md', 'hidden')
  await writeFixture(home, 'courses/term/node_modules/pkg/index.js', 'dependency')
  await writeFixture(home, 'courses/term/.professor/state/sessions/old.json', '{"legacy":true}')
  return { home, project }
}

function toolsByName(fake) {
  return Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
}

async function booted(fixture) {
  const fake = createFakeContext({ home: fixture.home })
  apply(fake.ctx, fake.pluginConfig)
  return { fake, tools: toolsByName(fake), exec: makeExec({ cwd: fixture.project }) }
}

async function readIndex(project) {
  return JSON.parse(await fs.readFile(path.join(project, '.professor/indexes/files.json'), 'utf8'))
}

async function hashTree(root) {
  const digest = createHash('sha256')
  const walk = async (current) => {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const target = path.join(current, entry.name)
      const relative = path.relative(root, target)
      if (entry.isDirectory()) {
        if (relative.startsWith('.professor')) continue
        await walk(target)
        continue
      }
      digest.update(relative).update(await fs.readFile(target))
    }
  }
  await walk(root)
  return digest.digest('hex')
}

test('the plugin registers the reduced, non-duplicated tool surface', async () => {
  const fixture = await projectFixture()
  const { fake, tools } = await booted(fixture)

  // 12 tools through M10, plus the M11 artifact/latex trio, the M2 memory trio, the Phase 3
  // onboarding trio and the bounded material reader. Every name is unique and namespaced; no read
  // tool shares a name with a write tool.
  assert.deepEqual(Object.keys(tools).sort(), [
    'professor_artifact_create', 'professor_artifact_status',
    'professor_course_list', 'professor_course_manage', 'professor_diagnostics',
    'professor_extract', 'professor_index_sync', 'professor_latex_compile',
    'professor_material_read', 'professor_memory_read', 'professor_memory_status',
    'professor_memory_update',
    'professor_paths', 'professor_project_init', 'professor_search',
    'professor_session_bind', 'professor_session_status',
    'professor_state_read', 'professor_state_update',
    'professor_workspace_confirm', 'professor_workspace_discover', 'professor_workspace_rebuild',
  ])
  assert.equal(new Set(Object.keys(tools)).size, Object.keys(tools).length, 'no duplicate tool name')
  assert.equal(fake.providers.length, 1, 'exactly one skill provider is registered')
  for (const tool of Object.values(tools)) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.name.startsWith('professor_'), true, `${tool.name} must be namespaced`)
  }
})

test('the index tool accepts no free-form root parameter', async () => {
  const fixture = await projectFixture()
  const { tools } = await booted(fixture)
  const parameters = tools.professor_index_sync.parameters
  assert.equal(Object.hasOwn(parameters.properties ?? {}, 'root'), false)
  assert.deepEqual(Object.keys(parameters.properties ?? {}).sort(), ['force', 'rebuild'])
})

test('an oversized archive is reported as skipped without blocking other course files', async () => {
  const fixture = await projectFixture()
  await writeFixture(fixture.home, 'courses/term/large.zip', '')
  await fs.truncate(path.join(fixture.project, 'large.zip'), 46 * 1024 * 1024)
  const { tools, exec } = await booted(fixture)
  const result = await tools.professor_index_sync.execute({}, exec)
  assert.equal(result.total, MATERIAL.length)
  assert.ok(result.skipped >= 1)
  assert.equal((await fs.stat(path.join(fixture.project, 'large.zip'))).size, 46 * 1024 * 1024)
})

test('first sync indexes sources, excludes operational paths, and leaves material unchanged', async () => {
  const fixture = await projectFixture()
  const before = await hashTree(fixture.project)
  const { tools, exec } = await booted(fixture)

  const result = await tools.professor_index_sync.execute({}, exec)
  assert.equal(result.schemaVersion, FILE_INDEX_SCHEMA_VERSION)
  assert.equal(result.total, MATERIAL.length)
  assert.equal(result.added, MATERIAL.length)
  assert.equal(result.missing, 0)

  const index = await readIndex(fixture.project)
  assert.deepEqual(index.files.map((file) => file.relative_path), [...MATERIAL].sort())
  for (const file of index.files) {
    assert.equal(file.file_id, fileIdFor(file.relative_path))
    assert.equal(file.course_id, null)
    assert.equal(file.category, 'unassigned')
    assert.equal(file.index_status, 'indexed')
    assert.match(file.content_hash, /^[0-9a-f]{64}$/)
    assert.equal(file.mtime, null, 'the fs seam exposes a version, not an mtime')
    assert.equal(typeof file.fs_version, 'string')
  }
  assert.equal(await hashTree(fixture.project), before, 'source material must be byte-identical')
})

test('a second sync reuses unchanged records and detects change, move and deletion', async () => {
  const fixture = await projectFixture()
  const { tools, exec } = await booted(fixture)
  await tools.professor_index_sync.execute({}, exec)

  const second = await tools.professor_index_sync.execute({}, exec)
  assert.equal(second.reused, MATERIAL.length)
  assert.equal(second.changed, 0)
  assert.equal(second.added, 0)

  const indexBefore = await readIndex(fixture.project)
  const lectureHash = indexBefore.files.find((file) => file.relative_path === MATERIAL[0]).content_hash

  await writeFixture(fixture.home, 'courses/term/01_Lectures/lecture-01.pdf', 'content of 01_Lectures/lecture-01.pdf (revised, longer)')
  await writeFixture(fixture.home, 'courses/term/02_Tutorials/tutorial-01.md', 'new tutorial')
  await fs.rename(
    path.join(fixture.project, '03_Assignments', 'hw1.md'),
    path.join(fixture.project, '03_Assignments', 'hw1-renamed.md'),
  )

  const third = await tools.professor_index_sync.execute({}, exec)
  assert.equal(third.changed, 1, 'the revised lecture is re-hashed')
  assert.equal(third.added, 2, 'the tutorial and the renamed file are new ids')
  assert.equal(third.missing, 1, 'the old path is kept as missing')

  const index = await readIndex(fixture.project)
  const revised = index.files.find((file) => file.relative_path === MATERIAL[0])
  assert.notEqual(revised.content_hash, lectureHash)

  const missing = index.files.find((file) => file.relative_path === '03_Assignments/hw1.md')
  assert.equal(missing.index_status, 'missing')
  assert.ok(missing.errors.some((message) => /not found/.test(message)))
})

test('symlinks are not followed out of the project', async () => {
  const fixture = await projectFixture()
  const outside = path.join(fixture.home, 'outside')
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(outside, 'secret.md'), 'outside material')
  await fs.symlink(outside, path.join(fixture.project, 'linked-dir'))
  await fs.symlink(path.join(outside, 'secret.md'), path.join(fixture.project, 'linked-file.md'))

  const { tools, exec } = await booted(fixture)
  const result = await tools.professor_index_sync.execute({}, exec)

  const index = await readIndex(fixture.project)
  const paths = index.files.map((file) => file.relative_path)
  assert.equal(paths.includes('linked-file.md'), false)
  assert.equal(paths.some((entry) => entry.startsWith('linked-dir/')), false)
  assert.equal(result.total, MATERIAL.length)
  assert.equal(result.skipped, 2, 'both links are reported as skipped, not silently indexed')
})

test('an unsupported index schema is never overwritten without an explicit rebuild', async () => {
  const fixture = await projectFixture()
  await writeFixture(fixture.home, 'courses/term/.professor/indexes/files.json', '{"schema_version": 99, "from":"the future"}')
  const original = await fs.readFile(path.join(fixture.project, '.professor/indexes/files.json'), 'utf8')

  const { tools, exec } = await booted(fixture)
  await assert.rejects(
    () => tools.professor_index_sync.execute({}, exec),
    (error) => error.code === 'PROFESSOR_INDEX_SCHEMA_UNSUPPORTED',
  )
  assert.equal(await fs.readFile(path.join(fixture.project, '.professor/indexes/files.json'), 'utf8'), original)

  const rebuilt = await tools.professor_index_sync.execute({ rebuild: true }, exec)
  assert.equal(rebuilt.schemaVersion, FILE_INDEX_SCHEMA_VERSION)
  assert.equal((await readIndex(fixture.project)).schema_version, FILE_INDEX_SCHEMA_VERSION)
})

test('the index is written only inside .professor and is deterministic', async () => {
  const fixture = await projectFixture()
  const { tools, exec } = await booted(fixture)
  const first = await tools.professor_index_sync.execute({}, exec)

  assert.ok(first.indexFile.startsWith(path.join(fixture.project, '.professor')))
  const entries = await fs.readdir(fixture.project)
  assert.deepEqual(entries.filter((name) => name.startsWith('.professor')).length, 1)
  assert.equal(entries.includes('files.json'), false)

  const indexA = await readIndex(fixture.project)
  await tools.professor_index_sync.execute({ rebuild: true }, exec)
  const indexB = await readIndex(fixture.project)
  assert.deepEqual(
    indexB.files.map((file) => [file.relative_path, file.file_id, file.content_hash]),
    indexA.files.map((file) => [file.relative_path, file.file_id, file.content_hash]),
    'index content is reproducible',
  )
})

test('professor_paths reports the project root, both policies and the sandbox policy', async () => {
  const fixture = await projectFixture()
  const { tools, exec } = await booted(fixture)
  const result = await tools.professor_paths.execute({}, exec)

  assert.equal(result.projectRoot, await fs.realpath(fixture.project))
  assert.equal(result.projectRootSource, 'session-cwd')
  assert.deepEqual(result.writeRoots, [path.join(fixture.project, '.professor')])
  assert.ok(result.readRoots.includes(fixture.project))
  assert.equal(result.sandbox.fsAvailable, true)
  assert.equal(result.sandbox.callPolicy.workspaceRoot, fixture.project)
  // The invariant is "the plugin root is the package directory this test lives in", not a
  // particular folder spelling: a tarball install lands in `node_modules/dsh-professor-spike`, and
  // that deployment is just as legitimate as a checkout called anything else.
  const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  assert.equal(await fs.realpath(result.pluginRoot), await fs.realpath(packageRoot))
  assert.equal(await fs.realpath(result.skillsDir), await fs.realpath(path.join(packageRoot, 'skills')))
  assert.equal(await fs.realpath(path.join(result.pluginRoot, 'package.json')).then(() => true, () => false), true,
    'the reported plugin root really is a package directory')
})

test('professor_diagnostics reports observable health and honest gaps', async () => {
  const fixture = await projectFixture()
  const { tools, exec } = await booted(fixture)
  const before = await tools.professor_diagnostics.execute({}, exec)

  assert.equal(before.plugin.name, 'professor-spike')
  assert.equal(before.project.projectFile, 'absent')
  assert.equal(before.session.cwd, fixture.project)
  assert.equal(before.index.present, false)
  assert.equal(before.skills.count, 6)
  assert.equal(before.skills.watcher.healthy, true)
  assert.ok(before.warnings.some((message) => /project\.yaml/.test(message)))
  // The list must stay honest in both directions: it names the limitations that are genuinely
  // still there (no OCR engine, no Office runner, no slide coordinates, no visual PDF check), and
  // it does NOT list a completed milestone (M10 learning state, M11 notes/reviews/LaTeX) as if it
  // were still missing. A regression that silently claims an unimplemented feature, or that leaves
  // a finished one behind, fails here.
  assert.ok(before.notImplemented.length > 0, 'diagnostics must report unimplemented features')
  const notImplementedFeatures = before.notImplemented.map((entry) => entry.feature).join(' | ')
  assert.match(notImplementedFeatures, /OCR|slide coordinates|Office|visual verification/i,
    'the list must still name the limitations that are genuinely not built yet')
  assert.doesNotMatch(notImplementedFeatures, /learning state|note and review/i,
    'a completed milestone must not remain on the not-implemented list')
  assert.deepEqual(before.limitations, before.notImplemented,
    'limitations and notImplemented describe the same honest set')
  // M12: the report is bounded and redaction-free by construction — it must never carry an
  // environment dump, a key, a file body, a prompt or the full learning state.
  const serialized = JSON.stringify(before)
  assert.doesNotMatch(serialized, /"(env|environment|process_env|api_key|apiKey|secret|token|prompt|contents?|state_contents)"\s*:/i,
    'diagnostics must never emit env dumps, credentials, prompts or file contents')

  await tools.professor_index_sync.execute({}, exec)
  const after = await tools.professor_diagnostics.execute({}, exec)
  assert.equal(after.index.present, true)
  assert.equal(after.index.fileCount, MATERIAL.length)
  assert.equal(after.index.schemaVersion, FILE_INDEX_SCHEMA_VERSION)
})

/**
 * Version coherence is a documentation claim, so it gets a test.
 *
 * The plugin version is stated in three places that a reader will compare — `package.json`, the
 * README's "当前版本" line, and whatever `professor_diagnostics` reports at call time. The third is
 * read from the manifest rather than hardcoded, which is exactly the property worth pinning: if
 * someone reintroduces a literal, the report and the manifest can silently disagree, and the README
 * becomes the only thing telling the truth.
 */
test('the package version, the README and diagnostics agree, with no hardcoded copy', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))

  // 1. Diagnostics reports the manifest version verbatim — it must not invent one.
  const fixture = await projectFixture()
  const { tools, exec } = await booted(fixture)
  const report = await tools.professor_diagnostics.execute({}, exec)
  assert.equal(report.plugin.version, manifest.version,
    'diagnostics must report the version it read from this package')

  // 2. The README states the same version, so the two documents cannot drift apart.
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8')
  const stated = readme.match(/当前版本\s*\*\*`([^`]+)`\*\*/)
  assert.ok(stated, 'the README must state the current version in the documented form')
  assert.equal(stated[1], manifest.version, 'the README version must equal the package version')

  // 3. No shipped source file hardcodes this package's own version. Citing the *Harness* version in
  //    a provenance comment is fine and deliberately allowed — the rule is about the plugin's own
  //    version, which must only ever come from the manifest.
  const offenders = []
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(target)
        continue
      }
      if (!entry.name.endsWith('.js')) continue
      const text = await fs.readFile(target, 'utf8')
      if (text.includes(manifest.version)) offenders.push(path.relative(root, target))
    }
  }
  for (const start of [path.join(root, 'src'), path.join(root, 'index.js')]) {
    const stats = await fs.stat(start)
    if (stats.isDirectory()) await walk(start)
    else if ((await fs.readFile(start, 'utf8')).includes(manifest.version)) offenders.push('index.js')
  }
  assert.deepEqual(offenders, [],
    `the plugin version must live only in package.json, but ${manifest.version} appears in: ${offenders.join(', ')}`)
})

test('every tool refuses to run without a conversation workspace', async () => {
  const fixture = await projectFixture()
  const { tools } = await booted(fixture)
  for (const tool of Object.values(tools)) {
    if (tool.name.startsWith('professor_memory_')) continue
    await assert.rejects(
      () => tool.execute({}, {}),
      /carries no conversation workspace|no conversation workspace/,
      `${tool.name} must not guess a project root`,
    )
  }

  // The memory tools are workspace-independent by design (they never resolve or guess a project
  // root on their own; course scope goes through the same strict resolution). Tools answer
  // failures as structured problems rather than rejections, so a rootless course-scoped read must
  // at least report an honest problem — never a guessed root.
  const status = await tools.professor_memory_status.execute({}, {})
  assert.equal(typeof status.enabled, 'boolean')
  const courseRead = await tools.professor_memory_read.execute({ scope: 'course' }, {})
  assert.ok(Array.isArray(courseRead.problems) && courseRead.problems.length > 0,
    'a rootless course-scoped memory read reports a problem instead of guessing a root')
})
