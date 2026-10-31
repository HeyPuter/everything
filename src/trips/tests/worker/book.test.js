// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as pageRules from '../../worker/ops/journey/bookPage.js';
import { BOOK_TITLE_MAX, FORMAT_IDS } from '../../worker/ops/journey/book.js';
import * as constants from '../../src/lib/book/constants.js';
import { USERS, createHarness, expectError, id } from './harness.js';

const put = (t, fields, eid = id(t)) => ({ opId: id('o'), t, id: eid, put: fields });
const set = (t, eid, fields, extra = {}) => ({ opId: id('o'), t, id: eid, set: fields, ...extra });
const del = (t, eid) => ({ opId: id('o'), t, id: eid, del: true });
const OWNER = USERS.alice.uuid;
const kvCalls = (h) => Object.entries(h.world.counters().byUser[OWNER]?.calls ?? {}).filter(([method]) => method.startsWith('kv.') && method !== 'kv.share').reduce((n, [, count]) => n + count, 0);
const photo = (extra = {}) => ({ k: 'photo', x: 0, y: 0, w: 0.5, h: 1, z: 1, fit: 'fill', ...extra });

async function journey() {
  const h = await createHarness({ ownerVerified: false });
  const alice = await h.client('alice');
  const { space } = await alice.call('space.create', { kind: 'journey', meta: { title: 'Portugal' } });
  for (const [name, role] of Object.entries({ bob: 'editor', carol: 'viewer' })) {
    const { token } = await alice.in(space).call('invite.create', { role });
    await (await h.client(name)).in(space).call('join', { token });
  }
  const clients = await Promise.all(['alice', 'bob', 'carol'].map((name) => h.client(name)));
  const [alice2, bob, carol] = clients.map((client) => (ops) => client.in(space).call('commit', { ops }));
  return { h, space, alice: alice2, bob, carol };
}

describe('photo-book rules', () => {
  it('keeps the worker and client value lists equal', () => {
    for (const name of ['PAGE_KINDS', 'ELEMENT_KINDS', 'COLORS', 'FILTERS', 'FITS', 'TEXT_STYLES', 'FONTS', 'ALIGNS', 'SHAPES', 'SCOPES', 'STATS', 'ICONS']) {
      expect(constants[name], name).toEqual(pageRules[name]);
    }
    expect(constants.FORMAT_IDS).toEqual(FORMAT_IDS);
    expect(constants.BOOK_LIMITS.title).toBe(BOOK_TITLE_MAX);
  });

  it('lets editors build books and keeps viewers out', async () => {
    const { alice, bob, carol } = await journey();
    const book = id('b');
    await expectError(carol([put('book', { title: 'Mine' }, book)]), 403, 'forbidden');
    await alice([put('book', { title: 'Portugal', fmt: 'a4l' }, book)]);
    const page = id('p');
    const result = await bob([put('bookPage', { book, kind: 'spread', order: 'V', els: { [id('e')]: photo() } }, page)]);
    expect(result.ents[0]).toMatchObject({ book, kind: 'spread' });
    await expectError(carol([set('bookPage', page, { layout: 'spread-pair' })]), 403, 'forbidden');
    await expectError(carol([del('bookPage', page)]), 403, 'forbidden');
    await bob([set('book', book, { title: 'Lisbon' })]);
    await bob([del('bookPage', page), del('book', book)]);
  });

  it('validates formats, kinds and element values', async () => {
    const { bob } = await journey();
    await expectError(bob([put('book', { fmt: 'b5' })]), 400, 'invalid_format');
    await expectError(bob([put('book', { fmt: 'custom', w: 200 })]), 400, 'invalid_format');
    await expectError(bob([put('book', { title: 'x'.repeat(201) })]), 400, 'title_too_long');
    await expectError(bob([put('book', { font: 'comic' })]), 400, 'invalid_font');
    const book = id('b');
    await bob([put('book', { fmt: 'custom', w: 200, h: 150 }, book)]);
    await expectError(bob([put('bookPage', { book, kind: 'middle', order: 'V' })]), 400, 'invalid_kind');
    await expectError(bob([put('bookPage', { book, kind: 'spread', order: 'V', bg: 'red' })]), 400, 'invalid_color');
    for (const bad of [{ k: 'video' }, { filter: 'glow' }, { color: '#ff0000' }, { icon: 'skull' }, { fit: 'stretch' }]) {
      await expectError(bob([put('bookPage', { book, kind: 'spread', order: 'V', els: { [id('e')]: photo(bad) } })]), 400);
    }
    await expectError(bob([put('bookPage', { book, kind: 'spread', order: 'V', els: { [id('e')]: photo({ x: 9 }) } })]), 400, 'invalid');
    const page = id('p');
    const eid = id('e');
    await bob([put('bookPage', { book, kind: 'cover', order: 'V', els: { [eid]: photo() } }, page)]);
    await expectError(bob([set('bookPage', page, { kind: 'spread' })]), 400, 'immutable_field');
    await expectError(bob([set('bookPage', page, { book: id('b') })]), 400, 'immutable_field');
    await expectError(bob([set('bookPage', page, { [`els.${eid}.filter`]: 'glow' })]), 400, 'invalid_element');
    const moved = await bob([set('bookPage', page, { [`els.${eid}.x`]: 0.25, [`els.${eid}.filter`]: 'bw' })]);
    expect(moved.ents[0].els[eid]).toMatchObject({ x: 0.25, filter: 'bw', k: 'photo' });
    const tooMany = Object.fromEntries(Array.from({ length: 81 }, () => [id('e'), photo()]));
    await expectError(bob([set('bookPage', page, { els: tooMany })]), 400);
  });

  it('parks a stale whole-page replacement as a conflict', async () => {
    const { alice, bob } = await journey();
    const book = id('b');
    const page = id('p');
    const eid = id('e');
    const created = await bob([put('book', {}, book), put('bookPage', { book, kind: 'spread', order: 'V', els: { [eid]: photo() } }, page)]);
    const base = created.ents.find((item) => item.id === page).v;
    await alice([set('bookPage', page, { [`els.${eid}.x`]: 0.3 })]);
    const error = await expectError(bob([set('bookPage', page, { els: { [id('e')]: photo() }, layout: 'spread-pair' }, { base })]), 409, 'stale');
    expect(error.server?.els?.[eid]?.x).toBe(0.3);
  });

  it('replays a retried page commit without new writes, within the commit budget', async () => {
    const { h, bob } = await journey();
    const op = put('bookPage', { book: id('b'), kind: 'spread', order: 'V', els: { [id('e')]: photo(), [id('e')]: { k: 'text', text: 'Day one', x: 0.5, y: 0.1, w: 0.4, h: 0.1, z: 2 } } });
    h.world.resetCounters();
    const first = await bob([op]);
    expect(kvCalls(h)).toBeLessThanOrEqual(8);
    const writes = h.world.counters().calls['kv.set'];
    const again = await bob([op]);
    expect(again).toMatchObject({ rev: first.rev, done: first.done });
    expect(h.world.counters().calls['kv.set']).toBe(writes);
  });
});
