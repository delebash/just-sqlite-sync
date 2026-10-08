// SPDX-License-Identifier: MIT
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { folderSync, generateLibraryKey } from "../src/index.js";
import { nodeFolder } from "../src/transports/node-folder.js";
import { dump, exchange, makeDevice } from "./helpers.js";

const dirs = [];
function tempDir() {
  const d = mkdtempSync(path.join(tmpdir(), "sqlite-sync-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed(dev) {
  dev.db.exec(`
    INSERT INTO projects VALUES ('p1', 'Book', NULL);
    INSERT INTO chapters VALUES ('p1', 'c1', 0, 'One');
    INSERT INTO scenes VALUES ('p1', 's1', 'c1', 0, 'Opening', 'It was night.');
  `);
}

describe("folder sync", () => {
  it("desktop writes, tablet reads (the user's Dropbox case); edits flow both ways", async () => {
    const root = tempDir();
    const key = generateLibraryKey();
    const desk = makeDevice("desk");
    const tab = makeDevice("tab");
    tab.sync.joinLibrary(desk.sync.library);
    seed(desk);
    const fd = folderSync(desk.sync, nodeFolder(root), { key });
    const ft = folderSync(tab.sync, nodeFolder(root), { key });
    await fd.sync();
    await ft.sync();
    expect(dump(tab.db)).toEqual(dump(desk.db));
    tab.db.exec("UPDATE scenes SET body = 'It was night. Rain fell.' WHERE id = 's1'");
    await ft.sync();
    await fd.sync();
    expect(desk.db.prepare("SELECT body FROM scenes").get().body).toBe("It was night. Rain fell.");
    // each device wrote only in its own folder
    expect(readdirSync(path.join(root, desk.sync.library)).sort()).toEqual([desk.sync.device, tab.sync.device].sort());
  });

  it("relays changes a device got by another route", async () => {
    const root = tempDir();
    const a = makeDevice("a");
    const b = makeDevice("b");
    const c = makeDevice("c");
    b.sync.joinLibrary(a.sync.library);
    c.sync.joinLibrary(a.sync.library);
    seed(a);
    exchange(a, b); // a and b over HTTP; only b uses the folder
    await folderSync(b.sync, nodeFolder(root)).sync();
    await folderSync(c.sync, nodeFolder(root)).sync();
    expect(dump(c.db)).toEqual(dump(a.db));
  });

  it("a device that fell behind a compaction starts again from a snapshot", async () => {
    const root = tempDir();
    const a = makeDevice("a");
    const b = makeDevice("b");
    b.sync.joinLibrary(a.sync.library);
    seed(a);
    const fa = folderSync(a.sync, nodeFolder(root), { snapshotEvery: 3 });
    for (let i = 0; i < 10; i++) {
      a.db.prepare("UPDATE chapters SET title = ? WHERE id = 'c1'").run(`Title ${i}`);
      await fa.push();
    }
    const files = readdirSync(path.join(root, a.sync.library, a.sync.device));
    expect(files.filter((f) => f.startsWith("c-")).length).toBeLessThan(10);
    expect(files.filter((f) => f.startsWith("s-")).length).toBe(2);
    await folderSync(b.sync, nodeFolder(root)).pull();
    expect(dump(b.db)).toEqual(dump(a.db));
  });

  it("lists the libraries in a folder, for joining one", async () => {
    const root = tempDir();
    const a = makeDevice("Dan's laptop");
    seed(a);
    await folderSync(a.sync, nodeFolder(root)).push();
    const libs = await folderSync(makeDevice("phone").sync, nodeFolder(root)).libraries();
    expect(libs).toEqual([{ library: a.sync.library, devices: [expect.objectContaining({ device: a.sync.device, name: "Dan's laptop" })] }]);
  });
});
