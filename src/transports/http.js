// SPDX-License-Identifier: MIT
// Sync over HTTP with another device or a server — the same three routes on every side:
//   GET  <base>/hello   who it is: app, library, device, name, schema, vector
//   POST <base>/pull    { vector } → the changes the caller lacks
//   POST <base>/push    a batch → applied there
// Any server, any address: the same Wi-Fi, a Tailscale/ZeroTier address, a rented machine.
// Authentication is the server's own (a bearer token); this module only sends it.

import { LIBRARY_MISMATCH, PEER, SyncError } from "../errors.js";

/** The route bodies, independent of any web framework. */
export function createSyncHandlers(getSync, { onApplied } = {}) {
  const sync = () => (typeof getSync === "function" ? getSync() : getSync);
  return {
    hello() {
      const s = sync();
      return { app: s.app, library: s.library, device: s.device, name: s.deviceName, schema: s.schemaVersion, vector: s.vector() };
    },
    pull(body) {
      return sync().changesSince(body?.vector ?? {});
    },
    push(body) {
      const s = sync();
      const result = s.apply(body);
      s.recordPeer(body.from, { name: body.fromName ?? null, kind: "http" });
      onApplied?.(result);
      return result;
    },
  };
}

async function call(fetchImpl, url, init) {
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    throw new SyncError(PEER, `can't reach ${url}: ${err.message || err}`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = body?.message || body?.detail || text || res.statusText;
    throw new SyncError(body?.error || PEER, `${res.status} from ${url}: ${msg}`, { status: res.status });
  }
  return body;
}

/**
 * Sync with another device's or a server's routes: pull what this device lacks, then push what
 * the other side lacks.
 * @param {object} sync from openSync
 * @param {{ url: string, token?: string, fetch?: Function, join?: boolean, onApplied?: Function }} opts
 *   url: the routes' base, e.g. http://100.64.0.2:17495/v1/sync
 *   join: if the other side holds another library, this device joins it (pairing)
 */
export async function syncWithPeer(sync, { url, token, fetch: fetchImpl = globalThis.fetch, join = false, onApplied } = {}) {
  const base = String(url).replace(/\/+$/, "");
  const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const hello = await call(fetchImpl, `${base}/hello`, { headers });
  if (hello.app !== sync.app) throw new SyncError(LIBRARY_MISMATCH, `${base} is ${hello.app}, not ${sync.app}`);
  if (hello.library !== sync.library && !join) {
    throw new SyncError(LIBRARY_MISMATCH, `${hello.name || hello.device} holds another library — pair with it to join it`, { library: hello.library });
  }
  const batch = await call(fetchImpl, `${base}/pull`, { method: "POST", headers, body: JSON.stringify({ vector: sync.vector() }) });
  const pulled = sync.apply(batch, { join });
  onApplied?.(pulled);
  const outgoing = sync.changesSince(hello.vector);
  const pushed = await call(fetchImpl, `${base}/push`, { method: "POST", headers, body: JSON.stringify(outgoing) });
  sync.recordPeer(hello.device, { name: hello.name, kind: "http", info: { url: base } });
  return { peer: { device: hello.device, name: hello.name }, pulled, pushed: { sent: outgoing.changes.length, ...pushed } };
}
