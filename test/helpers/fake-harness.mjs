/**
 * Test harness: a faithful in-process stand-in for the parts of DSH the plugin uses.
 *
 * Fidelity notes (modelled on `@deepseek-ai/dsh-fs-local` + `dsh-fs-sandbox` + `dsh-sandbox-policy`
 * 0.2.0-rc.2):
 * - `resolve` canonicalizes through the deepest existing ancestor (realpath), so symlink escapes
 *   collapse exactly as they do in production;
 * - `target` is `{ targetKey, displayPath }`;
 * - `writeText(target, content, expected, signal, sandboxPolicy)` creates parent directories,
 *   publishes atomically, and enforces: `read-only` denies, `workspace-write` requires containment
 *   in `policy.workspaceRoot` (plus `/tmp`), `createIfAbsent` refuses an existing file
 *   (`FS_NOT_OBSERVED`), `replaceIfVersion` refuses a changed file (`FS_STALE_VERSION`);
 * - denial is `FS_SANDBOX_DENIED`;
 * - `sandboxPolicy.resolve({ session })` returns `{ mode, workspaceRoot, sessionId }`.
 *
 * Everything is backed by a real temporary directory so tests exercise real IO, and every helper
 * refuses to touch anything outside the fixture it created.
 *
 * @module test/helpers/fake-harness
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Error with a Harness `code`, matching `FsError`. */
export function fsError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

async function statLoose(candidate) {
  try {
    return await fs.stat(candidate)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  }
}

/** Canonicalize like the real backend: realpath the deepest existing ancestor, keep the rest. */
export async function canonicalize(candidate) {
  const absolute = path.resolve(candidate)
  let current = absolute
  const missing = []
  for (;;) {
    const info = await statLoose(current)
    if (info !== undefined) {
      const real = await fs.realpath(current)
      return missing.length === 0 ? real : path.join(real, ...missing.reverse())
    }
    const parent = path.dirname(current)
    if (parent === current) return absolute
    missing.push(path.basename(current))
    current = parent
  }
}

function versionOf(info) {
  return createHash('sha256').update(`${info.size}:${info.mtimeMs}`).digest('hex').slice(0, 16)
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * Create a fake filesystem service rooted at a real temporary directory.
 *
 * @param options.home - directory that acts as the "machine" (all sandbox roots live here).
 * @returns the fake `ctx.fs` service.
 */
export function createFakeFs({ home }) {
  const service = {
    sandboxMode: 'workspace-write',

    async resolve(spelling, opts = {}) {
      if (typeof spelling !== 'string' || spelling.trim().length === 0) {
        throw fsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
      }
      const base = opts.cwd ?? home
      const candidate = path.isAbsolute(spelling) ? spelling : path.join(base, spelling)
      const displayPath = path.resolve(candidate)
      const targetKey = await canonicalize(displayPath)
      return { targetKey, displayPath }
    },

    processPath(target) {
      return String(target.targetKey)
    },

    contains(parent, child) {
      return isInside(String(parent.targetKey), String(child.targetKey))
    },

    async stat(target) {
      const info = await statLoose(target.targetKey)
      if (info === undefined) return undefined
      return {
        version: versionOf(info),
        type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
        size: info.size,
      }
    },

    async listDir(target) {
      const info = await statLoose(target.targetKey)
      if (info === undefined) throw fsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      if (!info.isDirectory()) throw fsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
      const entries = await fs.readdir(target.targetKey, { withFileTypes: true })
      const result = []
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const childKey = path.join(target.targetKey, entry.name)
        const childInfo = await statLoose(childKey)
        result.push({
          name: entry.name,
          type: childInfo === undefined ? 'other' : childInfo.isFile() ? 'file' : childInfo.isDirectory() ? 'directory' : 'other',
          target: { targetKey: childKey, displayPath: path.join(target.displayPath, entry.name) },
          ...(childInfo === undefined ? {} : { version: versionOf(childInfo), size: childInfo.size }),
        })
      }
      return result
    },

    async lstat(spelling, opts = {}) {
      const base = opts.cwd ?? home
      const candidate = path.isAbsolute(spelling) ? spelling : path.join(base, spelling)
      let info
      try {
        info = await fs.lstat(candidate)
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
        throw error
      }
      const type = info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
      return { version: versionOf(info), type, size: info.size }
    },

    async readText(target) {
      return fs.readFile(target.targetKey, 'utf8')
    },

    async readBytes(target, _signal, maxBytes) {
      const bytes = await fs.readFile(target.targetKey)
      if (typeof maxBytes === 'number' && bytes.byteLength > maxBytes) {
        throw fsError(`cannot read "${target.displayPath}": too large`, 'FS_TOO_LARGE')
      }
      return bytes
    },

    async writeText(target, content, expected, _signal, sandboxPolicy) {
      const policy = sandboxPolicy ?? { mode: 'workspace-write', workspaceRoot: home }
      const canonical = await canonicalize(target.targetKey)
      if (policy.mode === 'read-only') {
        throw fsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
      }
      if (policy.mode === 'workspace-write') {
        const roots = [policy.workspaceRoot, '/tmp', os.tmpdir()].map((entry) => path.resolve(entry))
        if (!roots.some((root) => isInside(root, canonical))) {
          throw fsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
        }
      }

      const existing = await statLoose(canonical)
      if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
        throw fsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (existing === undefined) throw fsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        if (versionOf(existing) !== expected.version) {
          throw fsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      }

      await fs.mkdir(path.dirname(canonical), { recursive: true })
      const temporary = `${canonical}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
      await fs.writeFile(temporary, content, 'utf8')
      await fs.rename(temporary, canonical)
      const after = await fs.stat(canonical)
      return {
        operation: existing === undefined ? 'create' : 'update',
        version: versionOf(after),
        before: null,
        after: content,
      }
    },
  }
  return service
}

/** Create a fake `ctx.sandboxPolicy`. */
export function createFakeSandboxPolicy({ home, mode = 'workspace-write', fallbackRoot }) {
  return {
    defaultMode: mode,
    resolve(request = {}) {
      const session = request.session
      return {
        mode: request.mode ?? mode,
        workspaceRoot: path.resolve(session?.header?.cwd ?? fallbackRoot ?? home),
        ...(session === undefined ? {} : { sessionId: session.id }),
      }
    },
  }
}

/**
 * Deterministic `fs.watch` stand-in.
 *
 * A real directory watch costs one descriptor per mounted plugin instance, which makes otherwise
 * hermetic tests depend on the host's descriptor budget and leaks a watcher whenever a test does
 * not dispose its context. This stub records its listeners and its close state, so a test can
 * drive change events and assert teardown without ever touching the OS.
 *
 * @returns `{ watchFn, stats, emit }` where `stats.opened/closed/listeners` are live counters.
 */
export function createDeterministicWatch() {
  const stats = { opened: 0, closed: 0, listeners: [] }
  const watchFn = (_dir, _options, listener) => {
    stats.opened += 1
    stats.listeners.push(listener)
    let closed = false
    return {
      on() { return this },
      close() { if (!closed) { closed = true; stats.closed += 1 } },
    }
  }
  return { watchFn, stats, emit: (index = 0) => { stats.listeners[index]?.() } }
}

/**
 * Build a fake Cordis context.
 *
 * @param options.home - machine root for the fake filesystem.
 * @param options.mode - sandbox mode (default workspace-write).
 * @param options.services - extra services for `ctx.get(name)`.
 * @returns `{ ctx, pluginConfig, watch, tools, providers, logs, fs, sandboxPolicy, disposeAll }`.
 *   Pass `pluginConfig` as the second argument to `apply()` so the plugin mounts a deterministic
 *   watcher instead of opening a real directory watch.
 */
export function createFakeContext(options = {}) {
  const home = options.home
  const fs = createFakeFs({ home })
  const sandboxPolicy = createFakeSandboxPolicy({ home, mode: options.mode ?? 'workspace-write' })
  const tools = []
  const providers = []
  const logs = { info: [], warn: [] }
  const disposers = []
  const watch = createDeterministicWatch()

  const services = {
    sandboxPolicy,
    ...(options.services ?? {}),
  }

  const ctx = {
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
      debug: () => {},
    },
    tools: { register: (tool) => tools.push(tool) },
    skills: { registerProvider: (create) => providers.push(create) },
    fs,
    get: (name) => services[name],
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
  }

  return {
    ctx,
    pluginConfig: { watchFn: watch.watchFn },
    watch,
    tools,
    providers,
    logs,
    fs,
    sandboxPolicy,
    disposeAll: () => disposers.forEach((dispose) => dispose()),
  }
}

/**
 * A **real** shell seam stand-in.
 *
 * Unlike every other helper here, this one deliberately does not simulate: it executes the command
 * through `/bin/sh -c`, exactly as the installed `dsh-bash-local` executor runs `bash -c`, and
 * projects the same `ShellRunResult` shape the real seam returns (`exitCode`, `signal`, `timedOut`,
 * `aborted`, `timeoutMs`, `stdout`/`stderr` with `truncated`, plus an optional `sandbox` block).
 *
 * It exists so the extraction integration tests can drive the *actual* Ghostscript and the
 * *actual* bundled Python interpreter. A production integration test that only ever ran against a
 * mock would prove nothing about the backend, which is precisely the failure mode the plugin's
 * capability rule is meant to prevent — so the mock is reserved for contract tests, and this seam
 * is used wherever the claim is "this really extracts a PDF".
 *
 * It is still bounded: a per-call timeout kills the process, output is capped, and the caller's
 * abort signal is honoured.
 *
 * @param options.cwd - default working directory.
 * @param options.timeoutMs - default and maximum deadline (default 30s).
 * @param options.stdoutMaxBytes - default and maximum capture per stream (default 8 MiB).
 * @param options.env - environment (defaults to `process.env`).
 * @returns `{ resolve, execute, calls }` where `calls` records every command line it ran.
 */
export function createFakeShell(options = {}) {
  const defaultCwd = options.cwd ?? process.cwd()
  const maxTimeoutMs = options.timeoutMs ?? 30_000
  const maxBytes = options.stdoutMaxBytes ?? 8 * 1024 * 1024
  const env = options.env ?? process.env
  const calls = []

  return {
    calls,
    resolve(request = {}) {
      const timeoutMs = Number.isInteger(request.timeoutMs) && request.timeoutMs > 0
        ? Math.min(request.timeoutMs, maxTimeoutMs)
        : maxTimeoutMs
      return {
        command: String(request.command ?? ''),
        workdir: typeof request.workdir === 'string' && request.workdir.length > 0 ? request.workdir : defaultCwd,
        timeoutMs,
        onExpiry: request.onExpiry ?? 'kill',
        stdoutMaxBytes: Number.isInteger(request.stdoutMaxBytes) && request.stdoutMaxBytes > 0
          ? Math.min(request.stdoutMaxBytes, maxBytes)
          : maxBytes,
      }
    },

    async execute(spec) {
      calls.push(spec.command)
      const signal = spec.signal
      if (signal?.aborted === true) {
        return { result: async () => ({ exitCode: null, signal: 'SIGTERM', timedOut: false, aborted: true, timeoutMs: spec.timeoutMs, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }) }
      }

      const child = spawn('/bin/sh', ['-c', spec.command], {
        cwd: spec.workdir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const capture = { out: '', err: '', outTruncated: false, errTruncated: false }
      const collect = (channel, chunk) => {
        const key = channel === 'stdout' ? 'out' : 'err'
        const flag = channel === 'stdout' ? 'outTruncated' : 'errTruncated'
        if (capture[key].length >= spec.stdoutMaxBytes) {
          capture[flag] = true
          return
        }
        capture[key] += chunk.toString('utf8')
        if (capture[key].length > spec.stdoutMaxBytes) {
          capture[key] = capture[key].slice(0, spec.stdoutMaxBytes)
          capture[flag] = true
        }
      }
      child.stdout.on('data', (chunk) => collect('stdout', chunk))
      child.stderr.on('data', (chunk) => collect('stderr', chunk))

      let timedOut = false
      let aborted = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, spec.timeoutMs)
      const onAbort = () => {
        aborted = true
        child.kill('SIGKILL')
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })

      const settled = new Promise((resolve) => {
        child.on('error', () => resolve({ code: null, signal: 'SIGKILL' }))
        child.on('close', (code, closeSignal) => resolve({ code, signal: closeSignal }))
      })

      return {
        kill: () => child.kill('SIGKILL'),
        result: async () => {
          const outcome = await settled
          clearTimeout(timer)
          signal?.removeEventListener?.('abort', onAbort)
          return {
            exitCode: typeof outcome.code === 'number' ? outcome.code : null,
            signal: outcome.signal ?? null,
            timedOut,
            aborted,
            timeoutMs: spec.timeoutMs,
            stdout: { text: capture.out, truncated: capture.outTruncated },
            stderr: { text: capture.err, truncated: capture.errTruncated },
            sandbox: { mode: 'workspace-write', denied: false },
          }
        },
      }
    },
  }
}

/**
 * A **scripted** shell seam: same shape as {@link createFakeShell}, but every command is answered
 * from a table instead of being executed.
 *
 * This is for contract coverage of the extraction service — the classification of a timeout, a
 * truncated capture, an encrypted document, a backend that is not there — where the point is the
 * *decision* the service makes, not the output of a particular binary. Production claims are never
 * tested with it: `extract-production.test.mjs` uses the real seam above for those.
 *
 * @param handler - `(commandLine, spec) => { stdout?, stderr?, exitCode?, timedOut?, truncated?, runnerFailed? }`.
 *   The handler is given the command line *and* the resolved spec, so a script can answer the
 *   probe and the extraction differently.
 * @returns `{ resolve, execute, calls }`.
 */
export function createScriptedShell(handler) {
  const calls = []
  return {
    calls,
    resolve(request = {}) {
      return {
        command: String(request.command ?? ''),
        workdir: request.workdir ?? process.cwd(),
        timeoutMs: request.timeoutMs ?? 5_000,
        onExpiry: request.onExpiry ?? 'kill',
        stdoutMaxBytes: request.stdoutMaxBytes ?? 1024 * 1024,
      }
    },
    async execute(spec) {
      calls.push(spec.command)
      const scripted = handler(spec.command, spec) ?? {}
      const result = {
        exitCode: scripted.exitCode === undefined ? 0 : scripted.exitCode,
        signal: scripted.signal ?? null,
        timedOut: scripted.timedOut === true,
        aborted: scripted.aborted === true,
        timeoutMs: spec.timeoutMs,
        stdout: { text: scripted.stdout ?? '', truncated: scripted.truncated === true },
        stderr: { text: scripted.stderr ?? '', truncated: false },
        sandbox: { mode: 'workspace-write', denied: scripted.denied === true },
      }
      return {
        kill: () => true,
        result: async () => {
          if (scripted.runnerFailed === true) throw new Error(scripted.runnerFailedReason ?? 'scripted runner failure')
          return result
        },
      }
    },
  }
}

/**
 * An in-memory `ctx.storageDomain` stand-in that honours the two facts the real host enforces:
 *
 * - `open(spec)` re-validates **every stored record** against the table's `valueSchema.parse`, so a
 *   handle that writes a record the schema refuses cannot be reopened (`invalid-record`);
 * - a second concurrent `open()` of the same domain name is refused (`already-open`), because the
 *   shipped backend serves one handle per domain per process.
 *
 * It exists so a test can drive a real `createAppStorage()` handle — and the modules layered on it
 * (memory, the workspace connection record) — without the desktop host.
 *
 * @param options.name - the domain name this medium serves (default `professor_app`).
 * @returns `{ stores, openCalls, service }`; `stores` is `Map<tableName, Map<key, value>>`, so a
 *   test can inspect the persisted bytes directly.
 */
export function createFakeStorageDomain({ name = 'professor_app' } = {}) {
  const stores = new Map()
  let openCalls = 0
  let open = false

  const domain = {
    name,
    async close() { open = false },
    table(tableName) {
      if (!stores.has(tableName)) stores.set(tableName, new Map())
      const store = stores.get(tableName)
      return {
        get: (key) => store.get(key),
        keys: () => store.keys(),
        entries: () => store.entries(),
        get size() { return store.size },
        async put(key, value) { store.set(key, value) },
        async delete(key) { store.delete(key) },
        async update(key, transform) { store.set(key, transform(store.get(key))) },
      }
    },
  }

  return {
    stores,
    /**
     * Write a record straight into the medium, as a previous process would have left it.
     *
     * The only honest way to test "what happens when the domain already holds a record this build
     * does not understand": the plugin must *find* it on open, which means it has to be there
     * before the plugin opens anything. Seeding through `service.open()` would leave the medium
     * marked open and make the plugin's own open fail with `already-open` instead.
     */
    seed(tableName, key, value) {
      if (!stores.has(tableName)) stores.set(tableName, new Map())
      stores.get(tableName).set(key, value)
      return this
    },
    get openCalls() { return openCalls },
    service: {
      async open(spec) {
        if (spec.name !== name) {
          throw Object.assign(new Error(`open-failed: no backend route for domain '${spec.name}'`), { code: 'open-failed' })
        }
        if (open) {
          throw Object.assign(new Error(`open-failed: already-open: domain '${spec.name}' is already open`), { code: 'open-failed' })
        }
        for (const [table, tableSpec] of Object.entries(spec.tables ?? {})) {
          for (const [key, raw] of stores.get(table) ?? []) {
            try {
              tableSpec.valueSchema.parse(raw)
            } catch (error) {
              throw Object.assign(
                new Error(`invalid-record: domain '${spec.name}': stored record '${key}' in table '${table}' does not match its schema`),
                { code: 'invalid-record', cause: error },
              )
            }
          }
        }
        open = true
        openCalls += 1
        return domain
      },
    },
  }
}

/** Build a tool-execution context for a session. */
export function makeExec({ cwd, sessionId = 'session-test', signal } = {}) {
  return {
    agent: { session: { id: sessionId, header: { cwd } } },
    ...(signal === undefined ? {} : { signal }),
  }
}

/**
 * Every fixture root this process created, so the suite can hand the disk back to the OS.
 *
 * `makeHome` used to leak: it created a directory under the system temp dir and nothing ever
 * removed it, so every run left a few dozen directories behind for good. On the machine this was
 * written on that had reached 8 902 directories — enough to leave the host's own process table
 * unhealthy. Removal is best-effort and synchronous because it runs from an `exit` hook, where
 * nothing may be awaited; and a fixture that cannot be removed must never turn a green run red.
 */
const createdHomes = new Set()

/** Remove every fixture root this process created. Safe to call repeatedly. */
export function cleanupHomes() {
  for (const home of createdHomes) {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // Best effort only: a leftover directory is a hygiene problem, never a test result.
    }
  }
  createdHomes.clear()
}

// `exit` and not `beforeExit`: `beforeExit` does not fire when the loop drains after an explicit
// `process.exit()`, which is exactly how a failing test run ends.
process.on('exit', cleanupHomes)

/**
 * Create an isolated temporary "machine" root.
 *
 * The returned path is realpath-canonicalized: on macOS `os.tmpdir()` is `/var/...` while its real
 * path is `/private/var/...`, and the fake filesystem canonicalizes like the real backend does.
 * Returning the canonical spelling keeps fixtures consistent with resolved targets.
 *
 * The directory is registered for removal at process exit, so a run leaves nothing behind.
 */
export async function makeHome(prefix = 'professor-test-') {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const canonical = await fs.realpath(created)
  createdHomes.add(canonical)
  return canonical
}

/** Write a file inside a fixture, creating parents. */
export async function writeFixture(home, relative, content) {
  const target = path.join(home, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf8')
  return target
}
