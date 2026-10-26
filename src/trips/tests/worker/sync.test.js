// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { gunzip } from '../../worker/engine/snapshot.js';
import { K, P } from '../../worker/keys.js';
import { USERS, createHarness, expectError, id } from './harness.js';

const place = (name = 'Spot', eid = id('p')) => ({ opId: id('o'), t: 'place', id: eid, put: { name } });

async function setup(options) {
  const h = await createHarness(options);
  const space = await h.team({ bob: 'editor' });
  const alice = await h.client('alice');
  const bob = await h.client('bob');
  return { h, space, alice: alice.in(space), bob: bob.in(space), clients: { alice, bob } };
}

describe('sync', () => {
  it('returns change records in rev order with entities and tombstones', async () => {
    const { bob, alice } = await setup();
    const eid = id('p');
    await bob.call('commit', { ops: [place('A', eid)] });
    await bob.call('commit', { ops: [{ opId: id('o'), t: 'place', id: eid, del: true }] });
    const result = await alice.call('sync', { since: 2 });
    expect(result.rev).toBe(4);
    expect(result.changes.map((change) => change.rev)).toEqual([3, 4]);
    // The delete scrubs the earlier version out of record 3.
    expect(result.changes[0]).toMatchObject({ by: USERS.bob.uuid, ents: [], del: [], sum: [{ t: 'place', id: eid, op: 'put', name: '' }] });
    expect(result.changes[1]).toMatchObject({ ents: [], del: [{ t: 'place', id: eid }], sum: [{ op: 'del', name: 'A', prev: 3 }] });
    expect(await alice.call('sync', { since: 4 })).toEqual({ ok: true, rev: 4, changes: [] });
    expect((await alice.call('sync', { since: 9 })).rev).toBe(9);
  });

  it('returns only the contiguous prefix when a record is missing', async () => {
    const { h, space, alice, bob, clients } = await setup();
    for (let i = 0; i < 4; i++) await bob.call('commit', { ops: [place(`P${i}`)] });
    await clients.alice.puter.kv.del(K.ch(space, 5, 0));
    h.advance(2000);
    const result = await alice.call('sync', { since: 2 });
    expect(result.rev).toBe(6);
    expect(result.changes.map((change) => change.rev)).toEqual([3, 4]);
    expect(result.more).toBeUndefined();
    const gap = await alice.call('sync', { since: 4 });
    expect(gap.changes).toEqual([]);
    const repaired = await alice.call('repair', { since: 4 });
    expect(repaired.snap.rev).toBe(6);
    expect(await alice.call('sync', { since: 4 })).toMatchObject({ reset: true, rev: 6 });
  });

  it('assembles multi-chunk records and withholds them until every chunk is readable', async () => {
    const { h, space, alice, bob, clients } = await setup();
    const ops = Array.from({ length: 30 }, (_, i) => ({ opId: id('o'), t: 'place', id: id('p'), put: { name: `P${i}`, notes: 'x'.repeat(8000) } }));
    const { rev } = await bob.call('commit', { ops });
    const head = h.kv()[K.ch(space, rev, 0)];
    expect(head.parts).toBeGreaterThan(1);
    const full = await alice.call('sync', { since: rev - 1 });
    expect(full.changes[0].ents).toHaveLength(30);
    expect(full.changes[0].sum).toHaveLength(30);
    await clients.alice.puter.kv.del(K.ch(space, rev, head.parts - 1));
    h.advance(2000);
    expect((await alice.call('sync', { since: rev - 1 })).changes).toEqual([]);
  });

  it('resets when the client is behind the retained log', async () => {
    const { h, space, alice, clients } = await setup();
    await clients.alice.puter.kv.set(K.rev(space), 2500);
    h.advance(2000);
    expect(await alice.call('sync', { since: 1 })).toMatchObject({ reset: true, rev: 2500 });
  });

  it('caps one response at 500 records and flags more', async () => {
    const { h, space, alice, clients } = await setup();
    const items = Array.from({ length: 598 }, (_, i) => ({ key: K.ch(space, i + 3, 0), value: { rev: i + 3, parts: 1, at: 1, by: USERS.bob.uuid, ents: [], del: [], sum: [] } }));
    await clients.alice.puter.kv.set(items);
    await clients.alice.puter.kv.set(K.rev(space), 600);
    h.advance(2000);
    const result = await alice.call('sync', { since: 0 });
    expect(result.rev).toBe(600);
    expect(result.changes).toHaveLength(500);
    expect(result.more).toBe(true);
    const rest = await alice.call('sync', { since: 560 });
    expect(rest.changes).toHaveLength(40);
    expect(rest.more).toBeUndefined();
    // The snapshot the first call rebuilt covers the rest, so a long catch-up reloads from it.
    expect(await alice.call('sync', { since: 500 })).toMatchObject({ reset: true, rev: 600 });
  });

  it('refuses non-members and removed members', async () => {
    const { h, space, alice } = await setup();
    const dave = await h.client('dave');
    await expectError(dave.in(space).call('sync', { since: 0 }), 403, 'not_member');
    await alice.call('member.remove', { uuid: USERS.bob.uuid });
    h.advance(2000);
    const bob = await h.client('bob');
    await expectError(bob.in(space).call('sync', { since: 0 }), 403, 'not_member');
    await expectError(dave.in(id('s')).call('sync', { since: 0 }), 404, 'space_not_found');
  });
});

describe('snapshot', () => {
  it('streams gzip JSON the client store can replace from', async () => {
    const { h, space, alice, bob, clients } = await setup();
    const eid = id('p');
    await bob.call('commit', { ops: [place('Kept', eid), place('Gone')] });
    await bob.call('commit', { ops: [{ opId: id('o'), t: 'msg', id: id('m'), put: { text: 'hi' } }] });
    const snapshot = await clients.bob.api.snapshot({ w: 'trips-abcdefghij', s: space, k: 'trip' });
    expect(snapshot.rev).toBe(4);
    expect(snapshot.kind).toBe('trip');
    expect(snapshot.ents.map((entity) => entity.t).sort()).toEqual(['member', 'member', 'meta', 'msg', 'place', 'place']);
    expect(snapshot.ents.find((entity) => entity.t === 'meta')).toMatchObject({ title: 'Lisbon', id: 'meta' });
    const file = await clients.alice.puter.fs.read(P.snapshot(space));
    expect(JSON.parse(await gunzip(new Uint8Array(await file.arrayBuffer()))).rev).toBe(4);
    expect(JSON.stringify(snapshot)).not.toContain('shareTokenHash');
    await alice.call('commit', { ops: [{ opId: id('o'), t: 'place', id: eid, del: true }] });
    h.advance(121_000);
    await alice.call('repair', { since: 4 });
    expect(h.kv()[K.snap(space)].rev).toBe(4);
  });

  it('rebuilds once per claim window and in the background after 200 revs', async () => {
    const { h, space, alice, clients } = await setup();
    await clients.alice.puter.kv.set(K.rev(space), 2);
    expect((await alice.call('repair', { since: 2 })).snap).toBeNull();
    await clients.alice.puter.kv.del(K.ch(space, 2, 0));
    h.advance(2000);
    const first = await alice.call('repair', { since: 1 });
    expect(first.snap.rev).toBe(2);
    h.advance(2000);
    const second = await alice.call('repair', { since: 1 });
    expect(second.snap.at).toBe(first.snap.at);
    expect(Object.keys(h.kv()).filter((key) => key.includes(':snapclaim:'))).toHaveLength(1);
  });

  it('finds nothing to re-announce after ordinary commits, member changes, shares and files', async () => {
    const { h, space, alice, bob, clients } = await setup();
    const carol = await h.client('carol');
    const { token } = await alice.call('invite.create', { role: 'viewer' });
    await carol.in(space).call('join', { token });
    const eid = id('p');
    const msg = id('m');
    const poll = id('q');
    await bob.call('commit', { ops: [place('Nested', eid), { opId: id('o'), t: 'msg', id: msg, put: { text: 'hi' } }, { opId: id('o'), t: 'poll', id: poll, put: { question: 'Q?', options: ['a', 'b'] } }] });
    await bob.call('commit', { ops: [{ opId: id('o'), t: 'place', id: eid, set: { [`rating.${USERS.bob.uuid}`]: 4, 'price.amount': 5, 'price.currency': 'EUR', phone: '1' } }] });
    await bob.call('commit', { ops: [{ opId: id('o'), t: 'place', id: eid, unset: ['phone'] }, { opId: id('o'), t: 'poll', id: poll, set: { [`votes.${USERS.bob.uuid}`]: [1] } }] });
    await bob.call('commit', { ops: [{ opId: id('o'), t: 'msg', id: msg, del: true }, place('Removed', id('p'))] });
    await alice.call('member.role', { uuid: USERS.carol.uuid, role: 'editor' });
    await alice.call('share.set', { on: true, plan: true });
    const fileId = id('f');
    await clients.bob.raw('PUT', `/files/${space}/${fileId}`, { body: new TextEncoder().encode('notes'), signed: `PUT /files/${space}/${fileId}` });
    await bob.call('file.put', { fileId, name: 'a.txt', mime: 'text/plain', sha256: 'a'.repeat(64), kind: 'user' });
    await bob.call('file.del', { fileId });
    await alice.call('member.remove', { uuid: USERS.carol.uuid });
    await h.settle();
    h.advance(180_000);
    const rev = h.kv()[K.rev(space)];
    await clients.bob.api.snapshot({ w: 'trips-abcdefghij', s: space, k: 'trip' });
    expect(h.kv()[K.rev(space)]).toBe(rev);
  });

  it('re-announces entities whose KV state no change record shows', async () => {
    const { h, space, bob, clients } = await setup();
    const merged = id('p');
    const deleted = id('p');
    await bob.call('commit', { ops: [place('Base', merged), place('Kept', deleted)] });
    const rev = h.kv()[K.rev(space)];
    // Concurrent path writes merged a field in KV, and a delete whose record another region overwrote.
    await clients.alice.puter.kv.update(K.entity(space, 'place', merged), { phone: '123' });
    const live = h.kv()[K.entity(space, 'place', deleted)];
    await clients.alice.puter.kv.set(K.entity(space, 'place', deleted), { id: deleted, t: 'place', deleted: true, rev, v: live.v });
    h.advance(2000);
    await clients.bob.api.snapshot({ w: 'trips-abcdefghij', s: space, k: 'trip' });
    h.advance(2000);
    const [healed] = (await bob.call('sync', { since: rev })).changes;
    expect(healed.rev).toBe(rev + 1);
    expect(healed.ents).toEqual([expect.objectContaining({ id: merged, name: 'Base', phone: '123' })]);
    expect(healed.del).toEqual([expect.objectContaining({ t: 'place', id: deleted })]);
    expect(h.kv()[K.entity(space, 'place', merged)]).toMatchObject({ phone: '123', v: healed.ents[0].v, rev: rev + 1 });
    expect(h.kv()[K.entity(space, 'place', deleted)]).toMatchObject({ deleted: true, rev: rev + 1 });
    // Once re-announced, the next rebuild finds the records and KV in agreement.
    h.advance(600_000);
    await bob.call('sync', { since: rev });
    await h.settle();
    expect(h.kv()[K.snap(space)].rev).toBe(rev + 1);
    expect(h.kv()[K.rev(space)]).toBe(rev + 1);
  });

  it('serves chat pages newest first and keeps the last 200 messages in the snapshot', async () => {
    const { h, space, bob, clients } = await setup();
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const mid = `m0000000000000${String(i).padStart(2, '0')}`;
      ids.push(mid);
      await bob.call('commit', { ops: [{ opId: id('o'), t: 'msg', id: mid, put: { text: `m${i}` } }] });
    }
    const page = await bob.call('chat.page', { before: ids[3], limit: 2 });
    expect(page.msgs.map((msg) => msg.id)).toEqual([ids[2], ids[1]]);
    expect(page.more).toBe(true);
    expect(page.msgs[0].t).toBe('msg');
    const snapshot = await clients.bob.api.snapshot({ w: 'trips-abcdefghij', s: space, k: 'trip' });
    expect(snapshot.ents.filter((entity) => entity.t === 'msg')).toHaveLength(5);
    expect(h).toBeTruthy();
  });
});

describe('heads, open and presence', () => {
  it('reports heads for member spaces only', async () => {
    const { h, space } = await setup();
    const other = await h.trip({ title: 'Solo', currency: 'EUR' });
    const bob = await h.client('bob');
    const result = await bob.call('heads', { spaces: [space, other, id('s')] });
    expect(Object.keys(result.heads)).toEqual([space]);
    expect(result.heads[space]).toEqual({ rev: 2, title: 'Lisbon', start: '2027-05-01', end: '2027-05-04', role: 'editor' });
    await expectError(bob.call('heads', { spaces: ['bad'] }), 400);
  });

  it('reports a meta change in heads right after the commit', async () => {
    const { space, alice, bob } = await setup();
    await bob.call('heads', { spaces: [space] });
    const { rev } = await alice.call('commit', { ops: [{ opId: id('o'), t: 'meta', id: 'meta', set: { title: 'Lisbon and Sintra' } }] });
    expect((await bob.call('heads', { spaces: [space] })).heads[space]).toMatchObject({ rev, title: 'Lisbon and Sintra' });
  });

  it('opens with role, rev, protocol and files mode', async () => {
    const { alice, bob } = await setup();
    expect(await bob.call('open')).toMatchObject({ kind: 'trip', role: 'editor', rev: 2, protocol: 1, files: { mode: 'direct' } });
    expect(await alice.call('open')).toMatchObject({ role: 'owner', files: { mode: 'direct', uid: expect.any(String), inbox: expect.any(String) } });
  });

  it('records worker presence at most once per two minutes per member', async () => {
    const { h, space, alice, bob } = await setup();
    h.world.resetCounters();
    expect(Object.keys((await bob.call('pres')).active)).toEqual([USERS.bob.uuid]);
    await bob.call('pres');
    h.advance(60_000);
    await bob.call('pres');
    expect(h.world.counters().calls['kv.update']).toBe(1);
    h.advance(61_000);
    await bob.call('pres');
    expect(h.world.counters().calls['kv.update']).toBe(2);
    const { active } = await alice.call('pres');
    expect(Object.keys(active).sort()).toEqual([USERS.alice.uuid, USERS.bob.uuid]);
    expect(active[USERS.bob.uuid]).toBe(h.now());
    expect(h.kv()[K.pres(space)]).toHaveProperty(USERS.bob.uuid);
  });
});
