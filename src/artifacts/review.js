/**
 * Exam-review artifact rendering (M11, v3 §9 / §9.7).
 *
 * A review is deliberately **not** a study note with a different title: it has its own section
 * contract, states its own completeness (what is confirmed, what is not), and ends with an
 * unresolved checklist. Sections with no content are omitted and listed in `sections_omitted`, so
 * an empty section can never read as "nothing to review here".
 *
 * Where a review can be grounded in the course's persisted learning state, `hydrateReviewFromState`
 * fills the weak-points, recurring-mistakes and deep-dive sections from the parsed state files
 * rather than asking the model to retype them.
 *
 * @module dsh-professor-spike/src/artifacts/review
 */

import { renderCitationSection } from '../provenance/attach.js'
import { PRACTICE_ORIGIN_LABELS } from '../provenance/source-ref.js'
import { renderHeader, renderMetadataBlock } from './note.js'

const asArray = (value) => (Array.isArray(value) ? value : [])
const filled = (value) => typeof value === 'string' && value.trim().length > 0

/** The canonical review section order. Exported so the docs and the tests share one source. */
export const REVIEW_SECTIONS = [
  '已确认考试范围',
  '薄弱点',
  '重点与难点',
  '高频基础',
  '未确认范围',
  '必备定义与公式',
  '代表性推导或代码模式',
  '反复出错',
  '深挖主题',
  '练习',
  '未解决清单',
]

/**
 * Fill the state-derived review sections from a course's parsed learning state.
 *
 * @param options.progress - `parseProgress` output (optional).
 * @param options.mistakes - `parseMistakes` output (optional).
 * @param options.knowledge - `parseKnowledge` output (optional).
 * @returns partial review fields; every field is omitted when the state had nothing to say.
 */
export function hydrateReviewFromState(options = {}) {
  const { progress, mistakes, knowledge } = options
  const out = {}

  const weak = asArray(mistakes?.weak_topics)
    .filter((topic) => filled(topic?.topic))
    .map((topic) => `**${topic.topic}**${filled(topic.weakness) ? ` — ${topic.weakness}` : ''}`
      + `${filled(topic.reinforcement) ? `（建议：${topic.reinforcement}）` : ''}`)
  if (weak.length > 0) out.weak_points = weak

  const recurring = asArray(mistakes?.active_mistakes)
    .filter((entry) => filled(entry?.title))
    .map((entry) => {
      const firstLine = String(entry.body ?? '').split('\n').map((line) => line.trim()).find(filled)
      return `**${entry.title}**${firstLine !== undefined ? ` — ${firstLine}` : ''}`
    })
  if (recurring.length > 0) out.recurring_mistakes = recurring

  const dives = asArray(mistakes?.deep_dives)
    .filter((dive) => filled(dive?.topic))
    .map((dive) => `**${dive.topic}**${filled(dive.question) ? ` — ${dive.question}` : ''}`
      + `${filled(dive.review_action) ? `（建议：${dive.review_action}）` : ''}`)
  if (dives.length > 0) out.deep_dives = dives

  const topicsNeedingReview = asArray(progress?.topics_needing_review)
    .filter((entry) => filled(entry?.topic))
    .map((entry) => `**${entry.topic}**${filled(entry.reason) ? ` — ${entry.reason}` : ''}`
      + `${filled(entry.priority) ? `（优先级：${entry.priority}）` : ''}`)
  if (topicsNeedingReview.length > 0) out.important_topics = topicsNeedingReview

  const concepts = []
  for (const section of asArray(knowledge?.sections)) {
    for (const concept of asArray(section?.concepts)) {
      if (filled(concept?.title)) concepts.push(`**${concept.title}**`)
    }
  }
  if (concepts.length > 0) out.essential_definitions = concepts

  const goals = asArray(progress?.goals).filter(filled)
  if (goals.length > 0) out.unresolved = goals.map((goal) => `目标尚未完成：${goal}`)
  if (filled(progress?.recommended_next_step)) {
    out.unresolved = [...(out.unresolved ?? []), `下一步：${progress.recommended_next_step}`]
  }

  return out
}

const bullets = (items, indent = '') => asArray(items)
  .filter(filled)
  .map((item) => `${indent}- ${String(item).trim()}`)
  .join('\n')

/** Markdown task-list items. Separate from `bullets` so a checkbox never doubles the bullet marker. */
const checkboxes = (items) => asArray(items)
  .filter(filled)
  .map((item) => `- [ ] ${String(item).trim()}`)
  .join('\n')

/**
 * Render an exam-review artifact.
 *
 * @param input - the validated review input.
 * @param citations - a value from `buildCitations`, or undefined.
 * @returns `{ content, sections_rendered, sections_omitted }`.
 */
export function renderReview(input, citations) {
  const rendered = []
  const omitted = []
  const lines = []

  lines.push(renderMetadataBlock({
    schema: 1,
    kind: 'review',
    course_id: input.course?.course_id ?? null,
    format: 'markdown',
    generated_at: input.generated_at ?? null,
    generator: input.generator ?? null,
  }), '', ...renderHeader({ ...input, title: input.title ?? '考试复习' }))

  lines.push('> 本文件为**考试复习产物**，与平时学习笔记不同：它只汇总复习所需的结构化信息，并明确标注尚未确认的范围。', '')

  const addSection = (name, body) => {
    if (!filled(body)) { omitted.push(name); return }
    lines.push(`## ${name}`, '', String(body).replace(/\s+$/, ''), '')
    rendered.push(name)
  }

  addSection('已确认考试范围', bullets(input.confirmed_scope))
  addSection('薄弱点', bullets(input.weak_points))
  addSection('重点与难点', bullets(input.important_topics))
  addSection('高频基础', bullets(input.high_frequency))
  addSection('未确认范围', bullets(input.unconfirmed_scope))

  if (asArray(input.definitions).length > 0 || asArray(input.formulas).length > 0) {
    const parts = []
    if (asArray(input.definitions).length > 0) {
      parts.push('### 必备定义', '', bullets(input.definitions))
    }
    if (asArray(input.formulas).length > 0) {
      parts.push('### 必备公式', '', asArray(input.formulas).filter(filled).map((formula) => `- ${formula}`).join('\n'))
    }
    addSection('必备定义与公式', parts.join('\n\n'))
  } else omitted.push('必备定义与公式')

  if (asArray(input.derivations).length > 0) {
    addSection('代表性推导或代码模式', asArray(input.derivations)
      .filter((entry) => filled(entry?.body))
      .map((entry, index) => `### ${filled(entry.title) ? entry.title : `推导 ${index + 1}`}\n\n${entry.body.trim()}`)
      .join('\n\n'))
  } else omitted.push('代表性推导或代码模式')

  addSection('反复出错', bullets(input.recurring_mistakes))
  addSection('深挖主题', bullets(input.deep_dives))

  if (asArray(input.practice).length > 0) {
    const body = asArray(input.practice)
      .filter((entry) => filled(entry?.question))
      .map((entry, index) => {
        const label = PRACTICE_ORIGIN_LABELS[entry.origin] ?? entry.origin ?? '未标注'
        return [
          `**练习 ${index + 1}**（${label}）`,
          '',
          entry.question.trim(),
          ...(filled(entry.answer) ? ['', `<details><summary>参考解答</summary>`, '', entry.answer.trim(), '', '</details>'] : []),
        ].join('\n')
      })
      .join('\n\n')
    addSection('练习', body)
  } else omitted.push('练习')

  if (asArray(input.unresolved).length > 0) {
    addSection('未解决清单', checkboxes(input.unresolved))
  } else omitted.push('未解决清单')

  const citationBlock = citations === undefined ? '' : renderCitationSection(citations)
  if (filled(citationBlock)) {
    lines.push(citationBlock.replace(/\s+$/, ''), '')
    rendered.push('资料依据')
  } else omitted.push('资料依据')

  return {
    content: `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`,
    sections_rendered: rendered,
    sections_omitted: omitted.filter((name) => !rendered.includes(name)),
  }
}
