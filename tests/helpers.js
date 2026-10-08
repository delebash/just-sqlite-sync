// SPDX-License-Identifier: MIT
// Test devices: an in-memory better-sqlite3 database with a small book schema shaped like the
// apps' (composite keys, a cascading foreign key, NOT NULL columns without defaults, a text
// column that merges through Yjs), and sync opened on it.

import Database from "better-sqlite3";
import { betterSqlite3Adapter, openSync, plainTextAdapter } from "../src/index.js";

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

export function makeDevice(name, { deviceId, file = ":memory:", schemaVersion = 1, raw, tables = TABLES } = {}) {
  const db = raw ?? new Database(file);
  if (!raw) {
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);
  }
  const adapter = betterSqlite3Adapter(db);
  const sync = openSync(adapter, { app: "testapp", schemaVersion, tables, deviceId: deviceId ?? `dev-${name}`, deviceName: name, now });
  return { name, db, adapter, sync };
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
