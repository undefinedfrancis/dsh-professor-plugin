import assert from 'node:assert/strict'
import test from 'node:test'
import { isReleaseVersion } from '../tools/release-version.mjs'

test('release metadata accepts a Beta tag without accepting malformed versions', () => {
  for (const value of ['0.12.0', '0.12.0-beta.1', '1.0.0-rc.0', '2.0.0-beta.2+build.001']) {
    assert.equal(isReleaseVersion(value), true, value)
  }
  for (const value of ['v0.12.0', '01.2.3', '1.2', '1.2.3-01', '1.2.3-', '1.2.3-beta..1', '1.2.3+']) {
    assert.equal(isReleaseVersion(value), false, value)
  }
})
