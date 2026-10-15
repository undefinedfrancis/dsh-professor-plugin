/**
 * Root resolution: where the Professor project lives, where the dependency workspace lives, and
 * what the bundled skills' `${...}` variables expand to.
 *
 * Design rules (see docs/AUDIT.md):
 * - The project root is the calling conversation's workspace **only when that workspace really is a
 *   Professor academic folder** (it holds `.professor/`), or when an explicit override names it.
 *   The server's launch directory is never an implicit project root.
 * - A workspace that is not a Professor folder is **unbound**, not "the project". A general
 *   academic session must still work there; course-owned work must refuse. See
 *   `assertProjectBound` and `docs/v1/STATUS.md` (Phase 1).
 * - There is no fallback that reads another store (the old `session_projcache` lookup is gone):
 *   a session without a workspace must fail loudly rather than silently scan the wrong tree.
 * - Root variables are resolved from (1) environment, (2) the workspace's own `PATHS.md`,
 *   (3) documented built-in defaults. Unresolved variables keep their `${VAR}` placeholder.
 *
 * @module dsh-professor-spike/src/paths/roots
 */

import os from 'node:os'
import path from 'node:path'

/** The three variables bundled skills use instead of hardcoded personal paths. */
export const ROOT_KEYS = ['PERSONAL_AGENT_ROOT', 'COURSE_ROOT', 'PROJECTS_ROOT']

/** Environment variable that overrides the Professor project root. */
export const PROJECT_ROOT_ENV = 'DSH_PROFESSOR_PROJECT'

/** Environment variable listing extra roots the plugin may read from (path-separator separated). */
export const ALLOWED_ROOTS_ENV = 'DSH_PROFESSOR_ALLOWED_ROOTS'

/** The Professor project directory name created inside a workspace. */
export const PROJECT_DIR = '.professor'

/**
 * Domain error code for "this call needs a Professor academic folder and there is none".
 *
 * The same code `assertUsableProject` uses for an absent `.professor/project.yaml`: an unbound
 * workspace is exactly the case where that document cannot exist, so one code covers both and
 * callers only ever have to learn one.
 */
export const NO_PROJECT_CODE = 'PROFESSOR_PROJECT_MISSING'


/**
 * Candidate locations of the dependency workspace that holds `00_System`, `01_Learning`, …,
 * in priority order. Every candidate is verified with a real directory check before use.
 */
export const WORKSPACE_ROOT_CANDIDATES = [
  { source: 'env:DSH_PROFESSOR_ROOT', path: () => process.env.DSH_PROFESSOR_ROOT },
  { source: 'bootstrapped', path: () => path.join(os.homedir(), '.dsh', 'professor', 'workspace') },
  { source: 'legacy-home', path: () => path.join(os.homedir(), 'Personal-Agent') },
]

/** The calling conversation's workspace, or undefined for a non-agent caller. */
export function conversationRoot(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** The calling session's stable id, or undefined for a non-agent caller. */
export function sessionId(exec) {
  const id = exec?.agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Resolve the Professor project root for one tool call.
 *
 * `bound` is the field callers must branch on. `root` is always reported — even when unbound, so a
 * diagnostic can name the workspace it refused to use — but `bound: false` means "this workspace is
 * not a Professor academic folder", and course-owned work must not touch it.
 *
 * @param exec - tool-execution context.
 * @param options.env - environment override (tests).
 * @param options.isDirectory - async directory probe (defaults to a real `stat`).
 * @returns a promise of `{ root, source, bound, reason }`. `source` is the environment variable
 *   name or `session-cwd`; `reason` explains an unbound result and is `null` when bound.
 * @throws when neither an override nor a conversation workspace exists.
 */
export async function resolveProjectRoot(exec, options = {}) {
  const env = options.env ?? process.env
  const override = env?.[PROJECT_ROOT_ENV]
  if (typeof override === 'string' && override.trim().length > 0) {
    // An explicit override is authoritative, including before the folder exists: it is how a user
    // (or a caller such as the Phase 3 onboarding flow) names an academic folder that is new.
    return { root: path.resolve(override.trim()), source: `env:${PROJECT_ROOT_ENV}`, bound: true, reason: null }
  }

  const cwd = conversationRoot(exec)
  if (cwd === undefined) {
    throw new Error(
      `cannot determine the Professor project root: this call carries no conversation workspace. `
      + `Set ${PROJECT_ROOT_ENV} or call the tool from an agent session.`,
    )
  }

  const root = path.resolve(cwd)
  const isDirectory = options.isDirectory ?? defaultIsDirectory
  // `.professor/` is the marker, not `project.yaml`: a project half-initialised (the directory
  // exists, the document does not yet) is still the user's chosen folder, and refusing to read it
  // would make the state tools unusable between init and the first write.
  const marked = await isDirectory(path.join(root, PROJECT_DIR))
  return marked
    ? { root, source: 'session-cwd', bound: true, reason: null }
    : {
      root,
      source: 'session-cwd',
      bound: false,
      reason: `${root} is not a Professor academic folder (no ${PROJECT_DIR}/ directory here)`,
    }
}

/**
 * Require a bound project, or refuse with an actionable domain error.
 *
 * Applied by every course-owned tool (state, index, search, extract, artifacts, LaTeX, course
 * registry, session binding). The message names the workspace and the next step, because the
 * failure a user actually hits is "I opened a Professor chat and it says there is no course" —
 * the answer is to connect the folder, not to retry.
 *
 * @param project - a result of {@link resolveProjectRoot}.
 * @returns the same `project` when it is bound.
 * @throws {Error} with `code = 'PROFESSOR_PROJECT_MISSING'` otherwise.
 */
export function assertProjectBound(project) {
  if (project?.bound === true) return project
  const where = typeof project?.root === 'string' && project.root.length > 0 ? project.root : 'this workspace'
  const error = new Error(
    `no academic folder is connected to ${where}: there is no ${PROJECT_DIR}/ directory there, so this is a `
    + `general Professor session rather than a course session. Ask the user which folder holds their courses, then `
    + `run professor_project_init from a session whose workspace is that folder. Never guess a course root from the `
    + `current directory.`,
  )
  error.code = NO_PROJECT_CODE
  throw error
}


/**
 * Extra roots the plugin may read from, beyond the project root and the dependency workspace.
 *
 * @param env - environment object (defaults to `process.env`).
 * @returns absolute, de-duplicated paths.
 */
export function allowedRoots(env = process.env) {
  const raw = env?.[ALLOWED_ROOTS_ENV]
  if (typeof raw !== 'string' || raw.trim().length === 0) return []
  return [...new Set(raw.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean)
    .map((entry) => path.resolve(entry)))]
}

/**
 * The versioned layout inside a Professor project, as relative paths.
 *
 * @param root - absolute project root.
 * @returns the layout map plus the directories that must exist.
 */
export function projectPaths(root) {
  const base = path.join(root, PROJECT_DIR)
  return {
    base,
    projectFile: path.join(base, 'project.yaml'),
    indexesDir: path.join(base, 'indexes'),
    filesIndex: path.join(base, 'indexes', 'files.json'),
    chunksDir: path.join(base, 'indexes', 'chunks'),
    stateDir: path.join(base, 'state'),
    sessionsDir: path.join(base, 'state', 'sessions'),
    courseStateDir(courseId) {
      return path.join(base, 'state', 'courses', courseId)
    },
    courseStateFile(courseId, name) {
      return path.join(base, 'state', 'courses', courseId, name)
    },
    notesDir: path.join(base, 'notes'),
    reviewsDir: path.join(base, 'reviews'),
    migrationsDir: path.join(base, 'migrations'),
    migrationLog: path.join(base, 'migrations', 'migration.log'),
    cacheDir: path.join(base, 'cache'),
  }
}

/**
 * Parse root values out of `00_System/PATHS.md`.
 *
 * Accepts the table form the file documents and a plain `KEY=value` / `KEY: value` line, so a
 * user rewriting the file cannot silently break resolution.
 *
 * @param text - contents of PATHS.md.
 * @returns the values found, keyed by variable name.
 */
export function parsePathsFile(text) {
  const values = {}
  for (const key of ROOT_KEYS) {
    const table = new RegExp('\\|\\s*`\\$\\{' + key + '\\}`\\s*\\|[^|]*\\|\\s*`([^`]+)`').exec(text)
    if (table !== null && table[1].trim().length > 0) {
      values[key] = table[1].trim()
      continue
    }
    const assignment = new RegExp('^\\s*' + key + '\\s*[:=]\\s*(.+)$', 'm').exec(text)
    if (assignment !== null) values[key] = assignment[1].trim().replace(/^`|`$/g, '')
  }
  return values
}

async function defaultIsDirectory(candidate) {
  const { promises: fs } = await import('node:fs')
  const info = await fs.stat(candidate).catch(() => undefined)
  return info?.isDirectory() === true
}

/**
 * Resolve the dependency workspace and the three root variables.
 *
 * @param options.projectRoot - the resolved Professor project root (may be undefined).
 * @param options.cwd - the calling conversation's workspace (COURSE_ROOT fallback).
 * @param options.env - environment object (tests).
 * @param options.isDirectory - injectable directory probe (tests).
 * @param options.readText - injectable text reader (tests).
 * @returns `{ workspaceRoot, workspaceSource, roots }`; each root is `{ value, source }` and
 *   `value` is null when unresolved.
 */
export async function resolveRootVariables(options = {}) {
  const env = options.env ?? process.env
  const isDirectory = options.isDirectory ?? defaultIsDirectory
  const candidates = options.candidates ?? WORKSPACE_ROOT_CANDIDATES
  const readText = options.readText ?? (async (file) => {
    const { promises: fs } = await import('node:fs')
    return fs.readFile(file, 'utf8')
  })

  let workspaceRoot
  let workspaceSource = 'unresolved'
  for (const candidate of candidates) {
    const value = candidate.path()
    if (await isDirectory(value)) {
      workspaceRoot = value
      workspaceSource = candidate.source
      break
    }
  }

  let fromFile = {}
  if (workspaceRoot !== undefined) {
    const pathsFile = path.join(workspaceRoot, '00_System', 'PATHS.md')
    try {
      fromFile = parsePathsFile(await readText(pathsFile))
    } catch {
      fromFile = {}
    }
  }

  const projectsDefault = options.projectsDefault ?? path.join(os.homedir(), 'Documents', 'Project')
  const defaults = {
    PERSONAL_AGENT_ROOT: workspaceRoot === undefined
      ? undefined
      : { value: workspaceRoot, source: workspaceSource },
    COURSE_ROOT: typeof options.cwd === 'string' && options.cwd.length > 0
      ? { value: options.cwd, source: 'session-cwd' }
      : undefined,
    PROJECTS_ROOT: (await isDirectory(projectsDefault))
      ? { value: projectsDefault, source: 'default-home' }
      : undefined,
  }

  const roots = {}
  for (const key of ROOT_KEYS) {
    const fromEnv = env?.[key]
    if (typeof fromEnv === 'string' && fromEnv.length > 0) {
      roots[key] = { value: fromEnv, source: 'env' }
      continue
    }
    if (typeof fromFile[key] === 'string' && fromFile[key].length > 0) {
      roots[key] = { value: fromFile[key], source: 'PATHS.md' }
      continue
    }
    roots[key] = defaults[key] ?? { value: null, source: 'unresolved' }
  }

  return { workspaceRoot: workspaceRoot ?? null, workspaceSource, roots }
}

/** Replace every resolved `${KEY}` in skill content; unresolved keys are left untouched. */
export function substituteRoots(content, roots) {
  let out = content
  for (const key of ROOT_KEYS) {
    const value = roots[key]?.value
    if (typeof value === 'string' && value.length > 0) out = out.split('${' + key + '}').join(value)
  }
  return out
}
