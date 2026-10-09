<!-- SPDX-License-Identifier: MIT -->
# just-sqlite-sync

Sync for SQLite databases that belong to **one person and live on many devices** — a desktop, a
laptop, a phone, a tablet. Every device keeps the whole database and works with no network; when
two devices meet, they swap the changes the other one lacks. Changes travel three ways:

- **a file carried by hand** — export, send it any way you like, import (it merges);
- **a shared folder** — a Dropbox or OneDrive folder, each device writing only its own files;
- **HTTP** — another device or a server (the same Wi-Fi, a Tailscale/ZeroTier address, a rented
  machine).

Plain JavaScript (ES modules), no native code of its own. It runs on Node over
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3) and in a browser or phone webview over
the [official SQLite WASM build](https://sqlite.org/wasm) (its `opfs-sahpool` storage keeps the
file inside the app). MIT. Package name `@delebash/sqlite-sync` — an internal library of the
JustWrite/JustVoice family, consumed as `"@delebash/sqlite-sync": "file:../just-sqlite-sync"`.

## How it works

1. **Recording.** Plain-SQL triggers on each synced table note every changed field — from any
   connection, so a restore or a script is caught too — and `sync.flush()` gives each a **stamp**
   from a hybrid logical clock (wall time + a counter + the device's id — sortable, never equal
   between devices). Only the newest stamp per field is kept: storage doesn't grow with history.
   Call `flush()` after your saves (it also runs before every sync).
2. **Merging.** For each field, **the newer stamp wins**. A **delete** beats older edits; a newer
   insert brings the row back. A **rich-text column** (a scene, a note) merges edit by edit
   through [Yjs](https://yjs.dev), so a paragraph added on the phone and a typo fixed on the desktop
   both survive. A row whose parent another device deleted goes too, as the foreign key's cascade
   would have done — and that's recorded, so every device ends the same.
3. **What each device has.** Every change keeps its origin (device, sequence). A device's
   **vector** says, per origin, the highest sequence it holds; "what do you lack" is a comparison of
   vectors, so nothing is sent back where it came from, and a device relays what it got from others.

The promise, tested: whatever devices do and in whatever order they sync, they end identical
(`tests/convergence.test.js` — thousands of seeded random runs with edits, deletes, cascades,
re-inserts, key changes and text edits on three devices; `tests/wasm.test.js` — a better-sqlite3
desktop and a SQLite WASM phone).

The reasoning, the alternatives rejected and the limits: [`docs/design.md`](docs/design.md). The
change file byte by byte: [`docs/file-format.md`](docs/file-format.md).

## Quick start (Node)

```js
import Database from "better-sqlite3";
import { betterSqlite3Adapter, openSync, plainTextAdapter, syncWithPeer, folderSync, encodeFile, decodeFile } from "@delebash/sqlite-sync";
import { nodeFolder } from "@delebash/sqlite-sync/node-folder";

const db = new Database("library.db");
db.pragma("foreign_keys = ON");
const sync = openSync(betterSqlite3Adapter(db), {
  app: "myapp",                    // batches from another app are refused
  schemaVersion: 3,                // batches from a newer schema are refused ("update the app")
  deviceId: storedOutsideTheDb,    // optional: a copied database file then becomes a new device
  deviceName: "Dan's laptop",
  tables: {
    projects: {},
    chapters: {},
    scenes: { text: { body: plainTextAdapter() } }, // body merges edit by edit
    images: { exclude: ["thumbnail"] },             // a column kept per device
  },
  // yjs: Y,                      // pass your own Yjs when a text adapter uses y-prosemirror/y-tiptap
});

// 1 · over HTTP with another device or a server
await syncWithPeer(sync, { url: "http://192.168.1.20:17495/v1/sync", token, join: firstTime });

// 2 · through a shared folder (each device reads the others' files, writes its own)
const key = libraryKey; // generateLibraryKey() once, then shared with each device (a QR code)
await folderSync(sync, nodeFolder("C:/Users/dan/Dropbox/Apps/MyApp"), { key }).sync();

// 3 · by hand: a file of some books, merged wherever it's imported
const bytes = await encodeFile(sync.changesSince({}, { scope: (table, pk) => pickedBooks.has(pk[0]) }), { key });
sync.apply(await decodeFile(bytes, { key }));
```

The server side of HTTP sync is three routes; on Fastify:

```js
import { registerSyncRoutes } from "@delebash/sqlite-sync/fastify";
registerSyncRoutes(app, () => sync, { prefix: "/v1/sync" }); // your auth hook protects the prefix
```

In a webview, open the database with the WASM build (usually in a worker) and use
`sqliteWasmAdapter(db)` in place of `betterSqlite3Adapter(db)`; everything else is the same.

### On a phone

```js
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { dropboxAppFolder, folderSync, oneDriveAppFolder, openSync, sqliteWasmAdapter } from "@delebash/sqlite-sync";

const sqlite3 = await sqlite3InitModule();                       // in a worker
const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "myapp" });
const db = new pool.OpfsSAHPoolDb("/library.db");
const sync = openSync(sqliteWasmAdapter(db), { app: "myapp", tables, deviceId });

// the cloud folder, through the service's own API (the phone has no synced folder on disk):
// the app folder is Apps/<your app> — the same folder the desktop sees inside its Dropbox/OneDrive
const cloud = oneDriveAppFolder({ getToken: () => currentAccessToken() }); // or dropboxAppFolder(...)
await folderSync(sync, cloud, { key }).sync();

// the storage guard: webview storage is best-effort (Android's WebView always refuses
// persist()), so also write this device's files to the app's native data folder…
await folderSync(sync, nativeFolderStore, { key }).push();          // after saves
// …and if the database is ever found empty, rebuild it from them:
await folderSync(sync, nativeFolderStore, { key }).restore();
```

Signing in to OneDrive (Microsoft Graph, scope `Files.ReadWrite.AppFolder`) or Dropbox ("App
folder" access) is the app's job — in the system browser with PKCE; the stores only need a current
access token. A store is any `{ list, read, write, remove }` object, so other services fit the same
way.

## The API

| | |
|---|---|
| `openSync(adapter, options)` | Opens sync on a database: creates its tables (`sync_*`), the triggers, and adopts rows that existed before. Returns the `sync` object. |
| `sync.changesSince(vector, { scope })` | The changes a device holding `vector` lacks, as a batch. `{}` = everything. `scope(table, pkValues)` keeps only some rows (a by-hand export); such a batch is *partial* and advances nobody's vector. |
| `sync.apply(batch, { join })` | Applies a batch in one transaction. Refuses another app, another library (unless `join` — pairing a new device), a newer schema, and stamps more than a day in the future (a device with a wrong clock). Returns `{ applied, skipped, rows, tables, problems }`. |
| `sync.flush()` | Stamps the changes the triggers noted since the last flush. Call it after your saves (an `onResponse` hook on write routes is one place); it also runs before every read or apply. |
| `sync.vector()` | This device's vector. |
| `sync.library` / `sync.device` / `sync.deviceName` | Identity. `setDeviceName(name)`, `joinLibrary(id)`. |
| `sync.peers()` | The devices and places this one has synced with, newest first. |
| `syncWithPeer(sync, { url, token, join })` | Pull then push with another device's routes. |
| `createSyncHandlers(sync)` | The three routes' bodies for any web framework (`hello`, `pull`, `push`). |
| `folderSync(sync, store, { key, snapshotEvery })` | `.sync()`, `.pull()`, `.push()`, `.restore()` (rebuild this device from its own files), `.libraries()` (for "join the library in this folder"), `.removeDevice(id)`. `store` is `{ list, read, write, remove }`: `nodeFolder(dir)` on disk, `oneDriveAppFolder({ getToken })`, `dropboxAppFolder({ getToken })`. |
| `encodeFile(batch, { key })` / `decodeFile(bytes, { key })` / `readFileHeader(bytes)` | The change file; with `key`, AES-256-GCM. `generateLibraryKey()` makes a key. |
| `plainTextAdapter()` | Rich-text merging for a plain-text column. Other kinds (HTML from an editor) bring their own adapter: `{ apply(ydoc, value), render(ydoc) }`. |

Errors are `SyncError` with a `code`: `library-mismatch`, `schema-too-new`, `clock-drift`,
`bad-file`, `wrong-key`, `bad-config`, `peer`.

### In an app's server — `@delebash/sqlite-sync/app` (Node, Fastify)

Everything an app server needs around the engine, so each app writes only what is its own:

```js
import { createAppSync } from "@delebash/sqlite-sync/app";

const appSync = createAppSync({
  app: "myapp", appName: "My App", schemaVersion: 1,
  tables: () => ({ projects: {}, chapters: {} }),          // what syncs (openSync `tables`)
  database: () => betterSqlite3Adapter(db),
  settings: { read, write },        // where the app keeps the `sync` section (an object)
  auth: { tokens, add },            // the app's bearer tokens — pairing adds one per device
  units: { scope, name, extension: "mysync", noun: "projects" }, // what a by-hand file holds
  errors,                           // optional: how a 400 / 409 / 503 reaches the app's client
});
appSync.open(dataDir);              // after the database is ready; reset(dataDir) after a wipe
app.register(appSync.routes);       // /v1/sync/…
app.addHook("onResponse", () => appSync.flush());
const host = appSync.networkHost() ?? "127.0.0.1"; // the network only when paired devices may connect
```

It keeps this device's identity (`sync-device.json` in the data folder, tied to the machine), the
`sync` settings (device name, the cloud folder, how often to sync, listening on the network, the
library key, the paired devices, the last export), a sync shortly after start and then every few
minutes with the folder and the paired devices, and the routes a sync screen calls:
`hello`/`pull`/`push` (the engine's), `rev` (moves when another device's changes land — an open
window polls it and reloads), `status`, `settings`, `folder/libraries`, `folder/run`, `run`,
`export`, `import` (`?join=1` adopts the file's library), `peer/run`, `pair` (a code with the
library, its key, a new token and this server's addresses — shown as a QR code) and `pair/join`
(adopts the code's library and key even when the other device can't be reached, so a shared
folder still carries the changes). JustWrite and JustVoice use it.

## Rules for a synced table

- **A primary key, and ids unique across devices.** Use random ids (UUIDs or similar), never
  `AUTOINCREMENT` — two devices would both make row 7. Primary-key columns hold text or integers.
- **Foreign keys work as they are** — including `ON DELETE CASCADE` and `NOT NULL` columns
  without defaults (unlike cr-sqlite, which refuses both).
- **Per-device columns** go in `exclude`. Tables that shouldn't sync (settings, caches, search
  indexes) simply aren't listed.
- **Schema changes:** reopen with the new `schemaVersion` after migrating; the triggers rebuild
  themselves when a table's shape changes. Devices on an older schema refuse the newer one's
  batches until updated.

## Develop

```bash
npm install
npm test          # vitest: engine, convergence, text, files, folders, cloud stores, HTTP, SQLite WASM
npm run lint      # Biome
```

**On a real phone engine:** `tests/phone/` is a Capacitor app whose worker runs the engine on SQLite
WASM over OPFS, syncs a persistent device with a fresh one, and times autosaves; it's launched
fresh, relaunched, and reinstalled over itself (an app update), and each launch must find the
earlier ones. `cd tests/phone && npm install && node run-android.js` runs it on an Android emulator
or phone over adb; `.github/workflows/phone-ios.yml` runs it on GitHub's iOS simulator.

Every file carries an SPDX header. Open work: [`docs/dev/TASKS.md`](docs/dev/TASKS.md); facts with
their proof: [`docs/dev/RESEARCH.md`](docs/dev/RESEARCH.md).
