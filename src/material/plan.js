/**
 * Reading plans for one lecture: text layer first, visual inspection second.
 *
 * A plan is pure data derived from an extraction outcome. It exists so a teaching turn can say
 * *which* pages were covered, *which* still need eyes, and *which* range the request was about —
 * before any image is rendered. Three rules shape it:
 *
 * 1. **Text layer first.** Pages with enough extracted text are `text_sufficient`; only the rest
 *    are marked `needs_visual`. A whole-lecture request never silently degrades into "the top few
 *    search chunks": the plan lists every physical page in scope.
 * 2. **Numbering is never guessed.** `page` is always the *physical* index inside the file.
 *    Printed/footer numbering is reported as `printed: null` with
 *    `correspondence: 'not-established'`, because this plugin does not parse footers and will not
 *    invent a mapping between the two systems.
 * 3. **Scope is explicit.** `whole-document` and `section` are different claims and are labelled
 *    differently in the coverage block, so "I read the section I was asked about" can never be
 *    reported as "I read the whole lecture".
 *
 * @module dsh-professor-spike/src/material/plan
 */

/** Below this many extracted characters a page is treated as needing visual inspection. */
export const VISUAL_TEXT_THRESHOLD = 120

/** A page at or above this many characters is answerable from its text layer alone. */
export const DEFAULT_VISUAL_THRESHOLD = VISUAL_TEXT_THRESHOLD

/** Hard ceiling on how many pages one plan will enumerate (keeps a pathological PDF bounded). */
export const MAX_PLAN_PAGES = 2000

/** How many per-page excerpt rows one payload carries before they are bounded. */
export const DEFAULT_PLAN_ROWS = 400

/**
 * The numbering block every plan and coverage report carries.
 *
 * Exported so there is exactly one spelling of the honesty claim, in the tool output, in the
 * coverage block and in the tests that pin it.
 *
 * @returns the numbering contract.
 */
export function numberingContract() {
  return {
    physical: '1-based page index inside the file (PDF page order)',
    printed: null,
    correspondence: 'not-established',
    note: 'printed/footer numbering was not parsed, so no mapping between the two systems is claimed',
  }
}

/**
 * Normalize a caller-supplied page range against a document.
 *
 * Absent bounds default to the whole document. Out-of-range bounds are clamped and reported
 * rather than thrown, because a model that asks for pages 1-90 of a 55-page deck should be told
 * the document ends at 55 instead of receiving an error it cannot act on.
 *
 * @param options.totalPages - physical page count, or null when unknown.
 * @param options.from - requested first page (1-based), optional.
 * @param options.to - requested last page (inclusive), optional.
 * @returns `{ from, to, scope, clamped, warnings }`.
 */
export function normalizeRange({ totalPages, from, to } = {}) {
  const warnings = []
  const known = Number.isInteger(totalPages) && totalPages > 0 ? Math.min(totalPages, MAX_PLAN_PAGES) : null
  const first = Number.isInteger(from) && from > 0 ? Math.floor(from) : null
  const last = Number.isInteger(to) && to > 0 ? Math.floor(to) : null

  if (first !== null && last !== null && last < first) {
    warnings.push(`page range ${first}-${last} is reversed; reading it as ${first}-${first}`)
  }
  let low = first ?? 1
  let high = Math.max(first ?? 1, last ?? (known ?? MAX_PLAN_PAGES))
  if (known === null) {
    if (first === null && last === null) {
      return { from: null, to: null, scope: 'whole-document', clamped: false, warnings, total: null }
    }
    warnings.push('total page count is unknown, so the range could not be validated against it')
    return { from: low, to: high, scope: 'section', clamped: false, warnings, total: null }
  }
  if (low > known) {
    warnings.push(`requested page ${low} is beyond the document (it has ${known} page(s))`)
    low = known
    high = known
  }
  if (high > known) {
    warnings.push(`requested page ${high} is beyond the document; clipped to ${known}`)
    high = known
  }
  if (high < low) high = low
  const clamped = (first !== null && low !== first) || (last !== null && high !== last)
  const scope = first === null && last === null ? 'whole-document' : 'section'
  return { from: low, to: high, scope, clamped, warnings, total: known }
}

/**
 * Classify one page from its extracted text length.
 *
 * @param chars - extracted character count for the page.
 * @param threshold - visual threshold (default {@link DEFAULT_VISUAL_THRESHOLD}).
 * @returns `'text_sufficient' | 'needs_visual' | 'no_text_layer'`.
 */
export function classifyPage(chars, threshold = DEFAULT_VISUAL_THRESHOLD) {
  const value = Number.isFinite(chars) ? chars : 0
  if (value <= 0) return 'no_text_layer'
  return value < threshold ? 'needs_visual' : 'text_sufficient'
}

/**
 * Build the reading plan for one source.
 *
 * @param options.pages - extraction pages, `[{ page, text }]`, in file order.
 * @param options.totalPages - physical page count when the backend reported one.
 * @param options.from / options.to - requested range (see {@link normalizeRange}).
 * @param options.threshold - visual threshold.
 * @param options.textAvailable - whether a text layer could be read at all.
 * @param options.textReason - why not, when `textAvailable` is false.
 * @returns the plan object.
 */
export function buildReadingPlan(options = {}) {
  const {
    pages = [], totalPages = null, from = null, to = null,
    threshold = DEFAULT_VISUAL_THRESHOLD, textAvailable = true, textReason = null,
  } = options

  const measured = new Map()
  const visualFeatures = new Map()
  for (const entry of pages) {
    const pageNumber = Number.isInteger(entry?.page) ? entry.page : null
    if (pageNumber === null) continue
    measured.set(pageNumber, String(entry.text ?? ''))
    visualFeatures.set(pageNumber, Array.isArray(entry.visual_features) ? entry.visual_features : [])
  }
  const total = Number.isInteger(totalPages) && totalPages > 0
    ? Math.min(totalPages, MAX_PLAN_PAGES)
    : measured.size > 0
      ? Math.max(...measured.keys())
      : null

  const range = normalizeRange({ totalPages: total, from, to })
  const inScope = []
  if (range.from !== null && range.to !== null) {
    for (let page = range.from; page <= range.to; page += 1) inScope.push(page)
  } else {
    for (const page of [...measured.keys()].sort((a, b) => a - b)) inScope.push(page)
  }

  const needsVisual = []
  const textSufficient = []
  const noTextLayer = []
  const perPage = []
  for (const page of inScope) {
    const text = measured.get(page) ?? null
    const chars = text === null ? 0 : text.length
    const features = visualFeatures.get(page) ?? []
    const classification = textAvailable === false || features.length > 0
      ? 'needs_visual'
      : classifyPage(chars, threshold)
    if (classification === 'needs_visual') needsVisual.push(page)
    else if (classification === 'no_text_layer') noTextLayer.push(page)
    else textSufficient.push(page)
    perPage.push({
      page,
      text_chars: chars,
      classification,
      ...(features.length > 0 ? { visual_features: features } : {}),
      // A short, verbatim slice of the text layer so the model can keep teaching after an image
      // is offloaded. Never a paraphrase: this is source text, not a summary of it.
      excerpt: text === null || text.trim().length === 0
        ? null
        : text.replace(/\s+/g, ' ').trim().slice(0, 240),
    })
  }

  return {
    method: 'text-layer-first',
    scope: range.scope,
    range: { from: range.from, to: range.to },
    total_pages: total,
    pages_in_scope: inScope.length,
    needs_visual: needsVisual,
    text_sufficient: textSufficient,
    no_text_layer: noTextLayer,
    per_page: perPage,
    numbering: numberingContract(),
    // Honesty about what the classifier can and cannot see: a thin text layer or a detected
    // visual feature is a reason to look, not proof that a chart, formula or diagram exists.
    classification_note: 'needs_visual means the text layer is thin or visual features '
      + '(embedded-image, vector-drawing) were detected; it does not prove a chart, formula or '
      + 'diagram is present, and text_sufficient does not mean the body has been delivered to you. '
      + 'Inspect any page that matters with action "pages" regardless of its classification.',
    text_layer: {
      available: textAvailable === true,
      ...(textReason === null ? {} : { reason: textReason }),
      threshold_chars: threshold,
    },
    warnings: range.warnings,
    ...(range.scope === 'whole-document'
      ? { whole_document_note: 'this plan enumerates every physical page in the document; a set of search hits is not coverage of it' }
      : { section_note: 'this plan covers only the requested page range; do not report it as whole-document coverage' }),
  }
}

/**
 * Re-scope a cached plan to a narrower range without re-reading the text layer.
 *
 * The per-page classifications and excerpts are already derived facts, so narrowing a view over
 * them changes only `scope`, `range` and the four page lists. Anything else would be re-derived
 * from an excerpt, which is exactly how character counts drift.
 *
 * @param plan - a plan built by {@link buildReadingPlan}.
 * @param options.from / options.to - the new range.
 * @returns a new plan object.
 */
export function rescopeReadingPlan(plan, { from = null, to = null } = {}) {
  const range = normalizeRange({ totalPages: plan?.total_pages ?? null, from, to })
  const perPage = (plan?.per_page ?? []).filter(
    (entry) => range.from === null || range.to === null || (entry.page >= range.from && entry.page <= range.to),
  )
  const pages = perPage.map((entry) => entry.page)
  const pick = (classification) => perPage.filter((entry) => entry.classification === classification).map((entry) => entry.page)
  return {
    ...plan,
    scope: range.scope,
    range: { from: range.from, to: range.to },
    pages_in_scope: pages.length,
    needs_visual: pick('needs_visual'),
    text_sufficient: pick('text_sufficient'),
    no_text_layer: pick('no_text_layer'),
    per_page: perPage,
    warnings: [...(plan?.warnings ?? []), ...range.warnings],
    ...(range.scope === 'whole-document'
      ? { whole_document_note: 'this plan enumerates every physical page in the document; a set of search hits is not coverage of it' }
      : { section_note: 'this plan covers only the requested page range; do not report it as whole-document coverage' }),
  }
}

/**
 * Bound the per-page rows a payload carries.
 *
 * Excerpts are the expensive part of a plan: 2 000 pages at 240 characters each is close to half a
 * megabyte of text that a model does not need in one shot. `keep` narrows the rows to exactly the
 * pages a call is about (the `pages` action), and the default cap keeps the first chunk of a whole
 * document. The *counts* and the classification lists are never truncated — only the excerpts — so
 * coverage stays complete no matter how the rows were bounded.
 *
 * @param plan - a plan built by {@link buildReadingPlan} or {@link rescopeReadingPlan}.
 * @param options.maxRows - how many per-page rows to keep by default.
 * @param options.keep - explicit page numbers to keep instead.
 * @returns a new plan with `per_page` bounded and the fact recorded on the plan itself.
 */
export function compactPlan(plan, { maxRows = DEFAULT_PLAN_ROWS, keep = null } = {}) {
  // Full source bodies stay in the in-process ledger, never in overview/status payloads.
  const { source_blocks: _sourceBlocks, ...overview } = plan
  plan = overview
  const all = Array.isArray(plan?.per_page) ? plan.per_page : []
  const kept = keep === null
    ? all.slice(0, Math.max(1, Math.floor(maxRows)))
    : all.filter((entry) => keep.includes(entry.page))
  const omitted = all.length - kept.length
  if (omitted === 0) return { ...plan, per_page: kept, per_page_total: all.length, per_page_truncated: false }
  return {
    ...plan,
    per_page: kept,
    per_page_total: all.length,
    per_page_truncated: true,
    per_page_note: keep === null
      ? `per-page excerpts are bounded to the first ${kept.length} of ${all.length} page(s); `
        + 'the classification lists and coverage counts above cover every page — ask for a page range '
        + 'to read excerpts for the rest'
      : `per-page excerpts are limited to the ${kept.length} page(s) this call is about; `
        + `${omitted} other page(s) are covered by the classification lists and coverage counts`,
  }
}

/**
 * The honest coverage sentence, derived from delivery counts rather than text classification.
 *
 * The buckets this reads are *delivery* states (see the ledger's `coverage`): an emitted page
 * image, a complete source body, part of one, a bounded excerpt only, the model's own note, or
 * nothing. A page whose text layer is merely long enough to classify `text_sufficient` is never
 * described as read here — its body still has to reach the model through `action: "text"`.
 *
 * @param coverage - the coverage block.
 * @returns a one-line statement of what is and is not established.
 */
export function coverageStatement(coverage) {
  const {
    inspected_count: inspected = 0, text_complete_count: textComplete = 0,
    text_partial_count: textPartial = 0, overview_only_count: overview = 0,
    noted_count: noted = 0, unread_count: unread = 0, unreadable_count: unreadable = 0,
    scope = 'whole-document', total = null,
    document_body: documentBody = null,
  } = coverage
  if (total === 0) {
    const bodyPart = documentBody !== null && documentBody.total_chars > 0
      ? ` The document body is ${documentBody.complete === true ? 'fully' : 'partially'} delivered`
        + ` (${documentBody.delivered_chars}/${documentBody.total_chars} characters).`
      : ''
    return 'No per-page coverage could be established for this source: page coordinates were '
      + 'unavailable, so nothing can be claimed about which pages were read. Say so explicitly '
      + 'instead of implying coverage.' + bodyPart
  }
  const parts = [
    `${inspected} page image(s) delivered`,
    `${textComplete} page(s) with complete source body delivered`,
    `${textPartial} page(s) with partial source body delivered`,
    `${overview} page(s) with only a bounded excerpt/overview returned`,
    `${noted} page(s) covered only by your own note`,
    `${unread} unread`,
    `${unreadable} unreadable`,
  ]
  const prefix = scope === 'whole-document' ? 'Whole-document coverage: ' : 'Section coverage: '
  const tail = unread > 0
    ? '. Search hits and earlier notes do not count as coverage of the unread pages.'
    : '. Every page in scope is accounted for.'
  return `${prefix}${parts.join(', ')}${tail}`
    + ' Delivery is proven; comprehension, mastery and actual use are not.'
    + ' Excerpts are overviews, never the source body: use action "text" for bodies still missing.'
}
