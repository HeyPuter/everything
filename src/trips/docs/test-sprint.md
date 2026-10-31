# Test sprint baseline

T0 run on `trips/full-build` at `0a2c80590` (2026-10-25), branch `trips/t0-baseline`, with `TRIPS_E2E_PORT_BASE=8300`. Everything ran offline against `dev/fake-puter`.

## Results

| Check | First run | After T0 fixes |
| --- | --- | --- |
| `npm run check:licenses` | pass (135 packages) | pass |
| `npm run build`, `build:worker`, `build:mock` | pass (chunk-size warning only) | pass |
| `build:geo`, `build:notify` | pass | pass |
| `npx vitest run` | 2536 passed in 201 files | unchanged |
| `test:e2e` (4 projects) | 176: 160 passed, **8 failed**, 8 skipped | 180: 172 passed, 8 skipped |
| `test:e2e:bridge` | 8 passed | unchanged |
| `test:e2e:client` | 11: 10 passed, **1 failed** | 11 passed |
| `test:e2e:map` | 6 passed | unchanged |

The 8 skips are by design: touch sorting on the two desktop projects, and the protocol-only `mock-worker` and `trips-flow` flows, which run on `desktop-light` only. `test:e2e` also runs `fake-bridge.spec.js` in all four projects (32 of its runs), on top of `test:e2e:bridge`.

## Infrastructure fixes

| Spec or fixture | Cause | Fix |
| --- | --- | --- |
| `settings.spec.js` "map, AI, dashboard and offline sections…" (×4) | Settings → AI no longer offers approval modes (55ac86da8); the dashboard widget list gained `collections` and `atlas`; Settings → Offline is the real P11 section, not the placeholder text | Assert the approval note and that no mode radios exist; expect the five widgets; check the Work offline and Keep map areas switches |
| `shell.spec.js` "account isolation…" (×4) | Relied on the in-page mock world surviving a reload. It resets on every load, so Alice's `me:prefs` existed only in her IndexedDB cache, which revalidation correctly cleared | Alice and Bob run on the bridge world; another account's device theme is simulated with `trips:theme` and a reload. Same assertions: the device theme shows when the account has none, and the account theme wins over it |
| `client-data.spec.js` "two accounts join by named invite…" | The fixture is a production build, where path A follows `config.json` (`pathA: false`) | `dev/client-data/path-a.js` passes `features: {pathA, directFiles}` to `openSpace` |
| `mock-worker.spec.js` first test (flaky, 9 of 10 in a repeat run) | `dev/mock-boot.js` set `data-worker="ready"` before installing `globalThis.trips` | Install the hook first |

Added:
- `tests/e2e/helpers/bridge-world.js`: accounts on one Node-side world, one context each in the project's theme and viewport, `sharedTrip()` (the owner creates through the mock hook, the others join through the app's invite link), and `audit`, `capture`, `noOverflow`. Contexts abort every non-local request. Without that, the Plan tab and Atlas fetch live OpenFreeMap tiles and Nager holidays.
- `tests/e2e/views.spec.js`: the owner and a joined editor open every trip tab and top-level page in all four projects, with no page errors and no `.view-error`.

## Remaining failures

No deterministic failures remain.

| Spec | Test | Cause hypothesis | Area |
| --- | --- | --- | --- |
| `tests/e2e/trips-flow.spec.js` | two accounts share a trip on the real worker across paths A and C… | Flaky, 1 of 10 repeats: Bob's `workers.exec` count rises by one while he reads on path A (line 59). **Fixed in A4:** the call was the dashboard's `heads` on its first load (see A4 below), so the test counts ops by name | A4 |

### Findings for the area specs

A probe (not committed) opened every trip tab and page as the owner and a joined editor at desktop-light and phone-dark, then ran axe on the first view. These fail once each area's spec audits its views:

| View | Finding | Hypothesis | Area |
| --- | --- | --- | --- |
| Plan tab (both widths) | axe `landmark-unique` on `.plan-places-pane` | The pane section and the places module both expose a "Places" landmark | A2 (fixed) |
| Plan tab (1280 px) | Horizontal overflow, 1284 > 1280, from `ul.pl-list` / `.pl-empty` | The places pane's empty list is 4 px wider than its pane | A2 (fixed: the three-pane grid was wider than the content area) |
| Costs tab | axe `heading-order` (`h3`) | The kit's `emptyState` renders `h3` straight under the page `h1` | A3 |
| Lists tab | axe `heading-order` (Packing empty state `h3`), `landmark-complementary-is-top-level` (`aside.lists-bags`) | Same empty-state `h3`; the bags `aside` sits inside the tab's landmark | A3 |
| Collab tab | axe `heading-order` (`h3`) | Empty-state `h3`. **Fixed in A4:** each Collab panel starts with a hidden `h2` | A4 |
| Atlas | axe `heading-order` (`h3`) | Empty-state `h3` | A6 |
| Vacay | axe `aria-required-attr` on `div[aria-label="Kind"] > button[role=radio]` (2) | The kind radios lack `aria-checked` | A6 |

The empty-state `h3` comes from `src/ui/bits.js` `emptyState`. One kit change (a heading level option) may fix the A3, A4 and A6 rows. The Files, Members, trip Settings, Bookings, dashboard, Collections, Week and Journeys views were axe-clean on first render, and so were Settings → flight status, integrations, data, delete, notifications, calendar and about.

### Stale against the spec (not changed)

- spec §13 ("tool calls with approval modes") and §19 ("AI: models, assistant approval mode") list approval modes, which 55ac86da8 removed. The assistant now always asks. A5 updated the spec, architecture and data model to say every write needs approval (a product decision for the user to confirm).
- `settings.offlinePending` and the placeholder fallback in `src/views/settings/index.js`, plus the registry comment in `src/views/registry/settings.js`, are dead now that `offline.js` exists (A1).

## Coverage gaps

**Alpha gate:** every module needs a two-person e2e in `mock.html` that passes in both themes and at phone width.

**PLAN §6:** each module's spec needs:
- two contexts as different users that create, see the change appear for the other user, edit offline, reconnect and reach the conflict UI;
- 1280×800 and 390×844 viewports;
- light and dark screenshots;
- axe on every view in both themes;
- a keyboard-only path through the main flow.

Today no module meets that bar:
- `views.spec` (render only) is the only two-person UI test that covers trip views.
- `trips-flow.spec` is two-person but protocol-only, on desktop-light.
- `settings.spec` covers two sessions of one account, and a template file passed to a second user.

The area sections below record what each spec now covers; open gaps and test hooks per area are in [handoffs.md](handoffs.md). Start from `helpers/bridge-world.js`.

| Area | Modules | E2E today | Missing |
| --- | --- | --- | --- |
| **A1** | Shell, dashboard, trip settings, settings, offline, notifications, week, help | `boot`, `shell` (empty dashboard, palette, shortcuts, skip link, appearance, invalid links, sign-in), `settings` (all P10 sections, templates, categories, vault, two sessions, offline save), `mock-app-bridge` (prefs on the bridge, mock reset); `views` renders the dashboard, week and trip Settings | Dashboard with trips: create from the UI, copy, archive, delete, re-date preview, filters, grid and list, FX and clocks widgets (intercept Frankfurter). Trip settings edited by Alice and seen by Bob. Offline: Work offline then reload, offline downloads, an offline edit with reconnect and the conflict banner. Reminders and the notify-out settings. Week across a trip boundary. Help drawer and trip menu by keyboard. Presence and the Collab badge. Settings → flight status, integrations, data, delete, notifications and calendar (render only, via the probe) |
| **A2** | Plan, places, map, schedule, weather, road trip, transit, Plan B | `map` (the MapLibre wrapper on a fixture, desktop-light and phone-dark only); `views` renders Plan | Two users adding, ordering and dragging visits (desktop and touch); undo and redo; places pool (rate, tag, bulk, viewer limits); the planner map with intercepted tiles; auto schedule and warnings; weather and holidays (intercept met.no, NASA POWER, Nager, OpenHolidays); road trip with two users; transit; Plan B alternatives; offline edit and conflict; axe fixes above |
| **A3** | Bookings, costs, lists, booking import, receipts | None beyond `views` rendering the tabs (and personal packing templates in `settings`) | Booking forms per type and legs, seen by the other user; expenses, splits, settle-up and settlements between two users, private expenses hidden from the other; lists with per-person checks, bags and reorder, and a viewer; AI booking import and receipt OCR on the scripted `puter.ai` (review UI, dedupe, 402); a booking moved to another trip; offline edit and conflict; axe fixes above |
| **A4** | Files, collab, members, join, invites, public link, path A, direct files | `trips-flow` (protocol: invite, join, paths A and C, offline, removal), `client-data` path A, `fake-bridge`; `views` covers the UI join through an invite link and renders Files, Collab and Members | Upload, preview, trash and star seen by the other user (`files=direct` and proxied); chat, notes, polls and the unread badge between two users; roles, the permission editor, a viewer and guests, leave and remove, presence; named invites by username; the public link viewer signed out, with rotate and off; path A event latency and fallback after unshare in the UI; the `trips-flow` flake |
| **A5** | Import/export, ICS, print, assistant, integrations, transfer | `settings` covers the AI model choice only | GPX, KML, KMZ and JSON import and export round trips, and "download all my data"; ICS download, feed create, rotate and revoke with three users; print view options and keyboard; assistant streaming, proposals, Apply, Reject and Undo, viewer, 402 and 429 (scripted `puter.ai`); integrations with a patched `puter.net.fetch`; ownership transfer between Alice and Bob |
| **A6** | Collections, atlas, journeys, photo book, Vacay | `views` renders Collections, Atlas, Vacay and Journeys | Collections shared with an editor and a viewer (`#/c/…`), saves from a trip, move and copy, public link; Atlas visited marks per user, regions, bucket list, flights view, offline and 402; journeys and the public journey link; photo book editing and the stale-layout conflict bar (peer cursors need live Puter); Vacay sharing between three users with live updates, `state=C` and 402; axe fixes above |

### Notes for writing module specs

- The in-page `mock.html` world resets on every load. Anything that spans a reload or two users belongs on the bridge (`bridgeWorld`).
- The bridge follows full page loads and in-app hash navigation (A1). `page.goto` to a URL that differs only in the hash is a same-document navigation too.
- The bridge follows full page loads. Since A5, a hash change in the same page keeps the bridge session (`bridge-playwright.js`), so in-app navigation works; a reload or a new URL starts a new session.
- Make failures with `world.failNext({ method, as, status })` on the bridge, or `__TRIPS_MOCK__.failNext(...)` in-page.
- Only the bridge contexts block the network. Specs that use Playwright's own `page` must route any third-party host they reach.
- The map suite (`tests/map`) intercepts styles and tiles in the spec. Reuse its fixtures when a module spec needs a rendered map.

## A2: Plan, places, map, scheduling, weather, road trip, transit, Plan B
Run on `trips/a2-tests` from `cd3411047` with `TRIPS_E2E_PORT_BASE=8450`. Specs use `helpers/plan.js` (`planWorld`, pane switching, mouse, long-press and keyboard drags, `setRole`) and `helpers/providers.js` (map styles, tiles, imagery, Photon, MET Norway, NASA POWER, Nager.Date, OpenHolidays, GDACS and DWD from fixtures; `config` patches `/config.json`; `seed` and `read` go through the mock hook).
### Specs
| Spec | Tests | Covers |
| --- | --- | --- |
| `plan.spec.js` | 6 | Set up days, add places, notes and items between two editors; undo and redo by button and keyboard; What's next. Rows by mouse drag (day list or rail chip), a pool place onto a day, drag out of every list (nothing moves), long press on touch, Alt+Arrow across days with undo and redo, Move to day, day reorder by keyboard. Day removal impact as an editor (end moves). Viewer. Offline edits, reconnect, and the stale-edit conflict review. 402 (status, Retry) and a demoted editor's queued write refused (403) |
| `places.spec.js` | 6 | Add, rate and tag between two editors (tags private, averages), add to day, scopes, Create expense and Attach files. Pasted coordinates, a Google Maps link and a short link, `/` and N by keyboard. Bulk category, visited and delete with visits and a linked expense. Viewer. An offline edit to a place deleted meanwhile, restored from the conflict review. Q11: Wikipedia description, Openverse photo, AI summary with a 402, then Save to notes |
| `plan-map.spec.js` | 2 | Style per theme, tiles, summary, day selection, Optimize, Apply and Undo seen by the other editor, keyboard search to a new place, explore pills, satellite imagery. Viewer (no Optimize or Add place) and the offline chip |
| `schedule.spec.js` | 2 | Estimates, overlap warning and travel connectors; dwell and Fixed time from the visit form; Auto schedule by keyboard, seen by the other editor, then Undo. Viewer |
| `weather.spec.js` | 2 | Forecast with strip, wind and chance of rain; typical values far ahead; public and school holiday badges and the closure warning; both editors. Both providers failing, then Retry; a Bavarian regional holiday |
| `road.spec.js` | 2 | Road mode on, a daily limit set by Alice adds nights in Bob's view, a night placed with the slider by keyboard, End the day here and Undo seen by Bob. Viewer (read-only settings) |
| `transit.spec.js` | 2 | Intercepted Transitous plan, Add to bookings between two visits seen by the others, a viewer without Add; no provider (maps links only); no connections |
| `alternatives.spec.js` | 2 | Copy the day as Plan B, edit, compare, switch and undo for both editors; viewer |
All 24 tests pass in the four projects (96 runs). Each spec runs axe (no violations) and the overflow check on its views and attaches screenshots. On a loaded machine use `--workers=3`: under heavy load the bridge's 5 s boot wait times out.
### Bugs fixed
- Baseline findings: one "Places" landmark (the plan's places pane is no longer a region); no overflow at 1280 px (the side columns cap at a share of the width; the places list's 4 px focus-ring bleed stays inside its pane).
- Falsy values rendered as text: "0" under every visit name, "undefined" after day weather, "null" in the day panel, "false" next to a single places filter, "0" in schedule details and road search results.
- Phone width: the Collab badge's hidden text widened the page to 552 px, so the page panned sideways and menus near the bottom could not be clicked.
- Places: rows did not update for offline edits (stale name); a name from a pasted map link was replaced by the reverse lookup; bulk bar contrast; duplicate "Search places" and "Show" labels; "1 stars" and "from 1 ratings".
- Conflict review: "Save mine as a copy" failed when a pull had removed the entity before the refused patch.
- Map: the day panel covered the search and explore controls and overlapped place cards; cards covered the layers and fit buttons; heading order (card and panel now h2); the day panel was an aside inside the map region.
- The weather strip was not keyboard scrollable; Auto schedule preview notes were below 4.5:1 in dark.
- Plan B: re-renders cleared the add-stop form, and focus was lost after moving a stop to the top.
- Missing phase 1 items added: Attach files and Create expense from a place.
### Shared code changed
- `src/lib/store/space.js`: pending patches keep `local` (the entity as shown) for restores; covered in `tests/unit/client-store.test.js`.
- `src/ui/modal.js`: a scrolling body with nothing focusable gets `tabindex=0`; disabled controls with a tabindex are no longer focus-trap targets.
- `src/views/trip/shell.css`: `.trip-tabs { position: relative }`.
### Conformance
**P2a day planner (§2)**: 18 done.
| Item | Status | Note |
| Three resizable panes; day panel over the map; phone rail, switch and sheets | done | |
| Dated or undated days; add undated or the next date | done | |
| Delete a day: impact first, later days shift up, impact rules | done | Tested as an editor |
| Deleting a booking or place unlinks expenses, asks on the last link | done | Places here; bookings are A3 |
| Reorder days (content moves) | done | Grip, Alt+Arrow, menu |
| Day title, markdown notes, default mode, color | done | |
| Visits: several days, times, notes, leg modes, people, `endDayId` | done | |
| Drag from the pool, within and across days, mobile drag, context menu | done | Pool drag tested on the three-pane layout |
| Visits without a place | done | |
| Timeline merge, phase labels, one row per leg | done | |
| Connectors with time, distance and mode; change mode; transit search | done | |
| Stop numbers on the map and list | done | |
| Day notes: fields, 32 icons, color, reorder, move between days | done | |
| Undo/redo for place and visit edits, reorders, optimize, imports | done | |
| What's next | done | |
| Categories (10 built in, trip and personal) | done | |
| Personal tags | done | |
| Shortcuts: registry, `?`, ⌘K, J/K, N, / | done | J/K not in the specs |
**P2b places pool (§2)**: 8 done, 1 partial.
| Fields, search, category, scope and rating filters | done | |
| Bulk category, delete, save to collection, visited | done | |
| Create from search, map pick, pasted coordinates, map links | done | |
| Short links through `puter.net.fetch` | partial | No `net.fetch` in the fake runtime; the pane asks for the full link. Live only |
| Custom image upload, HEIC | done | G1 place photo |
| Per-user ratings with averages | done | |
| Overlap and end-before-start warnings | done | P2c and the visit form |
| Attach files; Create expense | done | Added in this sprint |
| Open in Google, Apple, OSM, Waze, CoMaps | done | CoMaps format unverified on a device |
**P2c scheduling (§2)**: 4 done, 1 partial.
| Dwell per visit | done | |
| Travel time from routing | partial | Straight-line estimates until `geoWorker` is set (H3) |
| Auto schedule from a start time or hotel departure | done | |
| Pinned visits as anchors | done | |
| Late warnings | done | |
**P3 planner map (§3)**: 9 done, 5 partial, 1 missing.
| MapLibre, OpenFreeMap light and dark, swap on theme change | done | |
| Satellite (ESRI) with attribution | done | |
| Markers: icon, order badge, selection, rating, hover card, clustering | partial | No photo markers |
| Place name toggle | done | |
| Location (show/follow), compass, layers, attribution | partial | Location is one-shot, no follow |
| Day and trip routes with distances | done | |
| Booking overlays, pending dashed, endpoint pills | partial | Endpoint codes are text labels |
| GPX/KML tracks | done | Q3 track layer |
| Explore pills with "Search this area" | done | |
| Photon autocomplete, Nominatim fallback, source tags, 60 m dedupe | partial | Nominatim needs the geo worker (H3) |
| Google Places key [3] | missing | The spec expects it to be dropped |
| OSRM, Valhalla avoids | partial | Straight-line until H3 |
| Straight-line fallback, legs reset at transport, days start and end at stays | done | |
| Optimize (nearest neighbour + 2-opt, fixed stops, hotel anchor, undo) | done | |
| Day export to Google Maps or CoMaps | done | |
**Q11 place details (§3)**: 3 done, 2 partial.
| Description: OSM, Wikivoyage, Wikipedia via Wikidata | done | OSM descriptions need OSM tags (H3) |
| Commons photos with credit | done | Openverse fallback tested |
| Opening hours with badge in the place's zone | partial | Needs the geo worker's OSM lookup (H3) |
| Good to know facts | partial | Same |
| AI summary, labelled, checked against the place | done | |
**Q6 weather and holidays (§11)**: 6 done.
| Day weather in the panel and chips (condition, range, rain, wind, sun, strip) | done | |
| Forecast window (MET Norway, 9 days) | done | |
| Typical values beyond it | done | Also used when the forecast fails |
| Past dates: archive or normals | done | Normals (no licensed archive) |
| `cc` and `admin1` from bundled boundaries | done | |
| Public and school holiday badges | done | |
**R4 road trip (§18)**: 8 done, 1 partial.
| Road view: chain, arrival times, totals | done | |
| Stay per stop, anchors, late warnings, daily window and nights, End the day here, draggable day ends | done | Slider tested; map drag not |
| Driving limits, range, fill-up, fuel type, run-out band | done | |
| Search along the route, filters, Add manually | done | Not in the specs |
| Vias, alternatives, avoids, follow a track | partial | Avoids need Valhalla through the geo worker (H3) |
| EV charging (MobiData BW or OSM) | done | OSM only; MobiData terms unconfirmed |
| Hazards (GDACS, DWD) | done | Empty fixtures; live shapes are on the live list |
| Booked nights, transport legs, hire cars, service stops shown or hidden | done | |
| Drag and drop, search, fuel planning | done | Road drag not in the specs |
**R8 transit (§3, §2 connectors)**: 2 done.
| Transit search from a connector | done | Off until Transitous agrees (`providers.transit`); maps links meanwhile |
| Add to bookings between the visits | done | |
**R10 Plan B (§2)**: 1 done, 1 partial.
| Alternatives (Plan A/B) | partial | Per day or whole trip, not per time slot; stops are edited in the dialog only |
| Compare and switch with undo | done | |
### Left
- Not in the specs: road-view drag, the map's night-marker drag, J/K.
- Live only: short links, Transitous and the hazard feeds; routing, Nominatim, OSM hours and facts once H3 sets `geoWorker`.
- Holiday regions picked from the boundaries show the ISO code (for example "DE-BY"); the name loads only with the region dialog.
## A6: collections, atlas, journeys, photo book, Vacay
Branch `trips/a6-tests`. Two- and three-user specs on the bridge world in all four projects, with axe and an overflow check on every view they open.
| Spec | Tests (×4 projects) | Covers |
| `collections.spec.js` | 5 | create by keyboard; Bob joins through the sharing dialog's invite link, Carol as viewer; places, ratings and statuses seen by the others, visited per person; offline edits and a deleted-place conflict with Review; 403 rollback and 402 sync state; public link signed out (rotate, off); save a trip's places with a duplicate, copy to another collection |
| `atlas.spec.js` | 3 | visited, planned, undated and layover rules; Bob's own visited mark counts only for him; search, keyboard row and Escape, mark, second tab, hide and show, regions from trips and by hand; bucket list (coordinates, whole country, visited); flights view; offline and 402 refusals |
| `journeys.spec.js` | 3 | journey from a trip with suggestions; Bob writes one up, dismisses one, adds a members-only entry; Carol reads only; keyboard entry; map, gallery and stats tabs; public link signed out; offline edits, deleted-entry conflict, 403 rollback |
| `book.spec.js` | 2 | live cursors, selections and page badges between Alice and Bob over the fake peer; shape add, delete and undo seen by the other; keyboard nudge, delete and undo; viewer cannot edit; stale layout conflict with Keep theirs; PNG export |
| `vacay.spec.js` | 3 | full, half and Shift-click range; weekends refused; view-only share to Bob (live rings), plan together with Carol (bars both ways), stop sharing and dissolve; grid by keyboard and the Kind radios; offline; a holder's 402 and a 402 on first load; state C |
64 of 64 passed; each spec also passed with `--repeat-each 2` (atlas 3).
Helpers: `helpers/spaces.js` (`joinSpace` for any space kind, `refFromURL`, `committed` for what the owner's worker committed, `syncStatus`, `toastText`), `helpers/public-viewer.js` (`signedOutViewer`: `index.html` with the SDK blocked and `*.puter.work` answered by the world without credentials; `served` keeps every response for leak checks), `helpers/peer-relay.js` (a Node-side `puter.peer` across bridge contexts; attach each context before its first page).
Notes for specs:
- Before reconnecting a member to provoke a conflict, wait for the owner's commit with `committed(...)`. "Up to date" can show before the outbox sends.
- After `setOffline(false)` the outbox can take a few seconds (its backoff races the bridge's reconnect call). Give conflict bars up to 20 s.
- Photo-book members find each other's invites on a 10 s poll, so the first cursor can take that long.
- Set `actionTimeout` and `navigationTimeout`. The defaults wait until the test times out.
Status against spec §14–17 in the mock. "e2e" means a spec above covers it; otherwise unit tests and code review.
**Q9 collections (§14):** 8 done, 0 partial, 0 missing.
| Bullet | Status | Note |
| Lists: name, description, color, icon, cover, links, order; All saved | done | e2e create and list; cover upload only from the edit form |
| Saved places with status, labels, personal tags, ratings, cover | done | e2e status, rating, tags, per-person visited |
| Add by search; save from a trip; mark visited everywhere; copy to a trip; move or duplicate; bulk label and delete | done | e2e coordinates, save from a trip with a duplicate, copy; search needs Photon (live) |
| Import and export JSON and GPX (OsmAnd) | done | unit (`collections-model`) |
| Sharing with viewer and editor roles | done | e2e; the join page still says "Join trip" (P9 strings) |
| Read-only public link | done | was broken (the trip viewer showed an untitled, empty trip); new collection viewer, e2e signed out |
| Map panel, filters, category rings, overlay on a trip map | done | map and overlay not checked in e2e (tiles blocked) |
| Dashboard widget | done | unit |
**Q10 and R5 atlas (§15):** 8 done, 1 partial, 0 missing.
| World map (Natural Earth 50m) | done | renders in e2e without tiles |
| Visited, planned (dashed, toggle), undated and layovers excluded | done | e2e |
| Hide auto-detected countries | done | e2e |
| Country search; mark, unmark, places there | done | e2e |
| Stats | partial | cities missing: places have no city field (schema change, see the Q10 handoff); the rest e2e |
| Visited per user | done | e2e with Bob |
| Admin-1 regions from zoom 5 | done | e2e list and manual mark; map drawing and hit-testing not checked in a real browser |
| Bucket list; wishlist hatched | done | e2e list; hatching not checked visually |
| ISO codes; one dataset for borders | done | unit |
**R1 journeys (§16, journey):** 7 done, 1 partial, 0 missing.
| Title, subtitle, cover, status | done | e2e |
| Linked trips' suggestions, dismiss and restore | done | e2e write-up and dismiss |
| Entry fields and visibility | done | e2e title, story, date, members-only; reverse geocoding live-only |
| Media: HEIC, video, upload or drive, captions, photos near this entry | partial | video only in direct file mode; the drive picker and photos near this entry are live-only; e2e upload |
| Timeline, map, gallery, stats | done | e2e opens each |
| Mobile carousel, scrubber, quick capture | done | not in e2e (geolocation and weather) |
| Owner, editor, viewer, hide suggestions | done | e2e roles |
| Public link with toggles; photo GPS stripped without the map | done | e2e signed out: no members-only entries, suggestions, coordinates or member ids; served JPEGs have no GPS block |
**R2 photo book (§16, book):** 7 done, 1 partial, 0 missing.
| Formats, bleed and safe margin | done | unit |
| Book structure | done | e2e rail |
| 13 spread and 5 cover layouts; auto layout | done | e2e cover layouts |
| Left rail sections | done | e2e elements and layouts |
| Properties panel | done | unit |
| Undo and redo | done | e2e |
| Print to PDF; spread design files | done | not in e2e |
| Multi-user cursors and badges; stale version conflict | partial | e2e over the fake peer; live `puter.peer` unverified. The conflict dialog prints page content as raw JSON, and the journey header counts book conflicts too |
**R3 Vacay (§17):** 6 done, 0 partial, 0 missing.
| One plan per user in own KV; sharing through KV shares | done | e2e (`vacay:plan` written on first open) |
| Settings: weekends, week start, holidays, school holidays, company days, carry-over, leave year | done | holiday providers blocked in tests; settings dialog unit only |
| 12-month grid, half, comp, company mode, trip dots | done | e2e full, half, comp and ranges; company mode unit only |
| Entitlement, carry-over, stats | done | e2e used count; unit for the rest |
| Fusion with colors and dissolve; overlays as rings | done | e2e with three users and revocation |
| Day-based | done | |
- Collections: a public link opened as an untitled, empty trip. New `views/collections/public.js`, dispatched from the Q7 viewer like journeys.
- Native `replaceChildren` printed `false` and `undefined` in the place form's category select, the saved-place sheet, the collection filter bar and journey stats.
- The journey header printed `[object Object]` and leaked two subscriptions per presence event (it rebuilt `presenceStack` each time).
- Atlas: an async re-render took focus off the country title; the flights panel scrolled without focusable content.
- Photo book: the tools and properties asides were nested in the editor region (axe).
- Singular collection place counts; `main` landmarks in the collection and journey public viewers.
- Baseline findings: Atlas `heading-order` (a visually hidden h2 above the countries list, its results and errors, and the map failure); Vacay Kind radios without `aria-checked` (kit fix below); Vacay load error `heading-order`.
### Shared-code edits
- `src/ui/fields.js` `segmented`: paints `aria-checked`/`aria-pressed` even when every item is disabled.
- `src/ui/dnd.js` `makeSortable`: its status line goes after a `ul`/`ol` instead of inside it (axe `list`; every sortable list with two or more items).
- `src/views/trip/places/form.js`: the false-children fix above (A2's file).
- `src/views/public/index.js`: one line dispatching `kind: 'collection'` (Q7's file).
- `dev/fake-puter/bridge-playwright.js`: cherry-picked A5's 58d09dd38 (hash navigation keeps the bridge session).
- Atlas cities (schema change). Live checks: `puter.peer`, Photon search, holiday providers, the drive picker, geolocation.
- The kit conflict dialog prints object fields as JSON; the photo book needs a value formatter (kit API change).
- Collection strings with counts are plural only (`Copy 1 places to`, `1 are already in it`).
- Not in e2e: the collection map and trip overlay, JSON and GPX round trips, atlas "Load them", journey quick capture and map pins, book print preview and drag from the rail, Vacay settings, calendars, upgrade and decline.
- The trip public viewer (Q7) has no `main` landmark either (A4).
## A4: files, collab, members, join, public link, path A
Branch `trips/a4-tests` from `e0c48c621`, `TRIPS_E2E_PORT_BASE=8550`.
| Spec | Covers | Result (4 projects) |
| `files.spec.js` | upload by picker, paste and drop; SVG refusal; star, description, gallery, sanitized markdown; trash with Undo, restore, delete, empty; viewer; offline star; direct mode with video; proxied video refusal; concurrent links; keyboard; 402 and Retry | 30 passed, 2 skipped |
| `collab.spec.js` | chat (reply, reactions from both, jumbo emoji, edit, owner delete, paging past 200), notes, polls (hidden results, deadline, close, delete), links, badge, dashboard unread, Activity and filters, viewer, offline post, note conflict, chat images, link previews, keyboard, 402 and Retry sync | 42 passed, 2 skipped |
| `members.spec.js` | invite dialog, join preview, presence, role change on an open tab, removal, personal and revoked links, invite by username and the inbox, permission matrix, guests, leaving, keyboard, 402 and offline | 22 passed, 2 skipped |
| `public-link.spec.js` | link created in Members, read by a signed-out visitor with no account; secrets absent from the page and the raw `/pub` projection; toggles, rotate, turn off; keyboard | 6 passed, 2 skipped |
| `path-a.spec.js` | event-driven path A, a revoked read handle (fallback, renew, back to A), a lost write handle (presence), state C | 12 passed |
Skips are the keyboard paths on the phone projects. Full `test:e2e` on the branch: 284 passed, 16 skipped (one presence timing and three trace-artifact errors from a parallel run passed on rerun); `test:e2e:bridge` 8 and `test:e2e:client` 11 passed; `npx vitest run` 2,538 passed. The worker runs in the Playwright process on the bridge, so the link-preview test stubs Node's `fetch`; any spec that posts a URL in chat must do the same.
### Baseline findings
- **`trips-flow` flake.** Bob's extra call was the dashboard's `heads`, not his space. `mock-boot.js` sets `data-worker` before the app boots, so Bob can join before the dashboard's first load reads `me:spaces`; that load then sends one batched `heads` inside the counted window (5 of 6 runs with Bob's CPU throttled 12×). `heads` on load is intended, so the test now records Bob's ops by name and allows only `heads` while he reads on path A.
- **Collab `heading-order`.** Fixed with a hidden `h2` per panel (empty states, note titles, polls and feed days were all `h3` under the `h1`).
- Chat link previews never loaded in a browser: the holder was `hidden`, and an IntersectionObserver never reports a `display: none` target.
- The phone reaction bar (nine 44 px buttons) was wider than the screen; it wraps.
- The Collab badge's `sr-only` label escaped the scrolling tab strip and widened phone pages to 552 px.
- Dark mode contrast: secondary text in new feed entries, and hints on a selected kit choice card (invite dialog), were 4.12:1.
- Public viewer: no `main` landmark, card titles jumped from `h1` to `h3`, and failure states had no `h1`.
- Bridge infrastructure: a hash change (clicking a trip tab) made the page's bridge document stale, so its next call failed (the Collab read marker was never written). Signed-out visitors were impossible on the bridge.
**P7 files (§7)**
| Spec bullet | Status | Note |
| Upload by drag, picker or paste, ≤50 MB | done | all three in e2e; the cap is unit-tested |
| Video ≤500 MB in direct mode only; proxied blocks it with a message | done | recorded WebM plays for another member; proxied message |
| Allowlist; deny SVG, HTML, XML, scripts | done | SVG refused; the worker sniffs magic bytes |
| Filters: all, starred, PDFs, images, documents, notes | done | Starred in e2e |
| Preview: PDF, sanitized markdown, lightbox with arrows, swipe and strip, pkpass download | done | swipe and pkpass not in e2e |
| Star, description, download (also on bookings) | done | |
| Trash: restore, delete, empty, 30-day purge | done | purge runs in worker maintenance |
| Links to places, bookings, visits, expenses | done | two members linking at once keep both |
| Attach from the Puter drive, save to drive | partial | needs live `puter.ui`; hidden in the fake |
**P8 collab (§8), Q13 previews and feed**
| Messages ≤4,000 chars, replies, soft delete | partial | a deleted message vanishes from chat (the store drops tombstones); only Activity says "deleted a message" |
| Pages of 100 with Load older | done | 230 messages |
| Up to 4 images ≤10 MB | done | caption required (schema needs text) |
| Native emoji picker; 8 quick reactions; emoji-only enlarged | done | picker not in e2e |
| Link previews from the worker, SSRF guard, 60/min, cached | done | fixed (see above); private IP never fetched |
| Notes: title, markdown, category and 6 colors, website thumbnail, pin, attachments, expanded view, category filter | partial | the website "thumbnail" is the site's favicon; preview images exist in chat only |
| Links: title, URL, pinned, favicon chips | done | |
| Polls: options, multiple choice, deadline auto-close, manual close, delete, hidden results, voter avatars | done | |
| Activity feed from change records, 30-day note, per-trip unread badge on the dashboard | done | area and person filters |
**P9 members and Q7 public link (§9)**
| Roles owner, editor, viewer; guests | done | |
| Permission matrix editor | done | |
| Member colors, avatars, presence | done | avatars are initials in the fake (no `getProfilePicture`) |
| Join flow shows trip, owner and role, then confirms | done | the token leaves history |
| Invite by link: role, expiry, max uses, revoke | done | expiry uses the worker's clock, which the fake cannot advance (worker tests cover it) |
| Invite by Puter username; email through a personal link | done | |
| Remove, leave, change role | done | the role change applies on the member's open tab |
| Public link toggles, display currency | done | |
| Public link expiry, revoke, rotate | done | expiry not in e2e (worker clock) |
| Same components, read-only | done | |
| Language picker [3] | missing | phase 3 |
| One link for journey and road trip [3] | done | R11; not in the A4 specs |
| Trip ICS feed [2] | n/a | Q1, area A5 |
**Q8 and G1**
| Path A by events, no polling | done | |
| Revoked read handle: worker fallback, renew, back to path A | done | the member notices on the next poll (60 s) or focus |
| Presence with a revoked write handle | done | |
| State C stays on the worker | done | |
| Direct files without `/files` reads | done | the thumbnail PUT goes through the worker by design |
| Per-path file links | done | |
| Chat paste, drop and picker images | done | |
| Booking, receipt, place and collection uploads | n/a | entry points in A2, A3 and A6 |
### Shared code touched
- `src/styles/components.css`: `.choice[aria-checked="true"] .field-hint` uses `--ink-2`.
- `dev/fake-puter/bridge-playwright.js`: only a new URL (not a hash change) drops a page's bridge document.
- `dev/fake-puter/bridge-host.js`, `index.js`, `workers.js`: `openContext({as: null})` is a signed-out visitor; uncredentialed `workers.exec` is allowed.
- `dev/mock-trips.js`: `privateItem(ref, type, fields)`.
- `tests/e2e/helpers/bridge-world.js`: 30 s boot waits, `verified: false` for proxied trips, `open(null, hash)` documented.
- No `worker/` edits.
- Not in e2e: HEIC (Safari), upload progress and cancel, the 50 MB message, drive buttons (live), public link 429 and `snapshot_pending`, invite and link expiry (worker clock).
- Deleted messages keep no placeholder in chat; it needs the store to keep `msg` tombstones.
- Dashboard (A1): when a `me:spaces` event supersedes the first load, `headsAt` stays 0, so the next focus sends `heads` regardless of `HEADS_EVERY`.
- `emptyState({ level })` sets the title's heading level (default 3; 0 renders a plain title). Use 2 directly under a page `h1` (A1).
## A1: shell, dashboard, trip settings, settings, offline, notifications, week, help
Branch `trips/a1-tests` from `e0c48c621`, `TRIPS_E2E_PORT_BASE=8400`. Audited in `mock.html` with two or three users on the bridge world.
**P1 trips and dashboard (§1):** 20 done, 1 partial, 0 missing.
| Spec bullet | State | Note |
| Title (required), markdown description | done | e2e `trip-settings`; links stay http(s) only |
| Start and end dates, either empty, up to 999 days, N undated days (default 7) | done | form modes Dates / Number of days |
| Accounting currency | done | e2e |
| Cover: upload, paste, drag, Puter drive, image search | done | e2e upload and Openverse search; paste and drop in code; drive needs `puter.ui` (live) |
| Tags, archived flag, reminder days | done | the trip form now offers "On the first day", like the Reminders dialog |
| Create, edit, copy (choose what), archive, delete (owner); leave | done | e2e `dashboard` |
| Transfer ownership [3] | done | R10; A5 tests it |
| Days keyed by date; re-dating lays days out again | done | e2e |
| Shrink impact: places stay, day notes deleted, bookings kept or shifted, stays cancelled | done | e2e places, notes and shift; stay cancellation is unit-tested only |
| Moving the start keeps the length | done | e2e |
| Currency change re-bases expenses and pins rates | done | e2e with intercepted Frankfurter |
| Grid/list toggle | done | e2e, per device |
| Spotlight: countdown, companions, places, boarding pass | done | e2e (ongoing trip) |
| Sort ongoing → upcoming → past; filters planned / archived / completed | done | filters e2e by keyboard; sort unit-tested |
| Card menu, empty state, `#/new` | done | e2e |
| Widgets: per-device visibility and order | done | e2e: Settings → Dashboard in another tab now applies at once |
| Currency converter, time-zone clocks, upcoming reservations | done | e2e |
| Collections shortcut [2] | done | A6 tile, rendered in every dashboard run |
| Hero stats [2]: countries, trips, days travelled, distance flown | partial | the dashboard Atlas tile shows countries and continents; trips, travel days and distance flown are only on the Atlas page (A6 owns the tile) |
| Week overview [2] | done | e2e `week` |
| Onboarding tips in `me:prefs` | done | e2e (dismiss was broken, fixed) |
**P10 settings (§19):** 10 done, 2 partial, 1 missing.
| General (theme, units, date formats incl. ISO, 12/24 h, week start, currency, start page, default tab, descriptions, blur codes) | done | `settings.spec` |
| Appearance [1]: text size, high contrast | done | `settings.spec` |
| Appearance [2]: density, accent, phone tab-bar order | done | e2e together with high contrast in both themes |
| Reduced motion follows the OS, with an override | partial | the override can only force reduced motion (P10 note) |
| Map: style, labels, pills, routes, optimize from hotel | done | `settings.spec` |
| Custom map style URL [2] | missing | needs a prefs key (data-model contract) and support in the map module (A2); not small |
| Dashboard widgets per device | done | one layout per device type |
| Templates, categories, tags | done | `settings.spec` |
| AI: models, approval mode | partial | models done; approval modes were removed (55ac86da8), spec stale (A5) |
| Integrations [3] | done | renders with axe; flows are A5's |
| Travel documents vault [2] | done | `settings.spec` |
| Account and usage; sign out hidden in the desktop | done | `settings.spec` |
| Delete all my data [2], export offered first | done | e2e `delete-data` |
**P11 offline and PWA (§12):** 11 done, 1 partial.
| Service worker: precache, cache-first hashed, network-first navigations, never worker traffic | done | `offline-sw` unit tests |
| Stale-while-revalidate for the Puter SDK | partial | by design the SW never caches `js.puter.com` and relies on the HTTP cache (P11); offline cold boot depends on that (live check) |
| "New version ready — Reload" | done | unit only; the two-tab prompt is a live check |
| Replica, outbox, op ids, conflict parking | done | e2e offline edit and conflict |
| Ongoing and future trips kept; ended over 7 days evicted unless pinned | done | e2e kept and pinned; eviction unit-tested |
| Non-media attachments as blobs | done | unit only |
| Map tiles per trip box, 150 MB cap, persistent storage | done | unit only (live tiles) |
| Settings → Offline: force offline, re-sync now | done | e2e; Work offline survives a reload |
| Per-trip toggles, store-tiles toggle | done | e2e keep switch by keyboard |
| Cache sizes, Clear cache | done | e2e |
| Conflict list (keep mine / keep theirs / merge) | done | e2e Keep mine reaches the member |
| Offline edits sync on reconnect | done | e2e trip meta; expenses are A3's |
**Q13 reminders, week, help, delete-data, appearance:** 8 done.
| Item | State | Note |
| Trip reminders N days before (§20 [2]) | done | e2e Reminders dialog; the owner's days reach the member |
| To-do due reminders | done | unit; due to-dos show in the week e2e |
| Shown once on open; browser notifications while open | done | e2e: toast once, not after a reload, not in a second tab; a hidden tab gets one notification |
| Upcoming reminders list | done | was unsorted and worded relative to now; fixed |
| Week overview | done | e2e: two trips meeting on one day, owner and member |
| Help pages (§21 [2]) | done | palette drawer by keyboard; no `#/help` route (deferred by the shell task) |
| Delete my data | done | e2e: Bob's trip goes for Alice, Alice's trip stays |
| Density, accent, tab-bar order | done | e2e |
**R6 out-of-app notifications (§20 [3], §22):** 3 done, 1 partial.
| Webhook and ntfy for trip changes | done | settings e2e; delivery is live-only (handler unit tests) |
| Email digests for paid opt-in users | done | settings e2e; delivery is live-only |
| Channels per event; Slack and Discord formats (§22) | done | e2e 29-checkbox grid |
| Reminders out of the app | partial | sent on the next handler run after they fall due (no platform scheduled triggers) |
**Shell integration:** 6 done, 1 partial, 2 not covered.
| Presence in the trip header | done | e2e |
| Collab badge on every tab, cleared by opening Collab | done | e2e |
| Trip menu per role at both widths, by keyboard | done | e2e |
| Phone tab bar order and More by keyboard | done | e2e |
| Work offline, reload, offline boot | done | e2e (was broken: personal reads failed offline) |
| Dashboard tiles hidden and reordered from Settings | done | e2e |
| Banners: credit, outdated, gone, forbidden | partial | forbidden e2e; the others need a 402 or an old build on path A reads only, which `failNext` cannot target |
| Transfer notice above the Plan tab | not covered | A5 owns transfer |
| Background services once per sign-in | not covered | sign-out and sign-in on the bridge not exercised |
| Spec | Tests | Runs in the four projects |
| `dashboard` | create, edit seen by the member, filters, archive, copy, delete, leave; 402 and unverified email; `#/new`, tip and keyboard create; spotlight and widgets; the large fixture | 24 passed |
| `trip-settings` | three roles; shrink impact; shifted bookings; offline edit; currency re-base; covers | 24 passed |
| `trip-shell` | presence and Collab badge; trip menu and reminders; help; phone More; removed-member banner | 18 passed, 2 skipped (More is phone only) |
| `offline` | Work offline across a reload; conflict list; keep an ended trip, Clear cache | 12 passed |
| `week` | two trips on one day for owner and member; empty week | 8 passed |
| `reminders` | toast once across reloads and tabs; hidden-tab notification | 8 passed |
| `notifications` | render and URL checks; 402 and offline saves; secret not in the zip | 12 passed |
| `delete-data` | Bob deletes; Alice keeps her trip and sees his as unavailable | 4 passed |
| `settings` (7 added) | combined appearance and tab order; six sections render with axe | 28 passed |
Every spec checks axe and horizontal overflow on its views and attaches screenshots. The whole `test:e2e` run is 310 passed and 10 skipped (8 by design before A1, plus More on desktop); `test:e2e:bridge` 8 passed. `npx vitest run`: 2,543 tests, all passing alone; under machine load `vacay-view` (A6) sometimes exceeds its 5 s timeout.
### Fixes
- Worker `heads` paired a fresh rev with the isolate's meta cached up to 5 s before a commit, so members' dashboards showed (and wrote back) the old title.
- The dashboard's `onPrefs` handler threw on the changed-keys Set: dismissing the tip, widget changes and date or currency formats never re-rendered. Re-renders also dropped keyboard focus (filter arrow keys); focus now returns by `data-focus`.
- Offline cold boot: every personal store read failed because `auth.getUser` fails offline. The store now accepts the identity remembered for the same token, like the credential manager.
- Trips on a deleted worker (the owner ran Delete my data) stayed "Upcoming" with a stale note; they are now unavailable (live check added).
- Reminders dialog: upcoming list unsorted and worded relative to now; the trip form lacked the first-day choice and showed "0 days before".
- "1 photos" in the cover search; reminder notifications were tagged `lang: en`.
- Kit: `emptyState` heading level; menus open inside the anchor's `nav` (the phone More menu was outside every landmark); selected choice-card hints were 4.1:1 in dark mode.
- Dev: the bridge fixture follows in-app hash navigation; the mock hook has `list`, `conflicts`, a `base` option on `patch`, and records trip dates in `me:spaces`; bridge pages get 20 s to boot.
## A3: bookings, costs, lists

Branch `trips/a3-tests` from `e0c48c621`, `TRIPS_E2E_PORT_BASE=8500`. Two users (a third as viewer or observer where roles matter) on the bridge world, all four projects. Keyboard-only tests skip the phone projects.
| Spec | Covers | Result |
| `bookings.spec.js` | Two-leg flight from the airport picker, a stay across nights in the by-day view, viewer with hidden codes and filters, offline add and edit then reconnect, concurrent edit → conflict dialog, 402 and 403, keyboard add and confirm, form upload and one file linked to two bookings at once | 22 passed, 2 skipped |
| `costs.spec.js` | Shared and private expenses with the same balances for both users, settle up and the math, shares with a guest, itemised lines, settle all and undo, offline USD expense frozen on reconnect, stale edit → conflict, viewer's private expenses, CSV, splitting off, 402, keyboard add and Alt+Arrow reorder of expenses and categories | 18 passed, 2 skipped |
| `lists.spec.js` | Lists, bags and weights, per-person checks, pledges, viewer's private list, offline add and check, stale item edit → conflict, paste import with new bags, starter and saved templates, template file, to-dos with assignee, due date, priority and the reminder, Alt+Arrow reorder, 402 and 403 | 22 passed, 2 skipped |
| `booking-import.spec.js` | Paste and a text file read by the scripted `puter.ai`, card edits, Needs review for both users, source attached, duplicate → Update existing, a card without dates blocked until fixed, job running with the dialog closed, AI credit stop, Puter mail after the permission prompt (stubbed `puter.email`), reload mid-run → interrupted | 16 passed |
| `booking-move.spec.js` | A stay with a file and a sole expense moved to another trip for both members; a cut-off removal leaves a notice with Finish move and Keep both; move to a new trip | 8 passed |
| `receipts.spec.js` | Receipt scan prefill and photo attached (shared only), AI credit and offline, receipts staged in the form and attached in the detail, weight presets managed, picked and saved | 12 passed |
| `flight-status.spec.js` | Settings key (invalid, 402 on `kv.set`, save, show, offline, remove); intercepted AeroDataBox: delayed flight chip and details, 204, 401, 429, five days out with Check now offline and reload on reconnect, member without a key | 8 passed |
| `cost-extras.spec.js` | Payment plan with the rest due and Record a payment, per-currency balances and a USD settlement, an expense split across two trips, a budget seen by the other member | 12 passed |
Done means the behaviour exists and was exercised in the mock (e2e) or, where noted, by unit and worker tests.
**P4 bookings (spec §4)**: 17 done, 0 partial, 0 missing.
| 16 types (car pickup/return and stops) | done | |
| Status, code with blur, start/end with zones, location | done | e2e blur via Settings → General |
| URL, notes, linked place, visit, stay, travelers incl. guests | done | |
| Files: upload or link existing | done | e2e upload; the drive picker needs `puter.ui` (not in the fake) |
| One expense linked to several bookings | done | linked on the expense side |
| Needs review after imports | done | |
| Ordered legs with per-leg carrier, number, seat, class, code, platform, coach, zoned times | done | |
| Airport picker; location search with zone from coordinates | done | geocoding is refused offline in tests ("Search is unavailable") |
| Lodging range, check-in from/until, check-out, one place, no duplicate places | done | |
| Shown every night; anchors routes and scheduler | done | anchors are A2's Plan tab |
| Bookings and Transports views, type and traveler filters, status groups | done | one tab with an All / Transport / Stays switch |
| Inline in day timelines with manual position | done | Plan tab (A2) |
| Move to another or a new trip | done | |
| Import (§13), AirTrail [3], flight status [3] | done | AirTrail is A5's integrations |
**P5 costs (spec §5)**: 22 done, 0 partial, 0 missing.
| Any ISO currency, rate frozen at save; pending offline, frozen on reconnect; Refresh missing rates | done | Frankfurter intercepted |
| Reorder within a day and categories | done | keyboard |
| Day grouping, 14 categories, note, receipts, links | done | |
| One, several or no payers; unpaid counts in spend only | done | several payers by unit tests |
| Equal split leftover by expense id; paid parts; amounts, percent, shares with presets, items; guests | done | leftover rule by unit tests |
| Net balances, greedy simplify with switch, show the math | done | |
| Settlement in its own currency, settle all, edit, undo | done | |
| Cards, balances, per-person cost, category bars, display currency | done | display currency uses live rates (≈) |
| Split-costs switch, solo default off | done | |
| Ledger search, category, day and view filters | done | |
| CSV (semicolon, BOM) | done | |
| Private expenses | done | |
| [3] partial payments, per-currency, across trips, budget | done | `cost-extras.spec.js` |
| Correctness rules | done | stale form edits now park a conflict (fixed) |
**P6 lists (spec §6)**: 13 done, 0 partial, 0 missing.
| Lists with colors; items with qty, done, weight, bag | done | |
| Rename, check all, uncheck all, delete, assignees | done | |
| All / open / done, progress | done | |
| Shared, assigned, private tiers; My list and Shared | done | |
| Pledges, copy to my list, per-person checks | done | |
| Bags: auto color, kg or lb limit, members, fill bars, not in a bag | done | the unit follows Settings (lb in en-US) |
| Paste or CSV/TXT import with comma, semicolon or tab | done | |
| Personal templates, starters, template file | done | |
| To-dos: list, due, markdown notes, assignee, P1–P3 | done | |
| Filters, sort, detail, reorder, list assignees, to-do templates | done | |
| Due reminder on open; VALARM in the feed | done | reminder fixed; VALARM is A5's ICS spec |
**Q4 booking import (spec §13)**: 8 done, 0 partial, 1 missing.
| Choose or drop files (PDF, image, EML, HTML, TXT, PKPass) | done | chooser e2e; drop, PKPass and EML by unit tests |
| Paste text | done | |
| Puter mail: forward, then pick | done | stubbed `puter.email` and `perms.request` |
| Background mail capture into `me:import:*` | missing | needs a published events handler and live Puter (Q4 gap) |
| PKPass and EML parsed locally | done | unit tests |
| Claude with a JSON schema, deterministic checks | done | `puter_path` with `outputFormat` is F0 live check #9 |
| Review cards, edits, duplicate warnings | done | |
| One batch, source files attached | done | |
| Survives navigation, progress, IndexedDB | done | the first save is now immediate (fixed) |
**Q12, R8, R11, G1 (A3 parts)**: 12 done, 1 partial, 0 missing.
| Receipt OCR into an expense, photo attached, private refused | done | |
| Weight presets | done | |
| Move a booking, unfinished-move notices | done | Carol's worker and an edit during a move: unit and worker tests only |
| Flight status key in Settings | done | |
| Flight status in rows and details, provider errors, windows | done | row chips fixed |
| Gate, terminal and belt changes between answers | partial | unit tests only; a second answer comes from the 10-minute cache |
| Partial payments, per-currency, across trips, budget | done | |
| Booking form and expense receipts upload, detail attach | done | |
| Concurrent links of one file | done | |
| Old `links[]` lists | done | unit and worker tests |
| Private expense has no receipts | done | |
| Transit (R8) | done | Plan tab, A2 |
| Vault (Q12) | done | Settings, A1 |
### Fixed
- The Costs tab showed "nullnull…" above the summary: `replaceChildren` turned null and false into text there and in the Balances tab, expense detail, budget, receipt review, import inputs, move dialog and booking files list.
- Booking rows never showed the flight status chip (the first load notification dropped the detached chip). An offline manual check had no way out; it now offers Try again and resends on reconnect. Flight status headings were h4/h5 under the dialog's h2.
- Saving an expense or packing item over a change made while its form was open overwrote it; the form-open base now parks a 409, as bookings do.
- The due to-do reminder missed to-dos that arrived after the trip meta.
- A reload right after starting an import lost the job.
- "You owes" in balances. The booking form says "Saved on this device" when the browser is offline.
- Axe: Costs and Lists heading order (visually hidden h2s), the bags `aside` nested in a region (now a section), the sortable live region inside a `ul`, file picker size contrast on a chosen file.
### Shared code
- `src/ui/dnd.js`: the live region goes after `ul`/`ol` containers.
- `src/lib/files/files.css`: picker size contrast.
- `dev/fake-puter/bridge-client.js`: calls made during a reconnect wait for it (the app's first sync used to hit the offline bridge and back off for seconds).
- Cherry-picked unchanged from other areas: A2's tab badge clip (`src/views/trip/shell.css`), A5's choice hint contrast (`src/styles/components.css`), A5's hash navigation in `dev/fake-puter/bridge-playwright.js`.
### Notes for spec writers
- `tests/e2e/helpers/trip-flows.js`: `tripFor` (per-member roles, currency, and the days the mock hook does not create), `seed`, `patientWorld` (20 s boot allowance on a loaded machine), `failNextCommit(page, status, code, {match})`, `tabTo`, `arrowTo`, `choose`, `fakeRates`, `download`.
- `world.failNext({method: 'workers.exec'})` can be taken by a presence or other worker call; `failNextCommit` fails the page's next matching request instead.
- Wait for another user's page to show a change before relying on it being on the worker: the saving indicator can still read "synced" before a new send starts.
- Uploads are deduplicated by content, so give each test file different bytes.
## A5 results: imports and exports, calendars, print, assistant, integrations, transfer
Branch `trips/a5-tests` from `cd3411047`, `TRIPS_E2E_PORT_BASE=8600`. Every flow runs on the bridge world with two or three accounts, in all four projects. The assistant uses the scripted `puter.ai`; integrations use recorded fixtures behind an intercepted `puter.net.fetch` (`fakeNet` in `helpers/trip-tools.js`).
| Spec | Tests | Runs (4 projects) | Covers |
| --- | --- | --- | --- |
| `io.spec.js` | 6 | 24 passed | Trips-file round trip (export, import as a new trip, export again, normalized equal); another member imports (the exporter becomes a guest, private items skipped); a viewer's locked merge; GPX, KMZ and KML import with duplicates and undo, seen by the editor; GPX, KML and KMZ export content; download all my data (zip content, 402 and retry, files, Bob's personal-only zip); viewer refused; offline queueing; a keyboard path |
| `ics.spec.js` | 4 | 16 passed | File content in local zones and per-member to-dos; day and reminder options; feed links for owner, editor and viewer, another device, rotate, turn off, ETag; keyboard; 402, 429, offline; the all-trips feed merging two workers, rotate and off |
| `assistant.spec.js` | 4 | 16 passed | A streamed proposal applied only after Apply and seen by the editor; Undo; Reject; a change by the other user during review re-asks; visits on day 1; a date suggestion through the re-date preview; a viewer without propose tools; 402, 429 with retry, offline; keyboard (Enter, Shift+Enter, Escape) |
| `print.spec.js` | 2 | 8 passed | Light paper in both themes, cover stats, sections, day range, compact and detailed, orientation, text size, the other member's edit in the open preview, Print and Mod+P, Escape returns focus, options kept per device; offline route summaries; the phone Options/Preview switch |
| `transfer.spec.js` | 2 | 8 passed | Offer to an editor with a viewer watching; accept; a forced `fs.write` failure pauses at the files step; the frozen trip and a parked edit; reload and Resume from Members; the file copied; the viewer follows to the new trip; the old owner's stub, replayed edit and stub deletion; decline, withdraw, the owner stopping a paused move |
| `integrations.spec.js` | 5 | 20 passed | Settings for AirTrail, Immich and Dawarich (http warning, wrong key, sync switch, keys only to their own server, disconnect); AirTrail review (new, linked, changed), write-back, badge, viewer; Immich photos into files; Dawarich stays to places and a dismissal across devices; a Google Maps short link; days from photos with AI names |
**Q3 imports and exports (§10).** Done 9, partial 0, missing 1.
| GPX export: whole trip, places only, days as routes, category | done | The category is in `<type>`; `<sym>` holds the GPS symbol mapped from it |
| KML and KMZ export | done | KMZ holds `doc.kml`, equal to the KML export |
| JSON export and import of a whole trip, versioned | done | The round trip compares equal; invalid entities are dropped and counted |
| Exports never include other people's private data | done | |
| Download all my data, to the device or Puter | done | Save to Puter needs live `puter.ui` |
| GPX/KML/KMZ import: waypoints to places, tracks and routes to places with their track | done | Fixed: unnamed waypoints were offered again as new |
| Viewer refused, offline waypoints queue, tracks report the failure | done | |
| Import into an open trip, groups locked by permission | done | |
| Google Maps shared lists [3] | missing | Deferred: needs scraping Google pages (policy risk) |
| CSV export of costs | A3 | Costs module |
**Q1 calendar (§10 ICS, §9 all-trips feed).** Done 10, partial 1, missing 0.
| Trip as an all-day span | done | |
| Timed visits in the place's zone, location = address | done | |
| Per-day all-day summary of untimed items | done | |
| Reservations in endpoint zones | done | |
| Stays as all-day spans | done | |
| VALARM reminders | done | Flights 3 h, to-dos 09:00; trip alarms follow `meta.reminderDays` |
| Leave day events out | done | In the file and as `?days=0` on the feed |
| Short events keep their length | done | Unit-tested |
| Live feed per member: create, rotate, turn off, another device | done | Feeds follow the worker snapshot (200 revisions or 10 minutes), so e2e checks content, not live change; `tests/worker/ics.test.js` covers ETag changes |
| All-trips feed from the user's worker | done | |
| Puter Calendar hand-off | partial | Desktop only (`puter.env === 'app'`); Calendar does not read launch items yet |
**Q2 print (§10 PDF).** Done 6, partial 1, missing 0.
| Cover with stats | done | |
| Route map image | partial | The bridge blocks tiles, so e2e covers the summary fallback; the image path needs the `tests/map` fixtures |
| Day pages: timeline, notes, transports, the stay | done | Place photos need trip files (not covered) |
| Bookings | done | |
| Options: page break, sections, text size, orientation, compressed images | done | |
| Markdown rendered | done | |
| Prints the trip only, light in both themes, Mod+P, Escape returns focus | done | |
**Q5 assistant (§13).** Done 6, partial 3, missing 1.
| Side panel per trip, streaming | done | Fixed: text streamed before a proposal never showed |
| Every change approved first, no approval modes | done | Spec updated; product decision to confirm |
| Undo per approved change | done | |
| Read the trip | done | |
| Suggest an itinerary for a day | done | |
| Fill a packing list | done | |
| Search places | partial | The map search tool needs the live geocoder |
| Create or edit days, places, visits, reservations, list items, expenses | partial | Adds visits, places, packing items and to-dos, moves visits, suggests dates; no edits or deletes, and nothing for days, reservations or expenses |
| Weather for packing | partial | Needs live weather services |
| `web_search` | missing | Server-tool streaming is unverified offline |
**R7 and R11 integrations (§21, §22; days from photos, §13).** Done 9, partial 2, missing 1.
| AirTrail pull: review, link, update, dismiss, badge | done | Fixed: a linked flight came back as changed on every pull |
| AirTrail write-back | done | |
| Immich photos to trip files | done | |
| Dawarich stays as place suggestions, dismissals in `me:dawarich` | done | |
| Keys stay in `me:integrations`, go only to their own server, never exported | done | |
| Import a Google Maps route link (full and short) | done | |
| Days from photos (EXIF time and GPS, AI names) | done | Fixed: stop checkboxes had no label. Drive and folder sources need live `puter.ui` |
| Viewers get no entries; offline disables them | done | |
| Dawarich stays as journal entries, bucket and atlas matches, day trails | partial | Unit-tested; trails need map tiles |
| Google directions vias for road trips | partial | Needs the road-trip add-on; unit-tested |
| Google Places key, public API or MCP | missing | Deferred by decision (R11) |
**R10 ownership transfer (§1).** Done 6, partial 0, missing 0.
| Offer, accept, move to the new owner's worker | done | |
| Members rejoin with their roles; the old owner becomes an editor | done | |
| The old copy stays as a stub until the old owner deletes it | done | |
| Resume after a failure, across a reload | done | Fixed: Members now offers Resume for a paused move |
| Edits during the freeze park and are re-applied | done | |
| Decline, withdraw, the owner stops a move; viewers cannot offer | done | |
- Import: unnamed GPX waypoints were never marked as duplicates (`views/io/import.js`).
- Assistant: text streamed before a tool call was dropped, leaving an empty busy bubble (`views/trip/assistant/panel.js`).
- Transfer: a paused move showed "You are moving this trip" with no way to resume from Members (`views/trip/transfer/section.js`); a finished move printed "nullnullnull" (`dialog.js`).
- AirTrail: linking stored the booking's own hash, so the flight was offered as changed on every pull and counted in the badge (`lib/integrations/airtrail.js`, unit test added).
- Days from photos: unlabeled checkboxes (axe).
- UI kit: the hint under a selected choice was 4.1:1 in dark mode (axe).
- `dev/fake-puter/bridge-playwright.js`: hash navigation keeps the bridge session.
- `dev/mock-trips.js`: `putPrivate(ref, type, fields)`.
- `tests/e2e/helpers/bridge-world.js`: a `device` option for a second browser of one account; `sharedTrip({owner, members, role: {member: role}})`; `noOverflow` also checks `innerWidth`; 20 s boot waits.
- New `tests/e2e/helpers/trip-tools.js`: `seed`, `read`, `download`, `chooseFiles`, `tripMenu`, `planPane`, `placeNames`, `synced`, `fakeNet`, `workerGet`, `routeWorkerFetch`, `press`.
### Findings for other areas
- **Phone emulation widens the layout viewport (A1).** On trip pages, Chromium's 390 px emulation sometimes reported `innerWidth` 552 while `visualViewport` stayed 390×844, and pointer clicks on menus, sheets and panels landed beside their targets. Cause (final run): the Collab tab badge's hidden "N unread updates" label, whose right edge sits at 551.7 px in an unscrolled tab strip, escaped the strip while the badge's lazily loaded CSS had not applied. A2's `.trip-tabs { position: relative }` contains it; `collab.spec` guards it. A5 specs still activate those controls with `press()`.
- **Plan tab (A2).** The `landmark-unique` and 1284 px findings still stand; A5 audits its dialogs over the trip Settings or Members tab.
### More notes for writing module specs
- Workers run inside the Playwright Node process. A worker's own `fetch` of another worker (the all-trips feed) needs `routeWorkerFetch(w)`, or it would go to the network.
- Worker time is the real `Date.now()`: snapshot-based routes (ICS feeds) change only after a rebuild, so assert content after the first build.
- `failNext` matches the method and account only. Arm it right before the call you mean (the transfer spec waits for the settle step first).
- `noOverflow` now fails when phone emulation has widened the viewport, which the old check missed.

## Final run

Every check on `trips/final-run` (`trips/full-build` at 545529963, then merged with the final scan at 297230335, its polish at f589d7c38 and the KV-share reconcile at 0cd6fcfda), offline, `TRIPS_E2E_PORT_BASE=9000`, Playwright `--workers=3`. Counts are in [status.md](status.md#verification).

The first `test:e2e` run on 545529963: 816 tests, 774 passed, 18 failed, 24 skipped. Twelve were drift (two collections tests and the book test, in every project) and six were flakes; the known items are included:

| Spec | Cause | Fix |
| --- | --- | --- |
| `collections.spec` ×2 (all projects) | The place sheet's rating radios became "N of 5 stars" (A2); "5 stars" matched all five and "4 stars" none | Exact labels |
| `book.spec` nudge (all projects) | Elements are placed with logical insets since the RTL pass, so `style.left` was empty on both sides | Read `insetInlineStart`; Bob must show Alice's new position |
| `costs.spec` category order (known) | The shell showed "Up to date" during the 400 ms outbox debounce and the commit, with changes still pending; `synced(alice)` passed before the reorder reached the worker, Bob's fresh page loaded the old order and the open form kept it | App: `synced` with pending changes shows "Syncing…" (`src/main.js`) |
| `transfer.spec` ×2 (known) | Setup waited for `getByText('map.png')`, which matched the upload-progress row, then closed the page mid-upload: no file to move, so the armed `fs.write` failure never fired and the move finished | Wait for the file's row and the end of the upload |
| `collab.spec` chat paging (also failed in the reconcile run) | `trips.flush` sent one batch or joined the one a background flush had in flight; the setup page closed with messages 228–230 unsent | `trips.flush` (mock hook) sends everything pending |
| `schedule.spec` (phone) | A visit's menu opened as the day card re-rendered with travel estimates: the anchor was replaced, the scroll position shifted and the menu closed on the scroll; the click waited for it until the test timed out | App: menus follow their anchor through scrolls, stay put when a re-render replaces it, and close when it scrolls off screen (`src/ui/menu.js`) |
| Credit refusals in `bookings`, `costs`, `lists` (bookings failed once in the reconcile run) | A one-shot 402 left the batch queued without a hold; the engine's next poll or wake-up resent it and cleared the credit state, sometimes before the spec checked the message or pressed Retry | `failNextCommit(…, {times: Infinity})` until the message is checked, then `stopFailingCommits` and Retry |
| `ics.spec` teardown | Closing a world's contexts at once zipped a shared trace resource mid-write ("file data stream has unexpected number of bytes") | Close contexts one at a time |
| Phone pages at 552 px (known) | The Collab badge's hidden label (right edge 551.7 px in an unscrolled tab strip) escaped the strip before its CSS loaded; A2's `.trip-tabs { position: relative }` contains it | `collab.spec` checks the label stays in the strip and the page does not overflow |
| `vacay-view`, `atlas-view`, `shell` unit timeouts (known) | Already fixed by 328db6074 (waits on results with 10 s and 30 s limits) | Full `vitest` passed three times under Playwright load (load average 12–19) |

`test:e2e` no longer runs `fake-bridge.spec.js` (it ran in all four projects on top of `test:e2e:bridge`); 32 fewer runs.
