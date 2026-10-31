# Puter platform facts for Trips

What the app may rely on, read from the puter.js SDK and backend source (`heyputer/packages/puter`, October 2026). Where the published docs disagree, this file follows the code. Items marked **verify** are checked live in task F0 before anything depends on them; record results in `docs/platform-verified.md`.

Paths: `SDK/` = `packages/puter/src/puter-js/src/`, `BE/` = `packages/puter/src/backend/`.

## Billing

| Action | Billed to |
| --- | --- |
| Any `puter.*` call from the app (AI, KV, FS ops, egress, event deliveries) | the signed-in user |
| `user.puter.*` inside a worker | the caller |
| `me.puter.*` inside a worker | the worker's deployer (currently not blocked at zero balance, depending on a platform enforcement setting; every `me.puter` write must be authorized and budgeted) |
| Worker existence | $0.03/month to the deployer |
| Files B writes into A's shared folder | A's storage quota; B pays the request |
| B reading A's shared file | B pays egress |
| Anonymous download of a `/sign` URL | the file owner (**verify**: a signed-in reader may pay instead) |
| `getReadURL` link | whoever minted it |
| Anonymous visitor to a `*.puter.site` page | the site owner |
| `puter.peer` TURN relay | the user who minted the credential |
| `puter.net.fetch` | not metered |

Unit costs: egress $0.20/GiB; KV ~50 µ¢ per read unit (4 KB) and ~250 µ¢ per write unit (1 KB of the **whole** item; `update` bills max(old, new) size); FS writes $0.01/1k ops, reads $0.001/1k; event delivery 10 µ¢ (broadcast). Storage bytes are a quota, not a charge (100 MiB free). Free accounts get $0.50/month of usage; at zero balance KV get/set and FS read/write return **402** too, not only AI. Plan 402 handling everywhere.

## Auth and identity

- Apps see the real user uuid (`/whoami`). Usernames can change; store uuids.
- Tokens are server-signed; nothing outside Puter can verify them locally. App tokens live a year (sliding) and `signOut()` does not revoke them.
- App identity is the origin: the registered app whose `index_url` is the origin root. Keep Trips at the root of `trips.puter.com` or standalone visits land in a different KV/AppData namespace.
- `puter.env === 'app'` inside the desktop (hide Sign out); `'web'` standalone. `signIn()` only from a click.

### How a worker knows the caller

- `puter.workers.exec(url, init)` is `fetch` plus a `puter-auth` header carrying the caller's session token, **to any URL**, unless `puter-auth` is already set. Only call `https://*.puter.work` hosts the app trusts, and always set `puter-auth` yourself.
- The router builds `user.puter` from that header without validating it. Validate with `user.puter.auth.getUser()` (session/app tokens) and check `app_name === <Trips app uid>`, or use the restricted-credential scheme below.
- **Restricted credential** (use this, `src/wiki/src/collab/auth.js` + `src/wiki/worker/auth.js`): the member writes a tiny identity file holding a public key in their AppData, mints a read token for it with `getReadURL` (rate limit 20/hour, so cache it), and signs each request `[workerOrigin, path, sha256(body), at]` with a non-extractable ECDSA key (`at` bounds replays to 5 minutes). The worker validates the token with `user.puter.fs.stat(path)`, checks ownership and the signature. The member's real session never reaches code the trip owner controls.

## KV

- Namespace per (user, app). No other user can read or write it. **User KV is editable by its user** through other tools, so it can never hold ACLs or anything authoritative.
- Methods (BE/drivers/kv/KVStoreDriver.ts): `set`, `get`, batch `get([keys])` (undocumented, chunks of 100, counts as one call), batch `set([...])` (not atomic), `del`, `incr`/`decr` (plain or nested paths; no TTL argument, so put the time window in the key), `add` (atomic list append at a path), `update` (several paths in one write, creates missing parents), `remove(key, ...paths)`, `list({pattern: "prefix*", returnValues, limit ≤1000, cursor})` (object form: `list("prefix*", {returnValues:true})` treats the second argument as config and returns keys only), `expire`, `expireAt`, `flush`.
- No compare-and-set and no transactions. `set(key, value, expireAt?, {onlyIfAbsent: true})` writes only when no live entry holds the key and resolves `false` otherwise; the check is per region (see the consistency note under KV shares). It is read only from `optConfig`, never from the object form, and not offered on batches or `update`.
- Limits: key ≤1 KB; value ≤ ~399 KiB JSON; path depth 31; per method 400 ops/10 s; `list` 240/min paid, 120 free; 30 in flight per method.
- Replication: reads are eventually consistent. KV is replicated between regions asynchronously with last-writer-wins **per item**. `incr`/`add` are atomic only within one region, so two writers in different regions can get the same counter value or lose an append.
- A worker's `me.puter` calls share one rate bucket for every caller of that worker.

### KV shares

Shipped in `heyputer/packages/puter` 589a98b12 (October 2026), documented at docs.puter.com `KV/share`, `KV/unshare`, `KV/listShared`, `KV/listSharedByMe`, `Events/subjects` and `rate-limits-and-quotas`. Code: `BE/services/kvShare/`, `BE/controllers/kvShare/KvShareController.ts`, `BE/drivers/kv/KVStoreDriver.ts`, `SDK/modules/kv/{share,unshare,listShared,listSharedByMe}.js`. `dev/fake-puter/shares.js` models it, errors included.

**Sharing**
- `puter.kv.share(prefix, recipient, access?)` or `share({prefix, recipient, access, label, appUuid})`, served at `POST /kv/shares` (`/events/kv-handles` stays as an alias that defaults to `watch`). `access` defaults to `read`. `recipient` is a username, `{username}` or `{uid}`; one containing `@` is refused in the SDK with `invalid_recipient`.
- Resolves `{handle, prefix, access, appUid, holder, label, createdAt}`. `holder` is the holder's **username**, never the uuid. `createdAt` is in Unix seconds. Handles look like `kvh-<uuid>`.
- The same prefix to the same holder in the same app changes that share in place: same `handle` and `createdAt`, new `access`; an omitted `label` keeps the label and `null` clears it. A change sends no notice.
- **Prefix**: `:`-separated segments of `[a-z0-9_.-]`, no empty segment, never the whole namespace, the trailing `:` optional. The grant string `kv-share[-read|-write]:<ownerUuid>:<appUid>:<segments>` must fit 255 characters (for an `app-<uuid>` app: 168 characters at `watch`, 163 at `read`, 162 at `write`). A new share whose prefix differs from a live one to the same holder only in case is refused. Trips prefixes fit: `shared:<id>:` and `shared:inv:<hex>:` with lowercase base32 and hex ids, `shared:<id>:u:<uuid>:` with Puter's lowercase uuids, and `vacay:`.
- **Consent**: an app shares only its own data, and only with `puter.perms.request('kvShare', {prefix, access})` granted (the deprecated permission-string form `manage:kv-share-<level>:<owner>:<appUid>:<prefix>` is the same grant). It covers that prefix and deeper ones at that level and below. A worker created from the app session runs `me.puter` as that app, so it needs the owner's consent too; `user.puter` acts as the calling user in the calling app. Without it: `events_kv_handle_not_delegated`. The owner revoking also needs it; a holder giving a share up never does.
- **Label**: trimmed; at most 128 characters and 512 UTF-8 bytes; no control, format (zero-width, bidi) or line-separator characters; at most 3 combining marks on one character; empty means none. Trips cleans labels with `src/shared/share-label.js`.
- **Notice**: a new share of an app's data sends the holder `kv.share.received` on `notif:<appUid>:app-user`, notification `{type, handle, access, label, createdAt}`. At most 5 an hour per owner and holder (later shares are still made, silently). The Puter desktop never shows it, and it needs notifications enabled for events on the deployment, so `listShared()` on open stays the source of truth.
- **Who**: sharing needs a confirmed email where the deployment requires one (`account_is_not_verified`), no phone, card or paid plan. Temporary accounts get `events_kv_handle_requires_account`. A holder who blocked the owner or refuses all shares gets `recipient_not_accepting_shares`; an existing share can still be lowered, cleared or stopped.

**Listing and stopping**
- `listShared({limit, cursor, includeTotal})` (holder): live shares in this app, oldest first, `{items: [{handle, access, appUid, label, createdAt}], cursor?, total?}`. Never the owner or prefix. `limit` defaults to 50 and is capped at 200; `cursor` only when more pages exist; `total` only with `includeTotal`. Never gated on a feature flag.
- `listSharedByMe(...)` (owner): adds `prefix`, `holder` (current username), `revokedAt` and `revokedBy` (`owner`, `holder`, `system` when the app was deleted), stopped shares included. A deleted holder's shares leave the listing.
- `unshare(handle)` from either side resolves `{handle, revokedAt}`, and again the same for a share already stopped. Unknown or someone else's: `subject_does_not_exist` (404). The owner revoking also retires every narrower live share to the same holder inside the prefix; the holder giving up a share also retires the narrower ones they hold from the same owner. Not gated on any flag.

**Using a handle**
- Every `puter.kv` method takes `optConfig.handle` (`kv.get(key, {handle})`, `kv.list({pattern, optConfig: {handle}})`, `kv.set(key, v, {handle})`). Never from a shorthand object. Keys, patterns and list results are relative to the prefix; a key or pattern is at most 768 bytes. List cursors are sealed to the handle and direction, so treat them as opaque.
- `read` allows `get` and `list`; `write` adds every mutation, deletes and TTLs included; `flush` never. The owner may use their own handle. A handle is bound to its holder and app, never a bearer token.
- Private (`disableSharing`) entries are absent from reads, lists and totals; a write to one through a handle is `forbidden` (an `onlyIfAbsent` write resolves `false`).
- Each user pays for and is rate-limited on their own calls through a handle.
- Revocation is immediate, except that calls through a stopped handle can work for up to 60 s while a wider share of the same holder still covers the keys.

**Events**
- `kv:<handle>:<key>` (exact) or `kv:<handle>:<prefix>*`; every level, `watch` included, may subscribe. Keys and subjects in deliveries are relative. No key after the handle, or a `..` segment: `invalid_kv_handle_key`. Unknown, stopped or foreign: `subject_does_not_exist`. `watch` shares off: `events_kv_handles_disabled`.
- `self` is true when the subscriber's account made the change, through a handle too. `viaWorker` is true for writes from a worker session (`me.puter`) or an events handler; a worker's `user.puter` writes as that user. `self && !viaWorker` skips one's own client writes.
- A stopped share ends deliveries; persistent subscriptions on it are suspended with `permission_revoked`.

**Errors**

| Code | When |
| --- | --- |
| `kv_handle_not_found` (404) | handle unknown, stopped, foreign, owner gone or app gone (one body for all) |
| `kv_handle_access_denied` (403) | the holder's level is too low (only told to the holder) |
| `kv_handle_option_invalid` (400) | `handle` with `appUuid` or `disableSharing`, `flush` through a handle, or a non-string handle |
| `kv_handle_key_invalid` (400) | empty key, or key or pattern over 768 bytes |
| `kv_handles_disabled` (403) | `read`/`write` shares or handle calls are off (`kv.shareHandles`) |
| `events_kv_handles_disabled`, `events_disabled` | `watch` shares or events are off |
| `kv_share_access_invalid` (400) | `access` is not `watch`, `read` or `write` |
| `invalid_kv_share_prefix` (400) | prefix shape, length or case variant |
| `kv_share_label_invalid` (400) | label rules above |
| `invalid_recipient` (400) | `@` in the recipient, or not a username, `{username}` or `{uid}` |
| `subject_does_not_exist` (404) | no such user on share; no such handle (or not yours) on unshare or subscribe |
| `bad_request` (400) | sharing with yourself; bad `appUuid`; bad listing `limit` |
| `recipient_not_accepting_shares` (403) | blocks, as above |
| `events_kv_handle_not_delegated` (403) | no `kvShare` consent for that prefix and level |
| `events_kv_handle_outside_namespace` (403) | an app named another app's data |
| `events_kv_handle_limit_reached` (409) | live-share cap |
| `events_kv_handle_owner_only`, `forbidden` | access-token callers |
| `too_many_requests` (429) | share/unshare or listing budget |

**Limits**: live shares an account holds out: 200 across apps and 128 per app on free plans, 512 and 512 paid; mint and revoke together 60/min per user; share listings 120/min per user and app; pages of at most 200.

### Differences from the pre-release design

Trips was built against a pre-release design (this file before October 25, `dev/fake-puter` before `shares.js`). What shipped differs as follows; every row is handled in code.

| Area | Pre-release design | Shipped | Trips change |
| --- | --- | --- | --- |
| Methods, routes | `share`, `listShared`, `listSharedByMe`, `unshare` | Same names, served at `/kv/shares` | None |
| `share` arguments | Positional or `{prefix, recipient: {uid}\|username, access, appUuid, label}` | Same, plus `{username}`; trailing `:` optional | None |
| `share` result | `{handle, prefix, access, appUid, holder, createdAt}`, `holder` a uuid | Adds `label`; `holder` is a **username**; times in Unix seconds | Named invites store `holder` (username) and prove a renamed holder by re-sharing to the caller's uuid; Vacay grants keep `holder` and learn `uid` from acks; maintenance matches read handles by recorded id or member name |
| Prefix rules | Any key, at most 256 bytes for `read`/`write` | Lowercase `[a-z0-9_.-]` segments, 255-character grant string, no case variants | None needed (all Trips prefixes fit) |
| Levels | `watch < read < write` | Same | None |
| Consent | `perms.request('permission', {permission: 'manage:kv-share-write:…:shared'})` | `perms.request('kvShare', {prefix, access})`; required for app and app-bound worker mints and owner revokes | `ensureShareConsent` asks `kvShare` (`shared:` write); Vacay asks `vacay:` read before sharing; mints back off 10 min on `events_kv_handle_not_delegated` |
| Handle option | `optConfig.handle`, keys relative, holder pays | Same; 768-byte keys and patterns; owner may use the handle | None |
| Handle list cursors | Relative keys | Sealed to the handle and direction | None (passed through) |
| `listShared` / `listSharedByMe` | `{items, cursor, total}`, page size free | `cursor` and `total` only when present or asked; default 50, cap 200 | Page size 200 |
| `unshare` | Resolves `true`; stopped or unknown → `kv_handle_not_found` | `{handle, revokedAt}`; idempotent; unknown → `subject_does_not_exist`; cascades to narrower shares | Revoking a member's read handle also retires the write handle, so renewal re-mints both; `gone` checks use `subject_does_not_exist` |
| Share errors | `kv_share_access_invalid` for a long prefix, `invalid_recipient` for yourself, `bad_request` for labels, `user_not_found`, `kv_handle_limit` | `invalid_kv_share_prefix`, `bad_request` for yourself, `kv_share_label_invalid`, `subject_does_not_exist`, `events_kv_handle_limit_reached` (409), plus `recipient_not_accepting_shares`, `events_kv_handle_not_delegated`, `account_is_not_verified`, `too_many_requests` | Worker maps them to `user_not_found`, `invalid_username`, `recipient_refused`, `share_consent_required`, `share_limit`, `rate_limited`; Vacay to `noUser`, `refused`, `consent`, `limit`, `rate` |
| Watch-level flag | `kv_handles_disabled` for all | `events_kv_handles_disabled` / `events_disabled` for `watch` | None (Trips mints `read` and `write`) |
| Private entry write through a handle | `kv_handle_access_denied` | `forbidden` | None (no private keys under `shared:`) |
| Listing with sharing off | `kv_handles_disabled` | Works; only share and handle calls fail | Vacay learns sharing is off from the first invite, not from discovery |
| Labels | Owner-set, at most 256 bytes | Trimmed, 128 characters, 512 bytes, character rules | `shareLabel()` cleans worker and Vacay labels |
| Notification | "Puter notifies the holder" (fake: `kv_share`) | `kv.share.received` in the app's `notif:app-user` only, 5/hour per pair, not shown by the desktop | Invites and Vacay listen for `kv.share.received`; copy no longer promises a Puter notification |
| Events | `kv:<handle>:<key>`, `self`, `byWorker` | Same subjects; `viaWorker` on kv and fs events; refusals `subject_does_not_exist`, `invalid_kv_handle_key`, `events_kv_handles_disabled` | None (the notify handler already reads `viaWorker`) |
| Conditional put | Maybe; fake had a global claim and `feature_disabled`; Trips passed `onlyIfAbsent` at the top of the object form | `set(key, value, expireAt?, {onlyIfAbsent: true})` only: the object-form flag is ignored; `false` when a live entry exists; checked per region; not on batches (`invalid_request`) or `update` | `setIfAbsent` uses `optConfig` (the old call silently wrote unconditionally); the `feature_disabled` fallback is gone |
| Worker-write marking | `byWorker` | `viaWorker` | None |
| Limits | "Caps that fit" | 200 live shares per free account, 128 per app; 512 paid; 60 mints and revokes a minute | Each member holds 2, and pending named invites and the owner's Vacay shares count in the same app: a free owner fits at most 64 members across all trips before the rest fall back to path C; mints back off on `events_kv_handle_limit_reached` |
| Billing | Holder pays own calls | Same; sharing needs no phone, card or paid plan | None |
| Blocks, temporary accounts | Not modelled | `recipient_not_accepting_shares`, `events_kv_handle_requires_account` | Mapped as above |

**Consistency with the per-region conditional put.** The rev claim (`incr` then `ch:<rev>:0` with `onlyIfAbsent`) catches a rev that another region already wrote and that has replicated here, so a lagging counter cannot overwrite an older record. It does not stop two regions from claiming the same rev inside the replication window: both writes succeed and the later record wins everywhere. The entities themselves are separate keys and stay right; only that change record is lost. Path A clients see no gap, so they pick the change up when the owner's next snapshot rebuild compares records against the scan and re-announces it under a fresh version (architecture §8); path C clients get the same re-announcement through `sync`. This only happens when commits reach the same trip through worker isolates in different Puter regions within the replication window.

## Filesystem

- Content in object storage, metadata in SQL, a 60 s metadata cache with invalidation. No versions, no conditional writes (last writer wins), `delete` is a hard delete.
- Relative paths resolve to `~/AppData/<appUid>/`. An app reaches its own AppData, anything the user granted (pickers, `perms.request`), and **another user's same-app AppData once that user shared it** (`BE/services/acl/ACLService.ts` shared-appdata rule).
- Rate limits per minute (paid/free): read 600/300, write 300/120, stat 1200/600, readdir 600/300, mutations 1200/900.
- `getReadURL(path, ttl)`: revocable, re-checked on use, 20/hour/user. `sign(appUid, items)`: never expires, cannot be revoked (delete the file to kill it).

### Sharing

- `puter.fs.share(path, usernameOrEmail, mode)`, modes `see < list < read < write < manage`. No acceptance step. Unknown emails become pending invites and Puter emails them for free; recipients get a Puter notification.
- An app may share its own AppData without a prompt (not `manage`, not "anyone with link"). **verify** that a worker's `me.puter` can call it.
- Gates: the sharing account needs a verified phone or card (paid plans count). 200 new shares/day, 60/min, 10 recipients × 50 items per call.
- `write` on a folder lets the recipient overwrite, rename and hard-delete children.
- `listShared()` from an app returns items that app can reach (same-app AppData qualifies).

## Workers

- Service-worker syntax isolate runtime. Bindings: `me` (deployer's puter.js client) and `router` only; no env secrets, no cron, no durable objects. Request/response plus streaming; WebSockets untested.
- Router: `get/post/put/delete/options`, `custom(method)`. Handler gets `{request, params, user}`; call `event.waitUntil(p)` for post-response work. Params are not URL-decoded. Thrown errors become 500 with the error text, so wrap every handler. 404s have no CORS header. Never serve HTML (the dispatcher injects a script and forces 200).
- Module globals persist per isolate, but isolates are per location and incoherent with each other, and every redeploy resets them. **Never await a promise that another request will resolve**: the runtime cancels the waiter as hung.
- Deploy: requires a verified email. `puter.workers.create(name, path)` from the app session binds the worker to the app (same KV/AppData namespace as the owner's own app). Names are global, first come first served. Overwriting the source file redeploys; deleting it destroys the worker. Idle 30 days → evicted; the next request waits ≥5 s.
- The only non-HTTP trigger is the events worker: published handlers run on fs/kv/notif changes as the subscriber (15-minute token, subscriber pays, 30 s timeout, needs `events:background` consent).

## Events

- `puter.events.onLocal(subject, cb, opts)`; subjects `fs:`, `kv:`, `notif:` only; **no custom publish**. ~0.3 s same region, 250 ms coalescing, no replay (a `gap` marker on reconnect).
- Cross-user: `fs:` on anything the subscriber can list (a folder shared with them), and `kv:<handle>:…` (KV shares above).
- Every event carries `self` and `viaWorker` (written by a worker session or an events handler).
- Cross-region delivery for session subscriptions depends on `events.forwardSession` (**verify**).
- Limits: 50 subscriptions per socket, 600 deliveries/min per subscription.

## AI

- `puter.ai.chat(messages, {model, stream, tools, outputFormat, max_tokens})`. Use `outputFormat: {type:'json_schema', schema}` for structured output (`response_format` is dropped). Tools are returned to the app to run. `{type:'web_search'}` server tool on OpenAI and Claude models.
- **PDFs and documents work only with Claude models**, as content parts `{type:'file', puter_path}` (≤30 MB). Other providers replace a PDF with an error text.
- `img2txt` (single page fast OCR, or multi-page with the Mistral provider), `txt2speech`, `speech2txt`, `txt2img`.
- A trailing `true` argument is free test mode; use it in automated tests.
- Limits per (user, app): 30 requests/10 s and 3 concurrent on free plans.

## Email

- Every account has `<username>@puter.email`, stored under `~/.mail`. Read with `puter.email.list/get` after `puter.perms.request({permission:'fs:/<username>/.mail:read'})`. Background ingest pattern: `src/calendar/src/js/mailbox.js`.
- `puter.email.sendTransactional` must be authorized by a worker and the payer must be on a paid plan. Free invitations: `fs.share` by email.

## UI and networking

- Pickers (`showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`) work standalone (popup) and grant the app persistent access to the picked item.
- Desktop-only calls (`launchApp`, window APIs, `getLanguage`, `socialShare`) never resolve standalone. Guard with `puter.env === 'app'`; use `navigator.share`/clipboard instead of `socialShare`.
- No dark-mode signal from Puter; use `prefers-color-scheme` plus an in-app control.
- Deep links: `https://puter.com/app/trips?x=1` passes non-`puter.*` params into the app; standalone URLs work as is. Use hash routes.
- `puter.net.fetch(url, init)`: CORS-free HTTP/1.1 from the browser, no redirects or abort. Use only for user-owned servers (Immich, AirTrail, Dawarich) or sources with no CORS.
- `puter.hosting.create(subdomain, dir)`: static hosting on `*.puter.site`, Range requests supported, SPA 404 fallback via `.puter_site_config`.
