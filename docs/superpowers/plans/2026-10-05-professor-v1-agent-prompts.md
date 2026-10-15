# Professor v1 Audit and Phased Agent Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL where available: use superpowers:executing-plans to execute one phase at a time. Use test-driven development for implementation and verification-before-completion before reporting success. Do not dispatch additional agents without the user's authorization.

**Goal:** Extend the existing Professor core into the portable, lightweight academic plugin specified in `Professor_Plugin_v1_Project_Plan.md`.

**Architecture:** Preserve the existing tools, course configuration, extraction, provenance, artifacts and learning state. Add portable application storage, deterministic customization, academic-folder onboarding and a thin UI through supported Harness APIs. Native Harness owns conversations, permissions, attachments, models and history.

**Tech Stack:** Existing JavaScript ESM / Cordis plugin and Node test runner; the frontend and persistence integration must be selected from verified installed Harness APIs, not invented APIs.

## Current audit — 2026-10-05

Repository: `/Users/<user>/Documents/Project/professor-harness-spike-plugin`.

Authoritative new specification: `Professor_Plugin_v1_Project_Plan.md`, especially sections 5, 32, 34, 35 and 37. The old M0–M12 completion statements refer to the previous preset implementation, not the new M0–M8 application milestones.

| New milestone | Current assessment | Evidence and gap |
|---|---|---|
| M0 audit/safety | Partial | Source and Git inspected; existing tests available. Still on main, only baseline f2cbd25 committed, later fixes uncommitted. Current UI/API and live activation audit still required. |
| M1 portable core | Partial; semantic conflict | Persona and six skills bundled, but course-management skill mandates legacy Registry/Knowledge setup and latex skill suggests PERSONAL_AGENT_ROOT template. No proven course-free application bootstrap. |
| M2 memory | Partial foundation | Existing evidence-gated project learning state and session binding. No verified application-global preference store or complete new-session context hydration/restart workflow. |
| M3 academic folder | Partial foundation | Existing explicit initialization/registration/index/extract/search. No normal-user folder onboarding and course discovery/confirmation flow. |
| M4 independent UI | Not implemented in inspected source | cordis.patch.yml adds a preset; src/plugin.js registers tools/skills, not Home/sidebar surfaces. A workspace named Professor is not proof of an independent plugin entry. |
| M5 course UI/routing | Partial foundation | Course binding exists; course browser, native-session launcher, academic metadata and supported session separation are missing. |
| M6 customization | Not implemented | Imported registry_fields preserve data but are not a global/course skill overlay system. |
| M7 settings | Not implemented as UI | Tool diagnostics and configuration exist, not supported compact user settings surfaces. |
| M8 fresh release gate | Not satisfied | Existing package/activation checks do not prove the new 21-step fresh-install product workflow. |

Previously fixed behavior remains in source: lossless import output, per-course note roots, supplementary classification, explicit artifact format gate, preserved registry fields and multiline YAML roundtrip.

Current confirmed course configuration: six active courses with separate note roots, global format ask, code/course-info supplementary classification. This is personal data, not evidence of portable onboarding.

Historical validation: October 1 full verify, 28 E2E scenarios and real Harness checks passed. October 5 earlier status inspection reran 215 tests successfully. A fresh audit run is recorded in the accompanying chat; agents must rerun after their own changes.

Unresolved historical issue: old session `session-a466a3a2-5f5d-45bc-a6c7-f01b1f8b7e33` failed on `permissionRules/decision`. Its current condition was not rechecked by this source audit. Do not alter session logs to fix routing or hide the error.

## Execution order and rules

Execute phases 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Each prompt below is a separate handoff. Give the next agent the previous phase report and commit identifier. Do not run multiple implementation agents against the same files concurrently.

Phase 0 is a hard feasibility gate: if supported sidebar/settings/session APIs are missing, report the blocked requirements and prerequisite host version/API. Independent backend phases may continue only with an explicit scoped decision; do not represent a preset fallback as v1 UI completion.

File locations proposed below are implementation boundaries, not claims that modules already exist. Keep existing patterns; record any justified path adjustments in the phase report.

### Shared instructions — include with every phase

```text
You are working on /Users/<user>/Documents/Project/professor-harness-spike-plugin.
Read Professor_Plugin_v1_Project_Plan.md completely. It is the authoritative v1 specification. Then read PROJECT_MEMORY.md and docs/superpowers/plans/2026-10-05-professor-v1-agent-prompts.md. Older documents describe a preset baseline, not completion of the new app milestones.

Inspect git status, branch, log and diff before editing. Preserve all existing modified and untracked work. Never use destructive cleanup, reset, blanket restore or history rewriting. Do not change the real desktop profile, real courses, old Registry/Knowledge or session logs as a shortcut. Use disposable profiles and fixture course trees for verification. Keep personal paths out of shipped runtime defaults. Ask before any action requiring additional authority, credentials, publication or destructive migration.

Extend the core; do not rewrite it. Keep course isolation, honest sources/page/slide references, evidence-gated learning updates, safe artifact roots, no silent overwrite and the current explicit format gate. Customization must not weaken these invariants. A fresh installation must work without Hermes/Personal-Agent and without any connected academic folder. Never infer study progress from file presence.

Use native Harness conversations and supported plugin APIs. No DOM injection, Harness fork, second chat runtime/database, custom PDF viewer, cloud sync, calendar, grades or analytics. Do not append plugin-specific events to a closed Harness session log schema. Legacy import is explicit and optional.

For implementation: write a targeted failing test, run it and verify the expected failure, implement the minimal change, rerun it, then run relevant regressions. At phase completion run npm test, npm run verify:e2e and git diff --check; run real Harness validation for integration changes. These commands cannot prove new features unless feature-specific tests exist. Do not report mock-only tests as live verification. Report unsupported capabilities, failed checks and permissions separately.

Use milestone commits only after inspecting the staged scope. Never stage unrelated changes. Update README.md, PROJECT_MEMORY.md and a phase status report with implemented behavior, actual commands/results, branch/commit, changed files, user/source files modified, risks and next phase. Do not use historical test counts as current evidence. Stop at this phase's boundary.
```

## Phase 0 — Safety baseline and supported Harness API gate (M0)

**Relevant files:** existing `index.js`, `cordis.patch.yml`, `src/plugin.js`, `src/skills/provider.js`, `src/state/course-binding.js`, `tools/verify-*.mjs`; create `docs/v1/HARNESS_API_AUDIT.md` and `docs/v1/STATUS.md`.

```text
Execute Phase 0 only. This is an audit and integration-feasibility task, not permission to build the new UI yet.

1. Run git status --short, git branch --show-current, git log --oneline -10 and git diff --stat. Inventory existing modifications and untracked files. Read the six bundled skills, all project architecture documents and the tools/provider composition. Separate prior repairs from new v1 work.
2. Run npm run verify and npm run verify:harness in disposable environments. Obtain required local-listen permission normally if sandbox limits activation. Capture exit codes, counts, pending children and failure reasons. Confirm the actual installed Harness version and package resolution used by desktop versus verifiers.
3. Inspect installed official Harness packages, declarations and reference plugins. For sidebar registration, route/view mounting, frontend assets, settings/config persistence, local storage, session create/open, runtime preset selection, course-binding timing, native conversation navigation and session classification/separation, record exact module/export/signature, version, file evidence and lifecycle. Read-only local source inspection comes first; do not infer APIs from product screenshots or invent method names. Use official sources if online research is needed.
4. Verify each required API with the smallest disposable real-host experiment. Demonstrate register/unregister and native-session creation without writing the user's profile. Confirm whether a no-workspace conversation can use Professor and whether plugin disable removes the UI cleanly. Record unsupported features explicitly.
5. Check the historic permissionRules/decision failure without editing or filtering logs. Record the observable host/log compatibility condition; do not speculate that a version mismatch is proved without evidence. Separate this host issue from plugin defects.
6. Produce docs/v1/HARNESS_API_AUDIT.md with a supported/unsupported/unverified matrix and an implementation contract. If safe APIs are unavailable, STOP the affected milestone and identify the host prerequisite; no DOM hacks or silent preset fallback.
7. After validating and reviewing scope, preserve appropriate current work in a safety checkpoint and use feature/professor-portable-app for new implementation. Do not include unrelated files or publish/push. If checkpoint ownership is ambiguous, report it and ask before staging.

Acceptance: current baseline results recorded; actual host version known; every required integration has evidence or a named blocker; sources/history unchanged; safe Git checkpoint/branch verified or explicitly blocked. Report the readiness of phases 1–8 and stop.
```

## Phase 1 — Self-contained identity and course-free bootstrap (M1)

**Relevant files:** `cordis.patch.yml`, `src/paths/roots.js`, `src/skills/provider.js`, all `skills/professor-*/SKILL.md`, `tools/skill-sources.json`, `tools/verify-skill-sync.mjs`, `package.json`; proposed `src/core/` and `src/app/storage.js`; new portable-core tests.

```text
Execute Phase 1 only after reading the Phase 0 supported API/storage contract.

Make identity, constitution, six academic workflows and application bootstrap portable. Preserve working tools instead of replacing them.

Start with failing tests for a packaged installation in a temporary home with no Personal-Agent, Registry, Knowledge, PATHS.md, course folder, environment overrides or manually installed skills. Verify the Professor persona and all six skills load from the installed package, with no unresolved legacy path directing mandatory operations.

Audit delivered skill text, not just JavaScript. professor-course-management currently mandates 01_Learning/Registry files/template and old Knowledge roots; replace mandatory legacy operations with existing Professor tools and Professor-owned state. professor-latex currently suggests a PERSONAL_AGENT_ROOT shared template; use an explicitly configured template when valid, otherwise the existing self-contained generation path. Legacy import references may remain only as optional explicit workflows. Adjust source-sync manifests/tests honestly rather than silently disabling skill-sync verification.

Implement a supported Professor-owned application storage/bootstrap context for general academic sessions with no connected folder. An unbound general session must not silently inherit a different course or a service working directory. Existing course-required tools should fail descriptively when no course exists; general academic conversation and global memory must still work. Keep metadata separate from source materials and package files.

Prevent boot from depending on developer resources. Optional TeX/PDF/Office capabilities must report their observed availability and degrade honestly; they must not prevent a general Professor session from starting. Do not promise equivalent optional backends on every OS without tests.

Acceptance: actual installed package in an isolated real Harness profile starts a general Professor native session, persona and six skills are available, no legacy data is read as a requirement, and no course tree is created or guessed. Add tests for missing optional backends and no-course diagnostics. Document source-sync changes, portable storage location/ownership and unsupported platforms. Stop before memory content/UI features.
```

## Phase 2 — Persistent memory and bounded session context (M2)

**Relevant files:** reuse `src/state/{parse,write,conflicts,course-context,course-binding}.js`, `src/tools/state.js`; proposed `src/memory/{store,context}.js`, `test/memory.test.mjs`, restart integration verifier.

```text
Execute Phase 2 only. Use the supported persistence location established in phases 0–1.

Add versioned global academic preferences and minimal course memory (recent topic, last native Professor session, stable course instructions). Reuse PROGRESS/KNOWLEDGE/MISTAKES for learning memory; do not create parallel learning records or store conversation messages. Separate durable preference evidence from learning evidence and temporary session instructions. Provide explicit read/update interfaces with JSON-lossless results.

Before implementation write tests for: empty first install; explicit stable preference saved; casual/temporary utterance not promoted; learning update rejected without evidence; persistence across process restart; a genuinely NEW native session retrieves relevant global/course state; course A does not receive course B's memory; unbound sessions do not infer a course; concurrent revision conflicts preserve original data; corrupt/newer schema returns a clear non-destructive error.

Build a bounded, deterministic context loader invoked through the verified session-start/runtime API. Define character/item budgets and return diagnostics for omissions. Do not replay large old chats. Do not hydrate memory by reopening the previous session. Define disabled-memory semantics: no automatic persistence/retrieval while disabled, no deletion of existing memory, and honest status.

Acceptance: in a disposable real profile, save an explicit stable preference and one evidence-backed learning result, close/restart Harness, create a NEW Professor session and prove relevant memory is loaded from the persistent store. Also prove temporary preference and another course's data are absent. No legacy learning migration. Record exact evidence and stop.
```

## Phase 3 — Academic-folder onboarding and derived indexing (M3)

**Relevant files:** reuse `src/project/project.js`, `src/courses/registry.js`, `src/indexer/`, `src/extract/`, `src/paths/policy.js`; proposed `src/workspace/{onboarding,detect}.js`, `test/onboarding.test.mjs`.

```text
Execute Phase 3 only. Build backend onboarding that a later thin Settings UI can invoke; do not require users to edit YAML or import Hermes.

Implement folder validation, bounded read-only discovery, proposed course/category mapping, explicit ambiguity confirmation, accepted configuration persistence, initial index/extraction and incremental update/rebuild using existing services. Discovery must not mutate config until the user confirms the proposal. Folder changes must not delete old source files or learning memory, and a missing/disconnected folder must not disable general Professor conversation.

Write fixture tests containing CSC3200, STA2001, ambiguous Algorithms/Math folders, duplicate course codes in different terms, unrelated folders, inaccessible paths and symlinks escaping the approved root. High-confidence course codes may be suggested; ambiguous identities must require confirmation/editing. Preserve stable course identities on repeated connection. Model identity using existing course configuration, not a second registry.

Use existing categories, including supplementary. 06_Code and 00_Course-Info are not exams. Do not treat generated notes, .professor metadata or cache as source materials. Apply canonical path policies and validate artifact outputs.

Hash/stat fixture source files before/after discovery, confirmation, extraction, failed operations and rebuild. All originals must be unchanged. Indexes are derived and rebuildable, but memory is not disposable index data. Exercise adding, changing and removing files; update affected records/chunks, exclude removed stale content from search and demonstrate unchanged extraction is reused. Do not add an unconditional full extraction scan on every app start; report the observed incremental strategy and limits.

Acceptance: confirmed onboarding creates configuration/index without hand edits; ambiguous proposals remain pending until confirmed; materials are searchable with honest source coordinates; incremental operations and explicit rebuild pass; source snapshots match; no fake learning progress. Stop before frontend implementation.
```

## Phase 4 — Thin independent UI shell and native-session routing (M4 + M5 routing)

**Relevant files:** verified bundle/frontend integration from Phase 0; proposed `src/app/{service,sessions}.js`, `src/ui/` Home and launcher; reuse `src/state/course-binding.js`; integration/disable tests.

```text
Execute Phase 4 only and only if Phase 0 proved supported UI/session APIs.

Add a true dedicated Professor sidebar entry and Home through supported APIs. A project named Professor or a preset dropdown is not acceptance. Keep native Harness conversations untouched. Home contains only Continue, Courses, Recent Professor Sessions, New Study Session and Settings navigation, including the no-course empty state with Start chatting and Add academic folder actions.

Implement a thin session-launch/routing adapter shared by Home and future Course UI. Fields: optional course, mode (Learn/Question/Assignment/Review/Exam/Free), optional topic. Create/open a native Harness session, activate Professor runtime, bind the chosen course BEFORE the first model/tool turn, hydrate relevant bounded memory, and navigate to the native conversation using verified APIs. General sessions remain valid with no course.

Persist only minimal academic session metadata linked to harnessSessionId: course identity or null, title, mode, updatedAt. Never duplicate messages/history. Treat unavailable/deleted native sessions as missing, not silently recreate history. If creation succeeds but binding/hydration/navigation fails, report partial failure and allow safe retry without launching an incorrectly bound first turn or creating duplicates.

Use supported classification/presentation APIs to separate Professor sessions from normal project workflows. Do not delete or modify session logs, append unknown events or hide sessions via DOM manipulation. If required separation cannot be supported, stop and report the unmet requirement.

Acceptance in real disposable Harness: enable shows the entry; click opens Home; general Start opens Professor native conversation; CSC3200/Learn/Hash Tables opens the correctly bound conversation; reopen/restart restores recent metadata; normal projects and sessions work unchanged; disable removes UI and disposes subscriptions, without deleting personal memory. Automated adapter/component tests alone are insufficient. Stop before full Course/Settings UI.
```

## Phase 5 — Deterministic skill customization (M6)

**Relevant files:** `src/skills/provider.js`, memory/application storage; proposed `src/skills/{customization,compose}.js`, `test/skill-customization.test.mjs`.

```text
Execute Phase 5 only. Add persistent overlays without editing bundled skills.

Define small validated customization records for language, explanation style, teaching depth, programming language and additional instructions, keyed by bundled skill name at global and course scope. Course mode supports Use global settings and explicit course additions. Store customizations outside the package and source tree, with schema/version and safe revision handling.

Composition order is built-in skill < global customization < course override < current explicit session instruction. Mandatory truthfulness, source safety, course isolation, permissions and artifact-format gate are not user-overridable. Do not rely on unrestricted appended prose to enforce this boundary: document prompt boundaries and add adversarial tests while acknowledging model behavior cannot be guaranteed by string assembly tests alone.

Extend the existing provider/context mechanism using APIs established in Phase 0. Prevent skill cache contamination: loading CSC3200 must not cause later STA2001/general sessions to receive CSC3200 overlays. Keep current temporary instructions ephemeral unless separately explicitly saved. Define bounded record/prompt sizes, invalid values, reset-to-global semantics, corruption/newer-version handling and concurrent updates.

Tests: global detailed explanations plus CSC3200 C++ and STA2001 intuition overrides; current explicit Python overrides course C++ for that session only; switching courses yields correct composition; reset inherits global; upgrades/reinstall preserve overlay files; checksums of bundled skills remain unchanged; saved format preference cannot bypass the current format gate; malicious instructions cannot grant filesystem access.

Acceptance: deterministic tests and real NEW native sessions show different intended course behavior; no bundled skill writes, no duplicate memory/registry, no cross-course leakage. Report actual prompt/context and observed behavior separately. Stop before customization frontend.
```

## Phase 6 — Course view and compact settings (remaining M5 + M7)

**Relevant files:** thin `src/ui/` Course/Materials/Settings surfaces and `src/app/service.js`; existing course tools/configuration, onboarding, overlays, memory and session adapter.

```text
Execute Phase 6 only. Reuse backend services from earlier phases; do not put academic logic into UI or create a second configuration subsystem.

Course view: identity, recent native Professor sessions, category/count summary, simple indexed material browser, Study/Ask Professor actions and New Study Session. Show unavailable/missing files honestly. Material actions use stable indexed identifiers and existing source validation, then route to native Harness with the chosen course/material context. No custom PDF viewer or editor.

Settings: General enable/status, academic folder change/connection, course management, lightweight global/course skill customization, persistent-memory toggle/status, index state/rebuild and diagnostics. Course fields map to existing code/name/source root/output/special-instruction/status and overlay records. Identity changes must not orphan existing learning state: preserve current immutable-ID rules and return actionable guidance. Avoid unapproved source reorganization.

Make folder ambiguity confirmation part of onboarding UI. Provide pending/running/success/failure states, prevent duplicate submissions and show unsupported capabilities without calling them Ready. Rebuild affects derived indexes only, not memory or originals. Missing folder/general mode and disabled memory must be clearly represented. Reuse native controls where supported; keep the UI accessible with keyboard navigation and labels.

Write component/service tests for empty state, permission denial, invalid output folder, ambiguity, rebuild failure, missing native session, course switching, customization reset and memory toggle. Real-host acceptance: install/enable, connect fixture folder, confirm courses, browse materials, change a skill, start studying, rebuild and inspect health WITHOUT opening YAML. Verify source snapshots and normal Harness workflows remain unchanged. Stop before release packaging/sign-off.
```

## Phase 7 — Fresh-install release gate and package portability (M8)

**Relevant files:** `package.json`, `cordis.patch.yml`, distribution/activation verifiers; proposed `tools/verify-v1-fresh-install.mjs`, fixture integration tests, `docs/v1/ACCEPTANCE.md`.

```text
Execute Phase 7 only. Prove the product, not just the source checkout.

Pack the plugin and install the produced artifact into a completely disposable Harness profile/home. Verify the installed package has all runtime/frontend assets, built-in core/skills, memory mechanism and contracts; it must not resolve resources through the developer checkout or real home. Inspect runtime output for absolute developer paths, required legacy roots and missing packaged assets. Document the supported GitHub install route and host versions with actual evidence; do not publish/push or use credentials without explicit authorization.

Implement repeatable acceptance coverage for all 21 steps of M8 in the authoritative plan: packaged install; start; sidebar; Home; course-free academic session; identity; skills; tools; stable preference; restart; memory restoration in a new session; fixture academic folder; discovery; indexing; unchanged originals; global Study customization; one-course customization; course session; effective composition; restart; restored Home course/session state.

Use deterministic harness/service tests for repeatability, then real Harness verification for sidebar, native routing, lifecycle and restart. Where a model turn is required, obtain the normal model/network authorization and record actual observed behavior; do not label a mocked persona assertion as proof of a real model interaction. Mark unavailable steps BLOCKED, not passed.

Also verify upgrade from the existing project schema preserves IDs, memory, preferences and safe outputs; disable/re-enable does not delete data; missing optional extraction/TeX backend degrades; no registered UI/tool leaks into ordinary sessions; no unknown session events are written. Hash fixtures and bundled skills before/after. Run npm run verify and npm run verify:harness plus all new acceptance tests.

Acceptance: complete M8 evidence table with commands, host version, packaged artifact identity, clean-profile isolation, pass/fail/blocked per step and original-file invariance. If any release requirement fails, state NOT RELEASE READY and hand back a bounded fix list. Stop before final documentation sign-off.
```

## Phase 8 — Independent final audit and factual handoff

**Relevant files:** `README.md`, `PROJECT_MEMORY.md`, `docs/v1/STATUS.md`, `docs/v1/ACCEPTANCE.md`, `docs/PARITY.md`, `docs/AUDIT.md`, old `docs/PLAN.md`.

```text
Execute Phase 8 as an independent acceptance audit. Do not assume preceding agents' completion claims are true.

Map EVERY checkbox in section 37 of Professor_Plugin_v1_Project_Plan.md to implementation, automated tests and real-host evidence where required. Inspect the actual final package and Git commits, rerun full verification, and compare evidence to M0–M8 acceptance. Distinguish verified, implemented-but-unverified, blocked and out-of-scope. Any missing mandatory requirement means v1 is not complete.

Check all non-negotiable behaviors, no-course use, memory restoration in a new session, skill overlay precedence, original-file invariance, supported UI and native session separation. Explicitly verify no session-log edits, second conversation database or automatic Hermes migration was introduced. Do not conflate intentional OCR/visual limits with the new required UI/memory work.

Update README, architecture/status docs and PROJECT_MEMORY with current install/enable/use flow, supported host/platform/dependency limits, data ownership/storage, actual test counts, milestone commits, remaining risks and precise recovery instructions. Label old preset milestones as historical. Do not claim 1:1 Hermes parity or production readiness from old test counts. Preserve the authoritative new design document unless the user approves a design change.

Deliver a concise Chinese final report with each v1 milestone's status, all unmet release criteria, the accepted package/commit and one next action. If fixes are needed, generate narrowly scoped English follow-up prompts instead of doing a broad rewrite during audit. Commit only the reviewed documentation changes with authorization; do not publish a release automatically.
```

## Coverage and handoff checklist

- [ ] Phase 0: safety checkpoint, real host/API feasibility, old-history issue distinguished.
- [ ] Phase 1: bundled constitution/workflows, no legacy dependency, course-free bootstrap.
- [ ] Phase 2: global/course persistent memory, evidence safety, bounded new-session restoration.
- [ ] Phase 3: folder validation/discovery/confirmation, derived incremental indexes, source safety.
- [ ] Phase 4: dedicated sidebar/Home, native session adapter, metadata/separation, lifecycle.
- [ ] Phase 5: immutable built-ins, global/course/session precedence, upgrades preserve overlays.
- [ ] Phase 6: Course/material browser, lightweight settings, no manual configuration.
- [ ] Phase 7: packaged GitHub route and all M8 steps, regressions, upgrade and clean profile.
- [ ] Phase 8: every definition-of-done item independently evidenced; current documentation/Git.

Legacy Knowledge import, profile export/import, cloud sync, OCR, viewers and analytics are not newly scheduled features. Do not silently promote them into v1. Persistent memory capability is required; preexisting personal memory content is not.
