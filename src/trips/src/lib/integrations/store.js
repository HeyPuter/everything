// `me:integrations`: the user's own servers and their keys (data-model §4). Written with `disableSharing`, kept in
// memory only (never in IndexedDB), never sent to a trip worker and left out of data exports.
import { IntegrationError } from './errors.js';
import { normalizeServerUrl } from './client.js';

export const INTEGRATIONS_KEY = 'me:integrations';
export const SERVICES = Object.freeze(['airtrail', 'immich', 'dawarich']);
const FLAGS = Object.freeze({ airtrail: ['sync'], immich: [], dawarich: ['trails'] });
const KEY_MAX = 1024;
const STALE_MS = 5 * 60_000;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One service's settings `{url, key, ...flags}`, or null when missing or invalid. */
export function cleanConfig(service, value) {
  if (!SERVICES.includes(service) || !plain(value)) return null;
  const url = normalizeServerUrl(value.url);
  const key = typeof value.key === 'string' ? value.key.trim() : '';
  if (!url || !key || key.length > KEY_MAX || /[\u0000-\u001f\u007f]/.test(key)) return null;
  const out = { url, key };
  for (const flag of FLAGS[service]) if (typeof value[flag] === 'boolean') out[flag] = value[flag];
  return out;
}

/** Every service's settings from the stored value; services that are absent or invalid are null. */
export function readIntegrations(value) {
  const source = plain(value) && value.v === 1 ? value : {};
  return Object.fromEntries(SERVICES.map((service) => [service, cleanConfig(service, source[service])]));
}

/**
 * The store for one signed-in session. `load({fresh})` reads the cloud at most every five minutes; `save` and
 * `remove` re-read the stored value first so another device's other services survive. Fields this build does not
 * know are kept as stored.
 */
export function createIntegrationStore({ puter, now = Date.now }) {
  const session = puter?.authToken;
  const listeners = new Set();
  let state = null;
  let loadedAt = -Infinity;
  let pending = null;
  let queue = Promise.resolve();
  const guard = () => { if (!session || puter.authToken !== session) throw new IntegrationError('account_changed'); };
  const serial = (task) => { const run = queue.then(task); queue = run.catch(() => {}); return run; };
  const emit = () => { for (const listener of listeners) { try { listener(state); } catch { /* A listener's failure is its own. */ } } };

  async function read() {
    guard();
    const value = await puter.kv.get(INTEGRATIONS_KEY);
    guard();
    return plain(value) ? value : null;
  }
  function absorb(raw) {
    const next = readIntegrations(raw);
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next; loadedAt = now();
    if (changed) emit();
    return state;
  }
  async function write(update) {
    return serial(async () => {
      const raw = await read();
      const next = update({ ...(raw ?? {}), v: 1 });
      guard();
      if (SERVICES.some((service) => next[service] !== undefined)) await puter.kv.set(INTEGRATIONS_KEY, next, { disableSharing: true });
      else await puter.kv.del(INTEGRATIONS_KEY);
      guard();
      return absorb(next);
    });
  }

  return {
    /** Settings per service (null when not set up), from memory when fresh. */
    load({ fresh = false } = {}) {
      if (!fresh && state && now() - loadedAt < STALE_MS) return Promise.resolve(state);
      pending ??= read().then(absorb).finally(() => { pending = null; });
      return pending;
    },
    /** What is in memory: null before the first load. */
    peek: () => state,
    get: (service) => state?.[service] ?? null,
    configured: (service) => Boolean(state?.[service]),
    save(service, config) {
      const clean = cleanConfig(service, config);
      if (!clean) return Promise.reject(new IntegrationError('invalid_url'));
      return write((raw) => ({ ...raw, [service]: { ...(plain(raw[service]) ? raw[service] : {}), ...clean } }));
    },
    /** Changes flags of a configured service. */
    setFlags(service, flags) {
      return write((raw) => {
        if (!cleanConfig(service, raw[service])) throw new IntegrationError('not_configured');
        const allowed = Object.fromEntries(Object.entries(flags).filter(([flag, value]) => FLAGS[service].includes(flag) && typeof value === 'boolean'));
        return { ...raw, [service]: { ...raw[service], ...allowed } };
      });
    },
    remove(service) {
      return write((raw) => { const next = { ...raw }; delete next[service]; return next; });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

const stores = new WeakMap();
/** The shared store for the SDK's current session, so every view reads the key once. */
export function integrationStore(puter) {
  if (!puter || typeof puter !== 'object') return createIntegrationStore({ puter });
  const token = puter.authToken ?? '';
  let entry = stores.get(puter);
  if (!entry || entry.token !== token) { entry = { token, store: createIntegrationStore({ puter }) }; stores.set(puter, entry); }
  return entry.store;
}
