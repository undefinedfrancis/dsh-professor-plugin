/**
 * LaTeX template handling (M11, v3 §9.6 steps 1–5).
 *
 * The shared master template is **read-only**: this module reads it through the filesystem gateway
 * and writes copies into the new artifact project. Nothing here can modify the template, and the
 * copy is create-only, so re-running cannot silently clobber generated content either.
 *
 * Two details matter for reproducibility:
 *
 * - a stray `latexmkrc` / `.latexmkrc` in a template is **not** copied (and is reported), because a
 *   per-directory rc can re-enable shell escape behind the plugin's explicit flags;
 * - the walk is bounded (`MAX_TEMPLATE_FILES` / `MAX_TEMPLATE_BYTES`), so a template that points at
 *   a huge tree degrades into a clear problem instead of an unbounded read.
 *
 * @module dsh-professor-spike/src/latex/template
 */

import path from 'node:path'

/** Bounds for a template copy. */
export const MAX_TEMPLATE_FILES = 200
export const MAX_TEMPLATE_BYTES = 4 * 1024 * 1024

/** File names never copied from a template, with the reason recorded. */
export const TEMPLATE_SKIP_NAMES = new Set(['.latexmkrc', 'latexmkrc'])

function fail(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Inspect a configured LaTeX template.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.projectRoot - resolution base.
 * @param options.templatePath - the configured `notes.latex_template` value.
 * @param options.signal - cancellation.
 * @returns `{ ok, kind, files, texFiles, mainCandidates, skipped, problems }`.
 */
export async function inspectTemplate(options) {
  const { gateway, projectRoot, templatePath, signal } = options
  const problems = []
  const skipped = []

  if (typeof templatePath !== 'string' || templatePath.trim().length === 0) {
    return {
      ok: false,
      kind: null,
      files: [],
      texFiles: [],
      mainCandidates: [],
      skipped,
      problems: ['no LaTeX template is configured (notes.latex_template is null); register a template or generate the project from scratch'],
    }
  }
  const declared = templatePath.trim()
  if (!path.isAbsolute(declared)) {
    return {
      ok: false,
      kind: null,
      files: [],
      texFiles: [],
      mainCandidates: [],
      skipped,
      problems: [`the configured LaTeX template is not an absolute path: ${declared}`],
    }
  }
  if (declared.includes('..')) {
    return {
      ok: false,
      kind: null,
      files: [],
      texFiles: [],
      mainCandidates: [],
      skipped,
      problems: [`the configured LaTeX template contains a ".." segment: ${declared}`],
    }
  }

  const root = await gateway.resolveTarget(declared, { cwd: projectRoot, signal })
  const info = await gateway.stat(root, signal)
  if (info === undefined) {
    return {
      ok: false,
      kind: null,
      files: [],
      texFiles: [],
      mainCandidates: [],
      skipped,
      problems: [`the configured LaTeX template does not exist: ${declared}`],
    }
  }

  const files = []
  let totalBytes = 0

  const collect = async (target, prefix) => {
    const entries = await gateway.listDir(target, signal)
    for (const entry of entries) {
      if (files.length >= MAX_TEMPLATE_FILES) {
        skipped.push({ relative: prefix, reason: `template exceeds ${MAX_TEMPLATE_FILES} files` })
        return
      }
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (entry.type === 'directory') {
        if (entry.name === '.git' || entry.name === 'node_modules') {
          skipped.push({ relative, reason: 'build/dependency directory' })
          continue
        }
        await collect(entry.target, relative)
        continue
      }
      if (entry.type !== 'file') {
        skipped.push({ relative, reason: `not a regular file (${entry.type})` })
        continue
      }
      if (TEMPLATE_SKIP_NAMES.has(entry.name)) {
        skipped.push({ relative, reason: 'rc file skipped: it could override the explicit compiler flags' })
        continue
      }
      totalBytes += entry.size ?? 0
      if (totalBytes > MAX_TEMPLATE_BYTES) {
        skipped.push({ relative, reason: `template exceeds ${MAX_TEMPLATE_BYTES} bytes` })
        return
      }
      files.push({ relative, target: entry.target, bytes: entry.size ?? null })
    }
  }

  try {
    if (info.type === 'file') {
      files.push({ relative: path.basename(declared), target: root, bytes: info.size ?? null })
    } else {
      await collect(root, '')
    }
  } catch (error) {
    problems.push(`template unreadable: ${error.message}`)
  }

  const texFiles = files.filter((file) => file.relative.endsWith('.tex'))
  const mainCandidates = [
    ...texFiles.filter((file) => /(^|\/)main\.tex$/.test(file.relative)).map((file) => file.relative),
    ...texFiles.filter((file) => !/(^|\/)main\.tex$/.test(file.relative)).map((file) => file.relative),
  ]
  if (texFiles.length === 0) problems.push('the template contains no .tex file')

  return {
    ok: problems.length === 0,
    kind: info.type === 'file' ? 'file' : 'directory',
    root: declared,
    files,
    texFiles: texFiles.map((file) => file.relative),
    mainCandidates,
    skipped,
    problems,
  }
}

/**
 * Copy a template into an artifact project directory.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.projectRoot - resolution base.
 * @param options.inspection - a value from `inspectTemplate` (the file list comes from there).
 * @param options.destinationDir - absolute directory of the new artifact project.
 * @param options.writePolicy - the plugin's write policy (must already allow the destination).
 * @param options.session / options.signal - as usual.
 * @returns `{ copied, problems }` where each entry is `{ relative, bytes }`.
 */
export async function copyTemplate(options) {
  const {
    gateway, projectRoot, inspection, destinationDir, writePolicy, session, signal,
  } = options
  if (inspection?.ok !== true) {
    throw fail(inspection?.problems?.[0] ?? 'the template could not be inspected', 'PROFESSOR_LATEX_TEMPLATE_INVALID')
  }

  const copied = []
  const problems = []
  for (const file of inspection.files) {
    let bytes
    try {
      bytes = await gateway.readBytes(file.target, signal, MAX_TEMPLATE_BYTES)
    } catch (error) {
      problems.push(`could not read template file ${file.relative}: ${error.message}`)
      continue
    }
    try {
      // Create-only: a second run never silently replaces generated files.
      const written = await gateway.writeFile({
        filePath: path.join(destinationDir, file.relative),
        cwd: projectRoot,
        content: bytes,
        session,
        signal,
        writePolicy,
        expected: { kind: 'createIfAbsent' },
      })
      copied.push({ relative: file.relative, bytes: bytes.byteLength ?? bytes.length, canonicalPath: written.canonicalPath })
    } catch (error) {
      if (error?.code === 'FS_NOT_OBSERVED') {
        problems.push(`${file.relative} already exists in the artifact project; left untouched`)
        continue
      }
      problems.push(`could not write ${file.relative}: ${error.message}`)
    }
  }
  return { copied, problems }
}
