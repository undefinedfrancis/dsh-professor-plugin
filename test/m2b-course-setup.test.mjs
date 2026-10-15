/**
 * Regression: the M2b course setup must actually bind the material to the course.
 *
 * The failure this pins is silent by construction. Registering a course **without** `source_path`
 * returns `isError: false` from every tool — the project is written, the file is indexed, the
 * chunks are extracted — while the course ends up owning nothing, the index record stays
 * `course_id: null`, and a course-scoped search returns no hits. A case built that way would be
 * graded against an empty context, and the only visible symptom would be a paid request spent
 * producing nothing.
 *
 * Both tests drive the **real tool contracts** through the fake harness, not the source text of
 * `courses.js`. The negative case is the positive case with exactly one argument removed, so the
 * only difference between "grounded" and "empty" is the parameter itself.
 *
 * The fixture here is a markdown lecture rather than the synthetic PDF: the contract under test is
 * course assignment and course-scoped retrieval, and markdown extracts offline with no PDF runtime,
 * so this suite stays green in the packaged copy too.
 *
 * @module test/m2b-course-setup
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { COURSE_ID } from './helpers/source-grounded-fixture.mjs'
import {
  runCourseSetup, verifyCourseMaterial,
} from './helpers/m2b-course-setup.mjs'
import { createFakeContext, makeExec, makeHome } from './helpers/fake-harness.mjs'

const MATERIAL_RELATIVE = 'CSC3200/01_Lectures/week03-hash-tables.md'
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** Page-2 shaped content, so a hit on it is unambiguously a hit on the course material. */
const MATERIAL = `# Hash Tables

Resize Threshold: the table doubles its bucket count when the load factor reaches 0.75.

## Collision resolution

Avg probes (n=1k) and Avg probes (n=10k) for Linear probing reach 2.94, which suffers primary
clustering. Separate chaining shows none.
`

/**
 * Build the project and run the setup, with or without `source_path`.
 *
 * The negative variant is the positive one with that single argument dropped — nothing else
 * differs — so a pass on the positive case and a failure on the negative isolate the parameter.
 */
async function scenario({ withSourcePath }) {
  const home = await makeHome('professor-m2b-setup-')
  const workspace = path.join(home, 'term')
  const materialRoot = path.join(workspace, 'CSC3200')
  const materialPath = path.join(workspace, MATERIAL_RELATIVE)
  await fs.mkdir(path.dirname(materialPath), { recursive: true })
  await fs.writeFile(materialPath, MATERIAL)
  const independentHash = sha256(await fs.readFile(materialPath))

  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: workspace })
  const execute = async (name, args) => tools[name].execute(args, exec)
  const executeUnderTest = async (name, args) => tools[name].execute(
    name === 'professor_course_manage' && !withSourcePath
      ? { ...args, source_path: undefined }
      : args,
    exec,
  )

  const setup = await runCourseSetup({ execute: executeUnderTest, materialRoot })
  const preflight = await verifyCourseMaterial({
    execute, workspace, materialRoot, independentHash, sourceRelativePath: MATERIAL_RELATIVE,
  })
  return { fake, home, workspace, materialRoot, materialPath, independentHash, setup, preflight }
}

test('registering a course without source_path leaves the material unassigned and retrieval empty', async () => {
  const s = await scenario({ withSourcePath: false })

  // Every tool still reported success. That is the trap this test exists to document: an
  // isError:false envelope says nothing about whether the case would have anything to read.
  assert.equal(s.setup.ok, true,
    `the setup without source_path still "succeeds": ${JSON.stringify(s.setup.steps)}`)
  assert.deepEqual(s.setup.steps.filter((step) => step.isError), [])

  assert.equal(s.preflight.ok, false, 'the preflight must refuse this setup')
  assert.ok(s.preflight.problems.some((problem) => problem.includes('unassigned')),
    JSON.stringify(s.preflight.problems))
  assert.ok(s.preflight.problems.some((problem) => problem.includes('course-scoped search')),
    JSON.stringify(s.preflight.problems))

  const listed = s.preflight.evidence.course_list
  assert.equal(listed.courses.length, 1)
  assert.equal(listed.courses[0].course_id, COURSE_ID)
  assert.equal(listed.courses[0].source_count, 0,
    'the course owns no material, because nothing told it which directory to own')
  assert.deepEqual(listed.courses[0].sources, [])
  assert.equal(listed.assignment.unassigned.count, 1, 'the indexed file is reported unassigned')
  assert.deepEqual(listed.assignment.unassigned.sample, [MATERIAL_RELATIVE])

  assert.equal(s.preflight.evidence.index_record.course_id, null,
    'the index record carries no course')
  assert.equal(s.preflight.evidence.index_record.category, 'unassigned')
  assert.equal(s.preflight.evidence.index_record.index_status, 'indexed',
    'the file really is indexed — it is only the course association that is missing')
  assert.equal(s.preflight.evidence.retrieval.total_hits, 0,
    'a course-scoped search finds nothing, so the case would have no grounding')
  assert.deepEqual(s.preflight.evidence.retrieval.hits_on_source, [])
})

test('the formal setup registers the material through source_path and retrieval returns it', async () => {
  const s = await scenario({ withSourcePath: true })

  assert.equal(s.setup.ok, true, JSON.stringify(s.setup.steps))
  const manage = s.setup.results.professor_course_manage
  assert.equal(manage.action, 'register')
  assert.deepEqual(manage.course.sources.map((source) => source.path), [s.materialRoot],
    'the tool result itself reports the registered source, rather than this test trusting the call')

  assert.deepEqual(s.preflight.problems, [], JSON.stringify(s.preflight.problems))
  assert.equal(s.preflight.ok, true)

  const listed = s.preflight.evidence.course_list
  assert.equal(listed.courses.length, 1, 'exactly one selected course')
  assert.equal(listed.courses[0].course_id, COURSE_ID)
  assert.equal(listed.courses[0].source_count, 1)
  assert.deepEqual(listed.courses[0].sources, [s.materialRoot])
  assert.equal(listed.assignment.unassigned.count, 0, 'nothing is left unassigned')

  assert.equal(s.preflight.evidence.session_status.bound, true)
  assert.equal(s.preflight.evidence.session_status.course_id, COURSE_ID)

  const record = s.preflight.evidence.index_record
  assert.match(record.file_id, /^f_/, 'a stable file id')
  assert.equal(record.content_hash, s.independentHash, 'the index hash matches an independent digest')
  assert.equal(record.course_id, COURSE_ID, 'the file is assigned to the course')
  assert.equal(record.index_status, 'indexed')
  assert.equal(record.extraction_status, 'extracted')

  assert.ok(s.preflight.evidence.retrieval.hits_on_source.length >= 1,
    `a course-scoped search returns the source: ${JSON.stringify(s.preflight.evidence.retrieval)}`)
  assert.ok(s.preflight.evidence.retrieval.hits_on_source.every((hit) => hit.coordinate !== null),
    'every delivered hit carries a citable coordinate, so it can be credited as delivered coverage')
  assert.equal(s.preflight.evidence.retrieval.hits_on_source[0].coordinate.kind, 'lines',
    'a markdown chunk is cited by its line range, not by a page it does not have')

  // Setup never rewrites the material it indexes.
  assert.equal(await fs.readFile(s.materialPath, 'utf8'), MATERIAL)
})
