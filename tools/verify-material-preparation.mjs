/** Installed native-host first-use setup acceptance; no model calls or user material. */
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createProfessorProfile, bootProfessorProfile, createNativeSession, selectPreset, executeTool } from './packaged-profile.mjs'
if (!process.argv.includes('--allow-runtime-downloads')) throw new Error('setup downloads require --allow-runtime-downloads')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-native-prepare-'))
const output = process.env.PROFESSOR_PREPARATION_REPORT ?? path.join(os.tmpdir(), 'professor-native-preparation.json')
const fixturePython = process.env.DSH_PROFESSOR_ENHANCE_PYTHON
if (!fixturePython) throw new Error('a fixture generator interpreter is required for acceptance only')
const report = { complete: false, model_requests: 0, platform: `${process.platform}-${process.arch}`, tests: [] }
let ctx
try {
  const run = (command, args, options = {}) => execFileSync(command, args, { ...options, env: { ...process.env, npm_config_cache: path.join(temp, 'npm-cache') }, stdio: 'pipe', timeout: 120000 })
  run('npm', ['pack', '--pack-destination', temp], { cwd: root })
  const tarball = path.join(temp, (await fs.readdir(temp)).find(file => file.endsWith('.tgz')))
  await createProfessorProfile({ home: temp, profileName: 'material-prepare', tarball, run })
  const workspace = path.join(temp, 'synthetic-material')
  await fs.mkdir(workspace)
  run(fixturePython, [path.join(root, 'test/helpers/material-enhance-fixtures.py'), '--out', workspace])
  // Exercise default shipped configuration, not the acceptance machine's prepared override.
  delete process.env.DSH_PROFESSOR_PYTHON
  delete process.env.DSH_PROFESSOR_ENHANCE_PYTHON
  delete process.env.DSH_PROFESSOR_ENHANCE_ARTIFACTS
  const boot = await bootProfessorProfile({ home: temp, profileName: 'material-prepare', workspace })
  ctx = boot.ctx
  const { agent } = await createNativeSession({ ctx, sessionId: path.basename(temp), workspace })
  await selectPreset({ ctx, agent })
  const source = path.join(workspace, 'scanned.pdf')
  const before = await fs.readFile(source)
  for (const label of ['first-use', 'repeat-use']) {
    const result = await executeTool({ ctx, agent, name: 'professor_material_read', args: { action: 'enhance', path: source, pages: [1] }, label })
    const body = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    report.tests.push({ name: label, pass: !result.isError && /Scanned OCR source text/.test(body) && /扫描件/.test(body), result: body.slice(0, 24000) })
  }
  report.tests.push({ name: 'source-unchanged', pass: before.equals(await fs.readFile(source)) })
  report.complete = report.tests.every(test => test.pass)
} catch (error) { report.error = String(error.message).slice(0, 1500) }
finally {
  await fs.writeFile(output, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ complete: report.complete, model_requests: 0, report: output }))
  await Promise.race([ctx?.fiber?.dispose?.(), new Promise(resolve => setTimeout(resolve, 5000))])
  await fs.rm(temp, { recursive: true, force: true })
}
if (!report.complete) process.exitCode = 1
