import path from 'node:path'

/** Optional local enhancement. No implicit downloads or material uploads. */
export function createEnhancementService({ pluginRoot, shellRun, python, artifactsPath, backend = 'docling' }) {
  const cache = new Map()
  const info = { configured: Boolean(python), backend, local_only: true, max_pages: 6,
    auto_provisioned: false, last_status: 'not-run' }
  const finish = result => { info.last_status = result.status; return result }
  return {
    info,
    async run({ sourcePath, spelling = sourcePath, pages, sourceHash, readPolicy, signal }) {
      readPolicy.assert(spelling, sourcePath)
      if (signal?.aborted) throw new Error('material enhancement cancelled')
      if (!Array.isArray(pages) || pages.length === 0 || pages.length > 6
        || pages.some(p => !Number.isInteger(p) || p < 1) || new Set(pages).size !== pages.length) {
        throw new Error('enhancement requires one to six distinct positive page numbers')
      }
      if (!python || typeof shellRun !== 'function') return finish({ status: 'unavailable', pages: [],
        reason: 'the local enhancement runtime is not prepared; no OCR or enhanced parsing ran' })
      const key = JSON.stringify([sourcePath, sourceHash, pages, python, backend, artifactsPath])
      if (sourceHash && cache.has(key)) return finish({ ...cache.get(key), cache: 'hit' })
      const args = [path.join(pluginRoot, 'src/extract/scripts/enhance_pdf.py'), '--path', sourcePath,
        '--pages', pages.join(','), '--backend', backend]
      if (artifactsPath) args.push('--artifacts', artifactsPath)
      const run = await shellRun({ command: python, args, timeoutMs: 120000, signal,
        captureBytes: 4 * 1024 * 1024, stdoutMaxBytes: 4 * 1024 * 1024 })
      if (signal?.aborted) throw new Error('material enhancement cancelled')
      if (run.runnerFailed || run.timedOut || run.aborted || run.stdoutTruncated || run.exitCode !== 0) {
        return finish({ status: 'failed', pages: [], reason: run.reason ?? 'enhancement failed, timed out, was cancelled or exceeded the output budget' })
      }
      let output
      try { output = JSON.parse(run.stdout) } catch { return finish({ status: 'failed', pages: [], reason: 'enhancement returned malformed JSON' }) }
      if (output.ok !== true) return finish({ status: output.error === 'unavailable' ? 'unavailable' : 'failed', pages: [], reason: String(output.detail ?? output.error) })
      if (!Array.isArray(output.pages) || output.pages.length !== pages.length
        || new Set(output.pages.map(p => p.page)).size !== pages.length
        || output.pages.some(p => !pages.includes(p.page) || typeof p.text !== 'string')) {
        return finish({ status: 'failed', pages: [], reason: 'enhancement did not return exactly the requested physical pages' })
      }
      const result = { status: 'enhanced', backend: output.backend, versions: output.versions,
        pages: output.pages, warnings: output.warnings ?? [], cache: 'miss' }
      if (sourceHash) {
        cache.set(key, result)
        // Bound total retained serialized results, not just the number of documents.
        while (cache.size > 16 || [...cache.values()].reduce((n, v) => n + JSON.stringify(v).length, 0) > 8 * 1024 * 1024) cache.delete(cache.keys().next().value)
      }
      return finish(result)
    },
    dispose() { cache.clear() },
  }
}
