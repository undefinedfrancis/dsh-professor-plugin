/**
 * Course tooling tests: registry import (read-only, drift tolerant) and the three M5 tools.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { projectPaths } from '../src/paths/roots.js'
import {
  courseInputFromRegistry, importPersonalAgentRegistry, parseCourseDocument, parseCoursesIndex,
} from '../src/migrations/personal-agent-registry.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

const INDEX_MD = `# Active Courses

| Course Code | Course Name | Semester | Status | Registry |
|---|---|---|---|---|
| CSC3200 | Data Structures and Advanced Programming | 2025-2026 Fall | active | Courses/CSC3200.md |
| GFN1000 | GFN1000 | 2025-2026 Fall | archived | Courses/GFN1000.md |

# Archived Courses
`

const CSC3200_MD = `# Course Configuration

# 1. Course Identity

## Course Code
\`\`\`
CSC3200
\`\`\`

## Course Name
\`\`\`
Data Structures and Advanced Programming
\`\`\`

## Semester
\`\`\`
2025-2026 Fall
\`\`\`

## Status
\`\`\`
active
\`\`\`

# 2. External Course Workspace

## Course Root
\`\`\`
\${ROOT}/CSC3200
\`\`\`

## Lecture Materials
\`\`\`
\${ROOT}/CSC3200/01_Lectures
\`\`\`

## Tutorial Materials
\`\`\`
N/A
\`\`\`

## Assignment Materials
\`\`\`
\${ROOT}/CSC3200/03_Assignments
\`\`\`

# 6. Note Output

## AI Notes Output
\`\`\`
\${ROOT}/CSC3200/04_My-Notes/AI-Notes
\`\`\`

## Default Note Format
\`\`\`
Ask every time
\`\`\`

## LaTeX Template
\`\`\`
Use the shared/default LaTeX template when the user selects LaTeX
\`\`\`

# 9. Instructions

## Special Instructions
\`\`\`
Attend every tutorial.
\`\`\`
`

const GFN1000_MD = `# Course Configuration

## Course Code
\`\`\`
GFN1000
\`\`\`

## Course Name
\`\`\`
GFN1000
\`\`\`

## Course Root
\`\`\`
\${ROOT}/GFN1000
\`\`\`

## Default Note Format
\`\`\`
LaTeX
\`\`\`
`

async function fixture() {
  const home = await makeHome('professor-courses-')
  const project = path.join(home, 'courses', 'term')
  const material = path.join(home, 'courses', 'term', 'CSC3200')
  await writeFixture(home, 'courses/term/CSC3200/01_Lectures/lecture-01.pdf', 'lecture material')
  await writeFixture(home, 'courses/term/CSC3200/03_Assignments/hw1.md', 'assignment')
  await writeFixture(home, 'courses/term/GFN1000/L1.pdf', 'gfn material')

  const registryDir = path.join(home, 'Personal-Agent', '01_Learning', 'Registry')
  const root = path.join(home, 'courses', 'term')
  await writeFixture(home, 'Personal-Agent/01_Learning/Registry/COURSES.md', INDEX_MD)
  await writeFixture(home, 'Personal-Agent/01_Learning/Registry/Courses/CSC3200.md', CSC3200_MD.replaceAll('${ROOT}', root))
  await writeFixture(home, 'Personal-Agent/01_Learning/Registry/Courses/GFN1000.md', GFN1000_MD.replaceAll('${ROOT}', root))

  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  return { home, project, material, registryDir, fake, tools, exec: makeExec({ cwd: project }) }
}

async function readIndex(project) {
  return JSON.parse(await fs.readFile(path.join(project, '.professor', 'indexes', 'files.json'), 'utf8'))
}

async function readProject(project) {
  return fs.readFile(path.join(project, '.professor', 'project.yaml'), 'utf8')
}

// --- importer --------------------------------------------------------------

test('the registry index parser tolerates real formatting', () => {
  const { courses, warnings } = parseCoursesIndex(INDEX_MD)
  assert.equal(courses.length, 2)
  assert.deepEqual(courses[0], {
    course_code: 'CSC3200',
    course_name: 'Data Structures and Advanced Programming',
    term: '2025-2026 Fall',
    status: 'active',
    registry: 'Courses/CSC3200.md',
  })
  assert.equal(courses[1].status, 'archived')
  assert.deepEqual(warnings, [])

  const odd = parseCoursesIndex('| Course Code | Course Name | Semester | Status | Registry |\n|---|---|---|---|---|\n| X | X | T | pending | Courses/X.md |')
  assert.equal(odd.courses[0].status, 'active')
  assert.equal(odd.warnings.length, 1)
})

test('the course document parser reads fenced blocks and ignores group headings', () => {
  const { fields, warnings } = parseCourseDocument(CSC3200_MD.replaceAll('${ROOT}', '/root'))
  assert.equal(fields['Course Code'], 'CSC3200')
  assert.equal(fields['Course Root'], '/root/CSC3200')
  assert.equal(fields['Lecture Materials'], '/root/CSC3200/01_Lectures')
  assert.equal(fields['Tutorial Materials'], 'N/A')
  assert.equal(warnings.length, 0)
  assert.equal(Object.keys(fields).some((key) => /^\d+\./.test(key)), false, 'group headings are not fields')

  const duplicated = parseCourseDocument('## Course Code\n```\nA\n```\n## Course Code\n```\nB\n```\n')
  assert.equal(duplicated.fields['Course Code'], 'A')
  assert.equal(duplicated.warnings.length, 1)
})

test('registry fields map onto the project schema, reporting what cannot be mapped', () => {
  const root = '/root'
  const { fields } = parseCourseDocument(CSC3200_MD.replaceAll('${ROOT}', root))
  const mapped = courseInputFromRegistry({ courseCode: 'CSC3200', indexRow: { status: 'active', term: '2025-2026 Fall' }, fields })

  assert.equal(mapped.input.course_id, 'csc3200')
  assert.equal(mapped.input.term, '2025-2026 Fall')
  assert.equal(mapped.input.status, 'active')
  assert.deepEqual(mapped.input.sources[0].category_rules, {
    lectures: [`${root}/CSC3200/01_Lectures`],
    assignments: [`${root}/CSC3200/03_Assignments`],
  })
  assert.equal(mapped.notesRoot, `${root}/CSC3200/04_My-Notes/AI-Notes`)
  assert.equal(mapped.noteFormat, 'ask', '"Ask every time" means ask')
  assert.equal(mapped.latexTemplate, null, 'prose is not a template path')
  assert.ok(mapped.warnings.some((warning) => /LaTeX Template is prose/.test(warning)))
  assert.ok(Object.hasOwn(mapped.unmapped, 'Special Instructions'))

  const bare = courseInputFromRegistry({ courseCode: 'PHY1001', fields: { 'Course Code': 'PHY1001' } })
  assert.equal(bare.input.term, 'unspecified')
  assert.equal(bare.input.sources.length, 0)
  assert.ok(bare.warnings.some((warning) => /no semester recorded/.test(warning)))
  assert.ok(bare.warnings.some((warning) => /no Course Root recorded/.test(warning)))
})

test('importing the real registry layout is read-only and lossless about gaps', async () => {
  const f = await fixture()
  const before = await fs.readFile(path.join(f.registryDir, 'COURSES.md'), 'utf8')

  const { entries, report } = await importPersonalAgentRegistry({
    registryDir: f.registryDir,
    readText: (file) => fs.readFile(file, 'utf8'),
    listDir: (dir) => fs.readdir(dir),
  })

  assert.deepEqual(entries.map((entry) => entry.input.course_id), ['csc3200', 'gfn1000'])
  assert.equal(report.courseCount, 2)
  assert.equal(report.skipped.length, 0)
  assert.equal(entries[1].noteFormat, 'latex')
  assert.equal(await fs.readFile(path.join(f.registryDir, 'COURSES.md'), 'utf8'), before, 'the registry is never written')

  const missing = await importPersonalAgentRegistry({
    registryDir: path.join(f.home, 'nowhere'),
    readText: (file) => fs.readFile(file, 'utf8'),
    listDir: () => [],
  })
  assert.equal(missing.entries.length, 0)
  assert.ok(missing.report.warnings.some((warning) => /COURSES.md unreadable/.test(warning)))
})

test('course edits require the observed project digest and root when provided', async () => {
  const f = await fixture()
  await f.tools.professor_project_init.execute({}, f.exec)
  await f.tools.professor_course_manage.execute({ action: 'register', course_code: 'CSC3200', display_name: 'Original', term: 'T' }, f.exec)
  const observed = await f.tools.professor_course_list.execute({ include_archived: true }, f.exec)
  assert.match(observed.configDigest, /^[a-f0-9]{64}$/)
  const args = { action: 'update', course_id: 'csc3200', display_name: 'New', expected_config_digest: observed.configDigest, expected_project_root: f.project }
  await f.tools.professor_course_manage.execute(args, f.exec)
  await assert.rejects(f.tools.professor_course_manage.execute({ ...args, action: 'archive' }, f.exec), { code: 'PROFESSOR_PROJECT_STALE' })
  const next = await f.tools.professor_course_list.execute({ include_archived: true }, f.exec)
  await assert.rejects(f.tools.professor_course_manage.execute({ ...args, expected_config_digest: next.configDigest, expected_project_root: '/wrong-project' }, f.exec), { code: 'PROFESSOR_PROJECT_STALE' })
  assert.equal(next.courses[0].course_id, 'csc3200')
})

// --- tools -----------------------------------------------------------------
test('a concurrent course edit during source inspection is never overwritten', async () => {
  const f = await fixture()
  await f.tools.professor_project_init.execute({}, f.exec)
  await f.tools.professor_course_manage.execute({ action: 'register', course_code: 'CSC3200', display_name: 'Original', term: 'T' }, f.exec)
  const originalList = f.fake.fs.listDir
  let once = false
  f.fake.fs.listDir = async function (...args) {
    if (!once) {
      once = true
      await f.tools.professor_course_manage.execute({ action: 'update', course_id: 'csc3200', display_name: 'Concurrent name' }, f.exec)
    }
    return originalList.apply(this, args)
  }
  await assert.rejects(f.tools.professor_course_manage.execute({ action: 'update', course_id: 'csc3200', source_path: f.material, display_name: 'Stale name' }, f.exec), { code: 'PROFESSOR_PROJECT_STALE' })
  const current = await f.tools.professor_course_list.execute({}, f.exec)
  assert.equal(current.courses[0].display_name, 'Concurrent name')
})

test('project init is create-only and course registration validates sources', async () => {
  const f = await fixture()

  const created = await f.tools.professor_project_init.execute({ project_id: 'term-2026', name: 'Fall 2026' }, f.exec)
  assert.equal(created.created, true)
  assert.match(await readProject(f.project), /schema_version: 1/)
  assert.match(await readProject(f.project), /id: term-2026/)

  const again = await f.tools.professor_project_init.execute({}, f.exec)
  assert.equal(again.created, false)
  assert.equal(again.alreadyPresent, true)

  const registered = await f.tools.professor_course_manage.execute({
    action: 'register',
    course_code: 'CSC3200',
    display_name: 'Data Structures and Advanced Programming',
    term: '2025-2026 Fall',
    source_path: f.material,
    notes_root: path.join(f.material, '04_My-Notes/AI-Notes'),
  }, f.exec)
  assert.deepEqual(registered.changed, ['csc3200'])
  assert.deepEqual(registered.problems, [])
  assert.match(await readProject(f.project), /course_code: CSC3200/)
  assert.match(await readProject(f.project), /notes_root:/)

  await assert.rejects(
    () => f.tools.professor_course_manage.execute({
      action: 'register', course_code: 'CSC3200', display_name: 'Duplicate', term: '2025-2026 Fall',
    }, f.exec),
    (error) => error.code === 'PROFESSOR_COURSE_EXISTS',
  )

  const bogus = await f.tools.professor_course_manage.execute({
    action: 'register', course_code: 'PHY1001', display_name: 'Physics', term: '2025-2026 Fall',
    source_path: path.join(f.home, 'does-not-exist'),
  }, f.exec)
  assert.equal(bogus.problems.length, 1)
  assert.match(bogus.problems[0], /does not exist or is not a directory/)
})

test('course list resolves, validates and reports unassigned material', async () => {
  const f = await fixture()
  await f.tools.professor_project_init.execute({}, f.exec)
  await f.tools.professor_course_manage.execute({
    action: 'register', course_code: 'CSC3200', display_name: 'DSA', term: '2025-2026 Fall', source_path: f.material,
  }, f.exec)

  const beforeIndex = await f.tools.professor_course_list.execute({}, f.exec)
  assert.equal(beforeIndex.projectPresent, true)
  assert.equal(beforeIndex.courses.length, 1)
  assert.equal(beforeIndex.assignment.indexPresent, false)
  assert.deepEqual(beforeIndex.problems, [])

  const resolved = await f.tools.professor_course_list.execute({ course: 'CSC3200' }, f.exec)
  assert.equal(resolved.resolved.status, 'found')
  assert.equal(resolved.resolved.course.course_id, 'csc3200')

  const missing = await f.tools.professor_course_list.execute({ course: 'PHY1001' }, f.exec)
  assert.equal(missing.resolved.status, 'missing')

  const unknown = await f.tools.professor_course_list.execute({ course: 'ZZZ9999' }, f.exec)
  assert.equal(unknown.resolved.status, 'missing')

  const sync = await f.tools.professor_index_sync.execute({}, f.exec)
  assert.equal(sync.total, 3)
  assert.equal(sync.assigned, 2, 'files under the registered CSC3200 source root are assigned')
  assert.equal(sync.unassigned, 1, 'the GFN1000 file has no registered source here, so it stays unassigned')
  assert.equal(sync.classification.byCategory.lectures, 1, 'the lecture matched its lecture category rule')
  assert.equal(sync.classification.byCategory.assignments, 1, 'the assignment matched its assignment category rule')
  assert.equal(sync.classification.bySource['category-rule'], 2, 'both CSC3200 files matched a category rule, not a guess')
  assert.equal(sync.classification.bySource['source-root'], 0, 'no file fell back to the source root alone')
  assert.equal(sync.classification.bySource.none, 1, 'the GFN1000 file matched nothing')
  assert.deepEqual(sync.classification.byCourse, { csc3200: 2 })

  const afterIndex = await f.tools.professor_course_list.execute({}, f.exec)
  assert.equal(afterIndex.assignment.indexPresent, true)
  assert.equal(afterIndex.assignment.total, 3)
  assert.equal(afterIndex.assignment.unassigned.count, 1, 'only the file with no registered source stays unassigned')
  assert.equal(afterIndex.assignment.byCourse[0].matched_files, 2, 'the course source root matches its two files')

  const record = (await readIndex(f.project)).files.find((entry) => entry.relative_path === 'CSC3200/01_Lectures/lecture-01.pdf')
  assert.equal(record.course_id, 'csc3200')
  assert.equal(record.category, 'lectures')
  assert.equal(record.classification_source, 'category-rule')
  assert.equal(record.classification_confidence, 1)
  const assignmentRecord = (await readIndex(f.project)).files.find((entry) => entry.relative_path === 'CSC3200/03_Assignments/hw1.md')
  assert.equal(assignmentRecord.category, 'assignments')
  assert.equal(assignmentRecord.classification_source, 'category-rule')
  const unassigned = (await readIndex(f.project)).files.find((entry) => entry.relative_path === 'GFN1000/L1.pdf')
  assert.equal(unassigned.course_id, null)
  assert.equal(unassigned.category, 'unassigned')
  assert.equal(unassigned.classification_source, 'none')
  assert.equal(unassigned.classification_confidence, 0)
})

test('archiving hides a course from the default listing without deleting anything', async () => {
  const f = await fixture()
  await f.tools.professor_project_init.execute({}, f.exec)
  await f.tools.professor_course_manage.execute({
    action: 'register', course_code: 'CSC3200', display_name: 'DSA', term: '2025-2026 Fall', source_path: f.material,
  }, f.exec)

  const archived = await f.tools.professor_course_manage.execute({ action: 'archive', course_id: 'csc3200' }, f.exec)
  assert.deepEqual(archived.changed, ['csc3200'])
  assert.equal(archived.course.status, 'archived')

  const hidden = await f.tools.professor_course_list.execute({}, f.exec)
  assert.equal(hidden.courses.length, 0)
  const shown = await f.tools.professor_course_list.execute({ include_archived: true }, f.exec)
  assert.equal(shown.courses.length, 1)
  assert.equal(shown.courses[0].active, false)
  assert.equal(shown.sources[0].sources[0].exists, true, 'archiving keeps the source path')

  const reactivated = await f.tools.professor_course_manage.execute({ action: 'reactivate', course_id: 'csc3200' }, f.exec)
  assert.equal(reactivated.course.status, 'active')
  assert.equal(await fs.readFile(path.join(f.material, '01_Lectures', 'lecture-01.pdf'), 'utf8'), 'lecture material')
})

test('importing the upstream registry is dry-runnable and never rewrites the source', async () => {
  const f = await fixture()
  await f.tools.professor_project_init.execute({}, f.exec)
  const sourceBefore = await fs.readFile(path.join(f.registryDir, 'Courses', 'CSC3200.md'), 'utf8')

  const dry = await f.tools.professor_course_manage.execute({
    action: 'import', registry_dir: f.registryDir, dry_run: true,
  }, f.exec)
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.changed, ['csc3200', 'gfn1000'])
  assert.doesNotMatch(await readProject(f.project), /course_code:/, 'dry run writes nothing')

  const real = await f.tools.professor_course_manage.execute({
    action: 'import', registry_dir: f.registryDir,
  }, f.exec)
  assert.equal(real.dryRun, false)
  assert.deepEqual(real.changed, ['csc3200', 'gfn1000'])
  assert.equal(real.imported.filter((entry) => entry.status === 'imported').length, 2)
  assert.deepEqual(real.warnings.filter((warning) => /LaTeX Template is prose/.test(warning)).length, 1)

  const listed = await f.tools.professor_course_list.execute({ include_archived: true }, f.exec)
  assert.deepEqual(listed.courses.map((course) => course.course_id), ['csc3200', 'gfn1000'])
  assert.equal(listed.courses[1].status, 'archived', 'the upstream status is preserved')

  // Importing again is idempotent: existing ids are reported, not duplicated.
  const second = await f.tools.professor_course_manage.execute({ action: 'import', registry_dir: f.registryDir }, f.exec)
  assert.deepEqual(second.changed, [])
  assert.equal(second.imported.every((entry) => entry.status === 'already-registered'), true)

  assert.equal(await fs.readFile(path.join(f.registryDir, 'Courses', 'CSC3200.md'), 'utf8'), sourceBefore, 'the upstream registry is untouched')
})

test('every course tool fails safe on an unsupported project schema', async () => {
  const f = await fixture()
  await writeFixture(f.home, 'courses/term/.professor/project.yaml', 'schema_version: 99\nproject:\n  id: future\n')

  for (const call of [
    () => f.tools.professor_project_init.execute({}, f.exec),
    () => f.tools.professor_course_list.execute({}, f.exec),
    () => f.tools.professor_course_manage.execute({ action: 'register', course_code: 'X', display_name: 'X', term: 'T' }, f.exec),
  ]) {
    await assert.rejects(call, (error) => error.code === 'PROFESSOR_PROJECT_UNSUPPORTED')
  }
  assert.match(await readProject(f.project), /schema_version: 99/, 'the newer file is left untouched')
  assert.equal(await fs.stat(projectPaths(f.project).filesIndex).catch(() => undefined), undefined)
})
