# Client contracts

The client data layer. Views use `openSpace` and the personal store. Everything is tested against `dev/fake-puter` with the real worker bundle (and a stub worker in unit tests), not live Puter. Frozen at the Phase 0 contract gate; changes follow PLAN §7.

## Adding a module

1. Strings: create `src/lib/i18n/en/<module>.js` (`export default { '<module>.key': '…' }`) and add one line to `src/lib/i18n/en/index.js`. Keys must start with `<module>.`. Other locales show new keys in English until translated: run `node tools/i18n-check.mjs --write-untranslated` to list them (see Locales below).
2. Views: add `load: () => import('../trip/<tab>/index.js')` to your entry in `src/views/registry/tabs.js` (or `routes.js` for the dashboard, `settings.js` for a settings section). The module exports `mount(container, context)` and may return a cleanup function. `context` is `{app: {navigate, setSyncState, commands}, route, account, puter, personal, signal}`; `signal` aborts when the view is left. Trip tabs mount only on real trip routes (`route.ref`).
   On trip routes the shell also passes `ref` (`{w, s, k}`), `space` (one `openSpace` handle per open trip, shared by its tabs, closed when the trip is left; the shell calls `space.setView(tab)` and reflects `space.onState` in the sync indicator and banners) and `session`. Every view gets `session = {account, db, api, deployer, personal, invites, services, credentials}` (plus `ownWorker`, `ensureWorker`, `openTrip`, `closeTrip`, `withSpace` and `idle` from `src/lib/session.js`), created once per sign-in: `api` from `createWorkerClient`, `deployer` from `createDeployer`, `invites` from `createInvites`, `services` from `createServices`. The Plan tab composes `views/trip/plan/` with the panes `mountPlaces` (`views/trip/places/index.js`) and `mountMap` (`views/trip/map/index.js`), each called as `(container, {...context, plan})`, where `plan` is `createPlanState()` from `views/trip/plan/state.js`.
   A `routes.js` entry with `load` and a one-segment `hash` is a page (`#/atlas` → `{name: 'page', id}`); settings stays the last entry. Collection and journey spaces (`#/c/…`, `#/j/…`) mount the `collections` and `journeys` entries (`SPACE_PAGES` in `main.js`). A trip tab may add `badge: () => import(…)` exporting `unreadBadge(space)` → `{element, destroy}`; the trip shell appends it to the tab link while the trip is open.
   Trip-wide entry points (palette commands, the trip menu, notices) belong in the trip shell (`views/trip/shell.js`), not in a tab: it registers them once per open trip with a context whose `signal` aborts when the trip closes.
3. Commands: append `{ id, labelKey, shortcut?, run(app) }` to `src/views/registry/commands.js`.
4. Schemas live in `src/shared/schema/<kind>.js`; worker ops go in `worker/ops/<kind>/<type>.js` with one line in `worker/ops/index.js`.
5. `tests/unit/rules.test.js` fails on `workers.exec` outside `api.js`, HTML strings, `kv.list` outside `src/lib/sync/`, literal colors outside `tokens.css`, undefined or un-namespaced string keys, and physical CSS properties (`margin-left`, `left:`, `text-align: right`…; use logical ones).

## Locales

- `src/lib/i18n/index.js`: `t(key, values)`, `locale` (UI tag), `direction` (`ltr`/`rtl`), `strings`, `english`, `setLocale(choice, {persist})` (`auto` or a tag from `LOCALES`), `onLocaleChange(fn)`, `availableLocales()`, `requestedLocale()`, `automaticLocale()`, `intlLocale()`. A top-level await loads the device's choice (`?lang=`, else `localStorage['trips:lang']`, else the browser languages) before any view module runs, and sets `lang` and `dir` on `<html>`.
- Each locale is one lazy chunk, `src/lib/i18n/<tag>/<module>.js` mirroring English; missing keys fall back to English. `src/lib/i18n/untranslated.js` lists the keys allowed to be missing; `tests/unit/i18n-locales.test.js` fails on unlisted gaps, placeholder mismatches and bad plural forms. `node tools/i18n-check.mjs <tag> [modules]` checks one locale.
- The account preference `lang` (`me:prefs`) wins once read. A change redraws the shell's current view, so build strings at render time, not at module scope.
- Dates and numbers: `displayLocale()` is the UI language with the browser's region (`de-AT`, `en-DE`).
- Plurals: a locale value may be `{one, few, many, other, …}` (`Intl.PluralRules` categories), picked by `{count}` (else `{n}`). Keys ending `One`/`.one` mean exactly 1; `t()` sends any other count to the counted sibling (`x`, `xOther`, `xMany`, `x.other`), so picking the key with English rules or the locale's rules both work.
- Dev and mock builds add the pseudo-locale `en-XA` (accented, about 40% longer) and `?dir=rtl` to mirror any language.
- RTL: logical CSS properties only; `src/styles/base.css` mirrors directional lucide icons; arrow-key handlers flip with `getComputedStyle(node).direction`.

## Opening a space

```js
import { openSpace } from '../../lib/store/index.js';

const space = await openSpace({
  ref, db, api, puter, personal,          // ref = {w, s, k}; db from openDatabase; api from createWorkerClient
  handles: entry.handles, role: entry.role, files: entry.files, // from personal.spaces.list(), when cached
  ownWorker: (await deployer.current())?.name, // verified ownership only; the owner reads their own KV directly
  view: 'plan', onError, onFlush,
});
// later
space.close();
```

The path is chosen per space: the owner's own KV, path A through the cached read handle, otherwise path C (and `open` is asked for handles). A 402 falls back to path C at most once a minute and retries A after 10 minutes; an unusable handle (`kv_handle_*`, on a read or a region write) falls back to C, and `open {renew: true}` asks the worker to re-share it (at most once per 10 minutes); `kv_handles_disabled` keeps C for the session. Path A and direct files are feature flags (`features: {pathA, directFiles}`, from `loadFeatures()` in `src/lib/sync/features.js` when omitted): always on in dev, tests and the mock build; in production `config.json` `pathA` and `directFiles` turn them on once F0 checks 1–3 pass. With `pathA` off, members never use handles (path C, the worker `pres` op, `me:seen`), though handle ids are still cached. `await space.fileAccess()` is `{mode: 'direct', owner?, account?, uid?, inbox?}` or `{mode: 'proxied'}`: the files block of the last `open`/`join` (the `files` option, then `me:spaces`, then one `open`). `space.refreshAccess({renew})` calls `open` again (rate-limited) and updates handles, role, files and `me:spaces`. `space.state` is `{path, sync, issue, skipped, rev, pending, conflicts, handles}`; `space.onState(fn)` reports changes. `sync` is `idle|syncing|synced|queued|offline|credit|forbidden|conflict`, the shell's sync-indicator keys. `issue` is `credit` (member reads fell back to the worker; show the credit banner), `outdated`, `gone` or null. `outdated` with `skipped > 0` means this build skipped change records or entities it cannot validate (suggest reloading); otherwise the worker is below `minBuild` ("Ask <owner> to open Trips to update"). `gone` means the worker has answered `space_not_found` for 2 minutes without any other failure in between; a shorter run (a space created moments ago in another region) is retried with backoff. Keep the replica either way and let the user remove it.

## Reading

```js
space.select.day.all();                       // frozen, sorted by `order` (or `cr`), same array until days change
space.select.visit.groupBy('dayId').get(dayId); // Map, cached with the visits
space.select.place.get(id); space.select.place.by('cat', 'food'); space.select.place.where((p) => p.lat != null);
space.query('pack', { includePrivate: true, where, sort }); // private items carry `private: true`
space.get('meta', 'meta');
space.overlay('place', id);                   // {pending, local, conflict}
space.can('plan.edit');                       // role plus the trip's permission overrides

const off = space.subscribe({ type: 'place', id }, (event) => render()); // or subscribe('place', fn) or subscribe(fn)
```

Events are `{changed: Set<'type:id'>, types: Set<type>, rev}`; presence changes use type `presence`, feed growth sets `feed: true`. Entities are deep-frozen and keep their identity while unchanged.

`space.role` (and so `space.can()`) follows the caller's member entity: it is read when the space opens and updated before listeners of a change to it run (an event with type `member`, then `onState`), and `me:spaces` is updated. Views that cache `can()` re-check on `member` events or `onState`.

## Writing

```js
const create = space.ops.create('place', { name: 'Museum' });             // {opId, t, id, put}
await space.apply([create], { history: 'Add place' });                       // undoable
await space.apply([space.ops.patch('place', id, { set: { notes } }, { base: true })]); // base: conflict-checked types only
await space.apply([space.ops.remove('visit', visitId)]);
await space.apply([space.ops.domain('costs.settleAll', { transfers }, { settle: transfers.length })]); // args.newIds = {settle: [ids]}
space.flush();                                                               // on blur, navigation or Enter
await space.history.undo(); space.history.canRedo;
```

`apply` validates, persists to IndexedDB and shows the change at once; the outbox sends after 400 ms in batches of at most 200 entity writes (domain ops count their effects or new ids), halving a batch the worker refuses with a batch-level 413. A 429 keeps the frozen batch queued and holds sends, in every tab, for its `retryAfter` (sync shows `queued`); polls go on. A commit acknowledgement never moves the sync cursor. Without `base` an edit is last-writer-wins. `base` is the last server version, never a local one, and queued bases move forward after our own acknowledged write. Domain ops queue as is and show locally only through `registerDomainAdapter(name, (args, {get, entities, uid, now}) => [{t, id, put|set|unset|del}])`. History covers edits and creates per session; deletes and domain ops are not undoable and clear redo, unless `apply(ops, {history, inverse})` passes the undo ops (a domain op's owner knows its reverse). A redone create gets a new id (the old one is tombstoned) and later entries follow it.

## Conflicts

A 409, 400, 413 or 422 parks the op the worker names (`op` in the error body; the whole batch otherwise) in `space.conflicts()` as `{op, code, server, local, at}`; the rest of the batch is resent. A 403 rolls the op back; `onFlush({status: 'rejected', opIds})` lets the view toast. Resolve with:

```js
import { openConflictDialog, conflictList } from '../../ui/conflict.js';
openConflictDialog({ conflict, typeLabel, fieldLabel, onResolve: (choice) => space.resolveConflict(conflict.op.opId, choice) });
// choice: {keep: 'theirs'} | {keep: 'mine'} | {keep: 'merge', set, unset}
```

`mine` resends against the server version, or saves a copy under a new id when the entity is gone. Merge lists only the fields the parked patch changed and resends its own paths for those kept as mine, so `rating.<uuid>` and nested paths never overwrite others. Labels are required and must be translated. `conflictList({conflicts, describe, onOpen})` is the Settings → Offline list.

## Members, feed and chat

- `space.members()`: member entities with `{active, view, seen}`. Presence (`u:<uuid>:pres`) is written every 60 s while visible through the write handle (the member pays), or by the worker `pres` op without handles. `space.setView(name)` updates it.
- `space.markSeen(rev?)` writes `u:<uuid>:seen`, or `me:seen:<spaceId>` without handles. `await space.unread()` counts feed entries by others after it.
- `await space.feed()`: `[{rev, at, by, items:[{t, id, name, fields, op: add|change|remove}]}]`, accumulated in IndexedDB from change records (30 days, 1,000 entries).
- `await space.chatHistory({cursor})`: one older page of messages (path A reverse `m:*` listing, path C `chat.page`), merged into the replica.
- Region values are clamped on read; attribution always comes from `by` in records.

## Personal data

`createPersonalStore({puter, db})` handles `me:*` except credential, worker, vault and integration keys (`private_store_required`), which their owners read and write directly.

- `get(key, {fresh})` answers from the cache and revalidates against the cloud every 30 s; `subscribe(key, fn)` sees changes, and `watch()` applies other sessions' writes from events. `set`, `patchPreferences` (path update) and `refresh(key)`.
- `spaces.list() / upsert(entry) / remove(ref)`: the `me:spaces` index, with handle ids and the files block. It is a cache; upserts re-read the cloud first and are serialized across tabs with a Web Lock (two devices can still race).
- `privateItems(spaceId, 'pack'|'exp')`: `list/put/patch/remove`, one KV path per item, validated with the trip schemas, applied locally at once and queued durably while offline. `flush()` sends the queue; `watch()` and `openSpace` also flush it. A write the cloud refuses is moved to `failedWrites()` (dismiss with `dismissFailed(qid)`), the cache falls back to the cloud value, and `onError` gets `private_write_refused`. `space.privateItems(type)` exposes the same per trip.

## Deploy, invites and the worker client

- `createDeployer({puter}).ensure()` returns `{worker, health, created, updated, adopted}`. It refuses without a verified email (`email_unverified`), parses the bundle banner, writes `worker/trips-worker.js`, creates `trips-<10 random>` (retrying taken names, recovering lost creates and lost records through `workers.list`), polls `/health` without credentials and saves `me:worker`. A recorded worker is trusted only while `workers.get` shows this account owns it; a deleted one is recreated under its name, or `worker_lost`. Updates are forward-only against both the record and the live `/health`. `onProgress(stage)` reports `preparing|creating|updating|starting`. Only the owner's app calls it; links never deploy.
- `ensureShareConsent({puter, db, uid, prefix = 'shared:', access = 'write'})` asks once with `puter.perms.request('kvShare', {prefix, access})` before the first invite (`consent_denied` on refusal) and remembers the grant in IndexedDB; `forgetShareConsent({db, prefix})` drops it after a share came back `share_consent_required`.
- `createWorkerGate({puter, ownWorker})` goes in `createWorkerClient({..., gate})`: other owners' workers whose `/health` `builtAt` is below `config.json` `minBuild` fail with `worker_outdated` (426) before any credential is sent.
- `createInvites({puter, api, spaces}).list()` reads the `info` stub of each read share not already cached in `me:spaces` (six at a time) and hides invalid or expired ones. `accept(invite)` calls `join` and caches the handles and files block; when the index write fails it still resolves, with `indexed: false` and the `entry` to retry. `decline(invite)` asks the worker, or drops the share itself. `watch(fn)` fires on `kv.share.received` notices for shares that are not cached member handles.
- `fetchPublic(puter, {worker, space, token}, {etag})` and `fetchPublicFile(puter, link, fileId)` read the public link routes without any credential (`{data, etag}` or `{notModified: true}`; a Blob).
- `createWorkerClient({puter, credentials, gate})` returns `request`, `call(ref, op, input)`, `commit`, `snapshot`, and the file routes `upload(ref, fileId, blob, {thumb, onProgress, signal})` / `download(ref, fileId, {thumb, onProgress, signal})` (a Blob; idle timeout reset by progress; upload progress where the browser streams request bodies). Views use `src/lib/files/` instead; `fetchHealth(puter, worker)` reads `/health`. A 401 `proof_expired` re-signs once with the worker's clock offset; any other 401 refreshes the credential once. Errors carry `status`, `code`, and `op`/`server`/`reason` from the body.

## Lower layers

- `openDatabase(account)`: account-scoped IndexedDB with `get`, `put`, `remove`, synchronous atomic `update`, `close`. Blocked or failed writes reject. An `update` change that returns the value it was given writes nothing.
- `createCredentialManager`: restricted read token for a proof file plus a non-extractable ECDSA key; `headers(origin, body, {refresh, serverNow})` signs `[origin, path, sha256(body), at]` (data-model §6); `serverNow` sets the clock offset used for `at`.
- `openSpaceStore`: the replica and frozen outbox under `openSpace`. One request in flight and a cross-tab lease per space; a frozen batch is resent byte for byte. `receive` applies contiguous records with version skips; a record that fails client validation is skipped whole, still advances `rev` and is listed in `skipped`. `replace` takes a snapshot or listing and resets `skipped` to the entities it could not validate; `merge` adds entities outside the log. A store opened with skips from an earlier session has `reread` set: path A re-lists `e:*` on its first pull, path C loads the snapshot unless it is behind the replica.
- `createSyncEngine({store, adapter, fallback})` with `createPathA` / `createPathC` adapters. A path A poll reads `sig` and the next record in one batched get (concurrent commits can write `sig` out of order); path C pulls again at once while `sync` answers `more`. Polls every 20 s idle, 5 s after remote activity, 60 s with healthy events or a hidden tab (stopping after 10 minutes hidden), at once on focus, `online` or a gap event, with backoff to 60 s. A gap older than 15 s repairs (path A re-lists `e:*`; path C `repair` plus snapshot).
- `loadHeads(refs, {api})`: batched path C `heads` per worker for the dashboard.

## Remaining work

- The dashboard reads trip heads through path C `heads`; reading each trip's `sig` through its handle (architecture §13) is not built. No credential recovery UI.
- State is one IndexedDB record per space. On the H2 fixture (1.6 MB) each local or remote change rewrites it, about 20 ms on desktop and 60–75 ms on a throttled phone (docs/status.md, Performance); splitting it by type would cut that.
- Path A notices divergence only through a revision gap. A regressed `sig` is caught by reading the next record on each poll; a change record overwritten across regions (the conditional put is checked per region) leaves no gap, so clients wait for the worker's next snapshot rebuild to re-announce it (live check, docs/live-checks.md).
- Load re-applies the 20 records below the signal to cover commits still writing during the listing; anything older relies on repair.
