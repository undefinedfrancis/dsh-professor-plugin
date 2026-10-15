/**
 * The M2b executor is wired to the helpers it is supposed to use.
 *
 * The 2026-10-14 project review found "offline configuration helpers/tests now exist, but no use of
 * `buildInstructionSurface` / `m2b-run-config` in the inspected formal/live executors". That gap is
 * the whole reason the previous run could go out with a persona-only system prompt, a 2,000-token
 * allowance, no persisted finish reason, a path predicted from a title, and a status line that
 * promoted introductory text to OBSERVED — every one of which now has a passing unit test that the
 * executor simply never called.
 *
 * So this suite asserts the *connection*, not the helpers: the executor source must name them, and
 * must no longer contain the specific expressions that produced the failure. It also pins the two
 * copies of the formal executor byte-for-byte, because a fix applied to one and not the other
 * would leave whichever path the next grant uses still broken.
 *
 * No model request is made; these are text assertions over source that already parses.
 *
 * @module test/m2b-executor-wiring
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const FORMAL = path.join(ROOT, 'tools', 'verify-m2b-model.mjs')
const LEGACY = path.join(ROOT, 'docs', 'qa', '2026-10-12-source-grounded-notes', 'run-model.mjs')
const TWIN = path.join(ROOT, 'docs', 'qa', '2026-10-13-m2b-live', 'run-model.mjs')
const CONTINUATION = path.join(ROOT, 'docs', 'qa', '2026-10-13-m2b-live', 'run-model-continuation.mjs')
const INSTRUCTION_DOC = path.join(
  ROOT, 'docs', 'qa', '2026-10-13-source-grounding-review', 'M2B-EXECUTION-INSTRUCTION.md',
)

const read = (file) => fs.readFile(file, 'utf8')

// The public executor must be inspected in both public checkouts and installed packages.
const repoTest = (name, fn) => test(name, fn)

/** Every helper the executor must actually import. */
const REQUIRED_HELPERS = [
  'buildInstructionSurface',
  'guidanceReadinessProblems',
  'requestTextProblems',
  'classifyTurnOutcome',
  'parseToolArguments',
  'artifactPathsFromCreate',
  'assessDelivery',
  'ARTIFACT_TOKEN_ALLOWANCE',
  'REQUIRED_M2B_TOOLS',
  'INSTRUCTION_MODES',
]

/** Every helper that must also be invoked, not merely imported. */
const REQUIRED_CALLS = [
  'buildInstructionSurface(',
  'guidanceReadinessProblems(',
  'classifyTurnOutcome({',
  'validateToolBatch(',
  'artifactPathsFromCreate(',
  'assessDelivery({',
]

repoTest('the two copies of the formal executor are byte-identical', async (t) => {
  if (!(await fs.stat(LEGACY).catch(() => null))) {
    t.skip('local compatibility wrappers are excluded from publication'); return
  }
  const [formal, twin] = await Promise.all([read(LEGACY), read(TWIN)])
  assert.equal(
    formal,
    twin,
    'docs/qa/2026-10-12-source-grounded-notes/run-model.mjs and '
    + 'docs/qa/2026-10-13-m2b-live/run-model.mjs are two copies of one executor; a fix applied to '
    + 'only one leaves whichever path the next grant uses still broken',
  )
})

repoTest('the formal executor imports and uses every configuration helper', async () => {
  const source = await read(FORMAL)
  for (const helper of REQUIRED_HELPERS) {
    assert.ok(source.includes(helper),
      `the formal executor must use ${helper} — a helper with a passing unit test that the `
      + 'executor never calls is exactly the gap the 2026-10-14 review found')
  }
  for (const call of REQUIRED_CALLS) {
    assert.ok(source.includes(call), `${call} must be invoked, not just imported`)
  }
})

repoTest('the formal executor derives its directory with fileURLToPath', async () => {
  const source = await read(FORMAL)
  assert.ok(!source.includes('new URL(import.meta.url).pathname'),
    'the executor must not percent-encode its own directory — a checkout path containing a space '
    + 'or a Chinese character would make every evidence path point at a directory that does not exist')
  assert.match(source, /path\.dirname\(fileURLToPath\(import\.meta\.url\)\)/)
})

repoTest('the formal executor can run in either instruction mode and offers the host skill tool natively', async () => {
  const source = await read(FORMAL)
  assert.ok(source.includes('--instruction-mode='),
    'the mode must be an explicit flag so the readiness record and the report can say which test ran')
  assert.ok(source.includes("[...REQUIRED_M2B_TOOLS, 'skill']"),
    'native mode must offer the host `skill` tool: without it the bundled bodies can never reach '
    + 'the attempt however well the registry resolves them, and the run proves nothing about '
    + 'native activation')
  assert.ok(source.includes('resolvedSkillContents'),
    'the executor must resolve the skill bodies through the host registry to assert the guidance '
    + 'is reachable — six names in metadata is not those skills being read')
})

repoTest('the formal executor refuses the paid path when the guidance or tools are missing', async () => {
  const source = await read(FORMAL)
  assert.match(source, /if \(instructionProblems\.length > 0\) \{\s*\n\s*await refuse\(/,
    'a pre-request readiness failure must refuse before any charge, not merely be recorded')
  assert.ok(source.includes('readiness.stages.instruction_surface ='),
    'the readiness record must carry the instruction-surface verdict so a zero-cost run shows it')
})

repoTest('a turn is never promoted to OBSERVED from the presence of text', async () => {
  const source = await read(FORMAL)
  assert.ok(!source.includes("finalText ? 'OBSERVED'"),
    "status = finalText ? 'OBSERVED' promoted the 2026-10-13 continuation's introductory text to "
    + 'a completed turn that had ended on finish reason tool-calls')
  assert.ok(!source.includes('JSON.parse(block.arguments)'),
    'malformed partial tool JSON must be refused by parseToolArguments, never executed')
  assert.ok(source.includes('lastFinish'),
    'the classification must come from the host finish reason actually captured on this turn')
})

repoTest('the formal executor sets an adequate output allowance and persists finish reason and usage', async () => {
  const source = await read(FORMAL)
  assert.ok(!source.includes('maxTokens = 2000'),
    '2,000 tokens could not hold a full artifact-create argument JSON; the allowance must be '
    + 'ARTIFACT_TOKEN_ALLOWANCE')
  assert.match(source, /maxTokens = ARTIFACT_TOKEN_ALLOWANCE/)
  assert.ok(source.includes('consumeModelStream({'), 'the tested stream consumer persists even on exceptions')
  assert.ok(source.includes('persistAttempt: () => writeJson(COUNTER_PATH, counter)'), 'metadata must reach the durable ledger')
  assert.ok(source.includes('record.rounds.push('),
    'per-round finish reason and usage must also land on the case record')
})

repoTest('the request text never names an artifact path predicted from a title', async () => {
  const source = await read(FORMAL)
  const noteRequest = /function noteRequest\([\s\S]*?\n\}/.exec(source)?.[0] ?? ''
  assert.ok(noteRequest.length > 0, 'noteRequest must be found in the executor')
  assert.ok(!noteRequest.includes('.professor'),
    'noteRequest must not assemble a workspace path: slugify truncates a title at 64 characters, '
    + 'so the 78-character title used on 2026-10-13 produced a directory nobody could predict')
  assert.ok(!noteRequest.includes('content.tex'), 'noteRequest must not name the file to edit')
  assert.ok(source.includes('M2B_TABLE_REQUIREMENTS'),
    'the M2b requirement must be one constant so the pre-request gate checks the exact text sent')
  assert.ok(source.includes('requestTextProblems({ text: m2bRequestText, workspace })'),
    'the predicted-path gate must be run against the real request text before any charge')
})

repoTest('delivery is assessed from the artifact, and an undelivered case is not left OBSERVED', async () => {
  const source = await read(FORMAL)
  assert.ok(source.includes("if (rec.status === 'OBSERVED') rec.status = 'INCOMPLETE (delivery)'"),
    'a case holding TABLE_PLACEHOLDER, or with nothing read back, must not stand as OBSERVED')
  assert.ok(source.includes('registrationRows'),
    'the INDEX registration list must reach assessDelivery so an empty list is reported as not '
    + 'registered rather than assumed')
})

repoTest('run-model.mjs is the documented entry point, not the continuation runner', async (t) => {
  if (!(await fs.stat(INSTRUCTION_DOC).catch(() => null))) {
    t.skip('historical local execution instructions are excluded from publication'); return
  }
  const instruction = await read(INSTRUCTION_DOC)
  assert.match(instruction, /run-model\.mjs/,
    'the execution instruction must name the formal executor')
  assert.ok(!/run-model-continuation\.mjs/.test(instruction),
    'the continuation runner hard-codes a content.tex path predicted from the full 78-character '
    + 'title; it is historical evidence of the failed run and must never be the documented path')

  // It must stay recognisably the historical artefact it is: if that ever stops being true, the
  // note above should be revisited rather than assumed.
  const continuation = await read(CONTINUATION)
  assert.ok(continuation.includes("title 固定为") || continuation.includes('content.tex 路径')
    || continuation.includes('.professor'),
    'the continuation runner is left as the record of the failed run; a change here means the '
    + 'entry-point note above should be re-checked')
})
