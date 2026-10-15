/**
 * Markdown study-note rendering (M11, v3 §9 / §9.5).
 *
 * Two rules shape this renderer:
 *
 * - **a section appears only when it has content.** The design forbids inventing material to fill
 *   a template, so every empty section is omitted and its absence is reported as
 *   `sections_omitted` rather than being papered over with placeholder prose;
 * - **professor material and supplementary explanation are visually separated.** A reader must be
 *   able to tell which statements came from course material and which are the model's own
 *   explanation, so they never share a heading.
 *
 * Provenance is appended as a citation block built by `provenance/attach.js`, so a note carries the
 * same auditable references the search results do.
 *
 * @module dsh-professor-spike/src/artifacts/note
 */

import { renderCitationSection } from '../provenance/attach.js'

const asArray = (value) => (Array.isArray(value) ? value : [])
const filled = (value) => typeof value === 'string' && value.trim().length > 0

/** A glossary field is one GFM cell; conditions and line breaks must not reshape its table. */
function tableCell(value) {
  let result = ''
  let backslashes = 0
  for (const char of String(value).replace(/\r\n?|\n/g, ' ')) {
    if (char === '|' && backslashes % 2 === 0) result += '\\'
    result += char
    backslashes = char === '\\' ? backslashes + 1 : 0
  }
  return result
}

/** Deterministic artifact metadata block, emitted as an HTML comment so it never renders. */
export function renderMetadataBlock(metadata) {
  const lines = ['<!-- professor-artifact', `schema: ${metadata.schema}`]
  for (const [key, value] of Object.entries(metadata)) {
    if (key === 'schema' || value === undefined || value === null) continue
    lines.push(`${key}: ${String(value)}`)
  }
  lines.push('-->')
  return lines.join('\n')
}

/** The heading block every artifact starts with: title plus course identity. */
export function renderHeader(input) {
  const lines = [`# ${input.title}`, '']
  const course = input.course ?? {}
  const identity = [
    filled(course.course_code) ? `**课程:** ${course.course_code}` : null,
    filled(course.display_name) ? `**名称:** ${course.display_name}` : null,
    filled(course.term) ? `**学期:** ${course.term}` : null,
    filled(input.topic) ? `**主题:** ${input.topic}` : null,
  ].filter(Boolean)
  if (identity.length > 0) lines.push(identity.join('  '), '')
  if (filled(input.scope)) lines.push(`**材料范围:** ${input.scope}`, '')
  if (filled(input.summary)) lines.push(input.summary.trim(), '')
  return lines
}

/** Render a bullet list from plain strings. */
function bullets(items, indent = '') {
  return asArray(items)
    .filter(filled)
    .map((item) => `${indent}- ${String(item).trim()}`)
    .join('\n')
}

/**
 * Render one Markdown study note.
 *
 * @param input - the (already validated) note input; see `defineArtifactCreateTool`.
 * @param citations - a value from `buildCitations`, or undefined.
 * @returns `{ content, sections_rendered, sections_omitted }`.
 */
export function renderNote(input, citations) {
  const rendered = []
  const omitted = []
  const lines = []

  const metadata = {
    schema: 1,
    kind: 'note',
    course_id: input.course?.course_id ?? null,
    format: 'markdown',
    generated_at: input.generated_at ?? null,
    generator: input.generator ?? null,
  }
  lines.push(renderMetadataBlock(metadata), '', ...renderHeader(input))

  const addSection = (name, body) => {
    if (!filled(body)) { omitted.push(name); return }
    lines.push(`## ${name}`, '', String(body).replace(/\s+$/, ''), '')
    rendered.push(name)
  }

  // Structured explanation: free-form sections, in the caller's order.
  for (const section of asArray(input.sections)) {
    if (!filled(section?.heading) || !filled(section?.body)) {
      if (section !== undefined && section !== null) omitted.push(section.heading ?? '(unnamed section)')
      continue
    }
    addSection(section.heading.trim(), section.body)
  }

  if (asArray(input.terminology).length > 0) {
    const rows = asArray(input.terminology)
      .filter((entry) => filled(entry?.term))
      .map((entry) => `| ${tableCell(entry.term)} | ${filled(entry.definition) ? tableCell(entry.definition) : ''} |`)
    if (rows.length > 0) {
      addSection('重要术语', ['| 术语 | 含义 |', '| --- | --- |', ...rows].join('\n'))
    } else omitted.push('重要术语')
  } else omitted.push('重要术语')

  if (asArray(input.examples).length > 0) {
    const body = asArray(input.examples)
      .filter((entry) => filled(entry?.body))
      .map((entry, index) => `### ${filled(entry.title) ? entry.title : `例 ${index + 1}`}\n\n${entry.body.trim()}`)
      .join('\n\n')
    if (filled(body)) addSection('例题与推导', body)
    else omitted.push('例题与推导')
  } else omitted.push('例题与推导')

  if (asArray(input.mistakes).length > 0) {
    addSection('易错点', bullets(input.mistakes))
  } else omitted.push('易错点')

  if (asArray(input.warnings).length > 0) {
    addSection('注意事项', bullets(input.warnings))
  } else omitted.push('注意事项')

  if (asArray(input.deep_dives).length > 0) {
    const body = asArray(input.deep_dives)
      .filter((dive) => filled(dive?.topic))
      .map((dive) => [
        `> **深挖：${dive.topic}**`,
        filled(dive.question) ? `> 问题：${dive.question}` : null,
        filled(dive.cause) ? `> 难点：${dive.cause}` : null,
        filled(dive.review_action) ? `> 建议：${dive.review_action}` : null,
      ].filter(Boolean).join('\n'))
      .join('\n>\n')
    if (filled(body)) addSection('深挖标记', body)
    else omitted.push('深挖标记')
  } else omitted.push('深挖标记')

  if (asArray(input.self_check).length > 0) {
    addSection('自测问题', bullets(input.self_check))
  } else omitted.push('自测问题')

  // Practice items always carry their origin label (原题 / 改编题 / 新编练习), so a generated
  // question is never implied to be the professor's.
  if (asArray(input.practice).length > 0) {
    const body = asArray(input.practice)
      .filter((entry) => filled(entry?.question))
      .map((entry, index) => {
        const label = entry.origin_label ?? entry.origin ?? '未标注'
        return [
          `**练习 ${index + 1}**（${label}）`,
          '',
          entry.question.trim(),
          ...(filled(entry.answer) ? ['', `<details><summary>参考解答</summary>`, '', entry.answer.trim(), '', '</details>'] : []),
        ].join('\n')
      })
      .join('\n\n')
    if (filled(body)) addSection('练习', body)
    else omitted.push('练习')
  } else omitted.push('练习')

  if (asArray(input.supplementary).length > 0) {
    addSection(
      '补充说明（模型补充，非教授材料）',
      `${bullets(input.supplementary)}\n\n> 以上内容为模型补充的讲解，用于帮助理解，**不代表教授讲义的观点或考试范围**。`,
    )
  } else omitted.push('补充说明')

  const citationBlock = citations === undefined ? '' : renderCitationSection(citations)
  if (filled(citationBlock)) {
    lines.push(citationBlock.replace(/\s+$/, ''), '')
    rendered.push('资料依据')
  } else {
    omitted.push('资料依据')
  }

  return {
    content: `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`,
    sections_rendered: rendered,
    sections_omitted: omitted.filter((name) => !rendered.includes(name)),
  }
}
