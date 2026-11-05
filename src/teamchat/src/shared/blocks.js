/**
 * Message storage math, shared by the worker and the client.
 *
 * Every conversation (channel, DM, or thread) has one integer counter and a
 * series of fixed-size block documents:
 *
 *   tc:conv:{conv}:seq      the counter (kv.incr): the newest message's seq
 *   tc:conv:{conv}:b:{n}    block n: { m: [messages], x: { overlays } }
 *
 * A message with sequence number `seq` (1-based) lives in block
 * floor((seq - 1) / BLOCK_SIZE). The head block is therefore derived from the
 * counter alone, so a reader never lists keys: it reads the counter, then
 * exactly the blocks it needs, one get per BLOCK_SIZE messages.
 *
 * `tc:ws:{id}:ev:s{n}` is the workspace's change-signal region
 * (src/shared/events.js): the `ev` segment under `tc:ws:{id}:` is reserved
 * for it and must never be given to anything else, since a Puter Events
 * subscription anchors on the key prefix and a second meaning under `ev`
 * would blur what a signal key discloses.
 */

export const BLOCK_SIZE = 50;

/**
 * How large a block may grow before it is closed early (see the worker's
 * writeMessage): the store takes a value of 400 KB at most, and fifty
 * messages of the longest text allowed, each edited once (the edit's text
 * sits beside the original), come to 405 KB on their own, with five
 * attachments, a link card, mentions and a few hundred reactions each on
 * top of that. Past this many bytes the rest of the block's numbers are left
 * unused and the next message opens the next block; the numbering stays
 * whole (a message is found by its number as before), the skipped numbers
 * simply have no message, as a run of deleted messages has none. Measured
 * in bytes of the JSON, the unit the store's ceiling is taken to be in.
 */
export const BLOCK_BYTES = 160 * 1024;
/**
 * Past this a block takes no write that grows it by more than a few bytes
 * (an edit's text, a new reaction, a link card, a follower): refused with a
 * word to the member, where the store would refuse the write with none and
 * leave the block unable to take any change at all.
 */
export const BLOCK_BYTES_HARD = 360 * 1024;

/** The bytes a document takes as JSON (what the store's ceiling is measured against). */
export function jsonBytes(doc) {
  const s = JSON.stringify(doc);
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(s).length : s.length;
}

export function blockIndexOf(seq) {
  return Math.floor((seq - 1) / BLOCK_SIZE);
}

/** First sequence number stored in block n. */
export function firstSeqOfBlock(n) {
  return n * BLOCK_SIZE + 1;
}

/** Last sequence number stored in block n. */
export function lastSeqOfBlock(n) {
  return (n + 1) * BLOCK_SIZE;
}

/** True when `seq` is the first message written into its block. */
export function isFirstInBlock(seq) {
  return (seq - 1) % BLOCK_SIZE === 0;
}

export const KEYS = {
  user: (uuid) => `tc:user:${uuid}`,
  ws: (wsId) => `tc:ws:${wsId}`,
  member: (wsId, uuid) => `tc:ws:${wsId}:u:${uuid}`,
  activity: (wsId) => `tc:ws:${wsId}:act`,
  /** `{ [channel]: { [uuid]: 1 } }`: who hears a channel at "all messages", for pushes. */
  notifyAll: (wsId) => `tc:ws:${wsId}:na`,
  invite: (code) => `tc:invite:${code}`,
  seq: (conv) => `tc:conv:${conv}:seq`,
  block: (conv, n) => `tc:conv:${conv}:b:${n}`,
  file: (id) => `tc:file:${id}`,
  /** The search index from before month buckets: one shard set for all time. Read, never written. */
  searchShard: (wsId, n) => `tc:ws:${wsId}:idx:${n}`,
  /** Search index shard n of one month bucket (`yyyymm`). */
  searchBucket: (wsId, bucket, n) => `tc:ws:${wsId}:idx:m${bucket}:${n}`,
  /** The index's counters and its list of months: `{ c, folded, failed, months }`. */
  searchMeta: (wsId) => `tc:ws:${wsId}:idx:meta`,
  /** Log segment s: the postings of SEARCH_FOLD_EVERY messages waiting to be folded into the shards. */
  searchLog: (wsId, s) => `tc:ws:${wsId}:idx:log:${s}`,
  /** The direct messages a search rebuild in progress may read: kept here, so the list a step brings back is checked against the worker's own. */
  searchWalk: (wsId) => `tc:ws:${wsId}:idx:walk`,
  pins: (wsId, conv) => `tc:ws:${wsId}:pins:${conv}`,
  inbox: (wsId, uuid) => `tc:ws:${wsId}:u:${uuid}:inbox`,
  threads: (wsId, uuid) => `tc:ws:${wsId}:u:${uuid}:threads`,
  saved: (wsId, uuid) => `tc:ws:${wsId}:u:${uuid}:saved`,
  sched: (wsId) => `tc:ws:${wsId}:sched`,
  hook: (id) => `tc:hook:${id}`,
  bot: (id) => `tc:bot:${id}`,
  unfurl: (hash) => `tc:unfurl:${hash}`,
  /** The conversations an export in progress walks, named by its cursor. */
  exportList: (wsId, token) => `tc:ws:${wsId}:export:${token}`,
  /**
   * A connection between two workspaces sharing a channel: the host's record
   * and the partner's, each with their common secret. Two keys, since both
   * workspaces may well live on one worker.
   */
  connect: (id) => `tc:connect:${id}`,
  connectPartner: (id) => `tc:connect:${id}:partner`,
  /** The workspace's whole change-signal region (src/shared/events.js): what a member's handle is minted against. */
  evRegion: (wsId) => `tc:ws:${wsId}:ev:`,
  /**
   * One shard of the signal region: `tc:ws:{wsId}:ev:s{n}`, exactly five
   * `:`-segments. A Puter Events subscription anchors on an exact key only
   * while it is within six segments; past that the anchor falls back to the
   * first six and the whole key becomes a filter, which — in a naming where
   * the shard index sat beyond that point — would put every shard on one
   * anchor and reintroduce the per-workspace fan-out limit sharding exists to
   * avoid. `s{n}` rather than `s:{n}` keeps a segment of room under the cap;
   * both would fit today, and neither should grow.
   */
  evShard: (wsId, n) => `tc:ws:${wsId}:ev:s${n}`,
  /** Ping shard n of EV_RING_SHARDS for changes no ring entry carries (src/shared/events.js). Five segments, as above. */
  evPing: (wsId, n) => `tc:ws:${wsId}:ev:o${n}`,
  /** Ring shard n's slot k: one sealed change entry. Six segments, so a `r{n}:*` subscription anchors on its own shard. */
  evRingSlot: (wsId, n, k) => `tc:ws:${wsId}:ev:r${n}:k${k}`,
  /** What a subscription to ring shard n is rooted on. */
  evRingPrefix: (wsId, n) => `tc:ws:${wsId}:ev:r${n}:`,
  /** The ring shards' entry counters, `{ s0, s1, ... }`. Outside the `ev` region, so no handle sees it. */
  evCounter: (wsId) => `tc:ws:${wsId}:evn`,
};

/** Thread conversation id for the replies to message `seq` of `conv`. */
export function threadConvId(conv, seq) {
  return `${conv}_t${seq}`;
}

/** Split a thread id back into its parent, or null for a top-level conv. */
export function parentOfThread(conv) {
  const m = /^(.+)_t(\d+)$/.exec(conv);
  return m ? { conv: m[1], seq: Number(m[2]) } : null;
}

/** Overlay path segment for a message: prefixed so it never reads as an array index. */
export function overlayKey(seq) {
  return `s${seq}`;
}

/**
 * A message's reactions, less any that nobody is under any more. Taking a
 * reaction back takes one's own name off the record and nothing else (see
 * the worker's reaction routes), so the entry stays, empty, until another
 * name goes under it or the record is tidied; no reader is shown it.
 */
function liveReactions(r) {
  if (!r || typeof r !== 'object') return {};
  const out = {};
  for (const [k, users] of Object.entries(r)) if (users && typeof users === 'object' && Object.keys(users).length) out[k] = users;
  return out;
}

/**
 * Merge a block's overlays into its messages. Deleted messages are dropped
 * unless they anchor a thread, in which case a tombstone stays so the
 * replies remain reachable: its place, author, time, and reply count, and
 * nothing of what it said. The deletion only flags the record (the text,
 * mentions, reactions, and attachment list stay in the block), so the
 * tombstone used to carry all of it to every reader who cared to look past
 * the client's "This message was deleted".
 */
export function mergeBlock(block) {
  const list = Array.isArray(block?.m) ? block.m : [];
  const x = block?.x || {};
  const out = [];
  for (const m of list) {
    if (!m || typeof m.s !== 'number') continue;
    const o = x[overlayKey(m.s)] || {};
    const msg = {
      seq: m.s,
      user: m.u,
      text: typeof o.t === 'string' ? o.t : m.t,
      ts: m.ts,
      kind: m.k || 'msg',
      attachments: Array.isArray(m.a) ? m.a : [],
      mentions: Array.isArray(m.mn) ? m.mn : [],
      broadcast: m.bc || null,
      editedAt: o.e || null,
      deleted: !!o.d,
      reactions: liveReactions(o.r),
      replyCount: o.rc || 0,
      lastReplyAt: o.rt || null,
      followers: o.f || null,
      pinned: !!o.p,
      ref: m.ref || null,
      bot: m.bot || null,
      unfurl: o.uf && !o.uf.off ? o.uf : null,
      // The client id the message was sent with, for the sender's own
      // placeholder to recognise it by when the send's answer was lost.
      cid: m.cid || null,
    };
    if (msg.deleted && !msg.replyCount) continue;
    if (msg.deleted) Object.assign(msg, { text: '', attachments: [], mentions: [], broadcast: null, reactions: {}, followers: null, unfurl: null });
    out.push(msg);
  }
  return out;
}

/**
 * A merged message (mergeBlock's shape) with one ring patch laid over it, or
 * null when the patch takes it out (deleted with no replies). Every field is
 * idempotent: an edit stands only over an older one, a reply count and last
 * reply time only grow, a reaction is set or cleared for one person.
 *
 *   { t, e, uf? }       edited (uf: null when the edit dropped the card)
 *   { d: 1 }            deleted
 *   { r, ru, on }       reaction r put on (on: 1) or taken off by ru
 *   { rc, rt, f? }      a reply: the root's count and last reply, f the uuids now following
 *   { p }               pinned (1) or unpinned (0)
 *   { uf }              link card set, or null when removed
 */
export function applyOverlayPatch(msg, patch) {
  if (!msg || !patch || typeof patch !== 'object') return msg;
  if (msg.deleted) return msg;
  const out = { ...msg };
  if (patch.d) {
    if (!out.replyCount) return null;
    return { ...out, deleted: true, text: '', attachments: [], mentions: [], broadcast: null, reactions: {}, followers: null, unfurl: null };
  }
  if (typeof patch.t === 'string' && Number(patch.e) >= (out.editedAt || 0)) {
    out.text = patch.t;
    out.editedAt = Number(patch.e);
  }
  if (typeof patch.r === 'string' && typeof patch.ru === 'string') {
    const reactions = { ...(out.reactions || {}) };
    const users = { ...(reactions[patch.r] || {}) };
    if (patch.on) users[patch.ru] = 1;
    else delete users[patch.ru];
    if (Object.keys(users).length) reactions[patch.r] = users;
    else delete reactions[patch.r];
    out.reactions = reactions;
  }
  if (Number.isFinite(patch.rc)) out.replyCount = Math.max(out.replyCount || 0, patch.rc);
  if (Number.isFinite(patch.rt)) out.lastReplyAt = Math.max(out.lastReplyAt || 0, patch.rt);
  if (Array.isArray(patch.f) && patch.f.length) {
    const followers = { ...(out.followers || {}) };
    for (const u of patch.f) if (typeof u === 'string') followers[u] = 1;
    out.followers = followers;
  }
  if (patch.p === 0 || patch.p === 1) out.pinned = !!patch.p;
  if ('uf' in patch) out.unfurl = patch.uf && !patch.uf.off ? patch.uf : null;
  return out;
}
