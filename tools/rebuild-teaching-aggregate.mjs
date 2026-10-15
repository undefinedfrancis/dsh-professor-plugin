/**
 * Offline rebuild of the live-model teaching aggregate from preserved artifacts.
 *
 * No model call, no host boot, no network, no credential. Reads the immutable run reports and the
 * recorded human adjudication, and rewrites `aggregate-assessment.json` using the repaired
 * `aggregateRuns()`:
 *
 * - `NOT-INCLUDED` / `UNEXECUTED` invocation placeholders are history, never observations;
 * - completeness is judged against `EXPECTED_CASE_IDS`, not against whatever subset was supplied;
 * - automated screening and manual adjudication are reported side by side, both bound to the run
 *   whose evidence they rest on;
 * - the recorded closure decision is a separate field, never an all-pass claim.
 *
 * The input reports are hashed before and after and must be byte-identical: rebuilding reporting
 * must never touch the evidence it reports on.
 *
 * Usage:
 *   node tools/rebuild-teaching-aggregate.mjs           # rebuild, exit 0 when the rebuild succeeds
 *   node tools/rebuild-teaching-aggregate.mjs --gate     # also exit 1 unless aggregate.all_passed
 *
 * @module tools/rebuild-teaching-aggregate
 */

import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { aggregateRuns } from './teaching-model-grading.mjs'
import { EXPECTED_CASE_IDS } from './teaching-model-matrix.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evidenceDir = path.join(root, 'docs', 'qa', '2026-10-12-teaching-interaction', 'live-model')

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

export async function rebuildAggregate({ dir = evidenceDir, gate = false } = {}) {
  const reportPaths = []
  for (let n = 1; ; n += 1) {
    const candidate = path.join(dir, `report-run${n}.json`)
    try { await fs.access(candidate); reportPaths.push(candidate) } catch { break }
  }
  const currentPath = path.join(dir, 'report.json')
  try { await fs.access(currentPath); reportPaths.push(currentPath) } catch { /* no current report */ }
  if (reportPaths.length === 0) throw new Error(`no run reports found in ${dir}`)

  const adjudicationPath = path.join(dir, 'adjudications.json')
  const protectedPaths = [...reportPaths]
  try { await fs.access(adjudicationPath); protectedPaths.push(adjudicationPath) } catch { /* optional */ }

  const before = new Map()
  for (const file of protectedPaths) before.set(file, sha256(await fs.readFile(file)))

  const runs = []
  for (const file of reportPaths) {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!Array.isArray(parsed.cases)) throw new Error(`${path.basename(file)} has no cases array`)
    runs.push({ runId: path.basename(file), cases: parsed.cases })
  }

  let adjudications = []
  let decision = null
  try {
    const recorded = JSON.parse(await fs.readFile(adjudicationPath, 'utf8'))
    adjudications = Array.isArray(recorded.entries) ? recorded.entries : []
    decision = recorded.decision ?? null
  } catch { /* no human adjudication recorded for this matrix */ }

  const aggregate = aggregateRuns(runs, {
    expectedCases: EXPECTED_CASE_IDS, adjudications, decision,
  })

  const outPath = path.join(dir, 'aggregate-assessment.json')
  const previousOut = await fs.readFile(outPath, 'utf8').catch(() => null)
  const latest = JSON.parse(await fs.readFile(reportPaths[reportPaths.length - 1], 'utf8'))
  await fs.writeFile(outPath, `${JSON.stringify({
    date: latest.date ?? null,
    runs: runs.map(run => run.runId),
    rebuilt_by: 'tools/rebuild-teaching-aggregate.mjs',
    rebuilt_offline: true,
    expected_cases: EXPECTED_CASE_IDS,
    aggregate,
  }, null, 2)}\n`)

  // Evidence immutability: the inputs must be byte-identical after the rebuild.
  const damaged = []
  for (const [file, digest] of before) {
    if (sha256(await fs.readFile(file)) !== digest) damaged.push(path.basename(file))
  }
  if (damaged.length > 0) {
    throw new Error(`input evidence changed during rebuild: ${damaged.join(', ')}`)
  }

  return {
    outPath, previousOut, aggregate, runs: runs.map(run => run.runId), inputsUnchanged: true, gate,
    input_hashes: Object.fromEntries([...before].map(([file, digest]) => [path.basename(file), digest])),
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  try {
    const gate = process.argv.includes('--gate')
    const result = await rebuildAggregate({ gate })
    const { aggregate } = result
    console.log(JSON.stringify({
      rebuilt: path.relative(root, result.outPath),
      inputs_unchanged: result.inputsUnchanged,
      input_hashes: result.input_hashes,
      runs: result.runs,
      inventory: aggregate.inventory,
      counts: aggregate.counts,
      blocked: aggregate.blocked,
      automated_all_passed: aggregate.automated.all_passed,
      all_passed: aggregate.all_passed,
      rejected_adjudications: aggregate.rejected_adjudications,
      decision: aggregate.decision,
      per_case: Object.fromEntries(Object.entries(aggregate.cases).map(([id, slot]) => [id, {
        automated: slot.automated,
        effective: slot.effective_status,
        adjudicated: slot.adjudication !== null,
        history: slot.history.length,
        prior_failures: slot.prior_failures.length,
      }])),
    }, null, 2))
    process.exitCode = gate && aggregate.all_passed !== true ? 1 : 0
  } catch (error) {
    console.error(String(error?.stack ?? error))
    process.exitCode = 1
  }
}
