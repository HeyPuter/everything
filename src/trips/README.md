# Trips

A collaborative trip planner for Puter, built with vanilla JavaScript. puter.js is its only backend: each trip lives in a worker in its owner's Puter account. Build plan: [PLAN.md](PLAN.md). Status: [docs/status.md](docs/status.md). Known gaps and test hooks: [docs/handoffs.md](docs/handoffs.md).

## Features

- **Dashboard**: trips in a grid or list, a spotlight for the next trip, filters, and widgets for currency conversion, world clocks, upcoming bookings, collections and the atlas. Week overview of upcoming plans.
- **Trips**: create, copy, archive, delete or leave; re-date with an impact preview; covers from uploads, links or image search; ownership transfer.
- **Day planner**: days, visits and day notes merged with bookings into one timeline; drag and drop (mouse, touch and Alt+Arrow); undo and redo; Plan B alternatives per day or for the whole plan.
- **Scheduling**: dwell times, travel times, opening hours, anchors and warnings; automatic day schedule.
- **Places**: a shared pool with categories, tags, ratings and visited marks; paste coordinates or map links; details from Wikidata, Wikipedia and OpenStreetMap with photos and opening hours; AI summaries.
- **Map**: markers, day and trip routes, booking arcs, search, nearby places, route optimization, satellite imagery and deep links to other map apps.
- **Bookings**: flights with legs and airports, trains, lodging, rentals and more, each in its own time zone; AI import from PDFs, emails, wallet passes and Puter mail; flight status with the user's own AeroDataBox key; move a booking to another trip.
- **Costs**: expenses in any currency with frozen rates, payers, equal or weighted splits and presets, partial payments with due dates, settle-up with the fewest transfers, per-currency balances, private expenses, budgets, receipt scanning, CSV export.
- **Lists**: packing lists with bags, weights, per-person checks and templates; to-dos with due dates.
- **Files**: uploads, previews, trash, links to bookings, places and expenses, Puter drive pick and save, trip photos from the drive, videos in direct file mode.
- **Collab**: chat with reactions, replies and link previews; notes; polls; links; an activity feed with unread badges.
- **Members**: invite links, personal links and invites by Puter username; owner, editor and viewer roles with a per-trip permission matrix; guests; presence.
- **Sharing and export**: a read-only public link with section toggles, ICS calendar feeds per trip and for all trips, print and PDF, GPX/KML/KMZ import and export, trip files, "download all my data" and "delete all my data".
- **Weather and holidays**: forecasts within nine days, typical climate beyond, sunrise and sunset, public and school holidays.
- **AI assistant**: reads the trip and proposes changes; nothing is written until the user approves.
- **Offline**: installable PWA; kept trips with their files and map tiles; Work offline mode; conflict review.
- **More**: collections of saved places, an atlas of countries and regions with a bucket list and distance flown, travel journals with photo books and a public link, road trips (driving limits, nights, fuel, hazards), Vacay for shared leave planning, reminders, background notifications (webhook, ntfy, email digest), and AirTrail, Immich and Dawarich imports.
- **Settings**: language, units, date and time formats, theme, accent, density, text size, high contrast, reduced motion, dashboard layout, AI models, travel-document vault.

23 UI languages, including Arabic and Hebrew (right to left). English is the source; strings not yet translated show in English ([src/lib/README.md](src/lib/README.md), Locales).

## Where your data lives

| Data | Where | Who pays |
| --- | --- | --- |
| Trips, collections and journeys: entities, change log, chat | The owner's KV, written only by the owner's worker | Owner for writes; each member for their own reads |
| Membership, roles, invites, secrets | The owner's KV, worker-only keys | Owner |
| Presence and read markers | The owner's KV, in each member's own region | That member |
| Snapshots and files | The owner's AppData (`spaces/<id>/`) | Owner's storage; readers pay egress in direct file mode, the owner when proxied |
| Preferences, trip list, atlas, bucket list, templates, Vacay, private items, vault | Each user's own KV and AppData | That user |
| AI, map tiles, geocoding, routing, weather, FX | Called from the user's browser | That user, or free public services |

The owner's worker costs $0.03 a month in rent. Nothing authoritative is kept in a member's own storage. "Download all my data" and "delete all my data" are in Settings. Details: [architecture §4](docs/architecture.md#4-who-stores-and-pays-for-what) and [data-model.md](docs/data-model.md).

## Architecture

- **Static PWA** at `trips.puter.com`. Vite, vanilla ES modules, MapLibre GL, Lucide icons. The UI reads from an IndexedDB replica and writes through an outbox, so it works offline.
- **Trip host worker** (`worker/`): one per owner, `trips-<10 chars>.puter.work`, deployed from the owner's browser on their first trip and updated forward-only from `public/worker/trips-worker.js`. It validates and orders every write (roles, permissions, schemas, base versions), keeps the change log and snapshots, and serves public links and ICS feeds. Members call it with a restricted credential and a signed proof, never their session.
- **Reads**: members read through KV share handles (path A) when `config.json` enables `pathA`, otherwise through the worker (path C). Files are direct (shared folders) when `directFiles` is on and the owner can share, otherwise proxied.
- **Geo worker** (`worker-geo/`, `trips-geo`): the one developer-run worker. It caches and globally rate-limits Nominatim, OSRM and Valhalla. Upstream calls stay off until `geo:config` is written.
- **Notify handler** (`worker-notify/`): the `tripsNotify` events handler, published once against the app. It runs as each subscribed user and sends their webhook, ntfy and email notifications.
- **Runtime config** (`public/config.json`, served no-cache): provider lists, `geoWorker`, `pathA`, `directFiles`, `minBuild`. Edit it to pull a provider or flip a flag without a new build.

Layout: `src/shared` (schemas, money, dates, permissions; used by the client and the worker), `src/lib` (data layer, sync, services glue; API in [src/lib/README.md](src/lib/README.md)), `src/ui` (component kit), `src/views` (screens), `src/map`, `src/services`, `src/sw.js`. Full design: [docs/architecture.md](docs/architecture.md), [docs/data-model.md](docs/data-model.md), [docs/services.md](docs/services.md), [docs/design.md](docs/design.md).

## Development

Node 22.12+ (22.x), 24.x or 26+.

```sh
cd src/trips
npm ci
npm run dev
```

Open `http://trips.puter.localhost:5301/mock.html?as=alice` to run the real app, worker and sync against the in-memory fake Puter (`dev/fake-puter`), or `/` for production, which loads the hosted SDK. Port 5301 is reserved for Trips.

Mock options: `as=alice|bob|carol`, `state=A|C` (KV share handles on or off), `files=direct|proxied`, `cas=0|1`, `regions=1|2`, `offline=0|1`, `reset=1`, `sw=1` (service worker), `ai=off|credit|…` (scripted AI), `fixture=large` (the performance fixture), `lang=<tag>`, `dir=rtl`. Open two windows as different users to test collaboration. The UI kit is at `/dev/kit.html`.

Other builds: `npm run build:worker` (trip host worker into `public/worker/`), `npm run build:mock` and `npm run preview:mock` (the mock and kit pages in `dist-mock/`, port 5304), `npm run build:geo`, `npm run build:notify`, `npm run build:icons` (renders `icon.svg` into `icon.png`, `icon-128.png` and `public/icons/` with Playwright's Chromium). Performance scripts: `npm run perf:bundle|perf:store|perf:worker|perf:browser` ([docs/status.md](docs/status.md#performance)).

## Testing

```sh
npm test                  # Vitest: shared domain, data layer, views, worker ops against the fake runtime
npm run build             # runs check:licenses first
npm run check:licenses
npx playwright install chromium
npm run test:e2e          # mock.html, two users, both themes, 1280×800 and 390×844, axe
npm run test:e2e:bridge   # isolated browser contexts on one Node-side fake world
npm run test:e2e:client   # real IndexedDB client fixture
npm run test:e2e:map      # WebGL map fixture with intercepted tiles
```

Set `TRIPS_E2E_PORT_BASE` to move the Playwright servers (base +3, +4, +5; default 5300) when several runs share a machine. No test talks to live Puter or a third-party service. Checks that need them are listed in [docs/live-checks.md](docs/live-checks.md).

## Deploying

- **App**: AWS Amplify builds `src/trips` from the root `amplify.yml` (`npm ci`, `npm run build`, publish `dist/`). Headers are in the root `customHttp.yml`: no-cache for `/`, HTML, `sw.js`, the manifest, `config.json` and `worker/*`, immutable `assets/*`. `dist/` includes the trip host worker bundle; owners' workers update themselves from it the next time they open Trips.
- **Geo worker**: `.github/workflows/deploy-trips-geo.yml` deploys `trips-geo` on pushes to `main` that touch `worker-geo/` (or by hand). Secrets: `PUTER_API_TOKEN`, `TRIPS_GEO_WORKER_DIR`. Then write `geo:config` (`{regions, limits?, disabled?, killed?}`) in the worker's KV ([services.md §3](docs/services.md#3-geo-worker-trips-geo-developer-run)); `killed: true` is the kill switch.
- **Notify handler**: `npm run build:notify`, then `PUTER_TOKEN=… PUTER_APP_UID=… npm run publish:notify` from the account that owns the Trips app, or run `.github/workflows/publish-trips-notify.yml` by hand (secrets `PUTER_API_TOKEN`, `TRIPS_APP_UID`). `--replace` republishes an unchanged handler, which also resumes suspended subscriptions.
- **Config**: edit `public/config.json` and redeploy the app.

## License

AGPL-3.0-only ([LICENSE](LICENSE)). `npm run check:licenses` refuses third-party AGPL and GPL dependencies; MPL and LGPL need a review note.

## Launch checklist

Live steps, in order. None of them has been done.

1. **Hosting**: create the Amplify app for `src/trips` and connect `trips.puter.com`. Confirm the headers above on the live origin.
2. **App registration**: register the Puter app `trips` (title Trips, icon `icon-128.png`, description from [STORE_LISTING.md](STORE_LISTING.md)) with `index_url` set to the origin root, `https://trips.puter.com/`. Note the app uid.
3. **Geo worker**: set the `TRIPS_GEO_WORKER_DIR` secret and run the deploy workflow. Write `geo:config` with the verified region count into the KV the worker reads (`me.puter.kv` of the deploying account) and check that `GET https://<geo worker>/config` reports `limiter: "declared"`. Set `geoWorker` in `config.json` to the worker's `https://….puter.work` URL. Before a wide launch, pick a keyed routing and geocoding provider (PLAN D4).
4. **Notify handler**: set the `TRIPS_APP_UID` secret and run the publish workflow (or the npm script), then republish after every handler change.
5. **F0 live checks** with two accounts: all ten in [platform-verified.md](docs/platform-verified.md), recording evidence there.
6. **Worker floor**: after the first production deploy, read `at=` from the first line of `https://trips.puter.com/worker/trips-worker.js` (or `builtAt` from an owner's `/health`) and set `minBuild` in `config.json` to it. Proofs went to version 2 with no overlap, so this is the floor for later protocol changes.
7. **Path A and direct files**: set `pathA: true` in `config.json` once F0 check 1 passes, and `directFiles: true` once checks 2 and 3 pass.
8. **Module live checks**: everything in [docs/live-checks.md](docs/live-checks.md).
