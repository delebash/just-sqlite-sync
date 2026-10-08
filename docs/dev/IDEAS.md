<!-- SPDX-License-Identifier: MIT -->
# Ideas (unscheduled — adding one never starts it)

- **Many users and permissions** — per-user scopes on the server's pull route; the change format
  already carries origins. Out of scope by the 2026-10-08 decision ("Left out until wanted").
- **Partial replication** — a phone holding only the books it uses; scoped vectors per book.
- **Tombstone clean-up** — delete markers stay forever (small); once every known device's vector
  covers a marker, it could go.
- **Fractional positions** — a list reordered on two devices at once can end with equal positions;
  a fractional index per row (cr-sqlite's "fract" column) would keep both orders.
- **Live sync** — a WebSocket push between devices on the same network instead of polling.
