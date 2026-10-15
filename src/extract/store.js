/**
 * Persistent chunk store (M8).
 *
 * Extracted chunks are written to `.professor/indexes/chunks/<file_id>.json`, one file per source,
 * so a re-extraction replaces one document's chunks rather than rewriting a single giant store and
 * so a file that disappears keeps its chunks for provenance (they are marked stale, not deleted).
 *
 * Each store file carries a `schema_version` exactly like the file index: an unknown future
 * version fails safe (read refuses, write requires `rebuild`), never a silent overwrite.
 *
 * @module dsh-professor-spike/src/extract/store
 */

import path from 'node:path'

import { projectPaths } from '../paths/roots.js'

/** Schema version of a chunk store file. */
export const CHUNK_STORE_SCHEMA_VERSION = 1

/** Path of one file's chunk store. */
export function chunkStorePath(projectRoot, fileId) {
  if (typeof fileId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(fileId)) {
    const error = new Error(`invalid file id for chunk store: ${String(fileId)}`)
    error.code = 'PROFESSOR_CHUNK_ID_INVALID'
    throw error
  }
  return path.join(projectPaths(projectRoot).indexesDir, 'chunks', `${fileId}.json`)
}

/**
 * Read a file's chunks.
 *
 * @returns `{ present, chunks, sourceHash, sourcePath, unsupported, problems }`; `unsupported` is
 *   set when the store uses a schema this plugin must not touch, `sourcePath` is the file the
 *   chunks were derived from (so a caller that only re-stamps provenance can write it back
 *   unchanged), and `sourceHash` is the `content_hash` of the source file at the moment its chunks
 *   were written (`null` for a store written before Phase 3, which means "freshness cannot be
 *   proven" — the caller re-extracts once rather than presenting possibly superseded text as
 *   current).
 */
export async function readChunkStore(options) {
  const { gateway, projectRoot, fileId, signal } = options
  const target = await gateway.resolveTarget(chunkStorePath(projectRoot, fileId), { cwd: projectRoot, signal })
  const info = await gateway.stat(target, signal)
  if (info === undefined) return { present: false, chunks: [], sourceHash: null, sourcePath: null, unsupported: null, problems: [] }

  let parsed
  try {
    parsed = JSON.parse(await gateway.readText(target, signal))
  } catch (error) {
    return { present: true, chunks: [], sourceHash: null, sourcePath: null, unsupported: null, problems: [`chunk store unreadable: ${error.message}`] }
  }
  const version = parsed?.schema_version
  if (version !== CHUNK_STORE_SCHEMA_VERSION) {
    const future = typeof version === 'number' && version > CHUNK_STORE_SCHEMA_VERSION
    return {
      present: true,
      chunks: [],
      sourceHash: null,
      sourcePath: null,
      unsupported: { version, future },
      problems: [
        future
          ? `chunk store uses schema_version ${version}, newer than this plugin supports (${CHUNK_STORE_SCHEMA_VERSION}); refusing to touch it`
          : `chunk store uses schema_version ${JSON.stringify(version)}; refusing to overwrite it`,
      ],
    }
  }
  return {
    present: true,
    chunks: Array.isArray(parsed.chunks) ? parsed.chunks : [],
    sourceHash: typeof parsed.source_hash === 'string' && parsed.source_hash.length > 0 ? parsed.source_hash : null,
    sourcePath: typeof parsed.source_path === 'string' && parsed.source_path.length > 0 ? parsed.source_path : null,
    unsupported: null,
    problems: [],
  }
}

/**
 * Write one file's chunks.
 *
 * `source_hash` is the source file's `content_hash` from the file index. It is an **added optional
 * field on the same schema_version**: a store written by an earlier revision simply has no
 * `source_hash`, which reads back as "unknown" and costs one re-extraction rather than a bump that
 * would make every existing store unreadable.
 *
 * @throws with `code = 'PROFESSOR_CHUNK_STORE_UNSUPPORTED'` when the existing store is newer.
 */
export async function writeChunkStore(options) {
  const {
    gateway, projectRoot, fileId, chunks, session, signal, writePolicy, sourcePath, sourceHash = null,
  } = options

  const existing = await readChunkStore({ gateway, projectRoot, fileId, signal })
  if (existing.unsupported !== null) {
    const error = new Error(existing.problems[0])
    error.code = 'PROFESSOR_CHUNK_STORE_UNSUPPORTED'
    throw error
  }
  if (writePolicy === undefined || typeof writePolicy.assert !== 'function') {
    const error = new Error('refusing to write chunks without a write policy')
    error.code = 'PROFESSOR_PATH_DENIED'
    throw error
  }

  const payload = {
    schema_version: CHUNK_STORE_SCHEMA_VERSION,
    file_id: fileId,
    source_path: sourcePath ?? null,
    source_hash: typeof sourceHash === 'string' && sourceHash.length > 0 ? sourceHash : null,
    chunk_count: chunks.length,
    chunks,
  }
  return gateway.writeFile({
    filePath: chunkStorePath(projectRoot, fileId),
    cwd: projectRoot,
    content: `${JSON.stringify(payload, null, 2)}\n`,
    session,
    signal,
    writePolicy,
    expected: existing.present ? undefined : { kind: 'createIfAbsent' },
  })
}
