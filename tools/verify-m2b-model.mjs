/**
 * Gated model-driven runner for N2 — source-grounded note delivery (2026-10-12).
 *
 * Two modes, deliberately separated by a flag rather than by a comment:
 *
 *   node run-model.mjs
 *       ZERO paid requests. Boots a disposable profile, packs and installs the plugin into it,
 *       creates the synthetic course project, registers and indexes the source, captures the
 *       instruction surface, and records readiness. Every model case stays `NOT RUN`.
 *
 *   node run-model.mjs --allow-model-calls
 *       Executes M1–M7. Refuses to start unless ALL of the following hold:
 *         1. `evidence.json` exists, belongs to this block, and its deterministic checks are green
 *            (`assertPrepared`) — the local evidence checks gate the model, not the other way round;
 *         2. `authorization.json` names THIS block, carries a human statement, a positive integer
 *            budget, and a `granted_at` no earlier than preparation (`assertAuthorized`) — a prior
 *            phase's approval, the teaching counter, or silence is not authority;
 *         3. `counter.json` still has budget left.
 *       Every **attempt** is charged to `counter.json` and persisted **before** the request is
 *       made, so a crash or a restart can never silently reuse budget. `retryPolicy.maxRetries`
 *       is 0: a failed request is recorded as a failure and is not retried into a pass.
 *
 * Evidence rules: the model's final responses and every tool result are stored **verbatim**;
 * nothing is edited before grading. Anything computed here is labelled `derived_by`.
 *
 * Usage:
 *   node docs/qa/2026-10-12-source-grounded-notes/run-model.mjs
 *   node docs/qa/2026-10-12-source-grounded-notes/run-model.mjs --allow-model-calls
 *
 * @module docs/qa/2026-10-12-source-grounded-notes/run-model
 */

import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createProfessorProfile, bootProfessorProfile, createNativeSession, selectPreset,
  sessionSurface, executeTool, loadHarness, resultText, resultJson,
} from './packaged-profile.mjs'
import {
  AuthorizationError, RequestBudget, assertAuthorized, assertPrepared,
} from '../test/helpers/source-grounded-gate.mjs'
import { gradeNote } from '../test/helpers/source-grounded-grading.mjs'
import { gradingContextFromDelivery } from '../test/helpers/source-grounded-retrieval.mjs'
import {
  assessFsReadiness, discoverHostFsTools, probeFsBoundaries, OFFERED_FS_TOOLS,
} from '../test/helpers/source-grounded-host-tools.mjs'
// The course setup and its preflight are shared with the zero-cost preparation and the regression
// suite, so the formal runner cannot drift from what was actually tested.
import {
  runCourseSetup, verifyCourseMaterial,
} from '../test/helpers/m2b-course-setup.mjs'
// The input-surface, output-limit, turn-classification, returned-path and delivery decisions are
// pure functions with their own offline tests, so the executor that will spend money cannot drift
// from what was asserted without a request.
import {
  ARTIFACT_TOKEN_ALLOWANCE, INSTRUCTION_MODES, REQUIRED_M2B_TOOLS, artifactPathsFromCreate,
  assessDelivery, buildInstructionSurface, classifyTurnOutcome, guidanceReadinessProblems,
  parseToolArguments, requestTextProblems, normalizeInstructionMode, validateToolBatch,
  consumeModelStream, artifactGradingText, compilationFactsForCase,
} from '../test/helpers/m2b-run-config.mjs'
import {
  BLOCK_ID, COURSE_CODE, COURSE_ID, SOURCE_RELATIVE_PATH, buildSourcePdf,
} from '../test/helpers/source-grounded-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.argv.includes('--help')) {
  console.log('Usage: node tools/verify-m2b-model.mjs --evidence-dir=<prepared-run-directory> [--readiness-out=<new-file>] [--instruction-mode=native|supplied-skill-text] [--only=M2b] [--allow-model-calls]')
  process.exit(0)
}
const evidenceDirArg = process.argv.find((arg) => arg.startsWith('--evidence-dir='))
if (!evidenceDirArg || !evidenceDirArg.slice('--evidence-dir='.length)) {
  throw new Error('--evidence-dir is required; use a new prepared run directory and preserve historical evidence')
}
const DIR = path.resolve(evidenceDirArg.slice('--evidence-dir='.length))
const EVIDENCE_PATH = path.join(DIR, 'evidence.json')
const AUTH_PATH = path.join(DIR, 'authorization.json')
const COUNTER_PATH = path.join(DIR, 'counter.json')
// Overridable so a later zero-cost run can preserve the original readiness record beside itself
// instead of overwriting evidence a report already cites. The default is unchanged.
const readinessOutArg = process.argv.find((arg) => arg.startsWith('--readiness-out='))
const READINESS_PATH = readinessOutArg === undefined
  ? path.join(DIR, 'model-readiness.json')
  : path.resolve(readinessOutArg.slice('--readiness-out='.length))
if (await fs.stat(READINESS_PATH).catch(() => null)) {
  throw new Error('readiness output already exists; pass --readiness-out=<new-file> to preserve prior evidence')
}
/** A human decision record for the write-boundary finding; not an authorization to spend. */
const FS_DECISION_PATH = path.join(DIR, 'fs-boundary-decision.json')
const MODEL_REPORT_PATH = path.join(DIR, 'model-report.json')
const DERIVED_BY = 'run-model.mjs — node:crypto sha256 + fs.stat, independent of tool output'

const paidMode = process.argv.includes('--allow-model-calls')
// Which instruction surface this run sends. `native` is the default and the only mode that can say
// anything about native automatic skill activation; `supplied-skill-text` pastes the bundled bodies
// into the prompt itself and is labelled as a different test everywhere it is recorded, because it
// proves nothing about whether the host would have loaded them.
const modeArg = process.argv.find((arg) => arg.startsWith('--instruction-mode='))
const requestedInstructionMode = normalizeInstructionMode(modeArg === undefined
  ? 'native' : modeArg.slice('--instruction-mode='.length))
// A second grant must not re-spend what the first grant already bought: `--only=M2` runs just
// that case and marks the rest NOT-INCLUDED, exactly as the teaching runner does.
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='))
const only = onlyArg === undefined ? null : onlyArg.slice('--only='.length).split(',').filter(Boolean)

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** Recursive `{ relativePath: { bytes, sha256 } }`; a missing directory is `{}`. */
async function hashTree(rootDir) {
  const out = {}
  const walk = async (dir, prefix) => {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(abs, rel)
      else if (entry.isFile()) {
        const buffer = await fs.readFile(abs)
        out[rel] = { bytes: buffer.byteLength, sha256: sha256(buffer) }
      }
    }
  }
  await walk(rootDir, '')
  return out
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))
const writeJson = async (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)

/**
 * The M2b table requirement, stated as a deliverable rather than a recipe.
 *
 * It is a named constant rather than an inline argument so the pre-request readiness gate can
 * assert against the exact text the model will receive — a gate that checked a different string
 * would certify an input nobody sends. Nothing here names a filesystem path: only the paths a tool
 * returns may be used, and `slugify()` truncates a title at 64 characters.
 */
const M2B_TABLE_REQUIREMENTS = `- The note must reproduce the source's Table 1 (the average probe-count table on its page) as a
  **typeset table**, not as prose or as literal markup: four column labels, four rows of schemes, and
  every numeric cell the source states, all present on the rendered page.
- Reproduce all four column labels and all four rows exactly as the source gives them; do not drop a
  column, merge rows or round a value.
- Cite the table's page in the same place the table appears.`

/**
 * The model-facing request for one note.
 *
 * The format is stated **in this request** — a saved default or a previous choice is not a format
 * choice — and the labelling contract is stated alongside it so the grader can separate what the
 * source says from what the model added without having to guess.
 */
function noteRequest(format, extraRequirements = '') {
  const formatName = format === 'latex' ? 'LaTeX' : 'Markdown'
  const extra = extraRequirements.trim().length > 0
    ? `\n\nAdditional requirements for this note:\n${extraRequirements.trim()}\n`
    : ''
  return `Write a source-grounded study note for the course ${COURSE_CODE} (${COURSE_ID}) about
collision resolution and resize thresholds, in **${formatName}** format.${extra}

Grounding contract — all three are mandatory:
1. Every claim taken from the material must be followed by a citation of exactly this shape:
   [source: <file_id>, page <N>]
   using the file id and physical page number of the source you actually retrieved.
2. Label every passage as exactly one of:
   - 材料原文引用  (direct quotation or close restatement of the source)
   - 推断          (your own explanation or inference, not stated in the source)
   - 补充          (an example or exercise you supply yourself, not in the source)
3. The source contains an explicitly labelled uncertainty. Do not state those figures as
   established fact; carry the uncertainty through.

Never cite a page you did not retrieve, never name a course or a source file other than the one
bound to this session, and if you cannot produce a page number for a claim, say so rather than
inventing one.`
}

// ------------------------------------------------------------------ gates ----

async function refuse(message) {
  console.error(`NOT RUN: ${message}`)
  process.exitCode = 2
}

/** Gate 1 — deterministic preparation must be green before anything else is considered. */
async function loadPreparedEvidence() {
  const evidence = await readJson(EVIDENCE_PATH).catch(() => null)
  try {
    return assertPrepared(evidence, { blockId: BLOCK_ID })
  } catch (error) {
    if (error instanceof AuthorizationError) {
      await refuse(error.message)
      return null
    }
    throw error
  }
}

/** Resolve the currently configured model route read-only from the real desktop profile. */
async function resolveRoute() {
  const actualHome = process.env.DSH_REAL_HOME ?? path.join(os.homedir(), '.dsh')
  const { parse } = await loadHarness('yaml/dist/index.js')
  const patches = parse(await fs.readFile(path.join(actualHome, 'profiles/desktop/cordis.patch.yml'), 'utf8'))
  const entries = []
  const walk = (value) => {
    if (!value || typeof value !== 'object') return
    if (value.name) entries.push(value)
    for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child)
  }
  walk(patches)
  const selection = entries.find((entry) => entry.name === '@deepseek-ai/dsh-agent-default-model')?.config
  const llmConfig = entries.find((entry) => entry.name === '@deepseek-ai/dsh-llm-pi-ai')?.config
  if (!selection || !llmConfig?.providers?.[selection.provider]) {
    throw new Error('current model route could not be resolved from the real desktop profile (read-only)')
  }
  // Automatic retries are disabled on the route itself: a failed request is an observation.
  const route = { ...llmConfig.providers[selection.provider], retryPolicy: { mode: 'normal', maxRetries: 0 } }
  return { selection, route, actualHome }
}

// ------------------------------------------------------------------ main ----

async function main() {
  const evidence = await loadPreparedEvidence()
  if (evidence === null) return

  const readiness = {
    block: BLOCK_ID,
    mode: paidMode ? 'paid (model calls authorized)' : 'zero-cost readiness (no paid request)',
    generated_at: new Date().toISOString(),
    paid_requests: 0,
    model_calls: 0,
    real_profile_written: false,
    dependencies_installed: 'none global — npm install runs only into the disposable profile with an isolated npm cache',
    preparation_evidence: {
      path: EVIDENCE_PATH,
      checks_all_passed: evidence.checks.all_passed,
      prepared_at: evidence.prepared_at,
    },
    stages: {},
    cases: {
      M1_source_grounded_markdown_note: 'NOT RUN',
      M2_source_grounded_latex_note: 'NOT RUN',
      M2b_source_grounded_latex_note_with_wide_table: 'NOT RUN',
      M3_claim_grading_against_answer_key: 'NOT RUN',
      M4_artifact_readback_and_index_registration: 'NOT RUN',
      M5_source_and_artifact_preservation: 'NOT RUN',
      M6_latex_compile_through_production_tool: 'NOT RUN',
      M7_visual_inspection_bound_to_pdf_hash: 'NOT RUN',
    },
  }
  const persistReadiness = () => writeJson(READINESS_PATH, readiness)

  let authorization = null
  let budget = null
  let counter = null

  if (paidMode) {
    // ---- gate 2: fresh, block-scoped, numeric human authorization -----------------------
    const grant = await readJson(AUTH_PATH).catch(() => null)
    try {
      authorization = assertAuthorized(grant, { blockId: BLOCK_ID, preparedAt: evidence.prepared_at })
    } catch (error) {
      if (error instanceof AuthorizationError) {
        await refuse(`${error.message}\nProvide ${AUTH_PATH}.`)
        return
      }
      throw error
    }
    // ---- gate 3: a persisted counter with budget left -----------------------------------
    counter = await readJson(COUNTER_PATH).catch(() => null)
    if (counter === null || counter.block !== BLOCK_ID) {
      counter = {
        block: BLOCK_ID,
        grants: [],
        authorized_limit: 0,
        attempts: [],
        note: 'attempts are persisted BEFORE each request; a crash can never silently reuse budget. '
          + 'Every fresh grant is appended to `grants` and the limit is their sum, so an earlier '
          + 'grant can never be spent twice.',
      }
    }
    if (!Array.isArray(counter.grants)) {
      // First run of this ledger shape: fold the legacy single-grant fields into it, so the
      // first grant stays on the record rather than being silently replaced by the second.
      counter.grants = [{
        granted_at: counter.granted_at,
        budget: counter.authorized_limit,
        statement: 'legacy single-grant record from the first authorized run',
        granted_by: 'human',
      }]
    }
    const alreadyGranted = counter.grants.some((grant) => grant.granted_at === authorization.granted_at)
    if (!alreadyGranted) {
      counter.grants.push({
        granted_at: authorization.granted_at,
        budget: authorization.budget,
        statement: authorization.statement,
        granted_by: authorization.granted_by ?? 'human',
        recorded_at: new Date().toISOString(),
      })
    }
    counter.authorized_limit = counter.grants.reduce((sum, grant) => sum + (Number(grant.budget) || 0), 0)
    if (counter.attempts.length >= counter.authorized_limit) {
      await refuse(`request budget exhausted: ${counter.attempts.length}/${counter.authorized_limit} attempted`)
      return
    }
    await writeJson(COUNTER_PATH, counter)
    budget = new RequestBudget(counter.authorized_limit)
    budget.log = counter.attempts.slice()
    readiness.authorization = {
      block: authorization.block,
      grants: counter.grants,
      authorized_limit: counter.authorized_limit,
      attempts_so_far: counter.attempts.length,
      current_grant: {
        granted_at: authorization.granted_at,
        budget: authorization.budget,
        statement: authorization.statement,
      },
    }
  } else {
    readiness.authorization = {
      state: 'NOT GRANTED — this invocation makes no paid request',
      required: `a fresh human authorization in ${path.basename(AUTH_PATH)} naming ${BLOCK_ID} with a numeric budget`,
    }
  }

  // ---- route resolution (read-only, both modes) -------------------------------------------
  const { selection, route, actualHome } = await resolveRoute()
  readiness.route = { provider: selection.provider, model: selection.model }
  if (paidMode) {
    if (counter.route === undefined) {
      counter.route = { provider: selection.provider, model: selection.model }
      await writeJson(COUNTER_PATH, counter)
    } else if (counter.route.provider !== selection.provider || counter.route.model !== selection.model) {
      await refuse(`counter route ${JSON.stringify(counter.route)} does not match the configured route ${JSON.stringify(readiness.route)}`)
      return
    }
  }

  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'professor-source-grounding-model-')))
  let ctx = null
  try {
    const run = (cmd, args, options = {}) => execFileSync(cmd, args, {
      ...options,
      env: { ...process.env, npm_config_cache: path.join(temp, 'npm-cache') },
      stdio: 'pipe',
      timeout: 120_000,
    })

    readiness.stages.profile_install = 'running'
    await persistReadiness()
    run('npm', ['pack', '--pack-destination', temp], { cwd: root })
    const tarball = path.join(temp, (await fs.readdir(temp)).find((name) => name.endsWith('.tgz')))
    const profile = await createProfessorProfile({ home: temp, profileName: 'source-grounded', tarball, run })
    const { stringify } = await loadHarness('yaml/dist/index.js')
    await fs.writeFile(path.join(profile.profileDir, 'cordis.patch.yml'), stringify([
      { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { [selection.provider]: route } } },
      { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: selection },
    ]))
    readiness.stages.profile_install = 'done'
    readiness.stages.installed_plugin = profile.installedDir.slice(temp.length + 1)

    // ---- disposable workspace holding the actual synthetic source -----------------------
    const workspace = path.join(temp, 'workspace')
    const sourcePath = path.join(workspace, SOURCE_RELATIVE_PATH)
    await fs.mkdir(path.dirname(sourcePath), { recursive: true })
    const pdf = buildSourcePdf()
    await fs.writeFile(sourcePath, pdf)

    readiness.stages.profile_boot = 'running'
    await persistReadiness()
    const boot = await bootProfessorProfile({ home: temp, profileName: 'source-grounded', workspace })
    ctx = boot.ctx
    readiness.stages.profile_boot = 'done'

    if (paidMode) {
      const credentials = ctx.get('credentials')
      if (!credentials) throw new Error('host credential service is unavailable')
      const keyRef = route.apiKeyEnv
      const secrets = (await loadHarness('yaml/dist/index.js'))
        .parse(await fs.readFile(path.join(actualHome, '.credentials.yaml'), 'utf8'))
      const key = secrets.refs?.[keyRef]
      if (typeof key !== 'string' || key.length === 0) {
        await refuse(`the configured route has no readable existing credential reference for ${keyRef}`)
        return
      }
      const previous = credentials.resolve.bind(credentials)
      credentials.resolve = async (name) => (name === keyRef ? { value: key } : previous(name))
      readiness.stages.credential_binding = 'in-memory only; never written to any artifact'
    }

    // ---- genuine setup through the production tools -------------------------------------
    readiness.stages.course_setup = 'running'
    await persistReadiness()
    const setupSession = await createNativeSession({ ctx, sessionId: `n2-setup-${path.basename(temp)}`, workspace })
    await selectPreset({ ctx, agent: setupSession.agent })
    // The setup sequence is shared with the zero-cost preparation and the regression suite, so the
    // formal runner cannot drift from what was actually tested. `source_path` is part of it: a
    // course registered without it owns no material, the index record stays unassigned, and
    // course-scoped retrieval returns nothing — while every tool still reports success.
    const materialRoot = path.join(workspace, SOURCE_RELATIVE_PATH.split('/')[0])
    const execute = async (name, args) => {
      const result = await executeTool({ ctx, agent: setupSession.agent, name, args, label: `setup-${name}` })
      if (result?.isError === true) throw new Error(resultText(result))
      const payload = resultJson(result)
      if (payload === null) throw new Error(`tool ${name} returned no JSON payload`)
      return payload
    }
    const setupRun = await runCourseSetup({ execute, materialRoot, projectId: 'n2-term' })
    readiness.setup = setupRun.steps.map((step) => ({
      name: step.name, isError: step.isError, text: String(step.problem ?? '').slice(0, 300),
    }))
    readiness.stages.course_setup = setupRun.ok ? 'done' : 'failed'
    if (!setupRun.ok) {
      await persistReadiness()
      throw new Error('genuine setup tool failed: '
        + JSON.stringify(setupRun.steps.filter((step) => step.isError)))
    }

    // ---- preflight: read back what the setup actually produced ---------------------------
    //
    // Runs before any request is spent, in both modes. An `isError: false` envelope is not
    // evidence that the case has anything to ground against, so this reads the course list, the
    // session binding, the index record and a real course-scoped search back from the tools
    // themselves, and compares the index hash against a digest computed here.
    const preflight = await verifyCourseMaterial({
      execute, workspace, materialRoot, independentHash: sha256(pdf),
    })
    readiness.preflight = preflight
    readiness.stages.course_preflight = preflight.ok ? 'done' : 'failed'
    await persistReadiness()

    const surfaceParts = await sessionSurface({ ctx, agent: setupSession.agent, workspace })

    // ---- the instruction surface this attempt will actually send ---------------------------
    //
    // Measured on 2026-10-13 (instruction-surface-2026-10-13.json): the agent's assembled system
    // prompt carries 0 of the 3 table-finishing markers, because the host loads a skill on demand
    // through its `skill` tool. "Six skill names appear in metadata" was therefore never evidence
    // that the guidance reached the model, and a persona-only system prompt was not a skill-
    // activation test. Both modes are built here from the real assembly, the mode is recorded, and
    // readiness refuses the paid path unless the guidance is genuinely available under that mode.
    if (!Object.values(INSTRUCTION_MODES).includes(requestedInstructionMode)) {
      await refuse(`unknown instruction mode ${JSON.stringify(requestedInstructionMode)} — expected one of `
        + Object.values(INSTRUCTION_MODES).map((value) => JSON.stringify(value)).join(', '))
      return
    }
    const skillNames = ['professor-notes', 'professor-latex']
    const listedSkills = await ctx.get('skills').list({ scope: setupSession.agent, cwd: workspace })
    const resolvedSkillContents = []
    const resolvedSkillReport = []
    for (const name of skillNames) {
      const candidate = listedSkills.find((entry) => entry.name === name)
      if (candidate === undefined) {
        resolvedSkillReport.push({ name, resolved: false, reason: 'not listed for this scope' })
        continue
      }
      const skill = await ctx.get('skills')
        .get(candidate.name, { scope: setupSession.agent, cwd: workspace })
      const content = typeof skill?.content === 'string' ? skill.content : null
      if (content === null) {
        resolvedSkillReport.push({ name, resolved: false, reason: 'the registry returned no content' })
        continue
      }
      resolvedSkillContents.push(content)
      resolvedSkillReport.push({ name, resolved: true, chars: content.length })
    }
    if (requestedInstructionMode === INSTRUCTION_MODES.SUPPLIED && resolvedSkillContents.length === 0) {
      await refuse('supplied-skill-text was requested but the host resolved no skill body — the run '
        + 'would claim to supply skill text it never received')
      return
    }
    const instructionSurface = buildInstructionSurface({
      sections: surfaceParts.sections,
      persona: surfaceParts.persona,
      suppliedSkillText: requestedInstructionMode === INSTRUCTION_MODES.SUPPLIED
        ? resolvedSkillContents
        : null,
      suppliedSkillNames: skillNames,
    })
    const systemPrompt = `${instructionSurface.system}\n\nThis is a synthetic acceptance test with `
      + `a synthetic course ${COURSE_CODE}. Use only the tools offered to you.`
    // The five Professor tools plus the host read/edit pair are what the finishing workflow needs.
    // In native mode the host `skill` tool joins them, without which the bundled bodies can never
    // reach the attempt however well the registry resolves them.
    const offered = requestedInstructionMode === INSTRUCTION_MODES.NATIVE
      ? [...REQUIRED_M2B_TOOLS, 'skill']
      : [...REQUIRED_M2B_TOOLS]
    const m2bRequestText = noteRequest('latex', M2B_TABLE_REQUIREMENTS)
    const guidanceProblems = guidanceReadinessProblems({
      mode: instructionSurface.mode,
      system: systemPrompt,
      userMessage: m2bRequestText,
      resolvedSkillContents,
      offeredTools: offered,
    })
    const predictedPathProblems = requestTextProblems({ text: m2bRequestText, workspace })
    const instructionProblems = [...guidanceProblems, ...predictedPathProblems]
    readiness.instruction = {
      mode: instructionSurface.mode,
      mode_label: instructionSurface.modeLabel,
      requested_mode: requestedInstructionMode,
      assembled_section_count: instructionSurface.sectionNames.length,
      assembled_section_names: instructionSurface.sectionNames,
      persona_length: surfaceParts.persona?.length ?? 0,
      skills_listed: surfaceParts.skills ?? [],
      skills_resolved: resolvedSkillReport,
      skill_tool_offered: offered.includes('skill'),
      offered_tools: offered,
      output_token_allowance: ARTIFACT_TOKEN_ALLOWANCE,
      guidance_problems: guidanceProblems,
      predicted_path_problems: predictedPathProblems,
      note: 'listing skill names in metadata is not those skills being read; this records which '
        + 'mode was asked for and whether the table-finishing guidance is available under it',
    }
    readiness.stages.instruction_surface = instructionProblems.length === 0
      ? 'done — guidance and every required tool available before any request'
      : `blocked — ${instructionProblems.length} problem(s): ${instructionProblems.join(' | ')}`
    await persistReadiness()

    // ---- host filesystem capability: discover it, then probe what it may touch ---------------
    //
    // The repaired instructions tell the model to finish a wide table by editing the generated
    // `content.tex` of its own new artifact copy. That step needs a host file-edit tool, which
    // this runner did not offer — so it is discovered here from the live registry on the preset
    // scope, and its boundaries are probed against real files before any paid request. A missing
    // capability is reported as a blocked step; nothing is substituted for it.
    const hashOf = async (file) => {
      const bytes = await fs.readFile(file).catch(() => null)
      return bytes === null ? null : sha256(bytes)
    }
    const hostDiscovery = discoverHostFsTools(ctx, setupSession.agent)

    // An artifact copy to edit: created through the production tool, exactly as M2b would.
    const probeArtifact = await executeTool({
      ctx, agent: setupSession.agent, name: 'professor_artifact_create',
      args: {
        kind: 'note',
        title: 'N2 filesystem capability probe',
        course: COURSE_ID,
        format: 'latex',
        summary: 'Disposable probe artifact used only to verify which filesystem paths the host '
          + 'edit tool may touch. It is never graded and never counted as a model result.',
      },
      label: 'fs-probe-artifact',
    })
    const probeRoot = probeArtifact?.value?.root
      ?? path.join(workspace, '.professor', 'notes')
    const probeDirectory = probeArtifact?.value?.directory
    const probeContent = typeof probeDirectory === 'string'
      ? path.join(path.isAbsolute(probeDirectory) ? probeDirectory : path.join(probeRoot, probeDirectory), 'content.tex')
      : null

    // Text probes placed *inside* each directory under test, so a refusal can only come from
    // policy — never from an "unsupported file type" error that would read as protection.
    const probeFile = async (relative, sentinel) => {
      const absolute = path.join(workspace, relative)
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, `${sentinel}\n`)
      return { path: absolute, sentinel }
    }
    const sourceDirectoryProbe = await probeFile(
      path.join(path.dirname(SOURCE_RELATIVE_PATH), 'n2-fs-probe.txt'), 'source-directory-sentinel',
    )
    const otherCourseProbe = await probeFile('STA2001/n2-fs-probe.txt', 'other-course-sentinel')
    // The output copy is the renderer's own file, so its sentinel has to come from the file — a
    // guessed string that is not in it makes the edit fail with "old_string was not found", which
    // reads exactly like a policy refusal and would report the finishing step as blocked for the
    // wrong reason.
    const generatedContent = probeContent === null
      ? null
      : await fs.readFile(probeContent, 'utf8').catch(() => null)
    const outputSentinel = generatedContent === null
      ? null
      : generatedContent.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? null
    const outputCopyProbe = outputSentinel === null
      ? null
      : { path: probeContent, sentinel: outputSentinel }

    const fsProbes = outputCopyProbe === null
      ? { blocked: 'professor_artifact_create returned no content.tex to probe' }
      : await probeFsBoundaries({
        execute: (name, args) => executeTool({
          ctx, agent: setupSession.agent, name, args, label: `fs-probe-${name}`,
        }),
        hashOf,
        outputCopy: outputCopyProbe,
        sourceProbe: sourceDirectoryProbe,
        otherCourseProbe: otherCourseProbe,
      })
    // A write-boundary waiver is a human decision, so it is read from a record rather than assumed.
    // Without one the default is still blocking; with one, only the risks it actually names are
    // waived, and the record is echoed into readiness so the waiver can be audited. The same
    // identity the gate itself demands — a decision, a decider, and risks the record names — is
    // required here, so this stage line can never claim "waiver applied" for a record the gate
    // would refuse. Nothing in this file turns the record into authorization for a paid request.
    const fsDecision = await readJson(FS_DECISION_PATH).catch(() => null)
    const waiverValid = fsDecision !== null && fsDecision.block === BLOCK_ID
      && Array.isArray(fsDecision.accepted_risks)
      && typeof fsDecision.decision === 'string' && fsDecision.decision.trim() !== ''
      && typeof fsDecision.decided_by === 'string' && fsDecision.decided_by.trim() !== ''
    if (fsDecision !== null && !waiverValid) {
      readiness.stages.fs_boundary_decision = 'present but not usable — it does not name this block'
    } else {
      readiness.stages.fs_boundary_decision = waiverValid
        ? `waiver applied: ${(fsDecision.accepted_risks ?? []).join(', ') || 'none'}`
        : 'none recorded — write-boundary findings block the paid path by default'
    }
    const fsAssessment = assessFsReadiness(hostDiscovery, fsProbes, waiverValid
      ? { acceptedRisks: fsDecision.accepted_risks, waiver: fsDecision }
      : {})

    readiness.surface = {
      personaLength: surfaceParts.persona?.length ?? 0,
      visible_tools: surfaceParts.visibleTools,
      host_fs_tools: hostDiscovery,
      fs_probes: fsProbes,
      fs_readiness: fsAssessment,
    }
    readiness.workspace = { path: workspace, source: sourcePath, source_sha256: sha256(pdf) }
    readiness.stages.readiness = 'complete — no model request has been made'
    await persistReadiness()

    if (!paidMode) {
      console.log(JSON.stringify({
        mode: readiness.mode,
        paid_requests: 0,
        model_calls: 0,
        route: readiness.route,
        workspace,
        source_sha256: readiness.workspace.source_sha256,
        stages: readiness.stages,
        instruction: readiness.instruction,
        host_fs_tools: readiness.surface?.host_fs_tools?.offered ?? null,
        host_fs_missing: readiness.surface?.host_fs_tools?.missing ?? null,
        course_preflight: readiness.preflight === undefined ? null : {
          ok: readiness.preflight.ok,
          problems: readiness.preflight.problems,
          index_record: readiness.preflight.evidence?.index_record ?? null,
          retrieval: readiness.preflight.evidence?.retrieval ?? null,
        },
        fs_readiness: readiness.surface?.fs_readiness ?? null,
        setup: readiness.setup.map((entry) => entry.name),
        cases: readiness.cases,
        authorization: readiness.authorization,
        readiness: READINESS_PATH,
      }, null, 2))
      return
    }

    // ================================================================ paid path ========
    // The first thing that must hold before a request is spent: the model has to be told how to
    // finish the wide table, and has to have the tools to do it with. Asking for a budget while
    // the guidance is unreachable would only buy another uninterpretable failure.
    if (instructionProblems.length > 0) {
      await refuse('the instruction surface is not ready for this attempt:\n  '
        + instructionProblems.join('\n  '))
      return
    }
    // The finishing workflow the repaired instructions describe needs a host file-edit tool. If
    // readiness could not prove one is visible and stays inside its boundaries, this run stops
    // here: the model must not be graded against a workflow it has no tool for, and no substitute
    // is invented on its behalf.
    if (readiness.surface?.fs_readiness?.ready_for_paid_run !== true) {
      await refuse('the host filesystem capability is not ready: '
        + JSON.stringify(readiness.surface?.fs_readiness?.problems ?? ['unknown']))
      return
    }
    // The other thing that must hold before a request is spent: a case whose course owns no
    // material is a case graded against nothing, and that is only visible in the read-back.
    if (readiness.preflight?.ok !== true) {
      await refuse('the course material preflight failed — this case would have nothing to ground '
        + `against: ${JSON.stringify(readiness.preflight?.problems ?? ['unknown'])}`)
      return
    }
    const api = await loadHarness('@deepseek-ai/dsh-llm/lib/index.js')
    const llm = ctx.get('llm')
    const userMsg = (text) => api.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

    const report = {
      block: BLOCK_ID,
      started_at: new Date().toISOString(),
      route: readiness.route,
      authorization: readiness.authorization,
      source_sha256: readiness.workspace.source_sha256,
      workspace,
      cases: {},
      derived_by: DERIVED_BY,
    }
    const persistReport = () => writeJson(MODEL_REPORT_PATH, report)

    // Retrieval the grader holds the model to. Registration and the answer key are kept separately;
    // **coverage is not read from the index**. A page sitting in the index that no tool call
    // returned to this case was never seen by the model, so crediting it would let a citation to an
    // unread page pass. Coverage is therefore collected per case, from that case's own successful
    // search / material-read results, once the case has run.
    const indexDoc = await readJson(path.join(workspace, '.professor', 'indexes', 'files.json'))
    const indexRecords = Array.isArray(indexDoc.files) ? indexDoc.files : Object.values(indexDoc.files)
    const sourceRecord = indexRecords.find((entry) => entry.relative_path === SOURCE_RELATIVE_PATH)
    if (sourceRecord === undefined) {
      await refuse(`the synthetic source was not registered in ${SOURCE_RELATIVE_PATH}`)
      return
    }
    const registered = {
      file_id: sourceRecord.file_id,
      content_hash: sourceRecord.content_hash,
      relative_path: sourceRecord.relative_path,
    }
    report.registration = registered
    await persistReport()

    /** Coverage for one case, from that case's own delivered tool results only. */
    const contextForCase = (record) => {
      const context = gradingContextFromDelivery(record.tool_calls ?? [], {
        fileIds: [sourceRecord.file_id],
        sourceRelativePath: SOURCE_RELATIVE_PATH,
      })
      record.retrieval = {
        derived_from: context.derived_from,
        retrieved_pages: context.retrievedPages,
        deliveries: context.deliveries.map((delivery) => ({
          tool: delivery.tool, page: delivery.page, kind: delivery.kind,
          file_id: delivery.file_id, chunk_id: delivery.chunk_id ?? null,
        })),
        rejected: context.rejected,
      }
      return context
    }

    /**
     * One paid request. Charged to the budget and persisted BEFORE the call so a crash cannot
     * silently reuse allowance, and never retried.
     *
     * The allowance defaults to `ARTIFACT_TOKEN_ALLOWANCE`: 2,000 tokens could not hold a full
     * `professor_artifact_create` argument JSON plus reasoning, and the resulting cut-off went
     * unrecorded on 2026-10-13, so truncation could only be guessed at afterwards. The finish
     * reason and any usage the host reports are written to the attempt ledger **before** this
     * function returns, so a crash between the response and the report still leaves them on record.
     */
    const callModel = async (label, {
      system, messages, tools, sessionId, maxTokens = ARTIFACT_TOKEN_ALLOWANCE,
    }) => {
      budget.charge(label)
      counter.attempts = budget.log
      await writeJson(COUNTER_PATH, counter)
      await persistReport()
      const controller = new AbortController()
      const deadline = setTimeout(() => controller.abort(), 120_000)
      const attempt = counter.attempts[counter.attempts.length - 1]
      let response
      try {
        response = await consumeModelStream({
          openStream: () => llm.stream({
            ...selection, system, messages, tools, maxTokens, signal: controller.signal, sessionId,
          }),
          attempt, maxTokens,
          persistAttempt: () => writeJson(COUNTER_PATH, counter),
        })
      } finally {
        clearTimeout(deadline)
      }
      const { blocks, finish } = response
      if (finish?.kind === 'error' || finish?.kind === 'aborted') {
        attempt.failed = finish.kind
        await writeJson(COUNTER_PATH, counter)
        throw new Error(`model request ${counter.attempts.length} failed (${finish.kind}) — recorded, not retried`)
      }
      return { blocks, finish, usage: attempt.usage }
    }

    /**
     * Drive one note request: the model retrieves, then writes, then creates the artifact.
     * Its final response and every tool result are kept verbatim; nothing is edited.
     */
    const runNote = async (caseId, format, maxRounds, extraRequirements = '') => {
      const record = {
        case_id: caseId,
        format,
        request_text: noteRequest(format, extraRequirements),
        requests_used: 0,
        rounds: [],
        instruction: null,
        tool_calls: [],
        final_response: null,
        grading: null,
        delivery: null,
        status: 'IN-PROGRESS',
      }
      report.cases[caseId] = record
      await persistReport()

      const { agent } = await createNativeSession({ ctx, sessionId: `n2-${caseId}-${path.basename(temp)}`, workspace })
      await selectPreset({ ctx, agent })
      await executeTool({ ctx, agent, name: 'professor_session_bind', args: { course: COURSE_ID }, label: `bind-${caseId}` })

      // The host's own `read` and `edit` are offered alongside the plugin's tools: the repaired
      // instructions tell the model to finish a wide table in the generated `content.tex` of its
      // own new artifact copy, and that step is unreachable without a file-edit tool. Only these
      // two are added — the minimum read/edit capability — and only because readiness proved they
      // are visible on this scope and behave within their boundaries. No shell tool is offered.
      // The offer is fixed for the run (`offered`), built from REQUIRED_M2B_TOOLS. Every name is
      // resolved against this case's own scope: a tool that vanished is reported as a blocked
      // attempt rather than silently dropped from toolDefs, which would leave the model graded
      // against a workflow it was never given.
      if (!OFFERED_FS_TOOLS.every((name) => REQUIRED_M2B_TOOLS.includes(name))) {
        throw new Error('REQUIRED_M2B_TOOLS no longer contains OFFERED_FS_TOOLS — the finishing '
          + 'workflow would be offered host tools the capability probe never validated')
      }
      const toolDefs = offered
        .map((name) => {
          const descriptor = ctx.get('tools').view(agent).visible.get(name)
          return descriptor === undefined
            ? null
            : { name, description: descriptor.description, parameters: descriptor.parameters }
        })
        .filter(Boolean)
      const invisible = offered.filter((name) => !toolDefs.some((definition) => definition.name === name))
      record.instruction = {
        mode: instructionSurface.mode,
        mode_label: instructionSurface.modeLabel,
        offered_tools: offered,
        tool_definitions: toolDefs.map((definition) => definition.name),
        invisible_tools: invisible,
        output_token_allowance: ARTIFACT_TOKEN_ALLOWANCE,
      }
      if (invisible.length > 0) {
        record.status = 'BLOCKED (pre-request readiness)'
        record.notes = [`required tool(s) not visible on this scope: ${invisible.join(', ')}`]
        await persistReport()
        return record
      }
      const system = systemPrompt
      const messages = [userMsg(record.request_text)]

      if (only !== null && !only.some((prefix) => caseId.startsWith(prefix))) {
        record.status = 'NOT-INCLUDED (this invocation)'
        record.notes = [`not selected by ${onlyArg}; this case's earlier evidence is preserved in failed-observations/run-1-model-report.json`]
        record.grading = null
        await persistReport()
        return record
      }
      const exhausted = (why) => {
        record.status = 'BUDGET-EXHAUSTED'
        record.notes = [why]
        record.final_response = record.final_response ?? null
        record.grading = record.grading ?? null
        return persistReport()
      }
      if (counter.attempts.length >= counter.authorized_limit) {
        await exhausted('no budget left when this case started — the case is INCOMPLETE, never a pass')
        return record
      }

      let finalText = ''
      let lastFinish = null
      let incomplete = null
      for (let round = 0; round < maxRounds; round += 1) {
        if (counter.attempts.length >= counter.authorized_limit) {
          await exhausted('stopped on the authorized budget with pending work — the turn is INCOMPLETE')
          break
        }
        const before = counter.attempts.length
        const { blocks, finish, usage } = await callModel(`${caseId}-round-${round + 1}`, {
          system, messages, tools: toolDefs, sessionId: agent.id,
        })
        lastFinish = finish
        record.requests_used = (record.requests_used ?? 0) + (counter.attempts.length - before)
        const calls = blocks.filter((block) => block.type === 'tool-call')
        const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
        if (text) finalText = text
        record.rounds.push({
          round: round + 1,
          finish_reason: finish ?? null,
          usage: usage ?? null,
          max_tokens: ARTIFACT_TOKEN_ALLOWANCE,
          tool_calls: calls.length,
        })
        await persistReport()
        if (calls.length === 0) break
        const batch = validateToolBatch(calls, { finish, offeredTools: offered })
        if (!batch.ok) {
          incomplete = batch.reason
          record.notes = [...(record.notes ?? []), `INCOMPLETE — response batch not executed: ${batch.reason}`]
          break
        }
        messages.push(api.createAssistantMessage({ content: blocks, source: { kind: 'model', ...selection } }))
        for (const { block, args } of batch.calls) {
          const parsed = { args }
          const result = await executeTool({ ctx, agent, name: block.name, args: parsed.args, label: `${caseId}-${block.name}` })
          record.tool_calls.push({
            name: block.name, args: parsed.args,
            isError: result.isError === true,
            result: resultJson(result),
            result_text: resultText(result),
          })
          messages.push(api.createToolResultMessage({ callId: block.id, content: result.content, isError: result.isError === true }))
        }
        if (incomplete !== null) break
        if (counter.attempts.length >= counter.authorized_limit) {
          record.status = 'BUDGET-EXHAUSTED'
          record.notes = ['stopped on the authorized budget with pending tool calls — the turn is INCOMPLETE']
          await persistReport()
          break
        }
      }

      record.final_response = finalText
      // FO-3: the deliverable is the file the model created, not the chat reply summarising it.
      // Paths come only from what `professor_artifact_create` returned — never assembled from the
      // title, because slugify truncates at 64 characters and the predicted path does not exist.
      const createdTexts = []
      const createdPaths = []
      const pathProblems = []
      for (const call of record.tool_calls) {
        if (call.name !== 'professor_artifact_create' || call.isError === true) continue
        const collected = artifactPathsFromCreate(call.result, { workspace })
        pathProblems.push(...collected.problems)
        for (const entry of collected.paths) {
          const text = await fs.readFile(entry.path, 'utf8').catch(() => null)
          if (text === null) {
            pathProblems.push(`the returned path ${entry.path} could not be read back (${entry.source})`)
            continue
          }
          createdTexts.push(text)
          createdPaths.push(entry.path)
        }
      }
      const gradingText = artifactGradingText(createdTexts)
      record.deliverable = {
        graded_target: gradingText === null ? 'no-artifact' : 'created-artifact',
        created_paths: createdPaths,
        path_problems: pathProblems,
        graded_chars: gradingText?.length ?? 0,
      }
      const gradingContext = contextForCase(record)
      record.grading = gradingText === null ? null : gradeNote(gradingText, gradingContext)
      // Status comes from the host's own finish reason, never from whether some text exists.
      // `tool-calls`, `max-tokens`, an unrecognised reason, a truncated tool call, or a turn that
      // never concluded are all INCOMPLETE — the 2026-10-13 continuation ended on `tool-calls`
      // while still holding introductory text, and that read as progress.
      if (record.status === 'IN-PROGRESS') {
        const outcome = classifyTurnOutcome({
          finish: lastFinish,
          finalText,
          artifactCreated: createdPaths.length > 0,
        })
        record.turn_outcome = { ...outcome, finish_reason: lastFinish ?? null }
        record.status = incomplete === null ? outcome.status : 'INCOMPLETE'
        if (incomplete !== null) record.notes = [...(record.notes ?? []), incomplete]
        if (record.status === 'OBSERVED' && pathProblems.length > 0) {
          record.status = 'INCOMPLETE'
          record.notes = [...(record.notes ?? []), ...pathProblems]
        }
      }
      await persistReport()
      return record
    }

    // ---- snapshot taken BEFORE any model turn, so preservation and INDEX separation are
    // ---- provable rather than asserted after the fact -------------------------------
    const sourceRoot = path.join(workspace, path.dirname(SOURCE_RELATIVE_PATH))
    const notesRoot = path.join(workspace, '.professor', 'notes')
    const indexFile = path.join(workspace, '.professor', 'state', COURSE_ID, 'INDEX.md')
    const preModel = {
      index_read: await executeTool({
        ctx, agent: setupSession.agent, name: 'professor_state_read',
        args: { course: COURSE_ID, file: 'INDEX.md' }, label: 'pre-model-index-read',
      }),
      index_bytes: await fs.readFile(indexFile, 'utf8').catch(() => null),
      source_tree: await hashTree(sourceRoot),
      output_tree: await hashTree(notesRoot),
    }
    report.pre_model_snapshot = {
      index_exists_before_model_turns: preModel.index_bytes !== null,
      index_text_before_model_turns: preModel.index_bytes,
      source_tree: preModel.source_tree,
      output_tree: preModel.output_tree,
      derived_by: DERIVED_BY,
    }
    await persistReport()

    // M1 and M2: one note each, the format stated explicitly in that request.
    await runNote('M1_source_grounded_markdown_note', 'markdown', 8)
    await runNote('M2_source_grounded_latex_note', 'latex', 8)

    // M2b: the FO-8 case. The requirement is stated as a **deliverable**, not a recipe — what has
    // to be true of the rendered page — so the run tests whether the corrected bundled instructions
    // actually lead a model to a typeset table, rather than whether it can follow a recipe handed
    // to it here. `read` and `edit` are offered because readiness proved them available.
    await runNote(
      'M2b_source_grounded_latex_note_with_wide_table',
      'latex',
      8,
      M2B_TABLE_REQUIREMENTS,
    )

    // ---- M3: grading is deterministic and costs no request -----------------------------
    const m3 = {
      case_id: 'M3_claim_grading_against_answer_key',
      status: 'OBSERVED',
      derived_by: `${DERIVED_BY} — structural checks only; prose quality is a separate human column`,
      per_case: {},
    }
    for (const [caseId, rec] of Object.entries(report.cases)) {
      // M2b is a note case too, and `M2b_` deliberately does not start with `M2_` — naming it
      // explicitly keeps the filter honest instead of relying on a prefix coincidence.
      if (!['M1_', 'M2_', 'M2b_'].some((prefix) => caseId.startsWith(prefix))) continue
      m3.per_case[caseId] = {
        status: rec.grading === null ? 'NOT GRADED — no response produced' : 'GRADED',
        checks: rec.grading?.checks ?? null,
        citations: rec.grading?.citations ?? null,
        covered_pages: rec.grading?.covered_pages ?? null,
      }
    }
    m3.status = Object.values(m3.per_case).every((entry) => entry.status === 'GRADED') ? 'OBSERVED' : 'PARTIAL'
    report.cases.M3_claim_grading_against_answer_key = m3
    await persistReport()

    // ============ M3–M7: deterministic post-processing — costs NO requests ============
    const agent = setupSession.agent
    const artifacts = []
    for (const [caseId, rec] of Object.entries(report.cases)) {
      for (const call of rec.tool_calls ?? []) {
        if (call.name !== 'professor_artifact_create') continue
        artifacts.push({ case_id: caseId, format: rec.format, isError: call.isError, result: call.result })
      }
    }
    // ---- M4: read back + separate INDEX registration --------------------------------
    //
    // Every path is taken from what `professor_artifact_create` returned, through the same helper
    // the turn-level read-back uses. Nothing is assembled from a title: slugify truncates at 64
    // characters, so a predicted `content.tex` path does not exist — that is exactly the mistake
    // the 2026-10-13 continuation made and recorded as a failed read.
    const readBacks = []
    for (const artifact of artifacts) {
      const base = {
        created: artifact.result?.created === true,
        root: artifact.result?.root,
        directory: artifact.result?.directory,
      }
      const files = []
      const pathProblems = []
      const entries = Array.isArray(artifact.result?.files) ? artifact.result.files : []
      if (artifact.result?.created === true && entries.length === 0) {
        pathProblems.push('artifact_create reported created:true but no files to read back')
      }
      for (const entry of entries) {
        // One call per entry so the original entry survives for the reported-bytes comparison
        // (FO-5: the tool reports {relative, bytes} and no sha256, so only bytes are comparable).
        const collected = artifactPathsFromCreate({ ...base, files: [entry] }, { workspace })
        pathProblems.push(...collected.problems)
        const absolute = collected.paths[0]?.path ?? null
        if (absolute === null) continue
        const buffer = await fs.readFile(absolute).catch(() => null)
        files.push({
          path: absolute,
          path_source: collected.paths[0].source,
          exists: buffer !== null,
          bytes: buffer?.byteLength ?? null,
          sha256: buffer === null ? null : sha256(buffer),
          reported_bytes: typeof entry === 'object' ? entry.bytes ?? null : null,
          reported_sha256: typeof entry === 'object' ? entry.sha256 ?? null : null,
          matches_reported_bytes: buffer !== null && typeof entry === 'object'
            && typeof entry.bytes === 'number' && entry.bytes === buffer.byteLength,
          hash_computed_by: DERIVED_BY,
        })
      }
      readBacks.push({
        case_id: artifact.case_id,
        created: artifact.result?.created ?? null,
        path_problems: pathProblems,
        files,
      })
    }

    const indexAfterModelTurns = await fs.readFile(indexFile, 'utf8').catch(() => null)
    const stateRefusal = await executeTool({
      ctx, agent, name: 'professor_state_update',
      args: {
        course: COURSE_ID, file: 'INDEX.md', evidence: 'weak',
        title: 'N2 registration probe', body: 'written by the acceptance runner through professor_state_update',
      },
      label: 'M4-state-update-on-index',
    })
    const registrationRows = readBacks.flatMap((entry) => (entry.files ?? [])
      .filter((file) => file.exists)
      .map((file) => `| ${entry.case_id} | ${path.relative(workspace, file.path)} | ${file.sha256.slice(0, 12)} | acceptance-run |\n`))
    await fs.mkdir(path.dirname(indexFile), { recursive: true })
    const indexBeforeRegistration = await fs.readFile(indexFile, 'utf8').catch(() => null)
    await fs.appendFile(indexFile, registrationRows.join(''), 'utf8')
    const indexAfterRegistration = await fs.readFile(indexFile, 'utf8').catch(() => null)
    const stateReadBack = await executeTool({
      ctx, agent, name: 'professor_state_read',
      args: { course: COURSE_ID, file: 'INDEX.md' }, label: 'M4-index-read-after-registration',
    })

    report.cases.M4_artifact_readback_and_index_registration = {
      case_id: 'M4_artifact_readback_and_index_registration',
      status: 'OBSERVED',
      read_backs: readBacks,
      index_unchanged_by_model_turns: (preModel.index_bytes ?? null) === (indexAfterModelTurns ?? null),
      expected_negative_state_update: {
        // FO-5: executeTool returns {isError, content, value}; the domain fields live under .value.
        written: stateRefusal?.value?.written ?? null,
        problems: stateRefusal?.value?.problems ?? null,
        refused_read_only: (stateRefusal?.value?.problems ?? [])
          .some((text) => /read-only here/.test(text)),
        original: stateRefusal,
      },
      registration_performed_by: 'node:fs appendFile standing in for the host filesystem tool — professor_state_update refuses INDEX.md by contract',
      registration_rows: registrationRows,
      index_before_registration: indexBeforeRegistration,
      index_after_registration: indexAfterRegistration,
      registration_changed_index: indexBeforeRegistration !== indexAfterRegistration,
      state_read_after_registration: stateReadBack,
      derived_by: DERIVED_BY,
    }
    await persistReport()

    // ---- M5: preservation -------------------------------------------------------------
    const sourceAfter = await hashTree(sourceRoot)
    const outputAfter = await hashTree(notesRoot)
    const diffOf = (before, after) => ({
      added: Object.keys(after).filter((key) => before[key] === undefined).sort(),
      removed: Object.keys(before).filter((key) => after[key] === undefined).sort(),
      changed: Object.keys(after)
        .filter((key) => before[key] !== undefined && before[key].sha256 !== after[key].sha256).sort(),
    })
    const sourceDiff = diffOf(preModel.source_tree, sourceAfter)
    report.cases.M5_source_and_artifact_preservation = {
      case_id: 'M5_source_and_artifact_preservation',
      status: 'OBSERVED',
      source_tree_diff: sourceDiff,
      source_intact: sourceDiff.added.length === 0 && sourceDiff.removed.length === 0 && sourceDiff.changed.length === 0,
      output_tree_before: preModel.output_tree,
      output_tree_after: outputAfter,
      output_diff: diffOf(preModel.output_tree, outputAfter),
      derived_by: DERIVED_BY,
      note: 'a pre-existing output file whose sha256 changed would be a FAIL; newly added files are the artifacts themselves',
      pre_existing_output_files: Object.keys(preModel.output_tree),
      pre_existing_output_changed: Object.keys(preModel.output_tree)
        .filter((key) => outputAfter[key] !== undefined && outputAfter[key].sha256 !== preModel.output_tree[key].sha256),
    }
    await persistReport()

    // ---- M6: compile through the production tool -------------------------------------
    const latexArtifact = artifacts.find((entry) => entry.format === 'latex' && entry.result?.created === true)
    if (latexArtifact === undefined) {
      report.cases.M6_latex_compile_through_production_tool = {
        case_id: 'M6_latex_compile_through_production_tool',
        status: 'NOT RUN',
        reason: 'no LaTeX artifact was created, so there is nothing to compile — source creation alone is not compilation',
        attempted: false,
      }
    } else {
      const compile = await executeTool({
        ctx, agent, name: 'professor_latex_compile',
        args: { kind: 'note', directory: latexArtifact.result.directory },
        label: 'M6-compile',
      })
      report.cases.M6_latex_compile_through_production_tool = {
        case_id: 'M6_latex_compile_through_production_tool',
        status: 'OBSERVED',
        original: compile,
        artifact_case_id: latexArtifact.case_id,
        artifact_directory: latexArtifact.result.directory,
        // FO-6: executeTool returns {isError, content, value}; the compile payload lives under
        // .value. Reading the envelope made a successful compile look like "no PDF" and skipped
        // M7 entirely, so this is derived from .value and the envelope is kept alongside.
        derived_by: `${DERIVED_BY} — from original.value; pdf.produced lives inside pdf`,
        verdict: compile?.value?.verdict ?? null,
        attempted: compile?.value?.attempted ?? null,
        blocked_by: compile?.value?.blocked_by ?? null,
        exit_code: compile?.value?.exit_code ?? null,
        pdf: compile?.value?.pdf ?? null,
        warnings: compile?.value?.warnings ?? null,
        problems: compile?.value?.problems ?? null,
      }
    }
    await persistReport()

    // ---- M7: render the produced PDF so its pages can actually be inspected ------------
    const pdfPath = report.cases.M6_latex_compile_through_production_tool?.pdf?.path ?? null
    if (typeof pdfPath !== 'string') {
      report.cases.M7_visual_inspection_bound_to_pdf_hash = {
        case_id: 'M7_visual_inspection_bound_to_pdf_hash',
        status: 'NOT RUN',
        reason: 'no PDF was produced',
        inspected: false, inspected_pages: 0, inspected_by: null,
      }
    } else {
      const pdfBuffer = await fs.readFile(pdfPath).catch(() => null)
      const outDir = path.join(DIR, 'rendered')
      await fs.mkdir(outDir, { recursive: true })
      const renderScript = 'import pymupdf,sys,os\n'
        + 'doc=pymupdf.open(sys.argv[1])\n'
        + 'outdir=sys.argv[2]\n'
        + 'for i,page in enumerate(doc):\n'
        + '    page.get_pixmap(matrix=pymupdf.Matrix(1.5,1.5)).save(os.path.join(outdir, f"page-{i+1}.png"))\n'
        + 'print(doc.page_count)\n'
      let pageCount = null
      let renderError = null
      try {
        pageCount = Number(execFileSync('python3', ['-c', renderScript, pdfPath, outDir], { encoding: 'utf8' }).trim())
      } catch (error) {
        renderError = String(error?.stderr ?? error?.message ?? error).slice(0, 400)
      }
      const pages = []
      for (let page = 1; page <= (pageCount ?? 0); page += 1) {
        const png = path.join(outDir, `page-${page}.png`)
        const buffer = await fs.readFile(png).catch(() => null)
        pages.push({ page, path: png, bytes: buffer?.byteLength ?? null })
      }
      const pdfCopy = path.join(outDir, 'main.pdf')
      if (pdfBuffer !== null) await fs.copyFile(pdfPath, pdfCopy)
      report.cases.M7_visual_inspection_bound_to_pdf_hash = {
        case_id: 'M7_visual_inspection_bound_to_pdf_hash',
        status: 'RENDERED — awaiting inspection',
        artifact_case_id: latexArtifact.case_id,
        rendered_by: 'python3 -c pymupdf, independent of the tool result',
        pdf_source_path: pdfPath,
        pdf_copy: pdfBuffer === null ? null : pdfCopy,
        pdf_bytes: pdfBuffer?.byteLength ?? null,
        pdf_sha256: pdfBuffer === null ? null : sha256(pdfBuffer),
        rendered_pages: pages,
        render_error: renderError,
        inspected: false, inspected_pages: 0, inspected_by: null,
        note: 'pages are rendered but NOT yet inspected; pdf.produced is not visual success',
      }
    }
    await persistReport()

    // ---- delivery: what was actually delivered, judged as delivered ---------------------
    //
    // A missing artifact is a delivery failure, not an invitation to grade the chat reply;
    // `TABLE_PLACEHOLDER` means the four-column table was never written, so the artifact is
    // incomplete; an empty INDEX registration list is not registration. Runner-written
    // registration, model-written output, compilation and visual acceptance stay separate facts —
    // `assessDelivery` reports them without letting one imply another. A case whose delivery is
    // not ok is never left standing as OBSERVED, which is what "compile succeeded" used to read as.
    const compileCase = report.cases.M6_latex_compile_through_production_tool
    const visualCase = report.cases.M7_visual_inspection_bound_to_pdf_hash
    for (const [caseId, rec] of Object.entries(report.cases)) {
      if (!['M1_', 'M2_', 'M2b_'].some((prefix) => caseId.startsWith(prefix))) continue
      const paths = rec.deliverable?.created_paths ?? []
      const contents = []
      for (const created of paths) {
        const text = await fs.readFile(created, 'utf8').catch(() => null)
        if (text !== null) contents.push(text)
      }
      rec.delivery = assessDelivery({
        createdPaths: paths,
        contents,
        indexRegistration: registrationRows,
        ...compilationFactsForCase(caseId, compileCase, visualCase),
      })
      rec.compilation_evidence = compileCase?.artifact_case_id === caseId
        ? { case_id: compileCase.artifact_case_id, directory: compileCase.artifact_directory,
          pdf_path: compileCase.pdf?.path ?? null }
        : null
      if (rec.delivery.ok === false) {
        if (rec.status === 'OBSERVED') rec.status = 'INCOMPLETE (delivery)'
        rec.notes = [...(rec.notes ?? []), ...rec.delivery.problems]
      }
      await persistReport()
    }

    report.finished_at = new Date().toISOString()
    report.requests_used = counter.attempts.length
    report.requests_authorized = counter.authorized_limit
    await persistReport()
    readiness.model_calls = counter.attempts.length
    readiness.paid_requests = counter.attempts.length
    await persistReadiness()

    console.log(JSON.stringify({
      paid_requests: counter.attempts.length,
      authorized_limit: counter.authorized_limit,
      cases: Object.fromEntries(Object.entries(report.cases).map(([id, value]) => [id, value.status])),
      report: MODEL_REPORT_PATH,
    }, null, 2))
  } finally {
    // FO-2: the first run called `ctx.dispose()`, which does not exist, and the host never
    // released its handles — the work finished and the process then hung. This mirrors the
    // established runner (`tools/verify-teaching-model.mjs`): race the real disposer against a
    // timeout so an unsettled host can never hang the run. The temp workspace is deliberately
    // left behind so the recorded paths stay verifiable after the fact.
    await Promise.race([
      ctx?.fiber?.dispose?.(),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ])
  }
}

await main()
