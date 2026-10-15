# Phase 2 — Persistent memory takeover report

Date: 2026-10-06 (Asia/Shanghai). Branch: `feature/professor-portable-app`.

## Implementation

The preexisting, uncommitted Phase 2 implementation was retained and completed rather than rewritten. Global explicit-stable preferences, course memory and memory controls use the existing `professor_app` domain. Learning records remain the existing PROGRESS/KNOWLEDGE/MISTAKES files; no transcript store or second learning-state system was introduced. Three memory tools bring the Professor tool surface to 18.

Course keys include project identity/root namespace and stable course identity; term-separated registrations retain distinct identities. General sessions do not infer a course. Updates require observed revisions, invalid/newer records are refused without repair, and disabled memory preserves data while excluding automatic context and updates.

Native context uses a preset-scoped synchronous section plus the supported asynchronous `system-prompt/assemble` waterfall. Assembly reads relevant persistent state, checks asynchronous preset membership, supplies a plain string and disables interpolation for memory text. Memory is reference data, not authority to execute tools or weaken policy. Current explicit instructions and the existing format gate remain authoritative.

The application store belongs to the plugin lifecycle. Sessions share it, own separate caches and do not close it when disposed. Bind/unbind refreshes relevant context. Memory updates refresh all known session caches, so disabling memory does not leave another session's cached preferences active. Assembly rehydrates to observe changes from other sessions. Superseded hydration cannot republish a disposed/updated cache.

## Bugs reproduced and fixed during takeover

1. Restart verifier `temp` variable shadowing caused a temporal-dead-zone error before packing.
2. Temporary `/var` vs `/private/var` aliases violated the canonical write policy: fixture home is now canonical, not a security bypass.
3. Simultaneous mutations could accept the same revision before persistence: the complete read/control/revision/write transaction is serialized; a rejected mutation does not poison the queue.
4. Learning-state field plans included absent optional values as `undefined`, making real host output invalid after successful writes: absent fields are omitted, with a lossless-roundtrip regression.
5. Preset membership is asynchronous; synchronous comparison excluded real Professor sessions, while a truthy Promise could leak cached content in contract tests.
6. Prompt callbacks are synchronous on this host. Memory is hydrated in the supported async assembly waterfall, not returned as a Promise from `section.text`. The declared systemPrompt service is now a required supported-host dependency.
7. Binding did not refresh memory; restart verification previously tried rewriting an instruction to trigger hydration. Binding now refreshes directly and restore verification does not reconstruct persistent instructions.
8. Repeated hydration replaced the prior-session continuation context with the current session's own id: the session-local prior-session view is retained while durable metadata records the current session.
9. Omission footer could exceed the total context budget: headers/footer are now included in the hard limit.
10. Host table keys are iterable, not necessarily arrays: counting now materializes them, preventing undefined diagnostics output.
11. Restore child used an undefined `workspace`; all operations now use its explicit fixture workspace. Failed acceptance no longer prints a PROVED claim.
12. Host schema verifier still asserted 15 tools: it now expects the explicit 18-tool contract.

## Verification boundary

Feature-specific tests cover preference evidence, actual overlapping writes, revision conflicts, disabled sessions, async membership, scoped registration, iterable keys, budgets, course/project/term isolation, corruption and storage ownership. The packaged restart run executes through real tool/runtime services, shuts down the host and creates genuinely new native sessions in a fresh process. It checks persisted preference, instructions, learning summary, prior session, temporary-statement refusal, course leakage and independent session disposal.

No model turn is run. Model-observed teaching or model-selected tools remain unverified and need normally authorized credentials/network/spend for the later release gate. This is not v1 release readiness: onboarding/UI/customization remain later phases.

## Data and Git safety

Only repository source/tests/verifiers/docs and disposable test profiles were changed. No real course project, original materials, old Registry/Knowledge, desktop profile, real session logs or credentials were edited. Existing Phase 2 working-tree changes were preserved. No branch/history rewriting or publication was performed.

Final command results and checkpoint are recorded in `STATUS.md` after the regression sweep. Next phase: M3 academic-folder onboarding using existing project/course/index services; no custom UI or automatic legacy migration in that phase.
