// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { BAD_FILE, WRONG_KEY, decodeFile, encodeFile, generateLibraryKey, readFileHeader } from "../src/index.js";
import { dump, makeDevice } from "./helpers.js";

function book() {
  const a = makeDevice("a");
  a.db.exec(`
    INSERT INTO projects VALUES ('p1', 'Ünïcödé — book', NULL);
    INSERT INTO scenes VALUES ('p1', 's1', 'c1', 0, 'Opening', 'It was a dark night. “Quotes” and emoji 🌧.');
  `);
  a.db.prepare("INSERT INTO images VALUES ('i1', 'image/png', ?)").run(Buffer.from([0, 255, 7]));
  return a;
}

describe("change files", () => {
  it("a whole library survives the file round trip and lands on a new device", async () => {
    const a = book();
    const bytes = await encodeFile(a.sync.changesSince({}));
    const header = readFileHeader(bytes);
    expect(header).toMatchObject({ app: "testapp", library: a.sync.library, from: "dev-a", partial: false, enc: null });
    const b = makeDevice("b");
    b.sync.apply(await decodeFile(bytes), { join: true });
    expect(dump(b.db)).toEqual(dump(a.db));
  });

  it("encrypted: opens with the library key, refuses without it or with another", async () => {
    const a = book();
    const key = generateLibraryKey();
    const bytes = await encodeFile(a.sync.changesSince({}), { key });
    expect(readFileHeader(bytes).enc.alg).toBe("AES-256-GCM");
    expect(new TextDecoder().decode(bytes)).not.toContain("dark night");
    const batch = await decodeFile(bytes, { key });
    expect(batch.changes.length).toBeGreaterThan(0);
    await expect(decodeFile(bytes)).rejects.toMatchObject({ code: WRONG_KEY });
    await expect(decodeFile(bytes, { key: generateLibraryKey() })).rejects.toMatchObject({ code: WRONG_KEY });
  });

  it("a changed header or body is refused", async () => {
    const a = book();
    const key = generateLibraryKey();
    const bytes = await encodeFile(a.sync.changesSince({}), { key });
    const tampered = bytes.slice();
    const at = new TextDecoder().decode(bytes).indexOf('"from":"dev-a"') + 10;
    tampered[at] = "x".charCodeAt(0); // dev-a → dxv-a in the header
    await expect(decodeFile(tampered, { key })).rejects.toMatchObject({ code: WRONG_KEY });
    const body = bytes.slice();
    body[body.length - 3] ^= 1;
    await expect(decodeFile(body, { key })).rejects.toMatchObject({ code: WRONG_KEY });
  });

  it("not a change file", async () => {
    await expect(decodeFile(new TextEncoder().encode("hello world, not ours"))).rejects.toMatchObject({ code: BAD_FILE });
  });

  it("a by-hand export of one book carries that book only, and doesn't advance vectors", async () => {
    const a = book();
    a.db.exec("INSERT INTO projects VALUES ('p2', 'Other', NULL)");
    const batch = a.sync.changesSince({}, { scope: (t, pk) => t !== "projects" || pk[0] === "p1" });
    expect(batch.partial).toBe(true);
    const b = makeDevice("b");
    b.sync.apply(await decodeFile(await encodeFile(batch)), { join: true });
    expect(b.db.prepare("SELECT id FROM projects").all()).toEqual([{ id: "p1" }]);
    expect(b.sync.vector()["dev-a"]).toBeUndefined();
    // importing it twice changes nothing
    const before = dump(b.db);
    b.sync.apply(await decodeFile(await encodeFile(batch)));
    expect(dump(b.db)).toEqual(before);
  });
});
