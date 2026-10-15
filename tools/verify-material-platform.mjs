/** Six-platform backend acceptance entrypoint. No Harness or paid model calls. */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const platform = process.env.PROFESSOR_ACCEPTANCE_PLATFORM ?? `${process.platform}-${process.arch}`
if (!['darwin-arm64','darwin-x64','linux-arm64','linux-x64','win32-x64','win32-arm64'].includes(platform)) throw new Error('unsupported platform')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-platform-'))
const report = { platform, node_arch: process.arch, model_requests: 0, complete: false, tests: [] }
try {
  const bootstrap = process.env.PROFESSOR_BOOTSTRAP_PYTHON
  if (!bootstrap) throw new Error('acceptance requires an explicit Python 3.12 bootstrap')
  const prepareArgs = ['src/extract/scripts/prepare_enhance.py', '--root', root, '--lock', `resources/enhance/requirements/${platform}.lock`, '--manifest', 'resources/enhance/models.json', '--platform', platform]
  const setup = JSON.parse(execFileSync(bootstrap, prepareArgs, { encoding: 'utf8', timeout: 600000, maxBuffer: 4 * 1024 * 1024 }))
  if (!setup.ok) throw new Error(setup.detail)
  report.tests.push({ name: 'first-use-preparation', pass: true })
  const env = { ...process.env, DSH_PROFESSOR_ENHANCE_PYTHON: setup.python, DSH_PROFESSOR_ENHANCE_BACKEND: 'pdfium', DSH_PROFESSOR_ENHANCE_ARTIFACTS: setup.artifacts }
  execFileSync(process.execPath, ['--test', 'test/material-enhance-production.test.mjs', 'test/material-platform.test.mjs'], { env, stdio: 'inherit', timeout: 300000 })
  report.tests.push({ name: 'real-scanned-text-table-and-physical-page', pass: true })
  const warm = JSON.parse(execFileSync(bootstrap, prepareArgs, { encoding: 'utf8', timeout: 60000 }))
  if (!warm.ok || warm.python !== setup.python) throw new Error('prepared cache was not reused')
  report.tests.push({ name: 'verified-cache-reuse', pass: true })
  report.complete = true
} catch (error) { report.error = String(error.message).slice(0, 2000); process.exitCode = 1 }
finally {
  await fs.writeFile('material-platform-report.json', JSON.stringify(report, null, 2))
  await fs.rm(root, { recursive: true, force: true })
}
