// SPDX-License-Identifier: MIT
// The hybrid logical clock. A stamp is one sortable string:
//   <ms since 1970, base 36, 9 chars>-<counter, base 36, 4 chars>-<device id>
// Comparing two stamps as strings orders them by time, then counter, then device — so no two
// devices ever produce equal stamps, and "the newer stamp wins" always has one answer.
// Receiving a stamp moves the local clock past it, so a device's next edit is newer than
// everything it has seen (causality survives wrong wall clocks, within the drift limit).

import { CLOCK_DRIFT, SyncError } from "./errors.js";

const MS_WIDTH = 9;
const CTR_WIDTH = 4;
const CTR_MAX = 36 ** CTR_WIDTH - 1;
export const DEFAULT_MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

export function formatStamp(ms, counter, deviceId) {
  return `${ms.toString(36).padStart(MS_WIDTH, "0")}-${counter.toString(36).padStart(CTR_WIDTH, "0")}-${deviceId}`;
}

export function parseStamp(stamp) {
  const s = String(stamp);
  const ms = Number.parseInt(s.slice(0, MS_WIDTH), 36);
  const counter = Number.parseInt(s.slice(MS_WIDTH + 1, MS_WIDTH + 1 + CTR_WIDTH), 36);
  const device = s.slice(MS_WIDTH + CTR_WIDTH + 2);
  if (!Number.isFinite(ms) || !Number.isFinite(counter) || s[MS_WIDTH] !== "-" || s[MS_WIDTH + CTR_WIDTH + 1] !== "-") {
    throw new SyncError("bad-stamp", `not a clock stamp: ${s}`);
  }
  return { ms, counter, device };
}

/**
 * @param {string} deviceId
 * @param {{ now?: () => number, maxDriftMs?: number }} [options]
 */
export function createClock(deviceId, { now = () => Date.now(), maxDriftMs = DEFAULT_MAX_DRIFT_MS } = {}) {
  let lastMs = 0;
  let counter = 0;

  function advanceTo(ms, ctr) {
    if (ms > lastMs || (ms === lastMs && ctr > counter)) {
      lastMs = ms;
      counter = ctr;
    }
  }

  return {
    /** The next stamp for a local change. */
    tick() {
      const t = now();
      if (t > lastMs) {
        lastMs = t;
        counter = 0;
      } else if (counter < CTR_MAX) {
        counter++;
      } else {
        lastMs++;
        counter = 0;
      }
      return formatStamp(lastMs, counter, deviceId);
    },
    /** Note a stamp from another device; refuses one too far in the future. */
    observe(stamp) {
      const p = parseStamp(stamp);
      const limit = now() + maxDriftMs;
      if (p.ms > limit) {
        throw new SyncError(
          CLOCK_DRIFT,
          `a change from device ${p.device} is stamped ${new Date(p.ms).toISOString()}, more than ${Math.round(maxDriftMs / 3600000)} h ahead of this device's clock — check that device's date and time`,
          { stamp, device: p.device },
        );
      }
      advanceTo(p.ms, p.counter);
    },
    /** Start from a stamp already stored (no drift check: it was accepted before). */
    seed(stamp) {
      if (!stamp) return;
      const p = parseStamp(stamp);
      advanceTo(p.ms, p.counter);
    },
    get deviceId() {
      return deviceId;
    },
  };
}
