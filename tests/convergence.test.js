// SPDX-License-Identifier: MIT
// The engine's central promise: whatever three devices do, in whatever order they sync, they end
// identical. Random inserts, edits, deletes, cascades, re-inserts, key changes and text edits on
// a small shared id space (so they collide), random pairwise syncs, then everyone syncs until
// nothing moves — every seeded run must end with three equal databases and clean foreign keys.

import { describe, expect, it } from "vitest";
import { dump } from "./helpers.js";
import { runOnce } from "./sim.js";

describe("convergence", () => {
  it("three devices end identical, whatever they did and however they synced (300 seeded runs)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const devs = runOnce(seed, 40);
      const [da, db, dc] = devs.map((d) => dump(d.db));
      try {
        expect(db).toEqual(da);
        expect(dc).toEqual(da);
        for (const d of devs) expect(d.db.pragma("foreign_key_check")).toEqual([]);
        // and nothing left to send between any two of them
        for (const x of devs) for (const y of devs) if (x !== y) expect(x.sync.changesSince(y.sync.vector()).changes).toEqual([]);
      } catch (err) {
        err.message = `seed ${seed}: ${err.message}`;
        throw err;
      }
    }
  });
});
