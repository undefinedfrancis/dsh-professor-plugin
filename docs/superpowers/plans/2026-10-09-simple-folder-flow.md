# Simple folder and course flow

User-requested design: two sections only — select/scan a folder, then edit configured courses and start learning. Native session plumbing stays internal. Use the host directory picker, preserve explicit course selection and folder replacement confirmation, and reuse guarded native tools. Indexes stay inside the selected folder's .professor directory.

- [x] Add host folder picker and internal session preparation.
- [x] Automatically load configured courses and expose a study action.
- [x] Simplify labels and move diagnostics into secondary controls.
- [x] Verify component workflows and native host loading, then reload desktop.

Verification: 458/458 full test suite and 27/27 client tests passed. Updated component test exercises folder picker → internal session → scan → explicit selection → confirm → automatic course reload. Real desktop restarted and its accessibility tree confirms the simplified two-section page. Actual user's folder selection/indexing is left for their trial; no user folder was chosen or written during this UI acceptance.
