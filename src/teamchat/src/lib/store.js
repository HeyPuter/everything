/**
 * Client state: the signed-in user (profile, preferences, workspace list,
 * their own worker), the open workspace, per-conversation message windows,
 * read cursors, presence, and the sync loop that keeps it all fresh by
 * polling one small activity document.
 *
 * Workspaces live on their owners' workers, so the store addresses them by
 * reference (`{wsId}@{server}`); `wsId` below is always such a reference.
 * What belongs to the user alone lives in their own Puter KV (lib/user.js).
 *
 * Views subscribe with store.on(event, fn). Events:
 *   'profile'            profile, preferences, or workspace list changed
 *   'workspace'          workspace doc (channels, members) or member doc changed
 *   'activity'           unread / presence data changed
 *   'messages'           detail: { conv, reason }  a conversation window changed
 *   'error'              detail: ApiError (sync failures, surfaced sparingly)
 *   'notice'             detail: string, something worth a toast
 *   'huddle'             the huddles in progress, or the one this member is in, changed
 *   'huddle-media'       the huddle this member is in moved on the media side: who is speaking, a stream, a device (the dock's alone)
 *   'huddle-started'     detail: [{ conv, by, at }]  huddles that appeared since the last poll, started by others
 *   'huddle-error'       detail: { kind, message }  a device or the join could not be had
 */
import { api, ApiError } from './api.js';
import { KEYS, threadConvId, parentOfThread, blockIndexOf, firstSeqOfBlock, BLOCK_SIZE, mergeBlock, applyOverlayPatch } from '../shared/blocks.js';
import { colorSlot, uid } from '../shared/ids.js';
import { presenceState, PRESENCE_WINDOW_MS } from './time.js';
import { clearAvatarCache } from './avatars.js';
import { defaultLevel, notificationsPaused } from './notify.js';
import { typingSignal, TYPING_TTL_MS } from './typing.js';
import { firstUnfurlableLink } from '../shared/limits.js';
import { previewText, cutText } from './format.js';
import { idb } from './idb.js';
import { createOutbox, layeredStorage, makeClientId } from './outbox.js';
import { clearDrafts, forgetDrafts } from './drafts.js';
import { clearRecent, forgetWorkspaceRecent } from './recent.js';
import { pushPrefs, pushOffsetMoved, _notePushOffset, listenForPushes, stopListeningForPushes, puterPushStatus, enablePuterPush, disablePuterPush, retireLegacyPush, dismissShown, isIos, isStandalone } from './pwa.js';
import { notificationsSupported, notificationsGranted } from './notify.js';
import { loadUserDoc, saveUserDoc } from './user.js';
import { makeRef, parseRef, canonicalRef, serverKeyOf, trustServer } from './refs.js';
import { deployOwnWorker, findOwnWorker, updateOwnWorker, usesSharedWorker } from './deploy.js';
import { SHARED_WORKER_URL } from '../config.js';
import { Huddle } from './huddle.js';
import { HUDDLE_HEARTBEAT_MS } from '../shared/huddle.js';
import { appUidFromToken, EV_GRANT, DUE_HANDLER } from '../shared/events.js';
import { parseTag, ringKeysFrom, openEntry } from '../shared/ring.js';

/** A huddle first seen more than this long after it began is not announced as a call: it was not just placed. */
const HUDDLE_RING_MS = 5 * 60_000;
/**
 * How long a move to another server holds a workspace's writes from when
 * the nominee began it (the worker's TRANSFER_FREEZE_MS): the freeze the
 * document carries as `transferring: { by, at }` is over after this,
 * whatever the document still says (a nominee whose export died never
 * locks the workspace for good).
 */
export const TRANSFER_FREEZE_MS = 30 * 60_000;
/** How long signing out waits for the workers to be told the device's push subscription is over, all at once. */
const SIGNOUT_PUSH_MS = 4000;
/** Set once this device has been asked for notifications; after that only the switches ask. */
const NOTIFY_ASKED_KEY = 'tc:notify-asked';
/** How long a best-effort word to another worker (leaving a shared channel on its host, ending the connection, the copies of the member's card) is waited for before the app goes on without it; the request itself goes on. */
const HOST_WORD_MS = 4000;

/** `promise`, or nothing after `ms`, whichever comes first; the wait is cleared when the promise settles first. */
function withinMs(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((r) => { timer = setTimeout(r, ms); })]).finally(() => clearTimeout(timer));
}

/**
 * This workspace's words to the hosts of its shared channels (a leave, a
 * disconnect, a revocation; see leaveHosts, disconnectHosts and
 * carryRevocations): the words to one host go one after another, and the
 * hosts side by side. `hostOf` names a word's host (a word with none is
 * skipped); a word that fails stops nothing, as before; with `within`, a
 * host's words are given up on after that many milliseconds together, the
 * one on its way landing if the host answers late.
 *
 * Why one after another: each such word has the host read the person's
 * record there, take the channel off its list and write the list back
 * whole. Two words about one person landing on one host in the same instant
 * (someone in two channels shared with it leaving this workspace, or removed
 * from it; this workspace, deleted, disconnecting both) each read the list
 * with both channels on it and each wrote it back less their own, so the
 * slower write put the other's channel back: the person stayed in that
 * channel by their record, counted out of it, with their card standing on
 * the host, and went on reading and writing there until their standing
 * lapsed; and when the host at last let the card go it counted them out of
 * that channel a second time, for good. Sent all at once, as they used to
 * be, the app's own words raced each other so.
 */
async function eachHost(items, hostOf, send, { within = null } = {}) {
  const byHost = new Map();
  for (const item of items) {
    const host = hostOf(item);
    if (!host) continue;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(item);
  }
  const chain = async (list) => {
    for (const item of list) {
      try {
        await send(item);
      } catch {
        /* best effort, as each word always was */
      }
    }
  };
  await Promise.allSettled([...byHost.values()].map((list) => (within ? withinMs(chain(list), within) : chain(list))));
}

/**
 * How much of a conversation one range read refreshes. A from/to read is
 * answered a few blocks at a time, so asking for a longer window comes back
 * partial; the newest part is the part on screen, and anything older keeps
 * what it already has rather than being thrown away.
 */
const REFRESH_SPAN = 3 * BLOCK_SIZE;
/** Messages loaded on each side of a permalinked one. */
const AROUND = 25;

/** The user's own photo, in their Puter drive, the copy every worker is seeded from. */
const AVATAR_FILE = 'teamchat/avatar.jpg';
/** A sidebar section's name, in UTF-16 units as the dialog's maxlength counts them (the sections live in the user's own document; no worker holds them). */
const SECTION_NAME_MAX = 40;

/**
 * `obj[key]` when the key is the object's own, else undefined. Members,
 * channels and direct messages are looked up by ids that come from links
 * and from other owners' workers: one that reads "constructor" or
 * "__proto__" must find nobody and nothing, not Object.prototype's.
 */
const own = (obj, key) => (obj && key != null && Object.hasOwn(obj, key) ? obj[key] : undefined);

/**
 * What a queued message's placeholder shows for its files (see send,
 * _restoreQueued and _syncQueued): the attachments already uploaded, and
 * after them each file still on the device as a card waiting to upload
 * (`uploading`, with no id to fetch or download by; the row renderer draws
 * it as such). The bytes themselves stay in the outbox entry. The first
 * waiting file of the entry the outbox is on (`up`, see outbox.js list) is
 * the one going up; the renderer says so of it alone.
 */
const waitingFile = (f, up = false) => ({ name: f.name, size: f.size ?? f.blob?.size ?? 0, type: f.type || f.blob?.type || '', uploading: true, ...(up ? { up: true } : {}) });
const queuedAttachments = (e) => [...(e.attachments || []), ...(e.files || []).map((f, i) => waitingFile(f, !!e.up && i === 0))];

/** A status is shown until it expires; after that it is as good as cleared. */
function liveStatus(status) {
  if (!status || (!status.text && !status.emoji)) return null;
  if (status.until && status.until <= Date.now()) return null;
  return status;
}

export const POLL_VISIBLE_MS = 4000;
/** Channel and thread windows kept beyond the open ones and the direct messages (see _evictWindows). */
const MAX_IDLE_WINDOWS = 12;
/**
 * Conversation pages kept in the offline cache (the newest page of each
 * conversation opened, see loadConversation), and how many more may gather
 * before the oldest are let go: the pruning reads the whole store, so it
 * runs once in fifty writes rather than on each (see _pruneCache).
 */
const CACHE_CONVS = 200;
const CACHE_CONVS_MARGIN = 50;
/** Retry gap when a poll is asked for while one is still running. */
const POLL_RETRY_MS = 500;
/**
 * How long a poll waits after failing, at most: the wait doubles with each
 * failure of the same kind in a row (4, 8, 16 s, then this), and the plain
 * cadence is back with the first poll that gets through, the connection's
 * return, the tab coming back into view, or the member acting (see poll and
 * _resetBackoff). Held to the plain cadence, a tab whose server was down, or
 * whose network was gone with the browser still saying online, asked every
 * four seconds for hours, on battery, and a server coming back met every
 * tab at once, every four seconds. A hidden tab's half minute is the
 * ceiling already, and stays its floor.
 */
export const POLL_BACKOFF_MAX_MS = 30_000;
/** While someone is typing in the open conversation, poll a little faster so the line keeps up. */
export const POLL_TYPING_MS = 2000;
export const POLL_HIDDEN_MS = 30_000;
const HEARTBEAT_MS = 30_000;
/** No input for this long and the tab stops standing for the person: they lapse to away (see _present). */
const IDLE_MS = 10 * 60_000;
/**
 * A heartbeat older than this no longer keeps anyone active. One number,
 * shared with the drawing of the dot itself (see time.js): held apart, the
 * tab could think itself still present while everyone else had it as away.
 */
const ACTIVE_WINDOW_MS = PRESENCE_WINDOW_MS;
/** A shared channel's host that could not be reached is tried again after this long, doubling each time up to the ceiling. */
const LINK_RETRY_MS = 10_000;
const LINK_RETRY_MAX_MS = 120_000;
/** How long to wait before again asking a host to take the member into a shared channel it does not list them in. */
const LINK_REJOIN_MS = 60_000;
/** How close to lapsing the member's standing on a host gets before the poll renews it, and how long to wait after a renewal that failed. */
const LINK_RENEW_BEFORE_MS = 60 * 60_000;
const LINK_RENEW_RETRY_MS = 5 * 60_000;

/**
 * The scheduler beneath a healthy events subscription (see "events" below):
 * a floor-of-last-resort poll rather than the plain visible cadence, since a
 * change event is expected to wake the tab well before it.
 *
 * What holds it down is not the events side but everything else the poll
 * carries. The heartbeat rides on it (HEARTBEAT_MS), and a person is shown
 * active for PRESENCE_WINDOW_MS after their last one, so this has to clear a
 * lost poll or two without them flickering away — which is why that window
 * is two and a half of these rather than the one and a half it used to be.
 * And the poll is what notices a subscription that has gone quiet
 * (EV_MISSES_TO_DEGRADE), so a slower one is a slower fallback: at this
 * cadence a dead subscription is caught in about two minutes.
 *
 * What the poll no longer has to be quick for is a scheduled message: the
 * answer says how long until the next one is due (`ndIn`), and the tab polls
 * then rather than stumbling on it (see _schedule's use of `_dueIn`).
 */
export const POLL_SAFETY_MS = 60_000;
/** Never poll faster than this on a signal, so a burst of writes collapses into one poll. */
export const SIGNAL_FLOOR_MS = 2_000;
/** Drop an events subscription after the tab has been hidden this long: a delivery a hidden tab ignores is one the member's own account still paid for. */
export const HIDDEN_UNSUB_MS = 60_000;
/** Backoff after a subscribe or a delivered onError, advancing and capped. */
export const EV_RETRY_MS = [30_000, 120_000, 600_000];
/** How long a subscription that looks live but is not delivering is given up on, before trying again. */
export const EV_DEGRADE_MS = 5 * 60_000;
/**
 * Consecutive safety polls that turn up an unsignalled change before the
 * subscription is treated as degraded. Two rather than three since the
 * safety poll slowed to POLL_SAFETY_MS: what matters is how long a tab sits
 * on a dead subscription, and that is this many polls.
 */
export const EV_MISSES_TO_DEGRADE = 2;
/**
 * A failure code meaning "not available in this region," not a transient
 * hiccup: retrying on the short ladder (EV_RETRY_MS) against a socket that
 * will keep refusing the same way for as long as the platform flag stays off
 * is pure cost with no chance of success, so these get one long, terminal
 * wait instead.
 */
export const EV_TERMINAL_CODES = new Set(['events_disabled', 'events_kv_handles_disabled']);
/**
 * The code a refused handshake actually reaches this client as, which is
 * ambiguous: the socket layer raises it both for a region that will not admit
 * an app connection at all (the "surface is off" case, since the refusal
 * carries no code of its own) and for an ordinary dropped connection. So it is
 * not terminal on sight — it becomes terminal only once the short ladder has
 * been walked to its end without a single success, which a passing network
 * blip never manages and a region with the feature off always does.
 */
export const EV_AMBIGUOUS_CODE = 'events_connection_failed';
/** The terminal backoff itself, for a code in EV_TERMINAL_CODES. */
export const EV_TERMINAL_BACKOFF_MS = 60 * 60_000;
/**
 * The code a subscription is refused with when its own subject is not
 * there: a handle revoked from the Puter GUI, or one minted against an app
 * binding that has since changed. Unlike every other failure here, retrying
 * the same descriptor can never work — the worker caches a minted handle on
 * the member's own document and hands the same one back forever — so
 * without a re-mint the tab subscribed, was refused, backed off, and polled
 * for the rest of its life while the worker never tried again.
 */
export const EV_STALE_HANDLE_CODE = 'subject_does_not_exist';

/**
 * How long a ring entry that arrives ahead of one still missing waits for it
 * before the gap is taken as lost and a poll fills it: entries on different
 * slot keys are not promised to arrive in order.
 */
export const RING_GRACE_MS = 600;
/** How long a ring shard refused on its own (while its ping subscription was taken) is left alone before it is asked for again. */
export const RING_REFUSED_MS = 60 * 60_000;
/** Keys found out of date are read again (the workspace document) at most this often. */
const RING_STALE_MS = 5000;
/** How long keys stay readable after they are replaced. */
const RING_OLD_KEYS_MS = 2 * 60_000;

/** A fresh events holder, for the workspace's own subscription or for one link's (see "events" below). */
function evHolder() {
  return {
    state: 'off', sub: null, desc: null, lastDesc: null, epoch: 0,
    retryIdx: 0, retryTimer: null, retryUntil: 0, retryDesc: null, degradedUntil: 0, misses: 0,
    reminted: null, // the dead handle a fresh one has already been asked for, so one dead handle costs at most one ask (see _onEvFailure)
    // Ring entries (see "ring entries" below): the keys (`ring`, null when
    // the host gives none), the ring shard's subscription, the last entry
    // number applied, entries waiting on an earlier one, and the queue they
    // are opened in, one at a time and in order.
    ring: null, rsub: null, lastN: null, pending: new Map(), applied: new Set(), graceTimer: null, chain: Promise.resolve(),
    sig: undefined, retrySig: undefined, noRingUntil: 0, staleAt: 0,
  };
}

/**
 * Did the host say the connection behind a shared channel is over (as
 * opposed to failing to answer at all)? A host that moved (its owner
 * transferred it) counts: the copy answering is read-only for good, and the
 * copy at the new address starts unshared (see the worker's import).
 */
function isConnectionOver(e) {
  return e instanceof ApiError && (e.code === 'connection_ended' || e.code === 'connection_lost' || e.code === 'moved');
}
/**
 * Is the member's part in one shared channel over for good, as far as this
 * workspace's vouching goes: the connection ended, or the host's admins
 * removed them (their workspace's word does not bring them back)?
 */
function isEntryOver(e) {
  return isConnectionOver(e) || (e instanceof ApiError && e.code === 'removed');
}
/** Did the host's worker say the workspace itself is gone (deleted), rather than the address not answering (`no_backend`)? */
function isHostGone(e) {
  return e instanceof ApiError && e.status === 404 && e.code === 'not_found';
}
/**
 * Did the host answer with a refusal (the channel archived there, its
 * workspace full, an attestation it would not take), as opposed to not
 * answering at all? A refusal is the host's word and stands until something
 * changes on one side; an address that does not answer is simply tried again.
 * A 401 is not the host's word either: the worker answers it whenever
 * Puter's word on who is asking cannot be had (see worker/lib.js identify),
 * which is Puter not answering the worker for a moment as often as a
 * sign-in that has lapsed, and the polls and sends refused in that moment
 * go through again on their next try (see files.js refused). Read as a
 * refusal, a shared channel said the member was not in it on the host, and
 * a join made in that moment was taken back, over a failure that was
 * Puter's and passing.
 */
function isRefusal(e) {
  // Not a 408 or a 425 either: only ever a gateway's word (the request timed
  // out on its way, or came too early) and never the worker's refusal, so
  // they pass as a 5xx does (see isPassing). Read as refusals, a queued
  // message met with one was dropped as bound for a conversation gone. Nor
  // a 429, which is passing too (see isPassing): the platform's gateway
  // holding a request back for a moment, or a worker's budget for the
  // moment (too many previews, too many uploads), and either way an answer
  // that a later try may not get. Read as a refusal, a join whose word to
  // the host was held back so was taken back here (the channel left again,
  // to be joined again by hand), and the channel said the member was not in
  // it on the host, which had not been asked. Nor any page the platform
  // answered with in the worker's place (see isPlatformPage): a refusal is
  // the worker's word, and a page carries none of it.
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && ![401, 408, 425, 429].includes(e.status) && !['no_backend', 'network', 'timeout'].includes(e.code) && !isPlatformPage(e);
}
/**
 * Might a write the worker did not take land if it were tried again later:
 * nobody answered (the network, a timeout), the worker is erroring or rate
 * limiting, the address does not answer for the moment (a worker being
 * redeployed), the platform answered in its place (see isPlatformPage), or
 * the workspace is being moved and takes no writes for a while? A refusal
 * (not a member, gone, moved for good) is not this. The outbox reads a
 * send's failure by the same rule.
 */
function isPassing(e) {
  return e instanceof ApiError && (!e.status || e.status >= 500 || e.status === 429 || e.status === 408 || e.status === 425 || e.code === 'no_backend' || (e.status === 423 && e.code === 'transferring') || isPlatformPage(e));
}
/**
 * An answer with a status but none of the worker's words: a page the
 * platform put in the worker's place (a gateway or a firewall refusing the
 * request with a 403 of its own, a maintenance page, a 5xx with a page),
 * which api.js reads by its status alone and names `http_NNN` (the worker's
 * every answer carries a code of its own; see its fail). Whatever the
 * status, it is nobody's refusal: the worker was not asked, and the next
 * try may reach it. Read as the worker's word, a firewall's 403 page on a
 * poll had the workspace forgotten as one the member had lost access to,
 * on a host's poll had the channel say the member was not in it there, on
 * a huddle's beat put the member out of the call, and on a queued message
 * set it aside with a Retry.
 */
function isPlatformPage(e) {
  return e instanceof ApiError && /^http_\d{3}$/.test(String(e.code || ''));
}
/**
 * Is a conversation's activity entry `v` (a sync's delta, a document's
 * snapshot) older than the one that stands, `cur`? The counter `s` only
 * ever grows (a deleted newest message lowers nothing), and so does the
 * overlay stamp `x`; an entry behind on either is a snapshot from before
 * the one that stands, and everything in it (the last message's time, who
 * wrote it, the pin count) is older too. Laid over what stands, it moved
 * the counter back: the sync asked for before the workspace was read afresh
 * as the connection returned (see refreshStale) is applied after that
 * document, and a message that landed between the two went off the unread
 * count until the next change in its conversation.
 *
 * Behind on the counter but ahead on the stamp is not older: the worker
 * writes the counter last, message by message, so two messages written in
 * the same moment can leave it at the lower number (see _fillSkipped), and
 * every change in the conversation after that (a reaction, an edit, a
 * reply, a pin) carries that lower number beside a newer stamp. Read as
 * older, none of them reached the window until the next message moved the
 * counter on. Such an entry is laid over what stands with the higher
 * counter kept (see _foldActivity).
 */
function olderActivity(cur, v) {
  if (!cur) return false;
  const s = v.s || 0;
  const cs = cur.s || 0;
  const x = v.x || 0;
  const cx = cur.x || 0;
  return s < cs ? x <= cx : s === cs && x < cx;
}
/** `v` laid over `cur`, the counter never moving back (see olderActivity). */
function layActivity(cur, v) {
  const next = { ...cur, ...v };
  if ((v.s || 0) < (cur?.s || 0)) next.s = cur.s;
  return next;
}
/** How long a read the worker did not take waits before it is sent again, doubling with each failure up to the ceiling (see _sendRead). */
const READ_RETRY_MS = 2000;
const READ_RETRY_MAX_MS = 60_000;
/**
 * How far before a read was taken a thread's message still counts as
 * "since the read" (see _healStuckMentions): the moment the read was taken
 * is known here within a round trip of the workers' clock (see serverNow),
 * and a reply that near the read is left to stand rather than risked.
 */
const READ_ACK_GRACE_MS = 60_000;
/** How far off its minute a scheduled time read back from the workers may sit and still be put on it (see _dueHere). */
const DUE_SNAP_MS = 5000;
/** How long a server's saved or scheduled list, once read, serves a read that may reuse it (see _laterList). */
const LATER_REUSE_MS = 30_000;

class Store extends EventTarget {
  constructor() {
    super();
    this.identity = null; // { uuid, username } from Puter
    this.user = null; // the user's own document (lib/user.js)
    this._flags = {}; // per-ref UI flags from the last reconciliation (unreachable)
    this._forgotten = new Map(); // workspace ref -> when the user's list dropped it here (see refreshWorkspaces)
    this.profile = null;
    this.workspaces = [];
    this.wsId = null;
    this.ws = null;
    this.me = null;
    this.act = { c: {}, p: {}, w: 0, u: 0 };
    this.since = 0;
    this.convs = new Map();
    this.openConv = null;
    this.openThread = null;
    this._timer = null;
    this._lastHeartbeat = 0;
    this._lastFlag = null; // what the last heartbeat said beside the timestamp ('dnd' or nothing)
    this._lastInput = Date.now(); // when the person last touched this tab (see _present)
    this._polling = false;
    this._readTimers = new Map(); // `${wsId}:${conv}` -> the debounce of a read about to be sent (see markRead)
    this._readPending = new Map(); // the same keys -> what the debounce will do, for the page going away to do it now (see _flushReads)
    this.pushStatus = 'off';
    this._localSeen = new Map(); // conv -> highest seq the user has actually seen on screen
    this._wsFetch = 0; // refreshWorkspace() calls made, and the newest one applied: answers apply in order asked
    this._wsApplied = 0;
    this._seenAt = new Map(); // conv -> { at, acked }: a read issued for it, and when the worker took it (see refreshWorkspace)
    this._readRetry = new Map(); // `${wsId}:${conv}` -> { wsId, conv, host, target, seen, attempts, nextAt }: a read the worker did not take, to be sent again (see _sendRead)
    this._readAcked = new Map(); // conv -> { target, x, at }: the last read the worker took here, and how the conversation stood then (see _healStuckMentions)
    this._notifyPending = new Map(); // conv -> { patch, inflight, acked }: a notification setting written, until a document built after it (see refreshWorkspace)
    this._inboxRead = new Map(); // workspace ref -> { at, acked }: the Activity badge cleared there, until a document built after it
    this._unreadAt = new Map(); // conv -> { target, acked }: a mark-unread's cursor, until a document built after it
    this._typing = { at: 0, byConv: {} }; // what the last poll said about who is typing
    this._typingSignals = new Map(); // conv -> throttled signal for the user's own typing
    this._presenceSeen = ''; // who was in which presence state at the last look (see _presenceMoved)
    this._quoted = new Map(); // `${ws}:${conv}:${seq}` -> { value } or { promise }: messages read for quote cards (see quotedMessage)
    this._laterCache = new Map(); // `${kind}:${ref}` -> { p, at }: a server's saved or scheduled list as last read, for a read that may reuse it (see _laterList)
    this._reactTurns = new Map(); // `${conv}:${seq}:${reaction}` -> the toggle of it on its way to the worker (see react)
    this._clockOffset = 0; // the worker's clock minus this device's (see serverNow)
    // Other tabs of this account, by workspace: when each last sent a
    // heartbeat (they say so on a channel), so a tab that closes knows
    // whether another still keeps the person here (see _sayBye).
    this._siblingBeats = new Map();
    this._presenceChannel = null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this._presenceChannel = new BroadcastChannel('teamchat:presence');
        this._presenceChannel.onmessage = (e) => {
          const m = e.data;
          if (m && m.uuid && m.uuid === this.uuid && typeof m.ws === 'string') this._siblingBeats.set(m.ws, Date.now());
        };
      } catch {
        this._presenceChannel = null;
      }
    }
    this.offline = false; // the open workspace came from the offline cache
    // Shared channels live on other workspaces' workers: one link per host,
    // bootstrapped and polled beside the open workspace (see "shared channels" below).
    this.links = new Map();
    // Events (see "events" below): the workspace's own subscription. `state`
    // is 'off' | 'arming' | 'on'; `desc` is the bootstrap's `events` block
    // last armed with, so a refresh can tell whether anything about it
    // changed; `lastDesc` is the block last handed to this holder, kept
    // across a teardown so a hidden tab's re-arm and a degrade's recovery
    // know what to arm again; `epoch` invalidates a stale subscribe or
    // teardown racing a fresher one; `retryIdx`/`retryTimer`/`retryUntil`/
    // `retryDesc` are the one backoff a holder waits on (see _evArmRetry), a
    // wait that survives a hidden-tab teardown the same way `lastDesc` does.
    // A link carries the same shape on itself (see _syncLinks).
    this.ev = evHolder();
    // The worker's own read time (`ts`) of the last sync applied, in worker
    // clock. The sync route answers with two seconds of margin, so a change
    // it reports is reported once more by the next poll; the degradation
    // detector compares an entry's stamps against this so a re-report is not
    // mistaken for a signal that never came.
    this._evSyncAt = 0;
    // When the workspace's next scheduled item is due (see _applySync); 0 for none.
    this._dueAt = 0;
    // Set for good if a platform refuses `includeValue` on an own-mode
    // subject after all, so one refusal does not cost every later subscribe.
    this._evNoValues = false;
    this._evHiddenTimer = null;
    this._evPending = false;
    // What the next poll was scheduled for: 'cadence' unless a poke or an
    // event delivery asked for it, which the degradation detector must not
    // count as a plain safety poll (see poll()).
    this._pendingReason = 'cadence';
    this._lastPollAt = 0;
    // Polls failed in a row, and with what (see _noteFailure): the wait between polls grows with them (see POLL_BACKOFF_MAX_MS).
    this._pollFailures = 0;
    this._pollFailKind = null;
    // Huddles in progress, by local conversation id (see "huddles" below),
    // and the one this member is in, which outlives a workspace switch.
    this.huddles = {};
    this.huddle = null;
    this._huddleInfo = null;
    this._huddleTimer = null;
    this.outbox = createOutbox({
      storage: layeredStorage({ all: () => idb.all('outbox'), put: (v) => idb.put('outbox', v), del: (id) => idb.del('outbox', id) }),
      isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
      owner: () => this.identity?.uuid || null,
      // An entry for a shared channel carries the host it was written for.
      uploadFile: (ws, f, e) => api.upload(e?.host || ws, new File([f.blob], f.name, { type: f.type })),
      sendEntry: (e) => this._deliverQueued(e),
      onChange: () => {
        this._syncQueued().catch(() => {});
        this.emit('outbox');
      },
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.outbox.flush().catch(() => {});
        this._resendReads();
        // The connection is back: the next poll goes now, not at the end of
        // the wait its failures had earned (see _resetBackoff).
        this._resetBackoff(true);
      });
      // A tab closing mid-huddle gives its seat up at once; the others would
      // otherwise see it listed until its heartbeat lapses. Sent keepalive, or
      // the browser would drop the request with the page.
      window.addEventListener('pagehide', () => {
        // A read still in its debounce goes now, best effort (see _flushReads).
        this._flushReads();
        this._sayBye();
        if (!this.huddle) return;
        const info = this._huddleInfo;
        this.huddle.leave('closed');
        if (info) api.huddleLeave(info.ref, info.hostConv, { sid: info.sid, keepalive: true }).catch(() => {});
      });
    }
    if (typeof document !== 'undefined') {
      // What the person does here is what makes them present: the first
      // touch after a long stillness brings the heartbeat back with the next
      // poll, brought forward, so the dot is green again in a moment.
      const touched = () => {
        const idle = Date.now() - this._lastInput >= IDLE_MS;
        this._lastInput = Date.now();
        if (idle && this.wsId && !document.hidden) this.pokeSync();
      };
      let lastMove = 0;
      for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) document.addEventListener(ev, touched, { passive: true, capture: true });
      // Moving the pointer counts, but not at every pixel.
      document.addEventListener('pointermove', () => {
        const t = Date.now();
        if (t - lastMove < 1000) return;
        lastMove = t;
        touched();
      }, { passive: true, capture: true });
      window.addEventListener('focus', touched);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          touched();
          this._resetBackoff(); // back in view: the poll below and the ones after it on the plain cadence
        }
        // Put away (another tab, the phone's home screen), the page may be
        // gone before the debounce fires: the read goes now (see _flushReads).
        else this._flushReads();
        if (this.wsId) this._schedule(document.hidden ? POLL_HIDDEN_MS : 300);
        // Back in view after the tab's timers were slowed or stopped: the
        // seat in the huddle is kept at once rather than at the next beat.
        const info = this._huddleInfo;
        if (!document.hidden && info?.posted && Date.now() - (info.beat || 0) >= HUDDLE_HEARTBEAT_MS) this._beatHuddle();
        this._evOnVisibility();
      });
    }
  }

  on(event, fn) {
    const handler = (e) => fn(e.detail);
    this.addEventListener(event, handler);
    return () => this.removeEventListener(event, handler);
  }

  emit(event, detail) {
    this.dispatchEvent(new CustomEvent(event, { detail }));
  }

  /* ---- the user ---------------------------------------------------------- */

  /**
   * Boot: who is signed in and what they keep in their own account. Cached
   * workspace names come from the user's document; the workers are asked in
   * the background so the shell renders at once.
   */
  async loadMe() {
    const who = await puter.auth.getUser();
    if (!who || !who.uuid) throw new ApiError(401, 'unauthorized', 'Your Puter session is not valid');
    this.identity = { uuid: String(who.uuid), username: String(who.username || '').toLowerCase() };
    this._claimDevice();
    this.user = await loadUserDoc();
    this._trustOwnWorker();
    this._composeProfile();
    this._composeWorkspaces();
    this.emit('profile');
    this.refreshWorkspaces().catch(() => {});
    listenForPushes();
    this.autoEnablePush().catch((err) => console.warn('Teamchat push', err));
    return { profile: this.profile, workspaces: this.workspaces };
  }

  /**
   * Sign this device out of Puter. The push subscription is the device's,
   * not the account's: left standing, every direct message and mention to
   * the account that signed out kept arriving as banners, text and all, on
   * a computer that may be someone else's now, until some account signed in
   * and opened a workspace (only a bootstrap re-keys or drops it). Each
   * workspace's worker is told first, best effort, then the browser lets
   * the subscription go; the preference stays the account's, so the next
   * sign-in subscribes again. A huddle, if any, is left first.
   */
  async signOut() {
    await this.leaveHuddle().catch(() => {});
    // This browser's push handler and subscription go before the session
    // does. Inside the desktop disable() would revoke every device, so there
    // only the handler goes. Other devices keep their pushes either way.
    await stopListeningForPushes().catch(() => {});
    if (puter.env === 'web') await withinMs(disablePuterPush(), SIGNOUT_PUSH_MS).catch(() => {});
    await retireLegacyPush(this.workspaces.map((w) => w.ref), SIGNOUT_PUSH_MS).catch(() => {});
    await puter.auth.signOut();
  }

  /**
   * The device may have served another account before this one (a sign-out
   * and a sign-in, or a switch of Puter accounts): what that account left on
   * it unsent is not this one's to see. Drafts are dropped, and so is the
   * offline cache (the last bootstrap and pages the other account read,
   * their direct messages among them); queued messages stay in the outbox
   * for their author, who alone is shown or sends them.
   */
  _claimDevice() {
    if (typeof localStorage === 'undefined' || typeof window === 'undefined') return;
    try {
      const key = 'teamchat:identity';
      const prev = localStorage.getItem(key);
      if (prev && prev !== this.identity.uuid) {
        clearDrafts();
        clearRecent(); // where they went and what they searched for
        idb.clear('cache').catch(() => {});
      }
      localStorage.setItem(key, this.identity.uuid);
    } catch {
      /* storage unavailable */
    }
  }

  _composeProfile() {
    const p = this.user?.profile || {};
    const { uuid, username } = this.identity;
    this.profile = {
      uuid,
      username,
      name: p.name || username,
      title: p.title || '',
      color: Number.isInteger(p.color) ? p.color : colorSlot(uuid),
      avatar: p.avatar || null,
      status: liveStatus(p.status),
      prefs: { ...(this.user?.prefs || {}) },
    };
  }

  _composeWorkspaces(extra = {}) {
    this.workspaces = (this.user?.workspaces || []).map((w) => ({
      id: w.ref, ref: w.ref, name: w.name || 'Workspace', icon: w.icon || null, sample: !!w.sample,
      members: w.members, role: w.role || null, unreachable: !!extra[w.ref]?.unreachable, movedTo: w.movedTo || null,
    }));
  }

  /** The card other members see; sent along when first arriving at a worker. */
  profileSeed() {
    if (!this.profile) return undefined;
    return { name: this.profile.name, title: this.profile.title, color: this.profile.color, status: this.profile.status || null };
  }

  /**
   * Put the user's photo on a worker they have just arrived at (created or
   * joined a workspace there): the card said there is one, the bytes have
   * to follow. Best effort; the card shows initials until they do.
   */
  async _seedAvatar(url) {
    if (!this.profile?.avatar) return;
    try {
      const blob = await this._readOwnAvatar();
      if (blob) await api.uploadAvatar(url, blob);
    } catch {
      /* the next photo change tries again */
    }
  }

  /** The canonical copy of the user's photo, kept in their own drive. */
  async _readOwnAvatar() {
    try {
      const blob = await puter.fs.read(AVATAR_FILE);
      return blob && blob.size ? blob : null;
    } catch {
      return null;
    }
  }

  /** Change the photo everywhere: own drive, every worker, the card. `null` removes it. */
  async updateAvatar(blob) {
    const servers = this._servers();
    if (blob) {
      await puter.fs.write(AVATAR_FILE, blob, { overwrite: true, dedupeName: false, createMissingParents: true });
      const results = await Promise.allSettled(servers.map((url) => api.uploadAvatar(url, blob)));
      const ok = results.find((r) => r.status === 'fulfilled');
      if (!ok && servers.length) throw (results[0].reason || new Error('Could not upload the photo'));
      await this._mutateUser((doc) => { doc.profile = { ...doc.profile, avatar: Date.now() }; });
    } else {
      await Promise.allSettled(servers.map((url) => api.removeAvatar(url)));
      await puter.fs.delete?.(AVATAR_FILE).catch?.(() => {});
      await this._mutateUser((doc) => { doc.profile = { ...doc.profile, avatar: null }; });
    }
    clearAvatarCache();
    if (this.ws && this.ws.members[this.uuid]) {
      this.ws.members[this.uuid].avatar = this.profile.avatar;
      this.emit('workspace');
    }
    return this.profile.avatar;
  }

  /** Set or clear the status shown next to the user's name everywhere. */
  async updateStatus(status) {
    const next = status && (status.text || status.emoji) ? { emoji: status.emoji || '', text: status.text || '', until: status.until || null } : null;
    await this._mutateUser((doc) => { doc.profile = { ...doc.profile, status: next }; });
    if (this.ws && this.ws.members[this.uuid]) {
      this.ws.members[this.uuid].status = next;
      this.emit('workspace');
    }
    // The copies are best effort and not waited out (see updateProfile).
    await withinMs(Promise.allSettled(this._servers().map((url) => api.updateMe(url, { status: next }))), HOST_WORD_MS);
    return next;
  }

  /** A member's status, or null once it has expired. */
  statusOf(uuid) {
    return liveStatus(this.member(uuid).status);
  }

  /**
   * Change the user's document and save it. The document is re-read first
   * and the change applied to the fresh copy, so two tabs or devices with
   * different ideas of the list never overwrite each other's work: each
   * writes its own change (add this, drop that), not its whole snapshot.
   */
  async _mutateUser(fn) {
    // One change at a time: two in flight would each re-read the same old
    // document, apply only their own change, and the second save would
    // silently drop the first (a star made a moment after another).
    const run = async () => {
      // What the account held before, to put back if the save is refused
      // (offline, the storage erroring): the change was applied to the copy
      // here first and left standing when the storage would not take it, so
      // a star, a section, a preference or the name showed as changed beside
      // the toast saying it was not, and a preference the switch showed as
      // off was in force until the page was reloaded. A copy, since with
      // the storage out of reach the change is applied to this.user itself.
      const prev = this.user ? structuredClone(this.user) : null;
      let fresh = this.user;
      try {
        fresh = await loadUserDoc();
      } catch {
        /* offline: apply to what we have */
      }
      const compose = () => {
        this._trustOwnWorker();
        this._composeProfile();
        this._composeWorkspaces(this._flags);
        this.emit('profile');
      };
      fn(fresh);
      this.user = fresh;
      compose();
      try {
        await saveUserDoc(fresh);
      } catch (e) {
        this.user = prev;
        compose();
        throw e;
      }
    };
    const turn = (this._userWrites || Promise.resolve()).then(run, run);
    this._userWrites = turn.catch(() => {});
    return turn;
  }

  /**
   * The user's own worker is reached by the URL Puter reported when it was
   * created, which may sit outside puter.work; references to it must keep
   * resolving (see refs.js: hosts named only by a link never do).
   */
  _trustOwnWorker() {
    if (this.user?.worker?.url) trustServer(this.user.worker.url);
  }

  async updateProfile(patch) {
    await this._mutateUser((doc) => {
      const next = { ...doc.profile };
      if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim();
      if (typeof patch.title === 'string') next.title = patch.title.trim();
      if (Number.isInteger(patch.color)) next.color = patch.color;
      doc.profile = next;
    });
    if (this.ws && this.ws.members[this.profile.uuid]) {
      Object.assign(this.ws.members[this.profile.uuid], {
        name: this.profile.name, title: this.profile.title, color: this.profile.color,
      });
      this.emit('workspace');
    }
    this.emit('profile');
    // Every worker the user has a workspace on keeps a copy of the card. The
    // copies are best effort (one a worker does not hear of stands old there
    // until the next change), and not waited out: a worker that hangs held
    // the dialog's "Saving" for the request's whole timeout, twenty seconds,
    // over a card saved in the account long since, and the more workspaces
    // the likelier one such worker. The requests go on and land late.
    const seed = this.profileSeed();
    await withinMs(Promise.allSettled(this._servers().map((url) => api.updateMe(url, seed))), HOST_WORD_MS);
    return this.profile;
  }

  async updatePrefs(patch) {
    await this._mutateUser((doc) => { doc.prefs = { ...doc.prefs, ...patch }; });
    if (['dnd', 'pauseUntil', 'notifyPreview'].some((k) => k in patch)) this.syncPushPrefs();
    // The dot beside the name says "do not disturb" to the others: a pause
    // set or lifted goes out with a heartbeat now (see poll), not at the next one's turn.
    if ('dnd' in patch || 'pauseUntil' in patch) this.pokeSync();
    return this.profile.prefs;
  }

  /* ---- starred conversations ------------------------------------------- */

  /**
   * Stars live in the user's own preferences, keyed by workspace, so they
   * follow the user across devices without a worker route: `prefs.starred`
   * is `{ [wsId]: [convId, ...] }` in the order they were starred.
   */
  starred() {
    return this.wsId ? this.profile?.prefs?.starred?.[this.wsId] || [] : [];
  }

  isStarred(convId) {
    return this.starred().includes(convId);
  }

  async toggleStar(convId) {
    const on = !this.isStarred(convId);
    // A conversation sits in one place: starring it takes it out of a custom section.
    await this._savePlacement(({ starred, sections }) => ({
      starred: on ? [...starred.filter((c) => c !== convId), convId] : starred.filter((c) => c !== convId),
      sections: on ? sections.map((sec) => ({ ...sec, items: sec.items.filter((c) => c !== convId) })) : null,
    }));
    return on;
  }

  /* ---- custom sidebar sections ----------------------------------------- */

  /**
   * Custom sections the user made for the sidebar:
   * `prefs.sections` is `{ [wsId]: [{ id, name, items: [convId] }] }`, kept
   * with the stars in the user's own account. A conversation is in at most
   * one section (or Starred, or its default list).
   */
  sections() {
    return this.wsId ? this.profile?.prefs?.sections?.[this.wsId] || [] : [];
  }

  sectionOf(convId) {
    return this.sections().find((sec) => sec.items.includes(convId)) || null;
  }

  async createSection(name) {
    const id = Math.random().toString(36).slice(2, 10);
    // Forty characters as the dialog counts them, cut between whole ones
    // (see cutText): cut by the count alone, a name ending in an emoji at
    // the edge kept half of it, a boxed mark in the sidebar and in the document.
    const label = cutText(String(name).trim(), SECTION_NAME_MAX);
    await this._savePlacement(({ sections }) => ({ sections: [...sections, { id, name: label, items: [] }] }));
    return id;
  }

  /** Rename a section; one deleted meanwhile (from another tab) is not brought back by the rename. */
  async renameSection(id, name) {
    const label = cutText(String(name).trim(), SECTION_NAME_MAX);
    await this._savePlacement(({ sections }) => ({ sections: sections.map((sec) => (sec.id === id ? { ...sec, name: label } : sec)) }));
  }

  /** Remove a section; what was in it goes back to its default list. */
  async deleteSection(id) {
    await this._savePlacement(({ sections }) => ({ sections: sections.filter((sec) => sec.id !== id) }));
  }

  /**
   * Put a conversation in a section (null: back to its default list), and
   * out of everywhere else. Into a section deleted meanwhile (from another
   * tab), it goes back to its default list rather than into a section made anew.
   */
  async moveToSection(convId, sectionId) {
    await this._savePlacement(({ starred, sections }) => {
      const next = sections.map((sec) => ({ ...sec, items: sec.items.filter((c) => c !== convId) }));
      const target = sectionId ? next.find((sec) => sec.id === sectionId) : null;
      if (target) target.items.push(convId);
      return { sections: next, starred: starred.includes(convId) ? starred.filter((c) => c !== convId) : null };
    });
  }

  /**
   * Save a change to this workspace's stars and sections: `change` is given
   * the two arrays as a document has them and answers the arrays to write
   * (null leaves one alone; an empty one drops the workspace's entry). It is
   * applied to this tab's copy at once, so the sidebar and header redraw,
   * and then to the document read afresh in _mutateUser, so what another
   * tab wrote since this tab's copy was made stands: a section it deleted
   * stays deleted, a conversation it moved stays moved, a star it set stays
   * set. Written as this tab's copy of the arrays, a rename or a move here
   * brought a section deleted there back, and a star here dropped one set
   * there, until the next reload. Only this workspace's entries are
   * written either way: the whole map from this device's copy would erase
   * what another device starred in some other workspace since.
   */
  async _savePlacement(change) {
    const wsId = this.wsId;
    const apply = (prefs) => {
      const next = { ...(prefs || {}) };
      const out = change({ starred: next.starred?.[wsId] || [], sections: next.sections?.[wsId] || [] });
      for (const k of ['starred', 'sections']) {
        if (!out[k]) continue;
        const all = { ...(next[k] || {}) };
        if (out[k].length) all[wsId] = out[k];
        else delete all[wsId];
        next[k] = all;
      }
      return next;
    };
    // Optimistic: the sidebar and header redraw at once, the write follows.
    if (this.profile) this.profile.prefs = apply(this.profile.prefs);
    this.emit('profile');
    await this._mutateUser((doc) => { doc.prefs = apply(doc.prefs); });
  }

  get uuid() {
    return this.profile?.uuid || null;
  }

  /** Distinct worker URLs the user has workspaces on (plus their own). */
  _servers() {
    const urls = new Set();
    for (const w of this.user?.workspaces || []) {
      const r = parseRef(w.ref);
      if (r) urls.add(r.url);
    }
    if (this.user?.worker?.url) urls.add(this.user.worker.url);
    // The hosts of the shared channels the open workspace is in keep a card
    // for the member too (the other hosts get the profile with the next
    // attestation their client presents).
    for (const link of this.links.values()) {
      const r = link.loaded ? parseRef(link.ref) : null;
      if (r) urls.add(r.url);
    }
    return [...urls];
  }

  /**
   * Ask every worker which of its workspaces the user is in, and make the
   * cached list match: workspaces the user was removed from (or that were
   * deleted) drop out, renamed ones update. A worker that does not answer
   * keeps its cached entries, marked unreachable. Also the moment an owner's
   * worker is found to run an older build than the app ships.
   */
  async refreshWorkspaces() {
    if (!this.user) return;
    const urls = this._servers();
    if (!urls.length) return;
    // Only what was on the list when the servers were asked may be dropped
    // on their answer: a workspace joined while the requests were in flight
    // is not in a reply computed before the join, and must stay. And only
    // what was not dropped from the list meanwhile may be added on it: a
    // workspace left while the requests were out (by hand, or on the
    // worker's word that the member was removed) is in a reply computed
    // before the leave, and must not come back (see forgetWorkspace).
    const asked = new Set(this.user.workspaces.map((w) => w.ref));
    const startedAt = Date.now();
    const results = await Promise.allSettled(urls.map((url) => api.me(url)));
    if (!this.user) return;
    const flags = {};
    const upserts = [];
    const drop = new Set();
    urls.forEach((url, i) => {
      const server = serverKeyOf(url);
      const res = results[i];
      if (res.status === 'fulfilled' && res.value && Array.isArray(res.value.workspaces)) {
        const listed = new Set();
        for (const ws of res.value.workspaces) {
          const ref = makeRef(ws.id, server);
          listed.add(ref);
          upserts.push({ ref, name: ws.name, icon: ws.icon || undefined, sample: !!ws.sample, members: ws.members, role: ws.role || undefined, movedTo: ws.movedTo || undefined });
        }
        // Anything we had on this server that it no longer lists us in is gone.
        for (const w of this.user.workspaces) {
          if (asked.has(w.ref) && parseRef(w.ref)?.server === server && !listed.has(w.ref)) drop.add(w.ref);
        }
        if (this.user.worker && this.user.worker.url === url) this._maybeUpdateOwnWorker(res.value.build, res.value.builtAt);
      } else {
        for (const w of this.user.workspaces) if (parseRef(w.ref)?.server === server) flags[w.ref] = { unreachable: true };
      }
    });
    this._flags = flags;
    const apply = (doc) => {
      doc.workspaces = doc.workspaces.filter((w) => !drop.has(w.ref));
      for (const u of upserts) {
        const i = doc.workspaces.findIndex((w) => w.ref === u.ref);
        if (i > -1) doc.workspaces[i] = { ...doc.workspaces[i], ...u };
        else if ((this._forgotten.get(u.ref) || 0) < startedAt) doc.workspaces.push(u);
      }
    };
    const probe = { workspaces: this.user.workspaces.map((w) => ({ ...w })) };
    apply(probe);
    if (JSON.stringify(probe.workspaces) !== JSON.stringify(this.user.workspaces)) {
      await this._mutateUser(apply).catch(() => {});
    } else {
      this._composeWorkspaces(flags);
      this.emit('profile');
    }
  }

  async _maybeUpdateOwnWorker(reportedBuild, reportedBuiltAt = 0) {
    if (usesSharedWorker() || !this.user?.worker || this._updating) return;
    this._updating = true;
    try {
      const build = await updateOwnWorker(this.user.worker, reportedBuild, reportedBuiltAt);
      if (build) {
        await this._mutateUser((doc) => { doc.worker = { ...(doc.worker || this.user.worker), build, updatedAt: Date.now() }; }).catch(() => {});
        this.emit('notice', 'Your workspace server was updated to the latest version');
      }
    } finally {
      this._updating = false;
    }
  }

  /* ---- workspaces: create, join, forget --------------------------------- */

  /**
   * The worker new workspaces go on: the configured shared one, or the user's
   * own, created now if they have none. `onProgress(text)` narrates the deploy.
   */
  async ensureOwnWorker(onProgress) {
    if (usesSharedWorker()) return { url: SHARED_WORKER_URL, server: serverKeyOf(SHARED_WORKER_URL), shared: true };
    if (this.user.worker?.url) return { ...this.user.worker, server: serverKeyOf(this.user.worker.url) };
    // One deploy at a time, in this tab and across the tabs of this browser
    // (a Web Lock, where there is one): two tabs each creating their first
    // workspace at once each deployed a worker of their own, and the one
    // recorded last was the only one kept, the other left in the account
    // unused. The document is read afresh in turn, since another tab may
    // have recorded a worker meanwhile, and a worker recorded first stays
    // recorded, whatever this call found or made.
    const run = async () => {
      const fresh = await loadUserDoc().catch(() => null);
      let worker = fresh?.worker?.url ? fresh.worker : null;
      if (!worker) worker = await findOwnWorker();
      if (!worker) worker = await deployOwnWorker({ onProgress });
      let kept = worker;
      await this._mutateUser((doc) => {
        if (doc.worker?.url) kept = doc.worker;
        else doc.worker = worker;
      });
      return { ...kept, server: serverKeyOf(kept.url) };
    };
    const locked = () => (typeof navigator !== 'undefined' && navigator.locks?.request ? navigator.locks.request('teamchat:own-worker', run) : run());
    const turn = (this._ensuringWorker || Promise.resolve()).then(locked, locked);
    this._ensuringWorker = turn.catch(() => {});
    return turn;
  }

  async _addWorkspace({ ref, name, sample, icon }) {
    ref = canonicalRef(ref) || ref; // one spelling per workspace on the list (see openWorkspace)
    this._forgotten.delete(ref); // joined (again): the servers' next answer may list it
    await this._mutateUser((doc) => {
      const i = doc.workspaces.findIndex((w) => w.ref === ref);
      const entry = { ref, name, sample: !!sample };
      if (icon) entry.icon = icon;
      if (i > -1) doc.workspaces[i] = { ...doc.workspaces[i], ...entry };
      else doc.workspaces.push(entry);
    }).catch(() => {});
  }

  async createWorkspace(name, onProgress) {
    const target = await this.ensureOwnWorker(onProgress);
    onProgress?.('Creating the workspace');
    const { workspace } = await api.createWorkspace(target.url, name, this.profileSeed());
    const ref = makeRef(workspace.id, target.server);
    await this._addWorkspace({ ref, name: workspace.name });
    this._seedAvatar(target.url).catch(() => {});
    return { workspace: { id: ref, name: workspace.name } };
  }

  /** Create a separate demo workspace using the worker's fictional teammates and history. */
  async createSampleWorkspace() {
    if (!this.user || !this.profile) throw new Error('Sign in and wait for Teamchat to finish loading before populating sample data.');
    const target = await this.ensureOwnWorker();
    const { workspace } = await api.createSampleWorkspace(target.url, this.profileSeed());
    const ref = makeRef(workspace.id, target.server);
    await this._addWorkspace({ ref, name: workspace.name, sample: true });
    this._seedAvatar(target.url).catch(() => {});
    return { workspace: { ...workspace, id: ref } };
  }

  /** Accept an invite issued by the worker at `server`. */
  async join(server, code) {
    const r = parseRef(`000000@${server}`);
    if (!r) throw new ApiError(400, 'bad_ref', 'That invite names a server address that is not valid');
    const res = await api.join(r.url, code, this.profileSeed());
    const ref = makeRef(res.workspace.id, r.server);
    await this._addWorkspace({ ref, name: res.workspace.name });
    this._seedAvatar(r.url).catch(() => {});
    return { ...res, workspace: { ...res.workspace, id: ref } };
  }

  /** Drop a workspace from the user's list (left, removed, or deleted). */
  async forgetWorkspace(ref) {
    ref = canonicalRef(ref) || ref; // by whatever spelling it was named (see openWorkspace)
    this._forgotten.set(ref, Date.now());
    // Stop notifications if membership still stands on an unreachable worker.
    api.pushUnregister(ref).catch(() => {});
    // A huddle the member is in there ends now. The call outlives a switch
    // of workspace by design (see joinHuddle), but not the workspace itself:
    // left to the next heartbeat's refusal, it went on for up to fifteen
    // seconds after Leave (or the worker's word that the member was out),
    // microphone open, the dock still up, in a workspace the member was no
    // longer in, and then ended with the words for a refusal rather than as
    // a leave. The seat is given up best effort, as any word to a server
    // the member has just left; the call itself ends at once.
    if (this._huddleInfo?.ws === ref) this.leaveHuddle().catch(() => {});
    // Reads waiting to be sent to it again (see _sendRead) have nowhere to
    // go: kept, they went out to its server at every sync of every other
    // workspace, for good when that server had gone away without a word.
    for (const [key, r] of [...this._readRetry]) if (r.wsId === ref || r.host?.ref === ref) this._readRetry.delete(key);
    // And a read still waiting its moment (see markRead): sent after this,
    // it would only be refused, or, from a server gone without a word, kept
    // to be sent again for good, past the sweep above.
    for (const [key, t] of [...this._readTimers]) {
      if (!key.startsWith(`${ref}:`)) continue;
      clearTimeout(t);
      this._readTimers.delete(key);
      this._readPending.delete(key);
    }
    await this._mutateUser((doc) => {
      doc.workspaces = doc.workspaces.filter((w) => w.ref !== ref);
      // Its stars and sidebar sections go with it: kept, every workspace
      // left or lost stayed in the account's document as lists of
      // conversation ids nothing could open, for good; what the member has
      // on a rejoin is what they had at the time, as with the drafts below.
      for (const k of ['starred', 'sections']) if (doc.prefs?.[k] && Object.hasOwn(doc.prefs[k], ref)) delete doc.prefs[k][ref];
    }).catch(() => {});
    // Messages queued for it would only be refused now, and sit in the
    // outbox for good (shown again, failed, on a rejoin).
    this.outbox.forget(ref).catch(() => {});
    // What this device kept for it goes the same way: its drafts (half a
    // thought for a conversation nothing can send into, back in place on a
    // rejoin months later), and its history menu and recent searches.
    forgetDrafts(ref);
    forgetWorkspaceRecent(ref);
    // And what the device saved of it for reading offline: its last
    // bootstrap and the newest page of each conversation opened there (see
    // _afterBootstrap and loadConversation). Left, the bootstrap of every
    // workspace left or lost stayed in the browser's database for good (the
    // pruning counts the pages alone and never reaches a bootstrap; see
    // _pruneCache), its members and channels readable on the device by
    // someone no longer in it, and its pages until the pruning happened to
    // reach them.
    await this._forgetCache(ref);
  }

  /** Drop the offline cache of one workspace: its bootstrap and its conversation pages. Best effort: a database that cannot be read right now keeps them until another account's sign-in clears the store. */
  async _forgetCache(ref) {
    try {
      const keys = (await idb.keys('cache')) || [];
      for (const k of keys) if (k === `ws:${ref}` || (typeof k === 'string' && k.startsWith(`conv:${ref}:`))) await idb.del('cache', k);
    } catch {
      /* the device's store is not to be had right now */
    }
  }

  async noteWorkspaceName(ref, name) {
    await this._noteWorkspace(ref, { name });
  }

  /**
   * Update the cached entry of a workspace in the user's list (its name or
   * icon version, after a change made here) so the switcher is right before
   * the workers are next asked. A null value drops the field, as a worker's
   * answer without it would.
   */
  async _noteWorkspace(ref, patch) {
    ref = canonicalRef(ref) || ref;
    await this._mutateUser((doc) => {
      const w = doc.workspaces.find((x) => x.ref === ref);
      if (!w) return;
      for (const [k, v] of Object.entries(patch)) {
        if (v == null) delete w[k];
        else w[k] = v;
      }
    }).catch(() => {});
  }

  /**
   * Admins: set the open workspace's icon on its worker (`blob`, already
   * square and small), or clear it (`null`). The mark everywhere follows at
   * once; other members' apps pick it up on their next poll.
   */
  async updateWorkspaceIcon(blob) {
    const ref = this.wsId;
    const res = blob ? await api.uploadWorkspaceIcon(ref, blob) : await api.removeWorkspaceIcon(ref);
    const icon = res.icon || null;
    if (this.ws && this.wsId === ref) {
      this.ws.icon = icon;
      this.emit('workspace');
    }
    await this._noteWorkspace(ref, { icon });
    return icon;
  }

  /* ---- workspace -------------------------------------------------------- */

  async openWorkspace(wsId) {
    // Under the one spelling of its reference (see refs.js canonicalRef): a
    // link typed or pasted with capitals, or with the server's long name,
    // names the same workspace, and opened under it as written the
    // workspace was listed a second time under that spelling (until the
    // servers' next answer pruned it), was not the one the switcher marked,
    // and its reads, drafts and queued messages were filed under a name
    // nothing else used.
    wsId = canonicalRef(wsId) || wsId;
    if (this.wsId !== wsId) {
      this.stopPolling();
      this.convs.clear();
      // Direct message ids are derived from their members, so the same pair
      // of people share one id across workspaces: what was seen in one must
      // not count as seen in the next.
      this._localSeen.clear();
      this._seenAt.clear();
      this._readAcked.clear();
      this._notifyPending.clear();
      this._inboxRead.clear();
      this._unreadAt.clear();
      this.openConv = null;
      this.openThread = null;
      this.since = 0;
      this.ws = null;
      this.me = null;
      this.act = { c: {}, p: {}, w: 0, u: 0 };
      this._typing = { at: 0, byConv: {} };
      this._typingSignals.clear();
      this._presenceSeen = '';
      // The heartbeat is per workspace: the next one goes to the one being opened.
      this._lastHeartbeat = 0;
      this.links = new Map();
      // stopPolling(), just above, already tore down the old subscription;
      // a fresh workspace starts this one's bookkeeping (backoff, misses,
      // degrade window) from scratch rather than carrying over the last one's.
      this.ev = evHolder();
      this._evSyncAt = 0;
      clearTimeout(this._evHiddenTimer);
      this._evHiddenTimer = null;
      this._evPending = false;
      this.huddles = {};
      this._pins = new Map();
      this._laterCache = new Map();
      this._saved = null;
      this._savedDone = new Set();
      this._savedCount = 0;
      this._scheduledCount = 0;
      this._reminderCount = 0;
    }
    this.wsId = wsId;
    // Opened, it is not forgotten (a link can open a workspace left before,
    // whose leaving the list never recorded): its reads go out again as any
    // workspace's (see _sendRead), and the servers' next answer may list it.
    this._forgotten.delete(wsId);
    // A tab in view is present from the moment the workspace opens, not from
    // its first poll a few seconds later: the bootstrap carries the heartbeat.
    const present = this._present();
    const flag = present ? this._presenceFlag() : null;
    // The bootstrap takes its place among the document refreshes, which
    // apply in the order asked (see refreshWorkspace): one asked before it
    // (before a switch away and back, say) and landing after it would
    // otherwise lay its older document over this fresher one; and the same
    // goes for this bootstrap itself when a later-asked one (the return of
    // a switch away and straight back) has been applied by the time its
    // slow answer lands.
    const n = ++this._wsFetch;
    const startedAt = Date.now();
    let data;
    try {
      data = await api.workspace(wsId, { heartbeat: present, state: flag });
    } catch (e) {
      // No network: the last bootstrap this device saw, read-only, so the
      // installed app opens to something rather than an error.
      const cached = e instanceof ApiError && (e.code === 'network' || e.code === 'timeout') ? await idb.get('cache', `ws:${wsId}`) : null;
      if (!cached) throw e;
      if (this.wsId !== wsId || n < this._wsApplied) return null;
      this.offline = true;
      this._applyBootstrap(cached.data);
      this.startPolling();
      this._restoreQueued();
      return cached.data;
    }
    if (this.wsId !== wsId || n < this._wsApplied) return null; // switched away meanwhile, or a fresher document has been applied since
    this._wsApplied = n;
    if (present) this._beat(wsId, flag);
    this._afterBootstrap(wsId, data, startedAt);
    this.startPolling();
    this._restoreQueued();
    // A link can open a workspace the list does not know yet (a fresh device,
    // a lost document): remember it.
    if (this.user && !this.user.workspaces.some((w) => w.ref === wsId)) {
      this._addWorkspace({ ref: wsId, name: data.workspace.name, sample: data.workspace.sample }).catch(() => {});
    }
    return data;
  }

  /**
   * A bootstrap answered by the worker (not the cache): the clock it
   * carries, the answer cached for next time offline, and the side state a
   * connection makes possible (the outbox, the push subscription, the Later
   * counts). Shared by opening a workspace and by coming back online from a
   * cached one, whose loads all failed quietly while the network was away.
   * `startedAt` is when the document was asked for (see _applyBootstrap).
   */
  _afterBootstrap(wsId, data, startedAt = Date.now()) {
    this.offline = false;
    this._learnClock(data.now); // (not from the cache: its clock is as old as it is)
    this._applyBootstrap(data, startedAt);
    idb.put('cache', { key: `ws:${wsId}`, data, ts: Date.now() }).catch(() => {});
    this.outbox.flush().catch(() => {});
    this._resendReads();
    // While the settings toggle is mid-flight the preference still reads as
    // the old state, so this reconciliation would work against the very
    // change being made. The toggle finishes its own work.
    if (!this._pushToggling) this._reconcilePush(wsId, data.me?.pn).catch(() => {});
    this.loadSaved().catch(() => {});
    this.loadScheduled().catch(() => {});
  }

  /**
   * Lay a bootstrap document over the store. `startedAt`, when it was asked
   * for: what this device wrote after that (a mark-unread, a setting, the
   * Activity badge cleared, a read) is kept over it, as refreshWorkspace
   * keeps it over a refetch (see _keepPendingOver). A workspace opened anew
   * has nothing pending; one read again as the connection returns, or
   * opened again while it is open, may.
   */
  _applyBootstrap(data, startedAt = Date.now()) {
    // What the hosts of shared channels have said stands: this document is
    // this workspace's own and says nothing of their conversations (see
    // _linkedState). Read afresh with the hosts already loaded (the
    // connection back, see refreshStale), it put the shared channels'
    // counters, their huddles and their people's heartbeats out of the
    // store, and the hosts' polls, which bring only what has moved since,
    // did not bring them back: a shared channel unread past the reader's
    // cursor lost its bold and its count until something new was said there.
    const linked = this._linkedState();
    this.ws = data.workspace;
    this.me = data.me;
    this.act = { c: { ...linked.c, ...(data.activity.c || {}) }, p: linked.p, ps: linked.ps, w: data.activity.w || 0, u: data.activity.u?.[this.uuid] || 0 };
    this._mergePresence(data.activity.p, data.activity.ps);
    this.since = (data.now || Date.now()) - 2000;
    this._evSyncAt = data.now || Date.now();
    // What is in progress when the workspace opens is shown, not announced.
    this.huddles = { ...linked.h, ...(data.activity.h || {}) };
    this._healStuckMentions(Object.entries(data.activity.c || {}), this.wsId);
    this._keepPendingOver(startedAt, this.wsId);
    this._evSetOwn(this.wsId, data.events || null, data.ring || null);
    this._syncLinks();
    this._presenceMoved();
    this.emit('workspace');
    this.emit('activity');
    this.emit('huddle');
    this._rosterToHuddle();
    this._dropGoneQueued().catch(() => {});
  }

  /**
   * What the hosts of shared channels have said, as it stands here under
   * local ids, for a fresh document of this workspace to be laid beside
   * rather than over (see _applyBootstrap): the entries of their
   * conversations (the channels shared from them, the direct messages
   * carried from them), the huddles in progress there, and everyone's last
   * heartbeat, the hosts' people included, which the document's are merged
   * into as a poll's are (see _mergePresence). Read before the document
   * replaces the workspace and member documents, since a direct message on
   * a host is known as such by the member document alone.
   */
  _linkedState() {
    const out = { c: {}, h: {}, p: { ...(this.act.p || {}) }, ps: { ...(this.act.ps || {}) } };
    for (const [conv, v] of Object.entries(this.act.c || {})) if (this.hostOf(conv).link) out.c[conv] = v;
    for (const [conv, h] of Object.entries(this.huddles || {})) if (this.hostOf(conv).link) out.h[conv] = h;
    return out;
  }

  /**
   * The refresh that follows a change the worker has already taken (a rename,
   * a rotated invite, a member added): the change is done whatever this
   * fetch does, so a failure here must not read as the change failing. Never
   * throws; the caller carries on to its success path (closing, redrawing,
   * saying so) and the poll heals whatever this fetch missed. Awaiting the
   * throwing form after a successful write toasted "Could not reach the
   * workspace server" over a rename that went through, kept a replaced
   * invite's dead predecessor on screen to be copied, and hid a bot's
   * one-time token behind a retry that would have minted a second bot.
   */
  refreshAfterChange() {
    return this.refreshWorkspace().catch(() => {});
  }

  async refreshWorkspace() {
    if (!this.wsId) return;
    const startedAt = Date.now();
    const n = ++this._wsFetch;
    const wsId = this.wsId;
    const data = await api.workspace(wsId);
    // The whole reference, not the id alone: a transfer keeps the id, so the
    // read-only copy a workspace left behind and its new home share one,
    // and the copy's answer landing after the new home opened must not be
    // laid over it.
    if (!this.ws || this.wsId !== wsId || data.workspace.id !== parseRef(wsId)?.id) return;
    // Answers apply in the order they were asked, whatever order they land
    // in. The poll's refetch and the refresh after a change overlap all the
    // time (join a channel while a slow refetch is out), and the older
    // answer landing last put the document back a step: the channel just
    // joined left the sidebar, a rename reverted, until the next poll saw
    // the stamps disagree and fetched again.
    if (n < this._wsApplied) return;
    this._wsApplied = n;
    this._learnClock(data.now);
    // Keep the newest activity we already know, apply the doc updates.
    this.ws = data.workspace;
    this.me = data.me;
    this.act.w = data.activity.w || this.act.w;
    this.act.u = data.activity.u?.[this.uuid] || this.act.u;
    for (const [conv, v] of Object.entries(data.activity.c || {})) {
      const cur = this.act.c[conv];
      if (!olderActivity(cur, v)) this.act.c[conv] = layActivity(cur, v);
    }
    this._healStuckMentions(Object.entries(data.activity.c || {}), this.wsId);
    this._keepPendingOver(startedAt, this.wsId);
    this._evSetOwn(this.wsId, data.events || null, data.ring || null);
    this._syncLinks();
    this.emit('workspace');
    this.emit('activity');
    this._setHuddles(this._huddlesWith(data.activity.h, null));
    this._dropGoneQueued().catch(() => {});
  }

  /**
   * What this device changed but a document requested before the change
   * landed does not show, kept over that document — until one requested
   * after the write was acknowledged, which is trusted. Neither route bumps
   * a stamp that would bring a corrected document on its own. `ref`
   * is the workspace the document speaks for: this one for a bootstrap of
   * it, a host for a refetch of that host.
   *
   * A notification setting: the change itself is kept. The Activity badge
   * cleared: stays cleared. A mark-unread: its cursor stays where it was
   * put, under the document's.
   *
   * A read (the list reached its end as the fetch landed, or the read is
   * still in its debounce): a conversation read to its latest message
   * carries no mention badge. Only those: a mention in a thread is counted
   * on its channel, whose own messages need not have moved, and one in a
   * channel read to the end an hour ago must still show.
   *
   * Written through _setMine, so the host's document here (which
   * _mergeLinkMe lays over this workspace's again on every sync) carries
   * the same.
   */
  _keepPendingOver(startedAt, ref) {
    const ours = (conv) => this.hostOf(conv).ref === ref;
    const doc = ref === this.wsId ? this.me : this.links.get(ref)?.me;
    const inbox = this._inboxRead.get(ref);
    if (inbox) {
      if (inbox.acked && inbox.acked <= startedAt) this._inboxRead.delete(ref);
      else if (doc) doc.inbox = 0;
    }
    for (const [conv, u] of this._unreadAt) {
      if (!ours(conv)) continue;
      if (u.acked && u.acked <= startedAt) {
        this._unreadAt.delete(conv);
        continue;
      }
      this._setMine('reads', conv, Math.min(this.me.reads?.[conv] ?? u.target, u.target));
    }
    for (const [conv, p] of this._notifyPending) {
      if (!ours(conv)) continue;
      if (p.acked && p.acked <= startedAt) {
        this._notifyPending.delete(conv);
        continue;
      }
      this._setMine('notify', conv, { ...(this.me.notify?.[conv] || {}), ...p.patch });
      // Unfollowing a thread clears its unread replies as well (the worker
      // zeroes the count with the flag, and counts none for anyone who does
      // not follow): a document from before the write still carries them.
      if (p.patch.follow === false && this.me.threads?.[conv]) this._setMine('threads', conv, 0);
    }
    for (const [conv, seen] of this._seenAt) {
      if (!ours(conv)) continue;
      if (seen.acked && seen.acked <= startedAt) {
        this._seenAt.delete(conv);
        continue;
      }
      // The cursor itself, too: the document was asked for before the read
      // was taken (or before the worker had it), so it carries the cursor
      // from before, and laid over this device's it put the cursor back
      // below what was seen here. The badges count against what was seen,
      // so they stood, but a reader of the cursor (the list's "new" line)
      // saw a step back, which is how a mark-unread shows. The worker only
      // ever moves a plain read forward, so the cursor is held where the
      // read will leave it; a mark-unread made since (its own entry has just
      // put the cursor under it) is the newer word and stands.
      const local = this._localSeen.get(conv) || 0;
      const unread = this._unreadAt.get(conv);
      if (local > (this.me.reads?.[conv] || 0) && !(unread && unread.at > seen.at)) this._setMine('reads', conv, local);
      const latest = this.act.c[conv]?.s || 0;
      if (latest && (this._localSeen.get(conv) || 0) < latest) continue;
      if (this.me.mentions?.[conv]) this._setMine('mentions', conv, 0);
      if (this.me.threads?.[conv]) this._setMine('threads', conv, 0);
    }
  }

  closeWorkspace() {
    this.stopPolling();
    this.wsId = null;
    this.ws = null;
    this.me = null;
    this.links = new Map();
    this.convs.clear();
    this.emit('workspace');
  }

  /* ---- shared channels: links to the workspaces that host them ----------- */

  /**
   * A shared channel lives on its host workspace's worker;
   * this workspace holds an entry for it (`channel.shared = { ref, ch, conn,
   * host }`) and its members take part on the host as external members.
   * For every host the member is in a shared channel of, the store keeps a
   * link: the host's bootstrap as that external member (the shared channel,
   * its people, and the member's own direct messages there), polled beside
   * this workspace. What the link learns is folded into the store under
   * local ids (the entry's id for the channel, `h_` + the host's id for a
   * direct message there), so the rest of the app reads shared
   * conversations exactly as it reads local ones; writes are routed back
   * to the host by hostOf().
   */

  /** Where a conversation really lives: { ref, conv, link }. Local conversations point at this workspace. */
  hostOf(convId) {
    const thread = parentOfThread(convId);
    const base = thread ? thread.conv : convId;
    const shared = own(this.ws?.channels, base)?.shared;
    if (shared) {
      return { ref: shared.ref, conv: thread ? threadConvId(shared.ch, thread.seq) : shared.ch, link: this.links.get(shared.ref) || null, hostBase: shared.ch };
    }
    const dm = own(this.me?.dms, base);
    if (dm?.host) {
      const hostBase = base.slice(2);
      return { ref: dm.host, conv: thread ? threadConvId(hostBase, thread.seq) : hostBase, link: this.links.get(dm.host) || null, hostBase };
    }
    return { ref: this.wsId, conv: convId, link: null, hostBase: base };
  }

  /** The worker a conversation's files, photos, and messages are served from. */
  hostRef(convId) {
    return this.hostOf(convId).ref;
  }

  /** Is this a shared channel (hosted here with connections, or hosted elsewhere)? */
  isShared(convId) {
    const ch = this.channel(convId);
    return !!ch && (!!ch.shared || Object.keys(ch.connections || {}).length > 0);
  }

  /** The local id a host's conversation shows under here, or null for one this workspace does not carry. */
  _localOf(link, hostConv) {
    const thread = parentOfThread(hostConv);
    const base = thread ? thread.conv : hostConv;
    let local = link.convs.get(base) || null;
    if (!local && this._carriesDms(link) && own(link.me?.dms, base)) local = `h_${base}`;
    if (!local) return null;
    return thread ? threadConvId(local, thread.seq) : local;
  }

  /**
   * Are the member's direct messages on this host shown here? For someone
   * who is on the host only through the shared channel (an external member)
   * they are, under External connections: every person they can message
   * there was met in that channel. Someone who is a member of the host in
   * their own right has that workspace for its direct messages, which are
   * with its people about its business, not this workspace's; laid over
   * this one they would double every conversation, badge and all.
   */
  _carriesDms(link) {
    return link.me?.role === 'external';
  }

  /** Shared channel entries of this workspace, grouped by host. */
  _sharedByHost() {
    const out = new Map();
    for (const ch of Object.values(this.ws?.channels || {})) {
      if (!ch.shared) continue;
      if (!out.has(ch.shared.ref)) out.set(ch.shared.ref, []);
      out.get(ch.shared.ref).push(ch);
    }
    return out;
  }

  /**
   * Make the links match the workspace: one per host of a shared channel the
   * member has joined, loaded when new; and lay what loaded links know back
   * over a freshly fetched workspace (the overlay lives on the objects the
   * bootstrap replaced).
   */
  _syncLinks() {
    const joined = new Set(this.me?.channels || []);
    const wanted = new Set();
    for (const [ref, entries] of this._sharedByHost()) {
      if (!entries.some((c) => joined.has(c.id))) continue;
      wanted.add(ref);
      let link = this.links.get(ref);
      if (!link) {
        link = {
          ref, ws: null, me: null, act: null, since: 0, w: 0, u: 0, convs: new Map(), loaded: false, loading: null, syncing: null,
          // How the last load ended: the error, whether it means the connection
          // is over (rather than the host being out of reach), and when to try
          // again. lostConvs maps the host's channels the member is out of for
          // good (sharing ended, or they were removed) to the host's word on it;
          // rejoinAt spaces out attempts to get back into one it left us out of.
          error: null, lost: false, failures: 0, retryAt: 0, lostConvs: new Map(), rejoinAt: {},
          // This host's own events subscription (see "events" below): the
          // same shape as this.ev, kept per link since each host mints its
          // own handle.
          ev: evHolder(),
        };
        this.links.set(ref, link);
      }
      link.convs = new Map(entries.map((c) => [c.shared.ch, c.id]));
      // The connections the entries stand on. One renewed (an admin
      // reconnected the channel; the entry carries a new connection) or
      // one new to the link (another channel of the host shared here) is
      // fresh word the host has not refused: a link whose last load failed
      // is read again now, whatever wait that failure had earned it.
      const conns = new Map(entries.map((c) => [c.shared.ch, c.shared.conn]));
      if (link.conns && [...conns].some(([ch, conn]) => link.conns.get(ch) !== conn)) {
        link.retryAt = 0;
        link.failures = 0;
      }
      link.conns = conns;
      // The verdict lives on the link; every bootstrap brings fresh channel
      // objects, which carry it again from here.
      for (const c of entries) if (link.lostConvs.has(c.shared.ch)) c.lost = link.lostConvs.get(c.shared.ch);
      if (link.loaded) {
        this._overlayLinkChannels(link);
        this._mergeLinkMe(link);
      } else if (!link.loading && Date.now() >= (link.retryAt || 0)) {
        // Not before the wait its last failure earned is over (see
        // _loadLink): the workspace is read again with every change to it,
        // and a link to a host whose connection is over was read again on
        // each, the host refusing each time, two or three requests a
        // refresh for as long as the entry stood.
        this._loadLink(link).catch(() => {});
      }
    }
    for (const ref of [...this.links.keys()]) {
      if (wanted.has(ref)) continue;
      const dropped = this.links.get(ref);
      if (dropped?.ev) this._evTeardown(dropped.ev);
      this.links.delete(ref);
    }
  }

  /**
   * Bootstrap the host as this member. A 403 means the host does not (or no
   * longer) count the member in: their own workspace vouches for them with
   * an attestation, the host takes them (back) into the channel, and the
   * bootstrap is tried once more. A connection the host has ended, or a
   * host workspace that no longer exists, stays an error the channel shows;
   * a host that merely could not be reached is tried again by the poll, at
   * growing intervals. A link loaded before
   * stays so until the load fails: the channel is not taken off the screen
   * for the renewal the host asks for once a day.
   */
  async _loadLink(link) {
    if (link.loading) return link.loading;
    // Whether the host is being read for the first time (or after a load
    // that failed), as against being read again for a fresh attestation.
    const first = !link.loaded;
    let loadedNow = false; // this load brought the host up for the first time (see the finally below)
    link.loading = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Present on the host from the start too, as on the workspace itself.
          const present = this._present();
          const startedAt = Date.now();
          // Numbered among the re-reads of the host (see _refreshLink), so
          // that a re-read asked before this load and landing after it does
          // not lay its older document over the fresher one this brought.
          const n = (link.fetchN = (link.fetchN || 0) + 1);
          const data = await api.workspace(link.ref, { heartbeat: present, state: present ? this._presenceFlag() : null });
          if (this.links.get(link.ref) !== link) return;
          if (n < (link.appliedN || 0)) return; // a later-asked document has been applied since
          link.appliedN = n;
          this._applyLink(link, data, startedAt);
          this.emit('workspace');
          this.emit('activity');
          // The Later counts were read as the workspace opened, before any
          // host had answered (see _afterBootstrap): what this one keeps for
          // the member (a message saved in the shared channel, a reminder on
          // one) counts from now, not from the next opening of the Later
          // view. Read once this load has settled (see the finally below):
          // the lists are gathered from the links that are live, which a
          // link still loading is not, so asked from here the host's own
          // lists were the ones left out.
          if (first) loadedNow = true;
          return;
        } catch (e) {
          if (this.links.get(link.ref) !== link) return;
          let err = e;
          // The host's own 403 (not a page in its place, see isPlatformPage,
          // which is tried again as any failure to reach it is).
          if (e instanceof ApiError && e.status === 403 && !isPlatformPage(e) && attempt === 0) {
            const vouched = await this._attestLink(link);
            if (this.links.get(link.ref) !== link) return;
            if (vouched.ok) continue;
            err = vouched.error || e;
          }
          link.loaded = false;
          link.error = err;
          link.lost = isConnectionOver(err) || isHostGone(e);
          // Over for good, or the member removed there: the direct messages
          // they had on that host are not theirs to open any more, and
          // nothing under its conversations is unread.
          if (link.lost || isEntryOver(err)) {
            this._dropLinkActivity(link);
            this._dropLinkMe(link);
          }
          link.failures += 1;
          link.retryAt = Date.now() + Math.min(LINK_RETRY_MAX_MS, LINK_RETRY_MS * 2 ** (link.failures - 1));
          this.emit('workspace');
          return;
        }
      }
    })().finally(() => {
      link.loading = null;
      if (loadedNow && this.links.get(link.ref) === link) {
        // The lists read as the workspace opened, a moment ago, serve for
        // every server but this host (see _laterList).
        this.loadSaved({ reuse: true }).catch(() => {});
        this.loadScheduled({ reuse: true }).catch(() => {});
      }
    });
    return link.loading;
  }

  /**
   * What a write to a host fails with once the link's reload, for the fresh
   * attestation the host asked for (403 `reattest`), did not bring the link
   * up: the reload's own failure when it is the kind that passes (the host
   * out of reach or erroring for the moment, a move under way; see
   * isPassing), so the write is retried the way any write that met it is
   * (a live send goes into the outbox, a queued one waits its turn); else
   * the host's refusal `err`, which stands, as it does for a link that is
   * gone meanwhile (the channel left).
   */
  _linkFailure(link, err) {
    return link && this.links.get(link.ref) === link && isPassing(link.error) ? link.error : err;
  }

  /** Try a host that could not be reached again now (the channel's own button). */
  retryLink(convId) {
    const { link } = this.hostOf(convId);
    if (!link || link.loaded) return Promise.resolve();
    link.error = null;
    link.retryAt = 0;
    this.emit('workspace');
    return this._loadLink(link);
  }

  /** Have this workspace vouch for the member towards the host for one shared channel, and join (or renew) there. */
  async _attestEntry(link, ch) {
    const url = parseRef(link.ref)?.url;
    if (!url) throw new ApiError(400, 'bad_ref', 'The workspace hosting this channel has an address the app cannot call');
    const att = await api.attest(this.wsId, ch.id, 'join');
    const res = await api.connectJoin(url, { conn: att.conn, token: att.token, profile: this.profileSeed() });
    link.lostConvs.delete(ch.shared.ch);
    delete ch.lost;
    return res;
  }

  /**
   * Have this workspace vouch for the member towards the host, for every
   * shared channel of that host they are in, and join (or renew) there.
   * Returns { ok, error, exp }: ok when at least one succeeded, error the
   * last failure, exp when the member's standing on the host now lapses
   * (null for someone who is a member there in their own right). A channel
   * whose connection the host says is over is marked as lost; any other
   * failure is left to be tried again.
   */
  async _attestLink(link) {
    const joined = new Set(this.me?.channels || []);
    const entries = (this._sharedByHost().get(link.ref) || []).filter((c) => joined.has(c.id));
    const url = parseRef(link.ref)?.url;
    if (!url) return { ok: false, error: new ApiError(400, 'bad_ref', 'The workspace hosting this channel has an address the app cannot call') };
    let ok = false;
    let error = null;
    let exp;
    for (const ch of entries) {
      try {
        const res = await this._attestEntry(link, ch);
        ok = true;
        if (res && 'exp' in res) exp = res.exp;
      } catch (e) {
        error = e;
        if (isEntryOver(e)) {
          link.lostConvs.set(ch.shared.ch, e);
          ch.lost = e;
        }
      }
    }
    if (ok) this._seedAvatar(url).catch(() => {});
    return { ok, error, exp };
  }

  /**
   * Renew the member's standing on a host before it lapses (the host gives
   * a day, then answers 403 to everything), so the renewal is a quiet
   * exchange in the background rather than a poll that fails first.
   */
  _renewLink(link) {
    const exp = link.ws?.members?.[this.uuid]?.exp;
    // A host that moved refuses every write, a renewal included; its copy
    // stays readable without one, and nothing is shared from it any more.
    // The expiry is the host's stamp, so it is measured against the workers'
    // clock (see serverNow), not this device's: a device an hour or more
    // behind never saw the hour approach and let the standing lapse, one
    // that far ahead renewed every five minutes all day.
    if (!exp || link.ws?.movedTo || link.renewing || exp - this.serverNow() > LINK_RENEW_BEFORE_MS || Date.now() < (link.renewAt || 0)) return;
    link.renewAt = Date.now() + LINK_RENEW_RETRY_MS;
    link.renewing = this._attestLink(link).then((r) => {
      if (this.links.get(link.ref) !== link) return;
      if (r.ok && r.exp && link.ws?.members?.[this.uuid]) link.ws.members[this.uuid].exp = r.exp;
    }).catch(() => {}).finally(() => { link.renewing = null; });
  }

  _applyLink(link, data, startedAt = Date.now()) {
    link.ws = data.workspace;
    link.me = data.me;
    link.since = (data.now || Date.now()) - 2000;
    link.evSyncAt = data.now || Date.now();
    link.w = data.activity.w || 0;
    link.u = data.activity.u?.[this.uuid] || 0;
    link.loaded = true;
    link.error = null;
    link.lost = false;
    link.failures = 0;
    link.retryAt = 0;
    this._evSetLink(link, this.wsId, data.events || null, data.ring || null);
    this._mergeLinkMe(link);
    for (const [conv, v] of Object.entries(data.activity.c || {})) {
      const local = this._localOf(link, conv);
      if (!local) continue;
      const cur = this.act.c[local];
      if (!olderActivity(cur, v)) this.act.c[local] = layActivity(cur, v);
    }
    this._healStuckMentions(Object.entries(data.activity.c || {}).map(([conv, v]) => [this._localOf(link, conv), v]).filter(([local]) => local), link.ref);
    // A read or a setting of this device that the host's document predates
    // (the same care refreshWorkspace takes with this workspace's own).
    this._keepPendingOver(startedAt, link.ref);
    this._mergePresence(data.activity.p, data.activity.ps);
    this._overlayLinkChannels(link);
    // The host's huddles, under local ids: shown, not announced, as at a bootstrap.
    this.huddles = this._huddlesWith(data.activity.h, link);
    this.emit('huddle');
    this._rosterToHuddle();
  }

  /** Presence is per person, wherever it was seen: the freshest heartbeat wins. */
  _mergePresence(p, ps) {
    let changed = false;
    this.act.ps = this.act.ps || {};
    for (const [u, t] of Object.entries(p || {})) {
      if ((this.act.p[u] || 0) >= t) continue;
      this.act.p[u] = t;
      const flag = ps?.[u] || null;
      if (flag) this.act.ps[u] = flag;
      else delete this.act.ps[u];
      changed = true;
    }
    return changed;
  }

  /**
   * Write one entry of the member's own state (reads, mentions, notify,
   * threads) here and, for a conversation on a host, in the link's copy of
   * it too. The copy is laid back over this.me at every refresh of this
   * workspace, so left stale it would undo the change (a cleared mention
   * back, a mute gone) until the host happened to be read again.
   */
  _setMine(field, convId, value) {
    if (!this.me) return;
    (this.me[field] = this.me[field] || {})[convId] = value;
    const { link, conv } = this.hostOf(convId);
    if (link?.me) (link.me[field] = link.me[field] || {})[conv] = value;
  }

  /**
   * Forget what a host said about the member: its direct messages here, and
   * every cursor, count, and setting under its conversations. What the host
   * says next replaces them (see _mergeLinkMe); once the connection is over
   * (or the member was removed there) nothing does, and a direct message
   * that can no longer be read or written leaves the sidebar rather than
   * sitting there until this workspace happens to be fetched again.
   */
  _dropLinkMe(link) {
    if (!this.me) return;
    this.me.reads = this.me.reads || {};
    this.me.mentions = this.me.mentions || {};
    this.me.notify = this.me.notify || {};
    this.me.threads = this.me.threads || {};
    this.me.dms = this.me.dms || {};
    const isLinked = this._isLinkedTo(link);
    for (const conv of Object.keys(this.me.dms)) if (this.me.dms[conv]?.host === link.ref) delete this.me.dms[conv];
    for (const field of ['reads', 'mentions', 'notify', 'threads']) {
      for (const conv of Object.keys(this.me[field])) if (isLinked(conv)) delete this.me[field][conv];
    }
  }

  /** Does a local conversation id (a thread's included) belong to this host: one of its entries, or a direct message carried from it? */
  _isLinkedTo(link) {
    const ofLink = new Set(link.convs.values());
    for (const [conv, d] of Object.entries(this.me?.dms || {})) if (d?.host === link.ref) ofLink.add(conv);
    return (conv) => {
      const thread = parentOfThread(conv);
      return ofLink.has(thread ? thread.conv : conv);
    };
  }

  /**
   * Forget what a host's conversations were up to (their counters, who was
   * typing in them) once the member's cursors under them are gone for good
   * (see _dropLinkMe): a counter left standing over no cursor reads as
   * everything unread, and the row of a channel with nothing more to show
   * would sit in the sidebar in bold, as would a direct message gone from it.
   */
  _dropLinkActivity(link) {
    const isLinked = this._isLinkedTo(link);
    for (const conv of Object.keys(this.act.c)) if (isLinked(conv)) delete this.act.c[conv];
    const typing = { ...this._typing.byConv };
    let changed = false;
    for (const conv of Object.keys(typing)) if (isLinked(conv)) { delete typing[conv]; changed = true; }
    if (changed) this._setTyping(typing);
  }

  /**
   * The member's own state on the host (cursors, mentions, settings,
   * threads, direct messages), under local ids. What the host says replaces
   * what it said before rather than adding to it: a key it no longer has (a
   * mention cleared from another device, a mute lifted there, a fresh
   * document after a rejoin) would otherwise stand here, badge and all,
   * until this workspace's own document happened to be fetched again.
   */
  _mergeLinkMe(link) {
    if (!this.me || !link.me) return;
    const map = (obj, into) => {
      for (const [conv, v] of Object.entries(obj || {})) {
        const local = this._localOf(link, conv);
        if (local) into[local] = v;
      }
    };
    this._dropLinkMe(link);
    // Direct messages on the host come first: the channel map needs them to
    // translate their ids. (Only an external member's; see _carriesDms.)
    if (this._carriesDms(link)) {
      for (const [conv, d] of Object.entries(link.me.dms || {})) this.me.dms[`h_${conv}`] = { ...d, host: link.ref };
    }
    map(link.me.reads, this.me.reads);
    map(link.me.mentions, this.me.mentions);
    map(link.me.notify, this.me.notify);
    map(link.me.threads, this.me.threads);
  }

  /**
   * What the host says about the channel (topic, rules, who is in it, its
   * connections) laid over the entry here, which keeps its own id and name.
   */
  _overlayLinkChannels(link) {
    if (!link.ws) return;
    // A host that moved is the read-only copy its transfer left behind, and
    // the copy at the new address starts unshared: nothing posted through
    // the entry reaches anyone, and no attestation gets anyone back in. The
    // connection is over, in the host's own words (the gate says which), and
    // the host's admins share the channel again from its new home.
    if (link.ws.movedTo) {
      for (const hostCh of link.convs.keys()) {
        if (!link.lostConvs.has(hostCh)) link.lostConvs.set(hostCh, new ApiError(423, 'moved', `${link.ws.name || 'The workspace hosting this channel'} moved to another address; this copy is read-only`));
      }
    }
    for (const [hostCh, local] of link.convs) {
      const h = link.ws.channels[hostCh];
      const l = this.ws?.channels?.[local];
      if (!l) continue;
      // The host's own document lists the member in the channel: a verdict
      // that stood against it (the host's admins had removed them, the
      // connection was over) is behind this document, and goes. It was
      // otherwise dropped only by an attestation the host took, which a
      // host that lists the member never asks for: someone in two channels
      // shared from one host, removed from one and restored to it by the
      // host's admins, saw "an admin removed you" on it for the rest of the
      // session, with the host saying they were in it all along.
      if (h && !link.ws.movedTo && (link.me?.channels || []).includes(hostCh)) link.lostConvs.delete(hostCh);
      if (link.lostConvs.has(hostCh)) {
        l.lost = link.lostConvs.get(hostCh);
        continue;
      }
      delete l.lost;
      if (!h) {
        // The host does not have the member in this channel (a join that
        // never reached it, or a channel it has since taken back): rather
        // than call it lost on that alone, have this workspace vouch for
        // them again, at most once a minute; only the host saying the
        // connection is over makes it lost. Meanwhile the channel offers
        // Join, which does the same by hand.
        if ((this.me?.channels || []).includes(local) && Date.now() >= (link.rejoinAt[hostCh] || 0)) {
          link.rejoinAt[hostCh] = Date.now() + LINK_REJOIN_MS;
          this._attestEntry(link, l).then(() => this._refreshLink(link), (e) => {
            if (this.links.get(link.ref) !== link || !isEntryOver(e)) return;
            link.lostConvs.set(hostCh, e);
            const cur = this.ws?.channels?.[local];
            if (cur) cur.lost = e;
            this.emit('workspace');
          }).catch(() => {});
        }
        continue;
      }
      for (const k of ['topic', 'description', 'count', 'archived', 'postPolicy', 'threadPolicy', 'broadcast', 'bookmarks', 'guests', 'connections', 'createdBy', 'createdAt']) {
        if (h[k] !== undefined) l[k] = h[k];
        else delete l[k];
      }
      l.hostPrivate = !!h.private;
      l.hostName = h.name;
      // The host's name as the entry recorded it at the accept, brought up
      // to date with what the host calls itself now.
      if (link.ws.name && l.shared.host !== link.ws.name) l.shared = { ...l.shared, host: link.ws.name };
    }
  }

  /**
   * Re-read a host after its sync said something structural changed. False
   * when the host could not be read and nothing else stands in for it
   * (a 403 loads the link anew, which is a fresher read still), so the
   * poll can give the stamps back and ask again (see _applyLinked).
   */
  async _refreshLink(link) {
    try {
      const startedAt = Date.now();
      const n = (link.fetchN = (link.fetchN || 0) + 1);
      const data = await api.workspace(link.ref);
      if (this.links.get(link.ref) !== link) return true;
      if (n < (link.appliedN || 0)) return true; // an older answer landing late (see refreshWorkspace)
      link.appliedN = n;
      this._applyLink(link, data, startedAt);
      this.emit('workspace');
      this.emit('activity');
      return true;
    } catch (e) {
      if (this.links.get(link.ref) !== link) return true;
      if (e instanceof ApiError && e.status === 403 && !isPlatformPage(e)) {
        await this._loadLink(link);
        return true;
      }
      return false;
    }
  }

  /** The member's role where a conversation lives: their own here, what the host makes of them there. */
  roleIn(convId) {
    const { link } = this.hostOf(convId);
    if (!link) return this.me?.role || 'member';
    return link.me?.role || 'external';
  }

  isAdminIn(convId) {
    const role = this.roleIn(convId);
    return role === 'owner' || role === 'admin';
  }

  isLimitedIn(convId) {
    const role = this.roleIn(convId);
    return role === 'guest' || role === 'external';
  }

  /** The people a conversation can address: this workspace's members, or the host's for a shared one. */
  membersFor(convId) {
    const { link } = this.hostOf(convId);
    if (!link) return this.ws?.members || {};
    const out = {};
    for (const [uuid] of Object.entries(link.ws?.members || {})) out[uuid] = this.member(uuid);
    return out;
  }

  /** Is this uuid anyone the store knows, here or on a linked host? */
  _known(uuid) {
    if (own(this.ws?.members, uuid)) return true;
    for (const link of this.links.values()) if (own(link.ws?.members, uuid)) return true;
    return false;
  }

  /**
   * Open (or find) a direct message with someone: here for a member of this
   * workspace, on the host for someone met through a shared channel (the
   * host allows it while they share a channel). Returns { ws, conv }: the
   * workspace to open and the conversation's id there. For an external
   * member that is this workspace and the host's conversation under its
   * local id; for someone who is a member of the host in their own right it
   * is the host itself, where their direct messages live (see _carriesDms).
   */
  async openDmWith(uuid) {
    // The workspace as asked in: switched away while the worker was asked,
    // the answer names the conversation's own workspace, not the one open
    // by then (whose conversation of that id, if any, is another), and the
    // document read again to list the conversation is this workspace's,
    // where reading the other's brought it nothing.
    const wsId = this.wsId;
    const m = this.member(uuid);
    const here = !!own(this.ws?.members, uuid);
    const link = !here && m.photoRef ? this.links.get(m.photoRef) : null;
    if (!link) {
      if (!here) {
        // Someone who left (or whose workspace was disconnected): what the
        // two of you said stays readable, nothing new can be started, and
        // the worker's "pick at least one person" would explain neither.
        const had = this.dms().find((d) => d.others.length === 1 && d.others[0] === uuid);
        if (had) return { ws: wsId, conv: had.id };
        throw new ApiError(404, 'gone', `${m.name} is no longer in ${this.ws?.name || 'this workspace'}`);
      }
      const { conv } = await api.openDm(wsId, [uuid]);
      if (this.wsId === wsId && !own(this.me?.dms, conv)) await this.refreshWorkspace();
      return { ws: wsId, conv };
    }
    const { conv } = await api.openDm(link.ref, [uuid]);
    if (!this._carriesDms(link)) return { ws: link.ref, conv };
    await this._refreshLink(link); // (reads nothing for a link the switch has dropped)
    return { ws: wsId, conv: `h_${conv}` };
  }

  /** Upload an attachment where the conversation's messages live. */
  uploadFor(convId, file) {
    return api.upload(this.hostRef(convId), file);
  }

  /** Search inside one conversation, wherever it lives; result ids come back local. */
  async searchIn(convId, params = {}) {
    const host = this.hostOf(convId);
    const data = await api.search(host.ref, { ...params, in: host.conv });
    if (host.link) data.results = data.results.map((m) => ({ ...m, conv: this._localOf(host.link, m.conv) || m.conv }));
    return data;
  }

  /**
   * Join a channel: a local one here; a shared one here (so it is in the
   * sidebar and this workspace can vouch for the member) and then on the
   * host, with the attestation the join handed back.
   */
  async joinChannel(chId) {
    // The workspace as asked in (see leaveChannel): switched away while the
    // join or the host's word was out, the channel list here is the other
    // workspace's, and the join undone below must undo it where it was made.
    const wsId = this.wsId;
    const ch = this.channel(chId);
    const res = await api.joinChannel(wsId, chId);
    // The worker has taken the join: the channel is the member's from here
    // on, whatever the refresh below does (see _setJoined).
    if (this.wsId === wsId) this._setJoined(chId, true);
    if (ch?.shared && res.shared) {
      const url = parseRef(res.shared.ref)?.url;
      try {
        if (!url) throw new ApiError(400, 'bad_ref', 'The workspace hosting this channel has an address the app cannot call');
        await api.connectJoin(url, { conn: res.shared.conn, token: res.shared.token, profile: this.profileSeed() });
      } catch (e) {
        // The host would not have them (the channel archived there, its
        // workspace full, an admin's removal, the connection over): joined
        // here alone, the entry would sit in the sidebar showing a host that
        // keeps refusing, so what this workspace just recorded is undone. A
        // host that merely did not answer keeps the join: the channel waits
        // in the sidebar and the link takes them in when the host is back.
        if (!res.already && isRefusal(e)) {
          if (this.wsId === wsId) this._setJoined(chId, false);
          await api.leaveChannel(wsId, chId).catch(() => {});
        } else if (this.wsId === wsId) await this.refreshAfterChange();
        throw e;
      }
      this._seedAvatar(url).catch(() => {});
    }
    if (this.wsId !== wsId) return res;
    await this.refreshAfterChange();
    const link = ch?.shared ? this.links.get(ch.shared.ref) : null;
    if (link) await (link.loaded ? this._refreshLink(link) : this._loadLink(link));
    return res;
  }

  /**
   * The member's own channel list, changed here the moment the worker has
   * taken a join or a leave, and redrawn from. The refresh that follows
   * lays the worker's document over it; awaited in its throwing form, that
   * refresh made a join or a leave the worker had taken read as failed when
   * the GET after it could not reach the server (the Join button re-armed
   * over a channel joined, the app staying on a channel left), and the
   * poll, which the worker's stamp brings, heals what the fetch missed.
   */
  _setJoined(chId, joined) {
    if (!this.me) return;
    const list = this.me.channels || [];
    if (list.includes(chId) === joined) return;
    this.me.channels = joined ? [...list, chId] : list.filter((c) => c !== chId);
    this.emit('workspace');
  }

  /** Leave a channel; a shared one on the host first (best effort), then here. */
  async leaveChannel(chId) {
    // The workspace and channel as asked for: the huddle's leave and the
    // host's word below are waited for, and the app may be switched to
    // another workspace meanwhile. Read after them, the leave went to the
    // workspace then open, for a channel of the same id there (imported
    // workspaces keep their ids), and the one asked for was never left.
    const wsId = this.wsId;
    const ch = this.channel(chId);
    const host = ch?.shared ? this.hostOf(chId) : null;
    // Its huddle goes with the channel: a seat kept there would be refused
    // at the next heartbeat, with a word about joining the channel first.
    if (this.inHuddle(chId)) await this.leaveHuddle();
    if (host) {
      // Best effort, and not waited out: a host that hangs (overloaded, or
      // its network gone quiet) answers nothing for the request's whole
      // timeout, and the member who pressed Leave saw nothing happen for
      // twenty seconds, the channel still in the sidebar, before it was
      // left here. The word goes on its way whatever this waits for, and
      // lands if the host is back; their standing there lapses within a
      // day if it is not, as it does for a host out of reach.
      await withinMs(api.leaveChannel(host.ref, host.conv).catch(() => {}), HOST_WORD_MS);
    }
    const res = await api.leaveChannel(wsId, chId);
    // Switched away meanwhile: the leave stands on the worker, and the
    // channel list here is the other workspace's now (the one left is read
    // afresh when it is next opened).
    if (this.wsId !== wsId) return res;
    this._setJoined(chId, false);
    await this.refreshAfterChange();
    return res;
  }

  /**
   * Accept a share link for one of the member's workspaces (an admin's
   * call): the host mints the connection, this workspace records it as an
   * entry with the name chosen here, and the member joins the channel on
   * the host. Returns { ref, channel } naming the entry.
   */
  async acceptConnect({ server, code, wsRef, wsName, name, host }) {
    // One spelling of the host's server, whatever the link carried (the bare
    // worker name, or its full host): the entry's reference is compared with
    // others' by string, and the same host must never come out as two.
    const hostServer = parseRef(`000000@${server}`);
    const hostUrl = hostServer?.url;
    if (!hostUrl) throw new ApiError(400, 'bad_ref', 'That link names a server address that is not valid');
    server = hostServer.server;
    // The host itself is no partner: an admin of both sides picking it would
    // connect the channel to its own workspace.
    if (host && parseRef(wsRef)?.id === host.ws && parseRef(wsRef)?.server === server) {
      throw new ApiError(400, 'invalid', `That channel is already ${wsName || 'this workspace'}'s own; a share link is for another workspace`);
    }
    // What the workspace would refuse is settled first: accepting on the
    // host mints the connection and announces it in the channel, which must
    // not happen for a workspace that then refuses its half. Only an admin
    // can record the connection there, and the name must be free (unless it
    // is the entry for this very channel, which an accept repeated renews).
    const target = wsRef === this.wsId && this.ws && this.me
      ? { role: this.me.role, channels: this.ws.channels || {} }
      : await api.workspace(wsRef).then((d) => ({ role: d.me?.role, channels: d.workspace?.channels || {} }));
    if (target.role !== 'owner' && target.role !== 'admin') throw new ApiError(403, 'forbidden', `Only admins of ${wsName || 'that workspace'} can add a shared channel to it`);
    const sameEntry = (c) => !!host && c.shared?.ref === makeRef(host.ws, server) && c.shared?.ch === host.ch;
    if (name && Object.values(target.channels).some((c) => c.name === name && !sameEntry(c))) {
      throw new ApiError(409, 'exists', `#${name} already exists in ${wsName || 'that workspace'}; pick another name for it there`);
    }
    const acc = await api.connectAccept(hostUrl, { code, partner: { ref: wsRef, name: wsName }, profile: this.profileSeed() });
    const hostRef = makeRef(acc.workspace.id, server);
    const { channel } = await api.addSharedChannel(wsRef, {
      ref: hostRef, ch: acc.channel.id, conn: acc.conn, secret: acc.secret, name: name || acc.channel.name, host: acc.workspace.name, topic: acc.channel.topic,
    });
    // The admin is in the entry from the start; joining them on the host
    // happens when the workspace is open (the link attests on first load).
    if (this.wsId === wsRef) {
      await this.refreshWorkspace();
    } else {
      await this._addWorkspace({ ref: wsRef, name: wsName }).catch(() => {});
    }
    return { ref: wsRef, channel, host: acc.workspace };
  }

  /**
   * An admin ends this workspace's side of a connection: the host is told
   * (with a disconnect attestation, so its copy of the partner's people
   * goes at once) and the entry is removed here. The host being unreachable
   * does not stop the removal; its members expire within a day anyway.
   */
  async disconnectShared(chId) {
    // The workspace as asked in (see leaveChannel): the host's word is
    // waited for, and read after it the removal went to the workspace then
    // open, for a channel of the same id there.
    const wsId = this.wsId;
    const ch = this.channel(chId);
    if (!ch?.shared) throw new ApiError(400, 'invalid', 'Not a shared channel');
    await this._tellHostDisconnect(chId, wsId).catch(() => { /* the host's side is cleaned up by expiry, or by its own admins */ });
    // The link to the host goes with the last entry for it (refreshWorkspace
    // syncs the links); another entry for the same host keeps it as it is.
    await api.deleteChannel(wsId, chId);
    if (this.wsId === wsId) await this.refreshWorkspace();
  }

  /** Have this workspace vouch for the admin's word that the connection behind an entry is over, and tell the host. */
  async _tellHostDisconnect(chId, wsId = this.wsId) {
    const att = await api.attest(wsId, chId, 'disconnect');
    const url = parseRef(att.ref)?.url;
    if (!url) throw new ApiError(400, 'bad_ref', 'The workspace hosting this channel has an address the app cannot call');
    // Not waited out (see leaveChannel): a host that hangs held the admin's
    // Remove for the request's whole timeout before the entry went; the word
    // goes on its way and lands if the host answers late, and its copy of
    // this workspace's people expires within a day if it does not, as when
    // the host is out of reach.
    await withinMs(api.connectDisconnect(url, { conn: att.conn, token: att.token }), HOST_WORD_MS);
  }

  /**
   * Carry this workspace's word that one of its people is out of it (removed,
   * or made a guest) to the host of each channel shared with another
   * workspace they were in through this one: the worker's answer to the
   * removal (or the change of role) hands the admin's app one signed
   * revocation per such channel, since workers do not call each other, and
   * the host given it ends the person's seat now rather than a day later,
   * when their standing there would have run out. Best effort: a host out of
   * reach lets the seat lapse on its own, as it always did, and nothing is
   * said to the admin about it.
   */
  async carryRevocations(list) {
    const words = (Array.isArray(list) ? list : []).filter((r) => r && typeof r === 'object' && r.conn && r.token);
    // One host's words one after another (see eachHost): a person in two
    // channels shared with one host is the subject of two, and sent
    // together they raced each other on the host.
    await eachHost(words, (r) => parseRef(r.ref)?.url || null, (r) => api.connectRevoke(parseRef(r.ref).url, { conn: r.conn, token: r.token }));
  }

  /**
   * Before the owner deletes this workspace: end its side of every
   * connection, so each host lets this workspace's people go now and says
   * so in the channel. The worker cannot tell the hosts itself (workers do
   * not call each other), and without a word from here a host would go on
   * listing a workspace that no longer exists, with its people among the
   * channel's members until their standing lapsed and then for good. Best
   * effort: a host out of reach is cleaned up by expiry, or by its admins.
   */
  async disconnectHosts() {
    const entries = Object.values(this.ws?.channels || {}).filter((c) => c.shared);
    // One host's words one after another, and a host given up on after one
    // word's wait however many entries name it (see eachHost, and
    // _tellHostDisconnect, which bounds each word so): two channels shared
    // with one host are two words about the same people, and sent together
    // they raced each other on the host.
    await eachHost(entries, (c) => c.shared?.ref || null, (c) => this._tellHostDisconnect(c.id), { within: HOST_WORD_MS });
  }

  /**
   * Before the member leaves this workspace: leave, on their hosts, the
   * shared channels they are in through it alone (an external member there;
   * someone who is a member of the host in their own right keeps their
   * place, as they would leaving any channel of it). Their standing on each
   * host would otherwise lapse a day later, with their seat in the channel
   * counted until then and their card left behind after. Best effort.
   */
  async leaveHosts() {
    const joined = new Set(this.me?.channels || []);
    const entries = Object.values(this.ws?.channels || {}).filter((c) => c.shared && joined.has(c.id));
    // Not waited out (see leaveChannel): a host that hangs held the member's
    // Leave for the request's whole timeout; the words go on their way, and
    // a seat a host did not hear of in time lapses within a day as before.
    // One host's words one after another (see eachHost): two channels
    // shared with one host are two words about this member's one record
    // there, and sent together they raced each other on the host.
    const hosts = entries.map((c) => this.hostOf(c.id)).filter((host) => host.link?.loaded && host.link.me?.role === 'external');
    await eachHost(hosts, (host) => host.ref, (host) => api.leaveChannel(host.ref, host.conv), { within: HOST_WORD_MS });
  }

  /* ---- lookups ---------------------------------------------------------- */

  /**
   * Who a message shows as written by: an integration's message carries its
   * own name and colour and is never a member; anyone else is looked up.
   */
  author(msg) {
    if (msg?.bot) return { uuid: msg.user, name: msg.bot.name || 'App', username: 'app', color: msg.bot.color || 8, role: 'app', bot: true };
    return this.member(msg?.user);
  }

  member(uuid) {
    const m = own(this.ws?.members, uuid);
    if (m) return { uuid, ...m };
    // Someone met through a shared channel: the host's card, labelled with
    // their workspace (the host's own people with the host's name; people
    // from a third workspace with the name the host has for them).
    for (const link of this.links.values()) {
      const lm = own(link.ws?.members, uuid);
      if (lm) return { uuid, ...lm, role: 'external', org: lm.role === 'external' && lm.org ? lm.org : { name: link.ws.name, ref: link.ref }, photoRef: link.ref };
    }
    // Someone who left (or whose workspace was disconnected) keeps their
    // name on what they wrote, and their workspace's label if they had one.
    const former = own(this.ws?.former, uuid) || [...this.links.values()].map((l) => own(l.ws?.former, uuid)).find(Boolean);
    if (former) return { uuid, ...former, role: former.org ? 'external' : 'member', gone: true };
    if (uuid === this.uuid && this.profile) return { uuid, ...this.profile };
    if (/^(hook|bot)_/.test(String(uuid))) return { uuid, username: 'app', name: 'App', color: 8, role: 'app', bot: true };
    return { uuid, username: 'unknown', name: 'Former member', color: 8, role: 'member', gone: true };
  }

  membersByUsername() {
    const out = {};
    for (const link of this.links.values()) {
      for (const [uuid, m] of Object.entries(link.ws?.members || {})) out[String(m.username).toLowerCase()] = { uuid, name: m.name };
    }
    for (const [uuid, m] of Object.entries(this.ws?.members || {})) out[String(m.username).toLowerCase()] = { uuid, name: m.name };
    return out;
  }

  isAdmin(uuid = this.uuid) {
    const role = own(this.ws?.members, uuid)?.role;
    return role === 'owner' || role === 'admin';
  }

  /** Guests came in through a channel invite and see only their channels. */
  isGuest(uuid = this.uuid) {
    return own(this.ws?.members, uuid)?.role === 'guest';
  }

  channel(id) {
    return own(this.ws?.channels, id) || null;
  }

  /** Channels the user has joined, alphabetically, archived last. */
  joinedChannels() {
    const ids = new Set(this.me?.channels || []);
    return Object.values(this.ws?.channels || {})
      .filter((c) => ids.has(c.id))
      .sort((a, b) => (a.archived === b.archived ? a.name.localeCompare(b.name) : a.archived ? 1 : -1));
  }

  /**
   * Public channels the user could join. Not the entry for a channel hosted
   * elsewhere whose connection is over (`lost`, see _overlayLinkChannels):
   * the host refuses everyone this workspace sends, so a Join offered for it
   * (in Browse channels, the sidebar's filter, the count beside Browse) only
   * went round to the host and came back refused. One the member is in
   * stays in their list (see joinedChannels), to be opened and left.
   */
  browsableChannels() {
    const ids = new Set(this.me?.channels || []);
    return Object.values(this.ws?.channels || {})
      .filter((c) => !c.private && !ids.has(c.id) && !c.archived && !c.lost)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** DMs as [{ id, members: [uuid], others: [uuid], lastTs, host }], most recent first; `host` names the workspace a shared-channel DM lives on. */
  dms() {
    const list = Object.entries(this.me?.dms || {}).map(([id, d]) => ({
      id,
      members: d.members,
      others: d.members.filter((u) => u !== this.uuid),
      lastTs: this.act.c[id]?.t || d.createdAt || 0,
      host: d.host || null,
    }));
    return list.sort((a, b) => b.lastTs - a.lastTs);
  }

  dmTitle(dm) {
    const names = dm.others.map((u) => this.member(u).name);
    // One's own space wears one's own name, which beside the other rows
    // reads as a message thread with a namesake, so it says "(you)".
    if (!names.length) return `${this.member(this.uuid).name} (you)`;
    return names.join(', ');
  }

  /** Human title for any conversation id. */
  convTitle(convId) {
    const ch = this.channel(convId);
    if (ch) return `#${ch.name}`;
    const dm = own(this.me?.dms, convId);
    if (dm) return this.dmTitle({ others: dm.members.filter((u) => u !== this.uuid) });
    return 'Conversation';
  }

  canAccess(convId) {
    const ch = this.channel(convId);
    // A private channel nobody is left in is listed to admins so that it can
    // be deleted (the worker marks it an orphan), and for nothing else: every
    // other route answers "not found" for it, as for any private channel the
    // caller is not in, so nothing here may open it, post into it or read it.
    if (ch) return !ch.orphan;
    return !!own(this.me?.dms, convId);
  }

  /** Private channels nobody is left in, listed to admins only so they can be deleted; by name. */
  orphanChannels() {
    return Object.values(this.ws?.channels || {}).filter((c) => c.orphan).sort((a, b) => a.name.localeCompare(b.name));
  }

  isJoined(convId) {
    return (this.me?.channels || []).includes(convId) || !!own(this.me?.dms, convId);
  }

  /**
   * Is the workspace being moved to another server right now: the nominee
   * has begun the copy, and until it is complete (or given up, or half an
   * hour has passed) the worker takes no writes, answering each 423
   * `transferring` with a word to try again in a few minutes, while reads
   * stay open. With `convId`, the workspace the conversation lives on: a
   * shared channel's host may be the one moving. The freeze is stamped by
   * the worker, so it is measured on the workers' clock (see serverNow).
   * What the document says of it is at `ws.transferring` ({ by, at }).
   */
  isTransferring(convId = null) {
    const ws = convId ? this.hostOf(convId).link?.ws || this.ws : this.ws;
    const t = ws?.transferring;
    return !!t && typeof t.at === 'number' && t.at + TRANSFER_FREEZE_MS > this.serverNow();
  }

  /**
   * May this member change what a channel is called, what it is about, and
   * what it links to? Its members, its creator, and admins, as the worker
   * allows; never a guest, and not once it is archived.
   */
  canCurate(channelId) {
    const ch = this.channel(channelId);
    // The entry for a channel hosted elsewhere has nothing of its own to
    // curate: topic, description, and bookmarks are the host's, changed from
    // there (the worker refuses them here even for someone who is a member
    // of both); what this workspace calls it is an admin's rename in the details.
    if (!ch || ch.archived || ch.shared || ch.orphan || this.isLimitedIn(channelId)) return false;
    return this.isAdminIn(channelId) || ch.createdBy === this.uuid || this.isJoined(channelId);
  }

  /** May the current user @channel / @here (and @everyone, default channels only) here? */
  broadcastAccess(convId) {
    const ch = this.channel(convId);
    if (!ch) return { channel: this.canAccess(convId), everyone: false };
    const policy = ch.broadcast || (ch.def ? 'admins' : 'everyone');
    const ok = policy === 'everyone' || this.isAdminIn(convId);
    return { channel: ok, everyone: ok && !!ch.def };
  }

  /** How many people a broadcast in a conversation reaches, as best the client can tell. */
  broadcastReach(convId, kind) {
    const ch = this.channel(convId);
    const dm = own(this.me?.dms, convId);
    const members = this.membersFor(convId);
    const total = Object.keys(members).length - 1;
    if (kind === 'everyone') return { count: Math.max(0, total), exact: true };
    // @here reaches those here right now, in a direct message as in a
    // channel (the worker rings the members with a fresh heartbeat), so the
    // count is of those, and a guess: counted as every member, the confirm
    // said "2 people active now" for a group message whose others were
    // both away, and "Notify 2" where the worker would ring nobody.
    if (dm && kind === 'here') return { count: dm.members.filter((u) => u !== this.uuid && this.isOnline(u)).length, exact: false };
    if (dm) return { count: dm.members.length - 1, exact: true };
    if (!ch) return { count: 0, exact: false };
    if (kind === 'here') {
      const online = Object.keys(members).filter((u) => u !== this.uuid && this.isOnline(u)).length;
      return { count: Math.min(online, Math.max(0, (ch.count || 1) - 1)), exact: false };
    }
    return { count: Math.max(0, (ch.count || 1) - 1), exact: true };
  }

  /**
   * May the current user post in a conversation, and if not, why? Mirrors
   * the worker's resolveConv so the composer can explain itself before a
   * request is refused. Returns { ok, reason } with reason one of moved
   * (the read-only copy a move left behind), importing, transferring,
   * archived, not_joined, read_only, threads_off, threads_admins, and for a
   * shared channel shared_loading (the host has not answered yet),
   * shared_unreachable (it could not be reached; the poll keeps trying),
   * shared_refused (it answered, and would not take the member in; the poll
   * keeps asking) or shared_lost (the connection has ended).
   */
  postAccess(convId, { thread = false } = {}) {
    const ch = this.channel(convId);
    // The read-only copy a move to another server left behind (see the
    // worker's assertNotMoved, which every write meets first): nothing is
    // posted, pinned or replied to here, a channel hosted elsewhere included
    // (the copy is read-only whole, as the column's box has it). Said as the
    // column says it: read as open, the thread panel offered a reply box on
    // such a copy, and Pin was offered on every message, each to be refused
    // by the server with its words once pressed, where a reaction and an
    // edit were not offered at all.
    if (this.ws?.movedTo) return { ok: false, reason: 'moved' };
    // A workspace still being imported takes no writes (its history is being
    // written seq by seq, and a line landing meanwhile would take a number
    // the archive brings): read-only until it is open. A channel hosted
    // elsewhere is written on its host, which this says nothing about.
    if (this.ws?.importing && !ch?.shared) return { ok: false, reason: 'importing' };
    if (this.isTransferring(convId)) return { ok: false, reason: 'transferring' }; // being moved to another server: no writes for a while (see isTransferring)
    if (!ch) return { ok: this.canAccess(convId), reason: this.canAccess(convId) ? null : 'not_joined' };
    if (ch.shared) {
      if (ch.lost) return { ok: false, reason: 'shared_lost' };
      if (!this.isJoined(convId)) return { ok: false, reason: 'not_joined' };
      const link = this.links.get(ch.shared.ref);
      if (!link?.loaded) return { ok: false, reason: !link?.error ? 'shared_loading' : link.lost ? 'shared_lost' : isRefusal(link.error) ? 'shared_refused' : 'shared_unreachable' };
      if (!(link.me?.channels || []).includes(ch.shared.ch)) return { ok: false, reason: 'not_joined' };
    }
    if (ch.archived) return { ok: false, reason: 'archived' };
    if (!this.isJoined(convId)) return { ok: false, reason: 'not_joined' };
    if (thread) {
      const policy = ch.threadPolicy || 'everyone';
      if (policy === 'off') return { ok: false, reason: 'threads_off' };
      if (policy === 'admins' && !this.isAdminIn(convId)) return { ok: false, reason: 'threads_admins' };
      return { ok: true, reason: null };
    }
    if (ch.postPolicy === 'admins' && !this.isAdminIn(convId)) return { ok: false, reason: 'read_only' };
    return { ok: true, reason: null };
  }

  /* ---- notification settings --------------------------------------------- */

  /** What kind of conversation an id names, for notification defaults. */
  convKind(convId) {
    if (this.channel(convId)) return 'channel';
    if (own(this.me?.dms, convId)) return 'dm';
    if (/_t\d+$/.test(convId)) return 'thread';
    // A direct message this client has not been told of yet — the poll
    // announces a new one's first message before the member document that
    // lists it — is still known for what it is: the dm_ prefix is minted
    // only for direct messages (see dmConvId), and the poll only ever names
    // conversations the member is in.
    return convId.startsWith('dm_') ? 'dm' : 'channel';
  }

  /** The member's setting for a conversation, with defaults filled in. */
  notifySetting(convId) {
    const cur = this.me?.notify?.[convId] || {};
    return { level: cur.level || defaultLevel(this.convKind(convId)), mute: !!cur.mute, follow: cur.follow, explicit: !!cur.level };
  }

  isMuted(convId) {
    return this.notifySetting(convId).mute;
  }

  /** Change level or mute for a conversation; applied locally at once. */
  async setNotify(convId, patch) {
    if (!this.me) return;
    this._setMine('notify', convId, { ...(this.me.notify?.[convId] || {}), ...patch });
    this.emit('workspace');
    this.emit('activity');
    const pending = this._notifyPending.get(convId) || { patch: {}, inflight: 0, acked: 0 };
    pending.patch = { ...pending.patch, ...patch };
    pending.inflight++;
    pending.acked = 0;
    this._notifyPending.set(convId, pending);
    const host = this.hostOf(convId);
    try {
      await api.setNotify(host.ref, host.conv, patch);
    } finally {
      // Landed (or given up on): a document requested from now on is trusted.
      if (--pending.inflight === 0) pending.acked = Date.now();
    }
  }

  /**
   * Does the user follow a thread? The root's author and repliers do unless
   * they opted out. `shown` is the root as the caller draws it, for one the
   * conversation's window does not hold (a thread opened from a link, whose
   * root the panel fetched on its own; see _heldOrShown): read from the
   * window alone, the author of such a thread was shown as not following it.
   */
  followsThread(convId, seq, shown = null) {
    const id = threadConvId(convId, seq);
    const explicit = this.me?.notify?.[id]?.follow;
    if (typeof explicit === 'boolean') return explicit;
    const root = this._heldOrShown(convId, seq, shown);
    if (!root) return false;
    const f = root.followers || {};
    if (f[this.uuid] === 1) return true;
    if (f[this.uuid] === 0) return false;
    return root.user === this.uuid;
  }

  async followThread(convId, seq, follow, shown = null) {
    const id = threadConvId(convId, seq);
    const root = this._heldOrShown(convId, seq, shown);
    if (root) root.followers = { ...(root.followers || {}), [this.uuid]: follow ? 1 : 0 };
    if (!follow && this.me?.threads?.[id]) this._setMine('threads', id, 0);
    await this.setNotify(id, { follow });
  }

  /** Unread replies in a thread the user follows. */
  threadUnread(threadId) {
    return this.me?.threads?.[threadId] || 0;
  }

  /**
   * Total unread replies across followed threads, in conversations the
   * workspace still has. A channel an admin deletes takes its threads with
   * it, but the member documents keep their counters for them (the worker
   * touches no member document on a deletion; the Threads view's listing
   * zeroes them when it is next opened, see GET /threads): summed as they
   * stood, the badge on the rail, the Later pill and the tab's title kept
   * counting that channel's replies, with nothing left to open and read,
   * until the member happened to open the Threads view. A thread's
   * conversation is one of the workspace's channels (an entry for a channel
   * hosted elsewhere among them) or one of the member's direct messages (a
   * host's, folded in under its `h_` id); a thread of anything else counts
   * nothing here, as the worker's own listing leaves it out.
   */
  threadBadge() {
    let n = 0;
    for (const [id, v] of Object.entries(this.me?.threads || {})) {
      if (!v) continue;
      const parent = parentOfThread(id)?.conv;
      if (!parent || !(own(this.ws?.channels, parent) || own(this.me?.dms, parent))) continue;
      n += v;
    }
    return n;
  }

  /** Are browser notifications paused right now (explicit pause or quiet hours)? */
  notificationsPaused() {
    return notificationsPaused(this.profile?.prefs || {});
  }

  /* ---- inbox, saved, unread ---------------------------------------------- */

  /**
   * The Activity, Threads, and Later lists are the member's own on this
   * workspace and on every host of a shared channel they are in (a mention
   * in a shared channel lands in their inbox there). Each host is asked
   * alongside, its conversation ids translated to the local ones; a host
   * that does not answer is left out rather than failing the list.
   */
  _liveLinks() {
    return [...this.links.values()].filter((l) => l.loaded && !l.loading);
  }

  /**
   * The hosts whose inbox counter is this workspace's to show and clear:
   * those where the member is external, so everything counted there is in
   * a shared channel carried here. Someone who is a member of the host in
   * their own right has that workspace's Activity for its counter (which
   * covers channels this workspace does not carry); their items from the
   * shared channel are still listed here.
   */
  _inboxLinks() {
    return this._liveLinks().filter((l) => l.me?.role === 'external');
  }

  async _gather(fn, translate) {
    const mine = await fn(this.wsId, null);
    const others = await Promise.all(this._liveLinks().map((l) => fn(l.ref, l).then((d) => translate(d, l)).catch(() => null)));
    return [mine, ...others.filter(Boolean)];
  }

  /** Entries naming a host conversation under `key`, under the local id (and the host, for writes); ones this workspace does not carry are dropped. */
  _translateItems(link, items, key) {
    return (items || []).map((it) => {
      const local = this._localOf(link, it[key]);
      return local ? { ...it, [key]: local, host: link.ref } : null;
    }).filter(Boolean);
  }

  /** Unread activity (mentions, replies, reactions) since the inbox was last opened, here and on linked hosts. */
  inboxUnread() {
    return (this.me?.inbox || 0) + this._inboxLinks().reduce((n, l) => n + (l.me?.inbox || 0), 0);
  }

  async loadInbox(kind = 'all') {
    const parts = await this._gather((ref) => api.inbox(ref, kind), (d, l) => ({ items: this._translateItems(l, d.items, 'c') }));
    return { items: parts.flatMap((p) => p.items).sort((a, b) => b.ts - a.ts).slice(0, 60), unread: this.inboxUnread() };
  }

  /** Opening the Activity view clears its badge, everywhere it counts. */
  async readInbox() {
    const jobs = [];
    // Noted per worker for refreshWorkspace and _applyLink: a document
    // requested before the write landed still counts the badge.
    const note = (ref, job) => {
      const seen = { at: Date.now(), acked: 0 };
      this._inboxRead.set(ref, seen);
      jobs.push(job.finally(() => { seen.acked = Date.now(); }));
    };
    if (this.me?.inbox) {
      this.me.inbox = 0;
      note(this.wsId, api.inboxRead(this.wsId));
    }
    for (const l of this._inboxLinks()) {
      if (!l.me?.inbox) continue;
      l.me.inbox = 0;
      note(l.ref, api.inboxRead(l.ref));
    }
    if (!jobs.length) return;
    this.emit('activity');
    await Promise.allSettled(jobs);
  }

  async loadThreads() {
    const parts = await this._gather((ref) => api.threads(ref), (d, l) => ({
      threads: (d.threads || []).map((t) => {
        const id = this._localOf(l, t.id);
        const conv = this._localOf(l, t.conv);
        return id && conv ? { ...t, id, conv, host: l.ref } : null;
      }).filter(Boolean),
    }));
    return { threads: parts.flatMap((p) => p.threads).sort((a, b) => b.at - a.at) };
  }

  /**
   * A server's saved or scheduled list: read afresh, or, with `reuse`, as it
   * was read within the last LATER_REUSE_MS (see loadSaved and loadScheduled).
   * The lists are read as the workspace opens, for the Later badge and the
   * marks on saved messages, and again as each host's link loads, so that
   * what the member keeps on the host counts too (see _loadLink); the second
   * read asked every server afresh, this workspace's included, whose answer
   * of a moment before was still good, once per host. A read that fails is
   * not kept to be reused.
   */
  _laterList(kind, ref, fetch, reuse) {
    const key = `${kind}:${ref}`;
    const hit = this._laterCache.get(key);
    if (reuse && hit && Date.now() - hit.at < LATER_REUSE_MS) return hit.p;
    const entry = { p: fetch(), at: Date.now() };
    this._laterCache.set(key, entry);
    entry.p.catch(() => { if (this._laterCache.get(key) === entry) this._laterCache.delete(key); });
    return entry.p;
  }

  async loadSaved({ reuse = false } = {}) {
    const wsId = this.wsId;
    const writes = this._savedWrites || 0;
    const parts = await this._gather((ref) => this._laterList('saved', ref, () => api.saved(ref), reuse), (d, l) => ({ items: this._translateItems(l, d.items, 'c') }));
    const items = parts.flatMap((p) => p.items).sort((a, b) => b.ts - a.ts);
    // Asked for one workspace, answered with another open (a switch while
    // the request was out): the list is the caller's, the counts are not
    // this workspace's (see loadScheduled and loadPins, which do the same).
    if (this.wsId !== wsId) return items;
    // A save, a removal or a done landed while the list was on its way (the
    // list is read as the workspace opens and as each host answers, and a
    // message can be saved the moment it shows): the list predates the
    // change, and laid over it would take the mark off the message just
    // saved and count the badge as before. It is read again instead, and
    // what this device did stands meanwhile.
    if ((this._savedWrites || 0) !== writes) return this.loadSaved();
    this._saved = new Set(items.map((i) => `${i.c}:${i.s}`));
    // The badge counts what is not done; which items are done is kept, so
    // that removing one, or marking one done or not, moves the count by
    // what it should and not by one whatever the item's state.
    this._savedDone = new Set(items.filter((i) => i.done).map((i) => `${i.c}:${i.s}`));
    this._savedCount = items.filter((i) => !i.done).length;
    this.emit('activity');
    return items;
  }

  isSaved(convId, seq) {
    return !!this._saved?.has(`${convId}:${seq}`);
  }

  savedCount() {
    return this._savedCount || 0;
  }

  async save(convId, seq) {
    const host = this.hostOf(convId);
    const wsId = this.wsId;
    const res = await api.save(host.ref, host.conv, seq);
    // Answered with another workspace open (a switch while the request was
    // out): the worker has the change, and the list, the done marks and
    // the count here are that workspace's now (a direct message shares its
    // id across workspaces, so the key may even be one of theirs). They are
    // read afresh when the workspace asked is opened again (see loadSaved).
    if (this.wsId !== wsId) return;
    this._savedWrites = (this._savedWrites || 0) + 1; // a list asked for before this landed is behind it (see loadSaved)
    this._laterCache.clear();
    const key = `${convId}:${seq}`;
    this._saved = this._saved || new Set();
    this._saved.add(key);
    // One the worker already had (a double tap, a save from another device)
    // is counted once, and its done state stands: the count moves only for
    // an item saved now.
    if (!res?.already) {
      this._savedDone?.delete(key);
      this._savedCount = (this._savedCount || 0) + 1;
    }
    this.emit('messages', { conv: convId, reason: 'range' });
    this.emit('activity');
  }

  async unsave(convId, seq) {
    const host = this.hostOf(convId);
    const wsId = this.wsId;
    await api.unsave(host.ref, host.conv, seq);
    if (this.wsId !== wsId) return; // another workspace is open now (see save)
    this._savedWrites = (this._savedWrites || 0) + 1;
    this._laterCache.clear();
    const key = `${convId}:${seq}`;
    // The badge counts what is not done: removing an item marked done leaves it where it was.
    const counted = this._saved ? this._saved.has(key) && !this._savedDone?.has(key) : true;
    this._saved?.delete(key);
    this._savedDone?.delete(key);
    if (counted) this._savedCount = Math.max(0, (this._savedCount || 0) - 1);
    this.emit('messages', { conv: convId, reason: 'range' });
    this.emit('activity');
  }

  /** Mark a saved item done or not; `item` is an entry from loadSaved (its conversation says where it lives). */
  async saveDone(item, done) {
    const host = this.hostOf(item.c);
    const wsId = this.wsId;
    const res = await api.saveDone(host.ref, host.conv, item.s, done);
    if (this.wsId !== wsId) return res; // another workspace is open now (see save)
    this._savedWrites = (this._savedWrites || 0) + 1;
    this._laterCache.clear();
    // A change of state moves the badge by one, once; marking done what is done moves nothing.
    const key = `${item.c}:${item.s}`;
    this._savedDone = this._savedDone || new Set();
    const was = this._savedDone.has(key);
    if (done && !was) {
      this._savedDone.add(key);
      this._savedCount = Math.max(0, (this._savedCount || 0) - 1);
    } else if (!done && was) {
      this._savedDone.delete(key);
      this._savedCount = (this._savedCount || 0) + 1;
    }
    if (!!done !== was) this.emit('activity');
    return res;
  }

  /**
   * Mark a conversation unread from a message on: the cursor moves to just
   * before it, and the New divider and bolding follow from that.
   */
  async markUnread(convId, seq) {
    if (!this.me) return;
    const target = Math.max(0, seq - 1);
    clearTimeout(this._readTimers.get(this._readKey(convId)));
    this._readTimers.delete(this._readKey(convId));
    this._readPending.delete(this._readKey(convId));
    // The read this cancels will not be acknowledged: its note would clear
    // the badge on every document from now on (see refreshWorkspace). One
    // waiting to be sent again is the older word, and is not.
    this._seenAt.delete(convId);
    this._readRetry.delete(this._readKey(convId));
    this._readAcked.delete(convId);
    this._setMine('reads', convId, target);
    this._localSeen.set(convId, target);
    // Kept under a document requested before this landed (the route bumps no stamp).
    const put = { target, acked: 0, at: Date.now() };
    this._unreadAt.set(convId, put);
    this.emit('activity');
    this.emit('workspace');
    const host = this.hostOf(convId);
    try {
      await api.markUnread(host.ref, host.conv, target);
    } finally {
      put.acked = Date.now();
    }
  }

  /* ---- push --------------------------------------------------------------- */

  /** Enable from the click before any other await, then tell the workspace workers. */
  async setPush(on, { extra = [] } = {}) {
    this._pushToggling = true;
    try {
      if (!on) {
        await withinMs(Promise.allSettled(this._pushRefs().map((ref) => api.pushUnregister(ref))), HOST_WORD_MS);
        await disablePuterPush();
        _notePushOffset(null);
        await this.updatePrefs({ push: false });
        await this.refreshPushStatus();
        return { on: false };
      }
      const asked = enablePuterPush(() => retireLegacyPush(this.workspaces.map((w) => w.ref)));
      const device = await asked;
      const granted = extra.length ? await puter.perms.request(extra) : [];
      if (!device) {
        await this.updatePrefs({ pushDeclined: true });
        await this.refreshPushStatus();
        return { on: false, device: false, granted };
      }
      await this.updatePrefs({ push: true, pushDeclined: false });
      listenForPushes();
      await Promise.allSettled(this._pushRefs().map((ref) => this._registerPush(ref)));
      await this.refreshPushStatus();
      return { on: true, device, granted };
    } finally {
      this._pushToggling = false;
    }
  }

  /**
   * Notifications are on unless the user turned them off. Where this browser
   * already allows them, pushes are turned on here without asking; where it
   * hasn't decided, it is asked once, from the first click or key press.
   */
  async autoEnablePush() {
    if (typeof puter === 'undefined' || !puter.notifications) return;
    if (this.profile?.prefs?.push === false) return;
    if ((await this.refreshPushStatus()) === 'on') return;
    const web = puter.env === 'web';
    if (web && (!notificationsSupported() || (isIos() && !isStandalone()))) return;
    const allowed = web ? notificationsGranted() : await puter.notifications.hasPermission().catch(() => false);
    if (allowed) {
      await this.setPush(true);
      return;
    }
    if (web && Notification.permission === 'denied') return;
    try {
      if (localStorage.getItem(NOTIFY_ASKED_KEY)) return;
    } catch {
      return;
    }
    const ask = () => {
      document.removeEventListener('pointerdown', ask, true);
      document.removeEventListener('keydown', ask, true);
      try {
        localStorage.setItem(NOTIFY_ASKED_KEY, '1');
      } catch { /* asked again next load */ }
      // Synchronously from the gesture, so the browser shows its prompt.
      this.setPush(true).catch((err) => console.warn('Teamchat push', err));
    };
    document.addEventListener('pointerdown', ask, true);
    document.addEventListener('keydown', ask, true);
  }

  async refreshPushStatus() {
    this.pushStatus = await puterPushStatus();
    this.emit('push');
    return this.pushStatus;
  }

  /**
   * Offered from the click that creates or joins a workspace: pushes on for
   * the account, unless they are on already or were turned down. An owner
   * creating one is also asked for the sharing grant members' live updates
   * and pushes depend on, from that click, or on its own when pushes are
   * not being offered. Returns a promise of `{ on, device, grant }`, or null
   * when there is nothing to ask.
   */
  offerPush({ owner = false } = {}) {
    if (typeof puter === 'undefined' || !puter.perms) return null;
    const prefs = this.profile?.prefs || {};
    const grant = owner && this.appUid() && prefs.evConsent !== 'declined' ? [{ resource: 'kvShare', ...EV_GRANT }] : [];
    const push = prefs.push !== false && this.pushStatus !== 'on' && !!puter.notifications;
    if (!push && !grant.length) return null;
    const asked = push
      ? this.setPush(true, { extra: grant }).then((res) => ({ ...res, grant: !!res.granted[0] }))
      : puter.perms.request(grant).then((answers) => ({ on: false, grant: !!answers?.[0] }));
    return asked.then(async (res) => {
      if (grant.length && !res.grant) await this.updatePrefs({ evConsent: 'declined' }).catch(() => {});
      // The worker remembers a refusal to share; a grant made here lifts it.
      const url = this.user?.worker?.url;
      if (grant.length && res.grant && url) api.updateServer(url, { events: true }).catch(() => {});
      return res;
    });
  }

  /** The workspaces pushes are set up on. */
  _pushRefs() {
    return this.workspaces.filter((w) => !w.unreachable && !w.movedTo).map((w) => w.ref);
  }

  _pushBody() {
    const prefs = this.profile?.prefs || {};
    return { prefs: pushPrefs(prefs), preview: prefs.notifyPreview !== false };
  }

  /** Register the account's notification settings on one workspace worker. */
  async _registerPush(ref) {
    const body = this._pushBody();
    await api.pushRegister(ref, body);
    _notePushOffset(body.prefs.tzOffset);
  }

  async _reconcilePush(ref, pn) {
    // Workers hear of it once pushes were turned on somewhere, not from the default alone.
    const push = this.profile?.prefs?.push;
    if (push === true) await this._registerPush(ref);
    else if (push === false && pn) await api.pushUnregister(ref);
  }

  /** Keep every worker's copy of this member's quiet hours, pause, and preview choice current. */
  async syncPushPrefs() {
    if (this.profile?.prefs?.push !== true) return;
    const body = this._pushBody();
    _notePushOffset(body.prefs.tzOffset);
    await Promise.allSettled(this._pushRefs().map((ref) => api.pushRegister(ref, body)));
  }

  /* ---- scheduled & reminders ---------------------------------------------- */

  /**
   * A moment picked on this device (a "send later" time, a reminder's) as
   * the workers' clock has it. The workers deliver by their own clock and
   * refuse a time already past by it, so on a device running a minute or
   * more behind, "in a minute" was refused as a time in the past, and every
   * time picked was delivered that much early by the clock the picker read
   * it from. The offset learned with every sync (see serverNow) translates
   * it, once, on its way out; what the workers hand back is translated back
   * (see _dueHere), so what was picked is what is shown.
   */
  _toWorkerTime(ts) {
    return typeof ts === 'number' && Number.isFinite(ts) ? ts + this._clockOffset : ts;
  }

  /**
   * A scheduled entry or a reminder as the workers hand it back, its time as
   * this device's clock has it (see _toWorkerTime). The offset is learned
   * afresh with every sync and moves by the answer's travel time, so a time
   * translated out under one reading and back under another comes back a
   * few hundred milliseconds off; a time picked to the minute (a preset, the
   * picker) then sat a breath before its minute and read as the minute
   * before ("Tomorrow at 9" listed at 8:59). A time within a few seconds of
   * a minute is put back on it; one picked off the minute ("in an hour") is
   * left as it comes, that near or not.
   */
  _dueHere(entry) {
    if (!entry || typeof entry.dueAt !== 'number') return entry;
    let at = entry.dueAt - this._clockOffset;
    const MIN = 60_000;
    const into = ((at % MIN) + MIN) % MIN;
    if (into <= DUE_SNAP_MS) at -= into;
    else if (MIN - into <= DUE_SNAP_MS) at += MIN - into;
    return { ...entry, dueAt: at };
  }

  async schedule(convId, { text, attachments = [], dueAt }) {
    const host = this.hostOf(convId);
    const wsId = this.wsId;
    const workerDueAt = this._toWorkerTime(dueAt);
    const consent = this._dueConsent();
    const res = await api.schedule(host.ref, { conv: host.conv, text, attachments: attachments.map((a) => ({ id: a.id })), dueAt: workerDueAt });
    // Counted here only while the workspace asked is the one open: answered
    // after a switch, the entry stands on the worker and is counted when
    // that workspace's list is next read (see loadScheduled), not on the
    // Later badge of the workspace switched to.
    if (this.wsId === wsId) {
      this._scheduledCount = (this._scheduledCount || 0) + 1;
      this._laterWrites = (this._laterWrites || 0) + 1; // a list asked for before this landed is behind it (see loadScheduled)
      this._laterCache.clear();
      this.emit('activity');
    }
    return this._dueHere(await this._wakeDue(host.ref, res.scheduled, res.scheduled?.dueAt ?? workerDueAt, consent));
  }

  async remind(convId, seq, dueAt, note = '') {
    const host = this.hostOf(convId);
    const wsId = this.wsId;
    const workerDueAt = this._toWorkerTime(dueAt);
    const consent = this._dueConsent();
    const res = await api.remind(host.ref, { conv: host.conv, seq, dueAt: workerDueAt, note });
    if (this.wsId === wsId) { // (see schedule)
      this._reminderCount = (this._reminderCount || 0) + 1;
      this._laterWrites = (this._laterWrites || 0) + 1;
      this._laterCache.clear();
      this.emit('activity');
    }
    return this._dueHere(await this._wakeDue(host.ref, res.reminder, res.reminder?.dueAt ?? workerDueAt, consent));
  }

  async loadScheduled({ reuse = false } = {}) {
    const wsId = this.wsId;
    const writes = this._laterWrites || 0;
    const parts = await this._gather((ref) => this._laterList('sched', ref, () => api.scheduled(ref), reuse), (d, l) => ({
      scheduled: this._translateItems(l, d.scheduled, 'conv'), reminders: this._translateItems(l, d.reminders, 'conv'),
    }));
    const data = {
      scheduled: parts.flatMap((p) => p.scheduled || []).map((e) => this._dueHere(e)).sort((a, b) => a.dueAt - b.dueAt),
      reminders: parts.flatMap((p) => p.reminders || []).map((e) => this._dueHere(e)).sort((a, b) => a.dueAt - b.dueAt),
    };
    if (this.wsId !== wsId) return data; // another workspace is open now (see loadSaved)
    // A message scheduled, a reminder set, one changed or deleted while the
    // lists were on their way (the lists are read as the workspace opens and
    // as each host answers, and "Send later" can be pressed the moment the
    // composer shows): the lists predate the change, and laid over it they
    // put the Later badge back to the count from before (a message just
    // scheduled read as none until the Later view was opened). Read again
    // instead, as loadSaved does; what this device did stands meanwhile.
    if ((this._laterWrites || 0) !== writes) return this.loadScheduled();
    this._scheduledCount = data.scheduled.length;
    this._reminderCount = data.reminders.length;
    this.emit('activity');
    return data;
  }

  /**
   * Edit, reschedule, or send a pending entry from loadScheduled, wherever
   * it waits. The lists kept for reuse (see _laterList) go once the change
   * has landed, as they do after a save or a message scheduled, and not
   * only as it is asked for: a list read while the request was out (a
   * host's link loading and asking for the Later counts, see _loadLink)
   * predates the change and was kept, and the next read allowed to reuse
   * it, within the half minute, put the count back to what it had been
   * (the message just deleted counted on the Later badge again).
   */
  async updateScheduled(entry, patch) {
    const ref = entry.host || this.wsId;
    const moved = typeof patch?.dueAt === 'number';
    const p = moved ? { ...patch, dueAt: this._toWorkerTime(patch.dueAt) } : patch;
    const consent = moved ? this._dueConsent() : null;
    this._laterCache.clear();
    const res = await api.updateScheduled(ref, entry.id, p);
    if (moved || patch?.sendNow) {
      await this._cancelDue(res.previousScheduleId || entry.scheduleId);
      if (moved && !patch.sendNow) await this._wakeDue(ref, { ...entry, scheduleId: null }, p.dueAt, consent);
    }
    this._laterWrites = (this._laterWrites || 0) + 1;
    this._laterCache.clear();
    return res;
  }

  async deleteScheduled(entry) {
    this._laterCache.clear();
    const res = await api.deleteScheduled(entry.host || this.wsId, entry.id);
    await this._cancelDue(res.previousScheduleId || entry.scheduleId);
    this._laterWrites = (this._laterWrites || 0) + 1;
    this._laterCache.clear();
    return res;
  }

  /** Optional wake-up, asked for once; a decline or no scheduler leaves polling in charge. */
  async _dueConsent() {
    try {
      if (typeof puter.events?.onSchedule !== 'function') return false;
      if (await puter.perms.check('backgroundEvents')) return true;
      if (this.profile?.prefs?.dueDeclined) return false;
      const granted = !!(await puter.perms.request('backgroundEvents'));
      if (!granted) await this.updatePrefs({ dueDeclined: true }).catch(() => {});
      return granted;
    } catch {
      return false;
    }
  }

  async _wakeDue(ref, entry, dueAt, consent) {
    let scheduleId;
    try {
      if (!entry || !(await consent)) return entry;
      const r = parseRef(ref);
      const schedule = await puter.events.onSchedule({ at: dueAt, handlerName: DUE_HANDLER, context: { u: r.url, w: r.id } });
      scheduleId = schedule.scheduleId;
      await api.updateScheduled(ref, entry.id, { scheduleId, scheduleFor: dueAt });
      entry = { ...entry, scheduleId };
    } catch {
      await this._cancelDue(scheduleId);
    }
    this._laterCache.clear();
    return entry;
  }

  async _cancelDue(scheduleId) {
    try {
      if (scheduleId) await puter.events.removeSchedule(scheduleId);
    } catch { /* a removed schedule or failed cancellation leaves a harmless wake-up */ }
  }

  scheduledCount() {
    return this._scheduledCount || 0;
  }

  reminderCount() {
    return this._reminderCount || 0;
  }

  /* ---- pins -------------------------------------------------------------- */

  /** Pinned count for a conversation, kept live by the activity poll. */
  pinCount(convId) {
    return this.act.c[convId]?.pc || 0;
  }

  /** Pins of a conversation, cached until the count changes; each has { seq, by, ts, message }. */
  async loadPins(convId, { force = false } = {}) {
    this._pins = this._pins || new Map();
    const cur = this._pins.get(convId);
    // Cached while nothing about the conversation's overlays changed: a pin
    // swapped for another keeps the count, so the count alone is not enough.
    const stamp = `${this.pinCount(convId)}:${this.act.c[convId]?.x || 0}`;
    if (cur && !force) {
      if (cur.items && cur.stamp === stamp) return cur.items;
      // One is on its way already (the pin bar and the details dialog both
      // heard of one change and ask at once): its answer serves both, rather
      // than the worker being asked once per asker. Only while nothing has
      // changed since it was asked for: an asker who heard of a change made
      // meanwhile would be handed a list from before it, and nothing would
      // ask again until the next change.
      if (cur.loading && cur.stamp === stamp) return cur.loading;
    }
    const host = this.hostOf(convId);
    const cache = this._pins;
    const loading = api.pins(host.ref, host.conv).then(({ pins }) => {
      // The map is replaced when the workspace changes: an answer landing
      // after that is the other workspace's, and a direct message can carry
      // the same id in both (see loadSaved). And only the request the entry
      // still names is remembered: one a pin or an unpin dropped meanwhile
      // (they take the entry out), or a forced reload replaced, began before
      // the change and would remember what was.
      if (this._pins === cache && cache.get(convId)?.loading === loading) cache.set(convId, { stamp, items: pins });
      return pins;
    }, (e) => {
      if (this._pins === cache && cache.get(convId)?.loading === loading) cache.delete(convId);
      throw e;
    });
    cache.set(convId, { stamp, loading });
    return loading;
  }

  /**
   * The message the caller draws, for one the conversation's window here
   * does not hold (see react's `shown`): the root of a thread opened from a
   * link, the Threads view or Activity is fetched on its own while the
   * channel's window stands elsewhere, and a pin, an edit, a deletion or a
   * preview's removal made from its row reached the worker and showed
   * nowhere until the thread was opened again. The window's copy first,
   * when it has one.
   */
  _heldOrShown(convId, seq, shown) {
    return this.conv(convId).messages.find((x) => x.seq === seq) || (shown && shown.seq === seq ? shown : null);
  }

  async pin(convId, seq, shown = null) {
    const host = this.hostOf(convId);
    const wsId = this.wsId;
    const res = await api.pin(host.ref, host.conv, seq);
    // Answered with another workspace open (a switch while the request was
    // out): the pin stands on the worker, and the window, the pinned count
    // and the list here are that workspace's now (a direct message shares
    // its id across workspaces, so they may even be its own conversation's).
    // The workspace asked shows the pin when it is opened again.
    if (this.wsId !== wsId) return res;
    const m = this._heldOrShown(convId, seq, shown);
    if (m) m.pinned = true;
    this._pins?.delete(convId);
    if (!res.already) this.act.c[convId] = { ...(this.act.c[convId] || {}), pc: this.pinCount(convId) + 1 };
    this.emit('messages', { conv: convId, reason: 'range' });
    this.emit('activity');
    this.pokeSync();
    return res;
  }

  async unpin(convId, seq, shown = null) {
    const host = this.hostOf(convId);
    const wsId = this.wsId;
    await api.unpin(host.ref, host.conv, seq);
    if (this.wsId !== wsId) return; // another workspace is open now (see pin)
    const m = this._heldOrShown(convId, seq, shown);
    if (m) m.pinned = false;
    this._pins?.delete(convId);
    this.act.c[convId] = { ...(this.act.c[convId] || {}), pc: Math.max(0, this.pinCount(convId) - 1) };
    this.emit('messages', { conv: convId, reason: 'range' });
    this.emit('activity');
  }

  /* ---- typing ------------------------------------------------------------ */

  /** Uuids typing in a conversation right now (as of the last poll), never the user's own. */
  typingIn(convId) {
    if (Date.now() - this._typing.at > TYPING_TTL_MS) return [];
    return Object.keys(this._typing.byConv[convId] || {}).filter((u) => u !== this.uuid && this._known(u));
  }

  anyoneTyping() {
    return Date.now() - this._typing.at <= TYPING_TTL_MS && Object.keys(this._typing.byConv).length > 0;
  }

  /** The composer calls this on input; writes are throttled to one per window. */
  noteTyping(convId) {
    const wsId = this.wsId;
    if (!wsId) return;
    let sig = this._typingSignals.get(convId);
    if (!sig) {
      const host = this.hostOf(convId);
      sig = typingSignal({
        send: (first) => (this.wsId === wsId ? api.typing(host.ref, host.conv, false, first) : null),
        stop: () => (this.wsId === wsId ? api.typing(host.ref, host.conv, true) : null),
      });
      this._typingSignals.set(convId, sig);
    }
    sig.typed();
  }

  stopTyping(convId) {
    this._typingSignals.get(convId)?.stopped();
  }

  /* ---- huddles ---------------------------------------------------------- */

  /**
   * A huddle is a live call inside a channel or direct message (lib/huddle.js
   * carries the media; src/shared/huddle.js describes the roster the worker
   * keeps). The poll brings every huddle in progress, under local ids, as it
   * brings who is typing; the one this member is in is a Huddle object that
   * outlives switching workspaces, with its seat kept by a heartbeat.
   */

  /**
   * The huddle map as it should read after `h` arrived from one source: the
   * workspace itself (`link` null; its entries replace every local one) or a
   * host (its entries, translated, replace the ones that were its). What the
   * other sources said stands until they answer again.
   */
  _huddlesWith(h, link) {
    const next = {};
    for (const [conv, entry] of Object.entries(this.huddles)) {
      const owner = this.hostOf(conv).link;
      if (link ? owner !== link : !!owner) next[conv] = entry;
    }
    for (const [conv, entry] of Object.entries(h || {})) {
      const local = link ? this._localOf(link, conv) : conv;
      if (local && entry && typeof entry === 'object') next[local] = entry;
    }
    return next;
  }

  /** What of the huddle map is worth a redraw: everything but the heartbeats. */
  _huddleKey(h) {
    return JSON.stringify(Object.entries(h).sort().map(([conv, e]) => [conv, e.by, e.at, Object.entries(e.m || {}).sort().map(([u, p]) => [u, p.j, p.inv])]));
  }

  /**
   * Replace what is known about huddles in progress, tell views when that
   * changed, hand the active huddle its roster, and announce the ones that
   * appeared since the last look, started by someone else, so a direct
   * message can ring.
   */
  _setHuddles(next) {
    const before = this.huddles;
    this.huddles = next;
    this._rosterToHuddle();
    if (this._huddleKey(before) === this._huddleKey(next)) return false;
    this.emit('huddle');
    const started = [];
    for (const [conv, h] of Object.entries(next)) {
      if (before[conv] || !h.by || h.by === this.uuid || h.m?.[this.uuid]) continue;
      // One that began a while ago (the tab slept, the network was away) is
      // shown, as at a bootstrap, not rung: the call was not just placed.
      // Measured on the worker's clock, whose stamp `at` is: a device
      // running minutes ahead would never ring, one behind would ring for
      // calls long placed.
      if (typeof h.at === 'number' && this.serverNow() - h.at > HUDDLE_RING_MS) continue;
      started.push({ conv, by: h.by, at: h.at });
    }
    if (started.length) this.emit('huddle-started', started);
    return true;
  }

  /**
   * The active huddle learns the roster of its conversation as this
   * workspace sees it. Not before its join has landed, and not the seat of
   * this account as a poll that read the roster before this tab's last post
   * knew it: on a takeover from another tab, both list the seat under the
   * tab it is being taken from, which is where it was, not a tab taking it
   * back, and the huddle would leave on the news.
   */
  _rosterToHuddle() {
    const conv = this.huddleConv;
    if (!conv) return;
    const info = this._huddleInfo;
    if (!info.posted) return;
    const m = { ...(this.huddles[conv]?.m || {}) };
    const mine = m[this.uuid];
    if (mine && typeof mine.at === 'number' && mine.at < (info.seatAt || 0)) delete m[this.uuid];
    this.huddle.syncRoster(m);
  }

  /** The huddle in progress in a conversation: { by, at, m }, or null. */
  huddleIn(convId) {
    return this.huddles[convId] || null;
  }

  /** Who is in a conversation's huddle, in the order they joined. */
  huddleMembers(convId) {
    const h = this.huddleIn(convId);
    if (!h) return [];
    return Object.entries(h.m || {}).sort((a, b) => (a[1].j || 0) - (b[1].j || 0)).map(([u]) => u);
  }

  /** The conversation (in the open workspace) of the huddle this member is in, or null. */
  get huddleConv() {
    return this.huddle && this._huddleInfo?.ws === this.wsId ? this._huddleInfo.conv : null;
  }

  inHuddle(convId) {
    return !!convId && this.huddleConv === convId;
  }

  /** About the huddle this member is in, wherever the app has gone since: { ws, conv, title, kind, at }, or null. */
  get huddleInfo() {
    return this.huddle ? this._huddleInfo : null;
  }

  /** May a huddle be had here: a channel the member is in (posting rights aside), or a direct message. */
  canHuddle(convId) {
    if (!convId || parentOfThread(convId) || this.ws?.movedTo || this.offline) return false;
    const ch = this.channel(convId);
    if (ch) {
      if (ch.archived || ch.lost) return false;
      const a = this.postAccess(convId);
      return a.ok || a.reason === 'read_only';
    }
    return !!own(this.me?.dms, convId);
  }

  /**
   * Start the huddle in a conversation, or join the one in progress. One
   * huddle at a time: joining another leaves the first. Resolves once the
   * seat is taken; the media follows on its own.
   */
  async joinHuddle(convId) {
    if (this.inHuddle(convId)) return this.huddle;
    // Refused before the current huddle is left, not after.
    if (!this.canHuddle(convId)) throw new Error('A huddle cannot be started here');
    if (this.huddle) {
      await this.leaveHuddle();
      // The seat was given up at once and the worker was slow to take the
      // word; with no huddle shown meanwhile, every conversation offered a
      // join, and one was taken. The later join stands: made here anyway,
      // this one would have put its huddle in that one's place, leaving it
      // running (microphone open, its seat kept by the beats) with nothing
      // on screen to leave it by.
      if (this.huddle) return this.huddle;
    }
    const host = this.hostOf(convId);
    const wsId = this.wsId;
    const me = this.member(this.uuid);
    // Who may connect: in a direct message, its people; in a private channel,
    // its members (the list this workspace holds for one it hosts, read at
    // each check so someone removed mid-call is refused from then on); in a
    // public channel, the people of this workspace (and of the hosts it is
    // linked to), since no narrower list is held here. Once the user has
    // moved to another workspace there is no list to check against; the
    // invite, handed out by the worker only to the conversation's members,
    // stands for it then.
    const dm = own(this.me?.dms, convId);
    const party = dm ? new Set(dm.members || []) : null;
    const listed = () => {
      const c = this.channel(convId);
      return c?.private && !c.shared && Array.isArray(c.members) ? c.members : null;
    };
    const h = new Huddle({
      uuid: this.uuid, name: me.name,
      isMember: (u) => this.wsId !== wsId || (party ? party.has(u) : listed()?.includes(u) ?? (this._known(u) && !this.member(u).gone)),
    });
    // `sid` names this tab's seat to the worker: a heartbeat from a tab whose
    // seat another tab of this account took since is refused rather than
    // taking it back, and this tab's leave gives up only its own seat.
    const info = { ws: wsId, conv: convId, ref: host.ref, hostConv: host.conv, title: this.convTitle(convId), kind: this.convKind(convId), posted: false, sid: uid(16) };
    this.huddle = h;
    this._huddleInfo = info;
    // Media moves often (a speaking ring flips with every phrase) and is the
    // dock's to draw; the roster and the seat, which the sidebar, the header,
    // and the bar draw, come as 'huddle' from the polls and the seat changes.
    h.on('change', () => this.emit('huddle-media'));
    h.on('invite', ({ inviteCode }) => {
      // The first code is posted below; later ones (the server re-registered) replace it.
      if (info.posted) this._postHuddle(h, info, inviteCode).catch(() => {});
    });
    h.on('replaced', () => this._replacedByOtherTab(h));
    h.on('error', (e) => this.emit('huddle-error', e));
    h.on('ended', () => {
      if (this.huddle !== h) return;
      clearInterval(this._huddleTimer);
      this._huddleTimer = null;
      this.huddle = null;
      this._huddleInfo = null;
      this.emit('huddle');
    });
    this.emit('huddle');
    try {
      const inviteCode = await h.start();
      if (this.huddle !== h) {
        // Left while starting (leaveHuddle has released it already; this is
        // for good measure): whatever it took, it gives back.
        h.leave('left');
        return h;
      }
      await this._postHuddle(h, info, inviteCode);
    } catch (e) {
      if (this.huddle === h) {
        this.huddle = null;
        this._huddleInfo = null;
      }
      h.leave('failed');
      this.emit('huddle');
      throw e;
    }
    return h;
  }

  /** Another tab of this account holds the seat now: this one leaves, without giving that seat up. */
  _replacedByOtherTab(h) {
    if (this.huddle !== h) return;
    this.emit('notice', 'You joined this huddle from another tab, so this one left it');
    this.leaveHuddle({ tell: false }).catch(() => {});
  }

  /** Take (or keep) the seat under this invite code; the roster that comes back is dialled. */
  async _postHuddle(h, info, inviteCode) {
    if (this.huddle !== h || !inviteCode) return;
    let r;
    info.posting = true;
    try {
      // The first post is the join, which takes the seat whoever holds it; the
      // rest are heartbeats. The promise is kept where leaveHuddle can wait on it.
      info.post = api.huddleJoin(info.ref, info.hostConv, inviteCode, { sid: info.sid, join: !info.posted });
      r = await info.post;
    } catch (e) {
      // The seat went to another tab of this account between two beats.
      if (e instanceof ApiError && e.code === 'replaced') {
        this._replacedByOtherTab(h);
        throw e;
      }
      // Refused for good (full, archived, not a member any more): the huddle
      // cannot be had. Out of reach: the next heartbeat tries again while the
      // links already up carry on. So does one Puter could not confirm for
      // a moment (401, the worker's word whenever Puter's word on who is
      // asking cannot be had; see files.js refused) or one the worker held
      // back (429): the seat stands on the worker for HUDDLE_TTL_MS, five
      // more beats, any of which keeps it. Read as a refusal, either put
      // the member out of the call, with a word about the huddle, over a
      // failure that was Puter's and passing. The first post's refusal is
      // thrown to the join that awaits it, which says so once; a heartbeat's
      // has nobody waiting, so it is announced here.
      const passing = e instanceof ApiError && (e.status === 401 || e.status === 429 || isPlatformPage(e));
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.code !== 'no_backend' && !passing) {
        if (info.posted) this.emit('huddle-error', { kind: 'join', message: e.message });
        this.leaveHuddle({ tell: false }).catch(() => {});
      }
      throw e;
    } finally {
      info.posting = false;
    }
    if (this.huddle !== h) return;
    const first = !info.posted;
    info.posted = true;
    info.beat = Date.now();
    info.at = r.huddle.at || info.at || Date.now();
    // When the worker last heard from this tab, by its clock: a roster that
    // lists the seat as of an earlier moment is older than this post.
    info.seatAt = r.huddle.m?.[this.uuid]?.at || r.now || info.seatAt || 0;
    h.syncRoster(r.huddle.m, { dialAll: first });
    if (this.wsId === info.ws) this._setHuddles({ ...this.huddles, [info.conv]: r.huddle });
    if (!this._huddleTimer) this._huddleTimer = setInterval(() => this._beatHuddle(), HUDDLE_HEARTBEAT_MS);
  }

  /** Keep the seat now (a heartbeat, or a tab back in view), unless a post is already on its way. */
  _beatHuddle() {
    const h = this.huddle;
    const info = this._huddleInfo;
    if (!h || !info || info.posting) return;
    this._postHuddle(h, info, h.inviteCode).catch(() => {});
  }

  /** Leave the huddle this member is in, giving the seat up (`tell` false when the worker already knows). */
  async leaveHuddle({ tell = true } = {}) {
    const h = this.huddle;
    const info = this._huddleInfo;
    if (!h) return;
    clearInterval(this._huddleTimer);
    this._huddleTimer = null;
    this.huddle = null;
    this._huddleInfo = null;
    h.leave('left');
    // The local view drops the seat at once rather than after the next poll,
    // when the seat is this tab's: one the roster lists under another tab of
    // the account, whose taking it is why this tab leaves, is that tab's to keep.
    const mine = info && this.wsId === info.ws ? this.huddles[info.conv]?.m?.[this.uuid] : null;
    if (mine && (!mine.inv || mine.inv === h.inviteCode)) {
      const m = { ...this.huddles[info.conv].m };
      delete m[this.uuid];
      const next = { ...this.huddles };
      if (Object.keys(m).length) next[info.conv] = { ...next[info.conv], m };
      else delete next[info.conv];
      this.huddles = next;
    }
    this.emit('huddle');
    if (tell && info) {
      // A heartbeat still on its way is a second request racing the leave to
      // the worker with nothing to order them: taken after the leave, it
      // re-seats this tab, and with nobody else live it starts a new huddle
      // in this tab's name, with its "started a huddle" line and, in a
      // direct message, a ring, all for a tab that shows itself out of any
      // huddle. Let the beat land first, then give the seat up.
      if (info.posting) await info.post?.catch(() => {});
      await api.huddleLeave(info.ref, info.hostConv, { sid: info.sid }).catch(() => {});
    }
    this.pokeSync();
  }

  /* ---- unread & presence ------------------------------------------------ */

  latestSeq(convId) {
    return this.act.c[convId]?.s || 0;
  }

  unreadCount(convId) {
    const seen = Math.max(this.me?.reads?.[convId] || 0, this._localSeen.get(convId) || 0);
    const latest = this.latestSeq(convId);
    let n = latest - seen;
    // A block of messages closed early on the server leaves its last numbers
    // standing for no message (see the worker's rollBlock), and the entry
    // notes the run (`k`): those numbers are no unread messages. Counted as
    // the counter less the cursor alone, a closed block read as up to
    // forty-nine unread in the direct message list and the tab title until
    // the conversation was opened.
    const k = this.act.c[convId]?.k;
    if (Array.isArray(k) && k.length === 2 && k[1] > seen && k[0] <= latest) n -= Math.min(k[1], latest) - Math.max(k[0] - 1, seen);
    return Math.max(0, n);
  }

  mentionCount(convId) {
    return this.me?.mentions?.[convId] || 0;
  }

  /** What the tab title counts: muted conversations stay out of it. */
  totalBadge() {
    let n = 0;
    for (const dm of this.dms()) if (!this.isMuted(dm.id)) n += this.unreadCount(dm.id);
    for (const ch of this.joinedChannels()) if (!this.isMuted(ch.id)) n += this.mentionCount(ch.id);
    n += this.threadBadge();
    return n;
  }

  /**
   * The worker's clock, as best this device knows it. Heartbeats are stamped
   * by the worker, so presence is measured against its clock and not this
   * device's, which may sit minutes from it: measured here, a device running
   * ahead would show everyone away, one running behind would keep people
   * active long after they left. Learned from the bootstrap and every poll
   * (the answer's `ts`), within a round trip of the truth.
   */
  serverNow() {
    return Date.now() + this._clockOffset;
  }

  _learnClock(serverTs) {
    if (typeof serverTs === 'number' && Number.isFinite(serverTs) && serverTs > 0) this._clockOffset = serverTs - Date.now();
  }

  /** Here right now (active, or here with notifications paused). */
  isOnline(uuid) {
    const state = this.presenceOf(uuid);
    return state === 'active' || state === 'dnd';
  }

  /**
   * 'active' | 'dnd' | 'away' | 'offline', from the heartbeat and its state
   * flag. Someone no longer in view (left the workspace, or from a
   * connected workspace that was disconnected) is offline whatever their
   * last heartbeat said: a green dot beside "no longer here" would contradict it.
   */
  presenceOf(uuid) {
    if (!this._known(uuid)) return 'offline';
    return presenceState(this.act.p[uuid], this.act.ps?.[uuid] || null, this.serverNow());
  }

  /** Everyone in view and how they are: what every surface that draws a dot depends on. */
  _presenceSig() {
    const parts = [];
    const seen = new Set();
    const now = this.serverNow();
    const add = (members) => {
      for (const u of Object.keys(members || {})) {
        if (seen.has(u)) continue;
        seen.add(u);
        parts.push(u, presenceState(this.act.p[u], this.act.ps?.[u] || null, now));
      }
    };
    add(this.ws?.members);
    for (const link of this.links.values()) add(link.ws?.members);
    return parts.join('');
  }

  /**
   * Has anyone's presence state changed since the last look? A state moves
   * with a heartbeat (someone arrives, or pauses notifications) but also with
   * nothing but time: the person whose heartbeats stopped lapses to away
   * while every poll comes back empty. Asked at the end of each poll, so the
   * surfaces redraw for what changed on screen, and not for every heartbeat.
   */
  _presenceMoved() {
    const sig = this._presenceSig();
    if (sig === this._presenceSeen) return false;
    this._presenceSeen = sig;
    return true;
  }

  /* ---- conversations ---------------------------------------------------- */

  conv(convId) {
    let c = this.convs.get(convId);
    if (!c) {
      // hasNewer: the window was opened around an older message (a permalink)
      // and stops short of the newest ones; the list pages forward from it.
      c = { id: convId, messages: [], seq: 0, hasMore: false, hasNewer: false, loaded: false, loading: false, xSeen: 0, error: null };
      this.convs.set(convId, c);
    }
    return c;
  }

  setOpen(convId, threadSeq = null) {
    this.openConv = convId;
    this.openThread = threadSeq != null && convId ? threadConvId(convId, threadSeq) : null;
    const at = Date.now();
    for (const id of [this.openConv, this.openThread]) if (id) this.conv(id).openedAt = at;
    this._evictWindows();
  }

  /**
   * Every window that stands is brought up to date on each poll it has news
   * for and keeps every message it loaded, so a tab that has visited thirty
   * channels would read for all thirty every few seconds, for as long as it
   * lives. Windows are kept for what is open, for direct messages (the DMs
   * pane reads their newest line), and for what holds a message not sent
   * yet (queued for the outbox, or refused and waiting to be retried or
   * discarded: dropped with the window, it left the screen with nothing
   * said, and came back only with the next opening of the workspace, or
   * not at all); of the rest, the channels and threads left longest ago
   * are dropped once too many stand, to be read again if they are opened.
   */
  _evictWindows() {
    const keep = new Set([this.openConv, this.openThread]);
    const dms = new Set(this.dms().map((d) => d.id));
    const idle = [...this.convs.entries()].filter(([id, c]) => c.loaded && !keep.has(id) && !dms.has(parentOfThread(id)?.conv || id) && !c.messages.some((m) => m.seq == null));
    if (idle.length <= MAX_IDLE_WINDOWS) return;
    idle.sort((a, b) => (a[1].openedAt || 0) - (b[1].openedAt || 0));
    for (const [id] of idle.slice(0, idle.length - MAX_IDLE_WINDOWS)) this.convs.delete(id);
  }

  /**
   * Did a workspace switch happen while a request was in flight? Opening a
   * workspace drops every conversation object, so a window captured before
   * an await that is no longer the store's is stale: its answer belongs to
   * the workspace that was open, and must not touch this one (DM ids are
   * shared across workspaces, so the same id can now mean another one).
   */
  _dropped(convId, c) {
    return this.convs.get(convId) !== c;
  }

  /**
   * Load the newest page of a conversation into its window. With `again`, a
   * window already loaded is read afresh in place (the page shown from the
   * offline cache, as the connection returns; see refreshStale): it stays
   * loaded, so the list keeps drawing what it has until the page lands,
   * where a window unloaded first was drawn as a loading skeleton for the
   * length of the read, the messages the reader had in front of them gone.
   */
  async loadConversation(convId, { again = false } = {}) {
    const c = this.conv(convId);
    if (c.loading || (c.loaded && !again)) return c;
    // Loads of one window are numbered: an answer to an older load (the
    // newest page asked for by a preview) must not overwrite a window a
    // later loadAround opened at a permalink, nor clear its loading flag.
    const gen = c.gen = (c.gen || 0) + 1;
    c.loading = true;
    c.error = null;
    this.emit('messages', { conv: convId, reason: 'loading' });
    try {
      const host = this.hostOf(convId);
      const xBefore = this.act.c[convId]?.x || 0;
      const announced = this.latestSeq(convId);
      const data = await api.messages(host.ref, host.conv);
      if (this._dropped(convId, c) || c.gen !== gen) return c;
      c.messages = mergeMessages(data.messages, c.messages.filter((m) => m.seq == null));
      c.seq = this._reachOf(data, announced);
      c.hasMore = data.hasMore;
      c.hasNewer = false;
      c.loaded = true;
      c.stale = false;
      this._noteOverlaysSeen(convId, c, xBefore);
      this._noteActivity(convId, c.seq);
      this.emit('messages', { conv: convId, reason: 'init' });
      // Remembered for offline reading: the newest page, nothing more.
      idb.put('cache', { key: `conv:${this.wsId}:${convId}`, messages: data.messages.slice(-100), seq: data.seq, ts: Date.now() }).then(() => this._pruneCache()).catch(() => {});
    } catch (e) {
      // The window is gone with a switch of workspace (see _dropped), as the
      // answer's own path checks above: the failure is the workspace left
      // behind's, and said here it reached the list drawn for the new
      // workspace's conversation of the same id (a direct message shares
      // its id across workspaces), which took the page saved for it as one
      // landing anew (scrolled to its end, marked it read) or redrew for an
      // error of a page it holds, twenty seconds after the switch.
      if (this._dropped(convId, c) || c.gen !== gen) return c;
      const cached = e instanceof ApiError && (e.code === 'network' || e.code === 'timeout') ? await idb.get('cache', `conv:${this.wsId}:${convId}`) : null;
      if (this._dropped(convId, c) || c.gen !== gen) return c;
      if (cached) {
        // A fresh page when it is one; a window read afresh in place (see
        // refreshStale) whose read failed again holds this very page already,
        // and is said to have re-read what it holds: announced as a page
        // landing anew, the list scrolled to its end and marked it read on
        // every attempt, and a reader who had scrolled up in the saved page
        // was pulled to the bottom every four seconds for as long as the
        // fresh page would not come. A page saved since by another tab that
        // could read is a fresh one, and lands as such.
        const same = c.loaded && c.stale === cached.ts;
        c.messages = mergeMessages(cached.messages, c.messages.filter((m) => m.seq == null));
        c.seq = cached.seq;
        c.hasMore = false;
        c.loaded = true;
        c.stale = cached.ts;
        this.emit('messages', { conv: convId, reason: same ? 'range' : 'init' });
      } else {
        // The worker answered, and said no (the channel is gone, or the user
        // was taken out of it): the saved page is not going to be refreshed
        // by trying again on every poll, so it stops being "stale". A window
        // read afresh in place (`again`) is no longer loaded either, as one
        // whose first load was refused is not: what it holds is a page the
        // worker will not stand behind, and the poll must not read on for it.
        if (!(e instanceof ApiError && (e.code === 'network' || e.code === 'timeout'))) c.stale = false;
        c.loaded = false;
        c.error = e;
        this.emit('messages', { conv: convId, reason: 'error' });
      }
    } finally {
      if (c.gen === gen) c.loading = false;
    }
    return c;
  }

  /**
   * Keep the offline cache of conversation pages bounded: every conversation
   * ever opened left its newest page there for good, so the store grew with
   * the years, pruned only when another account signed in on the device.
   * Once more than CACHE_CONVS + CACHE_CONVS_MARGIN pages stand, the ones
   * written longest ago go until CACHE_CONVS are left; the workspace
   * bootstraps beside them (one per workspace) are not counted or touched.
   * The count is read from the keys alone; the pages themselves are read
   * only when there is pruning to do.
   */
  async _pruneCache() {
    if (this._pruning) return;
    this._pruning = true;
    try {
      const keys = ((await idb.keys('cache')) || []).filter((k) => typeof k === 'string' && k.startsWith('conv:'));
      if (keys.length <= CACHE_CONVS + CACHE_CONVS_MARGIN) return;
      const pages = ((await idb.all('cache')) || []).filter((e) => typeof e?.key === 'string' && e.key.startsWith('conv:'));
      pages.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      for (const e of pages.slice(CACHE_CONVS)) await idb.del('cache', e.key);
    } finally {
      this._pruning = false;
    }
  }

  /**
   * The outbox hands one entry here when it is ready to go: send it under
   * its own client id (so a retry after a lost response never posts twice),
   * then swap the placeholder shown in the conversation for the real
   * message, the way a live send does.
   */
  async _deliverQueued(e) {
    // `first` says this entry has never been refused, so the worker need not
    // read the conversation's newest blocks looking for a copy of it (see
    // postMessage): there cannot be one. Every attempt after the first says
    // nothing, and is checked.
    const post = () => api.send(e.host || e.ws, e.hconv || e.conv, {
      text: e.text,
      attachments: (e.attachments || []).map((a) => ({ id: a.id })),
      cid: e.id,
      // The attempt is counted before the send goes out (see the outbox), so
      // this is the first one when nothing had been counted before it.
      ...((e.attempts || 0) <= 1 ? { first: true } : {}),
    });
    let data;
    try {
      data = await post();
    } catch (err) {
      // The host of a shared channel says the member's standing there has
      // lapsed (a message queued before a day away, flushed as the workspace
      // opens, before the link has renewed it): renewed the way the link's
      // own poll renews on that word, then sent once more. Left to the
      // outbox, a 403 is a refusal retrying would not fix, and the message
      // sat as failed with a Retry button for a renewal that happens by itself.
      const link = err instanceof ApiError && err.status === 403 && err.code === 'reattest' && e.host && e.ws === this.wsId ? this.links.get(e.host) : null;
      if (!link) {
        // Refused for a conversation gone from the workspace (the channel
        // deleted while the message waited): let go, with a word (see
        // _dropQueued), rather than set aside as failed. The failed entry's
        // Retry and Discard show in the conversation's own window alone,
        // which nobody can open once it is gone, so the entry sat in the
        // device's store for good, tried by nothing and seen by no one.
        if (isRefusal(err) && this._queuedConvGone(e)) throw this._dropQueued(e, err);
        // And a reply refused because its thread is gone (see
        // _queuedThreadGone): let go the same way, with a word naming the
        // thread. Set aside as failed, it sat with its Retry and Discard in
        // the thread's window, which nobody could open once the root was
        // gone without a trace (a root deleted with no replies leaves none).
        if (this._queuedThreadGone(e, err)) throw this._dropQueued(e, err, 'thread');
        throw err;
      }
      await this._loadLink(link);
      if (this.links.get(e.host) !== link || !link.loaded) throw this._linkFailure(link, err);
      data = await post();
    }
    // Landed: the message is the worker's from here, and nothing below may
    // fail the entry. Read as the send failing, a fault in laying the
    // message into the window kept the entry in the outbox (set aside with a
    // Retry that could only be answered as a duplicate, or tried again at
    // every flush) while the message already stood in the channel for
    // everyone; the next poll draws the window right where this did not.
    try {
      this._placeDelivered(e, data);
    } catch (err) {
      console.warn('A delivered message could not be laid into its window', err);
    }
    return data;
  }

  /**
   * Is a queued message's conversation gone from the open workspace: neither
   * a channel of it (whatever the member's standing in it now: one they left
   * still exists, and takes the message again once they are back in it) nor
   * a direct message of theirs? Another workspace's is not known from here.
   */
  _queuedConvGone(e) {
    if (e.ws !== this.wsId || !this.ws || !this.me) return false;
    const base = parentOfThread(e.conv)?.conv || e.conv;
    if (this.channel(base) || own(this.me.dms, base)) return false;
    // A direct message on the host of a shared channel (`h_` + the host's
    // id) is known here through the host's document alone, laid into the
    // member document once the host's link has loaded (see _mergeLinkMe)
    // and taken out when the connection is over (see _dropLinkMe); this
    // workspace's own document never lists it. Missing before the link has
    // loaded (the workspace just opened, the host out of reach), it says
    // nothing of whether the conversation stands: read as gone, a message
    // set aside there was dropped at the next opening of the workspace,
    // with a word that the conversation no longer existed, and one the
    // host refused for its own reasons (too long) went the same way rather
    // than waiting with its Retry.
    if (base.startsWith('h_')) {
      const link = e.host ? this.links.get(e.host) : null;
      // No link to the host at all: the workspace has no channel of that
      // host left (the shared channel removed, or left; see _syncLinks), and
      // the host's direct messages, carried here through the link alone, are
      // not to be had from this workspace any more; the conversation's row
      // left the sidebar with the channel. Read as standing, a message set
      // aside for it sat in the device's store for good, shown by nothing.
      if (!link) return true;
      return link.loaded || link.lost;
    }
    return true;
  }

  /**
   * Was a queued reply refused because the thread it was written for is
   * gone: the worker's own word (404 `not_found`, see the worker's
   * assertThreadRoot and resolveConv: the root deleted, whether or not a
   * tombstone with replies stands for it, or the conversation it hangs off
   * not there for this member) for a message bound for a thread. Not the
   * address failing to answer (a bare 404 is read as `no_backend`, and the
   * outbox tries it again), and not a refusal of any other kind, which is
   * set aside with its reason as before.
   */
  _queuedThreadGone(e, err) {
    return !!parentOfThread(e.conv) && err instanceof ApiError && err.status === 404 && err.code === 'not_found';
  }

  /**
   * Let a queued message go, its conversation (or, for a reply, its thread:
   * `what`) being gone: its placeholder off the window (one restored at
   * boot, see _restoreQueued), a word to the reader with the message's first
   * words, and the outbox's word (`drop`) to take the entry out rather than
   * set it aside (see outbox.js pass).
   */
  _dropQueued(e, err, what = 'conversation') {
    const c = this.convs.get(e.conv);
    if (c && c.messages.some((m) => m.tempId === e.id)) {
      c.messages = c.messages.filter((m) => m.tempId !== e.id);
      this.emit('messages', { conv: e.conv, reason: 'local' });
    }
    // Its files that had gone up go with it (see _releaseUnsent): the entry
    // names the worker they went to (a shared channel's host), else this one.
    this._releaseUnsent(e.conv, e.attachments, e.host || this.wsId);
    const words = previewText(e.text || '', 40);
    this.emit('notice', `Your unsent message${words ? ` “${words}”` : ''} was dropped: the ${what} it was written for no longer exists`);
    const drop = new Error(err?.message || `The ${what} no longer exists`);
    drop.drop = true;
    return drop;
  }

  /**
   * Let go every message set aside (refused, see _deliverQueued) whose
   * conversation the workspace document read just now no longer has. The
   * browser's 'online' event flushes the outbox the moment the connection is
   * back, before the sync has read the workspace afresh, so a message for a
   * channel deleted while the device was offline was refused with the copy
   * here still listing the channel: not gone by _queuedConvGone, it was set
   * aside as failed, and once the sync took the channel out there was no
   * window to show its Retry and Discard in, and it sat in the device's
   * store for good. Asked whenever the document is replaced (a bootstrap, a
   * refetch). Only what was set aside: a message still in line goes to the
   * worker, whose answer decides (see _deliverQueued).
   */
  async _dropGoneQueued() {
    const wsId = this.wsId;
    if (!wsId) return;
    const gone = ((await this.outbox.list()) || []).filter((e) => e.failed && this._queuedConvGone(e));
    if (this.wsId !== wsId) return;
    for (const e of gone) {
      this._dropQueued(e, null);
      await this.outbox.remove(e.id);
    }
  }

  /** What a send does with its answer, for a queued message just delivered (see _deliverQueued and send). */
  _placeDelivered(e, data) {
    if (e.ws !== this.wsId) {
      // Landed with another workspace open (queued in one, then the switch,
      // then the connection back): its link gets the preview card a send
      // asks for below, all the same. Whether previews are on where the
      // message lives is not known from here; the worker declines when
      // its switch is off, as it declines the live send's request.
      if (data.message && firstUnfurlableLink(e.text)) api.unfurl(e.host || e.ws, e.hconv || e.conv, data.message.seq).catch(() => {});
      return;
    }
    const c = this.conv(e.conv);
    const known = c.messages.reduce((n, m) => (m.seq > n ? m.seq : n), c.seq || 0); // see send
    const i = c.messages.findIndex((m) => m.tempId === e.id);
    if (i > -1) c.messages.splice(i, 1);
    if (!data.message) {
      // The worker had this message already (a send whose answer was lost,
      // sent again under the same client id) and it has since been deleted
      // with nothing to answer with: a root with replies is answered as its
      // tombstone and laid in below, a message with none is gone for good.
      // There is nothing to lay in, and the placeholder goes. Read for the
      // message it did not carry, the answer threw after the placeholder
      // had been taken out of the list and before the list was told, and
      // the row stood on screen, "Queued", until something else redrew it.
      if (i > -1) this.emit('messages', { conv: e.conv, reason: 'local' });
      return;
    }
    if (c.loaded && !c.messages.some((m) => m.seq === data.message.seq)) c.messages = mergeMessages(c.messages, [data.message]);
    c.seq = Math.max(c.seq, data.message.seq);
    this._noteActivity(e.conv, data.message.seq);
    this._fillGap(e.conv, c, known, data.message.seq).catch(() => {});
    this._afterOwnPost(e.conv, data.message.seq);
    this.emit('messages', { conv: e.conv, reason: 'sent', message: data.message });
    this.emit('activity');
    this._countReply(e.conv, data.message); // a queued reply: the root's line follows as a live one's does
    if (c.hasNewer) this.jumpToLatest(e.conv).catch(() => {});
    if (this.unfurlsIn(e.conv) && firstUnfurlableLink(e.text)) this._unfurl(e.conv, data.message.seq);
  }

  /**
   * Keep the placeholders of queued messages in step with their outbox
   * entries (set aside, or back in line; a file gone up), and take off one
   * whose entry the device's store no longer holds. The tabs of this
   * browser share the store but not the word that one of them changed it:
   * a row this tab had put back on its own reload (see _restoreQueued)
   * stood after another tab had discarded the entry, "Queued" or not sent
   * with its Retry, until this tab was reloaded, and Retry on it sent the
   * message the member had discarded (the entry gone, the row is sent anew
   * under a client id the worker never saw). One another tab sent is
   * replaced by the message itself when the poll brings it, as before; gone
   * a poll early, it is that message's row a poll on. This tab's own
   * delivery lays the message in before it takes the entry out (see
   * _deliverQueued and outbox.js pass), and a live send still on its way
   * has no entry and is not `queued`, so neither is touched. Asked by the
   * outbox's every change, and by each poll while a window shows a queued row.
   */
  async _syncQueued() {
    if (!this.wsId) return;
    const all = await this.outbox.list();
    // The device's store could not be read this once (see outbox.js list):
    // nothing is known of the entries, and nothing is done to the rows.
    // Read as an empty list, every queued row left the screen as sent or
    // discarded elsewhere, with the messages still in the store, and the
    // polls stopped flushing them.
    if (!all) return;
    const entries = new Map(all.filter((e) => e.ws === this.wsId).map((e) => [e.id, e]));
    for (const [convId, c] of this.convs) {
      let changed = false;
      const gone = c.messages.filter((m) => m.queued && !entries.has(m.tempId));
      if (gone.length) {
        c.messages = c.messages.filter((m) => !gone.includes(m));
        changed = true;
      }
      for (const m of c.messages) {
        const e = m.queued ? entries.get(m.tempId) : null;
        if (!e) continue;
        if (m.failed !== !!e.failed) {
          m.failed = !!e.failed;
          m.error = e.failed ? { message: e.lastError } : null;
          changed = true;
        }
        // A file that has gone up moves from waiting to an attachment on the
        // entry (see outbox.js pass); the placeholder follows it.
        const atts = queuedAttachments(e);
        if (JSON.stringify(atts) !== JSON.stringify(m.attachments)) {
          m.attachments = atts;
          changed = true;
        }
      }
      if (changed) this.emit('messages', { conv: convId, reason: 'local' });
    }
    // Something waits to go out, for this workspace or another (queued
    // there, then the switch): the next poll that gets through sends it (a
    // connection lost with the browser still saying online has no 'online'
    // event to send it on), and the flush sends the whole queue.
    this._hasQueued = all.some((e) => !e.failed);
  }

  /** Put queued (unsent) messages back into their conversations after a reload. */
  async _restoreQueued() {
    const entries = ((await this.outbox.list()) || []).filter((e) => e.ws === this.wsId);
    for (const e of entries) {
      // Not one set aside for a conversation the workspace no longer has:
      // _dropGoneQueued, asked as the document was laid in, is letting it
      // go with a word. Both read the device's store as the workspace
      // opens, and the store answers reads in the order they were asked,
      // so this one's answer still listed the entry the drop was taking
      // out: laid back in, the message stood as a failed row in a window
      // for a channel that is gone, which nothing can open and which is
      // kept for the session for the unsent row in it, after the word
      // that it had been dropped.
      if (e.failed && this._queuedConvGone(e)) continue;
      const c = this.conv(e.conv);
      if (c.messages.some((m) => m.tempId === e.id)) continue;
      c.messages.push({ seq: null, tempId: e.id, cid: e.id, user: this.uuid, text: e.text, ts: e.ts, kind: 'msg', attachments: queuedAttachments(e), mentions: [], reactions: {}, replyCount: 0, queued: true, failed: !!e.failed, error: e.failed ? { message: e.lastError } : null });
      this.emit('messages', { conv: e.conv, reason: 'local' });
    }
  }

  /**
   * A stale (offline) window is reloaded the moment the network returns: in
   * place, its saved page on screen until the fresh one lands (see
   * loadConversation), not unloaded first and drawn as a skeleton meanwhile.
   */
  async refreshStale() {
    for (const [conv, c] of this.convs) {
      if (c.stale && this._hostUp(conv)) await this.loadConversation(conv, { again: true });
    }
    if (this.offline && this.wsId) {
      const wsId = this.wsId;
      // Numbered among the document refreshes, as opening a workspace is
      // (see refreshWorkspace): a document asked for before this one (the
      // refresh after a change made as the connection came back) and landing
      // after it must not lay its older state over the fresh bootstrap, nor
      // this bootstrap its own over a fresher document applied meanwhile.
      const n = ++this._wsFetch;
      const startedAt = Date.now();
      try {
        const data = await api.workspace(wsId);
        if (this.wsId !== wsId || n < this._wsApplied) return; // switched away meanwhile, or a fresher document stands
        this._wsApplied = n;
        this._afterBootstrap(wsId, data, startedAt);
      } catch {
        /* still offline */
      }
    }
  }

  /**
   * Open a conversation around one message (a permalink or a search result).
   * The window it loads may stop short of the newest messages; the list then
   * pages forward with loadNewer and offers a jump back to the latest.
   */
  async loadAround(convId, seq) {
    const c = this.conv(convId);
    const gen = c.gen = (c.gen || 0) + 1;
    c.loading = true;
    c.error = null;
    c.loaded = false;
    // What has not been sent yet (queued, failed with a retry to offer) has
    // no place in any window but this conversation's; it is kept through
    // the jump, as loadConversation and jumpToLatest keep it.
    const unsent = c.messages.filter((m) => m.seq == null);
    c.messages = unsent;
    this.emit('messages', { conv: convId, reason: 'loading' });
    try {
      const from = Math.max(1, seq - AROUND);
      const to = seq + AROUND;
      const host = this.hostOf(convId);
      const xBefore = this.act.c[convId]?.x || 0;
      const announced = this.latestSeq(convId);
      const data = await api.messages(host.ref, host.conv, { from, to });
      if (this._dropped(convId, c) || c.gen !== gen) return c;
      if (!data.messages.length && (data.seq || 0) > 0) {
        // Nothing stands in the span asked for: the message lies past the
        // counter (a link kept from before a workspace was moved, or
        // mistyped), or everything around it has been deleted. A window with
        // no message in it has nothing to page from (an older page is asked
        // for from its oldest message, a newer one from its newest, and it
        // has neither), so it stayed empty, and opening the conversation
        // again found it loaded and showed it again: the conversation was
        // blank until the workspace was switched. The newest page is shown
        // instead, as opening the conversation shows it. An empty
        // conversation (no counter) is empty, and is shown as such.
        c.loading = false;
        c.loaded = false;
        return this.loadConversation(convId);
      }
      c.messages = mergeMessages(data.messages, c.messages.filter((m) => m.seq == null));
      c.hasMore = from > 1;
      c.hasNewer = to < data.seq;
      // A window that stops short of the end reaches the counter for the
      // list's purposes (it pages forward on request); one that reaches the
      // end has reached the counter as far as it was announced (see _reachOf).
      const reach = this._reachOf(data, announced, c.messages);
      c.seq = c.hasNewer ? data.seq : reach;
      c.loaded = true;
      // The worker answered: what the window holds is its page, not the one
      // saved on the device while the connection was away (see
      // loadConversation). Left marked stale, the list said "You are offline.
      // Showing messages saved on this device" over a permalink just fetched,
      // and the next poll read the window afresh as a stale one, putting the
      // newest page in place of the message the reader had jumped to.
      c.stale = false;
      this._noteOverlaysSeen(convId, c, xBefore);
      this._noteActivity(convId, reach);
      this.emit('messages', { conv: convId, reason: 'init', focus: seq, found: c.messages.some((m) => m.seq === seq) });
    } catch (e) {
      if (this._dropped(convId, c) || c.gen !== gen) return c; // (see loadConversation's catch)
      c.error = e;
      this.emit('messages', { conv: convId, reason: 'error' });
    } finally {
      if (c.gen === gen) c.loading = false;
    }
    return c;
  }

  /**
   * The sequence number of the first message posted at or after `ts`, found
   * by binary search over sequence numbers with one single-message read per
   * probe (a conversation of five thousand messages takes about thirteen),
   * so jumping to a date needs no index and no new route. Null when every
   * message is older than `ts`.
   */
  async seqAtOrAfter(convId, ts) {
    // A read never returns a deleted message, so a probe asks for a short
    // run and takes the first message in it, widening the run when nothing
    // in it is left; only a run of hundreds of deleted messages in a row is
    // stepped over blind.
    const host = this.hostOf(convId);
    const probe = async (from, hi) => {
      let to = from;
      for (const span of [5, BLOCK_SIZE, 3 * BLOCK_SIZE]) {
        to = Math.min(hi, from + span - 1);
        const page = await api.messages(host.ref, host.conv, { from, to });
        if (page.messages[0]) return { m: page.messages[0], to, total: page.seq || 0 };
        if (to >= hi) break;
      }
      return { m: null, to, total: 0 };
    };
    const head = await api.messages(host.ref, host.conv, { from: 1, to: 5 });
    const total = head.seq || 0;
    if (!total) return null;
    const first = head.messages[0] || (total > 5 ? (await probe(6, total)).m : null);
    if (!first) return null;
    if (first.ts >= ts) return first.seq;
    let lo = first.seq + 1; // the first message is older
    let hi = total;
    let found = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const { m, to } = await probe(mid, hi);
      if (!m) {
        lo = to + 1;
      } else if (m.ts >= ts) {
        found = m.seq;
        hi = mid - 1;
      } else {
        lo = m.seq + 1;
      }
    }
    return found;
  }

  /**
   * Open the conversation at the first message on or after a date; the
   * newest page when there is none. The date is found by a dozen reads in
   * turn (see seqAtOrAfter), and the reader may move on meanwhile: to the
   * latest messages or the beginning (a load of the window since, by its
   * number; see loadConversation), to another conversation (the window
   * gone, or read anew), to another workspace whose direct message of the
   * same id has a window of its own here. The later word stands: landed
   * after it, the jump took the list back to the date just as the reader
   * had left it for the latest messages, or opened the other workspace's
   * conversation at a place from this one's history.
   */
  async jumpToDate(convId, ts) {
    const wsId = this.wsId;
    const c = this.conv(convId);
    const gen = c.gen || 0;
    const seq = await this.seqAtOrAfter(convId, ts);
    if (this.wsId !== wsId || this._dropped(convId, c) || (c.gen || 0) !== gen) return c;
    if (seq == null) return this.jumpToLatest(convId);
    return this.loadAround(convId, seq);
  }

  /** Page forward from a window opened around an older message. */
  async loadNewer(convId) {
    const c = this.conv(convId);
    if (!c.loaded || !c.hasNewer || c.loading) return 0;
    const last = c.messages.reduce((n, m) => (m.seq > n ? m.seq : n), 0);
    // Numbered like loadConversation: a page asked for by a window that a
    // permalink has since replaced belongs to nothing on screen.
    const gen = c.gen || 0;
    c.loading = true;
    try {
      const host = this.hostOf(convId);
      const announced = this.latestSeq(convId);
      let data;
      try {
        data = await api.messages(host.ref, host.conv, { after: last });
      } catch (e) {
        // Said, as an older page failing is said (see loadOlder): the list
        // drew "Loading newer messages" when it asked, and nothing redrew it
        // after the failure, so the line stood, with no page coming and no
        // button to ask for it again.
        if (!this._dropped(convId, c) && (c.gen || 0) === gen) this.emit('messages', { conv: convId, reason: 'newer-failed' });
        throw e;
      }
      if (this._dropped(convId, c) || (c.gen || 0) !== gen) return 0;
      c.messages = mergeMessages(c.messages, data.messages);
      // The last page joins the window to the end: what it has reached is
      // then the counter as far as it was announced (see _reachOf).
      const reach = this._reachOf(data, announced, c.messages);
      c.seq = data.hasMore ? data.seq : reach;
      c.hasNewer = data.hasMore;
      this._noteActivity(convId, reach);
      this.emit('messages', { conv: convId, reason: 'newer-page', count: data.messages.length });
      return data.messages.length;
    } finally {
      if ((c.gen || 0) === gen) c.loading = false;
    }
  }

  /** Drop a detached window and load the newest page again. */
  async jumpToLatest(convId) {
    const c = this.conv(convId);
    if (c.loading) {
      // A load of the newest page is on its way already: this is it.
      if (!c.hasNewer) return c;
      // A page of the detached window is (the reader at its edge as they
      // sent): the jump goes ahead and that answer is dropped, as the
      // window it continues is gone. Waited for instead, the page landed
      // after the message just sent had been laid at the window's end, and
      // carried the window on from that message with everything between
      // left out, and nothing to say so.
      c.gen = (c.gen || 0) + 1;
      c.loading = false;
    }
    c.loaded = false;
    c.hasNewer = false;
    c.messages = c.messages.filter((m) => m.seq == null);
    return this.loadConversation(convId);
  }

  async loadOlder(convId) {
    const c = this.conv(convId);
    // Paging back from an unsent entry (it has no sequence number) would read
    // the newest page instead of an older one.
    const first = c.messages.find((m) => m.seq != null);
    if (!c.loaded || !c.hasMore || c.loading || !first) return 0;
    const gen = c.gen || 0;
    c.loading = true;
    try {
      const host = this.hostOf(convId);
      let data;
      try {
        data = await api.messages(host.ref, host.conv, { before: first.seq });
      } catch (e) {
        // Said, so the list can offer to try again: nothing else would
        // redraw its "loading" line, and the sentinel that asked for the
        // page is still in view, so it would not ask again on its own.
        if (!this._dropped(convId, c) && (c.gen || 0) === gen) this.emit('messages', { conv: convId, reason: 'older-failed' });
        throw e;
      }
      if (this._dropped(convId, c) || (c.gen || 0) !== gen) return 0;
      c.messages = mergeMessages(data.messages, c.messages);
      c.hasMore = data.hasMore;
      this.emit('messages', { conv: convId, reason: 'older', count: data.messages.length });
      return data.messages.length;
    } finally {
      if ((c.gen || 0) === gen) c.loading = false;
    }
  }

  /**
   * One forward read of a window at a time: asked again while one is on its
   * way, the read out serves the second asker rather than the same page
   * being read twice. This workspace's sync and a host's land within the
   * same moment (see poll), and each brought every window with news up to
   * date (see _queueWindowUpdates), so with a shared channel in the
   * workspace every new message in the open channel was read twice, once
   * for each answer; the DMs pane asks for a window the poll is asking for
   * the same way. A message landing while the read is out is brought by the
   * next poll, which finds the window still behind the counter.
   */
  fetchNewer(convId) {
    const c = this.conv(convId);
    if (c.newerTask) return c.newerTask;
    const task = this._fetchNewer(convId).finally(() => { if (c.newerTask === task) c.newerTask = null; });
    c.newerTask = task;
    return task;
  }

  async _fetchNewer(convId) {
    const c = this.conv(convId);
    if (!c.loaded) return this.loadConversation(convId);
    // A window opened around an older message pages forward on request only.
    if (c.hasNewer) return [];
    // What the window has reached: its newest message, or the counter its
    // last read reported when it holds none (its newest messages all
    // deleted, which a read never returns), as _queueWindowUpdates measures
    // it. A message still being sent (or one that failed and is waiting for
    // a retry) has none, and asking for "everything after nothing" reads
    // the conversation from its first message: the whole history, laid page
    // by page into a window that stood at the end.
    const after = c.messages.reduce((n, m) => (m.seq > n ? m.seq : n), c.seq || 0);
    const gen = c.gen || 0;
    const host = this.hostOf(convId);
    const announced = this.latestSeq(convId);
    const data = await api.messages(host.ref, host.conv, { after });
    // The window was replaced meanwhile (a permalink opened at an older
    // message): what came back continues a window that is gone, and merging
    // it would leave a silent gap in the new one.
    if (this._dropped(convId, c) || (c.gen || 0) !== gen) return [];
    const fresh = data.messages.filter((m) => !c.messages.some((x) => x.seq === m.seq));
    // What the window has reached: the counter, once the answer is whole (as
    // far as it had been announced, see _reachOf). A page with more to come
    // that carried new messages leaves it at the newest of them, so that the
    // next page failing (the connection dropping mid-walk) leaves the rest
    // to the next poll rather than counted as read and never fetched. One
    // with more to come that brought nothing new is a run of deleted
    // messages as long as the page, and reached the page's end: three blocks
    // from the one the first message asked for lies in (the worker's page,
    // as REFRESH_SPAN has it), never the counter, which may lie past the
    // page with messages beyond it that no poll would then fetch (the window
    // looking up to date) and that the list would mark read.
    if (!data.hasMore) c.seq = this._reachOf(data, announced, c.messages);
    else if (!fresh.length) c.seq = Math.max(c.seq || 0, Math.min(data.seq, firstSeqOfBlock(blockIndexOf(after + 1)) - 1 + REFRESH_SPAN));
    if (fresh.length) {
      c.messages = mergeMessages(c.messages, fresh);
      this.emit('messages', { conv: convId, reason: 'newer', added: fresh });
    }
    this._noteActivity(convId, this._reachOf(data, announced, c.messages));
    // Keep walking forward while the counter lies beyond what the window has
    // reached; every page moves the reach on, so no page is asked for twice.
    if (data.hasMore && c.messages.reduce((n, m) => (m.seq > n ? m.seq : n), c.seq || 0) < data.seq) await this._fetchNewer(convId);
    return fresh;
  }

  /**
   * Re-read the loaded window after an overlay change (edit, reaction,
   * thread). One at a time, as fetchNewer: a second asker while one is out
   * (the host's answer after this workspace's, both bringing the same
   * window up to date) shares it; a stamp that moved while the read was
   * out is read again once it lands (see _noteOverlaysSeen).
   */
  refreshRange(convId) {
    const c = this.conv(convId);
    if (c.rangeTask) return c.rangeTask;
    const task = this._refreshRange(convId).finally(() => {
      if (c.rangeTask === task) c.rangeTask = null;
      // Asked for again while this one was out (see _noteOverlaysSeen): now.
      if (c.rangeAgain) {
        c.rangeAgain = false;
        this.refreshRange(convId).catch(() => {});
      }
    });
    c.rangeTask = task;
    return task;
  }

  async _refreshRange(convId) {
    const c = this.conv(convId);
    const sent = c.messages.filter((m) => m.seq != null);
    if (!c.loaded || !sent.length) return;
    const to = sent[sent.length - 1].seq;
    const from = Math.max(sent[0].seq, to - REFRESH_SPAN + 1);
    const gen = c.gen || 0;
    const host = this.hostOf(convId);
    const xBefore = this.act.c[convId]?.x || c.xSeen;
    // What the window held when it asked: the answer speaks for those, and
    // a message laid into the window meanwhile (one announced late, read on
    // its own; see _fillSkipped) is not judged deleted by an answer read
    // from blocks it was not yet in.
    const held = new Set(sent.map((m) => m.seq));
    const data = await api.messages(host.ref, host.conv, { from, to });
    if (this._dropped(convId, c) || (c.gen || 0) !== gen) return;
    c.messages = applyRange(c.messages, data, { from, to, held });
    // `c.seq` says what the window has reached (see _queueWindowUpdates and
    // the list's markSeen), and this read reached no further than `to`: the
    // counter it reports may already count a message posted while the
    // blocks were being read, which the next poll must still fetch, and
    // which the reader has not seen.
    this._noteOverlaysSeen(convId, c, xBefore);
    this.emit('messages', { conv: convId, reason: 'range' });
  }

  /**
   * A window fetched reflects the overlays (edits, reactions, thread counts)
   * as of the stamp when its fetch began, not the stamp when its answer
   * landed: a poll during the fetch may have carried a change the worker
   * made after reading the blocks. Stamping the answer's would mark that
   * change seen, and the poll that reported it has passed, so nothing would
   * fetch it until the next unrelated change; one that moved meanwhile is
   * fetched again now.
   */
  _noteOverlaysSeen(convId, c, xBefore) {
    c.xSeen = xBefore;
    if ((this.act.c[convId]?.x || 0) > xBefore) {
      // From inside a range read (see _refreshRange), the read once more
      // waits for it to land, since a second asker shares the read that is
      // out (see refreshRange); from a page load, it goes now.
      if (c.rangeTask) c.rangeAgain = true;
      else this.refreshRange(convId).catch(() => {});
    }
  }

  _noteActivity(convId, seq) {
    const cur = this.act.c[convId] || {};
    if ((cur.s || 0) < seq) {
      this.act.c[convId] = { ...cur, s: seq };
      this.emit('activity');
    }
  }

  /**
   * A reply of ours has just landed (see send and _placeDelivered): the
   * root's line in the parent's window ("1 reply · Last reply just now")
   * follows at once, rather than at the next poll (four
   * seconds on, thirty with the tab hidden), when the parent's overlay stamp
   * brings the worker's count (see refreshRange). The worker's count wins
   * once it comes: the re-read lays the root afresh over this one. A re-read
   * that got there first (the poll's answer and its re-read both landing
   * before the send's own answer, which follows the worker's pushes) shows
   * this reply already, the root's last-reply time being the reply's own
   * (the worker writes the reply's time there); counted here as well, the
   * root said one reply too many until the next change. Said for the parent
   * with nothing added, so the list keeps the reader's place. A root that
   * is not in the window (or is a tombstone) is left to the poll.
   */
  _countReply(threadId, reply) {
    const t = parentOfThread(threadId);
    if (!t || typeof reply?.ts !== 'number') return;
    const root = this.convs.get(t.conv)?.messages.find((m) => m.seq === t.seq);
    if (!root || root.deleted || (root.lastReplyAt || 0) >= reply.ts) return;
    root.replyCount = (root.replyCount || 0) + 1;
    root.lastReplyAt = reply.ts;
    this.emit('messages', { conv: t.conv, reason: 'local' });
  }

  /**
   * A reply of ours (or one we deleted) has just gone from a thread's window
   * (see remove): the root's line in the parent's window ("3 replies")
   * follows at once, the inverse of _countReply, rather than at the next
   * poll's re-read of the parent (four seconds on, thirty with the tab
   * hidden), when the parent's overlay stamp brings the worker's count. Only
   * when the reply stood in the thread's window here and went with the
   * deletion: one the poll's re-read of the thread had already taken out was
   * counted out by the parent's re-read alongside, and would be counted out
   * twice. Never below nothing. A root that is not in the window, or a
   * tombstone (the root deleted over its replies), is left to the poll, as
   * _countReply leaves it; the root's own deletion is no reply's, and the
   * parent id has no thread to count for.
   */
  _uncountReply(threadId) {
    const t = parentOfThread(threadId);
    if (!t) return;
    const root = this.convs.get(t.conv)?.messages.find((m) => m.seq === t.seq);
    if (!root || root.deleted || !root.replyCount) return;
    root.replyCount -= 1;
    this.emit('messages', { conv: t.conv, reason: 'local' });
  }

  /**
   * How far a page read (`data`, a whole answer: nothing more to come) says
   * the window has reached: the newest message it returned, or those the
   * window holds (`held`), or the conversation's counter, but the counter
   * only as far as the poll had announced it when the page was asked for
   * (`announced`, see latestSeq). The worker takes a message's number
   * before it writes the message, and announces it after, so a page read
   * in between reports a counter one past what it returned, with the
   * message not yet in its block: taken for the reach, that message was
   * never fetched (the poll fetches what lies past the reach, and its
   * announcement then moved the counter to where the reach already stood),
   * the reader was marked as having read it, and the next message's page
   * was asked for from past it, so it never showed here until the
   * conversation was opened afresh. Held to what was announced, the
   * announcement finds the reach short of it and the page is fetched. The
   * counter still counts for a newest message that was deleted, which no
   * page returns and which was announced when it was written: on the
   * messages alone such a window would look forever behind.
   */
  _reachOf(data, announced, held = []) {
    const newest = (list) => (list || []).reduce((n, m) => (m && m.seq != null && m.seq > n ? m.seq : n), 0);
    return Math.max(newest(data.messages), newest(held), Math.min(data.seq || 0, announced || 0));
  }

  /**
   * A message of one's own has landed as the newest of a conversation (a
   * live send, or a queued one delivered; see send and _placeDelivered):
   * the reader has seen up to it, the cursor moves to it, and the counts a
   * read to the end clears go with it, as the worker has it (see its
   * postMessage: posting moves the author's cursor to their message, the
   * newest, and zeroes the mention count and a thread's unread replies, as
   * the read route does for a cursor at the end). Left standing here until
   * the worker's poke brought the document, a poll or two on, a mention of
   * the author that landed in the moments before their own post (between
   * their tab's polls, so the tab had not drawn it yet) kept its red count
   * on the sidebar row, the rail and the tab's title of a conversation they
   * were looking at and had just written in; a reply of theirs in a thread
   * left its earlier replies counted as unread on the Threads badge. Not
   * for a message scheduled for later (see schedule): the worker delivers
   * it at its time with its author not looking, and leaves the counts as
   * it leaves the cursor. A workspace document asked for before the post
   * and answered after it carries the counts from before: held over as a
   * read's word is (see _keepPendingOver), and one asked for from now on is
   * trusted, the worker having cleared them itself by then.
   */
  _afterOwnPost(convId, seq) {
    this._localSeen.set(convId, Math.max(this._localSeen.get(convId) || 0, seq));
    if (!this.me) return;
    this._setMine('reads', convId, Math.max(this.me.reads[convId] || 0, seq));
    if (this.me.mentions?.[convId]) this._setMine('mentions', convId, 0);
    if (this.me.threads?.[convId]) this._setMine('threads', convId, 0);
    this._seenAt.set(convId, { at: Date.now(), acked: Date.now() });
  }

  /**
   * What others posted between the newest message the window held (`known`)
   * and one of ours that just landed at `seq`. A send's answer names its
   * sequence number; a jump past the newest we hold means someone posted
   * since the last poll. Read that stretch now: the poll compares the
   * conversation's counter with the newest message the window holds, which
   * our own message has just brought up to date, so it would never fill
   * the hole on its own.
   */
  async _fillGap(convId, c, known, seq) {
    if (!c.loaded || c.hasNewer || seq <= known + 1) return;
    const gen = c.gen || 0;
    const host = this.hostOf(convId);
    // A range read is answered a few blocks at a time (REFRESH_SPAN of it,
    // then a word that there is more): a stretch longer than that, as after
    // a day offline in a busy channel with a message queued, is read on from
    // where the last answer stopped, or the rest of it would never be, the
    // poll finding the counter already where our message is.
    for (let from = known + 1; from <= seq - 1; from += REFRESH_SPAN) {
      const data = await api.messages(host.ref, host.conv, { from, to: seq - 1 });
      if (this._dropped(convId, c) || (c.gen || 0) !== gen) return;
      const fresh = data.messages.filter((m) => !c.messages.some((x) => x.seq === m.seq));
      if (fresh.length) {
        c.messages = mergeMessages(c.messages, fresh);
        this.emit('messages', { conv: convId, reason: 'range' });
      }
      if (!data.hasMore) return;
    }
  }

  /* ---- writes ----------------------------------------------------------- */

  // A send under a client id the caller supplies is one that may have been
  // out before (a retry, a resend of a placeholder), so it is not offered as
  // a first send; one given no id is minting a fresh one and cannot have a
  // copy of itself anywhere. `first` overrides either way.
  async send(convId, { text, attachments = [], files = [], cid: givenCid = null, first = givenCid === null }) {
    const cid = givenCid || makeClientId();
    this.stopTyping(convId);
    const c = this.conv(convId);
    const temp = {
      seq: null, tempId: cid, cid,
      user: this.uuid, text, ts: Date.now(), kind: 'msg', attachments, mentions: [],
      reactions: {}, replyCount: 0, pending: true,
    };
    c.messages.push(temp);
    this.emit('messages', { conv: convId, reason: 'local', added: [temp] });
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const host = this.hostOf(convId);
    const wsId = this.wsId;
    // Offline, or attachments still on this device: into the outbox, which
    // survives a reload and sends when the connection is back. A shared
    // channel's entry remembers the host it is bound for, since the
    // workspace open then may be another.
    // `attempted`: this message has already gone out once and may well have
    // landed, so the entry starts with that attempt counted and the outbox
    // never offers it as a first send (see the worker's postMessage).
    const queue = async (files, attempted = false) => {
      // Queued under the time it was written, not the time it was queued: a
      // send still on its way when the connection dropped joins the queue
      // after a message written later and queued at once, and the outbox
      // sends oldest first, so the two would land the other way round from
      // the sender's own screen.
      // The attachments already uploaded keep their name, size and type in
      // the entry (the worker is handed their ids alone, see _deliverQueued),
      // so the placeholder drawn from the entry after a reload names them.
      const entry = { id: cid, ts: temp.ts, ws: wsId, conv: convId, text, attachments: attachments.map(({ id, name, size, type }) => ({ id, name, size, type })), files, attempts: attempted ? 1 : 0 };
      if (host.link || host.ref !== wsId) Object.assign(entry, { host: host.ref, hconv: host.conv });
      await this.outbox.enqueue(entry);
      temp.pending = false;
      temp.queued = true;
      // The files still on the device show on the placeholder as waiting to
      // upload (see queuedAttachments): shown as nothing until they had
      // gone up, a message queued with a picture read as a bare line, and
      // the reader could not tell what was waiting to go with it.
      temp.attachments = queuedAttachments(entry);
      // Not with another workspace open by now (see _dropped): the
      // placeholder stands in a window that is gone, and the word reached
      // the list drawn for the new workspace's conversation of the same id.
      if (!this._dropped(convId, c)) this.emit('messages', { conv: convId, reason: 'local' });
      return temp;
    };
    if (offline || files.length) {
      await queue(files);
      if (!offline) this.outbox.flush().catch(() => {});
      return temp;
    }
    // `first` spares the worker a read of the conversation's newest blocks
    // looking for a copy of this message: on a first send there cannot be
    // one. A retry under a client id that has already been out says nothing,
    // and is checked (see the worker's postMessage).
    const post = () => api.send(host.ref, host.conv, { text, attachments: attachments.map((a) => ({ id: a.id })), cid, ...(first ? { first: true } : {}) });
    try {
      let data;
      try {
        data = await post();
      } catch (err) {
        // The host of a shared channel says the member's standing there has
        // lapsed (the day it gives ran out while the tab slept, before the
        // poll came round to renewing it): renewed the way the outbox's
        // delivery renews on that word (see _deliverQueued), then sent once
        // more under the same client id. Treated as a refusal, the message
        // sat as failed with a Retry button for a renewal that happens by itself.
        const link = err instanceof ApiError && err.status === 403 && err.code === 'reattest' && host.link && this.wsId === wsId ? this.links.get(host.ref) : null;
        if (!link) throw err;
        await this._loadLink(link);
        if (this.links.get(host.ref) !== link || !link.loaded) throw this._linkFailure(link, err);
        data = await post();
      }
      if (this._dropped(convId, c)) {
        // Sent, but the workspace on screen changed meanwhile: nothing is
        // laid into the window here, which is another workspace's now. The
        // preview card is asked for all the same, of the workspace the
        // message lives in (the worker builds one only when asked), as it
        // is for a queued message delivered after a switch (see
        // _placeDelivered); whether previews are on there is no longer
        // known from here, and the worker declines when its switch is off.
        if (data.message && firstUnfurlableLink(text)) api.unfurl(host.ref, host.conv, data.message.seq).catch(() => {});
        return data.message || null;
      }
      // What the window has reached (as _queueWindowUpdates reads it): its
      // newest message, or the counter its last read reported when the
      // newest messages were deleted and it holds none of them.
      const known = c.messages.reduce((n, m) => (m.seq > n ? m.seq : n), c.seq || 0);
      const i = c.messages.indexOf(temp);
      if (i > -1) c.messages.splice(i, 1);
      if (!data.message) {
        // A retry of a send that had landed (its answer lost) and has since
        // been deleted, with nothing to answer with (see _placeDelivered):
        // nothing to show, and the placeholder goes. Read for a message the
        // answer did not carry, the retry failed on its own reading and the
        // row stood as "Not sent", with a fault for its reason.
        this.emit('messages', { conv: convId, reason: 'local' });
        return null;
      }
      if (!c.messages.some((m) => m.seq === data.message.seq)) c.messages = mergeMessages(c.messages, [data.message]);
      c.seq = Math.max(c.seq, data.message.seq);
      this._noteActivity(convId, data.message.seq);
      this._fillGap(convId, c, known, data.message.seq).catch(() => {});
      this._afterOwnPost(convId, data.message.seq);
      this.emit('messages', { conv: convId, reason: 'sent', message: data.message });
      this.emit('activity');
      // A reply: the root's line in the parent follows at once (see _countReply).
      this._countReply(convId, data.message);
      // Sent from the middle of history: the new message belongs at the end,
      // which the window does not hold yet.
      if (c.hasNewer) this.jumpToLatest(convId).catch(() => {});
      // A link gets its preview built by the worker now, off the send path;
      // the card arrives for everyone through the next overlay refresh.
      if (this.unfurlsIn(convId) && firstUnfurlableLink(text)) this._unfurl(convId, data.message.seq);
      return data.message;
    } catch (e) {
      // Failed for want of a connection (the worker out of reach, the request
      // timed out) while the browser still says it is online: into the
      // outbox all the same, under the same client id (a send that did land
      // is not posted twice), rather than a failed placeholder that lives in
      // this tab's window alone and is gone with a reload or a switch of
      // workspace. The next poll to get through flushes it.
      if (e instanceof ApiError && (e.code === 'network' || e.code === 'timeout')) return queue([], true);
      temp.pending = false;
      temp.failed = true;
      temp.error = e;
      if (!this._dropped(convId, c)) this.emit('messages', { conv: convId, reason: 'failed', message: temp }); // (see queue above)
      throw e;
    }
  }

  /**
   * Are link previews on where a conversation lives? The setting is the
   * workspace's whose worker builds the card: for a shared channel, the
   * host's (this workspace's own switch says nothing about a channel it
   * does not host, and the host's worker declines the request anyway when
   * its switch is off). Until the host has answered, this workspace's.
   */
  unfurlsIn(convId) {
    const { link } = this.hostOf(convId);
    return (link?.ws || this.ws)?.unfurl !== false;
  }

  async _unfurl(convId, seq, shown = null) {
    const wsId = this.wsId;
    const host = this.hostOf(convId);
    try {
      const { unfurl } = await api.unfurl(host.ref, host.conv, seq);
      if (!unfurl || this.wsId !== wsId) return;
      // The card goes onto the window's copy, or the caller's for a message
      // the window does not hold (an edited thread root; see _heldOrShown).
      const m = this._heldOrShown(convId, seq, shown);
      if (m) {
        m.unfurl = unfurl;
        this.emit('messages', { conv: convId, reason: 'range' });
      }
    } catch {
      /* no card, no error: previews are best effort */
    }
  }

  /**
   * One message, for the quote card under a permalink to it: from the loaded
   * window when it is there, otherwise fetched once and remembered. Returns
   * { value } when known (null meaning nothing to show: deleted, gone, or a
   * conversation this member may not read — the worker is the judge, so a
   * private channel leaks nothing), or { promise } while it is being
   * learned. A worker's refusal holds for the session; a network failure or
   * a passing condition (a 5xx, a budget, a lapsed attestation) is forgotten
   * so a later render may try again.
   */
  quotedMessage(convId, seq) {
    const live = this.convs.get(convId)?.messages.find((m) => m.seq === seq);
    if (live) return { value: live.deleted ? null : live };
    const key = `${this.wsId}:${convId}:${seq}`;
    let hit = this._quoted.get(key);
    if (!hit) {
      hit = {
        promise: (async () => {
          try {
            const host = this.hostOf(convId);
            const data = await api.messages(host.ref, host.conv, { from: seq, to: seq });
            const m = (data.messages || []).find((x) => x.seq === seq && !x.deleted) || null;
            this._quoted.set(key, { value: m });
            return m;
          } catch (e) {
            // Only a real refusal holds for the session. A worker hiccup
            // (5xx), a budget (429), or a lapsed shared-channel attestation
            // (403 reattest — the link poll renews it on its own) is
            // forgotten like a network failure, so a later render retries.
            // So is the address not answering for the moment (a bare 404
            // while the worker is redeployed, `no_backend`; see isRefusal),
            // and a 401, which the worker answers whenever Puter's word on
            // who is asking cannot be had (Puter not answering it for a
            // moment as often as a sign-in that has lapsed; see files.js
            // refused): held as the worker's word on the message, either
            // left the card blank for the rest of the session, as if the
            // message were gone, while everything else had long recovered.
            const refused = isRefusal(e) && e.status !== 429 && e.status !== 401 && e.code !== 'reattest';
            if (refused) this._quoted.set(key, { value: null });
            else this._quoted.delete(key);
            return null;
          }
        })(),
      };
      this._quoted.set(key, hit);
    }
    return hit;
  }

  async removeUnfurl(convId, seq, shown = null) {
    const host = this.hostOf(convId);
    const wsId = this.wsId;
    await api.removeUnfurl(host.ref, host.conv, seq);
    if (this.wsId !== wsId) return; // another workspace is open now: its message of this number keeps its card (see remove)
    const m = this._heldOrShown(convId, seq, shown);
    if (m) {
      m.unfurl = null;
      this.emit('messages', { conv: convId, reason: 'range' });
    }
  }

  async retry(convId, temp) {
    // A queued message still sits in the outbox (attachment bytes included):
    // put it back in line there, so it keeps its client id and is not sent
    // a second time by the next flush.
    if (temp.queued && (await this.outbox.retry(temp.tempId))) {
      temp.failed = false;
      temp.error = null;
      this.emit('messages', { conv: convId, reason: 'local' });
      await this.outbox.flush();
      return temp;
    }
    // A queued message whose entry is gone from the device's store (discarded
    // from another tab of this browser, whose word does not reach this one;
    // the browser having let the store go) with a file still shown waiting
    // under it (see queuedAttachments): the file's bytes went with the entry,
    // and there is nothing left to upload. Sent all the same, the message
    // went without the file (a card handed to the worker as an attachment
    // with no file behind it, which it drops), or, made of the file alone,
    // was refused for saying nothing, the card standing under it either way.
    // Said instead, with what to do; the row keeps its Retry and Discard.
    const waiting = (temp.attachments || []).filter((a) => a.uploading);
    if (waiting.length) {
      const one = waiting.length === 1;
      temp.failed = true;
      temp.error = new Error(`The ${one ? 'file' : 'files'} waiting to go with this message ${one ? 'is' : 'are'} no longer on this device. Discard the message and attach ${one ? 'it' : 'them'} again`);
      this.emit('messages', { conv: convId, reason: 'local' });
      throw temp.error;
    }
    // A send that failed in flight may well have been received (a response
    // lost after the write): the retry carries the same client id, so the
    // worker answers with the message it has instead of posting it twice.
    const c = this.conv(convId);
    const i = c.messages.indexOf(temp);
    if (i > -1) c.messages.splice(i, 1);
    return this.send(convId, { text: temp.text, attachments: temp.attachments, cid: temp.cid, first: false });
  }

  discard(convId, temp) {
    const c = this.conv(convId);
    const i = c.messages.indexOf(temp);
    if (i > -1) c.messages.splice(i, 1);
    if (temp.queued) this.outbox.remove(temp.tempId).catch(() => {});
    this._releaseUnsent(convId, temp.attachments, this.hostRef(convId));
    this.emit('messages', { conv: convId, reason: 'local' });
  }

  /**
   * The files a message that will never go out had already put up (a queued
   * message discarded, or dropped with its conversation): nobody's now, so
   * the worker is asked to let their bytes go (see DELETE /files/:id), as
   * the box asks for a chip taken out. Best effort: one a message names by
   * now (a send whose answer was lost had landed all the same) is kept by
   * the worker, with a word this side never needs. Kept, every attachment
   * of a message discarded sat in the owner's storage for good, with
   * nothing to find it by. Only what went up: a file still on this device
   * (`uploading`, see queuedAttachments) has nothing on the worker.
   */
  _releaseUnsent(convId, attachments, ref) {
    for (const a of attachments || []) if (a?.id && !a.uploading) api.deleteFile(ref, a.id).catch(() => {});
  }

  async edit(convId, seq, text, shown = null) {
    const host = this.hostOf(convId);
    const wsId = this.wsId;
    const data = await api.edit(host.ref, host.conv, seq, text);
    if (this.wsId !== wsId) {
      // Answered with another workspace open (a switch while the request
      // was out): the edit stands on the worker, and the window here is
      // that workspace's now (a direct message shares its id across
      // workspaces, so a message of the same number may well stand in it).
      // A link the edit brought in gets its card from the workspace the
      // message lives in, asked here since the worker builds one only when
      // asked (see send), and not from the workspace switched to, whose
      // worker would have put a card on its own message of that number.
      if (data.relink && firstUnfurlableLink(data.text)) api.unfurl(host.ref, host.conv, seq).catch(() => {});
      return;
    }
    // The message as the window holds it now, not as it held it when the
    // edit was asked for: a range read landing meanwhile (someone's reaction
    // on any message of the page, re-read by the poll) lays fresh copies of
    // the messages into the window, and the edit written onto the copy from
    // before reached nothing on screen, the old text standing until the next
    // poll happened to read the range again. Or the caller's copy, for a
    // message the window does not hold (see _heldOrShown).
    const m = this._heldOrShown(convId, seq, shown);
    if (m) {
      m.text = data.text;
      m.editedAt = data.editedAt;
      // The worker drops a card whose link the edit took out or replaced,
      // and says so; the new link, if there is one, gets its own below.
      if (data.relink) m.unfurl = null;
      this.emit('messages', { conv: convId, reason: 'range' });
    }
    if (data.relink && this.unfurlsIn(convId) && firstUnfurlableLink(data.text)) this._unfurl(convId, seq, shown);
  }

  async remove(convId, seq, shown = null) {
    const host = this.hostOf(convId);
    const wsId = this.wsId;
    await api.remove(host.ref, host.conv, seq);
    // Answered with another workspace open (a switch while the request was
    // out): the deletion stands on the worker, and the window here is that
    // workspace's now. A direct message shares its id across workspaces, so
    // its message of the same number went off the screen here, and stayed
    // off until the conversation was read afresh: a re-read of the overlays
    // lays nothing back that the window does not hold (see applyRange). The
    // workspace asked shows the deletion when it is opened again.
    if (this.wsId !== wsId) return;
    const c = this.conv(convId);
    const m = c.messages.find((x) => x.seq === seq);
    if (m) {
      if (m.replyCount) m.deleted = true;
      else c.messages = c.messages.filter((x) => x.seq !== seq);
      this.emit('messages', { conv: convId, reason: 'range' });
      // A reply: the root's line in the parent follows at once (see _uncountReply).
      this._uncountReply(convId);
    } else if (shown && shown.seq === seq) {
      // The caller's copy of a message the window does not hold (see
      // _heldOrShown): it stands as deleted where it is drawn (a thread
      // panel's root, whose thread closes on the word), there being no
      // window to take it out of.
      shown.deleted = true;
      this.emit('messages', { conv: convId, reason: 'range' });
    }
  }

  /**
   * Toggle one's own reaction on a message. `shown` is the message as the
   * caller draws it, for one the conversation's window here does not hold:
   * the root of a Threads view card is drawn from the worker's listing while
   * its channel has not been opened in this tab (the common case), and the
   * flip goes onto that copy, which the card redraws from, and to the worker
   * all the same. Returned from without a word when the window did not hold
   * the message, as it used to be, a reaction on such a root (the bar's quick
   * reactions, the "+" pill, the picker's pick) did nothing at all.
   */
  async react(convId, seq, reaction, shown = null) {
    const c = this.conv(convId);
    const held = c.messages.find((x) => x.seq === seq);
    const m = held || (shown && shown.seq === seq ? shown : null);
    if (!m) return;
    const on = !m.reactions?.[reaction]?.[this.uuid];
    // Optimistic: flip locally, then confirm.
    const before = m.reactions;
    m.reactions = { ...(m.reactions || {}) };
    const users = { ...(m.reactions[reaction] || {}) };
    if (on) users[this.uuid] = 1;
    else delete users[this.uuid];
    if (Object.keys(users).length) m.reactions[reaction] = users;
    else delete m.reactions[reaction];
    this.emit('messages', { conv: convId, reason: 'range' });
    // One toggle of a reaction on the worker at a time: a second tap while
    // the first was on its way (on, then off) reached the worker as two
    // writes racing each other, and the "off" read the message before the
    // "on" had landed and did nothing, so the reaction came back with the
    // next refetch though the tap had taken it off. The second waits for
    // the first's answer, then goes; the local flip is at once, as before.
    const host = this.hostOf(convId);
    const key = `${convId}:${seq}:${reaction}`;
    const send = () => api.react(host.ref, host.conv, seq, reaction, on);
    const turn = (this._reactTurns.get(key) || Promise.resolve()).then(send, send);
    const tail = turn.catch(() => {});
    this._reactTurns.set(key, tail);
    tail.then(() => { if (this._reactTurns.get(key) === tail) this._reactTurns.delete(key); });
    try {
      await turn;
    } catch (e) {
      // Another workspace is open by now (see _dropped): the window the flip
      // was made in is gone, and so is a card drawn from it. A read here
      // would be of the new workspace's conversation of the same id (a
      // direct message shares its id across workspaces), and the word of it
      // would redraw that list for nothing.
      if (this._dropped(convId, c)) throw e;
      // The window's copy is read afresh from the worker; the caller's copy
      // (see `shown`), which no read here reaches, takes its flip back.
      if (held) await this.refreshRange(convId).catch(() => {});
      else {
        m.reactions = before;
        this.emit('messages', { conv: convId, reason: 'range' });
      }
      throw e;
    }
  }

  /** The user has seen up to `seq` in a conversation; debounce the server call. */
  markRead(convId, seq) {
    if (!this.me || !seq) return;
    const prevLocal = this._localSeen.get(convId) || 0;
    const prevRead = this.me.reads[convId] || 0;
    // The badges clear when the conversation is read to its end (the worker
    // does the same): the end of a window opened at a permalink has not
    // shown the mention that is beyond it.
    const latest = this.latestSeq(convId);
    const hadMentions = seq >= latest && (this.mentionCount(convId) > 0 || this.threadUnread(convId) > 0);
    if (seq <= prevLocal && !hadMentions) return;
    this._localSeen.set(convId, Math.max(prevLocal, seq));
    if (hadMentions) {
      this._setMine('mentions', convId, 0);
      if (this.me.threads?.[convId]) this._setMine('threads', convId, 0);
    }
    // A mention in a thread is counted on its channel (the worker badges
    // the parent, whose own messages need not have moved), so reading the
    // thread must clear it there too, or the channel's badge and the title
    // count stand until the channel itself is scrolled. Only when the
    // channel's own messages are all seen — then the only mentions its
    // count can hold are in threads — and this thread held one just read.
    const t = parentOfThread(convId);
    if (t && this.mentionCount(t.conv) > 0) {
      const seenParent = Math.max(this._localSeen.get(t.conv) || 0, this.me.reads[t.conv] || 0);
      const mentionedHere = this.conv(convId).messages.some((m) => m.seq <= seq && (m.mentions?.includes(this.uuid) || (!!m.broadcast && m.user !== this.uuid)));
      if (mentionedHere && seenParent >= this.latestSeq(t.conv)) this.markRead(t.conv, seenParent);
    }
    // Read to the end: its notifications close here and on the user's other devices.
    if (seq >= latest) {
      const { ref, conv } = this.hostOf(convId);
      const tags = [`message-${conv}`, `reply-${conv}`, ...(this.mentionCount(convId) ? [] : [`mention-${conv}`])];
      dismissShown(new Set(tags.map((tag) => `${ref}:${tag}`))).catch(() => {});
    }
    this.emit('activity');
    if (seq <= prevRead && !hadMentions) return;
    // Noted for refreshWorkspace only when a read goes out: the entry says
    // the worker's document may lag this reading, and clears the badge until
    // a document built after the read landed. One with nothing to send would
    // keep clearing for good, and hide a later mention in a thread.
    const seen = { at: Date.now(), acked: 0 };
    this._seenAt.set(convId, seen);
    // The workspace is captured, not read when the timer fires: switching
    // away inside the debounce window would otherwise move a cursor in
    // whichever workspace is open by then.
    const wsId = this.wsId;
    const host = this.hostOf(convId);
    // Filed under the workspace too (see _readKey): a read of the other
    // workspace's direct message of the same id, arriving inside the
    // debounce, cancelled this one, and it never went out.
    const key = this._readKey(convId, wsId);
    clearTimeout(this._readTimers.get(key));
    // What the debounce does, kept where the page going away can do it at
    // once (see _flushReads): a conversation read in the last half-second
    // before the tab was closed, reloaded, or put away on a phone stayed
    // unread on every other device, its read never sent.
    const fire = () => {
      clearTimeout(this._readTimers.get(key));
      this._readTimers.delete(key);
      this._readPending.delete(key);
      const target = (this.wsId === wsId ? this._localSeen.get(convId) : 0) || seq;
      this._sendRead(convId, { wsId, conv: convId, host, target, seen, attempts: 0, nextAt: 0 });
    };
    this._readPending.set(key, fire);
    this._readTimers.set(key, setTimeout(fire, 600));
  }

  /**
   * Send every read still in its debounce (see markRead) now: the page is
   * being put away (visibilitychange to hidden, where it is alive and the
   * request goes out as any other) or going (pagehide, best effort). A
   * mark-unread or a workspace forgotten since has taken its read out.
   */
  _flushReads() {
    for (const fire of [...this._readPending.values()]) fire();
  }

  /**
   * Where a conversation's waiting read is filed (see _readRetry): under its
   * workspace as well as its id. Direct message ids are derived from their
   * members, so the same two people share one across workspaces (see
   * openWorkspace), and filed by the id alone a read waiting for one
   * workspace was written over by, or dropped with, a read or a mark-unread
   * of the other workspace's conversation of the same id.
   */
  _readKey(convId, wsId = this.wsId) {
    return `${wsId}:${convId}`;
  }

  /**
   * Send a read to the worker. Taken: the cursor follows, and a document
   * asked for from now on is trusted (see _keepPendingOver). Not taken for a
   * reason that may pass (out of reach, erroring, a move under way; see
   * isPassing): kept, to be sent again by the next sync that gets through,
   * the next bootstrap, or the connection's return (see _resendReads), and
   * the cursor stays held where the reader left it meanwhile, as it is
   * while the request is out. Given up on a refusal (the workspace moved
   * for good, the conversation gone), and once a newer read or a
   * mark-unread has replaced it, which is then the word that stands.
   */
  _sendRead(convId, read) {
    const { wsId, host, target, seen } = read;
    const key = this._readKey(convId, wsId);
    return api.markRead(host.ref, host.conv, target)
      .then(() => {
        if (this._readRetry.get(key) === read) this._readRetry.delete(key);
        // Not when the conversation was marked unread meanwhile (its
        // local cursor is then below this read's): the answer to a read
        // sent before that would put the cursor back at the end.
        if (this.wsId === wsId && this.me && (this._localSeen.get(convId) || 0) >= target) {
          this._setMine('reads', convId, Math.max(this.me.reads[convId] || 0, target));
          // How the conversation stood as the read was taken (see _healStuckMentions).
          this._readAcked.set(convId, { target, x: this.act.c[convId]?.x || 0, at: this.serverNow() });
        }
        seen.acked = Date.now();
      }, (e) => {
        const renewable = this._readRenewable(read, e);
        // Nor is a read given up on a 401, the worker's word whenever
        // Puter's word on who is asking cannot be had (Puter not answering
        // the worker for a moment as often as a sign-in that has lapsed;
        // see files.js refused): kept, and sent again with the next request
        // that gets through, which a lapsed sign-in never makes. Given up
        // as a refusal, the cursor stayed behind on the worker (nothing
        // sends a read again until a newer message is read here) and the
        // conversation sat unread on every other device, its badge masked
        // here alone by what this tab had seen.
        const unconfirmed = e instanceof ApiError && e.status === 401;
        // A workspace left while the read was on its way (see forgetWorkspace)
        // has nothing to send it to again: kept, it went out to a server gone
        // without a word at every sync, for good.
        const gone = this._forgotten.has(wsId) || this._forgotten.has(host.ref);
        if (this._readCurrent(convId, read) && !gone && (isPassing(e) || renewable || unconfirmed)) {
          read.renewing = renewable;
          read.attempts += 1;
          read.nextAt = Date.now() + Math.min(READ_RETRY_MAX_MS, READ_RETRY_MS * 2 ** (read.attempts - 1));
          this._readRetry.set(key, read);
          return;
        }
        if (this._readRetry.get(key) === read) this._readRetry.delete(key);
        // Given up on: a document requested from now on is trusted.
        seen.acked = Date.now();
      });
  }

  /**
   * A mention counted on the worker for a message this device had already
   * read past. The worker counts a mention a few writes after the message
   * itself is in, and a read of that message sent meanwhile (the reader at
   * the end of the conversation, the message drawn, the read a moment
   * later) can reach it before the count does: the read then clears a
   * count of nothing, the count lands after it, and the badge stood on a
   * conversation read to its end (the row, the title, Activity) until the
   * reader scrolled or something else happened there. `entries` are the
   * conversations' activity entries as the document just laid in has them,
   * under local ids, `ref` the workspace the document speaks for.
   *
   * Told apart from a mention this device has not seen by three things that
   * must all hold: a read of the conversation was taken (see _readAcked)
   * and the reader still stands at or past it; nothing has moved in the
   * conversation since, its counter and its overlay stamp standing where
   * they stood when the read was taken, in the document and here alike (a
   * message or a reply since moves one of them, and the reader would not
   * have seen it); and no thread of it has had a message since the read
   * was taken, by the threads' own entries. The last because a reply that
   * names the reader is counted on the conversation while the
   * conversation's own counter stands, and the worker counts it before it
   * moves the conversation's stamp for the reply, so a document read in
   * between carries the count and not the stamp; the reply's own thread
   * entry is written before either, and gives it away. What is left can
   * only be a count for what was read: the read goes again, which clears
   * it on the worker (a read at the end clears the mentions), and the badge
   * is cleared here meanwhile, as a read at the end clears it.
   */
  _healStuckMentions(entries, ref) {
    for (const [conv, v] of entries) {
      const rec = this._readAcked.get(conv);
      if (!rec || rec.healed || !v || !(this.me?.mentions?.[conv] > 0)) continue;
      if (this.hostOf(conv).ref !== ref) continue;
      if ((v.s || 0) !== rec.target || (v.x || 0) !== rec.x) continue;
      const cur = this.act.c[conv] || {};
      if ((cur.s || 0) !== rec.target || (cur.x || 0) !== rec.x) continue;
      if ((this._localSeen.get(conv) || 0) < rec.target || this._unreadAt.has(conv)) continue;
      if (this._threadActivitySince(conv, rec.at - READ_ACK_GRACE_MS)) continue;
      // And the message the read reached must name the reader (or reach
      // them as a broadcast), for the count to be its. A worker counts a
      // mention before it announces the message (so that no read of the
      // message can come before the count), and a document read in between
      // carries the count while the conversation still stands at the message
      // before, which the reader has read: healed on that, the badge went
      // off for a poll and came back with the announcement. The message
      // itself is in the window, since the read came from its being drawn.
      const reached = this.convs.get(conv)?.messages.find((m) => m.seq === rec.target);
      if (!reached || !(reached.mentions?.includes(this.uuid) || (reached.broadcast && reached.user !== this.uuid))) continue;
      rec.healed = true;
      this.markRead(conv, rec.target);
    }
  }

  /** Has any thread of a conversation had a message at or after `since` (the worker's clock), by the threads' entries? */
  _threadActivitySince(conv, since) {
    for (const [id, a] of Object.entries(this.act.c)) {
      if ((a?.t || 0) >= since && parentOfThread(id)?.conv === conv) return true;
    }
    return false;
  }

  /** Is a read still its conversation's latest word: no newer read and no mark-unread since (another workspace open says nothing either way)? */
  _readCurrent(convId, read) {
    return this.wsId !== read.wsId || this._seenAt.get(convId) === read.seen;
  }

  /**
   * Would a read the host of a shared channel refused for want of a fresh
   * attestation (403 `reattest`: the member's standing there lapsed while
   * the tab slept) be taken once the link has renewed it, as the link does
   * on the same word from its poll (see _applyLinked)? While the workspace
   * is open and the link stands, yes, and the read waits for that: given up
   * instead, the cursor and the mention count the host's document brought
   * with the renewal were yesterday's, and the channel just read to its end
   * sat bold and badged again until it was opened once more, and unread on
   * every other device. A link that is lost (the connection over) renews
   * nothing, and from another workspace nothing is known of it, so the read
   * is given up there as any refusal is. With `e`, whether the failure is
   * that word at all.
   */
  _readRenewable(read, e = null) {
    if (e && !(e instanceof ApiError && e.status === 403 && e.code === 'reattest')) return false;
    if (this.wsId !== read.wsId) return false;
    const link = this.links.get(read.host.ref);
    return !!link && !link.lost;
  }

  /**
   * Send again the reads the worker did not take (see _sendRead), each once
   * its wait is over, now that some request has got through (a sync, a
   * bootstrap, the connection's return): one that reached nobody would
   * fail the same way until then. A read replaced since by a newer one or
   * a mark-unread is dropped.
   */
  _resendReads() {
    const now = Date.now();
    for (const [key, read] of [...this._readRetry]) {
      if (!this._readCurrent(read.conv, read)) {
        this._readRetry.delete(key);
        continue;
      }
      // One waiting on a renewal the link will not make any more (lost
      // meanwhile, or the channel left) is given up, and a document
      // requested from now on is trusted.
      if (read.renewing && !this._readRenewable(read)) {
        this._readRetry.delete(key);
        read.seen.acked = Date.now();
        continue;
      }
      if (read.sending || now < read.nextAt) continue;
      read.sending = true;
      this._sendRead(read.conv, read).finally(() => { read.sending = false; });
    }
  }

  /* ---- events ------------------------------------------------------------ */

  /**
   * The client's own app uid, the same way the worker reads its own: the SDK
   * exposes it directly where it can, and otherwise it is decoded from the
   * client's own auth token with the same decoder the worker uses (see
   * src/shared/events.js), so the two never disagree about it without also
   * disagreeing about how to read it. Public: the events consent toast
   * (src/ui/shell.js) needs it too, to check against GET /api/server's `appUid`.
   * The SDK's value is trusted only when it has the shape the token decode
   * produces (`app-...`): both are compared against the bootstrap's own
   * `appUid` in `own` mode, and an SDK that answers a bare uuid or something
   * else entirely would disagree with the token on shape alone, refusing the
   * owner their own subscription with nothing said about why.
   */
  appUid() {
    const id = typeof puter !== 'undefined' ? puter?.appID : null;
    if (typeof id === 'string' && id.startsWith('app-')) return id;
    return appUidFromToken(typeof puter !== 'undefined' ? puter?.authToken : null);
  }

  /**
   * Arm, refresh, or drop `holder`'s subscription (this.ev for the workspace
   * itself, or a link's own `ev` for a shared channel's host — see
   * _syncLinks). `desc` is a bootstrap's `events` block, or null/undefined
   * when unavailable; everything here is a no-op with no SDK, no block, or a
   * refused `own` mode, which is what makes every row of the fallback matrix
   * (see the design doc) come back to today's behaviour. Called only when
   * something might have changed — same descriptor, still live, is left alone.
   */
  _evApply(holder, wsId, desc) {
    holder.lastDesc = desc || null;
    // Existing subscriptions get the visibility grace period; new ones wait for focus.
    if (typeof document !== 'undefined' && document.hidden) return;
    if (holder.degradedUntil && Date.now() < holder.degradedUntil) {
      if (!holder.retryTimer) this._evArmRetry(holder, wsId, holder.degradedUntil - Date.now());
      return;
    }
    // What this holder is on: the descriptor it is subscribed with, or —
    // once a hidden tab's teardown has taken the subscription down without
    // settling the wait it was on — the one the standing backoff is for.
    const d = holder.desc || (holder.retryUntil > Date.now() ? holder.retryDesc : null);
    // appUid is compared too, not only mode/handle/key/shard: an own-mode
    // bootstrap naming a new app uid over the same key used to read as
    // unchanged, and the tab kept subscribing to the old app's namespace.
    // And whether it reads ring entries, and from which shard (see _ringSig).
    const sig = this._ringSig(holder, desc);
    const dSig = (holder.desc ? holder.sig : holder.retrySig) ?? 'v1';
    const same = !!(d && desc && d.mode === desc.mode && d.appUid === desc.appUid
      && d.handle === desc.handle && d.key === desc.key && d.shard === desc.shard) && dSig === sig;
    // A pending wait is cancelled only by a genuinely different descriptor:
    // the same one arriving again, as a routine bootstrap refresh does every
    // few seconds, must not restart the retry ladder from its first rung.
    // Judged on retryUntil rather than the timer alone, so the same rule
    // survives a hidden tab's teardown too: the timer is gone with it, but
    // the wait it was counting down is still owed before trying again.
    if (same && holder.retryUntil > Date.now()) {
      if (!holder.retryTimer) this._evArmRetry(holder, wsId, holder.retryUntil - Date.now());
      return;
    }
    if (same && holder.state !== 'off') return;
    this._evTeardown(holder);
    holder.retryUntil = 0;
    holder.retryDesc = null;
    if (!desc || typeof puter === 'undefined' || typeof puter?.events?.onLocal !== 'function') return;
    // The owner subscribes directly to their own namespace; refused unless
    // the app running this tab is really the one the bootstrap named, since
    // subscribing as any other app would read as an unrelated subject.
    if (desc.mode === 'own' && this.appUid() !== desc.appUid) return;
    if (sig !== 'v1') return this._ringArm(holder, wsId, desc, sig);
    const subject = desc.mode === 'own' ? `kv:${desc.appUid}:${desc.key}` : `kv:${desc.handle}:s${desc.shard}`;
    // Ask for the shard's value with the delivery (Events' `includeValue`):
    // a shard holds nothing but the moment it was written, and a moment this
    // tab's last completed poll already covers is a wakeup with nothing
    // behind it, which _onEvSignal can then drop instead of spending a poll
    // on it. Asked for in both modes: a share handle used to refuse values
    // outright, on the reasoning that the grant is to watch a region rather
    // than read it, so this was the owner's alone; the platform now delivers
    // them through a handle as well, the revoke check that stops a dead
    // handle's deliveries stopping its values with it. A region where that
    // has not landed yet refuses with `events_kv_handle_no_values`, which
    // stands the tab down for good and resubscribes at once without them
    // (see _onEvFailure) — the subscription is what matters, and the value
    // only ever saved a poll.
    const wantValue = !this._evNoValues;
    holder.desc = desc;
    holder.sig = 'v1';
    holder.state = 'arming';
    const epoch = holder.epoch;
    Promise.resolve()
      .then(() => puter.events.onLocal(subject, ({ event } = {}) => {
        if (holder.epoch !== epoch) return;
        this._onEvSignal(holder, wsId, event);
      }, { ...(wantValue ? { includeValue: true } : {}), onError: (err) => {
        if (holder.epoch !== epoch) return;
        this._onEvFailure(holder, wsId, desc, err);
      } }))
      .then((sub) => {
        if (holder.epoch !== epoch) {
          try { sub?.off?.(); } catch { /* best effort */ }
          return;
        }
        // A resolved nothing is not a subscription: left as 'on' regardless,
        // the holder would look healthy for good, on an SDK that never
        // actually delivers anything — never torn down, never retried, the
        // tab stuck on the slow cadence forever.
        if (!sub) return this._onEvFailure(holder, wsId, desc, null);
        holder.sub = sub;
        holder.state = 'on';
        holder.retryIdx = 0;
        holder.retryUntil = 0;
        holder.retryDesc = null;
        // A handle that works now and dies later is a fresh problem, worth its own one ask (see _onEvFailure).
        holder.reminted = null;
      })
      .catch((err) => {
        if (holder.epoch !== epoch) return;
        this._onEvFailure(holder, wsId, desc, err);
      });
  }

  /** Best-effort teardown: bump the epoch first, so a subscribe or a retry already in flight for this holder lands as a no-op. */
  _evTeardown(holder) {
    holder.epoch = (holder.epoch || 0) + 1;
    clearTimeout(holder.retryTimer);
    holder.retryTimer = null;
    const sub = holder.sub;
    holder.sub = null;
    holder.state = 'off';
    holder.desc = null;
    if (sub && typeof sub.off === 'function') {
      try { sub.off(); } catch { /* the socket may already be gone */ }
    }
    // The ring shard's subscription, and the entries waiting on one that
    // will now never come: the poll after the next subscribe fills it.
    const rsub = holder.rsub;
    holder.rsub = null;
    if (rsub) this._ringDrop(rsub);
    clearTimeout(holder.graceTimer);
    holder.graceTimer = null;
    holder.pending?.clear();
  }

  /**
   * A subscribe or a delivered onError: back off, then try the same
   * descriptor again. `err` is whatever the SDK rejected or onError'd with —
   * a PuterJSError carrying `.code` when it is the SDK's own refusal. A code
   * in EV_TERMINAL_CODES means the platform surface itself is unavailable
   * here (not this holder's problem to retry its way out of), so it gets one
   * long, terminal wait instead of climbing the short advancing ladder. A
   * refused handshake arrives as EV_AMBIGUOUS_CODE, which a dropped
   * connection uses too: it earns the same long wait only once the ladder has
   * been walked to its end without a single success, so a passing blip keeps
   * the short retries and a region with the feature off stops asking. The
   * wait outlives the subscription itself (see _evArmRetry): a hidden tab's
   * teardown does not forgive it, so hiding a tab for a minute and showing it
   * again does not hand a region where the feature is off a fresh failing
   * subscribe on every hide/show cycle.
   *
   * A dead subject (EV_STALE_HANDLE_CODE) is neither of the above: not a
   * retry the ladder can ever win, since the handle behind it is gone for
   * good, but one the worker itself can fix by minting a fresh one. The
   * first refusal of a given handle buys exactly one ask for a replacement
   * (see _evRemint), with the ladder's own first rung armed alongside it as
   * the fallback for whenever that ask fails, is refused by the worker's own
   * budget, or simply takes a while. A second refusal of the *same* handle
   * means the ask already came up empty, so it takes the long terminal wait
   * instead of climbing the ladder against a subject that will never exist
   * again. `own` mode has no handle to replace at all, so it is left on the
   * ordinary ladder untouched by any of this.
   */
  _onEvFailure(holder, wsId, desc, err) {
    holder.sub = null;
    holder.state = 'off';
    const code = err?.code;
    // A platform that will not deliver values on this subject after all:
    // stop asking for them, for good and for every holder, and subscribe
    // again at once rather than spend a rung of the ladder on it. The
    // subscription itself is what matters; the value only ever saved a poll.
    if (code === 'invalid_include_value' || code === 'events_kv_handle_no_values') {
      if (!this._evNoValues) {
        this._evNoValues = true;
        // Nothing owed: the refusal was this tab's own doing, not a wait the
        // ladder had already earned, so the same descriptor goes again now.
        holder.retryUntil = 0;
        holder.retryDesc = null;
        this._evApply(holder, wsId, desc);
        return;
      }
    }
    const exhausted = holder.retryIdx >= EV_RETRY_MS.length - 1;
    const stale = code === EV_STALE_HANDLE_CODE && desc?.mode === 'handle' && !!desc.handle;
    const remintable = stale && holder.reminted !== desc.handle;
    let ms;
    if (EV_TERMINAL_CODES.has(code) || (code === EV_AMBIGUOUS_CODE && exhausted) || (stale && !remintable)) {
      ms = EV_TERMINAL_BACKOFF_MS;
    } else {
      const idx = Math.min(holder.retryIdx, EV_RETRY_MS.length - 1);
      holder.retryIdx = Math.min(holder.retryIdx + 1, EV_RETRY_MS.length - 1);
      ms = EV_RETRY_MS[idx];
    }
    holder.retryDesc = desc;
    holder.retrySig = holder.sig ?? 'v1';
    holder.retryUntil = Date.now() + ms;
    this._evArmRetry(holder, wsId, ms);
    if (remintable) {
      holder.reminted = desc.handle;
      this._evRemint(holder, wsId, desc).catch(() => {});
    }
  }

  /**
   * The one ask a dead handle gets (see _onEvFailure): asks this holder's
   * own host — the workspace's worker for `this.ev`, a shared channel's own
   * host for a link's holder (see _evHostOf) — to revoke the dead handle and
   * mint a fresh one, for the caller alone. A block that actually changed
   * cancels the wait _onEvFailure armed, since _evApply treats a changed
   * descriptor as reason enough to tear down and subscribe right now rather
   * than wait it out. The same handle coming back — a worker whose own clear
   * did not take — is not new, and is left standing on its wait rather than
   * resubscribed to at once against a subject already known to be gone.
   * Every failure here is silent, exactly like a plain mint failure: the
   * wait already armed stands, and the tab polls exactly as it did before
   * this existed.
   */
  async _evRemint(holder, wsId, desc) {
    const host = this._evHostOf(holder);
    if (!host?.ref) return;
    let block = null;
    try {
      block = (await api.remintEvents(host.ref))?.events || null;
    } catch {
      return; // the wait _onEvFailure armed stands, and the tab polls exactly as it did
    }
    // Checked only after the await: a workspace switch during the round trip
    // must not re-arm a holder that has since been torn down.
    if (!block || this.wsId !== wsId || !this._evHolderLive(holder, wsId)) return;
    if (block.mode === 'handle' && block.handle === desc.handle) return;
    if (host.link) this._evSetLink(host.link, wsId, block);
    else this._evSetOwn(wsId, block);
  }

  /**
   * The one timer a holder waits on, whether the wait is a backoff after a
   * failure or a degrade's five minutes: armed for what is left of it, and
   * applying whatever the last bootstrap said rather than what failed, since
   * a hidden tab goes on taking bootstraps while it waits.
   */
  _evArmRetry(holder, wsId, ms) {
    clearTimeout(holder.retryTimer);
    holder.retryTimer = setTimeout(() => {
      holder.retryTimer = null;
      if (!this._evHolderLive(holder, wsId)) return;
      holder.retryUntil = 0;
      holder.desc = null; // forces _evApply past its "nothing changed" guard
      this._evApply(holder, wsId, holder.lastDesc);
    }, ms);
  }

  /**
   * Which host a holder watches: the workspace itself, or one shared
   * channel's host, each of which mints its own handle. Null once it is
   * neither (a workspace switched away from, a link since dropped) — the
   * shape _evRemint needs to ask the right host for a fresh handle, beyond
   * the plain yes/no _evHolderLive answers.
   */
  _evHostOf(holder) {
    if (holder === this.ev) return { ref: this.wsId, link: null };
    for (const link of this.links.values()) if (link.ev === holder) return { ref: link.ref, link };
    return null;
  }

  /** Is `holder` still the live subscription of the open workspace, or of one of its current links? A stale timer for a workspace switched away from, or a link since dropped, does nothing. */
  _evHolderLive(holder, wsId) {
    return this.wsId === wsId && !!this._evHostOf(holder);
  }

  /* ---- ring entries -------------------------------------------------------- */

  /**
   * A host that writes ring entries (worker/signal.js) sends their keys in
   * the bootstrap's `ring` block. With them the tab watches `r{rs}:*` and
   * `o{rs}` instead of `s{n}`, and applies each change from its entry. The
   * ping still polls, for what entries do not carry.
   *
   * Entries are numbered per shard; a missing number (a dropped delivery, a
   * value Events left out, a gap marker) is filled by a poll, whose `rn`
   * says where numbering stands. Every entry is idempotent.
   */

  /** Which subscription `desc` calls for on this holder: 'v1' (the plain shard) or a v2 signature naming the ring shard. */
  _ringSig(holder, desc) {
    const ring = holder.ring;
    if (!desc || !ring || this._evNoValues || holder.noRingUntil > Date.now() || !Number.isInteger(ring.rs)) return 'v1';
    if (desc.mode === 'own') return ring.okey && ring.rkey ? `v2|${ring.rs}|${ring.okey}|${ring.rkey}` : 'v1';
    return desc.mode === 'handle' && desc.handle ? `v2|${ring.rs}` : 'v1';
  }

  _ringDrop(sub) {
    try { sub?.off?.(); } catch { /* the socket may already be gone */ }
  }

  /**
   * Watch the ring shard and its ping together, in _evApply's place once the
   * holder has keys. A ping alone would miss every change entries carry, so
   * a ring shard refused on its own drops back to `s{n}` for RING_REFUSED_MS.
   * A poll follows each subscribe, for what changed before it.
   */
  _ringArm(holder, wsId, desc, sig) {
    const ring = holder.ring;
    const ping = desc.mode === 'own' ? `kv:${desc.appUid}:${ring.okey}` : `kv:${desc.handle}:o${ring.rs}`;
    const shard = desc.mode === 'own' ? `kv:${desc.appUid}:${ring.rkey}*` : `kv:${desc.handle}:r${ring.rs}:*`;
    holder.desc = desc;
    holder.sig = sig;
    holder.state = 'arming';
    const epoch = holder.epoch;
    const live = () => holder.epoch === epoch;
    // The two end together on a dropped connection; the first to say so is
    // the one failure the backoff counts.
    const ending = () => !live() || holder.state !== 'on';
    Promise.resolve()
      .then(() => Promise.allSettled([
        puter.events.onLocal(ping, ({ event } = {}) => {
          if (live()) this._onEvSignal(holder, wsId, event);
        }, { includeValue: true, onError: (err) => {
          if (ending()) return;
          this._ringDrop(holder.rsub);
          holder.rsub = null;
          this._onEvFailure(holder, wsId, desc, err);
        } }),
        puter.events.onLocal(shard, ({ event } = {}) => {
          if (live()) this._onRingEvent(holder, wsId, event);
        }, { includeValue: true, onError: (err) => {
          if (ending()) return;
          this._ringDrop(holder.sub);
          holder.sub = null;
          holder.rsub = null;
          this._onEvFailure(holder, wsId, desc, err);
        } }),
      ]))
      .then(([p, r]) => {
        const pingSub = p.status === 'fulfilled' ? p.value : null;
        const ringSub = r.status === 'fulfilled' ? r.value : null;
        if (!live()) {
          this._ringDrop(pingSub);
          this._ringDrop(ringSub);
          return;
        }
        if (!pingSub) {
          this._ringDrop(ringSub);
          return this._onEvFailure(holder, wsId, desc, p.status === 'rejected' ? p.reason : null);
        }
        if (!ringSub) {
          this._ringDrop(pingSub);
          holder.noRingUntil = Date.now() + RING_REFUSED_MS;
          holder.desc = null;
          holder.state = 'off';
          return this._evApply(holder, wsId, desc);
        }
        holder.sub = pingSub;
        holder.rsub = ringSub;
        holder.state = 'on';
        holder.retryIdx = 0;
        holder.retryUntil = 0;
        holder.retryDesc = null;
        holder.reminted = null;
        this._onEvSignal(holder, wsId, null);
      })
      .catch((err) => {
        if (live()) this._onEvFailure(holder, wsId, desc, err);
      });
  }

  /**
   * Take a host's `ring` block: undefined keeps the keys (the re-mint's
   * answer), null drops them (an older host). Changed keys are followed by a
   * poll, for whatever was said under keys this tab did not have yet.
   */
  _ringSet(holder, wsId, ring) {
    if (ring === undefined) return;
    if (!ring || typeof ring !== 'object' || !ring.ek || typeof ring.ek !== 'object' || !Number.isInteger(ring.rs)) {
      holder.ring = null;
      return;
    }
    const prev = holder.ring;
    const ek = { ...ring.ek };
    const ke = Number(ring.ke) || 0;
    const okey = ring.okey || null;
    const rkey = ring.rkey || null;
    const same = prev && prev.ke === ke && prev.rs === ring.rs && prev.okey === okey && prev.rkey === rkey
      && Object.keys(ek).length === Object.keys(prev.ek).length && Object.entries(ek).every(([c, k]) => prev.ek[c] === k);
    if (!same) {
      // The keys replaced stay readable a while: a write already under way
      // when they changed is sealed with them (see _ringProcess).
      const old = prev ? { ek: prev.ek, tags: prev.tags, until: Date.now() + RING_OLD_KEYS_MS } : null;
      const scope = { ek, ke, rs: ring.rs, okey, rkey, tags: new Map(), old };
      scope.ready = Promise.all(Object.entries(ek).map(([conv, root]) => ringKeysFrom(root).then(({ tag }) => { scope.tags.set(tag, conv); }, () => {})));
      holder.ring = scope;
      if (prev) scope.ready.then(() => { if (holder.ring === scope && this._evHolderLive(holder, wsId)) this._onEvSignal(holder, wsId, null); });
    }
    // Where numbering starts, and no more: a document re-read does not bring
    // the windows' changes a poll's answer does (see _ringBaseline), so only
    // a poll may move it on past entries still waiting.
    if (holder.lastN == null) this._ringBaseline(holder, wsId, ring.rn);
  }

  /**
   * Where numbering stands as of a poll (`rn`): every entry up to it is in
   * what that answer brought, whose window updates fetch what those entries
   * would have laid in, so waiting for any of them is over.
   */
  _ringBaseline(holder, wsId, rn) {
    if (!holder || !Number.isInteger(rn) || rn < 0) return;
    if (holder.lastN != null && rn <= holder.lastN) return;
    holder.lastN = rn;
    if (!holder.pending) holder.pending = new Map();
    // Their stamps still count: the counter and the activity document are
    // read in one batch, not one instant, so the answer may predate one.
    for (const n of [...holder.pending.keys()].sort((x, y) => x - y)) {
      if (n > rn) continue;
      this._ringQueue(holder, wsId, holder.pending.get(n), 'late');
      holder.pending.delete(n);
    }
    this._ringDrain(holder, wsId);
  }

  _onRingEvent(holder, wsId, event = null) {
    holder.misses = 0;
    holder.signalled = true;
    if (this.wsId !== wsId) return;
    const v = event?.value;
    // A gap marker, or a value Events left out (too large, too many
    // watchers): something changed that this entry does not say. A poll.
    if (!event || event.op === 'gap' || !v || typeof v !== 'object' || !Number.isInteger(v.n) || typeof v.g !== 'string' || typeof v.d !== 'string') {
      this._onEvSignal(holder, wsId, null);
      return;
    }
    if (!holder.pending) holder.pending = new Map();
    if (holder.lastN != null && v.n <= holder.lastN) {
      // Behind the count: applied already, or passed over by a poll's
      // answer, which may not have carried it (see _ringBaseline).
      if (!holder.applied?.has(v.n)) this._ringQueue(holder, wsId, v, 'late');
      return;
    }
    // Sealed under a newer key epoch than this tab holds: someone lost
    // access and every key was replaced. The document brings the new ones.
    if (holder.ring && Number(v.e) > holder.ring.ke) this._ringStale(holder, wsId);
    holder.pending.set(v.n, v);
    this._ringDrain(holder, wsId);
  }

  /** Apply what follows on from the last entry applied; wait a moment for a missing one, then let a poll fill it. */
  _ringDrain(holder, wsId) {
    // With no count yet to follow on from, the wait below stands until a poll's answer gives one.
    while (holder.lastN != null && holder.pending.has(holder.lastN + 1)) {
      const v = holder.pending.get(holder.lastN + 1);
      holder.pending.delete(holder.lastN + 1);
      holder.lastN += 1;
      this._ringQueue(holder, wsId, v, 'next');
    }
    if (!holder.pending.size) {
      clearTimeout(holder.graceTimer);
      holder.graceTimer = null;
      return;
    }
    if (holder.graceTimer) return;
    holder.graceTimer = setTimeout(() => {
      holder.graceTimer = null;
      if (!this._evHolderLive(holder, wsId) || !holder.pending.size) return;
      const ns = [...holder.pending.keys()].sort((a, b) => a - b);
      for (const n of ns) this._ringQueue(holder, wsId, holder.pending.get(n), 'gapped');
      holder.pending.clear();
      holder.lastN = Math.max(holder.lastN ?? 0, ns[ns.length - 1]);
      this._onEvSignal(holder, wsId, null);
    }, RING_GRACE_MS);
  }

  /**
   * Entries are opened one at a time, in the order they are applied. `mode`:
   * 'next' follows on from the last applied; 'gapped' comes after a missing
   * one, so it does not vouch for a window; 'late' arrives behind entries
   * already applied, so only its stamps count (its patch could undo a newer
   * one, a reaction taken off, say), and a window behind them is re-read.
   */
  _ringQueue(holder, wsId, v, mode) {
    if (!holder.applied) holder.applied = new Set();
    holder.applied.add(v.n);
    if (holder.applied.size > 256) holder.applied.delete(holder.applied.values().next().value);
    holder.chain = (holder.chain || Promise.resolve()).then(() => this._ringProcess(holder, wsId, v, mode)).catch(() => {});
  }

  /** Keys out of date: the host's document again, which carries the current ones (at most every RING_STALE_MS). */
  _ringStale(holder, wsId) {
    if (Date.now() - holder.staleAt < RING_STALE_MS) return;
    holder.staleAt = Date.now();
    const host = this._evHostOf(holder);
    if (!host || this.wsId !== wsId) return;
    if (host.link) this._refreshLink(host.link).catch(() => {});
    else this.refreshWorkspace().catch(() => {});
  }

  async _ringProcess(holder, wsId, v, mode) {
    const scope = holder.ring;
    if (!scope) return;
    await scope.ready;
    if (!this._evHolderLive(holder, wsId)) return;
    const parsed = parseTag(v.g);
    let base = parsed ? scope.tags.get(parsed.tag) : null;
    let root = base ? scope.ek[base] : null;
    if (!base && parsed && scope.old && scope.old.until > Date.now()) {
      base = scope.old.tags.get(parsed.tag) || null;
      root = base ? scope.old.ek[base] : null;
    }
    if (!base) {
      // Sealed under an epoch this tab has moved past and holds no key for:
      // possibly one of its own, so a poll. Otherwise another member's.
      if (Number(v.e) < scope.ke) this._onEvSignal(holder, wsId, null);
      return;
    }
    const hostConv = parsed.seq ? threadConvId(base, parsed.seq) : base;
    const { aes } = await ringKeysFrom(root);
    const body = await openEntry(aes, v.g, v.d);
    if (!this._evHolderLive(holder, wsId)) return;
    if (!body || typeof body !== 'object') {
      // A tag this tab knows that does not open: its key changed under it.
      this._ringStale(holder, wsId);
      this._onEvSignal(holder, wsId, null);
      return;
    }
    const host = this._evHostOf(holder);
    const link = host?.link || null;
    const conv = link ? this._localOf(link, hostConv) : hostConv;
    if (!conv) return;
    this._ringApply(holder, conv, hostConv, link, body, mode);
  }

  /**
   * One opened entry: the window first, then the stamps, so the window
   * updates they trigger find nothing left to fetch. A window that could not
   * take it (a seq gap, a patch it cannot vouch for) is fetched as on a poll.
   */
  _ringApply(holder, conv, hostConv, link, body, mode) {
    let activityChanged = false;
    const late = mode === 'late';
    if (!late && body.ty && typeof body.ty === 'object') {
      if (this._ringTyping(conv, body.ty)) activityChanged = true;
    }
    const a = body.a && typeof body.a === 'object' ? body.a : null;
    const c = late ? null : this.convs.get(conv);
    const prevX = this.act.c[conv]?.x || 0;
    if (!late && a && Number.isInteger(a.s) && body.m && typeof body.m === 'object') {
      if (c?.loaded && !c.hasNewer && !this._dropped(conv, c)) {
        const known = c.messages.reduce((n, m) => (m.seq > n ? m.seq : n), c.seq || 0);
        const [msg] = mergeBlock({ m: [{ ...body.m, s: a.s }], x: {} });
        if (msg && a.s === known + 1) {
          c.messages = mergeMessages(c.messages, [msg]);
          c.seq = Math.max(c.seq || 0, a.s);
          this.emit('messages', { conv, reason: 'newer', added: [msg] });
        }
      }
      // They sent it, so they are not typing it any more.
      if (typeof body.m.u === 'string' && this._ringTyping(conv, { u: body.m.u, at: 0 })) activityChanged = true;
    }
    if (body.p && typeof body.p === 'object' && Number.isInteger(body.s) && c?.loaded && !this._dropped(conv, c)) {
      const i = c.messages.findIndex((m) => m.seq === body.s);
      if (i >= 0) {
        const next = applyOverlayPatch(c.messages[i], body.p);
        if (next !== c.messages[i]) {
          c.messages = next ? c.messages.map((m, j) => (j === i ? next : m)) : c.messages.filter((_, j) => j !== i);
          this.emit('messages', { conv, reason: 'range' });
        }
      }
      // The window was up to date before this change, and nothing came in
      // between (no entry missed, no ping a poll has not yet answered): it is
      // up to date after it too, with nothing to re-read.
      const vouched = mode === 'next' && !((holder.pingAt || 0) > (holder.syncedAt || 0));
      if (vouched && Number.isFinite(a?.x) && (c.xSeen || 0) >= prevX && !c.rangeTask) c.xSeen = Math.max(c.xSeen || 0, a.x);
    }
    const tasks = [];
    let newIn = [];
    if (a) {
      const translate = link ? (hc) => this._localOf(link, hc) : null;
      const folded = this._foldActivity({ [hostConv]: { ...(this.act.c[conv] || {}), ...a } }, translate);
      if (folded.changed) activityChanged = true;
      newIn = folded.newIn;
      for (const s of folded.skipped) tasks.push(this._fillSkipped(s.conv, s.seq).catch(() => {}));
      if (folded.reread) tasks.push((link ? this._refreshLink(link) : this.refreshWorkspace()).catch(() => {}));
      const w = this.convs.get(conv);
      if (w) this._queueWindowUpdate(conv, w, tasks);
    }
    if (activityChanged) this.emit('activity');
    if (newIn.length) this.emit('incoming', newIn);
  }

  /**
   * Someone started typing (`at`, the worker's time), or stopped (`at` 0).
   * The open conversation's typing then keeps itself fresh on the typing
   * poll, as when a poll first brought it.
   */
  _ringTyping(conv, ty) {
    if (typeof ty.u !== 'string' || ty.u === this.uuid) return false;
    const cur = this._typing.byConv[conv] || {};
    if (!ty.at) {
      if (!(ty.u in cur)) return false;
      const rest = { ...cur };
      delete rest[ty.u];
      const byConv = { ...this._typing.byConv };
      if (Object.keys(rest).length) byConv[conv] = rest;
      else delete byConv[conv];
      return this._setTyping(byConv);
    }
    // Only what is still fresh by the worker's clock stands beside it, as a
    // poll's answer would have it: the TTL restarts with every change.
    const fresh = this.serverNow() - TYPING_TTL_MS;
    const byConv = {};
    for (const [k, users] of Object.entries({ ...this._typing.byConv, [conv]: { ...cur, [ty.u]: ty.at } })) {
      const kept = Object.fromEntries(Object.entries(users || {}).filter(([, at]) => at >= fresh));
      if (Object.keys(kept).length) byConv[k] = kept;
    }
    const changed = this._setTyping(byConv);
    const open = this.openThread || this.openConv;
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (open === conv && !hidden && this._timer !== null && !this._polling && (this._timerAt || 0) - Date.now() > POLL_TYPING_MS) {
      this._schedule(POLL_TYPING_MS, this._pendingReason);
    }
    return changed;
  }

  /**
   * Whether a delivery names a change this tab has already seen. A shard's
   * document is `{ t }`, the moment the worker wrote it, and the worker
   * writes it only once every write the change consists of has landed. So a
   * delivery whose `t` is at or before the moment this tab's last completed
   * poll read (`_evSyncAt`, the worker's own clock as that poll reported it)
   * names a change that poll already carried, and polling again for it would
   * turn up nothing: a burst of posts in a busy channel lands a delivery
   * each, and the ones arriving just behind a poll are exactly this.
   *
   * Only for this workspace's own holder, and only where the value actually
   * rode along (see `includeValue` in _evApply): a linked workspace's shard
   * is written by *its* worker, whose clock `_evSyncAt` says nothing about,
   * and a delivery with no value — a gap marker, a value the platform left
   * out, a handle-mode subscription — says nothing either. Anything unclear
   * polls, exactly as before.
   */
  _evCovered(holder, event) {
    if (holder !== this.ev || !event || event.op === 'gap') return false;
    const t = Number(event.value?.t);
    return Number.isFinite(t) && t > 0 && t <= this._evSyncAt;
  }

  /**
   * Every delivery — including a gap marker, which by contract means
   * "something happened, re-read" — means the same thing: poll soon, unless
   * the delivery says outright that this tab has it already (see
   * _evCovered). Hidden tabs ignore it and keep their own cadence; a poll
   * already in flight is told to run again after the signal floor. Bursts
   * collapse into one poll. Every delivery counts as one for the degradation
   * detector, covered or not: it is proof the subscription is working.
   */
  _onEvSignal(holder, wsId, event = null) {
    holder.misses = 0;
    holder.signalled = true;
    if (this.wsId !== wsId) return;
    if (this._evCovered(holder, event)) return;
    // Something changed that no ring entry may have said: entries do not
    // vouch for a window's overlays until a poll begun after this lands (see _ringApply).
    holder.pingAt = Date.now();
    if (typeof document !== 'undefined' && document.hidden) return;
    // stopPolling() sets _timer to null; the epoch bump in _evTeardown
    // should already make a delivery arriving after it unreachable, but a
    // signal is exactly the kind of "just in case" surface worth a second,
    // cheap guard against restarting a poll loop that was just torn down.
    if (this._timer === null) return;
    if (this._polling) {
      this._evPending = true;
      return;
    }
    if (this._pendingReason === 'poke') return;
    this._schedule(Math.max(0, this._lastPollAt + SIGNAL_FLOOR_MS - Date.now()), 'signal');
  }

  /**
   * Three consecutive safety polls (not poked, not signal-driven) that turn
   * up a change of a kind the worker always signals mean the subscription is
   * live but not delivering: past a shard's fair share of watchers, a grant
   * revoked from the Puter GUI, a region where dispatch has gone quiet. Fall
   * back to plain polling for a while rather than trust a signal that keeps
   * not coming.
   */
  _evMiss(wsId, holder = this.ev) {
    holder.misses = (holder.misses || 0) + 1;
    if (holder.misses < EV_MISSES_TO_DEGRADE) return;
    holder.misses = 0;
    const desc = holder.lastDesc ?? holder.desc;
    this._evTeardown(holder);
    holder.degradedUntil = Date.now() + EV_DEGRADE_MS;
    this._evApply(holder, wsId, desc);
  }

  /** Each host is judged against its own last read and deliveries, including during a sync. */
  _evCheckSync(holder, data, syncAt, w, u, wasPoked) {
    if (!holder) return;
    const signalled = holder.signalled;
    holder.signalled = false;
    if (wasPoked || signalled || holder.state !== 'on') return;
    const changed = Object.values(data.c || {}).some((v) => Math.max(v?.t || 0, v?.x || 0) > syncAt);
    if (changed || (data.w || 0) > w || (data.u || 0) > u) this._evMiss(this.wsId, holder);
    else holder.misses = 0;
  }

  /**
   * Apply a fresh `events` block for the workspace itself, remembered so a
   * hidden tab's re-arm and a degrade's recovery know what to arm again, with
   * the bootstrap's `ring` block beside it (see _ringSet; undefined keeps the
   * keys the holder has).
   */
  _evSetOwn(wsId, desc, ring = undefined) {
    this._ringSet(this.ev, wsId, ring);
    this._evApply(this.ev, wsId, desc);
  }

  /** Apply a fresh `events` block for one shared channel's host. A link's `ev` is normally set when _syncLinks first makes it, but is created here too, lazily, for a link an older path (or a test) built without one. */
  _evSetLink(link, wsId, desc, ring = undefined) {
    if (!link.ev) link.ev = evHolder();
    this._ringSet(link.ev, wsId, ring);
    this._evApply(link.ev, wsId, desc);
  }

  /**
   * The fast cadence is used only when the workspace's own subscription is
   * healthy *and* every current link is loaded with a healthy one of its
   * own: a link that is loading, erroring, or on a host too old to carry an
   * `events` block keeps the whole tab on the classic cadence, which is the
   * safe direction and also preserves the link retry granularity a longer
   * tick would otherwise stretch.
   */
  _evFast() {
    if (this.ev.state !== 'on') return false;
    for (const link of this.links.values()) {
      if (!link.loaded || link.loading) return false;
      if (!link.ev || link.ev.state !== 'on') return false;
    }
    return true;
  }

  /**
   * A tab hidden for HIDDEN_UNSUB_MS drops every subscription it holds: a
   * delivery a hidden tab ignores is one the member's own account still paid
   * for. Coming back into view applies whatever the last bootstrap said, not
   * only what was torn down: a bootstrap that landed during a hide too short
   * to tear anything down (any ordinary alt-tab) could rotate the handle,
   * move the shard, or withdraw the block altogether, and re-arming only a
   * torn-down holder left the tab subscribed to a subject that was gone,
   * reported healthy, on the slow cadence, receiving nothing until the
   * degradation detector noticed three misses later. _evApply no-ops on an
   * unchanged live descriptor and tears down on a null one, so the
   * unconditional call costs nothing when nothing changed.
   */
  _evOnVisibility() {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      clearTimeout(this._evHiddenTimer);
      this._evHiddenTimer = setTimeout(() => {
        this._evTeardown(this.ev);
        for (const link of this.links.values()) if (link.ev) this._evTeardown(link.ev);
      }, HIDDEN_UNSUB_MS);
      return;
    }
    clearTimeout(this._evHiddenTimer);
    this._evHiddenTimer = null;
    if (!this.wsId) return;
    this._evApply(this.ev, this.wsId, this.ev.lastDesc);
    for (const link of this.links.values()) if (link.ev) this._evApply(link.ev, this.wsId, link.ev.lastDesc);
  }

  /* ---- sync loop -------------------------------------------------------- */

  startPolling() {
    this._resetBackoff(); // a fresh loop (a workspace opened) starts on the plain cadence, whatever the last one met
    this._schedule(POLL_VISIBLE_MS);
  }

  /**
   * The poll's failures in a row are over, as far as the wait between polls
   * goes (see POLL_BACKOFF_MAX_MS): a poll got through, the connection is
   * back, the tab is back in view, or the member acted, which must poll at
   * once. With `now`, the next poll goes now (or straight after the one in
   * flight); only while the loop runs, since one stopped for good (the
   * workspace lost, see poll) is not started again by this.
   */
  _resetBackoff(now = false) {
    this._pollFailures = 0;
    this._pollFailKind = null;
    if (!now || !this.wsId || this._timer === null) return;
    if (this._polling) this._poked = true;
    else this._schedule(50, 'poke');
  }

  /**
   * A poll failed, and with what: one more failure of the kind the last one
   * was (a server that is down answers the same way each time: the network
   * failing, a gateway's page, its own error), or the first of a new kind.
   * The wait between polls grows with the count (see poll). Not a 401: the
   * worker answers it whenever Puter cannot confirm the sign-in, a moment's
   * failure at Puter as often as a sign-in that has lapsed (see isRefusal),
   * and the polls go through again on their next try; the app says so of
   * its own (see shell.js), and a poll held back would only delay the recovery.
   */
  _noteFailure(e) {
    if (e instanceof ApiError && e.status === 401) {
      this._resetBackoff();
      return;
    }
    const kind = !(e instanceof ApiError) ? 'fault' : isPlatformPage(e) ? 'platform' : e.status ? `http_${e.status}` : e.code;
    this._pollFailures = kind === this._pollFailKind ? this._pollFailures + 1 : 1;
    this._pollFailKind = kind;
  }

  stopPolling() {
    clearTimeout(this._timer);
    this._timer = null;
    this._evPending = false;
    this._evTeardown(this.ev);
    for (const link of this.links.values()) if (link.ev) this._evTeardown(link.ev);
  }

  /** `reason` marks why the next poll was asked for ('poke' or 'signal' aside from the plain 'cadence'), which the degradation detector uses to tell a woken poll from a plain safety one (see poll()). */
  _schedule(ms, reason = 'cadence') {
    clearTimeout(this._timer);
    this._pendingReason = reason;
    this._timerAt = Date.now() + ms;
    this._timer = setTimeout(() => this.poll(), ms);
  }

  /**
   * Does this tab stand for the person being here? In view and touched
   * within the last ten minutes, that is (or in a huddle: a call is company
   * enough); a tab in the background, or one left open on a second screen,
   * sends no heartbeat, and its person lapses to away, which also spares the
   * write every half minute for nobody. Not a tab in a huddle, though: the
   * call goes on while its tab is put away (another tab for the notes, the
   * document being talked over), and the person is on it, talking, as
   * present as anyone; lapsing with the tab, as it used to, they showed
   * "away" to the very people they were on the call with, a minute and a
   * half after switching tabs.
   */
  _present() {
    if (typeof document !== 'undefined' && document.hidden) return !!this.huddle;
    return !!this.huddle || Date.now() - this._lastInput < IDLE_MS;
  }

  /** What a heartbeat says beside the timestamp: 'dnd' while notifications are paused, else nothing. */
  _presenceFlag() {
    return this.notificationsPaused() ? 'dnd' : null;
  }

  /** A heartbeat went out for `wsId` saying `flag`: remembered, and told to the other tabs of this account. */
  _beat(wsId, flag = null) {
    this._lastHeartbeat = Date.now();
    this._lastFlag = flag;
    try {
      this._presenceChannel?.postMessage({ uuid: this.uuid, ws: wsId, at: this._lastHeartbeat });
    } catch {
      /* the channel is a courtesy between tabs */
    }
  }

  /**
   * The page is going (pagehide): if this tab is what keeps the person
   * active here, say so, so the others see them away in seconds rather than
   * when the heartbeat lapses. Nothing is said when this tab has not been
   * heard from within the active window (it is not what keeps anyone
   * active), nor when another tab of this account has heartbeated for this
   * workspace lately (it still does). Sent keepalive, or the browser would
   * drop the request with the page. The heartbeat clock is cleared: a page
   * brought back from the cache, or the next one to open here, is present
   * again with its first request.
   */
  _sayBye() {
    const wsId = this.wsId;
    if (!wsId || !this._lastHeartbeat || Date.now() - this._lastHeartbeat > ACTIVE_WINDOW_MS) return;
    this._lastHeartbeat = 0;
    const sibling = this._siblingBeats.get(wsId) || 0;
    if (Date.now() - sibling < HEARTBEAT_MS + POLL_VISIBLE_MS * 2) return;
    api.presenceBye(wsId, { keepalive: true }).catch(() => {});
    for (const l of this._liveLinks()) api.presenceBye(l.ref, { keepalive: true }).catch(() => {});
  }

  /**
   * How long until the workspace's next scheduled message or reminder is due,
   * for a poll aimed at it rather than one that stumbles on it. A due time is
   * the one change nothing signals — the moment simply arrives — so at a
   * minute's cadence a message set for nine o'clock could go out a minute
   * late. `fallback` is returned when nothing is pending, so the caller's own
   * cadence stands. A little leeway past the moment itself, since the worker
   * delivers on the first poll at or after it.
   */
  _dueIn(fallback) {
    if (!this._dueAt) return fallback;
    return Math.max(SIGNAL_FLOOR_MS, this._dueAt - Date.now() + 250);
  }

  /** Force a poll now (after the user acts). */
  pokeSync() {
    if (!this.wsId) return;
    this._resetBackoff(); // the member acted: this poll now, and the ones after it on the plain cadence
    // A poll in flight read its state before whatever prompted this; it is
    // not the one to settle the next wait, so the wish is kept for its end.
    if (this._polling) this._poked = true;
    else this._schedule(50, 'poke');
  }

  async poll() {
    if (!this.wsId) return;
    if (this._polling) {
      // A poll is still in flight, for this workspace or the one open before
      // it. Its own rescheduling only covers the workspace it was started
      // for, so this turn is tried again shortly rather than dropped: a
      // switch made while the old poll ran would otherwise leave the new
      // workspace without a sync loop until the tab was hidden and shown.
      this._schedule(POLL_RETRY_MS, this._pendingReason);
      return;
    }
    this._polling = true;
    this._poked = false;
    this._evPending = false;
    // Capture user wakeups before resetting the scheduler. Event deliveries
    // are tracked per host so a healthy host cannot mask a silent one.
    const wasPoked = this._pendingReason === 'poke';
    this._pendingReason = 'cadence';
    this._lastPollAt = Date.now();
    const startedAt = this._lastPollAt;
    const wsId = this.wsId;
    // The clocks changed (or the device travelled) since the workers were
    // told this device's offset from UTC: they keep quiet hours by it, and
    // cannot know the zone, so they are told again, once, as the settings
    // are (see pwa.js pushOffsetMoved).
    if (pushOffsetMoved() && !this._tzResend) this._tzResend = this.syncPushPrefs().catch(() => {}).finally(() => { this._tzResend = null; });
    try {
      // A heartbeat every HEARTBEAT_MS while the tab stands for the person,
      // and one at once when what it would say has changed: notifications
      // paused or resumed, by hand or by the clock, reach the others' dots
      // with this poll rather than up to half a minute on.
      const flag = this._presenceFlag();
      const heartbeat = this._present() && (Date.now() - this._lastHeartbeat > HEARTBEAT_MS || flag !== this._lastFlag);
      const state = heartbeat ? flag : null;
      // The hosts of shared channels are polled alongside, each its own
      // small read, but not waited for: a host slow to answer (or hanging
      // until the request times out) would otherwise hold back this
      // workspace's own updates and the next poll. One sync in flight per
      // host; what it says is folded in when it arrives, and one that fails
      // leaves the others alone. A host that could not be reached is tried
      // again once its wait is up.
      for (const l of this.links.values()) {
        if (!l.loaded && !l.loading && l.error && !l.lost && Date.now() >= l.retryAt) this._loadLink(l).catch(() => {});
        else if (l.loaded && !l.loading) this._renewLink(l);
      }
      for (const l of this._liveLinks()) {
        if (l.syncing) continue;
        l.syncing = api.sync(l.ref, l.since, heartbeat, state)
          .then((d) => ({ link: l, data: d, startedAt }), (error) => ({ link: l, error }))
          .then((r) => {
            l.syncing = null;
            return this.wsId === wsId && this.links.get(l.ref) === l ? this._applyLinked([r], wasPoked) : undefined;
          })
          .catch(() => {});
      }
      // Read before the sync answer is folded in, which is what the
      // degradation detector below compares against: what this device
      // already knew, not what this very poll just brought it to.
      const prevW = this.act.w;
      const prevU = this.act.u;
      const data = await api.sync(wsId, this.since, heartbeat, state);
      if (this.wsId !== wsId) return;
      this._resetBackoff(); // a poll got through: whatever failures came before it are over (see POLL_BACKOFF_MAX_MS)
      if (heartbeat) this._beat(wsId, state);
      this._resendReads(); // a request got through: the reads the worker did not take are tried again
      if (this.offline || [...this.convs.values()].some((c) => c.stale)) await this.refreshStale();
      if (this.wsId !== wsId) return; // switched while stale windows reloaded
      this._evCheckSync(this.ev, data, this._evSyncAt, prevW, prevU, wasPoked);
      this._ringBaseline(this.ev, wsId, data.rn);
      await this._applySync(data);
      this.ev.syncedAt = Math.max(this.ev.syncedAt || 0, startedAt);
      // A queued row on screen: the device's store is looked at, for an
      // entry another tab has taken out meanwhile (see _syncQueued). One
      // read of the store per poll, and only while such a row shows.
      // Not gated on `_hasQueued`: this scan is for the placeholder whose
      // entry has *gone* from the device's store (discarded or sent from
      // another tab), which is exactly when that flag is false.
      if ([...this.convs.values()].some((c) => c.messages.some((m) => m.queued))) await this._syncQueued();
      if (this._hasQueued) this.outbox.flush().catch(() => {});
    } catch (e) {
      // Asked for a workspace the reader has since left for another: its
      // failure is no more this workspace's than its answer would have been
      // (dropped above). Read as the open workspace's, a "not a member" from
      // the one left behind dropped the new one from the list with a word
      // about lost access and stopped the polling, which the new workspace's
      // own loop was waiting its turn behind (see the _polling check), so it
      // went silent; a network failure of it showed the new one out of
      // reach. The finally below lets the waiting loop take its turn.
      if (this.wsId !== wsId) return;
      // Removed from the workspace, or it was deleted: the worker said so in
      // its own words. A bare 404 with no body is the address not answering
      // (a worker being redeployed, or gone), which the boot path treats as
      // unreachable rather than as lost access, and the next poll retries;
      // so is a page the platform answered with in the worker's place, a
      // firewall's 403 among them (see isPlatformPage).
      if (e instanceof ApiError && (e.status === 403 || e.status === 404) && e.code !== 'no_backend' && !isPlatformPage(e)) {
        this.emit('error', e);
        this.stopPolling();
        this._polling = false;
        return;
      }
      this.emit('error', e);
      this._noteFailure(e);
      // With the worker out of reach nothing arrives, but time still passes:
      // the dots lapse to away like anywhere else.
      if (this._presenceMoved()) this.emit('activity');
    } finally {
      this._polling = false;
      if (this.wsId === wsId && this._timer !== null) {
        const hidden = typeof document !== 'undefined' && document.hidden;
        const watching = !hidden && (this.openThread || this.openConv) && this.typingIn(this.openThread || this.openConv).length > 0;
        // The safety floor replaces the plain visible cadence only once
        // events are fully healthy (see _evFast): a subscription this tab
        // holds and, for every shared channel it has open, one its host
        // holds too. Below that this stays exactly today's cadence.
        const base = hidden ? POLL_HIDDEN_MS : watching ? POLL_TYPING_MS : this._evFast() ? POLL_SAFETY_MS : POLL_VISIBLE_MS;
        // Failed, and failed before the same way: the wait grows (see
        // POLL_BACKOFF_MAX_MS), a hidden tab keeping its half minute. A poke
        // or a signal still goes first, and a queued message waits with the
        // rest: the flush it wants comes with a poll that gets through, which
        // asking sooner does not bring.
        const backoff = this._pollFailures ? Math.min(POLL_BACKOFF_MAX_MS, POLL_VISIBLE_MS * 2 ** (this._pollFailures - 1)) : 0;
        if (this._poked) this._schedule(50, 'poke');
        else if (!hidden && this._evPending) this._schedule(Math.max(0, this._lastPollAt + SIGNAL_FLOOR_MS - Date.now()), 'signal');
        else if (backoff) this._schedule(hidden ? POLL_HIDDEN_MS : backoff);
        // The outbox has something to retry: keep the classic pace until it
        // is empty again, rather than let a safety-floor tick space out
        // retries. In view only — a hidden tab keeps its own half minute
        // whatever else is true, which is the one thing events signalling
        // promises about hidden tabs: never polled more often than today.
        else if (!hidden && this._hasQueued) this._schedule(POLL_VISIBLE_MS);
        else this._schedule(Math.min(base, this._dueIn(base)));
      }
    }
  }

  /**
   * Fold a sync's conversation deltas into the activity map, `translate`
   * turning a host's ids into local ones (null drops what this workspace
   * does not carry). Says whether anything moved and which conversations
   * got a new message from someone else.
   */
  _foldActivity(c, translate) {
    let changed = false;
    const newIn = [];
    const skipped = [];
    // Whether the member document should be read again: a message of one's
    // own delivered from the queue landed, and this tab cannot tell from
    // what it holds whether the worker moved the cursor to it (see below).
    let reread = false;
    for (const [hostConv, v] of Object.entries(c || {})) {
      const conv = translate ? translate(hostConv) : hostConv;
      if (!conv) continue;
      const cur = this.act.c[conv] || {};
      // A delta computed before the entry that stands was learned (the sync
      // asked for before a bootstrap and answered after it) is the older
      // word, and moves nothing. One that names a message numbered below
      // the counter that stands may still be the first word of that
      // message (see _fillSkipped).
      if (olderActivity(cur, v)) {
        if (v.s && v.s < (cur.s || 0)) skipped.push({ conv, seq: v.s });
        continue;
      }
      // The counter never moves back (see olderActivity): an entry behind on
      // it but ahead on the stamp brings the change and keeps the count.
      const next = layActivity(cur, v);
      if (v.s && v.s < (cur.s || 0)) skipped.push({ conv, seq: v.s });
      if (next.s !== cur.s || next.t !== cur.t || next.x !== cur.x) {
        changed = true;
        if ((v.s || 0) > (cur.s || 0)) {
          if (v.u !== this.uuid) newIn.push({ conv, from: v.u, seq: v.s });
          // One's own message, sent from another tab or device: the worker
          // moved this member's cursor to it as it was written (no refresh
          // follows), so it is not unread here either. Without this the row
          // sat bold and the badges counted it until the conversation was opened.
          //
          // Unless it is a message of one's own delivered from the queue at
          // its time, which the worker marks on the entry (`q`, the number
          // of the newest such message; see the worker's writeMessage): the
          // author is not looking at the conversation as it lands, so the
          // worker moves their cursor to it only where it stood just before
          // it, nothing unread in between (see the worker's postMessage),
          // and this tab does the same, by the cursor it holds and what it
          // has shown. Taken for a message sent from another tab, as it used
          // to be, the delivery marked everything posted since the message
          // was scheduled as read here, though the member had never seen it,
          // and a reload showed it unread again.
          else if (v.q !== v.s || Math.max(this._localSeen.get(conv) || 0, this.me?.reads?.[conv] || 0) >= v.s - 1) {
            this._localSeen.set(conv, Math.max(this._localSeen.get(conv) || 0, v.s));
            if (this.me?.reads && (this.me.reads[conv] || 0) < v.s) this._setMine('reads', conv, v.s);
          }
          // Delivered from the queue with this tab's cursor short of the
          // message before it: the worker's cursor may still have stood
          // there (the conversation read to its end on another device
          // since this tab last had the document; a read moves no stamp
          // that would have brought it), and then the worker moved it and
          // the message is read. The document says which; it is read (see
          // _applySync and _applyLinked), and the conversation then reads
          // here as it does there and on every other device, rather than
          // as unread for a message of one's own until something else
          // happened to bring the document.
          else reread = true;
        }
      }
      this.act.c[conv] = next;
    }
    return { changed, newIn, skipped, reread };
  }

  /**
   * Fetch a message the window skipped: one announced with a number below
   * the counter that stands, which the window does not hold though it
   * reaches past it. Two people posting in the same moment each take a
   * number before either message is written, and the one numbered later
   * may be written and announced first; a page read in between returned it
   * alone, with the counter, and the window took that for its reach (see
   * _reachOf), so the other's announcement, when it came, was the older
   * word by its number (see olderActivity) and nothing fetched it: the
   * message never showed here, and the next page was asked for from past
   * it, until the conversation was opened afresh. Only a message the window
   * would hold is read: one within its span, or, for a window at the end,
   * up to its reach; one before its oldest message comes with the older
   * page, one past a detached window's newest with the next. A word about
   * a message the window holds already (a sync computed before a bootstrap,
   * see olderActivity) reads nothing.
   */
  async _fillSkipped(convId, seq) {
    const c = this.convs.get(convId);
    if (!c?.loaded) return;
    const held = c.messages.filter((m) => m.seq != null);
    if (!held.length || held.some((m) => m.seq === seq)) return;
    const newest = held[held.length - 1].seq;
    if (seq < held[0].seq || seq > (c.hasNewer ? newest : Math.max(newest, c.seq || 0))) return;
    // Looked for once: the worker's entry keeps the lower number until the
    // next message, so every change in the conversation after it (a
    // reaction, an edit) names the same message again, and one that was
    // deleted before any page held it would be read for on each.
    if (c.sought?.has(seq)) return;
    const gen = c.gen || 0;
    const host = this.hostOf(convId);
    const data = await api.messages(host.ref, host.conv, { from: seq, to: seq });
    if (this._dropped(convId, c) || (c.gen || 0) !== gen) return;
    (c.sought = c.sought || new Set()).add(seq);
    const fresh = (data.messages || []).filter((m) => m.seq === seq && !c.messages.some((x) => x.seq === m.seq));
    if (!fresh.length) return;
    c.messages = mergeMessages(c.messages, fresh);
    this.emit('messages', { conv: convId, reason: 'newer', added: fresh });
    // News, as the poll would have announced it had its word come first.
    const others = fresh.filter((m) => m.user !== this.uuid).map((m) => ({ conv: convId, from: m.user, seq: m.seq }));
    if (others.length) this.emit('incoming', others);
  }

  /** Replace who is typing where; true (and a 'typing' event) when that changed. */
  _setTyping(byConv) {
    const before = JSON.stringify(this._typing.byConv);
    this._typing = { at: Object.keys(byConv).length ? Date.now() : 0, byConv };
    if (JSON.stringify(byConv) === before) return false;
    this.emit('typing');
    return true;
  }

  /**
   * Can a conversation's worker be read right now, as far as the store
   * knows: this workspace's own (a sync of it has just got through when
   * this is asked), or a host whose link stands loaded? A host not read yet,
   * or whose last read failed (out of reach, refusing), answers nothing to a
   * read of its messages either, and each read of it waits the request's
   * whole timeout; the link's own retries (see _loadLink and poll) bring it
   * back, and its windows are read again from the next poll after that.
   */
  _hostUp(convId) {
    const { link } = this.hostOf(convId);
    return !link || link.loaded;
  }

  /**
   * Loaded conversations: pull what is new, re-read what changed. Not the
   * windows of a host that cannot be read (see _hostUp): a window shown from
   * the offline cache has seen no overlay stamp, so the host's stamp read
   * as a change on every poll, and the range read of it waited the whole
   * timeout each time, as did the reload refreshStale asked for first; the
   * poll, which waits for both, applied this workspace's own sync forty
   * seconds late for as long as the host was away.
   */
  _queueWindowUpdates(tasks) {
    for (const [conv, c] of this.convs) this._queueWindowUpdate(conv, c, tasks);
  }

  /** One window's part of _queueWindowUpdates (a ring entry asks for its own conversation's alone). */
  _queueWindowUpdate(conv, c, tasks) {
    if (!c.loaded || !this._hostUp(conv)) return;
    const a = this.act.c[conv];
    if (!a) return;
    // What the window has reached: the newest message it holds, or the
    // counter its last read reported, whichever is higher. A deleted
    // newest message is never returned, so on the messages alone the
    // window would look forever behind, fetch nothing new on every poll,
    // and never get to re-read the overlays (edits, reactions, replies).
    const known = c.messages.reduce((m, x) => (x.seq > m ? x.seq : m), c.seq || 0);
    if ((a.s || 0) > known && !c.hasNewer) tasks.push(this.fetchNewer(conv).catch(() => {}));
    // Both when both moved: the newer messages come with their own
    // overlays, but a change to one the window already holds (a reaction,
    // an edit, a reply counted on its root) is only read back by the range
    // read, and taken as the fetch's turn alone it waited for the next
    // poll, four seconds on, half a minute with the tab in the background.
    if ((a.x || 0) > c.xSeen) tasks.push(this.refreshRange(conv).catch(() => {}));
  }

  /**
   * What the hosts of shared channels said, under local ids, applied as
   * each answers. A host that answered 403 wants a fresh attestation (or has
   * ended the connection): the link is loaded again, which attests along
   * the way, while what it showed stays on screen.
   */
  async _applyLinked(linked, wasPoked = false) {
    let activityChanged = false;
    const newIn = [];
    const tasks = [];
    for (const { link, data: d, error, startedAt = 0 } of linked) {
      if (this.links.get(link.ref) !== link) continue;
      if (error) {
        // A host that says the workspace itself is gone (deleted by its
        // owner) is read once more, and the reload marks the connection over
        // (see _loadLink), as it does when the host is first read: left to the
        // sync alone, the word came back with every poll and changed nothing,
        // and the channel stood as it was, its people and its history
        // showing, until this workspace was opened afresh.
        if (error instanceof ApiError && ((error.status === 403 && !isPlatformPage(error)) || isHostGone(error))) tasks.push(this._loadLink(link).catch(() => {}));
        continue;
      }
      this._evCheckSync(link.ev, d, link.evSyncAt || 0, link.w, link.u, wasPoked);
      this._ringBaseline(link.ev, this.wsId, d.rn);
      if (link.ev) link.ev.syncedAt = Math.max(link.ev.syncedAt || 0, startedAt);
      link.evSyncAt = Math.max(link.evSyncAt || 0, d.ts || 0);
      link.since = Math.max(link.since, d.now || 0);
      const folded = this._foldActivity(d.c, (conv) => this._localOf(link, conv));
      if (folded.changed) activityChanged = true;
      newIn.push(...folded.newIn);
      for (const s of folded.skipped) tasks.push(this._fillSkipped(s.conv, s.seq).catch(() => {}));
      this._mergePresence(d.p, d.ps);
      // Who is typing on this host: its channels' entries are replaced by
      // what it says now; everyone else's stand.
      const typing = { ...this._typing.byConv };
      for (const conv of Object.keys(typing)) if (this.hostOf(conv).link === link) delete typing[conv];
      for (const [conv, users] of Object.entries(d.t || {})) {
        const local = this._localOf(link, conv);
        if (local) typing[local] = users;
      }
      if (this._setTyping(typing)) activityChanged = true;
      this._setHuddles(this._huddlesWith(d.h, link));
      if ((d.w || 0) > link.w || (d.u || 0) > link.u) {
        // The stamps are taken as seen and given back if the re-read fails,
        // as _applySync does for this workspace's own: left standing over a
        // read that never landed, the host's document (its people, the
        // channel's topic and rules) stayed as it was until something else
        // changed there, the next poll seeing nothing new in the same stamp.
        const before = { w: link.w, u: link.u };
        link.w = Math.max(link.w, d.w || 0);
        link.u = Math.max(link.u, d.u || 0);
        tasks.push(this._refreshLink(link).then((ok) => {
          if (ok !== false) return;
          link.w = Math.min(link.w, before.w);
          link.u = Math.min(link.u, before.u);
        }).catch(() => {}));
      } else if (folded.reread) {
        // The host's document, for a message of one's own delivered from
        // the queue there (see _foldActivity and _applySync).
        tasks.push(this._refreshLink(link).catch(() => {}));
      }
    }
    this._queueWindowUpdates(tasks);
    if (this._presenceMoved()) activityChanged = true;
    if (activityChanged) this.emit('activity');
    if (newIn.length) this.emit('incoming', newIn);
    await Promise.all(tasks);
  }

  async _applySync(data, linked = []) {
    // When the workspace's next scheduled message or reminder comes due, as
    // a moment on this device's own clock. The worker sends a span, so the
    // two clocks need not agree; a poll is aimed at it below (see _dueIn),
    // since nothing signals when a due time simply arrives.
    this._dueAt = Number.isFinite(data.ndIn) ? Date.now() + Math.max(0, data.ndIn) : 0;
    this.since = Math.max(this.since, data.now || 0);
    this._evSyncAt = Math.max(this._evSyncAt, data.ts || 0);
    this._learnClock(data.ts);
    const folded = this._foldActivity(data.c, null);
    let activityChanged = folded.changed;
    const newIn = folded.newIn;
    // Heartbeats are folded in, and the redraw follows what they mean, not
    // their arrival: a heartbeat that keeps someone active changes nothing on
    // screen, while a silence that lets them lapse to away does (see _presenceMoved).
    this._mergePresence(data.p, data.ps);
    // Another tab of this account closed and said goodbye for the person
    // while this one is still here: the next poll says so, well within the
    // grace the word is given, rather than at the next heartbeat's turn.
    if (data.ps?.[this.uuid] === 'off' && this._present() && this._lastHeartbeat) this._lastHeartbeat = 0;
    if (this._presenceMoved()) activityChanged = true;
    // Typing is replaced wholesale each poll: what the server did not send
    // has stopped, and what it sent expires on its own if polling pauses.
    // What the hosts of shared channels said stands until their own answer
    // replaces it (see _applyLinked).
    const typing = { ...(data.t || {}) };
    for (const [conv, users] of Object.entries(this._typing.byConv)) if (this.hostOf(conv).link) typing[conv] = users;
    if (this._setTyping(typing)) activityChanged = true;
    // Huddles the same way: the whole set each poll, the hosts' entries standing until they answer.
    this._setHuddles(this._huddlesWith(data.h, null));
    const tasks = [];
    for (const s of folded.skipped) tasks.push(this._fillSkipped(s.conv, s.seq).catch(() => {}));
    if ((data.w || 0) > this.act.w || (data.u || 0) > this.act.u) {
      // The stamps are taken as seen so the same change is not fetched
      // twice, and given back if the fetch fails, so the next poll tries
      // again instead of never learning about the new channel or role.
      const before = { w: this.act.w, u: this.act.u };
      this.act.w = Math.max(this.act.w, data.w || 0);
      this.act.u = Math.max(this.act.u, data.u || 0);
      tasks.push(this.refreshWorkspace().catch((e) => {
        this.act.w = Math.min(this.act.w, before.w);
        this.act.u = Math.min(this.act.u, before.u);
        throw e;
      }));
    } else if (folded.reread) {
      // A message of one's own delivered from the queue, the cursor's
      // whereabouts unknown here (see _foldActivity): the document says.
      // Best effort; a stamp or the next opening brings it otherwise.
      tasks.push(this.refreshWorkspace().catch(() => {}));
    }
    this._queueWindowUpdates(tasks);
    if (activityChanged) this.emit('activity');
    if (newIn.length) this.emit('incoming', newIn);
    // Hosts' answers handed in together with this one (the poll folds them
    // in as they arrive; this is for callers that have them at hand).
    if (linked.length) tasks.push(this._applyLinked(linked));
    await Promise.all(tasks);
  }
}

/**
 * Fold a range read back into a loaded window. Messages the read returned
 * replace their old copies; ones it covered but did not return were deleted
 * and go; everything outside what the answer actually covers is left alone,
 * so a partial answer never empties the rest of the list. With `held`, the
 * seqs the window had when the read was asked for: only those are judged by
 * the answer, and a message laid into the window since stands as it is.
 */
function applyRange(messages, data, { from, to, held = null }) {
  const fresh = new Map(data.messages.map((m) => [m.seq, m]));
  const covered = data.hasMore
    ? data.messages.reduce((n, m) => Math.max(n, m.seq), from - 1)
    : to;
  return messages
    .map((m) => {
      if (m.seq == null || m.pending || m.failed) return m;
      if (m.seq < from || m.seq > covered) return m;
      if (held && !held.has(m.seq)) return m;
      return fresh.get(m.seq) || null;
    })
    .filter(Boolean);
}

/** Merge two ascending seq-ordered lists, dropping duplicates. Pending entries stay last. */
function mergeMessages(a, b) {
  const seen = new Map();
  for (const m of [...a, ...b]) if (m.seq != null) seen.set(m.seq, m);
  // A placeholder whose message has arrived is done with: a send whose
  // answer was lost (the request timing out after the worker wrote it) is
  // queued for a retry, and the message itself comes in with the next poll,
  // carrying the client id the placeholder was sent with. Kept, the
  // placeholder read "Queued. Sending shortly." beside the identical message
  // until the retry was answered as a duplicate.
  const landed = new Set([...seen.values()].map((m) => m.cid).filter(Boolean));
  const pending = [...a, ...b].filter((m) => m.seq == null && !(m.cid && landed.has(m.cid)));
  return [...seen.values()].sort((x, y) => x.seq - y.seq).concat(pending);
}

export { mergeMessages, applyRange, isPlatformPage };
export const store = new Store();
