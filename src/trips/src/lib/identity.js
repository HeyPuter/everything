// The last signed-in identity on this device, so the shell can boot offline. It is used only while the SDK still
// holds the same auth token (compared by hash; the token itself is never stored).
const KEY = 'trips:identity';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function tokenHash(token) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
const storageOf = (storage) => { try { return storage ?? globalThis.localStorage ?? null; } catch { return null; } };

export async function rememberIdentity({ uuid, username }, token, storage) {
  const target = storageOf(storage);
  if (!target || !token || !UUID.test(uuid ?? '')) return;
  try { target.setItem(KEY, JSON.stringify({ uuid, username: typeof username === 'string' ? username : '', token: await tokenHash(token) })); } catch { /* storage blocked */ }
}

/** The remembered identity when `token` is the one it was stored with, else null. */
export async function lastIdentity(token, storage) {
  const target = storageOf(storage);
  if (!target || !token) return null;
  try {
    const value = JSON.parse(target.getItem(KEY) ?? 'null');
    if (!value || !UUID.test(value.uuid ?? '') || value.token !== await tokenHash(token)) return null;
    return { uuid: value.uuid, username: typeof value.username === 'string' ? value.username : '' };
  } catch { return null; }
}
