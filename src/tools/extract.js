/**
 * `professor_extract` — extract and chunk the project's source material (M8).
 *
 * Reads the file index, chooses an extraction backend per file from the probed capability map,
 * chunks what it can, and records an honest status on every record. It writes only under
 * `.professor/indexes/chunks/` (never source material), and reports unsupported formats as
 * `unsupported` with a reason instead of leaving them `pending` forever.
 *
 * ## Incremental by source hash (Phase 3)
 *
 * A chunk store records the `content_hash` of the source file it was derived from. Reuse therefore
 * requires **proof**: a store is skipped only when its recorded hash still equals the index's
 * current hash for that file. A file that changed is re-extracted, and a store written before this
 * field existed (hash unknown) is re-derived exactly once rather than being trusted. That is what
 * makes `professor_search` able to withhold superseded text — see `src/tools/search.js`.
 *
 * Nothing here watches the filesystem. The observed strategy is an explicit, on-demand comparison
 * of index records against chunk stores; a full scan happens only when a caller asks for one.
 *
 * The behaviour lives in {@link runExtraction} so Phase 3 onboarding can drive *the same* extraction
 * service from a confirmation. The tool is a thin adapter.
 *
 * @module dsh-professor-spike/src/tools/extract
 */

import { extractFile, normalizeForChunking } from '../extract/extract.js'
import { backendFamilyFor, summarizeCapabilities } from '../extract/capabilities.js'
import { chunkDocument } from '../extract/chunk.js'
import { readChunkStore, writeChunkStore } from '../extract/store.js'
import { loadProject } from '../project/project.js'
import { projectPaths } from '../paths/roots.js'
import { jsonOutput } from './support.js'

export const EXTRACT_TOOL_NAME = 'professor_extract'

/** Read the stored file index, or fail with a precise message. */
async function readIndex({ gateway, projectRoot, signal }) {
  const layout = projectPaths(projectRoot)
  const target = await gateway.resolveTarget(layout.filesIndex, { cwd: projectRoot, signal })
  const info = await gateway.stat(target, signal)
  if (info === undefined) {
    const error = new Error('no file index yet: run professor_index_sync first')
    error.code = 'PROFESSOR_INDEX_MISSING'
    throw error
  }
  const parsed = JSON.parse(await gateway.readText(target, signal))
  if (!Array.isArray(parsed?.files)) {
    const error = new Error('file index is unreadable or malformed: run professor_index_sync with rebuild: true')
    error.code = 'PROFESSOR_INDEX_MISSING'
    throw error
  }
  return parsed
}

/** Persist extraction statuses back onto the index, guarded by the gateway write path. */
async function writeIndex({
  gateway, projectRoot, index, session, signal, writePolicy,
}) {
  const layout = projectPaths(projectRoot)
  return gateway.writeFile({
    filePath: layout.filesIndex,
    cwd: projectRoot,
    content: `${JSON.stringify(index, null, 2)}\n`,
    session,
    signal,
    writePolicy,
  })
}

/**
 * Extract and chunk the indexed material of one project root.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.projectRoot - absolute project root.
 * @param options.policiesFor - `(projectRoot) => { read, write }`.
 * @param options.capabilities - probed capability map (filled in by `ensureProbed`).
 * @param options.run - production extraction runner: `(spec, readPolicy) => outcome`.
 * @param options.ensureProbed - `async (signal) => capabilities`; runs the backend probe once.
 * @param options.fileId - extract only this file.
 * @param options.course - extract only files belonging to this course id.
 * @param options.limit - stop after this many files.
 * @param options.rebuild - re-extract and re-chunk even when the store proves fresh.
 * @param options.session - calling session (sandbox policy).
 * @param options.signal - cancellation.
 * @returns the tool payload.
 * @throws `PROFESSOR_INDEX_MISSING` when there is no usable index.
 */
export async function runExtraction(options) {
  const {
    gateway, projectRoot, policiesFor, capabilities = {}, run, ensureProbed,
    fileId, course, limit: limitArg, rebuild = false, session, signal,
  } = options

  // Probe the extraction backends before doing any work: the probe is memoized per plugin
  // instance, so the first extraction pays for it and every later call reuses the observation.
  if (typeof ensureProbed === 'function') await ensureProbed(signal)
  const policies = policiesFor(projectRoot)
  // The runner receives the read policy on every call, so a file outside the approved read
  // roots is refused *before* a process is started on it.
  const guardedRun = typeof run === 'function' ? (spec) => run(spec, policies.read) : undefined
  const warnings = []

  // Classification and budget come from the project document; an unreadable project means we
  // cannot know budgets, so extraction still runs but with defaults and a warning.
  let document = null
  const loaded = await loadProject({ gateway, projectRoot, signal })
  if (loaded.present && loaded.document !== null && loaded.unsupported === null) document = loaded.document
  else if (loaded.unsupported !== null) warnings.push(`project.yaml unusable (${loaded.problems[0]}); using default budgets`)

  const index = await readIndex({ gateway, projectRoot, signal })
  const capSummary = summarizeCapabilities(capabilities)

  let selected = index.files.filter((record) => record.index_status !== 'missing')
  if (typeof fileId === 'string' && fileId.trim().length > 0) {
    selected = selected.filter((record) => record.file_id === fileId.trim())
  }
  if (typeof course === 'string' && course.trim().length > 0) {
    selected = selected.filter((record) => record.course_id === course.trim())
  }
  const limit = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : selected.length

  const results = []
  let extracted = 0
  let unsupported = 0
  let failed = 0
  let skipped = 0
  let reExtracted = 0
  let chunksWritten = 0
  let processed = 0

  for (const record of selected) {
    if (processed >= limit) break
    processed += 1

    const family = backendFamilyFor(record.file_type)
    const already = await readChunkStore({
      gateway, projectRoot, fileId: record.file_id, signal,
    })
    if (already.unsupported !== null) {
      warnings.push(already.problems[0])
      record.extraction_status = 'failed'
      record.errors = [...(Array.isArray(record.errors) ? record.errors : []), already.problems[0]]
      results.push({ file_id: record.file_id, status: 'failed', reason: already.problems[0] })
      failed += 1
      continue
    }

    const indexHash = typeof record.content_hash === 'string' && record.content_hash.length > 0 ? record.content_hash : null
    // Freshness must be *proven*, never assumed: the store's recorded source hash has to equal the
    // index's current hash for this file. An unknown hash on either side (a store written before
    // source hashes were recorded, or an index record without one) is not proof.
    const provenFresh = already.present
      && already.chunks.length > 0
      && already.sourceHash !== null
      && indexHash !== null
      && already.sourceHash === indexHash
    if (provenFresh && rebuild !== true) {
      skipped += 1
      record.extraction_status = 'extracted'
      results.push({
        file_id: record.file_id, status: 'skipped', chunks: already.chunks.length, reuse: 'source-hash-match',
      })
      continue
    }
    const reusing = already.present && already.chunks.length > 0
    const reuseReason = reusing
      ? already.sourceHash === null
        ? 'existing chunks carry no source hash, so freshness cannot be proven'
        : 'the source file changed since it was extracted'
      : null

    const target = await gateway.resolveTarget(record.canonical_relative_path ?? record.relative_path, {
      cwd: projectRoot,
      signal,
    })
    const outcome = await extractFile({
      gateway,
      target,
      extension: record.file_type,
      capabilities,
      signal,
      run: guardedRun,
      spelling: record.canonical_relative_path ?? record.relative_path,
    })

    if (outcome.status === 'extracted') {
      const text = normalizeForChunking(outcome.text ?? '')
      const budget = document?.retrieval?.max_chunks ?? 8
      const { chunks, dropped } = chunkDocument({
        text,
        fileId: record.file_id,
        maxChunks: Number.isInteger(budget) && budget > 0 ? budget * 64 : 512,
        pages: outcome.pages ?? null,
      })
      for (const chunk of chunks) {
        chunk.course_id = record.course_id ?? null
        chunk.category = record.category ?? null
        chunk.relative_path = record.relative_path
        chunk.file_type = record.file_type
        chunk.source_note = `extracted by ${outcome.extractor ?? 'unknown'}` + (dropped > 0 ? ` (${dropped} chunk(s) dropped by cap)` : '')
      }
      await writeChunkStore({
        gateway,
        projectRoot,
        fileId: record.file_id,
        chunks,
        session,
        signal,
        writePolicy: policies.write,
        sourcePath: record.relative_path,
        // Record what the chunks were derived from, so the next run can prove they are current.
        sourceHash: indexHash,
      })
      record.extraction_status = 'extracted'
      record.extractor = outcome.extractor ?? null
      record.errors = []
      extracted += 1
      if (reusing) reExtracted += 1
      chunksWritten += chunks.length
      for (const problem of outcome.truncated ?? []) warnings.push(`${record.relative_path}: ${problem}`)
      const paged = chunks.filter((chunk) => chunk.page !== null)
      const slided = chunks.filter((chunk) => chunk.slide !== null)
      results.push({
        file_id: record.file_id,
        status: 'extracted',
        extractor: outcome.extractor ?? null,
        chunks: chunks.length,
        bytes: outcome.bytes ?? null,
        pages: paged.length,
        slides: slided.length,
        ...(reuseReason === null ? {} : { reason: reuseReason }),
        // A chunk that reaches beyond the last page the backend reported is marked rather than
        // silently attributed to one page.
        coordinates: {
          paged: paged.length,
          slided: slided.length,
          ranged: chunks.filter((chunk) => Array.isArray(chunk.page_range) || Array.isArray(chunk.slide_range)).length,
          ambiguous: chunks.filter((chunk) => chunk.coordinate_ambiguous === true).length,
        },
        ...(dropped > 0 ? { dropped } : {}),
        ...((outcome.truncated ?? []).length > 0 ? { truncated: outcome.truncated } : {}),
      })
    } else if (outcome.status === 'unsupported') {
      record.extraction_status = 'unsupported'
      record.extractor = null
      record.errors = []
      unsupported += 1
      results.push({
        file_id: record.file_id, status: 'unsupported', family, reason: outcome.reason,
      })
    } else {
      record.extraction_status = 'failed'
      failed += 1
      record.errors = [outcome.reason]
      results.push({ file_id: record.file_id, status: 'failed', reason: outcome.reason })
    }
  }

  await writeIndex({
    gateway,
    projectRoot,
    index,
    session,
    signal,
    writePolicy: policies.write,
  })

  return {
    projectRoot,
    processed,
    extracted,
    reExtracted,
    unsupported,
    failed,
    skipped,
    chunksWritten,
    capabilities: capSummary,
    results,
    warnings,
  }
}

/**
 * Define the tool.
 *
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`; course-owned tools
 *   receive a wrapper that throws `PROFESSOR_PROJECT_MISSING` for an unbound workspace.
 * @param options.gateway - filesystem gateway.
 * @param options.policiesFor - `(projectRoot) => { read, write }`.
 * @param options.capabilities - probed capability map.
 * @param options.run - the production extraction runner.
 * @param options.ensureProbed - `async (signal) => capabilities`.
 * @param options.logger - plugin logger.
 * @returns the tool definition.
 */
export function defineExtractTool(options) {
  const {
    resolveProject, gateway, policiesFor, capabilities = {}, run, ensureProbed, logger,
  } = options

  return {
    name: EXTRACT_TOOL_NAME,
    description: 'Extract text from the indexed source files and chunk it for retrieval (writes .professor/indexes/chunks/<file_id>.json and updates extraction_status in the file index). Reuse is proved by source hash: a file whose content changed is re-extracted, and a chunk store written before source hashes were recorded is re-derived once. PDF text comes from an observed backend (bundled PyMuPDF, else Ghostscript) and Office documents from the bundled Python; page and slide numbers are carried into the chunks and citations when the backend reports them. Images and PDFs with no text layer are reported "unsupported" (OCR is disabled), never guessed at; nothing is rendered or visually inspected. Source material is never modified.',
    parameters: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Extract only this file (from the file index).' },
        course: { type: 'string', description: 'Extract only files belonging to this course id.' },
        limit: { type: 'number', description: 'Stop after this many files (default: all eligible).' },
        rebuild: { type: 'boolean', description: 'Re-extract and re-chunk every selected file even when its chunks are already fresh (default false).' },
      },
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        projectRoot: { type: 'string' },
        processed: { type: 'number' },
        extracted: { type: 'number' },
        reExtracted: { type: 'number', description: 'How many of the extracted files replaced chunks whose source had changed.' },
        unsupported: { type: 'number' },
        failed: { type: 'number' },
        skipped: { type: 'number' },
        chunksWritten: { type: 'number' },
        capabilities: { type: 'object' },
        results: { type: 'array' },
        warnings: { type: 'array' },
      },
      required: ['projectRoot', 'processed', 'extracted', 'reExtracted', 'unsupported', 'failed', 'skipped', 'chunksWritten', 'capabilities', 'results', 'warnings'],
    }),

    async execute(args = {}, exec) {
      const project = await resolveProject(exec)
      const payload = await runExtraction({
        gateway,
        projectRoot: project.root,
        policiesFor,
        capabilities,
        run,
        ensureProbed,
        fileId: args.file_id,
        course: args.course,
        limit: args.limit,
        rebuild: args.rebuild === true,
        session: exec?.agent?.session,
        signal: exec?.signal,
      })
      logger?.info(`extract: ${payload.extracted} extracted (${payload.reExtracted} superseded), ${payload.unsupported} unsupported, ${payload.failed} failed, ${payload.skipped} skipped`)
      return payload
    },
  }
}

/** Path helper exported for diagnostics and tests. */
export function chunksDirFor(projectRoot) {
  return projectPaths(projectRoot).chunksDir
}

/** Exposed so diagnostics can report the on-disk chunk count without re-reading every store. */
export async function countChunks({ gateway, projectRoot, signal }) {
  const dir = chunksDirFor(projectRoot)
  const target = await gateway.resolveTarget(dir, { cwd: projectRoot, signal })
  const info = await gateway.stat(target, signal)
  if (info === undefined) return { files: 0, chunks: 0 }
  const entries = await gateway.listDir(target, signal)
  let chunks = 0
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await gateway.readText(entry.target, signal))
      chunks += Array.isArray(parsed?.chunks) ? parsed.chunks.length : 0
    } catch {
      // an unreadable store is reported by the extract tool, not here
    }
  }
  return { files: entries.filter((entry) => entry.name.endsWith('.json')).length, chunks }
}
