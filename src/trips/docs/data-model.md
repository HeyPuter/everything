# Trips data model and protocol

Source of truth for keys, entity fields and the worker protocol. The JS schemas in `src/shared/schema/` must match this file. Change both in the same PR.

Conventions:
- Ids are 16 lowercase base32 chars, time-sortable, generated on the client (`src/shared/ids.js`).
- Order keys are fractional index strings (`src/shared/order.js`).
- Dates are ISO `YYYY-MM-DD`. Times are local `HH:mm` plus an IANA `tz` where the time belongs to a place.
- Money is integer minor units plus an ISO 4217 code. Rates are decimal strings.
- Every entity has `id`, `v` (HLC string), `rev`, `upd` (ms), `by` (uuid), and `cr` (created ms). The worker sets these; clients never send them.
- A deleted entity is a tombstone `{id, t, deleted:true, rev, v}`, kept for 30 days.

## 1. Worker KV (owner's namespace)

There are three key groups (architecture §6):
- `sp:<id>:` is **worker-private**. Members never see it.
- `shared:<id>:` is **member-visible**. Any member, including viewers, may see anything here, because each member's `read` handle covers the whole prefix.
- `shared:<id>:u:<uuid>:` is **member-written**. That member writes it through their own `write` handle. The worker never validates it, so clients validate it on read.

| Key | Value | Notes |
| --- | --- | --- |
| `cfg` | `{owner, created, build}` | owner uuid pinned from `me.puter.auth.getUser()`; only the owner may create spaces |
| `idx` | `{<spaceId>: {k, created}}` | spaces on this worker (≤500); unknown space ids are refused on every route without further reads; the owner's own requests skip the check and re-add a live space a cross-region write dropped |
| `purge` | `{<spaceId>: ms}` | deleted spaces whose keys and files are still being purged; `space.list` resumes them |
| `allfeed` | `{tokenHash, created, feeds: [{w, s, uuid, token, title?}]}` | the worker owner's "all my trips" calendar (phase 3): the trips it merges and each one's `scope: 'all'` feed token; never shared |
| `unfurl:<sha256 of url>` | `{title, desc, image, at}` or `{none: true, at}` | link-preview cache shared by every space on this worker; TTL 7 days (1 hour for `none`) |
| `sp:<id>:secrets` | `{k, shareTokenHash, shareExp, journeyLink?: {w, s, token}}` | never in snapshots; `journeyLink` is a journey's public link that the trip's public link hands out (phase 3) |
| `sp:<id>:fm` | `'direct'\|'proxied'` | files mode, set by the first member file share |
| `sp:<id>:acl` | `{k, owner, created, folders:{files}, deleted?}` | the space doc; `deleted` marks a deleted space |
| `sp:<id>:m:<uuid>` | `{role, username, joined, via, removed?}` | one record per member, so cross-region writes for different members never collide; active while `removed` is absent or older than `joined`; removal and role changes are path writes |
| `sp:<id>:inv:<sha256>` | `{role, exp, max, by, created, named?:<username>, label?, holder?:<username Puter resolved>, handle?, stub?:<inviteId>, revoked?:ms}` | TTL = expiry + 30 days, so failed joins can say why; keyed by the hash of the link token or of the named invite id. Revoking keeps the record with `revoked` |
| `sp:<id>:invs` | `{<sha256>: {role, exp, max, by, created, named?, label?, handle?, stub?}}` | invite index for `invite.list` (no `kv.list`) and stub cleanup after expiry |
| `sp:<id>:invc:<sha256>` | claim counter | `incr` |
| `sp:<id>:rev` | integer | `incr` per commit, before entity writes |
| `sp:<id>:feed:<uuid>` | `{tokenHash, created}` | per-member ICS feed token |
| `sp:<id>:feeda:<uuid>` | `{tokenHash, created}` | the member's second feed token, used only by their own "all my trips" calendar (phase 3) |
| `sp:<id>:pres` | `{<uuid>: ms}` | ≤1 write per member per 2 min |
| `sp:<id>:h:<uuid>` | `{read, write, minted, files?, inbox?, inboxHold?, revoke?, username?}` | that member's handle ids (`read` on `shared:<id>:`, `write` on `shared:<id>:u:<uuid>:`); `inboxHold` (ms): no inbox until then, set when inbox sweeps used up the day's upload bytes |
| `sp:<id>:opdone:<opId>` | `rev` | TTL 48 h, idempotency per op element |
| `sp:<id>:author:<type>:<eid>` | creator uuid | immutable, worker-written with create; author-only rules must never use last-editor `by` |
| `sp:<id>:pollvoted:<eid>` | `true` | set on the first poll vote; never cleared when votes are withdrawn |
| `sp:<id>:snapclaim:<window>` | counter | rebuild claim; 120 s windows |
| `sp:<id>:rl:<bucket>:<uuid>:<window>` | counter | budgets the owner pays for (`inv`, `up`, `upb` (also charged with inbox bytes a sweep deletes), `dlb`, `unf` (link-preview fetches), `rdb` (path C bytes read), `snb` (snapshot bytes served), `wb` (KV bytes written, daily), and `pub`/`pubb` keyed by a token-hash prefix); per-isolate memory limits cover the rest |
| `sp:<id>:fail:<uuid>:<window>` | counter | failed joins; 10-minute windows |
| `sp:<id>:n` | `{e, day, place, collab, bytes, members}` | cap counters, `incr`'d by commits that create or delete; reset by a rebuild that saw no concurrent commit. `collab` counts notes, links and polls (cap 2,000) |
| `sp:<id>:pending` | `{<fileId>: {uuid, size, at, sniff, uid}}` | proxied uploads waiting for `file.put`; swept after 1 h |
| `sp:<id>:maint:<window>` | counter | hourly owner-open maintenance claim (sweeps, trash purge, expired invites, revoking grants of former members) |
| `sp:<id>:xfer` | `{to, toName, by, at, exp, state: offered\|moving\|moved, worker?, frozenAt?, movedTo?}` | ownership transfer out of this worker (architecture §16); `moving` and `moved` freeze the space |
| `sp:<id>:xin` | `{from: {w, s}, by, at}` | ownership transfer into this worker: binds the space to its source; written before the space doc |
| `sp:<id>:xseat:<uuid>` | `{role, username, exp, claimed?, revoked?}` | a member of a moved trip who may rejoin with `transfer.join`; TTL = expiry (30 days). `member.remove` on the uuid claims it with `revoked` |
| `sp:<id>:scrub` | `rev` | the last change that scrubbed earlier versions from change records; a snapshot with a lower `rev` is rebuilt before it is served |
| `shared:<id>:e:<type>:<eid>` | entity or tombstone | the only keys the snapshot scan lists; includes `e:meta:meta` and `e:member:<uuid>` |
| `shared:<id>:m:<msgId>` | chat message | outside the scan; the last 200 are embedded in snapshots |
| `shared:<id>:ch:<rev>:<n>` | change record chunk `{rev, parts, at, by, ents:[…], del:[{t,id,v}], sum:[{t, id, op:'put'\|'set'\|'del', name, fields[], prev?}]}` (`parts` and `sum` only in chunk 0) | ≤100 KB per chunk (one oversized entity gets its own), TTL 30 days. Record `ents` carry `t`; entity values under `e:` do not (the key holds the type). `prev` is the rev of the record that held the entity's previous version. A delete, a message soft delete or a message edit removes the earlier versions from those records and blanks their `sum` names, so a scrubbed record may list an entity in `sum` that is absent from `ents` |
| `shared:<id>:snap` | `{rev, at, bytes}` | snapshot state, for path C clients and projections |
| `shared:inv:<inviteId>:info` | `{invite, worker, space, kind, title, ownerName, role, exp}` | named-invite stub, shared `read` with the invitee only; deleted on answer or expiry. `invite` is the id the invitee sends to `join` and `invite.decline` |
| `shared:<id>:sig` | compact change record, or `{rev}` if over 16 KB | members watch `kv:<handle>:sig`; path A polls it |
| `shared:<id>:u:<uuid>:pres` | `{at, view}` | written by the member every 60 s while visible |
| `shared:<id>:u:<uuid>:seen` | `{rev}` | read marker for activity badges (replaces `me:seen:*` on path A) |
| `shared:<id>:u:<uuid>:peer` | `{v: 1, invite, book, at}` | the member's `puter.peer` invite while a journey photo book is open in the editor (`book` is its id); rewritten every 2 min, deleted on close, ignored after 5 min; clients clamp it |
| `shared:<id>:u:<uuid>:x:<type>:<eid>` | `{rating?, tags?, visited?, doneBy?, bring?, votes?, react?}` | later: per-user fields moved off the worker (architecture §7) |

## 2. Worker FS (owner's AppData)

```
worker/trips-worker.js                    worker source (never shared)
spaces/<id>/state/snapshot.json.gz        worker only (path C, public links, ICS, export)
spaces/<id>/files/<fileId>/<name>         direct mode: shared read with members (only the worker writes)
spaces/<id>/files/<fileId>/data           proxied mode: served by the worker only
spaces/<id>/files/<fileId>/.thumb        thumbnail (WebP, JPEG or PNG, ≤256 KB); the dot keeps it apart from direct-mode names
spaces/<id>/inbox/<uuid>/                 direct mode: shared write with that member only (uploads)
```

The built bundle starts with the banner `/*! trips-worker build=<id> at=<ms> protocol=<n> */` (`id` is 6–64 lowercase alphanumerics, `at` the build time in ms). The client parses it before deploying and compares it with `/health`.

## 3. Entities by kind

Field lists are what the UI needs for parity. Optional fields are omitted when empty.

### 3.1 trip

**`meta`** (entity `e:meta:meta`; secrets live in `sp:<id>:secrets`):

| Field group | Fields |
| --- | --- |
| Basics | `title`, `description` (md), `start`, `end` (dates or null), `dayCount` (undated trips, default 7), `currency` |
| Display | `cover` (fileId or `{url, credit}`), `tags[]`, `archived`, `reminderDays` |
| `settings` | `{splitCosts:true, perPersonPacking:false, bagTracking:true, addons:{lists,costs,files,collab,roadtrip}, weekStart, homeTz}` |
| `share` | `{on, exp, plan, map, bookings, codes, packing, costs, chat, files, road, journey, cur, since}`: toggles, `cur` (display currency for costs, or null for the trip currency) and `since` (ms, when the current token was minted; worker-set). The token hash is secret. Absent `map` means on. `road` (phase 3) adds the road trip to the plan; `journey` (phase 3, worker-set) is true while a journey's public link is attached, which lives in `sp:<id>:secrets` |
| `perms` | §5 |
| `transfer` (worker only) | `{to, name, by, at, exp, state: offered\|moving, worker?}`: an ownership offer to member `to`, and the move once accepted |
| `movedTo` (worker only) | `{w, s, at, name}`: the trip now lives in worker `w` under the same space id; clients follow it, and the space here is a read-only stub until it is deleted 30 days after `at` |

Feed tokens are per member (`sp:<id>:feed:<uuid>`), not in meta.

**Entity types**:

- **`member`** (`e:member:<uuid>`, written only by the worker): `name`, `role`, `color`, `avatar`. This is the member-visible view of the ACL.

- **`day`** (`order`): `date` (null for undated), `title`, `notes` (md), `mode` (default transport: `walk|drive|bike|transit|plugin`), `color` (slot index).

- **`place`**: the trip's pool of places.

  | Group | Fields |
  | --- | --- |
  | Identity and location | `name`, `desc`, `notes`, `address`, `lat`, `lng`, `tz`, `cc` (ISO country), `admin1` (region code), computed on the client at save |
  | Classification and cost | `cat` (built-in or trip `cat` id; a personal category is copied into the trip first), `tags` {<uuid>: [tag names]} (per-user path; each member sees only their own), `price` {amount, currency} |
  | Contact | `web`, `phone` |
  | Media | `img` {fileId} or {url, credit, license} |
  | Provenance | `ids` {osm, wikidata, google, photon}, `src` |
  | Track (GPX) | `track` {fileId (a `file` with `kind: track`, GeoJSON gzip), color, km} |
  | Road trip | `stop` {type: fuel\|charge\|rest, fill} |
  | Ratings | `rating` {<uuid>: 1-5} (path per user) |
  | Visited | `visited` {<uuid>: true} (per-user path, atlas) |

- **`visit`** (a place on a day; `placeId` may be null for free-form items):

  | Group | Fields |
  | --- | --- |
  | Position | `dayId`, `placeId`, `order` |
  | Time | `start`, `end` (HH:mm), `dwell` (minutes), `endDayId` (multi-day), `pinned` (scheduler anchor) |
  | Content | `title` (when no place), `notes` |
  | Travel | `legMode` (outgoing), `inMode` |
  | People and links | `people[]` (member uuids or guest ids), `stayId` (lodging reservation), `alt` (the `alt` plan it belongs to; such visits are not part of the main plan, and day timelines, routes, calendars and prints leave them out) |

- **`dayNote`**: `dayId`, `order`, `title`, `text` (md), `time`, `icon` (lucide name from an allowlist of 32), `color`.

- **`res`** (reservation; one type for bookings, transports and lodging):

  | Group | Fields |
  | --- | --- |
  | Basics | `type` (below), `title`, `status` (`pending\|confirmed\|cancelled`), `code` (confirmation) |
  | When and where | `start` {date, time, tz}, `end` {date, time, tz}, `location` {name, address, lat, lng} |
  | Links | `placeId`, `visitId`, `stayId` (the lodging reservation this booking belongs to), `url`, `notes`, `people[]` |
  | `legs[]` | `{from:{name, code, lat, lng, tz}, to:{…}, dep:{date,time}, arr:{date,time}, carrier, number, seat, cls, code, platform, coach}`; transit legs add `mode`, `color`, `shape` (encoded polyline ≤8 KB, or a fileId) |
  | `stay` (lodging) | `{checkInFrom, checkInUntil, checkOut, fromDayId, toDayId}` |
  | Day placement | `dayPos` {<dayId>: order} |
  | Import | `review` (needs review after import), `src` {kind: manual\|ai\|pkpass\|airtrail, ext, hash} |

  Attachments are not stored on the reservation: `file.links` is the single source of truth for every file ↔ entity link (reservations, expenses, visits, places, notes, messages).

  Types:
  - Transports: `flight`, `train`, `bus`, `car`, `taxi`, `bike`, `cruise`, `ferry`, `transit`, `transport`.
  - Bookings: `lodging`, `restaurant`, `event`, `tour`, `parking`, `other`.

- **`exp`** (expense):

  | Group | Fields |
  | --- | --- |
  | Amount | `name`, `amount` (minor units), `currency`, `rate` (to trip currency, frozen; `null` = pending, frozen on reconnect), `date`, `order` |
  | Category and note | `cat` (one of 14 built-ins or a trip category id), `note` |
  | `payers` | `[{who, amount}]`; empty means unpaid (counts toward spend, not toward balances). With `due` set they may add up to less than `amount`: a partial payment |
  | `due` | date the rest is due (phase 3). Only the paid part counts toward balances; the rest is outstanding, like an unpaid expense |
  | `across` | `{group, total, parts: [{w, s, title?, amount}]}` (phase 3): one payment split across 2–20 trips, each part the amount one trip carries, in the expense currency; parts add up to `total`. Every trip's copy has the same `group`. Never in public links |
  | `split` | `{mode: equal\|amounts\|percent\|shares\|items, parts:[{who, value, paid}], items:[{label, amount, who[]}]}` |
  | Links | `links[]` `{t, id}` (reservations, visits, places); receipts via `file.links` |

- **`settle`**: `from`, `to`, `amount`, `currency`, `rate`, `date`, `note`.

  **Rates.** A frozen `rate` on an expense or settlement converts its amount into the trip currency, and it is the only conversion the ledger uses (live rates appear only in display-currency totals, marked ≈). When the trip currency changes from A to B, the member saving the change fetches one A→B rate (the latest), and in the same commit as the meta change re-bases every shared `exp` and `settle`: amounts in A get that rate, amounts in B lose theirs, frozen rates are multiplied by it, and pending ones stay pending (they are frozen later against B, at the item's own date). The saver's own private expenses are re-based the same way through the personal store. Each item keeps its original conversion plus one pinned step, so totals keep their value. The change needs `costs.edit` as well as `trip.edit` when the trip has shared expenses or settlements. Known gap: other members' private expenses, and expenses queued offline against A, keep a rate meant for A.

- **`splitPreset`**: `name`, `weights` {who: n}.

- **`costCat`**: `{cat, order}`, the display order of cost categories.

- **`budget`** (phase 3): `{cat?, amount, note?}`, a planned amount in the trip currency (minor units) for one cost category, or for the whole trip without `cat`. Several for one category: the oldest wins. Never in public links.

- **`pack`** (packing item):

  | Group | Fields |
  | --- | --- |
  | Basics | `name`, `qty`, `list` (category name), `order` |
  | State | `done` (shared checkbox) or `doneBy` {<uuid>: bool} when the trip uses per-person checks |
  | Weight and bag | `grams`, `bagId` |
  | Visibility | `vis` (`shared\|people`), `for[]` (when `people`), `owner` |
  | Contributors | `bring` {<uuid>: 'yes'\|'maybe'} |

  Private items are not here; they live in the member's KV.

- **`bag`**: `name`, `color`, `limitGrams`, `people[]`, `order`.

- **`todo`**: `name`, `list`, `order`, `done`, `due` (date), `desc` (md), `who`, `prio` (1-3).

- **`listMeta`**: one entity per list name, holding `{kind: pack|todo|note, name, color, order, assignees[]}`. Collab note categories use `kind: note`.

- **`note`** (collab): `title`, `body` (md), `cat`, `color`, `pinned`, `web`, `author`. Attachments via `file.links`.

- **`link`**: `title`, `url`, `pinned`, `author`.

- **`poll`**: `question`, `options[]`, `multi`, `deadline`, `closed`, `votes` {<uuid>: [index]}, `author`.

- **`msg`**: `text` (≤4,000 chars), `reply`, `react` {<emoji>: {<uuid>: 1}} (keys are single emoji), `deleted`, `author`. Images (≤4, ≤10 MB each) are files linked to the message. The snapshot holds the last 200 messages; older ones are paged with the `chat.page` op.

- **`file`**: `name`, `mime`, `size`, `sha256`, `kind` (`user|track|book|photo`; only `user` files appear in the Files tab; `photo` (phase 3, trips, images only) is a trip photo shared with members, with optional `taken` {date, time?} and `geo` {lat, lng} from its EXIF, set by `file.put`), `loc` {mode: 'direct'|'proxied', uid?}, `thumb` (a fresh id each time a thumbnail is stored; absent when there is none), `desc`, `star`, `trashed` (ms), `linked` {`<t>_<id>`: true}, `links[]` {t, id}. A file's links are the union of `linked` and `links`, and are the only place file links are stored; targets are `place`, `res`, `visit`, `exp`, `note`, `msg`, or `{t:'meta', id:'meta'}` for the trip cover. Clients add a link as the path `linked.<t>_<id>` and remove it by unsetting that path, so links added by different members at the same time are all kept. `links[]` is the older whole-list form: still read, never extended, and rewritten only to drop a link it holds. A link may appear in both forms; `links` has no duplicates.

- **`cat`**: trip category `{name, color, icon}`. Built-in defaults are client constants and never stored.

- **`guest`**: `name`, `color`.

- **`alt`** (Plan B; phase 3): `name`, `order`, `dayId` (an alternative for that day; absent for the whole trip), `color` (slot index), `notes`. Its visits carry `alt: <id>` and keep their own `dayId`. Promoting it swaps, on each day it covers, the main visits into it and its visits into the main plan.

- **Road trip (phase 3)**:
  - `via`: `dayId`, `after` (visit id), `order`, `lat`, `lng`. A route point on the leg that leaves `after`.
  - `dayEnd`: `day`, `fromVisit`, `toVisit`, `fraction`. Where the night falls along the leg between two stops (the visit or booking ids at its ends): `fraction` 0 sleeps at the start, 1 at the end. `day` is the day that ends there.
  - `dayTrack`: `dayId`, `placeId` (the track to follow), `strayKm`.
  - `rtPrefs`: one entity per trip, always id `00000000000000rt` (`ROAD_PREFS_ID`); every field is optional:

    | Group | Fields |
    | --- | --- |
    | Vehicle | `fuel` (`petrol\|electric\|either`), `range` (km per full tank or charge; otherwise computed), `tank` (L), `use` (L or kWh per 100 km), `battery` (kWh), `degrade` (% capacity lost), `fill` (% to fill or charge to), `reserve` (% kept back) |
    | Cost | `price` (decimal string per L or kWh), `currency` |
    | Driving day | `start`, `end` (HH:mm window), `stint` (longest drive at once, min), `daily` (driving per day, min), `pause` (break, min) |
    | Route | `avoid[]` (`toll\|motorway\|ferry`), `dayAvoid` {<dayId>: avoid[]} (a day's chosen route), `corridor` (search width, km), `showStops` (service stops in the days view) |

### 3.2 collection

**`meta`**: `name`, `desc`, `color`, `icon`, `cover`, `links[]`, `urls[]` {url, title} (web links, ≤50), `share` {on, exp} (read-only public link). The token hash is in `sp:<id>:secrets`, never in member-readable meta.

**Entity types**:

- **`saved`**: the place fields from §3.1, plus:
  - `status`: `idea|want|visited|revisit`;
  - `labels[]`;
  - `rating` {<uuid>: n};
  - `src` {trip ref, placeId};
  - `links[]`;
  - `order`.
- **`label`**: `{name, color, order}`.
- **`file`**: as in §3.1. Collection files may link only to `saved` (place photos) and `meta` (the cover).
- **`member`**: as in §3.1.

### 3.3 journey (phase 3)

**`meta`**: `title` (≤200), `subtitle` (≤300), `cover`, `status` (`upcoming|ongoing|completed`), `trips[]` (trip refs, ≤20, distinct), `fields` {mood, weather, prosCons}, `showTracks`, `share` {on, exp, timeline, gallery, map, newestFirst, since}. `exp` and `since` work as for trips (`since` is worker-set on each mint). Absent `timeline` means on. The token hash is in `sp:<id>:secrets`, never in member-readable meta.

**Entity types**:

- **`entry`**:

  | Group | Fields |
  | --- | --- |
  | When | `type`, `date`, `time` |
  | Content | `title`, `story` (md) |
  | Where | `loc` {name, lat, lng, cc} |
  | Fields | `mood`, `weather`, `tags[]`, `pros[]`, `cons[]` |
  | Visibility | `vis`, `order`, `excluded`, `dismissed` |
  | Source | `src` {trip, placeId, visitId} |
  | Media | `media[]` (fileIds) |

  Worker-checked values: `type` `moment|day|checkin|highlight|suggestion`; `mood` `great|good|okay|meh|bad`; `weather` `clear|partly|cloudy|fog|rain|snow|thunder|wind`; `vis` `public` (default) or `members` (never in the public link); `title` ≤300; `tags` ≤30 distinct (case-insensitive), ≤50 chars; `pros`/`cons` ≤20 non-blank items of ≤200 chars; `media` distinct; `loc` has both or neither of `lat`/`lng`; `src.trip` is a trip ref. A `suggestion` is an entry imported from a linked trip's visit (`src` required); `dismissed` hides it until restored, and writing it up changes its type. Media are journey `file`s linked `{t:'entry', id}`; a caption is the file's `desc`. Journey files may link only to `entry` and `meta` (the cover).

- **`book`**: a photo book: `title`, `fmt` (`sq21|sq30|a4l|a4p|a5l|custom`; `custom` uses `w` and `h` in mm, 50–600), `font` (default text font), `bg` (default page color). `fileId` is unused (kept so older values stay valid). Bleed is 3 mm and the safe margin 5 mm.
- **`bookPage`**: one page or spread of a book: `book` (the `book` id), `kind` (`cover|first|spread|last|back`; the cover, first page, last page and back cover are single pages, one each, and spreads sit between the first and last page by `order`), `order`, `layout` (the layout id last applied), `bg` (page color) and `els` {<elementId>: element} (≤80). Elements: `k` (`photo|text|shape|line|icon|flag|country|map|route|stats`), `x`, `y`, `w`, `h` (fractions of the trim box of the page or spread), `z` (stacking), `lock`; photo `file` (a journey file id; an empty photo is a placeholder), `fit` (`fill|fit`), `fx`/`fy` (focal point 0–1), `zoom` (1–5), `filter`, `radius` and `frame` (mm), `frameColor`, `opacity`; text `text` (≤4,000), `style`, `size` (pt), `align`, `font`, `bold`, `italic`, `color`; shapes `shape`, `fill`, `stroke` (mm); `icon` (allowlisted icon name), `cc` (flags and country shapes); travel `scope` (`book|page`), `stat`, `entry`. Colors are palette names (`none`, `ink`, `ink-2`, `ink-3`, `surface`, `surface-2`, `surface-3`, `day-1`…`day-8`) resolved in the light theme for print. `kind` and `book` never change.
  - Concurrency: element edits are path writes (`els.<id>.<field>`), last writer wins per field. Whole-page replacements (a layout, auto layout, an imported spread design) carry `base` (`bookPage` is conflict-checked), so a stale version parks a conflict with keep mine / take theirs. Live cursors and selections travel over `puter.peer` only; they never reach KV beyond the `u:<uuid>:peer` invite (§1).
- **`file`** and **`member`**: as in §3.1.

### 3.4 vacay (phase 3, no worker)

Vacay data is per person, so it lives in each user's own KV, and sharing is direct `puter.kv.share` from the user's own app. Each user pays for their own data and for their own reads of other people's data.

| Key (user's KV) | Value |
| --- | --- |
| `vacay:plan` | `{weekendDays[], weekStart (0 = Sunday), holidays:{country, region}, school:{country, subdivision}, carryOver (most days carried into the next leave year; 0 or absent = none), yearType: calendar\|fiscal\|hire, startMonth, startDay, hireDate, color (1–8)}`; written with defaults on first use |
| `vacay:idx` | `{e:{<date>: ms}, company:{<date>: ms}, allow:{<year>: ms}, cal:{<id>: ms}, inv:{<hash>: ms}}`: every other `vacay:` key with its last write time, so holders, export and delete never list KV. Path writes; written before the key it names on create and after it on delete |
| `vacay:e:<date>` | `{fraction: 1\|0.5, kind: vacation\|comp, note}` |
| `vacay:allow:<year>` | `{days, carried?}`; `<year>` is the calendar year the leave year starts in. Absent `carried` is computed from the previous leave year (capped by `carryOver`); a year without a record takes the closest earlier year's `days` |
| `vacay:company:<date>` | `{note}` (company days, shown to anyone the plan is shared with) |
| `vacay:cal:<id>` | `{type: public\|school\|custom, region, label, color, periods[{start, end}]}`; extra calendars shown as bands (`region` is a country or ISO 3166-2 code; `periods` only for `custom`) |
| `vacay:inv:<hash>` | `{mode: fused\|view, name, uid, at, ack?}`: what the holder of the grant with this hash needs to know. `<hash>` is the first 32 hex chars of SHA-256 of `vacay:<handle>` |
| `vacay:shares` | `{<hash>: {handle, mode, name, uid, color?, at}}` (accepted shares this user holds); written with `disableSharing` |
| `vacay:grants` | `{<hash>: {handle, holder, uid?, mode, name, at}}` (this user's own `vacay:` grants). `holder` is the username `kv.share` returned (a uuid in records written before shares shipped); `uid` is set when the share went to `{uid}` or a fused reply was confirmed by its ack. Written with `disableSharing` |

- **Read-only share**: `puter.kv.share({prefix: 'vacay:', recipient, access: 'read', label})` plus `vacay:inv:<hash>` `{mode: 'view'}`. The holder merges it as an overlay (rings).
- **Fusion**: the inviter shares `vacay:` `read` with `mode: 'fused'`. On accept the holder shares `vacay:` back to `uid` from the invite record. Each edits only their own entries, and the merged calendar shows both with per-person colors. Dissolving unshares both directions; when either side finds the other's handle gone (`kv_handle_not_found`) or its own grant revoked by the holder (`listSharedByMe`), it revokes its own grant too.
- **Identity**: names and uids in invite records are claims. Each side of a fusion writes `ack = SHA-256("vacay-ack:" + <the handle the peer granted me> + ":" + <the handle this record is read through>)` into its record for the peer. A reader that recomputes it with its own grant to that uid knows the record's owner holds that grant; until then the peer shows as not confirmed. The record is bound to its handle, so other holders of the same prefix cannot replay it.
- **Shared company days**: company days of fused people count as company days for everyone in the fusion (vacation on them is not deducted). Each keeps their own in their `vacay:company:*`. No one writes another person's data.
- **Discovery**: creating a share sends the holder `kv.share.received` on `notif:<app>:app-user` (at most 5 an hour from one owner; the Puter desktop does not show it), with the owner-set label naming the sharer. The holder's app lists `listShared()`, skips handles cached in `me:spaces` or `vacay:shares`, and probes `plan` plus `inv:<hash>` through each remaining handle (one batched get). A valid plan marks a Vacay share; owners stay hidden from holders.
- **Live updates**: holders subscribe to `kv:<handle>:*` with `includeValue`, owners to `kv:<app>:vacay:*`; both poll `idx` while visible (events are hints).
- Sharing asks once for `puter.perms.request('kvShare', {prefix: 'vacay:', access: 'read'})`. It needs the platform's `read` level for KV shares; without it (`kv_handles_disabled` on the first share) Vacay is single-user.

## 4. Personal KV (member's namespace)

| Key | Value |
| --- | --- |
| `me:prefs` | theme, text size, contrast, density, accent, language, units (km/mi, °C/°F, kg/lb), date format, 12/24 h, week start, display currency, start page, default trip tab, show place descriptions, blur codes, map (style, place labels, endpoint labels, explore pills, always show routes, optimize from hotel), reduced motion, dashboard widgets, phone tab order, AI models, dismissed tips |
| `me:worker` | `{name, url, path, build, builtAt}` for the user's own worker |
| `me:spaces` | `[{ref, role, title, start, end, cover, opened, handles?:{read, write}, files?:{mode, uid?, inbox?}}]` (cache, not authority; `files` is the last `open`/`join` files block) |
| `me:priv:<spaceId>:pack` / `:exp` | private packing items and expenses for that trip, as `{<itemId>: {id, upd, …fields}}` so each item is one path write |
| `me:atlas` | `{visited:{<cc>: 'manual'}, regions:{<code>: 'manual'}, hidden:{<cc>: true}}`; `cc` is the ISO 3166-1 alpha-2 code of the atlas country (territories the map draws inside another country use that country's code). `regions` keys are admin-1 codes from the bundled boundaries (`public/data/regions/`): the ISO 3166-2 code, or Natural Earth's `XX-X<n>` where a subdivision has none; a region's country is its prefix unless `regions/index.json` `moved` says otherwise. Written by path (`visited.<cc>`, `hidden.<cc>`, `regions.<code>`), so unknown codes and values are ignored on read and left in place |
| `me:bucket:<id>` | bucket-list item `{name, cc?, lat?, lng?, notes?, target?, visitedAt?, upd}`: a name or `cc` (atlas country) is required, coordinates come in pairs, `target` and `visitedAt` are ISO dates. Written whole |
| `me:buckets` | bucket-list index `{<id>: {name, cc?, lat?, lng?, target?, visitedAt?, upd}}` (the item without `notes`), one path per item so neither the list nor data export needs `kv.list`. The item is written before its index entry and deleted before it |
| `me:tpl:<id>` | packing or to-do template `{kind: pack\|todo, name, lists:[{name, items:[{name, qty?, grams?, prio?}]}], upd}` |
| `me:tpls` | template index `{<id>: {kind, name, items, upd}}`, one path per template so `kv.list` is never needed |
| `me:tags` | personal tag names `[name]` |
| `me:collections` | `{order: [spaceId]}`, the member's own order of their collections; ids missing from it sort after, by name |
| `me:cats` | personal categories `[{id, name, color, icon}]` (same fields as the trip `cat` entity) |
| `me:vault` | travel documents, `disableSharing`: `{v: 1, docs: [{id, type, label, number, holder?, country?, expires?, notes?}]}`, or with a passphrase `{v: 1, enc: {alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter, salt, iv, data}}` (base64; the passphrase is never stored) |
| `me:import:<id>` | reserved for booking-import candidates queued by background mail capture (not built) |
| `me:photos` | trip-photo index `{<spaceId>: upd}`, one path per trip, naming the `me:photos:<spaceId>` keys (phase 3) |
| `me:photos:<spaceId>` | the member's private trip photos, references to files in their own drive (never copied): `{v: 1, folder?: {uid, path, name}, items: {<id>: {uid, name, path?, taken?: {date, time?}, lat?, lng?, shared?: <fileId>, upd}}}`. `folder` is a linked drive folder whose images join the pool; `shared` names the trip `photo` file made from it. Written whole after a fresh read |
| `me:seen:<spaceId>` | last-read rev for activity badges before handles are available (then `shared:<id>:u:<uuid>:seen`) |
| `vacay:*` | the user's Vacay data, grants and received shares, all named by `vacay:idx` or fixed (§3.4) |
| `me:key:aerodatabox` | the user's own AeroDataBox (RapidAPI) key for flight status, `disableSharing`: `{v: 1, key, upd}`. A fixed key, so "delete all my data" finds it; never exported, never cached on the device beyond the session, never sent to a worker |
| `me:notify` | out-of-app notification settings `{v: 1, on, channels: {webhook: {on, format: json\|slack\|discord}, ntfy: {on, server, priority: 1–5}, email: {on, every: hour\|day}}, events: {<category>: [channel]}, trips: {<spaceId>: reminders\|off}, lead: [days]}`; categories `reminders`, `bookings`, `members`, `trip`, `plan`, `costs`, `lists`, `files`, `collab`, `chat`; written by path; exported |
| `me:notify:secret` | `{v: 1, webhookUrl?, webhookSecret?, ntfyTopic?, ntfyToken?, email?}`, `disableSharing`; read only by Settings and the user's own events handler; never exported, cached, put in a subscription context or sent to a trip worker |
| `me:notify:sched` | reminder schedule `{v: 1, items: {<id>: {at, kind: trip\|todo\|booking\|overdue, space, w, trip, date, days?, name?, text?, count?}}, test?: {id, at}, tick?}`, written by the app (own trip-start items `trip-…`, to-dos `todo-…`, items forwarded from the in-app reminder model `q-<hash>`) and watched by the handler |
| `me:notify:rev` | `{<spaceId>: rev}`, the last change record the handler looked at per trip |
| `me:notify:retry` | `{<noteId>_<channel>: {ch, note, n, first, next}}`, push deliveries waiting for a retry (≤20, dropped after a day) |
| `me:notify:digest` | `{<noteId>: note}`, notes waiting for the next email digest (≤50, dropped after 7 days) |
| `me:notify:status` | `{<channel>: {at, ok, status?, code?, queued?, dropped?}, test?: {id, at, results}}`, the handler's last delivery per channel |
| `me:notify:d:<YYYYMMDDHH>` | per UTC hour: claim counters (`c.<spaceId>.<rev>`, `r.<reminderId>`, `t.<testId>`, `e.<noteId>_<hour>`), push counts (`rl.<channel>`) and `n`; `incr` paths, TTL 48 h. "Delete all my data" removes the last 49 hours (`notifyKeys()` in `src/lib/notify-out/`) |
| `me:integrations` | server URLs and keys of the user's own services, `disableSharing`, never cached on the device, never sent to a trip worker and never exported: `{v: 1, airtrail?: {url, key, sync?}, immich?: {url, key}, dawarich?: {url, key, trails?}}`. `url` is the server's http(s) base; a key is only sent to its own `url`. `sync` checks for new AirTrail flights while Trips is open; `trails` draws recorded Dawarich trails on the planner map. Written whole after a re-read (phase 3) |
| `me:dawarich` | review state of Dawarich stay suggestions: `{reviewed: {<server>_<visitId>: {s: accepted\|dismissed, at, trip?}}}`, where `<server>` is 8 hex characters of a hash of the server URL. One path write per stay; at most 2,000 entries, oldest dropped (phase 3) |

Out-of-app notifications also hold persistent event subscriptions on the account (not KV) bound to the published handler `tripsNotify`: one on `kv:<appUid>:me:notify:sched` and one per watched trip on `kv:<appUid>:shared:<id>:sig` (owned) or `kv:<readHandle>:sig` (joined), with context `{v: 1, k: trip|sched, u, o, s?, w?, h?}`. Every handler key above is outside the watched keys, so handler writes never trigger it again.

The device credential is not in KV: its non-extractable key pair and credential are in the account IndexedDB (`device:key`, `device:credential`), and the public key in AppData `identity/<fingerprint>.json`.

`me:prefs` keys are flat so each change is one path write and devices editing different settings never overwrite each other. Unknown keys are kept; invalid values read as the default.

| Group | Keys |
| --- | --- |
| Appearance | `theme` (`system\|light\|dark`), `textSize` (0.8–1.6), `contrast` (`normal\|more`), `motion` (`system\|reduce`), `density` (`comfortable\|compact`), `accent` (`blue\|teal\|green\|purple\|orange\|rose`), `tabOrder` (primary route ids in phone tab-bar order; ids it does not name follow in registry order) |
| Language | `lang` (`auto` or a UI locale tag from `src/lib/i18n/locales.js`, such as `de` or `pt-BR`; `auto` follows the browser). This device also keeps its last choice in `localStorage['trips:lang']` for the next start |
| Units and formats | `distanceUnit` (`km\|mi`), `tempUnit` (`c\|f`), `weightUnit` (`kg\|lb`), `dateFormat` (`auto\|dmy\|mdy\|iso`), `timeFormat` (`auto\|24\|12`), `weekStart` (`auto\|mon\|sun\|sat`), `currency` (ISO code or `null` for each trip's currency) |
| Behaviour | `startPage` (`trips\|last\|current`), `tripTab` (a trip tab id), `placeDescriptions`, `blurCodes` |
| Map | `mapStyle` (`auto\|light\|dark\|satellite`), `mapPlaceLabels`, `mapEndpointLabels`, `mapExplorePills`, `mapAlwaysRoutes`, `mapOptimizeFromHotel` |
| Dashboard | `widgetsDesktop`, `widgetsPhone`: `{order: [id], hidden: [id]}` |
| AI | `aiModel`, `aiQuickModel`; `assistantApproval` (`always\|destructive\|never`) may exist from older builds and is not read: the assistant always asks |
| Other | `tips` (`{<tipId>: true}`) |

## 5. Permissions

The roles are `owner`, `editor` and `viewer`. Each action has a minimum role, and the owner can change it per trip within the allowed range.

| Action | Default | Allowed |
| --- | --- | --- |
| `trip.edit` (title, dates, currency, settings) | owner | owner, editor |
| `trip.archive`, `trip.cover` | owner | owner, editor |
| `trip.delete`, `perms.edit`, `transfer` | owner | owner |
| `members.manage` (invite, remove, roles below their own) | owner | owner, editor |
| `share.manage` (public link, feed) | owner | owner, editor |
| `files.upload`, `files.edit`, `files.delete` | editor | owner, editor |
| `plan.edit` (days, places, visits, notes) | editor | owner, editor |
| `res.edit` | editor | owner, editor |
| `costs.edit` | editor | owner, editor |
| `lists.edit` | editor | owner, editor |
| `collab.post` (chat, notes, links, polls, votes) | editor | owner, editor, viewer |

Domain ops authorize themselves against this table. Removing a day (`day.remove`) is a `plan.edit` action, including the consequence on a dated trip: later days and the trip end move up a day without `trip.edit`. Changing the dates directly (`trip.redate`, adding a dated day past the end) needs `trip.edit`. Bookings and expenses a removal changes need `res.edit` and `costs.edit`; file and expense links the caller may not edit are left.

Write rules live in `src/shared/operations.js` (`authorizeOperation`, shared by the client and the worker) plus the worker's type hooks in `worker/ops/<kind>/<type>.js`, and the worker enforces them on every op:

- The permission action needed to create, patch or delete each type (the table below). Paths outside a type's schema are rejected.
- `$self` paths: the first segment after the field must be the caller's uuid (`votes.$self`, `rating.$self`, `tags.$self`, `visited.$self`, `doneBy.$self`, `bring.$self`, `react.*.$self`). Any member who can see the entity may write their own `$self` paths, viewers included where the table below allows.
- `author`: fields only the creator (or the owner) may change or delete.
- The worker reads immutable creator identity from `sp:<id>:author:<type>:<eid>` for author checks. `by` is last-editor attribution and is never an author credential.
- `author` on `note`, `link`, `poll` and `msg` is the member-visible creator, for display only: the creator sends their own uuid on create and the worker refuses any other value and any later change. It is optional, so older entities fall back to `by`. Author checks still use the private record.
- Poll question/options edits require the worker's private first-vote marker to be absent as well as no current votes. Withdrawing all votes never unlocks those fields.
- The worker sets `id`, `v`, `rev`, `upd`, `by` and `cr`. `put` on an existing id is rejected.
- Expense payers and split people (`who`) must be members or guests of the trip. Only people an op adds are checked, so former members stay on older expenses.

| Type | Create | Edit | `$self` paths | Delete |
| --- | --- | --- | --- | --- |
| `meta` | worker only | `trip.edit` (`perms`: `perms.edit`; `share`: `share.manage`; `cover`: `trip.cover`; `archived`: `trip.archive`; `transfer`, `movedTo`: worker only) | none | `trip.delete` (space) |
| `member` | worker only | worker only | none | worker only |
| `day`, `visit`, `dayNote`, `place`, `cat`, `guest`, `via`, `dayEnd`, `dayTrack`, `rtPrefs`, `alt` | `plan.edit` | `plan.edit` | place: `rating`, `tags`, `visited` (any member) | `plan.edit` |
| `res` | `res.edit` | `res.edit` | none | `res.edit` |
| `exp`, `settle`, `splitPreset`, `costCat`, `budget` | `costs.edit` | `costs.edit` | none | `costs.edit` |
| `pack`, `bag`, `todo`, `listMeta` | `lists.edit` | `lists.edit` | pack: `doneBy`, `bring` (any member) | `lists.edit` |
| `note`, `link` | `collab.post` | author or owner | none | author or owner |
| `poll` | `collab.post` | author or owner (`question`, `options` only before the first vote, `closed`, `deadline`) | `votes` (any member who can post) | author or owner |
| `msg` | `collab.post` | author (`text` within 15 min) | `react` (any member who can post) | author (soft delete) or owner |
| collection `saved`, `label`; journey `entry`, `book`, `bookPage` | `plan.edit` | `plan.edit` | saved: `rating`, `tags`, `visited` (any member) | `plan.edit` |
| `file` | `files.upload` (via `file.put`) | `files.edit` (`desc`, `star`, `links`, `linked`) | none | `files.delete` (trash) |

Visibility:
- Everything under `shared:` is visible to every member on every path.
- Per-user tags in shared place entities are displayed only to that user, but are readable by other members. Confidential tags must remain in personal KV.
- `shared:<id>:u:<uuid>:` is written by that member alone and never validated by the worker. Clients clamp and validate what they read there, and ignore unknown fields.
- `pack.vis = people` therefore means "assigned to", not private, and the UI says so. Private items live only in personal KV.
- Viewers never receive invite records, share tokens or feed tokens, because those live under `sp:`.
- Projections for public links and ICS feeds are built in the worker from the snapshot and filtered there.

## 6. Worker protocol

All calls are `POST /api` with JSON `{op, space?, …}`, except files, health and public endpoints. Responses are `{ok:true, …}` or `{code, message, issues?, op?, server?, retryAfter?}` with an HTTP status (commit errors below). Every 429 `rate_limited` carries `retryAfter`, the seconds left in its window (also in the `Retry-After` header). A 402 `owner_credit` means the owner is out of credit; `caller_credit` means the caller is. Every request except `hello`, `/health` and the public routes carries the restricted credential (`puter-auth`) and a proof (architecture §17):
- `x-trips-proof: {version: 2, path, at, signature}`. `path` is the identity file in the Trips app's AppData, `at` the client's clock in ms, and `signature` an ECDSA P-256 signature over `JSON.stringify([workerOrigin, path, sha256(text), at])`.
- `text` is the raw body for `/api` and `"<METHOD> /files/<space>/<fileId>"` for file routes.
- A proof whose `at` is more than 5 minutes from the worker's clock answers 401 `proof_expired` with the worker's `now` (ms). The client re-signs once, offset by the difference. Any other 401 makes it refresh the credential once.

A commit whose change record could not be stored answers 413 `entity_too_large` before it claims a rev.

| Op | Who | Purpose |
| --- | --- | --- |
| `hello` | anyone | `{build, builtAt, protocol, features}`; `GET /health` returns `{ok, build, builtAt, protocol}` without a credential. `build` and `builtAt` are the bundle banner's (§2) |
| `space.create` | worker owner | `{kind, meta, space?}` → `{space, kind, rev}`; a client-chosen `space` id makes retries idempotent |
| `space.list` | worker owner | spaces on this worker |
| `heads` | members | `{spaces:[id]}` → `{heads:{<space>: {rev, title, start, end, role}}}` for several spaces on this worker; omitted ids are unavailable metadata, never an instruction to delete local data |
| `open` | members | `{renew?:true}` → `{kind, role, rev, handles?:{read, write}, files:{mode, uid?, inbox?}, protocol}`; mints missing handles and file shares. `renew` re-shares the caller's handles and direct-file folders when they stopped working (a live share keeps its id; at most 3 per 10 minutes per member, beyond that it is ignored). The owner gets no handles (it reads its own KV) and `files.mode:'direct'`. State bytes come from the handle (path A) or `sync`/`snapshot` (path C), never from a URL. |
| `sync` | members | `{since}` → `{rev, changes[], more?}` (contiguous only, ≤500 records or 4 MB; `more` when capped), or `{rev, reset:true}` (also for a catch-up of more than 50 revs that the snapshot covers). Records are `{rev, at, by, ents, del, sum}`. A longer catch-up is allowed once a minute; reads count toward the member's daily `rdb` budget (429 past it) |
| `snapshot` | members | streams `snapshot.json.gz`: `{rev, at, kind, ents:[{t,…}], tombstones:[…]}`, with the last 200 messages as `t:'msg'` entities; 503 `snapshot_pending` while the first one builds |
| `repair` | members | `{since}`: rebuilds the snapshot if `since+1` is still missing (once per 120 s window); returns `{snap:{rev, at, bytes}\|null}` |
| `pres` | members | `{view?}` heartbeat (the worker does not store `view`) → `{active:{<uuid>: ms}}` for members active in the last 5 min |
| `commit` | by type rules | `{ops:[{opId, …}]}` → `{rev, ents[], del[], done:{opId: rev}}` |
| `chat.page` | members | `{before?, limit?≤200}` → `{msgs:[{t:'msg',…}], more}`, newest first |
| `link.unfurl` | members | `{url}` → `{preview: {title, desc, image} \| null}`: the worker fetches a public http(s) page (SSRF-guarded by `src/shared/reach.js` `PAGE`, no redirects to blocked hosts, ≤128 KB head, ≤8 s) and returns only its title, description and image URL. Cached per URL (`unfurl:` key); 60/min per member in isolate memory and 200 page fetches per member per day (`rl:unf`). Older workers answer `unknown_op` and clients show no preview |
| `invite.create` / `invite.list` / `invite.revoke` | `members.manage` | create `{role, exp?, max?, named?:<username>, label?}` → `{invite:{id, role, exp, max, by, created, named?, label?}, token?}` (the link token is returned once; link tokens and the stub's named invite id are 32 lowercase hex chars, and `invite.id`, used by list and revoke, is their SHA-256 in hex; `label` is a display-only name of ≤80 characters for a personal link, not allowed with `named`); list → `{invites:[…, uses], seats?:[{uuid, username, role, exp}]}` (`seats`: a moved trip's former members who may still rejoin); revoke `{id}`. Roles must be below the caller's |
| `join.preview` | signed in | `{token}` or `{invite}` → `{title, owner, role, kind, exp}` (rate-limited; failures count toward 8 per 10 min). An unusable invite answers 404 `invite_invalid` with `reason`: `expired`, `revoked`, `used` or `invalid` (unknown, someone else's named invite, or older than the caller's removal); `join` does the same |
| `join` | signed in | `{token}` or named `{invite}` → `{space, kind, role, rev, handles?, files}` like `open`; joining again returns the membership |
| `invite.decline` | the named invitee | `{invite}`: removes the stub share and the invite |
| `member.role` / `member.remove` / `leave` | as allowed | `{uuid, role}` / `{uuid}` / `{}`; targets and new roles must be below the caller's role; the owner cannot leave. `member.remove` on a moved trip's former member who has not rejoined revokes their seat → `{removed, seat: true, rev}` |
| `share.set` / `feed.set` | `share.manage` / self | `share.set {on?, exp?, <toggles>, cur?, journey?, rotate?, revoke?}` → `{share, rev, token?}` (token on first enable or rotate, which also stamps `share.since`). Trips take `journey: {w, s, token} \| null` to attach or remove a journey's public link (phase 3); `feed.set {rotate?, revoke?, scope?}` → `{token, path}`, `{exists:true}` or `{revoked:true}`. `scope: 'all'` manages the separate token for the member's "all my trips" calendar and echoes `scope` (older workers do not) |
| `feed.all` | worker owner | `{add?: [{w, s, uuid, token, title?}], remove?: [{w, s}], rotate?, revoke?}` → `{exists, feeds: [{w, s, title?}], token?, path?}` (phase 3): the trips the owner's "all my trips" calendar merges, each with its `scope: 'all'` token; `uuid` must be the owner's; ≤100 trips. The token comes back once, when created (first `add`) or rotated |
| `file.put` | `files.upload` | `{fileId, name, mime, sha256, kind, desc?, taken?, geo?}` plus `inboxName` in direct mode (`taken` and `geo` only for `kind: 'photo'`, which trips take for images); the worker checks the inbox file (size, type by name and magic bytes, budgets) and moves it. Proxied mode: after `PUT /files/<space>/<fileId>` (≤50 MB). → `{rev, ents, del}` |
| `file.del` | `files.delete` | `{fileId}` trashes, `{fileId, restore:true}` restores, `{fileId, purge:true}` deletes a trashed file |
| `space.export` / `space.delete` | owner | export streams gzip JSON `{format:'trips-export', version, space, rev, at, kind, ents, tombstones, members}` with every message; delete tombstones the ACL at once and purges after the response |
| `transfer.offer` / `transfer.cancel` | `transfer` / owner or the offered member | offer `{to}` (an editor or viewer) → `{transfer}`, shown in meta `transfer` for 14 days; cancel `{}` withdraws or declines an offer, or stops a move that has not completed, and unfreezes the space |
| `transfer.accept` | the offered member | `{worker}` (the caller's own worker) → `{transfer, settleAt}`; freezes the space: commits, file writes, invites, joins and member changes answer 409 `space_moving` |
| `transfer.export` | the accepting member | from `settleAt` on, streams gzip JSON `{format:'trips-transfer', version:1, space, rev, at, kind, ents, tombstones, members:[{uuid, role, username}], authors:{<t>:{<id>: uuid}}, pollvoted:[id]}` with every message; before it, 409 `transfer_settling` with `retryAfter` |
| `transfer.complete` | the accepting member | `{to:{w, s}, rev}` (`rev` of the export that was imported) → `{movedTo}`; 409 `transfer_stale` with the current `rev` when the space changed since. Sets meta `movedTo`; the space then answers writes with 409 `space_moved` |
| `transfer.import` | worker owner (receiving worker) | `{from:{w, s}, part?, create?:{kind, meta}, ents?, del?, files?, authors?, pollvoted?, seats?}` → `{rev, space, skipped}`. `from.s` is the space id here too. `create` makes the space (once); `ents` keep their ids and versions (a newer local version wins); `del` `[{t, id, v}]` tombstones; `files` patch `links`, `linked`, `star`, `trashed`, `desc` of files already registered with `file.put`; `seats` `[{uuid, role, username}]` let former members rejoin for 30 days. `part` (an op id) makes a retried call a no-op |
| `transfer.join` | a seat holder | `{}` → like `join`; 404 `seat_invalid` with `reason` (`invalid`, `expired`, `used`) |

Public, no credentials:
- `GET /pub/<space>/<token>`: projection JSON `{ok, v:2, kind, rev, at, share, meta, members, ents, files, journey?}` with an `ETag`; `If-None-Match` answers 304. A trip with `share.road` (and `plan`) adds `rtPrefs`, `dayEnd` and, with the map, `via` entities, plus `meta.settings.addons.roadtrip`; `dayTrack` never appears. A trip with an attached journey adds `journey: {w, s, token}`, that journey's public link, so one link covers the trip, its road trip and its journey. `share` holds the effective toggles and `exp`. Member uuids are replaced by per-projection aliases everywhere (`members[].id`, people fields, per-user keys); per-user fields, `by`/`v`/`rev`/`upd`, deleted messages, todos, notes, links, polls and non-packing `listMeta` are never included. Without `map`, coordinates, addresses, provider ids, tracks and leg shapes are removed; without `codes`, reservation `code`, leg codes, `notes` and `url`. `files` lists the servable file ids: raster cover and place images always, and with `files` on, user files linked to a projected entity.
- Journeys (`kind: 'journey'`) project differently: `meta` is `title`, `subtitle`, `status` and an image `cover`; `ents` are entries copied by field allowlist, never suggestions, dismissed or `vis: 'members'` entries, and never `src`, `vis`, `excluded` or `dismissed`. `timeline` adds the story fields, `map` adds `loc.lat`/`loc.lng` (place names and countries always show), and `timeline` or `gallery` adds `media` (raster user files only). Files carry `desc` (caption) and `thumb: true` when a thumbnail exists, and no links. `share.newestFirst` is a display order hint. Without `map` (any kind), served raster images lose embedded location: the JPEG EXIF GPS directory is emptied and XMP, IPTC and PNG/WebP metadata chunks are dropped.
- `GET /pub/<space>/<token>/f/<fileId>`: a raster image inline; anything else as `application/octet-stream` with `Content-Disposition: attachment`.
- `GET /pub/<space>/<token>/f/<fileId>/thumb`: the stored thumbnail (WebP, JPEG or PNG) of a servable file that has one; 404 otherwise.
- `GET /ics/<space>/<uuid>/<token>.ics`: per-member feed, filtered to what that member's role may see. The token is the member's feed token or their `scope: 'all'` one. Optional `?days=0` leaves out the per-day events, `?alarms=0` the VALARMs, and `?recent=<days>` answers an empty calendar for an archived trip or one that ended more than that many days ago. Answers carry an `ETag` and 304 on a matching `If-None-Match`; 503 `snapshot_pending` (with `retryAfter`) instead of a partial calendar.
- `GET /feed/<token>.ics` (phase 3): the worker owner's "all my trips" calendar, merging the trips in `allfeed`: trips on this worker from their snapshots, others from their workers' `/ics` route with `recent=90` (revalidated by ETag after 15 minutes). One VTIMEZONE per zone, repeated event UIDs once. Cached per isolate for 10 minutes; `ETag` and 304.
- Members download proxied files with a signed `GET /files/<space>/<fileId>` (always `application/octet-stream`).
- Thumbnails: `PUT /files/<space>/<fileId>/thumb` (`files.edit`, image files only, body ≤256 KB of WebP, JPEG or PNG; counts toward the uploader's daily upload bytes) stores the browser-made thumbnail and answers `{rev, ents, del}` with a new `thumb` id. `GET /files/<space>/<fileId>/thumb` returns it to members (`application/octet-stream`, metered like downloads). Both sign `"<METHOD> /files/<space>/<fileId>/thumb"`.

Op element format in `commit.ops` (each element has its own `opId`):
- `{opId, t, id, put:{…}}`: create.
- `{opId, t, id, set:{path: value}, unset:[path], base?}`: patch.
- `{opId, t, id, del:true, base?}`: delete (tombstone; `msg` is instead soft-deleted by the worker, clearing its text and reactions and stamping `deleted:true`).
- `{opId, do:'<domainOp>', args:{…, newIds:{…}}}`: a domain op, with client-generated ids for anything it creates. `DOMAIN_OPS` lists the ones the worker registers: `day.remove`, `trip.redate`, `visit.move`, `costs.settleAll` and `res.moveToTrip`. Templates and imports use plain creates; any other name is refused with `invalid_domain_op`.

A rejected commit answers `{code, message, op?, server?, retryAfter?}`:
- `op` names the failing op element on any per-op 4xx, so the client parks only that one and resends the rest. Batch-level errors name none: `invalid_commit`, `not_member`, `rate_limited`, 409 `space_full`, and 413 `too_many_reads`, `too_many_writes`, `entity_too_large` (the change record) or `batch_too_large` (the batch's billed write bytes alone exceed the per-minute budget). The client splits a batch on a batch-level 413.
- Per-op 409 codes are `stale` (the `base` is not the current version), `gone` (a patch or delete of a missing or deleted entity) and `already_exists` (a create on a taken id). When the entity exists they add `server`: the current entity with `t`, or its tombstone.
- 429 `rate_limited` adds `retryAfter`. Nothing was written; the client holds sends (not polls) for that long and resends the batch unchanged.

Protocol versioning: `protocol` is an integer. Clients do not compare it; a feature that needs a newer worker degrades when the worker answers `unknown_op`. Removing or renaming an op needs 90 days of overlap. `config.json` `minBuild` is a `builtAt` floor in ms: clients send no credential to another owner's worker whose `/health` `builtAt` is lower (or missing).
