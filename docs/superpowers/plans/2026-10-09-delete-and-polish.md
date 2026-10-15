# Course deletion and Professor UI polish

2026-10-09. Plan written before implementation, after inspecting this repository and the
**installed** DeepSeek Harness 0.2.0-rc.2 source (`/Applications/DeepSeek Harness.app`, read through
the asar archive; no host file was modified).

## 1. Host API inspection (evidence, not memory)

| Question | Finding | Where it was read |
|---|---|---|
| Can the plugin delete a file? | **No.** `ctx.fs` exposes `resolve / processPath / fileUrl / contains / stat / lstat / readText / streamText / readBytes / readByteRange / listDir / writeText / editText / watch` — there is no delete, rename or copy primitive. | host `api-catalog.js` service `fs`; matches `src/fs/gateway.js` ("there is no delete/rename/copy primitive") |
| Can a stored conversation be deleted? | **No.** `sessionPersistence` is append-only: `create / open / flush / stat / list`. | host `api-catalog.js` service `sessionPersistence` |
| Does the session Remote expose delete? | **No.** `sessionController` Remote methods are `list, search, create, selectModel, initializeDefaultModel, modelCatalog, canOpenWorkspacePath, workspaceDesktop, openWorkspacePath, workspacePathApplications, rename, fork, prompt, attachment, updateQueue, cancel, page, follow, projections, control`. | host `dsh-api-session-controller/lib/typert.host.js` method table |
| Does `sessionQuery` delete? | **No** — read-only (`listSessions / searchSessions / readTitle / readSurface / trace…`). `_deleteSession` in the SQLite backend is internal index reconciliation, not a public API. | host `api-catalog.js`; `dsh-session-query-sqlite` |
| Is there a UI delete for a chat? | **No.** The built-in session row menu registers only Pin / Rename / Fork / Archive (`sidebar.workspaces.session.menu.item` contributions in `dsh-client-ui-workspace`). The only session-adjacent "delete" is **workspace** delete, whose own Chinese copy states `文件夹与会话记录会保留`. | host `dsh-client-ui-workspace/lib/client.js` |
| Closest supported mechanism | `ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity })` — a **reversible archive set**, not a deletion. | host `api-catalog.js` service `workspaceRegistry` |

**Implementation limitation (2026-10-09; the user requirement remains outstanding):** requirement B ("delete the exact native Harness
conversation") is **blocked by the host**. This plan therefore ships course deletion and the UI
polish, and records conversation deletion as an explicit blocker. No hiding, no row filtering, no
direct removal of `~/.dsh/sessions/**`, no rewriting of any session log will be implemented as a
substitute.

## 2. Approved semantics — course deletion

"Delete course" removes Professor's **registration and derived search data only**:

1. The course disappears from `project.yaml`, from Home's study choices and from course management.
2. Its derived index records are removed from `.professor/indexes/files.json`, so Professor search
   and the material list can no longer return them.
3. Original course materials, generated notes, reviews, learning-state files
   (`.professor/state/**`), persistent course memory and binding history are **never** touched.
4. Archived and active registrations are both deletable; Archive/Restore stay as separate actions.
5. Re-scanning the same folder and explicitly confirming it registers the course again.

### Guards (unchanged pattern, extended)

Deletion runs only through the existing guarded `workspaceCommand` → `professor_course_manage`
pipeline: registry-owned **ready Professor session**, observed server-held course snapshot token,
exact course id inside that snapshot, project root + configuration digest, connection revision,
and now an explicit `confirmDelete: true`. Tokens are single-use after a successful operation,
expire after 15 minutes, and arbitrary browser paths/fields are refused.

### Safe ordering (idempotent, never claims success with stale search data)

1. Validate every guard and the confirmation.
2. Build the **target document** (course removed, tombstones added) in memory.
3. Compute the affected index records and **write the cleaned index first** (one atomic write).
   - If this fails: nothing changed, the course is still listed, the user retries.
4. Save `project.yaml` with `expectedRaw` optimistic guard.
   - If this fails after step 3: the index is already clean (no stale searchable data), the course
     is still listed, and a retry is a no-op for step 3 followed by a successful save.

### Which records belong to the deleted course

For every index record, classify its `relative_path` with **both** the current document and the
target document:

- belongs to the deleted course when the stored `course_id` matches *or* the current classifier
  assigns it to that course;
- **removed** only when the target classifier assigns it to **no** course (its source roots are not
  shared with a surviving course);
- **kept** and re-stamped with the surviving course when another registered course still covers the
  same path (shared/overlapping sources).

### Tombstone (why a rebuild must not resurrect it)

A rebuild re-walks the folder; without a marker the deleted course's material would come back as
`unassigned` and become searchable again. The target document therefore records the deleted course's
source roots in a **new, separate list** `indexing.removed_sources`:

- `resolveExcludePaths` treats those entries like excluded directories, so discovery never walks
  them;
- `indexing.exclude` (the user's own exclusions) is **not** modified — deletion and user exclusions
  are independent lists;
- registering a course whose sources cover a tombstoned path removes that tombstone
  (`registerCourse` / `updateCourse(sources)`), which is what makes explicit re-add work.

Chunk-store files under `.professor/indexes/chunks/` are **left in place**: the host offers no file
delete, and they are unreachable the moment their index records are gone. They are rebuildable
derived data and are re-verified by source hash on re-extraction.

Review correction: stale records outside the declared roots receive an exact absolute file marker,
including files at the project root; never mark their containing directory merely from one stale
record. This avoids excluding unrelated neighbours. Markers are applied after classification via
`removedSourcePrefixes`, rather than skipping discovery, so surviving shared sources stay available
and folder scans can offer explicit re-addition. Search takes course/category from the current file
index; chunk-store re-stamping is only cache maintenance and its failure cannot alter search ownership.

### Existing bound conversations

A conversation bound to a removed course must **report** the fact, never pick another course:

- `professor_session_*` / state tools already refuse with `PROFESSOR_COURSE_MISSING`;
- memory hydration already skips course memory with an explicit warning;
- the automatic prompt section gains an explicit line naming the removed course id so the model tells
  the student the course is no longer configured instead of silently rendering nothing.

## 3. Approved visual direction

Scope: Home, configured courses, recent rows, course details/materials, folder → scan → confirm →
readiness, course management, learning preferences, persistent memory, and every empty / loading /
error / success / confirmation state.

- **Host-aligned tokens, scoped CSS.** One stylesheet for all Professor surfaces, built on the
  installed host's own variables (`--dsw-alias-label-*`, `--dsw-alias-bg-*`, `--dsw-alias-border-l*`,
  `--dsw-alias-interactive-bg-hover`, `--dsw-alias-state-error-primary`,
  `--dsw-alias-state-business-primary`, `--dsw-radius-*`, `--dsw-focus-ring-*`) with local
  fallbacks, so light and dark come from the host and no global Harness style is modified. The
  current duplicated `<style>` blocks, Georgia serif title and hardcoded `#8887` / `#315c50` values
  are replaced.
- **Hierarchy and spacing:** one page title, 17px section headings, 13px metadata, an 8px-based
  spacing scale, cards for course rows, compact single-line rows for recent conversations.
- **One visually distinct primary action** — Start learning / 继续 — with every secondary control
  (查看课程, 刷新, 归档, 删除) quieter and consistently sized. Deletion is always secondary.
- **Consistent radii** (`--dsw-radius-md` for controls, `-sm` for chips), subtle hover/focus states,
  `:focus-visible` rings using the host focus token.
- **Responsive:** no fixed widths, `min-width: 0`, wrapping titles/paths, single-column settings
  below 620px, no horizontal overflow in a narrow panel.
- **Shared confirmation dialog**: `role="dialog"`, labelled by its title, target name spelled out,
  plain-language list of what is removed, an explicit "课程原始文件不受影响" line, Cancel + a
  destructive Delete button, busy state, duplicate-click lock, Escape/`取消` to dismiss, honest
  failure text with retry. No fake Undo.
- **Not added:** dashboards, statistics, illustrations, gradients, decorative animation, extra
  onboarding steps, jargon in controls.

## 4. Ordered implementation steps

1. **Failing regressions first** for removal planning, tombstones, guarded `delete` validation and
   the remote-descriptor parity.
2. `src/courses/registry.js` — `removeCourse` + tombstone maintenance.
3. `src/indexer/exclude.js` + `src/project/project.js` — `indexing.removed_sources` validation and
   exclusion.
4. New removal planner (`src/courses/removal.js`) — classify-and-split the index.
5. `src/tools/courses.js` — `action: 'delete'` with the ordering above.
6. `src/app/commands.js` — `delete` operation + `confirmDelete`.
7. Remote contracts kept byte-identical across `src/app/remote.js`, `client/remote.js`,
   `client/client.js` (`delete` in the allowed operation list and the confirmation field).
8. Prompt/`resolveCourseContext` reporting for a removed bound course.
9. `client/client.js` — confirmation dialog, delete controls (Home + course management incl.
   archived), unified stylesheet, polish pass.
10. Real-host verifier coverage for deletion on disposable profiles/fixtures.
11. `npm run verify` and `npm run verify:home`, then documentation.

## 5. Verification plan

- Unit: removal planner (shared source kept, exclusive source removed), tombstone add/clear,
  exclude-path resolution, guarded command refusals (no confirmation, stale/reused token, foreign
  course id, changed connection), registry removal, prompt reporting.
- Component: dialog copy/labels/busy/duplicate click, delete controls present on Home and in course
  management for active and archived rows, drafts of *other* courses preserved.
- Real host (`verify:home`): fixture hashes unchanged, course gone from Home, other course intact,
  index no longer returns the material, rebuild does not resurrect it, re-add restores it, bound
  conversation reports "no longer configured".
- Conversation deletion: **not implemented**, recorded as blocked in §1.
