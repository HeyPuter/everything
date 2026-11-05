/**
 * The workspace's change-signal region, shared by the worker (which writes
 * it) and the client (which subscribes to it): see
 * docs/systemDesignDocs/teamchatEventsSignaling.md for the full design. A
 * signal key carries nothing but a shard index and a timestamp — never a
 * conversation, a member, or a kind of change — and the worker alone decides
 * which shard a member's uuid falls in, so a client only ever has to use the
 * shard number its own bootstrap hands it.
 */
import { KEYS } from './blocks.js';

/**
 * A fixed shard count rather than one sized to a workspace's membership: a
 * member's shard has to be computed at every signal write, several of which
 * do not have the workspace document at hand, and a count read from a stale
 * client alongside a fresher worker would disagree about who owns which
 * shard. Four shards land 200 concurrent watchers per workspace at full
 * fidelity before Puter's per-event fan-out cap starts handing out gap
 * markers instead of silence.
 */
export const EV_SHARDS = 4;

/**
 * FNV-1a, 32-bit: small, deterministic, and dependency-free, so the worker
 * and every browser compute the exact same shard for the exact same uuid
 * with nothing to keep in sync between them.
 */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Which of the EV_SHARDS shards a member's uuid falls in. Computed by the worker only; the client just uses the number its bootstrap gives it. */
export function evShard(uuid) {
  return fnv1a32(String(uuid)) % EV_SHARDS;
}

/**
 * Shards for the ring entries and their companion pings (`r{n}`, `o{n}`),
 * which clients that read ring entries subscribe to instead of `s{n}`. Eight
 * keeps a shard near 75 tabs at 300 members with two tabs each, under the
 * 128 matched subscriptions past which Events drops values; a ring write is
 * one batched set whatever the count. Fixed for the same reason EV_SHARDS is.
 */
export const EV_RING_SHARDS = 8;

/** Slots per ring shard. Entries go to `n % RING_SLOTS`, so a slot is only rewritten after this many more entries on its shard. */
export const RING_SLOTS = 16;

export function evRingShard(uuid) {
  return fnv1a32(String(uuid)) % EV_RING_SHARDS;
}

/** The published handler that wakes a workspace's due queue. */
export const DUE_HANDLER = 'teamchat-due-v1';

/**
 * The Puter `group` for a banner tag: a newer notification in the same group
 * replaces the one showing. A digest keeps long workspace and conversation tags within the group limit.
 */
export function pushGroup(tag) {
  const s = String(tag);
  return `tc.${fnv1a32(s).toString(36)}${fnv1a32(`${s}|`).toString(36)}`;
}

/**
 * The absolute key of shard `n`: exactly five `:`-segments (`tc`, `ws`, the
 * workspace id, `ev`, `s{n}`). A Puter Events subscription anchors on an
 * exact key only within six segments; a seventh makes the anchor fall back to
 * the first six with the whole key as a filter, which in a naming where the
 * shard index sat beyond that point would put every shard on one anchor and
 * reintroduce the per-workspace fan-out limit sharding exists to avoid.
 * `s{n}` keeps a segment of room under that; do not add depth here.
 */
export const evShardKey = (wsId, n) => KEYS.evShard(wsId, n);

/** The workspace's whole signal region: what the owner's own direct subscription is rooted on, and the prefix a member's handle is minted against. */
export const evRegion = (wsId) => KEYS.evRegion(wsId);

function b64ToBytes(b64) {
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** A dashed `au` was never packed and stands as it is; anything else is base64 that must decode to exactly sixteen bytes, a uuid's worth, or it is not one and is refused rather than dressed up as an id nothing will ever match. */
function decodeCompressedAppUid(v) {
  if (v.includes('-')) return v;
  const bytes = b64ToBytes(v.replace(/_/g, '/'));
  if (bytes.length !== 16) return null;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `app-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The app uid a Puter auth token carries, or null: no token, a user-scoped
 * session with no app claim at all, or anything that will not parse. Both
 * the worker and the client decode it themselves, and from both claim
 * forms, because a v2 token — the only kind the platform has signed for
 * years — never carries `app_uid` at all: signing compresses the payload,
 * and the auth scope's table maps `app_uid` to `au`, whose value is the uuid
 * with its `app-` prefix stripped, its dashes removed and its hex packed
 * into base64. Reading `app_uid` alone, on the reasoning that puter.js's own
 * getAppIDFromAuthToken is undocumented and should not be depended on, found
 * nothing in any token the platform actually signs: every worker read as
 * user-scoped, every bootstrap left the `events` block out, and the whole
 * feature was inert while the tests passed against a fixture shaped like no
 * real token. The short aliases are the wire contract — they are what the
 * token holds, the long names never reach it — so decoding them here is
 * safe; ignoring them was not.
 */
export function appUidFromToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(
      b64ToBytes(parts[1].replace(/-/g, '+').replace(/_/g, '/')),
    ));
    const uid = typeof payload?.app_uid === 'string' && payload.app_uid
      ? payload.app_uid
      : typeof payload?.au === 'string' && payload.au ? decodeCompressedAppUid(payload.au) : null;
    return uid && uid.startsWith('app-') ? uid : null;
  } catch {
    return null;
  }
}

/**
 * The owner's one consent for Teamchat to share workspaces' signal regions
 * with their members, watch only, as perms.request('kvShare', …) and
 * perms.check take it. Covers every workspace the owner will ever have. The
 * permission string it stands for, `manage:kv-share:<owner>:<app>:tc:ws`, is
 * what owners were asked for before the resource existed.
 */
export const EV_GRANT = Object.freeze({ prefix: 'tc:ws', access: 'watch' });
