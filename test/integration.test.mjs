/**
 * Optional integration test against the real 0.2.1-rc.5 package bundles.
 *
 * It only runs when the pristine upstream copies exist at /tmp/dshoff/x (or
 * $TOMBSTONE_PRISTINE_SRC) *and* a live patched install is present at the
 * official path (or $TOMBSTONE_LIVE_ROOT).  In CI both are absent, so this test
 * reports "skipped" instead of failing.  Nothing here writes outside a temp
 * directory.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_INSTALL_ROOT } from '../scripts/spec.mjs'
import { TARGET_FILES, backupOf, readText, runScript, tempDir } from './helpers.mjs'

const PRISTINE_SRC = process.env.TOMBSTONE_PRISTINE_SRC || '/tmp/dshoff/x'
const LIVE_ROOT = process.env.TOMBSTONE_LIVE_ROOT || DEFAULT_INSTALL_ROOT

const pristineDir = (target) => join(PRISTINE_SRC, `deepseek-ai-${target.dir}`)
const liveFile = (target) => join(LIVE_ROOT, target.dir, target.file)

const missingPristine = TARGET_FILES.filter((target) => !existsSync(pristineDir(target)))
const missingLive = TARGET_FILES.filter((target) => !existsSync(liveFile(target)))
const skipReason = missingPristine.length
  ? `requires real pristine package copies at ${PRISTINE_SRC}`
  : missingLive.length
    ? `requires a patched live install at ${LIVE_ROOT}`
    : false

test(
  'integration: applying to pristine 0.2.1-rc.5 packages reproduces the live patched files',
  { skip: skipReason },
  (t) => {
    const root = join(tempDir(t), 'root')
    for (const target of TARGET_FILES) {
      cpSync(pristineDir(target), join(root, target.dir), { recursive: true })
    }

    const first = runScript('apply.mjs', ['--root', root])
    assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`)

    for (const target of TARGET_FILES) {
      const patched = join(root, target.dir, target.file)
      assert.equal(
        readText(patched),
        readText(liveFile(target)),
        `${target.package}: apply output must byte-match the live patched file`,
      )
      assert.equal(
        readText(backupOf(patched)),
        readText(join(pristineDir(target), target.file)),
        `${target.package}: backup must hold the pristine upstream bytes`,
      )
    }

    const second = runScript('apply.mjs', ['--root', root])
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /already applied/)

    const verified = runScript('verify.mjs', ['--root', root])
    assert.equal(verified.status, 0, `stdout:\n${verified.stdout}\nstderr:\n${verified.stderr}`)
  },
)
