---
name: professor-course-management
description: >
  Use when registering, locating, updating, synchronising or archiving a course, or when a
  request needs the course identity, source paths, note output paths or learning-state location
  resolved first. Owns course configuration and lifecycle; it does NOT teach content and does NOT
  generate notes.
---

# Professor — Course Management

Owns **course identity, paths, configuration, lifecycle and structural INDEX sync**. It never
teaches a concept and never writes a study note: those belong to `professor-study` and
`professor-notes`.

## Authority

The **Professor project document** (`.professor/project.yaml`) is the single source of truth for
course identity and configuration, and it is reached only through the Professor tools:

- `professor_course_list` — read the catalogue, resolve one course, validate its paths;
- `professor_course_manage` — register / update / archive / reactivate;
- `professor_paths` — confirm the project root and whether an academic folder is connected.

Never edit `project.yaml` by hand, and never maintain a second copy of the catalogue anywhere else.

If `professor_paths` reports `projectBound: false`, **no academic folder is connected to this
workspace**. That is a normal state for a general academic session, not an error to work around:
say so plainly, ask the user which folder holds their courses, and run `professor_project_init`
from a session whose workspace is *that* folder. Never infer a course root from the current
directory, a filename, or a guess.

Resolution order — stop at the first unambiguous match:

1. an explicit course code in the request;
2. a registered course name;
3. the course this conversation is bound to (`professor_session_status`);
4. the catalogue from `professor_course_list`.

If two courses match, ask which one. Never pick one silently, and never create a second
registration to work around capitalisation or spacing differences.

If the conversation is bound to one course but the request is about another, say so and change the
binding explicitly with `professor_session_bind` — never answer a CSC3200 question out of STA2001's
state because that is what happened to be bound.

## Where course state lives

| Kind | Location | Owner |
|---|---|---|
| Course catalogue | the `courses` list in `.professor/project.yaml` — **a table only** | this skill, through `professor_course_manage` |
| Learning state | `.professor/state/courses/<course_id>/{PROGRESS,MISTAKES,KNOWLEDGE,INDEX}.md` — the **Knowledge Root** | `professor_state_read` reads all four; `professor_state_update` writes `PROGRESS.md` / `MISTAKES.md`; `KNOWLEDGE.md` / `INDEX.md` are edited with the filesystem tools |
| Derived indexes | `.professor/indexes/` — rebuildable, disposable | `professor_index_sync` |
| Notes and reviews | resolved note/review output roots, never the Knowledge Root; unconfigured fallbacks are `.professor/notes` / `.professor/reviews` | `professor-notes` / `professor-latex` |
| Course material | the user's own folders — **read-only, never copied in** | the user |

The indexes under `.professor/indexes` are rebuildable derived data; learning state and saved
artifacts under `.professor/state`, `.professor/notes` and `.professor/reviews` are persistent user
work and must be preserved. None of these directories is original course material.

The catalogue is a table: identity, term, status, source roots, output roots and note preferences.
It must not accumulate progress, knowledge or teaching notes — those have their own files.

## Course fields

The Professor schema carries, in this order: Course Code, Course Name, Semester, Status; Course
Root; Lecture / Tutorial / Assignment / Additional Course Materials; Personal Notes Root,
AI Notes Output; Knowledge Root (derived, not configured); Default Note Format, Explanation
Language, Source Language; LaTeX Template, Compiler; Special Instructions; Exam-Oriented Course,
Exam Notes.

Enumerated values: Status `active | completed | archived`; Default Note Format `LaTeX | Markdown`
(preferences are stored, but each saved artifact still requires a format choice for the current request);
Exam-Oriented Course `yes | no | unknown`. A directory that is not there is reported as `N/A` —
never left blank, never filled with a guess.

Real configurations drift: a value outside an enum, a prose sentence where a path is expected, a
missing section. **Preserve what you find.** Report the drift, ask before normalising it, and never
rewrite a working configuration to match a template.

## Operations

### REGISTER

1. Confirm the course code, name and semester.
2. Confirm the external course root (absolute). Never copy course material into Professor state.
3. Inspect the real directory structure and record which slots exist
   (`00_Course-Info`, `01_Lectures`, `02_Tutorials`, `03_Assignments`, `04_My-Notes`, `05_Exams`,
   `06_Code`, or their actual equivalents).
4. Confirm the **AI Notes Output** before registration. If the chosen destination is the course's
   `<course_root>/04_My-Notes/AI-Notes` or another custom root, supply it as `notes_root` when
   registering through `professor_course_manage` (`action: register`) with `source_path`. Omitting
   `notes_root` uses the project's `.professor/notes` fallback; it does not select AI-Notes automatically. The tool
   derives the per-category rules from the directories that are really there; do not invent a rule
   for a directory that does not exist.
5. Verify the actual output with `professor_artifact_status` for the registered course. Do not
   claim it is configured until the tools return that root, and do not pass `notes_root` to
   `action: update`, whose supported fields do not include it.
6. Learning state is created *lazily*, never fabricated up front: `professor_state_read` reports
   `present: false` for a course that has not been studied, which is a correct state and not a
   missing file to be filled in. `professor_state_update` writes `PROGRESS.md` / `MISTAKES.md` the
   first time there is real evidence. `professor_index_sync` writes the derived file index,
   not the learning-state `INDEX.md`. Never
   create a state file just so that one exists, and never put invented content in one.
7. Run `professor_index_sync` to build `.professor/indexes/files.json` from what actually exists.
8. Validate with `professor_course_list`: every declared path exists or is `N/A`, and no source
   points at another course.

### SYNC

Run `professor_index_sync` to pick up material that was added, changed, moved or removed in the
derived file index. It does not update configuration or learning-state **INDEX.md**. Update
configuration-level facts only through `professor_course_manage` when requested. If a learning
INDEX entry needs a source-path correction, read it with `professor_state_read` and merge the
verified correction with the available filesystem tool, preserving note links and learning meaning.
Preserve `PROGRESS.md`, `KNOWLEDGE.md` and `MISTAKES.md`. Never reset a studied unit to "not started"
because files moved, and never delete a record because a source disappeared — mark it missing instead.

### LOCATE

Answer with the resolved course code, course root, AI Notes Output, Knowledge Root and the source
slots that exist, from `professor_course_list`. Say plainly when a path is missing rather than
substituting another course's.

### UPDATE

Change only the fields the user asked about, through `professor_course_manage` (`action: update`).
Never reset knowledge, progress or mistakes, and never silently rewrite unrelated fields.

### ARCHIVE

Set the status to `archived` through `professor_course_manage` (`action: archive`).
**Delete nothing** — not material, not notes, not configuration, not learning state. Archiving is a
status change; the course stays readable, and reactivating it restores it.

## Boundaries

- Final notes never live in the Knowledge Root; the state files must not become a second copy of
  notes.
- Course material is read-only. Never create, move, rename, copy or delete a source file.
- Structural INDEX maintenance is in scope; the *learning meaning* of PROGRESS, KNOWLEDGE and
  MISTAKES is not — hand those to `professor-study` / `professor-notes` / `professor-review`.
- Report what you changed and what you deliberately left untouched.

## Optional: importing an existing Personal-Agent registry

Only when the user explicitly asks to bring pre-existing Hermes / Personal-Agent course
configuration into Professor. This workflow is optional, never automatic, and never part of a fresh
install — a new user has no such registry and does not need one.

1. Ask for the registry directory. The documented default is
   `${PERSONAL_AGENT_ROOT}/01_Learning/Registry`; if `professor_paths` reports
   `PERSONAL_AGENT_ROOT` as unresolved, ask the user for the path instead of guessing.
2. Call `professor_course_manage` with `action: import` and `dry_run: true` first. Read the returned
   migration plan: the field mapping, the per-course source digests and the **unmapped-field
   report**. Show the user what would be carried over and what would not.
3. Only after the user accepts the plan, re-run with `dry_run: false`. The import is idempotent — a
   re-run reports `already-registered` rather than duplicating a course — and it reads the source
   registry read-only.
4. Report the outcome and the plan path under `.professor/migrations/`. If an unmapped field
   matters to the user, that is a conversation about the Professor schema, not something to patch
   into a file by hand.
