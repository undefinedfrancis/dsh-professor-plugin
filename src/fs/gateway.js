/**
 * Filesystem gateway: the only way the plugin touches the disk.
 *
 * Why this module exists
 * ----------------------
 * An earlier revision used raw `node:fs` because a *unstamped* `ctx.fs.writeText` resolves the
 * writable root to the deployment directory and denies everything inside the conversation
 * workspace. That diagnosis was correct but the conclusion was wrong: the fix is to stamp the
 * per-call sandbox policy (`ctx.sandboxPolicy.resolve({ session })`, the 5th positional argument
 * of `writeText`), not to bypass the seam.
 *
 * Verified behaviour this module relies on (DSH 0.2.0-rc.2):
 * - `ctx.fs.resolve(path, {cwd, signal})` -> `{ targetKey, displayPath }`, with `targetKey`
 *   realpath-canonicalized, so symlink escapes collapse before our own checks run.
 * - `writeText(target, content, expected, signal, sandboxPolicy)` creates parent directories
 *   (`writeFileAtomic` calls `mkdir(dirname, {recursive: true})`), publishes atomically, and
 *   implements `createIfAbsent` with a no-replace hard link, so concurrent creators cannot clobber
 *   each other (`FS_NOT_OBSERVED`) and stale writers get `FS_STALE_VERSION`.
 * - Denials surface as `FS_SANDBOX_DENIED`; there is no delete/rename/copy primitive.
 *
 * @module dsh-professor-spike/src/fs/gateway
 */

import { createHash } from 'node:crypto'

/** Write intents understood by the Harness filesystem service. */
export const CREATE_IF_ABSENT = { kind: 'createIfAbsent' }

/** Error code raised by the Harness when the per-call sandbox policy denies a write. */
export const SANDBOX_DENIED = 'FS_SANDBOX_DENIED'

/** Error code raised when a guarded write loses a race or targets a changed file. */
export const STALE_VERSION = 'FS_STALE_VERSION'

/** Error code raised when `createIfAbsent` finds an existing file. */
export const NOT_OBSERVED = 'FS_NOT_OBSERVED'

/**
 * Build the gateway.
 *
 * @param options.ctx - the Cordis plugin context (must expose `fs`).
 * @param options.logger - plugin logger.
 * @returns the gateway surface. Every method fails loudly when the service is missing rather than
 *   silently falling back to the process filesystem.
 */
export function createFsGateway({ ctx, logger }) {
  const service = () => {
    const fs = ctx?.fs
    if (fs === undefined || fs === null) {
      throw new Error('the Harness filesystem service (ctx.fs) is unavailable; refusing to fall back to node:fs')
    }
    return fs
  }

  /** Resolve an optional service without declaring a hard injection (older deployments lack it). */
  const optional = (name) => {
    try {
      if (typeof ctx?.get === 'function') return ctx.get(name)
    } catch {
      // A missing optional service must never break a tool call.
    }
    return ctx?.[name]
  }

  return {
    /** Whether a filesystem service is injected at all. */
    get available() {
      return ctx?.fs !== undefined && ctx?.fs !== null
    },

    /** The deployment's sandbox mode (`undefined` on an unconfined backend). */
    get sandboxMode() {
      return ctx?.fs?.sandboxMode
    },

    /**
     * The per-call sandbox policy for a session.
     *
     * Stamping this on every mutation is what keeps writes inside the conversation workspace and
     * honours an approved escalation. Returns undefined when the policy service is absent, in
     * which case the backend applies its own deployment fallback.
     */
    sessionPolicy(session) {
      const policyService = optional('sandboxPolicy')
      if (typeof policyService?.resolve !== 'function') return undefined
      return policyService.resolve(session === undefined ? {} : { session })
    },

    /** Resolve a caller-supplied path into a Harness target. */
    async resolveTarget(path, options = {}) {
      return service().resolve(path, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    },

    /** Canonical absolute path of a resolved target. */
    canonical(target) {
      const fs = service()
      if (typeof fs.processPath === 'function') return String(fs.processPath(target))
      return String(target?.displayPath)
    },

    /** Target-based containment (`contains(parent, child)`); falls back to canonical strings. */
    containsTarget(parent, child) {
      const fs = service()
      if (typeof fs.contains === 'function') return fs.contains(parent, child)
      return this.canonical(child).startsWith(this.canonical(parent))
    },

    async stat(target, signal) {
      return service().stat(target, signal)
    },

    /**
     * `lstat` semantics: reports `type: 'symlink'` for a symlink instead of its target's type.
     * Used to honour `follow_symlinks: false` during indexing, since `listDir`/`stat` follow
     * symlinks and would otherwise let a link inside the project read outside it.
     */
    async lstat(path, options = {}) {
      const fs = service()
      if (typeof fs.lstat !== 'function') return undefined
      return fs.lstat(path, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    },

    async listDir(target, signal) {
      return service().listDir(target, signal)
    },

    /**
     * Whether a path currently resolves to a directory.
     *
     * Uses the Harness service (never `node:fs`), so registrations and diagnostics validate paths
     * exactly the way the rest of the plugin reads them.
     */
    async isDirectory(path, options = {}) {
      try {
        const target = await this.resolveTarget(path, options)
        const info = await this.stat(target, options.signal)
        return info?.type === 'directory'
      } catch {
        return false
      }
    },

    async readText(target, signal) {
      return service().readText(target, signal)
    },

    async readBytes(target, signal, maxBytes) {
      return service().readBytes(target, signal, maxBytes)
    },

    /** SHA-256 of a file, read through the Harness service (never `node:fs`). */
    async hashFile(target, signal, maxBytes = 32 * 1024 * 1024) {
      const bytes = await this.readBytes(target, signal, maxBytes)
      return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength }
    },

    /**
     * Write a file through the Harness service, after enforcing the plugin's own write policy.
     *
     * @param options.filePath - caller-supplied spelling (used for traversal checks).
     * @param options.content - full new content.
     * @param options.cwd - resolution base (normally the conversation workspace).
     * @param options.session - calling session, used to stamp the sandbox policy.
     * @param options.signal - cancellation.
     * @param options.writePolicy - a `createPathPolicy` instance; required, so a caller cannot
     *   write without declaring its boundary.
     * @param options.expected - explicit write intent; defaults to a guarded intent derived from a
     *   fresh `stat` (absent -> createIfAbsent, present -> replaceIfVersion with that version).
     * @returns `{ path, canonicalPath, operation, version }`.
     */
    async writeFile(options) {
      const {
        filePath, content, cwd, session, signal, writePolicy,
      } = options
      if (writePolicy === undefined || typeof writePolicy.assert !== 'function') {
        throw new Error('refusing to write without a write policy')
      }

      const target = await this.resolveTarget(filePath, { cwd, signal })
      const canonicalPath = this.canonical(target)
      writePolicy.assert(filePath, canonicalPath)

      let expected = options.expected
      if (expected === undefined) {
        const info = await this.stat(target, signal)
        expected = info === undefined
          ? CREATE_IF_ABSENT
          : { kind: 'replaceIfVersion', version: info.version }
      }

      let outcome
      try {
        outcome = await service().writeText(target, content, expected, signal, this.sessionPolicy(session))
      } catch (error) {
        throw this.describeWriteError(error, canonicalPath)
      }

      return {
        path: target.displayPath,
        canonicalPath,
        operation: outcome?.operation ?? 'update',
        version: outcome?.version,
      }
    },

    /** Turn provider errors into messages a model (and a user) can act on. */
    describeWriteError(error, canonicalPath) {
      const code = error?.code
      if (code === SANDBOX_DENIED) {
        const message = `write denied by the Harness sandbox for ${canonicalPath}`
          + ' — the per-call policy does not include this location.'
        logger?.warn(message)
        const wrapped = new Error(message)
        wrapped.code = code
        wrapped.cause = error
        return wrapped
      }
      if (code === STALE_VERSION) {
        const message = `refusing to overwrite ${canonicalPath}: it changed after it was read`
          + ' (concurrent update). Re-read and retry.'
        logger?.warn(message)
        const wrapped = new Error(message)
        wrapped.code = code
        wrapped.cause = error
        return wrapped
      }
      if (code === NOT_OBSERVED) {
        const message = `refusing to create ${canonicalPath}: it already exists`
          + ' (use an explicit overwrite decision).'
        const wrapped = new Error(message)
        wrapped.code = code
        wrapped.cause = error
        return wrapped
      }
      return error
    },
  }
}
