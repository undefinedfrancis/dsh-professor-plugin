# Skill Customization Implementation Plan

> **For agentic workers:** Use executing-plans for inline task-by-task execution.

**Goal:** Implement Phase 5 persistent global/course overlays without changing bundled skills.

**Architecture:** Existing professor_app storage, strict optimistic revisions and deterministic
composition. Provider.get uses the current native agent binding, never shared catalog state.

**Tech Stack:** JavaScript ESM, node:test, existing Harness storage/provider APIs.

## Task 1 — validated storage foundation

Files: src/skills/customization.js, test/skill-customization.test.mjs.

- [x] Add tests using the real createAppStorage over createFakeStorageDomain. Assert persisted
      global/course scopes, expectedRevision conflicts, explicit-stable evidence, reset revision,
      unknown skills/fields, text limits, invalid/newer schemas, detached reads and reopen.
- [x] Run node --test test/skill-customization.test.mjs and observe missing-module failure.
- [x] Implement createSkillCustomizationStore({appStorage}) with read({skill, scope}),
      update({skill, scope, fields, expectedRevision, evidence}) and reset with the same mutation
      arguments. Scope is null or {namespace, courseId}; absence revision is 0. Update replaces
      the selected overlay, not another scope. Reset preserves revision and stores empty fields.
- [x] Rerun targeted tests and npm run verify; checkpoint only foundation as In progress.

## Task 2 — deterministic composition and native provider connection

Files: src/skills/compose.js, src/skills/provider.js, src/plugin.js,
test/skill-customization-compose.test.mjs, test/skills.test.mjs.

- [x] Test composeSkill({builtIn, global, course, session}) replacing structured preferences in
      that order, escaping markup, retaining labelled additions, immutable-policy framing and
      no mutation of inputs. Repeat CSC3200/STA2001/general lookups in one process.
- [x] Observe targeted failures before adding the function. Integrate a resolveCustomization
      callback only in provider.get; list candidates remain invariant. Real host inspection has
      confirmed lookup.scope is exec.agent and get bodies are not cached by SkillRegistry.
- [x] Resolve namespace/course via existing project loading and readBinding using lookup.scope;
      missing binding means global only. Expose a live store through the existing shared facade for
      Phase 6, and do not add unapproved frontend or modify existing academic tool count.
- [x] Rerun provider/storage tests and npm run verify (397/397); bundled skills have no Git diff.
      Packed skill checksum/reinstall proof remains Task 3, not claimed here.

## Task 3 — packed native/restart acceptance and final review

Files: tools/verify-customization.mjs (including --restore child branch),
package.json, docs/v1/PHASE5.md, docs/v1/STATUS.md, PROJECT_MEMORY.md.

- [x] Reuse packaged-profile.mjs to install the exact tarball in a disposable profile. Save
      global detailed language preferences and two distinct course overrides through the service.
- [x] Load professor-study from fresh native scoped agents via ctx.skills.get with scope: agent,
      asserting respective course fields, no sibling leakage, reset/global inheritance and
      current explicit instructions staying ephemeral. No model turn.
- [x] Launch a fresh host process against the same disposable domain; reload settings, native
      skills and hashes. Assert original fixture materials/real desktop profile unchanged.
- [x] Run npm run verify, verify:customization, verify:home, verify:packaged, verify:native-session,
      verify:memory-restart and verify:onboarding. Record exits and counts; separate prompt evidence
      from model-observed behavior. Request final review before marking Phase 5 Verified.
