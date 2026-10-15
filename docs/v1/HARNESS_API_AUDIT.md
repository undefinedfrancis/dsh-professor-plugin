# Professor v1 — Harness API Feasibility Audit (Phase 0)

> **Phase:** 0 — Safety baseline and supported Harness API gate
> **Date:** 2026-10-05 (Asia/Shanghai)
> **Branch:** `feature/professor-portable-app` (created from `f2cbd25`, working tree preserved)
> **Verdict:** **GO for Phases 1–8.** Every integration Professor v1 requires has a supported, documented
> Harness API with live evidence. No DOM injection, Harness fork, or session-log rewriting is required.
> One pre-existing, unrelated host/plugin incompatibility was diagnosed (`permissionRules/decision`) — see §8.

---

## 1. Host identity and resolution

| Item | Value | Evidence |
|---|---|---|
| Application | `/Applications/DeepSeek Harness.app` | on disk |
| Desktop host version | **`0.2.0-rc.2`** | `Contents/Resources/runtime/primary-runtime/runtime.json` → `desktopVersion` |
| Bundled Node (asar-aware) | `24.18.1` | `Contents/Resources/runtime/versions.json` |
| Runtime payload | node `24.21.0`, python `3.12.14` (+ `python-docx`/`python-pptx`/`openpyxl`) | `primary-runtime/runtime.json` |
| Official packages | 290 `@deepseek-ai/*` under `app.asar/dsh/node_modules` | directory listing |
| Desktop profile | `~/.dsh/profiles/desktop` | on disk |
| Profile bundles | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-experimental-agent-team-profile`, `dsh-permission-rules` (0.7.9), `dsh-professor-spike` (`link:`) | profile `package.json` |
| This package | `dsh-professor-spike` `0.12.0`, preset-scoped, no client half | `package.json`, `cordis.patch.yml` |
| `$DSH_HOME` | `~/.dsh` (sessions at `~/.dsh/sessions`, KV at `~/.dsh/storages`) | on disk |

**Note on how verifiers resolve Harness:** the `verify:*` scripts run the app binary with
`ELECTRON_RUN_AS_NODE=1` and import from `app.asar/dsh/node_modules` — this is the asar-aware Node, and
it is the same resolution the desktop profile uses. `DSH_HARNESS` overrides the asar root.

---

## 2. Method (read-only first, then one disposable live probe)

1. **Read-only inspection of the installed package tree** through the app's own asar-aware Node. No file
   in the app bundle, the real profile, the real courses, the old Registry/Knowledge, or any session log
   was modified.
2. **Extraction of the two generated API catalogs** the harness itself ships. These are machine-generated
   from the same AST walk as the published `cordis-catalog` docs, so they cannot silently diverge from the
   shipped code:
   - host: `dsh-tool-cordis/lib/types/api-catalog.js` → **91 services, 81 events, 936 types, 9 inherited ctx members**
   - client: `dsh-cordis-client-runner/lib/client.js` → **8 services, 4 events, 90 UI slots**
3. **A new disposable real-host probe** — `tools/verify-harness-api.mjs` (`npm run verify:api`). It boots
   the real Cordis loader (`@deepseek-ai/dsh-app-boot#boot`, the same entry `dsh <profile>` uses) inside a
   fresh `mktemp -d` `DSH_HOME`, composes the shipped `web` template **plus this bundle**, then asks the
   live context for every service v1 needs and exercises the smallest real operation for the data-bearing
   ones. Result: **ALL PASS** (29 checks). The real desktop profile is snapshotted before/after and proven
   unwritten.
4. **Re-run of the existing suites** (§3.1) to fix the baseline.

Evidence artifacts produced during the audit:

- `tools/verify-harness-api.mjs` (new, repeatable)
- temporary extraction under `/tmp/phase0-audit/` (catalogs as JSON, decompressed session log) — not part
  of the repository and not required for reproduction.

---

## 3. Baseline results (this run)

### 3.1 Existing suites — re-run, exit code 0

```text
npm run verify           → exit 0   （verify:syntax + verify:skills + verify:sync + verify:dist + verify:e2e + npm test）
  npm test               → 215 / 215 pass, 0 fail, duration ≈ 30.7 s
npm run verify:harness   → exit 0   （6 stages, each "ALL PASS"）
  verify:preset           ALL PASS
  verify:composition      ALL PASS
  verify:boot             ALL PASS
  verify:host             ALL PASS   44 checks incl. real ToolRuntime.register() of all 15 tools
  verify:activation       ALL PASS   24 checks, real preset registry, 13/13 child rows active
  verify:desktop          ALL PASS   24 checks, real desktop bundle list + patch layer
```

`git diff --check` is clean. No source, course, registry, knowledge, profile or session file was modified
by this audit; the only change to the working tree is the one new file `tools/verify-harness-api.mjs`.

Two **pre-existing, non-blocking** activation warnings appear in the desktop replay and are **not**
Professor defects:

```text
desktop-product-telemetry (@deepseek-ai/dsh-host-product-telemetry-otel): invalid config:
  $.serviceVersion missing required value
product-analytics: pending (waiting for service: productTelemetry)
```

### 3.2 New feasibility probe — `npm run verify:api`

```text
PASS  the composed tree reached the active state  — 2
PASS  ctx.clientModules / webServer / storageDomain / storage / agentPresets / sessions /
      sessionPersistence / sessionTitle / sessionQuery / workspaceRegistry / settings /
      configEditor / commands / tools / skills / fs / sandboxPolicy are mounted   (17 checks)
PASS  clientModules.graph() lists browser plugin entries  — 65 entries
PASS  at least one entry resolves an installed client bundle path  — 65 resolvable
PASS  ctx.sessions.create() returns a session；the created session is in the live store
PASS  ctx.agentPresets.resolve("professor") resolves  — professor；no activation failure
PASS  ctx.storageDomain.open() accepted a versioned domain spec
PASS  a table value round-trips inside the disposable home
PASS  the disposable tree disposed cleanly
PASS  the real desktop profile was not written by this run
ALL PASS
```

---

## 4. Required-integration feasibility matrix

| # | Professor v1 requirement | Supported API (exact) | Evidence | Status |
|---|---|---|---|---|
| 1 | **Dedicated sidebar entry** | client bundle registers into `sidebar.panellist` (slot `list`, scope `root`); the shipped panel row is `main`'s dispatched key | client catalog slot `sidebar.panellist`; `dsh-client-ui-sidebar/lib/client.js` declares children incl. `sidebar.panellist`; `dsh-client-ui-plugin-manager/lib/client.js` registers `{name:"sidebar.panellist", id:PANEL_ID, order, label}` | **Supported** |
| 2 | **View / route mounting** | `main` slot (`kind: keyed`, `scope: root`) — *“Central panel selected by sidebar entry id.”* Select via `ctx.layout.selectPanel(id)`; `ctx.layout.beginNavigation()` for cancellable navigation | client catalog slot `main` + `ctx.layout` service (`selectPanel`, `beginNavigation`, `toggleSidebar`); `dsh-client-ui-layout/lib/client.js` declares `root.children.main = {kind:'keyed'}` | **Supported** |
| 3 | **Frontend assets / client bundle** | package manifest `dsh.client = { platform:'web', inject:[…] }`; host scans it and serves `/plugins/<id>/client.js` | `dsh-client-modules` (`clientModules` service: `graph()`, `clientPath(id)`, `fetchBundle()`); catalog lists 65 live entries all resolving a bundle path; in-tree third-party precedent `dsh-better-sidebar@0.24.1` | **Supported** |
| 4 | **Settings page** | register into `settings.section` (slot `list`, scope `root`, options `{id, order, label}`); row-level seat is `settings.general.item` | client catalog slots `settings.section` / `settings.general.item`; `dsh-client-ui-agent-preset` and `dsh-client-ui-settings-plugins` both register `settings.section` | **Supported** |
| 5 | **Settings / config persistence** | `ctx.configEditor.edit(entry, change)` persists profile-row config through the normal Loader path; `ctx.settings` projects `Config` schemas into forms | host catalog services `configEditor` (`entries/configuration/edit`) and `settings`; probed mounted | **Supported** |
| 6 | **Plugin-owned local storage (memory)** | `ctx.storageDomain.open(DomainSpec)` → `Domain{ global, table(name): KvTable, close() }`; backends via `ctx.storage` (`mount`/`form`, `BackendRegistry`) | host catalog `storageDomain`/`storage`; `dsh-base` patch mounts `@deepseek-ai/dsh-storage` + `dsh-storage-json` (`root: dshHomePath('storages')`) + `dsh-storage-domain`; probe round-tripped a value | **Supported** |
| 7 | **Native session create / open** | `ctx.sessions.create(id?, opts)` / `prepare` + `enter` + `announce`; durable side `ctx.sessionPersistence.create/open/flush`; open existing via `ctx.uiWorkspace.openSession(target)` | host catalog `sessions`, `sessionPersistence`; probe created a live session | **Supported** |
| 8 | **Professor runtime activation before first turn** | `ctx.agentPresets.select(agent, agentPreset)` — *“Select a preset before a session starts its first turn.”* Also `resolve(id)`, `mount(ctx,id)`, `composeFrom`, `serviceFor` | host catalog `agentPresets`; probe resolved `professor` with no failure | **Supported** |
| 9 | **Native conversation navigation** | `ctx.layout.selectPanel(null)` returns to the Conversation; `main.conversation` slot is the session-scoped view; `ctx.uiWorkspace.openSession(target)` | client catalog slots `main.conversation`, `conversation.*`; `ctx.layout.selectPanel` doc: *“null to show the Conversation”* | **Supported** |
| 10 | **Session metadata / titles** | minimal side metadata in Professor's own domain (keyed by `harnessSessionId`); title via `ctx.sessionTitle.rename(session, title)` (appends a `session/title` event, source `user`) — **no second conversation database** | host catalog `sessionTitle` (`get/rename/refresh/register`); probe mounted | **Supported** |
| 11 | **Session listing / “recent sessions”** | `ctx.sessionQuery.listSessions / filterSessions / searchSessions / readTitle`; live-preferred, provider-independent | host catalog `sessionQuery`; probe mounted | **Supported** |
| 12 | **Session separation (hide from normal workflows)** | supported mechanisms exist: `ctx.workspaceRegistry.archiveSession / unarchiveSession / pinSession / unpinSession`, workspace grouping via `workspaceRegistry`, and dedicated presentation slots `sidebar.session.row.leading` / `sidebar.session.row.hover` | host catalog `workspaceRegistry`; client catalog slots `sidebar.session.row.*` | **Supported** (mechanism verified; **specific composition choice unverified** — see §9) |
| 13 | **Enable / disable removes UI** | bundle selection `ctx.pluginManager.setBundleEnabled(name, enabled)` / `setPluginEnabled(id, enabled)`; client roster recomposes on graph change (`clientModules.onGraphChanged`) | host catalog `pluginManager`; `clientModules` node half recomposes the graph | **Supported** (end-to-end UI removal **unverified** — see §9) |
| 14 | **Academic folder as a data source** | `ctx.workspaceRegistry.create(path, title)` / `resolveByPath(path)`; read-only browsing via `ctx.workspaceFiles.read/list/stat`; native directory picker `ctx.uiWorkspace.pickDirectory()` | host catalog `workspaceRegistry`, `workspaceFiles`, `uiWorkspace` | **Supported** |
| 15 | **Plugin HTTP route (optional)** | `ctx.webServer.register({kind, path, handler})`, `registerUpgrade`, `tapIndex`, `collectIndexInjections` | host catalog `webServer`; shipped `dsh-host-webserver` | **Supported** |
| 16 | **Human command entry (optional)** | `ctx.commands.register(definition)` + `@Remote execute` | host catalog `commands` | **Supported** |

---

## 5. Client extension surface — the slots that matter

Client plugins declare their browser half in `package.json` under `dsh.client` and receive a Cordis
context whose services include `ctx.slots`, `ctx.layout`, `ctx.sessions`, `ctx.uiWorkspace`,
`ctx.workspaces`, `ctx.locale`, `ctx.theme`, `ctx.timer`.

Registration is always `ctx.slots.inject(key, () => ctx.slots.register({name: key, …}, Component))` —
the `inject` call waits for the owning slot's declaration, so load order is not the plugin's problem.

| Slot | Kind | Scope | Use for Professor |
|---|---|---|---|
| `root` | single | root | declared by `dsh-client-ui-layout`; not ours to take |
| `main` | **keyed** | root | **Professor Home / Course view** — key = the sidebar entry id |
| `sidebar.panellist` | list | root | **🎓 Professor navigation icon** |
| `sidebar.settings` | single | root | host settings entry; not ours |
| `settings.section` | **list** | root | **Professor Settings page** |
| `settings.general.item` | list | root | single preference rows without a page |
| `sidebar.session.row.leading` / `.hover` | list | root | optional Professor marker on session rows |
| `main.conversation` | single | session-maybe | the native conversation occupant |
| `conversation.*` (90 total) | — | — | untouched; native Harness owns the transcript |

Discipline the slot core enforces (from `dsh-client-ui-slots` docs): registering an undeclared slot, a
duplicate child declaration, or two mounts of one shared handle **throws at load time**; an entry's
disposer recursively removes the children it declared. Enable/disable therefore cleans up by construction.

**Registration options are typed and validated:** `sidebar.panellist` and `settings.section` both require
`id` (string) and accept `order` (number) and `label` (string | thunk re-read per projection, so localized
labels follow the active locale without re-registering).

---

## 6. Persistence contract (`ctx.storageDomain`)

```ts
interface DomainSpec {
  name: string                       // UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/  (no hyphens, no dots)
  version: number
  layout?: 'single' | 'per-record'
  compatibleVersions?: readonly number[]
  invalidRecords?: 'backup-and-skip'
  global?: { schema: ZodType<G>; initial: G }
  tables: Record<string, DomainTableSpec>
}
interface Domain<S> {
  readonly name: string
  readonly global: DomainGlobalHandleOf<S>
  table<N>(name: N): KvTable<KeyOf<S,N>, ValueOf<S,N>>   // get/entries/keys/size/put/delete/update
  close(): Promise<void>
}
```

Observations from the installed implementation:

- **Name rule:** `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` (`dsh-storage/lib/index.js`). A hyphenated name is
  rejected with `invalid unit name`. Use e.g. `professor_memory`, `professor_state`.
- **On-disk location:** the `json` backend root is `dshHomePath('storages')` → `~/.dsh/storages/`. Existing
  units prove both layouts: `session_projcache/` (per-record, a directory) and `workspace.json` (single).
- **Schema safety, exactly what Phase 2 needs:** `open()` validates every stored record against the spec's
  schemas and fails loudly with the offending table and key. With `invalidRecords: 'backup-and-skip'`
  (and a backend unit that supports `backupRecord`) the bad record is moved aside as
  `<key>.json.bak.<stamp>`, logged, and skipped — the non-destructive behaviour the Phase 2 brief requires.
- **Versioning:** the backend itself rejects `version-mismatch` / `malformed-medium`, and
  `compatibleVersions` declares the accepted legacy set. This is the supported way to satisfy
  *“corrupt/newer schema returns a clear non-destructive error.”*
- **Dispose:** the **caller** owns the returned handle; close it in `ctx.effect`. A domain still open at
  facility unmount is closed by the plugin's own disposer.
- **Backend routing:** `config.routes?.[name] ?? config.backend`; a backend must expose the `kv` facet.

`ctx.storage.form('domain')` resolves the mounted facility; `StorageForms` is an open interface other
plugins extend by declaration merging — do not assume its shape beyond `domain`.

### 6.1 Phase 1 addendum — verified against the shipped spec

`tools/verify-app-storage.mjs` (`npm run verify:app-storage`, wired into `verify:harness`) hands the
plugin's **real** `createAppStorage()` the **real** service in a disposable home and pins what the
plugin actually ships (`professor_app`, v1, one `app` table with its own `parse()` validator).
Three facts matter beyond §6:

- **`valueSchema` is mandatory, not optional — corrected in Phase 1.** An earlier reading here said a
  bare `{ tables: { app: {} } }` spec was fine because it opened and round-tripped a record. It does,
  but only **within one `open()`**. The domain layer validates every stored record when it loads the
  unit (`dsh-storage-domain/lib/index.js`, open-time `loadAll`: `tableSpec.valueSchema.parse(raw)`), so
  a schema-less table opens, accepts writes, and then refuses to reopen with
  `invalid-record: … does not match its schema` (the loader calls `undefined.parse`). The plugin ships
  a small dependency-free validator (`APP_VALUE_SCHEMA`) that implements exactly the `parse()` method
  the host calls; `defineDomain` does not inspect `valueSchema` at all, and the write path never
  validates. `verify-harness-api.mjs` could not have caught this — it opened a schema-bearing domain
  and never reopened it.
- **`invalidRecords: 'backup-and-skip'` is NOT available on this domain's layout.** The domain layer
  honours it only when the opened unit exposes `backupRecord`, and the shipped JSON backend implements
  that **only** on the `per-record` layout. This domain uses the default `single` layout (one
  `<DSH_HOME>/storages/professor_app.json`), whose unit has no `backupRecord`, so declaring the policy
  would be a silent no-op. It is left off rather than claimed; a phase that needs it must also switch
  the layout and re-prove it here.
- **A second concurrent `open()` of the same domain is refused** (`open-failed: already-open: domain
  'professor_app' is already open`). One instance owns one domain per process; reopening **after
  `close()`** succeeds and finds the existing `bootstrap` marker, which is *not* rewritten.
- **Location is the host's decision, not the package's.** The bytes land at
  `<DSH_HOME>/storages/professor_app.json`; the probe asserts that and that nothing is written inside
  the plugin package or any academic folder. `defaultPathHint` in `describe()` is a hint only.

---

## 7. Native session and routing contract

```text
ctx.sessions.prepare(id?, opts)   → Session (not yet in the store; validates id/cwd, builds SessionHeader)
ctx.sessions.enter(session)       → detach disposer (hooks + store add; does NOT emit session/created)
ctx.sessions.announce(session)    → emits session/created exactly once
ctx.sessions.create(id?, opts)    → the one-shot form (create + enter + announce) for simple callers
ctx.agentPresets.select(agent, 'professor')   BEFORE the first model/tool turn
ctx.sessions.flush(session)       → awaited durability checkpoint
```

- `CreateSessionOptions.meta` accepts `{ cwd, parentSession, createdAt, isSeeded, origin, delegationDepth,
  agentPreset }`. `SessionHeader` persists the same fields — so a Professor session's `cwd` (course folder)
  and `agentPreset` are recorded by the native layer, not invented by us.
- `prepare`/`enter`/`announce` exist precisely so a designer can roll back a partly-created session without
  announcing a bad one. **This is the supported path for the Phase 4 requirement “if creation succeeds but
  binding/hydration/navigation fails, report partial failure and allow safe retry.”**
- Minimal Professor metadata (course, title, mode, updatedAt) belongs in Professor's own domain keyed by
  `harnessSessionId`. The transcript itself stays a Harness session — **no second conversation database.**

---

## 8. Pre-existing host/plugin finding: `permissionRules/decision`

**This is unrelated to the Professor plugin.** It is diagnosed here because Phase 0 was asked to record it
without editing or filtering logs, and because it can affect *any* session in this profile.

**Observed (read-only):**

- Installed build's event vocabulary: `dsh-session/lib/types/known-event-types.js` →
  `KNOWN_SESSION_EVENT_TYPES` contains `permission/preset` but **not** `permissionRules/decision`.
  Its own doc states the rule: an unknown event type is refused *“unless the event carries the envelope's
  `ignorable` marker … such a log was likely written by a newer harness.”*
- The failing log was decompressed to `/tmp/phase0-audit/session-a466a3a2.jsonl` (**read-only source;
  the original `.zstd` file was never opened for write**). 180 events, all parse. The offending row is
  exactly `seq 23`, and its envelope carries **no** `ignorable` field:

```json
{"type":"permissionRules/decision","seq":23,"time":1790852785912,
 "data":{"toolName":"skill","callId":"call_00_MwLwUSrrcPQeYwIFqwjs2765",
         "source":"/Users/<user>/.dsh/profiles/desktop/node_modules/dsh-permission-rules/rules/builtin-high-risk.yaml",
         "action":"passthrough","outcome":"allow","cwd":"/Users/<user>/Documents/courses/<academic-folder>"}}
```

- The writer is the profile-installed third-party **`dsh-permission-rules@0.7.9`**, whose own
  `src/events.ts` documents this exact failure mode and whose `scripts/repair-session-logs.mjs scan` was run
  read-only:

```text
[scan] would repair .../session-a466a3a2-.../session.v4.jsonl.zstd: 1 row(s)
[scan] would repair .../session-d74f6e7b-.../session.v4.jsonl.zstd: 1 row(s)
foreign (non-harness) event rows found by type:
  permissionRules/decision: 2 rows
20 log(s) scanned, 2 affected, 2 row(s) would be marked
```

- The same package declares `engines.dsh` / every peer range as `>=… <0.2.0` and
  `dshWorkshop.compatibility.dshVersions` up to `0.1.7-rc.2`, while the installed host is
  **`0.2.0-rc.2`** — i.e. the plugin is outside its own declared host range.

**Conclusion:** the cause is *an out-of-repo plugin event appended without the `ignorable` marker by a
third-party plugin running outside its declared host range* — **not** a plain “harness version mismatch”
and **not** a Professor defect. The correction to the earlier handoff is that the mechanism is now
identified precisely rather than hypothesised.

**Not done (requires explicit authorization — this is user data):** `repair` (stamps `ignorable: true`,
backs up each artifact first), `strip` (removes the rows), or any manual log edit. `scan` only reads.

**Risk to Phase 4/7 acceptance:** a fresh session created in *this* desktop profile can acquire the same
unmarked row and then refuse to reload, which would break “session remains discoverable after restart”.
Mitigations to evaluate under explicit direction: run Phase 4 acceptance against a **disposable profile
that does not compose `dsh-permission-rules`** (the probe already does this), and/or ask the user to
authorize the upstream `repair` for the two affected logs.

---

## 9. Supported / Unsupported / Unverified

### Supported (evidence in §4)

Sidebar entry · main-panel view mounting · client bundle delivery (`dsh.client`) · settings page ·
config persistence · plugin-owned versioned KV storage · native session create/open/fork ·
preset selection before the first turn · conversation navigation · session titles · session query/listing ·
workspace registry & file reads · plugin HTTP routes · human commands.

### Unsupported — none blocking v1

| Item | Status | Note |
|---|---|---|
| Out-of-vocabulary session events without `ignorable` | **Explicitly refused by design** | Not a gap to work around; §8. Do not append plugin events to the session log. |
| `type: ['string','null']` tool output schemas | **Refused** | Already handled via `oneOfTypes()`; regression held by `verify:host`. |
| A slot that does not exist | **Throws at registration** | Register only into declared slots listed in §5. |

### Unverified in this phase (named, not hidden)

The profile template used for the disposable probe is the shipped `web` template plus this bundle. The
following are provable only by a *client-bundle-bearing* plugin and therefore belong to Phase 4/6/7:

1. **End-to-end client bundle registration from *this* package.** Existence proof is strong
   (`dsh-better-sidebar@0.24.1` ships a working `dsh.client` half in the same profile, and the graph
   resolves 65 entries), but Professor has **no client half today** and this probe did not add one.
2. **Enable/disable removing the Professor UI and disposing subscriptions.** API identified
   (`pluginManager.setBundleEnabled`, `clientModules.onGraphChanged`); not exercised.
3. **The specific session-separation composition.** Mechanisms exist (archive/pin/workspace grouping,
   `sidebar.session.row.*` slots); the chosen composition is a Phase 4 design decision and must be verified
   in the real host then.
4. **`agentPresets.select()` immediately before a first model turn** inside a live Agent loop — the API and
   its documented precondition are confirmed; the ordered call sequence is Phase 4 work.
5. **Package/portability of a client half from a `link:`/tarball install on a clean profile** — Phase 7.

Nothing in the unverified list requires an unavailable API. Each has a named owner phase and a live
verification step in its acceptance criteria.

---

## 10. Implementation contract for Phases 1–8

Constraints derived from the evidence above. These are binding for later phases.

1. **Host floor:** `0.2.0-rc.2` (`.0.2.0-rc.2` catalog). Keep the existing `oneOfTypes()` JSON-Schema
   discipline; `verify:host` remains the gate.
2. **Do not touch the session log.** Out-of-vocabulary events are refused unless `ignorable`;
   the supported answer is *not* to write them. Session separation uses archive/pin/workspace grouping and
   presentation slots only.
3. **Professor metadata lives in a Professor-owned storage domain**, not in a second database and not in
   new session events. Domain/table names must match `/^[a-z][a-z0-9_]*$/`.
4. **Persistence root** is `$DSH_HOME/storages/`; declare `version`, `compatibleVersions`, and
   `invalidRecords: 'backup-and-skip'` for derived/disposable records; close the handle in `ctx.effect`.
5. **Fresh install must not need any bundle other than the shipped ones.** `dsh-base` already provides
   storage, sessions, presets, settings, workspace registry and filesystem — the portable core may rely on
   those, and on nothing profile-specific.
6. **The client half (Phase 4+) is a real Cordis client plugin**: declare `dsh.client = {platform:'web',
   inject:[…]}` in `package.json`, register only into declared slots, and dispose through the returned
   disposer / `ctx.effect`. Never inject DOM.
7. **Session creation uses `prepare → (bind preset/course/memory) → enter → announce`** so a partial failure
   never announces an incorrectly bound first turn (Phase 4 acceptance wording).
8. **Course binding happens before the first model/tool turn**, via `agentPresets.select` plus
   `sessions.create` meta/`SessionHeader` — the native layer records `cwd` and `agentPreset`.
9. **Academic folder is a workspace, not the runtime.** `workspaceRegistry.create/resolveByPath`;
   a missing folder must not disable general Professor conversation.
10. **Keep the existing invariants** (course isolation, source truthfulness, evidence-gated learning state,
    safe artifact roots, no silent overwrite, explicit format gate). Customization must not weaken them.

---

## 11. Readiness assessment for Phases 1–8

| Phase | Prerequisite from Phase 0 | Readiness |
|---|---|---|
| 1 — Self-contained identity & course-free bootstrap | `skills`/`tools`/`fs` registry on a profile with no legacy data; config via profile | **Ready** |
| 2 — Persistent memory & bounded context | `storageDomain` contract (§6), `agentPresets.resolve` | **Ready** |
| 3 — Academic-folder onboarding & indexing | `workspaceRegistry`, `workspaceFiles`, `fs` policy | **Ready** |
| 4 — Thin UI shell & native-session routing | slots `sidebar.panellist`/`main`/`settings.section`, `clientModules`, `sessions.prepare/enter/announce`, `agentPresets.select`, `layout.selectPanel` | **Ready**, with the §9 unverified items verified *in this phase* |
| 5 — Deterministic skill customization | storage domain + existing skill provider/context mechanism | **Ready** |
| 6 — Course view & compact settings | Phase 4 UI surface + `settings.section` + backend services from 1–5 | **Ready** |
| 7 — Fresh-install release gate | client-half packaging (`dsh.client`) proven on a clean profile | **Ready**, packaging path to be proven in phase |
| 8 — Independent final audit | evidence tables from 0–7 | **Ready** |

**Blocked requirements:** none.
**Design change requested:** none.
**Recommended host prerequisite for later phases:** treat `dsh-permission-rules@0.7.9` on host
`0.2.0-rc.2` as out-of-contract; keep it out of disposable acceptance profiles, and ask the user before
touching the two affected logs.
