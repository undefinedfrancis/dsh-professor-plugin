# Phase 5 — deterministic skill customization

2026-10-07, Asia/Shanghai. **Verified — backend/native content and persistence; no model turn.**

## Final acceptance (supersedes the checkpoint below)

Full verify: 398/398 tests, zero failures/skips, E2E 28/28, exit 0. Dedicated packed
`verify:customization` exit 0, ALL PASS: actual native CSC3200 C++/STA2001 formula-intuition/global
loads are isolated; repeated loads are fresh; reset inherits global preferences. Reinstallation
unpacks a replacement copy without changing persistence bytes; a separate host process executes
the installed verifier and new native sessions restore global/course customization. Fixture sources,
source/installed bundled skill hashes and real desktop profile fingerprints remain unchanged.

The sequential eight-stage `verify:harness`, `verify:home`, `verify:packaged`, `verify:native-session`,
`verify:memory-restart`, `verify:onboarding` matrix exited 0. Independent read-only review found
no Critical/Important blockers (17/17 targeted tests). Allowed whitespace controls were clarified
per minor feedback: tabs/newlines/carriage returns are accepted for readable preferences.

Real acceptance found the course identifier integration defect (`course_id`, not `id`), then passed
after correction. Distinct runtime facets now serialize by shared deployment identity: the delayed-
write regression first accepted two stale writes, then correctly accepted one and refused the other.
Releasing one consumer leaves the other's settings readable.

Current-session Python precedence and no implicit persistence are pure composition evidence using
a real loaded skill, **not** model behavior. Native explicit instructions remain conversation input;
old skill messages in history are not rewritten. Prompt framing is not a security sandbox, and
host permissions/tool validation remain authoritative. No model-driven action/teaching claim.

Restore uses the same shipped verifier's `--restore` branch instead of a second file. Reproduce with
`npm run verify:customization`. No frontend, real desktop installation, credential copying, real
course writes, push or merge. Phase 6 Course/Settings and Phases 7–8 release/audit remain.
Session separation is still deferred under the approved UI-first exception.

---

## Historical backend checkpoint (superseded above)

The user approved the design in chat. The implementation remains on the existing feature branch;
no settings frontend, desktop installation, model call or source-material change is included.

## Implemented checkpoint

- `src/skills/customization.js`: six recognized bundled skills; five bounded preference fields;
  global and project/course tuple keys in the existing professor_app domain; explicit-stable
  saving intent and required expectedRevision; same-handle serialization; monotonic reset;
  detached reads; corrupt/newer schemas refused without overwrite.
- `src/skills/compose.js`: deterministic structured precedence and labelled additional preferences;
  escaped user markup; immutable safety/format boundaries; pure ephemeral session composition.
- Provider integration recomposes skill bodies on each get using lookup.scope, not catalog cache.
  Existing read-only binding resolution is reused, avoiding another course registry. Missing storage
  loads built-ins with a visible warning; corrupt customization still fails loudly.
- Live settings store is exposed through the existing professorAppStorage facade, with ownership-
  checked cleanup. A new preset-provided service was rejected by the real host's isolate-realm
  requirement; the regression was reproduced and the service removed.

## Evidence and boundary

New targeted storage/composition/runtime contracts: 16/16 pass, preceded by failing tests.
Real packed `verify:home`: exit 0, ALL PASS after the service correction. This proves prior Home/
native behavior remains operational, **not** that every course customization criterion is accepted.
Fresh final `npm run verify` exit 0: 397/397 tests, zero failures/skips; E2E 28/28.
Bundled skills have no Git diff. This checkpoint is not a full Phase 5 acceptance.

Installed host source was read directly: SkillRegistry caches catalog candidates only; body get
receives options.scope. The native skill tool passes the calling agent as scope. No host patching.

## Required before Phase 5 Verified

- Dedicated packed native sessions for CSC3200 and STA2001 plus general mode, actual persisted
  course overlay isolation, current explicit instructions and reset-to-global.
- Fresh-process durable overlay restore and bundled skill checksums unchanged across install.
- Check multiple runtime facets against one shared owner for mutation concurrency and withdrawal;
  current serialized lock covers stores sharing the same storage handle, not arbitrary facets.
- Independent final review and complete host/native/memory/onboarding regression matrix.
- Prompt assembly tests do not guarantee model compliance. No model-observed teaching claim.

Plan: docs/superpowers/plans/2026-10-07-skill-customization.md.
