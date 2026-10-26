import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlanState } from '../../src/views/trip/plan/state.js';

// The map wrapper needs WebGL; this double records layer calls and exposes the handlers the view registers.
const maps = [];
vi.mock('../../src/map/index.js', async (load) => {
  const actual = await load();
  return {
    ...actual,
    createTripMap: vi.fn(async () => {
      const handlers = { click: new Map(), hover: new Map() };
      const events = new Map();
      const layers = {};
      const native = {
        on: (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
        off: (name, fn) => events.get(name)?.delete(fn),
        fire: (name, event) => { for (const fn of events.get(name) ?? []) fn(event); },
        getBounds: () => ({ getWest: () => 2.2, getSouth: () => 48.8, getEast: () => 2.4, getNorth: () => 48.9 }),
        getCenter: () => ({ lat: 48.85, lng: 2.3 }), getZoom: () => 12, easeTo: vi.fn(), project: () => ({ x: 10, y: 10 }),
        queryRenderedFeatures: () => [], getSource: () => null, getLayer: () => null, addLayer: vi.fn(), moveLayer: vi.fn(), setLayoutProperty: vi.fn(),
        hasImage: () => false, addImage: vi.fn(), removeImage: vi.fn(),
      };
      const record = (name) => vi.fn((key, data, options) => { layers[key] = { name, data, options }; });
      const api = {
        map: native, layers, handlers,
        setMarkers: record('markers'), setLabels: record('labels'), setArcs: record('arcs'), setRoutes: record('routes'), setPois: record('pois'),
        setSelected: vi.fn(), setBasemap: vi.fn(), setTheme: vi.fn(async () => false), refresh: vi.fn(), setAttribution: vi.fn(), fit: vi.fn(), resize: vi.fn(), destroy: vi.fn(),
        onClick: (key, fn) => { handlers.click.set(key, fn); return () => handlers.click.delete(key); },
        onHover: (key, fn) => { handlers.hover.set(key, fn); return () => handlers.hover.delete(key); },
      };
      maps.push(api);
      return api;
    }),
  };
});
const { mountMap } = await import('../../src/views/trip/map/index.js');

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 20)); };
const place = (id, x, y, extra = {}) => ({ id, name: `Place ${id}`, lat: 48.85 + y * 0.01, lng: 2.3 + x * 0.01, cat: 'restaurant', ...extra });
function stubSpace() {
  const entities = {
    day: [{ id: 'd1', order: 'a', date: '2026-05-01', mode: 'walk' }],
    place: [place('a', 0, 0), place('b', 3, 0), place('c', 1, 0), place('d', 2, 0), place('z', 9, 9, { rating: { u1: 4, u2: 5 } })],
    visit: [{ id: 'v1', dayId: 'd1', placeId: 'a', order: 'a' }, { id: 'v2', dayId: 'd1', placeId: 'b', order: 'b' }, { id: 'v3', dayId: 'd1', placeId: 'c', order: 'c' }, { id: 'v4', dayId: 'd1', placeId: 'd', order: 'd' }],
    res: [{ id: 'f1', type: 'flight', status: 'confirmed', title: 'Out', legs: [{ from: { code: 'CDG', lat: 49, lng: 2.55 }, to: { code: 'NRT', lat: 35.7, lng: 140.3 }, dep: { date: '2026-05-01' }, arr: { date: '2026-05-02' } }] }],
    cat: [],
  };
  const listeners = new Set();
  return {
    ref: { w: 'trips-0123456789', s: '0000000000000001', k: 'trip' },
    select: Object.fromEntries(Object.keys(entities).map((type) => [type, { all: () => entities[type] }])),
    get: (type, id) => entities[type]?.find((entity) => entity.id === id) ?? null,
    can: () => true,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    ops: { patch: (t, id, change) => ({ t, id, ...change }) },
    apply: vi.fn(async () => {}),
    history: { undo: vi.fn(async () => {}) },
  };
}
function stubServices() {
  return {
    context: { loadConfig: async () => ({ providers: { tiles: ['openfreemap'] }, disabled: [] }) },
    route: { route: vi.fn(async () => null) },
    geocode: {
      autocomplete: vi.fn(async () => ({ data: [{ id: 'N:1', source: 'photon', name: 'Louvre', lat: 48.86, lng: 2.33, address: 'Paris', osm: { type: 'node', id: '1' } }], attribution: [{ text: 'Photon' }] })),
      search: vi.fn(async () => ({ data: [], attribution: [] })),
      reverse: vi.fn(async () => ({ data: [{ id: 'N:2', source: 'photon', name: 'Corner', lat: 48.85, lng: 2.3, address: 'Rue X', osm: { type: 'way', id: '2' } }], attribution: [{ text: 'Photon' }] })),
      pois: vi.fn(async () => ({ data: [{ id: 'N:3', source: 'photon', name: 'Bistro', lat: 48.85, lng: 2.31, address: '' }], attribution: [] })),
    },
  };
}
async function mounted() {
  const container = document.createElement('div'); document.body.append(container);
  const plan = createPlanState();
  const space = stubSpace(); const services = stubServices();
  const cleanup = mountMap(container, { space, plan, session: { services }, ref: space.ref });
  await settle();
  return { container, plan, space, services, cleanup, map: maps.at(-1) };
}
afterEach(() => { maps.length = 0; document.body.replaceChildren(); localStorage.clear(); });

describe('planner map pane', () => {
  it('draws category markers, booking arcs and day stops, and follows the selected day', async () => {
    const { plan, map, cleanup } = await mounted();
    expect(map.layers.places.data.features).toHaveLength(5);
    expect(map.layers.places.data.features[0].properties).toMatchObject({ id: 'a', tone: 3, icon: 'planmap-utensils' });
    expect(map.layers['booking-arcs'].data.features).toHaveLength(1);
    plan.set({ day: 'd1' });
    await settle();
    expect(map.layers.stops.data.features.map((feature) => [feature.properties.id, feature.properties.order])).toEqual([['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
    expect(map.layers.places.data.features.map((feature) => feature.properties.id)).toEqual(['z']);
    expect(map.layers['day-routes'].data.features.length).toBeGreaterThan(0);
    cleanup();
    expect(map.destroy).toHaveBeenCalled();
  });

  it('selects on marker click, pans on locate and emits pickLocation for a dropped pin', async () => {
    const { plan, map, container } = await mounted();
    map.handlers.click.get('places')({ id: 'z', properties: {} });
    expect(plan.get().place).toBe('z');
    await settle();
    expect(container.querySelector('.planmap-card h2').textContent).toBe('Place z');
    plan.emit('locate', { t: 'place', id: 'b' });
    expect(map.map.easeTo).toHaveBeenCalled();
    map.map.fire('click', { point: { x: 1, y: 1 }, lngLat: { lat: 48.85, lng: 2.3 } });
    expect(plan.get().place).toBeNull();
    const picked = vi.fn(); plan.on('pickLocation', picked);
    map.map.fire('click', { point: { x: 1, y: 1 }, lngLat: { lat: 48.85, lng: 2.3 } });
    await settle();
    expect(container.querySelector('.planmap-card h2').textContent).toBe('Corner');
    [...container.querySelectorAll('.planmap-card button')].find((node) => node.textContent.includes('Add place')).click();
    expect(picked).toHaveBeenCalledWith(expect.objectContaining({ lat: 48.85, lng: 2.3, name: 'Corner', address: 'Rue X', osm: 'way/2' }));
  });

  it('proposes a shorter order and applies it as undoable visit patches', async () => {
    const { plan, space, container } = await mounted();
    plan.set({ day: 'd1' });
    await settle();
    [...container.querySelectorAll('.planmap-summary button')].find((node) => node.textContent.includes('Optimize order')).click();
    const apply = [...container.querySelectorAll('.planmap-proposal button')].find((node) => node.textContent.includes('Apply order'));
    expect(apply).toBeTruthy();
    apply.click();
    await settle();
    expect(space.apply).toHaveBeenCalledWith([
      { t: 'visit', id: 'v3', set: { order: 'b' } }, { t: 'visit', id: 'v4', set: { order: 'c' } }, { t: 'visit', id: 'v2', set: { order: 'd' } },
    ], { history: 'Optimize route' });
  });

  it('searches trip places and providers and explores a category', async () => {
    const { container, services, map } = await mounted();
    const input = container.querySelector('input[role=combobox]');
    input.value = 'lou'; input.dispatchEvent(new Event('input'));
    await settle();
    expect(services.geocode.autocomplete).toHaveBeenCalledWith('lou', expect.objectContaining({ lang: expect.any(String) }));
    expect([...container.querySelectorAll('[role=option]')].map((node) => node.textContent)).toEqual([expect.stringContaining('Louvre')]);
    [...container.querySelectorAll('.planmap-pill')][0].click();
    await settle();
    expect(services.geocode.pois).toHaveBeenCalledWith([2.2, 48.8, 2.4, 48.9], 'food', expect.any(Object));
    expect(map.layers.explore.data.features).toHaveLength(1);
  });
});
