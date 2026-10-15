/**
 * N2 preflight — the host filesystem capability, pinned to the real installed artifact.
 *
 * Three things are checked here, all zero-cost:
 *
 * 1. **The contracts are the host's, not ours.** `source-grounded-host-tools.mjs` states the
 *    parameters `read` and `edit` must accept. This test re-derives them from the installed
 *    `@deepseek-ai/dsh-tool-fs` package source, so a contract that drifts from the real tool fails
 *    here rather than at a paid request.
 * 2. **Discovery reports what the registry actually exposes**, including the absence of a tool.
 * 3. **A probe believes the bytes, not the tool.** A write that succeeds while reporting an error
 *    is recorded as a write; a "success" that changed nothing is recorded as blocked.
 *
 * The package is located by searching the known install roots; when none holds it, the test fails
 * loudly rather than skipping, because verifying against the real host artifact is the point.
 *
 * @module test/source-grounded-host-tools
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import {
  ALL_HOST_FS_TOOLS, EXPECTED_PARAMETERS, FORBIDDEN_SUBSTITUTES, OFFERED_FS_TOOLS,
  assessFsReadiness, checkParameters, discoverHostFsTools, probeEdit, probeFsBoundaries,
} from './helpers/source-grounded-host-tools.mjs'

const hashOf = async (file) => {
  const bytes = await fs.readFile(file).catch(() => null)
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
}

/** Locate the installed host package across the roots this repo already knows about. */
async function locateHostPackage() {
  const fixed = [
    process.env.HARNESS_NODE_MODULES
      && path.join(process.env.HARNESS_NODE_MODULES, '@deepseek-ai', 'dsh-tool-fs'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-tool-fs',
  ].filter(Boolean)
  for (const candidate of fixed) {
    const manifest = await fs.readFile(path.join(candidate, 'package.json')).catch(() => null)
    if (manifest !== null) return candidate
  }
  // The npx cache holds one directory per install; take the first that resolves.
  const npxRoot = path.join(os.homedir(), '.npm', '_npx')
  const entries = await fs.readdir(npxRoot).catch(() => [])
  for (const entry of entries) {
    const root = path.join(npxRoot, entry, 'node_modules', '@deepseek-ai', 'dsh-tool-fs')
    const manifest = await fs.readFile(path.join(root, 'package.json')).catch(() => null)
    if (manifest !== null) return root
  }
  return null
}

/** Re-derive each tool's parameter block from the package source, the way the plugin declares it. */
function parseParameters(source, toolName) {
  const marker = `name: "${toolName}"`
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, `the host package does not declare a ${toolName} tool`)
  const start = source.indexOf('parameters: {', at)
  assert.notEqual(start, -1, `${toolName} declares no parameters block`)
  let cursor = start + 'parameters: {'.length
  let depth = 1
  while (depth > 0 && cursor < source.length) {
    if (source[cursor] === '{') depth += 1
    else if (source[cursor] === '}') depth -= 1
    cursor += 1
  }
  return source.slice(start, cursor)
}

test('the host package declares read/write/edit with the parameters this block relies on', async () => {
  const root = await locateHostPackage()
  assert.ok(root !== null,
    'the installed @deepseek-ai/dsh-tool-fs could not be located — the parameter contracts cannot '
    + 'be verified against the real host artifact, which is the point of this test')
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@deepseek-ai/dsh-tool-fs')
  const source = await fs.readFile(path.join(root, 'lib', 'index.js'), 'utf8')

  for (const [toolName, expected] of Object.entries(EXPECTED_PARAMETERS)) {
    const block = parseParameters(source, toolName)
    const declared = [...block.matchAll(/^\t\t\t(\w+): \{/gm)].map((match) => match[1])
    assert.deepEqual(declared.sort(), [...expected.required, ...expected.optional].sort(),
      `${toolName} declares exactly the parameters this block expects`)
    for (const name of expected.required) {
      assert.match(block, new RegExp(`${name}: \\{[^}]*required: true`),
        `${toolName}.${name} is required in the real tool`)
    }
    for (const name of expected.optional) {
      assert.ok(!new RegExp(`${name}: \\{[^}]*required: true`).test(block),
        `${toolName}.${name} is optional in the real tool`)
    }
  }
})

test('discovery reports visibility from the live registry, including absence', () => {
  const visible = new Map([
    ['read', {
      description: 'Read a UTF-8 text file and return line-numbered content.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', required: true }, offset: { type: 'number' }, limit: { type: 'number' },
        },
      },
    }],
    ['edit', {
      description: 'Edit an existing UTF-8 text file by replacing literal text.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', required: true },
          old_string: { type: 'string', required: true },
          new_string: { type: 'string', required: true },
          replace_all: { type: 'boolean' },
        },
      },
    }],
    ['write', {
      description: 'Write a UTF-8 text file.',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
      },
    }],
  ])
  const ctx = { get: (name) => (name === 'tools' ? { view: () => ({ visible }) } : undefined) }
  const found = discoverHostFsTools(ctx, {})
  assert.equal(found.discovered, true)
  assert.deepEqual(found.offered, OFFERED_FS_TOOLS)
  assert.deepEqual(Object.keys(found.tools.read.parameters.properties).sort(),
    ['file_path', 'limit', 'offset'],
    'the descriptor the registry exposes is recorded verbatim, schema included')

  const missingEdit = new Map([['read', visible.get('read')]])
  const partial = discoverHostFsTools({ get: () => ({ view: () => ({ visible: missingEdit }) }) }, {})
  assert.equal(partial.discovered, false)
  assert.deepEqual(partial.missing, ['edit'])
  assert.equal(partial.tools.edit.visible, false)
})

test('a scope with no visible tools is reported as missing, never as an empty success', () => {
  const found = discoverHostFsTools({ get: () => ({ view: () => ({ visible: new Map() }) }) }, {})
  assert.equal(found.discovered, false)
  assert.deepEqual(found.offered, [])
})

test('the offered subset is the minimum read/edit capability, and no shell stands in for it', () => {
  assert.deepEqual(OFFERED_FS_TOOLS, ['read', 'edit'])
  assert.deepEqual(ALL_HOST_FS_TOOLS, ['read', 'write', 'edit'])
  for (const name of OFFERED_FS_TOOLS) {
    assert.ok(ALL_HOST_FS_TOOLS.includes(name), `${name} is a real host tool, not an invented one`)
  }
  for (const name of FORBIDDEN_SUBSTITUTES) {
    assert.ok(!OFFERED_FS_TOOLS.includes(name),
      `${name} is a broad capability and must never be offered to close this gap`)
  }
})

test('a probe records a write that succeeded while reporting an error', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-tools-probe-'))
  const file = path.join(dir, 'content.tex')
  await fs.writeFile(file, 'sentinel\n')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const refusingTool = async (name) => {
    if (name === 'read') return { isError: false, content: [{ type: 'text', text: 'sentinel' }] }
    return { isError: true, content: [{ type: 'text', text: 'Error: nope' }] }
  }
  const probe = await probeEdit({
    label: 'refusing tool', execute: refusingTool, hashOf,
    filePath: file, oldString: 'sentinel', newString: 'sentinel changed',
  })
  assert.equal(probe.read_first.succeeded, true, 'the probe reads before it edits')
  assert.equal(probe.bytes_changed, false, 'a refusal leaves the bytes alone')
  assert.equal(probe.write_blocked, true)
  assert.equal(probe.isError, true)

  const writingButFailing = async (name, args) => {
    if (name === 'read') return { isError: false, content: [{ type: 'text', text: 'sentinel' }] }
    await fs.writeFile(args.file_path, 'sentinel changed\n')
    return { isError: true, content: [{ type: 'text', text: 'Error: reported anyway' }] }
  }
  const caught = await probeEdit({
    label: 'writes then reports failure', execute: writingButFailing, hashOf,
    filePath: file, oldString: 'sentinel changed', newString: 'sentinel changed again',
  })
  assert.equal(caught.bytes_changed, true,
    'the bytes moved, so this is a write whatever the tool said about it')
  assert.equal(caught.write_blocked, false)
})

test('a probe that cannot read first is inconclusive, never protection', async (t) => {
  // The host's fs-observation-policy refuses `edit` on a file that has not been read. Without the
  // preceding read, every target looks unwritable — which is exactly the false reassurance the
  // probe must not report.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-tools-observed-'))
  const file = path.join(dir, 'content.tex')
  await fs.writeFile(file, 'sentinel\n')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  const observationPolicy = async (name) => (name === 'read'
    ? { isError: true, content: [{ type: 'text', text: 'Error: file has not been read — read the file, then retry' }] }
    : { isError: true, content: [{ type: 'text', text: 'Error: file has not been read' }] })
  const probe = await probeEdit({
    label: 'observation policy', execute: observationPolicy, hashOf,
    filePath: file, oldString: 'sentinel', newString: 'sentinel changed',
  })
  assert.equal(probe.read_first.succeeded, false)
  assert.equal(probe.inconclusive, true)
  assert.equal(probe.write_blocked, false, 'no refusal verdict may be drawn without a successful read')
  assert.equal(probe.isError, null, 'the edit was never attempted')
  assert.match(probe.error, /edit not attempted/)
  assert.equal(probe.bytes_changed, false)

  const ready = assessFsReadiness(
    {
      discovered: true, offered: OFFERED_FS_TOOLS,
      tools: { read: { visible: true }, edit: { visible: true } },
    },
    {
      output_copy_edit: probe,
      source_directory_edit: { ...probe, inconclusive: true },
      other_course_edit: { ...probe, inconclusive: true },
    },
  )
  assert.equal(ready.ready_for_paid_run, false)
  assert.deepEqual(ready.inconclusive_probes,
    ['output_copy_edit', 'source_directory_edit', 'other_course_edit'])
  assert.ok(!ready.problems.some((p) => p.includes('is writable through the host filesystem tool')),
    'an inconclusive probe must never be reported as a writability verdict')
  assert.ok(ready.problems.some((p) => p.includes('inconclusive')))
})

test('boundary probes distinguish the output copy from the source and another course', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-tools-bounds-'))
  const output = path.join(dir, 'notes', 'probe-output.tex')
  const source = path.join(dir, 'CSC3200', '01_Lectures', 'probe.txt')
  const other = path.join(dir, 'STA2001', 'probe.txt')
  for (const file of [output, source, other]) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'sentinel\n')
  }
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  // A policy that allows the output copy and refuses everything else. Reads always succeed, so a
  // refusal can only come from the write policy.
  const execute = async (name, args) => {
    if (name === 'read') return { isError: false, content: [{ type: 'text', text: 'sentinel' }] }
    assert.equal(name, 'edit')
    if (args.file_path.startsWith(path.join(dir, 'notes'))) {
      await fs.writeFile(args.file_path, `${args.new_string}\n`)
      return { isError: false, content: [{ type: 'text', text: 'ok' }] }
    }
    return { isError: true, content: [{ type: 'text', text: 'Error: path is outside the writable root' }] }
  }

  const probes = await probeFsBoundaries({
    execute, hashOf,
    outputCopy: { path: output, sentinel: 'sentinel' },
    sourceProbe: { path: source, sentinel: 'sentinel' },
    otherCourseProbe: { path: other, sentinel: 'sentinel' },
  })
  assert.equal(probes.output_copy_edit.bytes_changed, true, 'the output copy must be editable')
  assert.equal(probes.source_directory_edit.bytes_changed, false, 'the source directory must not move')
  assert.equal(probes.other_course_edit.bytes_changed, false, "another course's directory must not move")

  const ready = assessFsReadiness(
    {
      discovered: true,
      offered: OFFERED_FS_TOOLS,
      tools: {
        read: { visible: true, parameters: { properties: { file_path: {}, offset: {}, limit: {} } } },
        edit: {
          visible: true,
          parameters: {
            properties: { file_path: {}, old_string: {}, new_string: {}, replace_all: {} },
          },
        },
      },
    },
    probes,
  )
  assert.deepEqual(ready.problems, [], JSON.stringify(ready.problems))
  assert.equal(ready.ready_for_paid_run, true)
})

test('a writable source directory blocks the paid run', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-tools-leak-'))
  const output = path.join(dir, 'notes', 'probe-output.tex')
  const source = path.join(dir, 'CSC3200', '01_Lectures', 'probe.txt')
  const other = path.join(dir, 'STA2001', 'probe.txt')
  for (const file of [output, source, other]) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'sentinel\n')
  }
  t.after(() => fs.rm(dir, { recursive: true, force: true }))

  // Everything is writable — the failure this must catch.
  const execute = async (name, args) => {
    if (name === 'read') return { isError: false, content: [{ type: 'text', text: 'sentinel' }] }
    await fs.writeFile(args.file_path, `${args.new_string}\n`)
    return { isError: false, content: [{ type: 'text', text: 'ok' }] }
  }
  const probes = await probeFsBoundaries({
    execute, hashOf,
    outputCopy: { path: output, sentinel: 'sentinel' },
    sourceProbe: { path: source, sentinel: 'sentinel' },
    otherCourseProbe: { path: other, sentinel: 'sentinel' },
  })
  const ready = assessFsReadiness(
    {
      discovered: true, offered: OFFERED_FS_TOOLS,
      tools: { read: { visible: true }, edit: { visible: true } },
    },
    probes,
  )
  assert.equal(ready.ready_for_paid_run, false)
  assert.ok(ready.problems.some((problem) => problem.includes("source's own directory is writable")))
  assert.ok(ready.problems.some((problem) => problem.includes("another course's directory is writable")))
})

test('an undiscovered tool set blocks the paid run', () => {
  const ready = assessFsReadiness(
    { discovered: false, missing: ['edit'], offered: [], tools: { edit: { visible: false } } },
    undefined,
  )
  assert.equal(ready.ready_for_paid_run, false)
  assert.ok(ready.problems.some((problem) => problem.includes('edit')))
  assert.ok(ready.problems.some((problem) => problem.includes('output copy')),
    'the unreachable finishing step is named, not glossed over')
})

/** A real 64-hex SHA-256 digest — fixtures must look like the records the live probe writes. */
function digest(seed) {
  return createHash('sha256').update(seed).digest('hex')
}

/** Probes shaped like the live run's: the finishing step works, both course roots are writable. */
function writableRootsProbes() {
  const ok = (label, filePath, seed) => ({
    label, file_path: filePath, attempted: true,
    read_first: { attempted: true, isError: false, succeeded: true, error: null },
    isError: false, error: null, reported_success: true,
    bytes_changed: true, write_allowed: true, write_blocked: false, inconclusive: false,
    // Distinct per target, as the real before/after digests are.
    sha256_before: digest(`${seed}:before`),
    sha256_after: digest(`${seed}:after`),
  })
  const blocked = (label, filePath, seed) => ({
    ...ok(label, filePath, seed),
    isError: false, bytes_changed: false, write_allowed: false, write_blocked: true,
    // Untouched file: the after-digest is the before-digest, so the record stays self-consistent.
    sha256_after: digest(`${seed}:before`),
  })
  return {
    output_copy_edit: ok('output copy', '/w/.professor/notes/c/content.tex', 'output-copy'),
    source_directory_edit: ok('source', '/w/CSC3200/01_Lectures/probe.txt', 'source-directory'),
    other_course_edit: ok('other', '/w/STA2001/probe.txt', 'other-course'),
    blockedVariants: {
      output_copy_edit: blocked('output copy', '/w/.professor/notes/c/content.tex', 'output-copy'),
      source_directory_edit: blocked('source', '/w/CSC3200/01_Lectures/probe.txt', 'source-directory'),
      other_course_edit: blocked('other', '/w/STA2001/probe.txt', 'other-course'),
    },
  }
}

const fullDiscovery = {
  discovered: true,
  offered: OFFERED_FS_TOOLS,
  tools: {
    read: { visible: true, parameters: { properties: { file_path: {}, offset: {}, limit: {} } } },
    edit: {
      visible: true,
      parameters: { properties: { file_path: {}, old_string: {}, new_string: {}, replace_all: {} } },
    },
  },
}

test('a human waiver accepts exactly the risks it names, and records itself', () => {
  const probes = writableRootsProbes()
  const waiver = {
    block: 'source-grounded-note-delivery',
    decision: 'accept-write-boundaries-with-observational-control',
    decided_by: 'human',
    compensating_control: 'M5 hashes the source before and after',
    accepted_risks: ['source_directory_writable', 'other_course_directory_writable'],
  }

  const without = assessFsReadiness(fullDiscovery, probes)
  assert.equal(without.ready_for_paid_run, false, 'the default stays blocking')
  assert.deepEqual(without.waivers_applied, [])
  assert.deepEqual(without.waiver, null)

  const withWaiver = assessFsReadiness(fullDiscovery, probes, { acceptedRisks: waiver.accepted_risks, waiver })
  assert.deepEqual(withWaiver.problems, [], JSON.stringify(withWaiver.problems))
  assert.equal(withWaiver.ready_for_paid_run, true)
  assert.deepEqual(
    withWaiver.waivers_applied.map((entry) => entry.risk).sort(),
    ['other_course_directory_writable', 'source_directory_writable'],
  )
  assert.equal(withWaiver.waivers_applied[0].waived_by, waiver.decision)
  assert.equal(withWaiver.waiver.compensating_control, waiver.compensating_control,
    'the control that stands in for the waived risk is echoed back for audit')
})

test('waiving one risk does not waive the other', () => {
  const probes = writableRootsProbes()
  const ready = assessFsReadiness(fullDiscovery, probes, {
    acceptedRisks: ['source_directory_writable'],
    waiver: decisionRecord(['source_directory_writable']),
  })
  assert.equal(ready.ready_for_paid_run, false)
  assert.deepEqual(ready.problems, ["another course's directory is writable through the host filesystem tool"])
  assert.deepEqual(ready.waivers_applied.map((entry) => entry.risk), ['source_directory_writable'])
})

/**
 * A decision record of the shape a real waiver carries: it names the block, names exactly the risks
 * it accepts, and names a decider. An accepted-risk list with none of that behind it is not a
 * decision, so the gate must not clear a problem on its strength.
 */
function decisionRecord(acceptedRisks) {
  return {
    block: 'source-grounded-note-delivery',
    decision: 'accept-write-boundaries-with-observational-control',
    decided_by: 'human — the session user, answering directly when asked how to handle the probe result',
    accepted_risks: acceptedRisks,
    not_accepted: ['output_copy_edit_must_succeed'],
  }
}

const BOTH_WRITE_RISKS = ['source_directory_writable', 'other_course_directory_writable']
const RISK_FOR_PROBE = {
  source_directory_edit: 'source_directory_writable',
  other_course_edit: 'other_course_directory_writable',
}

test('a successful output-copy probe alone is not readiness — both course probes are required', () => {
  // The reproduced false-readiness path: valid visible read/edit descriptors, no waiver, and only
  // the finishing probe present. Missing observation is not proof of a protected boundary.
  const probes = writableRootsProbes()
  const ready = assessFsReadiness(fullDiscovery, { output_copy_edit: probes.output_copy_edit })
  assert.equal(ready.ready_for_paid_run, false,
    'the absence of the two course probes must never read as readiness')
  assert.ok(ready.problems.length > 0)
  assert.ok(ready.problems.some((problem) => problem.includes('source_directory_edit was never run')))
  assert.ok(ready.problems.some((problem) => problem.includes('other_course_edit was never run')))
  assert.deepEqual(ready.waivers_applied, [], 'nothing was observed, so nothing was waived')
  assert.deepEqual(ready.waiver, null)
})

test('a missing source-directory probe blocks readiness and cannot be waived', () => {
  const probes = writableRootsProbes()
  delete probes.source_directory_edit
  const ready = assessFsReadiness(fullDiscovery, probes, {
    acceptedRisks: BOTH_WRITE_RISKS, waiver: decisionRecord(BOTH_WRITE_RISKS),
  })
  assert.equal(ready.ready_for_paid_run, false)
  assert.ok(ready.problems.some((problem) => problem.includes('source_directory_edit was never run')),
    'the unrun probe is named rather than treated as an accepted boundary')
  assert.deepEqual(ready.waivers_applied.map((entry) => entry.risk),
    ['other_course_directory_writable'],
    'the waiver accepts only the boundary it actually observed')
})

test('a missing other-course probe blocks readiness and cannot be waived', () => {
  const probes = writableRootsProbes()
  delete probes.other_course_edit
  const ready = assessFsReadiness(fullDiscovery, probes, {
    acceptedRisks: BOTH_WRITE_RISKS, waiver: decisionRecord(BOTH_WRITE_RISKS),
  })
  assert.equal(ready.ready_for_paid_run, false)
  assert.ok(ready.problems.some((problem) => problem.includes('other_course_edit was never run')))
  assert.deepEqual(ready.waivers_applied.map((entry) => entry.risk),
    ['source_directory_writable'])
})

test('both missing course probes are reported, never averaged into one finding', () => {
  const probes = writableRootsProbes()
  delete probes.source_directory_edit
  delete probes.other_course_edit
  const ready = assessFsReadiness(fullDiscovery, probes, {
    acceptedRisks: BOTH_WRITE_RISKS, waiver: decisionRecord(BOTH_WRITE_RISKS),
  })
  assert.equal(ready.ready_for_paid_run, false)
  assert.equal(ready.problems.filter((problem) => problem.includes('was never run')).length, 2)
  assert.deepEqual(ready.waivers_applied, [], 'neither boundary was observed')
})

test('malformed probe evidence blocks readiness instead of counting as a verdict', () => {
  const base = writableRootsProbes()
  const cases = [
    ['source_directory_edit', 'not a probe record', 'a non-object entry'],
    ['other_course_edit', { ...base.other_course_edit, sha256_before: null, sha256_after: null },
      'no before/after digests to compare'],
    ['source_directory_edit', { ...base.source_directory_edit, read_first: undefined },
      'no read-before-edit record'],
    ['other_course_edit', { ...base.other_course_edit, bytes_changed: undefined },
      'no byte outcome'],
    ['source_directory_edit', { ...base.source_directory_edit, attempted: false },
      'no recorded attempt'],
  ]
  for (const [key, value, why] of cases) {
    const ready = assessFsReadiness(fullDiscovery, { ...base, [key]: value }, {
      acceptedRisks: BOTH_WRITE_RISKS, waiver: decisionRecord(BOTH_WRITE_RISKS),
    })
    assert.equal(ready.ready_for_paid_run, false, why)
    assert.ok(ready.problems.some((problem) => problem.includes(`probe for ${key} is malformed`)),
      `${why}: the malformed probe must be named`)
    assert.ok(!ready.waivers_applied.some((entry) => entry.risk === RISK_FOR_PROBE[key]),
      `${why}: malformed evidence is neither protection nor an accepted boundary`)
    assert.ok(!ready.problems.some((problem) => problem.includes('is writable through the host filesystem tool')),
      `${why}: a verdict must not be drawn from evidence that cannot support one`)
  }
})

/**
 * The two ways a record can contradict itself, for every probe the gate requires.
 *
 * Both directions matter: a claimed change whose digests match would report the finishing step as
 * exercisable when nothing moved, and a claimed non-change whose digests differ would report a
 * protected source directory when it was written to.
 */
const CONTRADICTIONS = [
  ['a claimed change whose before/after digests are identical', (probe) => ({
    ...probe, sha256_after: probe.sha256_before,
  })],
  ['a claimed non-change whose before/after digests differ', (probe) => ({
    ...probe, bytes_changed: false,
  })],
]

test('contradictory probe evidence is malformed, never a verdict, in either direction', () => {
  const base = writableRootsProbes()
  const riskFor = {
    source_directory_edit: 'source_directory_writable',
    other_course_edit: 'other_course_directory_writable',
  }
  for (const key of ['output_copy_edit', 'source_directory_edit', 'other_course_edit']) {
    for (const [why, breakIt] of CONTRADICTIONS) {
      for (const waiverMode of ['without a waiver', 'with an otherwise valid waiver']) {
        const broken = breakIt(base[key])
        const recorded = JSON.stringify(broken)
        const options = waiverMode === 'with an otherwise valid waiver'
          ? { acceptedRisks: BOTH_WRITE_RISKS, waiver: decisionRecord(BOTH_WRITE_RISKS) }
          : {}
        const ready = assessFsReadiness(fullDiscovery, { ...base, [key]: broken }, options)
        const label = `${key} / ${why} / ${waiverMode}`

        assert.equal(JSON.stringify(broken), recorded,
          `${label}: the recorded boolean must be reported, never rewritten`)
        assert.equal(ready.ready_for_paid_run, false, label)
        assert.ok(ready.problems.some((problem) =>
          problem.includes(`probe for ${key} is malformed`)
          && problem.includes('contradictory evidence')), `${label}: ${JSON.stringify(ready.problems)}`)

        if (waiverMode === 'with an otherwise valid waiver') {
          // Only the boundaries that were observed consistently may still be waived.
          const expected = Object.entries(riskFor)
            .filter(([probeKey]) => probeKey !== key)
            .map(([, risk]) => risk).sort()
          assert.deepEqual(ready.waivers_applied.map((entry) => entry.risk).sort(), expected,
            `${label}: a waiver may accept a consistent observation, not a contradictory one`)
        }
        if (riskFor[key] !== undefined) {
          assert.ok(!ready.waivers_applied.some((entry) => entry.risk === riskFor[key]),
            `${label}: contradictory evidence must never be accepted as a boundary`)
        }
      }
    }
  }
})

test('digests that are not usable SHA-256 values are malformed, not evidence', () => {
  const base = writableRootsProbes()
  const cases = [
    ['source_directory_edit', 'sha256_before', 'abce03f0f6fe', 'a truncated digest'],
    ['source_directory_edit', 'sha256_before', 'z'.repeat(64), 'a non-hex digest of the right length'],
    ['other_course_edit', 'sha256_after', `g${'0'.repeat(63)}`, 'a non-hex character'],
    ['other_course_edit', 'sha256_after', null, 'a missing after-digest'],
    ['output_copy_edit', 'sha256_before', 42, 'a non-string digest'],
  ]
  for (const [key, field, value, why] of cases) {
    const broken = { ...base[key], [field]: value }
    const ready = assessFsReadiness(fullDiscovery, { ...base, [key]: broken }, {
      acceptedRisks: BOTH_WRITE_RISKS, waiver: decisionRecord(BOTH_WRITE_RISKS),
    })
    assert.equal(ready.ready_for_paid_run, false, why)
    assert.ok(ready.problems.some((problem) =>
      problem.includes(`probe for ${key} is malformed`)
      && problem.includes('not a usable SHA-256 value')), `${why}: ${JSON.stringify(ready.problems)}`)
    assert.ok(!ready.waivers_applied.some((entry) =>
      entry.risk === RISK_FOR_PROBE[key]), `${why}: an unusable digest is not a boundary observation`)
  }
})

test('a missing required descriptor blocks readiness even when discovery claims success', () => {
  const ready = assessFsReadiness(
    { discovered: true, offered: OFFERED_FS_TOOLS, tools: { read: fullDiscovery.tools.read } },
    writableRootsProbes(),
    { acceptedRisks: BOTH_WRITE_RISKS, waiver: decisionRecord(BOTH_WRITE_RISKS) },
  )
  assert.equal(ready.ready_for_paid_run, false,
    'discovered:true must not stand in for an actual visible descriptor')
  assert.ok(ready.problems.some((problem) => problem.startsWith('edit:') && problem.includes('descriptor')),
    JSON.stringify(ready.problems))
  assert.ok(!ready.problems.some((problem) => problem.startsWith('read:')),
    'the descriptor that is present is still validated on its own')
})

test('an accepted-risk list with no trustworthy decision record does not waive anything', () => {
  const probes = writableRootsProbes()

  const bare = assessFsReadiness(fullDiscovery, probes, { acceptedRisks: BOTH_WRITE_RISKS })
  assert.equal(bare.ready_for_paid_run, false)
  assert.deepEqual(bare.waivers_applied, [], 'a bare accepted-risk list is not a human decision')
  assert.equal(bare.problems.length, 2, JSON.stringify(bare.problems))
  assert.ok(bare.problems.every((problem) =>
    problem.includes('trustworthy evidence of a human decision')))

  // A real record that does not name the risk cannot stand in for one that does.
  const partial = assessFsReadiness(fullDiscovery, probes, {
    acceptedRisks: BOTH_WRITE_RISKS,
    waiver: decisionRecord(['source_directory_writable']),
  })
  assert.deepEqual(partial.waivers_applied.map((entry) => entry.risk), ['source_directory_writable'])
  assert.equal(partial.ready_for_paid_run, false)
  assert.ok(partial.problems.some((problem) =>
    problem.includes('the decision record does not name this risk')))
})

test('the finishing step can never be waived', () => {
  const probes = writableRootsProbes()
  // The two course roots are writable and explicitly accepted; the finishing step fails. Even an
  // explicit attempt to accept it leaves that problem standing.
  const ready = assessFsReadiness(fullDiscovery, {
    ...probes,
    output_copy_edit: probes.blockedVariants.output_copy_edit,
  }, {
    acceptedRisks: [
      'source_directory_writable', 'other_course_directory_writable', 'output_copy_edit_must_succeed',
    ],
    waiver: decisionRecord(BOTH_WRITE_RISKS),
  })
  assert.deepEqual(ready.problems,
    ['the scoped edit inside the new output copy did not succeed — the finishing step '
      + 'the instructions require is not exercisable'],
    JSON.stringify(ready.problems))
  assert.equal(ready.ready_for_paid_run, false)
  assert.deepEqual(ready.waivers_applied.map((entry) => entry.risk).sort(),
    ['other_course_directory_writable', 'source_directory_writable'],
    'only the two write-boundary risks were waived')
})

test('the preserved probe records recompute to a conclusive verdict under the corrected gate', async (t) => {
  // The evidence from the zero-cost readiness run stays on disk; the gate is re-run against it
  // rather than trusting what the original report wrote down. Both files are read-only here.
  //
  // `docs/` is repository-only by design (`tools/verify-distribution.mjs` asserts it never reaches
  // the tarball), so the packaged copy has nothing to recompute from. Absence of the *evidence* is
  // only acceptable when the whole design record is absent; a checkout that ships `docs/` and still
  // cannot find these files has lost its evidence and fails here.
  const readinessPath = new URL('../docs/qa/2026-10-12-source-grounded-notes/model-readiness.json', import.meta.url)
  const decisionPath = new URL('../docs/qa/2026-10-12-source-grounded-notes/fs-boundary-decision.json', import.meta.url)
  const available = await Promise.all([readinessPath, decisionPath].map((file) => fs.stat(file).catch(() => null)))
  if (available.every((stat) => stat === null)) {
    t.skip('local QA evidence is intentionally excluded from public checkouts and packages')
    return
  }

  const readiness = JSON.parse(await fs.readFile(
    new URL('../docs/qa/2026-10-12-source-grounded-notes/model-readiness.json', import.meta.url)))
  const decision = JSON.parse(await fs.readFile(
    new URL('../docs/qa/2026-10-12-source-grounded-notes/fs-boundary-decision.json', import.meta.url)))
  const probes = readiness.surface.fs_probes
  for (const key of ['output_copy_edit', 'source_directory_edit', 'other_course_edit']) {
    assert.equal(typeof probes[key], 'object', `${key} is preserved, not absent`)
    assert.equal(probes[key].inconclusive, false, `${key} is conclusive`)
    assert.match(probes[key].sha256_before, /^[0-9a-f]{64}$/, `${key} carries a usable before-digest`)
    assert.match(probes[key].sha256_after, /^[0-9a-f]{64}$/, `${key} carries a usable after-digest`)
    assert.equal(probes[key].bytes_changed, probes[key].sha256_before !== probes[key].sha256_after,
      `${key}: the recorded byte outcome agrees with its own digests — the preserved evidence is `
      + 'self-consistent, and this correction does not accuse it of contradiction')
  }

  const recomputed = assessFsReadiness(readiness.surface.host_fs_tools, probes, {
    acceptedRisks: decision.accepted_risks, waiver: decision,
  })
  assert.deepEqual(recomputed.problems, [], JSON.stringify(recomputed.problems))
  assert.equal(recomputed.ready_for_paid_run, true)
  assert.deepEqual(recomputed.waivers_applied.map((entry) => entry.risk).sort(),
    ['other_course_directory_writable', 'source_directory_writable'],
    'only the two observed write-boundary risks are waived, and only because the record names them')

  // Every recomputation report this block has written says the same thing, so a later reader is
  // never left with two different verdicts for the same evidence. Reports are added, not revised.
  const reviewDir = new URL('../docs/qa/2026-10-13-source-grounding-review/', import.meta.url)
  const reports = (await fs.readdir(reviewDir))
    .filter((name) => /^READINESS_RECOMPUTE[^/]*\.json$/.test(name)).sort()
  assert.ok(reports.length >= 1, 'at least one recomputation report is recorded')
  for (const name of reports) {
    const artifact = JSON.parse(await fs.readFile(new URL(name, reviewDir)))
    assert.equal(artifact.verdict.ready_for_paid_run, recomputed.ready_for_paid_run, name)
    assert.deepEqual(artifact.verdict.problems, recomputed.problems, name)
    assert.deepEqual(artifact.waivers_applied.map((entry) => entry.risk),
      recomputed.waivers_applied.map((entry) => entry.risk), name)
    assert.equal(artifact.paid_requests, 0, name)
    assert.ok(artifact.evidence_read_only.every((entry) => entry.unchanged === true),
      `${name}: the original records were read, never rewritten`)
  }
})

test('checkParameters names what a descriptor is missing', () => {
  const short = checkParameters({ parameters: { properties: { file_path: {} } } }, EXPECTED_PARAMETERS.edit)
  assert.equal(short.ok, false)
  assert.deepEqual(short.missing_required.sort(), ['new_string', 'old_string'])
  assert.equal(checkParameters({}, EXPECTED_PARAMETERS.read).ok, false)
})
