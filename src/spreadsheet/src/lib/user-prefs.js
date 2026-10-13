/**
 * Preferences that belong to the person, not to a spreadsheet (AutoCorrect's lists, the custom dictionary):
 * kept in this browser under the signed-in account's scope, so each account on a shared browser has its own,
 * and copied to puter.kv where there is a session, so they follow the account to another device.
 *
 * Reading is synchronous, from this browser; syncPref brings in the account's copy when it is newer.
 */
import { accountStorageKey } from './account-storage.js';
import { kvGet, kvSet } from './puter.js';

/** The account's store is there: the SDK is loaded with its key-value store, and someone is signed in. */
const canUseKv = () => {
  const p = globalThis.puter;
  try { return typeof p?.kv?.get === 'function' && p?.auth?.isSignedIn?.() !== false; } catch { return false; }
};

const storage = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const localKey = (name) => `${accountStorageKey(`spreadsheet:pref-${name}`)}value`;
const kvKey = (name) => `spreadsheet:pref:${name}`;

/** The stored value ({ at, value } on disk), or `fallback`. */
export function loadPref(name, fallback = null) {
  try {
    const raw = JSON.parse(storage()?.getItem(localKey(name)) || 'null');
    return raw && typeof raw === 'object' && 'value' in raw ? raw.value : fallback;
  } catch { return fallback; }
}

/** Keep `value` here and, best effort, in the account's store. */
export function savePref(name, value) {
  const record = { at: Date.now(), value };
  try { storage()?.setItem(localKey(name), JSON.stringify(record)); } catch { /* storage unavailable */ }
  if (canUseKv()) kvSet(kvKey(name), JSON.stringify(record));
  return value;
}

/** Take the account's copy when it is newer than this browser's; resolves to the value in force. */
export async function syncPref(name, fallback = null) {
  if (!canUseKv()) return loadPref(name, fallback);
  let remote = null;
  try { const raw = await kvGet(kvKey(name)); remote = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { remote = null; }
  let local = null;
  try { local = JSON.parse(storage()?.getItem(localKey(name)) || 'null'); } catch { local = null; }
  if (remote && typeof remote === 'object' && 'value' in remote && (!local || (remote.at || 0) > (local.at || 0))) {
    try { storage()?.setItem(localKey(name), JSON.stringify(remote)); } catch { /* storage unavailable */ }
    return remote.value;
  }
  return local && 'value' in local ? local.value : fallback;
}
