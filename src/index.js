// SPDX-License-Identifier: MIT
// @delebash/sqlite-sync — sync for SQLite databases owned by one person and used on many
// devices. README.md is the guide; docs/design.md the reasoning; docs/file-format.md the file.
// Node-only pieces have their own entry points: "@delebash/sqlite-sync/node-folder" (a folder on
// disk) and "@delebash/sqlite-sync/hono" (the routes on an app's Hono server).

export { openSync, FORMAT_VERSION } from "./engine.js";
export { createClock, formatStamp, parseStamp } from "./clock.js";
export { plainTextAdapter } from "./text.js";
export { encodeFile, decodeFile, readFileHeader, generateLibraryKey } from "./file.js";
export { betterSqlite3Adapter } from "./adapters/better-sqlite3.js";
export { sqliteWasmAdapter } from "./adapters/sqlite-wasm.js";
export { folderSync } from "./transports/folder.js";
export { oneDriveAppFolder, dropboxAppFolder } from "./transports/cloud.js";
export { createSyncHandlers, syncWithPeer } from "./transports/http.js";
export {
  SyncError,
  LIBRARY_MISMATCH,
  SCHEMA_TOO_NEW,
  CLOCK_DRIFT,
  BAD_FILE,
  WRONG_KEY,
  BAD_CONFIG,
  PEER,
} from "./errors.js";
