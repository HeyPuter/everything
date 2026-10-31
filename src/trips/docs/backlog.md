# Trips backlog from the upstream board

Triage of public trip-planner feature boards (1,615 cards, read October 2026): what users keep hitting, how each open request maps to Trips, and which decisions to keep. Spec items taken from here are marked **(board)** in [spec.md](spec.md).

Where a rationale below disagrees with [architecture.md](architecture.md) or [services.md](services.md) (for example on Transitous or on how sharing maps to roles), those files win.

## 1. Where the upstream app keeps breaking

Approximate title-keyword counts over ~1,340 merged and finished cards.

| Theme | ~Cards | What breaks | Implication for v1 |
|---|---|---|---|
| Mobile layout / parity | ~100 | Create buttons missing on mobile, controls behind bottom nav, drag & drop absent, features desktop-only | One responsive component set; mobile is the primary surface during trips. |
| Expenses math | ~80 | Settlements ignore custom splits; balances inflated ~27x with mixed currencies; FX refresh reopens settled entries; float rounding; payer lost when no split members; removing a member or duplicating a trip silently drops payments on next save; editing a booking wipes the linked expense price; AI import repeats a booking total on every segment | Integer minor units; FX rate frozen per expense; settlement derived from an immutable ledger; never rewrite payer/share lists implicitly; one expense may link to many items. |
| Photos (Immich/Synology) | ~75 | Pagination, full-res thumbnails, HEIC, 401/403, leaking to public pages | On Puter: photos in Puter FS, client-side thumbnails, HEIC decode. |
| Auth / OIDC / sessions | ~60 | Login loops, claims, reverse proxy, TOTP backup codes | N/A on Puter (puter.auth). |
| Dates / day model | ~60 | Changing trip start date shifts or deletes assignments; day_count inflation; reservation dates clamped to trip range | Key days by calendar date; explicit UX when the range changes; reservations may fall outside the range. |
| Atlas geo | ~57 | Region names mismatched by accents, HK/MO/TW classification, layover countries marked visited, border places misassigned, 30 MB GeoJSON | Match by ISO codes, not names; exclude layovers; simplified/tiled boundaries. |
| Public share parity | ~50 | Untranslated, wrong durations, bad map framing, missing route lines/tracks, deleted chat still visible | Render public view from the same components over a sanitized snapshot. |
| Accommodation | ~46 | Multi-day ranges collapse to one day, check-in/out ignored, every hotel save creates a new place, duplicates in roadtrip | Accommodation = reservation with date range + one linked place. |
| Routing | ~42 | Day route not starting/ending at hotel, check-in time ignored, flights routed by car, transit legs overwritten, GPX segment routed twice | Route builder must know day bookends, transport legs and GPX segments. |
| AI import | ~41 | Input truncated at 4k chars, max_tokens too low, non-strict JSON, reasoning-model params, PM parsed as AM, reverse-order legs merged, .eml MIME not decoded, PDF-only attachments skipped | Tool/JSON-schema output via puter.ai, full input, deterministic post-validation, preview before write. |
| Time / timezones | ~35 | ICS times wrong, 2h train offset, east-to-west flights, 12/24h ignored, photo capture time shifted by server TZ, crash when browser reports no TZ | Store local time + IANA tz per event (airport tz for flights); no server TZ; tolerate missing browser tz. |
| MCP OAuth | ~29 | DCR, session revoked on token refresh, SSE disconnects | Avoid in v1. |
| Offline / PWA cache | ~26 | Stale UI after upgrade, tiles not cached, files unavailable offline, expenses cannot be added offline | Local-first store + write queue from day one. |
| Multi-leg transport | ~11 (+2 dev) | Leg shows first leg's seat, one booking ref for all legs, layover routing, AirTrail leg sync | Reservation with ordered segments, each with own number/seat/times/tz. |

## 2. Open board items

Legend: **a** = v1, **b** = later, **c** = not applicable on Puter, **d** = better solved by a Puter API. Combined codes give the primary first.

### Planned for Release (4)

| Card | Cat | Rationale |
|---|---|---|
| Packing templates for non-admin users | a | Templates are per-user on Puter anyway (user KV/FS); no admin tier. |
| Per-member expense visibility | d,b | Private expenses live in the member's own AppData/KV, outside the shared trip folder; storage model enforces it. Later. |
| Auto-import booking emails (forwarded-mail ingest) | d,a | User forwards to `username@puter.email`; app reads via `puter.email`, parses with puter.ai, stages candidates, writes only on user confirm (keep the "no unseen writes" and confirmation-number dedupe rules). |
| External database support | c | No database to choose on Puter. |

### Inbox (Features) (109)

| # | Card (short) | Cat | Rationale |
|---|---|---|---|
| 1 | Larger image preview / carousel for place | b | Polish. |
| 2 | UX: group bookings by type, airline list, live flight tracking, accommodation→maps link, check-in/out range picker | a | Grouping, range picker, maps link are cheap; flight tracking is #62. |
| 3 | Weekly/monthly calendar overview | b | After day timeline (#59). |
| 4 | TripIt-style: OCR of uploads, quick return flight, duplicate flight, airports as places, hotel booking creates place | d,a | OCR via puter.ai.img2txt/vision; return/duplicate flight and auto-places are v1 data-entry basics. |
| 5 | Accommodation split by nights per person | b | Falls out of weighted split (#75) if split model supports per-person units. |
| 6 | Generic lists with custom columns | b | Niche. |
| 7 | Hotkeys (Ctrl+Enter submit, unsaved-change prompt) | a | Cheap. |
| 8 | Atlas: flight history overlay, "lived" status, colors | b | Atlas extras. |
| 9 | Tags for trips | a | Cheap; also covers rejected "trip purpose" request. |
| 10 | Collections inside a trip + reorder | b | Needs collections v1 first. |
| 11 | What is TRANSIT_API_URL? | c | Config question; Puter build hardcodes Transitous via puter.net.fetch. |
| 12 | Satisfaction survey | c | Meta. |
| 13 | Merge automated transit result with booked transport | b | Useful, depends on transit routing. |
| 14 | Compress exported PDF | a | Downscale images client-side before embedding. |
| 15 | Store passport / frequent-flyer data | d | Per-user KV, never in the shared trip folder. |
| 16 | Trip start/end location for round trips | b | Small model extension. |
| 17 | Import trip from JSON/YAML | a | Needed anyway for import/export and backups in Puter FS. |
| 18 | Custom fields on places | b | Schema complexity. |
| 19 | Offline UX: continuous sync, status badges | a | Puter has no offline primitive; build local-first (IndexedDB) cache + write queue syncing to Puter FS/KV. |
| 20 | Place names next to markers | a | Toggleable label layer. |
| 21 | Subscribe to journey updates | b,d | Journey later; email via `puter.email.sendTransactional` (paid plans) or Puter share notifications. |
| 22 | Per-currency balances | b | Settle-up extension. |
| 23 | Comments on journey from link viewers | b | Journey later. |
| 24 | Cost tracking without splitting | a | Per-trip "split costs" toggle; solo-trip mode. |
| 25 | One expense linked to many items (JR Pass) | a | Many-to-many link in v1 schema. |
| 26 | View-only user | d,a | `fs.share` read vs write on the trip folder maps directly to viewer/editor. |
| 27 | Mapbox POI picker | b | Provider-specific. |
| 28 | Local MCP with Open WebUI/Ollama | c | Local LLM stack; in-app AI uses puter.ai. |
| 30 | Export/sync places to Google Maps list | b | No write API; offer KML/GeoJSON export instead. |
| 31 | Outbound firewall rules | c | Self-hosting. |
| 32 | Build days from photos' EXIF/GPS | d,b | Photos from Puter FS, EXIF + puter.ai vision to name places. Later. |
| 33 | Pre-trip budget planner + savings | b | Planned-vs-actual per category later. |
| 34 | Unify bookings/transports; separate place vs visit | a | Data-model decision: one reservation entity with type groups; visits (assignments) carry their own times/notes/costs. |
| 35 | How does the Google Maps key work? | c | No server key; OSM/Photon by default. |
| 36 | Group people (couples/families) for expenses | b | Display grouping over the ledger. |
| 37 | AMap for China; native mobile clients | b,c | AMap later; native clients N/A (web app). |
| 38 | No preset admin account in logs | c | Self-hosting support. |
| 39 | Transport routes on journey map | b | Journey later. |
| 40 | More detailed stats | b | After Atlas basics. |
| 41 | MCP: external authorization server | c | Self-hosted auth infra. |
| 42 | Show a collection on the trip map | a | Toggle overlay, cheap if collections ship. |
| 43 | Plugin holiday providers | c | No plugin system. |
| 44 | S3 forcePathStyle | c | Storage is Puter FS. |
| 45 | Synology Photos Shared Space | d | Photos picked from Puter FS (`showOpenFilePicker`/directory picker). |
| 46 | Journey: one entry per day, not per place | b | Journey design input: don't auto-create a card per planned place. |
| 47 | Login issue / SMTP reset | c | puter.auth. |
| 48 | Move booking to other/new trip | a | Cheap; needed once email ingest exists. |
| 49 | Multiple own photos per place | d,b | Store in Puter FS. Later. |
| 50 | Activity without a location (run/ride) | a | Same as #93. |
| 51 | Generic WebDAV document sync | d | Puter FS is the document store. |
| 52 | Roadtrip: choose which days | b | Roadtrip later. |
| 53 | Explicit date format (ISO) | a | Settings in KV. |
| 54 | Journey map as full trip summary | b | Journey later. |
| 55 | Configurable PDF (filters, font size, orientation, cover) | a,b | Content filters in v1; layout options later. |
| 56 | China localization (Amap engine) | b | Regional. |
| 57 | Push flights to AirTrail | b | Integration later; puter.net.fetch makes it possible. |
| 58 | GPX import for routes | a | Core shipped feature. |
| 59 | Dwell time, editable travel time, auto daily schedule | a | Most recurring planner request; compute schedule from day start + dwell + travel. |
| 60 | Roadtrip: segment search, fuel | b | Roadtrip later. |
| 61 | One public link for plan + journey + roadtrip | b | Design the public snapshot with tabs from the start. |
| 62 | Track flight status updates | b | Needs a paid flight-status API. |
| 63 | Disable debt simplification + show balance math | a | Settle-up is the most bug-prone area; explainability prevents "looks like a bug" reports. |
| 64 | Secure sharing (named users, password) | d | Share with named Puter users/emails (pending invites) instead of bearer links. |
| 65 | Collections as persistent place records with history | b | Later evolution. |
| 66 | "Want to revisit" status | a | One more status/flag. |
| 67 | Day timetable from departure + durations | a | Same as #59. |
| 68 | Read-only public link for a collection | d,b | Same mechanism as trip public link (hosted snapshot/worker). |
| 69 | Expense splitting across trips | b | Splitwise-style, out of scope for v1. |
| 70 | Android share sheet to add Google Maps place | b | Needs standalone PWA with `share_target`; paste-link import covers v1. |
| 71 | Mobile drag & drop place to another day | a | Mobile parity is the top bug theme. |
| 72 | Stop numbers on desktop map/list | a | Cheap. |
| 73 | Download button on booking attachments | a | Cheap with Puter FS. |
| 74 | Payment method on expenses | b | Small field, low priority. |
| 75 | Weighted split with presets | b | Design split model to allow it. |
| 76 | Partial payments (deposit + due date) | b | Ledger supports multiple payments per expense. |
| 77 | Satellite on public journey map | b | Journey later. |
| 78 | Document sync with Synology? | c | Support question; Puter FS replaces it. |
| 79 | Vacay hours vs days | b | Vacay later. |
| 80 | To-do templates | a | Same mechanism as packing templates. |
| 81 | ICS: opt out of "Day N" all-day events | a | Feed option. |
| 82 | GPX tracks on public journey | b | Journey later. |
| 83 | Better non-Google place search | a,d | Puter build has no Google key by default: Photon/Nominatim/Overpass via puter.net.fetch, viewport bias, optional puter.ai query normalization. |
| 84 | Pickup/drop-off address and city | a | Cheap. |
| 85 | Custom tab order / icon-only tabs | b | Polish. |
| 86 | Filter collection POIs by category on mobile | a | Parity. |
| 87 | Macao public holidays | b | Vacay later; data source issue. |
| 88 | Run on subpath | c | Hosting config. |
| 89 | Guests see chat pictures on share | b | Public share extension. |
| 90 | Place photo background in roadtrip mode | b | Roadtrip later. |
| 91 | Drag & drop in roadtrip mode | b | Roadtrip later. |
| 92 | API: GPX import from plugins | c | No plugin API. |
| 93 | Scheduled item without a place | a | Visits must allow null place (meals, laundry, runs). |
| 94 | Atlas flight history from AirTrail | b | Atlas extra. |
| 95 | Rental car with stops vs roadtrip addon confusion | a | Design input: one model for driving legs with stops. |
| 96 | "Test" button for AI connection | c | puter.ai needs no connection config. |
| 97 | MCP: update_collection_place fields | b,d | MCP later; same tool layer can back puter.ai chat. |
| 98 | MCP: paginated list_collection_places | b,d | Same. |
| 99 | Atlas tile: most recent countries first | a | Trivial if Atlas ships. |
| 100 | Weight in lbs | a | Units setting. |
| 101 | Periodic Google Maps list sync | b | Fragile scraping; no scheduler; re-import manually. |
| 102 | Plan A/B/C days, optional stops | b | Recurs (also 4 rejected variants); reserve an "optional/candidate" flag on visits. |
| 103 | Bring roadtrip stop durations/ETA warnings into day view | a | Same as #59. |
| 104 | Multiple expenses per location / repeat visits | a | Expenses link to the visit, not the place. |
| 105 | US states in Atlas | b | Subdivisions shipped; extra stats later. |
| 106 | Solo trip shows split UI | a | Same as #24. |
| 107 | More place icons (parking, ferry, bus, airport) + linked places | a,b | Icons v1; place linking later. |
| 108 | Category color rings in collections | a | Cheap. |
| 109 | Vulnerabilities / outdated deps | c | Meta; keep dependencies lean. |

Counts by primary code: a 37 (many are design-time decisions or trivial), b 47, c 16, d 9. Secondary codes: d 4, b 5, a 2, c 1.

## 3. Top 15 open items

1. **Time-aware day planning**: dwell time per visit, travel time, auto-computed schedule from a day start/hotel departure, timeline view. Inbox #59, #67, #103, #3; Won't Do "Day timeline surface"; merged "Times on all places", "Add time scheduling and transit durations".
2. **Expense model depth and correctness**: weighted/family splits (#75, #36, #5), per-currency balances (#22), explainable settle-up (#63), partial payments (#76), one expense ↔ many items (#25), per-visit expenses (#104), solo mode (#24, #106), privacy (Planned), cross-trip (#69). Also the largest bug cluster.
3. **Booking ingest from email/documents with AI**: Planned (full design), plus Won't Do duplicates ("Auto fill from email", "Booking automation"), merged kitinerary+LLM card, #4 OCR, #48 move booking.
4. **Roles and scoped access**: view-only (#26), secure sharing (#64), expense privacy (Planned); rejected variants: viewer role, expense-only members, partial collaborators.
5. **Offline reliability**: #19, dev-finished offline-expense bug, ~26 merged offline/PWA bugs, merged "Robust offline functionality".
6. **Alternatives per timeslot**: #102; Won't Do "Candidate places", "Multiple options for same time", "Multiple options for transport/accommodation", "Sub-positions"; merged "folders or nesting".
7. **Concept clarity: reservation vs transport vs visit vs place**: #34, #95, #13, #50, #93; Won't Do "Separate place + visit details", "What's the expected flow?".
8. **Collections evolution**: #10, #42, #65, #66, #68, #86, #108; dev-finished collection export/import and GPX.
9. **Public sharing completeness**: #61, #82, #77, #89, #23, #21, #64; five public-share bugs in Development finished.
10. **Place search without Google**: #83, #35; dev-finished viewport-bias, translation and category false-positive bugs. Matters most for Puter, which has no bundled Google key.
11. **In-app AI assistant**: dev-finished "Integrated AI chat", #28, MCP cards #97/#98, 50+ MCP cards merged.
12. **Mobile parity**: #71, #86, #91; ~100 mobile bug cards.
13. **Flight entry and status**: #4 (return/duplicate flight, airline lookup), #2, #62; merged "live flight information"; rejected "bundle single flights into multi-leg".
14. **Templates and structured import**: Planned packing templates for all users, #80 to-do templates, #17 JSON/YAML import, merged trip-template proposal.
15. **Atlas depth**: #8, #40, #94, #99, #105; rejected "visited cities", "Italian regions", "states as visited places".

Runner-up: configurable/smaller PDF export (#14, #55; Won't Do "More PDF layouts", "photo frame").

## 4. Declined upstream: decisions worth keeping

- **Private, not social.** Rejected: Community Trips, Destination Chatrooms, publishing trips to all users, federation, Organizations/Workspaces above trips. Collaboration is per trip among invited people; no discovery layer.
- **No travel-commerce or live-data features that need paid APIs.** Rejected: flight search, flight price tracking, wildfire/severe-weather layers, beach tide/condition features, "local hidden gems / safety tips".
- **One itinerary per day, people assigned to items.** Rejected: parallel itineraries/split groups, partial collaborators per leg, expense-only members, viewer role for buddies (some closed as duplicates; "View only user" is still open, so read-only access itself is not ruled out, but per-leg ACLs and parallel timelines are).
- **External data enters as suggestions, a human confirms.** From the ingest design and the Dawarich/AirTrail cards: no automated job writes a reservation nobody has seen; dedupe by provider + confirmation number, never by date/price/subject; attribution never from the From header; no stored per-user mailbox credentials. Apply the same rule to puter.ai parsing and any future sync.
- **Integrations: self-hosted-aligned first.** Rejected two-way Google Maps list sync, Komoot sync, Nextcloud Photos, Polarsteps import, AMap as search provider. On Puter the equivalent rule is "use Puter primitives (FS, email, AI) before third-party connectors".
- **Generic over specific fields.** Rejected a fixed "trip purpose (business/leisure)" field while trip tags remain open; rejected "split by share" while weighted split remains open (scope moved, not killed).
- **Vacay stays day-based.** Rejected accrual-based PTO, hourly tracking, compensatory workdays/custom holiday feeds, custom vacation tags.
- **Borders follow one standard dataset.** Both "Taiwan should not be a separate country" and "China map missing Taiwan" were closed, as was "show internationally recognized borders". Don't adjudicate borders per request.
- **Web/PWA only.** Rejected standalone local-only Android app, biometric login, NixOS package.
- **Small UX closures** (mostly duplicates or minor): hide map area, hide "no places planned" placeholder, default mobile tab, map style per theme, reorder dashboard widgets, protect items from deletion, image upload by URL, warn on suspicious imported coordinates, settle balance up to a date, split Costs into Planning/Tracking tabs.
- **Infra reversals.** External DB was rejected three times but is now Planned (urgent); S3 storage was rejected but S3 backups shipped. Irrelevant on Puter.
- **Detailed agent-written specs were closed** ("Candidate places", "Day timeline surface", "Book a decided item as a reservation"), while the underlying needs stay open in the Inbox (#59, #102). The maintainers also published an AI-usage disclosure and accept AI-assisted reports only when verified.
