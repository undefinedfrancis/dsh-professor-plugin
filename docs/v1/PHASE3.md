# Phase 3 — Academic folder onboarding and derived indexing

Date: 2026-10-07 (Asia/Shanghai). Branch: `feature/professor-portable-app`.

## Scope and status

Backend milestone verified. Existing uncommitted Phase 3 work was retained, reviewed, fixed and verified against the packaged plugin in disposable real Harness profiles. No frontend, model turn, filesystem watcher or automatic Hermes migration was added.

Professor now has 21 tools, including:

- `professor_workspace_discover`: bounded, read-only folder scan and versioned proposal.
- `professor_workspace_confirm`: revalidate fingerprint, apply explicit selected identities, preserve existing registrations and build derived data.
- `professor_workspace_rebuild`: rebuild derived index/extraction without resetting configuration, notes or memory.

The backend is the contract for the later Settings UI. Users can connect through tools without handwritten YAML. UI folder selection remains a later milestone.

## Behavior

Discovery proposes conventional course codes and marks uncertain identities as questions. A confirmed selection can edit the identity or exclude a folder. Term-separated registrations remain distinct. Unselected high-confidence folders are not silently registered; ambiguous identities remain pending.

The proposal carries `professor.onboarding/1`, canonical root, scan limits, confidence/reasons and a SHA-256 fingerprint of detected directory topology/version/category metadata. Confirmation rescans before writes. This is not a hash of every source file's contents; source freshness is handled by the file index and extraction hashes.

Configuration uses the existing project/course model. A connection record in `professor_app` remembers the selected folder and previous folders without deleting their data. Folder changes require explicit acknowledgment. Newer or malformed connection/project records are not overwritten.

Indexing/extraction reuse the existing services. Configured global and per-course output roots, `.professor` metadata and explicit exclusions are not source inputs. Code/course-info folders are supplementary, not exams. Original sources remain read-only and file presence never creates learning progress.

Incremental work is an explicit on-demand scan/version/hash comparison, not a live watcher. Chunk stores carry source hashes. Unchanged extraction is reused; changed content is re-extracted; removed and hash-mismatched chunks are withheld from search. Old chunk stores without a hash require re-extraction before being treated as current.

Readiness distinguishes configuration saved, index completion, extraction completion and searchability. Failed derived work does not roll back accepted configuration; a retry is reported. Optional unsupported formats remain visible as unsupported counts/reasons.

## Takeover fixes

1. Successful discovery omitted its schema-required `problems` array, so the real host rejected it. Regression and host verification now cover the success payload.
2. The output exclusion resolver missed `courses[].outputs`; it now resolves each course's artifact roots, preventing generated notes from feeding back into source retrieval.
3. Configuration confirmation could overwrite edits made since its initial read. It now supplies the expected raw preimage; saving checks it and writes against the observed file version. Concurrent changes are refused.
4. A connection with the current schema tag but malformed active/history fields could be overwritten. Field-shape validation now preserves and rejects it.
5. Temporary `/var` aliases conflicted with canonical write policies; fixture homes are canonicalized without weakening safety.
6. Extraction/E2E fixtures configured `Notes` as output but used `notes` as source on a case-insensitive disk. Their output is now separate `AI-Notes`; source exclusion remains enforced.
7. The restart verifier confused all visible tools with Professor tools, omitted a required memory revision, and attempted to inspect a stale parent-process cache. It now counts namespaced tools, reads the revision, shuts down the parent host and checks the child's durable storage bytes.

## Fresh verification

- `npm run verify`: exit 0; syntax, skills, sync, distribution, E2E and full suite passed.
- Full suite: **319/319**, 0 failures.
- E2E: **28/28**.
- Onboarding + project targeted tests: **41/41**.
- `verify:harness`, `verify:packaged`, `verify:native-session`, `verify:memory-restart`, `verify:onboarding`: all exit 0, run sequentially in isolated profiles.
- Real onboarding verifies discovery/confirmation, edited identity, exclusions, initial search/provenance, add/change/remove updates, unchanged reuse, explicit rebuild, memory preservation, restart and fixture source invariance.
- `git diff --check`: clean.

No real course tree, legacy Registry/Knowledge, desktop profile, session log or credentials was changed. No push/publication or history rewrite. Phase 4 is next: supported dedicated sidebar/Home and native-session routing. Model-observed behavior and UI acceptance remain unverified, so this is not v1 release readiness.
