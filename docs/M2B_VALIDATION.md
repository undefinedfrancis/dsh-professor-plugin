# Narrow model-table validation

The reusable executor is `tools/verify-m2b-model.mjs`. It is included in public source and the
package. Historical evidence and compatibility wrappers remain local under `docs/qa/`.

Run `node tools/verify-m2b-model.mjs --help` to inspect the interface. On the supported Mac host,
run the executor with the Harness executable in Node mode so its bundled modules are accessible.
Pass `--evidence-dir=<prepared-run-directory>` explicitly. Use a new run directory containing
the reviewed preparation evidence and boundary decision; preserve original model outputs, PDFs,
counters and authorization records. Do not run a new paid test in a historical evidence directory.

The default is zero paid requests. A zero-cost readiness check may use historical preparation as
input when `--readiness-out=<new-file>` points outside its evidence directory. Paid mode requires
`--allow-model-calls` and a fresh direct human grant scoped to the block with a numeric attempt
budget. A JSON record or this document does not independently authorize spending.

Select `--only=M2b` for the unfinished table case. The flags `--instruction-mode=native` and
`--instruction-mode=supplied-skill-text` are accepted and recorded as different modes. Native
readiness proves assembled sections, reachable skill bodies and offered tools; only a model run
can prove the model actually loads and follows those skills.

Each request is charged before it is sent. Its output allowance is 8,000 tokens. Finish reason,
usage, allowance and stream exceptions are persisted, including failures while opening or reading
the stream. The entire returned tool-call batch must have valid arguments, offered tool names and
a tool-calls finish reason before any operation executes. Partial responses are incomplete.

Grading uses readable model-created files only, never the chat reply. Compilation and rendering
facts are bound to the case that created the compiled artifact; one note's PDF cannot count as
another note's compilation. Rendering is not visual acceptance. Inspect the exact PDF and record
its hash before deciding whether the four-column table, values and citations were delivered.

The executor currently starts a fresh workspace and conversation. **It does not replay historical
retrieval.** The previous four-attempt proposal relied on replay and is not supported by this
implementation. A fresh native run must budget for skill loading, retrieval, creation, read-back,
editing and a concluding model response. A provisional ceiling of 8–12 attempts is a planning
estimate, not a promise or authorization; agree a numeric cap with the owner before running.
Production compilation and rendering are deterministic post-processing and do not themselves
consume model requests. Stop at the granted cap and preserve incomplete outcomes.

Offline preparation does not close FO-8, the browser matrix, the ordered Mac release gate or the
final audit. No paid retest has been performed as part of this repair.
