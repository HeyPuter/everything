/**
 * Data layer on top of Puter.
 *
 * Storage design:
 *
 *  KV (small, hot, single-key reads — never kv.list() scans):
 *    tasks:settings:v1  { theme, onboarded, sampleData, reminders, startMonday,
 *                         defaultListId, calFeed }
 *    tasks:lists:v1     { lists: [{ id, name, icon, slot, order, shared? }],
 *                         deleted: [tombstone…] }
 *    tasks:items:v1     { tasks: [task…], logMonths: ['2026-07', …],
 *                         deleted: [tombstone…] }
 *    tasks:collab:<id>: one prefix per list shared over KV shares (meta,
 *                       t:<taskId>, d:<taskId>; see collab.js). The only
 *                       keys read with kv.list(), one prefix at a time.
 *
 *  Every KV value is wrapped in an envelope { v: 2, rev, epoch, at, device,
 *  data } (legacy bare values are still read). `rev`/`at`/`device` identify
 *  a write so other devices can tell "changed" apart from "my own write";
 *  `epoch` identifies the dataset — import/wipe mint a new one, telling
 *  other devices to adopt wholesale instead of merging.
 *
 *  FS (grows unbounded, or must be readable by others):
 *    tasks-data/log-YYYY-MM.json   archived completed tasks, by month done
 *    tasks-data/shares/<id>.json   live snapshot for each shared list
 *    tasks-data/tasks.ics          calendar feed, when enabled
 *
 *  The active KV document holds every open task plus recent completions;
 *  completions older than ARCHIVE_DAYS move to monthly fs files on boot, so
 *  the hot document stays small no matter how long the app is used.
 *
 *  Multi-device: the store refetches on focus and before writing on top of
 *  a stale read, merging by record id (newer updatedAt wins) with
 *  tombstones for deletions — see merge.js. A localStorage mirror gives
 *  instant boots and offline reads; failed KV writes are marked dirty and
 *  merged-then-flushed when the connection returns.
 */

import { uid } from './util.js';
import { todayISO, monthKeyOf, isValidISODate, isValidTime } from './dates.js';
import { nextDue, normalizeRule, reanchorRule } from './recur.js';
import { buildSharePayload, shareLink } from './share.js';
import { buildICS } from './ics.js';
import { unwrapDoc, sigOf, mergeRecords, mergeMonths, normalizeTombstones, sameData } from './merge.js';
import {
  buildManifest, parseManifest, participantsOf, buildReplica, parseReplica,
  manifestPath, replicaPath, inviteLink, confirmLink,
  KV_COLLAB_ROOT, SHARING_OFF, kvPrefixFor, isKvPrefix, taskKey, tombKey, memberListId,
  buildMeta, parseMeta, readKvEntries, shareLabel, shareErrorMessage,
} from './collab.js';

const KV = {
  settings: 'tasks:settings:v1',
  lists: 'tasks:lists:v1',
  items: 'tasks:items:v1',
};

const MIRROR_KEY = 'tasks:mirror:v1';
const DEVICE_KEY = 'tasks:device:v1';
/** Last account seen on this device, so an offline boot can vet the mirror. */
const ACCOUNT_KEY = 'tasks:account:v1';
const DATA_DIR = 'tasks-data';
const SHARE_DIR = `${DATA_DIR}/shares`;
const ICS_PATH = `${DATA_DIR}/tasks.ics`;
/* Ids land in fs paths; encode them so a crafted id ('../x', 'a/b') from an
   import can never point a write or delete outside the app's directories.
   Normal uid()-shaped ids pass through unchanged. */
const fsName = (s) => encodeURIComponent(String(s));
const logPath = (key) => `${DATA_DIR}/log-${fsName(key)}.json`;
const sharePath = (listId) => `${SHARE_DIR}/${fsName(listId)}.json`;

/** Completed tasks stay in the hot document this long before archiving. */
export const ARCHIVE_DAYS = 30;
/** Share/feed URLs are minted for this long; the app renews on use. */
const URL_TTL = '1y';
/** A cloud read this old must be re-fetched (and merged) before writing. */
const FRESH_MS = 60000;
/** Minimum spacing between refreshes (focus events can come in bursts). */
const REFRESH_MIN_MS = 5000;
/** Minimum spacing between unforced kv.listShared() discoveries. */
const DISCOVER_MIN_MS = 30000;

export const PRIORITIES = [
  { value: 3, label: 'High', class: 'p3' },
  { value: 2, label: 'Medium', class: 'p2' },
  { value: 1, label: 'Low', class: 'p1' },
  { value: 0, label: 'None', class: 'p0' },
];

export function priorityInfo(value) {
  return PRIORITIES.find((p) => p.value === value) || PRIORITIES[3];
}

export const LIST_ICON_CHOICES = [
  'list', 'user', 'briefcase', 'house', 'heart', 'shopping-cart', 'book-open',
  'plane', 'star', 'users', 'target', 'dumbbell', 'gift', 'utensils',
  'graduation-cap', 'paw-print',
];

export function normalizeList(raw, order = 0) {
  const now = Date.now();
  return {
    id: raw.id || uid(),
    name: String(raw.name || 'Untitled').slice(0, 80),
    icon: LIST_ICON_CHOICES.includes(raw.icon) ? raw.icon : 'list',
    // Whole slots only: this styles var(--slot-N) lookups, and a fractional
    // slot from an import would resolve to no color at all.
    slot: Math.min(8, Math.max(1, Math.floor(Number(raw.slot)) || 1)),
    order: Number.isFinite(raw.order) ? raw.order : order,
    shared: raw.shared && raw.shared.url ? {
      url: String(raw.shared.url),
      link: String(raw.shared.link || ''),
      expiresAt: Number(raw.shared.expiresAt) || null,
    } : null,
    collab: normalizeCollab(raw.collab),
    // What a finished collaboration leaves behind on the private copy: who
    // ran it (so only that group's invite can re-adopt this list) and when
    // this account joined (so pre-join tombstones stay void afterwards).
    pastCollab: raw.pastCollab && raw.pastCollab.ownerId ? {
      ownerId: String(raw.pastCollab.ownerId),
      joinedAt: Number(raw.pastCollab.joinedAt) || 0,
      endedAt: Number(raw.pastCollab.endedAt) || 0,
    } : null,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || raw.createdAt || now,
  };
}

/**
 * A list's collaboration block. Linked replicas (no `mode`) carry the
 * manifest URL; KV shares carry the owner's prefix or the member's handle.
 */
function normalizeCollab(c) {
  if (!c || !c.memberId) return null;
  const role = c.role === 'owner' ? 'owner' : 'member';
  const base = {
    role,
    memberId: String(c.memberId),
    ownerName: c.ownerName ? String(c.ownerName) : null,
    approved: !!c.approved,
    // When this account joined: tombstones for this list stamped before
    // then are void (they predate the membership — see joinCollab).
    joinedAt: Number(c.joinedAt) || 0,
  };
  if (c.mode === 'kv') {
    if (role === 'owner') return isKvPrefix(c.prefix) ? { mode: 'kv', ...base, prefix: String(c.prefix) } : null;
    return c.handle ? { mode: 'kv', ...base, handle: String(c.handle) } : null;
  }
  return c.manifestUrl ? { ...base, manifestUrl: String(c.manifestUrl) } : null;
}

export function normalizeTask(raw, listId) {
  const now = Date.now();
  // Shape alone isn't enough: imports and collab replicas are just JSON,
  // and a '2026-13-45' that matches the regex renders as a rolled-over
  // date, breaks the ICS feed, and sorts after every real date.
  const due = isValidISODate(raw.due || '') ? raw.due : null;
  // Real epoch-ms only — new Date(1e21) is Invalid and a done task
  // carrying it would blow up the logbook's day grouping.
  const doneAt = Number(raw.completedAt);
  const completedAt = Number.isFinite(doneAt) && doneAt > 0 && doneAt <= 8.64e15 ? doneAt : null;
  // A monthly/yearly rule without a remembered day gets one from the due
  // date it was created with — otherwise the first clamped roll (Jan 31 →
  // Feb 28) would silently re-anchor every later occurrence to the 28th.
  let repeat = normalizeRule(raw.repeat);
  if (repeat && !repeat.day && due) repeat = reanchorRule(repeat, due);
  return {
    id: raw.id || uid(),
    listId: raw.listId || listId,
    title: String(raw.title || '').slice(0, 300),
    notes: String(raw.notes || '').slice(0, 4000),
    due,
    // A time without a date means nothing (and would still skew sorting).
    dueTime: due && isValidTime(raw.dueTime || '') ? raw.dueTime : null,
    // Minutes before the due time (0 = at it); meaningless without a date.
    reminder: due && Number.isFinite(raw.reminder) && raw.reminder >= 0
      ? Math.min(40320, Math.floor(raw.reminder)) : null,
    priority: [0, 1, 2, 3].includes(raw.priority) ? raw.priority : 0,
    tags: [...new Set((Array.isArray(raw.tags) ? raw.tags : [])
      .map((s) => String(s || '').trim().replace(/^#+/, '').toLowerCase()
        .replace(/\s+/g, '-').slice(0, 24))
      .filter(Boolean))].slice(0, 5),
    repeat,
    subtasks: (Array.isArray(raw.subtasks) ? raw.subtasks : [])
      .filter((s) => s && String(s.title || '').trim())
      .map((s) => ({ id: s.id || uid(), title: String(s.title).slice(0, 300), done: !!s.done })),
    done: !!raw.done,
    completedAt,
    recurringOf: raw.recurringOf || null,
    order: Number.isFinite(raw.order) ? raw.order : now,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
  };
}

/** Default open-task order: due first (dated before undated), then priority. */
export function compareTasks(a, b) {
  if (!!a.due !== !!b.due) return a.due ? -1 : 1;
  if (a.due !== b.due) return a.due < b.due ? -1 : 1;
  if ((a.dueTime || '') !== (b.dueTime || '')) {
    if (!a.dueTime !== !b.dueTime) return a.dueTime ? -1 : 1;
    return a.dueTime < b.dueTime ? -1 : 1;
  }
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.order - b.order;
}

const DEFAULT_SETTINGS = {
  theme: 'system',
  onboarded: false,
  sampleData: false,
  reminders: false,
  startMonday: true,
  defaultListId: null,
  calFeed: null,
};

function isQuotaError(err) {
  return /quota|storage/i.test(String(err?.message || err?.code || ''));
}

/**
 * What a caller sees when the cloud refuses a write for being out of room.
 * The change itself is already kept locally and queued for retry, so this
 * is the one write failure the UI is told about — and it must be told the
 * truth: reporting "could not save" made forms re-offer input the store had
 * in fact accepted, and the user filed the same task twice. `quota` marks
 * the difference; the message is safe to show as-is.
 */
function quotaError(cause) {
  const err = new Error('Saved on this device. Your Puter storage is full');
  err.quota = true;
  err.cause = cause;
  return err;
}

/**
 * When the dataset an envelope belongs to was minted. Pre-epochAt
 * envelopes fall back to their write time — the old (flawed) signal.
 */
function mintOf(d) {
  return d.epochAt || d.at || 0;
}

/** The provenance remnant a finished collaboration leaves on the list. */
function pastCollabOf(list) {
  if (!list.collab) return list.pastCollab || null;
  return {
    ownerId: list.collab.role === 'owner' ? list.collab.memberId
      : (list.collab.ownerName || list.collab.handle || ''),
    joinedAt: list.collab.joinedAt || 0,
    endedAt: Date.now(),
  };
}

function isMissingFile(err) {
  return err?.code === 'subject_does_not_exist'
    || /does not exist|not found/i.test(String(err?.message || ''));
}

function readDeviceId() {
  try {
    let d = localStorage.getItem(DEVICE_KEY);
    if (!d) {
      d = uid();
      localStorage.setItem(DEVICE_KEY, d);
    }
    return d;
  } catch {
    return uid();
  }
}

function readAccount() {
  try {
    return localStorage.getItem(ACCOUNT_KEY);
  } catch {
    return null;
  }
}

function writeAccount(name) {
  try {
    if (name) localStorage.setItem(ACCOUNT_KEY, name);
  } catch { /* best-effort */ }
}

/**
 * Next updatedAt for an edit of `prev`: strictly greater, so an edit always
 * beats the record it was derived from in a merge, even inside one clock
 * millisecond (same for reviving a record past its tombstone).
 */
const bump = (prev = 0) => Math.max(Date.now(), prev + 1);

const byIdAsc = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Canonical form of a record set for change detection (order-independent). */
const canon = (records, deleted, extra = null) => JSON.stringify({
  r: [...records].sort(byIdAsc),
  d: [...deleted].sort(byIdAsc),
  x: extra,
});

/**
 * Completions past the archive window live in each device's logbook, not
 * the hot document; an untouched copy arriving in a merge (from a device
 * that has not run its sweep yet) is a resurrection, not news. A recent
 * edit — updatedAt inside the window — still merges normally.
 */
const isArchivedCompletion = (t, cutoff) => !!t.done
  && (t.completedAt || 0) < cutoff && (t.updatedAt || 0) < cutoff;

export class Store extends EventTarget {
  /** The Puter SDK this store talks to (swappable in tests). */
  cloud = typeof puter !== 'undefined' ? puter : null;
  settings = { ...DEFAULT_SETTINGS };
  lists = [];
  tasks = [];
  logMonths = [];
  /** Tombstones: deletions other devices must not resurrect. */
  deletedTasks = [];
  deletedLists = [];
  user = null;
  deviceId = readDeviceId();
  /** Dataset identity: import/wipe mint a new one → others adopt wholesale. */
  epoch = null;
  epochAt = 0;
  #revs = { settings: 0, lists: 0, items: 0 };
  #sigs = { settings: null, lists: null, items: null };
  #lastFetchAt = 0;
  /** Bumped on every successful cloud read; lets callers tell "refreshed" from "read failed". */
  #fetchSeq = 0;
  #refreshPromise = null;
  #dirty = new Set();
  #shareTimer = null;
  #onlineBound = false;

  async init() {
    // Both round-trips start together — the account only has to be settled
    // before the *mirror* is read, since adopting or merging another
    // account's mirror would hand their tasks to whoever signed in next.
    const accountPromise = this.#resolveAccount();
    const cloudPromise = Promise.all([
      this.cloud.kv.get(KV.settings),
      this.cloud.kv.get(KV.lists),
      this.cloud.kv.get(KV.items),
    ]).then((docs) => ({ docs }), (err) => ({ err }));

    const mirror = this.#readMirror(await accountPromise);
    // Deletes a previous session still owed (see #deadFiles). Only paths
    // inside the app's own directory: the mirror is plain localStorage,
    // and a poisoned entry must not aim a delete anywhere else.
    if (mirror?.v === 2 && Array.isArray(mirror.dead)) {
      for (const p of mirror.dead) {
        if (typeof p === 'string' && p.startsWith(`${DATA_DIR}/`)) this.#deadFiles.add(p);
      }
    }
    // Unshares owed the same way (see #deadShares), and only of this app's
    // collab prefixes.
    if (mirror?.v === 2 && Array.isArray(mirror.deadShares)) {
      for (const e of mirror.deadShares) {
        if (typeof e === 'string' && (e.startsWith('h:') || e.startsWith(`p:${KV_COLLAB_ROOT}`))) this.#deadShares.add(e);
      }
    }
    const result = await cloudPromise;
    try {
      if (result.err) throw result.err;
      const [settings, lists, items] = result.docs;
      this.#adoptCloud(settings, lists, items);
      this.#lastFetchAt = Date.now();
      // Nothing in the cloud but a mirror on this device: a previous session
      // wrote offline. Restore it rather than presenting an empty account.
      if (!settings && !lists && !items && mirror) {
        this.#adoptMirror(mirror);
        this.#dirty = new Set(Object.keys(KV));
      } else if (mirror) {
        // A previous session may have ended with writes still queued;
        // adopting the (stale) cloud wholesale would silently drop them.
        this.#mergeQueued(mirror);
      }
    } catch (err) {
      if (!mirror) throw err;
      this.#adoptMirror(mirror);
      this.#restoreQueue(mirror);
    }
    if (!this.epoch) {
      this.epoch = uid();
      this.epochAt = Date.now();
    }

    if (this.lists.length === 0 && !this.settings.onboarded) {
      // First run: a friendly default so the very first task has a home.
      this.lists = [
        normalizeList({ name: 'Personal', icon: 'user', slot: 1 }, 0),
        normalizeList({ name: 'Work', icon: 'briefcase', slot: 5 }, 1),
      ];
      await this.#save('lists');
    }

    // #resolveAccount usually has this already; retry quietly if it could
    // not reach the account service (offline boot).
    if (!this.user) {
      this.cloud.auth.getUser()
        .then((u) => { this.user = u; writeAccount(u?.username); })
        .catch(() => {});
    }
    // init() can run more than once (error-retry flows); bind once.
    if (!this.#onlineBound) {
      this.#onlineBound = true;
      window.addEventListener('online', () => this.#flushDirty());
    }
    this.#writeMirror();
    // Push anything queued (restored mirrors, a prior session's offline
    // edits) now, instead of waiting for an edit or an 'online' event that
    // may never fire on a connection that stayed up.
    if (this.#dirty.size) this.#flushDirty().catch(() => {});
  }

  #adopt(settings, listsDoc, itemsDoc) {
    this.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    const ld = Array.isArray(listsDoc) ? { lists: listsDoc } : (listsDoc || {});
    this.lists = (Array.isArray(ld.lists) ? ld.lists : []).map((l, i) => normalizeList(l, i))
      .sort((a, b) => a.order - b.order);
    this.deletedLists = normalizeTombstones(ld.deleted);
    const doc = itemsDoc || {};
    this.tasks = (Array.isArray(doc.tasks) ? doc.tasks : []).map((t) => normalizeTask(t));
    // Month keys become fs paths (log-YYYY-MM.json); drop anything else.
    this.logMonths = (Array.isArray(doc.logMonths) ? doc.logMonths : [])
      .filter((k) => /^\d{4}-\d{2}$/.test(String(k))).sort();
    this.deletedTasks = normalizeTombstones(doc.deleted);
  }

  #adoptCloud(sRaw, lRaw, iRaw) {
    const s = unwrapDoc(sRaw);
    const l = unwrapDoc(lRaw);
    const i = unwrapDoc(iRaw);
    this.#adopt(s.data, l.data, i.data);
    this.#revs = { settings: s.rev, lists: l.rev, items: i.rev };
    this.#sigs = {
      settings: sRaw ? sigOf(s) : null,
      lists: lRaw ? sigOf(l) : null,
      items: iRaw ? sigOf(i) : null,
    };
    // Label this device with the newest-minted dataset present in the
    // cloud (falling back to write time for pre-epochAt envelopes) — not
    // blindly with whatever the items doc carries.
    const docs = [i, l, s].filter((d) => d.epoch);
    const newest = docs.length ? docs.reduce((a, b) => (mintOf(b) > mintOf(a) ? b : a)) : null;
    this.epoch = newest?.epoch || null;
    this.epochAt = newest ? mintOf(newest) : 0;
  }

  #adoptMirror(m) {
    this.#adopt(m.settings, m.lists, m.items);
    if (m.v === 2) {
      this.epoch = m.epoch || null;
      this.epochAt = m.epochAt || 0;
      this.#revs = { settings: 0, lists: 0, items: 0, ...(m.revs || {}) };
    }
    // Unknown cloud state → force a full merge on the next refresh.
    this.#sigs = { settings: null, lists: null, items: null };
  }

  /** Re-queue the mirror's unsynced keys (offline boot: mirror is state). */
  #restoreQueue(mirror) {
    if (mirror.v !== 2 || !Array.isArray(mirror.dirty)) return;
    for (const key of mirror.dirty) {
      if (key in KV) this.#dirty.add(key);
    }
  }

  /**
   * Layer a previous session's queued offline writes (persisted in the
   * mirror) onto the freshly adopted cloud state — the same per-record
   * newer-edit-wins/tombstone rules as any other merge, with local intent
   * winning for settings. A mirror belonging to a replaced dataset follows
   * the epoch rule: newer epoch wins wholesale, older is dropped.
   */
  #mergeQueued(mirror) {
    if (mirror.v !== 2 || !Array.isArray(mirror.dirty)) return;
    const queued = new Set(mirror.dirty.filter((k) => k in KV));
    if (!queued.size) return;

    if (mirror.epoch && this.epoch && mirror.epoch !== this.epoch) {
      if ((mirror.epochAt || 0) <= this.epochAt) return; // replaced elsewhere
      this.#adoptMirror(mirror);
      this.#dirty = new Set(Object.keys(KV));
      return;
    }

    const prune = Date.now() - ARCHIVE_DAYS * 86400000;
    if (queued.has('settings') && mirror.settings) {
      const next = { ...DEFAULT_SETTINGS, ...mirror.settings };
      if (!sameData(next, this.settings)) {
        this.settings = next;
        this.#dirty.add('settings');
      }
    }
    if (queued.has('lists')) {
      const md = mirror.lists || {};
      const mine = (Array.isArray(md.lists) ? md.lists : []).map((l, i) => normalizeList(l, i));
      const merged = mergeRecords(mine, this.lists, md.deleted, this.deletedLists, { pruneBefore: prune });
      if (canon(merged.records, merged.deleted) !== canon(this.lists, this.deletedLists)) {
        this.lists = [...merged.records].sort((a, b) => a.order - b.order);
        this.deletedLists = merged.deleted;
        this.#dirty.add('lists');
      }
    }
    if (queued.has('items')) {
      const md = mirror.items || {};
      const mine = (Array.isArray(md.tasks) ? md.tasks : []).map((t) => normalizeTask(t))
        .filter((t) => !isArchivedCompletion(t, prune));
      const months = mergeMonths(md.logMonths, this.logMonths);
      const mirrorDel = normalizeTombstones(md.deleted).filter((d) => !this.#voidTombstone(d));
      const localDel = this.deletedTasks.filter((d) => !this.#voidTombstone(d));
      const merged = mergeRecords(mine, this.tasks, mirrorDel, localDel, { pruneBefore: prune });
      if (canon(merged.records, merged.deleted, months) !== canon(this.tasks, this.deletedTasks, this.logMonths)) {
        this.tasks = merged.records;
        this.deletedTasks = merged.deleted;
        this.logMonths = months;
        this.#dirty.add('items');
      }
    }
  }

  #emit() {
    this.dispatchEvent(new Event('change'));
  }

  #docFor(key) {
    if (key === 'settings') return this.settings;
    if (key === 'lists') return { lists: this.lists, deleted: this.deletedLists };
    return { tasks: this.tasks, logMonths: this.logMonths, deleted: this.deletedTasks };
  }

  #envelope(key) {
    return {
      v: 2,
      rev: this.#revs[key] + 1,
      epoch: this.epoch,
      // The dataset's mint time rides along so other devices can order
      // epochs by when they were created — a stale epoch written recently
      // must not look newer than a fresh import written a moment earlier.
      epochAt: this.epochAt,
      at: Date.now(),
      device: this.deviceId,
      data: this.#docFor(key),
    };
  }

  async #save(key) {
    this.#writeMirror();
    this.#emit();
    const wasPending = this.#dirty.size;
    // This key's change is not in the cloud yet — true by definition here.
    // The mark matters for settings: the pre-write refresh below adopts a
    // remote settings doc wholesale unless the key is dirty, which would
    // silently revert the very patch this save is about to write (and then
    // write the reverted state as if it were the change).
    this.#dirty.add(key);
    try {
      // Writing on top of a stale read would clobber other devices' edits:
      // re-fetch and merge first, then write the combined state.
      if (navigator.onLine !== false && Date.now() - this.#lastFetchAt > FRESH_MS) {
        await this.refreshFromCloud().catch(() => {});
      }
      const env = this.#envelope(key);
      await this.cloud.kv.set(KV[key], env);
      this.#revs[key] = env.rev;
      this.#sigs[key] = sigOf(env);
      this.#dirty.delete(key);
    } catch (err) {
      // Keep the change locally and retry when back online. The queue must
      // survive the tab closing, so re-mirror with the key marked dirty.
      this.#dirty.add(key);
      this.#writeMirror();
      if (isQuotaError(err)) throw quotaError(err);
    } finally {
      // Even the rethrowing quota path queued a write: the unsynced-count
      // banner must hear about it, or the UI claims everything reached
      // the cloud while a write sits in the queue.
      this.#notifySync(wasPending);
      if (key !== 'settings') this.#scheduleShareSync();
    }
  }

  /**
   * Write several documents in order, attempting every one even if an
   * earlier write fails. #save rethrows a full-cloud rejection, and a
   * sequence that let it propagate abandoned the writes that came after:
   * deleting a list wrote its tasks and then never queued the list
   * tombstone at all, so the delete never left this device and the list
   * (with its tasks) came back on the next boot. Failed writes stay queued,
   * so the sequence still converges on retry — while the first error
   * reaches the caller, which is what the rethrow is for.
   */
  async #saveAll(...keys) {
    let first = null;
    for (const key of keys) {
      try {
        await this.#save(key);
      } catch (err) {
        first ||= err;
      }
    }
    if (first) throw first;
  }

  async #flushDirty() {
    if (!this.#dirty.size) return;
    const wasPending = this.#dirty.size;
    // Layer the queued offline edits onto the latest cloud state instead of
    // replacing it — the device may have been gone for a while. That
    // refresh is the only guard between this stale queue and newer cloud
    // data, so if the read failed (offline, transient server trouble),
    // keep the queue for the next retry instead of writing blind: reads
    // can fail while writes would still succeed, and flushing then would
    // clobber other devices' edits with old state.
    const seq = this.#fetchSeq;
    await this.refreshFromCloud({ force: true }).catch(() => {});
    if (this.#fetchSeq === seq) return;
    for (const key of [...this.#dirty]) {
      try {
        const env = this.#envelope(key);
        await this.cloud.kv.set(KV[key], env);
        this.#revs[key] = env.rev;
        this.#sigs[key] = sigOf(env);
        this.#dirty.delete(key);
      } catch { /* still offline; keep for next attempt */ }
    }
    this.#writeMirror(); // record which keys made it out of the queue
    this.#notifySync(wasPending);
    // Owed file deletes and unshares ride the same retry moments (online,
    // focus, boot).
    await this.#reapDeadFiles();
    await this.#reapDeadShares();
  }

  /** Announce a change in the unsynced-write count, so the UI can show it. */
  #notifySync(before) {
    if (this.#dirty.size === before) return;
    this.dispatchEvent(new CustomEvent('sync-state', {
      detail: { pending: this.#dirty.size },
    }));
  }

  /** How many documents hold changes that have not reached the cloud. */
  pendingWrites() {
    return this.#dirty.size;
  }

  /**
   * Retry the queued writes now. Writes fail for reasons beyond being
   * offline (transient server errors, an expired session), and those never
   * see an 'online' event — so the UI retries on focus as well.
   */
  async flushPending() {
    await this.#flushDirty();
    return this.#dirty.size;
  }

  /* ---------- cross-device refresh ---------- */

  /**
   * Fetch the cloud documents and merge remote changes in (see merge.js).
   * Cheap when nothing changed (three reads, no writes). Emits 'change' and
   * 'remote-change' when the merge altered local state. Returns whether it
   * did; concurrent calls share one in-flight refresh.
   */
  async refreshFromCloud({ force = false } = {}) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    if (this.#refreshPromise) return this.#refreshPromise;
    if (!force && Date.now() - this.#lastFetchAt < REFRESH_MIN_MS) return false;
    this.#refreshPromise = this.#doRefresh().finally(() => { this.#refreshPromise = null; });
    return this.#refreshPromise;
  }

  async #doRefresh() {
    let raw;
    try {
      raw = await Promise.all([
        this.cloud.kv.get(KV.settings),
        this.cloud.kv.get(KV.lists),
        this.cloud.kv.get(KV.items),
      ]);
    } catch {
      return false;
    }
    this.#lastFetchAt = Date.now();
    this.#fetchSeq++;
    const changed = await this.#mergeCloud(...raw);
    if (changed) {
      this.#writeMirror();
      this.#emit();
      this.dispatchEvent(new Event('remote-change'));
    }
    return changed;
  }

  async #mergeCloud(sRaw, lRaw, iRaw) {
    const s = unwrapDoc(sRaw);
    const l = unwrapDoc(lRaw);
    const i = unwrapDoc(iRaw);

    // A different epoch is a dataset replacement (import or wipe on another
    // device): adopt whichever dataset was *minted* later, wholesale —
    // merging two unrelated datasets would interleave them. Ordering by
    // write time instead of mint time would let a stale-epoch document
    // written moments after an import (a device saving inside its
    // freshness window, unaware) beat the import and destroy it.
    const foreign = [s, l, i].filter((d) => d.epoch && this.epoch && d.epoch !== this.epoch);
    if (foreign.length) {
      const newest = foreign.reduce((a, b) => (mintOf(b) > mintOf(a) ? b : a));
      const theirs = mintOf(newest);
      // Equal mints (two simultaneous imports) tie-break on the epoch id
      // so both devices pick the same winner instead of fighting forever.
      if (theirs > this.epochAt || (theirs === this.epochAt && newest.epoch > this.epoch)) {
        this.#adoptCloud(sRaw, lRaw, iRaw);
        this.#dirty.clear();
        this.#syncSig.clear();
        return true;
      }
      // Ours is newer: push our copy over each stale-epoch document now.
      // Waiting for an organic save of that key could leave the cloud
      // mixed indefinitely, and every refresh would bail out right here.
      for (const [key, d] of [['settings', s], ['lists', l], ['items', i]]) {
        if (d.epoch && d.epoch !== this.epoch) await this.#save(key);
      }
      return false;
    }

    const prune = Date.now() - ARCHIVE_DAYS * 86400000;
    let changed = false;

    if (sRaw && sigOf(s) !== this.#sigs.settings) {
      this.#revs.settings = s.rev;
      this.#sigs.settings = sigOf(s);
      // Settings have no per-field history; the other device's write wins
      // unless ours is still waiting to be pushed.
      if (!this.#dirty.has('settings')) {
        const next = { ...DEFAULT_SETTINGS, ...(s.data || {}) };
        if (!sameData(next, this.settings)) {
          this.settings = next;
          changed = true;
        }
      }
    }

    if (lRaw && sigOf(l) !== this.#sigs.lists) {
      this.#revs.lists = l.rev;
      this.#sigs.lists = sigOf(l);
      const ld = Array.isArray(l.data) ? { lists: l.data } : (l.data || {});
      const remote = (Array.isArray(ld.lists) ? ld.lists : []).map((x, idx) => normalizeList(x, idx));
      const remoteDel = normalizeTombstones(ld.deleted);
      const merged = mergeRecords(this.lists, remote, this.deletedLists, remoteDel, { pruneBefore: prune });
      const mergedC = canon(merged.records, merged.deleted);
      if (mergedC !== canon(this.lists, this.deletedLists)) {
        this.lists = [...merged.records].sort((a, b) => a.order - b.order);
        this.deletedLists = merged.deleted;
        changed = true;
      }
      // The merge produced something the cloud doesn't have → push our half.
      if (mergedC !== canon(remote, remoteDel)) await this.#save('lists');
    }

    if (iRaw && sigOf(i) !== this.#sigs.items) {
      this.#revs.items = i.rev;
      this.#sigs.items = sigOf(i);
      const doc = i.data || {};
      const remote = (Array.isArray(doc.tasks) ? doc.tasks : []).map((t) => normalizeTask(t))
        .filter((t) => !isArchivedCompletion(t, prune));
      // Void tombstones (pre-join, see #voidTombstone) are dropped from
      // both sides: another device's sync may have raced a collab rejoin.
      const remoteDel = normalizeTombstones(doc.deleted).filter((d) => !this.#voidTombstone(d));
      const localDel = this.deletedTasks.filter((d) => !this.#voidTombstone(d));
      const months = mergeMonths(this.logMonths, doc.logMonths);
      const merged = mergeRecords(this.tasks, remote, localDel, remoteDel, { pruneBefore: prune });
      const mergedC = canon(merged.records, merged.deleted, months);
      if (mergedC !== canon(this.tasks, this.deletedTasks, this.logMonths)) {
        this.tasks = merged.records;
        this.deletedTasks = merged.deleted;
        this.logMonths = months;
        changed = true;
      }
      if (mergedC !== canon(remote, remoteDel, Array.isArray(doc.logMonths) ? [...doc.logMonths].sort() : [])) {
        await this.#save('items');
      }
    }

    return changed;
  }

  /**
   * The account this boot belongs to. Online that is simply the signed-in
   * user; offline (where the mirror matters most) it is the last account
   * seen on this device — which is the same one, since signing in as
   * somebody else requires a connection.
   */
  async #resolveAccount() {
    try {
      // A hung account service must not hold up a boot the mirror could serve.
      const user = await Promise.race([
        this.cloud.auth.getUser(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
      ]);
      if (user?.username) {
        this.user = user;
        writeAccount(user.username);
        return user.username;
      }
    } catch { /* offline or unreachable: fall back to the cached account */ }
    return readAccount();
  }

  #readMirror(account = null) {
    try {
      const raw = localStorage.getItem(MIRROR_KEY);
      const m = raw ? JSON.parse(raw) : null;
      if (!m) return null;
      // Stamped for someone else: this mirror belongs to whoever used the
      // browser before, and none of it may reach the current account. An
      // unstamped mirror predates the stamp and can only be this account's.
      if (m.account && account && m.account !== account) return null;
      return m;
    } catch {
      return null;
    }
  }

  #writeMirror() {
    try {
      localStorage.setItem(MIRROR_KEY, JSON.stringify({
        v: 2,
        account: this.user?.username || readAccount() || null,
        settings: this.settings,
        lists: this.#docFor('lists'),
        items: this.#docFor('items'),
        epoch: this.epoch,
        epochAt: this.epochAt,
        revs: this.#revs,
        // Keys with writes still queued: the next boot must merge these
        // mirror docs over the cloud instead of adopting the cloud wholesale.
        dirty: [...this.#dirty],
        // Published files whose delete is still owed (see #deadFiles).
        dead: [...this.#deadFiles],
        deadShares: [...this.#deadShares],
      }));
    } catch { /* mirror is best-effort */ }
  }

  /* ---------- settings ---------- */

  async updateSettings(patch) {
    Object.assign(this.settings, patch);
    await this.#save('settings');
  }

  /* ---------- lists ---------- */

  listById(id) {
    return this.lists.find((l) => l.id === id) || null;
  }

  async addList(data) {
    // Strictly past every existing order — dragging a list to the end
    // assigns prev.order + 1, so lists.length alone can collide with it.
    const order = this.lists.reduce((m, l) => Math.max(m, l.order + 1), 0);
    const list = normalizeList({ ...data, id: uid() }, order);
    this.lists.push(list);
    await this.#save('lists');
    return list;
  }

  async updateList(id, patch) {
    const list = this.listById(id);
    if (!list) return;
    Object.assign(list, normalizeList({ ...list, ...patch, updatedAt: bump(list.updatedAt) }, list.order));
    await this.#save('lists');
  }

  /** Removes the list, its tasks, and its published files (best-effort). */
  async deleteList(id) {
    const list = this.listById(id);
    if (!list) return;
    this.lists = this.lists.filter((l) => l.id !== id);
    this.deletedLists.push({ id, at: bump(list.updatedAt) });
    for (const t of this.tasks.filter((t) => t.listId === id)) {
      this.deletedTasks.push({ id: t.id, at: bump(t.updatedAt), listId: id });
    }
    this.tasks = this.tasks.filter((t) => t.listId !== id);
    const wasDefault = this.settings.defaultListId === id;
    if (wasDefault) this.settings.defaultListId = null;
    if (list.shared) this.#deleteFile(sharePath(id));
    const released = this.#releaseCollab(list);
    // Two cloud documents, one delete: the tab can close between them, so
    // the order decides what a half-finished delete leaves behind. Tasks
    // first — an interrupted delete then shows an empty list the user can
    // remove again. The other order strands the tasks under a list
    // tombstone: they come back on the next boot, surface in Today,
    // search and tags, and nothing can reach them to clean them up.
    await this.#saveAll('items', 'lists', ...(wasDefault ? ['settings'] : []));
    await released;
  }

  /**
   * Undo what a collaboration published. Linked replicas: delete my replica
   * (and, as owner, the manifest — members then keep private copies). KV
   * shares: the owner revokes every share and clears the prefix, a member
   * drops their handle. Failures stay queued for retry; never rejects.
   */
  #releaseCollab(list) {
    const c = list.collab;
    if (!c) return Promise.resolve();
    if (c.mode !== 'kv') {
      if (c.role === 'owner') this.#deleteFile(manifestPath(list.id));
      this.#deleteFile(replicaPath(list.id, c.memberId));
      return Promise.resolve();
    }
    this.#unwatch(list.id);
    const entry = c.role === 'owner' ? `p:${c.prefix}` : `h:${c.handle}`;
    this.#deadShares.add(entry);
    return this.#reapShare(entry);
  }

  /* ---------- tasks ---------- */

  taskById(id) {
    return this.tasks.find((t) => t.id === id) || null;
  }

  openTasks(listId = null) {
    return this.tasks
      .filter((t) => !t.done && (!listId || t.listId === listId))
      .sort(compareTasks);
  }

  /**
   * Every tag in use, with open-task counts, alphabetically. Tags are
   * derived from the tasks themselves — no bookkeeping, and a tag with no
   * tasks left simply stops existing.
   */
  allTags() {
    const counts = new Map();
    for (const t of this.tasks) {
      for (const tag of t.tags || []) {
        const c = counts.get(tag) || { tag, open: 0, total: 0 };
        c.total += 1;
        if (!t.done) c.open += 1;
        counts.set(tag, c);
      }
    }
    return [...counts.values()].sort((a, b) => a.tag.localeCompare(b.tag));
  }

  /** Recently completed (still in the hot doc), newest first. */
  completedTasks(listId = null) {
    return this.tasks
      .filter((t) => t.done && (!listId || t.listId === listId))
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  }

  async addTask(data) {
    let listId = data.listId || this.settings.defaultListId || this.lists[0]?.id;
    // Never create an orphaned task: stale ids (deleted list, wiped data)
    // fall back to the first list, and an empty account gets a default one.
    if (!listId || !this.listById(listId)) {
      listId = this.lists[0]?.id
        || (await this.addList({ name: 'Personal', icon: 'user', slot: 1 })).id;
    }
    const task = normalizeTask({ ...data, id: uid(), listId }, listId);
    if (!task.title.trim()) throw new Error('A task needs a title');
    this.tasks.push(task);
    await this.#save('items');
    return task;
  }

  async updateTask(id, patch) {
    const task = this.taskById(id);
    if (!task) return;
    const updated = normalizeTask({ ...task, ...patch, updatedAt: bump(task.updatedAt) });
    // Deliberately moving the due date re-points a monthly/yearly rule at
    // the new day ("the 20th from now on"). Completion rolls don't pass
    // through here, so a clamped occurrence keeps the intended anchor.
    if (updated.repeat && 'due' in patch && patch.due !== task.due) {
      updated.repeat = reanchorRule(updated.repeat, updated.due);
    }
    Object.assign(task, updated);
    await this.#save('items');
  }

  /**
   * Complete an occurrence. Recurring tasks log the finished occurrence as
   * its own (completed) row and roll forward to the next due date with
   * subtasks reset; plain tasks simply flip to done.
   * Returns { recurred, next, undoId } so the UI can toast the roll-forward
   * and offer Undo — uncompleteTask(undoId) reverses either kind.
   */
  async completeTask(id, { today = todayISO() } = {}) {
    const task = this.taskById(id);
    if (!task || task.done) return { recurred: false, next: null, undoId: null };
    const now = Date.now();
    const at = bump(task.updatedAt);
    if (task.repeat) {
      const logged = normalizeTask({
        ...task,
        id: uid(),
        repeat: null,
        recurringOf: task.id,
        done: true,
        completedAt: now,
        updatedAt: at,
      });
      this.tasks.push(logged);
      task.due = nextDue(task.repeat, task.due, today);
      task.subtasks = task.subtasks.map((s) => ({ ...s, done: false }));
      task.updatedAt = at;
      await this.#save('items');
      return { recurred: true, next: task.due, undoId: logged.id };
    }
    task.done = true;
    task.completedAt = now;
    task.updatedAt = at;
    await this.#save('items');
    return { recurred: false, next: null, undoId: task.id };
  }

  async uncompleteTask(id) {
    const task = this.taskById(id);
    if (!task || !task.done) return;
    // Undoing a recurring occurrence must not leave two open copies around:
    // remove the logged occurrence and roll the source task back to it
    // (due date and pre-completion subtask states both come from the log).
    if (task.recurringOf) {
      const source = this.taskById(task.recurringOf);
      if (source && source.repeat && !source.done) {
        source.due = task.due;
        source.subtasks = task.subtasks.map((s) => ({ ...s }));
        source.updatedAt = bump(source.updatedAt);
        this.tasks = this.tasks.filter((t) => t.id !== id);
        this.deletedTasks.push({ id, at: bump(task.updatedAt), listId: task.listId });
        await this.#save('items');
        return;
      }
    }
    task.done = false;
    task.completedAt = null;
    task.updatedAt = bump(task.updatedAt);
    await this.#save('items');
  }

  async deleteTask(id) {
    const task = this.taskById(id);
    if (!task) return;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.deletedTasks.push({ id, at: bump(task.updatedAt), listId: task.listId });
    await this.#save('items');
  }

  async restoreTask(task) {
    // Undo of a delete: the tombstone must go too, or the next merge would
    // bury the task again — and the restored copy must postdate it in case
    // the tombstone already reached another device.
    const tomb = this.deletedTasks.find((d) => d.id === task.id);
    this.deletedTasks = this.deletedTasks.filter((d) => d.id !== task.id);
    this.tasks.push(normalizeTask({ ...task, updatedAt: bump(Math.max(task.updatedAt || 0, tomb?.at || 0)) }));
    await this.#save('items');
  }

  /**
   * Move any number of open tasks to a new due date (null clears it) in a
   * single write. Returns what changed so the caller can offer Undo.
   */
  async rescheduleTasks(ids, due) {
    const undo = [];
    for (const id of ids) {
      const task = this.taskById(id);
      if (!task || task.done || task.due === due) continue;
      undo.push({ id, due: task.due, dueTime: task.dueTime, reminder: task.reminder });
      task.due = due;
      if (!due) {
        // Same rule as the form: a time or reminder without a date is noise.
        task.dueTime = null;
        task.reminder = null;
      }
      if (due && task.repeat) task.repeat = reanchorRule(task.repeat, due);
      task.updatedAt = bump(task.updatedAt);
    }
    if (undo.length) await this.#save('items');
    return undo;
  }

  /** Undo half of rescheduleTasks. */
  async restoreDues(entries) {
    let changed = false;
    for (const e of entries) {
      const task = this.taskById(e.id);
      if (!task) continue;
      task.due = e.due;
      task.dueTime = e.due ? e.dueTime : null;
      task.reminder = e.due ? e.reminder : null;
      if (e.due && task.repeat) task.repeat = reanchorRule(task.repeat, e.due);
      task.updatedAt = bump(task.updatedAt);
      changed = true;
    }
    if (changed) await this.#save('items');
  }

  /* ---------- manual ordering ---------- */

  /** Open tasks of a list in the user's manual order (drag order). */
  manualTasks(listId) {
    return this.tasks
      .filter((t) => !t.done && t.listId === listId)
      .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  }

  /**
   * Place a task between two siblings (either may be absent at the ends).
   * Orders are midpoints so one move writes one record; when the gap
   * degenerates (imports, heavy reshuffling), the list renumbers once.
   */
  async reorderTask(id, { prevId = null, nextId = null } = {}, { renumbered = false } = {}) {
    const task = this.taskById(id);
    if (!task) return;
    const prev = prevId ? this.taskById(prevId) : null;
    const next = nextId ? this.taskById(nextId) : null;
    if (!prev && !next) return;
    let order;
    if (prev && next) order = (prev.order + next.order) / 2;
    else if (prev) order = prev.order + 1000;
    else order = next.order - 1000;
    const degenerate = !Number.isFinite(order)
      || (prev && order <= prev.order) || (next && order >= next.order);
    if (degenerate && !renumbered) {
      for (const [i, t] of this.manualTasks(task.listId).entries()) {
        t.order = (i + 1) * 1000;
        t.updatedAt = bump(t.updatedAt);
      }
      return this.reorderTask(id, { prevId, nextId }, { renumbered: true });
    }
    task.order = order;
    task.updatedAt = bump(task.updatedAt);
    await this.#save('items');
  }

  /** Same as reorderTask, for the lists themselves. */
  async reorderList(id, { prevId = null, nextId = null } = {}, { renumbered = false } = {}) {
    const list = this.listById(id);
    if (!list) return;
    const prev = prevId ? this.listById(prevId) : null;
    const next = nextId ? this.listById(nextId) : null;
    if (!prev && !next) return;
    let order;
    if (prev && next) order = (prev.order + next.order) / 2;
    else if (prev) order = prev.order + 1;
    else order = next.order - 1;
    const degenerate = !Number.isFinite(order)
      || (prev && order <= prev.order) || (next && order >= next.order);
    if (degenerate && !renumbered) {
      for (const [i, l] of this.lists.entries()) {
        l.order = i;
        l.updatedAt = bump(l.updatedAt);
      }
      return this.reorderList(id, { prevId, nextId }, { renumbered: true });
    }
    list.order = order;
    list.updatedAt = bump(list.updatedAt);
    this.lists.sort((a, b) => a.order - b.order);
    await this.#save('lists');
  }

  /** Skip the current occurrence of a recurring task (no completion logged). */
  async skipOccurrence(id, { today = todayISO() } = {}) {
    const task = this.taskById(id);
    if (!task?.repeat) return null;
    task.due = nextDue(task.repeat, task.due, today);
    task.updatedAt = bump(task.updatedAt);
    await this.#save('items');
    return task.due;
  }

  /* ---------- archive (logbook) ---------- */

  /**
   * Move completions older than ARCHIVE_DAYS into per-month fs files.
   * Runs on boot, fire-and-forget; the hot document stays small forever.
   */
  async archiveOldCompleted({ now = Date.now() } = {}) {
    const cutoff = now - ARCHIVE_DAYS * 86400000;
    const old = this.tasks.filter((t) => t.done && (t.completedAt || 0) < cutoff);
    if (!old.length) return 0;

    // Snapshot the victims before the fs round-trips below yield to the
    // UI: a task reopened or edited mid-sweep must not be archived in its
    // edited state, and the stamp lets the removal step recognize it.
    const stamp = new Map(old.map((t) => [t.id, t.updatedAt]));
    const byMonth = new Map();
    for (const t of old) {
      const key = monthKeyOf(todayISO(new Date(t.completedAt || now)));
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push({ ...t });
    }

    const gone = new Set();
    for (const [key, batch] of byMonth) {
      let existing;
      try {
        existing = await this.loadLog(key);
      } catch (err) {
        // Only a missing file means "no archive yet". Any other failure
        // (network hiccup, corrupt read) must not be mistaken for empty —
        // writing just this batch would destroy the month's history. Skip
        // the month; the next sweep retries.
        if (!isMissingFile(err)) continue;
        existing = [];
      }
      // Batch entries replace same-id archive copies: a completion that
      // bounced through reopen-and-complete-again should be archived in
      // its final state, not its first.
      const ids = new Set(batch.map((t) => t.id));
      const merged = existing.filter((t) => !ids.has(t.id)).concat(batch);
      try {
        await this.cloud.fs.write(logPath(key), JSON.stringify(merged), { createMissingParents: true });
        this.#deadFiles.delete(logPath(key));
      } catch {
        continue; // not written → its tasks stay in the hot doc for now
      }
      if (!this.logMonths.includes(key)) this.logMonths.push(key);
      for (const t of batch) gone.add(t.id);
    }
    if (!gone.size) return 0;
    this.logMonths.sort();
    // A task touched while the sweep's writes were in flight no longer
    // matches its snapshot: keep it — a reopened task removed here would
    // vanish from every open view with no tombstone and no error.
    this.tasks = this.tasks.filter((t) => !gone.has(t.id) || t.updatedAt !== stamp.get(t.id));
    // Same sweep: tombstones past their echo window have done their job.
    this.deletedTasks = this.deletedTasks.filter((d) => d.at >= cutoff);
    this.deletedLists = this.deletedLists.filter((d) => d.at >= cutoff);
    await this.#save('items');
    return gone.size;
  }

  async loadLog(monthKey) {
    const blob = await this.cloud.fs.read(logPath(monthKey));
    const text = typeof blob === 'string' ? blob : await blob.text();
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr.map((t) => normalizeTask(t)) : [];
  }

  /* ---------- sharing ---------- */

  /* Bumped whenever sharing is turned off for a list, so a publish whose
     cloud round-trips started earlier can tell it has been overtaken. */
  #shareGen = new Map();

  /**
   * Publish (or refresh) a list's snapshot and mint a viewer link.
   * Returns null when stopping (or deleting) overtook the publish.
   */
  async enableShare(listId) {
    const list = this.listById(listId);
    if (!list) throw new Error('No such list');
    const gen = this.#shareGen.get(listId) || 0;
    await this.#writeShareFile(list);
    let url;
    try {
      url = await this.cloud.fs.getReadURL(sharePath(listId), URL_TTL);
    } catch (err) {
      // The file may be gone despite a cached signature (deleted outside
      // the app); force one rewrite and retry.
      this.#syncSig.delete(sharePath(listId));
      await this.#writeShareFile(list);
      url = await this.cloud.fs.getReadURL(sharePath(listId), URL_TTL);
    }
    // "Stop sharing" while those round-trips were in flight must win:
    // committing here would re-publish the list the user just unshared,
    // and the writes above have already recreated the snapshot file.
    if ((this.#shareGen.get(listId) || 0) !== gen || !this.listById(listId)) {
      this.#deleteFile(sharePath(listId));
      return null;
    }
    list.shared = {
      url,
      link: shareLink(url),
      expiresAt: Date.now() + 365 * 86400000,
    };
    list.updatedAt = bump(list.updatedAt);
    await this.#save('lists');
    return list.shared;
  }

  async disableShare(listId) {
    const list = this.listById(listId);
    this.#shareGen.set(listId, (this.#shareGen.get(listId) || 0) + 1);
    if (!list?.shared) return;
    list.shared = null;
    list.updatedAt = bump(list.updatedAt);
    this.#deleteFile(sharePath(listId));
    await this.#save('lists');
  }

  /* Content signature of the last successful write per fs path, so a save
     that did not change a snapshot's content costs no cloud write. */
  #syncSig = new Map();

  /* Published files whose delete has not been confirmed yet. Stop-sharing,
     ending a collaboration, and turning the feed off promise the user that
     the copy is gone from their cloud — but the delete is a network call
     that can fail (offline, transient server trouble), and fire-and-forget
     left the snapshot serving at its still-valid URL forever. Queued paths
     ride in the mirror so a reload doesn't lose the intent, and are reaped
     on every share sync and dirty-flush until the file is really gone. */
  #deadFiles = new Set();

  /** Delete a published file; on failure keep it queued for the reaper. */
  #deleteFile(path) {
    this.#syncSig.delete(path);
    this.#deadFiles.add(path);
    return this.cloud.fs.delete(path)
      .then(() => { this.#deadFiles.delete(path); })
      .catch((err) => { if (isMissingFile(err)) this.#deadFiles.delete(path); });
  }

  /** A queued path whose feature has been turned back on must survive. */
  #fileIsLive(path) {
    if (path === ICS_PATH) return !!this.settings.calFeed;
    if (this.logMonths.some((k) => logPath(k) === path)) return true;
    for (const l of this.lists) {
      if (l.shared && sharePath(l.id) === path) return true;
      if (l.collab && l.collab.mode !== 'kv') {
        if (replicaPath(l.id, l.collab.memberId) === path) return true;
        if (l.collab.role === 'owner' && manifestPath(l.id) === path) return true;
      }
    }
    return false;
  }

  async #reapDeadFiles() {
    for (const path of [...this.#deadFiles]) {
      if (this.#fileIsLive(path)) {
        this.#deadFiles.delete(path);
        continue;
      }
      try {
        await this.cloud.fs.delete(path);
        this.#deadFiles.delete(path);
      } catch (err) {
        // Already gone counts as done; anything else retries next pass.
        if (isMissingFile(err)) this.#deadFiles.delete(path);
      }
    }
  }

  /* KV shares to stop, same idea as #deadFiles: 'h:<handle>' (a member's
     own share) or 'p:<prefix>' (every share of an owner's prefix, plus its
     keys). Ending a collaboration offline must still cut access later. */
  #deadShares = new Set();

  #shareIsLive(entry) {
    return this.lists.some((l) => l.collab?.mode === 'kv'
      && entry === (l.collab.role === 'owner' ? `p:${l.collab.prefix}` : `h:${l.collab.handle}`));
  }

  async #reapShare(entry) {
    const kv = this.cloud.kv;
    try {
      if (entry.startsWith('h:')) {
        await kv.unshare(entry.slice(2));
      } else {
        const prefix = entry.slice(2);
        for (const s of await this.#kvShares(prefix)) await kv.unshare(s.handle);
        for (const key of await kv.list(`${prefix}*`)) await kv.del(key);
      }
      this.#deadShares.delete(entry);
    } catch (err) {
      // A handle the server doesn't know has nothing left to stop.
      if (entry.startsWith('h:') && err?.code === 'subject_does_not_exist') this.#deadShares.delete(entry);
    }
    this.#writeMirror();
  }

  async #reapDeadShares() {
    for (const entry of [...this.#deadShares]) {
      if (this.#shareIsLive(entry)) {
        this.#deadShares.delete(entry);
        continue;
      }
      await this.#reapShare(entry);
    }
  }

  async #writeShareFile(list) {
    // Mirror what the owner sees in list detail: open tasks in their
    // manual (drag) order, completed ones newest first.
    const tasks = [
      ...this.manualTasks(list.id),
      ...this.completedTasks(list.id),
    ];
    // Signature excludes the timestamp: identical content must compare equal.
    const payload = buildSharePayload(list, tasks, { owner: this.user?.username || null, updatedAt: 0 });
    const path = sharePath(list.id);
    const sig = JSON.stringify(payload);
    if (this.#syncSig.get(path) === sig) return;
    payload.updatedAt = Date.now();
    await this.cloud.fs.write(path, JSON.stringify(payload), { createMissingParents: true });
    this.#syncSig.set(path, sig);
    this.#deadFiles.delete(path); // re-shared: an owed delete no longer applies
  }

  /** Debounced: keep published copies (snapshots, replicas, feed) current. */
  #scheduleShareSync() {
    const hasShares = this.lists.some((l) => l.shared);
    const hasCollab = this.lists.some((l) => l.collab);
    // #deadFiles: unsharing the very last list still owes its delete a
    // retry, and this debounce is what carries the reaper in-session.
    if (!hasShares && !hasCollab && !this.settings.calFeed && !this.#deadFiles.size && !this.#deadShares.size) return;
    clearTimeout(this.#shareTimer);
    this.#shareTimer = setTimeout(() => {
      this.syncShares().catch(() => {});
      this.syncCollab().catch(() => {});
    }, 1500);
  }

  async syncShares() {
    if (!navigator.onLine) return;
    await this.#reapDeadFiles();
    for (const list of this.lists.filter((l) => l.shared)) {
      await this.#writeShareFile(list).catch(() => {});
    }
    if (this.settings.calFeed) {
      const ics = this.buildCalendar();
      // DTSTAMP differs on every build; ignore it when comparing content.
      const sig = ics.replace(/^DTSTAMP:.*$/gm, '');
      if (this.#syncSig.get(ICS_PATH) !== sig) {
        await this.cloud.fs.write(ICS_PATH, ics, { createMissingParents: true })
          .then(() => {
            this.#syncSig.set(ICS_PATH, sig);
            this.#deadFiles.delete(ICS_PATH);
          })
          .catch(() => {});
      }
    }
  }

  /* ---------- collaboration (multi-writer lists) ---------- */

  /** My identity in collab manifests/replicas: the account's username. */
  async #collabIdentity() {
    if (!this.user) this.user = await this.cloud.auth.getUser();
    const name = this.user?.username;
    if (!name) throw new Error('Sign in to share lists');
    return { id: name, name };
  }

  /** Set when this deployment refuses KV shares: new collaborations use links. */
  #kvOff = false;

  /** How a new collaboration is set up: 'kv' (invite by username) or 'link'. */
  collabMode() {
    return typeof this.cloud?.kv?.share === 'function' && !this.#kvOff ? 'kv' : 'link';
  }

  /**
   * Turn on collaboration for a list I own. With KV shares this asks for
   * sharing consent (call it from a click), stores the list under its own
   * prefix and resolves { mode: 'kv' }; people are then added with
   * inviteMember. Otherwise it sets up linked replicas and resolves
   * { invite } with the invite link. Throws if consent is refused.
   */
  async enableCollab(listId) {
    const list = this.listById(listId);
    if (!list) throw new Error('No such list');
    if (list.collab) {
      return list.collab.mode === 'kv' ? { mode: 'kv' } : { invite: inviteLink(list.collab.manifestUrl) };
    }
    if (this.collabMode() === 'kv' && await this.#shareConsent()) return this.#enableKvCollab(list);
    return this.#enableLinkCollab(list);
  }

  /**
   * Consent to share `tasks:collab:` at write level (asked once; later calls
   * resolve without a prompt). False when this page can't ask (not running
   * as an app, no perms API): the caller falls back to links. Throws when
   * the user declines.
   */
  async #shareConsent() {
    const perms = this.cloud.perms;
    if (typeof perms?.request !== 'function') return false;
    let granted;
    try {
      if (perms.Resource?.KV_SHARE) {
        granted = await perms.request(perms.Resource.KV_SHARE, { prefix: KV_COLLAB_ROOT, access: 'write' });
      } else {
        // SDKs from before the kvShare resource take the permission string.
        const user = this.user?.uuid ? this.user : await this.cloud.auth.getUser();
        if (!user?.uuid || !this.cloud.appID) return false;
        granted = await perms.request('permission', {
          permission: `manage:kv-share-write:${user.uuid}:${this.cloud.appID}:${KV_COLLAB_ROOT.slice(0, -1)}`,
        });
      }
    } catch (err) {
      if (err?.code === 'invalid_argument') return false;
      throw err;
    }
    if (!granted) {
      const err = new Error('Tasks needs your permission to share lists');
      err.code = 'consent_denied';
      throw err;
    }
    return true;
  }

  async #enableKvCollab(list) {
    const me = await this.#collabIdentity();
    // A fresh prefix per collaboration, so a restarted one never inherits
    // keys or shares an earlier one left behind.
    list.collab = normalizeCollab({
      mode: 'kv', role: 'owner', prefix: kvPrefixFor(uid()), memberId: me.id, ownerName: me.id, approved: true,
    });
    try {
      await this.#syncKvList(list);
    } catch (err) {
      list.collab = null;
      throw err;
    }
    list.updatedAt = bump(list.updatedAt);
    await this.#save('lists');
    this.#watchCollab();
    return { mode: 'kv' };
  }

  /** Owner (KV): share the list at write level with a Puter username. */
  async inviteMember(listId, username) {
    const list = this.listById(listId);
    const c = list?.collab;
    if (c?.mode !== 'kv' || c.role !== 'owner') throw new Error('Only the owner can invite people');
    const name = String(username || '').trim().replace(/^@/, '');
    if (!name) throw new Error('Enter a Puter username');
    if (name.toLowerCase() === c.memberId.toLowerCase()) throw new Error('That is your own account');
    const share = (label) => this.cloud.kv.share({ prefix: c.prefix, recipient: name, access: 'write', label });
    let res;
    try {
      try {
        res = await share(shareLabel(list.name));
      } catch (err) {
        // Consent withdrawn since: ask again (this runs from the invite
        // click) and retry once. A label the server still rejects is
        // dropped; members read the name from `meta` anyway.
        if (err?.code === 'events_kv_handle_not_delegated' && await this.#shareConsent()) {
          res = await share(shareLabel(list.name));
        } else if (err?.code === 'kv_share_label_invalid') {
          res = await share(null);
        } else {
          throw err;
        }
      }
    } catch (err) {
      if (SHARING_OFF.has(err?.code)) return this.#fallBackToLinks(list);
      if (err?.code === 'consent_denied') throw err;
      const out = new Error(shareErrorMessage(err, name));
      out.code = err?.code || null;
      throw out;
    }
    return { member: { id: res.holder, name: res.holder, handle: res.handle } };
  }

  /**
   * The deployment turned KV shares off: move a collaboration nobody has
   * joined yet over to linked replicas and hand back its invite link.
   */
  async #fallBackToLinks(list) {
    this.#kvOff = true;
    const live = await this.#kvShares(list.collab.prefix).catch(() => []);
    if (live.length) throw new Error('Inviting by username is turned off right now');
    const released = this.#releaseCollab(list);
    list.collab = null;
    const { invite } = await this.#enableLinkCollab(list);
    await released;
    return { fallback: true, invite };
  }

  /** Live shares of one of my prefixes. */
  async #kvShares(prefix) {
    const out = [];
    let cursor;
    do {
      const page = await this.cloud.kv.listSharedByMe({ limit: 200, cursor });
      out.push(...(page?.items || []).filter((s) => s.prefix === prefix && !s.revokedAt && s.holder));
      cursor = page?.cursor;
    } while (cursor);
    return out;
  }

  /** Linked replicas: publish my replica and the manifest, mint the invite. */
  async #enableLinkCollab(list) {
    const me = await this.#collabIdentity();
    list.collab = { role: 'owner', memberId: me.id, manifestUrl: '', ownerName: me.id, approved: true };
    try {
      await this.#publishReplica(list);
      const replicaUrl = await this.cloud.fs.getReadURL(replicaPath(list.id, me.id), URL_TTL);
      await this.#writeManifest(list, { ...me, replicaUrl, addedAt: Date.now() }, []);
      list.collab.manifestUrl = await this.cloud.fs.getReadURL(manifestPath(list.id), URL_TTL);
    } catch (err) {
      // Nothing was saved yet; a half-built collab block left in memory
      // would render a dead invite link until the next reload.
      list.collab = null;
      throw err;
    }
    list.updatedAt = bump(list.updatedAt);
    await this.#save('lists');
    return { invite: inviteLink(list.collab.manifestUrl) };
  }

  /** Owner: stop collaborating. Members keep their copies as private lists. */
  async disableCollab(listId) {
    const list = this.listById(listId);
    if (!list?.collab) return;
    const released = this.#releaseCollab(list);
    list.pastCollab = pastCollabOf(list);
    list.collab = null;
    list.updatedAt = bump(list.updatedAt);
    await this.#save('lists');
    await released;
  }

  /**
   * Accept an invite: adopt the list locally (empty until the first sync
   * pulls the others' replicas), publish my replica, and hand back the
   * confirmation link the owner opens to approve me.
   */
  async joinCollab(manifestUrl) {
    const res = await fetch(manifestUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error('This invite is no longer available');
    const manifest = parseManifest(await res.text());
    const me = await this.#collabIdentity();
    if (manifest.owner.id === me.id) throw new Error('This is your own list');

    // A manifest is just a file at a URL anyone can send, and its listId is
    // whatever it claims. Adopting an existing local list on that word
    // alone would let anyone who knows a list's id (any former member) hand
    // the owner a link that publishes their private copy to the attacker
    // and merges the attacker's deletions back in. An existing list may
    // therefore only be (re)joined by the same group that ran it before.
    let list = this.listById(manifest.listId);
    if (list?.collab?.mode === 'kv') throw new Error('This invite does not match the list you already have');
    if (list) {
      const knownOwner = list.collab
        ? (list.collab.role === 'owner' ? list.collab.memberId : list.collab.ownerName)
        : list.pastCollab?.ownerId;
      if (!knownOwner || knownOwner !== manifest.owner.id) {
        throw new Error('This invite does not match the list you already have');
      }
      if (list.collab?.role === 'owner') throw new Error('This is your own list');
    }

    if (!list) {
      await this.#dropOutsiderTombstones(manifest.listId);
      list = normalizeList({
        id: manifest.listId,
        name: manifest.name,
        icon: manifest.icon,
        slot: manifest.slot,
        collab: {
          role: 'member', memberId: me.id, manifestUrl,
          ownerName: manifest.owner.id, approved: false, joinedAt: Date.now(),
        },
      }, this.lists.length);
      this.lists.push(list);
      await this.#save('lists');
    } else if (!list.collab) {
      // Rejoining a list kept as a private copy after a past collaboration
      // ended (owner stopped sharing, or this member was removed).
      await this.#dropOutsiderTombstones(list.id);
      list.collab = {
        role: 'member', memberId: me.id, manifestUrl,
        ownerName: manifest.owner.id, approved: false, joinedAt: Date.now(),
      };
      list.updatedAt = bump(list.updatedAt);
      await this.#save('lists');
    } else if (list.collab.manifestUrl !== manifestUrl) {
      // Already a member but invited through a fresh link: adopt it, since
      // minted URLs expire and the new one is always the longer-lived.
      list.collab = { ...list.collab, manifestUrl };
      list.updatedAt = bump(list.updatedAt);
      await this.#save('lists');
    }
    await this.#publishReplica(list);
    const replicaUrl = await this.cloud.fs.getReadURL(replicaPath(list.id, me.id), URL_TTL);
    this.syncCollab().catch(() => {});
    return {
      list,
      confirm: confirmLink({ listId: list.id, member: { ...me, replicaUrl } }),
    };
  }

  /** Member: a fresh confirmation link (e.g. the first one got lost). */
  async confirmLinkFor(listId) {
    const list = this.listById(listId);
    if (list?.collab?.role !== 'member' || list.collab.mode === 'kv') return null;
    await this.#publishReplica(list);
    const replicaUrl = await this.cloud.fs.getReadURL(replicaPath(list.id, list.collab.memberId), URL_TTL);
    return confirmLink({
      listId: list.id,
      member: { id: list.collab.memberId, name: list.collab.memberId, replicaUrl },
    });
  }

  /**
   * Member: leave the group and drop the list. Deleting it also stops my
   * share (KV) or unpublishes my replica (links).
   */
  async leaveCollab(listId) {
    const list = this.listById(listId);
    if (!list?.collab) return;
    if (list.collab.role === 'owner') return this.disableCollab(listId);
    await this.deleteList(listId);
  }

  /** Owner: current membership — the live shares of the prefix, or the manifest. */
  async collabMembers(listId) {
    const list = this.listById(listId);
    if (list?.collab?.role !== 'owner') throw new Error('Only the owner can manage members');
    if (list.collab.mode === 'kv') {
      const shares = await this.#kvShares(list.collab.prefix);
      return {
        owner: { id: list.collab.memberId, name: list.collab.memberId },
        members: shares.map((s) => ({ id: s.holder, name: s.holder, handle: s.handle })),
      };
    }
    const manifest = await this.#readOwnManifest(list);
    return { owner: manifest.owner, members: manifest.members };
  }

  /** Owner (links): approve a member from their confirmation link. */
  async approveMember(listId, member) {
    const list = this.listById(listId);
    if (list?.collab?.role !== 'owner' || list.collab.mode === 'kv') throw new Error('Only the owner can approve members');
    if (member.id === list.collab.memberId) throw new Error('You are already the owner');
    const members = await this.#withManifest(list, async (manifest) => {
      const next = manifest.members.filter((m) => m.id !== member.id);
      next.push({ ...member, addedAt: Date.now() });
      await this.#writeManifest(list, manifest.owner, next);
      return next;
    });
    this.syncCollab().catch(() => {});
    return members;
  }

  /**
   * Owner: revoke a member (a username for KV shares). Their app converts
   * the list back to a private copy.
   */
  async removeMember(listId, memberId) {
    const list = this.listById(listId);
    if (list?.collab?.role !== 'owner') throw new Error('Only the owner can remove members');
    if (list.collab.mode === 'kv') {
      for (const s of await this.#kvShares(list.collab.prefix)) {
        if (s.holder === memberId) await this.cloud.kv.unshare(s.handle);
      }
      return;
    }
    await this.#withManifest(list, (manifest) =>
      this.#writeManifest(list, manifest.owner, manifest.members.filter((m) => m.id !== memberId)));
  }

  async #readOwnManifest(list) {
    const blob = await this.cloud.fs.read(manifestPath(list.id));
    return parseManifest(typeof blob === 'string' ? blob : await blob.text());
  }

  /* One manifest read-modify-write at a time, per list. */
  #manifestQueue = new Map();

  /**
   * Run a read-modify-write cycle on a list's manifest with exclusive
   * access. Two overlapping cycles — approving a member while the
   * debounced meta sync rewrites the list's name, or two confirmation
   * links opened in quick succession — each wrote back the membership
   * they had read, silently dropping the other's change.
   */
  #withManifest(list, mutate) {
    const prev = this.#manifestQueue.get(list.id) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => mutate(await this.#readOwnManifest(list)));
    this.#manifestQueue.set(list.id, next.catch(() => {}));
    return next;
  }

  async #writeManifest(list, owner, members) {
    const manifest = buildManifest(list, owner, members);
    await this.cloud.fs.write(manifestPath(list.id), JSON.stringify(manifest), { createMissingParents: true });
    this.#deadFiles.delete(manifestPath(list.id));
  }

  /**
   * Deletions recorded outside a collaboration must not ride into the group
   * on (re)join: leaving a shared list tombstones every task in the local
   * copy, and publishing those with the fresh replica would delete the
   * whole list for everyone else. Joining means adopting the group's state.
   */
  async #dropOutsiderTombstones(listId) {
    this.deletedLists = this.deletedLists.filter((d) => d.id !== listId);
    const before = this.deletedTasks.length;
    this.deletedTasks = this.deletedTasks.filter((d) => d.listId !== listId);
    if (this.deletedTasks.length !== before) await this.#save('items');
  }

  /**
   * A tombstone scoped to a collab list but stamped before this account
   * joined it is void: it predates the membership (typically the mass
   * delete from leaving the list on some device) and must neither ship in
   * a replica nor suppress the group's tasks. The joinCollab cleanup drops
   * these locally; this guard also stops copies flowing back from another
   * of the account's devices whose sync raced the rejoin.
   */
  #voidTombstone(d) {
    if (!d || !d.listId) return false;
    const list = this.listById(String(d.listId));
    // pastCollab keeps the join time after a collaboration ends: without
    // it, a lagging device's leave-era tombstones would stop being void
    // the moment the group closed and would gut the kept private copy.
    const joined = list?.collab?.joinedAt || list?.pastCollab?.joinedAt || 0;
    return (Number(d.at) || 0) < joined;
  }

  /** Publish my replica of a collab list (skipped when content unchanged). */
  async #publishReplica(list) {
    const me = { id: list.collab.memberId, name: this.user?.username || list.collab.memberId };
    const tasks = this.tasks.filter((t) => t.listId === list.id).sort(byIdAsc);
    // Only this list's tombstones travel with its replica — shipping them
    // all would let deletions from one list (e.g. leaving it) leak into
    // every other shared list. Legacy tombstones without a listId predate
    // the stamp and still travel whole. Pre-join tombstones are void.
    const deleted = this.deletedTasks.filter((d) => (!d.listId || d.listId === list.id)
      && !this.#voidTombstone(d));
    const payload = buildReplica(list, tasks, deleted.sort(byIdAsc), me, { updatedAt: 0 });
    const path = replicaPath(list.id, me.id);
    const sig = JSON.stringify(payload);
    if (this.#syncSig.get(path) === sig) return;
    payload.updatedAt = Date.now();
    await this.cloud.fs.write(path, JSON.stringify(payload), { createMissingParents: true });
    this.#syncSig.set(path, sig);
    this.#deadFiles.delete(path); // rejoined: an owed delete no longer applies
  }

  #collabPromise = null;
  #collabAgain = false;
  #collabPollOnly = false;

  /**
   * Sync every collab list: merge with the shared prefix (KV) or pull the
   * other replicas and republish mine (links). A call during an in-flight
   * sync queues one more full pass (so a caller who just changed something
   * never gets a stale, already-running pass). `poll` skips KV lists whose
   * live subscription already delivers their changes.
   */
  async syncCollab({ poll = false } = {}) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (this.#collabPromise) {
      this.#collabAgain = true;
      this.#collabPollOnly &&= poll;
      return this.#collabPromise;
    }
    this.#collabPollOnly = poll;
    this.#collabPromise = (async () => {
      await this.#reapDeadShares();
      do {
        const pollOnly = this.#collabPollOnly;
        this.#collabAgain = false;
        this.#collabPollOnly = true;
        for (const list of this.lists.filter((l) => l.collab)) {
          if (list.collab.mode !== 'kv') {
            await this.#syncCollabList(list).catch(() => {});
          } else if (!pollOnly || !this.#watches.get(list.id)?.sub) {
            await this.#syncKvList(list).catch(() => {});
          }
        }
      } while (this.#collabAgain);
      this.#watchCollab();
    })().finally(() => { this.#collabPromise = null; });
    return this.#collabPromise;
  }

  /**
   * Merge a KV collaboration with its shared prefix, then write back what
   * the prefix lacks: changed tasks, new tombstones, the owner's meta.
   * Rejects on read/write failures; the next pass retries.
   */
  async #syncKvList(list) {
    const c = list.collab;
    const owner = c.role === 'owner';
    const kv = this.cloud.kv;
    const p = owner ? c.prefix : '';
    const withOpts = (...args) => (owner ? args : [...args, { handle: c.handle }]);
    // As in #syncCollabList: a leave, delete or merge landing mid-flight must
    // not have this pass write the list's leave-tombstones to the group.
    const detached = () => this.listById(list.id) !== list || list.collab !== c;
    const handleGone = async (err) => {
      if (owner || err?.code !== 'kv_handle_not_found' || detached()) return false;
      await this.#endCollab(list, 'The list is no longer shared with you');
      return true;
    };

    let remote;
    try {
      const entries = await kv.list(...withOpts(`${p}*`, true));
      remote = readKvEntries((entries || []).map(({ key, value }) => ({ key: String(key).slice(p.length), value })));
    } catch (err) {
      if (await handleGone(err)) return;
      throw err;
    }
    if (detached()) return;

    const writes = [];
    const dels = new Set();
    if (owner) {
      const meta = buildMeta(list, c.memberId);
      if (!sameData(remote.rawMeta, meta)) writes.push({ key: 'meta', value: meta });
    } else if (remote.meta) {
      // The owner's name/icon/color, vetted through normalizeList: any
      // member can write `meta`.
      const m = normalizeList({ ...list, name: remote.meta.name, icon: remote.meta.icon, slot: remote.meta.slot }, list.order);
      const ownerName = remote.meta.owner || c.ownerName;
      if (list.name !== m.name || list.icon !== m.icon || list.slot !== m.slot || c.ownerName !== ownerName) {
        Object.assign(list, { name: m.name, icon: m.icon, slot: m.slot });
        c.ownerName = ownerName;
        list.updatedAt = bump(list.updatedAt);
        await this.#save('lists');
        if (detached()) return;
      }
    }

    const cutoff = Date.now() - ARCHIVE_DAYS * 86400000;
    const remoteTasks = new Map();
    for (const [id, raw] of remote.tasks) {
      const t = normalizeTask({ ...raw, id, listId: list.id });
      // Old completions live in each account's logbook; clear them from the
      // prefix rather than merging them back.
      if (isArchivedCompletion(t, cutoff)) {
        dels.add(taskKey(id));
        continue;
      }
      // The prefix only speaks for this list: an id colliding with a task
      // elsewhere would collapse the two on the next full merge.
      const local = this.taskById(id);
      if (local && local.listId !== list.id) continue;
      remoteTasks.set(id, t);
    }
    const remoteDel = [];
    for (const d of remote.deleted.values()) {
      const local = this.taskById(d.id);
      if (local && local.listId !== list.id) continue;
      remoteDel.push({ ...d, listId: list.id });
    }

    const mine = this.tasks.filter((t) => t.listId === list.id);
    const localDel = this.deletedTasks.filter((d) => !this.#voidTombstone(d));
    const merged = mergeRecords(mine, [...remoteTasks.values()], localDel, remoteDel, { pruneBefore: cutoff });
    if (canon(merged.records, merged.deleted) !== canon(mine, this.deletedTasks)) {
      this.tasks = [...this.tasks.filter((t) => t.listId !== list.id), ...merged.records];
      this.deletedTasks = merged.deleted;
      await this.#save('items');
      this.dispatchEvent(new Event('remote-change'));
      if (detached()) return;
    }

    const live = new Set(merged.records.map((t) => t.id));
    for (const t of merged.records) {
      if (isArchivedCompletion(t, cutoff)) continue;
      const cur = remoteTasks.get(t.id);
      if (!cur || !sameData(cur, t)) {
        const { listId, ...wire } = t; // each account files it under its own list id
        writes.push({ key: taskKey(t.id), value: wire });
      }
    }
    const tombs = new Map(merged.deleted.filter((d) => d.listId === list.id).map((d) => [d.id, d]));
    for (const d of tombs.values()) {
      if (remote.deleted.get(d.id)?.at !== d.at) writes.push({ key: tombKey(d.id), value: { id: d.id, at: d.at } });
      if (remote.tasks.has(d.id)) dels.add(taskKey(d.id));
    }
    for (const [id, d] of remote.deleted) {
      // Past the echo window, or outlived by a newer edit.
      if (!tombs.has(id) && (live.has(id) || d.at < cutoff)) dels.add(tombKey(id));
    }

    if (detached()) return;
    try {
      for (let i = 0; i < writes.length; i += 100) {
        const batch = writes.slice(i, i + 100).map((w) => ({ key: p + w.key, value: w.value }));
        await kv.set(...withOpts(batch));
      }
      for (const key of dels) await kv.del(...withOpts(p + key));
    } catch (err) {
      if (await handleGone(err)) return;
      throw err;
    }
  }

  /* ---------- KV collaboration: discovery and live updates ---------- */

  #discoverPromise = null;
  #discoveredAt = 0;

  /**
   * Member (KV): adopt the lists other users shared with this account. Runs
   * at startup, on kv.share.received, and on focus/poll (throttled). A new
   * share becomes a local list straight away; there is nothing to accept.
   * Resolves to how many lists were added.
   */
  discoverShares({ force = false } = {}) {
    if (typeof this.cloud?.kv?.listShared !== 'function') return Promise.resolve(0);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(0);
    // A forced call mid-flight may be about a share that pass started too
    // early to see.
    if (this.#discoverPromise) {
      return force ? this.#discoverPromise.then(() => this.discoverShares({ force: true })) : this.#discoverPromise;
    }
    if (!force && Date.now() - this.#discoveredAt < DISCOVER_MIN_MS) return Promise.resolve(0);
    this.#discoveredAt = Date.now();
    this.#discoverPromise = this.#discover().finally(() => { this.#discoverPromise = null; });
    return this.#discoverPromise;
  }

  async #discover() {
    const found = [];
    let cursor;
    do {
      const page = await this.cloud.kv.listShared({ limit: 200, cursor });
      found.push(...(page?.items || []));
      cursor = page?.cursor;
    } while (cursor);
    const me = await this.#collabIdentity();
    const added = [];
    for (const s of found) {
      if (!s?.handle || s.access !== 'write') continue;
      if (s.appUid && this.cloud.appID && s.appUid !== this.cloud.appID) continue;
      if (this.#deadShares.has(`h:${s.handle}`)) continue; // left; the unshare is still owed
      if (this.lists.some((l) => l.collab?.mode === 'kv' && l.collab.handle === s.handle)) continue;
      const id = memberListId(s.handle);
      // Left on another device whose unshare hasn't landed yet: the list's
      // tombstone postdates the share.
      const tomb = this.deletedLists.find((d) => d.id === id);
      if (!this.listById(id) && tomb && tomb.at >= (Number(s.createdAt) || 0) * 1000) continue;
      let meta;
      try {
        meta = parseMeta(await this.cloud.kv.get('meta', { handle: s.handle }));
      } catch {
        continue; // revoked meanwhile, or unreachable: the next pass retries
      }
      const existing = this.listById(id);
      if (existing?.collab) continue;
      await this.#dropOutsiderTombstones(id);
      const collab = normalizeCollab({
        mode: 'kv', role: 'member', handle: s.handle, memberId: me.id,
        ownerName: meta?.owner || null, approved: true, joinedAt: Date.now(),
      });
      if (existing) {
        // The private copy an earlier end of this share left behind.
        existing.collab = collab;
        existing.updatedAt = bump(existing.updatedAt);
        added.push(existing);
      } else {
        const order = this.lists.reduce((m, l) => Math.max(m, l.order + 1), 0);
        const list = normalizeList({
          id, name: meta?.name || s.label || 'Shared list', icon: meta?.icon, slot: meta?.slot, collab,
        }, order);
        this.lists.push(list);
        added.push(list);
      }
    }
    if (!added.length) return 0;
    await this.#save('lists');
    for (const list of added) {
      this.dispatchEvent(new CustomEvent('collab-joined', {
        detail: { listId: list.id, name: list.name, owner: list.collab?.ownerName || null },
      }));
    }
    this.#watchCollab();
    this.syncCollab().catch(() => {});
    return added.length;
  }

  /** Live kv subscriptions by list id: { subject, sub, closed, failed }. */
  #watches = new Map();
  #notifWatch = false;
  #collabTimer = null;
  /** Debounce (ms) for syncs triggered by kv events. */
  collabDelay = 400;

  /**
   * Start KV collaboration in the background: subscribe to changes of
   * every KV list (owner: its prefix; member: the handle), listen for
   * kv.share.received, and look for new shares. Without the events API,
   * focus and polling keep lists in sync.
   */
  startCollabWatch() {
    this.#watchNotifications();
    this.#watchCollab();
    return this.discoverShares({ force: true }).catch(() => 0);
  }

  #watchNotifications() {
    const events = this.cloud?.events;
    if (this.#notifWatch || typeof events?.onLocal !== 'function'
      || typeof this.cloud.kv?.listShared !== 'function') return;
    this.#notifWatch = true;
    events.onLocal('notif:app-user', ({ event }) => {
      const type = event?.type || event?.notification?.type;
      if (type === 'kv.share.received') this.discoverShares({ force: true }).catch(() => {});
    }).catch(() => { this.#notifWatch = false; });
  }

  #watchCollab() {
    const events = this.cloud?.events;
    if (typeof events?.onLocal !== 'function') return;
    const wanted = new Map();
    for (const l of this.lists) {
      const c = l.collab;
      if (c?.mode !== 'kv' || (c.role === 'owner' && !this.cloud.appID)) continue;
      wanted.set(l.id, c.role === 'owner' ? `kv:${this.cloud.appID}:${c.prefix}*` : `kv:${c.handle}:*`);
    }
    for (const [id, w] of this.#watches) {
      if (wanted.get(id) !== w.subject) this.#unwatch(id);
    }
    for (const [id, subject] of wanted) {
      if (this.#watches.has(id)) continue;
      const w = { subject, sub: null, closed: false, failed: false };
      this.#watches.set(id, w);
      const onEvent = ({ event }) => {
        // My own writes are applied already; a gap means re-read.
        if (event?.op !== 'gap' && event?.self && !event?.viaWorker) return;
        clearTimeout(this.#collabTimer);
        this.#collabTimer = setTimeout(() => this.syncCollab().catch(() => {}), this.collabDelay);
      };
      // A failed subscribe stays recorded so it isn't retried every pass;
      // polling covers that list.
      events.onLocal(subject, onEvent, {
        onError: () => { w.sub = null; w.failed = true; },
      }).then((sub) => {
        if (w.closed) Promise.resolve(sub?.off?.()).catch(() => {});
        else w.sub = sub;
      }, () => { w.failed = true; });
    }
  }

  #unwatch(id) {
    const w = this.#watches.get(id);
    if (!w) return;
    this.#watches.delete(id);
    w.closed = true;
    if (w.sub) Promise.resolve(w.sub.off?.()).catch(() => {});
  }

  async #syncCollabList(list) {
    const me = list.collab.memberId;
    // The user can leave (or delete, import over, wipe) this list while one
    // of the fetches below is on the wire. The leave tombstones every task
    // in the local copy and unpublishes the replica — resuming here as if
    // nothing happened would publish those tombstones in a fresh replica,
    // and the group's next merge would delete the whole list for everyone.
    // Object identity (not just id) also covers a merge replacing the list.
    const detached = () => this.listById(list.id) !== list || !list.collab;

    let manifest;
    try {
      if (list.collab.role === 'owner') {
        manifest = await this.#readOwnManifest(list);
      } else {
        const res = await fetch(list.collab.manifestUrl, { cache: 'no-store' });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          err.gone = res.status === 404 || res.status === 410;
          throw err;
        }
        manifest = parseManifest(await res.text());
      }
    } catch (err) {
      // The owner stopped sharing: keep the tasks as a private copy.
      if (!detached() && list.collab.role === 'member' && err?.gone) {
        await this.#endCollab(list, 'The owner stopped sharing');
      }
      return;
    }
    if (detached()) return;

    if (list.collab.role === 'owner') {
      // The manifest mirrors the list's name/icon/color for members. Read
      // the membership again under the lock: an approval that landed since
      // the read above must not be rewritten away by this meta refresh.
      if (manifest.name !== list.name || manifest.icon !== list.icon || manifest.slot !== list.slot) {
        manifest = await this.#withManifest(list, async (fresh) => {
          await this.#writeManifest(list, fresh.owner, fresh.members);
          return fresh;
        });
      }
    } else {
      // The owner controls the list's meta; adopt their changes — through
      // normalizeList, because the manifest is another account's file and
      // an unvetted icon/slot would be stored and rendered everywhere.
      const meta = normalizeList({ ...list, name: manifest.name, icon: manifest.icon, slot: manifest.slot }, list.order);
      if (list.name !== meta.name || list.icon !== meta.icon || list.slot !== meta.slot) {
        Object.assign(list, { name: meta.name, icon: meta.icon, slot: meta.slot });
        list.updatedAt = bump(list.updatedAt);
        await this.#save('lists');
      }
      const inManifest = participantsOf(manifest).some((p) => p.id === me);
      if (inManifest && !list.collab.approved) {
        list.collab = { ...list.collab, approved: true };
        list.updatedAt = bump(list.updatedAt);
        await this.#save('lists');
      } else if (!inManifest && list.collab.approved) {
        // Approved before, gone now: revoked.
        await this.#endCollab(list, 'Your access was removed');
        return;
      }
    }

    // Pull the other participants' replicas and merge them in.
    if (detached()) return; // left/removed during the meta writes above
    const others = participantsOf(manifest).filter((p) => p.id !== me);
    const remoteTasks = [];
    const remoteDel = [];
    for (const p of others) {
      try {
        const res = await fetch(p.replicaUrl, { cache: 'no-store' });
        if (!res.ok) continue;
        const rep = parseReplica(await res.text(), list.id);
        // Completions past the archive window live in each member's own
        // logbook; merging them back would bounce until everyone archives.
        const cutoff = Date.now() - ARCHIVE_DAYS * 86400000;
        for (const t of rep.tasks) {
          if (!t || !t.id) continue;
          if (isArchivedCompletion(t, cutoff)) continue;
          // A replica only speaks for its own list: an id colliding with a
          // task elsewhere would collapse the two on the next full merge.
          const local = this.taskById(String(t.id));
          if (local && local.listId !== list.id) continue;
          remoteTasks.push(normalizeTask({ ...t, listId: list.id }));
        }
        for (const d of rep.deleted) {
          // Scope incoming tombstones the way #publishReplica scopes
          // outgoing ones — a replica must not delete tasks outside its
          // list. Unstamped (legacy) tombstones pass unless they contradict
          // a local task's list.
          if (!d || !d.id) continue;
          if (d.listId && d.listId !== list.id) continue;
          if (!d.listId) {
            const local = this.taskById(String(d.id));
            if (local && local.listId !== list.id) continue;
          }
          if (this.#voidTombstone(d)) continue;
          remoteDel.push(d);
        }
      } catch { /* member offline or gone; next sync retries */ }
    }

    if (detached()) return; // left/removed while the replicas were fetched

    if (others.length) {
      const mine = this.tasks.filter((t) => t.listId === list.id);
      const localDel = this.deletedTasks.filter((d) => !this.#voidTombstone(d));
      const merged = mergeRecords(mine, remoteTasks, localDel, remoteDel, {
        pruneBefore: Date.now() - ARCHIVE_DAYS * 86400000,
      });
      if (canon(merged.records, merged.deleted) !== canon(mine, this.deletedTasks)) {
        this.tasks = [...this.tasks.filter((t) => t.listId !== list.id), ...merged.records];
        this.deletedTasks = merged.deleted;
        await this.#save('items');
        this.dispatchEvent(new Event('remote-change'));
      }
    }

    if (detached()) return; // left/removed while the merge was saving
    await this.#publishReplica(list).catch(() => {});
  }

  /** Collaboration over: keep the data, stop the syncing, tell the UI. */
  async #endCollab(list, reason) {
    // Release first — it needs list.collab, and leaving the replica behind
    // would keep a full snapshot of the list readable at a still-valid URL
    // after access ended.
    const released = this.#releaseCollab(list);
    list.pastCollab = pastCollabOf(list);
    list.collab = null;
    list.updatedAt = bump(list.updatedAt);
    await this.#save('lists');
    await released;
    this.dispatchEvent(new CustomEvent('collab-ended', {
      detail: { listId: list.id, name: list.name, reason },
    }));
  }

  /* ---------- calendar ---------- */

  buildCalendar() {
    const dated = this.tasks.filter((t) => t.due && !t.done);
    return buildICS(dated, {
      calName: 'Tasks',
      listNameOf: (t) => this.listById(t.listId)?.name || null,
    });
  }

  /** A live .ics URL that calendar apps can subscribe to. */
  async enableCalendarFeed() {
    await this.cloud.fs.write(ICS_PATH, this.buildCalendar(), { createMissingParents: true });
    this.#deadFiles.delete(ICS_PATH); // re-enabled: an owed delete no longer applies
    const url = await this.cloud.fs.getReadURL(ICS_PATH, URL_TTL);
    await this.updateSettings({ calFeed: { url, expiresAt: Date.now() + 365 * 86400000 } });
    return url;
  }

  async disableCalendarFeed() {
    // Clear the setting first: #fileIsLive reads it, and the reaper must
    // not see a queued path that still looks live.
    this.settings.calFeed = null;
    this.#deleteFile(ICS_PATH);
    await this.#save('settings');
  }

  /* ---------- import / export / wipe ---------- */

  exportAll() {
    return {
      kind: 'tasks.export',
      v: 1,
      exportedAt: Date.now(),
      // Whose cloud the published copies in here belong to (share URLs,
      // collab membership, the calendar feed). Importing into a different
      // account must not adopt any of it — see #dropForeignPublications.
      account: this.user?.username || null,
      settings: this.settings,
      lists: this.lists,
      items: { tasks: this.tasks, logMonths: this.logMonths },
    };
  }

  /**
   * Strip publication state that belongs to another account.
   *
   * Share URLs, collab membership and the calendar feed all name files in
   * the *publisher's* drive, so an export carries them out of the account
   * that can act on them. Importing someone else's file kept them intact:
   * a member's export left the importing account fetching and merging that
   * group's replicas forever under the exporter's identity — receiving
   * every later edit of a list nobody invited them to — while a foreign
   * share URL was presented as this account's own live link and a foreign
   * feed URL as its own subscription. The tasks are the user's to keep;
   * the publications are not theirs to inherit.
   */
  #dropForeignPublications(data) {
    const me = this.user?.username || null;
    if (!me) return; // identity unknown (offline import): can't tell, keep
    const otherAccount = !!data.account && data.account !== me;
    for (const list of this.lists) {
      // A collab block always names the account it belongs to, so it gives
      // a foreign list away even in exports predating `account`.
      if (!otherAccount && !(list.collab && list.collab.memberId !== me)) continue;
      list.collab = null;
      list.pastCollab = null;
      list.shared = null;
    }
    if (otherAccount && data.settings?.calFeed) this.settings.calFeed = null;
  }

  async importAll(data) {
    // Import replaces the whole dataset (and mints a new epoch, so every
    // device adopts it) — picking the wrong file must fail loudly, never
    // wipe. Accept only declared exports, or files that at least carry a
    // recognizable payload (exports from before `kind` existed).
    const isExport = data?.kind === 'tasks.export';
    const legacyShape = !data?.kind && (Array.isArray(data?.lists)
      || Array.isArray(data?.tasks) || Array.isArray(data?.items?.tasks));
    if (!isExport && !legacyShape) throw new Error('Not a Tasks export');
    // Imports replace the dataset: share snapshots of lists that are not in
    // the incoming data would otherwise stay published forever.
    const incoming = new Set((data.lists || []).map((l) => l.id));
    for (const list of this.lists.filter((l) => !incoming.has(l.id))) {
      if (list.shared) this.#deleteFile(sharePath(list.id));
      this.#releaseCollab(list);
    }
    this.#syncSig.clear();
    this.#adopt(
      { ...this.settings, ...(data.settings || {}) },
      data.lists || [],
      data.items || { tasks: data.tasks || [], logMonths: [] },
    );
    this.#dropForeignPublications(data);
    // A replaced dataset is a new epoch: other devices adopt it wholesale
    // instead of merging their old tasks back in.
    this.epoch = uid();
    this.epochAt = Date.now();
    if (!this.settings.calFeed) this.#deleteFile(ICS_PATH);
    await this.#saveAll('settings', 'lists', 'items');
    // Snapshots for lists that survived the import refresh to the new data.
    this.syncShares().catch(() => {});
    this.syncCollab().catch(() => {});
  }

  /** Remove everything (used to leave sample-data mode). */
  async wipeAll() {
    // Cleanup of every file this account ever wrote; otherwise share links
    // and the calendar feed keep serving stale data forever. Failures stay
    // queued (#deadFiles) and are retried until the files are really gone.
    for (const list of this.lists) {
      if (list.shared) this.#deleteFile(sharePath(list.id));
      this.#releaseCollab(list);
    }
    const oldMonths = this.logMonths;
    if (this.settings.calFeed) this.#deleteFile(ICS_PATH);
    this.#syncSig.clear();
    this.settings = { ...DEFAULT_SETTINGS, theme: this.settings.theme, onboarded: false };
    this.lists = [];
    this.tasks = [];
    this.logMonths = [];
    // After the state reset, so #fileIsLive no longer counts these months.
    for (const key of oldMonths) this.#deleteFile(logPath(key));
    this.deletedTasks = [];
    this.deletedLists = [];
    this.epoch = uid();
    this.epochAt = Date.now();
    await this.#saveAll('settings', 'lists', 'items');
  }
}

/**
 * Drop this device's local copy and the identity it belongs to — used on
 * sign-out, so nothing of one account is left for the next one to adopt.
 */
export function clearDeviceCache() {
  try {
    localStorage.removeItem(MIRROR_KEY);
    localStorage.removeItem(ACCOUNT_KEY);
  } catch { /* best-effort */ }
}

export const store = new Store();
export { KV as KV_KEYS, DATA_DIR, sharePath, logPath, ICS_PATH };
