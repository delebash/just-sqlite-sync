// SPDX-License-Identifier: MIT
// Sync for an app's Hono server — everything an app needs around the engine, in one place:
// this device's identity, the app's `sync` settings, a sync shortly after start and then every
// few minutes (the cloud folder and the paired devices), listening on the network for paired
// devices, pairing codes, the by-hand file, and the routes a sync screen calls. Node only.
//
// The app says what is its own: which tables sync (and their rich-text columns), where it keeps
// the `sync` settings and its bearer tokens, what a by-hand export holds, and how an error
// reaches its client. JustWrite was the first app (its server/src/sync.js, 2026-10-08); this is
// its code, made shared when JustVoice took sync.
//
//   const appSync = createAppSync({ app: "justvoice", appName: "JustVoice", schemaVersion: 1,
//     tables: () => ({ projects: {}, … }), database: () => betterSqlite3Adapter(h.raw),
//     settings: { read, write }, auth: { tokens, add }, units: { scope, name, extension },
//     errors, log, readJson });
//   appSync.open(dataDir); appSync.routes(app); appSync.flush(); appSync.networkHost();
//
// `appSync.routes(app)` adds the routes to the app's own Hono instance (this package creates no
// Hono of its own); `readJson(c)` is the app's JSON body reader (its rules for a body with no
// content type or bad JSON), plain JSON when the app gives none.
//
// The routes (prefix /v1/sync): GET hello · POST pull · POST push (the engine's, another device's
// syncWithPeer calls them) · GET rev (an open window polls it; it moves when another device's
// changes land) · GET status · PUT settings · POST folder/libraries · POST folder/run · POST run ·
// POST export · POST import · POST peer/run · POST pair · POST pair/join.
//
// A restore of a backup (the kit's data router) takes `appSync.restoreHooks` — its beforeCopy,
// afterCopy and afterTables: this device continues as a new device in sync, keeps its own `sync`
// settings, and refuses a backup from another sync library while it syncs (docs/design.md §3.7).
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSync } from "./engine.js";
import { REOPENED, RESTORE_OTHER_LIBRARY, SyncError } from "./errors.js";
import { decodeFile, encodeFile, generateLibraryKey, readFileHeader } from "./file.js";
import { afterRestoreCopy, beforeRestoreCopy, restoreLibraries, restorePending } from "./restore.js";
import { folderSync } from "./transports/folder.js";
import { plainJson, registerSyncRoutes, tooLarge } from "./transports/hono.js";
import { syncWithPeer } from "./transports/http.js";
import { nodeFolder } from "./transports/node-folder.js";

const RETIRE = Symbol("retire");

/** The `sync` settings section's fields, with their defaults. */
export const SYNC_SETTINGS_DEFAULTS = Object.freeze({
  deviceName: null, // shown to the other devices; the computer's name when unset
  folder: null, // a folder inside Dropbox/OneDrive/… the desktop's sync client keeps in step
  autoMinutes: 5, // folder and paired devices: sync this often while the app runs (0 = by hand only)
  pollSeconds: 5, // an open window checks this often whether another device's changes landed
  listenOnNetwork: false, // let paired devices reach this server (applies on the next start)
  key: null, // the library key: encrypts folder files; travels in the pairing code
  lastExport: null, // when units were last exported by hand — the export picker ticks those changed since
  peers: [], // [{ url, token, name }] — devices or servers this one syncs with over HTTP
});

function statusError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

const DEFAULT_ERRORS = {
  badRequest: (detail) => statusError(400, detail),
  notReady: () => statusError(503, "database not ready"),
  refused: (e) => Object.assign(statusError(409, e.message), { code: e.code }),
};

const identityFile = (dataDir) => path.join(dataDir, "sync-device.json");
const thisMachine = () =>
  createHash("sha256").update(`${os.hostname()}\u0000${os.userInfo().username}\u0000${process.platform}`).digest("hex").slice(0, 16);

/**
 * This device's id, kept beside the database: `sync-device.json` in the data folder, tied to this
 * machine and user — a data folder copied to another computer becomes a new device instead of a
 * twin of this one (two devices with one id would lose each other's changes).
 */
export function deviceIdentity(dataDir) {
  const machine = thisMachine();
  try {
    const j = JSON.parse(readFileSync(identityFile(dataDir), "utf8"));
    if (j && j.machine === machine && typeof j.id === "string" && j.id) return j.id;
  } catch {
    // none yet, or unreadable: a new identity
  }
  return newIdentity(dataDir);
}

/**
 * A new id for this device, written to `sync-device.json`: after a restore this device continues
 * as a new device in sync (the id it had becomes an origin like any other — the engine's rule for
 * a copied database). Returns the id.
 */
export function newIdentity(dataDir) {
  const id = randomBytes(8).toString("hex");
  writeFileSync(identityFile(dataDir), JSON.stringify({ id, machine: thisMachine() }));
  return id;
}

/** The addresses another device can reach this server at (the same Wi-Fi, Tailscale, ZeroTier…). */
export function reachableUrls(port, prefix = "/v1/sync") {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${port}${prefix}`);
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.app the engine's app id — also the pairing code's `app`
 * @param {string} opts.appName the app's name, in messages
 * @param {number} opts.schemaVersion the synced tables' shape version
 * @param {() => object} opts.tables the engine's table config (openSync `tables`)
 * @param {() => object} opts.database the engine's adapter on the app's database (betterSqlite3Adapter…)
 * @param {{ read(): object|null, write(cfg: object): void }} opts.settings where the app keeps the `sync` section
 * @param {{ tokens(): string[], add(token: string): void, set?(tokens: string[]): void }} opts.auth the
 *   app's bearer tokens; `set` replaces them — after a restore this device's own go back (the backup's
 *   are older: a device paired since would be locked out, one removed since let back in)
 * @param {{ scope(ids: string[]): (table: string, pk: unknown[]) => boolean, name(ids: string[]): string, extension: string, noun?: string }} opts.units
 *   what a by-hand export holds: the units (books, projects…) the user picked; `noun` names them
 *   in messages ("books")
 * @param {object} [opts.yjs] the app's Yjs module — required with text columns (Yjs must exist once per process)
 * @param {object|(() => object)} [opts.windows] the app's windows on this one server — the kit's `ChangeCounter`
 *   (`@delebash/core/platform`, its window_changes.js), or a function answering it: `rev` then moves for the
 *   other windows' changes too, not only another device's, and carries the data's `epoch` (a restore or a reset
 *   elsewhere reloads the window) — the kit's watchOtherWindows reads it. Without it the answer is as before.
 * @param {{ badRequest(detail: string): Error, notReady(): Error, refused(e: SyncError): Error,
 *           libraryMismatch?(fromName: string|null): Error }} [opts.errors] how errors reach the client
 * @param {{ warning(msg: string): void }} [opts.log]
 * @param {(c: object) => Promise<any>} [opts.readJson] the app's JSON body reader (default plain JSON)
 * @param {string} [opts.prefix]
 * @param {object} [opts.platform] where the app runs, when not on a computer's Node (the phone's in-app
 *   server, a worker): `deviceId(dataDir)` → this device's id (default `deviceIdentity`; undefined lets
 *   the engine keep its own in the database), `newDeviceId(dataDir)` → after a restore, a new id that
 *   `deviceId` returns from then on (default `newIdentity`; a platform whose `deviceId` returns
 *   undefined needs none — the engine makes the new id), `deviceName()` → the name before the user
 *   sets one (default the computer's), `folder(path)` → the store a cloud-folder setting names
 *   (default `nodeFolder`)
 */
export function createAppSync(opts) {
  const { app, appName, schemaVersion, tables, database, settings, auth, units, yjs, prefix = "/v1/sync" } = opts;
  const platform = {
    deviceId: (dataDir) => deviceIdentity(dataDir),
    // a platform that keeps the id itself says how to make a new one (or lets the engine keep it)
    newDeviceId: opts.platform?.deviceId ? null : (dataDir) => newIdentity(dataDir),
    deviceName: () => os.hostname(),
    folder: (where) => nodeFolder(where),
    ...(opts.platform ?? {}),
  };
  const errors = { ...DEFAULT_ERRORS, ...(opts.errors ?? {}) };
  const log = opts.log ?? { warning: (m) => console.warn(m) };
  const readJson = opts.readJson ?? plainJson;
  const windowsOf = typeof opts.windows === "function" ? opts.windows : opts.windows ? () => opts.windows : null;

  let current = null; // { sync, dataDir }
  let rev = 0; // moves whenever another device's changes land here — the window reloads
  const lastRun = { folder: null, peers: [] };
  let timer = null;
  let startSync = null; // the one sync shortly after the server starts (the design: "when the app opens")

  // ── the `sync` settings section ──────────────────────────────────────────────────────
  function readSettings() {
    try {
      const cfg = settings.read();
      return { ...SYNC_SETTINGS_DEFAULTS, ...(cfg && typeof cfg === "object" ? cfg : {}) };
    } catch (e) {
      log.warning(`sync settings unreadable, using defaults: ${e?.message ?? e}`);
      return { ...SYNC_SETTINGS_DEFAULTS };
    }
  }
  const writeSettings = (cfg) => settings.write({ ...SYNC_SETTINGS_DEFAULTS, ...cfg });

  function libraryKey() {
    const cfg = readSettings();
    if (cfg.key) return cfg.key;
    const key = generateLibraryKey();
    writeSettings({ ...cfg, key });
    return key;
  }

  // ── the engine on this database ──────────────────────────────────────────────────────

  /**
   * The engine, wrapped so every apply that changed rows moves `rev` — and so it can be retired:
   * after a restore, a sync run still holding the engine it started with (a folder read, a peer's
   * answer on its way) stops at its next step instead of writing under the old identity.
   */
  function tracked(sync) {
    let retired = false;
    return new Proxy(sync, {
      get(target, prop) {
        if (prop === RETIRE) {
          return () => {
            retired = true;
          };
        }
        if (retired && typeof target[prop] === "function") {
          return () => {
            throw new SyncError(REOPENED, "sync reopened after a backup was restored — the next sync continues");
          };
        }
        if (prop === "apply") {
          return (batch, o) => {
            const r = target.apply(batch, o);
            if (r.rows) rev++;
            return r;
          };
        }
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  /** Open sync on the app's tables (after its database is ready). Safe to call again. */
  function open(dataDir) {
    const cfg = readSettings();
    const db = database();
    // a restore copied a backup in and sync hasn't reopened since (the server may have stopped in
    // between): this device continues as a new device
    if (restorePending(db)) platform.newDeviceId?.(dataDir);
    const sync = openSync(db, {
      app,
      schemaVersion,
      tables: tables(),
      deviceId: platform.deviceId(dataDir),
      deviceName: cfg.deviceName || platform.deviceName(),
      ...(yjs ? { yjs } : {}),
    });
    current = { sync: tracked(sync), dataDir };
    schedule();
    return current.sync;
  }

  const get = () => current?.sync ?? null;

  /** Stamp what the triggers noted — after every write request and before every sync. Returns how many fields it
   *  stamped (the engine's flush): 0 when nothing changed, it failed, or no engine is open — so an app can tell a
   *  request that changed synced rows (a change another window re-reads) from one that didn't. */
  function flush() {
    try {
      return current?.sync.flush() ?? 0;
    } catch (e) {
      log.warning(`sync flush failed: ${e?.message ?? e}`);
      return 0;
    }
  }

  /**
   * The app dropped and re-created its tables (a workspace reset): this device starts a new
   * library (its identity stays). The engine's tables and triggers go with the old one.
   */
  function reset(dataDir) {
    const db = database();
    for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_\\_%' ESCAPE '\\'")) {
      db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
    }
    for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sync\\_%' ESCAPE '\\'")) {
      db.exec(`DROP TABLE IF EXISTS "${name}"`);
    }
    return open(dataDir ?? current?.dataDir);
  }

  function need() {
    const s = get();
    if (!s) throw errors.notReady();
    return s;
  }

  // ── restoring a backup (the kit's data router: beforeCopy, afterCopy, afterTables) ───────

  let kept = null; // this device's `sync` settings, read before the copy, written back after
  let keptTokens = null; // and its bearer tokens (the paired devices'), when the app can set them

  /**
   * Before the copy, inside the restore's transaction (`h` its connection, the backup attached as
   * `src`). While this device syncs (a cloud folder or a paired device is set), a backup from
   * another sync library is refused — its contents would merge into this library on every device.
   * A device that isn't syncing takes it, and stays in its own library.
   */
  function beforeCopy(h) {
    const cfg = readSettings();
    const syncing = !!cfg.folder || (cfg.peers ?? []).length > 0;
    if (syncing) {
      const { live, backup } = restoreLibraries(h);
      if (live && backup && live !== backup) {
        throw errors.refused(
          new SyncError(
            RESTORE_OTHER_LIBRARY,
            "This backup is from another sync library. Stop using the cloud folder and remove your paired devices in Settings → Sync, then restore it.",
            { library: backup },
          ),
        );
      }
    }
    kept = cfg;
    keptTokens = null;
    if (typeof auth.set === "function") {
      try {
        keptTokens = [...(auth.tokens() ?? [])];
      } catch (e) {
        log.warning(`bearer tokens unreadable before the restore: ${e?.message ?? e}`);
      }
    }
    beforeRestoreCopy(h);
  }

  /** After the copy, inside the restore's transaction: the backup's sync stamps come with its rows. */
  function afterCopy(h) {
    afterRestoreCopy(h);
  }

  /**
   * Right after the copy commits: this device's own `sync` settings go back (the library key, the
   * paired devices, the folder, the device name — the backup's are older, or another computer's),
   * with its bearer tokens (`auth.set`), and sync reopens as a new device. The id it had stays an origin holding what the backup held of
   * it; the other devices' newer work comes back on the next sync. `dataDir` defaults to the one
   * sync was opened with.
   */
  function afterRestore(dataDir) {
    const dir = dataDir ?? current?.dataDir;
    if (current) current.sync[RETIRE]();
    current = null;
    if (kept) {
      const cfg = kept;
      kept = null;
      try {
        writeSettings(cfg);
      } catch (e) {
        log.warning(`sync settings couldn't be put back after the restore: ${e?.message ?? e}`);
      }
    }
    if (keptTokens) {
      const tokens = keptTokens;
      keptTokens = null;
      try {
        auth.set(tokens);
      } catch (e) {
        log.warning(`bearer tokens couldn't be put back after the restore: ${e?.message ?? e}`);
      }
    }
    return dir == null ? null : open(dir);
  }

  // ── running a sync ───────────────────────────────────────────────────────────────────

  async function runFolder() {
    const cfg = readSettings();
    if (!cfg.folder) return null;
    const started = new Date().toISOString();
    try {
      const r = await folderSync(need(), platform.folder(cfg.folder), { key: libraryKey(), name: "folder" }).sync();
      lastRun.folder = { at: started, ok: true, pulled: r.pulled.applied, pushed: r.pushed.written, problems: r.pulled.problems.length };
    } catch (e) {
      lastRun.folder = { at: started, ok: false, error: String(e?.message ?? e), code: e?.code ?? null };
      log.warning(`folder sync failed: ${e?.message ?? e}`);
    }
    return lastRun.folder;
  }

  async function runPeers() {
    const cfg = readSettings();
    const out = [];
    for (const p of cfg.peers ?? []) {
      const started = new Date().toISOString();
      try {
        const r = await syncWithPeer(need(), { url: p.url, token: p.token });
        out.push({ url: p.url, name: r.peer.name ?? p.name, at: started, ok: true, pulled: r.pulled.applied, sent: r.pushed.sent });
      } catch (e) {
        out.push({ url: p.url, name: p.name, at: started, ok: false, error: String(e?.message ?? e), code: e?.code ?? null });
      }
    }
    lastRun.peers = out;
    return out;
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = null;
    const minutes = Number(readSettings().autoMinutes) || 0;
    if (minutes <= 0) return;
    if (startSync === null) {
      startSync = setTimeout(() => void runFolder().then(runPeers), 15_000);
      startSync.unref?.();
    }
    timer = setInterval(() => {
      void runFolder().then(runPeers);
    }, minutes * 60_000);
    timer.unref?.();
  }

  /** Stop the auto-sync timers (the server is stopping). */
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (startSync) clearTimeout(startSync);
  }

  /** Listen on the network instead of only this computer — when the user turned it on AND a
   * pairing token exists (with no token the server would be open to anyone on the network). */
  function networkHost() {
    if (!readSettings().listenOnNetwork) return null;
    let tokens = [];
    try {
      tokens = auth.tokens() ?? [];
    } catch {
      return null;
    }
    if (!tokens.some((t) => typeof t === "string" && t)) {
      log.warning("sync: 'let my other devices connect' is on but no pairing token exists — staying on this computer only");
      return null;
    }
    return "0.0.0.0";
  }

  function failure(e) {
    // a SyncError carries the engine's code (library-mismatch, schema-too-new, clock-drift,
    // wrong-key, …) so the window can say what to do
    if (e instanceof SyncError) throw errors.refused(e);
    throw e;
  }

  // ── the routes ───────────────────────────────────────────────────────────────────────

  /** This server's own address — Node's socket under @hono/node-server; none inside the app (the
   * phone's in-app server answers without one). */
  const localSocket = (c) => c.env?.incoming?.socket ?? null;

  /** Add the routes to the app's Hono instance. */
  function routes(server) {
    registerSyncRoutes(server, need, { prefix, readJson });

    server.get(`${prefix}/rev`, (c) => {
      const pollSeconds = Number(readSettings().pollSeconds) || 5;
      const w = windowsOf?.();
      if (!w) return c.json({ rev, pollSeconds });
      // another device's changes, and the OTHER windows' on this server (their X-Client-Id apart): opaque — the
      // window compares it whole; the counter's boot id in it makes a server started again a change too
      return c.json({ rev: `${rev}:${w.boot}:${w.revFor(c.req.header("x-client-id") || null)}`, epoch: w.epoch, pollSeconds });
    });

    server.get(`${prefix}/status`, (c) => {
      const s = need();
      const cfg = readSettings();
      const socket = localSocket(c);
      return c.json({
        device: s.device,
        deviceName: s.deviceName,
        library: s.library,
        rev,
        peers: s.peers(),
        settings: {
          deviceName: cfg.deviceName,
          folder: cfg.folder,
          autoMinutes: cfg.autoMinutes,
          pollSeconds: cfg.pollSeconds,
          listenOnNetwork: cfg.listenOnNetwork,
          hasKey: !!cfg.key,
          lastExport: cfg.lastExport,
          peers: (cfg.peers ?? []).map((p) => ({ url: p.url, name: p.name ?? null })),
        },
        lastRun,
        listening: { host: socket?.localAddress ?? null, port: socket?.localPort ?? null },
      });
    });

    server.put(`${prefix}/settings`, async (c) => {
      const body = (await readJson(c)) ?? {};
      const cfg = readSettings();
      const next = { ...cfg };
      if ("deviceName" in body) next.deviceName = body.deviceName ? String(body.deviceName) : null;
      if ("folder" in body) next.folder = body.folder ? String(body.folder) : null;
      if ("autoMinutes" in body) next.autoMinutes = Math.max(0, Number(body.autoMinutes) || 0);
      if ("pollSeconds" in body) next.pollSeconds = Math.max(1, Number(body.pollSeconds) || 5);
      if ("listenOnNetwork" in body) next.listenOnNetwork = !!body.listenOnNetwork;
      if (Array.isArray(body.removePeers)) next.peers = (cfg.peers ?? []).filter((p) => !body.removePeers.includes(p.url));
      writeSettings(next);
      if (next.deviceName && next.deviceName !== cfg.deviceName) need().setDeviceName(next.deviceName);
      schedule();
      return c.json({ ok: true, restartRequired: next.listenOnNetwork !== cfg.listenOnNetwork });
    });

    /** The libraries already in a folder (to join one instead of starting a second). */
    server.post(`${prefix}/folder/libraries`, async (c) => {
      const body = await readJson(c);
      const folder = body?.folder || readSettings().folder;
      if (!folder) throw errors.badRequest("no folder given");
      return c.json({ libraries: await folderSync(need(), platform.folder(String(folder))).libraries() });
    });

    server.post(`${prefix}/folder/run`, async (c) => {
      const r = await runFolder();
      if (!r) throw errors.badRequest("no sync folder is set");
      return c.json(r);
    });

    server.post(`${prefix}/run`, async (c) => c.json({ folder: await runFolder(), peers: await runPeers() }));

    /** A file of some units (books, projects…), carried by hand to another device (import merges). */
    server.post(`${prefix}/export`, async (c) => {
      const body = await readJson(c);
      const ids = Array.isArray(body?.projectIds) ? body.projectIds.map(String) : [];
      if (!ids.length) throw errors.badRequest("pick at least one");
      const batch = need().changesSince({}, { scope: units.scope(ids) });
      const bytes = await encodeFile(batch, body?.encrypt ? { key: libraryKey() } : {});
      writeSettings({ ...readSettings(), lastExport: new Date().toISOString() });
      const base = String(units.name(ids) || appName).replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || appName;
      const d = new Date(); // today on this computer's calendar, not UTC's
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const name = `${base}${ids.length > 1 ? ` +${ids.length - 1}` : ""} ${day}.${units.extension}`;
      return c.body(bytes, 200, {
        "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
        "Content-Type": "application/octet-stream",
      });
    });

    /** Import a carried file: merges. `?join=1` adopts the file's library (a device's first sync). */
    server.post(`${prefix}/import`, async (c) => {
      if (Number(c.req.header("content-length") ?? 0) > 1024 * 1024 * 1024) throw tooLarge();
      const bytes = /^application\/octet-stream/i.test(c.req.header("content-type") || "")
        ? new Uint8Array(await c.req.arrayBuffer())
        : null;
      if (!bytes) throw errors.badRequest("send the file as application/octet-stream");
      let header;
      try {
        header = readFileHeader(bytes);
      } catch (e) {
        failure(e);
      }
      const s = need();
      const join = String(c.req.query("join") ?? "") === "1";
      if (header.library !== s.library && !join) {
        throw errors.refused(
          new SyncError("library-mismatch", `This file is from another library${header.fromName ? ` (${header.fromName})` : ""}. Join it to merge its ${units.noun ?? "contents"} into this one.`, { fromName: header.fromName ?? null }),
        );
      }
      try {
        const batch = await decodeFile(bytes, header.enc ? { key: readSettings().key ?? undefined } : {});
        const r = s.apply(batch, { join });
        s.recordPeer(header.from, { name: header.fromName ?? null, kind: "file" });
        return c.json({ applied: r.applied, rows: r.rows, problems: r.problems, from: header.fromName ?? header.from });
      } catch (e) {
        failure(e);
      }
    });

    /** Sync now with a device or server over HTTP (and remember it). */
    server.post(`${prefix}/peer/run`, async (c) => {
      const { url, token, join } = (await readJson(c)) ?? {};
      if (!url) throw errors.badRequest("give the other device's address");
      try {
        const r = await syncWithPeer(need(), { url: String(url), token: token ? String(token) : undefined, join: !!join });
        const cfg = readSettings();
        const peers = (cfg.peers ?? []).filter((p) => p.url !== url);
        writeSettings({ ...cfg, peers: [...peers, { url: String(url), token: token ? String(token) : null, name: r.peer.name ?? null }] });
        return c.json({ peer: r.peer, pulled: r.pulled.applied, sent: r.pushed.sent });
      } catch (e) {
        failure(e);
      }
    });

    /**
     * Pair a device: a code (shown as a QR) with this library, its key, a new token for the other
     * device, and this server's addresses. Turning pairing on also turns on listening on the
     * network (applies on the next start).
     */
    server.post(`${prefix}/pair`, (c) => {
      const s = need();
      const token = randomBytes(24).toString("base64url");
      auth.add(token);
      const cfg = readSettings();
      const wasListening = cfg.listenOnNetwork;
      writeSettings({ ...cfg, listenOnNetwork: true });
      const port = localSocket(c)?.localPort;
      return c.json({
        code: { v: 1, app, library: s.library, key: libraryKey(), token, name: s.deviceName, urls: port ? reachableUrls(port, prefix) : [] },
        restartRequired: !wasListening,
      });
    });

    /**
     * The other side of pairing: join with a code from another device. The code is the authority:
     * this device adopts its library and key at once, so a shared cloud folder carries changes
     * even when the other device can't be reached; then it syncs with the first address that
     * answers and remembers it.
     */
    server.post(`${prefix}/pair/join`, async (c) => {
      const body = await readJson(c);
      let code;
      try {
        code = typeof body?.code === "string" ? JSON.parse(body.code) : body?.code;
      } catch {
        code = null;
      }
      if (!code || code.app !== app || !code.library || !Array.isArray(code.urls)) throw errors.badRequest(`not a ${appName} pairing code`);
      const s = need();
      if (s.library !== code.library) s.joinLibrary(code.library);
      writeSettings({ ...readSettings(), key: code.key ?? readSettings().key });
      for (const url of code.urls) {
        try {
          const r = await syncWithPeer(s, { url, token: code.token, join: true });
          const cfg = readSettings();
          const peers = (cfg.peers ?? []).filter((p) => p.url !== url);
          writeSettings({ ...cfg, peers: [...peers, { url, token: code.token, name: r.peer.name ?? code.name ?? null }] });
          return c.json({ joined: true, url, peer: r.peer, pulled: r.pulled.applied, sent: r.pushed.sent });
        } catch (e) {
          log.warning(`pairing: ${url} didn't answer: ${e?.message ?? e}`);
        }
      }
      // Joined, but no address answered (the other device is off or on another network): the
      // folder, or a later "Sync now", carries the changes.
      return c.json({ joined: true, url: null, peer: { name: code.name ?? null }, pulled: 0, sent: 0 });
    });
  }

  return {
    open,
    get,
    flush,
    reset,
    stop,
    networkHost,
    readSettings,
    routes,
    runFolder,
    runPeers,
    afterRestore,
    /** A restore's steps, as the kit's data router names them (makeDataRouter's options). */
    restoreHooks: { beforeCopy, afterCopy, afterTables: () => void afterRestore() },
  };
}
