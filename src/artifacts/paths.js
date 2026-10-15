/**
 * Artifact destinations and output-root safety (M11, v3 §9).
 *
 * Where a note or a review may be written is decided here, and only from validated project
 * configuration. The rules are the ones the design calls non-negotiable:
 *
 * - **only configured output roots are writable** — the root set fed to the write policy comes from
 *   `project.yaml` `outputs.notes_root` / `outputs.reviews_root` (or, when unset, the project's own
 *   `.professor/notes` / `.professor/reviews`, which is plugin-owned state and never course
 *   material);
 * - **an output root may never be a course source root**, and may never *contain* one (that would
 *   make an entire course writable). An output root strictly *inside* a source root is accepted
 *   only when the configuration explicitly names an artifact subdirectory — which is exactly the
 *   `04_My-Notes/AI-Notes` shape the upstream registry declares.
 * - **`.professor/state` is never an artifact destination**: learning state is not notes.
 * - the process working directory is never a fallback; a missing configuration produces a domain
 *   error, not a guess.
 * - traversal and symlink escapes are rejected by the write policy and by `ctx.fs` canonicalisation.
 *
 * @module dsh-professor-spike/src/artifacts/paths
 */

import path from 'node:path'

import { projectPaths } from '../paths/roots.js'

/** Artifact kinds and the project keys that configure their destination. */
export const ARTIFACT_KINDS = {
  note: { key: 'notes_root', label: 'notes', defaultDir: 'notes' },
  review: { key: 'reviews_root', label: 'reviews', defaultDir: 'reviews' },
}

/**
 * Path segments that explicitly identify a *safe artifact subdirectory* of a course tree.
 *
 * Being on this list is what lets a configured output root live inside a registered source root:
 * the upstream registry's `AI Notes Output` (`…/CSC3200/04_My-Notes/AI-Notes`) is the motivating
 * case. Anything else inside a source root is refused rather than silently accepted.
 */
export const SAFE_ARTIFACT_SEGMENTS = new Set([
  'ai-notes', 'ainotes', 'ai notes', 'notes', 'my-notes', '04_my-notes',
  'ai-reviews', 'reviews', 'review', 'my-reviews', '05_my-reviews',
])

const isInside = (parent, candidate) => {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

function fail(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Every registered source path of the project, canonicalised as far as spelling allows. */
function sourceRoots(document) {
  const roots = []
  for (const course of Array.isArray(document?.courses) ? document.courses : []) {
    for (const source of Array.isArray(course.sources) ? course.sources : []) {
      if (typeof source?.path === 'string' && source.path.startsWith('/')) roots.push(path.resolve(source.path))
    }
  }
  return [...new Set(roots)]
}

/** Whether a path segment list explicitly names an artifact subdirectory. */
function hasSafeArtifactSegment(segments) {
  return segments.some((segment) => SAFE_ARTIFACT_SEGMENTS.has(segment.toLowerCase()))
}

/**
 * Resolve the destination root for an artifact kind.
 *
 * @param options.document - the validated project document.
 * @param options.projectRoot - absolute project root.
 * @param options.kind - `'note' | 'review'`.
 * @returns `{ root, source, configured, insideSource }` — `source` is `outputs.<key>` or
 *   `project-default`.
 * @throws {Error} `PROFESSOR_ARTIFACT_ROOT_UNSAFE` when the configured root overlaps course
 *   material or the plugin's own state directory.
 */
export function resolveArtifactRoot(options) {
  const { document, projectRoot, kind, course } = options
  const spec = ARTIFACT_KINDS[kind]
  if (spec === undefined) throw fail(`unknown artifact kind "${String(kind)}"`, 'PROFESSOR_ARTIFACT_KIND_INVALID')

  const courseOutput = course?.outputs?.[spec.key]
  const configuredRaw = courseOutput ?? document?.outputs?.[spec.key]
  const configured = typeof configuredRaw === 'string' && configuredRaw.trim().length > 0
    ? configuredRaw.trim()
    : undefined
  if (configured !== undefined && configured.includes('..')) {
    throw fail(`outputs.${spec.key} contains a ".." segment: ${configured}`, 'PROFESSOR_ARTIFACT_ROOT_UNSAFE')
  }

  const layout = projectPaths(projectRoot)
  const root = configured === undefined ? path.join(layout.base, spec.defaultDir) : path.resolve(configured)

  // `.professor/state` holds learning state, not notes: writing an artifact there would corrupt the
  // state files' own contract.
  if (isInside(layout.stateDir, root)) {
    throw fail(`outputs.${spec.key} points inside .professor/state (${root}); state is not an artifact destination`, 'PROFESSOR_ARTIFACT_ROOT_UNSAFE')
  }

  const sources = sourceRoots(document)
  let insideSource = null
  for (const source of sources) {
    if (root === source || isInside(root, source)) {
      throw fail(
        `outputs.${spec.key} (${root}) is a course material root (or contains one: ${source}); `
        + 'configure an explicit artifact subdirectory instead',
        'PROFESSOR_ARTIFACT_ROOT_UNSAFE',
      )
    }
    if (isInside(source, root)) {
      if (course && !(course.sources ?? []).some((item) => typeof item.path === 'string' && isInside(path.resolve(item.path), root))) {
        throw fail(`artifact destination belongs to another course: ${root}`, 'PROFESSOR_ARTIFACT_ROOT_UNSAFE')
      }
      const relative = path.relative(source, root)
      const segments = relative.split(path.sep).filter(Boolean)
      if (!hasSafeArtifactSegment(segments)) {
        throw fail(
          `outputs.${spec.key} (${root}) sits inside the course material root ${source} but does not name an `
          + `artifact subdirectory (saw ${segments.join('/') || '(the root itself)'}); refused so notes cannot `
          + 'land in original material',
          'PROFESSOR_ARTIFACT_ROOT_UNSAFE',
        )
      }
      insideSource = source
    }
  }

  return {
    root,
    source: configured === undefined ? 'project-default' : courseOutput != null ? `course.outputs.${spec.key}` : `outputs.${spec.key}`,
    configured: configured !== undefined,
    insideSource,
  }
}

/** Turn free text into a path-safe slug (never empty, never traversing). */
export function slugify(value, fallback = 'artifact') {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug.length > 0 ? slug : fallback
}

/**
 * The artifact's directory name: `<course_id>/<slug>` when a course is known, `<slug>` otherwise.
 *
 * The directory is always relative and single-level-safe; the absolute path is assembled here and
 * validated through the gateway on write.
 */
export function artifactDirectoryName({ courseId, title }) {
  const slug = slugify(title)
  return typeof courseId === 'string' && courseId.length > 0 ? `${courseId}/${slug}` : slug
}

/** Absolute path of an artifact file inside its root the way that root was resolved. */
export function artifactFilePath({ root, directory, filename }) {
  return path.join(root, directory, filename)
}

/** Expected extension for a format. */
export function extensionFor(format) {
  return format === 'latex' ? 'tex' : 'md'
}
