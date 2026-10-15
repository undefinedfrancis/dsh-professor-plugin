# Overall review corrections — 2026-10-09

Workspace: `/Users/<user>/Documents/Project/professor-harness-spike-plugin`.
Claude's in-progress changes were preserved and inspected in place. No user source files,
native conversation logs, profile credentials or host binaries were edited.

## Corrected behavior

- Home course deletion is synchronously locked before any asynchronous work starts. Two clicks
  before React re-renders prepare only one setup session and perform one deletion request.
- Confirmation dialogs contain Tab and Shift-Tab among enabled controls. Escape cancels only
  when idle. Initial focus is Cancel; dismissal restores the initiating element if still present.
- A removed stale index assignment outside its declared sources is remembered by exact file path,
  including root-level files. Rebuild excludes that file without excluding unassigned neighbours.
- Search reads course/category from the authoritative current index, after verifying the stored
  source hash. Old chunk assignments cannot override a surviving course or break scoped retrieval.

## Evidence

Failing targeted regressions reproduced the root-level marker omission, neighbouring-directory
over-exclusion, stale chunk filter failure, and missing Tab containment before production changes.
After fixes, full `npm run verify` exited 0: 481 tests, zero failures/skips; E2E 28/28.
Log: `/private/tmp/professor-corrections-final.log`.
The isolated packaged `npm run verify:home` exited 0, ALL PASS.
Log: `/private/tmp/professor-corrections-home.log`.
It proves guarded deletion, original material/state/binding byte preservation, rebuild exclusion,
shared course availability, removed-course refusal and explicit re-addition through the real host.
It does not execute a model turn or render the browser UI.

The running desktop loaded the modified client. Manual confirmation check on CSC3200:
Cancel initially focused; Tab twice remained on Cancel; Shift-Tab reached Delete; Escape returned
focus to the original CSC3200 Delete button. The destructive confirmation was never submitted.

## Outstanding scope

- Installed session Remote was re-read through Electron's ASAR filesystem; it still has no delete
  method. Native chat deletion and its Recent cleanup remain unimplemented. The previous plan's
  statement that this was a "user decision" was corrected: it is a host limitation, not acceptance
  of reduced requirements. Archive is not a substitute for deletion.
- Historical `permissionRules/decision` conversation replay remains unresolved. No log repair
  or destructive cleanup was attempted.
- Full Phase 6 page/error/responsive/theme acceptance remains outstanding; scoped checks above
  do not claim the entire project has passed final acceptance.
- Working-tree changes remain uncommitted. Unknown-origin `professor-skills/` was preserved.
