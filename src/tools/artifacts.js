/**
 * `professor_artifact_create` and `professor_artifact_status` — the artifact surface (M11).
 *
 * `artifact_create` is the single entry point for producing study notes and exam reviews. It owns
 * the *contract* rather than the prose: it decides the format through the format gate, resolves and
 * validates the destination, enforces the no-silent-overwrite policy, renders the deterministic
 * structure, attaches provenance, and reports exactly what it wrote. The model supplies content;
 * the tool supplies the guarantees.
 *
 * `artifact_status` is the read-only companion: it lists what exists under the configured roots and
 * reports health, so a caller can check destinations before asking for a write.
 *
 * @module dsh-professor-spike/src/tools/artifacts
 */

import path from 'node:path'

import { buildCitations, checkCitations } from '../provenance/attach.js'
import { PRACTICE_ORIGIN_LABELS, PRACTICE_ORIGINS } from '../provenance/source-ref.js'
import { renderContentTex, renderMainTex, renderMetadataTex, validateTexFragment } from '../artifacts/latex.js'
import { formatRequiredError, resolveArtifactFormat } from '../artifacts/format-gate.js'
import { renderNote } from '../artifacts/note.js'
import {
  ARTIFACT_KINDS, artifactDirectoryName, extensionFor, resolveArtifactRoot,
} from '../artifacts/paths.js'
import { hydrateReviewFromState, renderReview } from '../artifacts/review.js'
import { artifactFilenameFor, listArtifacts, writeArtifact } from '../artifacts/store.js'
import { assertUsableProject, loadProject } from '../project/project.js'
import { requireCourse } from '../courses/registry.js'
import { parseKnowledge, parseMistakes, parseProgress } from '../state/parse.js'
import { readStateFile, resolveCourseContext } from '../state/course-context.js'
import { copyTemplate, inspectTemplate } from '../latex/template.js'
import { jsonOutput, oneOfTypes } from './support.js'

export const ARTIFACT_CREATE_TOOL_NAME = 'professor_artifact_create'
export const ARTIFACT_STATUS_TOOL_NAME = 'professor_artifact_status'

const asArray = (value) => (Array.isArray(value) ? value : [])
const filled = (value) => typeof value === 'string' && value.trim().length > 0

/**
 * Accounting helper for the LaTeX branch: the Markdown renderers count a section as rendered only
 * when its `body` is filled, so a `body_tex`-only entry is shown with its raw body. The rendered
 * Markdown text is discarded for `format: "latex"` — this only keeps `sections_rendered` truthful.
 */
const rawAsBody = (entry) => (entry !== null && typeof entry === 'object'
  && !filled(entry.body) && filled(entry.body_tex)
  ? { ...entry, body: entry.body_tex }
  : entry)

/** Load the course's parsed learning state (all four files are optional). */
async function readCourseState({ gateway, projectRoot, courseId, signal }) {
  const progress = await readStateFile({ gateway, projectRoot, courseId, file: 'PROGRESS.md', signal })
  const mistakes = await readStateFile({ gateway, projectRoot, courseId, file: 'MISTAKES.md', signal })
  const knowledge = await readStateFile({ gateway, projectRoot, courseId, file: 'KNOWLEDGE.md', signal })
  return {
    present: progress !== undefined || mistakes !== undefined || knowledge !== undefined,
    progress: parseProgress(progress?.text ?? ''),
    mistakes: parseMistakes(mistakes?.text ?? ''),
    knowledge: parseKnowledge(knowledge?.text ?? ''),
  }
}

/** Attach the human-readable origin label to every practice item, refusing an unlabelled one. */
function labelPractice(items, problems) {
  const out = []
  for (const [index, entry] of asArray(items).entries()) {
    if (!filled(entry?.question)) {
      problems.push(`practice[${index}] has no question text`)
      continue
    }
    const origin = typeof entry.origin === 'string' ? entry.origin.trim().toLowerCase() : ''
    if (!PRACTICE_ORIGINS.includes(origin)) {
      problems.push(
        `practice[${index}] needs an origin of ${PRACTICE_ORIGINS.join(' | ')} `
        + '— a generated question must never be presented as professor material',
      )
      continue
    }
    out.push({ ...entry, origin, origin_label: PRACTICE_ORIGIN_LABELS[origin] })
  }
  return out
}

/** The common shape of every artifact tool result. */
function artifactOutputSchema(extra = {}) {
  return {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      // Null in the "format choice required" result: nothing was chosen and nothing was written,
      // so there is no format, destination or root to report. The host validates the returned
      // value against this schema, so a plain `string` here would fail at runtime.
      format: oneOfTypes('string', 'null'),
      format_source: { type: 'string' },
      format_required: { type: 'boolean' },
      question: oneOfTypes('string', 'null'),
      options: { type: 'array' },
      created: { type: 'boolean' },
      course_id: { type: 'string' },
      projectRoot: { type: 'string' },
      root: oneOfTypes('string', 'null'),
      root_source: oneOfTypes('string', 'null'),
      directory: oneOfTypes('string', 'null'),
      files: { type: 'array' },
      filename: oneOfTypes('string', 'null'),
      main_file: oneOfTypes('string', 'null'),
      artifact_version: oneOfTypes('string', 'number', 'null'),
      suggested: { type: 'object' },
      template: { type: 'object' },
      citations: { type: 'object' },
      sections_rendered: { type: 'array' },
      sections_omitted: { type: 'array' },
      timings: { type: 'object' },
      warnings: { type: 'array' },
      problems: { type: 'array' },
      ...extra,
    },
    required: [
      'kind', 'format', 'format_source', 'format_required', 'question', 'options', 'created',
      'course_id', 'projectRoot', 'root', 'root_source', 'directory', 'files', 'filename',
      'main_file', 'artifact_version', 'suggested', 'template', 'citations', 'sections_rendered',
      'sections_omitted', 'timings', 'warnings', 'problems',
    ],
  }
}

/**
 * Define `professor_artifact_create`.
 *
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`; course-owned tools
 *   receive a wrapper that throws `PROFESSOR_PROJECT_MISSING` for an unbound workspace.
 * @param options.gateway - filesystem gateway.
 * @param options.policiesFor - `(projectRoot, outputRoots) => { read, write }`.
 * @param options.outputRootsFor - `(document) => string[]`.
 * @param options.logger - plugin logger.
 * @param options.now - injectable clock (tests).
 * @returns the tool definition.
 */
export function defineArtifactCreateTool(options) {
  const {
    resolveProject, gateway, policiesFor, outputRootsFor, logger,
    now = () => new Date().toISOString(),
  } = options

  return {
    name: ARTIFACT_CREATE_TOOL_NAME,
    description:
      'Create a Markdown or LaTeX study note, or a separate exam-review artifact, inside the configured output root. '
      + 'The note format must be requested explicitly for every artifact, even when a saved preference exists — '
      + 'otherwise a structured "format choice required" result is returned and nothing is written. Never silently '
      + 'overwrites (default policy "never": it suggests the next -vN name instead), attaches validated provenance, '
      + 'labels every practice question with its origin, and never writes into course material or .professor/state. '
      + 'Input is text: section bodies and terminology cells are escaped on render, so LaTeX markup passed here '
      + 'prints literally instead of typesetting. For format "latex" a body may instead be supplied as raw LaTeX '
      + 'with `body_tex` (sections/examples/derivations), which is validated as a fragment and inserted verbatim — '
      + 'that is the one-pass route for real formulas, tables, semantic boxes and diagrams. Use the structured '
      + 'fields for what they support (terminology becomes a real two-column table in LaTeX).',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['note', 'review'], description: 'What to produce: an ordinary study note, or a distinct exam-review artifact.' },
        title: { type: 'string', description: 'Artifact title (also the file name).' },
        course: { type: 'string', description: 'Course id or code; defaults to this session\'s binding.' },
        format: { type: 'string', enum: ['markdown', 'latex'], description: 'Explicit format request for this artifact. When omitted, ask the user every time.' },
        topic: { type: 'string', description: 'Topic, recorded in the header.' },
        scope: { type: 'string', description: 'Which material this artifact covers (source scope).' },
        summary: { type: 'string', description: 'Short overview paragraph.' },
        sections: { type: 'array', description: '[{ heading, body, body_tex? }] structured explanation, rendered in the order given. body is plain text and is escaped on render: raw LaTeX in it prints literally, so it cannot typeset a table, math or an environment. With format "latex" only, body_tex replaces body for that entry and is inserted as raw LaTeX (validated as a fragment first) — the one-pass route for formulas, tables, semantic boxes and diagrams.' },
        terminology: { type: 'array', description: '[{ term, definition }] important terminology. In LaTeX this is the only field rendered as a real table (two columns); a wider data table belongs in a section body as `body_tex` (latex) or in the generated output copy afterwards.' },
        examples: { type: 'array', description: '[{ title, body, body_tex? }] worked examples; body_tex is the raw-LaTeX route for format "latex", same rules as sections.' },
        mistakes: { type: 'array', description: 'Common mistakes (strings).' },
        warnings: { type: 'array', description: 'Warnings / cautions (strings).' },
        self_check: { type: 'array', description: 'Self-check questions (strings).' },
        supplementary: { type: 'array', description: 'Model-authored extra explanation, rendered in a clearly separated section that never claims to be professor material.' },
        deep_dives: { type: 'array', description: '[{ topic, question, cause, review_action }] deep-dive callouts.' },
        practice: { type: 'array', description: '[{ question, origin, answer }] practice items. origin must be original/adapted/generated and is rendered as 原题/改编题/新编练习.' },
        source_chunks: { type: 'array', description: 'Chunks this artifact drew on (file_id/relative_path/page/slide/section/chunk_id) — rendered as the validated citation block.' },
        practice_origins: { type: 'object', description: 'Map chunk_id -> practice origin, for citing an exercise rather than a lecture.' },
        from_state: { type: 'boolean', description: 'Review only: hydrate weak points, recurring mistakes, deep dives and the unresolved list from the course learning state (default true).' },
        confirmed_scope: { type: 'array', description: 'Review: confirmed exam scope.' },
        unconfirmed_scope: { type: 'array', description: 'Review: scope that is NOT confirmed.' },
        important_topics: { type: 'array', description: 'Review: important/difficult topics.' },
        high_frequency: { type: 'array', description: 'Review: high-frequency foundations.' },
        weak_points: { type: 'array', description: 'Review: weak points.' },
        definitions: { type: 'array', description: 'Review: essential definitions.' },
        formulas: { type: 'array', description: 'Review: essential formulas (LaTeX math, unescaped).' },
        derivations: { type: 'array', description: 'Review: [{ title, body, body_tex? }] representative derivations or code patterns; body_tex is the raw-LaTeX route for format "latex", same rules as sections.' },
        recurring_mistakes: { type: 'array', description: 'Review: recurring mistakes.' },
        unresolved: { type: 'array', description: 'Review: unresolved checklist items.' },
        filename: { type: 'string', description: 'Markdown only: override the file name (extension is added).' },
        overwrite: { type: 'object', description: '{ policy?: "never"|"versioned"|"allow", expected_version?, use_suggested? } — defaults to project.yaml notes.overwrite_policy.' },
      },
      required: ['kind', 'title'],
    },
    output: jsonOutput(artifactOutputSchema()),

    async execute(args = {}, exec) {
      const started = performance.now()
      const timing = () => ({ create_ms: Math.round(performance.now() - started) })
      const project = await resolveProject(exec)
      const signal = exec?.signal
      const warnings = []
      const problems = []

      const kind = String(args.kind ?? '').trim()
      if (!Object.hasOwn(ARTIFACT_KINDS, kind)) {
        const error = new Error(`kind must be "note" or "review", found ${JSON.stringify(args.kind)}`)
        error.code = 'PROFESSOR_ARTIFACT_KIND_INVALID'
        throw error
      }
      const title = String(args.title ?? '').trim()
      if (title.length === 0) {
        const error = new Error('title must be a non-empty string')
        error.code = 'PROFESSOR_ARTIFACT_INVALID'
        throw error
      }

      const { document, course } = await resolveCourseContext({
        gateway, projectRoot: project.root, signal, exec, courseId: args.course,
      })
      const policies = policiesFor(project.root, outputRootsFor(document))

      // 1. Format gate. A `required` decision is a *result*, not a failure: nothing is written and
      // the caller is told exactly what to ask the user.
      const decision = resolveArtifactFormat({
        requested: args.format,
        projectDefault: document?.notes?.default_format,
        kind,
      })
      if (decision.status === 'required') {
        return {
          kind,
          format: null,
          format_source: decision.source,
          format_required: true,
          question: decision.question,
          options: decision.options,
          created: false,
          course_id: course.course_id,
          projectRoot: project.root,
          root: null,
          root_source: null,
          directory: null,
          files: [],
          filename: null,
          main_file: null,
          artifact_version: null,
          suggested: {},
          template: {},
          citations: {},
          sections_rendered: [],
          sections_omitted: [],
          timings: timing(),
          warnings,
          problems: [formatRequiredError(decision).message],
        }
      }
      const { format } = decision

      // 1b. The explicit LaTeX content route. `body_tex` is a *LaTeX* input: with any other format
      //     it is refused outright (never silently escaped or ignored), and for format "latex" each
      //     value must be a usable fragment — validated here, before the destination is even
      //     resolved, so a refused fragment cannot half-create a project.
      const texBodies = [
        ...asArray(args.sections).map((entry, index) => [`sections[${index}].body_tex`, entry]),
        ...asArray(args.examples).map((entry, index) => [`examples[${index}].body_tex`, entry]),
        ...asArray(args.derivations).map((entry, index) => [`derivations[${index}].body_tex`, entry]),
      ].filter(([, entry]) => filled(entry?.body_tex))
      if (texBodies.length > 0 && format !== 'latex') {
        const error = new Error(
          'body_tex is a LaTeX input; pass format: "latex" for this artifact '
          + `(found format: "${format}" — there it would be silently meaningless)`,
        )
        error.code = 'PROFESSOR_ARTIFACT_TEX_FORMAT'
        throw error
      }
      for (const [label, entry] of texBodies) {
        const check = validateTexFragment(entry.body_tex)
        if (!check.ok) {
          const error = new Error(`${label} is not a usable LaTeX fragment: ${check.problems.join('; ')}`)
          error.code = 'PROFESSOR_ARTIFACT_TEX_INVALID'
          throw error
        }
      }

      // 2. Destination. Throws PROFESSOR_ARTIFACT_ROOT_UNSAFE when the configuration would put
      // notes into course material or into the plugin's own state directory.
      const root = resolveArtifactRoot({ document, projectRoot: project.root, kind, course })

      // 3. Provenance.
      const citations = buildCitations({
        chunks: asArray(args.source_chunks),
        practiceOrigins: typeof args.practice_origins === 'object' && args.practice_origins !== null
          ? args.practice_origins
          : {},
      })
      const citationCheck = checkCitations(citations)
      if (!citationCheck.ok) problems.push(...citationCheck.errors)

      // 4. Content assembly.
      const practice = labelPractice(args.practice, problems)
      if (asArray(args.practice).length > 0 && practice.length === 0) {
        const error = new Error(`every practice item needs an origin (${PRACTICE_ORIGINS.join(' | ')})`)
        error.code = 'PROFESSOR_PROVENANCE_INVALID'
        throw error
      }

      let stateHydration = null
      if (kind === 'review' && args.from_state !== false) {
        stateHydration = await readCourseState({
          gateway, projectRoot: project.root, courseId: course.course_id, signal,
        })
        if (!stateHydration.present) warnings.push('no learning state found for this course; the review was built from the arguments alone')
      }
      const hydrated = stateHydration === null ? {} : hydrateReviewFromState(stateHydration)

      const merged = {
        ...hydrated,
        ...Object.fromEntries(Object.entries({
          weak_points: args.weak_points,
          important_topics: args.important_topics,
          deep_dives: asArray(args.deep_dives).map((dive) => (filled(dive?.topic)
            ? `**${dive.topic}**${filled(dive.question) ? ` — ${dive.question}` : ''}`
            : null)).filter(Boolean),
          unresolved: args.unresolved,
        }).filter(([, value]) => Array.isArray(value) && value.length > 0)),
      }

      const input = {
        kind,
        title,
        topic: args.topic,
        scope: args.scope,
        summary: args.summary,
        sections: asArray(args.sections),
        terminology: asArray(args.terminology),
        examples: asArray(args.examples),
        mistakes: asArray(args.mistakes),
        warnings: asArray(args.warnings),
        self_check: asArray(args.self_check),
        supplementary: asArray(args.supplementary),
        // Two shapes on purpose. `deep_dives` is the **string** list the review renderer and the
        // LaTeX fragment consume (state-derived dives plus the titles of caller-supplied ones);
        // `deep_dives_objects` is the structured form the Markdown note renderer turns into
        // blockquote callouts. Collapsing them into one field is what made a review print
        // `[object Object]`.
        deep_dives: merged.deep_dives,
        deep_dives_objects: asArray(args.deep_dives),
        practice,
        course,
        confirmed_scope: asArray(args.confirmed_scope),
        unconfirmed_scope: asArray(args.unconfirmed_scope),
        high_frequency: asArray(args.high_frequency),
        // A caller-supplied definition list wins; otherwise the concepts already recorded in the
        // course's KNOWLEDGE.md are used, so a review is grounded in what was actually learned.
        definitions: asArray(args.definitions).length > 0
          ? asArray(args.definitions)
          : asArray(merged.essential_definitions),
        formulas: asArray(args.formulas),
        derivations: asArray(args.derivations),
        recurring_mistakes: asArray(args.recurring_mistakes).length > 0
          ? asArray(args.recurring_mistakes)
          : merged.recurring_mistakes,
        weak_points: merged.weak_points,
        important_topics: merged.important_topics,
        unresolved: merged.unresolved,
        generated_at: typeof args.generated_at === 'string' ? args.generated_at : now(),
        generator: 'dsh-professor-spike',
      }

      const directory = artifactDirectoryName({ courseId: course.course_id, title })
      const policy = typeof args.overwrite?.policy === 'string'
        ? args.overwrite.policy
        : (document?.notes?.overwrite_policy ?? 'never')

      // 5. Render. The Markdown renderers own the sections_rendered/sections_omitted accounting,
      //    and in the LaTeX branch they never write their text — so a raw `body_tex` body is shown
      //    to them as the body of that entry: what was actually rendered into content.tex.
      const accounting = format === 'latex'
        ? {
          ...input,
          sections: asArray(input.sections).map(rawAsBody),
          examples: asArray(input.examples).map(rawAsBody),
          derivations: asArray(input.derivations).map(rawAsBody),
        }
        : input
      const rendered = kind === 'review'
        ? renderReview(accounting, citations)
        : renderNote({ ...accounting, deep_dives: input.deep_dives_objects }, citations)

      const base = {
        kind,
        format,
        format_source: decision.source,
        format_required: false,
        question: null,
        options: [],
        course_id: course.course_id,
        projectRoot: project.root,
        root: root.root,
        root_source: root.source,
        directory,
        filename: null,
        // Measured wall time of THIS tool's creation path (resolution, validation, rendering,
        // writing) — explicitly not model-generation time, which the tool cannot observe.
        timings: timing(),
        citations: {
          refs: citations.refs.length,
          conflicts: citations.conflicts.length,
          hasExternal: citations.hasExternal,
          hasInference: citations.hasInference,
        },
        sections_rendered: rendered.sections_rendered,
        sections_omitted: rendered.sections_omitted,
        warnings,
        problems,
      }

      if (format === 'markdown') {
        const filename = filled(args.filename)
          ? `${String(args.filename).trim().replace(/\.md$/i, '')}.md`
          : (args.overwrite?.use_suggested === true && filled(args.overwrite?.suggested_filename)
            ? String(args.overwrite.suggested_filename)
            : artifactFilenameFor(title, 'markdown'))
        const outcome = await writeArtifact({
          gateway,
          projectRoot: project.root,
          root: root.root,
          directory,
          filename,
          content: rendered.content,
          overwritePolicy: policy,
          expectedVersion: typeof args.overwrite?.expected_version === 'string' ? args.overwrite.expected_version : undefined,
          writePolicy: policies.write,
          session: exec?.agent?.session,
          signal,
        })
        if (outcome.written === true) logger?.info(`artifact created: ${outcome.canonicalPath}`)
        return {
          ...base,
          created: outcome.written === true,
          timings: timing(),
          files: outcome.written === true
            ? [{ relative: `${directory}/${outcome.filename}`, bytes: Buffer.byteLength(rendered.content, 'utf8') }]
            : [],
          filename: outcome.written === true ? outcome.filename : null,
          main_file: null,
          artifact_version: outcome.version ?? null,
          suggested: outcome.suggested ?? {},
          template: {},
          warnings: [...warnings, ...(outcome.versioned === true ? [`${outcome.requestedFilename} existed; wrote ${outcome.filename} instead`] : [])],
          problems: [...problems, ...(outcome.problems ?? [])],
        }
      }

      // --- LaTeX: a small project, never the shared template -------------------------------
      if (policy === 'allow') {
        const error = new Error(
          'overwrite policy "allow" is not supported for LaTeX projects (a project is several files); '
          + 'use the default "never", which suggests a versioned directory, or set notes.overwrite_policy: versioned',
        )
        error.code = 'PROFESSOR_ARTIFACT_POLICY_INVALID'
        throw error
      }

      const templatePath = course?.notes?.latex_template ?? document?.notes?.latex_template ?? null
      const inspection = await inspectTemplate({
        gateway, projectRoot: project.root, templatePath, signal,
      })
      const template = {
        configured: filled(templatePath),
        path: filled(templatePath) ? String(templatePath).trim() : null,
        usable: inspection.ok === true,
        bundled_default: inspection.ok !== true || inspection.mainCandidates.length === 0,
        source: inspection.ok === true && inspection.mainCandidates.length > 0 ? 'custom' : 'bundled',
        tex_files: inspection.texFiles,
        skipped: inspection.skipped,
        problems: filled(templatePath) ? inspection.problems : [],
      }
      if (!filled(templatePath)) {
        warnings.push('no LaTeX template is configured; the bundled reference-derived default main.tex was selected')
      }
      for (const problem of template.problems) warnings.push(problem)
      if (filled(templatePath) && template.bundled_default) {
        warnings.push('configured custom template is unusable; the bundled reference-derived default main.tex was selected')
      }

      // A project occupies a directory: the same policy applies at the directory level.
      let targetDirectory = directory
      const directoryTarget = await gateway.resolveTarget(path.join(root.root, targetDirectory), { cwd: project.root, signal })
      const existingDirectory = await gateway.stat(directoryTarget, signal)
      if (existingDirectory !== undefined) {
        if (policy === 'never') {
          let version = 2
          for (; version < 200; version += 1) {
            const candidate = `${directory}-v${version}`
            const candidateTarget = await gateway.resolveTarget(path.join(root.root, candidate), { cwd: project.root, signal })
            if ((await gateway.stat(candidateTarget, signal)) === undefined) break
          }
          return {
            ...base,
            created: false,
            timings: timing(),
            files: [],
            main_file: null,
            artifact_version: null,
            suggested: { directory: `${directory}-v${version}`, version },
            template,
            problems: [
              ...problems,
              `${directory} already exists and the configured overwrite policy is "never": nothing was written. `
              + `Re-run with overwrite: { policy: "versioned" } or overwrite: { suggested_directory: "${directory}-v${version}" }.`,
            ],
          }
        }
        let version = 2
        for (; version < 200; version += 1) {
          const candidate = `${directory}-v${version}`
          const candidateTarget = await gateway.resolveTarget(path.join(root.root, candidate), { cwd: project.root, signal })
          if ((await gateway.stat(candidateTarget, signal)) === undefined) break
        }
        targetDirectory = `${directory}-v${version}`
      }

      policies.write.add(root.root)
      const destinationDir = path.join(root.root, targetDirectory)
      const files = []

      if (inspection.ok === true) {
        const copied = await copyTemplate({
          gateway,
          projectRoot: project.root,
          inspection,
          destinationDir,
          writePolicy: policies.write,
          session: exec?.agent?.session,
          signal,
        })
        for (const entry of copied.copied) files.push({ relative: `${targetDirectory}/${entry.relative}`, bytes: entry.bytes })
        for (const problem of copied.problems) warnings.push(problem)
      }

      const generated = [
        ['professor-metadata.tex', renderMetadataTex({ ...input, format: 'latex' })],
        ['content.tex', renderContentTex(input, citations)],
      ]
      const templateMain = inspection.ok === true ? inspection.mainCandidates[0] : undefined
      const mainFile = templateMain ?? 'main.tex'
      if (templateMain === undefined) generated.push(['main.tex', renderMainTex()])

      for (const [name, content] of generated) {
        try {
          const written = await gateway.writeFile({
            filePath: path.join(destinationDir, name),
            cwd: project.root,
            content,
            session: exec?.agent?.session,
            signal,
            writePolicy: policies.write,
            expected: { kind: 'createIfAbsent' },
          })
          files.push({ relative: `${targetDirectory}/${name}`, bytes: Buffer.byteLength(content, 'utf8'), canonicalPath: written.canonicalPath })
        } catch (error) {
          if (error?.code === 'FS_NOT_OBSERVED') {
            warnings.push(`${name} already exists in ${targetDirectory}; left untouched`)
            continue
          }
          throw error
        }
      }

      if (templateMain !== undefined && templateMain !== 'main.tex') {
        warnings.push(`the template's main file is ${templateMain}; make sure it \\input{content} — content.tex holds the generated notes`)
      }

      logger?.info(`latex artifact created: ${targetDirectory} (${files.length} files)`)

      return {
        ...base,
        directory: targetDirectory,
        created: true,
        timings: timing(),
        files,
        main_file: mainFile,
        artifact_version: null,
        suggested: {},
        template: {
          ...template,
          copied: inspection.ok === true ? inspection.files.length : 0,
          main_file: mainFile,
        },
        warnings: [...warnings],
        problems,
      }
    },
  }
}

/**
 * Define `professor_artifact_status`.
 *
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`; course-owned tools
 *   receive a wrapper that throws `PROFESSOR_PROJECT_MISSING` for an unbound workspace.
 * @param options.gateway - filesystem gateway.
 * @returns the tool definition.
 */
export function defineArtifactStatusTool(options) {
  const { resolveProject, gateway } = options

  return {
    name: ARTIFACT_STATUS_TOOL_NAME,
    description:
      'Report where artifacts are written and what already exists: the resolved output root for notes and for reviews, whether each is configured or the project default, whether it exists, how many artifacts it holds and the most recent ones. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['note', 'review'], description: 'Limit the report to one artifact kind.' },
        course: { type: 'string', description: 'Limit the listing to one course id (directory prefix).' },
        limit: { type: 'number', description: 'Maximum files per root (default 50).' },
      },
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        projectRoot: { type: 'string' },
        projectPresent: { type: 'boolean' },
        roots: { type: 'array' },
        warnings: { type: 'array' },
      },
      required: ['projectRoot', 'projectPresent', 'roots', 'warnings'],
    }),

    async execute(args = {}, exec) {
      const project = await resolveProject(exec)
      const signal = exec?.signal
      const warnings = []
      const loaded = await loadProject({ gateway, projectRoot: project.root, signal })
      if (!loaded.present) {
        return {
          projectRoot: project.root,
          projectPresent: false,
          roots: [],
          warnings: ['no .professor/project.yaml yet: run professor_project_init first'],
        }
      }
      const document = assertUsableProject(loaded)

      const kinds = typeof args.kind === 'string' && Object.hasOwn(ARTIFACT_KINDS, args.kind)
        ? [args.kind]
        : ['note', 'review']
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 50
      const selectedCourse = typeof args.course === 'string' && args.course.trim().length > 0
        ? requireCourse(document, args.course.trim()) : undefined
      const roots = []
      for (const kind of kinds) {
        const outputKey = kind === 'note' ? 'notes_root' : 'reviews_root'
        const courses = selectedCourse ? [selectedCourse] : [undefined, ...document.courses.filter(course => course.outputs?.[outputKey])]
        for (const rootCourse of courses) {
        const courseFilter = rootCourse?.course_id ?? null
        let resolved
        try {
          resolved = resolveArtifactRoot({ document, projectRoot: project.root, kind, course: rootCourse })
        } catch (error) {
          roots.push({
            kind,
            root: null,
            root_source: null,
            configured: false,
            present: false,
            file_count: 0,
            files: [],
            problems: [error.message],
          })
          continue
        }
        const listing = await listArtifacts({
          gateway, projectRoot: project.root, root: resolved.root, signal, limit,
        })
        const files = courseFilter === null
          ? listing.files
          : listing.files.filter((file) => file.relativePath.startsWith(`${courseFilter}/`))
        if (resolved.insideSource !== null) {
          warnings.push(`${kind}: output root ${resolved.root} is an artifact subdirectory inside the course root ${resolved.insideSource}`)
        }
        roots.push({
          kind,
          root: resolved.root,
          root_source: resolved.source,
          configured: resolved.configured,
          insideSource: resolved.insideSource,
          present: listing.present,
          file_count: files.length,
          files: files.slice(0, limit).map((file) => file.relativePath),
          problems: listing.problems,
        })
        }
      }

      return { projectRoot: project.root, projectPresent: true, roots, warnings }
    },
  }
}

/** Exported for diagnostics: the configured artifact roots of a validated document. */
export function artifactRootsOf(document, projectRoot) {
  const out = {}
  for (const kind of Object.keys(ARTIFACT_KINDS)) {
    try {
      out[kind] = resolveArtifactRoot({ document, projectRoot, kind })
    } catch (error) {
      out[kind] = { root: null, source: null, configured: false, problems: [error.message] }
    }
  }
  return out
}

/** Exported for diagnostics and tests: artifact file extension per format. */
export function artifactExtension(format) {
  return extensionFor(format)
}
