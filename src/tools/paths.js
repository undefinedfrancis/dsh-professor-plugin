/**
 * `professor_paths` — report how the plugin resolved every root, and where each value came from.
 *
 * This replaces the spike-era filesystem probes as the single "where am I pointing?" tool: it
 * exposes only resolution results and policy roots, never filesystem contents or environment
 * dumps.
 *
 * Since Phase 1 it also answers the question a general (course-free) session needs: **is this
 * workspace a Professor academic folder at all?** `projectBound` is the answer, `projectRootReason`
 * explains a "no", and `writeRoots` is empty while unbound — so "there is nothing to point at" is
 * visible here rather than inferred from a denial later.
 *
 * @module dsh-professor-spike/src/tools/paths
 */

import { jsonOutput, NO_PARAMETERS, oneOfTypes } from './support.js'

export const PATHS_TOOL_NAME = 'professor_paths'

/**
 * Define the tool.
 *
 * @param options.pluginRoot - the plugin package directory.
 * @param options.skillsDir - bundled skills directory.
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`.
 * @param options.resolveRoots - root-variable resolver.
 * @param options.policiesFor - `(projectRoot) => { read, write }`.
 * @param options.gateway - filesystem gateway (for sandbox facts).
 * @param options.appStorage - Professor application storage handle (`describe()`/`ensureOpen()`).
 * @returns the tool definition.
 */
export function definePathsTool(options) {
  const {
    pluginRoot, skillsDir, resolveProject, resolveRoots, policiesFor, gateway, appStorage,
  } = options

  return {
    name: PATHS_TOOL_NAME,
    description: 'Report where the Professor plugin is pointing: the project root and whether it is a connected academic folder, the dependency workspace, the resolved values of PERSONAL_AGENT_ROOT / COURSE_ROOT / PROJECTS_ROOT (with the source of each value), the read/write roots this call is allowed to touch, and where Professor application storage lives. Use it to verify setup or diagnose a path problem.',
    parameters: NO_PARAMETERS,
    output: jsonOutput({
      type: 'object',
      properties: {
        pluginRoot: { type: 'string' },
        skillsDir: { type: 'string' },
        projectRoot: { type: 'string' },
        projectRootSource: { type: 'string' },
        projectBound: { type: 'boolean' },
        projectRootReason: oneOfTypes('string', 'null'),
        workspaceRoot: { type: 'string' },
        workspaceSource: { type: 'string' },
        roots: { type: 'object' },
        readRoots: { type: 'array' },
        writeRoots: { type: 'array' },
        appStorage: { type: 'object' },
        sandbox: { type: 'object' },
      },
      required: [
        'pluginRoot', 'skillsDir', 'projectRoot', 'projectRootSource', 'projectBound',
        'projectRootReason', 'workspaceRoot', 'workspaceSource', 'roots', 'readRoots', 'writeRoots',
        'appStorage', 'sandbox',
      ],
    }),

    async execute(_args, exec) {
      const project = await resolveProject(exec)
      const bound = project.bound === true
      const policies = policiesFor(project.root, [], { bound })
      const resolved = await resolveRoots({ cwd: project.root })
      const session = exec?.agent?.session
      // Reporting where application storage lives is part of "where am I pointing"; opening it is
      // lazy, but a paths call is exactly the moment a user asks, so this is allowed to trigger it.
      const storage = appStorage === undefined ? null : await appStorage.ensureOpen()

      return {
        pluginRoot,
        skillsDir,
        projectRoot: project.root,
        projectRootSource: project.source,
        projectBound: bound,
        projectRootReason: project.reason ?? null,
        workspaceRoot: resolved.workspaceRoot ?? '',
        workspaceSource: resolved.workspaceSource,
        roots: resolved.roots,
        readRoots: policies.read.roots,
        writeRoots: policies.write.roots,
        appStorage: storage,
        sandbox: {
          fsAvailable: gateway.available,
          fsSandboxMode: gateway.sandboxMode ?? null,
          callPolicy: gateway.sessionPolicy(session) ?? null,
        },
      }
    },
  }
}
