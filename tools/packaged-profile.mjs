/**
 * Shared plumbing for the **packaged-installation** acceptance runs.
 *
 * Why this exists separately from the other verifiers
 * ---------------------------------------------------
 * `tools/verify-app-storage.mjs` and `tools/verify-preset-activation.mjs` mount the bundle from the
 * *source checkout* through a `link:` dependency. That proves the source tree works, which is a
 * different question from "does the artefact a user installs work?" — a `files` whitelist silently
 * drops whatever it does not name, and a tarball-installed copy has no repository to borrow from.
 *
 * This module is therefore the *only* place that knows how to turn a packed tarball into a runnable
 * Harness profile, so the parent verifier and the fresh-process restore probe cannot drift apart:
 *
 *   1. {@link createProfessorProfile} initialises a disposable profile, installs **that exact
 *      tarball** into its `node_modules` (a real copy, never a symlink), and registers the bundle;
 *   2. {@link bootProfessorProfile} boots the real Cordis loader against that profile;
 *   3. {@link findProfessorScope} / {@link executeTool} reach the preset's own tool surface the way
 *      the runtime does, so a tool call is real execution rather than a direct function call;
 *   4. {@link createNativeSession} / {@link selectPreset} / {@link sessionSurface} go one level
 *      closer: they let the **host's own** agent factory build a session and bind the preset to it,
 *      then read the persona, tools and skills that session resolves for itself — the Phase 1
 *      requirement that the packaged package "starts a general Professor native session".
 *
 * `ctx.tools.execute()` needs a **live** session: the harness validates the session object's
 * identity against its own store (`dsh-session#liveEntryFor` throws
 * `session "…" is not live in this store` for any look-alike), so the session must come from
 * `ctx.sessions.create()`. The preset's scope token is the agent slot the execution is resolved
 * against, which is why {@link executeTool} attaches the session there.
 *
 * Run these scripts with the harness Node (asar-aware) — see the `verify:packaged` script.
 *
 * @module dsh-professor-spike/tools/packaged-profile
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { activationDeadline, hostActivationDiagnostic } from './activation-deadline.mjs'

/** The installed desktop Harness (asar archive), overridable for another host build. */
export const HARNESS_ROOT = process.env.DSH_HARNESS
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/** The host's bundled dependency tree. Everything host-side is imported from here. */
export const NODE_MODULES = path.join(HARNESS_ROOT, 'dsh/node_modules')

/** The harness executable, used both as the asar-aware Node and as the child-process launcher. */
export const HARNESS_BIN = process.env.DSH_HARNESS_BIN
  ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'

/** The host package the profile resolves its dependencies against. */
export const INSTALL_ANCHOR = path.join(NODE_MODULES, '@deepseek-ai/dsh/package.json')

/** Import one module out of the installed host, asar-aware. */
export const loadHarness = (specifier) => import(pathToFileURL(path.join(NODE_MODULES, specifier)).href)

/** The bundled package name under test. */
export const PACKAGE_NAME = 'dsh-professor-spike'

/**
 * Make a disposable profile and install the exact packed artefact into it.
 *
 * @param options.home - the disposable `DSH_HOME`.
 * @param options.profileName - the profile directory name under `<home>/profiles`.
 * @param options.tarball - absolute path to the packed `.tgz`. Installed as-is, no rebuild.
 * @param options.run - `(command, args, options) => string`; the caller supplies it so npm-cache
 *   isolation stays a single decision in the caller.
 * @param options.registerBundle - when `false` the package is installed but **not** added to
 *   `dsh.profile.bundles`, so the host boots without mounting Professor. The shipped storage backend
 *   refuses a second concurrent `open()` of the same domain name, so a durability run that drives
 *   the plugin's own storage module must not have a live plugin instance holding the domain.
 * @returns `{ profileDir, installedDir, manifest }`.
 */
export async function createProfessorProfile({ home, profileName, tarball, run, registerBundle = true }) {
  const appBoot = await loadHarness('@deepseek-ai/dsh-app-boot/lib/index.js')

  const profileDir = path.join(home, 'profiles', profileName)
  await fs.mkdir(path.join(home, 'profiles'), { recursive: true })
  appBoot.initProfile(profileDir, appBoot.PROFILE_TEMPLATES.web.bundles)

  // `npm install <tarball>` unpacks a real directory into `node_modules` — no symlink, so nothing
  // can resolve back into the developer's checkout by accident.
  run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--save', tarball], { cwd: profileDir })

  const installedDir = path.join(profileDir, 'node_modules', PACKAGE_NAME)
  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) {
    throw new Error('the initialised profile has no dsh.profile.bundles list to register the bundle in')
  }
  if (registerBundle && !manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) {
    manifest.dsh.profile.bundles.push(PACKAGE_NAME)
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  // The loader reads this root entry list; the empty tree is what every bundle patches over.
  await fs.writeFile(path.join(profileDir, 'cordis.yml'), '[]\n')
  return { profileDir, installedDir, manifest }
}

/**
 * Boot the real Cordis loader against an existing profile.
 *
 * @param options.home - the disposable `DSH_HOME`.
 * @param options.profileName - the profile directory name under `<home>/profiles`.
 * @param options.workspace - the session's working directory (deliberately NOT an academic folder).
 * @param options.profileName - see above.
 * @returns `{ ctx, profile, layers, appBoot, cmdline, launchEnv, environment, profileContext }`.
 */
export async function bootProfessorProfile({ home, profileName, workspace, port = '0', open = false }) {
  const readinessListeners = new Set()
  let ready = false
  const readiness = { onReady(callback) {
    if (ready) callback()
    else readinessListeners.add(callback)
    return () => readinessListeners.delete(callback)
  } }
  const appBoot = await loadHarness('@deepseek-ai/dsh-app-boot/lib/index.js')
  const cmdline = await loadHarness('@deepseek-ai/dsh-cmdline/lib/index.js')
  const launchEnv = await loadHarness('@deepseek-ai/dsh-launch-environment/lib/index.js')

  // The installed launch-environment service is a layered reader, not a plain object: the LLM
  // adapters and the directory picker read it during their own activation.
  const environment = appBoot.loadLayeredEnv('dsh')

  const profile = appBoot.loadProfile('professor-packaged', profileName, INSTALL_ANCHOR, home, { userLayer: true })
  const layers = profile.layers.map((layer) => layer.packageName)
  const resolution = await appBoot.createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile })
  const profileContext = {
    name: profileName,
    dir: profile.dir,
    patchPath: profile.patchPath,
    installAnchor: INSTALL_ANCHOR,
    startedBundles: layers,
    cwd: workspace,
    home,
    overlays: [],
    telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
  }
  const patches = appBoot.readProfilePatches('professor-packaged', profileContext, profile)
  const rootConfig = path.join(profile.dir, 'cordis.yml')

  let preparingHost
  const ctx = await activationDeadline(() => appBoot.boot('professor-packaged', rootConfig, patches, async (hostCtx) => {
    preparingHost = hostCtx
    hostCtx.provide('profileContext', profileContext)
    hostCtx.provide(launchEnv.DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    await hostCtx.plugin(appBoot.PluginPackages, { resolution })
    // `--no-open`/`--port 0` keep the disposable web host plane from opening a browser or
    // contending for the real app's port; the preset registry is mounted either way.
    cmdline.provideCmdline(hostCtx, {
      // `--no-open`/`--port 0` keep the disposable web plane from opening a browser or contending
      // for the real app's port. A caller that *wants* the plane (the browser acceptance run) passes
      // an explicit port; the default stays unreachable from outside this process.
      args: open ? ['--port', String(port)] : ['--no-open', '--port', String(port)],
      exit: () => {},
      ready: readiness,
    })
  }), { diagnostic: () => hostActivationDiagnostic(preparingHost) })

  ready = true
  for (const callback of readinessListeners) callback()
  readinessListeners.clear()
  return { ctx, profile, layers, appBoot, cmdline, launchEnv, environment, profileContext }
}

/**
 * The preset's own scope token — the agent slot its children registered under.
 *
 * The registry keys live mounts by `presetId`; `mount.key` is the opaque object the loader uses to
 * look the registrations up again. It is a plain `{}`, NOT an agent: an execution resolved against
 * it still needs a real session supplied separately (see {@link executeTool}).
 */
export async function findProfessorScope(ctx, presetId = 'professor') {
  const { livePresetMounts } = await loadHarness('@deepseek-ai/dsh-agent-preset-registry/lib/index.js')
  const mount = livePresetMounts(ctx.fiber).find((candidate) => candidate.presetId === presetId)
  return mount?.key
}

/** The tool names visible from one scope, as a sorted array. */
export function visibleTools(ctx, scope) {
  const view = ctx.get('tools').view(scope)
  return [...(view?.visible?.keys() ?? [])].sort()
}

/** The skill names the real registry returns for one scope. */
export async function visibleSkills(ctx, scope, cwd) {
  const listed = await ctx.get('skills').list({ scope, cwd })
  return listed.map((entry) => entry.name).sort()
}

/**
 * Create a **live** session and make it reachable from an execution.
 *
 * @param options.ctx - the booted host context.
 * @param options.scope - the preset scope token from {@link findProfessorScope}.
 * @param options.workspace - the session's working directory.
 * @returns `{ session, agent }` where `agent` is the scope with the session attached.
 */
export function attachSession({ ctx, scope, workspace }) {
  const session = ctx.get('sessions').create(undefined, { meta: { cwd: workspace } })
  scope.session = session
  return { session, agent: scope }
}

/**
 * Execute one tool through the **real registry pipeline** (guards, policy, projection and all).
 *
 * @returns the materialised result — `{ content, isError, error? }`. Never throws for a tool error:
 *   the pipeline converts a thrown tool failure into `isError: true`, which is what a real model
 *   turn would receive.
 */
export async function executeTool({ ctx, agent, name, args = {}, label = name }) {
  return ctx.get('tools').execute({
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
    callId: `packaged-${label}`,
    rootCallId: `packaged-${label}`,
    turnId: 'packaged-acceptance',
  })
}

/** The concatenated text of a materialised tool result. */
export function resultText(result) {
  return (result?.content ?? []).map((part) => part.text ?? '').join('\n').trim()
}

/** The parsed JSON payload of a tool result, or `null` when it is not JSON. */
export function resultJson(result) {
  try {
    return JSON.parse(resultText(result))
  } catch {
    return null
  }
}

/**
 * The section name `@deepseek-ai/dsh-persona` writes the preset's persona into.
 *
 * `dsh-persona` is a *scope-only* composable row: mounted inside a preset it shadows the deployment
 * persona for that preset's scope alone. Reading the assembled prompt is therefore how "the persona
 * is available" becomes runtime evidence rather than a claim about a YAML file.
 */
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

/**
 * Ask the host to assemble the system prompt for one scope.
 *
 * @returns the ordered `{ name, text }` sections the model would actually receive.
 */
export async function assembleSections(ctx, scope) {
  const assembled = await ctx.get('systemPrompt').assemble(scope === undefined ? {} : { scope })
  return Array.isArray(assembled?.sections) ? assembled.sections : []
}

/** The text of one assembled section, or `''` when the section is absent. */
export function sectionText(sections, name) {
  return sections.find((section) => section.name === name)?.text ?? ''
}

// --- native sessions ---------------------------------------------------------------------------
//
// Phase 1's acceptance says the installed package must "start a general Professor **native
// session**". `ctx.sessions.create()` (used by {@link attachSession}) makes a session, but the
// session is only a *Professor* session once a preset is bound to a live agent — so the helpers
// below use the harness's own agent factory and its own prompt-assembly contract.

/**
 * The harness's own `assembleContextFor(agent)` — `{ agent, scope: agent }`.
 *
 * Exported by `@deepseek-ai/dsh-agent` and used verbatim by the agent loop
 * (`dsh-agent-loop/lib/index.js`, `preStep()` → `this.loopCtx.systemPrompt.assemble(...)`), so this
 * module reuses it rather than picking a scope token of its own: which token stands for "this agent"
 * is not a detail a verifier may choose. Its doc comment states the reason it exists — *“so
 * agent-scoped prompt and tool contributions cannot be silently omitted.”*
 *
 * Getting it wrong is **silent**: see {@link sessionSurface}.
 */
export async function loadAssembleContextFor() {
  const { assembleContextFor } = await loadHarness('@deepseek-ai/dsh-agent/lib/index.js')
  return assembleContextFor
}

/**
 * Create a **genuinely native session** through the host's own agent factory.
 *
 * `ctx.agents.create()` is the harness's construction path: it prepares the session, persists it
 * through the configured `sessionPersistence` backend, builds an Agent around it and publishes the
 * agent loop. Everything underneath is the host's — the id, the header (`cwd`, `createdAt`) and the
 * on-disk session directory are produced by the native layer, not by this repository.
 *
 * `sessionId` is **required**: the factory rejects a create whose agent id would not match its
 * session id (`agent id "undefined" does not match session id "session-1"`), which is how this
 * contract was discovered.
 *
 * @returns `{ handle, agent, session }`; `handle.dispose()` tears exactly this agent down.
 */
export async function createNativeSession({ ctx, sessionId, workspace }) {
  const handle = await ctx.get('agents').create({ sessionId, meta: { cwd: workspace } })
  return { handle, agent: handle.agent, session: handle.agent.session }
}

/**
 * Bind a preset to a live agent the way the runtime does — before its first turn.
 *
 * The harness refuses this once a turn has begun (`agent-preset/locked`, "This session has already
 * started"), which is what makes the call order a real contract rather than a convention.
 */
export async function selectPreset({ ctx, agent, presetId = 'professor' }) {
  return ctx.get('agentPresets').select(agent, presetId)
}

/**
 * The prompt/tool/skill surface **one agent itself resolves** — i.e. what its own turns would see.
 *
 * Asking the *root* context instead is the trap this helper exists to document: `assembleSections`
 * above takes any token and yields the *default* persona for every token the rows did not register
 * under, with no error. Measured on the installed artefact, the difference is stark — the preset
 * scope gives the 2056-character Professor persona with the full `professor_*` tool set and 6
 * skills, while `agent.ctx` gives the 54-character coding persona with none of them. Only `scope: agent` (through
 * {@link loadAssembleContextFor}) reports the composition the agent is actually running.
 *
 * @returns `{ sections, persona, assemblyTools, visibleTools, skills }`, all sorted or verbatim.
 */
export async function sessionSurface({ ctx, agent, workspace }) {
  const assembleContextFor = await loadAssembleContextFor()
  const assembly = await agent.loopCtx.systemPrompt.assemble(assembleContextFor(agent))
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
  const toolName = (tool) => tool?.name ?? tool?.function?.name ?? String(tool)
  return {
    sections,
    persona: sectionText(sections, PERSONA_PREFIX_SECTION),
    assemblyTools: [...new Set((assembly?.tools ?? []).map(toolName))].sort(),
    visibleTools: [...(ctx.get('tools').view(agent)?.visible?.keys() ?? [])].sort(),
    skills: (await ctx.get('skills').list({ scope: agent, cwd: workspace })).map((entry) => entry.name).sort(),
  }
}

/** The native session log an agent carries, as `{ type, data }` pairs. */
export function nativeSessionLog(agent) {
  return agent.session.snapshotEvents().map((event) => ({ type: event.type, data: event.data }))
}
