// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { gunzip } from '../../worker/engine/snapshot.js';
import { K } from '../../worker/keys.js';
import { ORIGIN, USERS, createHarness, expectError, id } from './harness.js';

const anonymous = async (h, path) => (await h.client('dave')).puter.workers.exec(ORIGIN + path, { headers: { 'x-puter-no-auth': '1' } });
const owner = (h) => h.world.counters().byUser[USERS.alice.uuid]?.calls ?? {};

describe('space lifecycle', () => {
  it('lets only the worker owner create spaces, idempotently by client id', async () => {
    const h = await createHarness();
    const alice = await h.client('alice');
    const bob = await h.client('bob');
    const meta = { title: 'Rome', currency: 'EUR' };
    await expectError(bob.call('space.create', { kind: 'trip', meta }), 403, 'forbidden');
    await expectError(alice.call('space.create', { kind: 'trip', meta: { title: '' } }), 400);
    await expectError(alice.call('space.create', { kind: 'nope', meta }), 400, 'invalid_kind');
    const sid = id('s');
    const first = await alice.call('space.create', { kind: 'trip', meta, space: sid });
    const again = await alice.call('space.create', { kind: 'trip', meta, space: sid });
    expect(again).toEqual(first);
    await expectError(alice.call('space.create', { kind: 'collection', meta: { name: 'X' }, space: sid }), 409, 'exists');
    expect(h.kv().cfg).toMatchObject({ owner: USERS.alice.uuid });
    expect(h.kv()[K.member(sid, USERS.alice.uuid)]).toMatchObject({ role: 'owner' });
    const collection = await alice.call('space.create', { kind: 'collection', meta: { name: 'Saved' } });
    expect((await alice.call('space.list')).spaces.map((space) => space.kind).sort()).toEqual(['collection', 'trip']);
    expect((await alice.call('heads', { spaces: [collection.space] })).heads[collection.space].title).toBe('Saved');
    await expectError(bob.call('space.list'), 403);
  });

  it('enforces the per-worker space cap', async () => {
    const h = await createHarness();
    const alice = await h.client('alice');
    await alice.puter.kv.set(K.idx, Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`s${String(i).padStart(15, '0')}`, { k: 'trip', created: 1 }])));
    await expectError(alice.call('space.create', { kind: 'trip', meta: { title: 'One more', currency: 'EUR' } }), 409, 'space_limit');
  });

  it('exports every entity, message and member for the owner only', async () => {
    const h = await createHarness();
    const space = await h.team({ bob: 'editor' });
    const bob = await h.client('bob');
    for (let i = 0; i < 3; i++) await bob.in(space).call('commit', { ops: [{ opId: id('o'), t: 'msg', id: id('m'), put: { text: `m${i}` } }] });
    await expectError(bob.in(space).call('space.export'), 403);
    const alice = await h.client('alice');
    const response = await alice.raw('POST', '/api', { body: JSON.stringify({ op: 'space.export', space }) });
    const exported = JSON.parse(await gunzip(new Uint8Array(await response.arrayBuffer())));
    expect(exported).toMatchObject({ format: 'trips-export', version: 1, space, kind: 'trip' });
    expect(exported.ents.filter((entity) => entity.t === 'msg')).toHaveLength(3);
    expect(exported.members.map((member) => member.username).sort()).toEqual(['alice', 'bob']);
    expect(JSON.stringify(exported)).not.toContain('shareTokenHash');
  });

  it('deletes a space: access ends at once, a failed delete can be retried, and purges resume', async () => {
    const h = await createHarness();
    const space = await h.team({ bob: 'editor' });
    const alice = (await h.client('alice')).in(space);
    const bob = (await h.client('bob')).in(space);
    const { token } = await alice.call('share.set', { on: true, plan: true });
    expect((await anonymous(h, `/pub/${space}/${token}`)).status).toBe(200);
    await expectError(bob.call('space.delete'), 403);
    h.world.failNext({ method: 'kv.list', as: USERS.alice.uuid, status: 503, code: 'unavailable' });
    await expectError(alice.call('space.delete'), 500);
    expect((await alice.call('open')).role).toBe('owner');
    await alice.call('space.delete');
    await h.settle();
    h.advance(31_000);
    expect((await anonymous(h, `/pub/${space}/${token}`)).status).toBe(404);
    await expectError(bob.call('open'), 404, 'space_not_found');
    expect(Object.keys(h.kv()).filter((key) => key.includes(space))).toEqual([K.acl(space)]);
    expect(h.kv()[K.purge]).toEqual({});
    const second = await h.team({ bob: 'editor' });
    const owner2 = (await h.client('alice')).in(second);
    const link = (await owner2.call('share.set', { on: true })).token;
    // Fail at the first write (secrets) and at a member removal; each retry resumes.
    h.world.failNext({ method: 'kv.set', as: USERS.alice.uuid, status: 503, code: 'unavailable' });
    await expectError(owner2.call('space.delete'), 500);
    h.world.failNext({ method: 'kv.update', as: USERS.alice.uuid, status: 503, code: 'unavailable' });
    await expectError(owner2.call('space.delete'), 500);
    expect((await owner2.call('open')).role).toBe('owner');
    h.advance(31_000);
    expect((await anonymous(h, `/pub/${second}/${link}`)).status).toBe(404);
    expect((await owner2.call('space.delete')).deleted).toBe(true);
    await h.settle();
    const leftover = id('s');
    const owner = await h.client('alice');
    await owner.puter.kv.set(`shared:${leftover}:e:guest:${id('g')}`, { name: 'x' });
    await owner.puter.kv.set(K.purge, { [leftover]: 1 });
    await owner.call('space.list');
    await h.settle();
    expect(Object.keys(h.kv()).filter((key) => key.includes(leftover))).toEqual([]);
    expect(h.kv()[K.purge]).toEqual({});
  });
});

describe('outsiders cost the owner nothing', () => {
  it('rejects non-member commits before the batched read and stops reading after repeated denials', async () => {
    const h = await createHarness();
    const space = await h.trip();
    const dave = (await h.client('dave')).in(space);
    h.advance(2000);
    h.world.resetCounters();
    await expectError(dave.call('commit', { ops: Array.from({ length: 200 }, () => ({ opId: id('o'), t: 'guest', id: id('g'), put: { name: 'x' } })) }), 403, 'not_member');
    expect(h.world.counters().byUser[USERS.alice.uuid].kvReadUnits).toBeLessThanOrEqual(2);
    for (let i = 0; i < 40; i++) await dave.call('sync', { since: 0 }).catch(() => {});
    const reads = owner(h)['kv.get'];
    await expectError(dave.call('sync', { since: 0 }), 429, 'rate_limited');
    expect(owner(h)['kv.get']).toBe(reads);
  });

  it('answers heads, /pub and /ics for unknown spaces without reading them', async () => {
    const h = await createHarness();
    const space = await h.trip();
    const bob = await h.client('bob');
    await bob.call('heads', { spaces: [space] });
    h.world.resetCounters();
    expect((await bob.call('heads', { spaces: Array.from({ length: 50 }, () => id('s')) })).heads).toEqual({});
    for (let i = 0; i < 5; i++) {
      expect((await anonymous(h, `/pub/${id('s')}/${'0'.repeat(32)}`)).status).toBe(404);
      expect((await anonymous(h, `/ics/${id('s')}/${USERS.bob.uuid}/${'0'.repeat(32)}.ics`)).status).toBe(404);
    }
    expect(owner(h)['kv.get'] ?? 0).toBeLessThanOrEqual(1);
  });

  it('refuses unknown space ids on every member and join path without reading them', async () => {
    const h = await createHarness();
    await h.trip();
    const dave = await h.client('dave');
    h.world.resetCounters();
    for (let i = 0; i < 6; i++) {
      const unknown = dave.in(id('s'));
      await expectError(unknown.call('open'), 404, 'space_not_found');
      await expectError(unknown.call('sync', { since: 0 }), 404, 'space_not_found');
      await expectError(unknown.call('join', { token: '0'.repeat(32) }), 404, 'space_not_found');
      await expectError(unknown.call('join.preview', { token: '0'.repeat(32) }), 404, 'space_not_found');
      await expectError(unknown.call('invite.decline', { invite: '0'.repeat(32) }), 404, 'space_not_found');
    }
    expect(owner(h)['kv.get'] ?? 0).toBe(0);
    expect(owner(h)['kv.incr'] ?? 0).toBe(0);
  });

  it('rate-limits invite declines per account', async () => {
    const h = await createHarness();
    const space = await h.trip();
    const dave = (await h.client('dave')).in(space);
    for (let i = 0; i < 20; i++) await expectError(dave.call('invite.decline', { invite: String(i).padStart(32, '0') }), 404, 'not_found');
    h.world.resetCounters();
    await expectError(dave.call('invite.decline', { invite: 'f'.repeat(32) }), 429, 'rate_limited');
    expect(owner(h)['kv.get'] ?? 0).toBe(0);
  });
});

describe('space index', () => {
  it('re-indexes a live space whose idx entry was lost when its owner opens it', async () => {
    const h = await createHarness();
    const space = await h.team({ bob: 'editor' });
    const alice = await h.client('alice');
    const bob = (await h.client('bob')).in(space);
    // A concurrent idx write in another region won last-writer-wins and dropped this space.
    await alice.puter.kv.set(K.idx, {});
    h.advance(31_000);
    await expectError(bob.call('open'), 404, 'space_not_found');
    expect((await alice.in(space).call('open')).role).toBe('owner');
    expect(h.kv()[K.idx]).toHaveProperty(space);
    expect((await bob.call('open')).role).toBe('editor');
    expect((await alice.call('space.list')).spaces.map((item) => item.id)).toEqual([space]);
  });

  it('finishes the idx write when a create is retried after it failed there', async () => {
    const h = await createHarness();
    const alice = await h.client('alice');
    const space = id('s');
    const input = { kind: 'trip', space, meta: { title: 'Porto', currency: 'EUR' } };
    h.world.failNext({ method: 'kv.update', as: USERS.alice.uuid, status: 503, code: 'unavailable' });
    await expectError(alice.call('space.create', input), 500);
    expect(h.kv()[K.acl(space)]).toBeTruthy();
    expect(h.kv()[K.idx] ?? {}).not.toHaveProperty(space);
    expect((await alice.call('space.create', input)).space).toBe(space);
    expect(h.kv()[K.idx]).toHaveProperty(space);
    const { token } = await alice.in(space).call('invite.create', { role: 'viewer' });
    expect((await (await h.client('bob')).in(space).call('join', { token })).role).toBe('viewer');
  });
});
