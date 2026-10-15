/**
 * `professor_material_read` — the plugin's own bounded, non-repetitive material reader.
 *
 * Why this tool exists: a live comparison session read 96 images across 106 tool calls, re-read the
 * same pages up to six times, hit the host's 20,971,520-byte request-image bound three times and
 * never produced a paragraph. The loop had three legs — no durable record of what had been seen, an
 * offload placeholder that hands back a readable local path, and no budget anywhere. This tool
 * closes all three *at a boundary the plugin owns*, without wrapping or replacing the host's
 * `read_image` (no supported interception point exists for that).
 *
 * The contract, in one place:
 *
 * - **text layer first.** `action: 'plan'` reads the text layer and returns an explicit per-page
 *   reading plan, distinguishing `whole-document` from a selected `section`.
 * - **stable identity.** An inspection is keyed by source content hash + physical page number +
 *   rendering variant, so an unchanged page at an unchanged resolution is answered from the ledger
 *   — text excerpt plus the model's own note — instead of being attached again.
 * - **justified rereads.** A page comes back as an image only when the source changed, the
 *   rendering variant changed, or the caller names `reason: 'unreadable' | 'explicit-user-request'`.
 * - **notes survive offload.** `notes` may be passed on every call; the ledger stores them and
 *   `action: 'status'` returns them, which is how teaching continues after the host drops an image.
 * - **budgets terminate, they do not loop.** Pages per call, bytes per call/turn/session; when one
 *   is spent the answer is an actionable continuation listing what is still unread — never another
 *   attachment.
 * - **budgets are reserved, not re-read.** Capacity is *held* synchronously as each page is chosen
 *   and converted to real cost only after the attachment service reports what it charged, so a
 *   selection loop can never pick four pages into a two-page gap and discover the overspend when it
 *   charges them. Every hold is returned before the budget block is read, and again in a `finally`.
 * - **one page, one image.** A per-session lock serialises this tool's calls for one session, and a
 *   synchronous page claim blocks a second attempt on the same physical page, so two overlapping
 *   calls cannot render or attach it twice. Unrelated sessions never queue behind each other.
 * - **exactly the pages you named.** The request travels to the renderer as an explicit list, so
 *   `[1, 10]` renders those two pages — not a capped `1-4` that drops 10 and spends the budget on
 *   2-9 — and a page the renderer did not hand back is reported `not-delivered`, never as rendered.
 * - **coverage is reported, never implied.** `inspected / text_complete / text_partial /
 *   overview_only / noted / unread / unreadable` are delivery buckets: a page is covered only when
 *   its image or its complete source body reached the model-facing result. A bounded excerpt is
 *   `overview_only`, never a reading claim, and search hits are explicitly not coverage. Delivery
 *   is proven; comprehension and use are not.
 * - **images ride the host's real output path.** The projection lives on `output.render` (the
 *   installed Harness calls `tool.output.render(args, value)` when materializing a result), and
 *   nothing is recorded as delivered until that projection has been shown to carry the image
 *   blocks — a rendering failure rolls back every delivery claim instead of suppressing the page
 *   as already delivered.
 * - **numbering is never guessed.** `page` is the physical index; printed/footer numbering is
 *   reported as `printed: null, correspondence: 'not-established'`.
 * - **honest delivery.** A missing attachment service, an unresolved route or a text-only model is
 *   reported as such — never as a silent downgrade that looks like a successful visual read.
 *
 * Rendered images are produced in memory by `render_pages.py`, handed to the Harness attachment
 * service and dropped: nothing is written to a course directory and no image cache persists.
 *
 * @module dsh-professor-spike/src/tools/material-read
 */

import { backendFamilyFor, planExtraction } from '../extract/capabilities.js'
import { loadProject } from '../project/project.js'
import { projectPaths, sessionId as sessionIdOf } from '../paths/roots.js'
import { resolveCourseFilter } from '../courses/registry.js'
import { isInside } from '../paths/policy.js'
import {
  COST_UNIT, SUPPRESSION, cancelledError, createReadingLedger, renderVariant, resolveBudget,
  reuseDecision, textBodyId,
} from '../material/ledger.js'
import {
  MAX_PLAN_PAGES, buildReadingPlan, compactPlan, coverageStatement, numberingContract,
  rescopeReadingPlan,
} from '../material/plan.js'
import { jsonOutput, oneOfTypes } from './support.js'

export const MATERIAL_READ_TOOL_NAME = 'professor_material_read'

/** Actions the tool accepts. */
export const MATERIAL_ACTIONS = Object.freeze(['plan', 'text', 'enhance', 'pages', 'status'])

const TEXT_CALL_LIMIT = 32000
const TEXT_PAGE_LIMIT = 6

/** Longest page note the ledger keeps, in characters. */
const NOTE_LIMIT = 600

/** How many notes one call may submit. */
const NOTES_PER_CALL = 24

/**
 * Hard ceiling on a rendered page's long edge, in pixels.
 *
 * The approved design caps the long edge at 2000 pixels. The host may further downscale images
 * according to the active route; final attachment dimensions remain authoritative.
 */
const MAX_SIDE_CEILING = 2000

/**
 * The smallest byte budget the renderer will accept, mirroring `render_pages.py`.
 *
 * The script floors its own budget here, so asking it to stay under anything smaller is
 * impossible: the tool checks the *remaining* capacity against this floor first and refuses to
 * render at all rather than rendering pixels it knows it cannot deliver.
 */
const RENDER_FLOOR_BYTES = 1024

/**
 * Refuse when the caller has already cancelled.
 *
 * Module level on purpose: the same check runs before the lock, after every `await`, and before
 * every attachment, so a signal that aborts mid-render can never produce a delivered image or a
 * ledger write that the caller asked to stop.
 *
 * @throws `PROFESSOR_CANCELLED`.
 */
export function assertNotCancelled(signal) {
  if (signal?.aborted === true) throw cancelledError()
}

/**
 * Best-effort current turn index.
 *
 * The host gives a tool no turn identifier (`ToolRunContext` carries only `callId`, `agent` and
 * `signal`), so the per-turn budget is derived from the session's own `turn/start` events when the
 * session object exposes them, and falls back to `null` — which the budget block reports as the
 * `session` scope. Nothing is guessed here: an unreadable surface yields `null`, never a made-up
 * number.
 *
 * @param exec - tool execution context.
 * @returns the turn number, or null when the host does not expose one.
 */
export function readTurnIndex(exec) {
  try {
    const session = exec?.agent?.session
    if (session === undefined || session === null) return null
    if (typeof session.eventAt !== 'function') return null
    const nodes = session?.surface?.nodes
    if (!Array.isArray(nodes)) return null
    let turns = 0
    for (const seq of nodes) {
      const event = session.eventAt(seq)
      if (event?.type === 'turn/start') turns += 1
    }
    return turns > 0 ? turns : null
  } catch {
    // A host whose surface we cannot read simply means "no turn budget", not "no budget".
    return null
  }
}

/**
 * Whether the exact calling route can accept an image, mirroring the host's `read_image` gate.
 *
 * Unknown capability refuses, exactly as the host tool does: an image is useful only when the
 * route can actually see it, and a silent projection to placeholder text would look like a
 * successful visual read from the outside.
 *
 * @returns `{ ok, status, reason?, attachments?, model?, provider? }`.
 */
export async function resolveImageRoute(ctx, exec) {
  const attachments = (() => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined
    } catch {
      return undefined
    }
  })()
  if (attachments === undefined || attachments === null) {
    return {
      ok: false,
      status: 'unavailable-attachments',
      reason: 'the Harness attachment service (ctx.attachments) is not mounted, so no page image can be delivered',
    }
  }
  const routed = (() => {
    try {
      return exec?.agent?.session?.requestHeader?.()?.config
    } catch {
      return undefined
    }
  })()
  const provider = routed?.provider ?? exec?.agent?.options?.provider
  const model = routed?.model ?? exec?.agent?.options?.model
  const llm = (() => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
    } catch {
      return undefined
    }
  })()
  if (provider === undefined || model === undefined
    || llm === undefined || typeof llm.resolveModelInfo !== 'function') {
    return {
      ok: false,
      attachments,
      status: 'unavailable-route-unresolved',
      reason: 'the current model route could not be resolved, so image delivery cannot be verified for this call',
      ...(model === undefined ? {} : { model }),
    }
  }
  try {
    const info = await llm.resolveModelInfo(provider, model, exec?.signal)
    const modalities = Array.isArray(info?.inputModalities) ? info.inputModalities : null
    if (modalities === null || !modalities.includes('image')) {
      return {
        ok: false,
        attachments,
        status: 'unavailable-text-only-model',
        model,
        provider,
        reason: `model "${model}" does not declare image input, so page images are not delivered to it; `
          + 'the text layer and the coverage report below are still complete',
      }
    }
    return { ok: true, attachments, status: 'ready', model, provider }
  } catch (error) {
    return {
      ok: false,
      attachments,
      status: 'unavailable',
      model,
      provider,
      reason: `image delivery could not be verified: ${error?.message ?? String(error)}`,
    }
  }
}

/** Read the file index (the index is the authority on what exists). */
async function readIndexRecords({ gateway, projectRoot, signal, optional = false }) {
  const layout = projectPaths(projectRoot)
  const target = await gateway.resolveTarget(layout.filesIndex, { cwd: projectRoot, signal })
  if (await gateway.stat(target, signal) === undefined) {
    if (optional) return []
    const error = new Error('no file index yet: run professor_index_sync, then professor_extract')
    error.code = 'PROFESSOR_INDEX_MISSING'
    throw error
  }
  const parsed = JSON.parse(await gateway.readText(target, signal))
  if (!Array.isArray(parsed?.files)) {
    const error = new Error('file index is unreadable or malformed: run professor_index_sync with rebuild: true')
    error.code = 'PROFESSOR_INDEX_MISSING'
    throw error
  }
  return parsed.files
}

/**
 * Resolve which file this call is about.
 *
 * `file_id` and `path` are mutually exclusive and at least one is required: guessing a lecture
 * from a course name is how a citation ends up pointing at the wrong PDF. A matching indexed file
 * keeps its course provenance even when selected by path; selection never grants permission.
 *
 * @returns `{ target, spelling, source }`.
 */
async function resolveSource({ args, gateway, projectRoot, records, signal }) {
  const rawFileId = typeof args.file_id === 'string' && args.file_id.trim().length > 0 ? args.file_id.trim() : null
  const rawPath = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : null

  if (rawFileId !== null && rawPath !== null) {
    const error = new Error('pass either file_id or path, not both: which file to read must be unambiguous')
    error.code = 'PROFESSOR_MATERIAL_SOURCE_INVALID'
    throw error
  }
  if (rawFileId === null && rawPath === null) {
    const error = new Error(
      'a source is required: pass file_id (from professor_course_list / the file index) or an explicit path. '
      + 'The reader never guesses which lecture you meant.',
    )
    error.code = 'PROFESSOR_MATERIAL_SOURCE_MISSING'
    throw error
  }

  if (rawFileId !== null) {
    const record = records.find((entry) => entry.file_id === rawFileId)
    if (record === undefined || record.index_status === 'missing') {
      const error = new Error(`file_id "${rawFileId}" is not in the current file index (or its file is missing)`)
      error.code = 'PROFESSOR_MATERIAL_SOURCE_MISSING'
      throw error
    }
    const spelling = record.canonical_relative_path ?? record.relative_path
    const target = await gateway.resolveTarget(spelling, { cwd: projectRoot, signal })
    return {
      target,
      spelling,
      source: {
        kind: 'indexed',
        file_id: record.file_id,
        relative_path: record.relative_path,
        course_id: record.course_id ?? null,
        category: record.category ?? null,
        file_type: record.file_type,
        content_hash: typeof record.content_hash === 'string' && record.content_hash.length > 0
          ? record.content_hash
          : null,
        // The index's own freshness evidence. An indexed hash is only trustworthy while the file
        // still has the filesystem version it had when the index recorded it — otherwise the ledger
        // would key a *changed* lecture on a stale hash and suppress a read that must happen.
        fs_version: typeof record.fs_version === 'string' ? record.fs_version : null,
        authorization: 'index',
      },
    }
  }

  const target = await gateway.resolveTarget(rawPath, { cwd: projectRoot, signal })
  let indexed = null
  for (const record of records) {
    if (record.index_status === 'missing') continue
    const recordTarget = await gateway.resolveTarget(record.canonical_relative_path ?? record.relative_path, { cwd: projectRoot, signal })
    if (gateway.canonical(recordTarget) === gateway.canonical(target)) { indexed = record; break }
  }
  return {
    target,
    spelling: rawPath,
    source: {
      kind: 'explicit-path',
      file_id: null,
      relative_path: null,
      course_id: indexed?.course_id ?? null,
      category: indexed?.category ?? null,
      file_type: rawPath.split('.').pop()?.toLowerCase() ?? '',
      content_hash: null,
      fs_version: null,
      authorization: 'configured-read-root',
    },
  }
}

/** Derive the source identity everything else is keyed on. */
async function sourceIdentity({ gateway, target, source, signal }) {
  const info = await gateway.stat(target, signal)
  if (info === undefined) {
    const error = new Error('the source file could not be found (or is no longer readable)')
    error.code = 'PROFESSOR_MATERIAL_SOURCE_MISSING'
    throw error
  }
  // Trust the index's hash only while the file still carries the filesystem version that hash was
  // recorded against; otherwise hash now. This is the same freshness rule the indexer itself uses.
  if (source.content_hash !== null
    && (source.fs_version === null || info.version === source.fs_version)) {
    return { ...source, bytes: info.size ?? null }
  }
  try {
    const hashed = await gateway.hashFile(target, signal)
    return { ...source, content_hash: hashed.sha256, bytes: hashed.bytes }
  } catch (error) {
    const failure = new Error(`the source file could not be hashed: ${error.message}`)
    failure.code = 'PROFESSOR_MATERIAL_SOURCE_MISSING'
    throw failure
  }
}

/**
 * Define the tool.
 *
 * @param options.resolveProject - workspace resolver, which may report an unbound workspace.
 * @param options.gateway - filesystem gateway.
 * @param options.policiesFor - `(projectRoot) => { read, write }`.
 * @param options.capabilities - probed extraction capability map.
 * @param options.run - the production extraction runner.
 * @param options.render - the production page renderer.
 * @param options.ensureProbed - `async (signal) => capabilities`.
 * @param options.ledger - the reading ledger (defaults to a private one).
 * @param options.ctx - plugin context (attachment + model services).
 * @param options.budget - budget overrides.
 * @param options.logger - plugin logger.
 * @returns the tool definition.
 */
export function defineMaterialReadTool(options) {
  const {
    resolveProject, gateway, policiesFor, capabilities = {}, run, render, enhance, ensureProbed, runtimeFor,
    ctx, logger, telemetry, budget: budgetOverrides,
  } = options
  const ledger = options.ledger ?? createReadingLedger({ budget: budgetOverrides })
  const budget = ledger.budget ?? resolveBudget(budgetOverrides)

  /** Plain-text envelope appended after the JSON so an image-free reader still sees the verdict. */
  function describe(payload) {
    const lines = [
      `action: ${payload.action}`,
      `source: ${payload.source.relative_path ?? payload.source.path ?? payload.source.file_id ?? 'unknown'}`,
      `coverage: ${payload.coverage.statement}`,
      `budget: ${payload.budget.scope} scope, ${payload.budget.session.bytes.used}/${payload.budget.session.bytes.limit} image bytes used, ${payload.budget.suppressed} repeat read(s) suppressed`,
      `image delivery: ${payload.image_delivery.status}`,
    ]
    if (payload.continuation !== null) lines.push(`next: ${payload.continuation}`)
    return lines.join('\n')
  }

  /** The model-facing content blocks: one JSON/text envelope plus one image block per emitted page. */
  function projectMaterialResult(_args, value) {
    const images = (value.pages ?? [])
      .filter((entry) => entry.image !== null && entry.image !== undefined)
      .map((entry) => ({
        type: 'image',
        attachment: {
          attachmentId: entry.image.attachment_id,
          mediaType: entry.image.media_type,
          bytes: entry.image.bytes,
          width: entry.image.width,
          height: entry.image.height,
          ...(entry.image.name === undefined ? {} : { name: entry.image.name }),
        },
      }))
    return [{ type: 'text', text: `${describe(value)}\n\n${JSON.stringify(value)}` }, ...images]
  }

  return {
    name: MATERIAL_READ_TOOL_NAME,
    description:
      'Read course material with a bounded, non-repetitive plan: text layer first, then at most a few page images per call. '
      + 'Always start with action "plan" to get the explicit per-page reading plan (whole document or a section). Plan and '
      + 'status excerpts are short OVERVIEWS, never the source body: call action "text" (bounded per call; continue with '
      + 'text_offset=content.next_offset) whenever you need a page\'s actual body, and action "pages" for the pages the plan '
      + 'marks as needing visual inspection. Every inspected page is tracked by source hash + physical page + render variant: '
      + 'a page you already saw is NOT attached a second time, so never re-read a page just because an earlier image was '
      + 'offloaded — read the text excerpt and note that this call returns instead, or pass reason "unreadable" / '
      + '"explicit-user-request" when you genuinely must see it again. On every call, pass notes[] for the pages you have '
      + 'already looked at: those notes are what survive image offload and lets you keep teaching without re-attaching images. '
      + 'Coverage reports DELIVERY only — inspected (page image included in the result) / text_complete / text_partial / '
      + 'overview_only (excerpt returned, body NOT read) / noted / unread / unreadable; it proves the content reached you, '
      + 'never that you comprehended or used it, and search hits are never coverage. Only the pages you name are rendered: '
      + 'passing [1, 10] renders those two and never pages 2-9, and every requested page comes back with an explicit '
      + 'outcome (inspected, reused, or not-delivered with the reason). A page another call for this session is reading '
      + 'right now is reported not-delivered instead of being rendered twice. Page numbers are physical 1-based '
      + 'positions in the file — printed/footer numbering is not parsed and no mapping is claimed. Read-only: it never '
      + 'writes material, indexes, state or memory.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...MATERIAL_ACTIONS], description: 'plan = reading overview with bounded excerpts (not full bodies); text = source body (up to 6 pages/32000 characters per call, use from/to and continue with text_offset); enhance = local OCR/structure for up to 6 PDF pages when the enhancement runtime is prepared; pages = page images; status = coverage and notes.' },
        file_id: { type: 'string', description: 'Indexed file to read (from the file index). Mutually exclusive with path.' },
        path: { type: 'string', description: 'File selector within configured read roots. Mutually exclusive with file_id; works without a course or index. Supplying a path does not grant access.' },
        course: { type: 'string', description: 'Optional course filter for a file_id lookup: a canonical course_id or a unique course code. Ambiguous or unknown is an explicit error.' },
        pages: { type: 'array', items: { type: 'number' }, description: 'Physical page numbers to attach (action "pages"). At most the per-call page budget is attached; the rest are reported, not silently dropped.' },
        from: { type: 'number', description: 'First physical page of a range (1-based, inclusive).' },
        to: { type: 'number', description: 'Last physical page of a range (1-based, inclusive).' },
        max_side: { type: 'number', description: 'Long edge of a rendered page in pixels (default from the budget; capped by the deployment image limits).' },
        quality: { type: 'number', description: 'JPEG quality 1-95 for a rendered page (default from the budget).' },
        notes: { type: 'array', items: { type: 'object' }, description: 'Your short per-page notes for pages you already inspected: [{page, text}]. Persisted in the reading ledger and returned by "status", so they survive image offload. This is how you continue a lecture without re-reading images.' },
        reason: { type: 'string', enum: ['unreadable', 'explicit-user-request'], description: 'Justification to attach a page that is already recorded as inspected. Source changes and higher-resolution variants never need it.' },
        refresh: { type: 'boolean', description: 'Rebuild the reading plan from the text layer even if a fresh one is cached for this source (default false).' },
        text_offset: { type: 'number', description: 'Zero-based character offset in selected source blocks (action text). Continue using content.next_offset with the same source and range.' },
      },
    },
    /**
     * The host's tool-output contract is `output: { schema, render }`: the installed Harness calls
     * `tool.output.render(exec.arguments, value)` when it materializes a successful result
     * (`@deepseek-ai/dsh-tools` `createSuccessResult`), and the blocks it returns become the
     * model-facing `tool/result` content. The image projection therefore lives HERE — on
     * `output.render`, the same placement the host's own `read_image` tool uses — never on a
     * definition-level `render` field, which the host does not consult.
     */
    output: jsonOutput({
      type: 'object',
      properties: {
        action: { type: 'string' },
        source: { type: 'object' },
        numbering: { type: 'object' },
        plan: { type: 'object' },
        pages: { type: 'array' },
        coverage: { type: 'object' },
        budget: { type: 'object' },
        image_delivery: { type: 'object' },
        continuation: oneOfTypes('string', 'null'),
        warnings: { type: 'array' },
        content: { type: 'object' },
        enhancement: { type: 'object' },
      },
      required: ['action', 'source', 'numbering', 'plan', 'pages', 'coverage', 'budget', 'image_delivery', 'continuation', 'warnings'],
    }, projectMaterialResult),

    async execute(args = {}, exec) {
      const sessionId = sessionIdOf(exec) ?? 'no-session'
      try {
        assertNotCancelled(exec?.signal)
        // One session's reads are serialised end to end. Reservations inside `runBody` are what
        // stop a *single* call from spending the same remaining capacity twice; this lock is what
        // stops two overlapping calls from rendering and attaching the same unchanged page. It is
        // keyed by session id, so unrelated sessions never queue behind each other, and a caller
        // aborted while it waits is rejected instead of running.
        return await ledger.withLock(
          sessionId,
          () => runBody({ args, exec, sessionId }),
          { signal: exec?.signal },
        )
      } catch (error) {
        // A tool failure is recorded as its own event so a slow model, a permission wait and a
        // broken tool can never be confused for one another in the log.
        if (typeof telemetry === 'function') {
          telemetry('tool.failed', { code: error?.code ?? 'unknown', reason: String(error?.name ?? 'Error') })
        }
        throw error
      }
    },
  }

  /**
   * The body of one material read. Runs under this session's lock.
   *
   * Every ledger mutation here happens in a block that contains no `await`, which is what makes a
   * reservation atomic: capacity is checked and held in the same synchronous step, so no other
   * call can observe the amount that was just taken.
   */
  async function runBody({ args, exec, sessionId }) {
    const project = await resolveProject(exec)
    const signal = exec?.signal
    const warnings = []
    const action = MATERIAL_ACTIONS.includes(args.action) ? args.action : 'plan'
    assertNotCancelled(signal)

    const turnIndex = readTurnIndex(exec)
    const turn = ledger.beginTurn(sessionId, turnIndex)

    const policies = policiesFor(project.root, [], { bound: project.bound !== false })

    const records = project.bound === false && typeof args.path === 'string'
      ? []
      : await readIndexRecords({ gateway, projectRoot: project.root, signal, optional: typeof args.path === 'string' })
    const { target, spelling, source: resolved } = await resolveSource({
      args, gateway, projectRoot: project.root, records, signal,
    })
    if (project.bound === false && resolved.kind === 'explicit-path') {
      const workspace = await gateway.resolveTarget(project.root, { signal })
      // A standalone user-selected file inside this conversation's workspace is readable.
      // Add only this canonical file, leaving course roots and all write roots unchanged.
      if (isInside(gateway.canonical(workspace), gateway.canonical(target))) policies.read.add(gateway.canonical(target))
    }
    // A path is only a selector. Check it before stat/hash or any backend execution.
    policies.read.assert(spelling, gateway.canonical(target))
    if (typeof args.course === 'string' && args.course.trim().length > 0) {
      const loaded = await loadProject({ gateway, projectRoot: project.root, signal })
      const document = loaded.present && loaded.document !== null && loaded.unsupported === null ? loaded.document : null
      if (document === null) {
        const error = new Error('course filter cannot be applied: the project course list could not be read')
        error.code = 'PROFESSOR_COURSE_MISSING'
        throw error
      }
      const outcome = resolveCourseFilter(document, args.course.trim())
      if (outcome.status === 'found') {
        if (resolved.course_id !== null && resolved.course_id !== outcome.course.course_id) {
          const error = new Error(`file_id belongs to "${resolved.course_id}", not the requested course "${outcome.course.course_id}"`)
          error.code = 'PROFESSOR_COURSE_MISMATCH'
          throw error
        }
      } else if (outcome.status === 'ambiguous') {
        const error = new Error(`course filter "${args.course}" is ambiguous: pass an exact course_id`)
        error.code = 'PROFESSOR_COURSE_AMBIGUOUS'
        throw error
      } else {
        const error = new Error(`course filter "${args.course}" matches no registered course`)
        error.code = 'PROFESSOR_COURSE_MISSING'
        throw error
      }
    }

    const source = await sourceIdentity({ gateway, target, source: resolved, signal })
    const extension = source.file_type ?? backendFamilyFor(spelling.split('.').pop() ?? '')
    if (typeof ensureProbed === 'function') await ensureProbed(signal)
    const runtime = typeof runtimeFor === 'function'
      ? await runtimeFor({ workspace: project.root, action, extension, signal }) : { run, render, enhance, capabilities }
    const guardedRun = typeof runtime.run === 'function' ? spec => runtime.run(spec, policies.read) : undefined
    const guardedRender = typeof runtime.render === 'function' ? spec => runtime.render(spec, policies.read) : undefined
    // Notes are keyed by the *source identity*, so they can only be recorded once the file has
    // been resolved and hashed — a note stored under a placeholder key would never be found
    // again by coverage, which is exactly the durability this tool exists to provide.
    applyNotes({ ledger, sessionId, sourceHash: source.content_hash, notes: args.notes, warnings })

    // --- plan (cached per session + source hash) --------------------------------
    const cached = args.refresh === true ? null : ledger.planFor(sessionId, source.content_hash)
    let plan = cached?.plan ?? null
    // A source hash can stay unchanged while its previously unavailable parser becomes usable.
    if (extension === 'pdf' && plan?.total_pages == null && runtime.capabilities?.pdfInterpreter) plan = null
    if (plan === null) {
      const outcome = await readTextLayer({ target, spelling, extension, guardedRun, capabilities: runtime.capabilities, signal })
      plan = buildReadingPlan({
        pages: outcome.pages ?? [],
        totalPages: outcome.totalPages,
        textAvailable: outcome.status === 'extracted',
        textReason: outcome.status === 'extracted' ? null : outcome.reason,
      })
      plan.unit = outcome.unit
      plan.source_blocks = outcome.blocks ?? (outcome.pages ?? []).map(entry => ({
        page: entry.page, text: String(entry.text ?? ''), origin: 'source',
      }))
      if (Array.isArray(outcome.notes) && outcome.notes.length > 0) plan.warnings.push(...outcome.notes)
      if (Array.isArray(outcome.truncated) && outcome.truncated.length > 0) plan.warnings.push(...outcome.truncated)
      if (plan.total_pages === null && plan.per_page.length === 0) {
        plan.warnings.push(
          'page coordinates are not available for this document, so no per-page plan or coverage can be produced; '
          + 'cite sections instead of pages and say so',
        )
      }
      ledger.storePlan(sessionId, source.content_hash, plan)
      if (typeof telemetry === 'function') {
        telemetry('material.plan', {
          action,
          pages: plan.per_page.length,
          total: plan.total_pages,
          unread: plan.needs_visual.length + plan.no_text_layer.length,
          status: 'built',
        })
      }
    }
    if (typeof args.from === 'number' || typeof args.to === 'number') {
      // The cached plan covers the whole document; a narrower request only re-scopes the view,
      // reusing the classifications that were already derived from the full text layer.
      plan = rescopeReadingPlan(plan, { from: args.from, to: args.to })
    }

    const scopePages = plan.per_page.map((entry) => entry.page)
    const variant = renderVariant({
      maxSide: normalizeMaxSide(args.max_side, budget, ctx),
      quality: normalizeQuality(args.quality, budget),
    })

    const payload = {
      action,
      source: { ...source, path: spelling },
      numbering: numberingContract(),
      // The plan *object* stays complete for this call's own logic (scope, classification,
      // coverage); only the excerpt rows the payload carries are bounded, and the bounding is
      // reported on the plan itself rather than passed off as full coverage.
      plan: compactPlan(plan),
      pages: [],
      coverage: { statement: '' },
      budget: null,
      image_delivery: { status: 'not-requested' },
      continuation: null,
      warnings,
    }

    // Delivery staging: nothing is recorded as delivered until the model-facing projection has
    // succeeded, so an output failure can never mark pages read that the model never received.
    const staged = { inspections: [], textSegments: [] }

    let sourceBlocks = plan.source_blocks ?? []
    if (action === 'enhance') {
      if (extension !== 'pdf') throw new Error('enhance currently supports PDF files only')
      const selection = requestedPages({ args, plan, warnings })
      if (selection.outOfRange.length) throw new Error('enhancement page selection is outside the document')
      const pages = selection.inRange.length ? selection.inRange : scopePages.length ? scopePages.slice(0, 6) : [1]
      const enhanced = typeof runtime.enhance === 'function'
        ? await runtime.enhance({ sourcePath: gateway.canonical(target), spelling, pages,
          sourceHash: source.content_hash, readPolicy: policies.read, signal })
        : { status: 'unavailable', pages: [], reason: 'enhancement runtime is not prepared' }
      sourceBlocks = enhanced.status === 'enhanced'
        ? enhanced.pages.flatMap(entry => (entry.blocks?.length ? entry.blocks
          : [{ text: entry.text, origin: 'enhanced-extraction' }])
        // Every block of an enhanced page belongs to that physical page. Blocks that do not
        // carry their own page number inherit it, so sibling blocks aggregate per page instead
        // of colliding as anonymous bodies.
          .map(block => (Number.isInteger(block.page) ? block : { ...block, page: entry.page })))
        : []
      payload.enhancement = { ...enhanced, pages: (enhanced.pages ?? []).map(entry => ({
        page: entry.page, ocr_completed: entry.ocr_completed === true,
        unresolved: entry.unresolved ?? [], blocks: entry.blocks?.length ?? 0,
      })) }
      if (enhanced.reason) warnings.push(enhanced.reason)
      warnings.push(...(enhanced.warnings ?? []))
    }
    if (action === 'text' || action === 'enhance') {
      const all = sourceBlocks.filter(entry => action === 'enhance' || entry.page === undefined || scopePages.includes(entry.page))
      const offset = args.text_offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('text_offset must be a non-negative safe integer')
      let skip = offset
      let remaining = TEXT_CALL_LIMIT
      const blocks = []
      const totalChars = all.reduce((sum, entry) => sum + entry.text.length, 0)
      // Bodies first: every block belongs to exactly one page body (or the document body), laid
      // out at cumulative offsets with a stable body id, so a delivered slice is recorded against
      // the WHOLE body rather than against the block it happened to be cut from.
      const bodies = layoutTextBodies(all)
      for (const entry of all) {
        if (entry.text.length === 0) continue
        if (skip >= entry.text.length && entry.text.length > 0) { skip -= entry.text.length; continue }
        const text = entry.text.slice(skip, skip + remaining)
        // Record exactly the interval this response carries, as cumulative offsets within the
        // page's (or document's) full body, so coverage aggregates across every source block.
        const body = bodies.get(entry)
        staged.textSegments.push({
          page: Number.isInteger(entry.page) ? entry.page : null,
          bodyId: body.bodyId,
          start: body.base + skip,
          end: body.base + skip + text.length,
          length: body.length,
          origin: entry.origin ?? 'source',
        })
        skip = 0
        // Table cells duplicate the row text and can otherwise bypass the character limit.
        // Retain bounded row text and shape, never the unbounded duplicate cell array.
        const { cells, ...metadata } = entry
        blocks.push({ ...metadata, text, ...(Array.isArray(cells) ? {
          table_shape: [cells.length, Math.max(0, ...cells.map(row => row.length))], cells_omitted: true,
        } : {}) })
        remaining -= text.length
        if (remaining === 0 || blocks.length === TEXT_PAGE_LIMIT) break
      }
      const consumed = TEXT_CALL_LIMIT - remaining
      const truncated = offset + consumed < totalChars
      payload.content = { blocks, truncated, characters: TEXT_CALL_LIMIT - remaining,
        offset, next_offset: truncated ? offset + consumed : null }
      if (truncated) payload.warnings.push('source body was truncated; continue with text_offset=content.next_offset and the same range')
    }

    /** Overview rows this call's payload actually carries — the excerpts the model receives. */
    const overviewPagesOf = () => (payload.plan?.per_page ?? [])
      .filter((row) => row.excerpt !== null && row.excerpt !== undefined)
      .map((row) => row.page)

    /** Commit this call's staged delivery; the returned undo restores the pre-call state. */
    const commitStaged = () => ledger.commitDelivery(sessionId, {
      sourceHash: source.content_hash,
      inspections: staged.inspections,
      textSegments: staged.textSegments,
      overviewPages: overviewPagesOf(),
    })

    /**
     * The emission gate: run the ACTUAL `output.render` projection over the finished payload.
     *
     * This is the exact function the host calls when it materializes the result
     * (`tool.output.render(exec.arguments, value)`). A throw, or fewer image blocks than the
     * payload claims delivered, means the model would not receive what this call asserts — so the
     * commit is rolled back and the caller demotes its claims. Returns null on success.
     */
    const projectionGate = () => {
      try {
        const blocks = projectMaterialResult(null, payload)
        const expected = payload.image_delivery.images?.length ?? 0
        const emitted = blocks.filter((block) => block.type === 'image').length
        if (emitted !== expected) {
          return new Error(`the output projection carried ${emitted} image block(s) for ${expected} delivered page(s)`)
        }
        return null
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error))
      }
    }

    // --- status / plan / text / enhance: no images ------------------------------------
    if (action !== 'pages') {
      // A signal that arrived while the text layer or the enhancement ran stops the call here:
      // the model never receives this result, so nothing it staged may be recorded as delivered.
      assertNotCancelled(signal)
      const undo = commitStaged()
      payload.coverage = finalizeCoverage({ ledger, sessionId, source, plan, scopePages })
      payload.budget = ledger.budgetFor(sessionId, turn.scope)
      payload.image_delivery = { status: 'not-requested' }
      payload.continuation = continuationFor({ plan, coverage: payload.coverage, budget: payload.budget })
      const failure = projectionGate()
      if (failure !== null) {
        // The model would not receive this result at all: roll back every delivery claim, so
        // nothing that never reached the model is recorded as read.
        undo()
        warnings.push(
          `the model-facing output projection failed (${failure.message}); `
          + 'nothing this call read is recorded as delivered',
        )
        payload.coverage = finalizeCoverage({ ledger, sessionId, source, plan, scopePages })
        payload.continuation = continuationFor({ plan, coverage: payload.coverage, budget: payload.budget })
      }
      logger?.info?.(
        `material ${action}: ${source.relative_path ?? source.file_id ?? 'path'} pages=${plan.total_pages ?? '?'} `
        + `inspected=${payload.coverage.inspected_count} unread=${payload.coverage.unread_count} `
        + `budget=${payload.budget.session.bytes.used}/${payload.budget.session.bytes.limit}`,
      )
      return payload
    }

    // --- pages --------------------------------------------------------------------
    const selection = requestedPages({ args, plan, warnings })
    payload.plan = compactPlan(plan, { keep: selection.ordered })
    const route = await resolveImageRoute(ctx, exec)
    payload.image_delivery = {
      status: route.status,
      ...(route.model === undefined ? {} : { model: route.model }),
      ...(route.provider === undefined ? {} : { provider: route.provider }),
      ...(route.reason === undefined ? {} : { reason: route.reason }),
      images: [],
    }

    if (selection.ordered.length === 0) {
      warnings.push('no pages were requested: pass pages[] or a from/to range for action "pages"')
      payload.coverage = finalizeCoverage({ ledger, sessionId, source, plan, scopePages })
      payload.budget = ledger.budgetFor(sessionId, turn.scope)
      if (route.ok === true) payload.image_delivery.status = 'available-not-delivered'
      payload.continuation = continuationFor({ plan, coverage: payload.coverage, budget: payload.budget })
      return payload
    }

    const maxSide = normalizeMaxSide(args.max_side, budget, ctx)
    const quality = normalizeQuality(args.quality, budget)
    const perCall = perCallPageLimit({ ctx, budget })
    // Per-call counters live here, not in the ledger: they are private to this invocation, and
    // they are what makes the *cumulative* selection check honest (a loop that re-reads a stale
    // "used" value on every iteration can select four pages into a two-page gap).
    const callScope = {
      imagesUsed: 0,
      imagesLimit: perCall,
      bytesUsed: 0,
      bytesLimit: budget.maxBytesPerCall,
    }

    // Every page in this call ends up with exactly one outcome; nothing is dropped silently.
    const outcomes = new Map()
    const heldClaims = new Set()
    const outstanding = new Set()
    const track = (reservation) => { outstanding.add(reservation); return reservation }
    const drop = (reservation) => { outstanding.delete(reservation) }

    try {
      // ---- synchronous: classify, claim, reserve --------------------------------
      const reusable = []
      const candidates = []
      for (const page of selection.inRange) {
        const existing = ledger.find(sessionId, { sourceHash: source.content_hash, page })
        const decision = reuseDecision({ existing, variant, reason: args.reason })
        if (decision.reuse) {
          ledger.noteSuppressed(sessionId, 1)
          reusable.push({ page, existing })
          outcomes.set(page, { status: 'reused', suppression: SUPPRESSION.ALREADY_INSPECTED, ledgerRecord: existing })
          continue
        }
        if (decision.reason.startsWith('justified:')) ledger.noteJustified(sessionId, 1)
        const claim = ledger.claimPage(sessionId, { sourceHash: source.content_hash, page })
        if (!claim.ok) {
          outcomes.set(page, { status: 'not-delivered', suppression: SUPPRESSION.CONCURRENT, ledgerRecord: existing ?? null })
          continue
        }
        heldClaims.add(page)
        candidates.push({ page, existing, decision })
      }

      const selected = []
      for (const entry of candidates) {
        const hold = ledger.reserve(sessionId, { images: 1, bytes: 0, call: callScope })
        if (!hold.ok) {
          ledger.releaseClaim(sessionId, { sourceHash: source.content_hash, page: entry.page })
          heldClaims.delete(entry.page)
          outcomes.set(entry.page, {
            status: 'not-delivered',
            suppression: hold.unit === 'pages'
              ? SUPPRESSION.CALL_LIMIT
              : hold.unit === 'images'
                ? SUPPRESSION.IMAGE_LIMIT
                : SUPPRESSION.BUDGET_EXHAUSTED,
            ledgerRecord: entry.existing ?? null,
          })
          continue
        }
        track(hold.reservation)
        callScope.imagesUsed += 1
        selected.push({ ...entry, imageHold: hold.reservation })
      }
      for (const page of selection.outOfRange) {
        outcomes.set(page, { status: 'not-delivered', suppression: SUPPRESSION.OUT_OF_RANGE, ledgerRecord: null })
      }

      // Remaining capacity *now* — after every image slot this call has taken — is what bounds the
      // renderer, not the configured ceiling. The renderer can therefore never be asked to produce
      // more bytes than the call, the turn and the session still have left.
      const remaining = ledger.capacity(sessionId, callScope)

      // ---- render ----------------------------------------------------------------
      assertNotCancelled(signal)
      let rendered
      if (route.ok !== true) {
        rendered = { status: 'skipped', reason: route.status, pages: [], truncated: false }
      } else if (selected.length === 0) {
        rendered = { status: 'skipped', reason: SUPPRESSION.BUDGET_EXHAUSTED, pages: [], truncated: false }
      } else if (remaining.bytes < RENDER_FLOOR_BYTES) {
        rendered = { status: 'skipped', reason: SUPPRESSION.BUDGET_EXHAUSTED, pages: [], truncated: false }
        warnings.push(
          `the remaining image byte budget is ${remaining.bytes} ${COST_UNIT}, below the renderer's `
          + `${RENDER_FLOOR_BYTES}-byte floor, so no page was rendered; `
          + `${selected.length} requested page(s) are reported as not-delivered`,
        )
      } else if (guardedRender === null) {
        rendered = { status: 'skipped', reason: 'no-renderer', pages: [], truncated: false }
      } else {
        rendered = await renderPages({
          guardedRender,
          target,
          spelling,
          pages: selected.map((entry) => entry.page),
          maxSide,
          quality,
          maxTotalBytes: remaining.bytes,
          signal,
        })
      }
      // A signal that arrived while the renderer ran stops delivery here: nothing is attached and
      // no ledger record is written for work the caller abandoned.
      assertNotCancelled(signal)

      if (rendered.status !== 'rendered') {
        const reason = route.ok !== true
          ? route.status
          : rendered.reason === SUPPRESSION.BUDGET_EXHAUSTED
            ? SUPPRESSION.BUDGET_EXHAUSTED
            : rendered.reason === 'no-renderer'
              ? SUPPRESSION.NO_RENDERER
              : SUPPRESSION.RENDER_FAILED
        // The short code names the category; this names the actual backend verdict, so a caller can
        // tell "the renderer refused" from "the renderer is not installed here".
        if (rendered.status === 'failed') {
          warnings.push(`page rendering produced no image: ${rendered.reason}`)
        }
        for (const entry of selected) {
          outcomes.set(entry.page, { status: 'not-delivered', suppression: reason, ledgerRecord: entry.existing ?? null })
        }
      } else {
        if (rendered.truncated === true) {
          warnings.push('the renderer stopped early at its byte budget; the pages it did not reach are reported as not-delivered')
        }
        const produced = new Map(rendered.pages.map((page) => [page.page, page]))

        // ---- deliver --------------------------------------------------------------
        for (const entry of selected) {
          const page = produced.get(entry.page)
          if (page === undefined) {
            // Never claim a page the renderer did not hand back.
            outcomes.set(entry.page, {
              status: 'not-delivered',
              suppression: rendered.truncated === true ? SUPPRESSION.RENDERER_OMITTED : SUPPRESSION.RENDER_FAILED,
              ledgerRecord: entry.existing ?? null,
            })
            continue
          }
          assertNotCancelled(signal)

          const byteResult = ledger.reserve(sessionId, { images: 0, bytes: page.bytes, call: callScope })
          if (byteResult.ok === false) {
            outcomes.set(entry.page, {
              status: 'not-delivered',
              suppression: page.bytes > budget.maxBytesPerCall
                ? SUPPRESSION.PAGE_EXCEEDS_BUDGET
                : SUPPRESSION.BUDGET_EXHAUSTED,
              ledgerRecord: entry.existing ?? null,
            })
            continue
          }
          const byteHold = track(byteResult.reservation)
          callScope.bytesUsed += page.bytes

          const attachment = await attach({ attachments: route.attachments, page, warnings, maxSide })
          if (attachment === null) {
            ledger.release(sessionId, byteHold)
            drop(byteHold)
            callScope.bytesUsed -= page.bytes
            outcomes.set(entry.page, { status: 'not-delivered', suppression: SUPPRESSION.ATTACHMENT_FAILED, ledgerRecord: entry.existing ?? null })
            continue
          }

          // The bytes exist in the store now but have not been delivered. A signal that arrived
          // during the await must not turn stored bytes into an inspection the caller abandoned:
          // the holds are released by the `finally` and nothing is recorded.
          assertNotCancelled(signal)

          // A reference that cannot become a valid model-facing image block is not a delivery:
          // refuse it here so a broken attachment service can never produce a successful claim
          // (or a whole-result projection failure over non-lossless JSON like NaN dimensions).
          if (!isUsableAttachment(attachment)) {
            ledger.release(sessionId, byteHold)
            drop(byteHold)
            callScope.bytesUsed -= page.bytes
            warnings.push(
              `page ${page.page} could not be attached: the attachment service returned an unusable `
              + 'reference (missing or invalid id, media type, bytes or dimensions), so it cannot '
              + 'become a model-facing image block',
            )
            outcomes.set(entry.page, { status: 'not-delivered', suppression: SUPPRESSION.ATTACHMENT_INVALID, ledgerRecord: entry.existing ?? null })
            continue
          }

          // Validate what the attachment service actually charged *before* delivery: normalisation
          // can change the size, and a page that no longer fits must not reach the model.
          const actual = Number.isFinite(attachment.bytes) ? attachment.bytes : 0
          const delta = Math.max(0, actual - page.bytes)
          let deltaHold = null
          if (delta > 0) {
            const deltaResult = ledger.reserve(sessionId, { images: 0, bytes: delta, call: callScope })
            if (deltaResult.ok === false) {
              ledger.release(sessionId, byteHold)
              drop(byteHold)
              callScope.bytesUsed -= page.bytes
              warnings.push(
                `page ${page.page} grew from ${page.bytes} to ${actual} bytes when it was normalised, `
                + 'which no longer fits the remaining budget, so it was not delivered',
              )
              outcomes.set(entry.page, { status: 'not-delivered', suppression: SUPPRESSION.BUDGET_EXHAUSTED, ledgerRecord: entry.existing ?? null })
              continue
            }
            deltaHold = track(deltaResult.reservation)
            callScope.bytesUsed += delta
          } else {
            // Settled for less than was held: give the difference back to the call's counter.
            callScope.bytesUsed -= (page.bytes - actual)
          }

          ledger.settle(sessionId, byteHold, { images: 0, bytes: actual - delta })
          drop(byteHold)
          if (deltaHold !== null) {
            ledger.settle(sessionId, deltaHold, { images: 0, bytes: delta })
            drop(deltaHold)
          }
          ledger.settle(sessionId, entry.imageHold, { images: 1, bytes: 0 })
          drop(entry.imageHold)

          // Stage the inspection instead of recording it: nothing is marked delivered until the
          // model-facing projection has succeeded (see `commitStaged` / the emission gate below),
          // so a rendering failure can never suppress this page as already delivered.
          staged.inspections.push({
            page: page.page,
            sourceHash: source.content_hash,
            variant,
            status: 'inspected',
            emitted: true,
            bytes: actual,
            width: attachment.width,
            height: attachment.height,
            attachmentId: attachment.attachment_id,
            textChars: textCharsOf(plan, page.page),
            excerpt: excerptOf(plan, page.page),
          })
          const image = { ...attachment, bytes: actual, variant }
          outcomes.set(page.page, {
            status: 'inspected',
            suppression: entry.decision.reason.startsWith('justified:') ? entry.decision.reason : null,
            ledgerRecord: entry.existing ?? null,
            image,
          })
          payload.image_delivery.images.push({
            page: page.page,
            attachment_id: attachment.attachment_id,
            media_type: attachment.media_type,
            width: attachment.width,
            height: attachment.height,
            bytes: actual,
            variant,
          })
        }
      }

      // ---- report ----------------------------------------------------------------
      // Every hold that did not become a delivered page is returned *before* the budget is read,
      // so the numbers below describe what actually happened rather than what was merely intended.
      // (The `finally` is now a safety net for a throw, normally holding nothing.)
      for (const reservation of outstanding) ledger.release(sessionId, reservation)
      outstanding.clear()

      // Commit this call's staged delivery now, so coverage and page rows describe exactly what
      // is recorded; the emission gate below can still undo it all. A caller that abandoned the
      // call can never have anything recorded: the checks above already threw before reaching it.
      assertNotCancelled(signal)
      const undoDelivery = commitStaged()

      // One row per requested page, in ascending order: delivered, reused, or not-delivered with
      // the precise reason. An omitted page is never reported as rendered.
      for (const page of selection.ordered) {
        const outcome = outcomes.get(page) ?? {
          status: 'not-delivered',
          suppression: SUPPRESSION.RENDER_FAILED,
          ledgerRecord: null,
        }
        payload.pages.push(pageRow({
          plan,
          page,
          status: outcome.status,
          ledgerRecord: ledger.find(sessionId, { sourceHash: source.content_hash, page }) ?? outcome.ledgerRecord ?? null,
          suppression: outcome.suppression ?? null,
          image: outcome.image ?? null,
        }))
      }

      const counts = new Map()
      for (const outcome of outcomes.values()) {
        if (outcome.status !== 'not-delivered') continue
        counts.set(outcome.suppression, (counts.get(outcome.suppression) ?? 0) + 1)
      }
      const callLimited = counts.get(SUPPRESSION.CALL_LIMIT) ?? 0
      const imageLimited = counts.get(SUPPRESSION.IMAGE_LIMIT) ?? 0
      const byteLimited = (counts.get(SUPPRESSION.BUDGET_EXHAUSTED) ?? 0)
        + (counts.get(SUPPRESSION.PAGE_EXCEEDS_BUDGET) ?? 0)
      const refused = (count, why) => {
        if (count === 0) return
        warnings.push(
          `${count} page(s) were not attached because ${why}; `
          + 'they are listed as not-delivered rather than silently skipped',
        )
      }
      refused(callLimited, 'the per-call page budget is spent')
      refused(imageLimited, 'the per-turn image count is spent')
      refused(byteLimited, 'the image byte budget is spent')
      const concurrent = counts.get(SUPPRESSION.CONCURRENT) ?? 0
      if (concurrent > 0) {
        warnings.push(
          `${concurrent} page(s) are being read by another call for this session right now; `
          + 'they are reported as not-delivered here — ask for status again rather than re-reading them',
        )
      }

      payload.coverage = finalizeCoverage({ ledger, sessionId, source, plan, scopePages })
      payload.budget = ledger.budgetFor(sessionId, turn.scope)
      payload.continuation = continuationFor({ plan, coverage: payload.coverage, budget: payload.budget })
      // The route being *capable* of delivering is not the same as this call having delivered:
      // `delivered` is claimed only for image blocks the model-facing projection actually carries.
      if (payload.image_delivery.images.length > 0) {
        payload.image_delivery.status = 'delivered'
      } else if (route.ok === true) {
        payload.image_delivery.status = 'available-not-delivered'
      }

      // Emission gate: if the model-facing projection cannot carry what this call claims, no
      // delivery is claimed and nothing is recorded — an image the model never received must not
      // be suppressed later as already delivered.
      const gateFailure = projectionGate()
      if (gateFailure !== null) {
        undoDelivery()
        warnings.push(
          `the model-facing output projection failed (${gateFailure.message}); `
          + 'the rendered pages are reported as not-delivered and nothing is recorded as inspected',
        )
        for (const row of payload.pages) {
          if (row.image !== null && row.image !== undefined) {
            row.image = null
            row.status = 'not-delivered'
            row.suppression = SUPPRESSION.OUTPUT_FAILED
            row.provenance = { source_hash: source.content_hash, rendered_at: null, variant: null }
          }
        }
        payload.image_delivery.images = []
        payload.image_delivery.status = 'output-failed'
        payload.coverage = finalizeCoverage({ ledger, sessionId, source, plan, scopePages })
        payload.continuation = continuationFor({ plan, coverage: payload.coverage, budget: payload.budget })
      }
      if (typeof telemetry === 'function') {
        telemetry('material.suppressed', { suppressed: payload.budget.suppressed, justified: payload.budget.justified_rereads, count: payload.pages.length })
        telemetry('material.budget', {
          budget_scope: payload.budget.scope,
          bytes: payload.budget.session.bytes.used,
          images: payload.budget.turn.images.used,
          truncated: payload.budget.exhausted,
          turn: turnIndex,
        })
        telemetry('material.render', {
          status: route.status,
          images: payload.image_delivery.images.length,
          bytes: payload.image_delivery.images.reduce((sum, image) => sum + image.bytes, 0),
          truncated: rendered.truncated === true,
        })
      }
      logger?.info?.(
        `material pages: ${payload.pages.length} row(s), ${payload.image_delivery.images.length} image(s), `
        + `${payload.budget.suppressed} suppressed, budget ${payload.budget.session.bytes.used}/${payload.budget.session.bytes.limit}`,
      )
      return payload
    } finally {
      // Nothing may leak out of a cancellation, a refused attachment or a thrown renderer: every
      // reservation still held is returned and every claim is cleared, so the next call for this
      // session sees exactly what was delivered and nothing more.
      for (const reservation of outstanding) ledger.release(sessionId, reservation)
      outstanding.clear()
      for (const page of heldClaims) {
        ledger.releaseClaim(sessionId, { sourceHash: source.content_hash, page })
      }
      heldClaims.clear()
    }
  }

  // --- helpers ----------------------------------------------------------------------

  /**
   * Read the text layer (never the pixels) and report what came back.
   *
   * This goes to the extraction runner directly rather than through `extractFile`, because
   * `extractFile` drops pages whose extracted text is empty — and an empty page is precisely the
   * one a reading plan has to *see* in order to classify it `no_text_layer` and queue it for visual
   * inspection. Dropping it would make a scanned page silently vanish from the coverage report.
   */
  async function readTextLayer({ target, spelling, extension, guardedRun, capabilities: caps, signal }) {
    const family = backendFamilyFor(extension)
    // Text formats carry no page coordinates at all, so there is nothing to extract but the bytes.
    if (family === 'text') {
      const info = await gateway.stat(target, signal)
      if (info?.size > 4 * 1024 * 1024) return { status: 'unsupported', unit: 'document', pages: null, totalPages: null,
        reason: 'text source exceeds the 4 MiB byte limit; select a smaller source', notes: [] }
      const text = await gateway.readText(target, signal)
      return {
        status: 'extracted',
        unit: 'document',
        pages: null,
        totalPages: null,
        notes: [`${extension}: this format has no page coordinates; cite sections, not pages`],
        blocks: [{ text: text.slice(0, 4 * 1024 * 1024), origin: 'source' }],
        ...(text.length > 4 * 1024 * 1024 ? { truncated: ['source text capped at 4 MiB characters'] } : {}),
      }
    }
    if (typeof guardedRun !== 'function') {
      return {
        status: 'unsupported',
        unit: 'document',
        reason: 'no command runner is available in this context, so the text layer could not be read',
        pages: null,
        totalPages: null,
        notes: [],
      }
    }
    const spec = planExtraction({ extension, capabilities: caps })
    if (spec.supported !== true) {
      return {
        status: 'unsupported',
        unit: 'document',
        reason: spec.reason,
        pages: null,
        totalPages: null,
        notes: [],
      }
    }
    const outcome = await guardedRun({ plan: spec, target, extension, signal, spelling })
    if (outcome === null || outcome === undefined) {
      return {
        status: 'failed',
        unit: 'document',
        reason: 'the extraction backend returned no output',
        pages: null,
        totalPages: null,
        notes: [],
      }
    }
    if (outcome.status !== 'extracted') {
      const pages = Array.isArray(outcome.pages) ? outcome.pages : null
      return {
        status: outcome.status ?? 'failed',
        unit: 'document',
        reason: outcome.reason ?? 'the text layer could not be read',
        pages,
        totalPages: pages?.length ? Math.max(...pages.map(entry => entry.page ?? 0)) : null,
        notes: [],
      }
    }
    const paged = (Array.isArray(outcome.pages) ? outcome.pages : [])
      .filter((entry) => Number.isInteger(entry.page) && entry.page >= 1)
      .map((entry) => ({ page: entry.page, text: String(entry.text ?? ''),
        ...(Array.isArray(entry.visual_features) ? { visual_features: entry.visual_features } : {}),
      }))
    const hasPages = paged.length > 0
    // Unit coordinates (slides, sheets) are not pages and never become page coverage, but each
    // unit is still its own source block: document-body coverage then aggregates honestly across
    // every unit instead of one merged blob standing in for all of them.
    const unitBlocks = (Array.isArray(outcome.pages) ? outcome.pages : [])
      .filter((entry) => !Number.isInteger(entry.page))
      .map((entry) => ({
        text: String(entry.text ?? ''),
        origin: 'source',
        ...(Number.isInteger(entry.slide) ? { slide: entry.slide } : {}),
      }))
    return {
      status: 'extracted',
      // `unit` reports what the backend actually produced: PPTX yields slides, DOCX yields no
      // coordinates at all, PDF yields physical pages. Nothing is relabelled to look paged.
      unit: hasPages ? 'page' : 'document',
      pages: hasPages ? paged : null,
      blocks: hasPages ? paged.map(entry => ({ ...entry, origin: 'source' }))
        : unitBlocks.length > 0 ? unitBlocks
          : [{ text: String(outcome.text ?? ''), origin: 'source' }],
      totalPages: hasPages ? Math.max(...paged.map((entry) => entry.page)) : null,
      notes: Array.isArray(outcome.notes) ? outcome.notes : [],
      ...(Array.isArray(outcome.truncated) && outcome.truncated.length > 0
        ? { truncated: outcome.truncated }
        : {}),
    }
  }

  /**
   * Normalise what this call should try to attach.
   *
   * Duplicates collapse, the result is **ascending** (so a renderer that exhausts its byte budget
   * stops at a deterministic point the caller can name), entries that are not positive integers are
   * refused as invalid rather than quietly dropped, and a page past the end of the document becomes
   * its own reported outcome instead of disappearing from the payload.
   *
   * @returns `{ ordered, inRange, outOfRange }`.
   */
  function requestedPages({ args, plan, warnings }) {
    const raw = Array.isArray(args.pages) ? args.pages : []
    const ordered = []
    const invalid = []
    const seen = new Set()
    for (const value of raw) {
      const page = Number(value)
      if (!Number.isInteger(page) || page < 1) {
        invalid.push(value)
        continue
      }
      if (seen.has(page)) continue
      seen.add(page)
      ordered.push(page)
    }
    if (invalid.length > 0) {
      warnings.push(
        `${invalid.length} entr${invalid.length === 1 ? 'y' : 'ies'} in pages[] ${invalid.length === 1 ? 'is' : 'are'} `
        + `not a positive integer and ${invalid.length === 1 ? 'was' : 'were'} ignored: `
        + JSON.stringify(invalid.slice(0, 8)),
      )
    }

    if (ordered.length === 0) {
      const hasRange = Number.isInteger(args.from) || Number.isInteger(args.to)
      if (hasRange) {
        const from = Number.isInteger(args.from) ? args.from : plan.range.from
        const to = Number.isInteger(args.to) ? args.to : plan.range.to
        if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to)) {
          warnings.push('a page range was requested but the document has no page coordinates')
        } else {
          const low = Math.max(1, Math.min(from, to))
          const high = Math.max(from, to)
          const cap = plan.total_pages ?? MAX_PLAN_PAGES
          // Clamp to the document when its length is known: a range past the end is reported once,
          // rather than turned into a row per impossible page.
          const upper = plan.total_pages === null ? high : Math.min(high, plan.total_pages)
          for (let page = low; page <= upper && ordered.length < cap; page += 1) ordered.push(page)
          if (plan.total_pages !== null && high > plan.total_pages) {
            warnings.push(
              `the requested range ends at page ${high}, beyond the document `
              + `(${plan.total_pages} page(s)); it was clipped`,
            )
          }
        }
      } else if (plan.needs_visual.length > 0 || plan.no_text_layer.length > 0) {
        ordered.push(...new Set([...plan.no_text_layer, ...plan.needs_visual].sort((left, right) => left - right)))
      }
    }

    ordered.sort((left, right) => left - right)
    const total = plan.total_pages
    const inRange = total === null ? ordered : ordered.filter((page) => page <= total)
    const outOfRange = total === null ? [] : ordered.filter((page) => page > total)
    if (outOfRange.length > 0) {
      warnings.push(
        `${outOfRange.length} requested page(s) are beyond the document (${total} page(s)): `
        + `${outOfRange.join(', ')}; reported as not-delivered rather than dropped`,
      )
    }
    return { ordered, inRange, outOfRange }
  }

  /**
   * Render exactly the pages this call selected.
   *
   * The explicit list travels all the way to `render_pages.py`, so nothing between two requested
   * pages is rendered and no requested page is silently replaced by a capped range. Whatever comes
   * back that this call did not ask for is discarded — a renderer that overproduces must never turn
   * into an attachment nobody budgeted for.
   */
  async function renderPages({ guardedRender, target, spelling, pages, maxSide, quality, maxTotalBytes, signal }) {
    const outcome = await guardedRender({
      target,
      spelling,
      pages,
      maxSide,
      quality,
      maxTotalBytes,
      signal,
    })
    if (outcome?.status !== 'rendered') {
      return {
        status: 'failed',
        pages: [],
        reason: outcome?.reason ?? 'the renderer returned no outcome',
        truncated: false,
      }
    }
    const wanted = new Set(pages)
    return {
      status: 'rendered',
      truncated: outcome.truncated === true,
      pages: outcome.pages.filter((page) => wanted.has(page.page)),
      produced: outcome.pages.map((page) => page.page),
      reason: null,
    }
  }

  /** Hand rendered bytes to the attachment service; a refusal is reported, never swallowed. */
  async function attach({ attachments, page, warnings, maxSide }) {
    try {
      const ref = await attachments.saveImage({
        data: page.data,
        mediaType: 'image/jpeg',
        name: `page-${page.page}.jpg`,
      })
      return {
        attachment_id: ref.attachmentId,
        media_type: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
        rendered_max_side: maxSide,
      }
    } catch (error) {
      warnings.push(`page ${page.page} could not be attached: ${error?.message ?? String(error)}`)
      return null
    }
  }

  function textCharsOf(plan, page) {
    return plan.per_page.find((entry) => entry.page === page)?.text_chars ?? null
  }

  function excerptOf(plan, page) {
    return plan.per_page.find((entry) => entry.page === page)?.excerpt ?? null
  }

  function pageRow({ plan, page, status, ledgerRecord, suppression, image }) {
    const planned = plan.per_page.find((entry) => entry.page === page)
    return {
      page,
      status,
      text_chars: planned?.text_chars ?? null,
      excerpt: planned?.excerpt ?? null,
      classification: planned?.classification ?? 'unknown',
      note: ledgerRecord?.note ?? null,
      suppression: suppression ?? null,
      image: image === null || image === undefined ? null : {
        attachment_id: image.attachment_id,
        media_type: image.media_type,
        width: image.width,
        height: image.height,
        bytes: image.bytes,
        variant: image.variant,
        ...(image.rendered_max_side === undefined ? {} : { rendered_max_side: image.rendered_max_side }),
      },
      provenance: {
        source_hash: ledgerRecord?.sourceHash ?? null,
        rendered_at: ledgerRecord?.at ?? null,
        variant: ledgerRecord?.variant ?? null,
      },
    }
  }

  function finalizeCoverage({ ledger: led, sessionId, source, plan, scopePages }) {
    const block = led.coverage(sessionId, { sourceHash: source.content_hash, plan, scopePages })
    return { ...block, statement: coverageStatement(block) }
  }
}

/**
 * Lay selected source blocks out as bodies: one per physical page, or one document body for
 * formats without page coordinates, concatenated in delivery order.
 *
 * Each body gets a stable id ({@link textBodyId}) covering its version — plain versus enhanced,
 * and the exact body text — and every block gets its cumulative base offset inside its body. This
 * is what lets a delivered slice be recorded against the whole body across all of its blocks: one
 * block can never stand in for the rest, and equal-length blocks of different bodies never merge.
 *
 * @param entries - source blocks in delivery order (`{ page?, text, origin? }`).
 * @returns a Map from each entry to `{ bodyId, base, length }`.
 */
function layoutTextBodies(entries) {
  const keyOf = (entry) => (Number.isInteger(entry.page) ? entry.page : 'document')
  const groups = new Map()
  for (const entry of entries) {
    const key = keyOf(entry)
    let group = groups.get(key)
    if (group === undefined) {
      group = { parts: [], family: 'source' }
      groups.set(key, group)
    }
    if ((entry.origin ?? 'source') !== 'source') group.family = 'enhanced'
    group.parts.push(String(entry.text ?? ''))
  }
  const bodies = new Map()
  for (const [key, group] of groups) {
    bodies.set(key, {
      bodyId: textBodyId(group.family, group.parts),
      length: group.parts.reduce((sum, part) => sum + part.length, 0),
    })
  }
  const layout = new Map()
  const base = new Map()
  for (const entry of entries) {
    const key = keyOf(entry)
    const at = base.get(key) ?? 0
    layout.set(entry, { ...bodies.get(key), base: at })
    base.set(key, at + String(entry.text ?? '').length)
  }
  return layout
}

/** Record any notes the caller submitted, bounded and keyed to the resolved source. */
function applyNotes({ ledger, sessionId, sourceHash, notes, warnings }) {
  if (!Array.isArray(notes) || notes.length === 0) return
  if (notes.length > NOTES_PER_CALL) {
    warnings.push(`only the first ${NOTES_PER_CALL} notes of this call were stored (${notes.length} supplied)`)
  }
  let stored = 0
  for (const entry of notes.slice(0, NOTES_PER_CALL)) {
    const page = Number(entry?.page)
    if (!Number.isInteger(page) || page < 1) continue
    const outcome = ledger.setNote(sessionId, {
      sourceHash,
      page,
      text: entry?.text,
      budget: NOTE_LIMIT,
    })
    if (outcome.stored) stored += 1
  }
  if (stored === 0) warnings.push('notes were supplied but none had a valid physical page number')
}

/**
 * Clamp the requested long edge to a hard ceiling, not to the default.
 *
 * `budget.maxSide` is what a call gets when it asks for nothing; a call that deliberately asks for
 * more (a justified higher-resolution reread) is allowed up to the host's normalization ceiling and
 * the deployment's own dimension limit. Clamping to the default would silently make "render it
 * larger" impossible, which is one of the reread justifications the contract promises.
 */
function normalizeMaxSide(requested, budget, ctx) {
  let value = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : budget.maxSide
  value = Math.min(value, MAX_SIDE_CEILING)
  try {
    const limits = typeof ctx?.get === 'function' ? ctx.get('attachments')?.imageLimits : undefined
    if (Number.isFinite(limits?.maxImageDimension)) value = Math.min(value, limits.maxImageDimension)
  } catch {
    // No attachment service: the budget cap alone still applies.
  }
  return Math.max(64, value)
}

function normalizeQuality(requested, budget) {
  const value = Number.isFinite(requested) ? Math.floor(requested) : budget.quality
  return Math.min(95, Math.max(1, value))
}

/** How many pages one call may attach, never more than the deployment accepts per message. */
function perCallPageLimit({ ctx, budget }) {
  let limit = budget.maxPagesPerCall
  try {
    const limits = typeof ctx?.get === 'function' ? ctx.get('attachments')?.imageLimits : undefined
    if (Number.isFinite(limits?.maxImagesPerMessage)) limit = Math.min(limit, limits.maxImagesPerMessage)
  } catch {
    // Budget alone still bounds the call.
  }
  return Math.max(1, limit)
}

/**
 * Whether an attachment-service reference can become a valid model-facing image block.
 *
 * The host's image blocks carry `{ attachmentId, mediaType, bytes, width, height }` and the result
 * projection must be losslessly JSON-serializable — a `NaN` width would make the host reject the
 * ENTIRE result. Anything unusable is treated as an attachment failure before it is recorded.
 */
export function isUsableAttachment(ref) {
  return typeof ref?.attachment_id === 'string' && ref.attachment_id.length > 0
    && typeof ref?.media_type === 'string' && ref.media_type.length > 0
    && Number.isFinite(ref?.bytes) && ref.bytes >= 0
    && Number.isFinite(ref?.width) && ref.width > 0
    && Number.isFinite(ref?.height) && ref.height > 0
}

/**
 * The actionable continuation, or null when there is nothing left to do.
 *
 * A spent budget produces a next step rather than a loop: what is still unread, and which call
 * finishes it. Body text and visual inspection are separate next steps — an excerpt/overview page
 * needs `action: "text"`, a page with no text layer needs `action: "pages"`.
 */
function continuationFor({ plan, coverage, budget }) {
  const list = (pages) => `${pages.slice(0, 12).join(', ')}${pages.length > 12 ? ', …' : ''}`
  const bodyNeeded = [...(coverage.text_partial ?? []), ...(coverage.overview_only ?? [])]
    .sort((left, right) => left - right)
  const visualNeeded = coverage.unread ?? []
  const bodyAdvice = bodyNeeded.length === 0
    ? ''
    : `${bodyNeeded.length} page(s) still need their source body text (the overview excerpt is not the body): `
      + `${list(bodyNeeded)}. Call action "text" for them (bounded per call; continue with `
      + 'text_offset=content.next_offset and the same range).'
  if (budget?.exhausted === true && visualNeeded.length > 0) {
    return `image budget spent (${budget.session.bytes.used}/${budget.session.bytes.limit} bytes): ${visualNeeded.length} `
      + `page(s) still unread — ${list(visualNeeded)}. `
      + 'Continue from the text excerpts and your stored notes, ask for a later call with reason "explicit-user-request" '
      + 'only for a specific page you must see, and state plainly in your answer which pages you did not inspect.'
      + (bodyAdvice === '' ? '' : ` ${bodyAdvice}`)
  }
  const parts = []
  if (bodyAdvice !== '') parts.push(bodyAdvice)
  if (visualNeeded.length > 0) {
    parts.push(
      `${visualNeeded.length} page(s) still need visual inspection: ${list(visualNeeded)}. `
      + 'Call action "pages" for them in batches of at most the per-call budget.',
    )
  }
  return parts.length > 0 ? parts.join(' ') : null
}
