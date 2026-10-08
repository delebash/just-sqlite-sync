// SPDX-License-Identifier: MIT
// The change file — one format for every way changes travel (by hand, a cloud folder, a backup).
//
//   8 bytes   "SQLSYNC1"
//   4 bytes   header length, big-endian
//   header    UTF-8 JSON: { format, app, library, schema, from, fromName, created, partial,
//             count, enc }  — readable without the key, so a file can be identified
//   body      gzip of UTF-8 JSON { vector, changes }; when enc is set, AES-256-GCM of that
//             with the header bytes as additional data (so the header can't be swapped)
//
// Only web-standard APIs (CompressionStream, WebCrypto), so Node and every webview make and read
// the same bytes. docs/file-format.md is the reference.

import { BAD_FILE, SyncError, WRONG_KEY } from "./errors.js";
import { concatBytes, fromBase64, fromBase64Url, randomBytes, toBase64, toBase64Url, utf8 } from "./bytes.js";

const MAGIC = utf8.encode("SQLSYNC1");

async function pipe(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const gzip = (b) => pipe(b, new CompressionStream("gzip"));
const gunzip = (b) => pipe(b, new DecompressionStream("gzip"));

/** A new library key: 32 random bytes as base64url text (what the pairing QR code carries). */
export function generateLibraryKey() {
  return toBase64Url(randomBytes(32));
}

async function importKey(keyText) {
  const raw = fromBase64Url(keyText);
  if (raw.length !== 32) throw new SyncError(WRONG_KEY, "a library key is 32 bytes");
  return globalThis.crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * A batch (from sync.changesSince) as file bytes.
 * @param {object} batch
 * @param {{ key?: string }} [opts] key: the library key — encrypt with it
 */
export async function encodeFile(batch, { key } = {}) {
  const body = await gzip(utf8.encode(JSON.stringify({ vector: batch.vector ?? {}, changes: batch.changes ?? [] })));
  const iv = key ? randomBytes(12) : null;
  const header = {
    format: batch.format ?? 1,
    app: batch.app,
    library: batch.library,
    schema: batch.schema,
    from: batch.from,
    fromName: batch.fromName ?? null,
    created: batch.created,
    partial: !!batch.partial,
    count: (batch.changes ?? []).length,
    enc: iv ? { alg: "AES-256-GCM", iv: toBase64(iv) } : null,
  };
  const headerBytes = utf8.encode(JSON.stringify(header));
  let payload = body;
  if (iv) {
    const k = await importKey(key);
    payload = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: headerBytes }, k, body));
  }
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, headerBytes.length);
  return concatBytes([MAGIC, len, headerBytes, payload]);
}

function split(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 12 || MAGIC.some((b, i) => u8[i] !== b)) throw new SyncError(BAD_FILE, "not a sync change file");
  const len = new DataView(u8.buffer, u8.byteOffset + 8, 4).getUint32(0);
  if (12 + len > u8.length) throw new SyncError(BAD_FILE, "the change file is cut short");
  const headerBytes = u8.subarray(12, 12 + len);
  let header;
  try {
    header = JSON.parse(utf8.decode(headerBytes));
  } catch {
    throw new SyncError(BAD_FILE, "the change file's header is damaged");
  }
  return { header, headerBytes, payload: u8.subarray(12 + len) };
}

/** The header of a change file, without decrypting it. */
export function readFileHeader(bytes) {
  return split(bytes).header;
}

/**
 * File bytes back to a batch for sync.apply.
 * @param {Uint8Array} bytes
 * @param {{ key?: string }} [opts]
 */
export async function decodeFile(bytes, { key } = {}) {
  const { header, headerBytes, payload } = split(bytes);
  let body = payload;
  if (header.enc) {
    if (!key) throw new SyncError(WRONG_KEY, "this change file is encrypted — it needs the library key", { library: header.library });
    try {
      const k = await importKey(key);
      body = new Uint8Array(
        await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(header.enc.iv), additionalData: headerBytes }, k, payload),
      );
    } catch (err) {
      if (err instanceof SyncError) throw err;
      throw new SyncError(WRONG_KEY, "the library key doesn't open this change file (a different library, or the file was changed)");
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(utf8.decode(await gunzip(body)));
  } catch {
    throw new SyncError(BAD_FILE, "the change file's contents are damaged");
  }
  const { enc, count, ...rest } = header;
  return { ...rest, vector: parsed.vector ?? {}, changes: parsed.changes ?? [] };
}
