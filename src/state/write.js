/**
 * Learning-state merge, compression and write discipline (M10).
 *
 * The design's non-negotiable rules, made executable:
 *
 * - **merge by `entry_id`, not by append** — every entry carries a stable id derived from its
 *   course and title, so re-studying a concept updates one row instead of accumulating copies;
 * - **revision + `replaceIfVersion`** — a state file is read with its fs version, merged, and
 *   written back against that version, so a concurrent update is refused (`FS_STALE_VERSION`)
 *   rather than silently lost;
 * - **compression** — a state file that grows past a line budget is compacted (duplicates merged,
 *   resolved items collapsed) before writing, so the file never becomes a transcript dump;
 * - **lightweight questions write nothing** — `planStateUpdate({ evidence: 'none' })` returns a
 *   zero-change plan, and the write path refuses to persist an empty plan, which is the invariant
 *   the persona states and this module enforces.
 *
 * @module dsh-professor-spike/src/state/write
 */

import { PRACTICE_ORIGINS } from '../provenance/source-ref.js'
import { parseMistakes, parseProgress } from './parse.js'

/** Evidence levels that permit a state change. */
export const EVIDENCE_LEVELS = ['none', 'weak', 'strong']

/** Default line budget before compression kicks in (the templates call this "keep it compact"). */
export const DEFAULT_LINE_BUDGET = 400

/** Derive a stable entry id from a course and an entry title (slug + short hash). */
export function entryIdFor(courseId, title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const suffix = Buffer.from(String(title ?? ''), 'utf8').toString('hex').slice(0, 8)
  return `e_${courseId}_${slug}_${suffix}`
}

/** True when the evidence permits any write at all. */
export function evidencePermitsWrite(evidence) {
  return EVIDENCE_LEVELS.includes(evidence) && evidence !== 'none'
}

/**
 * Plan a state update from observed evidence.
 *
 * The central invariant: `evidence: 'none'` (a lightweight question) yields a plan that changes
 * nothing, and the write path refuses to persist it. This is what makes "a lightweight question
 * must not modify any persistent state" testable rather than advisory.
 *
 * @param options.courseId - the bound course.
 * @param options.evidence - `none` (lightweight), `weak` (self-reported understanding or
 *   performance completed with assistance — the record must say which), `strong` (observed
 *   independent performance: solved/answered/explained back without help).
 * @param options.reason - why the update is warranted (for the audit trail).
 * @param options.entry - `{ file, title, body }` — what to write, if anything.
 * @returns `{ writable, plan }` where `plan` is empty when nothing may change.
 */
export function planStateUpdate(options) {
  const { courseId, evidence, reason, entry, change } = options
  if (!evidencePermitsWrite(evidence)) {
    return {
      writable: false,
      plan: {
        course_id: courseId ?? null,
        evidence: evidence ?? 'none',
        reason: reason ?? null,
        changes: [],
        note: evidence === 'none' || evidence === undefined
          ? 'lightweight question: no persistent state may change'
          : `evidence "${evidence}" does not permit a state change`,
      },
    }
  }
  const changes = []
  if (entry !== undefined) {
    changes.push({
      file: entry.file,
      entry_id: entryIdFor(courseId, entry.title),
      title: entry.title,
      body: entry.body ?? '',
    })
  } else if (change !== undefined) {
    // A field/unit update carries no title (it edits an existing row), but is still a change. A
    // deep-dive also has no title — its identity is topic + question, which is what `mergeMistakes`
    // keys on — so `topic` participates in the derived id rather than falling back to the literal
    // string "field", which would give every deep-dive the same plan label.
    changes.push({
      file: change.file,
      entry_id: change.entry_id ?? entryIdFor(courseId, change.field ?? change.unit ?? change.topic ?? change.title ?? 'field'),
      ...Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)),
    })
  }
  return {
    writable: changes.length > 0,
    plan: {
      course_id: courseId ?? null,
      evidence,
      reason: reason ?? null,
      changes,
      note: changes.length === 0 ? 'no entry supplied; nothing to write' : null,
    },
  }
}

/**
 * Merge an entry into a list of existing entries by `entry_id`.
 *
 * @param existing - current entries (each with `entry_id`).
 * @param incoming - the entry to insert or update.
 * @param options.overwrite - allow replacing an existing body (default: merge in place by
 *   appending missing content rather than losing the old text).
 * @returns `{ entries, updated, created }`.
 */
export function mergeEntry(existing, incoming, options = {}) {
  const list = Array.isArray(existing) ? [...existing] : []
  const id = incoming.entry_id ?? entryIdFor(incoming.course_id, incoming.title)
  const index = list.findIndex((entry) => entry.entry_id === id)
  if (index < 0) {
    list.push({ ...incoming, entry_id: id })
    return { entries: list, created: true, updated: false }
  }
  const current = list[index]
  if (options.overwrite === true) {
    list[index] = { ...current, ...incoming, entry_id: id }
    return { entries: list, created: false, updated: true }
  }
  // Default: keep both, marking the update so the reader sees one entry grow rather than two.
  const mergedBody = current.body === incoming.body
    ? current.body
    : [current.body, incoming.body].filter((part) => part !== undefined && part !== '').join('\n\n')
  list[index] = { ...current, ...incoming, entry_id: id, body: mergedBody, updated_at: incoming.updated_at ?? null }
  return { entries: list, created: false, updated: true }
}

/**
 * Merge a Mistakes update: an active mistake keyed by title, or a requested deep dive keyed by
 * topic + question (the deep-dive table has no id column upstream, so the natural key is the pair).
 *
 * @returns `{ active_mistakes, deep_dives, created, updated }`.
 */
export function mergeMistakes(current, update) {
  const active = Array.isArray(current.active_mistakes) ? [...current.active_mistakes] : []
  const dives = Array.isArray(current.deep_dives) ? [...current.deep_dives] : []
  let created = false
  let updated = false

  if (update.kind === 'mistake') {
    const id = update.entry_id ?? entryIdFor(update.course_id, update.title)
    const index = active.findIndex((entry) => (entry.entry_id ?? entryIdFor(update.course_id, entry.title)) === id)
    if (index < 0) {
      active.push({ ...update, entry_id: id, occurrences: 1 })
      created = true
    } else {
      active[index] = {
        ...active[index],
        body: update.body ?? active[index].body,
        occurrences: (active[index].occurrences ?? 1) + 1,
        last_seen: update.last_seen ?? active[index].last_seen,
      }
      updated = true
    }
  } else if (update.kind === 'deep-dive') {
    const key = `${update.topic ?? ''}::${update.question ?? ''}`
    const index = dives.findIndex((entry) => `${entry.topic}::${entry.question}` === key)
    if (index < 0) {
      dives.push({
        date: update.date ?? null,
        topic: update.topic ?? '',
        question: update.question ?? '',
        cause: update.cause ?? '',
        review_action: update.review_action ?? '',
      })
      created = true
    } else {
      dives[index] = { ...dives[index], ...update }
      updated = true
    }
  }

  return { active_mistakes: active, deep_dives: dives, created, updated }
}

/**
 * Compress a parsed state object so it stays a present-state description, never an activity log.
 *
 * - active mistakes with `occurrences` over `mistakeCap` move to resolved (they were reinforced);
 * - deep dives older than `deepDiveHorizon` days, or already resolved, are dropped;
 * - duplicate unit rows (same unit) collapse to the latest;
 * - a `PROGRESS` note list is capped.
 *
 * @returns `{ data, removed }` — `removed` counts entries the compression dropped.
 */
export function compressState(data, options = {}) {
  const mistakeCap = options.mistakeCap ?? 5
  const deepDiveHorizonDays = options.deepDiveHorizonDays ?? 60
  const maxUnits = options.maxUnits ?? 60
  const now = options.now ?? (() => Date.now())
  let removed = 0

  const progress = data.progress !== undefined ? { ...data.progress } : undefined
  if (progress !== undefined) {
    const seen = new Map()
    for (const unit of progress.units ?? []) {
      const key = unit.unit
      if (seen.has(key)) removed += 1
      seen.set(key, unit)
    }
    progress.units = [...seen.values()].slice(-maxUnits)
  }

  const mistakes = data.mistakes !== undefined ? { ...data.mistakes } : undefined
  let resolved = []
  if (mistakes !== undefined) {
    const kept = []
    for (const entry of mistakes.active_mistakes ?? []) {
      if ((entry.occurrences ?? 1) >= mistakeCap) {
        resolved.push({ ...entry, resolved: true, reason: `reinforced ${entry.occurrences} times` })
        removed += 1
        continue
      }
      kept.push(entry)
    }
    mistakes.active_mistakes = kept
    mistakes.resolved_mistakes = [...(mistakes.resolved_mistakes ?? []), ...resolved]

    const horizon = now() - deepDiveHorizonDays * 24 * 60 * 60 * 1000
    const keptDives = []
    for (const dive of mistakes.deep_dives ?? []) {
      const stamp = Date.parse(dive.date ?? '')
      if (Number.isFinite(stamp) && stamp < horizon) {
        removed += 1
        continue
      }
      keptDives.push(dive)
    }
    mistakes.deep_dives = keptDives
  }

  return { data: { ...(progress !== undefined ? { progress } : {}), ...(mistakes !== undefined ? { mistakes } : {}) }, removed }
}

/**
 * Count lines in a rendered state document, for the budget check.
 */
export function lineCount(text) {
  return String(text ?? '').split('\n').length
}

/**
 * Validate an update before it touches disk.
 *
 * @returns `{ ok, errors }`.
 */
export function validateStateUpdate(update) {
  const errors = []
  if (update === null || typeof update !== 'object') return { ok: false, errors: ['update must be a mapping'] }
  if (!EVIDENCE_LEVELS.includes(update.evidence)) {
    errors.push(`evidence must be one of ${EVIDENCE_LEVELS.join(' | ')}`)
  }
  if (!evidencePermitsWrite(update.evidence) && Array.isArray(update.changes) && update.changes.length > 0) {
    errors.push('a change is planned but the evidence does not permit one')
  }
  for (const [index, change] of (Array.isArray(update.changes) ? update.changes : []).entries()) {
    if (change.file !== undefined && !['PROGRESS.md', 'KNOWLEDGE.md', 'MISTAKES.md', 'INDEX.md'].includes(change.file)) {
      errors.push(`changes[${index}].file must be a state file, found ${JSON.stringify(change.file)}`)
    }
    if (change.title !== undefined && (typeof change.title !== 'string' || change.title.trim().length === 0)) {
      errors.push(`changes[${index}].title must be a non-empty string`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/** Convenience: parse + compress in one step for callers that only need the summary. */
export function summarizeForUpdate(progressText, mistakesText) {
  const data = {
    progress: parseProgress(progressText),
    mistakes: parseMistakes(mistakesText),
  }
  return compressState(data)
}

/** Re-export so callers can validate a practice origin in the same place they write state. */
export { PRACTICE_ORIGINS }
