// Every Puter SDK call goes through this module so the rest of the app works
// the same with or without Puter (signed out, offline, or in tests).

let sdk = null;

/**
 * Waits briefly for the SDK script (loaded with defer) and returns it or null.
 * Stops at once when the script failed to load (offline, or blocked), which
 * index.html records in window.__puterFailed.
 */
export async function loadPuter(timeoutMs = 5000) {
  if (sdk) return sdk;
  const start = Date.now();
  const waiting = () => !window.puter && !window.__puterFailed && Date.now() - start < timeoutMs;
  while (typeof window !== 'undefined' && waiting()) {
    await new Promise((r) => setTimeout(r, 50));
  }
  sdk = typeof window !== 'undefined' && window.puter ? window.puter : null;
  return sdk;
}

export const puter = () => sdk;
export function setPuterForTests(p) { sdk = p; }

/** 'app' inside the Puter desktop, 'web' on a normal website, or 'none'. */
export function env() {
  return sdk?.env || 'none';
}

export function isSignedIn() {
  try { return !!sdk?.auth?.isSignedIn?.(); } catch { return false; }
}

/** Cloud storage is available when running as a Puter app or signed in. */
export const cloudAvailable = () => !!sdk?.fs && (env() === 'app' || isSignedIn());

const pictureCache = new Map();

export async function getUser() {
  if (!sdk) return null;
  try { return await sdk.auth.getUser(); } catch { return null; }
}

/** Profile picture as a data URL, or null. Cached briefly in memory only. */
export async function getProfilePicture() {
  if (!sdk?.auth?.getProfilePicture) return null;
  const hit = pictureCache.get('me');
  if (hit && Date.now() - hit.at < (hit.value ? 300_000 : 60_000)) return hit.value;
  let value = null;
  try {
    const pic = await sdk.auth.getProfilePicture();
    value = typeof pic === 'string' && pic.startsWith('data:image/') ? pic : null;
  } catch { value = null; }
  pictureCache.set('me', { value, at: Date.now() });
  return value;
}

export async function signIn() {
  if (!sdk) throw new Error('Puter is not available');
  const res = await sdk.auth.signIn();
  pictureCache.clear();
  return res;
}

export async function signOut() {
  if (!sdk) return;
  pictureCache.clear();
  await sdk.auth.signOut();
}

/** True when an error from puter.fs means the path does not exist. */
export function isMissing(err) {
  const code = err?.code || err?.error?.code || err?.message || '';
  // NotFoundError: the browser's own file storage (OPFS) has no such file.
  if (err?.name === 'NotFoundError') return true;
  return /subject_does_not_exist|not_found|does not exist|404/i.test(String(code)) || err?.status === 404;
}

/** Puter timestamps are Unix seconds; normalise to milliseconds. */
export const toMs = (t) => (!t ? 0 : t < 1e12 ? t * 1000 : t);

// Settings live in one small KV entry (a single item read on load and written
// on change), never in a per-setting key, to keep reads and writes minimal.
export const KV_SETTINGS_KEY = 'circuits:settings:v1';

export async function kvGet(key) {
  if (!sdk?.kv || !cloudAvailable()) return undefined;
  try { return await sdk.kv.get(key); } catch { return undefined; }
}

export async function kvSet(key, value) {
  if (!sdk?.kv || !cloudAvailable()) return false;
  try { await sdk.kv.set(key, value); return true; } catch { return false; }
}
