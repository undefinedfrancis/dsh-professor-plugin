/**
 * M11 LaTeX tests: project generation from a template (or from scratch), the read-only template
 * contract, the directory-level overwrite policy, and — most importantly — the compile verdicts.
 *
 * The verdict table is the whole point of the compile tool, so every verdict gets a test that
 * pins the *distinction*: "no engine on this machine" is not "the compile failed", and "a PDF was
 * produced" is not "the PDF looks right". A machine running these tests has no TeX installed, and
 * that must never turn into a claimed success.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { createFsGateway } from '../src/fs/gateway.js'
import { resolveProjectRoot } from '../src/paths/roots.js'
import { commandForEngine, detectRequirement, probeLatex, probeLatexRequirement, summarizeLatex } from '../src/latex/capabilities.js'
import { compileLatex, staticCheck } from '../src/latex/compile.js'
import { inspectTemplate, MAX_TEMPLATE_FILES } from '../src/latex/template.js'
import { renderContentTex, renderMainTex } from '../src/artifacts/latex.js'
import { defineLatexCompileTool, LATEX_COMPILE_TOOL_NAME } from '../src/tools/latex.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

const AVAILABLE = { available: true, engine: 'pdflatex', path: '/usr/bin/pdflatex', searched: [], note: 'test probe' }
const UNAVAILABLE = { available: false, engine: null, path: null, searched: [], note: 'no TeX engine found on this machine' }

function projectDocument({ material, latexTemplate = null, notesRoot = null }) {
  return `schema_version: 1
project:
  id: term-2026
  name: 'Fall 2026'
courses:
  - course_id: csc3200
    course_code: CSC3200
    term: '2025-2026 Fall'
    display_name: Data Structures
    status: active
    sources:
      - path: ${material}
outputs:
  notes_root: ${notesRoot === null ? 'null' : notesRoot}
  reviews_root: null
indexing:
  exclude: []
  follow_symlinks: false
retrieval:
  max_sources: 4
  max_chunks: 8
  prefer_local_course_sources: true
notes:
  default_format: latex
  overwrite_policy: never
  latex_template: ${latexTemplate === null ? 'null' : latexTemplate}
web:
  enabled: true
  policy: conditional
`
}

async function fixture(options = {}) {
  const home = await makeHome('professor-latex-')
  const project = path.join(home, 'term')
  const material = path.join(project, 'CSC3200')
  await writeFixture(home, 'term/CSC3200/01_Lectures/lecture-01.md', 'lecture material')
  const latexTemplate = options.latexTemplate === undefined || options.latexTemplate === null
    ? null
    : path.join(home, options.latexTemplate)
  await writeFixture(home, 'term/.professor/project.yaml', projectDocument({
    material,
    latexTemplate,
    notesRoot: options.notesRoot === undefined ? null : path.join(project, options.notesRoot),
  }))

  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })
  await tools.professor_session_bind.execute({ course: 'csc3200' }, exec)
  return { home, project, material, latexTemplate, fake, tools, exec }
}

const latexNote = (overrides = {}) => ({
  kind: 'note',
  title: 'Recursion',
  format: 'latex',
  topic: '递归',
  sections: [{ heading: '递归结构', body: 'base case 与 recursive step。下划线 _ 与 & 需要转义。' }],
  ...overrides,
})

// --- project generation -----------------------------------------------------

test('a LaTeX note with no template is generated as a self-contained project', async () => {
  const f = await fixture()
  const result = await f.tools.professor_artifact_create.execute(latexNote(), f.exec)

  assert.equal(result.created, true)
  assert.equal(result.format, 'latex')
  assert.equal(result.directory, 'csc3200/recursion')
  assert.equal(result.main_file, 'main.tex')
  assert.ok(result.warnings.some((warning) => /no LaTeX template is configured.*bundled/.test(warning)))
  assert.equal(result.template.bundled_default, true)
  assert.equal(result.template.source, 'bundled')
  assert.deepEqual(result.template.problems, [])

  const dir = path.join(f.project, '.professor', 'notes', 'csc3200', 'recursion')
  const names = (await fs.readdir(dir)).sort()
  assert.deepEqual(names, ['content.tex', 'main.tex', 'professor-metadata.tex'])

  const main = await fs.readFile(path.join(dir, 'main.tex'), 'utf8')
  assert.match(main, /\\documentclass/)
  assert.match(main, /\\input\{professor-metadata\}/)
  assert.match(main, /\\input\{content\}/)

  const metadata = await fs.readFile(path.join(dir, 'professor-metadata.tex'), 'utf8')
  assert.match(metadata, /\\newcommand\{\\ProfessorCourseCode\}\{CSC3200\}/)

  const content = await fs.readFile(path.join(dir, 'content.tex'), 'utf8')
  assert.doesNotMatch(content, /\\documentclass/, 'the body is a fragment, not a second document')
  assert.match(content, /\\section\*\{递归结构\}/)
  // Everything the model supplied is escaped, so a stray `_`/`&` cannot become TeX syntax.
  assert.match(content, /\\_/)
  assert.match(content, /\\&/)
})

test('a configured template is copied, never modified, and its rc files are skipped', async () => {
  const f = await fixture({ latexTemplate: 'templates/master' })
  await writeFixture(f.home, 'templates/master/main.tex', '\\documentclass{book}\n\\input{content}\n')
  await writeFixture(f.home, 'templates/master/style.cls', '% class\n')
  await writeFixture(f.home, 'templates/master/latexmkrc', '$pdflatex = "pdflatex -shell-escape";\n')
  const templateMainBefore = await fs.readFile(path.join(f.latexTemplate, 'main.tex'), 'utf8')

  const result = await f.tools.professor_artifact_create.execute(latexNote({ title: 'From Template' }), f.exec)
  assert.equal(result.created, true)
  assert.equal(result.template.usable, true)
  assert.equal(result.template.bundled_default, false)
  assert.equal(result.template.source, 'custom')
  assert.equal(result.template.path, f.latexTemplate)
  assert.equal(result.template.main_file, 'main.tex')

  const dir = path.join(f.project, '.professor', 'notes', 'csc3200', 'from-template')
  const names = (await fs.readdir(dir)).sort()
  assert.deepEqual(names, ['content.tex', 'main.tex', 'professor-metadata.tex', 'style.cls'])
  assert.equal(names.includes('latexmkrc'), false, 'a per-directory rc must never be copied')

  assert.equal(await fs.readFile(path.join(dir, 'main.tex'), 'utf8'), templateMainBefore,
    'the template main file is copied verbatim')
  assert.equal(await fs.readFile(path.join(f.latexTemplate, 'main.tex'), 'utf8'), templateMainBefore,
    'the shared template is never modified')
  assert.deepEqual((await fs.readdir(f.latexTemplate)).sort(), ['latexmkrc', 'main.tex', 'style.cls'],
    'the template directory keeps exactly its own files — nothing is written into it')
  assert.equal(await fs.readFile(path.join(f.latexTemplate, 'latexmkrc'), 'utf8'), '$pdflatex = "pdflatex -shell-escape";\n')
})

test('an unreadable or non-absolute template degrades to a generated project, with the reason', async () => {
  const broken = await fixture({ latexTemplate: 'templates/missing' })
  const result = await broken.tools.professor_artifact_create.execute(latexNote({ title: 'Missing Template' }), broken.exec)
  assert.equal(result.created, true)
  assert.equal(result.template.usable, false)
  assert.equal(result.template.bundled_default, true)
  assert.equal(result.template.source, 'bundled')
  assert.ok(result.template.problems.some((problem) => /does not exist/.test(problem)))
  assert.ok(result.warnings.some((warning) => /does not exist/.test(warning)))
  assert.deepEqual((await fs.readdir(path.join(broken.project, '.professor', 'notes', 'csc3200', 'missing-template'))).sort(),
    ['content.tex', 'main.tex', 'professor-metadata.tex'])

  const relative = await fixture({ latexTemplate: null })
  const inspection = await inspectTemplate({
    gateway: createFsGateway({ ctx: relative.fake.ctx }), projectRoot: relative.project, templatePath: 'templates/master',
  })
  assert.equal(inspection.ok, false)
  assert.ok(inspection.problems.some((problem) => /not an absolute path/.test(problem)))
})

test('the template walk is bounded so a huge tree degrades into a report', async () => {
  const f = await fixture()
  const gateway = createFsGateway({ ctx: f.fake.ctx })
  // A template with more files than the bound: the walk stops and says so.
  const total = MAX_TEMPLATE_FILES + 5
  for (let index = 0; index < total; index += 1) {
    await writeFixture(f.home, `templates/big/file-${String(index).padStart(3, '0')}.tex`, '% x\n')
  }
  const inspection = await inspectTemplate({
    gateway, projectRoot: f.project, templatePath: path.join(f.home, 'templates/big'),
  })
  assert.ok(inspection.files.length <= MAX_TEMPLATE_FILES)
  assert.ok(inspection.skipped.some((entry) => /exceeds/.test(entry.reason)))
})

test('a LaTeX project is a directory, so its overwrite policy is applied at the directory level', async () => {
  const f = await fixture()
  const first = await f.tools.professor_artifact_create.execute(latexNote(), f.exec)
  assert.equal(first.created, true)
  const before = await fs.readFile(path.join(f.project, '.professor', 'notes', 'csc3200', 'recursion', 'content.tex'), 'utf8')

  const refused = await f.tools.professor_artifact_create.execute(latexNote({ topic: '第二版' }), f.exec)
  assert.equal(refused.created, false)
  assert.deepEqual(refused.files, [])
  assert.equal(refused.suggested.directory, 'csc3200/recursion-v2')
  assert.ok(refused.problems.some((problem) => /already exists/.test(problem)))
  assert.equal(await fs.readFile(path.join(f.project, '.professor', 'notes', 'csc3200', 'recursion', 'content.tex'), 'utf8'), before)

  const versioned = await f.tools.professor_artifact_create.execute(latexNote({
    topic: '第二版', overwrite: { policy: 'versioned' },
  }), f.exec)
  assert.equal(versioned.created, true)
  assert.equal(versioned.directory, 'csc3200/recursion-v2')
  assert.equal(await fs.readFile(path.join(f.project, '.professor', 'notes', 'csc3200', 'recursion', 'content.tex'), 'utf8'), before)

  await assert.rejects(
    () => f.tools.professor_artifact_create.execute(latexNote({ overwrite: { policy: 'allow' } }), f.exec),
    (error) => error.code === 'PROFESSOR_ARTIFACT_POLICY_INVALID',
    '"allow" cannot be honoured for a multi-file project and is refused rather than half-applied',
  )
})

// --- capability probing -----------------------------------------------------

test('the host probe reports what it actually found, and never assumes a compiler', () => {
  const existsOn = (candidate) => candidate === '/Library/TeX/texbin/latexmk'
  const found = probeLatex({ env: { PATH: '' }, pathDirs: [], exists: existsOn, isFile: () => true })
  assert.equal(found.available, true)
  assert.equal(found.engine, 'latexmk')
  assert.equal(found.path, '/Library/TeX/texbin/latexmk')

  const override = probeLatex({
    env: { PATH: '', DSH_PROFESSOR_LATEX: '/opt/tex/bin' },
    pathDirs: [],
    exists: (candidate) => candidate === '/opt/tex/bin/pdflatex',
    isFile: () => true,
  })
  assert.equal(override.engine, 'pdflatex')
  assert.equal(override.note, 'from DSH_PROFESSOR_LATEX')

  const absent = probeLatex({ env: { PATH: '' }, pathDirs: [], exists: () => false, isFile: () => true })
  assert.equal(absent.available, false)
  assert.equal(absent.engine, null)
  assert.match(absent.note, /DSH_PROFESSOR_LATEX/, 'the note tells the user how to fix it')

  assert.deepEqual(summarizeLatex(absent), { available: false, engine: null, path: null, note: absent.note })
  assert.equal(probeLatex().available, probeLatex().available, 'probing is read-only and repeatable')
})

test('compiler flags are explicit: no shell escape unless the caller opted in', () => {
  assert.deepEqual(commandForEngine({ engine: 'latexmk', mainFile: 'main.tex' }), {
    command: 'latexmk',
    args: ['-pdf', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'],
  })
  assert.equal(commandForEngine({ engine: 'pdflatex', mainFile: 'main.tex' }).args.includes('-shell-escape'), false)
  assert.equal(commandForEngine({ engine: 'pdflatex', mainFile: 'main.tex', allowShellEscape: true }).args.includes('-shell-escape'), true)
})

test('the static pre-checks refuse shell escape and unbalanced environments', () => {
  assert.equal(staticCheck('\\documentclass{article}\n\\begin{document}x\\end{document}\n').ok, true)

  const noClass = staticCheck('\\begin{document}x\\end{document}')
  assert.equal(noClass.ok, false)
  assert.ok(noClass.problems.some((problem) => /no \\documentclass/.test(problem)))

  const unbalanced = staticCheck('\\documentclass{article}\n\\begin{document}\\begin{itemize}x\\end{document}')
  assert.equal(unbalanced.ok, false)
  assert.ok(unbalanced.problems.some((problem) => /unbalanced environments|never closed/.test(problem)))

  const escape = staticCheck('\\documentclass{article}\n\\write18{rm -rf /}\n\\begin{document}x\\end{document}')
  assert.equal(escape.ok, false)
  assert.ok(escape.problems.some((problem) => /shell escape/.test(problem)))

  const nested = staticCheck('\\documentclass{article}\n\\begin{document}\\input{|"cat /etc/passwd"}\\end{document}')
  assert.equal(nested.ok, false)

  const minted = staticCheck('\\documentclass{article}\n\\usepackage{minted}\n\\begin{document}x\\end{document}')
  assert.equal(minted.ok, true, 'minted is a warning, not a hard failure')
  assert.ok(minted.warnings.some((warning) => /minted requires shell escape/.test(warning)))

  assert.equal(staticCheck('').ok, false, 'an empty source is refused')
})

// --- compile verdicts -------------------------------------------------------

/**
 * Build the compile tool with an injected probe and runner, plus the plugin's real gateway.
 *
 * `runner: null` means "no shell seam at all" (the tool must then report *not attempted*); any
 * other function is recorded in `calls` before it runs, so a test can assert both what reached the
 * seam and what the seam returned.
 */
function compileTool(f, options = {}) {
  const calls = []
  const runner = options.runner === null
    ? undefined
    : async (spec) => {
      calls.push(spec)
      if (typeof options.runner === 'function') return options.runner(spec)
      return { runnerFailed: false, exitCode: 0, signal: null, timedOut: false, timeoutMs: spec.timeoutMs ?? null, stdout: 'ok', stderr: '' }
    }
  const tool = defineLatexCompileTool({
    resolveProject: (exec) => resolveProjectRoot(exec),
    gateway: createFsGateway({ ctx: f.fake.ctx }),
    runner,
    probeLatex: () => options.probe ?? AVAILABLE,
    // Tests inject a probe and expect it to be honoured for every requirement; production leaves
    // this unset so the tool classifies the document and probes for what it actually needs.
    probeFor: options.probeFor ?? (() => options.probe ?? AVAILABLE),
  })
  return { tool, calls }
}

async function compiledFixture(options = {}) {
  const f = await fixture(options)
  await f.tools.professor_artifact_create.execute(latexNote(), f.exec)
  return f
}

const NOTE_DIR = ['csc3200', 'recursion']

test('a compile of a missing project reports source_generated rather than inventing a failure', async () => {
  const f = await compiledFixture()
  const { tool, calls } = compileTool(f)
  const report = await tool.execute({ directory: 'csc3200/nowhere' }, f.exec)

  assert.equal(report.verdict, 'source_generated')
  assert.equal(report.attempted, false)
  assert.equal(report.blocked_by, 'missing-project')
  assert.equal(calls.length, 0, 'no process was started for a missing project')
  assert.equal(report.pdf.produced, false)
})

test('a machine with no TeX engine reports compiler_unavailable, not a failure', async () => {
  const f = await compiledFixture()
  const { tool, calls } = compileTool(f, { probe: UNAVAILABLE })
  const report = await tool.execute({ directory: path.join(...NOTE_DIR) }, f.exec)

  assert.equal(report.verdict, 'compiler_unavailable')
  assert.equal(report.attempted, false)
  assert.equal(report.blocked_by, 'no-compiler')
  assert.equal(report.static.ok, true, 'the source still passed the static checks')
  assert.equal(calls.length, 0)
  assert.match(report.summary, /no TeX engine was found/)
  assert.ok(report.warnings.some((warning) => /no TeX engine found/.test(warning)))
})

test('a source that requests shell escape is blocked before any compiler runs', async () => {
  const f = await compiledFixture()
  await fs.writeFile(
    path.join(f.project, '.professor', 'notes', ...NOTE_DIR, 'main.tex'),
    '\\documentclass{article}\n\\write18{echo pwned}\n\\begin{document}x\\end{document}\n',
    'utf8',
  )
  const { tool, calls } = compileTool(f)
  const report = await tool.execute({ directory: path.join(...NOTE_DIR) }, f.exec)

  assert.equal(report.verdict, 'source_generated')
  assert.equal(report.attempted, false)
  assert.equal(report.blocked_by, 'static-check')
  assert.equal(calls.length, 0, 'a shell-escape source is never handed to a runner')
  assert.ok(report.problems.some((problem) => /shell escape/.test(problem)))
})

test('without a shell seam the compile is reported as not attempted, never as a success', async () => {
  const f = await compiledFixture()
  const { tool, calls } = compileTool(f, { runner: null })
  const report = await tool.execute({ directory: path.join(...NOTE_DIR) }, f.exec)

  assert.equal(report.verdict, 'source_generated')
  assert.equal(report.attempted, false)
  assert.equal(report.blocked_by, 'no-runner')
  assert.equal(calls.length, 0)
  assert.match(report.summary, /no shell runner is wired/)
})

test('a successful compile produces a PDF and says plainly that it was not inspected', async () => {
  const f = await compiledFixture()
  const { tool, calls } = compileTool(f, {
    runner: async (spec) => {
      // Simulate a compiler that succeeded: exit 0 and a real file on disk.
      await fs.writeFile(path.join(spec.workdir, 'main.pdf'), '%PDF-1.4 fake\n', 'utf8')
      return { runnerFailed: false, exitCode: 0, signal: null, timedOut: false, timeoutMs: spec.timeoutMs, stdout: 'Output written on main.pdf', stderr: '' }
    },
  })
  const report = await tool.execute({ directory: path.join(...NOTE_DIR) }, f.exec)

  assert.equal(report.verdict, 'compilation_succeeded')
  assert.equal(report.attempted, true)
  assert.equal(report.exit_code, 0)
  assert.equal(report.pdf.produced, true)
  assert.equal(report.pdf.bytes > 0, true)
  assert.equal(report.pdf.inspected, false, 'a produced PDF is not a visually verified one')
  assert.equal(report.pdf.inspected_by, null)
  assert.match(report.summary, /NOT visually inspected/)
  assert.match(report.stdout, /Output written/)

  // The command goes through the seam with explicit, reproducible flags.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].workdir, path.join(f.project, '.professor', 'notes', ...NOTE_DIR))
  assert.equal(calls[0].onExpiry, 'kill')
  assert.match(calls[0].command, /-interaction=nonstopmode -halt-on-error main\.tex$/)
  assert.equal(calls[0].command.includes('-shell-escape'), false)

  // Only a caller attestation turns "produced" into "inspected".
  const inspected = await tool.execute({ directory: path.join(...NOTE_DIR), visually_inspected: true, inspected_pages: 3 }, f.exec)
  assert.equal(inspected.pdf.inspected, true)
  assert.equal(inspected.pdf.inspected_by, 'caller-attestation')
  assert.equal(inspected.pdf.inspected_pages, 3)
  assert.match(inspected.summary, /was visually inspected by the caller/)
})

test('a compiler that exits non-zero or produces no PDF is reported as failed', async () => {
  const f = await compiledFixture()
  const failing = compileTool(f, {
    runner: async () => ({ runnerFailed: false, exitCode: 1, signal: null, timedOut: false, timeoutMs: 1000, stdout: '', stderr: '! Undefined control sequence.' }),
  })
  const failed = await failing.tool.execute({ directory: path.join(...NOTE_DIR) }, f.exec)
  assert.equal(failed.verdict, 'compilation_failed')
  assert.equal(failed.attempted, true)
  assert.equal(failed.exit_code, 1)
  assert.ok(failed.problems.some((problem) => /exited with code 1/.test(problem)))
  assert.ok(failed.problems.some((problem) => /no main\.pdf was produced/.test(problem)))
  assert.match(failed.stderr, /Undefined control sequence/)

  // Exit 0 but no PDF is still a failure: the exit code is not the evidence.
  const silent = compileTool(f, {
    runner: async () => ({ runnerFailed: false, exitCode: 0, signal: null, timedOut: false, timeoutMs: 1000, stdout: '', stderr: '' }),
  })
  const noPdf = await silent.tool.execute({ directory: path.join(...NOTE_DIR) }, f.exec)
  assert.equal(noPdf.verdict, 'compilation_failed')
  assert.equal(noPdf.pdf.produced, false)

  // A timeout is a failure with its own explanation.
  const timedOut = compileTool(f, {
    runner: async () => ({ runnerFailed: false, exitCode: null, signal: 'SIGKILL', timedOut: true, timeoutMs: 500, stdout: '', stderr: '' }),
  })
  const expiry = await timedOut.tool.execute({ directory: path.join(...NOTE_DIR), timeout_ms: 500 }, f.exec)
  assert.equal(expiry.verdict, 'compilation_failed')
  assert.equal(expiry.timed_out, true)
  assert.ok(expiry.problems.some((problem) => /exceeded its 500 ms deadline/.test(problem)))
})

test('a shell-seam deviation is reported instead of being treated as a compile result', async () => {
  const f = await compiledFixture()
  const { tool } = compileTool(f, {
    runner: async () => ({ runnerFailed: true, reason: 'the shell seam rejected the request: denied' }),
  })
  const report = await tool.execute({ directory: path.join(...NOTE_DIR) }, f.exec)
  assert.equal(report.verdict, 'compilation_failed')
  assert.equal(report.attempted, true)
  assert.ok(report.problems.some((problem) => /shell seam rejected/.test(problem)))
})

test('the compile refuses a path outside the artifact root and a traversing directory', async () => {
  const f = await compiledFixture()
  const { tool, calls } = compileTool(f)

  await assert.rejects(
    () => tool.execute({ path: path.join(f.project, '.professor') }, f.exec),
    (error) => error.code === 'PROFESSOR_LATEX_PATH_OUTSIDE_ROOT',
  )
  await assert.rejects(
    () => tool.execute({ directory: 'csc3200/../../escape' }, f.exec),
    (error) => error.code === 'PROFESSOR_PATH_DENIED',
  )
  await assert.rejects(
    () => tool.execute({}, f.exec),
    (error) => error.code === 'PROFESSOR_LATEX_DIRECTORY_REQUIRED',
  )
  assert.equal(calls.length, 0, 'a refused destination never reaches the compiler')
})

test('the main file is located deterministically: main.tex, then a single .tex, else explicit', async () => {
  const f = await compiledFixture()
  const { tool } = compileTool(f)

  // A generated project always has main.tex, so it is chosen without a hint.
  const byDefault = await tool.execute({ directory: path.join(...NOTE_DIR) }, f.exec)
  assert.equal(byDefault.main_file, 'main.tex')

  // A hand-made project with exactly one .tex file: that file is compiled.
  const single = path.join(f.project, '.professor', 'notes', 'csc3200', 'handmade')
  await fs.mkdir(single, { recursive: true })
  await fs.writeFile(path.join(single, 'paper.tex'), '\\documentclass{article}\n\\begin{document}x\\end{document}\n', 'utf8')
  const inferred = await tool.execute({ directory: 'csc3200/handmade' }, f.exec)
  assert.equal(inferred.main_file, 'paper.tex')

  // Several .tex files and no main.tex: the tool says it cannot choose rather than picking one.
  await fs.writeFile(path.join(single, 'second.tex'), '\\documentclass{article}\n\\begin{document}y\\end{document}\n', 'utf8')
  const ambiguous = await tool.execute({ directory: 'csc3200/handmade' }, f.exec)
  assert.ok(ambiguous.warnings.some((warning) => /several \.tex files found/.test(warning)))
  assert.equal(ambiguous.main_file, 'main.tex', 'a missing default is reported, not silently substituted')

  const explicit = await tool.execute({ directory: 'csc3200/handmade', main_file: 'second.tex' }, f.exec)
  assert.equal(explicit.main_file, 'second.tex')

  // A generated project keeps its own content.tex/professor-metadata.tex from being mistaken for
  // the main file: main.tex always wins.
  const regenerated = await tool.execute({ directory: path.join(...NOTE_DIR) }, f.exec)
  assert.equal(regenerated.main_file, 'main.tex')
})

test('compileLatex is callable without a tool definition and keeps the same verdicts', async () => {
  const f = await compiledFixture()
  const gateway = createFsGateway({ ctx: f.fake.ctx })
  const report = await compileLatex({
    gateway,
    projectRoot: f.project,
    directory: path.join(f.project, '.professor', 'notes', ...NOTE_DIR),
    mainFile: 'main.tex',
    probe: UNAVAILABLE,
  })
  assert.equal(report.verdict, 'compiler_unavailable')
  assert.equal(report.attempted, false)
  assert.equal(report.pdf.produced, false)
})

test('the compile tool is registered and refuses to run without a conversation workspace', async () => {
  const f = await fixture()
  const tool = f.tools[LATEX_COMPILE_TOOL_NAME]
  assert.equal(typeof tool.execute, 'function')
  await assert.rejects(
    () => tool.execute({ directory: 'x' }, {}),
    /no conversation workspace/,
  )
})

// --- default wrapper vs compiler selection: the Unicode/CJK contract ----------

test('the generated default wrapper carries a CJK-capable preamble and declares its requirement', () => {
  const main = renderMainTex()
  assert.equal(detectRequirement(main), 'unicode-cjk', 'the generated wrapper must be classified')
  assert.match(main, /dsh-professor-requirement:\s*unicode-cjk/, 'the requirement is machine-readable in the file itself')
  assert.match(main, /\\usepackage\{xeCJK\}/, 'CJK text needs xeCJK')
  assert.match(main, /\\usepackage\{fontspec\}/, 'fontspec supplies the Unicode font machinery')
  assert.match(main, /FandolSong-Regular/, 'a font that ships with the TeX distribution')
  assert.doesNotMatch(main, /Songti|PingFang|STSong|Hiragino|Heiti|Microsoft YaHei/,
    'no operating-system-specific font name may be hard-coded')
  assert.doesNotMatch(main, /\\usepackage\[utf8\]\{inputenc\}/,
    'inputenc cannot encode CJK and must not ship with this wrapper')
  assert.match(main, /\\RequireXeTeX/, 'a wrong engine must say so instead of dying on a Unicode character')
  assert.match(main, /\\documentclass\[11pt\]\{article\}/, 'the document class is unchanged')
})

test('the Chinese headings the plugin generates are what force the requirement', () => {
  const content = renderContentTex({
    summary: 'An English-only summary.', scope: 'Lecture 03',
    sections: [{ heading: 'English heading', body: 'English body.' }],
    terminology: [{ term: 'stable', definition: 'equal keys keep their relative order' }],
    mistakes: [], self_check: [], practice: [],
  })
  assert.match(content, /概述/, 'the heading is generated even though every supplied field is English')
  assert.match(content, /材料范围/)
  assert.match(content, /重要术语/, 'the terminology table heading is generated too')
})

test('a user-provided main.tex is never reclassified as requiring XeLaTeX', () => {
  const userTemplate = '\\documentclass[11pt]{article}\n\\usepackage[utf8]{inputenc}\n\\begin{document}\nx\n\\end{document}\n'
  assert.equal(detectRequirement(userTemplate), 'any')
  assert.equal(detectRequirement(renderMainTex()), 'unicode-cjk')
  assert.equal(detectRequirement(''), 'any', 'an unreadable or empty source is never escalated')
})

test('compiler command selection: XeLaTeX for the generated default, -pdf for a user template', () => {
  assert.deepEqual(
    commandForEngine({ engine: 'latexmk', flavor: 'xelatex', mainFile: 'main.tex' }),
    { command: 'latexmk', args: ['-xelatex', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'] },
  )
  assert.deepEqual(
    commandForEngine({ engine: 'latexmk', mainFile: 'main.tex' }),
    { command: 'latexmk', args: ['-pdf', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'] },
    'the user-template path keeps its previous command exactly',
  )
  assert.equal(commandForEngine({ engine: 'xelatex', flavor: 'xelatex', mainFile: 'main.tex' }).command, 'xelatex')
  assert.equal(
    commandForEngine({ engine: 'pdflatex', mainFile: 'main.tex', allowShellEscape: true }).args.includes('-shell-escape'),
    true,
    'the shell-escape opt-in is untouched',
  )
})

test('the requirement probe refuses to hand a CJK document to pdfTeX', () => {
  const base = { env: { PATH: '' }, pathDirs: ['/tex'] }
  const engines = candidate => ['/tex/latexmk', '/tex/xelatex'].includes(candidate)

  const both = probeLatexRequirement('unicode-cjk', { ...base, exists: engines, isFile: () => true, fontExists: () => true })
  assert.equal(both.available, true)
  assert.equal(both.engine, 'latexmk')
  assert.equal(both.flavor, 'xelatex')

  const bareLatexmk = probeLatexRequirement('unicode-cjk', { ...base, exists: candidate => candidate === '/tex/latexmk', isFile: () => true, fontExists: () => true })
  assert.equal(bareLatexmk.available, false, 'latexmk alone cannot compile this document')
  assert.equal(bareLatexmk.engine, null, 'it must not silently fall back to pdfTeX')
  assert.match(bareLatexmk.note, /XeLaTeX/)

  const noFont = probeLatexRequirement('unicode-cjk', { ...base, exists: engines, isFile: () => true, fontExists: () => false })
  assert.equal(noFont.available, false, 'a missing CJK font is a reported capability gap')
  assert.match(noFont.note, /font/i)

  const generic = probeLatexRequirement('any', { ...base, exists: candidate => candidate === '/tex/latexmk', isFile: () => true, fontExists: () => false })
  assert.equal(generic.available, true, 'the generic probe is unchanged by the requirement')
  assert.equal(generic.flavor ?? null, null)
})

test('the compile tool drives a generated default project with XeLaTeX', async () => {
  const f = await fixture()
  await f.tools.professor_artifact_create.execute(latexNote(), f.exec)
  const { tool, calls } = compileTool(f, {
    probe: AVAILABLE,
    probeFor: () => ({
      available: true, engine: 'latexmk', path: '/Library/TeX/texbin/latexmk', flavor: 'xelatex',
      searched: ['/Library/TeX/texbin/xelatex'], note: 'found latexmk driving XeLaTeX',
    }),
  })
  const report = await tool.execute({ directory: NOTE_DIR.join('/') }, f.exec)
  assert.equal(calls.length, 1, 'exactly one command reached the shell seam')
  assert.match(String(calls[0].command), /-xelatex/, 'the generated default is driven by XeLaTeX')
  assert.equal(report.engine, 'latexmk')
  assert.match(String(report.command), /-xelatex/)
  assert.ok(report.warnings.some(warning => /XeLaTeX|xelatex/i.test(warning)),
    'the report says which capability it relied on')
})

test('an unsatisfiable requirement is compiler_unavailable, never a pdfTeX fallback or compilation_failed', async () => {
  const f = await fixture()
  await f.tools.professor_artifact_create.execute(latexNote(), f.exec)
  const { tool, calls } = compileTool(f, {
    probe: AVAILABLE,
    probeFor: () => ({
      available: false, engine: null, path: null, flavor: null, searched: ['/tex/xelatex'],
      note: 'this generated document requires XeLaTeX (unicode-cjk), which was not found',
    }),
  })
  const report = await tool.execute({ directory: NOTE_DIR.join('/') }, f.exec)
  assert.equal(calls.length, 0, 'nothing is executed when the required capability is missing')
  assert.equal(report.verdict, 'compiler_unavailable')
  assert.equal(report.attempted, false)
  assert.equal(report.command, null)
  assert.ok(report.warnings.some(warning => /XeLaTeX/.test(warning)), 'the absence is named accurately')
})


test('the default wrapper loads the bundled reference-derived layout without personal metadata', async () => {
  const bundled = await fs.readFile(new URL('../resources/latex/default/main.tex', import.meta.url), 'utf8')
  assert.equal(renderMainTex(), bundled)
  assert.match(bundled, /\\newcommand\{\\ruleskip\}/)
  assert.match(bundled, /\\huge/)
  assert.match(bundled, /\\usepackage\{tcolorbox\}/)
  assert.match(bundled, /\\usepackage\{tikz\}/)
  assert.doesNotMatch(bundled, /Francis|CSC3001|Lecture 2/)
  const reference = await fs.readFile(new URL('../resources/latex/reference/CSC3001note2.tex', import.meta.url), 'utf8')
  assert.match(reference, /\\coursetitle\}\{CSC3001 Review Notes\}/)
})
