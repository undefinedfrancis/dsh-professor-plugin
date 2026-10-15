/**
 * Read-only import from the existing Personal-Agent learning workspace.
 *
 * The upstream registry is **not YAML**: `COURSES.md` is a Markdown table and each
 * `Courses/<CODE>.md` is a set of `## Field` headings whose values sit in fenced blocks. Real files
 * have drifted from their own template (missing sections, values outside the declared enums, prose
 * where a path is expected, `N/A` sentinels), so the parser is tolerant and reports anything it
 * could not map instead of guessing.
 *
 * Nothing here writes: the importer returns course inputs for `registerCourse`, and the caller
 * writes only the new `.professor/project.yaml`. The original registry is never modified.
 *
 * @module dsh-professor-spike/src/migrations/personal-agent-registry
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

import { courseIdFor } from '../project/project.js'

/** Short, stable digest of a source document, so a migration plan can reference what it read. */
function digestOf(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

const NA = new Set(['n/a', 'na', 'none', '-', ''])
const isAbsolutePath = (value) => typeof value === 'string' && value.startsWith('/')

function clean(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim().replace(/^`|`$/g, '').trim()
  return NA.has(text.toLowerCase()) ? undefined : text
}

/**
 * Parse the registry index table.
 *
 * @param text - contents of `Registry/COURSES.md`.
 * @returns `{ courses, warnings }` with `{ course_code, course_name, term, status, registry }` rows.
 */
export function parseCoursesIndex(text) {
  const courses = []
  const warnings = []
  for (const [index, line] of String(text).split('\n').entries()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
    if (cells.length < 5) continue
    if (/^-+:?$/.test(cells[0]) || cells[0].length === 0) continue
    if (/^course\s*code$/i.test(cells[0])) continue // header row
    const status = /^(active|completed|archived)$/i.exec(cells[3])?.[1]?.toLowerCase() ?? 'active'
    if (!/^(active|completed|archived)$/i.test(cells[3])) {
      warnings.push(`COURSES.md line ${index + 1}: unrecognised status "${cells[3]}", treated as active`)
    }
    courses.push({
      course_code: cells[0],
      course_name: cells[1],
      term: cells[2],
      status,
      registry: cells[4],
    })
  }
  return { courses, warnings }
}

/**
 * Parse a per-course registry document into its `## Field` values.
 *
 * @param text - contents of `Registry/Courses/<CODE>.md`.
 * @returns `{ fields, warnings }` where fields are keyed by the heading text.
 */
export function parseCourseDocument(text) {
  const lines = String(text).split('\n')
  const fields = {}
  const warnings = []
  let current = null
  let buffer = []
  let fence = false

  const flush = () => {
    if (current === null) return
    const value = buffer.join('\n').trim()
    if (Object.hasOwn(fields, current)) warnings.push(`duplicate section "## ${current}"; the first value was kept`)
    else fields[current] = value
    buffer = []
  }

  for (const line of lines) {
    const heading = /^(#{2,3})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flush()
      current = /^\d+\.\s*$/.test(heading[2].trim()) ? null : heading[2].trim()
      continue
    }
    if (current === null) continue
    if (/^\s*```/.test(line)) {
      fence = !fence
      continue
    }
    if (!fence && /^#\s/.test(line)) {
      flush()
      current = null
      continue
    }
    buffer.push(line)
  }
  flush()
  return { fields, warnings }
}

function mapNoteFormat(value, warnings, courseCode) {
  if (value === undefined) return 'ask'
  const normalized = value.trim().toLowerCase()
  if (normalized === 'latex') return 'latex'
  if (normalized === 'markdown') return 'markdown'
  if (normalized === 'ask every time' || normalized === 'ask') return 'ask'
  warnings.push(`${courseCode}: unrecognised Default Note Format "${value}"; falling back to ask-every-time`)
  return 'ask'
}

function resolveMaybeRelative(value, courseRoot) {
  if (value === undefined) return undefined
  return isAbsolutePath(value) ? value : path.join(courseRoot, value)
}

/**
 * Turn parsed registry fields into a `registerCourse` input.
 *
 * @param options.courseCode - course code.
 * @param options.indexRow - the row from `COURSES.md`, when present.
 * @param options.fields - the parsed per-course fields.
 * @returns `{ input, warnings, unmapped }`; `unmapped` lists fields the project schema does not carry.
 */
export function courseInputFromRegistry(options) {
  const { courseCode, indexRow, fields } = options
  const warnings = []
  const code = clean(courseCode) ?? clean(fields['Course Code'])
  const displayName = clean(fields['Course Name']) ?? clean(indexRow?.course_name) ?? code
  const term = clean(fields.Semester) ?? clean(indexRow?.term) ?? 'unspecified'
  if (clean(fields.Semester) === undefined) {
    warnings.push(`${code}: no semester recorded; imported with term "unspecified"`)
  }

  const courseRoot = clean(fields['Course Root'])
  if (courseRoot === undefined) {
    warnings.push(`${code}: no Course Root recorded; imported without a source path`)
  } else if (!isAbsolutePath(courseRoot)) {
    warnings.push(`${code}: Course Root "${courseRoot}" is not an absolute path; imported without a source path`)
  }

  const sources = []
  if (courseRoot !== undefined && isAbsolutePath(courseRoot)) {
    const categoryRules = {}
    const categoryFields = {
      lectures: 'Lecture Materials',
      tutorials: 'Tutorial Materials',
      assignments: 'Assignment Materials',
      supplementary: 'Additional Course Materials',
    }
    for (const [category, field] of Object.entries(categoryFields)) {
      const declared = clean(fields[field])
      if (declared === undefined) continue
      const resolved = resolveMaybeRelative(declared, courseRoot)
      const effectiveCategory = category === 'supplementary' && /^(05_exams|exams?|exam-materials)$/i.test(path.basename(resolved))
        ? 'exams' : category
      categoryRules[effectiveCategory] = [resolved]
      if (!isAbsolutePath(declared)) {
        warnings.push(`${code}: ${field} "${declared}" is relative; resolved against Course Root as ${resolved}`)
      }
    }
    sources.push(Object.keys(categoryRules).length > 0 ? { path: courseRoot, category_rules: categoryRules } : { path: courseRoot })
  }

  const status = /^(active|completed|archived)$/i.test(indexRow?.status ?? '')
    ? indexRow.status.toLowerCase()
    : 'active'

  const aiNotes = clean(fields['AI Notes Output'])
  const notesRoot = courseRoot === undefined
    ? undefined
    : resolveMaybeRelative(aiNotes ?? '04_My-Notes/AI-Notes', courseRoot)

  const latexTemplate = clean(fields['LaTeX Template'])
  if (latexTemplate !== undefined && !isAbsolutePath(latexTemplate)) {
    warnings.push(`${code}: LaTeX Template is prose rather than a path ("${latexTemplate.slice(0, 60)}…"); left unset`)
  }

  const noteFormat = mapNoteFormat(clean(fields['Default Note Format']), warnings, code)
  const input = {
    course_id: courseIdFor(code),
    course_code: code,
    term,
    display_name: displayName,
    status,
    sources,
    outputs: { notes_root: notesRoot ?? null },
    notes: {
      default_format: noteFormat,
      latex_template: isAbsolutePath(latexTemplate) ? latexTemplate : null,
    },
    registry_fields: Object.entries(fields).map(([field, value]) => ({ field, value })),
  }

  return {
    input,
    notesRoot: notesRoot === undefined ? null : notesRoot,
    noteFormat,
    latexTemplate: isAbsolutePath(latexTemplate) ? latexTemplate : null,
    warnings,
    unmapped: Object.fromEntries(
      Object.entries(fields)
        .filter(([key]) => ![
          'Course Code', 'Course Name', 'Semester', 'Status', 'Course Root', 'AI Notes Output',
          'Default Note Format', 'LaTeX Template', 'Lecture Materials', 'Tutorial Materials',
          'Assignment Materials', 'Additional Course Materials',
        ].includes(key))
        .map(([key, value]) => [key, value.length > 200 ? `${value.slice(0, 200)}…` : value]),
    ),
  }
}

/**
 * Import a whole registry directory, read-only.
 *
 * @param options.readText - `async (absolutePath) => string` (throws when absent).
 * @param options.joinPath - path joiner (tests may inject).
 * @param options.registryDir - absolute path of `01_Learning/Registry`.
 * @param options.only - optional list of course codes to import.
 * @returns `{ entries, report }` where each entry is `{ code, input, warnings, unmapped, notesRoot, noteFormat, latexTemplate }`.
 */
export async function importPersonalAgentRegistry(options) {
  const { readText, registryDir, only } = options
  const report = { warnings: [], skipped: [], courseCount: 0 }

  let indexText = ''
  try {
    indexText = await readText(path.join(registryDir, 'COURSES.md'))
  } catch (error) {
    report.warnings.push(`COURSES.md unreadable (${error.message}); falling back to the Courses/ directory only`)
  }

  const { courses: indexRows, warnings: indexWarnings } = parseCoursesIndex(indexText)
  report.warnings.push(...indexWarnings)

  let directoryEntries = []
  try {
    directoryEntries = await options.listDir(path.join(registryDir, 'Courses'))
  } catch (error) {
    report.warnings.push(`Courses/ directory unreadable (${error.message})`)
  }

  const codes = new Set(indexRows.map((row) => row.course_code))
  for (const file of directoryEntries) {
    if (file.endsWith('.md')) codes.add(file.replace(/\.md$/, ''))
  }

  const entries = []
  for (const code of [...codes].sort()) {
    if (Array.isArray(only) && only.length > 0 && !only.includes(code)) continue
    const row = indexRows.find((candidate) => candidate.course_code === code)
    const registryRelative = row?.registry ?? path.join('Courses', `${code}.md`)
    const registryPath = isAbsolutePath(registryRelative) ? registryRelative : path.join(registryDir, registryRelative)
    let text
    try {
      text = await readText(registryPath)
    } catch (error) {
      report.skipped.push({ code, reason: `registry file unreadable: ${error.message}` })
      continue
    }
    const { fields, warnings } = parseCourseDocument(text)
    const mapped = courseInputFromRegistry({ courseCode: code, indexRow: row, fields })
    report.warnings.push(...warnings, ...mapped.warnings)
    entries.push({
      code,
      registryPath,
      // The digest is what makes a migration auditable after the fact: the plan records exactly
      // which revision of the registry document produced each course.
      digest: digestOf(text),
      input: mapped.input,
      notesRoot: mapped.notesRoot,
      noteFormat: mapped.noteFormat,
      latexTemplate: mapped.latexTemplate,
      unmapped: mapped.unmapped,
    })
    report.courseCount += 1
  }

  return { entries, report }
}
