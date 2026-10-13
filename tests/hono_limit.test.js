// SPDX-License-Identifier: MIT
// The sync routes on Hono refuse a body over the limit through Hono's body-limit middleware: 413,
// thrown as the app's own refusal so its error answer shapes it.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerSyncRoutes } from "../src/transports/hono.js";
import { makeDevice } from "./helpers.js";

function appWith(bodyLimit) {
  const dev = makeDevice("server");
  const app = new Hono();
  app.onError((err, c) => c.json({ detail: err.message }, err.statusCode ?? 500));
  registerSyncRoutes(app, dev.sync, { bodyLimit });
  return app;
}

describe("the sync routes' body limit", () => {
  it("refuses a body over the limit with 413", async () => {
    const r = await appWith(16).request("/v1/sync/pull", { method: "POST", body: JSON.stringify({ vector: { x: 123456789 } }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(413);
    expect((await r.json()).detail).toBe("Request body is too large");
  });

  it("takes a body under it", async () => {
    const r = await appWith(1024 * 1024).request("/v1/sync/pull", { method: "POST", body: JSON.stringify({ vector: {} }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(200);
  });
});
