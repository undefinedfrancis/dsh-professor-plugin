/**
 * M12 migration tests: the Personal-Agent registry import as an *auditable* operation.
 *
 * The import is the one place the plugin reads a layout it does not own, so the contract has to be
 * strict: the source is only ever read, the plan and the outcome are recorded under
 * `.professor/migrations/`, a re-run is idempotent, and the plan states exactly which registry
 * revision produced each course. These tests assert the audit trail, not just the resulting
 * course list.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { courseInputFromRegistry } from '../src/migrations/personal-agent-registry.js'
import { resolveArtifactRoot } from '../src/artifacts/paths.js'
import { MIGRATION_FIELD_MAP } from '../src/tools/courses.js'
import { readMigrationStatus } from '../src/migrations/log.js'
import { createFsGateway } from '../src/fs/gateway.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

const INDEX_MD = `# Active Courses

| Course Code | Course Name | Semester | Status | Registry |
|---|---|---|---|---|
| CSC3200 | Data Structures | 2025-2026 Fall | active | Courses/CSC3200.md |
| GFN1000 | Foundation Course | 2025-2026 Fall | archived | Courses/GFN1000.md |
`

/** A registry document with the drifted shape the real files have. */
const courseMd = (code, extras = '') => `# Course Configuration

## Course Code
\`\`\`
${code}
\`\`\`

## Course Name
\`\`\`
${code} Display Name
\`\`\`

## Semester
\`\`\`
2025-2026 Fall
\`\`\`

## Course Root
\`\`\`
\${ROOT}/${code}
\`\`\`

## Lecture Materials
\`\`\`
\${ROOT}/${code}/01_Lectures
\`\`\`

## AI Notes Output
\`\`\`
\${ROOT}/${code}/04_My-Notes/AI-Notes
\`\`\`

## Default Note Format
\`\`\`
Ask every time
\`\`\`

## Special Instructions
\`\`\`
Attend every tutorial.
\`\`\`
${extras}`

async function fixture() {
  const home = await makeHome('professor-migration-')
  const project = path.join(home, 'term')
  const registryDir = path.join(home, 'Personal-Agent', '01_Learning', 'Registry')
  await writeFixture(home, 'term/CSC3200/01_Lectures/lecture-01.pdf', 'course material')

  await writeFixture(home, 'Personal-Agent/01_Learning/Registry/COURSES.md', INDEX_MD)
  await writeFixture(home, 'Personal-Agent/01_Learning/Registry/Courses/CSC3200.md', courseMd('CSC3200').replaceAll('${ROOT}', project))
  await writeFixture(home, 'Personal-Agent/01_Learning/Registry/Courses/GFN1000.md', courseMd('GFN1000').replaceAll('${ROOT}', project))
  // A Personal-Agent Knowledge file: the import must never touch it either.
  await writeFixture(home, 'Personal-Agent/01_Learning/Knowledge/CSC3200/KNOWLEDGE.md', '# 原始知识\n\n- 教授强调的内容\n')

  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })
  await tools.professor_project_init.execute({ project_id: 'term-2026' }, exec)

  return { home, project, registryDir, fake, tools, exec }
}

const readFile = (absolute) => fs.readFile(absolute, 'utf8')
const exists = (absolute) => fs.stat(absolute).then(() => true, () => false)
const migrationsDir = (project) => path.join(project, '.professor', 'migrations')

test('every import result is lossless JSON, including preview and already-registered courses', async () => {
  const f = await fixture()
  for (const dry_run of [true, false, false]) {
    const result = await f.tools.professor_course_manage.execute({ action: 'import', registry_dir: f.registryDir, dry_run }, f.exec)
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  }
})

test('registry import preserves per-course destinations without promoting one course to global defaults', async () => {
  const f = await fixture()
  await f.tools.professor_course_manage.execute({ action: 'import', registry_dir: f.registryDir }, f.exec)
  const { parseYamlLite } = await import('../src/project/yaml-lite.js')
  const document = parseYamlLite(await readFile(path.join(f.project, '.professor', 'project.yaml')))
  assert.equal(document.outputs.notes_root, null)
  assert.equal(document.notes.default_format, 'ask')
  for (const course of document.courses) {
    const expected = path.join(f.project, course.course_code, '04_My-Notes/AI-Notes')
    assert.equal(course.outputs.notes_root, expected)
    assert.equal(resolveArtifactRoot({ document, projectRoot: f.project, course, kind: 'note' }).root, expected)
    assert.equal(course.registry_fields.find((entry) => entry.field === 'Special Instructions').value, 'Attend every tutorial.')
  }
})

test('additional materials are not exam evidence merely because they are supplemental', () => {
  for (const directory of ['06_Code', '00_Course-Info']) {
    const mapped = courseInputFromRegistry({ courseCode: 'CSC3200', fields: {
      'Course Root': '/courses/CSC3200', 'Additional Course Materials': directory,
    } })
    assert.equal(mapped.input.sources[0].category_rules.exams, undefined)
    assert.deepEqual(mapped.input.sources[0].category_rules.supplementary, [`/courses/CSC3200/${directory}`])
  }
})

test('a migrated course creates and lists notes only in its own configured destination', async () => {
  const f = await fixture()
  await f.tools.professor_course_manage.execute({ action: 'import', registry_dir: f.registryDir }, f.exec)
  const created = await f.tools.professor_artifact_create.execute({ kind: 'note', title: 'Own Course', course: 'CSC3200', format: 'markdown' }, f.exec)
  assert.equal(created.created, true)
  assert.equal(created.root, path.join(f.project, 'CSC3200/04_My-Notes/AI-Notes'))
  const status = await f.tools.professor_artifact_status.execute({ course: 'CSC3200', kind: 'note' }, f.exec)
  assert.equal(status.roots[0].root, created.root)
  assert.equal(status.roots[0].file_count, 1)
})

/** A recursive digest of every file under a directory, used to prove a tree was not written to. */
async function treeDigest(root) {
  const entries = []
  const walk = async (dir) => {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else entries.push(`${path.relative(root, full)}:${await readFile(full)}`)
    }
  }
  await walk(root)
  return entries.join('\n')
}

test('a dry run returns the explicit plan and writes nothing at all', async () => {
  const f = await fixture()
  const projectBefore = await readFile(path.join(f.project, '.professor', 'project.yaml'))

  const dry = await f.tools.professor_course_manage.execute({
    action: 'import', registry_dir: f.registryDir, dry_run: true,
  }, f.exec)

  assert.equal(dry.dryRun, true)
  assert.equal(dry.migration.dryRun, true)
  assert.equal(dry.migration.planWritten, false)
  assert.equal(dry.migration.logRecorded, false)
  assert.deepEqual(dry.changed, ['csc3200', 'gfn1000'])

  const plan = dry.migration.plan
  assert.equal(plan.schema, 'professor.migration.plan/1')
  assert.equal(plan.action, 'import')
  assert.equal(plan.registry_dir, f.registryDir)
  assert.equal(plan.dry_run, true)
  assert.deepEqual(plan.field_map, MIGRATION_FIELD_MAP)
  assert.deepEqual(plan.outcomes, { create: 2, already_registered: 0, skipped: 0 })

  // Every planned course names the registry revision it read.
  for (const entry of plan.courses) {
    assert.equal(entry.outcome, 'create')
    assert.equal(typeof entry.registry, 'string')
    assert.match(entry.source_digest, /^[0-9a-f]{16}$/)
    assert.equal(entry.registry.startsWith(f.registryDir), true)
    assert.equal(entry.unmapped_fields.includes('Special Instructions'), true)
  }

  // Nothing was written: no document change, no migrations directory, no plan, no log.
  assert.equal(await readFile(path.join(f.project, '.professor', 'project.yaml')), projectBefore)
  assert.equal(await exists(migrationsDir(f.project)), false)
  assert.equal(await exists(path.join(f.project, '.professor', 'state')), false)
})

test('a real import records the plan and the outcome under .professor/migrations/', async () => {
  const f = await fixture()
  const result = await f.tools.professor_course_manage.execute({
    action: 'import', registry_dir: f.registryDir,
  }, f.exec)

  assert.equal(result.dryRun, false)
  assert.equal(result.migration.planWritten, true)
  assert.equal(result.migration.logRecorded, true)
  assert.equal(result.migration.planPath, result.migration.plan.planPath ?? result.migration.planPath)
  assert.equal(result.migration.planPath, path.join(migrationsDir(f.project), `plan-${result.migration.plan.stamp}.json`))

  const planOnDisk = JSON.parse(await readFile(result.migration.planPath))
  assert.deepEqual(planOnDisk, result.migration.plan, 'the recorded plan is exactly the plan that was returned')
  assert.equal(planOnDisk.dry_run, false)

  const log = (await readFile(path.join(migrationsDir(f.project), 'migration.log')))
    .split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
  assert.equal(log.length, 1)
  assert.equal(log[0].outcome, 'applied')
  assert.equal(log[0].schema, 'professor.migration.log/1')
  assert.deepEqual(log[0].courses_created, ['csc3200', 'gfn1000'])
  assert.equal(log[0].plan, result.migration.planPath)
  assert.equal(log[0].registry_digest, planOnDisk.registry_digest)
  assert.equal(log[0].dry_run, false)
})

test('a re-run of an unchanged registry is a no-op: no duplicate course, an explicit no-op entry', async () => {
  const f = await fixture()
  await f.tools.professor_course_manage.execute({ action: 'import', registry_dir: f.registryDir }, f.exec)
  const projectAfterFirst = await readFile(path.join(f.project, '.professor', 'project.yaml'))

  const second = await f.tools.professor_course_manage.execute({ action: 'import', registry_dir: f.registryDir }, f.exec)
  assert.deepEqual(second.changed, [])
  assert.equal(second.imported.every((entry) => entry.status === 'already-registered'), true)
  assert.deepEqual(second.migration.plan.outcomes, { create: 0, already_registered: 2, skipped: 0 })
  assert.equal(await readFile(path.join(f.project, '.professor', 'project.yaml')), projectAfterFirst,
    'an idempotent re-run does not rewrite the document')

  const listed = await f.tools.professor_course_list.execute({ include_archived: true }, f.exec)
  assert.deepEqual(listed.courses.map((course) => course.course_id), ['csc3200', 'gfn1000'],
    'no course was duplicated')

  const log = (await readFile(path.join(migrationsDir(f.project), 'migration.log')))
    .split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
  assert.deepEqual(log.map((entry) => entry.outcome), ['applied', 'no-op'],
    'a re-run is visible as a no-op rather than indistinguishable from a first run')
})

test('changing a registry document changes the plan digest, so the audit trail is real', async () => {
  const f = await fixture()
  const first = await f.tools.professor_course_manage.execute({ action: 'import', registry_dir: f.registryDir }, f.exec)

  await writeFixture(
    f.home,
    'Personal-Agent/01_Learning/Registry/Courses/CSC3200.md',
    courseMd('CSC3200', '\n## Extra Section\n```\nnew content\n```\n').replaceAll('${ROOT}', f.project),
  )

  const second = await f.tools.professor_course_manage.execute({ action: 'import', registry_dir: f.registryDir }, f.exec)
  assert.notEqual(second.migration.plan.registry_digest, first.migration.plan.registry_digest,
    'a changed source must produce a different plan digest')
  const changed = second.migration.plan.courses.find((entry) => entry.course_code === 'CSC3200')
  assert.notEqual(changed.source_digest, first.migration.plan.courses.find((entry) => entry.course_code === 'CSC3200').source_digest)
  assert.equal(changed.unmapped_fields.includes('Extra Section'), true, 'a new unmapped field is reported')
})

test('the unmapped-field report aggregates by field and the only filter narrows the plan', async () => {
  const f = await fixture()
  const only = await f.tools.professor_course_manage.execute({
    action: 'import', registry_dir: f.registryDir, only: ['GFN1000'],
  }, f.exec)

  assert.deepEqual(only.changed, ['gfn1000'])
  assert.deepEqual(only.migration.plan.only, ['GFN1000'])
  assert.deepEqual(only.migration.plan.courses.map((entry) => entry.course_code), ['GFN1000'])

  const all = await f.tools.professor_course_manage.execute({ action: 'import', registry_dir: f.registryDir }, f.exec)
  assert.deepEqual(all.migration.plan.unmapped_fields, [
    { field: 'Special Instructions', courses: ['CSC3200', 'GFN1000'] },
  ])
})

test('the import never writes to the source registry, the Knowledge files or the material', async () => {
  const f = await fixture()
  const sourceDigest = await treeDigest(path.join(f.home, 'Personal-Agent'))
  const materialBefore = await readFile(path.join(f.project, 'CSC3200', '01_Lectures', 'lecture-01.pdf'))

  await f.tools.professor_course_manage.execute({ action: 'import', registry_dir: f.registryDir, dry_run: true }, f.exec)
  await f.tools.professor_course_manage.execute({ action: 'import', registry_dir: f.registryDir }, f.exec)
  await f.tools.professor_course_manage.execute({ action: 'import', registry_dir: f.registryDir }, f.exec)

  assert.equal(await treeDigest(path.join(f.home, 'Personal-Agent')), sourceDigest,
    'the Personal-Agent tree is byte-identical after three imports')
  assert.equal(await readFile(path.join(f.project, 'CSC3200', '01_Lectures', 'lecture-01.pdf')), materialBefore)
  assert.equal(await exists(path.join(f.project, 'CSC3200', '04_My-Notes')), false,
    'no notes directory is created in the course tree by an import')
})

test('an absent or unreadable registry is a domain error and leaves no log entry', async () => {
  const f = await fixture()
  await assert.rejects(
    () => f.tools.professor_course_manage.execute({ action: 'import', registry_dir: path.join(f.home, 'nowhere') }, f.exec),
    (error) => error.code === 'PROFESSOR_IMPORT_SOURCE_MISSING',
  )
  assert.equal(await exists(migrationsDir(f.project)), false, 'a refused import records nothing')
})

test('migration status is reported through professor_diagnostics', async () => {
  const f = await fixture()
  const before = await f.tools.professor_diagnostics.execute({}, f.exec)
  assert.equal(before.migration.status, 'never-run')
  assert.equal(before.migration.logPresent, false)

  await f.tools.professor_course_manage.execute({ action: 'import', registry_dir: f.registryDir }, f.exec)
  const applied = await f.tools.professor_diagnostics.execute({}, f.exec)
  assert.equal(applied.migration.status, 'applied')
  assert.equal(applied.migration.applied, 1)
  assert.equal(applied.migration.plans, 1)
  assert.equal(applied.migration.lastEntry.outcome, 'applied')

  await f.tools.professor_course_manage.execute({ action: 'import', registry_dir: f.registryDir }, f.exec)
  const noop = await f.tools.professor_diagnostics.execute({}, f.exec)
  assert.equal(noop.migration.status, 'applied')
  assert.equal(noop.migration.applied, 1)
  assert.equal(noop.migration.noop, 1)
  assert.equal(noop.migration.plans, 2)
})

test('migration status classifies a hand-written log without trusting it blindly', async () => {
  const f = await fixture()
  const gateway = createFsGateway({ ctx: f.fake.ctx })
  const logPath = path.join(migrationsDir(f.project), 'migration.log')

  await writeFixture(f.home, 'term/.professor/migrations/migration.log', [
    JSON.stringify({ outcome: 'applied', stamp: 1 }),
    'not json at all',
    JSON.stringify({ outcome: 'failed', reason: 'project.yaml moved under us' }),
  ].join('\n'))

  const status = await readMigrationStatus({ gateway, projectRoot: f.project })
  assert.equal(status.status, 'completed-with-failures')
  assert.equal(status.applied, 1)
  assert.equal(status.failed, 1)
  assert.equal(status.lastEntry.reason, 'project.yaml moved under us')
  assert.equal(status.plans, 0)

  await fs.writeFile(logPath, '', 'utf8')
  const empty = await readMigrationStatus({ gateway, projectRoot: f.project })
  assert.equal(empty.logPresent, true)
  assert.equal(empty.status, 'never-run', 'an empty log is not an applied migration')
})
