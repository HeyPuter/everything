// @vitest-environment node
import { describe, expect, it } from 'vitest';
import touch from '../../worker/ops/test/touch.js';
import { DomainError } from '../../src/shared/errors.js';
import { K } from '../../worker/keys.js';
import { USERS, createHarness, expectError, id } from './harness.js';

const put = (t, fields, eid = id(t)) => ({ opId: id('o'), t, id: eid, put: fields });
const set = (t, eid, fields, extra = {}) => ({ opId: id('o'), t, id: eid, set: fields, ...extra });
const del = (t, eid, extra = {}) => ({ opId: id('o'), t, id: eid, del: true, ...extra });

async function setup(options = {}) {
  const h = await createHarness(options);
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((name) => h.client(name)));
  const as = (client) => (ops) => client.in(space).call('commit', { ops });
  if (options.viewersPost) {
    await as(alice)([set('meta', 'meta', { perms: { 'collab.post': 'viewer' } })]);
    h.advance(6000);
  }
  return { h, space, alice: as(alice), bob: as(bob), carol: as(carol), clients: { alice, bob, carol } };
}

const SAMPLES = {
  day: { order: 'a', date: '2027-05-01' },
  place: { name: 'Café' },
  visit: { dayId: '0000000000000001', placeId: null, order: 'a', title: 'Walk' },
  dayNote: { dayId: '0000000000000001', order: 'a', title: 'Note' },
  cat: { name: 'Food', color: 1, icon: 'utensils' },
  guest: { name: 'Sam' },
  res: { type: 'flight', title: 'TP123', status: 'confirmed' },
  exp: { name: 'Lunch', amount: 1200, currency: 'EUR', payers: [], split: { mode: 'equal', parts: [{ who: USERS.bob.uuid }] } },
  settle: { from: USERS.bob.uuid, to: USERS.alice.uuid, amount: 500, currency: 'EUR' },
  splitPreset: { name: 'Even', weights: { [USERS.bob.uuid]: 1 } },
  costCat: { cat: 'food', order: 'a' },
  pack: { name: 'Socks', order: 'a' },
  bag: { name: 'Carry-on', order: 'a' },
  todo: { name: 'Book train', order: 'a' },
  listMeta: { kind: 'pack', name: 'Clothes', order: 'a' },
  note: { title: 'Ideas' },
  link: { title: 'Guide', url: 'https://example.com/guide' },
  poll: { question: 'Dinner?', options: ['Fish', 'Pasta'] },
  msg: { text: 'Hello' },
};
const EDITOR_ONLY = ['day', 'place', 'visit', 'dayNote', 'cat', 'guest', 'res', 'exp', 'settle', 'splitPreset', 'costCat', 'pack', 'bag', 'todo', 'listMeta'];

describe('commit permissions per type', () => {
  it('lets editors create every editor type and refuses viewers', async () => {
    const { bob, carol } = await setup();
    for (const t of EDITOR_ONLY) {
      await expectError(carol([put(t, SAMPLES[t])]), 403, 'forbidden');
      const result = await bob([put(t, SAMPLES[t])]);
      expect(result.ents[0]).toMatchObject({ t, by: USERS.bob.uuid });
    }
  });

  it('lets viewers post collab items once the owner allows it', async () => {
    const { h, alice, bob, carol } = await setup();
    for (const t of ['note', 'link', 'poll', 'msg']) {
      await expectError(carol([put(t, SAMPLES[t])]), 403, 'forbidden');
      expect((await bob([put(t, SAMPLES[t])])).ents[0].t).toBe(t);
    }
    await expectError(bob([set('meta', 'meta', { perms: { 'collab.post': 'viewer' } })]), 403, 'forbidden');
    await alice([set('meta', 'meta', { perms: { 'collab.post': 'viewer' } })]);
    h.advance(6000);
    for (const t of ['note', 'link', 'poll', 'msg']) expect((await carol([put(t, SAMPLES[t])])).ents[0].t).toBe(t);
  });

  it('enforces the permission matrix after an owner change', async () => {
    const { h, alice, bob } = await setup();
    await alice([set('meta', 'meta', { perms: { 'plan.edit': 'owner' } })]);
    h.advance(6000);
    await expectError(bob([put('place', SAMPLES.place)]), 403, 'forbidden');
    expect((await alice([put('place', SAMPLES.place)])).ents).toHaveLength(1);
  });

  it('keeps meta and member worker-only and gates meta fields by action', async () => {
    const { bob, alice } = await setup();
    await expectError(bob([put('member', { name: 'X', role: 'owner' }, USERS.dave.uuid)]), 403, 'worker_only');
    await expectError(bob([set('member', USERS.bob.uuid, { role: 'owner' })]), 403, 'worker_only');
    await expectError(bob([set('meta', 'meta', { title: 'Mine' })]), 403, 'forbidden');
    await expectError(bob([del('meta', 'meta')]), 403);
    await expectError(alice([put('file', { name: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 'a'.repeat(64), kind: 'user', loc: { mode: 'proxied' } })]), 403, 'worker_only');
    expect((await alice([set('meta', 'meta', { title: 'Porto' })])).ents[0]).toMatchObject({ t: 'meta', title: 'Porto' });
  });

  it('allows $self paths for any member and nothing else', async () => {
    const { bob, carol } = await setup();
    const place = id('p');
    await bob([put('place', SAMPLES.place, place)]);
    expect((await carol([set('place', place, { [`rating.${USERS.carol.uuid}`]: 4 })])).ents[0].rating).toEqual({ [USERS.carol.uuid]: 4 });
    await expectError(carol([set('place', place, { [`rating.${USERS.bob.uuid}`]: 1 })]), 403, 'forbidden');
    await expectError(carol([set('place', place, { name: 'Renamed' })]), 403, 'forbidden');
    await expectError(bob([put('place', { name: 'Seed', rating: { [USERS.carol.uuid]: 5 } })]), 403, 'forbidden');
  });

  it('applies author rules from the immutable author record, not the last editor', async () => {
    const { alice, bob, carol } = await setup({ viewersPost: true });
    const note = id('n');
    await carol([put('note', SAMPLES.note, note)]);
    await expectError(bob([set('note', note, { title: 'Bob' })]), 403, 'forbidden');
    expect((await alice([set('note', note, { title: 'Owner edit' })])).ents[0].by).toBe(USERS.alice.uuid);
    await expectError(bob([del('note', note)]), 403, 'forbidden');
    expect((await carol([set('note', note, { title: 'Still mine' })])).ents[0].title).toBe('Still mine');
  });

  it('locks poll questions after the first vote, even when votes are withdrawn', async () => {
    const { bob, carol } = await setup({ viewersPost: true });
    const poll = id('q');
    await bob([put('poll', SAMPLES.poll, poll)]);
    await carol([set('poll', poll, { [`votes.${USERS.carol.uuid}`]: [1] })]);
    await carol([{ opId: id('o'), t: 'poll', id: poll, unset: [`votes.${USERS.carol.uuid}`] }]);
    await expectError(bob([set('poll', poll, { question: 'Lunch?' })]), 409, 'poll_has_votes');
    expect((await bob([set('poll', poll, { closed: true })])).ents[0].closed).toBe(true);
    await expectError(carol([set('poll', poll, { [`votes.${USERS.carol.uuid}`]: [0] })]), 409, 'poll_closed');
  });

  it('soft-deletes messages and limits edits to the author within 15 minutes', async () => {
    const { h, space, alice, bob, carol } = await setup({ viewersPost: true });
    const msg = id('m');
    await carol([put('msg', SAMPLES.msg, msg)]);
    await bob([set('msg', msg, { [`react.👍.${USERS.bob.uuid}`]: 1 })]);
    await expectError(bob([set('msg', msg, { text: 'edited' })]), 403, 'forbidden');
    h.advance(16 * 60_000);
    await expectError(carol([set('msg', msg, { text: 'late' })]), 403, 'forbidden');
    const op = del('msg', msg);
    const removed = await alice([op]);
    expect(removed.ents[0]).toMatchObject({ t: 'msg', id: msg, text: '', deleted: true });
    expect(removed.ents[0].react).toBeUndefined();
    expect(removed.del).toEqual([]);
    expect(h.kv()[K.entity(space, 'msg', msg)]).toMatchObject({ deleted: true, text: '' });
    // A retried soft delete answers the same shape, not a tombstone.
    const replay = await alice([op]);
    expect(replay).toMatchObject({ rev: removed.rev, del: [], ents: [expect.objectContaining({ t: 'msg', id: msg, deleted: true })] });
  });
});

describe('commit validation and conflicts', () => {
  it('rejects malformed ops before reading anything else', async () => {
    const { bob } = await setup();
    await expectError(bob([{ opId: 'bad', t: 'place', id: id('p'), put: SAMPLES.place }]), 400, 'invalid_operation');
    await expectError(bob([put('place', { name: 'X', extra: 1 })]), 400);
    await expectError(bob([put('place', { name: 'X', v: 'forged' })]), 400);
    await expectError(bob([{ opId: id('o'), t: 'place', id: 'NOT-AN-ID', put: SAMPLES.place }]), 400);
    await expectError(bob([{ opId: id('o'), t: 'nope', id: id('p'), put: {} }]), 400);
    await expectError(bob([set('place', id('p'), { 'name.__proto__': 1 })]), 400);
    const op = put('place', SAMPLES.place);
    await expectError(bob([op, { ...op }]), 400, 'invalid_operation');
    await expectError(bob(Array.from({ length: 201 }, () => put('place', SAMPLES.place))), 400, 'invalid_commit');
  });

  it('is idempotent per op id and returns the recorded rev', async () => {
    const { h, bob } = await setup();
    const ops = [put('place', SAMPLES.place), put('day', SAMPLES.day)];
    const first = await bob(ops);
    const writes = h.world.counters().calls['kv.set'];
    const again = await bob(ops);
    expect(again.rev).toBe(first.rev);
    expect(again.done).toEqual(first.done);
    expect(again.ents.map((entity) => entity.id).sort()).toEqual(first.ents.map((entity) => entity.id).sort());
    expect(h.world.counters().calls['kv.set']).toBe(writes);
    const mixed = await bob([...ops, put('guest', SAMPLES.guest)]);
    expect(mixed.done[ops[0].opId]).toBe(first.rev);
    expect(mixed.done[mixed.ents.find((entity) => entity.t === 'guest') && Object.keys(mixed.done).at(-1)]).toBe(mixed.rev);
    expect(mixed.rev).toBe(first.rev + 1);
  });

  it('rejects a put on an existing id unless it replays the same create', async () => {
    const { bob, carol } = await setup();
    const place = id('p');
    await bob([put('place', SAMPLES.place, place)]);
    const replay = await bob([put('place', SAMPLES.place, place)]);
    expect(replay.ents[0].id).toBe(place);
    await expectError(bob([put('place', { name: 'Other' }, place)]), 409, 'already_exists');
  });

  it('answers 409 stale with the server entity and 409 gone after delete', async () => {
    const { bob, alice } = await setup();
    const place = id('p');
    const created = await bob([put('place', SAMPLES.place, place)]);
    const v1 = created.ents[0].v;
    await alice([set('place', place, { name: 'Alice' })]);
    const stale = await expectError(bob([set('place', place, { name: 'Bob' }, { base: v1 })]), 409, 'stale');
    expect(stale.server).toMatchObject({ t: 'place', id: place, name: 'Alice' });
    const removed = await alice([del('place', place)]);
    expect(removed.del).toEqual([{ t: 'place', id: place, v: expect.any(String) }]);
    await expectError(bob([set('place', place, { name: 'Late' })]), 409, 'gone');
    await expectError(bob([del('place', place)]), 409, 'gone');
    await expectError(bob([put('place', SAMPLES.place, place)]), 409, 'already_exists');
  });

  it('names the failing op element and returns the server copy on 409', async () => {
    const { bob, alice, carol, clients, space } = await setup();
    const place = id('p');
    await bob([put('place', SAMPLES.place, place)]);
    const fresh = put('guest', SAMPLES.guest);
    const taken = put('place', { name: 'Other' }, place);
    const exists = await expectError(bob([fresh, taken]), 409, 'already_exists');
    expect(exists.op).toBe(taken.opId);
    expect(exists.server).toMatchObject({ t: 'place', id: place, name: SAMPLES.place.name });
    const denied = put('place', SAMPLES.place);
    expect((await expectError(carol([denied]), 403, 'forbidden')).op).toBe(denied.opId);
    const invalid = { opId: id('o'), t: 'place', id: id('p'), put: { nope: 1 } };
    expect((await expectError(bob([invalid]), 400)).op).toBe(invalid.opId);
    await alice([del('place', place)]);
    const late = set('place', place, { name: 'Late' });
    const gone = await expectError(bob([late]), 409, 'gone');
    expect(gone.op).toBe(late.opId);
    expect(gone.server).toMatchObject({ t: 'place', id: place, deleted: true });
    // Batch-level failures name no op.
    await clients.alice.in(space).call('member.remove', { uuid: USERS.bob.uuid });
    expect((await expectError(bob([put('guest', SAMPLES.guest)]), 403, 'not_member')).op).toBeUndefined();
  });

  it('applies several ops on one entity in order and accepts the pre-commit base', async () => {
    const { bob } = await setup();
    const place = id('p');
    const created = await bob([put('place', SAMPLES.place, place)]);
    const base = created.ents[0].v;
    const result = await bob([set('place', place, { name: 'One' }, { base }), set('place', place, { address: 'Rua 1' }, { base }), { opId: id('o'), t: 'place', id: place, unset: ['address'] }]);
    expect(result.ents).toHaveLength(1);
    expect(result.ents[0]).toMatchObject({ name: 'One' });
    expect(result.ents[0].address).toBeUndefined();
    const createDelete = await bob([put('guest', SAMPLES.guest, 'g000000000000099'), del('guest', 'g000000000000099')]);
    expect(createDelete.ents).toEqual([]);
  });

  it('stamps worker fields and keeps concurrent edits to other fields', async () => {
    const { h, space, bob, alice } = await setup();
    const place = id('p');
    await bob([put('place', SAMPLES.place, place)]);
    await Promise.all([alice([set('place', place, { name: 'A' })]), bob([set('place', place, { phone: '123' })])]);
    const stored = h.kv()[K.entity(space, 'place', place)];
    expect(stored).toMatchObject({ name: 'A', phone: '123', id: place, by: expect.any(String), cr: expect.any(Number) });
  });

  it('enforces space caps from the counter and the 200-write limit', async () => {
    const { h, space, bob, clients } = await setup();
    await clients.alice.puter.kv.set(K.count(space), { e: 20_000, day: 0, place: 0, bytes: 0 });
    await expectError(bob([put('place', SAMPLES.place)]), 409, 'space_full');
    await clients.alice.puter.kv.set(K.count(space), { e: 10, day: 0, place: 5000, bytes: 0 });
    await expectError(bob([put('place', SAMPLES.place)]), 409, 'space_full');
    expect((await bob([put('guest', SAMPLES.guest)])).ents).toHaveLength(1);
    expect(h.kv()[K.count(space)]).toMatchObject({ e: 11 });
  });

  it('answers every rate limit with the seconds left in its window', async () => {
    const { h, bob } = await setup();
    h.advance(60_000 - (h.now() % 60_000) + 15_000);
    for (let i = 0; i < 120; i++) await bob([put('guest', SAMPLES.guest)]);
    const limited = await expectError(bob([put('guest', SAMPLES.guest)]), 429, 'rate_limited');
    expect(limited.retryAfter).toBe(45);
    expect(limited.op).toBeUndefined();
  });

  // Up to 119 commits that each rewrite a 200 KB entity: about a second alone, several on a loaded machine.
  it('caps the KV bytes a member makes the owner write, counting whole items for small patches', async () => {
    const { h, space, bob, carol } = await setup();
    const place = id('p');
    // ~200 KB: every `$self` rating patch rewrites (and bills) the whole item plus its change record.
    await bob([put('place', { name: 'Big', desc: 'd'.repeat(100_000), notes: 'n'.repeat(100_000) }, place)]);
    let accepted = 0;
    let error;
    for (let i = 0; i < 119 && !error; i++) {
      try { await carol([set('place', place, { [`rating.${USERS.carol.uuid}`]: (i % 5) + 1 })]); accepted++; } catch (caught) { error = caught; }
    }
    expect(error).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(error.retryAfter).toBeGreaterThan(0);
    expect(error.retryAfter).toBeLessThanOrEqual(60);
    expect(accepted).toBeGreaterThan(40);
    expect(accepted).toBeLessThan(100);
    const rev = h.kv()[K.rev(space)];
    // Others keep their own budget, and the member's returns with the next window.
    expect((await bob([put('guest', SAMPLES.guest)])).rev).toBe(rev + 1);
    h.advance(60_000);
    expect((await carol([set('place', place, { [`rating.${USERS.carol.uuid}`]: 3 })])).rev).toBe(rev + 2);
  }, 30_000);
});

describe('rev claims', () => {
  it('refuses an entity that cannot fit a change record before claiming a rev', async () => {
    const { h, space, bob } = await setup();
    const rev = h.kv()[K.rev(space)];
    // Just under the 399 KB entity cap, so only the change-record wrapper overflows.
    const big = { name: 'é'.repeat(500), notes: 'é'.repeat(100_000), desc: 'é'.repeat(100_000), address: 'é'.repeat(2000), src: 'é'.repeat(500), web: `https://e.com/${'a'.repeat(1900)}` };
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeLessThan(399 * 1024 - 200);
    await expectError(bob([put('place', big)]), 413, 'entity_too_large');
    expect(h.kv()[K.rev(space)]).toBe(rev);
  });

  it('leaves an empty record when the claim write fails, so no rev becomes a hole', async () => {
    const { h, space, bob, clients } = await setup({ onlyIfAbsent: true });
    h.world.failNext({ method: 'kv.set', as: USERS.alice.uuid, status: 503, code: 'unavailable' });
    await expectError(bob([put('guest', SAMPLES.guest)]), 500);
    const rev = h.kv()[K.rev(space)];
    expect(h.kv()[K.ch(space, rev, 0)]).toMatchObject({ rev, parts: 1, ents: [], del: [] });
    const next = await bob([put('guest', SAMPLES.guest)]);
    expect(next.rev).toBe(rev + 1);
    const synced = await clients.carol.in(space).call('sync', { since: rev - 1 });
    expect(synced.changes.map((change) => change.rev)).toEqual([rev, rev + 1]);
  });

  it('finishes claimed writes in the background when both inline attempts fail', async () => {
    const { h, space, bob } = await setup();
    const guest = id('g');
    await bob([put('guest', SAMPLES.guest, guest)]);
    const op = set('guest', guest, { name: 'Renamed' });
    h.world.failNext({ method: 'kv.update', as: USERS.alice.uuid, status: 503, code: 'unavailable', times: 2 });
    await expectError(bob([op]), 500);
    const rev = h.kv()[K.rev(space)];
    expect(h.kv()[K.ch(space, rev, 0)].ents[0]).toMatchObject({ id: guest, name: 'Renamed' });
    await h.settle();
    // The entity now matches the claimed record, and the client's retry is acknowledged with that rev.
    expect(h.kv()[K.entity(space, 'guest', guest)]).toMatchObject({ name: 'Renamed', rev });
    expect(await bob([op])).toMatchObject({ rev, done: { [op.opId]: rev } });
    expect(h.kv()[K.rev(space)]).toBe(rev);
  });

  it('locks a poll whose creator voted in the create', async () => {
    const { bob, carol } = await setup({ viewersPost: true });
    const poll = id('q');
    await carol([put('poll', { ...SAMPLES.poll, votes: { [USERS.carol.uuid]: [0] } }, poll)]);
    await carol([{ opId: id('o'), t: 'poll', id: poll, unset: [`votes.${USERS.carol.uuid}`] }]);
    await expectError(carol([set('poll', poll, { question: 'Changed?' })]), 409, 'poll_has_votes');
    expect(bob).toBeTruthy();
  });
});

describe('domain-op registry', () => {
  const ops = { typeHooks: {}, domainOps: { 'test.touch': touch } };

  it('runs a registered op as one change with client ids and its own authorization', async () => {
    const { bob, carol } = await setup({ ops });
    const place = id('p');
    const guest = id('g');
    await bob([put('place', SAMPLES.place, place)]);
    const result = await bob([{ opId: id('o'), do: 'test.touch', args: { placeId: place, name: 'Torre', newIds: { guest } } }]);
    expect(result.ents.map((entity) => [entity.t, entity.name])).toEqual([['place', 'Torre'], ['guest', 'Torre']]);
    await expectError(carol([{ opId: id('o'), do: 'test.touch', args: { placeId: place, name: 'No', newIds: { guest: id('g') } } }]), 403, 'forbidden');
    await expectError(bob([{ opId: id('o'), do: 'test.touch', args: { placeId: place, name: 'Again', newIds: { guest } } }]), 409, 'already_exists');
    await expectError(bob([{ opId: id('o'), do: 'test.touch', args: { placeId: place, name: 1, newIds: { guest: id('g') } } }]), 400, 'invalid_args');
    await expectError(bob([{ opId: id('o'), do: 'nope', args: {} }]), 400, 'invalid_domain_op');
  });

  it('refuses domain writes to worker-owned entities', async () => {
    const rogue = { ...touch, plan: () => [{ t: 'member', id: USERS.bob.uuid, set: { role: 'owner' } }] };
    const { bob } = await setup({ ops: { typeHooks: {}, domainOps: { 'test.touch': rogue } } });
    await expectError(bob([{ opId: id('o'), do: 'test.touch', args: { placeId: id('p'), name: 'x', newIds: { guest: id('g') } } }]), 403, 'worker_only');
  });

  it('refuses domain writes and reads outside the keys the op declared', async () => {
    const undeclared = { ...touch, reads: (args) => [{ t: 'place', id: args.placeId }] };
    const peek = { ...touch, plan: ({ args, get }) => (get('guest', args.newIds.guest) ? [] : [{ t: 'guest', id: args.newIds.guest, put: { name: 'x' } }]) };
    const { h, space, alice, bob } = await setup({ ops: { typeHooks: {}, domainOps: { 'test.touch': undeclared, 'test.peek': { ...peek, reads: undeclared.reads } } } });
    const place = id('p');
    const guest = id('g');
    await bob([put('place', SAMPLES.place, place)]);
    await alice([put('guest', { name: 'Original' }, guest)]);
    // An id the op never read would look absent, so the put would overwrite another member's entity.
    await expectError(bob([{ opId: id('o'), do: 'test.touch', args: { placeId: place, name: 'Overwrite', newIds: { guest } } }]), 500, 'invalid_domain_result');
    await expectError(bob([{ opId: id('o'), do: 'test.peek', args: { placeId: place, name: 'x', newIds: { guest } } }]), 500, 'invalid_domain_result');
    expect(h.kv()[K.entity(space, 'guest', guest)]).toMatchObject({ name: 'Original', by: USERS.alice.uuid });
  });

  it('refuses unregistered domain ops in the production registry', async () => {
    const { bob } = await setup();
    await expectError(bob([{ opId: id('o'), do: 'test.touch', args: {} }]), 400, 'invalid_domain_op');
  });

  it('runs type hooks after the shared rules', async () => {
    const hooked = { typeHooks: { 'trip/guest': { check: ({ after }) => { if (after?.name === 'Forbidden') throw new DomainError('name_taken', 409); } } }, domainOps: {} };
    const { bob } = await setup({ ops: hooked });
    await expectError(bob([put('guest', { name: 'Forbidden' })]), 409, 'name_taken');
    expect((await bob([put('guest', { name: 'Fine' })])).ents).toHaveLength(1);
  });
});
