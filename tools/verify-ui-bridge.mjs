/** Disposable official Remote feasibility probe. No product routes or real profile writes. */
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { bootProfessorProfile, createProfessorProfile } from './packaged-profile.mjs'

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'professor-ui-bridge-')))
const previousHome = process.env.DSH_HOME
const previousTelemetry = process.env.DSH_TELEMETRY_DISABLED
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_DISABLED = '1'
let ctx
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options, encoding: 'utf8',
    env: { ...process.env, npm_config_cache: path.join(home, 'npm-cache') },
  })
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout || result.error}`)
  return result.stdout
}
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', home], { cwd: repo }))[0]
  await createProfessorProfile({ home, profileName: 'bridge-probe', tarball: path.join(home, packed.filename), run })
  const workspace = path.join(home, 'workspace')
  await fs.mkdir(workspace)
  ;({ ctx } = await bootProfessorProfile({ home, profileName: 'bridge-probe', workspace }))
  const scope = ctx.extend()
  const service = {
    echo(request) { return { text: request.text } },
  }
  service.typertRemote = Object.freeze({ service, serviceKey: 'professorBridgeProbe', namespace: 'professorProbe' })
  scope.provide('professorBridgeProbe', service)
  const codec = {
    mode: 'strict', typeSymbol: 'professor-ui-probe#Echo',
    create: () => ({
      parse(value) {
        if (!value || typeof value !== 'object' || Object.keys(value).length !== 1
          || typeof value.text !== 'string' || value.text.length > 80) throw new TypeError('Expected bounded echo text')
        return { text: value.text }
      },
    }),
  }
  const descriptor = {
    id: 'professor-ui-probe#echo', service: 'professorBridgeProbe', namespace: 'professorProbe',
    method: 'echo', invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec }], result: codec,
  }
  const withdraw = scope.get('typert').register({ package: 'professor-ui-probe', face: 'host', schemas: [], invocations: [descriptor] })
  const gateway = ctx.get('typertGateway')
  assert.ok(gateway, 'real host gateway is composed')
  assert.deepEqual(await gateway.invoke({ namespace: 'professorProbe', method: 'echo', args: { request: { text: 'Professor' } } }), { text: 'Professor' })
  console.log('PASS official gateway dispatches a package-owned strict Remote contribution')
  await assert.rejects(gateway.invoke({ namespace: 'professorProbe', method: 'echo', args: { request: { text: 'Professor', messages: [] } } }))
  console.log('PASS strict codec rejects unexpected conversation payload')
  await withdraw()
  await assert.rejects(gateway.invoke({ namespace: 'professorProbe', method: 'echo', args: { request: { text: 'Professor' } } }))
  console.log('PASS withdrawn endpoint cannot fall back to an unregistered method')
  console.log('UNVERIFIED browser Remote mount, transport access control, Home registration and navigation')
} finally {
  try {
    await ctx?.fiber.dispose()
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousTelemetry === undefined) delete process.env.DSH_TELEMETRY_DISABLED
    else process.env.DSH_TELEMETRY_DISABLED = previousTelemetry
    await fs.rm(home, { recursive: true, force: true })
  }
}
