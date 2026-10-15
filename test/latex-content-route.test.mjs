/**
 * The explicit one-pass LaTeX content route (`body_tex`).
 *
 * Why this exists: `renderContentTex` escapes prose so a stray `_`/`&` can never become TeX syntax,
 * which meant a model that wanted a real formula, table, semantic box or diagram had to generate
 * `content.tex` and then *rewrite the file afterwards* — a second full generation pass over the
 * same material (docs/qa/2026-10-15-latex-flow-audit/REPORT.md, finding 2).
 *
 * What these tests pin:
 *   1. an explicit `body_tex` input typesets raw LaTeX inside the structured sections, in one pass;
 *   2. every other field keeps its existing escaping — nothing is globally unescaped;
 *   3. the route is LaTeX-only and validated (fragment, balanced, no shell escape) BEFORE any file
 *      is written, so a bad fragment cannot half-create a project;
 *   4. comment/verbatim/code content is masked, so a literal `\begin{...}` inside `lstlisting`
 *      never produces a false imbalance;
 *   5. section accounting stays truthful for `body_tex`-only sections.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

function projectDocument({ material, notesRoot = null }) {
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
  latex_template: null
web:
  enabled: true
  policy: conditional
`
}

async function fixture() {
  const home = await makeHome('professor-body-tex-')
  const project = path.join(home, 'term')
  const material = path.join(project, 'CSC3200')
  await writeFixture(home, 'term/CSC3200/01_Lectures/lecture-01.md', 'lecture material')
  await writeFixture(home, 'term/.professor/project.yaml', projectDocument({ material }))

  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })
  await tools.professor_session_bind.execute({ course: 'csc3200' }, exec)
  return { home, project, fake, tools, exec }
}

const contentOf = (project, directory, kind = 'notes') =>
  fs.readFile(path.join(project, '.professor', kind, directory, 'content.tex'), 'utf8')

// --- the one-pass route ------------------------------------------------------

test('a body_tex section typesets real LaTeX in one pass while prose fields stay escaped', async () => {
  const f = await fixture()
  const created = await f.tools.professor_artifact_create.execute({
    kind: 'note',
    title: '量子力学基础',
    format: 'latex',
    topic: 'Chapter 3',
    summary: '波函数与算符。下划线 _ 与 & 必须保持转义。',
    sections: [
      {
        heading: '能量本征值',
        body_tex: [
          '定态方程 $\\hat{H}\\lvert\\psi_n\\rangle = E_n\\lvert\\psi_n\\rangle$，其中',
          '\\begin{professorkey}[重点]',
          '  能级 $E_n = \\left(n + \\tfrac{1}{2}\\right)\\hbar\\omega$ 等间距。',
          '\\end{professorkey}',
          '\\begin{tabular}{lrr}',
          '  \\toprule',
          '  能级 & $n$ & $E_n/(\\hbar\\omega)$ \\\\',
          '  \\midrule',
          '  基态 & 0 & 1 \\\\',
          '  第一激发态 & 1 & 3 \\\\',
          '  \\bottomrule',
          '\\end{tabular}',
          '\\begin{tikzpicture}[baseline]',
          '  \\draw[->] (0,0) -- (3,0) node[right] {时间};',
          '\\end{tikzpicture}',
        ].join('\n'),
      },
      { heading: '阅读提示', body: '先看例题再做练习。_ & 保持字面。' },
    ],
  }, f.exec)
  assert.equal(created.created, true)

  const content = await contentOf(f.project, created.directory)

  // Raw LaTeX survives verbatim: no double-generation pass was needed.
  assert.match(content, /\\hat\{H\}\\lvert\\psi_n\\rangle/)
  assert.match(content, /\\begin\{professorkey\}\[重点\]/)
  assert.match(content, /\\begin\{tabular\}\{lrr\}/)
  assert.match(content, /\\begin\{tikzpicture\}/)
  assert.doesNotMatch(content, /\\textbackslash/, 'body_tex must never be escaped')

  // Every other field keeps its escaping — no global unescape.
  assert.match(content, /\\section\*\{阅读提示\}/)
  assert.match(content, /下划线 \\_/)
  assert.match(content, /\\&/)
  assert.match(content, /波函数与算符/, 'the prose summary is untouched text')
})

test('an entry with both body and body_tex renders body_tex, and says so in the artifact', async () => {
  const f = await fixture()
  const created = await f.tools.professor_artifact_create.execute({
    kind: 'note',
    title: 'Precedence',
    format: 'latex',
    sections: [{ heading: 'A', body: 'plain prose', body_tex: 'Raw $x^2$.' }],
  }, f.exec)
  assert.equal(created.created, true)
  const content = await contentOf(f.project, created.directory)
  assert.match(content, /Raw \$x\^2\$\./)
  assert.equal(content.includes('plain prose'), false, 'body_tex wins over body for the same entry')
})

test('body_tex is refused for markdown: the format gate is never silently reinterpreted', async () => {
  const f = await fixture()
  await assert.rejects(
    () => f.tools.professor_artifact_create.execute({
      kind: 'note', title: 'Mixed Signals', format: 'markdown',
      sections: [{ heading: 'A', body_tex: '$x^2$' }],
    }, f.exec),
    (error) => error.code === 'PROFESSOR_ARTIFACT_TEX_FORMAT' && /format: "latex"/.test(error.message),
  )
  assert.equal(
    await fs.stat(path.join(f.project, '.professor', 'notes')).then(() => true, () => false),
    false,
    'nothing is written when the route is refused',
  )
})

test('an invalid LaTeX fragment is refused before any file is written', async () => {
  const f = await fixture()

  await assert.rejects(
    () => f.tools.professor_artifact_create.execute({
      kind: 'note', title: 'Unbalanced', format: 'latex',
      sections: [{ heading: 'A', body_tex: '\\begin{itemize}\n\\item x\n' }],
    }, f.exec),
    (error) => error.code === 'PROFESSOR_ARTIFACT_TEX_INVALID'
      && /unbalanced environments|environments never closed/.test(error.message),
  )

  await assert.rejects(
    () => f.tools.professor_artifact_create.execute({
      kind: 'note', title: 'Whole Document', format: 'latex',
      sections: [{ heading: 'A', body_tex: '\\documentclass{article}\n\\begin{document}x\\end{document}' }],
    }, f.exec),
    (error) => error.code === 'PROFESSOR_ARTIFACT_TEX_INVALID' && /fragment/.test(error.message),
  )

  await assert.rejects(
    () => f.tools.professor_artifact_create.execute({
      kind: 'note', title: 'Shell Escape', format: 'latex',
      sections: [{ heading: 'A', body_tex: '\\write18{rm -rf /}' }],
    }, f.exec),
    (error) => error.code === 'PROFESSOR_ARTIFACT_TEX_INVALID' && /shell escape/.test(error.message),
  )

  for (const title of ['Unbalanced', 'Whole Document', 'Shell Escape']) {
    const directory = path.join(f.project, '.professor', 'notes', 'csc3200', title.toLowerCase().replace(/\s+/g, '-'))
    assert.equal(await fs.stat(directory).then(() => true, () => false), false,
      `${title}: a refused fragment writes no project`)
  }
})

test('literal environments inside comment/verbatim/code content never trip the balance check', async () => {
  const f = await fixture()
  const created = await f.tools.professor_artifact_create.execute({
    kind: 'note',
    title: 'Listings',
    format: 'latex',
    sections: [{
      heading: '代码示例',
      body_tex: [
        '\\begin{lstlisting}[language=Python]',
        'if x:',
        '    # \\begin{itemize} 未闭合的字面量，来自注释与代码',
        '    return 1',
        '\\end{lstlisting}',
        '% \\begin{itemize} 注释里的字面环境',
        '\\begin{itemize}',
        '\\item 真正的列表',
        '\\end{itemize}',
      ].join('\n'),
    }],
  }, f.exec)
  assert.equal(created.created, true)
  const content = await contentOf(f.project, created.directory)
  assert.match(content, /\\begin\{lstlisting\}/)
  assert.match(content, /\\item 真正的列表\n\\end\{itemize\}\s*$/, 'the real environment is intact')
})

test('body_tex-only sections are reported as rendered, not as omitted', async () => {
  const f = await fixture()
  const created = await f.tools.professor_artifact_create.execute({
    kind: 'note',
    title: 'Accounting',
    format: 'latex',
    sections: [
      { heading: '只有公式', body_tex: '$e^{i\\pi} + 1 = 0$' },
      { heading: '空小节' },
    ],
  }, f.exec)
  assert.equal(created.created, true)
  assert.ok(created.sections_rendered.includes('只有公式'), 'a raw section was written into content.tex')
  assert.equal(created.sections_rendered.includes('空小节'), false)
  assert.ok(created.sections_omitted.includes('空小节'), 'a section with no body at all stays omitted')

  const content = await contentOf(f.project, created.directory)
  assert.match(content, /\\section\*\{只有公式\}/)
  assert.match(content, /e\^\{i\\pi\} \+ 1 = 0/)
})

test('review derivations accept body_tex so a derivation can carry real math once', async () => {
  const f = await fixture()
  const created = await f.tools.professor_artifact_create.execute({
    kind: 'review',
    title: 'Midterm',
    format: 'latex',
    from_state: false,
    derivations: [{
      title: '动能定理',
      body_tex: '由 $W = \\int \\vec{F}\\cdot\\mathrm{d}\\vec{s}$ 得\n\\[ \\Delta K = W \\]',
    }],
    formulas: ['$E = mc^2$'],
  }, f.exec)
  assert.equal(created.created, true)
  const content = await contentOf(f.project, created.directory, 'reviews')
  assert.match(content, /\\int \\vec\{F\}\\cdot\\mathrm\{d\}\\vec\{s\}/)
  assert.match(content, /\\section\*\{动能定理\}/)
  // The existing raw-math exception for formulas[] is untouched.
  assert.match(content, /E = mc\^2/)
})
