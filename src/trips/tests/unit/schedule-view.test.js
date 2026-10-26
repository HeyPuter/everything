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
import { createActions, dayCountPatch, dayImpact } from '../../src/views/trip/plan/ops.js';

const uid = '00000000-0000-4000-8000-000000000001';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
let seq = 0;
const makeId = () => `5${String(++seq).padStart(15, '0')}`;
const clock = createClock({ node: '0000000000000009', now: () => 1_000_000 });
const server = (t, id, fields) => ({ t, id, ...fields, v: clock.tick(), rev: 1, upd: 1000, by: uid, cr: 1000 });
const opened = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };

async function openTrip({ role = 'owner', meta = {}, ents = [] } = {}) {
  const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
  const puter = world.client(uid);
  const db = await openDatabase(uid, { indexedDB: new IDBFactory() });
  const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 0, changes: [] })), snapshot: vi.fn() };
  const personal = createPersonalStore({ puter, db });
  const space = await openSpace({ ref, db, api, puter, personal, role, makeId, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false, autoStart: false });
  await space.store.replace({ rev: 1, ents: [server('meta', 'meta', { title: 'Road trip', currency: 'EUR', ...meta }), ...ents] });
  opened.push({ db, space });
  return space;
}

beforeEach(() => { document.body.replaceChildren(); });
afterEach(() => {
  for (const { db, space, cleanup } of opened.splice(0)) { cleanup?.(); space.close(); db.close(); }
  document.body.replaceChildren();
});

describe('day count of undated trips', () => {
  const sync = (space) => space.apply(dayCountPatch(space));

  it('follows days as they are set up, added, removed and undone', async () => {
    const space = await openTrip({ meta: { dayCount: 3 } });
    const actions = createActions(space, { label: (key) => key });
    await actions.setUpDays();
    expect(space.select.day.all()).toHaveLength(3);
    expect(dayCountPatch(space)).toEqual([]);
    await actions.addDay();
    await sync(space);
    expect(space.get('meta', 'meta').dayCount).toBe(4);
    await actions.removeDay(dayImpact(space, space.select.day.all()[0].id));
    await sync(space);
    expect(space.get('meta', 'meta').dayCount).toBe(3);
    await space.history.undo();
    await sync(space);
    expect(space.select.day.all()).toHaveLength(2);
    expect(space.get('meta', 'meta').dayCount).toBe(2);
    for (const day of space.select.day.all()) await space.apply([space.ops.remove('day', day.id)]);
    expect(dayCountPatch(space)).toEqual([]);
  });

  it('leaves dated trips and viewers alone', async () => {
    const dated = await openTrip({ meta: { start: '2027-05-01', end: '2027-05-02' }, ents: [server('day', 'd000000000000001', { order: 'a1', date: '2027-05-01' })] });
    expect(dayCountPatch(dated)).toEqual([]);
    const viewer = await openTrip({ role: 'viewer', meta: { dayCount: 5 }, ents: [server('day', 'd000000000000001', { order: 'a1', date: null })] });
    expect(dayCountPatch(viewer)).toEqual([]);
  });

  it('is kept in step while the plan is open', async () => {
    const space = await openTrip({ meta: { dayCount: 7 }, ents: [server('day', 'd000000000000001', { order: 'a1', date: null }), server('day', 'd000000000000002', { order: 'a2', date: null })] });
    const container = document.createElement('div');
    document.body.append(container);
    const cleanup = await mount(container, { space, app: { navigate: vi.fn(), commands: createCommandRegistry([]) }, route: { name: 'space', ref, tab: 'plan' }, ref });
    opened.at(-1).cleanup = cleanup;
    await settle();
    expect(space.get('meta', 'meta').dayCount).toBe(2);
  });
});

describe('scheduling in the plan view', () => {
  const LISBON = 'Europe/Lisbon';
  const ents = [
    server('day', 'd000000000000001', { order: 'a1', date: '2027-05-01' }),
    server('day', 'd000000000000002', { order: 'a2', date: '2027-05-02' }),
    server('place', 'p000000000000001', { name: 'Castle', cat: 'attraction', lat: 38.7139, lng: -9.1335, tz: LISBON }),
    server('place', 'p000000000000002', { name: 'Tasca', cat: 'restaurant', lat: 38.7108, lng: -9.1430, tz: LISBON }),
    server('visit', 'v000000000000001', { dayId: 'd000000000000001', placeId: 'p000000000000001', order: 'a1' }),
    server('visit', 'v000000000000002', { dayId: 'd000000000000001', placeId: 'p000000000000002', order: 'a2' }),
    server('visit', 'v000000000000003', { dayId: 'd000000000000002', placeId: null, title: 'Tram', order: 'a1', start: '10:00', end: '12:00' }),
    server('visit', 'v000000000000004', { dayId: 'd000000000000002', placeId: null, title: 'Lunch', order: 'a2', start: '11:30' }),
  ];
  async function mountPlan(role = 'owner') {
    const space = await openTrip({ role, meta: { start: '2027-05-01', end: '2027-05-02' }, ents });
    const container = document.createElement('div');
    document.body.append(container);
    const cleanup = await mount(container, { space, app: { navigate: vi.fn(), commands: createCommandRegistry([]) }, route: { name: 'space', ref, tab: 'plan' }, ref });
    opened.at(-1).cleanup = cleanup;
    await settle();
    return { space, container };
  }
  const row = (container, id) => container.querySelector(`.plan-row[data-kind="visit"][data-id="${id}"]`);
  const dayMenu = (container, dayId, label) => {
    container.querySelector(`.plan-day[data-day="${dayId}"] .plan-day-actions .icon-btn:last-child`).click();
    const item = [...document.querySelectorAll('.menu-item')].find((node) => node.textContent.includes(label));
    item?.click();
    return item;
  };

  it('shows estimated times, travel and warnings on the timeline', async () => {
    const { container } = await mountPlan();
    expect(row(container, 'v000000000000001').querySelector('.sched-detail').textContent).toMatch(/About (9:00\sAM|09:00)–(10:30\sAM|10:30) · 1 hr 30 min here/);
    expect(row(container, 'v000000000000001').querySelector('.sched-leg').textContent).toMatch(/^About \d+ min · /);
    expect(row(container, 'v000000000000004').querySelector('.sched-warn').textContent).toContain('Overlaps Tram.');
  });

  it('applies an auto schedule as one undoable change', async () => {
    const { space, container } = await mountPlan();
    expect(dayMenu(container, 'd000000000000001', 'Auto schedule')).toBeTruthy();
    await settle();
    const form = document.querySelector('.modal-panel form');
    expect(form.querySelectorAll('.sched-preview-item.is-changed')).toHaveLength(2);
    form.querySelector('input[type="time"]').value = '08:30';
    form.querySelector('input[type="time"]').dispatchEvent(new Event('input'));
    form.requestSubmit();
    await settle();
    expect(space.get('visit', 'v000000000000001')).toMatchObject({ start: '08:30', end: '10:00' });
    expect(space.get('visit', 'v000000000000002').start > '10:00').toBe(true);
    expect(localStorage.getItem('trips:schedule:0000000000000001')).toContain('08:30');
    await space.history.undo();
    expect(space.get('visit', 'v000000000000001').start).toBeUndefined();
    dayMenu(container, 'd000000000000002', 'Clear visit times');
    await settle();
    expect(space.get('visit', 'v000000000000003').start).toBeUndefined();
    localStorage.clear();
  });

  it('edits dwell and fixed time in the visit form', async () => {
    const { space, container } = await mountPlan();
    row(container, 'v000000000000001').querySelector('.plan-row-main').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const form = document.querySelector('.modal-panel form');
    const fields = form.querySelector('.sched-fields');
    expect(fields.textContent).toContain('Attraction default');
    fields.querySelector('input[type="number"]').value = '45';
    fields.querySelector('input[type="checkbox"]').checked = true;
    form.requestSubmit();
    await settle();
    expect(space.get('visit', 'v000000000000001')).toMatchObject({ dwell: 45, pinned: true });
  });

  it('offers no schedule actions to viewers', async () => {
    const { container } = await mountPlan('viewer');
    expect(dayMenu(container, 'd000000000000001', 'Auto schedule')).toBeUndefined();
    expect(row(container, 'v000000000000001').querySelector('.sched-detail')).not.toBeNull();
  });
});
