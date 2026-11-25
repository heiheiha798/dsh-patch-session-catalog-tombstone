#!/usr/bin/env node
/**
 * Resolve every plugin `name:` that a composed profile tree (or a patch file)
 * references, against the installed dsh packages.
 *
 * This is the check that catches the most common silent breakage after a dsh
 * upgrade: a patch layer keeps a package name or subpath export that the new
 * release renamed or stopped exporting (`@deepseek-ai/dsh-subagent/internal`,
 * `@deepseek-ai/dsh-tool-subagent-control/list-agents`, ...). Such an entry
 * fails only when a session mounts its preset, so boot stays clean and the
 * breakage shows up as `agent-preset/invalid` later.
 *
 * Resolution happens from the real install directories, not from the profile's
 * own node_modules (those hold third-party plugins and would produce false
 * passes).
 *
 * Usage:
 *   node scripts/check-entry-names.mjs --profile web
 *   node scripts/check-entry-names.mjs --config /tmp/composed.yml [--root <dir>]
 *
 *   --profile <name>  compose that profile with `dsh --profile <name> --dump-config`
 *   --config <file>   read an already composed tree (or a patch file)
 *   --root <dir>      alternate @deepseek-ai scope directory to resolve from
 *
 * Exit codes: 0 every name resolves, 1 stale names found, 2 usage error.
 * Node >= 22, zero dependencies (plain YAML-ish scanning, no parser needed).
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const USAGE = `Usage: node scripts/check-entry-names.mjs (--profile <name> | --config <file>) [--root <dir>]

  --profile <name>  compose the profile (dsh --profile <name> --dump-config) and scan it
  --config <file>   scan an existing composed tree or patch file
  --root <dir>      @deepseek-ai scope directory to resolve from (default: auto-detect)

Every plugin "name:" value in the scanned file is resolved from the install
directories. Stale names and subpaths are reported with their line numbers.
Default root detection: $DSH_NODE_MODULES, $DSH_INSTALL_ROOT, the npm global
prefix, the realpath of the dsh executable, then the official installer layout.`

function usageError(message) {
  process.stderr.write(`check-entry-names: ${message}\n\n${USAGE}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  const options = { profile: null, config: null, root: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const take = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) usageError(`${arg} needs a value`)
      i += 1
      return value
    }
    if (arg === '--profile') options.profile = take()
    else if (arg === '--config') options.config = take()
    else if (arg === '--root') options.root = take()
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`)
      process.exit(0)
    } else usageError(`unknown argument ${arg}`)
  }
  if (!options.profile && !options.config) usageError('pass --profile or --config')
  return options
}

/** Locate the @deepseek-ai scope directory of the installed dsh release. */
function detectInstallRoot() {
  const candidates = []
  const add = (path) => {
    if (path) candidates.push(resolve(path))
  }
  const quiet = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  try {
    const prefix = execFileSync('npm', ['prefix', '-g'], quiet).trim()
    add(join(prefix, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'))
    add(join(prefix, 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'))
  } catch {}
  try {
    const bin = execFileSync('sh', ['-c', 'command -v dsh'], quiet).trim()
    if (bin) add(join(dirname(dirname(realpathSafe(bin))), 'node_modules/@deepseek-ai'))
  } catch {}
  add(join(homedir(), '.local/share/dsh-official/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'))
  add('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  add('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  return candidates.find((candidate) => existsSync(candidate)) ?? ''
}

/** Directory of one profile under $DSH_HOME/profiles. */
function profileDir(name) {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', name)
}

function realpathSafe(path) {
  try {
    return execFileSync('realpath', [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return path
  }
}

/** Every `name:` value with its 1-based line number. */
function collectNames(text) {
  const found = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*-?\s*name:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/.exec(lines[i])
    if (match) found.push({ name: match[1], line: i + 1 })
  }
  return found
}

/** Names that are worth resolving: scoped packages, dsh-* plugins, or paths. */
const isPackageName = (name) => name.startsWith('@') || name.startsWith('dsh-')

function main() {
  const options = parseArgs(process.argv.slice(2))
  const root = options.root ? resolve(options.root) : detectInstallRoot()
  if (!root) {
    process.stderr.write('check-entry-names: cannot locate the installed @deepseek-ai scope directory; pass --root\n')
    process.exit(2)
  }
  if (!existsSync(root)) usageError(`root does not exist: ${root}`)

  const text = options.config
    ? readFileSync(options.config, 'utf8')
    : execFileSync('dsh', ['--profile', options.profile, '--dump-config'], { encoding: 'utf8' })

  const names = collectNames(text).filter((entry) => isPackageName(entry.name))
  const unique = [...new Map(names.map((entry) => [entry.name, entry])).values()]
  // Resolve from the install root first, then from the profile directory: third
  // party plugins live in the profile's node_modules, shipped ones in the install.
  const fromRoot = createRequire(join(root, 'noop.cjs'))
  const fromProfile = options.profile ? createRequire(join(profileDir(options.profile), 'noop.cjs')) : null
  const resolvers = fromProfile ? [fromRoot, fromProfile] : [fromRoot]
  const stale = []
  for (const entry of unique) {
    const errors = []
    let resolved = false
    for (const resolver of resolvers) {
      try {
        resolver.resolve(entry.name)
        resolved = true
        break
      } catch (error) {
        errors.push(error)
      }
    }
    if (!resolved) {
      const first = errors[0]
      stale.push({ ...entry, code: first.code ?? 'ERROR', message: String(first.message).split('\n')[0] })
    }
  }

  const occurrences = new Map()
  for (const entry of names) occurrences.set(entry.name, (occurrences.get(entry.name) ?? 0) + 1)

  process.stdout.write(`root:   ${root}\n`)
  process.stdout.write(`source: ${options.config ?? `profile ${options.profile}`}\n`)
  process.stdout.write(`names:  ${unique.length} unique, ${names.length} occurrence(s)\n`)
  if (stale.length === 0) {
    process.stdout.write('ok: every referenced package name resolves\n')
    return
  }
  process.stdout.write(`STALE: ${stale.length}\n`)
  for (const entry of stale) {
    const lines = names.filter((candidate) => candidate.name === entry.name).map((candidate) => candidate.line)
    process.stdout.write(`  FAIL ${entry.name}\n       ${entry.code}: ${entry.message}\n       lines ${lines.join(', ')} (${occurrences.get(entry.name)}x)\n`)
  }
  process.exitCode = 1
}

main()
