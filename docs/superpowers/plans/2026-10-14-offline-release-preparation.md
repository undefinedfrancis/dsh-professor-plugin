# Offline Release Preparation — Publication Boundary, Path-Safe Verifiers, M2b Executor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the working tree safe to publish to GitHub, make every verification entry point run correctly from a checkout path containing spaces and Chinese characters, and repair the M2b model-test executor offline so a future narrow table-delivery retest can be attempted honestly.

**Architecture:** Three independent workstreams sharing one verification spine. (1) A `.gitignore` publication boundary plus a new deterministic `tools/verify-publication.mjs` gate proving the *Git* publication set is clean, kept separate from the existing npm-tarball gate (`tools/verify-distribution.mjs` §4). (2) Mechanical `fileURLToPath` conversion of every `new URL(import.meta.url).pathname` derivation, proven by running the real verifiers from a disposable copy whose path contains a space and Chinese characters. (3) Wiring the already-tested pure helpers in `test/helpers/m2b-run-config.mjs` into the two byte-identical formal M2b executors, plus an offline wiring regression.

**Tech Stack:** Node.js 24 ESM, `node:test`, existing harness-host helpers in `tools/packaged-profile.mjs`.

**Spec:**
- `docs/qa/2026-10-14-project-review/REPORT.md` (prioritized remaining work items 1–3)
- `docs/qa/2026-10-13-m2b-live/NEXT_PROMPT.md` (the five offline-only repair instructions)
- `docs/qa/2026-10-13-m2b-live/REPORT.md` (the FAIL/INCOMPLETE observation being repaired)
- `docs/qa/2026-10-13-source-grounding-review/M2B-EXECUTION-INSTRUCTION.md` (gates the runner already enforces)
- `docs/v1/STATUS.md` (phase status that must not be overstated)

## Global Constraints

- No paid model request. `--allow-model-calls` must never be passed. Existing budgets are exhausted.
- No commit, no push, no publication, no global dependency installation, no real desktop-profile write.
- Preserve all 141 existing changed/untracked working-tree entries; HEAD (`b8850eb`) alone does not represent the runnable implementation.
- Preserve historical model outputs, PDFs, counters, authorization records and reports **byte-for-byte**. Record sha256 of every file under `docs/qa/**` matching `*.json`, `*.md`, `*.pdf`, `*.png`, `*.txt` before and after; the after-list must match for every file that existed before.
- Do not reopen S3/S5. Do not reopen Windows/Linux/macOS Intel testing.
- Keep the six bundled skills, five presets and 22 public `professor_*` tool contracts unchanged unless a directly necessary correction is demonstrated.
- Do not claim that offline runner repairs resolve FO-8 or complete Phase 6, 7 or 8.
- Distinguish npm tarball safety (`package.json#files` + `verify:dist`) from Git publication safety (a new gate).
- Environment: OCR/enhance runtime already prepared at `/tmp/professor-auto-prepare/env-e270c763ff8847c4562c/bin/python`, backend `pdfium`. Configure it for the enhancement production test and report any skip honestly.

## Review Focus

These input classes are the ones most likely to make a green run lie. Each is pinned by a named test in the task that owns it.

1. **A checkout path with a space or a Chinese character.** `path.dirname(new URL(import.meta.url).pathname)` yields a percent-encoded directory that does not exist, so a verifier scans nothing and can report success on an empty set. *Test:* `test/verify-path-paths.test.mjs` runs the real `tools/verify-syntax.mjs` from a disposable copy under `/tmp/professor 中文 检查/…` and asserts it parsed the copied files.
2. **A verifier that passes because it found zero files.** Empty-set success is the failure mode of defect 1. *Test:* the same test asserts the syntax verifier's parsed-file count is `> 0` and equals the count of `.js`/`.mjs` files in the copied tree.
3. **A publication set that still carries the personal profile, real learning records or a real home path.** *Test:* `tools/verify-publication.mjs` fails if any publishable path matches the private markers, or any publishable file matches a real `/Users/<name>` path or a credential pattern.
4. **A native-mode M2b run that claims skill activation it never had.** The 2026-10-13 probe proved the assembled system prompt carries **0/3** table-finishing markers, and the executor's `offered` list omits the host `skill` tool — so native loading is currently unreachable. *Test:* `test/m2b-executor-wiring.test.mjs` asserts the formal executor offers `skill` in native mode and calls the guidance-readiness gate; `test/m2b-run-config.test.mjs` covers `guidanceReadinessProblems` in both modes.
5. **A turn reported OBSERVED because text exists.** The current line is `record.status = finalText ? 'OBSERVED' : 'NO-RESPONSE'`. *Test:* existing `classifyTurnOutcome` tests plus a wiring assertion that the executor no longer contains that expression.

---

### Task 1: Record a baseline hash manifest of historical evidence

**Files:**
- Create: `docs/qa/2026-10-14-offline-release-preparation/hash-before.json`
- Test: `test/evidence-preservation.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `hash-before.json` = `{ "generated_at": iso8601, "root": <repo>, "files": { "<relpath>": { "bytes": n, "sha256": hex } } }` — the exact shape `hash-after.json` must reproduce.

- [ ] **Step 1: Write the failing test**

```js
// test/evidence-preservation.test.mjs
test('historical evidence under docs/qa is byte-identical to the recorded baseline', async () => {
  const baseline = JSON.parse(await fs.readFile(path.join(BASELINE_DIR, 'hash-before.json'), 'utf8'))
  for (const [rel, expected] of Object.entries(baseline.files)) {
    const buffer = await fs.readFile(path.join(ROOT, rel))
    assert.equal(buffer.byteLength, expected.bytes, `${rel} size changed`)
    assert.equal(sha256(buffer), expected.sha256, `${rel} content changed`)
  }
})
```
`BASELINE_DIR = docs/qa/2026-10-14-offline-release-preparation`. Skip with a clear message when `hash-before.json` is absent (fresh clone); fail if a listed file is now missing.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/evidence-preservation.test.mjs`
Expected: FAIL with `ENOENT … hash-before.json`.

- [ ] **Step 3: Generate the baseline** — walk `docs/qa/**` for `.json .md .pdf .png .txt .zst .jsonl`, sha256 each, write `hash-before.json`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/evidence-preservation.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit** — *not performed in this session* (no-commit constraint); record the step as satisfied by the passing test.

---

### Task 2: Publication boundary — exclusions and the public document

**Files:**
- Modify: `.gitignore`
- Create: `docs/PUBLICATION.md` (public, sanitized — no real home path, no learner identity, no course learning records)
- Test: `test/publication-boundary.test.mjs`

**Interfaces:**
- Consumes: `hash-before.json` (Task 1), proving exclusions delete nothing.
- Produces: `.gitignore` rules; `docs/PUBLICATION.md` §"what is published / what stays local".

- [ ] **Step 1: Write the failing test**

`test/publication-boundary.test.mjs` asserts via `git check-ignore`:

1. `professor-skills/` is ignored — it holds `Personal-Agent/00_System/PROFILE.md` (personal profile), `01_Learning/Registry/COURSES.md` + `01_Learning/Registry/Courses/*.md` (real course registry), `01_Learning/Knowledge/*/{KNOWLEDGE,PROGRESS,INDEX,MISTAKES}.md` (real learning records).
2. `.serena/` is ignored (local tooling state; its own `.gitignore` drops `cache` and `project.local.yml` but not `project.yml`).
3. `docs/qa/` is ignored — QA evidence carries run-specific `/Users/<user>/…` paths and must not be rewritten to remove them.
4. `.workbuddy/`, `*.bak-*`, `.DS_Store`, `node_modules/`, `*.tgz`, `.env*` remain ignored (regression on pre-existing rules).
5. `professor-skills/`, `.serena/` and `docs/qa/` are still **present on disk** (exclusion is not deletion).
6. `git ls-files -co --exclude-standard` contains no path matching `/^professor-skills\//`, `/^\.serena\//`, `/^docs\/qa\//`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/publication-boundary.test.mjs`
Expected: FAIL — those paths are not yet ignored.

- [ ] **Step 3: Add the exclusions to `.gitignore`**

Append a commented block:

```
# Local-only personal and machine content — never published to the public repository.
# See docs/PUBLICATION.md for the full publication inventory and the privacy decisions.
professor-skills/
.serena/
docs/qa/
```

Pre-existing rules untouched; nothing deleted from disk.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/publication-boundary.test.mjs`
Expected: PASS (6 assertions).

- [ ] **Step 5: Sanitize the five tracked documents carrying a real home path**

`git grep -l '/Users/<user>'` → `PROJECT_MEMORY.md` (9), `Professor_Plugin_v1_Project_Plan.md` (2), `docs/PARITY.md` (1), `docs/superpowers/plans/2026-10-05-professor-v1-agent-prompts.md` (2), `docs/v1/HARNESS_API_AUDIT.md` (2). Replace each `/Users/<user>` with `/Users/<user>` **in those files only** — documentation sanitization, not historical-evidence rewriting; no `docs/qa/**` file, model output or report is touched. Extend the test: `git grep -l '/Users/<user>'` over the publishable set returns nothing.

- [ ] **Step 6: Run both tests**

Run: `node --test test/publication-boundary.test.mjs test/evidence-preservation.test.mjs`
Expected: PASS / PASS.

- [ ] **Step 7: Write `docs/PUBLICATION.md`**

Sections: (a) publishable source inventory; (b) excluded local content and why; (c) npm-tarball vs Git-repository safety (`verify:dist` §4 covers the tarball, `verify:publication` covers the repository); (d) licensing status — `private: true` / `UNLICENSED` is npm protection, **not** an open-source license, decision open; (e) unresolved privacy decisions. Sanitized: no real home path, no personal profile excerpt, no learning-record content.

---

### Task 3: The Git publication gate

**Files:**
- Create: `tools/verify-publication.mjs`
- Modify: `package.json` (add `"verify:publication": "node tools/verify-publication.mjs"`)
- Test: `test/publication-boundary.test.mjs` (extend)

**Interfaces:**
- Consumes: the `.gitignore` rules from Task 2.
- Produces: `npm run verify:publication` → exit 0/1, printing `PASS`/`FAIL` lines in the house style of `tools/verify-distribution.mjs`.

- [ ] **Step 1: Write the failing test**

Assert `package.json.scripts['verify:publication']` exists and running it exits 0 with no `FAIL` in stdout.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/publication-boundary.test.mjs`
Expected: FAIL (script missing).

- [ ] **Step 3: Implement `tools/verify-publication.mjs`**

Publication set = `git ls-files --cached --others --exclude-standard`. Checks:

1. **No private directory in the set** — `professor-skills/`, `.serena/`, `docs/qa/`, `.workbuddy/`.
2. **No personal profile / learning record** — no path containing `Personal-Agent/00_System/PROFILE.md`, `/PATHS.md`, `01_Learning/Registry/Courses/`, `01_Learning/Knowledge/`.
3. **No credential** — the `SECRETS` patterns from `tools/verify-distribution.mjs` (private key, `sk-`, `AKIA`, `ghp_`, `xox[baprs]-`, JWT) plus a `.credentials.yaml` path check. Share the rules by extracting them to `tools/privacy-rules.mjs` only if `verify-distribution.mjs` can import them with no behaviour change; otherwise duplicate with a comment naming the source and add a test asserting the two lists stay identical.
4. **No real home path** — `/Users/<name>` and `/home/<name>` where `<name>` is not in `PLACEHOLDER_USERS` (`x`, `user`, `username`, `you`, `yourname`, `someone`, `example`, `me`, `<user>`).
5. **No `.bak-` / `.DS_Store` / `.tgz` / `node_modules`** in the set.
6. Report files scanned and files in set.

Exit 1 on any failure; print a final summary line.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run verify:publication`
Expected: exit 0, all `PASS`.

- [ ] **Step 5: Prove the gate actually fails (red path)**

Honour a test-only env override `PUBLICATION_FORCE_INCLUDE=<path>` that adds a path to the set; with `professor-skills/README.md` the gate must exit 1 and print the expected `FAIL`. Document the override in the tool header as test-only.

- [ ] **Step 6: Commit** — recorded only.

---

### Task 4: `fileURLToPath` conversion

**Files:**
- Modify: all 50 lines matching `new URL(import.meta.url).pathname` — 24 files under `tools/`, 4 under `test/` (incl. `test/helpers/fixtures.mjs`), 22 under `docs/qa/**`.
- Modify: `tools/verify-ui-bridge.mjs:9` — `path.resolve(new URL('..', import.meta.url).pathname)` is the same defect under another spelling.
- Test: `test/verify-path-paths.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: every affected file imports `{ fileURLToPath } from 'node:url'` and derives its directory with `path.dirname(fileURLToPath(import.meta.url))` (or `fileURLToPath(new URL('..', import.meta.url))` for a parent).

- [ ] **Step 1: Write the failing test**

`test/verify-path-paths.test.mjs`:

1. **Static:** walk `tools/`, `test/`, `src/`, `client/`, `docs/qa/` for `*.mjs`/`*.js`; assert no line contains `new URL(…import.meta.url…).pathname`. Failure message names file and line.
2. **Dynamic — the requirement a helper test cannot satisfy:** copy the verification-relevant tree to `path.join(os.tmpdir(), 'professor 中文 检查 path', 'repo')` (space **and** Chinese characters), excluding `node_modules`, `.git` and `docs/qa/**/rendered*`, then **from inside that copy** run `node tools/verify-syntax.mjs`, `node verify-plugin-skills.mjs`, `node tools/verify-skill-sync.mjs`. Assert each exits 0, and assert the syntax verifier's parsed-file count is `> 0` and equals the number of `.js`/`.mjs` files in the copy (the empty-set guard).
3. Write `docs/qa/2026-10-14-offline-release-preparation/spaced-path-run.json` as durable evidence: `{ "copy_path": str, "runs": [{ "script": str, "exit_code": n, "parsed_files": n }] }`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/verify-path-paths.test.mjs`
Expected: FAIL — static assertion lists offending files, and/or the dynamic run hits `ENOENT …professor%20…`.

- [ ] **Step 3: Convert every occurrence**

Mechanical, one shape per file. Example `tools/verify-syntax.mjs:21`:

```js
// before
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname))
// after
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
```
plus `import { fileURLToPath } from 'node:url'` where absent. `tools/verify-ui-bridge.mjs`: `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')`. No other line in any file changes; `src/` product behaviour is untouched (`src/plugin.js` already uses `fileURLToPath`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/verify-path-paths.test.mjs`
Expected: PASS; `spaced-path-run.json` written.

- [ ] **Step 5: Confirm no product behaviour changed**

Run: `npm run verify:syntax && git diff --stat`
Expected: exit 0; the diff touches only path derivation and `import` lines.

- [ ] **Step 6: Commit** — recorded only.

---

### Task 5: Guidance and tool readiness helpers

**Files:**
- Modify: `test/helpers/m2b-run-config.mjs`
- Test: `test/m2b-run-config.test.mjs`

**Interfaces:**
- Consumes: `INSTRUCTION_MODES`, `TABLE_FINISHING_MARKERS`, `instructionSurfaceProblems`, `buildInstructionSurface`.
- Produces (exact — Task 6 depends on these):
  - `REQUIRED_M2B_TOOLS: string[]` — `['professor_session_status','professor_state_read','professor_search','professor_material_read','professor_artifact_create','read','edit']`
  - `guidanceReadinessProblems({ mode, system, userMessage, resolvedSkillContents = [], offeredTools = [] }) → string[]`
  - `requestTextProblems({ text, workspace }) → string[]` — refuses any absolute path under `<workspace>/.professor/notes` in a model request (the predicted-`content.tex` defect).

- [ ] **Step 1: Write the failing tests**

```js
test('native mode is ready only when the skill tool is offered and the loaded bodies carry the guidance', () => {
  const body = 'Edit content.tex; write \\begin{tabular}; never in sections[].body.'
  assert.deepEqual(guidanceReadinessProblems({
    mode: INSTRUCTION_MODES.NATIVE, system: 'persona only', userMessage: 'make a note',
    resolvedSkillContents: [body], offeredTools: [...REQUIRED_M2B_TOOLS, 'skill'],
  }), [])
  assert.ok(guidanceReadinessProblems({           // guidance unreachable without the skill tool
    mode: INSTRUCTION_MODES.NATIVE, system: 'persona only', userMessage: 'x',
    resolvedSkillContents: [body], offeredTools: REQUIRED_M2B_TOOLS,
  })[0].includes('skill'))
  assert.ok(guidanceReadinessProblems({           // no body resolved: the prompt must carry it
    mode: INSTRUCTION_MODES.NATIVE, system: 'persona only', userMessage: 'x',
    resolvedSkillContents: [], offeredTools: [...REQUIRED_M2B_TOOLS, 'skill'],
  })[0].includes('table-finishing'))
})

test('supplied mode requires the markers in the input actually sent', () => { … })
test('every required tool missing from the offer is named', () => { … })
test('a request naming a predicted artifact path is refused', () => {
  assert.ok(requestTextProblems({ text: 'path is ' + path.join('/w', '.professor', 'notes', 'csc3200', 'x', 'content.tex'), workspace: '/w' }).length > 0)
  assert.deepEqual(requestTextProblems({ text: 'use whatever artifact_create returns', workspace: '/w' }), [])
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/m2b-run-config.test.mjs`
Expected: FAIL — `guidanceReadinessProblems is not a function`.

- [ ] **Step 3: Implement the two helpers**

`guidanceReadinessProblems` composes required-tool membership plus the mode-specific guidance check (native = every marker appears across concatenated `resolvedSkillContents` **and** `offeredTools` includes `skill`; supplied = delegate to `instructionSurfaceProblems({ system, userMessage })`), returning `string[]`. `requestTextProblems` checks `text.includes(path.join(workspace, '.professor', 'notes'))`.

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test test/m2b-run-config.test.mjs`
Expected: PASS (existing 16 + new 4).

---

### Task 6: Wire the helpers into the formal M2b executor

**Files:**
- Modify: `docs/qa/2026-10-12-source-grounded-notes/run-model.mjs`
- Modify: `docs/qa/2026-10-13-m2b-live/run-model.mjs` (must stay **byte-identical** to the first — two copies of one formal executor)
- Test: `test/m2b-executor-wiring.test.mjs`

**Interfaces:**
- Consumes: Task 5 helpers; `sessionSurface({ sections, persona, visibleTools, skills })` from `tools/packaged-profile.mjs`; `ctx.get('skills').get(name, { scope, cwd })` — the same call the host's `skill` tool makes — returning `{ content }`.
- Produces: a persisted `readiness.instruction` block `{ mode, modeLabel, section_count, guidance_problems, path_problems, offered_tools, skill_tool_offered, resolved_skills }`, and a `readiness.stages.instruction_surface` gate that refuses the paid path when either problem list is non-empty.

- [ ] **Step 1: Write the failing test**

`test/m2b-executor-wiring.test.mjs` reads both executor sources as text and asserts:

1. the two files are byte-identical;
2. each contains `fileURLToPath`, `buildInstructionSurface`, `guidanceReadinessProblems`, `classifyTurnOutcome`, `parseToolArguments`, `artifactPathsFromCreate`, `assessDelivery`, `ARTIFACT_TOKEN_ALLOWANCE`;
3. each offers `'skill'`;
4. each does **not** contain `new URL(import.meta.url).pathname`;
5. each does **not** contain `record.status = finalText ? 'OBSERVED'`;
6. `noteRequest` contains no `.professor/notes` path (nothing predicted from a title);
7. each persists `finish_reason` and `usage` on the attempt ledger;
8. `M2B-EXECUTION-INSTRUCTION.md` §5 names `run-model.mjs`, not `run-model-continuation.mjs`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/m2b-executor-wiring.test.mjs`
Expected: FAIL on assertions 1–7.

- [ ] **Step 3: Edit both copies identically — eight edits**

1. **Path** — line 60: `const DIR = path.dirname(fileURLToPath(import.meta.url))`; add `import { fileURLToPath } from 'node:url'`.
2. **Helper imports** — `buildInstructionSurface, guidanceReadinessProblems, requestTextProblems, classifyTurnOutcome, parseToolArguments, artifactPathsFromCreate, assessDelivery, INSTRUCTION_MODES, ARTIFACT_TOKEN_ALLOWANCE, REQUIRED_M2B_TOOLS` from `../../../test/helpers/m2b-run-config.mjs`.
3. **Instruction-mode flag** — `--instruction-mode=native` (default) or `--instruction-mode=supplied-skill-text`; recorded in `readiness.instruction.mode`.
4. **Surface + native skill resolution**, replacing `const system = \`${surfaceParts.persona}…\``:
   - resolve `resolvedContents` via `ctx.get('skills').get(name, { scope: setupSession.agent, cwd: workspace })` for `professor-notes` and `professor-latex`;
   - `supplied = mode === SUPPLIED ? resolvedContents : null`;
   - `const surface = buildInstructionSurface({ sections: surfaceParts.sections, persona: surfaceParts.persona, suppliedSkillText: supplied, suppliedSkillNames: supplied ? ['professor-notes','professor-latex'] : [] })`;
   - `const system = \`${surface.system}\n\nThis is a synthetic acceptance test …\``.
5. **Pre-request gates**, before the paid branch and reported in both modes — build `offered`, add `'skill'` in native mode, then compute `guidanceReadinessProblems({ mode: surface.mode, system, userMessage: requestText, resolvedSkillContents: resolvedContents, offeredTools: offered })` and `requestTextProblems({ text: requestText, workspace })`; persist both under `readiness.instruction`; set `stages.instruction_surface` to `done`/`blocked`; `await refuse(...)` in the paid branch when either is non-empty.
6. **Turn accounting** in `callModel` / `runNote`:
   - `maxTokens = ARTIFACT_TOKEN_ALLOWANCE` (drop the 2000 default for note cases);
   - after streaming write `attempt.finish_reason = finish` verbatim, `attempt.usage = finish?.usage ?? null`, `attempt.max_tokens = maxTokens` into `counter.attempts` **and** the report before returning (the continuation runner already persists the finish reason; extend to usage and per-round records);
   - `record.rounds.push({ round, finish, usage, tool_calls: calls.length })`;
   - replace `JSON.parse(block.arguments)` with `parseToolArguments`; on `ok === false` push a `tool_calls` entry with `isError: true` and the reason, set `record.status = 'INCOMPLETE'`, and stop the loop **without executing anything**;
   - replace `record.status = finalText ? 'OBSERVED' : 'NO-RESPONSE'` with `classifyTurnOutcome({ finish: lastFinish, finalText, artifactCreated })`; `tool-calls`, `max-tokens`, unrecognized, or budget exhaustion mid-turn all land on `INCOMPLETE`.
7. **Returned paths only** — replace the inline `call.result?.files` walk in `runNote` and `resolvePath` in M4 with `artifactPathsFromCreate(call.result, { workspace })`; record `collected.problems` verbatim.
8. **Delivery assessment** — `record.delivery = assessDelivery({ createdPaths, contents, indexRegistration: registrationRows, compiled, visuallyAccepted })` on the M2b case (and the same shape on M1/M2); the status is never promoted above `INCOMPLETE` while `delivery.ok === false`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/m2b-executor-wiring.test.mjs`
Expected: PASS.

- [ ] **Step 5: Confirm the two copies are byte-identical**

Run: `diff -q docs/qa/2026-10-12-source-grounded-notes/run-model.mjs docs/qa/2026-10-13-m2b-live/run-model.mjs`
Expected: no output.

- [ ] **Step 6: Commit** — recorded only.

---

### Task 7: Zero-cost executor run and the execution-readiness report

**Files:**
- Create: `docs/qa/2026-10-14-offline-release-preparation/m2b-readiness-zero-cost.json`
- Create: `docs/qa/2026-10-14-offline-release-preparation/M2B-EXECUTION-READINESS.md`

**Interfaces:**
- Consumes: the Task 6 executor; `--readiness-out=` so `docs/qa/2026-10-13-m2b-live/model-readiness.json` is never overwritten.
- Produces: the execution-readiness report — instruction mode, visible tools, output limits, path handling, proposed attempt budget.

- [ ] **Step 1: Run the executor's zero-cost path**

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  docs/qa/2026-10-13-m2b-live/run-model.mjs \
  --readiness-out=docs/qa/2026-10-14-offline-release-preparation/m2b-readiness-zero-cost.json
```
Expected: exit 0, `paid_requests: 0`, `model_calls: 0`, authorization `NOT GRANTED`, `stages.instruction_surface` reported, `instruction.mode = native-assembled-system-sections`, `instruction.guidance_problems` empty, `skill_tool_offered: true`.

- [ ] **Step 2: Write the readiness report**

Cover exactly: (a) instruction mode used and what it does/does not prove about native activation; (b) the offered tool list read back from the real registry; (c) `ARTIFACT_TOKEN_ALLOWANCE = 8000` and where finish reason + usage persist; (d) path handling — `fileURLToPath` in the executor, returned paths only, slugify's 64-char truncation and the long-title regression; (e) a **proposed attempt budget for the unfinished table case only**, justified from observed history (the 2026-10-13 run spent 6 attempts on retrieval with no artifact, so retrieval must be replayed from persisted context, leaving create → read/edit → compile: recommend **4 attempts** = 1 create round + 1 read/edit round + 1 compile-confirm round + 1 spare), stating the runner stops at the grant limit and never retries a failed request into a pass; (f) explicit non-claims — FO-8 open, Phase 6/7/8 open, no paid call made.

- [ ] **Step 3: Verify historical evidence is unchanged**

Run: `node --test test/evidence-preservation.test.mjs`
Expected: PASS against `hash-before.json`.

---

### Task 8: Full verification and independent review

**Files:**
- Create: `docs/qa/2026-10-14-offline-release-preparation/REPORT.md`
- Create: `docs/qa/2026-10-14-offline-release-preparation/hash-after.json`

- [ ] **Step 1: Configure the existing OCR runtime and run the full suite**

```bash
export DSH_PROFESSOR_ENHANCE_PYTHON=/tmp/professor-auto-prepare/env-e270c763ff8847c4562c/bin/python
export DSH_PROFESSOR_ENHANCE_BACKEND=pdfium
npm test
```
Expected: exit 0; report exact pass/fail/skip counts and whether `material-enhance-production` ran.

- [ ] **Step 2: Run every offline gate**

`npm run verify:syntax`, `verify:skills`, `verify:sync`, `verify:dist`, `verify:e2e`, `verify:publication`, plus `git diff --check`. Raise the timeout for long verifiers and run them one at a time (exit 137 with no output is a timeout, not a product failure).

- [ ] **Step 3: Run the harness chain**

`npm run verify:harness` with local listening permission; on `listen EPERM`, re-run in an isolated shell and record it as an environment restriction, not a product failure.

- [ ] **Step 4: Regenerate `hash-after.json` and compare**

Every pre-existing file must match `hash-before.json` exactly; new files under `docs/qa/2026-10-14-offline-release-preparation/` are expected additions.

- [ ] **Step 5: Obtain independent review**

Dispatch a fresh code reviewer over the working-tree diff; address every material finding before reporting.

- [ ] **Step 6: Write `REPORT.md`**

Sections required by the brief: changes made and their purpose; fresh verification results and remaining limitations; the safe GitHub publication inventory; evidence that historical artifacts are unchanged; the M2b execution-readiness report (or a pointer to `M2B-EXECUTION-READINESS.md`); remaining work before a Mac experimental release and before a stable Mac release. State plainly that offline runner repairs do not resolve FO-8 and do not complete Phase 6, 7 or 8.

---

## Self-review notes

- **Spec coverage:** publication boundary → Tasks 2–3; path fixes → Task 4; M2b repair → Tasks 5–7; preservation → Tasks 1 and 7.3; OCR runtime and honest skip reporting → Task 8.1; independent review → Task 8.5.
- **Type consistency:** `guidanceReadinessProblems` / `requestTextProblems` / `REQUIRED_M2B_TOOLS` are defined once in Task 5 and consumed only by Task 6.
- **Proportion:** the plan names signatures, assertions and commands; the executor body — the largest edit — is specified as eight numbered edits rather than transcribed.
