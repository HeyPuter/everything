// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { K } from '../../worker/keys.js';
import { USERS, createHarness, id } from './harness.js';

const OWNER = USERS.alice.uuid;
/** Owner-paid calls since the last reset, by method. */
const owner = (h) => h.world.counters().byUser[OWNER]?.calls ?? {};
const kvCalls = (calls) => Object.entries(calls).filter(([method]) => method.startsWith('kv.') && method !== 'kv.share').reduce((n, [, count]) => n + count, 0);

async function setup(options) {
  const h = await createHarness(options);
  const space = await h.team({ bob: 'editor' });
  const bob = await h.client('bob');
  await bob.in(space).call('open');
  return { h, space, bob: bob.in(space), clients: { bob } };
}

describe('cost budgets (architecture §15)', () => {
  it('path C sync with no changes: ≤2 KV reads cold, 0 warm', async () => {
    const { h, bob } = await setup();
    h.advance(10_000);
    h.world.resetCounters();
    await bob.call('sync', { since: 2 });
    expect(owner(h)['kv.get']).toBe(1);
    expect(h.world.counters().byUser[OWNER].kvReadUnits).toBeLessThanOrEqual(2);
    expect(kvCalls(owner(h))).toBe(1);
    h.world.resetCounters();
    await bob.call('sync', { since: 2 });
    expect(kvCalls(owner(h))).toBe(0);
  });

  it('path C sync with k changes adds ⌈k/100⌉ batched gets', async () => {
    const { h, bob } = await setup();
    for (let i = 0; i < 150; i++) {
      await bob.call('commit', { ops: [{ opId: id('o'), t: 'guest', id: id('g'), put: { name: `G${i}` } }] });
      h.advance(1000);
    }
    h.advance(10_000);
    h.world.resetCounters();
    const result = await bob.call('sync', { since: 2 });
    expect(result.changes).toHaveLength(150);
    expect(owner(h)['kv.get']).toBeLessThanOrEqual(1 + Math.ceil(150 / 100));
    expect(kvCalls(owner(h))).toBe(owner(h)['kv.get']);
  });

  it('a commit of n patches costs 1 get + 1 incr + 1 conditional put + n writes + 1 op-id write + 1 signal', async () => {
    const { h, bob } = await setup({ onlyIfAbsent: true });
    const ids = Array.from({ length: 10 }, () => id('g'));
    await bob.call('commit', { ops: ids.map((gid) => ({ opId: id('o'), t: 'guest', id: gid, put: { name: 'G' } })) });
    h.advance(10_000);
    // The sync engine pulls right before it flushes, so the caller's member record is cached.
    await bob.call('sync', { since: 0 });
    h.world.resetCounters();
    await bob.call('commit', { ops: ids.map((gid) => ({ opId: id('o'), t: 'guest', id: gid, set: { name: 'H' } })) });
    const calls = owner(h);
    expect(calls['kv.get']).toBe(1);
    expect(calls['kv.incr']).toBe(1);
    expect(calls['kv.update']).toBe(10);
    expect(calls['kv.set']).toBe(3);
    expect(kvCalls(calls)).toBe(4 + 10 + 1);
  });

  it('a commit of n creates writes them in one batch plus one counter increment', async () => {
    const { h, bob } = await setup({ onlyIfAbsent: true });
    await bob.call('commit', { ops: [{ opId: id('o'), t: 'guest', id: id('g'), put: { name: 'warm' } }] });
    h.world.resetCounters();
    const n = 20;
    await bob.call('commit', { ops: Array.from({ length: n }, () => ({ opId: id('o'), t: 'guest', id: id('g'), put: { name: 'G' } })) });
    const calls = owner(h);
    expect(calls['kv.get']).toBe(1);
    expect(calls['kv.incr']).toBe(2);
    expect(calls['kv.set']).toBe(4);
    expect(kvCalls(calls)).toBeLessThanOrEqual(4 + n + 1);
  });

  it('worker presence: ≤1 write per member per 2 minutes; path A presence costs the owner nothing', async () => {
    const { h, space, bob, clients } = await setup({ shareHandles: true });
    h.world.resetCounters();
    for (let i = 0; i < 4; i++) { await bob.call('pres'); h.advance(30_000); }
    expect(owner(h)['kv.update']).toBe(1);
    const { handles } = await bob.call('open');
    h.world.resetCounters();
    await clients.bob.puter.kv.set('pres', { at: h.now(), view: 'plan' }, { handle: handles.write });
    await clients.bob.puter.kv.get('sig', { handle: handles.read });
    expect(kvCalls(owner(h))).toBe(0);
    expect(h.world.counters().byUser[USERS.bob.uuid].calls['kv.get']).toBe(1);
    expect(h.kv()[`${K.region(space, USERS.bob.uuid)}pres`]).toBeTruthy();
  });

  it('join: ≤10 KV ops + 2 handle mints (+2 file shares in direct mode)', async () => {
    const h = await createHarness({ shareHandles: true });
    const space = await h.trip();
    const alice = (await h.client('alice')).in(space);
    const { token } = await alice.call('invite.create', { role: 'editor', max: 2 });
    // The first direct-mode join also records the files mode once.
    await (await h.client('bob')).in(space).call('join', { token });
    const carol = (await h.client('carol')).in(space);
    h.advance(10_000);
    h.world.resetCounters();
    const joined = await carol.call('join', { token });
    expect(joined.handles).toBeTruthy();
    const calls = owner(h);
    expect(kvCalls(calls)).toBeLessThanOrEqual(10);
    expect(calls['kv.share']).toBe(2);
    expect(calls['fs.share']).toBe(2);
  });

  it('counter windows carry the window number in the key', async () => {
    const { h, space, bob } = await setup();
    await bob.call('repair', { since: 1 });
    await bob.call('invite.create', { role: 'viewer' }).catch(() => {});
    await (await h.client('dave')).in(space).call('join', { token: '0'.repeat(32) }).catch(() => {});
    const keys = Object.keys(h.kv());
    expect(keys.filter((key) => /:(snapclaim|rl|fail):/.test(key)).length).toBeGreaterThanOrEqual(2);
    for (const key of keys.filter((name) => /:(snapclaim|fail):/.test(name))) expect(key).toMatch(/:\d+$/);
    for (const key of keys.filter((name) => /:rl:/.test(name))) expect(key).toMatch(/:rl:[a-z]+:[^:]+:\d+$/);
  });

  it('snapshot rebuild of 2,000 entities: ≤3 list pages + 1 FS write', async () => {
    const { h, space, bob, clients } = await setup();
    const alice = await h.client('alice');
    // 1,997 guests plus meta and two members.
    for (let batch = 0; batch < 2; batch++) {
      await alice.puter.kv.set(Array.from({ length: batch ? 997 : 1000 }, (_, i) => {
        const gid = `g${String(batch * 1000 + i).padStart(15, '0')}`;
        return { key: K.entity(space, 'guest', gid), value: { name: 'G', id: gid, v: '0000000001:000000:0000000000000001', rev: 2, upd: 1, by: USERS.bob.uuid, cr: 1 } };
      }));
    }
    await alice.puter.kv.del(K.ch(space, 2, 0));
    h.advance(10_000);
    h.world.resetCounters();
    const repaired = await bob.call('repair', { since: 1 });
    expect(repaired.snap.rev).toBe(2);
    const calls = owner(h);
    expect(calls['kv.list']).toBeLessThanOrEqual(3);
    expect(calls['fs.write']).toBe(1);
    const snapshot = await clients.bob.api.snapshot({ w: 'trips-abcdefghij', s: space, k: 'trip' });
    expect(snapshot.ents.filter((entity) => entity.t === 'guest')).toHaveLength(1997);
    expect(h.kv()[K.count(space)]).toMatchObject({ e: 1997 });
  });
});
