/**
 * Bounded preflight and failure diagnostics for `professor_latex_compile`.
 *
 * The historical behaviour checked only the *driver*: a broken or escaped `content.tex` body, a
 * missing generated input, or a permission denial all surfaced as the same generic
 * `compilation_failed` with `blocked_by: null`, so the model kept repairing the document even when
 * the blocker was the sandbox (docs/qa/2026-10-15-latex-flow-audit/REPORT.md, finding 3).
 *
 * What these tests pin:
 *   1. the generated body and its declared dependencies are checked BEFORE any process runs;
 *   2. comments and verbatim/code content never trip those checks (no false positives);
 *   3. traversal stays bounded and inside the artifact directory (authorized read roots);
 *   4. sandbox/permission denials are reported as ENVIRONMENT blockers, separate from document
 *      errors, with the compiler evidence preserved;
 *   5. a required package such as `cancel` is named explicitly instead of leaving an undefined
 *      command behind.
 *
 * Scope statement: this is a bounded structural preflight (environments, declared inputs, escaped
 * markup, package usage). It never claims to validate TeX syntax — the compiler remains the
 * authority for that.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { createFsGateway } from '../src/fs/gateway.js'
import { resolveProjectRoot } from '../src/paths/roots.js'
import { defineLatexCompileTool } from '../src/tools/latex.js'
import { preflightProject } from '../src/latex/preflight.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

const AVAILABLE = { available: true, engine: 'pdflatex', path: '/usr/bin/pdflatex', searched: [], note: 'test probe' }

function projectDocument({ material }) {
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
  notes_root: null
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
  latex_template: null
web:
  enabled: true
  policy: conditional
`
}

async function fixture() {
  const home = await makeHome('professor-preflight-')
  const project = path.join(home, 'term')
  const material = path.join(project, 'CSC3200')
  await writeFixture(home, 'term/CSC3200/01_Lectures/lecture-01.md', 'lecture material')
  await writeFixture(home, 'term/.professor/project.yaml', projectDocument({ material }))

  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })
  await tools.professor_session_bind.execute({ course: 'csc3200' }, exec)
  const created = await tools.professor_artifact_create.execute({
    kind: 'note', title: 'Recursion', format: 'latex',
    sections: [{ heading: '递归结构', body: 'base case。' }],
  }, exec)
  assert.equal(created.created, true)
  return { home, project, fake, tools, exec, directory: path.join(project, '.professor', 'notes', created.directory) }
}

/** Compile tool with an injected probe and a recording runner (no real compiler). */
function compileTool(f, options = {}) {
  const calls = []
  const runner = async (spec) => {
    calls.push(spec)
    return options.runner
      ? options.runner(spec)
      : { runnerFailed: false, exitCode: 0, signal: null, timedOut: false, timeoutMs: spec.timeoutMs ?? null, stdout: 'ok', stderr: '' }
  }
  const tool = defineLatexCompileTool({
    resolveProject: (exec) => resolveProjectRoot(exec),
    gateway: createFsGateway({ ctx: f.fake.ctx }),
    runner,
    probeLatex: () => options.probe ?? AVAILABLE,
    probeFor: () => options.probe ?? AVAILABLE,
  })
  return { tool, calls }
}

const DIR = ['csc3200', 'recursion']

async function scanFixture(f, mainSource) {
  return preflightProject({ gateway: createFsGateway({ ctx: f.fake.ctx }),
    projectRoot: f.project, directory: f.directory, mainFile: 'main.tex', mainSource })
}

test('transitive packages supplied by classes or packages do not block valid documents', async () => {
  const f = await fixture()
  for (const main of [String.raw`\documentclass{beamer}\begin{document}\begin{align}a=b\end{align}\end{document}`,
    String.raw`\documentclass{article}\usepackage{tikz}\begin{document}\textcolor{red}{hello}\end{document}`]) {
    const scanned = await scanFixture(f, main)
    assert.equal(scanned.ok, true, scanned.problems.join('; '))
    assert.equal(scanned.cacheable, false)
    assert.ok(scanned.warnings.length > 0)
  }
})

test('only loaded local styles are read and their bytes participate in the digest', async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.directory, 'unused.sty'), String.raw`\RequirePackage{cancel}`)
  const main = String.raw`\documentclass{article}\begin{document}\cancel{x}\end{document}`
  const unused = await scanFixture(f, main)
  assert.equal(unused.ok, false, 'an unused style cannot satisfy a dependency')
  await fs.writeFile(path.join(f.directory, 'loaded.sty'), String.raw`\RequirePackage{cancel}`)
  const withStyle = main.replace('\\begin{document}', '\\usepackage{loaded}\\begin{document}')
  const first = await scanFixture(f, withStyle)
  assert.equal(first.ok, true, first.problems.join('; '))
  assert.ok(first.files.some(file => file.name === 'loaded.sty'))
  assert.equal(first.cacheable, false)
  await fs.appendFile(path.join(f.directory, 'loaded.sty'), '\n% changed\n')
  const second = await scanFixture(f, withStyle)
  assert.notEqual(second.digest, first.digest)
})

test('loaded style symlinks outside the artifact are not read', async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.home, 'outside.sty'), String.raw`\RequirePackage{cancel}`)
  await fs.symlink(path.join(f.home, 'outside.sty'), path.join(f.directory, 'escaped.sty'))
  const scanned = await scanFixture(f, String.raw`\documentclass{article}\usepackage{escaped}\begin{document}\cancel{x}\end{document}`)
  assert.ok(!scanned.packages.loaded.includes('cancel'))
  assert.ok(scanned.notes.some(note => /outside/.test(note)))
  assert.equal(scanned.cacheable, false)
})

test('graphics dependencies disable compile reuse even when the image exists', async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.directory, 'figure.png'), 'image')
  const scanned = await scanFixture(f, String.raw`\documentclass{article}\usepackage{graphicx}\begin{document}\includegraphics{figure}\end{document}`)
  assert.equal(scanned.cacheable, false)
})

test('local style traversal obeys the style-file cap even when all are declared together', async () => {
  const f = await fixture()
  for (let i = 0; i < 10; i += 1) await fs.writeFile(path.join(f.directory, `style${i}.sty`), '% style\n')
  const main = `\\documentclass{article}\\usepackage{${Array.from({ length: 10 }, (_, i) => `style${i}`).join(',')}}\\begin{document}hello\\end{document}`
  const scanned = await scanFixture(f, main)
  assert.equal(scanned.files.filter(file => file.name.endsWith('.sty')).length, 8)
  assert.equal(scanned.bounded, true)
  assert.equal(scanned.cacheable, false)
})

test('macro-based and unbraced inputs defer to TeX and disable compile reuse', async () => {
  const f = await fixture()
  for (const input of [String.raw`\input{\chapterfile}`, String.raw`\input content`]) {
    const scanned = await scanFixture(f, `\\documentclass{article}\\begin{document}${input}\\end{document}`)
    assert.equal(scanned.ok, true, scanned.problems.join('; '))
    assert.equal(scanned.cacheable, false)
  }
})

test('pending input reads reserve file and byte budgets before reading', async () => {
  const f = await fixture()
  for (let i = 0; i < 30; i += 1) await fs.writeFile(path.join(f.directory, `part${i}.tex`), 'x'.repeat(100))
  const mainSource = `\\documentclass{article}\\begin{document}${Array.from({ length: 30 }, (_, i) => `\\input{part${i}}`).join('')}\\end{document}`
  for (const override of [{ maxFiles: 3 }, { maxTotalBytes: Buffer.byteLength(mainSource) + 250 }]) {
    const gateway = createFsGateway({ ctx: f.fake.ctx })
    let reads = 0
    const readText = gateway.readText.bind(gateway)
    gateway.readText = (...args) => { reads += 1; return readText(...args) }
    const { PREFLIGHT_LIMITS } = await import('../src/latex/preflight.js')
    const scanned = await preflightProject({ gateway, projectRoot: f.project, directory: f.directory,
      mainFile: 'main.tex', mainSource, limits: { ...PREFLIGHT_LIMITS, ...override } })
    assert.equal(reads, 2, 'the pending queue must not read beyond its reserved budget')
    assert.equal(scanned.bounded, true)
    assert.equal(scanned.cacheable, false)
  }
})

test('csname in metadata disables reuse even with the exact bundled driver', async () => {
  const f = await fixture()
  await fs.appendFile(path.join(f.directory, 'professor-metadata.tex'),
    String.raw`\newcommand{\hidden}{\csname input\endcsname external.tex}`)
  const scanned = await scanFixture(f, await fs.readFile(path.join(f.directory, 'main.tex'), 'utf8'))
  assert.equal(scanned.cacheable, false)
})

// --- preflight before compiling -------------------------------------------------

test('a missing generated input blocks the compile before any process runs', async () => {
  const f = await fixture()
  await fs.unlink(path.join(f.directory, 'content.tex'))

  const { tool, calls } = compileTool(f)
  const report = await tool.execute({ directory: DIR.join('/') }, f.exec)

  assert.equal(report.verdict, 'source_generated')
  assert.equal(report.attempted, false)
  assert.equal(report.blocked_by, 'preflight')
  assert.equal(calls.length, 0, 'no compiler runs when a declared input is missing')
  assert.ok(report.problems.some((problem) => /content\.tex/.test(problem) && /input/.test(problem)),
    `expected a named missing input, got: ${report.problems.join(' | ')}`)
  assert.equal(report.preflight.ok, false)
  assert.ok(report.preflight.files.some((entry) => entry.name === 'main.tex'),
    'the preflight says what it actually checked')
  assert.match(report.summary, /preflight/)
})

test('escaped markup mistaken for LaTeX is caught before compiling, and names the fix', async () => {
  const f = await fixture()
  await fs.writeFile(
    path.join(f.directory, 'content.tex'),
    '\\section*{表格}\n\\textbackslash\\{\\}begin\\{tabular\\}\n',
    'utf8',
  )

  const { tool, calls } = compileTool(f)
  const report = await tool.execute({ directory: DIR.join('/') }, f.exec)

  assert.equal(report.blocked_by, 'preflight')
  assert.equal(calls.length, 0)
  assert.ok(report.problems.some((problem) => /escaped markup/.test(problem)),
    `expected the escaped-markup problem, got: ${report.problems.join(' | ')}`)
  assert.ok(report.problems.some((problem) => /body_tex|section body/.test(problem)),
    'the problem must say where raw LaTeX belongs now')
})

test('environment checks ignore comments and verbatim/code content', async () => {
  const f = await fixture()
  // A real body with phantom environments in a comment and inside a listing: must compile.
  await fs.writeFile(path.join(f.directory, 'content.tex'), [
    '% \\begin{itemize} 注释里的字面环境',
    '\\begin{lstlisting}[language=Python]',
    'def f():',
    '    # \\begin{tabular} 代码里的字面量',
    '    return 1',
    '\\end{lstlisting}',
    '\\begin{itemize}',
    '\\item 真正的列表',
    '\\end{itemize}',
    '',
  ].join('\n'), 'utf8')

  const healthy = compileTool(f)
  const passed = await healthy.tool.execute({ directory: DIR.join('/') }, f.exec)
  assert.equal(passed.preflight.ok, true, `preflight problems: ${passed.preflight.problems.join('; ')}`)
  assert.equal(passed.blocked_by, null, passed.summary)
  assert.equal(passed.attempted, true, 'a comment/listing must never block the compile')
  assert.equal(healthy.calls.length, 1, 'a comment/listing must never block the compile')

  // The same body with a genuinely mismatched environment: blocked, and it names the environment.
  await fs.writeFile(path.join(f.directory, 'content.tex'),
    '\\begin{itemize}\n\\item x\n\\end{enumerate}\n', 'utf8')
  const broken = compileTool(f)
  const refused = await broken.tool.execute({ directory: DIR.join('/') }, f.exec)
  assert.equal(refused.blocked_by, 'preflight')
  assert.equal(broken.calls.length, 0)
  assert.ok(refused.problems.some((problem) => /itemize/.test(problem)))
})

test('preflight stays inside the artifact directory and reports what it skipped', async () => {
  const f = await fixture()
  // A sibling file that exists outside the project directory, referenced with a traversal, plus an
  // absolute reference: neither may be read by the preflight.
  await writeFixture(f.home, 'term/shared.tex', '\\begin{itemize}\\item outside\\end{itemize}\n')
  await fs.writeFile(path.join(f.directory, 'main.tex'), [
    '\\documentclass{article}',
    '% dsh-professor-requirement: unicode-cjk',
    '\\begin{document}',
    '\\input{../shared}',
    '\\input{/etc/hosts}',
    '\\input{content}',
    '\\input{professor-metadata}',
    '\\end{document}',
    '',
  ].join('\n'), 'utf8')

  const { tool, calls } = compileTool(f)
  const report = await tool.execute({ directory: DIR.join('/') }, f.exec)

  const names = report.preflight.files.map((entry) => entry.name)
  assert.deepEqual(names, ['main.tex', 'content.tex', 'professor-metadata.tex'],
    'only files inside the artifact directory are inspected')
  assert.ok(report.preflight.notes.some((note) => /outside the artifact directory/.test(note)),
    'skipped references are reported, not silently ignored')
  assert.equal(report.preflight.ok, true, `preflight problems: ${report.preflight.problems.join('; ')}`)
  assert.equal(report.blocked_by, null, report.summary)
  assert.equal(report.attempted, true, 'a skipped reference is not a blocker on its own')
  assert.equal(calls.length, 1)
  assert.ok(report.preflight.digest, 'the preflight records a source digest of what it checked')
})

test('cancel is an explicit dependency: named when missing, silent only when loaded', async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.directory, 'content.tex'),
    '\\section*{约化}\n\\( \\cancel{E_0} \\) 被约掉。\n', 'utf8')

  const missing = compileTool(f)
  const refused = await missing.tool.execute({ directory: DIR.join('/') }, f.exec)
  assert.equal(refused.blocked_by, 'preflight')
  assert.equal(missing.calls.length, 0, 'an undefined \\cancel must not reach the compiler')
  assert.ok(refused.problems.some((problem) => /cancel/.test(problem) && /usepackage\{cancel\}/.test(problem)),
    `expected the explicit cancel guidance, got: ${refused.problems.join(' | ')}`)

  // The driver that loads cancel compiles — the dependency was the only defect.
  const main = await fs.readFile(path.join(f.directory, 'main.tex'), 'utf8')
  await fs.writeFile(
    path.join(f.directory, 'main.tex'),
    main.replace('\\documentclass', '\\usepackage{cancel}\n\\documentclass'),
    'utf8',
  )
  const loaded = compileTool(f)
  const attempted = await loaded.tool.execute({ directory: DIR.join('/') }, f.exec)
  assert.equal(attempted.blocked_by, null, attempted.summary)
  assert.equal(attempted.attempted, true, 'with cancel loaded the compile runs normally')
  assert.equal(loaded.calls.length, 1, 'with cancel loaded the compile runs normally')
})

// --- failure classification ------------------------------------------------------

test('a sandbox/permission denial is an environment blocker, not a document error', async () => {
  const f = await fixture()
  const { tool } = compileTool(f, {
    runner: async () => ({
      runnerFailed: false, exitCode: 1, signal: null, timedOut: false, timeoutMs: 1000,
      stdout: '', stderr: "latexmk: Permission denied\n! I can't write on file `main.aux'.\n",
      sandbox: { mode: 'workspace-write', denied: true },
    }),
  })
  const report = await tool.execute({ directory: DIR.join('/') }, f.exec)

  assert.equal(report.verdict, 'compilation_failed')
  assert.equal(report.failure_class, 'environment', 'a denial must never read as a document error')
  assert.match(report.summary, /environment/)
  assert.match(report.summary, /not a document error/i)
  assert.ok(report.problems.some((problem) => /do not repair the document/i.test(problem)),
    'the report must stop a repair loop explicitly')
  assert.equal(report.blocked_by, null)
  assert.match(report.stderr, /Permission denied/, 'the compiler evidence is preserved verbatim')
})

test('a missing TeX package is an environment blocker naming the package', async () => {
  const f = await fixture()
  const { tool } = compileTool(f, {
    runner: async () => ({
      runnerFailed: false, exitCode: 1, signal: null, timedOut: false, timeoutMs: 1000,
      stdout: '! LaTeX Error: File `cancel.sty\' not found.\n', stderr: '',
    }),
  })
  const report = await tool.execute({ directory: DIR.join('/') }, f.exec)

  assert.equal(report.failure_class, 'environment')
  assert.match(report.summary, /cancel\.sty/)
  assert.match(report.summary, /do not repair the document/i)
  assert.ok(report.diagnostics.errors.some((line) => /cancel\.sty/.test(line)),
    'the concise diagnostics carry the package error')
})

test('an ordinary compile error stays a document failure with concise diagnostics', async () => {
  const f = await fixture()
  const longStderr = [
    '! Undefined control sequence.',
    'l.14 \\notACommand',
    'The control sequence at the end of the top line',
    ...Array.from({ length: 50 }, (_, index) => `padding line ${index}`),
  ].join('\n')
  const { tool } = compileTool(f, {
    runner: async () => ({
      runnerFailed: false, exitCode: 1, signal: null, timedOut: false, timeoutMs: 1000,
      stdout: '', stderr: longStderr,
    }),
  })
  const report = await tool.execute({ directory: DIR.join('/') }, f.exec)

  assert.equal(report.failure_class, 'document')
  assert.equal(report.blocked_by, null)
  assert.ok(report.diagnostics.errors.length > 0)
  assert.match(report.diagnostics.errors[0], /Undefined control sequence/)
  assert.ok(report.diagnostics.errors.length <= 8, 'the diagnostic list stays concise')
  assert.equal(report.stderr, longStderr, 'the full evidence is still returned')
  assert.ok(report.problems.some((problem) => /do not repair/i.test(problem)) === false,
    'a document error must NOT tell the caller to stop repairing')
})

test('a timeout is classified on its own and a seam failure is environmental', async () => {
  const f = await fixture()

  const timedOut = compileTool(f, {
    runner: async (spec) => ({
      runnerFailed: false, exitCode: null, signal: 'SIGKILL', timedOut: true, timeoutMs: 500,
      stdout: '', stderr: '', ...(spec === undefined ? {} : {}),
    }),
  })
  const expiry = await timedOut.tool.execute({ directory: DIR.join('/'), timeout_ms: 500 }, f.exec)
  assert.equal(expiry.verdict, 'compilation_failed')
  assert.equal(expiry.failure_class, 'timeout')

  const seam = compileTool(f, {
    runner: async () => ({ runnerFailed: true, reason: 'the shell seam rejected the request: denied' }),
  })
  const refused = await seam.tool.execute({ directory: DIR.join('/') }, f.exec)
  assert.equal(refused.failure_class, 'environment')
  assert.match(refused.summary, /environment/)
})

test('the environment classification also applies to blocked (not attempted) results', async () => {
  const f = await fixture()
  const { tool } = compileTool(f, { probe: { available: false, engine: null, path: null, searched: [], note: 'no TeX' } })
  const report = await tool.execute({ directory: DIR.join('/') }, f.exec)
  assert.equal(report.verdict, 'compiler_unavailable')
  assert.equal(report.failure_class, 'environment', 'a missing compiler cannot be repaired in the document')
  assert.equal(report.preflight.ok, true, 'the source still passed the preflight')
})
