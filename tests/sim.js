// SPDX-License-Identifier: MIT
// The random three-device simulation the convergence test runs (and a debug script can replay).

import path from "node:path";
import { backupOf, exchange, fileDatabase, makeDevice, restore, rng, setNow } from "./helpers.js";

const WORDS = ["night", "rain", "door", "lamp", "Cael", "brass", "the", "and", "slowly", "red"];

export function randomOp(dev, r) {
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const db = dev.db;
  const projects = db.prepare("SELECT id FROM projects").all().map((x) => x.id);
  const p = projects.length ? pick(projects) : null;
  const roll = r();
  if (roll < 0.08 || !p) {
    db.prepare("INSERT OR IGNORE INTO projects VALUES (?, ?, ?)").run(pick(["p0", "p1", "p2"]), `Book ${Math.floor(r() * 100)}`, null);
  } else if (roll < 0.2) {
    db.prepare("INSERT OR REPLACE INTO chapters VALUES (?, ?, ?, ?)").run(p, pick(["c0", "c1", "c2", "c3"]), Math.floor(r() * 5), `Ch ${Math.floor(r() * 100)}`);
  } else if (roll < 0.34) {
    db.prepare("INSERT OR IGNORE INTO scenes VALUES (?, ?, ?, ?, ?, ?)").run(p, pick(["s0", "s1", "s2", "s3", "s4"]), "c0", 0, "Scene", `${pick(WORDS)} ${pick(WORDS)}.`);
  } else if (roll < 0.5) {
    const s = db.prepare("SELECT project_id, id, body FROM scenes").all();
    if (s.length) {
      const row = pick(s);
      const words = row.body.split(" ");
      const at = Math.floor(r() * (words.length + 1));
      if (r() < 0.7 || words.length < 2) words.splice(at, 0, pick(WORDS));
      else words.splice(Math.min(at, words.length - 1), 1);
      db.prepare("UPDATE scenes SET body = ? WHERE project_id = ? AND id = ?").run(words.join(" "), row.project_id, row.id);
    }
  } else if (roll < 0.62) {
    db.prepare("UPDATE chapters SET title = ?, position = ? WHERE id = ?").run(`T${Math.floor(r() * 1000)}`, Math.floor(r() * 9), pick(["c0", "c1", "c2", "c3"]));
  } else if (roll < 0.7) {
    db.prepare("UPDATE scenes SET title = ? WHERE id = ?").run(`S${Math.floor(r() * 1000)}`, pick(["s0", "s1", "s2", "s3", "s4"]));
  } else if (roll < 0.78) {
    db.prepare("DELETE FROM scenes WHERE id = ?").run(pick(["s0", "s1", "s2", "s3", "s4"]));
  } else if (roll < 0.84) {
    db.prepare("DELETE FROM chapters WHERE id = ?").run(pick(["c0", "c1", "c2", "c3"]));
  } else if (roll < 0.88) {
    db.prepare("DELETE FROM projects WHERE id = ?").run(p); // cascades
  } else if (roll < 0.91) {
    try {
      db.prepare("UPDATE chapters SET id = ? WHERE id = ?").run(pick(["c4", "c5"]), pick(["c0", "c1", "c2", "c3"]));
    } catch {
      // the new key exists: a refused edit, like any app would show
    }
  } else if (roll < 0.96) {
    db.prepare("INSERT OR REPLACE INTO images VALUES (?, ?, ?)").run(pick(["i0", "i1"]), "image/png", Buffer.from([Math.floor(r() * 256), 1, 2]));
  } else {
    db.prepare("UPDATE projects SET author = ? WHERE id = ?").run(r() < 0.5 ? null : `A${Math.floor(r() * 10)}`, p);
  }
}

export function settle(devs) {
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < devs.length; i++) for (let j = 0; j < devs.length; j++) if (i !== j) exchange(devs[i], devs[j]);
  }
}

export function runOnce(seed, steps) {
  setNow(Date.UTC(2026, 9, 8, 12, 0, 0));
  const r = rng(seed);
  const a = makeDevice("a");
  const b = makeDevice("b");
  const c = makeDevice("c");
  b.sync.joinLibrary(a.sync.library);
  c.sync.joinLibrary(a.sync.library);
  const devs = [a, b, c];
  for (let i = 0; i < steps; i++) {
    const d = devs[Math.floor(r() * 3)];
    randomOp(d, r);
    if (r() < 0.25) {
      const x = devs[Math.floor(r() * 3)];
      const y = devs[Math.floor(r() * 3)];
      if (x !== y) exchange(x, y);
    }
  }
  settle(devs);
  return devs;
}


/**
 * The restore stress run (JustVoice's narrowings review, P16): the random three-device simulation
 * above, on database files, with backups taken and restored at random on any device; then every
 * pair settles. `adversarial` adds what the review found the first design lost data on: a batch
 * another device made for the restored device's vector from before its restore, applied after it
 * (an exchange under way), and backups taken while edits were noted but not yet stamped.
 * Returns the devices (open — the caller closes them) and how many restores ran.
 */
export function runWithRestores(seed, steps, dir, { adversarial = false } = {}) {
  setNow(Date.UTC(2026, 9, 8, 12, 0, 0));
  const r = rng(seed * 7919);
  const devs = ["a", "b", "c"].map((n) => makeDevice(n, { raw: fileDatabase(path.join(dir, `${n}.db`)) }));
  devs[1].sync.joinLibrary(devs[0].sync.library);
  devs[2].sync.joinLibrary(devs[0].sync.library);
  const backups = [[], [], []];
  let restores = 0;
  for (let i = 0; i < steps; i++) {
    const k = Math.floor(r() * 3);
    randomOp(devs[k], r);
    if (r() < 0.25) {
      const x = devs[Math.floor(r() * 3)];
      const y = devs[Math.floor(r() * 3)];
      if (x !== y) exchange(x, y);
    }
    if (r() < 0.08) {
      const k2 = Math.floor(r() * 3);
      if (adversarial && r() < 0.5) {
        // an edit noted by the triggers and not yet stamped when the backup is taken
        devs[k2].raw.prepare("UPDATE chapters SET title = ? WHERE id = ?").run(`U${Math.floor(r() * 1000)}`, ["c0", "c1", "c2", "c3"][Math.floor(r() * 4)]);
      }
      backups[k2].push(backupOf(devs[k2], path.join(dir, `bk-${k2}-${i}.db`)));
    }
    if (r() < 0.06) {
      const k3 = Math.floor(r() * 3);
      if (backups[k3].length) {
        const bk = backups[k3][Math.floor(r() * backups[k3].length)];
        // an exchange under way: another device made its batch for the vector from before
        const other = adversarial && r() < 0.5 ? devs[(k3 + 1 + Math.floor(r() * 2)) % 3] : null;
        const early = other ? other.sync.changesSince(devs[k3].sync.vector()) : null;
        restore(devs[k3], path.join(dir, `${devs[k3].name}.db`), bk);
        if (early) devs[k3].sync.apply(early);
        restores++;
      }
    }
  }
  settle(devs);
  return { devs, restores };
}
