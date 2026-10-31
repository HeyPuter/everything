# Build status

Last update: 2026-10-25. Branch: `trips/full-build` (final run on `trips/final-run`). Nothing is pushed and `main` is unchanged.

## Built

Every task in PLAN §4 is merged and runs offline against `dev/fake-puter`; only H1's live review rounds wait for the beta gate:

- **Foundations (F1–F8)**: scaffold, UI kit, shared schema and domain, fake runtime and bridge, worker engine, client store and sync, app shell, maps and services.
- **Phase 1 (P1–P11)**: dashboard and trip CRUD, day planner, places, scheduling, planner map, bookings, costs, lists, files, collab, members and sharing, settings, offline and PWA.
- **Phase 2 (Q1–Q13)**: ICS, print, GPX/KML/JSON import and export, AI booking import, assistant, weather and holidays, public link, path A, collections, atlas, place details, receipts and vault, reminders and polish.
- **Phase 3 (R1–R11)**: journeys, photo book, Vacay, road trip, atlas regions, out-of-app notifications, integrations, transit and flight status, 22 more locales and RTL, ownership transfer and Plan B, the remaining [3] items.
- **Hardening**: G1–G3 fixes, H2 performance (below), H3 launch wiring, the security fixes, the T0 and A1–A6 test sprints, the final scan and this final run.

Deferred by design: a custom map style URL, Atlas cities, MobiData BW, background mail capture, assistant edits of existing entities and web search. Per-area gaps are in [handoffs.md](handoffs.md).

## Verification

Final run, offline, `TRIPS_E2E_PORT_BASE=9000`, Playwright with `--workers=3`. Two consecutive runs of every suite, both green:

| Check | Result |
| --- | --- |
| `npm run build`, `build:worker`, `build:mock`, `build:geo`, `build:notify` | pass (chunk-size warning only) |
| `npm run check:licenses` | pass, 135 packages, allowlist unchanged |
| `node tools/i18n-check.mjs` | pass: 0 errors in 22 locales (89 keys each still fall back to English) |
| `npx vitest run` | 2,662 tests in 209 files pass |
| `npm run test:e2e` (desktop and phone, light and dark) | 788 tests: 764 passed, 24 skipped |
| `npm run test:e2e:bridge` | 8 passed |
| `npm run test:e2e:client` | 11 passed |
| `npm run test:e2e:map` | 6 passed |

The 24 skips are by design: keyboard-only paths run on the desktop projects (7 specs × 2 phone projects), the protocol-only `mock-worker` and `trips-flow` flows run on desktop-light only (2 × 3), touch-grip sorting and the phone tab bar run on phones only (2 × 2). Root causes of the flakes fixed in the final run are in [test-sprint.md](test-sprint.md#final-run).

## Live-only

Nothing here can pass on the fake runtime; [live-checks.md](live-checks.md) lists each check with the task that raised it:

- the ten F0 platform checks ([platform-verified.md](platform-verified.md)); checks 1–3 gate `pathA` and `directFiles` in `config.json`;
- deploy and launch: `customHttp.yml` headers, the first real `workers.create`, `minBuild` before release;
- two real accounts: joining, path A latency and handle renewal, direct files, profile pictures, ownership transfer, Delete my data;
- real devices and services: offline and PWA install, drive pickers, `puter.ai` and mail, calendar hand-off, map and weather providers, the geo worker (`geo:config`), out-of-app notifications, Vacay shares, integrations, `puter.peer` cursors in the photo book;
- a native-speaker review of the AI-drafted locales.

## Known gaps

- [test-sprint.md](test-sprint.md): conformance per area, the bugs each sprint fixed, and what is not covered by e2e.
- [handoffs.md](handoffs.md): what is not built or only partly built per area, open worker lows, test hooks.
- [live-checks.md](live-checks.md): everything that needs live Puter, a real service or a real device.
- Performance items left open are below.

## Performance

H2 measured the architecture §18 budgets, and the §15 operation counts, on a big trip, fixed the worst offenders, and left scripts to repeat the measurements.

**Fixture**: `dev/fixtures/large-trip.js`: 60 days, 1,000 places, 600 visits, 80 bookings, 300 expenses, 400 packing items, 2,000 chat messages, 200 files and 6 members (4,752 entities; the replica is one 1.6 MB IndexedDB record). It is seeded through the real worker: `mock.html?as=alice&reset=1&fixture=large` in the browser, `loadLargeTrip(harness)` in Node.

**Method**: before is `0e458544e`, after is `trips/h2-performance`. Each value is the median of alternating runs (two in the browser, three in Node) on an Apple Silicon laptop shared with other agents (load average 10–16), so small values are noisy. Browser rows use headless Chromium with the GPU and show desktop (1280×800) / phone (390×844, 4× CPU throttling). The fixture's worker runs in the page, so worker work also blocks that main thread. "Interactive" means the view's content showed and no long task (> 50 ms) followed. "Blocked" is the sum of long tasks.

| Budget | Measure | Before | After |
| --- | --- | --- | --- |
| Cold start < 1.5 s (mid phone) | Empty account, navigation to settled dashboard | 138 / 393 ms | 153 / 395 ms |
| | Dashboard with the big trip cached, to interactive | 33 / 124 ms | 21 / 78 ms |
| | Code before the dashboard shows (gzip; initial + dashboard route) | 239.5 KB | 236.7 KB |
| Cached trip < 300 ms to interactive | Plan tab, to interactive (content shown) | 7,136 / 20,910 ms (3,456 / 15,463) | 132 / 1,809 ms (132 / 397) |
| | Plan tab DOM nodes | 58,050 | 31,606 |
| | Bookings / costs / lists / files / collab tabs (desktop) | 389 / 80 / 82 / 84 / 53 ms | 63 / 74 / 69 / 46 / 38 ms |
| | The same tabs (phone) | 2,630 / 289 / 304 / 355 / 201 ms | 252 / 272 / 294 / 195 / 143 ms |
| | First open, replica loaded from KV | 7,423 / 11,116 ms | 321 / 3,497 ms |
| | Replica: cached open; path A first load (Node, fake IndexedDB) | 21 ms; 290 ms | 11 ms; 155 ms |
| | Opening a trip adds (gzip; plan tab, MapLibre loads separately, 286 KB) | 155.3 KB | 146.7 KB |
| Syncing 100 changes < 300 ms | Path A catch-up of 100 records (Node; 3 member-paid gets) | 68 ms | 41 ms |
| | 100 remote commits arriving one by one on the open plan tab, blocked | 3,372 / 5,730 ms | 0 / 255 ms |
| | Path C sync of 100 changes (owner KV ops; worker time) | 2 gets; 1.5 ms | 2 gets; 1.5 ms |
| Big trips: lists virtualized | Places pool rendered | 1,000 rows (29,000 nodes) | 100 rows, more on scroll (2,900 nodes) |
| | Day cards on open | all 60 at once | 6, then 12 ms slices; off-screen cards skip rendering |
| Markers clustered | Place markers | clustered | clustered (unchanged) |
| DnD at 60 fps | Dragging a visit, 60 pointer moves (p95 frame) | 54 / 31 fps (17 / 83 ms) | 46–60 / 48–59 fps (17 / 17 ms) |
| Re-render on unrelated events | Remote chat message on the plan tab, blocked | 1,249 / 6,748 ms | 0 / 59 ms |
| | Remote place edit on the plan tab, blocked | 615 / 8,076 ms | 0 / 56 ms |
| | Local edit through the store on the big replica | 30 / 307 ms | 18 / 71 ms |
| Selectors | Store selectors (1,000 places, 600 visits, 2,000 messages) | < 1 ms | < 1 ms |
| | Plan timeline: rebuild; unchanged | 1.3 ms; 0.8 ms | 1.3 ms; 0 ms (memoized) |
| Worker (§15 ops, §18 caches; no worker changes) | Commit: 1 patch / 10 patches / 200 creates, owner KV ops (budget) | 6 (≤6) / 15 (≤15) / 7 (≤206) | same |
| | Commit worker time: 1 patch / 200 creates | 0.8 / 9.6 ms | 0.8 / 9.1 ms |
| | Path C sync with no changes, KV ops cold / warm (≤2 / 0) | 1 / 0 | 1 / 0 |
| | Snapshot rebuild of 3,509 entities: list pages + FS writes; time | 5 + 1 (4 entity pages, 1 chat); 91 ms | same |
| | Snapshot size gzip / JSON held (LRU 16 MB, parsed cache 48 MB) | 129 KB / 1.15 MB | same |
| | Join: owner KV ops + handle mints (≤10 + 2) | 10 + 2 (11 with a cold `idx`) | same |

**Fixes**
- Time zones: `isTimeZone` and the zoned formatter built an `Intl.DateTimeFormat` on every call, and `zonedInstant` ran nine `formatToParts` per local time, for every booking on every day. Zone checks, resolved instants, locales, hour cycles and file-size formatters now sit in bounded caches, and server entity schemas are built once per type.
- Replica: a flush with nothing to send no longer clones and rewrites the 1.6 MB record on every poll (`db.update` writes nothing when the change returns its input). View builds share frozen confirmed entities instead of cloning them, and `space.onState` reports only real changes.
- Plan tab: day cards build six at a time and then in 12 ms slices, skip off-screen rendering (`content-visibility`), and rebuild only for their own changes (`refreshPlanHooks(dayIds)`, cached rail chips, a memoized timeline and weather answers). The places pool renders 100 rows at a time. The map batches routed-day redraws and draws one frame after mounting.
- Events: Bookings, chat, notes, links and polls ignore sync status flips, and Lists ignore presence heartbeats.
- Bundle: the re-date preview (which carries the worker's planner) and the track reader (which carries its gzip library) load on first use.

**Remaining**
- The initial bundle carries every module's English strings (84 KB gzip of 189 KB) and every service adapter, because `session.services` is synchronous. Per-module string bundles fit R9's locale work.
- The replica is one IndexedDB record, so each local or remote change rewrites 1.6 MB: about 20 ms on desktop and 60–75 ms on the throttled phone. Splitting it by type is a storage-format change left for later.
- On the throttled phone the plan tab shows its content in about 0.4 s, but MapLibre symbol placement and trip routing keep the main thread busy for about 1.5 s more, so "interactive" is 1.8 s.
- `src/ui/vlist.js` is not used. It needs fixed row heights, and place, packing and expense rows vary. The places pool pages instead. Packing (12,000 nodes) and expenses (8,000) render in under 100 ms on desktop and about 300 ms on the phone.
- Drags have an occasional slow first frame (up to 333 ms). It does not appear as main-thread work in a profile (`--profile=plan:drag`), so it is likely headless frame scheduling under load.

**Re-running**

```sh
cd src/trips
npm run perf:bundle                      # chunk sizes; --modules[=views/trip/plan/index.js] lists the largest sources
npm run perf:store                       # replica load, cached open, sync, edits, selectors (Node, fake IndexedDB)
npm run perf:worker                      # owner KV and FS ops and worker time per action, snapshot size
TRIPS_E2E_PORT_BASE=<base> PLAYWRIGHT_BROWSERS_PATH=/private/tmp/trips-playwright npm run perf:browser -- [--phone]
TRIPS_E2E_PORT_BASE=<base> npm run perf:browser -- --profile=plan[:msg|place|drag]   # then tools/perf/profile-summary.mjs, long-tasks.mjs
```

`perf:browser` builds the mock into a temp dir and serves it on `TRIPS_E2E_PORT_BASE + 6`. For a before/after comparison, check out the older `src/` (`git checkout <rev> -- src/`), run the scripts, then restore `src/` (`git checkout HEAD -- src/`).

Handoff notes: [handoffs.md](handoffs.md). Live checklist: [platform-verified.md](platform-verified.md). Client contracts: [src/lib/README.md](../src/lib/README.md).
