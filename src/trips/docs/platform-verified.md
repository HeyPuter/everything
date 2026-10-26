# F0 platform verification

**Status: pending live verification.** Prepared on 2026-10-24. No live accounts, SDK/browser connection, deployment or live observation was available. The fake-runtime results below validate the harness only; they do not verify platform behavior. F0 is not complete.

Development proceeds offline against `dev/fake-puter`, which implements the APIs these checks assume. All ten checks gate the v1 beta gate. Check 1 gates `config.json` `pathA` (path A, Q8); checks 2–3 gate `directFiles`. A failed check means updating architecture.md and the fake runtime, then listing the affected tasks in status.md.

Harness and cleanup instructions: [dev/spike/README.md](../dev/spike/README.md).

## Live checklist

All rows remain pending, including those with prepared probes. Record UTC execution time, build/commit, account roles A/B, redacted evidence path and cleanup outcome when a real run occurs. Do not publish identities, tokens, handles, keys, private content or billing account details.

| # | Live state | Preparation | Evidence still required |
| --- | --- | --- | --- |
| 1 | Pending; API shipped 2026-10-25 | Manual two-account procedure below against the shipped API; browser conditional-put probe in the harness | `kvShare` consent and worker mint, notices, holder reads/writes/events with `viaWorker`, fresh polled reads, revocation cascade, payer and free-account gates, labels, per-region conditional put, Trips end to end |
| 2 | Pending | Manual two-account procedure | Same-app worker FS share/read/write/unshare using free and verified owners |
| 3 | Pending | Manual two-account procedure | Recipient discovery, uid access and FS events with revocation |
| 4 | Pending | Restricted proof session + owner-only `/probe` auth; fake positive/negative tests | Current SDK getReadURL token validated by worker-side `user.puter.fs.stat/read`, signature/owner checks and denial cases |
| 5 | Pending | Explicit KV runner in browser and spike worker; exact-key cleanup | Live batch, missing-item update/path behavior, incr/add returns, both list forms, expiry and approximate value cap; propagation implications |
| 6 | Pending | Bounded 5,000-record synthetic gzip stream | Live CompressionStream/stream transport, actual 5,000-entity KV snapshot rebuild and worker CPU time |
| 7 | Pending | Manual account-role usage comparison | Signed-in reader versus anonymous signed-URL payer and deltas |
| 8 | Pending | Manual synthetic mail + events procedure | Explicit `.mail:read` consent, list/get and background handler delivery |
| 9 | Pending | Manual synthetic-PDF procedure | Claude PDF `puter_path`, schema output and model availability |
| 10 | Pending | Anonymous-header `/health` client probe | Auth omission on the real SDK, live response latency and genuine evicted-worker wake time |

### 1. KV shares (shipped API)

The API shipped on 2026-10-25 (heyputer `packages/puter` 589a98b12; docs.puter.com `KV/share`). platform.md, KV shares, lists what Trips relies on and how it differs from the design Trips was built against. Run this with two dedicated accounts in the registered Trips app: A owns (a free plan with no phone or card), B holds. Use a fresh lowercase run id `<run>` and only synthetic data. `<app>` is the Trips app uid, `<b>` B's uuid.

- [ ] **Consent.** In A's Trips tab: `await puter.perms.request('kvShare', { prefix: 'shared:', access: 'write' })` shows one prompt and resolves `true`; a second call resolves `true` without a prompt. (Trips asks the same thing in the invite dialog.)
- [ ] **Mint from the worker.** From A's app-bound worker (`me.puter`, the worker Trips deploys), share `shared:f0<run>:` with `{ uid: '<b>' }` at `read`, and `shared:f0<run>:u:<b>:` at `write`. Each resolves `{handle: 'kvh-…', prefix, access, appUid: '<app>', holder: '<B username>', label: null, createdAt: <Unix seconds>}`. A prefix the consent does not cover (`other:<run>:`) fails with `events_kv_handle_not_delegated`, which confirms the worker acts as the app. Sharing the same prefix again returns the same handle.
- [ ] **Notice.** B's Trips tab subscribed to `notif:<app>:app-user` gets one `kv.share.received` per new share, carrying `{handle, access, label, createdAt}` and nothing about A. A re-share sends none. Note whether the Puter desktop shows anything (it should not).
- [ ] **Holder calls.** In B's tab: `listShared({ includeTotal: true })` lists both shares without prefix or owner. Through the read handle: a batched `kv.get(['sig', 'nope'], { handle })`, then `kv.list({ pattern: 'e:*', returnValues: true, reverse: true, limit: 2, optConfig: { handle } })` and its next page by `cursor`. Through the write handle: `kv.set('pres', {at: 1}, { handle })`. Refusals: `kv.set('x', 1, { handle: read })` → `kv_handle_access_denied`; a 769-byte key → `kv_handle_key_invalid`; `kv.flush({ handle })` → `kv_handle_option_invalid`; the read handle used from another app → `kv_handle_not_found`.
- [ ] **Fresh reads.** Right after A's worker writes `shared:f0<run>:sig`, B's `kv.get('sig', { handle })` returns the new value (path A polls this key).
- [ ] **Events.** B: `puter.events.onLocal('kv:<read handle>:sig', cb, { includeValue: true })`. A's worker writes `sig`: B receives `{key: 'sig', value, self: false, viaWorker: true}`; A's tab subscribed to `kv:<app>:shared:f0<run>:sig` receives `self: true, viaWorker: true`. B's own write through the write handle reaches B with `self: true, viaWorker: false`. Repeat with B's tab and A's worker request in two regions (cross-region session delivery, `events.forwardSession`).
- [ ] **Private entries.** A writes `shared:f0<run>:p` with `{ disableSharing: true }`: B's `get` returns `null`, `list` and `total` leave it out, and a write to it through the write handle fails with `forbidden`.
- [ ] **Revoke.** A's worker unshares the read handle: it resolves `{handle, revokedAt}`, and again the same on a second call. B's next `get` fails with `kv_handle_not_found` at once, the write handle stopped with it, and B's subscription stops delivering. `listSharedByMe()` shows both with `revokedBy: 'owner'`. Mint a fresh share and have B `unshare` it: `revokedBy: 'holder'`.
- [ ] **Billing and gates.** Compare role-based usage before and after B's handle reads: B pays, A does not. A shares with no phone or card. Do not exhaust the live-share cap (128 per app on a free plan); `events_kv_handle_limit_reached` is documented.
- [ ] **Conditional put.** `kv.set('f0<run>:claim', 1, { onlyIfAbsent: true })` resolves `true`, again `false`. From two regions at nearly the same time on a new key: record whether both resolve `true` (the docs say they can) and which value survives.
- [ ] **Labels.** A share labelled with a zero-width joiner (for example a family emoji) fails with `kv_share_label_invalid`; Trips' cleaned label (`src/shared/share-label.js`) is accepted.
- [ ] **Trips end to end** on a build with `config.json` `pathA: true`: B joins A's trip by link (two handles, two notices), syncs on path A with events, and after A unshares B's read handle falls back to path C and returns to path A with two new handle ids. A named invite by username arrives in B's Invitations, and still joins after B renames.

When every row passes, set `pathA: true` in `public/config.json`. `directFiles` waits on checks 2–3, which KV shares do not change.

### 2–3. Shared files

- [ ] Use two dedicated accounts in the same registered app. A creates only a fresh synthetic folder/file. A's spike worker explicitly grants B read, then write; test free/unverified and verified owners separately. Keep recipient identities only in memory.
- [ ] B finds the folder through `listShared()`, accesses it by uid, reads the fixture and writes a second synthetic fixture only after write access. Observe an `fs:` event in B's app. Record booleans/statuses, not file ids/paths or real file contents.
- [ ] A unshares; B must lose access. Remove the exact synthetic folder after all in-flight work settles. Test the proxied-file fallback design separately if sharing is verification-gated.

### 4–6. Restricted auth, KV and snapshots

- [ ] Follow the explicit session/deploy steps in the harness README. Verify anonymous health, valid owner restricted proof, rejection of the owner's real session and rejection of a different account. Never forward a session token to an owner-controlled worker.
- [ ] Run KV semantics with a fresh run id; separately enable TTL/size/conditional options. Keep automatic exact-key cleanup results. Repeat the default semantics suite through the spike worker to observe the actual worker SDK's `me.puter` surface.
- [ ] Observe the synthetic gzip response on the live runtime. Separately measure real snapshot full-scan + serialization/compression for 5,000 synthetic entities and obtain CPU measurements from the platform. The harness performs no 5,000-write fixture seeding and its timings do not satisfy this requirement.

### 7. Signed URL billing

- [ ] Explicitly create a small synthetic file in A's isolated test folder and mint a signed URL. Measure redacted usage before/after one signed-in B read and one anonymous read, separated enough to attribute deltas. Never export the signed URL or use a private file. Delete the file to invalidate the permanent signed URL; delete the folder.

### 8. Mail

- [ ] Obtain `.mail:read` through an explicit user action in a dedicated mailbox containing synthetic mail only. Check `puter.email.list/get`; collect only result shape/count/status.
- [ ] Separately authorize/install a temporary events worker for `fs:~/.mail/objects/**:add`, send a synthetic fixture and confirm one delivery. Do not read/export real mailbox data. Remove the handler/subscription and test fixture. This harness installs no background handlers and sends no email.

### 9. AI PDF

- [ ] Explicitly upload a small synthetic PDF into the test user's isolated AppData. Call the currently available Claude model with `puter_path` and `outputFormat:{type:'json_schema',schema}`. Use AI test mode first; record only model availability, response/schema validation and error status. Do not attach output containing private documents. Remove the PDF and any temporary copies. The harness makes no AI calls.

### 10. Health and eviction

- [ ] Use the prepared health probe while signed in; verify the real worker reports no auth header. Record first and subsequent request latency with the same run/build.
- [ ] Confirm a genuine platform eviction through platform-supported evidence, then measure wake time separately. A fresh deployment or a cold isolate is not proof of the documented 30-day eviction behavior. No eviction/deployment automation is provided.

## Local harness evidence

`tests/unit/spike.test.js` exercises the probes, cleanup and evidence redaction against the fake runtime only. No local result changes a live checkbox.
