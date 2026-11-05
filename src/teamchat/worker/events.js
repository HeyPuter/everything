/**
 * The handle side of events signalling: who this worker's own token belongs
 * to, minting a member's watch handle on the workspace's signal region, and
 * the bootstrap block that tells a client how to subscribe (see
 * docs/systemDesignDocs/teamchatEventsSignaling.md, sections 3.5 and 3.6).
 * Everything here is defensive by design: a worker whose token carries no
 * app uid, a platform with the feature off, or a mint that fails must all
 * come back to exactly today's behaviour, never an error a caller sees.
 */
import { KEYS } from '../src/shared/blocks.js';
import { EV_SHARDS, evShard, evRegion, appUidFromToken } from '../src/shared/events.js';
import { kv, serverConfig, setServerConfig } from './lib.js';

/** How long a share or an unshare is given to answer before it is treated as unreachable. */
const HANDLE_TIMEOUT_MS = 3000;

/**
 * How many handles one request will take back. Mints and revokes share one
 * 60/min budget on the owner's account, and each is an HTTP round trip
 * inside a request the platform time-limits, so a fan-out with many leavers
 * (a workspace deletion, a connection ending) only ever takes a slice of them.
 */
export const REVOKE_BATCH_MAX = 20;

/**
 * This worker's own app uid, decoded from its own auth token. Null for a
 * user-scoped worker (no app claim at all — see the design doc, section
 * 2.5) or a token that will not parse; either way, events are unavailable
 * and every caller here treats null as "nothing to offer".
 */
export function workerAppUid() {
  try {
    return appUidFromToken(me?.puter?.authToken);
  } catch {
    return null;
  }
}

/**
 * The app uid the caller's own token carries, or null when it cannot be read
 * (no token forwarded, one that will not parse, a session with no app claim).
 */
export function callerAppUid(user) {
  try {
    return appUidFromToken(user?.puter?.authToken);
  } catch {
    return null;
  }
}

/**
 * Backoff windows for a mint failure (design doc, section 3.6), grouped by
 * whose problem the refusal is. All five below are worker-wide, not any one
 * member's, but they no longer share one wait: events_disabled and
 * events_kv_handles_disabled describe the platform region, and
 * events_kv_handle_owner_only and events_kv_handle_outside_namespace
 * describe this worker's own token and the prefix it mints against — none
 * of the four can change without a redeploy, and a redeploy makes a new
 * worker anyway, so six hours costs nothing real. Consent
 * (events_kv_handle_not_delegated) is different: it is the one code a
 * person can flip from outside the app entirely, at any moment, with
 * nothing telling the worker — granted from the Puter GUI, another device,
 * or a session long since closed, none of which touches this worker's
 * cached verdict. An owner's own tab open at the time heals that at once
 * (see shell.js's healEventsVerdict); this thirty minutes covers the owner
 * who granted it and closed the tab. The cost of the shorter window is one
 * refused mint per half hour per worker — a rounding error against a
 * 60-a-minute budget — against a workspace that used to stay dark for six
 * hours over a grant that had already been made.
 * events_kv_handle_limit_reached is the owner's live-handle cap, worker-wide
 * too, but shorter still: a slot can free up on its own as members leave.
 * A 429 is this member alone outrunning the mint budget; a temp account
 * behind events_kv_handle_requires_account cannot be granted a handle at
 * all, which is that one member's problem, not the worker's — refusing
 * every other member for hours over it would be wrong, so it gets the same
 * long wait but member-scoped (they can sign up, so it is not for ever, but
 * retrying it every ten minutes buys nothing). Anything else (a network
 * failure, a timeout, an answer with no handle) gets the same short,
 * member-scoped backoff a transient failure deserves.
 *
 * Puter's KV shares added three more. account_is_not_verified is the
 * owner's unconfirmed email, worker-wide until they confirm it.
 * recipient_not_accepting_shares is one member who blocked the owner or
 * takes no shares at all, and invalid_kv_share_prefix one workspace whose
 * region a new share can no longer name; both are member-scoped and long.
 */
const WORKER_BACKOFF_MS = {
  events_disabled: 6 * 3600_000,
  events_kv_handles_disabled: 6 * 3600_000,
  events_kv_handle_not_delegated: 30 * 60_000,
  events_kv_handle_owner_only: 6 * 3600_000,
  events_kv_handle_outside_namespace: 6 * 3600_000,
  events_kv_handle_limit_reached: 3600_000,
  account_is_not_verified: 3600_000,
};
const MEMBER_BACKOFF_MS = {
  too_many_requests: 2 * 60_000,
  events_kv_handle_requires_account: 6 * 3600_000,
  recipient_not_accepting_shares: 6 * 3600_000,
  invalid_kv_share_prefix: 6 * 3600_000,
};
const DEFAULT_MEMBER_BACKOFF_MS = 10 * 60_000;

/**
 * Run a share call with HANDLE_TIMEOUT_MS to answer; never throws. A refusal
 * comes back as { ok: false, code, why }, which the caller turns into a
 * backoff rather than a failed request of its own.
 */
async function shareCall(run, failed) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'timeout' })), HANDLE_TIMEOUT_MS);
  });
  try {
    return { ok: true, value: await Promise.race([run(), timeout]) };
  } catch (e) {
    return { ok: false, code: (e && typeof e.code === 'string' && e.code) || 'network', why: (e && e.message) || failed };
  } finally {
    clearTimeout(timer);
  }
}

/** A workspace name as a share label: what Puter refuses in one taken out, and cut well inside its 128 characters and 512 bytes. */
export function shareLabel(name) {
  const clean = String(name || '').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').replace(/(\p{M}{3})\p{M}+/gu, '$1').trim();
  return Array.from(clean).slice(0, 120).join('').trim() || null;
}

/**
 * Share this workspace's signal region with one member, watch only, as the
 * owner's app (puter.kv.share; the owner's `kvShare` consent covers it).
 * The member is shown the workspace's name as the share's label.
 */
export async function mintHandle(wsId, granteeUuid, name = null) {
  if (!workerAppUid()) return { ok: false, code: 'no_app_uid', why: 'This worker is not running as an app' };
  const label = shareLabel(name);
  const res = await shareCall(
    () => me.puter.kv.share({ prefix: evRegion(wsId), recipient: { uid: granteeUuid }, access: 'watch', notify: true, ...(label ? { label } : {}) }),
    'The share could not be made',
  );
  if (!res.ok) return res;
  const handle = res.value?.handle;
  if (typeof handle !== 'string' || !handle) return { ok: false, code: 'invalid_response', why: 'The share answered with no handle' };
  return { ok: true, handle };
}

/**
 * Stop one member's share (puter.kv.unshare). Never throws. Stopping a share
 * that already stopped answers ok, and so does an unknown handle
 * (`subject_does_not_exist`): either way there is nothing left to take back.
 */
export async function revokeHandle(handle) {
  if (!workerAppUid()) return { ok: false, code: 'no_app_uid', why: 'This worker is not running as an app' };
  const res = await shareCall(() => me.puter.kv.unshare(handle), 'The share could not be stopped');
  if (res.ok || res.code === 'subject_does_not_exist') return { ok: true };
  return res;
}

/**
 * Give back one member's cached handle when their membership ends, so the
 * slot it held on the owner's live-handle cap counts only while they are
 * actually still here. `doc` is the member document a caller already has in
 * hand; without one this reads it itself, but only once workerAppUid() has
 * confirmed there is anything to release, so a user-scoped worker makes
 * neither that read nor a fetch. Never mints, never throws, and a failed
 * revoke is simply left standing for the owner to clear by hand.
 */
export async function releaseHandle(wsId, uuid, doc = null) {
  if (!workerAppUid()) return { revoked: false };
  const memberDoc = doc == null ? await kv().get(KEYS.member(wsId, uuid)).catch(() => null) : doc;
  const h = memberDoc?.ev?.h;
  if (!h) return { revoked: false };
  const res = await revokeHandle(h);
  return { revoked: !!res.ok };
}

/**
 * Mint a handle for one member, or hand back the one already cached on their
 * member document. Older shares are upgraded to notify once. A failure
 * is remembered with the backoff table above and never retried before its
 * window, worker-wide for a platform or consent problem, member-wide for
 * anything else.
 */
export async function ensureHandle(wsId, uuid, doc, name) {
  if (doc?.ev?.h && doc.ev.notify) return doc.ev.h;
  const at = Date.now();
  if (doc?.ev?.until && doc.ev.until > at) return null;
  const cfg = await serverConfig();
  if (cfg.ev && cfg.ev.until > at) return null;
  const res = await mintHandle(wsId, uuid, name);
  if (res.ok) {
    await kv().update(KEYS.member(wsId, uuid), { ev: { h: res.handle, notify: true } }).catch(() => {});
    // Any successful mint proves the platform and the owner's consent both
    // stand, worth recording even when nothing was cached as bad before (the
    // very first mint a workspace ever makes, say), so GET /api/server has a
    // positive answer to give without waiting for a member to ask again.
    if (!cfg.ev?.ok) await setServerConfig({ ev: { ok: true, appUid: workerAppUid(), why: null, until: 0 } }).catch(() => {});
    return res.handle;
  }
  const workerMs = WORKER_BACKOFF_MS[res.code];
  if (workerMs) {
    await setServerConfig({ ev: { ok: false, appUid: workerAppUid(), why: res.code, until: at + workerMs } }).catch(() => {});
  } else {
    const memberMs = MEMBER_BACKOFF_MS[res.code] || DEFAULT_MEMBER_BACKOFF_MS;
    await kv().update(KEYS.member(wsId, uuid), { 'ev.until': at + memberMs, 'ev.why': res.code }).catch(() => {});
  }
  return null;
}

/**
 * The bootstrap's `events` block (design doc, section 3.5): `own` mode for
 * the worker's own owner, who needs no handle, no consent, and no
 * `events.kvHandles` flag, since their browser and their worker share the
 * same app-scoped namespace; `handle` mode for everyone else, whose handle
 * is minted lazily and cached on their own member document. Null when
 * nothing is available yet, so an old client sees no such key and an old
 * worker's bootstrap has none to begin with — both read the same as today.
 */
export async function eventsBlock(ws, uuid, doc = null, user = null) {
  const appUid = workerAppUid();
  if (!appUid) return null;
  // A handle is bound to the app whose namespace it shares, so a browser
  // running as another app is refused it whatever it does, while the handle
  // still holds one of the owner's live slots until something gives it back
  // (see releaseHandle). A token that cannot be read says nothing either
  // way, so it is not gated.
  const caller = callerAppUid(user);
  if (caller && caller !== appUid) return null;
  const shard = evShard(uuid);
  // `own` mode targets the KV namespace of the account this worker runs in
  // (serverConfig().owner), not whoever created this particular workspace:
  // on a shared worker (tc:config.open) those can differ, and a workspace
  // creator who is not the worker's own account would be handed a subject
  // pointing at their own empty namespace — a subscription that never
  // fires, retried forever, and no handle either (see the design doc,
  // section 3.4, and the caveat about shared workers).
  const cfg = await serverConfig();
  if (cfg.owner === uuid) {
    return { mode: 'own', appUid, key: KEYS.evShard(ws.id, shard), shards: EV_SHARDS, shard };
  }
  const memberDoc = doc || (await kv().get(KEYS.member(ws.id, uuid)).catch(() => null)) || {};
  const handle = (await ensureHandle(ws.id, uuid, memberDoc, ws.name)) || memberDoc.ev?.h;
  if (!handle) return null;
  return { mode: 'handle', handle, shards: EV_SHARDS, shard };
}

/**
 * Re-mint one member's own handle after the one they hold has been refused
 * (POST /api/ws/:ws/events/handle, worker/index.js — itself rate-limited per
 * member, since ensureHandle's own cache means nothing here is retried on
 * its own). The owner holds no handle to replace — they subscribe in `own`
 * mode — so their call is just eventsBlock's own bootstrap answer again.
 *
 * The old handle is revoked before anything else, its failure ignored:
 * releaseHandle is the only other place a handle is given back, and it reads
 * `ev.h`, which this is about to overwrite, so a handle abandoned here would
 * sit on one of the owner's live-handle slots (10,000 per app, 2,000 on free)
 * until cleared by hand from a Puter session. Revoking is idempotent and
 * already answers ok on a 404/subject_does_not_exist, so the ordinary case
 * here — a handle that is already gone, which is why this was called at all
 * — costs one wasted round trip, while the uncommon one (an app binding
 * changed under a still-live handle) actually frees a slot. The member
 * document is then cleared of `ev` entirely, not only its handle: `until`
 * and `why` go with it, so this member's own backoff does not outlive the
 * handle it was recorded against.
 *
 * The worker-wide verdict in tc:config.ev is deliberately left standing: if
 * it says a mint would be refused, eventsBlock's own ensureHandle answers
 * null without spending one of the owner's mints on a certain failure, and
 * the caller falls back to polling exactly as it does today. That is what
 * makes this compose with the owner-side healing in shell.js: a handle that
 * died because the owner revoked the grant leads here to a refused re-mint,
 * which is a worker-wide verdict, which the owner's own next visit clears.
 *
 * Never throws: every await here already `.catch`es its own failure, and
 * eventsBlock is no different.
 */
export async function remintHandle(ws, uuid, doc = null, user = null) {
  const appUid = workerAppUid();
  if (!appUid) return null;
  const caller = callerAppUid(user);
  if (caller && caller !== appUid) return null;
  const cfg = await serverConfig();
  if (cfg.owner === uuid) return eventsBlock(ws, uuid, doc, user);
  const memberDoc = doc || (await kv().get(KEYS.member(ws.id, uuid)).catch(() => null)) || {};
  const old = memberDoc?.ev?.h;
  if (old) await revokeHandle(old).catch(() => {});
  await kv().remove(KEYS.member(ws.id, uuid), 'ev').catch(() => {});
  return eventsBlock(ws, uuid, { ...memberDoc, ev: undefined }, user);
}

/**
 * GET /api/server's events status, owner only: whether the platform and the
 * owner's consent both stand. `why: 'unknown'` means nothing has actually
 * been probed yet (no member has ever attempted a mint) — distinct from a
 * definite refusal, so the client's consent toast, which must fire only on
 * a definite one, leaves an owner who already granted the permission alone
 * rather than asking again just because this worker has not confirmed it.
 * A worker with no app identity used to answer bare null here, so an owner
 * whose worker can never do events was told nothing, for ever — and
 * overwriting the worker bundle is not the fix, since a worker's app
 * identity is settled once, when `puter.workers.create()` makes it; the only
 * remedy is deploying a new worker. `'no_app_uid'` names that case instead,
 * the same code mintHandle() already answers for it, so a caller only ever
 * has one name to check.
 */
export async function serverEventsStatus() {
  const appUid = workerAppUid();
  if (!appUid) return { appUid: null, delegated: false, why: 'no_app_uid' };
  const cfg = await serverConfig();
  const verdict = cfg.ev;
  if (!verdict) return { appUid, delegated: false, why: 'unknown' };
  return { appUid, delegated: !!verdict.ok, why: verdict.ok ? null : (verdict.why || 'unknown') };
}

/** PUT /api/server { events: true }: forget a cached refusal so the next mint attempt re-probes the platform and the owner's consent from scratch. */
export async function clearEventsVerdict() {
  await setServerConfig({ ev: null });
}
