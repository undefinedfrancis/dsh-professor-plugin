/**
 * Skill-directory change detection.
 *
 * Defects this module fixes (see docs/AUDIT.md):
 * - the old watcher was created *inside* the provider factory, so every scope that mounted the
 *   plugin opened another recursive watcher on the same tree and leaked it when `control.signal`
 *   was absent;
 * - recursive watch costs one descriptor per subdirectory, which is what produced
 *   `EMFILE: too many open files, watch` in CI;
 * - every event invalidated immediately, so a burst of writes produced an invalidation storm.
 *
 * Design: exactly one non-recursive watcher per plugin instance (one descriptor), debounced, and
 * failure-tolerant. A non-recursive watch sees skill directories being added, removed or renamed,
 * which is what changes the catalog. Edits *inside* a skill are picked up by `get()`, which
 * re-reads `SKILL.md` on every call; only a frontmatter change (name/description) can stay stale
 * in the catalog until the next watch event or restart, and diagnostics report that honestly.
 *
 * @module dsh-professor-spike/src/skills/watcher
 */

import { watch as defaultWatch } from 'node:fs'

/**
 * Stable marker prefixed to every watcher-degradation log line.
 *
 * "Hot-reload is unavailable on this host" (EMFILE and friends) is *expected capability
 * degradation*: the plugin keeps working and the catalog simply refreshes on restart. It is not
 * the same class of event as a malformed skill candidate, which is a genuine provider defect.
 * Consumers (diagnostics, the offline verifier) use this marker to keep the two apart instead of
 * counting a host resource limit as a provider failure.
 */
export const WATCHER_DEGRADED_PREFIX = 'skills-watcher:'

/**
 * Create the watcher.
 *
 * @param options.dir - directory to watch (usually `<plugin>/skills`).
 * @param options.onChange - debounced callback; typically invalidates the skill catalog.
 * @param options.logger - plugin logger; failures are reported once, never thrown.
 * @param options.debounceMs - coalescing window (default 250 ms).
 * @param options.watchFn - injectable `fs.watch` (tests).
 * @returns `{ healthy, reason, close, flushPending }` — `healthy` is false when watching is
 *   unavailable, in which case the catalog simply refreshes on restart.
 */
export function createSkillsWatcher(options) {
  const {
    dir,
    onChange,
    logger,
    debounceMs = 250,
    watchFn = defaultWatch,
  } = options

  let watcher
  let timer
  let healthy = false
  let reason = 'not started'
  let closed = false

  const invalidate = () => {
    timer = undefined
    if (closed) return
    try {
      onChange()
    } catch (error) {
      logger?.warn(`skill invalidation failed: ${error.message}`)
    }
  }

  const schedule = () => {
    if (timer !== undefined) return // coalesce: one invalidation per window
    timer = setTimeout(invalidate, debounceMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const stop = (why) => {
    healthy = false
    reason = why
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    const current = watcher
    watcher = undefined
    if (current !== undefined) {
      try {
        current.close()
      } catch {
        // Closing an already-failed watcher is not an error worth surfacing.
      }
    }
  }

  /** Degrade to "refresh on restart": report once, distinguishably, and never throw. */
  const degrade = (error) => {
    stop(`watcher unavailable (${error?.code ?? error?.message ?? 'unknown error'}); catalog refreshes on restart`)
    logger?.warn(`${WATCHER_DEGRADED_PREFIX} ${reason}`)
  }

  try {
    watcher = watchFn(dir, { persistent: false }, () => schedule())
    watcher.on?.('error', (error) => {
      // EMFILE and friends: degrade to "refresh on restart" instead of failing the plugin.
      degrade(error)
    })
    healthy = true
    reason = 'watching'
  } catch (error) {
    degrade(error)
  }

  return {
    get healthy() {
      return healthy
    },
    get reason() {
      return reason
    },
    /** Trigger the callback immediately (diagnostics / manual refresh). */
    flushPending() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      invalidate()
    },
    close() {
      closed = true
      stop('closed')
    },
  }
}
