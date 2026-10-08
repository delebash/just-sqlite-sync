// SPDX-License-Identifier: MIT
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LIBRARY_MISMATCH, SCHEMA_TOO_NEW, CLOCK_DRIFT } from "../src/index.js";
import { dump, exchange, makeDevice, setNow } from "./helpers.js";

function seed(dev) {
  dev.db.exec(`
    INSERT INTO projects VALUES ('p1', 'The Book', 'Ann');
    INSERT INTO chapters VALUES ('p1', 'c1', 0, 'One'), ('p1', 'c2', 1, 'Two');
    INSERT INTO scenes VALUES ('p1', 's1', 'c1', 0, 'Opening', 'It was a dark night.'),
                              ('p1', 's2', 'c1', 1, 'Next', 'Morning came.');
  `);
}

/** Two devices holding the same library: a writes the book, b gets it. */
function pair() {
  const a = makeDevice("a");
  const b = makeDevice("b");
  seed(a);
  b.sync.apply(a.sync.changesSince({}), { join: true });
  return { a, b };
}

describe("recording changes", () => {
  it("records inserts, updates and deletes with stamps and origins", () => {
    const a = makeDevice("a");
    seed(a);
    const batch = a.sync.changesSince({});
    const scene = batch.changes.filter((c) => c.t === "scenes" && c.k === '["p1","s1"]');
    expect(scene.map((c) => c.c).sort()).toEqual(["-", "body", "chapter_id", "position", "title"]);
    expect(scene.every((c) => c.o === "dev-a" && c.n > 0)).toBe(true);
    const before = a.sync.seq;
    a.db.exec("UPDATE scenes SET title = 'Start' WHERE id = 's1'");
    const delta = a.sync.changesSince({ "dev-a": before });
    expect(delta.changes.map((c) => [c.t, c.c, c.v])).toEqual([["scenes", "title", "Start"]]);
    a.db.exec("DELETE FROM scenes WHERE id = 's2'");
    const del = a.sync.changesSince({ "dev-a": before + 1 });
    expect(del.changes).toHaveLength(1);
    expect(del.changes[0]).toMatchObject({ t: "scenes", k: '["p1","s2"]', c: "-", v: 0 });
  });

  it("adopts rows that existed before sync was opened", () => {
    const a = makeDevice("a");
    a.db.exec("INSERT INTO settings VALUES ('x', 'y')"); // not synced: never recorded
    seed(a);
    const raw = a.raw;
    const again = makeDevice("a2", { raw, deviceId: "dev-a" });
    expect(again.sync.changesSince({}).changes.length).toBe(a.sync.changesSince({}).changes.length);
  });

  it("a write from another connection is noted too (a restore, a script, a database browser)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sqlite-sync-conn-"));
    try {
      const file = path.join(dir, "lib.db");
      const a = makeDevice("a", { file });
      seed(a);
      const before = a.sync.seq;
      const other = new Database(file); // no engine, no functions registered on it
      other.pragma("foreign_keys = ON");
      other.exec("UPDATE chapters SET title = 'Written elsewhere' WHERE id = 'c1'; DELETE FROM chapters WHERE id = 'c2';");
      other.close();
      const delta = a.sync.changesSince({ "dev-a": before });
      expect(delta.changes.map((c) => [c.k, c.c, c.v]).sort()).toEqual([
        ['["p1","c1"]', "title", "Written elsewhere"],
        ['["p1","c2"]', "-", 0],
      ]);
      a.raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a table dropped and created again gets its triggers back on the next open", () => {
    const a = makeDevice("a");
    seed(a);
    a.raw.exec("DROP TABLE scenes; CREATE TABLE scenes (project_id TEXT NOT NULL, id TEXT NOT NULL, chapter_id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (project_id, id), FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE)");
    const again = makeDevice("a", { raw: a.raw, deviceId: "dev-a" });
    const before = again.sync.seq;
    again.db.exec("INSERT INTO scenes VALUES ('p1', 's9', 'c1', 0, 'New', 'Text.')");
    expect(again.sync.changesSince({ "dev-a": before }).changes.some((c) => c.k === '["p1","s9"]')).toBe(true);
  });

  it("a table without a primary key, or a missing table, is refused", () => {
    const a = makeDevice("a");
    a.db.exec("CREATE TABLE loose (x TEXT)");
    expect(() => makeDevice("a2", { raw: a.raw, tables: { loose: {} } })).toThrow(/no primary key/);
    expect(() => makeDevice("a3", { raw: a.raw, tables: { nothere: {} } })).toThrow(/doesn't exist/);
  });
});

describe("merging", () => {
  it("a new device receives the whole library", () => {
    const { a, b } = pair();
    expect(dump(b.db)).toEqual(dump(a.db));
    expect(b.sync.library).toBe(a.sync.library);
  });

  it("edits to different fields of one row are both kept", () => {
    const { a, b } = pair();
    a.db.exec("UPDATE scenes SET title = 'A title' WHERE id = 's1'");
    b.db.exec("UPDATE scenes SET position = 5 WHERE id = 's1'");
    exchange(a, b);
    const row = a.db.prepare("SELECT title, position FROM scenes WHERE id = 's1'").get();
    expect(row).toEqual({ title: "A title", position: 5 });
    expect(dump(a.db)).toEqual(dump(b.db));
  });

  it("the same field edited on both: the newer edit wins on both", () => {
    const { a, b } = pair();
    a.db.exec("UPDATE chapters SET title = 'From A' WHERE id = 'c1'");
    b.db.exec("UPDATE chapters SET title = 'From B' WHERE id = 'c1'");
    exchange(a, b);
    expect(a.db.prepare("SELECT title FROM chapters WHERE id = 'c1'").get().title).toBe("From B");
    expect(dump(a.db)).toEqual(dump(b.db));
  });

  it("text written on both devices merges: both edits survive", () => {
    const { a, b } = pair();
    a.db.exec("UPDATE scenes SET body = 'It was a dark and stormy night.' WHERE id = 's1'");
    b.db.exec("UPDATE scenes SET body = 'It was a dark night. Then the rain.' WHERE id = 's1'");
    exchange(a, b);
    const body = a.db.prepare("SELECT body FROM scenes WHERE id = 's1'").get().body;
    expect(body).toBe("It was a dark and stormy night. Then the rain.");
    expect(dump(a.db)).toEqual(dump(b.db));
  });

  it("a delete beats an older edit, and the children cascade on the other device too", () => {
    const { a, b } = pair();
    b.db.exec("UPDATE chapters SET title = 'Edited' WHERE id = 'c1'");
    a.db.exec("DELETE FROM projects WHERE id = 'p1'"); // cascades chapters and scenes on a
    exchange(a, b);
    expect(b.db.prepare("SELECT count(*) AS n FROM chapters").get().n).toBe(0);
    expect(b.db.prepare("SELECT count(*) AS n FROM projects").get().n).toBe(0);
    expect(dump(a.db)).toEqual(dump(b.db));
    expect(b.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("a row inserted again after a delete comes back", () => {
    const { a, b } = pair();
    a.db.exec("DELETE FROM chapters WHERE id = 'c2'");
    exchange(a, b);
    b.db.exec("INSERT INTO chapters VALUES ('p1', 'c2', 1, 'Two again')");
    exchange(a, b);
    expect(a.db.prepare("SELECT title FROM chapters WHERE id = 'c2'").get().title).toBe("Two again");
    expect(dump(a.db)).toEqual(dump(b.db));
  });

  it("blobs travel intact", () => {
    const { a, b } = pair();
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    a.db.prepare("INSERT INTO images VALUES ('i1', 'image/png', ?)").run(bytes);
    exchange(a, b);
    expect(Buffer.compare(b.db.prepare("SELECT data FROM images").get().data, bytes)).toBe(0);
  });

  it("a key change is a delete of the old row and an insert of the new", () => {
    const { a, b } = pair();
    a.db.exec("UPDATE chapters SET id = 'c9' WHERE id = 'c2'");
    exchange(a, b);
    expect(b.db.prepare("SELECT id FROM chapters ORDER BY id").all().map((r) => r.id)).toEqual(["c1", "c9"]);
  });

  it("nothing comes back to where it came from", () => {
    const { a, b } = pair();
    a.db.exec("UPDATE chapters SET title = 'x' WHERE id = 'c1'");
    exchange(a, b);
    expect(a.sync.changesSince(b.sync.vector()).changes).toEqual([]);
    expect(b.sync.changesSince(a.sync.vector()).changes).toEqual([]);
  });

  it("a third device that only talks to the second ends equal to the first", () => {
    const { a, b } = pair();
    const c = makeDevice("c");
    a.db.exec("UPDATE chapters SET title = 'via b' WHERE id = 'c2'");
    exchange(a, b);
    c.sync.apply(b.sync.changesSince(c.sync.vector()), { join: true });
    expect(dump(c.db)).toEqual(dump(a.db));
  });
});

describe("refusals", () => {
  it("another library is refused unless joining", () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    seed(a);
    expect(() => b.sync.apply(a.sync.changesSince({}))).toThrow(expect.objectContaining({ code: LIBRARY_MISMATCH }));
  });

  it("a newer schema is refused with a reason", () => {
    const a = makeDevice("a", { schemaVersion: 2 });
    const b = makeDevice("b", { schemaVersion: 1 });
    seed(a);
    expect(() => b.sync.apply(a.sync.changesSince({}), { join: true })).toThrow(expect.objectContaining({ code: SCHEMA_TOO_NEW }));
  });

  it("a stamp far in the future is refused and nothing is applied", () => {
    const { a, b } = pair();
    const batch = a.sync.changesSince({});
    batch.changes[0] = { ...batch.changes[0], s: `${"zzzzzzzzz"}-0000-dev-x` };
    const before = dump(b.db);
    expect(() => b.sync.apply(batch)).toThrow(expect.objectContaining({ code: CLOCK_DRIFT }));
    expect(dump(b.db)).toEqual(before);
  });
});

describe("devices", () => {
  it("a database opened under a new device id continues as a new device", () => {
    const { a, b } = pair();
    const copy = makeDevice("copy", { raw: b.raw, deviceId: "dev-copy" });
    expect(copy.sync.device).toBe("dev-copy");
    copy.db.exec("UPDATE chapters SET title = 'from the copy' WHERE id = 'c1'");
    exchange(a, copy);
    expect(a.db.prepare("SELECT title FROM chapters WHERE id = 'c1'").get().title).toBe("from the copy");
  });

  it("the clock keeps moving after a wrong-clock device's change", () => {
    const { a, b } = pair();
    setNow(Date.UTC(2026, 9, 8, 12, 0, 0) + 3600_000); // b an hour ahead
    b.db.exec("UPDATE chapters SET title = 'later' WHERE id = 'c1'");
    setNow(Date.UTC(2026, 9, 8, 12, 0, 10));
    exchange(a, b);
    a.db.exec("UPDATE chapters SET title = 'after seeing it' WHERE id = 'c1'");
    exchange(a, b);
    expect(b.db.prepare("SELECT title FROM chapters WHERE id = 'c1'").get().title).toBe("after seeing it");
  });
});
