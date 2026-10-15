/**
 * Serve the **packaged** Professor bundle in a disposable Harness profile, for the browser run.
 *
 * Why this exists: `tools/verify-home.mjs` drives the host from Node, which proves routing and
 * orchestration but not that a *browser* renders Professor Home. This script is the other half — it
 * boots the same disposable profile, starts the real web plane on a fixed port, prints the
 * authenticated URL, and stays up until it is killed.
 *
 * It is deliberately a *server*, not a verifier: a browser run needs a human (or a browser agent) to
 * look at the page, and that step cannot be asserted from inside this process.
 *
 * Usage:
 *
 *   ELECTRON_RUN_AS_NODE=1 "<harness>" tools/serve-home.mjs
 *
 * Everything lives under a fresh `DSH_HOME` in the OS temp directory; the real desktop profile is
 * never read for credentials and never written.
 *
 * @module dsh-professor-spike/tools/serve-home
 */

import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { promises as fs, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { bootProfessorProfile, createProfessorProfile, PACKAGE_NAME } from './packaged-profile.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PROFESSOR_HOME_PORT ?? 8787)
const PROFILE_NAME = 'professor-home-browser'

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-serve-'))
const npmCache = await fs.mkdtemp(path.join(os.tmpdir(), 'professor-serve-npm-'))
const childEnv = { ...process.env, npm_config_cache: npmCache, DSH_TELEMETRY_DISABLED: '1' }
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', env: childEnv, ...options })

let home
let ctx

async function main() {
  const packed = JSON.parse(run('npm', ['pack', '--pack-destination', temp, '--json'], { cwd: REPO }))
  const tarball = path.join(temp, packed[0].filename)
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-professor-serve-'))
  process.env.DSH_HOME = home
  const workspace = await fs.mkdtemp(path.join(home, 'workspace-'))
  await createProfessorProfile({ home, profileName: PROFILE_NAME, tarball, run })

  const booted = await bootProfessorProfile({ home, profileName: PROFILE_NAME, workspace, port: PORT })
  ctx = booted.ctx

  const port = ctx.get('webServer')?.port ?? PORT
  const connection = ctx.get('connection')
  const base = `http://127.0.0.1:${port}/`
  const url = typeof connection?.authenticatedUrl === 'function' ? connection.authenticatedUrl(base) : base

  writeFileSync(path.join(temp, 'url.txt'), `${url}\n`, 'utf8')
  console.log(`PROFESSOR_HOME_URL=${url}`)
  console.log(`PROFESSOR_HOME_HOME=${home}`)
  console.log(`serving ${PACKAGE_NAME}; press Ctrl-C to stop`)
}

const shutdown = async () => {
  try { await ctx?.fiber?.dispose?.() } catch { /* best effort */ }
  try { if (home !== undefined) await fs.rm(home, { recursive: true, force: true }) } catch { /* best effort */ }
  for (const dir of [temp, npmCache]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await main()
// Keep the process (and therefore the web plane) alive until it is stopped explicitly.
setInterval(() => {}, 1000)
