// SPDX-License-Identifier: MIT
// Restoring a backup over a synced database. A restore (the kit's data router) copies the
// backup's tables over the live ones on its own connection. Left alone, the sync triggers would
// note every restored row as a change made now, and the next sync would send the backup's old
// rows to every other device as the newest edits — overwriting the work done since the backup,
// and deleting there what was made since (JustVoice's narrowings review, P16).
//
// So the restore runs two steps inside its transaction, around its copy: before it, the triggers
// go quiet; after it, the backup's own stamps come with its rows, and the database is marked
// restored. The next `openSync` on it must name a new device id (the app layer makes one): this
// device continues as a new device, and the id it had becomes an origin like any other, holding
// what the backup held of it — the engine's rule for a copied database file (docs/design.md §3.7).
// The other devices' newer work then comes back and wins by its newer stamps.
//
// `h` is the restore's connection: run(sql, params), all(sql, params), exec(sql). The backup is
// attached to it as `src`.

/** What a restore copies of the engine's own tables: the stamps, the rich-text states, what the
 * backup held of each device, and the changes it had noted but not yet stamped. */
const COPIED = ["sync_clock", "sync_text", "sync_vector", "sync_pending"];

function hasTable(h, schema, name) {
  return h.all(`SELECT 1 AS x FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`, [name]).length > 0;
}

function metaOf(h, schema, key) {
  if (!hasTable(h, schema, "sync_meta")) return null;
  return h.all(`SELECT value FROM ${schema}.sync_meta WHERE key = ?`, [key])[0]?.value ?? null;
}

/** The sync library of this database and of the backup (null when either never had sync). */
export function restoreLibraries(h, { src = "src" } = {}) {
  return { live: metaOf(h, "main", "library"), backup: metaOf(h, src, "library") };
}

/** Before the copy: the triggers stay quiet, so the restored rows aren't noted as new changes. */
export function beforeRestoreCopy(h) {
  if (hasTable(h, "main", "sync_flag")) h.run("UPDATE main.sync_flag SET applying = 1 WHERE id = 1");
}

/**
 * After the copy: the backup's stamps, rich-text states, vector and unstamped changes replace this
 * database's (none, for a backup from before sync — its rows are then recorded as older than any
 * change); the backup's own device's entry joins the vector (a device keeps its own sequence in
 * `sync_meta`, not in `sync_vector`); the database is marked restored; the triggers record again.
 * `sync_meta` stays this database's: its library, its device id, its name.
 */
export function afterRestoreCopy(h, { src = "src" } = {}) {
  if (!hasTable(h, "main", "sync_clock")) return; // sync never opened here: nothing to carry
  for (const t of COPIED) h.run(`DELETE FROM main."${t}"`);
  for (const t of COPIED) {
    if (!hasTable(h, src, t)) continue;
    const mainCols = h.all(`PRAGMA main.table_info("${t}")`).map((r) => r.name);
    const srcCols = new Set(h.all(`PRAGMA ${src}.table_info("${t}")`).map((r) => r.name));
    const cols = mainCols.filter((c) => srcCols.has(c)).map((c) => `"${c}"`).join(", ");
    if (cols) h.exec(`INSERT INTO main."${t}" (${cols}) SELECT ${cols} FROM ${src}."${t}"`);
  }
  const device = metaOf(h, src, "device");
  // (a backup taken while its own restore was still marked holds that restore's vector already)
  if (device != null && metaOf(h, src, "restore") !== "copied") {
    h.run("INSERT INTO main.sync_vector (origin, seq) VALUES (?, ?) ON CONFLICT(origin) DO UPDATE SET seq = max(seq, excluded.seq)", [
      device,
      Number(metaOf(h, src, "seq") ?? 0),
    ]);
  }
  h.run("INSERT OR REPLACE INTO main.sync_meta (key, value) VALUES ('restore', 'copied')");
  if (hasTable(h, "main", "sync_flag")) h.run("UPDATE main.sync_flag SET applying = 0 WHERE id = 1");
}

/**
 * True when a restore copied a backup into this database and sync hasn't reopened since: the next
 * `openSync` must name a new device id (or none, when the engine keeps the id in the database).
 * @param {object} db an adapter (betterSqlite3Adapter / sqliteWasmAdapter)
 */
export function restorePending(db) {
  try {
    return db.get("SELECT value FROM sync_meta WHERE key = 'restore'")?.value === "copied";
  } catch {
    return false; // no sync tables yet
  }
}
