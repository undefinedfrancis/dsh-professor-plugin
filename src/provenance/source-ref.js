/**
 * Provenance: `SourceRef` and source classes (M9, v3 §15).
 *
 * A `SourceRef` is what makes an explanation quotable and auditable: it ties a claim back to
 * exactly where it came from. The rules here are the v3 rules made executable:
 *
 * - **four source classes** — `local_course_source`, `external_web_source`, `user_provided`,
 *   `model_inference`. A web source is never rendered as course material, and model inference is
 *   never presented as professor-authored content;
 * - **only known fields are included** (v3 §15.2): an unknown page stays absent rather than
 *   becoming `page: 0`, because a wrong coordinate is worse than no coordinate;
 * - **conflicts are shown, not merged** (v3 §15.3): two refs that disagree about a fact are
 *   reported side by side;
 * - **practice items carry an origin** (v3 §9): `original` (原题), `adapted` (改编题),
 *   `generated` (新编练习) — a generated question must never be implied to come from the
 *   professor. `origin` is required for practice refs and rejected for non-practice refs, so the
 *   distinction cannot silently collapse either way.
 *
 * @module dsh-professor-spike/src/provenance/source-ref
 */

/** The four source classes from v3 §15.1. */
export const SOURCE_TYPES = ['local_course_source', 'external_web_source', 'user_provided', 'model_inference']

/** Practice-item origins from v3 §9. */
export const PRACTICE_ORIGINS = ['original', 'adapted', 'generated']

/** Human-readable labels for the practice origins (the language the design mandates in output). */
export const PRACTICE_ORIGIN_LABELS = { original: '原题', adapted: '改编题', generated: '新编练习' }

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function fail(message) {
  const error = new Error(message)
  error.code = 'PROFESSOR_PROVENANCE_INVALID'
  return error
}

/**
 * Validate a `SourceRef`.
 *
 * @param ref - the candidate reference.
 * @param options.practice - true when the ref describes a practice item (origin becomes required).
 * @returns `{ ok, errors }`; never throws.
 */
export function validateSourceRef(ref, options = {}) {
  const errors = []
  if (!isPlainObject(ref)) return { ok: false, errors: ['source reference must be a mapping'] }

  if (!SOURCE_TYPES.includes(ref.source_type)) {
    errors.push(`source_type must be one of ${SOURCE_TYPES.join(' | ')}, found ${JSON.stringify(ref.source_type)}`)
  }

  // Coordinates: only known values are allowed, and they must be positive integers.
  for (const field of ['page', 'slide']) {
    const value = ref[field]
    if (value === undefined || value === null) continue
    if (!Number.isInteger(value) || value < 1) {
      errors.push(`${field} must be a positive integer or omitted (found ${JSON.stringify(value)})`)
    }
  }
  // A range is how a chunk that genuinely spans several pages stays honest. It is only accepted as
  // an ordered pair of real page numbers: a half-known range is a guessed coordinate in disguise.
  for (const field of ['page_range', 'slide_range']) {
    const value = ref[field]
    if (value === undefined || value === null) continue
    const valid = Array.isArray(value) && value.length === 2
      && value.every((entry) => Number.isInteger(entry) && entry >= 1)
      && value[1] >= value[0]
    if (!valid) {
      errors.push(`${field} must be an ordered pair of positive integers or omitted (found ${JSON.stringify(value)})`)
    }
  }
  if (ref.source_type === 'local_course_source' && ref.file_id === undefined && ref.relative_path === undefined) {
    errors.push('a local course source needs file_id or relative_path')
  }
  if (ref.source_type === 'external_web_source' && typeof ref.url !== 'string') {
    errors.push('an external web source needs a url')
  }
  if (ref.chunk_id !== undefined && ref.chunk_id !== null && typeof ref.chunk_id !== 'string') {
    errors.push('chunk_id must be a string or null')
  }
  if (ref.section !== undefined && ref.section !== null && typeof ref.section !== 'string') {
    errors.push('section must be a string or null')
  }

  // Origin: required for practice items, forbidden otherwise (so a lecture reference can never
  // silently claim to be a practice item, and a practice item can never hide its origin).
  const isPractice = options.practice === true || ref.practice === true
  if (isPractice) {
    if (!PRACTICE_ORIGINS.includes(ref.origin)) {
      errors.push(`a practice reference needs origin of ${PRACTICE_ORIGINS.join(' | ')}, found ${JSON.stringify(ref.origin)}`)
    }
  } else if (ref.origin !== undefined) {
    errors.push('origin is only valid for practice references')
  }

  return { ok: errors.length === 0, errors }
}

/**
 * Build a `SourceRef`, including only fields that are actually known.
 *
 * @param options.sourceType - one of `SOURCE_TYPES`.
 * @param options.fileId - index file id (local sources).
 * @param options.relativePath - project-relative path (local sources).
 * @param options.page - 1-based PDF page, if the extractor reported it.
 * @param options.pageRange - `[first, last]` when the evidence spans several known pages.
 * @param options.slide - 1-based slide number, if the extractor reported it.
 * @param options.slideRange - `[first, last]` when the evidence spans several known slides.
 * @param options.section - heading/section text, if known.
 * @param options.chunkId - the chunk this evidence came from.
 * @param options.url / title / publisher / date - for web sources.
 * @param options.origin - practice origin (`original`/`adapted`/`generated`).
 * @param options.practice - mark this ref as describing a practice item.
 * @returns the reference with unknown fields omitted.
 * @throws {Error} `PROFESSOR_PROVENANCE_INVALID` when the result would be invalid.
 */
export function makeSourceRef(options = {}) {
  const ref = { source_type: options.sourceType }

  if (options.fileId !== undefined && options.fileId !== null) ref.file_id = options.fileId
  if (options.relativePath !== undefined && options.relativePath !== null) ref.relative_path = options.relativePath
  if (options.page !== undefined && options.page !== null) ref.page = options.page
  if (options.pageRange !== undefined && options.pageRange !== null) ref.page_range = options.pageRange
  if (options.slide !== undefined && options.slide !== null) ref.slide = options.slide
  if (options.slideRange !== undefined && options.slideRange !== null) ref.slide_range = options.slideRange
  if (options.section !== undefined && options.section !== null) ref.section = options.section
  if (options.chunkId !== undefined && options.chunkId !== null) ref.chunk_id = options.chunkId
  if (options.url !== undefined && options.url !== null) ref.url = options.url
  if (options.title !== undefined && options.title !== null) ref.title = options.title
  if (options.publisher !== undefined && options.publisher !== null) ref.publisher = options.publisher
  if (options.date !== undefined && options.date !== null) ref.date = options.date
  if (options.origin !== undefined && options.origin !== null) ref.origin = options.origin
  if (options.practice === true) ref.practice = true

  const validation = validateSourceRef(ref, { practice: options.practice === true })
  if (!validation.ok) throw fail(validation.errors.join('; '))
  return ref
}

/**
 * Build a `SourceRef` from a retrieved chunk (the common local case).
 *
 * Carries page/slide through only when the extractor actually populated them on the chunk — that
 * is the mechanism by which a PDF page becomes citable without ever inventing a number.
 *
 * @param chunk - a chunk from the store or a search result.
 * @param options - extra fields (`practice`, `origin`).
 * @returns the reference.
 */
export function sourceRefFromChunk(chunk, options = {}) {
  return makeSourceRef({
    sourceType: 'local_course_source',
    fileId: chunk.file_id,
    relativePath: chunk.relative_path,
    page: chunk.page ?? undefined,
    pageRange: Array.isArray(chunk.page_range) ? chunk.page_range : undefined,
    slide: chunk.slide ?? undefined,
    slideRange: Array.isArray(chunk.slide_range) ? chunk.slide_range : undefined,
    section: chunk.heading ?? undefined,
    chunkId: chunk.chunk_id,
    practice: options.practice === true,
    origin: options.origin,
  })
}

/**
 * Render a reference for display: a short, human-readable citation.
 *
 * Local: `path (p.12)` or `path (§ Heading)`. Web: `title — url`. Inference and user-provided
 * sources say so explicitly, because v3 §15.3 requires the source class to be visible when it
 * changes how a statement should be read.
 *
 * @param ref - the reference.
 * @returns a single-line citation string.
 */
export function formatSourceRef(ref) {
  if (ref.source_type === 'external_web_source') {
    const head = ref.title ?? ref.url ?? '(no title)'
    return `${head}${ref.url ? ` — ${ref.url}` : ''} [external]`
  }
  if (ref.source_type === 'model_inference') return '[model inference — not professor material]'
  if (ref.source_type === 'user_provided') return '[user-provided]'

  const where = [
    ref.relative_path ?? ref.file_id,
    ref.page !== undefined && ref.page !== null
      ? (ref.page_range === undefined ? `p.${ref.page}` : `p.${ref.page_range[0]}–${ref.page_range[1]}`)
      : null,
    ref.slide !== undefined && ref.slide !== null
      ? (ref.slide_range === undefined ? `slide ${ref.slide}` : `slides ${ref.slide_range[0]}–${ref.slide_range[1]}`)
      : null,
    ref.section !== undefined && ref.section !== null ? `§ ${ref.section}` : null,
  ].filter(Boolean).join(' ')
  const origin = ref.origin !== undefined ? ` [${PRACTICE_ORIGIN_LABELS[ref.origin] ?? ref.origin}]` : ''
  return `${where}${origin}`.trim()
}

/**
 * Detect refs that disagree, so conflicts are surfaced rather than silently merged (v3 §15.3).
 *
 * Two refs conflict when they name the same `file_id` but report different `page`/`slide`, or the
 * same `chunk_id` but a different `section`.
 *
 * @param refs - candidate references.
 * @returns conflicts as `{ key, refs }`; empty when consistent.
 */
export function findProvenanceConflicts(refs) {
  const byFile = new Map()
  const byChunk = new Map()
  for (const ref of refs) {
    if (!isPlainObject(ref)) continue
    if (typeof ref.file_id === 'string' && (ref.page !== undefined || ref.slide !== undefined)) {
      const key = `${ref.file_id}:${ref.page ?? '-'}:${ref.slide ?? '-'}`
      byFile.set(key, [...(byFile.get(key) ?? []), ref])
    }
    if (typeof ref.chunk_id === 'string') {
      const key = ref.chunk_id
      byChunk.set(key, [...(byChunk.get(key) ?? []), ref])
    }
  }

  const conflicts = []
  const filePages = new Map()
  for (const [key, group] of byFile) {
    const fileId = key.split(':')[0]
    const pageKey = `${fileId}:${group[0].page ?? '-'}:${group[0].slide ?? '-'}`
    filePages.set(fileId, [...(filePages.get(fileId) ?? []), { pageKey, group }])
  }
  for (const [fileId, entries] of filePages) {
    if (entries.length > 1) {
      conflicts.push({ key: `file:${fileId}`, refs: entries.flatMap((entry) => entry.group) })
    }
  }

  const sections = new Map()
  for (const ref of byChunk.values()) {
    const first = ref[0]
    if (typeof first.section !== 'string') continue
    const distinct = new Set(ref.map((entry) => entry.section))
    if (distinct.size > 1) sections.set(first.chunk_id, ref)
  }
  for (const [chunkId, group] of sections) conflicts.push({ key: `chunk:${chunkId}`, refs: group })

  return conflicts
}
