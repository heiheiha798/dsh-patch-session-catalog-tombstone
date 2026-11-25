# dsh-patch-session-catalog-tombstone

A re-appliable local patch kit for the installed **DeepSeek Harness** npm
packages (`@deepseek-ai/*`). It adds a third **`removed` (tombstone)** mode to
the subagent catalog fact so that a permanently deleted subagent retracts its
catalog row instead of leaving a ghost entry in the session sidebar.

The change is not in the published bundles and upstream does not carry it in
the shipped line, so it is applied locally to `node_modules`. `dsh update`
reinstalls `node_modules` from npm and wipes the edit — this kit makes the edit
re-appliable, verifiable and idempotent.

- Runtime: **Node >= 22**, **zero dependencies**.
- Verified against: **`@deepseek-ai/*` 0.2.1-rc.5** (see the table below).
- Patch style: exact-string substitution with asserted upstream anchors,
  **never line numbers**, so upstream drift fails closed.

## The bug this fixes

`subagent/catalog` facts are append-only discovery history. Deleting a child
session removed the session but not its catalog fact, so the parent's
`subagentCatalog` projection kept publishing the row and the web app kept it in
the sidebar and lineage picker. There was no way to say "this child is gone"
without rewriting history.

## What the patch does

It backports upstream commit `93e0ef008f` (see
[docs/upstream-source.md](docs/upstream-source.md)) into the compiled bundles:

1. **New catalog fact variant** — `{ version: 3, mode: "removed" }` is declared
   and admitted to the `eventDataSchema` union (`dsh-subagent`).
2. **Projection retracts the row** — `subagentCatalogEntries` records
   tombstoned child ids and filters them out of the published view; the catalog
   projection `stateVersion` goes 6 → 7 (`dsh-subagent`).
3. **Restore validators accept the tombstone** — `catalogFact` admits
   `version === 3 && mode === "removed"`, and the relationship validator lets a
   tombstone `ids.delete(childId)` instead of tripping duplicate detection
   (`dsh-session-format-v3-to-v4` and the same validator inlined into
   `dsh-session-persistence-jsonl/lib/worker.cjs`).

The log stays append-only and the **session format stays v4**; only the
projection state version changes.

### The three anchors (what `verify` checks)

| Package | File | Marker asserted |
| --- | --- | --- |
| `@deepseek-ai/dsh-subagent` | `lib/index.js` | `removedCatalogSchema` declared; `removed` admitted to the `eventDataSchema` union; `removed.size === 0` filter in `subagentCatalogEntries`; `stateVersion: 7` |
| `@deepseek-ai/dsh-session-persistence-jsonl` | `lib/worker.cjs` | `catalogFact` early-returns `version === 3 && mode === "removed"`; tombstone `ids.delete(id)` branch |
| `@deepseek-ai/dsh-session-format-v3-to-v4` | `lib/index.js` | same two changes in the format validator bundle |

`scripts/verify.mjs` asserts these as 9 byte-exact marker checks across the
three files and prints a pass/fail table.

## Re-apply after `dsh update`

```bash
dsh update
node scripts/apply.mjs          # re-apply to the live install
node scripts/verify.mjs         # must exit 0
```

`apply.mjs` is idempotent: on an already-patched tree it reports
`already applied` and writes nothing. It writes a one-time backup next to each
patched file (`<file>.bak-before-tombstone`) so the edit is reversible.

### Install root resolution

`--root` wins; otherwise, in order:

1. `$DSH_NODE_MODULES`
2. `$DSH_INSTALL_ROOT`
3. `$_DSH_INSTALL_ROOT`
4. auto-detected: the global npm prefix (`npm prefix -g`) or the real path of the
   `dsh` executable, resolved to `<prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`

The root is the `@deepseek-ai` **scope directory** that contains the package
directories (`dsh-subagent`, `dsh-session-persistence-jsonl`,
`dsh-session-format-v3-to-v4`).

## Commands

```bash
# apply to the live install (default root), idempotent, backs up once
node scripts/apply.mjs

# report what would change, write nothing
node scripts/apply.mjs --dry-run

# verify only: exit 0 only if every file is fully patched
node scripts/apply.mjs --check

# print installed versions of the three target packages
node scripts/apply.mjs --version

# marker table + exit 0/1
node scripts/verify.mjs

# operate on another tree (CI, fixtures, a staging copy)
node scripts/apply.mjs --root /path/to/@deepseek-ai
node scripts/verify.mjs --root /path/to/@deepseek-ai

# test suite (no access to the live install required)
node --test
```

Exit codes: `0` success, `1` patch/verify failure, `2` usage error.
`apply --dry-run` and `apply --check` never write.

### Failure behaviour

- **Marker already present** → `already applied`, skipped (safe to run often).
- **Pristine anchors present** → exact-string replacement per rule; anchors are
  asserted to occur exactly once before any write.
- **Anchor missing** (upstream changed the bundle) → exit non-zero naming the
  package, file, rule and marker, plus the installed version. Nothing is
  written; re-derive the anchors against the new build.
- **Partially patched file** (some rules applied, some not) → exit non-zero and
  refuse to patch over it; restore `<file>.bak-before-tombstone` or reinstall.

## Failure mode if you skip it after an update

`dsh update` reverts the bundles to pristine. Sessions whose JSONL logs contain
a v3 `removed` catalog fact are then rejected on restore: the v4 validators
throw `subagent/catalog requires a supported versioned catalog fact`, and any
persisted catalog projection state at `stateVersion: 7` is not accepted by the
reverted `stateVersion: 6` definition. Practically: session restore fails for
affected sessions and deleted subagents reappear as catalog/sidebar rows.

## Verified against

| Package | Version | File | Status |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-subagent` | 0.2.1-rc.5 | `lib/index.js` | verified (apply output byte-identical to hand-patched live file) |
| `@deepseek-ai/dsh-session-persistence-jsonl` | 0.2.1-rc.5 | `lib/worker.cjs` | verified (same) |
| `@deepseek-ai/dsh-session-format-v3-to-v4` | 0.2.1-rc.5 | `lib/index.js` | verified (same) |

`scripts/verify.mjs` prints the installed version for every row, so a future
release is visible even if all markers still match; `apply --check` remains the
authoritative gate.

## Repository layout

```
patches/                       three unified diffs (paths relative to each package dir)
scripts/spec.mjs               anchors, replacements, markers, assertions (single source of truth)
scripts/apply.mjs              exact-string applier: --root/--dry-run/--check/--version
scripts/verify.mjs             marker table, exit 0/1
test/                          node:test suite (unit, verify, optional integration)
fixtures/pristine/             trimmed pristine bundle regions (synthetic fixture tree)
fixtures/expected/             byte-exact expected output after applying
docs/upstream-source.md        upstream commit summary and rule mapping
```

The fixtures are trimmed copies of the relevant bundle regions, not full
packages; the suite covers idempotency, byte-exact output, `already applied`
reporting, `--dry-run`/`--check`, missing-anchor failure and partial-patch
refusal. `test/integration.test.mjs` additionally re-applies the patch to real
pristine `0.2.1-rc.5` package copies and diffs the result against the live
patched install; it is skipped automatically when those copies are absent (e.g.
in CI).

## Patches

| Patch | Package | Upstream source |
| --- | --- | --- |
| `patches/01-dsh-subagent-v3-removed-catalog-fact.patch` | `dsh-subagent` | `src/catalog.ts` |
| `patches/02-dsh-session-persistence-jsonl-catalog-tombstone-validator.patch` | `dsh-session-persistence-jsonl` | `src/facts.ts` + `src/validation.ts` (inlined) |
| `patches/03-dsh-session-format-v3-to-v4-catalog-tombstone-validator.patch` | `dsh-session-format-v3-to-v4` | `src/facts.ts` + `src/validation.ts` |

Each patch is a plain `diff -u` relative to the package directory and is
provided for review/provenance; `apply.mjs` performs the equivalent
exact-string edits (it deliberately does not depend on `patch(1)`).

```bash
# review only, from a pristine package directory
patch -p0 --dry-run < patches/01-dsh-subagent-v3-removed-catalog-fact.patch
```

## Rollback

```bash
cd <install root>/dsh-subagent/lib && cp index.js.bak-before-tombstone index.js
# ... same for dsh-session-persistence-jsonl/lib/worker.cjs
# ... and dsh-session-format-v3-to-v4/lib/index.js
```

Or simply run `dsh update` again, which reinstalls the pristine packages.

## License

MIT — see [LICENSE](LICENSE). Upstream package code remains under its own
license; this repository only contains diffs, anchors and tooling.
