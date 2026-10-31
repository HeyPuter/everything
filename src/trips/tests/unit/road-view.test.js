import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { ApiError } from '../../src/lib/api.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createClock } from '../../src/shared/hlc.js';
import { ROAD_PREFS_ID } from '../../src/shared/schema/trip.js';
import { createCommandRegistry } from '../../src/views/registry/commands.js';
import { mount } from '../../src/views/trip/plan/index.js';
import { roadState } from '../../src/views/trip/road/state.js';
import { createServices } from '../../src/services/index.js';
import { createMemoryCache } from '../../src/services/core.js';
import { createRoadOps } from '../../src/views/trip/road/ops.js';

const uid = '00000000-0000-4000-8000-000000000001';
const ref = { w: 'trips-012345abcd', s: '0000000000000002', k: 'trip' };
let seq = 0;
const makeId = () => `6${String(++seq).padStart(15, '0')}`;
const clock = createClock({ node: '0000000000000009', now: () => 1_000_000 });
const server = (t, id, fields) => ({ t, id, ...fields, v: clock.tick(), rev: 1, upd: 1000, by: uid, cr: 1000 });
const opened = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
// Lazy modules load in real time, which a loaded machine stretches.
const WAIT = { timeout: 10_000 };

const days = [server('day', 'd000000000000001', { order: 'a1', date: null, mode: 'drive' }), server('day', 'd000000000000002', { order: 'a2', date: null, mode: 'drive' })];
const places = [
  server('place', 'p000000000000001', { name: 'Lyon', lat: 45.76, lng: 4.84 }),
  server('place', 'p000000000000002', { name: 'Avignon', lat: 43.95, lng: 4.81 }),
  server('place', 'p000000000000003', { name: 'Arles', lat: 43.68, lng: 4.63 }),
  server('place', 'p000000000000004', { name: 'Nice', lat: 43.70, lng: 7.27 }),
];
const visits = [
  server('visit', 'v000000000000001', { dayId: 'd000000000000001', placeId: 'p000000000000001', order: 'a1' }),
  server('visit', 'v000000000000002', { dayId: 'd000000000000001', placeId: 'p000000000000002', order: 'a2' }),
  server('visit', 'v000000000000003', { dayId: 'd000000000000001', placeId: 'p000000000000003', order: 'a3' }),
  server('visit', 'v000000000000004', { dayId: 'd000000000000002', placeId: 'p000000000000004', order: 'a1' }),
];

async function openTrip({ role = 'owner', roadtrip = true, ents = [] } = {}) {
  const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
  const puter = world.client(uid);
  const db = await openDatabase(uid, { indexedDB: new IDBFactory() });
  const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 0, changes: [] })), snapshot: vi.fn() };
  const personal = createPersonalStore({ puter, db });
  const space = await openSpace({ ref, db, api, puter, personal, role, makeId, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false, autoStart: false });
  await space.store.replace({ rev: 1, ents: [server('meta', 'meta', { title: 'Coast', currency: 'EUR', settings: { addons: { roadtrip } } }), ...days, ...places, ...visits, ...ents] });
  opened.push({ db, space });
  return space;
}
async function mountPlan(space) {
  const container = document.createElement('div');
  document.body.append(container);
  const cleanup = await mount(container, { space, app: { navigate: vi.fn(), commands: createCommandRegistry([]) }, route: { name: 'space', ref, tab: 'plan' }, ref, account: { uuid: uid } });
  opened.at(-1).cleanup = cleanup;
  await settle();
  return container;
}
const roadButton = (container) => [...container.querySelectorAll('.road-switch button')].find((node) => node.textContent.includes('Road trip'));

beforeEach(() => { document.body.replaceChildren(); localStorage.clear(); });
afterEach(() => {
  for (const { db, space, cleanup } of opened.splice(0)) { cleanup?.(); space.close(); db.close(); }
  document.body.replaceChildren();
});

describe('road trip view', () => {
  it('shows the chain by day with drives, a planned night and the driving line in the days view', async () => {
    const space = await openTrip();
    const container = await mountPlan(space);
    await vi.waitFor(() => expect(container.querySelectorAll('.road-dayinfo').length).toBeGreaterThan(0), WAIT);
    roadButton(container).click();
    await vi.waitFor(() => expect(container.querySelectorAll('.road-day')).toHaveLength(2), WAIT);
    const sections = container.querySelectorAll('.road-day');
    expect([...sections[0].querySelectorAll('.road-node-title')].map((node) => node.textContent)).toEqual(['Lyon', 'Avignon', 'Arles']);
    expect(sections[0].querySelectorAll('.road-leg')).toHaveLength(2);
    // The drive to Nice is on day 2, after the night at Arles.
    expect(sections[1].querySelector('.road-node-start .road-node-title').textContent).toBe('Arles');
    expect(sections[1].querySelector('.road-night')?.textContent).toContain('Night: at Arles');
    expect(container.querySelector('.road-totals').textContent).toMatch(/(km|mi) · .* driving · 4 stops · 2 days/);
    expect(container.querySelector('.plan-days-pane').dataset.roadView).toBe('road');
  }, 30_000);

  it('offers to turn road trip mode on and makes walking days driving days', async () => {
    const space = await openTrip({ roadtrip: false, ents: [server('day', 'd000000000000003', { order: 'a3', date: null })] });
    const container = await mountPlan(space);
    roadButton(container).click();
    const findTurnOn = () => [...container.querySelectorAll('.road-host button')].find((node) => node.textContent.includes('Turn on'));
    await vi.waitFor(() => expect(findTurnOn()).toBeTruthy(), WAIT);
    const turnOn = findTurnOn();
    turnOn.click();
    await settle();
    expect(space.get('meta', 'meta').settings.addons.roadtrip).toBe(true);
    expect(space.get('day', 'd000000000000003').mode).toBe('drive');
    await vi.waitFor(() => expect(container.querySelectorAll('.road-day').length).toBe(3), WAIT);
  }, 30_000);

  it('hides the switch from viewers when the mode is off', async () => {
    const space = await openTrip({ role: 'viewer', roadtrip: false });
    const container = await mountPlan(space);
    expect(container.querySelector('.road-switch').hidden).toBe(true);
  });
});

// Encodes [lng, lat] pairs as a precision-6 polyline.
function encode(points) {
  let out = ''; let lat = 0; let lng = 0;
  const put = (value) => { let v = value < 0 ? ~(value << 1) : value << 1; while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } out += String.fromCharCode(v + 63); };
  for (const [x, y] of points) { const a = Math.round(y * 1e6); const b = Math.round(x * 1e6); put(a - lat); put(b - lng); lat = a; lng = b; }
  return out;
}

describe('road trip routing', () => {
  it('routes each day through Valhalla with its avoid options and keeps the toll flags per leg', async () => {
    const bodies = [];
    const fetcher = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const legs = body.points.slice(1).map((point, index) => ({ shape: encode([body.points[index], point]), summary: { length: 100, time: 3600, has_toll: index === 0 } }));
      return Response.json({ trip: { status: 0, summary: { length: 100 * legs.length, time: 3600 * legs.length }, legs } });
    });
    const services = createServices({ userId: uid, fetch: fetcher, cache: createMemoryCache(), keys: async () => null, config: { providers: { route: ['geo-valhalla', 'straight'] }, disabled: [], geoWorker: 'https://trips-geo.puter.work' }, sleep: async () => {}, retries: 0, online: () => true });
    const space = await openTrip({ ents: [server('rtPrefs', ROAD_PREFS_ID, { avoid: ['ferry'], dayAvoid: { d000000000000002: ['toll'] } })] });
    const state = roadState(space, { services });
    const release = state.retain();
    state.view();
    await vi.waitFor(() => expect(state.view().info.get('visit:v000000000000001>visit:v000000000000002').routed).toBe(true));
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    const view = state.view();
    expect(view.info.get('visit:v000000000000001>visit:v000000000000002')).toMatchObject({ meters: 100_000, minutes: 60, flags: { toll: true } });
    expect(view.info.get('visit:v000000000000002>visit:v000000000000003').flags.toll).toBe(false);
    expect(bodies.map((body) => body.avoid)).toEqual([['ferry'], ['toll']]);
    expect(view.flags.toll).toEqual(['visit:v000000000000001>visit:v000000000000002', 'visit:v000000000000003>visit:v000000000000004']);
    release();
  });
});

describe('road trip writes', () => {
  it('saves settings under the fixed id, then patches them', async () => {
    const space = await openTrip();
    const ops = createRoadOps(space);
    await ops.setPrefs({ stint: 90, fuel: 'electric' });
    expect(space.get('rtPrefs', ROAD_PREFS_ID)).toMatchObject({ stint: 90, fuel: 'electric' });
    await ops.setPrefs({ stint: 100, fuel: null });
    expect(space.get('rtPrefs', ROAD_PREFS_ID)).toMatchObject({ stint: 100 });
    expect(space.get('rtPrefs', ROAD_PREFS_ID).fuel).toBeUndefined();
    await ops.setDayRoute('d000000000000001', ['toll']);
    expect(roadState(space, null).prefs().dayAvoid).toEqual({ d000000000000001: ['toll'] });
  });

  it('ends the day at a stop by moving the later visits to the next day, undoably', async () => {
    const space = await openTrip();
    const state = roadState(space, null);
    const ops = createRoadOps(space);
    const view = state.view();
    const avignon = view.chain.nodes.find((node) => node.id === 'v000000000000002');
    expect(await ops.endDayHere(view, avignon)).toBe(1);
    expect(space.get('visit', 'v000000000000003').dayId).toBe('d000000000000002');
    expect(state.view().chain.nodes.map((node) => node.name)).toEqual(['Lyon', 'Avignon', 'Arles', 'Nice']);
    await space.history.undo();
    expect(space.get('visit', 'v000000000000003').dayId).toBe('d000000000000001');
  });

  it('places a night along a leg and adds a found place as a stop on its leg', async () => {
    const space = await openTrip();
    const state = roadState(space, null);
    const ops = createRoadOps(space);
    let view = state.view();
    const crossing = view.chain.legs.find((leg) => leg.key === 'visit:v000000000000003>visit:v000000000000004');
    await ops.placeNight(view.chain, crossing, 0.4);
    view = state.view();
    expect(view.schedule.drives.get(crossing.key).nights[0]).toMatchObject({ at: 0.4, source: 'manual' });
    const id = view.dayEnds.get(crossing.key)[0].id;
    await ops.placeNight(view.chain, crossing, 0.6, id);
    expect(space.get('dayEnd', id).fraction).toBe(0.6);
    const leg = view.chain.legs.find((item) => item.key === 'visit:v000000000000001>visit:v000000000000002');
    await ops.insertStop(view.chain, leg, { result: { id: 'node:1', name: 'Station', lat: 44.9, lng: 4.85, category: 'fuel', osm: { type: 'node', id: '1' }, country: 'FR' }, prefs: view.prefs });
    view = state.view();
    expect(view.chain.nodes.map((node) => node.name)).toEqual(['Lyon', 'Station', 'Avignon', 'Arles', 'Nice']);
    const station = view.chain.nodes[1];
    expect(station).toMatchObject({ service: 'fuel', dwell: 15 });
    expect(station.place).toMatchObject({ cat: 'transport', stop: { type: 'fuel' }, ids: { osm: 'node/1' }, cc: 'FR' });
    // On the drive across the night, a stop before the night ends day 1 and one after it opens day 2.
    const across = view.chain.legs.find((item) => item.key === crossing.key);
    await ops.insertStop(view.chain, across, { result: { id: 'a', name: 'Before', lat: 43.6, lng: 5.5, category: 'rest' }, prefs: view.prefs, fraction: 0.3, night: 0.6 });
    await ops.insertStop(view.chain, across, { result: { id: 'b', name: 'After', lat: 43.6, lng: 6.5, category: 'food' }, prefs: view.prefs, fraction: 0.8, night: 0.6 });
    view = state.view();
    expect(view.chain.nodes.map((node) => `${node.name}@${node.day}`)).toEqual(['Lyon@0', 'Station@0', 'Avignon@0', 'Arles@0', 'Before@0', 'After@1', 'Nice@1']);
    expect(view.chain.nodes.find((node) => node.name === 'Before').dwell).toBe(20);
  });
});
