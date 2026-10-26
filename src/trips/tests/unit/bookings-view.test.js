import { afterEach, describe, expect, it } from 'vitest';
import { createSelectors } from '../../src/lib/store/query.js';
import { applyPatch, validateOperation } from '../../src/shared/operations.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import { can } from '../../src/shared/perms.js';
import { createClock } from '../../src/shared/hlc.js';
import { mount } from '../../src/views/trip/bookings/index.js';

const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
let seq = 0;
const makeId = () => `4${String(++seq).padStart(15, '0')}`;
const clock = createClock({ node: '0000000000000007', now: () => 1_000_000 });
const V1 = clock.tick();
const tick = (ms = 0) => new Promise((resolve) => { setTimeout(resolve, ms); });
const byText = (root, text, selector = 'button') => [...root.querySelectorAll(selector)].find((node) => node.textContent.trim() === text);
const dialog = () => [...document.querySelectorAll('[role=dialog]')].at(-1);
const typeInto = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
const setValue = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); };
const fieldInput = (root, label) => {
  const node = [...root.querySelectorAll('label')].find((item) => item.textContent.trim() === label);
  return node && document.getElementById(node.htmlFor);
};

/** A minimal in-memory `space` with the facade the view uses; ops are validated with the shared rules. */
function stubSpace({ role = 'editor', ents = [] } = {}) {
  const data = new Map();
  const arrays = new Map();
  const listeners = new Set();
  const applied = [];
  const typeMap = (type) => { if (!data.has(type)) data.set(type, new Map()); return data.get(type); };
  for (const { t, ...entity } of ents) typeMap(t).set(entity.id, Object.freeze({ v: V1, rev: 1, upd: 1, by: ALICE, cr: 1, ...entity }));
  const source = (type) => {
    if (!arrays.has(type)) arrays.set(type, Object.freeze([...(data.get(type)?.values() ?? [])]));
    return arrays.get(type);
  };
  const get = (type, id) => data.get(type)?.get(id);
  const space = {
    role,
    select: null,
    state: { sync: 'synced', rev: 5, issue: null },
    store: { serverVersion: (type, id) => get(type, id)?.v },
    can: (action) => can(role, action, {}),
    get,
    members: () => [{ uid: ALICE, name: 'Alice', role: 'owner' }, { uid: BOB, name: 'Bob', role: 'editor' }],
    conflicts: () => [],
    history: { canUndo: false },
    ops: {
      create: (t, put) => ({ opId: makeId(), t, id: makeId(), put: structuredClone(put) }),
      patch: (t, id, { set, unset } = {}, { base = false } = {}) => ({ opId: makeId(), t, id, ...(set && Object.keys(set).length ? { set } : {}), ...(unset?.length ? { unset } : {}), ...(base ? { base: get(t, id)?.v } : {}) }),
      remove: (t, id, { base = false } = {}) => ({ opId: makeId(), t, id, del: true, ...(base ? { base: get(t, id)?.v } : {}) }),
    },
    async apply(ops) {
      const types = new Set();
      for (const op of ops) {
        validateOperation(op);
        const map = typeMap(op.t);
        if (op.put) map.set(op.id, Object.freeze(validateEntity('trip', op.t, { ...op.put }) && { ...op.put, id: op.id, v: clock.tick(), rev: 2, upd: 2, by: ALICE, cr: 2 }));
        else if (op.del) map.delete(op.id);
        else map.set(op.id, Object.freeze({ ...applyPatch('trip', op.t, map.get(op.id), op), v: clock.tick() }));
        arrays.delete(op.t); types.add(op.t);
      }
      applied.push(ops);
      for (const listener of listeners) listener({ changed: new Set(), types, rev: 6 });
    },
    subscribe(target, listener) {
      const entry = typeof target === 'function' ? target : listener;
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    onState: () => () => {},
    resolveConflict: async () => {},
  };
  space.select = createSelectors({ kind: 'trip', source, get, subscribe: () => () => {} });
  return { space, applied };
}

const days = ['2027-05-01', '2027-05-02', '2027-05-03'].map((date, index) => ({ t: 'day', id: `d00000000000000${index + 1}`, order: `a${index}`, date }));
const flight = {
  t: 'res', id: 'r000000000000001', type: 'flight', title: 'LIS → JFK', status: 'confirmed', code: 'ABC123', people: [BOB],
  legs: [
    { from: { code: 'LIS', tz: 'Europe/Lisbon' }, to: { code: 'MAD', tz: 'Europe/Madrid' }, dep: { date: '2027-05-02', time: '08:00' }, arr: { date: '2027-05-02', time: '10:15' }, carrier: 'TAP', number: 'TP1', seat: '12A' },
    { from: { code: 'MAD', tz: 'Europe/Madrid' }, to: { code: 'JFK', tz: 'America/New_York' }, dep: { date: '2027-05-02', time: '12:00' }, arr: { date: '2027-05-02', time: '14:30' } },
  ],
  start: { date: '2027-05-02', time: '08:00', tz: 'Europe/Lisbon' }, end: { date: '2027-05-02', time: '14:30', tz: 'America/New_York' },
};
const hotel = { t: 'res', id: 'r000000000000002', type: 'lodging', title: 'Hotel Avenida', status: 'pending', start: { date: '2027-05-01' }, end: { date: '2027-05-03' }, stay: { checkInFrom: '15:00', checkOut: '11:00', fromDayId: days[0].id, toDayId: days[2].id } };
const file = { t: 'file', id: 'f000000000000001', name: 'ticket.pdf', mime: 'application/pdf', size: 10, sha256: 'a'.repeat(64), kind: 'user', loc: { mode: 'proxied' }, links: [{ t: 'res', id: flight.id }] };
const airports = [
  { iata: 'LIS', name: 'Humberto Delgado Airport', city: 'Lisbon', country: 'PT', lat: 38.77, lng: -9.13, tz: 'Europe/Lisbon' },
  { iata: 'OPO', name: 'Francisco Sá Carneiro Airport', city: 'Porto', country: 'PT', lat: 41.24, lng: -8.68, tz: 'Europe/Lisbon' },
];
const session = { services: {
  airports: {
    search: async (query) => airports.filter((item) => `${item.iata} ${item.city}`.toLowerCase().includes(query.toLowerCase())),
    byCode: async (code) => airports.find((item) => item.iata === code.toUpperCase()) ?? null,
  },
  tz: { zoneAt: async () => 'Europe/Lisbon' },
  geocode: null,
} };

const mounted = [];
async function view(options) {
  const { space, applied } = stubSpace(options);
  const controller = new AbortController();
  const container = document.createElement('div');
  document.body.append(container);
  const cleanup = await mount(container, { space, session, signal: controller.signal, route: { tab: 'bookings' } });
  mounted.push({ controller, cleanup });
  return { space, applied, container };
}
afterEach(() => {
  for (const { controller, cleanup } of mounted.splice(0)) { controller.abort(); cleanup?.(); }
  document.body.replaceChildren();
});

describe('bookings tab', () => {
  it('offers adding to editors and only viewing to viewers', async () => {
    const editor = await view({ ents: days });
    expect(editor.container.textContent).toContain('No bookings yet');
    expect(byText(editor.container, 'Add booking')).toBeTruthy();
    document.body.replaceChildren();
    const viewer = await view({ role: 'viewer', ents: [...days, flight] });
    expect(byText(viewer.container.querySelector('.bookings-head'), 'Add booking').hidden).toBe(true);
    expect(viewer.container.textContent).toContain('You can view bookings');
  });

  it('lists bookings by status with legs, codes and attachments, and filters them', async () => {
    const { container } = await view({ ents: [...days, flight, hotel, file] });
    const groups = [...container.querySelectorAll('.bookings-group-title')].map((node) => node.textContent);
    expect(groups).toEqual(['Pending (1)', 'Confirmed (1)']);
    expect(container.querySelectorAll('.res-legs-summary li')).toHaveLength(2);
    expect(container.textContent).toContain('ABC123');
    expect(container.textContent).toContain('1 attachment');
    byText(container, 'Transport').click();
    expect(container.querySelectorAll('.res-row')).toHaveLength(1);
    byText(container, 'By day').click();
    const titles = [...container.querySelectorAll('.bookings-group-title')].map((node) => node.textContent);
    expect(titles).toHaveLength(3);
    expect(container.querySelectorAll('.res-entry')).toHaveLength(2);
    byText(container, 'All').click();
    expect(container.querySelectorAll('.res-phase')).toHaveLength(3);
    expect([...container.querySelectorAll('.res-phase')].map((node) => node.textContent)).toEqual(['Check-in', 'Stay', 'Check-out']);
  });

  it('creates a flight with airport time zones', async () => {
    const { container, applied } = await view({ ents: days });
    byText(container, 'Add booking').click();
    byText(document.body, 'Flight', '[role=menuitem]').click();
    const form = dialog();
    expect(form.querySelector('h2').textContent).toBe('New booking');
    const from = fieldInput(form, 'From');
    typeInto(from, 'lis');
    await tick(200);
    const option = form.querySelector('[role=option]');
    expect(option.textContent).toContain('LIS · Humberto Delgado Airport');
    option.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    await tick();
    const to = fieldInput(form, 'To');
    setValue(to, 'OPO');
    await tick();
    setValue(fieldInput(form, 'Departure date'), '2027-05-02');
    setValue(fieldInput(form, 'Departure time'), '09:00');
    setValue(fieldInput(form, 'Arrival time'), '10:00');
    expect(form.textContent).toContain('Travel time');
    byText(form, 'Add booking').click();
    await tick();
    expect(dialog()).toBeUndefined();
    const [create] = applied.at(-1);
    expect(create.put).toMatchObject({
      type: 'flight', title: 'LIS → OPO', status: 'pending',
      legs: [{ from: { code: 'LIS', tz: 'Europe/Lisbon' }, to: { code: 'OPO', tz: 'Europe/Lisbon' }, dep: { date: '2027-05-02', time: '09:00' }, arr: { date: '2027-05-02', time: '10:00' } }],
      start: { date: '2027-05-02', time: '09:00', tz: 'Europe/Lisbon' },
    });
    expect(container.querySelectorAll('.res-row')).toHaveLength(1);
  });

  it('requires a departure date', async () => {
    const { container, applied } = await view({ ents: days });
    byText(container, 'Add booking').click();
    byText(document.body, 'Train', '[role=menuitem]').click();
    byText(dialog(), 'Add booking').click();
    await tick();
    expect(dialog().textContent).toContain('Enter a departure date.');
    expect(applied).toHaveLength(0);
  });

  it('edits through details with a conflict-checked patch and keeps day ids for stays', async () => {
    const { container, applied } = await view({ ents: [...days, hotel] });
    byText(container, 'Hotel Avenida').click();
    expect(dialog().textContent).toContain('Check-in from');
    byText(dialog(), 'Edit').click();
    const form = dialog();
    typeInto(fieldInput(form, 'Name'), 'Casa');
    setValue(fieldInput(form, 'Check-out date'), '2027-05-02');
    byText(form, 'Save').click();
    await tick();
    const [patch] = applied.at(-1);
    expect(patch).toMatchObject({ t: 'res', id: hotel.id, base: V1, set: { title: 'Casa', end: { date: '2027-05-02' }, stay: { checkInFrom: '15:00', checkOut: '11:00', fromDayId: days[0].id, toDayId: days[1].id } } });
  });

  it('deletes a booking and unlinks its files', async () => {
    const { container, applied } = await view({ ents: [...days, flight, file] });
    container.querySelector('.res-side .icon-btn').click();
    byText(document.body, 'Delete', '[role=menuitem]').click();
    byText(dialog(), 'Delete').click();
    await tick();
    expect(applied.at(-1)).toMatchObject([{ t: 'res', id: flight.id, del: true }, { t: 'file', id: file.id, unset: ['links'] }]);
    expect(container.textContent).toContain('No bookings yet');
  });
});
