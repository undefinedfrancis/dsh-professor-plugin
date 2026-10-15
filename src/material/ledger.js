/**
 * The per-session reading ledger: what has been inspected, what it cost, and what may be reused.
 *
 * This is the deterministic half of Repair A. The model can forget a page the moment the host
 * offloads its image; the ledger cannot. Every successful page inspection is recorded against a
 * **stable identity** — source content hash, physical page number and rendering variant — so an
 * unchanged page at the same resolution is answered from the ledger (text excerpt + the model's
 * own note) instead of being attached to the request a second time.
 *
 * Scope and lifetime, deliberately narrow:
 *
 * - **in-process only.** Nothing here is written to disk, so no cache of lecture material can
 *   outlive the plugin or leak into an unrelated session.
 * - **per session.** Two sessions never see each other's coverage.
 * - **bounded.** Sessions, pages per session and note length all have caps; the oldest entry is
 *   dropped rather than grown without limit.
 * - **no timers, no background work.** Everything is computed synchronously from a call, so a
 *   cancelled or disposed session cannot leave anything running.
 *
 * Budgets are three nested ceilings — per call, per turn, per session — over *both* page count and
 * attached bytes. The host's own request bound (20,971,520 bytes of base64) is the reason these
 * exist: the plugin keeps its own contribution well inside it rather than discovering the limit
 * after the fact. A turn boundary is derived from the session's `turn/start` events when the host
 * exposes them, and falls back to the session scope when it does not (reported, never assumed).
 *
 * ## What a "byte" is here
 *
 * Every counter in this module is charged in **binary encoded image bytes** ({@link COST_UNIT}) —
 * the length `render_pages.py` measures when it stops, and the length `attachments.saveImage`
 * reports back. The host bounds the *request* by base64 length instead, which is 4/3 of that; the
 * budget block reports {@link base64RequestBytes} alongside the binary figure so a reader can
 * compare like with like. Nothing is ever counted in one unit and compared against a limit in the
 * other.
 *
 * ## Concurrency
 *
 * Two overlapping calls for one session must not both spend the same remaining capacity, and must
 * not render the same unchanged page twice. Three things guarantee that:
 *
 * 1. **Reservations are synchronous.** `reserve` checks *and* holds capacity in one non-awaiting
 *    step, so two calls can never both observe the same free bytes — JavaScript interleaves only
 *    at `await`, and there is none here.
 * 2. **Page claims are synchronous.** `claimPage` marks a physical page as in flight before any
 *    rendering starts, so a second call is told `in-flight` instead of producing a second image.
 * 3. **A per-session lock** serialises whole `pages` calls for *one* session only; unrelated
 *    sessions never queue behind each other.
 *
 * Every ledger mutation happens in a non-awaiting block; reservations are released in a `finally`
 * so a cancellation, a failed render or a refused attachment can never leak held capacity.
 *
 * @module dsh-professor-spike/src/material/ledger
 */

/** Default bounds; every one is overridable through `config.materialReadBudget`. */
export const DEFAULT_BUDGET = Object.freeze({
  /** Pages that may be *attached* in one call. */
  maxPagesPerCall: 4,
  /** Attachment bytes that may be spent in one call. */
  maxBytesPerCall: 2 * 1024 * 1024,
  /** Images that may be attached while one user turn is in progress. */
  maxImagesPerTurn: 6,
  /** Attachment bytes that may be spent while one user turn is in progress. */
  maxBytesPerTurn: 4 * 1024 * 1024,
  /** Attachment bytes that may be attached over the whole session. */
  maxBytesPerSession: 10 * 1024 * 1024,
  /** Longest edge of a rendered page, in pixels (stays inside the host's normalization cap). */
  maxSide: 1600,
  /** JPEG quality for a rendered page. */
  quality: 80,
  /** Characters accepted for one model-written page note. */
  maxNoteChars: 600,
  /** Notes accepted in one call. */
  maxNotesPerCall: 24,
})

/** Justifications that legitimately allow an already-inspected page to be attached again. */
export const REREAD_REASONS = Object.freeze(['unreadable', 'explicit-user-request'])

/**
 * The unit every byte budget in this module is counted and compared in.
 *
 * Binary encoded image bytes — what the renderer measures and what `saveImage` reports. The host's
 * request bound is base64 length; use {@link base64RequestBytes} to convert for comparison, and
 * never mix the two inside one check.
 */
export const COST_UNIT = 'binary-encoded-image-bytes'

/** Base64 expands three binary bytes into four characters, rounded up to a whole quantum. */
export function base64RequestBytes(binaryBytes) {
  const value = Number.isFinite(binaryBytes) && binaryBytes > 0 ? Math.floor(binaryBytes) : 0
  return Math.ceil(value / 3) * 4
}

/**
 * Reasons the tool reports when it declines to attach a page.
 *
 * Each one names a *different* stopping condition, because "not delivered" alone cannot tell a
 * caller whether to retry now, retry next turn, or fix its request.
 */
export const SUPPRESSION = Object.freeze({
  ALREADY_INSPECTED: 'already-inspected',
  BUDGET_EXHAUSTED: 'budget-exhausted',
  /** The per-call page ceiling stopped the selection before any byte budget was consulted. */
  CALL_LIMIT: 'call-limit',
  /** The per-turn image-count ceiling is spent; byte budgets are irrelevant to this refusal. */
  IMAGE_LIMIT: 'image-count-exhausted',
  /** One page on its own is larger than the whole per-call byte budget; retrying cannot help. */
  PAGE_EXCEEDS_BUDGET: 'page-exceeds-budget',
  /** Another call for this session is rendering this page right now. */
  CONCURRENT: 'concurrent-call-in-flight',
  /** The attachment service refused the bytes. */
  ATTACHMENT_FAILED: 'attachment-failed',
  /** The attachment service accepted the bytes but returned an unusable reference (bad metadata). */
  ATTACHMENT_INVALID: 'attachment-invalid',
  /** The rendered page could not be included in the model-facing output, so it was not delivered. */
  OUTPUT_FAILED: 'output-failed',
  /** The renderer stopped at its byte budget before reaching this page. */
  RENDERER_OMITTED: 'renderer-omitted',
  /** The renderer ran and failed outright. */
  RENDER_FAILED: 'render-failed',
  /** No renderer is wired in this context at all (a host without a shell seam, say). */
  NO_RENDERER: 'renderer-unavailable',
  /** The page is beyond the last page of this document. */
  OUT_OF_RANGE: 'out-of-range',
  REASON_REQUIRED: 'justification-required',
  SOURCE_CHANGED: 'source-changed',
  VARIANT_CHANGED: 'variant-changed',
  NOT_INSPECTED: 'not-inspected',
})

/** The error a cancelled material read throws; identical wherever it is raised. */
export function cancelledError() {
  const error = new Error('this material read was cancelled before it finished')
  error.code = 'PROFESSOR_CANCELLED'
  return error
}

/** Merge caller overrides onto the defaults, ignoring anything that is not a positive integer. */
export function resolveBudget(overrides = {}) {
  const budget = { ...DEFAULT_BUDGET }
  for (const key of Object.keys(DEFAULT_BUDGET)) {
    const value = overrides?.[key]
    if (Number.isFinite(value) && value > 0) budget[key] = Math.floor(value)
  }
  return budget
}

/** The stable identity of one rendered page of one source. */
export function pageKey({ sourceHash, page, variant }) {
  return `${sourceHash}#${page}@${variant}`
}

/**
 * The stable identity of one full text body — a page body, or the whole body of an unpaged source.
 *
 * Identity covers the body's *version*: the family (`'source'` for plain text-layer bodies,
 * `'enhanced'` for OCR/enhanced bodies) and a fingerprint of every character of the body in block
 * order. Two bodies share an id only when they are the same text in the same family, so intervals
 * measured against one body resume when that body returns and are never applied to another — not
 * even to an equal-length or character-identical body of the other family. The fingerprint hashes
 * the concatenated characters without separators: two block decompositions of the same text are
 * the same body, and their cumulative offsets mean the same thing.
 *
 * @param family - `'source'` or `'enhanced'`.
 * @param parts - the body's block texts in delivery order (their concatenation is the body).
 * @returns the body id string.
 */
export function textBodyId(family, parts) {
  const list = Array.isArray(parts) ? parts : [parts]
  const label = String(family ?? 'source')
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  const feed = (string) => {
    for (let index = 0; index < string.length; index += 1) {
      const code = string.charCodeAt(index)
      h1 = Math.imul(h1 ^ code, 2654435761)
      h2 = Math.imul(h2 ^ code, 1597334677)
    }
  }
  feed(label)
  feed(' ')
  let total = 0
  for (const part of list) {
    const text = String(part ?? '')
    total += text.length
    feed(text)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${label}:${total}:${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`
}

/** How many body versions one page (or document) keeps before the oldest are dropped. */
const MAX_BODY_VERSIONS = 8

/** The rendering variant string a request asks for. */
export function renderVariant({ maxSide, quality }) {
  return `${Math.floor(maxSide)}px-q${Math.floor(quality)}`
}

/**
 * Decide whether an existing inspection may be reused instead of re-attached.
 *
 * A page is reusable only when the source hash, the physical page number **and** the rendering
 * variant are all identical: an unchanged file at an unchanged resolution carries no new
 * information, and the ledger still holds the excerpt and the model's note for it. A different
 * source hash or a different variant is a different identity, so it is never suppressed by this
 * rule. A record that carries only a note (the model wrote one but never received an image through
 * this tool) is not an inspection at all, so it never suppresses a first attachment. Neither does
 * a record whose image never reached the model-facing result (`emitted === false`): an attachment
 * that was stored but not included in the tool result is not a delivered inspection, and
 * suppressing it would permanently hide the page from the model.
 *
 * @param options.existing - the ledger record, or undefined.
 * @param options.variant - the variant being requested now.
 * @param options.reason - the caller's justification, if any.
 * @returns `{ reuse: boolean, reason: string }`.
 */
export function reuseDecision({ existing, variant, reason } = {}) {
  if (existing === undefined || existing === null) return { reuse: false, reason: SUPPRESSION.NOT_INSPECTED }
  if (existing.variant === null || existing.status === 'noted') return { reuse: false, reason: SUPPRESSION.NOT_INSPECTED }
  if (existing.emitted === false) return { reuse: false, reason: SUPPRESSION.NOT_INSPECTED }
  if (existing.variant !== variant) return { reuse: false, reason: SUPPRESSION.VARIANT_CHANGED }
  if (typeof reason === 'string' && REREAD_REASONS.includes(reason)) {
    return { reuse: false, reason: `justified:${reason}` }
  }
  return { reuse: true, reason: SUPPRESSION.ALREADY_INSPECTED }
}

/**
 * Build the ledger.
 *
 * @param options.budget - partial budget overrides ({@link resolveBudget}).
 * @param options.maxSessions - how many sessions to retain.
 * @param options.maxPages - how many inspected pages to retain per session and source.
 * @param options.now - clock (tests).
 * @returns the ledger surface.
 */
export function createReadingLedger(options = {}) {
  const budget = resolveBudget(options.budget)
  const maxSessions = Number.isInteger(options.maxSessions) && options.maxSessions > 0 ? options.maxSessions : 32
  const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0 ? options.maxPages : 512
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString()
  const sessions = new Map()
  /** Per-session tail promise for {@link withLock}; one queue per session, never a global one. */
  const locks = new Map()

  function stateFor(sessionId) {
    const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'no-session'
    let state = sessions.get(key)
    if (state === undefined) {
      state = {
        id: key,
        turnIndex: null,
        // Settled cost: what has actually been delivered to the model.
        turn: { images: 0, bytes: 0 },
        total: { images: 0, bytes: 0 },
        // Reserved cost: held by an in-flight call and not yet delivered. Counted against every
        // limit so a second call can never spend the same remaining capacity.
        turnHeld: { images: 0, bytes: 0 },
        totalHeld: { images: 0, bytes: 0 },
        suppressed: 0,
        justified: 0,
        sources: new Map(),
        claims: new Set(),
      }
      sessions.set(key, state)
      // Bounded: the oldest session is dropped rather than the map growing without limit.
      while (sessions.size > maxSessions) {
        const oldest = sessions.keys().next().value
        sessions.delete(oldest)
      }
    }
    return state
  }

  function stateOf(sessionId) {
    return sessions.get(typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'no-session')
  }

  function claimKey({ sourceHash, page }) {
    return `${sourceHash}#${page}`
  }

  function sourceState(state, sourceHash) {
    let source = state.sources.get(sourceHash)
    if (source === undefined) {
      source = {
        pages: new Map(),
        plan: null,
        planAt: null,
        // Source-body delivery, per physical page (or 'document' for formats without page
        // coordinates). Each key holds the CURRENT body version's id plus a small map of
        // per-version delivery: the full body length each version was read against, and its
        // delivered character intervals merged into a minimal set. Intervals of different
        // versions never merge (see `recordTextDelivery`). Delivery proof, not classification.
        text: new Map(),
        // Pages whose bounded excerpt/overview row appeared in a projected model-facing result.
        overview: new Set(),
      }
      state.sources.set(sourceHash, source)
    }
    return source
  }

  /**
   * Adopt the caller's turn index when the host exposes one.
   *
   * A new turn resets the per-turn counters only; the session ceiling keeps accumulating, which is
   * what stops a multi-turn loop from re-attaching the same bytes forever. When no turn index is
   * available the per-turn budget degrades to the session scope — `scope` reports which was used.
   *
   * @returns `{ scope: 'turn' | 'session' | 'unknown', turnIndex }`.
   */
  function beginTurn(sessionId, turnIndex) {
    const state = stateFor(sessionId)
    const index = Number.isInteger(turnIndex) && turnIndex > 0 ? turnIndex : null
    if (index !== null && index !== state.turnIndex) {
      state.turnIndex = index
      state.turn = { images: 0, bytes: 0 }
    }
    return { scope: index === null ? 'unknown' : 'turn', turnIndex: index }
  }

  /** Record a model-written note for one page. Returns what was stored. */
  function setNote(sessionId, { sourceHash, page, text, budget: noteBudget }) {
    const limit = Number.isInteger(noteBudget) ? noteBudget : budget.maxNoteChars
    const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, limit) : ''
    if (value.length === 0 || !Number.isInteger(page)) return { stored: false, page }
    const state = stateFor(sessionId)
    const source = sourceState(state, sourceHash)
    const existing = source.pages.get(page)
    const stamp = now()
    if (existing === undefined) {
      source.pages.set(page, {
        page, sourceHash, variant: null, status: 'noted', at: stamp, note: value,
        noteAt: stamp, bytes: 0, textChars: null, excerpt: null,
      })
    } else {
      existing.note = value
      existing.noteAt = stamp
    }
    trim(source)
    return { stored: true, page, chars: value.length }
  }

  /**
   * Record one completed inspection (image delivered, or explicitly marked unreadable).
   *
   * `emitted` marks whether the page image was actually included in a model-facing tool result.
   * It defaults to true for callers that only record after emission; pass `false` for a record
   * that exists (e.g. attachment cost was settled) but whose image never reached the model —
   * such a record never suppresses a re-read ({@link reuseDecision}) and never counts as
   * `inspected` in {@link coverage}.
   */
  function recordInspection(sessionId, entry) {
    const state = stateFor(sessionId)
    const source = sourceState(state, entry.sourceHash)
    const stamp = entry.at ?? now()
    const previous = source.pages.get(entry.page)
    const record = {
      page: entry.page,
      sourceHash: entry.sourceHash,
      variant: entry.variant ?? previous?.variant ?? null,
      status: entry.status ?? 'inspected',
      emitted: entry.emitted !== false,
      at: stamp,
      bytes: Number.isFinite(entry.bytes) ? entry.bytes : 0,
      width: Number.isFinite(entry.width) ? entry.width : null,
      height: Number.isFinite(entry.height) ? entry.height : null,
      attachmentId: entry.attachmentId ?? null,
      textChars: Number.isFinite(entry.textChars) ? entry.textChars : (previous?.textChars ?? null),
      excerpt: entry.excerpt ?? previous?.excerpt ?? null,
      note: entry.note ?? previous?.note ?? null,
      noteAt: previous?.noteAt ?? null,
    }
    source.pages.set(entry.page, record)
    trim(source)
    return record
  }

  function trim(source) {
    while (source.pages.size > maxPages) {
      const oldest = source.pages.keys().next().value
      source.pages.delete(oldest)
    }
  }

  /** Look up one page's inspection record for a source. */
  function find(sessionId, { sourceHash, page }) {
    const state = sessions.get(typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'no-session')
    if (state === undefined) return undefined
    return state.sources.get(sourceHash)?.pages.get(page)
  }

  /** Merge one `[start, end)` interval into a sorted, minimal interval list. */
  function mergeIntervals(intervals, [start, end]) {
    const merged = []
    let placed = false
    for (const [low, high] of intervals) {
      if (high < start) { merged.push([low, high]); continue }
      if (end < low) {
        if (!placed) { merged.push([start, end]); placed = true }
        merged.push([low, high])
        continue
      }
      start = Math.min(start, low)
      end = Math.max(end, high)
    }
    if (!placed) merged.push([start, end])
    return merged
  }

  /** Total covered characters of an interval list, clipped to `[0, length]`. */
  function coveredChars(intervals, length) {
    let covered = 0
    for (const [low, high] of intervals) {
      covered += Math.max(0, Math.min(high, length) - Math.min(low, length))
    }
    return Math.min(covered, length)
  }

  /**
   * Record which character intervals of which source bodies actually reached the model.
   *
   * Each segment names the source identity, the physical page (or `null` for formats without page
   * coordinates, tracked under `'document'`), the stable identity of the body it belongs to
   * (`bodyId`, see {@link textBodyId}), the delivered `[start, end)` interval at *cumulative body
   * offsets* — offsets into the concatenation of every source block of that body — and the body's
   * full length as read. Coverage therefore aggregates across all blocks of a body: one fully
   * delivered block covers only its own range, never the whole page.
   *
   * Intervals of different bodies never merge. Enhanced and plain-text bodies of one page are
   * separate versions even when their text and lengths match exactly, so switching between them
   * reuses nothing; returning to a previously tracked body resumes exactly its own intervals.
   * A segment whose body id is known but whose length contradicts what was recorded restarts that
   * version: intervals measured against a different length say nothing about this one. A segment
   * without a `bodyId` cannot be attributed to any body and is never recorded — an unattributable
   * interval must not become a delivery claim.
   *
   * Records replace rather than mutate, so {@link commitDelivery} can undo them by restoring the
   * previous record object.
   */
  function recordTextDelivery(sessionId, { sourceHash, segments }) {
    const state = stateFor(sessionId)
    const source = sourceState(state, sourceHash)
    for (const segment of segments ?? []) {
      const key = Number.isInteger(segment?.page) ? segment.page : 'document'
      const bodyId = typeof segment?.bodyId === 'string' && segment.bodyId.length > 0 ? segment.bodyId : null
      if (bodyId === null) continue
      const start = Math.max(0, Math.floor(segment?.start ?? 0))
      const end = Math.max(start, Math.floor(segment?.end ?? 0))
      const length = Number.isFinite(segment?.length) && segment.length >= 0 ? Math.floor(segment.length) : 0
      const existing = source.text.get(key)
      // Copy-on-write all the way down: `commitDelivery` undoes a call by restoring the previous
      // record object, so nothing reachable from it may ever be mutated in place.
      const versions = new Map(existing?.versions ?? [])
      const prior = versions.get(bodyId)
      const base = prior !== undefined && prior.length === length
        ? prior
        : { bodyId, length, intervals: [], origin: segment?.origin ?? prior?.origin ?? 'source' }
      const merged = end > start ? mergeIntervals(base.intervals, [start, end]) : base.intervals
      versions.set(bodyId, { ...base, length, intervals: merged })
      while (versions.size > MAX_BODY_VERSIONS) {
        const oldest = [...versions.keys()].find((id) => id !== bodyId)
        if (oldest === undefined) break
        versions.delete(oldest)
      }
      source.text.set(key, { current: bodyId, versions })
    }
  }

  /**
   * Commit one call's delivery — inspections, body intervals and overview rows — as one undoable
   * step.
   *
   * The tool calls this only after its output projection has succeeded, so a rendering failure can
   * never leave "delivered" records behind for work the model never received; the returned `undo`
   * restores the exact prior state if a later gate still fails.
   */
  function commitDelivery(sessionId, { sourceHash, inspections = [], textSegments = [], overviewPages = [] } = {}) {
    const state = stateFor(sessionId)
    const source = sourceState(state, sourceHash)
    const undoPages = new Map()
    for (const entry of inspections) {
      if (!undoPages.has(entry.page)) undoPages.set(entry.page, source.pages.get(entry.page))
      recordInspection(sessionId, entry)
    }
    const undoText = []
    for (const segment of textSegments) {
      const key = Number.isInteger(segment?.page) ? segment.page : 'document'
      if (!undoText.some((item) => item.key === key)) undoText.push({ key, record: source.text.get(key) })
    }
    if (textSegments.length > 0) recordTextDelivery(sessionId, { sourceHash, segments: textSegments })
    const undoOverview = []
    for (const page of overviewPages) {
      if (!source.overview.has(page)) {
        source.overview.add(page)
        undoOverview.push(page)
      }
    }
    return function undoDelivery() {
      for (const [page, previous] of undoPages) {
        if (previous === undefined) source.pages.delete(page)
        else source.pages.set(page, previous)
      }
      for (const { key, record } of undoText) {
        if (record === undefined) source.text.delete(key)
        else source.text.set(key, record)
      }
      for (const page of undoOverview) source.overview.delete(page)
    }
  }

  /**
   * How much more this call may spend, in one synchronous read.
   *
   * `call` carries the caller's own per-call counters (they are private to one invocation, so they
   * live outside the ledger); everything else is the live session state minus what is already
   * settled **and** what is already reserved by an in-flight call.
   *
   * @param call - `{ imagesUsed, imagesLimit, bytesUsed, bytesLimit }`, or null for no call scope.
   * @returns `{ images, bytes, parts }` — the smallest remaining capacity across every ceiling.
   */
  function capacity(sessionId, call = null) {
    const state = stateFor(sessionId)
    const callImages = call === null
      ? budget.maxPagesPerCall
      : Math.max(0, call.imagesLimit - call.imagesUsed)
    const callBytes = call === null
      ? budget.maxBytesPerCall
      : Math.max(0, call.bytesLimit - call.bytesUsed)
    const turnImages = Math.max(0, budget.maxImagesPerTurn - state.turn.images - state.turnHeld.images)
    const turnBytes = Math.max(0, budget.maxBytesPerTurn - state.turn.bytes - state.turnHeld.bytes)
    const sessionBytes = Math.max(
      0, budget.maxBytesPerSession - state.total.bytes - state.totalHeld.bytes,
    )
    return {
      images: Math.min(callImages, turnImages),
      bytes: Math.min(callBytes, turnBytes, sessionBytes),
      parts: { callImages, callBytes, turnImages, turnBytes, sessionBytes },
    }
  }

  function refusal(scope, unit, used, limit, requested) {
    return { ok: false, scope, unit, used, limit, requested }
  }

  /**
   * Hold capacity for work that has been decided on but not delivered yet.
   *
   * The check and the hold happen in the same non-awaiting step, which is what makes them atomic:
   * a second call that runs before this one settles sees the held amount, not the free amount, so
   * two calls can never both spend the last of a budget. Page capacity is usually reserved first
   * (images unknown until render), then bytes once the renderer reports real sizes.
   *
   * @param options.call - per-call counters, so the call ceiling is honoured cumulatively too.
   * @returns `{ ok: true, reservation }` or `{ ok: false, scope, unit, used, limit, requested }`.
   */
  function reserve(sessionId, { images = 0, bytes = 0, call = null } = {}) {
    const state = stateFor(sessionId)
    if (call !== null) {
      if (call.imagesUsed + images > call.imagesLimit) {
        return refusal('call', 'pages', call.imagesUsed, call.imagesLimit, images)
      }
      if (call.bytesUsed + bytes > call.bytesLimit) {
        return refusal('call', 'bytes', call.bytesUsed, call.bytesLimit, bytes)
      }
    }
    const turnImages = state.turn.images + state.turnHeld.images
    if (turnImages + images > budget.maxImagesPerTurn) {
      return refusal('turn', 'images', turnImages, budget.maxImagesPerTurn, images)
    }
    const turnBytes = state.turn.bytes + state.turnHeld.bytes
    if (turnBytes + bytes > budget.maxBytesPerTurn) {
      return refusal('turn', 'bytes', turnBytes, budget.maxBytesPerTurn, bytes)
    }
    const sessionBytes = state.total.bytes + state.totalHeld.bytes
    if (sessionBytes + bytes > budget.maxBytesPerSession) {
      return refusal('session', 'bytes', sessionBytes, budget.maxBytesPerSession, bytes)
    }
    state.turnHeld.images += images
    state.turnHeld.bytes += bytes
    state.totalHeld.images += images
    state.totalHeld.bytes += bytes
    return { ok: true, reservation: { images, bytes } }
  }

  /** Give a reservation back — a cancellation, a refused attachment, an oversized page. */
  function release(sessionId, reservation) {
    if (reservation === undefined || reservation === null) return
    const state = stateFor(sessionId)
    state.turnHeld.images = Math.max(0, state.turnHeld.images - (reservation.images ?? 0))
    state.turnHeld.bytes = Math.max(0, state.turnHeld.bytes - (reservation.bytes ?? 0))
    state.totalHeld.images = Math.max(0, state.totalHeld.images - (reservation.images ?? 0))
    state.totalHeld.bytes = Math.max(0, state.totalHeld.bytes - (reservation.bytes ?? 0))
  }

  /**
   * Convert a reservation into delivered cost.
   *
   * `actual` is what the attachment service really charged, which may be smaller than the rendered
   * size it was reserved for. The held amount is always returned in full and the settled amount
   * applied exactly, so `used` never drifts from what the model actually received.
   *
   * @returns the session's settled turn counters.
   */
  function settle(sessionId, reservation, actual = {}) {
    release(sessionId, reservation)
    const state = stateFor(sessionId)
    const images = Number.isFinite(actual.images) ? actual.images : 0
    const bytes = Number.isFinite(actual.bytes) ? actual.bytes : 0
    state.turn.images += images
    state.turn.bytes += bytes
    state.total.images += images
    state.total.bytes += bytes
    return { ...state.turn }
  }

  /**
   * Claim a physical page for this session so a concurrent call cannot render it twice.
   *
   * The claim covers the page regardless of rendering variant: two variants of the same page are
   * still two renders of the same content, and the budget only has room for one at a time.
   *
   * @returns `{ ok: true }` or `{ ok: false, reason: 'in-flight' }`.
   */
  function claimPage(sessionId, { sourceHash, page }) {
    const state = stateFor(sessionId)
    const key = claimKey({ sourceHash, page })
    if (state.claims.has(key)) return { ok: false, reason: 'in-flight' }
    state.claims.add(key)
    return { ok: true }
  }

  /** Release a claim. Idempotent, so a `finally` can clear everything without counting. */
  function releaseClaim(sessionId, { sourceHash, page }) {
    const state = stateOf(sessionId)
    if (state === undefined) return false
    return state.claims.delete(claimKey({ sourceHash, page }))
  }

  /** Claims currently held — for tests and diagnostics only. */
  function activeClaims(sessionId) {
    return [...(stateOf(sessionId)?.claims ?? [])]
  }

  /**
   * Run `fn` with exclusive access to one session's reading state.
   *
   * Scoped by session id on purpose: two unrelated sessions never queue behind each other, and a
   * call that is aborted while it waits is rejected instead of running. A rejected `fn` never
   * poisons the queue for the next caller.
   *
   * @param sessionId - the session to serialise on.
   * @param fn - the critical section; may be async.
   * @param options.signal - abort while queued, and `fn` is skipped.
   * @returns the promise `fn` produced.
   */
  function withLock(sessionId, fn, { signal } = {}) {
    const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'no-session'
    const previous = locks.get(key) ?? Promise.resolve()
    const run = previous.then(() => {
      if (signal?.aborted === true) throw cancelledError()
      return fn()
    })
    // The queue tail never rejects, so one failed caller cannot break the next.
    const guard = run.then(() => undefined, () => undefined)
    locks.set(key, guard)
    guard.then(() => {
      if (locks.get(key) === guard) locks.delete(key)
    })
    return run
  }

  /**
   * Whether there is room in every budget for `images` more attachments of `bytes` bytes.
   *
   * Kept as a read-only predicate for callers that are not reserving; anything that goes on to
   * spend must {@link reserve} instead, or two callers can both pass this check.
   */
  function canSpend(sessionId, { images = 0, bytes = 0, call = null } = {}) {
    const state = stateFor(sessionId)
    const checks = [
      ...(call === null ? [] : [
        { scope: 'call', used: call.imagesUsed, limit: call.imagesLimit, value: images, unit: 'pages' },
        { scope: 'call', used: call.bytesUsed, limit: call.bytesLimit, value: bytes, unit: 'bytes' },
      ]),
      {
        scope: 'turn',
        used: state.turn.images + state.turnHeld.images,
        limit: budget.maxImagesPerTurn,
        value: images,
        unit: 'images',
      },
      {
        scope: 'turn',
        used: state.turn.bytes + state.turnHeld.bytes,
        limit: budget.maxBytesPerTurn,
        value: bytes,
        unit: 'bytes',
      },
      {
        scope: 'session',
        used: state.total.bytes + state.totalHeld.bytes,
        limit: budget.maxBytesPerSession,
        value: bytes,
        unit: 'bytes',
      },
    ]
    for (const check of checks) {
      if (check.used + check.value > check.limit) {
        return {
          ok: false, scope: check.scope, unit: check.unit, used: check.used,
          limit: check.limit, requested: check.value,
        }
      }
    }
    return { ok: true }
  }

  /** Charge settled attachment cost directly. Prefer {@link reserve} + {@link settle}. */
  function spend(sessionId, { images = 0, bytes = 0 } = {}) {
    const state = stateFor(sessionId)
    state.turn.images += images
    state.turn.bytes += bytes
    state.total.images += images
    state.total.bytes += bytes
    return { ...state.turn }
  }

  /** Count a suppressed request (an already-inspected page the tool declined to re-attach). */
  function noteSuppressed(sessionId, count = 1) {
    const state = stateFor(sessionId)
    state.suppressed += count
    return state.suppressed
  }

  function noteJustified(sessionId, count = 1) {
    const state = stateFor(sessionId)
    state.justified += count
    return state.justified
  }

  /** The budget block for one call, with the scope actually in force. */
  function budgetFor(sessionId, scope = 'unknown') {
    const state = stateFor(sessionId)
    const turnUsed = state.turn.bytes + state.turnHeld.bytes
    const sessionUsed = state.total.bytes + state.totalHeld.bytes
    const turnImages = state.turn.images + state.turnHeld.images
    return {
      scope: scope === 'turn' ? 'turn' : 'session',
      // Stated once, on the payload, so no reader has to guess which unit these numbers are in.
      cost_unit: COST_UNIT,
      pages_per_call: { used: null, limit: budget.maxPagesPerCall },
      turn: {
        images: { used: state.turn.images, held: state.turnHeld.images, limit: budget.maxImagesPerTurn },
        bytes: { used: state.turn.bytes, held: state.turnHeld.bytes, limit: budget.maxBytesPerTurn },
      },
      session: {
        images: { used: state.total.images, held: state.totalHeld.images, limit: null },
        bytes: { used: state.total.bytes, held: state.totalHeld.bytes, limit: budget.maxBytesPerSession },
      },
      // The host bounds the request by base64 length; this is the same spend expressed that way.
      request_bytes: {
        unit: 'base64-request-bytes',
        estimate: base64RequestBytes(state.total.bytes),
        note: 'binary encoded bytes above, converted for comparison with a base64 request bound',
      },
      exhausted: sessionUsed >= budget.maxBytesPerSession
        || (scope === 'turn' && turnUsed >= budget.maxBytesPerTurn)
        || turnImages >= budget.maxImagesPerTurn,
      suppressed: state.suppressed,
      justified_rereads: state.justified,
      note: 'budgets count attached image bytes; an offloaded image still counts, because it was already spent',
    }
  }

  /**
   * Classify every page in scope against what was actually delivered to the model.
   *
   * Coverage is a *delivery* record, not a reading-comprehension claim and not a text-layer
   * classification. A page counts as covered only when the model-facing result carried its image
   * (`inspected`) or its complete source body (`text_complete`). A bounded excerpt from a plan or
   * status call is `overview_only` — explicitly not reading. Buckets, in precedence order:
   *
   * 1. `inspected` — the page image was included in a model-facing tool result (`emitted`).
   * 2. `text_complete` — the complete source body reached the model across text responses.
   * 3. `text_partial` — part of the source body reached the model.
   * 4. `noted` — only the model's own note accounts for it: its claim, not this tool's proof.
   * 5. `overview_only` — only a bounded excerpt/overview row was returned.
   * 6. `unreadable` — an attempt failed and was recorded as such.
   * 7. `unread` — nothing accounts for it yet.
   *
   * `body` totals count delivered source-body characters against the body length that was read.
   * Formats without page coordinates get `document_body` instead of invented per-page claims.
   * None of this proves comprehension, mastery, or that every character was used — only delivery.
   */
  function coverage(sessionId, { sourceHash, plan, scopePages = [] }) {
    const state = sessions.get(typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'no-session')
    const source = state?.sources.get(sourceHash)
    const pages = scopePages.length > 0
      ? scopePages
      : (plan?.per_page ?? []).map((entry) => entry.page)
    const planLength = new Map((plan?.per_page ?? []).map((entry) => [entry.page, Number(entry.text_chars) || 0]))
    const hasPages = pages.length > 0

    const inspected = []
    const textComplete = []
    const textPartial = []
    const noted = []
    const overviewOnly = []
    const unread = []
    const unreadable = []
    let bodyDelivered = 0
    let bodyTotal = 0

    const accountBody = (key, expectedLength) => {
      const record = source?.text.get(key)
      // The CURRENT body version is what this page's delivery means: intervals of other versions
      // (enhanced vs plain, or an older extraction) never count toward it and are never lost.
      const version = record === undefined ? undefined : record.versions.get(record.current)
      const length = version?.length ?? expectedLength
      const delivered = version === undefined ? 0 : coveredChars(version.intervals, length)
      bodyDelivered += delivered
      bodyTotal += length
      return { record: version, delivered, length }
    }

    if (hasPages) {
      for (const page of pages) {
        const record = source?.pages.get(page)
        const { record: textRecord, delivered, length } = accountBody(page, planLength.get(page) ?? 0)
        if (record?.status === 'unreadable') { unreadable.push(page); continue }
        if (record?.status === 'inspected' && record.emitted !== false) { inspected.push(page); continue }
        if (length > 0 && delivered >= length) { textComplete.push(page); continue }
        if (delivered > 0) { textPartial.push(page); continue }
        if (record?.status === 'noted' || (typeof record?.note === 'string' && record.note.length > 0)) { noted.push(page); continue }
        if (source?.overview.has(page) === true) { overviewOnly.push(page); continue }
        unread.push(page)
      }
    } else {
      // No page coordinates: one document body, tracked under 'document', never invented pages.
      accountBody('document', (plan?.source_blocks ?? []).reduce((sum, block) => sum + String(block.text ?? '').length, 0))
    }

    const documentBody = hasPages ? null : {
      delivered_chars: bodyDelivered,
      total_chars: bodyTotal,
      complete: bodyTotal > 0 && bodyDelivered >= bodyTotal,
    }
    const block = {
      scope: plan?.scope ?? 'whole-document',
      inspected,
      text_complete: textComplete,
      text_partial: textPartial,
      noted,
      overview_only: overviewOnly,
      unread,
      unreadable,
      inspected_count: inspected.length,
      text_complete_count: textComplete.length,
      text_partial_count: textPartial.length,
      noted_count: noted.length,
      overview_only_count: overviewOnly.length,
      unread_count: unread.length,
      unreadable_count: unreadable.length,
      total: pages.length,
      // Delivery proof only: an emitted image or a complete source body. An excerpt, a note or a
      // text-layer classification never moves this number.
      percent_delivered: pages.length === 0 ? 0 : Math.round(((inspected.length + textComplete.length) / pages.length) * 100),
      body: { delivered_chars: bodyDelivered, total_chars: bodyTotal },
      ...(documentBody === null ? {} : { document_body: documentBody }),
      notes_available: [...(source?.pages.values() ?? [])].filter((record) => typeof record.note === 'string' && record.note.length > 0).length,
      terminology: {
        inspected: 'the page image was included in a model-facing tool result — delivery proof only, not proof of comprehension or use',
        text_complete: 'the complete source body of the page was delivered in text responses',
        text_partial: 'part of the source body was delivered; continue with action "text" for the rest',
        overview_only: 'only a bounded excerpt/overview was returned — this is NOT the source body; retrieve it with action "text"',
        noted: 'only the model\'s own note accounts for this page — its claim, not this tool\'s delivery proof',
        unreadable: 'a read attempt failed and was recorded as such',
        unread: 'nothing accounts for this page yet',
      },
    }
    return block
  }

  /** Everything diagnostics needs about one session, with no material content in it. */
  function summary(sessionId) {
    const state = stateOf(sessionId)
    if (state === undefined) {
      return {
        present: false, sources: 0, inspected_pages: 0, notes: 0, images: 0, bytes: 0,
        suppressed: 0, held: 0, claims: 0,
      }
    }
    let pages = 0
    let notes = 0
    for (const source of state.sources.values()) {
      pages += source.pages.size
      for (const record of source.pages.values()) if (typeof record.note === 'string' && record.note.length > 0) notes += 1
    }
    return {
      present: true,
      sources: state.sources.size,
      inspected_pages: pages,
      notes,
      images: state.total.images,
      bytes: state.total.bytes,
      held: state.totalHeld.bytes,
      claims: state.claims.size,
      suppressed: state.suppressed,
      justified_rereads: state.justified,
      turn: state.turnIndex,
      scope: state.turnIndex === null ? 'session' : 'turn',
      cost_unit: COST_UNIT,
    }
  }

  /** Cache the derived plan for one source so a later call does not re-extract the text layer. */
  function storePlan(sessionId, sourceHash, plan) {
    const state = stateFor(sessionId)
    const source = sourceState(state, sourceHash)
    source.plan = plan
    source.planAt = now()
    const maxChars = options.maxSourceChars ?? 16 * 1024 * 1024
    const retained = [...sessions.values()].flatMap(session => [...session.sources.values()])
      .filter(item => item.plan !== null)
      .sort((a, b) => a.planAt - b.planAt)
    const size = item => (item.plan?.source_blocks ?? []).reduce((sum, block) => sum + String(block.text ?? '').length, 0)
    let chars = retained.reduce((sum, item) => sum + size(item), 0)
    for (const item of retained) {
      if (chars <= maxChars) break
      chars -= size(item)
      item.plan = null
    }
    return plan
  }

  function planFor(sessionId, sourceHash) {
    const state = sessions.get(typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'no-session')
    const source = state?.sources.get(sourceHash)
    return source === undefined ? null : { plan: source.plan, at: source.planAt }
  }

  /** Drop one session's state. */
  function disposeSession(sessionId) {
    sessions.delete(typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'no-session')
  }

  return {
    budget,
    activeClaims,
    beginTurn,
    budgetFor,
    canSpend,
    capacity,
    claimPage,
    commitDelivery,
    coverage,
    disposeSession,
    find,
    noteJustified,
    noteSuppressed,
    planFor,
    recordInspection,
    recordTextDelivery,
    release,
    releaseClaim,
    reserve,
    setNote,
    settle,
    spend,
    storePlan,
    summary,
    withLock,
    /** Drop every session and every queued call (plugin disposal). */
    dispose() {
      sessions.clear()
      locks.clear()
    },
    /** Session ids currently retained — for tests and disposal assertions only. */
    sessionIds() { return [...sessions.keys()] },
  }
}
