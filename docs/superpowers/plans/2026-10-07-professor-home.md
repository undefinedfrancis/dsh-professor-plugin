# Professor Home and Native Routing Implementation Plan

> **For agentic workers:** Use executing-plans for inline execution, task by task.

**Goal:** Add the approved Professor sidebar/Home and launch native Professor conversations, leaving ordinary session lists untouched.

**Architecture:** Keep academic tools preset-scoped. Home uses official client slots and an authenticated host Remote contribution; a metadata-only registry lives in the existing professor_app domain. Native sessions own all conversation history. Readiness precedes navigation; failed setup is visible and retryable.

**Tech Stack:** JavaScript ESM, node:test, Harness Cordis services, host module loader and React.

## Boundaries

User approved UI-first scope on 2026-10-07. Session separation is incomplete, not a release claim.
No session archival, history duplication, CSS/DOM hiding, real-profile testing or credential copying.
Home uses restrained host-compatible typography, clear Continue/Courses/Recent sections and an accessible launcher; it has no analytics dashboard. Full course/settings pages belong to later phases.

## Task 1 — Metadata registry

Files: create `src/app/sessions.js`, `test/app-sessions.test.mjs`.

- [x] Write tests for create/reopen, strict metadata projection, invalid records, bounded strings,
      request-token conflicts, missing sessions and a failed setup retried without a new native ID.
- [x] Run `node --test test/app-sessions.test.mjs`; confirm failure because registry is absent.
- [x] Implement a serialized registry over `appStorage.ensureOpen/table/writeRecord` using a single
      `sessions:registry` record (`professor.sessions/1`). Do not persist messages or raw launcher topics.
- [x] Run targeted tests, then `npm test`; record fresh output (11/11 targeted, 330/330 full).

Registry API: `reserve({requestId, sessionId, courseId, title, mode})`,
`settle(sessionId, {status, error})`, `list()`, `get(sessionId)`.
Allowed modes: learn/question/assignment/review/exam/free; status: preparing/ready/failed.
Identical request retries return the existing row. A different payload for the same request refuses.
Corrupt records are read-only failures, never reset. Every returned row is detached from storage.

## Task 2 — Official bridge and lifecycle

Files: host integration in `src/plugin.js`, `src/app/home.js`, shared storage owner module, manifest/bundle changes;
tests for ownership and native routing. Preserve all existing preset isolation assertions.

- [x] Inspect installed Typert gateway discovery and codecs; prove a minimal package-owned Remote
      contribution in a disposable profile before adding a product bridge. No HTTP workaround.
- [x] Verify shared professor_app ownership across global UI and preset lifecycle, including disable.
- [x] Test launch validation, concurrency/retry, preset selection, course binding, memory assembly
      before return, and stale/deleted session refusal. Never submit an automatic model turn.
- [x] Implement only APIs proven by the real-host probe and rerun it against the packed tarball.

## Task 3 — Home and launcher

Files: `client/client.js`, `client/remote.js`, `package.json`; client registration/navigation tests.

- [x] Test official sidebar/main registration and complete removal on disable.
- [x] Register the keyed panel through ctx.slots; use host React/module-loader exports.
- [x] Render Continue, Courses, Recent Sessions and New Study Session, with course-free empty state.
      Form labels cover course, six modes and optional topic; show pending/error/retry states.
- [x] Navigate ready sessions through uiWorkspace.openSession and layout.selectPanel(null).
      No duplicate conversation component. Every displayed action has a real supported route.

## Task 4 — Acceptance and checkpoint

Files: packaged/UI verifier, `docs/v1/PHASE4.md`, `docs/v1/STATUS.md`, `PROJECT_MEMORY.md`.

- [x] Run npm run verify, verify:harness, verify:packaged and native-session/onboarding regressions.
- [x] Disposable real browser: enable/Home/launch/reopen/disable and normal workspace remain.
      Cold restart verified separately by packaged host; browser restart is not claimed.
- [x] Record exact verified and unverified criteria, including deferred session separation/model turns.
- [x] Review diff and create a scoped local checkpoint; do not push or alter real desktop settings.

Final acceptance: 381/381 tests; host, packaged, Home, native-session, memory-restart and onboarding
gates exit 0. See docs/v1/PHASE4.md for browser evidence and intentionally unverified boundaries.
