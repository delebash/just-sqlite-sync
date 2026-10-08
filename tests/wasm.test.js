// SPDX-License-Identifier: MIT
// The phone's engine: the official SQLite WASM build (here its Node build, in memory — the phone
// runs the same code over OPFS storage in a worker). A desktop on better-sqlite3 and a "phone" on
// SQLite WASM sync with each other.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { openSync, sqliteWasmAdapter } from "../src/index.js";
import { SCHEMA, TABLES, dump, makeDevice, now } from "./helpers.js";
import { randomOp } from "./sim.js";
import { rng } from "./helpers.js";

let sqlite3;
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

function wasmDevice(name) {
  const db = new sqlite3.oo1.DB(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  const sync = openSync(sqliteWasmAdapter(db), { app: "testapp", tables: TABLES, deviceId: `dev-${name}`, deviceName: name, now });
  // a better-sqlite3-like shim so the shared helpers (dump, randomOp) can drive it
  const shim = {
    prepare(sql) {
      return {
        all: (...p) => db.selectObjects(sql, p.length ? p.map(norm) : undefined),
        get: (...p) => db.selectObject(sql, p.length ? p.map(norm) : undefined),
        run: (...p) => {
          db.exec({ sql, bind: p.length ? p.map(norm) : undefined });
          sync.flush(); // an app flushes after its saves
        },
      };
    },
    exec: (sql) => {
      db.exec(sql);
      sync.flush();
    },
    pragma: (p) => db.selectObjects(`PRAGMA ${p}`),
  };
  return { name, db: shim, sync };
}
const norm = (v) => (Buffer.isBuffer(v) ? new Uint8Array(v) : v);
const normDump = (d) => JSON.parse(JSON.stringify(d, (k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v)));

function exchange(a, b) {
  const vb = b.sync.vector();
  a.sync.apply(b.sync.changesSince(a.sync.vector()));
  b.sync.apply(a.sync.changesSince(vb));
}

describe("SQLite WASM (the phone's engine)", () => {
  it("a desktop and a phone on different SQLite builds converge (100 seeded runs)", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const r = rng(seed);
      const desk = makeDevice("desk");
      const phone = wasmDevice("phone");
      phone.sync.joinLibrary(desk.sync.library);
      for (let i = 0; i < 30; i++) {
        randomOp(r() < 0.5 ? desk : phone, r);
        if (r() < 0.3) exchange(desk, phone);
      }
      exchange(desk, phone);
      exchange(desk, phone);
      try {
        expect(normDump(dump(phone.db))).toEqual(normDump(dump(desk.db)));
      } catch (err) {
        err.message = `seed ${seed}: ${err.message}`;
        throw err;
      }
    }
  });
});
