import { createWorkerClient } from './api.js';
import { createCredentialManager } from './cred.js';
import { createDeployer, createWorkerGate } from './deploy.js';
import { createInvites } from './invites.js';
import { openSpace as defaultOpenSpace } from './store/index.js';
import { loadFeatures as defaultLoadFeatures } from './sync/features.js';
import { createServices as defaultCreateServices } from '../services/index.js';
import { validateSpaceRef } from '../shared/protocol.js';

const sameRef = (a, b) => a?.w === b?.w && a?.s === b?.s;

/**
 * Created once per sign-in and passed to every view as `context.session` (src/lib/README.md, "Adding a module").
 * Besides the contract keys it tracks this account's own worker and the one open trip space, shared by that trip's tabs.
 */
export async function createSession({
  puter, account, db, personal, openSpace = defaultOpenSpace, createServices = defaultCreateServices, loadFeatures = defaultLoadFeatures,
  credentials: injectedCredentials, deployer: injectedDeployer,
}) {
  const credentials = injectedCredentials ?? await createCredentialManager({ puter, db });
  const progress = new Set();
  const deployer = injectedDeployer ?? createDeployer({ puter, onProgress: (stage) => { for (const fn of [...progress]) fn(stage); } });
  // `undefined` until resolved, then the verified worker name or null.
  let own;
  let ownLookup = null;
  const api = createWorkerClient({ puter, credentials, gate: createWorkerGate({ puter, ownWorker: () => own ?? null }) });
  const invites = createInvites({ puter, api, spaces: personal.spaces });
  let services = null;
  let trip = null;
  let closing = null;
  let closed = false;
  // Path A and direct-file flags, read once per session.
  let flags = null;
  const features = () => (flags ??= Promise.resolve().then(() => loadFeatures()).catch(() => ({})));

  async function ownWorker({ fresh = false } = {}) {
    if (own !== undefined && !fresh) return own;
    ownLookup ??= (async () => {
      try { own = (await deployer.current())?.name ?? null; return own; } finally { ownLookup = null; }
    })();
    return ownLookup;
  }

  /** Deploys or updates this account's worker; `onProgress(stage)` sees preparing|creating|updating|starting. */
  async function ensureWorker({ onProgress } = {}) {
    if (onProgress) progress.add(onProgress);
    try {
      const result = await deployer.ensure();
      own = result.worker.name;
      return result;
    } finally { if (onProgress) progress.delete(onProgress); }
  }

  /** Resolves once the store has closed. Queued edits go out first; anything left stays queued for the next open. */
  function closeTrip() {
    if (!trip) return Promise.resolve();
    const current = trip; trip = null;
    current.closed = true;
    current.listeners.clear();
    const space = current.space;
    if (!space) return Promise.resolve();
    const done = space.flush().catch(() => {}).finally(() => { space.close(); if (closing === done) closing = null; });
    closing = done;
    return done;
  }

  /** The one open trip: reused while the ref stays the same, closed (and the previous one too) when it changes. */
  function openTrip(ref, { view = '' } = {}) {
    validateSpaceRef(ref);
    if (closed) throw new Error('session_closed');
    if (trip && sameRef(trip.ref, ref)) return trip;
    closeTrip();
    const listeners = new Set();
    const emit = (kind, value) => { for (const fn of [...listeners]) fn(kind, value); };
    const handle = {
      ref: { ...ref }, space: null, closed: false, listeners,
      /** `fn(kind, value)` with kind `error` (sync and open errors) or `flush` (outbox results). */
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
    handle.ready = (async () => {
      const [entries, ownName, flagSet] = await Promise.all([personal.spaces.list().catch(() => []), ownWorker().catch(() => null), features()]);
      if (handle.closed) throw Object.assign(new Error('trip_closed'), { code: 'trip_closed' });
      const entry = entries.find((item) => sameRef(item.ref, ref));
      const space = await openSpace({
        ref, db, api, puter, personal, handles: entry?.handles ?? null, files: entry?.files ?? null, features: flagSet,
        role: entry?.role ?? (ownName && ownName === ref.w ? 'owner' : null), ownWorker: ownName, view, autoStart: false,
        onError: (error) => emit('error', error), onFlush: (result) => emit('flush', result),
      });
      if (handle.closed) { space.close(); throw Object.assign(new Error('trip_closed'), { code: 'trip_closed' }); }
      handle.space = space;
      // Views render from the replica at once; the first pull continues in the background.
      space.start().catch((error) => emit('error', error));
      return space;
    })();
    handle.ready.catch(() => {});
    trip = handle;
    return handle;
  }

  /**
   * Runs `fn(space)` against a trip outside its route (dashboard actions, copies) and flushes afterwards. Reuses the
   * open trip when it is the same one; otherwise opens a short-lived space, pulling first when nothing is cached.
   * Resolves `{value, flush}`; `flush.status` is `queued` when the change waits for a connection.
   */
  async function withSpace(ref, fn, { pull = false } = {}) {
    validateSpaceRef(ref);
    if (trip && sameRef(trip.ref, ref)) {
      const space = await trip.ready;
      const value = await fn(space);
      return { value, flush: await space.flush() };
    }
    const [entries, ownName, flagSet] = await Promise.all([personal.spaces.list().catch(() => []), ownWorker().catch(() => null), features()]);
    const entry = entries.find((item) => sameRef(item.ref, ref));
    const space = await openSpace({
      ref, db, api, puter, personal, handles: entry?.handles ?? null, files: entry?.files ?? null, features: flagSet,
      role: entry?.role ?? (ownName && ownName === ref.w ? 'owner' : null), ownWorker: ownName, autoStart: false, view: '',
    });
    try {
      if (pull || !space.get('meta', 'meta')) await space.start();
      const value = await fn(space);
      return { value, flush: await space.flush() };
    } finally { space.close(); }
  }

  return {
    account: { ...account }, db, api, deployer, personal, invites, credentials, withSpace,
    /** Geocoding, routing, weather, FX and image search for this account (src/services), created on first use. */
    get services() { services ??= createServices({ userId: account.uuid }); return services; },
    ownWorker, ensureWorker, openTrip, closeTrip,
    get trip() { return trip; },
    /** A promise while a just-closed trip is still sending its queued edits, else null. */
    idle: () => closing,
    close() { closed = true; closeTrip(); progress.clear(); },
  };
}
