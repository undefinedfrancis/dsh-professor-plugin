import test from 'node:test'
import assert from 'node:assert/strict'
import { dumpYamlLite, parseYamlLite } from '../src/project/yaml-lite.js'
test('registry multiline preferences and literal escapes survive config roundtrip', () => {
  const value = { fields: [{ field: 'Instructions', value: 'first\nsecond "quoted"\r\ntab\t and literal \\n' }] }
  assert.deepEqual(parseYamlLite(dumpYamlLite(value)), value)
})
