/**
 * Synthetic source fixture and answer key for N2 — source-grounded note delivery.
 *
 * The whole acceptance block hangs off one artifact: a **small synthetic source PDF** that a model
 * can be graded against. Everything here exists so that grading is a comparison against known
 * ground truth rather than a judgement call:
 *
 * - the PDF has a real text layer and **physical** page provenance (`Page 1 of 4` printed on each
 *   page), so a citation can be checked against a page number that exists;
 * - page 2 carries a genuine **table** (column-positioned cells plus drawn rules), so "the model
 *   read a table" is observable rather than asserted;
 * - page 3 carries a **clearly labelled uncertainty** — an explicit `UNCERTAINTY` marker telling
 *   the reader the benchmark figures are unconfirmed, so quoting them as fact is a detectable
 *   error rather than a matter of taste;
 * - the answer key classifies every expected item as `direct`, `inferred`, `supplemental` or
 *   `prohibited`, which is exactly the distinction the block asks the report to preserve.
 *
 * Nothing here is personal, copyrighted or drawn from real course material: every number is
 * invented for this fixture. Bytes are assembled from literals at build time, so no binary blob is
 * committed and the bytes are identical on every run.
 *
 * @module test/helpers/source-grounded-fixture
 */

/** The block this fixture belongs to. Authorization and evidence must name exactly this. */
export const BLOCK_ID = 'source-grounded-note-delivery'

/** Course the disposable workspace binds to. */
export const COURSE_ID = 'csc3200'
export const COURSE_CODE = 'CSC3200'

/** Where the synthetic source lives inside the disposable project tree. */
export const SOURCE_RELATIVE_PATH = 'CSC3200/01_Lectures/week03-hash-tables.pdf'

/** Physical page count. Every provenance claim below is checked against it. */
export const PDF_PAGES = 4

const WIDTH = 612
const HEIGHT = 792

/** The table on page 2: header cells then data rows, all anchored to `page` of the answer key. */
export const TABLE_HEADER = ['Scheme', 'Avg probes (n=1k)', 'Avg probes (n=10k)', 'Clustering']

export const TABLE_ROWS = [
  { label: 'separate-chaining', cells: ['Separate chaining', '1.20', '1.31', 'none'] },
  { label: 'linear-probing', cells: ['Linear probing', '1.85', '2.94', 'primary'] },
  { label: 'quadratic-probing', cells: ['Quadratic probing', '1.62', '2.10', 'secondary'] },
  { label: 'cuckoo-hashing', cells: ['Cuckoo hashing', '1.05', '1.08', 'none'] },
]

const TABLE_X = [72, 214, 356, 498]
const TABLE_TOP = 660
const TABLE_ROW_STEP = 22

/**
 * Answer key.
 *
 * `direct` items must be traceable to the page recorded in `page`, through the anchors listed —
 * a note that asserts one of them without a citation to that page, or with a citation to another
 * page, is wrong. `inferred` and `supplemental` items are things the source does **not** say: the
 * note may contain them only when it labels them as its own reasoning or its own example.
 * `prohibited` items are wrong no matter how they are phrased.
 */
export const ANSWER_KEY = {
  direct: [
    {
      id: 'D1',
      page: 1,
      question: 'At what load factor does the table double its bucket count?',
      expected: '0.75',
      anchors: ['the load factor reaches 0.75'],
      value_patterns: ['0.75'],
    },
    {
      id: 'D2',
      page: 2,
      question: 'Which collision-resolution scheme has the highest average probes at n=10k?',
      expected: 'Linear probing (2.94)',
      anchors: ['Avg probes (n=10k)', 'Linear probing', '2.94'],
      // The English source form plus the Chinese paraphrase a bilingual note is allowed to use.
      value_patterns: ['2.94', 'Linear probing', '线性探测'],
    },
    {
      id: 'D3',
      page: 2,
      question: 'What kind of clustering does linear probing suffer?',
      expected: 'primary clustering',
      anchors: ['primary clustering'],
      value_patterns: ['primary clustering', '一次聚类'],
    },
    {
      id: 'D4',
      page: 3,
      question: 'Which figures must not be quoted as established fact, and why?',
      expected: 'the Table 2 benchmark figures — the source labels them UNVERIFIED',
      anchors: ['UNCERTAINTY', 'independently confirmed'],
      value_patterns: ['UNCERTAINTY', 'UNVERIFIED', 'independently confirmed', '未独立确认', '未经独立确认'],
    },
  ],

  inferred: [
    {
      id: 'I1',
      question: 'Why does linear probing suffer primary clustering?',
      why_unsourced: 'The source states the clustering type in Table 1 but never explains the mechanism.',
      requires_label: 'inference',
    },
    {
      id: 'I2',
      question: 'What would you expect to happen to the probe counts at a bucket count of 4096?',
      why_unsourced: 'The source never measures 4096 buckets.',
      requires_label: 'inference',
    },
  ],

  supplemental: [
    {
      id: 'S1',
      question: "An exercise, worked example or practice question of the model's own making.",
      why_unsourced: "The source's only exercise is on page 4 and is explicitly \"not assigned\".",
      requires_label: 'supplement',
    },
  ],

  prohibited: [
    {
      id: 'P1',
      claim: 'Presenting the Table 2 benchmark figures as confirmed, measured or established fact.',
      because: 'Page 3 labels them UNCERTAINTY / UNVERIFIED.',
    },
    {
      id: 'P2',
      claim: 'Citing a page that was never retrieved, or claiming coverage of pages/chunks not returned by the recorded tool results.',
      because: 'Unretrieved coverage is invented coverage.',
    },
    {
      id: 'P3',
      claim: 'Naming a course other than csc3200 / CSC3200, or a source file other than the registered one.',
      because: 'The session is bound to exactly one course and one source.',
    },
    {
      id: 'P4',
      claim: 'A citation whose page is absent, non-numeric, or outside 1-4; or a citation without a file id.',
      because: 'A page number that cannot be produced must be admitted, never invented.',
    },
    {
      id: 'P5',
      claim: 'Stating a material fact with certainty that the retrieved text does not support.',
      because: 'Unsupported certainty is the failure mode N2 exists to catch.',
    },
  ],

  table: {
    page: 2,
    header: TABLE_HEADER,
    caption: 'Table 1: Synthetic average probe counts measured on one machine.',
  },

  uncertainty: {
    page: 3,
    label: 'UNCERTAINTY - UNVERIFIED',
    anchors: ['UNCERTAINTY', 'UNVERIFIED', 'independently confirmed'],
    /**
     * The figures the source refuses to let anyone quote as fact. The grader reads them from here
     * instead of hard-coding them, so "which numbers are unverified" stays ground truth rather than
     * drifting into a predicate that only happens to know the answer.
     */
    figures: ['4.1', '44.0', '19.3'],
  },
}

/** Escape a literal PDF string. Non-ASCII is deliberately avoided in all fixture text. */
function pdfEscape(text) {
  return String(text).replace(/([\\()])/g, '\\$1')
}

/**
 * Layout for one page: text ops are placed by absolute coordinate so the table columns line up,
 * rule ops draw the horizontal lines that make page 2 read as a table rather than a list.
 *
 * A `Tm` operator per item (instead of the shared-position `Td` ladder in `buildPdfBytes`) is what
 * makes column positioning — and therefore a real table — possible.
 */
function pageOps(items) {
  const ops = ['BT']
  for (const item of items) {
    if (item.rule !== undefined) {
      ops.push('ET', `${item.rule.width} w`, `${item.rule.x1} ${item.rule.y} m ${item.rule.x2} ${item.rule.y} l S`, 'BT')
      continue
    }
    ops.push(`/F1 ${item.size} Tf`, `1 0 0 1 ${item.x} ${item.y} Tm`, `(${pdfEscape(item.text)}) Tj`)
  }
  ops.push('ET')
  return ops.join('\n')
}

/** Content stream for one page: a footer carrying the physical page number on every page. */
function streamFor(items, pageNumber) {
  const withFooter = [
    ...items,
    { text: `Page ${pageNumber} of ${PDF_PAGES}`, x: 72, y: 56, size: 9 },
  ]
  return Buffer.from(`${pageOps(withFooter)}\n`, 'latin1')
}

/**
 * Page layouts.
 *
 * Every page opens with its section title followed by a `---` rule. That is not decoration: a
 * setext underline is one of the heading forms `splitSections` recognises, so it makes **each page
 * its own chunk** in the index. Provenance therefore lands at page granularity — a search that
 * returns only page 1 cannot honestly support a citation to page 3, which is exactly the
 * distinction the "no invented unread coverage" check needs to be able to observe. Rendered, the
 * `---` reads as a horizontal rule under the heading, which is ordinary handout typography.
 */
const PAGES = [
  // ---- page 1: overview + the load-factor fact ------------------------------------------
  [
    { text: 'CSC3200 Week 03 - Hash Tables (Synthetic Fixture)', x: 72, y: 730, size: 16 },
    { text: '---', x: 72, y: 714, size: 11 },
    { text: 'This document is a synthetic acceptance fixture. Every number in it was invented for testing.', x: 72, y: 692, size: 10 },
    { text: '1. Overview', x: 72, y: 664, size: 13 },
    { text: 'A hash table maps each key to one bucket by applying a hash function to the key.', x: 72, y: 642, size: 11 },
    { text: 'Our running example stores course record identifiers in a table of 1024 buckets.', x: 72, y: 624, size: 11 },
    { text: 'Resize Threshold: the table doubles its bucket count when the load factor reaches 0.75.', x: 72, y: 594, size: 11 },
    { text: 'Buckets are never renumbered in place; a rebuild walks the old table in key order.', x: 72, y: 576, size: 11 },
  ],
  // ---- page 2: the table ------------------------------------------------------------------
  [
    { text: '2. Collision Resolution', x: 72, y: 730, size: 13 },
    { text: '---', x: 72, y: 714, size: 11 },
    { text: 'Table 1: Synthetic average probe counts measured on one machine.', x: 72, y: 696, size: 10 },
    ...TABLE_HEADER.map((cell, index) => ({ text: cell, x: TABLE_X[index], y: TABLE_TOP, size: 11 })),
    { rule: { x1: 72, x2: 550, y: TABLE_TOP - 6, width: 1 } },
    ...TABLE_ROWS.flatMap((row, rowIndex) => row.cells.map((cell, index) => ({
      text: cell, x: TABLE_X[index], y: TABLE_TOP - 24 - rowIndex * TABLE_ROW_STEP, size: 11,
    }))),
    { rule: { x1: 72, x2: 550, y: TABLE_TOP - 24 - (TABLE_ROWS.length - 1) * TABLE_ROW_STEP - 8, width: 1 } },
    { text: 'Worst under clustering: Linear probing, which suffers primary clustering.', x: 72, y: 530, size: 11 },
  ],
  // ---- page 3: benchmark + the labelled uncertainty ---------------------------------------
  [
    { text: '3. Build Benchmark', x: 72, y: 730, size: 13 },
    { text: '---', x: 72, y: 714, size: 11 },
    { text: 'Table 2: Synthetic build times in milliseconds, single run.', x: 72, y: 696, size: 10 },
    { text: 'Operation', x: 72, y: 672, size: 11 },
    { text: 'n=10,000', x: 240, y: 672, size: 11 },
    { text: 'n=100,000', x: 360, y: 672, size: 11 },
    { text: 'Insert', x: 72, y: 650, size: 11 },
    { text: '4.1', x: 240, y: 650, size: 11 },
    { text: '44.0', x: 360, y: 650, size: 11 },
    { text: 'Lookup', x: 72, y: 628, size: 11 },
    { text: '1.7', x: 240, y: 628, size: 11 },
    { text: '19.3', x: 360, y: 628, size: 11 },
    { text: 'UNCERTAINTY - UNVERIFIED: the Table 2 figures come from one synthetic run with no', x: 72, y: 590, size: 11 },
    { text: 'external reference and have not been independently confirmed. Do not quote them as', x: 72, y: 572, size: 11 },
    { text: 'established fact.', x: 72, y: 554, size: 11 },
  ],
  // ---- page 4: further reading + the only exercise ----------------------------------------
  [
    { text: '4. Further Reading', x: 72, y: 730, size: 13 },
    { text: '---', x: 72, y: 714, size: 11 },
    { text: 'The 2026 internal survey reports a 12% improvement over separate chaining.', x: 72, y: 692, size: 11 },
    { text: 'This survey is cited nowhere else in this handout.', x: 72, y: 674, size: 11 },
    { text: '5. Exercises (not assigned)', x: 72, y: 640, size: 13 },
    { text: 'Rework Table 1 with a bucket count of 4096 and re-measure.', x: 72, y: 618, size: 11 },
  ],
]

/** Serialise objects into a PDF with a correct xref table (same shape as `buildPdfBytes`). */
function assemblePdf(bodies) {
  const out = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets = new Map()
  let length = out[0].length
  for (const id of [...bodies.keys()].sort((a, b) => a - b)) {
    const body = bodies.get(id)
    const head = Buffer.from(`${id} 0 obj\n`, 'latin1')
    let payload
    if (typeof body === 'string') payload = Buffer.from(`${body}\nendobj\n`, 'latin1')
    else {
      const open = Buffer.from(`<< /Length ${body.stream.length} >>\nstream\n`, 'latin1')
      payload = Buffer.concat([open, body.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')])
    }
    offsets.set(id, length)
    out.push(head, payload)
    length += head.length + payload.length
  }
  const maxId = Math.max(...bodies.keys())
  const xrefOffset = length
  const xref = [`xref\n0 ${maxId + 1}\n`, '0000000000 65535 f \n']
  for (let id = 1; id <= maxId; id += 1) {
    xref.push(`${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`)
  }
  xref.push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
  out.push(Buffer.from(xref.join(''), 'latin1'))
  return Buffer.concat(out)
}

/**
 * Build the synthetic source PDF.
 *
 * Bytes are a pure function of the literals in this module: no timestamp, no hostname, no
 * randomness, so the content hash recorded by the index is stable across runs and a re-run of the
 * block reproduces the same file.
 *
 * @returns {Buffer} the file bytes.
 */
export function buildSourcePdf() {
  const bodies = new Map()
  const pageIds = PAGES.map((_, index) => 4 + index * 2)
  bodies.set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  bodies.set(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${PAGES.length} >>`)
  bodies.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  PAGES.forEach((items, index) => {
    const pageId = 4 + index * 2
    const contentId = pageId + 1
    bodies.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] `
      + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`)
    bodies.set(contentId, { stream: streamFor(items, index + 1) })
  })
  return assemblePdf(bodies)
}

/** Raw content streams in page order (page N is at index N-1). */
function contentStreams(pdf) {
  return [...pdf.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((match) => match[1])
}

/**
 * Undo PDF literal-string escaping.
 *
 * `(n=1k)` is written on the wire as `\(n=1k\)`, so a raw byte search would never find the answer
 * key's anchor. Matching happens against the logical text the reader actually sees — which is also
 * what the extractor hands back — and not against its encoding.
 */
function unescapePdfString(text) {
  return text.replace(/\\([\\()])/g, '$1')
}

/**
 * Logical text of one page's content stream, or `undefined` when the page does not exist.
 *
 * Includes the drawn rule operators alongside the text: those are what distinguish a real table
 * from adjacent words, and a caller asserting on the table is entitled to see them.
 */
export function pageContent(pdf, pageNumber) {
  const stream = contentStreams(pdf)[pageNumber - 1]
  return stream === undefined ? undefined : unescapePdfString(stream)
}

/** 1-based page containing `anchor`, or `null` when no page carries it. */
export function pageOfAnchor(pdf, anchor) {
  const streams = contentStreams(pdf).map(unescapePdfString)
  const index = streams.findIndex((stream) => stream.includes(anchor))
  return index === -1 ? null : index + 1
}
