# just-sqlite-sync

Sync for SQLite databases owned by one person and used on many devices — the family's sync engine
(`@delebash/sqlite-sync`, consumed as `file:../just-sqlite-sync`, never published). Plain
JavaScript ES modules (`.js` only, `"type": "module"`), no native code, no TypeScript.

- Guide: `README.md`. Reasoning, rejected alternatives, limits: `docs/design.md`. The file:
  `docs/file-format.md`. Open work: `docs/dev/TASKS.md`. Facts with proof: `docs/dev/RESEARCH.md`
  (read the subject's section before researching; new facts land there in the same change).
- The engine must stay usable on both adapters (better-sqlite3 and the SQLite WASM OO1 API): the
  adapter interface is in `src/adapters/better-sqlite3.js`. No Node-only import in `src/` except
  `src/transports/node-folder.js` and `src/transports/fastify.js` (their own export paths).
- Every change to merging, recording or vectors must keep `tests/convergence.test.js` and
  `tests/wasm.test.js` green; when touching them, also run thousands of seeds once
  (`tests/sim.js` → `runOnce(seed, steps)`).
- `npm test` and `npm run lint` pass before a commit. Every file carries an SPDX header.
