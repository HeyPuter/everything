import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { ApiError } from '../../src/lib/api.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createClock } from '../../src/shared/hlc.js';
import { createCommandRegistry } from '../../src/views/registry/commands.js';
import { mount } from '../../src/views/trip/plan/index.js';
import { dayImpact } from '../../src/views/trip/plan/ops.js';

const uid = '00000000-0000-4000-8000-000000000001';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
let seq = 0;
const makeId = () => `5${String(++seq).padStart(15, '0')}`;
const clock = createClock({ node: '0000000000000009', now: () => 1_000_000 });
const server = (t, id, fields) => ({ t, id, ...fields, v: clock.tick(), rev: 1, upd: 1000, by: uid, cr: 1000 });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };
const opened = [];

async function setup({ role = 'owner', ents = [] } = {}) {
  const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
  const puter = world.client(uid);
  const db = await openDatabase(uid, { indexedDB: new IDBFactory() });
  const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 0, changes: [] })), snapshot: vi.fn() };
  const personal = createPersonalStore({ puter, db });
  const space = await openSpace({ ref, db, api, puter, personal, role, makeId, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false, autoStart: false });
  await space.store.replace({ rev: 1, ents: [server('meta', 'meta', { title: 'Lisbon', currency: 'EUR', start: '2027-05-01', end: '2027-05-03' }), ...ents] });
  const container = document.createElement('div');
  document.body.append(container);
  const commands = createCommandRegistry([]);
  const cleanup = await mount(container, { space, app: { navigate: vi.fn(), commands }, route: { name: 'space', ref, tab: 'plan' }, ref });
  opened.push({ db, space, cleanup });
  await settle();
  return { space, container, commands };
}
const days = [
  server('day', 'd000000000000001', { order: 'a1', date: '2027-05-01' }),
  server('day', 'd000000000000002', { order: 'a2', date: '2027-05-02' }),
  server('day', 'd000000000000003', { order: 'a3', date: '2027-05-03' }),
];
const visits = [
  server('visit', 'v000000000000001', { dayId: 'd000000000000001', placeId: null, title: 'Breakfast', order: 'a1', start: '08:00' }),
  server('visit', 'v000000000000002', { dayId: 'd000000000000001', placeId: null, title: 'Museum', order: 'a2' }),
];
const key = (target, value, options = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options }));
const titles = (container, dayId) => [...container.querySelectorAll(`.plan-day[data-day="${dayId}"] .plan-row-title`)].map((node) => node.textContent);

beforeEach(() => { document.body.replaceChildren(); });
afterEach(() => {
  for (const { db, space, cleanup } of opened.splice(0)) { cleanup(); space.close(); db.close(); }
  document.body.replaceChildren();
});

describe('plan view', () => {
  it('sets up days from the trip dates and renders their timelines', async () => {
    const { space, container } = await setup();
    expect(container.textContent).toContain('No days yet');
    container.querySelector('.empty .btn').click();
    await settle();
    expect(space.select.day.all().map((day) => day.date)).toEqual(['2027-05-01', '2027-05-02', '2027-05-03']);
    expect([...container.querySelectorAll('.plan-day-num')].map((node) => node.textContent)).toEqual(['Day 1', 'Day 2', 'Day 3']);
  });

  it('reorders with the keyboard, crosses days through visit.move, and undoes it', async () => {
    const { space, container, commands } = await setup({ ents: [...days, ...visits] });
    expect(titles(container, 'd000000000000001')).toEqual(['Breakfast', 'Museum']);
    key(container.querySelector('[data-focus="grip:visit:v000000000000001"]'), 'ArrowDown', { altKey: true });
    await settle();
    expect(titles(container, 'd000000000000001')).toEqual(['Museum', 'Breakfast']);
    key(container.querySelector('[data-focus="grip:visit:v000000000000001"]'), 'ArrowDown', { altKey: true });
    await settle();
    expect(space.get('visit', 'v000000000000001').dayId).toBe('d000000000000002');
    expect(space.store.pending.at(-1)).toMatchObject({ do: 'visit.move' });
    expect(document.activeElement?.dataset.focus).toBe('grip:visit:v000000000000001');
    await commands.get('plan-undo').run();
    await settle();
    expect(space.get('visit', 'v000000000000001').dayId).toBe('d000000000000001');
  });

  it('previews and applies a day removal through the local adapter', async () => {
    const note = server('dayNote', 'n000000000000001', { dayId: 'd000000000000002', order: 'a1', title: 'Rest' });
    const hotel = server('res', 'r000000000000001', { type: 'lodging', title: 'Hotel', status: 'confirmed', start: { date: '2027-05-02' }, end: { date: '2027-05-03' } });
    const { space, container } = await setup({ ents: [...days, ...visits, note, hotel] });
    const impact = dayImpact(space, 'd000000000000002');
    expect(impact).toMatchObject({ notes: 1, shifted: 1, end: '2027-05-02', needs: { res: true, trip: true } });
    expect(impact.cancelled.map((res) => res.title)).toEqual(['Hotel']);
    const day = container.querySelector('.plan-day[data-day="d000000000000002"]');
    day.querySelector('.plan-day-actions .icon-btn:last-child').click();
    [...document.querySelectorAll('.menu-item')].find((node) => node.textContent.includes('Remove day')).click();
    await settle();
    expect(document.querySelector('.plan-impact').textContent).toContain('Cancel the stay at Hotel');
    document.querySelector('.modal-panel form').requestSubmit();
    await settle();
    expect(space.get('day', 'd000000000000002')).toBeUndefined();
    expect(space.get('day', 'd000000000000003').date).toBe('2027-05-02');
    expect(space.get('res', 'r000000000000001').status).toBe('cancelled');
    expect(space.get('meta', 'meta').end).toBe('2027-05-02');
  });

  it('lists links to the deleted visits and the stay days a removal needs', async () => {
    const walk = server('visit', 'v000000000000009', { dayId: 'd000000000000002', placeId: null, title: 'Walk', order: 'a1' });
    const exp = server('exp', 'e000000000000001', { name: 'Guide', amount: 500, currency: 'EUR', payers: [], split: { mode: 'equal', parts: [{ who: uid }] }, links: [{ t: 'visit', id: walk.id }] });
    const flat = server('res', 'r000000000000002', { type: 'lodging', title: 'Flat', status: 'confirmed', stay: { fromDayId: 'd000000000000001', toDayId: 'd000000000000002' } });
    const { space } = await setup({ ents: [...days, walk, exp, flat] });
    const impact = dayImpact(space, 'd000000000000002');
    expect(impact.args()).toEqual({
      day: 'd000000000000002', visits: [walk.id], res: [flat.id], days: ['d000000000000003', 'd000000000000001'], unlink: [exp.id],
    });
    expect(impact.cancelled.map((res) => res.title)).toEqual(['Flat']);
    await space.apply([space.ops.domain('day.remove', impact.args())]);
    expect(space.get('exp', exp.id).links).toBeUndefined();
    expect(space.get('res', flat.id).status).toBe('cancelled');
  });

  it('adds an item from the day menu and places pool places on a day', async () => {
    const place = server('place', 'p000000000000001', { name: 'Tower' });
    const { space, container } = await setup({ ents: [...days, place] });
    const day = container.querySelector('.plan-day[data-day="d000000000000003"]');
    day.querySelector('.plan-day-actions .icon-btn').click();
    [...document.querySelectorAll('.menu-item')].find((node) => node.textContent.includes('Add item')).click();
    const form = document.querySelector('.modal-panel form');
    form.querySelector('input').value = 'Free time';
    form.requestSubmit();
    await settle();
    expect(titles(container, 'd000000000000003')).toEqual(['Free time']);
    day.querySelector('.plan-day-actions .icon-btn').click();
    [...document.querySelectorAll('.menu-item')].find((node) => node.textContent.includes('Add places')).click();
    document.querySelector('.plan-pick-places .pick-item').click();
    [...document.querySelectorAll('.modal-actions .btn')].find((node) => node.textContent.startsWith('Add selected')).click();
    await settle();
    expect(space.select.visit.all().map((visit) => visit.placeId)).toContain('p000000000000001');
    expect(titles(container, 'd000000000000003')).toEqual(['Free time', 'Tower']);
  });

  it('is read-only for viewers', async () => {
    const { container } = await setup({ role: 'viewer', ents: [...days, ...visits] });
    expect(container.querySelector('[data-drag-handle]')).toBeNull();
    expect(container.textContent).toContain('You can view this plan');
  });
});
