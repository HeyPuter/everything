// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { COLLECTION_ICONS as WORKER_ICONS } from '../../worker/ops/collection/meta.js';
import { COLLECTION_ICONS } from '../../src/views/collections/icons.js';
import { ORIGIN, USERS, WORKER, createHarness, expectError, id } from './harness.js';

const put = (t, fields, eid = id(t)) => ({ opId: id('o'), t, id: eid, put: fields });
const set = (t, eid, fields) => ({ opId: id('o'), t, id: eid, set: fields });
const del = (t, eid) => ({ opId: id('o'), t, id: eid, del: true });
const OWNER = USERS.alice.uuid;
const kvCalls = (h) => Object.entries(h.world.counters().byUser[OWNER]?.calls ?? {}).filter(([method]) => method.startsWith('kv.') && method !== 'kv.share').reduce((n, [, count]) => n + count, 0);
const tripRef = { w: WORKER, s: '0123456789abcdef', k: 'trip' };

async function setup() {
  const h = await createHarness();
  const alice = await h.client('alice');
  const { space } = await alice.call('space.create', { kind: 'collection', meta: { name: 'Lisbon food', color: 3, icon: 'utensils' } });
  for (const [name, role] of Object.entries({ bob: 'editor', carol: 'viewer' })) {
    const { token } = await alice.in(space).call('invite.create', { role });
    await (await h.client(name)).in(space).call('join', { token });
  }
  const [bob, carol] = await Promise.all(['bob', 'carol'].map((name) => h.client(name)));
  const as = (client) => (ops) => client.in(space).call('commit', { ops });
  return { h, space, alice: as(alice), bob: as(bob), carol: as(carol), clients: { alice, bob, carol } };
}

describe('collection spaces', () => {
  it('validate meta on create and report the name as the title', async () => {
    const h = await createHarness();
    const alice = await h.client('alice');
    await expectError(alice.call('space.create', { kind: 'collection', meta: { name: '   ' } }), 400);
    await expectError(alice.call('space.create', { kind: 'collection', meta: { name: 'x'.repeat(201) } }), 400, 'name_too_long');
    await expectError(alice.call('space.create', { kind: 'collection', meta: { name: 'Ideas', icon: 'skull' } }), 400, 'invalid_icon');
    await expectError(alice.call('space.create', { kind: 'collection', meta: { name: 'Ideas', color: 12 } }), 400);
    const { space, kind } = await alice.call('space.create', { kind: 'collection', meta: { name: 'Ideas', icon: 'heart', urls: [{ url: 'https://example.com/list', title: 'Source' }] } });
    expect(kind).toBe('collection');
    expect((await alice.call('heads', { spaces: [space] })).heads[space].title).toBe('Ideas');
  });

  it('lets only the owner edit meta by default and rejects bad links', async () => {
    const { alice, bob, carol } = await setup();
    await expectError(bob([set('meta', 'meta', { name: 'Mine' })]), 403, 'forbidden');
    await expectError(carol([set('meta', 'meta', { desc: 'Hi' })]), 403, 'forbidden');
    await expectError(alice([set('meta', 'meta', { urls: [{ url: 'javascript:alert(1)' }] })]), 400);
    await expectError(alice([set('meta', 'meta', { urls: [{ url: 'https://a.example' }, { url: 'https://a.example', title: 'Again' }] })]), 400, 'duplicate_url');
    await expectError(alice([set('meta', 'meta', { color: '#ff0000' })]), 400, 'invalid_color');
    const ok = await alice([set('meta', 'meta', { name: 'Lisbon eats', urls: [{ url: 'https://a.example', title: 'Guide' }] })]);
    expect(ok.ents[0]).toMatchObject({ name: 'Lisbon eats', urls: [{ url: 'https://a.example', title: 'Guide' }] });
    await expectError(alice([{ opId: id('o'), t: 'meta', id: 'meta', del: true }]), 403);
  });
});

describe('saved place rules', () => {
  it('needs plan.edit to write, but any member keeps their own rating, tags and visited flag', async () => {
    const { bob, carol } = await setup();
    const saved = id('s');
    await expectError(carol([put('saved', { name: 'Taberna', status: 'want', order: 'V' })]), 403, 'forbidden');
    await bob([put('saved', { name: 'Taberna', status: 'want', order: 'V', lat: 38.71, lng: -9.14, cat: 'restaurant' }, saved)]);
    await expectError(carol([set('saved', saved, { status: 'visited' })]), 403, 'forbidden');
    await expectError(carol([del('saved', saved)]), 403, 'forbidden');
    const mine = await carol([set('saved', saved, { [`rating.${USERS.carol.uuid}`]: 4, [`tags.${USERS.carol.uuid}`]: ['Lunch'], [`visited.${USERS.carol.uuid}`]: true })]);
    expect(mine.ents[0]).toMatchObject({ rating: { [USERS.carol.uuid]: 4 }, tags: { [USERS.carol.uuid]: ['Lunch'] } });
    await expectError(carol([set('saved', saved, { [`rating.${USERS.bob.uuid}`]: 1 })]), 403, 'forbidden');
    await expectError(bob([put('saved', { name: 'Seeded', status: 'idea', order: 'W', rating: { [USERS.carol.uuid]: 5 } })]), 403, 'forbidden');
    expect((await bob([del('saved', saved)])).del).toEqual([expect.objectContaining({ t: 'saved', id: saved })]);
  });

  it('rejects bad statuses, repeated labels, non-trip sources, negative prices and duplicate tags', async () => {
    const { bob } = await setup();
    const saved = id('s');
    const label = id('l');
    await expectError(bob([put('saved', { name: 'Kiosk', status: 'maybe', order: 'V' })]), 400);
    await expectError(bob([put('saved', { name: 'Kiosk', status: 'idea' })]), 400);
    await expectError(bob([put('saved', { name: ' ', status: 'idea', order: 'V' })]), 400);
    await expectError(bob([put('saved', { name: 'Kiosk', status: 'idea', order: 'V', labels: [label, label] })]), 400, 'duplicate_label');
    await expectError(bob([put('saved', { name: 'Kiosk', status: 'idea', order: 'V', src: { trip: { ...tripRef, k: 'collection' }, placeId: id('p') } })]), 400, 'invalid_source');
    await expectError(bob([put('saved', { name: 'Kiosk', status: 'idea', order: 'V', price: { amount: -1, currency: 'EUR' } })]), 400, 'invalid_price');
    await expectError(bob([put('saved', { name: 'Kiosk', status: 'idea', order: 'V', lat: 38.7 })]), 400);
    await bob([put('saved', { name: 'Kiosk', status: 'idea', order: 'V', labels: [label], src: { trip: tripRef, placeId: id('p') } }, saved)]);
    await expectError(bob([set('saved', saved, { [`tags.${USERS.bob.uuid}`]: ['Snack', 'snack'] })]), 400, 'duplicate_tag');
    expect((await bob([set('saved', saved, { status: 'revisit', labels: [] })])).ents[0]).toMatchObject({ status: 'revisit', labels: [] });
  });

  it('is idempotent per op id and costs one batched read plus the commit writes', async () => {
    const { h, bob } = await setup();
    await bob([put('saved', { name: 'Warm-up', status: 'idea', order: 'U' })]);
    const op = put('saved', { name: 'Miradouro', status: 'want', order: 'V', lat: 38.71, lng: -9.13 });
    h.world.resetCounters();
    const first = await bob([op]);
    expect(kvCalls(h)).toBeLessThanOrEqual(8);
    const writes = h.world.counters().calls['kv.set'];
    const again = await bob([op]);
    expect(again).toMatchObject({ rev: first.rev, done: first.done });
    expect(h.world.counters().calls['kv.set']).toBe(writes);
  });
});

describe('collection labels', () => {
  it('need plan.edit, a short non-blank name and a day-token color', async () => {
    const { bob, carol } = await setup();
    const label = id('l');
    await expectError(carol([put('label', { name: 'Brunch', order: 'V' })]), 403, 'forbidden');
    await expectError(bob([put('label', { name: '  ', order: 'V' })]), 400);
    await expectError(bob([put('label', { name: 'x'.repeat(101), order: 'V' })]), 400, 'name_too_long');
    await expectError(bob([put('label', { name: 'Brunch', order: 'V', color: '#00ff00' })]), 400, 'invalid_color');
    await bob([put('label', { name: 'Brunch', order: 'V', color: 4 }, label)]);
    expect((await bob([set('label', label, { name: 'Late brunch' })])).ents[0]).toMatchObject({ name: 'Late brunch', color: 4 });
    await expectError(carol([del('label', label)]), 403, 'forbidden');
  });

  it('accepts exactly the icons the client offers', () => {
    expect([...WORKER_ICONS].sort()).toEqual([...COLLECTION_ICONS].sort());
  });
});

describe('collection sharing', () => {
  it('lets the owner publish a read-only link without trip sources or per-user fields', async () => {
    const { h, space, bob, clients } = await setup();
    await bob([put('saved', { name: 'Pastéis', status: 'want', order: 'V', rating: { [USERS.bob.uuid]: 5 }, src: { trip: tripRef, placeId: id('p') } })]);
    await expectError(clients.bob.in(space).call('share.set', { on: true }), 403, 'forbidden');
    const { token, share } = await clients.alice.in(space).call('share.set', { on: true });
    expect(share).toMatchObject({ on: true });
    h.advance(121_000);
    const response = await (await h.client('dave')).puter.workers.exec(`${ORIGIN}/pub/${space}/${token}`, { headers: { 'x-puter-no-auth': '1' } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.kind).toBe('collection');
    const saved = body.ents.find((entity) => entity.t === 'saved');
    expect(saved).toMatchObject({ name: 'Pastéis', status: 'want' });
    expect(saved).not.toHaveProperty('src');
    expect(saved).not.toHaveProperty('rating');
  });
});
