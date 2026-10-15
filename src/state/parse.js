/**
 * Learning-state parsing (M10).
 *
 * Parses `PROGRESS.md`, `KNOWLEDGE.md`, `MISTAKES.md` and the index out of a course's Knowledge
 * directory. The parser is deliberately **tolerant of heading drift**: real files do not match
 * their own templates (CSC3200's PROGRESS has `## Current Position` where the template says
 * `# 1. Current Position`; MISTAKES puts `## Requested Deep Dives` at level 2 in one course and
 * `# 3. Requested Deep Dives` at level 1 in another). Rules:
 *
 * - match headings by **content**, not by level or numbering (`## Current Position` and
 *   `# 1. Current Position` are the same section);
 * - a label field (`**Recommended Next Step:** ...`) is recognised with or without bold;
 * - unknown sections are preserved verbatim (never dropped), so a parse never loses content;
 * - a missing section is reported as absent rather than invented.
 *
 * Everything returned is plain data; rendering back to Markdown lives in `write.js`.
 *
 * @module dsh-professor-spike/src/state/parse
 */

const HEADING = /^(#{1,6})\s+(.*?)\s*$/
const FIELD = /^(?:\*\*|`)?([^*:]+?)(?:\*\*|`)?\s*:\s*(?:\*\*|`)?\s*(.*)$/

/** Normalise a heading to a comparison key: strip numbering, emphasis, and case. */
function headingKey(text) {
  return String(text ?? '')
    .replace(/^#*\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
}

/** Split a document into sections keyed by normalised heading, preserving unknown headings. */
function sectionsOf(text) {
  const lines = String(text ?? '').split('\n')
  const sections = new Map()
  const order = []
  let current = { key: '(preamble)', heading: null, lines: [], start: 0 }
  for (const [index, line] of lines.entries()) {
    const match = HEADING.exec(line)
    if (match !== null) {
      const heading = match[2].trim()
      const key = headingKey(heading)
      if (!sections.has(key)) {
        sections.set(key, { key, heading, lines: [], start: index })
        order.push(sections.get(key))
      }
      current = sections.get(key)
      continue
    }
    current.lines.push(line)
  }
  const all = order
  return { all, byKey: (needle) => sections.get(headingKey(needle)) }
}

/**
 * Read a `**Label:** value` style field from a section's lines.
 *
 * Tolerates the Markdown hard-break idiom the real files use (`**Current Unit:** x` followed by a
 * line ending in two spaces) — the trailing spaces must not leak into the captured value, and the
 * label must be matched without its emphasis markers.
 */
function readField(section, label) {
  if (section === undefined) return undefined
  const target = headingKey(label)
  for (const line of section.lines) {
    const match = FIELD.exec(line.trim())
    if (match === null) continue
    if (headingKey(match[1]) !== target) continue
    return match[2].trim().replace(/\s+$/, '')
  }
  return undefined
}

/** Parse a Markdown table (header + separator + rows) into objects keyed by header text. */
function parseTable(lines) {
  const rows = []
  let headers = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue // separator row
    if (headers === null) {
      headers = cells
      continue
    }
    const row = {}
    headers.forEach((header, index) => { row[header] = cells[index] ?? '' })
    rows.push(row)
  }
  return { headers: headers ?? [], rows }
}

/** Map the status vocabulary used by the real PROGRESS template to canonical values. */
export const UNIT_STATUSES = ['not_started', 'learning', 'review', 'completed']
export const UNDERSTANDING = ['unknown', 'weak', 'developing', 'good', 'strong']

/**
 * Parse `PROGRESS.md`.
 *
 * @param text - file contents (may be empty).
 * @returns a plain object; absent fields are `null`, never invented.
 */
/**
 * Stable identity of a `Unit Progress` row.
 *
 * The table has no id column — that is the upstream file shape and it is not ours to change — so
 * the unit name *is* the identity. Deriving the id from the name, rather than from the course id
 * (which the parser does not know, because the file already lives under the course), is what makes
 * a unit update idempotent across a write/re-read round trip: an earlier revision keyed the merge
 * on `u_<course>_<unit>`, a value the next parse could never reproduce, so every repeated update
 * silently appended another identical row.
 *
 * @param unit - the unit name as written in the `Unit` cell.
 * @returns a deterministic id, identical for the same name on both sides of the round trip.
 */
export function unitEntryId(unit) {
  const text = String(unit ?? '').trim()
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const suffix = Buffer.from(text, 'utf8').toString('hex').slice(0, 8)
  return `u_${slug}_${suffix}`
}

export function parseProgress(text) {
  const { byKey, all } = sectionsOf(text)
  const position = byKey('Current Position') ?? byKey('1. Current Position')
  const units = byKey('Unit Progress') ?? byKey('2. Unit Progress')

  const unitTable = units === undefined
    ? { headers: [], rows: [] }
    : parseTable(units.lines)

  const review = byKey('Topics Needing Review') ?? byKey('3. Topics Needing Review')
  const goals = byKey('Current Learning Goals') ?? byKey('4. Current Learning Goals')
  const exam = byKey('Exam Preparation State') ?? byKey('5. Exam Preparation State')

  return {
    present: all.length > 1 || (position !== undefined && position !== null),
    current_unit: readField(position, 'Current Unit') ?? null,
    current_topic: readField(position, 'Current Topic') ?? null,
    last_studied: readField(position, 'Last Studied') ?? null,
    recommended_next_step: readField(position, 'Recommended Next Step') ?? null,
    units: unitTable.rows.map((row) => ({
      entry_id: unitEntryId(row.Unit),
      unit: row.Unit ?? '',
      topic: row['Topic / Title'] ?? row.Topic ?? '',
      status: UNIT_STATUSES.includes(row.Status) ? row.Status : (row.Status ?? ''),
      understanding: UNDERSTANDING.includes(row.Understanding) ? row.Understanding : (row.Understanding ?? ''),
      notes: row.Notes ?? '',
    })),
    topics_needing_review: review === undefined ? [] : parseTable(review.lines).rows.map((row) => ({
      topic: row.Topic ?? '',
      reason: row.Reason ?? '',
      priority: row.Priority ?? '',
    })),
    goals: goals === undefined ? [] : goals.lines
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim()),
    exam_mode: readField(exam, 'Exam Mode') ?? null,
  }
}

/**
 * Parse `MISTAKES.md`.
 *
 * Active mistakes are `## <title>` entries under the "Active Mistakes" section; weak topics and
 * requested deep dives are tables (the deep-dive table appears under a heading that drifts in level
 * and numbering across real courses, which is exactly what this parser absorbs).
 *
 * @param text - file contents.
 * @returns `{ active_mistakes, weak_topics, resolved_mistakes, deep_dives }`.
 */
export function parseMistakes(text) {
  const { byKey, all } = sectionsOf(text)
  const active = byKey('Active Mistakes') ?? byKey('1. Active Mistakes')
  const weak = byKey('Weak Topics') ?? byKey('2. Weak Topics')
  const resolved = byKey('Resolved Mistakes') ?? byKey('3. Resolved Mistakes')
  const dives = byKey('Requested Deep Dives')

  // Real files nest each mistake under its own `## <title>` inside the Active Mistakes section,
  // and `sectionsOf` splits on every heading — so collect the entries that follow Active Mistakes
  // up to the next numbered top-level section, rather than only the section's own lines.
  let activeLines = []
  if (active !== undefined) {
    activeLines = [...active.lines]
    const startIndex = all.findIndex((section) => section === active)
    for (const section of all.slice(startIndex + 1)) {
      // Stop at the next numbered top-level section (Weak Topics, Resolved, ...).
      if (/^\d+\./.test(section.heading ?? '')) break
      // The heading itself is not part of `lines` (sectionsOf stores it separately), so feed it in
      // as a line — otherwise the mistake's `## <title>` would never reach the entry scan below.
      if (section.heading != null) activeLines.push(`## ${section.heading}`)
      activeLines.push(...section.lines)
    }
  }

  const activeMistakes = []
  if (activeLines.length > 0) {
    let current = null
    for (const line of activeLines) {
      const match = HEADING.exec(line)
      if (match !== null && match[1].length >= 2 && match[1].length <= 6) {
        const key = headingKey(match[2])
        // Stop at the next numbered top-level section (e.g. `# 2. Weak Topics`).
        if (/^\d+\./.test(match[2].trim())) break
        current = { title: match[2].trim(), lines: [] }
        activeMistakes.push(current)
        continue
      }
      if (current !== null) current.lines.push(line)
    }
  }

  const deepDives = dives === undefined ? [] : parseTable(dives.lines).rows.map((row) => ({
    date: row.Date ?? '',
    topic: row.Topic ?? '',
    question: row['Question (paraphrased)'] ?? row.Question ?? '',
    cause: row['Cause of difficulty'] ?? row.Cause ?? '',
    review_action: row['Suggested review action'] ?? row['Suggested review'] ?? row.Action ?? '',
  }))

  return {
    present: all.length > 1 || activeLines.length > 0,
    active_mistakes: activeMistakes.map((entry) => ({
      title: entry.title,
      body: entry.lines.join('\n').trim(),
    })),
    weak_topics: weak === undefined ? [] : parseTable(weak.lines).rows.map((row) => ({
      topic: row.Topic ?? '',
      weakness: row.Weakness ?? row.Reason ?? '',
      reinforcement: row['Recommended Reinforcement'] ?? '',
    })),
    resolved_mistakes: resolved === undefined ? [] : parseTable(resolved.lines).rows.map((row) => row),
    deep_dives: deepDives,
  }
}

/**
 * Parse `KNOWLEDGE.md`: the top-level sections plus the `## <concept>` entries inside them.
 *
 * Concept entries carry their body verbatim so merging can compare rather than reflow.
 *
 * @param text - file contents.
 * @returns `{ sections }` where each section has `heading`, `level`, `concepts`, `body`.
 */
export function parseKnowledge(text) {
  const lines = String(text ?? '').split('\n')
  const sections = []
  let current = { heading: null, level: 0, lines: [], concepts: [] }
  let concept = null

  const flushConcept = () => {
    if (concept !== null) {
      concept.body = concept.lines.join('\n').trim()
      delete concept.lines
      current.concepts.push(concept)
      concept = null
    }
  }

  for (const line of lines) {
    const match = HEADING.exec(line)
    if (match === null) {
      if (concept !== null) concept.lines.push(line)
      else current.lines.push(line)
      continue
    }
    const level = match[1].length
    const heading = match[2].trim()
    if (level === 1) {
      flushConcept()
      if (current.heading !== null || current.lines.length > 0) {
        current.body = current.lines.join('\n').trim()
        sections.push(current)
      }
      current = { heading, level, lines: [], concepts: [] }
      continue
    }
    if (level === 2) {
      flushConcept()
      concept = { title: heading, level, lines: [] }
      continue
    }
    // Deeper headings belong to the current concept as literal content.
    if (concept !== null) concept.lines.push(line)
    else current.lines.push(line)
  }
  flushConcept()
  if (current.heading !== null || current.lines.length > 0) {
    current.body = current.lines.join('\n').trim()
    sections.push(current)
  }

  return { sections }
}

/**
 * Parse the Material Index table of `INDEX.md` (the course file, not this plugin's file index).
 *
 * @param text - file contents.
 * @returns rows as `{ unit, type, title, source, ai_note, status }`.
 */
export function parseIndexMaterials(text) {
  const { byKey, all } = sectionsOf(text)
  // The real files differ from their own template: the tables live under `## File Inventory`,
  // grouped by `### <directory>`, with no `Material Index` heading at all. Collect every table
  // that has the Material-Index column shape, from whichever heading carries it.
  const anchor = byKey('Material Index') ?? byKey('1. Material Index') ?? byKey('File Inventory')
  // The real files group tables under `### <directory>` children of `## File Inventory`, so collect
  // the anchor's own tables plus every section that follows it (its children).
  const candidates = anchor === undefined
    ? all
    : all.filter((section) => section.start >= anchor.start)
  const rows = []
  for (const section of candidates) {
    const table = parseTable(section.lines)
    if (table.headers.length === 0 || !table.headers.includes('Unit') || !table.headers.includes('Type')) continue
    for (const row of table.rows) {
      rows.push({
        unit: row.Unit ?? '',
        type: row.Type ?? '',
        title: row.Title ?? '',
        source: row.Source ?? '',
        ai_note: row['AI Note'] ?? '',
        status: row.Status ?? '',
      })
    }
  }
  return rows
}
