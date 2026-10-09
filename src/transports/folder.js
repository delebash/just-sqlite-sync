// SPDX-License-Identifier: MIT
// Sync through a shared folder — a Dropbox/OneDrive folder on a desktop, or a cloud API's app
// folder on a phone. Nothing in the folder is ever written by two devices: each device writes
// only inside its own subfolder and reads everyone else's (one shared file is how folder sync
// goes wrong — two writers, one file, a conflict copy).
//
//   <library>/<device>/device.json       who it is, when it last wrote
//   <library>/<device>/c-<n>.sqs         its n-th change file: everything it held that its
//                                        files 1…n-1 didn't (its own changes and those it got
//                                        from other devices by other routes — so the folder
//                                        relays them too)
//   <library>/<device>/s-<n>.sqs         a snapshot of the whole library as of its file n
//
// A reader applies a device's files in order. Every `snapshotEvery` files a device writes a
// snapshot and deletes the change files the previous snapshot covers; a reader that fell behind
// starts again from the newest snapshot. The live database is never in the folder.
//
// `store` is any object with: list(dir) → names ([] when missing) · read(path) → bytes | null ·
// write(path, bytes) (atomic) · remove(path). nodeFolder() in ./node-folder.js is the desktop one.

import { utf8 } from "../bytes.js";
import { PEER, SyncError } from "../errors.js";
import { decodeFile, encodeFile } from "../file.js";

const pad = (n) => String(n).padStart(10, "0");
const CHANGE = /^c-(\d+)\.sqs$/;
const SNAPSHOT = /^s-(\d+)\.sqs$/;

function parseNames(names) {
  const changes = [];
  const snapshots = [];
  for (const name of names) {
    let m = CHANGE.exec(name);
    if (m) changes.push({ name, n: Number(m[1]) });
    else if ((m = SNAPSHOT.exec(name))) snapshots.push({ name, n: Number(m[1]) });
  }
  changes.sort((a, b) => a.n - b.n);
  snapshots.sort((a, b) => a.n - b.n);
  return { changes, snapshots };
}

/**
 * @param {object} sync from openSync
 * @param {object} store the folder (see above)
 * @param {{ key?: string, snapshotEvery?: number, name?: string }} [opts]
 *   key: the library key — every file is encrypted with it (the folder is on someone else's disk)
 *   name: what to call this folder in the devices list ("Dropbox")
 *   state: the prefix of this folder's progress in the engine's state (`folder.fileNo`, …) — a second
 *   folder on the same device (the phone's storage guard beside its cloud folder) takes its own
 */
export function folderSync(sync, store, { key, snapshotEvery = 100, name = "folder", state = "folder" } = {}) {
  const dir = () => `${sync.library}/${sync.device}`;

  async function writeDeviceInfo() {
    const info = { device: sync.device, name: sync.deviceName, app: sync.app, updated: new Date().toISOString() };
    await store.write(`${dir()}/device.json`, utf8.encode(JSON.stringify(info)));
  }

  async function writeSnapshot() {
    const n = sync.getState(`${state}.fileNo`) ?? 0;
    await store.write(`${dir()}/s-${pad(n)}.sqs`, await encodeFile(sync.changesSince({}), { key }));
    // keep this snapshot and the one before it, and the change files after that one
    const { changes, snapshots } = parseNames(await store.list(dir()));
    const keepFrom = snapshots.length >= 2 ? snapshots[snapshots.length - 2].n : 0;
    for (const s of snapshots.slice(0, -2)) await store.remove(`${dir()}/${s.name}`);
    for (const c of changes) if (c.n <= keepFrom) await store.remove(`${dir()}/${c.name}`);
    sync.setState(`${state}.sinceSnapshot`, 0);
  }

  /** Write what this device holds that its earlier files didn't. */
  async function push() {
    const batch = sync.changesSince(sync.getState(`${state}.pushVector`) ?? {});
    let written = 0;
    if (batch.changes.length) {
      const n = (sync.getState(`${state}.fileNo`) ?? 0) + 1;
      await store.write(`${dir()}/c-${pad(n)}.sqs`, await encodeFile(batch, { key }));
      sync.setState(`${state}.fileNo`, n);
      sync.setState(`${state}.sinceSnapshot`, (sync.getState(`${state}.sinceSnapshot`) ?? 0) + 1);
      written = batch.changes.length;
    }
    sync.setState(`${state}.pushVector`, batch.vector);
    if ((sync.getState(`${state}.sinceSnapshot`) ?? 0) >= snapshotEvery) await writeSnapshot();
    await writeDeviceInfo();
    return { written };
  }

  async function readFile(path) {
    const bytes = await store.read(path);
    if (!bytes) throw new SyncError(PEER, `${path} vanished while syncing — try again`);
    return decodeFile(bytes, { key });
  }

  /** Apply every other device's files this device hasn't read yet. */
  async function pull() {
    const out = { applied: 0, devices: 0, problems: [], tables: new Set() };
    for (const other of await store.list(sync.library)) {
      if (other === sync.device) continue;
      const odir = `${sync.library}/${other}`;
      const { changes, snapshots } = parseNames(await store.list(odir));
      let read = sync.getState(`${state}.read.${other}`) ?? 0;
      const next = changes.find((c) => c.n > read);
      const newest = snapshots[snapshots.length - 1];
      if (newest && newest.n > read && (!next || next.n > read + 1)) {
        // the files after where this device stopped were compacted away: start from the snapshot
        collect(out, sync.apply(await readFile(`${odir}/${newest.name}`)));
        read = newest.n;
        sync.setState(`${state}.read.${other}`, read);
      }
      for (const c of changes) {
        if (c.n <= read) continue;
        if (c.n !== read + 1) break; // a gap: wait for that device's next snapshot
        collect(out, sync.apply(await readFile(`${odir}/${c.name}`)));
        read = c.n;
        sync.setState(`${state}.read.${other}`, read);
      }
      let deviceName = null;
      const info = await store.read(`${odir}/device.json`);
      if (info) {
        try {
          deviceName = JSON.parse(utf8.decode(info)).name ?? null;
        } catch {
          // a damaged device.json only loses the name
        }
      }
      sync.recordPeer(other, { name: deviceName, kind: "folder", info: { folder: name } });
      out.devices++;
    }
    return { ...out, tables: [...out.tables] };
  }

  function collect(out, r) {
    out.applied += r.applied;
    out.problems.push(...r.problems);
    for (const t of r.tables) out.tables.add(t);
  }

  return {
    push,
    pull,
    /** Read everyone else's files, then write this device's. */
    async sync() {
      const pulled = await pull();
      const pushed = await push();
      return { pulled, pushed };
    },
    writeSnapshot,
    /**
     * Rebuild this device's database from its own files (the phone's storage guard: the files
     * were also written to the app's native folder, which the webview's storage pressure can't
     * clear). Applies its newest snapshot and the change files after it. Returns the number of
     * files applied, or null when this folder holds nothing of this device.
     */
    async restore() {
      // This device may have files in more than one library (it started one, then joined
      // another): the one it wrote to last — its device.json's `updated` — is the library it's in.
      let lib = null;
      let newest = "";
      for (const l of await store.list("")) {
        if (!(await store.list(l)).includes(sync.device)) continue;
        let updated = "";
        try {
          const bytes = await store.read(`${l}/${sync.device}/device.json`);
          updated = bytes ? String(JSON.parse(utf8.decode(bytes)).updated ?? "") : "";
        } catch {
          // no readable device.json: the oldest possible
        }
        if (lib === null || updated > newest) {
          lib = l;
          newest = updated;
        }
      }
      if (!lib) return null;
      if (lib !== sync.library) sync.joinLibrary(lib);
      const { changes, snapshots } = parseNames(await store.list(dir()));
      let read = 0;
      let files = 0;
      const snap = snapshots[snapshots.length - 1];
      if (snap) {
        sync.apply(await readFile(`${dir()}/${snap.name}`));
        read = snap.n;
        files++;
      }
      for (const c of changes) {
        if (c.n <= read) continue;
        sync.apply(await readFile(`${dir()}/${c.name}`));
        read = c.n;
        files++;
      }
      sync.setState(`${state}.fileNo`, Math.max(read, sync.getState(`${state}.fileNo`) ?? 0));
      sync.setState(`${state}.pushVector`, sync.vector());
      return files;
    },
    /** The libraries in this folder and their devices — for "join the library in this folder". */
    async libraries() {
      const out = [];
      for (const lib of await store.list("")) {
        const devices = [];
        for (const dev of await store.list(lib)) {
          const info = await store.read(`${lib}/${dev}/device.json`);
          try {
            if (info) devices.push(JSON.parse(utf8.decode(info)));
          } catch {
            // not a device folder
          }
        }
        if (devices.length) out.push({ library: lib, devices });
      }
      return out;
    },
    /** Remove a device's files (a device the user retired). Never this device's own. */
    async removeDevice(id) {
      if (id === sync.device) throw new SyncError(PEER, "a device can't remove itself");
      const odir = `${sync.library}/${id}`;
      for (const n of await store.list(odir)) await store.remove(`${odir}/${n}`);
    },
  };
}
