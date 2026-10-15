# Professor Plugin v1 — Phase Status

> Append-only status ledger for the v1 phased plan.
> Source of truth for scope: `Professor_Plugin_v1_Project_Plan.md`.
> Phase prompts: `docs/superpowers/plans/2026-10-05-professor-v1-agent-prompts.md`.
> This file records **factual** status only. “Code exists” is never recorded as “complete”.

## Status vocabulary

### Current status — 2026-10-12 (Mac integration acceptance and release preparation)

**Scope of this entry:** it records today's fresh evidence and corrects the checklist rows it
depends on. It does **not** rewrite any dated entry below; those remain historical records of the
day they were written.

**Fresh verification this round (all exit 0):**

| Check | Result |
|---|---|
| `npm test` | **744 tests — 744 pass, 0 fail, 0 skipped**, run 2026-10-12 with the enhancement runtime configured (`DSH_PROFESSOR_ENHANCE_PYTHON=/tmp/professor-auto-prepare/env-e270c763ff8847c4562c/bin/python`, backend `pdfium`, `DSH_PROFESSOR_PYTHON` left unset), so `test/material-enhance-production.test.mjs` **ran and passed**. The earlier `no prepared enhancement runtime configured` skip is a **dated record of a run that did not configure that runtime** — an unset variable or a missing workspace cache says only that; it does not mean no runtime exists on the machine |
| `npm run verify:e2e` | **28/28** |
| `npm test` (after the N2 fixture was added) | **765 tests — 764 pass, 0 fail, 1 skip**, `npm run verify` **exit 0**, re-run 2026-10-13 after the N2 source-grounded block completed. The 21 new tests are `test/source-grounded-notes.test.mjs`. The 1 skip is the pre-existing dated `material-enhance-production` skip (enhance runtime not configured **in this run**) — the 744/744 row above is that other run's record and is left untouched. Evidence: `docs/qa/2026-10-12-source-grounded-notes/REPORT.md` |
| `npm run verify:syntax` | **177 files** parsed, ALL PASS |
| `npm run verify:skills` | **39 checks**, ALL PASS |
| `npm run verify:sync` | **89 checks**, ALL PASS |
| `npm run verify:dist` | **70 checks**, ALL PASS (asserts 22 tools / 6 skills / 5 presets in the installed copy) |
| `npm run verify:harness` | **266 checks, 0 FAIL**, all 8 segments ALL PASS |
| `npm run verify:packaged` | **94 checks**, ALL PASS (207 packed files byte-identical after install) |
| `npm run verify:native-session` | **47 checks**, ALL PASS (session's own surface: 2629-char persona, 22 `professor_*` of 35 tools, 6 skills) |
| `npm run verify:teaching-aggregate` | rebuilt offline, 0 model calls: inventory complete 8/8, `counts.passed: 6`, `counts.open: 2`, `all_passed: false`, inputs byte-identical |

**Verified inventory this round** (counted from source, cross-checked against independent gates):
**22** `professor_*` tools, **6** bundled skills, **5** built-in teaching presets
(`builtin-progressive`, `builtin-socratic`, `builtin-exam-review`, `builtin-coding`,
`builtin-quick-answers`). Three acceptance verifiers had stale expected tool lists (18/18/21) and
were corrected to 22; `verify:activation` now also asserts the visible `professor_*` set equals the
expected list exactly, so a missing tool fails as loudly as an unexpected one.

**Implemented capability described correctly:** Mac **PDF OCR / enhancement is implemented on the
read path** — `professor_material_read`'s `enhance` action runs bundled `enhance_pdf.py` with
sha256-pinned OCR models and network disabled, using automatic hash-locked workspace runtime
preparation. The **index-extraction path (`professor_extract`) still performs no OCR**: scanned and
image-only PDFs stay `unsupported` and `capabilities.pdf.ocr` is `false`. Standalone image OCR and
real Windows/Linux host enhancement acceptance remain open (`professor_diagnostics.notImplemented`).

**Phase position:** Phase 0–5 Verified. **Phase 6 and Phase 7 are partially evidenced, not
globally complete. Phase 8 and full Mac release readiness stay open** until their actual criteria
pass — see the corrected checklist rows below.

**Retained limitations (unchanged this round):**

- **Cross-platform testing is deferred by explicit user instruction (2026-10-11).** Windows/Linux
  and macOS Intel are unverified and are no longer active blockers; the Apple Silicon Mac path is
  what is being evidenced.
- **Host API limitation — archiving is not permanent deletion.** `workspaceRegistry.archiveSession`
  is supported; permanent native chat deletion is not. Clearing a Recent row archives/hides it and
  must never be described as deletion.
- **Historical `permissionRules/decision` replay** remains an older unresolved compatibility item.
- **Home browser rendering, a model turn inside a launched session, and permanent native deletion**
  are reported `UNVERIFIED` by the verifiers that touch them.
- **Teaching-interaction live-model acceptance is 6/8 with S3/S5 OPEN.** The user's "Accept and
  close" is scope closure with retained limitations, **not** an eight-case PASS claim; automated
  screening and human adjudication are reported separately in
  `docs/qa/2026-10-12-teaching-interaction/live-model/aggregate-assessment.json`. S3/S5 are not to
  be reopened without a direct human instruction, and any further retest needs new explicit
  authorization.
- **No paid model call, real-profile edit, commit, push or publication happened in this round.**

### Latest Phase 5 acceptance — 2026-10-07

Phase 5 backend/native content and persistence are Verified, not model-observed behavior.
Full verify 398/398, E2E 28/28; packed course/reinstall/new-process acceptance and the complete
Harness/Home/packaged/native/memory/onboarding regression matrix exit 0. Independent review:
no Critical/Important blocker. Profile, bundled skills and original fixture materials unchanged.
Settings frontend remains Phase 6; entire v1 is not release-ready. See PHASE5.md.

### Latest Phase 4 final acceptance — 2026-10-07

Phase 5 backend checkpoint subsequently added: fresh `npm run verify` exit 0, 397/397 tests
and E2E 28/28; `verify:home` exit 0 after fixing the preset isolate-realm compatibility regression.
Phase 5 remains In progress, not Verified; see PHASE5.md for unexercised native course/restart gates.

Approved UI-first scope **Verified**, not the entire v1. Fresh `npm run verify` exit 0:
381/381 tests, zero failed/skipped; E2E 28/28. `verify:home`, `verify:harness` (all eight stages),
`verify:packaged`, `verify:native-session`, `verify:memory-restart`, `verify:onboarding` exit 0.
Real Chrome separately verified Home/launcher/native navigation/continue/plugin disable and
re-enable with retained metadata. Cold-process reopen is packaged backend evidence, not browser
restart evidence. Independent final narrow re-review found no remaining blocker (51/51 targeted).
Session separation is deferred; model turns and Phase 5–8 are not complete. Real profile/source
materials/user logs unchanged; no desktop installation, remote push or merge. See PHASE4.md.

`Not started` / `In progress` / `Implemented but unverified` / `Verified` / `Blocked`

**Verified** requires: implementation + feature-specific automated tests + *real Harness verification
wherever UI, runtime activation, native-session routing or restart behaviour is involved*.

## Phase checklist

| Phase | Milestone(s) | Title | Status | Note |
|---|---|---|---|---|
| 0 | M0 | Safety baseline and supported Harness API gate | **Verified** | See report below. The checkpoint that this pass deferred was created on 2026-10-06 (`368b8dc`, `a63c925`) — see §Git in §Phase 1 third re-verification. |
| 1 | M1 | Self-contained identity and course-free bootstrap | **Verified** | All six Phase 1 acceptance criteria now have evidence, on the real host and against the **packed artefact** in a disposable profile — including the first clause, which the earlier passes left unexercised: the installed package **starts a genuinely native general Professor session** (`ctx.agents.create` + `ctx.agentPresets.select`), and that session's *own* assembled prompt, tool view and skills were read back. See §Phase 1 third re-verification. Four acceptance-gap defects were found, reproduced and fixed across the first two re-verification passes. **Model-observed behaviour** (a model turn, model-driven tool selection) is a **Phase 7/8** requirement, needs credentials/network/spend, and is reported `UNVERIFIED` on every run — never as Verified. |
| 2 | M2 | Persistent memory and bounded session context | Verified (native integration; no model turn) | 286 tests; packaged new-process restore passed. See PHASE2.md and the takeover acceptance below. |
| 3 | M3 | Academic-folder onboarding and derived indexing | Verified (backend and packaged execution) | 319 tests; real onboarding/restart passed. UI remains Phase 4/6. See PHASE3.md. |
| 4 | M4 + M5 routing | Thin independent UI shell and native-session routing | Verified — approved UI-first scope | Packed Home/native/cold-reopen and real browser launch/continue/disable/re-enable verified. Ordinary listings unchanged; separation deferred. No model turn. See PHASE4.md. |
| 5 | M6 | Deterministic skill customization | Verified (backend/native content; no model turn) | 398/398 tests; packed two-course isolation, reset, reinstall preservation and separate-process restore pass. Frontend is Phase 6. See PHASE5.md. |
| 6 | M5 + M7 | Course view and compact settings | **Partially evidenced — NOT globally complete** | Fresh 2026-10-12: `npm test` 744, `verify:harness` 266 checks, `verify:home` native/backend paths pass. Folder onboarding (scan/ambiguity/folder change), course management, material-context handoff, memory switch, rebuild/diagnostics and the native study entry each have dated evidence; the **full Phase 6 error/responsive/theme browser matrix has not been run**, and browser rendering plus a model turn inside a launched session remain `UNVERIFIED`. See PHASE6.md and its 2026-10-12 append. |
| 7 | M8 | Fresh-install release gate and package portability | **Partially evidenced — NOT globally complete** | Fresh 2026-10-12: `verify:dist` 70, `verify:packaged` 94, `verify:native-session` 47 and `verify:harness` 266 all ALL PASS. Still required for closure: the **complete ordered Mac fresh-install release sequence run end to end**, the observed model turn the phase text asks for (needs its own explicit authorization), and a re-check of the `CODEBUDDY_BROKER_DENY` sandbox note on an unsandboxed shell. |
| 8 | — | Independent final audit and factual handoff | **Open — criteria not met** | Full Mac release readiness is **not** claimed: Phase 6's browser matrix is incomplete, Phase 7's ordered release sequence has not been run end to end, live-model teaching acceptance is 6/8 with S3/S5 OPEN, cross-platform testing is deferred by instruction, and permanent native deletion remains unavailable at the host API level. |

---

## Phase 0 — Safety baseline and supported Harness API gate

**Status:** Verified
**Date:** 2026-10-05 (Asia/Shanghai)
**Branch:** `feature/professor-portable-app` (created from `main` @ `f2cbd25`)
**Commit:** none — the Phase 0 safety checkpoint commit is **deferred** pending the user's decision on
staging pre-existing work (see §Git).

### What was implemented

- `tools/verify-harness-api.mjs` — **new** disposable real-host feasibility probe (`npm run verify:api`).
  Boots the real Cordis loader in a fresh `mktemp -d` `DSH_HOME`, composes the shipped `web` template plus
  this bundle, asserts the presence of the 17 host services v1 depends on, and exercises the smallest real
  operation for each data-bearing one (client roster, session creation, preset resolution, storage-domain
  round-trip), then proves the real desktop profile was not written.
- `docs/v1/HARNESS_API_AUDIT.md` — **new** supported/unsupported/unverified matrix and the binding
  implementation contract for Phases 1–8.
- `docs/v1/STATUS.md` — this file.
- No change to `src/`, `skills/`, `cordis.patch.yml` or any product behaviour.

### What was actually verified

| Check | Command | Result |
|---|---|---|
| Baseline product suite | `npm run verify` | **exit 0** |
| Unit/integration count | `npm test` (inside `verify`) | **215 / 215 pass, 0 fail**, ≈30.7 s |
| Harness composition + real activation | `npm run verify:harness` | **exit 0** — all 6 stages `ALL PASS` |
| ├ `verify:host` | real `assertSupportedJsonSchema` + real `ToolRuntime.register()` of all 15 tools | ALL PASS |
| ├ `verify:activation` | real Cordis loader, real preset registry, 13/13 child rows active | ALL PASS |
| └ `verify:desktop` | real desktop bundle list + patch layer replayed | ALL PASS |
| Feasibility gate | `npm run verify:api` (new) | **ALL PASS** (29 checks, 0 fail, exit 0) |
| Whitespace hygiene | `git diff --check` | clean |

**Real-host evidence vs mocked tests.** `npm test` is largely a fake-host suite and proves the plugin's own
contracts only. `verify:host` / `verify:activation` / `verify:desktop` / `verify:api` all boot the *real*
installed Harness. The Phase 0 feasibility claims in §4 of the audit rest on the real-host runs plus
read-only inspection of the installed package tree — not on mocks.

**Host identity.** `0.2.0-rc.2` (desktop host), bundled node `24.18.1`, profile bundles
`dsh-base` + `dsh-web-app` + `dsh-experimental-agent-team-profile` + `dsh-permission-rules@0.7.9` +
`dsh-professor-spike` (`link:`).

### Files changed

| File | Change |
|---|---|
| `tools/verify-harness-api.mjs` | added (new probe) |
| `package.json` | added `verify:api` script |
| `docs/v1/HARNESS_API_AUDIT.md` | added |
| `docs/v1/STATUS.md` | added |
| `PROJECT_MEMORY.md` | updated with the Phase 0 handoff |

### User / source files modified

**None.** No course material, old Registry, old Knowledge, real desktop profile, real `project.yaml` or
session log was written. Evidence:

- the probe snapshots `~/.dsh/profiles/desktop/{package.json,cordis.patch.yml,cordis.yml}` by digest and
  asserts they are unchanged;
- the failing session log was decompressed **to `/tmp` only**; the original `.zstd` file was opened
  read-only, and `repair-session-logs.mjs scan` (read-only mode) was used;
- `git status --short` after the audit shows exactly the same set of pre-existing modified/untracked files
  plus the one new probe.

### Remaining failures, blockers and risks

1. **No blockers.** Every integration Professor v1 needs has a supported API with live evidence
   (audit §4). No design change is requested.
2. **Unverified items deliberately deferred to their owning phases** (audit §9): end-to-end client-bundle
   registration from *this* package; enable/disable UI removal; the chosen session-separation composition;
   `agentPresets.select()` immediately before a first model turn; clean-profile packaging of a client half.
   Each has a named owner phase and a live acceptance step.
3. **Pre-existing, unrelated incompatibility:** `dsh-permission-rules@0.7.9` (declared host range
   `<0.2.0`) is installed into host `0.2.0-rc.2` and appends `permissionRules/decision` **without** the
   `ignorable` marker, so the read path refuses those logs. Read-only scan: **20 logs scanned, 2 affected,
   2 rows**. Repaired only by the upstream tool (`repair` / `strip`), which **modifies user data and was not
   run**. Corrected diagnosis: this is an out-of-contract third-party plugin event, not a plain host version
   mismatch and not a Professor defect. Risk: a new session in this profile can become unresumable —
   relevant to Phase 4/7 acceptance, which should use disposable profiles without that plugin.
4. **Pre-existing desktop activation warnings** (not Professor defects): `dsh-host-product-telemetry-otel`
   missing required `$.serviceVersion`, and `product-analytics` pending on `productTelemetry`.

### Git

- Branch created: `feature/professor-portable-app` (from `f2cbd25`). `main` still points at `f2cbd25`.
- New implementation work is on the feature branch. The working tree was **not** reset, cleaned or restored.
- **Checkpoint commit deferred and explicitly reported.** The tree carries ~23 modified files and ~13
  untracked paths that were authored by earlier agents (the import/format-gate/preference repairs described
  in `PROJECT_MEMORY.md`, plus the v1 plan and prompt documents). Staging them is an ownership decision for
  the user; per the phase prompt (“If checkpoint ownership is ambiguous, report it and ask before staging”)
  nothing was staged.
- Nothing was pushed or published.

### Next phase and prerequisites

**Phase 1 — Self-contained identity and course-free bootstrap (M1).**
Prerequisites satisfied: `ctx.skills` / `ctx.tools` / `ctx.fs` are mounted on a profile with no legacy data
(probe evidence), and the storage contract is defined (audit §6). Phase 1 must additionally work from the
Phase 0 contract and must read `docs/v1/HARNESS_API_AUDIT.md` before editing.

---

## Phase 1 — Self-contained identity and course-free bootstrap

**Status:** Verified. All six Phase 1 acceptance criteria have evidence (see the acceptance table below).
Two acceptance-gap defects were later found, reproduced and fixed — see **§Phase 1 re-verification**.
**Date:** 2026-10-05 → 2026-10-06 (Asia/Shanghai)
**Branch:** `feature/professor-portable-app`
**Commit:** none — the checkpoint commit is still **deferred** (§Git).

### What was implemented

- **Root binding is now explicit.** `src/paths/roots.js`: `resolveProjectRoot` became `async` and reports
  `{ root, source, bound, reason }`. The conversation workspace is a Professor root **only** when it holds a
  `.professor/` directory (or `DSH_PROFESSOR_PROJECT` names one). New `assertProjectBound` throws a domain
  error `PROFESSOR_PROJECT_MISSING` naming the workspace and the fix. `.professor/` — not `project.yaml` —
  is the marker, so an empty or half-built folder cannot masquerade as a course.
- **The whole course tool surface refuses an unbound workspace.** `src/plugin.js` gains
  `requireCourseProject`, which the **eleven** course-owned tools receive; the four lenient tools
  (`professor_paths`, `professor_diagnostics`, `professor_project_init`, `professor_course_list`) keep the
  reporting resolver. `policiesFor(root, roots, { bound })` drops the workspace from **both** read and write
  roots while unbound, as second-line defence, so even a tool that forgot its guard cannot create a
  `.professor/` tree in a directory the user never chose. All eleven tool modules were mechanically updated
  to `await resolveProject(exec)`.
- **Professor-owned application storage** (`src/app/storage.js`, new): domain `professor_app` @ v1 with one
  `app` table; lazy open (never part of `apply`), failure memoised, `close()` wired through `ctx.effect`;
  a one-off `bootstrap` record attributing the domain to this package; `describe()` for diagnostics.
  **Corrected after real-host evidence:** the domain ships its own dependency-free `valueSchema`
  (`APP_VALUE_SCHEMA`) — see §Risks 1, which is the most important finding of this phase.
- **Diagnostics + paths report the course-free state honestly.** `professor_paths` gained `projectBound` /
  `projectRootReason` and the application-storage block; `professor_diagnostics` gained
  `project.{bound,connected,reason}` and `appStorage`, plus a warning when no academic folder is connected
  and when storage is unavailable.
- **The delivered skill text was audited, not just the JavaScript.** `professor-course-management` was
  rewritten so the authority is the Professor project document reached through the existing tools; the
  mandatory `01_Learning` / Registry / template / old-Knowledge operations are gone, and the legacy import
  survives as a single **Optional** section routed through `professor_course_manage`. `professor-latex` now
  resolves a **configured** template when one is valid and otherwise generates a self-contained project —
  no shared `PERSONAL_AGENT_ROOT` template, no `06_Shared`.
- **The persona was rewritten** (`cordis.patch.yml`): an explicit two-mode section (course professor vs
  general academic assistant), `## 权威与顺序` naming `.professor/project.yaml` and the Professor tools, and
  `## 未连接课程时` stating that an unbound workspace is general mode, not a fault. The old
  `注册表 → INDEX → PROGRESS → KNOWLEDGE → MISTAKES → 源材料` chain is gone.
- **Source-sync verification was tightened, not muted.** `tools/skill-sources.json` gained a documented
  `portability` block and four *honest* divergences replacing two now-false ones;
  `tools/verify-skill-sync.mjs` gained a `// --- portability ---` rule that fails when a non-Optional section
  names a legacy token, when a declared Optional section is missing or unmarked, or when the persona
  contains a forbidden location.
- **New repeatable real-host probe** `tools/verify-app-storage.mjs` (`npm run verify:app-storage`), wired
  into `verify:harness`.
- `tools/verify-preset-activation.mjs` now also reads the **real skill registry** with the preset's own
  scope, so "the six workflows are available" is host evidence rather than an assertion about files.

### What was actually verified

| Check | Command | Result |
|---|---|---|
| Real-host chain (8 stages) | `npm run verify:harness` | **exit 0** — `preset`(32) `composition`(12) `boot`(27) `host`(48) `activation`(27) `desktop`(24) `api`(29) `app-storage`(44) all `ALL PASS`; **243 checks, 0 FAIL** |
| ├ six skills in the mounted preset | `verify:activation` (extended) | PASS — real `ctx.skills.list({ scope })` returns exactly `professor-course-management, professor-latex, professor-notes, professor-research, professor-review, professor-study`; the provider name is not leaked as a skill |
| └ application storage on the real host | `verify:app-storage` (new) | **exit 0, ALL PASS (44 checks)** — shipped spec opens; bootstrap written; bytes at `<DSH_HOME>/storages/professor_app.json`; **reopen after close** finds the marker and does not rewrite it; concurrent open refused (`already-open`); record round-trip; `close()` idempotent; a host without `ctx.storageDomain` reports `unavailable` without throwing |
| Source-sync + portability | `node tools/verify-skill-sync.mjs` | **exit 0, ALL PASS, 89 checks** (up from 79 — the portability rule was added, not swapped in) |
| Skill contract | `node verify-plugin-skills.mjs` | **exit 0, ALL PASS, 39 checks** |
| End-to-end fixtures | `node tools/verify-e2e.mjs` | **exit 0, 28 scenarios** |
| Syntax gate | `npm run verify:syntax` | **exit 0, ALL PASS**, 95 files parsed |
| Distribution | `node tools/verify-distribution.mjs` | **62/62, exit 0, ALL PASS** (re-run 2026-10-06 after the Phase 1 fixes). *Historical, 2026-10-05:* 61/62, the one failure being the installed-copy self-test through the sandbox denial later recorded in §Risks 2 — not a product failure. |
| **Product** test suite | `npm test` | **256/256 pass, 0 fail** (re-run 2026-10-06, 56.4 s, 235 pre-existing + 21 new). *Historical, 2026-10-05:* 234/235 run alone and 214/235 under concurrent load, every failure the `CODEBUDDY_BROKER_DENY` sandbox denial described in §Risks 2. **That denial did not recur** in the re-run; see §Phase 1 re-verification. |

**Real-host vs mocked.** The `verify:harness` chain boots the real Cordis loader with the shipped `web`
template plus this bundle in a fresh `mktemp -d` `DSH_HOME`, and `verify:app-storage` additionally hands the
plugin's real `createAppStorage()` the real `ctx.storageDomain`. The new Phase 1 unit tests
(`test/portable-core.test.mjs`, `test/portable-skills.test.mjs`) are a fake-host/textual-audit suite and are
labelled as such; they prove the plugin's own contracts, not the host's.

### Acceptance (Phase 1 prompt) — item by item

| Acceptance item | Evidence |
|---|---|
| installed package in an isolated real Harness profile | **`verify:packaged`** (added in §Phase 1 re-verification) — `npm pack` → `npm install` of *that tarball* into a disposable profile → all 113 packed files asserted byte-identical → real Harness booted → resources resolved from the installed copy, never the checkout. `verify:harness` (8 stages) additionally covers the source-linked profile. Real desktop profile byte-unchanged in both. |
| persona available | `verify:packaged` §5 — the host's own `ctx.systemPrompt.assemble({ scope })` returns a 2056-character Professor persona in the preset scope while the **global** scope keeps the ordinary coding persona, so the persona is proven present *and* correctly scoped. `verify:activation` adds `name: Professor`, `order: 20`, `broken === undefined`, all 13 child rows active |
| six skills available | `verify:activation` and `verify:packaged` — real skill registry, preset scope, exactly six names |
| no legacy data read as a requirement | `verify:skill-sync` portability rule + `test/portable-skills.test.mjs`; `verify:packaged` §3 proves the disposable home contains **no** Hermes / Personal-Agent / Registry / Knowledge artefact and that the only Professor skills present are the ones inside the installed package; §11 scans the runtime configuration this run resolves (2 profile manifests, 2 root entry trees, 2 installed patches) for any legacy reference and any path outside the disposable home and the host install |
| no course tree created or guessed | `verify:packaged` §7 — after diagnostics, `professor_paths`, a refused course tool and a lenient course tool, the workspace is still empty and no `.professor/` exists anywhere; `test/portable-core.test.mjs` asserts an unbound session creates **no** `.professor/` and never inherits a sibling course tree |
| tests for missing optional backends and no-course diagnostics | `test/portable-core.test.mjs` — bare host with no shell/Office/TeX still mounts 15 tools + 1 provider with no warnings; diagnostics report `appStorage: unavailable` and `projectBound: false`. `verify:packaged` §7 repeats the course-free diagnostics against the **installed** artefact |

### Files changed

| File | Change |
|---|---|
| `src/paths/roots.js` | binding rule, `assertProjectBound`, `PROFESSOR_PROJECT_MISSING` |
| `src/app/storage.js` | **new** — `professor_app` domain, `APP_VALUE_SCHEMA`, lazy open, bootstrap |
| `src/plugin.js` | `requireCourseProject`, bound-aware `policiesFor`, app storage wired via `ctx.effect` |
| `src/tools/*.js` (11 files) | `await resolveProject(exec)`; `paths`/`diagnostics` report the new state |
| `skills/professor-course-management/SKILL.md` | rewritten; legacy operations → Optional section |
| `skills/professor-latex/SKILL.md` | rewritten; configured template, else self-contained project |
| `cordis.patch.yml` | persona rewritten (two modes, authority, unbound behaviour) |
| `tools/skill-sources.json`, `tools/verify-skill-sync.mjs` | portability manifest + rule (tightened) |
| `tools/verify-app-storage.mjs` | **new** real-host probe |
| `tools/verify-preset-activation.mjs` | real skill-registry section |
| `tools/verify-distribution.mjs` | failure reporting now names the failing cases, counts and first cause (a four-line tail hid them) |
| `package.json` | `verify:app-storage` added; `verify:harness` extended to 8 stages |
| `test/portable-core.test.mjs`, `test/portable-skills.test.mjs` | **new** |
| `test/paths.test.mjs`, `test/classify.test.mjs`, `test/regressions.test.mjs` | updated for the binding rule (the "indexing without a project" exception is now refused, and the unassigned-material guarantee is re-anchored to an existing project) |
| `docs/v1/HARNESS_API_AUDIT.md` | §6.1 added, then **corrected** — see §Risks 1 |
| `docs/v1/STATUS.md`, `PROJECT_MEMORY.md`, `README.md` | this report |

### User / source files modified

**None.** No course material, old Registry/Knowledge, `PATHS.md`, real `project.yaml`, real desktop profile or
session log was read as a requirement or written. Evidence: every `verify:harness` stage snapshots
`~/.dsh/profiles/desktop/{package.json,cordis.patch.yml,cordis.yml}` by digest and asserts no change; all
scratch state lives in `mktemp -d` homes that are removed on exit; `git status --short` shows the same
pre-existing set plus the Phase 1 files.

### Remaining failures, blockers and risks

1. **FIXED, and the finding matters for Phase 2 — `valueSchema` is mandatory.** Phase 1 initially shipped
   `tables: { app: {} }` on the reading that a bare table worked. It only works **within one `open()`**: the
   host's domain loader calls `tableSpec.valueSchema.parse(raw)` for every stored record, so a schema-less
   table opens, accepts writes, and then **refuses to reopen** with
   `invalid-record: … does not match its schema`. Application storage would have worked until the next
   process start. The plugin now ships `APP_VALUE_SCHEMA`, a dependency-free validator implementing exactly
   the `parse()` the host calls. Two related facts, both verified: a **second concurrent** `open()` of the
   same domain is refused (`already-open`), and `invalidRecords: 'backup-and-skip'` is **not** honoured on
   the default `single` layout (the JSON backend implements `backupRecord` only for `per-record`), so the
   plugin does not declare it rather than claim a safety net it does not have. Audit §6.1 was corrected
   accordingly; `verify-app-storage` pins the reopen path so this cannot regress silently.
2. **Sandbox filesystem denials — RESOLVED IN THE CURRENT ENVIRONMENT; retained as dated history.**
   **Current (2026-10-06 re-run):** `npm test` is **256/256, 0 fail**, and `npm run verify:dist` is
   **62/62, exit 0** — including the installed-copy self-test that previously failed. **The
   `CODEBUDDY_BROKER_DENY` denial did not recur at all**, so it is not a property of this package.
   *Historical (2026-10-05):* `npm test` reported failing cases with one identical error,
   `CODEBUDDY_BROKER_DENY` / `Brokered host mkdir requires an available runtime file rule`, originating in
   WorkBuddy's own fs shim (`cli/vendor/shim/node-brokered-fs-shim.cjs`) and not in the plugin. Evidence
   that it was environmental and load-related rather than a regression:
   - **every** failing case had that same code and message — there was **no assertion failure anywhere**;
   - **the failure count tracked concurrency**: with heavy jobs running concurrently, 21 of 235 failed; run
     alone, **234 of 235 passed and the one failure was still the same denial**;
   - the same files passed on their own (`test/portable-core.test.mjs` 13/13, `test/session-binding.test.mjs`
     8/8) and from an outside cwd;
   - the identical suite passed 215/215 at Phase 0 and 234/234 mid-Phase-1;
   - a shadow copy built from the `files` whitelist reproduced the same denial class with a *different*
     count (10), ruling out anything tree-specific.
   *Consequence for Phase 7:* the denial is environmental and therefore must still be re-checked in the
   release environment rather than assumed away. The verifier was improved so a red run names the failing
   cases, the counts and the first cause instead of printing four anonymous lines.
3. **FIXED in §Phase 1 re-verification — the depth policy contradicted its own documentation.**
   `APP_VALUE_MAX_DEPTH`'s doc comment says depth counts *containers* (the record is depth 1, its members
   depth 2), but the guard ran before the scalar cases, so it also counted the innermost **leaf**. A legal
   32-container record was therefore refused at `$.next…next.leaf`. The bound is now checked on the value
   about to be descended into, which is exactly the documented rule. `test/app-storage-record.test.mjs` pins
   both the accepted boundary and the refusal one level deeper.
4. **Unverified items deliberately deferred:** the *native-conversation* acceptance items. The v1 items
   still owned by later phases remain as listed under Phase 0 §Remaining.
5. **Pre-existing, unrelated:** `dsh-permission-rules@0.7.9` (`permissionRules/decision`) and the two desktop
   activation warnings — unchanged, see Phase 0 §Remaining 3–4.

### Documented answers to the phase's documentation requirement

- **Source-sync changes.** `tools/skill-sources.json` now carries an explicit `portability` block
  (`rule`, `legacyTokens`, per-skill `optionalSections`, `personaFile`, `personaMayNotContain`) and four
  divergences that describe the real edits (Professor-owned table document; derived Knowledge Root; legacy
  import now Optional). `tools/verify-skill-sync.mjs` **gained** checks rather than losing them: a legacy
  token in a non-Optional section fails, a declared Optional section that does not exist or contains no
  legacy token fails, and a persona carrying a forbidden location or machine path fails.
- **Portable storage location and ownership.** Domain `professor_app` @ v1, one `app` table, owner
  `dsh-professor-spike`, record schema `professor.app/1`. The **host** decides the bytes:
  `<DSH_HOME>/storages/professor_app.json` (`~/.dsh/storages/professor_app.json` by default). Never inside
  the plugin package, never inside an academic folder. Opening is lazy and failure is reported, not thrown —
  a host without `ctx.storageDomain` still starts a general Professor session.
- **Unsupported platforms / optional backends.** `sh -c` is how extraction and LaTeX run, so Windows
  (`tool-bash` is `disabled: !!js process.platform === 'win32'`) has **no** verified shell seam; TeX, PDF,
  Ghostscript and Office availability are **observed at call time**, not promised, and their absence is
  reported as `unsupported` / `compiler_unavailable` / `not attempted` with a reason. No equivalent optional
  backend is claimed on any OS without a probe. §5 of `README.md` keeps the honest list.

### Git

- Branch `feature/professor-portable-app` is unchanged; `main` still points at `f2cbd25`.
- The working tree was **not** reset, cleaned or restored; all pre-existing uncommitted work is preserved.
- **Checkpoint commit is still deferred and reported** — the same ownership decision as Phase 0 (≈23 modified
  and ≈13 untracked pre-existing paths authored by earlier agents). Nothing was staged; nothing was pushed.
- `git diff --check` is clean.

### Next phase and prerequisites

**Phase 2 — Persistent memory and bounded session context (M2).**
Prerequisites now satisfied: the persistence location is established and **proven to survive a reopen**
(§Risks 1 — do not regress it), and an unbound session can hold Professor-owned state without a course.
Phase 2 must reuse it rather than introduce a second persistence mechanism, and must keep global
preferences separate from course memory.

---

## Phase 1 re-verification — acceptance-gap fixes

**Status:** Verified. Every applicable Phase 1 acceptance criterion now has evidence, and two Phase 1
defects were found, reproduced and fixed.
**Date:** 2026-10-06 (Asia/Shanghai)
**Branch:** `feature/professor-portable-app`
**Commit:** none created. `HEAD` == `main` == `f2cbd25` (`Save Professor plugin v0.12.0 verified
baseline`); the branch is **0 commits ahead of `main`**. Checkpoint commit deferred — see §Git below.

### Why this pass existed

Phase 1 was reported as "implemented and verified" on the strength of real-host runs that mount the
bundle from the **source checkout** through a `link:` dependency. Three gaps followed from that:

1. a lifecycle race in `src/app/storage.js` was never exercised, because the verifiers only ever open
   and close a domain in isolation;
2. the shipped `valueSchema` checked only the **outermost** `typeof`, so a record containing `NaN`,
   `Infinity`, `{ x: undefined }` or `{ x: 1n }` would be accepted by a write path that performs no
   validation of its own and would only explode on the **next** open;
3. "the installed package works" had never been tested against an actual installed package.

### Defect 1 — the application-storage lifecycle race (FIXED)

**Reproduction.** `ensureOpen()` started the host's `open()` and stored the pending promise. `close()`
landing while that promise was pending cleared `opening` but could not see the domain, because none had
been published yet. When the host finally granted one, the abandoned attempt published it and set
`status = 'open'` — **after** the handle had been closed. The storage resurrected itself and the
acquired domain was never released.

**Fix.** The handle is now guarded by a monotonic `epoch`: every `close()` bumps it and every attempt
claims it, so an abandoned attempt can neither adopt a domain nor write a status. Publishing the domain
happens with **no `await`** between the epoch check and the assignment, so a `close()` can only land
before or after it, never interleaved. The ownership rule is *whoever clears `domain` owns releasing
it*, and the bootstrap re-checks its epoch after every `await` so an invalidated handle stops writing.
`writeRecord()` was added as the validated write path (the host's write path validates nothing).

**Evidence.** `test/app-storage-lifecycle.test.mjs` (~new, 8 tests) drives the interleavings with
explicit deferred promises rather than timing guesses, and covers all eight required properties:
no resurrection, release-exactly-once, concurrent `ensureOpen()` sharing one attempt, repeated
`close()`, explicit reopen, a stale attempt not overwriting a newer one, bootstrap stopping after
invalidation, and honest reporting of a cleanup failure.

### Defect 2 — validation was not lossless (FIXED)

**Reproduction.** `APP_VALUE_SCHEMA.parse()` compared only `typeof value`. Every value that
`JSON.stringify` silently rewrites or drops was therefore accepted: `NaN`, `±Infinity`, `-0`,
`{ x: undefined }`, `{ x: 1n }`, functions, symbols, sparse arrays, `Date`/`Map`/`Set`/RegExp`/typed
arrays/class instances, accessor and non-enumerable properties, and circular references.

**Fix.** `validateRecord()` walks the whole reachable graph and refuses anything that would not survive
`JSON.stringify` → `JSON.parse` unchanged, naming the offending JSON path. A long doc comment defines
the accepted record shape and the null policy (`null` is legal anywhere *inside* a record but refused as
the record itself, because `null` is the medium's "never written" sentinel), and records two facts
verified against the host: `invalidRecords: 'backup-and-skip'` is a **no-op** on the default `single`
layout (the backend exposes `backupRecord` only for `per-record`), so the plugin does not declare it
rather than claim a safety net it does not have.

**Third finding, caught by the new test.** The documented depth rule says depth counts **containers**,
but the guard ran before the scalar cases and so counted the innermost leaf too, refusing a legal
32-container record. Now enforced on the value about to be descended into — see §Risks 3.

**Evidence.** `test/app-storage-record.test.mjs` (~new, 13 tests) covers accepted nested records and
permitted nulls, the boundary depth and one level deeper, non-finite numbers, nested
`undefined`/BigInt/function/symbol, circular vs. repeated-but-acyclic references, sparse arrays and
array extra properties, shapes that serialise differently, dropped property kinds, null-prototype
objects, and — through a fake medium that performs a real `JSON.stringify` and re-validates every
record on `open()` — that a valid record survives persistence and a reopen, that `writeRecord` refuses
an invalid record **before** the medium, and that the shipped bootstrap record satisfies its own schema.

**These are real regression tests, not tautologies.** Both new files were re-run against a copy of the
un-fixed implementation in a scratch directory: **11 of 21 fail** there (2 of 8 lifecycle, 9 of 13
record), and **21/21 pass** against the fixed source.

### Fix 3 — the packed installation is now what gets tested

`npm run verify:packaged` (new) is the acceptance run the brief asked for. `tools/packaged-profile.mjs`
holds the shared boot plumbing; `tools/verify-packaged-restore.mjs` is the fresh-process half. In order:

1. `npm pack` the repository and fingerprint the exact tarball (sha256 + shipped file list);
2. `npm install` **that tarball** into a disposable profile — asserted to be a real directory rather
   than a symlink, to resolve outside the checkout, and to be **byte-identical** to the packed sources
   for all 113 files;
3. assert a genuinely clean room: no Hermes profile, no `Personal-Agent`, no Registry/Knowledge file,
   no manually installed Professor skill, no academic folder, no pre-existing storage file;
4. boot the real Cordis loader from the **installed** copy;
5. activation: preset declared and not broken, the persona read from the host's own
   `ctx.systemPrompt.assemble({ scope })`, all six skills, all 15 tools, all 13 child rows active;
6. prove the **runtime** resolves its resources from the installed directory (`professor_diagnostics`
   and `professor_paths` both name it, and it is not the checkout);
7. course-free behaviour: diagnostics and paths report the unbound state, a course-required tool is
   refused, a lenient one still answers, and nothing is created on disk;
8. the mounted plugin opens `professor_app` for real, and a second concurrent open is **refused**
   (`already-open`) rather than silently double-mounted;
9. durability in a second profile where the package is installed but **not** mounted (see finding (b)
   below): persist a valid record, refuse an invalid one without damaging what is stored, close;
10. **restart** — a fresh host process running the *installed* copy of the restore probe reopens the
    same home, restores the record byte-for-byte, and persists one of its own so the parent can prove
    it wrote rather than merely read;
11. nothing changed: the source checkout, both installed copies, the packed tarball, the real desktop
    profile, and the runtime configuration are all fingerprinted before and after.

**Two new host findings, recorded rather than papered over.**

- **(a) A tool failure loses its error code.** The pipeline materialises a thrown tool error as
  `{ content, isError: true, error: { message } }` — no `code`. So `PROFESSOR_PROJECT_MISSING` is
  **not** observable through a tool result; only its message is. The verifier therefore asserts the
  refusal through the message on the real host **and** asserts the documented code against the
  installed `src/paths/roots.js#assertProjectBound`. Any future phase that needs a machine-readable
  refusal code must not assume it survives the tool boundary.
- **(b) The shipped storage backend refuses a second concurrent `open()` of the same domain**
  (`already-open`). Combined with the plugin's own instance holding the domain for the lifetime of the
  mounted tree, this means a durability probe cannot open the domain a second time in the same process.
  The verifier installs the package into a second profile **without** registering the bundle, so the
  plugin is present on disk but not mounted — rather than fighting its own subject.

**Not claimed.** `verify:packaged` produces *registration/activation evidence* and *real execution
evidence*. It does **not** drive a native conversation or a model turn: no model provider is configured
in a disposable profile, and doing so would need network access and spend. The script prints those
requirements as `UNVERIFIED` at the end of every run, so a green run cannot be mistaken for a claim
that a real session was exercised. The Phase 4 sidebar/UI is likewise out of scope here.

### Evidence, by tier

| Tier | What it covers | Fresh result (2026-10-06, first pass — superseded by §Phase 1 second re-verification, kept as dated history) |
|---|---|---|
| Implementation | the two fixes, the validated write path, the restored depth policy | done |
| Automated tests | `npm test` — 235 pre-existing + 21 new regression tests | **256/256 pass, 0 fail**, 56.4 s |
| Real host, source-linked | `npm run verify:harness` — 8 stages | **exit 0, 243 checks, 0 FAIL** (`preset` 32, `composition` 12, `boot` 27, `host` 48, `activation` 27, `desktop` 24, `api` 29, `app-storage` 44) |
| Real host, packed artefact | `npm run verify:packaged` | **exit 0, 94 checks, 0 FAIL** |
| Offline gates | `verify:syntax` / `verify:skills` / `verify:sync` / `verify:dist` / `verify:e2e` | **100 files / 39 / 89 / 62 (exit 0) / 28 scenarios** — all `ALL PASS` |
| Hygiene | `git diff --check` | clean |
| **Unverified** | native conversation turn; model-driven tool selection; Phase 4 UI shell | explicitly reported as `UNVERIFIED` by `verify:packaged`; owned by later phases |

### Files changed in this pass

| File | Change |
|---|---|
| `src/app/storage.js` | epoch-guarded lifecycle (`releaseHandle`, `openFor`, cancellation-safe publish); `validateRecord` replacement of the shallow validator; `writeRecord`; depth bound moved to containers; doc comments for the record shape, null policy and depth rule |
| `test/app-storage-lifecycle.test.mjs` | **new** — 8 lifecycle regression tests |
| `test/app-storage-record.test.mjs` | **new** — 13 validation regression tests |
| `test/portable-core.test.mjs` | one stale expectation updated: the validator's refusal message (behaviour unchanged — it still refuses `null`) |
| `tools/packaged-profile.mjs` | **new** — shared boot/install plumbing for packed acceptance |
| `tools/verify-packaged-acceptance.mjs` | **new** — the 94-check packaged acceptance verifier |
| `tools/verify-packaged-restore.mjs` | **new** — fresh-process restore probe (shipped inside the package) |
| `package.json` | `verify:packaged` added |
| `docs/v1/STATUS.md`, `PROJECT_MEMORY.md` | this report |

### User / source files modified

**None.** No course material, old Registry/Knowledge, `PATHS.md`, real `project.yaml`, real desktop
profile or session log was read as a requirement or written. Evidence: `verify:packaged` §11 asserts
the source checkout is byte-identical after the run (126 files digested before and after), that both
installed copies still hold exactly the 113 packed files, that the tarball is unmodified, and that the
real desktop profile is unchanged. All scratch state lives in `mktemp -d` homes and private npm caches
removed on exit.

**One correction worth recording.** An earlier draft of §11 compared `mtime` of the user's real
`~/.hermes` and `~/Personal-Agent` directories. That check was **removed as unsound**: `~/.hermes` is a
live directory owned by an unrelated gateway process (`gateway_state.json`, `kanban.db-wal`, `cron`)
whose `mtime` advances every second on its own, so the comparison failed for reasons with no connection
to this run. The property it was meant to establish is now proved twice over — statically, by scanning
the runtime configuration this run resolves (2 profile manifests, 2 root entry trees, 2 installed
patches) for any legacy reference and any path outside the disposable home and the host install; and
dynamically, by booting a home that contains none of them. Those directories are now *observed and
reported*, never *asserted*.

### Risks, recorded

1. **`valueSchema` is mandatory** — carried forward unchanged from §Risks 1; the packed verifier now
   pins the reopen path against the **installed** artefact as well as the source.
2. **The sandbox `CODEBUDDY_BROKER_DENY` denial did not recur** (256/256 and 62/62). It is therefore
   environmental, but Phase 7's release gate must still re-check it in the release environment rather
   than assume it away.
3. **Depth off-by-one — FIXED** (see §Risks 3 above). The rule is container-counted as documented, and
   both sides of the boundary are pinned by test.
4. **A tool failure loses its machine-readable code** (finding (a)). Message-only refusal observation
   is the current reality; later phases that need codes must not assume they cross the tool boundary.
5. **Concurrent opens of the same domain are refused** (finding (b)). Correct for a single-instance
   plugin, and now documented and pinned rather than discovered.
6. **Pre-existing, unrelated:** `dsh-permission-rules@0.7.9` (`permissionRules/decision`) and the two
   desktop activation warnings — unchanged, see Phase 0 §Remaining 3–4.
7. **Platform coverage:** `sh -c` is the extraction and LaTeX seam, so Windows still has no verified
   shell path (Phase 1 §Documented answers). Unchanged and deliberate.

### Git

- Branch **`feature/professor-portable-app`**; `HEAD` == `main` == **`f2cbd25`**
  (`Save Professor plugin v0.12.0 verified baseline`); **0 commits ahead of `main`**.
- Working tree: **38 modified and 23 untracked paths**, **0 staged** (verified with
  `git diff --cached --name-only`). This is larger than the Phase 1 figure because this pass added
  three tools files and two test files.
- The tree mixes work authored by earlier agents (the import/format-gate/preference repairs recorded in
  `PROJECT_MEMORY.md`, the v1 plan and prompt documents) with this pass's changes, so **staging scope is
  an ownership decision for the user**. Per the brief, nothing was staged and no commit was created;
  see the question accompanying this report.
- The working tree was **not** reset, cleaned or restored; all pre-existing uncommitted work is
  preserved. Nothing was pushed or published. `git diff --check` is clean.

### Can Phase 1 be closed, and can Phase 2 begin?

**Yes, with the residuals stated above.** All six Phase 1 acceptance criteria have evidence, and
criterion 1 is now satisfied in the strong sense — the **packed artefact**, installed into a
disposable profile, registers the bundle, the persona (correctly scoped), six skills and 15 tools, and
survives a real process restart with its own storage intact. The unexercised items are native
conversation, model-driven tool selection and the Phase 4 UI, all owned by later phases per
`HARNESS_API_AUDIT.md` §9.

**Phase 2 prerequisites:** reuse `professor_app` rather than adding a second persistence mechanism;
the reopen path is now pinned by tests at both the source level and the installed-artefact level, and
every future writer must go through `writeRecord()` (or an equally validated path), because the host's
write path validates nothing and the failure only surfaces on the *next* open. Three constraints to
carry in: the domain is versioned at 1 and a bump needs an explicit migration; the backend refuses a
concurrent `open()` of the same domain; and a tool failure does not carry its error code to the caller.

---

## Phase 1 second re-verification — the two remaining acceptance defects

**Status:** Verified. Both remaining defects were reproduced as failing tests, fixed, and re-checked
against the full battery. Phase 1's acceptance conclusion is **unchanged** — it was already correct —
and is now backed by evidence that covers the two holes described below.
**Date:** 2026-10-06 (Asia/Shanghai) — a second pass on the same day as §Phase 1 re-verification.
**Branch:** `feature/professor-portable-app`
**Commit:** none created. `HEAD` == `main` == `f2cbd25` (`Save Professor plugin v0.12.0 verified
baseline`); the branch is **0 commits ahead of `main`**. Checkpoint commit deferred — see §Git below.

### Why this pass existed

§Phase 1 re-verification fixed two defect *classes* — the storage lifecycle race and the shallow
validator — but each fix was only exercised in the shape its first test happened to use, which left
one hole **inside each** of them:

1. the lifecycle tests never overlapped a *release still in flight* with a **newer** open, so the
   unconditional `status = 'closed'` after `await handle.close()` was never reached with a newer
   lifecycle in place;
2. the array walker rejected property names only by shape (`/^(?:0|[1-9]\d*)$/`), which admits
   `"4294967295"` and above — values that are **not** array indices — and it read elements through
   `array[index]`, which **invokes an accessor's getter** during validation.

Both were reproduced first, as failing tests, before any implementation changed.

### Defect 3 — a stale close completion overwrote a newer lifecycle (FIXED)

**Reproduction** (`test/app-storage-lifecycle.test.mjs`, "a stale close completion cannot overwrite a
newer lifecycle"). (1) open handle A and let it settle; (2) start `close()` on A and keep A's release
pending; (3) start and complete a new open for handle B; (4) resolve A's release. Before the fix the
storage reported `closed` while B was still live and reachable through `table()` — the reported
symptom was `'closed' !== 'open'` at the status assertion.

**Fix.** `close()` now writes the status in its **synchronous** part, before the release is awaited,
and writes **nothing** after it. Nothing can interleave between the epoch bump and that write, so the
write happens while that close is the lifecycle in force; the `await` that follows touches no state at
all. This is also the honest report from the caller's point of view, because `table()` stops resolving
at the same moment. A failed release is still surfaced through the logger — never by corrupting the
status of the lifecycle that may have replaced this one. The release itself was folded into the shared
`releaseHandle(handle, 'during close')` helper, so the warning text is unchanged.

**Ownership applied consistently to the other asynchronous completion path.** The bootstrap assignment
`bootstrapped = await bootstrap(...)` had the same shape — a state write after an `await` that a
superseded attempt could land — and is now gated on the epoch (`if (isCurrent()) bootstrapped = wrote`).
The rule is stated once in the module's lifecycle contract: *a lifecycle writes state only while its
own epoch is current.*

**Two tests, both red before the fix.** The second one ("a failed release on a superseded lifecycle is
reported without corrupting the newer one") covers the brief's "cleanup errors observable without
corrupting newer state" requirement: the release rejects after B is current, the warning fires exactly
once, B's status and reason are untouched, and B remains writable. The first also pins
release-exactly-once (`calls.closed === ['open#1','open#2']` — A by its own `close()`, B by the newer
one) and that B is still *usable*, not merely described as open.

### Defect 4 — an array property that is not an index was accepted as a member (FIXED)

**Reproduction** — the brief's own snippet, now a test:

```js
const value = []
value['4294967295'] = 'lost'   // 2 ** 32 - 1: looks like an index, is not one
validateRecord(value)          // accepted, before the fix
JSON.stringify(value)          // "[]" — the member is silently gone
```

`"4294967295"` does not count towards `length` and `JSON.stringify` omits it, so a record could be
declared valid while a member was **dropped** — the exact failure mode the lossless contract exists to
prevent. The same walker also read elements through `array[index]`, invoking an accessor getter.

**Fix.** Only a canonical index that the array can actually have is an element now: the name must match
`/^(?:0|[1-9]\d*)$/` **and** be `<= 2 ** 32 - 2` (`MAX_ARRAY_INDEX`; an array's `length` is capped at
`2 ** 32 - 1`, so one below that is the highest index that can exist) **and** be below the array's own
`length`. Anything else is refused as "an extra property that JSON would drop". Element **descriptors**
are now inspected before elements are read, so a non-enumerable element is still refused and an accessor
element is refused **without its getter ever being invoked** — running the code under validation and
then trusting a value a later read need not reproduce is not a validation strategy.

**Deliberately not done: the sparse/hole check was left alone.** An earlier draft replaced the
index-by-index hole scan with an element count plus a bounded search for the first hole, on the theory
that a huge `length` would make the scan pathological. Measuring first showed the theory was wrong — the
existing loop short-circuits at the **first hole**, so `a[2 ** 32 - 2] = 1` is refused at
`$[0]` in under a millisecond. The smaller change was kept, and the boundary it depends on is pinned
instead: `2 ** 32 - 2` must be treated as a real *element* (so the refusal is "sparse array", not
"extra property"), which is what an off-by-one at the boundary would break.

**Honest note on test redness.** Seven tests were added in this pass. **Five were red before the fix and
green after** — the two lifecycle tests, plus three of the four validation tests (the brief's
reproduction, the accessor case, and the persistence-refusal case). The remaining two **passed before the
fix as well**: the array-index boundary / bounded-time test (the un-fixed hole scan already
short-circuits at the first hole) and the ordinary-arrays test. Both are retained as
regression *guards* — the second exists specifically to catch the opposite failure, over-refusal — and
neither is counted as evidence of a fix.

**Persistence.** `test/app-storage-record.test.mjs` also proves, through the fake medium that performs a
real `JSON.stringify` and re-validates every record on `open()`, that both lossy shapes are refused by
`writeRecord` **before** the medium: the stored text is byte-identical afterwards, the refused keys do
not exist, the bootstrap marker survives, and no getter ran while deciding.

### Evidence, by tier (fresh, this pass)

| Tier | What it covers | Fresh result (2026-10-06, second pass) |
|---|---|---|
| Implementation | stale-close ownership + epoch-gated bootstrap; canonical array indices + descriptor-first element checks | done |
| Automated tests | `npm test` — 256 pre-existing + **7 new** regression tests | **263/263 pass, 0 fail**, ≈63 s, **exit 0** |
| Regression value | the 7 new tests run against the un-fixed implementation | **5 fail there** (2 lifecycle, 3 record); the other 2 pass either way and are labelled guards, not evidence |
| Real host, source-linked | `npm run verify:harness` — 8 stages | **exit 0, 243 checks, 0 FAIL** — all 8 stages `ALL PASS` |
| Real host, packed artefact | `npm run verify:packaged` | **exit 0, 94 checks, 0 FAIL** |
| Offline gates | `verify:syntax` / `verify:skills` / `verify:sync` / `verify:dist` / `verify:e2e` | **100 files / 39 / 89 / 62 (exit 0) / 28 scenarios** — all `ALL PASS` |
| Hygiene | `git diff --check` | clean |
| **Unverified** | native conversation turn; model-driven tool selection; Phase 4 UI shell | unchanged, still reported as `UNVERIFIED` by `verify:packaged`; owned by later phases |

The real-host chain and the packed acceptance run were re-executed **because the storage module is
their subject** (`verify:app-storage` hands the plugin's real `createAppStorage()` the real
`ctx.storageDomain`, and `verify:packaged` persists, refuses and restores records through the installed
copy). Both were unchanged at 243 and 94 checks, so the two fixes did not move host-observable
behaviour.

### Files changed in this pass

| File | Change |
|---|---|
| `src/app/storage.js` | `close()` claims its status synchronously and writes nothing after the release is awaited; the bootstrap assignment is gated on the epoch; `MAX_ARRAY_INDEX` + `CANONICAL_ARRAY_INDEX`; `walkArray` rejects non-index properties and inspects element descriptors before reading elements; the module's record-shape table and lifecycle contract document both rules |
| `test/app-storage-lifecycle.test.mjs` | `pendingService({ deferClose })` so a release can be held in flight; **+2** tests (stale close completion; a failed release on a superseded lifecycle) |
| `test/app-storage-record.test.mjs` | **+4** tests (the brief's reproduction and the index boundary; the array-index boundary with a `2 ** 32 - 1` length; accessor elements and the element-descriptor refusals; ordinary/nested/long arrays) and one persistence-refusal test |
| `README.md` | test counts refreshed (256 → 263); the storage contract now names the array-index rule, the accessor rule and the lifecycle-ownership rule; a dated note that the long verifiers exceed the ambient command timeout (exit 137/SIGTERM with no output is a timeout, not a product failure) |
| `docs/v1/STATUS.md`, `PROJECT_MEMORY.md` | this report |

### User / source files modified

**None.** No course material, old Registry/Knowledge, `PATHS.md`, real `project.yaml`, real desktop
profile or session log was read as a requirement or written. The two new test files use fake hosts and
in-memory fixtures; the real-host runs are the existing verifiers, which snapshot the real desktop
profile by digest and keep all scratch state in `mktemp -d` homes. `git status` before and after shows
the identical set of pre-existing modified/untracked paths (38 modified, 23 untracked, 0 staged).

### Risks, recorded

1. **A lifecycle may only write state while its own epoch is current** — now stated once in
   `createAppStorage`'s contract and enforced on both asynchronous completion paths (`close()`'s status,
   the open attempt's `bootstrapped`). Any future field written after an `await` must be gated the same
   way, or the same class of defect returns in a new field.
2. **The array-index boundary is `2 ** 32 - 2`, inclusive** — one above it is a plain string property
   that JSON drops. Pinned by test on both sides so an off-by-one cannot silently start dropping or
   accepting members.
3. **Validation never invokes accessor getters** — object properties and array elements are both refused
   from their descriptors. A future validator "simplification" that reads values first would reintroduce
   running untrusted code during validation.
4. **The un-fixed sparse scan already short-circuits at the first hole.** Recorded because the earlier
   plan (a count-based hole search) was motivated by a pathology that measurement did not confirm: keep
   measuring before optimising here.
5. **`valueSchema` is mandatory** — carried forward, unchanged (see §Risks 1 of the first pass).
6. **The sandbox `CODEBUDDY_BROKER_DENY` denial did not recur** (263/263, 62/62). Still environmental;
   Phase 7's release gate must re-check it in the release environment rather than assume it away.
7. **A tool failure loses its machine-readable code; concurrent opens of the same domain are refused** —
   carried forward, unchanged (findings (a) and (b) of the first pass).
8. **Operational, dated 2026-10-06 (this environment):** `verify:dist`, `verify:packaged` and
   `verify:harness` each take 1–3 minutes, longer than the ambient command timeout. When they are killed
   from outside they show **exit 137 / SIGTERM with no output at all**, which reads like a product
   failure and is not one. Re-run them with a raised timeout, one at a time. `verify:dist` was observed
   failing exactly this way three times before succeeding unchanged.
9. **Pre-existing, unrelated:** `dsh-permission-rules@0.7.9` (`permissionRules/decision`) and the two
   desktop activation warnings — unchanged, see Phase 0 §Remaining 3–4.

### Git

- Branch **`feature/professor-portable-app`**; `HEAD` == `main` == **`f2cbd25`**
  (`Save Professor plugin v0.12.0 verified baseline`); **0 commits ahead of `main`**.
- Working tree: **38 modified and 23 untracked paths**, **0 staged** (verified with
  `git diff --cached --name-only`). This pass added no files and deleted none, so the counts are
  identical to the first pass's — only three already-tracked-and-modified files
  (`src/app/storage.js`, `README.md`) and two already-untracked test files (plus the two memory
  documents) changed content.
- The tree still mixes work authored by earlier agents (the import/format-gate/preference repairs
  recorded in `PROJECT_MEMORY.md`, the v1 plan and prompt documents) with these two passes, so
  **staging scope remains an ownership decision for the user**. Per the brief, nothing was staged and no
  commit was created; the question raised with the first pass's report is still open.
- The working tree was **not** reset, cleaned or restored; all pre-existing uncommitted work is
  preserved. Nothing was pushed or published. `git diff --check` is clean.

### Can Phase 1 be closed, and can Phase 2 begin?

**Yes — the conclusion of §Phase 1 re-verification stands, now on complete evidence.** The two
remaining holes were in the *implementations of already-verified requirements*, not in the acceptance
list itself: with them fixed, all six Phase 1 acceptance criteria have evidence and the two
correctness properties they defend (a lifecycle cannot be corrupted by a superseded completion; a
record that would lose a member cannot reach the medium as "valid") are pinned by tests that fail
without the fix. Nothing was moved to a later phase to make this true, and no acceptance item is being
claimed on partial evidence: **native conversation, model-driven tool selection and the Phase 4 UI
remain unverified and are reported as such** by `verify:packaged` on every run.

**Phase 2 prerequisites:** unchanged from §Phase 1 re-verification, with one addition — reuse
`professor_app` through `writeRecord()`; and if Phase 2 adds a field that is written **after** an
`await` inside the storage lifecycle, gate it on the epoch, because that is exactly the shape of defect
3.

---

## Phase 1 third re-verification — the native-session acceptance

**Status:** Verified — Phase 1 acceptance complete
**Date:** 2026-10-06 (Asia/Shanghai)
**Branch:** `feature/professor-portable-app`
**Commits:** `368b8dc` then `a63c925` (the deferred checkpoint is now closed out — see §Git).

### Why this pass existed

The Phase 1 acceptance sentence is exact (prompt, 2026-10-05):

> “actual installed package in an isolated real Harness profile **starts a general Professor native
> session**, persona and six skills are available, no legacy data is read as a requirement, and no
> course tree is created or guessed.”

The previous two passes claimed Phase 1 fully verified while their own evidence — and
`verify:packaged`'s own output, printed on every run — admitted that **“a native conversation turn”**
was `UNVERIFIED`. That is a contradiction of exactly one clause: the first one. Everything after it
(installed package, isolated profile, persona, six skills, no legacy read, no course tree) had real
evidence; *“starts a general Professor native session”* did not, because the earlier runs proved
**registration and activation** of the preset, not that a **session** runs under it.

This pass removes the contradiction by exercising that clause, and by reporting the residual gap in
its correct place instead of leaving it as an unstated caveat on a “Verified” row.

### What “native session” means, and why the distinction mattered

A session created by the plugin, or by a test helper, would prove nothing — the clause says the
*installed package* starts a session. So the verifier uses the host's own factory:

| Step | Call | Why it is the native path |
|---|---|---|
| create | `ctx.get('agents').create({ sessionId, meta: { cwd } })` | The harness's own constructor: prepares the session, persists it through the configured `sessionPersistence` backend, builds an Agent around it and publishes the agent loop. `sessionId` is **required** — omitting it fails with `agent id "undefined" does not match session id "session-1"`. |
| bind | `ctx.get('agentPresets').select(agent, 'professor')` | Binding happens the way the runtime does it, **before** the first turn; the harness refuses it later (`agent-preset/locked`). |
| read | `agent.loopCtx.systemPrompt.assemble(assembleContextFor(agent))` | Reads the surface **the session itself resolves**, using the host's own `assembleContextFor` — the same call `dsh-agent-loop` makes at `preStep()`. |

Two measured traps are worth recording because both are **silent**:

1. **The authoritative scope token is the agent object.** `assembleContextFor(agent)` returns
   `{ agent, scope: agent }`. Reading the same assembly through `agent.ctx` — or through the preset
   mount's key — returns the **default deployment persona instead of the preset's**, with no error.
   Measured on the installed artefact: **2056-character Professor persona, 28 tools, 6 skills** via
   `scope: agent`, versus **54-character coding persona, 0 tools, 0 skills** via `agent.ctx`.
   `renderContextSections()` from `dsh-system-prompt` is likewise the wrong reader (render-hook
   sections only) — it returns 2 sections where the assembly carries 16.
2. **`pathToFileURL(import.meta.url)` double-encodes an already-URL value** (`…/repo/file:/…/repo`),
   so a `cwd` derived that way does not exist and every child process reports
   `spawnSync npm ENOENT` — a message that blames npm for a bad path. Found and fixed in this pass;
   section 1 of the new verifier now asserts the resolved repository root exists **before** any child
   process runs, so this can never again present as an npm problem.

### The new verifier

`tools/verify-native-session.mjs`, exposed as **`npm run verify:native-session`**. It packs the real
tarball, installs it into a disposable profile (a real directory, proven not to resolve back into the
checkout), boots the genuine Cordis loader against it, and then — in nine sections — creates a native
general (course-free) Professor session, a **control** native session that selects no preset, checks
that the session is durable, that nothing academic was invented, and that nothing else on the machine
changed (source checkout digest, real desktop profile digest, tarball, installed file set).

### Evidence, by tier (fresh, this pass)

The tiers are the point: they are *not* interchangeable, and only tiers 1–3 are Phase 1's.

| Tier | What it establishes | Evidence | Result |
|---|---|---|---|
| 1 — package activation | the installed bundle mounts and activates in a real profile | `npm run verify:packaged` | **94 PASS / 0 FAIL**, exit 0 |
| 2 — directly dispatched tool tests | the tools behave correctly when invoked through the real registry pipeline | same run + `verify:native-session` §5 | PASS |
| 3 — **native-session integration** | the installed package **starts a general Professor native session**, and that session's own persona/tools/skills are active | `npm run verify:native-session` | **47 PASS / 0 FAIL**, exit 0 |
| 4 — model-observed behaviour | what a **model** does: a real turn, and tool selection chosen by a model | none | **UNVERIFIED** — no model provider is configured in a disposable profile (`defaultModel` is reported **ABSENT**); a turn needs credentials, network and spend |

Tier 3, per the run: the session header is stamped by the native layer itself (id, `cwd`, `createdAt`);
before selection the session composes **no** preset and after it composes `professor`; the **native
session log** records `agent-preset/selected` with `{"agentPreset":"professor"}`; the session's own
prompt carries the 2056-character persona opening `你是 Professor` as the
`deployment:persona-prefix` section; all **15** `professor_*` tools are visible and offered (28 total);
the **six** bundled skills are listed; a real tool call through the real pipeline succeeds and reports
`projectBound: false` with `appStorage: 'open'`; a course-required tool is **refused descriptively**;
and the previously unexecuted **control** session receives none of it (54-character coding persona, 0
tools, 0 skills) — so the surface is genuinely *scoped*, not global. `sessions.flush()` then writes
`session.v4.jsonl.zstd` under a native-layer-chosen directory, whose decoded header names this session
and this non-academic workspace.

**Tier 4 is not a Phase 1 clause, and is not being moved to a later phase to make this row green.**
The controlling plan assigns it explicitly: Phase 4 owns the ordered `agentPresets.select()` →
first model turn sequence, and Phase 7 owns *“where a model turn is required, obtain the normal
model/network authorization and record actual observed behavior.”* The verifier prints these three
`UNVERIFIED` lines into its own output on every run so the boundary is visible in the artefact, not
only in this document.

### Commands actually run (fresh, 2026-10-06)

| Command | Result |
|---|---|
| `npm test` | **263 / 263 pass**, 0 fail, exit 0 |
| `npm run verify:e2e` | **28 / 28**, exit 0 |
| `npm run verify:packaged` | **94 PASS / 0 FAIL**, exit 0 (3 `UNVERIFIED`, all tier 4 / Phase 4 UI) |
| `npm run verify:native-session` | **47 PASS / 0 FAIL**, exit 0 (NEW) |
| `npm run verify:harness` | **243 checks, 8 stages ALL PASS**, exit 0 |
| `npm run verify:dist` | **62 / 62**, exit 0 |
| `npm run verify:syntax` | 101 files parsed, ALL PASS |
| `npm run verify:skills` | ALL PASS |
| `npm run verify:sync` | ALL PASS |
| `git diff --check` | clean |

No historical count is reused: every figure above was produced by a command run during this pass.
`verify:native-session` was also confirmed to work through **both** entry points (`npm run
verify:native-session` and a direct invocation with the harness binary).

### Files changed in this pass

- `tools/verify-native-session.mjs` — **new**; the tier-3 acceptance verifier (9 sections + claims
  block), 47 assertions.
- `tools/packaged-profile.mjs` — extended with the native-session helpers
  (`createNativeSession`, `selectPreset`, `sessionSurface`, `nativeSessionLog`,
  `loadAssembleContextFor`), so the native path lives in the one module that already owns
  “tarball → runnable profile”.
- `package.json` — added the `verify:native-session` script.
- `docs/v1/STATUS.md` — this section, plus the corrected Phase 1 checklist row.
- `PROJECT_MEMORY.md` — Chinese counterpart of this pass.
- `README.md` — counts and the new script.

### User / source files modified

**None.** No real course tree, legacy Registry/Knowledge data, desktop configuration or session log
was read, written or migrated. The verifier's §9 asserts this rather than promising it: the source
checkout is byte-identical after the run, the real desktop profile (`~/.dsh/profiles/desktop`) was not
written, and the run's own runtime-configuration sources (5 files) contain no reference to a legacy
academic location. The disposable home is removed on every exit path.

### Risks, recorded

1. **Tier 4 remains open by design** (see above). It is the only thing standing between this row and
   “all four tiers green”, and it is **not** a Phase 1 requirement. It becomes a blocker for Phase 7.
2. **No model provider is configured in a disposable profile.** Copying the user's real credentials or
   reusing the real desktop profile was explicitly forbidden by the brief and was not done. The
   credentials file a disposable profile generates carries only a web-session grant.
3. **Native session persistence is only partially flushed without a turn.** After `flush()`, the log
   file holds the header event; remaining events stay in the in-memory native log until a turn
   advances persistence. This is why the verifier asserts the preset selection from the **native
   session log** rather than from the file, and says so in its output.
4. **`assembleContextFor` is the only correct reader** (measured trap 1 above). Any future code that
   reads the persona or tool list through a different scope token will silently see the coding
   persona. `sessionSurface()`'s doc comment exists to stop that.
5. **Operational — two distinct overload symptoms, both observed on 2026-10-06.** The heavyweight
   verifiers exceed the ambient command timeout and, when killed from outside, show **exit 137 /
   SIGTERM with no output** — a timeout, not a product failure. Separately, on a machine running at
   **load average 11 on 12 CPUs** a full sweep that normally takes ~6 minutes took **1 h 45 m**, and
   two checks failed *not* on assertions but on fixtures:
   `spawnSync …/python3 ETIMEDOUT` after **917 s** in `test/extract-production.test.mjs` and, from the
   same cause, `verify:e2e` scenario 22 reporting `no Office extractor for pptx … (the Python backend
   needs python-pptx)`. Both passed when re-run in isolation (`extract-production` **19/19**,
   `verify:e2e` **28/28**), and `npm test` passed **263/263** on a quieter machine. **Do not read a
   fixture timeout as a product failure** — re-run the check alone and compare the failure's shape
   (an assertion vs. a `spawnSync … ETIMEDOUT`). Run these verifiers one at a time on an idle machine.
6. **Pre-existing, unrelated:** `dsh-permission-rules@0.7.9` and the two desktop activation warnings —
   unchanged, see Phase 0 §Remaining 3–4.

### Git

- Branch **`feature/professor-portable-app`**; `HEAD` == `main` == **`f2cbd25`**
  (`Save Professor plugin v0.12.0 verified baseline`); **0 commits ahead of `main`**.
- Working tree: **38 modified and 24 untracked paths**, **0 staged** (confirmed with
  `git diff --cached --name-only` → empty). Those 24 untracked *paths* include three directories
  (`docs/superpowers/`, `docs/v1/`, `src/app/`), so the tree holds **63 changed files in total**
  (38 modified + 25 untracked). This pass added one file (`tools/verify-native-session.mjs`) and
  modified no files the previous pass had left alone.
- **The ownership question is now answered rather than merely restated.** Every one of the 63 files
  falls into one of two eras by modification time, and **no file appears in both** (verified with
  `comm -12`):
  - **2026-10-01 17:43–19:18 — pre-v1 repairs: 22 files** (14 modified + 8 untracked), authored
    *before* the v1 plan document existed (2026-10-05 09:57): the import/format-gate/preference
    repairs recorded in `PROJECT_MEMORY.md`. They are a self-contained concern —
    `src/migrations/repair-import.js` is imported only by `tools/repair-import-config.mjs` and
    `test/repair-import.test.mjs`, all three inside this set.
  - **2026-10-05 10:41 onward — v1 Phase 0 / Phase 1: 41 files** (24 modified + 17 untracked),
    including `src/app/storage.js`, the v1 plan and prompt documents, `docs/v1/`, and the verifiers.
  Because the later work was authored **on top of** the earlier modifications, a split commit must
  order the pre-v1 set **first**; the two sets are disjoint by file, so that ordering is
  well-defined.
- **Checkpoint created on the user's explicit instruction** (“split into two commits by era”).
  Nothing else was staged; the file lists were computed from modification time, not chosen by hand.
  - `368b8dc` — *Professor plugin: pre-v1 repairs to import, format gate and preferences* — the 22
    files of the 2026-10-01 era (14 modified + 8 added), 956 insertions / 44 deletions.
  - `a63c925` — *Professor v1 Phase 0 + Phase 1: portable identity, course-free bootstrap, app
    storage* — the remaining 41 files (24 modified + 17 added), 9453 insertions / 227 deletions.
  - Both agree with the partition above to the file: `22 + 41 = 63`, overlap `0`, unclassified `0`.
- **⚠ The intermediate commit is NOT green, and this is recorded rather than papered over.**
  Measured in a throwaway `git worktree` (the real working tree was never checked out or touched):
  - At **`368b8dc`**: `npm test` → **211 pass / 4 fail**, exit 1. The four failures are
    *artifact status reports roots, configuration source and existing files*,
    *every import result is lossless JSON…*, *registry import preserves per-course destinations…* and
    *a migrated course creates and lists notes only in its own configured destination* — i.e. the
    updated **artifacts / migration tests** (2026-10-01 era) assert behaviour whose **`src`** landed in
    the 2026-10-05 era (`src/tools/artifacts.js`, `src/tools/courses.js`, …). `verify:syntax` passes
    (89 files).
  - At **`a63c925`** (HEAD): `npm test` → **263 pass / 0 fail**, exit 0.
  So the era split is a faithful **authorship** split but not a green-at-every-commit split: the last
  commit is the verified state, the first is an attribution step. **A single squashed commit would
  remove the red intermediate**; that is a one-command change on this unpushed branch and is left to
  the user.
- The working tree was **not** reset, cleaned or restored; all pre-existing work is preserved, and the
  tree is now **clean** (0 modified, 0 untracked, 0 staged). Nothing was pushed or published.
  `git diff --check` is clean.

### Can Phase 1 be closed, and can Phase 2 begin?

**Phase 1 can now be formally closed.** The acceptance sentence has evidence for every one of its
clauses, produced against the packed artefact in a disposable profile with no legacy data and no
academic folder — including the clause that previously had none. The contradiction is resolved in the
honest direction: rather than promoting the unexercised clause, this pass exercised it. Nothing was
moved between phases to make the row green, and the remaining gap (tier 4) is stated as a Phase 7/8
requirement with the plan's own wording as support.

**Phase 2 may proceed, with one explicitly acknowledged pending acceptance:** model-observed behaviour
(a model turn and model-driven tool selection) is unverified and **requires the user's authorization**
for model credentials, network access and spend before Phase 7 can close. Phase 2 itself does not need
that authorization — it works on the storage and context contracts already proven at tiers 1–3.

**Prerequisites for Phase 2, carried forward:** reuse `professor_app` through `writeRecord()`; gate any
field written **after** an `await` inside the storage lifecycle on the epoch (defect 3's shape); keep
reading agent-scoped prompt/tool contributions through `assembleContextFor(agent)` (risk 4).

**Historical Phase 1 conclusion, not a v1 release-readiness claim.** At that checkpoint Phase 2 through Phase 8 were not started; there was no
release gate, no UI shell, and no model-observed evidence. The only claim made here is that Phase 1's
own acceptance list is now fully evidenced.

## Phase 2 takeover and acceptance — 2026-10-06

**Status:** Verified at automated and native-integration tiers. No model turn was executed.
**Branch:** `feature/professor-portable-app`. Detailed implementation/fixes: `PHASE2.md`.

The current agent retained the preexisting uncommitted memory implementation and completed the
store, native prompt-assembly hook, binding refresh, multi-session ownership, disabled cache behavior
and genuine new-process restore. Global/course/control memory remains in `professor_app`; existing
learning-state files are reused. The public surface is now 18 tools and six bundled skills.

Fresh final verification:

| Command | Result |
|---|---|
| `npm run verify` | Exit 0: syntax, skills, synchronization, packed distribution, E2E and full suite |
| `npm test` inside the sweep | 286/286 pass, 0 fail |
| `verify:e2e` inside the sweep | 28/28 pass |
| `npm run verify:harness` | Exit 0, all eight stages passed |
| `npm run verify:packaged` | Exit 0 |
| `npm run verify:native-session` | Exit 0 |
| `npm run verify:memory-restart` | Exit 0: new host process and new native sessions restored persistent context |
| `node --test test/memory.test.mjs` | 22/22 pass |
| `git diff --check` | Clean |

The restart verifier proves stable preference and evidence-backed learning persist, temporary
preferences are refused, course memory does not leak to another course or an unbound session,
two native sessions share storage, sibling disposal does not close the shared store, and native
assembly retrieves prior-session context without recreating stored instructions.

Real model behavior remains unverified; the scripts explicitly report this. No real course material,
Registry/Knowledge, desktop profile, user session log or credentials were edited. Test state was
restricted to disposable profiles. Prior feature work and historical commits were preserved.

Milestone checkpoint contains the reviewed Phase 2 working-tree changes; no push/publication.
Next: Phase 3 academic-folder discovery/confirmation and incremental indexing using the existing core.

## Phase 3 takeover and acceptance — 2026-10-07

**Status:** Verified: backend contracts and packaged real execution. See `PHASE3.md`.
**Branch:** `feature/professor-portable-app`; reviewed milestone checkpoint, no push or history rewrite.

The preexisting Phase 3 implementation was retained. Discovery is read-only, identities require
confirmation, output roots are excluded, original materials stay untouched, and derived indexing
supports explicit incremental refresh and rebuild. The workspace connection survives a real restart.

Takeover fixes include the schema-required success field, per-course output exclusion, guarded
configuration preimages/versions, malformed current-schema connections, case-insensitive test-path
collisions and restart probes that had read an old parent-process cache. None bypasses path policy.

Fresh final sweep: `npm run verify` exit 0 (**319/319** tests, **28/28** E2E); targeted onboarding/project
tests **41/41**; `verify:harness`, `verify:packaged`, `verify:native-session`, `verify:memory-restart`,
and `verify:onboarding` ran sequentially and all exited 0; `git diff --check` clean.

Source snapshots and exclusion checks prove fixture safety, restart checks read the installed package
and durable connection/memory data, and Phase 2 regressions remain green. No real course, old
Registry/Knowledge, desktop profile, user session log or credentials was modified.

Model turns, thin UI and live filesystem watching are explicitly unverified/not implemented.
Incremental scanning is on demand. No v1 release-readiness claim. Next phase: supported sidebar/Home
and native study-session routing (Phase 4); do not substitute DOM injection or a second chat runtime.
