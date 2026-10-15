/**
 * Grading contract for the live-model teaching acceptance runner (corrected 2026-10-12).
 *
 * Pure functions shared by `tools/verify-teaching-model.mjs` and the offline regression suite
 * `test/teaching-model-grading.test.mjs`. They encode the corrections required by
 * `docs/qa/2026-10-12-teaching-interaction/live-model/INDEPENDENT-REVIEW.md`:
 *
 * - a state write succeeds only on `written: true` with no `problems` — `isError: false` is not
 *   domain success;
 * - a `kind: "unit"` update must carry the `unit` field (`title` is not a substitute);
 * - a turn stopped on a tool call or budget exhaustion is INCOMPLETE, never PASSED;
 * - affirmative independent-completion claims (「经提示后独立完成」) are contradictions, while
 *   negated / pending-verification wording is not;
 * - unsupported exam claims (scoring efficiency, mark-loss rates) are flagged;
 * - filtered reruns never erase earlier failures or fake an all-pass aggregate;
 * - `NOT-INCLUDED` / `UNEXECUTED` placeholders are history, never observations;
 * - all-pass requires the declared matrix inventory, so a passing subset cannot pass alone;
 * - automated screening and human adjudication stay separately traceable and both are retained;
 * - a run exits nonzero whenever any case is not PASSED.
 *
 * @module tools/teaching-model-grading
 */

/** Statuses that count as success; anything else fails the run. */
export const PASSING_STATUSES = Object.freeze(['PASSED'])

/** Detect an affirmative independent-completion claim, allowing negated/pending wording. */
export function hasAffirmativeIndependentClaim(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  // Remove negated and pending-verification spans first so they cannot trigger the detector.
  const stripped = text
    .replace(/独立(能力)?(尚)?未(验证|证明|检验)/g, '⟦pending⟧')
    .replace(/不是独立(完成|解决|做对)的?/g, '⟦negated⟧')
    .replace(/未能独立(完成|解决|做对)/g, '⟦negated⟧')
    .replace(/不作为独立(完成|解决|做对)/g, '⟦negated⟧')
    .replace(/not (yet )?(independently )?(verified|proved|solved|completed)/gi, '⟦pending⟧')
    .replace(/independent (ability|performance) not (yet )?verified/gi, '⟦pending⟧')
    .replace(/未(经)?独立/g, '⟦negated⟧')
  return /独立(完成|解决|做对)|independently (completed|solved|done)/i.test(stripped)
}

/**
 * Unsupported exam claims: measured scoring efficiency / mark-loss rates / frequency assertions
 * that supplied evidence cannot support. Returns the matched claim strings.
 */
export function unsupportedExamClaims(text) {
  if (typeof text !== 'string') return []
  // Negated refusals (「更不能说"必考"」) are not claims; strip them first.
  const stripped = text
    .replace(/(不|未)(能|得|会|可以)?(说|算|称|断言|声称)[^。」"']{0,8}(必考|必现|每年必考)/g, '⟦refusal⟧')
    .replace(/不能说[「"']?(必考|每年必考)[」"']?/g, '⟦refusal⟧')
  const patterns = [
    /性价比高/, /单位时间得分稳定/, /得分稳定/, /最容易因[^。]{0,12}丢分/, /容易丢分/, /丢分率/,
    /必考型/, /必考(?!")/, /每年必考/, /历来必考/, /出题规律是/, /一定考/, /肯定会考/,
  ]
  const hits = []
  for (const pattern of patterns) {
    const match = pattern.exec(stripped)
    if (match !== null) hits.push(match[0])
  }
  return hits
}

/**
 * Grade one executed tool call from its full structured result.
 *
 * @param call - `{ name, isError, args, result }` where `result` is the parsed tool result
 *   object (the full structured payload, including `written` and `problems`).
 * @returns `{ ok, problems }`.
 */
export function gradeToolCall(call) {
  const problems = []
  const args = call?.args ?? {}
  const result = call?.result ?? {}
  if (call?.isError === true) problems.push(`tool ${call.name} returned isError:true`)

  if (call?.name === 'professor_state_update') {
    if (args.kind === 'unit' && (typeof args.unit !== 'string' || args.unit.trim().length === 0)) {
      problems.push('unit update requires the unit field; title is not a substitute')
    }
    if (result.written !== true) {
      problems.push(`state write did not persist (written:${JSON.stringify(result.written)} — written:true is required)`)
    }
    if (Array.isArray(result.problems) && result.problems.length > 0) {
      problems.push(`state write reported problems: ${result.problems.join(' | ')}`)
    }
  }
  return { ok: problems.length === 0, problems }
}

/**
 * Derive the case status from complete evidence.
 *
 * A case PASSES only when the turn produced a final answer (not stopped on a tool call or
 * budget), every check passed, and every tool call graded ok. Domain failures keep FAILED even
 * when later checks succeed; an unfinished turn is INCOMPLETE regardless of checks.
 */
export function deriveCaseStatus({ outputText, turnEndedOnToolCall, budgetExhausted, checks = [], toolCalls = [] }) {
  const completed = typeof outputText === 'string' && outputText.trim().length > 0 && turnEndedOnToolCall !== true
  const domainFailures = toolCalls.map(gradeToolCall).filter(graded => !graded.ok)
  if (!completed) return budgetExhausted === true ? 'INCOMPLETE' : 'INCOMPLETE'
  if (domainFailures.length > 0) return 'FAILED'
  if (checks.some(check => check.pass !== true)) return 'FAILED'
  return 'PASSED'
}

/**
 * An invocation placeholder: this run did not execute the case, so the entry carries no
 * observation. It is retained for history but can never become a result or a failure.
 */
export function isPlaceholderStatus(status) {
  if (typeof status !== 'string') return true
  const trimmed = status.trim()
  if (trimmed.length === 0) return true
  if (trimmed === 'UNEXECUTED') return true
  return trimmed.startsWith('NOT-INCLUDED')
}

/**
 * Aggregate per-run case records traceably: every observation is kept, prior failures stay
 * visible next to any later pass, and an all-pass aggregate is impossible while an untouched
 * failure/incomplete remains.
 *
 * Bookkeeping rules (2026-10-12 repair):
 *
 * - a **placeholder** status (`NOT-INCLUDED …`, `UNEXECUTED`, absent) records that *this*
 *   invocation skipped the case. It stays in `history` but is **never an observation**: it cannot
 *   become `final_status`, cannot enter `prior_failures`, and cannot be read as a failure or a
 *   pass. `final_status` is always the **latest actually executed** status;
 * - `all_passed` additionally requires the **expected matrix inventory**. A supplied subset that
 *   happens to pass cannot report all-pass while required cases are missing, unexecuted, OPEN or
 *   INCOMPLETE. With no expected inventory supplied, all-pass is never asserted;
 * - **automated screening and manual adjudication stay separately traceable.** `automated.status`
 *   is the runner's own verdict and is never rewritten; a human adjudication lands beside it in
 *   `adjudication` / `effective_status`, never on top of it;
 * - **an adjudication must bind to an executed observation.** A known `runId` is not enough: the
 *   cited run must contain a non-placeholder record for that exact case, and the entry must carry
 *   a written `basis`. Anything else is rejected with its reasons and never applied;
 * - **only the latest executed observation may be adjudicated.** Adjudications of older
 *   observations are preserved in `historical_adjudications` as evidence and can never decide the
 *   current status — a stale `PASSED` cannot override a newer `FAILED`, and the result does not
 *   depend on the order adjudications are supplied in;
 * - the reported closure `decision` is a separate field whose `is_acceptance_of_full_pass` is
 *   defined as `all_passed`, so a scope-closure decision can never be read as an all-pass claim.
 *
 * @param runs - `[{ runId, cases: [{ id, status, ... }] }]` in execution order.
 * @param options - `{ expectedCases, adjudications, decision }`.
 */
export function aggregateRuns(runs, options = {}) {
  const expectedCases = Array.isArray(options.expectedCases) ? [...options.expectedCases] : null
  const cases = {}
  for (const run of runs ?? []) {
    for (const entry of run.cases ?? []) {
      const slot = cases[entry.id] ?? (cases[entry.id] = {
        final_status: 'UNEXECUTED', effective_status: 'UNEXECUTED', automated: null,
        adjudication: null, historical_adjudications: [],
        history: [], executed_history: [], prior_failures: [],
      })
      const executed = !isPlaceholderStatus(entry.status)
      slot.history.push({ runId: run.runId, status: entry.status, executed })
      if (!executed) continue
      slot.executed_history.push({ runId: run.runId, status: entry.status })
      // Carry an earlier executed failure forward next to the newer observation. Placeholders
      // never reach this branch, so a filtered rerun can neither invent nor erase a failure.
      if (slot.automated !== null && !PASSING_STATUSES.includes(slot.automated.status)) {
        slot.prior_failures.push({ runId: slot.automated.runId, status: slot.automated.status })
      }
      slot.automated = { status: entry.status, runId: run.runId }
    }
  }
  for (const slot of Object.values(cases)) {
    slot.final_status = slot.automated?.status ?? 'UNEXECUTED'
    slot.effective_status = slot.final_status
  }

  const runsById = new Map()
  for (const run of runs ?? []) runsById.set(run.runId, run)

  // Manual adjudication: recorded separately, and bound to an *executed observation of that exact
  // case in that exact run*. A known runId alone is not enough — the run must actually contain a
  // non-placeholder record for the case. A valid adjudication of an OLDER observation is kept as
  // history and can never become the current verdict, so a stale entry cannot override a newer
  // result (including a newer failure), and the outcome does not depend on input array order.
  const rejected_adjudications = []
  const applied = []
  for (const entry of options.adjudications ?? []) {
    const reasons = []
    if (!cases[entry.caseId]) reasons.push('unknown caseId')
    const run = runsById.get(entry.runId)
    if (run === undefined) reasons.push('unknown runId')
    else {
      const record = (run.cases ?? []).find(item => item.id === entry.caseId)
      if (record === undefined) reasons.push('case absent from cited run')
      else if (isPlaceholderStatus(record.status)) reasons.push('cited observation was not executed')
    }
    if (typeof entry.basis !== 'string' || entry.basis.trim().length === 0) reasons.push('missing basis')
    if (isPlaceholderStatus(entry.status)) reasons.push('placeholder status')
    if (reasons.length > 0) {
      rejected_adjudications.push({ caseId: entry.caseId, runId: entry.runId, status: entry.status, reasons })
      continue
    }
    applied.push({
      caseId: entry.caseId, status: entry.status, runId: entry.runId, basis: entry.basis,
      source: entry.source ?? null, decidedBy: entry.decidedBy ?? 'manual',
    })
  }

  for (const [caseId, slot] of Object.entries(cases)) {
    const bound = applied.filter(entry => entry.caseId === caseId)
    const latestRunId = slot.automated?.runId ?? null
    // Only an adjudication of the latest executed observation may determine the current status.
    slot.historical_adjudications = latestRunId === null
      ? bound
      : bound.filter(entry => entry.runId !== latestRunId)
    slot.adjudication = latestRunId === null
      ? null
      : (bound.filter(entry => entry.runId === latestRunId).at(-1) ?? null)
    slot.effective_status = slot.adjudication?.status ?? slot.final_status
  }

  const scope = expectedCases ?? Object.keys(cases)
  const missing = expectedCases === null ? [] : expectedCases.filter(id => !cases[id])
  const extra = expectedCases === null ? [] : Object.keys(cases).filter(id => !expectedCases.includes(id))
  const inventory = {
    expected: expectedCases,
    complete: expectedCases !== null && missing.length === 0,
    missing, extra, observed: Object.keys(cases).length,
  }

  const blocked = { unexecuted: [], open: [], not_passed: [] }
  const counts = { passed: 0, open: 0, failed: 0, incomplete: 0, unexecuted: 0, total: scope.length }
  for (const id of scope) {
    const slot = cases[id]
    if (!slot) continue
    const status = slot.effective_status
    if (status === 'UNEXECUTED') { blocked.unexecuted.push(id); counts.unexecuted += 1; continue }
    if (status === 'OPEN') { blocked.open.push(id); counts.open += 1; continue }
    if (status === 'PASSED') { counts.passed += 1; continue }
    if (status === 'INCOMPLETE' || status === 'BLOCKED') counts.incomplete += 1
    else counts.failed += 1
    blocked.not_passed.push(id)
  }

  const automated_all_passed = inventory.complete
    && scope.every(id => cases[id] !== undefined && PASSING_STATUSES.includes(cases[id].final_status))
  const all_passed = inventory.complete
    && scope.every(id => cases[id] !== undefined && PASSING_STATUSES.includes(cases[id].effective_status))
  const decision = options.decision
    ? {
        label: options.decision.label ?? null,
        decidedBy: options.decision.decidedBy ?? null,
        date: options.decision.date ?? null,
        source: options.decision.source ?? null,
        note: options.decision.note ?? null,
        // A closure decision can never be read as an all-pass claim unless the aggregate is one.
        is_acceptance_of_full_pass: all_passed,
      }
    : null

  return {
    cases, inventory, blocked, counts, decision, rejected_adjudications,
    automated: { all_passed: automated_all_passed },
    all_passed,
  }
}

/** Exit status for a run: 0 only when every listed case is PASSED. */
export function runExitCode(cases) {
  return (cases ?? []).every(entry => PASSING_STATUSES.includes(entry.status)) && (cases ?? []).length > 0 ? 0 : 1
}
