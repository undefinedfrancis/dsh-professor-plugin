/**
 * Path policy and root resolution tests.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createPathPolicy, hasTraversal, isInside } from '../src/paths/policy.js'
import {
  allowedRoots, parsePathsFile, resolveProjectRoot, resolveRootVariables, substituteRoots,
} from '../src/paths/roots.js'
import { makeExec, makeHome } from './helpers/fake-harness.mjs'

test('isInside handles nested, sibling and prefix-trap paths', () => {
  assert.equal(isInside('/a/b', '/a/b'), true)
  assert.equal(isInside('/a/b', '/a/b/c'), true)
  assert.equal(isInside('/a/b', '/a/bc'), false, 'prefix must not count as containment')
  assert.equal(isInside('/a/b', '/a'), false)
  // `path.relative` does not normalize dot segments, and `/a/../b` resolves to `/b`, so this is
  // genuinely outside. Traversal *spellings* are rejected earlier by `hasTraversal`.
  assert.equal(isInside('/a/b', '/a/../b'), false)
})

test('hasTraversal detects escape spellings', () => {
  assert.equal(hasTraversal('../../etc/passwd'), true)
  assert.equal(hasTraversal('a/../b'), true)
  assert.equal(hasTraversal('a/b/c.md'), false)
})

test('path policy allows only configured roots and rejects traversal spellings', () => {
  const policy = createPathPolicy({ roots: ['/project/.professor'], label: 'write' })

  assert.deepEqual(policy.check('/project/.professor/indexes/files.json', '/project/.professor/indexes/files.json'), { ok: true })

  const outside = policy.check('/project/01_Lectures/x.pdf', '/project/01_Lectures/x.pdf')
  assert.equal(outside.ok, false)
  assert.match(outside.reason, /outside every allowed write root/)

  const traversal = policy.check('../../etc/passwd', '/etc/passwd')
  assert.equal(traversal.ok, false)
  assert.match(traversal.reason, /"\.\." segment/)

  const relative = policy.check('x', 'x')
  assert.equal(relative.ok, false)
  assert.match(relative.reason, /absolute/)
})

test('path policy fails closed when no roots are configured', () => {
  const policy = createPathPolicy({ roots: [], label: 'write' })
  const result = policy.check('/anything', '/anything')
  assert.equal(result.ok, false)
  assert.match(result.reason, /no write roots/)
})

test('path policy assert throws a coded error', () => {
  const policy = createPathPolicy({ roots: ['/project/.professor'], label: 'write' })
  assert.throws(
    () => policy.assert('/project/notes/x.md', '/project/notes/x.md'),
    (error) => error.code === 'PROFESSOR_PATH_DENIED',
  )
})

test('resolveProjectRoot prefers the environment override, then a genuinely bound session workspace', async () => {
  const home = await makeHome('professor-paths-')
  const workspace = path.join(home, 'course')
  await fs.mkdir(path.join(workspace, '.professor'), { recursive: true })
  const exec = makeExec({ cwd: workspace })

  // An explicit override is authoritative and is not second-guessed against the disk.
  assert.deepEqual(
    await resolveProjectRoot(exec, { env: { DSH_PROFESSOR_PROJECT: '/custom/project' } }),
    { root: '/custom/project', source: 'env:DSH_PROFESSOR_PROJECT', bound: true, reason: null },
  )

  // A workspace holding `.professor/` is the project root (Phase 1: the marker, not the cwd alone).
  assert.deepEqual(
    await resolveProjectRoot(exec, { env: {} }),
    { root: workspace, source: 'session-cwd', bound: true, reason: null },
  )
})

test('resolveProjectRoot reports an unbound workspace instead of claiming it as the project', async () => {
  const home = await makeHome('professor-paths-')
  const loose = path.join(home, 'loose')
  await fs.mkdir(loose, { recursive: true })

  const project = await resolveProjectRoot(makeExec({ cwd: loose }), { env: {} })
  assert.equal(project.root, loose, 'the candidate is reported so a diagnostic can name it')
  assert.equal(project.source, 'session-cwd')
  assert.equal(project.bound, false)
  assert.match(project.reason, /\.professor/)

  // The probe is injectable, so the rule is testable without a real directory.
  const injected = await resolveProjectRoot(makeExec({ cwd: '/srv/courses' }), {
    env: {},
    isDirectory: async (candidate) => candidate === path.join('/srv/courses', '.professor'),
  })
  assert.equal(injected.bound, true)
})

test('resolveProjectRoot refuses to guess without a conversation workspace', async () => {
  await assert.rejects(
    () => resolveProjectRoot({}, { env: {} }),
    /carries no conversation workspace/,
  )
})

test('resolveProjectRoot never falls back to the process working directory', async () => {
  const exec = makeExec({ cwd: undefined })
  await assert.rejects(() => resolveProjectRoot(exec, { env: {} }), /no conversation workspace/)
})

test('parsePathsFile reads the documented table form and plain assignments', () => {
  const table = [
    '| 变量 | 含义 | 本机取值 |',
    '|---|---|---|',
    '| `${PERSONAL_AGENT_ROOT}` | root | `/Users/x/Personal-Agent` |',
    '| `${COURSE_ROOT}` | courses | `/Users/x/Documents/courses` |',
  ].join('\n')
  assert.deepEqual(parsePathsFile(table), {
    PERSONAL_AGENT_ROOT: '/Users/x/Personal-Agent',
    COURSE_ROOT: '/Users/x/Documents/courses',
  })

  assert.deepEqual(parsePathsFile('PROJECTS_ROOT=/srv/projects'), { PROJECTS_ROOT: '/srv/projects' })
  assert.deepEqual(parsePathsFile('COURSE_ROOT: /srv/courses'), { COURSE_ROOT: '/srv/courses' })
})

test('resolveRootVariables applies env > PATHS.md > defaults and leaves the rest unresolved', async () => {
  const home = await makeHome()
  const workspace = path.join(home, 'Personal-Agent')
  const cwd = path.join(home, 'courses', 'term')

  const isDirectory = async (candidate) => candidate === workspace || candidate === path.join(home, 'Documents', 'Project')
  const readText = async (file) => {
    assert.equal(file, path.join(workspace, '00_System', 'PATHS.md'))
    return '| `${PERSONAL_AGENT_ROOT}` | root | `/from/paths/md` |'
  }

  const resolved = await resolveRootVariables({
    cwd,
    env: {},
    isDirectory,
    readText,
    candidates: [{ source: 'legacy-home', path: () => workspace }],
    projectsDefault: path.join(home, 'Documents', 'Project'),
  })
  assert.equal(resolved.workspaceRoot, workspace)
  assert.equal(resolved.workspaceSource, 'legacy-home')
  assert.equal(resolved.roots.PERSONAL_AGENT_ROOT.value, '/from/paths/md')
  assert.equal(resolved.roots.PERSONAL_AGENT_ROOT.source, 'PATHS.md')
  assert.equal(resolved.roots.COURSE_ROOT.value, cwd)
  assert.equal(resolved.roots.COURSE_ROOT.source, 'session-cwd')
  assert.equal(resolved.roots.PROJECTS_ROOT.source, 'default-home')

  const withEnv = await resolveRootVariables({
    cwd,
    env: { COURSE_ROOT: '/env/courses' },
    isDirectory: async () => false,
    readText: async () => { throw new Error('absent') },
  })
  assert.equal(withEnv.roots.COURSE_ROOT.value, '/env/courses')
  assert.equal(withEnv.roots.COURSE_ROOT.source, 'env')
  assert.equal(withEnv.roots.PERSONAL_AGENT_ROOT.value, null)
  assert.equal(withEnv.roots.PERSONAL_AGENT_ROOT.source, 'unresolved')
  assert.equal(withEnv.roots.PROJECTS_ROOT.value, null)
})

test('substituteRoots replaces only resolved variables', () => {
  const content = 'a=${PERSONAL_AGENT_ROOT}/x b=${COURSE_ROOT}/y c=${PROJECTS_ROOT}/z'
  const out = substituteRoots(content, {
    PERSONAL_AGENT_ROOT: { value: '/a' },
    COURSE_ROOT: { value: null },
    PROJECTS_ROOT: { value: '/c' },
  })
  assert.equal(out, 'a=/a/x b=${COURSE_ROOT}/y c=/c/z')
})

test('allowedRoots reads the environment list and de-duplicates', () => {
  const joined = ['/one', '/two', '/one'].join(path.delimiter)
  assert.deepEqual(allowedRoots({ DSH_PROFESSOR_ALLOWED_ROOTS: joined }), ['/one', '/two'])
  assert.deepEqual(allowedRoots({}), [])
})
