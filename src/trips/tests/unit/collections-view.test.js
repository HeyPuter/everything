import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { ApiError } from '../../src/lib/api.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createClock } from '../../src/shared/hlc.js';
import { strings } from '../../src/lib/i18n/index.js';
import { mount } from '../../src/views/collections/index.js';
import { deleteLabelOps } from '../../src/views/collections/labels.js';
import { openSaveToCollection } from '../../src/views/collections/save.js';
import { parseRoute, routeHash } from '../../src/lib/router.js';

const uid = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const collectionRef = { w: 'trips-012345abcd', s: '0000000000000001', k: 'collection' };
const tripRef = { w: 'trips-012345abcd', s: '0000000000000002', k: 'trip' };
const clock = createClock({ node: '0000000000000007', now: () => 1_000_000 });
const server = (t, id, fields) => ({ t, id, ...fields, v: clock.tick(), rev: 1, upd: 1000, by: bob, cr: 1000 });
const open = [];
const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
const byText = (root, text, selector = 'button') => [...root.querySelectorAll(selector)].find((node) => node.textContent.trim().startsWith(text));

async function world() {
  const fake = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
  const puter = fake.client(uid);
  const db = await openDatabase(uid, { indexedDB: new IDBFactory() });
  const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 1, changes: [] })), snapshot: vi.fn(), request: vi.fn() };
  const personal = createPersonalStore({ puter, db });
  return { puter, db, api, personal };
}
async function openKind(env, ref, ents, role = 'editor') {
  const space = await openSpace({ ref, db: env.db, api: env.api, puter: env.puter, personal: env.personal, role, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false });
  await space.store.replace({ rev: 1, ents: [server('member', uid, { name: 'Me', role }), ...ents] });
  open.push({ space });
  return space;
}
afterEach(() => {
  for (const entry of open.splice(0)) { entry.controller?.abort(); entry.cleanup?.(); entry.space?.close(); }
  document.body.replaceChildren();
  localStorage.clear();
});

const label = '1000000000000001';
const ents = [
  server('meta', 'meta', { name: 'Lisbon eats', color: 3, icon: 'utensils', desc: 'Where **we** eat', urls: [{ url: 'https://guide.example/lisbon', title: 'Guide' }] }),
  server('label', label, { name: 'Lunch', color: 2, order: 'a' }),
  server('saved', '2000000000000001', { name: 'Taberna', status: 'want', order: 'a', lat: 38.71, lng: -9.14, cat: 'restaurant', labels: [label] }),
  server('saved', '2000000000000002', { name: 'Miradouro', status: 'visited', order: 'b', lat: 38.72, lng: -9.13 }),
  server('saved', '2000000000000003', { name: 'Bookshop', status: 'idea', order: 'c' }),
];

async function detail(role = 'editor') {
  const env = await world();
  const space = await openKind(env, collectionRef, ents, role);
  const container = document.createElement('div');
  document.body.append(container);
  const controller = new AbortController();
  const context = { space, ref: collectionRef, route: { name: 'space', ref: collectionRef, tab: 'places' }, account: { uuid: uid }, personal: env.personal, puter: env.puter,
    session: { api: env.api, db: env.db, personal: env.personal, ownWorker: async () => null }, app: { navigate: vi.fn(), setSyncState: vi.fn() }, signal: controller.signal };
  const cleanup = await mount(container, context);
  open.push({ controller, cleanup });
  await frame();
  return { space, container, context };
}

describe('collection page', () => {
  it('shows meta, places with statuses and labels, and filters by status and search', async () => {
    const { container } = await detail();
    expect(container.querySelector('.col-detail-title').textContent).toBe('Lisbon eats');
    expect(container.querySelector('.col-desc strong').textContent).toBe('we');
    expect(container.querySelector('.col-urls a').getAttribute('href')).toBe('https://guide.example/lisbon');
    const names = () => [...container.querySelectorAll('.col-row-name')].map((node) => node.textContent);
    expect(names()).toEqual(['Taberna', 'Miradouro', 'Bookshop']);
    expect(container.querySelector('.col-row .col-label-chip').textContent).toBe('Lunch');
    container.querySelector('.col-status-toggle[data-status="visited"]').click();
    await vi.waitFor(() => expect(names()).toEqual(['Miradouro']));
    container.querySelector('.col-status-toggle[data-status="visited"]').click();
    const search = container.querySelector('.col-search input');
    search.value = 'book';
    search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(names()).toEqual(['Bookshop']));
  });

  it('changes the status of a selection and keeps viewers to their own fields', async () => {
    const { space, container } = await detail();
    container.querySelector(`[aria-label="${strings['collections.moreCollection']}"]`).click();
    byText(document.body, strings['collections.selectStart'], '.menu-item').click();
    await vi.waitFor(() => expect(container.querySelector('.col-bulk input[type=checkbox]')).toBeTruthy());
    container.querySelector('.col-bulk input[type=checkbox]').click();
    await vi.waitFor(() => expect(container.querySelector('.col-bulk-count').textContent).toContain('3'));
    byText(container, strings['collections.bulkStatus']).click();
    byText(document.body, strings['collections.status.revisit'], '.menu-item').click();
    await vi.waitFor(() => expect(space.select.saved.all().every((item) => item.status === 'revisit')).toBe(true));
    const viewer = await detail('viewer');
    expect(viewer.container.querySelector('.col-head-actions .btn-primary').hidden).toBe(true);
  });

  it('deletes a label and takes it off its places', async () => {
    const { space } = await detail();
    await space.apply(deleteLabelOps(space, [label]));
    expect(space.get('label', label)).toBeFalsy();
    expect(space.get('saved', '2000000000000001').labels).toBeUndefined();
  });
});

describe('collection dialogs', () => {
  it('opens place details, labels, sharing and the details form without errors', async () => {
    const { space, container, context } = await detail('owner');
    context.session.api.call.mockImplementation(async (_ref, op) => (op === 'invite.list' ? { invites: [] } : { rev: 1, changes: [] }));
    container.querySelector('.col-row-main').click();
    let dialog = document.querySelector('[role=dialog]');
    expect(dialog.querySelector('.modal-title').textContent).toBe('Taberna');
    byText(dialog, strings['collections.visitedNo']).click();
    await vi.waitFor(() => expect(space.get('saved', '2000000000000001').visited).toEqual({ [uid]: true }));
    dialog.querySelector('.modal-head .icon-btn').click();
    container.querySelector(`[aria-label="${strings['collections.moreCollection']}"]`).click();
    byText(document.body, strings['collections.labelsManage'], '.menu-item').click();
    dialog = document.querySelector('[role=dialog]');
    expect(dialog.querySelector('.col-label-row input').value).toBe('Lunch');
    dialog.querySelector('.modal-head .icon-btn').click();
    byText(container, strings['collections.share']).click();
    dialog = document.querySelector('[role=dialog]');
    await vi.waitFor(() => expect(dialog.textContent).toContain(strings['collections.linksEmpty']));
    expect(dialog.textContent).toContain(strings['collections.publicTitle']);
    dialog.querySelector('.modal-head .icon-btn').click();
    container.querySelector(`[aria-label="${strings['collections.moreCollection']}"]`).click();
    byText(document.body, strings['collections.editDetails'], '.menu-item').click();
    dialog = document.querySelector('[role=dialog]');
    dialog.querySelector('input').value = 'Lisbon bites';
    dialog.querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(space.get('meta', 'meta').name).toBe('Lisbon bites'));
  });

  it('lists collections from the index', async () => {
    const env = await world();
    await env.personal.spaces.upsert({ ref: collectionRef, role: 'viewer', title: 'Lisbon eats' });
    const container = document.createElement('div');
    document.body.append(container);
    const controller = new AbortController();
    const cleanup = await mount(container, { route: { name: 'collections' }, account: { uuid: uid }, personal: env.personal, puter: env.puter, signal: controller.signal,
      session: { api: env.api, db: env.db, personal: env.personal, ownWorker: async () => null }, app: { navigate: vi.fn() } });
    open.push({ controller, cleanup });
    await vi.waitFor(() => expect(container.querySelector('.col-card .col-card-name')?.textContent).toBe('Lisbon eats'));
    expect(container.querySelector('.col-card-link').getAttribute('href')).toBe('#/c/trips-012345abcd/0000000000000001/places');
    expect(container.querySelector('.col-card .col-card-sub').textContent).toContain(strings['collections.roleViewer']);
  });
});

describe('save to collection', () => {
  it('previews trip places, skips ones already saved and writes the rest with my data and a trip source', async () => {
    const env = await world();
    const target = await openKind(env, collectionRef, ents);
    const trip = await openKind(env, tripRef, [
      server('meta', 'meta', { title: 'Lisbon', currency: 'EUR' }),
      server('place', '3000000000000001', { name: 'Taberna', lat: 38.71, lng: -9.14 }),
      server('place', '3000000000000002', { name: 'Castle', lat: 38.7139, lng: -9.1335, cat: 'attraction', rating: { [uid]: 5, [bob]: 2 }, visited: { [uid]: true } }),
    ]);
    await env.personal.spaces.upsert({ ref: collectionRef, role: 'editor', title: 'Lisbon eats' });
    const context = { account: { uuid: uid }, personal: env.personal, puter: env.puter, app: { navigate: vi.fn() },
      session: { api: env.api, db: env.db, personal: env.personal, ownWorker: async () => null,
        withSpace: async (ref, fn) => ({ value: await fn(ref.s === collectionRef.s ? target : trip), flush: { status: 'queued' } }) } };
    const closed = openSaveToCollection(context, { space: trip });
    await vi.waitFor(() => expect(document.querySelector('[role=dialog]')?.textContent).toContain(strings['collections.alreadySaved']));
    const dialog = document.querySelector('[role=dialog]');
    expect(dialog.querySelectorAll('.col-preview-row').length).toBe(3);
    dialog.querySelector('form').requestSubmit();
    await closed;
    const castle = target.select.saved.all().find((item) => item.name === 'Castle');
    expect(castle).toMatchObject({ status: 'visited', cat: 'attraction', rating: { [uid]: 5 }, src: { trip: tripRef, placeId: '3000000000000002' } });
    expect(castle.rating).not.toHaveProperty(bob);
    expect(target.select.saved.all().filter((item) => item.name === 'Taberna').length).toBe(1);
  });
});

describe('collection routes', () => {
  it('parses the list and collection pages', () => {
    expect(parseRoute('#/collections')).toEqual({ name: 'collections' });
    expect(routeHash({ name: 'collections' })).toBe('#/collections');
    expect(parseRoute(`#/c/${collectionRef.w}/${collectionRef.s}`)).toEqual({ name: 'space', ref: collectionRef, tab: 'places' });
    expect(parseRoute('#/collections/x').name).toBe('notFound');
  });
});
