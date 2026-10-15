/**
 * Extraction backend contracts: discovery, argv quoting, output parsing, failure classification.
 *
 * Everything here is pure and deterministic — no process is started, no file is opened — so it runs
 * identically on a machine with Ghostscript and Python and on one with neither. That is the point:
 * the *contract* of the production backend is covered everywhere, while the *integration* claim
 * ("this really extracts a PDF here") lives in `extract-production.test.mjs` and is capability
 * gated. A production test that only ever ran a mock would prove nothing about the backend.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  argvToCommand, buildGhostscriptPlan, buildOfficePlan, buildPymupdfPlan, classifiedReason,
  decodeMarkupText, parseGhostscriptStructured, parseJsonObject, readOfficeResult,
  readPymupdfResult, shellQuote,
} from '../src/extract/backend.js'
import {
  GHOSTSCRIPT_PREFIXES, dshHome, existingCandidates, ghostscriptCandidates,
  hasTxtwriteDevice, parseGhostscriptVersion, parsePythonProbe, pythonCandidates,
} from '../src/extract/runtime.js'

// --- argument quoting: the boundary that keeps a path from becoming a command -------------

/** Run `fn` and return the thrown error (assert.throws discards it). */
function thrownBy(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}

test('every argument is quoted so it can never be read as a second command or a flag', () => {
  assert.equal(shellQuote('plain'), 'plain', 'a provably inert word is left alone')
  assert.equal(shellQuote(''), "''", 'an empty argument is still an argument')
  assert.equal(shellQuote('/a path/with spaces.pdf'), "'/a path/with spaces.pdf'")
  assert.equal(shellQuote('a;rm -rf /'), "'a;rm -rf /'", 'a command separator is inert inside quotes')
  assert.equal(shellQuote('$(whoami)'), "'$(whoami)'", 'command substitution is inert inside quotes')
  assert.equal(shellQuote('a`whoami`b'), "'a`whoami`b'")
  assert.equal(shellQuote("it's"), "'it'\\''s'", 'a literal quote is closed, escaped and reopened')
  assert.equal(shellQuote('--flag'), '--flag')

  // The decisive property: a value that *looks* like a flag or a pipeline stays one argument.
  assert.equal(argvToCommand(['gs', '-sDEVICE=txtwrite', '--', '/tmp/a;b.pdf']),
    "gs -sDEVICE=txtwrite -- '/tmp/a;b.pdf'")

  assert.equal(thrownBy(() => shellQuote('a\0b')).code, 'PROFESSOR_EXTRACT_ARGV_INVALID',
    'a NUL byte has no shell spelling')
  assert.equal(thrownBy(() => argvToCommand([])).code, 'PROFESSOR_EXTRACT_ARGV_INVALID')
})

// --- candidate discovery: ordered, injectable, and never a hardcoded machine path ----------

test('interpreter candidates are ordered by privilege and carry their source', () => {
  const candidates = pythonCandidates({
    env: { DSH_PROFESSOR_PYTHON: '/opt/custom/venv', DSH_PRIMARY_RUNTIME: '/carrier', DSH_HOME: '/home/x/.dsh' },
    resourcesPath: '/app/Resources',
    homedir: '/home/x',
    pathDirs: ['/usr/bin'],
    platform: 'darwin',
  })
  const sources = candidates.map((entry) => entry.source)
  assert.equal(sources[0], 'env:DSH_PROFESSOR_PYTHON', 'an explicit override always wins')
  assert.ok(sources.indexOf('env:DSH_PRIMARY_RUNTIME') < sources.indexOf('dsh-home-payload'))
  assert.ok(sources.indexOf('dsh-home-payload') < sources.indexOf('app-resources-payload'))
  assert.ok(sources.indexOf('app-resources-payload') < sources.indexOf('path'), 'PATH is the last resort')
  const overrideSpellings = candidates.filter((entry) => entry.source === 'env:DSH_PROFESSOR_PYTHON').map((entry) => entry.path)
  assert.ok(overrideSpellings.includes(path.resolve('/opt/custom/venv/bin/python3')),
    'a directory override expands to its bin/ interpreter')
  assert.ok(overrideSpellings.every((entry) => entry.startsWith('/opt/custom/venv/')),
    'and never escapes the directory the operator named')
  assert.ok(candidates.some((entry) => entry.path === path.join('/app/Resources', 'runtime', 'primary-runtime', 'dependencies', 'python', 'bin', 'python3')))
  assert.ok(candidates.some((entry) => entry.path === path.join('/carrier', 'dependencies', 'python', 'bin', 'python3')))
  assert.equal(new Set(candidates.map((entry) => entry.path)).size, candidates.length, 'no duplicates')
})

test('an override that names the executable itself is used verbatim', () => {
  const candidates = pythonCandidates({
    env: { DSH_PROFESSOR_PYTHON: '/opt/venv/bin/python3.12' },
    homedir: '/home/x',
    pathDirs: [],
  })
  assert.equal(candidates[0].path, path.resolve('/opt/venv/bin/python3.12'))
})

test('the Harness home honours DSH_HOME, exactly as the loader does', () => {
  assert.equal(dshHome({ DSH_HOME: '/tmp/disposable' }), path.resolve('/tmp/disposable'))
  assert.match(dshHome({}), /\.dsh$/)
})

test('Ghostscript candidates put the override first and never invent a device', () => {
  const candidates = ghostscriptCandidates({ env: { DSH_PROFESSOR_GS: '/opt/gs/bin' }, pathDirs: [], platform: 'darwin' })
  assert.equal(candidates[0].path, path.resolve('/opt/gs/bin/gs'))
  assert.ok(GHOSTSCRIPT_PREFIXES.every((prefix) => candidates.some((entry) => entry.path.startsWith(prefix))))
  assert.equal(hasTxtwriteDevice('Device list: png16m txtwrite uniprint'), true)
  assert.equal(hasTxtwriteDevice('Device list: png16m pngalpha'), false,
    'an unavailable device is never assumed present')
  assert.equal(parseGhostscriptVersion('10.07.0'), '10.07.0')
  assert.equal(parseGhostscriptVersion('GPL Ghostscript 9.56.1 (2022-04-04)'), '9.56.1')
  assert.equal(parseGhostscriptVersion('not a version'), null)
})

test('existing candidates keep their order and drop what is not really there', () => {
  const listed = existingCandidates(
    [{ path: '/a/python3', source: 'one' }, { path: '/b/python3', source: 'two' }, { path: '/c/python3', source: 'three' }],
    { exists: (candidate) => candidate !== '/b/python3', isFile: () => true },
  )
  assert.deepEqual(listed.map((entry) => entry.source), ['one', 'three'])
})

test('the interpreter probe report is parsed, and malformed output is rejected', () => {
  const probe = parsePythonProbe('{"ok":true,"python":"3.12.14","modules":{"docx":"1.2.0"},"missing":["fitz"]}')
  assert.equal(probe.python, '3.12.14')
  assert.deepEqual(probe.missing, ['fitz'])
  assert.equal(parsePythonProbe(''), null)
  assert.equal(parsePythonProbe('Traceback: no such module'), null)
  assert.equal(parsePythonProbe('[]'), null, 'a non-object report is not a report')
})

// --- Ghostscript structured output ---------------------------------------------------------

test('Ghostscript TextFormat=1 markup becomes one text block per page', () => {
  const markup = [
    '<page>',
    '<block>',
    '<line>',
    '<span bbox="1 2 3 4" font="Helvetica" size="14">',
    '<char bbox="1 2 3 4" c="H"/><char bbox="1 2 3 4" c="i"/>',
    '</span>',
    '</line>',
    '<line><span><char c="&amp;"/><char c=" "/><char c="x"/></span></line>',
    '</block>',
    '</page>',
    '<page><block><line><span><char c="P"/><char c="2"/></span></line></block></page>',
  ].join('\n')

  const parsed = parseGhostscriptStructured(markup)
  assert.equal(parsed.structured, true)
  assert.equal(parsed.pages.length, 2, 'one entry per <page>, so numbering is the document\'s own')
  assert.equal(parsed.pages[0].page, 1)
  assert.equal(parsed.pages[0].text, 'Hi\n& x', 'lines are joined, character references decoded')
  assert.equal(parsed.pages[1].page, 2)
  assert.equal(parsed.pages[1].text, 'P2')
})

test('plain text output is reported as unstructured rather than given invented page numbers', () => {
  const parsed = parseGhostscriptStructured('    Page one text\n      more text\n')
  assert.equal(parsed.structured, false)
  assert.equal(parsed.pages, null, 'no markup means no page coordinate, not page 1')
})

test('an empty page stays an empty page instead of being skipped', () => {
  const parsed = parseGhostscriptStructured('<page><block></block></page><page><block><line><span><char c="x"/></span></line></block></page>')
  assert.equal(parsed.pages.length, 2, 'a blank page still occupies its position')
  assert.equal(parsed.pages[0].text, '')
  assert.equal(parsed.pages[1].page, 2, 'so the second page keeps its real number')
})

test('character references outside Unicode are dropped rather than crashing', () => {
  assert.equal(decodeMarkupText('&#x110000;'), '')
  assert.equal(decodeMarkupText('&lt;a&gt;&amp;&quot;b&quot;'), '<a>&"b"')
})

// --- plan building --------------------------------------------------------------------------

test('the Ghostscript plan is an argv with a hard end-of-options marker', () => {
  const plan = buildGhostscriptPlan({ binary: '/usr/local/bin/gs', sourcePath: '/tmp/two page.pdf', maxPages: 50 })
  assert.deepEqual(plan.argv.slice(0, 2), ['/usr/local/bin/gs', '-q'])
  assert.ok(plan.argv.includes('-dSAFER'), 'the PostScript program cannot touch the filesystem')
  assert.ok(plan.argv.includes('-dTextFormat=1'), 'structured output is requested explicitly')
  assert.ok(plan.argv.includes('-dLastPage=50'))
  assert.equal(plan.argv.at(-1), '/tmp/two page.pdf')
  assert.equal(plan.argv.at(-2), '--', 'so a path can never be read as a flag')
  assert.equal(buildGhostscriptPlan({ binary: 'gs', sourcePath: '/x.pdf', maxPages: undefined }).argv.includes('-dLastPage=2000'), false,
    'an absent page bound adds no flag')
})

test('the Python plans put the source path last and never build a shell string', () => {
  const pdf = buildPymupdfPlan({ python: '/p/python3', scriptPath: '/p/extract_pdf.py', sourcePath: "/x/it's.pdf", maxPages: 10 })
  assert.deepEqual(pdf.argv.slice(0, 3), ['/p/python3', '/p/extract_pdf.py', '--path'])
  assert.equal(argvToCommand(pdf.argv).includes("'/x/it'\\''s.pdf'"), true,
    'the apostrophe is escaped when the argv becomes a command line')

  const office = buildOfficePlan({
    python: '/p/python3', scriptPath: '/p/extract_office.py', format: 'xlsx',
    sourcePath: '/x/w.xlsx', limits: { maxSheets: 3, maxCells: 100 }, includeNotes: true,
  })
  assert.ok(office.argv.includes('--max-sheets'))
  assert.ok(office.argv.includes('3'))
  assert.ok(office.argv.includes('--max-cells'))
  assert.equal(office.argv.at(-1), '--include-notes')
  assert.equal(buildOfficePlan({
    python: 'p', scriptPath: 's', format: 'pptx', sourcePath: 'x', limits: {},
  }).argv.includes('--include-notes'), false, 'speaker notes are opt-in')
})

// --- result parsing and classification ------------------------------------------------------

test('the Office result keeps one-based indices and reports its own errors', () => {
  const ok = readOfficeResult(JSON.stringify({
    ok: true,
    units: [
      { kind: 'slide', index: 1, title: 'A', text: 'body' },
      { kind: 'slide', index: 2, title: null, text: '' },
      { kind: 'slide', index: 0, title: 'ignored', text: 'no coordinate' },
    ],
    notes: ['pptx: 2 slide(s)'],
  }))
  assert.equal(ok.ok, true)
  assert.equal(ok.units.length, 2, 'a unit without a real coordinate is dropped, never renumbered')
  assert.deepEqual(ok.units.map((unit) => unit.index), [1, 2])

  const bad = readOfficeResult('{"ok":false,"error":"encrypted","detail":"protected"}')
  assert.equal(bad.ok, false)
  assert.match(classifiedReason(bad.error, bad.detail, 'the Office backend'), /encrypted or password-protected/)
  assert.match(classifiedReason('malformed', 'x', 'the Office backend'), /parsing failure/)
  assert.match(classifiedReason('parse-failed', '', 'the Office backend'), /could not be parsed/)
  assert.equal(readOfficeResult('not json at all').error, 'parse-failed')
})

test('a JSON envelope is located inside surrounding noise, or rejected', () => {
  assert.deepEqual(parseJsonObject('warning: something\n{"a":1}\n'), { a: 1 })
  assert.equal(parseJsonObject(''), null)
  assert.equal(parseJsonObject('{oops'), null)
})

test('the PyMuPDF result drops entries with no real page number', () => {
  const parsed = readPymupdfResult('{"ok":true,"pages":[{"page":1,"text":"a"},{"page":0,"text":"b"},{"text":"c"}]}')
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.pages, [{ page: 1, text: 'a' }])
  assert.equal(readPymupdfResult('{"ok":false,"error":"encrypted","detail":"needs a password"}').error, 'encrypted')
})
