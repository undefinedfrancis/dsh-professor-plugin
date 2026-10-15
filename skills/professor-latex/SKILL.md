---
name: professor-latex
description: >
  Use when creating, revising, compiling or quality-checking a LaTeX note, formula sheet or
  handout for a course, including requests for the bundled course-note template, typeset
  mathematics, diagrams, or PDF layout review.
---

# Professor — LaTeX Workflow

LaTeX output is only finished when it compiles and its PDF has actually been inspected — or when
you say plainly that it was not.

## 1. Resolve the template

Resolve the course with `professor_course_list` and create the artifact through
`professor_artifact_create` with the chosen `format: "latex"`. The tool inspects and copies a
usable configured template into the output, or generates a self-contained project using the
bundled `resources/latex/default/main.tex`, adapted from `CSC3001note2.tex`. This is the default
for both notes and reviews when no usable custom template exists. Inspect
`created`, `files`, `main_file`, `template` and `warnings` before claiming success. Report an
unusable template and any fallback explicitly. Never edit, tidy or "improve" the template itself,
and never compile inside it.

Validate the project before writing content: inspect the returned driver `main_file` and its
actual inputs. The built-in fallback uses `main.tex`, `content.tex` and `professor-metadata.tex`;
it does not require `preamble.tex` or `metadata.tex`. Templates may use other filenames. Read the
copied driver to confirm that it includes the generated content and metadata; do not infer that
from successful copying or a file count. Modify only the artifact copy when integration is needed.

The bundled reference `resources/latex/reference/CSC3001note2.tex` preserves the supplied source
template; it is not the generated driver. Its original course, lecture and author fields are
reference data. Generated notes use the resolved course and current request through
`professor-metadata.tex`; unknown personal metadata stays empty.

## 2. Fill the metadata

Inspect `professor-metadata.tex` and any metadata expected by the copied template. The built-in
renderer provides `\ProfessorCourseCode` and other `\Professor...` macros; a configured template
may instead expect macros such as `\coursecode`. Reconcile those names only in the artifact copy.
Set values from the resolved course and request; leave unknown values empty rather than inventing
an author, semester or title.

## 3. Generation contract

- Reuse the project's existing macros and environments instead of redefining them. Read the
  copied `main.tex` first; keep document-level styling there and substantive material in
  `content.tex`. An explicit custom template keeps its own file layout.
- One concept per subsection; a clear heading hierarchy.
- Define every symbol at first use; keep the course's notation.
- Use defined semantic environments (`lemma`, `proof`, `itemize`, `verbatim`/`lstlisting` in the
  bundled default) rather than visual hacks. Check that an environment exists before using it.
- Never invent BibTeX entries, DOIs or references from memory.
- Keep the source material read-only; the note is new content in the output project.

For the bundled default, retain its two large title lines, horizontal separator, compact
paragraph spacing, large blue section headings and bold subsection headings. Use selected
`\textbf{...}` conclusions in the output copy, with explanation around them. Its available
facilities are:

| Purpose | Existing facility |
|---|---|
| Key result or distinction | `\begin{professorkey}[重点] ... \end{professorkey}` (blue) |
| Assumption, pitfall or boundary | `professornote` (amber, default title 注意) |
| Worked example with intermediate reasoning | `professorexample` (green, default title 例题) |
| Comparative/numeric table | `tabular` with `booktabs` rules |
| Branch/state diagram | `tikzpicture`; trees, arrows.meta, positioning and calc are loaded |
| Code and pseudocode | `lstlisting[language=Python]` and `algorithmic` |

Prefer the explicit raw-fragment route in the creation call: with `format: "latex"`, use
`sections[].body_tex`, `examples[].body_tex`, and review `derivations[].body_tex` for real math,
semantic boxes, tables and diagrams. A nonempty `body_tex` replaces `body` for that entry in the
LaTeX output. For example:

```json
{"format":"latex","sections":[{"heading":"Result","body_tex":"\\begin{professorkey}For $x>0$, $\\log x$ is defined.\\end{professorkey}"}]}
```

The fragment must omit `\documentclass` and document scaffolding, balance its environments and
request no shell escape. Bounded fragment validation is not a TeX syntax, mathematical correctness
or compilation verdict. Review the actual generated source and formulas, including assumptions,
symbols, intermediate transitions and interpretation. Inspect template facilities before selecting
an environment; custom templates may not define the bundled boxes. Use a few useful boxes rather
than boxing every paragraph. Diagrams need labels, a caption or adjacent explanation, and verified
values; distinguish sourced figures from illustrative additions. Explicit brief notes and compact
formula sheets retain their requested scope.

Plain `body` and other text fields remain escaped: raw LaTeX there prints literally. For Markdown,
omit `body_tex`. Never unescape prose globally. `terminology` still builds a real two-column glossary
table; a wider table belongs in `sections[].body_tex` as a real `tabular`, preserving every header,
value and source citation. The same raw-fragment exception supports equations and environments.
Host filesystem edits of output `content.tex` remain available for repairs, existing-note updates
and integration the structured route cannot express; they are not required for every new formula
or table. Never edit the shared template or source material.

A `\begin{tabular}` placed in `sections[].body` prints as escaped literal text. The document can
still report `compilation_succeeded` and a text-level check can still pass while the page shows
`\{}begin{tabular}` where the table should be — so the static review gate must look for that
literal in `content.tex`, and the verdict must not claim a typeset table until the rendered page
has been inspected.

## 4. Gates, in order

1. **Format gate** — per `professor-notes`: use the user's explicit LaTeX choice for this artifact;
   otherwise ask. A stored format preference does not bypass this gate.
2. **Static review gate** — read the generated `.tex` before compiling: undefined symbols, unused
   macros, unbalanced environments, references to files that do not exist, content that duplicates
   the source instead of summarising it. Also read it for escaped markup: a literal
   `\textbackslash\{\}begin\{tabular\}` or `\textbackslash\{\}begin\{itemize\}` in `content.tex`
   means a semantic environment was put where the renderer escapes it, and it will print as text.
3. **Compile gate** — call `professor_latex_compile` with the artifact's returned `directory`,
   selected `course`, `kind` and `main_file`. The tool classifies the document before it chooses a
   driver: the plugin's own generated `main.tex` declares `dsh-professor-requirement: unicode-cjk`
   (the plugin emits CJK section headings such as 概述), so it is compiled with XeLaTeX —
   `latexmk -xelatex` when latexmk is present — using a CJK font that ships **inside the TeX
   distribution** (Fandol); a user-provided `main.tex` declares nothing and keeps whatever driver it
   already had. Read `compiler.requirement`, `compiler.flavor` and `compiler.cjk_fonts`, plus
   `verdict`, `static`, `stdout`, `stderr` and `pdf.produced`. A missing XeLaTeX or a missing CJK
   font is reported as `compiler_unavailable` **with the reason** — never as a compile failure and
   never as a silent fall-back to pdfTeX. Do not assume a TeX directive alone selects an available
   engine. Do not enable shell escape implicitly. Treat unresolved references or missing packages as
   issues to fix or disclose.
4. **Repair loop** — read `failure_class` first. When it is `environment` (permission/sandbox denial,
   missing compiler, font or TeX package), stop document repairs and disclose the blocker; changing
   correct content will not repair the environment. For `document` errors, fix only the artifact
   copy and recompile, at most three repair attempts for this request. If an error repeats without progress or needs an
   unavailable compiler/package, stop the loop and report the remaining blocker. Label each
   fix's severity (blocking / significant / cosmetic).
5. **Visual review gate** — only claim the layout is correct after looking at the produced PDF (or
   its rendered pages) with an actual image-reading tool. Otherwise say the visual check was not
   performed. Record actual pages inspected. Read `pdf.pages`, `pdf.inspected_pages` and
   `pdf.visual_review` (`none`, `partial`, `full`, or `unscoped`); disclose partial coverage or an
   unknown page total rather than claiming whole-document layout approval. To record inspection,
   call the compile tool with `visually_inspected` and `inspected_pages` only after looking at the
   PDF. A confirmed `reused_prior_compile: true` result records this without another compilation
   (`attempted: false`, `timings.compile_ms: null`), using prior successful evidence only when
   source fingerprint and actual PDF hash still match. Never assume that reuse occurred: inspect
   the returned flag. Changed sources/PDF or uncertain preflight require fresh compile evidence
   and inspection of the newly produced PDF.

## 5. Honest reporting

End with a verdict line in this shape:

```
编译：通过/未执行/失败；结构审查：通过/需修改；版式审查：通过/未执行；遗留问题：…
```

- No compiler available → `编译：未执行`, and say which capability is missing. Do not claim a PDF.
- Compilation failed → `编译：失败`, include the first blocking error and what you tried.
- Compilation succeeded but you did not inspect the PDF → `版式审查：未执行`.
- Never state that a PDF exists, or that a formula rendered correctly, without the evidence.

## 6. Output location

Use the actual output root and artifact directory returned by `professor_artifact_create`.
The course's AI Notes Output may point to `<course_root>/04_My-Notes/AI-Notes/`; the plugin's
unconfigured fallback is the project's `.professor/notes`. Do not guess a course-relative root.
Never write it into the Knowledge Root, and never overwrite an existing note without an explicit
decision. If the output directory already contains a project for that unit, choose a versioned
directory name or ask.
