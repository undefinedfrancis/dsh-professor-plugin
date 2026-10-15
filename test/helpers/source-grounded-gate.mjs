/**
 * The authorization and readiness gate for N2 — source-grounded note delivery.
 *
 * Everything in this block is split into a **zero-cost** half (fixtures, registration, indexing,
 * local evidence checks) and a **model-driven** half that spends paid requests. Nothing but a
 * fresh, explicit human authorization naming *this* block with a numeric budget may open the
 * second half — and the rule is enforced in code rather than in a report, because a rule that
 * lives only in prose is one omitted `if` away from being silently ignored.
 *
 * Three properties this module exists to guarantee:
 *
 * - **Freshness and scope.** An authorization must name `source-grounded-note-delivery` and be
 *   granted no earlier than this block's preparation. The teaching-matrix counter, the
 *   note-delivery block's counter, a non-empty `counter.json`, and silence are all explicitly
 *   rejected: authority for one block never transfers to another.
 * - **A numeric budget.** `'many'` is not a budget. The limit is a positive integer, stated up
 *   front, and every *attempt* is charged to it — a request that fails still costs a request.
 * - **Ordering.** The model-driven cases may not start until the deterministic evidence checks
 *   are green, so no request is ever spent on a fixture that did not register, index or extract.
 *
 * Deliberately has no dependency on the network or on any model client: importing it can never
 * spend a request, which is what lets the test suite exercise the whole gate for free.
 *
 * @module test/helpers/source-grounded-gate
 */

/** The one block this module authorizes. Anything else is out of scope by construction. */
export const BLOCK_ID = 'source-grounded-note-delivery'

/** Blocks whose approvals are explicitly *not* authority for this one. */
const OTHER_BLOCKS = new Set(['teaching-matrix', 'teaching-interaction', 'note-delivery', 'latex-cjk-fix'])

/** Raised whenever the gate refuses. Refusals are expected outcomes, not crashes. */
export class AuthorizationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthorizationError'
    this.code = 'PROFESSOR_BLOCK_NOT_AUTHORIZED'
  }
}

const looksIso = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)

/**
 * Refuse to authorize unless the human statement is fresh, scoped to this block and numeric.
 *
 * @param authorization - `{ block, statement, budget, granted_at }` as given by the human.
 * @param options.blockId - the block being authorized; defaults to this one.
 * @param options.preparedAt - ISO timestamp of this block's preparation; an authorization issued
 *   before it is stale, not fresh.
 * @returns the authorization, unchanged, so callers can log exactly what was accepted.
 * @throws {AuthorizationError} when any condition fails.
 */
export function assertAuthorized(authorization, options = {}) {
  const blockId = options.blockId ?? BLOCK_ID
  const preparedAt = options.preparedAt ?? null

  if (authorization === null || authorization === undefined || typeof authorization !== 'object') {
    throw new AuthorizationError('no authorization: silence is never authority for a paid request')
  }
  if (authorization.block !== blockId) {
    const named = authorization.block === undefined || authorization.block === null
      ? 'no block named'
      : `names ${JSON.stringify(authorization.block)}`
    throw new AuthorizationError(
      `authorization ${named}; this block is ${JSON.stringify(blockId)}. `
      + 'An approval for another block, a prior phase, or an earlier counter is not authority here.',
    )
  }
  if (OTHER_BLOCKS.has(authorization.block)) {
    throw new AuthorizationError(`authorization for ${authorization.block} does not cover ${blockId}`)
  }
  if (typeof authorization.statement !== 'string' || authorization.statement.trim().length < 10) {
    throw new AuthorizationError('authorization carries no human statement')
  }
  if (!Number.isInteger(authorization.budget) || authorization.budget < 1) {
    throw new AuthorizationError(
      `request budget must be a positive integer, got ${JSON.stringify(authorization.budget)}`,
    )
  }
  if (!looksIso(authorization.granted_at)) {
    throw new AuthorizationError('authorization has no ISO-8601 granted_at timestamp')
  }
  const granted = Date.parse(authorization.granted_at)
  if (Number.isNaN(granted)) {
    throw new AuthorizationError(`authorization granted_at is not a parseable timestamp: ${authorization.granted_at}`)
  }
  if (preparedAt !== null) {
    const prepared = Date.parse(preparedAt)
    if (!Number.isNaN(prepared) && granted < prepared) {
      throw new AuthorizationError(
        `authorization granted_at ${authorization.granted_at} predates this block's preparation `
        + `${preparedAt}; it is stale, not fresh`,
      )
    }
  }
  return authorization
}

/**
 * Refuse to start the model-driven cases until the deterministic half is green.
 *
 * @param evidence - the `evidence.json` written by `docs/qa/2026-10-12-source-grounded-notes/run-prepare.mjs`.
 * @param options.blockId - the block the evidence must belong to.
 * @throws {AuthorizationError} when evidence is missing, foreign, failed, or empty.
 */
export function assertPrepared(evidence, options = {}) {
  const blockId = options.blockId ?? BLOCK_ID
  if (evidence === null || evidence === undefined || typeof evidence !== 'object') {
    throw new AuthorizationError('no preparation evidence: run the zero-cost half first')
  }
  if (evidence.block !== blockId) {
    throw new AuthorizationError(
      `evidence belongs to ${JSON.stringify(evidence.block)}, not ${JSON.stringify(blockId)}`,
    )
  }
  const checks = evidence.checks
  if (checks === null || checks === undefined || typeof checks !== 'object') {
    throw new AuthorizationError('evidence records no deterministic checks')
  }
  const passed = Array.isArray(checks.passed) ? checks.passed : []
  const failed = Array.isArray(checks.failed) ? checks.failed : []
  if (passed.length === 0) {
    throw new AuthorizationError('evidence records no passing deterministic check')
  }
  if (failed.length > 0) {
    throw new AuthorizationError(`deterministic checks failed: ${failed.join(', ')}`)
  }
  if (checks.all_passed !== true) {
    throw new AuthorizationError('deterministic checks are not all passed')
  }
  return evidence
}

/**
 * A request budget that charges **attempts**, not successes.
 *
 * A request that times out, errors or returns garbage still consumed the authorized allowance, so
 * `charge()` increments before the caller knows the outcome. The log is the run's own ledger: it
 * is what the report quotes when it says how many requests this block actually used.
 */
export class RequestBudget {
  /**
   * @param limit - the authorized number of requests; must be a positive integer.
   */
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new AuthorizationError(`budget limit must be a positive integer, got ${JSON.stringify(limit)}`)
    }
    this.limit = limit
    this.log = []
  }

  /** Requests attempted so far. */
  get attempts() {
    return this.log.length
  }

  /** Requests still available. */
  get remaining() {
    return Math.max(0, this.limit - this.attempts)
  }

  /**
   * Take one request out of the budget.
   *
   * @param label - what the request is for, e.g. `'source-grounded-markdown-note'`.
   * @param meta - optional detail recorded alongside the label (`{ failed: true, reason }`).
   * @throws {AuthorizationError} when the budget is already spent.
   */
  charge(label, meta = {}) {
    if (this.attempts >= this.limit) {
      throw new AuthorizationError(
        `request budget exhausted: ${this.attempts}/${this.limit} attempted. `
        + 'Stopping immediately; no further request is made.',
      )
    }
    this.log.push({
      index: this.attempts + 1,
      label: String(label),
      charged_at: new Date().toISOString(),
      ...meta,
    })
    return this.attempts
  }
}
