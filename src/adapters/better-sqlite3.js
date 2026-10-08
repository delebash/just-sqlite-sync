// SPDX-License-Identifier: MIT
// The engine's database interface over better-sqlite3 (Node and Electron). Synchronous, like
// the SQLite WASM adapter beside it, so the engine has one code path.
//
// The interface every adapter provides:
//   exec(sql)                 run one or more statements with no parameters
//   run(sql, params)          run one statement → { changes }
//   all(sql, params)          rows as objects
//   get(sql, params)          the first row as an object, or undefined
//   transaction(fn)           run fn atomically (nests through savepoints) and return its result
//   fn(name, impl, options)   register a scalar SQL function: options { arity, deterministic }

function bindable(params) {
  return params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p instanceof Uint8Array && !(p instanceof Buffer) ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : p));
}

/** @param {import("better-sqlite3").Database} db */
export function betterSqlite3Adapter(db) {
  const cache = new Map();
  const prep = (sql) => {
    let st = cache.get(sql);
    if (!st) {
      st = db.prepare(sql);
      cache.set(sql, st);
    }
    return st;
  };
  return {
    kind: "better-sqlite3",
    raw: db,
    exec(sql) {
      db.exec(sql);
    },
    run(sql, params = []) {
      const r = prep(sql).run(...bindable(params));
      return { changes: r.changes };
    },
    all(sql, params = []) {
      return prep(sql).all(...bindable(params));
    },
    get(sql, params = []) {
      return prep(sql).get(...bindable(params));
    },
    transaction(fn) {
      return db.transaction(fn)();
    },
    fn(name, impl, { arity, deterministic = false } = {}) {
      const opts = { deterministic };
      if (arity !== undefined && arity < 0) opts.varargs = true;
      db.function(name, opts, impl);
    },
  };
}
