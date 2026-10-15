# Phase 4 — Professor Home and native routing acceptance

Date: 2026-10-07 (Asia/Shanghai). Status: **Verified within the approved UI-first scope**.

## Latest acceptance (supersedes the historical checkpoint below)

The user approved sidebar/Home/native routing while ordinary session listings remain unchanged.
Session separation is **deferred**, not implemented. No archival, history rewriting, DOM hiding,
host patching or second conversation store is used. This is not a complete v1 release claim.

### Delivered

- Official packaged client entry, host module-loader React, keyed sidebar/main slots and complete
  withdrawal on disable. Continue/Courses/Recent and a labelled launcher support course-free use,
  six study modes, optional topic and explicit pending/error/retry states.
- Strict package-owned Typert Remote contributions over the official authenticated gateway;
  no custom HTTP bridge or CDN. The global app row exposes no academic tools or skills.
- One deployment-owned, refcounted professor_app handle shared with the preset runtime. Consumer
  withdrawal leaves siblings usable; final release closes; re-enable retains records.
- Metadata-only serialized registry, idempotent tokens, conflicting-request refusal, same-ID
  failure retry and missing-session refusal. No copied messages or raw topic field.
- Native workspace/session creation, preset selection, course binding, memory hydration and title
  synchronization precede readiness. Navigation refreshes the native catalog before opening.
- Cold sessions restore through the official controller. Changed presets/folder contexts are
  refused safely. Failed navigation retains its request token to avoid duplicate conversations.

### Fresh acceptance evidence

| Gate | Result |
|---|---|
| `npm run verify` | Latest count in STATUS.md; syntax/skills/sync/distribution/E2E/unit gates |
| `verify:home` | Exit 0, ALL PASS: auth and no-auth rejection, native launch/course/title, retry, deletion, unload/remount and cold-process reopen |
| `verify:harness` | Exit 0; all eight stages pass |
| `verify:packaged`, `verify:native-session`, `verify:memory-restart`, `verify:onboarding` | Exit 0; packed install and prior-phase regressions pass |
| Independent narrow code re-review | No remaining blocker; targeted 51/51 pass |

The packed disposable web host was also operated in real Chrome:

1. Professor sidebar opens Home; course/mode/topic controls render and work.
2. Course-free launch with topic “验收测试” opens the native Conversation with Professor selected,
   a registered workspace and an available input. No message was submitted.
3. Home shows “验收测试 · 学习” in Continue/Recent; Continue reopens that conversation.
4. Native Plugins disable removes the entry while normal workspace remains. Re-enable restores
   the entry and the same records.

Screenshot: `/private/tmp/professor-home-accepted.jpg` (temporary evidence, not shipped).
Cold restart is separately verified by the packaged backend test, not browser automation. Browser
course binding was not claimed. `verify:home` correctly reports browser rendering as unverified
**by that script**; the manual browser evidence above is separate.

Takeover corrections include missing field children, navigation error/token handling, native cwd
shape and workspace attachment, stale client catalog, persisted header-ID lookup, preset restore,
false hydration success, conflicting in-flight requests, changed preset/folder retries, cancellation
readiness, retry title preservation and creator-owner teardown. The disposable boot harness also
needed readiness callbacks to mount the official WebSocket gateway; no custom transport was added.

### Outstanding and safety

Session separation remains deferred. Phases 5–6 skill customization and Course/Settings remain.
Phases 7–8 release/final audit remain. No model-driven teaching/tool choice was tested without
credentials/network/spend. No update was installed into the real desktop profile. Course materials,
legacy records, desktop configuration and user session logs were not modified; no push or merge.

---

# Historical foundation checkpoint (superseded above)

Date: 2026-10-07 (Asia/Shanghai). Status: **In progress, not accepted**.

## Approved exception

The user selected the UI-first option (`1`): implement sidebar/Home/native routing while native
Professor sessions remain visible in ordinary listings. Separation is deferred, not completed.
Archival, history rewriting, DOM hiding and a second conversation store are prohibited.

## Implemented in this checkpoint

- `src/app/sessions.js`: strict metadata-only registry over an injected existing app-storage owner.
  Serialized operations, concurrent idempotent reservation, conflicting request/session refusal,
  ready/failed setup tracking, same-ID failed retry and detached reads. Incompatible/corrupt data
  is refused without overwrite. No raw topics or messages are admitted.
- `test/app-sessions.test.mjs`: 11 tests, first run failed because the registry did not exist,
  then passed after implementation. This is an isolated module, **not wired into the runtime yet**.
- `tools/verify-ui-bridge.mjs`: repeatable packaged disposable real-host probe. Official
  `typert.register` + gateway `invoke` accepts a strict package-owned contribution, rejects
  unexpected input fields, and refuses calls after withdrawal. No custom HTTP route is installed.
- Scoped implementation plan and feasibility/approval record.

## Fresh evidence

| Check | Result |
|---|---|
| `node --test test/app-sessions.test.mjs` | 11/11, exit 0 |
| `npm run verify` | exit 0; 330/330 unit/integration tests, zero failures; existing E2E passed |
| Real packaged host bridge probe | exit 0; dispatch/input rejection/withdrawal passed |

Initial probe could not listen inside the sandbox (`listen EPERM`); the approved isolated local
server run succeeded. First successful dispatch run then exposed a verifier cleanup error
(`ctx.stop` does not exist). Cleanup was corrected to the established `ctx.fiber.dispose` API and
the entire probe reran successfully, including temporary-directory cleanup. Host fs.Stats
deprecation warning remains; no product failure was observed.

## Not implemented / not verified

- No `dsh.client` manifest, sidebar entry, Home, launcher or desktop-visible change.
- No production Remote service or shared global/preset application owner. The existing preset
  remains sole product storage owner; do not open professor_app twice when adding UI.
- No native launch orchestration, ready-before-navigation guarantee, deleted-session handling,
  title synchronization or browser transport/access-control proof.
- No UI lifecycle/restart/disable acceptance. The probe invokes the host gateway in-process;
  it does **not** demonstrate browser RPC or access-control enforcement.
- No model turn. No full Phase 4 or v1 completion claim.

## Next implementation order

1. Prove browser-side official Remote mounting and transport access control in the disposable host.
2. Add one shared app-storage owner with lifecycle tests; keep academic tools preset-scoped.
3. Implement native create/select/bind/memory setup and retries before returning navigable IDs.
4. Add official sidebar/main slots, Home and launcher using native conversation navigation.
5. Verify packed browser UI, normal Projects, restart and disable; rerun prior backend gates.

Real course material, legacy Registry/Knowledge, desktop configuration and user session logs were
not changed. Nothing was installed into the user's desktop profile or pushed remotely.
