# Known gaps and test hooks

What is not built or only partly built, per area, and the hooks tests drive. Conformance results and fixed bugs are in [test-sprint.md](test-sprint.md); checks that need live Puter or real services in [live-checks.md](live-checks.md); client contracts in [src/lib/README.md](../src/lib/README.md); keys and protocol in [data-model.md](data-model.md).

## Running checks

```sh
cd src/trips && npm ci
npm test && npm run build          # build runs check:licenses first
npm run test:e2e                   # builds the worker and dist-mock/, serves mock.html on base+4
npm run test:e2e:bridge            # isolated contexts on one Node-side fake world
npm run test:e2e:client            # real Chromium IndexedDB fixture on base+3
npm run test:e2e:map               # WebGL map fixture on base+5, intercepted styles and tiles
node tools/i18n-check.mjs          # locale files against English
```

`TRIPS_E2E_PORT_BASE` (default 5300) moves the Playwright servers so parallel runs use separate ranges (`tools/e2e-ports.mjs`); the dev server is 5301. Point `PLAYWRIGHT_BROWSERS_PATH` at an existing Chromium or run `npx playwright install chromium`. No check talks to live Puter or a third-party service.

## Test infrastructure

- **Fake runtime** (`dev/fake-puter`): `createFakePuter({users, regions: 1|2, shareHandles, onlyIfAbsent (default on, checked per region; `false` models a server that ignores it), replicationDelay, now, latency, enforceRateLimits, maxHandles, ai})` and `world.client(username, region, {appUid, worker})`. KV shares follow the shipped API (`dev/fake-puter/shares.js`, platform.md); app mints need `world.grantShareConsent(as, prefix, access)` or `client.perms.request('kvShare', …)`, which the fake answers Allow unless `denyPermissions(as)`. World controls: `registerWorker`, `grantShareConsent`, `revokeShareConsent`, `denyPermissions`, `configureUser(as, {paid, email_confirmed, temporary, refusesShares, blocks})`, `counters()`/`resetCounters()`, `failNext({method, as, code, status, times})`, `setOffline(as)`, `advance(ms)`, `flushReplication()`, `flushEvents()`, `flushWorkers()`, `inspectKv()`, `fs.getShares(path)`, `renameUser(as, name)`, `removeUser()`, `removeApp()`. Not modelled: persistence across reloads, consent prompts other than `kvShare`, real JWTs, billing balances, eviction and CPU limits, streaming backpressure, `puter.ui` pickers, `puter.net`, `puter.email`, `puter.peer`, `events.onPersistent`, `getMonthlyUsage`.
- **Scripted AI** (`dev/fake-puter/ai.js`, on in `mock.html`): built-in replies for booking import, place summaries, receipts, photo stop names and the assistant; `world.ai.script({kind, match, reply, times})`, `world.ai.fail('credit'|'usage'|'auth'|'offline'|'failed')`, `world.ai.calls()`. In the page: `?ai=off|credit|…` and `window.__TRIPS_AI__`.
- **Bridge**: `createTestBridgeHost(world)` plus `attachFakePuterContext(host, context, {as, region})` gives isolated Playwright contexts one Node-side world. `tests/e2e/helpers/bridge-world.js` (`bridgeWorld`, `sharedTrip`, `audit`, `capture`, `noOverflow`) is the starting point for two-user specs; its contexts abort every non-local request. The bridge follows full page loads and in-app hash navigation; anything else ends the session (`bridge_stale_document`). The in-page `mock.html` world resets on every load.
- **`mock.html`**: `as=alice|bob|carol`, `state=A|C`, `files=direct|proxied`, `cas=0|1`, `regions=1|2`, `offline=0|1`, `reset=1`, `sw=1`, `ai=…`, `fixture=large` (sets `data-fixture=ready`, exposes `__TRIPS_FIXTURE__ = {ref, callers, fixture}`), `lang=<tag>`, `lang=en-XA` (pseudo-locale), `dir=rtl`. `globalThis.trips` (`dev/mock-trips.js`) drives the real deployer and worker: `createTrip`, `invite`, `join`, `open`, `create`, `patch(…, {base: true})`, `putPrivate`, `get`, `list`, `conflicts`, `state`, `access`, `flush` (sends everything pending), `sync`, `members`, `call(ref, op, input)`. `__TRIPS_MOCK__` has `failNext` and `setOffline`.
- **Unit helpers** (`tests/unit/helpers/`): `stub-worker.js` (light worker double), `fake-ai.js` (AI, fs staging, perms, mail, `memoryDb`), `fake-net.js` (recorded `puter.net.fetch`), `fake-peer.js`, `fake-caches.js`, `zip-writer.js` (PKPass fixtures), `costs-space.js`, `exif-jpeg.js`. `tests/worker/harness.js` runs the real worker on the fake runtime with the real `cred.js` and `api.js`; cost budgets are asserted from its counters.
- **Reset and injection hooks**: `resetDirect()` (files), `resetUnfurlCache()` and `resetAllFeedCache()` (worker), `resetLinkPreviews()`, `resetJobs()` and `resetNotices()` (transfer), `startReminders({now, zone, locks: null})`, `context.assistantChat`, `context.photoChat`, `createCatalogStore({locks})`, the vault store's `snapshot()`.
- **Conventions**: row controls carry `data-focus="<kind>:<id>"` (focus returns there after a re-render); trip tabs carry `data-tab`; cards and rows carry `data-id` or a module key (`data-trip`, `data-day`, `data-date`). Per-device UI state lives in `localStorage` under `trips:*`. The shell's `.app-sync .save-state` reads `synced` only when no queued change is pending; uploads run outside the queue, so wait for their own row.

## Open lows (worker)

- **Role change vs removal**: both are path writes on `sp:<id>:m:<uuid>`. If cross-region writes are last-writer-wins per item, a role change in one region can undo a removal from another. Fix if the live check shows that: a separate removal key read in the same batched get.
- **`idx` race**: a cross-region path write to `idx` can drop a space id (members then get `space_not_found`). Mitigated: the owner's requests re-add a live space and clients retry `space_not_found` for 2 minutes. Open: let member requests re-check the space doc at a low rate.
- A captured request can be replayed within the 5-minute proof window; commit `opId`s keep writes idempotent and other ops are idempotent or rate-limited.
- A path A client notices a lost change record only through a revision gap or the next snapshot rebuild's re-announcement.
- **Before release**: set `config.json` `minBuild` to the first released worker's `builtAt` (proofs went to version 2 without overlap).

## Shell, dashboard, settings, offline

- Dashboard archived state, tags, cover, members and bookings come from the local replica (`heads` carries title, dates and role), so they are as fresh as the last sync on this device. `me:spaces` cannot clear dates. Hero stats (trips, travel days, distance flown) are on the Atlas page only.
- `createServices` gets no user API keys (ORS, Geoapify, Unsplash); flight status passes its key per call.
- Not built: custom map style URL ([2]); a `#/help` page (help is a palette drawer); `watchAirtrail` on every tab (Bookings only); a `notificationclick` handler in `sw.js`.
- Settings → AI hides the `assistantApproval` choices: the assistant always asks. The reduced-motion override can only force reduced motion.
- Offline: kept trips' non-media files are cached (`trips-files-<uuid>`); `fileBlob` reads them back while offline or when the network read fails (not on 403/404). Thumbnails and media are not kept. The SDK script comes from the HTTP cache on an offline cold start. Glyphs beyond Latin, Greek and Cyrillic are cached only once seen online; trips without coordinates get no tiles.
- The vault and catalog re-read before writing, but KV has no conditional put, so a small window remains.
- Offline: kept trips' non-media files are cached (`trips-files-<uuid>`) but nothing reads them back yet (`readCachedFile` in `src/lib/offline/files.js` has no caller), so attachments still need the network. The SDK script comes from the HTTP cache on an offline cold start. Glyphs beyond Latin, Greek and Cyrillic are cached only once seen online; trips without coordinates get no tiles.
- The vault and catalog re-read before writing, but KV has no compare-and-set (`onlyIfAbsent` only guards creation), so a small window remains.
- No e2e yet for the credit, outdated and gone banners or the two-tab update prompt.
- Hooks: `data-trip` on dashboard cards, `.trip-unread`, the "Trip actions" button, `.app-nav-more`, `.delete-plan`, `.delete-step[data-state]`, `.week-day[data-date]`, `.help-topic[data-topic]`, `.tab-order-row[data-tab]`; keys `trips:dash-filter`, `trips:dash-view`, `trips:fx`, `trips:clocks`, `trips:forceOffline`, `trips:identity`.

## Plan, places, map, scheduling, weather, road trip, transit, Plan B

- Routing and OSM details need the geo worker: until `config.json` sets `geoWorker`, every route is a straight-line estimate ("About"), and opening hours and OSM facts are missing (Wikidata places still get descriptions and photos).
- Planner: day removal is not undoable; no per-day stored start time (one per trip per device); auto schedule keeps the order and only warns; loose bookings get no position, so a visit pushed past a booking can swap rows; travel connectors show only between two located visits.
- Places: pasted Google short links need `puter.net.fetch` (live); the CoMaps link format is unverified on a device.
- Map: location follow is one-shot; endpoint labels are text; Apple and CoMaps day links use the first and last stop only; marker glyphs are a symbol layer on the map wrapper's source (re-added on `style.load`).
- Weather: no per-date archive for past days (normals instead); regions without an ISO 3166-2 code are chosen by hand, one per country per trip, per device.
- Road trip: times are wall-clock per day (zone changes during a drive are not applied); no toll amounts; no per-leg alternative geometry; vias only from search results; mpg and miles not offered; two members creating settings at once park a 409 for the second; MobiData BW not built.
- Transit: Transitous is off in `config.json` until its operators agree (Google and Apple links only); one connector at a time.
- Plan B: alternative stops are edited in the Plan B dialog only; the public projection carries alternative visits (the viewer hides them).
- Hooks: `.plan-day[data-day]`, `.plan-row`, `data-focus` `row:|grip:|dayGrip:|day:|chip:<id>`, `.plan-impact`, `.plan-next`, commands `plan-undo|plan-redo|plan-next-day|plan-previous-day|plan-add-day`; `.wx-head|.wx-info|.wx-chip|.wx-panel`; `.road-day[data-day]`, `.road-node[data-key][data-kind]`, `.road-leg[data-leg]`, map layers `trips-road-*`; `.alt-chip`, `.alt-dialog`; helpers in `tests/e2e/helpers/{plan,providers}.js`.

## Bookings, costs, lists

- Bookings: the worker does not check participant ids against members and guests; flight status shows on the Bookings tab only (RapidAPI only, no other AeroDataBox resellers).
- Booking import: background mail capture (`me:import:*`) is not built; HEIC is refused; EML and HTML sources are not attached (the files allowlist refuses them); the cost estimate is a request count, not a price.
- Booking moves need a connection to both trips; Undo deletes a copied place unless something in the target uses it.
- Costs: display-currency totals use live rates (marked ≈); a split across trips does not follow later edits (drift warning); budgets count shared expenses only; receipts are images only (PDF would need `puter_path`).
- Lists: no cross-list drag (use the item dialog); reorder is off while a filter is on.
- Hooks: `tests/unit/{bookings,costs}-view.test.js` stub spaces; `.move-notice[data-move]`; `.cx-due`, `.cx-budget`, `.cx-currencies`, `data-focus` `bycur|budget|due:<id>`; `trips:costs:*` and `trips:lists:<spaceId>` keys.

## Files, collab, members, public link, path A

- Files: the owner downloads its own files through its worker; thumbnails only for images the browser decodes; object URLs last one session; an upload fails quietly if the trip closes mid-upload; videos get no poster and play after a full download; direct writes report no progress.
- Chat: soft-deleted messages vanish from chat (only Activity says so); image-only messages need a schema change (text is required); link previews are in chat only. Notes and link chips load the site's own favicon. Emptied reaction keys still count toward the 50-key cap. Feed filters apply to the loaded 100 entries.
- Members: invite links are shown once (only the hash is stored); expiry is absolute, so a device clock off by days answers `invalid_expiry`; profile pictures are best effort (initials in the fake). The join page shows trip role hints for collection and journey invites. Seats from `invite.list` are not shown, and the UI does not explain `inboxHold`.
- Public link: place photos and attachment thumbnails are not inline (downloads only); other share managers cannot copy a link minted on another device; collections keep the older projection rules.
- Path A: the dashboard reads `heads`, not each trip's `sig`; per-user fields in member regions are not started; feature flags are read when a space opens; renewing re-shares a grant the holder revoked while they keep using Trips. Production keeps `pathA` and `directFiles` off until the live checks pass.
- Hooks: `.chat-msg[data-id]`, `.chat-input`, `.chat-preview-card`, `button.poll-option[aria-pressed]`, `.feed-entry.is-new`, `.feed-filter`; `data-focus` `member:|guest:|invite:|perm:<id>` and `share:<toggle>|create|copy|rotate|off|exp|cur`; `.invite-url`, `.share-url`, `.inbox-button`; `createFilesView({container, space, app})`; `globalThis.trips.access(ref)`; helpers in `tests/e2e/helpers/{public-viewer,spaces,trip-flows}.js`.

## Imports and exports, calendars, print, assistant, integrations, transfer

- Imports: undoing an import leaves its uploaded track files behind; a retried import after a partial apply can duplicate items; dropping a file outside the drop zone lets the browser open it; exported GPX positions have no times.
- Calendars: Puter Calendar does not read launch items, so the hand-off opens it and asks for a drop; no per-member reminder lead times; the all-trips feed learns of new trips when Trips syncs it.
- Print: page numbers need margin-box support (Chromium); iOS Safari may print the whole page; photos come only from places of visits; map pictures are not cached between openings.
- Assistant: every write waits for approval; no edits or deletes of existing entities, no web search; map lookups for new places run one at a time; the conversation is not saved.
- Integrations: AirTrail write-back is per leg with a local journal; private-network servers are unreachable through the relay.
- Transfer: the new owner cannot stop a running move until it pauses; daily budgets can pause a large move; member entities are not imported (rejoin needed within 30 days); the old copy's public link and ICS feeds serve the frozen trip until it is deleted.
- Hooks: `buildExport(context, {format, scope})`; `.io-item`, `.io-summary`, `.io-error`; `.ics-dialog`, `[data-ics=…]`, `.ics-feed-url`; `.as-panel`, `.as-card[data-status]`, `[data-action="approve|reject|undo"]`; `.int-row`, `[data-service]`; `.transfer-notice[data-tone]`, `.transfer-steps [data-state]`.

## Collections, atlas, journeys, photo book, Vacay

- Collections: copies carry only the caller's per-user data, so moves leave others' ratings and tags behind; copying saved places keeps only web images; the create form has no cover upload (edit after creating).
- Atlas: no cities (places store no locality); region names are English with the local name as a subtitle; regions use a 0.02° simplification; no per-region hide; bucket items have no photos or links.
- Journeys: "Photos near this entry" needs `puter.ui.showDirectoryPicker` and ranged `fs.read` (hidden when absent); GPX tracks only for linked trips the member belongs to; undated trip days give no suggestions; two editors importing at once can create duplicate suggestions (shown once).
- Photo book: trashing a journey photo does not check the book ("Photo unavailable" once purged); no rotation or text flow; live `puter.peer` cursors are unverified; the journey header's conflict bar also counts book conflicts.
- Vacay: fusion is pairwise; holidays load for the shown leave year only; fused people show day counts, not entitlement; the invitations inbox probes each Vacay handle once per refresh.
- Hooks: `.col-card[data-id]`, `.col-row[data-id]`, `data-focus` `open:|menu:|check:|status:<id>`; `data-focus` `row:|region:|bucket:<id>`, `.atlas-region[data-code][data-status]`; `.jr-entry[data-id][data-type]`, `.jr-public-url`; `.bk-editor`, `.bk-page[data-id]`, `.bk-el[data-id][data-kind]`, `tests/e2e/helpers/peer-relay.js`; `button.vacay-day[data-date]`, `.vacay-person[data-peer]`.

## Notifications and locales

- In-app reminders run while Trips is open, in the tab holding the `trips-reminders-<uuid>` lock. Out-of-app notifications have no scheduled trigger: reminders and digests go out on the next handler run (trip activity, the open app's wake-up write, or a test). Reminders are not emailed. Duplicate subscriptions from two devices are cleaned on the next sync.
- Out-of-app notifications are English only (the handler bundles `en/notifyOut.js`; subscriptions carry no locale). Basemap labels, holiday names and place descriptions follow provider languages; native date inputs follow the browser. Locales are AI-drafted with no native-speaker review yet.
- New English strings show in English in every locale until translated: run `node tools/i18n-check.mjs --write-untranslated` after adding strings, or `tests/unit/i18n-locales.test.js` fails.
- Hooks: `runHandler({event, ctx, user, fetch, now, sleep})`, `claim(kv, entries)`, `send(run, channel, note)`; `?lang=en-XA`, `?dir=rtl`, `setLocale(tag, {persist: false})`.

## Performance

Fixture and scripts: `dev/fixtures/large-trip.js`, `npm run perf:*`; results, method and remaining items in [status.md](status.md#performance). The `kit` and `mock` string modules ship in the production bundle (about 3 KB).
