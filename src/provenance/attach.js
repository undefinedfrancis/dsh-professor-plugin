/**
 * Attaching provenance to generated artifacts (M9, v3 §15.4).
 *
 * Notes and review artifacts must preserve useful source references. This module turns the chunks
 * an artifact was built from into a citation block the artifact can carry, and enforces the two
 * constraints that matter for honesty:
 *
 * - every local citation is a validated `SourceRef`, and unknown coordinates stay absent;
 * - a practice item's origin (`原题` / `改编题` / `新编练习`) is stated whenever the citation
 *   describes a practice item, and never for a plain lecture reference.
 *
 * Web sources are rendered as external and model inference never claims professor authorship, so
 * a reader can tell at a glance where a statement came from.
 *
 * @module dsh-professor-spike/src/provenance/attach
 */

import { findProvenanceConflicts, formatSourceRef, sourceRefFromChunk } from './source-ref.js'

/**
 * Build the citation block for an artifact.
 *
 * @param options.chunks - the chunks the artifact drew on (from search results or the store).
 * @param options.practiceOrigins - optional map `chunk_id -> origin` for practice items.
 * @returns `{ refs, lines, conflicts, hasExternal, hasInference }`.
 */
export function buildCitations(options) {
  const { chunks = [], practiceOrigins = {} } = options
  const refs = []
  const seen = new Set()

  for (const chunk of chunks) {
    const origin = practiceOrigins[chunk.chunk_id]
    const isPractice = typeof origin === 'string'
    let ref
    try {
      ref = sourceRefFromChunk(chunk, { practice: isPractice, origin })
    } catch {
      continue // a malformed chunk never poisons the artifact's citation block
    }
    const key = JSON.stringify(ref)
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }

  return {
    refs,
    lines: refs.map((ref) => `- ${formatSourceRef(ref)}`),
    conflicts: findProvenanceConflicts(refs),
    hasExternal: refs.some((ref) => ref.source_type === 'external_web_source'),
    hasInference: refs.some((ref) => ref.source_type === 'model_inference'),
  }
}

/**
 * Render a ready-to-append Markdown citation section.
 *
 * The section header is explicit about the source class when one is present (v3 §15.3: a label is
 * required when the class affects interpretation).
 *
 * @param citations - a value from `buildCitations`.
 * @returns Markdown text (empty string when there is nothing to cite).
 */
export function renderCitationSection(citations) {
  if (citations.refs.length === 0) return ''
  const lines = ['## 资料依据', '']
  lines.push(...citations.lines)
  if (citations.hasExternal) lines.push('', '> 标注 [external] 的条目为外部来源，非课程材料。')
  if (citations.hasInference) lines.push('> 标注 [model inference] 的内容为模型推断，不代表教授观点。')
  if (citations.conflicts.length > 0) {
    lines.push('', '### 来源冲突（需人工核对，未静默合并）')
    for (const conflict of citations.conflicts) {
      lines.push(`- \`${conflict.key}\`: ${conflict.refs.map((ref) => formatSourceRef(ref)).join(' vs ')}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Assert an artifact's citation block satisfies the provenance rules before it is written.
 *
 * @param citations - a value from `buildCitations`.
 * @returns `{ ok, errors }`.
 */
export function checkCitations(citations) {
  const errors = []
  for (const ref of citations.refs) {
    if (ref.source_type === 'local_course_source' && ref.file_id === undefined && ref.relative_path === undefined) {
      errors.push('a local citation must name its file')
    }
    if (ref.origin === 'generated' && ref.practice !== true) {
      errors.push('a generated-practice origin must be marked as practice')
    }
  }
  // Conflicts are surfaced by `renderCitationSection`, not an error here: v3 §15.3 requires them
  // to be *shown*, so the failure mode is omitting them from the artifact, not detecting them.
  if (citations.conflicts !== undefined && !Array.isArray(citations.conflicts)) {
    errors.push('conflicts must be a list so it can be surfaced to the reader')
  }
  return { ok: errors.length === 0, errors }
}
