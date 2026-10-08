// SPDX-License-Identifier: MIT
// Cloud folders reached through their own web APIs — for a phone, where the service's sync client
// doesn't keep a folder on disk. Each is a folderSync store ({ list, read, write, remove }) rooted
// at the service's app folder: the app's own folder in the user's account (OneDrive
// `Apps/<app>`, Dropbox `Apps/<app>`), which the desktop sees as a plain folder on disk.
//
// Signing in is the app's: pass `getToken()` returning a current access token (sign-in in the
// system browser with PKCE; scopes Files.ReadWrite.AppFolder / Dropbox "App folder" access).
// The API facts these follow are in docs/dev/RESEARCH.md "Cloud APIs".

import { PEER, SyncError } from "../errors.js";

const segs = (p) => String(p).split("/").filter(Boolean).map(encodeURIComponent).join("/");

async function fail(res, what) {
  const text = await res.text().catch(() => "");
  throw new SyncError(PEER, `${what}: ${res.status} ${text.slice(0, 300)}`, { status: res.status });
}

/**
 * OneDrive's app folder through Microsoft Graph.
 * @param {{ getToken: () => Promise<string> | string, fetch?: Function, base?: string }} opts
 */
export function oneDriveAppFolder({ getToken, fetch: fetchImpl = globalThis.fetch, base = "https://graph.microsoft.com/v1.0" }) {
  const item = (p) => (segs(p) ? `${base}/me/drive/special/approot:/${segs(p)}:` : `${base}/me/drive/special/approot`);
  const auth = async () => ({ authorization: `Bearer ${await getToken()}` });
  return {
    kind: "onedrive",
    async list(dir) {
      const names = [];
      let url = `${item(dir)}/children?$select=name&$top=999`;
      while (url) {
        const res = await fetchImpl(url, { headers: await auth() });
        if (res.status === 404) return [];
        if (!res.ok) await fail(res, `OneDrive list ${dir}`);
        const body = await res.json();
        for (const v of body.value ?? []) if (!String(v.name).endsWith(".tmp")) names.push(v.name);
        url = body["@odata.nextLink"] ?? null;
      }
      return names;
    },
    async read(p) {
      // /content answers with a redirect a browser can't follow under CORS: ask for the item's
      // pre-signed download URL instead and fetch that (no Authorization header).
      const res = await fetchImpl(`${item(p)}?$select=id,@microsoft.graph.downloadUrl`, { headers: await auth() });
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, `OneDrive read ${p}`);
      const meta = await res.json();
      const dl = meta["@microsoft.graph.downloadUrl"];
      if (!dl) throw new SyncError(PEER, `OneDrive gave no download URL for ${p}`);
      const file = await fetchImpl(dl);
      if (!file.ok) await fail(file, `OneDrive download ${p}`);
      return new Uint8Array(await file.arrayBuffer());
    },
    async write(p, bytes) {
      // simple upload: files up to 250 MB; replaces an existing file whole
      const res = await fetchImpl(`${item(p)}/content`, {
        method: "PUT",
        headers: { ...(await auth()), "content-type": "application/octet-stream" },
        body: bytes,
      });
      if (!res.ok) await fail(res, `OneDrive write ${p}`);
    },
    async remove(p) {
      const res = await fetchImpl(item(p), { method: "DELETE", headers: await auth() });
      if (!res.ok && res.status !== 404) await fail(res, `OneDrive delete ${p}`);
    },
  };
}

// Dropbox-API-Arg is an HTTP header: JSON with every non-ASCII character escaped.
const headerJson = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const notFound = (text) => /not_found/.test(text);

/**
 * Dropbox's App Folder through the Dropbox API (paths are relative to the app folder; "" is it).
 * @param {{ getToken: () => Promise<string> | string, fetch?: Function, api?: string, content?: string }} opts
 */
export function dropboxAppFolder({
  getToken,
  fetch: fetchImpl = globalThis.fetch,
  api = "https://api.dropboxapi.com/2",
  content = "https://content.dropboxapi.com/2",
}) {
  const path = (p) => (segs(p) ? `/${String(p).split("/").filter(Boolean).join("/")}` : "");
  const auth = async () => ({ authorization: `Bearer ${await getToken()}` });
  const rpc = async (route, arg) =>
    fetchImpl(`${api}/${route}`, { method: "POST", headers: { ...(await auth()), "content-type": "application/json" }, body: JSON.stringify(arg) });
  return {
    kind: "dropbox",
    async list(dir) {
      const names = [];
      let res = await rpc("files/list_folder", { path: path(dir) });
      for (;;) {
        if (res.status === 409) {
          const t = await res.text();
          if (notFound(t)) return [];
          throw new SyncError(PEER, `Dropbox list ${dir}: ${t.slice(0, 300)}`);
        }
        if (!res.ok) await fail(res, `Dropbox list ${dir}`);
        const body = await res.json();
        for (const e of body.entries ?? []) if (!String(e.name).endsWith(".tmp")) names.push(e.name);
        if (!body.has_more) return names;
        res = await rpc("files/list_folder/continue", { cursor: body.cursor });
      }
    },
    async read(p) {
      const res = await fetchImpl(`${content}/files/download`, {
        method: "POST",
        headers: { ...(await auth()), "dropbox-api-arg": headerJson({ path: path(p) }) },
      });
      if (res.status === 409) {
        const t = await res.text();
        if (notFound(t)) return null;
        throw new SyncError(PEER, `Dropbox read ${p}: ${t.slice(0, 300)}`);
      }
      if (!res.ok) await fail(res, `Dropbox read ${p}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async write(p, bytes) {
      // files/upload: up to 150 MiB; overwrite replaces the file whole
      const res = await fetchImpl(`${content}/files/upload`, {
        method: "POST",
        headers: {
          ...(await auth()),
          "content-type": "application/octet-stream",
          "dropbox-api-arg": headerJson({ path: path(p), mode: "overwrite", autorename: false, mute: true }),
        },
        body: bytes,
      });
      if (!res.ok) await fail(res, `Dropbox write ${p}`);
    },
    async remove(p) {
      const res = await rpc("files/delete_v2", { path: path(p) });
      if (res.status === 409) {
        const t = await res.text();
        if (notFound(t)) return;
        throw new SyncError(PEER, `Dropbox delete ${p}: ${t.slice(0, 300)}`);
      }
      if (!res.ok) await fail(res, `Dropbox delete ${p}`);
    },
  };
}
