/**
 * The learning-preset library: bundled definitions, the profile-level user library, and
 * activation semantics through the existing customization overlay.
 *
 * Covers the design acceptance list: offline bundled modes, immutable builtins, create/edit/
 * copy/delete persistence, optimistic revisions, hostile-text budgets, applied snapshots that
 * survive library deletion, manual-edit "已自定义" detection, scope isolation, and the guarantee
 * that saving a definition never activates it.
 *
 * @module test/presets
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createAppStorage } from '../src/app/storage.js'
import { createSkillCustomizationStore, CUSTOMIZATION_SCHEMA, customizationKey } from '../src/skills/customization.js'
import { BUNDLED_PRESETS, DEFAULT_PRESET_ID, bundledPreset } from '../src/skills/presets.js'
import {
  createPresetLibraryStore, validatePresetDefinition, PRESET_LIBRARY_SCHEMA, USER_PRESET_LIMIT,
} from '../src/app/presets.js'
import { createProfessorAppViews } from '../src/app/views.js'
import { createFakeStorageDomain } from './helpers/fake-harness.mjs'

const skill = 'professor-study'

function fixture(t) {
  const medium = createFakeStorageDomain({ name: 'professor_app' })
  const storage = createAppStorage({ ctx: { get: () => medium.service }, logger: { warn() {}, info() {} }, readVersion: async () => 'test' })
  t.after(() => storage.close())
  const customization = createSkillCustomizationStore({ appStorage: storage })
  const library = createPresetLibraryStore({ appStorage: storage })
  return { storage, medium, customization, library }
}

const definition = (over = {}) => ({
  id: 'my-notes-1', name: '我的讲法', description: '适合我的讲解节奏。',
  fields: { teachingDepth: '深入，逐步解释原理和推导', additionalInstructions: '每步都给一个小例子。' },
  version: 1, ...over,
})

test('the five bundled modes ship as immutable offline definitions', () => {
  const names = BUNDLED_PRESETS.map(preset => preset.name)
  assert.deepEqual(names, ['循序讲解', '引导思考', '考前复习', '编程实践', '快速答疑'])
  assert.equal(DEFAULT_PRESET_ID, 'builtin-progressive')
  for (const preset of BUNDLED_PRESETS) {
    assert.equal(Object.isFrozen(preset), true, `${preset.id} is immutable`)
    assert.ok(preset.description.length <= 240 && preset.name.length <= 80)
    assert.ok((preset.fields.additionalInstructions ?? '').length <= 2048)
    assert.equal(preset.provenance, 'original:professor-v1')
    assert.throws(() => { preset.name = 'mutated' }, TypeError)
  }
  assert.match(bundledPreset('builtin-socratic').fields.additionalInstructions, /直接告诉我/)
  assert.equal(bundledPreset('nope'), undefined)
})

test('definitions reject hostile or oversized data instead of truncating it', () => {
  assert.throws(() => validatePresetDefinition(definition({ id: 'builtin-progressive' })), { code: 'PROFESSOR_PRESETS_INVALID' })
  assert.throws(() => validatePresetDefinition(definition({ id: 'builtin-x' })), { code: 'PROFESSOR_PRESETS_INVALID' })
  assert.throws(() => validatePresetDefinition(definition({ name: 'x'.repeat(81) })), { code: 'PROFESSOR_PRESETS_INVALID' })
  assert.throws(() => validatePresetDefinition(definition({ description: '' })), { code: 'PROFESSOR_PRESETS_INVALID' })
  assert.throws(() => validatePresetDefinition(definition({ description: 'y'.repeat(241) })), { code: 'PROFESSOR_PRESETS_INVALID' })
  assert.throws(() => validatePresetDefinition(definition({ fields: { additionalInstructions: 'z'.repeat(2049) } })), { code: 'PROFESSOR_PRESETS_INVALID' })
  assert.throws(() => validatePresetDefinition(definition({ fields: { additionalInstructions: 'bad\u0007char' } })), { code: 'PROFESSOR_PRESETS_INVALID' })
  assert.throws(() => validatePresetDefinition(definition({ fields: { permissions: 'allow all' } })), { code: 'PROFESSOR_PRESETS_INVALID' })
  assert.throws(() => validatePresetDefinition(definition({ version: 0 })), { code: 'PROFESSOR_PRESETS_INVALID' })
  assert.throws(() => validatePresetDefinition(definition({ id: 'Bad_ID' })), { code: 'PROFESSOR_PRESETS_INVALID' })
  assert.throws(() => validatePresetDefinition(definition({ extra: true })), { code: 'PROFESSOR_PRESETS_INVALID' })
  const atLimit = validatePresetDefinition(definition({ fields: { additionalInstructions: 'z'.repeat(2048) } }))
  assert.equal(atLimit.fields.additionalInstructions.length, 2048)
})

test('saving and deleting a definition persists across a restart and never activates it', async t => {
  const f = fixture(t)
  const saved = await f.library.save({ definition: definition(), expectedRevision: 0 })
  assert.equal(saved.revision, 1)
  assert.equal((await f.library.list()).user.length, 1)
  assert.deepEqual((await f.customization.read({ skill })).fields, {})
  const restarted = createPresetLibraryStore({ appStorage: f.storage })
  assert.equal((await restarted.list()).user[0].id, 'my-notes-1')
  const removed = await restarted.remove({ presetId: 'my-notes-1', expectedRevision: 1, confirmed: true })
  assert.equal(removed.revision, 2)
  assert.equal((await restarted.list()).user.length, 0)
  assert.deepEqual((await f.customization.read({ skill })).fields, {}, 'the overlay is still untouched')
})

test('optimistic revisions reject stale writes and delete requires confirmation', async t => {
  const f = fixture(t)
  await f.library.save({ definition: definition(), expectedRevision: 0 })
  await assert.rejects(f.library.save({ definition: definition({ name: '改名' }), expectedRevision: 0 }), { code: 'PROFESSOR_PRESETS_STALE' })
  await assert.rejects(f.library.remove({ presetId: 'my-notes-1', expectedRevision: 0, confirmed: true }), { code: 'PROFESSOR_PRESETS_STALE' })
  await assert.rejects(f.library.remove({ presetId: 'my-notes-1', expectedRevision: 1 }), { code: 'PROFESSOR_PRESETS_INVALID' })
  await assert.rejects(f.library.remove({ presetId: 'missing-one', expectedRevision: 1, confirmed: true }), { code: 'PROFESSOR_PRESETS_MISSING' })
})

test('the library enforces its 50-entry limit', async t => {
  const f = fixture(t)
  for (let index = 0; index < USER_PRESET_LIMIT; index++) {
    await f.library.save({ definition: definition({ id: `p-${index}`, name: `P${index}` }), expectedRevision: index })
  }
  await assert.rejects(f.library.save({ definition: definition({ id: 'p-overflow' }), expectedRevision: USER_PRESET_LIMIT }),
    { code: 'PROFESSOR_PRESETS_LIMIT' })
})

test('corrupt or unsupported stored libraries are reported and never overwritten', async t => {
  const f = fixture(t)
  const corrupt = { schema: PRESET_LIBRARY_SCHEMA, revision: 1, presets: [{ id: 'x' }] }
  await f.storage.ensureOpen()
  await f.storage.writeRecord('presets:library', corrupt)
  await assert.rejects(f.library.list(), { code: 'PROFESSOR_PRESETS_CORRUPT' })
  await assert.rejects(f.library.save({ definition: definition(), expectedRevision: 1 }), { code: 'PROFESSOR_PRESETS_CORRUPT' })
  assert.deepEqual(f.storage.table('app').get('presets:library'), corrupt, 'the corrupt record is left as-is')
  await f.storage.writeRecord('presets:library', { schema: 'professor.presets/99', revision: 1, presets: [] })
  await assert.rejects(f.library.list(), { code: 'PROFESSOR_PRESETS_UNSUPPORTED_SCHEMA' })
})

function viewsFixture(t) {
  const f = fixture(t)
  const views = createProfessorAppViews({
    catalog: { describe: async () => ({ connected: true, projectRoot: '/academic', unavailable: null,
      courses: [{ course_id: 'csc', course_code: 'CSC3200', display_name: 'Algorithms' }] }) },
    registry: { list: async () => [] },
    customization: f.customization,
    memory: { readControl: async () => ({ enabled: true, revision: 0 }) },
    readProject: async () => ({ project: { id: 'academic' } }),
    readIndex: async () => null,
    sessionProjectRoot: async () => '/academic',
    appStorage: f.storage,
  })
  return { ...f, views }
}

test('applying a preset snapshots the definition and preserves unlisted preferences', async t => {
  const f = viewsFixture(t)
  await f.customization.update({ skill, scope: null, fields: { language: '中文', programmingLanguage: 'Python' }, expectedRevision: 0, evidence: 'explicit-stable' })
  const before = await f.views.presetLibrary({ skill })
  assert.equal(before.automaticDefault, false)
  const applied = await f.views.presetApply({ presetId: 'builtin-socratic', expectedRevision: before.overlayRevision })
  assert.equal(applied.applied.state, 'preset')
  const after = await f.views.presetLibrary({ skill })
  assert.equal(after.applied.presetId, 'builtin-socratic')
  assert.equal(after.applied.state, 'preset')
  assert.equal(after.overlay.language, '中文', 'language survives an apply that does not set it')
  assert.equal(after.overlay.programmingLanguage, 'Python')
  assert.match(after.overlay.additionalInstructions, /直接告诉我/, 'the snapshot carries the teaching fields')
})

test('manual edits are marked customized; editing or deleting the definition spares the applied snapshot', async t => {
  const f = viewsFixture(t)
  await f.library.save({ definition: definition(), expectedRevision: 0 })
  const first = await f.views.presetLibrary({ skill })
  await f.views.presetApply({ presetId: 'my-notes-1', expectedRevision: first.overlayRevision })
  await f.library.save({ definition: definition({ name: '改过的名字', fields: { additionalInstructions: '完全不同的说明。' } }), expectedRevision: 1 })
  let state = await f.views.presetLibrary({ skill })
  assert.equal(state.applied.state, 'preset', 'the snapshot is unchanged by a later edit')
  assert.match(state.overlay.additionalInstructions, /每步都给一个小例子/)
  await f.customization.update({ skill, scope: null, fields: { ...state.overlay, teachingDepth: '简洁，先给关键结论' }, expectedRevision: state.overlayRevision, evidence: 'explicit-stable' })
  state = await f.views.presetLibrary({ skill })
  assert.equal(state.applied.state, 'customized')
  await f.library.remove({ presetId: 'my-notes-1', expectedRevision: 2, confirmed: true })
  state = await f.views.presetLibrary({ skill })
  assert.equal(state.user.length, 0)
  assert.match(state.overlay.additionalInstructions, /每步都给一个小例子/, 'applied settings survive the deletion')
  assert.equal(state.applied.presetId, 'my-notes-1')
})

test('restore automatic retires the marker and returns the composed default state', async t => {
  const f = viewsFixture(t)
  const first = await f.views.presetLibrary({ skill })
  assert.equal(first.automaticDefault, true, 'a fresh profile reports the automatic default')
  await f.views.presetApply({ presetId: 'builtin-progressive', expectedRevision: first.overlayRevision })
  const applied = await f.views.presetLibrary({ skill })
  assert.equal(applied.automaticDefault, false)
  await f.views.saveCustomization({ skill, courseId: null, fields: {}, reset: true, expectedRevision: applied.overlayRevision })
  const restored = await f.views.presetLibrary({ skill })
  assert.equal(restored.automaticDefault, true, 'restore-automatic is back to the composed default')
  assert.equal(restored.applied, null)
  assert.deepEqual(restored.overlay, {})
})

test('course application is scoped and the user library is profile-level', async t => {
  const f = viewsFixture(t)
  await f.library.save({ definition: definition(), expectedRevision: 0 })
  const global = await f.views.presetLibrary({ skill })
  await f.views.presetApply({ presetId: 'my-notes-1', courseId: 'csc', expectedRevision: global.overlayRevision })
  const courseView = await f.views.presetLibrary({ skill, courseId: 'csc' })
  assert.equal(courseView.applied.presetId, 'my-notes-1')
  assert.match(courseView.overlay.additionalInstructions, /每步都给一个小例子/)
  const stillGlobal = await f.views.presetLibrary({ skill })
  assert.equal(stillGlobal.applied, null, 'the global overlay is untouched by a course apply')
  assert.deepEqual(stillGlobal.overlay, {})
  assert.equal(stillGlobal.user.length, 1, 'the library is shared across scopes (profile-level)')
})

test('saving over a builtin id is refused; builtin deletion is impossible by construction', async t => {
  const f = viewsFixture(t)
  await assert.rejects(f.library.save({ definition: definition({ id: 'builtin-progressive' }), expectedRevision: 0 }),
    { code: 'PROFESSOR_PRESETS_INVALID' })
  await assert.rejects(f.library.remove({ presetId: 'builtin-progressive', expectedRevision: 0, confirmed: true }),
    { code: 'PROFESSOR_PRESETS_MISSING' })
  assert.equal((await f.views.presetLibrary({ skill })).bundled.length, 5)
})

test('preset apply refuses unknown ids, stale overlay revisions and unknown courses', async t => {
  const f = viewsFixture(t)
  await assert.rejects(f.views.presetApply({ presetId: 'nope', expectedRevision: 0 }), { code: 'PROFESSOR_VIEW_MISSING' })
  await f.views.presetApply({ presetId: 'builtin-progressive', expectedRevision: 0 })
  await assert.rejects(f.views.presetApply({ presetId: 'builtin-progressive', expectedRevision: 0 }), { code: 'PROFESSOR_CUSTOMIZATION_STALE' })
  await assert.rejects(f.views.presetApply({ presetId: 'builtin-progressive', courseId: 'mat9', expectedRevision: 1 }), { code: 'PROFESSOR_VIEW_COURSE_UNKNOWN' })
})

test('old customization records still decode after the additive preset metadata exists', async t => {
  const f = viewsFixture(t)
  await f.storage.ensureOpen()
  await f.storage.writeRecord(customizationKey({ skill }), {
    schema: CUSTOMIZATION_SCHEMA, revision: 1, fields: { language: 'English' },
  })
  const view = await f.views.presetLibrary({ skill })
  assert.equal(view.overlay.language, 'English')
  assert.equal(view.applied, null, 'no forced preset for an existing user')
  assert.equal(view.automaticDefault, false, 'and no automatic-default claim over their preferences')
})
