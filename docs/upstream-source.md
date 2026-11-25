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
| Author | (address omitted in this public copy) |
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

The published `@deepseek-ai/*` bundles predate this commit (the bundled source
regions match the pre-commit versions in the table above), and upstream did not
take the change into the shipped line. `dsh update` reinstalls `node_modules`
from npm, which reverts every file to pristine and wipes any hand edit — hence
the scripts in this repository re-apply it deterministically after each update.

## Status against 0.2.2-rc.5 (`9c2670d3bc`)

**Not fixed upstream; the kit is still required.** Checked at tag
`dsh-v0.2.2-rc.5` = `9c2670d3bce5275e0d1610272958121af87787bb` and against the
installed `0.2.2-rc.5` bundles:

| Evidence | 0.2.2 source | Installed bundle |
| --- | --- | --- |
| No `removed` catalog mode / schema | `packages/subagent/subagent/src/catalog.ts` — `eventDataSchema` union ends at `namedExternalCatalogSchema`; `SubagentCatalogEvent` v3 admits only `continuable`/`external` | `dsh-subagent/lib/index.js:813-851` (schemas), `:844-851` (union) |
| Projection still publishes every fact | same file — `subagentCatalogEntries` pushes every folded fact and `return entries`, `stateVersion: 6` | `dsh-subagent/lib/index.js:897-923` |
| Restore rejects a tombstone | `packages/session/session-format-v3-to-v4/src/facts.ts` — `nativeCatalogFact` requires v3 `mode` to be `continuable`/`external` and `name` to be a string | `dsh-session-format-v3-to-v4/lib/index.js:1055-1061` |
| Relationship validator only adds ids | `packages/session/session-format-v3-to-v4/src/validation.ts` — `ids.add(id)` after the duplicate check, `names.add(name)` for named facts | `dsh-session-format-v3-to-v4/lib/index.js:1027-1048`; the same region inlined at `dsh-session-persistence-jsonl/lib/worker.cjs:12726-12747` |
| Deletion is still an external capability | `packages/workspace/workspace/README.md` — "Removal never deletes data"; `packages/session/session-persistence-jsonl/README.md` — "Nothing deletes session files" | no delete op in `dsh-session-persistence-jsonl/lib/worker.cjs` |
| Agent-team rows come from the catalog | `packages/team/agent-team/src/types.ts` keeps roster snapshots only as history; the team UI counts `subagentCatalog` | `dsh-client-ui-agent-team/lib/client.js` (`subagentCatalog?.length`) |
| Ghost still surfaces in discovery | `packages/subagent/subagent/src/list-children.ts` — `listDescendants` emits a `child` row with `activity: 'inactive'` from the catalog entry even when no session exists | `dsh-subagent/lib/types/list-children.js:100-156` (catalog row at `:152`) |

The producer of the tombstone is the companion plugin
`dsh-plugin-subagent-delete` (`retireCatalogRow` appends
`{ version: 3, childId, childCreatedAt, mode: "removed" }`); upstream still has
no retirement API, so the reader-side backport remains necessary.

### 0.2.2 re-derivation (why the old anchors stopped matching)

`0.2.2-rc.5` did not change the bug, but it did change the compiled regions, so
every anchor was re-derived against the installed bundles:

| Change in 0.2.2 | Rule affected | New anchor |
| --- | --- | --- |
| Catalog v3 facts gained a mandatory `name`; two named schemas were added to the union | `subagent.catalog-v3-schema` | the six-entry `eventDataSchema` union (`namedContinuableCatalogSchema`, `namedExternalCatalogSchema`) |
| JSDoc above the projection changed and `return entries;` is no longer unique | `subagent.catalog-entries-filter` | the three lines above the return (`});` / `}` / `return entries;`), which are unique |
| `stateVersion` is still 6, so the bump rule is unchanged | `subagent.catalog-state-version` | unchanged shape |
| The projection fold is unchanged | `subagent.catalog-entries-collect` | unchanged shape |
| Native v3 payloads now go through the new `nativeCatalogFact`, which only delegates v0–v2 to `catalogFact` | `persistence.catalog-v3-removed`, `format.catalog-v3-removed` | insert the guard at the top of `nativeCatalogFact`; `catalogFact` is deliberately left untouched (a v3 tombstone can only exist in native v4 logs) |
| The relationship validator now also tracks unique child `name`s | `*.catalog-tombstone-delete`, `*.catalog-names-by-id` | tombstone deletes the id and drops its `id → name` record; a new `namesById` map records names as they are admitted |

The name release is a 0.2.2-specific addition to the original backport: because
the retracted view no longer reserves a deleted child's name, the live manager
can hand the same name (including the automatic first-free `agent-N`) to a new
sibling. Without the release, such a log would fail restoration with
`duplicate catalog child name …` even though the live tree accepted the
creation.

The patch set still spans the same three packages and files; no package was
renamed or merged. `dsh-subagent/lib/types/catalog.js` carries a second copy of
the projection source but is not imported by `lib/index.js` or by any other
installed package (the bundle inlines the region), so it is intentionally not a
target.

## How the compiled rules map to source

The bundlers flatten the TypeScript guards, so the backport is expressed as
exact-string rules over the bundled files (see `scripts/spec.mjs`):

| Source change | Compiled rule id | Bundle file |
| --- | --- | --- |
| `removedCatalogSchema` + `eventDataSchema` union | `subagent.catalog-v3-schema` | `dsh-subagent/lib/index.js` |
| `subagentCatalogEntries` collects tombstones | `subagent.catalog-entries-collect` | `dsh-subagent/lib/index.js` |
| `subagentCatalogEntries` filters retired rows | `subagent.catalog-entries-filter` | `dsh-subagent/lib/index.js` |
| `stateVersion` 6 → 7 | `subagent.catalog-state-version` | `dsh-subagent/lib/index.js` |
| `facts.ts` version-3 / removed admission (`nativeCatalogFact`) | `format.catalog-v3-removed` | `dsh-session-format-v3-to-v4/lib/index.js` |
| `validation.ts` tombstone id/name retirement | `format.catalog-tombstone-delete`, `format.catalog-names-by-id` | `dsh-session-format-v3-to-v4/lib/index.js` |
| Same validator, duplicated into the persistence worker bundle | `persistence.catalog-v3-removed`, `persistence.catalog-tombstone-delete`, `persistence.catalog-names-by-id` | `dsh-session-persistence-jsonl/lib/worker.cjs` |

The `validation.ts` logic is bundled into both
`dsh-session-format-v3-to-v4/lib/index.js` and
`dsh-session-persistence-jsonl/lib/worker.cjs` (the worker inlines the compiled
output instead of importing the format package), which is why the same three
rules appear in both files. In 0.2.2 the main persistence bundle does import
`assertReleasedV4Relationships` from `@deepseek-ai/dsh-session-format-v3-to-v4`,
so both copies still have to be patched for the main thread and the worker
threads. `retireCatalogChild` is a producer-side API that no compiled caller
in these bundles uses; it is intentionally not part of this kit — the installed
build only needs the *reader* side to restore sessions containing tombstones.

## Reproducing the diffs

`patches/` was generated from the pristine installed `0.2.2-rc.5` files and the
spec-applied output (the same bytes `scripts/apply.mjs` writes):

```bash
cd <pristine-package-dir> && diff -u --label lib/index.js --label lib/index.js \
  lib/index.js <patched-package-dir>/lib/index.js
```

Paths in every `.patch` are relative to the package directory, matching the
layout under `node_modules/@deepseek-ai/<package>/`.
