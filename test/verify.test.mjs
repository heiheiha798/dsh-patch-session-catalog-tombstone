/**
 * Tests for scripts/verify.mjs: the marker table must be green on a patched
 * tree and red (exit 1) on the pristine upstream bytes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { EXPECTED_FIXTURE, TARGET_FILES, fixturePath, freshFixtureRoot, readText, runScript } from './helpers.mjs'
import { ASSERTIONS } from '../scripts/spec.mjs'

test('verify fails on pristine fixtures and lists missing markers', (t) => {
  const root = freshFixtureRoot(t)
  const result = runScript('verify.mjs', ['--root', root])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /MISSING/)
  assert.match(result.stderr, /markers missing/)
  assert.match(result.stderr, /@deepseek-ai\/dsh-subagent/)
  assert.match(result.stderr, /verify failed/)
})

test('verify passes on patched fixtures and prints the full table', (t) => {
  const root = freshFixtureRoot(t)
  assert.equal(runScript('apply.mjs', ['--root', root]).status, 0)
  const result = runScript('verify.mjs', ['--root', root])
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.match(result.stdout, /verify passed/)
  assert.match(result.stdout, new RegExp(`${ASSERTIONS.length}/${ASSERTIONS.length} markers present`))
  for (const target of TARGET_FILES) {
    assert.match(result.stdout, new RegExp(target.package.replace(/[/@]/g, '\\$&')))
    assert.match(result.stdout, /0\.2\.2-rc\.5/)
  }
  // Every assertion id must appear exactly once in the table.
  for (const assertion of ASSERTIONS) {
    const rows = result.stdout.split('\n').filter((line) => line.includes(assertion.id))
    assert.equal(rows.length, 1, `assertion ${assertion.id} must have exactly one table row`)
  }
})

test('verify --root points at an alternate install root', (t) => {
  const root = freshFixtureRoot(t)
  assert.equal(runScript('apply.mjs', ['--root', root]).status, 0)
  // Expected fixture is a second, independent copy of a patched tree.
  const result = runScript('verify.mjs', ['--root', EXPECTED_FIXTURE])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readText(fixturePath(EXPECTED_FIXTURE, TARGET_FILES[0])).includes('removedCatalogSchema'), true)
})

test('verify fails when the install root is missing', (t) => {
  const result = runScript('verify.mjs', ['--root', '/nonexistent-tombstone-root'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /install root does not exist/)
})
