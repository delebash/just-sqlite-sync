// SPDX-License-Identifier: MIT
// Byte helpers that work the same on Node and in a webview (no Buffer required).

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((ch, i) => [ch, i]));

export function toBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  let i = 0;
  for (; i + 2 < u8.length; i += 3) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = u8.length - i;
  if (rest === 1) {
    const n = u8[i] << 16;
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8);
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}${B64[(n >> 6) & 63]}=`;
  }
  return out;
}

export function fromBase64(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_INDEX.get(clean[i]) ?? 0;
    const b = B64_INDEX.get(clean[i + 1]) ?? 0;
    const c = B64_INDEX.get(clean[i + 2]);
    const d = B64_INDEX.get(clean[i + 3]);
    const n = (a << 18) | (b << 12) | ((c ?? 0) << 6) | (d ?? 0);
    out[o++] = (n >> 16) & 255;
    if (c !== undefined && o < out.length) out[o++] = (n >> 8) & 255;
    if (d !== undefined && o < out.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
  return fromBase64(String(text).replace(/-/g, "+").replace(/_/g, "/"));
}

export const utf8 = {
  encode: (s) => new TextEncoder().encode(s),
  decode: (b) => new TextDecoder().decode(b),
};

/** Random bytes from the platform's crypto (Node ≥ 19 and every webview have globalThis.crypto). */
export function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** A random id: `bytes` random bytes as lowercase hex. */
export function randomId(bytes = 8) {
  return [...randomBytes(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A 52-bit hash of a string (two FNV-1a passes), as a safe integer. Used for Yjs client ids,
 * which must be the same for the same input on every device and must not collide in practice.
 */
export function hash52(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  // 32 bits of h1 + 20 bits of h2 = 52 bits; never 0 (Yjs treats client ids as plain numbers).
  return (h1 * 0x100000 + (h2 & 0xfffff)) || 1;
}

export function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
