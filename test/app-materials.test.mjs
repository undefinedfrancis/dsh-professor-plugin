import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createMaterialValidator } from '../src/app/materials.js'
import { createFsGateway } from '../src/fs/gateway.js'
import { createPathPolicy } from '../src/paths/policy.js'
import { summarizeCourses } from '../src/courses/registry.js'
import { createFakeFs, makeHome, writeFixture } from './helpers/fake-harness.mjs'

async function fixture() {
  const home = await makeHome('professor-material-validation-')
  const root = path.join(home, 'academic'), relative = 'CSC/lecture.txt'
  await writeFixture(home, 'academic/' + relative, 'Original lecture')
  const gateway = createFsGateway({ ctx: { fs: createFakeFs({ home }) } })
  const target = await gateway.resolveTarget(relative, { cwd: root })
  const { sha256 } = await gateway.hashFile(target)
  const course = { course_id: 'csc', sources: [{ path: path.join(root, 'CSC') }] }
  const connection = { connected: true, projectRoot: root, courses: summarizeCourses({ courses: [course] }) }
  const index = { schema_version: 1, root, files: [{ file_id: 'file-one', course_id: 'csc', relative_path: relative, content_hash: sha256, index_status: 'indexed' }] }
  const create = (overrides = {}) => createMaterialValidator({ catalog: { describe: async () => connection }, readIndex: async () => index, gateway,
    policiesFor: () => ({ read: createPathPolicy({ roots: [root], label: 'read' }) }), ...overrides })
  return { home, root, relative, index, gateway, create, connection }
}

test('material validation resolves stable course/file ids and proves source hash', async () => {
  const f = await fixture()
  const checked = await f.create().validate({ courseId: 'csc', fileId: 'file-one' })
  assert.equal(checked.fileId, 'file-one')
  assert.equal(checked.projectRoot, f.root)
  assert.equal(checked.contentHash, f.index.files[0].content_hash)
})

test('browser paths and unknown or duplicate material ids refuse', async () => {
  const f = await fixture(), validator = f.create()
  await assert.rejects(validator.validate({ courseId: 'csc', fileId: 'file-one', path: '/elsewhere' }), { code: 'PROFESSOR_MATERIAL_INVALID' })
  await assert.rejects(validator.validate({ courseId: 'other', fileId: 'file-one' }), { code: 'PROFESSOR_MATERIAL_COURSE' })
  await assert.rejects(validator.validate({ courseId: 'csc', fileId: 'unknown' }), { code: 'PROFESSOR_MATERIAL_UNKNOWN' })
  f.index.files.push({ ...f.index.files[0] })
  await assert.rejects(validator.validate({ courseId: 'csc', fileId: 'file-one' }), { code: 'PROFESSOR_MATERIAL_INDEX' })
})

test('missing or changed originals never become ready material context', async () => {
  const f = await fixture()
  await writeFixture(f.home, 'academic/' + f.relative, 'Changed lecture')
  await assert.rejects(f.create().validate({ courseId: 'csc', fileId: 'file-one' }), { code: 'PROFESSOR_MATERIAL_CHANGED' })
  f.index.files[0].relative_path = 'CSC/missing.txt'
  await assert.rejects(f.create().validate({ courseId: 'csc', fileId: 'file-one' }), { code: 'PROFESSOR_MATERIAL_MISSING' })
})

test('index root, traversal, course source ownership and read policy are rechecked', async () => {
  const f = await fixture(), row = f.index.files[0]
  f.index.root = '/wrong-project'
  await assert.rejects(f.create().validate({ courseId: 'csc', fileId: row.file_id }), { code: 'PROFESSOR_MATERIAL_INDEX' })
  f.index.root = f.root; row.relative_path = '../outside.txt'
  await assert.rejects(f.create().validate({ courseId: 'csc', fileId: row.file_id }), { code: 'PROFESSOR_MATERIAL_INDEX' })
  row.relative_path = f.relative
  f.connection.courses[0].sources = [path.join(f.root, 'OTHER')]
  await assert.rejects(f.create().validate({ courseId: 'csc', fileId: row.file_id }), { code: 'PROFESSOR_MATERIAL_SOURCE' })
  f.connection.courses[0].sources = [path.join(f.root, 'CSC')]
  await assert.rejects(f.create({ policiesFor: () => ({ read: createPathPolicy({ roots: [] }) }) }).validate({ courseId: 'csc', fileId: row.file_id }), { code: 'PROFESSOR_PATH_DENIED' })
})

test('connection changes while validating refuse before context handoff', async () => {
  const f = await fixture(); let calls = 0
  const validator = f.create({ catalog: { describe: async () => ++calls === 1 ? f.connection : { ...f.connection, projectRoot: '/changed' } } })
  await assert.rejects(validator.validate({ courseId: 'csc', fileId: 'file-one' }), { code: 'PROFESSOR_MATERIAL_CHANGED' })
})

test('a symlink escape is refused before hashing even with broader native read roots', async () => {
  const f = await fixture()
  await writeFixture(f.home, 'outside.txt', 'Not course material')
  await fs.symlink(path.join(f.home, 'outside.txt'), path.join(f.root, 'CSC', 'link.txt'))
  f.index.files[0].relative_path = 'CSC/link.txt'
  let hashes = 0
  const originalHash = f.gateway.hashFile.bind(f.gateway)
  f.gateway.hashFile = (...args) => { hashes++; return originalHash(...args) }
  await assert.rejects(f.create({ policiesFor: () => ({ read: createPathPolicy({ roots: [f.home] }) }) }).validate({ courseId: 'csc', fileId: 'file-one' }), { code: 'PROFESSOR_MATERIAL_SOURCE' })
  assert.equal(hashes, 0)
})

test('unsupported indexes, missing digests and oversized material refuse', async () => {
  const f = await fixture()
  f.index.schema_version = 2
  await assert.rejects(f.create().validate({ courseId: 'csc', fileId: 'file-one' }), { code: 'PROFESSOR_MATERIAL_INDEX' })
  f.index.schema_version = 1
  const hash = f.index.files[0].content_hash; f.index.files[0].content_hash = null
  await assert.rejects(f.create().validate({ courseId: 'csc', fileId: 'file-one' }), { code: 'PROFESSOR_MATERIAL_INDEX' })
  f.index.files[0].content_hash = hash
  f.gateway.stat = async () => ({ type: 'file', size: 33 * 1024 * 1024, version: 'v1' })
  await assert.rejects(f.create().validate({ courseId: 'csc', fileId: 'file-one' }), { code: 'PROFESSOR_MATERIAL_BUDGET' })
})

test('a changed index or cancellation cannot produce validated handoff context', async () => {
  const f = await fixture(); let reads = 0
  await assert.rejects(f.create({ readIndex: async () => {
    reads++
    return reads === 1 ? f.index : { ...f.index, files: [{ ...f.index.files[0], content_hash: 'a'.repeat(64) }] }
  } }).validate({ courseId: 'csc', fileId: 'file-one' }), { code: 'PROFESSOR_MATERIAL_CHANGED' })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.create().validate({ courseId: 'csc', fileId: 'file-one' }, { signal: controller.signal }), { name: 'AbortError' })
})
