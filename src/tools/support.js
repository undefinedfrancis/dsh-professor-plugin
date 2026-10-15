/**
 * Shared helpers for the model-facing tool definitions.
 *
 * @module dsh-professor-spike/src/tools/support
 */

/** Wrap a JSON payload as the single text part every Professor tool returns. */
export function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Build the `output` block for a tool whose schema is a plain object. */
export function jsonOutput(schema, render = renderJson) {
  return { schema, render }
}

/** A tool that takes no parameters at all. */
export const NO_PARAMETERS = { type: 'object', properties: {} }

/**
 * A "one of these JSON types" schema node the installed Harness accepts.
 *
 * The host validates every registered tool's `output.schema` against its own enforced JSON
 * Schema subset (`@deepseek-ai/dsh-tools` → `assertSupportedJsonSchema`) *before* the tool is
 * registered, and that subset is deliberately narrow: one scalar `type` string, or an
 * exact-one `oneOf`. It rejects JSON Schema type arrays outright
 * ("… .type must be a single type string (type arrays are not supported)") and has no
 * `nullable` keyword, so `type: ['string', 'null']` makes the whole composition fail to load.
 *
 * A field whose value may be one of several JSON types is therefore written as a `oneOf` over
 * disjoint branches. The branches never overlap, so the host's exact-one check accepts exactly
 * the listed types and still refuses everything else — the union semantics are preserved, not
 * relaxed. `oneOf` may not carry constraint siblings (`type`, `properties`, `required`,
 * `additionalProperties`, `items`, `enum`, `const`), which is why this helper returns a node
 * holding `oneOf` and nothing else.
 *
 * @param types - the accepted JSON types, in declaration order, e.g. `oneOfTypes('string', 'null')`.
 * @returns the host-accepted schema node.
 */
export function oneOfTypes(...types) {
  return { oneOf: types.map((type) => ({ type })) }
}
