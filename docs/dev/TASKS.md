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
OPEN:   the cloud stores (OneDrive app folder, Dropbox App Folder) as `folderSync` stores; the
        restore-from-own-files call; the iOS storage test on GitHub's macOS runners.
GO:     given 2026-10-08 ("you have a go on it all your recs").

## Adoption by the apps [2026-10-08]
OPEN:   JustWrite first (its server side: the kit's program step S2), then JustVoice and docgen.
