// SPDX-License-Identifier: MIT
// Restoring a backup over a synced database (src/restore.js, and openSync on a restored database):
// the device continues as a new device in sync, and the other devices' newer work wins — what was
// edited, made or deleted since the backup comes back on the next sync, on every device, instead
// of the backup's old rows overwriting it (JustVoice's narrowings review, P16, decided 2026-10-15).

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BAD_CONFIG, folderSync, openSync, restorePending } from "../src/index.js";
import { nodeFolder } from "../src/transports/node-folder.js";
import { TABLES, backupOf, dump, exchange, fileDatabase, makeDevice, now, restore, restoreCopy } from "./helpers.js";
import { runWithRestores } from "./sim.js";

let dir;
let open = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sync-restore-"));
});
afterEach(() => {
  for (const d of open) d.raw.close();
  open = [];
  rmSync(dir, { recursive: true, force: true });
});

const title = (d, id) => d.db.prepare("SELECT title FROM chapters WHERE id = ?").get(id)?.title;
const file = (name) => path.join(dir, `${name}.db`);

function device(name, opts = {}) {
  const d = makeDevice(name, { raw: fileDatabase(file(name)), ...opts });
  open.push(d);
  return d;
}

/** a has a book with chapters c1, c2, c4; b joined its library. */
function setup() {
  const a = device("a");
  const b = device("b");
  a.db.exec("INSERT INTO projects (id, title) VALUES ('p1', 'Book')");
  for (const [id, pos] of [
    ["c1", 1],
    ["c2", 2],
    ["c4", 4],
  ]) {
    a.db.prepare("INSERT INTO chapters (project_id, id, position, title) VALUES ('p1', ?, ?, 'old')").run(id, pos);
  }
  b.sync.apply(a.sync.changesSince({}), { join: true });
  return { a, b };
}

describe("restoring a backup", () => {
  it("keeps the newer work made since the backup, on both devices; the restored one is a new device", () => {
    const { a, b } = setup();
    const backup = backupOf(a, path.join(dir, "backup.db"));
    a.db.exec("UPDATE chapters SET title = 'a after' WHERE id = 'c1'"); // a's own edit, synced
    exchange(a, b);
    b.db.exec("UPDATE chapters SET title = 'b after' WHERE id = 'c2'");
    b.db.exec("INSERT INTO chapters (project_id, id, position, title) VALUES ('p1', 'c3', 3, 'new on b')");
    b.db.exec("DELETE FROM chapters WHERE id = 'c4'");
    exchange(a, b);

    const before = a.sync.device;
    restore(a, file("a"), backup);
    expect(title(a, "c1")).toBe("old"); // the backup's rows, until the next sync
    expect(title(a, "c3")).toBeUndefined();
    expect(a.sync.device).not.toBe(before);
    expect(Object.keys(a.sync.vector())).toContain(before); // the old id: an origin like any other

    exchange(a, b);
    for (const d of [a, b]) {
      expect(title(d, "c1")).toBe("a after");
      expect(title(d, "c2")).toBe("b after");
      expect(title(d, "c3")).toBe("new on b");
      expect(title(d, "c4")).toBeUndefined();
    }
    expect(dump(a.db)).toEqual(dump(b.db));
    expect(b.sync.changesSince(a.sync.vector()).changes).toEqual([]);
    expect(a.sync.changesSince(b.sync.vector()).changes).toEqual([]);
  });

  it("a backup from before sync loses to every newer change", () => {
    const { a, b } = setup();
    const backup = backupOf(a, path.join(dir, "presync.db"));
    const old = new Database(backup);
    for (const { name } of old.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sync_%'").all()) {
      old.exec(`DROP TABLE "${name}"`);
    }
    old.close();
    b.db.exec("UPDATE chapters SET title = 'b after' WHERE id = 'c2'");
    b.db.exec("DELETE FROM chapters WHERE id = 'c4'");
    exchange(a, b);

    restore(a, file("a"), backup);
    exchange(a, b);
    for (const d of [a, b]) {
      expect(title(d, "c2")).toBe("b after");
      expect(title(d, "c4")).toBeUndefined();
      expect(title(d, "c1")).toBe("old");
    }
    expect(dump(a.db)).toEqual(dump(b.db));
  });

  it("an edit on the restored device afterwards reaches the others, rich text too", () => {
    const { a, b } = setup();
    a.db.exec("INSERT INTO scenes VALUES ('p1', 's1', 'c1', 0, 'Scene', 'the lamp was lit')");
    exchange(a, b);
    const backup = backupOf(a, path.join(dir, "backup.db"));
    a.db.exec("UPDATE scenes SET body = 'the lamp was lit at night' WHERE id = 's1'");
    exchange(a, b);
    restore(a, file("a"), backup);
    // edited before the next sync, on the backup's text: as the old id, these edits would reuse
    // the ids of the ones made after the backup, and the other device would skip them as known
    a.db.exec("UPDATE scenes SET body = 'the brass lamp was lit' WHERE id = 's1'");
    a.db.exec("UPDATE chapters SET title = 'after the restore' WHERE id = 'c1'");
    exchange(a, b);
    expect(title(b, "c1")).toBe("after the restore");
    expect(b.db.prepare("SELECT body FROM scenes").get().body).toBe("the brass lamp was lit at night");
    expect(dump(a.db)).toEqual(dump(b.db));
  });

  it("an edit noted but not yet stamped when the backup was taken keeps the backup's age", () => {
    const { a, b } = setup();
    // the triggers noted these; nothing stamped them before the backup, nor sent them since
    a.raw.exec("UPDATE chapters SET title = 'unstamped' WHERE id IN ('c1', 'c2')");
    const backup = backupOf(a, path.join(dir, "backup.db"));
    b.db.exec("UPDATE chapters SET title = 'b after' WHERE id = 'c2'"); // newer than the backup
    restore(a, file("a"), backup);
    exchange(a, b);
    for (const d of [a, b]) {
      expect(title(d, "c1")).toBe("unstamped");
      expect(title(d, "c2")).toBe("b after");
    }
    expect(dump(a.db)).toEqual(dump(b.db));
  });

  it("a change only one other device holds still comes back (three devices)", () => {
    const a = device("a");
    const b = device("b");
    const c = device("c");
    a.db.exec("INSERT INTO projects (id, title) VALUES ('p1', 'Book')");
    a.db.exec("INSERT INTO chapters (project_id, id, position, title) VALUES ('p1', 'c1', 1, 'old')");
    b.sync.apply(a.sync.changesSince({}), { join: true });
    c.sync.apply(a.sync.changesSince({}), { join: true });
    const backup = backupOf(a, path.join(dir, "backup3.db"));
    a.db.exec("UPDATE chapters SET title = 'a after, only c has it' WHERE id = 'c1'");
    exchange(a, c); // b never hears of it

    restore(a, file("a"), backup);
    exchange(a, b);
    exchange(a, c);
    expect(title(a, "c1")).toBe("a after, only c has it");
    exchange(a, b);
    expect(title(b, "c1")).toBe("a after, only c has it");
  });

  it("an exchange under way during the restore is left for the next one", () => {
    const { a, b } = setup();
    const backup = backupOf(a, path.join(dir, "backup.db"));
    b.db.exec("INSERT INTO projects (id, title) VALUES ('p2', 'Second book')");
    exchange(a, b); // a has the second book
    b.db.exec("INSERT INTO chapters (project_id, id, position, title) VALUES ('p2', 'c9', 1, 'in the second book')");
    // b made its batch for a's vector from before the restore: it holds the new chapter but not
    // its book, which a had then. Applied, the chapter would be an orphan here, and its delete
    // would win everywhere.
    const early = b.sync.changesSince(a.sync.vector());
    restore(a, file("a"), backup);
    expect(a.sync.apply(early)).toMatchObject({ applied: 0, stale: true });
    exchange(a, b);
    for (const d of [a, b]) expect(title(d, "c9")).toBe("in the second book");
    expect(dump(a.db)).toEqual(dump(b.db));
  });

  it("a restored database opens only under a new device id — or makes its own when it keeps the id", () => {
    const { a } = setup();
    const backup = backupOf(a, path.join(dir, "backup.db"));
    const before = a.sync.device;
    restoreCopy(file("a"), backup);
    expect(restorePending(a.adapter)).toBe(true);
    const reopen = (deviceId) => openSync(a.adapter, { app: "testapp", tables: TABLES, deviceId, now });
    expect(() => reopen(before)).toThrow(expect.objectContaining({ code: BAD_CONFIG }));
    a.sync = reopen(undefined); // the phone's way: the engine keeps the id in the database
    expect(a.sync.device).not.toBe(before);
    expect(restorePending(a.adapter)).toBe(false);
    expect(a.sync.vector()[before]).toBeGreaterThan(0);
  });

  it("folder sync: the new device writes its own files from the first and reads every other device's again", async () => {
    const root = path.join(dir, "folder");
    const a = device("a");
    const b = device("b");
    b.sync.joinLibrary(a.sync.library);
    a.db.exec("INSERT INTO projects (id, title) VALUES ('p1', 'Book')");
    a.db.exec("INSERT INTO chapters (project_id, id, position, title) VALUES ('p1', 'c2', 2, 'old'), ('p1', 'c3', 3, 'old')");
    const fa = () => folderSync(a.sync, nodeFolder(root));
    const fb = () => folderSync(b.sync, nodeFolder(root));
    await fa().sync();
    await fb().sync();
    const backup = backupOf(a, path.join(dir, "fbackup.db"));
    a.db.exec("UPDATE chapters SET title = 'a after the backup' WHERE id = 'c2'");
    await fa().sync(); // in a's own folder files only
    b.db.exec("UPDATE chapters SET title = 'b after the backup' WHERE id = 'c3'");
    await fb().sync();

    const before = a.sync.device;
    restore(a, file("a"), backup);
    await fa().sync();
    await fb().sync();
    for (const d of [a, b]) {
      expect(title(d, "c2")).toBe("a after the backup"); // from its old folder copy
      expect(title(d, "c3")).toBe("b after the backup");
    }
    expect(dump(a.db)).toEqual(dump(b.db));
    const lib = path.join(root, a.sync.library);
    expect(readdirSync(path.join(lib, a.sync.device)).filter((n) => n.startsWith("c-"))[0]).toBe("c-0000000001.sqs");
    expect(existsSync(path.join(lib, before))).toBe(true); // the old copy stays until removed
  });
});

describe("restoring a backup: the stress run", () => {
  it("three devices, random edits, backups and restores: every run ends identical (300 seeded runs)", () => {
    let restores = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const runDir = mkdtempSync(path.join(dir, "run-"));
      const { devs, restores: n } = runWithRestores(seed, 60, runDir);
      restores += n;
      try {
        const [da, db, dc] = devs.map((d) => dump(d.db));
        expect(db).toEqual(da);
        expect(dc).toEqual(da);
        for (const d of devs) {
          expect(d.raw.pragma("foreign_key_check")).toEqual([]);
          expect(restorePending(d.adapter)).toBe(false);
        }
        for (const x of devs) for (const y of devs) if (x !== y) expect(x.sync.changesSince(y.sync.vector()).changes).toEqual([]);
      } catch (err) {
        err.message = `seed ${seed}: ${err.message}`;
        throw err;
      } finally {
        for (const d of devs) d.raw.close();
      }
    }
    expect(restores).toBeGreaterThan(500);
  }, 600_000);

  it("the run that once ended different: a parent's delete over a child brought back (seed 526)", () => {
    const { devs } = runWithRestores(526, 60, mkdtempSync(path.join(dir, "run-")));
    try {
      const [da, db, dc] = devs.map((d) => dump(d.db));
      expect(db).toEqual(da);
      expect(dc).toEqual(da);
    } finally {
      for (const d of devs) d.raw.close();
    }
  });
});
