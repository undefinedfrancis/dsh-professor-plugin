/**
 * Deterministic grading for N2 — source-grounded note delivery.
 *
 * Grades a model's **verbatim, unedited** response against the synthetic answer key and against
 * the evidence that was actually retrieved. Three things shape it:
 *
 * - **It only asserts structure.** Citation shape, page membership against retrieved coverage,
 *   presence of a direct claim beside the citation to the page that claim lives on, presence of the
 *   three required labels, absence of course/source codes other than the bound ones. Whether the
 *   prose is *good* is a human judgement and is recorded in a separate column of the report; this
 *   module never merges the two, so an automated pass can never launder a prose failure or vice
 *   versa.
 * - **The answer key is the ground truth, not the model.** A direct claim must be cited on the
 *   page the key records, and the retrieved text for that page must actually contain the anchor —
 *   so a right answer attached to the wrong page fails, and so does a citation to a page whose
 *   retrieved text does not carry the claim.
 * - **Coverage is checked against retrieval, not against the PDF.** `retrievedPages` is what the
 *   tool results actually returned; a cited page outside it is invented unread coverage even when
 *   the PDF happens to have that page.
 *
 * ## What a check may say
 *
 * Every check carries a `status` of `pass`, `fail` or `review-required`, and `pass` is true **only**
 * for `pass`. G3 grades a direct claim at three granularities and records which one it used:
 *
 * - `unit` — the answer appears in a statement (sentence, table row or list item) that cites one
 *   page, and that page is the claim's. This is the only tier that passes.
 * - `paragraph` — the answer appears in a statement that cites the claim's page *alongside other
 *   pages*, so the paragraph does not say which page the value belongs to.
 * - `introducing-block` — the answer's statement cites nothing and a neighbouring paragraph carries
 *   the citation, which is how a table introduced by a citing sentence reads.
 *
 * The last two are real associations that a mechanical screen cannot settle, so they are reported
 * as review items with the evidence attached and handed to the manual column of the report — never
 * promoted to a pass.
 *
 * ## Limits of the mechanical screen — state these wherever the results are reported
 *
 * - **Statement association, not meaning.** G3 establishes "this answer's surface form appears in a
 *   statement that cites a page whose retrieved text carries the source anchor". It does not
 *   establish that the statement *means* what the key's question asks.
 * - **Surface forms come from the key.** `value_patterns` are the answer's accepted written forms
 *   (source language and Chinese paraphrase). When the answer carries a number, the statement that
 *   is credited must carry that number too: naming the scheme alone, or quoting the heading the
 *   number sits under, is a *partial* statement and is reported as unmet rather than passed. A
 *   pattern that is a bare number is recognised as that number; the citation association is what
 *   earns the pass, not the number's meaning.
 * - **Caveat detection is lexical.** G5 recognises uncertainty and confirmation by explicit
 *   wording. A statement confident in every word it uses while meaning something hedged will not be
 *   caught, and one hedged in wording only will not be credited as hedged.
 * - **Nothing is graded on rendered output.** That a PDF typesets is a separate gate.
 *
 * Pure: no I/O, no network, no model. Importing it can never spend a request, which is what lets
 * the test suite exercise the whole grader for free.
 *
 * @module test/helpers/source-grounded-grading
 */

import { ANSWER_KEY, COURSE_CODE, PDF_PAGES, SOURCE_RELATIVE_PATH } from './source-grounded-fixture.mjs'

/** The three outcomes a check can carry. `review-required` is never a pass. */
const STATUS = { PASS: 'pass', FAIL: 'fail', REVIEW: 'review-required' }

const CITATION_RE = /\[source:\s*([^,\]]+?),\s*page\s*(\d+)\s*\]/g

/** Uncertainty wording the source itself uses, plus the Chinese forms a bilingual note may use. */
const CAVEAT_RE = new RegExp(
  [
    'UNVERIFIED', 'UNCERTAINTY', 'unconfirmed', 'unverified',
    'not\\s+been\\s+independently\\s+confirmed', 'not\\s+independently\\s+confirmed',
    '未确认', '未验证', '未证实', '不确定', '未经', '存疑', '尚待', '待核实',
    '未独立确认', '未经独立确认', '尚未独立确认', '未被独立确认', '没有被独立确认',
    '合成测试数据', '测试用途', '单次运行',
  ].join('|'),
  'gi',
)

/**
 * Wording that *denies* the confirmation it contains. Matched and removed before the confirmation
 * scan, because `not independently confirmed` and `independently confirmed` are opposite verdicts
 * and only the second contradicts the source's own label.
 */
const NEGATION_RES = [
  /not\s+been\s+independently\s+confirmed/gi,
  /not\s+independently\s+confirmed/gi,
  /do\s+not\s+quote[^.;\n]{0,60}?established\s+fact/gi,
  /must\s+not\s+be\s+quoted[^.;\n]{0,40}?established\s+fact/gi,
  /不得作为既定事实/g,
  /不应作为既定事实/g,
  /不可作为既定事实/g,
  /不能作为既定事实/g,
  /不得当作既定事实/g,
  /不作为既定事实/g,
  /非既定事实/g,
  /不得作为已确立/g,
  /不应作为已确立/g,
  /不作为已确立/g,
  /不得当作真实性能基准/g,
  /不可当作真实性能基准/g,
  /不应作为已确立的性能事实/g,
  /不作为既定/g,
]

/** Affirmative confirmation of something the source refuses to confirm. */
const CONFIRMATION_RE = new RegExp(
  [
    'independently\\s+confirmed', '已独立确认', '已经独立确认',
    'established\\s+fact', '既定事实', '已确立', '已验证', '已证实', '确认无误',
    'verified\\s+(?:fact|figure|figures|result|results|measurement)',
  ].join('|'),
  'gi',
)

/**
 * Does this statement contain the direct claim's answer, as the note writes it?
 *
 * `complete` is the stronger question and the one the association is made on. When the key's
 * answer carries a number, a statement that names only the scheme — or only the heading the number
 * sits under — has not stated the answer, so it is not enough to earn a pass. That keeps the
 * figure and its citation travelling together instead of letting either one stand in for the other.
 *
 * @returns `{ present, complete }` — `present` is kept so a partial statement can still be
 *   reported rather than silently ignored.
 */
function claimMatches(text, item) {
  const body = String(text)
  const patterns = item.value_patterns ?? []
  const digitPatterns = patterns.filter((pattern) => /\d/.test(pattern))
  const present = body.includes(item.expected) || patterns.some((pattern) => body.includes(pattern))
  const complete = digitPatterns.length === 0
    ? present
    : body.includes(item.expected) || digitPatterns.some((pattern) => body.includes(pattern))
  return { present, complete }
}

function citationsIn(text) {
  return [...String(text).matchAll(CITATION_RE)]
    .map((match) => ({ file_id: match[1].trim(), page: Number(match[2]) }))
}

/** Paragraph-level units: a blank line ends one. */
function blocksOf(body) {
  return String(body).split(/\n{2,}/).map((block) => block.trim()).filter((block) => block.length > 0)
}

/**
 * Sentences inside a block. Deliberately conservative in both directions: `4.1` and `0.75` are
 * values, not sentence ends, so a split needs whitespace and a capital after the dot — and `[` is
 * excluded from the "new sentence" lookahead because `[source: …, page N]` opens with one. A
 * citation *closes* a statement, so the text after one starts the next: without that, a block of
 * three separately cited claims would read as one statement citing three pages, and every claim in
 * it would be graded as ambiguous.
 */
function sentencesOf(block) {
  const parts = String(block)
    .split(/(?<=[。！？；;])\s*|(?<=\.)\s+(?=[A-Z"'“(])|(?<=\])\s+(?=\S)/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return parts.length > 0 ? parts : [String(block)]
}

const MARKDOWN_ROW_RE = /^\s*\|.+\|\s*$/
const MARKDOWN_SEPARATOR_RE = /^\s*\|[\s:|-]+\|\s*$/
const LIST_ITEM_RE = /^\s*(?:[-*•]|\d+[.)]|\\item\b)/

/** Structured assertions: pipe-table rows, `&`-separated tabular rows, and list items. */
function structuredRowsOf(block) {
  return String(block).split('\n').map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => (MARKDOWN_ROW_RE.test(line) && !MARKDOWN_SEPARATOR_RE.test(line))
      || (line.includes('&') && line.length > 1)
      || LIST_ITEM_RE.test(line))
}

/**
 * Every unit a claim could be asserted in, tagged with the paragraph it sits in.
 *
 * Rows come first, so a table cell is never credited merely because its paragraph happens to cite
 * something: the finest unit that carries the value decides the association.
 */
function unitsOf(body) {
  const blocks = blocksOf(body)
  const units = []
  blocks.forEach((block, blockIndex) => {
    for (const row of structuredRowsOf(block)) {
      units.push({ kind: 'row', text: row, block, blockIndex })
    }
    for (const sentence of sentencesOf(block)) {
      units.push({ kind: 'sentence', text: sentence, block, blockIndex })
    }
    units.push({ kind: 'block', text: block, block, blockIndex })
  })
  return { blocks, units }
}

/** Nearest preceding paragraph that cites anything; `null` when there is none. */
function introducingBlock(blocks, blockIndex, page) {
  for (let index = blockIndex - 1; index >= 0; index -= 1) {
    const citations = citationsIn(blocks[index])
    if (citations.length === 0) continue
    return { blockIndex: index, citesPage: citations.some((citation) => citation.page === page) }
  }
  return null
}

function uncertaintyFigures() {
  return ANSWER_KEY.uncertainty?.figures ?? []
}

function mentionsFigure(text) {
  const figures = uncertaintyFigures()
  if (figures.length === 0) return false
  const escaped = figures.map((figure) => figure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(?<![\\d.])(${escaped.join('|')})(?![\\d.])`).test(String(text))
}

/** Confirmation left after every denial and every caveat has been removed. */
function confirmsUncertainly(text) {
  let stripped = String(text)
  for (const negation of NEGATION_RES) stripped = stripped.replace(negation, ' ')
  stripped = stripped.replace(CAVEAT_RE, ' ')
  CONFIRMATION_RE.lastIndex = 0
  return CONFIRMATION_RE.test(stripped)
}

function check(id, pass, detail, extra = {}) {
  const { status, ...rest } = extra
  return {
    id,
    pass: pass === true,
    status: status ?? (pass === true ? STATUS.PASS : STATUS.FAIL),
    detail,
    ...rest,
  }
}

/**
 * Deterministic grading of a model response against the answer key and the retrieved evidence.
 *
 * Only structural facts are asserted: presence, citation shape, page membership, label presence,
 * prohibited-course strings. Whether prose is *good* is a human judgement and is recorded in a
 * separate column of the report — this function never merges the two.
 *
 * @param text - the model's final response, verbatim and unedited.
 * @param context - `{ fileIds, retrievedPages, retrievedTextByPage, sourceRelativePath }`.
 * @returns `{ checks, citations, covered_pages }`.
 */
export function gradeNote(text, context) {
  // FO-7: LaTeX escapes `_` as `\_`, so a well-formed .tex artifact literally contains
  // `f\_bfc…` and `01\_Lectures/…`. Identifiers are compared after undoing that escape — a note
  // must not be penalised for obeying the syntax of the format it was asked to produce. The
  // unescaping runs before any pattern is matched, so citations and paths are read the way a
  // reader of the compiled document would read them.
  const body = String(text ?? '').replace(/\\_/g, '_')
  const citations = [...body.matchAll(CITATION_RE)]
    .map((match) => ({ file_id: match[1].trim(), page: Number(match[2]), raw: match[0] }))
  const pages = new Set(citations.map((citation) => citation.page))
  const { blocks, units } = unitsOf(body)
  const checks = []

  const badFileIds = citations.filter((citation) => !context.fileIds.includes(citation.file_id))
  checks.push(check(
    'G1-citation-file-id',
    citations.length > 0 && badFileIds.length === 0,
    citations.length === 0
      ? 'no [source: …, page N] citation was produced'
      : badFileIds.length === 0
        ? `${citations.length} citation(s), all naming the registered file id`
        : `citations naming an unregistered file id: ${JSON.stringify(badFileIds)}`,
  ))

  const badPages = citations.filter((citation) => !Number.isInteger(citation.page)
    || citation.page < 1 || citation.page > PDF_PAGES || !context.retrievedPages.includes(citation.page))
  checks.push(check(
    'G2-citation-page-is-retrieved',
    citations.length > 0 && badPages.length === 0,
    citations.length > 0 && badPages.length === 0
      ? `every cited page is inside retrieved pages ${JSON.stringify(context.retrievedPages)}`
      : `citations outside retrieved coverage: ${JSON.stringify(badPages)}`,
  ))

  // ---- G3: the claim and its citation have to be the *same* statement ---------------------
  //
  // The old predicate asked two independent questions — "is the answer present anywhere" and
  // "does a citation to the right page exist anywhere" — so a correct-page citation in an
  // unrelated bibliography rescued every wrong-page claim in the document. The association is now
  // made on the statement that actually carries the answer, at three granularities, and the
  // granularity is recorded so a weaker association is never reported as a strong one.
  const unmet = []
  const review = []
  for (const item of ANSWER_KEY.direct) {
    const anchors = item.anchors ?? []
    const pageText = context.retrievedTextByPage[item.page] ?? ''
    const anchorOnPage = anchors.some((anchor) => pageText.includes(anchor))
    const carriers = units.filter((unit) => claimMatches(unit.text, item).complete)
    if (carriers.length === 0) {
      const partial = units.filter((unit) => claimMatches(unit.text, item).present)
      unmet.push(partial.length === 0
        ? { id: item.id, reason: 'claim-absent', expected: item.expected }
        : {
          id: item.id,
          reason: 'answer-value-only-partially-associated',
          expected: item.expected,
          value_patterns: item.value_patterns ?? [],
          statements: partial.slice(0, 4).map((unit) => ({ kind: unit.kind, text: unit.text.slice(0, 160) })),
        })
      continue
    }
    if (!anchorOnPage) {
      unmet.push({
        id: item.id,
        reason: 'cited-page-lacks-the-source-anchor',
        page: item.page,
        anchors,
      })
      continue
    }

    let verdict = null
    const misattributed = []
    let uncitedNearby = 0
    for (const unit of carriers) {
      const own = citationsIn(unit.text)
      const citedPages = [...new Set(own.map((citation) => citation.page))].sort((a, b) => a - b)
      // An unambiguous statement: the answer appears in a sentence (or table row, or list item)
      // that cites one page, and that page is the claim's. A paragraph that cites several pages
      // does not say which of them this row belongs to, so it is worth less than it looks.
      if (citedPages.length === 1 && citedPages[0] === item.page) {
        verdict = { tier: 'unit', kind: unit.kind, text: unit.text }
        break
      }
      // The value and the citation sit in the same paragraph but not in an unambiguous statement
      // of their own — the shape a compiled tabular produces, where the row carries the number and
      // the paragraph carries several sources. Real, paragraph-granular, and weaker than an
      // unambiguous citation: it is recorded as a review item, never promoted to a pass.
      if (citedPages.includes(item.page)) {
        if (verdict === null) {
          verdict = {
            tier: 'paragraph',
            kind: unit.kind,
            text: unit.text,
            cited_pages: citedPages,
          }
        }
        continue
      }
      if (own.length > 0) {
        misattributed.push({ kind: unit.kind, text: unit.text, pages: citedPages })
        continue
      }
      // The value stands in a statement that cites nothing, so the page can only come from a
      // neighbouring paragraph. That is a real association and a weak one: it is recorded as a
      // review item rather than promoted to a pass.
      const introduced = introducingBlock(blocks, unit.blockIndex, item.page)
      if (introduced !== null && introduced.citesPage) {
        if (verdict === null) {
          verdict = {
            tier: 'introducing-block', kind: unit.kind, text: unit.text, block: introduced.blockIndex,
          }
        }
        continue
      }
      uncitedNearby += 1
    }

    if (verdict?.tier === 'unit') continue
    if (verdict !== null) {
      review.push({ id: item.id, ...verdict, anchors })
      continue
    }
    unmet.push({
      id: item.id,
      reason: misattributed.length > 0 ? 'cited-on-the-wrong-page' : 'no-citation-near-the-claim',
      page: item.page,
      cited_pages: misattributed.flatMap((entry) => entry.pages),
      uncited_statements: uncitedNearby,
    })
  }
  const g3Pass = unmet.length === 0 && review.length === 0
  checks.push(check(
    'G3-direct-claims-cited-on-their-page',
    g3Pass,
    g3Pass
      ? `all ${ANSWER_KEY.direct.length} direct claims carry a citation to the page the key records, in the statement that states them`
      : unmet.length > 0
        ? `unmet direct claims: ${JSON.stringify(unmet)}`
        : `claims whose page is only carried by a neighbouring paragraph: ${JSON.stringify(review)}`,
    {
      unmet,
      review,
      status: g3Pass ? STATUS.PASS : (unmet.length === 0 ? STATUS.REVIEW : STATUS.FAIL),
    },
  ))

  checks.push(check(
    'G4-inferred-and-supplemental-labelled',
    /推断/.test(body) && /补充/.test(body) && /材料原文引用/.test(body),
    'the response must separate 材料原文引用 / 推断 / 补充 labelling',
  ))

  // ---- G5: a caveat counts only where the figures are stated -----------------------------
  //
  // The old predicate accepted any uncertainty marker anywhere in the document as covering any
  // statement of the unverified figures, so a marker about page 4 excused a confident assertion
  // about page 3. The unit of assessment is now the paragraph that states the figures, and
  // confirmation *of those figures* is a contradiction of the source's own label wherever it
  // appears.
  const figureBlocks = blocks.filter((block) => mentionsFigure(block))
  const contradictory = []
  for (const unit of units) {
    if (!mentionsFigure(unit.text)) continue
    if (!confirmsUncertainly(unit.text)) continue
    contradictory.push({ kind: unit.kind, text: unit.text.slice(0, 240) })
  }
  const uncaveated = figureBlocks
    .filter((block) => !CAVEAT_RE.test(block))
    .map((block) => block.slice(0, 240))
  CAVEAT_RE.lastIndex = 0

  const g5Pass = contradictory.length === 0 && uncaveated.length === 0
  checks.push(check(
    'G5-no-unsupported-certainty',
    g5Pass,
    g5Pass
      ? figureBlocks.length === 0
        ? 'the labelled-uncertainty figures are not restated in the response'
        : 'every statement of the labelled-uncertainty figures carries a caveat in that same statement'
      : contradictory.length > 0
        ? `the labelled-uncertainty figures are confirmed outright: ${JSON.stringify(contradictory)}`
        : `statements of the labelled-uncertainty figures with no caveat in the statement: ${JSON.stringify(uncaveated)}`,
    {
      status: g5Pass ? STATUS.PASS : (contradictory.length > 0 ? STATUS.FAIL : STATUS.REVIEW),
      ...(contradictory.length > 0 ? { contradictory } : {}),
      ...(uncaveated.length > 0 ? { review: uncaveated } : {}),
      figures: uncertaintyFigures(),
    },
  ))

  const foreignCourses = [...new Set(
    [...body.matchAll(/\b[A-Z]{2,5}\d{3,4}\b/g)].map((match) => match[0]).filter((code) => code !== COURSE_CODE),
  )]
  // FO-4: the registered source may be named by its full relative path, by its basename, or by
  // its file id — all three denote the one registered file. Only a path that is neither is an
  // invented source.
  const registeredPath = context.sourceRelativePath ?? SOURCE_RELATIVE_PATH
  const registeredBase = registeredPath.split('/').pop()
  const foreignSources = [...new Set(
    [...body.matchAll(/\b[\w./-]+\.pdf\b/g)].map((match) => match[0])
      .filter((found) => found !== registeredPath && found !== registeredBase),
  )]
  checks.push(check(
    'G6-no-invented-course-or-source',
    foreignCourses.length === 0 && foreignSources.length === 0,
    foreignCourses.length === 0 && foreignSources.length === 0
      ? `only the bound course (${COURSE_CODE}) and the registered source are named`
      : `invented course(s) ${JSON.stringify(foreignCourses)} / source(s) ${JSON.stringify(foreignSources)}`,
  ))

  const covered = [...pages].sort((a, b) => a - b)
  checks.push(check(
    'G7-declared-coverage-is-real',
    covered.every((page) => context.retrievedPages.includes(page)),
    `declared coverage ${JSON.stringify(covered)} is inside retrieved ${JSON.stringify(context.retrievedPages)}`,
  ))

  checks.push(check(
    'G8-uncertainty-carried-through',
    /UNCERTAINTY|UNVERIFIED|未确认|未验证|不确定|存疑/.test(body),
    "the response repeats the source's uncertainty label rather than dropping it",
  ))

  return { checks, citations, covered_pages: covered }
}
