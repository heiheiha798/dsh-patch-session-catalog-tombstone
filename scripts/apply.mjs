#!/usr/bin/env node
/**
 * Apply the subagent catalog tombstone patch to an installed DeepSeek Harness
 * npm tree.
 *
 * Usage:
 *   node scripts/apply.mjs [--root <@deepseek-ai dir>] [--dry-run] [--check] [--version] [--help]
 *
 *   --root <dir>   @deepseek-ai scope directory to patch.  Resolution order when
 *                  omitted: $DSH_NODE_MODULES, $DSH_INSTALL_ROOT,
 *                  $_DSH_INSTALL_ROOT, then the official default install path.
 *   --dry-run      Report what would change; never write.
 *   --check        Verify only (implies no writes): exit 0 only when every
 *                  target file is fully patched.
 *   --version      Print every target package version and exit.
 *
 * The patch is exact-string based (never line numbers), so a moved hunk in a
 * newer upstream build fails loudly instead of corrupting the bundle.  A
 * `<file>.bak-before-tombstone` backup is written once per file.
 *
 * Node >= 22, zero dependencies.
 */

import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { TARGETS, VERIFIED_VERSIONS, backupPath, readInstalledVersion, resolveInstallRoot, targetPath } from './spec.mjs'

const USAGE = `Usage: node scripts/apply.mjs [options]

Apply the "retired subagent catalog row" patch to installed @deepseek-ai packages.

Options:
  --root <dir>   @deepseek-ai scope directory holding dsh-subagent,
                 dsh-session-persistence-jsonl and dsh-session-format-v3-to-v4.
                 Default: $DSH_NODE_MODULES || $DSH_INSTALL_ROOT ||
                 $_DSH_INSTALL_ROOT || the official dsh install.
  --dry-run      Show what would change; write nothing.
  --check        Verify only; exit 0 only if every target file is fully patched.
  --version      Print the installed version of every target package and exit.
  --help, -h     Show this help.

Exit codes: 0 success, 1 patch/verify failure, 2 usage error.`

function usageError(message) {
  process.stderr.write(`apply: ${message}\n\n${USAGE}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  const options = { root: null, dryRun: false, check: false, version: false, help: false }
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
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--check') {
      options.check = true
    } else if (arg === '--version') {
      options.version = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      usageError(`unknown argument: ${arg}`)
    }
  }
  return options
}

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1
const firstLine = (text) => text.split('\n')[0]
const label = (target) => `${target.package} (${target.dir}/${target.file})`

function describeVersion(root, target) {
  return readInstalledVersion(root, target) ?? 'not installed'
}

/**
 * Inspect one target file without writing.
 * @returns {object} status: 'applied' | 'pristine' | 'broken'
 */
function inspectTarget(root, target) {
  const file = targetPath(root, target)
  const version = readInstalledVersion(root, target)
  // A missing/unreadable package.json only degrades diagnostics (version shows
  // as "unknown"); the patch itself operates on the lib file alone.
  const result = { target, file, version, status: 'broken', rules: [], problems: [] }
  if (!existsSync(file)) {
    result.problems.push(`${file} does not exist`)
    return result
  }
  const text = readFileSync(file, 'utf8')
  for (const rule of target.rules) {
    const markers = countOccurrences(text, rule.marker)
    const anchors = countOccurrences(text, rule.anchor)
    result.rules.push({ rule, markers, anchors })
  }
  // Insertion-style rules keep their anchor (they prepend a block to it), so
  // "applied" is decided by markers only; pristine additionally requires every
  // anchor to still be present exactly once.
  const allApplied = result.rules.every((r) => r.markers === 1)
  const noMarkers = result.rules.every((r) => r.markers === 0)
  if (allApplied) {
    result.status = 'applied'
    return result
  }
  if (noMarkers) {
    let anchorsOk = true
    for (const r of result.rules) {
      if (r.anchors === 1) continue
      anchorsOk = false
      result.problems.push(
        `${target.package} ${target.file}: upstream anchor for rule "${r.rule.id}" ` +
          `(marker ${JSON.stringify(firstLine(r.rule.marker))}) ` +
          `occurs ${r.anchors} times, expected exactly 1; installed version ${version ?? 'unknown'}. ` +
          'Refusing to patch - re-derive the anchor against the new upstream build.',
      )
    }
    if (anchorsOk) result.status = 'pristine'
    return result
  }
  // Some markers present and some absent: never patch over a half-applied tree.
  for (const r of result.rules) {
    if (r.markers !== 1) {
      result.problems.push(
        `${target.package} ${target.file}: partially patched - rule "${r.rule.id}" ` +
          `(marker ${JSON.stringify(firstLine(r.rule.marker))}) is missing; ` +
          `installed version ${version ?? 'unknown'}. ` +
          'Restore ' + backupPath(root, target) + ' (or reinstall) before applying.',
      )
    }
  }
  return result
}

function writeAtomic(file, content) {
  const tmp = `${file}.tombstone-${process.pid}.tmp`
  const mode = statSync(file).mode
  writeFileSync(tmp, content, 'utf8')
  chmodSync(tmp, mode)
  renameSync(tmp, file)
}

function runVersion(root, out) {
  out.write(`install root: ${root}\n\n`)
  let ok = true
  for (const target of TARGETS) {
    const version = readInstalledVersion(root, target)
    const verified = VERIFIED_VERSIONS[target.package] ?? 'unknown'
    if (version === null) ok = false
    out.write(
      `${target.package.padEnd(46)} ${String(version ?? 'not installed').padEnd(14)} verified-against: ${verified}\n`,
    )
  }
  return ok ? 0 : 1
}

function runCheck(root, out, err) {
  const results = TARGETS.map((target) => inspectTarget(root, target))
  out.write(`install root: ${root}\n\n`)
  let ok = true
  for (const result of results) {
    const { target } = result
    if (result.status === 'applied') {
      out.write(`[ok]      ${label(target)}: patched (${target.rules.length}/${target.rules.length} rules, version ${describeVersion(root, target)})\n`)
    } else {
      ok = false
      out.write(`[missing] ${label(target)}: ${result.status === 'pristine' ? 'pristine upstream - patch not applied' : 'invalid patch state'}\n`)
      for (const problem of result.problems) err.write(`  - ${problem}\n`)
    }
  }
  out.write(`\n${ok ? 'check passed: tombstone patch is fully applied.' : 'check failed: run node scripts/apply.mjs'}\n`)
  return ok ? 0 : 1
}

function runPatch(root, options, out, err) {
  const results = TARGETS.map((target) => inspectTarget(root, target))
  const broken = results.filter((result) => result.status === 'broken')
  out.write(`install root: ${root}\n\n`)
  if (broken.length > 0) {
    for (const result of broken) {
      err.write(`[error]   ${label(result.target)}\n`)
      for (const problem of result.problems) err.write(`          ${problem}\n`)
    }
    err.write('\napply aborted: no files were written.\n')
    return 1
  }

  let patchedCount = 0
  for (const result of results) {
    const { target } = result
    const file = result.file
    if (result.status === 'applied') {
      out.write(`[applied] ${label(target)}: already applied (${target.rules.length}/${target.rules.length} rules) - skipped\n`)
      continue
    }
    const backup = backupPath(root, target)
    if (options.dryRun) {
      out.write(`[dry-run] ${label(target)}: would apply ${target.rules.length} rule(s) to ${file}\n`)
      continue
    }
    let text = readFileSync(file, 'utf8')
    for (const rule of target.rules) {
      const occurrences = countOccurrences(text, rule.anchor)
      if (occurrences !== 1) {
        // Unreachable after inspectTarget, kept as a hard guard against a race.
        err.write(`[error] ${target.package} ${target.file}: anchor for rule "${rule.id}" occurred ${occurrences} times\n`)
        err.write('apply aborted.\n')
        return 1
      }
      text = text.replace(rule.anchor, rule.replacement)
    }
    if (existsSync(backup)) {
      out.write(`[backup]  ${backup}: exists - kept as-is\n`)
    } else {
      copyFileSync(file, backup)
      chmodSync(backup, statSync(file).mode)
      out.write(`[backup]  ${backup}: created\n`)
    }
    writeAtomic(file, text)
    const after = inspectTarget(root, target)
    if (after.status !== 'applied') {
      err.write(`[error] ${label(target)}: post-write verification failed; restore ${backup}\n`)
      return 1
    }
    out.write(`[patched] ${label(target)}: applied ${target.rules.length} rule(s)\n`)
    patchedCount += 1
  }
  if (options.dryRun) {
    out.write('\ndry run: nothing written. Run without --dry-run to apply.\n')
  } else if (patchedCount === 0) {
    out.write('\nnothing to do: the tombstone patch is already applied to every target.\n')
  } else {
    out.write('\ntombstone patch applied. Verify with: node scripts/verify.mjs\n')
  }
  return 0
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const root = resolveInstallRoot(options.root)
  if (!existsSync(root)) {
    process.stderr.write(`apply: install root does not exist: ${root}\n`)
    return 1
  }
  if (options.version) return runVersion(root, process.stdout)
  if (options.check) return runCheck(root, process.stdout, process.stderr)
  return runPatch(root, options, process.stdout, process.stderr)
}

process.exitCode = main()
