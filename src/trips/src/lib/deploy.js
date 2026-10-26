import { DomainError, invariant } from '../shared/errors.js';
import { WORKER_PATTERN, trustedWorkerURL, workerOrigin } from '../shared/protocol.js';
import { plainObject } from '../shared/schema/dsl.js';
import { fetchHealth } from './api.js';

export const WORKER_FILE = 'worker/trips-worker.js';
export const WORKER_KEY = 'me:worker';
const BANNER = /^\s*\/\*! trips-worker build=([0-9a-z]{6,64}) at=(\d{1,16}) protocol=(\d{1,6}) \*\//;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const MAX_SOURCE = 8 * 1024 * 1024;

export function parseBanner(source) {
  invariant(typeof source === 'string' && source.length <= MAX_SOURCE, 'invalid_worker_bundle');
  const match = BANNER.exec(source.slice(0, 512));
  invariant(match, 'invalid_worker_bundle');
  const builtAt = Number(match[2]);
  invariant(Number.isSafeInteger(builtAt), 'invalid_worker_bundle');
  return { build: match[1], builtAt, protocol: Number(match[3]) };
}

export function validateWorkerRecord(value) {
  invariant(plainObject(value) && typeof value.name === 'string' && WORKER_PATTERN.test(value.name)
    && value.url === workerOrigin(value.name) && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 1024
    && /^[0-9a-z]{6,64}$/.test(value.build) && Number.isSafeInteger(value.builtAt) && value.builtAt >= 0, 'invalid_worker_record', 409);
  return { name: value.name, url: value.url, path: value.path, build: value.build, builtAt: value.builtAt };
}

export function randomWorkerName(random = (bytes) => globalThis.crypto.getRandomValues(bytes)) {
  let name = '';
  while (name.length < 10) {
    for (const byte of random(new Uint8Array(16))) if (byte < 252 && name.length < 10) name += ALPHABET[byte % 36];
  }
  return `trips-${name}`;
}

export async function needsEmailVerification(puter) {
  const user = await puter.auth.getUser();
  return !user?.email_confirmed;
}

/** Deploys or updates this account's own worker. Updates are forward-only; links never deploy anything. */
export function createDeployer({
  puter, fetchBundle = defaultBundle, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random, healthAttempts = 8, createAttempts = 5, locks = globalThis.navigator?.locks, lockWait = 8000, onProgress = () => {},
}) {
  const session = puter.authToken;
  const check = () => invariant(session && puter.authToken === session, 'account_changed', 401);
  let running;
  let verified = null;

  async function step(promise) { const value = await promise; check(); return value; }
  async function saved() {
    const value = await step(puter.kv.get(WORKER_KEY));
    return value == null ? null : validateWorkerRecord(value);
  }
  async function save(record) { await step(puter.kv.set(WORKER_KEY, record)); return record; }
  async function listed(predicate) {
    const items = await step(puter.workers.list());
    return (Array.isArray(items) ? items : []).find((item) => plainObject(item) && typeof item.name === 'string' && WORKER_PATTERN.test(item.name) && predicate(item));
  }

  // Names are global: a record counts only while this account owns the worker. A 404 throw reads as not owned,
  // and workers.list gives a second opinion before anything is recreated.
  async function owned(name) {
    try { if (await step(puter.workers.get(name))) return true; }
    catch (error) { if (error.code === 'account_changed' || error.status !== 404) throw error; check(); }
    return Boolean(await listed((item) => item.name === name));
  }

  async function healthy(record, target) {
    let last;
    for (let attempt = 0; attempt < healthAttempts; attempt++) {
      try {
        // A worker that never answers fails within about a minute instead of spinning for many.
        const health = await step(fetchHealth(puter, record.name, { timeout: 6000 }));
        // A newer client may already have moved the worker forward.
        if (health.build === target.build || (health.builtAt ?? 0) > target.builtAt) return health;
        last = new DomainError('worker_stale', 503);
      } catch (error) {
        if (error.code === 'account_changed') throw error;
        check();
        last = error;
        if (error.status === 404 && attempt >= 2) break;
      }
      await step(sleep(Math.min(1000 * 1.5 ** attempt, 5000)));
    }
    throw Object.assign(new DomainError(last?.status === 404 ? 'worker_missing' : 'worker_starting', 503), { cause: last });
  }

  async function create(source, meta, name) {
    if (!name) {
      const winner = await saved();
      if (winner) return { record: winner, adopted: true };
    }
    const file = await step(puter.fs.write(WORKER_FILE, source, { overwrite: true, dedupeName: false, createMissingParents: true }));
    invariant(typeof file?.path === 'string' && file.path, 'worker_write_failed', 502);
    let found = name ? null : await listed((item) => item.file_path === file.path);
    for (let attempt = 0; !found && attempt < (name ? 1 : createAttempts); attempt++) {
      const winner = name ? null : await saved();
      if (winner) return { record: winner, adopted: true };
      const candidate = name ?? randomWorkerName(random);
      try {
        const result = await step(puter.workers.create(candidate, file.path));
        if (result?.url) invariant(trustedWorkerURL(result.url).origin === workerOrigin(candidate), 'untrusted_worker');
        found = { name: candidate };
      } catch (error) {
        if (['account_changed', 'untrusted_worker'].includes(error.code)) throw error;
        check();
        // The create may have landed with its response lost.
        found = await listed((item) => item.name === candidate);
        if (!found && (error.status === 402 || error.code === 'email_not_confirmed')) {
          throw new DomainError(error.status === 402 ? 'insufficient_funds' : 'email_unverified', error.status === 402 ? 402 : 403);
        }
      }
    }
    if (!found) throw new DomainError(name ? 'worker_lost' : 'worker_create_failed', 503);
    const record = await save({ name: found.name, url: workerOrigin(found.name), path: file.path, build: meta.build, builtAt: meta.builtAt });
    const winner = await saved();
    if (winner && winner.name !== record.name) {
      // Another device saved first: retire ours and keep the shared source file in place.
      await puter.workers.delete(record.name).catch(() => {});
      check();
      try { await step(puter.fs.stat(winner.path)); } catch (error) {
        if (error.code === 'account_changed' || error.status !== 404) throw error;
        await step(puter.fs.write(winner.path, source, { overwrite: true, dedupeName: false, createMissingParents: true }));
      }
      return { record: winner, adopted: true };
    }
    return { record, created: true };
  }

  async function withLock(task) {
    if (!locks?.request) return task();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), lockWait);
    try { return await locks.request('trips-deploy', { signal: controller.signal }, task); }
    catch (error) {
      if (error?.name !== 'AbortError' || !controller.signal.aborted) throw error;
      return task();
    } finally { clearTimeout(timer); }
  }

  async function run() {
    verified = null;
    check();
    if (await needsEmailVerification(puter)) throw new DomainError('email_unverified', 403);
    check();
    onProgress('preparing');
    const source = await step(fetchBundle());
    const meta = parseBanner(source);
    let record = await saved();
    let result;
    if (!record) {
      onProgress('creating');
      result = await create(source, meta);
      record = result.record;
    } else if (!await owned(record.name)) {
      // Names are global: a record is trusted only while this account owns the worker. Recreate it or fail.
      onProgress('creating');
      await create(source, meta, record.name);
      result = { record, updated: true };
    } else if (record.builtAt < meta.builtAt && record.build !== meta.build) {
      onProgress('updating');
      const live = await fetchHealth(puter, record.name).catch((error) => { check(); return error.code === 'account_changed' ? Promise.reject(error) : null; });
      check();
      if (live?.builtAt >= meta.builtAt) {
        // Another device already moved the live worker forward; never write an older bundle over it.
        record = await save({ ...record, build: live.build, builtAt: live.builtAt });
        result = { record };
      } else {
        await step(puter.fs.write(record.path, source, { overwrite: true, dedupeName: false }));
        result = { record, updated: true };
      }
    } else result = { record };
    onProgress('starting');
    let health;
    try { health = await healthy(record, result.updated ? meta : record); }
    catch (error) {
      if (error.code !== 'worker_missing' || await owned(record.name)) throw error;
      await create(source, meta, record.name);
      health = await healthy(record, meta);
      result.updated = true;
    }
    if (result.updated && (record.build !== meta.build || record.builtAt !== meta.builtAt) && health.build === meta.build) {
      record = await save({ ...record, build: meta.build, builtAt: meta.builtAt });
    }
    verified = record;
    return { worker: record, health, created: Boolean(result.created), updated: Boolean(result.updated), adopted: Boolean(result.adopted) };
  }

  return {
    /**
     * Single-flight per tab and, where Web Locks exist, per origin. A document parked in the back/forward cache keeps
     * its lock while its timers are frozen, so the wait is bounded: after it the run goes ahead without the lock
     * (`saved()` and `listed()` already reconcile two deploys of one account).
     */
    ensure() {
      running ??= withLock(run).finally(() => { running = undefined; });
      return running;
    },
    /** The worker the last `ensure()` verified, or the saved record while this account still owns it; otherwise null. */
    async current() {
      check();
      if (verified) return verified;
      const record = await saved();
      return record && await owned(record.name) ? record : null;
    },
  };
}

async function defaultBundle() {
  const base = globalThis.document?.baseURI ?? globalThis.location?.href;
  const response = await fetch(new URL(WORKER_FILE, base), { cache: 'no-cache' });
  if (!response.ok) throw new DomainError('worker_bundle_unavailable', 503);
  return response.text();
}

/** Refuses other owners' workers whose `/health` `builtAt` is below `config.json` `minBuild`. */
export function createWorkerGate({ puter, loadConfig = defaultConfig, ownWorker = () => null, ttl = 10 * 60_000, now = Date.now }) {
  const checked = new Map();
  return async function gate(worker) {
    if (worker === ownWorker()) return;
    const minBuild = (await loadConfig())?.minBuild;
    if (!Number.isSafeInteger(minBuild) || minBuild <= 0) return;
    const cached = checked.get(worker);
    if (!cached || now() - cached.at >= ttl) {
      const health = await fetchHealth(puter, worker);
      checked.set(worker, { at: now(), ok: Number.isSafeInteger(health.builtAt) && health.builtAt >= minBuild });
      if (checked.size > 200) checked.delete(checked.keys().next().value);
    }
    if (!checked.get(worker).ok) throw new DomainError('worker_outdated', 426);
  };
}

let configPromise;
/** `config.json`, fetched once per page (retried after a failure); `{}` when unavailable. */
export function appConfig() { return defaultConfig(); }
function defaultConfig() {
  configPromise ??= (async () => {
    try {
      const base = globalThis.document?.baseURI ?? globalThis.location?.href;
      const response = await fetch(new URL('config.json', base), { cache: 'no-cache' });
      return response.ok ? await response.json() : {};
    } catch { configPromise = undefined; return {}; }
  })();
  return configPromise;
}

/**
 * Asks once for the `kvShare` consent an app needs before it (or its worker) shares the user's KV: `shared:` at
 * `write` lets the owner's worker mint member handles and invite stubs; Vacay asks for `vacay:` at `read`.
 */
export async function ensureShareConsent({ puter, db, uid, prefix = 'shared:', access = 'write' }) {
  const session = puter.authToken;
  const appUid = puter.appID;
  invariant(typeof appUid === 'string' && appUid && uid === db.account, 'invalid_consent_scope');
  // The permission string the request grants, kept to skip the request next time.
  const permission = `manage:kv-share-${access}:${uid}:${appUid}:${prefix.replace(/:$/, '')}`;
  const key = prefix === 'shared:' ? 'consent:kv-share' : `consent:kv-share:${prefix}`;
  if ((await db.get(key)) === permission) return { granted: true, prompted: false };
  invariant(puter.authToken === session, 'account_changed', 401);
  if (typeof puter.perms?.request !== 'function') return { granted: true, prompted: false };
  const granted = await puter.perms.request('kvShare', { prefix, access });
  invariant(puter.authToken === session, 'account_changed', 401);
  if (!granted || (Array.isArray(granted) && !granted.every(Boolean))) throw new DomainError('consent_denied', 403);
  await db.put(key, permission);
  return { granted: true, prompted: true };
}

/** Drops the remembered consent after the platform refused a share for want of it (the user withdrew it in Puter). */
export async function forgetShareConsent({ db, prefix = 'shared:' }) {
  await db.remove(prefix === 'shared:' ? 'consent:kv-share' : `consent:kv-share:${prefix}`);
}
