---
name: professor-notes
description: >
  Use when the user asks for a saved study note, lecture note, revision note, formula sheet, or a
  note update in Markdown or LaTeX, including notes intended for independent review or revisiting
  material whose reasoning was unclear.
---

# Professor — Note Generation

Turn verified material into a durable note the student can understand without reopening the chat.
Preserve the reasoning needed for review; producing a note is not evidence of learning mastery.

## Preserve explanatory depth

A normal study-note request calls for a learnable account of the material, even when the request
is short. Organise each central concept around the problem it solves, the necessary definitions
and notation, the reasoning that leads to the result, and a worked application. For a derived
formula, retain the starting identity, intermediate steps and why the non-obvious transitions
hold. Name assumptions at the point where they are used; an unexplained formula list is a
different deliverable, appropriate when the student explicitly asks for a formula sheet.

Use one concrete example throughout a concept, with enough calculation or state trace to reproduce
it. Add a useful connection to prior knowledge and a limiting case or contrast that reveals when
the method applies. Explain what the result means and how to recognise a similar problem.
If a necessary prerequisite is new to the student, introduce it in the note rather than leaving
the proof dependent on chat history. Supplementary derivations and examples are labelled as such;
unread source details remain unresolved instead of being invented.

An explicitly requested summary, formula sheet or quick reference keeps that scope; select the
conditions and essential relationships it needs without expanding it into a full lesson.
For ordinary review notes, a compact recap comes after the substantive explanation. Keep optional
practice distinct from worked examples. Match Markdown formulas to the destination's verified
capabilities as described below; LaTeX output uses the chosen document's typesetting conventions.

## Readable presentation

For a substantive Markdown note, use one `#` title and `##` main-section headings; use `###`
only for genuine subsections. The artifact tool already adds the title and section headings:
pass plain titles in `title` and `sections[].heading`, with only local subheadings inside bodies.
Keep related explanation, the calculation and its interpretation close together. Before each
new equation or method, bridge from the preceding result: explain what is being found, why that
step is valid, and what its result means. A proof must remain understandable between headings.

Bold selected conclusions, key quantities and important distinctions. Use a small number of
meaningful cues such as `🎯 **重点**`, `⚠️ **注意 / 易错点**` and `💡 **直觉**`, with normal
text explaining each one. Use a table for comparisons and a compact branching/state diagram
when it makes the reasoning easier to follow; give it a caption and explain how to read it.
Keep source and supplementary content distinguishable. Graphs use supplied/computed values,
declared assumptions and labelled axes; never present an illustrative plot as the source's figure.

For Markdown, mathematics must match the destination viewer. The `$...$`/`$$...$$` notation
is for viewers with verified math support. When support is unknown or the student sees
raw delimiters, use readable Unicode/plain formulas and defined symbols; preserve complex
mathematics through a genuinely rendered image/PDF when available. Use bold/labels for emphasis
unless colors are actually supported. Raw styled HTML, Mermaid or SVG code does not prove a
rendered visual. Actual image assets must be created and inspected in the output project before
linking them; never insert a guessed or placeholder path. LaTeX output follows professor-latex
and its compile/visual review gates.

Explicit summaries, formula sheets and brief notes retain their requested size and purpose;
they do not require the full heading/cue/visual pattern. Whitespace and useful grouping should
make the content easier to understand, not fragment it into many tiny sections.

## Resolve the course and source

Use `professor_session_status` and `professor_course_list` to resolve the intended course; pass its
identifier to artifact and state tools. If the course is ambiguous, ask before saving. Do not
invent a course binding or register a course merely to answer a note request.

Reuse material actually delivered in the current session. For source content still missing,
use `professor_material_read` to retrieve its body or relevant page images before summarizing.
A search hit or reading-plan excerpt is a locator, not proof that the full requested scope was
read. State any unread or unresolved portions in the note rather than claiming complete coverage.
Use `source_chunks` only for source references actually returned by the tools; do not invent
file IDs or chunk IDs to fill the citation field. Keep a plain source description when structured
provenance is unavailable and disclose that limitation.

## Format gate

- If the user explicitly names Markdown or LaTeX for this artifact, use it.
- Otherwise ask for this artifact, even when the course stores a default format. A saved
  preference or a choice made for an earlier note does not bypass the format gate:

  ```
  请选择笔记格式：
  1. Markdown
  2. LaTeX
  ```

The gate applies to saved lecture notes, detailed notes, revision notes, combined notes and
exported notes. It does not apply to an explanation that is never written to disk.

Create the saved note through `professor_artifact_create` with `kind: "note"` and the explicitly
chosen `format` (`markdown` or `latex`). If the tool returns `format_required: true`, ask its
question and retry only after the user chooses; nothing was written by that response. Treat
`created: true` and the returned `files` as evidence of creation, and report any problems rather
than claiming a note was saved.

## Where notes go

- Resolve the destination with `professor_artifact_status` for the selected course. Use its
  configured **AI Notes Output**, which may be `<COURSE_ROOT>/04_My-Notes/AI-Notes/`.
  Without a course or project output setting, the plugin falls back to the project's
  `.professor/notes`; do not create a guessed course-relative destination. The creation tool's
  returned `root`, `directory` and `files` identify where the artifact was actually saved.
- Never write final notes into the Knowledge directory, into the course's original material
  folders, or outside the configured output.
- Never modify, move or delete the source material a note is derived from.

## Never overwrite silently

1. Inspect an existing note at the intended path before writing.
2. If one exists, choose a versioned name (`...-2`, `...-3`, or a date-prefixed name) or ask for
   explicit approval to replace it.
3. When updating an existing note, preserve its useful content and revise intentionally — never
   erase a long note to insert one section.

## Content contract

- Write for review, not for dumping: one concept per subsection, definitions stated once, formulas
  written with the course's own notation.
- Separate explicitly:
  - **Professor's material** — sourced from the course material, with provenance;
  - **Additional explanation / intuition / supplementary example** — your own elaboration.
  Never let the second masquerade as the first.
- Mark the sections a deep dive should revisit, using the marker
  `重点掌握：加深讲解`, together with what was unclear and what would resolve it.
- Record provenance for anything traceable: course, source file, and — when the extractor provided
  it — page, slide, heading or chunk. If provenance is unavailable, say so rather than inventing a
  page number.
- Do not invent BibTeX entries, citations or references from memory. If a reference is needed and
  the source is not at hand, flag it as unresolved.

## Tables and structured content

A table is structured content, not prose. Put it where the format can typeset it — never as raw
LaTeX inside a text body.

- **Markdown:** write a pipe table with matching header/data columns. Escape literal `|` inside
  cells as `\|`, including `P(+\|D)` or `E[X\|Z]`; otherwise a condition becomes an extra column.
  Inline code/math does not remove that requirement. Put long formulas outside the table.
- **LaTeX:** prefer `sections[].body_tex`, `examples[].body_tex`, and review
  `derivations[].body_tex` with `format: "latex"` for real formulas, tables, semantic boxes and
  diagrams in the initial creation call. Nonempty `body_tex` replaces `body` for that entry in
  LaTeX rendering. `terminology` still builds a two-column glossary table; wider tables use a
  real `tabular` in `body_tex`, keeping all headers, values and source references.
- Plain `sections[].body` and other prose fields are escaped. Putting `\begin{tabular}` there
  prints literal markup, even if compilation succeeds. Do not globally unescape text. Omit
  `body_tex` for Markdown. Raw fragments must omit document scaffolding, balance environments
  and request no shell escape; review actual source and formulas after bounded validation.
- Editing the generated output `content.tex` remains a repair/update or unsupported-integration
  route, rather than a mandatory rewrite for every new table or equation. Keep edits in the
  artifact copy; never edit the shared template or source material.

## LaTeX notes

For LaTeX, use `professor-latex`: it resolves the template, copies it into the output project,
validates it, and runs the compile gate. Never claim a PDF exists, or that the layout was
verified, unless compilation actually ran and its output was inspected. Read `failure_class`:
`environment` blockers stop document repairs; only document errors enter the bounded repair loop.
State actual visual coverage from `pdf.pages`, `pdf.inspected_pages` and `pdf.visual_review`;
partial or unscoped inspection is not whole-document approval. After actual image inspection,
record it with `visually_inspected`/`inspected_pages`. Only a returned `reused_prior_compile: true`
confirms inspection recording without recompilation, based on unchanged source fingerprint and
actual PDF hash; otherwise use the new compile result and inspect its produced PDF.

## State updates after a note

`professor_artifact_create` saves the artifact but does not update learning state. After a
successful creation, read the selected course's `INDEX.md` with `professor_state_read` and use
the available host filesystem tool to merge the returned note path into that unit's entry.
Preserve unrelated entries; never replace the whole index with a note summary. Do not send
INDEX changes to `professor_state_update`, which supports only PROGRESS and MISTAKES.
If creation failed or returned `created: false`, do not record that a note exists. If index
registration is unavailable or fails, preserve the saved note and report the partial result;
do not regenerate the artifact just to retry its index entry.

A generated note updates `INDEX.md` and nothing else by default.
Do not mark a unit completed because a note was created. Update `PROGRESS.md` or `KNOWLEDGE.md`
only on independent evidence of learning, and `MISTAKES.md` only for recurring or meaningful
misconceptions. Keep Knowledge compact: merge into existing entries instead of appending new
copies.

## Report

Say where the note was written, which format was used, what was sourced from professor material
versus added as explanation, and which state files were updated — or why none were.
