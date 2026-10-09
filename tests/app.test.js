// SPDX-License-Identifier: MIT
// The app layer (src/app.js): two app servers — each a database, its `sync` settings and tokens
// in a settings table, the routes on Fastify — exchanging a file by hand, refusing another
// library until joined, pairing with a device that's off, and the settings and status routes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createAppSync } from "../src/app.js";
import { betterSqlite3Adapter } from "../src/index.js";
import { SCHEMA, TABLES } from "./helpers.js";

const cleanup = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** One app: its database, its settings rows, its server with the sync routes. */
async function makeApp(name) {
  const dir = mkdtempSync(path.join(tmpdir(), `appsync-${name}-`));
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  const getRow = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
  const putRow = (key, value) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  const appSync = createAppSync({
    app: "testapp",
    appName: "Test App",
    schemaVersion: 1,
    tables: () => TABLES,
    database: () => betterSqlite3Adapter(db),
    settings: { read: () => JSON.parse(getRow("sync") ?? "null"), write: (cfg) => putRow("sync", JSON.stringify(cfg)) },
    auth: { tokens: () => JSON.parse(getRow("tokens") ?? "[]"), add: (t) => putRow("tokens", JSON.stringify([...JSON.parse(getRow("tokens") ?? "[]"), t])) },
    units: { scope: (ids) => (t, pk) => t !== "images" && ids.includes(pk[0]), name: (ids) => db.prepare("SELECT title FROM projects WHERE id = ?").get(ids[0])?.title, extension: "tsync" },
    log: { warning() {} },
  });
  appSync.open(dir);
  const server = Fastify();
  server.register(appSync.routes);
  await server.ready();
  cleanup.push(async () => {
    appSync.stop();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (sql) => {
    db.exec(sql);
    appSync.flush();
  };
  return { db, appSync, server, write };
}

describe("the app layer", () => {
  it("a book exported by hand imports on another device after joining its library", async () => {
    const laptop = await makeApp("laptop");
    laptop.write("INSERT INTO projects VALUES ('p1', 'The Lamp', 'Mira'); INSERT INTO chapters VALUES ('p1', 'c1', 0, 'Arrival');");
    laptop.write("INSERT INTO projects VALUES ('p2', 'Another', NULL);");
    const exp = await laptop.server.inject({ method: "POST", url: "/v1/sync/export", payload: { projectIds: ["p1"] } });
    expect(exp.statusCode).toBe(200);
    expect(decodeURIComponent(exp.headers["content-disposition"])).toMatch(/The Lamp \d{4}-\d{2}-\d{2}\.tsync/);
    const status = (await laptop.server.inject({ url: "/v1/sync/status" })).json();
    expect(Date.parse(status.settings.lastExport)).toBeGreaterThan(Date.now() - 60_000);

    const phone = await makeApp("phone");
    const upload = { method: "POST", url: "/v1/sync/import", headers: { "content-type": "application/octet-stream" }, payload: exp.rawPayload };
    const refused = await phone.server.inject(upload);
    expect(refused.statusCode).toBe(409);
    const joined = await phone.server.inject({ ...upload, url: "/v1/sync/import?join=1" });
    expect(joined.statusCode).toBe(200);
    expect(phone.db.prepare("SELECT id FROM projects").all().map((r) => r.id)).toEqual(["p1"]);
    expect(phone.appSync.get().library).toBe(laptop.appSync.get().library);
    // the window's poll moved: another device's changes landed
    expect((await phone.server.inject({ url: "/v1/sync/rev" })).json().rev).toBeGreaterThan(0);
  });

  it("pairing gives a code; joining with it adopts the library and key even when the device is off", async () => {
    const laptop = await makeApp("laptop");
    const r = (await laptop.server.inject({ method: "POST", url: "/v1/sync/pair", payload: {} })).json();
    expect(r.code).toMatchObject({ v: 1, app: "testapp", library: laptop.appSync.get().library });
    expect(r.code.key).toHaveLength(43);
    expect(laptop.appSync.readSettings().listenOnNetwork).toBe(true);
    expect(laptop.appSync.networkHost()).toBe("0.0.0.0"); // listening on, and a token exists

    const phone = await makeApp("phone");
    const code = { ...r.code, urls: ["http://127.0.0.1:9/v1/sync"] }; // nothing answers there
    const join = await phone.server.inject({ method: "POST", url: "/v1/sync/pair/join", payload: { code: JSON.stringify(code) } });
    expect(join.statusCode).toBe(200);
    expect(join.json()).toMatchObject({ joined: true, url: null });
    expect(phone.appSync.get().library).toBe(laptop.appSync.get().library);
    expect(phone.appSync.readSettings().key).toBe(r.code.key);
    const bad = await phone.server.inject({ method: "POST", url: "/v1/sync/pair/join", payload: { code: "{}" } });
    expect(bad.statusCode).toBe(400);
  });

  it("settings: the device name reaches the engine; listening needs a token", async () => {
    const one = await makeApp("one");
    const put = await one.server.inject({ method: "PUT", url: "/v1/sync/settings", payload: { deviceName: "Study laptop", autoMinutes: 0, listenOnNetwork: true } });
    expect(put.json()).toEqual({ ok: true, restartRequired: true });
    expect(one.appSync.get().deviceName).toBe("Study laptop");
    expect(one.appSync.networkHost()).toBe(null); // no token yet: stays on this computer
  });
});
