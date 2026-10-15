/**
 * A small, append-only record of refused concurrent state writes (M10/M12).
 *
 * When a state update loses a race the write is refused (never silently lost) and the caller gets
 * `stale: true`. That is the right behaviour, but on its own it leaves no trace: a learner who
 * closed and reopened the app cannot tell that a write was refused. This module keeps the last
 * handful of refusals in `.professor/state/conflicts.log` (JSON Lines) so diagnostics can report
 * "recent state conflicts" as a fact rather than a guess.
 *
 * The log is best-effort by design: recording a conflict must never turn a refused write into a
 * thrown error, and a log that cannot be written is simply not recorded.
 *
 * @module dsh-professor-spike/src/state/conflicts
 */

import path from 'node:path'

import { projectPaths } from '../paths/roots.js'

/** How many conflict lines are kept on disk. */
export const MAX_CONFLICT_LINES = 200

/** Path of the conflict log. */
export function conflictLogPath(projectRoot) {
  return path.join(projectPaths(projectRoot).stateDir, 'conflicts.log')
}

/**
 * Append one refusal.
 *
 * @param options.gateway / options.projectRoot / options.writePolicy / options.session / options.signal - as usual.
 * @param options.entry - `{ course_id, file, expected_version, observed_version, at }`.
 * @returns `{ recorded: boolean, reason? }` — never throws.
 */
export async function recordConflict(options) {
  const {
    gateway, projectRoot, writePolicy, session, signal, entry,
  } = options
  if (writePolicy === undefined || typeof writePolicy.assert !== 'function') {
    return { recorded: false, reason: 'no write policy' }
  }
  const filePath = conflictLogPath(projectRoot)
  try {
    // Read, append, write — with a version guard. A concurrent append loses its own entry (one
    // line of telemetry), which is an acceptable trade for never corrupting the file.
    const target = await gateway.resolveTarget(filePath, { cwd: projectRoot, signal })
    const info = await gateway.stat(target, signal)
    const existing = info === undefined ? '' : await gateway.readText(target, signal)
    const lines = existing.split('\n').filter((line) => line.trim().length > 0)
    const appended = [...lines, JSON.stringify(entry)].slice(-MAX_CONFLICT_LINES)
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
 * Read the most recent refusals.
 *
 * @returns `{ present, entries, problems }` — entries newest first.
 */
export async function readConflicts(options) {
  const { gateway, projectRoot, signal, limit = 5 } = options
  const filePath = conflictLogPath(projectRoot)
  try {
    const target = await gateway.resolveTarget(filePath, { cwd: projectRoot, signal })
    const info = await gateway.stat(target, signal)
    if (info === undefined) return { present: false, entries: [], problems: [] }
    const lines = (await gateway.readText(target, signal)).split('\n').filter((line) => line.trim().length > 0)
    const entries = []
    for (const line of lines.slice(-limit).reverse()) {
      try {
        entries.push(JSON.parse(line))
      } catch {
        // A malformed line is skipped rather than failing the whole report.
      }
    }
    return { present: true, entries, total: lines.length, problems: [] }
  } catch (error) {
    return { present: false, entries: [], problems: [`conflict log unreadable: ${error.message}`] }
  }
}
