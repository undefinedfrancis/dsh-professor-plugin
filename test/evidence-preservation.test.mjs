/**
 * Historical evidence must not move.
 *
 * The brief for this round requires model outputs, PDFs, counters, authorization records and
 * reports to stay byte-for-byte identical while the executor that produced them is repaired.
 * "Nothing was changed" is not an assertion this suite can take on trust, so the bytes are
 * fingerprinted before any edit (`hash-before.json`) and compared here afterwards.
 *
 * The baseline is written by the release-preparation pass itself and lives beside the report it
 * belongs to. On a fresh clone without that file the test skips rather than inventing a baseline —
 * but a baseline that *exists* and no longer matches is a hard failure, including a missing file.
 *
 * @module test/evidence-preservation
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BASELINE_DIR = path.join(ROOT, 'docs', 'qa', '2026-10-14-offline-release-preparation')
const BASELINE_PATH = path.join(BASELINE_DIR, 'hash-before.json')

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

test('historical evidence under docs/qa is byte-identical to the recorded baseline', async (t) => {
  const raw = await fs.readFile(BASELINE_PATH, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) {
    t.skip(`no baseline at ${path.relative(ROOT, BASELINE_PATH)} — nothing recorded to compare against`)
    return
  }

  const baseline = JSON.parse(raw)
  assert.equal(typeof baseline.generated_at, 'string', 'the baseline records when it was taken')
  assert.ok(Object.keys(baseline.files).length > 0, 'the baseline must list files, not an empty set')

  const missing = []
  const changed = []
  for (const [rel, expected] of Object.entries(baseline.files)) {
    const buffer = await fs.readFile(path.join(ROOT, rel)).catch(() => null)
    if (buffer === null) {
      missing.push(rel)
      continue
    }
    if (buffer.byteLength !== expected.bytes || sha256(buffer) !== expected.sha256) {
      changed.push(`${rel} (expected ${expected.bytes}B ${expected.sha256.slice(0, 12)}, `
        + `found ${buffer.byteLength}B ${sha256(buffer).slice(0, 12)})`)
    }
  }

  assert.deepEqual(missing, [], `files recorded in the baseline are now gone:\n  ${missing.join('\n  ')}`)
  assert.deepEqual(changed, [], `historical evidence changed:\n  ${changed.join('\n  ')}`)
})
