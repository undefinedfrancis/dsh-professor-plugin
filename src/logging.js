/**
 * Logging helpers for the Professor plugin.
 *
 * The plugin previously used `console.*` directly, which bypassed the Harness logger (no
 * session attribution, no level filtering). Everything now routes through the injected
 * `ctx.logger` when it is available, and degrades to `console` only when it is not.
 *
 * @module dsh-professor-spike/src/logging
 */

const PREFIX = '[professor-spike]'

/**
 * Build the plugin's logger surface.
 *
 * @param ctx - the Cordis plugin context (its `logger` is optional).
 * @returns an object with `info`, `warn` and `debug`; never throws.
 */
export function createLogger(ctx) {
  const forward = (level, fallback) => (message) => {
    const text = `${PREFIX} ${message}`
    const target = ctx?.logger
    if (typeof target?.[level] === 'function') {
      target[level](text)
      return
    }
    fallback(text)
  }

  return {
    info: forward('info', (text) => console.log(text)),
    warn: forward('warn', (text) => console.warn(text)),
    debug: forward('debug', () => {}),
  }
}
