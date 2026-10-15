/**
 * Budgeted retrieval (M8).
 *
 * Given a query, pick the chunks most likely to answer it under an explicit budget, and say why:
 * every returned chunk carries its score, its provenance and its position, so a caller can quote
 * it and a reviewer can audit the choice. Deliberate properties:
 *
 * - **budget is hard**: `max_chunks` is never exceeded — overflow is reported as dropped, not
 *   silently truncated from the middle;
 * - **deterministic**: ties break by `chunk_id`, so two runs over the same index return the same
 *   set in the same order;
 * - **filtering before scoring**: `course`/`category` filters narrow the candidate set first, so
 *   an unrelated course's material can never win a budget slot by having a high raw score;
 * - **local sources first**: `prefer_local_course_sources` boosts chunks from the bound course,
 *   but never at the cost of the hard budget;
 * - **no whole-course reads**: scoring touches chunk text only through the already-extracted
 *   store, never by re-reading files.
 *
 * @module dsh-professor-spike/src/extract/retrieval
 */

/** Scoring weights (tuned for study material: a heading hit is worth more than body text). */
const WEIGHTS = { exactPhrase: 6, allTerms: 3, heading: 4, term: 1 }

/** Collapse whitespace so scores do not depend on formatting. */
function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Split a query into significant terms, dropping very short ones. */
export function queryTerms(query) {
  const raw = normalize(query).split(' ').filter((term) => term.length > 1)
  return [...new Set(raw)]
}

/**
 * Score one chunk against a query.
 *
 * @returns `{ score, matched }` where `matched` lists the terms that appeared.
 */
export function scoreChunk(chunk, { terms, phrase }) {
  const body = normalize(chunk.text)
  const heading = normalize(chunk.heading)
  let score = 0
  const matched = []

  for (const term of terms) {
    const inBody = body.includes(term)
    const inHeading = heading.includes(term)
    if (inBody || inHeading) matched.push(term)
    if (inBody) score += WEIGHTS.term
    if (inHeading) score += WEIGHTS.heading
  }
  if (phrase.length > 0 && (body.includes(phrase) || heading.includes(phrase))) {
    score += WEIGHTS.exactPhrase
  }
  if (terms.length > 1 && matched.length === terms.length) score += WEIGHTS.allTerms

  return { score, matched }
}

/**
 * Select chunks for a query under a budget.
 *
 * @param options.chunks - candidate chunks (each already carries provenance fields).
 * @param options.query - the query string.
 * @param options.maxChunks - hard budget (from `retrieval.max_chunks`).
 * @param options.maxSources - cap on distinct source files (from `retrieval.max_sources`).
 * @param options.courseFilter - optional `course_id` to restrict candidates.
 * @param options.categoryFilter - optional category to restrict candidates.
 * @param options.preferCourse - optional `course_id` to boost (never to exceed the budget).
 * @returns `{ results, dropped, filtered, diagnostics }`.
 */
export function retrieve(options) {
  const {
    chunks,
    query,
    maxChunks,
    maxSources = Number.POSITIVE_INFINITY,
    courseFilter,
    categoryFilter,
    preferCourse,
  } = options

  const terms = queryTerms(query)
  const phrase = normalize(query)
  let filtered = { byCourse: 0, byCategory: 0 }

  const candidates = chunks.filter((chunk) => {
    if (courseFilter !== undefined && courseFilter !== null && chunk.course_id !== courseFilter) {
      filtered.byCourse += 1
      return false
    }
    if (categoryFilter !== undefined && categoryFilter !== null && chunk.category !== categoryFilter) {
      filtered.byCategory += 1
      return false
    }
    return true
  })

  const scored = candidates
    .map((chunk) => {
      const { score, matched } = scoreChunk(chunk, { terms, phrase })
      const boost = preferCourse !== undefined && preferCourse !== null && chunk.course_id === preferCourse ? 1 : 0
      return { chunk, baseScore: score, matched, boost }
    })
    .filter((entry) => entry.baseScore > 0)

  // Deterministic ordering: score (desc), local boost (desc), then chunk_id (asc).
  scored.sort((left, right) => (
    right.baseScore - left.baseScore
    || right.boost - left.boost
    || (left.chunk.chunk_id < right.chunk.chunk_id ? -1 : 1)
  ))

  const results = []
  const sourcesUsed = new Set()
  let dropped = 0

  for (const entry of scored) {
    if (results.length >= maxChunks) {
      dropped += 1
      continue
    }
    const fileId = entry.chunk.file_id
    if (!sourcesUsed.has(fileId) && sourcesUsed.size >= maxSources) {
      dropped += 1
      continue
    }
    sourcesUsed.add(fileId)
    results.push({
      chunk_id: entry.chunk.chunk_id,
      file_id: fileId,
      course_id: entry.chunk.course_id ?? null,
      category: entry.chunk.category ?? null,
      heading: entry.chunk.heading ?? null,
      start_line: entry.chunk.start_line ?? null,
      end_line: entry.chunk.end_line ?? null,
      page: entry.chunk.page ?? null,
      // A range is carried only when the extractor really reported both endpoints, so a citation
      // can say "pp. 12–13" without ever inventing the second number.
      page_range: Array.isArray(entry.chunk.page_range) ? entry.chunk.page_range : null,
      slide: entry.chunk.slide ?? null,
      slide_range: Array.isArray(entry.chunk.slide_range) ? entry.chunk.slide_range : null,
      coordinate_ambiguous: entry.chunk.coordinate_ambiguous === true,
      relative_path: entry.chunk.relative_path ?? null,
      text: entry.chunk.text,
      score: entry.baseScore + entry.boost,
      matched_terms: entry.matched,
      source_note: entry.chunk.source_note ?? null,
    })
  }

  return {
    results,
    dropped,
    filtered,
    diagnostics: {
      query_terms: terms,
      candidates: candidates.length,
      scored: scored.length,
      budget_chunks: maxChunks,
      budget_sources: maxSources,
      used_chunks: results.length,
      used_sources: sourcesUsed.size,
      dropped,
      note: scored.length === 0
        ? 'no chunk matched the query; the material may not be indexed yet (run professor_index_sync) or the terms may not appear in it'
        : dropped > 0
          ? `budget reached: ${dropped} further matching chunk(s) were dropped`
          : null,
    },
  }
}
