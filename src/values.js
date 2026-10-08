// SPDX-License-Identifier: MIT
// SQL values ↔ JSON. Strings, finite numbers and null travel as themselves; the rest as a
// one-key object: { b: base64 } a blob, { i: "123" } a big integer, { f: "Infinity" } a
// non-finite real, { y: base64 } a Yjs state (rich-text columns only).

import { fromBase64, toBase64 } from "./bytes.js";

export function encodeValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : { f: String(v) };
  if (typeof v === "bigint") return { i: v.toString() };
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Uint8Array) return { b: toBase64(v) };
  if (v instanceof ArrayBuffer) return { b: toBase64(new Uint8Array(v)) };
  throw new TypeError(`can't sync a value of type ${Object.prototype.toString.call(v)}`);
}

export function decodeValue(v) {
  if (v === null || typeof v !== "object") return v;
  if ("b" in v) return fromBase64(v.b);
  if ("i" in v) return BigInt(v.i);
  if ("f" in v) return Number(v.f);
  throw new TypeError(`not a synced value: ${JSON.stringify(v)}`);
}
