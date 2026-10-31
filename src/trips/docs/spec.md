# Trips feature spec

This is the feature checklist (October 2026), described by behavior.

**Clean room:** do not open or copy another product's source, strings, translations, CSS, icons or wiki text. Work from this spec and the running app. Code comments never say a design is modelled on another product.

**Tags:**
- **[1]** phase 1 (core)
- **[2]** phase 2
- **[3]** phase 3
- **[P]** changed or better on Puter
- **[x]** dropped, with the reason

Unmarked bullets inherit their section's phase. Backlog items from the public board that we take are folded in and marked **(board)**.

## 1. Trips and dashboard [1]

**Trip fields**
- Title (required) and a markdown description.
- Start and end dates. Either can be empty, and trips can be up to 999 days. An undated trip gets N undated days (default 7).
- Accounting currency.
- Cover image: upload, paste, drag, or **[P]** pick from the Puter drive, or search Openverse/Wikimedia (Unsplash needs a key).
- Tags **(board)**, archived flag, reminder days.

**Trip actions**
- Create, edit, copy (choose what to copy), archive, delete (owner).
- Leave a trip.
- Transfer ownership **[3][P]**: export to the new owner's worker (architecture §16).

**Re-dating**
- Days are keyed by date. Changing dates lays days out again.
- Shrinking a trip shows an impact list:
  - places stay in the pool;
  - day notes are deleted;
  - bookings are either kept on their dates or shifted with the trip;
  - stays touching removed days are cancelled.
- Moving the start date keeps the trip's length.

**Changing the trip currency** re-bases expenses and pins their old rates.

**Dashboard**
- Grid/list toggle.
- Spotlight card (ongoing or next trip: countdown, companions, places, "boarding pass" for the next transport).
- Sort ongoing → upcoming → past. Filters: planned / archived / completed.
- Card menu: edit, copy, archive, delete. Empty state. Deep link `#/new`.

**Dashboard widgets**
- Per-device visibility and order.
- Currency converter (Frankfurter).
- Time-zone clocks.
- Upcoming reservations.
- Collections shortcut **[2]**.
- Hero stats: countries, trips, days travelled, distance flown (from flight legs) **[2]**.

**Other**
- Week overview of upcoming trips **(board)** **[2]**.
- Onboarding notices: first-run tips, dismissible, stored in `me:prefs`.

## 2. Day planner [1]

**Layout**
- Desktop: three panes (day plan | map | places), resizable.
- A day detail panel over the map shows weather, the day's bookings and the stay.
- Mobile: a day-chip rail, a plan/map toggle, and sheets for everything else.

**Days**
- Dated or undated.
- Add an undated day, or "add <next date>" to extend the trip.
- Delete a day: show the impact first, then later days shift up. Impact rules:
  - its visits are removed, but their places stay in the pool;
  - its day notes are deleted;
  - its bookings are unassigned from the day;
  - stays spanning the day are shortened;
  - stays that check in or out on that day are cancelled, and linked expenses are offered for deletion (default keep).
- Deleting a booking or a place only unlinks its expenses. If it was an expense's last link, ask whether to delete the expense too.
- Reorder days (content moves with them).
- Title, markdown notes, a default transport mode and a color.

**Places pool**
- Fields per data-model §3.1. Search, category filter, and all/unplanned/planned/tracks filters (scoped to the open day). Rating filter.
- Multi-select with bulk category, delete, save to collection (with Collections, phase 2) and mark visited.
- Create a place:
  - from search;
  - by right-click or long-press on the map (reverse geocode);
  - by pasting "lat, lng";
  - by pasting a Google Maps or OSM link (**[P]** parsed locally where the link carries coordinates or a query; no server scraping). Short links (`maps.app.goo.gl`) are followed with `puter.net.fetch`, reading only the `Location` header, then parsed.
- Custom image: upload ≤20 MB, HEIC converted in the browser.
- Per-user 1–5 star ratings with averages.
- Overlap and end-before-start warnings.
- Attach files. "Create expense" links an expense to the place.
- Open in Google Maps, Apple Maps, OSM, Waze or CoMaps (deep links).

**Visits** (a place on a day)
- The same place can be on several days.
- Start/end time, notes, outgoing/incoming leg mode, participants (members and guests), multi-day `endDayId`.
- Drag from the pool onto a day or between items. Reorder within and across days. Mobile drag to another day **(board)**. Context menu.
- Visits without a place: a timed item with only a title **(board)**.
- **Time-aware scheduling (board, top request)**:
  - dwell time per visit;
  - travel time from routing;
  - "auto schedule" from a day start time or hotel departure;
  - pinned visits act as anchors;
  - late warnings.
- Alternatives per time slot (Plan A/B) **[3] (board)**.

**Day timeline**
- Merges visits, day notes and non-lodging reservations by time and manual position (`dayPos`).
- Phase labels for multi-day bookings: flight departure / in transit / arrival; car pickup / active / return; parking drop-off / pick-up; other start / ongoing / end.
- Multi-leg bookings show one row per leg.
- Travel connectors between stops show time, distance and a mode icon. Click one to change the mode or open transit search **[3]**.
- Stop numbers on the map and in the list **(board)**.

**Day notes**
- Title, markdown detail, optional time, an icon (32 allowed) and a color.
- Reorder by drag, and move between days.

**Other planner features**
- Undo/redo for place and visit edits, reorders, optimize and imports (client-side, per session). Day delete is not undoable; it confirms instead.
- "What's next": the next 8 timed items across days.
- Categories: built-in 10 (hotel, restaurant, attraction, shopping, transport, activity, bar/café, beach, nature, other), each with a color and icon. Trip and personal custom categories **[P]** (no admin list).
- Personal tags. These are per user: each member sees only their own tags on a place. Choosing a personal category copies it into the trip's categories.
- Keyboard shortcuts **(board)**: a registry with a `?` help sheet, plus ⌘K command palette, J/K between days, N new place, / search.

## 3. Map, search, routing [1]

**Map**
- MapLibre GL with OpenFreeMap styles: positron/liberty in light, dark in dark. Swap on theme change.
- Satellite layer: ESRI World Imagery, with attribution.
- Markers: photo or category icon, order badge, selection, rating disc, hover card, clustering.
- Show place names next to markers (toggle) **(board)**.
- Location button (show/follow), compass, layer switcher, attribution.
- Lines:
  - per-day route (toggle, remembered per trip);
  - whole-trip route colored by day, with per-day and total distance;
  - booking overlays: geodesic arcs for flights, cruises and ferries; routed lines for car, bus, taxi and bike; straight or multi-stop lines for trains. Confirmed bookings solid, pending dashed. Endpoint pills with IATA or station codes;
  - imported GPX/KML tracks.
- POI explore pills (restaurants, cafés, bars, lodging, sights, museums, nature, activities) for the viewport, with "search this area". Data from Photon's `osm_tag` filters [services.md].

**Search**
- Autocomplete from Photon, biased to the viewport or the open day's centroid. Nominatim is the fallback for full search.
- Results tagged with their source; dedupe within 60 m by name.
- Optional user-supplied Google Places key **[3]**. It needs a Google map for display, so it is likely dropped.

**Place details** (phase [2])
- Description: OSM `description`, then Wikivoyage/Wikipedia in the user's language via Wikidata.
- Photos from Wikimedia Commons with author and license credit.
- Opening hours from OSM (`simple-opening-hours`), with an open/closed badge in the place's time zone.
- "Good to know" facts from OSM tags.
- AI summary on demand **[P]**, labelled as AI and checked against the place's location.

**Routing**
- FOSSGIS OSRM car/bike/foot, throttled and cached on the client. Valhalla when avoiding tolls, motorways or ferries **[3]**.
- Straight-line fallback (×1.25 at mode speed).
- Legs reset at transport bookings.
- Day routes start and end at the day's stay when one exists.

**Other map features**
- Optimize: nearest neighbour then 2-opt on distance. Locked and timed stops stay. Optional anchoring at the hotel (loop, or hotel to hotel on transfer days). Undoable.
- Export a day as a Google Maps directions URL or a CoMaps link.
- Public transit search **[3]**: depends on provider licensing [services.md]. Until then, deep links to Google or Apple transit directions.

## 4. Reservations, transport, lodging [1]

**Types (16)**
- Transports: flight, train, bus, car (rental or own; pickup/return; stops along the way), taxi, bike, cruise, ferry, public transit, other.
- Bookings: lodging, restaurant, event, tour, parking, other.

**Common fields**
- Status (pending/confirmed), confirmation code (blur option), start/end day and time with time zones, location.
- Link URL, notes, linked place/visit/stay, travelers (members and guests).
- Files: upload or link existing.
- Linked expenses: one expense can link to several bookings **(board)**.
- "Needs review" flag after imports.

**Multi-leg flights and trains**
- An ordered list of legs.
- Each leg has its own airline or train, number, seat, class, booking code, platform, coach and times with time zones.
- Airport picker from the bundled airport database (IATA, name, city, country, coordinates, time zone). Other endpoints use location search with a time zone from coordinates.

**Lodging**
- A reservation with a date range (`fromDayId` → `toDayId`), check-in from/until and check-out, linked to one place.
- Shown on every night of the stay. Anchors routes and the scheduler. Creates no duplicate places **(board)**.

**Lists and day placement**
- Bookings tab and Transports tab with type and traveler filters, and pending/confirmed groups.
- Bookings appear inline in day timelines with manual position.

**Moving bookings**
- Move a booking to another trip or a new trip **(board)** **[2]**.

**Import and integrations**
- Import: §13.
- AirTrail **[3][P]**: the user's own server via `puter.net.fetch`, key in their KV, a periodic pull while the app is open. Synced items keep `src.ext` and `src.hash`.
- Flight status **[3]**: only with a user-supplied key [services.md].

## 5. Costs [1]

**Expenses**
- Name, amount, currency (any ISO 4217) and a rate to the trip currency, frozen at save (Frankfurter).
  - Offline, the rate is saved as pending (`rate: null`) and frozen on reconnect. Pending expenses are flagged.
  - "Refresh missing rates" freezes any still pending.
- Reorder expenses within a day, and reorder cost categories.
- Date (grouped by day, or "no date") and one of 14 categories: accommodation, food & drink, groceries, transport, flights, activities, sightseeing, shopping, fees & tickets, health, tips, fuel, parking, other.
- Note, receipts (files), links to bookings, visits or places.

**Payers**
- One payer, several payers with amounts (must sum to the total), or "unpaid". Unpaid expenses count toward spend, not toward balances.

**Splits**
- Equal: integer minor units. The leftover minor units are spread one per person, starting at a member chosen by the expense id, so the same person does not always absorb them.
- A participant's share can be marked paid (`parts[].paid`), and balances account for it.
- Amounts.
- Percent **(board)**.
- Shares/weights **(board)**, with reusable weight presets per trip **[2]**.
- Itemised ticket lines, each assigned to people.
- Members and guests can both be split participants.

**Settling up**
- Net balances in the trip currency.
- Debt simplification (greedy), with a switch to turn it off and a "show the math" view **(board)**.
- Record a settlement (own currency and rate), "settle all", manual payment, edit and undo.

**Overview and export**
- Cards: you owe, you're owed, outstanding, total spend.
- Balances, final budget per member, by-category bars, per-person summary, display-currency conversion.
- Per-trip "split costs" switch: when off, costs are a plain spend tracker with no balances **(board)**. Solo trips default to off.
- Ledger with search, category and day filters, and all / paid by me / I'm owed views.
- CSV export (semicolon separated, UTF-8 BOM).

**Private expenses** **(board, planned)** **[P]**: kept in the member's KV and merged into their own view only.

**Later [3]**: partial payments with a due date, per-currency balances, an expense split across trips, and a pre-trip budget planner **(board)**.

**Correctness rules** (from the upstream bug history):
- Never rewrite payer or split lists implicitly.
- Removing a member keeps their historical payments and shows them as a former member.
- Mixed currencies always convert through the frozen rate.
- Editing a linked booking never touches the expense amount.

## 6. Lists [1]

**Packing**
- Lists (categories) with color dots. Items have name, quantity, done, weight and bag.
- Category actions: rename, check all, uncheck all, delete. Category assignees.
- Filters: all, open, done. A progress bar.

**Visibility tiers**
- Shared (default).
- Assigned to specific members.
- **Private [P]**: in the member's KV, so nobody else can see it.
- "My list" and "Shared" views.
- "I can bring that too" pledges. Copy an item to my list.
- Per-person checkboxes mode **(board)**.

**Bags**
- Name, auto color, weight limit (kg or lb **(board)**), members, totals, fill bars, and an unassigned section.

**Import and templates**
- Paste or CSV/TXT import, one item per line: `List, Name, Weight, Bag, checked` (comma, semicolon or tab).
- Templates **[P]**: personal templates for every user, not admin-only **(board, planned)**.
  - Save as template; apply a template (appends items).
  - Built-in starter templates.
  - Share a template as a file.

**To-dos**
- Name, done, list, due date, markdown description, assignee (member or guest), priority P1–P3.
- Filters: all, mine, overdue, done, per list. Sort by priority. Detail pane. Reorder. List assignees.
- To-do templates **(board)**.
- Due reminders: in-app on open **[1]**, plus VALARM in the trip feed **[2]** **[P]** (no server cron).

## 7. Files [1]

- Upload by drag, picker or paste: ≤50 MB. Video ≤500 MB **[2]** works only in direct file mode (the owner can share folders). Proxied mode blocks it with a clear message.
- Allowlist: images including HEIC, PDF, doc/docx, xls/xlsx, txt, csv, md, pkpass/pkpasses. Deny SVG/HTML/XML, scripts and executables.
- Filters: all, starred, PDFs, images, documents, collab notes.
- Preview:
  - PDF in the browser viewer;
  - markdown rendered and sanitized;
  - images and video in a lightbox with arrows, swipe and a thumbnail strip;
  - `.pkpass` downloads with the right mime type.
- Star, description, download (button on bookings and transports too **(board)**).
- Trash: restore, permanent delete, empty trash, 30-day purge.
- Links from one file to many places, bookings, visits and expenses.
- **[P]** Attach from the Puter drive (picker; copied into the trip) and "Save to my drive".
- **[x]** Storage backends, mirroring, and document sync with Paperless, Papra, Nextcloud, OpenCloud and Synology: Puter FS is the store.

## 8. Collab [1]

**Chat**
- Messages ≤4,000 chars, replies, soft delete ("deleted a message").
- Pages of 100 with "load older".
- Up to 4 images per message, ≤10 MB each.
- Emoji picker using native emoji; no bundled emoji images.
- 8 quick reactions. Emoji-only messages enlarged.
- Deleting a message removes its text from the trip. Members who already synced it, and the 30-day change log, still hold it until it expires; the UI does not promise more.
- Link previews **[2]**: fetched by the worker with SSRF guards (copy `src/teamchat/worker` unfurl), 60/min per member, cached.

**Notes**
- Title, markdown body, category with one of 6 colors, website with a thumbnail, pinned, attachments, expanded view, category filter.

**Links**
- Title and URL, pinned, favicon chips.

**Polls**
- Question, 2+ options, multiple choice, optional deadline (auto-close on read after the deadline), manual close, delete.
- Results hidden until you vote. Voter avatars.

**Activity feed [P]**
- Per-trip feed derived from change records: who added, changed or removed what.
  - Change records carry a summary (`sum`) with each entity's name and the changed fields, so deletes stay readable.
  - Clients keep the feed in IndexedDB as they sync. The worker keeps 30 days; the UI says so.
- An unread badge per trip on the dashboard.
- This replaces in-app notifications for trip events.

## 9. Members and sharing [1]

**Roles and access**
- Roles: owner, editor, viewer **(board: view-only)**, plus guests (no account).
- Per-trip permission matrix editor (data-model §5).
- Member colors, avatars (`puter.auth.getProfilePicture`), and presence ("here now").
- The join flow shows the trip, owner and role, then asks for confirmation.

**Invites**
- Invite by link (role, expiry, max uses, revoke).
- Invite by Puter username **[P]**: a labelled KV share of an invite stub, so their Trips app gets a `kv.share.received` notice and lists it. Invites by email use a personal link.
- Remove a member, leave, change role.

**Public read-only link** **[2]**
- Toggles: plan with map, bookings, packing, costs (in the sharer's display currency), chat.
- Optional expiry, revoke and rotate.
- Same components as the app, read-only. Language picker **[3]**.
- One public link that covers the journey and road trip too **(board)** **[3]**.

**Trip ICS feed** **[2]**
- Token URL, rotate, revoke. `webcal://`, Google Calendar "add by URL", and copy buttons.
- Every member gets their own feed token for each trip, scoped to their role, so editors and viewers can subscribe without `share.manage`.
- An "all my trips" feed (excluding archived trips and trips that ended more than 90 days ago) is served by the user's own worker **[3]**.

## 10. Exports and imports [2]

**Exports**
- ICS: one-off file export and the live feed.
  - The trip as an all-day span.
  - Timed visits in the place's time zone (location = address).
  - A per-day all-day summary for untimed items.
  - Reservations with endpoint time zones.
  - Stays as all-day spans.
  - VALARM reminders.
  - Option to leave day-name events out **(board)**.
  - Events shorter than an hour stay at their real length.
- PDF via a print view:
  - a cover with stats;
  - a route map image baked from the map canvas;
  - per-day pages with a merged timeline, photos, notes, transports and the stay;
  - bookings;
  - options: page break per day, sections, font size, orientation, compressed images **(board)**.
  - Markdown is rendered in the PDF **(board)**.
- GPX export: the whole trip, places only, or days as routes, with the category in `<sym>`.
- JSON export and import of a whole trip (versioned schema) **(board)**, used for backup, copy and transfer.
- CSV export of costs.
- "Download all my data": a zip of every space I own plus my personal KV, saved to my Puter drive or this device.

**Imports**
- GPX/KML/KMZ: waypoints become places; tracks and routes become places with track geometry and color, with start and end kept separately.
- Google Maps shared lists **[3]**: needs a fetch from Google pages, which has policy risk; likely dropped.
- Naver lists **[x]**.

## 11. Weather and holidays [2]

**Weather**
- Day weather in the day panel and on day chips: condition, min/max, precipitation probability and amount, wind, sunrise and sunset, a 2-hourly strip.
- Forecast window depends on D3: 0–9 days with MET Norway, or −1 to +16 days with Open-Meteo.
- Beyond the window: monthly climate normals, labelled "typical".
- Past dates (trips and journeys) use archive data where the provider's license allows; otherwise normals.
- Holiday badges and Atlas need a country per place: `place.cc` and `place.admin1` are computed on the client when the place is saved (offline point-in-polygon on the bundled boundaries).
- Provider choice is in services.md.

**Holidays**
- Public holidays (Nager.Date) and school holidays (OpenHolidays) shown as day badges in the planner.
- Vacay uses the same data [3].

## 12. Offline and PWA [1]

- Service worker:
  - precaches the app shell and route chunks, cache-first for hashed assets;
  - network-first for navigations;
  - stale-while-revalidate for the Puter SDK;
  - never caches worker traffic.
- "New version ready — Reload" toast.
- IndexedDB replica per space, plus an outbox with optimistic writes, op ids and conflict parking.
- Download for offline: ongoing and future trips are kept automatically. Trips that ended more than 7 days ago are evicted unless pinned.
- Non-media attachments are cached as blobs.
- Map tiles for each trip's bounding box (vector tiles up to z14, capped at 150 MB) with persistent-storage permission.
- Settings → Offline:
  - force offline, re-sync now;
  - per-trip offline toggles and a store-tiles toggle;
  - cache sizes, clear cache;
  - the conflict list (keep mine / keep theirs / merge).
- Offline expense entry and every other edit work **(board)**.

## 13. AI [2] [P]

**Booking import**
- Inputs:
  - drop files (≤5 × 10 MB: PDF, image, EML, HTML, TXT, PKPass);
  - paste text;
  - "From my Puter mail": forward confirmations to `<username>@puter.email`, then pick messages. Optional background capture (events-worker handler) that queues candidates in `me:import:*`.
- Processing:
  - PKPass is parsed locally;
  - EML MIME is decoded locally;
  - extraction uses a Claude model with a JSON schema;
  - deterministic post-checks run (architecture §14).
- Review screen: one card per item, edit before confirm, with duplicate warnings (provider plus confirmation number). Confirmed items are committed in one batch. Source files are attached.
- The import job survives navigation: it runs in the page with a progress widget, and its state is kept in IndexedDB.

**Assistant**
- Side panel per trip. Streaming and tool calls. Every change is shown as a preview and written only after the user approves it; there are no approval modes. Each approved change can be undone in one step.
- Tools:
  - read the trip;
  - search places;
  - create or edit days, places, visits, reservations, list items and expenses;
  - suggest an itinerary for a day;
  - fill a packing list from destination, dates and weather;
  - `web_search`.

**Other AI features**
- Receipt OCR into an expense (copy `src/expense/src/lib/ocr.js`).
- Build days from photos for a past trip (EXIF time and GPS plus AI grouping) **(board)** **[3]**.
- Translate the UI **[3]**: AI-drafted locale files, reviewed.

## 14. Collections [2]

- Lists: name, description, color, icon, cover, links, order. An "All saved" view.
- Saved places: place fields plus status (idea / want / visited / revisit **(board)**), labels, personal tags, ratings and a custom cover.
- Add by search. Save from a trip (single, bulk, or whole trip with preview). "Mark visited everywhere". Copy to a trip with photo, tags and ratings. Move or duplicate between lists. Bulk label and delete.
- Import and export as JSON and GPX (including OsmAnd favourites).
- Sharing with viewer and editor roles, using the same invite mechanics as trips.
- Read-only public link **(board)**.
- Map panel, filters (status, category, label), colored category rings **(board)**, and a collection overlay on a trip map **(board)**.
- Dashboard widget.

## 15. Atlas [2] basic, [3] full

**Phase 2**
- World map of countries (Natural Earth 50m).
- Visited = countries of places in trips that have started, plus manual marks. Future trips show as "planned" (dashed; toggle). Undated trips are excluded. Layover-only airports are excluded.
- Hide auto-detected countries.
- Country search. Popup: mark or unmark, list the places there.
- Stats: countries (plus planned), trips, places, cities, travel days, continents, streak, trips this year, distance flown. Most recent countries first **(board)**.
- "Visited" on a place is per user: each member marks their own.

**Phase 3**
- Admin-1 regions from zoom 5 (simplified Natural Earth 10m, split per country, lazy loaded).
- Bucket list: name, coordinates, country, notes, target date, visited. Wishlist countries hatched.
- Match by ISO codes, never by names. Borders follow one dataset; do not adjudicate disputes.

## 16. Journey and photo book [3]

**Journey**
- Title, subtitle, cover, status.
- Linked trips import their places as per-day suggestion entries, which can be dismissed or restored.
- Entries: type, title, markdown story, date and time, location (reverse geocoded), mood, weather, tags, pros and cons, visibility, order, excluded from stats.
- Media:
  - photos with HEIC converted;
  - video ≤500 MB;
  - from upload or the Puter drive **[P]**;
  - captions and ordering;
  - "photos near this entry" from the user's drive by EXIF date and GPS **[P]**.
- Views: timeline (search, jump, opens on today), map (pins, linked trips' places, GPX tracks, dashed connector), gallery, stats.
- Mobile: map with a card carousel, a day scrubber, and quick capture (camera, current position, current weather).
- Contributors: owner, editor, viewer, plus a "hide suggestions" option.
- Public journey link with timeline, gallery and map toggles and newest first. Photo coordinates are stripped when the map is hidden.

**Photo book**
- Formats: square 21/30 cm, A4 landscape and portrait, A5 landscape, custom mm. 3 mm bleed and 5 mm safe margin.
- Book structure: cover, single first page, spreads, single last page, back cover.
- 13 spread layouts and 5 cover layouts. Auto layout per spread or for the whole book.
- Left rail: pages, content (photos and entries), elements (text styles, shapes, lines, grids, icons, flags, country shapes), travel (maps, route lines, stats), layouts.
- Properties panel: position and size, crop and focal point, fill or fit, filters, corner radius, frame, z-order, lock.
- Undo and redo.
- Print to PDF (pages or spreads, crop marks). Import and export a spread design file.
- Multi-user: `puter.peer` cursors and badges. Whole-document saves with a version, and on a stale version, a conflict with "keep mine / take theirs".

## 17. Vacay [3]

- One plan per user, created on first use, in the user's own KV. Sharing and fusion use direct KV shares (data-model §3.4), with no worker.
- Settings:
  - weekends blocked, with configurable weekend days;
  - week start;
  - public holidays (Nager.Date, country and region);
  - school holidays (OpenHolidays);
  - company holidays;
  - carry-over;
  - leave year (calendar, fiscal start, or hire date).
- 12-month grid. Click to toggle a day; half days; comp/flex days; company-holiday mode (not deducted); dots where trips overlap.
- Per-year entitlement and carry-over. Stats: used, remaining, comp.
- Fusion: invite people as editors with per-person colors, and dissolve. Read-only overlay share: viewer role, drawn as rings.
- Stays day-based (no hours) per the upstream decision.

## 18. Road trip [3]

- A road-trip view beside the days: the whole trip as one chain of legs with arrival times, total distance, driving time and stop count.
- Scheduling:
  - stay per stop;
  - pinned times anchor the schedule forward and backward;
  - late warnings;
  - a daily window (start and end) splits drives into days with night-pause markers;
  - "End the day here";
  - draggable day-end labels stored as a fraction along a leg.
- Driving limits:
  - longest drive at once, driving per day;
  - range per tank or charge (or computed from tank size and consumption, or battery, consumption and degradation), fill-up percent;
  - fuel type: petrol, electric or either;
  - a "tank runs out here" band with fuel and charging suggestions.
- Search along the route (2/5/10 km corridor) for fuel, charging, rest areas, campsites, lodging, food and sights [services.md]. Filters. "Add manually" with leg detection.
- Via points per day, alternative routes, avoid tolls, motorways and ferries (Valhalla), and follow an imported track (stray km).
- EV charging data: MobiData BW (DE/CH, keyless) if its terms allow; otherwise OSM `amenity=charging_station`.
- Hazards: GDACS global events. DWD for Germany. Both are refreshed when the view is open.
- Booked nights act as anchors. Flights, trains, ferries and hire cars are integrated into the drive. Service stops can be shown or hidden in the days view.
- Drag and drop in road-trip mode; search; fuel planning **(board)**.

## 19. Settings [1]

- **General**: theme (system/light/dark), units (km/mi, °C/°F, kg/lb), date format including ISO **(board)**, 12/24 h, week start **(board)**, display currency, start page, default trip tab, show place descriptions, blur booking codes.
- **Appearance**:
  - text size (0.8–1.6) and a high-contrast scheme **[1]**;
  - density (comfortable/compact), accent choice and phone tab-bar order **[2]**;
  - reduced motion follows the OS, with an override;
  - **[x]** transparency/glass, which the design does not use.
- **Map**: style, place labels, booking-endpoint labels, explore pills, always show routes, optimize from the hotel. Custom style URL (advanced) **[2]**. **[x]** Mapbox 3D (needs a Mapbox token and map).
- **Dashboard widgets**: per device.
- **Templates, personal categories and tags.**
- **AI**: models. The assistant always asks before it changes a trip, so there is no approval-mode setting.
- **Offline** (§12).
- **Integrations [3]**: AirTrail, Immich, Dawarich (URL and key in personal KV; called with `puter.net.fetch`).
- **Travel documents vault [2] (board)**.
- **Account**: shows the Puter account and usage (`getMonthlyUsage`). Sign out is hidden inside the desktop.
- **Delete all my Trips data [2]**: my spaces, my worker and my personal KV, with an export offered first.
- **[x]** Passwords, 2FA, passkeys, OIDC, API keys, MCP tokens and the admin panel: Puter accounts replace all of them.

## 20. Notifications [2]/[3]

- **[1]**: in-app activity badges (with the activity feed, §8).
- **[2]**:
  - browser notifications while the app or PWA is open;
  - trip reminders (N days before) and to-do due reminders, shown on open and as feed VALARMs.
- **[3]**:
  - webhook and ntfy for trip changes, via an events-worker handler subscribed through the member's KV handle (runs as the subscriber, who pays; needs `events:background` consent);
  - email digests of trip changes through an events-worker handler and `sendTransactional`, for paid users who opt in. Time-based email reminders wait for platform scheduled triggers.
- **[x]** SMTP configuration and admin notification channels.

## 21. Dropped or replaced

| Feature | Here |
| --- | --- |
| Admin panel, instance settings, user management, audit log | [x] no instance; per-trip settings and permissions instead |
| Local accounts, OIDC, 2FA, passkeys, registration invites, demo mode | [x] Puter accounts |
| Plugin system (sandboxed plugins, hooks, registry) | [x] not in scope; revisit after v1 |
| Public REST API, MCP server with OAuth | [3] maybe; the in-app assistant covers most uses |
| Storage backends, document sync, backups | [P] Puter FS; JSON and zip export |
| Immich / Synology Photos | [P] Puter drive photos; Immich via `puter.net.fetch` [3] |
| Dawarich | [3] via `puter.net.fetch` |
| Unsplash cover search | [P] Openverse or Wikimedia search, or the user's own Unsplash key |
| Google Places, Amap, Naver | [x] by default; Google only with a user key and a Google map [3] |
| Help wiki | [2] short in-app help pages written fresh |
| System notices | [1] minimal onboarding tips |
| 23 locales | [3] English plus ar, cs, da, de, es, fr, he, hu, id, it, ja, ko, nl, pl, pt-BR, ru, sv, tr, uk, vi, zh-CN, zh-TW (`src/lib/i18n/locales.js`), AI-drafted; ar and he right-to-left; picker in Settings → General and the public viewer |

## 22. Smaller parity items

| Item | Phase |
| --- | --- |
| Packing import creates the bags it names; a per-trip bag-tracking switch | [1] |
| Reorder expenses and cost categories | [1] |
| Trip photos: a pool of photos from the Puter drive, each private or shared with members, optionally a linked drive folder | [3] |
| Links per saved place in collections; collection "admin" = editor with `members.manage` | [2] |
| Offline place search covers trip and collection places only; bulk-fetching Photon is not allowed | [x] |
| Import a Google Maps route link (stops in order); road trip: import Google directions, lodging-portal deep links | [3] |
| AirTrail write-back | [3] |
| Dawarich: detected stays as suggestions (accept as place or journal entry, dismiss), recorded day trails on maps, bucket-list and Atlas matches. Review state in `me:dawarich:*` | [3] |
| Vacay: several holiday calendars with label and color; manual school-holiday periods where OpenHolidays has no data | [3] |
| Notifications: choose channels per event; Discord/Slack webhook formats | [3] |
| Cost extras: partial payments, per-currency balances, an expense across trips, budget planner | [3] |
| One public link covering trip, journey and road trip | [3] |
