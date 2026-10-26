# Trips: build plan

Trips is a collaborative trip planner built as a Puter first-party app whose only backend is puter.js. This file is the entry point for the orchestrator and for every build agent.

| Doc | Read it when |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | always: tiers, who pays, write/read/realtime paths, security, costs |
| [docs/data-model.md](docs/data-model.md) | any work on schemas, the worker, the store or sync |
| [docs/spec.md](docs/spec.md) | building a feature: the parity checklist by module, with phases |
| [docs/platform.md](docs/platform.md) | any puter.js call: limits, billing, quirks |
| [docs/services.md](docs/services.md) | maps, search, routing, weather, FX, holidays |
| [docs/design.md](docs/design.md) | any UI: tokens, components, dark mode, files to copy |
| [docs/backlog.md](docs/backlog.md) | prioritising; the upstream bug history to avoid repeating |
| [docs/status.md](docs/status.md), [docs/handoffs.md](docs/handoffs.md) | starting any task: current state, gates, known gaps, test hooks and how to run checks |
| [docs/test-sprint.md](docs/test-sprint.md), [docs/live-checks.md](docs/live-checks.md) | testing: offline conformance per area; checks that need live Puter or real services |

## 1. Rules for every agent

1. **Clean room.** Never open, copy or translate another product's source, strings, translations, CSS, icons or wiki text. Work from `docs/spec.md` and observed behavior. Code comments never say a design is modelled on another product.
2. **No third-party AGPL/GPL code or dependencies.** Run `npm run check:licenses` (copy `src/records/tools/check-licenses.mjs`). LGPL/MPL need a note in the PR. Do not widen the allowlist to pass. Code from this repo's own apps may be reused whatever their license, because Puter holds the copyright.
3. **Stack**:
   - Vanilla JS ES modules, Vite, Vitest (jsdom), Playwright for browser flows, Lucide icons, MapLibre GL.
   - No framework, no TypeScript.
   - puter.js only via `<script src="https://js.puter.com/v2/" defer>`.
   - `el()` DOM helper (`src/projects/src/lib/dom.js`).
4. **Data rules**:
   - Never trust identity, roles or ids from the client inside the worker.
   - Nothing authoritative in a user's own KV.
   - No `kv.list` on hot paths.
   - Bytes go in FS and only references in KV.
   - Every `me.puter` write must be authorized and budgeted.
5. **Every user-visible string goes through `t()`** (`src/lib/i18n/`); English is the source and other locales follow it (`tools/i18n-check.mjs`). Dates and numbers use `Intl`. Use CSS logical properties (RTL-safe).
6. **Both themes, desktop and phone, keyboard and screen reader** for every view. 4.5:1 contrast. Focus is visible and returns after dialogs close.
7. **Comments are short** and only where code is not obvious. Docs are concise. No narration of decisions in code.
8. **Stay inside your task's owned paths** (§4). Edits to shared registries are one-line appends. Contract changes follow §7.
9. **Verify before claiming done** (§8). Report failures with output, and never mark a task done with failing checks.

## 2. Decisions

### Made

| # | Decision | Where |
| --- | --- | --- |
| M1 | Every shared object is a **space** in a per-owner **trip host worker** deployed from the owner's browser (`trips-<10 chars>.puter.work`). Owner pays writes and rent. | architecture §2–4 |
| M2 | Members call the worker with a **restricted credential plus a signed request**, never their session. | architecture §17, platform |
| M3 | Members read state through **KV share handles** (path A, member pays) and write their own presence and markers through a write handle on their own sub-prefix. The worker (path C) is the fallback. Files are direct (shared folder, reader pays) when the owner can share, otherwise proxied. Phase 1 ships C; Q8 switches to A. | architecture §6, §10 |
| M4 | Local-first: IndexedDB replica + outbox. Polling is the source of truth; KV-handle and fs events are hints. | architecture §5, §7 |
| M5 | One KV item per entity. Change log plus FS snapshots rebuilt by full scan as the repair point. | architecture §8–9, data-model |
| M6 | Client-generated ids, fractional ordering, HLC versions, base-version 409s on conflict-checked types. | data-model |
| M7 | Private packing items and expenses live in the member's own KV. | architecture §13 |
| M8 | All AI runs in the browser (user pays). Claude models for documents. | architecture §14 |
| M9 | Third-party geo and weather calls run from the browser. The only developer-run worker is `trips-geo`, for globally rate-limited providers. | services |
| M10 | Public links and ICS feeds are served by the owner's worker. | architecture §12 |
| M11 | Roles: owner / editor / viewer, plus guests; per-trip permission matrix. | data-model §5 |

### Open (defaults apply until the user answers; record answers here)

| # | Question | Default |
| --- | --- | --- |
| D1 | App name, URL, folder | "Trips", `trips.puter.com`, `src/trips`, app name `trips` (available on 2026-10-24) |
| D2 | License | AGPL-3.0-only, like the recent collaborative apps (whiteboard, spreadsheet, presentation) |
| D3 | Weather provider (is Trips "commercial" for API terms?) | MET Norway forecast + NASA POWER normals (commercial-safe) |
| D4 | Routing and geocoding capacity for a wide launch | public FOSSGIS/Photon for beta; pick a keyed provider behind `trips-geo` before launch |
| D5 | KV share handles with `read`/`write` levels | shipped October 25, 2026 with a per-region conditional put; Trips, the fake runtime and data-model.md follow the shipped API (differences in platform.md, KV shares) |
| D6 | Locales at launch | English only, i18n-ready (R9 later shipped 22 AI-drafted locales; native review pending) |
| D7 | Phase 3 modules (journey, photo book, vacay, road trip, full atlas) required before calling it 1:1 | yes, after v1 ships |
| D8 | Add Trips to the first-party AI free-credit list (Puter repo change) | ask the platform team |

## 3. Repository layout

```
src/trips/
  PLAN.md  README.md  STORE_LISTING.md  package.json  package-lock.json
  vite.config.js  vite.worker.config.js  index.html  mock.html  icon.svg  icon.png  icon-128.png
  public/               config.json, manifest, icons/, data/ (airports, countries, regions/), worker/ (built bundle)
  dev/                  fake-puter/, client-data/, fixtures/, spike/, mock-boot.js, mock-trips.js, mock-worker.js, kit.html
  worker/               trip host worker: index.js, app.js, auth.js, http.js, keys.js, cache.js, engine/, ops/<kind>/<type>.js
  worker-geo/           developer-run geo proxy
  worker-notify/        tripsNotify events handler (out-of-app notifications)
  scripts/              data builds (airports, countries, regions), icons, publish-notify
  tools/                check-licenses, i18n-check, Vite plugins (PWA, text scale), e2e ports, perf/
  src/
    main.js  sw.js
    shared/             ids, order, hlc, schema/, operations, money, dates, geo, pool, perms, protocol, limits, reach (worker + client)
    lib/                puter, api (worker client), cred, deploy, session, store/, sync/, idb, outbox, i18n/, router, prefs, format,
                        files/, offline/, ai/, costs/, res/, timeline/, schedule/, route-plan/, road/, ics/, io/, notify/, notify-out/, ...
    ui/                 kit: dom, icons, modal, sheet, menu, toast, tabs, fields, dates, avatar, dnd, vlist, md
    map/                MapLibre wrapper and layers
    services/           geocode, route, placeInfo, weather, fx, holidays, tz, airports, images, transit, flights, hazards
    views/              shell/, registry/, dashboard/, trip/<tab>/, settings/, join/, public/, collections/, atlas/, journey/,
                        vacay/, week/, help/, ics/, io/, integrations/, print/
    styles/             tokens.css, base.css, components.css; views keep their own css
  tests/                unit/, worker/, e2e/ (Playwright, axe), map/ (WebGL fixture)
  docs/
```

Shared registries (one-line appends only):
- `src/shared/schema/index.js` (created by F3)
- `worker/ops/index.js` (created by F5)
- `src/views/registry/` (`routes.js`, `tabs.js`, `settings.js`, `commands.js`; entries may carry a lazy `load`, see `src/lib/README.md`)
- `src/lib/i18n/en/index.js` (one line per module; strings live in `src/lib/i18n/en/<module>.js` with keys prefixed `<module>.`)

Cross-entity domain ops (`day.remove`, `trip.redate`, `visit.move`, `res.moveToTrip`) live in `worker/ops/trip/domain/`; `costs.settleAll` is in `worker/ops/trip/settle.js`. The task named in the table owns each op, and the owners of the entity types it touches review it.

## 4. Phases and tasks

Sizes: S ≈ ≤1 day, M ≈ 2–4 days, L ≈ 1–2 weeks, XL ≈ split further when assigned (agent-days). Each task lists what it owns, what it needs, and its acceptance criteria. Module acceptance criteria are in `docs/spec.md`.

**State** (final scan, 2026-10-25): every task was built, merged into `trips/full-build` and tested offline against `dev/fake-puter`, except where the State column says otherwise. Remaining gaps per area are in [docs/handoffs.md](docs/handoffs.md), live-only checks in [docs/live-checks.md](docs/live-checks.md).

### Phase 0: foundations (contracts frozen at the end)

| ID | Task | Owns | Needs | Size | State |
| --- | --- | --- | --- | --- | --- |
| F0 | **Platform verification spike** on live Puter with two test accounts. Runs whenever accounts are available; gates the beta gate, not Phase 0 | `docs/platform-verified.md`, `dev/spike/` | none | M | Pending: needs two live accounts; harness in `dev/spike/` |
| F1 | **Scaffold**: package.json, Vite configs (unique `strictPort`, `puterLocalhost('trips')`), index.html with pre-paint theme script, mock.html, check:licenses, empty PWA plugin, placeholder icons | root files | none | S | Done |
| F2 | **UI kit and design system**: tokens/base/components CSS and `src/ui/*` from design.md, plus `dev/kit.html` showing every component in both themes, both widths | `src/ui/`, `src/styles/`, `dev/kit.html` | F1 | L | Done |
| F3 | **Shared domain**: ids, order keys, HLC, schema DSL plus every entity type in data-model.md, validators, money (minor units, rounding, split allocation), dates and time zones, permission matrix, protocol constants, limits | `src/shared/` | F1 | L | Done |
| F4 | **Fake Puter**: copy the SDK's argument parsing exactly (for example `kv.list` object vs string forms); KV share handles per the platform design (`share`/`unshare`/`listShared`/`listSharedByMe`, `optConfig.handle`, levels, relative keys and cursors, labels, share notifications, worker-write marking, `kv_handle_*` errors) behind a fake flag; `onlyIfAbsent` behind a separate flag so both code paths are tested; KV with real semantics (path ops, `incr`/`add`, 400 KB cap, TTL, batch get, list) plus a `regions: 2` mode with async replication and LWW; FS with share/listShared/sign/getReadURL; events (fs, kv, handles, includeValue); multi-user auth; `workers.exec` routed to an in-page worker; op and cost counters | `dev/fake-puter/` | F1 | L | Done |
| F5 | **Worker space engine**: router wrapper, restricted-credential auth, caches, spaces, ACL, link invites and join (path C; shares, stubs and handles come in Q8), commit pipeline (per-op ids, type rules, generic CRUD plus a domain-op registry), change log, signal key, contiguous sync, repair, snapshot rebuild and serving, presence, rate limits and budgets, path C files, `/health`, error mapping. Build script with a banner build id. | `worker/` | F3, F4 (built and tested against the fake runtime) | XL | Done |
| F6 | **Client data layer**: puter wrapper, worker client (trusted hosts, credential, signing, retries, 402/409 handling), deploy and forward-only update, personal store (`me:*`), space store (replica, outbox batching, optimistic apply, conflict parking), sync engine (path C adapter, events, polling cadence), `heads` | `src/lib/` | F3, F4 (protocol from data-model.md) | XL | Done |
| F7 | **App shell**: boot and sign-in, hash router and view registry, desktop and phone layouts, trip shell with a tab registry, command palette and shortcut registry, toasts, offline and sync indicators, settings section registry, `t()` | `src/main.js`, `src/views/shell/`, `src/views/registry/`, `src/lib/router.js`, `src/lib/i18n*` | F2, F6 (stubs allowed) | L | Done |
| F8 | **Map and services foundation**: lazy MapLibre wrapper with theme styles, layer API (clustered markers, lines, arcs, polygons, labels), geolocation, attribution; every adapter in services.md with config.json, cache and throttle; airports and countries data build scripts; `worker-geo/` plus a disabled CI deploy workflow | `src/map/`, `src/services/`, `public/data/`, `worker-geo/`, `scripts/` | F1 | L | Done; live provider acceptance pending |

**Parallelism**: F1 first, then F2, F3, F4 and F8 at once, then F5 and F6 at once against the fake runtime, then F7. F0 needs live accounts and runs independently; it gates the beta gate, not this phase. Gate: **Contracts review**. The orchestrator checks that `src/shared` and the worker protocol match data-model.md, the store and sync APIs are documented in `src/lib/README.md`, and the UI kit is in `dev/kit.html`. Then contracts are frozen.

**F0 checklist** (record pass/fail and evidence for each):
1. KV handles:
   - mint from a worker's `me.puter` after consent; grantee `onLocal` with `includeValue`; deliveries cross-region; revoke.
   - When `kv.shareHandles` is on:
     - `me.puter.kv.share({prefix, recipient:{uid}, access:'read'|'write'})` from the worker;
     - holder `get`/batch `get`/`list({returnValues, reverse})`/`set` through `optConfig.handle`;
     - free owners need no phone or card verification;
     - handle caps per owner;
     - billing lands on the holder;
     - share labels and notifications; worker-write marking in events;
     - the conditional put (`onlyIfAbsent`), if it landed.
2. A worker bound to the app can `me.puter.fs.share` its AppData subfolder to a username (read and write) and `unshare`. Free and verified accounts both tried.
3. The recipient's app can `stat`/`read`/`write` the shared same-app AppData by uid; `listShared()` finds it; `fs:` events reach the recipient.
4. The restricted-credential flow (`getReadURL` token, `user.puter.fs.stat` in the worker) works with the current SDK in workers.
5. `kv.get([keys])` batches; `kv.update` path semantics (does it create a missing item?); `incr`/`add` return values; `kv.list({pattern, returnValues})`; TTL; 400 KB cap.
6. `CompressionStream` and streaming responses in workers; CPU time for a 5,000-entity snapshot rebuild.
7. Who pays for a signed URL read by a signed-in user.
8. `puter.email.list/get` with `.mail:read`; an events-worker handler on `fs:~/.mail/objects/**:add`.
9. `puter.ai.chat` with a PDF `puter_path` on `claude-sonnet-5-5` and `outputFormat`.
10. Worker eviction wake time; `/health` without auth (`x-puter-no-auth`).

Development is offline: `dev/fake-puter` implements the APIs these checks assume, and F5, F6 and every later task build against it. All ten checks gate the **v1 beta** gate. Checks 1–3 also gate switching production reads to path A (Q8); Q8 itself is built and tested against the fake first. If a check fails, the orchestrator updates architecture.md and the fake runtime, and lists the affected tasks in `docs/status.md`.

### Phase 1: core planner (fan out after the contract gate)

| ID | Task | Spec | Owns | Needs | Size | State |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | Trips CRUD, copy, archive, re-date with impact preview, dashboard (grid/list, spotlight, filters, widgets: FX, clocks, upcoming) | §1 | `views/dashboard/`, `views/trip/settings/`, `worker/ops/trip/meta.js`, `trip.redate` | F5–F7 | L | Done |
| P2a | Days, visits, day notes, timeline merge, drag and drop (desktop and touch), undo/redo, what's next | §2 | `views/trip/plan/`, `worker/ops/trip/{day,visit,dayNote}.js` | F5–F7 | XL | Done |
| P2b | Places pool: sidebar, filters, bulk, place form, ratings, categories, tags, paste coordinates or link | §2 | `views/trip/places/`, `worker/ops/trip/{place,cat}.js` | F5–F7 | L | Done |
| P2c | Time-aware scheduling: dwell, travel time, auto schedule, anchors, warnings | §2 | `src/lib/schedule/`, plan view hooks | P2a, P3 | M | Done |
| P3 | Map in the planner: markers, day and trip routes, booking overlays, search UI, reverse geocode, POI explore, optimize, external deep links | §3 | `views/trip/map/`, `src/lib/route-plan/` | F8, P2a, P2b | L | Done |
| P4 | Reservations, transport, lodging: forms per type, legs, airports, travelers, day positions and phases, stays | §4 | `views/trip/bookings/`, `worker/ops/trip/res.js` | F5–F8 | L | Done |
| P5 | Costs: expenses, payers, splits, settle-up with math, settlements, overview, CSV, private expenses | §5 | `views/trip/costs/`, `src/lib/costs/`, `worker/ops/trip/{exp,settle}.js` | F5–F7 | L | Done |
| P6 | Lists: packing (tiers, bags, contributors, per-person checks, import), to-dos, personal templates | §6 | `views/trip/lists/`, `worker/ops/trip/{pack,bag,todo,listMeta}.js` | F5–F7 | L | Done |
| P7 | Files on path C: upload, preview, trash, star, links, attach from drive, save to drive, thumbnails, HEIC | §7 | `views/trip/files/`, `src/lib/files/`, `worker/ops/trip/file.js` | F5–F7 | M | Done |
| P8 | Collab: chat, notes, links, polls, activity feed and unread badges | §8 | `views/trip/collab/`, `worker/ops/trip/{msg,note,link,poll}.js` | F5–F7 | L | Done |
| P9 | Members and sharing: invite links, personal invite links for named people (discovery through Puter shares comes in Q8), join flow, roles, permission matrix editor, guests, leave/remove, presence, avatars | §9 | `views/trip/members/`, `views/join/` | F5–F7 | M | Done |
| P10 | Settings and personalization | §19 | `views/settings/` | F7 | M | Done; custom map style URL deferred ([2]) |
| P11 | Offline and PWA: service worker, offline downloads, tile prefetch, conflict UI, Settings → Offline | §12 | `src/sw.js`, `src/lib/offline/`, `views/settings/offline.js` | F6, F8 | M | Done |

**Parallelism**: everything except P2c (after P2a and P3) and P3 (after P2a and P2b reach their entity APIs) can run at once: about 11 agents. **Gate: v1 alpha.** Two-person multi-user e2e in mock.html passes for every module, in both themes and at phone width.

### Phase 2: imports, exports, AI, sharing, collections

| ID | Task | Spec | Needs | Size | State |
| --- | --- | --- | --- | --- | --- |
| Q1 | ICS export, trip feed endpoint (VALARM), Puter Calendar app hand-off (desktop only) | §9–10 | P2a, P4, P6 | M | Done; Puter Calendar does not read launch items yet, so the hand-off only opens it |
| Q2 | PDF print view and options | §10 | P2a, P3, P4 | M | Done |
| Q3 | GPX/KML/KMZ import and export, JSON trip export and import, "download all my data" | §10 | P2b, P4 | M | Done |
| Q4 | AI booking import: files, paste, PKPass, EML, Puter mail, review UI, dedupe | §13 | P4, P7 | L | Done; background mail capture deferred (needs a published events handler and live Puter) |
| Q5 | AI assistant with trip tools and approvals | §13 | P2a, P2b, P4, P6 | L | Done; edits and deletes of existing entities and web search deferred |
| Q6 | Weather and holidays in the planner | §11 | P2a, F8 | M | Done |
| Q7 | Public trip link: worker projection, viewer, toggles | §9 | P1–P8 | M | Done |
| Q8 | Path A (read handle on `shared:<id>:`, member write regions for presence and read markers), KV-handle wake-ups, named invites through KV shares (labels, notifications), direct file mode (files and inbox shares) | arch §6–7, §10–11 | P7, P9 (F0 checks 1–3 before enabling in production) | L | Done; production flags stay off until F0 checks 1–3 pass |
| Q9 | Collections (space kind) | §14 | P2b, P9 | L | Done |
| Q10 | Atlas basic | §15 | P2b | M | Done; cities deferred (places store no locality) |
| Q11 | Place details enrichment and AI summary | §3 | P2b, F8 | M | Done; OSM hours and facts need the geo worker (`geoWorker` is null until launch) |
| Q12 | Receipt OCR, travel-documents vault, move a booking to another trip, cost weight presets | §4–5, §19 | P4, P5 | M | Done |
| Q13 | Reminders and browser notifications, activity-feed polish, week overview, chat link previews (worker unfurl), video uploads (direct file mode), appearance [2] items, help pages, "delete all my Trips data" | §1, §7–8, §19–20 | P1, P8, Q8 | M | Done |

**Gate: v1 beta.** Every F0 live check passes or its failure is designed around. Live-Puter e2e with real accounts (§6). Cost budgets pass. Security and data-loss review rounds are clean (§9).

### Phase 3: the remaining parity modules

| ID | Task | Spec | Size | State |
| --- | --- | --- | --- | --- |
| R1 | Journey (space kind), public journey link | §16 | XL | Done |
| R2 | Photo-book editor with `puter.peer` cursors | §16 | XL | Done; live `puter.peer` cursors unverified |
| R3 | Vacay on direct KV shares, no worker (data-model §3.4) | §17 | M | Done |
| R4 | Road trip | §18 | XL | Done; MobiData BW not built (terms unconfirmed) |
| R5 | Atlas regions, bucket list, distance flown | §15 | M | Done |
| R6 | Out-of-app notifications (events-worker handlers: webhook, ntfy; opt-in email) | §20 | M | Done; the handler is published at launch |
| R7 | Integrations via `puter.net.fetch` (AirTrail, Immich, Dawarich) | §4, §10, §21 | L | Done |
| R8 | Transit (if licensed) and flight status with a user key | §3–4 | M | Done; Transitous stays off in `config.json` until its operators agree |
| R9 | Locales (AI-drafted, reviewed), RTL pass | §21 | M | Done; native-speaker review pending (live check list) |
| R10 | Ownership transfer, Plan A/B alternatives | §1, §2 | M | Done |
| R11 | Remaining [3] items: cost extras, days from photos, trip photos, combined public link, all-trips ICS feed via the user's own worker, spec §22 [3] rows | §5, §9, §13, §22 | L | Done; Google Places key, Google Maps shared lists and a public API deferred (Google terms, scraping, covered by the assistant) |

### Phase 4: launch

| ID | Task | State |
| --- | --- | --- |
| H1 | Final adversarial review rounds on everything (§9) | Partly: security review fixes merged and every area audited in the test sprints (A1–A6); live rounds wait for the beta gate |
| H2 | Performance pass against architecture §18 budgets with a 60-day, 1,000-place fixture | Done (status.md, Performance) |
| H3 | Launch wiring: `amplify.yml` and `customHttp.yml` entries (`/`, `**/*.html`, `/sw.js`, `/config.json`, `/worker/*` no-cache; `/assets/*` immutable), root README row (Productivity), `STORE_LISTING.md`, final icons (`scripts/build-icons`), Puter app registration (`index_url` = origin root), enable the `trips-geo` deploy workflow, README with Features / Where your data lives / Architecture / Development / Testing / Deploying / License | Done offline; hosting, app registration, worker deploys and publishing are the README launch checklist |

## 5. Task graph

```
F1 ─┬─ F2 ──────────────┐
    ├─ F3 ─┬─ F5 ─┐     ├─ F7 ─┐
    ├─ F4 ─┴─ F6 ─┴─────┘      ├─ [contract gate] ─┬─ P1 P2a P2b P4 P5 P6 P7 P8 P9 P10
    └─ F8 ─────────────────────┘                   ├─ P3 (after P2a+P2b entity APIs) ─ P2c
                                                   └─ P11 (after F6+F8)
[alpha gate] ─ Q1…Q13 ─ [beta gate] ─ R1…R11 ─ H1…H3
F0 (live checks, needs accounts) ──────────────▶ beta gate; checks 1–3 also gate Q8 in production
F5, F6 and all later tasks build against the fake runtime (dev/fake-puter)
```

## 6. Testing and the mock world

- `mock.html?as=alice|bob|carol&state=A|C&files=direct|proxied&cas=0|1&regions=1|2&offline=0|1&reset=1` boots the real app against `dev/fake-puter` and the real worker bundle in the page. Every multi-user flow must be testable here with no Puter account. Copy the approach of `src/teamchat/dev/worker-runtime.js` and `src/teamchat/tests/helpers/harness.js`.
- **Unit tests** (Vitest): everything in `src/shared`, `src/lib/costs`, `src/lib/schedule`, `src/lib/route-plan`, importers and parsers. Money and dates use table-driven cases, including the upstream bug themes in backlog §1.
- **Worker tests** run against the fake runtime:
  - every op's permission checks;
  - validation rejects;
  - idempotency;
  - 409 paths;
  - sync and reset;
  - snapshot repair under `regions: 2`;
  - rate limits;
  - **cost budgets** (architecture §15) asserted from the op counters.
- **E2E** (Playwright on mock.html): two browser contexts as different users per module (create, see it appear for the other user, edit offline, reconnect, conflict UI). Viewports 1280×800 and 390×844. Light and dark screenshots attached to the PR.
- **a11y**: axe on every view in both themes; keyboard-only path through each module's main flow.
- **Live smoke** (beta gate and H1): two real Puter accounts, `src/trips/tests/live/` behind `PUTER_LIVE=1`. Covers create, invite, join, edit, sync, file round-trip, public link, ICS, AI import in test mode.

## 7. Orchestration protocol

- **One task, one agent, one branch** `trips/<id>-<slug>` in its own git worktree, branched from `trips/full-build` and merged back into it. `main` is untouched until launch.
- **Start of task**: read §1, the docs the task row points to, and `src/lib/README.md` plus `src/shared` once they exist. Write a short task plan in the PR description before coding.
- **Shared registries**: append one line each. The orchestrator resolves merge conflicts in registries.
- **Contract changes** (data-model.md, `src/shared/schema`, worker protocol, store/sync API, UI kit APIs):
  - the agent opens a separate small PR titled `Trips: contract: …`;
  - the orchestrator approves it and tells dependent tasks;
  - protocol changes must stay backward compatible for 90 days.
- **Commits**: `Trips: <plain sentence>`. The body gives symptom or goal, cause, change, and how it was verified.
- **PR description**: what changed, how it was verified (commands with results, screenshots), cost-budget results, known gaps, and the spec checkboxes covered.
- **Merge**: only after the DoD (§8) and an independent review (§9) pass. The orchestrator merges in dependency order and asks open branches to rebase.
- **Status**: the orchestrator keeps `docs/status.md` (task, agent, branch, state, blockers, last update). Agents report blockers rather than working around another task's ownership.
- **Concurrency**: Phase 0 ≤6 agents, Phase 1 ≤11, Phase 2 ≤12, Phase 3 ≤10. Reviews run alongside implementation.

## 8. Definition of done (every task)

- [ ] The spec checkboxes for the task are implemented, or explicitly deferred in the PR with a reason.
- [ ] `npm test`, `npm run build`, `npm run check:licenses` pass, and `npm run test:e2e` for UI tasks.
- [ ] New logic has unit tests. Worker ops have permission, validation, idempotency and cost-budget tests.
- [ ] Multi-user flow verified in mock.html with two users. Offline edit and reconnect verified for any write path.
- [ ] Light and dark, desktop and phone screenshots. Keyboard path. axe clean.
- [ ] 402, 403, 409, offline and slow-network states handled with clear UI.
- [ ] No user content via `innerHTML`; markdown through `src/ui/md.js`; links http(s) only and show their host.
- [ ] No `puter.workers.exec` outside `src/lib/api.js`; no `kv.list` outside snapshot, chat paging and repair.
- [ ] Strings through `t()`. No hard-coded colors outside tokens.
- [ ] Comments short; no competitor references in code or text.
- [ ] Docs updated if behavior or contracts changed (data-model.md, spec checkboxes, README section).

## 9. Review protocol

Every PR gets an independent reviewer agent with no access to the author's reasoning. The reviewer gets the diff, this plan and the relevant docs, reports findings ranked by severity, and the author fixes them. Repeat until clean. At each gate, run full adversarial rounds over the whole app by category:

1. **Security**: identity and authorization in the worker; trusted hosts; invite and token handling; XSS (markdown, links, file previews, names); SSRF in link previews; leaks in public projections; tokens in logs.
2. **Data loss and races**:
   - two tabs, two users, offline replay;
   - cross-region double `rev`;
   - read-modify-write anywhere;
   - delete versus edit;
   - re-dating;
   - member removal with history.
3. **Money and dates**:
   - rounding;
   - mixed currencies;
   - settle-up correctness;
   - time zones (flights east to west, DST, missing browser tz);
   - 12/24 h.
4. **Puter quirks**: 402 everywhere, picker cancel, desktop-only APIs standalone, worker eviction, old worker builds, share verification gates, rate limits.
5. **Accessibility and keyboard**: focus order and return, live regions, DnD alternatives (Alt+Arrow), reduced motion, contrast in both themes.
6. **Mobile and touch**: every create action reachable, sheets, DnD on touch, safe areas, landscape.
7. **Performance and memory**: big-trip fixture, map with 1,000 markers, long chat, leaks on view switches.
8. **Cost and abuse**: op counts against budgets, unbounded loops or polls, per-member budgets, hidden-tab behavior.
9. **Error reporting**: every failed save, upload, share or import tells the user what happened and what to do.

Tell reviewers rule 1 in §1 (no competitor references in comments).

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| Free owners can't share folders (phone/card verification) | Only file downloads are affected: they fall back to proxied mode (owner pays egress). State uses KV handles |
| Owner pays more than expected on big, busy trips | Cost budgets in tests; batching; event-driven polling; path A; usage banner for owners |
| Cross-region KV races | Conditional put for `rev` claims (assumed); repair by re-listing or snapshot as fallback; tests with `regions: 2` |
| Public geo providers throttle or change terms | Adapters plus remote config; `trips-geo` limiter; D4 before launch |
| Scope (the feature set is very large) | Phased plan; Phase 1 is a usable product on its own; one responsive UI instead of separate phone and desktop trees |
| Members on old worker builds | Protocol versioning; feature detection; 90-day compatibility |
