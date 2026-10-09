// SPDX-License-Identifier: MIT
// Sync for an app's Fastify server — everything an app needs around the engine, in one place:
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
//     errors, log });
//   appSync.open(dataDir); app.register(appSync.routes); appSync.flush(); appSync.networkHost();
//
// The routes (prefix /v1/sync): GET hello · POST pull · POST push (the engine's, another device's
// syncWithPeer calls them) · GET rev (an open window polls it; it moves when another device's
// changes land) · GET status · PUT settings · POST folder/libraries · POST folder/run · POST run ·
// POST export · POST import · POST peer/run · POST pair · POST pair/join.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSync } from "./engine.js";
import { SyncError } from "./errors.js";
import { decodeFile, encodeFile, generateLibraryKey, readFileHeader } from "./file.js";
import { folderSync } from "./transports/folder.js";
import { registerSyncRoutes } from "./transports/fastify.js";
import { syncWithPeer } from "./transports/http.js";
import { nodeFolder } from "./transports/node-folder.js";

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

/**
 * This device's id, kept beside the database: `sync-device.json` in the data folder, tied to this
 * machine and user — a data folder copied to another computer becomes a new device instead of a
 * twin of this one (two devices with one id would lose each other's changes).
 */
export function deviceIdentity(dataDir) {
  const file = path.join(dataDir, "sync-device.json");
  const machine = createHash("sha256").update(`${os.hostname()}\u0000${os.userInfo().username}\u0000${process.platform}`).digest("hex").slice(0, 16);
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j && j.machine === machine && typeof j.id === "string" && j.id) return j.id;
  } catch {
    // none yet, or unreadable: a new identity
  }
  const id = randomBytes(8).toString("hex");
  writeFileSync(file, JSON.stringify({ id, machine }));
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
 * @param {{ tokens(): string[], add(token: string): void }} opts.auth the app's bearer tokens
 * @param {{ scope(ids: string[]): (table: string, pk: unknown[]) => boolean, name(ids: string[]): string, extension: string, noun?: string }} opts.units
 *   what a by-hand export holds: the units (books, projects…) the user picked; `noun` names them
 *   in messages ("books")
 * @param {object} [opts.yjs] the app's own Yjs, for rich-text columns
 * @param {{ badRequest(detail: string): Error, notReady(): Error, refused(e: SyncError): Error,
 *           libraryMismatch?(fromName: string|null): Error }} [opts.errors] how errors reach the client
 * @param {{ warning(msg: string): void }} [opts.log]
 * @param {string} [opts.prefix]
 * @param {object} [opts.platform] where the app runs, when not on a computer's Node (the phone's in-app
 *   server, a worker): `deviceId(dataDir)` → this device's id (default `deviceIdentity`; undefined lets
 *   the engine keep its own in the database), `deviceName()` → the name before the user sets one
 *   (default the computer's), `folder(path)` → the store a cloud-folder setting names (default
 *   `nodeFolder`)
 */
export function createAppSync(opts) {
  const { app, appName, schemaVersion, tables, database, settings, auth, units, yjs, prefix = "/v1/sync" } = opts;
  const platform = {
    deviceId: (dataDir) => deviceIdentity(dataDir),
    deviceName: () => os.hostname(),
    folder: (where) => nodeFolder(where),
    ...(opts.platform ?? {}),
  };
  const errors = { ...DEFAULT_ERRORS, ...(opts.errors ?? {}) };
  const log = opts.log ?? { warning: (m) => console.warn(m) };

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

  /** The engine, wrapped so every apply that changed rows moves `rev`. */
  function tracked(sync) {
    return new Proxy(sync, {
      get(target, prop) {
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
    const sync = openSync(database(), {
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

  /** Stamp what the triggers noted — after every write request and before every sync. */
  function flush() {
    try {
      current?.sync.flush();
    } catch (e) {
      log.warning(`sync flush failed: ${e?.message ?? e}`);
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

  async function routes(fastify) {
    registerSyncRoutes(fastify, need, { prefix });

    fastify.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 1024 * 1024 * 1024 }, (_req, body, done) => done(null, body));

    fastify.get(`${prefix}/rev`, async () => ({ rev, pollSeconds: Number(readSettings().pollSeconds) || 5 }));

    fastify.get(`${prefix}/status`, async (req) => {
      const s = need();
      const cfg = readSettings();
      return {
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
        listening: { host: req.socket?.localAddress ?? null, port: req.socket?.localPort ?? null },
      };
    });

    fastify.put(`${prefix}/settings`, async (req) => {
      const body = req.body ?? {};
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
      return { ok: true, restartRequired: next.listenOnNetwork !== cfg.listenOnNetwork };
    });

    /** The libraries already in a folder (to join one instead of starting a second). */
    fastify.post(`${prefix}/folder/libraries`, async (req) => {
      const folder = req.body?.folder || readSettings().folder;
      if (!folder) throw errors.badRequest("no folder given");
      return { libraries: await folderSync(need(), platform.folder(String(folder))).libraries() };
    });

    fastify.post(`${prefix}/folder/run`, async () => {
      const r = await runFolder();
      if (!r) throw errors.badRequest("no sync folder is set");
      return r;
    });

    fastify.post(`${prefix}/run`, async () => ({ folder: await runFolder(), peers: await runPeers() }));

    /** A file of some units (books, projects…), carried by hand to another device (import merges). */
    fastify.post(`${prefix}/export`, async (req, reply) => {
      const ids = Array.isArray(req.body?.projectIds) ? req.body.projectIds.map(String) : [];
      if (!ids.length) throw errors.badRequest("pick at least one");
      const batch = need().changesSince({}, { scope: units.scope(ids) });
      const bytes = await encodeFile(batch, req.body?.encrypt ? { key: libraryKey() } : {});
      writeSettings({ ...readSettings(), lastExport: new Date().toISOString() });
      const base = String(units.name(ids) || appName).replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || appName;
      const d = new Date(); // today on this computer's calendar, not UTC's
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const name = `${base}${ids.length > 1 ? ` +${ids.length - 1}` : ""} ${day}.${units.extension}`;
      reply.header("content-disposition", `attachment; filename="${encodeURIComponent(name)}"`);
      return reply.type("application/octet-stream").send(Buffer.from(bytes));
    });

    /** Import a carried file: merges. `?join=1` adopts the file's library (a device's first sync). */
    fastify.post(`${prefix}/import`, async (req) => {
      const bytes = req.body instanceof Uint8Array ? req.body : null;
      if (!bytes) throw errors.badRequest("send the file as application/octet-stream");
      let header;
      try {
        header = readFileHeader(bytes);
      } catch (e) {
        failure(e);
      }
      const s = need();
      const join = String(req.query?.join ?? "") === "1";
      if (header.library !== s.library && !join) {
        throw errors.refused(
          new SyncError("library-mismatch", `This file is from another library${header.fromName ? ` (${header.fromName})` : ""}. Join it to merge its ${units.noun ?? "contents"} into this one.`, { fromName: header.fromName ?? null }),
        );
      }
      try {
        const batch = await decodeFile(bytes, header.enc ? { key: readSettings().key ?? undefined } : {});
        const r = s.apply(batch, { join });
        s.recordPeer(header.from, { name: header.fromName ?? null, kind: "file" });
        return { applied: r.applied, rows: r.rows, problems: r.problems, from: header.fromName ?? header.from };
      } catch (e) {
        failure(e);
      }
    });

    /** Sync now with a device or server over HTTP (and remember it). */
    fastify.post(`${prefix}/peer/run`, async (req) => {
      const { url, token, join } = req.body ?? {};
      if (!url) throw errors.badRequest("give the other device's address");
      try {
        const r = await syncWithPeer(need(), { url: String(url), token: token ? String(token) : undefined, join: !!join });
        const cfg = readSettings();
        const peers = (cfg.peers ?? []).filter((p) => p.url !== url);
        writeSettings({ ...cfg, peers: [...peers, { url: String(url), token: token ? String(token) : null, name: r.peer.name ?? null }] });
        return { peer: r.peer, pulled: r.pulled.applied, sent: r.pushed.sent };
      } catch (e) {
        failure(e);
      }
    });

    /**
     * Pair a device: a code (shown as a QR) with this library, its key, a new token for the other
     * device, and this server's addresses. Turning pairing on also turns on listening on the
     * network (applies on the next start).
     */
    fastify.post(`${prefix}/pair`, async (req) => {
      const s = need();
      const token = randomBytes(24).toString("base64url");
      auth.add(token);
      const cfg = readSettings();
      const wasListening = cfg.listenOnNetwork;
      writeSettings({ ...cfg, listenOnNetwork: true });
      const port = req.socket?.localPort;
      return {
        code: { v: 1, app, library: s.library, key: libraryKey(), token, name: s.deviceName, urls: port ? reachableUrls(port, prefix) : [] },
        restartRequired: !wasListening,
      };
    });

    /**
     * The other side of pairing: join with a code from another device. The code is the authority:
     * this device adopts its library and key at once, so a shared cloud folder carries changes
     * even when the other device can't be reached; then it syncs with the first address that
     * answers and remembers it.
     */
    fastify.post(`${prefix}/pair/join`, async (req) => {
      let code;
      try {
        code = typeof req.body?.code === "string" ? JSON.parse(req.body.code) : req.body?.code;
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
          return { joined: true, url, peer: r.peer, pulled: r.pulled.applied, sent: r.pushed.sent };
        } catch (e) {
          log.warning(`pairing: ${url} didn't answer: ${e?.message ?? e}`);
        }
      }
      // Joined, but no address answered (the other device is off or on another network): the
      // folder, or a later "Sync now", carries the changes.
      return { joined: true, url: null, peer: { name: code.name ?? null }, pulled: 0, sent: 0 };
    });
  }

  return { open, get, flush, reset, stop, networkHost, readSettings, routes, runFolder, runPeers };
}
