// SPDX-License-Identifier: MIT
// The engine's own tables, and the triggers that record each change to a synced table.
//
// sync_meta    key → value: library, device, device_name, seq (this device's change counter),
//              triggers (a hash of the trigger SQL, to rebuild them when a schema changes)
// sync_clock   one row per synced field: its newest stamp and where that change came from
//              (origin device, origin sequence). col '-' is the row itself: alive 1, deleted 0.
//              History-free: an older change to the same field is replaced, never kept.
// sync_vector  per other device, the highest sequence of its changes this device holds
// sync_text    per rich-text field, its Yjs state and the clock stamp it was last brought up to
// sync_peers   devices and places this one has synced with (for the app's "devices" list)

export const ENGINE_SQL = `
CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_clock (
  tbl TEXT NOT NULL, pk TEXT NOT NULL, col TEXT NOT NULL,
  stamp TEXT NOT NULL, origin TEXT NOT NULL, oseq INTEGER NOT NULL, alive INTEGER,
  PRIMARY KEY (tbl, pk, col)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sync_clock_by_origin ON sync_clock (origin, oseq);
CREATE TABLE IF NOT EXISTS sync_vector (origin TEXT PRIMARY KEY, seq INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_text (
  tbl TEXT NOT NULL, pk TEXT NOT NULL, col TEXT NOT NULL, state BLOB NOT NULL, stamp TEXT NOT NULL,
  PRIMARY KEY (tbl, pk, col)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_peers (
  id TEXT PRIMARY KEY, name TEXT, kind TEXT, last_sync TEXT, info TEXT
) WITHOUT ROWID;
`;

export const TRIGGER_PREFIX = "sync__";

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function quoteLit(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

function pkExpr(prefix, pk) {
  return `json_array(${pk.map((c) => `${prefix}.${quoteIdent(c)}`).join(", ")})`;
}

const CLOCK_COLS = "(tbl, pk, col, stamp, origin, oseq, alive)";
const NOW = "sync_stamp(), sync_device(), sync_seq()";
// UPSERT, never INSERT OR REPLACE: SQLite lets the conflict clause of the statement that fired a
// trigger (an app's INSERT OR IGNORE) override the trigger's own — an OR REPLACE inside would
// silently become OR IGNORE and keep a stale stamp. An UPSERT isn't overridden (tested).
const UPSERT = "ON CONFLICT (tbl, pk, col) DO UPDATE SET stamp = excluded.stamp, origin = excluded.origin, oseq = excluded.oseq, alive = excluded.alive";

/**
 * The triggers for one table.
 * @param {string} table
 * @param {{ pk: string[], data: string[], text: string[] }} t
 */
export function triggerSql(table, { pk, data }) {
  const T = quoteIdent(table);
  const L = quoteLit(table);
  const name = (suffix) => quoteIdent(`${TRIGGER_PREFIX}${table}__${suffix}`);
  const markAlive = (row) => `INSERT INTO sync_clock ${CLOCK_COLS} VALUES (${L}, ${pkExpr(row, pk)}, '-', ${NOW}, 1) ${UPSERT};`;
  const allFields = (row) =>
    data.map((c) => `INSERT INTO sync_clock ${CLOCK_COLS} VALUES (${L}, ${pkExpr(row, pk)}, ${quoteLit(c)}, ${NOW}, NULL) ${UPSERT};`).join("\n  ");
  const changedFields = data
    .map(
      (c) =>
        `INSERT INTO sync_clock ${CLOCK_COLS} SELECT ${L}, ${pkExpr("NEW", pk)}, ${quoteLit(c)}, ${NOW}, NULL WHERE OLD.${quoteIdent(c)} IS NOT NEW.${quoteIdent(c)} ${UPSERT};`,
    )
    .join("\n  ");
  const markDeleted = (row) => `INSERT INTO sync_clock ${CLOCK_COLS} VALUES (${L}, ${pkExpr(row, pk)}, '-', ${NOW}, 0) ${UPSERT};
  DELETE FROM sync_clock WHERE tbl = ${L} AND pk = ${pkExpr(row, pk)} AND col <> '-';
  DELETE FROM sync_text WHERE tbl = ${L} AND pk = ${pkExpr(row, pk)};`;
  const saveSeq = "UPDATE sync_meta SET value = sync_seq() WHERE key = 'seq';";
  const samePk = `${pkExpr("OLD", pk)} = ${pkExpr("NEW", pk)}`;
  return `
CREATE TRIGGER ${name("insert")} AFTER INSERT ON ${T} WHEN sync_on() BEGIN
  SELECT sync_begin();
  ${markAlive("NEW")}
  ${allFields("NEW")}
  ${saveSeq}
END;
CREATE TRIGGER ${name("update")} AFTER UPDATE ON ${T} WHEN sync_on() AND ${samePk} BEGIN
  SELECT sync_begin();
  ${changedFields}
  ${saveSeq}
END;
CREATE TRIGGER ${name("rekey")} AFTER UPDATE ON ${T} WHEN sync_on() AND NOT (${samePk}) BEGIN
  SELECT sync_begin();
  ${markDeleted("OLD")}
  ${markAlive("NEW")}
  ${allFields("NEW")}
  ${saveSeq}
END;
CREATE TRIGGER ${name("delete")} AFTER DELETE ON ${T} WHEN sync_on() BEGIN
  SELECT sync_begin();
  ${markDeleted("OLD")}
  ${saveSeq}
END;
`;
}
