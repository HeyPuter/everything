# Trips architecture

Static PWA at `trips.puter.com`, with puter.js as the only backend. Platform facts and limits are in [platform.md](platform.md), and the KV/FS layout and entities in [data-model.md](data-model.md).

## 1. Principles

1. **User pays.** Each person's reads, downloads, AI and personal data are billed to them. The trip owner pays only for what has to be authoritative and shared: validated writes, membership and the worker's rent.
2. **The worker validates and orders writes; members read on their own.** Members read trip state straight from the owner's KV through KV share handles, and pay for it (section 6).
3. **Local first.** The UI reads from an IndexedDB replica and writes optimistically through an outbox. The network only syncs.
4. **Polling is the source of truth; events are hints.** Every event channel can fail without data loss.
5. **Nothing authoritative in a user's own KV.** Membership, roles and invites live only in the owner's worker.
6. **Small KV items.** KV writes are billed on the size of the whole item, so state is one item per entity, never one big document.

## 2. Building blocks

```
 member browser                              owner's account
 ┌───────────────────────┐  commit (signed,  ┌──────────────────────────────┐
 │ Trips PWA             │  restricted cred) │ trips-<rand>.puter.work      │
 │  IndexedDB replica    │──────────────────▶│  space engine: validate,     │
 │  outbox               │                   │  order, change log, ACL      │
 │  personal KV / AppData│                   │                              │
 └─────────┬─────────────┘                   │ owner KV (Trips namespace)   │
           │ kv.get/list/set {handle}        │  sp:<id>:      worker-only   │
           │ events kv:<handle>:…            │  shared:<id>:  members read  │
           └────────────────────────────────▶│  shared:<id>:u:<uuid>: member│
                                             │ owner AppData: snapshots,    │
                                             │  files (shared or proxied)   │
                                             └──────────────────────────────┘
 third-party APIs (tiles, geocoding, routing, weather, FX) are called from the browser.
```

- **Trips PWA**: vanilla JS + Vite, deployed with the other apps in this repo.
- **Trip host worker**:
  - One per owner, deployed from the owner's browser into the owner's account (`trips-<10 random chars>`), bound to the Trips app.
  - It hosts every shared object that owner creates, and it is the only writer of shared state outside members' own regions.
- **Personal storage**: the user's own `puter.kv` (prefix `me:`) and `~/AppData/<appUid>/`.

## 3. Spaces

Every shared object is a **space**: an id, a kind, members with roles, a change log, entities and files. The engine is generic, and each kind adds entity types and domain ops.

| Kind | What it holds | Phase |
| --- | --- | --- |
| `trip` | days, places, visits, notes, reservations, expenses, lists, files, collab | 1 |
| `collection` | saved places, labels, statuses | 2 |
| `journey` | journal entries, media, photo book | 3 |

Vacay is not a space. Each person keeps their own leave data in their own KV and shares it `read` with the others through `puter.kv.share` (data-model §3.4).

A space is addressed by a **space ref** `{w: '<worker name>', s: '<space id>', k: '<kind>'}`. Its link form is `#/t/<worker>/<space>` (for collections `#/c/…`, and so on). Only `*.puter.work` workers are accepted, and the worker name must match `/^trips-[a-z0-9]{10}$/`.

## 4. Who stores and pays for what

| Data | Lives in | Pays |
| --- | --- | --- |
| Entities, change log, chat, signal | owner's KV under `shared:<id>:` | owner writes (through the worker); each member pays their own reads |
| ACL, invites, secrets, counters | owner's KV under `sp:<id>:` | owner |
| Presence, read markers, later per-user fields | owner's KV under `shared:<id>:u:<uuid>:` | that member (write handle) |
| Snapshot file (fallback reads, public links, ICS) | owner's AppData `spaces/<id>/state/` | owner |
| Files and attachments | owner's AppData `spaces/<id>/files/` | owner's quota. Uploader pays upload ops. Egress: the reader on direct files, the owner when proxied |
| Preferences, joined-space index, atlas, bucket list, vacay, templates, personal tags | member's KV (`me:*`, `vacay:*`) | member |
| Private packing items, private expenses, travel-document vault | member's KV / AppData | member |
| AI (booking import, assistant, OCR, enrichment) | member's browser | member |
| Map tiles, geocoding, routing, weather, FX | third parties, called from the browser | nobody on Puter |
| Public link and ICS feed traffic | worker endpoints | owner |
| Worker rent | owner | $0.03/month |

Estimates are in section 15.

## 5. Write path

1. The UI calls `store.apply(ops)`. Each op element gets its own client op id. The ops apply to the replica at once and land in the outbox (IndexedDB).
2. The outbox flushes as one `commit` per space:
   - debounced to 400 ms, and immediate on blur, navigation or Enter;
   - one request in flight per space;
   - a batch in flight is frozen and retried byte for byte until it is acknowledged;
   - domain ops carry client-generated ids for everything they create.
3. The worker runs this pipeline:
   1. Authenticate (cached).
   2. Load the caller's member record (cached).
   3. Make one batched get of every `sp:<id>:opdone:<opId>` and every touched entity.
   4. Return the recorded `rev` for op ids already applied.
   5. Validate each remaining op against its type rules (data-model §5): role and permission action, create rights, field allowlist with `$self` path segments, authorship, `base` version, tombstone (409 `gone`), and caps (≤200 entity writes per commit, ≤1 MB body).
   6. Allocate a `rev`: `kv.incr(sp:<id>:rev)`, then write change record chunk 0, `shared:<id>:ch:<rev>:0`, with the conditional put (`set(key, value, expireAt, {onlyIfAbsent: true})`). The change record write is the claim: if a record for that `rev` is already in this region, the put resolves `false` and the worker increments again. Puter checks per region, so two regions claiming the same `rev` before replication both succeed and the later record wins; the next snapshot rebuild re-announces what it lost (sections 8, 9; platform.md, KV shares).
   7. Write the entities. The worker stamps `rev`, `v`, `upd` and `by`; clients never set them. Patches are `kv.update` path writes plus the stamp paths. Deletes write a tombstone `{id, t, deleted:true, rev, v}`.
   8. Write any further change chunks `ch:<rev>:<n>` (≤100 KB each; chunk 0 holds the part count, 30-day TTL), then `opdone:<opId> = rev` (48 h TTL), then the signal `shared:<id>:sig`.
   9. Return `{rev, ents, del, done}` (`done`: `{opId: rev}`).
4. The client replaces optimistic entities with the server versions and drops the acknowledged outbox entries.
5. Errors:
   - 409 `stale` or `gone` parks the op for the conflict UI.
   - 403 rolls back the op and shows a toast.
   - 402/5xx keep the batch queued and retry with backoff.
6. A failure after the `rev` claim and before the entity writes leaves a record whose entities are partly missing. The worker retries in `waitUntil`, and clients treat any gap as described in section 6. The next snapshot or listing repairs it.

Ids are generated on the client (time-sortable, 16 chars base32), so offline creates need no id remapping. A `put` on an existing id is rejected unless its op id was already applied.

Domain ops that touch several entities run in one commit. They are: delete a day with its impact, re-date a trip, move a visit between days, settle up, and move a booking to another trip. The commit produces one change record.

## 6. Reading state

KV keys come in three groups:

| Prefix | What | Who reads | Who writes |
| --- | --- | --- | --- |
| `sp:<id>:` | full ACL, invites, secrets, counters, op ids, rate limits, handle records | worker only | worker |
| `shared:<id>:` (except `u:`) | entities, chat, change records, the signal | every member (read handle) | worker only |
| `shared:<id>:u:<uuid>:` | that member's own presence, read marker and, later, per-user fields | every member | that member (write handle), and the worker |

Everything under `shared:` must be fine for any member, including viewers, to see. Each name prefix is also the region name in Puter's consent prompt, so keep it readable.

**Handles**
- At join, the worker mints each member two handles with `me.puter.kv.share({prefix, recipient: {uid}, access})` (the result names the holder by username, so the worker keys records by the uuid it already has):
  - `read` on `shared:<id>:`;
  - `write` on `shared:<id>:u:<uuid>:`.
- Both are covered by the owner's one-time consent `puter.perms.request('kvShare', {prefix: 'shared:', access: 'write'})` (grant `manage:kv-share-write:<owner>:<appUid>:shared`; `write` covers `read`). The worker's `me.puter` acts as the app, so it needs it too. Trips asks the first time the owner invites someone and again after a named invite comes back `share_consent_required`. Without it, or past the owner's share cap (128 live shares per app on a free plan, so 64 members across all trips), mints fail and the worker stops trying for 10 minutes; members use path C meanwhile.
- Removing a member unshares the read handle, which also retires the narrower write handle; the worker unshares both anyway. A member leaving does the same as holder.
- Handle ids come back in the worker's `join`/`open` responses and are cached in `me:spaces`.
- A handle that stops working (`kv_handle_*` on a read or a region write) sends the member to path C, and the client asks `open {renew: true}` at most once per 10 minutes. The worker re-shares: a live share keeps its id, a stopped one gets a new id, and a stopped read handle took the write handle with it. `kv_handles_disabled` keeps path C for the session.
- Hourly maintenance revokes handles of people who are no longer members. A write handle names its member in its prefix; a read handle names only its holder's current username, so it is kept while its id is on an active member's record or its holder goes by an active member's name.

**Paths**

| Path | How a member reads | Pays | When |
| --- | --- | --- | --- |
| **A. Handles** (default) | `puter.kv.get/list(…, {handle})` on `shared:<id>:`, with keys relative to that prefix | member | whenever `kv.shareHandles` is on and the `pathA` flag is set |
| **C. Worker** | `sync` / `snapshot` ops | owner | before the flag is on, while a member is out of credit (rate-limited), or if a handle call fails unexpectedly |

Path A is built (Q8). The client flag `pathA` is always on in dev, tests and the mock build; in production `config.json` `pathA` turns it on once F0 checks 1–3 pass (`src/lib/sync/features.js`). With it off, members use path C, the worker `pres` op and `me:seen`, as in Phase 1. `directFiles` gates direct file mode the same way. Both paths produce the same shapes: entities, tombstones, `meta`, `members`, and change records `{rev, at, by, ents:[…], del:[…], sum:[…]}`. The sync engine (`src/lib/sync/`) has one adapter per path.

**Path A**
- **Initial load**:
  1. Read `sig` for `R0`.
  2. Page through `kv.list({pattern: 'e:*', returnValues: true, limit: 1000, optConfig: {handle}})`.
  3. Apply change records from `R0 + 1`. Records whose entity `v` is older than the one held are skipped, so the overlap with the listing is harmless.
- **Catch-up**: batched `kv.get(['ch:<n>:0', …], {handle})`, plus extra chunks.
- **Poll**: one batched `kv.get(['sig', 'ch:<rev+1>:0'], {handle})`. Concurrent commits can write `sig` out of order, so the next record is read with it.
- **Chat history**: `kv.list({pattern: 'm:*', reverse: true, limit: 200, optConfig: {handle}})`.
- **Presence**: `kv.list({pattern: 'u:*', returnValues: true, optConfig: {handle}})` on open, then events.

**Path C**
- `sync?since=n` costs one KV read when nothing changed, with a 1.5 s per-isolate cache of `rev`. Otherwise it costs one batched get of the new records. Records older than 2 minutes are cached per isolate for 60 s.
- If `since` is older than the retained log (30 days or 2,000 records), it returns `reset`, and the client loads the snapshot.
- A catch-up of more than 50 revs returns `reset` when the snapshot this isolate knows covers it; otherwise one such catch-up per member per minute is allowed.
- The owner pays path C, so each member has daily byte budgets on KV window counters: 128 MB of records and chat pages read (`rdb`, bytes read, not returned) and 256 MB of snapshots (`snb`). Small reads add up in isolate memory and reach the counter in 256 KB steps.

**Contiguity**
- A client applies change records strictly in `rev` order.
- A record the client cannot validate (usually from a newer release) is skipped but counts as applied. The space reports `outdated` so the UI can suggest reloading, and the next session re-reads the space.
- If `rev = n` exists but record `n` is not readable yet (eventual consistency, or a write still in flight), the client waits and retries.
- After 15 s it repairs. On path A it re-lists `e:*`. On path C it calls `repair`, which makes the worker rebuild the snapshot if the gap is still there.
- The worker's `sync` returns only the contiguous prefix.

## 7. Realtime

**Wake-ups**
- Members subscribe to `kv:<handle>:sig` and `kv:<handle>:u:*` with `includeValue: true`.
- The owner's browser subscribes to `kv:<appUid>:shared:<id>:sig` and `kv:<appUid>:shared:<id>:u:*`.
- The signal value is the compact change record. If it fits in 16 KB and its `rev` is the next one, apply it directly; otherwise run a sync.
- Attribution comes from the `by` field inside records. Events mark worker-session and events-handler writes with `viaWorker`, so `self && !viaWorker` means "this client's account wrote it"; the UI does not depend on it.

**Polling cadence**

| Situation | Interval |
| --- | --- |
| Healthy event subscription | 60 s safety poll |
| No events, someone else edited in the last 2 min | 5 s |
| No events, otherwise | 20 s |
| Hidden tab | 60 s, stopping after 10 min |
| Focus, `online`, or a `gap` event | sync at once |

On path A a poll is one batched `get` (`sig` and the next record) that the member pays for. Back off exponentially on errors, up to 60 s.

**Presence and read markers**
- Each member writes `u:<uuid>:pres` (`{at, view}`) through their own write handle every 60 s while visible, and pays for it. The read marker `u:<uuid>:seen` works the same way.
- Before handles are available, a `pres` op every 60 s is recorded by the worker in `sp:<id>:pres` at most once per 2 minutes per member. The owner pays for this.
- **Later (Q8+)**: per-user fields (`rating`, `tags`, `visited`, `doneBy`, `bring`, poll `votes`, message `react`) move from worker-validated `$self` paths to the member's own region (`u:<uuid>:x:<type>:<eid>` → `{field: value}`). Clients merge them over the entities. Clients must validate anything read from `u:` regions, because the worker never checks them.
- `puter.peer` is used only for live cursors in the photo-book editor (phase 3).

**Out-of-app notifications** (R6, spec §20 [3])
- The developer publishes one events-worker handler, `tripsNotify`, for the Trips app (`npm run build:notify`, then `puter.events.handlers.publish('tripsNotify', source, {appUid})`; republishing resumes suspended subscriptions). The app owner pays the events worker's rent.
- Each user who turns notifications on grants `events:background` and holds persistent subscriptions (data-model §4) on `me:notify:sched` and on each watched trip's `sig`: their own KV for trips they own, their read handle otherwise. The handler runs as that user (15-minute token), so the user pays for its deliveries, KV reads and writes, and emails. Trip workers never see notification settings or secrets.
- A run reads the change records after `me:notify:rev` (the signal value, then `ch:<rev>:0` for revs that coalesced events skipped, at most 20), leaves out the user's own changes, claims each rev, reminder and test once in an hourly `incr` bucket, and sends to the chosen channels: signed webhook (JSON, Slack or Discord), ntfy JSON publish, or an email digest through `user.email.sendTransactional` (paid plans). Push channels are capped at 30 per hour each.
- Sends never follow redirects and pass the shared reach rules (`src/shared/reach.js` `RECEIVER`: https on 443/8443, public addresses only) on save and before every send; workers also run with `global_fetch_strictly_public`. Transient failures retry inline (0, 1, 3 s), then from `me:notify:retry` on later runs (1 min to 6 h, at most a day). The handler always returns, so the platform never suspends a subscription for delivery failures.
- Puter has no scheduled triggers. Reminders and email digests go out on the next run after they fall due: any watched trip change, the open app's wake-up write to `me:notify:sched`, or a test.
- Email goes only to the account's own confirmed address (`user.auth.getUser()`, checked before every send), at most 5 emails an hour, tests included. Tests are capped at 5 an hour on every channel. Links point at `https://trips.puter.com`; the subscription context's `o` is not used.

## 8. Snapshots and repair

The snapshot file `state/snapshot.json.gz` serves path C, public links, ICS feeds and exports. Path A clients never need it.

**When a rebuild runs**
- A path C sync, public request or feed request finds `rev - snapRev ≥ 200`, or the snapshot is older than 10 minutes with changes since.
- Or a client asks for `repair`.
- No rebuild ran in the last 2 minutes. The claim key `sp:<id>:snapclaim:<epoch/120s>` is `incr`'d; the window number in the key means a lost `expire` cannot block rebuilds.
- The rebuild runs in `waitUntil`.

**How it is built**
- Scan with `kv.list({pattern: 'shared:<id>:e:*', returnValues: true, limit: 1000, cursor})`. Use the object form: `kv.list(prefix, {returnValues})` returns keys only.
- Gzip with `CompressionStream`.
- Chat messages live under `shared:<id>:m:`, outside the scan. The snapshot embeds the last 200 messages from a separate reverse list of `m:`.
- The snapshot carries `meta` (the public `e:meta:meta` entity) and `members` (the public `e:member:*` entities). Secrets and the full ACL stay under `sp:`.
- Tombstones older than 30 days are deleted during the rebuild; newer ones go in the snapshot's `tombstones`.

**Repair**
- A full scan, by the worker or by a path A client re-listing, is authoritative.
- Clients replace their replica from it and re-apply their pending outbox.
- A rebuild also checks the change records since the previous snapshot against the scan. An entity whose record lost it (another region overwrote the record) or shows a different state (concurrent patches merged in KV, a delete racing an edit) is re-announced in a new record with a fresh `v`, so clients that never reload the snapshot converge too.
- `kv.list` runs only for rebuilds, path A loads and repairs, chat history and presence on open. It is never polled.

## 9. Consistency and conflicts

- **Entity stamps**: `v` (a hybrid logical clock string), `rev`, `upd` (ms) and `by` (uuid), all set by the worker.
- **Field edits** are path updates, so concurrent edits to different fields of one entity both survive within a region.
- **Delete vs edit**: `kv.update` creates items, so a late patch could resurrect a deleted entity. Patches therefore read the entity first (in the batched get), and a tombstone answers 409 `gone`.
- **Conflict-checked types** (places, visits, reservations, expenses, packing items, notes, saved places, photo-book pages) accept `base: v` on patch and delete.
  - A mismatch returns 409 with the server entity, and the client shows Keep mine / Keep theirs / Merge fields.
  - The conditional put has no expected-value form, so the check is read-then-write and narrows conflicts without excluding them.
  - Online edits without a `base` are last-writer-wins, as in most of the app.
- **Cross-region**: KV replicates between regions with last-writer-wins per item.
  - The conditional put holds within a region: a worker that finds a record for its `rev` already replicated here re-increments.
  - Two regions claiming the same `rev` before replication both succeed, and one change record overwrites the other. No rev is missing, so clients see no gap; the next snapshot rebuild re-announces what the lost record held (section 8).
  - Entities are always correct in KV.
  - Tests cover both with the fake runtime's `regions: 2` mode (`dev/fake-puter`), which checks `onlyIfAbsent` per region as Puter does.
- **Ordering** inside lists uses fractional index keys (`order: "a0V"`), so a move writes one item.
- **Per-user fields**: chat messages are separate items. Votes, reactions, ratings, personal tags, `visited`, `doneBy` and `bring` are per-user, as `$self` paths or member regions, so they never conflict.

## 10. Files

**Direct** (the owner's account can share files: phone or card verified)
- At join, the worker shares `spaces/<id>/files/` with the member (read) and `spaces/<id>/inbox/<uuid>/` (write, only for `files.upload`).
- To upload, a member writes into their inbox, then sends a `file.put` op. The worker stats the upload and checks size, the type allowlist (by name and magic bytes in the first chunk), and the budgets. It then moves the file to `files/<fileId>/<name>`, which is read-only to members, and registers it. Rejected uploads are deleted.
- Inboxes are swept of anything older than 1 hour on any member's open and on each `file.put` from that member.
- Readers download directly by uid and pay the egress. Thumbnails are read by path under the shared folder.
- The owner reads and uploads through its own AppData, which is the worker's namespace.
- Any direct failure (share gone, unknown path, the reader out of credit) falls back to the worker for that trip for 10 minutes and asks `open {renew: true}`, which re-shares the folders. A file that is merely missing falls back alone.

**Proxied** (otherwise)
- Uploads and downloads go through the worker: a streaming `PUT/GET /files/<space>/<fileId>` with a membership check, at most 50 MB per file. The owner pays egress.
- Video over 50 MB needs direct mode.

**Both**
- Track geometry (GPX) and photo-book documents are files with an internal `kind`, so they follow the same mode.
- Thumbnails (320 px WebP) are made in the browser and stored next to the file.
- HEIC is converted in the browser before upload.
- Trash keeps files for 30 days. The purge runs on the owner's next open.
- Downloads become blob URLs. The public `/f/` endpoint sends `application/octet-stream` with `Content-Disposition: attachment` for anything that is not a raster image. SVG/HTML are never rendered inline.
- Per-member budgets: 200 uploads/day, 1 GB/day. The space quota is 2 GB (413 `space_quota`). All are enforced in `file.put` or the worker upload route.
- Attach from the Puter drive: the picker grants access, and the file is copied into the trip through the normal upload path. "Save to my drive" copies out with `showSaveFilePicker`.
- Sending a trip file to AI: the member's browser first copies it to their own AppData (`tmp/`), because `puter_path` must be readable by the caller. The copy is deleted after the call.

## 11. Joining, roles, discovery

**Roles**
- `owner` (one), `editor`, `viewer` (read-only).
- Guests: people without accounts who appear in splits and assignments. They are space entities, not members.
- Per-trip permission matrix (data-model §5) with defaults. The owner can change it.

**Who can own** — creating a worker needs a verified email, so the app asks for verification before the first trip. Every member has a full Puter account; temporary accounts no longer exist in production.

**Invite link**
- `#/join/<worker>/<space>/<token>`, with the token in the hash.
- The token is 128-bit random, stored as `sha256` with role, expiry (default 14 days) and max uses.
- Uses are counted with `kv.incr` on `sp:<id>:invc:<hash>`.
- Failed joins: 8 per 10 min per account, then 429. The window number is in the key.

**Named invite (by Puter username)**
1. The worker writes a stub `shared:inv:<inviteId>:info` (`{invite, worker, space, kind, title, ownerName, role, exp}`).
2. It shares `shared:inv:<inviteId>:` with the invitee at `read`, labelled "<title> · from <owner>" (cleaned to Puter's label rules). Puter resolves the username; refusals map to `user_not_found`, `recipient_refused`, `share_consent_required` and `share_limit`.
3. It records the pending invite with the stub handle and the holder's username as Puter returned it. Puter sends `kv.share.received` to the invitee's Trips (the desktop does not show it).
4. The invitee's Trips app lists `puter.kv.listShared()`, reads `info` through each invite handle, and shows Accept/Decline. Expired stubs are hidden.
5. Accepting calls `join` with the invite id. The worker accepts the caller when their username matches the recorded holder; after a rename it re-shares the stub to the caller's uuid, which answers with the same handle only for its holder (a probe share made for anyone else is unshared). Trip state, files and the member handles are granted only inside `join`.
6. The worker unshares and deletes the stub on accept, decline or expiry. Expiry cleanup runs in the hourly maintenance on the owner's open. The invitee can also unshare the stub themselves.

Invites by email use a personal invite link until `kv.share` accepts email recipients.

**Joining**
- Shows the owner's name and the trip title, then asks for confirmation.
- Joining sends a restricted credential only, never the session.

**Leaving or removal**
1. Mark the member record `removed` (a path write) and delete the member entity.
2. Remove their public `member` entity.
3. Unshare their handles (which also retires the narrower write handle) and their file folders.
4. Delete their `u:<uuid>:` region.

A removed person can come back only with an invite created after their removal.

**Old worker builds** — `config.json` carries `minBuild`, a `builtAt` floor. The client will not send credentials to a worker whose `/health` `builtAt` is older; instead it shows "Ask <owner> to open Trips to update". This is how security fixes reach dormant owners' workers.

## 12. Public links and feeds

- **Public trip link**:
  - `#/s/<worker>/<space>/<token>` opens a read-only viewer in the same app (lazy chunk, no sign-in).
  - The viewer calls the worker without credentials. The worker returns a projection of the snapshot filtered by the share toggles: plan, map, bookings, codes, packing, costs, chat, files. Member uuids become per-projection aliases. Responses carry an `ETag`, and `If-None-Match` answers 304.
  - It always strips private fields, member emails, file paths, confirmation codes and booking notes and links (unless the owner opts in), and coordinates (unless the map is shared). Attachments are served only with the files toggle; cover and place images always.
  - Images and files go through the worker with size caps. The response is cached per isolate for 30 s.
  - Rate limit: 60 requests/min per token per isolate, plus a KV window counter of 600/hour per token.
  - Toggles live in the space meta; the token is stored hashed. The owner can rotate or revoke it. Expiry is optional and checked on every request.
- **ICS feed**:
  - `GET /ics/<space>/<uuid>/<token>.ics`, one token per member, filtered to that member's role and built from the snapshot.
  - Includes VALARM reminders for trip start, timed bookings and to-dos with due dates.
  - Calendar clients poll it, so it carries `Cache-Control: max-age=900`.
- **Public journey link** (phase 3): same mechanism, with timeline/gallery/map toggles.

## 13. Personal data and the dashboard

- `me:spaces` holds the joined-space index: ref, role, handle ids, cached title, dates, cover thumbnail, last opened. It is a cache; a member's role is always checked in the worker.
- The dashboard renders from the index plus each space's replica in IndexedDB.
  - Path A refreshes `sig` per space with one batched read per owner where possible.
  - Path C uses a batched `heads` op per worker.
- Atlas, bucket list, vacay data, templates, personal categories and tags, and the travel-document vault (stored with `disableSharing`) live in the member's KV.
- Private packing items and private expenses for a trip live in `me:priv:<spaceId>:*` and are merged into that trip's views on the client. Nobody else, including the owner, can read them.

## 14. AI

All AI runs in the browser with `puter.ai.chat`, billed to the user. Patterns to copy: `src/presentation/src/cloud.js` (streaming plus tools) and `src/expense/src/lib/ocr.js` (extraction).

- **Booking import**:
  - Inputs: files (PDF, image, EML, HTML, TXT), pasted text, or mail in `<username>@puter.email` (needs `.mail:read`).
  - `.pkpass` files are parsed locally, without AI.
  - EML MIME is decoded locally. Text and HTML parts go as text; PDF attachments go as `{type:'file', puter_path}` to a Claude model.
  - Output is shaped by `outputFormat` JSON schema, then deterministic checks run: airport and timezone lookup, AM/PM sanity, leg order, duplicate totals across segments.
  - The user reviews every item before anything is committed. Dedupe uses provider plus confirmation number.
- **Assistant**:
  - A trip-scoped agent with tools: read the trip; create or edit days, places, visits, reservations and list items; search places; `web_search`.
  - Every write is a preview the user approves first; there are no approval modes. Each approved change is one undo step.
  - The system prompt states that tool output and trip content are data, not instructions.
- **Default models**: `claude-sonnet-5-5` for import and the assistant (PDFs need Claude), `claude-haiku-5-5` for small extractions (OCR clean-up, packing suggestions). The user can pick in settings.
- **Cost display**: show an estimate before large imports. Handle 402 (`insufficient_funds`) with an upgrade prompt.
- **Tests** use the free test mode (`puter.ai.chat(..., true)`).

## 15. Cost model (targets, enforced by tests)

The fake worker runtime counts KV and FS operations, and tests assert these budgets:

| Operation | Budget |
| --- | --- |
| Path A poll | 1 batched KV read (`sig` and the next record), billed to the member |
| Path C sync, no changes | ≤2 KV reads (rev, member record); 0 with warm isolate caches |
| Path C sync, k changes | the above + ⌈k/100⌉ batched gets (0 for records cached in the isolate); +1 `incr` per 256 KB read |
| Commit with n entity ops | 1 batched get (op ids and entities) + 1 `incr` + 1 conditional put + n entity writes (creates and deletes share one batch; a patch with `unset` paths costs 2) + extra chunks (usually 0) + 1 batched op-id write + 1 signal write; +1 cap-counter `incr` when it creates or deletes; +1 membership read when the caller's record is not cached (1 s); +1 `incr` per MB written (daily write budget) |
| Delete (or message edit) | the commit above + 1 write of `sp:<id>:scrub` + per version depth (usually 1) 1 batched get of the records that held earlier versions and 1 batched rewrite of them |
| Presence | 0 owner ops on path A; ≤1 KV write per active member per 2 min before handles |
| Join | ≤10 KV ops + 2 handle mints (+ 2 file shares in direct mode; the first direct-mode join also records the files mode) |
| Handle renewal (`open {renew}`) | the `open` reads + 2 handle mints (+ ≤2 file shares and 1 member re-read in direct mode) + 1 record write and 1 member re-read when an id changed; ≤3 per member per 10 min |
| Counter windows (`snapclaim`, `rl:`, `fail:`) | window number in the key; `expire` is only cleanup |
| Snapshot rebuild, 2,000 entities | ≤3 list pages + 1 FS write |

Rough owner cost for an active five-person trip over a planning month (2,000 commits, events healthy):

| Item | Path A | Path C |
| --- | --- | --- |
| Commits (including validation reads) | ~$0.05 | ~$0.05 |
| Sync reads | $0 (members pay) | ~$0.02–0.06 |
| Presence (5 members, 1 h/day) | $0 (member regions) | ~$0.02 |
| Snapshots (public links, ICS, fallback) | ~$0.01 | ~$0.01 |
| Rent | $0.03 | $0.03 |
| **Total** | **~$0.09** | **~$0.15** |

Attachment egress ($0.20/GiB) is the largest variable cost. In direct file mode the reader pays it; when proxied, the owner does.

## 16. Failure modes

| Case | Behavior |
| --- | --- |
| Member out of credit (402 on their own reads) | Fall back to path C for sync (rate-limited to 1/min), with a banner. Writes still work because the owner pays them. Presence writes pause. |
| Owner out of credit | Today the worker keeps working because deployer usage is not credit-blocked, but that depends on a platform enforcement setting and can change. Show the owner a banner from `getMonthlyUsage`. If the worker starts answering 402, the trip goes read-only and members see "<owner>'s Puter credit has run out". |
| Worker evicted after 30 idle days | Path A reads keep working: they go straight to KV. The first worker request takes ~5 s, so the client shows "Waking the trip server…" on the first commit. |
| Old worker build (the owner hasn't opened the app since a release) | Ops are backward compatible for 90 days. Clients refuse workers older than `config.json` `minBuild` with "Ask <owner> to open Trips to update", and a feature that needs a newer op degrades when the worker answers `unknown_op`. |
| Owner deletes their account or worker | Members keep their replica read-only and can "Make my own copy" (JSON plus files they can still read). |
| Ownership transfer | The owner offers the trip to a member. On accepting, the new owner's app freezes the space, exports it from the old worker and imports it into their own worker under the same space and entity ids, copying files, then completes the move. Each step is idempotent and journaled, so it resumes after any failure. The old space keeps `movedTo` as a read-only stub for 30 days; members' clients follow it, rejoin through seats with their roles and re-apply edits the freeze refused. |
| A trip far beyond normal size | Hard caps per space: 20k entities, 1k days, 5k places, 50 members. Clear errors. |

## 17. Security checklist

Apply this to every PR that touches the worker, handles or rendering.

- **Identity**:
  - Comes only from a credential Puter validated in this request. That means `user.puter.fs.stat(proof.path)` succeeded with the restricted token, the file is owned by the caller, and the signature over `[workerOrigin, path, sha256(body), at]` verifies. The uuid may then be read from that same token's claims.
  - `at` is the signing time in ms. The worker refuses proofs more than 5 minutes from its clock (401 `proof_expired` with its `now`, before any read), so a captured request replays for at most 5 minutes instead of the credential's 24 hours. Within that window commit `opId`s keep writes idempotent.
  - Never trust ids, roles or usernames from bodies or URLs, or from tokens that were not validated this way.
  - There is no session-token branch: the owner's own browser uses a restricted credential too.
  - Pin `cfg.owner` from `me.puter.auth.getUser()`, not from the first request.
- **Authorization**:
  - Check the role and permission action on every op, inside the worker.
  - Anything placed under `shared:` is readable by every member, so viewer-hidden data never goes there.
  - Data in `u:` regions is unvalidated and is rendered as untrusted input.
- **Worker calls**:
  - `src/lib/api.js` is the only module allowed to call `puter.workers.exec`. It always sets `puter-auth` to the restricted token, so the session is never attached. A test fails on any other `workers.exec` call in `src/`.
  - Targets are only `https://trips-*.puter.work`. A URL from a link is validated before any call.
  - An invite link never triggers a deploy.
  - One restricted credential per device, not per worker. The signature already binds the worker origin, and minting is limited to 20/hour.
- **Handles**:
  - Mint only on the prefixes in data-model §1, recipients by uuid.
  - Unshare on removal.
  - Never put a handle id in a URL or log.
- **Input**:
  - Ids match `/^[0-9a-z]{16}$/`.
  - Strings are clamped, numbers range-checked, enums allowlisted.
  - Lookups use `Object.hasOwn`.
  - Request bodies are capped at 1 MB (files 50 MB).
  - Schemas are shared by client and worker (`src/shared/schema`).
- **Errors**: all handlers are wrapped. Errors go back as JSON `{code, message}` without internals, with CORS headers on every response including 404.
- **Rendering**:
  - No `innerHTML` with user content.
  - Markdown renders through `src/ui/md.js`, which builds an allowlisted DOM tree and never parses HTML.
  - Links are http(s) only and show their real host.
  - Uploaded SVG/HTML are never rendered.
  - Untrusted data is never copied into `document.title` or into attributes that execute.
- **Tokens and secrets**:
  - Invite, public and feed tokens are 128+ bits, stored hashed, and compared timing-safely.
  - Credentials are never logged.
  - Third-party keys a user enters stay in their own KV with `disableSharing`.
- **Abuse**: per-member budgets in the worker (ops/min, creates/hour, KV write bytes, path C read bytes, uploads/day, invites/day, failed joins), because the owner pays for every validated write. Write bytes count whole items, since `update` bills max(old, new) size even for a viewer's `$self` patch. Day budgets live on KV window counters, so new isolates don't reset them. Notes, links and polls have their own cap (2,000), so members who may only post can't fill the space.
- **History**: a delete, a message soft delete or a message edit scrubs the earlier versions out of the change records (each `sum` entry names the record of the version before it), so members who join later can't read them through their handle or `sync`. A snapshot older than the last scrub is rebuilt before it is served. Edits of other entities stay in the records for their 30 days, readable by members.
- **Direct-mode files**:
  - File shares go by username, which can change. Removal and hourly maintenance list the `files/` folder's shares and unshare anyone who isn't an active member; inboxes are revoked by deleting them.
  - Inbox writes bypass the upload budgets until `file.put`. Any member's `open` sweeps all inboxes (at most every 10 minutes per isolate), charges what it deletes to the member's daily upload bytes, and takes the inbox away for the day once that runs out. A perms change that takes `files.upload` away drops those inboxes at once.
  - Members read files by path inside the trip's folder, never by a uid from an entity, and check that the folders the worker names belong to the trip.
  - Residual risk: Puter has no per-recipient quota on a shared folder, so a member can fill the owner's storage until the next sweep. Owners worried about this can keep the trip in proxied mode.
- **Outbound fetches** (link previews, webhooks): `src/shared/reach.js` refuses literal private addresses and local names. Names that resolve to private addresses are the platform's to refuse: heyputer deploys every worker with `global_fetch_strictly_public`, and self-hosted workerd denies link-local and private ranges. A worker can't see the address a fetch reached, so there is no check after the fetch (live check in live-checks.md).
- **Public endpoints**: read-only projections, rate-limited, never touching ACL or member records. Members appear by initial only. Without the map, images are served without location data, and HEIC, AVIF and video attachments are not served. A flood of bad tokens never blocks the refresh for a token the isolate already accepted.
- **Third-party images**: unfurl images, covers and place images from URLs load from their hosts with `referrerPolicy: no-referrer`, so the host sees the viewer's IP and user agent. Uploaded covers avoid this.
- **Workers and storage**:
  - The worker source file lives in the owner's AppData outside `spaces/`, so it is never shared.
  - Updates are forward-only (`build`/`builtAt`).
  - The app never runs a worker built by anything other than its own bundle.

## 18. Performance budgets

- **Cold start**: app shell plus cached dashboard in < 1.5 s on a mid phone. MapLibre and heavy views load lazily.
- **Opening a cached trip**: < 300 ms to interactive.
- **Syncing 100 changes**: < 300 ms.
- **Big trips** (60 days, 1,000 places, 500 expenses): lists virtualized, markers clustered, DnD at 60 fps.
- **Worker caches** (per isolate, all bounded):

  | Cache | Freshness |
  | --- | --- |
  | Identity / credential proof | 5 min, revalidated every 30 s, 2,048 entries |
  | Member record (role) | 1 s; the space doc (kind, folders) 60 s; `idx` 30 s, re-read on an unknown id at most every 5 s |
  | Space meta | 5 s |
  | `rev` | 1.5 s |
  | Snapshot | LRU, 16 MB |
  | Change records older than 2 minutes | 60 s, LRU, 16 MB; a scrub drops this isolate's copies |
  | Public projections | 30 s |

  Never share an in-flight promise between requests.

## 19. Platform dependencies and asks

**Shipped** (October 2026; differences from the design are in platform.md, KV shares; F0 check 1 confirms them live):
- KV shares at `watch`, `read` and `write`, with `optConfig.handle` on every method and `list` options through handles.
- Minting from an app-bound worker's `me.puter` with uid recipients after the owner's `kvShare` consent; no phone or card gate; 128 live shares per app on free plans.
- Narrower write handles inside a broader read handle (revoking the broader one retires them).
- Owner-set labels and a `kv.share.received` notice in the app.
- `viaWorker` on events.
- A conditional put (`onlyIfAbsent`), checked per region. An expected-value form did not ship.

**To confirm live:** fresh reads of polled keys through a handle.

**Still open:**
1. **Scheduled triggers for workers or event handlers**, for reminders and digests. Until then: ICS alarms and in-app reminders.
2. **App-scoped file sharing without phone/card verification** when the shared item is the app's own AppData. Without it, owners who can't share fall back to proxied files.
3. **`kv.share` to email recipients**, for invites to people without Puter accounts.
4. A light/dark signal from the desktop to apps.
5. Adding Trips to the first-party AI free-credit list.
