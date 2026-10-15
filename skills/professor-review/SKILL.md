---
name: professor-review
description: >
  Use when the user asks for exam preparation, midterm or final review, a weak-point summary, a
  review plan, or practice questions. Builds an evidence-based priority map, runs guided
  small-block review, labels every practice item, and writes a separate review artifact.
---

# Professor — Exam Review

Review is evidence work: the scope and the priorities come from the course material and the
persistent learning state, never from assumptions about what an exam "usually" covers.

## Before building a plan

1. Confirm the course and its exam orientation from the registry.
2. Read the professor material that defines the scope, plus `PROGRESS.md`, `KNOWLEDGE.md`,
   `MISTAKES.md` and the requested deep dives.
3. Ask only what materially changes the plan — the exam date, the chapters in scope, available
   time, and the intensity the student wants. Do not ask for anything you can resolve from the
   registry, the index or the state files.
4. State clearly what is **not** confirmed: if the professor has not indicated exam emphasis, say
   so instead of inventing it.

Resolve the course with `professor_session_status` / `professor_course_list` and read its state
with `professor_state_read`. Use `professor_material_read` for source bodies and relevant page
images not yet delivered; search hits and plan excerpts alone do not establish exam coverage.
If state is absent, build the review from the confirmed material and the student's current
answers; do not invent past weaknesses, mistakes or mastery.

## Priority map

Produce a map with these four labels, and nothing else, each item tied to its evidence:

- 薄弱点 — from recurring mistakes and weak topics in the state files;
- 重难点 — from material density, derivations and the student's own difficulty signals;
- 高频基础 — foundations the course builds on throughout, not from guesswork about exams;
- 待确认范围 — material whose exam relevance cannot be established yet.

Separate **evidence-backed observations** (what the supplied material, sample or state actually
shows) from **study recommendations** (your advice on how to spend time), and label
recommendations as such. Never assert measured scoring efficiency (得分效率/性价比), mark-loss
rates (丢分率) or exam frequency (必考/必考型/每年必考) the supplied evidence does not establish.

## Guided review loop

Work in small blocks, one at a time:

1. objective of the block and its prerequisites;
2. a concise explanation, with the course's notation preserved;
3. one worked example;
4. ask the student to solve a related problem — do not reveal the answer first;
5. diagnose the errors by type: concept, setup, algebra, code syntax, or carelessness;
6. update `PROGRESS.md`, and `MISTAKES.md` only for meaningful, recurring or exam-relevant errors;
7. choose the next block adaptively: reinforce, advance, or revisit.

Adapt the pace to the answers. If the student is struggling with a prerequisite, fix that before
continuing.

## Practice questions

- Prefer professor tutorials, assignments, past exams and the supplied textbook.
- Label every item as exactly one of: **原题** (verbatim source question), **改编题** (adapted from a
  source question), **新编练习** (newly generated practice).
- Never imply that a newly generated question came from the professor.
- Give progressive hints; give a full solution only after an attempt or an explicit request.
- Mix recall, explanation, derivation, application and exam-style items.

## Review artifact

When the user requests a saved review, write it as a **separate** artifact with
`professor_artifact_create`, `kind: "review"`. Resolve its destination through
`professor_artifact_status` for that course: the tool uses the configured review output, with
the project's `.professor/reviews` as its unconfigured fallback. Do not assume the lecture-note
root is also the review root, and never overwrite an ordinary lecture note.
It contains: the scope, the priority map, essential definitions and
formulas, the step-by-step derivations or code patterns, the common traps tied to actual recorded
mistakes, representative examples with their labels, and an unresolved-items checklist.

The note format gate applies. For LaTeX, use `professor-latex` and its compile gate.
Map practice labels to tool origins `original`, `adapted`, or `generated`, and supply only
verified source references. Check `created`, `files`, `warnings` and `problems` before reporting
the artifact as saved. A conversational plan or practice session does not require a saved
artifact or a format question unless the user asks for one.

## Boundaries

- Never invent exam scope, weighting or professor preferences.
- Do not expand into unrelated advanced material.
- Keep the artifact separate from lecture notes and from the Knowledge files.
