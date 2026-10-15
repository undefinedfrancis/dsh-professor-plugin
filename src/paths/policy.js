/**
 * Path policy: the single place that decides which paths the plugin may read and write.
 *
 * Two policies exist per call:
 * - READ roots: the project workspace, the dependency workspace, and configured extras.
 * - WRITE roots: only the Professor project directory (`.professor/`) and configured output
 *   roots. Original course material is never writable.
 *
 * The module is intentionally pure: it works on canonical path strings supplied by the caller
 * (the filesystem gateway canonicalizes through `ctx.fs`, which realpaths the deepest existing
 * ancestor, so symlink escapes are already collapsed before these checks run).
 *
 * @module dsh-professor-spike/src/paths/policy
 */

import path from 'node:path'

/** Whether `candidate` is inside `root` (or is `root` itself), using canonical strings. */
export function isInside(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

/** Find `../` segments in a caller-supplied spelling (before canonicalization). */
export function hasTraversal(spelling) {
  if (typeof spelling !== 'string') return false
  return spelling.split(/[\\/]+/).includes('..')
}

/**
 * Build a containment policy.
 *
 * @param options.roots - absolute canonical roots this policy allows.
 * @param options.label - name used in error messages (`read` / `write`).
 * @returns the policy surface used by the filesystem gateway.
 */
export function createPathPolicy({ roots = [], label = 'path' } = {}) {
  const normalized = [...new Set(roots.map((root) => path.resolve(root)))]

  return {
    label,
    roots: normalized,

    /** Add a root at runtime (used when a course registers a new source or output root). */
    add(root) {
      const resolved = path.resolve(root)
      if (!normalized.includes(resolved)) normalized.push(resolved)
      return resolved
    },

    /** Containment test on a canonical path. */
    contains(canonicalPath) {
      return normalized.some((root) => isInside(root, canonicalPath))
    },

    /**
     * Validate a path for this policy.
     *
     * @param spelling - the caller-supplied path (may be relative; used for traversal checks).
     * @param canonicalPath - the canonical absolute path from the filesystem service.
     * @returns `{ ok: true }` or `{ ok: false, reason }`; never throws.
     */
    check(spelling, canonicalPath) {
      if (typeof canonicalPath !== 'string' || !path.isAbsolute(canonicalPath)) {
        return { ok: false, reason: 'path did not resolve to an absolute location' }
      }
      if (hasTraversal(spelling)) {
        return { ok: false, reason: `path contains a ".." segment: ${spelling}` }
      }
      if (normalized.length === 0) {
        return { ok: false, reason: `no ${label} roots are configured` }
      }
      if (!this.contains(canonicalPath)) {
        return {
          ok: false,
          reason: `${label} denied: ${canonicalPath} is outside every allowed ${label} root`
            + ` (${normalized.join(', ')})`,
        }
      }
      return { ok: true }
    },

    /**
     * Validate or throw, so callers can fail fast with a descriptive error.
     *
     * @throws {Error} with `code = 'PROFESSOR_PATH_DENIED'` when the path is not allowed.
     */
    assert(spelling, canonicalPath) {
      const result = this.check(spelling, canonicalPath)
      if (result.ok) return canonicalPath
      const error = new Error(result.reason)
      error.code = 'PROFESSOR_PATH_DENIED'
      throw error
    },
  }
}
