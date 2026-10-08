// SPDX-License-Identifier: MIT
// Builds www/: the page, the worker bundled with the engine (esbuild), and the SQLite WASM binary
// beside the bundle (the WASM module finds it next to itself via import.meta.url).
import { copyFileSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("www", { recursive: true });
copyFileSync("src/index.html", "www/index.html");
copyFileSync("src/main.js", "www/main.js");
copyFileSync("node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm", "www/sqlite3.wasm");
await build({
  entryPoints: ["src/worker.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "www/worker.js",
  logLevel: "warning",
});
console.log("www/ built");
