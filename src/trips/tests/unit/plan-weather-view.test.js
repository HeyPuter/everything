import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { ApiError } from '../../src/lib/api.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createClock } from '../../src/shared/hlc.js';
import { createCommandRegistry } from '../../src/views/registry/commands.js';
import { mount } from '../../src/views/trip/plan/index.js';

const uid = '00000000-0000-4000-8000-000000000001';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
const clock = createClock({ node: '0000000000000009', now: () => 1_000_000 });
const server = (t, id, fields) => ({ t, id, ...fields, v: clock.tick(), rev: 1, upd: 1000, by: uid, cr: 1000 });
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 20)); };
const opened = [];

// Far-future dates: no forecast, so every day shows typical weather.
const ents = [
  server('meta', 'meta', { title: 'Berlin', currency: 'EUR', start: '2030-10-03', end: '2030-10-04' }),
  server('day', 'd000000000000001', { order: 'a1', date: '2030-10-03' }),
  server('day', 'd000000000000002', { order: 'a2', date: '2030-10-04' }),
  server('place', 'p000000000000001', { name: 'Museum Island', lat: 52.52, lng: 13.4, cc: 'DE', tz: 'Europe/Berlin' }),
  server('visit', 'v000000000000001', { dayId: 'd000000000000001', placeId: 'p000000000000001', order: 'a1' }),
];
const services = () => ({
  weather: {
    forecast: vi.fn(async () => null),
    normals: vi.fn(async (_lat, _lng, month) => ({ data: { month, temperatureC: 10, highC: 14, lowC: 6, precipitationMmDay: 1.6 }, attribution: [{ text: 'NASA POWER', url: 'https://power.larc.nasa.gov/' }] })),
  },
  holidays: {
    public: vi.fn(async () => ({ data: [{ date: '2030-10-03', name: 'German Unity Day', localName: 'Tag der Deutschen Einheit', global: true, regions: [] }], attribution: [{ text: 'Nager.Date' }] })),
    school: vi.fn(async () => ({ data: [{ start: '2030-10-01', end: '2030-10-10', name: 'Autumn', regions: ['DE-BY'] }], attribution: [] })),
    subdivisions: vi.fn(async () => ({ data: [{ code: 'DE-BY', name: 'Bavaria' }] })),
  },
});

async function setup() {
  const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
  const puter = world.client(uid);
  const db = await openDatabase(uid, { indexedDB: new IDBFactory() });
  const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 0, changes: [] })), snapshot: vi.fn() };
  const personal = createPersonalStore({ puter, db });
  const space = await openSpace({ ref, db, api, puter, personal, role: 'owner', setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false, autoStart: false });
  await space.store.replace({ rev: 1, ents });
  const container = document.createElement('div');
  document.body.append(container);
  const stub = services();
  const cleanup = await mount(container, { space, app: { navigate: vi.fn(), commands: createCommandRegistry([]) }, route: { name: 'space', ref, tab: 'plan' }, ref, session: { services: stub } });
  opened.push({ db, space, cleanup });
  await settle();
  return { container, stub };
}

afterEach(() => {
  for (const { db, space, cleanup } of opened.splice(0)) { cleanup(); space.close(); db.close(); }
  document.body.replaceChildren();
  localStorage.clear();
});

describe('plan weather view', () => {
  it('shows typical weather and holidays in day headers, chips and the panel', async () => {
    const { container, stub } = await setup();
    const head = container.querySelector('.plan-day[data-day="d000000000000001"] .wx-head');
    expect(head.textContent).toContain('typical');
    expect(head.querySelector('.sr-only').textContent).toMatch(/^Typical: high (14°C|57°F), low (6°C|43°F)$/);
    expect(container.querySelector('.plan-day[data-day="d000000000000002"] .wx-head').textContent).toMatch(/14°|57°/);
    expect(container.querySelector('.plan-day[data-day="d000000000000001"] .wx-info').textContent).toContain('German Unity Day');
    expect(container.querySelector('.plan-rail-chip[data-day="d000000000000001"] .wx-chip')).not.toBeNull();
    expect(stub.weather.forecast).not.toHaveBeenCalled();

    container.querySelector('[data-focus="day:d000000000000001"]').click();
    await settle();
    const panel = container.querySelector('.plan-panel .wx-panel');
    expect(panel.textContent).toContain('Typical for October in Museum Island');
    expect(panel.textContent).toContain('NASA POWER');
    expect(panel.textContent).toContain('Public holiday in Germany');
    expect(panel.textContent).toContain('Check opening hours for the stops planned this day (1).');
    expect(panel.textContent).toContain('Holidays in Germany depend on the region.');
    expect(panel.textContent).toContain('School holidays in some regions of Germany');
    expect(container.textContent).not.toMatch(/undefined|null/);

    panel.querySelector('[data-focus="wx-region:DE"]').click();
    await settle();
    const select = document.querySelector('.modal-panel select');
    expect([...select.options].map((option) => option.textContent)).toEqual(['Not chosen', 'Bavaria']);
    select.value = 'DE-BY';
    [...document.querySelectorAll('.modal-panel .btn')].find((node) => node.textContent === 'Save').click();
    await settle();
    const updated = container.querySelector('.plan-panel .wx-panel');
    expect(updated.textContent).toContain('Region: Bavaria');
    expect(updated.textContent).toContain('School holidays in Bavaria');
    expect(JSON.parse(localStorage.getItem(`trips:holidays:${ref.s}`))).toEqual({ regions: { DE: 'DE-BY' } });
  });
});
