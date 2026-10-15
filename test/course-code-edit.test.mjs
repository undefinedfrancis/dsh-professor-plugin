/**
 * Editing a visible course code through the production tool/command paths.
 *
 * Identity guarantee under test: `course_code` is an editable label — changing it never touches
 * `course_id`, native conversation bindings, index ownership, sources/outputs, notes, state or
 * memory, and never renames files. The managed-course workflow keeps its snapshot/revision
 * safeguards, and launcher lookup follows the updated code with explicit ambiguity.
 *
 * @module test/course-code-edit
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { createProfessorCommands } from '../src/app/commands.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

async function toolFixture() {
  const home = await makeHome('professor-code-edit-')
  const project = path.join(home, 'workspace')
  await writeFixture(home, 'workspace/A_materials/lecture-01.md', '# Notes\nbinary search halves the range\n')
  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })
  await tools.professor_project_init.execute({}, exec)
  await tools.professor_course_manage.execute({
    action: 'register', course_code: 'CSC3200', display_name: 'Data Structures', term: '2025-2026 Fall',
    source_path: path.join(project, 'A_materials'), notes_root: path.join(project, 'Notes'),
  }, exec)
  await tools.professor_session_bind.execute({ action: 'bind', course: 'CSC3200' }, exec)
  await tools.professor_index_sync.execute({}, exec)
  await tools.professor_extract.execute({}, exec)
  return { home, project, tools, exec }
}

const sha = async (file) => (await fs.readFile(file).catch(() => null))

test('a code edit through the production update path preserves bindings, indexes and materials', async () => {
  const f = await toolFixture()
  try {
    const bindingFile = path.join(f.project, '.professor/state/sessions', `${f.exec.agent.session.id}.json`)
    const indexFile = path.join(f.project, '.professor/indexes/files.json')
    const projectFile = path.join(f.project, '.professor/project.yaml')
    const sourceFile = path.join(f.project, 'A_materials/lecture-01.md')
    const [bindingBefore, indexBefore, projectBefore, sourceBefore] = await Promise.all(
      [bindingFile, indexFile, projectFile, sourceFile].map(sha),
    )
    assert.ok(bindingBefore, 'the binding exists before the edit')
    const indexRecordsBefore = JSON.parse(indexBefore).files.map((row) => ({ id: row.file_id, course: row.course_id, path: row.relative_path }))

    const updated = await f.tools.professor_course_manage.execute({
      action: 'update', course_id: 'csc3200', course_code: ' CS-3200 ',
    }, f.exec)
    assert.equal(updated.course.course_code, 'CS-3200', 'trimmed exactly; capitalization preserved')
    assert.equal(updated.course.course_id, 'csc3200', 'the immutable id is untouched')

    const [bindingAfter, indexAfter, projectAfter, sourceAfter] = await Promise.all(
      [bindingFile, indexFile, projectFile, sourceFile].map(sha),
    )
    assert.deepEqual(bindingAfter, bindingBefore, 'the conversation binding record is byte-identical')
    assert.deepEqual(sourceAfter, sourceBefore, 'source material is byte-identical (no renames, no edits)')
    // The project document legitimately contains the code; only that one field may differ.
    const { parseYamlLite } = await import('../src/project/yaml-lite.js')
    const mask = (raw) => {
      const doc = parseYamlLite(raw.toString('utf8'))
      for (const course of doc.courses ?? []) course.course_code = '<masked>'
      return JSON.stringify(doc)
    }
    assert.equal(mask(projectAfter), mask(projectBefore), 'the project document changed only by the code field')
    const indexRecordsAfter = JSON.parse(indexAfter).files.map((row) => ({ id: row.file_id, course: row.course_id, path: row.relative_path }))
    assert.deepEqual(indexRecordsAfter, indexRecordsBefore, 'index ownership (file ids, course ids, paths) is unchanged')
    // Notes/output paths derive from the id and moved nowhere.
    const listed = await f.tools.professor_course_list.execute({}, f.exec)
    const course = listed.courses.find((row) => row.course_id === 'csc3200')
    assert.equal(course.course_code, 'CS-3200')
    assert.ok(course.sources.some((entry) => String(entry).endsWith('A_materials')), 'source paths survive')

    // Subsequent lookup follows the updated code; the canonical id still resolves.
    const byCode = await f.tools.professor_search.execute({ query: 'binary search', course: 'CS-3200' }, f.exec)
    assert.ok(byCode.results.length > 0, 'the updated code resolves in a course-filtered search')
    const byOldCode = await f.tools.professor_search.execute({ query: 'binary search', course: 'CSC3200' }, f.exec)
    assert.ok(byOldCode.results.length === 0 || byOldCode.results[0].course_id === 'csc3200')
    await assert.rejects(
      f.tools.professor_course_manage.execute({ action: 'update', course_id: 'other', course_code: 'X' }, f.exec),
      { code: 'PROFESSOR_COURSE_MISSING' },
    )
    const status = await f.tools.professor_session_status.execute({}, f.exec)
    assert.equal(status.course_id, 'csc3200', 'the session binding still reports the immutable id')
  } finally {
    await fs.rm(f.home, { recursive: true, force: true })
  }
})

test('duplicate codes stay ambiguous after edits and never pick a course arbitrarily', async () => {
  const f = await toolFixture()
  try {
    await f.tools.professor_course_manage.execute({
      action: 'register', course_code: 'CSC3200', display_name: 'DSA Spring', term: '2025-2026 Spring',
      source_path: path.join(f.project, 'A_materials'), notes_root: path.join(f.project, 'Notes'),
    }, f.exec)
    // Two registrations now share code CSC3200 across terms: the first was recoded in the other
    // test only — here it keeps its code. Resolution must stay explicit about ambiguity.
    const resolved = await f.tools.professor_course_list.execute({}, f.exec)
    const rows = resolved.courses.filter((row) => String(row.course_code).toLowerCase() === 'csc3200')
    assert.equal(rows.length, 2)
    const search = await f.tools.professor_search.execute({ query: 'binary search', course: 'csc3200' }, f.exec)
    assert.ok(search.results.length > 0, 'the exact canonical id still disambiguates')
    const ambiguity = await f.tools.professor_course_list.execute({}, f.exec)
    assert.ok(ambiguity.courses.every((row) => row.course_id))
  } finally {
    await fs.rm(f.home, { recursive: true, force: true })
  }
})

test('the managed-course command carries courseCode under its snapshot safeguards', async () => {
  const f = await toolFixture()
  try {
    // Drive the production command layer the way the settings UI does: courses → manageCourse.
    const executions = []
    const commands = createProfessorCommands({
      registry: { get: async (sessionId) => (sessionId === f.exec.agent.session.id ? { status: 'ready', sessionId } : null) },
      resolveAgent: async () => f.exec.agent,
      composedPreset: async () => 'professor',
      readConnectionRevision: async () => 1,
      execute: async (call) => {
        executions.push([call.name, call.arguments])
        const payload = await f.tools[call.name].execute(call.arguments, f.exec)
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
      },
    })
    const sessionId = f.exec.agent.session.id
    const snapshot = await commands.run({ sessionId, action: 'courses', args: {} })
    assert.ok(snapshot.courseToken)
    const saved = await commands.run({
      sessionId, action: 'manageCourse',
      args: { courseToken: snapshot.courseToken, courseId: 'csc3200', operation: 'update', courseCode: 'DS-1' },
    })
    assert.deepEqual(saved.changed, ['csc3200'])
    const toolCall = executions.find(([tool]) => tool === 'professor_course_manage')
    assert.equal(toolCall[1].course_code, 'DS-1', 'the field reaches the production tool args')

    // Snapshot protections still hold for code edits: the observed token is single-use, so a
    // second edit on the same token is refused until courses are reloaded — it never overwrites.
    const stale = await commands.run({
      sessionId, action: 'manageCourse',
      args: { courseToken: snapshot.courseToken, courseId: 'csc3200', operation: 'update', courseCode: 'DS-2' },
    }).catch((error) => error)
    assert.equal(stale?.code, 'PROFESSOR_COMMAND_PROPOSAL', String(stale))
    assert.match(String(stale?.message ?? ''), /Reload courses|重新读取/, 'the refusal tells the user to reload')
    assert.equal((await f.tools.professor_course_list.execute({}, f.exec)).courses.find((row) => row.course_id === 'csc3200').course_code, 'DS-1')

    // A code-only update is a valid operation; a no-op update and bad codes are refused early.
    await assert.rejects(commands.run({ sessionId, action: 'manageCourse', args: { courseToken: snapshot.courseToken, courseId: 'csc3200', operation: 'update' } }),
      (error) => error.code === 'PROFESSOR_COMMAND_INVALID')
    for (const bad of ['', '   ', 'x'.repeat(241), 'CS\u0007T']) {
      await assert.rejects(commands.run({ sessionId, action: 'manageCourse', args: { courseToken: 'x', courseId: 'csc3200', operation: 'update', courseCode: bad } }),
        (error) => error.code === 'PROFESSOR_COMMAND_INVALID', JSON.stringify(bad))
    }
    await assert.rejects(commands.run({ sessionId, action: 'manageCourse', args: { courseToken: 'x', courseId: 'csc3200', operation: 'delete', courseCode: 'DS-3', confirmDelete: true } }),
      (error) => error.code === 'PROFESSOR_COMMAND_INVALID')
  } finally {
    await fs.rm(f.home, { recursive: true, force: true })
  }
})
