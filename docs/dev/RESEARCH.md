<!-- SPDX-License-Identifier: MIT -->
# Research — facts with their proof

The field (other sync tools, platforms, phones) is in the kit's `docs/dev/RESEARCH.md` §2 "Sync"
and "Sync, round 2", with full records in the kit's `docs/plans/2026-10-08-sync-research-*.md`.
This file holds what this repo's code depends on.

## SQLite

- **A trigger's `INSERT OR REPLACE` is overridden by the firing statement's conflict clause**
  (*tested* 2026-10-08, better-sqlite3 13.0.3 / SQLite 3.53.4): an app's `INSERT OR IGNORE` turned
  the trigger's `OR REPLACE` into `OR IGNORE` and kept a stale clock row (found by the convergence
  test, seed 1). An UPSERT (`ON CONFLICT … DO UPDATE`) in the trigger worked under `INSERT`,
  `OR IGNORE`, `OR ABORT`, `OR FAIL` and `OR REPLACE` (5 of 5). SQLite's CREATE TRIGGER page states
  the override rule.
- **`ON DELETE CASCADE` fires the child tables' delete triggers** (*tested* on a copy of JustWrite's
  database: deleting the book recorded a delete for every row of every child table that had rows;
  `tests/engine.test.js` "a delete beats an older edit…" checks it on every run).
- **`INSERT … SELECT … ON CONFLICT` needs a `WHERE`** after the SELECT (SQLite's parser rule for
  UPSERT); the update trigger's per-field statements have one.
- `json_each` over a JSON object yields `key`/`value` rows — used to compare clock rows with a
  vector in one query.

## The SQLite WASM build (`@sqlite.org/sqlite-wasm` 3.53.4-build2)

- OO1 `createFunction(name, (ctx, ...args) => …, { arity })` — the first argument is the context
  pointer and arity defaults to `xFunc.length - 1`, so the adapter passes `arity` explicitly.
- `db.savepoint(fn)` nests and works as the outermost transaction (the adapter's `transaction`).
- Runs in Node (`dist/node.mjs`) for tests; in a Capacitor Android 16 webview (WebView 133) on
  `opfs-sahpool`, the database survived a force-stop and an app update (*tested* 2026-10-08, kit
  RESEARCH "Sync, round 2").

## Yjs (13.6.33)

- `Y.equalSnapshots(Y.snapshot(a), Y.snapshot(b))` compares both insertions (state vector) and
  deletions (delete set); comparing state vectors alone misses deletions, which add no structs.
- A Y.Doc's `clientID` can be set after loading a state and before editing; edits then continue
  that client's clock.

## Measured

- Recording cost (2,000 saves of a 7.5 KB row, WAL): cr-sqlite 336 ms vs 132 ms plain; a full-log
  design 1,020 ms vs 106 ms; this engine's history-free triggers are cr-sqlite's shape (2026-10-08,
  the kit's round-2 record).
- Convergence: 300 seeded runs in the suite, plus 3,000 runs of 40 steps and 500 of 150 steps run
  once — zero divergence (2026-10-08).
