// SPDX-License-Identifier: MIT
// The restore stress run's harder half (tests/sim.js runWithRestores, adversarial): on top of random
// edits, backups and restores on three devices, a batch another device made for the restored
// device's vector from before its restore is applied after it (an exchange under way), and backups
// are taken while edits are noted but not yet stamped — what the first restore design lost data on
// (JustVoice's narrowings review, P16). Its own file, so it runs beside restore.test.js.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restorePending } from "../src/index.js";
import { dump } from "./helpers.js";
import { runWithRestores } from "./sim.js";

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sync-inflight-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("restoring a backup: the stress run, with exchanges under way", () => {
  it("every run ends identical with nothing left to send (300 seeded runs)", () => {
    let restores = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const runDir = mkdtempSync(path.join(dir, "run-"));
      const { devs, restores: n } = runWithRestores(seed, 60, runDir, { adversarial: true });
      restores += n;
      try {
        const [da, db, dc] = devs.map((d) => dump(d.db));
        expect(db).toEqual(da);
        expect(dc).toEqual(da);
        for (const d of devs) {
          expect(d.raw.pragma("foreign_key_check")).toEqual([]);
          expect(restorePending(d.adapter)).toBe(false);
        }
        for (const x of devs) for (const y of devs) if (x !== y) expect(x.sync.changesSince(y.sync.vector()).changes).toEqual([]);
      } catch (err) {
        err.message = `seed ${seed}: ${err.message}`;
        throw err;
      } finally {
        for (const d of devs) d.raw.close();
      }
    }
    expect(restores).toBeGreaterThan(500);
  }, 600_000);

  it("the runs that once ended different: a parent's delete over a child brought back, a row's text across its lives", () => {
    // engine.test.js "merging: what the longer random runs found" (2026-10-15)
    for (const seed of [364, 526, 1236, 2162]) {
      const runDir = mkdtempSync(path.join(dir, "run-"));
      const { devs } = runWithRestores(seed, 60, runDir, { adversarial: true });
      try {
        const [da, db, dc] = devs.map((d) => dump(d.db));
        expect(db).toEqual(da);
        expect(dc).toEqual(da);
        for (const x of devs) for (const y of devs) if (x !== y) expect(x.sync.changesSince(y.sync.vector()).changes).toEqual([]);
      } catch (err) {
        err.message = `seed ${seed}: ${err.message}`;
        throw err;
      } finally {
        for (const d of devs) d.raw.close();
      }
    }
  });
});
