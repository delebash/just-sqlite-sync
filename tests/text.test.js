// SPDX-License-Identifier: MIT
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { diffText, plainTextAdapter } from "../src/text.js";
import { rng } from "./helpers.js";

function applyOps(a, ops) {
  let out = "";
  let pos = 0;
  for (const [op, s] of ops) {
    if (op === 0) {
      expect(a.slice(pos, pos + s.length)).toBe(s);
      out += s;
      pos += s.length;
    } else if (op < 0) {
      expect(a.slice(pos, pos + s.length)).toBe(s);
      pos += s.length;
    } else out += s;
  }
  expect(pos).toBe(a.length);
  return out;
}

describe("diffText", () => {
  it("always turns a into b, and keeps what didn't change (1000 random pairs)", () => {
    const r = rng(7);
    const alpha = "abc de.";
    const word = (n) => Array.from({ length: n }, () => alpha[Math.floor(r() * alpha.length)]).join("");
    for (let i = 0; i < 1000; i++) {
      const a = word(Math.floor(r() * 60));
      let b = a;
      for (let e = 0; e < 1 + Math.floor(r() * 4); e++) {
        const at = Math.floor(r() * (b.length + 1));
        b = r() < 0.5 ? b.slice(0, at) + word(1 + Math.floor(r() * 5)) + b.slice(at) : b.slice(0, at) + b.slice(at + 1 + Math.floor(r() * 4));
      }
      expect(applyOps(a, diffText(a, b))).toBe(b);
    }
  });

  it("an edit at both ends keeps the middle", () => {
    const ops = diffText("rain lamp.", "and rain lamp. the");
    expect(ops).toEqual([
      [1, "and "],
      [0, "rain lamp."],
      [1, " the"],
    ]);
  });

  it("falls back to replacing the middle past the size limit, still correct", () => {
    expect(applyOps("abcdef", diffText("abcdef", "uvwxyz", 2))).toBe("uvwxyz");
  });
});

describe("plainTextAdapter", () => {
  it("merges two devices' edits to the same text", () => {
    const ad = plainTextAdapter();
    const base = new Y.Doc();
    ad.apply(base, "rain lamp.");
    const s = Y.encodeStateAsUpdate(base);
    const a = new Y.Doc();
    Y.applyUpdate(a, s);
    const b = new Y.Doc();
    Y.applyUpdate(b, s);
    ad.apply(a, "and rain lamp. the");
    ad.apply(b, "rain");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(ad.render(a)).toBe("and rain the");
  });
});
