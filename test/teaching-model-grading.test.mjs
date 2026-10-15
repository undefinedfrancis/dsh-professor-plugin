/**
 * Offline regression cases for the live-model runner's grading contract
 * (2026-10-12 correction phase). No paid model call is made; all records are synthetic.
 *
 * These pin the defects documented in `docs/qa/2026-10-12-teaching-interaction/live-model/
 * INDEPENDENT-REVIEW.md`: a domain failure with `isError:false`, a unit update missing `unit`,
 * a turn stopped on a tool call / budget exhaustion, assisted-vs-independent contradictions,
 * filtered reruns that must not erase earlier failures, and a failing exit status whenever a
 * required case is not PASSED.
 *
 * The aggregation half also pins the 2026-10-12 bookkeeping repair: `NOT-INCLUDED`/`UNEXECUTED`
 * placeholders are never observations, completeness is judged against the declared matrix
 * inventory, automated screening and human adjudication are reported side by side without either
 * being erased, and a recorded closure decision is never reported as an all-pass claim.
 *
 * @module test/teaching-model-grading
 */

import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  deriveCaseStatus, gradeToolCall, hasAffirmativeIndependentClaim, unsupportedExamClaims,
  aggregateRuns, runExitCode, isPlaceholderStatus,
} from '../tools/teaching-model-grading.mjs'
import { EXPECTED_CASE_IDS } from '../tools/teaching-model-matrix.mjs'

// --- domain failure with isError:false ----------------------------------------

test('a state write with written:false and problems fails even when isError is false', () => {
  const call = {
    name: 'professor_state_update',
    isError: false,
    args: { file: 'PROGRESS.md', evidence: 'weak', kind: 'unit', title: 'Only a title' },
    result: {
      course_id: 'syn101', file: 'PROGRESS.md', evidence: 'weak', writable: true,
      written: false, dryRun: false, revision: null,
      warnings: [], problems: ['unsupported update shape for PROGRESS.md: pass a field or kind "unit"'],
    },
  }
  const graded = gradeToolCall(call)
  assert.equal(graded.ok, false)
  assert.match(graded.problems.join(' '), /written:false|written is not true/)
  assert.match(graded.problems.join(' '), /unsupported update shape/)
})

test('a state write only succeeds on written:true with no problems', () => {
  const good = gradeToolCall({
    name: 'professor_state_update', isError: false,
    args: { file: 'PROGRESS.md', evidence: 'weak', kind: 'unit', unit: 'Unit 1' },
    result: { written: true, problems: [], warnings: [] },
  })
  assert.equal(good.ok, true)
})

// --- missing unit -------------------------------------------------------------

test('a unit update without the unit field is rejected before any result is trusted', () => {
  const graded = gradeToolCall({
    name: 'professor_state_update', isError: false,
    args: { file: 'PROGRESS.md', evidence: 'weak', kind: 'unit', title: 'Not a unit name' },
    result: { written: true, problems: [] }, // even a lying result cannot rescue the args
  })
  assert.equal(graded.ok, false)
  assert.match(graded.problems.join(' '), /unit/)
})

// --- unfinished tool loop / incomplete turns ----------------------------------

test('a turn that ends on a tool call is INCOMPLETE, never PASSED', () => {
  const status = deriveCaseStatus({
    outputText: null,
    turnEndedOnToolCall: true,
    budgetExhausted: true,
    checks: [{ name: 'everything', pass: true }],
    toolCalls: [],
  })
  assert.equal(status, 'INCOMPLETE')
})

test('budget exhaustion with no answer is INCOMPLETE, never PASSED', () => {
  const status = deriveCaseStatus({
    outputText: '', turnEndedOnToolCall: false, budgetExhausted: true,
    checks: [], toolCalls: [],
  })
  assert.equal(status, 'INCOMPLETE')
})

test('a completed turn with failing checks is FAILED', () => {
  const status = deriveCaseStatus({
    outputText: '答案', turnEndedOnToolCall: false, budgetExhausted: false,
    checks: [{ name: 'ok', pass: true }, { name: 'bad', pass: false }], toolCalls: [],
  })
  assert.equal(status, 'FAILED')
})

test('a domain-failed tool call keeps the case FAILED even if every check passes', () => {
  const status = deriveCaseStatus({
    outputText: '答案', turnEndedOnToolCall: false, budgetExhausted: false,
    checks: [{ name: 'ok', pass: true }],
    toolCalls: [{
      name: 'professor_state_update', isError: false,
      args: { kind: 'unit', unit: 'U' }, result: { written: false, problems: ['nope'] },
    }],
  })
  assert.equal(status, 'FAILED')
})

// --- assisted / independent contradictions ------------------------------------

test('an affirmative independent-completion claim after hints is a contradiction', () => {
  assert.equal(hasAffirmativeIndependentClaim('经两级提示后独立完成代码'), true)
  assert.equal(hasAffirmativeIndependentClaim('学生独立完成了本题'), true)
})

test('negated or pending-verification wording is not an independent claim', () => {
  assert.equal(hasAffirmativeIndependentClaim('提示辅助完成；独立能力尚未验证'), false)
  assert.equal(hasAffirmativeIndependentClaim('不是独立完成的，仍有缺口'), false)
  assert.equal(hasAffirmativeIndependentClaim('independent performance not yet verified'), false)
})

test('a record-level independent contradiction fails the case via checks', () => {
  const status = deriveCaseStatus({
    outputText: '已记录', turnEndedOnToolCall: false, budgetExhausted: false,
    checks: [{ name: 'independent-claim', pass: !hasAffirmativeIndependentClaim('经两级提示后独立完成代码') }],
    toolCalls: [],
  })
  assert.equal(status, 'FAILED')
})

// --- unsupported exam claims ---------------------------------------------------

test('unsupported scoring-efficiency and mark-loss claims are flagged', () => {
  const flagged = unsupportedExamClaims('性价比高——单位时间得分稳定。闭卷笔试中最容易因边界条件丢分。')
  assert.ok(flagged.length >= 2, `expected ≥2 flagged claims, got ${JSON.stringify(flagged)}`)
  assert.equal(unsupportedExamClaims('递归是基础；建议多练。').length, 0)
  // A refusal that merely quotes the word is not a claim.
  assert.equal(unsupportedExamClaims('样本不足以断定频率，更不能说"必考"。').length, 0)
  assert.equal(unsupportedExamClaims('在范围内必考型基础。').length >= 1, true, '必考型 variants are claims')
})

// --- filtering / aggregation ---------------------------------------------------

const NOT_INCLUDED = 'NOT-INCLUDED (this invocation; see report-run1.json)'
const MATRIX = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']

test('a filtered rerun cannot erase earlier failures or fake an all-pass aggregate', () => {
  const aggregate = aggregateRuns([
    { runId: 'run-1', cases: [
      { id: 'S3', status: 'FAILED' }, { id: 'S7', status: 'FAILED' }, { id: 'S4', status: 'PASSED' },
    ] },
    { runId: 'run-2', cases: [{ id: 'S3', status: 'PASSED' }] }, // filtered rerun of S3 only
  ], { expectedCases: MATRIX })
  assert.equal(aggregate.cases.S3.history.length, 2, 'both observations are retained')
  assert.equal(aggregate.cases.S3.final_status, 'PASSED')
  assert.equal(aggregate.cases.S3.prior_failures.length, 1, 'the earlier failure is kept visible')
  assert.equal(aggregate.cases.S7.final_status, 'FAILED', 'untouched failure survives filtering')
  assert.equal(aggregate.all_passed, false, 'the seven cases that never ran cannot all-pass')
})

// --- placeholders are not observations ----------------------------------------

test('a NOT-INCLUDED placeholder never replaces a case latest executed result', () => {
  const aggregate = aggregateRuns([
    { runId: 'report-run1.json', cases: [{ id: 'S7', status: 'FAILED' }] },
    { runId: 'report-run3.json', cases: [{ id: 'S7', status: 'PASSED' }] },
    { runId: 'report.json', cases: [{ id: 'S7', status: NOT_INCLUDED }] },
  ], { expectedCases: ['S7'] })
  const slot = aggregate.cases.S7
  assert.equal(slot.final_status, 'PASSED', 'the placeholder is not an observation')
  assert.equal(slot.automated.status, 'PASSED')
  assert.equal(slot.automated.runId, 'report-run3.json')
  assert.equal(slot.history.length, 3, 'complete history, placeholders included')
  assert.equal(slot.history.filter(entry => entry.executed === false).length, 1)
  assert.equal(slot.executed_history.length, 2)
  assert.equal(aggregate.all_passed, true)
})

test('placeholders never land in prior_failures', () => {
  const aggregate = aggregateRuns([
    { runId: 'report-run1.json', cases: [{ id: 'S4', status: 'PASSED' }] },
    { runId: 'report-run2.json', cases: [{ id: 'S4', status: NOT_INCLUDED }] },
    { runId: 'report.json', cases: [{ id: 'S4', status: 'UNEXECUTED' }] },
  ], { expectedCases: ['S4'] })
  assert.deepEqual(aggregate.cases.S4.prior_failures, [], 'a skipped case is not a failure')
  assert.equal(aggregate.cases.S4.final_status, 'PASSED')
  assert.equal(aggregate.automated.all_passed, true)
})

test('a required case with no executed observation cannot contribute to all-pass', () => {
  const aggregate = aggregateRuns([
    { runId: 'report.json', cases: [{ id: 'S1', status: 'PASSED' }, { id: 'S9', status: NOT_INCLUDED }] },
  ], { expectedCases: ['S1', 'S9'] })
  assert.equal(aggregate.cases.S9.final_status, 'UNEXECUTED')
  assert.deepEqual(aggregate.blocked.unexecuted, ['S9'])
  assert.equal(aggregate.all_passed, false)
})

// --- expected matrix inventory -------------------------------------------------

test('a passing subset cannot claim all-pass without the full expected inventory', () => {
  const aggregate = aggregateRuns([
    { runId: 'report.json', cases: [
      { id: 'S1', status: 'PASSED' }, { id: 'S4', status: 'PASSED' }, { id: 'S6', status: 'PASSED' },
    ] },
  ], { expectedCases: MATRIX })
  assert.equal(aggregate.inventory.complete, false)
  assert.deepEqual(
    aggregate.inventory.missing,
    ['S2', 'S3', 'S5', 'S7', 'S8'],
    'missing required cases are named',
  )
  assert.equal(aggregate.all_passed, false)
})

test('all-pass cannot be asserted when no expected inventory is supplied', () => {
  const aggregate = aggregateRuns([
    { runId: 'report.json', cases: [{ id: 'S1', status: 'PASSED' }] },
  ])
  assert.equal(aggregate.inventory.complete, false)
  assert.equal(aggregate.all_passed, false)
})

test('an OPEN or INCOMPLETE required case blocks all-pass', () => {
  const open = aggregateRuns(
    [{ runId: 'report.json', cases: MATRIX.map(id => ({ id, status: 'PASSED' })) }],
    { expectedCases: MATRIX, adjudications: [{ caseId: 'S3', status: 'OPEN', runId: 'report.json', basis: 'narrow gap', source: 'RETEST-RESULTS.md' }] },
  )
  assert.equal(open.all_passed, false)
  assert.deepEqual(open.blocked.open, ['S3'])

  const incomplete = aggregateRuns(
    [{ runId: 'report.json', cases: MATRIX.map(id => ({ id, status: id === 'S5' ? 'INCOMPLETE' : 'PASSED' })) }],
    { expectedCases: MATRIX },
  )
  assert.equal(incomplete.all_passed, false)
  assert.deepEqual(incomplete.blocked.not_passed, ['S5'])
})

// --- manual adjudication stays separate from automated screening ----------------

test('a justified manual adjudication never erases the automated failure', () => {
  const aggregate = aggregateRuns([
    { runId: 'report-run1.json', cases: [{ id: 'S2', status: 'FAILED' }] },
    { runId: 'report.json', cases: [{ id: 'S2', status: 'FAILED' }] },
  ], {
    expectedCases: ['S2'],
    adjudications: [{
      caseId: 'S2', status: 'PASSED', runId: 'report.json', source: 'RETEST-RESULTS.md',
      basis: 'screener false positives on negated wording and chapter enumeration, documented',
    }],
  })
  const slot = aggregate.cases.S2
  assert.equal(slot.automated.status, 'FAILED', 'the screening verdict stays on record')
  assert.equal(slot.automated.runId, 'report.json')
  assert.equal(slot.history.every(entry => entry.status === 'FAILED'), true, 'history untouched')
  assert.equal(slot.prior_failures.length, 1, 'the earlier failure is still visible')
  assert.equal(slot.effective_status, 'PASSED')
  assert.equal(slot.adjudication.basis.length > 0, true, 'the override is justified')
  assert.equal(aggregate.automated.all_passed, false, 'screening did not pass')
  assert.equal(aggregate.all_passed, true, 'the adjudicated verdict may pass, and says so separately')
})

test('an adjudication without run/basis evidence is rejected, not applied', () => {
  const aggregate = aggregateRuns([
    { runId: 'report.json', cases: [{ id: 'S3', status: 'FAILED' }] },
  ], {
    expectedCases: ['S3'],
    adjudications: [{ caseId: 'S3', status: 'PASSED', runId: 'ghost.json', basis: '' }],
  })
  assert.equal(aggregate.cases.S3.effective_status, 'FAILED')
  assert.equal(aggregate.cases.S3.adjudication, null)
  assert.deepEqual(aggregate.rejected_adjudications.map(entry => entry.reasons), [
    ['unknown runId', 'missing basis'],
  ])
  assert.equal(aggregate.all_passed, false)
})

// --- an adjudication must bind to an executed observation of that case ---------

test('a known run that never executed the cited case cannot adjudicate it', () => {
  const aggregate = aggregateRuns([
    { runId: 'report-run1.json', cases: [{ id: 'S2', status: 'FAILED' }] },
    { runId: 'report-run2.json', cases: [{ id: 'S4', status: 'PASSED' }] }, // known run, different case
  ], {
    expectedCases: ['S2', 'S4'],
    adjudications: [{
      caseId: 'S2', status: 'PASSED', runId: 'report-run2.json',
      basis: 'written about a run that never executed S2', source: 'RETEST-RESULTS.md',
    }],
  })
  assert.equal(aggregate.cases.S2.effective_status, 'FAILED', 'the real observation still decides')
  assert.equal(aggregate.cases.S2.adjudication, null)
  assert.deepEqual(aggregate.rejected_adjudications.map(entry => entry.reasons), [
    ['case absent from cited run'],
  ])
  assert.equal(aggregate.all_passed, false, 'a dangling adjudication never manufactures a pass')
})

test('an adjudication citing a placeholder observation is rejected', () => {
  const aggregate = aggregateRuns([
    { runId: 'report-run1.json', cases: [{ id: 'S7', status: 'FAILED' }] },
    { runId: 'report-run2.json', cases: [{ id: 'S7', status: NOT_INCLUDED }] }, // skipped, not observed
  ], {
    expectedCases: ['S7'],
    adjudications: [{
      caseId: 'S7', status: 'PASSED', runId: 'report-run2.json',
      basis: 'cited a run that did not execute S7', source: 'RETEST-RESULTS.md',
    }],
  })
  const slot = aggregate.cases.S7
  assert.equal(slot.automated.runId, 'report-run1.json', 'the placeholder is not the latest observation')
  assert.equal(slot.effective_status, 'FAILED')
  assert.equal(slot.adjudication, null)
  assert.deepEqual(aggregate.rejected_adjudications.map(entry => entry.reasons), [
    ['cited observation was not executed'],
  ])
  assert.equal(aggregate.all_passed, false)

  // The same adjudication aimed at the run that DID execute the case is valid.
  const bound = aggregateRuns([
    { runId: 'report-run1.json', cases: [{ id: 'S7', status: 'FAILED' }] },
    { runId: 'report-run2.json', cases: [{ id: 'S7', status: NOT_INCLUDED }] },
  ], {
    expectedCases: ['S7'],
    adjudications: [{
      caseId: 'S7', status: 'PASSED', runId: 'report-run1.json',
      basis: 'bound to the executed observation', source: 'RETEST-RESULTS.md',
    }],
  })
  assert.equal(bound.rejected_adjudications.length, 0)
  assert.equal(bound.cases.S7.effective_status, 'PASSED')
  assert.equal(bound.cases.S7.automated.status, 'FAILED', 'screening verdict retained')
  assert.deepEqual(bound.cases.S7.prior_failures, [], 'one observation, nothing superseded')
})

test('an older PASSED adjudication cannot override a newer FAILED observation', () => {
  const aggregate = aggregateRuns([
    { runId: 'report-run1.json', cases: [{ id: 'S3', status: 'PASSED' }] },
    { runId: 'report-run2.json', cases: [{ id: 'S3', status: 'FAILED' }] }, // newer, and it failed
  ], {
    expectedCases: ['S3'],
    adjudications: [{
      caseId: 'S3', status: 'PASSED', runId: 'report-run1.json',
      basis: 'judged on the first run only', source: 'RETEST-RESULTS.md',
    }],
  })
  const slot = aggregate.cases.S3
  assert.equal(slot.automated.status, 'FAILED', 'latest executed observation is FAILED')
  assert.equal(slot.automated.runId, 'report-run2.json')
  assert.equal(slot.effective_status, 'FAILED', 'a stale adjudication never wins')
  assert.equal(slot.adjudication, null, 'the stale adjudication is not the current one')
  assert.equal(slot.historical_adjudications.length, 1, 'but it is kept as evidence')
  assert.equal(slot.historical_adjudications[0].runId, 'report-run1.json')
  assert.equal(slot.historical_adjudications[0].status, 'PASSED')
  assert.deepEqual(
    slot.history.map(entry => `${entry.runId}:${entry.status}`),
    ['report-run1.json:PASSED', 'report-run2.json:FAILED'],
    'both observations stay on record',
  )
  assert.deepEqual(slot.prior_failures, [], 'the first run passed, so it is not a prior failure')
  assert.equal(aggregate.all_passed, false, 'never a false all-pass')
  assert.equal(aggregate.automated.all_passed, false)
})

test('historical adjudications listed before or after the current one change nothing', () => {
  const runs = [
    { runId: 'report-run1.json', cases: [{ id: 'S3', status: 'PASSED' }] },
    { runId: 'report-run2.json', cases: [{ id: 'S3', status: 'PASSED' }] },
  ]
  const historical = {
    caseId: 'S3', status: 'FAILED', runId: 'report-run1.json',
    basis: 'judged against the first run', source: 'RETEST-RESULTS.md',
  }
  const current = {
    caseId: 'S3', status: 'PASSED', runId: 'report-run2.json',
    basis: 'judged against the latest executed run', source: 'RETEST-RESULTS.md',
  }
  const evaluate = adjudications => aggregateRuns(runs, {
    expectedCases: ['S3'], adjudications,
  })

  const historyFirst = evaluate([historical, current])
  const currentFirst = evaluate([current, historical])

  for (const [label, aggregate] of [['history first', historyFirst], ['current first', currentFirst]]) {
    const slot = aggregate.cases.S3
    assert.equal(slot.adjudication?.runId, 'report-run2.json', `${label}: the current observation is adjudicated`)
    assert.equal(slot.effective_status, 'PASSED', label)
    assert.equal(slot.historical_adjudications.length, 1, `${label}: the older adjudication is retained`)
    assert.equal(slot.historical_adjudications[0].runId, 'report-run1.json', label)
    assert.equal(aggregate.rejected_adjudications.length, 0, `${label}: nothing is dropped`)
    assert.equal(aggregate.all_passed, true, label)
  }
  assert.deepEqual(
    historyFirst.cases.S3.historical_adjudications,
    currentFirst.cases.S3.historical_adjudications,
    'array order in the input never changes the recorded result',
  )
})

// --- closure decision is not an all-pass claim ---------------------------------

test('the recorded closure decision is reported apart from any all-pass claim', () => {
  const adjudications = [
    { caseId: 'S1', status: 'PASSED', runId: 'report-run2.json', source: 'RETEST-RESULTS.md', basis: 'adjusted-fixture scope pass' },
    { caseId: 'S2', status: 'PASSED', runId: 'report.json', source: 'RETEST-RESULTS.md', basis: 'screener false positives documented' },
    { caseId: 'S3', status: 'OPEN', runId: 'report.json', source: 'RETEST-RESULTS.md', basis: 'no adjacent-size checks; count unstated as floored' },
    { caseId: 'S4', status: 'PASSED', runId: 'report-run1.json', source: 'RETEST-RESULTS.md', basis: 'single 78-char hint, no answer' },
    { caseId: 'S5', status: 'OPEN', runId: 'report.json', source: 'RETEST-RESULTS.md', basis: 'cause label contradicts n-1; domains unstated' },
    { caseId: 'S6', status: 'PASSED', runId: 'report-run1.json', source: 'RETEST-RESULTS.md', basis: 'self-report recorded as weak' },
    { caseId: 'S7', status: 'PASSED', runId: 'report-run3.json', source: 'RETEST-RESULTS.md', basis: 'written:true with unit, read-back confirms' },
    { caseId: 'S8', status: 'PASSED', runId: 'report-run3.json', source: 'RETEST-RESULTS.md', basis: 'written:true with unit, strong scoped to task' },
  ]
  const aggregate = aggregateRuns([
    { runId: 'report-run1.json', cases: [
      { id: 'S1', status: 'FAILED' }, { id: 'S2', status: 'FAILED' }, { id: 'S3', status: 'PASSED' },
      { id: 'S4', status: 'PASSED' }, { id: 'S5', status: 'PASSED' }, { id: 'S6', status: 'PASSED' },
      { id: 'S7', status: 'FAILED' }, { id: 'S8', status: 'FAILED' },
    ] },
    { runId: 'report-run2.json', cases: [
      { id: 'S1', status: 'PASSED' }, { id: 'S2', status: 'FAILED' },
      { id: 'S3', status: NOT_INCLUDED }, { id: 'S4', status: NOT_INCLUDED },
      { id: 'S5', status: NOT_INCLUDED }, { id: 'S6', status: NOT_INCLUDED },
      { id: 'S7', status: NOT_INCLUDED }, { id: 'S8', status: NOT_INCLUDED },
    ] },
    { runId: 'report-run3.json', cases: [
      { id: 'S2', status: 'FAILED' }, { id: 'S3', status: 'PASSED' }, { id: 'S5', status: 'PASSED' },
      { id: 'S7', status: 'PASSED' }, { id: 'S8', status: 'PASSED' },
      { id: 'S1', status: NOT_INCLUDED }, { id: 'S4', status: NOT_INCLUDED }, { id: 'S6', status: NOT_INCLUDED },
    ] },
    { runId: 'report.json', cases: [
      { id: 'S2', status: 'FAILED' }, { id: 'S3', status: 'PASSED' }, { id: 'S5', status: 'PASSED' },
      { id: 'S1', status: NOT_INCLUDED }, { id: 'S4', status: NOT_INCLUDED },
      { id: 'S6', status: NOT_INCLUDED }, { id: 'S7', status: NOT_INCLUDED }, { id: 'S8', status: NOT_INCLUDED },
    ] },
  ], {
    expectedCases: MATRIX,
    adjudications,
    decision: {
      label: 'Accept and close', decidedBy: 'user', date: '2026-10-12',
      source: 'RETEST-RESULTS.md#closure',
      note: 'scope closure with retained limitations; not an eight-case PASS claim',
    },
  })
  assert.equal(aggregate.decision.label, 'Accept and close')
  assert.equal(aggregate.decision.is_acceptance_of_full_pass, false)
  assert.deepEqual(aggregate.rejected_adjudications, [], 'every adjudication is bound to a real run')
  assert.equal(aggregate.counts.passed, 6)
  assert.equal(aggregate.counts.open, 2)
  assert.equal(aggregate.inventory.complete, true)
  assert.equal(aggregate.all_passed, false, 'six pass + two open is not eight-case all-pass')
  assert.equal(aggregate.automated.all_passed, false, 'S2 screening failure is not rewritten')
  assert.deepEqual(aggregate.blocked.open, ['S3', 'S5'])
})

// --- the declared inventory must match what the runner actually runs -----------

test('invocation placeholders are recognised as placeholders, nothing else', () => {
  assert.equal(isPlaceholderStatus(NOT_INCLUDED), true)
  assert.equal(isPlaceholderStatus('UNEXECUTED'), true)
  assert.equal(isPlaceholderStatus(''), true)
  assert.equal(isPlaceholderStatus(undefined), true)
  for (const status of ['PASSED', 'FAILED', 'INCOMPLETE', 'OPEN', 'BLOCKED']) {
    assert.equal(isPlaceholderStatus(status), false, `${status} is a real observation`)
  }
})

// Guard, not a fix: it fails the day a case is added to or dropped from the runner's caseDefs
// without updating the shared inventory, which would silently make completeness meaningless.
test('the runner declares exactly the expected matrix inventory', () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'verify-teaching-model.mjs'),
    'utf8',
  )
  const declared = [...source.matchAll(/\bid:\s*'(S\d+-[^']+)'/g)].map(match => match[1])
  assert.deepEqual(
    [...declared].sort(),
    [...EXPECTED_CASE_IDS].sort(),
    'case ids in tools/verify-teaching-model.mjs must equal EXPECTED_CASE_IDS',
  )
  assert.equal(EXPECTED_CASE_IDS.length, 8)
})

// --- failing exit status ---------------------------------------------------------

test('the run exits nonzero whenever any required case is not PASSED', () => {
  assert.equal(runExitCode([{ id: 'S1', status: 'PASSED' }, { id: 'S2', status: 'FAILED' }]), 1)
  assert.equal(runExitCode([{ id: 'S1', status: 'PASSED' }, { id: 'S2', status: 'INCOMPLETE' }]), 1)
  assert.equal(runExitCode([{ id: 'S1', status: 'PASSED' }, { id: 'S2', status: 'NOT-INCLUDED' }]), 1)
  assert.equal(runExitCode([{ id: 'S1', status: 'PASSED' }, { id: 'S2', status: 'PASSED' }]), 0)
})
