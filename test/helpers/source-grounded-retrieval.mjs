/**
 * N2 — grading coverage must come from what the model was actually **handed**.
 *
 * The runner and the offline regrade used to build `retrievedPages` / `retrievedTextByPage` from
 * every indexed chunk. Indexed availability is not model retrieval: a page sitting in the index
 * that no tool call returned to this case was never seen by the model, so a citation to it is
 * invented unread coverage and must fail G2/G3 rather than pass.
 *
 * This module walks one case's recorded `tool_calls[]` and collects the text that a **successful**
 * `professor_search` or `professor_material_read` call actually put in front of the model. Failed
 * calls, other cases' calls, and index content that was never returned are all excluded by
 * construction — there is no index file here to fall back to.
 *
 * Pure: no I/O, no network, no model. The inputs are the verbatim records the runner already
 * stores, so this can be exercised for free and reused offline against the preserved paid runs.
 *
 * @module test/helpers/source-grounded-retrieval
 */

/** Tool names whose successful results carry source text. */
const RETRIEVAL_TOOLS = new Set(['professor_search', 'professor_material_read'])

/**
 * Pull the JSON envelope out of a `professor_material_read` result.
 *
 * The tool renders a human-readable header (`action: …`, `coverage: …`, `budget: …`) and then the
 * same payload as JSON, because that is what the model is actually given. `resultJson` in the
 * runner therefore returns `null` for these calls and the text is the record that matters.
 *
 * @returns the parsed envelope, or `null` when none is present.
 */
export function materialReadEnvelope(resultText) {
  const text = String(resultText ?? '')
  const start = text.indexOf('{')
  if (start === -1) return null
  for (let end = text.length; end > start; end -= 1) {
    const candidate = text.slice(start, end)
    if (!candidate.trimEnd().endsWith('}')) continue
    try {
      return JSON.parse(candidate)
    } catch {
      // keep shrinking until the JSON object parses
    }
  }
  return null
}

/** `{ page, text, file_id, kind }` for every source body a successful `material_read` returned. */
function fromMaterialRead(call) {
  const envelope = materialReadEnvelope(call.result_text)
  if (envelope === null) return []
  const fileId = [envelope?.source?.file_id, envelope?.source?.source?.file_id]
    .find((value) => typeof value === 'string') ?? null
  const blocks = Array.isArray(envelope?.content?.blocks) ? envelope.content.blocks : []
  const fromBlocks = blocks
    .filter((block) => Number.isInteger(Number(block?.page)) && typeof block?.text === 'string')
    .map((block) => ({
      page: Number(block.page),
      text: block.text,
      file_id: fileId,
      kind: 'body',
      origin: block.origin ?? null,
    }))
  if (fromBlocks.length > 0) return fromBlocks
  // `action: "plan"` returns bounded excerpts rather than bodies. The model was still shown them,
  // so they count as delivered — but as excerpts, so the report can tell the two apart.
  const perPage = Array.isArray(envelope?.plan?.per_page) ? envelope.plan.per_page : []
  return perPage
    .filter((entry) => Number.isInteger(Number(entry?.page)) && typeof entry?.excerpt === 'string')
    .map((entry) => ({
      page: Number(entry.page),
      text: entry.excerpt,
      file_id: fileId,
      kind: 'excerpt',
      origin: 'plan',
    }))
}

/** `{ page, text, file_id, kind }` for every chunk a successful `search` returned. */
function fromSearch(call) {
  const result = call.result
  if (result === null || typeof result !== 'object') return []
  const rows = Array.isArray(result.results) ? result.results : []
  return rows
    .filter((row) => Number.isInteger(Number(row?.page))
      && typeof row?.text === 'string' && row.text.length > 0)
    .map((row) => ({
      page: Number(row.page),
      text: row.text,
      file_id: typeof row.file_id === 'string' ? row.file_id : null,
      kind: 'chunk',
      chunk_id: typeof row.chunk_id === 'string' ? row.chunk_id : null,
    }))
}

/**
 * Collect the text one model case was actually handed.
 *
 * @param toolCalls - that case's `tool_calls[]`, verbatim: `{ name, args, isError, result, result_text }`.
 * @returns `{ deliveries, rejected, retrievedTextByPage, retrievedPages }`.
 *   `retrievedTextByPage` concatenates every delivered fragment for a page in delivery order, which
 *   is what the grader matches anchors against — the same text the model could read.
 */
export function collectDeliveredRetrieval(toolCalls) {
  const deliveries = []
  const rejected = []
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!RETRIEVAL_TOOLS.has(call?.name)) continue
    if (call.isError === true) {
      rejected.push({ name: call.name, args: call.args ?? null, reason: 'tool-call-failed' })
      continue
    }
    const extracted = call.name === 'professor_search' ? fromSearch(call) : fromMaterialRead(call)
    if (extracted.length === 0) {
      rejected.push({ name: call.name, args: call.args ?? null, reason: 'returned-no-source-text' })
      continue
    }
    for (const delivery of extracted) deliveries.push({ tool: call.name, ...delivery })
  }

  const retrievedTextByPage = {}
  for (const delivery of deliveries) {
    retrievedTextByPage[delivery.page] = retrievedTextByPage[delivery.page] === undefined
      ? delivery.text
      : `${retrievedTextByPage[delivery.page]}\n${delivery.text}`
  }
  const retrievedPages = Object.keys(retrievedTextByPage).map(Number).sort((a, b) => a - b)
  return { deliveries, rejected, retrievedTextByPage, retrievedPages }
}

/**
 * The grading context for one case, built only from what that case was handed.
 *
 * `fileIds` stays the **registered** file id — a citation naming an unregistered id is a different
 * failure (G1) and must not be masked by a delivery that happened to come from elsewhere. Pages are
 * filtered to that id when the delivery recorded one, so a stray hit on another source cannot widen
 * this case's coverage.
 *
 * @param toolCalls - the case's `tool_calls[]`.
 * @param options - `{ fileIds, sourceRelativePath }` from the registration, not from the index.
 */
export function gradingContextFromDelivery(toolCalls, { fileIds = [], sourceRelativePath = null } = {}) {
  const collected = collectDeliveredRetrieval(toolCalls)
  const registered = new Set(fileIds)
  const own = registered.size === 0
    ? collected.deliveries
    : collected.deliveries.filter((delivery) => delivery.file_id === null || registered.has(delivery.file_id))
  const retrievedTextByPage = {}
  for (const delivery of own) {
    retrievedTextByPage[delivery.page] = retrievedTextByPage[delivery.page] === undefined
      ? delivery.text
      : `${retrievedTextByPage[delivery.page]}\n${delivery.text}`
  }
  const retrievedPages = Object.keys(retrievedTextByPage).map(Number).sort((a, b) => a - b)
  return {
    fileIds: [...fileIds],
    retrievedPages,
    retrievedTextByPage,
    sourceRelativePath,
    deliveries: own,
    rejected: collected.rejected,
    derived_from: 'successful professor_search / professor_material_read results recorded for this case only',
  }
}
