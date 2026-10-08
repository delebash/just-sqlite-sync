// SPDX-License-Identifier: MIT
// The engine's errors. Each has a stable `code` an app can switch on to show the right words.

export class SyncError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** The batch or file belongs to another library (another set of devices). */
export const LIBRARY_MISMATCH = "library-mismatch";
/** The batch was made by a newer version of the app's schema; update the app on this device. */
export const SCHEMA_TOO_NEW = "schema-too-new";
/** A change carries a clock stamp too far in the future; the sending device's clock is wrong. */
export const CLOCK_DRIFT = "clock-drift";
/** A change file is damaged, not a change file, or needs a key this device doesn't have. */
export const BAD_FILE = "bad-file";
/** A change file is encrypted and the key given is wrong (or the file was tampered with). */
export const WRONG_KEY = "wrong-key";
/** The table list given to openSync can't be synced as configured. */
export const BAD_CONFIG = "bad-config";
/** A peer or folder answered something the engine can't use. */
export const PEER = "peer";
