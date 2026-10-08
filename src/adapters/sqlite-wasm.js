// SPDX-License-Identifier: MIT
// The engine's database interface over the official SQLite WASM build's OO1 API
// (`@sqlite.org/sqlite-wasm`) — a browser or a phone webview, usually in a worker on the
// `opfs-sahpool` storage. Synchronous, like the better-sqlite3 adapter; see that file for the
// interface.

function bindable(params) {
  return params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : typeof p === "bigint" ? p : p));
}

/** @param {any} db an `oo1.DB` (or `OpfsSAHPoolDb`) */
export function sqliteWasmAdapter(db) {
  return {
    kind: "sqlite-wasm",
    raw: db,
    exec(sql) {
      db.exec(sql);
    },
    run(sql, params = []) {
      db.exec({ sql, bind: params.length ? bindable(params) : undefined });
      return { changes: db.changes() };
    },
    all(sql, params = []) {
      return db.selectObjects(sql, params.length ? bindable(params) : undefined);
    },
    get(sql, params = []) {
      return db.selectObject(sql, params.length ? bindable(params) : undefined);
    },
    transaction(fn) {
      // savepoint() nests and also works as the outermost transaction.
      return db.savepoint(() => fn());
    },
    fn(name, impl, { arity, deterministic = false } = {}) {
      db.createFunction(name, (_ctx, ...args) => impl(...args), { arity: arity ?? impl.length, deterministic });
    },
  };
}
