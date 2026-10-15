/**
 * `professor_latex_compile` — compile a generated LaTeX artifact through the shell seam (M11).
 *
 * The tool exists so a compile is never claimed without evidence. It probes the host compiler at
 * call time, runs the static pre-checks and a bounded body/dependency preflight, and compiles only
 * through the Harness `ctx.shell` boundary. A machine without TeX, a machine without a shell seam,
 * a static-check/preflight failure, an *environment* blocker (sandbox/permission denial, missing
 * package) and a real *document* compile failure are five different, clearly reported outcomes —
 * `failure_class` says which one it is, so a repair loop is never aimed at the wrong target — and
 * a produced PDF is never described as visually correct unless the caller says it inspected it.
 *
 * @module dsh-professor-spike/src/tools/latex
 */

import path from 'node:path'

import { artifactDirectoryName, resolveArtifactRoot } from '../artifacts/paths.js'
import { compileLatex } from '../latex/compile.js'
import { detectRequirement, probeLatex as defaultProbeLatex, probeLatexRequirement, REQUIREMENT_ANY, summarizeLatex } from '../latex/capabilities.js'
import { resolveCourseContext } from '../state/course-context.js'
import { jsonOutput, oneOfTypes } from './support.js'

export const LATEX_COMPILE_TOOL_NAME = 'professor_latex_compile'

/**
 * Define the tool.
 *
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`; course-owned tools
 *   receive a wrapper that throws `PROFESSOR_PROJECT_MISSING` for an unbound workspace.
 * @param options.gateway - filesystem gateway.
 * @param options.probeLatex - `() => probe` (defaults to the real host probe).
 * @param options.probeFor - `(requirement) => probe`; defaults to the generic probe for `any` and to
 *   `probeLatexRequirement` for `unicode-cjk`, so the generated wrapper gets XeLaTeX (or an accurate
 *   report of its absence) while a user-provided `main.tex` keeps the command it always had.
 * @param options.runner - a runner from `createShellRunner`, or undefined.
 * @param options.policiesFor / options.outputRootsFor - optional, for the read policy that bounds
 *   the preflight's walk (production passes both; unit tests may omit them).
 * @param options.logger - plugin logger.
 * @returns the tool definition.
 */
export function defineLatexCompileTool(options) {
  const {
    resolveProject, gateway, runner, logger, policiesFor, outputRootsFor,
    probeLatex = () => defaultProbeLatex(),
    probeFor = requirement => (requirement === REQUIREMENT_ANY ? probeLatex() : probeLatexRequirement(requirement)),
  } = options

  const compileCache = new Map()

  return {
    name: LATEX_COMPILE_TOOL_NAME,
    description:
      'Compile a generated LaTeX artifact project and report an honest verdict: source_generated (not attempted), '
      + 'compiler_unavailable, compilation_failed, or compilation_succeeded. A produced PDF is reported separately, and '
      + 'is only described as visually inspected when you state that you inspected it. Compilation runs through the shell '
      + 'seam with explicit flags (no shell escape, stop on error); the shared template is never modified. '
      + 'A bounded preflight checks the generated body and its declared inputs before anything runs. '
      + 'failure_class separates environment blockers (sandbox/permission denial, missing compiler or TeX '
      + 'package — do NOT repair the document for those) from document errors; timings cover only this '
      + 'tool\'s own preflight/compile stages, never model generation time.',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Artifact directory, relative to the resolved artifact root (as returned by professor_artifact_create).' },
        path: { type: 'string', description: 'Absolute artifact directory; must be inside the resolved artifact root.' },
        course: { type: 'string', description: 'Course id, used when only a title-based directory is given.' },
        kind: { type: 'string', enum: ['note', 'review'], description: 'Which artifact root to resolve (default note).' },
        title: { type: 'string', description: 'Artifact title; the directory is derived from it when neither directory nor path is given.' },
        main_file: { type: 'string', description: 'Main .tex file (default: main.tex, else the single .tex in the directory).' },
        timeout_ms: { type: 'number', description: 'Compile deadline in milliseconds (default 120000).' },
        allow_shell_escape: { type: 'boolean', description: 'Opt in to shell escape for this compile (default false; never enabled implicitly).' },
        visually_inspected: { type: 'boolean', description: 'State that you inspected the produced PDF pages; only then is the PDF reported as inspected.' },
        inspected_pages: { type: 'number', description: 'How many pages you inspected.' },
      },
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        verdict: { type: 'string' },
        attempted: { type: 'boolean' },
        blocked_by: oneOfTypes('string', 'null'),
        engine: oneOfTypes('string', 'null'),
        compiler: { type: 'object' },
        command: oneOfTypes('string', 'null'),
        exit_code: oneOfTypes('number', 'null'),
        timed_out: { type: 'boolean' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        pdf: { type: 'object' },
        static: { type: 'object' },
        preflight: { type: 'object' },
        timings: { type: 'object' },
        diagnostics: { type: 'object' },
        failure_class: oneOfTypes('string', 'null'),
        sandbox: oneOfTypes('object', 'null'),
        reused_prior_compile: { type: 'boolean' },
        projectRoot: { type: 'string' },
        directory: oneOfTypes('string', 'null'),
        main_file: oneOfTypes('string', 'null'),
        summary: { type: 'string' },
        warnings: { type: 'array' },
        problems: { type: 'array' },
      },
      required: [
        'verdict', 'attempted', 'blocked_by', 'engine', 'compiler', 'command', 'exit_code',
        'timed_out', 'stdout', 'stderr', 'pdf', 'static', 'preflight', 'timings', 'diagnostics',
        'failure_class', 'projectRoot', 'directory', 'main_file', 'summary', 'warnings', 'problems',
      ],
    }),

    async execute(args = {}, exec) {
      const project = await resolveProject(exec)
      const signal = exec?.signal
      const warnings = []
      const problems = []

      const kind = typeof args.kind === 'string' && (args.kind === 'note' || args.kind === 'review') ? args.kind : 'note'
      const { document, course } = await resolveCourseContext({
        gateway, projectRoot: project.root, signal, exec, courseId: args.course,
      })
      const root = resolveArtifactRoot({ document, projectRoot: project.root, kind, course })

      // The preflight walks declared inputs inside the artifact directory; when policies are wired,
      // that walk is additionally asserted against the plugin's read roots (the resolved artifact
      // root is explicitly readable — we were asked to compile it).
      let readPolicy
      if (typeof policiesFor === 'function') {
        const policies = policiesFor(project.root, typeof outputRootsFor === 'function' ? outputRootsFor(document) : [])
        policies.read.add(root.root)
        readPolicy = policies.read
      }

      // Destination resolution. A free-form absolute directory is accepted only inside the resolved
      // artifact root; the process working directory is never a fallback.
      let directory = null
      if (typeof args.path === 'string' && args.path.trim().length > 0) {
        const candidate = path.resolve(args.path.trim())
        const relative = path.relative(root.root, candidate)
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          const error = new Error(`path ${candidate} is outside the resolved ${kind} artifact root (${root.root})`)
          error.code = 'PROFESSOR_LATEX_PATH_OUTSIDE_ROOT'
          throw error
        }
        directory = candidate
      } else if (typeof args.directory === 'string' && args.directory.trim().length > 0) {
        const relative = args.directory.trim()
        if (relative.split(/[\\/]+/).includes('..')) {
          const error = new Error(`directory contains a ".." segment: ${relative}`)
          error.code = 'PROFESSOR_PATH_DENIED'
          throw error
        }
        directory = path.join(root.root, relative)
      } else if (typeof args.title === 'string' && args.title.trim().length > 0) {
        directory = path.join(root.root, artifactDirectoryName({ courseId: course.course_id, title: args.title.trim() }))
      } else {
        const error = new Error('pass "directory" (relative), "path" (absolute, inside the root), or "title" to locate the LaTeX project')
        error.code = 'PROFESSOR_LATEX_DIRECTORY_REQUIRED'
        throw error
      }

      const probe = probeLatex()
      let compiler = summarizeLatex(probe)

      // Locate the main file: explicit, then main.tex, then the single .tex present.
      const target = await gateway.resolveTarget(directory, { cwd: project.root, signal })
      const info = await gateway.stat(target, signal)
      if (info === undefined || info.type !== 'directory') {
        return {
          verdict: 'source_generated',
          attempted: false,
          blocked_by: 'missing-project',
          failure_class: 'document',
          engine: compiler.engine,
          compiler,
          command: null,
          exit_code: null,
          timed_out: false,
          stdout: '',
          stderr: '',
          pdf: { produced: false, path: null, bytes: null, inspected: false, inspected_by: null },
          static: { ok: null, problems: [], warnings: [] },
          preflight: { ok: null, files: [], problems: [], warnings: [], notes: [], duration_ms: null },
          timings: { preflight_ms: null, compile_ms: null },
          diagnostics: { errors: [], pages: null },
          projectRoot: project.root,
          directory,
          main_file: null,
          summary: `no LaTeX project directory at ${directory}; nothing was compiled`,
          warnings,
          problems: [`directory not found: ${directory}`],
        }
      }

      let mainFile = typeof args.main_file === 'string' && args.main_file.trim().length > 0
        ? args.main_file.trim()
        : null
      if (mainFile === null) {
        const entries = await gateway.listDir(target, signal)
        const texFiles = entries.filter((entry) => entry.type === 'file' && entry.name.endsWith('.tex')).map((entry) => entry.name)
        if (texFiles.includes('main.tex')) mainFile = 'main.tex'
        else if (texFiles.length === 1) mainFile = texFiles[0]
        else if (texFiles.length > 1) {
          warnings.push(`several .tex files found (${texFiles.join(', ')}); pass main_file explicitly`)
          mainFile = 'main.tex'
        } else {
          mainFile = 'main.tex'
        }
      }
      if (mainFile.includes('/') || mainFile.includes('\\') || mainFile.includes('..')) {
        warnings.push(`main_file "${mainFile}" is not a plain file name; it was used as given`)
      }

      // Classify the document before choosing a compiler. Only the plugin's own generated wrapper
      // declares `dsh-professor-requirement: unicode-cjk`; a user-provided main.tex declares
      // nothing and therefore keeps the probe — and the command — it always had. A failure to read
      // the file here is not swallowed: compileLatex reads it again and reports its own verdict.
      let requirement = REQUIREMENT_ANY
      try {
        const mainTarget = await gateway.resolveTarget(path.join(directory, mainFile), { cwd: project.root, signal })
        requirement = detectRequirement(await gateway.readText(mainTarget, signal))
      } catch {
        requirement = REQUIREMENT_ANY
      }
      const resolvedProbe = probeFor(requirement)
      compiler = {
        ...summarizeLatex(resolvedProbe),
        requirement,
        flavor: resolvedProbe.flavor ?? null,
        cjk_fonts: resolvedProbe.fonts ?? null,
      }

      const report = await compileLatex({
        compileCache,
        gateway,
        projectRoot: project.root,
        directory,
        mainFile,
        probe: resolvedProbe,
        requirement,
        runner,
        timeoutMs: Number.isInteger(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : undefined,
        allowShellEscape: args.allow_shell_escape === true,
        ...(readPolicy === undefined ? {} : { readPolicy }),
        visualInspection: typeof args.visually_inspected === 'boolean'
          ? { inspected: args.visually_inspected, pages: args.inspected_pages }
          : undefined,
        signal,
        exec,
      })

      logger?.info(`latex compile: ${report.verdict}${report.failure_class === null ? '' : ` (${report.failure_class})`} (${mainFile})`)

      return {
        verdict: report.verdict,
        attempted: report.attempted,
        blocked_by: report.blocked_by ?? null,
        failure_class: report.failure_class ?? null,
        sandbox: report.sandbox ?? null,
        reused_prior_compile: report.reused_prior_compile === true,
        engine: report.engine ?? null,
        compiler,
        command: report.command ?? null,
        exit_code: report.exitCode ?? null,
        timed_out: report.timedOut === true,
        stdout: report.stdout ?? '',
        stderr: report.stderr ?? '',
        pdf: report.pdf,
        static: report.static,
        preflight: report.preflight,
        timings: report.timings,
        diagnostics: report.diagnostics,
        projectRoot: project.root,
        directory,
        main_file: mainFile,
        summary: report.summary,
        warnings: [...warnings, ...(report.warnings ?? [])],
        problems: [...problems, ...(report.problems ?? [])],
      }
    },
  }
}
