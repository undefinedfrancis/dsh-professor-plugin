/**
 * Deterministic, incremental file index for a Professor project.
 *
 * Scope: discovery, stable ids, content hashing, change detection, course assignment and virtual
 * classification, written into the versioned `indexes/files.json` artifact. Assignment and
 * classification come from the registered project document (`createClassifier`); a record that no
 * rule covers stays `course_id: null` / `category: "unassigned"` and is visible in the index rather
 * than dropped. Extraction and chunking arrive in M8.
 *
 * Notable adaptation (documented in docs/AUDIT.md): the Harness filesystem seam exposes a branded
 * per-file `version`, not a raw mtime, so `mtime` is recorded as `null` and `fs_version` carries
 * change detection instead. That keeps every read inside `ctx.fs`.
 *
 * @module dsh-professor-spike/src/indexer
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

import { classifyRecords } from './classify.js'
import { isRemovedPath } from './exclude.js'

/** Schema version of `indexes/files.json`. */
export const FILE_INDEX_SCHEMA_VERSION = 1

/** Directories that are never indexed. */
export const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.git'])

/** The Professor project directory is never part of its own source corpus. */
export const PROJECT_DIRECTORY = '.professor'

/** Stable file id: derived from the project-relative path, so moving the project keeps ids. */
export function fileIdFor(relativePath) {
  return `f_${createHash('sha256').update(relativePath).digest('hex').slice(0, 16)}`
}

/** Lower-case extension without the dot, or the empty string. */
export function fileTypeOf(name) {
  return path.extname(name).replace(/^\./, '').toLowerCase()
}

function joinRelative(prefix, name) {
  return prefix.length === 0 ? name : `${prefix}/${name}`
}

/**
 * Walk the project through the filesystem gateway, collecting candidate files in deterministic
 * (code-point) order.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.rootTarget - resolved target of the project root.
 * @param options.signal - cancellation.
 * @param options.exclude - a `Set` of canonical absolute paths that are never sources (configured
 *   output roots: an AI Notes folder inside the course tree is generated data, not material).
 * @returns an array of `{ relativePath, target, size, fsVersion, fileType }`.
 */
export async function discoverFiles({
  gateway, rootTarget, signal, prefix = '', records = [], followSymlinks = false, skipped = [], exclude,
}) {
  const entries = await gateway.listDir(rootTarget, signal)
  const sorted = [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

  for (const entry of sorted) {
    if (entry.name.startsWith('.')) continue
    if (entry.type === 'directory') {
      if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.name === PROJECT_DIRECTORY) continue
      // A configured output root may legally live *inside* the course tree. Excluding it here is
      // what keeps generated notes out of the index without forbidding the layout.
      if (exclude !== undefined && exclude.size > 0 && exclude.has(gateway.canonical(entry.target))) {
        skipped.push({
          relativePath: joinRelative(prefix, entry.name),
          reason: 'excluded path (a configured output root or indexing.exclude entry)',
        })
        continue
      }
    } else if (entry.type !== 'file') {
      continue // special entries are never sources
    }

    // `listDir` reports a symlink's target type, so honouring `follow_symlinks: false` requires an
    // lstat per entry: otherwise a link inside the project would be indexed from outside it.
    if (followSymlinks === false) {
      const relativePath = joinRelative(prefix, entry.name)
      const info = await gateway.lstat(relativePath, { cwd: gateway.canonical(rootTarget), signal })
      if (info?.type === 'symlink') {
        skipped.push({ relativePath, reason: 'symlink (follow_symlinks is disabled)' })
        continue
      }
    }

    if (entry.type === 'directory') {
      await discoverFiles({
        gateway,
        rootTarget: entry.target,
        signal,
        prefix: joinRelative(prefix, entry.name),
        records,
        followSymlinks,
        skipped,
        exclude,
      })
      continue
    }

    if (typeof entry.size === 'number' && entry.size > 32 * 1024 * 1024) {
      skipped.push({ relativePath: joinRelative(prefix, entry.name), reason: 'file exceeds the 32 MiB indexing limit' })
      continue
    }
    records.push({
      relativePath: joinRelative(prefix, entry.name),
      target: entry.target,
      size: typeof entry.size === 'number' ? entry.size : null,
      fsVersion: entry.version,
      fileType: fileTypeOf(entry.name),
    })
  }
  return records
}

function recordFor(discovered, previous, signal, gateway, rootRelativeBase) {
  const fileId = fileIdFor(discovered.relativePath)
  const unchanged = previous !== undefined
    && previous.fs_version !== undefined
    && discovered.fsVersion !== undefined
    && previous.fs_version === String(discovered.fsVersion)
    && previous.size === discovered.size
    && typeof previous.content_hash === 'string'

  if (unchanged) {
    // Reused records are re-classified below (the project document may have changed since the
    // last run), so only the identity/content fields are carried forward from `previous`.
    return {
      ...previous,
      relative_path: discovered.relativePath,
      canonical_relative_path: discovered.relativePath,
      size: discovered.size,
      fs_version: String(discovered.fsVersion),
      index_status: 'indexed',
      last_indexed_at: previous.last_indexed_at,
      errors: [],
      _reclassify: true,
    }
  }

  return {
    schema_version: FILE_INDEX_SCHEMA_VERSION,
    file_id: fileId,
    relative_path: discovered.relativePath,
    canonical_relative_path: discovered.relativePath,
    file_type: discovered.fileType,
    course_id: null,
    category: 'unassigned',
    size: discovered.size,
    // The Harness fs seam exposes a branded version rather than a raw mtime; recorded as null.
    mtime: null,
    fs_version: discovered.fsVersion === undefined ? null : String(discovered.fsVersion),
    content_hash: null,
    extractor: null,
    index_status: 'new',
    extraction_status: 'pending',
    last_indexed_at: null,
    errors: [],
    _rootRelativeBase: rootRelativeBase,
    _target: discovered.target,
    _needsHash: true,
    _signal: signal,
    _gateway: gateway,
  }
}

/**
 * Build or refresh the file index.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.root - absolute project root.
 * @param options.rootTarget - resolved target of the project root.
 * @param options.previous - the previously stored index (any shape); reused for unchanged files.
 * @param options.signal - cancellation.
 * @param options.excludePaths - canonical absolute paths never indexed (configured output roots,
 *   `indexing.exclude`). Omitted or empty means "index everything under the root".
 * @param options.dropPrefixes - posix-relative prefixes whose *unassigned* records are dropped
 *   after classification (the material of a deleted course that a surviving course does not
 *   cover). Omitted means nothing is dropped.
 * @param options.now - injectable clock (tests) returning an ISO timestamp.
 * @returns `{ index, stats }` where index is the serialisable artifact; `stats.removed` counts the
 *   records dropped by `dropPrefixes`.
 */
export async function buildFileIndex(options) {
  const {
    gateway, root, rootTarget, previous, signal, now = () => new Date().toISOString(),
  } = options

  const classifier = options.classifier ?? (() => ({
    course_id: null,
    category: 'unassigned',
    classification_source: 'none',
    classification_confidence: 0,
  }))

  const previousById = new Map()
  const skipped = []
  const previousRecords = Array.isArray(previous?.files) ? previous.files : []
  for (const record of previousRecords) {
    if (typeof record?.file_id === 'string') previousById.set(record.file_id, record)
  }

  const discovered = await discoverFiles({
    gateway,
    rootTarget,
    signal,
    followSymlinks: options.followSymlinks === true,
    skipped,
    exclude: new Set(Array.isArray(options.excludePaths) ? options.excludePaths : []),
  })
  const timestamp = now()
  const seen = new Set()
  const files = []
  let added = 0
  let changed = 0
  let reused = 0

  for (const entry of discovered) {
    const fileId = fileIdFor(entry.relativePath)
    seen.add(fileId)
    const prior = previousById.get(fileId)
    const draft = recordFor(entry, prior, signal, gateway, root)

    if (prior === undefined) added += 1
    else if (draft._needsHash === true) changed += 1
    else reused += 1

    if (draft._needsHash === true) {
      const hashed = await gateway.hashFile(draft._target, signal)
      draft.content_hash = hashed.sha256
      draft.index_status = 'indexed'
      draft.last_indexed_at = timestamp
    }

    delete draft._target
    delete draft._needsHash
    delete draft._signal
    delete draft._gateway
    delete draft._rootRelativeBase
    delete draft._reclassify
    draft.mtime = draft.mtime ?? null
    files.push(draft)
  }

  // Files that existed before but are gone now are kept, marked `missing`, never deleted — an
  // index rebuild must not lose the record of material the user may have moved.
  let missing = 0
  for (const [fileId, record] of previousById) {
    if (seen.has(fileId)) continue
    missing += 1
    files.push({
      ...record,
      index_status: 'missing',
      errors: [...(Array.isArray(record.errors) ? record.errors : []), 'not found during the last scan'],
    })
  }

  // Course assignment and virtual classification run over the whole result set (present and
  // missing) so a record's course/category always reflect the *current* project document, even
  // when the file itself did not change. Every record therefore carries
  // classification_source / classification_confidence; an unmatched record stays unassigned.
  classifyRecords(files, classifier)

  // A deleted course's folder is still on disk and still walkable (it has to be, so the same
  // material can be re-added), which means classification alone would hand it back as an
  // `unassigned` record — immediately searchable again. Records inside a removed-source prefix are
  // therefore dropped *unless* a surviving course still claims them, which is what keeps a shared
  // sub-directory alive while the rest of the deleted folder stays out of the index.
  const dropPrefixes = Array.isArray(options.dropPrefixes) ? options.dropPrefixes : []
  let removedByDeletion = 0
  const kept = []
  for (const record of files) {
    if (record.course_id === null && isRemovedPath(dropPrefixes, record.relative_path)) {
      removedByDeletion += 1
      continue
    }
    kept.push(record)
  }
  files.length = 0
  files.push(...kept)

  // Recount after the drop so the report never claims coverage it no longer has.
  const byCourse = {}
  let assigned = 0
  let unassigned = 0
  for (const record of files) {
    if (record.course_id === null) unassigned += 1
    else {
      assigned += 1
      byCourse[record.course_id] = (byCourse[record.course_id] ?? 0) + 1
    }
  }

  files.sort((left, right) => (left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0))

  return {
    index: {
      schema_version: FILE_INDEX_SCHEMA_VERSION,
      generated_at: timestamp,
      root,
      file_count: files.length,
      files,
    },
    stats: {
      total: files.length,
      added,
      changed,
      reused,
      missing,
      skipped: skipped.length,
      removed: removedByDeletion,
      assigned,
      unassigned,
      byCourse: Object.fromEntries(Object.entries(byCourse).sort(([left], [right]) => (left < right ? -1 : 1))),
    },
  }
}
