<!-- SPDX-License-Identifier: MIT -->
# just-sqlite-sync — the design

Why it's built this way, what was rejected, and its limits. The guide is the README; the file
format is `file-format.md`. The decisions that led here are recorded verbatim in JustWrite's TASKS
("Sync — offline first, by file, folder and server"); the research is the kit's
`docs/plans/2026-10-08-sync-research-*.md` and its RESEARCH §2 "Sync".

## 1 · The job

One owner, many devices, offline first. Every device holds the whole database and works with no
network. Changes move when devices meet — by a file carried by hand, through a shared cloud
folder, or over HTTP with another device or a server. The engine must work on an app's **existing**
relational schema (composite keys, foreign keys with cascades, NOT NULL columns), on Node and in a
phone's webview, under a permissive licence. Not in scope until wanted (and not blocked by the
design): many users, permissions, partial replication, other languages.

## 2 · Why our own engine

Checked 2026-10-08 (records in the kit): no open-source tool syncs an app's own SQLite tables by
file, folder and server on Node and in a webview. **cr-sqlite** was tested on JustWrite's real
database: it refuses tables with checked foreign keys and NOT NULL columns without defaults, its
last release is from 2024-01, Fly.io's active fork is server-bound and ships no WASM build.
**PowerSync** syncs through its own service with Postgres/MongoDB/MySQL/SQL Server as the central
copy (no file or folder route, no device to device). **Turso Sync** syncs only with its sync server
(pre-1.0). **sqlite-sync** (sqliteai) needs a paid licence for production. Databases other than
SQLite would mean rewriting the schema, every query and the data layer. Open-source apps that
sync phone and desktop (Actual Budget, Joplin, Anytype, Trilium…) build their own on standard
parts; Actual Budget's design — per-cell changes stamped with a hybrid clock on its own SQLite
tables — is this engine's model.

## 3 · The pieces

### 3.1 Tables the engine owns

`sync_meta` (library id, device id and name, this device's sequence, the trigger hash, transport
state) · `sync_clock` (per synced field: newest stamp, origin device, origin sequence; per row:
`col = '-'`, alive 1 / deleted 0) · `sync_vector` (per other device, the highest sequence held) ·
`sync_text` (per rich-text field: its Yjs state and the stamp it was brought up to) · `sync_peers`
(devices and places synced with).

### 3.2 Recording: triggers, history-free

`AFTER INSERT / UPDATE / DELETE` triggers, generated from the table list, upsert one `sync_clock`
row per changed field (the update trigger compares `OLD.c IS NOT NEW.c`). A key change is a delete
plus an insert. Stamps and sequences come from SQL functions registered in JavaScript; the
triggers keep the sequence in `sync_meta`. Only the newest change per field is kept and the value
is the row itself, so the cost doesn't grow with history (a full log cost 10× the write time in a
test; this design about 2.5×, like cr-sqlite's). Two SQLite facts the triggers respect:
- **UPSERT, never INSERT OR REPLACE, inside a trigger:** the conflict clause of the statement that
  fired the trigger (an app's `INSERT OR IGNORE`) overrides the trigger's own — an `OR REPLACE`
  would silently keep a stale stamp. Found by the convergence test; UPSERT isn't overridden.
- **Cascades fire triggers:** an `ON DELETE CASCADE` deletes the children through their own delete
  triggers, so a deleted book records every row it took.

### 3.3 The clock

`<ms base 36, 9>-<counter base 36, 4>-<device id>` — sortable as a string, unique per device. A
received stamp moves the local clock past it (an edit made after seeing a change is newer than
it). A stamp more than a day ahead of local time is refused (`clock-drift`): one device with a
wrong date must not win every field forever.

### 3.4 Merging

Per field, the newer stamp wins. A delete marker newer than the row's insert removes it; field
edits older than a delete are ignored; an insert newer than the delete brings the row back. A
batch applies in one transaction with `defer_foreign_keys`, so its order doesn't matter and a
failure changes nothing. **Foreign keys:** applying a parent's delete cascades here too; children
only this device had are deleted with a recorded delete (other devices drop them as well); a child
whose parent is gone after a batch (added on one device while the parent was deleted on another) is
deleted — or nulled, for `ON DELETE SET NULL` — and recorded. The parent's delete wins, as the
cascade would have decided.

### 3.5 Rich text

A text column keeps the app's own value; beside it the engine keeps a Yjs document. Before
changes are read or applied, each text field whose stamp moved is reconciled: the app's adapter
changes the Yjs document to the column's value by the smallest difference. The change that travels
is the Yjs state; receiving merges it and renders the column. Rules that keep it convergent:
- the field's clock always names a version holding what this device has: when the merged result
  equals what the sender had, the clock takes the sender's change (even if its stamp is older);
  when both sides contributed, the merge is a new change of this device;
- a document's first state is made under a client id derived from its content, so two devices
  that hold the same initial text (a bundled sample, a copied database) produce identical states
  that merge to one;
- later edits use a client id derived from the device id.
`plainTextAdapter()` diffs characters with Myers' algorithm (beyond 2,000 changed characters it
replaces the changed middle whole — still correct, only coarser). An HTML editor brings its own
adapter (for ProseMirror/TipTap: y-prosemirror's `updateYFragment` against the editor's schema).

### 3.6 What each device has: vectors

Each change carries (origin, sequence). A batch made for a peer holds every change whose sequence
is above the peer's vector for its origin; applying a complete batch lets the receiver take the
sender's vector. History-free storage means an older change of a field may be gone — it was
superseded by a newer change the batch does carry (cr-sqlite's rule). A scoped batch (some books)
is *partial*: it merges but advances no vector.

## 4 · Transports

- **The file** (`file-format.md`): gzip of JSON, optionally AES-256-GCM with the library key; the
  header stays readable (app, library, sender) and is authenticated with the body.
- **The folder:** `<library>/<device>/c-<n>.sqs` — a device's n-th file holds everything it held
  that its earlier files didn't (its own changes and those it got by other routes, so the folder
  relays them); `s-<n>.sqs` snapshots every `snapshotEvery` files, with the older change files
  deleted; a reader that fell behind restarts from a snapshot. No file is written by two devices
  (a single shared file makes the cloud service write conflict copies).
- **HTTP:** `hello`, `pull` (my vector → your changes), `push` (my changes). The server's own
  authentication protects them. Same code against a laptop, a phone or a rented server.

## 5 · Limits (known, accepted)

- Primary-key values must be unique across devices (random ids); text or integer columns.
- Two devices reordering one list at once can leave equal `position` values (each row's position
  is its own field); the app orders by position then id.
- Two devices that held **different** text for the same row before they first synced merge both
  texts (Yjs keeps both insertions).
- A device whose clock is more than a day wrong can't sync until it's fixed (by design).
- Large edits beyond the plain-text diff's limit merge coarsely.

## 6 · Tests

`tests/` — the engine's rules one by one; the **convergence** test (three devices, random edits,
deletes, cascades, re-inserts, key changes and text edits on a small shared id space, random sync
order; every seeded run must end identical with clean foreign keys and nothing left to send; 300
runs in the suite, 3,500 more run once while building); text diffs; change files (round trip,
encryption, tampering); folders (relay, compaction, a reader behind a snapshot); HTTP (pairing,
tokens); and the same engine on the official SQLite WASM build syncing with better-sqlite3.
