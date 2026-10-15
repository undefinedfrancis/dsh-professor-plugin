/**
 * `professor_search` — budgeted retrieval over the extracted chunk store (M8).
 *
 * Read-only: it never extracts, never writes, and never touches source material. It loads the
 * chunk stores that pass the filters, scores them, and returns the top `max_chunks` with full
 * provenance so a quote can be traced back to file, heading and line range.
 *
 * @module dsh-professor-spike/src/tools/search
 */

import { loadProject } from '../project/project.js'
import { projectPaths } from '../paths/roots.js'
import { resolveCourseFilter } from '../courses/registry.js'
import { readChunkStore } from '../extract/store.js'
import { retrieve } from '../extract/retrieval.js'
import { jsonOutput } from './support.js'

export const SEARCH_TOOL_NAME = 'professor_search'

/** List chunk store file ids by reading the file index (the index is the authority on what exists). */
async function indexedFileIds({ gateway, projectRoot, signal }) {
  const layout = projectPaths(projectRoot)
  const target = await gateway.resolveTarget(layout.filesIndex, { cwd: projectRoot, signal })
  const info = await gateway.stat(target, signal)
  if (info === undefined) return { present: false, records: [] }
  const parsed = JSON.parse(await gateway.readText(target, signal))
  return { present: true, records: Array.isArray(parsed?.files) ? parsed.files : [] }
}

/**
 * Define the tool.
 *
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`; course-owned tools
 *   receive a wrapper that throws `PROFESSOR_PROJECT_MISSING` for an unbound workspace.
 * @param options.gateway - filesystem gateway.
 * @returns the tool definition.
 */
export function defineSearchTool(options) {
  const { resolveProject, gateway } = options

  return {
    name: SEARCH_TOOL_NAME,
    description: 'Search the extracted course material under a hard budget. Returns the most relevant chunks with full provenance (file, course, category, heading, line range) plus a diagnostics block explaining the score and what the budget dropped. Read-only: it never extracts or writes. Run professor_extract first if no chunks exist yet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to find (a concept, term, formula, or question).' },
        course: { type: 'string', description: 'Restrict results to one course: a canonical course_id or a unique course code (case-insensitive). An ambiguous or unknown value is an explicit error, never a silent empty result.' },
        category: { type: 'string', description: 'Restrict results to one category (lectures/tutorials/assignments/exams).' },
        max_chunks: { type: 'number', description: 'Budget override; defaults to retrieval.max_chunks from project.yaml.' },
        max_sources: { type: 'number', description: 'Distinct-source cap; defaults to retrieval.max_sources from project.yaml.' },
      },
      required: ['query'],
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        query: { type: 'string' },
        results: { type: 'array' },
        dropped: { type: 'number' },
        diagnostics: { type: 'object' },
        warnings: { type: 'array' },
      },
      required: ['query', 'results', 'dropped', 'diagnostics', 'warnings'],
    }),

    async execute(args = {}, exec) {
      const project = await resolveProject(exec)
      const signal = exec?.signal
      const warnings = []
      const query = String(args.query ?? '').trim()
      if (query.length === 0) {
        const error = new Error('query must be a non-empty string')
        error.code = 'PROFESSOR_SEARCH_INVALID'
        throw error
      }

      let document = null
      const loaded = await loadProject({ gateway, projectRoot: project.root, signal })
      if (loaded.present && loaded.document !== null && loaded.unsupported === null) document = loaded.document
      else if (loaded.unsupported !== null) warnings.push(`project.yaml unusable (${loaded.problems[0]}); using default budgets`)

      // The course filter is resolved to one canonical id before it is applied anywhere: an
      // unresolved filter is an explicit error, never a silently broadened or emptied search.
      const rawCourseFilter = typeof args.course === 'string' && args.course.trim().length > 0
        ? args.course.trim()
        : null
      let courseFilter = null
      if (rawCourseFilter !== null) {
        if (document === null) {
          const error = new Error(
            `course filter "${rawCourseFilter}" cannot be applied: the project course list could not be read, `
            + 'and an unverifiable filter is never silently ignored.',
          )
          error.code = 'PROFESSOR_COURSE_MISSING'
          throw error
        }
        const outcome = resolveCourseFilter(document, rawCourseFilter)
        if (outcome.status === 'found') {
          courseFilter = outcome.course.course_id
        } else if (outcome.status === 'ambiguous') {
          const detail = outcome.candidates
            .map((candidate) => `${candidate.course_id} (${candidate.course_code}, ${candidate.term})`)
            .join(', ')
          const error = new Error(
            `course filter "${rawCourseFilter}" is ambiguous: ${detail}. Pass an exact course_id.`,
          )
          error.code = 'PROFESSOR_COURSE_AMBIGUOUS'
          throw error
        } else {
          const reason = outcome.status === 'empty'
            ? 'no courses are registered in this project'
            : 'it matches no registered course'
          const error = new Error(
            `course filter "${rawCourseFilter}" cannot be applied: ${reason}. `
            + 'Check professor_course_list for the canonical ids; the filter is never silently ignored.',
          )
          error.code = 'PROFESSOR_COURSE_MISSING'
          throw error
        }
      }

      const maxChunks = Number.isInteger(args.max_chunks) && args.max_chunks > 0
        ? args.max_chunks
        : document?.retrieval?.max_chunks ?? 8
      const maxSources = Number.isInteger(args.max_sources) && args.max_sources > 0
        ? args.max_sources
        : document?.retrieval?.max_sources ?? 4

      const { present, records } = await indexedFileIds({ gateway, projectRoot: project.root, signal })
      if (!present) {
        const error = new Error('no file index yet: run professor_index_sync, then professor_extract')
        error.code = 'PROFESSOR_INDEX_MISSING'
        throw error
      }

      const byId = new Map(records.map((record) => [record.file_id, record]))
      const chunks = []
      // The resolved canonical id is applied to the *current* index records; cached chunk metadata
      // never decides ownership (it is overwritten from the record further below).
      const storeIds = records
        .filter((record) => record.index_status !== 'missing')
        .filter((record) => courseFilter === null || record.course_id === courseFilter)
        .map((record) => record.file_id)

      let emptyStores = 0
      let staleStores = 0
      for (const fileId of storeIds) {
        const store = await readChunkStore({
          gateway, projectRoot: project.root, fileId, signal,
        })
        if (store.unsupported !== null) {
          warnings.push(store.problems[0])
          continue
        }
        if (!store.present || store.chunks.length === 0) {
          emptyStores += 1
          continue
        }
        const record = byId.get(fileId)
        // Freshness must be proved, exactly as in `professor_extract`: the store's recorded source
        // hash has to equal the index's current hash for this file. Chunks whose source has changed
        // (or whose store predates source hashes) are **withheld**, not ranked lower — returning
        // superseded text as a current result is the one failure this rule exists to prevent.
        const indexHash = typeof record?.content_hash === 'string' && record.content_hash.length > 0
          ? record.content_hash
          : null
        if (indexHash === null || store.sourceHash !== indexHash) {
          staleStores += 1
          continue
        }
        for (const chunk of store.chunks) {
          chunks.push({
            ...chunk,
            relative_path: chunk.relative_path ?? record?.relative_path ?? null,
            // Classification changes independently of the source hash. The current index owns
            // assignment even if a cached chunk still carries a removed course's provenance.
            course_id: record?.course_id ?? null,
            category: record?.category ?? null,
          })
        }
      }
      if (staleStores > 0) {
        warnings.push(
          `${staleStores} chunk store(s) are stale: their source file changed since extraction, so their `
          + 'chunks were withheld rather than returned as current. Run professor_extract to re-derive them.',
        )
      }
      if (emptyStores > 0 && chunks.length === 0) {
        warnings.push(`${emptyStores} indexed file(s) have no chunks yet: run professor_extract`)
      }

      const outcome = retrieve({
        chunks,
        query,
        maxChunks,
        maxSources,
        courseFilter: courseFilter ?? undefined,
        categoryFilter: typeof args.category === 'string' && args.category.trim().length > 0 ? args.category.trim() : undefined,
        preferCourse: document?.courses?.length === 1 ? document.courses[0].course_id : undefined,
      })

      if (courseFilter !== null) {
        outcome.diagnostics.course_filter = courseFilter
        outcome.diagnostics.course_filter_input = rawCourseFilter
        if (storeIds.length === 0) {
          warnings.push(`course "${courseFilter}" owns no files in the current index; nothing could match`)
        }
      }
      if (typeof args.category === 'string' && args.category.trim().length > 0) {
        // category filter is applied inside retrieve(); surface it in the diagnostics for audit.
        outcome.diagnostics.category_filter = args.category.trim()
      }
      // Reported so a caller can tell "nothing matched" apart from "material was withheld".
      outcome.diagnostics.stale_stores = staleStores
      outcome.diagnostics.empty_stores = emptyStores

      return {
        query,
        results: outcome.results,
        dropped: outcome.dropped,
        diagnostics: outcome.diagnostics,
        warnings,
      }
    },
  }
}
