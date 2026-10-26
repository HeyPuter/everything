# Live checks

Everything here needs live Puter (real accounts, a deployed origin or worker), a real third-party service or a real device. None of it can pass on `dev/fake-puter`. The task that raised each check is in brackets (task ids are in PLAN §4). Record evidence for the platform checks in [platform-verified.md](platform-verified.md).

Use two dedicated accounts (A owns, B joins; a third, C, where noted) and synthetic data only.

## Platform (F0)

- [ ] The ten F0 checks in [platform-verified.md](platform-verified.md). All gate the beta. Check 1 (KV shares, shipped 2026-10-25) gates `pathA`; checks 2–3 gate `directFiles` in `config.json`. [F0]
- [ ] Conditional put as shipped: `kv.set(key, value, expireAt, {onlyIfAbsent: true})` resolves `false` when a live entry holds the key, and two regions claiming one key before replication can both get `true` (F0 #1). `worker/engine/store.js` `setIfAbsent` is the only caller. [F5]
- [ ] `incr` with a path map returns the whole item. [F5, R6]
- [ ] A strong `fs.stat` with a restricted token, and `me.puter.appID` inside workers (proofs are pinned to it; AppData stat is the fallback). [F5]
- [ ] A `kv.list` cursor built from a key pages chat history (`worker/engine/scan.js`). [F5]
- [ ] Cross-region path writes to one item: merge or last writer wins. If last writer wins, fix the role-change-versus-removal and `idx` races in [handoffs.md](handoffs.md#open-lows-worker). [F5]
- [ ] `kv.update` creates a missing item (F0 #5); atlas marks and private items rely on it. [Q10]
- [ ] Choices the fake made where the docs are silent: share recipients are matched by username without regard to case, share listing cursors are offsets, and the legacy `/events/kv-handles` revoke answers like `unshare`. [F4]
- [ ] Not modelled by the fake: consent prompts other than `kvShare` (which it answers Allow), real JWTs, billing balances, eviction and CPU limits, streaming backpressure, the 60 s grace for a stopped handle covered by a wider share. [F4]
- [ ] `fs.read({uid})`, `fs.stat({uid})` and path writes into a shared inbox have the shapes the fake uses (F0 #3). [Q8]
- [ ] SDK write progress for large direct uploads (direct writes report none today). [Q8, Q13]
- [ ] `kv.flush()` is scoped to the app and `fs.readdir('.')` lists the app folder (Delete my data relies on both). [Q13]
- [ ] A path A client notices a lost change record through a revision gap or the next snapshot rebuild (F0 #1). [F5]
- [ ] From a worker's `me.puter`: `fs.getShares(path)` lists a shared folder's holders by their current username, and `fs.unshare(path, <unknown username>)` resolves `{revoked: 0}` instead of throwing (heyputer `/share/revoke` answers 200 with per-pair results). Member removal and maintenance rely on both. Deleting a shared folder ends the recipient's access. [SFIX M3]
- [ ] A hostname whose A record is a private address (`10.0.0.1`, `169.254.169.254`) cannot be fetched from the trip worker (link previews) or the events worker (webhooks). heyputer deploys both with `global_fetch_strictly_public`; nothing in the app can check the address a fetch reached. [SFIX M4]

## Deploy and launch config

- [ ] The deployed origin serves the `customHttp.yml` headers: no-cache on `/`, `*.html`, `/sw.js`, `/manifest.webmanifest`, `/config.json`, `/worker/*`; `text/javascript` on `sw.js`; `application/manifest+json` on the manifest; immutable `/assets/*`. [P11, H3]
- [ ] A's first trip deploys A's worker with a real `workers.create` (deploy stages, consent); an unverified owner gets `email_unverified`. [P1]
- [ ] `config.json` `minBuild` is set to the first released worker's `builtAt` before launch. [F5]
- [ ] A production build with `pathA: false` stays on path C; after F0 #1 passes, `pathA: true` moves members to handles. [Q8]

## Sharing and sync

- [ ] B joins A's trip by link and by username; B's Trips gets the `kv.share.received` notice (the Puter desktop shows nothing) and B accepts from Invitations. After B renames, an older named invite still joins. [P9, Q8]
- [ ] B on path A sees A's edits within a second without polling; after `kv.unshare` of B's read handle (which also stops the write handle), B keeps syncing on path C and returns to path A after renewal with two new handle ids. [Q8]
- [ ] A owner who declines the `kvShare` prompt still gets members joining on path C; a named invite then answers `share_consent_required` and the next try asks again. [Q8]
- [ ] Presence and badges survive a revoked write handle. [Q8]
- [ ] With `directFiles` on and a verified owner, B uploads and C downloads with no `/files` request; after C's folder share is removed, downloads still work. [Q8]
- [ ] Profile pictures through `puter.auth.getProfilePicture(username)`. [P9]
- [ ] Ownership transfer between two real accounts: deploy, owner inbox writes relative to AppData, `fs.read` of shared files (F0 #2–3). [R10]
- [ ] After A runs Delete my data, B's `heads` call to A's deleted worker fails with a 404 from the host (`worker_not_found`, or a 404 without a Trips error body), so B's dashboard shows A's trip as unavailable. If the platform answers otherwise (a network error, a 5xx), update `refreshHeads` in `src/views/dashboard/data.js`. [A1]

## Offline and PWA

- [ ] On the deployed origin: install, reload offline (shell and a kept trip open), and offline cold boot from the stored identity while the SDK script comes from the HTTP cache. [P11, shell]
- [ ] The update prompt across two tabs after a new deploy. [P11]
- [ ] Offline map tiles in Safari: MapLibre's blob worker must inherit the service worker; otherwise fall back to `addProtocol` reading `trips-map-v1`. [P11]

## Files and drive

- [ ] Attach from drive, save to drive and Save to Puter in Your data (`puter.ui` pickers). [P7, Q3, P1]
- [ ] Streamed-body upload progress on real networks. [P7]
- [ ] Journey "Photos near this entry" (`puter.ui.showDirectoryPicker`, ranged `fs.read`), the drive picker and quick capture with real geolocation. [R1]

## AI and mail

- [ ] `puter.ai.chat` with a PDF `puter_path` and `outputFormat` on Claude (F0 #9): booking import and PDF receipts. [Q4]
- [ ] `puter.perms.request` for `~/.mail` and `email.list/get` (F0 #8): booking import from Puter mail. [Q4]
- [ ] Assistant streaming and tool calls with a real model; `web_search` server-tool streaming is unverified. [Q5]
- [ ] Place AI summary and receipt OCR (with the `img2txt` fallback) on real models; a 402 shows the SDK's upgrade prompt next to the app's message. [Q11, Q12, Q4]

## Calendar, print and public links

- [ ] Subscribe to a trip feed in Apple Calendar, Google Calendar and Outlook. [Q1]
- [ ] Puter Calendar hand-off on the desktop (`puter.env === 'app'`): sign, launch, and the manual drop until Calendar reads launch items. [Q1]
- [ ] `/pub` and `/ics` answer without auth on a real worker (`x-puter-no-auth`, F0 #10), with ETag and 304 through the platform. [Q7, Q1]
- [ ] Print from iOS Safari prints the frame, not the whole page. [Q2]

## Maps and services

- [ ] Geo worker after deploy and `geo:config`: `GET /config` reports `limiter: "declared"`; routes stop showing "About"; opening hours and OSM-only place details appear. [F8, P2c, P3, Q11]
- [ ] Live provider acceptance: OpenFreeMap tiles, Photon, Nominatim, OSRM and Valhalla through the geo worker, MET Norway, NASA POWER, Frankfurter, Nager.Date, OpenHolidays, Openverse and Wikimedia. [F8, Q6]
- [ ] Road trip: Valhalla summary flags through the geo worker, Photon `include` with `highway.rest_area`/`highway.services`, the GDACS `geteventlist/SEARCH` shape, and the DWD WFS bbox axis order with `EPSG:4326`. [R4]
- [ ] Flight status: AeroDataBox on RapidAPI answers CORS preflights for `X-RapidAPI-Key`/`X-RapidAPI-Host` from `trips.puter.com`, and responses match the fixtures (`scheduledTime.{utc,local}`). [R8]
- [ ] Transitous, only if it is enabled: `/api/v1/plan` accepts `detailedTransfers=false`, reports `legGeometry.precision` and serves CORS. [R8]
- [ ] Pasted Google short links resolve through `puter.net.fetch`. [P2b]
- [ ] CoMaps links (`comaps.at/map`, `cm://route`, `cm://map`) open on a device. [P2b, P3]

## Notifications

- [ ] Publish the `tripsNotify` handler. [R6]
- [ ] B joins A's trip and turns on a webhook (webhook.site) and ntfy; A adds a booking → one signed request (check `Trips-Signature` with the secret) and one ntfy push. A's own edits send nothing to A. [R6]
- [ ] Send a test fills `me:notify:status.test`. [R6]
- [ ] Revoke `events:background`: Settings says so, and Allow background events asks again and recreates the subscriptions. [R6]
- [ ] Email digest on a paid plan; `user.email.sendTransactional` works from an events handler without `emailAccessToken`. [R6]
- [ ] `user.auth.getUser()` inside the events handler returns `email` and `email_confirmed`; email goes only to that address, at most 5 an hour. [SFIX M5]
- [ ] `kv.get([...], {handle})` batches inside the handler. [R6]

## Vacay

- [ ] Sharing asks for `kvShare` on `vacay:` at `read` once; `kv.share` with a username resolves `holder` as that username; `kv.share.received` reaches the other person's Vacay; a fused pair confirms both sides. [R3]
- [ ] Handle events with `includeValue`; batch `get` through a handle. [R3]
- [ ] `disableSharing` sticks on `update`/`remove` path writes. [R3]

## Integrations

- [ ] Real AirTrail, Immich and Dawarich servers through `puter.net.fetch`: auth headers, AirTrail v1 field names (`passengers` versus `seats`), Immich `localDateTime`, Dawarich visit fields and whether `/api/v1/users/me` exists, and servers on private networks (the relay cannot reach them). [R7]

## Live smoke (PLAN §6)

- [ ] With two real accounts: create, invite, join, edit, sync, file round trip, public link, ICS, and AI import in test mode. `tests/live/` (behind `PUTER_LIVE=1`) does not exist yet.
