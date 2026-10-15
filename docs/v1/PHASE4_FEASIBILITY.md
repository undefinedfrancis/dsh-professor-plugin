# Phase 4 — Current-state and integration decision

Inspection date: 2026-10-07 (Asia/Shanghai).

## Actual repository state

The checkout was clean at inspection. Latest milestone: `80a7fc8`, Phase 3. No Phase 4 client bundle,
Home component, native routing service or academic session metadata implementation exists yet.
The status ledger correctly lists Phase 4 as not started. There is no unfinished Phase 4 patch to repair.

## Supported UI path confirmed from installed source

Host package tree: `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules`.

The installed `@deepseek-ai/dsh-client-ui-plugin-manager` manifest declares `dsh.client` with web
platform and client dependencies. Its shipped `lib/client.js` uses the host module-loader factory,
React, official `ctx.slots.inject` and `ctx.slots.register` calls. It registers a keyed `main` panel
and a `sidebar.panellist` row sharing a panel ID. This provides a supported route for Professor Home;
no DOM injection or replacement of the host conversation is necessary.

The existing Phase 0 audit is a useful API inventory, but its session-separation entry was explicitly
an unverified composition choice. Presence of archive/grouping methods is not proof of a safe
custom classification/filtering implementation.

## Session-separation concern

Read-only inspection of installed `@deepseek-ai/dsh-workspace/lib/index.js` confirms:

- Workspace membership validates the persisted session header's canonical `cwd` against the
  workspace path and rejects a mismatch. Therefore a course session cannot simply be assigned to a
  different Professor workspace while retaining its academic `cwd` through that API.
- Session archival is real persistent archival, with checks for active sessions and interactions
  with pinning. It is not equivalent to a Professor-only display tag.
- No non-archival session filter was established by this inspection. This is an unresolved API/design
  question, not a claim that every possible supported extension has been exhaustively ruled out.

Do not silently archive sessions, alter headers/logs, substitute a second conversation store, patch
the host or use CSS/DOM hiding to satisfy the acceptance wording.

## Approved scope (2026-10-07)

The user selected the UI-first option in chat (`1`). Implement the supported sidebar/Home/native
routing now, retaining ordinary native session listings. Session separation remains explicitly
incomplete. This approval does not permit archival, log editing, DOM hiding or host patching.

## Original decision context

Original requirement: Professor sessions appear through Professor UI without cluttering ordinary
project workflows. Two possible scopes:

1. Preserve the requirement and first establish a supported classification/filtering mechanism or a
   host prerequisite. The separation requirement remains pending until verified.
2. With explicit user approval, build the supported entry/Home/native routing first while retaining
   native sessions in ordinary listings, clearly marking separation incomplete. This is a scoped
   exception, not full Phase 4 acceptance and not a v1 release-readiness claim.

No product code, desktop settings, source materials or session history was changed in this inspection.
Scope approval is recorded above. Fresh runtime/UI acceptance remains necessary.
