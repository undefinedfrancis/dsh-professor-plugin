/**
 * Fresh-process restore probe — the "shut down and come back" half of packaged acceptance.
 *
 * Why a separate process
 * ----------------------
 * A reopen inside one process cannot tell "the record reached the medium" apart from "the record is
 * still in memory". Only a *new process* booting the same `DSH_HOME` answers the question the v1
 * brief actually asks: after the host shuts down, does Professor's own storage come back?
 *
 * It boots the real Harness from the **installed** package (never the source checkout), opens the
 * same `professor_app` domain, and then:
 *
 *   - reads every record the previous process persisted and reports them verbatim, so the parent can
 *     compare byte-for-byte rather than trusting a summary;
 *   - writes one fresh record of its own, so the parent can prove this process *also* wrote through
 *     the medium instead of only reading a file.
 *
 * Inputs come from the environment (`PROFESSOR_HOME`, `PROFESSOR_PROFILE`, `PROFESSOR_WORKSPACE`,
 * `PROFESSOR_INSTALLED_DIR`), so the parent controls isolation without command-line parsing. The
 * result is printed as a single `PROFESSOR_RESTORE_JSON {...}` line.
 *
 * @module dsh-professor-spike/tools/verify-packaged-restore
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootProfessorProfile } from './packaged-profile.mjs'

const HOME = process.env.PROFESSOR_HOME
const PROFILE = process.env.PROFESSOR_PROFILE
const WORKSPACE = process.env.PROFESSOR_WORKSPACE
const INSTALLED_DIR = process.env.PROFESSOR_INSTALLED_DIR
const RECORD_KEY = process.env.PROFESSOR_RECORD_KEY ?? 'acceptance/roundtrip'
const CHILD_KEY = process.env.PROFESSOR_CHILD_KEY ?? 'acceptance/restored-by-child'
const CHILD_TOKEN = process.env.PROFESSOR_CHILD_TOKEN ?? 'child-wrote-this'

const report = { ok: false, stage: 'start', errors: [] }
const fail = (stage, message) => {
  report.stage = stage
  report.errors.push(message)
  console.log(`PROFESSOR_RESTORE_JSON ${JSON.stringify(report)}`)
  process.exit(1)
}

if (HOME === undefined || PROFILE === undefined || WORKSPACE === undefined || INSTALLED_DIR === undefined) {
  fail('arguments', 'PROFESSOR_HOME, PROFESSOR_PROFILE, PROFESSOR_WORKSPACE and PROFESSOR_INSTALLED_DIR are all required')
}

process.env.DSH_HOME = HOME
process.env.DSH_TELEMETRY_DISABLED = '1'

let ctx
try {
  report.stage = 'boot'
  // The installed copy of this package is what runs — proving the artefact, not the checkout.
  const storageModule = await import(pathToFileURL(path.join(INSTALLED_DIR, 'src/app/storage.js')).href)
  const ownPackage = JSON.parse(await fs.readFile(path.join(INSTALLED_DIR, 'package.json'), 'utf8'))

  const booted = await bootProfessorProfile({ home: HOME, profileName: PROFILE, workspace: WORKSPACE })
  ctx = booted.ctx
  report.layers = booted.layers
  report.storageSourceFile = pathToFileURL(path.join(INSTALLED_DIR, 'src/app/storage.js')).pathname

  report.stage = 'open'
  const storage = storageModule.createAppStorage({
    ctx,
    logger: { warn: (message) => report.errors.push(String(message)), info: () => {}, debug: () => {} },
    readVersion: async () => ownPackage.version,
  })
  const opened = await storage.ensureOpen()
  report.status = opened.status
  report.bootstrapped = opened.bootstrapped
  if (opened.status !== 'open') fail('open', `the domain did not open in the fresh process: ${JSON.stringify(opened)}`)

  report.stage = 'read'
  const table = storage.table('app')
  report.record = table.get(RECORD_KEY) ?? null
  report.bootstrapPresent = table.get('bootstrap') !== undefined

  report.stage = 'write'
  await storage.writeRecord(CHILD_KEY, {
    schema: storageModule.APP_RECORD_SCHEMA,
    written_by: 'fresh-process',
    token: CHILD_TOKEN,
    at: new Date().toISOString(),
  })
  report.childRecordWritten = storage.table('app').get(CHILD_KEY)?.token === CHILD_TOKEN

  report.stage = 'close'
  await storage.close()
  report.closedStatus = storage.describe().status
} catch (error) {
  report.errors.push(`${report.stage}: ${error?.message ?? String(error)}`)
} finally {
  if (ctx !== undefined) await ctx.fiber.dispose().catch(() => {})
}

report.ok = report.errors.length === 0 && report.status === 'open' && report.childRecordWritten === true
console.log(`PROFESSOR_RESTORE_JSON ${JSON.stringify(report)}`)
process.exit(report.ok ? 0 : 1)
