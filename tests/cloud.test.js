// SPDX-License-Identifier: MIT
// The OneDrive and Dropbox stores against in-memory fakes of the two APIs (the calls each store
// makes, answered the way the services document them), and the phone's storage guard.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dropboxAppFolder, folderSync, generateLibraryKey, oneDriveAppFolder } from "../src/index.js";
import { nodeFolder } from "../src/transports/node-folder.js";
import { dump, exchange, makeDevice } from "./helpers.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Microsoft Graph's app-folder calls, over a Map of path → bytes. */
function fakeGraph(files = new Map(), token = "ms-token") {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method ?? "GET"} ${u.pathname}`);
    if (u.host === "download.example") return new Response(files.get(decodeURIComponent(u.pathname.slice(1))));
    if (init.headers?.authorization !== `Bearer ${token}`) return json(401, { error: { code: "InvalidAuthenticationToken" } });
    const m = /\/me\/drive\/special\/approot(?::\/(.*?):)?(\/children|\/content)?$/.exec(decodeURIComponent(u.pathname));
    const p = m[1] ?? "";
    if (m[2] === "/children") {
      const prefix = p ? `${p}/` : "";
      const names = new Set();
      for (const k of files.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]);
      if (!names.size && p) return json(404, { error: { code: "itemNotFound" } });
      return json(200, { value: [...names].map((name) => ({ name })) });
    }
    if (m[2] === "/content" && init.method === "PUT") {
      files.set(p, new Uint8Array(await new Response(init.body).arrayBuffer()));
      return json(201, { name: p.split("/").pop() });
    }
    if (init.method === "DELETE") {
      if (!files.delete(p)) return json(404, { error: { code: "itemNotFound" } });
      return new Response(null, { status: 204 });
    }
    if (!files.has(p)) return json(404, { error: { code: "itemNotFound" } });
    return json(200, { id: p, "@microsoft.graph.downloadUrl": `https://download.example/${encodeURIComponent(p)}` });
  };
  return { files, calls, fetchImpl };
}

/** Dropbox's app-folder calls, over a Map of path → bytes (paths stored without the leading /). */
function fakeDropbox(files = new Map(), token = "db-token") {
  const fetchImpl = async (url, init = {}) => {
    if (init.headers?.authorization !== `Bearer ${token}`) return json(401, { error_summary: "invalid_access_token/" });
    const u = new URL(url);
    const route = u.pathname.replace(/^\/2\//, "");
    const arg = init.headers["dropbox-api-arg"] ? JSON.parse(init.headers["dropbox-api-arg"]) : JSON.parse(init.body);
    const p = String(arg.path ?? "").replace(/^\//, "");
    const notFound = () => json(409, { error_summary: "path/not_found/..", error: { ".tag": "path" } });
    if (route === "files/list_folder") {
      const prefix = p ? `${p}/` : "";
      const names = new Set();
      for (const k of files.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]);
      if (!names.size && p) return notFound();
      return json(200, { entries: [...names].map((name) => ({ name })), has_more: false, cursor: "c" });
    }
    if (route === "files/download") return files.has(p) ? new Response(files.get(p)) : notFound();
    if (route === "files/upload") {
      expect(arg.mode).toBe("overwrite");
      files.set(p, new Uint8Array(await new Response(init.body).arrayBuffer()));
      return json(200, { name: p.split("/").pop() });
    }
    if (route === "files/delete_v2") return files.delete(p) ? json(200, {}) : notFound();
    return json(400, { error_summary: `unknown route ${route}` });
  };
  return { files, fetchImpl };
}

function seed(dev) {
  dev.db.exec(`
    INSERT INTO projects VALUES ('p1', 'Book', NULL);
    INSERT INTO scenes VALUES ('p1', 's1', 'c1', 0, 'Opening', 'It was night.');
  `);
}

describe("cloud stores", () => {
  for (const [name, make, token] of [
    ["OneDrive", (f) => oneDriveAppFolder({ getToken: () => "ms-token", fetch: f.fetchImpl }), "ms"],
    ["Dropbox", (f) => dropboxAppFolder({ getToken: async () => "db-token", fetch: f.fetchImpl }), "db"],
  ]) {
    it(`${name}: a desktop and a phone sync through the app folder, encrypted`, async () => {
      const fake = token === "ms" ? fakeGraph() : fakeDropbox();
      const key = generateLibraryKey();
      const desk = makeDevice("desk");
      const phone = makeDevice("phone");
      phone.sync.joinLibrary(desk.sync.library);
      seed(desk);
      await folderSync(desk.sync, make(fake), { key }).sync();
      await folderSync(phone.sync, make(fake), { key }).sync();
      expect(dump(phone.db)).toEqual(dump(desk.db));
      phone.db.exec("UPDATE scenes SET body = 'It was night. The bus.' WHERE id = 's1'");
      await folderSync(phone.sync, make(fake), { key }).sync();
      await folderSync(desk.sync, make(fake), { key }).sync();
      expect(desk.db.prepare("SELECT body FROM scenes").get().body).toBe("It was night. The bus.");
      for (const bytes of fake.files.values()) expect(new TextDecoder().decode(bytes)).not.toContain("The bus");
    });
  }

  it("a wrong token surfaces as an error, not as an empty folder", async () => {
    const fake = fakeGraph();
    const store = oneDriveAppFolder({ getToken: () => "expired", fetch: fake.fetchImpl });
    await expect(store.list("x")).rejects.toThrow(/401/);
  });
});

describe("the phone's storage guard", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a wiped database is rebuilt from the device's own files, and keeps syncing correctly", async () => {
    const native = mkdtempSync(path.join(tmpdir(), "sqlite-sync-guard-"));
    dirs.push(native);
    const desk = makeDevice("desk");
    const phone = makeDevice("phone", { deviceId: "dev-phone" });
    phone.sync.joinLibrary(desk.sync.library);
    seed(desk);
    exchange(desk, phone);
    phone.db.exec("UPDATE scenes SET title = 'Written offline' WHERE id = 's1'");
    const guard = folderSync(phone.sync, nodeFolder(native));
    await guard.push(); // after each save
    // the webview's storage is cleared: a new, empty database under the same device id
    const reborn = makeDevice("phone", { deviceId: "dev-phone" });
    expect(await folderSync(reborn.sync, nodeFolder(native)).restore()).toBeGreaterThan(0);
    expect(reborn.db.prepare("SELECT title FROM scenes").get().title).toBe("Written offline");
    // its next change must reach the desktop (its sequence continued past the restored ones)
    reborn.db.exec("UPDATE scenes SET title = 'After the rebuild' WHERE id = 's1'");
    exchange(desk, reborn);
    expect(desk.db.prepare("SELECT title FROM scenes").get().title).toBe("After the rebuild");
  });
});
