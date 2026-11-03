import { webcrypto } from 'node:crypto';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { createCredentialManager } from '../../src/lib/cred.js';
import { createWorkerClient } from '../../src/lib/api.js';
import { install } from '../../worker/app.js';

export const WORKER = 'trips-abcdefghij';
export const ORIGIN = `https://${WORKER}.puter.work`;
export const USERS = Object.freeze({
  alice: { uuid: '00000000-0000-4000-8000-000000000001', username: 'alice' },
  bob: { uuid: '00000000-0000-4000-8000-000000000002', username: 'bob' },
  carol: { uuid: '00000000-0000-4000-8000-000000000003', username: 'carol' },
  dave: { uuid: '00000000-0000-4000-8000-000000000004', username: 'dave' },
});

let sequence = 0;
/** Deterministic 16-char ids for tests (valid `isId`). */
export const id = (prefix = 'x') => `${prefix.replace(/[^0-9a-hjkmnp-tv-z]/g, '0').slice(0, 4).padEnd(4, '0')}${String(++sequence).padStart(12, '0')}`;

export function memoryDb(account) {
  const map = new Map();
  return {
    account,
    async get(key) { return map.get(key); },
    async put(key, value) { map.set(key, value); },
    async remove(key) { map.delete(key); },
    async update(key, change) {
      const value = change(map.get(key));
      if (value === undefined) map.delete(key); else map.set(key, value);
      return value;
    },
    close() {},
  };
}

/**
 * One fake Puter world with the real worker installed for Alice (in every region) and
 * clients that use the real credential manager and worker client from src/lib.
 */
export async function createHarness({ regions = 1, onlyIfAbsent = true, shareHandles = false, shareConsent = true, ownerVerified = true, ops, enforceRateLimits = false, replicationDelay, source, timeout = 10_000 } = {}) {
  // A built bundle reads the real clock, so its world follows real time.
  let time = source ? Date.now() : 1_800_000_000_000;
  const now = () => (source ? Math.max(time, Date.now()) : time);
  const users = Object.values(USERS).map((user) => ({ ...user, verified: user.username === 'alice' ? ownerVerified : true }));
  const world = createFakePuter({ users, regions, onlyIfAbsent, shareHandles, now, enforceRateLimits, replicationDelay });
  // The owner allowed `kvShare` on `shared:` at their first invite (ensureShareConsent), so their worker can mint.
  if (shareConsent) world.grantShareConsent(USERS.alice.uuid, 'shared:', 'write');
  const workers = [];
  for (let region = 0; region < regions; region++) {
    if (source) await world.registerWorker(WORKER, { owner: USERS.alice.uuid, region, source });
    else await world.registerWorker(WORKER, { owner: USERS.alice.uuid, region, setup: ({ router, me }) => { workers[region] = install({ router, me, options: { now, ops, build: 'test000007', builtAt: 1_700_000_000_000 } }); } });
  }
  const clients = new Map();
  async function client(name, region = 0) {
    const key = `${name}:${region}`;
    if (clients.has(key)) return clients.get(key);
    const user = USERS[name];
    const puter = world.client(user.uuid, region);
    const credentials = await createCredentialManager({ puter, db: memoryDb(user.uuid), crypto: webcrypto, now });
    // `timeout` is real time per request; tests that move tens of MB raise it so a loaded machine cannot trip it.
    const api = createWorkerClient({ puter, credentials, timeout });
    const c = {
      name, uuid: user.uuid, puter, credentials, api,
      call: (op, input = {}) => api.request(WORKER, JSON.stringify({ op, ...input })),
      in: (space) => ({ ref: { w: WORKER, s: space, k: 'trip' }, call: (op, input = {}) => api.request(WORKER, JSON.stringify({ ...input, op, space })) }),
      async raw(method, path, { body, signed, headers = {} } = {}) {
        const auth = await credentials.headers(ORIGIN, signed ?? (typeof body === 'string' ? body : ''));
        return puter.workers.exec(ORIGIN + path, { method, headers: { ...auth, ...headers }, body });
      },
    };
    clients.set(key, c);
    return c;
  }
  const harness = {
    world, workers, client, now,
    advance(ms) { time += ms; },
    async settle() { await world.flushWorkers(); world.flushReplication(); },
    kv: (region = 0) => world.inspectKv(USERS.alice.uuid, region),
    async trip(meta = { title: 'Lisbon', currency: 'EUR', start: '2027-05-01', end: '2027-05-04' }) {
      const alice = await client('alice');
      const { space } = await alice.call('space.create', { kind: 'trip', meta });
      return space;
    },
    /** Creates a trip and joins the named users with the given roles. */
    async team(roles = { bob: 'editor', carol: 'viewer' }, options = {}) {
      const space = await harness.trip(options.meta);
      const alice = await client('alice');
      for (const [name, role] of Object.entries(roles)) {
        const { token } = await alice.in(space).call('invite.create', { role });
        await (await client(name)).in(space).call('join', { token });
      }
      return space;
    },
  };
  return harness;
}

export async function expectError(promise, status, code) {
  try { await promise; } catch (error) {
    if (error.status !== status || (code && error.code !== code)) throw new Error(`Expected ${status} ${code ?? ''}, got ${error.status} ${error.code}`);
    return error;
  }
  throw new Error(`Expected ${status} ${code ?? ''}, but the call succeeded`);
}
