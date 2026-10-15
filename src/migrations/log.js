/**
 * Migration plan and log storage (M12, v3 §16).
 *
 * Every import from the Personal-Agent layout is auditable: a **plan** records what was read and how
 * each field was mapped (including the fields that could not be mapped), and a **log** records what
 * was actually applied. Both live under `.professor/migrations/` — never in the source tree, which
 * the importer only ever reads.
 *
 * The log is append-only and idempotent by construction: an import that changes nothing still
 * appends a `no-op` entry, so a re-run is visible rather than indistinguishable from a first run.
 *
 * @module dsh-professor-spike/src/migrations/log
 */

import path from 'node:path'

import { projectPaths } from '../paths/roots.js'

/** How many log lines are kept. */
export const MAX_MIGRATION_LOG_LINES = 200

/** Path of the migration plan for one run. */
export function migrationPlanPath(projectRoot, stamp) {
  const safe = String(stamp ?? '').replace(/[^0-9A-Za-z._-]/g, '-')
  return path.join(projectPaths(projectRoot).migrationsDir, `plan-${safe}.json`)
}

/**
 * Write a migration plan (create-only: a second run in the same millisecond never overwrites one).
 *
 * @returns `{ path, written }`.
 */
export async function writeMigrationPlan(options) {
  const {
    gateway, projectRoot, plan, session, signal, writePolicy,
  } = options
  const filePath = migrationPlanPath(projectRoot, plan?.stamp ?? Date.now())
  const written = await gateway.writeFile({
    filePath,
    cwd: projectRoot,
    content: `${JSON.stringify(plan, null, 2)}\n`,
    session,
    signal,
    writePolicy,
    expected: { kind: 'createIfAbsent' },
  })
  return { path: filePath, canonicalPath: written.canonicalPath, written: true }
}

/** Read a previously written plan, or `undefined`. */
export async function readMigrationPlan(options) {
  const { gateway, projectRoot, stamp, signal } = options
  const target = await gateway.resolveTarget(migrationPlanPath(projectRoot, stamp), { cwd: projectRoot, signal })
  const info = await gateway.stat(target, signal)
  if (info === undefined) return undefined
  return JSON.parse(await gateway.readText(target, signal))
}

/**
 * Append one line to the migration log.
 *
 * @returns `{ recorded: boolean, reason? }` — never throws on a lost append.
 */
export async function appendMigrationLog(options) {
  const {
    gateway, projectRoot, entry, session, signal, writePolicy,
  } = options
  const filePath = projectPaths(projectRoot).migrationLog
  try {
    const target = await gateway.resolveTarget(filePath, { cwd: projectRoot, signal })
    const info = await gateway.stat(target, signal)
    const existing = info === undefined ? '' : await gateway.readText(target, signal)
    const lines = existing.split('\n').filter((line) => line.trim().length > 0)
    const appended = [...lines, JSON.stringify(entry)].slice(-MAX_MIGRATION_LOG_LINES)
    await gateway.writeFile({
      filePath,
      cwd: projectRoot,
      content: `${appended.join('\n')}\n`,
      session,
      signal,
      writePolicy,
      expected: info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version },
    })
    return { recorded: true }
  } catch (error) {
    return { recorded: false, reason: error.message }
  }
}

/**
 * Summarise migration state for diagnostics.
 *
 * @returns `{ status, logPresent, applied, noop, failed, lastEntry, plans }`.
 */
export async function readMigrationStatus(options) {
  const { gateway, projectRoot, signal, limit = 5 } = options
  const layout = projectPaths(projectRoot)
  const out = { status: 'never-run', logPresent: false, applied: 0, noop: 0, failed: 0, lastEntry: null, plans: 0 }

  try {
    const dirTarget = await gateway.resolveTarget(layout.migrationsDir, { cwd: projectRoot, signal })
    const dirInfo = await gateway.stat(dirTarget, signal)
    if (dirInfo?.type === 'directory') {
      const entries = await gateway.listDir(dirTarget, signal)
      out.plans = entries.filter((entry) => entry.name.startsWith('plan-') && entry.name.endsWith('.json')).length
    }
  } catch {
    // A missing migrations directory simply means no migration has run.
  }

  try {
    const target = await gateway.resolveTarget(layout.migrationLog, { cwd: projectRoot, signal })
    const info = await gateway.stat(target, signal)
    if (info === undefined) return out
    out.logPresent = true
    const lines = (await gateway.readText(target, signal)).split('\n').filter((line) => line.trim().length > 0)
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line)
        if (parsed.outcome === 'applied') out.applied += 1
        else if (parsed.outcome === 'no-op') out.noop += 1
        else if (parsed.outcome === 'failed') out.failed += 1
      } catch {
        // Skip a malformed line.
      }
    }
    for (const line of lines.slice(-limit).reverse()) {
      try {
        out.lastEntry = JSON.parse(line)
        break
      } catch {
        // keep looking
      }
    }
    // Only a *recorded* outcome is a claim about a migration. A log that exists but records
    // nothing (empty file, or lines that would not parse) is reported as `never-run` rather than
    // as a successful no-op.
    out.status = out.failed > 0
      ? 'completed-with-failures'
      : out.applied > 0 ? 'applied' : out.noop > 0 ? 'no-op' : 'never-run'
    return out
  } catch (error) {
    return { ...out, status: 'unreadable', problems: [`migration log unreadable: ${error.message}`] }
  }
}

/** A short, stable digest of a text value (for the plan's source references). */
export async function digestOf(text) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16)
}
