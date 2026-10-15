# Third-party content notices — learning presets

**Capture date: 2026-10-10.**

The five bundled learning presets (`src/skills/presets.js`: 循序讲解 / 引导思考 / 考前复习 /
编程实践 / 快速答疑) are **original content written for Professor**, identified by the provenance
value `original:professor-v1`. **No third-party skill text, code, or teaching material is bundled
in these teaching presets**. Material recognition has a separate setup-time dependency download described below.

## Source research record

External skill sources were researched against the release gate in
`docs/superpowers/specs/2026-10-10-bulk-clear-learning-presets-design.md` §4. None of the examined
candidates met the "verifiably popular and redistributable" bar for adaptation, so none was
imported. The full comparison — URLs, authors, verified licenses with license-file URLs, captured
metrics, pinned revisions where inspected, dependency/safety findings and rejection reasons — is
recorded in `docs/qa/2026-10-10-bulk-clear-learning-presets/SOURCES.md`.

Summary of examined candidates (details in SOURCES.md):

| Candidate | License (verified) | Popularity evidence (2026-10-10) | Disposition |
| --- | --- | --- | --- |
| Jellypod-Inc/school-skills | MIT, LICENSE file verified ("Copyright (c) 2026 Jellypod") | 7 GitHub stars (repository-level) | Not adapted — popularity below the bar |
| benrosche/socratic-tutor | MIT, LICENSE.md verified ("Copyright (c) 2026 Ben Rosche") | 2 GitHub stars (repository-level) | Not adapted — low popularity; server/credential workflow removed as incompatible anyway |
| ClawHub jiangkaiqi2005/study-tutor | MIT-0 shown on listing page (no license-file URL exposed) | Downloads/ratings unavailable on the listing; 4 bookmarks | Not adapted — metrics unverifiable |
| anthropics/skills (`academy-guide`) | Apache-2.0 (non-document skills, per repository README) | 180.2k GitHub stars (repository-level) | Not adapted — the only learning-related skill is a course-recommendation checkpoint with an external catalog fetch, not teaching pedagogy |

If a future release adapts any third-party teaching content, the exact source commit, the adapted
sections, the retained copyright notices and the license text must be added to this file before
shipping.

## Teaching-interaction design research (2026-10-11 → 2026-10-12)

The teaching-interaction improvements shipped on 2026-10-12 (request-intent handling, graduated
assistance, optional understanding checks, first-gap feedback, assistance-aware learning evidence)
implement an approved design whose research record is
`docs/qa/2026-10-11-teaching-design/RESEARCH.md` and `sources.json`. That design was informed by
the following open-source skill repositories, studied as reference material only:

| Repository | License | Used as reference for |
| --- | --- | --- |
| bstellato/ai-teaching-skills | MIT | focused questioning, teach-back, first-gap comparison |
| learning-commons-org/agent-skills | Apache-2.0 | narrowly targeted diagnostic questions, response-specific actions |
| Jellypod-Inc/school-skills | MIT | graduated hints, response-sensitive tutoring |
| GarethManning/education-agent-skills | CC BY-SA 4.0 | transfer checks, assisted-versus-independent evidence |

**No third-party skill text, code, or teaching material was copied or adapted into the bundled
skills or presets.** All shipped wording remains original content written for Professor
(`original:professor-v1`); only unprotectable ideas and techniques informed the design. The
prohibited imports recorded in the research (rigid answer refusals, compulsory testing gates,
unavailable skill handoffs, speculative age inference, unsupported timing mechanisms) were
explicitly rejected and do not appear in the bundle. Immutable source commits were not resolved at
research time (`sources.json` records main + retrieval date); this is acceptable precisely
because no source wording was taken. If a future release adapts source *expression* — including
anything from the CC BY-SA 4.0 repository — the exact source commit must first be verified and
recorded here, together with the adapted sections, retained copyright notices, attribution,
modification disclosure, and the CC BY-SA 4.0 share-alike conditions.

## Material recognition runtime

The plugin ships its own adapter code, platform-specific dependency locks and a model-resource
manifest. It does not redistribute third-party Python wheels or model weights in the tarball.
First-use preparation downloads wheels from PyPI and pinned model files from Hugging Face,
checks their hashes, and retains wheel package metadata and license files in the private venv.
Recognition itself disables network access and does not upload course material.

The locked runtime includes Docling, RapidOCR, PyMuPDF, PDFium, PyTorch and their transitive
dependencies. Their licenses remain applicable to the installed runtime; this notice does not
relicense those components. Exact versions and wheel hashes are in `resources/enhance/requirements/`;
model repositories, immutable revisions, sizes and hashes are in `resources/enhance/models.json`.
Any redistribution of a prepared environment must retain the upstream notices and comply with
the licenses of those components.

## LaTeX typesetting runtime (Unicode/CJK)

The generated default `main.tex` asks for `iftex`, `fontspec`, `xeCJK` and the **Fandol** font
family (`FandolSong-Regular`, `FandolSong-Bold`, `FandolKai-Regular`, `FandolHei-Regular`,
`FandolHei-Bold`, `FandolFang-Regular`). None of these is redistributed by this package: the tarball
contains only the generator code in `src/artifacts/latex.js`, which *names* them in the document it
emits. They are resolved at compile time from the user's own TeX installation through kpathsea,
exactly as that installation already resolves every other package the document loads.

- **Fandol** (The Fandol Project) — SIL Open Font License 1.1; ships inside TeX Live under
  `texmf-dist/fonts/opentype/public/fandol`.
- **fontspec**, **xeCJK**, **iftex**, **hyperref**, **geometry**, **enumitem**, **amsmath** — LaTeX
  Project Public License (LPPL), as distributed with the TeX installation.

Choosing fonts that ship with the TeX distribution rather than an operating-system font name is
what keeps this package free of platform-specific font dependencies and free of a bundled font
payload; it is also why no new resource file was added under `resources/`. Because nothing is copied
into this package, no OFL or LPPL text is re-licensed here — anyone redistributing a TeX
installation remains subject to those upstream licences.

If the TeX installation lacks XeLaTeX, or lacks Fandol, `professor_latex_compile` reports
`compiler_unavailable` and names the missing capability. It never downloads or installs a font, an
engine or a package on the user's behalf.

