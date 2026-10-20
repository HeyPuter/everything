/**
 * Per-message flags: read/unread and starred, plus where a message came from
 * before it was archived or deleted.
 *
 * Flags belong to the account, not to a browser. They are kept in two places
 * at once: a synchronous local cache the list renders from immediately, and
 * the account store (`puter.kv`, injected as `remote`) which is read and
 * written in the background. Nothing here awaits the network on the way to
 * the screen -- a flag is a display detail and must never delay the list.
 *
 * Both are the same shape: an id mapped to *when* it was last changed, as
 * whole seconds, positive when the flag is on and negative when it was turned
 * off. Keeping the "off" side is what makes "mark as unread" survive a merge
 * with a device that still thinks the message is read; last write wins per
 * id, so two devices reading different mail merge to both being read.
 */

const CAP = 5000;   // ids kept, newest change first
const PUSH_MS = 1500; // batch a burst of changes into one account write

/**
 * Flags are keyed by the uuid v7 part of the filename, not the whole name.
 * The uuid is already unique per message, and dropping the base64 subject
 * makes the payload about a third of the size -- which matters when the whole
 * set has to fit in a single key-value entry.
 */
export const flagId = (name = '') => {
  const sep = String(name).indexOf('--');
  return sep === -1 ? String(name) : String(name).slice(0, sep);
};

const clean = (value) => {
  // An array is the shape this store used before flags were synced: a plain
  // list of ids that were read or starred. Read them as very old changes, so
  // anything either device has done since wins.
  if (Array.isArray(value)) {
    return Object.fromEntries(value.filter((id) => typeof id === 'string' && id).map((id) => [flagId(id), 1]));
  }
  if (!value || typeof value !== 'object') return {};
  const entries = {};
  for (const [id, stamp] of Object.entries(value)) {
    if (id && Number.isFinite(stamp) && stamp !== 0) entries[id] = stamp;
  }
  return entries;
};

const capped = (entries) => {
  const ids = Object.keys(entries);
  if (ids.length <= CAP) return entries;
  // Oldest change first out. Sorting by when it changed keeps what the user
  // touched most recently, which is a better guess than insertion order. A
  // burst of changes shares one stamp, and among those the later change -- the
  // later key, since a change moves its id to the end -- is the one kept.
  const order = new Map(ids.map((id, at) => [id, at]));
  const kept = new Set([...ids]
    .sort((a, b) => Math.abs(entries[b]) - Math.abs(entries[a]) || order.get(b) - order.get(a))
    .slice(0, CAP));
  // Written back in the order the changes were made, which is what the next
  // trim reads as the order they were made in.
  return Object.fromEntries(ids.filter((id) => kept.has(id)).map((id) => [id, entries[id]]));
};

/**
 * Merge two flag sets. Per id the more recent change wins; a tie keeps the
 * flag on, so two devices that disagree in the same second never lose a star.
 * Pure, because two devices marking different messages read is the normal
 * case rather than an edge case.
 */
export const mergeFlags = (mine = {}, theirs = {}) => {
  const merged = { ...clean(mine) };
  for (const [id, stamp] of Object.entries(clean(theirs))) {
    const current = merged[id];
    if (current === undefined || Math.abs(stamp) > Math.abs(current)
      || (Math.abs(stamp) === Math.abs(current) && stamp > current)) {
      merged[id] = stamp;
    }
  }
  return capped(merged);
};

const same = (a, b) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/**
 * One flag set: local cache in front, account store behind.
 * `remote` is `{ get(key), set(key, value) }` over JSON strings, or null when
 * there is no account store to talk to (a Puter without kv, or the tests).
 */
function createFlagStore({ key, storage, remote = null, onChange = null }) {
  const readLocal = () => {
    try {
      return clean(JSON.parse(storage.getItem(key) || '{}'));
    } catch {
      return {};
    }
  };

  let entries = readLocal();
  let size = Object.keys(entries).length;
  let pushTimer = null;
  let writeQueued = false;

  /**
   * Monotonic stamps: two changes to the same id in the same second must
   * still be ordered, or a merge could resurrect the older one. The clock
   * never falls behind a stamp already held, either: a store reopened after a
   * change stamped ahead of the wall clock (another device's, or a flag
   * toggled twice in a second) must not stamp the next change *behind* it --
   * at the cap that made the message just opened the oldest change in the
   * set, and the one dropped from it.
   *
   * Only the id changed again moves the clock past a stamp: a burst over many
   * ids shares one. Advancing it once per flag put "mark all as read" over
   * 3,000 messages fifty minutes into the future, and every change another
   * device made in those fifty minutes lost the merge to it -- a message
   * marked unread there ten minutes later came back read.
   */
  let clock = 0;
  const catchUp = () => {
    for (const id in entries) {
      const held = Math.abs(entries[id]);
      if (held > clock) clock = held;
    }
  };
  catchUp();
  const stamp = (id) => {
    clock = Math.max(Math.floor(Date.now() / 1000), clock, Math.abs(entries[id] ?? 0) + 1);
    return clock;
  };

  const persist = () => {
    writeQueued = false;
    // Trimmed as it is written rather than as it is changed: sorting the whole
    // set once per burst, not once per flag.
    if (size > CAP) {
      entries = capped(entries);
      size = CAP;
    }
    try {
      storage.setItem(key, JSON.stringify(entries));
    } catch {
      // Quota or private mode: flags degrade, mail still reads fine.
    }
  };

  /**
   * One write per burst of changes rather than one per flag. Serialising the
   * whole set is the cost of a change -- a quarter of a megabyte at the cap --
   * and "mark all as read" over a folder, or a conversation of twelve opening,
   * paid it once per message: three hundred flags was two seconds with the
   * page frozen. A microtask runs before the event loop moves on, so the write
   * has landed before any later event -- pagehide included -- can run, and a
   * second store opened over the same storage afterwards reads it.
   */
  const scheduleWrite = () => {
    if (writeQueued) return;
    writeQueued = true;
    queueMicrotask(persist);
  };

  /**
   * One at a time. Two at once could land in either order, and a pull whose
   * write-back was slow on the wire landed after a push that already held a
   * newer change, and wrote over it: the change never reached the account
   * store, and nothing pushed it again. A call made while one is waiting to
   * start joins that one rather than queueing another round trip.
   */
  let tail = Promise.resolve();
  let waiting = null;
  const reconcile = ({ write }) => {
    if (waiting) {
      waiting.write ||= write;
      return waiting.run;
    }
    const next = { write };
    next.run = tail.then(() => {
      if (waiting === next) waiting = null;
      return reconcileOnce(next);
    });
    waiting = next;
    tail = next.run;
    return next.run;
  };

  const reconcileOnce = async ({ write }) => {
    if (!remote) return false;
    try {
      const incoming = clean(JSON.parse((await remote.get(key)) || '{}'));
      const merged = mergeFlags(entries, incoming);
      const localChanged = !same(merged, entries);
      entries = merged;
      size = Object.keys(entries).length;
      catchUp();
      if (localChanged) {
        persist();
        onChange?.();
      }
      if (write || !same(merged, incoming)) await remote.set(key, JSON.stringify(merged));
      return localChanged;
    } catch {
      // No account store, offline, or a refused write: the local flags stand.
      return false;
    }
  };

  const schedulePush = () => {
    if (!remote) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => reconcile({ write: true }), PUSH_MS);
  };

  return {
    has: (name) => (entries[flagId(name)] ?? 0) > 0,

    set(name, on) {
      const id = flagId(name);
      if (!id) return;
      const at = stamp(id);
      // To the end of the key order, which is the order changes were made in.
      if (id in entries) delete entries[id];
      else size++;
      entries[id] = on ? at : -at;
      scheduleWrite();
      schedulePush();
    },

    /** Read the account store and merge. Resolves to whether anything changed. */
    pull: () => reconcile({ write: false }),
  };
}

export function createReadState(scope, storage = window.localStorage, options = {}) {
  const store = createFlagStore({ key: `puter-mail:read:${scope}`, storage, ...options });
  return {
    isRead: (name) => store.has(name),
    markRead: (name) => store.set(name, true),
    markUnread: (name) => store.set(name, false),
    unreadCount: (candidates) => candidates.reduce((n, id) => n + (store.has(id) ? 0 : 1), 0),
    pull: store.pull,
  };
}

export function createStarState(scope, storage = window.localStorage, options = {}) {
  const store = createFlagStore({ key: `puter-mail:star:${scope}`, storage, ...options });
  return {
    isStarred: (name) => store.has(name),
    /** Returns the new starred state. */
    toggle(name) {
      const next = !store.has(name);
      store.set(name, next);
      return next;
    },
    // A conversation's star is the star of the messages in it, so the caller
    // needs to be able to say which way rather than only "the other way": one
    // click has to clear a star that could be on any of five messages.
    set: (name, on) => store.set(name, Boolean(on)),
    pull: store.pull,
  };
}

/**
 * Where a message was before it was archived or deleted, so restoring puts it
 * back where it came from rather than always in the inbox. Local only: it
 * describes a move this device made a moment ago, and it is cleared as soon
 * as the message is restored.
 */
// Origin writes waiting for their timer, by storage and key, so a store opened
// over the same storage before the timer fires reads them -- and a write left
// behind by an old store cannot later land over a newer one's.
const pendingOrigins = new WeakMap();
const ORIGIN_WRITE_MS = 250;

export function createOriginState(scope, storage = window.localStorage) {
  const key = `puter-mail:origin:${scope}`;
  pendingOrigins.get(storage)?.get(key)?.();
  const load = () => {
    try {
      const value = JSON.parse(storage.getItem(key) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  };

  let origins = load();
  let timer = null;

  const write = () => {
    clearTimeout(timer);
    timer = null;
    pendingOrigins.get(storage)?.delete(key);
    // Entries only matter until the message is restored or purged, so the cap
    // drops the oldest rather than growing without bound.
    const names = Object.keys(origins);
    if (names.length > CAP) {
      origins = Object.fromEntries(names.slice(names.length - CAP).map((n) => [n, origins[n]]));
    }
    try {
      storage.setItem(key, JSON.stringify(origins));
    } catch {}
  };

  // A bulk move records one origin per message as each move lands, each in a
  // task of its own, and serialising the whole set every time was most of the
  // CPU of archiving a folder: 17 of 21 seconds for ten thousand messages.
  // One write per burst instead.
  const persist = () => {
    if (timer) return;
    timer = setTimeout(write, ORIGIN_WRITE_MS);
    if (!pendingOrigins.has(storage)) pendingOrigins.set(storage, new Map());
    pendingOrigins.get(storage).set(key, write);
  };

  return {
    /** The box this message came from, or 'inbox' when nothing was recorded. */
    get: (id) => origins[id] ?? 'inbox',
    set(id, box) {
      if (!id || origins[id] === box) return;
      origins[id] = box;
      persist();
    },
    clear(id) {
      if (!(id in origins)) return;
      delete origins[id];
      persist();
    },
    /** Write anything still waiting for its timer. */
    flush() {
      if (timer) write();
    },
  };
}

/**
 * Senders whose remote images the user has chosen to always show. Per sender
 * rather than globally, because "I trust this newsletter" is not "load every
 * tracking pixel that ever arrives".
 */
export function createImageState(scope, storage = window.localStorage) {
  const key = `puter-mail:images:${scope}`;
  const load = () => {
    try {
      const value = JSON.parse(storage.getItem(key) || '{}');
      // Sender headers are untrusted keys. Inherited Object properties are
      // never consent, including a malformed address such as <constructor>.
      return Object.assign(Object.create(null),
        value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    } catch {
      return Object.create(null);
    }
  };

  let senders = load();
  const id = (sender = '') => String(sender).trim().toLowerCase();

  return {
    allows: (sender) => Boolean(senders[id(sender)]),
    allow(sender) {
      const key = id(sender);
      if (!key || senders[key]) return;
      senders[key] = 1;
      const names = Object.keys(senders);
      if (names.length > 500) {
        senders = Object.assign(Object.create(null),
          Object.fromEntries(names.slice(names.length - 500).map((n) => [n, 1])));
      }
      try {
        storage.setItem(`puter-mail:images:${scope}`, JSON.stringify(senders));
      } catch {}
    },
  };
}

/** Map-backed storage for the tests. */
export function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}
