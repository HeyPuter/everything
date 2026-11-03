import { afterEach, describe, expect, it, vi } from 'vitest';
import { USERS, WORKER, createHarness, id, memoryDb } from '../worker/harness.js';
import { K } from '../../worker/keys.js';
import { project } from '../../worker/engine/projection.js';
import { parseRoute, routeHash } from '../../src/lib/router.js';
import { createApp } from '../../src/main.js';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { fetchPublic } from '../../src/lib/api.js';
import { t } from '../../src/lib/i18n/index.js';
import { cleanProjection, personName, readOnlySpace } from '../../src/views/public/data.js';
import { failure, mount } from '../../src/views/public/index.js';
import { shareSection } from '../../src/views/trip/members/share/index.js';
import { currentToken, publicURL, shareOf, togglePatch, visibleSections } from '../../src/views/trip/members/share/logic.js';

Blob.prototype.text ??= function text() { return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(this); }); };

const S = '0123456789abcdef';
const TOKEN = 'b'.repeat(32);
const ALIAS = '00000000-0000-0000-0000-000000000001';
const DAY = id('d');

describe('public link route', () => {
  it('parses and builds #/s/<worker>/<space>/<token>', () => {
    expect(parseRoute(`#/s/${WORKER}/${S}/${TOKEN}`)).toEqual({ name: 'public', worker: WORKER, space: S, token: TOKEN });
    expect(routeHash({ name: 'public', worker: WORKER, space: S, token: TOKEN })).toBe(`#/s/${WORKER}/${S}/${TOKEN}`);
    for (const bad of [`#/s/evil.example/${S}/${TOKEN}`, `#/s/${WORKER}/nope/${TOKEN}`, `#/s/${WORKER}/${S}/XYZ`, `#/s/${WORKER}/${S}`]) expect(parseRoute(bad).name).toBe('notFound');
  });
});

describe('share settings logic', () => {
  it('reads absent fields the way the worker does', () => {
    expect(shareOf({})).toEqual({ on: false, exp: null, since: null, cur: null, plan: false, map: true, bookings: false, codes: false, packing: false, costs: false, chat: false, files: false });
    expect(shareOf({ share: { on: true, cur: 'nope', exp: 5 } })).toMatchObject({ on: true, cur: null, exp: 5 });
  });

  it('lists only sections a viewer can actually see', () => {
    expect(visibleSections(shareOf({ share: { codes: true, map: true } }))).toEqual([]);
    expect(visibleSections(shareOf({ share: { bookings: true, codes: true } }))).toEqual(['map', 'bookings', 'codes']);
    expect(visibleSections(shareOf({ share: { plan: true, map: false, costs: true } }))).toEqual(['plan', 'costs']);
  });

  it('turns codes off with bookings', () => {
    expect(togglePatch({ codes: true }, 'bookings', false)).toEqual({ bookings: false, codes: false });
    expect(togglePatch({ codes: false }, 'bookings', false)).toEqual({ bookings: false });
  });

  it('builds the link without Puter launch parameters', () => {
    const url = publicURL('https://trips.puter.com/?puter.auth.token=x&as=bob#/t/x', { w: WORKER, s: S }, TOKEN);
    expect(url).toBe(`https://trips.puter.com/?as=bob#/s/${WORKER}/${S}/${TOKEN}`);
    expect(() => publicURL('https://trips.puter.com/', { w: 'evil', s: S }, TOKEN)).toThrow();
  });

  it('shows a cached token only while it is the current one', () => {
    const share = shareOf({ share: { on: true, since: 10 } });
    expect(currentToken({ token: TOKEN, since: 10 }, share)).toBe(TOKEN);
    expect(currentToken({ token: TOKEN, since: 9 }, share)).toBeNull();
    expect(currentToken({ token: TOKEN, since: 10 }, { ...share, on: false })).toBeNull();
    expect(currentToken({ token: 'short', since: 10 }, share)).toBeNull();
  });
});

describe('public projection on the client', () => {
  const data = {
    ok: true, rev: 3, at: 9,
    share: { plan: true, map: true, bookings: false, files: true, cur: 'USD', exp: null, evil: true },
    meta: { title: 'Lisbon', currency: 'EUR', cover: { url: 'javascript:alert(1)' }, perms: {} },
    members: [{ id: ALIAS, name: 'alice', color: 1 }, { id: 'not-a-uuid', name: 'x' }],
    ents: [
      { t: 'day', id: DAY, order: 'V', date: '2027-05-01', cr: 1 },
      { t: 'place', id: id('p'), name: 'Belém', lat: 1 },
      { t: 'place', id: id('p'), name: 'Ok', cr: 2 },
      { t: 'todo', id: id('t'), name: 'Hidden', order: 'V' },
      { t: 'visit', id: id('v'), dayId: DAY, placeId: null, order: 'V', title: 'Walk', people: [ALIAS, id('g')] },
      { t: 'file', id: id('f'), name: 'a.png', mime: 'image/png', size: 4, links: [{ t: 'place', id: 'x' }], loc: { uid: 'secret' } },
      { t: 'file', id: id('f'), name: 'b.png', mime: 'image/png', size: 4 },
    ],
  };
  data.files = [data.ents[5].id];

  it('keeps only known types that pass the schema and drops unsafe links', () => {
    const projection = cleanProjection(data);
    expect(projection.ents.map((entity) => entity.t)).toEqual(['day', 'place', 'visit']);
    expect(projection.ents[1].name).toBe('Ok');
    expect(projection.meta).toEqual({ title: 'Lisbon', currency: 'EUR' });
    expect(projection.share).toEqual({ plan: true, map: true, bookings: false, codes: false, packing: false, costs: false, chat: false, files: true, road: false, cur: 'USD', exp: null });
    expect(projection.members).toEqual([{ id: ALIAS, uid: ALIAS, name: 'alice', color: 1 }]);
    expect(projection.files).toEqual([{ t: 'file', id: data.ents[5].id, name: 'a.png', mime: 'image/png', size: 4, links: [{ t: 'place', id: 'x' }] }]);
  });

  it('offers read-only selectors and refuses writes', async () => {
    const space = readOnlySpace(cleanProjection(data), { w: WORKER, s: S, k: 'trip' });
    expect(space.select.day.all()).toHaveLength(1);
    expect(space.select.visit.groupBy('dayId').get(data.ents[0].id)).toHaveLength(1);
    expect(space.get('meta', 'meta').title).toBe('Lisbon');
    expect(space.can('plan.edit')).toBe(false);
    await expect(space.apply([])).rejects.toMatchObject({ code: 'read_only' });
    expect(() => space.ops.patch('place', 'x', {})).toThrow('read_only');
    const names = { former: 'Former', guest: (name) => `${name} (guest)` };
    expect(personName(space, ALIAS, names)).toBe('alice');
    expect(personName(space, '00000000-0000-0000-0000-000000000009', names)).toBe('Former');
  });

  it('maps load failures to what the visitor can do', () => {
    expect(failure({ status: 404 })).toMatchObject({ title: t('public.goneTitle'), retry: false });
    expect(failure({ status: 429, retryAfter: 12 }).body).toBe(t('public.rateBodyIn', { seconds: '12' }));
    expect(failure({ status: 402, code: 'owner_credit' }).title).toBe(t('public.creditTitle'));
    expect(failure({ status: 0, code: 'network' }, { online: false }).title).toBe(t('public.offlineTitle'));
    expect(failure({ status: 500 }).title).toBe(t('public.errorTitle'));
  });
});

describe('fetchPublic', () => {
  const link = { worker: WORKER, space: S, token: TOKEN };
  const respond = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  it('sends no credential and handles ETags', async () => {
    const exec = vi.fn(async (_url, init) => (init.headers['If-None-Match'] === '"e1"' ? respond(304, null) : respond(200, { ok: true, ents: [] }, { ETag: '"e1"' })));
    const puter = { authToken: 'session', workers: { exec } };
    const first = await fetchPublic(puter, link);
    expect(first).toMatchObject({ etag: '"e1"', data: { ok: true } });
    const [url, init] = exec.mock.calls[0];
    expect(url).toBe(`https://${WORKER}.puter.work/pub/${S}/${TOKEN}`);
    expect(init.headers['x-puter-no-auth']).toBe('1');
    expect(init.headers['puter-auth']).toBeUndefined();
    expect(await fetchPublic(puter, link, { etag: '"e1"' })).toEqual({ notModified: true, etag: '"e1"' });
  });

  it('reports worker errors with retry hints and refuses bad links', async () => {
    const puter = { workers: { exec: async () => respond(503, { code: 'snapshot_pending', retryAfter: 2 }, { 'Retry-After': '2' }) } };
    await expect(fetchPublic(puter, link)).rejects.toMatchObject({ status: 503, code: 'snapshot_pending', retryAfter: 2 });
    await expect(fetchPublic(puter, { ...link, worker: 'evil.example' })).rejects.toBeTruthy();
    await expect(fetchPublic(puter, { ...link, token: '../x' })).rejects.toMatchObject({ code: 'invalid_public_link' });
  });
});

/** The meta and member entities straight from the worker's KV, as a synced replica would show them. */
function kvSpace(h, space, role) {
  return {
    ref: { w: WORKER, s: space, k: 'trip' }, role,
    get: (type, entityId) => h.kv()[K.entity(space, type, entityId)],
    query: () => [], members: () => [], subscribe: () => () => {}, ops: {}, apply: async () => {}, sync: async () => {},
  };
}

describe('public link against the real worker', () => {
  afterEach(() => { document.querySelector('[role=dialog] .modal-actions .btn')?.click(); document.body.replaceChildren(); vi.useRealTimers(); });

  it('creates a link and batches toggle changes into one share.set', async () => {
    const h = await createHarness();
    const space = await h.team({ bob: 'editor' });
    const alice = await h.client('alice');
    await alice.in(space).call('commit', { ops: [{ opId: id('o'), t: 'day', id: id('d'), put: { order: 'V', date: '2027-05-01', title: 'Arrive' } }] });
    const db = memoryDb(USERS.alice.uuid);
    const container = document.createElement('div'); document.body.append(container);
    const section = shareSection({ space: kvSpace(h, space, 'owner'), session: { api: alice.api, db }, account: { uuid: USERS.alice.uuid } });
    container.append(section.element);
    const create = [...container.querySelectorAll('button')].find((node) => node.textContent.includes(t('public.share.create')));
    create.click();
    await vi.waitFor(() => expect(container.querySelector('.share-url')).toBeTruthy());
    const url = container.querySelector('.share-url').value;
    const [, worker, sid, token] = /#\/s\/([^/]+)\/([^/]+)\/([0-9a-f]{32})$/.exec(url);
    expect([worker, sid]).toEqual([WORKER, space]);
    expect(h.kv()[K.entity(space, 'meta', 'meta')].share).toMatchObject({ on: true, plan: true, map: true, bookings: true, codes: false, costs: false });
    expect((await db.get(`share:${WORKER}:${space}`)).token).toBe(token);

    const calls = vi.spyOn(alice.api, 'call');
    const box = (key) => container.querySelector(`input[data-focus="share:${key}"]`);
    box('costs').click(); box('chat').click();
    await vi.waitFor(() => expect(h.kv()[K.entity(space, 'meta', 'meta')].share).toMatchObject({ costs: true, chat: true }), { timeout: 3000 });
    expect(calls.mock.calls.filter(([, op]) => op === 'share.set')).toHaveLength(1);

    section.destroy();
  });
});

describe('public viewer', () => {
  afterEach(() => { document.body.replaceChildren(); });
  const ALICE = USERS.alice.uuid;
  const BOB = USERS.bob.uuid;
  const ids = { day: id('d'), place: id('p'), visit: id('v'), res: id('r'), exp: id('e'), msg: id('m') };
  const snapshot = { rev: 4, at: 1, ents: [
    { t: 'member', id: ALICE, name: 'alice', role: 'owner', color: 1, cr: 1 },
    { t: 'member', id: BOB, name: 'bob', role: 'editor', color: 2, cr: 2 },
    { t: 'day', id: ids.day, order: 'V', date: '2027-05-01', title: 'Arrive', by: ALICE },
    { t: 'place', id: ids.place, name: 'Belém', lat: 38.69, lng: -9.21, address: 'Av. Brasília', rating: { [BOB]: 5 } },
    { t: 'visit', id: ids.visit, dayId: ids.day, placeId: ids.place, order: 'V', start: '10:00', people: [BOB] },
    { t: 'res', id: ids.res, type: 'flight', title: 'TP1', status: 'confirmed', code: 'ABC123', people: [ALICE],
      legs: [{ from: { code: 'LIS' }, to: { code: 'OPO' }, dep: { date: '2027-05-01', time: '08:00' }, arr: { date: '2027-05-01', time: '09:00' } }] },
    { t: 'exp', id: ids.exp, name: 'Taxi', amount: 1500, currency: 'EUR', payers: [{ who: BOB, amount: 1500 }], split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB }] } },
    { t: 'msg', id: ids.msg, text: 'see you', author: BOB, cr: 5 },
  ] };
  const meta = { title: 'Lisbon', currency: 'EUR', start: '2027-05-01', end: '2027-05-04' };
  function serve(share) {
    const body = JSON.stringify({ ok: true, ...project(snapshot, 'trip', share, { meta }) });
    return { workers: { exec: vi.fn(async () => new Response(body, { status: 200, headers: { ETag: '"x"' } })) } };
  }
  const open = async (puter) => {
    const view = document.createElement('div'); document.body.append(view);
    const controller = new AbortController();
    const destroy = await mount(view, { route: { name: 'public', worker: WORKER, space: S, token: TOKEN }, puter, signal: controller.signal });
    return { view, close: () => { destroy(); controller.abort(); } };
  };

  it('shows the shared sections with aliased people and nothing else', async () => {
    const { view, close } = await open(serve({ on: true, plan: true, bookings: true, costs: true, chat: true, map: false }));
    expect(view.querySelector('h1').textContent).toBe('Lisbon');
    expect([...view.querySelectorAll('[role=tab]')].map((node) => node.textContent)).toEqual([t('public.tab.plan'), t('public.tab.bookings'), t('public.tab.costs'), t('public.tab.chat')]);
    const text = view.textContent;
    expect(text).toContain('Arrive');
    expect(text).toContain('Belém');
    expect(text).toContain('TP1');
    expect(text).toContain(t('public.owes', { from: 'A.', to: 'B.' }));
    expect(text).toContain('see you');
    expect(text).not.toContain('ABC123');
    expect(text).not.toContain('Av. Brasília');
    expect(view.innerHTML).not.toContain(ALICE);
    close();
  });

  it('says when nothing is shared and when the link is gone', async () => {
    const empty = await open(serve({ on: true }));
    expect(empty.view.textContent).toContain(t('public.nothingTitle'));
    empty.close();
    const gone = await open({ workers: { exec: async () => new Response(JSON.stringify({ code: 'not_found' }), { status: 404 }) } });
    expect(gone.view.textContent).toContain(t('public.goneTitle'));
    expect(gone.view.querySelector('button.btn-primary')).toBeNull();
    gone.close();
  });
});

describe('shell on a public link', () => {
  afterEach(() => { window.history.replaceState(null, '', '/'); document.body.replaceChildren(); });

  it('opens the viewer without signing in and boots normally when leaving it', async () => {
    const world = createFakePuter({ users: [USERS.alice] });
    const puter = world.client(null);
    puter.workers.exec = vi.fn(async () => new Response(JSON.stringify({ code: 'not_found' }), { status: 404 }));
    const signIn = vi.spyOn(puter.auth, 'signIn');
    window.history.replaceState(null, '', `/#/s/${WORKER}/${S}/${TOKEN}`);
    const root = document.createElement('div'); document.body.append(root);
    const openDatabase = vi.fn();
    const app = createApp({ root, puter, openDatabase, mac: false });
    await app.start();
    expect(app.state.phase).toBe('public');
    await vi.waitFor(() => expect(root.textContent).toContain(t('public.goneTitle')));
    expect(document.title).toBe(t('public.docTitle'));
    expect(signIn).not.toHaveBeenCalled();
    expect(openDatabase).not.toHaveBeenCalled();
    window.location.hash = '#/';
    await vi.waitFor(() => expect(app.state.phase).toBe('signedOut'));
    app.destroy();
  });
});
