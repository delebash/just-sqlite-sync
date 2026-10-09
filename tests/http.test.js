// SPDX-License-Identifier: MIT
import { serve as listen } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { LIBRARY_MISMATCH, syncWithPeer } from "../src/index.js";
import { registerSyncRoutes } from "../src/transports/hono.js";
import { dump, makeDevice } from "./helpers.js";

const servers = [];
async function serve(dev, { token } = {}) {
  const app = new Hono();
  if (token) {
    app.use("*", async (c, next) => {
      if (c.req.header("authorization") !== `Bearer ${token}`) return c.json({ message: "sign in" }, 401);
      await next();
    });
  }
  registerSyncRoutes(app, dev.sync);
  const server = await new Promise((resolve) => {
    const s = listen({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/v1/sync`;
}
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(() => resolve()));
  }
});

describe("HTTP sync", () => {
  it("a phone pairs with the laptop's server: joins its library, gets the book, sends its edits", async () => {
    const laptop = makeDevice("laptop");
    laptop.db.exec("INSERT INTO projects VALUES ('p1', 'Book', NULL); INSERT INTO chapters VALUES ('p1', 'c1', 0, 'One');");
    const url = await serve(laptop, { token: "t0ken" });
    const phone = makeDevice("phone");
    await expect(syncWithPeer(phone.sync, { url, token: "t0ken" })).rejects.toMatchObject({ code: LIBRARY_MISMATCH });
    const r = await syncWithPeer(phone.sync, { url, token: "t0ken", join: true });
    expect(r.peer.name).toBe("laptop");
    expect(dump(phone.db)).toEqual(dump(laptop.db));
    phone.db.exec("UPDATE chapters SET title = 'Written on the bus' WHERE id = 'c1'");
    await syncWithPeer(phone.sync, { url, token: "t0ken" });
    expect(laptop.db.prepare("SELECT title FROM chapters").get().title).toBe("Written on the bus");
    expect(laptop.sync.peers().map((p) => p.name)).toContain("phone");
  });

  it("a wrong token is a clear error", async () => {
    const laptop = makeDevice("laptop");
    const url = await serve(laptop, { token: "right" });
    await expect(syncWithPeer(makeDevice("phone").sync, { url, token: "wrong", join: true })).rejects.toThrow(/401/);
  });
});
