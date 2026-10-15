/**
 * Teaching-interaction instruction surface (2026-10-12).
 *
 * Regression coverage for the approved teaching-interaction design
 * (`docs/qa/2026-10-11-teaching-design/RESEARCH.md`): respect the current request, coherent
 * progression, graduated assistance, targeted optional understanding checks, specific feedback
 * and honest learning evidence.
 *
 * These are **static instruction-coverage tests**, not live-model behavioral acceptance: they
 * assert that the shipped professor-study skill, the bundled presets and the composed per-turn
 * rules actually contain each governing rule (and none of the prohibited patterns). Whether a
 * model follows the text needs authorized paid-model acceptance and is recorded as UNVERIFIED in
 * `docs/qa/2026-10-12-teaching-interaction/REPORT.md`.
 *
 * @module test/teaching-interaction
 */

import assert from 'node:assert/strict'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { composeSkill } from '../src/skills/compose.js'
import { BUNDLED_PRESETS, bundledPreset } from '../src/skills/presets.js'
import { defineStateUpdateTool } from '../src/tools/state.js'

const SKILL_PATH = path.join(import.meta.dirname, '..', 'skills', 'professor-study', 'SKILL.md')
const skillText = await fs.readFile(SKILL_PATH, 'utf8')

const socratic = bundledPreset('builtin-socratic').fields.additionalInstructions
const progressive = bundledPreset('builtin-progressive').fields.additionalInstructions
const examReview = bundledPreset('builtin-exam-review').fields.additionalInstructions
const coding = bundledPreset('builtin-coding').fields.additionalInstructions
const quick = bundledPreset('builtin-quick-answers').fields.additionalInstructions

const composedWithSocratic = composeSkill({
  builtIn: skillText,
  global: { ...bundledPreset('builtin-socratic').fields },
}).content

const evidenceDescription = defineStateUpdateTool({}).parameters.properties.evidence.description

// --- 1. Respect the current request -----------------------------------------

test('a complete explanation requested under the Socratic preset is delivered before anything else', () => {
  // The Socratic preset must keep the direct-switch escape hatch…
  assert.match(socratic, /直接告诉我/)
  assert.match(socratic, /完整直接的讲解|完整.*讲解/)
  // …and the skill must state that an explicit complete-explanation request beats any saved
  // rhythm or Socratic preference.
  assert.match(skillText, /overrides any saved teaching rhythm/i)
  assert.match(skillText, /complete explanation/i)
  // The composed turn rules still carry the depth-precedence answer for this exact case.
  assert.match(composedWithSocratic, /Depth precedence/)
  assert.match(composedWithSocratic, /Answer the request that was actually made/)
  // The requested explanation precedes optional exercises.
  assert.match(skillText, /before (any|an) (optional )?(exercise|exercises|follow-up)/i)
})

test('a hint-only request gets the hint without the complete solution', () => {
  assert.match(skillText, /hint-only/i)
  assert.match(skillText, /without (revealing|giving) (the )?complete solution/i)
  assert.match(socratic, /只要提示|提示不揭晓/)
  assert.match(composedWithSocratic, /hint-only/i)
})

test('the request intent distinguishes complete explanation, incremental tutoring and a check', () => {
  assert.match(skillText, /Infer (from )?the current (message|request)/i)
  const section = /## Respect the current request([\s\S]*?)\n## /.exec(skillText)
  assert.ok(section, 'the skill has a Respect the current request section')
  assert.match(section[1], /complete explanation/i)
  assert.match(section[1], /incremental/i)
  assert.match(section[1], /understanding check/i)
})

// --- 2. Teach through a coherent progression --------------------------------

test('incremental teaching links intuition and an example to definition, assumptions and key reasoning', () => {
  assert.match(skillText, /intuition/i)
  assert.match(skillText, /concrete example/i)
  assert.match(skillText, /definition/i)
  assert.match(skillText, /assumptions/i)
  assert.match(skillText, /key reasoning/i)
  assert.match(progressive, /先用直觉和一个具体例子引入概念/)
  assert.match(progressive, /准确定义/)
})

test('incremental teaching begins from the learner’s attempt and asks only material questions', () => {
  assert.match(skillText, /Begin from the student'?s existing attempt/i)
  assert.match(skillText, /materially (changes|affects) the next step/i)
  assert.match(skillText, /never (re-ask|reask|repeat) setup questions/i)
  assert.match(skillText, /rituals?/i)
})

// --- 3. Escalate assistance appropriately -----------------------------------

test('repeated difficulty escalates assistance instead of repeating ineffective questions', () => {
  // The four rungs appear in order.
  assert.match(skillText, /conceptual cue[\s\S]*local-step hint[\s\S]*partial demonstration[\s\S]*complete explanation/i)
  assert.match(skillText, /one useful reasoning step/i)
  assert.match(skillText, /Do not repeat it/i)
  assert.match(skillText, /missing prerequisite/i)
  assert.match(skillText, /instead of asking the same ineffective question/i)
  // No invented timing and no arbitrary turn thresholds.
  assert.match(skillText, /never (gate|gates) help behind a fixed turn count|never.*fixed turn count/i)
  assert.match(skillText, /elapsed-time|elapsed time/i)
  // Switching to direct explanation or stopping the exercise is honored.
  assert.match(skillText, /stop the exercise/i)
  assert.match(skillText, /direct explanation/i)
  assert.match(composedWithSocratic, /escalate|understanding-check request|switch to direct explanation/i)
})

test('the CODING-TUTOR ladder keeps its Hint 1..Hint 4 contract and aligns with graduated rungs', () => {
  assert.match(skillText, /Hint 1/)
  assert.match(skillText, /Hint 2/)
  assert.match(skillText, /Hint 3/)
  assert.match(skillText, /Hint 4/)
  assert.match(coding, /概念提示|逐级/)
})

// --- 4. Targeted, optional understanding checks ------------------------------

test('understanding checks are targeted, optional, and never a routine ending', () => {
  const section = /## Understanding checks([\s\S]*?)\n## /.exec(skillText)
  assert.ok(section, 'the skill has an Understanding checks section')
  assert.match(section[1], /own words/i)
  assert.match(section[1], /variation/i)
  assert.match(section[1], /boundary case/i)
  assert.match(section[1], /optional/i)
  assert.match(section[1], /declin|skip/i)
  assert.match(section[1], /Do not routinely end/i)
  assert.match(section[1], /before the student attempts it|before (an|the) attempt/i)
})

test('a learner declining a check keeps getting taught', () => {
  const section = /## Understanding checks([\s\S]*?)\n## /.exec(skillText)
  assert.match(section[1], /continue teaching/i)
  assert.match(socratic, /我拒绝时就继续|拒绝/)
  // The old mandatory "always confirm at the end" ritual is gone.
  assert.doesNotMatch(socratic, /始终在最后确认/)
})

// --- 5. Specific and accurate feedback ---------------------------------------

test('a partially correct attempt gets valid parts named and the first substantive gap fixed', () => {
  assert.match(skillText, /which parts of an attempt are valid and why/i)
  assert.match(skillText, /first substantive gap/i)
  assert.match(skillText, /concrete next action/i)
  assert.match(skillText, /conceptual errors/i)
  assert.match(skillText, /notation slips|notation/i)
  assert.match(skillText, /procedural errors|procedural/i)
  assert.match(skillText, /missing prerequisites/i)
  assert.match(skillText, /Verify mathematical and programming examples before adopting them/i)
})

test('an alternative valid method is accepted rather than marked wrong', () => {
  assert.match(skillText, /alternative valid (methods|method|solutions|approaches)/i)
  assert.match(skillText, /not (itself )?an error/i)
  assert.match(examReview, /接受与参考解法不同但同样正确/)
  assert.match(coding, /接受与参考实现不同但正确/)
})

// --- 6. Honest learning evidence ---------------------------------------------

test('self-reported understanding is recorded as self-report, not independent mastery', () => {
  assert.match(skillText, /Self-report/i)
  assert.match(skillText, /not proof of independent mastery|is not proof/i)
  assert.match(evidenceDescription, /self-report|stated understanding/i)
  assert.match(evidenceDescription, /weak/)
})

test('a hint-assisted solution is never described as independently solved', () => {
  assert.match(skillText, /hint-assisted/i)
  assert.match(skillText, /never describe it as independently solved|not.*independently solved/i)
  assert.match(evidenceDescription, /hint-assisted/i)
  assert.match(evidenceDescription, /independent/i)
})

test('one independently correct answer is evidence for that task, not durable mastery', () => {
  assert.match(skillText, /evidence for (that|the) task/i)
  assert.match(skillText, /durable mastery/i)
  assert.match(skillText, /Distinguish material covered/i)
  assert.match(skillText, /demonstrated understanding/i)
})

test('lightweight questions still write no persistent state', () => {
  assert.match(skillText, /Lightweight question/i)
  assert.match(evidenceDescription, /none = lightweight question \(no write\)/)
  assert.match(skillText, /evidence: none|`none`/)
})

// --- 7. Coverage honesty and absent state -------------------------------------

test('coverage claims match the material actually read and citations stay honest', () => {
  assert.match(skillText, /coverage claims? (are )?consistent with the material actually read/i)
  assert.match(skillText, /Never fabricate professor statements/)
  assert.match(composedWithSocratic, /never imply complete coverage you did not establish/)
})

test('absent course state is the normal first-study condition', () => {
  assert.match(skillText, /first-study condition|first study/i)
  assert.match(skillText, /start from the material/i)
})

// --- 8. Prohibited patterns stay out of the bundle ------------------------------

test('no mandatory check ritual, rigid refusal or invented threshold ships anywhere', () => {
  for (const preset of BUNDLED_PRESETS) {
    const text = preset.fields.additionalInstructions ?? ''
    assert.doesNotMatch(text, /始终在最后确认/, `${preset.id} keeps no mandatory final-check ritual`)
    assert.doesNotMatch(text, /拒绝回答|refuse to (answer|give)/i, `${preset.id} keeps no rigid answer refusal`)
    assert.doesNotMatch(text, /第 ?[0-9]+ ?轮|after [0-9]+ (turns|attempts|minutes)/i,
      `${preset.id} keeps no turn-count or timing threshold`)
  }
  assert.doesNotMatch(skillText, /refuse to (provide|give) (a |the )?(full |complete )?(explanation|answer|solution)/i)
  assert.doesNotMatch(skillText, /always end (the |each |every )?(reply|turn|answer) (by )?ask/i)
})

// --- 9. Pinned compatibility contracts remain --------------------------------

test('the previously pinned wording contracts still hold', () => {
  assert.match(socratic, /直接告诉我/)
  assert.match(progressive, /循序渐进的顺序教学/)
  assert.match(progressive, /先把要求的正文完整讲完，练习与提问放在其后/)
  assert.match(quick, /快速答疑模式：第一句先给出明确答案/)
  assert.match(skillText, /Reading or explaining does not mean mastery/)
  assert.match(composedWithSocratic, /professor_mandatory_boundaries/)
})

// --- 10. Exam-review evidence discipline (P2 correction, 2026-10-12) ----------
// Static instruction checks on the **composed** surface of the exam-review preset, not just the
// source string in presets.js. They pin instruction text only; they do not prove model behavior.

const composedWithExamReview = composeSkill({
  builtIn: skillText,
  global: { ...bundledPreset('builtin-exam-review').fields },
}).content

test('static instruction check: exam review without exam evidence reports the gap and proceeds concept-based', () => {
  // Missing evidence: say so briefly, then continue with concept-based review.
  assert.match(composedWithExamReview, /没有考试证据时/)
  assert.match(composedWithExamReview, /概念型复习|概念/)
  // Never invent exam emphasis, frequency, weighting or predictions.
  assert.match(composedWithExamReview, /不要杜撰/)
  assert.match(composedWithExamReview, /侧重|频率|分值|预测/)
  // Missing exam papers must not block ordinary review; ask only when it materially matters.
  assert.match(composedWithExamReview, /不要因为缺少往年卷而阻塞/)
  assert.match(composedWithExamReview, /只有确实影响本次复习时才向我要补充材料/)
})

test('static instruction check: exam-frequency claims require supplied evidence and name its scope', () => {
  // Genuine supplied evidence may inform the plan — conditioned on the evidence.
  assert.match(composedWithExamReview, /只有证据支持时才说/)
  assert.match(composedWithExamReview, /常考/)
  assert.match(composedWithExamReview, /证据范围/)
  // A small sample does not establish general frequency.
  assert.match(composedWithExamReview, /少量样卷不足以/)
  // Confirmed scope (material / syllabus / instructor / papers) is what establishes exam scope.
  assert.match(composedWithExamReview, /讲义|大纲|老师强调|往年卷/)
  // Review priorities come from confirmed scope + foundations + observed difficulty.
  assert.match(composedWithExamReview, /复习优先级由已确认范围/)
})

test('static instruction check: exam review separates confirmed scope, foundations, personal priorities and unconfirmed relevance', () => {
  assert.match(composedWithExamReview, /已确认的考试范围/)
  assert.match(composedWithExamReview, /老师强调/)
  assert.match(composedWithExamReview, /课程反复出现的基础/)
  assert.match(composedWithExamReview, /不等于考试频率/)
  assert.match(composedWithExamReview, /针对我个人的练习重点/)
  assert.match(composedWithExamReview, /尚未确认的考试相关性/)
})

test('static instruction check: no unconditional exam-frequency demand remains and the kept clauses survive', () => {
  // The P2 defect text is gone from the preset and from the composed surface.
  assert.doesNotMatch(examReview, /高频考点清单/)
  assert.doesNotMatch(composedWithExamReview, /高频考点清单/)
  // Optional diagnostics, specific feedback and alternative valid methods are kept.
  assert.match(composedWithExamReview, /可跳过/)
  assert.match(composedWithExamReview, /接受与参考解法不同但同样正确/)
  assert.match(composedWithExamReview, /第一个实质性错误/)
  // The preset now agrees with the review skill's evidence discipline (no leftover contradiction).
  const reviewSkill = readFileSync(
    path.join(import.meta.dirname, '..', 'skills', 'professor-review', 'SKILL.md'), 'utf8')
  assert.match(reviewSkill, /State clearly what is \*\*not\*\* confirmed/)
  assert.match(reviewSkill, /not from guesswork about exams/)
})
