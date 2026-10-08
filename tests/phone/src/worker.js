// SPDX-License-Identifier: MIT
// The worker: the sync engine on the official SQLite WASM build over OPFS (opfs-sahpool), used
// through its synchronous API — as an app's server code runs on a phone.
//
// Each launch: the persistent device P (OPFS) records one more run and edits a scene; a fresh
// in-memory device D joins P's library and receives everything; D edits the same scene and P
// merges it. Printed: RESULT lines the runner scripts check, ending "RESULT done".

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { openSync, plainTextAdapter, sqliteWasmAdapter } from "../../../src/index.js";

const say = (s) => postMessage(s);
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scenes (
  project_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (project_id, id), FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, at TEXT);`;
const TABLES = { projects: {}, scenes: { text: { body: plainTextAdapter() } } };

try {
  say(`worker syncAccessHandle=${typeof FileSystemFileHandle !== "undefined" && "createSyncAccessHandle" in FileSystemFileHandle.prototype}`);
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "sync-test" });
  const pdb = new pool.OpfsSAHPoolDb("/library.db");
  pdb.exec("PRAGMA foreign_keys = ON");
  pdb.exec(SCHEMA);
  const runsBefore = pdb.selectValue("SELECT count(*) FROM runs");
  pdb.exec({ sql: "INSERT INTO runs (at) VALUES (?)", bind: [new Date().toISOString()] });
  const P = openSync(sqliteWasmAdapter(pdb), { app: "phonetest", tables: TABLES, deviceId: "phone-P", deviceName: "phone" });
  const seqBefore = P.seq;
  pdb.exec("INSERT OR IGNORE INTO projects VALUES ('p1', 'Book')");
  pdb.exec("INSERT OR IGNORE INTO scenes VALUES ('p1', 's1', 'Opening', 'It was night.')");
  pdb.exec({ sql: "UPDATE scenes SET title = ? WHERE id = 's1'", bind: [`Run ${runsBefore + 1}`] });

  const ddb = new sqlite3.oo1.DB(":memory:");
  ddb.exec("PRAGMA foreign_keys = ON");
  ddb.exec(SCHEMA);
  const D = openSync(sqliteWasmAdapter(ddb), { app: "phonetest", tables: TABLES, deviceName: "desk" });
  D.apply(P.changesSince({}), { join: true });
  const got = ddb.selectObject("SELECT title, body FROM scenes WHERE id = 's1'");
  ddb.exec({ sql: "UPDATE scenes SET body = ? WHERE id = 's1'", bind: [`${got.body} Rain ${runsBefore + 1}.`] });
  P.apply(D.changesSince(P.vector()));
  const merged = pdb.selectObject("SELECT title, body FROM scenes WHERE id = 's1'");
  const equal = JSON.stringify(merged) === JSON.stringify(ddb.selectObject("SELECT title, body FROM scenes WHERE id = 's1'"));

  // the write path an author's autosave takes: 200 saves of a 7.5 KB scene
  const body = `<p>${"word ".repeat(1500)}</p>`;
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) pdb.exec({ sql: "UPDATE scenes SET body = ? WHERE id = 's1'", bind: [body + i] });
  const ms = Math.round(performance.now() - t0);
  pdb.exec({ sql: "UPDATE scenes SET body = ? WHERE id = 's1'", bind: [merged.body] });

  say(`RESULT runsBefore=${runsBefore} seqBefore=${seqBefore} seqAfter=${P.seq} title=${JSON.stringify(merged.title)} equal=${equal}`);
  say(`RESULT body=${JSON.stringify(merged.body)}`);
  say(`RESULT saves200=${ms}ms`);
  pdb.close();
  ddb.close();
  say("RESULT done");
} catch (err) {
  say(`RESULT FAIL ${err?.stack || err}`);
  say("RESULT done");
}
