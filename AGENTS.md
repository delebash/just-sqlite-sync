# just-sqlite-sync — instructions for any AI working in this repo

Sync for SQLite databases owned by one person and used on many devices — the family's sync engine
(`@delebash/sqlite-sync`, consumed as `file:../just-sqlite-sync`, never published). Plain
JavaScript ES modules (`.js` only, `"type": "module"`), no native code, no TypeScript.

- Guide: `README.md`. Reasoning, rejected alternatives, limits: `docs/design.md`. The file:
  `docs/file-format.md`. Open work: `docs/dev/TASKS.md`. Facts with proof: `docs/dev/RESEARCH.md`
  (read the subject's section before researching; new facts land there in the same change).
- The engine must stay usable on both adapters (better-sqlite3 and the SQLite WASM OO1 API): the
  adapter interface is in `src/adapters/better-sqlite3.js`. No Node-only import in `src/` except
  `src/transports/node-folder.js` and `src/transports/hono.js` (their own export paths).
- Every change to merging, recording or vectors must keep `tests/convergence.test.js` and
  `tests/wasm.test.js` green; when touching them, also run thousands of seeds once
  (`tests/sim.js` → `runOnce(seed, steps)`).
- `npm test` and `npm run lint` pass before a commit. Every file carries an SPDX header.

Claude Code reads this file through CLAUDE.md's `@AGENTS.md`; Codex, Cursor and the other tools read it
directly and follow no `@` imports — so it holds everything itself, the family rules included (the
family's design, the user, 2026-10-17).

---

## The family rules

A copy of the kit's `docs/family-rules.md`, kept identical by a check (`scripts/check-family.js`) — edit the
kit's file, never this copy.

<!-- family-rules:start -->
# Family rules

The rules every family repo follows: JustWrite, JustVoice, docgen and this kit. Each repo's
CLAUDE.md imports this file; a repo's own rules stay in its CLAUDE.md. How an app is laid out is
the kit's [`docs/app-structure.md`](https://github.com/delebash/just-core/blob/main/docs/app-structure.md)
§Q; the reference app is the kit's [`template/`](https://github.com/delebash/just-core/tree/main/template).

- **No hardcoded values a user might want to change.** Thresholds, limits, names and presets live
  in the database (seeded, editable in Settings), not in code, so changing one never needs a code
  change.
- **The server owns the data.** An app's data is one SQLite database that only its server reads
  and writes; the screen holds no durable data and asks the server. The desktop window, the
  browser tab of a headless server, the phone and other apps calling the API must all see the
  same data.
- **Nothing hand-rolled that Quasar or the kit ships.** The kit's `Ui*` controls sit on Quasar's
  components; apps use the `Ui*` API, and a shape the kit doesn't have uses Quasar's own component
  before anything hand-rolled. Before building a control, dialog, task or service, look in the kit
  (`packages/ui/src/index.js`, `packages/ui/src/common/index.js`, `packages/core/`), in the app's
  own `src/services/`, and for a screen that already has the same shape, and reuse it. A gap is
  filled in the kit so every app gets it. Copies drift and share bugs.
- **Code copied from another project keeps its licence notice** and gets an entry in the repo's
  `NOTICE.md`. MIT, Apache and BSD licences all require it.
- **Every AI engine and model goes through the kit, the way llama.cpp does.** Its builds are
  seeded rows, its models catalog rows in the kit's cache, its features routed by a preset, its
  graphics-card use booked with the kit's VRAM arbiter, its screens the kit's. An engine the kit
  doesn't have yet is a kit gap: it goes into the kit first and the app is built on it — never
  inside the app.
- **A fork is brought up to date before we work on it.** Before any work on a fork we keep (today
  our audio.cpp, github.com/delebash/audio.cpp; any fork a later app takes on), merge its upstream
  into our branch, build it, and test the merged build in the app that runs it — the real app on its
  real data (JustVoice: `npm run dev`) — then start the work. (The user, 2026-10-29: "before we do
  any work on audio cpp nextime we should update the fork and test it in our app … this should be
  true for any forks for futre apps that we may use".)
- **Modern ES modules everywhere.** `.js` files with standard `import` — app and kit code,
  scripts, tests and tools alike — never `require`, `createRequire`, `.mjs` or `.cjs`. The only
  CommonJS is what a platform forces, named with its doc: Electron's sandboxed preload
  (electronjs.org/docs/latest/tutorial/esm) and Capacitor's `.js` config
  (quasar.dev/quasar-cli-vite/developing-capacitor-apps/configuring-capacitor).
<!-- family-rules:end -->
