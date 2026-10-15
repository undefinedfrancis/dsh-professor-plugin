# Harness-aligned UI Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, preserving the approved checkout.

**Goal:** Apply the approved host-aligned section navigation without losing existing settings state.

**Architecture:** One mounted ProfessorDetails owner retains preference and connection guards;
native hidden panels retain the workspace child. Shared scoped presentation removes serif/green
visual overrides; host font/color inheritance and currentColor neutral controls need no new service.

**Tech Stack:** Host React, existing client bundle, Node component contract tests.

### Task 1 — navigation regression

- [x] Add a test in test/client-bundle.test.mjs rendering ProfessorDetails with persistent hook
  slots; switch preferences → workspace → memory → preferences and assert draft retention,
  three labeled navigation buttons, and exactly one mounted workspace component.
- [x] Run `node --test test/client-bundle.test.mjs`; observed missing navigation failure.

### Task 2 — mounted sections

- [x] In client/client.js append section state after existing state slots. Render a labeled nav
  using `aria-pressed` buttons and `hidden` sections. Keep the workspace child mounted independently
  of data/loading. Place preference and memory controls in their own hidden sections.
- [x] Add a scoped style override shared by Home/details: inherited fonts, neutral theme-aware
  currentColor boundaries/primary control, wrapping navigation/rows and narrow width padding.
- [x] Run focused tests and full `npm run verify`; 22/22 client and 436/436 full passed.

### Task 3 — acceptance and record

- [x] Review diff, perform isolated packed UI acceptance, record evidence and limitations in
  docs/v1/PHASE6.md. Only mark browser acceptance when actually exercised.
- [x] Save a local checkpoint after verified checks; no push, merge or desktop reinstall.
