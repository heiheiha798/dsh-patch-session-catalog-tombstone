/**
 * Behavioural tests for scripts/apply.mjs, driven entirely by the synthetic
 * fixture tree in fixtures (trimmed regions of the real 0.2.1-rc.5
 * bundles).  No test touches the live installation.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  EXPECTED_FIXTURE,
  PRISTINE_FIXTURE,
  TARGET_FILES,
  backupOf,
  fixturePath,
  freshFixtureRoot,
  readText,
  runScript,
  tempDir,
} from './helpers.mjs'

test('apply patches every fixture file byte-exactly and writes one backup', (t) => {
  const root = freshFixtureRoot(t)
  const result = runScript('apply.mjs', ['--root', root])
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)

  for (const target of TARGET_FILES) {
    const patched = fixturePath(root, target)
    const expected = fixturePath(EXPECTED_FIXTURE, target)
    const pristine = fixturePath(PRISTINE_FIXTURE, target)
    assert.equal(
      readText(patched),
      readText(expected),
      `${target.dir}/${target.file}: patched output must byte-match fixtures/expected`,
    )
    assert.ok(existsSync(backupOf(patched)), `${target.dir}/${target.file}: backup must exist`)
    assert.equal(
      readText(backupOf(patched)),
      readText(pristine),
      `${target.dir}/${target.file}: backup must hold the pristine upstream bytes`,
    )
  }
  assert.match(result.stdout, /\[patched\]/)
  assert.match(result.stdout, /tombstone patch applied/)
})

test('second run reports already applied and changes nothing', (t) => {
  const root = freshFixtureRoot(t)
  const first = runScript('apply.mjs', ['--root', root])
  assert.equal(first.status, 0, first.stderr)

  const before = TARGET_FILES.map((target) => readText(fixturePath(root, target)))
  const second = runScript('apply.mjs', ['--root', root])
  assert.equal(second.status, 0, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`)
  assert.match(second.stdout, /already applied/)
  assert.doesNotMatch(second.stdout, /\[patched\]/)
  for (const target of TARGET_FILES) {
    assert.equal(
      readText(fixturePath(root, target)),
      before[TARGET_FILES.indexOf(target)],
      `${target.dir}/${target.file}: second run must be a no-op`,
    )
    assert.equal(
      readText(backupOf(fixturePath(root, target))),
      readText(fixturePath(PRISTINE_FIXTURE, target)),
      `${target.dir}/${target.file}: backup must stay pristine on re-runs`,
    )
  }
})

test('--dry-run writes nothing and reports intent', (t) => {
  const root = freshFixtureRoot(t)
  const result = runScript('apply.mjs', ['--root', root, '--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[dry-run\].*would apply/)

  for (const target of TARGET_FILES) {
    assert.equal(
      readText(fixturePath(root, target)),
      readText(fixturePath(PRISTINE_FIXTURE, target)),
      `${target.dir}/${target.file}: dry run must not write`,
    )
    assert.equal(existsSync(backupOf(fixturePath(root, target))), false, 'dry run must not create backups')
  }
  assert.match(result.stdout, /nothing written/)
})

test('missing upstream anchor fails closed, naming package/file/marker/version', (t) => {
  const root = freshFixtureRoot(t)
  const victim = fixturePath(root, TARGET_FILES[0])
  const original = readText(victim)
  const mutated = original.replace(
    'const eventDataSchema = z$1.union([',
    'const eventDataSchema = z$1.union([ /* upstream drift */',
  )
  assert.notEqual(mutated, original)
  writeFileSync(victim, mutated)

  const result = runScript('apply.mjs', ['--root', root])
  assert.notEqual(result.status, 0, 'apply must exit non-zero when an anchor is missing')
  const output = `${result.stdout}\n${result.stderr}`
  assert.match(output, /@deepseek-ai\/dsh-subagent/)
  assert.match(output, /lib\/index\.js/)
  assert.match(output, /removedCatalogSchema/)
  assert.match(output, /0\.2\.1-rc\.5/)
  assert.match(output, /no files were written/)

  // Fail-closed: no target file may be written when any preflight check fails.
  for (const target of TARGET_FILES) {
    assert.equal(readText(fixturePath(root, target)).includes('const removed = new Set();'), false)
    assert.equal(existsSync(backupOf(fixturePath(root, target))), false)
  }
})

test('partially patched tree fails closed instead of patching over it', (t) => {
  const root = freshFixtureRoot(t)
  assert.equal(runScript('apply.mjs', ['--root', root]).status, 0)
  const victim = fixturePath(root, TARGET_FILES[0])
  const mutated = readText(victim).split('\n').filter((line) => line !== '\tconst removed = new Set();').join('\n')
  writeFileSync(victim, mutated)

  const result = runScript('apply.mjs', ['--root', root])
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /partially patched/)
  // The other two files keep their already-applied state untouched.
  for (const target of TARGET_FILES.slice(1)) {
    assert.equal(
      readText(fixturePath(root, target)),
      readText(fixturePath(EXPECTED_FIXTURE, target)),
      `${target.dir}/${target.file}: must not be rewritten`,
    )
  }
})

test('--check distinguishes pristine from patched', (t) => {
  const root = freshFixtureRoot(t)
  const pristineCheck = runScript('apply.mjs', ['--root', root, '--check'])
  assert.equal(pristineCheck.status, 1)
  assert.match(pristineCheck.stdout, /pristine upstream - patch not applied/)

  assert.equal(runScript('apply.mjs', ['--root', root]).status, 0)
  const patchedCheck = runScript('apply.mjs', ['--root', root, '--check'])
  assert.equal(patchedCheck.status, 0, `stdout:\n${patchedCheck.stdout}\nstderr:\n${patchedCheck.stderr}`)
  assert.match(patchedCheck.stdout, /check passed/)
})

test('--version prints every installed target package version', (t) => {
  const root = freshFixtureRoot(t)
  const result = runScript('apply.mjs', ['--root', root, '--version'])
  assert.equal(result.status, 0, result.stderr)
  for (const target of TARGET_FILES) {
    assert.match(result.stdout, new RegExp(target.package.replace(/[/@]/g, '\\$&')))
  }
  assert.match(result.stdout, /0\.2\.1-rc\.5/)
})

test('missing install root is a non-zero, non-writing failure', (t) => {
  const root = join(tempDir(t), 'does-not-exist')
  const result = runScript('apply.mjs', ['--root', root])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /install root does not exist/)
})
