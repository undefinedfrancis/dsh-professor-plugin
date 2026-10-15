/**
 * The note-format gate (M11, v3 §9).
 *
 * The rule the design mandates, made executable:
 *
 * - an explicit request for Markdown is honoured;
 * - an explicit request for LaTeX is honoured;
 * - **otherwise the format is not guessed** — the caller receives a structured
 *   `format_required` result and must ask the user;
 * - a previously used format is never silently reused, and nothing unrelated (extension of some
 *   other file, the language of the question, a past artifact) is used as evidence.
 *
 * Saved `notes.default_format` values are preferences, not authorization for this artifact.
 * They never bypass the explicit choice required on every generation.
 *
 * @module dsh-professor-spike/src/artifacts/format-gate
 */

/** The two formats an artifact may be produced in. */
export const ARTIFACT_FORMATS = ['markdown', 'latex']

/** Where a decision came from, so the tool output can be audited. */
export const FORMAT_SOURCES = ['explicit-request', 'project-default', 'none']

/**
 * Normalise a caller-supplied format spelling.
 *
 * @param value - raw argument.
 * @returns `'markdown' | 'latex' | undefined` (an unrecognised value is `undefined`, never a guess).
 */
export function normalizeFormat(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (text === 'markdown' || text === 'md') return 'markdown'
  if (text === 'latex' || text === 'tex') return 'latex'
  return undefined
}

/**
 * Decide the artifact format.
 *
 * @param options.requested - the user's explicit request (`'markdown' | 'latex' | undefined`).
 * @param options.projectDefault - `project.yaml` `notes.default_format` (`latex|markdown|ask`).
 * @param options.kind - `'note' | 'review'` (used only in the question text).
 * @returns `{ status: 'ok', format, source, reason }` or
 *   `{ status: 'required', options: ARTIFACT_FORMATS, question }`.
 */
export function resolveArtifactFormat(options = {}) {
  const requested = normalizeFormat(options.requested)
  if (requested !== undefined) {
    return {
      status: 'ok',
      format: requested,
      source: 'explicit-request',
      reason: `the caller explicitly requested ${requested}`,
    }
  }

  const kind = options.kind === 'review' ? '复习产物' : '笔记'
  return {
    status: 'required',
    options: ARTIFACT_FORMATS,
    source: 'none',
    question: `请选择${kind}格式：markdown 还是 latex？（每次生成都需明确选择，不沿用保存的偏好）`,
    reason: 'no explicit format was requested for this artifact',
  }
}

/** Build the domain error a caller raises when the gate returns `required`. */
export function formatRequiredError(decision) {
  const error = new Error(decision.question)
  error.code = 'PROFESSOR_ARTIFACT_FORMAT_REQUIRED'
  error.options = decision.options
  return error
}
