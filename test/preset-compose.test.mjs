/**
 * Learning presets reach the model only through the existing composition pipeline.
 *
 * Proves the design's Stage-5 requirement without a paid model call: a fresh profile composes the
 * default 循序讲解 teaching mode, an applied preset changes the **next** composed study body (never
 * a previously returned one), and a learner's own saved preferences keep their documented
 * precedence with no forced replacement.
 *
 * @module test/preset-compose
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { bundledPreset, DEFAULT_PRESET_ID } from '../src/skills/presets.js'
import { createPresetLibraryStore } from '../src/app/presets.js'
import { createFakeContext, createFakeStorageDomain } from './helpers/fake-harness.mjs'

const skill = 'professor-study'

test('first-use teaching loads a deep explanation preference without persisting it', async t => {
  const medium = createFakeStorageDomain({ name: 'professor_app' })
  const services = new Map()
  const fake = createFakeContext({ services: { storageDomain: medium.service } })
  fake.ctx.provide = (name, value) => services.set(name, value)
  await apply(fake.ctx, {})
  t.after(() => fake.disposeAll())
  const provider = fake.providers[0]()
  const candidate = (await provider.list()).find(row => row.name === skill)
  const body = (await provider.get(candidate)).content
  assert.match(body, /teachingDepth: 深入，逐步解释原理和推导/,
    'a first-use learner must receive the approved depth through the real provider')
  assert.deepEqual((await services.get('professorAppStorage').skillCustomization.read({ skill })).fields, {},
    'the composed default must not become a saved preference or overwrite future choices')
})

test('a fresh profile composes the default 循序讲解 teaching mode through normal composition', async t => {
  const medium = createFakeStorageDomain({ name: 'professor_app' })
  const fake = createFakeContext({ services: { storageDomain: medium.service } })
  fake.ctx.provide = () => {}

  await apply(fake.ctx, {})
  t.after(() => fake.disposeAll())
  const provider = fake.providers[0]()
  const candidate = (await provider.list()).find(row => row.name === 'professor-study')
  const body = (await provider.get(candidate)).content
  const defaults = bundledPreset(DEFAULT_PRESET_ID).fields
  assert.match(body, new RegExp(defaults.teachingDepth.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(body, /循序渐进的顺序教学/)
  assert.match(body, /<professor_mandatory_boundaries>/)
})

test('applying a preset changes the next composed body and never rewrites a previous one', async t => {
  const medium = createFakeStorageDomain({ name: 'professor_app' })
  const services = new Map()
  const fake = createFakeContext({ services: { storageDomain: medium.service } })
  fake.ctx.provide = (name, value) => services.set(name, value)
  await apply(fake.ctx, {})
  t.after(() => fake.disposeAll())
  const provider = fake.providers[0]()
  const candidate = (await provider.list()).find(row => row.name === 'professor-study')
  const before = await provider.get(candidate)
  assert.match(before.content, /循序渐进的顺序教学/, 'the default is active before any choice')

  // Activation, exactly as views.presetApply performs it: snapshot fields into the overlay,
  // through the same shared storage facet the plugin itself uses.
  const shared = services.get('professorAppStorage')
  const customization = shared.skillCustomization
  const presets = createPresetLibraryStore({ appStorage: shared.acquire('preset-compose-test') })
  const applied = bundledPreset('builtin-quick-answers')
  await customization.update({ skill, scope: null, fields: { ...applied.fields }, expectedRevision: 0, evidence: 'explicit-stable' })
  await presets.writeApplied({ skill }, { presetId: applied.id, presetVersion: applied.version, overlayRevision: 1, fields: { ...applied.fields } })

  const after = await provider.get(candidate)
  assert.match(after.content, /快速答疑模式：第一句先给出明确答案/, 'the next composed body uses the applied preset')
  assert.doesNotMatch(after.content, /循序渐进的顺序教学/, 'the previous preset is not still used')
  assert.match(before.content, /循序渐进的顺序教学/, 'the earlier composed body was not rewritten')
})

test('a learner\'s own saved preferences keep precedence and never receive a forced preset', async t => {
  const medium = createFakeStorageDomain({ name: 'professor_app' })
  const services = new Map()
  const fake = createFakeContext({ services: { storageDomain: medium.service } })
  fake.ctx.provide = (name, value) => services.set(name, value)
  await apply(fake.ctx, {})
  t.after(() => fake.disposeAll())
  const provider = fake.providers[0]()
  const candidate = (await provider.list()).find(row => row.name === 'professor-study')
  const customization = services.get('professorAppStorage').skillCustomization
  // An existing user with their own preference: nothing may inject the default on top of it.
  await customization.update({ skill, scope: null, fields: { teachingDepth: '适中，解释关键步骤', language: 'English' }, expectedRevision: 0, evidence: 'explicit-stable' })
  const body = (await provider.get(candidate)).content
  assert.match(body, /teachingDepth: 适中，解释关键步骤/)
  assert.match(body, /language: English/)
  assert.doesNotMatch(body, /循序渐进的顺序教学/, 'no forced default over saved preferences')
})
