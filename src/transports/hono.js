// SPDX-License-Identifier: MIT
// The three sync routes on an app's Hono server. Authentication stays the app's (its bearer-token
// middleware covers the prefix); a sync error answers 409 with { error, message } so the other
// side can show the reason.
//
// The routes are added to the app's own Hono instance (`app.get/post`), and this package creates
// no Hono of its own — an app has one Hono (two copies would answer errors differently).

import { SyncError } from "../errors.js";
import { createSyncHandlers } from "./http.js";

/** A body too large: the server's own refusal (413, `{ detail }` through the app's error answer). */
export const tooLarge = () => Object.assign(new Error("Request body is too large"), { statusCode: 413 });

/** A JSON body as plain JSON: empty → undefined. An app passes its own reader (`readJson`) to keep
 * its rules for bodies with no content type or bad JSON. */
export async function plainJson(c) {
  const text = await c.req.text();
  return text === "" ? undefined : JSON.parse(text);
}

/**
 * @param {object} app the app's Hono instance
 * @param {object | (() => object)} getSync the sync object, or a function returning it (a server
 *   whose database opens after its routes are added)
 * @param {{ prefix?: string, bodyLimit?: number, onApplied?: Function, readJson?: (c) => Promise<any> }} [opts]
 */
export function registerSyncRoutes(app, getSync, { prefix = "/v1/sync", bodyLimit = 1024 * 1024 * 1024, onApplied, readJson = plainJson } = {}) {
  const h = createSyncHandlers(getSync, { onApplied });
  const guard = (fn) => async (c) => {
    if (Number(c.req.header("content-length") ?? 0) > bodyLimit) throw tooLarge();
    try {
      return c.json(await fn(await readJson(c)));
    } catch (err) {
      if (err instanceof SyncError) return c.json({ error: err.code, message: err.message }, 409);
      throw err;
    }
  };
  app.get(`${prefix}/hello`, guard(() => h.hello()));
  app.post(`${prefix}/pull`, guard((body) => h.pull(body)));
  app.post(`${prefix}/push`, guard((body) => h.push(body)));
}
