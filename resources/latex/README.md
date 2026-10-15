# Bundled course-note template

`default/main.tex` is the runtime default copied into new LaTeX note and review projects when no
usable custom template is configured. It reads generated `professor-metadata.tex` and
`content.tex`. Configured usable user templates take precedence. Existing artifacts are not
restyled or overwritten.

`reference/CSC3001note2.tex` is the user-supplied source template preserved verbatim, including
its original sample course/lecture/author fields. It is a reference asset, not the runtime driver.
Generated projects use current course/request metadata and never inherit that sample identity.

The default preserves the original dual large titles, separator, compact paragraphs, Python
listings, math, table and TikZ facilities. It adds larger blue section headings, bold subsection
headings and breakable `professorkey`, `professornote` and `professorexample` boxes. Use real
LaTeX environments in the generated content copy; the artifact tool's prose fields escape markup.

Compile with XeLaTeX (or latexmk with XeLaTeX), with Fandol fonts supplied by the TeX distribution.
A TeX installation must also supply the template's packages, including xeCJK, titlesec, tcolorbox,
TikZ, listings, booktabs, nccmath, bbm and the other packages listed in the driver. Fonts are not
bundled; no operating-system font is required. Compilation and PDF visual inspection are separate
checks. Missing packages or compiler capabilities must be reported instead of claiming success.
