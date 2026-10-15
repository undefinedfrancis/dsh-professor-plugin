/**
 * M11 artifact tests: the format gate, output-root safety, the no-silent-overwrite policy, the
 * Markdown note and exam-review content contracts, provenance labelling, and artifact status.
 *
 * Every test asserts a *contract* rather than an implementation detail: which root was used and
 * why, whether anything was written, what the artifact says about itself, and which decision was
 * taken when the request was ambiguous. The two rules the design calls non-negotiable — "never
 * guess the format" and "never silently overwrite" — each get a test that would fail if the tool
 * became helpful in the wrong way.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { renderNote } from '../src/artifacts/note.js'
import { renderReview, REVIEW_SECTIONS } from '../src/artifacts/review.js'
import { resolveArtifactFormat } from '../src/artifacts/format-gate.js'
import { resolveArtifactRoot } from '../src/artifacts/paths.js'
import { versionedFilename, parseVersionedFilename } from '../src/artifacts/store.js'
import { createFakeContext, makeExec, makeHome, writeFixture } from './helpers/fake-harness.mjs'

test('Markdown glossary cells preserve conditional bars without creating extra columns', () => {
  const { content } = renderNote({ title: 'Conditional probability', terminology: [
    { term: 'P(D|+)', definition: 'Disease | positive\r\nUse the positive population.' },
    { term: 'E[X\\|Z]', definition: 'Already escaped condition' },
  ] })
  assert.ok(content.includes('| P(D\\|+) | Disease \\| positive Use the positive population. |'))
  assert.ok(content.includes('| E[X\\|Z] | Already escaped condition |'),
    'an existing Markdown escape is retained without doubling')
})

/** Build the fixture project document, mirroring what `saveProject` emits. */
function projectDocument(options = {}) {
  const {
    material, notesRoot = null, reviewsRoot = null,
    defaultFormat = 'ask', overwritePolicy = 'never', latexTemplate = null,
  } = options
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
  reviews_root: ${reviewsRoot === null ? 'null' : reviewsRoot}
indexing:
  exclude: []
  follow_symlinks: false
retrieval:
  max_sources: 4
  max_chunks: 8
  prefer_local_course_sources: true
notes:
  default_format: ${defaultFormat}
  overwrite_policy: ${overwritePolicy}
  latex_template: ${latexTemplate === null ? 'null' : latexTemplate}
web:
  enabled: true
  policy: conditional
`
}

/**
 * Create a fixture project.
 *
 * `notesRoot` / `reviewsRoot` are *relative to the project* on purpose: a path outside the
 * session workspace would be denied by the deployment sandbox before the artifact logic ran, and
 * these tests are about the artifact logic.
 */
async function fixture(options = {}) {
  const home = await makeHome('professor-artifacts-')
  const project = path.join(home, 'term')
  const material = path.join(project, 'CSC3200')
  await writeFixture(home, 'term/CSC3200/01_Lectures/lecture-01.md', 'lecture material')
  await writeFixture(home, 'term/CSC3200/03_Assignments/hw1.md', 'assignment')

  const notesRoot = options.notesRoot === undefined || options.notesRoot === null
    ? null
    : path.join(project, options.notesRoot)
  const reviewsRoot = options.reviewsRoot === undefined || options.reviewsRoot === null
    ? null
    : path.join(project, options.reviewsRoot)
  const latexTemplate = options.latexTemplate === undefined || options.latexTemplate === null
    ? null
    : path.join(home, options.latexTemplate)

  await writeFixture(home, 'term/.professor/project.yaml', projectDocument({
    material,
    notesRoot,
    reviewsRoot,
    defaultFormat: options.defaultFormat ?? 'ask',
    overwritePolicy: options.overwritePolicy ?? 'never',
    latexTemplate,
  }))

  const fake = createFakeContext({ home })
  apply(fake.ctx, fake.pluginConfig)
  const tools = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]))
  const exec = makeExec({ cwd: project })

  // Bind the session the way a real conversation does, so most tests exercise the default path
  // ("which course is this about?" → this session's binding). The unbound case is covered by its
  // own test below.
  if (options.bind !== false) {
    const bound = await tools.professor_session_bind.execute({ course: 'csc3200' }, exec)
    assert.equal(bound.course_id, 'csc3200', 'fixture setup: the session must bind to the registered course')
  }

  return { home, project, material, notesRoot, reviewsRoot, latexTemplate, fake, tools, exec }
}

const readFile = (absolute) => fs.readFile(absolute, 'utf8')
const exists = (absolute) => fs.stat(absolute).then(() => true, () => false)

/** The fs version token of a file, read the way the tool reads it. */
async function versionOf(fake, project, absolute) {
  const target = await fake.fs.resolve(absolute, { cwd: project })
  const info = await fake.fs.stat(target)
  return info.version
}

/** A note request that exercises every content section the renderer knows about. */
function richNote(overrides = {}) {
  return {
    kind: 'note',
    title: 'Binary Trees',
    format: 'markdown',
    topic: 'Tree traversals',
    scope: 'Lecture 04 and tutorial 02',
    summary: 'How binary trees are traversed and why the order matters.',
    sections: [{ heading: '遍历顺序', body: '前序、中序、后序的区别在于访问根节点的时机。' }],
    terminology: [{ term: 'in-order', definition: '左-根-右' }],
    examples: [{ title: '重建二叉树', body: '给定前序与中序，可以唯一确定一棵二叉树。' }],
    mistakes: ['把中序与前序混为一谈'],
    warnings: ['注意空树不是叶子节点'],
    self_check: ['给出前序与中序，画树'],
    deep_dives: [{ topic: '平衡因子', question: '为什么 AVL 要求 ±1？', cause: '旋转次数与高度相关' }],
    practice: [{ question: '写出中序遍历结果', origin: 'adapted', answer: '从左到右' }],
    ...overrides,
  }
}

// --- the format gate --------------------------------------------------------

test('an explicit markdown request is honoured and written into the configured root', async () => {
  const f = await fixture({ notesRoot: 'notes-out' })
  const configured = path.join(f.project, 'notes-out')

  const result = await f.tools.professor_artifact_create.execute(richNote(), f.exec)
  assert.equal(result.created, true)
  assert.equal(result.format, 'markdown')
  assert.equal(result.format_source, 'explicit-request')
  assert.equal(result.format_required, false)
  assert.equal(result.root, configured)
  assert.equal(result.root_source, 'outputs.notes_root')
  assert.equal(result.filename, 'binary-trees.md')
  assert.deepEqual(result.files.map((file) => file.relative), ['csc3200/binary-trees/binary-trees.md'])

  const written = await readFile(path.join(configured, 'csc3200', 'binary-trees', 'binary-trees.md'))
  assert.match(written, /^<!-- professor-artifact/)
  assert.match(written, /^# Binary Trees$/m)
})

test('the format is never guessed: the ask default returns a structured choice and writes nothing', async () => {
  const f = await fixture({ defaultFormat: 'ask' })

  const result = await f.tools.professor_artifact_create.execute({ kind: 'note', title: 'Graphs' }, f.exec)
  assert.equal(result.format_required, true)
  assert.equal(result.created, false)
  assert.equal(result.format, null)
  assert.deepEqual(result.options, ['markdown', 'latex'])
  assert.equal(result.root, null, 'no destination is resolved before the format is known')
  assert.deepEqual(result.files, [])
  assert.match(result.question, /markdown/)
  assert.match(result.question, /latex/)
  assert.equal(await exists(path.join(f.project, '.professor', 'notes')), false, 'nothing was written')

  // The gate itself must not treat anything else as evidence.
  assert.equal(resolveArtifactFormat({ requested: 'pdf' }).status, 'required', 'an unknown format is not mapped to a guess')
  assert.equal(resolveArtifactFormat({ requested: 'md' }).format, 'markdown', 'documented shorthand is accepted')
  assert.equal(resolveArtifactFormat({ requested: undefined, projectDefault: 'ask' }).status, 'required')
})

test('"ask every time" asks again even though a markdown artifact already exists', async () => {
  const f = await fixture({ defaultFormat: 'ask' })
  const first = await f.tools.professor_artifact_create.execute(richNote(), f.exec)
  assert.equal(first.created, true)

  const second = await f.tools.professor_artifact_create.execute({ kind: 'note', title: 'Another Topic' }, f.exec)
  assert.equal(second.format_required, true, 'a previous artifact is not evidence for the next format')
  assert.equal(second.created, false)
})

test('even a concrete project default cannot skip the explicit format choice', async () => {
  const f = await fixture({ defaultFormat: 'markdown' })
  const result = await f.tools.professor_artifact_create.execute({ kind: 'note', title: 'Graphs' }, f.exec)
  assert.equal(result.format_required, true)
  assert.equal(result.format, null)
  assert.equal(result.created, false)
})

// --- note content -----------------------------------------------------------

test('a note renders only sections that have content and lists the rest as omitted', async () => {
  const f = await fixture({ defaultFormat: 'markdown' })
  const sparse = await f.tools.professor_artifact_create.execute({
    kind: 'note', title: 'Sparse', format: 'markdown', sections: [{ heading: '唯一小节', body: '内容' }],
  }, f.exec)
  const sparseText = await readFile(path.join(f.project, '.professor', 'notes', 'csc3200', 'sparse', 'sparse.md'))

  assert.ok(sparse.sections_rendered.includes('唯一小节'))
  for (const absent of ['重要术语', '例题与推导', '易错点', '自测问题', '练习']) {
    assert.equal(sparse.sections_rendered.includes(absent), false, `${absent} was invented`)
    assert.ok(sparse.sections_omitted.includes(absent), `${absent} must be reported as omitted`)
    assert.doesNotMatch(sparseText, new RegExp(`^## ${absent}$`, 'm'), `${absent} must not appear as an empty heading`)
  }

  const rich = await f.tools.professor_artifact_create.execute(richNote({ title: 'Rich' }), f.exec)
  const richText = await readFile(path.join(f.project, '.professor', 'notes', 'csc3200', 'rich', 'rich.md'))
  for (const present of ['重要术语', '例题与推导', '易错点', '注意事项', '深挖标记', '自测问题', '练习', '遍历顺序']) {
    assert.ok(rich.sections_rendered.includes(present), `${present} must render when it has content`)
    assert.match(richText, new RegExp(`^## ${present}$`, 'm'))
  }
})

test('note metadata is deterministic for identical inputs', () => {
  const input = {
    ...richNote(),
    course: { course_id: 'csc3200', course_code: 'CSC3200' },
    generated_at: '2026-01-01T00:00:00.000Z',
    generator: 'dsh-professor-spike',
  }
  const a = renderNote(input)
  const b = renderNote(input)
  assert.equal(a.content, b.content, 'the same inputs must render byte-identical output')
  assert.equal(a.content.split('generated_at: ')[1].split('\n')[0], '2026-01-01T00:00:00.000Z')
  assert.match(a.content, /^schema: 1$/m)
  assert.match(a.content, /^kind: note$/m)
  assert.match(a.content, /^course_id: csc3200$/m)
  assert.doesNotMatch(a.content, /^course_id: null$/m)
})

test('supplementary explanation is fenced off and never presented as professor material', async () => {
  const f = await fixture({ defaultFormat: 'markdown' })
  const result = await f.tools.professor_artifact_create.execute(richNote({
    title: 'With Supplement',
    supplementary: ['模型补充的一点背景'],
  }), f.exec)
  const text = await readFile(path.join(f.project, '.professor', 'notes', 'csc3200', 'with-supplement', 'with-supplement.md'))

  const heading = '补充说明（模型补充，非教授材料）'
  assert.ok(result.sections_rendered.includes(heading))
  assert.match(text, new RegExp(`^## ${heading}$`, 'm'))
  assert.match(text, /不代表教授讲义的观点或考试范围/)
  assert.ok(text.indexOf('模型补充的一点背景') > text.indexOf(`## ${heading}`), 'supplementary text lives under its own heading')
})

test('every practice item carries its origin label and an unlabelled item is refused', async () => {
  const f = await fixture({ defaultFormat: 'markdown' })
  const result = await f.tools.professor_artifact_create.execute(richNote({
    title: 'Practice',
    practice: [
      { question: '教授原题', origin: 'original' },
      { question: '改过的题', origin: 'adapted' },
      { question: '我出的题', origin: 'generated' },
    ],
  }), f.exec)
  const text = await readFile(path.join(f.project, '.professor', 'notes', 'csc3200', 'practice', 'practice.md'))
  assert.match(text, /（原题）/)
  assert.match(text, /（改编题）/)
  assert.match(text, /（新编练习）/)
  assert.deepEqual(result.problems, [])

  await assert.rejects(
    () => f.tools.professor_artifact_create.execute(richNote({ title: 'Unlabelled', practice: [{ question: '谁出的？' }] }), f.exec),
    (error) => error.code === 'PROFESSOR_PROVENANCE_INVALID',
  )
  await assert.rejects(
    () => f.tools.professor_artifact_create.execute(richNote({ title: 'Bad Origin', practice: [{ question: 'q', origin: 'made-up' }] }), f.exec),
    (error) => error.code === 'PROFESSOR_PROVENANCE_INVALID',
  )
  assert.equal(await exists(path.join(f.project, '.professor', 'notes', 'csc3200', 'unlabelled', 'unlabelled.md')), false,
    'an unlabelled practice item writes nothing')
})

// --- output roots -----------------------------------------------------------

test('a configured output root that is, or contains, course material is refused', async () => {
  const f = await fixture()
  const base = { courses: [{ course_id: 'csc3200', sources: [{ path: f.material }] }] }

  assert.throws(
    () => resolveArtifactRoot({ document: { ...base, outputs: {} }, projectRoot: f.project, kind: 'slide' }),
    (error) => error.code === 'PROFESSOR_ARTIFACT_KIND_INVALID',
    'an unknown kind is a domain error, not a silent default',
  )
  assert.throws(
    () => resolveArtifactRoot({ document: { ...base, outputs: { notes_root: f.material } }, projectRoot: f.project, kind: 'note' }),
    (error) => error.code === 'PROFESSOR_ARTIFACT_ROOT_UNSAFE',
  )
  assert.throws(
    () => resolveArtifactRoot({ document: { ...base, outputs: { notes_root: f.project } }, projectRoot: f.project, kind: 'note' }),
    (error) => error.code === 'PROFESSOR_ARTIFACT_ROOT_UNSAFE',
    'a root containing a course root would make the whole course writable',
  )
})

test('an output root inside a course root is accepted only when it names an artifact subdirectory', async () => {
  const accepted = await fixture({ notesRoot: 'CSC3200/04_My-Notes/AI-Notes' })
  const result = await accepted.tools.professor_artifact_create.execute(richNote({ title: 'In Course' }), accepted.exec)
  assert.equal(result.created, true)
  assert.equal(result.root, path.join(accepted.material, '04_My-Notes', 'AI-Notes'))
  assert.equal(result.root_source, 'outputs.notes_root')

  const listed = await accepted.tools.professor_artifact_status.execute({}, accepted.exec)
  assert.equal(listed.roots[0].insideSource, accepted.material,
    'the report says the root is an artifact subdirectory of the course root')
  assert.ok(listed.warnings.some((warning) => /artifact subdirectory inside the course root/.test(warning)))

  // The same shape without an artifact segment is refused.
  const refused = await fixture({ notesRoot: 'CSC3200/random-dir' })
  await assert.rejects(
    () => refused.tools.professor_artifact_create.execute(richNote({ title: 'Nope' }), refused.exec),
    (error) => error.code === 'PROFESSOR_ARTIFACT_ROOT_UNSAFE',
  )
  assert.equal(await exists(path.join(refused.material, 'random-dir')), false)
})

test('a traversal spelling or a destination inside .professor/state is refused', async () => {
  const f = await fixture()
  const base = { courses: [{ course_id: 'csc3200', sources: [{ path: f.material }] }], outputs: {} }
  const resolve = (notes_root) => resolveArtifactRoot({
    document: { ...base, outputs: { notes_root } }, projectRoot: f.project, kind: 'note',
  })

  for (const unsafe of [
    `${f.project}/notes/../escape`,
    path.join(f.project, '.professor', 'state'),
    path.join(f.project, '.professor', 'state', 'courses'),
  ]) {
    assert.throws(() => resolve(unsafe), (error) => error.code === 'PROFESSOR_ARTIFACT_ROOT_UNSAFE',
      `${unsafe} must be refused`)
  }
})

test('a destination inside another course\'s source tree is refused', async () => {
  const f = await fixture()
  const other = path.join(f.project, 'STA2001')
  const nested = path.join(other, '04_My-Notes', 'AI-Notes')
  const courseA = { course_id: 'csc3200', sources: [{ path: f.material }] }
  const courseB = { course_id: 'sta2001', sources: [{ path: other }] }
  const document = { courses: [courseA, courseB], outputs: { notes_root: nested } }

  // A safe artifact segment does not make another course's tree writable.
  assert.throws(
    () => resolveArtifactRoot({ document, projectRoot: f.project, kind: 'note', course: courseA }),
    (error) => error.code === 'PROFESSOR_ARTIFACT_ROOT_UNSAFE' && /another course/.test(error.message),
    'course A must not write into course B\'s tree, even through 04_My-Notes/AI-Notes',
  )
  assert.equal(await exists(nested), false, 'refusal creates nothing')

  // The same root is fine for the course that owns it.
  const own = resolveArtifactRoot({ document, projectRoot: f.project, kind: 'note', course: courseB })
  assert.equal(own.root, nested)
  assert.equal(own.insideSource, other)
  assert.equal(own.source, 'outputs.notes_root')
})

test('an artifact never falls back to the process working directory', async () => {
  const f = await fixture({ notesRoot: null })
  const result = await f.tools.professor_artifact_create.execute(richNote({ title: 'Default Root' }), f.exec)

  assert.equal(result.root, path.join(f.project, '.professor', 'notes'))
  assert.equal(result.root_source, 'project-default')
  assert.notEqual(result.root, process.cwd())
  assert.equal(path.resolve(result.root).startsWith(path.resolve(f.project)), true)
  assert.equal(await exists(path.join(process.cwd(), 'csc3200', 'default-root', 'default-root.md')), false)
})

// --- overwrite policy -------------------------------------------------------

test('the default policy never overwrites: a second create is refused and suggests the next name', async () => {
  const f = await fixture({ defaultFormat: 'markdown' })
  const target = path.join(f.project, '.professor', 'notes', 'csc3200', 'twice', 'twice.md')

  const first = await f.tools.professor_artifact_create.execute(richNote({ title: 'Twice', summary: '第一版' }), f.exec)
  assert.equal(first.created, true)
  const before = await readFile(target)

  const second = await f.tools.professor_artifact_create.execute(richNote({ title: 'Twice', summary: '第二版' }), f.exec)
  assert.equal(second.created, false)
  assert.deepEqual(second.files, [])
  assert.equal(second.suggested.filename, 'twice-v2.md')
  assert.ok(second.problems.some((problem) => /already exists/.test(problem)))
  assert.equal(await readFile(target), before, 'the existing artifact is byte-identical')

  // The suggestion is actionable: taking it writes the new version and still leaves v1 alone.
  const taken = await f.tools.professor_artifact_create.execute(richNote({
    title: 'Twice', summary: '第二版', filename: 'twice-v2',
  }), f.exec)
  assert.equal(taken.created, true)
  assert.equal(taken.filename, 'twice-v2.md')
  assert.equal(await readFile(target), before)
})

test('the versioned policy writes an alternative and leaves the original untouched', async () => {
  const f = await fixture({ defaultFormat: 'markdown', overwritePolicy: 'versioned' })
  const base = path.join(f.project, '.professor', 'notes', 'csc3200', 'versioned', 'versioned.md')

  await f.tools.professor_artifact_create.execute(richNote({ title: 'Versioned', summary: 'v1' }), f.exec)
  const original = await readFile(base)

  const second = await f.tools.professor_artifact_create.execute(richNote({ title: 'Versioned', summary: 'v2' }), f.exec)
  assert.equal(second.created, true)
  assert.equal(second.filename, 'versioned-v2.md')
  assert.ok(second.warnings.some((warning) => /wrote versioned-v2\.md instead/.test(warning)))
  assert.equal(await readFile(base), original)

  const third = await f.tools.professor_artifact_create.execute(richNote({ title: 'Versioned', summary: 'v3' }), f.exec)
  assert.equal(third.filename, 'versioned-v3.md')
  assert.match(await readFile(path.join(f.project, '.professor', 'notes', 'csc3200', 'versioned', 'versioned-v2.md')), /v2/)
})

test('the allow policy requires the current version token and refuses a stale one', async () => {
  const f = await fixture({ defaultFormat: 'markdown', overwritePolicy: 'allow' })
  const target = path.join(f.project, '.professor', 'notes', 'csc3200', 'explicit', 'explicit.md')

  await f.tools.professor_artifact_create.execute(richNote({ title: 'Explicit', summary: 'first' }), f.exec)

  // No token: the tool will not overwrite on a bare request.
  const untokened = await f.tools.professor_artifact_create.execute(richNote({ title: 'Explicit', summary: 'second' }), f.exec)
  assert.equal(untokened.created, false)
  assert.match(await readFile(target), /first/)

  // A token that does not match the current file is refused outright.
  await assert.rejects(
    () => f.tools.professor_artifact_create.execute(richNote({
      title: 'Explicit', summary: 'second', overwrite: { policy: 'allow', expected_version: 'not-the-current-version' },
    }), f.exec),
    (error) => error.code === 'PROFESSOR_ARTIFACT_STALE',
  )

  // The real token overwrites exactly that revision.
  const version = await versionOf(f.fake, f.project, target)
  const overwritten = await f.tools.professor_artifact_create.execute(richNote({
    title: 'Explicit', summary: 'third', overwrite: { policy: 'allow', expected_version: version },
  }), f.exec)
  assert.equal(overwritten.created, true)
  assert.equal(overwritten.filename, 'explicit.md')
  assert.match(await readFile(target), /third/)
})

test('versioned filenames round-trip and v1 is the bare name', () => {
  assert.equal(versionedFilename('note.md', 1), 'note.md')
  assert.equal(versionedFilename('note.md', 3), 'note-v3.md')
  assert.deepEqual(parseVersionedFilename('note-v3.md'), { base: 'note.md', version: 3, ext: '.md' })
  assert.deepEqual(parseVersionedFilename('note.md'), { base: 'note.md', version: 1, ext: '.md' })
})

// --- reviews ----------------------------------------------------------------

test('a review hydrates weak points, recurring mistakes and goals from the learning state', async () => {
  const f = await fixture({ defaultFormat: 'markdown' })
  await writeFixture(f.home, 'term/.professor/state/courses/csc3200/PROGRESS.md', `# 1. Current Position

**Current Unit:** Unit 3
**Recommended Next Step:** 重做第三次作业

# 3. Topics Needing Review

| Topic | Reason | Priority |
| --- | --- | --- |
| 递归 | 边界条件总写错 | high |

# 4. Current Learning Goals

- 完成图论部分
`)
  await writeFixture(f.home, 'term/.professor/state/courses/csc3200/MISTAKES.md', `# 1. Active Mistakes

## 递归深度
写递归时忘记 base case。

# 2. Weak Topics

| Topic | Weakness | Recommended Reinforcement |
| --- | --- | --- |
| 递归 | 边界条件 | 重做练习题 3 |

# 3. Requested Deep Dives

| Date | Topic | Question (paraphrased) | Cause of difficulty | Suggested review action |
| --- | --- | --- | --- | --- |
| 2026-01-02 | 红黑树 | 为什么插入需要旋转 | 不变量不直观 | 画图推导 |
`)
  await writeFixture(f.home, 'term/.professor/state/courses/csc3200/KNOWLEDGE.md', `# 基本概念

## 递归
自己调用自己。

## 不变量
始终为真的性质。
`)

  const result = await f.tools.professor_artifact_create.execute({
    kind: 'review',
    title: 'Midterm Review',
    format: 'markdown',
    confirmed_scope: ['第一到第五章'],
    unconfirmed_scope: ['第六章（教授未确认）'],
  }, f.exec)

  assert.equal(result.created, true)
  const text = await readFile(path.join(f.project, '.professor', 'reviews', 'csc3200', 'midterm-review', 'midterm-review.md'))

  assert.match(text, /^## 已确认考试范围$/m)
  assert.match(text, /^## 未确认范围$/m)
  assert.match(text, /^## 薄弱点$/m)
  assert.match(text, /重做练习题 3/)
  assert.match(text, /^## 反复出错$/m)
  assert.match(text, /递归深度/)
  assert.match(text, /^## 重点与难点$/m)
  assert.match(text, /边界条件总写错/)
  assert.match(text, /^## 深挖主题$/m)
  assert.match(text, /红黑树/)
  assert.match(text, /^## 未解决清单$/m)
  assert.match(text, /- \[ \] 目标尚未完成：完成图论部分/)
  assert.match(text, /- \[ \] 下一步：重做第三次作业/)
  // Concepts recorded in KNOWLEDGE.md become the review's definition list.
  assert.match(text, /^## 必备定义与公式$/m)
  assert.match(text, /\*\*递归\*\*/)
  assert.doesNotMatch(text, /\[object Object\]/, 'hydrated dives must render as text, not as objects')

  assert.equal(REVIEW_SECTIONS.every((name) => typeof name === 'string'), true)
})

test('a review is a distinct artifact with its own root, sections and completeness statement', async () => {
  const f = await fixture({ defaultFormat: 'markdown' })
  const note = await f.tools.professor_artifact_create.execute(richNote({ title: 'A Note' }), f.exec)
  const review = await f.tools.professor_artifact_create.execute({
    kind: 'review', title: 'A Review', format: 'markdown', weak_points: ['递归'],
  }, f.exec)

  assert.equal(note.root, path.join(f.project, '.professor', 'notes'))
  assert.equal(review.root, path.join(f.project, '.professor', 'reviews'))
  assert.notEqual(note.root, review.root, 'a review is not just a note with a different title')

  const fromArguments = await f.tools.professor_artifact_create.execute({
    kind: 'review', title: 'From Arguments', format: 'markdown', from_state: false, weak_points: ['线程'],
  }, f.exec)
  assert.equal(fromArguments.created, true)
  const text = await readFile(path.join(f.project, '.professor', 'reviews', 'csc3200', 'from-arguments', 'from-arguments.md'))
  assert.match(text, /考试复习产物/)
  assert.match(text, /尚未确认的范围/)
  assert.match(text, /线程/)
})

test('a review without any learning state says so instead of inventing one', async () => {
  const f = await fixture({ defaultFormat: 'markdown' })
  const result = await f.tools.professor_artifact_create.execute({
    kind: 'review', title: 'Empty State', format: 'markdown',
  }, f.exec)
  assert.equal(result.created, true)
  assert.ok(result.warnings.some((warning) => /no learning state found/.test(warning)))
  const text = await readFile(path.join(f.project, '.professor', 'reviews', 'csc3200', 'empty-state', 'empty-state.md'))
  assert.doesNotMatch(text, /^## 薄弱点$/m, 'an empty weak-point section is omitted, not shown blank')
})

test('the review renderer is deterministic and omits sections it has nothing to say about', () => {
  const input = {
    title: 'R',
    course: { course_id: 'csc3200' },
    generated_at: '2026-01-01T00:00:00.000Z',
    unconfirmed_scope: ['第六章'],
  }
  const a = renderReview(input)
  const b = renderReview(input)
  assert.equal(a.content, b.content)
  assert.ok(a.sections_rendered.includes('未确认范围'))
  assert.ok(a.sections_omitted.includes('薄弱点'))
})

// --- status -----------------------------------------------------------------

test('artifact status reports roots, configuration source and existing files', async () => {
  const f = await fixture({ notesRoot: 'notes-out', reviewsRoot: 'reviews-out' })
  const notesRoot = path.join(f.project, 'notes-out')
  const reviewsRoot = path.join(f.project, 'reviews-out')

  const empty = await f.tools.professor_artifact_status.execute({}, f.exec)
  assert.equal(empty.projectPresent, true)
  assert.deepEqual(empty.roots.map((root) => root.root), [notesRoot, reviewsRoot])
  assert.deepEqual(empty.roots.map((root) => root.configured), [true, true])
  assert.deepEqual(empty.roots.map((root) => root.present), [false, false])

  await f.tools.professor_artifact_create.execute(richNote({ title: 'Listed' }), f.exec)
  const after = await f.tools.professor_artifact_status.execute({}, f.exec)
  assert.equal(after.roots[0].present, true)
  assert.equal(after.roots[0].file_count, 1)
  assert.deepEqual(after.roots[0].files, ['csc3200/listed/listed.md'])
  assert.equal(after.roots[1].file_count, 0)

  await assert.rejects(f.tools.professor_artifact_status.execute({ course: 'gfw1000' }, f.exec),
    { code: 'PROFESSOR_COURSE_MISSING' }, 'an unknown course must not silently select a destination')

  const single = await f.tools.professor_artifact_status.execute({ kind: 'review' }, f.exec)
  assert.equal(single.roots.length, 1)
  assert.equal(single.roots[0].kind, 'review')
})

test('an unbound session must name a course rather than guessing one', async () => {
  const f = await fixture({ bind: false, defaultFormat: 'markdown' })
  await assert.rejects(
    () => f.tools.professor_artifact_create.execute(richNote(), f.exec),
    (error) => error.code === 'PROFESSOR_STATE_COURSE_REQUIRED',
  )
  const explicit = await f.tools.professor_artifact_create.execute(richNote({ course: 'csc3200' }), f.exec)
  assert.equal(explicit.created, true)
  assert.equal(explicit.course_id, 'csc3200')
})

test('artifact status is refused when the project document is unusable', async () => {
  const f = await fixture()
  await writeFixture(f.home, 'term/.professor/project.yaml', 'schema_version: 99\nproject:\n  id: future\n')
  await assert.rejects(
    () => f.tools.professor_artifact_status.execute({}, f.exec),
    (error) => error.code === 'PROFESSOR_PROJECT_UNSUPPORTED',
  )
})
