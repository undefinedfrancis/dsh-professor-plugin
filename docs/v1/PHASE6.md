# Phase 6 — Course and Settings

2026-10-09, Asia/Shanghai. **In progress — Course/Settings and material handoff connected, not full acceptance.**

## Latest connected checkpoint (supersedes foundation-only notes below)

### Phase 6 status re-check — 2026-10-12 (partially evidenced, NOT globally complete)

This entry **appends** today's factual position; every dated checkpoint below is left intact as
historical evidence.

Fresh, all exit 0: `npm test` **744** (744 pass / 0 fail / 0 skipped, enhancement runtime
configured),
`verify:e2e` **28/28**, `verify:syntax` **177 files**, `verify:skills` **39**,
`verify:sync` **89**, `verify:dist` **70**, `verify:host` **65**, `verify:harness` **266 (0 FAIL)**,
`verify:activation` **28**, `verify:desktop` **24**, `verify:packaged` **94**,
`verify:native-session` **47**. Inventory counted from source and cross-checked by three
independent gates: **22 `professor_*` tools, 6 bundled skills, 5 built-in teaching presets**.

What Phase 6 **does** have today:

- Folder onboarding (scan → ambiguity confirmation → folder change → rebuild/diagnostics) with
  dated real-browser checkpoints; course registration/edit/archive/restore including editable
  course codes; material-list and native study/ask entry points; persistent memory switch;
  bulk-clear and the five teaching presets through the settings page.
- Native/backend `verify:home` paths ALL PASS. `verify:packaged` and `verify:native-session`
  re-run green today with the corrected 22-tool inventory.

What Phase 6 **does not** have — these keep the phase open:

- The **complete Phase 6 browser matrix**: error states, responsive layout, theme, and a fresh
  browser recheck of the final artifact page. `verify:home` itself reports browser rendering, a
  model turn inside a launched session, and permanent native deletion as `UNVERIFIED`.
- **Permanent native conversation deletion** is unavailable at the host API level.
  `workspaceRegistry.archiveSession` / `unarchiveSession` exist; clearing a Recent row
  archives/hides it and is **not** deletion. This is a host limitation, not a Phase 6 defect.
- **Historical `permissionRules/decision` replay** remains an older unresolved compatibility item.
- Model-observed teaching behavior: the live-model matrix stands at **6/8 with S3/S5 OPEN**;
  "Accept and close" is scope closure, not an all-pass.

Cross-platform testing stays **deferred by the user's 2026-10-11 instruction** (Windows/Linux and
macOS Intel unverified, no longer active blockers). No paid model call, real-profile edit, commit,
push or publication accompanied this entry.

### Course deletion and review corrections — 2026-10-09

Course deletion now removes registration and reachable derived index records through the guarded
course-management command. Shared source records remain assigned to surviving courses; removal
markers prevent rebuild resurrection, and explicit re-registration clears covered markers.
Original material, notes, learning state, memory and binding history are preserved.
Review corrections add a synchronous Home duplicate-click lock, keyboard containment and focus
restoration for confirmations, exact-file markers for stale assignments outside source roots,
and authoritative index classification during search regardless of cached chunk metadata.
Fresh verification: full verify 481/481, E2E 28/28; isolated packaged verify:home ALL PASS.
Real desktop confirmation Tab/Shift-Tab/Escape checks passed without deleting user data.
Native conversation deletion remains blocked by the installed host's public API; historical
permissionRules/decision replay and the complete Phase 6 matrix remain unresolved. See
`docs/v1/2026-10-09-review-corrections.md`. Changes remain uncommitted.

### Native material-reference handoff accepted — 2026-10-09

Authenticated launchMaterial accepts request/course/file IDs and learn/question only. It validates
material before and after existing Home native session setup, checks actual native cwd, and refuses
changed root/path/hash/version. Plugin lifecycle aborts the validator and forwards its signal to
Home's existing launch cancellation. Backend returns only server-derived reference metadata.

Course material rows now offer Study/Ask. Client uses the installed host's retained-session API
`sessions.using(...,{source:'workspaceOperation'},...)`, `conversation.input.for(binding.ctx)` and
native `addFiles(referenceChips,[])`. Quoted mention grammar/chip shape match the host file picker.
It appends instead of replacing existing draft content. It never calls submit/prompt/send or owns
new attachment/chat storage. Input receipts/uploads were inspected but not used: local workspace
file references are the appropriate native mechanism here. Client retry IDs preserve native request
identity; completed handoffs are locally remembered to avoid duplicate insertion on navigation retry.

Review found two Important lifecycle gaps (late component handoff after unmount and signal not
passed to Home), plus invalid client codec calling an undefined helper. Each was reproduced by a
failing regression then fixed. Client checks both component sequence and UI lifetime before/after
asynchronous retention; disposal blocks mutation/navigation. Focused launcher/client **32/32**.
Fresh full verify **458/458**, E2E **28/28**, zero failures/skips, exit 0:
`/private/tmp/professor-material-launch-final.log`. Final packed Home gate exit 0:
`/private/tmp/professor-material-launch-home-final.log`, including actual material session preparation.

Exact isolated installed bundle browser: connect fixture CSC3200 → course page → Study material
opens native Professor composer with lecture.txt reference chip and user-owned Send button, no
message; Ask material repeats in question mode. Source SHA-256 is unchanged through positive
operations (`2a90d4491efe3a5193168b73f6a718109145743e8f2c09fc026eaabd1888fab1`). Then
deliberately edit only the disposable fixture after indexing: Study refuses changed original on
the course page and asks to rebuild; no silent launch. Screenshots:
`/private/tmp/professor-material-native-handoff-accepted.jpg` and
`/private/tmp/professor-material-changed-refused.jpg`. Test tab and server closed, test data cleaned.

No real installation, profile credentials, user originals, model turns, push or merge. Validation
is at preparation time: after a user waits/edits the original, normal native file-reference reading
remains host-owned and does not promise an immutable attachment copy. Full Phase 6 acceptance still
requires the complete regression gate matrix and remaining negative/error workflows.

### Material stable-ID validation foundation — 2026-10-09

`src/app/materials.js` introduces an injected internal validator over the existing catalog/index,
fs gateway and path policies. Browser-shaped input accepts only bounded course/file IDs. It refuses
unknown/duplicate IDs, unsupported/mismatched index root, missing fingerprint, unsafe relative path,
wrong course ownership, canonical project/course-source escapes (including symlinks), read-policy
denial, missing/non-file/oversized sources and changed content/version. Hashing is capped at 32MiB.
It rechecks connected project/source roots and indexed identity/hash after IO, and respects abort.
Originals are only read; no new storage, tool dispatch, model message or session mutation exists here.

Initial missing-module RED, then passing tests. Scoped review found one Important contract mismatch:
catalog summarizeCourses uses source path strings, not raw `{path}` records. Fixtures now invoke the
actual summary function; RED reproduced refusal of valid sources, correction restored passing tests.
Eight focused tests include actual gateway fixture IO and a symlink escape refused before hashing.
Fresh full verify after the catalog correction: **449/449**, E2E **28/28**, zero failures/skips,
exit 0. Log `/private/tmp/professor-material-validation-final.log`; focused **8/8**.

**Foundation only, not wired to production Remote, native handoff or UI.** Returned observedVersion
is evidence of the checked version, not permanent freshness. The native handoff adapter must consume
that version with an appropriate guard/revalidation at use. This review minor is retained as an
integration requirement. Full Phase 6, material-specific native context and browser acceptance remain.

### Course-management browser acceptance — 2026-10-08

Supersedes the unverified browser/Git status in the historical checkpoint below. Automatic approval
was available on this continuation. Exact isolated installed bundle: create native setup session,
scan/confirm CSC3200 and MAT1001, explicitly read managed courses, edit CSC name while MAT has an
unsaved name draft, save CSC → MAT draft retained; archive without acknowledgment refused;
acknowledge/archive → archived status; restore → active status; change term to Spring 2027/save.
Final project.yaml confirms stable csc3200/mat1001 IDs, updated CSC name/term, both active, and MAT's
draft not persisted. Both original fixture SHA-256 digests are identical before/after all operations.

Fresh full verify **441/441**, E2E **28/28**, zero failures/skips, exit 0:
`/private/tmp/professor-course-ui-acceptance-verify.log`. Actual screenshot:
`/private/tmp/professor-course-management-accepted.jpg`. Browser closed and isolated server stopped,
normal test cleanup removed disposable fixture data only. No actual installation, account credentials,
model turns, push or merge. This accepts scoped course management, not full Phase 6; material ID
revalidation/context handoff and remaining complete matrix are still required.

### Course-management UI component checkpoint — 2026-10-08

Folder/courses settings now offers explicit native course listing including archived entries,
editable name/term, immutable course IDs, archive acknowledgment and restore. Adding courses uses
the existing scan/confirmation workflow. Selecting a different session/folder, creating a setup
session or confirming a folder clears the old list. Success reloads native course snapshots and
Home; failure clears the snapshot and requires a fresh read. Pending work guards duplicate requests.
Course edits reuse the parent connection-transition lock/clear/reload callbacks so old course
preference drafts cannot be saved during the academic configuration mutation.

Component RED→GREEN: missing explicit read action first failed; implemented form refuses archive
without acknowledgment, then sends only observed token/ID/operation. Focused tests **45/45**.
Scoped review found an Important issue: refreshing after one course edit discarded another course's
unsaved fields. A two-course regression failed with persisted name replacing the draft; the fix
merges only unaffected dirty rows into the new authoritative snapshot, retaining current status and
resetting archive acknowledgment. Unmounted successful actions no longer start new list reads.
Final fresh verify after the draft fix: **441/441**, E2E **28/28**, zero failures/skips, exit 0;
focused **45/45**. Log: `/private/tmp/professor-course-ui-draft-final.log`.
Actual browser course-management acceptance is **not performed**. An automatic approval-review
quota failure prevented the previous backend checkpoint's Git commit; no escalation was bypassed.
All backend/UI changes remain in the worktree atop 3c54a7c until Git save can be reviewed.
No desktop update or model turn. Full Phase 6 remains incomplete.

### Guarded course-management backend — 2026-10-08

The existing authenticated workspaceCommand now supports courses/manageCourse for owned ready
native Professor sessions. Listing includes archived courses and returns a session-bound server
token, observed connection revision, project root and SHA-256 config fingerprint. Tokens expire
after 15 minutes, are bounded to 20, and are consumed after a successful edit. Browser edits accept
only observed course ID, update/archive/reactivate, display name and term: no paths, source/output
changes, course-code change or import. Registration remains through existing folder onboarding.

Native course tools expose optional observed root/digest checks. All course saves now carry the raw
document originally loaded into saveProject's existing optimistic guard. A deterministic regression
first allowed a concurrent source-inspection edit to be overwritten; with expectedRaw it refuses
and retains the concurrent name. Existing native callers need not supply the new optional fields.

Final fresh full verify **440/440**, E2E **28/28**, zero failures/skips, exit 0; focused **44/44**.
Evidence logs: `/private/tmp/professor-course-guard-final.log` and
`/private/tmp/professor-course-guard-home-final.log` (packed gate exit 0).

Fresh isolated packed Home gate exit 0 proves update/archive/reactivate preserve course ID, tokens
cannot be reused, Home metadata reflects archived status, and native course launches still bind.
Initial new verifier wrongly expected archived courses to disappear from Home; the established Home
contract retains summaries with status, so verification now checks that metadata rather than changing
the product's contract. No source, real-profile, credentials or model turns changed.
Scoped independent review found no Critical/Important findings; its missing race-coverage minor was
subsequently covered by the deterministic RED→GREEN test. This is backend-only: no course form or
browser management acceptance. Full Phase 6 and material handoff remain outstanding.

### Harness-aligned settings UI — 2026-10-08

User approved the “宿主分区” preview. Settings now has learning preferences, folder/courses,
and durable-memory navigation. Diagnostics/index repair deliberately remain beside the selected
workspace native session. Inactive panels use native hidden and stay mounted; no native permission
or authenticated mutation contract changed. Home/details inherit host typography and use neutral
currentColor controls instead of visible serif/green overrides.

Test-first navigation regression failed for missing workspace navigation, then passed. Fresh full
verify **436/436**, zero failures/skips, exit 0; client **22/22**. Independent scoped review found
no Critical/Important issues. Minor remaining coverage: running scans/proposals across navigation
are structurally retained, but were not directly browser exercised in this checkpoint.

Exact isolated installed bundle browser: preferences → folder → memory → preferences retains
unsaved language; returning to folder retains its unsaved path. At 600px viewport, navigation is
horizontal and plugin clientWidth/scrollWidth are both 544px (no horizontal overflow). Screenshot:
`/private/tmp/professor-harness-ui-accepted.jpg`. Temporary viewport reset and browser closed;
isolated server stopped. No real credentials, installation, material originals or model turns.
This is only a visual/settings checkpoint: course management, material handoff and full Phase 6
gate matrix remain outstanding. Shared visual overrides are scoped; legacy CSS deduplication
and direct running-scan navigation coverage are follow-ups, not claimed completed.

### Folder onboarding UI accepted checkpoint — 2026-10-08

Settings now renders native-session selection and explicit setup-session creation (no automatic
model message), folder input, read-only scan, bounded candidate choices and course identity fields.
Ambiguous candidates default to excluded; inclusion requires a nonempty explicit course code.
Changing the selected session/path clears its previous proposal. Confirmation sends only the
server proposal token and explicit choices; changing folders requires a separate acknowledgment.
Configuration/index/extraction/search readiness, retry actions and diagnostic health/limitations
are presented separately. Course management beyond onboarding is still outstanding.

Before confirmation, the parent synchronously locks preference writes, clears old course drafts
and the selected course, then reloads global settings and authoritative course choices afterward.
Regression tests first reproduced stale course state and an already-rendered Save callback still
writing; both now refuse during a connection transition. Scoped re-review has no Important/Critical
findings. Full verify **435/435**, E2E **28/28**, exit 0; focused component/views **36/36**;
packed Home gate exit 0.

Real browser, exact isolated installed tarball: create native configuration session → scan two
test courses (CSC3200 high-confidence; Algorithms excluded as ambiguous) → explicitly identify
ALG1001/include → confirm → all four readiness states complete → rebuild → health → course scope
preference save/switch/readback (C++ absent from the other course) → browse indexed course material
→ Study opens native Professor composer with no model message. A second isolated project with the
same course code refuses changing folders without acknowledgment, then connects after explicit
confirmation. Old draft is cleared and new-project course fields are empty. No YAML editing.

All three original fixture-content hashes stayed identical; the first project's project.yaml hash
also stayed identical during the switch. Temporary screenshot evidence:
`/private/tmp/professor-phase6-onboarding-accepted.jpg` (two-course connection and diagnostics).
The test server/tab and isolated fixture home were closed/cleaned after acceptance. No real profile,
course originals, credentials or model turns were changed. Full Phase 6 still requires course
management, material-ID context handoff, remaining negative cases and the complete gate matrix.
Notes below are historical checkpoints, not current missing-UI claims.

### Guarded workspace command foundation — 2026-10-08

The authenticated professorHome bridge now exposes one narrow workspaceCommand envelope:
discover/confirm/rebuild/diagnostics only, dispatched through the existing native tool pipeline.
The selected session must be registry-owned, ready, actually present and still using Professor;
ordinary coding sessions gain no tools. Caller tool names, raw proposals, arbitrary selection
fields and selections not in the discovered candidates are refused.
Discovery caches a detached server-owned proposal under a session-bound token (15-minute expiry,
20-proposal cap). Confirmation retains the native fingerprint checks, uses the observed connection
revision (0 for a fresh connection), and refuses changed connections. Applied proposals are consumed.
Disposal refuses queued actions before dispatch and aborts running native tool work.

Fresh full verify: **430/430**, E2E **28/28**, exit 0; focused **30/30**. Packed Home gate exit 0
proves native discovery, authenticated server-proposal confirmation, unknown-session refusal,
diagnostics and derived-index rebuild. Initial packed confirmation exposed an undefined revision
argument on a fresh connection; explicit zero revision corrected the strict tool boundary. Lifecycle
review reproduced a delayed-dispatch-after-disable race; failing regressions precede its fix.
Independent scoped re-review has no remaining Important/Critical findings.

This is a backend checkpoint, not Settings form/browser acceptance. Folder input, session selection,
ambiguity choices, readable job state and change-folder confirmation still need their UI; course
management and material-context adapters remain separate outstanding tasks. No real desktop update,
source-material mutation, credential copying or model turn. Notes below are historical checkpoints.

### Memory switch accepted checkpoint — 2026-10-08

Settings now has an authenticated, revision-guarded global memory switch and a reload action.
Absent control is explicitly represented by null revision; stale writers refuse. The existing
store preserves memory/customization records, shares the deployment queue and refreshes active
native sessions. Hydration degradation is reported separately from an already successful write.
Switching does not silently discard unsaved preference drafts; duplicate clicks are guarded.

Fresh full verify: **420/420**, E2E **28/28**, exit 0; focused **58/58**; packed Home gate exit 0.
The real native prompt contains a durable marker, becomes empty after authenticated UI disable,
and regains the marker after re-enable. Browser acceptance on the exact isolated installed bundle
proves saved preference retention, disable/back/reopen, re-enable, and unsaved draft preservation
through off/on. Screenshot: `/private/tmp/professor-phase6-memory-switch-accepted.jpg`.
Independent re-review: no remaining Important/Critical findings. Initial parallel Home packing
attempt failed before host activation; isolated retries and final native checks passed.
No real desktop installation, original course data, credentials or model turns were involved.
Full Phase 6 remains incomplete: folder/course-management, rebuild/diagnostics and material-context
actions plus the complete browser acceptance matrix remain. Notes below are historical checkpoints.

Additional 2026-10-08 preparatory checkpoint: memory mutations now share the deployment queue
across global-app and preset-runtime storage facets. A deterministic blocked-write regression
first reproduced two successful writes accepting the same revision; after correction only one
accepts and the other reports PROFESSOR_MEMORY_STALE. Focused tests 35/35, full verify 415/415
(exit 0), and packed real-host memory restart verification exit 0. Independent scoped review
found no Important/Critical issues. Initial sandboxed host attempt could not listen on localhost;
the approved isolated retry passed. This does not implement the memory switch UI or complete
Phase 6. Default same-handle multi-store coverage is a minor follow-up from review.

- Existing authenticated professorHome Remote now exposes strict course/settings/saveCustomization
  methods; host, ESM client and browser bundle descriptors match. No arbitrary path/namespace input
  is admitted; view-specific backend guards reject inappropriate fields before action.
- Global app row reads the authoritative project/index through the existing fs gateway and resolves
  recent native session roots from live/persisted headers. It still grants no Professor tools to
  normal sessions. Settings uses the existing app-storage facet and shared deployment write queue.
- Home now has Settings and course-detail navigation. Course shows identity, paginated indexed
  materials, verified-project recent metadata and native Study/Ask entry points. Materials remain
  explicitly `not-checked`; no material-specific native context action is claimed yet.
- Settings renders six skill choices, global/course scopes, five labelled preference fields,
  save/reset and readable memory state. It does not yet change memory enablement or academic folder.
- Failed course launch/navigation retries keep their token for the same mode; changing mode starts
  a new intent. A failing regression reproduced the conflicting-token bug before correction.

Fresh checks: npm run verify exit 0, **414/414** tests, zero failures/skips, E2E **28/28**.
verify:home and verify:customization exit 0. Packed Home test proves settings before any native
session, revisioned authenticated writes, stale refusal, real indexed course view, native project
history and course/global overlay separation. Phase 5 reinstall/new-process regressions still pass.
Independent scoped review found no Important/Critical blockers; targeted **30/30** pass.

Real in-app browser operated the exact disposable installed bundle without credentials:
Home → Settings → save Chinese/detailed preferences → Home → reopen Settings reads saved fields
→ clear customization empties fields. No YAML editing or model message. Screenshot evidence:
`/private/tmp/professor-phase6-settings-accepted.jpg` (temporary, not shipped).
Course page and course-scope switching have component/backend evidence, not a browser acceptance
claim in this checkpoint. The browser was course-free. Full Phase 6 acceptance remains outstanding.

Still required: folder discovery/ambiguity/confirmation UI, course management,
rebuild/diagnostics controls, safe material-ID revalidation/context handoff and complete packed
browser workflow. No release claim, real-profile installation, original material write, push or merge.

---

## Historical service foundation checkpoint

The user approved the lightweight Course/Settings design. The execution plan is
docs/superpowers/plans/2026-10-07-course-settings.md. Existing feature branch/checkout retained.

## This checkpoint

`src/app/views.js` defines injected read/save contracts over existing stores:

- Course identity, known material-category counts, 50-row index metadata pages and recent native
  session metadata. Missing/unsupported/corrupt/unreadable index states are explicit. An indexed
  record is **not** proof the source still exists (`availability: not-checked`).
- Settings reads reuse existing global/course customization and memory control. The server derives
  namespace from the connected authoritative project; the browser cannot choose a namespace.
- Save/reset delegates to the existing Phase 5 store with expected revision and explicit-save intent.
  No new registry, configuration store, memory store or filesystem writes exist in this module.
- Read projection excludes arbitrary metadata, copied contents and unsupported category keys.
  Unknown courses fail; outputs are detached. Memory/customization failures are not empty successes.
- Recent rows require authoritative native session project-root association, not course ID alone.
  Missing association means unavailable history, preventing cross-folder same-ID contamination.

Test-first evidence: initial missing-module failure; targeted 12/12 pass after implementation and
regression fixes. Review found cross-project recent leakage and corrupt-record indexed success;
both reproduced by failing tests and fixed. Extra tests cover detached outputs, storage failures,
scope isolation, pagination/wire-sized projections and input values that JSON would otherwise drop.

Fresh `npm run verify` exit 0: 410/410 tests, zero failed/skipped, E2E 28/28. Scoped independent
re-review found no remaining Important/Critical findings (12/12 targeted). No production bridge/UI
or real-browser acceptance is implied by these contract tests.

## Still required

This service is **not wired to the production Remote or client yet**. No visible Course/Settings
page was added or accepted in this checkpoint. No UI action/desktop-install claim is made.

Next: authenticated strict bridge, native permission-preserving mutation adapters, folder ambiguity
confirmation, course management, memory switch, rebuild/diagnostics, safe material ID revalidation
and native context handoff, then React pages and real packed browser acceptance without YAML.
The sessionProjectRoot adapter must read native live/persisted headers without guessing a project.

No real course materials, desktop configuration or user logs were touched. No model call, push or
merge. Phases 7–8 release/final audit remain separate; approved session separation deferral remains.
