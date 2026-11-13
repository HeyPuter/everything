// Per-tab autosave slots, so two open tabs never overwrite each other's
// session draft.
//
// Each tab keeps a slot id in sessionStorage (it survives a reload of that
// tab) and holds a Web Lock named after it for as long as the tab is open, so
// any tab can tell which drafts belong to a live tab. A duplicated tab copies
// sessionStorage, finds the lock taken and picks a fresh slot. Without the
// Web Locks API every tab shares one slot, which is the old behaviour.
//
//   const tabs = await claimTab();
//   tabs.key                    draft key for this tab ('tab:<slot>' or 'session')
//   await tabs.liveKeys()       draft keys owned by open tabs (this one included)
//   pickDraft(entries, { own, live, now }) chooses which draft a starting tab restores

import { uid } from '../lib/util.js';

const SLOT_KEY = 'music-studio:tab';
const LOCK_PREFIX = 'music-studio-tab-';
const RECOVERY_LOCK = 'music-studio-recovery';
export const LEGACY_KEY = 'session';
/** Unowned drafts older than this are deleted at startup. */
export const STALE_MS = 30 * 24 * 3600 * 1000;
/** At most this many unowned drafts are kept. */
export const KEEP_UNOWNED = 5;

const keyFor = (slot) => `tab:${slot}`;

/** Takes the lock for `slot` if no other tab holds it; resolves true when held. */
function tryLock(locks, slot) {
  return new Promise((resolve) => {
    locks
      .request(`${LOCK_PREFIX}${slot}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        // Held until the tab closes.
        return new Promise(() => {});
      })
      .catch(() => resolve(false));
  });
}

export async function claimTab({ locks = globalThis.navigator?.locks, session = safeSession() } = {}) {
  if (!locks?.request || !locks?.query) {
    return { key: LEGACY_KEY, liveKeys: async () => new Set([LEGACY_KEY]), shared: true };
  }
  // Claiming a reload slot must not race another tab adopting its old draft.
  return withRecovery(locks, async () => {
    let slot = session?.getItem(SLOT_KEY) || uid(10);
    for (let i = 0; i < 4 && !(await tryLock(locks, slot)); i++) slot = uid(10);
    try {
      session?.setItem(SLOT_KEY, slot);
    } catch {
      // Blocked storage: this tab gets a new slot after a reload.
    }
    return {
      key: keyFor(slot),
      shared: false,
      withRecovery: (action) => withRecovery(locks, action),
      async liveKeys() {
        try {
          const { held = [] } = await locks.query();
          return new Set(held.filter((l) => l.name?.startsWith(LOCK_PREFIX)).map((l) => keyFor(l.name.slice(LOCK_PREFIX.length))));
        } catch {
          // Unknown ownership must not be treated as proof that other tabs closed.
          return null;
        }
      },
    };
  });
}

// Serialize selection, transfer and cleanup; a failed lock request permits only
// recovery of the caller's own draft. Never rerun an action that itself failed.
async function withRecovery(locks, action) {
  let entered = false;
  try {
    return await locks.request(RECOVERY_LOCK, {}, () => {
      entered = true;
      return action(true);
    });
  } catch (err) {
    if (entered) throw err;
    return action(false);
  }
}

function safeSession() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

/**
 * Which draft a starting tab restores, and which drafts to delete.
 * entries: [[key, { at, ... }], ...]; own: this tab's key; live: keys of open tabs.
 * Returns { key, draft, busy, remove }: the tab's own draft (a reload) first,
 * else the newest draft no open tab owns. `busy` is true when drafts exist but
 * all belong to other open tabs (the tab then starts a new project).
 * A null `live` means inspection failed: restore only our own draft, without cleanup.
 */
export function pickDraft(entries, { own, live, now = Date.now() }) {
  const drafts = entries.filter(([, v]) => v && typeof v === 'object');
  const mine = drafts.find(([k]) => k === own);
  if (live === null) return { key: mine ? own : null, draft: mine?.[1] || null, busy: false, remove: [] };
  const unowned = drafts.filter(([k]) => k !== own && !live.has(k)).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const remove = unowned.filter(([, v], i) => i >= KEEP_UNOWNED || now - (v.at || 0) > STALE_MS).map(([k]) => k);
  if (mine) return { key: own, draft: mine[1], busy: false, remove };
  const pick = unowned.find(([k]) => !remove.includes(k));
  if (pick) return { key: pick[0], draft: pick[1], busy: false, remove };
  const others = drafts.some(([k]) => k !== own && live.has(k));
  return { key: null, draft: null, busy: others, remove };
}
