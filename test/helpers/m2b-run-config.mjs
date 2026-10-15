/**
 * The M2b runner's input-surface, output-limit and delivery-labelling decisions, expressed as
 * pure functions so they can be asserted **offline**, before any request is paid for.
 *
 * What went wrong the first time
 * ------------------------------
 * The live run failed in ways a green test could not see, because none of them were functions —
 * they were inline string concatenation and a status line:
 *
 * - the system prompt was the persona section alone, so the installed notes/LaTeX guidance about
 *   finishing a wide table was never in the model's input;
 * - a 2,000-token allowance could not hold artifact tool-argument JSON, and the attempt's finish
 *   reason was not persisted, so truncation could only be guessed at afterwards;
 * - `status = finalText ? 'OBSERVED' : ...` promoted introductory text to OBSERVED even when the
 *   turn had not concluded;
 * - the request named a `content.tex` path predicted from the full 78-character title, but
 *   `slugify()` truncates at 64, so the predicted path did not exist;
 * - a missing artifact fell back to grading the chat reply, and `TABLE_PLACEHOLDER` was never
 *   treated as "incomplete".
 *
 * Each of those is now a function with a test.
 *
 * @module test/helpers/m2b-run-config
 */

import path from 'node:path'

/**
 * The exact fragments the bundled skills use to state the wide-table finishing workflow: where to
 * edit (`content.tex`), what to write (`\begin{tabular}`), and where it must never go
 * (`sections[].body`). All three appear verbatim in both `professor-notes` and `professor-latex`,
 * so an input missing any of them did not receive the guidance.
 */
export const TABLE_FINISHING_MARKERS = ['content.tex', '\\begin{tabular}', 'sections[].body']

/** The sentinel the renderer leaves where a table was never written. */
export const TABLE_PLACEHOLDER = 'TABLE_PLACEHOLDER'

/**
 * Two instruction modes, kept apart on purpose.
 *
 * `native` is what the agent's own system-prompt assembly produced — the honest test of bundled
 * skill activation. `supplied-skill-text` is the runner handing the model the SKILL.md bodies
 * itself: a legitimate repair to try, but it proves nothing about native activation, so it is
 * labelled as a different mode everywhere it is recorded.
 */
export const INSTRUCTION_MODES = {
  NATIVE: 'native-assembled-system-sections',
  SUPPLIED: 'explicitly-supplied-skill-text',
}

export function normalizeInstructionMode(value = 'native') {
  if (value === 'native' || value === INSTRUCTION_MODES.NATIVE) return INSTRUCTION_MODES.NATIVE
  if (value === 'supplied-skill-text' || value === INSTRUCTION_MODES.SUPPLIED) return INSTRUCTION_MODES.SUPPLIED
  throw new Error(`unknown instruction mode ${JSON.stringify(value)}`)
}

/** Validate the whole response before allowing any of its operations to execute. */
export function validateToolBatch(calls, { finish, offeredTools }) {
  const refuse = (reason) => ({ ok: false, calls: [], reason })
  if (finish?.kind !== 'tool-calls') return refuse('tool calls arrived in an unfinished or invalid response')
  const parsedCalls = []
  for (const call of calls) {
    if (!offeredTools.includes(call.name)) return refuse(`tool ${call.name} was not offered`)
    const parsed = parseToolArguments(call.arguments)
    if (!parsed.ok) return refuse(`tool ${call.name}: ${parsed.reason}`)
    parsedCalls.push({ block: call, args: parsed.args })
  }
  return { ok: true, calls: parsedCalls, reason: null }
}

/** Persist outcome metadata even when opening or reading the remote stream throws. */
export async function consumeModelStream({ openStream, attempt, maxTokens, persistAttempt }) {
  const blocks = []
  let finish = null
  let usage = null
  try {
    for await (const chunk of openStream()) {
      if (chunk.type === 'block-end') blocks.push(chunk.block)
      if (chunk.type === 'finish') finish = chunk.reason
      if (chunk.usage != null) usage = chunk.usage
    }
    return { blocks, finish, usage: usage ?? finish?.usage ?? null }
  } catch (error) {
    attempt.stream_error = error.message
    throw error
  } finally {
    attempt.finish_reason = finish
    attempt.usage = usage ?? finish?.usage ?? null
    attempt.max_tokens = maxTokens
    await persistAttempt()
  }
}

/** No file means no grading target; chat prose must never substitute for delivery. */
export function artifactGradingText(contents) {
  const text = contents.filter((value) => typeof value === 'string').join('\n')
  return text.trim().length > 0 ? text : null
}

export function compilationFactsForCase(caseId, compile, visual) {
  return {
    compiled: compile?.artifact_case_id === caseId ? compile.pdf?.produced === true : null,
    visuallyAccepted: visual?.artifact_case_id === caseId ? visual.inspected === true : null,
  }
}

/**
 * Output allowance for requests that generate an artifact.
 *
 * 2,000 tokens could not hold a full `professor_artifact_create` argument JSON plus reasoning, and
 * the resulting `max-tokens` finish went unrecorded. 8,000 is the ceiling already proven to fit
 * the argument plus a table round in the continuation phase.
 */
export const ARTIFACT_TOKEN_ALLOWANCE = 8000

/**
 * Build the system prompt actually sent, and say which mode produced it.
 *
 * In `native` mode only the agent's own assembled sections are used — if the skill bodies are not
 * in there, they are not in the input, and no caller may pretend otherwise. Skill text supplied by
 * the runner is appended under a delimiter and flips the mode to `supplied-skill-text`.
 *
 * @param options.sections - the assembled `{ name, text }` sections from `sessionSurface`.
 * @param options.persona - fallback when no sections were assembled.
 * @param options.suppliedSkillText - SKILL.md bodies the runner chose to hand over, or `null`.
 * @returns `{ system, mode, modeLabel, sectionNames, suppliedSkills }`.
 */
export function buildInstructionSurface({
  sections = [], persona = '', suppliedSkillText = null, suppliedSkillNames = [],
}) {
  const usable = Array.isArray(sections)
    ? sections.filter((section) => section?.name
      && typeof section.text === 'string' && section.text.length > 0)
    : []
  const assembled = usable.length > 0
    ? usable.map((section) => section.text).join('\n\n')
    : persona
  const supplied = Array.isArray(suppliedSkillText)
    ? suppliedSkillText.filter((text) => typeof text === 'string' && text.trim().length > 0)
    : []

  if (supplied.length === 0) {
    return {
      system: assembled,
      mode: INSTRUCTION_MODES.NATIVE,
      modeLabel: 'native automatic skill activation — the system prompt is the agent\'s own '
        + 'assembled sections; skill bodies are NOT appended by the runner',
      sectionNames: usable.map((section) => section.name),
      suppliedSkills: [],
    }
  }
  return {
    system: `${assembled}\n\n--- explicitly supplied skill text (not native activation) ---\n`
      + `${supplied.join('\n\n---\n\n')}\n--- end supplied skill text ---`,
    mode: INSTRUCTION_MODES.SUPPLIED,
    modeLabel: `explicitly supplied skill text (${suppliedSkillNames.join(', ') || 'unnamed'}) — `
      + 'this run is NOT evidence about native automatic skill activation',
    sectionNames: usable.map((section) => section.name),
    suppliedSkills: suppliedSkillNames,
  }
}

/**
 * Offline assertion: is the exact table-finishing guidance in the input we are about to send?
 *
 * Runs against the real system prompt and user message, so "the skills are installed" can never
 * stand in for "the instructions were in the request".
 *
 * @returns problems — empty when every marker is present in the input.
 */
export function instructionSurfaceProblems({ system = '', userMessage = '' }) {
  const input = `${system}\n${userMessage}`
  const missing = TABLE_FINISHING_MARKERS.filter((marker) => !input.includes(marker))
  if (missing.length === 0) return []
  return [`the instruction input is missing the table-finishing guidance marker(s) `
    + `${JSON.stringify(missing)}; without them the model is not told where to edit the wide table, `
    + 'what markup to write, or that tabular markup must stay out of sections[].body']
}

/**
 * Parse a model's tool-call arguments without ever throwing.
 *
 * A truncated response produces truncated JSON. Executing it would mean acting on a partial
 * instruction the model never finished writing, so the caller records an INCOMPLETE turn instead.
 *
 * @returns `{ ok: true, args }` or `{ ok: false, reason }`.
 */
export function parseToolArguments(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: 'the tool call carried no argument text' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, reason: `the tool arguments are not parseable JSON (${error.message})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: `the tool arguments parsed to ${Array.isArray(parsed) ? 'an array' : typeof parsed}, not an object`,
    }
  }
  return { ok: true, args: parsed }
}

/**
 * Classify a finished turn from the reason the host actually reported — never from whether some
 * text happens to exist.
 *
 * The vocabulary is the host's own `FinishReasonMap`: `stop`, `tool-calls`, `max-tokens`,
 * `aborted`, `error`. Anything else, or nothing at all, is treated as unfinished: an unknown
 * finish must never be read as success.
 *
 * @param options.finish - the verbatim reason from the `finish` stream chunk.
 * @param options.finalText - text the model produced this turn.
 * @param options.artifactCreated - whether an artifact was actually created this turn.
 * @returns `{ status, reason }` with status `OBSERVED` | `INCOMPLETE` | `NO-RESPONSE` | `FAILED`.
 */
export function classifyTurnOutcome({ finish = null, finalText = '', artifactCreated = false } = {}) {
  const kind = finish?.kind ?? null
  const text = typeof finalText === 'string' ? finalText.trim() : ''

  if (kind === 'error' || kind === 'aborted') {
    return { status: 'FAILED', reason: `the host reported finish reason ${kind} — the request did not complete` }
  }
  if (kind === 'max-tokens') {
    return {
      status: 'INCOMPLETE',
      reason: 'the host reported finish reason max-tokens: the response was cut off by the output '
        + 'allowance, so any tool call it was building may be truncated',
    }
  }
  if (kind === 'tool-calls') {
    return {
      status: 'INCOMPLETE',
      reason: 'the host reported finish reason tool-calls: the model ended by requesting tool calls, '
        + 'so the turn never concluded',
    }
  }
  if (kind === null) {
    return { status: 'INCOMPLETE', reason: 'no finish reason was captured for this request' }
  }
  if (kind !== 'stop') {
    return {
      status: 'INCOMPLETE',
      reason: `unrecognized finish reason ${JSON.stringify(kind)} — treated as unfinished, never as success`,
    }
  }
  if (text.length === 0 && artifactCreated !== true) {
    return { status: 'NO-RESPONSE', reason: 'the host reported stop but produced no text and no artifact' }
  }
  return { status: 'OBSERVED', reason: 'the host reported stop and the turn produced output' }
}

/**
 * Collect the paths an `professor_artifact_create` result actually returned.
 *
 * Only `root`, `directory`, `files[].canonicalPath` / `files[].relative` are used. Nothing is
 * predicted from the requested title: `slugify()` truncates at 64 characters, so a 78-character
 * title yields a different directory than the one it reads like.
 *
 * @returns `{ paths, directory, problems }` — `paths` are absolute when `workspace` is given.
 */
export function artifactPathsFromCreate(result, { workspace = null } = {}) {
  const problems = []
  if (result === null || result === undefined || typeof result !== 'object') {
    return { paths: [], directory: null, problems: ['artifact_create returned no result object'] }
  }
  if (result.created !== true) {
    return {
      paths: [],
      directory: typeof result.directory === 'string' ? result.directory : null,
      problems: [`artifact_create did not create anything (created=${JSON.stringify(result.created)}, `
        + `problems=${JSON.stringify(result.problems ?? [])})`],
    }
  }
  const directory = typeof result.directory === 'string' ? result.directory : null
  const root = typeof result.root === 'string' ? result.root : null
  const paths = []
  const add = (value, source) => {
    if (typeof value !== 'string' || value.length === 0) return
    const absolute = workspace === null || path.isAbsolute(value) ? value : path.join(workspace, value)
    if (!paths.some((entry) => entry.path === absolute)) paths.push({ path: absolute, source })
  }
  for (const entry of Array.isArray(result.files) ? result.files : []) {
    if (typeof entry === 'string') add(root === null ? entry : path.join(root, entry), 'files[].relative')
    else if (typeof entry?.canonicalPath === 'string') add(entry.canonicalPath, 'files[].canonicalPath')
    else if (typeof entry?.relative === 'string') {
      add(root === null ? entry.relative : path.join(root, entry.relative), 'files[].relative')
    } else if (typeof entry?.path === 'string') add(entry.path, 'files[].path')
  }
  if (paths.length === 0 && directory !== null) {
    problems.push('artifact_create reported a directory but no file path')
  }
  if (paths.length === 0) problems.push('artifact_create returned no usable file path — nothing can be read back')
  return { paths, directory, problems }
}

/**
 * Judge what was actually delivered.
 *
 * A missing artifact is a **delivery failure**, not an invitation to grade the chat reply;
 * `TABLE_PLACEHOLDER` means the table was never written, so the artifact is **incomplete**; and an
 * empty INDEX registration list is not registration. Runner-written registration, model-written
 * output, compilation and visual acceptance stay separate facts — this reports them without
 * letting one imply another.
 *
 * @param options.createdPaths - paths actually read back from the tool's returned evidence.
 * @param options.contents - the text read from those paths.
 * @param options.indexRegistration - the INDEX registration list as recorded.
 * @param options.compiled - whether a PDF was produced through the production tool.
 * @param options.visuallyAccepted - whether inspection accepted the rendered PDF.
 * @returns `{ ok, problems, facts }`.
 */
export function assessDelivery({
  createdPaths = [], contents = [], indexRegistration = null, compiled = null, visuallyAccepted = null,
} = {}) {
  const problems = []
  const texts = contents.filter((text) => typeof text === 'string')

  if (createdPaths.length === 0 || texts.length === 0) {
    problems.push('no artifact was delivered: no model-created file could be read back, so this is '
      + 'a delivery failure and the chat reply must not be graded in its place')
  }
  const placeholders = texts.filter((text) => text.includes(TABLE_PLACEHOLDER))
  if (placeholders.length > 0) {
    problems.push(`the delivered artifact still contains ${TABLE_PLACEHOLDER}: the four-column table `
      + 'was never written, so the artifact is INCOMPLETE and cannot close FO-8')
  }
  const registration = Array.isArray(indexRegistration) ? indexRegistration : null
  if (registration === null) {
    problems.push('no INDEX registration list was recorded')
  } else if (registration.length === 0) {
    problems.push('the INDEX registration list is empty — an empty list is not successful registration')
  }

  return {
    ok: problems.length === 0,
    problems,
    facts: {
      artifact_delivered: createdPaths.length > 0 && texts.length > 0,
      table_placeholder_present: placeholders.length > 0,
      index_registered: registration !== null && registration.length > 0,
      runner_wrote_registration: registration !== null && registration.length > 0,
      compiled: compiled === true,
      visually_accepted: visuallyAccepted === true,
      note: 'runner-written registration, model-written output, compilation and visual acceptance '
        + 'are separate facts and none of them implies another',
    },
  }
}

/**
 * The tools one M2b attempt must be offered, in full.
 *
 * The five Professor tools retrieve and create; the two host tools read and edit the generated
 * output copy. Dropping either group reproduces the 2026-10-13 failure, where the finishing
 * instruction was unreachable because no file-edit tool was on offer.
 */
export const REQUIRED_M2B_TOOLS = [
  'professor_session_status', 'professor_state_read', 'professor_search',
  'professor_material_read', 'professor_artifact_create',
  'read', 'edit',
]

/**
 * Is the required table-finishing guidance actually available to this attempt?
 *
 * The answer differs by instruction mode, and the difference is the whole point:
 *
 * - **native** — the assembled system prompt is *expected* not to contain the skill bodies; the
 *   host loads one through its `skill` tool when the model asks. So the guidance counts as
 *   available when it is already in the input **or** when the `skill` tool is offered *and* the
 *   bodies the host resolves for this scope carry every marker. Offered-but-unreachable (no
 *   `skill` tool) and reachable-but-absent (no marker in any resolved body) are separate
 *   problems, because they fail for different reasons and need different fixes.
 * - **supplied-skill-text** — the runner pasted the bodies itself, so they must literally be in
 *   the input; anything else is the runner claiming to have supplied text it did not.
 *
 * Required-tool membership is checked in both modes.
 *
 * @param options.mode - `INSTRUCTION_MODES.NATIVE` or `INSTRUCTION_MODES.SUPPLIED`.
 * @param options.system - the system prompt actually built for the request.
 * @param options.userMessage - the user message actually built for the request.
 * @param options.resolvedSkillContents - bodies returned by the host's own skill registry.
 * @param options.offeredTools - the tool names this attempt will be given.
 * @returns `string[]` of problems; empty means ready.
 */
export function guidanceReadinessProblems({
  mode = INSTRUCTION_MODES.NATIVE,
  system = '',
  userMessage = '',
  resolvedSkillContents = [],
  offeredTools = [],
} = {}) {
  const problems = []

  const missing = REQUIRED_M2B_TOOLS.filter((name) => !offeredTools.includes(name))
  if (missing.length > 0) {
    problems.push(`the attempt is not offered the required tool(s) ${JSON.stringify(missing)}; `
      + `the offered set is ${JSON.stringify(offeredTools)}. The wide-table finishing workflow needs `
      + 'both the Professor retrieval/creation tools and the host read/edit tools — this is the gap '
      + 'that made the 2026-10-13 continuation unreachable.')
  }

  const input = `${system}\n${userMessage}`
  const inputMissing = TABLE_FINISHING_MARKERS.filter((marker) => !input.includes(marker))
  if (inputMissing.length === 0) return problems

  if (mode === INSTRUCTION_MODES.NATIVE) {
    if (!offeredTools.includes('skill')) {
      problems.push('native mode: the host `skill` tool is not offered, so the bundled skill '
        + 'bodies can never reach this attempt — the guidance is unreachable even though the '
        + 'registry resolves it. Listing six skill names in metadata is not those skills being read.')
      return problems
    }
    const bodies = resolvedSkillContents.filter((text) => typeof text === 'string').join('\n\n')
    const bodyMissing = TABLE_FINISHING_MARKERS.filter((marker) => !bodies.includes(marker))
    if (bodyMissing.length > 0) {
      problems.push('native mode: the table-finishing guidance marker(s) '
        + `${JSON.stringify(bodyMissing)} are neither in the assembled input nor in any skill body `
        + 'the host resolves for this scope, so the model is not told where to edit the wide table, '
        + 'what markup to write, or that tabular markup must stay out of sections[].body')
    }
    return problems
  }

  return [...problems, ...instructionSurfaceProblems({ system, userMessage })]
}

/**
 * Refuse a request that names an artifact path the runner predicted.
 *
 * `slugify()` truncates a title at 64 characters, so a path assembled from the full requested
 * title does not exist — the 2026-10-13 continuation was told to edit exactly such a path and the
 * read failed. Only paths the tool itself returned may be used, so no predicted path may appear in
 * the instruction at all.
 *
 * @returns `string[]` of problems; empty means the request names no predicted path.
 */
export function requestTextProblems({ text = '', workspace = '' } = {}) {
  if (typeof workspace !== 'string' || workspace.length === 0) return []
  const notesRoot = path.join(workspace, '.professor', 'notes')
  if (typeof text !== 'string' || !text.includes(notesRoot)) return []
  return [`the model request names ${notesRoot}, a path derived from a title rather than returned by `
    + 'a tool: slugify truncates at 64 characters, so the predicted path may not exist. Only the '
    + 'root/directory/files a tool actually returned may be used.']
}
