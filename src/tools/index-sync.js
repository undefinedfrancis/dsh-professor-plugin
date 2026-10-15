/**
 * `professor_index_sync` — build or refresh the project's file index.
 *
 * Security-relevant differences from the spike-era `professor_project_scan`:
 * - there is **no** free-form `root` parameter. The index is always written inside the calling
 *   conversation's project (`<projectRoot>/.professor/indexes/files.json`), so a model cannot aim
 *   a write at an arbitrary directory;
 * - reads and the write both go through the filesystem gateway, and the write is additionally
 *   fenced by the plugin's own write policy (`.professor/` only);
 * - source material is never modified; the index records `missing` entries instead of deleting
 *   records when files disappear.
 *
 * The behaviour lives in {@link runIndexSync} so Phase 3 onboarding can drive *the same* indexing
 * service from a confirmation rather than re-implementing it. The tool is a thin adapter: it
 * resolves the project and forwards.
 *
 * @module dsh-professor-spike/src/tools/index-sync
 */

import path from 'node:path'
import { createHash } from 'node:crypto'

import { buildFileIndex, FILE_INDEX_SCHEMA_VERSION } from '../indexer/index.js'
import { createClassifier, summarizeClassification } from '../indexer/classify.js'
import { removedSourcePrefixes, resolveExcludePaths } from '../indexer/exclude.js'
import { loadProject } from '../project/project.js'
import { projectPaths } from '../paths/roots.js'
import { jsonOutput, oneOfTypes } from './support.js'

export const INDEX_SYNC_TOOL_NAME = 'professor_index_sync'

/** Digest of the project document an index was built from (additive field, always written). */
function digestOf(raw) {
  if (typeof raw !== 'string') return null
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * Build or refresh the index for one project root.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.projectRoot - absolute project root (already resolved and validated by the caller).
 * @param options.policiesFor - `(projectRoot, outputRoots) => { read, write }`.
 * @param options.outputRootsFor - `(document) => string[]`; the configured artifact outputs.
 * @param options.logger - plugin logger.
 * @param options.rebuild - ignore the previous index and hash every file again.
 * @param options.session - calling session (sandbox policy).
 * @param options.signal - cancellation.
 * @returns the tool payload, including how many paths were excluded and how many skips occurred.
 * @throws `PROFESSOR_INDEX_SCHEMA_UNSUPPORTED` when the stored index carries a newer schema.
 */
export async function runIndexSync(options) {
  const {
    gateway, projectRoot, policiesFor, outputRootsFor, logger, rebuild = false, force = false,
    session, signal,
  } = options

  const layout = projectPaths(projectRoot)

  // Classification is derived from the project document: the indexer must never guess a course, so
  // a project that cannot be read leaves every record unassigned rather than attaching material to
  // a course on a hunch. The document is therefore read *first*, and the write policy (which
  // includes the configured output roots) is only derived from a successfully loaded document — a
  // missing or malformed project must not define the writable boundary.
  // Indexing is the one operation that must still work on a project it cannot classify: it records
  // the files and leaves every one of them `unassigned`. The decision table is explicit — absent
  // project (index, no assignment, no warning about a document that does not exist); unparseable,
  // unsupported-schema or validation-failing document (index, no assignment, warn once).
  // Classification never guesses, and the write policy below is only ever built from a document
  // that passed all of those checks.
  let document = null
  const loaded = await loadProject({ gateway, projectRoot, signal })
  const usable = loaded.present
    && loaded.document !== null
    && loaded.unsupported === null
    && (loaded.problems ?? []).length === 0
  if (usable) {
    document = loaded.document
  } else if (loaded.present) {
    logger?.warn(`project.yaml is unusable (${loaded.problems?.[0] ?? 'unreadable'}); indexing without course assignment`)
  }

  const policies = policiesFor(projectRoot, outputRootsFor(document))

  const rootTarget = await gateway.resolveTarget(projectRoot, { cwd: projectRoot, signal })
  const canonicalRoot = gateway.canonical(rootTarget)
  policies.read.assert(projectRoot, canonicalRoot)

  const excludePaths = await resolveExcludePaths({
    gateway, projectRoot: canonicalRoot, document, signal,
  })

  let previous = null
  if (rebuild !== true) {
    try {
      const indexTarget = await gateway.resolveTarget(layout.filesIndex, { cwd: projectRoot, signal })
      const info = await gateway.stat(indexTarget, signal)
      if (info !== undefined) {
        const parsed = JSON.parse(await gateway.readText(indexTarget, signal))
        if (parsed?.schema_version === FILE_INDEX_SCHEMA_VERSION) {
          previous = parsed
        } else {
          // Fail safe: a newer (or older) schema is never silently overwritten. Replacing it
          // requires an explicit `rebuild: true`, so a downgrade cannot destroy a newer index.
          const error = new Error(
            `existing index has schema_version ${parsed?.schema_version ?? 'none'}, but this plugin `
            + `supports ${FILE_INDEX_SCHEMA_VERSION}; refusing to overwrite it. `
            + 'Pass rebuild: true to replace it deliberately.',
          )
          error.code = 'PROFESSOR_INDEX_SCHEMA_UNSUPPORTED'
          throw error
        }
      }
    } catch (error) {
      // An absent or corrupt index is rebuilt; an unsupported schema must reach the caller.
      if (error?.code === 'PROFESSOR_INDEX_SCHEMA_UNSUPPORTED') throw error
      logger?.warn(`previous index unreadable (${error.message}); rebuilding`)
    }
  }

  // Freshness is decided by evidence from the *tree*, never by elapsed time: a file added to a
  // source root has to be found even if the index was written a minute ago, and an unchanged tree
  // must not be rewritten just because a teaching request asked what was already known. So the walk
  // below is a verification pass — nothing is re-hashed when a record still matches, and nothing is
  // written at all unless something actually differed, the project document changed, or the caller
  // asked for it (`force` / `rebuild`). This is what "do not rebuild the index on every teaching
  // request" means here: no rebuild, no write, and an explicit `status` that says which happened.
  const projectDigest = digestOf(loaded.raw)
  const digestMatches = previous !== null
    && typeof previous.project_digest === 'string'
    && previous.project_digest === projectDigest

  const { index, stats } = await buildFileIndex({
    gateway,
    root: canonicalRoot,
    rootTarget,
    previous,
    signal,
    followSymlinks: document?.indexing?.follow_symlinks === true,
    excludePaths,
    // A deleted course's folder stays walkable so it can be re-added; this is what stops a rebuild
    // from handing it back as an unassigned, searchable corpus (shared sub-directories survive).
    dropPrefixes: removedSourcePrefixes({ document, indexRoot: canonicalRoot }),
    classifier: createClassifier({ document, indexRoot: canonicalRoot }),
  })

  const differs = stats.added > 0 || stats.changed > 0 || stats.missing > 0 || stats.removed > 0
  const mustWrite = force === true || rebuild === true || previous === null
    || digestMatches !== true || differs
  const summary = summarizeClassification(index.files)

  if (!mustWrite) {
    // Verification found nothing to change: the stored index is left byte-identical. No write, no
    // version bump, no re-derived records — which is exactly what a teaching request should get.
    logger?.info(`index verified unchanged (${stats.total} record(s)); not rewritten`)
    return {
      status: 'unchanged',
      projectRoot: canonicalRoot,
      indexFile: path.join(projectRoot, '.professor', 'indexes', 'files.json'),
      schemaVersion: index.schema_version,
      total: stats.total,
      added: 0,
      changed: 0,
      reused: stats.reused,
      missing: 0,
      skipped: 0,
      removed: 0,
      assigned: stats.assigned,
      unassigned: stats.unassigned,
      excluded: excludePaths.length,
      classification: summary,
      projectDigest,
      freshness: {
        status: 'unchanged',
        generated_at: previous.generated_at ?? null,
        project_digest_match: true,
        verified: true,
        written: false,
        added: 0,
        changed: 0,
        note: 'the tree was verified against the stored index and nothing differed, so the index was '
          + 'not rewritten; verification stats every file, and a difference is reported as a normal '
          + 'sync (force: true skips straight to a full re-derivation)',
      },
      warnings: [],
    }
  }

  // Additive field: which project document this index was derived from. An index written before it
  // existed simply fails the freshness comparison once and is rewritten with it — a missing digest
  // is never trusted as a match.
  index.project_digest = projectDigest

  const written = await gateway.writeFile({
    filePath: layout.filesIndex,
    cwd: projectRoot,
    content: `${JSON.stringify(index, null, 2)}\n`,
    session,
    signal,
    writePolicy: policies.write,
  })

  return {
    status: 'synced',
    projectRoot: canonicalRoot,
    indexFile: written.canonicalPath,
    schemaVersion: index.schema_version,
    total: stats.total,
    added: stats.added,
    changed: stats.changed,
    reused: stats.reused,
    missing: stats.missing,
    skipped: stats.skipped,
    removed: stats.removed,
    assigned: stats.assigned,
    unassigned: stats.unassigned,
    excluded: excludePaths.length,
    classification: summary,
    projectDigest,
    freshness: {
      status: 'synced',
      generated_at: index.generated_at ?? null,
      project_digest_match: digestMatches,
      verified: true,
      written: true,
      added: stats.added,
      changed: stats.changed,
      note: 'the index was re-derived because the tree or the project document differed (or the '
        + 'caller passed force/rebuild); the next call re-verifies and, if nothing differs, leaves '
        + 'the file untouched',
    },
    warnings: [],
  }
}

/**
 * Define the tool.
 *
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`; course-owned tools
 *   receive a wrapper that throws `PROFESSOR_PROJECT_MISSING` for an unbound workspace.
 * @param options.gateway - filesystem gateway.
 * @param options.policiesFor - `(projectRoot, outputRoots) => { read, write }`.
 * @param options.outputRootsFor - `(document) => string[]`.
 * @param options.logger - plugin logger.
 * @returns the tool definition.
 */
export function defineIndexSyncTool(options) {
  const {
    resolveProject, gateway, policiesFor, outputRootsFor, logger,
  } = options

  return {
    name: INDEX_SYNC_TOOL_NAME,
    description: 'Build or refresh the file index of the current Professor project (.professor/indexes/files.json). It verifies the tree against the stored index and reports status "unchanged" when nothing differed — no rebuild and no write — so a teaching request never re-derives an index that is already correct; status "synced" means something actually differed (or force/rebuild was passed) and the index was rewritten. A verification stats every file and reports added/changed/missing counts, so a file added to a source root is always found. When it does write, it records path, type, size, filesystem version, content hash and the project-document digest for every source file, reuses unchanged records, keeps disappeared files as "missing", assigns each file to a course via the registered source roots and category rules (reporting classification_source and classification_confidence, leaving unmatched files unassigned), excludes configured artifact output roots so generated notes are never indexed as input, and never modifies source material or writes outside the project.',
    parameters: {
      type: 'object',
      properties: {
        rebuild: {
          type: 'boolean',
          description: 'Ignore the previous index and hash every file again (default false).',
        },
        force: {
          type: 'boolean',
          description: 'Walk the tree even when the existing index is fresh (default false). Use when a file may have been added since the index was generated.',
        },
      },
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        status: { type: 'string', description: '"unchanged" (tree verified, index not rewritten) or "synced" (something differed, index rewritten).' },
        projectRoot: { type: 'string' },
        indexFile: { type: 'string' },
        schemaVersion: { type: 'number' },
        total: { type: 'number' },
        added: { type: 'number' },
        changed: { type: 'number' },
        reused: { type: 'number' },
        missing: { type: 'number' },
        skipped: { type: 'number' },
        assigned: { type: 'number' },
        unassigned: { type: 'number' },
        excluded: { type: 'number', description: 'Configured output roots and indexing.exclude entries that were kept out of the index.' },
        removed: { type: 'number', description: 'Records dropped because they fall in a deleted course\'s material and no surviving course claims them.' },
        classification: { type: 'object', description: 'Counts by category and by classification source, with a note when nothing matched.' },
        projectDigest: oneOfTypes('string', 'null'),
        freshness: { type: 'object', description: 'Whether the tree was verified, whether the index was rewritten, and what that does and does not prove.' },
        warnings: { type: 'array' },
      },
      required: ['status', 'projectRoot', 'indexFile', 'schemaVersion', 'total', 'added', 'changed', 'reused', 'missing', 'skipped', 'assigned', 'unassigned', 'excluded', 'removed', 'classification', 'projectDigest', 'freshness', 'warnings'],
    }),

    async execute(args = {}, exec) {
      const project = await resolveProject(exec)
      return runIndexSync({
        gateway,
        projectRoot: project.root,
        policiesFor,
        outputRootsFor,
        logger,
        rebuild: args.rebuild === true,
        force: args.force === true,
        session: exec?.agent?.session,
        signal: exec?.signal,
      })
    },
  }
}

/**
 * Read a small summary of the stored index for diagnostics.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.projectRoot - absolute project root.
 * @param options.signal - cancellation.
 * @returns the summary, or null when the index is absent.
 */
export async function readIndexSummary({ gateway, projectRoot, signal }) {
  const layout = projectPaths(projectRoot)
  const target = await gateway.resolveTarget(layout.filesIndex, { cwd: projectRoot, signal })
  const info = await gateway.stat(target, signal)
  if (info === undefined) return null
  const parsed = JSON.parse(await gateway.readText(target, signal))
  const files = Array.isArray(parsed?.files) ? parsed.files : []
  return {
    schemaVersion: parsed?.schema_version ?? null,
    fileCount: files.length,
    generatedAt: parsed?.generated_at ?? null,
    indexPath: path.join(projectRoot, '.professor', 'indexes', 'files.json'),
    supported: parsed?.schema_version === FILE_INDEX_SCHEMA_VERSION,
    classification: summarizeClassification(files),
  }
}
