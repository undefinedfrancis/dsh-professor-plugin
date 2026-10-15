# Phase 5 skill customization — approved design

Approved in chat on 2026-10-07. No frontend in this phase.

Store bounded versioned overlays in the existing professor_app table, outside immutable package
skills. Keys use a JSON tuple of skill name and either global scope or existing project namespace
plus immutable course ID. Reuse courseMemoryNamespace; do not create another course registry.
Only six bundled skill names are accepted. Five optional string fields: language, explanationStyle,
teachingDepth, programmingLanguage, additionalInstructions. Empty fields are omitted. Reject
unknown fields, non-whitespace control characters, nonplain objects, excessive size and unsupported
records. Tab, newline and carriage return are permitted for readable multiline preferences.

Composition: immutable built-in content; resolved global preferences; explicit course additions;
current explicit session instructions. Structured fields replace lower-precedence fields;
additional instructions remain labelled additions. Current session instructions are never saved
implicitly. Reset writes an empty overlay with a new revision, avoiding stale-writer ABA.
Mutations require expectedRevision and explicit-stable evidence; no silent inference or promotion.
Serialize per shared storage handle, including across store instances using that handle.

Prompt framing escapes user-provided markup and labels additions as preferences, not policies.
Mandatory truthfulness, citations, source safety, course isolation, host permissions and the
current-session artifact-format gate remain immutable. Prompt framing is not a security sandbox:
actual permissions and existing tool validation remain authoritative; model compliance requires
separate authorized model testing.

Host compatibility correction: expose the settings store through the existing professorAppStorage
facade, not a new preset-provided Cordis service. Real packed Home acceptance rejected that new
service because it would require an isolate realm. The runtime owns its facet and clears the
facade reference on withdrawal only if it still owns that reference. Phase 6 must obtain a live
store and must not retain a released facet. Catalog candidates remain unchanged.

Resolve course binding only from lookup.scope (the host's current agent), its workspace and the
existing binding file. No cwd-only course inference. Catalog candidates never carry course data;
compose fresh bodies in provider.get. General/unknown-session lookup gets only global settings.
Invalid stored records surface coded errors without rewrite. Provider failures must not silently
serve apparently customized content. Old loaded content in conversation history is not rewritten.

Tests cover precedence, isolation, reset, bounded values, concurrency, corruption, escaping,
ephemeral instructions and persistent reopen. Packaged new native sessions must load distinct
course skill content and restore settings across fresh-process restart. Check package skill hashes
and real profile hashes. No credentials, model turn, real source writes or desktop installation.
