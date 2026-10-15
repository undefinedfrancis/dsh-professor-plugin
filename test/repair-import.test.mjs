import assert from 'node:assert/strict'
import test from 'node:test'
import { repairImportedProject } from '../src/migrations/repair-import.js'

test('legacy repair preserves identities and custom rules but separates course output and preferences', () => {
  const document = {
    courses: [{ course_id: 'physics', course_code: 'PHY1001', term: 'Fall', status: 'active',
      sources: [{ path: '/courses/PHY1001', category_rules: { exams: ['/courses/PHY1001/00_Course-Info'], custom: ['/courses/PHY1001/custom'] } }] }],
    outputs: { notes_root: '/courses/PHY1001/04_My-Notes/AI-Notes', reviews_root: '/neutral/reviews' },
    notes: { default_format: 'latex', latex_template: '/templates/math', overwrite_policy: 'never' },
  }
  const entries = [{ input: { course_code: 'PHY1001', outputs: { notes_root: document.outputs.notes_root },
    notes: { default_format: 'latex', latex_template: '/templates/math' }, registry_fields: [{ field: 'Special Instructions', value: 'Do not skip derivation steps' }],
    sources: [{ path: '/courses/PHY1001', category_rules: { supplementary: ['/courses/PHY1001/00_Course-Info'] } }] }, notesRoot: document.outputs.notes_root, latexTemplate: '/templates/math' }]
  const repaired = repairImportedProject(document, entries)
  assert.equal(repaired.outputs.notes_root, null)
  assert.equal(repaired.outputs.reviews_root, '/neutral/reviews')
  assert.equal(repaired.notes.default_format, 'ask')
  assert.equal(repaired.notes.latex_template, null)
  assert.equal(repaired.courses[0].course_id, 'physics')
  assert.deepEqual(repaired.courses[0].outputs, entries[0].input.outputs)
  assert.deepEqual(repaired.courses[0].registry_fields, entries[0].input.registry_fields)
  assert.equal(repaired.courses[0].sources[0].category_rules.exams, undefined)
  assert.deepEqual(repaired.courses[0].sources[0].category_rules.custom, ['/courses/PHY1001/custom'])
  assert.equal(document.notes.default_format, 'latex', 'the original remains unchanged')
  assert.deepEqual(repairImportedProject(repaired, entries), repaired, 'repair is idempotent')
})
