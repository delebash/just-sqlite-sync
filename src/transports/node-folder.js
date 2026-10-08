// SPDX-License-Identifier: MIT
// A folder on disk as a folderSync store (Node / Electron) — a Dropbox or OneDrive folder that
// the service's own client keeps in step. Writes go to a .tmp file first and are renamed into
// place, so a half-written file is never seen (OneDrive's client also skips .tmp files).

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function nodeFolder(root) {
  const full = (p) => path.join(root, ...String(p).split("/").filter(Boolean));
  return {
    root,
    async list(dir) {
      try {
        return (await readdir(full(dir))).filter((n) => !n.endsWith(".tmp") && !n.startsWith("."));
      } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
      }
    },
    async read(p) {
      try {
        return new Uint8Array(await readFile(full(p)));
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },
    async write(p, bytes) {
      const target = full(p);
      await mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, target);
    },
    async remove(p) {
      await rm(full(p), { force: true });
    },
  };
}
