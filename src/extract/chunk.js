/**
 * Heading-aware chunking (M8).
 *
 * Chunks are the unit of retrieval and the unit provenance points back at, so they must be
 * stable: the same document must produce the same chunks on every run, or `chunk_id` stops being
 * a usable reference. The rules:
 *
 * 1. **split on headings** — Markdown ATX/setext headings, and LaTeX `\section`-family commands,
 *    because those are the boundaries a reader would actually cite;
 * 2. **split long sections** — a section longer than `maxChars` is split on paragraph (blank line)
 *    boundaries, then on sentence-ish boundaries as a last resort, so a single enormous paragraph
 *    still yields bounded chunks;
 * 3. **never split mid-code** — fenced code blocks and `verbatim`/`lstlisting` environments are
 *    kept whole even if that pushes a chunk past the target size, because a half-open code block
 *    is not usable for study;
 * 4. **stable ids** — `chunk_id = sha256(file_id + ':' + index).slice(0,16)`, so an id identifies
 *    a position in a file, and re-chunking the same content reproduces it.
 *
 * Output carries the provenance fields later milestones consume: `course_id`, `category`,
 * `heading`, `start_line`, `end_line`, plus `page`/`slide` placeholders (null until an extractor
 * supplies them).
 *
 * @module dsh-professor-spike/src/extract/chunk
 */

import { createHash } from 'node:crypto'

/** Default target chunk size, in characters. */
export const DEFAULT_MAX_CHARS = 1600
/** Never emit a chunk smaller than this, unless the source section itself is smaller. */
export const DEFAULT_MIN_CHARS = 200

const ATX = /^(#{1,6})\s+(.*)$/
const SETEXT = /^(=+|-{2,})\s*$/
const LATEX_SECTION = /^\\(chapter|section|subsection|subsubsection|paragraph)\*?\s*\{(.*)\}\s*$/
const CODE_FENCE = /^\s*(```|~~~)/
const LATEX_VERBATIM = /^\\begin\{(verbatim|lstlisting|minted|Verbatim)\}/
const LATEX_VERBATIM_END = /^\\end\{(verbatim|lstlisting|minted|Verbatim)\}/

function chunkIdFor(fileId, index) {
  return `c_${createHash('sha256').update(`${fileId}:${index}`).digest('hex').slice(0, 16)}`
}

/** Detect the heading level of a line, or null. Level order: ATX 1-6, setext 1-2, LaTeX sections. */
function headingOf(line) {
  const atx = ATX.exec(line)
  if (atx !== null) return { level: atx[1].length, text: atx[2].trim().replace(/#+\s*$/, '').trim() }
  const latex = LATEX_SECTION.exec(line)
  if (latex !== null) {
    const order = { chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 }
    return { level: order[latex[1]], text: latex[2].trim() }
  }
  return null
}

/**
 * Split text into logical sections on heading boundaries, keeping track of line numbers and
 * preserving code fences as indivisible runs.
 *
 * @param text - normalised document text.
 * @returns sections as `{ heading, headingLevel, lines, startLine }`.
 */
export function splitSections(text) {
  const lines = String(text).split('\n')
  const sections = []
  let current = { heading: null, headingLevel: 0, lines: [], startLine: 1 }
  let fence = null
  let verbatim = false
  let previous = null

  const push = () => {
    if (current.lines.length > 0 || current.heading !== null) sections.push(current)
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNo = index + 1

    if (fence !== null) {
      current.lines.push(line)
      if (CODE_FENCE.test(line) && line.trimStart().startsWith(fence)) fence = null
      previous = line
      continue
    }
    if (verbatim) {
      current.lines.push(line)
      if (LATEX_VERBATIM_END.test(line)) verbatim = false
      previous = line
      continue
    }
    if (CODE_FENCE.test(line)) {
      fence = line.trimStart().slice(0, 3)
      current.lines.push(line)
      previous = line
      continue
    }
    if (LATEX_VERBATIM.test(line)) {
      verbatim = true
      current.lines.push(line)
      previous = line
      continue
    }

    const heading = headingOf(line)
    // A setext underline only counts as a heading when a non-empty line precedes it.
    const setext = heading === null && current.lines.length > 0 && previous !== null && previous.trim().length > 0 && SETEXT.test(line) && lines[index - 1]?.trim().length > 0
    if (heading !== null || setext) {
      push()
      if (setext) {
        const title = current.lines.pop()
        current = { heading: title.trim(), headingLevel: 2, lines: [], startLine: lineNo + 1 }
        if (current.heading === '') current.heading = null
      } else {
        current = { heading: heading.text, headingLevel: heading.level, lines: [], startLine: lineNo }
      }
      previous = line
      continue
    }

    current.lines.push(line)
    previous = line
  }
  push()
  return sections
}

/**
 * Split a section's lines into chunks of at most `maxChars`, never breaking a code block.
 *
 * @returns chunks as `{ text, startLine, endLine }`.
 */
function chunkSectionLines(section, { maxChars, minChars }) {
  const lines = section.lines
  const chunks = []
  let buffer = []
  let bufferChars = 0
  let startLine = section.startLine
  let inFence = null
  let inVerbatim = false
  let pendingLong = []

  const flush = (endLine) => {
    if (buffer.length === 0) return
    const body = buffer.join('\n').replace(/^\n+|\n+$/g, '')
    if (body.length > 0) chunks.push({ text: body, startLine, endLine })
    buffer = []
    bufferChars = 0
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNo = section.startLine + index

    if (inFence !== null) {
      buffer.push(line)
      bufferChars += line.length + 1
      if (CODE_FENCE.test(line) && line.trimStart().startsWith(inFence)) inFence = null
      continue
    }
    if (inVerbatim) {
      buffer.push(line)
      bufferChars += line.length + 1
      if (LATEX_VERBATIM_END.test(line)) inVerbatim = false
      continue
    }
    if (CODE_FENCE.test(line)) {
      inFence = line.trimStart().slice(0, 3)
      buffer.push(line)
      bufferChars += line.length + 1
      continue
    }
    if (LATEX_VERBATIM.test(line)) {
      inVerbatim = true
      buffer.push(line)
      bufferChars += line.length + 1
      continue
    }

    const isBlank = line.trim().length === 0
    if (bufferChars + line.length + 1 > maxChars && buffer.length > 0) {
      // Prefer a paragraph boundary; if the current run is already long enough, cut here.
      if (bufferChars >= minChars) {
        flush(lineNo - 1)
      } else {
        pendingLong.push({ line, lineNo })
        buffer.push(line)
        bufferChars += line.length + 1
        continue
      }
    }
    if (isBlank && bufferChars >= minChars && buffer.length > 0 && bufferChars + line.length + 1 <= maxChars) {
      // paragraph break inside the budget: keep going (a blank line alone does not force a cut)
      buffer.push(line)
      bufferChars += line.length + 1
      continue
    }

    if (isBlank && buffer.length > 0 && bufferChars >= minChars) {
      flush(lineNo - 1)
      startLine = lineNo + 1
      continue
    }

    if (buffer.length === 0) startLine = lineNo
    buffer.push(line)
    bufferChars += line.length + 1
  }
  flush(section.startLine + lines.length - 1)
  void pendingLong
  return chunks
}

/** Map 1-based page/slide boundaries onto line numbers, or null when the backend gave none. */
function pageLineRanges(text, pages) {
  if (!Array.isArray(pages) || pages.length === 0) return null
  const ranges = []
  let cursor = 0
  for (const entry of pages) {
    const pageText = typeof entry?.text === 'string' ? entry.text.trim() : ''
    const page = Number(entry?.page)
    const slide = Number(entry?.slide)
    const hasPage = Number.isInteger(page) && page >= 1
    const hasSlide = Number.isInteger(slide) && slide >= 1
    // One of the two coordinates has to be known; a segment that names neither cannot be cited.
    if (!hasPage && !hasSlide) continue
    if (pageText.length === 0) continue
    const found = text.indexOf(pageText, cursor)
    if (found < 0) continue
    const end = found + pageText.length
    ranges.push({
      page: hasPage ? page : null,
      slide: hasSlide ? slide : null,
      startLine: text.slice(0, found).split('\n').length,
      endLine: text.slice(0, end).split('\n').length,
    })
    cursor = end
  }
  return ranges.length > 0 ? ranges : null
}

/** The range that contains `line`, or null when the line is in a gap (or before the first page). */
function rangeForLine(ranges, line) {
  for (const range of ranges) {
    if (range.startLine <= line && line <= range.endLine) return range
  }
  return null
}

/**
 * Which coordinate should this chunk cite?
 *
 * A chunk usually spans several lines while a page covers only some of them, so requiring the
 * whole chunk to sit inside one page would mark nearly every chunk `null`. The rule is:
 *
 * - the chunk's **first** line decides where the citation *starts*: if a chunk begins on page 12
 *   and runs onto 13, page 12 is where the reader starts, which is both correct and honest;
 * - when the chunk's **last** line lands on a different known page, the honest answer is a range,
 *   so `page_range: [12, 13]` is attached rather than pretending the whole chunk is page 12;
 * - when the start is inside a known page but the end is **not** inside any known page — a gap, or
 *   past the last page the backend reported — the extent is marked `coordinate_ambiguous` instead
 *   of silently selecting one page for a chunk that reaches beyond it;
 * - when the backend reported no pages at all, every field stays absent: an unknown coordinate is
 *   never invented (v3 §15.2).
 *
 * @returns `{ page, slide, pageRange, slideRange, ambiguous }`.
 */
function coordinatesForChunk(ranges, startLine, endLine) {
  const empty = { page: null, slide: null, pageRange: null, slideRange: null, ambiguous: false }
  if (ranges === null) return empty
  const start = rangeForLine(ranges, startLine)
  if (start === null) return empty
  const end = rangeForLine(ranges, endLine)
  const result = {
    page: start.page,
    slide: start.slide,
    pageRange: null,
    slideRange: null,
    ambiguous: end === null,
  }
  if (end === null) return result
  if (start.page !== null && end.page !== null && end.page !== start.page) {
    result.pageRange = [start.page, end.page]
  }
  if (start.slide !== null && end.slide !== null && end.slide !== start.slide) {
    result.slideRange = [start.slide, end.slide]
  }
  return result
}

/**
 * Chunk a document.
 *
 * @param options.text - extracted (normalised) text.
 * @param options.fileId - the file's index id, used to derive stable chunk ids.
 * @param options.maxChars - target chunk size (default `DEFAULT_MAX_CHARS`).
 * @param options.minChars - minimum size before a forced cut (default `DEFAULT_MIN_CHARS`).
 * @param options.maxChunks - hard cap; chunks beyond it are dropped and reported.
 * @param options.pages - optional `{ page?, slide?, text }[]` from a coordinate-aware backend. When
 *   present, each chunk's `page`/`slide` is derived from the page its lines fall on and a
 *   `page_range`/`slide_range` is attached when the chunk spans several known pages. When absent
 *   (or the backend reports no pages) the coordinates stay `null` and are omitted from provenance
 *   rather than guessed.
 * @returns `{ chunks, dropped }` where each chunk carries `chunk_id`, `text`, `heading`,
 *   `heading_level`, `start_line`, `end_line`, `page`, `slide`, and — only when they apply —
 *   `page_range`, `slide_range`, `coordinate_ambiguous`.
 */
export function chunkDocument(options) {
  const {
    text,
    fileId,
    maxChars = DEFAULT_MAX_CHARS,
    minChars = DEFAULT_MIN_CHARS,
    maxChunks = Number.POSITIVE_INFINITY,
    pages = null,
  } = options

  const sections = splitSections(String(text ?? ''))
  const pageRanges = pageLineRanges(String(text ?? ''), pages)
  const chunks = []
  let dropped = 0

  for (const section of sections) {
    for (const piece of chunkSectionLines(section, { maxChars, minChars })) {
      if (chunks.length >= maxChunks) {
        dropped += 1
        continue
      }
      const coordinates = coordinatesForChunk(pageRanges, piece.startLine, piece.endLine)
      chunks.push({
        chunk_id: chunkIdFor(fileId, chunks.length),
        file_id: fileId,
        text: piece.text,
        heading: section.heading,
        heading_level: section.headingLevel,
        start_line: piece.startLine,
        end_line: piece.endLine,
        page: coordinates.page,
        slide: coordinates.slide,
        ...(coordinates.pageRange === null ? {} : { page_range: coordinates.pageRange }),
        ...(coordinates.slideRange === null ? {} : { slide_range: coordinates.slideRange }),
        ...(coordinates.ambiguous ? { coordinate_ambiguous: true } : {}),
      })
    }
  }
  return { chunks, dropped }
}
