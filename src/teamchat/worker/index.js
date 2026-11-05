/**
 * Teamchat API: a Puter Serverless Worker.
 *
 * Every workspace owner runs a copy of this worker in their own Puter
 * account (the app deploys it for them), so a workspace's data lives in its
 * owner's key-value store (me.puter.kv), which is what lets every member
 * read and write the same channels, and the owner pays for it. Callers are
 * identified by the Puter session that puter.workers.exec() forwards;
 * nothing about identity is trusted from request bodies. Only the owner may
 * create workspaces here (see assertMayCreate); members of other people's
 * workspaces only ever touch data inside those workspaces.
 *
 * Storage layout (no kv.list anywhere; every read is a direct get):
 *
 *   tc:config                 { owner, open } who runs this worker
 *   tc:user:{uuid}            profile card + the user's workspace ids here
 *   tc:ws:{ws}                workspace: name, invite, channels{}, members{}, former{} (who left), removed{} (externals kept out)
 *   tc:ws:{ws}:u:{uuid}       per-member state: channels, dms, reads, mentions, notify, threads
 *   tc:ws:{ws}:act            activity: c{conv: {s,t,u,x}}, p{uuid: seen}, t{conv: {uuid: ts}}, w, u{},
 *                             h{conv: { by, at, m{uuid: {at, j, inv}} }} the huddles in progress (src/shared/huddle.js),
 *                             he{conv: {t{at}: claims}} who writes a huddle's "ended" line (endHuddle)
 *   tc:invite:{code}          { ws } | { ws, ch, role: 'guest' | 'connect' }
 *   tc:connect:{id}           a shared channel's connection: host side { ws, ch, partner, name, secret },
 *                             partner side { ws, ch, ref, rch, secret } (see worker/connect.js)
 *   tc:conv:{conv}:seq        message counter (kv.incr)
 *   tc:conv:{conv}:b:{n}      message block n: { m: [...], x: {overlays} }
 *   tc:file:{id}              attachment metadata (bytes live in me.puter.fs)
 *   tc:ws:{ws}:pins:{conv}    pinned messages: { items: [{ seq, by, ts }] }
 *   tc:ws:{ws}:u:{uuid}:inbox   activity inbox ring: { items: [{ k, c, s, by, ts }] }
 *   tc:ws:{ws}:u:{uuid}:threads followed threads: { t: { [threadId]: { c, s, at } } }
 *   tc:ws:{ws}:u:{uuid}:saved   saved for later: { items: [{ c, s, ts, done }] }
 *   tc:ws:{ws}:sched          due queue: { m: { [id]: scheduled message | reminder } }; act.nd = next due time
 *   tc:unfurl:{sha256(url)}   a link preview, cached with a TTL (negative results briefly)
 *   tc:hook:{id}              incoming webhook: { ws, ch, name, color, hash } (the token's secret is only ever hashed)
 *   tc:bot:{id}               bot token: { ws, name, color, hash, scopes, channels }
 *   tc:ws:{ws}:idx:m{yyyymm}:{n}  search index, month bucket, shard n: { token: [postings] }
 *   tc:ws:{ws}:idx:meta       the index's counters and months: { c, folded, failed, months }
 *   tc:ws:{ws}:idx:log:{s}    log segment s: postings waiting to be folded into the shards
 *   tc:ws:{ws}:idx:{n}        the index from before month buckets, read until the workspace is rebuilt
 */
import {
  KEYS, blockIndexOf, isFirstInBlock, firstSeqOfBlock, lastSeqOfBlock, mergeBlock, overlayKey, parentOfThread, threadConvId, BLOCK_SIZE, BLOCK_BYTES, BLOCK_BYTES_HARD, jsonBytes,
} from '../src/shared/blocks.js';
import { uid, inviteCode, normalizeInviteCode, dmConvId, colorSlot } from '../src/shared/ids.js';
import {
  LIMITS, INVITE_TTLS, DEFAULT_INVITE_TTL, POST_POLICIES, THREAD_POLICIES, BROADCASTS, BROADCAST_POLICIES, BROADCAST_FANOUT, NOTIFY_LEVELS,
  cleanChannelName, cleanText, extractMentionNames, broadcastKind, firstUnfurlableLink, isAppLink,
} from '../src/shared/limits.js';
import { isReactionKey, REACTIONS_PER_MESSAGE, REACTORS_PER_MESSAGE } from '../src/shared/reactions.js';
import {
  kv, fs, fail, route, identify, peekIdentity, readJson, query, appendToBlock, ensureBlock, getMany,
  WORKER_BUILD, WORKER_BUILT_AT, workerRuntime, serverConfig, setServerConfig, assertMayCreate, HttpError, sha256, timingSafeEqual, workerHost,
} from './lib.js';
import { buildSampleWorkspace } from './sample.js';
import { indexMessage, indexEdit, indexStamp, deleteIndex, search as searchIndex, searchMeta, reindexStep, indexBatch, counterReader, REINDEX_MAX_CONVS } from './search.js';
import { words as queryWords, isBucket, SEARCH_VERSION } from '../src/shared/search.js';
import { unfurl, readImage, allowedUrl, readCapped } from './unfurl.js';
import { vapidKeys, sendPush, pushAllowed } from './push.js';
import { signal } from './signal.js';
import {
  eventsBlock, serverEventsStatus, clearEventsVerdict, releaseHandle, remintHandle, REVOKE_BATCH_MAX, workerAppUid, ensureHandle,
} from './events.js';
import { ringBlock, ringCount, bumpRingEpoch } from './ring.js';
import { EV_SHARDS, EV_RING_SHARDS, RING_SLOTS, pushGroup } from '../src/shared/events.js';
import { signAttestation, verifyAttestation, ATTEST_TTL_MS, EXTERNAL_TTL_MS, CONN_ID_RE, SECRET_RE, REF_RE } from './connect.js';
import { liveHuddle, liveHuddles, stalePaths, HUDDLE_MAX, INVITE_RE, SESSION_RE, durationText } from '../src/shared/huddle.js';

/** Inbox entries one person's reactions to one message may leave its author. */
const REACTION_NOTICES = 3;

const now = () => Date.now();
/**
 * A caller-supplied id looked up in a map: own properties only, so names
 * inherited from Object.prototype (`constructor`, `__proto__`) can never
 * pass for a channel, member, conversation, or token that exists.
 */
const own = (obj, key) => (obj && typeof obj === 'object' && Object.hasOwn(obj, key) ? obj[key] : undefined);
const isAdmin = (member) => member && (member.role === 'owner' || member.role === 'admin');
/** Guests came in through a channel invite: they see only the channels they are in and the people in them. */
const isGuest = (member) => member && member.role === 'guest';
/**
 * External members belong to another workspace and take part in a channel
 * shared with it (see worker/connect.js). They are labelled with their
 * organization, cannot be promoted, and are never added to other channels.
 */
const isExternal = (member) => member && member.role === 'external';
/** Guests and externals alike: their view of the workspace is the channels they are in. */
const isLimited = (member) => isGuest(member) || isExternal(member);
/**
 * How a refusal names a limited member's standing. Someone from a connected
 * workspace who asked to create or change a channel here, add people to
 * one, or have this workspace vouch for them was told what guests cannot
 * do, and they are no guest: the word is for the caller.
 */
const limitedWho = (member) => (isExternal(member) ? 'People from a connected workspace' : 'Guests');
/**
 * A channel entry that stands for a channel hosted on another workspace:
 * `shared` names the host and the channel there. Nothing is ever posted
 * into it here; it puts the channel in this workspace's sidebar and lets
 * this worker vouch for its members to the host.
 */
const isPartnerEntry = (channel) => !!(channel && channel.shared && typeof channel.shared === 'object');

/* ------------------------------------------------------------------------ */
/* Users                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * The caller's card on this worker: display name, title, color, plus the
 * ids of their workspaces here. The card is a copy of the profile the app
 * keeps in the user's own account; `seed` carries that profile along with
 * the requests that first bring a user to a worker (create, join), and
 * PUT /api/me refreshes it later.
 */
async function ensureProfile(id, seed = null, { known = undefined } = {}) {
  const key = KEYS.user(id.uuid);
  // `known` is the record as a caller already read it (null where there is
  // none): the bootstrap reads it in the same call as the caller's member
  // document, and reading it again here was a round trip for an answer
  // already in hand.
  let profile = known === undefined ? await kv().get(key) : known;
  let renamed = false;
  if (!profile) {
    // Written once, with what the seed says (a name, a title, a colour, a
    // status brought along by a join): written bare and then patched with
    // the seed, as it used to be, every first arrival on a server cost two
    // writes where one carries the whole.
    profile = {
      uuid: id.uuid,
      username: id.username,
      name: id.username,
      title: '',
      color: colorSlot(id.uuid),
      workspaces: [],
      createdAt: now(),
      ...profilePatch(seed),
    };
    await kv().set(key, profile);
  } else if (profile.username !== id.username && id.username) {
    profile.username = id.username;
    await kv().update(key, { username: id.username });
    renamed = true;
  }
  if (!Array.isArray(profile.workspaces)) profile.workspaces = [];
  // A list of distinct workspaces, wherever it is read: two tabs appending
  // the same workspace at once (see listWorkspace) named it twice, and
  // /api/me listed it twice, a card sync wrote it twice, and the cap on
  // workspaces counted it twice. A record found to repeat one is put right
  // once, here.
  const distinct = [...new Set(profile.workspaces)];
  if (distinct.length !== profile.workspaces.length) {
    profile.workspaces = distinct;
    await kv().update(key, { workspaces: distinct }).catch(() => {});
  }
  // What the seed says that the record here does not: compared by value (a
  // status is an object, and one equal to the record's is no change; taken
  // for one, as it used to be, the record was written again on every seed
  // that carried a status, once a day per renewal of someone from a
  // connected workspace).
  const patch = profilePatch(seed);
  const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => JSON.stringify(profile[k] ?? null) !== JSON.stringify(v ?? null)));
  if (Object.keys(changed).length) {
    Object.assign(profile, changed);
    await kv().update(key, changed);
  }
  // The handle sits on every card of theirs as well, and a mention is
  // resolved by the card's: an account renamed on Puter was shown, and
  // reached by @-mention, under its old name in every workspace here. So
  // does what the seed changed: the profile travels with a join (of a
  // workspace, or of a channel shared with one), and a name, title, colour
  // or status changed while this server was out of reach (the app's PUT
  // /api/me, best effort, never landed here) was written to the record and
  // to the new card alone, so the person stood under two names on one
  // server, the old one on every card they had here, until the app next
  // saved their profile. The cards a change reaches take it as PUT /api/me
  // has them take it (see syncCards).
  const onCards = { ...(renamed ? { username: id.username } : {}), ...changed };
  if (Object.keys(onCards).length) await syncCards(profile, onCards);
  return profile;
}

/**
 * Validate a profile body into a patch of name, title, color, status, and
 * the avatar version; unknown or invalid fields are dropped. The avatar
 * version only says a photo exists (the bytes arrive separately); a status
 * is an emoji, a short text, and an optional expiry.
 */
function profilePatch(body, { strict = false } = {}) {
  const patch = {};
  if (!body || typeof body !== 'object') return patch;
  if (typeof body.name === 'string') {
    const name = cleanLine(body.name, LIMITS.displayName);
    if (name) patch.name = name;
    else if (strict) fail(400, 'invalid', 'Display name cannot be empty');
  }
  if (typeof body.title === 'string') patch.title = cleanLine(body.title, LIMITS.title);
  if (Number.isInteger(body.color) && body.color >= 1 && body.color <= 8) patch.color = body.color;
  if (body.status === null) patch.status = null;
  else if (body.status && typeof body.status === 'object') {
    const text = cleanLine(body.status.text, LIMITS.statusText);
    // The emoji is drawn inline before the text and beside the name, as the
    // text is: a one-line field like it, cleaned like it (an override
    // passed here turned the line around as one in the text once did).
    const emoji = cleanLine(body.status.emoji, 16);
    const until = Number.isFinite(body.status.until) && body.status.until > 0 ? Math.floor(body.status.until) : null;
    patch.status = text || emoji ? { emoji, text, until } : null;
  }
  return patch;
}

function memberRecord(profile, role) {
  return {
    username: profile.username,
    name: profile.name || profile.username,
    title: profile.title || '',
    color: profile.color || colorSlot(profile.uuid),
    avatar: profile.avatar || null,
    status: profile.status || null,
    role,
    joinedAt: now(),
  };
}

/**
 * A one-line field as cards, headers and lists show it (a display name, a
 * title, a status, a workspace's name, a reminder's note, a channel's topic
 * and description and its bookmarks' labels). The control
 * characters (C0 but tab and newline, C1) and the bidi embedding, override
 * and isolate characters come out before the trim, and what is left must
 * have a mark to show: a name of a bell character, or of zero-width joiners
 * alone, passed as a name and drew as none, and a name opened with a
 * right-to-left override turned the rest of its line around (the time
 * beside it, the text after it), the override running to the end of the
 * paragraph while a name sits inline. Joiners and non-joiners inside stay:
 * emoji sequences and Persian and Indic words are written with them; so do
 * the plain left-to-right and right-to-left marks. Message text is not
 * this: the renderer draws it as content, in a block of its own.
 */
const LINE_CONTROLS_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
const LINE_VISIBLE_RE = /[\p{L}\p{N}\p{P}\p{S}\p{M}]/u;
/**
 * Letters and symbols by category that draw as nothing all the same: the
 * Hangul fillers (the conjoining choseong and jungseong fillers, the
 * compatibility filler, its halfwidth form) and the braille pattern with no
 * dots. Each passes for a mark to show by its category alone, and a name, a
 * title or a workspace's name made of them alone was taken and drew as an
 * empty space wherever it was shown. They stay in a line that has something
 * else to show (a name may carry one), and count for nothing in deciding
 * whether it has.
 */
const LINE_BLANK_RE = /[\u115F\u1160\u3164\uFFA0\u2800]/g;
/**
 * A line of combining marks alone (accents, vowel signs, variation
 * selectors), with nothing for them to sit on: each is a mark by category
 * and passed for something to show, and a name or a workspace's name made
 * of them alone was taken and drew as a few stray accents on nothing, or as
 * nothing at all. A mark on a letter stays, as every accented or Indic name
 * needs it to.
 */
const LINE_MARKS_ONLY_RE = /^[\p{M}\s]*$/u;
/**
 * What no address carries (see the bookmark route): the controls a line is
 * cleaned of, and the zero-width and directional marks a name may keep but
 * an address has no use for, since each reads as nothing where the address
 * is shown and sends the link somewhere other than where it appears to go.
 */
const URL_CONTROLS_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
function cleanLine(input, max) {
  if (typeof input !== 'string') return '';
  const s = cleanText(input.replace(LINE_CONTROLS_RE, ''), max);
  const shown = s.replace(LINE_BLANK_RE, '');
  return LINE_VISIBLE_RE.test(shown) && !LINE_MARKS_ONLY_RE.test(shown) ? s : '';
}

/**
 * Refuse an upload whose declared length is past the route's cap before its
 * body is read: a multipart body is parsed whole (request.formData holds it
 * in the worker's memory), and the file's size was checked only after that,
 * so a body of any length was buffered on the owner's worker before it was
 * refused. The declared length may run a little past the file (the parts'
 * boundaries and headers, a long file name; `MULTIPART_MARGIN`), so only one
 * past the cap by more than that is refused here, with the words the route
 * refuses the file with; a body sent without a length, or with one that does
 * not parse, is read and measured as before.
 */
const MULTIPART_MARGIN = 64 * 1024;
function assertDeclaredSize(request, cap, words) {
  const declared = Number(request.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > cap + MULTIPART_MARGIN) fail(413, 'too_large', words);
}

/** Where a member's photo bytes live in this worker's drive. */
const avatarPath = (uuid) => `teamchat-avatars/${uuid}`;
/** A workspace's icon, in its owner's drive like its attachments. */
const iconPath = (wsId) => `teamchat-icons/${wsId}`;

/**
 * Put a workspace on someone's own list of them (what /api/me answers from,
 * and what a change of name or photo reaches their cards through) by an
 * atomic append, and take a second copy off again where the answer shows
 * one: two tabs finding the workspace missing at once (opening one a move
 * or an import carried the member into, renewing a seat in a shared channel,
 * opening an invite link again after a join cut short) each appended it, and
 * the list named the workspace twice. The join of a newcomer takes its own
 * append as a claim and is not this (see /api/join).
 */
async function listWorkspace(uuid, wsId) {
  const res = await kv().add(KEYS.user(uuid), { workspaces: [wsId] });
  const list = res && Array.isArray(res.workspaces) ? res.workspaces : null;
  if (list && list.filter((w) => w === wsId).length > 1) await kv().update(KEYS.user(uuid), { workspaces: [...new Set(list)] }).catch(() => {});
}

/** Write a profile field to every workspace card the caller really holds. */
async function syncCards(profile, patch) {
  const docs = await getMany(profile.workspaces.map((w) => KEYS.ws(w)));
  // A workspace document already holding as much as it may (see
  // assertWorkspaceRoom, which refuses a join or a channel past the ceiling)
  // takes no card that grows: the ceiling is checked where channels, their
  // text and new cards go on, and never where a card already there is
  // lengthened, so five hundred members each giving themselves the longest
  // name, title and status could carry the document past what the store
  // takes, after which no count, role, join or invite in the workspace
  // could be written. The card there keeps what it had; a change that makes
  // the card no longer (a shorter name, a status cleared) still lands.
  const room = (doc) => {
    const card = doc.members[profile.uuid];
    if (JSON.stringify({ ...card, ...patch }).length <= JSON.stringify(card).length) return true;
    return JSON.stringify(doc).length <= WS_DOC_BYTES;
  };
  const held = profile.workspaces.filter((w, i) => docs[i]?.members?.[profile.uuid] && room(docs[i]));
  const upd = {};
  for (const [k, v] of Object.entries(patch)) upd[`members.${profile.uuid}.${k}`] = v;
  // A dozen workspaces at a time, as every fan-out here goes (see getMany):
  // one after another, as it used to be, a member of twenty workspaces on
  // this server (and of the hosts of the channels shared with them) paid
  // three round trips a workspace in a row for a new name or photo.
  for (let i = 0; i < held.length; i += 12) {
    await Promise.all(held.slice(i, i + 12).map(async (wsId) => {
      const res = await kv().update(KEYS.ws(wsId), upd).catch(() => null);
      // Whether the card still stands is read off the workspace document;
      // the bump is on the activity document, and neither answer feeds the
      // other, so they go together rather than one after the other.
      await Promise.all([
        res === null ? null : cardStands(wsId, profile.uuid, res, Object.keys(patch)).catch(() => {}),
        bumpWorkspace(wsId).catch(() => {}),
      ]);
    }));
  }
}

/**
 * Is the member still here after a path write under their card? A write
 * of one field of a card (a role, a renewed standing, a synced name) makes
 * a card where there is none: someone who left, or was shown the door,
 * between the caller's read of the workspace and its write came back as
 * that field alone, and a card is membership here. The departed member
 * opened the workspace again with no role at all (a plain member's
 * standing) or the very role just written, admin included, and someone
 * from a connected workspace an admin had removed walked back in past the
 * list that keeps them out. A stub holds the fields this write put there
 * and nothing else (`fields`), while a real card, whatever its age or
 * origin, holds more than any one write of these puts; one made of the
 * written fields alone is taken off again here. `res` is what the store
 * handed back from the write; a store that hands back nothing is read again.
 */
async function cardStands(wsId, uuid, res, fields) {
  const answered = !!(res && typeof res === 'object' && res.members);
  let doc = answered ? res : await kv().get(KEYS.ws(wsId));
  let card = own(doc?.members || {}, uuid);
  if (!card) return false;
  const written = new Set(fields);
  const whole = (c) => Object.keys(c).some((k) => !written.has(k));
  if (whole(card)) return true;
  // Decided on the document itself, never on the shape of an answer (see
  // enterChannel): an answer with nothing but the written fields on the
  // card may be the part that changed, and taken for the card it had every
  // change of role, every synced name and every renewal on such a store
  // take the member's card off. Read once more where the answer is all
  // there is; only a card of the written fields alone goes.
  if (answered) {
    doc = await kv().get(KEYS.ws(wsId));
    card = own(doc?.members || {}, uuid);
    if (!card) return false;
    if (whole(card)) return true;
  }
  await kv().remove(KEYS.ws(wsId), `members.${uuid}`).catch(() => {});
  return false;
}

/**
 * Is the channel still here after a path write under it? A counter or a
 * field written under a channel deleted between the caller's read of the
 * workspace and its write (someone joining or leaving the channel, or being
 * added to it, as it went) makes an entry of that field alone, as such a
 * write under a card does (see cardStands): a channel with no name, listed
 * to everyone, and open to posts from whoever's document still named it,
 * whose blocks then came back. A real channel carries its id, from the
 * moment it is made; an entry without one is the write's alone and is
 * taken off again. `res` is what the store handed back from the write; a
 * store that hands back nothing is read again. (loadWorkspace sweeps such
 * entries too, for the writes that do not look.)
 */
async function channelStands(wsId, ch, res) {
  const answered = !!(res && typeof res === 'object' && res.channels);
  let doc = answered ? res : await kv().get(KEYS.ws(wsId));
  let c = own(doc?.channels || {}, ch);
  if (c && typeof c.id === 'string') return true;
  // Decided on the document itself, never on the shape of an answer (see
  // enterChannel, cardStands): an answer with nothing but the counter on the
  // entry may be the part that changed, and taken for the entry it had every
  // join, leave and "add people" on such a store take the channel off the
  // workspace, history and all, and a channel made there taken off as it was
  // made. Read once more where the answer is all there is; only an entry the
  // workspace itself holds without an id goes.
  if (c && answered) {
    doc = await kv().get(KEYS.ws(wsId));
    c = own(doc?.channels || {}, ch);
    if (c && typeof c.id === 'string') return true;
  }
  if (c) await kv().remove(KEYS.ws(wsId), `channels.${ch}`).catch(() => {});
  return false;
}

/**
 * Is the workspace still here after a newcomer's card was written into it?
 * A card written under a workspace its owner deleted between the join's
 * read of it and the write (see cardStands, channelStands) makes a
 * document of the card alone where the workspace was: no name, no owner,
 * no channels, one member. The newcomer was told they had joined, their
 * list named a workspace with no name that nobody could delete (deleting
 * is the owner's, and it had none), and their next steps wrote a "joined"
 * line and a member document under it. A workspace carries its id from the
 * moment it is made; a document without one is the write's alone, and the
 * card comes off it again. `res` is what the store handed back from the
 * write; a store that hands back nothing is read again.
 */
async function workspaceStands(wsId, uuid, res) {
  const answered = !!(res && typeof res === 'object' && res.members);
  let doc = answered ? res : await kv().get(KEYS.ws(wsId));
  if (doc && typeof doc.id === 'string') return true;
  // Decided on the document itself, never on the shape of an answer (see
  // cardStands): an answer without the workspace's id on it may be the part
  // that changed, the card alone, and taken for the document it had every
  // join on such a store take the newcomer's card off again and answer that
  // the invite was not valid. Read once more where the answer is all there is.
  if (doc && answered) {
    doc = await kv().get(KEYS.ws(wsId));
    if (doc && typeof doc.id === 'string') return true;
  }
  if (doc) await kv().remove(KEYS.ws(wsId), `members.${uuid}`).catch(() => {});
  return false;
}

/* ------------------------------------------------------------------------ */
/* Workspaces and authorization                                              */
/* ------------------------------------------------------------------------ */

/** Whether a workspace id could name one here at all, judged without a read. */
const validWsId = (wsId) => /^[a-z0-9]{6,20}$/.test(String(wsId));

/**
 * A conversation id as this worker ever mints one (a channel's, a direct
 * message's, a thread's): enough to know a key built from it is safe to read
 * before the id has been resolved against the workspace.
 */
const looksLikeConvId = (conv) => /^[a-z0-9_]{1,64}$/.test(String(conv));

async function loadWorkspace(wsId) {
  if (!validWsId(wsId)) fail(404, 'not_found', 'Workspace not found');
  return normalizeWorkspace(wsId, await kv().get(KEYS.ws(wsId)));
}

/**
 * The workspace document as the routes use it, from what the store handed
 * back. Split out of loadWorkspace so a caller that read the document
 * itself — requireMembership reads it beside identify, rather than after it
 * — does not read it a second time to get the same tidying.
 */
async function normalizeWorkspace(wsId, ws) {
  if (!ws) fail(404, 'not_found', 'Workspace not found');
  ws.channels = ws.channels || {};
  ws.members = ws.members || {};
  // An entry with no id is no channel (see channelStands): a counter or a
  // field written under a channel deleted a moment before, by a request
  // that had read it standing (someone taken out of the workspace as it
  // went, a rule or a name changed, a share accepted). It is dropped from
  // the view here and taken off the document, so no bootstrap lists a
  // nameless channel and nothing is posted into one; one that lands while
  // this read is under way comes off at the next. Dropped from the view on
  // every copy (an export reads the workspace through here too, and the
  // import would make a channel of such an entry, named for its id); taken
  // off the document only where the copy takes writes: a copy that has
  // moved to another server is read-only from then on, one being moved
  // takes no writes for the length of the move, and one still being
  // imported is written from the archive alone (see assertWritable).
  const stubs = Object.entries(ws.channels).filter(([, c]) => !c || typeof c !== 'object' || typeof c.id !== 'string').map(([cid]) => cid);
  if (stubs.length) {
    for (const cid of stubs) delete ws.channels[cid];
    if (!ws.movedTo && !ws.importing && !frozen(ws)) await kv().remove(KEYS.ws(wsId), ...stubs.map((cid) => `channels.${cid}`)).catch(() => {});
  }
  // A private channel's list is appended to atomically (see addPrivateMember),
  // so two joins at once cannot lose each other; the one duplicate that can
  // arise from the same person joining twice at once is folded here.
  for (const c of Object.values(ws.channels)) if (Array.isArray(c.members) && new Set(c.members).size !== c.members.length) c.members = [...new Set(c.members)];
  return ws;
}

/**
 * Put people on a private channel's member list. An atomic append, not a
 * rewrite of the list read at the top of the request: two people accepting
 * the same invite at once (a link pasted in chat) each rewrote the list
 * they had read, and one of them was then in the channel (their own member
 * document says so) but off its list, so never mentioned, pushed, shown to
 * guests or counted, with nothing to repair it.
 */
async function addPrivateMember(wsId, ch, uuids) {
  const list = (Array.isArray(uuids) ? uuids : [uuids]).filter(Boolean);
  if (list.length) await kv().add(KEYS.ws(wsId), { [`channels.${ch}.members`]: list });
}

/**
 * Put a channel on a member's own document, the append that makes them a
 * member of it. The caller has read the document and found the channel
 * missing; two requests for the same person at once (a join from two tabs,
 * two admins adding them) both did, both appended, and both then counted
 * the person into the channel and announced them, so the channel counted
 * one person twice for good (leaving took one off). When the store hands
 * the document back, a second copy of the channel on it says this request
 * lost: the copy is taken off again and the caller treats the person as
 * already in.
 *
 * The document the store hands back is also where the caller learns that
 * the person is on their way out, or what they are being made, in the same
 * instant. Membership is two documents: the member's own, which the append
 * claims, and the workspace's, which carries their card and every channel's
 * count. Taking someone out of the workspace reads their document, counts
 * them out of each channel on it, and deletes it; an append landing after
 * that read and before the deletion was counted in by its caller and out by
 * nobody, so the channel counted a person no longer here, for good, and one
 * landing after the deletion made a document of the channel alone under
 * someone gone. So the removal closes the document first, with a stamp
 * (`gone`) whose write hands back the very list it then counts from (see
 * DELETE /api/ws/:ws/members/:uuid): an append that finds the stamp is one
 * the removal did not see, and answers 'gone', counting nothing; one that
 * does not is on the removal's list, and both count. A document that had a
 * `joinedAt` when the caller read it (`doc`) and has none now was deleted in
 * between, and this append made one of the channel alone: it goes again,
 * and the answer is 'gone'. A stamp older than a delivery's hold is a
 * removal that died, and is no longer one.
 *
 * Likewise a change of role, which decides whether the person is counted
 * among a channel's guests: it is written on the member's document before
 * the card (see the role route), and the document handed back here says
 * what they are as of this append (`role`), which the caller counts by
 * where the document says nothing (a document from before roles were kept
 * there), the card as the caller read it decides, as before.
 *
 * Returns { status, role }: 'entered' when this call put them in, 'already'
 * when another request for the same person did, 'gone' as above.
 */
async function enterChannel(wsId, uuid, ch, doc = null) {
  const key = KEYS.member(wsId, uuid);
  const existed = Number.isFinite(doc?.joinedAt);
  let res;
  try {
    res = await kv().add(key, { channels: [ch] });
  } catch (e) {
    // A store that refuses add on a missing key (see appendToBlock): someone
    // new here has no document yet, and it is written whole, as before the
    // claim; a document that is there means the refusal was something else,
    // and one that was there when the caller read it has been deleted since.
    if (await kv().get(key)) throw e;
    if (existed) return { status: 'gone', role: null };
    await kv().set(key, { channels: [ch] });
    return { status: 'entered', role: null };
  }
  // What the store handed back is the member's document only where it looks
  // like one, their channels on it (as cardStands and the other claims trust
  // an answer only where the field they need is there); any other answer
  // (the list alone, the part that changed, a count, nothing) has the
  // document read again.
  const looksLikeDoc = (d) => !!d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.channels);
  let after = looksLikeDoc(res) ? res : await kv().get(key).catch(() => undefined);
  const answered = after === res;
  if (after === null) return { status: existed ? 'gone' : 'entered', role: null };
  if (!looksLikeDoc(after)) return { status: 'entered', role: null };
  if (existed && !Object.hasOwn(after, 'joinedAt')) {
    // Deleted between the caller's read and this append, and made again of
    // the channel alone by it? Decided on the document itself, never on the
    // shape of an answer: an answer that was the part that changed, with
    // nothing of the member's on it, read as a document deleted meanwhile,
    // and every join on such a store deleted the joiner's document (their
    // direct messages, cursors and settings with it) and refused the join.
    // Read once more where the answer is all there is; only a document with
    // nothing of the member's on it goes.
    const fresh = answered ? await kv().get(key).catch(() => undefined) : after;
    if (fresh === null) return { status: 'gone', role: null };
    if (!looksLikeDoc(fresh)) return { status: 'entered', role: null };
    if (!Object.hasOwn(fresh, 'joinedAt')) {
      await kv().del(key).catch(() => {});
      return { status: 'gone', role: typeof fresh.role === 'string' ? fresh.role : null };
    }
    after = fresh;
  }
  const role = typeof after.role === 'string' ? after.role : null;
  const list = after.channels;
  const lost = list.filter((c) => c === ch).length >= 2;
  if (typeof after.gone === 'number' && after.gone + SCHED_CLAIM_MS > now()) {
    if (!lost) await kv().update(key, { channels: list.filter((c) => c !== ch) }).catch(() => {});
    return { status: 'gone', role };
  }
  if (!lost) return { status: 'entered', role };
  await kv().update(key, { channels: list.filter((c, i) => c !== ch || list.indexOf(ch) === i) }).catch(() => {});
  return { status: 'already', role };
}

/**
 * Close a member's document before they are counted out of their channels:
 * the stamp's write hands back the list as it stands at that instant, which
 * is the list the caller counts from (see enterChannel), so a channel
 * appended after it is counted by nobody and one appended before it is
 * counted out as it was counted in. A store that hands nothing back is read
 * again (an append landing between the two is then counted out and not in,
 * a window the store's own answer closes).
 */
async function closeMemberDoc(wsId, uuid) {
  const key = KEYS.member(wsId, uuid);
  // The claim a newcomer's join took on writing the document goes with the
  // closing (see /api/join): a removal that dies after this leaves the
  // document behind, and someone joining again must be able to claim it anew.
  const res = await kv().update(key, { gone: now(), jc: 0 }).catch(() => null);
  // The answer is the document only with the member's channels on it (see
  // enterChannel): one that was the stamp alone, the part that changed, would
  // have counted them out of no channel at all.
  if (res && typeof res === 'object' && !Array.isArray(res) && Object.hasOwn(res, 'gone') && Array.isArray(res.channels)) return res;
  return (await kv().get(key)) || {};
}

/**
 * Write a member's new role on their own document ahead of their card (see
 * enterChannel, and the role route), and hand back the document as the
 * store returned it, or as read again where the store returns nothing: the
 * list of channels on it is the one the caller counts by.
 */
async function writeDocRole(wsId, uuid, role) {
  const key = KEYS.member(wsId, uuid);
  const snap = await kv().update(key, { role });
  return snap && typeof snap === 'object' && Array.isArray(snap.channels) ? snap : (await kv().get(key)) || {};
}

/**
 * A member's own document as it stands after a write to it: the write's
 * answer where that is the document, their channels on it, and the document
 * read again where it is not (the part that changed, a count, nothing).
 * What the caller reads off it is what landed on the document ahead of the
 * card, as of its own write: the role a change of role put there (see
 * writeDocRole, and enterChannel, which reads it off the append), and the
 * stamp a removal closed it with (see closeMemberDoc). Null where there is
 * no document to read (deleted since the write), undefined where the read
 * itself failed.
 */
async function memberDocAfter(wsId, uuid, res) {
  if (res && typeof res === 'object' && !Array.isArray(res) && Array.isArray(res.channels)) return res;
  return kv().get(KEYS.member(wsId, uuid)).catch(() => undefined);
}

/**
 * The role written ahead of a card that turned out to be gone (see
 * cardStands) is undone: a document the write made, of the role alone, is
 * one nobody had, and goes; one that was there is being deleted by whoever
 * took the card (a removal deletes the document after the card), and is
 * left to them, since a path removal of ours landing after their deletion
 * would make a document of nothing where theirs had been.
 */
async function unwriteDocRole(wsId, uuid, snap) {
  const key = KEYS.member(wsId, uuid);
  const doc = snap && typeof snap === 'object' ? snap : await kv().get(key).catch(() => null);
  if (doc && !Object.hasOwn(doc, 'joinedAt') && !Object.hasOwn(doc, 'channels')) await kv().del(key).catch(() => {});
}

/**
 * A role that landed on a member's document (`doc`, as that write handed it
 * back) but never on their card, the card taken between the two by a
 * removal (see cardStands): the removal closed the document after the role
 * was on it (closed before, it answers `gone` to the role's write, which
 * then writes nothing more) and counted them out of every channel on it as
 * what they were being made (see dropMembership), while the channels they
 * were in when the role landed had counted them in as what they were. Each
 * is made even here: counted among the guests once more where a member on
 * their way out was made a guest, counted out where a guest was made a
 * member. A channel entered since the role landed was counted in and out
 * alike, as what they were being made, and is not on `doc`.
 */
async function evenGuestCounts(ws, doc, from, to) {
  const delta = (to === 'guest' ? 1 : 0) - (from === 'guest' ? 1 : 0);
  if (!delta) return;
  await incrPaths(KEYS.ws(ws.id), Object.fromEntries((doc?.channels || []).filter((ch) => ws.channels[ch]).map((ch) => [`channels.${ch}.guests`, delta])));
}

/**
 * Someone entering a channel starts at its present: their cursor is set to
 * what stands there, and the count of mentions they carried for it goes
 * with the history behind that cursor. A member may be named in a public
 * channel they are not in (its messages are theirs to read, so a mention
 * there counts for them and lands in their Activity), and one who left a
 * channel keeps the count of what they had not read in it: entered caught
 * up, the channel's row and the rail badged that count over a cursor that
 * said nothing was waiting, until the channel was opened. `doc` is the
 * member's document as the caller read it; nothing is written when it
 * carried no count.
 */
const caughtUpMentions = (doc, ch) => (Number(doc?.mentions?.[ch]) > 0 ? { [`mentions.${ch}`]: 0 } : {});

/**
 * A workspace that was transferred stays here read-only: reads work so
 * nothing is lost while the move settles, writes answer 423 with the new
 * reference so clients can follow it. One still being imported is not open
 * either: its history is being written seq by seq from the archive, and a
 * write that lands a line in a conversation meanwhile (someone joining a
 * channel, a policy change) takes the very number the archive's next page
 * brings for a message of its own, which is then kept out for good.
 */
/**
 * How long a transfer freeze holds without renewal. The nominee's app sets
 * it before exporting this copy (POST /transfer/begin) and renews it while
 * the export and the import into the new copy run; completing or cancelling
 * lets go of it, and one whose export died lets go on its own, so nobody's
 * workspace is locked for good by a tab that closed. Everything written
 * here between the export and the completion existed only in a copy about
 * to be marked moved, and was lost to the move: a message posted, a channel
 * made, a pin, a reaction, a member joined.
 */
const TRANSFER_FREEZE_MS = 30 * 60_000;
const frozen = (ws) => !!(ws.transferring && typeof ws.transferring === 'object' && (Number(ws.transferring.at) || 0) + TRANSFER_FREEZE_MS > now());

/**
 * A copy that has moved takes no write at all, the member's own state
 * included (a thread followed, a message saved, a badge cleared, a cursor
 * moved): written into the copy left behind, as they used to be by the
 * routes that write during a freeze (see assertWritable's `write` callers
 * and the ones without it), the change was answered as done and never
 * reached the copy everyone moves to, so a thread followed in the moment
 * after the move was not followed there, and a message saved was not saved.
 * Refused, the app is told the workspace moved, as it is for a post.
 */
function assertNotMoved(ws) {
  if (ws.movedTo) fail(423, 'moved', `This workspace moved to ${ws.movedTo}; this copy is read-only`);
}

function assertWritable(ws, { moving = false } = {}) {
  assertNotMoved(ws);
  if (ws.importing) fail(409, 'importing', 'This workspace is still being imported; try again in a moment');
  // `moving`: the transfer's own routes, which run while the freeze stands.
  if (!moving && frozen(ws)) fail(423, 'transferring', 'This workspace is being moved to another server; try again in a few minutes');
}

/**
 * Who is calling, the workspace, and the caller's own document — in one
 * round of calls where the caller is already known, and two where they are
 * not.
 *
 * Every key a route wants is either the workspace's or the caller's, and the
 * caller's needs their uuid. Where that is already in hand — a uuid passed
 * in, or an identity still good from a moment ago (see peekIdentity) — all
 * of them go in a single batched read: the workspace, the caller's document,
 * and whatever else the route asked for (`also`, answered as `extra`).
 *
 * Where it is not, asking Puter is an HTTP call of its own, so it runs
 * beside the workspace read rather than in front of it, and only the
 * caller's own keys wait on it. Done one after another, as it used to be,
 * every request here began with three round trips before it looked at
 * anything.
 *
 * Nothing is read for a request carrying no session at all: identify refuses
 * that without a call of its own, and starting the workspace read beside it
 * would have every unauthenticated request cost the owner a read.
 */
async function requireMembership(wsId, who, { write = false, lapsed = false, doc: withDoc = true, also = null } = {}) {
  const known = typeof who === 'string' ? { uuid: who } : null;
  // Who is asking comes first, so a caller with no session is told that
  // rather than whether a workspace of this name is here.
  if (!validWsId(wsId)) {
    if (!known) await identify(who);
    fail(404, 'not_found', 'Workspace not found');
  }
  const keysOf = (id) => (typeof also === 'function' ? (also(id) || []) : (also ? [...also] : []));
  const ready = known || (await peekIdentity(who));
  let id = ready;
  let wsRaw;
  let read = [];
  if (ready) {
    const want = keysOf(ready);
    const mine = withDoc ? [KEYS.member(wsId, ready.uuid)] : [];
    [wsRaw, ...read] = await getMany([KEYS.ws(wsId), ...mine, ...want]);
  } else {
    const [idRes, wsRes] = await Promise.allSettled([
      identify(who),
      who?.puter ? kv().get(KEYS.ws(wsId)) : null,
    ]);
    // Answered in the order the request would have met them: who is asking,
    // and only then whether there is anything here to ask about.
    if (idRes.status === 'rejected') throw idRes.reason;
    if (wsRes.status === 'rejected') throw wsRes.reason;
    id = idRes.value;
    wsRaw = wsRes.value;
  }
  const ws = await normalizeWorkspace(wsId, wsRaw);
  const member = ws.members[id.uuid];
  if (!member) fail(403, 'forbidden', 'You are not a member of this workspace');
  // `lapsed` admits an external member whose standing has run out: the
  // routes that take them out of the channel or the workspace, which need
  // no word from their own workspace and leave nothing behind for the day
  // an unrenewed seat would otherwise linger.
  if (!lapsed) assertAttested(member);
  if (write) assertWritable(ws);
  if (!ready) {
    // `doc: false` for a route that reads nothing of the caller's own
    // document (a setting changed, a role given, a member removed, a device
    // unsubscribed): the card is what says they are here and what they are,
    // and the document was read for every request all the same, a round trip
    // to the store that nothing on those routes looked at.
    const want = keysOf(id);
    read = withDoc || want.length
      ? await getMany([...(withDoc ? [KEYS.member(wsId, id.uuid)] : []), ...want])
      : [];
  }
  const extra = withDoc ? read.slice(1) : read;
  if (!withDoc) return { id, uuid: id.uuid, ws, member, doc: null, extra };
  const doc = read[0] || {};
  doc.channels = Array.isArray(doc.channels) ? doc.channels : [];
  doc.dms = doc.dms || {};
  doc.reads = doc.reads || {};
  doc.mentions = doc.mentions || {};
  doc.notify = doc.notify || {};
  doc.threads = doc.threads || {};
  doc.inbox = doc.inbox || 0;
  return { id, uuid: id.uuid, ws, member, doc, extra };
}

/**
 * An external member's standing here is what their own workspace last
 * vouched for; past that, every route answers `reattest` and their client
 * asks its own worker for a fresh attestation (see /api/connect/join).
 */
function assertAttested(member) {
  if (isExternal(member) && (Number(member.exp) || 0) < now()) fail(403, 'reattest', 'Your access to this shared channel needs renewing');
}

/**
 * What conversation is this id, and may the caller read or post to it?
 * Threads resolve through their parent. Public channels are readable by any
 * workspace member (preview), but posting needs membership, and a channel
 * may limit posting to admins (postPolicy) and replies to admins or nobody
 * (threadPolicy); `deny` names the reason posting is refused.
 */
function resolveConv(ctx, convId) {
  const thread = parentOfThread(convId);
  if (thread) {
    // One spelling per thread: a padded number ("_t003") or a thread of a
    // thread would count replies on the real root while keeping them in a
    // conversation nobody reads, and mint keys for every variant.
    if (thread.seq < 1 || threadConvId(thread.conv, thread.seq) !== convId || parentOfThread(thread.conv)) fail(404, 'not_found', 'Conversation not found');
    const base = resolveConv(ctx, thread.conv);
    let canPost = base.canRead && base.joined && !base.channel?.archived;
    let deny = base.channel?.archived ? 'archived' : !base.joined ? 'not_joined' : null;
    const policy = base.channel?.threadPolicy || 'everyone';
    if (canPost && policy === 'off') {
      canPost = false;
      deny = 'threads_off';
    } else if (canPost && policy === 'admins' && !isAdmin(ctx.member)) {
      canPost = false;
      deny = 'threads_admins';
    }
    return { ...base, kind: 'thread', id: convId, parent: thread, base, canPost, deny };
  }
  const { ws, doc } = ctx;
  const channel = own(ws.channels, convId);
  if (channel) {
    // A shared channel's messages live on its host: nothing is read or
    // written under the entry that stands for it here.
    if (isPartnerEntry(channel)) fail(404, 'shared_elsewhere', 'This channel lives on another workspace');
    const joined = doc.channels.includes(convId);
    if ((channel.private || isLimited(ctx.member)) && !joined) fail(404, 'not_found', 'Conversation not found');
    const adminsOnly = channel.postPolicy === 'admins' && !isAdmin(ctx.member);
    return {
      kind: 'channel', id: convId, channel, joined,
      canRead: true,
      canPost: joined && !channel.archived && !adminsOnly,
      deny: channel.archived ? 'archived' : !joined ? 'not_joined' : adminsOnly ? 'read_only' : null,
    };
  }
  const dm = own(doc.dms, convId);
  if (dm) return { kind: 'dm', id: convId, dm, joined: true, canRead: true, canPost: true };
  fail(404, 'not_found', 'Conversation not found');
}

/**
 * The stamps only order: a poller refetches when the one it is told is
 * greater than the one it holds. Counting up from the time the document was
 * created (rather than writing the clock) makes every bump visible — two in
 * one millisecond, or one landing in the millisecond a client read the
 * document, used to leave the stamp where it was, and the change unseen
 * until the next.
 */
async function bumpWorkspace(wsId) {
  await kv().incr(KEYS.activity(wsId), { w: 1 });
  await signal(wsId, null);
}

/** Tell one member (through the activity doc) that their own state changed. */
async function pokeMember(wsId, uuid) {
  await kv().incr(KEYS.activity(wsId), { [`u.${uuid}`]: 1 });
  await signal(wsId, [uuid]);
}

/**
 * Who could care that a conversation changed, for the signal that goes with
 * it (see worker/signal.js): null for a public channel (anyone might be
 * reading it, so every shard gets it), a private channel's member list, or a
 * direct message's members. `conv` is a resolveConv(...) result; a thread's
 * spreads its parent's `channel` or `dm` in already (resolveConv), so it
 * needs no case of its own.
 */
function audienceOf(conv) {
  if (conv.channel) return conv.channel.private ? (conv.channel.members || []) : null;
  if (conv.dm) return conv.dm.members || [];
  return null;
}

/**
 * A conversation's activity stamp for a write that changes what it shows
 * without adding a message: an edit, a delete, a reaction, a pin, an
 * unfurl. `extra` carries whatever other path the same write touches (a pin
 * count, say), landed in the same call; `audience` is who should be signalled
 * for it (see audienceOf), null reaching the whole workspace.
 */
async function touchConv(wsId, convId, ts, { audience = null, extra = {}, defer = null, ws = null, seq = null, patch = null } = {}) {
  await kv().update(KEYS.activity(wsId), { [`c.${convId}.x`]: ts, ...extra });
  // The ring entry carries the new stamp (and any other field of this
  // conversation's entry `extra` set, a pin count) and, with `patch`, the
  // change to message `seq` itself (see applyOverlayPatch); without one, a
  // reader holding the window re-reads it, as on a poll.
  const a = { x: ts };
  const prefix = `c.${convId}.`;
  for (const [path, v] of Object.entries(extra)) if (path.startsWith(prefix) && !path.slice(prefix.length).includes('.')) a[path.slice(prefix.length)] = v;
  const entry = { conv: convId, body: patch && Number.isInteger(seq) ? { a, s: seq, p: patch } : { a }, slim: { a } };
  // The signal goes last either way (the write it announces has landed);
  // with a request's `defer` it goes behind the answer as well, since the
  // caller has no use for it and only waited on the round trip.
  if (defer) defer(() => signal(wsId, audience, { entries: [entry], ws }));
  else await signal(wsId, audience, { entries: [entry], ws });
}

/**
 * Both at once, in the one write the store takes a map of paths for: a
 * member whose own state changed in a way everyone sees (a role given, a
 * channel entered), whose tabs refetch their document and everyone's the
 * workspace. Written one after the other, as they used to be, every change
 * of role and every entry by a channel's link cost a round trip more.
 */
async function pokeAndBump(wsId, uuid) {
  await kv().incr(KEYS.activity(wsId), { [`u.${uuid}`]: 1, w: 1 });
  await signal(wsId, null);
}

/**
 * Move many counters (or set many fields) on one document in a few writes,
 * fifty paths a write as notifyMentions pokes, rather than one write per
 * path. A member's channels are counted out, or among the guests, on the
 * workspace document one channel at a time, and a member in many channels
 * cost one round trip per channel (two, for a private one, whose list is
 * rewritten): past a few hundred the request ran longer than the platform
 * lets one run, and a removal died between closing the member's document
 * and taking their card. A write that fails is let go of, as each single
 * one was.
 */
async function incrPaths(key, paths) {
  const entries = Object.entries(paths);
  for (let i = 0; i < entries.length; i += 50) await kv().incr(key, Object.fromEntries(entries.slice(i, i + 50))).catch(() => {});
}
async function updatePaths(key, paths) {
  const entries = Object.entries(paths);
  for (let i = 0; i < entries.length; i += 50) await kv().update(key, Object.fromEntries(entries.slice(i, i + 50))).catch(() => {});
}

/**
 * Take someone's traces out of the activity document when they leave the
 * workspace: their last heartbeat and status (sent to every member with
 * each bootstrap, for a person no longer here), the stamp their own polls
 * watched (one number per person who ever left, otherwise kept for good),
 * their seat in any huddle, and their typing in any conversation. The seat
 * used to stay until it lapsed, a minute and a half on: the roster kept
 * naming someone shown the door, every tab in the call went on dialling
 * their peer, and a huddle they had been alone in stood "in progress" with
 * nobody in it until then. One read of the document, on a route that is rare.
 *
 * With `conv`, only what they had in that conversation and its threads (a
 * seat, a typing entry): someone leaving a channel, or taken out of it,
 * stays in the workspace, heartbeat and all, but the seat they had in its
 * huddle is not theirs to keep for the minute and a half it would lapse in.
 *
 * `who` is one person or a list of them (a partner workspace's people all
 * going at once, see disconnect): the document is read once for all of
 * them, and their paths go a hundred a write.
 */
async function dropPresence(wsId, who, conv = null) {
  const key = KEYS.activity(wsId);
  const uuids = Array.isArray(who) ? who : [who];
  if (!uuids.length) return;
  const within = (c) => !conv || c === conv || parentOfThread(c)?.conv === conv;
  const paths = conv ? [] : uuids.flatMap((uuid) => [`p.${uuid}`, `ps.${uuid}`, `u.${uuid}`]);
  const act = (await kv().get(key).catch(() => null)) || {};
  for (const [c, h] of Object.entries(act.h || {})) if (within(c) && h?.m) for (const uuid of uuids) if (Object.hasOwn(h.m, uuid)) paths.push(`h.${c}.m.${uuid}`);
  for (const [c, t] of Object.entries(act.t || {})) if (within(c) && t) for (const uuid of uuids) if (Object.hasOwn(t, uuid)) paths.push(`t.${c}.${uuid}`);
  // Each path its own argument, as the store's remove takes them (see
  // dev/worker-runtime.js, strictPaths): handed one array, puter.js refuses
  // the call before it leaves the worker, and every removal here, and at
  // every other fan-out below, failed quietly under its catch.
  for (let i = 0; i < paths.length; i += 100) await kv().remove(key, ...paths.slice(i, i + 100)).catch(() => {});
}

/**
 * Mint an invite for a workspace: the code document carries its own expiry
 * and the key is also given a TTL, so a stale code disappears on its own
 * and, until it does, is refused by the timestamp check.
 */
async function issueInvite(wsId, ttlKey = DEFAULT_INVITE_TTL, scope = null, role = 'guest') {
  // Own entries only: "constructor" is not a duration, and must not mint a code that never expires.
  const ttl = Object.hasOwn(INVITE_TTLS, ttlKey) ? INVITE_TTLS[ttlKey] : INVITE_TTLS[DEFAULT_INVITE_TTL];
  const code = inviteCode();
  const exp = now() + ttl.seconds * 1000;
  // A channel-scoped code carries the channel and what accepting it means:
  // joining as a guest, or connecting another workspace to the channel. The
  // same document shape, TTL, and brute-force budget as a workspace invite.
  await kv().set(KEYS.invite(code), scope ? { ws: wsId, ch: scope, role, exp } : { ws: wsId, exp });
  await kv().expire(KEYS.invite(code), ttl.seconds).catch(() => {});
  return { code, exp };
}

/**
 * Members a guest may see: everyone in a channel they are in, and the
 * people in their direct messages. Private channels carry their list;
 * public ones cost one member-document read per workspace member, the same
 * as listing a channel's members, once per bootstrap of a guest. A direct
 * message names nobody new: it was made while the two shared a channel
 * (see POST /dms), and it stays theirs when they no longer do, so the
 * person on the other side kept their card, presence and photo in it (they
 * used to turn into "Former member" in a conversation they were still in,
 * and the app, finding their card gone, would not open it from their side).
 * Who a guest may write to is judged by the same set (see POST /dms).
 */
async function peersOf(ws, doc, readDocs = memberDocsReader(ws)) {
  const peers = new Set();
  const publics = [];
  for (const cid of doc.channels) {
    const ch = ws.channels[cid];
    if (!ch) continue;
    if (ch.private) (ch.members || []).forEach((u) => peers.add(u));
    else publics.push(cid);
  }
  for (const dm of Object.values(doc.dms || {})) for (const u of dm?.members || []) if (own(ws.members, u)) peers.add(u);
  if (publics.length) {
    for (const [u, d] of await readDocs()) if ((d?.channels || []).some((c) => publics.includes(c))) peers.add(u);
  }
  return peers;
}

/**
 * Every member's document (the first 500), read once and handed to whoever
 * asks again within the request: a map by uuid, loaded on the first ask.
 * Who is in a public channel is answered from these (see peersOf), and a
 * request that asks the question for several people (a group message
 * naming several guests, or people from a connected workspace; see POST
 * /dms) used to read every document again for each of them, five hundred
 * reads a person.
 */
function memberDocsReader(ws, seed = null) {
  let pending = null;
  return () => {
    if (!pending) {
      const ids = Object.keys(ws.members).slice(0, 500);
      // The caller's own document, read at the top of every request (see
      // requireMembership), is handed in (`seed`) rather than read again:
      // every guest's bootstrap and every direct message a guest opened
      // read it twice.
      const others = ids.filter((u) => !seed || u !== seed.uuid);
      pending = getMany(others.map((u) => KEYS.member(ws.id, u))).then((docs) => {
        const read = new Map(others.map((u, i) => [u, docs[i]]));
        return new Map(ids.map((u) => [u, seed && u === seed.uuid ? seed.doc : read.get(u)]));
      });
    }
    return pending;
  };
}

/**
 * Member documents as one request reads them, each read once however many
 * times it is asked for: `docs(uuids)` answers in order, reading only what
 * has not been read yet. A post asks the same question of the same
 * documents several times over (who of those named may read here, who is
 * in the channel a broadcast reaches, who of them may hear of it, who has
 * asked for a push; see readersAmong, broadcastTargets and sendPushes),
 * and used to read a guest's document for each question and every push
 * target's once more after the write: a broadcast in a public channel of
 * five hundred read well past five hundred documents where one reading of
 * each would do. Kept on the request's context (`ctx.docs`) by postMessage;
 * a caller without one reads as before.
 */
function memberDocsMemo(wsId, seed = null) {
  const cache = new Map();
  // The caller's own document, read at the top of the request (see
  // requireMembership), is in the memo from the start: a broadcast in a
  // public channel reads every member's document for who is in the channel,
  // the author's among them, and read the author's a second time for it.
  if (seed && typeof seed.uuid === 'string' && seed.doc) cache.set(seed.uuid, seed.doc);
  return async (uuids) => {
    const missing = [...new Set(uuids.filter((u) => !cache.has(u)))];
    if (missing.length) {
      const docs = await getMany(missing.map((u) => KEYS.member(wsId, u)));
      missing.forEach((u, i) => cache.set(u, docs[i]));
    }
    return uuids.map((u) => cache.get(u));
  };
}

/** The member documents of `uuids`, through the request's memo where it has one (see memberDocsMemo). */
const docsOf = (ctx, uuids) => (typeof ctx.docs === 'function' ? ctx.docs(uuids) : getMany(uuids.map((u) => KEYS.member(ctx.ws.id, u))));

/**
 * What a member may see in the activity document by their own document: the
 * channels they are in, their direct messages, and the threads inside
 * either. The bootstrap and the sync poll filter a guest's whole view with
 * this, so a guest never learns that a channel they are not in moved, and so
 * a reply in their own direct message's thread does reach them; and they
 * filter everyone's huddles with it, since a roster names who is in a call
 * and the invite code each of them serves.
 */
function memberVisible(doc) {
  const channels = Array.isArray(doc.channels) ? doc.channels : [];
  const dms = doc.dms || {};
  return (conv) => {
    const thread = parentOfThread(conv);
    const base = thread ? thread.conv : conv;
    return channels.includes(base) || !!own(dms, base);
  };
}

/** A conversation (or a thread of one) that is a public channel of the workspace: any member may browse it. */
function isPublicChannel(ws, conv) {
  const thread = parentOfThread(conv);
  const ch = own(ws.channels || {}, thread ? thread.conv : conv);
  return !!ch && !ch.private;
}

/**
 * Brute-force guard for invite codes. Each account gets a small budget of
 * failed guesses per window; over it, the route answers 429 before any
 * lookup, so guessing stops costing the owner KV reads. Successful joins
 * never count.
 */
const joinFailKey = (uuid) => `tc:joinfail:${uuid}`;

async function assertJoinBudget(uuid) {
  const fails = Number(await kv().get(joinFailKey(uuid))) || 0;
  if (fails >= LIMITS.joinAttempts) {
    fail(429, 'too_many_attempts', 'Too many invite attempts. Try again in a few minutes');
  }
}

async function noteJoinFailure(uuid) {
  // Re-arm the TTL on every failure, not only the first. If the single expire
  // on the first failure were lost to a transient store error, the counter
  // would keep climbing with no TTL and lock the account out of every join,
  // connect-preview and connect-accept on this worker for good, with no route
  // to clear it. Setting it each time also measures the window from the last
  // attempt, and costs nothing extra once the account is over budget (that
  // path answers 429 before reaching here).
  await kv().incr(joinFailKey(uuid)).catch(() => {});
  await kv().expire(joinFailKey(uuid), LIMITS.joinWindowSeconds).catch(() => {});
}

async function createWorkspaceFor(profile, name) {
  const wsId = uid(10);
  const generalId = uid(10);
  const { code, exp } = await issueInvite(wsId);
  const ts = now();
  const ws = {
    id: wsId,
    name,
    owner: profile.uuid,
    invite: code,
    inviteExp: exp,
    createdAt: ts,
    search: indexStamp(),
    channels: {
      [generalId]: {
        id: generalId, name: 'general', topic: 'Company-wide announcements and conversation',
        private: false, def: true, createdBy: profile.uuid, createdAt: ts, count: 1,
      },
    },
    members: { [profile.uuid]: memberRecord(profile, 'owner') },
  };
  await Promise.all([
    kv().set(KEYS.ws(wsId), ws),
    kv().set(KEYS.activity(wsId), { c: {}, p: {}, u: {}, w: ts }),
    kv().set(KEYS.member(wsId, profile.uuid), {
      channels: [generalId], dms: {}, reads: {}, mentions: {}, joinedAt: ts,
    }),
    kv().set(KEYS.block(generalId, 0), { m: [], x: {} }),
  ]);
  await postSystem(wsId, generalId, profile.uuid, `${profile.name || profile.username} created #general`);
  await kv().add(KEYS.user(profile.uuid), { workspaces: [wsId] });
  return ws;
}

/* ------------------------------------------------------------------------ */
/* Messages                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Append a message and note it in the activity document: the conversation's
 * newest seq, when, and who wrote it (`by`, the author unless the line was
 * written for the author rather than by them: a reminder that came due
 * carries their uuid so it draws as theirs, but the clients take a line
 * whose author is the reader for one they sent from another tab, read as
 * it was written, and it is not that; stamped `sys`, it reaches them as
 * news, unread, the way the worker holds it).
 *
 * `before(seq)` runs once the message has its number and before it is
 * appended or announced: the counters a reader's cursor is judged against
 * (a mention counted on the conversation, a reply counted on the thread; see
 * the read route) go on there. Counted after the announcement, as they used
 * to be, a reader who saw the message at once and read it before the count
 * landed cleared nothing, and the count then stood on a conversation read
 * to its end; counted before the number is taken, a stale read of the
 * message before this one, landing between the two, would clear a count for
 * a message the reader has not seen. In between, neither: a read of this
 * message cannot come before the count, and a read of the one before it
 * falls short of the number the count is judged against.
 */
async function writeMessage(wsId, conv, msg, { by = msg.u, before = null, scheduled = false, audience = null, signal: doSignal = true, alongside = null, ws = null, entries = null } = {}) {
  let seq = await kv().incr(KEYS.seq(conv));
  msg.s = seq;
  if (before) await before(seq);
  let n = blockIndexOf(seq);
  let written;
  // A block closed here notes its unused numbers on the entry (`k`), which
  // no ring entry carries: the message then goes out as a plain signal.
  let rolled = false;
  try {
    written = await appendToBlock(conv, n, msg);
  } catch (err) {
    // The block would not take the message (a block grown past what the
    // store holds, from before blocks were closed early; see rollBlock):
    // the number is left unused, as a deleted message's is, the block is
    // closed, and the message takes the first number of the next block.
    // Given up as it used to be, the message was counted and never stored
    // (its number a hole every reader passed over as a deleted message), the
    // sender told it had failed, and every post into the conversation
    // failed the same way until the numbers ran into the next block. The
    // number given up is the first of the run the block is closed with.
    await rollBlock(wsId, conv, n, seq);
    rolled = true;
    seq = await kv().incr(KEYS.seq(conv));
    if (blockIndexOf(seq) === n) throw err;
    msg.s = seq;
    n = blockIndexOf(seq);
    written = await appendToBlock(conv, n, msg);
  }
  // Create the next block while this one is still filling, so the append
  // there never has to fall back to a read-modify-write. It waits on nothing
  // the conversation's stamp waits on, so the two go together (see `tail`).
  const tail = isFirstInBlock(seq) ? [ensureBlock(conv, n + 1)] : [];
  // Stamped with the moment it is written, not the message's own time: a
  // poll delivers an entry stamped after the `since` it carries, which is
  // two seconds before its last read, and the message's time is taken before
  // its counters go on (see `before`), which for a broadcast in a large
  // channel runs for seconds. Stamped with the message's time, an entry
  // written that late was already behind the `since` of a tab that had
  // polled meanwhile, and that tab was not told of the message until the
  // conversation next changed for some other reason.
  //
  // A message delivered from the queue at its time (`scheduled`) is marked
  // on the entry (`q`, the number of the newest such message): the author's
  // own tabs read the entry for who wrote last, and take a message of their
  // own for one sent from another tab of theirs, read as it was written (see
  // postMessage, which moves the cursor so for a live post). One delivered
  // from the queue is not that, and the mark lets them tell the two apart;
  // an older mark left by an earlier delivery names a number below the
  // entry's, and says nothing about the message that stands.
  const stamp = { s: seq, t: now(), u: by, ...(scheduled ? { q: seq } : {}) };
  tail.push(kv().update(KEYS.activity(wsId), Object.fromEntries(Object.entries(stamp).map(([f, v]) => [`c.${conv}.${f}`, v]))));
  // A block grown past its budget with this message is closed behind it
  // (see rollBlock): the next message opens the next block. It touches the
  // counter and its own path on the activity document, neither of which the
  // stamp above touches, so it goes beside it rather than after it.
  if (Number(written?.bytes) > BLOCK_BYTES) {
    rolled = true;
    tail.push(rollBlock(wsId, conv, n).catch(() => {}));
  }
  // Whatever the caller has to write about the message now that it is stored
  // and has its number: it goes beside the conversation's stamp rather than
  // after it. A post's own read cursor is the case this exists for — its
  // document is not the activity document, and neither write feeds the other,
  // so waiting for one before making the other was a round trip for nothing.
  if (alongside) tail.push(alongside(seq));
  await Promise.all(tail);
  // Every write here signals by default (audience null reaches the whole
  // workspace, which is always a safe superset): a plain system line — a
  // "joined" line, a huddle's own start/end line, any of the other sixteen
  // postSystem call sites — must wake a subscriber same as a live message
  // does, not only a caller that happens to compute a narrower audience.
  // postMessage passes signal: false and does its own, single signal once
  // everything else the post touches is written (see postMessage), so this
  // write is not left uncovered, only covered later and once.
  //
  // The ring entry carries the message as stored and the stamp above, so a
  // client reading ring entries lays it in without a request; `entries`
  // collects it instead for a caller that signals on its own.
  const entry = rolled ? null : { conv, body: { a: stamp, m: msg }, slim: { a: stamp } };
  if (entries) entries.push(entry);
  if (doSignal) await signal(wsId, audience, { entries: [entry], ws });
  return seq;
}

/**
 * Close block `n` of a conversation early: the counter is moved to the
 * block's last number, so the next message takes the first number of the
 * next block (made ahead when this one opened, see writeMessage), and the
 * numbers between stand for no message, as a run of deleted messages does.
 * Every reader finds a message by its number as before (the block a number
 * lives in is arithmetic, see blockIndexOf), and a page, an export, a
 * rebuild of the search index and a deletion walk the blocks by the counter
 * and pass over what is not there.
 *
 * Why: the store holds a value of 400 KB at most, and a block of fifty
 * messages can grow past that on its own (fifty of the longest texts, each
 * edited once, are 405 KB; a link card, five attachments and a few hundred
 * reactions on each far more; see BLOCK_BYTES). Past it, the append of the
 * next message failed after its number was taken (a hole every reader
 * passed over as a deleted message, the sender told the send had failed),
 * every post into the conversation failed the same way until the numbers
 * ran into the next block, and every edit, reaction, pin, deletion and
 * reply count on the block's fifty messages failed for good, since the
 * block could never shrink.
 *
 * Claimed on the block itself (`full`, an atomic count): two messages
 * landing over the budget in the same instant both come here, and only the
 * one that took the count from nothing moves the counter, so it is moved
 * once (moved by each, the counter would have run past the next block).
 * The counter is read back for the move, since messages may have landed
 * since; a post taking a number in the same instant may run the counter a
 * few past the block's end, which puts the next message a little into the
 * next block and no further.
 *
 * `from`: a number already taken that no message stands under (the one a
 * message that would not fit was given, see writeMessage): the run noted
 * below begins with it. Noted from the counter alone, as it used to be, the
 * run left that number out, and the reader's app counted it as one unread
 * message more than there was until the conversation was opened.
 */
async function rollBlock(wsId, conv, n, from = null) {
  const key = KEYS.block(conv, n);
  const res = await kv().incr(key, { full: 1 });
  const claims = res && typeof res === 'object' ? res.full : res;
  if (!(claims === 1 || claims == null)) return;
  const cur = Number(await kv().get(KEYS.seq(conv))) || 0;
  const last = lastSeqOfBlock(n);
  const start = from != null ? Math.min(from, cur + 1) : cur + 1;
  if (cur < last) await kv().incr(KEYS.seq(conv), last - cur);
  // The numbers left unused, noted on the conversation's activity entry
  // (`k`, the last such run) for every reader's unread count: the app counts
  // what is unread as the counter less the reader's cursor, so a block
  // closed with thirty-nine numbers to spare read as thirty-nine unread
  // messages in every direct message list and tab title until the
  // conversation was opened (see the store's unreadCount).
  if (start <= last) await kv().update(KEYS.activity(wsId), { [`c.${conv}.k`]: [start, last] }).catch(() => {});
}

/**
 * Refuse a write that would grow a message's block past what the store
 * holds (see BLOCK_BYTES_HARD): the member is told, where the store would
 * have refused the write with no word and left the block unable to take any
 * change at all. `growth` is the bytes the write adds; `words` what to say.
 */
function assertBlockRoom(block, growth, words) {
  if (jsonBytes(block || {}) + growth > BLOCK_BYTES_HARD) fail(400, 'limit', words);
}

/** Has a message's block room for a write that grows it by `growth` bytes (see assertBlockRoom)? */
const blockHasRoom = (block, growth) => jsonBytes(block || {}) + growth <= BLOCK_BYTES_HARD;

/**
 * A line the worker writes into a conversation, about `uuid` (who is drawn
 * as its subject). `by` is who the conversation's activity entry names as
 * the writer: the subject, where the line records their own act in a
 * conversation they are looking at (they joined, pinned, changed a rule;
 * their tabs then take the line as read, as they take a message of their
 * own sent from another tab, see the client's _foldActivity), and 'sys'
 * where the subject is not the one acting, or need not be looking (a huddle
 * that ended, a share accepted by another workspace's admin): named as the
 * writer of those, the subject's own tabs marked the conversation read to
 * the line, bold and count gone, over messages they had never seen.
 */
async function postSystem(wsId, conv, uuid, text, { by = uuid } = {}) {
  return writeMessage(wsId, conv, { u: uuid, t: text, ts: now(), k: 'sys' }, { by });
}

/** Find a message's raw record and its block key; null when absent. */
async function locateMessage(conv, seq) {
  if (!Number.isInteger(seq) || seq < 1) return null;
  return messageIn(conv, seq, await kv().get(KEYS.block(conv, blockIndexOf(seq))));
}

/**
 * The same, from a block a caller already has: the block a message lives in
 * is arithmetic from its number (see blockIndexOf), so a route whose path
 * names the number reads it with the caller's own document rather than after
 * it (see the edit route).
 */
function messageIn(conv, seq, block) {
  if (!Number.isInteger(seq) || seq < 1) return null;
  const key = KEYS.block(conv, blockIndexOf(seq));
  const raw = block?.m?.find((m) => m && m.s === seq) || null;
  return raw ? { key, block, raw, overlay: block.x?.[overlayKey(seq)] || {} } : null;
}

async function readRange(conv, fromSeq, toSeq) {
  if (toSeq < fromSeq) return [];
  const from = blockIndexOf(fromSeq);
  const to = blockIndexOf(toSeq);
  const keys = [];
  for (let n = from; n <= to; n++) keys.push(KEYS.block(conv, n));
  const blocks = await getMany(keys);
  return blocks.flatMap(mergeBlock).filter((m) => m.seq >= fromSeq && m.seq <= toSeq);
}

/**
 * Blocks one page read may go on past its own when they held nothing. A
 * deleted message is never returned, so a run of them longer than a page
 * answered an empty page with more to come; the client keys its next
 * request back on the oldest message it holds, which such a page brought
 * none of, and takes a forward page with nothing new for the end of its
 * walk, so what lay past the run was out of reach until a fresh load. A
 * run longer than this budget still answers empty: the cost of an answer
 * stays bounded.
 */
const SKIP_BLOCKS = 6;

/**
 * Three ways to read: the newest page (no params), older than a seq
 * (`before`), or newer than a seq (`after`). `from`/`to` re-reads a range
 * the client already shows, after an overlay change (edit, reaction).
 * Each answer costs one get for the counter plus one per block touched,
 * never a listing.
 */
async function fetchMessages(conv, q, head = undefined) {
  // `head` is the conversation's counter where the route read it beside the
  // caller's own document (see the messages route): keyed on the
  // conversation alone, it needs nothing this request has worked out.
  const seq = head === undefined ? Number(await kv().get(KEYS.seq(conv))) || 0 : Number(head) || 0;
  const num = (name) => (q.get(name) == null ? null : Math.max(0, Math.floor(Number(q.get(name)) || 0)));
  const after = num('after');
  const from = num('from');
  const to = num('to');
  const before = num('before');
  const maxBlocks = 3;

  if (from != null && to != null) {
    const hi = Math.min(to, seq, from + maxBlocks * BLOCK_SIZE - 1);
    return { seq, messages: await readRange(conv, Math.max(1, from), hi), hasMore: hi < Math.min(to, seq) };
  }
  if (after != null) {
    if (seq <= after) return { seq, messages: [], hasMore: false };
    let lo = after + 1;
    let hi = Math.min(seq, (blockIndexOf(lo) + maxBlocks) * BLOCK_SIZE);
    let messages = await readRange(conv, lo, hi);
    // A page of nothing but deleted messages reads on (see SKIP_BLOCKS).
    for (let extra = 0; !messages.length && hi < seq && extra < SKIP_BLOCKS; extra += maxBlocks) {
      lo = hi + 1;
      hi = Math.min(seq, (blockIndexOf(lo) + maxBlocks) * BLOCK_SIZE);
      messages = await readRange(conv, lo, hi);
    }
    return { seq, messages, hasMore: hi < seq };
  }
  // Held to the counter: a starting point past it (no client's is, a
  // window's oldest message being at or below the counter) named a block
  // that does not exist, read for nothing.
  const top = Math.min(before != null ? before - 1 : seq, seq);
  if (top < 1) return { seq, messages: [], hasMore: false };
  let n = blockIndexOf(top);
  // How many numbers the newest block holds at or below the window's top: a
  // block fills to BLOCK_SIZE, so this says up front whether the one before
  // it will be wanted too, and the two are then read together. Read one and
  // then the other, as it used to be, opening a conversation whose newest
  // block was less than half full — which is most of the time, and always
  // just after a block rolls — cost two round trips in a row for the page.
  // The count is an upper bound (a deleted message keeps its number but not
  // its place), so a page that still comes up short reads on below as before.
  const inTop = top - firstSeqOfBlock(n) + 1;
  let messages;
  if (inTop < BLOCK_SIZE / 2 && n > 0) {
    const [prev, cur] = await getMany([KEYS.block(conv, n - 1), KEYS.block(conv, n)]);
    n -= 1;
    messages = mergeBlock(prev).concat(mergeBlock(cur).filter((m) => m.seq <= top));
  } else {
    messages = mergeBlock(await kv().get(KEYS.block(conv, n))).filter((m) => m.seq <= top);
    if (messages.length < BLOCK_SIZE / 2 && n > 0) {
      n -= 1;
      messages = mergeBlock(await kv().get(KEYS.block(conv, n))).concat(messages);
    }
  }
  // Still nothing (the blocks held deleted messages alone): back, a block at a time (see SKIP_BLOCKS).
  for (let extra = 0; !messages.length && n > 0 && extra < SKIP_BLOCKS; extra++) {
    n -= 1;
    messages = mergeBlock(await kv().get(KEYS.block(conv, n)));
  }
  return { seq, messages, hasMore: n > 0 };
}

/** Resolve @username mentions to member uuids, capped. Reserved names are never people. */
function mentionUuids(ws, text) {
  const names = extractMentionNames(text).filter((n) => !BROADCASTS.includes(n));
  if (!names.length) return [];
  const byName = new Map(Object.entries(ws.members).map(([u, m]) => [String(m.username).toLowerCase(), u]));
  const out = [];
  for (const name of names) {
    const u = byName.get(name);
    if (u && !out.includes(u)) out.push(u);
    if (out.length >= LIMITS.mentionsPerMessage) break;
  }
  return out;
}

/**
 * Of `uuids`, those who may read this conversation: a direct message's or a
 * private channel's members, every non-guest member for a public channel,
 * and a guest only if they have joined it (one member-document read per
 * mentioned guest, which is rare). A mention of anyone else is just text:
 * it must not count against them, land in their inbox, or push them the
 * message, since none of that would ever be readable to them.
 */
async function readersAmong(ctx, conv, uuids) {
  const { ws } = ctx;
  const allowed = new Set();
  const guests = [];
  for (const u of uuids) {
    const m = ws.members[u];
    if (!m) continue;
    if (conv.dm) {
      if (conv.dm.members.includes(u)) allowed.add(u);
    } else if (conv.channel?.private) {
      if ((conv.channel.members || []).includes(u)) allowed.add(u);
    } else if (isLimited(m)) {
      guests.push(u);
    } else {
      allowed.add(u);
    }
  }
  if (guests.length) {
    const docs = await docsOf(ctx, guests);
    guests.forEach((u, i) => {
      if ((docs[i]?.channels || []).includes(conv.channel.id)) allowed.add(u);
    });
  }
  return uuids.filter((u) => allowed.has(u));
}

/** Who may broadcast in a channel: everyone by default, admins in a default channel. */
const broadcastPolicy = (channel) => channel.broadcast || (channel.def ? 'admins' : 'everyone');

/** Presence counts as "here" within this window, a little wider than the client's active dot. */
const HERE_WINDOW_MS = 5 * 60_000;

/**
 * Expand a broadcast into the uuids it reaches, minus the sender. @channel is
 * the conversation's members (a private channel's list, a DM's members, or
 * one member document read per workspace member for a public channel, the
 * same cost as listing its members), @here is those of them with a recent
 * heartbeat, and @everyone is the whole workspace. Bounded by the workspace
 * member cap; sample teammates are skipped since they have no counters.
 */
async function broadcastTargets(ctx, conv, kind) {
  const { ws, uuid } = ctx;
  const all = Object.keys(ws.members).slice(0, BROADCAST_FANOUT);
  let members;
  // A thread carries its parent's `dm` or `channel`, so a reply inside a
  // direct message resolves like the direct message itself.
  if (kind === 'everyone') members = all;
  else if (conv.dm) members = conv.dm.members;
  else if (conv.channel.private) members = conv.channel.members || [];
  else {
    const docs = await docsOf(ctx, all);
    members = all.filter((u, i) => (docs[i]?.channels || []).includes(conv.channel.id));
  }
  members = members.filter((u) => u !== uuid && ws.members[u] && !u.startsWith('smp_'));
  if (kind === 'here') {
    const act = (await kv().get(KEYS.activity(ws.id))) || {};
    const cutoff = now() - HERE_WINDOW_MS;
    // A heartbeat in the window, unless the tab behind it said it was closing.
    members = members.filter((u) => (act.p?.[u] || 0) >= cutoff && act.ps?.[u] !== 'off');
  }
  return members;
}

/**
 * Bump mention counters for many members at once: counters in parallel
 * batches, and a single activity write naming everyone poked (the update
 * takes a map of paths) rather than one write per person.
 */
async function notifyMentions(wsId, conv, uuids) {
  const targets = uuids.filter((u) => !u.startsWith('smp_'));
  const ts = now();
  // The counters and the poke that tells each of them to refetch touch
  // different documents, so they go together rather than one wave after the
  // other: a mention of one person used to cost two round trips in a row in
  // front of the message it is for.
  const writes = [];
  for (let i = 0; i < targets.length; i += 50) {
    const paths = Object.fromEntries(targets.slice(i, i + 50).map((u) => [`u.${u}`, ts]));
    writes.push(kv().update(KEYS.activity(wsId), paths).catch(() => {}));
  }
  for (let i = 0; i < targets.length; i += 12) {
    const slice = targets.slice(i, i + 12);
    writes.push(Promise.all(slice.map((u) => kv().incr(KEYS.member(wsId, u), { [`mentions.${conv}`]: 1 }).catch(() => {}))));
  }
  await Promise.all(writes);
  // No signal of its own: this only ever runs from postMessage's before(seq)
  // hook, before the message it is for has even been appended, and targets
  // is always a subset of that post's own audience — covered by postMessage's
  // single, final signal once everything it touches is written.
  return targets.length;
}

/**
 * Append one entry to members' activity inboxes: { k: kind, c: conv, s: seq,
 * by, ts }. One kv.add per member, in parallel batches, plus a bump of the
 * unread counter in their member document; no reads. The ring is trimmed to
 * its cap when add hands the document back (or when the value limit is hit).
 */
/**
 * Pushes a member takes between two readings of their ring's length, where
 * the store's answer to the append does not show it (see pushInbox). Once
 * in fifty, against a ring of three hundred: a read per fifty entries, and
 * the ring at most a sixth over its cap between two readings.
 */
const INBOX_TRIM_EVERY = 50;

async function pushInbox(wsId, uuids, entry) {
  const targets = uuids.filter((u) => !u.startsWith('smp_'));
  for (let i = 0; i < targets.length; i += 12) {
    await Promise.all(targets.slice(i, i + 12).map(async (u) => {
      const key = KEYS.inbox(wsId, u);
      let judged = false;
      // The ring and the count live in different documents and neither
      // answer feeds the other, so the two writes go together; only the
      // trim, which needs the ring as the append left it, waits.
      const counting = kv().incr(KEYS.member(wsId, u), { inbox: 1, inboxN: 1 }).catch(() => null);
      try {
        const doc = await kv().add(key, { items: [entry] });
        if (doc && Array.isArray(doc.items) && doc.items.length > LIMITS.inboxItems) {
          await kv().update(key, { items: doc.items.slice(-LIMITS.inboxItems) }).catch(() => {});
          judged = true;
        }
      } catch {
        const cur = (await kv().get(key)) || { items: [] };
        await kv().set(key, { items: [...(cur.items || []), entry].slice(-LIMITS.inboxItems) }).catch(() => {});
        judged = true;
      }
      // The unread count, and beside it a count of every entry ever pushed
      // (`inboxN`), on the same write. The ring is trimmed above from what
      // the append hands back, which is the whole ring only where the store
      // answers so: a store that answers with the part it changed hands back
      // the one entry appended, which reads as a ring well under its cap
      // however long the ring has grown (an answer of one item cannot be
      // told from a ring of one), and the ring grew until the store refused
      // the append at its value limit, every Activity read carrying it whole
      // meanwhile. So once in every INBOX_TRIM_EVERY pushes to a member,
      // where the append's answer did not settle it, the ring itself is read
      // and trimmed if it has run past the cap: the count rides on the write
      // made anyway, and the read is one in fifty rather than one a push.
      const counted = await counting;
      const n = counted && typeof counted === 'object' ? Number(counted.inboxN) : NaN;
      if (!judged && Number.isFinite(n) && n % INBOX_TRIM_EVERY === 0) {
        const ring = await kv().get(key).catch(() => null);
        if (Array.isArray(ring?.items) && ring.items.length > LIMITS.inboxItems) await kv().update(key, { items: ring.items.slice(-LIMITS.inboxItems) }).catch(() => {});
      }
    }));
  }
}

/** Note thread activity for its followers (the poster included): one path write each. */
async function touchThreads(wsId, uuids, threadId, parent, ts) {
  const targets = uuids.filter((u) => !u.startsWith('smp_'));
  for (let i = 0; i < targets.length; i += 12) {
    await Promise.all(targets.slice(i, i + 12).map((u) => kv().update(KEYS.threads(wsId, u), {
      [`t.${threadId}`]: { c: parent.conv, s: parent.seq, at: ts },
    }).catch(() => {})));
  }
}

/** Recipients one post may push to; broadcasts beyond this reach people through the in-app badge. */
const PUSH_FANOUT = 50;
/** Devices one member may subscribe per workspace. */
const PUSH_DEVICES = 5;
/** A heartbeat this recent means a tab of theirs is in view here (one every 30 seconds). */
const PUSH_PRESENT_MS = 75_000;

/** Notify opted-in members; legacy devices still receive Web Push. Never fails a post. */
async function sendPushes(ws, uuids, n, readDocs = null) {
  // Through the request's memo where the caller has one (see memberDocsMemo): a
  // post has read these documents already to count the people it now pushes.
  const docs = readDocs ? await readDocs(uuids) : await getMany(uuids.map((u) => KEYS.member(ws.id, u)));
  // The workspace as the app refers to it, its id at this server (the
  // deep link below names it so, and the app opens it by that name).
  const server = (workerHost || 'server').replace(/\.puter\.work$/, '');
  const ref = `${ws.id}@${server}`;
  const route = n.threadRoot ? `#/ws/${ref}/c/${n.threadRoot.conv}/t/${n.threadRoot.seq}/m/${n.seq}` : `#/ws/${ref}/c/${n.conv}/m/${n.seq}`;
  const notifying = !!workerAppUid();
  const owner = (await serverConfig()).owner;
  const act = docs.some((d) => Object.keys(d?.push || {}).length) ? (await kv().get(KEYS.activity(ws.id)).catch(() => null)) || {} : {};
  const present = (u) => (act.p?.[u] || 0) >= now() - PUSH_PRESENT_MS && act.ps?.[u] !== 'off';
  const jobs = [];
  for (const [i, u] of uuids.slice(0, PUSH_FANOUT).entries()) {
    const doc = docs[i];
    const subs = doc?.push || {};
    const pn = notifying && doc?.pn ? doc.pn : null;
    if (!Object.keys(subs).length && !pn) continue;
    const setting = doc?.notify?.[n.mentionConv] || {};
    if (setting.mute) continue;
    const level = setting.level || (n.kind === 'dm' ? 'all' : 'mentions');
    if (level === 'nothing') continue;
    // What this post is to this person: a mention of them, or a message in
    // their direct message. A group message that names someone else is a
    // plain message to the rest, which "mentions only" does not want.
    // A reply in a direct message is a direct message to the others in it.
    const event = n.reminder ? 'reminder' : n.mentioned.has(u) ? 'mention' : n.replies?.has(u) && n.kind !== 'dm' ? 'reply' : 'message';
    if (event === 'message' && level !== 'all') continue;
    // A channel heard at "all messages" by someone who has since left it.
    if (event === 'message' && n.channel && !doc?.channels?.includes(n.channel)) continue;
    // Legacy Web Push has no sensitive flag.
    const quiet = n.quiet || (event === 'mention' ? 'Mentioned you' : event === 'reply' ? 'New reply' : 'New message');
    const bodyFor = (preview) => (preview === false || !n.body ? quiet : n.body);
    // Tagged the way the client's own banner for the same news is tagged,
    // so a device told twice — by this push and by the page's poll —
    // shows one banner replacing the other rather than two. A mention is
    // tagged by the conversation it counts against (the parent, for one
    // inside a thread; shell.js tags mentions so) — except a top-level
    // mention in a conversation heard at "all messages" (every direct
    // message, a channel set so), which the page announces as the message
    // it already hears, so the push wears that name; a call keeps the
    // mention tag the page's huddle banner carries. A plain reply in a
    // direct message's thread is tagged by the thread under the client's
    // 'reply' name, which is how the page announces it to its followers.
    // Named with the workspace as the page names its own (`ref`), since a
    // direct message keeps its id across workspaces.
    const tag = n.reminder ? `${ref}:reminder-${n.reminder}` : `${ref}:${event === 'mention'
      ? (level === 'all' && !n.threadRoot && !n.call ? `message-${n.conv}` : `mention-${n.mentionConv}`)
      : n.threadRoot ? `reply-${n.conv}` : `message-${n.conv}`}`;
    if (pn && pushAllowed(pn.prefs)) {
      jobs.push((async () => {
        const handle = u === owner ? null : await ensureHandle(ws.id, u, doc, ws.name).catch(() => null);
        if (u !== owner && !handle) return;
        try {
          await me.puter.notifications.notify({
            title: n.title.slice(0, 120), text: (n.body || quiet).slice(0, 240),
            channel: 'chat', target: `/${route}`, data: { r: route, g: tag, ...(n.call ? { c: 1 } : {}) }, group: pushGroup(tag),
            ...(pn.preview === false ? { sensitive: true } : {}),
            // A ring arrives at once, and not after the call is over.
            ...(n.call ? { priority: 'high', ttl: 60 } : {}),
            ...(handle ? { to: { handle } } : {}),
          });
        } catch (err) {
          if (err?.code === 'subject_does_not_exist') {
            await kv().remove(KEYS.member(ws.id, u), 'ev').catch(() => {});
          } else if (err?.code === 'kv_share_notify_not_enabled') {
            await kv().remove(KEYS.member(ws.id, u), 'ev.notify').catch(() => {});
            await ensureHandle(ws.id, u, { ev: { h: handle } }, ws.name).catch(() => {});
          }
        }
      })());
    }
    for (const [sid, sub] of Object.entries(subs)) {
      if (!sub?.endpoint || present(u) || !pushAllowed(sub.prefs)) continue;
      // A message of files alone has no text to preview: it says what
      // happened, as the in-app banner does for such a message, rather than
      // arriving under the sender's name with nothing beneath it.
      const payload = { title: n.title, body: bodyFor(sub.preview), tag, route, ws: ws.id };
      jobs.push(sendPush(sub, payload).then((r) => (r === 'gone' ? kv().remove(KEYS.member(ws.id, u), `push.${sid}`).catch(() => {}) : null)));
    }
  }
  await Promise.allSettled(jobs);
}

/* ------------------------------------------------------------------------ */
/* Routes                                                                    */
/* ------------------------------------------------------------------------ */

router.get('/health', route(async () => ({ ok: true, ts: now(), build: WORKER_BUILD, builtAt: WORKER_BUILT_AT, runtime: workerRuntime() })));

/* ---- server ------------------------------------------------------------ */

router.get('/api/server', route(async ({ user }) => {
  const id = await identify(user);
  const cfg = await serverConfig();
  const owner = cfg.owner === id.uuid;
  // Events status is the owner's business alone: it names their own app uid
  // and whether they have delegated a share to it, neither of which is
  // anyone else's to know.
  const events = owner ? await serverEventsStatus() : null;
  return { build: WORKER_BUILD, owner, claimed: !!cfg.owner, open: !!cfg.open, ...(events ? { events } : {}) };
}));

/** Owner only: `open` lets any account create workspaces here (a shared deployment). */
router.put('/api/server', route(async ({ request, user }) => {
  const id = await identify(user);
  const cfg = await serverConfig();
  if (!cfg.owner || cfg.owner !== id.uuid) fail(403, 'forbidden', 'Only the owner of this server can change its settings');
  const body = await readJson(request);
  if (typeof body.open === 'boolean') await setServerConfig({ open: body.open });
  // { events: true } is what the consent toast calls after a grant: forget
  // the cached refusal so the next member's mint re-probes rather than
  // sitting out its old backoff window.
  if (body.events === true) await clearEventsVerdict();
  const next = await serverConfig();
  const events = await serverEventsStatus();
  return { build: WORKER_BUILD, owner: true, claimed: true, open: !!next.open, ...(events ? { events } : {}) };
}));

/* ---- me ---------------------------------------------------------------- */

router.get('/api/me', route(async ({ user }) => {
  const id = await identify(user);
  const profile = await ensureProfile(id);
  const docs = await getMany(profile.workspaces.map((w) => KEYS.ws(w)));
  const workspaces = [];
  const stale = [];
  docs.forEach((ws, i) => {
    // A document with no id is no workspace (see workspaceStands): a card
    // written under one deleted a moment before. It is not listed, and the
    // id drops out of the list below with the ids of workspaces deleted outright.
    if (ws && typeof ws.id !== 'string') ws = null;
    if (ws && ws.members && isExternal(ws.members[id.uuid])) {
      // In a shared channel here, not in the workspace: it is not one of theirs to list.
    } else if (ws && ws.members && ws.members[id.uuid]) {
      // The role travels with the list so the app knows, before asking a
      // worker, which workspaces the user administers.
      workspaces.push({ id: ws.id, name: ws.name, icon: ws.icon || undefined, members: Object.keys(ws.members).length, sample: !!ws.sample, role: ws.members[id.uuid].role, movedTo: ws.movedTo || undefined });
    } else {
      stale.push(profile.workspaces[i]);
    }
  });
  // A workspace the user was removed from (or that was deleted) drops out of
  // their list the next time they show up.
  if (stale.length) {
    const keep = profile.workspaces.filter((w) => !stale.includes(w));
    await kv().update(KEYS.user(id.uuid), { workspaces: keep });
  }
  const cfg = await serverConfig();
  return { profile: publicProfile(profile), workspaces, env: 'worker', build: WORKER_BUILD, builtAt: WORKER_BUILT_AT, owner: cfg.owner === id.uuid };
}));

function publicProfile(p) {
  return { uuid: p.uuid, username: p.username, name: p.name, title: p.title, color: p.color, avatar: p.avatar || null, status: p.status || null };
}

router.put('/api/me', route(async ({ request, user, defer }) => {
  const id = await identify(user);
  const profile = await ensureProfile(id);
  const body = await readJson(request);
  const patch = profilePatch(body, { strict: true });
  if (!Object.keys(patch).length) return { profile: publicProfile(profile) };
  await kv().update(KEYS.user(id.uuid), patch);
  // The card shown to other members lives in each workspace document. Only
  // workspaces the caller is really a member of are touched: a path update
  // would otherwise create a member record out of a stale id in the list,
  // handing back access to someone who had been removed.
  // Behind the answer, which is drawn from the patch itself: carrying a
  // name or a photo to every card costs three round trips per dozen
  // workspaces, and the caller has nothing to learn from any of them. Every
  // write in there already gives up quietly on failure, and ensureProfile
  // puts right a card a failed sync left behind.
  defer(() => syncCards(profile, patch));
  return { profile: publicProfile({ ...profile, ...patch }) };
}));

/**
 * Profile photo bytes for this worker. Each worker a user has a workspace
 * on keeps its own copy in the owner's drive (like attachments); the app
 * uploads it everywhere the card goes. Already square and small when it
 * arrives (the client crops and downscales), so the worker only bounds it.
 */
router.post('/api/me/avatar', route(async ({ request, user, defer }) => {
  const id = await identify(user);
  const profile = await ensureProfile(id);
  // The bytes go into the owner's drive, at the owner's cost: for the people
  // whose card this worker shows, which is anyone in a workspace here (and
  // the owner, whose first workspace may be moments away).
  const cfg = await serverConfig();
  if (!profile.workspaces?.length && cfg.owner !== id.uuid) fail(403, 'forbidden', 'Join a workspace on this server first');
  assertDeclaredSize(request, LIMITS.avatarBytes, 'Profile photos can be up to 300 KB');
  let form;
  try {
    form = await request.formData();
  } catch {
    fail(400, 'invalid', 'Expected a multipart upload');
  }
  const file = form.get('file');
  // A part with no bytes is no image (see the icon route): taken, it stood as the photo, a broken picture on every card of theirs.
  if (!file || typeof file.size !== 'number' || file.size === 0) fail(400, 'invalid', 'No image provided');
  if (file.size > LIMITS.avatarBytes) fail(413, 'too_large', 'Profile photos can be up to 300 KB');
  if (!/^image\/(png|jpeg|webp)$/.test(file.type || '')) fail(400, 'invalid', 'Profile photos must be PNG, JPEG, or WebP');
  await fs().write(avatarPath(id.uuid), file, { createMissingParents: true, overwrite: true });
  const avatar = now();
  await kv().update(KEYS.user(id.uuid), { avatar, avatarType: file.type });
  defer(() => syncCards(profile, { avatar }));
  return { avatar };
}));

router.delete('/api/me/avatar', route(async ({ user, defer }) => {
  const id = await identify(user);
  const profile = await ensureProfile(id);
  await fs().delete(avatarPath(id.uuid)).catch(() => {});
  await kv().update(KEYS.user(id.uuid), { avatar: null });
  defer(() => syncCards(profile, { avatar: null }));
  return { avatar: null };
}));

/** A member's photo, for members of a workspace they share. */
router.get('/api/ws/:ws/members/:uuid/avatar', route(async ({ params, user }) => {
  // The caller's membership alone, without their own document (see
  // requireMember, as the attachment route reads it): a photo is asked for
  // once per card on screen, and a member's may be served on their
  // membership; only a guest's or an external's check reads their document,
  // below. Read for every caller, as it used to be, opening a workspace of
  // fifty people cost fifty reads of one's own document that nothing looked
  // at. The pictured person's own record says what type the bytes are, and
  // is keyed on them rather than on the caller, so it comes up with the
  // workspace rather than after it — but only for a uuid that could name a
  // member at all, since that key is built before the workspace has been
  // read and one of any length would make a key the store refuses for size.
  const named = /^[A-Za-z0-9_-]{1,64}$/.test(String(params.uuid));
  const { id, ws, member, extra } = await requireMember(params.ws, user, { also: named ? [KEYS.user(params.uuid)] : [] });
  const [profile] = extra;
  const target = own(ws.members, params.uuid);
  if (!target || !target.avatar) fail(404, 'not_found', 'No photo');
  // A guest or a partner workspace's member sees the people they share a
  // channel with and nobody else, as the bootstrap, the presence, and the
  // member list all hold; the photo route held to the member list alone, so
  // it fetched any member's photo and answered whether a uuid is a member
  // here at all. The peers a limited bootstrap recorded are the rule; a
  // document from before it recorded any is asked the long way. Only a
  // limited caller's document is read at all.
  const limited = isLimited(member) && params.uuid !== id.uuid;
  const raw = limited ? await kv().get(KEYS.member(params.ws, id.uuid)) : null;
  if (limited) {
    const doc = { ...(raw || {}), channels: Array.isArray(raw?.channels) ? raw.channels : [], dms: raw?.dms || {} };
    const peers = Array.isArray(doc.peers) ? doc.peers : [...(await peersOf(ws, doc, memberDocsReader(ws, { uuid: id.uuid, doc })))];
    if (!peers.includes(params.uuid)) fail(404, 'not_found', 'No photo');
  }
  let blob;
  try {
    blob = await fs().read(avatarPath(params.uuid));
  } catch {
    fail(404, 'not_found', 'No photo');
  }
  return new Response(blob, { status: 200, headers: fileHeaders(profile?.avatarType || 'image/jpeg', 'photo', 86400) });
}));

/* ---- workspaces -------------------------------------------------------- */

/**
 * How many workspaces the account is in as a member, for the cap on making
 * or joining more. The profile's list also names the hosts of shared
 * channels the account takes part in from another workspace (so their card
 * syncs reach them), which /api/me leaves out of "your workspaces" and the
 * cap counted all the same: an owner active in many partners' channels was
 * told they were in the maximum number of workspaces. Ids of workspaces
 * since deleted drop out of the count as well, and so does the copy a
 * workspace left behind when it was moved to another server (see
 * /transfer/complete): read-only, and no longer anyone's workspace here, it
 * kept its cards, and counted as one the owner was still in until they
 * deleted it, so an owner who had moved a workspace away was told they were
 * in the maximum number one early for each they had moved.
 */
async function workspacesOf(profile) {
  const docs = await getMany(profile.workspaces.map((w) => KEYS.ws(w)));
  return docs.filter((w) => w?.members?.[profile.uuid] && !isExternal(w.members[profile.uuid]) && !w.movedTo).length;
}

router.post('/api/workspaces', route(async ({ request, user }) => {
  const id = await identify(user);
  await assertMayCreate(id.uuid);
  const body = await readJson(request);
  const profile = await ensureProfile(id, body.profile);
  const name = cleanLine(body.name, LIMITS.workspaceName);
  if (!name) fail(400, 'invalid', 'Give your workspace a name');
  if ((await workspacesOf(profile)) >= 20) fail(400, 'limit', 'You are in the maximum number of workspaces');
  const ws = await createWorkspaceFor(profile, name);
  return { workspace: { id: ws.id, name: ws.name } };
}));

router.post('/api/workspaces/sample', route(async ({ request, user }) => {
  const id = await identify(user);
  await assertMayCreate(id.uuid);
  const body = await readJson(request);
  const profile = await ensureProfile(id, body.profile);
  if ((await workspacesOf(profile)) >= 20) fail(400, 'limit', 'You are in the maximum number of workspaces');
  const wsId = await buildSampleWorkspace(profile);
  await kv().add(KEYS.user(profile.uuid), { workspaces: [wsId] });
  return { workspace: { id: wsId, name: 'Northwind Studio', sample: true } };
}));

router.post('/api/join', route(async ({ request, user }) => {
  const id = await identify(user);
  const body = await readJson(request);
  const code = normalizeInviteCode(body.code);
  if (!code) fail(400, 'invalid', 'That does not look like an invite code');
  // Budget first: a throttled caller costs one read and nothing else.
  await assertJoinBudget(id.uuid);
  // Missing, expired, and rotated codes all fail the same way: the endpoint
  // says nothing about which codes ever existed.
  const invite = await kv().get(KEYS.invite(code));
  const ws = invite ? await kv().get(KEYS.ws(invite.ws)) : null;
  // A channel invite is live while it is still the channel's current code;
  // a workspace invite while it is the workspace's. Rotating either kills
  // the old one, and every failure looks the same.
  const scoped = invite?.ch ? ws?.channels?.[invite.ch] : null;
  // A code that shares a channel with another workspace is accepted on
  // /api/connect/accept by that workspace's admin; it never makes a guest.
  const live = invite && ws && invite.role !== 'connect' && (invite.ch ? scoped && scoped.guestInvite === code && !scoped.archived : ws.invite === code) && (!invite.exp || invite.exp > now());
  if (!live) {
    await noteJoinFailure(id.uuid);
    fail(404, 'invite_not_found', 'This invite is not valid anymore');
  }
  ws.channels = ws.channels || {};
  ws.members = ws.members || {};
  // The workspace moved to another worker: say where, so an old link still
  // leads somewhere. Membership was carried across by the import, and only
  // for those who had it: someone with a card on this copy finds theirs on
  // the new one, and is sent on. Someone new does not, and the code they hold
  // opens nothing there either (the import mints the copy an invite of its
  // own), so sent on, as they used to be, they were told the workspace was
  // opening elsewhere and then that they had no access to it. Their link is
  // answered as any dead code is, which the app reads as "ask for a new one";
  // nothing is counted against them, the code having been this copy's own.
  // (Someone from a connected workspace has a card here and none on the new
  // copy, which such cards do not travel to; they are answered the same.)
  if (ws.movedTo) {
    const carried = own(ws.members, id.uuid);
    if (!carried || isExternal(carried)) fail(404, 'invite_not_found', 'This workspace moved to another server; ask an admin for a new invite');
    return { workspace: { id: ws.id, name: ws.name }, movedTo: ws.movedTo };
  }
  // The caller's record here, written on their first arrival (see
  // ensureProfile): only once the code has held. Written ahead of the code,
  // as it used to be, any account sending any code, refused every time,
  // left a record of its own making in the owner's store, one per account,
  // for good.
  const profile = await ensureProfile(id, body.profile);
  // One still being imported takes no joins either: a newcomer's "joined"
  // line would take the number the archive's next page brings for a message
  // of its own (see assertWritable). The code was good; nothing is counted.
  // Nor one being moved: a card made here now would be lost to the move,
  // and the newcomer told they had joined a workspace that then knew nothing
  // of them (see assertWritable). Asked before anything is written into the
  // workspace, and there alone: a member opening a link of theirs again,
  // for the workspace or for a channel they are in, is answered that they
  // are in already, which writes nothing here, and used to be told to try
  // again in a few minutes while the workspace was moved.
  const assertOpen = () => {
    if (ws.importing) fail(409, 'importing', 'This workspace is still being imported; try again in a moment');
    if (frozen(ws)) fail(423, 'transferring', 'This workspace is being moved to another server; try again in a few minutes');
  };
  // Someone here through a connected workspace's shared channel who accepts
  // an invite to the workspace itself becomes a member in their own right:
  // their card loses the connection's stamp (and its expiry), the default
  // channels are added to the channel, direct messages, and cursors they
  // have, and the workspace appears in their list. A channel invite adds
  // nothing to what they have; it answers as for any member.
  const external = isExternal(ws.members[id.uuid]) && !invite.ch;
  if (ws.members[id.uuid] && !external) {
    // Already a member. Repair the workspace list on the way through: a join
    // that wrote the membership but not the list (a request cut short) would
    // otherwise leave a workspace the caller is in that /api/me never names,
    // and the app drops what a worker does not list.
    if (!profile.workspaces.includes(ws.id)) await listWorkspace(id.uuid, ws.id);
    // A channel invite says "be in this channel": someone already here who
    // is not in it yet enters it now, as an admin adding them would have it.
    // That is the one way a guest gets into a second channel on their own
    // (they can join nothing themselves), and it takes a member into a
    // private channel they were handed the link to. Someone from a connected
    // workspace is in its shared channel alone, and enters nothing else.
    const me = ws.members[id.uuid];
    // The workspace's own invite makes members: a guest handed it (an admin
    // bringing them in fully, the way the Invite dialog offers) becomes one,
    // as someone here through a connected workspace does, rather than being
    // told they are in already while everything stays as it was.
    if (isGuest(me) && !invite.ch) {
      assertOpen();
      // The role goes on their own document first, and the channels handed
      // back with it are the ones counted below (see the role route, and enterChannel).
      const mine = await writeDocRole(ws.id, id.uuid, 'member');
      // Being removed this very moment (see closeMemberDoc, and the role
      // route): nothing is counted for someone on their way out, and the link
      // is theirs to open again once that is settled.
      if (typeof mine.gone === 'number' && mine.gone + SCHED_CLAIM_MS > now()) fail(409, 'retry', 'Your membership here changed just now; open the invite link again');
      const written = await kv().update(KEYS.ws(ws.id), { [`members.${id.uuid}.role`]: 'member' });
      // Removed by an admin between the read above and this write: the
      // write made no member of them (see cardStands), and they are told to
      // open the link again, which then joins them afresh if it still holds.
      // What the removal counted by the role already on their document is
      // made even (see evenGuestCounts).
      if (!(await cardStands(ws.id, id.uuid, written, ['role']))) {
        await unwriteDocRole(ws.id, id.uuid, mine);
        await evenGuestCounts(ws, mine, 'guest', 'member');
        fail(409, 'retry', 'Your membership here changed just now; open the invite link again');
      }
      await landPromotedGuest(ws, id.uuid, mine);
      await pokeAndBump(ws.id, id.uuid);
      return { workspace: { id: ws.id, name: ws.name }, promoted: true };
    }
    if (invite.ch) {
      const doc = (await kv().get(KEYS.member(ws.id, id.uuid))) || {};
      const inIt = (doc.channels || []).includes(invite.ch);
      // Someone from a connected workspace is in the channel shared with it
      // and in no other here: a guest link for that very channel finds them
      // in it, and one for another channel is refused with the reason. It
      // used to be answered as "already in", the answer for a member handed
      // the link of a channel they are in, which sent them to no channel and
      // told them they were in a workspace they are not.
      if (isExternal(me)) {
        if (inIt) return { workspace: { id: ws.id, name: ws.name }, already: true, channel: { id: invite.ch, name: scoped.name } };
        fail(403, 'external', `You are in ${ws.name} through a channel shared with your workspace, and this link is to another of its channels; ask an admin of ${ws.name} for its workspace invite to join it fully`);
      }
      if (!inIt) assertOpen();
      const entry = inIt ? null : await enterChannel(ws.id, id.uuid, invite.ch, doc);
      // On their way out of the workspace this very moment (see enterChannel):
      // the link is theirs to open again once that is settled.
      if (entry?.status === 'gone') fail(409, 'retry', 'Your membership here changed just now; open the invite link again');
      if (entry?.status === 'entered') {
        // Counted as what they are as of the append: a guest, or being made one (see enterChannel).
        const asGuest = entry.role ? entry.role === 'guest' : isGuest(me);
        const counted = await kv().incr(KEYS.ws(ws.id), { [`channels.${invite.ch}.count`]: 1, ...(asGuest ? { [`channels.${invite.ch}.guests`]: 1 } : {}) });
        // The channel was deleted between the read above and these writes,
        // its invite with it (see channelStands): the link leads nowhere now.
        if (!(await channelStands(ws.id, invite.ch, counted))) fail(404, 'invite_not_found', 'This invite is not valid anymore');
        // Taken out of the workspace between the append and the count (their
        // card is gone from what the count handed back): the count is right
        // on both sides (see enterChannel), and nothing more is written for
        // someone who is out.
        if (counted && typeof counted === 'object' && counted.members && !own(counted.members, id.uuid)) fail(409, 'retry', 'Your membership here changed just now; open the invite link again');
        // On a private channel's list only now, the channel known to stand
        // and the card to hold. Appended before either was asked, the name
        // stayed on the list of a channel the person was being taken out of
        // (the removal rewrites the list from its own reading, and had
        // already), a name with no card behind it: a channel then hidden
        // from every admin, its list not empty, that nobody could open or
        // delete (see enterMadeChannel, which orders a new channel the same way).
        if (scoped.private) await addPrivateMember(ws.id, invite.ch, id.uuid);
        // Caught up including their own "joined" line: read to the seq that
        // line takes, not the one before it, so entering leaves no self-made unread.
        const joinSeq = await postSystem(ws.id, invite.ch, id.uuid, `${me.name || profile.name || profile.username} joined`);
        await kv().update(KEYS.member(ws.id, id.uuid), { [`reads.${invite.ch}`]: Math.max(joinSeq, Number(doc.reads?.[invite.ch]) || 0), ...caughtUpMentions(doc, invite.ch) });
        await pokeAndBump(ws.id, id.uuid);
        return { workspace: { id: ws.id, name: ws.name }, already: true, channel: { id: invite.ch, name: scoped.name }, joined: true };
      }
      return { workspace: { id: ws.id, name: ws.name }, already: true, channel: { id: invite.ch, name: scoped.name } };
    }
    return { workspace: { id: ws.id, name: ws.name }, already: true };
  }
  assertOpen();
  if (!external && Object.keys(ws.members).length >= 500) fail(400, 'limit', 'This workspace is full');
  // A card grows the workspace document as a channel or a description does,
  // and the guard was applied only to those: with the text at the allowed
  // ceiling, cards and private member lists could carry the document past
  // what the store takes, after which every write to it failed.
  assertWorkspaceRoom(ws, { joining: true });

  // A guest lands in exactly the invited channel; a member in the defaults.
  const guest = !!invite.ch;
  // Two requests for the same newcomer at once (the link opened in two
  // tabs) each found no card and each made one: the channel counted them
  // twice for good, their "joined" line was posted twice, and their list
  // named the workspace twice. The workspace's place in their own list is
  // the claim, an atomic append as enterChannel's is: a second copy in what
  // comes back says this request lost, and the other is putting them in.
  if (!profile.workspaces.includes(ws.id)) {
    const res = await kv().add(KEYS.user(id.uuid), { workspaces: [ws.id] });
    const list = res && Array.isArray(res.workspaces) ? res.workspaces : null;
    if (list && list.filter((w) => w === ws.id).length > 1) {
      await kv().update(KEYS.user(id.uuid), { workspaces: list.filter((w, i) => w !== ws.id || list.indexOf(ws.id) === i) }).catch(() => {});
      return { workspace: { id: ws.id, name: ws.name }, guest, channel: guest ? { id: invite.ch, name: scoped.name } : undefined };
    }
    profile.workspaces.push(ws.id);
  }
  // Someone from a connected workspace whose standing ran out a month ago
  // is one the bootstrap's sweep may be letting go of this very moment (see
  // lapseExternals): the claim it takes on the card is taken here first, and
  // the one of the two that loses it leaves the card to the other. Without
  // it, a sweep reading the old card while this request wrote the new one
  // took the new member out again, card, document and all, and counted them
  // out of channels this request had just counted them into, while they
  // were told they had joined. Told to open the link again, they join afresh
  // once the sweep is done with the old card.
  if (external && sweepable(ws.members[id.uuid]) && !(await claimLapse(ws.id, id.uuid, ws.members[id.uuid]))) {
    fail(409, 'retry', 'Your membership here changed just now; open the invite link again');
  }
  const had = external ? (await kv().get(KEYS.member(ws.id, id.uuid))) || {} : null;
  const defaults = (guest ? [invite.ch] : Object.values(ws.channels).filter((c) => c.def && !c.archived).map((c) => c.id))
    .filter((c) => !had || !(had.channels || []).includes(c));
  const ts = now();
  // A newcomer starts caught up: history is there to scroll, not to clear.
  const seqs = await getMany(defaults.map((c) => KEYS.seq(c)));
  const reads = {};
  defaults.forEach((c, i) => { reads[c] = Number(seqs[i]) || 0; });
  // What the cards remembered of them, kept in case the join is undone below.
  const remembered = { former: ws.former?.[id.uuid] || null, removed: ws.removed?.[id.uuid] || null };
  const written = await kv().update(KEYS.ws(ws.id), { [`members.${id.uuid}`]: memberRecord(profile, guest ? 'guest' : 'member') });
  // The owner deleted the workspace between the read at the top and this
  // write (see workspaceStands): the card made a workspace of nothing but
  // itself, and comes off again; the place the join claimed in the
  // newcomer's own list goes with it, and the link, whose code went with
  // the workspace, is answered as any dead code is. Nothing is counted,
  // announced or written for them under what is gone.
  if (!(await workspaceStands(ws.id, id.uuid, written))) {
    const p = await kv().get(KEYS.user(id.uuid)).catch(() => null);
    if (p?.workspaces?.includes(ws.id)) await kv().update(KEYS.user(id.uuid), { workspaces: p.workspaces.filter((w) => w !== ws.id) }).catch(() => {});
    fail(404, 'invite_not_found', 'This invite is not valid anymore');
  }
  await forgetFormer(ws, id.uuid);
  // In the workspace in their own right now: no longer someone kept out of its shared channels.
  await forgetRemoved(ws, id.uuid);
  // Undo what this request alone made, when the join cannot go on: the card
  // it wrote; the document it wrote whole (`doc`; not one that was there
  // before, which is the removal's to take); what the cards remembered of
  // them; the place it took in their own list; and a word to every tab that
  // the workspace changed. Then the answer given.
  const undo = async ({ doc: dropDoc }, status, code, message) => {
    await kv().remove(KEYS.ws(ws.id), `members.${id.uuid}`).catch(() => {});
    if (dropDoc) await kv().del(KEYS.member(ws.id, id.uuid)).catch(() => {});
    const restore = {};
    if (remembered.former) restore[`former.${id.uuid}`] = remembered.former;
    if (remembered.removed) restore[`removed.${id.uuid}`] = remembered.removed;
    if (Object.keys(restore).length) await kv().update(KEYS.ws(ws.id), restore).catch(() => {});
    const p = await kv().get(KEYS.user(id.uuid)).catch(() => null);
    if (p?.workspaces?.includes(ws.id)) await kv().update(KEYS.user(id.uuid), { workspaces: p.workspaces.filter((w) => w !== ws.id) }).catch(() => {});
    await bumpWorkspace(ws.id).catch(() => {});
    fail(status, code, message);
  };
  const retry = 'Your membership here changed just now; open the invite link again';
  const entered = [];
  if (had) {
    // Someone from a connected workspace has a document here already, and
    // it is added to rather than written whole: two tabs accepting the
    // invite at once each found them outside the default channels and each
    // wrote the document, counted them into the defaults, announced them,
    // and took them off their connection's count, so the channel counted
    // them twice and the connection one too few, for good. Entering the
    // defaults is the claim (see enterChannel): the request that entered
    // none where there were some to enter lost, and the other is counting.
    let gone = false;
    for (const c of defaults) {
      const entry = await enterChannel(ws.id, id.uuid, c, had);
      if (entry.status === 'entered') entered.push(c);
      else if (entry.status === 'gone') gone = true;
    }
    if (defaults.length && !entered.length) {
      // Refused everywhere because an admin is removing them this very
      // moment (see enterChannel): the card written above made a member of
      // someone being shown the door, and comes off again; their document,
      // from before this request, is the removal's to take. Answered to open
      // the link again once that is settled, rather than told they had
      // joined a workspace that then knew nothing of them.
      if (gone) await undo({ doc: false }, 409, 'retry', retry);
      return { workspace: { id: ws.id, name: ws.name }, guest };
    }
    const upd = { joinedAt: had.joinedAt || ts };
    for (const c of entered) upd[`reads.${c}`] = reads[c];
    await kv().update(KEYS.member(ws.id, id.uuid), upd);
  } else {
    // Written whole, with no channel on it yet: entering each default is
    // the claim (see enterChannel), as it is for someone already here.
    // Written with its channels, as it used to be, the document told nothing
    // of a removal landing between the card's write and the count. One that
    // closed the document before this write found no channel to count them
    // out of, and this request's count then stood for good, one too many,
    // with a document behind it for someone gone; one that closed it after
    // counted them out, and the count came out right; and the two could not
    // be told apart afterwards. An append the closed document refuses
    // ('gone'), or one made again of the channel alone over its deletion, is
    // a removal that counted nothing: nothing is counted here either, and
    // what this request made goes again. Written field by field, not whole:
    // a closing already on the document (a removal that read the card
    // written above and stamped a document not yet there) must survive
    // this write for the append to find it; written whole, it was wiped,
    // and the append entered someone the removal had counted out of
    // nothing. The role goes on with the rest, as a change of role keeps it
    // there (see writeDocRole), so what is left of an older document of
    // theirs cannot say otherwise. Nor the claim a promotion of theirs once
    // took, should the document be an older one (see landPromotedGuest).
    //
    //
    // The write itself is claimed, with a count on the document that only
    // the request taking it from nothing to one wins (as a delivery claims a
    // scheduled entry; see claimEntry): two tabs opening the link at once,
    // neither held back by the claim on their own list (a join cut short
    // earlier had left the workspace on it), each wrote the document, and
    // the slower write laid its empty list of channels over the channel the
    // faster had appended, so its own append then entered them again, and
    // the channel counted them twice, for good, under two "joined" lines.
    // The request that loses the claim waits for the winner's document, and
    // goes on from there through the appends, each its own claim (see
    // enterChannel), so whichever of the two reaches a channel first counts
    // them into it and the other finds them in. A winner that died before
    // writing (the wait finds no document) is written for here, as before.
    // The count goes with the document, and a removal zeroes it as it closes
    // the document (see closeMemberDoc), so someone joining again after one
    // that died claims afresh and the channels it had counted them out of
    // are reset. A store that answers the count with nothing is trusted once.
    const key = KEYS.member(ws.id, id.uuid);
    const claim = await kv().incr(key, { jc: 1 }).catch(() => null);
    const n = claim && typeof claim === 'object' ? Number(claim.jc) : Number(claim);
    let writes = !Number.isFinite(n) || n === 1;
    if (!writes) {
      let seen = false;
      for (let i = 0; i < 6 && !seen; i++) {
        await new Promise((r) => setTimeout(r, 150));
        const d = await kv().get(key).catch(() => null);
        seen = !!d && typeof d === 'object' && Object.hasOwn(d, 'joinedAt') && Array.isArray(d.channels);
      }
      writes = !seen;
    }
    if (writes) await kv().update(key, { channels: [], dms: {}, reads, mentions: {}, joinedAt: ts, role: guest ? 'guest' : 'member', ...(guest ? { promo: 0 } : {}) });
    const fresh = { channels: [], joinedAt: ts };
    let gone = false;
    for (const c of defaults) {
      const entry = await enterChannel(ws.id, id.uuid, c, fresh);
      if (entry.status === 'entered') entered.push(c);
      else if (entry.status === 'gone') {
        gone = true;
        break;
      }
    }
    if (gone && !entered.length) await undo({ doc: true }, 409, 'retry', retry);
  }
  for (const ch of entered) {
    const counted = await kv().incr(KEYS.ws(ws.id), { [`channels.${ch}.count`]: 1, ...(guest ? { [`channels.${ch}.guests`]: 1 } : {}) });
    // A guest's one channel was deleted between the read above and this
    // count, its invite with it (see channelStands, and the same check for
    // someone already here): the count made a nameless entry of it, and the
    // card written a moment ago would make a guest of nothing, told they had
    // joined, listed to the admins with no channel, whom nothing but an
    // admin's hand ever lets go of; and their "joined" line would bring the
    // deleted channel's history back as a conversation nobody can open. The
    // join is undone, card, document and list entry, and the link is
    // answered as no longer valid, as it would have been a moment later. (A
    // member's default channels cannot be deleted.)
    if (guest && !(await channelStands(ws.id, ch, counted))) await undo({ doc: true }, 404, 'invite_not_found', 'This invite is not valid anymore');
    // Taken out of the workspace between the append and the count (their
    // card is gone from what the count handed back): the count is right on
    // both sides, the removal having closed their document after the append
    // and counted them out of this channel with the rest (see enterChannel);
    // nothing more is written for someone who is out, no name onto a private
    // channel's list, no line, no cursor. The document and the card are the
    // removal's to take. Without this the count stood one too many for good,
    // and a guest's name on a private channel's list with no card behind it.
    if (counted && typeof counted === 'object' && counted.members && !own(counted.members, id.uuid)) {
      if (!had) {
        // Which side the removal counted on, the document says. One still
        // standing with no closing on it is one the removal never saw: it
        // closed (and deleted) what stood before this request wrote the
        // document, so it counted them out of nothing, and what this request
        // counted comes off again, the document with it. One closed, or gone,
        // was counted out of by the removal, the appends having landed before
        // its closing (an append after it answers 'gone'; see enterChannel),
        // and the counts are right on both sides.
        const stray = await kv().get(KEYS.member(ws.id, id.uuid)).catch(() => undefined);
        if (stray && typeof stray === 'object' && !(typeof stray.gone === 'number' && stray.gone + SCHED_CLAIM_MS > now())) {
          const back = {};
          for (const c of entered.slice(0, entered.indexOf(ch) + 1)) {
            back[`channels.${c}.count`] = -1;
            if (guest) back[`channels.${c}.guests`] = -1;
          }
          await kv().incr(KEYS.ws(ws.id), back).catch(() => {});
          await undo({ doc: true }, 409, 'retry', retry);
        }
      }
      fail(409, 'retry', retry);
    }
  }
  if (had) {
    // No longer one of the connected workspace's people in the shared
    // channels they are in: taken off each connection's count once, by the
    // one of two requests that takes the claim on their document (see
    // landPromotedGuest, which claims a guest's coming off the guest count
    // the same way). Two tabs accepting the invite together, in a workspace
    // with two default channels, could each enter one of them, and each then
    // took them off the connection's count, which stood one short for good.
    const claim = await kv().incr(KEYS.member(ws.id, id.uuid), { promo: 1 }).catch(() => null);
    const n = claim && typeof claim === 'object' ? Number(claim.promo) : Number(claim);
    if (!Number.isFinite(n) || n === 1) {
      const was = ws.members[id.uuid];
      for (const ch of had.channels || []) {
        const conn = ws.channels[ch] ? partnerConnOf(ws.channels[ch], was) : null;
        if (conn) await kv().incr(KEYS.ws(ws.id), { [`channels.${ch}.connections.${conn}.count`]: -1 }).catch(() => {});
      }
    }
  }
  if (guest && scoped.private) await addPrivateMember(ws.id, invite.ch, id.uuid);
  await bumpWorkspace(ws.id);
  if (entered[0]) {
    // The "joined" line takes the next seq in the channel it lands in; read
    // past it so a newcomer's own arrival is not waiting for them as one unread.
    const joinSeq = await postSystem(ws.id, entered[0], id.uuid, `${profile.name || profile.username} joined${guest ? ' as a guest' : ''}`);
    await kv().update(KEYS.member(ws.id, id.uuid), { [`reads.${entered[0]}`]: joinSeq });
  }
  // Minted here, awaited, so a member's first bootstrap already finds a
  // cached handle instead of paying the mint's own latency (see
  // worker/events.js): the result is not needed for the answer below.
  await eventsBlock(ws, id.uuid, null, user).catch(() => null);
  // One final signal, covering everything this join wrote (the "joined"
  // line's own signal already ran, but the read-cursor catch-up just above
  // it, and any mint bookkeeping eventsBlock did, come after): guaranteed
  // last, whatever else this request touched.
  await signal(ws.id, null);
  return { workspace: { id: ws.id, name: ws.name }, guest, channel: guest ? { id: invite.ch, name: scoped.name } : undefined };
}));

router.get('/api/ws/:ws', route(async ({ params, request, user, defer }) => {
  // The moment this answer is drawn from, taken before anything is read.
  // The client makes its first poll's `since` of it and judges live signals
  // against it (see the store's _evCovered): reported as the moment the
  // answer was finished instead, as it used to be, a change landing while
  // the bootstrap was still being put together fell between the two — after
  // what was read, before what was reported — and the first poll passed
  // over it.
  const readAt = now();
  // Four rounds of calls before anything is looked at — who is asking, the
  // workspace, the caller's own document, their account record, the activity
  // document — where only the first two depend on one another: identify runs
  // beside the workspace read, and the other three are one batched read.
  // The ring counters only where anything could watch this worker (see worker/signal.js).
  const ringOn = !!workerAppUid();
  const { id, ws, doc, extra } = await requireMembership(params.ws, user, {
    also: ({ uuid }) => [KEYS.user(uuid), KEYS.activity(params.ws), ...(ringOn ? [KEYS.evCounter(params.ws)] : [])],
  });
  const [knownProfile, knownAct, knownCounters = null] = extra;
  if (!doc.naSync) defer(() => recordHearAll(ws, id.uuid, doc));
  const q = query(request);
  // A member carried across by an import, or whose join was cut short, has
  // a card in the workspace but no entry in their own list on this worker,
  // which is what /api/me answers from and what the app trusts over its
  // cache: the workspace would drop off their list at every start. Opening
  // it puts the entry right.
  const profile = await ensureProfile(id, null, { known: knownProfile });
  const me = ws.members[id.uuid];
  // (For someone from a connected workspace the list is where their card
  // is updated from, and /api/me leaves this workspace out of their answer.)
  if (!profile.workspaces.includes(ws.id)) await listWorkspace(id.uuid, ws.id).catch(() => {});
  // The handle on the card is the account's as Puter says it (see identify),
  // and what an @-mention is matched against. A rename is carried to the
  // cards of the workspaces the account's record here lists (see
  // ensureProfile); a card on a workspace the record did not list (one
  // brought here by an import and opened here for the first time, a join cut
  // short) kept the old handle for good, so a mention of the new handle rang
  // nobody there while the old one still rang. Brought in step here, once,
  // and every tab told; the name, title, photo and status on the card are
  // the person's own to change and stay as they are.
  // Either of the two below writes to the activity document (a bump, a
  // lapsed member's presence dropped), which was read up front with
  // everything else: when one of them fires — both are rare — it is read
  // again, so the answer never names presence for someone this very request
  // took out, or a version stamp its own bump has already passed.
  let stale = false;
  if (id.username && me.username !== id.username) {
    const written = await kv().update(KEYS.ws(ws.id), { [`members.${id.uuid}.username`]: id.username }).catch(() => null);
    if (written !== null) await cardStands(ws.id, id.uuid, written, ['username']).catch(() => {});
    me.username = id.username;
    await bumpWorkspace(ws.id).catch(() => {});
    stale = true;
  }
  // People from connected workspaces whose standing ran out long ago go
  // here (see lapseExternals); not on a copy that moved or is still being
  // imported, which take no writes.
  if (!ws.movedTo && !ws.importing && (await lapseExternals(ws).catch(() => false))) stale = true;
  const act = (stale ? await kv().get(KEYS.activity(params.ws)).catch(() => knownAct) : knownAct) || { c: {}, p: {}, u: {}, w: 0 };
  // A tab in view opening the workspace is here from this moment, not from
  // its first poll a few seconds on: the same heartbeat the poll carries,
  // written while the rest of the answer is put together.
  const heartbeat = q.get('hb') === '1' ? recordPresence(params.ws, id.uuid, act, q.get('st')) : null;
  const guest = isLimited(me);
  // Private channels the caller is not in are invisible; to a guest, so is
  // every channel they are not in, and every member they share none with.
  const channels = {};
  for (const [cid, c] of Object.entries(ws.channels)) {
    // A private channel with nobody left on its list (its last member was
    // removed from the workspace; leaving keeps the last one in) is one
    // nobody can open, and an admin may delete it (see the delete route) so
    // its history does not sit in the owner's store for good. Hidden from
    // every bootstrap, admins included, as a private channel they are not in
    // is, nothing in the app could offer that deletion. It is listed to
    // admins, marked `orphan`, its list empty, so the app can show it for
    // what it is and offer Delete alone; every other route still answers
    // "not found" for it, as for any private channel the caller is not in.
    const orphan = c.private && !guest && isAdmin(me) && !(c.members || []).length && !doc.channels.includes(cid);
    if ((c.private || guest) && !doc.channels.includes(cid) && !orphan) continue;
    // Guests never learn a channel's own invite codes (for guests, or for
    // other workspaces); nor do members who are not admins.
    const shown = guest || !isAdmin(me) ? { ...c, guestInvite: undefined, guestInviteExp: undefined, connectInvite: undefined, connectInviteExp: undefined } : c;
    channels[cid] = orphan ? { ...shown, members: [], orphan: true } : shown;
  }
  let members = ws.members;
  if (guest) {
    const peers = await peersOf(ws, doc, memberDocsReader(ws, { uuid: id.uuid, doc }));
    peers.add(id.uuid);
    members = Object.fromEntries(Object.entries(ws.members).filter(([u]) => peers.has(u)));
    // Kept on the member document for the poll, which reads that document
    // anyway and must not send a guest the presence of people they were not
    // given here. Every join and leave bumps the workspace, which brings the
    // guest back here for a fresh list.
    await kv().update(KEYS.member(ws.id, id.uuid), { peers: [...peers] }).catch(() => {});
  }
  // Activity and typing only for what the caller can see: their channels and
  // direct messages, and for members the public channels too (see the sync
  // poll). Presence and version stamps are cut for guests alone.
  const sees = memberVisible(doc);
  const visible = guest ? sees : (conv) => sees(conv) || isPublicChannel(ws, conv);
  // Huddles only where the caller is: a roster carries the invite codes its
  // participants serve, and those are for the conversation's members alone,
  // whatever the caller's role (see the sync poll).
  const huddles = Object.fromEntries(Object.entries(liveHuddles(act.h)).filter(([conv]) => sees(conv)));
  const activity = {
    ...act,
    c: Object.fromEntries(Object.entries(act.c || {}).filter(([conv]) => visible(conv))),
    t: Object.fromEntries(Object.entries(act.t || {}).filter(([conv]) => visible(conv))),
    h: huddles,
    // The claims on huddles that ended are the poll's own bookkeeping (see
    // endHuddle), no client's; keyed by conversation, they named to a guest
    // conversations they were shown nothing else of.
    he: undefined,
  };
  if (guest) {
    activity.p = Object.fromEntries(Object.entries(act.p || {}).filter(([u]) => members[u]));
    activity.ps = Object.fromEntries(Object.entries(act.ps || {}).filter(([u]) => members[u]));
    activity.u = Object.fromEntries(Object.entries(act.u || {}).filter(([u]) => u === id.uuid));
  }
  // Minted lazily and cached on the member document when it has none yet
  // (see worker/events.js); omitted entirely when unavailable, so an old
  // client never sees the key and an old worker's bootstrap never had one.
  const events = await eventsBlock(ws, id.uuid, doc, user).catch(() => null);
  // The keys to the ring entries of what the caller can read (see worker/ring.js).
  const keyed = [...Object.keys(channels).filter((cid) => !channels[cid].orphan), ...Object.keys(doc.dms || {})];
  const ring = await ringBlock(ws, id.uuid, events, keyed, knownCounters).catch(() => null);
  if (heartbeat) await heartbeat;
  return {
    now: readAt,
    ...(events ? { events } : {}),
    ...(ring ? { ring } : {}),
    workspace: {
      id: ws.id, name: ws.name, owner: ws.owner, sample: !!ws.sample, createdAt: ws.createdAt,
      icon: ws.icon || null,
      invite: isAdmin(me) ? ws.invite : null,
      inviteExp: isAdmin(me) ? ws.inviteExp || null : null,
      search: ws.search || null,
      unfurl: ws.unfurl !== false,
      movedTo: ws.movedTo || null,
      transferTo: ws.transferTo || null,
      // The move in progress, while its freeze holds (see assertWritable):
      // the app can say the workspace is being moved rather than fail each write.
      // Who is moving it and since when; the name of the session holding
      // the freeze (see /transfer/begin) is between that session and the
      // worker, and no member's business.
      transferring: frozen(ws) ? { by: ws.transferring.by, at: ws.transferring.at } : null,
      importing: !!ws.importing,
      integrations: isAdmin(me) ? liveIntegrations(ws) : undefined,
      channels, members,
      // People who left, by name, so their messages keep an author. Not for
      // guests and people from connected workspaces, who are shown only the
      // people of the channels they are in.
      former: guest ? undefined : ws.former || undefined,
      // People from connected workspaces an admin removed, kept out until
      // restored: the admins' list to restore from.
      removed: isAdmin(me) && Object.keys(ws.removed || {}).length ? ws.removed : undefined,
    },
    me: { ...doc, peers: undefined, role: me.role },
    activity,
  };
}));

/**
 * Re-mints per member per workspace, the join-budget pattern (see
 * assertUnfurlBudget): counted before the mint is even attempted, so a
 * re-mint that fails still spends it. A client stuck reloading in a retry
 * loop is exactly what this exists to stop, and a failing mint costs the
 * owner's shared 60-a-minute budget the same as a successful one does.
 */
async function assertRemintBudget(wsId, uuid) {
  const key = `tc:evrate:${wsId}:${uuid}`;
  const n = await kv().incr(key).catch(() => 1);
  if (n === 1) await kv().expire(key, LIMITS.evRemintWindowSeconds).catch(() => {});
  if (n > LIMITS.evRemintsPerMember) fail(429, 'too_many_remints', 'Live updates have been renewed as often as they can be just now; they resume on their own');
}

/**
 * A fresh handle for the caller alone, once the one they hold has been
 * refused (see worker/events.js's remintHandle, and store.js's _evRemint,
 * which is the only thing that ever calls this). The caller is only ever
 * themselves — this route takes no member id at all — so there is no shape
 * in which one member spends another's handle or another's budget. An
 * answer with no `events` key means exactly what it means in the bootstrap:
 * nothing is available right now, and the tab keeps polling.
 */
router.post('/api/ws/:ws/events/handle', route(async ({ params, user }) => {
  const { id, ws, doc } = await requireMembership(params.ws, user);
  await assertRemintBudget(ws.id, id.uuid);
  const events = await remintHandle(ws, id.uuid, doc, user).catch(() => null);
  return { ...(events ? { events } : {}) };
}));

router.put('/api/ws/:ws', route(async ({ params, request, user }) => {
  const { id, ws, member } = await requireMembership(params.ws, user, { write: true, doc: false });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can change workspace settings');
  const body = await readJson(request);
  const patch = {};
  if (typeof body.name === 'string') {
    const name = cleanLine(body.name, LIMITS.workspaceName);
    if (!name) fail(400, 'invalid', 'Workspace name cannot be empty');
    patch.name = name;
  }
  if (typeof body.unfurl === 'boolean') patch.unfurl = body.unfurl;
  if (body.rotateInvite) {
    if (body.inviteTtl !== undefined && !Object.hasOwn(INVITE_TTLS, body.inviteTtl)) fail(400, 'invalid', 'Unknown invite duration');
    const { code, exp } = await issueInvite(ws.id, body.inviteTtl || DEFAULT_INVITE_TTL);
    if (ws.invite) await kv().del(KEYS.invite(ws.invite)).catch(() => {});
    patch.invite = code;
    patch.inviteExp = exp;
  } else if (body.revokeInvite && ws.invite) {
    // Deactivate without replacing: nobody joins with the old link, and no
    // new link exists until an admin creates one.
    await kv().del(KEYS.invite(ws.invite)).catch(() => {});
    patch.invite = null;
    patch.inviteExp = null;
  }
  if (Object.keys(patch).length) {
    await kv().update(KEYS.ws(ws.id), patch);
    await bumpWorkspace(ws.id);
  }
  return {
    workspace: {
      id: ws.id, name: patch.name || ws.name,
      invite: Object.hasOwn(patch, 'invite') ? patch.invite : ws.invite || null,
      inviteExp: Object.hasOwn(patch, 'inviteExp') ? patch.inviteExp : ws.inviteExp || null,
    },
  };
}));

/**
 * The workspace's icon: shown in place of the name's first letter on the
 * rail, in the workspace menu, and in the switcher. Admins set it; already
 * square and small when it arrives (the client crops and downscales, as for
 * a profile photo), so the worker only bounds it. The bytes live in the
 * owner's drive beside the attachments; `icon` on the workspace document is
 * the version the clients cache by.
 */
router.post('/api/ws/:ws/icon', route(async ({ params, request, user }) => {
  const { id, ws, member } = await requireMembership(params.ws, user, { write: true, doc: false });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can change the workspace icon');
  assertDeclaredSize(request, LIMITS.workspaceIconBytes, 'Workspace icons can be up to 300 KB');
  let form;
  try {
    form = await request.formData();
  } catch {
    fail(400, 'invalid', 'Expected a multipart upload');
  }
  const file = form.get('file');
  // A part with no bytes is no image (a picker that handed over nothing, a
  // read that failed on the way): taken, it stood as the icon, a broken
  // picture on the rail and in the switcher for everyone until the next upload.
  if (!file || typeof file.size !== 'number' || file.size === 0) fail(400, 'invalid', 'No image provided');
  if (file.size > LIMITS.workspaceIconBytes) fail(413, 'too_large', 'Workspace icons can be up to 300 KB');
  if (!/^image\/(png|jpeg|webp)$/.test(file.type || '')) fail(400, 'invalid', 'Workspace icons must be PNG, JPEG, or WebP');
  await fs().write(iconPath(ws.id), file, { createMissingParents: true, overwrite: true });
  const icon = now();
  await kv().update(KEYS.ws(ws.id), { icon, iconType: file.type });
  await bumpWorkspace(ws.id);
  return { icon };
}));

router.delete('/api/ws/:ws/icon', route(async ({ params, user }) => {
  const { id, ws, member } = await requireMembership(params.ws, user, { write: true, doc: false });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can change the workspace icon');
  await fs().delete(iconPath(ws.id)).catch(() => {});
  await kv().update(KEYS.ws(ws.id), { icon: null });
  await bumpWorkspace(ws.id);
  return { icon: null };
}));

/** The icon's bytes, for members (guests and people from connected workspaces included). */
router.get('/api/ws/:ws/icon', route(async ({ params, user }) => {
  const { id, ws } = await requireMembership(params.ws, user, { doc: false });
  if (!ws.icon) fail(404, 'not_found', 'No icon');
  let blob;
  try {
    blob = await fs().read(iconPath(ws.id));
  } catch {
    fail(404, 'not_found', 'No icon');
  }
  return new Response(blob, { status: 200, headers: fileHeaders(ws.iconType || 'image/png', 'icon', 86400) });
}));

router.delete('/api/ws/:ws', route(async ({ params, user }) => {
  const { id, ws } = await requireMembership(params.ws, user, { doc: false });
  if (ws.owner !== id.uuid) fail(403, 'forbidden', 'Only the owner can delete a workspace');
  const memberIds = Object.keys(ws.members);
  const docs = await getMany(memberIds.map((u) => KEYS.member(ws.id, u)));
  const convs = new Set(Object.keys(ws.channels));
  // A direct message under an unscoped id (from before ids carried the
  // workspace) may be the same conversation in another workspace on this
  // worker: its blocks stay, like a long conversation's tail blocks.
  for (const d of docs) for (const [c, v] of Object.entries(d?.dms || {})) if (dmConvId(v?.members || []) !== c) convs.add(c);
  // Best effort cleanup of the head blocks; orphaned tail blocks of very long
  // conversations cost nothing to leave behind.
  // The import's claim on the id goes too (see importClaimKey), so an import stopped short and taken down can be tried again under the archive's own id at once.
  const dels = [KEYS.ws(ws.id), KEYS.activity(ws.id), KEYS.sched(ws.id), importClaimKey(ws.id)];
  // The signal shards: a deleted workspace leaves no trace even for a member
  // whose handle is past the batch below and still stands (see the design
  // doc, section 7.2).
  for (let n = 0; n < EV_SHARDS; n++) dels.push(KEYS.evShard(ws.id, n));
  dels.push(KEYS.evCounter(ws.id));
  for (let n = 0; n < EV_RING_SHARDS; n++) {
    dels.push(KEYS.evPing(ws.id, n));
    for (let k = 0; k < RING_SLOTS; k++) dels.push(KEYS.evRingSlot(ws.id, n, k));
  }
  for (const hid of Object.keys(ws.webhooks || {})) dels.push(KEYS.hook(hid));
  for (const bid of Object.keys(ws.bots || {})) dels.push(KEYS.bot(bid));
  if (ws.invite) dels.push(KEYS.invite(ws.invite));
  // Its half of every connection: the ones sharing its channels (a partner
  // presenting an attestation is then told the connection has ended, as
  // for a disconnect), and the ones behind its entries for channels hosted
  // elsewhere.
  for (const c of Object.values(ws.channels)) {
    for (const conn of Object.keys(c.connections || {})) dels.push(KEYS.connect(conn));
    if (isPartnerEntry(c) && CONN_ID_RE.test(String(c.shared.conn || ''))) dels.push(KEYS.connectPartner(c.shared.conn));
    if (c.guestInvite) dels.push(KEYS.invite(c.guestInvite));
    if (c.connectInvite) dels.push(KEYS.invite(c.connectInvite));
  }
  for (const u of memberIds) dels.push(KEYS.member(ws.id, u), KEYS.inbox(ws.id, u), KEYS.threads(ws.id, u), KEYS.saved(ws.id, u));
  dels.push(KEYS.notifyAll(ws.id));
  // Threads are conversations of their own ({conv}_t{seq}), reachable only
  // through their roots' reply counts: their counters and blocks used to be
  // left behind, two keys and the replies' text per thread, for good. The
  // head blocks are read to find them, a bounded number of them, so the
  // request stays short (a very long history's oldest threads cost, like
  // its tail blocks, nothing to leave).
  let budget = 240;
  // Every read here goes a dozen at a time, as every fan-out on this server
  // does (see getMany): one round trip per conversation for its counter, one
  // per thread found, and then a read and a write per member's account
  // record, one after another as they used to be, ran a workspace of a few
  // hundred people (with the direct messages such a workspace holds) to
  // over a thousand round trips inside this one request, past what the
  // platform lets a request run, so the deletion stopped midway and left
  // the workspace half gone: its document taken, its history and its
  // members' records still there.
  const convList = [...convs];
  const seqs = await getMany(convList.map((c) => KEYS.seq(c)));
  const threads = [];
  // The records of the workspace's files go with their bytes: each is a key
  // of its own, named by the file alone (see KEYS.file), and nothing reads
  // one again once the workspace is gone, so every record left behind sat in
  // the owner's store for good, one per file ever shared here. The ids are
  // taken from where the messages name them, the blocks read below for
  // their threads (a file in a block past the budget stays, like the block),
  // from the channels' bookmarks, and from the messages waiting in the queue;
  // an upload that never reached a message is named nowhere, and stays.
  const files = new Set();
  for (const c of Object.values(ws.channels)) for (const b of c.bookmarks || []) if (typeof b?.file === 'string') files.add(b.file);
  const queue = await kv().get(KEYS.sched(ws.id)).catch(() => null);
  for (const e of Object.values(queue?.m || {})) for (const a of Array.isArray(e?.attachments) ? e.attachments : []) if (typeof a?.id === 'string') files.add(a.id);
  for (let i = 0; i < convList.length; i++) {
    const c = convList[i];
    const seq = Number(seqs[i]) || 0;
    const blocks = [];
    for (let n = blockIndexOf(Math.max(1, seq)) + 1; n >= 0; n--) blocks.push(KEYS.block(c, n));
    dels.push(...blocks, KEYS.seq(c), KEYS.pins(ws.id, c));
    for (let j = 0; j < blocks.length && budget > 0; j += 12) {
      const read = blocks.slice(j, j + Math.min(12, budget));
      budget -= read.length;
      for (const blk of await getMany(read).catch(() => [])) {
        // Every thread ever written under the block, emptied ones included (see threadsOf).
        threads.push(...threadsOf(c, blk));
        for (const m of Array.isArray(blk?.m) ? blk.m : []) for (const a of Array.isArray(m?.a) ? m.a : []) if (typeof a?.id === 'string') files.add(a.id);
      }
    }
  }
  // Counters, so nothing large comes back: one batched read rather than a
  // wave per dozen (see getMany).
  const tseqs = await getMany(threads.map((t) => KEYS.seq(t))).catch(() => threads.map(() => 0));
  const tblocks = [];
  threads.forEach((t, i) => {
    const tseq = Number(tseqs[i]) || 0;
    for (let n = blockIndexOf(Math.max(1, tseq)) + 1; n >= 0; n--) tblocks.push(KEYS.block(t, n));
    dels.push(KEYS.seq(t), KEYS.pins(ws.id, t));
  });
  dels.push(...tblocks);
  // The replies' files, from the threads' blocks, within what is left of the budget.
  for (let j = 0; j < tblocks.length && budget > 0; j += 12) {
    const read = tblocks.slice(j, j + Math.min(12, budget));
    budget -= read.length;
    for (const blk of await getMany(read).catch(() => [])) for (const m of Array.isArray(blk?.m) ? blk.m : []) for (const a of Array.isArray(m?.a) ? m.a : []) if (typeof a?.id === 'string') files.add(a.id);
  }
  for (const id of files) dels.push(KEYS.file(id));
  for (let i = 0; i < dels.length; i += 12) {
    await Promise.all(dels.slice(i, i + 12).map((k) => kv().del(k).catch(() => {})));
  }
  await deleteIndex(ws.id);
  // The attachments' bytes are what the workspace cost its owner in storage:
  // they live under one directory, gone with it (their metadata keys are
  // tiny and, like tail blocks, unreachable from now on).
  await fs().delete(`teamchat-files/${ws.id}`, { recursive: true }).catch(() => {});
  await fs().delete(iconPath(ws.id)).catch(() => {});
  // The members' account records, last: read together, and the ones that
  // still name the workspace written together (see the import, which files
  // them the same way). One left unwritten drops out of a member's list at
  // their next /api/me, which names no workspace whose document is gone.
  const people = memberIds.filter((u) => !u.startsWith('smp_'));
  const records = await getMany(people.map((u) => KEYS.user(u)));
  const filed = people.map((u, i) => [u, records[i]]).filter(([, p]) => p?.workspaces?.includes(ws.id));
  for (let i = 0; i < filed.length; i += 12) {
    await Promise.all(filed.slice(i, i + 12).map(([u, p]) => kv().update(KEYS.user(u), { workspaces: p.workspaces.filter((w) => w !== ws.id) }).catch(() => {})));
  }
  // A bounded batch of the members' cached handles, given back from the
  // documents read at the top (no extra reads, no kv().list()). Last of all,
  // because taking the workspace down is the part that must finish: a
  // request that runs out of time here leaves handles standing, which is
  // where the ones past the batch stand anyway until the owner revokes them.
  const releasing = memberIds.map((u, i) => [u, docs[i]]).filter(([, d]) => d?.ev?.h).slice(0, REVOKE_BATCH_MAX);
  for (let i = 0; i < releasing.length; i += 12) {
    await Promise.all(releasing.slice(i, i + 12).map(([u, d]) => releaseHandle(ws.id, u, d).catch(() => {})));
  }
  return { deleted: true };
}));

/**
 * A guest made a full member (by an admin, or by accepting the workspace's
 * own invite) lands in the default channels like anyone who joins, caught
 * up to their present, and stops counting as a guest where they already are.
 */
async function landPromotedGuest(ws, uuid, doc) {
  const have = new Set(doc?.channels || []);
  // Two promotions at once (two admins, or the workspace invite accepted
  // from two tabs) both found the guest outside the default channels and
  // both put them in, and both took them off the guest count of every
  // channel they were in: counted twice in the defaults and one too few as
  // a guest, for good. Entering each default is its own claim (see
  // enterChannel), so the defaults count them once whatever the two do.
  // Their arrival in the defaults is announced, as it is for anyone joining
  // by the workspace's invite.
  await landInDefaults(ws, uuid, doc, { announce: true });
  // Coming off the guest count is claimed on its own, with a count on their
  // document that only the promotion taking it from nothing to one wins (as
  // a delivery claims a scheduled entry, see claimEntry); the count goes
  // when they are made a guest again (see the role route, and /api/join,
  // which writes a guest's document afresh), so the next promotion claims
  // anew. Judged by the defaults entered, as it used to be (the promotion
  // that entered none had lost), a guest an admin had already put into every
  // default channel, or one whose two promotions each entered one of two
  // defaults, was taken off the guest count of each of their channels by
  // both: the channel then counted one guest fewer than it held, for good,
  // and the notice that a channel includes people from outside the
  // workspace, drawn from that count, stayed off it for the next guest to
  // come. The removal that closed their document after the role went on it
  // (see dropMembership) counts them out as the member they are being made,
  // so the guest they were counted in as still comes off here.
  const key = KEYS.member(ws.id, uuid);
  const res = await kv().incr(key, { promo: 1 }).catch(() => null);
  const n = res && typeof res === 'object' ? Number(res.promo) : Number(res);
  // A document of the claim alone is one the count made where a removal had
  // deleted theirs (see unwriteDocRole): it goes again, and the removal,
  // which counted them out as a member, leaves the guest to come off here.
  // Decided on the document itself, never on the shape of an answer (see
  // enterChannel): an answer with nothing of the member's on it may be the
  // part that changed, the count alone, and taken for the document it had
  // every promotion on such a store delete the guest's document, their
  // direct messages, cursors, settings and devices with it. The document
  // is read again, and only one with nothing of the member's on it goes.
  if (res && typeof res === 'object' && !Array.isArray(res) && !Object.hasOwn(res, 'joinedAt') && !Object.hasOwn(res, 'channels')) {
    const fresh = await kv().get(key).catch(() => undefined);
    if (fresh && typeof fresh === 'object' && !Array.isArray(fresh) && !Object.hasOwn(fresh, 'joinedAt') && !Object.hasOwn(fresh, 'channels')) await kv().del(key).catch(() => {});
  }
  if (Number.isFinite(n) && n !== 1) return;
  await incrPaths(KEYS.ws(ws.id), Object.fromEntries([...have].filter((ch) => ws.channels[ch]).map((ch) => [`channels.${ch}.guests`, -1])));
}

/**
 * Put a member (whose document already exists) into the default channels
 * they are not in yet, caught up to each one's present, and counted there.
 * `doc` is their document as the caller's role write handed it back (see
 * the role route). False when there were channels to enter and another
 * request for the same person put them into every one first; 'gone' when
 * they are on their way out of the workspace (see enterChannel) and entered
 * none, which is not another request's doing, and leaves the caller's own
 * counting to the caller.
 *
 * With `announce`, their arrival is written into the first channel entered
 * as it is for someone joining by the workspace's invite, "X joined", and
 * they are read past it: a guest made a member landed in #general with no
 * word, while everyone joining by the invite is announced there. Not for
 * someone whose card is gone by the count (a removal this very moment; see
 * the join routes): nothing more is written for someone who is out. The
 * line is one per channel however many promotions run at once, since
 * entering each channel is its own claim (see enterChannel).
 */
async function landInDefaults(ws, uuid, doc, { announce = false } = {}) {
  const have = new Set(doc?.channels || []);
  const defaults = Object.values(ws.channels).filter((c) => c.def && !c.archived && !have.has(c.id)).map((c) => c.id);
  if (!defaults.length) return true;
  const entered = [];
  let gone = false;
  for (const c of defaults) {
    const entry = await enterChannel(ws.id, uuid, c, doc);
    if (entry.status === 'entered') entered.push(c);
    else if (entry.status === 'gone') gone = true;
  }
  if (!entered.length) return gone ? 'gone' : false;
  const seqs = await getMany(entered.map((c) => KEYS.seq(c)));
  const reads = {};
  entered.forEach((c, i) => { reads[`reads.${c}`] = Number(seqs[i]) || 0; });
  await kv().update(KEYS.member(ws.id, uuid), reads);
  let stands = true;
  for (const ch of entered) {
    const counted = await kv().incr(KEYS.ws(ws.id), { [`channels.${ch}.count`]: 1 });
    if (counted && typeof counted === 'object' && counted.members && !own(counted.members, uuid)) stands = false;
  }
  if (announce && stands) {
    const m = ws.members[uuid];
    const joinSeq = await postSystem(ws.id, entered[0], uuid, `${m?.name || m?.username || 'Someone'} joined`);
    await kv().update(KEYS.member(ws.id, uuid), { [`reads.${entered[0]}`]: Math.max(joinSeq, reads[`reads.${entered[0]}`] || 0) });
  }
  return true;
}

router.post('/api/ws/:ws/members/:uuid/role', route(async ({ params, request, user }) => {
  const { id, ws, member } = await requireMembership(params.ws, user, { write: true, doc: false });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can change roles');
  const target = own(ws.members, params.uuid);
  if (!target) fail(404, 'not_found', 'Member not found');
  if (target.role === 'owner') fail(400, 'invalid', 'The owner role cannot be changed');
  // Someone from a connected workspace belongs to that workspace: they take
  // part in the channel shared with it and cannot be made a member here.
  if (isExternal(target)) fail(400, 'invalid', 'People from a connected workspace cannot be given a role here');
  const { role } = await readJson(request);
  if (!['admin', 'member', 'guest'].includes(role)) fail(400, 'invalid', 'Unknown role');
  // The role goes on the member's own document first, and the channels the
  // store hands back with it are the ones counted below (see enterChannel):
  // a channel they enter after this write is counted by the role they are
  // being given, one entered before is on this list and counted here, so a
  // guest made a member (or a member made a guest) while joining a channel
  // is neither counted among its guests twice nor left out of the count.
  // The card follows; a store that hands nothing back is read again.
  const doc = await writeDocRole(ws.id, params.uuid, role);
  // On their way out of the workspace this very moment: a removal has closed
  // their document (see closeMemberDoc) and counts them out of their
  // channels as what the document said when it closed, which this role was
  // not yet. Written on to the card, the role would then count them once
  // more, as what they are being made, on the channels of someone gone, for
  // good. The removal deletes the document, this write on it included.
  if (typeof doc.gone === 'number' && doc.gone + SCHED_CLAIM_MS > now()) fail(404, 'not_found', 'Member not found');
  const written = await kv().update(KEYS.ws(ws.id), { [`members.${params.uuid}.role`]: role });
  // Gone between the read above and these writes (they left, or another
  // admin removed them): the role must not bring them back (see cardStands),
  // nor the one written ahead of it on their document (see unwriteDocRole);
  // and what their removal counted by that role is made even (see evenGuestCounts).
  if (!(await cardStands(ws.id, params.uuid, written, ['role']))) {
    await unwriteDocRole(ws.id, params.uuid, doc);
    await evenGuestCounts(ws, doc, target.role, role);
    fail(404, 'not_found', 'Member not found');
  }
  // A pending transfer was offered to an admin; losing the role withdraws it.
  if (ws.transferTo === params.uuid && role !== 'admin') await kv().remove(KEYS.ws(ws.id), 'transferTo', 'transferring').catch(() => {});
  let revocations = [];
  if (target.role === 'guest' && role !== 'guest') {
    await landPromotedGuest(ws, params.uuid, doc);
  } else if (target.role !== 'guest' && role === 'guest') {
    // A guest is in this workspace's channels, not one of its people, and
    // the channels shared with other workspaces are entered on this
    // workspace's word for its people: those entries are no longer theirs,
    // and the word is taken back on each host at once (see revocationsFor;
    // a host never told lets their standing lapse within a day, see
    // /api/connect/join). Left in, the entry would sit in their sidebar
    // asking for an attestation this workspace refuses a guest.
    const entries = (doc.channels || []).filter((c) => isPartnerEntry(ws.channels[c]));
    const counters = {};
    for (const c of entries) counters[`channels.${c}.count`] = -1;
    for (const ch of doc.channels || []) if (ws.channels[ch] && !entries.includes(ch)) counters[`channels.${ch}.guests`] = 1;
    if (entries.length) await kv().update(KEYS.member(ws.id, params.uuid), { channels: doc.channels.filter((c) => !entries.includes(c)) });
    // The channels they are in count them among their guests now, and the
    // entries for channels hosted elsewhere count them out: a few writes for
    // all of them (see incrPaths), not one per channel.
    await incrPaths(KEYS.ws(ws.id), counters);
    if (entries.length) revocations = await revocationsFor(ws, params.uuid, entries).catch(() => []);
    // A guest again: the next promotion's claim on coming off the guest count starts afresh (see landPromotedGuest).
    await kv().remove(KEYS.member(ws.id, params.uuid), 'promo').catch(() => {});
    // A guest reads only the channels they are in: the public channels' keys they held are replaced.
    await bumpRingEpoch(ws.id).catch(() => {});
  }
  await pokeAndBump(ws.id, params.uuid);
  return { ok: true, ...(revocations.length ? { revocations } : {}) };
}));

/**
 * Admins: every guest, with the channels they can see. A private channel
 * the caller is not in is no channel to them, admins included (see
 * hiddenFrom, and the integrations list): a guest's channels are listed as
 * the caller can see them, with how many are kept from them, so the row
 * does not read "no channels" for a guest who is in some, and the id of a
 * private channel the caller is not in goes to them no more than its name.
 */
router.get('/api/ws/:ws/guests', route(async ({ params, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user);
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can list guests');
  const ids = Object.entries(ws.members).filter(([, m]) => m.role === 'guest').map(([u]) => u);
  const docs = await getMany(ids.map((u) => KEYS.member(ws.id, u)));
  return {
    guests: ids.map((u, i) => {
      const all = (docs[i]?.channels || []).filter((c) => own(ws.channels, c));
      const channels = all.filter((c) => !hiddenFrom(ws, doc, c));
      return { uuid: u, channels, ...(channels.length < all.length ? { hidden: all.length - channels.length } : {}), joinedAt: ws.members[u].joinedAt };
    }),
  };
}));

router.delete('/api/ws/:ws/members/:uuid', route(async ({ params, user }) => {
  const id = await identify(user);
  const target = params.uuid;
  const self = target === id.uuid;
  // Someone from a connected workspace leaving in their own right is let
  // go whether or not their standing here is current (see the leave route).
  const { ws, member } = await requireMembership(params.ws, id.uuid, { write: true, lapsed: self, doc: false });
  if (!self && !isAdmin(member)) fail(403, 'forbidden', 'Only admins can remove members');
  if (!own(ws.members, target)) fail(404, 'not_found', 'Member not found');
  // Said to whoever asked: the owner, about leaving, or an admin, about
  // removing them (who was told the owner "cannot leave" and to delete the
  // workspace, which is the owner's to do and not theirs).
  if (ws.owner === target) fail(400, 'invalid', self ? 'The owner cannot leave; delete the workspace instead' : 'The owner cannot be removed from their own workspace');
  // Their document is closed first, and what its closing hands back is the
  // list counted out of (see closeMemberDoc, enterChannel): a channel they
  // were joining in this very moment is either on it, counted in by the
  // join and out here, or not, and then counted by neither.
  const doc = await closeMemberDoc(ws.id, target);
  await dropMembership(ws, target, doc);
  await rememberFormer(ws, target);
  // An admin showing someone from a connected workspace the door keeps it
  // shut: their own workspace's next attestation would otherwise put them
  // straight back (see rememberRemoved). Leaving on their own is not that.
  if (!self && isExternal(ws.members[target])) await rememberRemoved(ws, target, id.uuid);
  await kv().remove(KEYS.ws(ws.id), `members.${target}`);
  if (ws.transferTo === target) await kv().remove(KEYS.ws(ws.id), 'transferTo', 'transferring').catch(() => {});
  // Their last heartbeat, their seat in a huddle and their typing go too (see dropPresence).
  await dropPresence(ws.id, target);
  await kv().del(KEYS.member(ws.id, target));
  await Promise.all([KEYS.inbox(ws.id, target), KEYS.threads(ws.id, target), KEYS.saved(ws.id, target)].map((k) => kv().del(k).catch(() => {})));
  await dropScheduled(ws.id, target);
  if (!target.startsWith('smp_')) {
    const p = await kv().get(KEYS.user(target));
    if (p?.workspaces?.includes(ws.id)) {
      await kv().update(KEYS.user(target), { workspaces: p.workspaces.filter((w) => w !== ws.id) });
    }
  }
  // Their watch on this workspace's shards ends with their membership,
  // ahead of the bump that announces it, so the bump itself cannot wake a
  // subscription about to be torn down.
  await releaseHandle(ws.id, target, doc).catch(() => {});
  // Every conversation key they were handed is replaced (see worker/ring.js):
  // a handle whose revoke failed must not read what is said from now on.
  await bumpRingEpoch(ws.id).catch(() => {});
  await bumpWorkspace(ws.id);
  // The seats they held on other workspaces through this one end with their
  // membership here: this workspace's word to each host, for the app to
  // carry (see revocationsFor). Without it, someone shown the door here
  // kept reading and writing in every channel shared with this workspace
  // until their standing there ran out, up to a day later.
  const revocations = await revocationsFor(ws, target, doc?.channels).catch(() => []);
  return { ok: true, ...(revocations.length ? { revocations } : {}) };
}));

/* ---- scheduled messages and reminders ----------------------------------- */

/**
 * Polls and scheduled wake-ups share the due queue and its atomic claims.
 * The earliest due time is kept on the activity document a poll already reads.
 */
const SCHED_HORIZON_MS = 400 * 86400_000;
/**
 * The queue is one document per workspace, and an entry carries its whole
 * text: a few members each holding fifty long drafts would push it past the
 * store's value limit, after which nothing could be scheduled or delivered.
 */
const SCHED_DOC_BYTES = 250_000;

/**
 * The workspace document holds every channel's description, topic and
 * bookmarks and every member's card: any member may create channels and
 * curate the bookmarks of the ones they are in, so without a ceiling one
 * could push it past the store's value limit, after which no join, role
 * change, invite or counter in the workspace could be written. Refused at
 * the two routes that add free text to it, well short of the limit.
 */
const WS_DOC_BYTES = 300_000;

function assertWorkspaceRoom(ws, { joining = false } = {}) {
  if (JSON.stringify(ws).length <= WS_DOC_BYTES) return;
  // Said to whoever is refused: an admin adding to the workspace can make
  // room; someone joining it (by its invite, or from a connected workspace)
  // cannot, and was told to remove channels of a workspace they are not in.
  if (joining) fail(400, 'limit', `${ws.name || 'This workspace'} has no room for another member right now; ask one of its admins to remove some channels, bookmarks or descriptions`);
  fail(400, 'limit', 'This workspace holds as much as it can; remove some channels, bookmarks or descriptions first');
}

/**
 * A member's own document has the same ceiling: it carries their direct
 * messages (each one an entry with its members), their read cursors and
 * settings, and nothing of it can be written once the store refuses the
 * document, not a read cursor, a badge or a push subscription. A direct
 * message is written to every participant's document, so one member could
 * fill another's by starting group conversations that named them, thousands
 * of them, each a little different; refused here, for the caller's document
 * and each participant's, well short of the limit (see also
 * LIMITS.dmsPerMember, which bounds what any one member can start).
 */
const MEMBER_DOC_BYTES = 300_000;

function assertMemberRoom(doc, name) {
  if (JSON.stringify(doc || {}).length > MEMBER_DOC_BYTES) {
    fail(400, 'limit', name ? `${name} is in as many conversations as one can hold here` : 'You are in as many conversations as one can hold here');
  }
}

function assertQueueRoom(queue) {
  if (JSON.stringify(queue).length > SCHED_DOC_BYTES) fail(400, 'limit', 'Too much is waiting to be sent in this workspace; try again once some of it has gone out');
}

async function scheduleEntry(wsId, entry) {
  await kv().update(KEYS.sched(wsId), { [`m.${entry.id}`]: entry });
  // The activity document as the bump hands it back stands in for the read
  // the lowering would make (see lowerNextDue): scheduling a message read
  // the document four times over, twice for the due time and twice for the
  // count of changes, where the store had just handed it over.
  await lowerNextDue(wsId, entry.dueAt, await bumpQueue(wsId));
}

/**
 * Note that the queue gained an entry, or one of its entries a time: a count
 * on the activity document (`qv`) that a recompute of the next due time
 * reads before and after its work (see recomputeNextDue). Written after the
 * entry itself, and before the next due time is lowered for it. Returns what
 * the store handed back (the document, on a store that answers with it).
 */
async function bumpQueue(wsId) {
  return kv().incr(KEYS.activity(wsId), { qv: 1 }).catch(() => null);
}

/** The activity document, as an answer to a write on it shows it whole (its `w` or `c` on it), or null. */
const activityDoc = (res) => (res && typeof res === 'object' && !Array.isArray(res) && (Object.hasOwn(res, 'w') || Object.hasOwn(res, 'c')) ? res : null);

/**
 * Bring the next due time down to a new entry's, never up. A due time
 * already in the past is an entry come due that no poll has delivered yet
 * (the next poll does, and recomputes from the queue, this entry included;
 * see recomputeNextDue), or one a poll is delivering this moment (its
 * recompute reads the queue again when the count of changes moved under
 * it; see bumpQueue). Written over with this entry's time, as it used to
 * be, a past due time hid the entry come due from every poll until this
 * one's time: a message due at ten, scheduled a moment before someone else
 * scheduled one for tomorrow, went out tomorrow.
 *
 * Two people scheduling in the same instant each read the same due time (or
 * none) and each wrote their own below it, and when the later landed last the
 * earlier waited for it. Neither could tell from the document: each wrote
 * what it had read to be right, and a second read of it showed each its own
 * write, or the other's, which is the same document either way. So the due
 * time is recomputed from the queue after every lowering (see
 * recomputeNextDue, which reads the queue's count of changes before and
 * after and reads again when it moved): the other's entry was in the queue
 * before it came here (see scheduleEntry), so whichever recompute writes
 * last writes the earlier of the two. Judged instead by whether the count of
 * changes moved between the read and the write, as it used to be, two
 * entries whose counts both landed before either read went unnoticed by
 * both, and a message scheduled for ten went out at the other's time.
 */
async function lowerNextDue(wsId, dueAt, known = null) {
  const key = KEYS.activity(wsId);
  // `known`: the document as a write just made on it handed it back (see
  // scheduleEntry), taken only where it is the whole document; anything less
  // (the part that changed, a count, nothing) has it read.
  const act = activityDoc(known) || (await kv().get(key)) || {};
  if (act.nd && dueAt >= act.nd) return;
  await kv().update(key, { nd: dueAt });
  await recomputeNextDue(wsId);
}

/**
 * Recompute act.nd from what is left in the queue, read afresh: an entry
 * scheduled while a delivery ran is in the store but not in the snapshot
 * the delivery worked from, and a recompute from that snapshot would leave
 * it with no due time for any poll to notice.
 *
 * Read afresh is not enough on its own: an entry scheduled after this read
 * and before this write had its own due time written (see lowerNextDue)
 * only for this write to land over it, with a later time or with none, and
 * the message was never sent until something else changed the queue. So
 * the queue's count of changes (see bumpQueue) is read before the queue and
 * again after the write: a schedule that landed in between bumped it, or is
 * about to lower the due time itself after this write, so nothing of its
 * lands unseen; when it moved, the queue is read again.
 */
async function recomputeNextDue(wsId) {
  const actKey = KEYS.activity(wsId);
  for (let round = 0; round < 3; round++) {
    const read = await kv().get(actKey).catch(() => undefined);
    const known = !!read && typeof read === 'object';
    const before = Number(read?.qv) || 0;
    const doc = (await kv().get(KEYS.sched(wsId))) || { m: {} };
    // An entry a delivery holds comes due again when that claim goes stale,
    // so a delivery that died with it is not the end of it.
    // A message that was not sent (see markFailed) is due again only once its author acts on it.
    const times = Object.values(doc.m || {}).filter((e) => e && !e.failed).map((e) => (inDelivery(e) ? e.claimedAt + SCHED_CLAIM_MS : nextTryAt(e))).filter(Number.isFinite);
    // Written only where it moves: the due time as read a moment ago (where
    // the read succeeded) already standing at what the queue says is no
    // change, and a write of the same value bought nothing; the entry just
    // lowered to is the common case. A write landing between the read and
    // here from another scheduler is followed by that scheduler's own
    // recompute, which reads after it (and the count of changes, read
    // again below, says whether the queue moved under this one).
    if (times.length) {
      const nd = Math.min(...times);
      if (!known || read.nd !== nd) await kv().update(actKey, { nd });
    } else if (!known || Object.hasOwn(read, 'nd')) await kv().remove(actKey, 'nd').catch(() => {});
    const after = Number((await kv().get(actKey).catch(() => null))?.qv) || 0;
    if (after === before) return;
  }
}

/**
 * Take what one person had waiting out of the workspace's queue, when they
 * leave or are removed. Their entries used to stay until their time came,
 * up to a year on, holding room in a queue every member's drafts share (a
 * departed member's fifty long drafts could refuse everyone else's) only to
 * be dropped unsent then; and one whose author had come back meanwhile was
 * posted, as if they had never left. The next due time follows what is left.
 * `who` is one person or a list of them (see disconnect): the queue is read
 * once for all of them, and the next due time recomputed once.
 */
async function dropScheduled(wsId, who) {
  const key = KEYS.sched(wsId);
  const gone = new Set(Array.isArray(who) ? who : [who]);
  if (!gone.size) return;
  const doc = await kv().get(key).catch(() => null);
  const all = Object.values(doc?.m || {}).filter((e) => e && e.id);
  const mine = all.filter((e) => gone.has(e.u));
  if (!mine.length) return;
  for (let i = 0; i < mine.length; i += 100) await kv().remove(key, ...mine.slice(i, i + 100).map((e) => `m.${e.id}`)).catch(() => {});
  const rest = all.filter((e) => !gone.has(e.u));
  for (const e of mine) await releaseScheduledFiles(wsId, e, rest).catch(() => {});
  await recomputeNextDue(wsId).catch(() => {});
}

/**
 * Let go of the files a scheduled message carried when the entry goes
 * without being posted: deleted by its author, refused at its time, taken
 * out with its author or its conversation. An upload is held by the
 * messages that carry it and released with the last of them; one that
 * only ever waited in the queue was never held, so its bytes stayed in the
 * owner's drive for good, ten megabytes at a time, with nothing to find
 * them by. Only the author's own uploads that nothing holds go: a file a
 * posted message carries (a forward names it) is that message's, and one
 * named by another entry still waiting (`others`) is that entry's.
 */
async function releaseScheduledFiles(wsId, entry, others) {
  const ids = [...new Set((entry?.attachments || []).map((a) => a && a.id).filter((id) => typeof id === 'string'))];
  if (!ids.length) return;
  const held = new Set();
  for (const e of others || []) for (const a of e?.attachments || []) if (a?.id) held.add(a.id);
  const metas = await getMany(ids.map((id) => KEYS.file(id)));
  // A bookmark holds a file as a message does (see releaseFile and
  // releaseBookmarkFiles): one a channel's bookmark names stays until the
  // bookmark comes down, whatever else let go of it. The workspace is read
  // for its bookmarks once, on this rare path, and only where a file is
  // about to go. Judged by the messages' count and the queue alone, as it
  // used to be, a file bookmarked while it waited with a scheduled message
  // of its uploader's (the channel's bookmarks route takes any file of the
  // workspace) went with the message when that was deleted, or refused at
  // its time and dropped, and the bookmark opened onto "Could not download
  // the file" for good.
  let keep = null;
  for (let i = 0; i < ids.length; i++) {
    const meta = metas[i];
    if (!meta || meta.ws !== wsId || meta.u !== entry.u || (Number(meta.refs) || 0) > 0 || held.has(ids[i])) continue;
    if (!keep) keep = bookmarkedFiles(await kv().get(KEYS.ws(wsId)).catch(() => null));
    if (keep.has(ids[i])) continue;
    await fs().delete(`teamchat-files/${wsId}/${ids[i]}`).catch(() => {});
    await kv().del(KEYS.file(ids[i])).catch(() => {});
  }
}

/**
 * How long a delivery may hold an entry. A poll claims an entry before
 * posting it so that no two polls post it; a worker that dies in between
 * (a request cut short under a fan-out of pushes) used to leave the claim
 * standing for good, and a claimed entry was hidden from its author,
 * refused an edit, and never due again. A claim this old is a dead one:
 * the next poll takes the entry over. Deliveries take seconds, not minutes.
 */
const SCHED_CLAIM_MS = 5 * 60_000;
/** A delivery that fails under the post (the store, not a refusal) is tried again this many times, then dropped. */
const SCHED_MAX_TRIES = 5;
const inDelivery = (e) => !!e.claims && (e.claimedAt || 0) + SCHED_CLAIM_MS > now();
/** When the entry is next due: its time, or the retry set after a failed delivery, whichever is later. */
const nextTryAt = (e) => Math.max(e.dueAt, e.retryAt || 0);

/**
 * Take an entry for delivery. The claim counter goes up by one and the entry
 * is the caller's only when it then reads one more than the queue the caller
 * read said (an add that says nothing is trusted once). A stale claim (see
 * SCHED_CLAIM_MS) is counted past, not cleared first: two polls taking over
 * the same dead delivery both read the old count, and the one whose
 * increment lands first is the one that reads it plus one. Clearing it first
 * let both win: the second poll's clearing, reaching the store after the
 * first poll's claim, wiped that claim, and its own increment then started
 * the counter again at one — and a reminder, which carries no client id
 * for a repeat to be recognised by, was delivered twice.
 * 'gone' means another poll delivered and removed the entry between this
 * poll's read of the queue and its claim: the increment then put back a
 * bare counter where the entry was, which reads as a first claim on
 * something already sent, and the stub goes.
 *
 * Returns { status, entry }: the entry as it stands at the claim, where the
 * store's answer (or the read it made necessary) shows it whole, and as the
 * caller read it otherwise. What is delivered is that entry, not the one the
 * caller read from the queue a moment before: an edit or a new time landing
 * between the caller's read and its claim used to be lost, the words the poll
 * had read going out while the author was answered that their change had
 * been saved, and a message moved to tomorrow going out now (see flushDue,
 * which lets go of a claim on an entry no longer due).
 */
async function claimEntry(key, e) {
  await kv().update(key, { [`m.${e.id}.claimedAt`]: now() }).catch(() => {});
  try {
    const res = await kv().incr(key, { [`m.${e.id}.claims`]: 1 });
    let entry = res && typeof res === 'object' ? res.m?.[e.id] : null;
    if (entry && entry.dueAt == null) {
      // Decided on the queue itself, never on the shape of an answer (see
      // enterChannel): an answer with nothing of the entry's on it may be
      // the part that changed, the count alone, and taken for the entry it
      // had every delivery on such a store take the message off the queue
      // unsent, its author told nothing. The queue is read again; only an
      // entry with no time on it goes, and a read that fails claims nothing.
      const doc = await kv().get(key).catch(() => undefined);
      if (doc === undefined) return { status: 'lost', entry: e };
      const fresh = own(doc?.m, e.id);
      if (!fresh || fresh.dueAt == null) {
        if (fresh) await kv().remove(key, `m.${e.id}`).catch(() => {});
        return { status: 'gone', entry: e };
      }
      entry = fresh;
    }
    const claims = entry ? entry.claims : res;
    const won = claims === (Number(e.claims) || 0) + 1 || claims === undefined;
    // Whole where it carries an author and a time (the fields no patch of a
    // claim, an edit or a retry writes alone); anything less is not the
    // entry, and the caller's reading stands.
    const whole = entry && typeof entry === 'object' && entry.u && entry.dueAt != null && entry.id === e.id;
    return { status: won ? 'won' : 'lost', entry: whole ? entry : e };
  } catch {
    return { status: 'lost', entry: e };
  }
}

/**
 * Let go of a claim taken on an entry that turned out not to be for
 * delivering (moved to a later time, or marked, between the poll's read of
 * the queue and its claim; see flushDue): the counter and the stamp come off,
 * and the entry is its author's again, listed and editable, due at its time.
 */
async function releaseClaim(key, id) {
  await kv().remove(key, `m.${id}.claims`, `m.${id}.claimedAt`).catch(() => {});
}

/**
 * Messages that were not sent that one member may have standing at once.
 * A refused message stays in the queue, marked, until its author edits,
 * moves, sends or deletes it (see markFailed); past this many, the oldest
 * goes with its files when another fails, so a queue every member's drafts
 * share is not filled by what one member never came back to.
 */
const FAILED_PER_MEMBER = 20;
/** The oldest first: by when it failed, then by its time, then by when it was written. */
const byFailedAge = (a, b) => (a.failed.at - b.failed.at) || (a.dueAt - b.dueAt) || ((a.createdAt || 0) - (b.createdAt || 0)) || (a.id < b.id ? -1 : 1);

/**
 * A scheduled message refused at its time (the channel archived or made
 * admins-only since, the author no longer in it, a thread's root gone, an
 * external member's standing run out) is kept for its author rather than
 * dropped: marked with when and why, in the words the live post would have
 * answered with, so the Later view can say "Not sent" and offer Edit,
 * Reschedule, Send now and Delete. Dropped, it took the words the author
 * wrote with it, with no word to them that it had not gone out. A marked
 * message is never tried again on its own (flushDue and recomputeNextDue
 * skip it); an edit or a new time clears the mark, "Send now" tries at
 * once, and Delete lets its files go, as ever. The mark goes on before the
 * claim is let go of, so a poll reading in between finds it marked and
 * leaves it. Returns the author's oldest marked message when this one puts
 * them past FAILED_PER_MEMBER, taken off the queue here for the caller to
 * release its files; `doc` (the caller's reading of the queue) is kept in
 * step so a poll marking several counts them right.
 */
async function markFailed(key, doc, e, refusal) {
  const failed = { at: now(), code: String(refusal?.code || 'refused'), message: String(refusal?.message || 'This message could not be sent') };
  await kv().update(key, { [`m.${e.id}.failed`]: failed });
  await kv().remove(key, `m.${e.id}.claims`, `m.${e.id}.claimedAt`, `m.${e.id}.tries`, `m.${e.id}.retryAt`).catch(() => {});
  const cur = doc.m[e.id] || e;
  const { claims, claimedAt, tries, retryAt, ...rest } = cur;
  doc.m[e.id] = { ...rest, failed };
  const mine = Object.values(doc.m).filter((x) => x && x.id && x.u === e.u && x.kind !== 'reminder' && x.failed).sort(byFailedAge);
  if (mine.length <= FAILED_PER_MEMBER) return null;
  const oldest = mine[0];
  await kv().remove(key, `m.${oldest.id}`).catch(() => {});
  delete doc.m[oldest.id];
  return oldest;
}

/**
 * Deliver whatever is due, from a sync poll or /due. Storage failures reach
 * /due so its handler can retry; the poll catches them in its deferred work.
 */
async function flushDue(ws) {
  // A transferred workspace is read-only here: nothing may be posted into
  // the copy that is about to be deleted, so its queue is left alone.
  // One still being imported takes no posts either: an entry come due
  // meanwhile would be refused and dropped as a refusal; it waits, and the
  // first poll once the copy is open delivers it. Nor is one being moved: the
  // queue travels with the export, and an entry delivered here would be
  // lost with this copy and delivered again on the new one.
  if (ws.movedTo || ws.importing || frozen(ws)) return;
  const wsId = ws.id;
  const key = KEYS.sched(wsId);
  const doc = (await kv().get(key)) || { m: {} };
  // A stub is what a path write leaves when the entry it patched had been
  // taken out meanwhile (a retry's note landing after its author deleted
  // the entry): the patched fields alone, with no author and no time, which
  // nothing lists, delivers or drops. It goes here, where the queue is read
  // anyway; the edit route catches its own the moment it makes one.
  for (const [id, e] of Object.entries(doc.m || {})) {
    if (e && e.u && e.dueAt != null) continue;
    await kv().remove(key, `m.${id}`).catch(() => {});
    delete doc.m[id];
  }
  const due = Object.values(doc.m || {}).filter((e) => !e.failed && nextTryAt(e) <= now() && !inDelivery(e));
  const evicted = [];
  for (const read of due) {
    const claim = await claimEntry(key, read);
    if (claim.status === 'gone') delete doc.m[read.id];
    if (claim.status !== 'won') continue;
    // Delivered as it stands at the claim (see claimEntry), not as this poll
    // read it: the words an edit landed meanwhile, the time a reschedule
    // did. One no longer due (moved to a later time, or marked, between the
    // read and the claim) is not delivered: the claim is let go of, and the
    // entry waits for its time, as its author was answered it would.
    const e = claim.entry;
    doc.m[e.id] = e;
    if (e.failed || nextTryAt(e) > now()) {
      await releaseClaim(key, e.id);
      continue;
    }
    let res;
    try {
      res = await deliver(ws, e);
    } catch (err) {
      console.error('scheduled delivery failed', e.id, err);
      // Not a refusal (deliver() swallows those) but the store failing under
      // the post: the entry is kept, unclaimed, for a later poll to try
      // again, rather than dropped with nothing posted and nothing said. A
      // few tries, spaced out, then it goes.
      const tries = (e.tries || 0) + 1;
      if (tries < SCHED_MAX_TRIES) {
        await kv().update(key, { [`m.${e.id}.tries`]: tries, [`m.${e.id}.retryAt`]: now() + 30_000 * tries }).catch(() => {});
        await kv().remove(key, `m.${e.id}.claims`).catch(() => {});
        continue;
      }
      // The last try: the entry goes unposted, and the files it waited with
      // go too (below), as with an author who is gone; they used to be left
      // in the owner's drive, held by nothing, when the entry went this way.
      res = null;
    }
    // A message refused at its time is kept for its author, marked with the
    // reason (see markFailed); the oldest such message past the cap goes,
    // and its files with it once this poll is done (below).
    if (res && typeof res === 'object') {
      const dropped = await markFailed(key, doc, e, res).catch(() => null);
      if (dropped) evicted.push(dropped);
      continue;
    }
    await kv().remove(key, `m.${e.id}`).catch(() => {});
    delete doc.m[e.id];
    // A message whose author is no longer here (deliver answers null) goes
    // unposted, and the files it waited with go as a deletion lets them go
    // (below): their exit took their entries and those files with them (see
    // dropScheduled), but an entry written in the same moment stayed, and
    // used to be dropped here with its file left in the owner's drive for good.
    if (res === null && e.kind !== 'reminder') evicted.push(e);
  }
  // The files the evicted and dropped entries waited with (see
  // releaseScheduledFiles), judged against the queue as it stands now that
  // this poll's entries are off it, not against the snapshot this poll read:
  // two polls at once, each refusing one of two entries that shared a file,
  // each read the other's entry as still waiting with it, and the file
  // stayed in the owner's drive for good. Whichever poll re-reads last finds
  // both gone. A read that fails falls back to the snapshot, which holds
  // more, never less.
  if (evicted.length) {
    const fresh = await kv().get(key).catch(() => null);
    const rest = Object.values((fresh || doc).m || {}).filter((x) => x && x.id);
    for (const e of evicted) await releaseScheduledFiles(wsId, e, rest).catch(() => {});
  }
  await recomputeNextDue(wsId);
}

/**
 * The message in `conv` written under a client id by `uuid`, if one is in
 * the newest two blocks (a repeat follows its original closely; see
 * postMessage, which looks the same way for a repeated post): the raw
 * record, or null.
 */
async function findByCid(conv, cid, uuid) {
  const head = Number(await kv().get(KEYS.seq(conv)).catch(() => 0)) || 0;
  const n = blockIndexOf(Math.max(1, head));
  const blocks = await getMany(n > 0 ? [KEYS.block(conv, n), KEYS.block(conv, n - 1)] : [KEYS.block(conv, n)]);
  for (const b of blocks) {
    const dup = (b?.m || []).find((m) => m && m.cid === cid && m.u === uuid);
    if (dup) return dup;
  }
  return null;
}

/**
 * Deliver one entry. For a message: true when it was posted (now, or by a
 * delivery that died after posting); the refusal, { code, message } as the
 * live post would have answered, when it was refused, which keeps it for its
 * author (see markFailed); null when the entry is to go (its author no
 * longer here). A reminder answers nothing: delivered, or with nothing left
 * to remind of, it goes either way.
 */
async function deliver(ws, e) {
  const member = ws.members[e.u];
  if (!member) return null; // the author is gone; the entry goes with them
  const docRaw = (await kv().get(KEYS.member(ws.id, e.u))) || {};
  const doc = { channels: docRaw.channels || [], dms: docRaw.dms || {}, reads: docRaw.reads || {}, mentions: docRaw.mentions || {}, notify: docRaw.notify || {}, threads: docRaw.threads || {}, inbox: docRaw.inbox || 0 };
  const ctx = { ws, member, doc, uuid: e.u };
  if (e.kind === 'reminder') {
    const found = await locateMessage(e.conv, e.seq).catch(() => null);
    if (!found || found.overlay.d) return; // the message is gone: nothing to remind about
    try {
      resolveConv(ctx, e.conv);
    } catch {
      return; // no longer readable
    }
    const ts = now();
    // A line in the member's own space, linking back to the message, and an
    // Activity entry. Each is written only where it is not there already:
    // a delivery that died after writing them and before taking the entry
    // off the queue is taken over by a later poll once its claim is stale,
    // and the copy of a moved workspace delivers again whatever the old
    // copy sent as the move began (its queue travels, the entry on it), so
    // the member was reminded twice, a second line under the first and a
    // second entry in Activity. The line carries the entry's id as a
    // scheduled message carries it (see postMessage), which a move keeps
    // with the message; the Activity entry carries it too (`rid`), and each
    // is looked for before it is written, the line in the newest two blocks
    // as a repeated post is, the entry in the ring as it stands.
    const self = own(doc.dms, dmConvId([e.u])) ? dmConvId([e.u]) : dmConvId([e.u], ws.id);
    if (!doc.dms[self] || !(await findByCid(self, e.id, e.u))) {
      if (!doc.dms[self]) {
        // The first block only if it is not there: two reminders of theirs
        // due at the same minute, delivered by two polls at once, each found
        // no conversation and each wrote an empty first block, the second
        // over the line the first had just put there, which was lost for good.
        await ensureBlock(self, 0);
        await kv().update(KEYS.member(ws.id, e.u), { [`dms.${self}`]: { members: [e.u], createdAt: ts } });
      }
      // Written for the member, not by them: their cursor stays where it was,
      // so the line is unread in their own space, and the activity entry says
      // the system wrote it, so an open tab does not read it as their own.
      await writeMessage(ws.id, self, { u: e.u, t: e.note ? `Reminder: ${e.note}` : 'Reminder', ts, k: 'rem', ref: { c: e.conv, s: e.seq }, cid: e.id }, { by: 'sys' });
    }
    const ring = (await kv().get(KEYS.inbox(ws.id, e.u)).catch(() => null))?.items;
    if (!(Array.isArray(ring) && ring.some((x) => x && x.k === 'reminder' && x.rid === e.id))) {
      await pushInbox(ws.id, [e.u], { k: 'reminder', c: e.conv, s: e.seq, by: e.u, ts, note: e.note || '', rid: e.id });
      await sendPushes(ws, [e.u], {
        reminder: e.id, mentioned: new Set(), conv: e.conv, mentionConv: parentOfThread(e.conv)?.conv || e.conv,
        seq: e.seq, kind: 'reminder', title: 'Reminder', body: e.note || found.overlay.t || found.raw.t || 'You asked to be reminded',
        threadRoot: parentOfThread(e.conv),
      }).catch(() => {});
    }
    await pokeMember(ws.id, e.u).catch(() => {});
    return;
  }
  // A scheduled message goes through the normal post path; a refusal (the
  // channel became admin-only, was archived, or the author left it) drops
  // the entry rather than posting it somewhere else.
  // The entry's id is the post's cid: a delivery that died after posting
  // is taken over by a later poll, whose post then finds the message and
  // does not repeat it.
  // A conversation gone since the message was scheduled: its channel was
  // deleted while the scheduling was in flight, and landed after the delete
  // had taken the queue's entries for it (see dropScheduledIn). The entry
  // goes as the deletion would have taken it, files and all (the caller
  // lets them go), rather than being posted into nothing and kept for its
  // author as "Not sent" in a conversation with no name. Direct messages
  // are never deleted.
  const base = parentOfThread(String(e.conv || ''))?.conv || String(e.conv || '');
  if (!base.startsWith('dm_') && !own(ws.channels || {}, base)) return null;
  try {
    // Someone from a connected workspace whose standing has run out cannot
    // post now, as they could not by hand; the message waits for them,
    // marked, and goes when they are vouched for again and send it.
    assertAttested(member);
    await postMessage(ctx, e.conv, { text: e.text, attachments: e.attachments || [], cid: e.id }, { scheduled: true });
    return true;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { code: err.code, message: err.message };
  }
}

/** A schedule or any member may wake the queue without a presence heartbeat. */
router.post('/api/ws/:ws/due', route(async ({ params, user }) => {
  const requestedAt = now();
  const { ws } = await requireMembership(params.ws, user, { doc: false });
  ws.channels = ws.channels || {};
  await flushDue(ws);
  // A moved or frozen workspace delivers nothing here, so retrying cannot help.
  if (ws.movedTo || frozen(ws)) return { ok: true };
  const queue = await kv().get(KEYS.sched(ws.id));
  // Backoff still needs a wake-up; future and refused entries do not.
  if (Object.values(queue?.m || {}).some((e) => e && !e.failed && e.dueAt <= requestedAt)) fail(503, 'retry', 'Scheduled delivery is still pending');
  return { ok: true };
}));

function validDue(v) {
  const t = Math.floor(Number(v));
  if (!Number.isFinite(t) || t < now() - 60_000) fail(400, 'invalid', 'Pick a time in the future');
  if (t > now() + SCHED_HORIZON_MS) fail(400, 'invalid', 'That is more than a year away');
  return t;
}

/** Schedule a message: it is checked now as if posted, then queued for its time. */
router.post('/api/ws/:ws/scheduled', route(async ({ params, request, user }) => {
  const ctx = await requireMembership(params.ws, user, { write: true });
  const id = ctx.id;
  const body = await readJson(request);
  const conv = resolveConv(ctx, String(body.conv || ''));
  // Refused as the post itself would be, code and words (see refusePost).
  if (!conv.canPost) refusePost(conv);
  const text = cleanText(body.text, LIMITS.messageText);
  const named = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, LIMITS.attachmentsPerMessage)
    .filter((a) => a && typeof a.id === 'string' && /^[a-z0-9]{8,24}$/.test(a.id)).map((a) => ({ id: a.id }));
  if (!text && !named.length) fail(400, 'invalid', 'Write something first');
  // The files are judged now as the post itself judges them (see
  // postMessage): a file of this workspace, and one the author may take
  // (see mayTakeFile; a guest's own uploads and what is shared where they
  // can read). Taken by the shape of their ids alone, as they used to be,
  // an id of nothing, or of a file the author had no right to, waited in
  // the queue until its time, when the delivery dropped the file from
  // under the words without a word to the author, or, with no words
  // beside it, marked the message "Not sent" for a reason they could have
  // been told at once. What the post would drop is dropped here, and what
  // it would refuse is refused here, in its words.
  const metas = named.length ? await getMany(named.map((a) => KEYS.file(a.id))) : [];
  const attachments = named.filter((a, i) => metas[i] && metas[i].ws === params.ws && mayTakeFile(ctx, a.id, metas[i]));
  if (!text && !attachments.length) fail(400, 'invalid', 'Those files are not in this workspace');
  // What the post itself would refuse is refused here, to the author: a
  // broadcast they may not send where they are sending it, and a thread
  // whose root is gone. The delivery drops a refused entry quietly, which is
  // right for one nobody is watching, and used to be the only answer these
  // ever got: accepted now, and at their time neither posted nor kept.
  assertBroadcast(ctx, conv, text);
  await assertThreadRoot(conv);
  const dueAt = validDue(body.dueAt);
  const queue = (await kv().get(KEYS.sched(params.ws))) || { m: {} };
  const mine = Object.values(queue.m || {}).filter((e) => e.u === id.uuid && e.kind !== 'reminder');
  if (mine.length >= LIMITS.scheduledPerMember) fail(400, 'limit', `You can have up to ${LIMITS.scheduledPerMember} scheduled messages`);
  assertQueueRoom(queue);
  const entry = { id: uid(10), kind: 'message', u: id.uuid, conv: conv.id, text, attachments, dueAt, createdAt: now() };
  await scheduleEntry(params.ws, entry);
  return { scheduled: entry };
}));

/** Set a reminder about a message for yourself. */
router.post('/api/ws/:ws/reminders', route(async ({ params, request, user }) => {
  const ctx = await requireMembership(params.ws, user, { write: true });
  const id = ctx.id;
  const body = await readJson(request);
  const conv = String(body.conv || '');
  const seq = Math.floor(Number(body.seq));
  if (!/^[a-z0-9_]{1,64}$/.test(conv) || !Number.isInteger(seq) || seq < 1) fail(400, 'invalid', 'Bad message reference');
  resolveConv(ctx, conv);
  const found = await locateMessage(conv, seq);
  if (!found || found.overlay.d) fail(404, 'not_found', 'Message not found');
  const dueAt = validDue(body.dueAt);
  const queue = (await kv().get(KEYS.sched(params.ws))) || { m: {} };
  const mine = Object.values(queue.m || {}).filter((e) => e.u === id.uuid && e.kind === 'reminder');
  if (mine.length >= LIMITS.remindersPerMember) fail(400, 'limit', `You can have up to ${LIMITS.remindersPerMember} reminders`);
  assertQueueRoom(queue);
  const entry = { id: uid(10), kind: 'reminder', u: id.uuid, conv, seq, note: cleanLine(body.note, 120), dueAt, createdAt: now() };
  await scheduleEntry(params.ws, entry);
  return { reminder: entry };
}));

/** The caller's own pending items: scheduled messages and reminders. */
router.get('/api/ws/:ws/scheduled', route(async ({ params, user }) => {
  // The queue is keyed on the workspace alone, so it comes up with the
  // caller's own document rather than after it.
  const ctx = await requireMembership(params.ws, user, { also: [KEYS.sched(params.ws)] });
  const id = ctx.id;
  const key = KEYS.sched(params.ws);
  const queue = ctx.extra[0] || { m: {} };
  const mine = Object.values(queue.m || {}).filter((e) => e.u === id.uuid && !inDelivery(e)).sort((a, b) => a.dueAt - b.dueAt);
  // A reminder shows its message only while the caller may still read where
  // it was posted (as the saved list does): out of the private channel, the
  // message and its later edits are no longer theirs to see.
  const all = mine.filter((e) => e.kind === 'reminder').map((r) => ({ ...r, c: r.conv, s: r.seq }));
  const reminders = readable(ctx, all);
  const withMessages = await attachMessages(reminders);
  // A reminder about a message that is gone (deleted since, a root whose
  // thread keeps a tombstone included, or a number nothing was ever posted
  // under), or about a conversation gone for good, stood in the list until
  // its time as a row that opened onto nothing; the delivery then found
  // nothing to remind of and dropped it. It goes now, off the queue as well
  // (as the saved list lets a saved message go), and only where its block
  // was actually read: one past the blocks a single answer reads is merely
  // not shown yet, and one out of reach for now (a private channel left)
  // stays, hidden, as before.
  // Not while the workspace is still being imported: its history is on its
  // way page by page, so a reminder's message not there yet is not gone,
  // and nothing is let go of until the import has finished. Nor on a copy
  // that has moved, or is being moved (see GET /pins): the queue travels
  // with the move, and is tidied where it delivers.
  const frozenOrMoved = ctx.ws.importing || ctx.ws.movedTo || frozen(ctx.ws);
  const read = new Set(frozenOrMoved ? [] : blockKeysOf(reminders, 12));
  const gone = new Set(frozenOrMoved ? [] : [
    ...all.filter((e) => isGone(ctx, e.c)).map((e) => e.id),
    ...withMessages.filter((e) => read.has(KEYS.block(e.c, blockIndexOf(e.s))) && (!e.message || e.message.deleted)).map((e) => e.id),
  ]);
  if (gone.size) {
    await kv().remove(key, ...[...gone].map((rid) => `m.${rid}`)).catch(() => {});
    await recomputeNextDue(params.ws).catch(() => {});
  }
  return {
    scheduled: mine.filter((e) => e.kind !== 'reminder'),
    reminders: withMessages.filter((e) => !gone.has(e.id)).map(({ c, s, ...r }) => r),
  };
}));

/**
 * Edit, reschedule (snooze), or send now. Only the author's own entries. A
 * write like any other: the queue of a workspace that moved went with it,
 * and an edit or a deletion here would be answered as done and never reach
 * the copy that will deliver the entry, so a moved copy answers 423 with
 * the new reference, as every write does, and the client follows.
 */
router.put('/api/ws/:ws/scheduled/:id', route(async ({ params, request, user }) => {
  const { id, ws, member, doc, extra } = await requireMembership(params.ws, user, { write: true, also: [KEYS.sched(params.ws)] });
  const key = KEYS.sched(params.ws);
  const queue = extra[0] || { m: {} };
  const e = own(queue.m, params.id);
  if (!e || e.u !== id.uuid) fail(404, 'not_found', 'Nothing scheduled with that id');
  // An entry a poll has claimed is going out this moment, and is said to be,
  // as the delete route says it (the list a tab holds may be a poll behind,
  // and still offer Edit, Reschedule and Send now on it). Refused as nothing
  // scheduled with that id, as it used to be, the author was told of a
  // message that was not there while it was being posted under their name;
  // a claim gone stale (a delivery that died) is no delivery, and the entry
  // is theirs again.
  if (inDelivery(e)) fail(409, 'sending', e.kind === 'reminder' ? 'This reminder is being delivered already' : 'This message is being sent already');
  const body = await readJson(request);
  if (body.sendNow) {
    if (e.kind === 'reminder') fail(400, 'invalid', 'A reminder cannot be sent');
    // Posted here, as the author, so that a refusal (the channel became
    // admins-only or archived, or the author left it) is answered and the
    // entry kept for them to move or delete — the poll's delivery drops a
    // refused entry quietly, which is right for one nobody is watching, and
    // used to be what "Send now" did too, answering that it was sent.
    // Claimed first, as the poll claims: an entry due at this very moment is
    // one or the other's to send, never both.
    const claim = await claimEntry(key, e);
    // Gone between this request's read of the queue and its claim (sent by
    // a poll, or deleted from another tab): nothing scheduled by that id, as
    // the read at the top would have said a moment later, and as the delete
    // route says it; answered as a message being sent, as it used to be, the
    // Later view was told of a sending that was not happening.
    if (claim.status === 'gone') fail(404, 'not_found', 'Nothing scheduled with that id');
    if (claim.status !== 'won') fail(409, 'sending', 'This message is being sent already');
    // Sent as it stands at the claim (see claimEntry): the words an edit from another tab landed a moment ago.
    const cur = claim.entry;
    try {
      // Sent from the queue (`scheduled`), as a delivery at its time sends
      // it: the author presses "Send now" in the Later view, not in the
      // conversation, so their cursor follows the message only where
      // nothing was unread before it, and the entry marks the message for
      // their own tabs (see postMessage, writeMessage). Posted as a live one,
      // as it used to be, the cursor moved to the message over everything
      // posted there since it was scheduled, and the conversation lost its
      // bold and its count with nothing seen, on this device and, since
      // the entry bore no mark, on every other tab of theirs.
      await postMessage({ ws, member, doc, uuid: id.uuid }, cur.conv, { text: cur.text, attachments: cur.attachments || [], cid: cur.id }, { scheduled: true });
    } catch (err) {
      // Refused: the message is kept for its author, marked with the reason
      // as a refusal at its time marks it (see markFailed), and the refusal
      // is answered; the store failing under the post lets the claim go.
      if (err instanceof HttpError) {
        const dropped = await markFailed(key, queue, e, { code: err.code, message: err.message }).catch(() => null);
        if (dropped) await releaseScheduledFiles(params.ws, dropped, Object.values(((await kv().get(key).catch(() => null)) || queue).m || {}).filter((x) => x && x.id)).catch(() => {});
        await recomputeNextDue(params.ws).catch(() => {});
      } else await kv().remove(key, `m.${e.id}.claims`).catch(() => {});
      throw err;
    }
    await kv().remove(key, `m.${e.id}`).catch(() => {});
    await recomputeNextDue(params.ws);
    return { ok: true, sent: true, ...(cur.scheduleId ? { previousScheduleId: cur.scheduleId } : {}) };
  }
  const patch = {};
  if (body.text !== undefined) {
    if (e.kind === 'reminder') patch[`m.${e.id}.note`] = cleanLine(body.text, 120);
    else {
      const text = cleanText(body.text, LIMITS.messageText);
      if (!text && !(e.attachments || []).length) fail(400, 'invalid', 'Write something first');
      // A broadcast written in by the edit is checked as scheduling it would
      // have; where the author can no longer see the conversation there is
      // nothing to check it against, and the delivery will refuse the whole.
      let conv = null;
      try {
        conv = resolveConv({ ws, member, doc }, e.conv);
      } catch {
        conv = null;
      }
      if (conv) assertBroadcast({ ws, member, doc, uuid: id.uuid }, conv, text);
      // Growing text is measured against the queue's room, as scheduling it
      // was: edits are how a queue of short entries could otherwise swell
      // past what the store takes and stop every delivery in the workspace.
      if (text.length > (e.text || '').length) assertQueueRoom({ ...queue, m: { ...queue.m, [e.id]: { ...e, text } } });
      patch[`m.${e.id}.text`] = text;
    }
  }
  if (body.dueAt !== undefined) {
    patch[`m.${e.id}.dueAt`] = validDue(body.dueAt);
    patch[`m.${e.id}.scheduleId`] = null;
  }
  if (body.scheduleId !== undefined) {
    if (body.scheduleFor !== undefined && body.scheduleFor !== e.dueAt) fail(409, 'rescheduled', 'The scheduled time changed');
    if (body.scheduleId !== null && (typeof body.scheduleId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(body.scheduleId))) fail(400, 'invalid', 'Bad schedule id');
    patch[`m.${e.id}.scheduleId`] = body.scheduleId;
  }
  if (!Object.keys(patch).length) fail(400, 'invalid', 'Nothing to change');
  const res = await kv().update(key, patch);
  // A path write makes an entry where there was none: a delivery (or a
  // deletion from another tab) that took the entry out between this
  // request's read of the queue and its write left the patched fields
  // standing alone, with no author, kind or time, which no list showed, no
  // poll delivered and nothing ever removed, holding the queue's room for
  // good. What came back from the write, or the queue read again, says
  // whether the entry is whole; a stub is taken out and the edit refused.
  const answered = !!(res && typeof res === 'object' && res.m);
  let after = answered ? own(res.m, e.id) : own((await kv().get(key))?.m, e.id);
  // Decided on the queue itself, never on the shape of an answer (see
  // enterChannel, and claimEntry): an answer with nothing of the entry's on
  // it may be the part that changed, the patched fields alone, and taken for
  // the entry it had every edit on such a store take the message off the
  // queue and refuse the edit as nothing scheduled. Read once more where the
  // answer is all there is; only an entry with no author on it goes.
  if (after && !after.u && answered) after = own((await kv().get(key))?.m, e.id);
  if (after && !after.u) {
    await kv().remove(key, `m.${e.id}`).catch(() => {});
    fail(404, 'not_found', 'Nothing scheduled with that id');
  }
  // No entry at all where the write landed: deleted from another tab
  // between this request's read and its write, and the stub the write made
  // swept away by a poll before the queue was read again (see flushDue).
  // With nothing to judge by, the edit used to be answered as saved.
  if (!after) fail(404, 'not_found', 'Nothing scheduled with that id');
  // Claimed by a poll between this request's read of the queue and its
  // write: the delivery works from the entry as it stood at the claim (see
  // claimEntry), which this change is not part of, and the message is going
  // out as it was. Said so, as it is said above for a claim read at the
  // top, rather than answering that the change was saved (the words then
  // went out unchanged; a message moved to tomorrow went out now, "moved").
  if (after && inDelivery(after)) fail(409, 'sending', e.kind === 'reminder' ? 'This reminder is being delivered already' : 'This message is being sent already');
  // A message that was not sent (see markFailed) is the author's again once
  // they have edited or moved it: the mark goes, after the change is written
  // so a poll never sends the old words, and it is due at its time (an edit
  // alone leaves the time it failed at, so the next poll tries it at once).
  if (e.failed && (body.text !== undefined || body.dueAt !== undefined)) await kv().remove(key, `m.${e.id}.failed`, `m.${e.id}.tries`, `m.${e.id}.retryAt`).catch(() => {});
  // A time changed, or a mark cleared, makes the entry due anew: noted for a
  // recompute under way elsewhere (see bumpQueue), whose write would
  // otherwise land over the one below.
  await bumpQueue(params.ws);
  await recomputeNextDue(params.ws);
  return { ok: true, ...(e.scheduleId ? { previousScheduleId: e.scheduleId } : {}) };
}));

router.delete('/api/ws/:ws/scheduled/:id', route(async ({ params, user }) => {
  const { id, extra } = await requireMembership(params.ws, user, { write: true, doc: false, also: [KEYS.sched(params.ws)] });
  const key = KEYS.sched(params.ws);
  const queue = extra[0] || { m: {} };
  const e = own(queue.m, params.id);
  if (!e || e.u !== id.uuid) fail(404, 'not_found', 'Nothing scheduled with that id');
  // An entry a poll has claimed is going out this moment: taking it off the
  // queue now would answer "deleted" for a message that is posted all the
  // same (the list a tab holds may be a poll behind, and still show it). It
  // is said so instead, as the edit route says; a claim gone stale (a
  // delivery that died) is no delivery, and the entry is the author's to take.
  if (inDelivery(e)) fail(409, 'sending', e.kind === 'reminder' ? 'This reminder is being delivered already' : 'This message is being sent already');
  // Claimed first, as a delivery claims it and as "Send now" does (see
  // claimEntry): a poll that claimed the entry between this request's read
  // of the queue and this line is posting it, and taking the entry off the
  // queue under it answered "deleted" for a message that went out all the
  // same. One that is gone already (delivered, or deleted from another tab)
  // is answered as nothing scheduled, as it would have been a moment later.
  const claim = await claimEntry(key, e);
  if (claim.status === 'gone') fail(404, 'not_found', 'Nothing scheduled with that id');
  if (claim.status !== 'won') fail(409, 'sending', e.kind === 'reminder' ? 'This reminder is being delivered already' : 'This message is being sent already');
  await kv().remove(key, `m.${e.id}`);
  await releaseScheduledFiles(params.ws, claim.entry, Object.values(queue.m).filter((x) => x && x.id !== e.id)).catch(() => {});
  await recomputeNextDue(params.ws);
  return { ok: true, ...(claim.entry.scheduleId ? { previousScheduleId: claim.entry.scheduleId } : {}) };
}));

/* ---- push subscriptions --------------------------------------------------- */

/** A device's quiet hours, pause, and offset from UTC, as pushAllowed reads them. */
function pushPrefsFrom(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    pauseUntil: Number(p.pauseUntil) || null,
    tzOffset: Number(p.tzOffset) || 0,
    dnd: p.dnd && typeof p.dnd === 'object' ? { enabled: !!p.dnd.enabled, from: Number(p.dnd.from), to: Number(p.dnd.to) } : null,
  };
}

/** This worker's VAPID public key, which the browser needs to subscribe. */
router.get('/api/ws/:ws/push/key', route(async ({ params, user }) => {
  await requireMembership(params.ws, user, { doc: false });
  return { key: (await vapidKeys()).pub };
}));

/**
 * Register (or refresh) this device's subscription for the caller in a
 * workspace, along with the device's quiet hours and pause so pushes can
 * respect them while the app is closed. Keyed by a hash of the endpoint.
 */
router.post('/api/ws/:ws/push', route(async ({ params, request, user }) => {
  const { id, doc } = await requireMembership(params.ws, user);
  const body = await readJson(request);
  const sub = body.subscription;
  // A push endpoint is an outbound request the worker will make later, so
  // it passes the same host checks as a link preview: public https only.
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !allowedUrl(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) fail(400, 'invalid', 'Bad push subscription');
  // The subscription is kept on the member document, which every request
  // of theirs reads and every fan-out to the channel's members reads with
  // the others': it is bounded like anything else stored. Real endpoints
  // run to a few hundred characters, the keys to 87 and 22.
  if (sub.endpoint.length > 2048 || String(sub.keys.p256dh).length > 256 || String(sub.keys.auth).length > 128) fail(400, 'invalid', 'Bad push subscription');
  const sid = (await sha256(sub.endpoint)).slice(0, 16);
  const existing = doc.push || {};
  if (!existing[sid] && Object.keys(existing).length >= PUSH_DEVICES) fail(400, 'limit', `Up to ${PUSH_DEVICES} devices per workspace`);
  const prefs = pushPrefsFrom(body.prefs);
  const written = await kv().update(KEYS.member(params.ws, id.uuid), {
    [`push.${sid}`]: { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, prefs, preview: body.preview !== false, ts: now() },
  });
  // Two devices subscribing in the same instant each found room and each
  // wrote, and the member held one more than the cap for good. What the
  // store hands back from the write (or the document read again) is
  // trimmed to the cap, the oldest subscriptions going first; the newest N
  // stay, this one among them.
  const after = written && typeof written === 'object' && written.push ? written.push : (await kv().get(KEYS.member(params.ws, id.uuid)))?.push;
  const subs = Object.entries(after || {});
  if (subs.length > PUSH_DEVICES) {
    subs.sort((a, b) => (Number(a[1]?.ts) || 0) - (Number(b[1]?.ts) || 0));
    await kv().remove(KEYS.member(params.ws, id.uuid), ...subs.slice(0, subs.length - PUSH_DEVICES).map(([k]) => `push.${k}`)).catch(() => {});
  }
  return { ok: true, id: sid };
}));

router.delete('/api/ws/:ws/push', route(async ({ params, request, user }) => {
  const { id } = await requireMembership(params.ws, user, { doc: false });
  const body = await readJson(request);
  if (typeof body.endpoint !== 'string') fail(400, 'invalid', 'Which device?');
  const sid = (await sha256(body.endpoint)).slice(0, 16);
  await kv().remove(KEYS.member(params.ws, id.uuid), `push.${sid}`).catch(() => {});
  return { ok: true };
}));

/** Puter notification opt-in and quiet hours, shared across the member's devices. */
router.post('/api/ws/:ws/pn', route(async ({ params, request, user }) => {
  const { id, ws, doc } = await requireMembership(params.ws, user);
  const body = await readJson(request);
  const pn = { prefs: pushPrefsFrom(body.prefs), preview: body.preview !== false, ts: now() };
  await kv().update(KEYS.member(params.ws, id.uuid), { pn });
  if ((await serverConfig()).owner !== id.uuid) await ensureHandle(ws.id, id.uuid, doc, ws.name).catch(() => {});
  return { ok: true };
}));

router.delete('/api/ws/:ws/pn', route(async ({ params, user }) => {
  const { id } = await requireMembership(params.ws, user, { doc: false });
  await kv().remove(KEYS.member(params.ws, id.uuid), 'pn').catch(() => {});
  return { ok: true };
}));

/* ---- sync (polling) ---------------------------------------------------- */

/** Typing entries older than this are gone; a little wider than the client's throttle. */
const TYPING_FRESH_MS = 8000;
// The activity document keeps one entry per conversation ever written in,
// threads included, and a thread's entry has nothing to remove it once the
// thread goes quiet, so a busy workspace's document grew by every thread
// ever opened, sent whole with each bootstrap, until it met the value limit
// and every post failed. Past this many entries, a poll drops the thread
// entries quiet the longest (a hundred a time); a reply or a reaction in
// such a thread writes its entry back, so nothing is lost but a stamp.
const ACTIVITY_PRUNE_AT = 1000;
const THREAD_ENTRY_QUIET_MS = 30 * 24 * 3600 * 1000;
/**
 * The most the activity document may run to before a poll lets go of its
 * quietest thread and direct-message entries whatever their age: well under
 * the store's ceiling (400 KB), with room for every member's heartbeat,
 * status and stamp and every channel's entry beside some two thousand of them.
 */
const ACTIVITY_BYTES = 250 * 1024;
/** Prune stale typing entries once the map holds more than this many. */
const TYPING_PRUNE_AT = 20;

/**
 * "I am typing here": one path write into the activity document, the same
 * shape as the presence heartbeat, expiring by time so a closed tab never
 * leaves a stuck indicator. `stop` removes it early (on send or clear).
 */
router.post('/api/ws/:ws/conv/:conv/typing', route(async ({ params, request, user, defer }) => {
  const ctx = await requireMembership(params.ws, user);
  const id = ctx.id;
  const conv = resolveConv(ctx, params.conv);
  if (!conv.canPost) return { ok: true };
  // Typing in a thread names a root that exists, as a reply must: the
  // conversation id alone would let any spelling of a thread mint an entry
  // in the shared activity document, without bound, until the document met
  // the store's value limit and every post in the workspace failed.
  if (conv.kind === 'thread') {
    const root = await locateMessage(conv.parent.conv, conv.parent.seq);
    if (!root || root.overlay.d) fail(404, 'not_found', 'Message not found');
  }
  const body = await readJson(request);
  const path = `t.${params.conv}.${id.uuid}`;
  if (body.stop) {
    await kv().remove(KEYS.activity(params.ws), path).catch(() => {});
  } else {
    const at = now();
    await kv().update(KEYS.activity(params.ws), { [path]: at });
    // Only the first write of a typing burst signals: the composer already
    // rate-limits itself to one write per few seconds per conversation, and a
    // woken client that finds a fresh typing entry in its open conversation
    // switches to the existing faster typing poll on its own, so every write
    // after the first is covered without a signal of its own. `first` absent
    // (an old client, which has no notion of it) is treated as "first" —
    // conservative in the safe direction — so it is only skipped on an
    // explicit `first: false`, which is what a new client sends for every
    // write after the burst's own.
    //
    // The ring entry names who is typing, which is all a poll woken by it
    // would have learnt.
    if (body.first !== false) defer(() => signal(params.ws, audienceOf(conv), { entries: [{ conv: params.conv, body: { ty: { u: id.uuid, at } } }], ws: ctx.ws }));
  }
  return { ok: true };
}));

/* ---- huddles ----------------------------------------------------------- */

/**
 * A huddle is over: its entry leaves the activity document and the
 * conversation gets a line saying how long it ran. Several polls may notice
 * the same ending at once, so the line is claimed first with an atomic
 * increment (the poll that takes the counter from nothing to one writes it;
 * the rest only tidy), as scheduled delivery does. The counter lives beside
 * the roster, under the huddle's start stamp (`he.{conv}.t{at}`), not on the
 * entry itself: a poll that read the roster before the winner removed it
 * and claimed after would find a counter on the entry gone and start it
 * again at one, and the line would be written twice. A conversation's older
 * counters, all settled by then, go with the winner's tidy.
 */
async function endHuddle(wsId, conv, entry, act = null, ws = null, audience = null) {
  const key = KEYS.activity(wsId);
  // A channel deleted while a seat was still being written (a heartbeat
  // that read the channel a moment before the delete took its roster; see
  // the delete route) leaves a roster behind with no channel under it. It
  // goes, claims and all, and nothing else is written: the line, and the
  // claim on it, minted a block and an activity entry for a channel that
  // was no longer there. Direct messages are never deleted, and a huddle is
  // never in a thread. (`ws` as the caller read it; without it, as before.)
  if (ws && !String(conv).startsWith('dm_') && !own(ws.channels || {}, conv)) {
    await kv().remove(key, `h.${conv}`, ...Object.keys(act?.he?.[conv] || {}).map((s) => `he.${conv}.${s}`)).catch(() => {});
    return;
  }
  const stamp = `t${typeof entry?.at === 'number' ? entry.at : 0}`;
  let won = true;
  try {
    const res = await kv().incr(key, { [`he.${conv}.${stamp}`]: 1 });
    const claims = res && typeof res === 'object' ? res.he?.[conv]?.[stamp] : res;
    won = claims === 1 || claims === undefined;
  } catch {
    won = false;
  }
  const drop = [`h.${conv}`];
  if (won) for (const old of Object.keys(act?.he?.[conv] || {})) if (old !== stamp) drop.push(`he.${conv}.${old}`);
  await kv().remove(key, ...drop).catch(() => {});
  if (!won) return;
  // A roster nobody was ever on is not a huddle that ended: the count a
  // start claims its line with is written after the seat, and a poll that
  // tidied the roster away between the two (an old entry it had read as
  // stale) leaves the count standing alone, an entry with no seat on it.
  // The next poll takes it out here; a line for it would say a huddle that
  // nobody saw begin had ended, with no duration to give. A roster whose
  // seats were all taken away (someone removed from the workspace in the
  // middle of a huddle they were alone in) still carries its emptied seat
  // map, and was a huddle: it gets its line.
  if (!entry?.m || typeof entry.m !== 'object') return;
  // Nor does an archived channel take the line (`ws`, when the caller has
  // the workspace). Archiving ends the channel's huddle itself, with its
  // line, while the channel is still open (see the edit route); a seat that
  // a heartbeat wrote after that, having read the channel open a moment
  // before, made a roster of one in a closed channel, and tidying it (by the
  // poll, or by that tab giving the seat up) wrote "Huddle ended" into a
  // channel that takes no lines, lighting it up as unread for everyone in it.
  if (ws && own(ws.channels || {}, conv)?.archived) return;
  const startedAt = typeof entry?.at === 'number' ? entry.at : null;
  const text = startedAt ? `Huddle ended after ${durationText(now() - startedAt)}` : 'Huddle ended';
  // Drawn as the starter's, written as the system's (see postSystem): the
  // starter is wherever they went during the call (the dock follows them
  // through the app), and named as the writer, their own tabs took the
  // line for a message of theirs from another tab and marked the
  // conversation read to it, its bold and its count gone with nothing seen.
  await postSystem(wsId, conv, entry?.by || 'sys', text, { by: 'sys' }).catch(() => {});
  await signal(wsId, audience);
}

/**
 * "I am in the huddle here": start one, join the one in progress, or, sent
 * again every HUDDLE_HEARTBEAT_MS, stay in it. The body carries the invite
 * code of the caller's own Puter Peer server, which is what the others dial;
 * the roster that comes back is what the caller dials. Threads have no
 * huddles of their own (the conversation's is theirs), and a channel has to
 * be joined, not merely previewed.
 *
 * One seat per account, held by one tab: the body names the tab (`sid`)
 * and whether this is its join (`join`) or a heartbeat. A join takes the
 * seat, from another tab of the same account too; a heartbeat for a seat
 * that another tab has since taken is refused (`replaced`), so the tab that
 * joined last keeps it, whichever beats first.
 */
router.post('/api/ws/:ws/conv/:conv/huddle', route(async ({ params, request, user, defer }) => {
  const ctx = await requireMembership(params.ws, user);
  const id = ctx.id;
  const conv = resolveConv(ctx, params.conv);
  if (conv.kind === 'thread') fail(400, 'invalid', 'Huddles happen in a channel or a direct message, not in a thread');
  if (conv.channel?.archived) fail(403, 'archived', 'This channel is archived');
  if (!conv.joined) fail(403, 'not_joined', 'Join the channel to huddle in it');
  const audience = audienceOf(conv);
  const body = await readJson(request);
  const invite = typeof body.invite === 'string' && INVITE_RE.test(body.invite) ? body.invite : null;
  if (!invite) fail(400, 'invalid', 'A huddle needs the invite code of your peer server');
  const sid = typeof body.sid === 'string' && SESSION_RE.test(body.sid) ? body.sid : null;
  const ts = now();
  const key = KEYS.activity(params.ws);
  const act = (await kv().get(key)) || {};
  const raw = act.h?.[params.conv];
  let cur = liveHuddle(raw, ts);
  // A seat kept, or taken, in a huddle already going on is written while
  // the workspace is being moved to another server (see assertWritable, and
  // the renewal in /api/connect/join): the roster is the moment's and
  // travels with no move, so nothing of it is lost, while refusing the beat
  // ended every call in the workspace within a minute of the move
  // beginning, each tab told the workspace was being moved. Starting one
  // waits for the move, as a post does: its line, and the call a direct
  // message's others are told of, would be lost with the copy left behind.
  // A copy that has moved, or is still being imported, takes no seat at all.
  assertWritable(ctx.ws, { moving: !!cur });
  const mine = cur?.m?.[id.uuid] || null;
  const heldBy = mine && typeof raw.m[id.uuid].s === 'string' ? raw.m[id.uuid].s : null;
  if (sid && heldBy && heldBy !== sid && body.join !== true) fail(409, 'replaced', 'You joined this huddle from another tab');
  const seat = { at: ts, j: mine ? mine.j : ts, inv: invite };
  if (sid) seat.s = sid;
  let started = false;
  if (!cur) {
    // Nobody live here: this call starts the huddle. Two people starting
    // it in the same instant both write their own path, and both end up in
    // it; whoever's stamp lands last is "who started it", which is fair.
    // An entry everyone has gone quiet from that no poll has tidied yet is
    // a huddle that is over: it ends here, with its line, before this one
    // begins, rather than vanishing under the new roster.
    if (raw) await endHuddle(params.ws, params.conv, raw, act, ctx.ws, audience).catch(() => {});
    await kv().update(key, {
      [`h.${params.conv}.by`]: id.uuid,
      [`h.${params.conv}.at`]: ts,
      [`h.${params.conv}.m.${id.uuid}`]: seat,
    });
    // The line, and the call the others in a direct message are told of,
    // are one per huddle: claimed with an atomic count on the roster (which
    // goes when the huddle ends), the way an ended huddle's line is claimed,
    // after the seat is written so no poll finds a roster with nobody in
    // it. Two people starting the huddle together used to write two lines,
    // ring each other twice in a direct message, and each be handed a
    // roster with only themself, so neither dialled the other until a poll.
    const res = await kv().incr(key, { [`h.${params.conv}.n`]: 1 }).catch(() => null);
    const n = res && typeof res === 'object' ? res.h?.[params.conv]?.n : res;
    started = n === 1 || n === undefined || n === null;
  } else {
    if (!mine && Object.keys(cur.m).length >= HUDDLE_MAX) fail(409, 'full', `A huddle holds up to ${HUDDLE_MAX} people`);
    const res = await kv().update(key, { [`h.${params.conv}.m.${id.uuid}`]: seat });
    // The roster was taken down between this beat's read of it and this
    // write: every seat on it had gone quiet by the poll's clock (this one
    // by a fraction of a second more than by this beat's), the poll ended
    // the huddle with its line, and the seat written here made a roster of
    // the seat alone, with no start. Everyone was then shown a huddle in
    // progress that nobody had started, under a line saying it had ended,
    // and its end, when it came, had no duration to give. Where the store's
    // answer shows the roster so (as every claim here reads its answer, and
    // only where the answer is the document), this beat begins the huddle
    // anew, as it would have had it found no roster: its start, its line,
    // and the call the others in a direct message are told of.
    let after = res && typeof res === 'object' ? res.h?.[params.conv] : undefined;
    // Decided on the document itself, never on the shape of an answer (see
    // enterChannel, channelStands): an answer with nothing but the seat on
    // the roster may be the part that changed, and taken for the roster it
    // had every heartbeat on such a store begin the huddle anew, the start
    // moved to the beat and the beater handed a roster of themself alone, so
    // they stopped dialling the others and every call broke within a beat.
    // Read once more where the answer is all there is; only a roster the
    // document itself holds without a start begins anew.
    if (after && typeof after === 'object' && !Object.hasOwn(after, 'at')) after = (await kv().get(key).catch(() => undefined))?.h?.[params.conv];
    if (after && typeof after === 'object' && !Object.hasOwn(after, 'at')) {
      await kv().update(key, { [`h.${params.conv}.by`]: id.uuid, [`h.${params.conv}.at`]: ts });
      const claim = await kv().incr(key, { [`h.${params.conv}.n`]: 1 }).catch(() => null);
      const n = claim && typeof claim === 'object' ? claim.h?.[params.conv]?.n : claim;
      started = n === 1 || n === undefined || n === null;
      cur = null;
    }
  }
  if (started) {
    const name = ctx.member.name || ctx.member.username || 'Someone';
    // The starter's own line where they started it by hand (`join`: a click
    // in the conversation they are looking at), the system's where a
    // heartbeat began the huddle anew (the roster tidied away by a poll
    // while the beat was on its way, or a tab beating once a minute in the
    // background after everyone else had gone): that tab is not looking,
    // and named as the writer, the starter's tabs marked the conversation
    // read to the line (see postSystem).
    const seq = await postSystem(params.ws, params.conv, id.uuid, `${name} started a huddle`, { by: body.join === true ? id.uuid : 'sys' });
    // A huddle in a direct message is a call: the others are told the way
    // a message would tell them (activity, and a push while the app is
    // closed), under the conversation's own notification setting. The entry
    // and the push name the line just written, by the number the write
    // handed back: read off the counter afterwards, as it used to be, the
    // number was another message's where one landed in between, and a
    // number nothing stands under where the line closed its block (see
    // rollBlock), so the Activity row opened onto nothing and was pruned.
    if (conv.kind === 'dm') {
      const others = conv.dm.members.filter((u) => u !== id.uuid && own(ctx.ws.members, u));
      if (others.length) {
        // The ring is what the caller is waiting for — the roster they dial
        // from — so telling the others rides behind the answer. The pokes go
        // in one write of the activity document and one signal for all of
        // them, as the direct-message routes do it: one pokeMember apiece
        // was an increment and a signal each, sixteen store operations to
        // ring a group of eight, in front of the dial.
        await pushInbox(params.ws, others, { k: 'huddle', c: params.conv, s: seq, by: id.uuid, ts });
        defer(async () => {
          await incrPaths(KEYS.activity(params.ws), Object.fromEntries(others.map((u) => [`u.${u}`, 1])));
          await signal(params.ws, others);
          await sendPushes(ctx.ws, others, {
            mentioned: new Set(others), conv: params.conv, mentionConv: params.conv, seq, kind: 'dm',
            title: name, body: 'started a huddle', quiet: 'started a huddle', threadRoot: null, call: true,
          }).catch(() => {});
        });
      }
    }
  }
  let roster = cur ? { ...cur, m: { ...cur.m } } : { by: id.uuid, at: ts, m: {} };
  roster.m[id.uuid] = { at: ts, j: seat.j, inv: invite };
  // The second of two who started it together is handed the roster as it
  // now stands, the first's seat on it, so the two dial each other at once
  // rather than when a poll brings the other's seat. One read, only then.
  if (!cur && !started) {
    const after = liveHuddle((await kv().get(key).catch(() => null))?.h?.[params.conv], ts);
    if (after?.m?.[id.uuid]) roster = after;
  }
  // A genuine join (starting the huddle, or a new seat on one already going)
  // wakes the conversation; a heartbeat from a seat already held does not,
  // the same restraint presence keeps.
  if (!cur || !mine) await signal(params.ws, audience);
  return { huddle: roster, started, now: ts };
}));

/**
 * Leave the huddle here. The last one out ends it. A tab that names itself
 * (`?sid=`) gives up only a seat it holds: one another tab of the account
 * has taken since is that tab's to leave.
 */
router.delete('/api/ws/:ws/conv/:conv/huddle', route(async ({ params, request, user }) => {
  const ctx = await requireMembership(params.ws, user, { also: [KEYS.activity(params.ws)] });
  const id = ctx.id;
  const conv = resolveConv(ctx, params.conv);
  const key = KEYS.activity(params.ws);
  const act = ctx.extra[0] || {};
  const raw = act.h?.[params.conv];
  if (!raw?.m?.[id.uuid]) return { ok: true, ended: false };
  const sid = query(request).get('sid');
  const heldBy = typeof raw.m[id.uuid].s === 'string' ? raw.m[id.uuid].s : null;
  if (sid && heldBy && heldBy !== sid) return { ok: true, ended: false };
  const audience = audienceOf(conv);
  const rest = liveHuddle({ ...raw, m: Object.fromEntries(Object.entries(raw.m).filter(([u]) => u !== id.uuid)) }, now());
  if (rest) {
    await kv().remove(key, `h.${params.conv}.m.${id.uuid}`);
    await signal(params.ws, audience);
    return { ok: true, ended: false };
  }
  await endHuddle(params.ws, params.conv, raw, act, ctx.ws, audience);
  return { ok: true, ended: true };
}));

/**
 * Mark the caller present: their heartbeat, with a small state beside it (do
 * not disturb; absent means plain "active"). `act` is the activity document
 * as already read, so a state that is gone is only removed when it was there.
 */
function recordPresence(wsId, uuid, act, state, at = now()) {
  const flag = state === 'dnd' ? 'dnd' : state === 'off' ? 'off' : null;
  const upd = { [`p.${uuid}`]: at };
  if (flag) upd[`ps.${uuid}`] = flag;
  const writes = [kv().update(KEYS.activity(wsId), upd).catch(() => {})];
  if (!flag && act.ps?.[uuid]) writes.push(kv().remove(KEYS.activity(wsId), `ps.${uuid}`).catch(() => {}));
  return Promise.all(writes);
}

/**
 * The tab is closing: the person is away from now rather than when their
 * last heartbeat lapses, a minute and a half on. The word goes beside the
 * heartbeat ('off'), so the poll's since filter carries it like any
 * heartbeat and the next heartbeat, from a tab that is still here or one
 * that opens, replaces it. Sent keepalive from pagehide; one write.
 */
router.delete('/api/ws/:ws/presence', route(async ({ params, user }) => {
  const [id, ws] = await Promise.all([identify(user), user?.puter ? kv().get(KEYS.ws(params.ws)) : null]);
  if (!ws || !ws.members?.[id.uuid]) fail(403, 'forbidden', 'You are not a member of this workspace');
  await recordPresence(params.ws, id.uuid, {}, 'off');
  return { ok: true };
}));

router.get('/api/ws/:ws/sync', route(async ({ params, request, user, defer }) => {
  // The route every open tab runs every few seconds, so its shape matters
  // more than any other's. Who is asking is an HTTP call to Puter and the
  // workspace and activity documents are one batched read: none of the three
  // waits on another, and only the caller's own document has to (its key is
  // their uuid), which goes below beside nothing else.
  const named = validWsId(params.ws);
  const ready = named ? await peekIdentity(user) : null;
  let id = ready;
  let wsRead = null;
  let actRead = null;
  let docRead = null;
  // The ring counters, read beside the activity document so the `rn` this
  // answer gives is no newer than the entries it reflects (see ringCount),
  // and only where anything could watch this worker (see worker/signal.js).
  let ctrRead = null;
  const counter = workerAppUid() ? [KEYS.evCounter(params.ws)] : [];
  if (ready) {
    // Everything this poll reads in one call: the workspace, the activity
    // document and the caller's own, whose key is the only one that needed
    // knowing who is asking.
    [wsRead, actRead, docRead, ctrRead = null] = await getMany([KEYS.ws(params.ws), KEYS.activity(params.ws), KEYS.member(params.ws, ready.uuid), ...counter]);
  } else {
    const [idRes, readRes] = await Promise.allSettled([
      identify(user),
      user?.puter && named ? getMany([KEYS.ws(params.ws), KEYS.activity(params.ws), ...counter]) : [null, null],
    ]);
    if (idRes.status === 'rejected') throw idRes.reason;
    if (readRes.status === 'rejected') throw readRes.reason;
    id = idRes.value;
    [wsRead, actRead, ctrRead = null] = readRes.value;
  }
  const q = query(request);
  const since = Math.max(0, Number(q.get('since')) || 0);
  const heartbeat = q.get('hb') === '1';
  const state = q.get('st');
  // Read time minus a margin: a write that raced this read is picked up by
  // the next poll instead of being lost. Clients apply deltas idempotently.
  const readAt = now();
  const ws = wsRead;
  if (!ws || !ws.members?.[id.uuid]) fail(403, 'forbidden', 'You are not a member of this workspace');
  assertAttested(ws.members[id.uuid]);
  // A poll names only conversations the caller can see, as the bootstrap
  // does: their channels and direct messages, and (for members) the public
  // channels anyone here may join. An entry says who last wrote where and
  // who is typing to whom, which for a direct message or a private channel
  // is the members' business alone. All three came up in one read where the
  // caller was already known, and the caller's own followed the other two
  // where Puter had to be asked first. Presence is cut for guests
  // to the people their bootstrap gave them, a list it left on their member
  // document; a guest whose document predates the list (opened before this
  // build) is not told of anyone until they open the workspace again, which
  // the update notice has them do.
  const act = actRead || {};
  const doc = (ready ? docRead : await kv().get(KEYS.member(params.ws, id.uuid))) || {};
  const me = ws.members[id.uuid];
  const sees = memberVisible(doc);
  const visible = isLimited(me) ? sees : (conv) => sees(conv) || isPublicChannel(ws, conv);
  // The heartbeat is written while the answer is put together and awaited
  // before it goes: work left running after a worker has answered has no
  // promise of finishing, and a heartbeat that never lands is a person who
  // is here and shown away.
  const pending = heartbeat ? recordPresence(params.ws, id.uuid, act, state, readAt) : null;
  const c = {};
  const entries = Object.entries(act.c || {});
  for (const [conv, v] of entries) {
    if (!visible(conv)) continue;
    if (v && ((v.t || 0) > since || (v.x || 0) > since)) c[conv] = v;
  }
  // The document cannot grow by every thread ever opened, nor by every
  // direct message ever started (see ACTIVITY_PRUNE_AT): once it is large,
  // this poll drops the thread and DM entries quiet the longest. The next
  // message in one writes its entry back, as for a thread; a DM unread for
  // a month in a workspace this size loses its bold until then, which is
  // the trade already taken for threads. Awaited, as the huddle tidying is.
  //
  // Nor can it grow past what the store holds (see ACTIVITY_BYTES): a
  // workspace busy enough to have more thread and direct-message entries
  // fresh than the budget allows (hundreds of threads a day, for a month)
  // grew the document to the store's ceiling, after which every post failed,
  // since each writes its conversation's entry here, and nothing would ever
  // have shrunk it, every entry being too fresh to go. Past the budget the
  // quietest entries go whatever their age, as many as bring the document
  // under it; a channel's entry never goes. The claims on ended huddles go
  // the same two ways (see endHuddle, which keeps one per conversation for
  // good otherwise): one a day old guards nothing any more.
  const claims = Object.entries(act.he || {}).filter(([conv, stamps]) => !act.h?.[conv] && stamps && typeof stamps === 'object' && Math.max(0, ...Object.keys(stamps).map((s) => Number(s.slice(1)) || 0)) < readAt - 86400_000);
  if (entries.length + claims.length > ACTIVITY_PRUNE_AT) {
    const aged = [];
    for (const [conv, v] of entries) {
      if (!parentOfThread(conv) && !conv.startsWith('dm_')) continue;
      aged.push([`c.${conv}`, Math.max(v?.t || 0, v?.x || 0), jsonBytes(conv) + jsonBytes(v || {}) + 2]);
    }
    for (const [conv, stamps] of claims) aged.push([`he.${conv}`, Math.max(0, ...Object.keys(stamps).map((s) => Number(s.slice(1)) || 0)), jsonBytes(conv) + jsonBytes(stamps) + 2]);
    aged.sort((a, b) => a[1] - b[1]);
    const drop = [];
    let over = jsonBytes(act) - ACTIVITY_BYTES;
    for (const [path, last, bytes] of aged) {
      const quiet = last < readAt - THREAD_ENTRY_QUIET_MS && drop.length < 100;
      if (!quiet && over <= 0) break;
      drop.push(path);
      over -= bytes;
    }
    for (let i = 0; i < drop.length; i += 100) await kv().remove(KEYS.activity(params.ws), ...drop.slice(i, i + 100)).catch(() => {});
  }
  const p = {};
  const ps = {};
  const peers = isLimited(me) ? new Set(Array.isArray(doc.peers) ? doc.peers : []) : null;
  for (const [u, t] of Object.entries(act.p || {})) {
    if (peers && !peers.has(u)) continue;
    if (t > since) {
      p[u] = t;
      if (act.ps?.[u]) ps[u] = act.ps[u];
    }
  }
  // Who is typing, by conversation: only fresh entries, never the caller's
  // own. Nothing is sent when nobody is, which is nearly always.
  const t = {};
  const stale = [];
  let total = 0;
  for (const [conv, users] of Object.entries(act.t || {})) {
    for (const [u, at] of Object.entries(users || {})) {
      total++;
      if (at < readAt - TYPING_FRESH_MS) {
        if (at < readAt - 60_000) stale.push(`t.${conv}.${u}`);
        continue;
      }
      if (u === id.uuid || !visible(conv)) continue;
      (t[conv] || (t[conv] = {}))[u] = at;
    }
  }
  // The map cannot grow without bound: once it is large, this poll drops
  // what is long expired, one write shared by everyone polling.
  if (total > TYPING_PRUNE_AT && stale.length) await kv().remove(KEYS.activity(params.ws), ...stale.slice(0, 100)).catch(() => {});
  // `now` is the next poll's `since`, held back so a write racing this read
  // is not missed; `ts` is the worker's clock as it stands, which presence
  // is measured against (a heartbeat is a worker timestamp, and the client's
  // own clock may sit minutes from it).
  const out = { now: readAt - 2000, ts: readAt, c, p, w: act.w || 0, u: act.u?.[id.uuid] || 0 };
  if (ctrRead) out.rn = ringCount(ctrRead, id.uuid);
  // How long until something scheduled here comes due, so a tab can poll
  // then rather than happen upon it. Nothing signals when a due time passes
  // — the moment simply arrives — so without this the wait for a scheduled
  // message is however long the poll cadence is, and the cadence is now a
  // minute. Sent as a span rather than a moment: the two clocks need not
  // agree for the tab to count down from what it was told.
  if (Number.isFinite(act.nd) && act.nd > readAt) out.ndIn = act.nd - readAt;
  if (Object.keys(ps).length) out.ps = ps;
  if (Object.keys(t).length) out.t = t;
  // Huddles in progress, with only the participants still heard from. Sent
  // whole every poll (there are rarely any, and never many), and nothing is
  // sent when there are none. This poll also tidies: a participant who has
  // gone quiet is taken out, and a huddle nobody is left in is ended here,
  // since the tab that would have said so is the one that is gone.
  if (act.h && typeof act.h === 'object') {
    const live = liveHuddles(act.h, readAt);
    if (Object.keys(live).length) {
      // A roster names who is in a call and the invite code each of them
      // serves, which is all anyone needs to dial in: it goes to the
      // conversation's members and no one else, whatever their role (a
      // public channel the caller has not joined included).
      const h = {};
      for (const [conv, entry] of Object.entries(live)) if (sees(conv)) h[conv] = entry;
      if (Object.keys(h).length) out.h = h;
    }
    // Awaited: ending a huddle is a few writes in a row, and work left
    // running after the answer is sent has no promise of finishing.
    const stale = stalePaths(act.h, readAt);
    const tidy = [];
    if (stale.drop.length) tidy.push(kv().remove(KEYS.activity(params.ws), ...stale.drop.slice(0, 100)).catch(() => {}));
    for (const conv of stale.ended) {
      const audience = own(ws.channels || {}, conv) ? audienceOf({ channel: ws.channels[conv] }) : null;
      tidy.push(endHuddle(params.ws, conv, act.h[conv], act, ws, audience).catch(() => {}));
    }
    if (tidy.length) await Promise.all(tidy);
  }
  // Something scheduled has come due: this poll delivers it, behind its own
  // answer. Nearly every poll finds nothing here and reads nothing extra;
  // the unlucky one that does used to carry a whole delivery — the queue,
  // the claim, a full post, and the next due time recomputed, twenty or
  // more round trips — in front of a poll that otherwise costs two, for
  // whichever member happened to poll first after the time came.
  //
  // Nothing in this answer is drawn from it (`out` was assembled above from
  // the activity document as it was read), and a delivery cut short is
  // already a case the queue is built for: the claim carries a stamp, and
  // one older than SCHED_CLAIM_MS is due again, so a poll that dies
  // mid-delivery is redelivered by the next — which is what would happen
  // today if the worker fell over here. The runtime is told to stay up for
  // it (see worker/lib.js's route), which is more than the old shape had.
  if (act.nd && act.nd <= readAt && !ws.movedTo && !ws.importing && !frozen(ws)) {
    ws.channels = ws.channels || {};
    defer(() => flushDue(ws).catch((e) => console.error('flush failed', e)));
  }
  if (pending) await pending;
  return out;
}));

/* ---- channels ---------------------------------------------------------- */

/**
 * Put the maker of a new channel into it, and count them in: the append onto
 * their own document is the claim (see enterChannel), and the count's answer
 * says whether their card still stands. The channel's entry was written a
 * moment ago with nobody counted; an admin removing the maker in that very
 * instant either closed their document before the append (which then finds
 * the stamp, or a document deleted, and counts nothing) or took their card
 * between the append and the count (their card is gone from what the count
 * hands back). Written with a plain append, as it used to be, the channel
 * counted its maker after the removal had counted them out, listed them on
 * a private channel's list with no card behind the name (a channel then
 * hidden from every admin, since its list was not empty, that nobody could
 * open or delete), and made a document of the channel alone for someone
 * gone. Such a channel is taken off again here, with its first block and,
 * for an entry standing for a channel hosted elsewhere, the connection's
 * record (`conn`), and the maker is answered as the member they no longer
 * are. True when they are in and counted.
 */
async function enterMadeChannel(ws, id, doc, chId, { conn = null } = {}) {
  const entry = await enterChannel(ws.id, id.uuid, chId, doc);
  let stands = entry.status === 'entered';
  if (stands) {
    const counted = await kv().incr(KEYS.ws(ws.id), { [`channels.${chId}.count`]: 1 });
    stands = (await channelStands(ws.id, chId, counted)) && !(counted && typeof counted === 'object' && counted.members && !own(counted.members, id.uuid));
  }
  if (stands) return true;
  await kv().remove(KEYS.ws(ws.id), `channels.${chId}`).catch(() => {});
  await kv().del(KEYS.block(chId, 0)).catch(() => {});
  if (conn) await kv().del(KEYS.connectPartner(conn)).catch(() => {});
  await bumpWorkspace(ws.id).catch(() => {});
  fail(403, 'forbidden', 'You are not a member of this workspace');
}

router.post('/api/ws/:ws/channels', route(async ({ params, request, user, defer }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user, { write: true });
  if (isLimited(member)) fail(403, 'forbidden', `${limitedWho(member)} cannot create channels`);
  const body = await readJson(request);
  const name = cleanChannelName(body.name);
  if (!name) fail(400, 'invalid', 'Channel names use lowercase letters, numbers, and hyphens');
  if (Object.values(ws.channels).some((c) => c.name === name)) fail(409, 'exists', `#${name} already exists`);
  if (Object.keys(ws.channels).length >= 200) fail(400, 'limit', 'This workspace has the maximum number of channels');
  assertWorkspaceRoom(ws);
  const chId = uid(10);
  const ts = now();
  const channel = {
    id: chId, name, topic: cleanLine(body.topic, LIMITS.channelTopic), private: !!body.private,
    def: false, createdBy: id.uuid, createdAt: ts, count: 0,
  };
  if (channel.private) channel.members = [id.uuid];
  await kv().update(KEYS.ws(ws.id), { [`channels.${chId}`]: channel });
  await kv().set(KEYS.block(chId, 0), { m: [], x: {} });
  // The maker enters and is counted in (see enterMadeChannel); the answer carries the channel as it stands.
  await enterMadeChannel(ws, id, doc, chId);
  channel.count = 1;
  // The channel is made and the caller is in it; the line announcing it and
  // the poke that puts it in everyone's sidebar follow the answer.
  defer(async () => {
    await postSystem(ws.id, chId, id.uuid, `${ws.members[id.uuid].name} created #${name}`);
    await pokeAndBump(ws.id, id.uuid);
  });
  return { channel };
}));

router.put('/api/ws/:ws/channels/:ch', route(async ({ params, request, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user, { write: true });
  const channel = own(ws.channels, params.ch);
  if (!channel || (channel.private && !doc.channels.includes(params.ch))) fail(404, 'not_found', 'Channel not found');
  // A guest is in the channel but not of the workspace: what it is called,
  // what it is about, and what it links to stay with the members.
  if (isLimited(member)) fail(403, 'forbidden', `${limitedWho(member)} cannot change a channel`);
  const mayEdit = isAdmin(member) || channel.createdBy === id.uuid || doc.channels.includes(params.ch);
  if (!mayEdit) fail(403, 'forbidden', 'Join the channel to edit it');
  // The answer carries the channel back; a non-admin never learns its own
  // invite codes through it, exactly as GET /api/ws withholds them (the edit
  // routes reach a member who is in a channel but not an admin of it).
  const forCaller = (c) => (isAdmin(member) ? c : { ...c, guestInvite: undefined, guestInviteExp: undefined, connectInvite: undefined, connectInviteExp: undefined });
  const body = await readJson(request);
  if (isPartnerEntry(channel)) {
    // The channel itself (topic, rules, bookmarks) is the host's; what this
    // workspace decides is what it calls it here. Admins only, like a
    // default channel's name.
    if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can rename a shared channel');
    const name = cleanChannelName(body.name);
    if (!name) fail(400, 'invalid', 'Channel names use lowercase letters, numbers, and hyphens');
    if (Object.keys(body).some((k) => k !== 'name')) fail(400, 'shared', 'A shared channel is set up on the workspace that hosts it');
    if (name !== channel.name && Object.values(ws.channels).some((c) => c.name === name)) fail(409, 'exists', `#${name} already exists`);
    const renamed = await kv().update(KEYS.ws(ws.id), { [`channels.${params.ch}.name`]: name });
    // Disconnected and deleted between the read above and this write (see
    // channelStands, and below): the name made a nameless entry of it, which
    // is taken off again, and the caller is told it is gone.
    if (!(await channelStands(ws.id, params.ch, renamed))) fail(404, 'not_found', 'Channel not found');
    await bumpWorkspace(ws.id);
    return { channel: forCaller({ ...channel, name }) };
  }
  // An archived channel is closed to change as it is to posts, edits,
  // reactions and pins: its name, topic, description, bookmarks and rules
  // stay as they were until it is unarchived (which may come in the same
  // request as the changes that follow it). The app offers none of these on
  // an archived channel; a request made another way was taken, and a rule
  // changed there wrote its line into a conversation that takes no lines.
  if (channel.archived && body.archived !== false && ['name', 'topic', 'description', 'bookmarks', 'postPolicy', 'broadcast', 'threadPolicy'].some((k) => body[k] !== undefined)) {
    fail(403, 'archived', 'This channel is archived; unarchive it to change it');
  }
  // Nor is a rule changed by the request that archives the channel: the
  // line announcing the rule would land in a channel the same request had
  // just closed (the flag is written first, the lines after it), and a rule
  // for a channel nobody may post in is no rule. The app never sends the
  // two together; a request made another way is told to do one at a time.
  if (body.archived === true && ['postPolicy', 'broadcast', 'threadPolicy'].some((k) => body[k] !== undefined)) {
    fail(400, 'invalid', 'Archive the channel on its own; who may post, notify or reply in it is changed while it is open');
  }
  const patch = {};
  let droppedFiles = [];
  if (typeof body.description === 'string' || body.bookmarks !== undefined) assertWorkspaceRoom(ws);
  if (typeof body.name === 'string') {
    const name = cleanChannelName(body.name);
    if (!name) fail(400, 'invalid', 'Channel names use lowercase letters, numbers, and hyphens');
    if (name !== channel.name && Object.values(ws.channels).some((c) => c.name === name)) fail(409, 'exists', `#${name} already exists`);
    if (channel.def && !isAdmin(member)) fail(403, 'forbidden', 'Only admins can rename a default channel');
    patch[`channels.${params.ch}.name`] = name;
  }
  // The topic, the description and a bookmark's label are shown as lines
  // beside other text (the header, the channel browser, the share preview
  // that says "#design (topic) with you: 3 people there"): cleaned as a
  // name is (see cleanLine), so a right-to-left override in one cannot turn
  // the words after it around, and one of characters that show as nothing
  // is nothing.
  if (typeof body.topic === 'string') patch[`channels.${params.ch}.topic`] = cleanLine(body.topic, LIMITS.channelTopic);
  // A description says what the channel is for, at more length than the
  // topic; it shows in the channel's details and its intro, never in the header.
  if (typeof body.description === 'string') patch[`channels.${params.ch}.description`] = cleanLine(body.description, LIMITS.channelDescription);
  if (body.bookmarks !== undefined) {
    // Named links under the channel header, in the order given. Any member of
    // the channel may curate them, like the topic; links are http(s) only or
    // an attachment already in this workspace.
    if (!Array.isArray(body.bookmarks)) fail(400, 'invalid', 'bookmarks must be a list');
    if (body.bookmarks.length > LIMITS.bookmarksPerChannel) fail(400, 'limit', `A channel can have up to ${LIMITS.bookmarksPerChannel} bookmarks`);
    const list = [];
    for (const b of body.bookmarks) {
      if (!b || typeof b !== 'object') fail(400, 'invalid', 'Bad bookmark');
      const label = cleanLine(b.label, LIMITS.bookmarkLabel);
      if (!label) fail(400, 'invalid', 'Give the bookmark a name');
      const item = { id: /^[a-z0-9]{6,16}$/.test(String(b.id || '')) ? b.id : uid(8), label };
      if (typeof b.file === 'string') {
        if (!/^[a-z0-9]{8,24}$/.test(b.file)) fail(400, 'invalid', 'Bad file reference');
        item.file = b.file;
      } else {
        // The address is checked whole, not cut to its length first: one past
        // the limit is refused, as the app refuses it, where it used to be
        // stored cut short, a link to somewhere else; and one carrying a
        // control character (a NUL, an escape, a zero-width or bidirectional
        // mark that turns the address around where the bar shows it) is no
        // address, where the label beside it has always been cleaned of them.
        // Letters of any script in the address are its own.
        const raw = typeof b.url === 'string' ? b.url.trim() : '';
        if (raw.length > LIMITS.bookmarkUrl) fail(400, 'invalid', `That link is too long (${LIMITS.bookmarkUrl} characters at most)`);
        const url = cleanText(raw, LIMITS.bookmarkUrl);
        if (!/^https?:\/\/[^\s]+$/i.test(url) || URL_CONTROLS_RE.test(url)) fail(400, 'invalid', 'Bookmarks need an http or https link');
        item.url = url;
      }
      list.push(item);
    }
    const files = list.filter((b) => b.file);
    if (files.length) {
      const metas = await getMany(files.map((b) => KEYS.file(b.file)));
      metas.forEach((m, i) => {
        if (!m || m.ws !== params.ws) fail(400, 'invalid', 'That file is not in this workspace');
        files[i].name = m.name;
      });
      // A bookmark shares its file with the channel's guests for as long as
      // it stands, read from the channel itself (see sharedWithin): written
      // on the file's record, the sharing outlived the bookmark, and clobbered
      // the count of the messages carrying the file there.
    }
    patch[`channels.${params.ch}.bookmarks`] = list;
    // A file whose bookmark comes down here, kept by that bookmark alone
    // (its message deleted since), goes with it (see releaseBookmarkFiles);
    // after the list is written, so a write refused leaves it standing.
    const staying = new Set(files.map((b) => b.file));
    droppedFiles = (channel.bookmarks || []).map((b) => b?.file).filter((f) => typeof f === 'string' && !staying.has(f));
  }
  if (typeof body.archived === 'boolean') {
    if (!isAdmin(member) && channel.createdBy !== id.uuid) fail(403, 'forbidden', 'Only admins can archive channels');
    if (channel.def && body.archived) fail(400, 'invalid', 'Default channels cannot be archived');
    patch[`channels.${params.ch}.archived`] = body.archived;
  }
  // Who may post, and who may reply in threads: admins decide, and the
  // change is announced in the channel like other structural changes.
  const lines = [];
  const me = ws.members[id.uuid].name;
  if (body.postPolicy !== undefined) {
    if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can change who may post');
    if (!POST_POLICIES.includes(body.postPolicy)) fail(400, 'invalid', 'Unknown posting policy');
    if ((channel.postPolicy || 'members') !== body.postPolicy) {
      patch[`channels.${params.ch}.postPolicy`] = body.postPolicy;
      lines.push(body.postPolicy === 'admins' ? `${me} limited posting to admins` : `${me} opened posting to everyone in the channel`);
    }
  }
  if (body.broadcast !== undefined) {
    if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can change who may notify the channel');
    if (!BROADCAST_POLICIES.includes(body.broadcast)) fail(400, 'invalid', 'Unknown broadcast policy');
    if (broadcastPolicy(channel) !== body.broadcast) patch[`channels.${params.ch}.broadcast`] = body.broadcast;
  }
  if (body.threadPolicy !== undefined) {
    if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can change who may reply in threads');
    if (!THREAD_POLICIES.includes(body.threadPolicy)) fail(400, 'invalid', 'Unknown thread policy');
    if ((channel.threadPolicy || 'everyone') !== body.threadPolicy) {
      patch[`channels.${params.ch}.threadPolicy`] = body.threadPolicy;
      lines.push(body.threadPolicy === 'off' ? `${me} turned off thread replies`
        : body.threadPolicy === 'admins' ? `${me} limited thread replies to admins` : `${me} opened thread replies to everyone`);
    }
  }
  if (!Object.keys(patch).length) return { channel: forCaller(channel) };
  // Archiving ends a huddle in progress, its line written while the channel
  // still takes one. Left standing, the roster kept the call alive for a
  // minute and a half after nobody could keep their seat (the huddle route
  // refuses an archived channel), and the poll, or the last one to leave,
  // then wrote "Huddle ended" into a channel that takes no lines, lighting
  // it up as unread for everyone in it.
  if (patch[`channels.${params.ch}.archived`] === true && !channel.archived) {
    const act = (await kv().get(KEYS.activity(ws.id)).catch(() => null)) || {};
    if (act.h?.[params.ch]) await endHuddle(ws.id, params.ch, act.h[params.ch], act, ws, audienceOf({ channel })).catch(() => {});
  }
  const written = await kv().update(KEYS.ws(ws.id), patch);
  // Deleted between the read at the top and this write, by another admin
  // (see channelStands, and the join, leave and "add people" routes, which
  // read their counter's answer the same way): the patch made a nameless
  // entry of the channel, which is taken off again, and nothing more is
  // written for it. Answered as updated, as it used to be, the caller was
  // shown the channel unarchived, or renamed, until their next poll took it
  // away; and a rule changed by the same request wrote its line into a
  // conversation just purged, making a block and a counter anew under a
  // channel that was gone, and its activity entry with them.
  if (!(await channelStands(ws.id, params.ch, written))) fail(404, 'not_found', 'Channel not found');
  if (droppedFiles.length) await releaseBookmarkFiles(ws.id, droppedFiles, bookmarkedFiles(ws, params.ch)).catch(() => {});
  for (const line of lines) await postSystem(ws.id, params.ch, id.uuid, line);
  await bumpWorkspace(ws.id);
  return { channel: forCaller({ ...channel, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k.split('.').pop(), v])) }) };
}));

/**
 * Take a conversation's storage away: its blocks, read on the way out for
 * the files to let go of and the threads to purge with it, then its counter
 * and pins, and the threads' blocks, counters and pins the same way. A
 * deleted channel used to leave every one of these behind for good: the
 * workspace's own deletion walks `ws.channels`, which the channel had left,
 * so its history, its threads' and its attachments' bytes stayed in the
 * owner's store as long as the workspace did. Best effort, as that deletion
 * is; never throws. Returns the ids of the threads purged, for the activity
 * entries that named them. `keep`: files a bookmark elsewhere still points
 * at (see bookmarkedFiles).
 *
 * Every read, deletion and release here goes a dozen at a time, as every
 * fan-out on this server does (see getMany, and the workspace's own
 * deletion): the threads were purged one after another, each with its
 * counter read, its block read and its keys deleted in turn, and each file
 * let go of in turn after them, so a channel with a few hundred threads (a
 * busy channel's year) ran this one request to a thousand round trips to
 * the store, past what the platform lets a request run. The channel's entry
 * is taken off the workspace before this runs, so the deletion stopped
 * midway with the channel gone from every sidebar and its history, threads
 * and attachments' bytes left in the owner's store for good, while the
 * admin who deleted it was shown an error for a deletion that had happened.
 */
/**
 * The threads under one block's messages, read off the record itself: a root
 * that was ever replied to carries the reply count (`rc`) and the time of the
 * last reply (`rt`) on its overlay, and keeps both once every reply is deleted
 * (the count back at nothing), whether the root itself stands or was deleted
 * while replies stood. What a reader is shown (see mergeBlock) names a thread
 * only by a count above nothing, and judged so, as the deletion walks used to
 * judge it, a thread whose replies had all been deleted was never found: its
 * block, its counter and its pins list stayed in the owner's store for good
 * when the channel, or the workspace, was deleted, and its activity entry
 * with them. A follow flag alone (`f`, see the notify route) names no thread:
 * nothing is written for one until its first reply.
 */
function threadsOf(conv, block) {
  const x = block?.x && typeof block.x === 'object' ? block.x : {};
  const out = [];
  for (const m of Array.isArray(block?.m) ? block.m : []) {
    if (!m || typeof m.s !== 'number') continue;
    const o = x[overlayKey(m.s)];
    if (o && typeof o === 'object' && (Object.hasOwn(o, 'rc') || Object.hasOwn(o, 'rt'))) out.push(threadConvId(conv, m.s));
  }
  return out;
}

async function purgeConversation(wsId, conv, { keep = null } = {}) {
  // The blocks a conversation whose counter stands at `seq` may have: one
  // past the head's, made ahead of its first message (see writeMessage).
  const blocksOf = (c, seq) => {
    const out = [];
    for (let n = 0; n <= blockIndexOf(Math.max(1, seq)) + 1; n++) out.push(KEYS.block(c, n));
    return out;
  };
  // A file is held once per message carrying it, in the conversation it was
  // carried in (see holdFiles): one shared twice here is let go of twice,
  // and one forwarded into another conversation stays held there. A deleted
  // root stays in the list for its thread's sake, with its attachments;
  // those were let go of when it was deleted.
  const holds = [];
  const found = [];
  const scan = (c, b, threads) => {
    for (const m of mergeBlock(b)) if (!m.deleted) for (const a of m.attachments) holds.push([c, a.id]);
    // Every thread ever written under the block, emptied ones included (see threadsOf).
    if (threads) found.push(...threadsOf(c, b));
  };
  const seq = Number(await kv().get(KEYS.seq(conv)).catch(() => 0)) || 0;
  const keys = blocksOf(conv, seq);
  for (let i = 0; i < keys.length; i += 12) {
    for (const b of await getMany(keys.slice(i, i + 12)).catch(() => [])) scan(conv, b, true);
  }
  // The threads' counters in one batched read (they are counters, so nothing
  // large comes back), then their blocks, each read for the files its
  // replies carried (a thread has no threads of its own).
  const tseqs = await getMany(found.map((t) => KEYS.seq(t))).catch(() => found.map(() => 0));
  const tblocks = found.flatMap((t, i) => blocksOf(t, Number(tseqs[i]) || 0).map((k) => [t, k]));
  for (let i = 0; i < tblocks.length; i += 12) {
    const slice = tblocks.slice(i, i + 12);
    const blocks = await getMany(slice.map(([, k]) => k)).catch(() => []);
    blocks.forEach((b, j) => scan(slice[j][0], b, false));
  }
  const dels = [...keys, KEYS.seq(conv), KEYS.pins(wsId, conv), ...tblocks.map(([, k]) => k), ...found.flatMap((t) => [KEYS.seq(t), KEYS.pins(wsId, t)])];
  for (let i = 0; i < dels.length; i += 12) {
    await Promise.all(dels.slice(i, i + 12).map((k) => kv().del(k).catch(() => {})));
  }
  // Each hold let go of on its own (the record's counts move atomically, so
  // two holds on one file may go together; see releaseFile). A file a
  // message waiting in the queue is to carry stays for it (see
  // queuedFilesReader): the entries waiting for this very conversation are
  // dropped after the purge (see dropScheduledIn), and let go of what they
  // waited with then.
  const queued = holds.length ? queuedFilesReader(wsId) : null;
  for (let i = 0; i < holds.length; i += 12) {
    await Promise.all(holds.slice(i, i + 12).map(([c, f]) => releaseFile(wsId, f, c, keep, queued).catch(() => {})));
  }
  return found;
}

/**
 * Take what was waiting to be sent into a conversation (or a thread of it),
 * and the reminders about its messages, out of the workspace's queue when
 * the conversation goes. Left there, an entry for a channel that no longer
 * existed sat in its author's list of scheduled messages as "Conversation"
 * until its time, could not be sent now, and held room in the queue every
 * member's drafts share, only to be dropped unsent then. Best effort, as
 * the deletion is; the next due time follows what is left.
 */
async function dropScheduledIn(wsId, conv) {
  const key = KEYS.sched(wsId);
  const doc = await kv().get(key).catch(() => null);
  const inConv = (c) => c === conv || parentOfThread(c)?.conv === conv;
  const all = Object.values(doc?.m || {}).filter((e) => e && e.id);
  const gone = all.filter((e) => inConv(String(e.conv || '')));
  if (!gone.length) return;
  for (let i = 0; i < gone.length; i += 100) await kv().remove(key, ...gone.slice(i, i + 100).map((e) => `m.${e.id}`)).catch(() => {});
  // The files these entries waited with go too (see releaseScheduledFiles).
  const rest = all.filter((e) => !gone.includes(e));
  for (const e of gone) await releaseScheduledFiles(wsId, e, rest).catch(() => {});
  await recomputeNextDue(wsId).catch(() => {});
}

router.delete('/api/ws/:ws/channels/:ch', route(async ({ params, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user, { write: true });
  const channel = own(ws.channels, params.ch);
  // A private channel the caller is not in is no channel to them, admins
  // included, as the edit, the invite and the "Add people" routes have it:
  // an admin outside it could otherwise delete it, history and all, by id.
  // One with nobody left on its list is the exception: its last member was
  // removed from the workspace (leaving keeps the last one in), so no one
  // can open it, and nobody's privacy is in it; an admin may still delete
  // it, or its history would sit in the owner's store for good.
  const orphan = channel?.private && !(channel.members || []).length;
  if (!channel || (channel.private && !doc.channels.includes(params.ch) && !orphan)) fail(404, 'not_found', 'Channel not found');
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can delete channels');
  if (channel.def) fail(400, 'invalid', 'Default channels cannot be deleted');
  // A shared channel's partners are let go first, so nobody is left a
  // member of this workspace for a channel that no longer exists; the entry
  // for a channel hosted elsewhere takes its half of the connection with it.
  for (const conn of Object.keys(channel.connections || {})) await disconnect(ws, channel, conn, null).catch(() => {});
  if (isPartnerEntry(channel) && CONN_ID_RE.test(String(channel.shared.conn || ''))) await kv().del(KEYS.connectPartner(channel.shared.conn)).catch(() => {});
  // The channel's own invite codes go with it, as a deleted workspace's do;
  // otherwise their tc:invite documents sit dead in the owner's KV until their
  // TTL (up to 30 days) fires.
  if (channel.guestInvite) await kv().del(KEYS.invite(channel.guestInvite)).catch(() => {});
  if (channel.connectInvite) await kv().del(KEYS.invite(channel.connectInvite)).catch(() => {});
  await dropChannelIntegrations(ws, params.ch);
  await kv().remove(KEYS.ws(ws.id), `channels.${params.ch}`);
  // The messages go with the channel (an entry for a channel hosted
  // elsewhere has none here), and so does every trace of it in the activity
  // document: its own entry, its threads', who was typing, a huddle. A file
  // another channel's bookmark points at stays for it; the files this
  // channel's own bookmarks kept, and nothing else holds, go with them.
  const keep = bookmarkedFiles(ws, params.ch);
  const threads = isPartnerEntry(channel) ? [] : await purgeConversation(ws.id, params.ch, { keep });
  await releaseBookmarkFiles(ws.id, (channel.bookmarks || []).map((b) => b?.file), keep).catch(() => {});
  const paths = [`c.${params.ch}`, `t.${params.ch}`, `h.${params.ch}`, `he.${params.ch}`, ...threads.flatMap((t) => [`c.${t}`, `t.${t}`])];
  for (let i = 0; i < paths.length; i += 100) await kv().remove(KEYS.activity(ws.id), ...paths.slice(i, i + 100)).catch(() => {});
  // And whatever was waiting to be sent into it (an entry for a channel
  // hosted elsewhere has none here: nothing is posted under the entry).
  if (!isPartnerEntry(channel)) await dropScheduledIn(ws.id, params.ch);
  await bumpWorkspace(ws.id);
  return { ok: true };
}));

router.post('/api/ws/:ws/channels/:ch/join', route(async ({ params, user, defer }) => {
  const { id, ws, doc, member } = await requireMembership(params.ws, user, { write: true });
  const channel = own(ws.channels, params.ch);
  if (!channel || channel.private || isLimited(member)) fail(404, 'not_found', 'Channel not found');
  if (channel.archived) fail(403, 'archived', 'This channel is archived');
  if (isPartnerEntry(channel)) {
    // Joining a shared channel is recorded here (so it sits in the sidebar
    // and this workspace knows who of its people is in it) and carried out
    // on the host with the attestation handed back: the client presents it
    // to the host's worker, which is where the messages are. The attestation
    // comes first: a connection this workspace no longer holds is refused
    // before anything is recorded, so nobody ends up in an entry that can
    // take them nowhere.
    const shared = await attestFor(ws, channel, id.uuid, 'join');
    const entry = doc.channels.includes(params.ch) ? null : await enterChannel(ws.id, id.uuid, params.ch, doc);
    // On their way out of the workspace this very moment (see enterChannel): not a member, as they are told a moment later.
    if (entry?.status === 'gone') fail(403, 'forbidden', 'You are not a member of this workspace');
    if (entry?.status === 'entered') {
      const counted = await kv().incr(KEYS.ws(ws.id), { [`channels.${params.ch}.count`]: 1 });
      // The entry went (an admin deleted it) between the read above and the
      // count: nothing is counted into a channel that is not there (see channelStands).
      if (!(await channelStands(ws.id, params.ch, counted))) fail(404, 'not_found', 'Channel not found');
      await bumpWorkspace(ws.id);
    }
    return { ok: true, already: doc.channels.includes(params.ch), shared };
  }
  if (doc.channels.includes(params.ch)) return { ok: true, already: true };
  const entry = await enterChannel(ws.id, id.uuid, params.ch, doc);
  // On their way out of the workspace this very moment (see enterChannel): not a member, as they are told a moment later.
  if (entry.status === 'gone') fail(403, 'forbidden', 'You are not a member of this workspace');
  if (entry.status !== 'entered') return { ok: true, already: true };
  const counted = await kv().incr(KEYS.ws(ws.id), { [`channels.${params.ch}.count`]: 1 });
  // Deleted between the read above and the count: the count made a nameless
  // entry of the channel, which is taken off again (see channelStands), and
  // no "joined" line is written into a conversation that is gone.
  if (!(await channelStands(ws.id, params.ch, counted))) fail(404, 'not_found', 'Channel not found');
  // Taken out of the workspace between the append and the count (their card
  // is gone from what the count handed back): the count is right on both
  // sides (see enterChannel), and nothing more is written for someone who
  // is out, neither a "joined" line nor a cursor under a document that is gone.
  if (counted && typeof counted === 'object' && counted.members && !own(counted.members, id.uuid)) fail(403, 'forbidden', 'You are not a member of this workspace');
  // Caught up including their own "joined" line: read to the seq that line
  // takes, not the one before it, so entering leaves no self-made unread.
  // They are in the channel; what is left says so to everyone else. The
  // line is a whole message of its own, and the cursor waits on the number
  // it takes, so the three of them stood between joining and being told.
  defer(async () => {
    const joinSeq = await postSystem(ws.id, params.ch, id.uuid, `${ws.members[id.uuid].name} joined`);
    await kv().update(KEYS.member(ws.id, id.uuid), { [`reads.${params.ch}`]: Math.max(joinSeq, Number(doc.reads?.[params.ch]) || 0), ...caughtUpMentions(doc, params.ch) });
    await bumpWorkspace(ws.id);
  });
  return { ok: true };
}));

router.post('/api/ws/:ws/channels/:ch/leave', route(async ({ params, user, defer }) => {
  // Someone from a connected workspace whose standing here has lapsed may
  // still leave: their app sends the leave for the host before leaving the
  // channel on their own workspace, and refused for want of a fresh
  // attestation (as every other route rightly refuses them), it was
  // swallowed, and their card and seat in the channel stayed here for good.
  const { id, ws, doc } = await requireMembership(params.ws, user, { write: true, lapsed: true });
  const channel = own(ws.channels, params.ch);
  if (!channel) fail(404, 'not_found', 'Channel not found');
  if (channel.def) fail(400, 'invalid', 'You cannot leave a default channel');
  if (!doc.channels.includes(params.ch)) return { ok: true, already: true };
  // The last one in a private channel stays. A private channel is shown to
  // the people on its list and to nobody else, admins included, so one left
  // with nobody on it could be neither opened nor deleted from any screen,
  // while its history sat in the owner's store for good and it counted
  // against the workspace's channels.
  const me = ws.members[id.uuid];
  // Not a guest, nor someone from a connected workspace: they can neither
  // add anyone to the channel nor delete it, so held in they were stuck in
  // a channel nobody else could reach, and no admin could see it to help
  // (a private channel is hidden from admins not in it until it stands
  // empty). They may go; the channel is then an orphan, listed to admins
  // for deletion (see the bootstrap and the delete route).
  if (channel.private && !isLimited(me) && !(channel.members || []).some((u) => u !== id.uuid)) fail(400, 'last_member', `You are the last person in #${channel.name}; add someone before you leave, or delete the channel`);
  // A guest is in the workspace for the channels they were let into, and
  // can join none on their own: out of the last of them they would be a
  // guest of nothing, opening the workspace to an empty sidebar with no way
  // back but an admin's hand, and the app offered them the door all the
  // same. Refused, with what to do instead; someone from a connected
  // workspace leaving their last shared channel leaves the workspace with
  // it (below), which is what their standing here was for.
  if (isGuest(me) && !doc.channels.some((c) => c !== params.ch && own(ws.channels, c))) {
    fail(400, 'last_channel', `You are here as a guest of #${channel.name} alone; ask an admin to add you to another channel before you leave it, or leave the workspace instead`);
  }
  const written = await kv().update(KEYS.member(ws.id, id.uuid), { channels: doc.channels.filter((c) => c !== params.ch) });
  // What the document says as of this write decides the rest, the way the
  // append decides for someone entering (see enterChannel): a removal closes
  // the document ahead of counting them out (see closeMemberDoc), and a
  // change of role goes on it ahead of their card (see writeDocRole).
  let after = await memberDocAfter(ws.id, id.uuid, written);
  // Closed before this write landed: the removal (an admin's, or the sweep
  // that lets a lapsed seat go, or a disconnect) took its list from the
  // closing, and this channel is on it, so they are being counted out of it
  // there, and off its list, with everything else of theirs; counted out
  // here as well, the channel counted one fewer than it held, for good, and
  // a guest's channel fewer guests than none. Nothing more is written for
  // someone on their way out: not a line saying they left, either. A
  // document gone by the time it is read again (a store that answers the
  // write with something other than the document, and a removal that
  // deleted the document in between) is one such removal has got to the
  // end of, and it closed the document long before this write landed: the
  // same side. A read that failed says nothing, and the card decides.
  const closed = (d) => typeof d?.gone === 'number' && d.gone + SCHED_CLAIM_MS > now();
  if (after === null || closed(after)) return { ok: true };
  if (Number.isFinite(doc.joinedAt) && after && !Object.hasOwn(after, 'joinedAt')) {
    // A removal that ran to its end, document deleted, between the read at
    // the top and this write: the write made a document again, of the
    // channels alone, under someone gone (every document written for a
    // member carries `joinedAt`; see enterChannel, whose append meets the
    // same shape). Decided on the document itself, never on the shape of an
    // answer, which may be the part that changed: read once more where the
    // answer is all there is. Such a document goes again, and nothing is
    // counted: the removal counted them out of this channel with the rest.
    const fresh = after === written ? await kv().get(KEYS.member(ws.id, id.uuid)).catch(() => undefined) : after;
    if (fresh === null || closed(fresh)) return { ok: true };
    if (fresh && !Object.hasOwn(fresh, 'joinedAt')) {
      await kv().del(KEYS.member(ws.id, id.uuid)).catch(() => {});
      return { ok: true };
    }
    if (fresh) after = fresh;
  }
  // Counted out as what they are as of this write, the role already on the
  // document or the card where it says nothing. Judged by the card as read
  // at the top, someone leaving a channel in the instant an admin made them
  // a guest was counted out of its members and not its guests, while the
  // role change counted them in among the guests of a channel they had just
  // left, for good; and a guest made a member (by an admin, or by the
  // workspace's own link) as they left one was counted out of its guests by
  // both, and the channel counted fewer than none.
  const role = typeof after?.role === 'string' ? after.role : null;
  const counters = { [`channels.${params.ch}.count`]: -1 };
  if (role ? role === 'guest' : isGuest(me)) counters[`channels.${params.ch}.guests`] = -1;
  const conn = partnerConnOf(channel, me);
  if (conn) counters[`channels.${params.ch}.connections.${conn}.count`] = -1;
  const counted = await kv().incr(KEYS.ws(ws.id), counters);
  // Deleted between the read above and the count (see channelStands): the
  // leaver is out either way, and nothing more is written under the channel
  // or into it.
  const stands = await channelStands(ws.id, params.ch, counted);
  if (stands && channel.private) {
    await kv().update(KEYS.ws(ws.id), {
      [`channels.${params.ch}.members`]: (channel.members || []).filter((u) => u !== id.uuid),
    });
  }
  // The entry for a channel hosted elsewhere has no conversation to announce
  // in. Nor does an archived channel take the line: it is closed to posts,
  // edits, reactions, pins and rule changes alike (see the edit route), and a
  // "left" line written into it moved its newest-message stamp, so the frozen
  // channel lit up as unread in everyone else's sidebar because one person
  // tidied it out of theirs.
  // They are out of the channel; the rest says so to everyone else and tidies
  // up after them, none of which the leaver waits on. The line alone is a
  // whole message — a number, an append and a stamp — and it stood in front
  // of the answer with the presence tidy and the bump behind it.
  defer(async () => {
    if (stands && !isPartnerEntry(channel) && !channel.archived) await postSystem(ws.id, params.ch, id.uuid, `${me.name} left`);
    // An external member is here for the shared channels alone: out of the
    // last one, they are out of the workspace.
    if (isExternal(me) && doc.channels.filter((c) => c !== params.ch).length === 0) await removeExternal(ws, id.uuid, doc);
    // Otherwise their seat in the channel's huddle and their typing there go
    // with them (removeExternal takes everything of theirs): left standing,
    // the roster named someone gone for a minute and a half, every tab in the
    // call went on dialling their peer, and a huddle they had been alone in
    // stood "in progress" with nobody in it until it lapsed.
    else if (!isPartnerEntry(channel)) await dropPresence(ws.id, id.uuid, params.ch);
    // A guest or someone from a connected workspace reads a public channel
    // only while in it: its key is replaced. A private channel's key follows
    // its member list on its own (see worker/ring.js).
    if (!channel.private && (role ? role === 'guest' : isLimited(me))) await bumpRingEpoch(ws.id).catch(() => {});
    await bumpWorkspace(ws.id);
  });
  return { ok: true };
}));

/**
 * A channel-scoped invite: whoever accepts it joins as a guest of this one
 * channel. Admins only. One live code per channel; minting again replaces
 * it, and revoking leaves none.
 */
router.post('/api/ws/:ws/channels/:ch/invites', route(async ({ params, request, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user, { write: true });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can invite guests');
  const channel = own(ws.channels, params.ch);
  // A private channel is its members' alone, admins included: the bootstrap
  // and the edit route hide one the caller is not in, and so do the invite
  // routes. An admin outside it could otherwise mint its guest link (or its
  // share link), and, accepting the guest link themselves, walk into it.
  if (!channel || (channel.private && !doc.channels.includes(params.ch))) fail(404, 'not_found', 'Channel not found');
  if (channel.archived) fail(403, 'archived', 'This channel is archived');
  if (channel.def) fail(400, 'invalid', 'Guests cannot be invited to a default channel; use the workspace invite');
  // A guest of this workspace would end up in the channel on its host,
  // vouched for as one of this workspace's people; guests are not that.
  if (isPartnerEntry(channel)) fail(400, 'shared', 'Guests cannot be invited to a shared channel; its host invites its own guests');
  const body = await readJson(request);
  if (body.inviteTtl !== undefined && !Object.hasOwn(INVITE_TTLS, body.inviteTtl)) fail(400, 'invalid', 'Unknown invite duration');
  const { code, exp } = await issueInvite(ws.id, body.inviteTtl || DEFAULT_INVITE_TTL, params.ch);
  if (channel.guestInvite) await kv().del(KEYS.invite(channel.guestInvite)).catch(() => {});
  await kv().update(KEYS.ws(ws.id), { [`channels.${params.ch}.guestInvite`]: code, [`channels.${params.ch}.guestInviteExp`]: exp });
  await bumpWorkspace(ws.id);
  return { code, exp, channel: params.ch };
}));

router.delete('/api/ws/:ws/channels/:ch/invites', route(async ({ params, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user, { write: true });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can revoke invites');
  const channel = own(ws.channels, params.ch);
  if (!channel || (channel.private && !doc.channels.includes(params.ch))) fail(404, 'not_found', 'Channel not found');
  if (channel.guestInvite) await kv().del(KEYS.invite(channel.guestInvite)).catch(() => {});
  await kv().remove(KEYS.ws(ws.id), `channels.${params.ch}.guestInvite`, `channels.${params.ch}.guestInviteExp`);
  await bumpWorkspace(ws.id);
  return { ok: true };
}));

/* ---- shared channels ------------------------------------------------------ */

/**
 * A channel is shared by connecting another workspace to it. The host's
 * admin mints a code; the partner's admin accepts it, which mints a
 * connection (an id and a secret both workers keep, see worker/connect.js)
 * and an entry in the partner workspace that stands for the channel there.
 * The partner's members then join the channel on the host as `external`
 * members, each carrying an attestation their own worker signed for them.
 * Either side can end it: the host's admin from the channel, the partner's
 * admin with a disconnect attestation.
 */

/**
 * The connection through which an external member is in a channel: the one
 * made with their workspace. Their card names whichever workspace vouched
 * for them last, so someone here through two partners (each sharing a
 * channel of its own) is labelled with one that this channel may not be
 * connected to at all; when the channel has one connection, it is the one
 * they came through, and their leaving used to leave its count standing.
 */
function partnerConnOf(channel, member) {
  if (!isExternal(member)) return null;
  const conns = Object.entries(channel.connections || {});
  const labelled = conns.find(([, c]) => c.ref === member.org?.ref)?.[0];
  return labelled || (conns.length === 1 ? conns[0][0] : null);
}

/**
 * Take a member out of every channel's counters and member lists; the caller
 * removes the card. A private channel's list is rewritten from the copy of
 * the workspace in hand, less this person, and that copy is kept in step
 * with the write: a caller taking several people out of one channel in a
 * row (see lapseExternals) used to rewrite the list from the same copy each
 * time, so the last rewrite put everyone but its own person back on it,
 * names with no card behind them, shown as former members and counted as
 * someone still in the channel when its last real member asked to leave.
 */
async function dropMembership(ws, target, doc) {
  const m = ws.members[target];
  // Counted out of a channel's guests as what the document says they are
  // as of its closing (see closeMemberDoc, and the role route, which writes
  // a new role on the document ahead of the card), the card as read at the
  // top of the request deciding only where the document says nothing: a
  // member made a guest in the instant they were removed, the removal
  // having read the card before the role reached it and closed the document
  // after the role's counting, was counted among the guests of every channel
  // of theirs by the role change and out of them by nobody, for good.
  const asGuest = typeof doc?.role === 'string' ? doc.role === 'guest' : isGuest(m);
  // Every channel's counters in a few writes, and every private list in a
  // few more (see incrPaths), rather than one and two per channel.
  const counters = {};
  const lists = {};
  for (const ch of doc?.channels || []) {
    const channel = ws.channels[ch];
    if (!channel) continue;
    counters[`channels.${ch}.count`] = -1;
    if (asGuest) counters[`channels.${ch}.guests`] = -1;
    const conn = partnerConnOf(channel, m);
    if (conn) counters[`channels.${ch}.connections.${conn}.count`] = -1;
    if (channel.private) {
      const members = (channel.members || []).filter((u) => u !== target);
      lists[`channels.${ch}.members`] = members;
      channel.members = members;
    }
  }
  await incrPaths(KEYS.ws(ws.id), counters);
  await updatePaths(KEYS.ws(ws.id), lists);
}

/**
 * How many people who left are remembered by name. A card is a few dozen
 * bytes; a hundred of them keep years of comings and goings attributed
 * without the workspace document growing with every departure.
 */
const FORMER_MAX = 100;

/**
 * Keep the name of someone leaving the workspace (and, for someone from a
 * connected workspace, its name), so what they wrote keeps its author
 * instead of turning into "Former member". Read from `ws.former` by the
 * app when a card is gone; the oldest entries make room for new ones.
 */
async function rememberFormer(ws, who) {
  const cards = {};
  const at = now();
  for (const uuid of Array.isArray(who) ? who : [who]) {
    const m = ws.members?.[uuid];
    if (!m || String(uuid).startsWith('smp_')) continue;
    const card = { username: m.username, name: m.name, color: m.color, at };
    if (m.org) card.org = m.org;
    cards[uuid] = card;
  }
  if (Object.keys(cards).length) await rememberCards(ws, 'former', cards, FORMER_MAX);
}

/** Someone remembered as having left is back: the card in `members` is the one to read again. */
async function forgetFormer(ws, uuid) {
  if (!ws.former?.[uuid]) return;
  delete ws.former[uuid];
  await kv().remove(KEYS.ws(ws.id), `former.${uuid}`).catch(() => {});
}

/** Put a card under `ws[field][uuid]`, the oldest making room once there are more than `max`. */
async function rememberCard(ws, field, uuid, card, max) {
  await rememberCards(ws, field, { [uuid]: card }, max);
}

/**
 * Put several cards under `ws[field]` at once (a partner workspace's people
 * all leaving together, see disconnect): the map written whole where the
 * oldest must make room, else each card by its own path, fifty a write.
 * One card at a time, as cards used to go, each rebuilt the map from the
 * copy in hand and wrote it, and two written together would have each
 * started from a map without the other's.
 */
async function rememberCards(ws, field, cards, max) {
  const map = { ...(ws[field] || {}), ...cards };
  const ids = Object.keys(map);
  if (ids.length > max) {
    ids.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
    for (const u of ids.slice(0, ids.length - max)) delete map[u];
    await kv().update(KEYS.ws(ws.id), { [field]: map });
  } else {
    const entries = Object.entries(cards).map(([u, card]) => [`${field}.${u}`, card]);
    for (let i = 0; i < entries.length; i += 50) await kv().update(KEYS.ws(ws.id), Object.fromEntries(entries.slice(i, i + 50)));
  }
  ws[field] = map;
}

/** How many people removed from the shared channels by an admin are kept out; the oldest removals lapse first. */
const REMOVED_MAX = 100;

/**
 * An admin removing someone from a connected workspace means it. Their own
 * workspace goes on vouching for them (their app renews on their behalf and
 * takes the host's refusal as a cue to try again), so on its own the removal
 * would last until their next poll. Remembered here, in `ws.removed`, it
 * keeps /api/connect/join from taking them back until an admin restores
 * them (DELETE /api/ws/:ws/removed/:uuid) or they join this workspace in
 * their own right. The card lets admins see who is kept out.
 */
async function rememberRemoved(ws, uuid, by) {
  const m = ws.members?.[uuid];
  if (!m) return;
  const card = { username: m.username, name: m.name, color: m.color, org: m.org || null, at: now(), by };
  await rememberCard(ws, 'removed', uuid, card, REMOVED_MAX);
}

async function forgetRemoved(ws, uuid) {
  if (!ws.removed?.[uuid]) return;
  delete ws.removed[uuid];
  await kv().remove(KEYS.ws(ws.id), `removed.${uuid}`).catch(() => {});
}

/**
 * How long past its expiry an external member's card is kept before this
 * workspace lets go of them on its own. Their own workspace vouches for
 * them again about once a day while they open the app (see
 * /api/connect/join); one made a guest there, or removed from it, or whose
 * workspace was deleted or disconnected while this one was out of reach, is
 * vouched for no more, and their card stayed here for good: shut out, since
 * their standing had run out, but listed among the channel's members and
 * counted in it and in its connection, and holding one of the workspace's
 * seats, with no route that would ever take them off (their own client has
 * no entry left to leave by, and nobody else may sign for them). A month
 * with no word is taken as the end of it; someone merely away that long
 * comes back the way they first came, through a fresh attestation.
 */
const EXTERNAL_LAPSE_GRACE_MS = 30 * 86400_000;
/** Lapsed cards let go of per bootstrap, so the request stays short. */
const LAPSE_SWEEP_MAX = 5;
/** A card the sweep may let go of: someone from a connected workspace whose standing ran out past the grace. */
const sweepable = (m) => isExternal(m) && (Number(m.exp) || 0) < now() - EXTERNAL_LAPSE_GRACE_MS;

/**
 * Take the claim on letting a lapsed card go, as a poll claims a scheduled
 * entry (see claimEntry): two bootstraps finding the same card at once
 * would each count the person out of their channels. The count lives on
 * the card and goes with it; a claim older than a delivery's hold is a
 * bootstrap that died, and is counted past. A write landing after the
 * winner took the card off leaves a card of the claim alone (see
 * cardStands), which is taken off again here and is no claim. Nor is a
 * claim on a card that is no longer one to let go of: the person accepted
 * the workspace's own invite between the caller's read and its claim (their
 * card is a member's now; see /api/join, which takes this same claim before
 * it writes that card), or their workspace vouched for them again (their
 * standing is current). The card is read back after the claim, from what
 * the store hands back or by a read of its own, and such a card keeps
 * nothing of the claim. Winning it used to rest on the count alone, and a
 * sweep that read the old card and claimed after the promotion took the new
 * member out of the workspace, card, document and all, while the join
 * answered that they had joined.
 */
async function claimLapse(wsId, uuid, card) {
  const key = KEYS.ws(wsId);
  const prev = Number(card.lapse) || 0;
  if (prev && (Number(card.lapseAt) || 0) + SCHED_CLAIM_MS > now()) return false;
  await kv().update(key, { [`members.${uuid}.lapseAt`]: now() }).catch(() => {});
  try {
    const res = await kv().incr(key, { [`members.${uuid}.lapse`]: 1 });
    let after = res && typeof res === 'object' && res.members ? own(res.members, uuid) : undefined;
    if (after === undefined) after = own((await kv().get(key))?.members || {}, uuid);
    if (!after) return false;
    if (!after.role) {
      // Decided on the document itself, never on the shape of an answer (see
      // enterChannel): an answer with nothing of the card's on it may be the
      // part that changed, the count alone, and taken for the card it had
      // every sweep on such a store take the card off without counting the
      // person out of their channels or their connection, their document
      // and their entries left behind. Read once more; only a card with no
      // role on it, the claim's own, goes.
      const fresh = own((await kv().get(key).catch(() => null))?.members || {}, uuid);
      if (!fresh) return false;
      if (!fresh.role) {
        await kv().remove(key, `members.${uuid}`).catch(() => {});
        return false;
      }
      after = fresh;
    }
    if (!sweepable(after)) {
      await kv().remove(key, `members.${uuid}.lapse`, `members.${uuid}.lapseAt`).catch(() => {});
      return false;
    }
    return after.lapse === prev + 1;
  } catch {
    return false;
  }
}

/**
 * Let go of the external members whose standing ran out long ago (see
 * EXTERNAL_LAPSE_GRACE_MS): out of their channels and their counts, and
 * out of the workspace, remembered by name as anyone who left is. Run on
 * the bootstrap, which any member's tab does now and then and which has
 * the workspace in hand; `ws` is brought up to date when anyone went, so
 * the answer being put together shows the workspace as it now stands.
 */
async function lapseExternals(ws) {
  const lapsed = Object.entries(ws.members).filter(([, m]) => sweepable(m)).slice(0, LAPSE_SWEEP_MAX);
  if (!lapsed.length) return false;
  let swept = 0;
  for (const [u, m] of lapsed) {
    if (!(await claimLapse(ws.id, u, m))) continue;
    const doc = await closeMemberDoc(ws.id, u).catch(() => null);
    await dropMembership(ws, u, doc);
    await removeExternal(ws, u, doc);
    swept++;
  }
  if (!swept) return false;
  const fresh = await kv().get(KEYS.ws(ws.id)).catch(() => null);
  if (fresh) {
    ws.channels = fresh.channels || {};
    ws.members = fresh.members || {};
    ws.former = fresh.former;
    ws.ke = fresh.ke; // the bootstrap's ring keys are derived from it (see removeExternals)
  }
  await bumpWorkspace(ws.id).catch(() => {});
  return true;
}

/** Remove an external member from the workspace altogether (they were only ever here for shared channels). `doc` is their member document, when the caller already has it. */
async function removeExternal(ws, uuid, doc = null) {
  await removeExternals(ws, [uuid], [doc]);
}

/**
 * Remove several external members from the workspace at once (a connection
 * ending takes every one of the partner's people, see disconnect), each
 * step for all of them together: their names remembered in one write, their
 * cards off the workspace document a hundred a write, their traces off the
 * activity document from one reading of it, their documents and lists
 * deleted a dozen at a time, their queued messages dropped from one reading
 * of the queue, and their account records read together and written
 * together. One person at a time, as they used to go, each cost some ten
 * round trips to the store in a row, and a partner whose hundred people
 * were in the channel ran the disconnect past what the platform lets a
 * request run, so it stopped midway: the connection standing, some of them
 * gone from the channel's list and some not, and no line written.
 * `docs`, parallel to `uuids`, are the member documents callers already
 * hold (entries may be missing or null); used only to release a cached
 * handle, never re-read.
 */
async function removeExternals(ws, uuids, docs = []) {
  if (!uuids.length) return;
  await rememberFormer(ws, uuids);
  for (let i = 0; i < uuids.length; i += 100) await kv().remove(KEYS.ws(ws.id), ...uuids.slice(i, i + 100).map((u) => `members.${u}`));
  // Their conversation keys go with them, as a removed member's do: once
  // their cards are off, so no bootstrap of theirs is handed the new ones.
  await bumpRingEpoch(ws.id).catch(() => {});
  // Their heartbeat and status go with them, as an admin's removal takes a
  // member's, and their seat in a huddle with those (see dropPresence).
  await dropPresence(ws.id, uuids);
  for (let i = 0; i < uuids.length; i += 12) await Promise.all(uuids.slice(i, i + 12).map((u) => kv().del(KEYS.member(ws.id, u))));
  const lists = uuids.flatMap((u) => [KEYS.inbox(ws.id, u), KEYS.threads(ws.id, u), KEYS.saved(ws.id, u)]);
  for (let i = 0; i < lists.length; i += 12) await Promise.all(lists.slice(i, i + 12).map((k) => kv().del(k).catch(() => {})));
  // What they had waiting to be sent goes with them, however they leave: a
  // disconnect took their card and left their entries in the queue until
  // their time, when they were posted if their workspace was connected again.
  await dropScheduled(ws.id, uuids);
  const records = await getMany(uuids.map((u) => KEYS.user(u)));
  const filed = uuids.map((u, i) => [u, records[i]]).filter(([, p]) => p?.workspaces?.includes(ws.id));
  for (let i = 0; i < filed.length; i += 12) {
    await Promise.all(filed.slice(i, i + 12).map(([u, p]) => kv().update(KEYS.user(u), { workspaces: p.workspaces.filter((w) => w !== ws.id) }).catch(() => {})));
  }
  // Capped, and only the ones with a cached handle: mint and revoke share
  // one 60/min budget on the owner's account, and a partner's hundred
  // people leaving at once would otherwise run this past what the platform
  // lets a request run.
  const releasing = uuids.map((u, i) => [u, docs[i]]).filter(([, d]) => d?.ev?.h).slice(0, REVOKE_BATCH_MAX);
  for (let i = 0; i < releasing.length; i += 12) {
    await Promise.all(releasing.slice(i, i + 12).map(([u, d]) => releaseHandle(ws.id, u, d).catch(() => {})));
  }
}

/**
 * Sign for one of this workspace's members towards the host of a shared
 * channel: `join` says "this person is in the channel here", `disconnect`
 * says "this workspace is ending the connection" (admins only, checked by
 * the caller). The host checks the signature against the secret the two
 * workers share and the uuid against whoever presents the token.
 */
async function attestFor(ws, channel, uuid, kind, known = undefined) {
  const conn = String(channel.shared?.conn || '');
  // `known` is the record a caller read already (see revocationsFor).
  const rec = known !== undefined ? known : (CONN_ID_RE.test(conn) ? await kv().get(KEYS.connectPartner(conn)) : null);
  if (!rec || rec.role !== 'partner' || rec.ws !== ws.id || rec.ch !== channel.id || !rec.secret) fail(409, 'connection_lost', 'This workspace no longer holds its connection to that channel');
  const token = await signAttestation(rec.secret, { conn, uuid, kind });
  return { ref: channel.shared.ref, ch: channel.shared.ch, conn, host: channel.shared.host || null, token };
}

/**
 * This workspace's word to each host that one of its people is no longer
 * one of them: a revocation per shared channel the person was in through
 * this workspace (`channels`, their entries here), signed here and carried
 * to the hosts by the admin's app, as a disconnect is carried (see
 * /api/connect/revoke on the host). Best effort: a connection this
 * workspace no longer holds signs nothing, and a host never told lets the
 * seat lapse on its own, a day on, as it always did.
 */
async function revocationsFor(ws, uuid, channels) {
  // Every connection's record in one read, then the signing, which is
  // arithmetic: read one at a time as each channel was reached, a member
  // taken out of a workspace sharing a dozen channels paid a round trip per
  // channel before the answer, in a row.
  const shared = (channels || []).map((ch) => own(ws.channels, ch)).filter(isPartnerEntry);
  if (!shared.length) return [];
  const recs = await getMany(shared.map((c) => KEYS.connectPartner(String(c.shared?.conn || ''))));
  const out = [];
  for (const [i, channel] of shared.entries()) {
    try {
      out.push(await attestFor(ws, channel, uuid, 'revoke', recs[i]));
    } catch {
      /* the connection is gone from this side: nothing to say to its host */
    }
  }
  return out;
}

/** The workspace and channel a connect code stands for, while it is live; every failure looks the same and counts against the guesser. */
async function liveConnectInvite(code, uuid) {
  const invite = await kv().get(KEYS.invite(code));
  const ws = invite?.role === 'connect' ? await kv().get(KEYS.ws(invite.ws)) : null;
  const channel = ws?.channels?.[invite?.ch];
  const live = channel && channel.connectInvite === code && !channel.archived && !ws.movedTo && (!invite.exp || invite.exp > now());
  if (!live) {
    await noteJoinFailure(uuid);
    fail(404, 'invite_not_found', 'This share link is not valid anymore');
  }
  ws.channels = ws.channels || {};
  ws.members = ws.members || {};
  return { invite, ws, channel };
}

/**
 * End a connection on the host: the partner's people leave the channel (and
 * the workspace, once they are in no shared channel here), the partner can
 * vouch for nobody any more, and the channel says so.
 */
async function disconnect(ws, channel, conn, line) {
  const c = own(channel.connections, conn);
  if (!c) fail(404, 'not_found', 'That workspace is not connected to this channel');
  // Who goes: the partner's people, and anyone else from outside whose own
  // workspace is not connected to this channel once this one is gone. A
  // member of two partner workspaces carries the label of whichever vouched
  // for them last, so the label alone would let someone stay in a channel
  // their workspace was just disconnected from.
  const remaining = new Set(Object.entries(channel.connections).filter(([k]) => k !== conn).map(([, v]) => v.ref));
  const externals = Object.entries(ws.members).filter(([, m]) => isExternal(m) && (m.org?.ref === c.ref || !remaining.has(m.org?.ref))).map(([u]) => u);
  const docs = await getMany(externals.map((u) => KEYS.member(ws.id, u)));
  const docByUuid = new Map(externals.map((u, i) => [u, docs[i]]));
  // Everyone of theirs who is in the channel, and what else each is in here.
  // Every step below is taken for all of them together, a dozen at a time
  // where each has a document of their own to write, as every fan-out on
  // this server goes (see getMany, removeExternals): one person after
  // another, as it used to be, each awaited through their closing, their
  // rewrite, their presence and their poke or their removal, a partner
  // whose hundred people were in the channel ran this past what the
  // platform lets a request run, and the disconnect stopped midway.
  const inIt = externals.map((u, i) => [u, docs[i]?.channels || []]).filter(([, channels]) => channels.includes(channel.id));
  const going = new Set(inIt.map(([u]) => u));
  let members = (channel.members || []).filter((x) => !going.has(x));
  const gone = inIt.length;
  // Who stays in the workspace (in other channels of it) and who goes with
  // this one. For someone whose only channel here this is, their document
  // is closed first, and what the closing hands back decides (see
  // closeMemberDoc, enterChannel): a channel they were entering in this
  // very moment is either on it, and they stay, in that channel, the stamp
  // taken off again; or it is not, and the entry, finding the stamp, counts
  // nothing and answers that their standing changed. Read once and deleted,
  // as before, an entry landing between the two was counted into a channel
  // by someone who then went, for good.
  const staying = [];
  const leaving = [];
  const reopen = [];
  const last = inIt.filter(([, channels]) => !channels.some((x) => x !== channel.id));
  for (const [u, channels] of inIt) if (channels.some((x) => x !== channel.id)) staying.push([u, channels.filter((x) => x !== channel.id)]);
  for (let i = 0; i < last.length; i += 12) {
    const closed = await Promise.all(last.slice(i, i + 12).map(([u]) => closeMemberDoc(ws.id, u)));
    closed.forEach((c, j) => {
      const u = last[i + j][0];
      const left = (Array.isArray(c.channels) ? c.channels : []).filter((x) => x !== channel.id);
      if (left.length) {
        reopen.push(u);
        staying.push([u, left]);
      } else {
        leaving.push(u);
      }
    });
  }
  for (let i = 0; i < reopen.length; i += 12) await Promise.all(reopen.slice(i, i + 12).map((u) => kv().remove(KEYS.member(ws.id, u), 'gone').catch(() => {})));
  for (let i = 0; i < staying.length; i += 12) await Promise.all(staying.slice(i, i + 12).map(([u, left]) => kv().update(KEYS.member(ws.id, u), { channels: left })));
  if (staying.length) {
    // Out of this channel and staying in others: the seat they had in its
    // huddle goes as a member's does on leaving, and their tabs are told to
    // read their document again (see pokeMember), one write for all.
    await dropPresence(ws.id, staying.map(([u]) => u), channel.id);
    await incrPaths(KEYS.activity(ws.id), Object.fromEntries(staying.map(([u]) => [`u.${u}`, 1])));
  }
  await removeExternals(ws, leaving, leaving.map((u) => docByUuid.get(u) || null));
  if (gone) await kv().incr(KEYS.ws(ws.id), { [`channels.${channel.id}.count`]: -gone }).catch(() => {});
  if (channel.private) await kv().update(KEYS.ws(ws.id), { [`channels.${channel.id}.members`]: members }).catch(() => {});
  await kv().remove(KEYS.ws(ws.id), `channels.${channel.id}.connections.${conn}`);
  await kv().del(KEYS.connect(conn)).catch(() => {});
  // Drawn as the owner's, written as the system's (see postSystem): the
  // owner did not necessarily do this (the partner's admin may have, or
  // another admin here), and is not necessarily looking; named as the
  // writer, their own tabs marked the channel read to the line.
  if (line) await postSystem(ws.id, channel.id, ws.owner, line, { by: 'sys' });
  // Those staying in other channels here no longer read this one (see removeExternals for those who left).
  if (staying.length && !channel.private) await bumpRingEpoch(ws.id).catch(() => {});
  await bumpWorkspace(ws.id);
}

/** Admins: mint the link another workspace's admin accepts to share this channel. One live code per channel. */
router.post('/api/ws/:ws/channels/:ch/connect/invites', route(async ({ params, request, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user, { write: true });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can share a channel with another workspace');
  const channel = own(ws.channels, params.ch);
  // A private channel the caller is not in is not theirs to share (see the guest invite route).
  if (!channel || (channel.private && !doc.channels.includes(params.ch))) fail(404, 'not_found', 'Channel not found');
  if (channel.archived) fail(403, 'archived', 'This channel is archived');
  if (channel.def) fail(400, 'invalid', 'A default channel cannot be shared with another workspace');
  if (isPartnerEntry(channel)) fail(400, 'shared', 'Only the workspace that hosts a shared channel can share it further');
  const body = await readJson(request);
  if (body.inviteTtl !== undefined && !Object.hasOwn(INVITE_TTLS, body.inviteTtl)) fail(400, 'invalid', 'Unknown invite duration');
  const { code, exp } = await issueInvite(ws.id, body.inviteTtl || DEFAULT_INVITE_TTL, params.ch, 'connect');
  if (channel.connectInvite) await kv().del(KEYS.invite(channel.connectInvite)).catch(() => {});
  await kv().update(KEYS.ws(ws.id), { [`channels.${params.ch}.connectInvite`]: code, [`channels.${params.ch}.connectInviteExp`]: exp });
  await bumpWorkspace(ws.id);
  return { code, exp, channel: params.ch };
}));

router.delete('/api/ws/:ws/channels/:ch/connect/invites', route(async ({ params, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user, { write: true });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can revoke a share link');
  const channel = own(ws.channels, params.ch);
  if (!channel || (channel.private && !doc.channels.includes(params.ch))) fail(404, 'not_found', 'Channel not found');
  if (channel.connectInvite) await kv().del(KEYS.invite(channel.connectInvite)).catch(() => {});
  await kv().remove(KEYS.ws(ws.id), `channels.${params.ch}.connectInvite`, `channels.${params.ch}.connectInviteExp`);
  await bumpWorkspace(ws.id);
  return { ok: true };
}));

/** What a share link leads to, for the admin deciding whether to accept it. Counts against the invite budget like a join. */
router.get('/api/connect/preview', route(async ({ request, user }) => {
  const id = await identify(user);
  const code = normalizeInviteCode(query(request).get('code'));
  if (!code) fail(400, 'invalid', 'That does not look like a share link');
  await assertJoinBudget(id.uuid);
  const { ws, channel } = await liveConnectInvite(code, id.uuid);
  return {
    workspace: { id: ws.id, name: ws.name },
    channel: { id: channel.id, name: channel.name, topic: channel.topic || '', description: channel.description || '', count: channel.count || 0, private: !!channel.private },
    connections: Object.values(channel.connections || {}).map((c) => c.name),
  };
}));

/**
 * A partner workspace's admin accepts a share link: a connection is minted
 * (or, for a workspace already connected to this channel, its secret is
 * renewed) and handed back once with its secret, which the admin's app
 * stores on their own worker. Nothing about the partner is verified here:
 * its reference and name are what that workspace says of itself, shown as
 * such.
 */
router.post('/api/connect/accept', route(async ({ request, user }) => {
  const id = await identify(user);
  const body = await readJson(request);
  const code = normalizeInviteCode(body.code);
  if (!code) fail(400, 'invalid', 'That does not look like a share link');
  const partnerRef = String(body.partner?.ref || '');
  const partnerName = cleanLine(body.partner?.name, LIMITS.workspaceName);
  if (!REF_RE.test(partnerRef) || !partnerName) fail(400, 'invalid', 'Say which workspace is accepting');
  await assertJoinBudget(id.uuid);
  const { ws, channel } = await liveConnectInvite(code, id.uuid);
  if (ws.importing) fail(409, 'importing', 'This workspace is still being imported; try again in a moment');
  // A connection made while the host is being moved would be lost to the
  // move with everything else written here meanwhile (see assertWritable).
  if (frozen(ws)) fail(423, 'transferring', `${ws.name} is being moved to another server; try again in a few minutes`);
  // An admin of both sides picking the host itself would connect the channel
  // to its own workspace: an entry pointing back here, and a "now shared
  // with" line naming ourselves.
  if (partnerRef.slice(0, partnerRef.indexOf('@')) === ws.id) fail(400, 'invalid', `#${channel.name} is ${ws.name}'s own channel; a share link is for another workspace`);
  await ensureProfile(id, body.profile);
  const existing = Object.entries(channel.connections || {}).find(([, c]) => c.ref === partnerRef);
  // Re-accepting an existing connection rotates the secret the host verifies
  // attestations with, so whoever still holds the old one (the real partner's
  // members) can no longer be vouched for and drops out. A partner's `ref`
  // is no secret — it sits in this channel's connection list, which every
  // member of the channel reads, including the admins of every other partner
  // sharing it — and the share code is one code for all partners, so without
  // this check any code-holder could name another partner's ref to re-key
  // and rename its connection, cutting that partner off and taking over its
  // labelled identity. Only the admin who established a connection may renew
  // it (which also covers retrying a first accept whose partner-side record
  // was lost); a different admin of the partner reconnects it afresh instead.
  if (existing && existing[1].by !== id.uuid) {
    fail(403, 'connection_owned', `#${channel.name} is already connected to that workspace; only the admin who set that connection up can renew it`);
  }
  if (!existing && Object.keys(channel.connections || {}).length >= LIMITS.connectionsPerChannel) fail(400, 'limit', `A channel can be shared with up to ${LIMITS.connectionsPerChannel} workspaces`);
  const conn = existing ? existing[0] : uid(10);
  const secret = uid(32);
  const ts = now();
  await kv().set(KEYS.connect(conn), { ws: ws.id, ch: channel.id, partner: partnerRef, name: partnerName, secret, role: 'host', createdAt: existing ? existing[1].at || ts : ts, by: id.uuid });
  if (existing) {
    await kv().update(KEYS.ws(ws.id), { [`channels.${channel.id}.connections.${conn}.name`]: partnerName });
  } else {
    await kv().update(KEYS.ws(ws.id), { [`channels.${channel.id}.connections.${conn}`]: { ref: partnerRef, name: partnerName, count: 0, at: ts, by: id.uuid } });
    // Drawn as the owner's, written as the system's (see postSystem): the
    // other workspace's admin accepted the link, and the owner here, named
    // as the writer, had their own tabs mark the channel read to the line.
    await postSystem(ws.id, channel.id, ws.owner, `This channel is now shared with ${partnerName}`, { by: 'sys' });
  }
  await bumpWorkspace(ws.id);
  return {
    conn, secret,
    workspace: { id: ws.id, name: ws.name },
    channel: { id: channel.id, name: channel.name, topic: channel.topic || '', description: channel.description || '' },
  };
}));

/**
 * A partner's member joins the shared channel on the host, carrying the
 * attestation their own worker signed. New here: they become an external
 * member, in this channel alone, for a day; already here: their standing is
 * renewed. Someone who is a member of both workspaces simply joins the
 * channel as themselves.
 */
router.post('/api/connect/join', route(async ({ request, user }) => {
  const id = await identify(user);
  const body = await readJson(request);
  const conn = String(body.conn || '');
  if (!CONN_ID_RE.test(conn)) fail(400, 'invalid', 'Bad connection');
  const rec = await kv().get(KEYS.connect(conn));
  if (!rec || rec.role !== 'host') fail(404, 'connection_ended', 'This channel is no longer shared with your workspace');
  const ok = await verifyAttestation(rec.secret, body.token, { conn, uuid: id.uuid, kind: 'join' });
  if (!ok) fail(401, 'bad_attestation', 'Your workspace could not vouch for you; try again');
  // Their workspace took its word back after this token was signed (see
  // /api/connect/revoke): a token signed before the removal and presented
  // after it would seat someone their workspace has since shown the door,
  // for a day. One signed since (they were let back in) passes.
  if (Number(own(rec.revoked || {}, id.uuid)) > ok.iat) fail(403, 'revoked', 'Your workspace withdrew its word for you here; if you were let back in, try again');
  const ws = await kv().get(KEYS.ws(rec.ws));
  const channel = ws?.channels?.[rec.ch];
  const connection = channel?.connections?.[conn];
  if (!ws || !channel || !connection) fail(404, 'connection_ended', 'This channel is no longer shared with your workspace');
  ws.members = ws.members || {};
  const existing = ws.members[id.uuid];
  // Removed from here by an admin: their workspace's word does not bring
  // them back until an admin restores them. (A member of this workspace in
  // their own right is not kept out of anything by that.)
  if (own(ws.removed || {}, id.uuid) && !(existing && !isExternal(existing))) fail(403, 'removed', `An admin of ${ws.name} removed you from its shared channels`);
  const doc = existing ? (await kv().get(KEYS.member(ws.id, id.uuid))) || {} : null;
  const joined = !!doc && (doc.channels || []).includes(channel.id);
  // Someone from a connected workspace who is in the channel already comes
  // here to renew their standing, which every route of theirs needs (see
  // assertAttested) and which runs out once a day. A renewal alone goes
  // through while the workspace is being moved to another server (see
  // assertWritable): it puts nobody in and counts nothing, and what it
  // writes, a day more on a card that does not travel with the move, is
  // lost to nothing; refused, it shut them out of reading the channel for
  // the length of the move, told first that their access needed renewing
  // and then that the workspace was being moved. Entering the channel, or
  // the workspace, still waits for the move, as any joining does.
  const renewal = !!existing && isExternal(existing) && joined;
  assertWritable(ws, { moving: renewal });
  // An archived channel is read by those in it and entered by nobody, as
  // everywhere: someone already in it renews their standing (a day later
  // they would otherwise be shut out of what they may still read), someone
  // new is turned away like anyone joining an archived channel.
  if (channel.archived && !joined) fail(403, 'archived', 'This channel is archived');
  // Someone new to this workspace takes a seat in it like anyone joining.
  if (!existing && Object.keys(ws.members).length >= 500) fail(400, 'limit', 'The workspace hosting this channel is full');
  const profile = await ensureProfile(id, body.profile);
  const exp = now() + EXTERNAL_TTL_MS;
  const enter = async (external) => {
    // The channel's present, for a newcomer's cursor (see below); a member here already has a document, and needs no reading of it.
    const seq = doc ? 0 : Number(await kv().get(KEYS.seq(channel.id))) || 0;
    // Two tabs presenting attestations at once: the second finds the
    // first has put them in, and leaves the counting to it. The append is
    // the claim for someone new here too: each tab used to write their
    // document whole, and both then counted and announced them.
    const entry = await enterChannel(ws.id, id.uuid, channel.id, doc);
    // On their way out of the workspace this very moment (an admin removing
    // them; see enterChannel): tried again once that is settled.
    if (entry.status === 'gone') fail(409, 'retry', 'Your standing in this channel changed just now; try again');
    if (entry.status !== 'entered') return;
    // A member of both workspaces joins as themselves, counted as what they
    // are here (a guest of this workspace stays one, and counts as one),
    // as of the append (see enterChannel).
    const counters = { [`channels.${channel.id}.count`]: 1 };
    if (external) counters[`channels.${channel.id}.connections.${conn}.count`] = 1;
    else if (entry.role ? entry.role === 'guest' : isGuest(existing)) counters[`channels.${channel.id}.guests`] = 1;
    const counted = await kv().incr(KEYS.ws(ws.id), counters);
    // The channel was deleted on the host between the read above and these
    // writes (see channelStands): no line is written into what is gone; the
    // next attestation is told the connection has ended.
    if (!(await channelStands(ws.id, channel.id, counted))) return;
    // Taken out of the workspace between the append and the count (an
    // admin's removal, a disconnect, their own workspace's word arriving):
    // their card is gone from what the count handed back (as the channel
    // join route reads it). Nothing more is written for someone who is out:
    // no name of theirs onto a private channel's list, where it stood with
    // no card behind it; no "joined" line; no cursor under a document the
    // removal had deleted, which made a document of the cursor alone for
    // someone gone. The count is right where the removal saw the append (it
    // counted them out of a channel their document named; the two cancel);
    // someone new here, whose document the append alone made after the
    // removal had closed and deleted what stood, was counted out by nobody,
    // and that document says so: the channel alone on it, nothing else. The
    // count comes off again and the document goes with it. Answered as a
    // standing that changed, to be tried again once that is settled.
    if (counted && typeof counted === 'object' && counted.members && !own(counted.members, id.uuid)) {
      const stray = await kv().get(KEYS.member(ws.id, id.uuid)).catch(() => undefined);
      const alone = !!stray && typeof stray === 'object' && Object.keys(stray).length === 1 && Array.isArray(stray.channels) && stray.channels.length === 1 && stray.channels[0] === channel.id;
      if (alone) {
        await kv().incr(KEYS.ws(ws.id), Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, -v]))).catch(() => {});
        await kv().del(KEYS.member(ws.id, id.uuid)).catch(() => {});
      }
      fail(409, 'retry', 'Your standing in this channel changed just now; try again');
    }
    if (channel.private) await addPrivateMember(ws.id, channel.id, id.uuid);
    // Someone new here has their document made whole, of which the append
    // wrote the channel alone: their cursor at the channel's present, moved
    // to their own line below. A member of this workspace already has one,
    // and their cursor is written once, below, as the channel join route
    // writes it: written here as well, to the present, and then again to
    // the line, as it used to be, a member of both workspaces joining the
    // shared channel cost their record a read of the counter and a write
    // that the next write covered.
    if (!doc) await kv().update(KEYS.member(ws.id, id.uuid), { dms: {}, reads: { [channel.id]: seq }, mentions: {}, joinedAt: now() });
    // Caught up including their own "joined" line: read to the seq that line
    // takes, not the one before it, so entering leaves no self-made unread.
    const joinSeq = await postSystem(ws.id, channel.id, id.uuid, `${profile.name || profile.username}${external ? ` (${connection.name})` : ''} joined`);
    await kv().update(KEYS.member(ws.id, id.uuid), { [`reads.${channel.id}`]: Math.max(joinSeq, Number(doc?.reads?.[channel.id]) || 0), ...caughtUpMentions(doc, channel.id) });
  };
  if (existing && !isExternal(existing)) {
    if (!joined) {
      await enter(false);
      await bumpWorkspace(ws.id);
    }
    return { workspace: { id: ws.id, name: ws.name }, channel: channel.id, exp: null, member: true };
  }
  // `att`: when their workspace signed for them, by its own clock; a
  // revocation older than that is stale (see /api/connect/revoke).
  const card = { ...memberRecord(profile, 'external'), org: { ref: rec.partner, name: connection.name }, exp, att: ok.iat };
  // Whether anyone else has something new to read: someone entering, or a
  // card that changed in what it shows. A renewal that moves nothing but
  // the member's own standing is not that, and must not make every member
  // of this workspace fetch it again (each external's client renews once a
  // day, and each fetch by an external costs a read per member here).
  let changed = !existing || !joined;
  if (existing) {
    // Renewed, and the card brought up to date: the profile travels with
    // every attestation, so a name or photo changed while the host was out
    // of reach shows here at the next renewal.
    delete card.joinedAt;
    const upd = {};
    for (const [k, v] of Object.entries(card)) if (JSON.stringify(existing[k] ?? null) !== JSON.stringify(v ?? null)) upd[`members.${id.uuid}.${k}`] = v;
    const written = await kv().update(KEYS.ws(ws.id), upd);
    // Their card went between the read above and this write (an admin
    // removed them, or they left): a renewal makes no member of them (see
    // cardStands). The next attempt is answered for what they are by then:
    // kept out, or joining afresh.
    if (!(await cardStands(ws.id, id.uuid, written, Object.keys(card)))) fail(409, 'retry', 'Your standing in this channel changed just now; try again');
    if (Object.keys(upd).some((k) => !k.endsWith('.exp') && !k.endsWith('.att'))) changed = true;
    if (!joined) await enter(true);
  } else {
    assertWorkspaceRoom(ws, { joining: true }); // a card grows the document as a member's does
    await kv().update(KEYS.ws(ws.id), { [`members.${id.uuid}`]: card });
    await forgetFormer(ws, id.uuid);
    await enter(true);
  }
  // The profile's list of workspaces is what a new name, status, or photo
  // updates the member's cards from (PUT /api/me, POST /api/me/avatar), so
  // the host goes on it; /api/me keeps it out of what it answers, since an
  // external member is in a channel here, not in the workspace.
  if (!profile.workspaces.includes(ws.id)) await listWorkspace(id.uuid, ws.id);
  if (changed) await bumpWorkspace(ws.id);
  return { workspace: { id: ws.id, name: ws.name }, channel: channel.id, exp };
}));

/** The partner ends the connection, with a disconnect attestation from its own worker. Idempotent. */
router.post('/api/connect/disconnect', route(async ({ request, user }) => {
  const id = await identify(user);
  const body = await readJson(request);
  const conn = String(body.conn || '');
  if (!CONN_ID_RE.test(conn)) fail(400, 'invalid', 'Bad connection');
  const rec = await kv().get(KEYS.connect(conn));
  if (!rec || rec.role !== 'host') return { ok: true, already: true };
  const ok = await verifyAttestation(rec.secret, body.token, { conn, uuid: id.uuid, kind: 'disconnect' });
  if (!ok) fail(401, 'bad_attestation', 'Your workspace could not vouch for you; try again');
  const ws = await kv().get(KEYS.ws(rec.ws));
  const channel = ws?.channels?.[rec.ch];
  if (!ws || !channel || !channel.connections?.[conn]) {
    await kv().del(KEYS.connect(conn)).catch(() => {});
    return { ok: true, already: true };
  }
  ws.members = ws.members || {};
  // Ended while the host is being moved, the connection would end in the
  // copy about to be left behind and stand in the one everyone moves to
  // (see assertWritable); the partner's app tries again in a few minutes.
  if (frozen(ws)) fail(423, 'transferring', `${ws.name || 'That workspace'} is being moved to another server; try again in a few minutes`);
  await disconnect(ws, channel, conn, `${channel.connections[conn].name} disconnected from this channel`);
  return { ok: true };
}));

/**
 * The partner has taken one of its people out of its workspace, or made
 * them a guest there: their seat in the channel shared with it ends now, as
 * it would on a disconnect, rather than a day later when their standing ran
 * out (see EXTERNAL_TTL_MS), a day through which they went on reading and
 * writing here. The word is a revocation the partner's worker signed when
 * its admin acted (see worker/connect.js), carried here by that admin's
 * app, as every word between two workers is carried. Idempotent. One older
 * than the person's latest vouching is stale (their workspace let them back
 * in since) and changes nothing; and the connection remembers it for as
 * long as a join token lives, so a token signed before the removal and
 * presented after it seats nobody (see /api/connect/join). Someone who is
 * a member of this workspace in their own right is not touched by their
 * other workspace's word, as a renewal does not touch them.
 */
router.post('/api/connect/revoke', route(async ({ request, user }) => {
  await identify(user);
  const body = await readJson(request);
  const conn = String(body.conn || '');
  if (!CONN_ID_RE.test(conn)) fail(400, 'invalid', 'Bad connection');
  const rec = await kv().get(KEYS.connect(conn));
  if (!rec || rec.role !== 'host') return { ok: true, already: true };
  const word = await verifyAttestation(rec.secret, body.token, { conn, kind: 'revoke' });
  if (!word || !isId(word.u)) fail(401, 'bad_attestation', 'That workspace could not vouch for this; try again');
  const target = word.u;
  const ws = await kv().get(KEYS.ws(rec.ws));
  const channel = ws?.channels?.[rec.ch];
  if (!ws || !channel || !channel.connections?.[conn]) return { ok: true, already: true };
  ws.members = ws.members || {};
  // The seat ends in the copy the word reached, a move under way or not: a
  // card from a connected workspace does not travel with a move (see the
  // import), so nothing of this is lost to one; a copy that has moved, or
  // is still being imported, takes no writes.
  assertWritable(ws, { moving: true });
  // Remembered on the connection whether or not a seat is here to end (a
  // join token signed before this word is refused by it); words older than
  // any token could still be are let go of.
  const cutoff = now() - ATTEST_TTL_MS - 60_000;
  const spent = Object.entries(rec.revoked || {}).filter(([u, at]) => u !== target && !(Number(at) > cutoff)).map(([u]) => `revoked.${u}`);
  if (spent.length) await kv().remove(KEYS.connect(conn), ...spent).catch(() => {});
  if (!(Number(own(rec.revoked || {}, target)) >= word.iat)) await kv().update(KEYS.connect(conn), { [`revoked.${target}`]: word.iat }).catch(() => {});
  const existing = own(ws.members, target);
  if (!existing || !isExternal(existing)) return { ok: true, already: true };
  // Here through another workspace as well, by their card, which names
  // whichever connected workspace vouched for them last (see partnerConnOf,
  // and disconnect, which keeps such a person when a connection ends): that
  // workspace still stands behind them, and this one's word leaves them to
  // it. Taken out all the same, they were thrown out of a channel their
  // other workspace still vouched for, until its next renewal seated them again.
  const via = existing.org?.ref;
  if (via && via !== channel.connections[conn]?.ref && Object.values(channel.connections).some((c) => c && c.ref === via)) return { ok: true, already: true };
  // Vouched for again since this word was signed (see `att`, or for a card
  // from before it, when the standing was last set): the newer word stands.
  const vouchedAt = Number(existing.att) || (Number(existing.exp) || 0) - EXTERNAL_TTL_MS;
  if (vouchedAt > word.iat) return { ok: true, already: true };
  // A card whose standing ran out long ago is also the sweep's to let go of
  // (see lapseExternals), and the two could meet on it: a bootstrap's sweep
  // and this word arriving in the same instant each counted the person out
  // of the channel and its connection, and the channel counted one fewer
  // than it held, for good. This word takes the claim the sweep takes (see
  // claimLapse); lost, the sweep is at it, and there is nothing left to do.
  if (sweepable(existing) && !(await claimLapse(ws.id, target, existing))) return { ok: true, already: true };
  const doc = (await kv().get(KEYS.member(ws.id, target))) || {};
  const channels = Array.isArray(doc.channels) ? doc.channels : [];
  if (!channels.includes(channel.id)) return { ok: true, already: true };
  // Out of the channel as a disconnect takes them out (see disconnect): the
  // counts, the private list, a line, their seat in its huddle; out of the
  // workspace with it when it was their last channel here.
  let left = channels.filter((x) => x !== channel.id);
  let closed = null;
  if (!left.length) {
    // Their last channel here, so they go from the workspace: their document
    // is closed first, and what the closing hands back decides (see
    // closeMemberDoc, enterChannel, and disconnect, which does the same). A
    // channel they were entering in this very moment is either on it, and
    // they stay, in that channel, the stamp taken off again; or it is not,
    // and the entry, finding the stamp, counts nothing and answers that
    // their standing changed. Read once and deleted, an entry landing
    // between the two was counted into a channel by someone who then went.
    closed = await closeMemberDoc(ws.id, target);
    left = (Array.isArray(closed.channels) ? closed.channels : []).filter((x) => x !== channel.id);
    if (left.length) await kv().remove(KEYS.member(ws.id, target), 'gone').catch(() => {});
  }
  await kv().incr(KEYS.ws(ws.id), { [`channels.${channel.id}.count`]: -1, [`channels.${channel.id}.connections.${conn}.count`]: -1 }).catch(() => {});
  if (channel.private) await kv().update(KEYS.ws(ws.id), { [`channels.${channel.id}.members`]: (channel.members || []).filter((u) => u !== target) }).catch(() => {});
  if (!channel.archived) await postSystem(ws.id, channel.id, target, `${existing.name || existing.username || 'Someone'} left`).catch(() => {});
  if (left.length) {
    await kv().update(KEYS.member(ws.id, target), { channels: left });
    await dropPresence(ws.id, target, channel.id);
    await pokeMember(ws.id, target).catch(() => {});
  } else {
    await removeExternal(ws, target, closed || doc);
  }
  await bumpWorkspace(ws.id);
  return { ok: true };
}));

/** The host's admins let someone they removed from the shared channels come back through their workspace. */
router.delete('/api/ws/:ws/removed/:uuid', route(async ({ params, user }) => {
  const { id, ws, member } = await requireMembership(params.ws, user, { write: true, doc: false });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can restore someone');
  if (!own(ws.removed || {}, params.uuid)) fail(404, 'not_found', 'Nobody by that id was removed');
  await forgetRemoved(ws, params.uuid);
  await bumpWorkspace(ws.id);
  return { ok: true };
}));

/** The host's admins end a connection from their side. */
router.delete('/api/ws/:ws/channels/:ch/connections/:conn', route(async ({ params, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user, { write: true });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can disconnect a workspace');
  const channel = own(ws.channels, params.ch);
  // A private channel the caller is not in is no channel to them (see the delete route).
  if (!channel || (channel.private && !doc.channels.includes(params.ch))) fail(404, 'not_found', 'Channel not found');
  if (!CONN_ID_RE.test(params.conn) || !own(channel.connections, params.conn)) fail(404, 'not_found', 'That workspace is not connected to this channel');
  await disconnect(ws, channel, params.conn, `${member.name} disconnected ${channel.connections[params.conn].name}`);
  return { ok: true };
}));

/**
 * The partner side: an admin who accepted a share link records the
 * connection here, as an entry that stands for the channel in this
 * workspace (with its own name) and the secret this worker signs
 * attestations with. The admin is in it from the start; their app joins
 * them on the host next.
 */
router.post('/api/ws/:ws/channels/shared', route(async ({ params, request, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user, { write: true });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can add a shared channel');
  const body = await readJson(request);
  const ref = String(body.ref || '');
  const rch = String(body.ch || '');
  const conn = String(body.conn || '');
  const secret = String(body.secret || '');
  if (!REF_RE.test(ref) || !/^[a-z0-9]{6,20}$/.test(rch) || !CONN_ID_RE.test(conn) || !SECRET_RE.test(secret)) fail(400, 'invalid', 'Bad connection details');
  const name = cleanChannelName(body.name);
  if (!name) fail(400, 'invalid', 'Channel names use lowercase letters, numbers, and hyphens');
  const host = cleanLine(body.host, LIMITS.workspaceName) || 'another workspace';
  const ts = now();
  // A connection's partner record belongs to the workspace that accepted
  // it. Connection ids are no secret (every member of either workspace sees
  // them), so one held by another workspace on this worker is not taken
  // over: that would leave its members unable to renew their seats.
  const held = await kv().get(KEYS.connectPartner(conn));
  if (held && held.ws !== ws.id) fail(409, 'exists', 'That connection belongs to another workspace');
  const dup = Object.values(ws.channels).find((c) => isPartnerEntry(c) && c.shared.ref === ref && c.shared.ch === rch);
  if (dup) {
    // Connected already (an accept repeated, or a renewed secret): the entry
    // stays where people put it; only the credentials move on.
    if (dup.shared.conn !== conn) {
      const old = await kv().get(KEYS.connectPartner(dup.shared.conn)).catch(() => null);
      if (old && old.ws === ws.id) await kv().del(KEYS.connectPartner(dup.shared.conn)).catch(() => {});
    }
    await kv().set(KEYS.connectPartner(conn), { ws: ws.id, ch: dup.id, ref, rch, secret, role: 'partner', createdAt: ts, by: id.uuid });
    await kv().update(KEYS.ws(ws.id), { [`channels.${dup.id}.shared.conn`]: conn, [`channels.${dup.id}.shared.host`]: host });
    await bumpWorkspace(ws.id);
    return { channel: { ...dup, shared: { ...dup.shared, conn, host } }, already: true };
  }
  if (Object.values(ws.channels).some((c) => c.name === name)) fail(409, 'exists', `#${name} already exists`);
  if (Object.keys(ws.channels).length >= 200) fail(400, 'limit', 'This workspace has the maximum number of channels');
  const chId = uid(10);
  const channel = {
    id: chId, name, topic: cleanLine(body.topic, LIMITS.channelTopic), private: false, def: false,
    createdBy: id.uuid, createdAt: ts, count: 0,
    shared: { ref, ch: rch, conn, host, at: ts },
  };
  await kv().set(KEYS.connectPartner(conn), { ws: ws.id, ch: chId, ref, rch, secret, role: 'partner', createdAt: ts, by: id.uuid });
  await kv().update(KEYS.ws(ws.id), { [`channels.${chId}`]: channel });
  // The admin enters the entry and is counted in (see enterMadeChannel); the answer carries it as it stands.
  await enterMadeChannel(ws, id, doc, chId, { conn });
  channel.count = 1;
  await pokeAndBump(ws.id, id.uuid);
  return { channel };
}));

/**
 * An attestation for the caller towards the host of a shared channel: to
 * join (anyone in the channel here) or to disconnect (admins). The client
 * asks for one whenever the host wants a fresh word from this workspace.
 */
router.post('/api/ws/:ws/channels/:ch/attest', route(async ({ params, request, user }) => {
  const { id, ws, doc, member } = await requireMembership(params.ws, user);
  const channel = own(ws.channels, params.ch);
  if (!channel || !isPartnerEntry(channel)) fail(404, 'not_found', 'Channel not found');
  // This workspace vouches for its members; a guest is in a channel here, not one of them.
  if (isLimited(member)) fail(403, 'forbidden', isExternal(member) ? 'This workspace vouches for its own members; you are here through a channel shared with your workspace, which vouches for you' : 'Guests cannot take part in a shared channel');
  const body = await readJson(request);
  const kind = body.kind === 'disconnect' ? 'disconnect' : 'join';
  if (kind === 'disconnect' && !isAdmin(member)) fail(403, 'forbidden', 'Only admins can disconnect a shared channel');
  if (kind === 'join' && !doc.channels.includes(params.ch)) fail(403, 'not_joined', 'Join the channel first');
  return attestFor(ws, channel, id.uuid, kind);
}));

/**
 * Add members to a channel: any current member of a private channel may
 * invite; in a public channel only admins add people, and only guests need
 * adding (members join public channels themselves). Guests cannot add.
 */
router.post('/api/ws/:ws/channels/:ch/members', route(async ({ params, request, user }) => {
  const { id, ws, doc, member } = await requireMembership(params.ws, user, { write: true });
  const channel = own(ws.channels, params.ch);
  const joined = doc.channels.includes(params.ch);
  // A channel the caller cannot see is no channel to them, as everywhere
  // (see resolveConv): a private one they are not in, or any one a guest is
  // not in. A public channel they can see but have not joined is another
  // matter: adding people to a channel takes being in it, and someone
  // looking at the channel (an admin, from its details) was told it was not
  // there. They are told what to do instead.
  if (!channel || ((channel.private || isLimited(member)) && !joined)) fail(404, 'not_found', 'Channel not found');
  if (isLimited(member)) fail(403, 'forbidden', `${limitedWho(member)} cannot add people`);
  if (isPartnerEntry(channel)) fail(400, 'shared', 'People join a shared channel themselves, from its row in the sidebar');
  if (!joined) fail(403, 'not_joined', 'Join the channel to add people to it');
  if (channel.archived) fail(403, 'archived', 'This channel is archived');
  const body = await readJson(request);
  // People from a connected workspace are in the channel shared with it and
  // nowhere else: they are never added to another channel.
  // Anyone in the channel may bring workspace members in; a guest joins a
  // public channel only by an admin's hand, since being added widens what
  // they see.
  let uuids = (Array.isArray(body.uuids) ? body.uuids : []).filter((u) => own(ws.members, u) && !isExternal(ws.members[u])).slice(0, 50);
  if (!channel.private && !isAdmin(member)) {
    uuids = uuids.filter((u) => !isGuest(ws.members[u]));
  }
  // A private channel's member list lives on the workspace document: room
  // for it is checked as for a channel or a description.
  if (channel.private) assertWorkspaceRoom(ws);
  const current = new Set(channel.members || []);
  const added = [];
  const cursors = new Map();
  let guests = 0;
  // Someone added starts at the channel's present, as someone joining does:
  // the history before them is not unread, and a mention of them in it
  // (an admin's "let's add @bob") is not a badge waiting for them.
  const seqNow = uuids.length ? Number(await kv().get(KEYS.seq(params.ch))) || 0 : 0;
  // Everyone's document at once, then their entries a dozen at a time, as
  // every fan-out here goes (see getMany); each entry is its own claim on
  // its own document, so they need no order among them. One person after
  // another, as it used to be (their document read, their entry made, their
  // cursor written, their tabs poked, each awaited in turn), adding fifty
  // people ran this request through two hundred round trips to the store in
  // a row, seconds under the admin's finger, with the workspace's own
  // deletion held to a fraction of that for the same reason.
  uuids = [...new Set(uuids)];
  const targets = await getMany(uuids.map((u) => KEYS.member(ws.id, u)));
  const entries = [];
  for (let i = 0; i < uuids.length; i += 12) {
    entries.push(...(await Promise.all(uuids.slice(i, i + 12).map(async (u, j) => {
      // Membership is the member's document; the private channel's list is a
      // mirror of it, rewritten when someone leaves, and a rewrite lost to a
      // race or a request cut short leaves a name on the list of someone who
      // is out. That name used to be skipped here before the document was
      // asked, so "Add people" answered that everyone was already in and the
      // person stayed out; the document decides, and the list is only added to.
      const target = targets[i + j] || {};
      if ((target.channels || []).includes(params.ch)) return null;
      return { u, target, entry: await enterChannel(ws.id, u, params.ch, target) };
    }))));
  }
  for (const e of entries) {
    // Put in by another request meanwhile, or on their way out of the
    // workspace this very moment (see enterChannel): not added, not counted.
    if (!e || e.entry.status !== 'entered') continue;
    cursors.set(e.u, { [`reads.${params.ch}`]: Math.max(seqNow, Number(e.target.reads?.[params.ch]) || 0), ...caughtUpMentions(e.target, params.ch) });
    added.push(e.u);
    // Counted as what they are as of the append: a guest, or being made one (see enterChannel).
    if (e.entry.role ? e.entry.role === 'guest' : isGuest(ws.members[e.u])) guests++;
  }
  if (added.length) {
    const counted = await kv().incr(KEYS.ws(ws.id), { [`channels.${params.ch}.count`]: added.length, ...(guests ? { [`channels.${params.ch}.guests`]: guests } : {}) });
    // Deleted between the read above and these writes: they made a nameless
    // entry of the channel, taken off again (see channelStands), and nobody
    // was added to anything.
    if (!(await channelStands(ws.id, params.ch, counted))) fail(404, 'not_found', 'Channel not found');
    // Someone taken out of the workspace between the append and the count
    // (their card is gone from what the count handed back) was not added:
    // the count is right on both sides, the removal having closed their
    // document after the append and counted them out of this channel with
    // the rest (see enterChannel, and the join routes, which read the count
    // the same way), and nothing more is written for someone who is out: no
    // cursor under a document the removal deleted (which made a document of
    // the cursor alone for someone gone), no line naming them as added, and
    // no name of theirs onto a private channel's list. The name went on
    // before the count asked, a name with no card behind it (the removal
    // rewrites the list from its own reading, and had already): the list
    // then held someone for the last real member to leave past, into a
    // channel hidden from every admin that nobody could open or delete.
    const cards = counted && typeof counted === 'object' && counted.members ? counted.members : null;
    const held = cards ? added.filter((u) => own(cards, u)) : added;
    if (!held.length) return { added: [] };
    // Their cursors a dozen at a time, and then one poke naming them all (see
    // incrPaths, and pokeMember for what a poke is), the cursors on their
    // documents before any tab is told to read them again.
    for (let i = 0; i < held.length; i += 12) {
      await Promise.all(held.slice(i, i + 12).map((u) => kv().update(KEYS.member(ws.id, u), cursors.get(u))));
    }
    await incrPaths(KEYS.activity(ws.id), Object.fromEntries(held.map((u) => [`u.${u}`, 1])));
    if (channel.private) await addPrivateMember(ws.id, params.ch, held.filter((u) => !current.has(u)));
    const names = held.map((u) => ws.members[u].name).join(', ');
    await postSystem(ws.id, params.ch, id.uuid, `${ws.members[id.uuid].name} added ${names}`);
    await bumpWorkspace(ws.id);
    return { added: held };
  }
  return { added };
}));

/**
 * Who is in a channel. Private channels keep their list; public ones are
 * answered from members' own documents, which bounds the cost to one get
 * per workspace member and only when someone asks.
 */
router.get('/api/ws/:ws/channels/:ch/members', route(async ({ params, user }) => {
  const { id, ws, doc, member } = await requireMembership(params.ws, user);
  const channel = own(ws.channels, params.ch);
  if (!channel || ((channel.private || isLimited(member)) && !doc.channels.includes(params.ch))) fail(404, 'not_found', 'Channel not found');
  if (isPartnerEntry(channel)) fail(404, 'shared_elsewhere', 'This channel lives on another workspace');
  if (channel.private) return { members: channel.members || [] };
  // Every member's document but the caller's, which the request has read already (see memberDocsReader).
  const docs = await memberDocsReader(ws, { uuid: id.uuid, doc })();
  const members = [...docs].filter(([, d]) => (d?.channels || []).includes(params.ch)).map(([u]) => u);
  return { members };
}));

/* ---- direct messages --------------------------------------------------- */

router.post('/api/ws/:ws/dms', route(async ({ params, request, user }) => {
  const { id, ws, doc, member } = await requireMembership(params.ws, user, { write: true });
  const body = await readJson(request);
  const named = [...new Set((Array.isArray(body.members) ? body.members : []).filter((u) => u !== id.uuid))];
  const others = named.filter((u) => own(ws.members, u));
  // A guest, or someone from a connected workspace, is shown the people of
  // their channels and nobody else: whether an id they name is a member here
  // at all is not theirs to learn, so a stranger is refused the way a member
  // they share no channel with is (below), rather than dropped from the list.
  if (isLimited(member) && others.length !== named.length) fail(403, 'forbidden', 'You can only message people in your channels');
  if (!named.length) fail(400, 'invalid', 'Pick at least one person');
  // Someone named who is not here (they left, or were removed, since the
  // list the tab drew them from): the conversation is not made without
  // them. Made of the rest, as it used to be, a group of three named with
  // someone gone became the two's own direct message, opened as if a group
  // had been made; and a message to a former member alone was refused as
  // "pick at least one person", which said nothing of why. Named where the
  // workspace still remembers them (see rememberFormer), as the app names
  // them on a former member's card before it asks (see store.openDmWith).
  if (others.length !== named.length) {
    const gone = named.find((u) => !own(ws.members, u));
    const who = own(ws.former || {}, gone)?.name;
    fail(400, 'invalid', `${who || (named.length === 1 ? 'They' : 'Someone you picked')} ${who || named.length > 1 ? 'is' : 'are'} no longer in this workspace`);
  }
  if (others.length > LIMITS.dmMembers - 1) fail(400, 'limit', `Group messages hold up to ${LIMITS.dmMembers} people`);
  // A guest only messages people they share a channel with, and only such
  // people can message a guest: the guest's world is their channels. The
  // same goes for someone from a connected workspace.
  const guests = [id.uuid, ...others].filter((u) => isLimited(ws.members[u]));
  // Every member document this request reads is read once, through one memo
  // (see memberDocsMemo): a guest's own document, for the channels their
  // world is made of; everyone's, for who is in a public channel of theirs
  // (asked for each guest in turn, as it used to be, a group message naming
  // eight people from a connected workspace read every document in the
  // workspace eight times over); and each named person's, below, for the
  // conversation they may already have and the room on their document for
  // one. Read through three readers, as they used to be, a guest's document
  // was read three times in one request, and every named member's twice.
  const memo = memberDocsMemo(ws.id, { uuid: id.uuid, doc });
  const everyone = Object.keys(ws.members).slice(0, 500);
  let everyoneRead = null;
  const readDocs = () => {
    if (!everyoneRead) everyoneRead = memo(everyone).then((list) => new Map(everyone.map((u, i) => [u, list[i]])));
    return everyoneRead;
  };
  for (const g of guests) {
    const gdoc = g === id.uuid ? doc : (await memo([g]))[0] || { channels: [] };
    // Their channels, and the people already in a direct message with them
    // (see peersOf): the conversation the two have is theirs to open again
    // from either side once they no longer share a channel.
    const peers = await peersOf(ws, { channels: gdoc.channels || [], dms: gdoc.dms || {} }, readDocs);
    for (const u of [id.uuid, ...others]) {
      if (u !== g && !peers.has(u)) {
        fail(403, 'forbidden', g === id.uuid ? 'You can only message people in your channels'
          : isExternal(ws.members[g]) ? 'People from a connected workspace can only be messaged by people in the channel shared with them'
            : 'Guests can only be messaged by people in their channels');
      }
    }
  }
  const members = [id.uuid, ...others].sort();
  const real = members.filter((u) => !u.startsWith('smp_'));
  // The conversation these people already have, under this workspace's id
  // or the unscoped one from before ids were scoped, in any of their member
  // documents; a new one is minted under the scoped id.
  const targets = real.filter((u) => u !== id.uuid);
  const docs = await memo(targets);
  const all = [doc, ...docs];
  const candidates = [dmConvId(members), dmConvId(members, ws.id)];
  const convId = candidates.find((c) => all.some((d) => own(d?.dms, c))) || dmConvId(members, ws.id);
  const existing = all.map((d) => own(d?.dms, convId)).find(Boolean);
  if (existing) {
    // Give it to anyone who does not have it: a conversation only one side
    // can see swallows messages, and the two sides can drift apart when a
    // member is removed and comes back, or when the writes below are cut
    // short.
    // Their documents a dozen at a time and one poke for all (see incrPaths,
    // and pokeMember for what a poke is), as the new conversation's go below.
    const lacking = real.filter((u) => !own((u === id.uuid ? doc : docs[targets.indexOf(u)])?.dms, convId));
    for (let i = 0; i < lacking.length; i += 12) await Promise.all(lacking.slice(i, i + 12).map((u) => kv().update(KEYS.member(ws.id, u), { [`dms.${convId}`]: existing })));
    // This was the one write path in the worker that moved a member's `u.*`
    // with nothing to wake them: a client reads such a change turning up on a
    // plain safety poll as its own subscription having gone silent (see
    // _evCheckSync), so opening the same direct message with someone three
    // times over cost them a working subscription and five minutes of plain
    // polling for it.
    if (lacking.length) {
      await incrPaths(KEYS.activity(ws.id), Object.fromEntries(lacking.map((u) => [`u.${u}`, 1])));
      await signal(ws.id, lacking);
    }
    return { conv: convId, members, already: !!own(doc.dms, convId) };
  }
  // A new conversation is an entry on every participant's document, for
  // good (there is no closing one). One member could start thousands, each
  // naming another member with a different set of others, until that
  // member's document passed what the store takes and nothing of theirs
  // could be written again; and a member's own list has an end too. The
  // caller's list is capped, and every participant's document must have room.
  // The count said is the caller's own: others starting conversations with
  // them can take it past the cap, and "you are in 500 already" then read as
  // a miscount beside a list of 512.
  const held = Object.keys(doc.dms).length;
  if (held >= LIMITS.dmsPerMember) fail(400, 'limit', `You can be in up to ${LIMITS.dmsPerMember} direct message conversations, and you are in ${held} already`);
  assertMemberRoom(doc);
  targets.forEach((u, i) => assertMemberRoom(docs[i], ws.members[u]?.name || 'That person'));
  const ts = now();
  const entry = { members, createdAt: ts };
  // Only if it is not there: the same people opening the conversation from
  // both sides (or from two tabs) at once each found nobody had it and came
  // here to create it, and the slower one's bare write of an empty first
  // block erased whatever the faster side had already posted into it, the
  // counter still counting a message no block held.
  await ensureBlock(convId, 0);
  // The entry onto every participant's document a dozen at a time, then the
  // others' tabs told with one write (see incrPaths): one after another, as
  // they used to be written, a group message of nine cost eighteen round
  // trips to the store in a row before the dialog could open it.
  for (let i = 0; i < real.length; i += 12) await Promise.all(real.slice(i, i + 12).map((u) => kv().update(KEYS.member(ws.id, u), { [`dms.${convId}`]: entry })));
  const told = real.filter((u) => u !== id.uuid);
  // Signalled for the same reason as the existing-conversation branch above.
  if (told.length) {
    await incrPaths(KEYS.activity(ws.id), Object.fromEntries(told.map((u) => [`u.${u}`, 1])));
    await signal(ws.id, told);
  }
  return { conv: convId, members };
}));

/* ---- messages ---------------------------------------------------------- */

router.get('/api/ws/:ws/conv/:conv/messages', route(async ({ params, request, user }) => {
  const prefetch = looksLikeConvId(params.conv) ? [KEYS.seq(params.conv)] : [];
  const ctx = await requireMembership(params.ws, user, { also: prefetch });
  resolveConv(ctx, params.conv);
  return fetchMessages(params.conv, query(request), prefetch.length ? ctx.extra[0] : undefined);
}));

/**
 * The broadcast a text asks for (@channel, @here, @everyone), or null, once
 * it is allowed here: who may send one is a channel setting, and @everyone
 * belongs to the default channel only. Run when a message is posted and
 * when one is scheduled, so a message that would be refused is refused to
 * the author's face rather than dropped at its time with nothing said.
 */
function assertBroadcast(ctx, conv, text) {
  const bc = broadcastKind(extractMentionNames(text));
  if (!bc) return null;
  const channel = conv.channel || null;
  if (channel && broadcastPolicy(channel) === 'admins' && !isAdmin(ctx.member)) {
    fail(403, 'broadcast_forbidden', `Only admins can notify everyone in #${channel.name}`);
  }
  if (bc === 'everyone' && (!channel || !channel.def)) {
    fail(400, 'broadcast_scope', '@everyone only works in a default channel; use @channel here');
  }
  return bc;
}

/**
 * A reply needs a root that exists and stands: replying to a sequence
 * number nobody has posted yet would count the reply on a message that
 * arrives later, and a deleted one is closed. Returns the root as located,
 * or null for a conversation that is not a thread.
 */
async function assertThreadRoot(conv) {
  if (conv.kind !== 'thread') return null;
  const root = await locateMessage(conv.parent.conv, conv.parent.seq);
  if (!root || root.overlay.d) fail(404, 'not_found', 'Message not found');
  // A line the worker wrote (someone joined, a pin, a huddle that ended; a
  // reminder in one's own space) has no thread: the app offers no reply
  // under one, and a reply posted under one by its address would count the
  // line's subject as the thread's author and its follower, told of every
  // reply under a line they never wrote.
  if (root.raw.k === 'sys') fail(400, 'invalid', 'System lines have no thread');
  if (root.raw.k === 'rem') fail(400, 'invalid', 'Reminders have no thread');
  return root;
}

/**
 * Post a message as `ctx.uuid` into a conversation: validation, attachments,
 * mentions and broadcasts, the write itself, the index, read cursor, mention
 * counters, inboxes, and thread bookkeeping. Shared by the live route and by
 * scheduled delivery (`scheduled`), so a message sent later behaves like one
 * sent now, but for the author's own read cursor (see below). Returns
 * { message, notified }.
 */
/**
 * Refuse a post where the conversation says the caller may not (see
 * resolveConv's `deny`): the code the app acts on and the words it shows.
 * One answer for a message sent now and one scheduled for later, since the
 * composer and the Later view show these words as they come: scheduling into
 * an archived channel, or a thread whose replies are off, used to be told
 * only that one cannot post there, with no word of why.
 */
function refusePost(conv) {
  const name = conv.channel ? `#${conv.channel.name}` : 'this conversation';
  if (conv.deny === 'archived') fail(403, 'archived', 'This channel is archived');
  if (conv.deny === 'read_only') fail(403, 'read_only', `Only admins can post in ${name}`);
  if (conv.deny === 'threads_off') fail(403, 'threads_off', `Replies are turned off in ${name}`);
  if (conv.deny === 'threads_admins') fail(403, 'threads_admins', `Only admins can reply in threads in ${name}`);
  fail(403, 'not_joined', 'Join the channel to post');
}

/**
 * What a post writes on its own author's document, given the number the
 * message took. Lifted out of postMessage so writeMessage can make the write
 * beside the conversation's stamp (see `alongside`); the rules are unchanged.
 *
 * The cursor follows the author's own message, because someone posting is
 * looking at the conversation and their message is its newest — but not for
 * one delivered from the queue at its time, whose author is not looking, and
 * for whom everything posted since they scheduled it is still theirs to read.
 * Moved for a queued message all the same, as it used to be, the cursor
 * marked all of that read (five messages posted after a message was
 * scheduled were read, by the cursor, the moment it went out) and the
 * conversation lost its bold and its count with nothing seen. It follows a
 * queued message only where it stood just before it, with nothing unread in
 * between, as it would have had the author sent it then.
 *
 * The counts a read to the end clears go with the cursor (see the read
 * route, which zeroes them when the cursor reaches the newest message). Left
 * standing, as they used to be, a mention of the author that landed in the
 * moments before their own post — between their tab's polls, so their tab
 * had not read it yet — kept its badge on the sidebar row and in the title
 * of a conversation whose cursor stood at the end, until the tab happened to
 * mark it seen again. Not for a message from the queue, whose author is not
 * looking.
 *
 * And replying to a thread follows it again, on both records that say so:
 * the root's overlay (written by the caller), which is where
 * replies find their followers, and the member's own choice here, which is
 * what their Threads list is drawn from. With only the first put back, every
 * later reply was counted for them under a thread their list hid as
 * unfollowed, and the Threads badge stood for a row nothing shown could clear.
 */
function fillOwnCursor(upd, ctx, conv, convId, seq, scheduled) {
  if (!scheduled || (Number(ctx.doc?.reads?.[convId]) || 0) >= seq - 1) upd[`reads.${convId}`] = seq;
  if (!scheduled) {
    for (const map of ['mentions', 'threads']) {
      if (Number(ctx.doc?.[map]?.[convId]) > 0) upd[`${map}.${convId}`] = 0;
    }
  }
  if (conv.kind === 'thread' && ctx.doc?.notify?.[convId]?.follow === false) upd[`notify.${convId}.follow`] = true;
  return upd;
}

/**
 * Somewhere to put work the answer does not wait on. A request hands in the
 * `defer` its route was given (see worker/lib.js), and the runtime finishes
 * it after the answer has gone out. A caller with none — a scheduled
 * delivery, an import, a webhook — collects the work instead and `settle()`s
 * it before returning, which is exactly what those paths did before, so
 * nothing is left running where nothing is left to run it.
 */
function deferrer(given) {
  if (typeof given === 'function') return { defer: given, settle: async () => {} };
  const jobs = [];
  return {
    defer: (work) => {
      jobs.push(Promise.resolve().then(typeof work === 'function' ? work : () => work).catch((e) => console.error('deferred work failed', e)));
    },
    settle: () => Promise.all(jobs.splice(0)),
  };
}

async function postMessage(ctx, convId, body, { scheduled = false, head = undefined, defer: given = null } = {}) {
  const wsId = ctx.ws.id;
  const { defer, settle } = deferrer(given);
  if (ctx.ws.importing) fail(409, 'importing', 'This workspace is still being imported; try again in a moment');
  // Every member document this post reads is read once (see memberDocsMemo).
  if (typeof ctx.docs !== 'function') ctx.docs = memberDocsMemo(wsId, ctx.doc ? { uuid: ctx.uuid, doc: ctx.doc } : null);
  const conv = resolveConv(ctx, convId);
  // Computed once and reused everywhere this post touches: a thread's own
  // audience is its parent's (resolveConv already folds that in), so the
  // reply's own write and the parent's activity stamp below signal the same
  // people.
  const audience = audienceOf(conv);
  // A client id makes a retry safe: if the same client already got this
  // message in (a response lost after the write), hand back what is there
  // instead of posting it twice. The newest two blocks are enough: a retry
  // follows its original closely. Looked for before the conversation's
  // posting rules are applied (and only in a conversation the caller may
  // read, which resolveConv has just settled): a message that landed is
  // sent, whatever may be posted there now. Judged by the rules first, a
  // retry after the channel had been archived, or the author had left it,
  // or posting there had been limited to admins, was refused as a new post
  // would be, and the outbox set the message aside as "Not sent" for that
  // reason, with a Retry that could only be refused again, while the message
  // stood in the channel for everyone; a scheduled message whose delivery
  // died after the post was marked failed the same way.
  const cid = typeof body.cid === 'string' && /^[a-z0-9_-]{8,40}$/.test(body.cid) ? body.cid : null;
  // Only where this send could be a second one. The check below is what
  // makes a retry safe, and a retry is the only thing it ever finds: an
  // outbox that has never had this entry refused knows it is sending for the
  // first time and says so (`first`), and a first send by definition has no
  // earlier copy of itself to find. Made on every send, as it used to be, a
  // read of the newest blocks stood in front of every message anyone posted
  // to catch the one in ten thousand that is a retry. A client that says
  // nothing — an older one, or any caller but ours — is checked exactly as
  // before, so nothing that used to be safe stops being it.
  if (cid && body.first !== true) {
    // The counter comes with the caller's own document where the route read
    // it there (`head`, see the post route): it is keyed on the conversation
    // alone, so it needs nothing this request has worked out, and read on
    // its own it was a round trip of its own in front of every post.
    const at = head === undefined ? Number(await kv().get(KEYS.seq(convId))) || 0 : Number(head) || 0;
    const n = blockIndexOf(Math.max(1, at));
    const blocks = await getMany(n > 0 ? [KEYS.block(convId, n), KEYS.block(convId, n - 1)] : [KEYS.block(convId, n)]);
    for (const b of blocks) {
      const dup = (b?.m || []).find((m) => m && m.cid === cid && m.u === ctx.uuid);
      if (dup) {
        const merged = mergeBlock(b).find((m) => m.seq === dup.s);
        return { message: merged, notified: 0, duplicate: true };
      }
    }
  }
  if (!conv.canPost) refusePost(conv);
  const text = cleanText(body.text, LIMITS.messageText);
  const attachments = (Array.isArray(body.attachments) ? body.attachments : [])
    .slice(0, LIMITS.attachmentsPerMessage)
    .filter((a) => a && typeof a.id === 'string' && /^[a-z0-9]{8,24}$/.test(a.id));
  if (!text && !attachments.length) fail(400, 'invalid', 'Write something first');
  // Any file uploaded to this workspace may be attached, not only one's
  // own: a forward carries the original's attachments by reference, and
  // every member can download every file of the workspace anyway. A guest
  // may attach only what they could download (see mayTakeFile, the download
  // route's rule), else a file id seen in a channel since lost would come
  // back through a new message, shared into another conversation with its
  // real name.
  const metas = attachments.length ? await getMany(attachments.map((a) => KEYS.file(a.id))) : [];
  const a = [];
  metas.forEach((meta, i) => {
    if (meta && meta.ws === wsId && mayTakeFile(ctx, attachments[i].id, meta)) {
      a.push({ id: attachments[i].id, name: meta.name, size: meta.size, type: meta.type });
    }
  });
  // Attachments that turned out not to exist here leave nothing to post.
  if (!text && !a.length) fail(400, 'invalid', 'Those files are not in this workspace');
  // Only people who can read the conversation are really mentioned; the
  // rest stays text, so a private channel or a direct message never rings,
  // badges, or pushes its contents to someone outside it.
  const mn = await readersAmong(ctx, conv, mentionUuids(ctx.ws, text));
  // A broadcast (@channel, @here, @everyone) is checked before anything is
  // written. The kind is stored on the message rather than the expanded
  // list, so a block never carries hundreds of uuids and a member who
  // joins later still sees it as a mention.
  const bc = assertBroadcast(ctx, conv, text);
  // Like a plain mention, a broadcast reaches only people who can read
  // where it was posted: @everyone in the default channel must not ring,
  // badge, or push a guest who is not in it.
  const reach = bc ? await readersAmong(ctx, conv, await broadcastTargets(ctx, conv, bc)) : [];
  const root = await assertThreadRoot(conv);
  // A thread's first block is made before its first reply is appended, as a
  // channel's and a direct message's are made with them. Every other block
  // is there before anything is appended to it (writeMessage makes the next
  // while the current one fills), so the append never has to read the block
  // and write it back whole; a thread's first block was not, and on a store
  // that refuses to append to a key that does not exist, two people
  // answering a message in the same instant each read no block, each wrote
  // one holding their own reply, and the slower write took the faster one's
  // reply out for good while its author was told it was sent and the root
  // counted it. The root's count says whether the thread has a block yet.
  if (root && !(Number(root.overlay.rc) > 0)) await ensureBlock(convId, 0);
  const ts = now();
  const msg = { u: ctx.uuid, t: text, ts };
  if (a.length) msg.a = a;
  if (mn.length) msg.mn = mn;
  if (bc) msg.bc = bc;
  if (cid) msg.cid = cid;
  const mentionConv = conv.kind === 'thread' ? conv.parent.conv : convId;
  const mentioned = [...new Set([...mn, ...reach])].filter((u) => u !== ctx.uuid);
  // Who hears of a reply as a reply: the thread's followers (its author and
  // everyone who replied, minus anyone who unfollowed), read off the root's
  // overlay before the reply is written. Someone named in the reply follows
  // the thread from here (`pulled`; the root's follower map
  // takes them below, and an unfollow of theirs comes off their document by
  // a path removal, which writes no key where there was none): they were
  // told of the mention, in Activity and on the parent's badge, but the
  // thread reached neither their Threads view nor their count for the
  // replies after it. Named or reached by a broadcast, a follower is
  // already counted as mentioned, and the two are one notice, not a reply on
  // top of it (`named`); the thread still moves up their list. And only
  // followers who can still read the thread hear of the reply: one who has
  // left the private channel (or the direct message's workspace side) since
  // would be handed a counter that nothing clears, because the read and
  // unfollow routes both refuse a conversation they cannot resolve, and the
  // Threads badge would stand for good.
  const followers = new Set();
  let pulled = [];
  let named = [];
  let replyTargets = [];
  if (conv.kind === 'thread' && root) {
    const f = root.overlay.f || {};
    for (const [u, v] of Object.entries(f)) if (v === 1) followers.add(u);
    if (root.raw.u && f[root.raw.u] !== 0) followers.add(root.raw.u);
    followers.delete(ctx.uuid);
    pulled = mn.filter((u) => u !== ctx.uuid && !followers.has(u) && ctx.ws.members[u] && !u.startsWith('smp_'));
    named = [...followers].filter((u) => mentioned.includes(u));
    for (const u of named) followers.delete(u);
    replyTargets = await readersAmong(ctx, conv, [...followers].filter((u) => !u.startsWith('smp_')));
  }
  let notified = 0;
  // The author's own cursor and the badges their own post clears: worked out
  // the moment the message has its number and written beside the
  // conversation's stamp rather than after it (see writeMessage's
  // `alongside`), since the two are different documents and neither answer
  // feeds the other.
  const upd = {};
  let cleared = false;
  // The ring entries this post's one signal carries (see the end): the
  // message, and for a reply the root's new count.
  const entries = [];
  const seq = await writeMessage(wsId, convId, msg, {
    scheduled,
    audience,
    entries,
    // This post signals once, itself, at the very end (see below), once
    // everything it touches is written: the thread-follower poke and the
    // parent's own activity stamp run after this call returns, so a signal
    // here would land before them.
    signal: false,
    // The counters go on once the message has its number and before anyone
    // can read it (see writeMessage): a mention counted on the conversation
    // for everyone named or reached, and a reply counted on the thread for
    // its followers, each poked to refetch the document that carries their
    // count. Counted after the message was announced, a reader looking at
    // the conversation read the message the moment it came, before the
    // count landed, and the read cleared nothing: the badge then stood on a
    // conversation read to its end, on the sidebar row, in the title and in
    // Activity, until they scrolled or the next message came.
    //
    // A reply's mention is the one exception: it is counted on the channel
    // (see mentionConv), whose own counter does not move for a reply, so no
    // read of the reply clears it, and the reader's app tells it from a count
    // left standing by such a read (a mention counted after its message was
    // read, which the ordering above is for) by the thread's own entry in
    // the activity document, written for the reply as it is appended. Counted
    // here, before the append, the count reached a reader's document while
    // the thread's entry was not there to give it away, and the channel's
    // newest message naming them (the very message the thread hangs off)
    // was taken for its cause: their app read the channel to its end again,
    // which cleared the count, and the mention in the reply badged nothing.
    // So a reply's mention is counted below, once the thread's entry is in,
    // and still before the channel's stamp moves for the reply.
    before: async () => {
      if (conv.kind !== 'thread') notified = await notifyMentions(wsId, mentionConv, mentioned);
      for (let i = 0; i < replyTargets.length; i += 12) {
        await Promise.all(replyTargets.slice(i, i + 12).map((u) => kv().incr(KEYS.member(wsId, u), { [`threads.${convId}`]: 1 }).catch(() => {})));
      }
      // Each poked with the moment of the poke, as notifyMentions pokes (a
      // stamp from before the counters could sit below one another route wrote meanwhile).
      if (replyTargets.length) {
        const at = now();
        await kv().update(KEYS.activity(wsId), Object.fromEntries(replyTargets.map((u) => [`u.${u}`, at]))).catch(() => {});
      }
    },
    alongside: (s) => {
      fillOwnCursor(upd, ctx, conv, convId, s, scheduled);
      cleared = ['mentions', 'threads'].some((map) => upd[`${map}.${convId}`] === 0);
      // Only where there is something to write: a delivery that leaves the
      // cursor where it stood (the common case, something unread in between)
      // has nothing for the document, and a write of nothing is a round trip
      // whose answer, on a store not ours, is nobody's to vouch for.
      return Object.keys(upd).length ? kv().update(KEYS.member(wsId, ctx.uuid), upd) : null;
    },
  });
  // A reply's mention, counted on the channel now that the thread's entry
  // names the reply (see above); the channel's stamp moves for it further down.
  if (conv.kind === 'thread') notified = await notifyMentions(wsId, mentionConv, mentioned);
  // Each message holding a file is one reference; the bytes go when the last
  // one is deleted. The conversations a file was shared in are noted too,
  // so a guest is served only files from channels they are in. Started here
  // and waited on at the end of the post (`written`), beside the author's own
  // cursor and the Activity entries: each touches a different document, and
  // one after another a message with five files cost five round trips in a
  // row before its sender heard anything.
  const written = a.length ? [holdFiles(convId, a.map((f) => f.id))] : [];

  // The Activity entry names the message, so it follows the write; the count it stands beside went on before (see above).
  if (mentioned.length) written.push(pushInbox(wsId, mentioned, { k: 'mention', c: convId, s: seq, by: ctx.uuid, ts, bc: bc || undefined }));
  await Promise.all(written);
  // A choice changed for them is theirs to refetch (as a badge cleared is,
  // see the read route): their open tabs draw the thread's header and their
  // Threads list from the document they hold, which said otherwise. Once
  // per thread, not once per message, so the poll is not made to fetch the
  // workspace over and over. After the cursor above, whose write it is for.
  if (upd[`notify.${convId}.follow`] || cleared) await pokeMember(wsId, ctx.uuid).catch(() => {});
  // Notifications, the app's only ones: a mention (or broadcast) reaches
  // those mentioned, a direct message the other members, a reply the
  // thread's followers, and a channel message whoever hears that channel at
  // "all messages". Each recipient's own settings decide.
  // A reply inside a direct message is a direct message to the others in
  // it (a thread carries its parent's `dm`), and is pushed as one.
  const dmOthers = conv.dm ? conv.dm.members.filter((u) => u !== ctx.uuid) : [];
  const hearsAll = conv.channel && conv.kind !== 'thread' && !conv.dm;
  let pushJob = null;
  if (mentioned.length || dmOthers.length || replyTargets.length || hearsAll) {
    const author = ctx.ws.members[ctx.uuid];
    pushJob = async () => {
      let hearAll = [];
      if (hearsAll) {
        const heard = (await kv().get(KEYS.notifyAll(wsId)).catch(() => null))?.[convId] || {};
        const readers = audienceOf(conv);
        hearAll = Object.keys(heard).filter((u) => u !== ctx.uuid && ctx.ws.members[u] && (!readers || readers.includes(u)));
      }
      const pushTargets = [...new Set([...mentioned, ...dmOthers, ...replyTargets, ...hearAll])].slice(0, PUSH_FANOUT);
      if (!pushTargets.length) return;
      await sendPushes(ctx.ws, pushTargets, {
        mentioned: new Set(mentioned), replies: new Set(replyTargets), channel: conv.channel && !conv.dm ? convId : null,
        conv: convId, mentionConv, seq, kind: conv.dm ? 'dm' : conv.kind,
        title: conv.dm ? author?.name || 'Direct message' : `${author?.name || 'Someone'} in #${conv.channel?.name || 'channel'}`,
        // The first 120 characters, cut between whole ones (see cleanText): a
        // character written as two units (an emoji) straddling the cut left
        // its first half at the end, which the encoder turned into a
        // replacement mark on the device.
        body: bc ? `@${bc}: ${cleanText(text, 120)}` : cleanText(text, 120),
        threadRoot: conv.kind === 'thread' ? conv.parent : null,
      }, ctx.docs);
    };
  }
  if (conv.kind === 'thread') {
    const k = overlayKey(conv.parent.seq);
    const parentKey = KEYS.block(conv.parent.conv, blockIndexOf(conv.parent.seq));
    const counted = await kv().incr(parentKey, { [`x.${k}.rc`]: 1 });
    // What the reply leaves on the root's record goes in one write: the time
    // of the last reply, and (the followers were counted with the write, see
    // above) the follow flags of what names the reply or whom it brought in,
    // the author's own (following again) and those of the people
    // the reply named (`pulled`). Written one after another, as they used to
    // be, a first reply of someone's that named a person cost the block
    // three round trips where one carries all three.
    const marks = { [`x.${k}.rt`]: ts };
    const f = root?.overlay.f || {};
    // Only where the root's block has room for the names (see blockHasRoom):
    // written onto a block at what the store holds, the flags took the
    // write down with them, the reply already stored and counted, and the
    // sender was told it had failed. Without the flags the author and the
    // people named are not counted for the replies to come, as before.
    const flags = root ? [ctx.uuid, ...pulled].filter((u) => f[u] !== 1) : [];
    const following = flags.length && blockHasRoom(root.block, flags.length * 60) ? flags : [];
    for (const u of following) marks[`x.${k}.f.${u}`] = 1;
    await kv().update(parentKey, marks);
    // The channel's stamp for the reply is of this moment, not of the reply's
    // time, taken before the counters, the index, the inbox entries and the
    // pushes that come between (see writeMessage): a tab that polled in
    // between must still be told of it. Signalled by the post's one final
    // signal below, with everything else it writes.
    const x = now();
    await kv().update(KEYS.activity(wsId), { [`c.${conv.parent.conv}.x`]: x });
    // The count as the increment left it, which only ever grows here, so a
    // reader takes the larger of it and what it holds (see applyOverlayPatch).
    const rc = Number(counted?.x?.[k]?.rc);
    const patch = { rt: ts, ...(Number.isFinite(rc) ? { rc } : {}), ...(following.length ? { f: following } : {}) };
    entries.push({ conv: conv.parent.conv, body: Number.isFinite(rc) ? { a: { x }, s: conv.parent.seq, p: patch } : { a: { x } }, slim: { a: { x } } });
    // The rest of what follows the reply: the choice of those it brought in,
    // the Activity entries, and the Threads view's list of every thread a
    // member is in, newest activity first.
    if (root) {
      if (pulled.length) {
        for (let i = 0; i < pulled.length; i += 12) {
          await Promise.all(pulled.slice(i, i + 12).map((u) => kv().remove(KEYS.member(wsId, u), `notify.${convId}.follow`).catch(() => {})));
        }
      }
      if (replyTargets.length) await pushInbox(wsId, replyTargets, { k: 'reply', c: convId, s: seq, by: ctx.uuid, ts });
      await touchThreads(wsId, [...replyTargets, ...named, ...pulled, ctx.uuid].filter((u) => ctx.ws.members[u]), convId, conv.parent, ts);
    }
  }
  // What is left runs behind the answer (see worker/lib.js's route): none of
  // it is anything the sender is told, and all of it — a push per device,
  // each an HTTP call to its service, and the index's counter, log append
  // and every sixty-fourth message a fold into the month shards — used to
  // stand between their message landing and their being told so.
  //
  // In order, and the signal first: it is the last write anyone reading this
  // post could see, made once every write the post depends on is done (the
  // message itself, which writeMessage left unsignalled, the mention and
  // reply counters, the thread-follower poke, and the parent's touchConv),
  // so a subscription woken by it never finds a partial view. What follows
  // it writes nowhere such a reader looks: the index catches up on its own,
  // and a push reaches a device, not this workspace.
  //
  // Ring entries carry the message and the root's count; the plain ping
  // still reaches everyone whose own document this post moved (a mention or
  // reply counted for them), which no entry says.
  defer(async () => {
    await signal(wsId, audience, { entries, ws: ctx.ws, others: [...new Set([...mentioned, ...replyTargets])] });
    await Promise.all([
      indexMessage(wsId, convId, msg).catch(() => {}),
      pushJob ? pushJob() : null,
    ]);
  });
  await settle();
  return {
    message: {
      seq, user: ctx.uuid, text, ts, kind: 'msg', attachments: a, mentions: mn, broadcast: bc,
      editedAt: null, deleted: false, reactions: {}, replyCount: 0, lastReplyAt: null,
    },
    notified,
  };
}

router.post('/api/ws/:ws/conv/:conv/messages', route(async ({ params, request, user, defer }) => {
  // The conversation's counter is keyed on the conversation alone, so it is
  // read with the caller's own document rather than after it.
  const prefetch = looksLikeConvId(params.conv) ? [KEYS.seq(params.conv)] : [];
  const ctx = await requireMembership(params.ws, user, { write: true, also: prefetch });
  const body = await readJson(request);
  return postMessage(ctx, params.conv, body, { head: prefetch.length ? ctx.extra[0] : undefined, defer });
}));

router.put('/api/ws/:ws/conv/:conv/messages/:seq', route(async ({ params, request, user, defer }) => {
  // The message's block is keyed on the conversation and the number in the
  // path, so it comes up with the caller's own document rather than after
  // it.
  const seqNum = Number(params.seq);
  const locatable = looksLikeConvId(params.conv) && Number.isInteger(seqNum) && seqNum >= 1;
  const ctx = await requireMembership(params.ws, user, { write: true, also: locatable ? [KEYS.block(params.conv, blockIndexOf(seqNum))] : [] });
  const body = await readJson(request);
  const id = ctx.id;
  const conv = resolveConv(ctx, params.conv);
  // An archived channel is closed, not only to new posts: what was said
  // there stays as it was (a reply's thread counts as the channel's).
  if (conv.channel?.archived) fail(403, 'archived', 'This channel is archived');
  const seq = seqNum;
  const found = locatable ? messageIn(params.conv, seq, ctx.extra[0]) : await locateMessage(params.conv, seq);
  if (!found || found.overlay.d) fail(404, 'not_found', 'Message not found');
  if (found.raw.u !== id.uuid || found.raw.k === 'sys') fail(403, 'forbidden', 'You can only edit your own messages');
  // A reminder line is the worker's words in one's own space, drawn without
  // an edit (as without a reaction or a pin): edited by its address, the
  // change showed nowhere and moved the conversation's stamp for nothing.
  if (found.raw.k === 'rem') fail(403, 'forbidden', 'Reminders cannot be edited');
  const text = cleanText(body.text, LIMITS.messageText);
  if (!text) fail(400, 'invalid', 'A message cannot be empty; delete it instead');
  const ts = now();
  const k = overlayKey(seq);
  const oldText = typeof found.overlay.t === 'string' ? found.overlay.t : found.raw.t;
  // The preview is the first link's. A card built for a link the edit took
  // out or replaced goes with it (so does a removal: it was of that link's
  // card), and the client is told to ask for the new link's, if there is
  // one, the way it asks after a send. Only the words changing leaves the
  // card, and the fetch it cost, alone.
  const relink = firstUnfurlableLink(oldText) !== firstUnfurlableLink(text);
  // The edit's text sits beside the original on the block (see mergeBlock):
  // a block with no room for it refuses the edit with a word (see
  // assertBlockRoom), where the store refused it with none.
  assertBlockRoom(found.block, jsonBytes(text) + 40, 'This message cannot be edited any further here; post it again instead');
  await kv().update(found.key, { [`x.${k}.t`]: text, [`x.${k}.e`]: ts });
  // Whether or not a card stood when the message was read above: one for
  // the old link landing between that read and this write (its fetch, begun
  // when the message was posted, takes seconds) was left standing under a
  // message that no longer carried its link, and answered to every later
  // request for the card. A path removal of what is not there writes nothing.
  if (relink) await kv().remove(found.key, `x.${k}.uf`);
  // Both behind the answer, and the signal first: it is the last write
  // anyone reading this conversation could see, and the index, which nobody
  // reading it looks at, catches up after (as a post's does, see postMessage).
  defer(async () => {
    await touchConv(params.ws, params.conv, ts, { audience: audienceOf(conv), ws: ctx.ws, seq, patch: { t: text, e: ts, ...(relink ? { uf: null } : {}) } });
    await indexEdit(params.ws, params.conv, { s: seq, ts: found.raw.ts, a: found.raw.a }, oldText, text).catch(() => {});
  });
  return { ok: true, text, editedAt: ts, relink };
}));

router.delete('/api/ws/:ws/conv/:conv/messages/:seq', route(async ({ params, user, defer }) => {
  // The message's block, keyed on the conversation and the number in the
  // path, comes up with the caller's own document (see the edit route).
  const seq = Number(params.seq);
  const locatable = looksLikeConvId(params.conv) && Number.isInteger(seq) && seq >= 1;
  const ctx = await requireMembership(params.ws, user, { write: true, also: locatable ? [KEYS.block(params.conv, blockIndexOf(seq))] : [] });
  const id = ctx.id;
  const conv = resolveConv(ctx, params.conv);
  const found = locatable ? messageIn(params.conv, seq, ctx.extra[0]) : await locateMessage(params.conv, seq);
  if (!found || found.overlay.d) fail(404, 'not_found', 'Message not found');
  // A line the worker wrote names the person it is about, not an author
  // ("bob joined", "carol pinned a message"): it is nobody's own message, and
  // an admin's to take out if anyone's. Judged by the name on it, the person
  // a line was about could take the record of their own joining, leaving or
  // pinning out of the conversation, which the app never offers.
  if (found.raw.k === 'sys' && !isAdmin(ctx.member)) fail(403, 'forbidden', 'Only admins can remove a system line');
  if (found.raw.u !== id.uuid && !isAdmin(ctx.member)) fail(403, 'forbidden', 'You can only delete your own messages');
  const ts = now();
  // The flag is claimed with an atomic increment, as an ended huddle's line
  // is: two deletions of one message at once (the author from one tab and
  // an admin from another, a tap repeated over a slow network) both found
  // it standing, and both then let go of its attachments and counted it off
  // its root, so a file shared elsewhere too lost its bytes and a thread's
  // count fell by two. Only the one that took the flag from nothing does
  // what follows; every reader takes the flag by its truth alone.
  // A store that hands nothing back from the write (undefined or null, as a
  // missing key reads) gives no verdict, and the deletion goes on as it did
  // before the claim: only a count that reads past one says another got
  // there first. (The huddle start's claim reads its count the same way.)
  const claimed = await kv().incr(found.key, { [`x.${overlayKey(seq)}.d`]: 1 });
  const flag = claimed && typeof claimed === 'object' ? claimed.x?.[overlayKey(seq)]?.d : claimed;
  if (flag != null && flag !== 1) fail(404, 'not_found', 'Message not found');
  const audience = audienceOf(conv);
  await touchConv(params.ws, params.conv, ts, { audience, ws: ctx.ws, seq, patch: { d: 1 } });
  // A reply taken out comes off its root's count, which is what the channel
  // shows beside the root and the thread at its head: the count stood at the
  // replies ever made, so a thread with one reply left said two for good. A
  // line the worker wrote into the thread was never counted; a count already
  // at nothing (an archive's is its own) is left there. The root's
  // conversation is stamped so an open channel refetches the root.
  if (conv.kind === 'thread' && found.raw.k !== 'sys') {
    const root = await locateMessage(conv.parent.conv, conv.parent.seq);
    if (root && (Number(root.overlay.rc) || 0) > 0) {
      await kv().incr(root.key, { [`x.${overlayKey(conv.parent.seq)}.rc`]: -1 });
      // No patch: a count going down cannot be told from a stale one going up (see applyOverlayPatch).
      await touchConv(params.ws, conv.parent.conv, ts, { audience, ws: ctx.ws });
    }
  }
  if (found.overlay.p) await unpin(params.ws, params.conv, seq, null, audience, ctx.ws).catch(() => {});
  // A file a bookmark points at stays for the bookmark (see bookmarkedFiles),
  // and one a scheduled message waits with stays for it (see
  // queuedFilesReader): the queue is read once, and only for a file that
  // nothing posted holds any more.
  const keep = (found.raw.a || []).length ? bookmarkedFiles(ctx.ws) : null;
  const queued = (found.raw.a || []).length ? queuedFilesReader(params.ws) : null;
  // Letting go of the attachments is bookkeeping on the files' own records,
  // nowhere a reader of this conversation looks, so it runs behind the
  // answer: a message with five attachments made the person who deleted it
  // wait on five records being rewritten, and on the queue being read.
  if ((found.raw.a || []).length) {
    defer(() => Promise.all(found.raw.a.map((a) => releaseFile(params.ws, a.id, params.conv, keep, queued))));
  }
  return { ok: true };
}));

/**
 * Is a file shared somewhere the caller can read: carried there by a message
 * not deleted (the record counts the messages per conversation, up with each
 * post and down with each deletion), or bookmarked in a channel of theirs?
 * What a guest's, or an external member's, download and attaching are judged
 * by. A conversation whose count has run out is one the file has left: a
 * forward deleted used to leave its conversation on the record for good,
 * so a guest there kept a file nothing they could read carried any more.
 */
function sharedWithin(ctx, fileId, cs) {
  for (const [c, n] of Object.entries(cs || {})) {
    if (!(Number(n) > 0)) continue;
    try {
      resolveConv(ctx, c);
      return true;
    } catch {
      /* not theirs to read */
    }
  }
  return ctx.doc.channels.some((c) => (own(ctx.ws.channels, c)?.bookmarks || []).some((b) => b?.file === fileId));
}

/**
 * May this caller take a file of the workspace: download it, or attach it to
 * a message of theirs? A member may take any of them (a forward carries the
 * original's attachments by reference, and every member can download every
 * file anyway). A guest, or someone from a connected workspace, may take
 * their own uploads and what is shared where they can read: a file a message
 * carries in a conversation of theirs (the record counts them per
 * conversation), or one bookmarked in a channel of theirs (see sharedWithin).
 * A file shared nowhere they can read is not theirs, and nor is one shared
 * nowhere yet (uploaded and not yet attached, waiting with a scheduled
 * message, bookmarked in a channel they are not in): taken as open for want
 * of a sharing record, as it used to be, such a file was any guest's to
 * download or attach by its id. A record from before files were counted
 * (neither a count nor a sharing record on it) stays open, as it was:
 * nothing on it says whose it is not.
 */
function mayTakeFile(ctx, fileId, meta) {
  if (!isLimited(ctx.member) || meta.u === ctx.uuid) return true;
  if (meta.refs === undefined && meta.cs === undefined) return true;
  return sharedWithin(ctx, fileId, meta.cs);
}

/**
 * Count one message's hold on each of its files: a reference, and a sharing
 * in the conversation (what a guest's download is judged by). A dozen at a
 * time, as every other fan-out here (an import's page names up to 2,500),
 * and a write that failed is tried once more rather than let go: a hold not
 * counted is a file deleted from under the messages still carrying it.
 */
async function holdFiles(conv, ids) {
  const hold = async (id) => {
    const by = { refs: 1, [`cs.${conv}`]: 1 };
    try {
      await kv().incr(KEYS.file(id), by);
    } catch {
      await kv().incr(KEYS.file(id), by).catch(() => {});
    }
  };
  for (let i = 0; i < ids.length; i += 12) await Promise.all(ids.slice(i, i + 12).map(hold));
}

/**
 * The files the workspace's channel bookmarks point at, less the bookmarks
 * of `except` (a channel whose list is being rewritten, or which is going).
 * A bookmark holds a file the way a message does (see releaseFile): the
 * bookmark is made from a message's menu, and the message deleted later
 * used to take the bytes with it, leaving the bookmark to open onto "Could
 * not download the file" for good.
 */
function bookmarkedFiles(ws, except = null) {
  const out = new Set();
  for (const [cid, c] of Object.entries(ws?.channels || {})) {
    if (cid === except) continue;
    for (const b of Array.isArray(c?.bookmarks) ? c.bookmarks : []) if (typeof b?.file === 'string') out.add(b.file);
  }
  return out;
}

/**
 * Let go of files whose bookmarks came down (`ids`), where nothing else
 * holds them: not a message (the record's count), and not a bookmark still
 * standing elsewhere (`keep`, see bookmarkedFiles). The bytes of a file a
 * bookmark alone kept would otherwise sit in the owner's drive for good.
 */
/**
 * The files the messages waiting in the workspace's queue are to carry (see
 * releaseScheduledFiles, which lets go of those): read once, the first time
 * asked, and only then, since every caller asks only where a file nothing
 * else holds is about to go. A file a waiting message names stays for it,
 * whatever else let go of it, as a bookmarked one stays for its bookmark.
 */
function queuedFilesReader(wsId) {
  let pending = null;
  return () => {
    if (!pending) {
      pending = kv().get(KEYS.sched(wsId)).catch(() => null)
        .then((queue) => new Set(Object.values(queue?.m || {}).flatMap((e) => (Array.isArray(e?.attachments) ? e.attachments : []).map((a) => a?.id).filter((id) => typeof id === 'string'))));
    }
    return pending;
  };
}

async function releaseBookmarkFiles(wsId, ids, keep) {
  const gone = [...new Set(ids)].filter((id) => typeof id === 'string' && !keep.has(id));
  if (!gone.length) return;
  const metas = await getMany(gone.map((id) => KEYS.file(id)));
  // Nor a file a message still waiting in the queue is to carry (see
  // releaseScheduledFiles, which lets go of those, and holds the bookmark's
  // side of this the same way): the queue is read once, on this rare path,
  // and only where a file is about to go. Judged by the messages' count
  // alone, as it used to be, a file bookmarked while it waited with a
  // scheduled message went with the bookmark when that came down, and the
  // message went out at its time without the file, or, with no words beside
  // it, was marked "Not sent".
  const queued = queuedFilesReader(wsId);
  for (let i = 0; i < gone.length; i++) {
    const meta = metas[i];
    if (!meta || meta.ws !== wsId || Number(meta.refs) > 0) continue;
    if ((await queued()).has(gone[i])) continue;
    await fs().delete(`teamchat-files/${wsId}/${gone[i]}`).catch(() => {});
    await kv().del(KEYS.file(gone[i])).catch(() => {});
  }
}

/**
 * A deleted message lets go of its attachments. A file forwarded into other
 * messages is still referenced there, so its bytes stay until the last
 * message holding it is deleted; files from before references were counted
 * go at once, as they always did. One a bookmark still points at (`keep`,
 * see bookmarkedFiles) stays, whatever its count, until the bookmark comes
 * down; so does one a message still waiting in the queue is to carry
 * (`queued`, see queuedFilesReader), until that message goes out or is
 * dropped, when the queue's side lets go of it (see releaseScheduledFiles).
 */
async function releaseFile(wsId, fileId, conv = null, keep = null, queued = null) {
  let refs = 0;
  // The sharing in the conversation goes with the hold (see sharedWithin):
  // a forward deleted used to leave its conversation on the record for
  // good, so a guest there kept a file nothing they could read carried.
  const by = (n) => ({ refs: n, ...(conv ? { [`cs.${conv}`]: n } : {}) });
  try {
    const res = await kv().incr(KEYS.file(fileId), by(-1));
    // Another workspace's record (a message here named its file before that
    // was refused): not this workspace's to count down or delete.
    if (res && typeof res === 'object' && res.ws && res.ws !== wsId) {
      await kv().incr(KEYS.file(fileId), by(1)).catch(() => {});
      return;
    }
    refs = Number(res && typeof res === 'object' ? res.refs : res) || 0;
  } catch {
    refs = 0;
  }
  if (refs > 0) return;
  if (keep?.has(fileId)) {
    // Kept for a bookmark the caller read a moment ago: the bookmark may
    // have come down since (its removal, reading the file still held by
    // this very message, left the bytes to this deletion; see
    // releaseBookmarkFiles), so the workspace is read again, once, on this
    // rare path, and the file stays only while a bookmark still names it.
    const fresh = await kv().get(KEYS.ws(wsId)).catch(() => null);
    if (!fresh || bookmarkedFiles(fresh).has(fileId)) return;
  }
  // A message waiting in the queue to carry the file (the same file named
  // by a posted message and by a scheduled one) keeps it: judged by the
  // posted messages' count alone, as it used to be, the last posted message
  // deleted took the bytes with it, and the scheduled one went out at its
  // time without its file, or, with no words beside it, was marked "Not
  // sent". The queue's own side has always judged the other way round (see
  // releaseScheduledFiles). One read of the queue, and only here.
  if (queued && (await queued()).has(fileId)) return;
  await fs().delete(`teamchat-files/${wsId}/${fileId}`).catch(() => {});
  await kv().del(KEYS.file(fileId)).catch(() => {});
}

router.post('/api/ws/:ws/conv/:conv/messages/:seq/reactions', route(async ({ params, request, user, defer }) => {
  // The reaction's own message block is keyed on the conversation and the
  // number in the path, so it comes up with the caller's document, and the
  // (see the edit route).
  const seqNum = Number(params.seq);
  const locatable = looksLikeConvId(params.conv) && Number.isInteger(seqNum) && seqNum >= 1;
  const ctx = await requireMembership(params.ws, user, { write: true, also: locatable ? [KEYS.block(params.conv, blockIndexOf(seqNum))] : [] });
  const body = await readJson(request);
  const id = ctx.id;
  const conv = resolveConv(ctx, params.conv);
  // Previewing a public channel shows its messages; reacting to them, like
  // posting and pinning, is for people who have joined, and an archived
  // channel takes no reactions any more than it takes posts.
  if (!conv.joined) fail(403, 'not_joined', 'Join the channel to react');
  if (conv.channel?.archived) fail(403, 'archived', 'This channel is archived');
  const seq = seqNum;
  if (!isReactionKey(body.reaction)) fail(400, 'invalid', 'Unknown reaction');
  const found = locatable ? messageIn(params.conv, seq, ctx.extra[0]) : await locateMessage(params.conv, seq);
  if (!found || found.overlay.d) fail(404, 'not_found', 'Message not found');
  // A line the worker wrote (someone joined or left, a pin, a huddle) takes
  // no reaction, as it takes no pin and has no thread: the app draws none on
  // such a line and offers none, so one put there by its address was a write
  // nobody could see, and each moved the conversation's stamp, which had
  // every open tab here re-read its window for a change that showed nothing.
  // A reminder line in one's own space is drawn the same way, without them.
  if (found.raw.k === 'sys') fail(400, 'invalid', 'System lines take no reactions');
  if (found.raw.k === 'rem') fail(400, 'invalid', 'Reminders take no reactions');
  const path = `x.${overlayKey(seq)}.r.${body.reaction}.${id.uuid}`;
  const current = found.overlay.r || {};
  const has = !!current[body.reaction]?.[id.uuid];
  const on = typeof body.on === 'boolean' ? body.on : !has;
  // A new kind of reaction on a message that already carries the maximum
  // is refused; joining an existing one is always fine. One nobody is under
  // any more (see the removal below) is a new kind again.
  const under = (users) => (users ? Object.keys(users).length : 0);
  const distinct = Object.values(current).filter(under).length;
  if (on && !has && !under(current[body.reaction]) && distinct >= REACTIONS_PER_MESSAGE) {
    fail(400, 'limit', `A message can carry up to ${REACTIONS_PER_MESSAGE} different reactions`);
  }
  if (on && !has && Object.values(current).reduce((sum, users) => sum + Object.keys(users || {}).length, 0) >= REACTORS_PER_MESSAGE) {
    fail(400, 'limit', 'This message has as many reactions as it can carry');
  }
  // Nor one whose block has no room left for another (see assertBlockRoom).
  if (on && !has) assertBlockRoom(found.block, 120, 'This message cannot take more reactions');
  // A reaction nobody is under any more stays on the record as an empty
  // entry (see the removal below): once a message has carried as many kinds
  // as it may show, its empty ones are taken off as another goes on, so the
  // record does not grow by every kind ever put on it and taken back.
  if (on && !has && Object.keys(current).length >= REACTIONS_PER_MESSAGE) {
    const dead = Object.keys(current).filter((k) => k !== body.reaction && !under(current[k]));
    if (dead.length) await kv().remove(found.key, ...dead.map((k) => `x.${overlayKey(seq)}.r.${k}`)).catch(() => {});
  }
  if (on && !has) {
    // The author hears of it only while they can still read the conversation
    // (mentions and replies take the same rule): an inbox entry for a private
    // channel they have left would badge Activity over a list that hides it.
    const tell = found.raw.u && found.raw.u !== id.uuid && found.raw.k !== 'sys' && (await readersAmong(ctx, conv, [found.raw.u])).length > 0;
    if (tell) {
      // The author hears about reactions to their message, in their inbox
      // only, and from each person a few times per message at most: the
      // count rides on the overlay in the same write as the reaction, so
      // taking one off and putting it back cannot fill an inbox.
      const res = await kv().incr(found.key, { [path]: 1, [`x.${overlayKey(seq)}.rn.${id.uuid}`]: 1 });
      const o = res && typeof res === 'object' ? res.x?.[overlayKey(seq)] : null;
      // The same person's two taps in the same instant (two tabs, two
      // devices) each read the reaction absent and each counted one on: the
      // message then carried a count of two under one name, and its author
      // heard of the one reaction twice. The second to land finds the two,
      // sets the count back to the one a person is, and gives back the
      // notice its count took, since the author was told already.
      const mine = o ? Number(o.r?.[body.reaction]?.[id.uuid]) : 1;
      if (mine > 1) {
        await kv().update(found.key, { [path]: 1 }).catch(() => {});
        await kv().incr(found.key, { [`x.${overlayKey(seq)}.rn.${id.uuid}`]: -1 }).catch(() => {});
      } else {
        const notices = o ? Number(o.rn?.[id.uuid]) || 1 : 1;
        // Telling the author is for the author, not for whoever tapped: it
        // runs behind the answer, where it used to be three round trips in
        // front of it (the ring, the count, the poke).
        if (notices <= REACTION_NOTICES) {
          defer(async () => {
            await pushInbox(params.ws, [found.raw.u], { k: 'reaction', c: params.conv, s: seq, by: id.uuid, ts: now(), r: body.reaction });
            await pokeMember(params.ws, found.raw.u).catch(() => {});
          });
        }
      }
    } else {
      await kv().update(found.key, { [path]: 1 });
    }
  } else if (!on && has) {
    // One's own name alone comes off, whoever else is under the reaction:
    // every reader passes over a reaction nobody is under (the row, the
    // picker, Activity, the export's page). The last person taking a
    // reaction back used to remove its whole entry, judged by the block as
    // read a moment before, and someone else's same reaction that landed in
    // between went with it: they were answered that it was on, their tab
    // drew it, and the next re-read of the window took it away.
    await kv().remove(found.key, path);
  } else {
    // The message already carries what was asked for (a tap repeated, or
    // a tab whose view of the reaction was behind): nothing is written, and
    // the conversation's stamp is left where it was, since moving it would
    // have every open tab of every member here re-read its window for a
    // change that never happened.
    return { ok: true, on };
  }
  await touchConv(params.ws, params.conv, now(), { audience: audienceOf(conv), defer, ws: ctx.ws, seq, patch: { r: body.reaction, ru: id.uuid, on: on ? 1 : 0 } });
  return { ok: true, on };
}));

router.post('/api/ws/:ws/conv/:conv/read', route(async ({ params, request, user, defer }) => {
  // The conversation's counter, which a read that clears a badge has to
  // compare against, is keyed on the conversation alone: it comes up with
  // the caller's own document.
  const prefetch = looksLikeConvId(params.conv) ? [KEYS.seq(params.conv)] : [];
  const ctx = await requireMembership(params.ws, user, { also: prefetch });
  const body = await readJson(request);
  const id = ctx.id;
  resolveConv(ctx, params.conv);
  // A cursor moves during a move's freeze (see assertWritable's callers and
  // the routes without `write`: the member goes on reading while the copy is
  // exported), but not in a copy that has moved (see assertNotMoved); the
  // app lets a read so refused go, and reads afresh in the copy it moves to.
  assertNotMoved(ctx.ws);
  const seq = Math.max(0, Math.floor(Number(body.seq) || 0));
  const prev = ctx.doc.reads[params.conv] || 0;
  const patch = {};
  // Cursors only move forward, except when asked to mark something unread:
  // then it sits just before that message and the client's "New" divider
  // and bolding do the rest.
  if (body.back) patch[`reads.${params.conv}`] = seq;
  else if (seq > prev) patch[`reads.${params.conv}`] = seq;
  if (!body.back && (ctx.doc.mentions[params.conv] || ctx.doc.threads[params.conv])) {
    // The badges clear when the conversation is read to its end: a read
    // from the middle of its history (the end of a permalink's window) has
    // not shown what they count.
    const latest = prefetch.length ? Number(ctx.extra[0]) || 0 : Number(await kv().get(KEYS.seq(params.conv))) || 0;
    let atEnd = seq >= latest;
    // The counter may stand past the newest message: a block closed early
    // leaves its last numbers unused (see rollBlock), and the newest
    // messages may have been deleted. Read to the last message that stands
    // is read to the end; judged by the counter alone, the badge for a
    // mention in that message stood, on every device, until the next
    // message came, while the reader's own app, judging by the newest
    // message, cleared it and asked again at every refresh.
    // The read's block, and the counter's where that is the next one: the
    // newest message may be the first of a new block and deleted since (one
    // in fifty of the newest messages is), and read within its own block
    // alone, as it used to be, a read to the last message standing then
    // cleared nothing, and the badge stood on every device until someone
    // posted again. Further behind than a block is not a read to the end.
    const from = blockIndexOf(seq);
    const to = blockIndexOf(latest);
    if (!atEnd && seq > 0 && to - from <= 1) {
      const blocks = await Promise.all(Array.from({ length: to - from + 1 }, (_, i) => kv().get(KEYS.block(params.conv, from + i)).catch(() => null)));
      if (!blocks.some((b) => mergeBlock(b).some((m) => m.seq > seq))) {
        // Every number past the read is accounted for: a record in its
        // block (a deleted message keeps its record; mergeBlock drops it),
        // or its block closed early (`full`, see rollBlock), whose numbers
        // left over stand for nothing. A number with neither is a message
        // on its way: its number taken and its counters moved, a mention of
        // this reader among them, and not yet appended (see writeMessage).
        // Taken for read to the end, the read landed over that count, and
        // the badge for the mention never showed on any device while the
        // message stood unread.
        const held = new Set(blocks.flatMap((b) => (Array.isArray(b?.m) ? b.m : []).map((m) => m?.s)));
        let accounted = true;
        for (let s = seq + 1; s <= latest && accounted; s++) if (!held.has(s) && !blocks[blockIndexOf(s) - from]?.full) accounted = false;
        atEnd = accounted;
      }
    }
    if (atEnd) {
      if (ctx.doc.mentions[params.conv]) patch[`mentions.${params.conv}`] = 0;
      if (ctx.doc.threads[params.conv]) patch[`threads.${params.conv}`] = 0;
    }
  }
  if (Object.keys(patch).length) await kv().update(KEYS.member(params.ws, id.uuid), patch);
  // A badge cleared here is cleared on the member's other tabs and devices
  // too: their document is theirs to refetch, and the poll refetches it when
  // its stamp moves. Only a badge, not every cursor move: the cursor advances
  // with every message read in an open conversation, and a poke per message
  // would have every other tab fetch the workspace over and over. A cursor
  // moved back is the other exception: "Mark unread from here" is one
  // deliberate act, and the conversation it bolds again stayed read on the
  // member's other devices, with no "New" line, until something else had
  // them fetch their document.
  if (body.back || patch[`mentions.${params.conv}`] === 0 || patch[`threads.${params.conv}`] === 0) {
    // For their other tabs, not for this one: it goes behind the answer.
    defer(() => pokeMember(params.ws, id.uuid).catch(() => {}));
  }
  return { ok: true, seq: body.back ? seq : Math.max(seq, prev) };
}));

/* ---- inbox, threads, saved --------------------------------------------- */

/** The blocks a list of (conv, seq) entries would be read from, in list order, held to `maxBlocks`. */
function blockKeysOf(entries, maxBlocks) {
  const keys = [];
  for (const e of entries) {
    const k = KEYS.block(e.c, blockIndexOf(e.s));
    if (!keys.includes(k) && keys.length < maxBlocks) keys.push(k);
  }
  return keys;
}

/** Attach messages to entries that name (conv, seq), reading a bounded number of blocks, newest first. */
async function attachMessages(entries, maxBlocks = 12) {
  const keys = blockKeysOf(entries, maxBlocks);
  const blocks = await getMany(keys);
  const bySeq = new Map();
  blocks.forEach((b, i) => { for (const m of mergeBlock(b)) bySeq.set(`${keys[i]}#${m.seq}`, m); });
  return entries.map((e) => ({ ...e, message: bySeq.get(`${KEYS.block(e.c, blockIndexOf(e.s))}#${e.s}`) || null }));
}

/**
 * Append to a list document that may not exist yet (a member's first save,
 * a conversation's first pin). kv.add is the atomic append; a store that
 * refuses add on a missing key (see appendToBlock) has the list written
 * whole with its first entries, as a member's document is on their first
 * channel. A document that is there means the refusal was something else.
 * Returns what the store handed back from the append (the document, on a
 * store that answers with it), or null.
 *
 * Two first appends in the same instant (a member's first two saves, from
 * two tabs; a conversation's first two pins) each found no list and each
 * wrote one whole, and the slower write took the faster one's entries with
 * it: the message was answered as saved, or pinned, and stood on no list.
 * So the list is read back once the whole write has landed, and an entry of
 * ours it does not hold is appended to the list that stands, which is there
 * to be appended to now.
 */
async function appendItems(key, items) {
  try {
    return await kv().add(key, { items });
  } catch (e) {
    if (await kv().get(key)) throw e;
    await kv().set(key, { items });
    const after = await kv().get(key).catch(() => null);
    const list = Array.isArray(after?.items) ? after.items : null;
    if (!list) return null;
    const same = (a, b) => !!a && !!b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
    const lost = items.filter((x) => !list.some((y) => same(x, y)));
    if (!lost.length) return after;
    return await kv().add(key, { items: lost }).catch(() => null);
  }
}

/**
 * A conversation that is gone for good, as against one the caller cannot
 * read right now: a channel no longer on the workspace (or a thread of one),
 * or a direct message the caller's document does not hold (their saved list
 * dies with their membership, so one they once saved into and no longer hold
 * is not coming back). A channel they have merely left still exists and may
 * take them back, and what they kept of it with them.
 */
function isGone(ctx, conv) {
  const id = String(conv || '');
  const thread = parentOfThread(id);
  const base = thread ? thread.conv : id;
  return !own(ctx.ws.channels, base) && !own(ctx.doc.dms, base);
}

/**
 * Read cursors kept for threads no longer on the member's Threads list. A
 * cursor is written for every thread a member ever opens, and nothing took
 * one out again: a member reading thirty threads a day added a couple of
 * hundred kilobytes a year to a document that every request of theirs reads
 * and that the store refuses past a ceiling (see MEMBER_DOC_BYTES), after
 * which nothing of theirs could be written. The listed threads keep theirs
 * (a row opens onto them); of the rest, this many stay, the ones first
 * opened longest ago going first (a document keeps its keys in the order
 * they were first written). What is lost with a cursor is only where the
 * "New" line would sit on reopening a thread not opened in a long while.
 */
const THREAD_CURSORS_MAX = 1000;
/** Keys pruned per visit, so one visit after years of growth stays short; the next takes more. */
const MEMBER_PRUNE_MAX = 300;

/**
 * Paths of a member's document that hold nothing any more, pruned where the
 * Threads list is drawn (the one place the document's thread record is read
 * whole): every cursor, mention count, notification setting and reply count
 * kept for a conversation gone for good (a channel deleted, or a thread of
 * one), which nothing would read again; and the oldest thread cursors past
 * THREAD_CURSORS_MAX. Nothing a badge or a follow depends on goes: a reply
 * count for a live thread, a mention count for a channel still here (one
 * merely left keeps its count, and entering clears it), a follow flag (the
 * app's Follow button falls back to the root's record only when the flag is
 * absent, so an unlisted thread's flag stays as it was).
 */
function staleMemberPaths(ctx, listed) {
  const { doc } = ctx;
  const paths = [];
  for (const map of ['reads', 'mentions', 'notify', 'threads']) {
    for (const conv of Object.keys(doc[map] || {})) if (isGone(ctx, conv)) paths.push(`${map}.${conv}`);
  }
  const cursors = Object.keys(doc.reads || {}).filter((c) => parentOfThread(c) && !listed.has(c) && !isGone(ctx, c));
  for (const c of cursors.slice(0, Math.max(0, cursors.length - THREAD_CURSORS_MAX))) paths.push(`reads.${c}`);
  // The follow flag of a thread not on the list, where the flag is all the
  // entry holds: following or unfollowing by the button left one for every
  // thread ever, and nothing took it off. The root's own record says the
  // same (the notify route and a reply write both), and the app reads the
  // root where the flag is absent (see followsThread); a listed thread's
  // flag hides an unfollowed thread from the list and stays, as does a
  // level or a mute set on a thread itself.
  for (const [c, v] of Object.entries(doc.notify || {})) {
    if (!parentOfThread(c) || listed.has(c) || isGone(ctx, c)) continue;
    if (v && typeof v === 'object' && Object.keys(v).every((k) => k === 'follow')) paths.push(`notify.${c}`);
  }
  return paths.slice(0, MEMBER_PRUNE_MAX);
}

/** Drop entries in conversations the caller can no longer read. */
function readable(ctx, entries) {
  return entries.filter((e) => {
    try {
      resolveConv(ctx, e.c);
      return true;
    } catch {
      return false;
    }
  });
}

router.get('/api/ws/:ws/inbox', route(async ({ params, request, user }) => {
  // The ring is keyed on the caller, so it comes up with their own document.
  const ctx = await requireMembership(params.ws, user, { also: ({ uuid }) => [KEYS.inbox(params.ws, uuid)] });
  const id = ctx.id;
  const q = query(request);
  const kind = q.get('kind');
  const doc = ctx.extra[0] || { items: [] };
  let items = [...(doc.items || [])].reverse();
  if (kind && kind !== 'all') items = items.filter((e) => e.k === kind);
  // One entry per person per reaction per message, the newest: each time a
  // reaction goes on the author is told (a few times per person, see the
  // reaction route), and one taken back and put on again stood down the
  // list once for every time, each row opening onto the one message. Folded
  // before the cut below, so the rows shown are as many distinct notices.
  const told = new Set();
  items = items.filter((e) => {
    if (e.k !== 'reaction') return true;
    const key = `${e.c}#${e.s}#${e.by}#${e.r}`;
    if (told.has(key)) return false;
    told.add(key);
    return true;
  });
  items = readable(ctx, items).slice(0, 60);
  const withMessages = await attachMessages(items);
  // An entry about a message that is gone (deleted since, a root whose
  // thread keeps a tombstone included) is not shown: it opened onto nothing.
  // The ring itself is left as it is (entries are appended to it atomically,
  // never rewritten in place); only where the block was actually read, as
  // the saved list has it, since one past the blocks an answer reads is
  // merely not shown yet.
  // Not while the workspace is still being imported: a message not there
  // yet is on its way, not gone.
  const read = new Set(ctx.ws.importing ? [] : blockKeysOf(items, 12));
  // Nor is a reaction that has since been taken back: the entry says someone
  // reacted to your message, and the message, read here for the entry, no
  // longer carries their reaction (a misclick undone a moment later stood in
  // Activity for good). One still on the message is shown as before; so is
  // an entry from before the reaction it names was kept on it.
  const gone = (e) => read.has(KEYS.block(e.c, blockIndexOf(e.s))) && (!e.message || e.message.deleted || (e.k === 'reaction' && e.r && !e.message.reactions?.[e.r]?.[e.by]));
  return { items: withMessages.filter((e) => !gone(e)), unread: ctx.doc.inbox || 0 };
}));

router.post('/api/ws/:ws/inbox/read', route(async ({ params, user }) => {
  const ctx = await requireMembership(params.ws, user);
  const id = ctx.id;
  assertNotMoved(ctx.ws);
  if (ctx.doc.inbox) {
    await kv().update(KEYS.member(params.ws, id.uuid), { inbox: 0 });
    // The Activity badge cleared here clears on the member's other tabs and
    // devices too, as a badge cleared by the read route does: they draw it
    // from the document they hold, refetched when their stamp moves.
    await pokeMember(params.ws, id.uuid).catch(() => {});
  }
  return { ok: true };
}));

/**
 * Threads the caller is in, newest activity first, with the root message
 * and the unread reply count. The list is pruned to its cap here, the one
 * place it is read whole.
 */
router.get('/api/ws/:ws/threads', route(async ({ params, user }) => {
  const ctx = await requireMembership(params.ws, user, { also: ({ uuid }) => [KEYS.threads(params.ws, uuid)] });
  const id = ctx.id;
  const doc = ctx.extra[0] || { t: {} };
  let entries = Object.entries(doc.t || {}).map(([tid, v]) => ({ id: tid, c: v.c, s: v.s, at: v.at || 0 })).sort((a, b) => b.at - a.at);
  // The list, and the member's counters below, are tidied only where the
  // copy takes writes that count (as the pins and saved lists are, see GET
  // /pins): not one that has moved to another server, nor one being moved.
  // The answer is drawn as if tidied all the same. (An import in progress
  // holds only the letting go of roots not found, below: they are on their way.)
  const noWrites = ctx.ws.movedTo || frozen(ctx.ws);
  let pruned = [];
  if (entries.length > LIMITS.threadsFollowed) {
    pruned = entries.slice(LIMITS.threadsFollowed);
    entries = entries.slice(0, LIMITS.threadsFollowed);
    if (!noWrites) await kv().set(KEYS.threads(params.ws, id.uuid), { t: Object.fromEntries(entries.map((e) => [e.id, { c: e.c, s: e.s, at: e.at }])) }).catch(() => {});
  }
  const canRead = readable(ctx, entries);
  // An unread count for a thread this member can no longer read (a private
  // channel left with a reply still unread, or a counter from before replies
  // were counted only for readers) would badge Threads for good: the read
  // and unfollow routes that clear counters refuse a conversation they cannot
  // resolve. Zero them here, where the list is drawn without them; and the
  // counters of the threads just pruned off the list with them, since the
  // badge sums every counter and a pruned thread has no row left to clear from.
  // The counters come off the document rather than being set to nothing: a
  // counter set to nothing stayed as a key, one per thread ever followed and
  // let go of, so the document grew for good with every thread a member had
  // ever been in, toward the ceiling past which nothing of theirs (a read
  // cursor, a badge, a push subscription) could be written. So do the
  // counters at nothing for threads no longer on the list at all (let go of
  // by an earlier read of it, and left standing); one that counts something
  // for a thread not listed is a reply that landed before its entry, and stays.
  const drop = new Set([...entries.filter((e) => !canRead.includes(e)), ...pruned].filter((e) => Object.hasOwn(ctx.doc.threads, e.id)).map((e) => e.id));
  const listed = new Set(entries.map((e) => e.id));
  for (const [tid, n] of Object.entries(ctx.doc.threads)) if (!listed.has(tid) && !(Number(n) > 0)) drop.add(tid);
  // The document's other maps are pruned here as well (see staleMemberPaths).
  const stale = staleMemberPaths(ctx, listed);
  entries = canRead.filter((e) => ctx.doc.notify[e.id]?.follow !== false).slice(0, 60);
  // Every root on the page: the card is drawn around it and says "Loading
  // message" until it has one, and the thread's own conversation, which is
  // all the card loads, never brings it. Held to a dozen blocks, the page
  // left the roots of the threads past a dozen channels out for good; the
  // page itself bounds the reads, a block at most per thread.
  const withRoot = await attachMessages(entries.map((e) => ({ ...e, c: e.c, s: e.s })), entries.length);
  // A thread whose root is gone for good (deleted, and its tombstone gone
  // with the last of its replies; or a number nothing was ever posted under)
  // has nothing to draw its card around: the card said "Loading message"
  // for good, a reply into it was refused, and it could not be unfollowed,
  // since the follow flag lives on the root. It comes off the list here, as
  // a saved message that is gone comes off the saved list, and its unread
  // count with it. Every entry's block is read above, so a root not found is
  // gone, not merely past the blocks read. A root deleted while replies
  // stand keeps its tombstone and its thread. Not while the workspace is
  // still being imported: a root not there yet is on its way, not gone.
  const gone = new Set(ctx.ws.importing || noWrites ? [] : withRoot.filter((e) => !e.message).map((e) => e.id));
  if (gone.size) await kv().remove(KEYS.threads(params.ws, id.uuid), ...[...gone].map((tid) => `t.${tid}`)).catch(() => {});
  for (const tid of gone) if (Object.hasOwn(ctx.doc.threads, tid)) drop.add(tid);
  if (!noWrites && (drop.size || stale.length)) {
    const paths = [...new Set([...[...drop].map((tid) => `threads.${tid}`), ...stale])];
    for (let i = 0; i < paths.length; i += 100) await kv().remove(KEYS.member(params.ws, id.uuid), ...paths.slice(i, i + 100)).catch(() => {});
    // The badge is the sum of these: other tabs are told only when a count
    // that stood for something went, not for housekeeping alone.
    const counted = (p) => p.startsWith('threads.') && Number(ctx.doc.threads[p.slice('threads.'.length)]) > 0;
    if (paths.some(counted)) await pokeMember(params.ws, id.uuid).catch(() => {});
  }
  return { threads: withRoot.filter((e) => !gone.has(e.id)).map((e) => ({ id: e.id, conv: e.c, seq: e.s, at: e.at, unread: ctx.doc.threads[e.id] || 0, root: e.message })) };
}));

router.get('/api/ws/:ws/saved', route(async ({ params, user }) => {
  const ctx = await requireMembership(params.ws, user, { also: ({ uuid }) => [KEYS.saved(params.ws, uuid)] });
  const id = ctx.id;
  const key = KEYS.saved(params.ws, id.uuid);
  const doc = ctx.extra[0] || { items: [] };
  // What was saved in a conversation that is gone for good (a deleted
  // channel, a thread of one) goes off the list here, the one place it is
  // read whole: hidden only, as an entry the member merely cannot read
  // now is, it counted toward their two hundred without a row to remove it
  // by, and the list filled with what nothing could clear.
  const all = doc.items || [];
  let kept = all.filter((e) => !isGone(ctx, e.c));
  // One entry per message. The save route appends to the list without
  // reading it back, so two saves of one message at once could both land
  // (the second is taken off again there, on a store that hands the list
  // back); a copy that got in all the same is folded here, the one place
  // the list is read whole, so the Later view never shows a message twice
  // and one removal takes it off.
  const seen = new Set();
  kept = kept.filter((e) => {
    const k = `${e.c}#${e.s}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const items = readable(ctx, [...kept].reverse());
  const withMessages = await attachMessages(items);
  // So does a saved message that is itself gone: deleted since (a root
  // whose thread keeps a tombstone included), or a number nothing was ever
  // posted under. It stood on the list as "Open to read" with nothing to
  // open, for good, toward the cap. Only where its block was read: a message
  // past the blocks one answer reads is merely not shown yet.
  const read = new Set(blockKeysOf(items, 12));
  const gone = new Set(withMessages.filter((e) => read.has(KEYS.block(e.c, blockIndexOf(e.s))) && (!e.message || e.message.deleted)).map((e) => `${e.c}#${e.s}`));
  if (gone.size) kept = kept.filter((e) => !gone.has(`${e.c}#${e.s}`));
  // Tidied only where the copy takes writes that count (as the pins list is,
  // see GET /pins): not one that has moved to another server, nor one being
  // moved, whose list is shown as if tidied and tidied once the workspace is
  // open to writes again. Written into a copy that had moved, the tidying
  // went into what nothing reads again.
  const noWrites = ctx.ws.movedTo || frozen(ctx.ws);
  if (!noWrites && kept.length !== all.length) await kv().set(key, { items: kept }).catch(() => {});
  return { items: withMessages.filter((e) => !gone.has(`${e.c}#${e.s}`)) };
}));

/** Save a message for later, mark it done or not, or remove it. */
router.post('/api/ws/:ws/saved', route(async ({ params, request, user }) => {
  const ctx = await requireMembership(params.ws, user);
  const id = ctx.id;
  const body = await readJson(request);
  const conv = String(body.conv || '');
  const seq = Math.floor(Number(body.seq));
  if (!/^[a-z0-9_]{1,64}$/.test(conv) || !Number.isInteger(seq) || seq < 1) fail(400, 'invalid', 'Bad message reference');
  // The list is the member's own and is written during a move's freeze, but
  // not into a copy that has moved (see assertNotMoved).
  assertNotMoved(ctx.ws);
  const key = KEYS.saved(params.ws, id.uuid);
  const doc = (await kv().get(key)) || { items: [] };
  const items = doc.items || [];
  const i = items.findIndex((x) => x.c === conv && x.s === seq);
  // Taking an entry off one's own list needs no conversation to resolve:
  // one saved in a channel since deleted or left could not be removed at
  // all, and sat on the list toward its cap.
  if (body.remove) {
    if (i > -1) await kv().set(key, { items: items.filter((_, j) => j !== i) });
    return { ok: true, saved: false };
  }
  resolveConv(ctx, conv);
  if (typeof body.done === 'boolean') {
    if (i === -1) fail(404, 'not_found', 'Not saved');
    items[i] = { ...items[i], done: body.done };
    await kv().set(key, { items });
    return { ok: true, saved: true, done: body.done };
  }
  if (i > -1) return { ok: true, saved: true, already: true };
  if (items.length >= LIMITS.savedItems) fail(400, 'limit', `You can keep up to ${LIMITS.savedItems} saved messages. Clear some first`);
  // A message that stands, as a pin or a reminder needs: a number nobody
  // posted, or a deleted message, would sit on the list as "Open to read"
  // with nothing behind it, toward the cap.
  const found = await locateMessage(conv, seq);
  if (!found || found.overlay.d) fail(404, 'not_found', 'Message not found');
  const entry = { c: conv, s: seq, ts: now(), done: false };
  const after = await appendItems(key, [entry]);
  // The append is the claim, as a channel join's is (see enterChannel): two
  // saves of one message at once (two tabs, a tap repeated over a slow
  // network) each read the list above without the message and each put it
  // on, so the Later view showed it twice, "Remove" took one off and left
  // the other, and the second tab's count of saved messages ran one ahead
  // of the list. A second copy in what the store hands back says this
  // request landed second: its copy (the last) comes off again, and the
  // message is answered as saved already, the way a repeated tap is.
  const list = Array.isArray(after?.items) ? after.items : null;
  const mine = (x) => x && x.c === conv && x.s === seq;
  if (list && list.filter(mine).length > 1) {
    const last = list.map((x, j) => (mine(x) ? j : -1)).filter((j) => j >= 0).pop();
    await kv().set(key, { items: list.filter((_, j) => j !== last) }).catch(() => {});
    return { ok: true, saved: true, already: true };
  }
  // Read back once, as a pin is (see POST /pins): taking another saved
  // message off the list, or marking one done, rewrites the list whole
  // (above) from a read made before this append, and landing in the same
  // instant (another tab, another device) took this entry off with it; the
  // message was answered as saved and never stood on the Later list. Put
  // back, it stands as answered.
  const seen = (await kv().get(key).catch(() => null))?.items;
  if (Array.isArray(seen) && !seen.some(mine)) await appendItems(key, [entry]);
  return { ok: true, saved: true };
}));

/**
 * How a member wants to hear about a conversation: level (all, mentions,
 * nothing), mute, and for a thread whether they follow it. Lives in the
 * member document, which every request already reads, as one path write.
 * Following is also recorded on the thread root's overlay, which is where
 * the reply path looks for followers.
 */
router.put('/api/ws/:ws/conv/:conv/notify', route(async ({ params, request, user }) => {
  const ctx = await requireMembership(params.ws, user);
  const id = ctx.id;
  const conv = resolveConv(ctx, params.conv);
  // Written during a move's freeze (a setting is the member's own, and lost
  // to nothing that matters), but not into a copy that has moved (see assertNotMoved).
  assertNotMoved(ctx.ws);
  const body = await readJson(request);
  const cur = { ...(ctx.doc.notify[params.conv] || {}) };
  const patch = {};
  if (body.level !== undefined) {
    if (!NOTIFY_LEVELS.includes(body.level)) fail(400, 'invalid', 'Unknown notification level');
    patch[`notify.${params.conv}.level`] = body.level;
    cur.level = body.level;
  }
  if (body.mute !== undefined) {
    if (typeof body.mute !== 'boolean') fail(400, 'invalid', 'mute must be true or false');
    patch[`notify.${params.conv}.mute`] = body.mute;
    cur.mute = body.mute;
  }
  if (body.follow !== undefined) {
    if (conv.kind !== 'thread') fail(400, 'invalid', 'Only threads can be followed');
    if (typeof body.follow !== 'boolean') fail(400, 'invalid', 'follow must be true or false');
    // The root has to be there: the follower flag lives on its overlay, and
    // a path write for a message nobody posted would mint a block document
    // for any number named, one no walk of the conversation ever reaches.
    // A deleted one is closed too, except a root deleted while replies
    // stood: its thread stays on the Threads list around its tombstone (see
    // mergeBlock, and GET /threads, which keeps such a thread), and the flag
    // is written onto a record that is there. Refused with the rest of the
    // deleted, the Unfollow of such a thread answered "Message not found",
    // and the row stood on the list with nothing to take it off.
    const root = await locateMessage(conv.parent.conv, conv.parent.seq);
    if (!root || (root.overlay.d && !(Number(root.overlay.rc) > 0))) fail(404, 'not_found', 'Message not found');
    // A flag not there yet grows the root's block by a name (see assertBlockRoom).
    if (root.overlay.f?.[id.uuid] === undefined) assertBlockRoom(root.block, 60, 'This thread cannot take more followers');
    patch[`notify.${params.conv}.follow`] = body.follow;
    cur.follow = body.follow;
    await kv().update(root.key, { [`x.${overlayKey(conv.parent.seq)}.f.${id.uuid}`]: body.follow ? 1 : 0 });
    if (!body.follow && ctx.doc.threads[params.conv]) patch[`threads.${params.conv}`] = 0;
  }
  if (!Object.keys(patch).length) fail(400, 'invalid', 'Nothing to change');
  await kv().update(KEYS.member(params.ws, id.uuid), patch);
  // The post path reads this instead of every member's document.
  if (body.level !== undefined && conv.channel && conv.kind !== 'thread' && !conv.dm) {
    if (body.level === 'all') await kv().update(KEYS.notifyAll(params.ws), { [`${params.conv}.${id.uuid}`]: 1 });
    else await kv().remove(KEYS.notifyAll(params.ws), `${params.conv}.${id.uuid}`).catch(() => {});
  }
  // The member's other tabs and devices are told their own state moved, as
  // the read route tells them of a badge cleared: what they chime and show a
  // banner for, and which threads they list, they judge by the settings in
  // the document they hold, refetched when their stamp moves. A channel
  // muted, or turned down to mentions, on the phone went on chiming and
  // bannering on the laptop until something else had it fetch the document;
  // a thread followed there was not on the laptop's list. A setting changed
  // is one deliberate act, not a cursor moving with every message read.
  await pokeMember(params.ws, id.uuid).catch(() => {});
  return { ok: true, notify: cur };
}));

/** "All messages" chosen before tc:ws:{id}:na existed, carried into it once per member. */
async function recordHearAll(ws, uuid, doc) {
  const heard = Object.entries(doc.notify || {}).filter(([c, v]) => v?.level === 'all' && own(ws.channels, c)).map(([c]) => [`${c}.${uuid}`, 1]);
  if (heard.length) await kv().update(KEYS.notifyAll(ws.id), Object.fromEntries(heard));
  await kv().update(KEYS.member(ws.id, uuid), { naSync: 1 });
}

/* ---- pins -------------------------------------------------------------- */

/**
 * Remove a pin from the list, clear the message flag, and count it off.
 * Idempotent. `known` is the list as the caller has just read it (the unpin
 * route reads it to find the pin and who made it), spared a second read;
 * `audience` is who to signal for it (see audienceOf).
 */
async function unpin(wsId, conv, seq, known = null, audience = null, ws = null) {
  const doc = known || (await kv().get(KEYS.pins(wsId, conv))) || { items: [] };
  const items = (doc.items || []).filter((p) => p.seq !== seq);
  if (items.length === (doc.items || []).length) return false;
  await kv().set(KEYS.pins(wsId, conv), { items });
  await kv().remove(KEYS.block(conv, blockIndexOf(seq)), `x.${overlayKey(seq)}.p`).catch(() => {});
  // The count is of messages pinned, as the pin route and the pins list
  // count them, not of entries: a list that came to hold a message twice
  // (see the pins list route) counted it twice here, and the header said one
  // pin more than the list showed until the next pin.
  await touchConv(wsId, conv, now(), { audience, extra: { [`c.${conv}.pc`]: new Set(items.map((p) => p?.seq)).size }, ws, seq, patch: { p: 0 } });
  return true;
}

/**
 * The pinned messages of a conversation, with the messages themselves where
 * they can be read in a bounded number of blocks (newest pins first). A pin
 * whose block was not reached comes back without its message; the client
 * can still open it.
 */
router.get('/api/ws/:ws/conv/:conv/pins', route(async ({ params, user }) => {
  // The pin list is keyed on the workspace and the conversation, so it comes
  // up with the caller's own document rather than after it.
  const pinned = looksLikeConvId(params.conv) ? [KEYS.pins(params.ws, params.conv)] : [];
  const ctx = await requireMembership(params.ws, user, { also: pinned });
  const conv = resolveConv(ctx, params.conv);
  const doc = (pinned.length ? ctx.extra[0] : await kv().get(KEYS.pins(params.ws, params.conv))) || { items: [] };
  // One row per message: a list that came to hold a message twice (two pins
  // of it at once on a store that hands nothing back from an append) is
  // shown with its first copy, the one that stands as the pin.
  const seen = new Set();
  const items = (doc.items || []).filter((p) => p && !seen.has(p.seq) && seen.add(p.seq)).sort((a, b) => b.ts - a.ts);
  const blocks = [];
  for (const p of items) {
    const key = KEYS.block(params.conv, blockIndexOf(p.seq));
    if (!blocks.includes(key) && blocks.length < 12) blocks.push(key);
  }
  const read = await getMany(blocks);
  const bySeq = new Map();
  read.forEach((b) => { for (const m of mergeBlock(b)) bySeq.set(m.seq, m); });
  // A pin whose message is gone comes off the list here, the one place it
  // is read whole, as a saved message that is gone comes off the saved list.
  // Deleting a message unpins it, but a pin and a deletion of the same
  // message in the same instant cross: the deletion finds no pin flag yet
  // (the pin route writes it after appending to the list) and unpins
  // nothing, and the pin then stands on the list, and in the header's
  // count, for good, drawn as "Open to read" with nothing to open; an
  // export carries such a pin into the copy as well. Only where the block
  // was read: a pin past the blocks one answer reads is merely shown
  // without its message. Not while the workspace is still being imported,
  // when a message not there yet is on its way, not gone; nor on a copy that
  // has moved to another server, or is being moved, which take no writes
  // (see assertWritable): the list is shown as it stands, and tidied once
  // the workspace is open to writes again.
  const frozenOrMoved = ctx.ws.importing || ctx.ws.movedTo || frozen(ctx.ws);
  const gone = new Set(frozenOrMoved ? [] : items.filter((p) => blocks.includes(KEYS.block(params.conv, blockIndexOf(p.seq))) && (!bySeq.has(p.seq) || bySeq.get(p.seq).deleted)).map((p) => p.seq));
  if (gone.size) {
    const kept = (doc.items || []).filter((p) => !p || !gone.has(p.seq));
    await kv().set(KEYS.pins(params.ws, params.conv), { items: kept }).catch(() => {});
    // The flag on the message goes with the entry, as an unpin takes it (see unpin).
    for (const seq of gone) await kv().remove(KEYS.block(params.conv, blockIndexOf(seq)), `x.${overlayKey(seq)}.p`).catch(() => {});
    await touchConv(params.ws, params.conv, now(), { audience: audienceOf(conv), extra: { [`c.${params.conv}.pc`]: new Set(kept.map((p) => p?.seq)).size }, ws: ctx.ws }).catch(() => {});
  }
  return { pins: items.filter((p) => !gone.has(p.seq)).map((p) => ({ ...p, message: bySeq.get(p.seq) || null })) };
}));

/** Pin a message: anyone who may post here; capped, and announced in the conversation. */
router.post('/api/ws/:ws/conv/:conv/pins', route(async ({ params, request, user, defer }) => {
  // The pin list is keyed on the workspace and the conversation, so it comes
  // up with the caller's own document. The message's block cannot: which
  // message is being pinned is in the body, which is read after the caller
  // is known (see readJson's callers).
  const listed = looksLikeConvId(params.conv) ? [KEYS.pins(params.ws, params.conv)] : [];
  const ctx = await requireMembership(params.ws, user, { write: true, also: listed });
  const id = ctx.id;
  const conv = resolveConv(ctx, params.conv);
  if (!conv.canPost) {
    if (conv.deny === 'read_only') fail(403, 'read_only', 'Only admins can pin here');
    // Pinning follows posting rights, and in a thread those are the
    // channel's rules for replies: the refusal says which one stands in the
    // way, worded as a refused reply is, rather than telling someone in the
    // conversation to join it.
    const name = conv.channel ? `#${conv.channel.name}` : 'this conversation';
    if (conv.deny === 'threads_off') fail(403, 'threads_off', `Replies are turned off in ${name}, and so is pinning in its threads`);
    if (conv.deny === 'threads_admins') fail(403, 'threads_admins', `Only admins can pin in threads in ${name}`);
    // An archived channel is refused under the one code every route refuses
    // it with (see refusePost): answered `forbidden` with the archived
    // words, as it used to be, a caller reading the code could not tell an
    // archived channel from one it had not joined.
    if (conv.deny === 'archived') fail(403, 'archived', 'This channel is archived');
    fail(403, 'forbidden', 'Join the conversation to pin messages');
  }
  const body = await readJson(request);
  const seq = Math.floor(Number(body.seq));
  const found = await locateMessage(params.conv, seq);
  if (!found || found.overlay.d) fail(404, 'not_found', 'Message not found');
  if (found.raw.k === 'sys') fail(400, 'invalid', 'System lines cannot be pinned');
  // Nor a reminder line, which the app offers no pin on (as it offers no reaction, see the reaction route).
  if (found.raw.k === 'rem') fail(400, 'invalid', 'Reminders cannot be pinned');
  const pinsKey = KEYS.pins(params.ws, params.conv);
  const doc = (listed.length ? ctx.extra[0] : await kv().get(pinsKey)) || { items: [] };
  // The list is what is pinned; the flag on the message is its mirror. The
  // two can part: the list is appended to atomically but rewritten whole
  // when a pin is taken off, so a pin landing while another was taken off
  // went off the list with the flag still on its message, which then said
  // "Pinned" over a list that did not hold it, and could be neither pinned
  // (the flag said it was) nor unpinned (the list said it was not). A
  // message on the list is pinned, whatever its flag (put right here); one
  // flagged but off the list is not, and is pinned now like any other.
  if ((doc.items || []).some((p) => p.seq === seq)) {
    if (!found.overlay.p) await kv().update(found.key, { [`x.${overlayKey(seq)}.p`]: 1 }).catch(() => {});
    return { ok: true, already: true };
  }
  if ((doc.items || []).length >= LIMITS.pinsPerConversation) {
    fail(400, 'limit', `A conversation can hold ${LIMITS.pinsPerConversation} pins. Unpin something first`);
  }
  const ts = now();
  const pin = { seq, by: id.uuid, ts };
  // The list and the flag on the message are different documents and neither
  // answer feeds the other, so they go together rather than one after the other.
  await Promise.all([appendItems(pinsKey, [pin]), kv().update(found.key, { [`x.${overlayKey(seq)}.p`]: 1 })]);
  // Read back once: an unpin rewriting the list in the same instant took
  // this entry off it; put back, it is on the list as its flag says.
  let items = (await kv().get(pinsKey).catch(() => null))?.items;
  if (Array.isArray(items) && !items.some((p) => p.seq === seq)) {
    await appendItems(pinsKey, [pin]);
    items = [...items, pin];
  }
  // Two people pinning one message in the same instant each read the list
  // above without it and each appended it: the list then held the message
  // twice, the header counted two pins for it, and the conversation got two
  // "pinned a message" lines. The copy that landed first stands as the pin;
  // a request whose own entry is not that copy landed second, takes its copy
  // off again, and is answered as pinned already, like a pin of a message on
  // the list. So is one whose entry is not on the list at all while
  // another's for the message is: the two were the conversation's first
  // pins, and on a store that refuses to append to a list that is not
  // there yet (see appendItems) each wrote the list whole, the slower write
  // taking the faster one's entry with it, so the one copy left was the
  // other's; or an unpin in between took every copy off and the other
  // pinned it again. Either way the message is pinned, by the other, and
  // this request has no pin of its own to announce (it used to write a
  // second line, and tell its sender they had pinned it). The count is of
  // messages pinned, whatever the list holds.
  if (Array.isArray(items)) {
    const copies = items.map((p, j) => (p && p.seq === seq ? j : -1)).filter((j) => j >= 0);
    const first = copies.length ? items[copies[0]] : null;
    if (first && !(first.by === pin.by && first.ts === pin.ts)) {
      const own = [...copies].reverse().find((j) => items[j].by === pin.by && items[j].ts === pin.ts);
      if (own !== undefined) await kv().set(pinsKey, { items: items.filter((_, j) => j !== own) }).catch(() => {});
      else if (copies.length > 1) await kv().set(pinsKey, { items: items.filter((_, j) => j !== copies[copies.length - 1]) }).catch(() => {});
      return { ok: true, already: true };
    }
  }
  const count = Array.isArray(items) ? new Set(items.map((p) => p?.seq)).size : (doc.items || []).length + 1;
  // The message is pinned as far as the caller is concerned; the stamp that
  // tells everyone so, and the line in the conversation saying who did it,
  // follow behind the answer. The line is a whole message of its own — a
  // number, an append and a stamp — and it stood in front of every pin.
  defer(async () => {
    await touchConv(params.ws, params.conv, ts, { audience: audienceOf(conv), extra: { [`c.${params.conv}.pc`]: count }, ws: ctx.ws, seq, patch: { p: 1 } });
    await postSystem(params.ws, params.conv, id.uuid, `${ctx.ws.members[id.uuid].name} pinned a message`);
  });
  return { ok: true, pin };
}));

/** Unpin: the person who pinned it, or an admin. */
router.delete('/api/ws/:ws/conv/:conv/pins/:seq', route(async ({ params, user }) => {
  const ctx = await requireMembership(params.ws, user, { write: true });
  const id = ctx.id;
  const conv = resolveConv(ctx, params.conv);
  const seq = Math.floor(Number(params.seq));
  const doc = (await kv().get(KEYS.pins(params.ws, params.conv))) || { items: [] };
  const pin = (doc.items || []).find((p) => p.seq === seq);
  if (!pin) {
    // Off the list but flagged (see the pin route): the message says
    // "Pinned" over a list that does not hold it, and "Unpin" is what its
    // row offers. Nothing is pinned, so nothing is unpinned; the stray flag
    // goes, for anyone who could have pinned here or an admin, and the
    // conversation is stamped so every tab redraws the row.
    const found = await locateMessage(params.conv, seq);
    if (!found?.overlay.p) fail(404, 'not_found', 'That message is not pinned');
    if (!conv.canPost && !isAdmin(ctx.member)) fail(403, 'forbidden', 'Only the person who pinned it, or an admin, can unpin');
    await kv().remove(found.key, `x.${overlayKey(seq)}.p`);
    await touchConv(params.ws, params.conv, now(), { audience: audienceOf(conv), ws: ctx.ws, seq, patch: { p: 0 } });
    return { ok: true };
  }
  if (pin.by !== id.uuid && !isAdmin(ctx.member)) fail(403, 'forbidden', 'Only the person who pinned it, or an admin, can unpin');
  // The list as read above is the list unpinned from: read again for it, as
  // it used to be, every unpin cost one round trip more than it needed.
  await unpin(params.ws, params.conv, seq, doc, audienceOf(conv), ctx.ws);
  return { ok: true };
}));

/* ---- search ------------------------------------------------------------ */

/**
 * Query params: q (words), in (conversation id), from (member uuid),
 * has (file,link), before/after (epoch ms), cursor. Results only ever come
 * from conversations the caller may read; the check runs on every
 * candidate before any message is fetched.
 */
router.get('/api/ws/:ws/search', route(async ({ params, request, user }) => {
  const id = await identify(user);
  // The index's meta document is read alongside the membership check: one
  // hop instead of two before the shards can be asked for.
  const [membership, meta] = await Promise.all([
    requireMembership(params.ws, id.uuid),
    /^[a-z0-9]{6,20}$/.test(String(params.ws)) ? searchMeta(params.ws).catch(() => ({})) : {},
  ]);
  const ctx = { ...membership, uuid: id.uuid };
  const q = query(request);
  const text = cleanText(q.get('q') || '', LIMITS.searchQuery);
  const num = (name) => (q.get(name) ? Math.floor(Number(q.get(name))) || null : null);
  const inConv = q.get('in') || null;
  if (inConv) resolveConv(ctx, inConv); // 404 when the caller cannot read it
  const from = q.get('from') || null;
  if (from && !/^[\w-]{1,64}$/.test(from)) fail(400, 'invalid', 'Unknown person');
  const has = String(q.get('has') || '').split(',').filter((h) => h === 'file' || h === 'link');
  const canRead = (conv) => {
    try {
      resolveConv(ctx, conv);
      return true;
    } catch {
      return false;
    }
  };
  // A workspace whose index predates month buckets keeps answering from it
  // (read alongside the log) until an admin rebuilds on the current layout.
  const legacy = !(Number(ctx.ws.search?.v) >= SEARCH_VERSION);
  const out = await searchIndex(params.ws, {
    words: queryWords(text), has, in: inConv, from, before: num('before'), after: num('after'), cursor: q.get('cursor') || null,
  }, canRead, { meta, legacy });
  return { ...out, indexed: ctx.ws.search || null };
}));

/**
 * Admin only: (re)build the index over existing history. Each call does a
 * bounded amount of work and returns a state to post back; the client loops
 * until `done`. Starting over (no state) drops the old index first.
 */
router.post('/api/ws/:ws/search/reindex', route(async ({ params, request, user }) => {
  const id = await identify(user);
  const body = await readJson(request);
  let state = body.state && typeof body.state === 'object' && Array.isArray(body.state.convs) ? body.state : null;
  // The admin's own document is read with the first step, whose reading of
  // every member's it seeds (see memberDocsReader); a step carrying on from
  // a state looks at nothing of it, and read it all the same, a round trip
  // per step over the hundreds a large workspace's rebuild runs to. The
  // state is looked at only once the caller is known to be an admin here.
  const { ws, member, doc } = await requireMembership(params.ws, id.uuid, { doc: !state });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can build the search index');
  if (state) {
    const drop = Array.isArray(state.drop) ? state.drop : [];
    const ok = state.convs.every((c) => typeof c === 'string' && /^[a-z0-9_]{1,64}$/.test(c))
      && drop.every((b) => isBucket(b))
      && Number.isInteger(state.i) && state.i >= 0 && Number.isInteger(state.n) && state.n >= 0;
    if (!ok) fail(400, 'invalid', 'Bad reindex state');
    state = { convs: state.convs.slice(0, REINDEX_MAX_CONVS), i: state.i, n: state.n, messages: Number(state.messages) || 0, skipped: Number(state.skipped) || 0, drop: drop.slice(0, 1200) };
    // The list of conversations comes back from the client between steps:
    // only this workspace's are read (its channels, the direct messages the
    // first step listed and kept, and threads of either), as export holds
    // its walk to its own workspace. Anything else is dropped from the list,
    // the position kept on the same entry; a walk whose record is gone
    // (started on an older build) starts over.
    const walk = await kv().get(KEYS.searchWalk(ws.id));
    if (!walk || !Array.isArray(walk.dms)) fail(400, 'invalid', 'Bad reindex state');
    const dms = new Set(walk.dms);
    const ours = (c) => {
      const t = parentOfThread(c);
      if (t && (threadConvId(t.conv, t.seq) !== c || parentOfThread(t.conv))) return false;
      const base = t ? t.conv : c;
      return !!own(ws.channels, base) || dms.has(base);
    };
    const convs = [];
    let i = state.i;
    state.convs.forEach((c, idx) => {
      if (ours(c)) convs.push(c);
      else if (idx < state.i) i--;
      else if (idx === state.i) state.n = 0;
    });
    state.convs = convs;
    state.i = Math.max(0, i);
  }
  let memberDocs = [];
  if (!state) {
    // Direct messages live in member documents: one read each, once, at the
    // start, the caller's being the one their membership was read with (see
    // memberDocsReader; read again among the rest, as it used to be, the same
    // key was read twice in one request).
    memberDocs = [...(await memberDocsReader(ws, { uuid: id.uuid, doc })()).values()];
  }
  const next = await reindexStep(ws.id, ws, memberDocs, state);
  if (next.done) {
    await kv().update(KEYS.ws(ws.id), { search: indexStamp() });
    await bumpWorkspace(ws.id);
  }
  // `clearing`: months of the previous index still to drop before the walk begins.
  return {
    done: next.done,
    state: next.done ? null : next,
    progress: { done: Math.min(next.i, next.convs.length), total: next.convs.length, messages: next.messages, skipped: next.skipped || 0, clearing: Array.isArray(next.drop) ? next.drop.length : 0 },
  };
}));

/* ---- integrations: incoming webhooks and bot tokens --------------------- */

/**
 * Tokens are `tch_{id}_{secret}` (webhooks) and `tcb_{id}_{secret}` (bots):
 * the id makes the record a direct get, the secret is stored only as a
 * SHA-256 hash and compared in constant time, and the token is shown to the
 * admin exactly once. These are the only routes besides /health that take
 * no Puter session, so they are rate-limited per token and reject oversized
 * bodies before touching storage.
 */
const TOKEN_RE = /^(tch|tcb)_([a-z0-9]{10})_([a-z0-9]{32})$/;
const BOT_SCOPES = ['post', 'read', 'react'];

function botAuthor(kind, id) {
  return `${kind}_${id}`;
}

/**
 * How many integrations a workspace has: the live ones, as the list shows
 * them. A "last used" note landing under an integration revoked meanwhile
 * (or whose channel was deleted) leaves an entry of that one field, which
 * the list route sweeps; counted here until then, it made a workspace with
 * forty-nine integrations refuse a fiftieth, and told a move's nominee of
 * fifty to make again.
 */
function liveIntegrations(ws) {
  const live = (map, has) => Object.values(map || {}).filter((v) => !!(v && typeof v === 'object' && v[has])).length;
  return live(ws.webhooks, 'ch') + live(ws.bots, 'name');
}

async function mintToken(kind) {
  const id = uid(10);
  const secret = uid(32);
  return { id, secret, token: `${kind}_${id}_${secret}`, hash: await sha256(secret) };
}

/** The minute's count of calls under one token id (see authToken); dropped when the token is rotated. */
const hookRateKey = (id) => `tc:hookrate:${id}`;

/** Resolve a token to its record, or 401. Records of revoked tokens are gone, so they fail the same way. */
async function authToken(raw, expectKind) {
  const m = TOKEN_RE.exec(String(raw || ''));
  if (!m || m[1] !== expectKind) fail(401, 'unauthorized', 'Invalid token');
  const [, kind, id, secret] = m;
  const rec = await kv().get(kind === 'tch' ? KEYS.hook(id) : KEYS.bot(id));
  // A record with no workspace is not one: a rotation whose write landed
  // after a revocation deleted the record left a hash alone under the id,
  // and the token the rotation handed out then passed here, to be answered
  // "the channel is gone" as a webhook and, as a bot, to fail on the record's
  // missing scopes with a server error. Revoked is revoked: invalid.
  if (!rec || !rec.ws || !timingSafeEqual(await sha256(secret), rec.hash)) fail(401, 'unauthorized', 'Invalid token');
  // Rate limit per token, a minute at a time: the minute runs from the
  // token's first call in it, and a fresh one begins with the first call
  // after it has run out.
  const rateKey = hookRateKey(id);
  const n = await kv().incr(rateKey).catch(() => 1);
  if (n === 1) await kv().expire(rateKey, 60).catch(() => {});
  // One budget for every call the token makes, a read as much as a post.
  // The refusal says when to try again in the header machines read for it
  // (Retry-After): the minute at most, since
  // how much of it is left is not read. Told in words alone, as it used to
  // be, a build server that honours the header retried at once and spent the
  // rest of the minute being refused.
  if (n > LIMITS.hookRatePerMinute) fail(429, 'rate_limited', `This token may make ${LIMITS.hookRatePerMinute} calls a minute; try again shortly`, { 'Retry-After': '60' });
  return { id, rec };
}

/** Read a small JSON body; refuse anything over the cap before parsing it. */
async function readSmallJson(request) {
  const len = Number(request.headers.get('content-length'));
  if (len > LIMITS.webhookBodyBytes) fail(413, 'too_large', `Payloads can be up to ${LIMITS.webhookBodyBytes / 1024} KB`);
  // A body sent without a length (chunked) is read only as far as the cap,
  // rather than whole and then measured: these routes take no session.
  const { text, truncated } = await readCapped(request, LIMITS.webhookBodyBytes);
  if (truncated || text.length > LIMITS.webhookBodyBytes) fail(413, 'too_large', `Payloads can be up to ${LIMITS.webhookBodyBytes / 1024} KB`);
  // The oldest incoming-webhook shape, which a decade of build servers and
  // scripts were set up with (and what `curl -d payload=…` sends): the JSON
  // in a `payload` field of a form-encoded body. Read as JSON, as it used to
  // be, such a body was refused ("Body must be JSON"), and an integration
  // set up that way posted nothing here. The field is read where the body
  // says it is a form, or opens as one with no type at all; one with no
  // such field is refused with what would do. (A byte order mark ahead of
  // the JSON is taken off by the decoding, see readCapped.)
  const form = /application\/x-www-form-urlencoded/i.test(String(request.headers.get('content-type') || '')) || /^payload=/.test(text);
  const raw = form ? String(new URLSearchParams(text).get('payload') || '') : text;
  if (form && !raw) fail(400, 'invalid', 'Body must be JSON, or a form with a JSON payload field');
  try {
    const body = JSON.parse(raw || '{}');
    return body && typeof body === 'object' ? body : {};
  } catch {
    fail(400, 'invalid', form ? 'The payload field must be JSON' : 'Body must be JSON');
  }
}

/**
 * Text from our shape or the common incoming-webhook one ({ text }, or
 * blocks/attachments with text), its markup read as that format writes it,
 * and each part given the place the format gives it. Blocks that say
 * something are the message, and `text` beside them is the notification
 * fallback a payload may carry (many libraries send `text: ""` with their
 * blocks, and as many send a one-line summary there); without blocks,
 * `text` is the message. The attachments follow either, below the message
 * as they are drawn under it. Taken as the whole message whenever it said
 * something, as it used to be, a payload's summary line was posted and the
 * blocks or attachments that held the notice itself (the build's title,
 * its fields, who ran it) were dropped, so a deploy notice arrived as
 * "Deploy finished" alone. Blocks that say nothing (a divider, a picture)
 * leave the text to stand in. Each piece reads its own markup (see
 * blockText and attachmentText): a rich text block's runs are plain words,
 * which the format never escapes, and are read as written.
 */
function integrationText(body) {
  const text = typeof body.text === 'string' && body.text.trim() ? fromWebhookMarkup(body.text) : '';
  const blocks = (Array.isArray(body.blocks) ? body.blocks : []).map(blockText).filter(Boolean);
  const attachments = (Array.isArray(body.attachments) ? body.attachments : []).map(attachmentText).filter(Boolean);
  const lead = blocks.length ? blocks : text ? [text] : [];
  return [...lead, ...attachments].join('\n');
}

/**
 * The text of one attachment in the legacy attachments shape (what build
 * servers and monitoring tools have sent for a decade: a coloured bar
 * beside a few lines), each piece on its own line in the order they are
 * drawn: the pretext above the bar, the title with its link (as
 * <address|label> in a payload's text is read: "title (link)", the address
 * alone when the title is the address), the text, the fields one to a line
 * as "title: value", the blocks an attachment may carry instead, and the
 * footer. Only the text used to be read, and the fallback (the one-line
 * summary shown in a notification) only when there was no text, so a build
 * notice arrived as its body alone, its title and every field gone, and one
 * made of a title and fields alone posted its notification summary
 * instead. The fallback now stands in only when nothing else says
 * anything. The markup within each piece (links, mentions, dates, escapes)
 * is read as incoming-webhook markup; the blocks read their own (see
 * blockText).
 */
function attachmentText(a) {
  if (!a || typeof a !== 'object') return '';
  const str = (v) => (typeof v === 'string' ? fromWebhookMarkup(v.trim()).trim() : '');
  const lines = [];
  if (str(a.pretext)) lines.push(str(a.pretext));
  const title = str(a.title);
  const link = /^https?:\/\/\S+$/i.test(str(a.title_link)) ? str(a.title_link) : '';
  if (title) lines.push(link && link !== title ? `${title} (${link})` : title);
  if (str(a.text)) lines.push(str(a.text));
  for (const f of Array.isArray(a.fields) ? a.fields : []) {
    const name = str(f?.title);
    const value = str(f?.value);
    if (name && value) lines.push(`${name}: ${value}`);
    else if (name || value) lines.push(name || value);
  }
  for (const b of Array.isArray(a.blocks) ? a.blocks : []) {
    const t = blockText(b);
    if (t) lines.push(t);
  }
  if (str(a.footer)) lines.push(str(a.footer));
  if (!lines.length && str(a.fallback)) lines.push(str(a.fallback));
  return lines.join('\n');
}

/**
 * The text of one payload block. A section's or a header's is its text, and
 * a section's fields after it, one to a line (the two columns of small
 * facts a deploy notice is often made of: an environment, a version, who
 * asked for it; a section may carry them with no text of its own,
 * and such a section used to post as nothing, a payload of one refused as
 * saying nothing); a context block's is the pieces of its line (small print
 * under a message: "triggered by alice", a time), which used to be dropped
 * from the post without a word, and a payload of context alone refused as
 * saying nothing; a rich text block's is its runs, one line per section,
 * list item, quote or preformatted run, the inline runs of each joined as
 * written (a link without words is its address, an emoji its name).
 * Anything else (a divider, a picture, buttons) says nothing.
 *
 * A section's, a header's and a context block's text is incoming-webhook
 * markup (see fromWebhookMarkup). A rich text block's runs
 * are not: rich text is the structured form, its words carried as they
 * are, so they are read as written. Read for markup with the rest, as they
 * used to be, a snippet in a preformatted run that held "&lt;" or "&amp;"
 * (an HTML template, a shell line) posted with the characters they stand
 * for, code that no longer read as the code it was, and an address written
 * in a run between angle brackets was rewritten as a link with words.
 */
function blockText(b) {
  if (!b || typeof b !== 'object') return '';
  // A block whose text is blank (a space, a line break) says nothing, as a
  // divider says nothing: judged by whether it carried a string at all, as
  // it used to be, such a block stood in for the message, so a payload
  // whose summary line stood beside it was refused as saying nothing, and
  // one with an attachment beside it posted the attachment alone.
  const said = (t) => (t.trim() ? t : '');
  const own = typeof b.text?.text === 'string' ? b.text.text : typeof b.text === 'string' ? b.text : '';
  const fields = (Array.isArray(b.fields) ? b.fields : []).map((f) => (typeof f?.text === 'string' ? f.text : '')).filter(Boolean);
  if (own || fields.length) return said(fromWebhookMarkup([own, ...fields].filter(Boolean).join('\n')));
  if (!Array.isArray(b.elements)) return '';
  if (b.type === 'rich_text') return b.elements.flatMap(richLines).join('\n');
  return said(fromWebhookMarkup(b.elements.map(runText).filter(Boolean).join(' ')));
}
/**
 * The lines of one rich text element, in the marks the app draws (see
 * lib/format.js): a section is one line of its inline runs; a quote is its
 * lines each led by "> "; a list is one line per item, led by "- " or by
 * its number, indented by its level; a preformatted run is a fenced block.
 * Posted as bare lines, as they used to be, a quote read as plain words, a
 * list ran its items together with nothing to tell them apart, and code
 * kept its indentation in the stored text alone, since the message body is
 * drawn with its spaces collapsed: "    return 1" showed as "return 1".
 */
function richLines(e) {
  if (!e || typeof e !== 'object') return [];
  if (!Array.isArray(e.elements)) return [runText(e)].filter(Boolean);
  if (e.type === 'rich_text_list') {
    // Nested lists come as lists of their own with an indent level; led in
    // by no-break spaces, since the body collapses ordinary ones.
    const pad = '\u00a0\u00a0'.repeat(Math.max(0, Math.min(8, Math.floor(Number(e.indent) || 0))));
    const ordered = e.style === 'ordered';
    let n = 0;
    return e.elements.flatMap((item) => richLines(item).flatMap((entry) => entry.split('\n').map((line, i) => (i === 0 ? `${pad}${ordered ? `${++n}. ` : '- '}${line}` : `${pad}\u00a0\u00a0${line}`))));
  }
  if (e.type === 'rich_text_preformatted') {
    // Code, its spacing part of what it says, in a fence the app draws as a
    // block that keeps it. A fence within the code would close the block
    // early (and pair with the next block's fence, breaking that one open),
    // so each is broken by a zero-width space, which shows as nothing: after
    // every backtick with two more behind it, so a run of any length (the
    // four-backtick fence Markdown allows, quoted in a snippet) is left with
    // no three in a row. Broken at every third alone, as it used to be, a
    // run of four kept three together past the break, and the block closed
    // there: what followed drew as plain words, and the code's end opened a
    // block of its own. The app reads a lone word on a fence's first line as
    // a language hint and hides it, so code that opens with one is set off
    // by a blank line, which the app takes off again.
    const code = e.elements.map(runText).join('').replace(/`(?=``)/g, '`\u200b');
    if (!code.trim()) return [];
    const hint = /^[\w+-]{1,20}$/.test(code.split('\n', 1)[0].trim());
    return [`\`\`\`\n${hint ? '\n' : ''}${code}\n\`\`\``];
  }
  const line = joinRuns(e.elements);
  if (!line) return [];
  if (e.type === 'rich_text_quote') return line.split('\n').map((l) => `> ${l}`);
  return [line];
}

/**
 * One line from a rich text element's inline runs. A run this reads as
 * nothing (a date, a colour swatch) leaves the space on either side of it to
 * be one, and none at the ends of the line; the spacing within a run stays
 * as it was written. A text run's style (bold, italic, strike, code) becomes
 * the mark the app draws it by (see styledRun).
 */
function joinRuns(elements) {
  const texts = elements.map(runText);
  let line = '';
  let gap = false;
  for (let i = 0; i < elements.length; i++) {
    let t = texts[i];
    if (!t) {
      gap = true;
      continue;
    }
    const r = elements[i];
    if (r.type === 'text' && r.style && typeof r.style === 'object') t = styledRun(t, r.style, line, texts.slice(i + 1).find(Boolean) || '');
    line += gap && line.endsWith(' ') && t.startsWith(' ') ? t.slice(1) : t;
    gap = false;
  }
  return line.trim();
}

/**
 * A styled text run in the app's marks: **bold**, _italic_, ~strike~,
 * `code`. Only where the mark would draw: a run with a space at either end,
 * or a line break within, is left plain (the app draws "** x**" as typed);
 * so is one that carries the mark's own character. Italics and strikes
 * stand on their own in the app (opened after a space, a bracket or a quote,
 * closed before a space, punctuation or the end), so they take their mark
 * only where the run's neighbours allow it, or inside bold, whose tag is a
 * boundary of its own. Code takes no other mark. Only text runs are styled:
 * a person or a channel named by id (@U1) stays as it is.
 */
function styledRun(t, style, before, after) {
  if (/^\s|\s$/.test(t) || t.includes('\n')) return t;
  if (style.code) return t.includes('`') ? t : `\`${t}\``;
  const bold = !!style.bold && !t.includes('*');
  const alone = bold || ((!before || /[\s(["']$/.test(before)) && (!after || /^[\s.,!?;:)\]"']/.test(after)));
  let out = t;
  if (style.strike && alone && !t.includes('~')) out = `~${out}~`;
  if (style.italic && alone && !t.includes('_')) out = `_${out}_`;
  if (bold) out = `**${out}**`;
  return out;
}

/**
 * A text clamped to `max` that leaves no fence open: a fenced block the
 * clamp cut through would draw everything after it as code, or, its closing
 * fence gone, nothing after it at all. The text is cut a little shorter and
 * the block closed; a cut that took an opening fence with it needs nothing.
 * Only a fence the clamp opened: `whole` is the text before the clamp, and
 * a lone fence the writer left open in it stays as written, drawn as the
 * backticks it is, as it is in a member's message. Closed all the same, as
 * it used to be, "use ``` to open a code block" posted by a webhook drew
 * everything after the fence as code. The fence open at the cut is the
 * writer's own only when it is the last the whole text had (the app pairs
 * fences from the first on, so an odd one out is always the last): where
 * the text went on to more fences past the cut, the open one is a block's,
 * cut through, and is closed. Judged by the whole text's count alone, as
 * it briefly was, a block cut through in a text that also carried a lone
 * fence of the writer's past the cut was left open, and drew as its text.
 */
function closeFences(text, max, whole = text) {
  const fences = (s) => (s.match(/```/g) || []).length;
  if (fences(text) % 2 === 0 || fences(text) === fences(whole)) return text;
  const cut = text.length > max - 4 ? cleanText(text, max - 4).replace(/`+$/, '').trimEnd() : text;
  return fences(cut) % 2 === 0 ? cut : `${cut}\n\`\`\``;
}
/**
 * One inline run of rich text as plain words: its text; a link as its
 * address, with its words before it when it has some (as fromWebhookMarkup
 * reads <address|label> in a payload's text: the words alone, as the run
 * used to post, had nowhere to lead); an emoji as its name; a person, a
 * channel, a user group or a notice to everyone by the id or range the
 * payload wrote, as fromWebhookMarkup reads the same in a payload's text
 * (<@U1>, <#C1>, <!channel>), since the ids come from elsewhere and name
 * nobody here. Left out, the words around them ran together with a gap
 * where the name had been.
 */
function runText(e) {
  if (!e || typeof e !== 'object') return '';
  if (e.type === 'link' && typeof e.url === 'string') {
    const label = typeof e.text === 'string' ? e.text.trim() : '';
    return label && label !== e.url ? `${label} (${e.url})` : e.url;
  }
  if (typeof e.text === 'string') return e.text;
  if (e.type === 'emoji' && typeof e.name === 'string') return `:${e.name}:`;
  if (e.type === 'user' && typeof e.user_id === 'string') return `@${e.user_id}`;
  if (e.type === 'usergroup' && typeof e.usergroup_id === 'string') return `@${e.usergroup_id}`;
  if (e.type === 'channel' && typeof e.channel_id === 'string') return `#${e.channel_id}`;
  if (e.type === 'broadcast' && typeof e.range === 'string') return `@${e.range}`;
  return '';
}

/**
 * A payload's text writes a link as <address|label> (or <address>),
 * a channel-wide notice as <!channel>, a person as <@id|name>, a channel as
 * <#id|name>, and escapes every & < > in the text. Posted as it came, a
 * build notice read "Build <https://ci.example.com/42|#42> passed &amp;
 * deployed", the label glued onto an address that then led nowhere. Each
 * is made the plain text the app draws as such; only these exact shapes
 * are read, so a stray angle bracket or an ampersand in a payload of our
 * own shape stays as it was. The escapes go last, once the markup they
 * kept out of is read.
 */
function fromWebhookMarkup(text) {
  return String(text)
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]*)>/g, (m, url, label) => (label.trim() ? `${label.trim()} (${url})` : url))
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/<mailto:([^|>\s]+)\|([^>]*)>/g, (m, addr, label) => (label.trim() ? `${label.trim()} (${addr})` : addr))
    .replace(/<mailto:([^>\s]+)>/g, '$1')
    .replace(/<!(channel|here|everyone)(?:\|[^>]*)?>/g, '@$1')
    // A user group (<!subteam^ID|@handle>): its handle, and a group without
    // one is "@group", since the id is from elsewhere and names nobody
    // here. Left as written, the markup itself stood in the line.
    .replace(/<!subteam\^[A-Za-z0-9]+(?:\|([^>]*))?>/g, (m, label) => (label && label.trim() ? `${label.trim().startsWith('@') ? '' : '@'}${label.trim()}` : '@group'))
    .replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, '$1')
    .replace(/<([@#])([A-Za-z0-9]+)(?:\|([^>]*))?>/g, (m, sigil, id, label) => `${sigil}${(label || id).trim()}`)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * What a token's write meets on a workspace that takes none: the refusals a
 * member's write meets (see assertWritable), and for a move under way the
 * time the freeze has left, in the header machines read for it (Retry-After,
 * as the token's own rate limit answers): a build server that honours it
 * backs off for that long, where told in words alone it tried again at once
 * and was refused for the length of the move. Capped at a few minutes: the
 * freeze is renewed while the move runs and let go of the moment it is
 * done, so a caller asks again well before the half hour a freeze may hold.
 */
const TOKEN_RETRY_MAX_S = 300;
function assertTokenWritable(ws) {
  assertNotMoved(ws);
  if (ws.importing) fail(409, 'importing', 'This workspace is still being imported; try again in a moment');
  if (frozen(ws)) {
    const left = Math.ceil(((Number(ws.transferring.at) || 0) + TRANSFER_FREEZE_MS - now()) / 1000);
    fail(423, 'transferring', 'This workspace is being moved to another server; try again in a few minutes', { 'Retry-After': String(Math.max(1, Math.min(TOKEN_RETRY_MAX_S, left))) });
  }
}

/** Post as an integration: no mentions, no broadcasts, never a member's identity. */
async function postAsBot(wsId, conv, author, bot, text, audience = null, ws = null) {
  // Clamped as any post is, and a fenced block the clamp cut through closed (see closeFences).
  const clean = closeFences(cleanText(text, LIMITS.messageText), LIMITS.messageText, cleanText(text, Infinity));
  if (!clean) fail(400, 'invalid', 'Send some text');
  const msg = { u: author, t: clean, ts: now(), bot: { name: bot.name, color: bot.color } };
  const seq = await writeMessage(wsId, conv, msg, { audience, ws });
  await indexMessage(wsId, conv, msg).catch(() => {});
  return { seq, ts: msg.ts, text: clean };
}

function cleanIntegration(body) {
  // The author line of every post it makes: one line, as a display name is (see cleanLine).
  const name = cleanLine(body.name, LIMITS.webhookName);
  if (!name) fail(400, 'invalid', 'Give it a name');
  const color = Number.isInteger(body.color) && body.color >= 1 && body.color <= 8 ? body.color : colorSlot(name);
  return { name, color };
}

/**
 * A deleted channel takes its integrations with it: the webhooks bound to
 * it (their records too, so their tokens die as a revoked one's does) and
 * its place in every bot's channel list. Deleting the workspace drops them
 * all; deleting one channel left them, so the admins' list went on showing
 * a webhook for "#?" that only a revoke by hand would clear, while its
 * token was still looked up, counted against its budget, and answered 404.
 */
async function dropChannelIntegrations(ws, ch) {
  const hooks = Object.entries(ws.webhooks || {}).filter(([, h]) => h?.ch === ch).map(([id]) => id);
  for (const id of hooks) await kv().del(KEYS.hook(id)).catch(() => {});
  if (hooks.length) await kv().remove(KEYS.ws(ws.id), ...hooks.map((id) => `webhooks.${id}`)).catch(() => {});
  const upd = {};
  for (const [id, b] of Object.entries(ws.bots || {})) {
    if (!Array.isArray(b?.channels) || !b.channels.includes(ch)) continue;
    const channels = b.channels.filter((c) => c !== ch);
    await kv().update(KEYS.bot(id), { channels }).catch(() => {});
    upd[`bots.${id}.channels`] = channels;
  }
  if (Object.keys(upd).length) await kv().update(KEYS.ws(ws.id), upd).catch(() => {});
}

/** Admins: create a webhook bound to one channel. The token is in this response and nowhere else. */
router.post('/api/ws/:ws/webhooks', route(async ({ params, request, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user, { write: true });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can create webhooks');
  const body = await readJson(request);
  const channel = own(ws.channels, String(body.channel || ''));
  // A private channel the caller is not in is no channel to them, admins
  // included (see botChannels): a webhook bound to it would post into it by
  // its id alone.
  if (!channel || (channel.private && !doc.channels.includes(channel.id))) fail(404, 'not_found', 'Channel not found');
  if (channel.archived) fail(403, 'archived', 'This channel is archived');
  if (isPartnerEntry(channel)) fail(400, 'shared', 'Integrations for a shared channel are set up on the workspace that hosts it');
  if (liveIntegrations(ws) >= LIMITS.webhooksPerWorkspace) fail(400, 'limit', 'This workspace has the maximum number of integrations');
  const { name, color } = cleanIntegration(body);
  const t = await mintToken('tch');
  const rec = { ws: ws.id, ch: channel.id, name, color, hash: t.hash, createdBy: id.uuid, createdAt: now() };
  await kv().set(KEYS.hook(t.id), rec);
  await kv().update(KEYS.ws(ws.id), { [`webhooks.${t.id}`]: { ch: channel.id, name, color, createdBy: id.uuid, createdAt: rec.createdAt, lastUsed: null } });
  await bumpWorkspace(ws.id);
  return { id: t.id, token: t.token, url: `/webhook/${t.token}`, name, color, channel: channel.id };
}));

router.get('/api/ws/:ws/webhooks', route(async ({ params, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user);
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can see integrations');
  // An entry with no channel (a bot with no name) is the trace of a call
  // that noted its "last used" under an integration revoked, or whose
  // channel was deleted, while the call was in flight: the path write put
  // the entry back with that one field, and the list showed a nameless
  // integration for "#?". It stands for nothing (its record is gone, so its
  // token is refused) and goes here, where it would otherwise be seen. Left
  // out of the list on every copy; taken off the document only where the
  // copy takes writes (see assertWritable, and the pinned list's tidying):
  // a copy that has moved to another server is read-only from then on, one
  // being moved takes no writes for the length of the move, and one still
  // being imported is written from the archive alone.
  const sound = (v, has) => !!(v && typeof v === 'object' && v[has]);
  const stale = [
    ...Object.entries(ws.webhooks || {}).filter(([, h]) => !sound(h, 'ch')).map(([hid]) => `webhooks.${hid}`),
    ...Object.entries(ws.bots || {}).filter(([, b]) => !sound(b, 'name')).map(([bid]) => `bots.${bid}`),
  ];
  if (stale.length && !ws.movedTo && !ws.importing && !frozen(ws)) await kv().remove(KEYS.ws(ws.id), ...stale).catch(() => {});
  const list = (map, has) => Object.entries(map || {}).filter(([, v]) => sound(v, has)).map(([hid, h]) => ({ id: hid, ...h }));
  // A private channel the caller is not in is no channel to them (see
  // botChannels): a webhook bound to one is listed without it, marked as
  // one to a private channel, and a bot is listed with the channels the
  // caller can see, and how many are kept from them, so the list does not
  // read "no channels" for a bot that is in some.
  const webhooks = list(ws.webhooks, 'ch').map((h) => (hiddenFrom(ws, doc, h.ch) ? { ...h, ch: null, private: true } : h));
  const bots = list(ws.bots, 'name').map((b) => {
    const all = Array.isArray(b.channels) ? b.channels : [];
    const shown = all.filter((c) => !hiddenFrom(ws, doc, c));
    return shown.length === all.length ? b : { ...b, channels: shown, hidden: all.length - shown.length };
  });
  return { webhooks, bots };
}));

/** Rotate the secret (the old token dies) or revoke. */
router.post('/api/ws/:ws/webhooks/:id/rotate', route(async ({ params, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user, { write: true });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can rotate webhooks');
  const hook = own(ws.webhooks, params.id);
  if (!hook) fail(404, 'not_found', 'Webhook not found');
  // A fresh token posts into the channel: not for an admin the channel is hidden from (see botChannels).
  if (hiddenFrom(ws, doc, hook.ch)) fail(403, 'forbidden', 'This webhook posts to a private channel you are not in; an admin in it can rotate its token');
  const secret = uid(32);
  await kv().update(KEYS.hook(params.id), { hash: await sha256(secret) });
  // The minute's count goes with the old secret. Kept under the id, as it
  // used to be, the calls a runaway script (or whoever had got hold of the
  // token) had made stood against the fresh token, which was refused for
  // the rest of the minute as the old one had been: a rotation made to stop
  // the misuse left the integration itself shut out.
  await kv().del(hookRateKey(params.id)).catch(() => {});
  return { id: params.id, token: `tch_${params.id}_${secret}` };
}));

router.delete('/api/ws/:ws/webhooks/:id', route(async ({ params, user }) => {
  const { id, ws, member } = await requireMembership(params.ws, user, { write: true, doc: false });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can revoke webhooks');
  if (!own(ws.webhooks, params.id)) fail(404, 'not_found', 'Webhook not found');
  await kv().del(KEYS.hook(params.id));
  await kv().remove(KEYS.ws(ws.id), `webhooks.${params.id}`);
  await bumpWorkspace(ws.id);
  return { ok: true };
}));

/** The webhook itself: no session, the token is the credential, one channel, write only. */
router.post('/webhook/:token', route(async ({ params, request }) => {
  const { id, rec } = await authToken(params.token, 'tch');
  const body = await readSmallJson(request);
  const ws = await kv().get(KEYS.ws(rec.ws));
  const channel = ws?.channels?.[rec.ch];
  if (!ws || !channel) fail(404, 'not_found', 'The channel this webhook posts to is gone');
  assertTokenWritable(ws); // the workspace moved: this copy is read-only, and the message would be lost
  if (channel.archived) fail(403, 'archived', 'This channel is archived');
  const out = await postAsBot(rec.ws, rec.ch, botAuthor('hook', id), rec, integrationText(body), audienceOf({ channel }), ws);
  await noteTokenUse(ws, 'webhooks', id);
  return { ok: true, ...out };
}));

/**
 * "Last used" on an integration, for the admins' list. It lives on the
 * workspace document (members, channels, all of it), and a token may post
 * sixty times a minute: written on every call, the busiest route with no
 * session behind it rewrote that whole document each time. Once a minute is
 * as fine as the list shows.
 */
const TOKEN_USE_EVERY_MS = 60_000;
async function noteTokenUse(ws, field, id) {
  const last = Number(ws?.[field]?.[id]?.lastUsed) || 0;
  if (now() - last < TOKEN_USE_EVERY_MS) return;
  // Awaited: work left running after the answer is not sure to land.
  await kv().update(KEYS.ws(ws.id), { [`${field}.${id}.lastUsed`]: now() }).catch(() => {});
}
router.get('/webhook/:token', route(async () => fail(405, 'method_not_allowed', 'Webhooks accept POST only; they cannot read anything')));

/* ---- bot tokens: post to and read the channels it is added to ------------ */

/**
 * The channels a bot may be given: this workspace's own (a shared channel's
 * entry is not one; its integrations are set up on the host), each once,
 * whatever the request repeated. A list stored as it came carried a channel
 * twice or three times over, and the admins' dialog drew it that many times.
 * A private channel the admin is not in is no channel to them (as the
 * edit, the invite and the delete routes have it, and as the bootstrap
 * hides it): a bot with it on its list would read the channel for them, or
 * post into it, by its id alone, so it is dropped from the list as a
 * channel that is not there.
 */
const botChannels = (ws, doc, list) => [...new Set((Array.isArray(list) ? list : []).map(String))]
  .filter((c) => own(ws.channels, c) && !isPartnerEntry(ws.channels[c]) && !hiddenFrom(ws, doc, c));

/** Is this channel a private one the caller is not in: no channel to them, whatever their role (see botChannels)? */
const hiddenFrom = (ws, doc, c) => !!own(ws.channels, c)?.private && !doc.channels.includes(c);

router.post('/api/ws/:ws/bots', route(async ({ params, request, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user, { write: true });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can create bot tokens');
  const body = await readJson(request);
  if (liveIntegrations(ws) >= LIMITS.webhooksPerWorkspace) fail(400, 'limit', 'This workspace has the maximum number of integrations');
  const { name, color } = cleanIntegration(body);
  const scopes = (Array.isArray(body.scopes) ? body.scopes : ['post']).filter((x) => BOT_SCOPES.includes(x));
  if (!scopes.length) fail(400, 'invalid', 'Pick at least one scope');
  const channels = botChannels(ws, doc, body.channels);
  const t = await mintToken('tcb');
  const rec = { ws: ws.id, name, color, hash: t.hash, scopes, channels, createdBy: id.uuid, createdAt: now() };
  await kv().set(KEYS.bot(t.id), rec);
  await kv().update(KEYS.ws(ws.id), { [`bots.${t.id}`]: { name, color, scopes, channels, createdBy: id.uuid, createdAt: rec.createdAt, lastUsed: null } });
  await bumpWorkspace(ws.id);
  return { id: t.id, token: t.token, name, color, scopes, channels };
}));

/** Change a bot's channels or scopes. */
router.put('/api/ws/:ws/bots/:id', route(async ({ params, request, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user, { write: true });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can change bots');
  if (!own(ws.bots, params.id)) fail(404, 'not_found', 'Bot not found');
  const body = await readJson(request);
  const patch = {};
  // The list as the caller sees it is what they change: a private channel
  // they are not in, already on the bot's list, is not shown to them (see
  // the list route), so it stays, rather than going because it was not sent.
  if (Array.isArray(body.channels)) {
    const kept = (ws.bots[params.id].channels || []).filter((c) => hiddenFrom(ws, doc, c));
    patch.channels = [...botChannels(ws, doc, body.channels), ...kept];
  }
  if (Array.isArray(body.scopes)) {
    patch.scopes = body.scopes.filter((x) => BOT_SCOPES.includes(x));
    if (!patch.scopes.length) fail(400, 'invalid', 'Pick at least one scope');
  }
  if (!Object.keys(patch).length) fail(400, 'invalid', 'Nothing to change');
  await kv().update(KEYS.bot(params.id), patch);
  await kv().update(KEYS.ws(ws.id), Object.fromEntries(Object.entries(patch).map(([k, v]) => [`bots.${params.id}.${k}`, v])));
  await bumpWorkspace(ws.id);
  return { ok: true };
}));

router.post('/api/ws/:ws/bots/:id/rotate', route(async ({ params, user }) => {
  const { id, ws, member, doc } = await requireMembership(params.ws, user, { write: true });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can rotate bot tokens');
  if (!own(ws.bots, params.id)) fail(404, 'not_found', 'Bot not found');
  // A fresh token reads, or posts into, every channel on the bot's list: not
  // for an admin one of them is hidden from (see botChannels).
  if ((ws.bots[params.id].channels || []).some((c) => hiddenFrom(ws, doc, c))) fail(403, 'forbidden', 'This bot is in a private channel you are not in; an admin in it can rotate its token');
  const secret = uid(32);
  await kv().update(KEYS.bot(params.id), { hash: await sha256(secret) });
  // The minute's count goes with the old secret, as a webhook's does (see its rotate).
  await kv().del(hookRateKey(params.id)).catch(() => {});
  return { id: params.id, token: `tcb_${params.id}_${secret}` };
}));

router.delete('/api/ws/:ws/bots/:id', route(async ({ params, user }) => {
  const { id, ws, member } = await requireMembership(params.ws, user, { write: true, doc: false });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can revoke bot tokens');
  if (!own(ws.bots, params.id)) fail(404, 'not_found', 'Bot not found');
  await kv().del(KEYS.bot(params.id));
  await kv().remove(KEYS.ws(ws.id), `bots.${params.id}`);
  await bumpWorkspace(ws.id);
  return { ok: true };
}));

/**
 * A bot's view of a channel: only channels it was added to, only with the
 * scope. Reading a moved workspace still works, like any member's read;
 * posting and reacting answer 423 like every other write.
 */
async function botChannel(params, scope) {
  const { id, rec } = await authToken(params.token, 'tcb');
  if (!rec.scopes.includes(scope)) fail(403, 'forbidden', `This token has no ${scope} scope`);
  if (!rec.channels.includes(params.ch)) fail(404, 'not_found', 'This bot is not in that channel');
  const ws = await kv().get(KEYS.ws(rec.ws));
  const channel = ws?.channels?.[params.ch];
  if (!ws || !channel) fail(404, 'not_found', 'Channel not found');
  // Members are refused until the import finishes; a token is too, so its
  // posts do not interleave with the history being written (see assertTokenWritable).
  if (scope !== 'read') assertTokenWritable(ws);
  return { id, rec, ws, channel };
}

router.post('/bot/:token/channels/:ch/messages', route(async ({ params, request }) => {
  const { id, rec, ws, channel } = await botChannel(params, 'post');
  if (channel.archived) fail(403, 'archived', 'This channel is archived');
  const body = await readSmallJson(request);
  const out = await postAsBot(rec.ws, params.ch, botAuthor('bot', id), rec, integrationText(body), audienceOf({ channel }), ws);
  await noteTokenUse(ws, 'bots', id);
  return { ok: true, ...out };
}));

router.get('/bot/:token/channels/:ch/messages', route(async ({ params, request }) => {
  await botChannel(params, 'read');
  return fetchMessages(params.ch, query(request));
}));

router.post('/bot/:token/channels/:ch/messages/:seq/reactions', route(async ({ params, request }) => {
  const { id, rec, ws, channel } = await botChannel(params, 'react');
  // Closed to reactions as it is to posts, for a token as for a member.
  if (channel.archived) fail(403, 'archived', 'This channel is archived');
  const body = await readSmallJson(request);
  if (!isReactionKey(body.reaction)) fail(400, 'invalid', 'Unknown reaction');
  const seq = Number(params.seq);
  const found = await locateMessage(params.ch, seq);
  if (!found || found.overlay.d) fail(404, 'not_found', 'Message not found');
  // A line the worker wrote takes no reaction from a token either (see the member route).
  if (found.raw.k === 'sys') fail(400, 'invalid', 'System lines take no reactions');
  const path = `x.${overlayKey(seq)}.r.${body.reaction}.${botAuthor('bot', id)}`;
  const current = found.overlay.r || {};
  const has = !!current[body.reaction]?.[botAuthor('bot', id)];
  const on = typeof body.on === 'boolean' ? body.on : !has;
  // The same cap as a member's: a token must not be a way to bloat a block.
  const under = (users) => (users ? Object.keys(users).length : 0);
  const distinct = Object.values(current).filter(under).length;
  if (on && !has && !under(current[body.reaction]) && distinct >= REACTIONS_PER_MESSAGE) {
    fail(400, 'limit', `A message can carry up to ${REACTIONS_PER_MESSAGE} different reactions`);
  }
  if (on && !has && Object.values(current).reduce((sum, users) => sum + Object.keys(users || {}).length, 0) >= REACTORS_PER_MESSAGE) {
    fail(400, 'limit', 'This message has as many reactions as it can carry');
  }
  // Nor onto a block with no room left for another name (see
  // assertBlockRoom): the member route refuses there, and a token's reaction
  // let through grew the block toward what the store holds, where every
  // small write to its fifty messages (a pin, a deletion, a reply's count)
  // would then fail with no word to anyone.
  if (on && !has) assertBlockRoom(found.block, 120, 'This message cannot take more reactions');
  // Empty entries come off once the message has carried its count of kinds, as on the member route.
  if (on && !has && Object.keys(current).length >= REACTIONS_PER_MESSAGE) {
    const dead = Object.keys(current).filter((k) => k !== body.reaction && !under(current[k]));
    if (dead.length) await kv().remove(found.key, ...dead.map((k) => `x.${overlayKey(seq)}.r.${k}`)).catch(() => {});
  }
  if (on && !has) await kv().update(found.key, { [path]: 1 });
  else if (!on && has) {
    // The token's own name alone, as the member route has it: every reader
    // passes over a reaction nobody is under, and taking the whole entry
    // wiped a member's same reaction landing in between (see that route).
    await kv().remove(found.key, path);
  } else {
    // The message already carries what was asked for (a call repeated, a
    // script behind on what it had done): nothing is written, and the
    // conversation's stamp is left where it was, as the member route leaves
    // it, since moving it would have every open tab of every member here
    // re-read its window for a change that never happened.
    return { ok: true, on };
  }
  await touchConv(rec.ws, params.ch, now(), { audience: audienceOf({ channel }), ws, seq, patch: { r: body.reaction, ru: botAuthor('bot', id), on: on ? 1 : 0 } });
  return { ok: true, on };
}));

/* ---- export, import, transfer ------------------------------------------- */

const EXPORT_BLOCKS = 12;
/** Conversations with nothing in them one export page passes over before handing back its cursor (see counterReader). */
const EXPORT_SKIP_CONVS = 120;
/** Conversations one export walks, and how long its list is kept for the cursor to name. */
const EXPORT_MAX_CONVS = 5000;
const EXPORT_LIST_TTL_S = 86400;
const IMPORT_CHUNK = 500;
// The highest message number an archive may name. A counter is walked
// block by block by export, reindex and the workspace's deletion, so one
// set to a trillion from a malformed archive would leave a workspace that
// cannot be deleted; ten million messages in one conversation is far past
// anything a workspace on one worker holds.
const IMPORT_MAX_SEQ = 10_000_000;
/** The counter an import claims a workspace id with, for the moment before its document is written (see /api/workspaces/import); deleted with the workspace. */
const importClaimKey = (wsId) => `tc:ws:${wsId}:import-claim`;

/**
 * Export a workspace, a page at a time. The first call (no cursor) returns
 * the header: workspace document minus secrets, members, channels, pins,
 * the list of conversations to walk; every call returns up to EXPORT_BLOCKS
 * blocks of merged messages and the attachments they reference, plus the
 * cursor to continue with. Admins only. Threads are discovered as their
 * parents are walked, like the search backfill.
 */
router.get('/api/ws/:ws/export', route(async ({ params, request, user }) => {
  const id = await identify(user);
  const q = query(request);
  // The admin's own document is read with the first page, whose reading of
  // every member's it seeds (see memberDocsReader); a page named by a cursor
  // looks at nothing of it, and read it for every page all the same, a
  // round trip per page over the hundreds an export of a large workspace runs to.
  const { ws, member, doc } = await requireMembership(params.ws, id.uuid, { doc: !q.get('cursor') });
  if (!isAdmin(member)) fail(403, 'forbidden', 'Only admins can export a workspace');
  // The list of conversations to walk is kept in the worker, under a token
  // the cursor names, never taken from the cursor itself: conversation keys
  // carry no workspace, so a list the caller could write would let an admin
  // of one workspace read out any other on this worker.
  let cursor = null;
  let listKey = null;
  let listChanged = false;
  if (q.get('cursor')) {
    try {
      cursor = JSON.parse(q.get('cursor'));
    } catch {
      fail(400, 'invalid', 'Bad cursor');
    }
    if (!cursor || typeof cursor.k !== 'string' || !/^[a-z0-9]{12}$/.test(cursor.k) || !Number.isInteger(cursor.i) || !Number.isInteger(cursor.n) || cursor.i < 0 || cursor.n < 0) {
      fail(400, 'invalid', 'Bad cursor');
    }
    listKey = KEYS.exportList(ws.id, cursor.k);
    const list = await kv().get(listKey);
    if (!list || !Array.isArray(list.convs)) fail(410, 'expired', 'This export has expired; start it again');
    cursor.convs = list.convs;
  }
  const out = {};
  const pages = [];
  const files = [];
  if (!cursor) {
    // Every member's document, the caller's being the one their membership
    // was read with (see memberDocsReader): read again among the rest, as it
    // used to be, the same key was read twice in one request.
    const ids = Object.keys(ws.members).slice(0, 500);
    const byId = await memberDocsReader(ws, { uuid: id.uuid, doc })();
    const docs = ids.map((u) => byId.get(u));
    const convs = new Set(Object.keys(ws.channels));
    const dms = {};
    docs.forEach((d) => { for (const [c, v] of Object.entries(d?.dms || {})) { convs.add(c); dms[c] = v; } });
    const channels = {};
    for (const [cid, c] of Object.entries(ws.channels)) {
      const { guestInvite, guestInviteExp, connectInvite, connectInviteExp, ...rest } = c;
      channels[cid] = rest;
    }
    const pins = {};
    const pinDocs = await getMany([...convs].map((c) => KEYS.pins(ws.id, c)));
    [...convs].forEach((c, i) => { if (pinDocs[i]?.items?.length) pins[c] = pinDocs[i].items; });
    // What is waiting to go out or to come due, minus the claims of a
    // delivery in progress: a transfer leaves this copy read-only, where
    // nothing is delivered, so what waits here waits in the copy instead.
    const queue = (await kv().get(KEYS.sched(ws.id))) || { m: {} };
    const sched = Object.values(queue.m || {}).map(({ claims, claimedAt, tries, retryAt, ...e }) => e);
    // The files the channels' bookmarks point at, and the ones the queue's
    // messages will carry when they go out, are files of the workspace too,
    // though no message carries them yet: named here, since the list of
    // files is otherwise built from the messages walked, so the client that
    // writes the export to a drive or moves it to another server copies them
    // with the rest. (Without the queue's, a message scheduled with a file
    // arrived on the copy without it, and one that was a file alone never
    // arrived: the post refuses files the workspace does not hold.) Only
    // this workspace's (a bookmark keeps pointing at a file that was taken
    // elsewhere); a file in messages as well is listed again by its page, as
    // a file forwarded twice is.
    const fileId = (f) => (/^[a-z0-9]{8,24}$/.test(String(f || '')) ? String(f) : null);
    const inBookmarks = new Set(Object.values(channels).flatMap((c) => (Array.isArray(c.bookmarks) ? c.bookmarks : []).map((b) => fileId(b?.file)).filter(Boolean)));
    // The queue's files are named for the entries the copy will hold, as
    // the import admits them: one waiting for someone from a connected
    // workspace (their connection does not travel, so nor do they), for a
    // sample person, or for an author who is no member here any more is
    // left out of the copy, and its file, copied all the same, sat in the
    // new owner's drive held by nothing, with nothing to find it by.
    const carried = (e) => {
      const m = own(ws.members, String(e?.u || ''));
      return !!m && !isExternal(m) && !String(e.u).startsWith('smp_');
    };
    const inQueue = new Set(sched.filter(carried).flatMap((e) => (Array.isArray(e.attachments) ? e.attachments : []).map((a) => fileId(a?.id)).filter(Boolean)));
    const marked = [...new Set([...inBookmarks, ...inQueue])];
    if (marked.length) {
      const metas = await getMany(marked.map((f) => KEYS.file(f)));
      metas.forEach((meta, i) => {
        if (!meta || meta.ws !== ws.id) return;
        files.push({ id: marked[i], name: meta.name, size: meta.size, type: meta.type, ...(inBookmarks.has(marked[i]) ? { bookmark: true } : {}), ...(inQueue.has(marked[i]) ? { sched: true } : {}) });
      });
    }
    out.header = {
      format: 'teamchat-export', version: 1, exportedAt: now(), exportedBy: id.uuid,
      workspace: { id: ws.id, name: ws.name, owner: ws.owner, createdAt: ws.createdAt, sample: !!ws.sample, unfurl: ws.unfurl !== false },
      channels, members: ws.members, dms, pins,
      sched: sched.length ? sched : undefined,
      // The people who left, by name: what keeps their messages attributed
      // once the archive is a workspace again.
      former: ws.former || undefined,
      memberDocs: Object.fromEntries(ids.map((u, i) => [u, { channels: docs[i]?.channels || [], dms: docs[i]?.dms || {}, reads: docs[i]?.reads || {}, notify: docs[i]?.notify || {} }])),
    };
    cursor = { k: uid(12), convs: [...convs], i: 0, n: 0 };
    listKey = KEYS.exportList(ws.id, cursor.k);
    listChanged = true;
  }
  let budget = EXPORT_BLOCKS;
  const known = new Set(cursor.convs);
  // The counters a dozen ahead at a time, and so many empty conversations
  // passed over before the page hands back its cursor (see counterReader):
  // the next page goes on from there, and the client loops until `done`.
  const counterOf = counterReader(cursor.convs);
  let passed = 0;
  while (budget > 0 && cursor.i < cursor.convs.length && passed < EXPORT_SKIP_CONVS) {
    const conv = cursor.convs[cursor.i];
    const seq = await counterOf(cursor.i);
    if (!seq) {
      cursor.i++;
      cursor.n = 0;
      passed++;
      continue;
    }
    const head = blockIndexOf(seq);
    const to = Math.min(head, cursor.n + budget - 1);
    const keys = [];
    for (let n = cursor.n; n <= to; n++) keys.push(KEYS.block(conv, n));
    const blocks = await getMany(keys);
    const messages = [];
    // A block closed early (see rollBlock: `full` on the block, and the
    // numbers after its last record, deleted ones included, that stand for
    // no message) is named to the copy with the number its records end at,
    // so the import closes its own the same way. Carried as its messages
    // alone, as it used to be, the copy's block was open and the run was a
    // hole: a reader more than a block behind kept a badge over numbers no
    // message stood under, and every reader's app counted the run as unread
    // until the conversation was opened.
    const closed = [];
    blocks.forEach((b, i) => {
      const n = cursor.n + i;
      if (Number(b?.full) > 0) closed.push({ block: n, after: Math.max(firstSeqOfBlock(n) - 1, ...(Array.isArray(b.m) ? b.m : []).map((x) => Number(x?.s) || 0)) });
      for (const m of mergeBlock(b)) {
        if (m.replyCount > 0) {
          const t = threadConvId(conv, m.seq);
          if (!known.has(t) && cursor.convs.length < EXPORT_MAX_CONVS) {
            known.add(t);
            cursor.convs.push(t);
            listChanged = true;
          }
        }
        for (const a of m.attachments || []) files.push({ id: a.id, name: a.name, size: a.size, type: a.type, conv, seq: m.seq });
        messages.push(m);
      }
    });
    // The blocks the page covers (`from`..`to`): the import closes the
    // counter's block where the page covering it has no message past a
    // number (see the import route); `to` says the page covers it even where
    // the block holds no message that stands. And the blocks the original
    // closed early (`closed`), for the import to close the same way.
    pages.push({ conv, seq, from: cursor.n, to, messages, ...(closed.length ? { closed } : {}) });
    budget -= keys.length;
    cursor.n = to + 1;
    if (cursor.n > head) {
      cursor.i++;
      cursor.n = 0;
    }
  }
  const done = cursor.i >= cursor.convs.length;
  if (done) {
    if (q.get('cursor')) await kv().del(listKey).catch(() => {});
  } else if (listChanged) {
    // The list lives a day: long enough for any export, and gone on its own
    // if the client never finishes.
    await kv().set(listKey, { convs: cursor.convs });
    await kv().expire(listKey, EXPORT_LIST_TTL_S).catch(() => {});
  }
  const total = cursor.convs.length;
  return { ...out, pages, files, cursor: done ? null : { k: cursor.k, i: cursor.i, n: cursor.n }, done, progress: { done: Math.min(cursor.i, total), total } };
}));

/*
 * What an archive may carry. An export is JSON the importing admin picked
 * from a drive, so nothing in it is taken at its word: every field is
 * admitted only in the shape the app itself writes, since it is rendered
 * to every member afterwards (a preview's link becomes an href, a reaction
 * key a path segment, a member card a name on screen).
 */
const ID_RE = /^[\w-]{1,64}$/;
const CONV_RE = /^[a-z0-9_]{1,64}$/;
/**
 * A name every object inherits (`constructor`, `__proto__`, `toString`) is
 * never an id, and an archive that uses one as a key must not have it taken
 * for one: looked up, it passes for an entry that is not there (a member
 * document was given "constructor" as a channel), and written as a path it
 * makes one (the removal of that member then counted a channel by that name
 * into the workspace document, a nameless one every member was shown). Nor
 * may it be taken for one as a value: an author, a mention, the maker of a
 * pin or a channel, a direct message's member, a file's owner. The clients
 * look those up on the member map, where "constructor" is a function whose
 * name is "Object", and drew a line by an author of that name; the members
 * of a direct message named one nobody could be.
 */
const inherited = (k) => Object.hasOwn(Object.prototype, k);
const isId = (u) => ID_RE.test(u) && !inherited(u);

function cleanImportedMember(m, uuid) {
  const card = profilePatch(m);
  return {
    username: cleanText(m.username, 40).toLowerCase() || uuid.slice(0, 12),
    name: card.name || cleanText(m.username, LIMITS.displayName) || 'Member',
    title: card.title || '',
    color: card.color || colorSlot(uuid),
    avatar: Number.isFinite(m.avatar) && m.avatar > 0 ? m.avatar : null,
    status: card.status || null,
    joinedAt: Number(m.joinedAt) || null,
  };
}

/**
 * A channel as the archive carries it, admitted field by field. `known` is
 * the copy's member map: a private channel's list is cut to the people who
 * are in the copy, since someone from a connected workspace is on the
 * original's list and not in the copy (their connection does not travel),
 * and the copy has no route that would ever take them off it.
 */
function cleanImportedChannel(c, cid, known = null) {
  const out = {
    id: cid,
    name: cleanChannelName(c.name) || `channel-${cid.slice(0, 6)}`,
    // The topic, the description and the bookmark labels as the channel
    // routes admit them (see cleanLine): a description keeps its line breaks.
    topic: cleanLine(c.topic, LIMITS.channelTopic),
    private: !!c.private,
    def: !!c.def,
    createdBy: isId(String(c.createdBy || '')) ? c.createdBy : null,
    createdAt: Number(c.createdAt) || null,
    count: Math.max(0, Math.floor(Number(c.count) || 0)),
  };
  if (c.description) out.description = cleanLine(c.description, LIMITS.channelDescription);
  if (c.archived) out.archived = true;
  if (Number(c.guests) > 0) out.guests = Math.floor(Number(c.guests));
  if (out.private) out.members = (Array.isArray(c.members) ? c.members : []).filter((u) => ID_RE.test(String(u)) && (!known || own(known, u))).slice(0, 500);
  if (POST_POLICIES.includes(c.postPolicy)) out.postPolicy = c.postPolicy;
  if (THREAD_POLICIES.includes(c.threadPolicy)) out.threadPolicy = c.threadPolicy;
  if (BROADCAST_POLICIES.includes(c.broadcast)) out.broadcast = c.broadcast;
  if (Array.isArray(c.bookmarks)) {
    out.bookmarks = c.bookmarks.slice(0, LIMITS.bookmarksPerChannel).map((b) => {
      const label = cleanLine(b?.label, LIMITS.bookmarkLabel);
      if (!label) return null;
      const item = { id: /^[a-z0-9]{6,16}$/.test(String(b.id || '')) ? b.id : uid(8), label };
      if (typeof b.file === 'string' && /^[a-z0-9]{8,24}$/.test(b.file)) {
        item.file = b.file;
        item.name = typeof b.name === 'string' && b.name.trim() ? cleanFileName(b.name) : label;
      } else {
        // An address as the channel route admits one (see PUT /channels/:ch):
        // whole within its length, and carrying no control character. Cut to
        // the length, as it used to be, an address past it led somewhere
        // else, and one with a bidirectional mark in it (written before the
        // route refused them) turned around in the bar of the copy, so a
        // bookmark with either is left out, as one with no address is.
        const url = typeof b.url === 'string' ? b.url.trim() : '';
        if (url.length > LIMITS.bookmarkUrl || !/^https?:\/\/[^\s]+$/i.test(url) || URL_CONTROLS_RE.test(url)) return null;
        item.url = url;
      }
      return item;
    }).filter(Boolean);
  }
  return out;
}

/** { uuid: 0|1 } maps: reaction members, thread followers. */
function cleanUserFlags(map, allowed = [1]) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [u, v] of Object.entries(map)) if (isId(u) && allowed.includes(v)) out[u] = v;
  return out;
}

function cleanImportedReactions(r) {
  const out = {};
  if (!r || typeof r !== 'object') return out;
  for (const [k, users] of Object.entries(r)) {
    if (!isReactionKey(k)) continue;
    const m = cleanUserFlags(users);
    if (Object.keys(m).length) out[k] = m;
  }
  return out;
}

/**
 * A message's time as an archive carries it: a moment that has passed (a
 * day's leeway for the clocks of two servers), else the moment it is written
 * here. Every message of a live workspace is stamped by its server as it is
 * posted, so an export never carries a time ahead of the import; one that
 * does (a messages.json edited by hand, a field damaged in transit) is not a
 * time at all. Taken as it came, as it used to be, a message dated a trillion
 * seconds hence was drawn under a day divider in the year 5138, and its
 * search entry went into a month that is no month ("NaNNaN", from a Date
 * past what a Date can be): a shard no query reads, since the index lists
 * its months by their shape, and no rebuild takes down, so the message could
 * not be found by any word in it and the key stayed for good.
 */
const IMPORT_TIME_MARGIN_MS = 86_400_000;
function importedTime(raw) {
  const ts = Math.floor(Number(raw));
  return Number.isFinite(ts) && ts > 0 && ts <= now() + IMPORT_TIME_MARGIN_MS ? ts : now();
}

/** A stored preview: the link must be one the app would have unfurled, the image a hash it serves. */
function cleanImportedUnfurl(u) {
  if (!u || typeof u !== 'object') return null;
  const url = typeof u.url === 'string' && /^https?:\/\/[^\s<>"']+$/i.test(u.url) ? u.url.slice(0, 2000) : null;
  if (!url || isAppLink(url)) return null;
  const image = typeof u.image === 'string' && /^[0-9a-f]{64}$/.test(u.image) ? u.image : null;
  return { url, title: cleanText(u.title, 200), desc: cleanText(u.desc, 400), site: cleanText(u.site, 80), image, kind: u.kind === 'image' ? 'image' : 'page', ts: Number(u.ts) || now() };
}

/**
 * Conversation keys (`tc:conv:{id}:...`) carry no workspace, so an import
 * may only ever write conversations that are its own: a channel id the
 * archive names that is already in use on this worker (another workspace's
 * channel, or the original of a copy made on the same server) would
 * otherwise have the copy's history merged into it, and deleting either
 * workspace would take the other's messages with it. Such a channel gets a
 * fresh id, and a direct message's id is derived from the new workspace as
 * `POST /dms` would derive it, so nobody can plant a conversation under an
 * id another workspace's members will later open. The translation is kept
 * on the workspace for the pages that follow and dropped at finish.
 */
async function convInUse(conv) {
  return !!(await kv().get(KEYS.block(conv, 0))) || (await kv().get(KEYS.seq(conv))) != null;
}

/** The id a conversation of an import is stored under here: mapped, thread ids following their parent. */
function importedConv(map, conv) {
  if (!map) return conv;
  const t = parentOfThread(conv);
  if (t) {
    // A thread id that is not the one spelling is left as it is, for the check that refuses it.
    if (threadConvId(t.conv, t.seq) !== conv) return conv;
    const parent = own(map, t.conv);
    return parent ? threadConvId(parent, t.seq) : conv;
  }
  return own(map, conv) || conv;
}

/**
 * Import, step one: create the workspace on this worker from an archive
 * header, with its ids intact where possible (the workspace id itself is
 * kept when free, so old permalinks keep their shape), members carried
 * across with their roles, channels, pins, and notification settings. The
 * caller becomes the owner; the previous owner keeps admin. The workspace
 * is marked `importing` until step three, and refuses writes until then.
 */
router.post('/api/workspaces/import', route(async ({ request, user }) => {
  const id = await identify(user);
  await assertMayCreate(id.uuid);
  const body = await readJson(request);
  const profile = await ensureProfile(id, body.profile);
  const h = body.header;
  if (!h || h.format !== 'teamchat-export' || !h.workspace || !h.channels || !h.members) fail(400, 'invalid', 'That is not a Teamchat export');
  if ((await workspacesOf(profile)) >= 20) fail(400, 'limit', 'You are in the maximum number of workspaces');
  let wsId = /^[a-z0-9]{6,20}$/.test(String(h.workspace.id)) ? h.workspace.id : uid(10);
  const ts = now();
  // As many as a workspace holds (500 members, 200 channels): each costs
  // the owner a document, and an archive is whatever the admin picked.
  const members = {};
  for (const [u, m] of Object.entries(h.members).slice(0, 500)) {
    if (!isId(u) || !m || typeof m !== 'object') continue;
    // People from connected workspaces belong to the connections, which do
    // not travel: the new copy starts unshared, and can be shared again.
    if (m.role === 'external') continue;
    members[u] = { ...cleanImportedMember(m, u), role: m.role === 'owner' ? 'admin' : (['admin', 'member', 'guest'].includes(m.role) ? m.role : 'member') };
  }
  members[id.uuid] = { ...(members[id.uuid] || memberRecord(profile, 'owner')), role: 'owner' };
  // The people who had left, by name, so what they wrote keeps its author:
  // admitted in the shape rememberFormer writes and bounded as it bounds
  // them, the most recent departures kept. Someone the archive still lists
  // as a member is not a former one.
  const former = {};
  const formerAll = h.former && typeof h.former === 'object' ? Object.entries(h.former) : [];
  // People from connected workspaces are not in the copy, and what they
  // wrote keeps its author the way a disconnect keeps it on the original:
  // by a card among those who left, with their workspace's name. Without
  // one, every line a partner's member wrote read "Former member" once the
  // workspace had moved.
  for (const [u, m] of Object.entries(h.members).slice(0, 500)) {
    if (m && typeof m === 'object' && m.role === 'external') formerAll.push([u, { username: m.username, name: m.name, color: m.color, at: ts, org: m.org }]);
  }
  formerAll.sort(([, a], [, b]) => (Number(b?.at) || 0) - (Number(a?.at) || 0));
  for (const [u, c] of formerAll) {
    if (Object.keys(former).length >= FORMER_MAX) break;
    if (!isId(u) || !c || typeof c !== 'object' || members[u] || own(former, u)) continue;
    const card = {
      username: cleanText(c.username, 40).toLowerCase() || u.slice(0, 12),
      name: cleanLine(c.name, LIMITS.displayName) || 'Former member',
      color: Number.isInteger(c.color) && c.color >= 1 && c.color <= 8 ? c.color : colorSlot(u),
      at: Number(c.at) || ts,
    };
    const org = c.org && typeof c.org === 'object' ? { name: cleanLine(c.org.name, LIMITS.workspaceName), ref: REF_RE.test(String(c.org.ref || '')) ? c.org.ref : null } : null;
    if (org?.name) card.org = org;
    former[u] = card;
  }
  const channels = {};
  const convMap = {}; // archive conversation id -> the id it is stored under here, where they differ
  // A name every object inherits is no channel id either (see isId):
  // "constructor" is the one that passes for one, and a channel by that
  // name had its people counted onto Object's own constructor, a function
  // with a one glued on where the count should have been. A partner entry
  // is a pointer at another workspace's channel, minus the secret that made
  // it work, and is not brought across.
  const entries = Object.entries(h.channels).slice(0, 200)
    .filter(([cid, c]) => /^[a-z0-9]{6,20}$/.test(cid) && !inherited(cid) && !!c && typeof c === 'object' && !isPartnerEntry(c));
  // Whether each id is in use here (see convInUse), read for all of them
  // together: asked one channel at a time, two reads each, the two hundred
  // channels a workspace may hold cost this one request four hundred round
  // trips to the store in a row before anything was written.
  const heads = await getMany(entries.flatMap(([cid]) => [KEYS.block(cid, 0), KEYS.seq(cid)]));
  const inUse = new Set(entries.filter((e, i) => !!heads[2 * i] || heads[2 * i + 1] != null).map(([cid]) => cid));
  // A fresh id for each channel whose own is in use: drawn for all of them
  // at once and checked together the same way (a draw in use here, or taken
  // by another channel of the copy, is drawn again; none ever is, at ten
  // characters of thirty-six). Drawn and checked one channel at a time, two
  // reads each in a row, as they used to be, a copy of a live workspace
  // restored beside it on the same server (its every channel id in use)
  // spent four hundred round trips to the store on its two hundred channels
  // before anything was written, past what the platform lets a request run.
  const usedIds = new Set(entries.map(([cid]) => cid));
  const taken = entries.filter(([cid]) => inUse.has(cid)).map(([cid]) => cid);
  for (let tries = 0; tries < 5 && taken.some((cid) => !own(convMap, cid)); tries++) {
    const pending = taken.filter((cid) => !own(convMap, cid));
    const drawn = pending.map(() => uid(10));
    const found = await getMany(drawn.flatMap((nid) => [KEYS.block(nid, 0), KEYS.seq(nid)]));
    pending.forEach((cid, i) => {
      const nid = drawn[i];
      if (found[2 * i] || found[2 * i + 1] != null || usedIds.has(nid)) return;
      usedIds.add(nid);
      convMap[cid] = nid;
    });
  }
  for (const cid of taken.filter((c) => !own(convMap, c))) {
    let nid;
    do nid = uid(10); while (usedIds.has(nid) || await convInUse(nid));
    usedIds.add(nid);
    convMap[cid] = nid;
  }
  for (const [cid, c] of entries) {
    const nid = own(convMap, cid) || cid;
    channels[nid] = cleanImportedChannel(c, nid, members);
  }
  if (!Object.keys(channels).length) fail(400, 'invalid', 'The export has no channels');
  const mapped = (conv) => importedConv(convMap, conv);
  // Member documents: channels, direct messages, cursors, and notification choices, but no counters.
  const docs = h.memberDocs && typeof h.memberDocs === 'object' ? h.memberDocs : {};
  // How many people each channel holds (and how many of them are guests) is
  // counted from the documents being brought across, not taken from the
  // counter the archive carries: people from connected workspaces are in
  // that counter and not in the copy (their connections do not travel), so
  // the copy's header said three where two were in, for good.
  const inChannel = {};
  const guestsIn = {};
  for (const u of Object.keys(members)) {
    const d = docs[u] || {};
    for (const c of new Set((Array.isArray(d.channels) ? d.channels : []).map((x) => mapped(String(x))))) {
      if (!own(channels, c)) continue;
      inChannel[c] = (inChannel[c] || 0) + 1;
      if (members[u].role === 'guest') guestsIn[c] = (guestsIn[c] || 0) + 1;
    }
  }
  for (const [cid, c] of Object.entries(channels)) {
    c.count = inChannel[cid] || 0;
    if (guestsIn[cid]) c.guests = guestsIn[cid];
    else delete c.guests;
  }
  // The id is taken only where no workspace stands under it, and only once:
  // two imports of one archive in the same instant (the same file picked in
  // two tabs) both found the id free and both made the workspace under it,
  // the second's document over the first's, their pages written into one
  // another's conversations, and the first to finish opened the copy to
  // writes while the other was still writing, whose next page was then
  // refused and the copy taken down as an import stopped short is. The id is
  // claimed with a counter here, moments before the document is written
  // under it, and the import that did not take the claim from nothing takes
  // a fresh id instead. The claim lives seconds, long enough for the winner's
  // document to be there for the next import's read to find, and goes with
  // the workspace when that is deleted (an import stopped short is taken
  // down and tried again at once, and keeps the archive's id on the retry);
  // a store that hands back no count is trusted once.
  const claim = async (id) => {
    const key = importClaimKey(id);
    const n = Number(await kv().incr(key).catch(() => 1));
    await kv().expire(key, 10).catch(() => {});
    return !(n > 1);
  };
  while ((await kv().get(KEYS.ws(wsId))) || !(await claim(wsId))) wsId = uid(10);
  const { code, exp } = await issueInvite(wsId);
  const ws = {
    // One-line names as the routes that write them here admit them (see cleanLine): the workspace's, and the former members' below.
    id: wsId, name: cleanLine(h.workspace.name, LIMITS.workspaceName) || 'Imported workspace', owner: id.uuid, invite: code, inviteExp: exp,
    // Where it came from: a workspace reference, or nothing (the field is
    // admitted in the one shape the app writes, like the rest of the archive).
    createdAt: Number(h.workspace.createdAt) || ts, importedAt: ts, importedFrom: REF_RE.test(String(body.from || '')) ? body.from : null, unfurl: h.workspace.unfurl !== false,
    search: indexStamp(), importing: true, channels, members,
    ...(Object.keys(former).length ? { former } : {}),
  };
  await kv().set(KEYS.ws(wsId), ws);
  await kv().set(KEYS.activity(wsId), { c: {}, p: {}, u: {}, w: ts });
  // The direct messages the archive names, kept on the workspace while the
  // import runs: step two writes conversation keys, which carry no
  // workspace, so it may only write the ones this import declared.
  const importDms = {};
  // A dozen writes at a time, as every fan-out here goes (see getMany and
  // holdFiles). One after another, as they used to be, the documents of a
  // full workspace's five hundred members, then a read and a write of each
  // one's account record, then a pinned list per conversation, ran to over a
  // thousand round trips to the store inside this one request, longer than
  // the platform lets a request run, so a large workspace's move or restore
  // stopped at "Creating the workspace" every time it was tried. The
  // documents are still made in order (a direct message's new id, made as
  // the first of its people is reached, names it for the rest), and only
  // written together.
  const memberDocs = [];
  for (const u of Object.keys(members)) {
    const d = docs[u] || {};
    const dms = {};
    for (const [c, v] of Object.entries(d.dms && typeof d.dms === 'object' ? d.dms : {})) {
      if (!CONV_RE.test(c) || !Array.isArray(v?.members)) continue;
      const people = [...new Set(v.members.map(String).filter(isId))].sort().slice(0, LIMITS.dmMembers);
      if (!people.length) continue;
      // The same people in this workspace: the id POST /dms would mint.
      const nid = dmConvId(people, wsId);
      if (nid !== c) convMap[c] = nid;
      dms[nid] = { members: people, createdAt: Number(v.createdAt) || ts };
      importDms[nid] = 1;
    }
    const reads = {};
    for (const [c, v] of Object.entries(d.reads && typeof d.reads === 'object' ? d.reads : {})) if (CONV_RE.test(c) && !inherited(c) && Number.isFinite(v)) reads[mapped(c)] = Math.max(0, Math.floor(v));
    const notify = {};
    for (const [c, v] of Object.entries(d.notify && typeof d.notify === 'object' ? d.notify : {})) {
      if (!CONV_RE.test(c) || inherited(c) || !v || typeof v !== 'object') continue;
      const n = {};
      if (NOTIFY_LEVELS.includes(v.level)) n.level = v.level;
      if (typeof v.mute === 'boolean') n.mute = v.mute;
      if (typeof v.follow === 'boolean') n.follow = v.follow;
      if (Object.keys(n).length) notify[mapped(c)] = n;
    }
    memberDocs.push([KEYS.member(wsId, u), {
      channels: (Array.isArray(d.channels) ? d.channels : []).map((c) => mapped(String(c))).filter((c) => own(channels, c)), dms, reads, mentions: {}, notify, joinedAt: members[u].joinedAt || ts,
    }]);
  }
  for (let i = 0; i < memberDocs.length; i += 12) await Promise.all(memberDocs.slice(i, i + 12).map(([key, doc]) => kv().set(key, doc)));
  const during = {};
  if (Object.keys(importDms).length) during.importDms = importDms;
  if (Object.keys(convMap).length) during.importMap = convMap;
  if (Object.keys(during).length) await kv().update(KEYS.ws(wsId), during);
  // Ensure this worker's user records list the workspace for members who
  // exist here. The importer's own record is left to the line below, which
  // must land (the pass is best effort): filed by both, as it used to be,
  // the workspace stood twice on their record, since the line judged by a
  // copy of the record read before the pass had filed it. Counted twice, it
  // brought them to the twenty workspaces one may be in a workspace early
  // for every archive they had brought across, and this server named the
  // workspace twice in its list of theirs.
  const people = Object.keys(members).filter((u) => !u.startsWith('smp_') && u !== id.uuid);
  const records = await getMany(people.map((u) => KEYS.user(u)));
  const unfiled = people.filter((u, i) => records[i] && !(records[i].workspaces || []).includes(wsId));
  for (let i = 0; i < unfiled.length; i += 12) await Promise.all(unfiled.slice(i, i + 12).map((u) => kv().add(KEYS.user(u), { workspaces: [wsId] }).catch(() => {})));
  if (!profile.workspaces.includes(wsId)) await kv().add(KEYS.user(id.uuid), { workspaces: [wsId] });
  // Each conversation's count of pinned messages goes on the activity
  // document with its list, as the pin route keeps it: the header's pin bar
  // and the details pane draw the count from there and show nothing at
  // nothing, so a moved workspace's pins were out of reach in every
  // conversation until someone pinned or unpinned something in it.
  const pinCounts = {};
  const pinLists = [];
  for (const [conv, items] of Object.entries(h.pins && typeof h.pins === 'object' ? h.pins : {})) {
    if (!CONV_RE.test(conv) || inherited(conv) || !Array.isArray(items)) continue;
    // Only the copy's own conversations take pins: a channel the archive
    // named and the copy did not make (an id it could not admit), or one it
    // never named, would otherwise get a pinned list and a pin count here
    // that nothing ever reaches or takes down.
    const pinned = mapped(conv);
    const base = parentOfThread(pinned)?.conv || pinned;
    if (!own(channels, base) && !own(importDms, base)) continue;
    const clean = items.filter((p) => p && Number.isInteger(p.seq) && p.seq >= 1).slice(0, LIMITS.pinsPerConversation)
      .map((p) => ({ seq: p.seq, by: isId(String(p.by || '')) ? p.by : id.uuid, ts: Number(p.ts) || ts }));
    if (!clean.length) continue;
    pinLists.push([KEYS.pins(wsId, mapped(conv)), { items: clean }]);
    pinCounts[`c.${mapped(conv)}.pc`] = new Set(clean.map((p) => p.seq)).size;
  }
  for (let i = 0; i < pinLists.length; i += 12) await Promise.all(pinLists.slice(i, i + 12).map(([key, doc]) => kv().set(key, doc)));
  const pinPaths = Object.entries(pinCounts);
  for (let i = 0; i < pinPaths.length; i += 100) await kv().update(KEYS.activity(wsId), Object.fromEntries(pinPaths.slice(i, i + 100)));
  // The scheduled messages and reminders that were waiting travel too: a
  // transfer leaves the old copy read-only, where nothing is ever delivered,
  // so without this every one of them in the workspace was gone with the
  // move. Each entry is admitted in the shape the routes write it, for a
  // member of the copy, into a conversation of it; one whose time has
  // passed is due, and the first poll once the copy is open delivers it
  // (nothing is delivered while the history is still being written).
  const queue = {};
  for (const e of (Array.isArray(h.sched) ? h.sched : []).slice(0, 5000)) {
    if (!e || typeof e !== 'object' || !/^[a-z0-9]{6,20}$/.test(String(e.id || '')) || !own(members, e.u) || String(e.u).startsWith('smp_')) continue;
    if (e.kind !== 'message' && e.kind !== 'reminder') continue;
    const conv = mapped(String(e.conv || ''));
    const base = parentOfThread(conv)?.conv || conv;
    if (!CONV_RE.test(conv) || (!own(channels, base) && !own(importDms, base))) continue;
    const dueAt = Math.floor(Number(e.dueAt));
    if (!Number.isFinite(dueAt) || dueAt > ts + SCHED_HORIZON_MS) continue;
    const entry = { id: e.id, kind: e.kind, u: e.u, conv, dueAt, createdAt: Number(e.createdAt) || ts };
    if (e.kind === 'reminder') {
      const seq = Math.floor(Number(e.seq));
      if (!Number.isInteger(seq) || seq < 1) continue;
      entry.seq = seq;
      entry.note = cleanLine(e.note, 120);
    } else {
      entry.text = cleanText(e.text, LIMITS.messageText);
      entry.attachments = (Array.isArray(e.attachments) ? e.attachments : []).filter((a) => a && /^[a-z0-9]{8,24}$/.test(String(a.id))).slice(0, LIMITS.attachmentsPerMessage).map((a) => ({ id: String(a.id) }));
      if (!entry.text && !entry.attachments.length) continue;
      // One refused at its time travels marked, as markFailed marks it: its
      // author was told it was not sent and that it was theirs to edit, move
      // or send. Brought across as merely due (its time long past), the
      // copy's first poll sent it on its own, into a channel opened again
      // since, with no word from the author; or refused it again and marked
      // it afresh, and the Later view showed it as waiting until then.
      if (e.failed && typeof e.failed === 'object') {
        entry.failed = {
          at: Number(e.failed.at) || ts,
          code: (typeof e.failed.code === 'string' && cleanLine(e.failed.code, 40)) || 'refused',
          message: (typeof e.failed.message === 'string' && cleanLine(e.failed.message, 200)) || 'This message could not be sent',
        };
      }
    }
    queue[e.id] = entry;
  }
  // As many of them as the queue holds (see SCHED_DOC_BYTES), soonest due
  // first. The original refuses a new entry only once its queue is at that
  // size, so a full queue carries a little more than the copy takes; brought
  // across whole or not at all, such a queue was dropped in silence, every
  // waiting message and reminder gone with the move, and the files those
  // messages were to carry landed here held by nothing. What does not fit
  // is counted in the answer, and its files are noted for the end of the
  // import to let go of (see releaseImportDropped), since the app sends them
  // along with the rest.
  const ordered = Object.values(queue).sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt);
  const kept = {};
  const dropped = [];
  let size = '{"m":{}}'.length;
  for (const e of ordered) {
    // `"id":{...}`, and a comma before it once another entry stands.
    const add = JSON.stringify(e.id).length + 1 + JSON.stringify(e).length + (Object.keys(kept).length ? 1 : 0);
    if (dropped.length || size + add > SCHED_DOC_BYTES) dropped.push(e);
    else {
      kept[e.id] = e;
      size += add;
    }
  }
  if (Object.keys(kept).length) {
    await kv().set(KEYS.sched(wsId), { m: kept });
    // The next due time, as recomputeNextDue would have it: a marked message is not due until its author acts on it.
    const times = Object.values(kept).filter((e) => !e.failed).map((e) => e.dueAt);
    if (times.length) await kv().update(KEYS.activity(wsId), { nd: Math.min(...times) });
  }
  if (dropped.length) {
    const held = new Set(Object.values(kept).flatMap((e) => (e.attachments || []).map((a) => a.id)));
    // Noted on the workspace document for the length of the import, so held
    // to a thousand ids: what is left past that is a bounded leak, and no
    // queue the archive holds drops that many files.
    const files = [...new Set(dropped.flatMap((e) => (e.attachments || []).map((a) => a.id)))].filter((f) => !held.has(f)).slice(0, 1000);
    await kv().update(KEYS.ws(wsId), { importDropped: { n: dropped.length, files } });
  }
  // One signal, last: the pin counts written above (nobody could be
  // subscribed to this brand new workspace yet, but the invariant — every
  // request that writes c.*/w/u.* ends with a signal — is simplest kept
  // without a special case for "not yet, probably").
  await signal(wsId, null);
  return { workspace: { id: wsId, name: ws.name }, ...(ordered.length ? { scheduled: { kept: Object.keys(kept).length, dropped: dropped.length } } : {}) };
}));

/**
 * The steps after the first are the owner's alone, as the first is
 * (assertMayCreate): the archive's admins are admins of the copy the moment
 * it is created, and while it is being filled they could otherwise write
 * messages under anyone's name into any of its conversations, replace the
 * bytes of any of its files, or open it before the history is in.
 */
function assertImporter(ws, uuid) {
  if (ws.owner !== uuid) fail(403, 'forbidden', 'Only the owner can import');
  if (!ws.importing) fail(409, 'not_importing', 'This workspace is not being imported into');
}

/**
 * Is this file record one a deleted copy of the workspace left behind? A
 * workspace restored from its export on the server it was deleted from gets
 * its id back (the id was free) and so do its channels and its files; the
 * deletion took the bytes and left the records (see DELETE /api/ws/:ws),
 * each still counting the messages of the copy that is gone and the
 * conversations it was shared in. Counted on top of that, a restored file
 * outlived the deletion of its last message for good, and a guest kept it
 * through a sharing that was no longer there. A record of this workspace's
 * that this import did not write is that copy's: the bytes an import
 * writes name the import they came with (`imp`, the moment the workspace
 * was made, which no two makings of one id share), and a page's count
 * writes a record with no workspace at all. Told apart by that name rather
 * than by the clock: the moment a record was written and the moment the
 * workspace was made are stamped by whichever machine took each request,
 * and a record of this import's written on a clock a little behind the one
 * that made the workspace read as older than the workspace, so a file sent
 * twice, or sent before its pages, lost the count of the messages already
 * holding it.
 */
const staleFileRecord = (meta, ws) => !!(meta && meta.ws === ws.id && ws.importing && meta.imp !== ws.importedAt);

/**
 * Let go of the files of the waiting messages the copy could not take (see
 * the queue in /api/workspaces/import): the app sends them with the rest,
 * and each would otherwise sit in the new owner's drive held by nothing.
 * Only what nothing here holds goes: not a file a message carries (its
 * count), one a bookmark points at, or one an entry the copy did keep will
 * send. Best effort; a file whose bytes never arrived has no record to take.
 */
async function releaseImportDropped(ws) {
  const ids = [...new Set((Array.isArray(ws.importDropped?.files) ? ws.importDropped.files : []).filter((f) => /^[a-z0-9]{8,24}$/.test(String(f))))];
  if (!ids.length) return;
  const keep = bookmarkedFiles(ws);
  const queue = (await kv().get(KEYS.sched(ws.id)).catch(() => null)) || { m: {} };
  for (const e of Object.values(queue.m || {})) for (const a of e?.attachments || []) if (a?.id) keep.add(a.id);
  const metas = await getMany(ids.map((f) => KEYS.file(f)));
  for (let i = 0; i < ids.length; i++) {
    const meta = metas[i];
    if (!meta || meta.ws !== ws.id || Number(meta.refs) > 0 || keep.has(ids[i])) continue;
    await fs().delete(`teamchat-files/${ws.id}/${ids[i]}`).catch(() => {});
    await kv().del(KEYS.file(ids[i])).catch(() => {});
  }
}

/**
 * Import, step two: a chunk of one conversation's messages (in order). The
 * archive holds merged messages; they are written back as raw records with
 * their overlays (edits, reactions, pins, thread counts) rebuilt, keeping
 * every seq, so permalinks and thread ids survive. Idempotent per seq.
 */
router.post('/api/ws/:ws/import', route(async ({ params, request, user }) => {
  // The importer's own document is nothing a page looks at (see requireMembership's `doc`).
  const { id, ws } = await requireMembership(params.ws, user, { doc: false });
  assertImporter(ws, id.uuid);
  const body = await readJson(request);
  // The archive's id, translated where step one gave the conversation a new one.
  const conv = importedConv(ws.importMap, String(body.conv || ''));
  if (!/^[a-z0-9_]{1,64}$/.test(conv)) fail(400, 'invalid', 'Bad conversation id');
  // Only this workspace's conversations may be written: its channels, the
  // direct messages the archive declared, and threads of either.
  const thread = parentOfThread(conv);
  const root = thread ? thread.conv : conv;
  if (thread && (threadConvId(thread.conv, thread.seq) !== conv || parentOfThread(thread.conv))) fail(400, 'invalid', 'Bad conversation id');
  if (!own(ws.channels, root) && !own(ws.importDms || {}, root)) fail(404, 'not_found', 'That conversation is not part of this workspace');
  const messages = (Array.isArray(body.messages) ? body.messages : []).slice(0, IMPORT_CHUNK);
  const declared = body.seq === undefined ? 0 : Number(body.seq);
  if (!Number.isFinite(declared) || declared < 0 || declared > IMPORT_MAX_SEQ) fail(400, 'invalid', 'Bad conversation counter');
  // The blocks the original closed early, each with the number its records
  // end at (see the export's `closed`): the copy's are closed the same way
  // below, once its counter stands. An entry of no shape is passed over, as
  // an archive's other fields are; one naming a block past the counter's is
  // left to rollBlock, which moves nothing where the counter is already past.
  const closed = new Map();
  for (const c of (Array.isArray(body.closed) ? body.closed : []).slice(0, 200)) {
    const n = Number(c?.block);
    const after = Number(c?.after);
    if (!Number.isInteger(n) || n < 0 || n > blockIndexOf(IMPORT_MAX_SEQ) || !Number.isInteger(after) || after < firstSeqOfBlock(n) - 1 || after > lastSeqOfBlock(n)) continue;
    closed.set(n, after);
  }
  // File records carry no workspace in their key either: an archive naming
  // a file another workspace on this worker holds must not count on its
  // record (a delete here would then take that workspace's file with it),
  // nor keep pointing at it. Such attachments are dropped; a file not here
  // yet is the import's own, its bytes on their way (see import/file).
  const named = [...new Set(messages.flatMap((m) => (Array.isArray(m?.attachments) ? m.attachments : []).map((a) => String(a?.id || '')).filter((x) => /^[a-z0-9]{8,24}$/.test(x))))];
  const foreign = new Set();
  if (named.length) {
    const metas = await getMany(named.map((f) => KEYS.file(f)));
    const stale = [];
    metas.forEach((meta, i) => {
      if (meta && meta.ws && meta.ws !== ws.id) foreign.add(named[i]);
      else if (staleFileRecord(meta, ws)) stale.push(named[i]);
    });
    // A record left by a deleted copy of this workspace (see staleFileRecord)
    // goes before the page is counted, so the file starts at nothing here,
    // as on a server that never held it.
    for (let i = 0; i < stale.length; i += 12) await Promise.all(stale.slice(i, i + 12).map((f) => kv().del(KEYS.file(f)).catch(() => {})));
  }
  const blocks = new Map();
  // One record per number within the page as well as across pages: a page
  // naming a number twice put both records in the block, and the message
  // was listed twice, its file counted twice (so released once too few).
  const seen = new Set();
  let maxSeq = 0;
  // The page's newest message as admitted (the highest number, not the last
  // entry: an export writes a page in order, and one edited by hand may
  // not be), which the conversation is stamped with below.
  let lastRaw = null;
  for (const m of messages) {
    // An entry that is no message (a null where a hand-edited or truncated
    // messages.json lost one) is passed over, as an entry without a number
    // is; read for its number, it threw, and the whole import stopped with
    // "Something went wrong on the server" and the copy taken down.
    if (!m || typeof m !== 'object') continue;
    const seq = Math.floor(Number(m.seq));
    if (!Number.isInteger(seq) || seq < 1 || seen.has(seq)) continue;
    if (seq > IMPORT_MAX_SEQ) fail(400, 'invalid', 'Bad message sequence number');
    seen.add(seq);
    maxSeq = Math.max(maxSeq, seq);
    const n = blockIndexOf(seq);
    const b = blocks.get(n) || (blocks.set(n, { m: [], x: {} }), blocks.get(n));
    // An author is a member's id, an app's (`hook_…`, `bot_…`), or nobody's: the line stays, attributed to no one.
    const author = String(m.user || '');
    const raw = { s: seq, u: isId(author) ? author : '', t: cleanText(m.text, LIMITS.messageText), ts: importedTime(m.ts) };
    if (m.kind && m.kind !== 'msg') raw.k = String(m.kind).slice(0, 8);
    if (Array.isArray(m.attachments) && m.attachments.length) {
      raw.a = m.attachments.filter((a) => a && /^[a-z0-9]{8,24}$/.test(String(a.id)) && !foreign.has(String(a.id))).slice(0, LIMITS.attachmentsPerMessage)
        .map((a) => ({ id: String(a.id), name: cleanFileName(a.name), size: Math.max(0, Number(a.size) || 0), type: cleanFileType(a.type) }));
      if (!raw.a.length) delete raw.a;
    }
    if (Array.isArray(m.mentions) && m.mentions.length) raw.mn = m.mentions.map(String).filter(isId).slice(0, LIMITS.mentionsPerMessage);
    if (BROADCASTS.includes(m.broadcast)) raw.bc = m.broadcast;
    if (m.bot && typeof m.bot === 'object') raw.bot = { name: cleanLine(m.bot.name, LIMITS.webhookName) || 'App', color: Number.isInteger(m.bot.color) && m.bot.color >= 1 && m.bot.color <= 8 ? m.bot.color : 8 };
    if (m.ref && typeof m.ref === 'object' && CONV_RE.test(String(m.ref.c || '')) && Number.isInteger(m.ref.s) && m.ref.s >= 1) raw.ref = { c: importedConv(ws.importMap, m.ref.c), s: m.ref.s };
    // The id the sender gave the post, in the shape the post route admits it
    // (see postMessage): what tells a repeat from the original. A scheduled
    // message is posted under its entry's id, and an entry the old copy
    // delivered as the move began may travel both as a message and, in the
    // header's queue, as still waiting; without the id on the message, the
    // copy's first poll posted it again.
    if (typeof m.cid === 'string' && /^[a-z0-9_-]{8,40}$/.test(m.cid)) raw.cid = m.cid;
    b.m.push(raw);
    if (!lastRaw || raw.s > lastRaw.s) lastRaw = raw;
    const o = {};
    // An edited message keeps its mark alone: the text it shows is the
    // record's (see mergeBlock, which reads the overlay's text only where
    // there is one, as the edit and preview routes do). Written on the
    // overlay as well, as it used to be, an edited message's text stood
    // twice in the block, where the original's block held the first text
    // and the edit, so a block of long edited messages the original held
    // came to more than the store holds here, and the page failed with a
    // server error that stopped the whole import, or the move.
    if (Number(m.editedAt) > 0) o.e = Number(m.editedAt);
    if (m.deleted) o.d = 1;
    const reactions = cleanImportedReactions(m.reactions);
    if (Object.keys(reactions).length) o.r = reactions;
    if (Number(m.replyCount) > 0) o.rc = Math.floor(Number(m.replyCount));
    if (Number(m.lastReplyAt) > 0) o.rt = Number(m.lastReplyAt);
    const followers = cleanUserFlags(m.followers, [0, 1]);
    if (Object.keys(followers).length) o.f = followers;
    if (m.pinned) o.p = 1;
    const uf = cleanImportedUnfurl(m.unfurl);
    if (uf) o.uf = uf;
    if (Object.keys(o).length) b.x[overlayKey(seq)] = o;
  }
  const written = [];
  // The page's blocks as they stand, and the conversation's counter, read
  // together, and the blocks written together, a dozen at a time (see
  // getMany), as every other fan-out here goes. Read and written one after
  // another, as they used to be, a page of four hundred messages spent
  // sixteen round trips to the store in a row on its eight blocks alone.
  const entries = [...blocks.entries()];
  const [seqRaw, ...curs] = await getMany([KEYS.seq(conv), ...entries.map(([n]) => KEYS.block(conv, n))]);
  const sets = entries.map(([n, b], i) => {
    const cur = curs[i] || { m: [], x: {} };
    const have = new Set((cur.m || []).map((x) => x.s));
    const adding = b.m.filter((x) => !have.has(x.s));
    const merged = (cur.m || []).concat(adding).sort((x, y) => x.s - y.s);
    // Idempotent per seq: a message already here keeps its overlay as it
    // stands. The archive's copy replacing it would undo what happened since
    // (a page sent twice used to bring a message deleted in between back,
    // its file counted once but released twice).
    const x = { ...(cur.x || {}) };
    for (const [k, o] of Object.entries(b.x)) if (!(k in x)) x[k] = o;
    written.push(...adding);
    // A block already closed here (see `closed` and rollBlock, which marks
    // it `full` before or after its messages arrive, since the page's chunks
    // each name every closed block) stays closed when its messages are written.
    return [KEYS.block(conv, n), { ...(Number(cur.full) > 0 ? { full: cur.full } : {}), m: merged, x }];
  });
  const seqNow = Number(seqRaw) || 0;
  let top = Math.max(seqNow, maxSeq, Math.floor(declared) || 0);
  // The counter's block is closed behind the newest message it holds where
  // the counter stands past that message (see rollBlock, which closes a
  // block so on the original): the block is marked `full`, the counter moves
  // to the block's last number, and the numbers between are noted on the
  // conversation's entry (`k`) as standing for no message. An archive
  // carries the messages that stand and the counter, not the block's own
  // marks nor the records of messages deleted since (see mergeBlock): a
  // block the original had closed early, or one whose newest messages were
  // deleted before the export, came across with numbers at its end that no
  // record and no mark accounted for, so on the copy a mention read to the
  // last message standing kept its badge on every device until someone
  // posted again (see the read route, which takes such a number for a
  // message on its way), and the conversation counted those numbers as
  // unread in every sidebar and tab title until it was opened. Only once
  // the page covering the counter's block is wholly in (`last`, the page's
  // last part; `to`, the blocks it covers, or the block's messages on this
  // part for an archive from before pages said), since a part cut short of
  // the block's newest message would close it too soon; and only where
  // numbers stand past that message, so a block filled to its end is left
  // as it is. Idempotent: a part sent again finds the block closed as it
  // left it.
  let run = null;
  let closing = null;
  if (top > 0 && body.last === true) {
    const head = blockIndexOf(top);
    const covers = Number.isInteger(body.to) ? body.to >= head : blocks.has(head);
    if (covers) {
      const set = sets.find(([key]) => key === KEYS.block(conv, head));
      const cur = set ? set[1] : (await kv().get(KEYS.block(conv, head))) || { m: [], x: {} };
      const records = Array.isArray(cur.m) ? cur.m : [];
      // The first number nothing stands under: past the block's newest
      // record, or, in a block holding none, the block's first.
      const newest = Math.max(head * BLOCK_SIZE, ...records.map((x) => Number(x?.s) || 0));
      if (newest < top) {
        top = lastSeqOfBlock(head);
        run = [newest + 1, top];
        if (set) set[1].full = 1;
        else closing = [KEYS.block(conv, head), { ...cur, m: records, x: cur.x && typeof cur.x === 'object' ? cur.x : {}, full: 1 }];
      }
    }
  }
  if (closing) sets.push(closing);
  for (let i = 0; i < sets.length; i += 12) await Promise.all(sets.slice(i, i + 12).map(([key, block]) => kv().set(key, block)));
  // Every message written here counts as a reference to each file it
  // carries, as a live post does: a file shared in two messages (forwarded)
  // must survive the deletion of one of them. The bytes may arrive later
  // (the app sends pages before files): the count waits on a record the
  // upload completes.
  const refd = written.flatMap((x) => x.a || []);
  if (refd.length) await holdFiles(conv, refd.map((f) => f.id));
  if (top > seqNow) await kv().set(KEYS.seq(conv), top);
  // The blocks a live conversation at this count has standing (see
  // writeMessage): the head block, and the one past it, made ahead of its
  // first message, so that an append there never falls back to writing the
  // block whole, which two members posting at once would each do over the
  // other (see appendToBlock). A page carries the messages that stand, not
  // the ones deleted before the export (see mergeBlock), so the head block
  // is not written where the counter's last messages were all deleted (the
  // one message of a new block, deleted before the move), nor is any block
  // where the whole conversation was: each is made here where the page did
  // not make it. Made past the head alone where the page had messages, and
  // where it had none the head alone, as they used to be, the first post
  // after the restore (or the first to open the block after that) went into
  // a block that was not there, and of two sent at once one was lost.
  if (top > 0) {
    const head = blockIndexOf(top);
    await Promise.all([blocks.has(head) || closing ? null : ensureBlock(conv, head), ensureBlock(conv, head + 1)]);
  }
  // The blocks the original closed early are closed here as the original
  // closed them (see rollBlock: the block marked `full`, the run of unused
  // numbers noted on the conversation's activity entry for every reader's
  // unread count; the counter, already past the block, stays). In block
  // order, so the run noted last is the newest, as on the original; a page
  // sent again finds each block closed and changes nothing.
  for (const [n, after] of closed) await rollBlock(ws.id, conv, n, after + 1).catch(() => {});
  // The conversation is stamped with the newest message as it was stored,
  // not with the page's last entry as it came: one without a number is
  // admitted nowhere, yet named its author (of any length) as the last to
  // write, and the clients take that name for whose line the newest is. A
  // block closed above notes its run of unused numbers on the entry (`k`,
  // see rollBlock), which the clients count no unread messages for.
  if (lastRaw || run) {
    await kv().update(KEYS.activity(ws.id), {
      [`c.${conv}.s`]: top,
      ...(lastRaw ? { [`c.${conv}.t`]: lastRaw.ts, [`c.${conv}.u`]: lastRaw.u } : {}),
      ...(run ? { [`c.${conv}.k`]: run } : {}),
    });
  }
  // The search index is built from the records just written, no extra
  // reads: the same cleaned text, validated seq and timestamp, and edit
  // overlay the blocks hold, so a posting names a message as it is stored.
  await indexBatch(ws.id, [...blocks.values()].flatMap((b) => mergeBlock(b).map((message) => ({ conv, message }))));
  // One signal, last, covering the c.* stamp above.
  await signal(ws.id, null);
  return { ok: true, conv, count: messages.length };
}));

/** Import, files: an attachment's bytes under its original id, so messages keep pointing at it. */
router.post('/api/ws/:ws/import/file', route(async ({ params, request, user }) => {
  // Nor is it anything a file looks at: read for every page and every file of an import, it cost a large one hundreds of round trips.
  const { id, ws } = await requireMembership(params.ws, user, { doc: false });
  assertImporter(ws, id.uuid);
  // Refused by its declared length before the body is buffered, as an upload
  // is (see assertDeclaredSize): an archive's attachment past the cap (a file
  // taken in before the cap, or a messages.json edited by hand) was held
  // whole in the worker's memory and then refused for its size.
  assertDeclaredSize(request, LIMITS.attachmentBytes, 'Files can be up to 10 MB');
  let form;
  try {
    form = await request.formData();
  } catch {
    fail(400, 'invalid', 'Expected a multipart upload');
  }
  const file = form.get('file');
  const fileId = String(form.get('id') || '');
  if (!file || typeof file.size !== 'number' || !/^[a-z0-9]{8,24}$/.test(fileId)) fail(400, 'invalid', 'Bad file');
  if (file.size > LIMITS.attachmentBytes) fail(413, 'too_large', 'Files can be up to 10 MB');
  const owner = String(form.get('owner') || id.uuid);
  // File records carry no workspace in their key either: one that belongs
  // to another workspace on this worker stays that workspace's.
  const found = await kv().get(KEYS.file(fileId));
  if (found && found.ws && found.ws !== params.ws) fail(409, 'exists', 'A file with that id belongs to another workspace');
  // A record a deleted copy of this workspace left behind counts nothing here (see staleFileRecord).
  const held = staleFileRecord(found, ws) ? null : found;
  await fs().write(`teamchat-files/${params.ws}/${fileId}`, file, { createMissingParents: true, overwrite: true });
  // The messages of this import may be in already (the app sends pages
  // before files), each counted on a record that awaited the bytes: the
  // count and the conversations carry over, and so they do when the same
  // file is sent again.
  await kv().set(KEYS.file(fileId), {
    ws: params.ws, u: isId(owner) ? owner : id.uuid, name: cleanFileName(form.get('name') || file.name), size: file.size,
    type: cleanFileType(file.type), ts: now(), imp: ws.importedAt, refs: Number(held?.refs) || 0, ...(held?.cs && typeof held.cs === 'object' ? { cs: held.cs } : {}),
  });
  return { ok: true, id: fileId };
}));

/** Import, step three: open for business. */
router.post('/api/ws/:ws/import/finish', route(async ({ params, user }) => {
  const { id, ws, doc } = await requireMembership(params.ws, user);
  assertImporter(ws, id.uuid);
  // An archive of a workspace the importer was not in (another owner's
  // export, a backup restored under a new account) carries no document for
  // them, so the owner opened their copy to an empty sidebar, and a private
  // channel in it was theirs to delete but never to enter (adding people
  // takes being in the channel). They land in the default channels as
  // anyone joining does, now that the history is in to be caught up to.
  if (!doc.channels.length) await landInDefaults(ws, id.uuid, doc);
  // The files of the waiting messages the copy could not take (see the import's queue) go now that every file has arrived.
  if (ws.importDropped) await releaseImportDropped(ws).catch(() => {});
  await kv().remove(KEYS.ws(ws.id), 'importing', 'importDms', 'importMap', 'importDropped');
  await bumpWorkspace(ws.id);
  return { ok: true };
}));

/**
 * Transfer, step one: the owner nominates an admin. Nothing moves yet; the
 * nominee's app does the export and import with their own session, on
 * their own worker, then calls complete below.
 */
router.post('/api/ws/:ws/transfer', route(async ({ params, request, user }) => {
  // The owner's own document is nothing a move looks at, here or in the three routes below (see requireMembership's `doc`).
  const { id, ws } = await requireMembership(params.ws, user, { doc: false });
  if (ws.owner !== id.uuid) fail(403, 'forbidden', 'Only the owner can transfer a workspace');
  const body = await readJson(request);
  // Withdrawing the nomination is the owner's way out of a move under way:
  // allowed while the freeze stands, and it takes the freeze with it.
  assertWritable(ws, { moving: !!body.cancel });
  if (body.cancel) {
    await kv().remove(KEYS.ws(ws.id), 'transferTo', 'transferring');
    await bumpWorkspace(ws.id);
    return { ok: true, transferTo: null };
  }
  const to = String(body.to || '');
  const nominee = own(ws.members, to);
  if (!nominee || !isAdmin(nominee) || to === id.uuid) fail(400, 'invalid', 'Pick another admin of this workspace');
  await kv().update(KEYS.ws(ws.id), { transferTo: to });
  await pokeAndBump(ws.id, to);
  return { ok: true, transferTo: to };
}));

/**
 * Transfer, before the export: the nominee freezes this copy (see
 * assertWritable) so that nothing written while they export it and import
 * it elsewhere is lost to the move. Called again to renew while the move
 * still runs; the freeze lets go on its own after TRANSFER_FREEZE_MS.
 */
router.post('/api/ws/:ws/transfer/begin', route(async ({ params, request, user }) => {
  const { id, ws, member } = await requireMembership(params.ws, user, { doc: false });
  assertWritable(ws, { moving: true });
  if (ws.transferTo !== id.uuid || !isAdmin(member)) fail(403, 'forbidden', 'Only the admin nominated to take this workspace over can begin moving it');
  const body = await readJson(request);
  // The session moving the workspace, named by the nominee's app once per
  // attempt (and kept across a retry from the same dialog): a freeze that
  // stands, named by another session of the same nominee, is that session's
  // to renew, not this one's to take. Two tabs of the nominee's both told to
  // accept used to freeze, export and import in turn, each unaware of the
  // other, and the second copy was found out only at the completion. One
  // that has lapsed, or that an app from before sessions were named left
  // unnamed, is taken over.
  const sid = typeof body.sid === 'string' && /^[a-z0-9_-]{8,40}$/.test(body.sid) ? body.sid : null;
  const standing = frozen(ws) ? ws.transferring : null;
  if (standing?.sid && standing.sid !== sid) fail(423, 'transferring', 'This workspace is already being moved from another of your sessions; let that finish');
  const transferring = { by: id.uuid, at: now(), ...(sid ? { sid } : {}) };
  await kv().update(KEYS.ws(ws.id), { transferring });
  await bumpWorkspace(ws.id);
  return { ok: true, transferring, until: transferring.at + TRANSFER_FREEZE_MS };
}));

/** The move did not go through (the export or the import failed): the nominee or the owner lets the workspace go on again. The nomination stays. */
router.post('/api/ws/:ws/transfer/cancel', route(async ({ params, user }) => {
  const { id, ws, member } = await requireMembership(params.ws, user, { doc: false });
  assertWritable(ws, { moving: true });
  if (ws.owner !== id.uuid && !(ws.transferTo === id.uuid && isAdmin(member))) fail(403, 'forbidden', 'Only the owner or the nominated admin can cancel a move');
  if (ws.transferring) {
    await kv().remove(KEYS.ws(ws.id), 'transferring');
    await bumpWorkspace(ws.id);
  }
  return { ok: true };
}));

/**
 * Transfer, step two: the nominee (or the owner) marks the copy here as
 * moved. From now on it is read-only and every client that opens it is
 * sent to the new reference; the old owner can delete it when they like.
 */
router.post('/api/ws/:ws/transfer/complete', route(async ({ params, request, user }) => {
  const { id, ws, member } = await requireMembership(params.ws, user, { doc: false });
  // Already moved: the first completion stands, and the caller is told so
  // and where to, whatever copy they name (`already`; the reference says
  // whether it is theirs). Answered before the nomination is checked, since
  // completing clears the nomination: the nominee asking again after an
  // answer that was lost on the way was refused as no longer nominated.
  if (ws.movedTo) return { ok: true, movedTo: ws.movedTo, already: true };
  // The nominee must still be an admin: marking the copy moved makes it
  // read-only for everyone, which is not for a member to decide.
  if (ws.owner !== id.uuid && !(ws.transferTo === id.uuid && isAdmin(member))) fail(403, 'forbidden', 'Only the owner or the nominated admin can complete a transfer');
  const body = await readJson(request);
  const to = String(body.to || '');
  if (!/^[a-z0-9]{6,20}@[a-z0-9][a-z0-9._:-]{0,120}$/.test(to)) fail(400, 'invalid', 'Bad workspace reference');
  // A move keeps the workspace's id where that id is free on the server it
  // goes to, so the same id under another server's name is a move; an
  // address naming this very copy, the id on this worker, is none: marked
  // moved to itself, the copy sent everyone who opened it back to itself and
  // refused every write as moved, and only deleting it put that right. This
  // worker is named as the links in pushes name it, by the host the request
  // came to, its puter.work name or its host, in lower case, which is how the
  // app writes a reference's server (see refs.js serverKeyOf). The app never
  // asks for this; a request made another way is refused with the reason.
  const serverKey = (host) => String(host || '').toLowerCase().replace(/\.puter\.work$/, '');
  const at = to.indexOf('@');
  if (to.slice(0, at) === ws.id && workerHost && serverKey(to.slice(at + 1)) === serverKey(workerHost)) fail(400, 'invalid', 'A workspace cannot be moved to itself');
  await kv().update(KEYS.ws(ws.id), { movedTo: to, movedAt: now() });
  // The nomination and the freeze (see /transfer/begin) go with the move: the copy is read-only now on its own account.
  await kv().remove(KEYS.ws(ws.id), 'transferTo', 'transferring').catch(() => {});
  await bumpWorkspace(ws.id);
  return { ok: true, movedTo: to };
}));

/* ---- link previews ------------------------------------------------------- */

/**
 * Per-member and per-workspace budgets for triggering fetches, the
 * join-budget pattern. The member's is counted per workspace, as their
 * upload budget is (see assertUploadBudget): counted under their id alone,
 * as it used to be, the thirty previews a member may ask for in ten minutes
 * were shared across every workspace of theirs on this worker, and having
 * spent them in one, their first link in another was refused a card.
 */
async function assertUnfurlBudget(wsId, uuid) {
  const keys = [[`tc:unfurlrate:${wsId}:${uuid}`, LIMITS.unfurlsPerMember], [`tc:unfurlrate:ws:${wsId}`, LIMITS.unfurlsPerWorkspace]];
  for (const [key, max] of keys) {
    const n = await kv().incr(key).catch(() => 1);
    if (n === 1) await kv().expire(key, LIMITS.unfurlWindowSeconds).catch(() => {});
    if (n > max) fail(429, 'too_many_previews', 'Too many link previews right now; try again in a few minutes');
  }
}

/**
 * Build the preview for a message's first link (outside code) and store it
 * on the message's overlay, so it is computed once and identical for every
 * reader. Idempotent: a message that already has one (or had it removed) is
 * left alone. Called by the sender's client right after posting, so the
 * post itself stays fast.
 */
router.post('/api/ws/:ws/conv/:conv/messages/:seq/unfurl', route(async ({ params, user, defer }) => {
  // The message's block, keyed on the conversation and the number in the
  // path, comes up with the caller's own document (see the edit route).
  const seqNum = Number(params.seq);
  const locatable = looksLikeConvId(params.conv) && Number.isInteger(seqNum) && seqNum >= 1;
  const ctx = await requireMembership(params.ws, user, { write: true, also: locatable ? [KEYS.block(params.conv, blockIndexOf(seqNum))] : [] });
  const id = ctx.id;
  const conv = resolveConv(ctx, params.conv);
  // A card is a change to the conversation, asked for by the sender's app
  // after a send or an edit: for people who have joined, as reacting and
  // pinning are (someone previewing a public channel reads it and changes
  // nothing), and not in an archived channel, which is closed to change as
  // it is to posts, edits, reactions and pins. Either used to have the
  // worker fetch the page and write the card all the same, on the
  // workspace's preview budget. Taking a card down stays as it was.
  if (!conv.joined) fail(403, 'not_joined', 'Join the channel to load a preview');
  if (conv.channel?.archived) fail(403, 'archived', 'This channel is archived');
  if (ctx.ws.unfurl === false) return { unfurl: null, disabled: true };
  const seq = seqNum;
  const found = locatable ? messageIn(params.conv, seq, ctx.extra[0]) : await locateMessage(params.conv, seq);
  if (!found || found.overlay.d || found.raw.k) fail(404, 'not_found', 'Message not found');
  const text = typeof found.overlay.t === 'string' ? found.overlay.t : found.raw.t;
  const link = firstUnfurlableLink(text);
  // The card that stands is answered: one taken down (`off`), or one for
  // the link the message carries. A card for another link is what a fetch
  // of the link the message carried before left behind, landing after the
  // edit that took that link out had looked for a card to take down (see
  // the edit route): it is no card of this message's, and is not answered
  // as one, nor kept; the link the message carries now gets its own.
  const standing = (uf, forLink) => !!uf && (uf.off || typeof uf.url !== 'string' || uf.url === forLink);
  if (standing(found.overlay.uf, link)) return { unfurl: found.overlay.uf.off ? null : found.overlay.uf };
  if (!link) return { unfurl: null };
  await assertUnfurlBudget(params.ws, id.uuid);
  const data = await unfurl(link);
  if (!data) return { unfurl: null };
  // The message as it stands now, not as it stood before the page was
  // read: a fetch runs for seconds (five per hop, up to four hops for the
  // page and again for its image), and the message may have changed under
  // it. Edited to another link, it was told to ask again for that link's
  // card (see the edit route's `relink`), and this fetch's card, landing
  // after the new one, stood over it for good, drawn under a message that
  // no longer carried its link, and answered to every later request; edited
  // to no link, or deleted, it got a card all the same, and a removal made
  // meanwhile was undone by it. Only a card for the link the message still
  // carries, where none has landed, is written; whatever stands is answered.
  const again = await locateMessage(params.conv, seq);
  if (!again || again.overlay.d) return { unfurl: null };
  // Whatever stands for the message as it is now is answered: a removal, or
  // a card for the link it carries now (see `standing`). Neither standing,
  // this fetch's card is written only where its link is still the message's;
  // a card left there for a link the message no longer carries is written over.
  const nowLink = firstUnfurlableLink(typeof again.overlay.t === 'string' ? again.overlay.t : again.raw.t);
  if (standing(again.overlay.uf, nowLink)) return { unfurl: again.overlay.uf.off ? null : again.overlay.uf };
  if (nowLink !== link) return { unfurl: null };
  const uf = { url: link, title: data.title, desc: data.desc, site: data.site, image: data.image, kind: data.kind, ts: now() };
  // A block with no room for the card goes without one (see blockHasRoom).
  if (!blockHasRoom(again.block, jsonBytes(uf) + 40)) return { unfurl: null };
  await kv().update(again.key, { [`x.${overlayKey(seq)}.uf`]: uf });
  await touchConv(params.ws, params.conv, now(), { audience: audienceOf(conv), defer, ws: ctx.ws, seq, patch: { uf } });
  return { unfurl: uf };
}));

/** The author or an admin removes a preview; it is not fetched again. */
router.delete('/api/ws/:ws/conv/:conv/messages/:seq/unfurl', route(async ({ params, user, defer }) => {
  const seq = Number(params.seq);
  const locatable = looksLikeConvId(params.conv) && Number.isInteger(seq) && seq >= 1;
  const ctx = await requireMembership(params.ws, user, { write: true, also: locatable ? [KEYS.block(params.conv, blockIndexOf(seq))] : [] });
  const id = ctx.id;
  const conv = resolveConv(ctx, params.conv);
  const found = locatable ? messageIn(params.conv, seq, ctx.extra[0]) : await locateMessage(params.conv, seq);
  if (!found) fail(404, 'not_found', 'Message not found');
  if (found.raw.u !== id.uuid && !isAdmin(ctx.member)) fail(403, 'forbidden', 'Only the author or an admin can remove a preview');
  await kv().update(found.key, { [`x.${overlayKey(seq)}.uf`]: { off: 1 } });
  await touchConv(params.ws, params.conv, now(), { audience: audienceOf(conv), defer, ws: ctx.ws, seq, patch: { uf: null } });
  return { ok: true };
}));

/**
 * The workspace and the caller's membership in it, without the caller's
 * own document: for the routes that serve bytes (an attachment, a
 * preview's picture), asked for once per picture on screen, which a member
 * may read on their membership alone. Read through requireMembership, as
 * they used to be, every download cost a read of the caller's document
 * that only a guest's or an external's check ever looked at (see
 * mayTakeFile, which reads it for them below).
 */
async function requireMember(wsId, who, { also = null } = {}) {
  // As requireMembership does it: nothing here is keyed on the caller, so
  // the workspace and whatever else the route wants (a card's account
  // record, a file's) go in one read — beside the identity call where that
  // still has to be made, and after a cached one where it does not. These
  // are the routes asked once per picture on screen, so the round trip
  // saved here is saved fifty times over when a workspace opens.
  const known = typeof who === 'string' ? { uuid: who } : null;
  const want = also || [];
  const ready = known || (validWsId(wsId) ? await peekIdentity(who) : null);
  let id = ready;
  let readValues;
  if (ready) {
    readValues = await getMany([KEYS.ws(wsId), ...want]);
  } else {
    const readable = validWsId(wsId) && who?.puter;
    const [idRes, readRes] = await Promise.allSettled([
      identify(who),
      readable ? getMany([KEYS.ws(wsId), ...want]) : [null],
    ]);
    if (idRes.status === 'rejected') throw idRes.reason;
    if (readRes.status === 'rejected') throw readRes.reason;
    id = idRes.value;
    readValues = readRes.value;
  }
  if (!validWsId(wsId)) fail(404, 'not_found', 'Workspace not found');
  const [wsRead, ...extra] = readValues;
  const ws = await normalizeWorkspace(wsId, wsRead);
  const member = ws.members[id.uuid];
  if (!member) fail(403, 'forbidden', 'You are not a member of this workspace');
  assertAttested(member);
  return { id, uuid: id.uuid, ws, member, extra };
}

/** A preview's thumbnail, stored by the worker, served to members only. */
router.get('/api/ws/:ws/unfurl-image/:hash', route(async ({ params, user }) => {
  await requireMember(params.ws, user);
  const img = await readImage(params.hash);
  if (!img) fail(404, 'not_found', 'No image');
  return new Response(img.blob, { status: 200, headers: fileHeaders(img.type, 'preview', 86400) });
}));

/* ---- files ------------------------------------------------------------- */

/**
 * Headers for bytes the worker serves (an attachment, a photo, an icon, a
 * preview's image). The type is the one recorded at upload and is never to
 * be sniffed into another; and only what the app shows inline (a picture,
 * video, sound, a PDF) is offered inline, so a document the browser would
 * run scripts in (SVG, HTML) is a download should its address ever be
 * opened on its own rather than fetched by the app into a blob of the app's
 * own origin. The name travels encoded for any alphabet (RFC 5987), with an
 * ASCII stand-in beside it for clients that read only that.
 */
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif)$|video\/|audio\/|application\/pdf$)/;

/**
 * A file's name as every reader sees it and saves it under: one line, with
 * the bidi and zero-width format characters out (a right-to-left override in
 * "invoice_[U+202E]fdp.exe" shows it as "invoice_exe.pdf" in the card and in
 * the name a browser offers; a zero-width space hides in a name that then
 * matches nothing typed), control characters and line breaks made one space,
 * clamped, and "file" when nothing is left. Applied wherever a name is
 * admitted: an upload, an import's attachments and the bytes sent for them.
 */
const FILE_NAME_MAX = 120;
function cleanFileName(input) {
  const s = String(input || '')
    .replace(/[\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ');
  // The clamp counts UTF-16 units and falls only between whole characters
  // (see cleanText): a character written as several of them can straddle
  // the cut, and cut by the count alone a name lost half of an emoji (a lone
  // surrogate no encoder takes, so the headers a download is served with
  // could not be built, and the file answered a server error on every try),
  // or half of a flag or a keycap, drawn as a boxed letter or a bare digit.
  return cleanText(s, FILE_NAME_MAX) || 'file';
}

/**
 * A file's type as recorded: what stands before any parameter, in lower
 * case, in the one shape a media type has; anything else is a file of
 * unknown kind. Admitted in the bare shape alone, as it used to be, a type
 * declared with a parameter ("image/png; charset=binary", as a script or a
 * mail client's attachment may send it) was recorded as a file of unknown
 * kind, and the picture opened only as a download. The app reads the type
 * before the semicolon when it takes a file back (see lib/api.js readBlob).
 */
function cleanFileType(raw) {
  const t = String(raw || '').split(';')[0].trim().toLowerCase();
  return /^[\w.+-]+\/[\w.+-]+$/.test(t) ? t : 'application/octet-stream';
}

/**
 * A name with no half of a character in it. A lone surrogate is no character
 * and no encoder takes it: a file's name is kept whole as it comes in now
 * (see cleanFileName), but a record written before that keeps the half of an
 * emoji its name was cut to, and the headers built for it threw, so the file
 * answered a server error on every download.
 */
const wholeName = (name) => String(name || 'file').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '').trim() || 'file';

function fileHeaders(type, name, maxAge) {
  const shown = wholeName(name);
  const ascii = shown.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  const encoded = encodeURIComponent(shown).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    'Content-Type': type,
    'Cache-Control': `private, max-age=${maxAge}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${INLINE_TYPES.test(type) ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
  };
}

/**
 * What one member may upload: so many files per window and so many bytes a
 * day. Every upload lands in the owner's storage, and one never attached to
 * a message is never released, so without a budget any member — a guest, or
 * someone another workspace vouched for — could fill the owner's drive at
 * the owner's cost. The join-budget pattern: a counter with a TTL.
 */
async function assertUploadBudget(wsId, uuid, bytes) {
  const countKey = `tc:uprate:${wsId}:${uuid}`;
  const n = await kv().incr(countKey).catch(() => 1);
  if (n === 1) await kv().expire(countKey, LIMITS.uploadWindowSeconds).catch(() => {});
  if (n > LIMITS.uploadsPerMember) fail(429, 'too_many_uploads', 'Too many files uploaded just now; try again in a few minutes');
  const bytesKey = `tc:upbytes:${wsId}:${uuid}`;
  const total = await kv().incr(bytesKey, bytes).catch(() => bytes);
  if (total === bytes) await kv().expire(bytesKey, 86400).catch(() => {});
  if (total > LIMITS.uploadBytesPerDay) fail(429, 'too_many_uploads', 'You have uploaded as much as you can today; try again tomorrow');
}

router.post('/api/ws/:ws/files', route(async ({ params, request, user }) => {
  // The uploader's own document is nothing an upload looks at (see
  // requireMembership's `doc`): the card says they are here and the copy
  // takes writes, and the record is written under their id alone.
  const { id } = await requireMembership(params.ws, user, { write: true, doc: false });
  assertDeclaredSize(request, LIMITS.attachmentBytes, 'Files can be up to 10 MB');
  let form;
  try {
    form = await request.formData();
  } catch {
    fail(400, 'invalid', 'Expected a multipart upload');
  }
  const file = form.get('file');
  if (!file || typeof file.size !== 'number') fail(400, 'invalid', 'No file provided');
  if (file.size > LIMITS.attachmentBytes) fail(413, 'too_large', 'Files can be up to 10 MB');
  await assertUploadBudget(params.ws, id.uuid, file.size);
  const fileId = uid(16);
  const name = cleanFileName(file.name);
  const type = cleanFileType(file.type);
  await fs().write(`teamchat-files/${params.ws}/${fileId}`, file, { createMissingParents: true });
  const meta = { ws: params.ws, u: id.uuid, name, size: file.size, type, ts: now(), refs: 0 };
  await kv().set(KEYS.file(fileId), meta);
  return { id: fileId, name, size: file.size, type };
}));

router.get('/api/ws/:ws/files/:id', route(async ({ params, user }) => {
  const named = /^[a-z0-9]{8,24}$/.test(params.id);
  // The file's own record is keyed on the file, not the caller, so it comes
  // up with the workspace rather than after it.
  const { id, ws, member, extra } = await requireMember(params.ws, user, { also: named ? [KEYS.file(params.id)] : [] });
  if (!named) fail(404, 'not_found', 'File not found');
  // Members may download any file of the workspace; a guest only what is
  // shared where they can read, or what they uploaded themselves (the rule
  // attaching takes too, see mayTakeFile: their own upload is theirs to
  // attach anywhere, so it is theirs to download whatever it is shared in
  // now; judged by the sharing alone, a guest's own file, forwarded into a
  // channel they cannot read and gone from theirs, was refused them). That
  // judgment reads their document; a member's download reads it not at all.
  const [meta] = extra;
  const raw = isLimited(member) ? await kv().get(KEYS.member(params.ws, id.uuid)) : null;
  if (!meta || meta.ws !== params.ws) fail(404, 'not_found', 'File not found');
  if (isLimited(member)) {
    const doc = { ...(raw || {}), channels: Array.isArray(raw?.channels) ? raw.channels : [], dms: raw?.dms || {} };
    if (!mayTakeFile({ ws, member, doc, uuid: id.uuid }, params.id, meta)) fail(404, 'not_found', 'File not found');
  }
  const blob = await fs().read(`teamchat-files/${params.ws}/${params.id}`);
  return new Response(blob, {
    status: 200,
    headers: { ...fileHeaders(meta.type || 'application/octet-stream', meta.name, 3600), 'X-File-Name': encodeURIComponent(wholeName(meta.name)) },
  });
}));

/**
 * The uploader takes back a file nothing names yet: one picked into the box
 * and taken out again before sending, or left in a draft since discarded. An
 * upload lands in the owner's drive the moment it is picked, and is held by
 * the messages that carry it and let go of with the last of them (see
 * releaseFile); one never attached to anything was held by nothing and let
 * go of by nothing, so it sat in the owner's drive for good, ten megabytes at
 * a time, with nothing to find it by. Only the uploader's own, and only while
 * nothing holds it: not a message (the record's count), not a message waiting
 * in the queue (see queuedFilesReader), not a channel's bookmark (see
 * bookmarkedFiles); a record from before files were counted says nothing of
 * what holds it, and stays. The count is taken down atomically and read
 * back, as a deletion takes it (see releaseFile): a post attaching the file
 * in the same instant moves it first, and the file is put back and kept.
 */
router.delete('/api/ws/:ws/files/:id', route(async ({ params, user }) => {
  const { id, ws } = await requireMembership(params.ws, user, { write: true, doc: false });
  if (!/^[a-z0-9]{8,24}$/.test(params.id)) fail(404, 'not_found', 'File not found');
  const meta = await kv().get(KEYS.file(params.id));
  if (!meta || meta.ws !== params.ws) fail(404, 'not_found', 'File not found');
  if (meta.u !== id.uuid) fail(403, 'forbidden', 'Only the person who uploaded a file can remove it');
  const held = 'This file is attached to a message; delete the message instead';
  if (meta.refs === undefined || Number(meta.refs) > 0) fail(409, 'in_use', held);
  if ((await queuedFilesReader(params.ws)()).has(params.id)) fail(409, 'in_use', 'This file is waiting to go out with a scheduled message; edit that message instead');
  if (bookmarkedFiles(ws).has(params.id)) fail(409, 'in_use', 'This file is bookmarked in a channel; remove the bookmark instead');
  const res = await kv().incr(KEYS.file(params.id), { refs: -1 });
  const refs = Number(res && typeof res === 'object' ? res.refs : res);
  if (!(refs < 0)) {
    // A hold landed between the read and the count (a post naming the file
    // in the same instant), or the store handed back no count to go by: the
    // count goes back and the file stays.
    await kv().incr(KEYS.file(params.id), { refs: 1 }).catch(() => {});
    if (Number.isNaN(refs)) fail(500, 'internal', 'The file could not be removed right now; try again in a moment');
    fail(409, 'in_use', held);
  }
  await fs().delete(`teamchat-files/${params.ws}/${params.id}`).catch(() => {});
  await kv().del(KEYS.file(params.id)).catch(() => {});
  return { ok: true };
}));

/* ---- fallthrough ------------------------------------------------------- */

router.get('/*path', route(async () => fail(404, 'not_found', 'No such endpoint')));
router.post('/*path', route(async () => fail(404, 'not_found', 'No such endpoint')));
