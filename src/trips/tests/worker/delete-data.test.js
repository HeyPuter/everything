// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { install } from '../../worker/app.js';
import { KNOWN_FOLDERS, buildPlan, deletionSteps, runDeletion, runStep } from '../../src/views/settings/delete-data.js';
import { USERS, WORKER, createHarness, expectError, id } from './harness.js';

const BOB_WORKER = 'trips-bobbbbbbbb';

async function world() {
  const h = await createHarness();
  await h.world.registerWorker(BOB_WORKER, { owner: USERS.bob.uuid, region: 0, setup: ({ router, me }) => install({ router, me, options: { now: h.now, build: 'test000007', builtAt: 1_700_000_000_000 } }) });
  const alice = await h.client('alice');
  const bob = await h.client('bob');
  const carol = await h.client('carol');
  // Alice owns Lisbon with Bob; Bob owns Porto with Alice and Carol.
  const lisbon = await h.team({ bob: 'editor' });
  const onBob = (client, input) => client.api.request(BOB_WORKER, JSON.stringify(input));
  const { space: porto } = await onBob(bob, { op: 'space.create', kind: 'trip', meta: { title: 'Porto', currency: 'EUR' } });
  for (const client of [alice, carol]) {
    const { token } = await onBob(bob, { op: 'invite.create', space: porto, role: 'editor' });
    await onBob(client, { op: 'join', space: porto, token });
  }
  const tpl = id('t');
  await alice.puter.kv.set('me:worker', { name: WORKER, url: `https://${WORKER}.puter.work`, path: '/alice/AppData/x/worker/trips-worker.js', build: 'test000007', builtAt: 1 });
  await alice.puter.kv.set('me:spaces', [
    { ref: { w: WORKER, s: lisbon, k: 'trip' }, role: 'owner', title: 'Lisbon' },
    { ref: { w: BOB_WORKER, s: porto, k: 'trip' }, role: 'editor', title: 'Porto' },
    { ref: { w: 'trips-gonegonego', s: id('s'), k: 'trip' }, role: 'owner', title: 'Lost' },
  ]);
  await alice.puter.kv.set('me:prefs', { theme: 'dark' });
  await alice.puter.kv.set('me:tpls', { [tpl]: { kind: 'pack', name: 'Beach' } });
  await alice.puter.kv.set(`me:tpl:${tpl}`, { kind: 'pack', name: 'Beach', lists: [] });
  await alice.puter.kv.set(`me:priv:${lisbon}:pack`, { a: { id: 'a', name: 'Socks' } });
  await alice.puter.kv.set('me:import:abc', { queued: true });
  await alice.puter.fs.write('exports/calendar/Lisbon.ics', new Blob(['BEGIN:VCALENDAR']), { createMissingParents: true });
  return { h, alice, bob, carol, lisbon, porto, onBob };
}

describe('delete all my Trips data', () => {
  it('plans exactly what goes: owned trips and server, joined trips to leave, storage and folders', async () => {
    const { alice, lisbon, porto } = await world();
    const plan = await buildPlan({ puter: alice.puter, api: alice.api });
    expect(plan.failed).toEqual([]);
    expect(plan.workers).toEqual([{ name: WORKER, spaces: [{ id: lisbon, kind: 'trip', title: 'Lisbon' }] }]);
    expect(plan.joined).toEqual([{ ref: { w: BOB_WORKER, s: porto, k: 'trip' }, title: 'Porto', role: 'editor' }]);
    expect(plan.orphans.map((trip) => trip.title)).toEqual(['Lost']);
    expect(plan.personal).toMatchObject({ templates: 1, privateTrips: 1 });
    expect(plan.personal.keys).toEqual(expect.arrayContaining(['me:prefs', 'me:worker', 'me:spaces', 'me:tpls', `me:priv:${lisbon}:pack`]));
    expect(plan.folders).toEqual(expect.arrayContaining(['exports', 'identity']));
    expect(deletionSteps(plan).map((step) => step.kind)).toEqual(['leave', 'space', 'worker', 'files', 'notify', 'vacay', 'storage', 'device']);
  });

  it('leaves trips owned by others, deletes owned ones for everyone, then servers, files and storage', async () => {
    const { h, alice, bob, carol, lisbon, porto, onBob } = await world();
    const plan = await buildPlan({ puter: alice.puter, api: alice.api });
    const steps = deletionSteps(plan);
    const seen = [];
    const storage = { 'trips:notify': '{}', 'trips:collab:section': 'chat', other: 'keep', removeItem(key) { delete this[key]; } };
    const result = await runDeletion(steps, { api: alice.api, puter: alice.puter, account: USERS.alice.uuid, storage, indexedDB: { deleteDatabase: vi.fn() }, caches: null },
      { onStep: (step, state) => seen.push(`${step.kind}:${state}`) });
    expect(result.failed).toBeNull();
    expect(seen.filter((entry) => entry.endsWith(':done')).map((entry) => entry.split(':')[0])).toEqual(['leave', 'space', 'worker', 'files', 'notify', 'vacay', 'storage', 'device']);
    await h.settle();
    // Porto stays for Bob and Carol; Alice is no longer in it.
    expect((await onBob(carol, { op: 'open', space: porto })).role).toBe('editor');
    await expectError(onBob(bob, { op: 'member.role', space: porto, uuid: USERS.alice.uuid, role: 'viewer' }), 404);
    // Lisbon is gone for Bob too.
    await expectError(bob.in(lisbon).call('open'), 404);
    expect(await alice.puter.kv.get('me:prefs')).toBeFalsy();
    expect(await alice.puter.kv.get('me:import:abc')).toBeFalsy();
    await expect(alice.puter.fs.stat('exports/calendar/Lisbon.ics')).rejects.toBeTruthy();
    expect(storage).toEqual({ other: 'keep', removeItem: storage.removeItem });
  });

  it('can run every server step again after a partial failure', async () => {
    const { alice } = await world();
    const steps = deletionSteps(await buildPlan({ puter: alice.puter, api: alice.api }));
    const deps = { api: alice.api, puter: alice.puter, account: USERS.alice.uuid };
    const first = await runDeletion(steps.slice(0, 2), deps);
    expect(first.failed).toBeNull();
    const again = await runDeletion(steps.slice(0, 2), deps);
    expect(again.failed).toBeNull();
  });

  it('stops at the first failing step and resumes there', async () => {
    const calls = [];
    const api = { call: vi.fn(async () => { calls.push('leave'); throw Object.assign(new Error('network'), { status: 0, code: 'network' }); }), request: vi.fn() };
    const puter = { workers: { delete: vi.fn() }, fs: { delete: vi.fn() }, kv: { flush: vi.fn(), get: vi.fn(async (key) => (Array.isArray(key) ? key.map(() => null) : null)), del: vi.fn(async () => true), listSharedByMe: vi.fn(async () => ({ items: [] })) } };
    const plan = { joined: [{ ref: { w: BOB_WORKER, s: '0000000000000001', k: 'trip' }, title: 'Porto' }], workers: [], folders: null, personal: { keys: [] } };
    const steps = deletionSteps(plan);
    const done = new Set();
    const failed = await runDeletion(steps, { api, puter, account: USERS.alice.uuid, storage: null, caches: null, indexedDB: null }, { done });
    expect(failed.failed.kind).toBe('leave');
    expect(puter.kv.flush).not.toHaveBeenCalled();
    api.call.mockResolvedValue({ ok: true });
    const resumed = await runDeletion(steps, { api, puter, account: USERS.alice.uuid, storage: null, caches: null, indexedDB: null }, { done });
    expect(resumed.failed).toBeNull();
    expect(puter.fs.delete.mock.calls.map(([name]) => name)).toEqual(KNOWN_FOLDERS);
    expect(puter.kv.flush).toHaveBeenCalledTimes(1);
  });

  it('treats a server that is already gone as done and refuses to plan around one it cannot reach', async () => {
    await runStep({ kind: 'worker', worker: WORKER }, { puter: { workers: { delete: async () => { throw Object.assign(new Error('x'), { status: 404, code: 'worker_not_found' }); } } } });
    const puter = { kv: { get: async (key) => (key === 'me:worker' ? { name: WORKER, path: 'p' } : null) }, workers: { list: async () => [] }, fs: { readdir: async () => [] } };
    const plan = await buildPlan({ puter, api: { request: async () => { throw Object.assign(new Error('x'), { status: 402, code: 'owner_credit' }); } } });
    expect(plan.failed).toEqual([{ worker: WORKER, code: 'owner_credit', status: 402 }]);
  });
});
