/**
 * `professor_project_init` — create the versioned `.professor/` project inside the conversation's
 * workspace.
 *
 * Initialisation is create-only: an existing `project.yaml` is never replaced, and a file carrying
 * a newer schema is refused outright (see `src/project/project.js`). Directories are created by the
 * filesystem service itself when the project file is written, so no `mkdir` is needed.
 *
 * @module dsh-professor-spike/src/tools/project-init
 */

import { defaultProject, loadProject, PROJECT_SCHEMA_VERSION, saveProject, validateProject } from '../project/project.js'
import { projectPaths } from '../paths/roots.js'
import { jsonOutput } from './support.js'

export const PROJECT_INIT_TOOL_NAME = 'professor_project_init'

/**
 * Define the tool.
 *
 * @param options.resolveProject - `async (exec) => { root, source, bound, reason }`; course-owned tools
 *   receive a wrapper that throws `PROFESSOR_PROJECT_MISSING` for an unbound workspace.
 * @param options.gateway - filesystem gateway.
 * @param options.policiesFor - `(projectRoot) => { read, write }`.
 * @param options.logger - plugin logger.
 * @returns the tool definition.
 */
export function defineProjectInitTool(options) {
  const {
    resolveProject, gateway, policiesFor, logger,
  } = options

  return {
    name: PROJECT_INIT_TOOL_NAME,
    description: 'Create the Professor project (.professor/project.yaml and its directories) inside the current conversation workspace. Create-only: it refuses to replace an existing project or a newer schema, and it never touches course material. Use professor_course_manage to add courses afterwards.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Stable project id (kebab-case). Defaults to "professor-project".' },
        name: { type: 'string', description: 'Display name for the project.' },
      },
    },
    output: jsonOutput({
      type: 'object',
      properties: {
        projectRoot: { type: 'string' },
        projectFile: { type: 'string' },
        schemaVersion: { type: 'number' },
        created: { type: 'boolean' },
        alreadyPresent: { type: 'boolean' },
        warnings: { type: 'array' },
      },
      required: ['projectRoot', 'projectFile', 'schemaVersion', 'created', 'alreadyPresent', 'warnings'],
    }),

    async execute(args = {}, exec) {
      const project = await resolveProject(exec)
      const policies = policiesFor(project.root)
      const signal = exec?.signal
      const layout = projectPaths(project.root)

      const existing = await loadProject({ gateway, projectRoot: project.root, signal })
      if (existing.unsupported !== null) {
        // Never overwrite a newer schema; surface it as a hard failure with the loader's message.
        const error = new Error(existing.problems[0])
        error.code = 'PROFESSOR_PROJECT_UNSUPPORTED'
        throw error
      }
      if (existing.present) {
        const validation = validateProject(existing.document)
        logger?.info('project.yaml already present; leaving it untouched')
        return {
          projectRoot: project.root,
          projectFile: layout.projectFile,
          schemaVersion: existing.document?.schema_version ?? PROJECT_SCHEMA_VERSION,
          created: false,
          alreadyPresent: true,
          warnings: [...validation.errors, ...(validation.warnings ?? [])],
        }
      }

      const document = defaultProject({
        id: typeof args.project_id === 'string' && args.project_id.trim().length > 0 ? args.project_id.trim() : undefined,
        name: typeof args.name === 'string' && args.name.trim().length > 0 ? args.name.trim() : undefined,
      })

      const written = await saveProject({
        gateway,
        projectRoot: project.root,
        document,
        session: exec?.agent?.session,
        signal,
        writePolicy: policies.write,
        createOnly: true,
      })

      return {
        projectRoot: project.root,
        projectFile: written.path,
        schemaVersion: PROJECT_SCHEMA_VERSION,
        created: true,
        alreadyPresent: false,
        warnings: written.warnings ?? [],
      }
    },
  }
}
