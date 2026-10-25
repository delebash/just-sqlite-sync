// SPDX-License-Identifier: MIT
// The app layer (src/app.js): two app servers — each a database, its `sync` settings and tokens
// in a settings table, the routes on Hono — exchanging a file by hand, refusing another
// library until joined, pairing with a device that's off, the settings and status routes, and
// restoring a backup through the kit's restore hooks.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAppSync } from "../src/app.js";
import { REOPENED, RESTORE_OTHER_LIBRARY, betterSqlite3Adapter, restorePending } from "../src/index.js";
import { APP_TABLES, SCHEMA, TABLES, Y, fileDatabase, restoreCopy } from "./helpers.js";

const cleanup = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/**
 * One app: its database, its settings rows, its server with the sync routes. `file`: the database
 * is a file in the data folder (a restore copies on its own connection), and `make()` builds
 * another app layer on it (the server started again).
 */
async function makeApp(name, { file = false, windows = undefined } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), `appsync-${name}-`));
  const dbFile = file ? path.join(dir, "app.db") : null;
  const db = dbFile ? fileDatabase(dbFile) : new Database(":memory:");
  if (!dbFile) {
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);
  }
  const getRow = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
  const putRow = (key, value) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  const make = () => createAppSync({
    app: "testapp",
    appName: "Test App",
    schemaVersion: 1,
    tables: () => TABLES,
    yjs: Y,
    database: () => betterSqlite3Adapter(db),
    settings: { read: () => JSON.parse(getRow("sync") ?? "null"), write: (cfg) => putRow("sync", JSON.stringify(cfg)) },
    auth: {
      tokens: () => JSON.parse(getRow("tokens") ?? "[]"),
      add: (t) => putRow("tokens", JSON.stringify([...JSON.parse(getRow("tokens") ?? "[]"), t])),
      set: (tokens) => putRow("tokens", JSON.stringify(tokens)),
    },
    units: { scope: (ids) => (t, pk) => t !== "images" && ids.includes(pk[0]), name: (ids) => db.prepare("SELECT title FROM projects WHERE id = ?").get(ids[0])?.title, extension: "tsync" },
    log: { warning() {} },
    windows,
  });
  const appSync = make();
  appSync.open(dir);
  const server = new Hono();
  // The host's error answer, as Fastify's default one: an error's own status code.
  server.onError((err, c) => c.json({ message: err.message }, err.statusCode ?? 500));
  appSync.routes(server);
  cleanup.push(async () => {
    appSync.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (sql) => {
    db.exec(sql);
    appSync.flush();
  };
  return { db, dbFile, dir, appSync, server, write, make, putRow };
}

/** What the kit's data router does with an app's restore hooks: the copy (the app's tables and its
 * settings table) between beforeCopy and afterCopy, then afterTables once it committed. */
function restoreThrough(one, backup) {
  const { beforeCopy, afterCopy, afterTables } = one.appSync.restoreHooks;
  restoreCopy(one.dbFile, backup, { beforeCopy, afterCopy, tables: [...APP_TABLES, "settings"] });
  afterTables();
}

function backupOf(one, name) {
  const file = path.join(one.dir, `${name}.db`);
  one.db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  return file;
}

const idOnFile = (one) => JSON.parse(readFileSync(path.join(one.dir, "sync-device.json"), "utf8")).id;
const titles = (one) => one.db.prepare("SELECT title FROM projects ORDER BY id").all().map((r) => r.title);

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

  it("with the app's windows: rev moves for the OTHER windows' changes too and carries the data's epoch; without, as before", async () => {
    // the kit's ChangeCounter, as the app passes it (a stand-in: this package never imports the kit)
    const counter = { boot: "b1", epoch: "e1", revFor: (id) => (id === "window-a" ? 0 : 1) };
    const one = await makeApp("windows", { windows: () => counter });
    const ask = async (who) => (await one.server.request("/v1/sync/rev", { headers: { "x-client-id": who } })).json();
    expect(await ask("window-a")).toEqual({ rev: "0:b1:0", epoch: "e1", pollSeconds: 5 });
    expect(await ask("window-b")).toEqual({ rev: "0:b1:1", epoch: "e1", pollSeconds: 5 });
    const plain = await makeApp("plain");
    expect(await (await plain.server.request("/v1/sync/rev")).json()).toEqual({ rev: 0, pollSeconds: 5 });
  });

  it("flush answers how many fields it stamped — a write to synced rows, else 0", async () => {
    const one = await makeApp("flushcount");
    one.db.exec("INSERT INTO projects VALUES ('p1', 'The Lamp', 'Mira');");
    expect(one.appSync.flush()).toBeGreaterThan(0);
    expect(one.appSync.flush()).toBe(0); // nothing new since
    one.db.exec("UPDATE projects SET title = 'The Lamp' WHERE id = 'p1';"); // the same value: no change to stamp
    expect(one.appSync.flush()).toBe(0);
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
        yjs: Y,
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

describe("the app layer: restoring a backup", () => {
  const LIVE = { deviceName: "Studio PC", autoMinutes: 0, key: "live-key", folder: null, peers: [{ url: "http://127.0.0.1:9/v1/sync", token: "t1", name: "Laptop" }] };

  it("this computer continues as a new device in sync and keeps its own sync settings", async () => {
    const one = await makeApp("one", { file: true });
    one.write("INSERT INTO projects VALUES ('p1', 'The Lamp', NULL)");
    one.putRow("sync", JSON.stringify({ deviceName: "Before the backup", autoMinutes: 0, key: "old-key" }));
    one.putRow("tokens", JSON.stringify(["removed-since"]));
    const backup = backupOf(one, "backup");
    one.putRow("sync", JSON.stringify(LIVE));
    one.putRow("tokens", JSON.stringify(["paired-since"]));
    one.write("UPDATE projects SET title = 'The Brass Lamp' WHERE id = 'p1'");
    const old = one.appSync.get();
    const before = old.device;
    const library = old.library;

    restoreThrough(one, backup);
    const now = one.appSync.get();
    expect(titles(one)).toEqual(["The Lamp"]);
    expect(now.device).not.toBe(before);
    expect(idOnFile(one)).toBe(now.device);
    expect(now.vector()[before]).toBeGreaterThan(0); // the id it had: an origin, at what the backup held
    expect(now.library).toBe(library);
    expect(one.appSync.readSettings()).toMatchObject(LIVE); // not the backup's
    expect(JSON.parse(one.db.prepare("SELECT value FROM settings WHERE key = 'tokens'").get().value)).toEqual(["paired-since"]);
    expect(restorePending(betterSqlite3Adapter(one.db))).toBe(false);
    // a sync run still holding the engine from before stops instead of writing as the old device
    expect(() => old.vector()).toThrow(expect.objectContaining({ code: REOPENED }));
  });

  it("a backup from another sync library: refused while this computer syncs, taken when it doesn't", async () => {
    const one = await makeApp("one", { file: true });
    one.write("INSERT INTO projects VALUES ('p1', 'Mine', NULL)");
    const other = await makeApp("other", { file: true });
    other.write("INSERT INTO projects VALUES ('p9', 'Theirs', NULL)");
    const backup = backupOf(other, "theirs");
    const library = one.appSync.get().library;
    const before = one.appSync.get().device;

    one.putRow("sync", JSON.stringify(LIVE)); // a paired device is set
    let refused;
    try {
      restoreThrough(one, backup);
    } catch (e) {
      refused = e;
    }
    expect(refused).toMatchObject({ statusCode: 409, code: RESTORE_OTHER_LIBRARY });
    expect(refused.message).toBe("This backup is from another sync library. Stop using the cloud folder and remove your paired devices in Settings → Sync, then restore it.");
    expect(titles(one)).toEqual(["Mine"]); // nothing copied
    expect(one.appSync.get().device).toBe(before);

    one.putRow("sync", JSON.stringify({ ...LIVE, peers: [], folder: "C:/Dropbox/Test" })); // a cloud folder is set
    expect(() => restoreThrough(one, backup)).toThrow(expect.objectContaining({ code: RESTORE_OTHER_LIBRARY }));

    one.putRow("sync", JSON.stringify({ ...LIVE, peers: [], folder: null })); // not syncing
    restoreThrough(one, backup);
    expect(titles(one)).toEqual(["Theirs"]);
    expect(one.appSync.get().library).toBe(library); // it stays in its own library
    expect(one.appSync.get().device).not.toBe(before);
  });

  it("the status route: the entry that was this computer before the restore says so, with the name it had", async () => {
    const one = await makeApp("one", { file: true });
    const folder = path.join(one.dir, "cloud");
    const put = await one.server.request("/v1/sync/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceName: "Studio PC", autoMinutes: 0, folder }) });
    expect(put.status).toBe(200);
    one.write("INSERT INTO projects VALUES ('p1', 'The Lamp', NULL)");
    expect(await one.appSync.runFolder()).toMatchObject({ ok: true });
    const backup = backupOf(one, "backup");
    const before = one.appSync.get().device;

    restoreThrough(one, backup);
    expect(await one.appSync.runFolder()).toMatchObject({ ok: true }); // reads its old folder copy
    const status = await (await one.server.request("/v1/sync/status")).json();
    expect(status.deviceName).toBe("Studio PC");
    expect(status.peers).toEqual([
      expect.objectContaining({ id: before, name: "Studio PC", kind: "folder", retired: { name: "Studio PC", at: expect.any(String) } }),
    ]);
    expect(Number.isFinite(Date.parse(status.peers[0].retired.at))).toBe(true);
  });

  it("the server stopped right after the copy: the next start continues as a new device", async () => {
    const one = await makeApp("one", { file: true });
    one.write("INSERT INTO projects VALUES ('p1', 'The Lamp', NULL)");
    const backup = backupOf(one, "backup");
    const before = one.appSync.get().device;
    const { beforeCopy, afterCopy } = one.appSync.restoreHooks;
    restoreCopy(one.dbFile, backup, { beforeCopy, afterCopy, tables: [...APP_TABLES, "settings"] }); // no afterTables
    one.appSync.stop();
    const again = one.make();
    const s = again.open(one.dir);
    again.stop();
    expect(s.device).not.toBe(before);
    expect(idOnFile(one)).toBe(s.device);
    expect(s.vector()[before]).toBeGreaterThan(0);
  });
});
