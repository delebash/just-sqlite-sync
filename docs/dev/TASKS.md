<!-- SPDX-License-Identifier: MIT -->
# TASKS — open work (just-sqlite-sync)

> One item per piece of open work; close = delete. The format: STATE (the decision, dated, the
> user's words) / WHY / NOT / BUILT / OPEN / GO. The product's decisions live in JustWrite's TASKS
> ("Sync — offline first, by file, folder and server"); the program is the kit's
> `docs/plans/2026-10-08-sync-and-quasar-program.md`.

## The phone side [2026-10-08]
STATE:  DECIDED 2026-10-08 (JustWrite TASKS item 7): the phone also saves its outgoing changes to
        the app's own native folder and rebuilds from them if needed; the cloud folder on the phone
        through signing in to OneDrive, then Dropbox (Google Drive later).
BUILT:  `oneDriveAppFolder`, `dropboxAppFolder` (tested against fakes of the two APIs),
        `folderSync(...).restore()` (the storage guard), `tests/phone` — the engine on SQLite WASM
        over OPFS, passing on the Android 16 emulator and the iOS 18.7 simulator (GitHub macOS).
OPEN:   a real sign-in against OneDrive
        and Dropbox needs app registrations under the user's accounts (an Azure app id, a Dropbox
        app key) — the stores take a token, the app does the sign-in.
GO:     given 2026-10-08 ("you have a go on it all your recs").

## Adoption by the apps [2026-10-08]
OPEN:   JustWrite first (its server side: the kit's program step S2), then JustVoice and docgen.
