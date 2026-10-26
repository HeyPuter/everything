import { TIMING } from '../../shared/limits.js';
import { createPathC } from './path-c.js';

export { createPathC } from './path-c.js';
export { createPathA, handleFailure } from './path-a.js';

/** The shell's sync-indicator status for a failure; an outdated worker (426) reads as forbidden, a rate limit as queued. */
export function syncStatus(error) {
  const status = error?.status;
  return status === 402 ? 'credit' : status === 403 || status === 426 ? 'forbidden' : status === 409 ? 'conflict' : status === 429 ? 'queued' : 'offline';
}

/**
 * Polling is authoritative; adapter subscriptions only wake it. An adapter is
 * `{name, minInterval?, pull(active), repair(active), subscribe?(notify, active)}`; `pull` resolves `{applied, remote, behind}`.
 */
export function createSyncEngine({ store, api, events, adapter, fallback, uid, document = globalThis.document, window = globalThis.window, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, onError = () => {}, onState = () => {}, onPath = () => {}, onFlush = () => {} }) {
  let current;
  let base = adapter ?? createPathC({ store, api, events, uid });
  const active = (run) => current === run && !run.stopped;
  function delay(run) {
    const floor = run.adapter.minInterval ?? 0;
    if (document?.hidden) return Math.max(floor, TIMING.pollEvents);
    if (run.retryAt > now()) return Math.max(floor, run.retryAt - now());
    if (run.failures) return Math.max(floor, Math.min(60_000, 1000 * 2 ** Math.min(run.failures, 6)));
    const base = run.eventsHealthy ? TIMING.pollEvents : now() - run.lastRemote < 120_000 ? TIMING.pollActive : TIMING.pollIdle;
    // While behind, come back when the 15 s repair is due.
    const repair = run.gapAt === undefined ? Infinity : Math.max(1000, TIMING.gapRepair - (now() - run.gapAt));
    return Math.max(floor, Math.min(base, repair));
  }
  function schedule(run) {
    if (!active(run)) return;
    clearTimer(run.timer); run.timer = undefined;
    if (document?.hidden && now() - run.hiddenAt >= TIMING.hiddenStop) return;
    run.timer = setTimer(() => { void syncRun(run); }, delay(run));
  }
  async function pull(run) {
    const live = () => active(run);
    // A rate-limited adapter (path C after a credit fallback) skips wake-ups inside its interval.
    if (run.adapter.minInterval && now() - run.lastPull < run.adapter.minInterval) return true;
    run.lastPull = now();
    let outcome;
    try { outcome = await run.adapter.pull(live); }
    catch (error) {
      const next = active(run) && fallback?.(error, run.adapter);
      if (!next) throw error;
      switchTo(run, next, error);
      outcome = await run.adapter.pull(live);
    }
    if (!active(run) || !outcome) return false;
    if (outcome.remote) run.lastRemote = now();
    if (outcome.behind) {
      run.gapAt ??= now();
      if (now() - run.gapAt >= TIMING.gapRepair) {
        await run.adapter.repair(live);
        if (!active(run)) return false;
        run.gapAt = undefined;
      }
    } else run.gapAt = undefined;
    return true;
  }
  async function flush(run) {
    let result = await store.flush();
    // A parked op leaves the rest of its batch queued, and a split batch is resent smaller, in the same run.
    for (let round = 0; active(run) && (result.retry || ['conflict', 'rejected'].includes(result.status)); round++) {
      if (!result.retry) onFlush(result);
      if (!store.pending.length || round === 8) break;
      result = await store.flush();
    }
    return result;
  }
  function syncRun(run) {
    if (!active(run)) return Promise.resolve();
    if (run.running) { run.again = true; return run.running; }
    clearTimer(run.timer);
    run.running = (async () => {
      // A pull's `retryAfter` delays the next run; a send's only holds sends (the store does that).
      let pulling = true;
      try {
        onState('syncing');
        if (!active(run) || !await pull(run)) return;
        pulling = false;
        const result = await flush(run);
        if (!active(run)) return;
        pulling = true;
        if (result.status === 'sent' && !await pull(run)) return;
        pulling = false;
        if (!active(run)) return;
        if (result.status === 'queued' && result.error) throw result.error;
        run.failures = 0; run.retryAt = 0;
        onState(store.conflicts?.length ? 'conflict' : store.pending.length ? 'queued' : 'synced', { ok: true, worker: run.adapter.name === 'C' || result.status === 'sent' });
      } catch (error) {
        if (!active(run)) return;
        run.failures += 1;
        run.retryAt = pulling && Number.isFinite(error?.retryAfter) && error.retryAfter > 0 ? now() + Math.min(error.retryAfter, 3600) * 1000 : 0;
        onState(syncStatus(error));
        if (active(run)) onError(error);
      } finally {
        run.running = undefined;
        if (active(run) && run.again) { run.again = false; queueMicrotask(() => { void syncRun(run); }); }
        else schedule(run);
      }
    })();
    return run.running;
  }
  async function subscribe(run) {
    const source = run.adapter;
    if (!source.subscribe) { run.eventsHealthy = false; return; }
    try {
      const unsubscribe = await source.subscribe((event) => {
        if (!active(run) || run.adapter !== source) return;
        if (event?.op === 'gap') run.eventsHealthy = false;
        if (event?.op === 'applied') { if (event.remote) run.lastRemote = now(); schedule(run); return; }
        void syncRun(run);
      }, () => active(run) && run.adapter === source);
      if (!active(run) || run.adapter !== source) { unsubscribe?.(); return; }
      run.unsubscribe = unsubscribe; run.eventsHealthy = true;
    } catch (error) { if (active(run) && run.adapter === source) { run.eventsHealthy = false; onError(error); } }
  }
  function switchTo(run, next, reason) {
    run.unsubscribe?.(); run.unsubscribe = undefined; run.eventsHealthy = false;
    run.adapter = next; run.gapAt = undefined;
    onPath(next.name, reason);
    void subscribe(run);
  }
  return {
    get path() { return (current?.adapter ?? base).name; },
    sync() { return current ? syncRun(current) : Promise.resolve(); },
    /** Swaps the adapter, for example back to path A after a credit fallback. */
    use(next) {
      base = next;
      if (current && active(current) && current.adapter !== next) { switchTo(current, next, null); void syncRun(current); }
    },
    async start() {
      if (current && active(current)) return;
      const run = { stopped: false, running: undefined, again: false, failures: 0, retryAt: 0, gapAt: undefined, adapter: base, lastPull: -Infinity,
        hiddenAt: document?.hidden ? now() : null, lastRemote: -Infinity, eventsHealthy: false };
      current = run;
      run.wake = () => { void syncRun(run); };
      run.visibility = () => {
        if (!active(run)) return;
        run.hiddenAt = document?.hidden ? now() : null;
        if (run.hiddenAt === null) run.wake(); else schedule(run);
      };
      window?.addEventListener('focus', run.wake); window?.addEventListener('online', run.wake);
      document?.addEventListener('visibilitychange', run.visibility);
      void subscribe(run);
      await syncRun(run);
    },
    stop() {
      const run = current;
      if (!run || run.stopped) return;
      run.stopped = true; run.again = false; clearTimer(run.timer);
      run.unsubscribe?.();
      window?.removeEventListener('focus', run.wake); window?.removeEventListener('online', run.wake);
      document?.removeEventListener('visibilitychange', run.visibility);
    },
  };
}
