import path from 'node:path'
import { isInside } from '../paths/policy.js'
import { createPreparationService } from './prepare.js'
import { createEnhancementService } from './enhance.js'
import { createExtractionService } from '../extract/runner.js'

/** Workspace-scoped runtime; source authorization precedes this setup-only download seam. */
export function createMaterialRuntime({ pluginRoot, shellRun, gateway, extraction, enhancement, configured = false }) {
  const prepare = createPreparationService({ pluginRoot, shellRun })
  const runtimes = new Map()
  const active = new Map()
  async function runtimeFor({ workspace, action, extension, signal }) {
    await extraction.ensureProbed(signal)
    const target = await gateway.resolveTarget(workspace, { signal })
    const canonical = gateway.canonical(target)
    const existing = runtimes.get(canonical)
    if (existing) return existing
    if (configured || extension !== 'pdf' || (action !== 'enhance' && extraction.capabilities.pdfInterpreter)) {
      return { ...extraction, enhance: enhancement.run }
    }
    if (active.has(canonical)) return active.get(canonical)
    const pending = (async () => {
      const cache = await gateway.resolveTarget(path.join(canonical, '.professor-cache', 'enhance'), { signal })
      const destination = gateway.canonical(cache)
      if (!isInside(canonical, destination)) throw new Error('enhancement cache escapes the workspace')
      enhancement.info.last_status = 'preparing'
      const prepared = await prepare({ workspace: canonical, destination,
        basePython: extraction.capabilities.bootstrapInterpreter,
        platform: `${process.platform}-${process.arch}`, signal })
      if (prepared.status !== 'prepared') {
        enhancement.info.last_status = 'unavailable'
        return { ...extraction, enhance: async () => ({ ...prepared, pages: [] }) }
      }
      const reader = createExtractionService({ pluginRoot, shellRun, env: { ...process.env, DSH_PROFESSOR_PYTHON: prepared.python } })
      await reader.ensureProbed(signal)
      const engine = createEnhancementService({ pluginRoot, shellRun, python: prepared.python, artifactsPath: prepared.artifacts, backend: prepared.backend })
      Object.assign(enhancement.info, { configured: true, auto_provisioned: true, backend: prepared.backend, last_status: 'prepared' })
      const runtime = { ...reader, enhance: engine.run, dispose: engine.dispose }
      runtimes.set(canonical, runtime)
      return runtime
    })()
    active.set(canonical, pending)
    try { return await pending } finally { active.delete(canonical) }
  }
  return { runtimeFor, dispose() { for (const runtime of runtimes.values()) runtime.dispose(); runtimes.clear() } }
}
