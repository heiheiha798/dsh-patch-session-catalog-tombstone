/**
 * Single source of truth for the "retired subagent catalog row" (tombstone)
 * patch kit.
 *
 * The patch is applied by exact-string substitution, never by line numbers:
 * every rule carries a pristine `anchor` snippet (asserted to occur exactly
 * once) and the `replacement` that must take its place.  A rule's `marker` is
 * a short snippet that only exists *after* the rule has been applied, so the
 * scripts can tell "pristine", "already applied" and "partially applied"
 * apart without ever running the patched code.
 *
 * No dependencies, no side effects: this module only exports data plus a few
 * filesystem helpers shared by scripts/apply.mjs, scripts/verify.mjs and the
 * test suite.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Locate the `@deepseek-ai` scope directory of the official dsh install.
 *
 * Candidates, first existing wins: the global npm prefix (`npm prefix -g`),
 * the real path of the `dsh` executable (`<prefix>/lib/node_modules/
 * @deepseek-ai/dsh/lib/bin.js`), then the usual Linux/Homebrew prefixes.
 * Anything here can be overridden with `--root` or the DSH_* variables.
 */
export function detectInstallRoot() {
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
    if (bin) add(join(dirname(dirname(realpathSync(bin))), 'node_modules/@deepseek-ai'))
  } catch {}
  add(join(homedir(), '.local/share/dsh-official/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'))
  add('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  add('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  return candidates.find((candidate) => existsSync(candidate)) ?? ''
}

/** Fallback install root; '' when detection fails (pass --root or set DSH_INSTALL_ROOT). */
export const DEFAULT_INSTALL_ROOT = detectInstallRoot()

/** Backup suffix written next to a patched file, exactly once. */
export const BACKUP_SUFFIX = '.bak-before-tombstone'

/** Packages whose published 0.2.2-rc.5 bundles this kit knows how to patch. */
export const VERIFIED_VERSIONS = {
  '@deepseek-ai/dsh-subagent': '0.2.2-rc.5',
  '@deepseek-ai/dsh-session-persistence-jsonl': '0.2.2-rc.5',
  '@deepseek-ai/dsh-session-format-v3-to-v4': '0.2.2-rc.5',
}

/** Indentation helper: the published bundles are tab-indented. */
const t = (depth, text) => '\t'.repeat(depth) + text

/**
 * Build one multi-line snippet.  Written as explicit line arrays (instead of
 * template literals) so that the exact indentation of the minified bundles is
 * visible and reviewable in this file.
 */
const lines = (...parts) => parts.join('\n')

/**
 * The v3 "removed" catalog fact validator inserted at the top of the compiled
 * `nativeCatalogFact`.  0.2.2 routes every native v3 `subagent/catalog`
 * payload through `nativeCatalogFact` (which only delegates older versions to
 * `catalogFact`), so the tombstone has to be admitted here rather than in
 * `catalogFact`.  Shape matches what the producer appends:
 * `{ version: 3, childId, childCreatedAt, mode: "removed" }` with no `name`.
 */
const NATIVE_REMOVED_GUARD = [
  t(1, 'if (isSessionFormatJsonObject(value) && value["version"] === 3 && value["mode"] === "removed" && typeof value["childId"] === "string" && (value["label"] === void 0 || typeof value["label"] === "string")) {'),
  t(2, 'sessionFormatCount(value["childCreatedAt"], "catalog child creation time");'),
  t(2, 'return value;'),
  t(1, '}'),
]

/**
 * The v4 relationship validator block that collects catalog child ids.
 *
 * 0.2.2 added a sibling `names` set (v3 facts carry a unique `name`).  The
 * tombstone has to retire both: `ids.delete(id)` keeps duplicate detection
 * correct, and `namesById` releases the name so a deleted child's name can be
 * reused without turning the parent Session into an unrestorable
 * "duplicate catalog child name" log.
 */
const RELATIONSHIP_TOMBSTONE_BLOCK = [
  t(3, 'const fact = nativeCatalogFact(event.data);'),
  t(3, 'const id = fact["childId"];'),
  t(3, 'if (fact["mode"] === "removed") {'),
  t(4, 'ids.delete(id);'),
  t(4, 'const retiredName = namesById.get(id);'),
  t(4, 'if (retiredName !== void 0) {'),
  t(5, 'names.delete(retiredName);'),
  t(5, 'namesById.delete(id);'),
  t(4, '}'),
  t(4, 'continue;'),
  t(3, '}'),
  t(3, 'if (ids.has(id)) throw new SessionFormatError(`duplicate catalog child ${id}`);'),
  t(3, 'ids.add(id);'),
  t(3, 'if (fact["name"] === void 0) continue;'),
  t(3, 'const name = fact["name"];'),
  t(3, 'if (names.has(name)) throw new SessionFormatError(`duplicate catalog child name ${name}`);'),
  t(3, 'names.add(name);'),
  t(3, 'namesById.set(id, name);'),
]

/** Rules that turn the pristine bundles into the tombstone-aware bundles. */
export const RULES = [
  {
    id: 'subagent.catalog-v3-schema',
    description: 'declare the v3 "removed" catalog fact and admit it to the event union',
    marker: lines(
      'const removedCatalogSchema = oneShotCatalogSchema.extend({',
      t(1, 'version: z$1.literal(3),'),
      t(1, 'mode: z$1.literal("removed")'),
      '});',
    ),
    anchor: lines(
      'const eventDataSchema = z$1.union([',
      t(1, 'oneShotCatalogSchema,'),
      t(1, 'externalCatalogSchema,'),
      t(1, 'continuableCatalogSchema,'),
      t(1, 'unknownCatalogSchema,'),
      t(1, 'namedContinuableCatalogSchema,'),
      t(1, 'namedExternalCatalogSchema'),
      ']);',
    ),
    replacement: lines(
      'const removedCatalogSchema = oneShotCatalogSchema.extend({',
      t(1, 'version: z$1.literal(3),'),
      t(1, 'mode: z$1.literal("removed")'),
      '});',
      'const eventDataSchema = z$1.union([',
      t(1, 'oneShotCatalogSchema,'),
      t(1, 'externalCatalogSchema,'),
      t(1, 'continuableCatalogSchema,'),
      t(1, 'unknownCatalogSchema,'),
      t(1, 'namedContinuableCatalogSchema,'),
      t(1, 'namedExternalCatalogSchema,'),
      t(1, 'removedCatalogSchema'),
      ']);',
    ),
  },
  {
    id: 'subagent.catalog-entries-collect',
    description: 'collect tombstoned child ids while folding the append-only catalog log',
    marker: lines(t(1, 'const removed = new Set();'), t(1, 'for (const data of iterateChunkedList(state.head)) {')),
    anchor: lines(
      'function subagentCatalogEntries(state) {',
      t(1, 'const entries = [];'),
      t(1, 'for (const data of iterateChunkedList(state.head)) {'),
    ),
    replacement: lines(
      'function subagentCatalogEntries(state) {',
      t(1, 'const entries = [];'),
      t(1, 'const removed = new Set();'),
      t(1, 'for (const data of iterateChunkedList(state.head)) {'),
      t(2, 'if (data.mode === "removed") {'),
      t(3, 'removed.add(data.childId);'),
      t(3, 'continue;'),
      t(2, '}'),
    ),
  },
  {
    id: 'subagent.catalog-entries-filter',
    description: 'retract retired rows from the published catalog view',
    marker: lines(t(1, 'return removed.size === 0 ? entries : entries.filter((entry) => !removed.has(entry.id));')),
    anchor: lines(t(2, '});'), t(1, '}'), t(1, 'return entries;'), '}'),
    replacement: lines(
      t(2, '});'),
      t(1, '}'),
      t(1, 'return removed.size === 0 ? entries : entries.filter((entry) => !removed.has(entry.id));'),
      '}',
    ),
  },
  {
    id: 'subagent.catalog-state-version',
    description: 'bump the catalog projection stateVersion from 6 to 7',
    marker: lines(t(1, 'stateVersion: 7,'), t(1, 'wire: {'), t(2, 'viewSchema,'), t(2, 'view: subagentCatalogEntries')),
    anchor: lines(t(1, 'stateVersion: 6,'), t(1, 'wire: {'), t(2, 'viewSchema,'), t(2, 'view: subagentCatalogEntries')),
    replacement: lines(t(1, 'stateVersion: 7,'), t(1, 'wire: {'), t(2, 'viewSchema,'), t(2, 'view: subagentCatalogEntries')),
  },
]

/**
 * Rules shared by the two bundles that inline the v4 format validator
 * (`@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js` and the copy inside
 * `@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs`).  They are
 * byte-identical regions; only the rule ids differ per package.
 */
function relationshipValidatorRules(prefix) {
  return [
    {
      id: `${prefix}.catalog-v3-removed`,
      description: 'accept the v3 "removed" catalog fact in the v4 native catalog validator',
      marker: lines(...NATIVE_REMOVED_GUARD),
      anchor: lines(
        'function nativeCatalogFact(value) {',
        t(1, 'if (!isSessionFormatJsonObject(value) || value["version"] !== 3) return catalogFact(value);'),
      ),
      replacement: lines(
        'function nativeCatalogFact(value) {',
        ...NATIVE_REMOVED_GUARD,
        t(1, 'if (!isSessionFormatJsonObject(value) || value["version"] !== 3) return catalogFact(value);'),
      ),
    },
    {
      id: `${prefix}.catalog-tombstone-delete`,
      description: 'retire the child id and name instead of tripping duplicate detection',
      marker: lines(
        t(3, 'if (fact["mode"] === "removed") {'),
        t(4, 'ids.delete(id);'),
        t(4, 'const retiredName = namesById.get(id);'),
      ),
      anchor: lines(
        t(3, 'const fact = nativeCatalogFact(event.data);'),
        t(3, 'const id = fact["childId"];'),
        t(3, 'if (ids.has(id)) throw new SessionFormatError(`duplicate catalog child ${id}`);'),
        t(3, 'ids.add(id);'),
        t(3, 'if (fact["name"] === void 0) continue;'),
        t(3, 'const name = fact["name"];'),
        t(3, 'if (names.has(name)) throw new SessionFormatError(`duplicate catalog child name ${name}`);'),
        t(3, 'names.add(name);'),
      ),
      replacement: lines(...RELATIONSHIP_TOMBSTONE_BLOCK),
    },
    {
      id: `${prefix}.catalog-names-by-id`,
      description: 'remember each admitted child name so a tombstone can release it',
      marker: lines(t(1, 'const namesById = /* @__PURE__ */ new Map();')),
      anchor: lines(t(1, 'const ids = /* @__PURE__ */ new Set();'), t(1, 'const names = /* @__PURE__ */ new Set();')),
      replacement: lines(
        t(1, 'const ids = /* @__PURE__ */ new Set();'),
        t(1, 'const names = /* @__PURE__ */ new Set();'),
        t(1, 'const namesById = /* @__PURE__ */ new Map();'),
      ),
    },
  ]
}

/**
 * Rules grouped per published package.  `dir` is the package directory below
 * the @deepseek-ai install root, `file` is relative to that package directory
 * (the same relative path used by the files in patches/).
 */
export const TARGETS = [
  {
    package: '@deepseek-ai/dsh-subagent',
    dir: 'dsh-subagent',
    file: 'lib/index.js',
    rules: RULES.filter((rule) => rule.id.startsWith('subagent.')),
  },
  {
    package: '@deepseek-ai/dsh-session-persistence-jsonl',
    dir: 'dsh-session-persistence-jsonl',
    file: 'lib/worker.cjs',
    rules: relationshipValidatorRules('persistence'),
  },
  {
    package: '@deepseek-ai/dsh-session-format-v3-to-v4',
    dir: 'dsh-session-format-v3-to-v4',
    file: 'lib/index.js',
    rules: relationshipValidatorRules('format'),
  },
]

/**
 * Byte-level assertions (marker classes) checked by scripts/verify.mjs.
 * `targetIndex` indexes into TARGETS so the marker is only looked for in the
 * file that must contain it.
 */
export const ASSERTIONS = [
  {
    id: 'subagent.removedCatalogSchema',
    targetIndex: 0,
    label: 'v3 "removed" catalog schema declared',
    marker: lines(
      'const removedCatalogSchema = oneShotCatalogSchema.extend({',
      t(1, 'version: z$1.literal(3),'),
      t(1, 'mode: z$1.literal("removed")'),
      '});',
    ),
  },
  {
    id: 'subagent.eventDataSchema-union',
    targetIndex: 0,
    label: 'removed mode admitted to eventDataSchema union',
    marker: lines(t(1, 'namedExternalCatalogSchema,'), t(1, 'removedCatalogSchema'), ']);'),
  },
  {
    id: 'subagent.entries-collect',
    targetIndex: 0,
    label: 'projection collects tombstoned child ids',
    marker: lines(t(1, 'const removed = new Set();'), t(1, 'for (const data of iterateChunkedList(state.head)) {')),
  },
  {
    id: 'subagent.entries-filter',
    targetIndex: 0,
    label: 'projection retracts retired rows (removed.size === 0 filter)',
    marker: lines(t(1, 'return removed.size === 0 ? entries : entries.filter((entry) => !removed.has(entry.id));')),
  },
  {
    id: 'subagent.stateVersion-7',
    targetIndex: 0,
    label: 'catalog projection stateVersion is 7',
    marker: lines(t(1, 'stateVersion: 7,'), t(1, 'wire: {'), t(2, 'viewSchema,'), t(2, 'view: subagentCatalogEntries')),
  },
  {
    id: 'persistence.catalogFact-v3-removed',
    targetIndex: 1,
    label: 'nativeCatalogFact early-returns the v3 removed fact',
    marker: lines(...NATIVE_REMOVED_GUARD),
  },
  {
    id: 'persistence.tombstone-delete',
    targetIndex: 1,
    label: 'tombstone branch retires the child id',
    marker: lines(
      t(3, 'if (fact["mode"] === "removed") {'),
      t(4, 'ids.delete(id);'),
      t(4, 'const retiredName = namesById.get(id);'),
    ),
  },
  {
    id: 'persistence.names-by-id',
    targetIndex: 1,
    label: 'name bookkeeping releases a retired child name',
    marker: lines(t(1, 'const namesById = /* @__PURE__ */ new Map();')),
  },
  {
    id: 'format.catalogFact-v3-removed',
    targetIndex: 2,
    label: 'nativeCatalogFact early-returns the v3 removed fact',
    marker: lines(...NATIVE_REMOVED_GUARD),
  },
  {
    id: 'format.tombstone-delete',
    targetIndex: 2,
    label: 'tombstone branch retires the child id',
    marker: lines(
      t(3, 'if (fact["mode"] === "removed") {'),
      t(4, 'ids.delete(id);'),
      t(4, 'const retiredName = namesById.get(id);'),
    ),
  },
  {
    id: 'format.names-by-id',
    targetIndex: 2,
    label: 'name bookkeeping releases a retired child name',
    marker: lines(t(1, 'const namesById = /* @__PURE__ */ new Map();')),
  },
]

/** Absolute path of the patched file for one target. */
export function targetPath(root, target) {
  return join(root, target.dir, target.file)
}

/** Absolute path of that file's one-shot backup. */
export function backupPath(root, target) {
  return targetPath(root, target) + BACKUP_SUFFIX
}

/** Resolve the @deepseek-ai install root: --root, then env, then the official default. */
export function resolveInstallRoot(cliRoot, env = process.env) {
  if (cliRoot) return resolve(cliRoot)
  const envRoot = env.DSH_NODE_MODULES || env.DSH_INSTALL_ROOT || env._DSH_INSTALL_ROOT
  if (envRoot) return resolve(envRoot)
  return DEFAULT_INSTALL_ROOT
}

/** Read the installed version of a target package, or null when the package is absent. */
export function readInstalledVersion(root, target) {
  const pkgFile = join(root, target.dir, 'package.json')
  if (!existsSync(pkgFile)) return null
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}
