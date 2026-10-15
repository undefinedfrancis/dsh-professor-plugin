/** Repair the legacy import projection without touching learning state or source documents. */
export function repairImportedProject(document, entries) {
  const repaired = structuredClone(document)
  for (const entry of entries) {
    const matches = repaired.courses.filter(course => course.course_code.toUpperCase() === entry.input.course_code.toUpperCase())
    if (matches.length !== 1) throw new Error(`Ambiguous or missing course: ${entry.input.course_code}`)
    const course = matches[0]
    for (const source of entry.input.sources ?? []) {
      const existing = course.sources.find(item => item.path === source.path)
      if (!existing) throw new Error(`Source mismatch for ${entry.input.course_code}: ${source.path}`)
      const rules = existing.category_rules ?? {}
      const supplementary = source.category_rules?.supplementary ?? []
      if (Array.isArray(rules.exams)) {
        rules.exams = rules.exams.filter(item => !supplementary.includes(item))
        if (rules.exams.length === 0) delete rules.exams
      }
      existing.category_rules = { ...rules, ...structuredClone(source.category_rules ?? {}) }
    }
    for (const key of ['outputs', 'notes', 'registry_fields']) {
      if (entry.input[key] !== undefined) course[key] = structuredClone(entry.input[key])
    }
    if (entry.notesRoot && repaired.outputs?.notes_root === entry.notesRoot) repaired.outputs.notes_root = null
    if (entry.latexTemplate && repaired.notes?.latex_template === entry.latexTemplate) repaired.notes.latex_template = null
  }
  repaired.notes = { ...repaired.notes, default_format: 'ask' }
  return repaired
}
