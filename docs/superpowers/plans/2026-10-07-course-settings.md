# Course and Settings Implementation Plan

> **For agentic workers:** Use executing-plans for inline task-by-task execution.

**Goal:** Deliver Phase 6 views/forms over existing Professor backend contracts.

**Architecture:** Read view service, guarded mutation adapters, strict existing Remote namespace and
small host React components. No second configuration system or chat store.

**Tech Stack:** JavaScript ESM, node:test, host Typert/React/fs/native sessions.

## Task 1 — read view and overlay save contract

Files: src/app/views.js, test/app-views.test.mjs.

- [x] Write tests for course identity/category counts/recent rows, general settings, course overlay
      namespace isolation, unknown course, missing/newer index, pagination, memory/storage failure,
      save/reset with revision conflict and detached output. Observe missing module failure.
- [x] Implement createProfessorAppViews({catalog, registry, customization, memory, readProject,
      readIndex}) exposing course({courseId, offset}), settings({skill, courseId}),
      saveCustomization({skill, courseId, fields, expectedRevision, reset}). Resolve course scope
      from authoritative connected project, not caller-provided namespace. Reuse existing stores.
- [x] Run node --test test/app-views.test.mjs (12/12), npm run verify (410/410, E2E 28/28,
      exit 0); scoped re-review has no remaining Important/Critical findings. Only this task complete.

## Task 2 — bridge and guarded mutations

2026-10-08 course backend checkpoint: courses/manageCourse authenticated actions use owned native
sessions and server-held course snapshots; update/archive/reactivate guarded by connection revision,
observed project root and config digest. Native save also compares original raw document, including
a deterministic concurrent-edit regression. Packed Home gate passes editing/status/token consumption.
Ruling: Home's existing course summaries include archived status; verifier checks status rather than
assuming removal. No new course forms or material context are claimed in this backend checkpoint.

2026-10-08 additional checkpoint: workspaceCommand dispatches discover/confirm/rebuild/diagnostics
through owned-ready native Professor sessions. Server-held session-bound proposal tokens, observed
connection revision, strict selection checks and disposal cancellation are tested. Packed gate
passes actual discovery/confirmation/rebuild/diagnostics. Full430/430, focused30/30, scoped review
clear. This does not complete course-management/material adapters or the folder/job-status UI.

Files: src/plugin.js, src/app/service.js, src/app/remote.js, client/remote.js, client/client.js.

- [ ] Test strict view/command descriptors and ownership: unknown fields/actions/paths/session IDs
      refuse, contributions withdraw, root coding sessions retain zero Professor tools.
- [x] Wire readIndex/readProject through fs gateway and existing index schema; publish views on the
      existing global professorHome service. Share app owner mutation queues.
- [ ] Adapt folder discovery/confirmation, course register/update/archive, memory switch and index
      rebuild through existing implementations/native permission pipeline. Validate requests before
      action; require confirmation proposal and current config version/revision. No source writes.
- [ ] Add server material-ID validation and native context handoff before returning ready session.
      Check missing file/hash/path-policy denial; never take an arbitrary browser path as authority.
- [x] Run focused bridge/service/native tests, then npm run verify and verify:home.
      2026-10-08 checkpoint: 414/414 full, 30/30 targeted, Home/customization packed gates exit 0.
      Folder/course/memory/index command adapters above remain incomplete.

## Task 3 — Course and Settings UI

2026-10-08 accepted scoped addition: native session/folder/ambiguity/confirmation forms and
rebuild/health controls connected. Real browser verifies two-course onboarding, preference isolation,
material listing/native Study, guarded switch to a second project, and source/config hash retention.
Full435/435, E2E28/28, focused36/36; packed Home and scoped review pass. Course management,
material context and complete Phase6 acceptance remain; older partial-UI notes below are historical.

2026-10-08 partial UI checkpoint: Course detail/material pages and native Study/Ask entry points,
global/course skill preference fields/save/reset, and memory status readout are connected. Real
course-free browser save/back/reopen/reset passes. No browser course or complete Settings claim;
the unchecked tasks below retain the remaining full-scope requirements.

Files: client/client.js (split only through supported host module-loader packaging), UI tests.

- [ ] Add failing component tests for navigation, labelled forms, errors/pending, ambiguity, course
      switching, customization reset, memory off and unavailable index; then implement.
- [ ] Course view renders identity, grouped bounded materials, recent native sessions and supported
      study/question actions. Settings renders folder/course/customization/memory/index/diagnostic
      controls using the bridge. No raw YAML requirement or fake disabled action placeholders.
- [ ] Preserve native host plugin controls; withdraw all slots/requests when disabled.
- [ ] Run client contract/render and service tests and npm run verify.

## Task 4 — real packed browser acceptance and checkpoint

Files: tools/serve-home.mjs, repeatable packed service verifier, docs/v1/PHASE6.md, STATUS.md,
PROJECT_MEMORY.md, README.md.

- [ ] Use disposable fixture academic folders and the exact installed tarball; no copied credentials
      or real-profile mutations. Verify UI connect/ambiguity/course/material/preferences/native
      routing/reset/memory/rebuild/health, permission failures and normal workspace behavior.
- [ ] Run verify:harness, verify:home, verify:customization, verify:packaged, verify:native-session,
      verify:memory-restart, verify:onboarding and npm run verify; record exits/counts.
- [ ] Independent final review, source/profile snapshots and factual evidence boundaries before
      marking Phase 6 Verified. Save a scoped local commit; no push/merge or Phase 7 release claim.
