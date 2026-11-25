# Upstream source provenance

This patch kit is a **local backport** of one upstream source commit into the
compiled bundles that npm actually ships. The monorepo itself is *not* copied
here; this document only records what the change is and how the bundled rules
map back to source.

## The commit

| Field | Value |
| --- | --- |
| Repository | `deepseek-harness` (local checkout used for provenance: a local checkout of `deepseek-harness` at the matching tag) |
| Commit | `93e0ef008f63a3b6df61ef5b4d455250e9dde3d4` (`93e0ef008f`) |
| Author | heiheiha798 `<143272889+heiheiha798@users.noreply.github.com>` |
| Date | Thu Oct 22 16:07:23 2026 +0800 |
| Subject | `feat(subagent): retire catalog rows when a child session is deleted` |
| Size | 4 files, +64 / -6 |

Commit message (verbatim):

> The parent catalog is append-only creation history, so deleting a child
> Session left a permanent catalog row that the web session list projected as a
> sidebar entry. Add a v3 'removed' catalog fact: the projection drops the
> child from the published view while every earlier fact stays in the log, and
> the v4 format validator accepts the tombstone (only after the same generation
> admitted the child). Session-format version stays 4; older readers never see
> version 3 because only this build writes it.

Files touched:

| Source file | Change |
| --- | --- |
| `packages/subagent/subagent/src/catalog.ts` | `SubagentCatalogEvent` gains `{ version: 3; mode: 'removed' }`; new `removedCatalogSchema`; `removedCatalogSchema` added to `eventDataSchema`; `subagentCatalogEntries` records `mode === 'removed'` child ids in a `Set` and filters them out of the published view; projection `stateVersion` 6 → 7; new exported `retireCatalogChild(parent, childId)` that appends `{ version: 3, childId, childCreatedAt: Date.now(), mode: 'removed' }`. |
| `packages/session/session-format-v3-to-v4/src/facts.ts` | `catalogFact` accepts `version: 3` / `mode: 'removed'` (with the existing version↔mode correspondence rules). |
| `packages/session/session-format-v3-to-v4/src/validation.ts` | In `assertReleasedV4Relationships`, a `removed` fact deletes the child id from the duplicate-detection set instead of adding it. |
| `packages/subagent/subagent/tests/catalog.spec.ts` | New test `retires a deleted child row without disturbing its siblings` (retire one of two children; published view keeps only the sibling). |

Semantics that matter for the backport:

- The catalog projection stays append-only: earlier discovery facts are never
  rewritten, so old readers keep seeing the creation history they understand.
- Session-format stays **v4**; only this build writes catalog fact version 3.
- A tombstone may only refer to a child the same generation admitted; the
  validator removes the id, so a later re-creation can be admitted again.
- `stateVersion: 7` is the **projection state version**, not the wire format
  version.

## Why a patch kit is needed

The published `@deepseek-ai/*` bundles for `0.2.1-rc.5` predate this commit
(the bundled source regions match the pre-commit versions in the table above),
and upstream did not take the change into the shipped line. The working
installation was therefore patched by hand in compiled form. `dsh update`
reinstalls `node_modules` from npm, which reverts every file to pristine and
wipes the hand edit — hence the scripts in this repository re-apply it
deterministically after each update.

## How the compiled rules map to source

The bundlers flatten the TypeScript guards, so the backport is expressed as
exact-string rules over the bundled files (see `scripts/spec.mjs`):

| Source change | Compiled rule id | Bundle file |
| --- | --- | --- |
| `removedCatalogSchema` + `eventDataSchema` union | `subagent.catalog-v3-schema` | `dsh-subagent/lib/index.js` |
| `subagentCatalogEntries` collects tombstones | `subagent.catalog-entries-collect` | `dsh-subagent/lib/index.js` |
| `subagentCatalogEntries` filters retired rows | `subagent.catalog-entries-filter` | `dsh-subagent/lib/index.js` |
| `stateVersion` 6 → 7 | `subagent.catalog-state-version` | `dsh-subagent/lib/index.js` |
| `facts.ts` version-3 / removed admission | `format.catalog-v3-removed` | `dsh-session-format-v3-to-v4/lib/index.js` |
| `validation.ts` tombstone delete branch | `format.catalog-tombstone-delete` | `dsh-session-format-v3-to-v4/lib/index.js` |
| Same validator, duplicated into the persistence worker bundle | `persistence.catalog-v3-removed`, `persistence.catalog-tombstone-delete` | `dsh-session-persistence-jsonl/lib/worker.cjs` |

The `validation.ts` logic is bundled into both
`dsh-session-format-v3-to-v4/lib/index.js` and
`dsh-session-persistence-jsonl/lib/worker.cjs` (the worker imports the format
package's compiled output inline), which is why the same two rules appear in
both files. `retireCatalogChild` is a producer-side API that no compiled caller
in these bundles uses; it is intentionally not part of this kit — the installed
build only needs the *reader* side to restore sessions containing tombstones.

## Reproducing the diffs

`patches/` was generated from the pristine `0.2.1-rc.5` package files and the
hand-patched installed files:

```bash
cd <pristine-package-dir> && diff -u lib/index.js <patched-package-dir>/lib/index.js
```

Paths in every `.patch` are relative to the package directory, matching the
layout under `node_modules/@deepseek-ai/<package>/`.
