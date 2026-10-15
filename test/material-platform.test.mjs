import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { argvToCommand } from '../src/extract/backend.js'
import { pythonCandidates } from '../src/extract/runtime.js'

test('PowerShell argv uses call operator and literal single-quoted arguments', () => {
  assert.equal(argvToCommand(['C:\\Program Files\\python.exe', "C:\\notes\\it's.pdf", '$HOME;$(whoami)'], { platform: 'win32' }),
    "& 'C:\\Program Files\\python.exe' 'C:\\notes\\it''s.pdf' '$HOME;$(whoami)'")
})

test('Windows Python discovery includes payload root and Scripts layouts', () => {
  const candidates = pythonCandidates({ platform: 'win32', env: { DSH_PRIMARY_RUNTIME: '/runtime' }, homedir: '/home/example', pathDirs: [] })
  assert.ok(candidates.some(entry => entry.path === path.resolve('/runtime/dependencies/python/python.exe')))
  assert.ok(candidates.some(entry => entry.path === path.resolve('/runtime/dependencies/python/Scripts/python.exe')))
})
