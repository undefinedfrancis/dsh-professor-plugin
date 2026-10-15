# Selected-course repair — 2026-10-09

## Required behavior

Opening a configured course starts a native Professor conversation bound to that exact stable
course ID. The model should restore only that course's learning context and may ask about the
topic, not ask the student to select a course again. General conversations remain course-free.

## Findings and changes

- Home's course row previously only changed a separate launch form. Its action now launches the
  exact course directly, with a retained retry token through the existing launch path.
- Home study choices exclude archived courses; settings retain archived entries for recovery.
- Persisted bindings were incorrectly resolved as ambiguous code queries. Memory hydration,
  session status, and implicit state/artifact context now use exact stable IDs.
- Explicit state/artifact and bind-tool arguments accept an exact ID before trying code lookup.
  Ambiguous course-code queries still refuse rather than guessing.
- Active course identity is rendered at prompt assembly independently of the persistent-memory
  switch. Ordinary sessions receive no Professor context. Course metadata is JSON data, and the
  section is non-interpolated by the existing assembly hook.
- A blank inferred scan term now reuses a same-code registration for the same source folder,
  preserving configured terms and IDs. Different explicitly identified terms remain distinct.
- In the desktop course settings, six erroneous unspecified-term duplicates were archived through
  the guarded native workflow: CSC3001, CSC3200, CSC4801, GFN1000, PHY1001, STA2001. Their original
  configured entries and CSC3002 remain active. Archiving preserves source files, notes, memory,
  bindings and history; each archived row remains recoverable using Restore.

## Evidence

- Regression tests failed before fixes for exact bound identity, blank-term rescan, direct Home
  course launch, and explicit state reads by the selected stable ID.
- Full verification (syntax, skills, sync, distribution, E2E, tests) passed before the final explicit
  ID correction; the full test suite after that correction passed 465/465.
- Real packed `verify:home` passed, including actual native prompt assembly with
  `{ agent, scope: agent }`, selected-course identity, and the no-repeat-selection instruction.
- Desktop Home's direct CSC3200 action opened a Professor session with binding `csc3200`.
- The first desktop study smoke run revealed explicit-ID tool ambiguity after the initial fixes;
  it was stopped, a failing regression added, and the explicit-ID path corrected. That first turn
  is not successful acceptance evidence.
- An earlier reported session had native header `agentPreset: professor` but a later persisted
  `agent-preset/selected` event switched it to `standard`. Attribution to user action versus a
  staged native picker is unresolved; no host code or global default was patched. The fresh desktop
  launch after restart displayed Professor. Historical standard-mode turns remain unchanged.

## Final desktop check

After the final restart, Home displayed seven active courses, with the six archived duplicate
entries absent from study choices. Clicking the original CSC3200 opened Professor mode. Sending
`我在学习什么课程？` produced a successful 10-second answer naming CSC3200 / Data Structures and
Advanced Programming, Year2Term1, its course material and notes paths, followed by a topic question
within this course. It did not ask to choose among courses.

Final `npm run verify` exited 0 (465/465 tests plus syntax, skills, sync, distribution and E2E).

## Separate outstanding issue

Restarting the earlier long-running smoke-test conversation `professor-r-0d3037b334e6297b29fa150c`
revealed a native replay rejection: unknown event `permissionRules/decision` at seq 16. No log was
rewritten or deleted. That history compatibility issue remains unresolved and is not covered by
the selected-course acceptance above. The final fresh conversation successfully answered.
