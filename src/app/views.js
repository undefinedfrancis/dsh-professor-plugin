/** Read models over existing course/index/session/overlay stores. No new academic database. */
import { courseMemoryNamespace } from '../memory/store.js'
import { validateCustomizationFields, CUSTOMIZABLE_SKILLS } from '../skills/customization.js'
import { createPresetLibraryStore, bundledPreset, DEFAULT_PRESET_ID } from './presets.js'
import { CATEGORIES } from '../indexer/classify.js'

const fail = (suffix, message) => Object.assign(new Error(message), { code: `PROFESSOR_VIEW_${suffix}` })
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const detached = value => JSON.parse(JSON.stringify(value))
const short = (value, max = 240) => typeof value === 'string' ? value.slice(0, max) : null
const courseSummary = value => value === null ? null : Object.fromEntries(
  ['course_id', 'course_code', 'display_name', 'term', 'status'].map(key => [key, short(value[key])]))
const validMaterial = row => plain(row) && ['file_id', 'relative_path', 'index_status'].every(key =>
  typeof row[key] === 'string' && row[key].trim().length > 0)
  && (row.course_id === null || typeof row.course_id === 'string')

function request(value, allowed) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key))) throw fail('INVALID', 'Unexpected view request fields')
  if (value.courseId != null && (typeof value.courseId !== 'string' || !value.courseId.trim() || value.courseId.length > 128)) throw fail('INVALID', 'Expected a bounded course identifier')
  return value
}

export function createProfessorAppViews({ catalog, registry, customization, memory, readProject, readIndex, sessionProjectRoot, onMemoryChanged, appStorage, queueOwner }) {
  const presets = createPresetLibraryStore({ appStorage, queueOwner: queueOwner ?? appStorage })

  /** Applied-preset state: 'preset' (overlay matches the snapshot), 'customized' (edited since), or null. */
  async function appliedState(selector, overlay) {
    const applied = await presets.readApplied(selector)
    if (applied === null) return null
    const same = JSON.stringify(Object.keys(applied.fields).sort().map(key => [key, applied.fields[key]]))
      === JSON.stringify(Object.keys(overlay.fields).sort().map(key => [key, overlay.fields[key]]))
    return { presetId: applied.presetId, presetVersion: applied.presetVersion, overlayRevision: applied.overlayRevision, state: same ? 'preset' : 'customized' }
  }

  async function presetBlock(skill, courseId) {
    const { scope } = await context(courseId ?? null)
    const library = await presets.list()
    const overlay = scope === null ? await customization.read({ skill }) : await customization.read({ skill, scope })
    const selector = scope === null ? { skill } : { skill, scope }
    const applied = await appliedState(selector, overlay)
    return {
      bundled: library.bundled,
      user: library.user,
      userRevision: library.revision,
      defaultPresetId: library.defaultPresetId,
      applied,
      overlay: overlay.fields,
      overlayRevision: overlay.revision,
      automaticDefault: applied === null && Object.keys(overlay.fields).length === 0,
    }
  }
  async function context(courseId = null) {
    const connection = await catalog.describe()
    if (connection.unavailable) throw fail('UNAVAILABLE', connection.unavailable)
    if (courseId === null) return { connection, course: null, scope: null }
    if (!connection.connected) throw fail('COURSE_UNAVAILABLE', 'Connect an academic folder before selecting a course')
    const course = connection.courses.find(row => row.course_id === courseId)
    if (!course) throw fail('COURSE_UNKNOWN', 'This course is not registered in the connected academic folder')
    const document = await readProject(connection.projectRoot)
    const id = document?.project?.id
    if (typeof id !== 'string' || !id) throw fail('UNAVAILABLE', 'Connected project identity is unavailable')
    return { connection, course, scope: { namespace: courseMemoryNamespace(id, connection.projectRoot), courseId: course.course_id } }
  }

  async function course(args) {
    request(args, ['courseId', 'offset'])
    if (args.courseId == null) throw fail('INVALID', 'A course identifier is required')
    const offset = args.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw fail('INVALID', 'Material offset must be a nonnegative integer')
    const { connection, course: selected } = await context(args.courseId)
    let index, indexState
    try {
      index = await readIndex(connection.projectRoot)
      indexState = index == null ? { status: 'missing' }
        : index.schema_version !== 1 ? { status: 'unsupported', schema: index.schema_version ?? null }
          : !Array.isArray(index.files) || !index.files.every(validMaterial) ? { status: 'corrupt' }
            : { status: 'indexed', generatedAt: short(index.generated_at) }
    } catch (error) { indexState = { status: 'unavailable', message: short(error.message) } }
    const records = indexState.status === 'indexed' ? index.files.filter(row => row?.course_id === selected.course_id) : []
    const categories = Object.create(null)
    for (const row of records) {
      const category = CATEGORIES.has(row.category) ? row.category : 'unassigned'
      categories[category] = (categories[category] ?? 0) + 1
    }
    const materials = records.slice(offset, offset + 50).map(row => ({
      fileId: short(row.file_id, 128), name: short(row.relative_path, 240), category: CATEGORIES.has(row.category) ? row.category : 'unassigned',
      indexStatus: short(row.index_status, 64),
      // An index entry is not proof that the original still exists. Launch revalidation is separate.
      availability: 'not-checked',
    }))
    const recent = []
    let historyUnavailable = typeof sessionProjectRoot !== 'function'
    if (!historyUnavailable) {
      for (const row of (await registry.list()).filter(entry => entry.courseId === selected.course_id)) {
        let root
        try { root = await sessionProjectRoot(row.sessionId) } catch { historyUnavailable = true; continue }
        if (root == null) { historyUnavailable = true; continue }
        if (root !== connection.projectRoot) continue
        recent.push(Object.fromEntries(['sessionId', 'courseId', 'title', 'mode', 'status', 'updatedAt'].map(key => [key, short(row[key])])) )
        if (recent.length === 10) break
      }
    }
    return detached({ course: courseSummary(selected), index: indexState, categories, materials, recent, historyUnavailable,
      total: records.length, offset, nextOffset: offset + materials.length < records.length ? offset + materials.length : null })
  }

  async function settings(args = {}) {
    request(args, ['skill', 'courseId'])
    const skill = args.skill ?? 'professor-study'
    const { connection, course, scope } = await context(args.courseId ?? null)
    const global = await customization.read({ skill })
    const overlay = scope === null ? global : await customization.read({ skill, scope })
    let control
    try {
      const value = await memory.readControl()
      control = { status: 'available', enabled: value.enabled, revision: value.revision ?? null }
    } catch (error) { control = { status: 'unavailable', enabled: null, message: short(error.message) } }
    return detached({ connection: { connected: connection.connected, folder: connection.projectRoot },
      courses: connection.courses.map(courseSummary), course: courseSummary(course), skill, global, overlay, memory: control,
      presets: await presetBlock(skill, args.courseId ?? null) })
  }

  async function saveCustomization(args) {
    request(args, ['skill', 'courseId', 'fields', 'expectedRevision', 'reset'])
    if (args.reset !== undefined && typeof args.reset !== 'boolean') throw fail('INVALID', 'Reset must be boolean')
    // Freeze caller-owned settings before waiting for course/project IO.
    const snapshot = { skill: args.skill, courseId: args.courseId ?? null,
      fields: args.reset === true ? {} : validateCustomizationFields(args.fields),
      expectedRevision: args.expectedRevision, reset: args.reset ?? false }
    const { scope } = await context(snapshot.courseId ?? null)
    const mutation = { skill: snapshot.skill, scope, fields: snapshot.fields,
      expectedRevision: snapshot.expectedRevision, evidence: 'explicit-stable' }
    const result = snapshot.reset === true ? customization.reset(mutation) : customization.update(mutation)
    const settled = await result
    if (snapshot.reset === true) {
      // "Restore automatic" also retires the applied-preset marker; a plain manual edit does not,
      // so the UI can show "已自定义" against the last applied snapshot.
      await presets.writeApplied(scope === null ? { skill: snapshot.skill } : { skill: snapshot.skill, scope }, null)
    }
    return settled
  }

  // --- learning presets -----------------------------------------------------
  // Preset writes go through the same customization store and scope rules as manual preferences;
  // the library is profile-level and never lives in a course-material folder.

  async function presetLibrary(args = {}) {
    request(args, ['skill', 'courseId'])
    return detached(await presetBlock(args.skill ?? 'professor-study', args.courseId ?? null))
  }

  async function presetSave(args = {}) {
    request(args, ['definition', 'expectedRevision'])
    // Saving a definition never activates it; activation is the explicit apply below.
    return presets.save({ definition: args.definition, expectedRevision: args.expectedRevision })
  }

  async function presetDelete(args = {}) {
    request(args, ['presetId', 'expectedRevision', 'confirmed'])
    return presets.remove({ presetId: args.presetId, expectedRevision: args.expectedRevision, confirmed: args.confirmed === true })
  }

  async function presetApply(args = {}) {
    request(args, ['presetId', 'courseId', 'expectedRevision'])
    const skill = 'professor-study'
    if (!CUSTOMIZABLE_SKILLS.includes(skill)) throw fail('INVALID', 'Presets apply to the study skill only')
    const definition = bundledPreset(args.presetId) ?? (await presets.list()).user.find(row => row.id === args.presetId)
    if (definition === undefined) throw fail('MISSING', 'No preset with this id')
    const { scope } = await context(args.courseId ?? null)
    const selector = scope === null ? { skill } : { skill, scope }
    // Activation copies a validated snapshot into the overlay through the existing store, merging
    // the definition over the current fields: a preference the definition does not set (language,
    // programming language) is preserved unless the preview explicitly showed it changing.
    const current = await customization.read({ skill, scope })
    const merged = validateCustomizationFields({ ...current.fields, ...validateCustomizationFields(definition.fields) })
    const overlay = await customization.update({
      skill, scope, fields: merged,
      expectedRevision: args.expectedRevision, evidence: 'explicit-stable',
    })
    const applied = await presets.writeApplied(selector, {
      presetId: definition.id, presetVersion: definition.version,
      overlayRevision: overlay.revision, fields: merged,
    })
    return { overlayRevision: overlay.revision, applied: { presetId: applied.presetId, presetVersion: applied.presetVersion, overlayRevision: applied.overlayRevision, state: 'preset' } }
  }

  async function setMemoryEnabled(args) {
    request(args, ['enabled', 'expectedRevision'])
    if (typeof args.enabled !== 'boolean' || !Object.hasOwn(args, 'expectedRevision') ||
      (args.expectedRevision !== null && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1))) {
      throw fail('INVALID', 'Memory changes require a boolean and the observed revision')
    }
    const result = await memory.setEnabled({ enabled: args.enabled, expectedRevision: args.expectedRevision ?? undefined, reason: 'Explicit Settings change' })
    let refresh = 'complete'
    try { if ((await onMemoryChanged?.())?.degraded === true) refresh = 'failed' } catch { refresh = 'failed' }
    return { enabled: result.record.enabled, revision: result.revision, refresh }
  }
  return { course, settings, saveCustomization, setMemoryEnabled, presetLibrary, presetSave, presetDelete, presetApply }
}
