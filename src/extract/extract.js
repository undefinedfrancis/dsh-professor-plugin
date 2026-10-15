/**
 * Document extraction (M8).
 *
 * Reads a source file into text through the filesystem gateway (never raw `node:fs`), choosing a
 * backend from the probed capability map. Every outcome is explicit:
 *
 * - `{ status: 'extracted' }` — full text for a supported format;
 * - `{ status: 'unsupported', reason }` — no backend, or a format this plugin deliberately does
 *   not read (images, opaque containers); the caller records `unsupported` rather than `pending`;
 * - `{ status: 'failed', reason }` — the backend exists but rejected this particular file.
 *
 * A backend may return `{ text, pages }` instead of a bare string. `pages` is an array of
 * `{ page?, slide?, text }` (1-based) and is the only way a coordinate reaches a chunk: when the
 * backend reports no pages, `pages` stays `null` and provenance simply omits `page` rather than
 * guessing a number (v3 §15.2: only known fields are included).
 *
 * Page texts are normalised **individually** and then joined, so the joined document contains each
 * page's text verbatim. That is what lets the chunker locate a page boundary by search instead of
 * approximating it — the coordinate a chunk cites is therefore derived from the real page text, not
 * from a line-count guess.
 *
 * Out-of-scope rules honoured here:
 * - **no OCR**: a scanned PDF or an image has no text layer and the plugin wires no OCR engine, so it
 *   is `unsupported` with an explicit reason — never a partial read passed off as the document;
 * - **no whole-course reads**: extraction is per file, and the caller decides what to pass;
 * - **source material is read-only**: nothing here writes.
 *
 * @module dsh-professor-spike/src/extract/extract
 */

import { planExtraction } from './capabilities.js'

/** Hard ceiling on extracted text, so one pathological file cannot exhaust a context window. */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024

function fail(status, reason, extra = {}) {
  return { status, reason, ...extra }
}

/** UTF-8 text with a tolerant replacement for invalid sequences. */
function decodeText(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/**
 * Strip a UTF-8 BOM, which several text exporters prepend and which would otherwise show up as a
 * stray character at the head of every chunk.
 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

/**
 * Read one file's text.
 *
 * @param options.gateway - filesystem gateway.
 * @param options.target - resolved target of the file.
 * @param options.extension - lower-case extension without a dot.
 * @param options.capabilities - probed capability map.
 * @param options.signal - cancellation.
 * @returns `{ status, text?, extractor?, reason?, bytes? }`.
 */
export async function extractFile(options) {
  const { gateway, target, extension, capabilities, signal } = options
  const plan = planExtraction({ extension, capabilities })

  if (!plan.supported) return fail('unsupported', plan.reason, { extractor: null, family: plan.family })

  if (plan.family === 'text') {
    try {
      const bytes = await gateway.readBytes(target, signal, MAX_TEXT_BYTES)
      return {
        status: 'extracted',
        extractor: plan.extractor,
        bytes: bytes.byteLength,
        text: stripBom(decodeText(bytes)),
      }
    } catch (error) {
      if (error?.code === 'FS_TOO_LARGE' || /too large/i.test(String(error?.message))) {
        return fail('failed', `file exceeds the ${MAX_TEXT_BYTES}-byte extraction limit`, { extractor: plan.extractor })
      }
      return fail('failed', `could not read text: ${error.message}`, { extractor: plan.extractor })
    }
  }

  // Non-text backends need a command runner, which the caller supplies (the Harness shell
  // capability in production, a stub in tests). Without one there is no honest way to extract.
  const run = options.run
  if (typeof run !== 'function') {
    return fail('unsupported', 'no command runner available for this format in this context', { extractor: plan.extractor })
  }

  try {
    const result = await run({ plan, target, extension, signal, spelling: options.spelling })
    if (result === null || result === undefined) {
      return fail('failed', 'the extraction backend returned no output', { extractor: plan.extractor })
    }
    if (typeof result === 'object' && result.status !== undefined) return result
    if (typeof result === 'object' && typeof result.text === 'string') {
      // Structured backend: text plus per-page coordinates (or `pages: null` when unknown).
      const pages = Array.isArray(result.pages)
        ? result.pages
          .map((entry) => ({
            page: Number.isInteger(entry?.page) && entry.page >= 1 ? entry.page : null,
            slide: Number.isInteger(entry?.slide) && entry.slide >= 1 ? entry.slide : null,
            text: normalizeForChunking(entry?.text ?? ''),
          }))
          .filter((entry) => entry.text.length > 0 && (entry.page !== null || entry.slide !== null))
        : []
      if (pages.length > 0) {
        return {
          status: 'extracted',
          extractor: plan.extractor,
          text: pages.map((page) => page.text).join('\n\n'),
          pages,
          bytes: result.bytes ?? null,
          ...(Array.isArray(result.notes) ? { notes: result.notes } : {}),
          ...(Array.isArray(result.truncated) && result.truncated.length > 0 ? { truncated: result.truncated } : {}),
        }
      }
      return {
        status: 'extracted',
        extractor: plan.extractor,
        text: stripBom(result.text),
        pages: null,
        bytes: result.bytes ?? null,
        ...(Array.isArray(result.notes) ? { notes: result.notes } : {}),
        ...(Array.isArray(result.truncated) && result.truncated.length > 0 ? { truncated: result.truncated } : {}),
      }
    }
    return { status: 'extracted', extractor: plan.extractor, text: stripBom(String(result)), pages: null }
  } catch (error) {
    return fail('failed', `extraction backend failed: ${error.message}`, { extractor: plan.extractor })
  }
}

/**
 * Normalise extracted text for chunking: normalise newlines, drop trailing whitespace per line,
 * and collapse runs of blank lines. This keeps heading detection and chunk boundaries stable
 * across platforms and exporters.
 *
 * @param text - raw extracted text.
 * @returns the normalised text.
 */
export function normalizeForChunking(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
