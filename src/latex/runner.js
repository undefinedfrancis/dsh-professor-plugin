/**
 * The shared shell boundary (M11 LaTeX compilation, M8-follow-up extraction runners).
 *
 * The plugin never spawns a process itself. Every external command runs through the Harness
 * `ctx.shell` capability seam — the same seam the model-facing `bash` tool uses — so the
 * deployment's sandbox mode, approval policy and output limits all still apply.
 *
 * The seam's contract, as verified against the installed build:
 *
 * ```text
 * ctx.shell.resolve({ command, workdir?, timeoutMs?, onExpiry?, stdoutMaxBytes?,
 *                     dshEnv?, sandboxPolicy? })       -> spec
 * await ctx.shell.execute({ ...spec, signal })          -> handle
 * await handle.result()    -> { exitCode, signal, timedOut, aborted, timeoutMs,
 *                               stdout: { text, truncated },
 *                               stderr: { text, truncated },
 *                               sandbox?: { mode, denied } }
 * ```
 *
 * **Sandbox policy.** The installed `@deepseek-ai/dsh-tool-bash` resolves the *standing* policy of
 * the calling session — `ctx.sandboxPolicy.resolve({ session: exec.agent.session })` — and passes
 * the result in its shell request; a confining executor (`shell.sandboxMode !== undefined`) then
 * confines to `policy.workspaceRoot`, and falls back to `ctx.sandboxPolicy.resolve()` (deployment
 * root, **no** session) when the request carries no policy. This adapter therefore stamps the same
 * standing policy, under the same condition, for the same reason:
 *
 * - it passes the policy through the supported host API and never fabricates or widens one — the
 *   session's own mode and workspace root travel unchanged, approval boundaries and escalation
 *   rules stay where they belong (the tool layer), and selecting an artifact `workdir` does not
 *   extend the writable roots;
 * - a host without the `sandboxPolicy` service keeps today's behaviour: no policy is stamped and
 *   the executor applies its own deployment fallback (graceful, never a throw);
 * - a policy resolver that *throws* is reported as an explicit `runnerFailed` — running under an
 *   unknown policy would be the very bug this fixes.
 *
 * What the omission caused in any given session (e.g. the reported `.fls`/temp write denial) is a
 * separate, empirical question: the gap is confirmed, its causal share is not, until reproduced.
 *
 * `ShellExecRequest.command` is a **string**, not an argv, so callers that have an argument vector
 * pass it as `args` and it is quoted into one command line by `argvToCommand` (see
 * `src/extract/backend.js`). Every argument is single-quoted unless it is provably inert, so a
 * value can never be re-read as a second command or as a flag.
 *
 * Because that shape could change between Harness versions, the adapter is **defensive**: it
 * activates only when both `resolve` and `execute` are present, and any deviation surfaces as
 * `undefined` (no runner) or as an explicit `runner_failed` result — never as a fabricated
 * success.
 *
 * @module dsh-professor-spike/src/latex/runner
 */

import { argvToCommand } from '../extract/backend.js'

/** Default deadline for a document compile. */
export const DEFAULT_COMPILE_TIMEOUT_MS = 120_000

/** Maximum captured bytes per stream, so a runaway log cannot exhaust memory. */
export const MAX_CAPTURE_BYTES = 256 * 1024

function truncate(text, limit = MAX_CAPTURE_BYTES) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[output truncated]`
}

/**
 * Adapt the Harness shell seam into a plain `run(spec) -> result` function.
 *
 * @param ctx - the Cordis plugin context.
 * @returns the runner, or `undefined` when the seam is unavailable (the caller then reports
 *   "not attempted" rather than failing).
 */
export function createShellRunner(ctx) {
  let shell
  try {
    shell = typeof ctx?.get === 'function' ? ctx.get('shell') : ctx?.shell
  } catch {
    shell = undefined
  }
  if (shell === undefined || shell === null) return undefined
  if (typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') return undefined
  // Optional companion seam: the bash tool passes the collected environment into every request.
  let shellEnv
  try {
    shellEnv = typeof ctx?.get === 'function' ? ctx.get('shellEnv') : ctx?.shellEnv
  } catch {
    shellEnv = undefined
  }
  // Optional companion seam: the standing sandbox policy of the calling session. Only a *confining*
  // executor receives it — that is exactly the condition `dsh-tool-bash` applies, and an unconfined
  // executor must be handed its request unchanged. A host without the service is not an error:
  // the executor then keeps its own deployment fallback (see the module contract above).
  let sandboxPolicyService
  try {
    sandboxPolicyService = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : ctx?.sandboxPolicy
  } catch {
    sandboxPolicyService = undefined
  }
  const stampsPolicy = shell.sandboxMode !== undefined && typeof sandboxPolicyService?.resolve === 'function'

  return async function run(spec) {
    const {
      command, args, workdir, timeoutMs = DEFAULT_COMPILE_TIMEOUT_MS, onExpiry = 'kill',
      signal, exec, stdoutMaxBytes, captureBytes = MAX_CAPTURE_BYTES,
    } = spec
    let line
    try {
      line = Array.isArray(args) ? argvToCommand([command, ...args]) : String(command)
    } catch (error) {
      return { runnerFailed: true, reason: `the command could not be built: ${error.message}` }
    }
    const request = { command: line }
    if (typeof workdir === 'string' && workdir.length > 0) request.workdir = workdir
    if (Number.isInteger(timeoutMs) && timeoutMs > 0) request.timeoutMs = timeoutMs
    if (Number.isInteger(stdoutMaxBytes) && stdoutMaxBytes > 0) request.stdoutMaxBytes = stdoutMaxBytes
    if (typeof shellEnv?.collect === 'function') {
      try {
        request.dshEnv = shellEnv.collect(exec)
      } catch {
        // A missing environment is the executor's default, not a reason to fail the compile.
      }
    }
    if (stampsPolicy) {
      let policy
      try {
        policy = sandboxPolicyService.resolve(
          exec?.agent === undefined ? {} : { session: exec.agent.session },
        )
      } catch (error) {
        // Never execute under an unknown policy: that is the failure mode being fixed here.
        return {
          runnerFailed: true,
          reason: `the session sandbox policy could not be resolved: ${error.message}`,
        }
      }
      if (policy !== undefined && policy !== null && typeof policy === 'object') {
        request.sandboxPolicy = policy
      }
    }

    let handle
    try {
      const resolved = shell.resolve({ ...request, onExpiry })
      handle = await shell.execute({ ...resolved, ...(signal === undefined ? {} : { signal }) })
    } catch (error) {
      return { runnerFailed: true, reason: `the shell seam rejected the request: ${error.message}` }
    }
    if (handle === undefined || typeof handle.result !== 'function') {
      return { runnerFailed: true, reason: 'the shell seam returned a handle without result()' }
    }

    let result
    try {
      result = await handle.result()
    } catch (error) {
      return { runnerFailed: true, reason: `the shell run failed: ${error.message}` }
    }
    if (result === undefined || result === null) {
      return { runnerFailed: true, reason: 'the shell run produced no result' }
    }

    return {
      runnerFailed: false,
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
      signal: result.signal ?? null,
      timedOut: result.timedOut === true,
      aborted: result.aborted === true,
      timeoutMs: result.timeoutMs ?? request.timeoutMs ?? null,
      stdout: truncate(result.stdout?.text, captureBytes),
      stdoutTruncated: result.stdout?.truncated === true || String(result.stdout?.text ?? '').length > captureBytes,
      stderr: truncate(result.stderr?.text, captureBytes),
      stderrTruncated: result.stderr?.truncated === true || String(result.stderr?.text ?? '').length > captureBytes,
      sandbox: result.sandbox === undefined ? null : {
        mode: result.sandbox.mode ?? null,
        denied: result.sandbox.denied === true,
        ...(result.sandbox.runnerFailed === true ? { runnerFailed: true } : {}),
      },
    }
  }
}
