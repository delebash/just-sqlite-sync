// SPDX-License-Identifier: MIT
// The sync engine: records every change to the synced tables, hands out the changes another
// device lacks, and applies changes from other devices. The design is
// docs/design.md; the rules in one place:
//   - every synced field carries the stamp of its newest change (src/clock.js)
//   - applying: per field, the newer stamp wins; a delete beats older edits, and a newer insert
//     brings a deleted row back; rich-text columns merge through Yjs (src/text.js)
//   - each change keeps its origin (device, sequence); a device's vector says, per origin, the
//     highest sequence it holds — "what does the other side lack" is a comparison of vectors

import { randomId, hash52, fromBase64, toBase64 } from "./bytes.js";
import { createClock } from "./clock.js";
import { BAD_CONFIG, LIBRARY_MISMATCH, SCHEMA_TOO_NEW, SyncError } from "./errors.js";
import { ENGINE_SQL, TRIGGERS_PER_TABLE, TRIGGER_PREFIX, quoteIdent, triggerSql } from "./schema.js";
import { textOps } from "./text.js";
import { decodeValue, encodeValue } from "./values.js";

export const FORMAT_VERSION = 1;

/**
 * Open sync on a database.
 * @param {object} db an adapter (betterSqlite3Adapter / sqliteWasmAdapter)
 * @param {object} options
 * @param {string} options.app the app's name; batches from another app are refused
 * @param {number} [options.schemaVersion] the app's schema version; newer batches are refused
 * @param {Record<string, { exclude?: string[], text?: Record<string, object> }>} options.tables
 * @param {string} [options.deviceId] this device's id, kept by the app outside the database (a
 *   copied database file then becomes a new device instead of a twin of the old one)
 * @param {string} [options.deviceName]
 * @param {() => number} [options.now]
 * @param {number} [options.maxDriftMs]
 * @param {object} [options.yjs] the Yjs module for rich-text columns — pass the app's own when its
 *   text adapters use another Yjs library (y-prosemirror, y-tiptap), so there's one copy of Yjs
 */
export function openSync(db, options) {
  const { app, schemaVersion = 1, tables, now, maxDriftMs } = options || {};
  if (!app) throw new SyncError(BAD_CONFIG, "openSync needs options.app");
  if (!tables || typeof tables !== "object" || !Object.keys(tables).length) {
    throw new SyncError(BAD_CONFIG, "openSync needs options.tables — the tables to sync");
  }
  db.exec(ENGINE_SQL);

  // --- meta ---------------------------------------------------------------------------------
  const getMeta = (key) => db.get("SELECT value FROM sync_meta WHERE key = ?", [key])?.value;
  const setMeta = (key, value) => db.run("INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)", [key, value]);

  let library = getMeta("library");
  if (!library) {
    library = randomId(12);
    setMeta("library", library);
  }
  let device = getMeta("device");
  if (options.deviceId && options.deviceId !== device) {
    // A database opened under another device id (a copied file, a restored backup): the old id
    // stays an origin like any other device, and this one continues as the new id.
    if (device) {
      db.run("INSERT INTO sync_vector (origin, seq) VALUES (?, ?) ON CONFLICT(origin) DO UPDATE SET seq = max(seq, excluded.seq)", [
        device,
        Number(getMeta("seq") ?? 0),
      ]);
    }
    device = options.deviceId;
    setMeta("device", device);
    // this id may have synced before (its changes are in the clock as an origin)
    const prior = db.get("SELECT max(oseq) AS n FROM sync_clock WHERE origin = ?", [device])?.n ?? 0;
    const vec = db.get("SELECT seq FROM sync_vector WHERE origin = ?", [device])?.seq ?? 0;
    setMeta("seq", Math.max(prior, vec));
    db.run("DELETE FROM sync_vector WHERE origin = ?", [device]);
  } else if (!device) {
    device = randomId(8);
    setMeta("device", device);
    setMeta("seq", 0);
  }
  if (getMeta("seq") == null) setMeta("seq", 0); // the triggers UPDATE this row
  if (options.deviceName && getMeta("device_name") !== options.deviceName) setMeta("device_name", options.deviceName);
  let seq = Number(getMeta("seq") ?? 0);
  const deviceClientId = hash52(`device:${device}`);

  const clock = createClock(device, { now, maxDriftMs });
  clock.seed(db.get("SELECT max(stamp) AS s FROM sync_clock")?.s);

  // --- while this device applies another's changes, the triggers stay quiet (sync_flag) -----
  const setApplying = (on) => db.run("UPDATE sync_flag SET applying = ? WHERE id = 1", [on ? 1 : 0]);

  // --- tables ---------------------------------------------------------------------------------
  const info = {};
  for (const [name, cfg] of Object.entries(tables)) {
    const cols = db.all(`PRAGMA table_info(${quoteIdent(name)})`);
    if (!cols.length) throw new SyncError(BAD_CONFIG, `table ${name} doesn't exist`);
    const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    if (!pk.length) throw new SyncError(BAD_CONFIG, `table ${name} has no primary key — synced tables need one`);
    const exclude = new Set(cfg?.exclude ?? []);
    const data = cols.filter((c) => !c.pk && !exclude.has(c.name)).map((c) => c.name);
    const text = {};
    for (const [col, adapter] of Object.entries(cfg?.text ?? {})) {
      if (!data.includes(col)) throw new SyncError(BAD_CONFIG, `text column ${name}.${col} isn't a synced column`);
      if (!adapter || typeof adapter.apply !== "function" || typeof adapter.render !== "function") {
        throw new SyncError(BAD_CONFIG, `text column ${name}.${col} needs an adapter with apply(doc, value) and render(doc)`);
      }
      text[col] = textOps(adapter, deviceClientId, options.yjs);
    }
    const where = pk.map((c) => `${quoteIdent(c)} = ?`).join(" AND ");
    info[name] = { name, pk, data, text, where, Q: quoteIdent(name), dataSet: new Set(data) };
  }

  // --- foreign keys between synced tables ---------------------------------------------------
  // A row whose parent another device deleted is deleted here too (the cascade's own rule), and
  // that delete is recorded, so every device ends the same. `children` maps a parent table to
  // the synced tables referencing it.
  const children = new Map();
  for (const t of Object.values(info)) {
    const fks = new Map();
    for (const r of db.all(`PRAGMA foreign_key_list(${t.Q})`)) {
      if (!info[r.table]) continue;
      if (!fks.has(r.id)) fks.set(r.id, { child: t.name, parent: r.table, from: [], to: [], onDelete: r.on_delete });
      const fk = fks.get(r.id);
      fk.from[r.seq] = r.from;
      fk.to[r.seq] = r.to;
    }
    for (const fk of fks.values()) {
      if (fk.to.some((c) => c == null)) fk.to = info[fk.parent].pk; // REFERENCES parent with no columns = its primary key
      if (!children.has(fk.parent)) children.set(fk.parent, []);
      children.get(fk.parent).push(fk);
    }
  }
  const fksOn = () => Number(db.get("PRAGMA foreign_keys")?.foreign_keys ?? 0) === 1;

  // --- triggers (rebuilt when the tables' shape changes, or when they're gone — dropping and
  // re-creating a table drops its triggers) --------------------------------------------------
  const allTriggerSql = Object.values(info)
    .map((t) => triggerSql(t.name, t))
    .join("\n");
  const triggerHash = String(hash52(`v${FORMAT_VERSION}\n${allTriggerSql}`));
  const ours = () => db.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, ?) = ?", [TRIGGER_PREFIX.length, TRIGGER_PREFIX]);
  if (getMeta("triggers") !== triggerHash || ours().length !== Object.keys(info).length * TRIGGERS_PER_TABLE) {
    db.transaction(() => {
      for (const { name } of ours()) db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(name)}`);
      db.exec(allTriggerSql);
      setMeta("triggers", triggerHash);
    });
  }

  /**
   * Stamp the changes the triggers noted (from any connection) as this device's own: each field
   * gets the next clock stamp and sequence. Runs before changes are read or applied; an app calls
   * it after its saves so stamps follow the order edits were made in.
   * @returns {number} how many fields were stamped
   */
  function flush() {
    const pending = db.all("SELECT tbl, pk, col, alive FROM sync_pending");
    if (!pending.length) return 0;
    db.transaction(() => {
      for (const p of pending) {
        if (!info[p.tbl]) continue;
        const stamp = clock.tick();
        const n = ++seq;
        db.run("INSERT OR REPLACE INTO sync_clock (tbl, pk, col, stamp, origin, oseq, alive) VALUES (?, ?, ?, ?, ?, ?, ?)", [
          p.tbl,
          p.pk,
          p.col,
          stamp,
          device,
          n,
          p.col === "-" ? p.alive : null,
        ]);
      }
      db.run("DELETE FROM sync_pending");
      setMeta("seq", seq);
    });
    return pending.length;
  }

  // --- adopt rows that exist but were never recorded (first open; a newly synced table) -------
  flush();
  adoptExisting();

  function adoptExisting() {
    const insertClock = "INSERT OR REPLACE INTO sync_clock (tbl, pk, col, stamp, origin, oseq, alive) VALUES (?, ?, ?, ?, ?, ?, ?)";
    db.transaction(() => {
      for (const t of Object.values(info)) {
        const pkJson = `json_array(${t.pk.map((c) => `t.${quoteIdent(c)}`).join(", ")})`;
        const rows = db.all(
          `SELECT ${pkJson} AS k FROM ${t.Q} t WHERE NOT EXISTS (SELECT 1 FROM sync_clock c WHERE c.tbl = ? AND c.pk = ${pkJson} AND c.col = '-')`,
          [t.name],
        );
        for (const { k } of rows) {
          const stamp = clock.tick();
          const n = ++seq;
          db.run(insertClock, [t.name, k, "-", stamp, device, n, 1]);
          for (const col of t.data) db.run(insertClock, [t.name, k, col, stamp, device, n, null]);
        }
      }
      setMeta("seq", seq);
    });
  }

  // --- helpers --------------------------------------------------------------------------------
  const pkValues = (k) => JSON.parse(k).map(decodeValue);
  const readRow = (t, k, cols) => db.get(`SELECT ${cols.map(quoteIdent).join(", ")} FROM ${t.Q} WHERE ${t.where}`, pkValues(k));
  const rowExists = (t, k) => !!db.get(`SELECT 1 AS x FROM ${t.Q} WHERE ${t.where}`, pkValues(k));
  const setClock = (tbl, k, col, stamp, origin, oseq, alive = null) =>
    db.run("INSERT OR REPLACE INTO sync_clock (tbl, pk, col, stamp, origin, oseq, alive) VALUES (?, ?, ?, ?, ?, ?, ?)", [tbl, k, col, stamp, origin, oseq, alive]);
  const getText = (tbl, k, col) => db.get("SELECT state, stamp FROM sync_text WHERE tbl = ? AND pk = ? AND col = ?", [tbl, k, col]);
  const setText = (tbl, k, col, state, stamp) =>
    db.run("INSERT OR REPLACE INTO sync_text (tbl, pk, col, state, stamp) VALUES (?, ?, ?, ?, ?)", [tbl, k, col, state, stamp]);
  const asBytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

  /** A new change made by this device itself (outside a trigger). */
  function localChange() {
    const stamp = clock.tick();
    const n = ++seq;
    setMeta("seq", seq);
    return { stamp, n };
  }

  /** Bring each rich-text field's Yjs state up to the column's current value. */
  function reconcileText() {
    for (const t of Object.values(info)) {
      for (const [col, ops] of Object.entries(t.text)) {
        const dirty = db.all(
          `SELECT c.pk AS k, c.stamp AS stamp, x.state AS state FROM sync_clock c
             LEFT JOIN sync_text x ON x.tbl = c.tbl AND x.pk = c.pk AND x.col = c.col
            WHERE c.tbl = ? AND c.col = ? AND (x.stamp IS NULL OR x.stamp <> c.stamp)`,
          [t.name, col],
        );
        for (const { k, stamp, state } of dirty) {
          const row = readRow(t, k, [col]);
          if (!row) continue;
          const next = ops.fromValue(state ? asBytes(state) : null, row[col], `${t.name}\u0000${k}\u0000${col}`);
          setText(t.name, k, col, next, stamp);
        }
      }
    }
  }

  function vector() {
    const out = {};
    for (const { origin, seq: n } of db.all("SELECT origin, seq FROM sync_vector")) out[origin] = n;
    out[device] = seq;
    return out;
  }

  // --- outgoing -------------------------------------------------------------------------------
  /**
   * The changes a device holding `peerVector` lacks.
   * @param {Record<string, number>} [peerVector]
   * @param {{ scope?: (table: string, pk: any[]) => boolean, partial?: boolean }} [opts]
   *   scope: only rows it accepts (a by-hand export of some books) — the batch is then partial
   */
  function changesSince(peerVector = {}, opts = {}) {
    db.transaction(() => {
      flush();
      reconcileText();
    });
    const sql = `SELECT c.tbl, c.pk, c.col, c.stamp, c.origin, c.oseq, c.alive FROM sync_clock c
                   LEFT JOIN json_each(?) v ON v.key = c.origin
                  WHERE c.oseq > coalesce(v.value, 0)
                  ORDER BY c.origin, c.oseq`;
    const groups = new Map();
    for (const r of db.all(sql, [JSON.stringify(peerVector || {})])) {
      if (!info[r.tbl]) continue;
      const key = `${r.tbl}\u0000${r.pk}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { tbl: r.tbl, k: r.pk, rows: [] }));
      g.rows.push(r);
    }
    const changes = [];
    for (const { tbl, k, rows } of groups.values()) {
      const t = info[tbl];
      if (opts.scope && !opts.scope(tbl, pkValues(k))) continue;
      const fieldCols = rows.filter((r) => r.col !== "-" && t.dataSet.has(r.col)).map((r) => r.col);
      const row = fieldCols.length ? readRow(t, k, fieldCols) : undefined;
      for (const r of rows) {
        const base = { t: tbl, k, c: r.col, s: r.stamp, o: r.origin, n: r.oseq };
        if (r.col === "-") {
          changes.push({ ...base, v: r.alive ? 1 : 0 });
        } else if (row && t.dataSet.has(r.col)) {
          if (t.text[r.col]) {
            const x = getText(tbl, k, r.col);
            if (x) changes.push({ ...base, v: { y: toBase64(asBytes(x.state)) } });
          } else {
            changes.push({ ...base, v: encodeValue(row[r.col]) });
          }
        }
      }
    }
    // A batch is complete for every origin when it holds every change above the peer's vector
    // (superseded ones are gone, never lost) — the receiver may then take this device's vector.
    // A scoped batch (some books only) is complete for nothing.
    const partial = !!(opts.scope || opts.partial);
    return {
      format: FORMAT_VERSION,
      app,
      library,
      schema: schemaVersion,
      from: device,
      fromName: getMeta("device_name") ?? null,
      created: new Date((now ?? Date.now)()).toISOString(),
      partial,
      vector: partial ? {} : vector(),
      changes,
    };
  }

  // --- incoming -------------------------------------------------------------------------------
  /**
   * Apply a batch of changes from another device.
   * @param {object} batch as made by changesSince()
   * @param {{ join?: boolean }} [opts] join: adopt the batch's library (pairing a new device)
   * @returns {{ applied: number, skipped: number, rows: number, problems: object[], tables: string[] }}
   */
  function apply(batch, opts = {}) {
    if (!batch || !Array.isArray(batch.changes)) throw new SyncError("bad-batch", "not a batch of changes");
    if (batch.app && batch.app !== app) {
      throw new SyncError(LIBRARY_MISMATCH, `these changes are from ${batch.app}, not ${app}`, { app: batch.app });
    }
    if (batch.library !== library) {
      if (!opts.join) {
        throw new SyncError(LIBRARY_MISMATCH, "these changes belong to another library", { library: batch.library });
      }
      library = batch.library;
      setMeta("library", library);
    }
    if ((batch.schema ?? 1) > schemaVersion) {
      throw new SyncError(SCHEMA_TOO_NEW, `these changes come from a newer version of ${app} (schema ${batch.schema}; this device has ${schemaVersion}) — update ${app} on this device`, {
        schema: batch.schema,
      });
    }
    const stats = { applied: 0, skipped: 0, rows: 0, problems: [], tables: new Set() };
    db.transaction(() => {
      // This device's own changes coming back (a database rebuilt from its own files, a peer
      // returning what it got): the sequence continues past them BEFORE anything is stamped, or
      // new changes would reuse numbers other devices already hold and be skipped there.
      for (const ch of batch.changes) if (ch.o === device && ch.n > seq) seq = ch.n;
      if (!batch.partial && (batch.vector?.[device] ?? 0) > seq) seq = batch.vector[device];
      flush();
      reconcileText();
      for (const ch of batch.changes) clock.observe(ch.s);
      setApplying(true);
      try {
        db.exec("PRAGMA defer_foreign_keys = ON");
        const groups = new Map();
        for (const ch of batch.changes) {
          const key = `${ch.t}\u0000${ch.k}`;
          let g = groups.get(key);
          if (!g) groups.set(key, (g = { tbl: ch.t, k: ch.k, latest: new Map() }));
          const prev = g.latest.get(ch.c);
          if (!prev || ch.s > prev.s) g.latest.set(ch.c, ch);
        }
        const incomingDelete = (tbl, k) => groups.get(`${tbl}\u0000${k}`)?.latest.get("-")?.v === 0;
        for (const g of groups.values()) applyRow(g, stats, incomingDelete);
        if (fksOn()) removeOrphans(stats);
        flush(); // the orphans this device removed, as its own changes
        if (!batch.partial) {
          for (const [origin, n] of Object.entries(batch.vector || {})) {
            if (origin === device) continue;
            db.run("INSERT INTO sync_vector (origin, seq) VALUES (?, ?) ON CONFLICT(origin) DO UPDATE SET seq = max(seq, excluded.seq)", [origin, n]);
          }
        }
        setMeta("seq", seq);
      } finally {
        setApplying(false);
      }
    });
    return { ...stats, tables: [...stats.tables] };
  }

  /** The rows a delete of (tbl, k) will cascade to, depth first. */
  function cascadeOf(tbl, k, out = []) {
    for (const fk of children.get(tbl) ?? []) {
      if (fk.onDelete !== "CASCADE") continue;
      const parent = info[tbl];
      const vals = db.get(`SELECT ${fk.to.map(quoteIdent).join(", ")} FROM ${parent.Q} WHERE ${parent.where}`, pkValues(k));
      if (!vals) continue;
      const ct = info[fk.child];
      const rows = db.all(
        `SELECT json_array(${ct.pk.map(quoteIdent).join(", ")}) AS k FROM ${ct.Q} WHERE ${fk.from.map((c) => `${quoteIdent(c)} = ?`).join(" AND ")}`,
        fk.to.map((c) => vals[c]),
      );
      for (const r of rows) {
        out.push({ tbl: fk.child, k: r.k });
        cascadeOf(fk.child, r.k, out);
      }
    }
    return out;
  }

  /** This device deleted a row as a consequence of another device's change: record it. */
  function recordDelete(tbl, k) {
    const c = localChange();
    setClock(tbl, k, "-", c.stamp, device, c.n, 0);
    db.run("DELETE FROM sync_clock WHERE tbl = ? AND pk = ? AND col <> '-'", [tbl, k]);
    db.run("DELETE FROM sync_text WHERE tbl = ? AND pk = ?", [tbl, k]);
  }

  /**
   * Rows whose parent is gone (one device added a chapter while another deleted its book): the
   * parent's delete wins, as the cascade would have done — they're deleted (SET NULL foreign keys
   * are nulled instead), recorded like any local change so every device ends the same.
   */
  function removeOrphans(stats) {
    for (const fks of children.values()) {
      for (const fk of fks) {
        if (!stats.tables.has(fk.child)) continue;
        const ct = info[fk.child];
        const pt = info[fk.parent];
        const match = fk.from.map((c, i) => `p.${quoteIdent(fk.to[i])} = c.${quoteIdent(c)}`).join(" AND ");
        const set = fk.from.map((c) => `c.${quoteIdent(c)} IS NOT NULL`).join(" AND ");
        const orphans = db.all(
          `SELECT json_array(${ct.pk.map((c) => `c.${quoteIdent(c)}`).join(", ")}) AS k FROM ${ct.Q} c WHERE ${set} AND NOT EXISTS (SELECT 1 FROM ${pt.Q} p WHERE ${match})`,
        );
        if (!orphans.length) continue;
        setApplying(false); // noted as this device's own changes
        try {
          for (const { k } of orphans) {
            if (fk.onDelete === "SET NULL") {
              db.run(`UPDATE ${ct.Q} SET ${fk.from.map((c) => `${quoteIdent(c)} = NULL`).join(", ")} WHERE ${ct.where}`, pkValues(k));
            } else {
              db.run(`DELETE FROM ${ct.Q} WHERE ${ct.where}`, pkValues(k));
            }
            stats.rows++;
          }
        } finally {
          setApplying(true);
        }
      }
    }
  }

  function applyRow({ tbl, k, latest }, stats, incomingDelete) {
    const t = info[tbl];
    if (!t) {
      stats.skipped += latest.size;
      return;
    }
    const local = new Map(db.all("SELECT col, stamp, origin, oseq, alive FROM sync_clock WHERE tbl = ? AND pk = ?", [tbl, k]).map((r) => [r.col, r]));
    const inMarker = latest.get("-");
    const locMarker = local.get("-");
    let touched = false;

    if (inMarker && (!locMarker || inMarker.s > locMarker.stamp)) {
      setClock(tbl, k, "-", inMarker.s, inMarker.o, inMarker.n, inMarker.v ? 1 : 0);
      stats.applied++;
      if (!inMarker.v) {
        // deleted: the row goes, and its foreign-key children cascade here as they did there.
        // Children only this device had (added here meanwhile) go too; their deletes are
        // recorded so the other devices drop them as well.
        const doomed = fksOn() ? cascadeOf(tbl, k) : [];
        db.run(`DELETE FROM ${t.Q} WHERE ${t.where}`, pkValues(k));
        for (const d of doomed) {
          const m = db.get("SELECT alive FROM sync_clock WHERE tbl = ? AND pk = ? AND col = '-'", [d.tbl, d.k]);
          if (m && m.alive === 0) continue;
          if (incomingDelete(d.tbl, d.k)) continue;
          recordDelete(d.tbl, d.k);
          stats.tables.add(d.tbl);
        }
        db.run("DELETE FROM sync_clock WHERE tbl = ? AND pk = ? AND col <> '-'", [tbl, k]);
        db.run("DELETE FROM sync_text WHERE tbl = ? AND pk = ?", [tbl, k]);
        for (const [c] of latest) if (c !== "-") stats.skipped++;
        stats.rows++;
        stats.tables.add(tbl);
        return;
      }
      touched = true;
    } else if (inMarker) {
      stats.skipped++;
    }
    const marker = inMarker && (!locMarker || inMarker.s > locMarker.stamp) ? { alive: inMarker.v ? 1 : 0 } : locMarker;
    const exists = rowExists(t, k);
    const fields = [...latest.values()].filter((c) => c.c !== "-" && t.dataSet.has(c.c));
    for (const c of latest.values()) if (c.c !== "-" && !t.dataSet.has(c.c)) stats.skipped++;

    if (!exists) {
      if (marker && !marker.alive) {
        // deleted here, and the delete is newer than anything coming in
        stats.skipped += fields.length;
        return;
      }
      if (!fields.length) return;
      const values = [];
      const textStates = [];
      for (const f of fields) {
        if (t.text[f.c]) {
          const state = fromBase64(f.v.y);
          textStates.push([f, state]);
          values.push(t.text[f.c].render(state));
        } else {
          values.push(decodeValue(f.v));
        }
      }
      const cols = [...t.pk, ...fields.map((f) => f.c)];
      try {
        db.run(
          `INSERT INTO ${t.Q} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          [...pkValues(k), ...values],
        );
      } catch (err) {
        stats.problems.push({ table: tbl, pk: k, error: String(err.message || err) });
        stats.skipped += fields.length;
        return;
      }
      if (!marker) setClock(tbl, k, "-", fields[0].s, fields[0].o, fields[0].n, 1);
      for (const f of fields) setClock(tbl, k, f.c, f.s, f.o, f.n);
      for (const [f, state] of textStates) setText(tbl, k, f.c, state, f.s);
      stats.applied += fields.length;
      stats.rows++;
      stats.tables.add(tbl);
      return;
    }

    const sets = [];
    const vals = [];
    for (const f of fields) {
      const loc = local.get(f.c);
      if (t.text[f.c]) {
        const r = mergeText(t, k, f, loc);
        if (r.changed) {
          sets.push(f.c);
          vals.push(r.value);
        }
        if (r.counted) stats.applied++;
        else stats.skipped++;
        continue;
      }
      if (loc && f.s <= loc.stamp) {
        stats.skipped++;
        continue;
      }
      sets.push(f.c);
      vals.push(decodeValue(f.v));
      setClock(tbl, k, f.c, f.s, f.o, f.n);
      stats.applied++;
    }
    if (sets.length) {
      db.run(`UPDATE ${t.Q} SET ${sets.map((c) => `${quoteIdent(c)} = ?`).join(", ")} WHERE ${t.where}`, [...vals, ...pkValues(k)]);
      touched = true;
    }
    if (touched) {
      stats.rows++;
      stats.tables.add(tbl);
    }
  }

  /** Merge an incoming Yjs state into a rich-text field. */
  function mergeText(t, k, f, loc) {
    const ops = t.text[f.c];
    const incoming = fromBase64(f.v.y);
    const cur = getText(t.name, k, f.c);
    const curState = cur ? asBytes(cur.state) : null;
    const merged = curState ? ops.merge(curState, incoming) : incoming;
    const changed = !curState || !ops.same(merged, curState);
    const extra = curState ? !ops.same(merged, incoming) : false;
    // The field's clock must always name a version that holds what this device has, or a device
    // asking for "what I lack" by origin could miss it. (Text never compares stamps to merge.)
    let stamp = loc?.stamp;
    if (!extra) {
      // this device now holds exactly what the sender held at that change — even when that
      // stamp is older than ours (the sender's edits already contained ours)
      if (!loc || changed || f.s > loc.stamp) {
        setClock(t.name, k, f.c, f.s, f.o, f.n);
        stamp = f.s;
      }
    } else if (changed) {
      // both sides had edits the other lacked: the merge is a new version, made here
      const c = localChange();
      setClock(t.name, k, f.c, c.stamp, device, c.n);
      stamp = c.stamp;
    }
    const value = changed ? ops.render(merged) : undefined;
    if (changed || (stamp && cur && cur.stamp !== stamp)) setText(t.name, k, f.c, merged, stamp ?? f.s);
    return { changed, value, counted: changed || !extra };
  }

  // --- the rest of the API ------------------------------------------------------------------
  function recordPeer(id, { name = null, kind = null, info: extra = null } = {}) {
    if (!id) return;
    db.run(
      "INSERT INTO sync_peers (id, name, kind, last_sync, info) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = coalesce(excluded.name, name), kind = coalesce(excluded.kind, kind), last_sync = excluded.last_sync, info = coalesce(excluded.info, info)",
      [id, name, kind, new Date((now ?? Date.now)()).toISOString(), extra == null ? null : JSON.stringify(extra)],
    );
  }

  return {
    get library() {
      return library;
    },
    get device() {
      return device;
    },
    get deviceName() {
      return getMeta("device_name") ?? null;
    },
    get app() {
      return app;
    },
    get schemaVersion() {
      return schemaVersion;
    },
    tables: Object.keys(info),
    vector,
    changesSince,
    apply,
    flush,
    recordPeer,
    peers: () => db.all("SELECT id, name, kind, last_sync AS lastSync, info FROM sync_peers ORDER BY last_sync DESC").map((p) => ({ ...p, info: p.info ? JSON.parse(p.info) : null })),
    setDeviceName(name) {
      setMeta("device_name", name);
    },
    /** Join another library: this device's data merges into it from now on. */
    joinLibrary(id) {
      library = id;
      setMeta("library", id);
    },
    /** Engine-owned key/value storage for transports (last file read, last pushed, …). */
    getState: (key) => {
      const v = getMeta(`state:${key}`);
      return v == null ? undefined : JSON.parse(v);
    },
    setState: (key, value) => setMeta(`state:${key}`, JSON.stringify(value)),
    /** Re-read the tables' shape (after the app migrated its schema) and rebuild the triggers. */
    adoptExisting,
    /** Highest sequence this device has used. */
    get seq() {
      return seq;
    },
  };
}
