#!/usr/bin/env node
/**
 * Verify that the subagent catalog tombstone patch is present in an installed
 * DeepSeek Harness npm tree.
 *
 * Usage:
 *   node scripts/verify.mjs [--root <@deepseek-ai dir>]
 *
 * Checks every marker (byte-exact snippet that only exists after patching) in
 * all three patched files, prints a table and exits 0 (all present) or 1.
 * This is read-only: it never writes and never executes the bundles.
 *
 * Node >= 22, zero dependencies.
 */

import { existsSync, readFileSync } from 'node:fs'
import {
  ASSERTIONS,
  TARGETS,
  VERIFIED_VERSIONS,
  readInstalledVersion,
  resolveInstallRoot,
  targetPath,
} from './spec.mjs'

const USAGE = `Usage: node scripts/verify.mjs [--root <dir>]

Verify the subagent catalog tombstone patch is applied.

  --root <dir>   @deepseek-ai scope directory (default: $DSH_NODE_MODULES ||
                 $DSH_INSTALL_ROOT || $_DSH_INSTALL_ROOT || official install).
  --help, -h     Show this help.

Exit codes: 0 all markers present, 1 any marker missing or file unreadable.`

function usageError(message) {
  process.stderr.write(`verify: ${message}\n\n${USAGE}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  const options = { root: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) usageError('--root requires a directory')
      options.root = value
      i += 1
    } else if (arg.startsWith('--root=')) {
      options.root = arg.slice('--root='.length)
      if (!options.root) usageError('--root requires a directory')
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      usageError(`unknown argument: ${arg}`)
    }
  }
  return options
}

const pad = (text, width) => String(text).padEnd(width)

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const root = resolveInstallRoot(options.root)
  if (!existsSync(root)) {
    process.stderr.write(`verify: install root does not exist: ${root}\n`)
    return 1
  }

  process.stdout.write(`install root: ${root}\n\n`)

  const cache = new Map()
  const readTarget = (index) => {
    if (cache.has(index)) return cache.get(index)
    const target = TARGETS[index]
    const file = targetPath(root, target)
    const entry = {
      target,
      file,
      version: readInstalledVersion(root, target),
      text: existsSync(file) ? readFileSync(file, 'utf8') : null,
    }
    cache.set(index, entry)
    return entry
  }

  const widths = { pkg: 44, file: 18, version: 12, id: 38 }
  process.stdout.write(
    `${pad('package', widths.pkg)} ${pad('file', widths.file)} ${pad('version', widths.version)} ${pad('assertion', widths.id)} status\n`,
  )
  process.stdout.write(`${'-'.repeat(widths.pkg + widths.file + widths.version + widths.id + 18)}\n`)

  const failures = []
  const versionNotes = new Set()
  for (const assertion of ASSERTIONS) {
    const entry = readTarget(assertion.targetIndex)
    const { target } = entry
    let ok = false
    if (entry.text === null) {
      failures.push({ assertion, entry, reason: `file does not exist: ${entry.file}` })
    } else if (!entry.text.includes(assertion.marker)) {
      failures.push({ assertion, entry, reason: 'marker not found' })
    } else {
      ok = true
    }
    if (ok && entry.version && VERIFIED_VERSIONS[target.package] && entry.version !== VERIFIED_VERSIONS[target.package]) {
      versionNotes.add(`${target.package} ${entry.version} (verified against ${VERIFIED_VERSIONS[target.package]})`)
    }
    process.stdout.write(
      `${pad(target.package, widths.pkg)} ${pad(target.file, widths.file)} ${pad(entry.version ?? 'unknown', widths.version)} ${pad(assertion.id, widths.id)} ${ok ? 'ok' : 'MISSING'}\n`,
    )
  }

  for (const note of versionNotes) {
    process.stdout.write(`\nnote: installed version differs from the verified baseline: ${note}\n`)
  }

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length}/${ASSERTIONS.length} markers missing:\n`)
    for (const { assertion, entry, reason } of failures) {
      process.stderr.write(`\n  ${statement(assertion, entry)}: ${reason}\n`)
      process.stderr.write(`  expected marker (${assertion.id}):\n`)
      for (const line of assertion.marker.split('\n')) process.stderr.write(`    ${line}\n`)
      process.stderr.write(`  installed version: ${entry.version ?? 'unknown'}\n`)
    }
    process.stderr.write('\nverify failed: run node scripts/apply.mjs\n')
    return 1
  }

  process.stdout.write(`\n${ASSERTIONS.length}/${ASSERTIONS.length} markers present across ${TARGETS.length} files.\nverify passed.\n`)
  return 0
}

function statement(assertion, entry) {
  return `${entry.target.package} (${entry.target.dir}/${entry.target.file}) :: ${assertion.label}`
}

process.exitCode = main()
