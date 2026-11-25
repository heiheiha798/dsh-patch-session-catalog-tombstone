/**
 * Shared helpers for the node:test suite (not a test file itself).
 * Everything here is stdlib-only, matching the patch kit's zero-dependency rule.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { BACKUP_SUFFIX } from '../scripts/spec.mjs'

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const FIXTURES = join(REPO_ROOT, 'fixtures')
export const PRISTINE_FIXTURE = join(FIXTURES, 'pristine')
export const EXPECTED_FIXTURE = join(FIXTURES, 'expected')

/** The three patched package files, relative to an @deepseek-ai install root. */
export const TARGET_FILES = [
  { package: '@deepseek-ai/dsh-subagent', dir: 'dsh-subagent', file: 'lib/index.js' },
  { package: '@deepseek-ai/dsh-session-persistence-jsonl', dir: 'dsh-session-persistence-jsonl', file: 'lib/worker.cjs' },
  { package: '@deepseek-ai/dsh-session-format-v3-to-v4', dir: 'dsh-session-format-v3-to-v4', file: 'lib/index.js' },
]

export { BACKUP_SUFFIX }

/** Create a temp directory that is removed when the test finishes. */
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tombstone-kit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Fresh writable copy of the pristine fixture install root. */
export function freshFixtureRoot(t) {
  const root = join(tempDir(t), 'root')
  cpSync(PRISTINE_FIXTURE, root, { recursive: true })
  return root
}

/** Run one of the kit scripts with `node`, capturing stdout/stderr. */
export function runScript(name, args) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', name), ...args], { encoding: 'utf8' })
}

export const readText = (file) => readFileSync(file, 'utf8')
export const backupOf = (file) => file + BACKUP_SUFFIX
export const fixturePath = (root, { dir, file }) => join(root, dir, file)
