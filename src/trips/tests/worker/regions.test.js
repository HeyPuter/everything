// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { K } from '../../worker/keys.js';
import { WORKER, createHarness, id } from './harness.js';

const place = (name) => ({ opId: id('o'), t: 'place', id: id('p'), put: { name } });

async function setup(onlyIfAbsent) {
  const h = await createHarness({ regions: 2, onlyIfAbsent, replicationDelay: 60_000 });
  const space = await h.team({ bob: 'editor' });
  h.world.flushReplication();
  h.advance(2000);
  const alice = (await h.client('alice', 0)).in(space);
  const bob = (await h.client('bob', 1)).in(space);
  return { h, space, alice, bob };
}

// Puter checks `onlyIfAbsent` against the writing region's copy, so the claim only sees revs that have replicated.
describe('regions: 2, conditional put checked per region', () => {
  it('re-increments past revs another region already wrote once they replicated', async () => {
    const { h, space, alice, bob } = await setup(true);
    for (const name of ['A1', 'A2', 'A3']) await alice.call('commit', { ops: [place(name)] });
    h.world.flushReplication();
    // Region 1's counter lags behind the records it already holds.
    await (await h.client('alice', 1)).puter.kv.set(K.rev(space), 2);
    const late = await bob.call('commit', { ops: [place('B')] });
    expect(late.rev).toBe(6);
    h.world.flushReplication();
    h.advance(2000);
    const synced = await alice.call('sync', { since: 2 });
    expect(synced.changes.map((change) => change.ents[0].name)).toEqual(['A1', 'A2', 'A3', 'B']);
  });

  it('lets two regions claim the same rev before replication, and a full-scan snapshot repairs the lost record', async () => {
    const { h, space, alice, bob } = await setup(true);
    const [a, b] = await Promise.all([alice.call('commit', { ops: [place('A')] }), bob.call('commit', { ops: [place('B')] })]);
    expect(a.rev).toBe(b.rev);
    h.world.flushReplication();
    h.advance(2000);
    const synced = await alice.call('sync', { since: 2 });
    expect(synced.changes).toHaveLength(1);
    const names = Object.entries(h.kv(0)).filter(([key]) => key.startsWith(`shared:${space}:e:place:`)).map(([, value]) => value.name).sort();
    expect(names).toEqual(['A', 'B']);
    // The surviving record is contiguous, so repair has nothing to fix; the next full scan does.
    expect((await alice.call('repair', { since: 2 })).snap).toBeNull();
    const snapshot = await (await h.client('alice', 0)).api.snapshot({ w: WORKER, s: space, k: 'trip' });
    expect(snapshot.ents.filter((entity) => entity.t === 'place').map((entity) => entity.name).sort()).toEqual(['A', 'B']);
    // Clients that never reload the snapshot get the lost change through a fresh record.
    h.world.flushReplication();
    h.advance(2000);
    const healed = await bob.call('sync', { since: 2 });
    expect(healed.changes.flatMap((change) => change.ents).filter((entity) => entity.t === 'place').map((entity) => entity.name).sort()).toEqual(['A', 'B']);
  });

  it('behaves the same on a server that ignores onlyIfAbsent', async () => {
    const { alice, bob } = await setup(false);
    const [a, b] = await Promise.all([alice.call('commit', { ops: [place('A')] }), bob.call('commit', { ops: [place('B')] })]);
    expect(a.rev).toBe(b.rev);
  });

  it('converges one entity across regions when both patch it (last writer wins per item)', async () => {
    const { h, space, alice, bob } = await setup(false);
    const eid = id('p');
    await alice.call('commit', { ops: [{ opId: id('o'), t: 'place', id: eid, put: { name: 'Base' } }] });
    h.world.flushReplication();
    h.advance(2000);
    await Promise.all([
      alice.call('commit', { ops: [{ opId: id('o'), t: 'place', id: eid, set: { phone: '1' } }] }),
      bob.call('commit', { ops: [{ opId: id('o'), t: 'place', id: eid, set: { phone: '2' } }] }),
    ]);
    h.world.flushReplication();
    expect(h.kv(0)[K.entity(space, 'place', eid)]).toEqual(h.kv(1)[K.entity(space, 'place', eid)]);
  });
});
