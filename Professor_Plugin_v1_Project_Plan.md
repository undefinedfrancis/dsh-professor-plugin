# Professor Plugin v1 — Project Plan

> **Status:** Design baseline  
> **Purpose:** Define the latest agreed architecture and implementation plan for turning the existing Professor plugin into a self-contained, portable academic-agent plugin for DeepSeek Harness.  
> **Guiding principle:** Keep the plugin lightweight. Focus on the core UI, Professor behavior, built-in skills, memory, indexing, and clean Harness integration. Do not turn Professor into a second learning-management platform.

---

## 1. Project Goal

Professor should become a **self-contained, installable academic-agent plugin for DeepSeek Harness**.

After installing the plugin from GitHub on a fresh computer, enabling it should immediately provide:

- a dedicated **Professor** entry in the Harness sidebar;
- the complete built-in Professor identity and behavior rules;
- bundled Professor skills;
- Professor tools;
- a persistent memory mechanism;
- lightweight Professor-specific UI;
- the ability to connect an academic folder;
- automatic course/material indexing;
- customizable global and course-specific skill behavior;
- native Harness conversations for actual chat and tool execution.

The plugin must **not** depend on the developer's current machine, previous Hermes files, old Registry/Knowledge folders, or manually installed skills in order to work.

Legacy Hermes content is an optional migration source, not a runtime dependency.

---

# 2. Product Definition

Professor is **not merely a preset**.

It should be treated as a lightweight academic application inside Harness:

```text
DeepSeek Harness
│
├── Normal Harness
│   ├── New Session
│   ├── Projects
│   └── Normal conversations
│
└── Professor Plugin
    ├── Dedicated sidebar entry
    ├── Professor Home
    ├── Course view
    ├── Professor Settings
    ├── Professor memory
    ├── Built-in skills/tools
    └── Native Harness conversations
```

The Professor preset/runtime remains useful internally, but users should not need to manually create a generic session and then choose the Professor preset.

The intended experience is:

```text
Install Professor
    ↓
Enable Professor
    ↓
🎓 Professor appears in sidebar
    ↓
Open Professor
    ↓
Start or continue studying
```

---

# 3. Scope Principle

Professor is still **just a plugin**.

It must not become:

- a second Harness;
- a custom operating system;
- a Notion clone;
- a full learning-management system;
- a grade tracker;
- a course analytics dashboard;
- a task manager;
- a calendar;
- a second chat framework;
- a second session database.

The project should remain centered on:

```text
Professor identity
+ built-in academic workflows
+ lightweight UI
+ persistent memory
+ course/material context
+ skill customization
+ Harness-native conversation
```

Whenever a new feature is considered, ask:

> Is this required for Professor to function as a high-quality independent academic bot?

If not, defer it.

---

# 4. Existing Project Baseline

The current project already includes a substantial working Professor implementation.

The handoff baseline reports:

- approximately **15 `professor_*` tools**;
- **6 bundled skills**;
- working course management;
- course/session binding;
- material indexing;
- text extraction;
- source-grounded retrieval;
- learning-state support;
- Markdown/LaTeX note generation;
- review generation;
- LaTeX compilation;
- diagnostics and health checks.

Existing skill domains include:

- `course-management`
- `study`
- `notes`
- `review`
- `research`
- `latex`

This new project phase should **extend the existing core**, not replace it.

Preferred strategy:

```text
Existing Professor Core
        +
Portable UI / Memory / Integration Layer
```

Avoid unnecessary rewrites.

---

# 5. Non-Negotiable Existing Behavior

The existing Professor safety and correctness rules remain mandatory.

## 5.1 Course Isolation

Each course must preserve its own:

- identity;
- materials;
- preferences;
- learning state;
- output locations.

Never silently mix courses.

If multiple courses match and Professor cannot safely determine the intended one, ask rather than guess.

---

## 5.2 Source Truthfulness

Professor must not fabricate:

- page numbers;
- slide numbers;
- source files;
- citations;
- extracted material content.

Professor should clearly distinguish:

1. content supported by course materials;
2. Professor/model explanation;
3. external research.

---

## 5.3 Learning-State Truthfulness

The existence of a course or lecture file does **not** mean the user has studied it.

Professor should update learning state only when there is real learning evidence.

Never manufacture learning progress to make the system appear more capable.

---

## 5.4 Source Files Remain Safe

Original course materials are read-only inputs.

Professor may:

- read;
- scan;
- index;
- extract;
- retrieve;
- cite.

Professor must not silently:

- rename;
- move;
- delete;
- rewrite;
- reorganize;
- overwrite

the original course material tree.

---

## 5.5 Artifact Safety

Professor-generated outputs may be saved only to appropriate configured output directories.

Cross-course output writing must remain forbidden.

Professor must not silently overwrite an existing user file.

---

## 5.6 Format Gate

When creating a saved artifact, historical preference alone must not automatically authorize a file format if the current request requires a format choice.

Existing format-gate behavior must be preserved.

---

# 6. Target Architecture

Professor v1 should contain six logical components:

```text
Professor Plugin
│
├── 1. Professor Core
│   ├── Identity
│   ├── Constitution
│   ├── Teaching behavior
│   ├── Truthfulness rules
│   ├── Memory policy
│   └── Runtime policy
│
├── 2. Professor Skills & Tools
│   ├── Built-in skills
│   ├── professor_* tools
│   ├── Global customizations
│   └── Course-specific overrides
│
├── 3. Professor Memory
│   ├── Global preferences
│   ├── Course memory
│   ├── Learning memory
│   └── Session metadata
│
├── 4. Academic Workspace
│   ├── Connected folder
│   ├── Course detection
│   ├── Material indexing
│   └── Course configuration
│
├── 5. Professor UI
│   ├── Sidebar entry
│   ├── Home
│   ├── Course view
│   └── Settings
│
└── 6. Harness Integration
    ├── Native Conversation
    ├── Session routing
    ├── Storage
    └── Plugin packaging
```

Do not add additional architecture layers without a strong reason.

---

# 7. Professor Core

The Professor identity must ship with the plugin.

It must not depend on an external local `SOUL.md`, personal configuration directory, or previous Hermes setup.

The built-in Professor Core should define stable defaults for:

- academic-assistant identity;
- teaching philosophy;
- explanation style;
- source-grounding behavior;
- truthfulness;
- course isolation;
- memory policy;
- artifact safety;
- material handling;
- session behavior;
- skill-loading behavior.

The plugin itself must contain what makes Professor **Professor**.

User customization should extend this core, not replace the existence of the core.

---

# 8. Built-In Skills

The following Professor skills should ship inside the plugin:

```text
study
course-management
notes
review
research
latex
```

A fresh installation must not require the user to separately install these skills.

Built-in skill definitions should be treated as **read-only defaults**.

Do not personalize Professor by directly editing bundled skill files.

Instead, use an overlay system.

---

# 9. Skill Customization

Use the following precedence model:

```text
Built-in Skill
      ↓
Global Professor Customization
      ↓
Course-Specific Override
      ↓
Current Session / Explicit User Instruction
```

Example:

```text
Built-in Study Skill
  → explain concepts clearly and use course material when available

Global Study Preference
  → Chinese preferred
  → use step-by-step explanations

CSC3200 Study Override
  → prefer C++ examples
  → explain algorithm intuition before code
  → recommend LeetCode examples when appropriate

Current Session
  → studying Hash Tables from Lecture 05
```

The effective behavior is composed from these layers.

---

## 9.1 Global Skill Customization

Professor Settings should allow lightweight customization of skills such as:

```text
Study        Customize
Notes        Customize
Review       Customize
Research     Customize
LaTeX        Customize
```

Possible customization fields:

- preferred language;
- explanation style;
- teaching depth;
- preferred programming language;
- additional instructions.

Do not build a complicated visual skill editor.

---

## 9.2 Course-Specific Skill Overrides

Each course should optionally override global skill behavior.

Example:

### CSC3200

```text
Study:
- Prefer C++ examples.
- Explain algorithm intuition before implementation.
- Relate explanations to course lectures.
- Suggest LeetCode-style examples when useful.
```

### STA2001

```text
Study:
- Explain formula intuition before calculation.
- Show derivation when appropriate.
- Include English terminology alongside Chinese explanation.
```

### PHY1001

```text
Study:
- Explain physical meaning before equations.
- Use force/diagram reasoning before formulas.
```

The user should be able to choose:

```text
Use global settings
```

or define course-specific additions.

Plugin upgrades must not overwrite these customizations.

---

# 10. Professor Memory

Professor must include a persistent memory mechanism similar in spirit to the previous Hermes Professor experience.

Memory must survive:

- closing a session;
- restarting Harness;
- opening a new Professor session.

Memory should **not** be implemented by replaying large amounts of old conversation history.

Use structured persistent state.

---

## 10.1 Memory Categories

Keep v1 memory small.

### A. Global Preferences

Examples:

- preferred language;
- preferred teaching style;
- preferred coding language;
- stable academic preferences.

### B. Course Memory

Examples:

- course-specific instructions;
- recent topic;
- last Professor session;
- relevant course preference.

### C. Learning Memory

Reuse and integrate with the existing concepts:

```text
PROGRESS
KNOWLEDGE
MISTAKES
```

Do not create unnecessary duplicate learning-state systems.

---

## 10.2 Memory Lifecycle

Expected behavior:

```text
Professor Conversation
        ↓
Meaningful learning/preference evidence
        ↓
Memory update
        ↓
Persistent Professor storage
```

Later:

```text
New Professor Session
        ↓
Identify course/task
        ↓
Retrieve relevant memory
        ↓
Build context
        ↓
Respond
```

Professor should not need to reopen an old chat merely to remember stable relevant information.

---

## 10.3 Memory Safety

Do not save every message.

Do not treat every temporary statement as a permanent preference.

Do not fabricate missing memory.

Do not guess lost study history.

Remember the distinction:

```text
Plugin ships memory mechanism.
User activity creates memory content.
```

Therefore a fresh install correctly starts with:

```text
Memory mechanism: available
Memory content: mostly empty
```

---

# 11. Fresh Install / Zero-Setup Requirement

This is one of the most important release requirements.

On a fresh computer, Professor must work without:

- `/Users/<user>/...`;
- old Hermes files;
- old Registry;
- old Knowledge;
- manually installed Professor skills;
- hand-written YAML;
- manually copied prompts;
- pre-existing Professor memory.

Expected flow:

```text
Fresh Computer
    ↓
DeepSeek Harness
    ↓
Install Professor from GitHub
    ↓
Enable Professor
    ↓
🎓 Professor appears
    ↓
Professor is immediately usable
```

With no course folder configured, Professor should still function as a general academic assistant.

Example empty state:

```text
🎓 Professor

Your academic assistant is ready.

No courses connected yet.

[Start chatting]
[Add academic folder]
```

---

# 12. Academic Folder

The user should be able to configure a Professor academic folder from plugin settings.

Example:

```text
Professor Settings

Academic Folder

/Users/example/Documents/courses

[Change Folder]
```

This folder is a **data source**.

It is not the Professor runtime itself.

Professor Core, skills, tools, memory mechanism, and UI must still work if this folder does not exist.

---

# 13. First-Run Folder Initialization

After selecting a folder:

```text
Choose Academic Folder
        ↓
Validate
        ↓
Scan
        ↓
Detect Courses
        ↓
Detect Material Categories
        ↓
Ask User About Ambiguity
        ↓
Build Professor Index
        ↓
Save Professor Metadata
        ↓
Ready
```

Normal users should not need to manually create `.professor`, `project.yaml`, or other internal files.

---

# 14. Course Detection

Professor should use:

```text
automatic detection
+
user confirmation when uncertain
```

High-confidence examples:

```text
CSC3200
STA2001
PHY1001
```

Ambiguous examples:

```text
Algorithms
Math
Course A
```

Ambiguous identities must not be guessed silently.

Professor should present the detected folder and allow confirmation/editing.

---

# 15. Professor-Owned Metadata vs User Files

Professor-derived state must remain separate from source materials.

A possible model:

```text
Academic Root/
│
├── CSC3200/
├── STA2001/
├── PHY1001/
│
└── .professor/
    ├── project config
    ├── index/
    ├── memory/
    ├── sessions/
    └── customization/
```

If Harness storage provides a cleaner supported persistence mechanism, it may be used instead.

The architectural rule is what matters:

```text
Original Course Materials
        ≠
Professor Derived State
```

---

# 16. Indexing

Professor indexes must be:

- derived;
- disposable;
- rebuildable.

The original materials are always the source of truth.

Deleting the Professor index must not damage course materials.

Professor must be able to rebuild it.

---

## 16.1 Initial Indexing

First connection:

```text
scan
→ classify
→ extract/index
→ save metadata
```

---

## 16.2 Incremental Indexing

After the initial build, Professor should avoid full rescans on every start.

Prefer lightweight detection of:

- new files;
- changed files;
- removed files.

Update only what is needed.

Settings should also provide:

```text
[Rebuild Index]
```

for explicit recovery.

---

# 17. Professor UI

Keep the UI deliberately small.

Professor v1 has only three meaningful surfaces:

```text
1. Professor Home
2. Professor Course View
3. Professor Settings
```

No large dashboard system.

---

# 18. Sidebar Entry

When Professor is enabled, Harness should show a dedicated top-level entry.

Conceptually:

```text
+ New Session

🎓 Professor

Projects
────────────
CampusHub
Personal Website
agent1
...
```

The implementation must use supported Harness plugin APIs.

Do not use brittle DOM hacks if official APIs are available.

If the installed Harness does not support the required UI safely, stop and document the blocker rather than silently implementing an unstable workaround.

---

# 19. Professor Home

Professor Home should answer:

> What should I continue or study now?

Recommended layout:

```text
🎓 Professor                         Settings

Continue

CSC3200 · Hash Tables
Last studied recently
                                      Continue →

Courses

CSC3001   CSC3200   CSC4801
GFN1000   PHY1001   STA2001

Recent Sessions

CSC3200   Hash Tables
STA2001   Conditional Probability
PHY1001   Momentum

                              + New Study Session
```

Home responsibilities:

- continue latest Professor session;
- show configured courses;
- open recent Professor sessions;
- start new study session;
- open settings.

Do not add:

- mastery charts;
- grades;
- study-time statistics;
- calendars;
- todos;
- exam countdowns;
- complex dashboards.

---

# 20. Course View

The Course page remains lightweight.

Example:

```text
← Professor

CSC3200
Algorithms & Data Structures

Recent Sessions

Hash Tables
STL Review
Lecture 04

Course Materials

Lectures          8
Assignments       2
Supplementary     4
Exams             1

[Browse Materials]

                         + Start Study Session
```

Required elements:

- course identity;
- recent Professor sessions;
- material summary;
- simple material browser;
- start-session action.

No complex multi-tab learning dashboard in v1.

---

# 21. Material Browser

The material browser is only a UI over existing indexing/retrieval capabilities.

Suggested categories:

```text
Lectures
Assignments
Supplementary
Exams
```

Do not incorrectly classify ordinary code/course-info/supplementary folders as exams.

Material actions should remain simple:

```text
Study
Ask Professor
```

Do not build a PDF viewer in v1.

---

# 22. New Study Session

The new-session UI should stay small.

Required fields:

```text
Course
Mode
Topic (optional)
```

Suggested modes:

```text
Learn
Question
Assignment
Review
Exam
Free
```

Example:

```text
Start Study Session

Course
[CSC3200]

Mode
[Learn]

Topic
[Hash Tables]

Cancel            Start
```

Mode only provides useful academic context.

Do not turn modes into a complex workflow engine.

---

# 23. Native Harness Conversation

Professor must **reuse Harness's native conversation runtime**.

Do not build a second chat UI.

Expected flow:

```text
Professor UI
    ↓
Start/Open Professor Session
    ↓
Create/Open Harness Session
    ↓
Activate Professor Runtime/Preset
    ↓
Bind Course if applicable
    ↓
Load relevant memory/customization
    ↓
Open Native Harness Conversation
```

Harness remains responsible for:

- message rendering;
- streaming;
- tool execution;
- permissions;
- attachments;
- model execution;
- conversation history.

Professor is responsible for:

- academic identity;
- academic context;
- course context;
- skill behavior;
- memory;
- routing.

---

# 24. Professor Session Metadata

Do not create a second conversation database.

Professor only needs minimal metadata around native Harness sessions.

Example:

```json
{
  "harnessSessionId": "session-xxx",
  "course": "CSC3200",
  "title": "Hash Tables",
  "mode": "learn",
  "updatedAt": "..."
}
```

This metadata answers:

- Is this a Professor session?
- Which course does it belong to?
- What is its study mode?
- What should Professor call it?
- When was it last active?

The actual conversation remains a Harness session.

---

# 25. Session Separation

Professor sessions should appear through Professor UI instead of cluttering normal project workflows.

Use supported Harness classification/hiding/routing mechanisms.

Do not:

- rewrite session logs;
- delete history simply to hide it;
- force incompatible events;
- corrupt old sessions.

Session isolation is a presentation/routing concern, not an excuse to damage Harness data.

---

# 26. Professor Settings

Keep Settings compact.

Recommended sections:

```text
General
Academic Folder
Courses
Skills
Memory
Index
Diagnostics
```

Example:

```text
Professor

Enable Professor        ON

Academic Folder
/path/to/courses
[Change]

Courses
6 configured
[Manage]

Skills
Study
Notes
Review
Research
LaTeX
[Customize]

Memory
Persistent Memory      ON

Index
52 materials
Last updated ...
[Rebuild Index]

Diagnostics
Professor runtime      Ready
Tools                  Ready
Skills                 Ready
```

Do not turn Settings into an admin dashboard.

---

# 27. Course Settings

A course may expose lightweight settings such as:

```text
Course Code
Course Name
Course Folder
Notes Folder
Special Instructions
Skill Overrides
Status
```

This should map to existing Professor course configuration wherever possible.

Do not create an entirely separate course-configuration subsystem.

---

# 28. Legacy Hermes Data

Legacy Hermes data is optional.

Possible future/import sources include:

```text
Registry
Knowledge
old course preferences
old study state
```

Professor v1 must not require these.

If import functionality exists, it should remain:

- explicit;
- reviewable;
- non-destructive;
- conflict-aware.

Do not silently migrate old learning history.

---

# 29. Profile Export / Import — Future Extension

A lightweight future extension may allow:

```text
Professor Settings
→ Export Profile
```

to export:

- preferences;
- skill customization;
- course configuration;
- Professor memory.

Course PDFs/PPTs should not be included.

This is useful for moving Professor personality/memory between computers.

It is **not required for the first v1 implementation**.

Cloud synchronization is explicitly out of scope.

---

# 30. Git Safety Strategy

Before implementation, inspect the repository.

Required baseline audit:

```bash
git status --short
git branch --show-current
git log --oneline -10
git diff --stat
```

Do not assume modified or untracked files are disposable.

Never use destructive cleanup commands without explicit authorization.

Examples that must not be used casually:

```bash
git reset --hard
git clean -fd
git checkout .
git restore .
```

The previous handoff records an existing baseline commit:

```text
f2cbd25 Save Professor plugin v0.12.0 verified baseline
```

but later fixes may not be included in that commit.

Therefore:

1. inspect current changes;
2. run current tests;
3. preserve valid existing work;
4. create a new safety checkpoint if appropriate;
5. then start feature work.

Recommended branch:

```text
feature/professor-portable-app
```

Recommended pre-feature checkpoint:

```text
chore: checkpoint Professor before portable app work
```

---

# 31. Commit Discipline

Use milestone-sized commits.

Suggested sequence:

```text
chore: checkpoint Professor pre-v1 app work

feat: bundle Professor core and portable defaults

feat: add persistent Professor memory

feat: add academic folder indexing

feat: add Professor sidebar and home

feat: add Professor course and session routing

feat: add skill customization

feat: add Professor settings and diagnostics

test: add fresh-install acceptance coverage

docs: document Professor v1 architecture
```

Before every commit:

- run relevant tests;
- inspect `git diff`;
- run `git diff --check`;
- verify staged files;
- avoid unrelated changes.

Do not create one giant final commit.

---

# 32. Implementation Milestones

---

## M0 — Repository Audit and Safety Baseline

### Goal

Understand the real existing repository before changing architecture.

### Tasks

Read and inspect:

- `PROJECT_MEMORY.md`
- `README.md`
- `docs/PARITY.md`
- `docs/AUDIT.md`
- `docs/PLAN.md`
- `docs/SKILLS.md`
- plugin entrypoint
- Professor preset/runtime
- skill provider
- storage usage
- course configuration
- material indexing
- session integration
- UI extension support
- settings extension support

Verify:

- current Harness version;
- current package version;
- current tools;
- current skills;
- actual Git state;
- actual tests;
- actual plugin activation.

### Acceptance

- existing tests pass;
- existing Professor preset works;
- tools activate;
- skills activate;
- no course source material is modified;
- Git checkpoint is safe;
- feature branch exists.

Do not continue if the baseline is broken without documenting why.

---

## M1 — Portable Professor Core

### Goal

Make Professor's essential identity and behavior fully self-contained.

### Tasks

- audit current Professor instructions;
- remove accidental machine-specific dependencies;
- bundle stable identity;
- bundle stable constitution;
- bundle stable behavior;
- ensure skills are plugin-provided;
- verify fresh install does not require legacy files.

### Acceptance

Use an isolated Harness profile with:

- no `Personal-Agent`;
- no old Registry;
- no old Knowledge;
- no existing course folder.

Verify:

- Professor starts;
- academic identity is active;
- built-in rules are active;
- built-in skills are available;
- no developer-specific files are required.

---

## M2 — Persistent Professor Memory

### Goal

Professor preserves useful relevant state across sessions and restarts.

### Tasks

- choose supported Harness persistence;
- persist global preferences;
- persist minimal course memory;
- integrate existing learning state;
- retrieve memory at Professor session start;
- avoid duplicate memory systems.

### Acceptance

1. Open fresh Professor session.
2. Establish a stable preference.
3. Perform simple learning interaction.
4. Close Harness.
5. Restart Harness.
6. Open new Professor session.
7. Verify relevant memory is restored.

Memory must come from persistent Professor state, not simply from reopening the same chat.

---

## M3 — Academic Folder and Indexing

### Goal

Connect a user's course folder without manual setup.

### Tasks

- folder selection;
- validation;
- scan;
- course detection;
- ambiguity confirmation;
- material categorization;
- Professor-owned index;
- incremental update;
- explicit rebuild.

### Acceptance

Use a fixture course tree.

Before setup:

- snapshot/hash/stat source files.

After setup:

- source files unchanged;
- Professor index exists;
- courses detected;
- materials searchable;
- categories correct.

Then:

- add one file;
- modify one file;
- remove one file;
- verify incremental index behavior.

---

## M4 — Independent Professor UI

### Goal

Professor becomes a first-class Harness entry.

### Tasks

- verify official Harness UI extension API;
- add sidebar entry;
- add Professor Home;
- add empty state;
- show Continue;
- show Courses;
- show Recent Sessions;
- add New Study Session.

### Acceptance

- enable plugin → Professor appears;
- disable plugin → entry disappears correctly;
- clicking Professor opens Home;
- normal Projects remain unchanged;
- normal sessions remain usable;
- fresh profile works.

---

## M5 — Course UI and Session Routing

### Goal

Create the lightweight academic workflow.

### Tasks

- Course page;
- Recent Sessions;
- Material summary;
- Browse Materials;
- Study action;
- Ask Professor action;
- New Study Session;
- Professor session metadata;
- automatic Professor runtime activation;
- course binding;
- native Harness Conversation opening.

### Acceptance

Create:

```text
CSC3200
→ Learn
→ Hash Tables
```

Verify:

- native Harness conversation opens;
- Professor runtime active;
- CSC3200 bound correctly;
- Professor tools available;
- Professor skills available;
- session visible inside Professor;
- normal project UI not polluted;
- session remains discoverable after restart.

---

## M6 — Skill Customization

### Goal

Allow personalization without modifying built-in skills.

### Tasks

- global skill customization;
- course-specific overrides;
- deterministic composition;
- safe separate storage;
- preserve customization across updates.

### Required Precedence

```text
Built-in Skill
<
Global Professor Customization
<
Course Override
<
Current Explicit Instruction
```

### Acceptance

Configure:

```text
Global Study:
Detailed explanations.

CSC3200:
Prefer C++ examples.

STA2001:
Explain intuition before formulas.
```

Verify the two courses behave differently while built-in skill files remain unchanged.

---

## M7 — Settings and Diagnostics

### Goal

Normal users can configure Professor without editing YAML.

### Tasks

Implement lightweight controls for:

- enable/disable;
- academic folder;
- courses;
- skill customization;
- memory;
- index state;
- diagnostics.

### Acceptance

A user should be able to:

1. install Professor;
2. enable Professor;
3. connect course folder;
4. customize a skill;
5. start studying;
6. rebuild index;
7. verify Professor health;

without opening config files manually.

---

## M8 — Fresh Install Release Gate

### Goal

Prove Professor works as a portable plugin.

Use a completely isolated Harness profile.

It must contain:

- no Professor configuration;
- no Personal-Agent;
- no Hermes files;
- no developer-specific course paths;
- no manual Professor skills.

### Acceptance Sequence

1. Install packaged Professor plugin.
2. Start Harness.
3. Verify Professor sidebar entry.
4. Open Professor.
5. Start general academic session with no courses.
6. Verify Professor identity.
7. Verify built-in skills.
8. Verify Professor tools.
9. Save a stable preference.
10. Restart Harness.
11. Verify memory retrieval.
12. Connect fixture academic folder.
13. Verify course discovery.
14. Verify indexing.
15. Verify original files unchanged.
16. Customize Study globally.
17. Customize Study for one course.
18. Start a course session.
19. Verify customization composition.
20. Restart again.
21. Verify Professor Home restores course/session state.

Professor v1 is not release-ready until this passes.

---

# 33. Regression Requirements

After each milestone, run the relevant existing test suite.

At final completion, run the full suite.

The previous project handoff reported:

```text
215/215 unit tests
28/28 end-to-end scenarios
Harness verification ALL PASS
```

These are historical values only.

Do not claim them after modifications unless tests are re-run successfully.

Documentation must always reflect actual current results.

---

# 34. Anti-Drift Rules

These rules exist specifically to prevent future agents from moving the project away from its purpose.

## Rule 1 — Extend, Do Not Rewrite

Do not replace working systems simply because another implementation seems cleaner.

Prefer minimal extension.

---

## Rule 2 — No Unrequested Expansion

If an idea is useful but not required, document it under:

```text
Future Ideas
```

Do not implement it.

---

## Rule 3 — UI Is Thin

Do not move Professor's academic logic into UI code.

UI controls and exposes Professor Core.

It does not replace Professor Core.

---

## Rule 4 — Fresh Computer Test

For every dependency, ask:

> Would Professor itself still work if every `/Users/<user>/...` path disappeared?

If not, determine whether the dependency is legitimate user data or an accidental machine dependency.

Allowed to disappear:

- the student's courses;
- the student's personal memory;
- the student's preferences.

Must still exist:

- Professor identity;
- Professor rules;
- Professor skills;
- Professor tools;
- Professor memory mechanism;
- Professor UI.

---

## Rule 5 — Capability vs Personal Data

Always distinguish:

```text
Professor Capability
```

from:

```text
the student's Professor Data
```

The plugin ships capability.

Usage creates personal data.

---

## Rule 6 — Code Existing Is Not Completion

A feature is complete only when:

```text
Implementation
+
Automated Verification
+
Real Harness Verification where necessary
```

all succeed.

---

## Rule 7 — Never Hide Failure

Do not silently bypass:

- failed tests;
- unsupported Harness APIs;
- broken indexing;
- memory failures;
- migration conflicts.

Report them.

---

## Rule 8 — Protect Source Files

A failed Professor operation must never damage original course materials.

Safety has priority over convenience.

---

## Rule 9 — No Session-Log Hacks

Do not modify or corrupt Harness session logs to make Professor sessions appear hidden or compatible.

Use supported routing/classification mechanisms.

---

## Rule 10 — Stay Lightweight

If implementation starts creating:

- complex dashboards;
- new editors;
- new viewers;
- new runtimes;
- new chat frameworks;
- large workflow engines;

stop and return to this plan.

---

# 35. Explicitly Out of Scope for v1

Professor v1 does not require:

- custom chat UI;
- custom LLM runtime;
- custom model server;
- custom file manager;
- PDF viewer;
- calendar;
- todo manager;
- grade tracking;
- mastery percentage;
- course analytics;
- complex learning dashboards;
- flashcard UI;
- custom Notes editor;
- second conversation database;
- cloud memory sync;
- mobile app;
- Harness fork;
- DOM hacks;
- automatic Hermes migration.

These may be considered later only if clearly justified.

---

# 36. Documentation and Handoff

Maintain:

- `README.md`
- architecture/design documentation
- implementation plan/status
- `PROJECT_MEMORY.md`

At each milestone, record:

```text
Milestone
Status
Implemented
Verified
Tests
Git branch
Git commit
Files changed
Source/user files modified
Remaining risks
Next milestone
```

`PROJECT_MEMORY.md` must remain a factual handoff document.

Do not use vague claims such as:

- "fully complete";
- "1:1 parity";
- "production ready";

unless the relevant acceptance tests prove them.

---

# 37. Definition of Done

Professor v1 is complete only when all of the following are true:

- [ ] Professor installs from the plugin package on a fresh Harness profile.
- [ ] Professor appears as a dedicated UI entry.
- [ ] Professor works with no course folder configured.
- [ ] Professor identity and behavior rules are bundled.
- [ ] Professor built-in skills are bundled.
- [ ] Professor tools activate correctly.
- [ ] Professor persistent local memory works across restart.
- [ ] User can connect an academic folder.
- [ ] Professor can detect/configure courses.
- [ ] Professor builds its own indexes.
- [ ] Original course materials remain unchanged.
- [ ] Professor provides lightweight course browsing.
- [ ] Professor can start course-aware study sessions.
- [ ] Professor reuses native Harness conversations.
- [ ] Professor sessions are logically separated from ordinary project workflows.
- [ ] Global skill customization works.
- [ ] Course-specific skill overrides work.
- [ ] Customization survives restart.
- [ ] Existing Professor functionality still passes regression tests.
- [ ] Fresh-install acceptance test passes.
- [ ] Documentation reflects actual current implementation.
- [ ] Git contains safe milestone commits.

---

# 38. Final Design Principle

When choosing between two possible implementations, prefer the one that makes Professor:

- more portable;
- easier to install;
- safer with user files;
- easier to understand;
- more predictable;
- less machine-dependent;
- more compatible with Harness;
- lighter in architecture.

The intended end result is:

> **A high-quality, self-contained Professor Agent that behaves like a dedicated academic bot inside DeepSeek Harness, installs cleanly from GitHub, includes its own carefully designed skills and behavior, remembers useful context, understands connected course materials, supports controlled personalization, and never takes ownership of the user's original files.**

That is the design target for Professor Plugin v1.
