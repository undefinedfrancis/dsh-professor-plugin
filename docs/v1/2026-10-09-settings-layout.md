# Settings layout refresh — 2026-10-09

User screenshots requested Recent deletion, simpler preferences, and corrected course forms.
Implemented UI changes in the existing plugin workspace:

- Top navigation for Preferences, Folder & Courses, and Memory; heading and Back aligned.
- Common preferences use three optional selectors: explanation language, detail and teaching style.
- Existing custom values are retained as selectable options. No stored values migrate automatically.
- Task-specific preferences, programming language and additional instructions remain under More settings.
  The page names the selected task explicitly; preferences are not falsely advertised as applying to all tasks.
- Course name and term use a responsive two-column grid. Primary study/save controls and maintenance
  controls use separate wrapping groups, consistent spacing and a dividing line.
- Successful course loading clears its stale loading message.

Design references:
- https://www.nngroup.com/articles/progressive-disclosure/
- https://design-system.service.gov.uk/patterns/question-pages/

Validation: `npm run verify` exit 0, 481/481 tests and E2E 28/28; log
`/private/tmp/professor-settings-layout-final.log`. Existing component tests verify labelled selectors,
collapsed advanced settings, save/reset wiring and course draft preservation.
Real Harness dark-theme screenshots inspected: common preferences fit within the page, course card
fields and action groups are spaced and aligned. No real preference saves, archive submissions,
course deletion or model turns were performed. Light theme and narrow-screen visual checks remain outstanding.

Recent deletion is pending the user's choice. Current public host APIs do not support permanent native
conversation deletion. An asynchronous question offers list removal plus native archive, list removal
only, or retaining permanent deletion as an outstanding requirement. No response has been received;
no alternative semantics or conversation mutations have been implemented yet.
