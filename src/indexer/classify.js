/**
 * Course assignment and virtual classification for the file index (M7).
 *
 * A record is never "guessed into" a course. Assignment happens in three ordered passes, each
 * reporting where the answer came from so the index can state it:
 *
 * 1. **registered source root** (`confidence: high`) — the file is under a course's registered
 *    `sources[].path`;
 * 2. **category rule** (`confidence: high` when the path matches a `category_rules` entry) — the
 *    rule is a prefix the registry declared (e.g. `<course>/01_Lectures`), so the match is exact
 *    by construction;
 * 3. **no match** → `course_id: null`, `category: "unassigned"` with
 *    `classification_source: "none"`.
 *
 * Anything the rules do not cover stays `unassigned` rather than being attached to a course —
 * v3 §9: *"Unknown sources remain unassigned until safely mapped."* This is a deterministic,
 * data-only decision: no heuristics, no name-based guessing, no filesystem sniffing.
 *
 * The fields this module writes on each record:
 *
 * | field | meaning |
 * |---|---|
 * | `course_id` | matched course id, or `null` |
 * | `category` | matched category, or `"unassigned"` |
 * | `classification_source` | `"source-root"`, `"category-rule"` or `"none"` |
 * | `classification_confidence` | `0`–`1`; `1` for a rule/prefix match, `0` for none |
 *
 * `classification_source` is intentionally a string rather than an enum so a future
 * auto-detection pass (a *suggestion*, per v3 §6.4) can be recorded without a schema change.
 *
 * @module dsh-professor-spike/src/indexer/classify
 */

import path from 'node:path'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Category emitted when nothing matched. */
export const UNASSIGNED = 'unassigned'

/** The four categories the registry's `category_rules` declares, plus `unassigned`. */
export const CATEGORIES = new Set(['lectures', 'tutorials', 'assignments', 'exams', 'supplementary', UNASSIGNED])

function toPosix(value) {
  return value.split(path.sep).join('/')
}

/** True when `child` is inside `parent` (both already posix-separated, no trailing slash). */
function isInsidePath(parent, child) {
  if (parent.length === 0) return true
  return child === parent || child.startsWith(`${parent}/`)
}

/**
 * Resolve a course's `sources[].path` against the index root.
 *
 * A source outside the index root cannot match any record (the index never walks outside the
 * project), so it is reported as unreachable rather than silently ignored.
 *
 * @returns `{ courseId, sources: [{ relative, categories: [{ category, relative }] }] }`.
 */
function normalizeCourse(course, indexRoot) {
  const rules = []
  const sources = []
  for (const source of (Array.isArray(course?.sources) ? course.sources : [])) {
    if (!isPlainObject(source) || typeof source.path !== 'string') continue
    const relativeSource = path.relative(indexRoot, source.path)
    if (relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) continue
    const normalizedSource = toPosix(relativeSource)
    sources.push(normalizedSource)

    const categoryRules = isPlainObject(source.category_rules) ? source.category_rules : {}
    for (const [category, value] of Object.entries(categoryRules)) {
      const declared = Array.isArray(value) ? value : [value]
      for (const entry of declared) {
        if (typeof entry !== 'string' || entry.length === 0) continue
        const relativeRule = path.relative(indexRoot, entry)
        if (relativeRule.startsWith('..') || path.isAbsolute(relativeRule)) continue
        rules.push({ category, relative: toPosix(relativeRule) })
      }
    }
  }
  return { courseId: course.course_id, sources, rules }
}

/**
 * Build a classifier from a project document.
 *
 * @param options.document - the parsed project document.
 * @param options.indexRoot - canonical project root (the index's `root`).
 * @returns `(relativePath) => { course_id, category, classification_source, classification_confidence }`.
 */
export function createClassifier({ document, indexRoot }) {
  const courses = (Array.isArray(document?.courses) ? document.courses : [])
    .filter((course) => isPlainObject(course) && typeof course.course_id === 'string')
    .map((course) => normalizeCourse(course, indexRoot))

  // Longest-prefix first so the most specific rule wins when several match; ties are resolved by
  // course id, keeping the result independent of registration order.
  const rules = []
  for (const course of courses) {
    for (const rule of course.rules) rules.push({ ...rule, courseId: course.courseId })
  }
  rules.sort((left, right) => right.relative.length - left.relative.length || (left.courseId < right.courseId ? -1 : 1))

  const roots = []
  for (const course of courses) {
    for (const source of course.sources) roots.push({ relative: source, courseId: course.courseId })
  }
  roots.sort((left, right) => right.relative.length - left.relative.length || (left.courseId < right.courseId ? -1 : 1))

  return function classify(relativePath) {
    // Normalise before matching: a record path containing `..` must not reach a rule by prefix
    // through traversal (`CSC3200/../other` is not inside `CSC3200`).
    const file = toPosix(path.normalize(String(relativePath)))
    if (file.startsWith('../') || file === '..' || path.isAbsolute(file)) {
      return {
        course_id: null,
        category: UNASSIGNED,
        classification_source: 'none',
        classification_confidence: 0,
      }
    }

    for (const rule of rules) {
      if (isInsidePath(rule.relative, file) || file === rule.relative) {
        return {
          course_id: rule.courseId,
          category: rule.category,
          classification_source: 'category-rule',
          classification_confidence: 1,
        }
      }
    }

    for (const root of roots) {
      if (isInsidePath(root.relative, file)) {
        return {
          course_id: root.courseId,
          category: UNASSIGNED,
          classification_source: 'source-root',
          classification_confidence: 1,
        }
      }
    }

    return {
      course_id: null,
      category: UNASSIGNED,
      classification_source: 'none',
      classification_confidence: 0,
    }
  }
}

/**
 * Classify a batch of records, writing the four fields onto each in place.
 *
 * @param records - index records (must carry `relative_path`).
 * @param classify - a classifier from `createClassifier`.
 * @returns `{ assigned, unassigned, byCourse }` counts.
 */
export function classifyRecords(records, classify) {
  let assigned = 0
  let unassigned = 0
  const byCourse = new Map()

  for (const record of records) {
    const outcome = classify(record.relative_path)
    record.course_id = outcome.course_id
    record.category = outcome.category
    record.classification_source = outcome.classification_source
    record.classification_confidence = outcome.classification_confidence

    if (outcome.course_id === null) unassigned += 1
    else {
      assigned += 1
      byCourse.set(outcome.course_id, (byCourse.get(outcome.course_id) ?? 0) + 1)
    }
  }

  return {
    assigned,
    unassigned,
    byCourse: Object.fromEntries([...byCourse].sort(([left], [right]) => (left < right ? -1 : 1))),
  }
}

/**
 * Summarise classification coverage for a tool response.
 *
 * @returns counts plus an explicit note when nothing matched, so a caller is never left to infer
 *   the absence of a field.
 */
export function summarizeClassification(records) {
  // Every known bucket starts at 0 so a consumer can read a count without probing for `undefined`
  // when nothing matched — an absent key is easy to mistake for a missing field.
  const byCategory = new Map([...CATEGORIES].map((category) => [category, 0]))
  const bySource = new Map([['source-root', 0], ['category-rule', 0], ['none', 0]])
  const byCourse = new Map()
  let unassigned = 0
  for (const record of records) {
    if (record.course_id === null || record.course_id === undefined) unassigned += 1
    else byCourse.set(record.course_id, (byCourse.get(record.course_id) ?? 0) + 1)
    const category = record.category ?? UNASSIGNED
    const source = record.classification_source ?? 'none'
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1)
    bySource.set(source, (bySource.get(source) ?? 0) + 1)
  }
  return {
    total: records.length,
    unassigned,
    byCategory: Object.fromEntries([...byCategory].sort(([left], [right]) => (left < right ? -1 : 1))),
    bySource: Object.fromEntries([...bySource].sort(([left], [right]) => (left < right ? -1 : 1))),
    byCourse: Object.fromEntries([...byCourse].sort(([left], [right]) => (left < right ? -1 : 1))),
    note: unassigned === records.length && records.length > 0
      ? 'no file matched a registered source root or category rule; register a course source and re-run professor_index_sync'
      : null,
  }
}
