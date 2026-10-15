import path from 'node:path'
import { isInside } from '../paths/policy.js'

export function createPreparationService({ pluginRoot, shellRun }) {
  const active = new Map()
  return async function prepare({ workspace, destination, basePython, platform, signal }) {
    if (!isInside(workspace, destination) || workspace === destination) throw new Error('enhancement preparation must stay inside the workspace cache')
    if (!['darwin-arm64','darwin-x64','linux-arm64','linux-x64','win32-arm64','win32-x64'].includes(platform)) return { status: 'unavailable', reason: 'unsupported runtime platform' }
    if (!basePython || !shellRun) return { status: 'unavailable', reason: 'no usable host Python or shell is available for runtime preparation' }
    if (signal?.aborted) throw new Error('runtime preparation cancelled')
    const id = `${destination}:${platform}`
    if (active.has(id)) return active.get(id)
    const operation = (async () => {
      const result = await shellRun({ command: basePython, args: [path.join(pluginRoot, 'src/extract/scripts/prepare_enhance.py'),
        '--root', destination, '--lock', path.join(pluginRoot, 'resources/enhance/requirements', `${platform}.lock`),
        '--manifest', path.join(pluginRoot, 'resources/enhance/models.json'), '--platform', platform],
        workdir: workspace, signal, timeoutMs: 600000, captureBytes: 64000, stdoutMaxBytes: 64000 })
      if (signal?.aborted) throw new Error('runtime preparation cancelled')
      if (result.exitCode !== 0 || result.runnerFailed || result.timedOut || result.stdoutTruncated) return { status: 'unavailable', reason: 'automatic preparation failed or timed out; no environment was activated' }
      let parsed
      try { parsed = JSON.parse(result.stdout) } catch { return { status: 'unavailable', reason: 'preparation returned invalid JSON' } }
      if (!parsed.ok) return { status: 'unavailable', reason: String(parsed.detail ?? 'preparation failed') }
      if (!isInside(destination, parsed.python) || !isInside(destination, parsed.artifacts)) return { status: 'unavailable', reason: 'prepared runtime escaped its cache root' }
      return { status: 'prepared', python: parsed.python, artifacts: parsed.artifacts, backend: 'pdfium' }
    })()
    active.set(id, operation)
    try { return await operation } finally { active.delete(id) }
  }
}
