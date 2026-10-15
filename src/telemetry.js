/**
 * Privacy-conscious diagnostics for the teaching runtime.
 *
 * One rule governs every event this module emits: **counts and codes, never content**. A lecture's
 * text, an image, a saved preference value or a full prompt must never appear in a log line, so the
 * allow-list below is exhaustive and an unknown field is dropped rather than forwarded.
 *
 * Each event carries a `kind`, and the kinds are chosen so the four failure modes a teaching turn
 * can exhibit stay distinguishable in the log instead of collapsing into "it was slow":
 *
 * | kind | meaning |
 * |---|---|
 * | `skill.loaded` | a skill was served, with its composition scope |
 * | `material.plan` / `material.render` / `material.suppressed` / `material.budget` | reading pipeline |
 * | `state.read` | a state read, whether it reused the session cache |
 * | `index.sync` | index freshness decision (walked vs short-circuited) |
 * | `tool.failed` | a tool threw, with its code — a tool failure, not a slow model |
 *
 * What this module deliberately does **not** claim: model-stream waiting and permission waiting are
 * host-owned and invisible to a plugin (the host exposes no hook for either), so no event pretends
 * to measure them. An absent event means "not observed here", never "instant".
 *
 * @module dsh-professor-spike/src/telemetry
 */

/** Fields that may appear in an event. Anything else is dropped. */
const ALLOWED_FIELDS = Object.freeze(new Set([
  'skill', 'scope', 'action', 'status', 'reason', 'code', 'pages', 'total', 'images', 'bytes',
  'inspected', 'noted', 'text_only', 'unread', 'unreadable', 'suppressed', 'justified', 'reused',
  'read', 'walked', 'age_seconds', 'window_seconds', 'fresh', 'count', 'duration_ms', 'budget_scope',
  'unavailable', 'truncated', 'variant', 'turn', 'first_study', 'cache', 'render', 'extract',
  'chars', 'scope_kind', 'course',
]))

/** Longest string a field may carry before it is truncated (codes are short; prose is dropped). */
const MAX_STRING = 120

/** How many events one kind may emit per session before it is sampled down. */
const KIND_BUDGET = 200

function sanitize(fields) {
  const out = {}
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!ALLOWED_FIELDS.has(key)) continue
    if (typeof value === 'string') out[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value
    else if (Array.isArray(value)) out[key] = value.slice(0, 12).map((item) => typeof item === 'string' ? item.slice(0, MAX_STRING) : item)
    // Objects are dropped: a nested structure is where content accidentally leaks.
  }
  return out
}

/**
 * Build the telemetry surface.
 *
 * @param options.logger - the plugin logger (`info`/`warn`/`debug`).
 * @param options.enabled - turn emission off entirely (still returns a callable surface).
 * @returns `(kind, fields) => void` plus `{ enabled, counts, reset }`.
 */
export function createTelemetry({ logger, enabled = true } = {}) {
  const counts = new Map()

  function emit(kind, fields = {}) {
    if (enabled !== true) return
    const seen = (counts.get(kind) ?? 0) + 1
    counts.set(kind, seen)
    // Sampling keeps a pathological loop from flooding the log while still proving it happened.
    if (seen > KIND_BUDGET) {
      if (seen === KIND_BUDGET + 1) logger?.warn?.(`professor.telemetry ${kind} sampling after ${KIND_BUDGET} events`)
      return
    }
    try {
      logger?.info?.(`professor.telemetry ${kind} ${JSON.stringify(sanitize(fields))}`)
    } catch {
      // Diagnostics must never break the thing they are diagnosing.
    }
  }

  emit.enabled = enabled
  emit.counts = counts
  emit.reset = () => counts.clear()
  return emit
}
