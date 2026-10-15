/**
 * `professor_state_read` / `professor_state_update` — learning-state tools (M10).
 *
 * State lives at `.professor/state/<course_id>/{PROGRESS,KNOWLEDGE,MISTAKES,INDEX}.md`, one
 * directory per course, keyed by the bound course. Reads parse with the tolerant parser;
 * writes go through the gateway with the observed fs version, so a concurrent update is refused
 * (`PROFESSOR_STATE_STALE`) instead of being silently lost, and a lightweight question
 * (`evidence: none`) is rejected before it can touch disk.
 *
 * @module dsh-professor-spike/src/tools/state
 */

import { projectPaths, sessionId as sessionIdOf } from '../paths/roots.js'
import { recordConflict } from '../state/conflicts.js'
import { resolveCourseContext, readStateFile, STATE_FILES } from '../state/course-context.js'
import { parseKnowledge, parseMistakes, parseProgress, unitEntryId } from '../state/parse.js'
import {
  compressState, DEFAULT_LINE_BUDGET, evidencePermitsWrite, lineCount, mergeEntry, mergeMistakes,
  planStateUpdate, validateStateUpdate,
} from '../state/write.js'
import { jsonOutput, oneOfTypes } from './support.js'

export const STATE_READ_TOOL_NAME = 'professor_state_read'
export const STATE_UPDATE_TOOL_NAME = 'professor_state_update'

/**
 * A session-scoped read cache for the state files.
 *
 * One complete `professor_state_read` already returns every file, so the four single-file reads
 * that followed it in a live session were pure duplicates: four more `readText` calls for content
 * the model had just received. This cache makes the second read a **stat** instead of a read.
 *
 * The rules it has to keep honest:
 *
 * - **freshness is proved, never assumed.** The cached record is served only when the file's
 *   current `fs_version` equals the version that was cached; a changed file is re-read.
 * - **scope is one session.** Entries are keyed by session id, so two conversations never share
 *   another's learning state.
 * - **bounded.** The oldest entry is dropped at the cap; nothing grows without limit.
 * - **`refresh: true` always re-reads**, and a missing file evicts its entry rather than being
 *   served from memory.
 *
 * @param options.maxEntries - cache capacity.
 * @returns `{ read, clear, size }`.
 */
export function createStateReadCache({ maxEntries = 256 } = {}) {
  const entries = new Map()

  return {
    /**
     * Read one state file, reusing an unchanged cached copy.
     *
     * @returns `{ record, reused, version, checkedAt }` where `record` is `undefined` when the file
     *   is absent (exactly what `readStateFile` returns).
     */
    async read({ gateway, projectRoot, courseId, file, sessionId, signal, refresh = false }) {
      const key = `${sessionId ?? 'no-session'}|${courseId}|${file}`
      const target = await gateway.resolveTarget(projectPaths(projectRoot).courseStateFile(courseId, file), {
        cwd: projectRoot, signal,
      })
      const info = await gateway.stat(target, signal)
      const checkedAt = new Date().toISOString()
      if (info === undefined) {
        entries.delete(key)
        return { record: undefined, reused: false, version: null, checkedAt, absent: true }
      }
      const hit = refresh === true ? undefined : entries.get(key)
      if (hit !== undefined && hit.version === info.version) {
        return { record: hit.record, reused: true, version: info.version, checkedAt, absent: false }
      }
      const text = await gateway.readText(target, signal)
      const record = { text, version: info.version, target }
      entries.set(key, { version: info.version, record })
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value)
      }
      return { record, reused: false, version: info.version, checkedAt, absent: false }
    },

    clear() { entries.clear() },
    get size() { return entries.size },
  }
}

/**
 * Define `professor_state_read`.
 *
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`; course-owned tools
 *   receive a wrapper that throws `PROFESSOR_PROJECT_MISSING` for an unbound workspace.
 * @param options.gateway - filesystem gateway.
 * @returns the tool definition.
 */
export function defineStateReadTool(options) {
  const { resolveProject, gateway, telemetry } = options
  const cache = createStateReadCache()

  return {
    name: STATE_READ_TOOL_NAME,
    description: 'Read the learning state of a course: current position, unit progress, knowledge entries, mistakes, weak topics and requested deep dives. Parses the real file shapes (tolerant of heading drift) and reports counts plus the parsed fields. One call reads every file — do not re-read the same state afterwards: an unchanged file is answered from this session\'s cache (reported as reused with its freshness evidence) and only a changed file is read again; pass refresh: true to force a re-read. A course with no state yet is the normal first-study condition, not an error: proceed with the material instead of trying to recover something that was never written. Read-only: it never writes state.',
    parameters: {
      type: 'object',
      properties: {
        course: { type: 'string', description: 'Course id; defaults to this session\'s binding.' },
        file: { type: 'string', description: 'Limit to one file: PROGRESS.md, KNOWLEDGE.md, MISTAKES.md or INDEX.md.' },
        refresh: { type: 'boolean', description: 'Ignore this session\'s cache and re-read from disk (default false). The cache already invalidates on a changed file version.' },
      },
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        course_id: { type: 'string' },
        present: { type: 'boolean' },
        files: { type: 'object' },
        summary: { type: 'object' },
        warnings: { type: 'array' },
      },
      required: ['course_id', 'present', 'files', 'summary', 'warnings'],
    }),

    async execute(args = {}, exec) {
      const project = await resolveProject(exec)
      const signal = exec?.signal
      const warnings = []
      const sessionId = sessionIdOf(exec) ?? 'no-session'
      const refresh = args.refresh === true
      const { course } = await resolveCourseContext({
        gateway, projectRoot: project.root, signal, exec, courseId: args.course,
      })

      const wanted = typeof args.file === 'string' && args.file.trim().length > 0
        ? [args.file.trim()]
        : STATE_FILES
      const files = {}
      let present = false
      let reusedCount = 0
      let readCount = 0

      for (const file of wanted) {
        if (!STATE_FILES.includes(file)) {
          warnings.push(`unknown state file "${file}"; expected one of ${STATE_FILES.join(', ')}`)
          continue
        }
        const outcome = await cache.read({
          gateway,
          projectRoot: project.root,
          courseId: course.course_id,
          file,
          sessionId,
          signal,
          refresh,
        })
        const record = outcome.record
        if (record === undefined) {
          files[file] = { present: false, fresh: { checked_at: outcome.checkedAt, unchanged: null } }
          continue
        }
        present = true
        if (outcome.reused) reusedCount += 1
        else readCount += 1
        const freshness = {
          checked_at: outcome.checkedAt,
          version: outcome.version,
          unchanged: outcome.reused,
          source: outcome.reused ? 'session cache (fs_version unchanged)' : 'disk',
        }
        if (file === 'PROGRESS.md') files[file] = { present: true, parsed: parseProgress(record.text), revision: record.version, fresh: freshness }
        else if (file === 'MISTAKES.md') files[file] = { present: true, parsed: parseMistakes(record.text), revision: record.version, fresh: freshness }
        else if (file === 'KNOWLEDGE.md') files[file] = { present: true, parsed: parseKnowledge(record.text), revision: record.version, fresh: freshness }
        else files[file] = { present: true, revision: record.version, lines: lineCount(record.text), fresh: freshness }
      }

      const progress = files['PROGRESS.md']?.parsed
      const mistakes = files['MISTAKES.md']?.parsed
      const knowledge = files['KNOWLEDGE.md']?.parsed
      const summary = {
        has_progress: progress !== undefined && progress.present,
        current_unit: progress?.current_unit ?? null,
        recommended_next_step: progress?.recommended_next_step ?? null,
        units_tracked: progress?.units?.length ?? 0,
        knowledge_sections: knowledge?.sections?.length ?? 0,
        knowledge_concepts: (knowledge?.sections ?? []).reduce((sum, section) => sum + section.concepts.length, 0),
        active_mistakes: mistakes?.active_mistakes?.length ?? 0,
        weak_topics: mistakes?.weak_topics?.length ?? 0,
        requested_deep_dives: mistakes?.deep_dives?.length ?? 0,
        // First study is a *normal condition*, named as such so a model cannot read "no state"
        // as a broken workspace and start hunting for it.
        first_study: present === false,
        files_reused: reusedCount,
        files_read: readCount,
        note: present
          ? 'state restored; continue from recommended_next_step rather than asking where to start'
          : 'no learning state for this course yet — the normal first-study condition: start from the material, '
            + 'do not re-read state or rebuild indexes looking for something that was never written',
      }

      if (typeof telemetry === 'function') {
        telemetry('state.read', {
          course: course.course_id,
          read: readCount,
          reused: reusedCount,
          first_study: present === false,
          cache: refresh ? 'bypassed' : 'session',
        })
      }
      return { course_id: course.course_id, present, files, summary, warnings }
    },
  }
}

/**
 * Define `professor_state_update`.
 *
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`; course-owned tools
 *   receive a wrapper that throws `PROFESSOR_PROJECT_MISSING` for an unbound workspace.
 * @param options.gateway - filesystem gateway.
 * @param options.policiesFor - `(projectRoot) => { read, write }`.
 * @param options.logger - plugin logger.
 * @returns the tool definition.
 */
export function defineStateUpdateTool(options) {
  const { resolveProject, gateway, policiesFor, outputRootsFor, logger } = options

  return {
    name: STATE_UPDATE_TOOL_NAME,
    description: 'Update a course learning state file. Requires evidence (weak/strong) — a lightweight question with evidence "none" is refused and changes nothing. Merge is by entry id (no duplicate rows), writes are guarded by the observed revision (concurrent updates are refused, not lost), and oversized state is compressed before writing. Never deletes history; resolved items are marked, not removed.',
    parameters: {
      type: 'object',
      properties: {
        course: { type: 'string', description: 'Course id; defaults to this session\'s binding.' },
        // The advertised contract must match what is implemented. `PROGRESS.md` and `MISTAKES.md`
        // have renderers, so this tool can safely rewrite them; `KNOWLEDGE.md` and `INDEX.md` are
        // read-only here (there is no renderer for them), and the model edits those with the
        // filesystem tools. An earlier revision listed all four files *and* a `concept` kind, so a
        // caller following the schema got a refusal for a shape the schema had just offered.
        file: { type: 'string', enum: ['PROGRESS.md', 'MISTAKES.md'], description: 'Writable state file. KNOWLEDGE.md and INDEX.md are read-only here: read them with professor_state_read and edit them with the filesystem tools.' },
        evidence: { type: 'string', enum: ['none', 'weak', 'strong'], description: 'none = lightweight question (no write); weak = self-reported understanding or performance completed with assistance (record which, and any remaining gaps, in the entry body/notes; for hint-assisted work record 提示辅助完成；独立能力尚未验证, never an independently-completed phrasing); strong = observed independent performance (solved/answered/explained back without help). One independently correct answer is evidence for that task, not durable mastery of the unit.' },
        reason: { type: 'string', description: 'Why this update is warranted (recorded on the plan).' },
        kind: { type: 'string', enum: ['mistake', 'deep-dive', 'field', 'unit'], description: 'MISTAKES.md accepts "mistake" and "deep-dive"; PROGRESS.md accepts "unit" (or use `field`).' },
        title: { type: 'string', description: 'Entry title (mistake/concept/unit).' },
        body: { type: 'string', description: 'Entry body or updated text.' },
        topic: { type: 'string', description: 'Deep-dive topic (kind: deep-dive).' },
        question: { type: 'string', description: 'Deep-dive question, paraphrased (kind: deep-dive).' },
        cause: { type: 'string', description: 'Why it is difficult (kind: deep-dive).' },
        review_action: { type: 'string', description: 'Suggested review action (kind: deep-dive).' },
        field: { type: 'string', description: 'PROGRESS.md field to set (current_unit/current_topic/last_studied/recommended_next_step/exam_mode).' },
        value: { type: 'string', description: 'New value for the field.' },
        unit: { type: 'string', description: 'Unit name (kind: unit). Required for a unit update — title is not a substitute; without unit the write is refused and nothing persists.' },
        status: { type: 'string', description: 'Unit status (kind: unit): not_started/learning/review/completed.' },
        overwrite: { type: 'boolean', description: 'Replace an existing entry body instead of merging (default false).' },
        dry_run: { type: 'boolean', description: 'Report the plan without writing.' },
      },
      required: ['file', 'evidence'],
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        course_id: { type: 'string' },
        file: { type: 'string' },
        evidence: { type: 'string' },
        writable: { type: 'boolean' },
        written: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        plan: { type: 'object' },
        revision: oneOfTypes('string', 'number', 'null'),
        compression: { type: 'object' },
        warnings: { type: 'array' },
        problems: { type: 'array' },
      },
      required: ['course_id', 'file', 'evidence', 'writable', 'written', 'dryRun', 'plan', 'revision', 'compression', 'warnings', 'problems'],
    }),

    async execute(args = {}, exec) {
      const project = await resolveProject(exec)
      const signal = exec?.signal
      const warnings = []
      const problems = []
      const file = args.file
      const evidence = args.evidence

      // `resolveCourseContext` already loads and validates the project document (and refuses an
      // unsupported schema). Reuse that document to derive the write policy instead of reading it
      // a second time — and, critically, instead of referencing a `loaded` binding that never
      // existed in this scope (the regression that made every state update throw).
      const { course, document } = await resolveCourseContext({
        gateway, projectRoot: project.root, signal, exec, courseId: args.course,
      })
      const policies = policiesFor(project.root, outputRootsFor(document))

      // 1. Plan: a lightweight question yields a non-writable plan, before any file is touched.
      const entry = typeof args.title === 'string' && args.title.trim().length > 0
        ? { file, title: args.title.trim(), body: args.body }
        : undefined
      // A shape with no title still counts as a change: a PROGRESS field/unit edit *is* the change,
      // and a deep-dive's identity is its topic + question (which is what `mergeMistakes` keys on),
      // not a title. Omitting the deep-dive case planned zero changes, so the advertised
      // `kind: deep-dive` shape was silently reported as "not written" with no explanation.
      const wantsChange = typeof args.field === 'string'
        || typeof args.unit === 'string'
        || (args.kind === 'deep-dive' && typeof args.topic === 'string')
      const change = entry === undefined && wantsChange
        ? { file, field: args.field, unit: args.unit, value: args.value, topic: args.topic, question: args.question }
        : undefined
      const { writable, plan } = planStateUpdate({
        courseId: course.course_id,
        evidence,
        reason: args.reason,
        entry: evidencePermitsWrite(evidence) ? entry : undefined,
        change: evidencePermitsWrite(evidence) ? change : undefined,
      })
      const validation = validateStateUpdate(plan)

      if (!validation.ok) {
        return {
          course_id: course.course_id,
          file,
          evidence,
          writable: false,
          written: false,
          dryRun: args.dry_run === true,
          plan,
          revision: null,
          compression: { removed: 0 },
          warnings,
          problems: validation.errors,
        }
      }
      if (!writable) {
        // Refuse to persist anything: this is the invariant that makes lightweight questions
        // provably harmless.
        return {
          course_id: course.course_id,
          file,
          evidence,
          writable: false,
          written: false,
          dryRun: args.dry_run === true,
          plan,
          revision: null,
          compression: { removed: 0 },
          warnings,
          problems: [],
        }
      }

      // 2. Read current state with its version.
      const current = await readStateFile({ gateway, projectRoot: project.root, courseId: course.course_id, file, signal })
      const currentText = current?.text ?? ''
      const parsed = file === 'PROGRESS.md'
        ? parseProgress(currentText)
        : file === 'MISTAKES.md'
          ? parseMistakes(currentText)
          : file === 'KNOWLEDGE.md'
            ? parseKnowledge(currentText)
            : { present: currentText.length > 0, sections: [] }

      // 3. Merge.
      let merged = currentText
      let created = false
      let updated = false
      let scaffold = false

      if (file === 'MISTAKES.md' && (args.kind === 'mistake' || args.kind === 'deep-dive')) {
        const outcome = mergeMistakes(parsed, {
          kind: args.kind,
          course_id: course.course_id,
          title: args.title,
          body: args.body,
          topic: args.topic,
          question: args.question,
          cause: args.cause,
          review_action: args.review_action,
          date: new Date().toISOString().slice(0, 10),
          last_seen: new Date().toISOString().slice(0, 10),
          entry: undefined,
        })
        created = outcome.created
        updated = outcome.updated
        merged = renderMistakes(parsed, outcome)
      } else if (file === 'PROGRESS.md' && typeof args.field === 'string') {
        // Edit the raw document: the parser keeps structure, not the original text, so rewriting
        // from the parsed object would drop every section the parser did not model.
        const applied = applyProgressField(currentText, args.field, args.value)
        merged = applied.text
        scaffold = applied.scaffold
        updated = true
      } else if (file === 'PROGRESS.md' && args.kind === 'unit' && typeof args.unit === 'string') {
        // Keyed on the unit name, which is the identity the file itself carries, so the *next* parse
        // derives the same id and a repeated update merges instead of appending (see `unitEntryId`).
        const outcome = mergeEntry(parsed.units ?? [], {
          entry_id: unitEntryId(args.unit),
          unit: args.unit,
          topic: args.title ?? '',
          status: args.status ?? 'learning',
          understanding: args.value ?? 'unknown',
          notes: args.body ?? '',
        }, { overwrite: args.overwrite === true })
        created = outcome.created
        updated = outcome.updated
        merged = renderProgressUnits(parsed, outcome.entries)
      } else {
        // Name the combinations that actually work for *this* file. The old message told every
        // caller to "pass kind (mistake/deep-dive/unit)", which is nonsense for MISTAKES.md's
        // siblings and was the visible half of the schema/implementation mismatch above.
        const advice = file === 'PROGRESS.md'
          ? 'pass a field (current_unit/current_topic/last_studied/recommended_next_step/exam_mode) or kind "unit"'
          : file === 'MISTAKES.md'
            ? 'pass kind "mistake" or kind "deep-dive"'
            : `${file} is read-only here: read it with professor_state_read and edit it with the filesystem tools`
        problems.push(`unsupported update shape for ${file}: ${advice}`)
        return {
          course_id: course.course_id,
          file,
          evidence,
          writable: true,
          written: false,
          dryRun: args.dry_run === true,
          plan,
          revision: current?.version ?? null,
          compression: { removed: 0 },
          warnings,
          problems,
        }
      }

      // 4. Compress when over budget, reporting what it dropped.
      const compressed = compressState(
        file === 'PROGRESS.md' ? { progress: parseProgress(merged) } : { mistakes: parseMistakes(merged) },
        { now: () => Date.now() },
      )
      let text = merged
      let removed = compressed.removed
      if (lineCount(text) > DEFAULT_LINE_BUDGET) {
        text = file === 'PROGRESS.md'
          ? renderProgressUnits(compressed.data.progress, compressed.data.progress.units)
          : renderMistakes(parseMistakes(text), compressed.data.mistakes)
        if (removed === 0) removed = 1
      }

      if (args.dry_run === true) {
        return {
          course_id: course.course_id,
          file,
          evidence,
          writable: true,
          written: false,
          dryRun: true,
          plan,
          revision: current?.version ?? null,
          compression: { removed },
          warnings,
          problems,
        }
      }

      // 5. Guarded write against the observed version.
      try {
        const written = await gateway.writeFile({
          filePath: projectPaths(project.root).courseStateFile(course.course_id, file),
          cwd: project.root,
          content: text.endsWith('\n') ? text : `${text}\n`,
          session: exec?.agent?.session,
          signal,
          writePolicy: policies.write,
          expected: current === undefined || scaffold
            ? { kind: 'createIfAbsent' }
            : { kind: 'replaceIfVersion', version: current.version },
        })
        logger?.info(`state ${file} updated for ${course.course_id} (evidence: ${evidence})`)
        return {
          course_id: course.course_id,
          file,
          evidence,
          writable: true,
          written: true,
          dryRun: false,
          plan,
          revision: written.version ?? null,
          compression: { removed },
          warnings,
          problems,
          ...(created ? { created } : {}),
          ...(updated ? { updated } : {}),
        }
      } catch (error) {
        if (error?.code === 'FS_STALE_VERSION' || error?.code === 'PROFESSOR_STATE_STALE') {
          // Leave a trace so diagnostics can report the refusal; best-effort, never fatal.
          await recordConflict({
            gateway,
            projectRoot: project.root,
            writePolicy: policies.write,
            session: exec?.agent?.session,
            signal,
            entry: {
              at: new Date().toISOString(),
              course_id: course.course_id,
              file,
              expected_version: current?.version ?? null,
              observed_version: null,
              reason: error.message,
            },
          }).catch(() => {})
          return {
            course_id: course.course_id,
            file,
            evidence,
            writable: true,
            written: false,
            dryRun: false,
            plan,
            revision: current?.version ?? null,
            compression: { removed },
            warnings,
            problems: [`state changed concurrently: re-read and retry (${error.message})`],
            stale: true,
          }
        }
        throw error
      }
    },
  }
}

/** Field labels the PROGRESS template uses. */
const PROGRESS_FIELD_LABELS = {
  current_unit: 'Current Unit',
  current_topic: 'Current Topic',
  last_studied: 'Last Studied',
  recommended_next_step: 'Recommended Next Step',
  exam_mode: 'Exam Mode',
}

/**
 * Compute the next `PROGRESS.md` content with one field replaced.
 *
 * Operates on the raw text (the parser keeps structure, not the original), so every section the
 * parser does not model survives a single-field update. When the document is absent or the label
 * is missing, a minimal scaffold with the field is produced and the `scaffold` flag is set, so a
 * caller can distinguish "edited" from "created".
 *
 * @param rawText - current content, or null/empty when the file does not exist yet.
 * @param field - one of `PROGRESS_FIELD_LABELS`.
 * @param value - the new value.
 * @returns `{ text, replaced, scaffold }`.
 */
export function applyProgressField(rawText, field, value) {
  const label = PROGRESS_FIELD_LABELS[field]
  if (label === undefined) return { text: rawText ?? '', replaced: false, scaffold: false }
  const needle = `**${label}:**`
  const source = typeof rawText === 'string' && rawText.length > 0 ? rawText : null

  if (source === null) {
    return {
      text: [
        '# Course — Learning Progress', '',
        '## Current Position', '',
        `**${label}:** ${value}`, '',
      ].join('\n'),
      replaced: false,
      scaffold: true,
    }
  }

  const lines = source.split('\n')
  let replaced = false
  const out = lines.map((line) => {
    if (line.trimStart().startsWith(needle)) {
      replaced = true
      return `${line.slice(0, line.length - line.trimStart().length)}**${label}:** ${value}`
    }
    return line
  })
  if (!replaced) {
    const headingIndex = out.findIndex((line) => /^#{1,6}\s+.*Current Position/i.test(line))
    if (headingIndex >= 0) out.splice(headingIndex + 1, 0, `**${label}:** ${value}`, '')
    else out.push('', `**${label}:** ${value}`)
  }
  return { text: out.join('\n'), replaced, scaffold: false }
}

/** Convenience wrapper returning only the text (used by callers that only need the document). */
export function renderProgressField(rawText, field, value) {
  return applyProgressField(rawText, field, value).text
}

/** Render PROGRESS with the unit table rewritten (the parser does not keep raw lines). */
function renderProgressUnits(parsed, units) {
  const rows = units.map((unit) => `| ${unit.unit} | ${unit.topic} | ${unit.status} | ${unit.understanding} | ${unit.notes} |`)
  return [
    '# Course — Learning Progress', '',
    '## Current Position', '',
    `**Current Unit:** ${parsed.current_unit ?? 'Not started'}`, '',
    `**Current Topic:** ${parsed.current_topic ?? 'Not started'}`, '',
    `**Last Studied:** ${parsed.last_studied ?? 'N/A'}`, '',
    `**Recommended Next Step:** ${parsed.recommended_next_step ?? 'Start from the first available course unit.'}`, '',
    '## Unit Progress', '',
    '| Unit | Topic / Title | Status | Understanding | Notes |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

/** Render MISTAKES with merged active mistakes and deep dives. */
function renderMistakes(parsed, merged) {
  const lines = [
    '# Course — Mistakes & Weak Points', '',
    '## Course', '',
    '## Active Mistakes', '',
  ]
  if ((merged.active_mistakes ?? []).length === 0) lines.push('(No mistakes recorded yet)', '')
  for (const entry of merged.active_mistakes ?? []) {
    lines.push(`## ${entry.title}`, '', entry.body ?? '', '', `Occurrences: ${entry.occurrences ?? 1}`, '')
  }
  lines.push('---', '', '## Weak Topics', '', '| Topic | Weakness | Recommended Reinforcement |', '| --- | --- | --- |')
  for (const topic of merged.weak_topics ?? parsed.weak_topics ?? []) {
    lines.push(`| ${topic.topic} | ${topic.weakness} | ${topic.reinforcement ?? ''} |`)
  }
  lines.push('', '---', '', '## Requested Deep Dives', '',
    '| Date | Topic | Question (paraphrased) | Cause of difficulty | Suggested review action |',
    '|------|-------|------------------------|---------------------|-------------------------|')
  for (const dive of merged.deep_dives ?? []) {
    lines.push(`| ${dive.date ?? ''} | ${dive.topic ?? ''} | ${dive.question ?? ''} | ${dive.cause ?? ''} | ${dive.review_action ?? ''} |`)
  }
  return lines.join('\n')
}
