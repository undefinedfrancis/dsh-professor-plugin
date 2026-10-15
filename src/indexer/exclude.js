/**
 * Which paths are excluded from the project's source corpus.
 *
 * The file index walks everything under the academic folder. Two kinds of entry must never become
 * "course material" even though they legitimately live inside it:
 *
 * 1. **Configured artifact output roots.** An AI Notes folder may be configured *inside* a course
 *    tree (`<course>/04_My-Notes/AI-Notes` is the conventional layout the registry import already
 *    reads). Without this exclusion the plugin would index its own generated notes on the next run
 *    and then quote them back as source material — the exact feedback loop v3 §15 forbids.
 * 2. **`indexing.exclude` entries** — the user's own escape hatch.
 *
 * Resolution goes through the same service the artifact tools use
 * (`src/artifacts/paths.js#resolveArtifactRoot`), so "where do notes go?" has **one** answer in this
 * codebase rather than a second, subtly different one here. That service also refuses an output
 * root that *is* a material root, so an unsafe configuration fails where it is declared instead of
 * silently emptying the index.
 *
 * `.professor/` is not returned: the indexer already skips dot-directories, so listing it would
 * inflate the reported exclusion count without changing the outcome.
 *
 * A second, separate question lives here: **which prefixes a deleted course's material occupies.**
 * Those must keep the folder scannable (so it can be re-added) while keeping its records out of a
 * later rebuild — see {@link removedSourcePrefixes}.
 *
 * @module dsh-professor-spike/src/indexer/exclude
 */

import path from 'node:path'

import { ARTIFACT_KINDS, resolveArtifactRoot } from '../artifacts/paths.js'
import { isInside } from '../paths/policy.js'
import { projectPaths } from '../paths/roots.js'

/**
 * Canonical paths inside the project that must never be indexed.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.projectRoot - canonical absolute project root.
 * @param options.document - the loaded project document, or `null` when there is none.
 * @param options.signal - cancellation.
 * @returns absolute canonical paths (possibly empty). Never throws: an output root that cannot be
 *   resolved is reported by the artifact tools, and here it simply excludes nothing.
 */
export async function resolveExcludePaths(options) {
  const {
    gateway, projectRoot, document, signal,
  } = options

  const declared = []
  for (const kind of Object.keys(ARTIFACT_KINDS)) {
    for (const course of [undefined, ...(document?.courses ?? [])]) {
    try {
      const resolved = resolveArtifactRoot({ document, projectRoot, kind, course })
      if (typeof resolved.root === 'string' && resolved.root.length > 0) declared.push(resolved.root)
    } catch {
      // An unsafe or unresolvable destination is refused where it is used; it excludes nothing here.
    }
    }
  }
  for (const entry of (Array.isArray(document?.indexing?.exclude) ? document.indexing.exclude : [])) {
    if (typeof entry === 'string' && entry.trim().length > 0) declared.push(entry.trim())
  }

  const base = projectPaths(projectRoot).base
  const excluded = new Set()
  for (const spelling of declared) {
    try {
      const target = await gateway.resolveTarget(spelling, { cwd: projectRoot, signal })
      const canonical = gateway.canonical(target)
      // Only entries inside the folder matter — everything outside it is unreachable anyway — and
      // only ones outside `.professor/`, which the walk already skips as a dot-directory.
      if (canonical === projectRoot) continue
      if (!isInside(projectRoot, canonical)) continue
      if (isInside(base, canonical)) continue
      excluded.add(canonical)
    } catch {
      // A path that cannot be resolved cannot match a directory entry either.
    }
  }
  return [...excluded]
}

/**
 * Index-relative prefixes whose material a **deleted course** used to own.
 *
 * These are deliberately *not* part of {@link resolveExcludePaths}: a deleted folder must stay
 * visible to discovery so re-scanning and confirming it can add the course back. What must not
 * happen is the rebuild quietly promoting that folder into an `unassigned`, searchable corpus — so
 * the prefixes are handed to the indexer instead, which drops any record that lands inside one and
 * is not assigned to a surviving course.
 *
 * @param options.document - the project document, or null when there is none.
 * @param options.indexRoot - canonical absolute root the index's relative paths are measured from.
 * @returns posix-relative prefixes (the empty string means "the index root itself"). Entries that
 *   are not absolute, or that live outside the index root, cannot match any record and are skipped.
 */
export function removedSourcePrefixes({ document, indexRoot }) {
  const entries = Array.isArray(document?.indexing?.removed_sources) ? document.indexing.removed_sources : []
  const prefixes = []
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0 || !path.isAbsolute(entry)) continue
    const relative = path.relative(indexRoot, entry).split(path.sep).join('/')
    if (relative === '..' || relative.startsWith('../')) continue
    prefixes.push(relative.replace(/\/+$/, ''))
  }
  return [...new Set(prefixes)]
}

/**
 * Whether an index-relative record path falls inside any removed-source prefix.
 *
 * @param prefixes - output of {@link removedSourcePrefixes}.
 * @param relativePath - a record's `relative_path` (already posix-separated by the indexer).
 */
export function isRemovedPath(prefixes, relativePath) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) return false
  const record = String(relativePath ?? '')
  return prefixes.some((prefix) => prefix === '' || record === prefix || record.startsWith(`${prefix}/`))
}
