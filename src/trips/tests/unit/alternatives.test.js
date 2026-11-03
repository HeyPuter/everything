import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { ApiError } from '../../src/lib/api.js';
import { tripEvents } from '../../src/lib/ics/trip.js';
import { buildTimeline } from '../../src/lib/timeline/index.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createClock } from '../../src/shared/hlc.js';
import { validateOperation } from '../../src/shared/operations.js';
import { createCommandRegistry } from '../../src/views/registry/commands.js';
import { mount } from '../../src/views/trip/plan/index.js';
import { callHook, registerPlanHooks } from '../../src/views/trip/plan/hooks.js';
import {
  addStopWrite, alternatives, copyToMainWrite, createWrites, flagCounts, flagged, mainStops, moveStopWrite, onlyIn, planStats, promoteWrites, removeWrites,
} from '../../src/views/trip/plan/alternatives/model.js';

const uid = '00000000-0000-4000-8000-000000000001';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
let seq = 0;
const makeId = () => `7${String(++seq).padStart(15, '0')}`;
const clock = createClock({ node: '0000000000000009', now: () => 1_000_000 });
const server = (t, id, fields) => ({ t, id, ...fields, v: clock.tick(), rev: 1, upd: 1000, by: uid, cr: 1000 });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

const D1 = 'd000000000000001';
const D2 = 'd000000000000002';
const B = 'a000000000000001';
const WHOLE = 'a000000000000002';
const days = [server('day', D1, { order: 'a1', date: '2027-05-01' }), server('day', D2, { order: 'a2', date: '2027-05-02' })];
const places = [server('place', 'p000000000000001', { name: 'Castle', lat: 38.71, lng: -9.13 }), server('place', 'p000000000000002', { name: 'Beach', lat: 38.68, lng: -9.33 })];
const alts = [server('alt', B, { name: 'Rainy day', order: 'a', dayId: D1 }), server('alt', WHOLE, { name: 'Slow trip', order: 'b' })];
const visits = [
  server('visit', 'v000000000000001', { dayId: D1, placeId: 'p000000000000001', order: 'a1', start: '10:00', dwell: 90 }),
  server('visit', 'v000000000000002', { dayId: D1, placeId: null, title: 'Lunch', order: 'a2', start: '13:00', end: '14:00' }),
  server('visit', 'v000000000000003', { dayId: D1, placeId: null, title: 'Museum', order: 'a1', alt: B }),
  server('visit', 'v000000000000004', { dayId: D2, placeId: 'p000000000000002', order: 'a1' }),
  server('visit', 'v000000000000005', { dayId: D2, placeId: null, title: 'Nap', order: 'a1', alt: WHOLE }),
];
const valid = (write) => validateOperation({ opId: makeId(), ...write }, { kind: 'trip' });

describe('alternative plans model', () => {
  it('hides alternatives of removed days and flags days with alternatives', () => {
    const orphan = server('alt', 'a000000000000009', { name: 'Old', order: 'c', dayId: 'd000000000000099' });
    expect(alternatives([...alts, orphan], days).map((alt) => alt.id)).toEqual([B, WHOLE]);
    expect(flagged(alts, days, visits, D1).map((alt) => alt.id)).toEqual([B]);
    expect(flagged(alts, days, visits, D2).map((alt) => alt.id)).toEqual([WHOLE]);
    expect([...flagCounts(alts, days, visits)]).toEqual([[D1, 1], [D2, 1]]);
  });

  it('swaps a day alternative with the main plan, and swapping again restores it', () => {
    const writes = promoteWrites({ alt: alts[0], days, visits, previousName: 'Previous plan' });
    writes.forEach(valid);
    expect(writes).toEqual([
      { t: 'visit', id: 'v000000000000001', set: { alt: B } },
      { t: 'visit', id: 'v000000000000002', set: { alt: B } },
      { t: 'visit', id: 'v000000000000003', unset: ['alt'] },
      { t: 'alt', id: B, set: { name: 'Previous plan' } },
    ]);
    const after = visits.map((visit) => {
      const write = writes.find((item) => item.id === visit.id);
      if (!write) return visit;
      const next = { ...visit, ...(write.set ?? {}) };
      for (const path of write.unset ?? []) delete next[path];
      return next;
    });
    expect(mainStops(after, D1).map((visit) => visit.id)).toEqual(['v000000000000003']);
    const back = promoteWrites({ alt: { ...alts[0], name: 'Previous plan' }, days, visits: after, previousName: 'Previous plan' });
    expect(back.filter((write) => write.t === 'visit')).toEqual([
      { t: 'visit', id: 'v000000000000001', unset: ['alt'] },
      { t: 'visit', id: 'v000000000000002', unset: ['alt'] },
      { t: 'visit', id: 'v000000000000003', set: { alt: B } },
    ]);
  });

  it('swaps a whole-plan alternative on every day, leaving other alternatives alone', () => {
    const writes = promoteWrites({ alt: alts[1], days, visits });
    expect(writes.map((write) => [write.id, write.set?.alt ?? (write.unset ? 'main' : null)])).toEqual([
      ['v000000000000001', WHOLE], ['v000000000000002', WHOLE], ['v000000000000004', WHOLE], ['v000000000000005', 'main'],
    ]);
  });

  it('copies the main plan into a new alternative, and removes one with its stops', () => {
    const writes = createWrites({ alts, days, visits, dayId: D1, name: 'Plan C', copy: true, makeId });
    writes.forEach(valid);
    expect(writes[0]).toMatchObject({ t: 'alt', put: { name: 'Plan C', dayId: D1 } });
    expect(writes[0].put.order > 'b').toBe(true);
    expect(writes.slice(1).map((write) => [write.put.title ?? write.put.placeId, write.put.alt])).toEqual([['p000000000000001', writes[0].id], ['Lunch', writes[0].id]]);
    expect(writes[1].put).not.toHaveProperty('id');
    const whole = createWrites({ alts, days, visits, name: 'Plan D', copy: true, makeId });
    expect(whole[0].put).not.toHaveProperty('dayId');
    expect(whole).toHaveLength(4);
    expect(removeWrites({ alt: alts[0], visits })).toEqual([{ t: 'visit', id: 'v000000000000003', del: true }, { t: 'alt', id: B, del: true }]);
  });

  it('adds, moves and copies stops', () => {
    const stops = mainStops(visits, D1);
    const add = addStopWrite({ stops, dayId: D1, altId: B, title: '  Tea  ', makeId });
    valid(add);
    expect(add.put).toMatchObject({ dayId: D1, placeId: null, title: 'Tea', alt: B });
    expect(add.put.order > 'a2').toBe(true);
    const down = moveStopWrite(stops, 0, 1);
    expect(down.set.order > 'a2').toBe(true);
    expect(moveStopWrite(stops, 1, 1)).toBeNull();
    const copy = copyToMainWrite({ visit: visits[2], visits, makeId });
    valid(copy);
    expect(copy.put).not.toHaveProperty('alt');
    expect(copy.put.order > 'a2').toBe(true);
  });

  it('compares plans by stops, times, planned time and distance', () => {
    const main = mainStops(visits, D1);
    const placeOf = (id) => places.find((place) => place.id === id) ?? null;
    expect(planStats(main, placeOf)).toEqual({ stops: 2, first: 600, last: 840, planned: 150, meters: 0 });
    const both = [visits[0], visits[3]];
    expect(planStats(both, placeOf).meters).toBeGreaterThan(15_000);
    expect([...onlyIn(main, [visits[0]])]).toEqual(['v000000000000002']);
  });
});

describe('alternative visits outside the main plan', () => {
  it('leaves them out of day timelines and calendars', () => {
    const timeline = buildTimeline({ days, visits });
    expect(timeline.byDay.get(D1).rows.map((row) => row.id)).toEqual(['v000000000000001', 'v000000000000002']);
    expect(timeline.orphans.visits).toEqual([]);
    const events = tripEvents({ meta: { title: 'T', start: '2027-05-01', end: '2027-05-02' }, day: days, visit: visits, place: places }, { space: 's' });
    expect(events.some((event) => event.uid.includes('v000000000000003'))).toBe(false);
    expect(events.some((event) => event.uid.includes('v000000000000001'))).toBe(true);
  });
});

describe('plan hooks from several modules', () => {
  it('joins menu items and shows every node', () => {
    const offA = registerPlanHooks({ dayActions: () => [{ label: 'A' }], dayHeader: () => document.createElement('i') });
    const offB = registerPlanHooks({ dayActions: () => [{ label: 'B' }], dayHeader: () => document.createElement('b'), annotate: () => new Map([['k', 1]]) });
    expect(callHook('dayActions', {}).map((item) => item.label)).toEqual(['A', 'B']);
    const header = document.createElement('div');
    header.append(callHook('dayHeader', {}));
    expect([...header.children].map((node) => node.tagName)).toEqual(['I', 'B']);
    expect(callHook('annotate', {}).get('k')).toBe(1);
    offB();
    expect(callHook('dayActions', {}).map((item) => item.label)).toEqual(['A']);
    offA();
    expect(callHook('dayActions', {})).toBeNull();
  });
});

describe('Plan B in the plan view', () => {
  const opened = [];
  beforeEach(() => { document.body.replaceChildren(); });
  afterEach(() => {
    for (const { db, space, cleanup } of opened.splice(0)) { cleanup(); space.close(); db.close(); }
    document.body.replaceChildren();
  });

  async function setup({ role = 'owner' } = {}) {
    const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
    const puter = world.client(uid);
    const db = await openDatabase(uid, { indexedDB: new IDBFactory() });
    const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 0, changes: [] })), snapshot: vi.fn() };
    const space = await openSpace({ ref, db, api, puter, personal: createPersonalStore({ puter, db }), role, makeId, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false, autoStart: false });
    await space.store.replace({ rev: 1, ents: [server('meta', 'meta', { title: 'Lisbon', currency: 'EUR', start: '2027-05-01', end: '2027-05-02' }), ...days, ...places, ...alts, ...visits] });
    const container = document.createElement('div');
    document.body.append(container);
    const cleanup = await mount(container, { space, app: { navigate: vi.fn(), commands: createCommandRegistry([]) }, route: { name: 'space', ref, tab: 'plan' }, ref });
    opened.push({ db, space, cleanup });
    await settle();
    return { space, container };
  }

  it('shows only the main plan, flags the day, and switches plans from the dialog', async () => {
    const { space, container } = await setup();
    const titles = [...container.querySelectorAll(`.plan-day[data-day="${D1}"] .plan-row-title`)].map((node) => node.textContent);
    expect(titles).toEqual(['Castle', 'Lunch']);
    const chip = container.querySelector(`.plan-day[data-day="${D1}"] .alt-chip`);
    expect(chip.textContent).toContain('Plan B');
    chip.click();
    await settle();
    await vi.waitFor(() => expect(document.querySelector('.alt-dialog')).toBeTruthy());
    const dialog = document.querySelector('.alt-dialog');
    const tabs = [...dialog.querySelectorAll('[role="tab"]')].map((node) => node.textContent);
    expect(tabs).toEqual(['Main plan', 'Rainy day', 'Slow trip', 'Compare']);
    dialog.querySelectorAll('[role="tab"]')[1].click();
    [...dialog.querySelectorAll('button')].find((node) => node.textContent === 'Use this plan').click();
    await settle();
    [...document.querySelectorAll('.modal-actions button')].find((node) => node.textContent === 'Use this plan').click();
    await settle();
    expect(space.get('visit', 'v000000000000003')).not.toHaveProperty('alt');
    expect(space.get('visit', 'v000000000000001').alt).toBe(B);
    expect(space.get('alt', B).name).toBe('Previous plan');
    await settle();
    const after = [...container.querySelectorAll(`.plan-day[data-day="${D1}"] .plan-row-title`)].map((node) => node.textContent);
    expect(after).toEqual(['Museum']);
    await space.history.undo();
    await settle();
    expect(space.get('visit', 'v000000000000001')).not.toHaveProperty('alt');
  });

  it('lets viewers compare but not change plans', async () => {
    await setup({ role: 'viewer' });
    document.querySelector(`.plan-day[data-day="${D1}"] .alt-chip`).click();
    await settle();
    await vi.waitFor(() => expect(document.querySelector('.alt-dialog')).toBeTruthy());
    const dialog = document.querySelector('.alt-dialog');
    dialog.querySelectorAll('[role="tab"]')[1].click();
    expect([...dialog.querySelectorAll('button')].some((node) => node.textContent === 'Use this plan')).toBe(false);
    expect(dialog.textContent).toContain('changing them needs edit access');
    dialog.querySelectorAll('[role="tab"]')[3].click();
    expect(dialog.querySelectorAll('.alt-column')).toHaveLength(2);
    expect(dialog.querySelector('.alt-column [data-unique="true"]')).toBeTruthy();
  });
});
