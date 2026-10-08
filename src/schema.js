// SPDX-License-Identifier: MIT
// The engine's own tables, and the triggers that note each change to a synced table.
//
// sync_meta     key → value: library, device, device_name, seq (this device's change counter),
//               triggers (a hash of the trigger SQL, to rebuild them when a schema changes)
// sync_clock    one row per synced field: its newest stamp and where that change came from
//               (origin device, origin sequence). col '-' is the row itself: alive 1, deleted 0.
//               History-free: an older change to the same field is replaced, never kept.
// sync_pending  fields changed here and not yet stamped (see below)
// sync_flag     one row: applying = 1 while the engine applies another device's changes
// sync_vector   per other device, the highest sequence of its changes this device holds
// sync_text     per rich-text field, its Yjs state and the clock stamp it was last brought up to
// sync_peers    devices and places this one has synced with (for the app's "devices" list)
//
// The triggers are PURE SQL — no function registered from JavaScript — so a write from any
// connection is noted the same way: the app's, a restore that opens its own connection, a
// migration script, a database browser. They only note which fields changed (sync_pending,
// one row per field however often it changes); the engine stamps them (flush) before it reads or
// applies changes, and an app calls flush() after its saves so stamps follow edit order.

export const ENGINE_SQL = `
CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_clock (
  tbl TEXT NOT NULL, pk TEXT NOT NULL, col TEXT NOT NULL,
  stamp TEXT NOT NULL, origin TEXT NOT NULL, oseq INTEGER NOT NULL, alive INTEGER,
  PRIMARY KEY (tbl, pk, col)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sync_clock_by_origin ON sync_clock (origin, oseq);
CREATE TABLE IF NOT EXISTS sync_pending (
  tbl TEXT NOT NULL, pk TEXT NOT NULL, col TEXT NOT NULL, alive INTEGER,
  PRIMARY KEY (tbl, pk, col)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_flag (id INTEGER PRIMARY KEY CHECK (id = 1), applying INTEGER NOT NULL);
INSERT OR IGNORE INTO sync_flag (id, applying) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS sync_vector (origin TEXT PRIMARY KEY, seq INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_text (
  tbl TEXT NOT NULL, pk TEXT NOT NULL, col TEXT NOT NULL, state BLOB NOT NULL, stamp TEXT NOT NULL,
  PRIMARY KEY (tbl, pk, col)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_peers (
  id TEXT PRIMARY KEY, name TEXT, kind TEXT, last_sync TEXT, info TEXT
) WITHOUT ROWID;
`;

export const ENGINE_TABLES = ["sync_meta", "sync_clock", "sync_pending", "sync_flag", "sync_vector", "sync_text", "sync_peers"];
export const TRIGGER_PREFIX = "sync__";
export const TRIGGERS_PER_TABLE = 4;

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function quoteLit(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

function pkExpr(prefix, pk) {
  return `json_array(${pk.map((c) => `${prefix}.${quoteIdent(c)}`).join(", ")})`;
}

// UPSERT, never INSERT OR REPLACE: SQLite lets the conflict clause of the statement that fired a
// trigger (an app's INSERT OR IGNORE) override the trigger's own — an OR REPLACE inside would
// silently become OR IGNORE. An UPSERT isn't overridden (tested: docs/dev/RESEARCH.md).
const NOTE = "ON CONFLICT (tbl, pk, col) DO UPDATE SET alive = excluded.alive";
const QUIET = "(SELECT applying FROM sync_flag WHERE id = 1) = 0";

/**
 * The triggers for one table.
 * @param {string} table
 * @param {{ pk: string[], data: string[] }} t
 */
export function triggerSql(table, { pk, data }) {
  const T = quoteIdent(table);
  const L = quoteLit(table);
  const name = (suffix) => quoteIdent(`${TRIGGER_PREFIX}${table}__${suffix}`);
  const note = (row, col, alive) => `INSERT INTO sync_pending (tbl, pk, col, alive) VALUES (${L}, ${pkExpr(row, pk)}, ${quoteLit(col)}, ${alive}) ${NOTE};`;
  const inserted = (row) => [note(row, "-", 1), ...data.map((c) => note(row, c, "NULL"))].join("\n  ");
  const changed = data
    .map(
      (c) =>
        `INSERT INTO sync_pending (tbl, pk, col, alive) SELECT ${L}, ${pkExpr("NEW", pk)}, ${quoteLit(c)}, NULL WHERE OLD.${quoteIdent(c)} IS NOT NEW.${quoteIdent(c)} ${NOTE};`,
    )
    .join("\n  ");
  // A delete is noted at once, and the row's field stamps go with it (a later insert of the same
  // key starts fresh); its rich-text state too.
  const deleted = (row) => `${note(row, "-", 0)}
  DELETE FROM sync_pending WHERE tbl = ${L} AND pk = ${pkExpr(row, pk)} AND col <> '-';
  DELETE FROM sync_clock WHERE tbl = ${L} AND pk = ${pkExpr(row, pk)} AND col <> '-';
  DELETE FROM sync_text WHERE tbl = ${L} AND pk = ${pkExpr(row, pk)};`;
  const samePk = `${pkExpr("OLD", pk)} = ${pkExpr("NEW", pk)}`;
  return `
CREATE TRIGGER ${name("insert")} AFTER INSERT ON ${T} WHEN ${QUIET} BEGIN
  ${inserted("NEW")}
END;
CREATE TRIGGER ${name("update")} AFTER UPDATE ON ${T} WHEN ${QUIET} AND ${samePk} BEGIN
  SELECT 1;
  ${changed}
END;
CREATE TRIGGER ${name("rekey")} AFTER UPDATE ON ${T} WHEN ${QUIET} AND NOT (${samePk}) BEGIN
  ${deleted("OLD")}
  ${inserted("NEW")}
END;
CREATE TRIGGER ${name("delete")} AFTER DELETE ON ${T} WHEN ${QUIET} BEGIN
  ${deleted("OLD")}
END;
`;
}
