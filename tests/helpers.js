// SPDX-License-Identifier: MIT
// Test devices: an in-memory better-sqlite3 database with a small book schema shaped like the
// apps' (composite keys, a cascading foreign key, NOT NULL columns without defaults, a text
// column that merges through Yjs), and sync opened on it.

import Database from "better-sqlite3";
import { afterRestoreCopy, beforeRestoreCopy, betterSqlite3Adapter, openSync, plainTextAdapter } from "../src/index.js";

export const SCHEMA = `
CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT);
CREATE TABLE chapters (
  project_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);
CREATE TABLE scenes (
  project_id TEXT NOT NULL, id TEXT NOT NULL, chapter_id TEXT NOT NULL, position INTEGER NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);
CREATE TABLE images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
`;

export const TABLES = {
  projects: {},
  chapters: {},
  scenes: { text: { body: plainTextAdapter() } },
  images: {},
};

let clockNow = Date.UTC(2026, 9, 8, 12, 0, 0);
/** A shared fake time so tests are repeatable; each read moves it 1 ms. */
export const now = () => clockNow++;
export function setNow(t) {
  clockNow = t;
}

/**
 * A database handle that calls sync.flush() after every write — what an app does after its
 * saves, so stamps follow the order edits were made in.
 */
function flushingDb(db, getSync) {
  const flush = () => getSync()?.flush();
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "exec") {
        return (sql) => {
          const r = target.exec(sql);
          flush();
          return r;
        };
      }
      if (prop === "prepare") {
        return (sql) => {
          const st = target.prepare(sql);
          return new Proxy(st, {
            get(t, p) {
              if (p === "run") {
                return (...args) => {
                  const r = t.run(...args);
                  flush();
                  return r;
                };
              }
              const v = t[p];
              return typeof v === "function" ? v.bind(t) : v;
            },
          });
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export function makeDevice(name, { deviceId, file = ":memory:", schemaVersion = 1, raw, tables = TABLES } = {}) {
  const base = raw ?? new Database(file);
  if (!raw) {
    base.pragma("foreign_keys = ON");
    base.exec(SCHEMA);
  }
  const adapter = betterSqlite3Adapter(base);
  const open = (id) => openSync(adapter, { app: "testapp", schemaVersion, tables, deviceId: id, deviceName: name, now });
  const dev = { name, raw: base, adapter, sync: open(deviceId ?? `dev-${name}`) };
  dev.db = flushingDb(base, () => dev.sync);
  /** Open sync again under a new device id — what the app layer does after a restore. */
  dev.reopen = () => {
    dev.restores = (dev.restores ?? 0) + 1;
    dev.sync = open(`dev-${name}~${dev.restores}`);
    return dev.sync;
  };
  return dev;
}

/**
 * A device's database as a file (a restore copies on its own connection), with the test schema —
 * kept fast: the journal in memory, nothing synced to disk.
 */
export function fileDatabase(file) {
  const raw = new Database(file);
  raw.pragma("journal_mode = MEMORY");
  raw.pragma("synchronous = OFF");
  raw.pragma("foreign_keys = ON");
  raw.exec(SCHEMA);
  return raw;
}

/** Back up a device's database the way the kit does (VACUUM INTO a clean copy). */
export function backupOf(dev, file) {
  dev.raw.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  return file;
}

export const APP_TABLES = ["projects", "chapters", "scenes", "images"]; // parents first

/**
 * Restore a backup over a device's database file as the kit's data router does — on its own
 * connection, the backup attached as `src`, one transaction: the sync step before the copy, clear
 * the live tables, copy the backup's in, the sync step after it.
 */
export function restoreCopy(file, backup, { beforeCopy = beforeRestoreCopy, afterCopy = afterRestoreCopy, tables = APP_TABLES } = {}) {
  const raw = new Database(file);
  const h = {
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    exec: (sql) => raw.exec(sql),
  };
  try {
    raw.pragma("journal_mode = MEMORY");
    raw.pragma("synchronous = OFF");
    raw.prepare("ATTACH ? AS src").run(backup);
    raw.transaction(() => {
      beforeCopy(h);
      for (const t of [...tables].reverse()) raw.exec(`DELETE FROM main."${t}"`);
      for (const t of tables) raw.exec(`INSERT INTO main."${t}" SELECT * FROM src."${t}"`);
      afterCopy(h);
    })();
    raw.exec("DETACH src");
  } finally {
    raw.close();
  }
}

/** A whole restore: the copy, then sync reopened under a new device id. */
export function restore(dev, file, backup) {
  restoreCopy(file, backup);
  return dev.reopen();
}

/** Everything a user would see: the synced tables' rows, in a stable order. */
export function dump(db, tables = Object.keys(TABLES)) {
  const out = {};
  for (const t of tables) {
    out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map((r) => {
      const o = { ...r };
      for (const [k, v] of Object.entries(o)) if (v instanceof Uint8Array) o[k] = Buffer.from(v).toString("hex");
      return o;
    });
  }
  return out;
}

/** Pull then push between two devices directly (what syncWithPeer does over HTTP). */
export function exchange(a, b) {
  const helloB = b.sync.vector();
  const fromB = b.sync.changesSince(a.sync.vector());
  a.sync.apply(fromB);
  const fromA = a.sync.changesSince(helloB);
  b.sync.apply(fromA);
}

/** A seeded random generator (mulberry32). */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
