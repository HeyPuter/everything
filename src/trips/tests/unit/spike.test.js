// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { CLEANUP_PERMIT, IDENTITY_PERMIT, KV_PERMIT, WORKER_PERMIT, createEvidence, newRunId } from '../../dev/spike/evidence.js';
import { cleanupKv, kvKeys, runKvProbes } from '../../dev/spike/kv.js';
import { createSpikeSession, runHealthProbe, workerOrigin } from '../../dev/spike/client.js';
import { createSpikeHandler } from '../../dev/spike/worker.js';

const runId = 'f0-0123456789abcdef';
const owner = { uuid: '00000000-0000-4000-8000-000000000001', username: 'owner' };
const other = { uuid: '00000000-0000-4000-8000-000000000002', username: 'other' };
const environment = 'fake';
function world() {
  const fake = createFakePuter({ users: [owner, other], appUid: 'trips', onlyIfAbsent: true });
  return { fake, puter: fake.client(owner), other: fake.client(other) };
}
function switchingClient(initial) {
  let current = initial;
  let after = () => {};
  const call = async (group, method, args) => {
    const result = await current[group][method](...args);
    after(group, method);
    return result;
  };
  const module = (group) => new Proxy({}, { get: (_, method) => (...args) => call(group, method, args) });
  return {
    puter: {
      get authToken() { return current.authToken; }, get APIOrigin() { return current.APIOrigin; },
      auth: { isSignedIn: () => current.auth.isSignedIn(), getUser: () => call('auth', 'getUser', []) },
      kv: module('kv'), fs: module('fs'), workers: module('workers'),
    },
    switchTo(client) { current = client; },
    after(operation) { after = operation; },
  };
}
const kvOptions = (puter) => ({ puter, runId, environment, permit: KV_PERMIT });
const sessionOptions = (puter) => ({ puter, runId, environment, crypto: webcrypto, permit: IDENTITY_PERMIT });
const results = (report) => Object.fromEntries(report.results.map((row) => [row.probe, row]));
async function register(fake, options = {}) {
  return fake.registerWorker(`trips-${runId}`, {
    owner, appUid: 'trips',
    setup({ router, me }) {
      const handler = createSpikeHandler({ me, crypto: webcrypto, environment, ...options });
      router.get('/health', handler); router.post('/probe', handler); router.post('/*path', handler);
    },
  });
}
afterEach(() => { vi.restoreAllMocks(); });

describe('F0 isolated KV probes and evidence', () => {
  it('has no SDK activity before explicit opt-in and rejects arbitrary namespaces', async () => {
    const { fake, puter } = world();
    await expect(runKvProbes({ ...kvOptions(puter), permit: undefined })).rejects.toThrow('spike_explicit_permission_required');
    await expect(runKvProbes({ ...kvOptions(puter), runId: 'me:prefs' })).rejects.toThrow('spike_invalid_run');
    await expect(cleanupKv({ puter, runId, permit: undefined })).rejects.toThrow('spike_explicit_permission_required');
    expect(fake.counters().calls).toEqual({});
    expect(newRunId(webcrypto)).toMatch(/^f0-[a-f0-9]{16}$/);
  });
  it('checks the fake semantics, optional TTL/size/conditional paths and exact-key cleanup', async () => {
    const { fake, puter } = world();
    await puter.kv.set('me:prefs', { private: 'preserve' });
    const report = await runKvProbes({ ...kvOptions(puter), ttl: true, size: true, conditional: true, wait: async (ms) => fake.advance(ms) });
    expect(report.environment).toBe('fake');
    expect(report.results).toHaveLength(11);
    expect(report.results.every((item) => item.outcome === 'pass')).toBe(true);
    expect(await puter.kv.get(kvKeys(runId))).toEqual(Array(10).fill(null));
    expect(await puter.kv.get('me:prefs')).toEqual({ private: 'preserve' });
    expect(fake.counters().calls['kv.flush']).toBeUndefined();
    expect(results(report)['cleanup.kv'].measurements).toMatchObject({ attempted: 10, failed: 0 });
  });
  it('keeps unrequested checks pending and cleans up after a failed write', async () => {
    const { fake, puter } = world();
    fake.failNext({ method: 'kv.update', code: 'private-token-should-not-escape', message: 'sensitive-personal-data', status: 402 });
    const report = await runKvProbes(kvOptions(puter));
    expect(results(report)['kv.updateMissing']).toMatchObject({ outcome: 'error', measurements: { status: 402 } });
    expect(results(report)['kv.ttl'].outcome).toBe('pending');
    expect(results(report)['kv.size'].outcome).toBe('pending');
    expect(results(report)['kv.conditional'].outcome).toBe('pending');
    expect(await puter.kv.get(kvKeys(runId))).toEqual(Array(10).fill(null));
    expect(JSON.stringify(report)).not.toMatch(/private-token|sensitive-personal|owner|AppData/);
  });
  it('attempts every cleanup key and reports incomplete cleanup without raw SDK errors', async () => {
    const { fake, puter } = world();
    fake.failNext({ method: 'kv.del', status: 402, times: 2 });
    const report = await runKvProbes(kvOptions(puter));
    expect(results(report)['cleanup.kv']).toMatchObject({ outcome: 'fail', measurements: { attempted: 10, failed: 2 } });
    expect(fake.counters().calls['kv.del']).toBe(10);
    expect(await cleanupKv({ puter, runId, permit: CLEANUP_PERMIT })).toMatchObject({ attempted: 10, failed: 0, cleanupRequired: false });
    expect(await puter.kv.get(kvKeys(runId))).toEqual(Array(10).fill(null));
  });
  it('fails an ignored conditional option instead of claiming support', async () => {
    const { puter } = world();
    const set = puter.kv.set;
    puter.kv.set = (key, value) => set(key, value);
    const report = await runKvProbes({ ...kvOptions(puter), conditional: true });
    expect(results(report)['kv.conditional'].outcome).toBe('fail');
  });
  it('allows only fixed probe IDs and numeric/boolean evidence fields', () => {
    const evidence = createEvidence({ runId, environment });
    expect(() => evidence.record('kv.batch', 'pass', { path: '/owner/private' })).toThrow('spike_invalid_measurement');
    expect(() => evidence.record('kv.batch', 'pass', { status: 'token' })).toThrow('spike_invalid_measurement');
    expect(() => evidence.record('token', 'pass')).toThrow('spike_invalid_evidence');
    evidence.record('kv.batch', 'pass', { calls: 1 });
    const report = evidence.report(); report.results[0].measurements.calls = 999;
    expect(evidence.report().results[0].measurements.calls).toBe(1);
  });
});

describe('F0 restricted owner-only spike worker preparation', () => {
  it('requires independent identity and request opt-ins and never signs in or deploys', async () => {
    const { fake, puter } = world();
    await expect(createSpikeSession({ ...sessionOptions(puter), permit: undefined })).rejects.toThrow('spike_explicit_permission_required');
    expect(fake.counters().calls).toEqual({});
    const signIn = vi.spyOn(puter.auth, 'signIn');
    const session = await createSpikeSession(sessionOptions(puter));
    await expect(session.request('auth')).rejects.toThrow('spike_explicit_permission_required');
    expect(signIn).not.toHaveBeenCalled();
    expect(Object.keys(session).sort()).toEqual(['cleanup', 'request', 'runId', 'workerName']);
    await session.cleanup({ permit: CLEANUP_PERMIT });
  });
  it('validates a restricted proof, keeps health anonymous, streams synthetic gzip and cleans identity', async () => {
    const { fake, puter } = world();
    await register(fake);
    const session = await createSpikeSession(sessionOptions(puter));
    const health = await runHealthProbe({ puter, runId, environment, permit: WORKER_PERMIT });
    expect(results(health)['worker.health']).toMatchObject({ outcome: 'pass', measurements: { authenticated: false } });
    const auth = await session.request('auth', { permit: WORKER_PERMIT });
    expect(results(auth)['worker.auth']).toMatchObject({ outcome: 'pass', measurements: { restricted: true, owner: true } });
    const compression = await session.request('compress', { permit: WORKER_PERMIT });
    expect(results(compression)['worker.compression']).toMatchObject({ outcome: 'pass', measurements: { entities: 5000, streamed: true } });
    const measures = results(compression)['worker.compression'].measurements;
    expect(measures.gzipBytes).toBeLessThan(measures.jsonBytes);
    const kv = await session.request('kv', { permit: WORKER_PERMIT });
    expect(results(kv)['cleanup.kv'].outcome).toBe('pass');
    expect(results(await session.request('kv', { permit: WORKER_PERMIT }))['kv.batch'].measurements.status).toBe(409);
    const serialized = JSON.stringify([health, auth, compression, kv]);
    expect(serialized).not.toMatch(/AppData|publicKey|signature|authToken|username|00000000-0000/);
    expect(serialized).not.toContain(puter.authToken);
    expect(results(await session.cleanup({ permit: CLEANUP_PERMIT }))['cleanup.identity'].outcome).toBe('pass');
    await expect(puter.fs.stat(`dev/spike/${runId}`)).rejects.toMatchObject({ status: 404 });
    await expect(session.request('auth', { permit: WORKER_PERMIT })).rejects.toThrow('spike_session_expired');
  });
  it('rejects session tokens, valid restricted credentials owned by another user and tampered bodies', async () => {
    const { fake, puter, other: otherClient } = world();
    await register(fake);
    const response = await puter.workers.exec(`${workerOrigin(runId)}/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'puter-auth': puter.authToken, 'x-trips-proof': '{}' }, body: '{"probe":"auth"}' });
    expect(response.status).toBe(401);
    const unauthorized = await createSpikeSession(sessionOptions(otherClient));
    expect(results(await unauthorized.request('auth', { permit: WORKER_PERMIT }))['worker.auth'].measurements.status).toBe(401);
    await unauthorized.cleanup({ permit: CLEANUP_PERMIT });
    const session = await createSpikeSession(sessionOptions(puter));
    const exec = puter.workers.exec;
    puter.workers.exec = (url, init) => exec(url, { ...init, body: '{"probe":"compress"}' });
    expect(results(await session.request('auth', { permit: WORKER_PERMIT }))['worker.auth'].measurements.status).toBe(401);
    await session.cleanup({ permit: CLEANUP_PERMIT });
    expect(fake.counters().calls['kv.set']).toBeUndefined();
  });
  it('bounds bodies and disallows arbitrary probe fields before any worker storage writes', async () => {
    const { fake, puter } = world();
    await register(fake);
    for (const [body, status] of [['x'.repeat(2049), 413], ['{"probe":"kv","key":"me:prefs"}', 400]]) {
      const response = await puter.workers.exec(`${workerOrigin(runId)}/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      expect(response.status).toBe(status);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    }
    expect(fake.counters().calls['kv.set']).toBeUndefined();
  });
  it('enforces per-isolate attempt and completed-probe budgets', async () => {
    const { fake, puter } = world();
    await register(fake);
    const session = await createSpikeSession(sessionOptions(puter));
    for (let i = 0; i < 8; i++) expect(results(await session.request('auth', { permit: WORKER_PERMIT }))['worker.auth'].outcome).toBe('pass');
    expect(results(await session.request('compress', { permit: WORKER_PERMIT }))['worker.compression'].measurements.status).toBe(429);
    await session.cleanup({ permit: CLEANUP_PERMIT });
  });
  it('preserves existing spike folders when identity creation collides', async () => {
    const { puter } = world();
    await puter.fs.write(`dev/spike/${runId}/sentinel.txt`, 'preserve', { createMissingParents: true });
    await expect(createSpikeSession(sessionOptions(puter))).rejects.toThrow('spike_identity_setup_failed');
    expect(await (await puter.fs.read(`dev/spike/${runId}/sentinel.txt`)).text()).toBe('preserve');
  });
  it('records failed identity cleanup without exporting raw SDK errors and permits retry', async () => {
    const { fake, puter } = world();
    const session = await createSpikeSession(sessionOptions(puter));
    fake.failNext({ method: 'fs.delete', status: 402, message: 'sensitive secret' });
    expect(results(await session.cleanup({ permit: CLEANUP_PERMIT }))['cleanup.identity'].outcome).toBe('error');
    expect(results(await session.cleanup({ permit: CLEANUP_PERMIT }))['cleanup.identity'].outcome).toBe('pass');
  });
});

describe('F0 account-switch isolation', () => {
  it('stops KV operations and refuses replacement-account cleanup after the first write', async () => {
    const { fake, puter: a, other: b } = world();
    await b.kv.set(kvKeys(runId)[0], 'preserve-b');
    const switching = switchingClient(a);
    switching.after((group, method) => { if (group === 'kv' && method === 'set') switching.switchTo(b); });
    const report = await runKvProbes(kvOptions(switching.puter));
    expect(results(report)['kv.batch']).toMatchObject({ outcome: 'error', measurements: { cleanupRequired: true, originalAccountRequired: true } });
    expect(results(report)['kv.updateMissing'].outcome).toBe('pending');
    expect(results(report)['cleanup.kv']).toMatchObject({ outcome: 'fail', measurements: { attempted: 0, calls: 1, writes: 1, cleanupRequired: true, originalAccountRequired: true } });
    expect(fake.counters().byUser[other.uuid].calls['kv.del']).toBeUndefined();
    expect(await b.kv.get(kvKeys(runId)[0])).toBe('preserve-b');
    expect(await a.kv.get(kvKeys(runId)[0])).toEqual({ fixture: 'a' });
    expect(await a.kv.get(kvKeys(runId)[1])).toBeNull();
    expect(await cleanupKv({ puter: a, runId, permit: CLEANUP_PERMIT })).toMatchObject({ attempted: 10, cleanupRequired: false });
  });
  it('stops cleanup immediately if an account changes while a delete settles', async () => {
    const { fake, puter: a, other: b } = world();
    await a.kv.set(kvKeys(runId)[0], 'remove-a'); await a.kv.set(kvKeys(runId)[1], 'keep-a-for-recovery');
    await b.kv.set(kvKeys(runId)[1], 'preserve-b');
    const switching = switchingClient(a);
    switching.after((group, method) => { if (group === 'kv' && method === 'del') switching.switchTo(b); });
    expect(await cleanupKv({ puter: switching.puter, runId, permit: CLEANUP_PERMIT })).toEqual({ attempted: 1, failed: 0, cleanupRequired: true, originalAccountRequired: true });
    expect(fake.counters().byUser[other.uuid].calls['kv.del']).toBeUndefined();
    expect(await a.kv.get(kvKeys(runId)[1])).toBe('keep-a-for-recovery');
    expect(await b.kv.get(kvKeys(runId)[1])).toBe('preserve-b');
  });
  it('does not mutate files after an account changes during key generation', async () => {
    const { fake, puter: a, other: b } = world();
    await b.fs.write(`dev/spike/${runId}/sentinel.txt`, 'preserve-b', { createMissingParents: true });
    const switching = switchingClient(a);
    const crypto = { subtle: new Proxy(webcrypto.subtle, { get(target, method) {
      if (method === 'generateKey') return async (...args) => { const keys = await target.generateKey(...args); switching.switchTo(b); return keys; };
      return target[method].bind(target);
    } }) };
    await expect(createSpikeSession({ ...sessionOptions(switching.puter), crypto })).rejects.toMatchObject({ message: 'spike_identity_setup_failed', runId, cleanupRequired: false, originalAccountRequired: false });
    expect(fake.counters().calls['fs.mkdir']).toBeUndefined(); expect(fake.counters().calls['fs.delete']).toBeUndefined(); expect(fake.counters().calls['fs.getReadURL']).toBeUndefined();
    expect(await (await b.fs.read(`dev/spike/${runId}/sentinel.txt`)).text()).toBe('preserve-b');
  });
  it.each(['mkdir', 'write', 'getReadURL'])('requires original-account recovery after a switch while %s settles', async (stage) => {
    const { fake, puter: a, other: b } = world();
    await b.fs.write(`dev/spike/${runId}/sentinel.txt`, 'preserve-b', { createMissingParents: true });
    const switching = switchingClient(a);
    switching.after((group, method) => { if (group === 'fs' && method === stage) switching.switchTo(b); });
    await expect(createSpikeSession(sessionOptions(switching.puter))).rejects.toMatchObject({ message: 'spike_identity_setup_failed_cleanup_required_original_account', runId, cleanupRequired: true, originalAccountRequired: true });
    expect(fake.counters().byUser[other.uuid].calls['fs.delete']).toBeUndefined();
    expect(fake.counters().byUser[other.uuid].calls['fs.mkdir']).toBeUndefined();
    expect(fake.counters().byUser[other.uuid].calls['fs.getReadURL']).toBeUndefined();
    expect(fake.counters().byUser[other.uuid].calls['fs.write']).toBe(1);
    expect(await (await b.fs.read(`dev/spike/${runId}/sentinel.txt`)).text()).toBe('preserve-b');
    expect((await a.fs.stat(`dev/spike/${runId}`)).is_dir).toBe(true);
    if (stage === 'mkdir') expect(fake.counters().byUser[owner.uuid].calls['fs.write']).toBeUndefined();
    if (stage === 'write') expect(fake.counters().calls['fs.getReadURL']).toBeUndefined();
  });
  it('reports identity cleanup requirements after a mid-request switch without deleting the replacement account', async () => {
    const { fake, puter: a, other: b } = world(); await register(fake);
    await b.fs.write(`dev/spike/${runId}/sentinel.txt`, 'preserve-b', { createMissingParents: true });
    const switching = switchingClient(a);
    const session = await createSpikeSession(sessionOptions(switching.puter));
    switching.after((group) => { if (group === 'workers') switching.switchTo(b); });
    expect(results(await session.request('auth', { permit: WORKER_PERMIT }))['worker.auth']).toMatchObject({ outcome: 'error', measurements: { cleanupRequired: true, originalAccountRequired: true } });
    expect(results(await session.cleanup({ permit: CLEANUP_PERMIT }))['cleanup.identity']).toMatchObject({ outcome: 'error', measurements: { cleanupRequired: true, originalAccountRequired: true } });
    expect(fake.counters().byUser[other.uuid].calls['fs.delete']).toBeUndefined();
    expect(await (await b.fs.read(`dev/spike/${runId}/sentinel.txt`)).text()).toBe('preserve-b');
    switching.switchTo(a);
    expect(results(await session.cleanup({ permit: CLEANUP_PERMIT }))['cleanup.identity'].outcome).toBe('pass');
  });
  it('runs owner-bound worker KV probes without browser session properties', async () => {
    const { fake, puter } = world();
    await fake.registerWorker(`trips-${runId}`, {
      owner, appUid: 'trips', setup({ router, me }) {
        delete me.puter.authToken; delete me.puter.auth.isSignedIn;
        const handler = createSpikeHandler({ me, crypto: webcrypto, environment });
        router.post('/probe', handler);
      },
    });
    const session = await createSpikeSession(sessionOptions(puter));
    const report = await session.request('kv', { permit: WORKER_PERMIT });
    expect(results(report)['cleanup.kv']).toMatchObject({ outcome: 'pass', measurements: { cleanupRequired: false, originalAccountRequired: false } });
    expect(report.results.every((item) => ['pass', 'pending'].includes(item.outcome))).toBe(true);
    await session.cleanup({ permit: CLEANUP_PERMIT });
  });
});
