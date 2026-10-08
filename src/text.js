// SPDX-License-Identifier: MIT
// Rich-text columns. The column keeps the app's own value (plain text, HTML, …); beside it the
// engine keeps a Yjs document, so edits from two devices to the same column merge edit by edit
// instead of one replacing the other.
//
// An app gives one adapter per kind of column:
//   apply(doc, value)  change the Y.Doc so it represents `value`, by the smallest difference
//   render(doc)        the column value the Y.Doc represents
// `plainTextAdapter()` below is the one for plain text; a ProseMirror/TipTap adapter (HTML through
// y-prosemirror's updateYFragment) lives with the app that knows its editor schema.

import * as Y from "yjs";
import { hash52 } from "./bytes.js";

/**
 * The edits turning `a` into `b`: [op, text] with op 0 keep, -1 delete, 1 insert. Myers'
 * O((N+M)·D) diff on the part between the common start and end; an edit larger than `maxD`
 * characters falls back to replacing that middle whole (still correct, only coarser).
 */
export function diffText(a, b, maxD = 2000) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  let mid = myers(A, B, maxD);
  if (!mid) mid = [...(A ? [[-1, A]] : []), ...(B ? [[1, B]] : [])];
  return [...(start ? [[0, a.slice(0, start)]] : []), ...mid, ...(endA < a.length ? [[0, a.slice(endA)]] : [])];
}

function myers(A, B, maxD) {
  const N = A.length;
  const M = B.length;
  if (!N) return M ? [[1, B]] : [];
  if (!M) return [[-1, A]];
  const max = Math.min(N + M, maxD);
  const off = max + 1;
  const V = new Int32Array(2 * max + 3).fill(-1);
  V[off + 1] = 0;
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(V.slice(off - d - 1, off + d + 2)); // V after step d-1, for k in [-d-1, d+1]
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      V[off + k] = x;
      if (x >= N && y >= M) return backtrack(trace, d, A, B);
    }
  }
  return null;
}

function backtrack(trace, D, A, B) {
  const ops = [];
  let x = A.length;
  let y = B.length;
  for (let d = D; d > 0; d--) {
    const v = trace[d];
    const at = (k) => v[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    const startX = down ? prevX : prevX + 1;
    while (x > startX) {
      ops.push([0, A[x - 1]]);
      x--;
      y--;
    }
    if (down) ops.push([1, B[prevY]]);
    else ops.push([-1, A[prevX]]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push([0, A[x - 1]]);
    x--;
    y--;
  }
  ops.reverse();
  const out = [];
  for (const [op, ch] of ops) {
    const last = out[out.length - 1];
    if (last && last[0] === op) last[1] += ch;
    else out.push([op, ch]);
  }
  return out;
}

/** Plain text in a Y.Text, changed by the smallest character difference. */
export function plainTextAdapter(name = "text") {
  return {
    apply(doc, value) {
      const text = doc.getText(name);
      const before = text.toString();
      const after = value == null ? "" : String(value);
      if (before === after) return;
      doc.transact(() => {
        let pos = 0;
        for (const [op, s] of diffText(before, after)) {
          if (op === 0) pos += s.length;
          else if (op < 0) text.delete(pos, s.length);
          else {
            text.insert(pos, s);
            pos += s.length;
          }
        }
      });
    },
    render(doc) {
      return doc.getText(name).toString();
    },
  };
}

function docFrom(state) {
  const doc = new Y.Doc();
  if (state && state.length) Y.applyUpdate(doc, state);
  return doc;
}

/** The engine's Yjs operations for one adapter. `deviceClientId` names this device's edits. */
export function textOps(adapter, deviceClientId) {
  return {
    /**
     * The Yjs state after the column took `value`. With no earlier state the document starts
     * from a client id derived from the content itself, so two devices that hold the same
     * initial text (a bundled sample, a copied database) produce the same state and merging
     * them changes nothing.
     */
    fromValue(prevState, value, seedKey) {
      const doc = docFrom(prevState);
      doc.clientID = prevState && prevState.length ? deviceClientId : hash52(`${seedKey}\u0000${value ?? ""}`);
      adapter.apply(doc, value);
      return Y.encodeStateAsUpdate(doc);
    },
    render(state) {
      return adapter.render(docFrom(state));
    },
    merge(a, b) {
      return Y.mergeUpdates([a, b]);
    },
    /** Do two states hold the same edits (insertions and deletions)? */
    same(a, b) {
      return Y.equalSnapshots(Y.snapshot(docFrom(a)), Y.snapshot(docFrom(b)));
    },
  };
}
