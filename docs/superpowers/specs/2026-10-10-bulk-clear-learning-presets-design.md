# Bulk conversation clearing and learning presets

Status: design for user review; no implementation authorized by this document alone.

## Intent and scope

Make Professor easier to manage and immediately useful after installation: one confirmed action clears all Professor Recent conversations, and learners can select bundled teaching modes or save their own. Preserve materials, notes, indexes, memory, course bindings and native history. These features extend the current Home clearing flow and skill preference overlays, not native Harness model/preset configuration.

## 1. Clear all conversations

- Place “全部清除” beside the Recent heading. Keep individual actions.
- Scope is every non-archived Professor registry row, including rows beyond the displayed Recent limit; never other Harness conversations.
- Before mutation, fetch a backend-owned snapshot of exact IDs and count. Confirm “清除 N 条对话？” with native archiving/recoverability and file-preservation explanations. New conversations created after this snapshot are excluded.
- A bounded, expiring, single-use confirmation token binds that snapshot. Resolve ownership on the backend, never trust arbitrary client ID lists. A retry reads a fresh snapshot of remaining rows; no replay can absorb newly created chats.
- Process sequentially using the existing single-session clear service. Confirmed presence must archive first; confirmed absence permits stale-row cleanup; unknown existence, active sessions and preparing rows remain untouched. Catch per-item errors and continue.
- Return counts and exact per-item outcomes: cleared, skipped, failed. A partial result is not universal success. Show remaining reasons and permit another explicit confirmation. Disable duplicate submission synchronously and show progress/status.
- Bound execution batches and payloads; for large registries use a resumable token-scoped cursor rather than one timeout-prone remote call. UI advances batches automatically after the one confirmation. Expiry/failure never expands the snapshot.
- Keep tombstones for launch idempotence. Refresh native navigation and Home after progress/completion. Do not automatically unarchive or delete native history.

## 2. Learning preset library

- First release: 循序讲解, 引导思考, 考前复习, 编程实践, 快速答疑. Bundled definitions are local package assets, available offline at first install.
- Each definition has a stable ID, name (80 characters), description (240), bounded teaching fields and teaching instructions (within the existing 2048-character additionalInstructions budget), version and provenance. No executable code, remote installation or paths from external skills.
- Separate immutable bundled definitions from a versioned user library in the existing app storage domain. User entries are limited to 50, support optimistic revision checks and reject malformed/unsupported schemas without overwriting them.
- Offer selection, preview, “使用此预设”, “新建”, and “另存为”. User definitions support edit and confirmed delete. Built-ins can be copied but not overwritten/deleted. Saving a definition does not silently activate it.
- Apply to the selected global/course scope for professor-study only initially. Advanced task-specific preferences continue independently. Preserve language/programming preferences unless the preview explicitly identifies a changed field.
- Activation snapshots the definition into the existing customization overlay and records the applied preset ID/version plus applied overlay revision separately. Manual preference edits show “已自定义”; editing/deleting a library entry does not silently alter an already applied snapshot.
- User library is profile-level; course application uses the existing namespace + immutable course ID scoping. Removing a course does not delete the user preset library.
- Provide an explicit “恢复自动” option. Existing users retain their existing preferences and start with no forced preset. Fresh users receive the default 循序讲解 selection through normal composition without writing into their material folder.

## 3. Prompt composition and safety

- Reuse customization validation and composition, rather than introduce a competing prompt pipeline. Presets supply lower-priority teaching preferences, not system authority.
- Course identity, retrieval/source truth, tool permissions and safety contracts remain outside preset control. Never copy third-party onboarding that asks learners to reselect an already bound course.
- Activation takes effect on the next composed study turn, not an in-flight turn. Inspect existing runtime composition/cache behavior and explicitly invalidate preference caches if required. UI must only claim next-turn activation after an integration test proves it; fail activation rather than claim false success.
- Clearly distinguish learning mode from Harness deployment preset/model. Never modify the user's model, credentials or native permission settings.

## 4. External skill sourcing and release gate

Research observed on 2026-10-10:

| Candidate | Evidence | Disposition |
| --- | --- | --- |
| Jellypod-Inc/school-skills | https://github.com/Jellypod-Inc/school-skills shows MIT, 7 stars, 1 fork | Relevant candidate, not demonstrated high popularity |
| benrosche/socratic-tutor | https://github.com/benrosche/socratic-tutor shows MIT, 2 stars; depends on instructor solutions/server | Low-popularity reference; do not embed its server workflow |
| jiangkaiqi2005/study-tutor | https://clawhub.ai/jiangkaiqi2005/skills/study-tutor found through search; direct page failed | Downloads, ratings and license not verified; not approved for bundling |

These are candidates, not final selected sources. Search additional GitHub/ClawHub candidates and compare verifiable stars/downloads/ratings with capture dates, keeping repository popularity distinct from individual skill quality. Missing ratings/downloads must say unavailable, never be invented. The current candidates do not satisfy the user's requested high-popularity evidence.

Before any third-party-derived definition ships: read its exact skill and dependencies as untrusted data, verify the actual license file, pin a commit/version, document adapted sections and removed dependencies, retain required attribution/license notices inside package distribution, and test against Professor contracts. A root README's license badge alone is not the final license review. Discard destructive instructions, telemetry, external-service requirements and privilege-changing content.

If no suitable popular redistributable candidates are verifiable, present the evidence and obtain user agreement before substituting original presets or low-popularity candidates. Do not silently claim popular curated imports. No runtime auto-update or fetching is included.

## 5. Components and compatibility

- Home/registry: snapshot and bounded bulk orchestration around existing clearSession.
- New focused preset-library module: schema, CRUD, bounded catalog, revision and provenance validation.
- App views: catalog/library endpoints, preview and explicit apply through customization store; expected revisions protect concurrent edits.
- Backend remote, exported remote and embedded bundle: strict matching descriptors and bounded payloads.
- Client: Recent heading actions/progress, preset picker/editor/preview in learning preferences. Follow selected host-section styling, keyboard accessibility, responsive wrapping and theme variables.
- Packaging: explicitly include assets and license notices in npm pack; preserve old customization records. New metadata is additive, not a breaking rewrite of existing schemas.

## 6. Acceptance

Bulk: beyond-list-limit rows included; no foreign chats; cancel zero mutations; snapshot excludes new chats; duplicate submit blocked; partial failure preserves rows; unknown existence never hides a native chat; active/preparing skipped; timeout/resume/token expiry safe; restart tombstones preserved; native archive recoverable and materials unchanged.

Presets: all five available in an offline packed installation; selection/preview/apply matches actual composed next-turn prompt; no automatic course reselection; create/edit/copy/delete persist across restart; active snapshot survives library deletion; revisions reject stale writes; global/course isolation; manual edits marked custom; existing preference migration preserves data; hostile custom text cannot change permissions/course identity; budgets enforced; distribution contains provenance/license notices.

Run focused tests, full verification and isolated real-host tests. Validate wide/narrow and light/dark UI plus long names and errors. Use disposable sessions/materials only; no paid model turns without explicit authorization. Report visual/model gaps honestly.

## Delivery stages

1. User reviews this design, particularly batch scope and preset application semantics.
2. Write a detailed implementation plan and complete third-party source selection evidence before preset bundling.
3. Implement batch clearing, then library/storage/composition, then UI/packaging.
4. Verify and report separately for each feature. Do not claim total project completion.
