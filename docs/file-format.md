<!-- SPDX-License-Identifier: MIT -->
# The change file (format 1)

One format for every way changes travel: a file carried by hand, a cloud folder's files, a backup.
Made by `encodeFile(batch, { key })`, read by `decodeFile(bytes, { key })`; the header alone by
`readFileHeader(bytes)`. Only web-standard APIs are used (`CompressionStream`, WebCrypto), so Node
and every webview make and read the same bytes.

## Layout

| Bytes | Content |
|---|---|
| 8 | ASCII `SQLSYNC1` |
| 4 | header length, unsigned big-endian |
| n | header: UTF-8 JSON (below) |
| rest | body: gzip of UTF-8 JSON `{ "vector": {…}, "changes": […] }`; when `enc` is set, the AES-256-GCM encryption of that gzip, with the header bytes as additional authenticated data |

## Header

```json
{
  "format": 1,
  "app": "justwrite",
  "library": "3f2a…",
  "schema": 4,
  "from": "9c1b…",
  "fromName": "Dan's laptop",
  "created": "2026-10-08T21:59:36.853Z",
  "partial": false,
  "count": 1832,
  "enc": { "alg": "AES-256-GCM", "iv": "<base64, 12 bytes>" }
}
```

`enc` is `null` for an unencrypted file. The header is readable without the key (so an app can say
"this file is from Dan's laptop, library …") but it can't be changed: it's authenticated with the
body, and decrypting fails if either was altered.

## Changes

```json
{ "t": "scenes", "k": "[\"p1\",\"s1\"]", "c": "title", "v": "Opening", "s": "0muzhi82g-0000-9c1b…", "o": "9c1b…", "n": 42 }
```

| Key | Meaning |
|---|---|
| `t` | table |
| `k` | the row's primary key: SQLite's `json_array(pk columns…)` text |
| `c` | column, or `-` for the row itself |
| `v` | the value. For `-`: `1` alive, `0` deleted. Strings, finite numbers and null as themselves; `{ "b": base64 }` a blob; `{ "i": "123" }` a big integer; `{ "f": "Infinity" }` a non-finite real; `{ "y": base64 }` a rich-text column's Yjs state |
| `s` | the stamp: `<ms base36, 9>-<counter base36, 4>-<device>` |
| `o`, `n` | origin device and its sequence number |

`vector` maps device id → the highest sequence the sender held; it's `{}` in a partial file.

## The library key

32 random bytes, written as base64url (43 characters) — what a pairing QR code carries. Made once
by `generateLibraryKey()` on the first device.
