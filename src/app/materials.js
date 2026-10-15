/** Server-side stable-ID source validation. Internal context only; no browser path authority. */
import path from 'node:path'
import { isInside, hasTraversal } from '../paths/policy.js'

const fail = (suffix, message) => Object.assign(new Error(message), { code: 'PROFESSOR_MATERIAL_' + suffix })
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const id = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 128
const MAX_BYTES = 32 * 1024 * 1024

export function createMaterialValidator({ catalog, readIndex, gateway, policiesFor }) {
  function select(index, root, courseId, fileId) {
    if (!plain(index) || index.schema_version !== 1 || index.root !== root || !Array.isArray(index.files)) throw fail('INDEX', 'Reload the material index for this academic folder')
    const matches = index.files.filter(row => row?.file_id === fileId)
    if (matches.length === 0) throw fail('UNKNOWN', 'This material is no longer indexed')
    if (matches.length !== 1) throw fail('INDEX', 'Material ID is ambiguous in the index')
    const row = matches[0]
    if (!plain(row) || row.course_id !== courseId) throw fail('SOURCE', 'Material does not belong to the selected course')
    if (typeof row.relative_path !== 'string' || !row.relative_path || row.relative_path.length > 4096 ||
        path.isAbsolute(row.relative_path) || hasTraversal(row.relative_path) || row.relative_path.includes('\\') || row.relative_path.includes('\0')) throw fail('INDEX', 'Material path in the index is invalid')
    if (row.index_status === 'missing') throw fail('MISSING', 'Material is marked missing; rescan the folder')
    if (typeof row.content_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.content_hash)) throw fail('INDEX', 'Material content fingerprint is unavailable; rebuild the index')
    return { fileId, courseId, relativePath: row.relative_path, contentHash: row.content_hash }
  }
  async function validate(input, { signal } = {}) {
    if (!plain(input) || Reflect.ownKeys(input).some(key => !['courseId', 'fileId'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value')) || !id(input.courseId) || !id(input.fileId)) throw fail('INVALID', 'Choose a bounded course ID and material ID only')
    const { courseId, fileId } = input
    signal?.throwIfAborted()
    const connection = await catalog.describe()
    if (!connection.connected || connection.unavailable || typeof connection.projectRoot !== 'string' || !path.isAbsolute(connection.projectRoot)) throw fail('COURSE', 'Connect a readable academic folder first')
    const course = connection.courses.find(row => row.course_id === courseId)
    if (!course) throw fail('COURSE', 'Course is not registered in this academic folder')
    const root = connection.projectRoot
    const sources = JSON.stringify(course.sources ?? [])
    const selected = select(await readIndex(root), root, courseId, fileId)
    const rootTarget = await gateway.resolveTarget(root, { cwd: root, signal })
    const target = await gateway.resolveTarget(selected.relativePath, { cwd: root, signal })
    const canonical = gateway.canonical(target)
    const readPolicy = policiesFor(root)?.read
    if (typeof readPolicy?.assert !== 'function') throw fail('UNAVAILABLE', 'Native source read policy is unavailable')
    readPolicy.assert(selected.relativePath, canonical)
    if (!isInside(gateway.canonical(rootTarget), canonical)) throw fail('SOURCE', 'Material resolves outside the indexed academic folder')
    let owned = false
    for (const source of course.sources ?? []) {
      // The app catalog uses summarizeCourses(): source roots are path strings, not raw YAML objects.
      if (typeof source !== 'string' || !path.isAbsolute(source)) continue
      const sourceTarget = await gateway.resolveTarget(source, { cwd: root, signal })
      if (isInside(gateway.canonical(sourceTarget), canonical)) { owned = true; break }
    }
    if (!owned) throw fail('SOURCE', 'Material resolves outside the configured course sources')
    const before = await gateway.stat(target, signal)
    if (!before || before.type !== 'file') throw fail('MISSING', 'The original material is missing or not a file')
    if (!Number.isFinite(before.size) || before.size < 0 || before.size > MAX_BYTES) throw fail('BUDGET', 'Material exceeds the bounded validation budget')
    const digest = await gateway.hashFile(target, signal, MAX_BYTES)
    const after = await gateway.stat(target, signal)
    if (!after || before.version === undefined || after.version !== before.version || after.size !== before.size || digest.sha256 !== selected.contentHash) throw fail('CHANGED', 'Original material changed; rebuild the index before opening it')
    const current = await catalog.describe()
    const currentCourse = current.courses?.find(row => row.course_id === courseId)
    if (!current.connected || current.unavailable || current.projectRoot !== root || JSON.stringify(currentCourse?.sources ?? []) !== sources) throw fail('CHANGED', 'Academic folder or course sources changed during validation')
    if (JSON.stringify(select(await readIndex(root), root, courseId, fileId)) !== JSON.stringify(selected)) throw fail('CHANGED', 'Material index changed during validation')
    signal?.throwIfAborted()
    return { ...selected, projectRoot: root, target, observedVersion: after.version }
  }
  return { validate }
}
