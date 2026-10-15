/** Packed real-host skill overlay acceptance. --restore runs in a distinct host process. No model. */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { PACKAGE_NAME, HARNESS_BIN, bootProfessorProfile, createProfessorProfile, executeTool, resultJson } from './packaged-profile.mjs'
import { courseMemoryNamespace } from '../src/memory/store.js'
import { composeSkill } from '../src/skills/compose.js'
import { parseYamlLite } from '../src/project/yaml-lite.js'

const profileName = 'professor-customization'
const skill = 'professor-study'
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const restored = process.argv.includes('--restore')
let ctx, temporary
async function digest(directory) {
  const rows = []
  async function visit(current, relative = '') {
    let entries
    try { entries = await fs.readdir(current, { withFileTypes: true }) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.join(relative, entry.name), full = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(full, rel)
      else if (entry.isSymbolicLink()) rows.push([rel, await fs.readlink(full)])
      else if (entry.isFile()) rows.push([rel, createHash('sha256').update(await fs.readFile(full)).digest('hex')])
    }
  }
  await visit(directory)
  return JSON.stringify(rows)
}
function pass(label) { console.log(`PASS  ${label}`) }
async function load(agent) {
  const definition = await ctx.get('skills').get(skill, { scope: agent, cwd: agent.session.header.cwd })
  assert.ok(definition, 'native scoped skill must resolve')
  return definition.content
}
async function launch(cwd, id, courseId = null) {
  const result = await ctx.get('typertGateway').invoke({ namespace: 'professorHome', method: 'launch',
    args: { request: { requestId: id, mode: 'learn', courseId, topic: null } } })
  assert.equal(result.ok, true)
  const agent = ctx.get('agents').get(result.sessionId)
  assert.equal(agent.session.header.cwd, cwd)
  return agent
}
async function checkedTool(agent, name, args) {
  const result = await executeTool({ ctx, agent, name, args })
  assert.notEqual(result.isError, true, JSON.stringify(resultJson(result)))
  return resultJson(result)
}

try {
  if (restored) {
    const { home, workspace, courseId } = JSON.parse(process.env.PROFESSOR_CUSTOMIZATION_RESTORE)
    process.env.DSH_HOME = home
    ctx = (await bootProfessorProfile({ home, profileName, workspace })).ctx
    const general = await launch(workspace, 'r-111111111111')
    assert.match(await load(general), /teachingDepth: detailed/)
    assert.doesNotMatch(await load(general), /programmingLanguage: C\+\+|explanationStyle: formula intuition/)
    const course = await launch(workspace, 'r-222222222222', courseId)
    assert.match(await load(course), /programmingLanguage: C\+\+/)
    pass('new native sessions in a distinct process restore global and course customization')
  } else {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-customization-'))
    const home = path.join(temporary, 'home'), workspace = path.join(home, 'academic')
    await fs.mkdir(workspace, { recursive: true })
    const realWorkspace = await fs.realpath(workspace)
    const originalHome = process.env.DSH_HOME
    const realProfile = path.join(originalHome ?? path.join(os.homedir(), '.dsh'), 'profiles', 'desktop')
    const profileBefore = await digest(realProfile)
    const skillsBefore = await digest(path.join(repo, 'skills'))
    for (const code of ['CSC3200', 'STA2001']) {
      await fs.mkdir(path.join(realWorkspace, code, 'Lectures'), { recursive: true })
      await fs.writeFile(path.join(realWorkspace, code, 'Lectures', 'intro.md'), `# ${code}\nIntroductory source material.\n`)
    }
    const fixtureBefore = await digest(realWorkspace)
    const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', ...options,
      env: { ...process.env, npm_config_cache: path.join(temporary, 'cache'), DSH_TELEMETRY_DISABLED: '1' } })
    const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary], { cwd: repo }))
    const tarball = path.join(temporary, packed[0].filename)
    const { installedDir } = await createProfessorProfile({ home, profileName, tarball, run })
    assert.equal(await digest(path.join(installedDir, 'skills')), skillsBefore)
    process.env.DSH_HOME = home
    ctx = (await bootProfessorProfile({ home, profileName, workspace: realWorkspace })).ctx
    const general = await launch(realWorkspace, 'r-333333333333')
    const discovery = await checkedTool(general, 'professor_workspace_discover', { folder: realWorkspace })
    const confirmation = await checkedTool(general, 'professor_workspace_confirm', { proposal: discovery.proposal,
      selections: ['CSC3200', 'STA2001'].map(relative_path => ({ relative_path, action: 'include' })) })
    assert.equal(confirmation.applied, true)
    const data = await ctx.get('typertGateway').invoke({ namespace: 'professorHome', method: 'home', args: {} })
    const csc = data.courses.find(course => course.course_code === 'CSC3200')
    const sta = data.courses.find(course => course.course_code === 'STA2001')
    assert.ok(csc && sta)
    const document = await fs.readFile(path.join(realWorkspace, '.professor', 'project.yaml'), 'utf8')
    // Reuse the established project parser; this is a disposable fixture, not a new registry.
    const projectId = parseYamlLite(document).project.id
    assert.ok(projectId, 'fixture project identity must be known')
    const namespace = courseMemoryNamespace(projectId, realWorkspace)
    const store = ctx.get('professorAppStorage').skillCustomization
    assert.ok(store)
    const save = (scope, fields, expectedRevision = 0) => store.update({ skill, scope, fields, expectedRevision, evidence: 'explicit-stable' })
    await save(null, { language: 'Chinese', teachingDepth: 'detailed', programmingLanguage: 'Java' })
    await save({ namespace, courseId: csc.course_id }, { programmingLanguage: 'C++' })
    await save({ namespace, courseId: sta.course_id }, { explanationStyle: 'formula intuition' })
    const a = await launch(realWorkspace, 'r-444444444444', csc.course_id)
    const b = await launch(realWorkspace, 'r-555555555555', sta.course_id)
    assert.match(await load(a), /programmingLanguage: C\+\+/)
    assert.match(await load(b), /explanationStyle: formula intuition/)
    assert.doesNotMatch(await load(b), /programmingLanguage: C\+\+/)
    assert.doesNotMatch(await load(general), /explanationStyle: formula intuition|programmingLanguage: C\+\+/)
    assert.match(await load(a), /teachingDepth: detailed/)
    pass('distinct actual native course/global loads compose correctly without cache leakage')
    const scope = { namespace, courseId: csc.course_id }
    const before = await store.read({ skill, scope })
    const ephemeral = composeSkill({ builtIn: await load(a), course: before.fields, session: { programmingLanguage: 'Python' } })
    assert.equal(ephemeral.effective.programmingLanguage, 'Python')
    assert.deepEqual(await store.read({ skill, scope }), before)
    pass('explicit session composition remains ephemeral (no model behavior claimed)')
    await store.reset({ skill, scope, expectedRevision: 1, evidence: 'explicit-stable' })
    assert.match(await load(a), /programmingLanguage: Java/)
    assert.doesNotMatch(await load(a), /programmingLanguage: C\+\+/)
    await save(scope, { programmingLanguage: 'C++' }, 2)
    pass('reset inherits global preferences and same-session reloading is fresh')
    await ctx.fiber.dispose(); ctx = undefined
    const storageFile = path.join(home, 'storages', 'professor_app.json')
    const storedBeforeInstall = await fs.readFile(storageFile, 'utf8')
    // Replace only the validated installed package in this newly created disposable home.
    // Renaming preserves the old copy for diagnosis and forces npm to unpack a new copy.
    await fs.rename(installedDir, path.join(temporary, 'previous-install'))
    run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--save', tarball], {
      cwd: path.join(home, 'profiles', profileName),
    })
    assert.equal(await fs.readFile(storageFile, 'utf8'), storedBeforeInstall)
    assert.equal(await digest(path.join(installedDir, 'skills')), skillsBefore)
    pass('reinstall replaces the package without overwriting user customization storage')
    const output = execFileSync(HARNESS_BIN, [path.join(installedDir, 'tools', 'verify-customization.mjs'), '--restore'], {
      encoding: 'utf8', timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
        PROFESSOR_CUSTOMIZATION_RESTORE: JSON.stringify({ home, workspace: realWorkspace, courseId: csc.course_id }) } })
    assert.match(output, /distinct process restore/)
    console.log(output.trim())
    assert.equal(await digest(path.join(repo, 'skills')), skillsBefore)
    assert.equal(await digest(path.join(installedDir, 'skills')), skillsBefore)
    // Only derived .professor state may have been added; source directories must remain byte-identical.
    const fixtureAfter = JSON.parse(await digest(realWorkspace)).filter(([rel]) => !rel.startsWith('.professor' + path.sep))
    assert.equal(JSON.stringify(fixtureAfter), fixtureBefore)
    assert.equal(await digest(realProfile), profileBefore)
    pass('source materials, bundled skills and real desktop profile remain unchanged')
  }
  console.log('UNVERIFIED  model-driven behavior — no credentials, network or model turn used')
  console.log('ALL PASS')
} finally {
  if (ctx) await ctx.fiber.dispose()
  if (temporary) await fs.rm(temporary, { recursive: true, force: true })
}
