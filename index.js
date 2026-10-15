/**
 * Bundle entry point.
 *
 * The implementation lives in `src/`; this file only re-exports the Cordis plugin surface
 * (`name`, `inject`, `apply`) so the loader keeps a stable entry path.
 *
 * @module dsh-professor-spike
 */

export { apply, inject, name } from './src/plugin.js'
export { WATCHER_DEGRADED_PREFIX } from './src/skills/watcher.js'
