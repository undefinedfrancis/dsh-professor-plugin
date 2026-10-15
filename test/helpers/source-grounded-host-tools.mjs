/**
 * Discovery and probing of the **real host's** filesystem tools, for the N2 retest preflight.
 *
 * The repaired notes/LaTeX instructions tell the model to finish a wide table by editing the
 * generated `content.tex` of its own new artifact copy. `run-model.mjs` offered only
 * `professor_*` tools, so that instruction was unreachable — the model was being graded against a
 * workflow it had no tool for. This module finds the host capability that already exists and
 * checks what it is actually allowed to touch, before any paid request is made.
 *
 * The tools are the host's, not this plugin's. `@deepseek-ai/dsh-tool-fs` registers `read`,
 * `write` and `edit` into the preset scope; the preset mounts it (`tools/verify-preset.mjs` asserts
 * the row), and `tools/verify-packaged-acceptance.mjs` asserts the same three names among the
 * children that must activate. Nothing here registers a substitute: if the real tools are not
 * visible, the answer is a blocked step, never a runner-authored edit wearing a tool's name.
 *
 * Probes never trust a tool's own verdict. Each one hashes the target before and after, so
 * "refused" means the bytes did not move, and a write that succeeded while reporting an error is
 * still recorded as a write.
 *
 * @module test/helpers/source-grounded-host-tools
 */

/** The host package that owns `read` / `write` / `edit`. */
export const HOST_FS_PACKAGE = '@deepseek-ai/dsh-tool-fs'

/** Host tools this block's workflow needs: read the generated file, then edit that output copy. */
export const OFFERED_FS_TOOLS = ['read', 'edit']

/** Every host filesystem tool, so the record shows the full set and which subset is offered. */
export const ALL_HOST_FS_TOOLS = ['read', 'write', 'edit']

/**
 * Parameter contracts taken from the installed package, not from memory.
 *
 * `read`: `file_path` (required), `offset`, `limit`.
 * `write`: `file_path`, `content` (required).
 * `edit`: `file_path`, `old_string`, `new_string` (required), `replace_all`.
 */
export const EXPECTED_PARAMETERS = {
  read: { required: ['file_path'], optional: ['offset', 'limit'] },
  write: { required: ['file_path', 'content'], optional: [] },
  edit: { required: ['file_path', 'old_string', 'new_string'], optional: ['replace_all'] },
}

/** Names that must never be added to close this gap — a broad shell is not a scoped file edit. */
export const FORBIDDEN_SUBSTITUTES = ['bash', 'shell', 'run_command', 'execute', 'terminal']

/**
 * What the live tool registry actually exposes for the host filesystem tools.
 *
 * @param ctx - the booted host context.
 * @param agent - the agent scope the preset was selected on.
 */
export function discoverHostFsTools(ctx, agent) {
  let visible
  try {
    visible = ctx.get('tools').view(agent)?.visible
  } catch (error) {
    return {
      package: HOST_FS_PACKAGE,
      discovered: false,
      reason: `tool registry unavailable: ${error?.message ?? String(error)}`,
      tools: {},
    }
  }
  if (!(visible instanceof Map)) {
    return {
      package: HOST_FS_PACKAGE, discovered: false, reason: 'no visible tool map on this scope', tools: {},
    }
  }

  const tools = {}
  for (const name of ALL_HOST_FS_TOOLS) {
    const descriptor = visible.get(name)
    tools[name] = descriptor === undefined
      ? { name, visible: false }
      : {
        name,
        visible: true,
        description: typeof descriptor.description === 'string' ? descriptor.description : null,
        parameters: descriptor.parameters ?? null,
      }
  }
  const offered = OFFERED_FS_TOOLS.filter((name) => tools[name]?.visible === true)
  const missing = OFFERED_FS_TOOLS.filter((name) => tools[name]?.visible !== true)
  return {
    package: HOST_FS_PACKAGE,
    discovered: missing.length === 0,
    offered,
    missing,
    tools,
    note: 'names and schemas are read from the live registry on the preset scope, which is what a '
      + 'model turn would see',
  }
}

/** Does a live descriptor accept the parameters the workflow needs? */
export function checkParameters(descriptor, expected) {
  const schema = descriptor?.parameters
  const properties = schema?.properties ?? schema?.schema?.properties ?? null
  if (properties === null || typeof properties !== 'object') {
    return { ok: false, reason: 'descriptor exposes no parameter schema to check against' }
  }
  const present = new Set(Object.keys(properties))
  const missingRequired = expected.required.filter((name) => !present.has(name))
  const missingOptional = expected.optional.filter((name) => !present.has(name))
  return {
    ok: missingRequired.length === 0,
    missing_required: missingRequired,
    missing_optional: missingOptional,
    declared: [...present].sort(),
  }
}

/**
 * Attempt one scoped edit and report what actually happened to the bytes.
 *
 * The host enforces an **fs-observation-policy**: `edit` refuses a file that has not been read in
 * this session ("file has not been read — read the file, then retry"). A probe that jumps straight
 * to `edit` therefore learns nothing about writability — every target fails identically, and a
 * refusal that comes from the observation policy reads exactly like one that comes from path
 * policy. So each probe reads first, exactly as the model is instructed to, and records whether
 * that read succeeded; a verdict drawn without a successful read is reported as *inconclusive*
 * rather than as protection.
 *
 * @param options.execute - `(name, args) => Promise<result>` — the real registry pipeline.
 * @param options.hashOf - `(path) => Promise<string|null>` — independent digest; `null` when absent.
 */
export async function probeEdit({ label, execute, hashOf, filePath, oldString, newString }) {
  const before = await hashOf(filePath)

  let readResult = null
  let readError = null
  try {
    readResult = await execute('read', { file_path: filePath })
  } catch (thrown) {
    readError = thrown?.message ?? String(thrown)
  }
  const readIsError = readResult?.isError === true
  const readText = (readResult?.content ?? []).map((part) => part?.text ?? '').join('\n').trim()
  const readSucceeded = readError === null && readIsError === false

  let result = null
  let error = null
  if (readSucceeded) {
    try {
      result = await execute('edit', {
        file_path: filePath, old_string: oldString, new_string: newString,
      })
    } catch (thrown) {
      error = thrown?.message ?? String(thrown)
    }
  }
  const after = await hashOf(filePath)
  const isError = result?.isError === true
  const text = (result?.content ?? []).map((part) => part?.text ?? '').join('\n').trim()
  const bytesChanged = before !== null && after !== null && before !== after

  return {
    label,
    file_path: filePath,
    attempted: true,
    read_first: {
      attempted: true,
      isError: readIsError,
      succeeded: readSucceeded,
      error: readError ?? (readIsError ? readText.slice(0, 300) : null),
    },
    // Without a successful read the edit is never attempted, so `null` — not false — records that
    // no writability verdict exists.
    isError: readSucceeded ? isError : null,
    error: readSucceeded
      ? (error ?? (isError ? text.slice(0, 300) : null))
      : `edit not attempted: the preceding read failed (${readError ?? readText.slice(0, 160)})`,
    reported_success: readSucceeded && isError === false && error === null,
    bytes_changed: bytesChanged,
    // The only trustworthy verdict: did the file move? A tool that reports success without
    // writing, or writes while reporting an error, is caught here rather than believed.
    write_allowed: bytesChanged,
    write_blocked: readSucceeded && !bytesChanged,
    inconclusive: !readSucceeded,
    sha256_before: before,
    sha256_after: after,
  }
}

/**
 * The three preflight probes this block needs, in the order the brief states them.
 *
 * Each target is a **text** file placed inside the directory under test, so a refusal can only come
 * from policy — never from an "unsupported file type" error that would masquerade as protection.
 *
 * @param options.outputCopy - a text file inside the artifact copy the model would finish.
 * @param options.sourceProbe - a text file inside the source's own directory.
 * @param options.otherCourseProbe - a text file inside a different course's directory.
 */
export async function probeFsBoundaries({ execute, hashOf, outputCopy, sourceProbe, otherCourseProbe }) {
  const outputs = {}
  outputs.output_copy_edit = await probeEdit({
    label: 'edit inside the newly created output copy',
    execute, hashOf,
    filePath: outputCopy.path,
    oldString: outputCopy.sentinel,
    newString: `${outputCopy.sentinel} -- finished by the model's scoped edit`,
  })
  outputs.source_directory_edit = await probeEdit({
    label: "edit inside the source's own directory",
    execute, hashOf,
    filePath: sourceProbe.path,
    oldString: sourceProbe.sentinel,
    newString: `${sourceProbe.sentinel} -- must never happen`,
  })
  outputs.other_course_edit = await probeEdit({
    label: "edit inside another course's directory",
    execute, hashOf,
    filePath: otherCourseProbe.path,
    oldString: otherCourseProbe.sentinel,
    newString: `${otherCourseProbe.sentinel} -- must never happen`,
  })
  // Recorded so a reader can see what each edit actually matched on. A sentinel that is not in the
  // target makes `edit` fail with "old_string was not found", which is indistinguishable from a
  // policy refusal unless the probe says which text it tried.
  outputs.sentinels = {
    output_copy: outputCopy.sentinel,
    source_directory: sourceProbe.sentinel,
    other_course: otherCourseProbe.sentinel,
  }
  return outputs
}

/**
 * The verdict the readiness report carries, and the gate the paid path reads.
 *
 * A blocked step is a blocked step: the runner must not invent an equivalent, and must not proceed
 * to a paid request on the strength of a note that says "the model could have used bash".
 *
 * Write-boundary failures may be **waived**, but only by an explicit decision record naming this
 * block — never by default, and never silently: a waived problem is moved into `waivers_applied`
 * with the control that stands in for it, and `problems` keeps only what is still unmet. The
 * output-copy edit is **not waivable**: if the finishing step does not work, the workflow the
 * instructions describe does not exist, and no amount of acceptance changes that.
 *
 * @param options.acceptedRisks - risk ids a human decision has accepted, e.g.
 *   `['source_directory_writable', 'other_course_directory_writable']`.
 * @param options.waiver - the decision record, echoed back into the result for audit.
 */
/**
 * Every probe the gate requires, and what a conclusive answer to it would establish.
 *
 * All three are required: the finishing step, the source's own directory, and another course's.
 * A boundary nobody probed is a boundary nobody knows about, so it can be neither reported as
 * protected nor accepted as writable.
 *
 * @type {Array<[string, string]>}
 */
const REQUIRED_PROBES = [
  ['output_copy_edit', 'whether the finishing step is exercisable'],
  ['source_directory_edit', "whether the source's own directory is writable"],
  ['other_course_edit', "whether another course's directory is writable"],
]

/**
 * Classify one recorded probe before anything at all is concluded from it.
 *
 * - `missing` — nothing was attempted. Absence is not a verdict in either direction: it is not
 *   protection, and it is not an observed writable boundary that a waiver could accept.
 * - `malformed` — a record exists but its evidence cannot support a verdict: no attempt, no
 *   read-before-edit result, no byte outcome, digests that are not usable SHA-256 values, a claim of
 *   conclusiveness the rest of the record does not support, or a `bytes_changed` flag that
 *   **contradicts** its own before/after digests. The digests are the evidence and the flag is a
 *   claim about them, so a disagreement between the two is reported as a contradiction — in either
 *   direction, without rewriting the claim to make it agree.
 * - `inconclusive` — the read the observation policy demands failed, so the edit was never tried.
 *   Reported as an absence of a verdict, never as protection.
 * - `conclusive` — a complete record whose before/after digests say whether the bytes moved.
 *
 * @param entry - a probe record as `probeEdit` writes it, or whatever the caller passed.
 * @returns {{status: string, entry: object|null, reasons: string[]}}
 */
function classifyProbe(entry) {
  if (entry === null || entry === undefined) return { status: 'missing', entry: null, reasons: [] }
  if (typeof entry !== 'object' || Array.isArray(entry)) {
    return { status: 'malformed', entry: null, reasons: ['the record is not a probe result'] }
  }
  // Inconclusive is checked first: a failed read is an honest "no verdict" rather than a damaged
  // record, and the report keeps naming it as such.
  if (entry.inconclusive === true) {
    return {
      status: 'inconclusive',
      entry,
      reasons: ['the preceding read failed, so no writability verdict exists'],
    }
  }
  // A digest is only evidence a reader can act on if it is a complete hexadecimal SHA-256 value.
  const usableDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)

  const reasons = []
  if (entry.attempted !== true) reasons.push('no attempt is recorded')
  if (entry.read_first === null || typeof entry.read_first !== 'object') {
    reasons.push('no read-before-edit result is recorded')
  } else if (entry.read_first.succeeded !== true) {
    reasons.push('the read-before-edit did not succeed')
  }
  if (typeof entry.bytes_changed !== 'boolean') reasons.push('no byte outcome is recorded')
  const beforeUsable = usableDigest(entry.sha256_before)
  const afterUsable = usableDigest(entry.sha256_after)
  if (!beforeUsable) reasons.push('the recorded before-digest is not a usable SHA-256 value')
  if (!afterUsable) reasons.push('the recorded after-digest is not a usable SHA-256 value')

  // The digests are the observation; `bytes_changed` is a claim about them. When the claim and the
  // digests disagree the record contradicts itself, and neither half may be believed: a claimed
  // change with identical digests would report a write that never happened (including a "working"
  // finishing step), and a claimed non-change with differing digests would read a written source
  // directory as protected. The claim is reported, never rewritten to fit, and never waived.
  if (typeof entry.bytes_changed === 'boolean' && beforeUsable && afterUsable) {
    const digestsMatch = entry.sha256_before.toLowerCase() === entry.sha256_after.toLowerCase()
    if (entry.bytes_changed === true && digestsMatch) {
      reasons.push('bytes_changed is true but the before/after digests are identical — '
        + 'contradictory evidence')
    } else if (entry.bytes_changed === false && !digestsMatch) {
      reasons.push('bytes_changed is false but the before/after digests differ — '
        + 'contradictory evidence')
    }
  }

  if (entry.inconclusive !== false) reasons.push('the record does not state that it was conclusive')
  if (reasons.length > 0) return { status: 'malformed', entry, reasons }
  return { status: 'conclusive', entry, reasons: [] }
}

/**
 * The verdict the readiness report carries, and the gate the paid path reads.
 *
 * A blocked step is a blocked step: the runner must not invent an equivalent, and must not proceed
 * to a paid request on the strength of a note that says "the model could have used bash".
 *
 * **All three probes must exist and be conclusive.** A probe that never ran, or whose record cannot
 * support a verdict, is reported as a problem and stays a problem: absence is never read as
 * protection and never as an accepted writable boundary. Only a boundary that was actually
 * observed — bytes moved, before and after digests recorded — can be waived at all.
 *
 * Write-boundary failures may be **waived**, but only by a decision record that names this block
 * and names the risk being accepted — never by default, never by a bare accepted-risk list, and
 * never silently: a waived problem is moved into `waivers_applied` with the control that stands in
 * for it, and `problems` keeps only what is still unmet. The output-copy edit is **not waivable**: if
 * the finishing step does not work, the workflow the instructions describe does not exist, and no
 * amount of acceptance changes that. Neither is a missing or inconclusive probe waivable, because
 * there is no observed boundary there to accept.
 *
 * @param options.acceptedRisks - risk ids the caller believes a human decision has accepted, e.g.
 *   `['source_directory_writable', 'other_course_directory_writable']`.
 * @param options.waiver - the decision record itself. It must carry a `decision`, a `decided_by`,
 *   and an `accepted_risks` list containing the risk; without all three the acceptance clears
 *   nothing, because nothing trustworthy evidences a human decision behind it.
 */
export function assessFsReadiness(discovery, probes, { acceptedRisks = [], waiver = null } = {}) {
  const accepted = new Set(acceptedRisks)
  const problems = []
  const waiversApplied = []
  const hasDecisionRecord = waiver !== null && waiver !== undefined
    && typeof waiver.decision === 'string' && waiver.decision.trim() !== ''
    && typeof waiver.decided_by === 'string' && waiver.decided_by.trim() !== ''

  // A waiver may accept only a named, actually observed writable boundary. Everything else — a
  // missing probe, an inconclusive one, the finishing step — never reaches this function, so it
  // cannot be waived by any record.
  const waive = (riskId, text) => {
    if (!accepted.has(riskId)) {
      problems.push(text)
      return
    }
    let unsupported = null
    if (!hasDecisionRecord) {
      unsupported = 'no decision record accompanies this acceptance'
    } else if (!Array.isArray(waiver.accepted_risks) || !waiver.accepted_risks.includes(riskId)) {
      unsupported = 'the decision record does not name this risk'
    } else if (Array.isArray(waiver.not_accepted) && waiver.not_accepted.includes(riskId)) {
      unsupported = 'the decision record explicitly does not accept it'
    }
    if (unsupported !== null) {
      problems.push(`${text} — listed as accepted, but ${unsupported}, so there is no trustworthy `
        + 'evidence of a human decision behind the acceptance')
      return
    }
    waiversApplied.push({ risk: riskId, problem: text, waived_by: waiver.decision })
  }

  if (discovery.discovered !== true) {
    problems.push(
      `host filesystem tools are not usable on the preset scope`
      + `${discovery.reason ? ` (${discovery.reason})` : ''}`
      + `${discovery.missing?.length ? ` — missing: ${discovery.missing.join(', ')}` : ''}`,
    )
  }
  // Descriptors are validated individually rather than inferred from `discovered`. A scope that
  // claims discovery while not actually exposing one of the offered tools must not pass on that
  // claim alone.
  for (const name of OFFERED_FS_TOOLS) {
    const descriptor = discovery.tools?.[name]
    if (descriptor?.visible !== true) {
      problems.push(`${name}: the preset scope exposes no visible descriptor for this offered tool, `
        + 'so its contract cannot be validated')
      continue
    }
    const check = checkParameters(descriptor, EXPECTED_PARAMETERS[name])
    if (check.ok !== true) {
      problems.push(`${name}: ${check.reason ?? `missing required parameters ${check.missing_required.join(', ')}`}`)
    }
  }

  // Every required probe is classified before anything is concluded from it. An inconclusive probe
  // is not evidence of anything, and a probe that never ran is not evidence either: the observation
  // policy makes every target look unwritable when a probe forgets to read first, so reporting either
  // as protection would be exactly the false reassurance this module exists to prevent.
  const verdicts = {}
  for (const [key, meaning] of REQUIRED_PROBES) {
    const verdict = classifyProbe(probes?.[key] ?? null)
    verdicts[key] = verdict
    if (verdict.status === 'missing') {
      problems.push(key === 'output_copy_edit'
        // Nothing has even been attempted, so the finishing step is simply unexercised and must be
        // named as such.
        ? 'the scoped edit inside the new output copy was never probed — the finishing step '
          + 'the instructions require is not exercisable'
        : `probe for ${key} was never run (${meaning}) — nothing was observed, and absence is `
          + 'neither a protected boundary nor an accepted one')
    } else if (verdict.status === 'malformed') {
      problems.push(`probe for ${key} is malformed (${meaning}): ${verdict.reasons.join('; ')} — `
        + 'its evidence cannot support a boundary verdict')
    } else if (verdict.status === 'inconclusive') {
      problems.push(`probe for ${key} is inconclusive (${meaning}): the preceding read failed, so no `
        + 'writability verdict exists')
    }
  }

  const outputCopy = verdicts.output_copy_edit
  if (outputCopy.status === 'conclusive' && outputCopy.entry.bytes_changed !== true) {
    // Never waivable: without this the workflow under test does not exist.
    problems.push('the scoped edit inside the new output copy did not succeed — the finishing step '
      + 'the instructions require is not exercisable')
  }

  // Only a probe whose bytes actually moved raises a write-boundary risk. A refused edit is not a
  // finding, and must not become one just because a waiver mechanism now exists; nor may a probe
  // that never ran or that cannot support a verdict.
  const raises = (key, riskId, text) => {
    const verdict = verdicts[key]
    if (verdict.status !== 'conclusive' || verdict.entry.bytes_changed !== true) return
    waive(riskId, text)
  }
  raises('source_directory_edit', 'source_directory_writable',
    "the source's own directory is writable through the host filesystem tool")
  raises('other_course_edit', 'other_course_directory_writable',
    "another course's directory is writable through the host filesystem tool")

  return {
    ready_for_paid_run: problems.length === 0,
    problems,
    offered: discovery.offered ?? [],
    inconclusive_probes: Object.entries(probes ?? {})
      .filter(([, entry]) => entry?.inconclusive === true)
      .map(([key]) => key),
    waivers_applied: waiversApplied,
    waiver: waiver === null ? null : {
      decision: waiver.decision ?? null,
      decided_by: waiver.decided_by ?? null,
      decided_at: waiver.decided_at ?? null,
      compensating_control: waiver.compensating_control ?? null,
      not_accepted: waiver.not_accepted ?? [],
      authority_note: waiver.authority_note ?? null,
    },
  }
}
