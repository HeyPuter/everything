import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { createCredentialManager } from '../../src/lib/cred.js';
import { createWorkerClient } from '../../src/lib/api.js';
import { createDeployer, createWorkerGate, ensureShareConsent, forgetShareConsent, parseBanner, randomWorkerName, WORKER_KEY } from '../../src/lib/deploy.js';

const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const users = [{ uuid: alice, username: 'alice' }, { uuid: bob, username: 'bob' }];
const bundle = (build, at, { failHealth = 0 } = {}) => `/*! trips-worker build=${build} at=${at} protocol=1 */
let calls = 0;
router.get('/health', ({ request }) => {
  if (++calls <= ${failHealth}) return new Response('starting', { status: 503 });
  return { ok: true, build: '${build}', builtAt: ${at}, protocol: 1, auth: request.headers.get('puter-auth') };
});`;
// Each call yields the next scripted name (as 16 random bytes).
const names = (...list) => {
  const queue = [...list];
  return (bytes) => { const name = queue.shift(); bytes.set([...name].map((char) => 'abcdefghijklmnopqrstuvwxyz0123456789'.indexOf(char))); return bytes; };
};
const databases = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); });

function setup({ source = bundle('aaaaaa', 1000), ...options } = {}) {
  const world = createFakePuter({ users, ...options });
  const puter = world.client(alice);
  let current = source;
  const sleep = vi.fn(async () => {});
  const deployer = (extra = {}) => createDeployer({ puter, fetchBundle: async () => current, sleep, locks: null, ...extra });
  return { world, puter, sleep, deployer, setSource: (value) => { current = value; } };
}

describe('worker bundle banner', () => {
  it('parses the build id and refuses bundles without one', () => {
    expect(parseBanner(bundle('abc123', 1700000000000))).toEqual({ build: 'abc123', builtAt: 1700000000000, protocol: 1 });
    expect(() => parseBanner('router.get("/", () => 1)')).toThrow('invalid_worker_bundle');
    expect(() => parseBanner('/*! trips-worker build=UPPER at=1 protocol=1 */')).toThrow('invalid_worker_bundle');
  });
  it('makes valid worker names', () => {
    for (let i = 0; i < 20; i++) expect(randomWorkerName()).toMatch(/^trips-[a-z0-9]{10}$/);
  });
});

describe('own worker deploy', () => {
  it('runs a deployed worker in every region of the fake, each with that region\'s KV', async () => {
    const source = `${bundle('aaaaaa', 1000)}\nrouter.post('/mark', async () => { await me.puter.kv.set('mark', 1); return { ok: true }; });`;
    const { world, deployer } = setup({ source, regions: 2 });
    const { worker } = await deployer({ random: names('regionsxxx') }).ensure();
    await world.client(alice, 1).workers.exec(`${worker.url}/mark`, { method: 'POST' });
    expect(world.inspectKv(alice, 1).mark).toBe(1);
    expect(world.inspectKv(alice, 0).mark).toBeUndefined();
  });
  it('writes the source to AppData, creates the worker, polls health without credentials and saves me:worker', async () => {
    const { world, puter, deployer, sleep } = setup({ source: bundle('aaaaaa', 1000, { failHealth: 2 }) });
    const result = await deployer({ random: names('firstnamex') }).ensure();
    expect(result).toMatchObject({ created: true, worker: { name: 'trips-firstnamex', url: 'https://trips-firstnamex.puter.work', build: 'aaaaaa', builtAt: 1000 } });
    expect(result.health).toMatchObject({ build: 'aaaaaa' });
    expect(world.inspectKv(alice)[WORKER_KEY]).toEqual(result.worker);
    expect(result.worker.path).toBe('/alice/AppData/trips/worker/trips-worker.js');
    expect(await puter.workers.list()).toEqual([expect.objectContaining({ name: 'trips-firstnamex', file_path: result.worker.path })]);
    expect(sleep).toHaveBeenCalledTimes(2);
    const response = await (await puter.workers.exec('https://trips-firstnamex.puter.work/health', { headers: { 'x-puter-no-auth': '1' } })).json();
    expect(response.auth).toBeNull();
  });
  it('retries a taken name and recovers a create whose response was lost', async () => {
    const { world, puter, deployer } = setup();
    const other = world.client(bob);
    const file = await other.fs.write('worker/x.js', bundle('bbbbbb', 1), { createMissingParents: true });
    await other.workers.create('trips-takenxxxxx', file.path);
    const create = puter.workers.create;
    puter.workers.create = vi.fn(async (...args) => {
      if (args[0] === 'trips-takenxxxxx') return create(...args);
      await create(...args);
      throw Object.assign(new Error('network'), { status: 0 });
    });
    const result = await deployer({ random: names('takenxxxxx', 'secondxxxx') }).ensure();
    expect(result.worker.name).toBe('trips-secondxxxx');
    expect(puter.workers.create).toHaveBeenCalledTimes(2);
    expect((await puter.workers.list()).map((item) => item.name)).toEqual(['trips-secondxxxx']);
  });
  it('adopts an existing worker for its source file when the record was lost', async () => {
    const { puter, deployer, world } = setup();
    const first = await deployer({ random: names('keepername') }).ensure();
    await puter.kv.del(WORKER_KEY);
    const create = vi.spyOn(puter.workers, 'create');
    const again = await deployer({ random: names('neverusedx') }).ensure();
    expect(again.worker.name).toBe(first.worker.name);
    expect(create).not.toHaveBeenCalled();
    expect(world.inspectKv(alice)[WORKER_KEY].name).toBe('trips-keepername');
  });
  it('updates forward only and never downgrades', async () => {
    const { world, puter, deployer, setSource } = setup();
    await deployer({ random: names('forwardxxx') }).ensure();
    setSource(bundle('bbbbbb', 2000));
    const updated = await deployer().ensure();
    expect(updated).toMatchObject({ updated: true, worker: { build: 'bbbbbb', builtAt: 2000 }, health: { build: 'bbbbbb' } });
    const writes = world.counters().calls['fs.write'];
    setSource(bundle('cccccc', 1500));
    const older = await deployer().ensure();
    expect(older).toMatchObject({ updated: false, worker: { build: 'bbbbbb' }, health: { build: 'bbbbbb' } });
    expect(world.counters().calls['fs.write']).toBe(writes);
    expect(world.inspectKv(alice)[WORKER_KEY].build).toBe('bbbbbb');
    expect((await puter.workers.list())).toHaveLength(1);
  });
  it('recreates a worker under the same name when its source was deleted', async () => {
    const { puter, deployer } = setup();
    const first = await deployer({ random: names('phoenixxxx') }).ensure();
    await puter.fs.delete(first.worker.path);
    const again = await deployer().ensure();
    expect(again.worker.name).toBe('trips-phoenixxxx');
    expect(again.health.build).toBe('aaaaaa');
  });
  it('refuses a recorded name another account took over', async () => {
    const { world, puter, deployer } = setup();
    const first = await deployer({ random: names('hijackedxx') }).ensure();
    await puter.fs.delete(first.worker.path);
    const other = world.client(bob);
    const file = await other.fs.write('worker/x.js', bundle('aaaaaa', 1000), { createMissingParents: true });
    await other.workers.create(first.worker.name, file.path);
    const instance = deployer();
    await expect(instance.ensure()).rejects.toMatchObject({ code: 'worker_lost' });
    expect(await instance.current()).toBeNull();
    const reused = deployer({ random: names('reusedxxxx') });
    expect((await reused.current())).toBeNull();
  });
  it('treats a 404 from workers.get as not owned and asks workers.list before recreating', async () => {
    const { puter, deployer } = setup();
    const first = await deployer({ random: names('listcheckx') }).ensure();
    puter.workers.get = vi.fn(async () => { throw Object.assign(new Error('not found'), { status: 404 }); });
    const create = vi.spyOn(puter.workers, 'create');
    const instance = deployer();
    expect((await instance.ensure()).worker.name).toBe(first.worker.name);
    expect(create).not.toHaveBeenCalled();
    expect((await instance.current()).name).toBe(first.worker.name);
  });
  it('adopts the record another device saved first and retires its own worker', async () => {
    const { world, puter, deployer } = setup();
    const otherDevice = world.client(alice);
    const set = puter.kv.set;
    let raced = false;
    puter.kv.set = vi.fn(async (key, value, ...rest) => {
      const result = await set(key, value, ...rest);
      if (key === WORKER_KEY && !raced) {
        raced = true;
        await otherDevice.workers.create('trips-otherdevic', value.path);
        await otherDevice.kv.set(WORKER_KEY, { ...value, name: 'trips-otherdevic', url: 'https://trips-otherdevic.puter.work' });
      }
      return result;
    });
    const result = await deployer({ random: names('mineonexxx') }).ensure();
    expect(result).toMatchObject({ adopted: true, worker: { name: 'trips-otherdevic' } });
    expect((await puter.workers.list()).map((item) => item.name)).toEqual(['trips-otherdevic']);
    expect(result.health.build).toBe('aaaaaa');
  });
  it('does not write an older bundle over a live worker that is already newer', async () => {
    const { world, puter, deployer, setSource } = setup();
    const first = await deployer({ random: names('livecheckx') }).ensure();
    await puter.fs.write(first.worker.path, bundle('dddddd', 3000), { overwrite: true });
    setSource(bundle('bbbbbb', 2000));
    const writes = world.counters().calls['fs.write'];
    const result = await deployer().ensure();
    expect(result).toMatchObject({ updated: false, worker: { build: 'dddddd', builtAt: 3000 } });
    expect(world.counters().calls['fs.write']).toBe(writes);
  });
  it('stops on an account change after any await and before creating', async () => {
    const { world, puter } = setup();
    const deployer = createDeployer({ puter, locks: null, sleep: async () => {}, fetchBundle: async () => { puter.authToken = 'changed'; return bundle('aaaaaa', 1); } });
    await expect(deployer.ensure()).rejects.toMatchObject({ code: 'account_changed' });
    expect(world.counters().calls['workers.create']).toBeUndefined();
    expect(world.counters().calls['fs.write']).toBeUndefined();
  });
  it('asks for a verified email before deploying', async () => {
    const world = createFakePuter({ users: [{ uuid: alice, username: 'alice', email_confirmed: false }] });
    const puter = world.client(alice);
    await expect(createDeployer({ puter, locks: null, fetchBundle: async () => bundle('aaaaaa', 1) }).ensure()).rejects.toMatchObject({ code: 'email_unverified', status: 403 });
    expect(world.counters().calls['workers.create']).toBeUndefined();
  });
  it('runs one deploy per tab at a time', async () => {
    const { puter, deployer } = setup();
    const create = vi.spyOn(puter.workers, 'create');
    const instance = deployer({ random: names('onlyonexxx') });
    const [a, b] = await Promise.all([instance.ensure(), instance.ensure()]);
    expect(a.worker.name).toBe(b.worker.name);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('minBuild gate and consent', () => {
  async function client(world, options = {}) {
    const puter = world.client(alice);
    const db = await openDatabase(alice, { indexedDB: new IDBFactory() }); databases.push(db);
    const credentials = await createCredentialManager({ puter, db, crypto: webcrypto });
    return { puter, db, api: createWorkerClient({ puter, credentials, ...options }) };
  }
  it('refuses another owner’s worker below minBuild before sending a credential', async () => {
    const world = createFakePuter({ users });
    const seen = [];
    const register = (name, builtAt) => world.registerWorker(name, { owner: bob, fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/health') return Response.json({ build: 'abcdef', builtAt, protocol: 1 });
      seen.push(request.headers.get('puter-auth'));
      return Response.json({ ok: true, heads: {} });
    } });
    await register('trips-oldbuildxx', 1000);
    await register('trips-newbuildxx', 5000);
    const { puter } = await client(world);
    const gate = createWorkerGate({ puter, loadConfig: async () => ({ minBuild: 2000 }), ownWorker: () => 'trips-ownworkerx' });
    const { api } = await client(world, { gate });
    await expect(api.request('trips-oldbuildxx', JSON.stringify({ op: 'heads', spaces: [] }))).rejects.toMatchObject({ code: 'worker_outdated', status: 426 });
    expect(seen).toEqual([]);
    expect((await api.request('trips-newbuildxx', JSON.stringify({ op: 'heads', spaces: [] }))).ok).toBe(true);
    expect(seen).toHaveLength(1);
    await expect(gate('trips-ownworkerx')).resolves.toBeUndefined();
    const healthCalls = world.counters().calls['workers.exec'];
    await expect(gate('trips-oldbuildxx')).rejects.toMatchObject({ code: 'worker_outdated' });
    expect(world.counters().calls['workers.exec']).toBe(healthCalls);
  });
  it('requests the owner’s KV-share consent once and caches the grant', async () => {
    const world = createFakePuter({ users });
    const { puter, db } = await client(world);
    puter.perms = { request: vi.fn(async () => true) };
    expect(await ensureShareConsent({ puter, db, uid: alice })).toEqual({ granted: true, prompted: true });
    expect(puter.perms.request).toHaveBeenCalledWith('kvShare', { prefix: 'shared:', access: 'write' });
    expect(await db.get('consent:kv-share')).toBe(`manage:kv-share-write:${alice}:trips:shared`);
    expect(await ensureShareConsent({ puter, db, uid: alice })).toEqual({ granted: true, prompted: false });
    expect(puter.perms.request).toHaveBeenCalledTimes(1);
    await forgetShareConsent({ db });
    puter.perms.request.mockResolvedValue(false);
    await expect(ensureShareConsent({ puter, db, uid: alice })).rejects.toMatchObject({ code: 'consent_denied' });
  });
  it('grants the fake world’s kvShare consent, which the worker’s mint then relies on', async () => {
    const world = createFakePuter({ users, shareHandles: true });
    const { puter, db } = await client(world);
    expect(await ensureShareConsent({ puter, db, uid: alice, prefix: 'vacay:', access: 'read' })).toEqual({ granted: true, prompted: true });
    expect(await db.get('consent:kv-share:vacay:')).toBe(`manage:kv-share-read:${alice}:trips:vacay`);
    await expect(puter.kv.share('vacay:', 'bob', 'read')).resolves.toMatchObject({ holder: 'bob', access: 'read' });
    await expect(puter.kv.share('vacay:', 'bob', 'write')).rejects.toMatchObject({ code: 'events_kv_handle_not_delegated' });
    await expect(puter.kv.share('shared:x:', 'bob', 'read')).rejects.toMatchObject({ code: 'events_kv_handle_not_delegated' });
  });
});

describe('deploy lock', () => {
  it('goes ahead without the lock when another document never releases it', async () => {
    const { deployer } = setup();
    // A lock holder frozen in the back/forward cache: the request only ever settles through its abort signal.
    const locks = { request: (name, options) => new Promise((_, reject) => { options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); }) };
    const result = await deployer({ locks, lockWait: 20 }).ensure();
    expect(result.worker.name).toMatch(/^trips-/);
    expect(result.created).toBe(true);
  });
});
