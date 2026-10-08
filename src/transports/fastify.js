// SPDX-License-Identifier: MIT
// The three sync routes on a Fastify server. Authentication stays the app's (its bearer-token
// hook covers the prefix); a sync error answers 409 with { error, message } so the other side
// can show the reason.

import { SyncError } from "../errors.js";
import { createSyncHandlers } from "./http.js";

/**
 * @param {import("fastify").FastifyInstance} app
 * @param {object | (() => object)} getSync the sync object, or a function returning it (a server
 *   whose database opens after its routes are registered)
 * @param {{ prefix?: string, bodyLimit?: number, onApplied?: Function }} [opts]
 */
export function registerSyncRoutes(app, getSync, { prefix = "/v1/sync", bodyLimit = 1024 * 1024 * 1024, onApplied } = {}) {
  const h = createSyncHandlers(getSync, { onApplied });
  const guard = (fn) => async (req, reply) => {
    try {
      return await fn(req.body);
    } catch (err) {
      if (err instanceof SyncError) {
        reply.code(409);
        return { error: err.code, message: err.message };
      }
      throw err;
    }
  };
  app.get(`${prefix}/hello`, guard(() => h.hello()));
  app.post(`${prefix}/pull`, { bodyLimit }, guard((body) => h.pull(body)));
  app.post(`${prefix}/push`, { bodyLimit }, guard((body) => h.push(body)));
}
