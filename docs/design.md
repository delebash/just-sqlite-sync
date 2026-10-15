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
state, a restore's mark and time, the ids this device had before its restores — §3.7) · `sync_clock` (per synced field: newest stamp, origin device, origin sequence; per row:
`col = '-'`, alive 1 / deleted 0) · `sync_vector` (per other device, the highest sequence held) ·
`sync_text` (per rich-text field: its Yjs state and the stamp it was brought up to) · `sync_peers`
(devices and places synced with).

### 3.2 Recording: pure-SQL triggers, stamped by flush, history-free

`AFTER INSERT / UPDATE / DELETE` triggers, generated from the table list, note each changed field
in `sync_pending` (one row per field, however often it changes; the update trigger compares
`OLD.c IS NOT NEW.c`; a key change is a delete plus an insert; a delete drops the row's field
stamps at once). **The triggers are pure SQL** — no function registered from JavaScript — so a
write from *any* connection is noted: the app's, the kit's restore (which opens its own
connection and rewrites the tables), a migration script, a database browser. A first version
called JavaScript functions from the triggers; any other connection then failed with "no such
function". `flush()` stamps the pending fields — each gets the next clock stamp and this device's
next sequence — and runs before changes are read or applied; an app calls it after its saves so
stamps follow the order edits were made in. While the engine applies another device's changes it
sets `sync_flag.applying` inside its transaction, and the triggers stay quiet. Only the newest
change per field is kept and the value is the row itself, so the cost doesn't grow with history (a
full log cost 10× the write time in a test; this design is cr-sqlite's shape, about 2.5×). Triggers
are rebuilt when a table's shape changes and when they're missing (dropping and re-creating a
table drops its triggers — a data reset does that). Two SQLite facts the triggers respect:
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
cascade would have decided. A child the cascade takes is left unrecorded only when the same batch
deletes it too *and that delete wins here*: a batch can carry an older delete of a child this
device has since brought back (the newer insert wins over it), and the parent's newer delete then
takes the row — recorded as this device's delete, or the row would be gone while its mark said
alive, and come back wherever an older copy of it lives (a restored backup). Found by a longer
random run, 2026-10-15 (`tests/engine.test.js`; seeds 128, 677, 1128, 1553 at 120 steps).

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
- later edits use a client id derived from the device id and the row's insert mark (its `-`
  stamp; for a row with none, the oldest stamp). A row deleted and made again is a new document,
  where a client's edits start again from clock 0: under one id for every life of the row they
  would take the ids of its edits to the old life, and a device still holding that life — it never
  applied the delete because the new insert won, or a restored backup brought it back — would
  skip them as already known. Each life gets its own ids (2026-10-15; `tests/engine.test.js`,
  restore stress seed 1236). Edits made by an engine from before this keep their ids (one per
  device): a client id is only ever new, never reused, so old and new ids merge without losing or
  doubling an edit (the mixed-version test runs the engine as of 35dc1d7 against this one).
`plainTextAdapter()` diffs characters with Myers' algorithm (beyond 2,000 changed characters it
replaces the changed middle whole — still correct, only coarser). An HTML editor brings its own
adapter (for ProseMirror/TipTap: y-prosemirror's `updateYFragment` against the editor's schema).

### 3.6 What each device has: vectors

Each change carries (origin, sequence). A batch made for a peer holds every change whose sequence
is above the peer's vector for its origin; applying a complete batch lets the receiver take the
sender's vector. History-free storage means an older change of a field may be gone — it was
superseded by a newer change the batch does carry (cr-sqlite's rule). A scoped batch (some books)
is *partial*: it merges but advances no vector.

A batch sent over HTTP also names `base`, the vector it was made for. It holds every change above
`base`, so it counts on the receiver holding at least `base` of every origin; a receiver that holds
less (it restored a backup while the exchange was under way, §3.7) leaves the whole batch for the
next exchange. Applied, its changes could build on rows the receiver no longer has — a field edit
on a row inserted under another origin, a chapter whose book is gone here, which the orphan rule
(§3.4) would then delete on every device. A file carries no `base`: a folder's files are read in
order, each following the sender's earlier ones.

### 3.7 Restoring a backup

A restore (the kit's data router) copies a backup's tables over the live ones on its own
connection. Left alone, the triggers would note every restored row as a change made now, and the
next sync would send the backup's old rows everywhere as the newest edits — overwriting the work
done since and deleting what was made since (JustVoice's narrowings review, P16).

**A restored device continues as a new device** (decided 2026-10-15) — the engine's own rule for a
copied database (§3.1 `sync_meta`; `openSync` under another `deviceId`). The restore runs two steps
inside its transaction around the copy (`src/restore.js`): before it, the triggers go quiet; after
it, the backup's `sync_clock`, `sync_text`, `sync_vector` and `sync_pending` replace the live ones,
the backup's own device's entry joins the vector (a device keeps its own sequence in `sync_meta`),
and `sync_meta.restore` marks the database restored. `sync_meta` otherwise stays this database's:
its library, device id and name. The next `openSync` must name a new device id (or none, when the
engine keeps the id in the database; the old one is refused). In one transaction the old id
retires at what the backup held of it — an origin like any other — and the transports' progress
(`state:*`) goes, so the new id writes its own folder files from the first and reads every other
device's again, the old id's too. Then the changes the backup had noted but not stamped are
stamped just after its newest stamp, and rows it held with no stamps at all (a backup from before
sync) get the oldest stamp there is, both under the new id; the mark goes.

So everything the backup holds keeps its age, and the other devices' newer work — and what this
device itself made after the backup and had synced — comes back and wins by its newer stamps.
What this device changed after the backup and never synced is gone, as it would be without sync.
Nothing is ever numbered twice: the old id stops, and the new one starts at 1. A rich-text edit
made right after the restore is a new Yjs client's (the client id follows the device id), never a
reuse of the old one's ids.

**Why not keep the old id with a "floor"** (the first design: the device's vector says it holds
only its own changes the backup held, until an exchange brings the rest back): a stress run
(three devices, random edits, backups and restores, 300 runs) ended permanently different in 6 —
an exchange under way during the restore, a backup taken while a floor was on, Yjs ids reused, a
reset then a restore, the step never running — and with endless re-sending in ~26. The new
identity passed the same 300.

The costs: one more origin in every vector per restore; the devices list shows the restored device
as a new entry beside the old one; its old folder subfolder stays until removed.

**The old id in this device's own list** (decided 2026-10-15, JustVoice's TASKS, "The build's 16
questions", answer 5): the restored device reads its old id's folder subfolder like any other
device's — that is how its newer work comes back — so the old id becomes an entry in its own
devices list, under its own name. The restore marks the database with its time
(`sync_meta.restore_at`, `src/restore.js`); when the old id retires, `sync_meta.retired` records
it with the name the device had and that time (a list: one entry per restore), and `peers()`
marks its entry `retired: { name, at }`. The kit's sync screen names it "‹name› (before the
restore on ‹date›)". No Remove: the restored device reads that folder copy to get its newer work
back, and a device still offline may not have read it yet. A device that never restored records
nothing and its list is unchanged.

The app layer (`src/app.js`) adds the rest: `restoreHooks` are the kit's `beforeCopy`, `afterCopy`
and `afterTables`. Before the copy, while this device syncs (a cloud folder or a paired device is
set), a backup from another sync library is refused (409, `restore-other-library`; decided
2026-10-15) — every fresh database starts its own library, so a device that isn't syncing takes
any backup, and stays in its own library. This device's `sync` settings (the library key, the
paired devices, the folder, the name) are read before the copy and written back after it: the
backup's are older, or another computer's. So are its bearer tokens, the ones its paired devices
use to reach it, when the app gives `auth.set`. After the copy, sync reopens under a new id
(`newIdentity`, `sync-device.json`); a sync run still holding the engine from before stops with
`reopened` instead of writing as the old device. If the server stops between the copy and that
step, the mark makes the next start take the new id.

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
- A restored device is a new device (§3.7): the other devices' lists show it as a new entry beside
  the old one, both under its name; in its own list the old one says it was this device before the
  restore. Its old folder subfolder stays until removed.

## 6 · Tests

`tests/` — the engine's rules one by one; the **convergence** test (three devices, random edits,
deletes, cascades, re-inserts, key changes and text edits on a small shared id space, random sync
order; every seeded run must end identical with clean foreign keys and nothing left to send; 300
runs in the suite, 3,500 more run once while building); the **restore** stress run (the same random
devices on database files, with backups taken and restored at random — 300 runs; and 300 more with
batches made before a restore applied after it and backups holding unstamped edits — each must
end identical with nothing left to send); text diffs; change files (round trip,
encryption, tampering); folders (relay, compaction, a reader behind a snapshot); HTTP (pairing,
tokens); and the same engine on the official SQLite WASM build syncing with better-sqlite3.
