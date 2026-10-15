/**
 * Bundled skill provider (`ctx.skills.registerProvider`).
 *
 * Contract notes (verified against `@deepseek-ai/dsh-skill` 0.2.0-rc.2):
 * - a provider is `{ name, list(options), get(candidate, options) }`;
 * - `list` may return an array or `{ candidates, complete }`; `complete: false` stops the registry
 *   from caching a partial catalog;
 * - candidates must satisfy `validateCandidate`: kebab-case `name`, non-empty `description`, an
 *   `invocation` object with two booleans, `source`, numeric `rank`, and `provider` equal to the
 *   provider name. A malformed candidate makes the registry **skip the whole provider**, so this
 *   module validates everything itself and skips bad entries with a warning instead;
 * - `get` must return a definition whose `name` matches the candidate and which carries string
 *   `content`;
 * - `options.cwd` is the calling conversation's workspace (the loader passes
 *   `exec.agent.session.header.cwd`), which is where `COURSE_ROOT` comes from.
 *
 * IO boundary: this module reads the plugin's own immutable package resources with `node:fs`
 * (documented exception — see docs/AUDIT.md). Every piece of *user* data goes through the
 * filesystem gateway instead. Entry names are validated so a crafted directory name cannot escape
 * the bundle directory.
 *
 * @module dsh-professor-spike/src/skills/provider
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { invocationPolicy, parseFrontmatter, stringField } from './frontmatter.js'
import { resolveRootVariables, substituteRoots } from '../paths/roots.js'
import { composeSkill } from './compose.js'

/** Mirrors `BUNDLED_SKILL_RANK` in `@deepseek-ai/dsh-skill`. */
export const BUNDLED_SKILL_RANK = 600

/** Provider name registered on `ctx.skills`. */
export const SKILL_PROVIDER_NAME = 'professor-bundled'

/** Source label reported for every bundled skill. */
export const SKILL_SOURCE = 'bundled'

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SAFE_DIRECTORY = /^[A-Za-z0-9._-]+$/

/**
 * Read one skill bundle (`<skillsDir>/<entry>/SKILL.md`).
 *
 * @returns the parsed skill, or undefined when the file is absent or its frontmatter is invalid.
 */
export async function readBundledSkill(skillsDir, entry) {
  if (!SAFE_DIRECTORY.test(entry) || entry.startsWith('.')) return undefined
  const directory = path.join(skillsDir, entry)
  const skillFile = path.join(directory, 'SKILL.md')
  let raw
  try {
    raw = await fs.readFile(skillFile, 'utf8')
  } catch {
    return undefined
  }
  const frontmatter = parseFrontmatter(raw)
  if (frontmatter === undefined) return undefined
  const name = stringField(frontmatter.data, 'name')
  const description = stringField(frontmatter.data, 'description')
  if (name === undefined || description === undefined) return undefined
  return {
    name,
    description,
    whenToUse: stringField(frontmatter.data, 'whenToUse'),
    invocation: invocationPolicy(frontmatter.data),
    content: frontmatter.body,
    directory,
    skillFile,
  }
}

/**
 * Build the provider.
 *
 * @param options.ctx - plugin context (logging).
 * @param options.skillsDir - absolute path of the bundled skills directory.
 * @param options.logger - plugin logger.
 * @param options.resolveRoots - injectable root resolver (tests); defaults to the real one.
 * @returns the provider object registered on `ctx.skills`.
 */
export function createBundledSkillProvider(options) {
  const {
    ctx,
    skillsDir,
    logger,
    resolveRoots = resolveRootVariables,
    resolveCustomization,
    onEvent,
  } = options

  const warn = (message) => logger?.warn(message)
  /** Bounded, content-free notice that a skill was served (never its text). */
  const loaded = (fields) => {
    if (typeof onEvent !== 'function') return
    try {
      onEvent('skill.loaded', fields)
    } catch {
      // Diagnostics must not be able to break a skill load.
    }
  }

  return {
    name: SKILL_PROVIDER_NAME,
    /** Exposed for diagnostics. */
    skillsDir,

    async list() {
      let entries
      try {
        entries = await fs.readdir(skillsDir, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT') return []
        warn(`bundled skills directory unreadable: ${error.message}`)
        return { candidates: [], complete: false }
      }

      const candidates = []
      const directories = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .sort((left, right) => left.name.localeCompare(right.name))

      for (const entry of directories) {
        const skill = await readBundledSkill(skillsDir, entry.name)
        if (skill === undefined) {
          warn(`ignored skills/${entry.name}: missing or invalid frontmatter (name/description)`)
          continue
        }
        if (!SKILL_NAME_PATTERN.test(skill.name)) {
          warn(`ignored skills/${entry.name}: "${skill.name}" is not kebab-case`)
          continue
        }
        if (skill.name !== entry.name) {
          warn(`skills/${entry.name} declares name "${skill.name}"; directory and skill name differ`)
        }
        candidates.push({
          name: skill.name,
          description: skill.description,
          ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
          invocation: skill.invocation,
          source: SKILL_SOURCE,
          rank: BUNDLED_SKILL_RANK,
          provider: SKILL_PROVIDER_NAME,
          locator: { path: skill.skillFile, directory: skill.directory },
          path: skill.skillFile,
        })
      }
      return candidates
    },

    async get(candidate, lookup = {}) {
      if (candidate?.locator?.directory === undefined) return undefined
      const entry = path.basename(candidate.locator.directory)
      const skill = await readBundledSkill(skillsDir, entry)
      if (skill === undefined || skill.name !== candidate.name) return undefined

      // Resolve `${...}` placeholders so the model receives concrete paths. Unresolved variables
      // keep their placeholder rather than silently pointing somewhere wrong.
      const resolved = await resolveRoots({ cwd: lookup.cwd })
      const builtIn = substituteRoots(skill.content, resolved.roots)
      let content = builtIn
      if (typeof resolveCustomization === 'function') {
        try {
          content = composeSkill({ builtIn, ...await resolveCustomization(skill.name, lookup) }).content
        } catch (error) {
          if (error?.code !== 'PROFESSOR_CUSTOMIZATION_UNAVAILABLE') throw error
          warn('PROFESSOR_CUSTOMIZATION_UNAVAILABLE: saved customization was not loaded')
          content = `${builtIn}\n\nCustomization status: PROFESSOR_CUSTOMIZATION_UNAVAILABLE. Saved customization was not loaded; these are built-in instructions only.`
        }
      }
      // Content-free: which skill, whether preferences were composed, how long it is. Never the text.
      loaded({ skill: skill.name, scope: content === builtIn ? 'builtin' : 'customized', chars: content.length })
      return {
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        invocation: skill.invocation,
        source: SKILL_SOURCE,
        provider: SKILL_PROVIDER_NAME,
        resourceBase: { kind: 'directory', path: candidate.locator.directory },
        path: skill.skillFile,
        content,
      }
    },
  }
}
