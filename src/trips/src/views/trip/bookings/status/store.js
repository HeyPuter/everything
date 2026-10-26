import { statusTtl } from '../../../../services/flights.js';
import { mergeSeen, queryId, seenId } from './model.js';

const MINUTE = 60_000;
const SEEN_LIMIT = 60;
const SEEN_AGE = 14 * 24 * 60 * MINUTE;

/**
 * Flight status per `{number, date}` for one view. Entries are `{query, state, result, code, refreshAt, seen}` with
 * `state` idle|loading|ready|nokey|unconfigured|offline|unavailable|error. Automatic entries refresh when their
 * answer expires while the page is visible; others load only on `ensure(query, {force: true})`.
 */
export function createStatusStore({ flights, keys, account = '', now = Date.now, storage = globalThis.localStorage, online = () => globalThis.navigator?.onLine !== false, doc = globalThis.document, win = globalThis.window }) {
  const entries = new Map();
  const listeners = new Set();
  const controller = new AbortController();
  const storageKey = `trips:flight-seen:${account || 'anon'}`;
  let timer = 0;
  let seen = readSeen();

  function readSeen() {
    try {
      const value = JSON.parse(storage?.getItem(storageKey) ?? '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }
  function writeSeen() {
    const cutoff = now() - SEEN_AGE;
    const kept = Object.entries(seen).filter(([, value]) => Number(value?.at) > cutoff).sort((a, b) => b[1].at - a[1].at).slice(0, SEEN_LIMIT);
    seen = Object.fromEntries(kept);
    try { storage?.setItem(storageKey, JSON.stringify(seen)); } catch { /* Gate changes are a convenience. */ }
  }

  const notify = () => { for (const listener of listeners) listener(); };
  function update(entry, patch) { Object.assign(entry, patch); }

  async function load(entry) {
    entry.pending = true;
    if (!entry.result) update(entry, { state: 'loading' });
    notify();
    try {
      if (!(await flights.available())) { update(entry, { state: 'unconfigured' }); return; }
      const key = await keys.get();
      if (!key) { update(entry, { state: 'nokey' }); return; }
      const result = await flights.status(entry.query, { key, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!result) {
        update(entry, { state: entry.result ? 'ready' : online() ? 'unavailable' : 'offline', offline: !online(), refreshAt: now() + 5 * MINUTE });
        return;
      }
      const list = result.data?.flights ?? [];
      for (const flight of list) {
        const id = seenId(entry.query, flight);
        seen[id] = mergeSeen(seen[id], flight, now());
      }
      if (list.length) writeSeen();
      const fetchedAt = Number.isFinite(result.data?.fetchedAt) ? result.data.fetchedAt : now();
      update(entry, { state: 'ready', result, code: null, offline: false, refreshAt: Math.max(fetchedAt + statusTtl(list, now()), now() + MINUTE) });
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) return;
      const code = !online() ? 'offline' : typeof error?.code === 'string' ? error.code : 'unavailable';
      update(entry, { state: entry.result ? 'ready' : code === 'offline' ? 'offline' : 'error', code, offline: code === 'offline', refreshAt: now() + (code === 'offline' ? 5 : 15) * MINUTE });
    } finally {
      entry.pending = false;
      if (!controller.signal.aborted) { schedule(); notify(); }
    }
  }

  function due(entry) {
    if (entry.pending) return false;
    if (entry.state === 'idle') return true;
    return Number.isFinite(entry.refreshAt) && entry.refreshAt <= now() && !['nokey', 'unconfigured'].includes(entry.state);
  }
  function schedule() {
    clearTimeout(timer);
    if (controller.signal.aborted || doc?.visibilityState === 'hidden') return;
    const next = Math.min(...[...entries.values()].filter((entry) => entry.auto && Number.isFinite(entry.refreshAt)).map((entry) => entry.refreshAt));
    if (!Number.isFinite(next)) return;
    timer = setTimeout(tick, Math.min(Math.max(next - now(), 1000), 2 ** 31 - 1));
  }
  function tick() {
    if (controller.signal.aborted || doc?.visibilityState === 'hidden') return;
    let started = false;
    for (const entry of entries.values()) if (entry.auto && due(entry)) { started = true; void load(entry); }
    if (!started) schedule();
  }
  const wake = () => { if (doc?.visibilityState !== 'hidden') tick(); else clearTimeout(timer); };
  const reconnect = () => {
    for (const entry of entries.values()) if (entry.offline || entry.state === 'unavailable') entry.refreshAt = now();
    // A check asked for by hand while offline is not automatic, so it is sent again here.
    for (const entry of entries.values()) if (!entry.auto && !entry.pending && entry.state === 'offline' && doc?.visibilityState !== 'hidden') void load(entry);
    wake();
  };
  doc?.addEventListener?.('visibilitychange', wake);
  win?.addEventListener?.('online', reconnect);
  const offKey = keys.subscribe?.(() => {
    for (const entry of entries.values()) if (['nokey', 'error'].includes(entry.state)) update(entry, { state: 'idle' });
    tick(); notify();
  });

  return {
    get: (query) => entries.get(queryId(query)) ?? null,
    seen: (query, flight) => seen[seenId(query, flight)] ?? null,
    /** Starts loading when needed: `auto` entries follow their expiry, `force` asks again now (manual check or retry). */
    ensure(query, { auto = false, force = false } = {}) {
      const id = queryId(query);
      let entry = entries.get(id);
      if (!entry) { entry = { query, state: 'idle', auto: false, result: null, code: null, refreshAt: null, pending: false }; entries.set(id, entry); }
      if (auto && !entry.auto) entry.auto = true;
      if (!entry.pending && (force || (entry.auto && due(entry)))) void load(entry);
      return entry;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    destroy() {
      controller.abort();
      clearTimeout(timer);
      listeners.clear();
      offKey?.();
      doc?.removeEventListener?.('visibilitychange', wake);
      win?.removeEventListener?.('online', reconnect);
    },
  };
}
