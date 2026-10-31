import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { ApiError } from '../../src/lib/api.js';
import { createPlanState } from '../../src/views/trip/plan/state.js';
import { mountPlaces } from '../../src/views/trip/places/index.js';
import { deletePlacesOps, linkedExpenses, placePatch } from '../../src/views/trip/places/actions.js';
import { filterPlaces, plannedDays } from '../../src/views/trip/places/filter.js';

const me = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
let sequence = 100;
const makeId = () => `0000000000${String(++sequence).padStart(6, '0')}`;
const open = [];
const names = (container) => [...container.querySelectorAll('.pl-name')].map((node) => node.textContent);
const byText = (root, text, selector = 'button') => [...root.querySelectorAll(selector)].find((node) => node.textContent.trim() === text);
const dialog = () => [...document.querySelectorAll('[role=dialog]')].at(-1);
const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };

async function mount({ role = 'owner' } = {}) {
  const world = createFakePuter({ users: [{ uuid: me, username: 'me' }] });
  const puter = world.client(me);
  const db = await openDatabase(me, { indexedDB: new IDBFactory() });
  const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 0, changes: [] })), snapshot: vi.fn() };
  const personal = createPersonalStore({ puter, db });
  const space = await openSpace({ ref, db, api, puter, personal, role, makeId, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false });
  const plan = createPlanState();
  const container = document.createElement('div');
  document.body.append(container);
  const controller = new AbortController();
  const register = vi.fn(() => () => {});
  const cleanup = mountPlaces(container, { space, plan, account: { uuid: me }, personal, puter, signal: controller.signal, app: { commands: { register } } });
  open.push({ space, cleanup, db });
  return { space, plan, container, register };
}
afterEach(() => {
  for (const { space, cleanup, db } of open.splice(0)) { cleanup(); space.close(); db.close(); }
  document.body.replaceChildren();
});

describe('places pane', () => {
  it('adds a place from the form and lists it', async () => {
    const { space, container, register } = await mount();
    expect(container.textContent).toContain('No places yet');
    expect(register.mock.calls.map(([command]) => command.id)).toEqual(['places-new', 'places-search', 'trip-export', 'trip-import', 'tracks-import']);
    byText(container, 'Add place').click();
    const form = dialog();
    const [name] = form.querySelectorAll('input');
    type(name, 'Belém Tower');
    const lat = [...form.querySelectorAll('label')].find((node) => node.textContent === 'Latitude').control;
    const lng = [...form.querySelectorAll('label')].find((node) => node.textContent === 'Longitude').control;
    type(lat, '38.6916'); type(lng, '-9.2160');
    form.querySelector('select').value = 'attraction';
    form.querySelector('select').dispatchEvent(new Event('change'));
    form.querySelector('form').requestSubmit();
    // Saving may wait briefly for the boundary lookup.
    await vi.waitFor(() => expect(space.select.place.all()).toHaveLength(1), { timeout: 3000 });
    const [place] = space.select.place.all();
    expect(place).toMatchObject({ name: 'Belém Tower', lat: 38.6916, lng: -9.216, cat: 'attraction', src: 'manual' });
    await vi.waitFor(() => expect(container.querySelector('.pl-name')?.textContent).toBe('Belém Tower'));
  });

  it('fills the country and region from the bundled boundaries when saving offline', async () => {
    const data = `${process.cwd()}/public/data`;
    vi.stubGlobal('fetch', async (url) => {
      const path = new URL(url).pathname.replace(/^\/data\//, '');
      try { return new Response(readFileSync(`${data}/${path}`, 'utf8'), { status: 200 }); } catch { return new Response('', { status: 404 }); }
    });
    try {
      // Warm the page cache the way an earlier lookup would, so the save does not race the first decode.
      const { locatePlace } = await import('../../src/lib/atlas/boundaries.js');
      await locatePlace(38.69, -9.21);
      await locatePlace(40.4, -3.7);
      const { space, container } = await mount();
      byText(container, 'Add place').click();
      let form = dialog();
      const field = (text) => [...form.querySelectorAll('label')].find((node) => node.textContent === text).control;
      type(field('Name'), 'Belém Tower'); type(field('Latitude'), '38.6916'); type(field('Longitude'), '-9.2160');
      form.querySelector('form').requestSubmit();
      await vi.waitFor(() => expect(space.select.place.all()).toHaveLength(1), { timeout: 5000 });
      const [place] = space.select.place.all();
      expect(place).toMatchObject({ cc: 'PT', admin1: 'PT-11' });
      // Moving it to Madrid replaces both.
      container.querySelector('.pl-name').click();
      await vi.waitFor(() => expect(byText(container, 'Edit')).toBeTruthy());
      byText(container, 'Edit').click();
      form = dialog();
      type(field('Latitude'), '40.4168'); type(field('Longitude'), '-3.7038');
      form.querySelector('form').requestSubmit();
      await vi.waitFor(() => expect(space.get('place', place.id)).toMatchObject({ cc: 'ES', admin1: 'ES-M' }), { timeout: 5000 });
    } finally { vi.unstubAllGlobals(); }
  });

  it('refuses a half-filled location and fills both boxes from a pasted link', async () => {
    const { container } = await mount();
    byText(container, 'Add place').click();
    const form = dialog();
    const inputs = [...form.querySelectorAll('label')];
    const name = inputs.find((node) => node.textContent === 'Name').control;
    const lat = inputs.find((node) => node.textContent === 'Latitude').control;
    const lng = inputs.find((node) => node.textContent === 'Longitude').control;
    type(name, 'Somewhere'); type(lat, '38.7');
    form.querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(form.textContent).toContain('Fill in both latitude and longitude'));
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    paste.clipboardData = { getData: () => 'https://www.google.com/maps/place/Torre/@38.6916,-9.216,17z' };
    lng.dispatchEvent(paste);
    expect([lat.value, lng.value]).toEqual(['38.6916', '-9.216']);
  });

  it('filters by planned state for the open day and by category', async () => {
    const { space, plan, container } = await mount();
    const day = makeId(); const a = makeId(); const b = makeId();
    await space.apply([space.ops.create('day', { order: 'a', date: '2027-05-01' }, { id: day }),
      space.ops.create('place', { name: 'Alpha', cat: 'restaurant' }, { id: a }), space.ops.create('place', { name: 'Beta' }, { id: b }),
      space.ops.create('visit', { dayId: day, placeId: a, order: 'a' })]);
    await vi.waitFor(() => expect(names(container)).toHaveLength(2));
    byText(container, 'Planned').click();
    expect([...container.querySelectorAll('.pl-name')].map((node) => node.textContent)).toEqual(['Alpha']);
    byText(container, 'Unplanned').click();
    expect([...container.querySelectorAll('.pl-name')].map((node) => node.textContent)).toEqual(['Beta']);
    plan.set({ day: makeId() });
    await vi.waitFor(() => expect(names(container).sort()).toEqual(['Alpha', 'Beta']));
    byText(container, 'All').click();
    type(container.querySelector('input[type=search]'), 'restaurant');
    expect([...container.querySelectorAll('.pl-name')].map((node) => node.textContent)).toEqual(['Alpha']);
  });

  it('marks selected places visited in bulk and deletes a place with its visits', async () => {
    const { space, container } = await mount();
    const day = makeId(); const a = makeId(); const b = makeId(); const visit = makeId();
    await space.apply([space.ops.create('day', { order: 'a', date: null }, { id: day }),
      space.ops.create('place', { name: 'Alpha' }, { id: a }), space.ops.create('place', { name: 'Beta' }, { id: b }),
      space.ops.create('visit', { dayId: day, placeId: a, order: 'a' }, { id: visit })]);
    await vi.waitFor(() => expect(names(container)).toHaveLength(2));
    container.querySelector('.pl-head .icon-btn').click();
    byText(document.body, 'Select places', '.menu-item').click();
    byText(container, 'Select all shown', 'label').querySelector('input').click();
    byText(container, 'Mark visited').click();
    await vi.waitFor(() => expect(space.select.place.all().every((place) => place.visited?.[me] === true)).toBe(true));
    byText(container, 'Delete').click();
    expect(dialog().textContent).toContain('along with its 1 visits');
    byText(dialog(), 'Delete').click();
    await vi.waitFor(() => expect(space.select.place.all()).toHaveLength(0));
    expect(space.select.visit.all()).toHaveLength(0);
  });

  it('opens the form prefilled when the map picks a location, and opens details on request', async () => {
    const { space, plan, container } = await mount();
    plan.emit('pickLocation', { lat: 41.4036, lng: 2.1744, name: 'Sagrada Família' });
    const form = dialog();
    expect([...form.querySelectorAll('input')].map((input) => input.value)).toEqual(expect.arrayContaining(['Sagrada Família', '41.4036', '2.1744']));
    form.querySelector('[aria-label=Close]').click();
    const id = makeId();
    await space.apply([space.ops.create('place', { name: 'Park Güell', rating: { [me]: 4 } }, { id })]);
    plan.emit('openPlace', { id });
    expect(container.querySelector('.pl-detail-title').textContent).toBe('Park Güell');
    expect(plan.get().place).toBe(id);
    expect(container.textContent).toContain('Average 4, ratings: 1');
  });

  it('lets viewers rate and tag but not add or edit', async () => {
    const { space, container } = await mount({ role: 'viewer' });
    const id = makeId();
    await space.store.receive([{ rev: 1, ents: [{ t: 'place', id, name: 'Miradouro', v: '0000000001:000000:0000000000000001', rev: 1, upd: 1, by: other, cr: 1 }], del: [] }]);
    await vi.waitFor(() => expect(names(container)).toEqual(['Miradouro']));
    expect(byText(container, 'Add place').hidden).toBe(true);
    container.querySelector('.pl-main').click();
    expect(byText(container, 'Edit')).toBeUndefined();
    container.querySelector('[aria-label="5 of 5 stars"]').click();
    await vi.waitFor(() => expect(space.get('place', id).rating).toEqual({ [me]: 5 }));
  });
});

describe('place op builders', () => {
  const fakeSpace = (entities, perms = {}) => {
    const all = (type) => entities.filter((entity) => entity.t === type);
    return {
      get: (type, id) => all(type).find((entity) => entity.id === id) ?? null,
      can: (action) => perms[action] ?? true,
      select: new Proxy({}, { get: (_, type) => ({ all: () => all(type), groupBy: (field) => all(type).reduce((map, entity) => map.set(entity[field], [...(map.get(entity[field]) ?? []), entity]), new Map()) }) }),
      ops: {
        remove: (t, id, options) => ({ t, id, del: true, ...(options?.base ? { base: 'v' } : {}) }),
        patch: (t, id, change, options) => ({ t, id, ...change, ...(options?.base ? { base: 'v' } : {}) }),
      },
    };
  };
  const entities = [
    { t: 'place', id: 'p1', name: 'A' }, { t: 'place', id: 'p2', name: 'B' },
    { t: 'visit', id: 'v1', placeId: 'p1', dayId: 'd1' }, { t: 'visit', id: 'v2', placeId: 'p2', dayId: 'd2', endDayId: 'd3' },
    { t: 'res', id: 'r1', placeId: 'p1' },
    { t: 'file', id: 'f1', links: [{ t: 'place', id: 'p1' }, { t: 'exp', id: 'e1' }] },
    { t: 'exp', id: 'e1', links: [{ t: 'place', id: 'p1' }] }, { t: 'exp', id: 'e2', links: [{ t: 'place', id: 'p1' }, { t: 'res', id: 'r1' }] },
  ];

  it('removes visits and unlinks bookings, files and expenses, deleting only chosen last-link expenses', () => {
    const space = fakeSpace(entities);
    expect(linkedExpenses(space, ['p1']).map(({ exp, last }) => [exp.id, last])).toEqual([['e1', true], ['e2', false]]);
    expect(deletePlacesOps(space, ['p1'], { deleteExpenses: new Set(['e1', 'e2']) })).toEqual([
      { t: 'visit', id: 'v1', del: true },
      { t: 'place', id: 'p1', del: true },
      { t: 'res', id: 'r1', unset: ['placeId'] },
      { t: 'file', id: 'f1', set: { links: [{ t: 'exp', id: 'e1' }] } },
      { t: 'exp', id: 'e1', del: true, base: 'v' },
      { t: 'exp', id: 'e2', set: { links: [{ t: 'res', id: 'r1' }] }, base: 'v' },
    ]);
  });

  it('skips links the caller may not edit and does nothing without plan.edit', () => {
    expect(deletePlacesOps(fakeSpace(entities, { 'costs.edit': false, 'files.edit': false, 'res.edit': false }), ['p1']).map((op) => op.t)).toEqual(['visit', 'place']);
    expect(deletePlacesOps(fakeSpace(entities, { 'plan.edit': false }), ['p1'])).toEqual([]);
  });

  it('patches only changed form fields and unsets cleared ones', () => {
    const before = { name: 'A', notes: 'old', lat: 1, lng: 2, price: { amount: 5, currency: 'EUR' }, rating: { [me]: 3 } };
    expect(placePatch(before, { name: 'A', notes: undefined, lat: 1, lng: 2.5, price: { amount: 5, currency: 'EUR' }, web: 'https://x.test/' }))
      .toEqual({ set: { lng: 2.5, web: 'https://x.test/' }, unset: ['notes'] });
  });

  it('counts multi-day visits on their end day for the planned filter', () => {
    const visits = new Map([['p2', [entities[3]]]]);
    expect([...plannedDays('p2', visits)]).toEqual(['d2', 'd3']);
    const places = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }];
    expect(filterPlaces(places, { scope: 'planned', day: 'd3', visitsByPlace: visits }).map((place) => place.id)).toEqual(['p2']);
    expect(filterPlaces(places, { scope: 'unplanned', visitsByPlace: visits }).map((place) => place.id)).toEqual(['p1']);
  });

  it('does not count Plan B stops as planned', () => {
    const visits = new Map([['p1', [{ id: 'v9', dayId: 'd1', placeId: 'p1', order: 'a', alt: 'alt0000000000001' }]]]);
    expect([...plannedDays('p1', visits)]).toEqual([]);
    const places = [{ id: 'p1', name: 'A' }];
    expect(filterPlaces(places, { scope: 'unplanned', visitsByPlace: visits }).map((place) => place.id)).toEqual(['p1']);
    expect(filterPlaces(places, { scope: 'planned', day: 'd1', visitsByPlace: visits })).toEqual([]);
  });
});
