/**
 * Material conventions: which directory under a course root holds what.
 *
 * One table, two consumers. The course registry derives a source's `category_rules` from it when a
 * course is registered, and Phase 3 onboarding derives the *same* rules (plus a per-category report
 * for the proposal the user reviews) while discovering a folder. Before this module existed the
 * table lived inside `src/tools/courses.js` and onboarding would have had to copy it — the classic
 * way two code paths start disagreeing about what `05_Exams` means.
 *
 * ## The categories
 *
 * {@link MATERIAL_CATEGORIES} is the closed vocabulary the indexer's classifier already accepts
 * (`lectures`, `tutorials`, `assignments`, `exams`, `supplementary`). `supplementary` is the one
 * added by Phase 3, and it exists precisely so that `06_Code` and `00_Course-Info` have somewhere
 * honest to go: **neither is exam evidence.** Recording them as `supplementary` is what stops a
 * code folder from being counted as revision material, and it is the mapping the registry's
 * `Additional Course Materials` field already declared.
 *
 * ## What this module refuses to do
 *
 * It never invents a category from a file name, a file count or a guess: only a directory whose
 * *name* matches a documented convention is classified, and a directory that matches nothing stays
 * unclassified (reported, never silently binned). {@link MIGRATION_FIELD_MAP} in
 * `src/tools/courses.js` remains the stable record of how registry fields map onto these.
 *
 * @module dsh-professor-spike/src/workspace/materials
 */

import path from 'node:path'

import { OFFICE_EXTENSIONS, PDF_EXTENSIONS, TEXT_EXTENSIONS } from '../extract/capabilities.js'

/**
 * The closed category vocabulary, in convention order.
 *
 * `supplementary` is last on purpose: it is the bucket a directory falls into when it is clearly
 * course material but is neither a lecture, a tutorial, an assignment nor an exam.
 */
export const MATERIAL_CATEGORIES = Object.freeze([
  'lectures',
  'tutorials',
  'assignments',
  'exams',
  'supplementary',
])

/**
 * Which directory names mean which category.
 *
 * The order inside `candidates` is the order results are reported in, and it is stable: a
 * convention written into a `project.yaml` today keeps its position tomorrow.
 *
 * `06_Code` precedes `00_Course-Info` because code is the more common supplementary folder; both
 * are recorded when both are present (a course may legitimately ship both).
 */
export const DIRECTORY_CATEGORIES = Object.freeze([
  Object.freeze({ category: 'lectures', candidates: Object.freeze(['01_Lectures', 'lectures', 'lecture', 'slides']) }),
  Object.freeze({ category: 'tutorials', candidates: Object.freeze(['02_Tutorials', 'tutorials', 'tutorial']) }),
  Object.freeze({ category: 'assignments', candidates: Object.freeze(['03_Assignments', 'assignments', 'assignment']) }),
  Object.freeze({ category: 'exams', candidates: Object.freeze(['05_Exams', 'exams', 'exam']) }),
  Object.freeze({
    category: 'supplementary',
    candidates: Object.freeze(['06_Code', 'code', '00_Course-Info', 'course-info']),
  }),
])

/**
 * Every directory name any convention recognises, lower-cased.
 *
 * Used to answer "is this name *known* material naming?" separately from "is its category enabled
 * for this caller?" — the two questions differ, and conflating them made a `06_Code` folder look
 * unrecognised when a caller had only opted out of supplementary rules.
 */
const RECOGNISED = new Set(
  DIRECTORY_CATEGORIES.flatMap((entry) => entry.candidates.map((candidate) => candidate.toLowerCase())),
)

/** True when a directory name matches a documented material convention. */
export function isMaterialDirectoryName(name) {
  return typeof name === 'string' && RECOGNISED.has(name.trim().toLowerCase())
}

/**
 * File extensions that make a folder look like academic material during discovery.
 *
 * Deliberately the extraction module's own sets plus PDF/Office: a directory of `image.png` and
 * `data.bin` is not a course, whereas a directory holding a single `notes.md` plausibly is one and
 * should therefore be *offered for confirmation* rather than silently ignored. This is a
 * plausibility signal for the proposal, never evidence used to assign an identity.
 */
export const MATERIAL_DOCUMENT_EXTENSIONS = Object.freeze(
  new Set([...TEXT_EXTENSIONS, ...PDF_EXTENSIONS, ...OFFICE_EXTENSIONS]),
)

/** True when a file name carries a document-like extension (see {@link MATERIAL_DOCUMENT_EXTENSIONS}). */
export function isMaterialDocumentName(name) {
  if (typeof name !== 'string') return false
  const extension = path.extname(name).replace(/^\./, '').toLowerCase()
  return extension.length > 0 && MATERIAL_DOCUMENT_EXTENSIONS.has(extension)
}

/**
 * Derive category rules and a per-category report for one source root.
 *
 * @param options.sourcePath - the absolute course root the names belong to.
 * @param options.names - the directory names present directly under `sourcePath`. Required: the
 *   caller has already listed the directory, so this function stays pure and testable.
 * @param options.includeSupplementary - when false, `supplementary` is not derived at all and its
 *   absence is reported through `missing`. The course registry passes `false` so its legacy
 *   four-category shape is preserved byte for byte; onboarding passes `true`.
 * @returns `{ categoryRules, categories, missing, unclassified }` where
 *   - `categoryRules` maps an enabled category to **every** matching absolute directory, in
 *     convention order (the classifier matches the longest prefix, so one category may legitimately
 *     cover two sibling directories);
 *   - `categories` maps a category to `[{ name, path }]`, the per-directory report the proposal
 *     shows a user;
 *   - `missing` lists enabled categories with no matching directory — a rule is never invented for
 *     a directory that is not there;
 *   - `unclassified` lists the supplied names that match no convention at all, so nothing is
 *     quietly discarded.
 */
export function deriveMaterialRules(options = {}) {
  const sourcePath = typeof options.sourcePath === 'string' ? options.sourcePath : ''
  const includeSupplementary = options.includeSupplementary === true
  const names = (Array.isArray(options.names) ? options.names : [])
    .filter((name) => typeof name === 'string' && name.trim().length > 0)

  // Name comparison is case-insensitive: `Slides` and `slides` are the same convention, and a
  // macOS default filesystem would have matched them through a directory probe anyway. It is a
  // naming convention, not a guess — the *category* still comes only from the documented list.
  const byLowerName = new Map(names.map((name) => [name.trim().toLowerCase(), name.trim()]))

  const categoryRules = {}
  const categories = {}
  const missing = []
  const recognised = new Set()

  for (const entry of DIRECTORY_CATEGORIES) {
    const enabled = entry.category !== 'supplementary' || includeSupplementary
    const matched = []
    for (const candidate of entry.candidates) {
      const actual = byLowerName.get(candidate.toLowerCase())
      if (actual === undefined) continue
      recognised.add(actual.toLowerCase())
      matched.push(actual)
    }
    if (matched.length === 0) {
      if (enabled) missing.push(entry.category)
      continue
    }
    const entries = matched.map((name) => ({ name, path: path.join(sourcePath, name) }))
    categories[entry.category] = entries
    if (enabled) categoryRules[entry.category] = entries.map((item) => item.path)
  }

  const unclassified = names
    .map((name) => name.trim())
    .filter((name) => !recognised.has(name.toLowerCase()))

  return { categoryRules, categories, missing, unclassified }
}
