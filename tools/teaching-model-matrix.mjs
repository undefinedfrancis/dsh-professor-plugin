/**
 * The authoritative case inventory for the live-model teaching acceptance matrix.
 *
 * Shared by the runner (`tools/verify-teaching-model.mjs`) and the offline rebuild
 * (`tools/rebuild-teaching-aggregate.mjs`) so that "is the matrix complete?" is answered against a
 * declared required set rather than against whatever subset a filtered invocation happened to
 * supply. The runner asserts at runtime that its own case definitions match this list.
 *
 * @module tools/teaching-model-matrix
 */

/** The eight required MATRIX.md cases, in matrix order. */
export const EXPECTED_CASE_IDS = Object.freeze([
  'S1-exam-no-evidence',
  'S2-exam-with-evidence',
  'S3-complete-explanation-socratic',
  'S4-hint-only',
  'S5-declined-check',
  'S6-self-report',
  'S7-hint-assisted',
  'S8-independent-variation',
])
