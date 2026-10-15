/**
 * Artifact persistence (M11, v3 §9).
 *
 * The default policy is **never silently overwrite**. This module implements the three
 * configured policies and, just as importantly, makes each outcome explicit in its return value so
 * a caller can report exactly what happened:
 *
 * | `notes.overwrite_policy` | existing file |
 * |---|---|
 * | `never` (default) | refuse, and *suggest* the next free `-vN` name |
 * | `versioned` | write the next free `-vN` name, leaving the original untouched |
 * | `allow` | overwrite only with the current version token; a stale token is refused |
 *
 * Every write goes through the filesystem gateway with a `createIfAbsent` intent (so two writers
 * cannot clobber each other) or an explicit `replaceIfVersion` (so a concurrent edit is refused
 * rather than lost). Nothing here can write outside the resolved artifact root, because the caller
 * passes the plugin's write policy through.
 *
 * @module dsh-professor-spike/src/artifacts/store
 */

import path from 'node:path'

import { extensionFor } from './paths.js'

/** Policies understood by the artifact store (mirrors `OVERWRITE_POLICIES` in project.js). */
export const ARTIFACT_OVERWRITE_POLICIES = ['never', 'versioned', 'allow']

const isFile = (info) => info !== undefined && info.type !== 'directory'

function fail(message, code, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

/** Split `name.md` into `{ stem: 'name', ext: '.md' }`. */
function splitName(filename) {
  const ext = path.extname(filename)
  return { stem: filename.slice(0, filename.length - ext.length), ext }
}

/** `name-v3.md` for a requested version number (v1 is the bare name). */
export function versionedFilename(filename, version) {
  if (version <= 1) return filename
  const { stem, ext } = splitName(filename)
  return `${stem}-v${version}${ext}`
}

/** Parse `-vN` off a filename, returning `{ base, version }`. */
export function parseVersionedFilename(filename) {
  const { stem, ext } = splitName(filename)
  const match = /^(.*)-v(\d+)$/.exec(stem)
  if (match === null) return { base: filename, version: 1, ext }
  return { base: `${match[1]}${ext}`, version: Number.parseInt(match[2], 10), ext }
}

/**
 * Find the first free versioned name at or above `fromVersion`.
 *
 * @returns `{ filename, version }` for the first name that does not exist yet.
 */
export async function nextFreeVersion(options) {
  const {
    gateway, projectRoot, directoryPath, filename, fromVersion = 1, signal, limit = 200,
  } = options
  for (let version = Math.max(1, fromVersion); version < Math.max(1, fromVersion) + limit; version += 1) {
    const candidate = versionedFilename(filename, version)
    const target = await gateway.resolveTarget(path.join(directoryPath, candidate), { cwd: projectRoot, signal })
    const info = await gateway.stat(target, signal)
    if (info === undefined) return { filename: candidate, version }
  }
  throw fail(
    `could not find a free versioned name for ${filename} (checked ${limit} alternatives)`,
    'PROFESSOR_ARTIFACT_VERSION_LIMIT',
  )
}

/**
 * Write an artifact under the configured policy.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.projectRoot - absolute project root (resolution base).
 * @param options.root - absolute artifact root (already validated by `resolveArtifactRoot`).
 * @param options.directory - directory name relative to the root (may contain one `/`).
 * @param options.filename - file name, including the extension.
 * @param options.content - full file content.
 * @param options.overwritePolicy - `never` | `versioned` | `allow`.
 * @param options.expectedVersion - the version token the caller read (required by `allow`).
 * @param options.writePolicy - the plugin's write policy (required).
 * @param options.writePolicyExtra - optional extra roots to add before the write (configured output
 *   roots must be added to the write policy only after the document validated).
 * @param options.session / options.signal - as usual.
 * @returns a report: `{ written, path, canonicalPath, operation, version, requestedFilename,
 *   existing?, suggested?, reason, code? }`.
 */
export async function writeArtifact(options) {
  const {
    gateway, projectRoot, root, directory, filename, content,
    overwritePolicy = 'never', expectedVersion, writePolicy, session, signal,
  } = options

  if (writePolicy === undefined || typeof writePolicy.assert !== 'function') {
    throw fail('refusing to write an artifact without a write policy', 'PROFESSOR_PATH_DENIED')
  }
  if (!ARTIFACT_OVERWRITE_POLICIES.includes(overwritePolicy)) {
    throw fail(
      `unknown overwrite policy "${overwritePolicy}"; expected ${ARTIFACT_OVERWRITE_POLICIES.join(' | ')}`,
      'PROFESSOR_ARTIFACT_POLICY_INVALID',
    )
  }

  // The configured output root becomes writable only now — after the document validated and the
  // root passed the safety checks — never before.
  writePolicy.add(root)

  const directoryPath = path.join(root, directory)
  const requestedPath = path.join(directoryPath, filename)
  const requestedTarget = await gateway.resolveTarget(requestedPath, { cwd: projectRoot, signal })
  const existingInfo = await gateway.stat(requestedTarget, signal)

  const write = async (targetPath, expected) => gateway.writeFile({
    filePath: targetPath,
    cwd: projectRoot,
    content,
    session,
    signal,
    writePolicy,
    expected,
  })

  if (existingInfo === undefined) {
    try {
      const written = await write(requestedPath, { kind: 'createIfAbsent' })
      return {
        written: true,
        path: requestedPath,
        canonicalPath: written.canonicalPath,
        operation: written.operation,
        version: written.version,
        requestedFilename: filename,
        filename,
        reason: 'created',
      }
    } catch (error) {
      if (error?.code !== 'FS_NOT_OBSERVED') throw error
      // Lost a race: someone created the exact file between the stat and the write. Fall through to
      // the "already exists" path rather than overwriting them.
      return fallbackOnExisting({ ...options, reason: 'concurrent-create' })
    }
  }

  if (overwritePolicy === 'allow' && typeof expectedVersion === 'string' && expectedVersion.length > 0) {
    const currentVersion = String(existingInfo.version ?? '')
    if (currentVersion !== expectedVersion) {
      throw fail(
        `refusing to overwrite ${requestedPath}: it changed after it was read `
        + `(expected version ${expectedVersion}, found ${currentVersion || '(none)'}). Re-read and retry.`,
        'PROFESSOR_ARTIFACT_STALE',
      )
    }
    const written = await write(requestedPath, { kind: 'replaceIfVersion', version: existingInfo.version })
    return {
      written: true,
      path: requestedPath,
      canonicalPath: written.canonicalPath,
      operation: written.operation,
      version: written.version,
      requestedFilename: filename,
      filename,
      previousVersion: expectedVersion,
      reason: 'explicit-overwrite',
    }
  }

  return fallbackOnExisting({ ...options, reason: overwritePolicy === 'allow' ? 'overwrite-token-required' : 'exists' })
}

/** Handle "the requested name is taken": refuse, or move to a versioned alternative. */
async function fallbackOnExisting(options) {
  const {
    gateway, projectRoot, directory, filename, root, overwritePolicy, reason,
  } = options
  const directoryPath = path.join(root, directory)
  const next = await nextFreeVersion({
    gateway, projectRoot, directoryPath, filename, fromVersion: 2, signal: options.signal,
  })

  if (overwritePolicy !== 'versioned') {
    return {
      written: false,
      requestedFilename: filename,
      filename: next.filename,
      path: path.join(directoryPath, next.filename),
      suggested: { filename: next.filename, version: next.version },
      reason,
      problems: [
        `${filename} already exists and the configured overwrite policy is "${overwritePolicy}": `
        + `nothing was written. Re-run with the suggested name ${next.filename}, or set `
        + 'notes.overwrite_policy: versioned/allow deliberately.',
      ],
    }
  }

  const written = await options.gateway.writeFile({
    filePath: path.join(directoryPath, next.filename),
    cwd: projectRoot,
    content: options.content,
    session: options.session,
    signal: options.signal,
    writePolicy: options.writePolicy,
    expected: { kind: 'createIfAbsent' },
  })
  return {
    written: true,
    path: path.join(directoryPath, next.filename),
    canonicalPath: written.canonicalPath,
    operation: written.operation,
    version: written.version,
    requestedFilename: filename,
    filename: next.filename,
    versioned: true,
    reason: `${reason}-versioned`,
  }
}

/** How many directory levels `listArtifacts` descends below an artifact root. */
export const MAX_ARTIFACT_DEPTH = 4

/**
 * List the artifacts under one root.
 *
 * The walk is **bounded and recursive**, because the layout is genuinely nested: a Markdown note
 * lives at `<root>/<course_id>/<slug>/<file>.md` and a LaTeX project is a whole directory of files
 * at the same place. A single-level listing would silently report "no artifacts" for a root full of
 * them, so the depth is explicit (`MAX_ARTIFACT_DEPTH`) and anything deeper is reported as a
 * problem rather than ignored.
 *
 * @returns `{ present, files: [{ relativePath, size }], problems }`.
 */
export async function listArtifacts(options) {
  const {
    gateway, projectRoot, root, signal, limit = 500, maxDepth = MAX_ARTIFACT_DEPTH,
  } = options
  const target = await gateway.resolveTarget(root, { cwd: projectRoot, signal })
  const info = await gateway.stat(target, signal)
  if (info === undefined) return { present: false, files: [], problems: [] }

  const files = []
  const problems = []

  const walk = async (dirTarget, prefix, depth) => {
    let entries
    try {
      entries = await gateway.listDir(dirTarget, signal)
    } catch (error) {
      problems.push(`${prefix.length === 0 ? '.' : prefix} unreadable: ${error.message}`)
      return
    }
    for (const entry of entries) {
      if (files.length >= limit) return
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (entry.type === 'file') {
        files.push({ relativePath, size: entry.size ?? null })
        continue
      }
      if (entry.type !== 'directory') continue
      if (depth >= maxDepth) {
        problems.push(`${relativePath} was not listed: it is deeper than ${maxDepth} levels`)
        continue
      }
      await walk(entry.target, relativePath, depth + 1)
    }
  }

  await walk(target, '', 1)
  return { present: true, files, problems }
}

/** Expected filename for a title/format pair. */
export function artifactFilenameFor(title, format) {
  const slug = String(title ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'artifact'
  return `${slug}.${extensionFor(format)}`
}
