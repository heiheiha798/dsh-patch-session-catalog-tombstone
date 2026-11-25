/**
 * Optional integration test against the real 0.2.2-rc.5 package bundles.
 *
 * It only runs when the installed upstream packages exist at the official dsh
 * path (or $TOMBSTONE_LIVE_ROOT points at another @deepseek-ai scope
 * directory).  The source install is never written: the target files are
 * copied into a temp root first.  In CI the install is absent, so this test
 * reports "skipped" instead of failing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DEFAULT_INSTALL_ROOT } from '../scripts/spec.mjs'
import { TARGET_FILES, backupOf, readText, runScript, tempDir } from './helpers.mjs'

const LIVE_ROOT = process.env.TOMBSTONE_LIVE_ROOT || DEFAULT_INSTALL_ROOT || '/nonexistent-dsh-install'

const liveFile = (target) => join(LIVE_ROOT, target.dir, target.file)
const missingLive = TARGET_FILES.filter((target) => !existsSync(liveFile(target)))
const skipReason = missingLive.length
  ? `requires the real installed packages at ${LIVE_ROOT}`
  : false

/** Copy just the tested package metadata and bundle into a temp install root. */
function stagePristineRoot(root) {
  for (const target of TARGET_FILES) {
    const file = join(root, target.dir, target.file)
    mkdirSync(dirname(file), { recursive: true })
    cpSync(liveFile(target), file)
    cpSync(join(LIVE_ROOT, target.dir, 'package.json'), join(root, target.dir, 'package.json'))
  }
}

test(
  'integration: applying to a copy of the installed 0.2.2-rc.5 bundles converges and is idempotent',
  { skip: skipReason },
  (t) => {
    const root = join(tempDir(t), 'root')
    stagePristineRoot(root)

    const pristineCheck = runScript('apply.mjs', ['--root', root, '--check'])
    assert.equal(pristineCheck.status, 1, 'the staged copy must start pristine')
    assert.match(pristineCheck.stdout, /pristine upstream - patch not applied/)

    const before = new Map(TARGET_FILES.map((target) => [target, readText(liveFile(target))]))

    const first = runScript('apply.mjs', ['--root', root])
    assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`)
    assert.match(first.stdout, /\[patched\]/)

    // Every patched file must differ from upstream and carry its backup.
    for (const target of TARGET_FILES) {
      const patched = join(root, target.dir, target.file)
      assert.notEqual(readText(patched), before.get(target), `${target.package}: bundle must change`)
      assert.ok(existsSync(backupOf(patched)), `${target.package}: backup must exist`)
      assert.equal(readText(backupOf(patched)), before.get(target), `${target.package}: backup must hold pristine bytes`)
      assert.equal(
        readText(liveFile(target)),
        before.get(target),
        `${target.package}: the source install must never be modified`,
      )
    }

    const checked = runScript('apply.mjs', ['--root', root, '--check'])
    assert.equal(checked.status, 0, `stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`)

    const verified = runScript('verify.mjs', ['--root', root])
    assert.equal(verified.status, 0, `stdout:\n${verified.stdout}\nstderr:\n${verified.stderr}`)

    const patchedBytes = TARGET_FILES.map((target) => readText(join(root, target.dir, target.file)))
    const second = runScript('apply.mjs', ['--root', root])
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /already applied/)
    assert.doesNotMatch(second.stdout, /\[patched\]/)
    TARGET_FILES.forEach((target, index) => {
      assert.equal(
        readText(join(root, target.dir, target.file)),
        patchedBytes[index],
        `${target.package}: second apply must be a byte-level no-op`,
      )
    })
  },
)
