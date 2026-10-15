/**
 * Derived-index cleanup for a deleted course.
 *
 * Scope
 * -----
 * Deleting a registration has to do two separate things to `.professor/indexes/`:
 *
 * 1. **plan** which records the deleted course actually owned — by classifying every record's path
 *    against *both* the current and the target document, so a source shared with a surviving course
 *    stays searchable under that course, and
 * 2. **apply** that plan with one guarded, atomic index write, before the configuration is saved.
 *
 * Ordering matters and is deliberate (see
 * `docs/superpowers/plans/2026-10-09-delete-and-polish.md`): the index is cleaned first, so a
 * failure can only ever leave a *registered* course with no searchable material — retried safely —
 * and never a removed course whose material is still searchable.
 *
 * Writes are confined to `.professor/indexes/` (file index and shared chunk provenance), and nothing here can touch a source
 * file: the host filesystem service has no delete primitive at all, and the chunk stores that are
 * no longer reachable are left on disk as rebuildable derived data.
 *
 * @module dsh-professor-spike/src/courses/removal
 */

import path from 'node:path'

import { readChunkStore, writeChunkStore } from '../extract/store.js'
import { createClassifier } from '../indexer/classify.js'
import { FILE_INDEX_SCHEMA_VERSION } from '../indexer/index.js'
import { projectPaths } from '../paths/roots.js'

const covers = (parent, child) => child === parent || child.startsWith(`${parent}/`)

/** Smallest covering set: drop any path already covered by a shorter one, then sort. */
function minimalPaths(paths) {
  const unique = [...new Set(paths.filter((value) => typeof value === 'string' && value.length > 0))]
    .sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0))
  return unique
    .filter((candidate, index) => index === 0 || !unique.slice(0, index).some((kept) => covers(kept, candidate)))
    .sort()
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Split the stored index into what the deleted course exclusively owned and what must stay.
 *
 * A record **belongs** to the deleted course when its stored `course_id` says so *or* the current
 * document still classifies its path there — either signal is enough, because a stale stored id is
 * exactly the case a rebuild would otherwise resurrect. It is **removed** only when the target
 * document classifies it to no course at all; otherwise it is kept and re-stamped with the
 * surviving course's assignment.
 *
 * @param options.document - the project document as it is now.
 * @param options.nextDocument - the document with the course removed (markers may already be on it).
 * @param options.removedCourseId - the stable id being deleted.
 * @param options.removedSources - absolute source roots of the deleted course; records inside them
 *   need no extra marker.
 * @param options.index - the stored index artifact (never mutated).
 * @param options.indexRoot - the canonical root its `relative_path` values are measured from.
 * @returns `{ removedFileIds, remaining, sharedKept, reStamped, extraRemovedSources }`.
 */
export function planCourseIndexRemoval(options) {
  const {
    document, nextDocument, removedCourseId, removedSources = [], index, indexRoot,
  } = options

  const files = Array.isArray(index?.files) ? index.files : []
  const classifyCurrent = createClassifier({ document, indexRoot })
  const classifyNext = createClassifier({ document: nextDocument, indexRoot })
  // Everything that will be on the target document already — source roots plus any marker an
  // earlier deletion recorded — plus the roots this deletion adds.
  const covered = minimalPaths([
    ...removedSources,
    ...(Array.isArray(nextDocument?.indexing?.removed_sources) ? nextDocument.indexing.removed_sources : []),
  ])

  const removedFileIds = []
  const remaining = []
  const extra = []
  const reStampedRecords = []
  let sharedKept = 0
  let reStamped = 0

  for (const record of files) {
    const relative = record.relative_path
    const belongs = record.course_id === removedCourseId
      || classifyCurrent(relative).course_id === removedCourseId
    const nextOutcome = classifyNext(relative)

    if (belongs && nextOutcome.course_id === null) {
      removedFileIds.push(record.file_id)
      // A record the source roots do not explain would come back as unassigned material on the
      // next rebuild. Mark this exact file, including root-level files, so unrelated neighbours
      // remain available. Source roots already cover normally assigned material.
      const absolute = path.resolve(indexRoot, relative)
      if (absolute !== indexRoot && !covered.some((root) => covers(root, absolute))) extra.push(absolute)
      continue
    }

    if (!belongs) {
      remaining.push(record)
      continue
    }

    const reclassified = {
      ...record,
      course_id: nextOutcome.course_id,
      category: nextOutcome.category,
      classification_source: nextOutcome.classification_source,
      classification_confidence: nextOutcome.classification_confidence,
    }
    if (reclassified.course_id !== record.course_id
      || reclassified.category !== record.category
      || reclassified.classification_source !== record.classification_source) reStamped += 1
    if (reclassified.course_id !== record.course_id || reclassified.category !== record.category) {
      // The chunk store extracted from this record still carries the *old* assignment, and search
      // reports a chunk's provenance — so it has to be re-stamped with the surviving course or the
      // material would keep naming a course that no longer exists.
      reStampedRecords.push({ file_id: record.file_id, course_id: reclassified.course_id, category: reclassified.category })
    }
    sharedKept += 1
    remaining.push(reclassified)
  }

  return {
    removedFileIds,
    remaining,
    sharedKept,
    reStamped,
    reStampedRecords,
    extraRemovedSources: minimalPaths(extra),
  }
}

/**
 * Apply the plan: one guarded write of the cleaned index.
 *
 * Reads the stored artifact first, so an absent index is simply "nothing to clean" and an index
 * this build cannot faithfully edit is a refusal rather than a silent half-cleanup.
 *
 * @returns `{ indexPresent, indexRecordsRemoved, sharedKept, indexWritten, extraRemovedSources }`.
 * @throws `PROFESSOR_INDEX_UNREADABLE` | `PROFESSOR_INDEX_SCHEMA_UNSUPPORTED` when the stored index
 *   cannot be edited safely; nothing is written in that case.
 */
export async function cleanupCourseIndex(options) {
  const {
    gateway, projectRoot, document, nextDocument, removedCourseId, removedSources = [],
    session, signal, writePolicy,
  } = options

  const layout = projectPaths(projectRoot)
  const empty = {
    indexPresent: false,
    indexRecordsRemoved: 0,
    sharedKept: 0,
    indexWritten: false,
    chunksRestamped: 0,
    chunkProblems: [],
    extraRemovedSources: [],
  }

  const target = await gateway.resolveTarget(layout.filesIndex, { cwd: projectRoot, signal })
  if (await gateway.stat(target, signal) === undefined) return empty

  let index
  try {
    index = JSON.parse(await gateway.readText(target, signal))
  } catch (error) {
    throw fail('PROFESSOR_INDEX_UNREADABLE',
      `the stored file index could not be read (${error.message}); run professor_index_sync rebuild before deleting a course`)
  }
  if (index?.schema_version !== FILE_INDEX_SCHEMA_VERSION) {
    throw fail('PROFESSOR_INDEX_SCHEMA_UNSUPPORTED',
      `the stored file index uses schema_version ${JSON.stringify(index?.schema_version ?? null)}, which this `
      + `build cannot edit (it writes ${FILE_INDEX_SCHEMA_VERSION}); run professor_index_sync rebuild before deleting a course`)
  }

  const indexRoot = typeof index.root === 'string' && path.isAbsolute(index.root) ? index.root : projectRoot
  const plan = planCourseIndexRemoval({
    document, nextDocument, removedCourseId, removedSources, index, indexRoot,
  })

  if (plan.removedFileIds.length === 0 && plan.reStamped === 0) {
    // Already clean — which is what makes a retry after a failed configuration save a no-op.
    return {
      indexPresent: true,
      indexRecordsRemoved: 0,
      sharedKept: plan.sharedKept,
      indexWritten: false,
      chunksRestamped: 0,
      chunkProblems: [],
      extraRemovedSources: plan.extraRemovedSources,
    }
  }

  const cleaned = { ...index, files: plan.remaining, file_count: plan.remaining.length }
  await gateway.writeFile({
    filePath: layout.filesIndex,
    cwd: projectRoot,
    content: `${JSON.stringify(cleaned, null, 2)}\n`,
    session,
    signal,
    writePolicy,
  })

  // Shared records now belong to a surviving course, so their extracted chunks — whose provenance
  // search reports — are re-stamped to match. This runs after the index write on purpose: a chunk
  // label that cannot be refreshed is a *warning*, never a reason to refuse a deletion the index
  // has already made correct, and never a half-deleted configuration.
  const chunkProblems = []
  let chunksRestamped = 0
  for (const record of plan.reStampedRecords) {
    try {
      const store = await readChunkStore({ gateway, projectRoot, fileId: record.file_id, signal })
      if (store.present !== true || store.chunks.length === 0) continue
      if (store.unsupported !== null) {
        chunkProblems.push(store.problems[0])
        continue
      }
      let touched = false
      const chunks = store.chunks.map((chunk) => {
        if ((chunk.course_id ?? null) === record.course_id && (chunk.category ?? null) === record.category) return chunk
        touched = true
        return { ...chunk, course_id: record.course_id, category: record.category }
      })
      if (touched !== true) continue
      await writeChunkStore({
        gateway,
        projectRoot,
        fileId: record.file_id,
        chunks,
        session,
        signal,
        writePolicy,
        sourcePath: store.sourcePath,
        sourceHash: store.sourceHash,
      })
      chunksRestamped += 1
    } catch (error) {
      chunkProblems.push(`${record.file_id}: ${error.message}`)
    }
  }

  return {
    indexPresent: true,
    indexRecordsRemoved: plan.removedFileIds.length,
    sharedKept: plan.sharedKept,
    indexWritten: true,
    chunksRestamped,
    chunkProblems,
    extraRemovedSources: plan.extraRemovedSources,
  }
}
