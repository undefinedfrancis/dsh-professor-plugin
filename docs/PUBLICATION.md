# Publication boundary

This document is the publication inventory for the Professor Harness plugin. It exists because
**npm-tarball safety and Git-repository safety are different questions**, and only one of them was
previously answered.

## The distinction

| | npm tarball | Git repository |
|---|---|---|
| What limits the contents | `package.json#files`, a **whitelist** | `.gitignore`, an **exclusion list** |
| Covers `professor-skills/` | yes — not in the whitelist | only once explicitly ignored |
| Covers `.serena/` | yes — not in the whitelist | only once explicitly ignored |
| Covers `docs/qa/` | yes — `docs/` is not shipped | only once explicitly ignored |
| What a green run proves | nothing leaks **out of the package** | nothing leaks **out of `git add -A`** |

`npm run verify:dist` packs the tarball, installs it into a disposable consumer, and scans every
shipped text file for secrets and for a real account's home path. That is a genuine gate and it
passes — but it says nothing about a `git push`, because the tarball whitelist simply never
contains those directories in the first place. Three untracked directories in this working tree
carry a personal profile, a real course registry, learning-state snapshots and run-specific
machine paths, and `git add -A` would have published all of them.

So there is now a second, independent gate.

This gate checks the current publication files, **not existing Git history**. The local HEAD still
contains older documents with the original machine account path. Pushing this repository's history
would expose those earlier versions even after the working-tree copies are sanitised. For an initial
public release, export the reviewed publication files into a fresh public repository without the
private local history. Keep the original repository intact. Do not rewrite or publish its history
without a separate review and owner decision.

## `npm run verify:publication`

Runs `node tools/verify-publication.mjs`. It reads the exact set
`git ls-files --cached --others --exclude-standard` would publish — tracked files plus untracked
files that are not ignored — and checks that set for:

1. no private directory (`professor-skills/`, `.serena/`, `docs/qa/`, `.workbuddy/`);
2. no personal profile, course registry or learning-record path;
3. no `.credentials*` file;
4. no secret pattern and no home path naming a real account;
5. no backup, junk, tarball or `node_modules` entry.

It is also part of `npm run verify`. The last run checked 258 paths, all `PASS`. The gate has a
test-only escape hatch (`PUBLICATION_FORCE_INCLUDE=<path>`) so `test/publication-boundary.test.mjs`
can prove it actually fails when a private file enters the set — a gate that has never been seen to
fail is not evidence that it works.

## What is published

The publication set is the source, the bundled skills, the verification tooling and the public
documentation:

- `src/`, `client/`, `index.js` — the plugin itself;
- `skills/` — the six bundled skills;
- `resources/enhance/` — the platform lockfiles and model manifest;
- `resources/latex/` — the shared default and owner-supplied reference LaTeX templates;
- `cordis.patch.yml` — the Professor preset;
- `tools/`, `test/` — the verification tooling and the regression suite (shipped so the installed
  copy can self-test);
- `README.md`, `docs/` (except `docs/qa/`), `THIRD_PARTY_LICENSES.md`, `package.json`;
- `.github/workflows/` — the offline material-platform workflow.

Course codes that appear in `src/`, `test/` and some design documents are **synthetic acceptance
fixtures**: `CSC3200`, `STA2001` and the rest are deliberately reused as the name of a generated
test course, with generated lecture content. They are not a record of anybody's enrolment.

## What stays local, and why

| Path | Why it is not published |
|---|---|
| `professor-skills/` | A snapshot of a personal assistant workspace: a user profile (`Personal-Agent/00_System/PROFILE.md`), a real course registry (`01_Learning/Registry/`), and learning-state snapshots for real courses (`01_Learning/Knowledge/<code>/{KNOWLEDGE,PROGRESS,INDEX,MISTAKES}.md`). It is the *origin* the bundled skills were portabilised from, which is why it is kept — not why it is published. |
| `.serena/` | Local language-server state: project settings and a symbol cache. Its own `.gitignore` already dropped the cache and the local override, but not `project.yml`. |
| `docs/qa/` | Dated QA evidence: model reports, counters, authorization records, rendered PDFs, verifier logs. These carry run-specific absolute paths that name this machine's account. Removing them would rewrite the evidence, so the evidence is kept local instead. |
| `.workbuddy/`, `*.bak-*`, `.DS_Store`, `node_modules/`, `*.tgz`, `.env*` | Pre-existing ignore rules, unchanged. |

**Exclusion is not deletion.** Every one of these paths remains on disk, and
`test/publication-boundary.test.mjs` asserts that they still exist alongside the rule that keeps
them out of git.

## Documentation sanitisation

Eight publishable documents — five tracked, three untracked — carried this machine's real account
name in absolute paths, and two carried it in prose. Those were sanitised **in place** in the
publishable copies only:

- `/Users/<account>/…` → `/Users/<user>/…`;
- the real academic workspace label → `<academic-folder>`;
- the personal-name possessive in the fresh-computer rule → `the student's`.

This is documentation sanitisation, not evidence rewriting. No file under `docs/qa/` was touched:
those are historical records and they are local-only by the rule above. The baseline is
`test/evidence-preservation.test.mjs`, which fingerprints every `docs/qa/**` model output, PDF,
counter, authorization record and report before any change and fails if a single byte moves.

## Licensing — an open decision

`package.json` currently declares `"private": true` and `"license": "UNLICENSED"`.

- `private: true` is **npm protection**: it stops an accidental `npm publish`. It is not a
  statement about copyright terms.
- `UNLICENSED` is **not an open-source licence**. It is the absence of one.

Publishing this repository to GitHub without choosing a licence would place source in public view with
no licence at all — which, under most jurisdictions, means "all rights reserved" and no permission
to use, modify or redistribute. If an open-source release is intended, a licence must be chosen
and `license` updated. `private: true` can remain to protect against accidental npm publication;
it does not prevent a GitHub source or tarball release. **The licence has not been decided here.**

The reusable model-validation executor is published as `tools/verify-m2b-model.mjs`, together with
its helpers and offline tests. Historical reports, compatibility wrappers and prepared evidence
remain under the excluded `docs/qa/` directory. See `docs/M2B_VALIDATION.md` for the public entry point.

## Unresolved privacy decisions

Recorded rather than silently resolved:

1. **Course codes remain in the public source.** `CSC3200` and friends appear as synthetic fixtures
   and in design documentation. They are also the codes of real courses in the local, unpublished
   learning records. A reader of the public repository learns a set of course codes and nothing
   else; a reader who also had the private snapshot could correlate them. Recommendation: if that
   correlation matters, rename the fixture codes to clearly fictitious ones in a later pass. Not
   done here because it would touch many tests and no privacy fact changes.
2. **An academic-folder label survives in a sanitised form.** The real workspace path is gone, but
   a few documents still describe *that* such a folder exists and what it contains. That is needed
   to explain the onboarding design; it identifies no course and no person.
3. **`docs/qa/` is excluded wholesale.** A narrower rule (publish the reports, exclude the raw
   evidence) would keep more of the audit trail public, but the reports themselves quote machine
   paths, and editing them is excluded by the preservation constraint. Revisit only with a
   sanitised-mirror plan, never by rewriting the originals.
4. **The licence is undecided** (see above).

## Reproducing the check

```bash
npm run verify:publication
node --test test/publication-boundary.test.mjs
```
