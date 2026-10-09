// SPDX-License-Identifier: MIT
// The app layer (src/app.js): two app servers — each a database, its `sync` settings and tokens
// in a settings table, the routes on Hono — exchanging a file by hand, refusing another
// library until joined, pairing with a device that's off, and the settings and status routes.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
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
  const server = new Hono();
  // The host's error answer, as Fastify's default one: an error's own status code.
  server.onError((err, c) => c.json({ message: err.message }, err.statusCode ?? 500));
  appSync.routes(server);
  cleanup.push(async () => {
    appSync.stop();
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
    const exp = await laptop.server.request("/v1/sync/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectIds: ["p1"] }) });
    expect(exp.status).toBe(200);
    expect(decodeURIComponent(exp.headers.get("content-disposition"))).toMatch(/The Lamp \d{4}-\d{2}-\d{2}\.tsync/);
    const status = await (await laptop.server.request("/v1/sync/status")).json();
    expect(Date.parse(status.settings.lastExport)).toBeGreaterThan(Date.now() - 60_000);

    const phone = await makeApp("phone");
    const file = new Uint8Array(await exp.arrayBuffer());
    const upload = { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file };
    const refused = await phone.server.request("/v1/sync/import", upload);
    expect(refused.status).toBe(409);
    const joined = await phone.server.request("/v1/sync/import?join=1", upload);
    expect(joined.status).toBe(200);
    expect(phone.db.prepare("SELECT id FROM projects").all().map((r) => r.id)).toEqual(["p1"]);
    expect(phone.appSync.get().library).toBe(laptop.appSync.get().library);
    // the window's poll moved: another device's changes landed
    expect((await (await phone.server.request("/v1/sync/rev")).json()).rev).toBeGreaterThan(0);
  });

  it("pairing gives a code; joining with it adopts the library and key even when the device is off", async () => {
    const laptop = await makeApp("laptop");
    const r = await (await laptop.server.request("/v1/sync/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })).json();
    expect(r.code).toMatchObject({ v: 1, app: "testapp", library: laptop.appSync.get().library });
    expect(r.code.key).toHaveLength(43);
    expect(laptop.appSync.readSettings().listenOnNetwork).toBe(true);
    expect(laptop.appSync.networkHost()).toBe("0.0.0.0"); // listening on, and a token exists

    const phone = await makeApp("phone");
    const code = { ...r.code, urls: ["http://127.0.0.1:9/v1/sync"] }; // nothing answers there
    const join = await phone.server.request("/v1/sync/pair/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: JSON.stringify(code) }) });
    expect(join.status).toBe(200);
    expect(await join.json()).toMatchObject({ joined: true, url: null });
    expect(phone.appSync.get().library).toBe(laptop.appSync.get().library);
    expect(phone.appSync.readSettings().key).toBe(r.code.key);
    const bad = await phone.server.request("/v1/sync/pair/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "{}" }),
    });
    expect(bad.status).toBe(400);
  });

  it("a platform without Node's disk (the phone): the engine's own device id, the app's name, its folder store", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);
    const files = new Map(); // a folder in memory, as a cloud store would be
    const store = {
      async list(dir) {
        const prefix = dir ? `${dir}/` : "";
        return [...new Set([...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]))];
      },
      async read(p) {
        if (!files.has(p)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return files.get(p);
      },
      async write(p, bytes) {
        files.set(p, bytes);
      },
      async remove(p) {
        files.delete(p);
      },
    };
    let cfg = null;
    const make = () =>
      createAppSync({
        app: "testapp",
        appName: "Test App",
        schemaVersion: 1,
        tables: () => TABLES,
        database: () => betterSqlite3Adapter(db),
        settings: { read: () => cfg, write: (c) => (cfg = c) },
        auth: { tokens: () => [], add() {} },
        units: { scope: () => () => true, name: () => "x", extension: "tsync" },
        platform: { deviceId: () => undefined, deviceName: () => "Android phone", folder: () => store },
        log: { warning() {} },
      });
    const dir = mkdtempSync(path.join(tmpdir(), "appsync-phone-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = make();
    const s = first.open(dir);
    expect(s.deviceName).toBe("Android phone");
    expect(existsSync(path.join(dir, "sync-device.json"))).toBe(false); // no machine file: the engine keeps the id
    const device = s.device;
    first.stop();
    const again = make();
    expect(again.open(dir).device).toBe(device); // the same device after a restart
    cfg = { ...cfg, folder: "the cloud" };
    db.exec("INSERT INTO projects VALUES ('p1', 'The Lamp', NULL)");
    const r = await again.runFolder();
    again.stop();
    expect(r).toMatchObject({ ok: true });
    expect([...files.keys()].some((k) => k.startsWith(`${s.library}/${device}/`))).toBe(true);
  });

  it("settings: the device name reaches the engine; listening needs a token", async () => {
    const one = await makeApp("one");
    const put = await one.server.request("/v1/sync/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceName: "Study laptop", autoMinutes: 0, listenOnNetwork: true }) });
    expect(await put.json()).toEqual({ ok: true, restartRequired: true });
    expect(one.appSync.get().deviceName).toBe("Study laptop");
    expect(one.appSync.networkHost()).toBe(null); // no token yet: stays on this computer
  });
});
