// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createTripModel, createRoutePlanner, estimateStops, proposeOrder, optimizeOpenPath, orderPatches, pathLength, bookingOverlays, dayLinks, googleDirections, comapsRoute, appleDirections, transitLinks, GOOGLE_MAX_WAYPOINTS } from '../../src/lib/route-plan/index.js';
import { planDay } from '../../src/services/dayRoute.js';

const day = (id, order, extra = {}) => ({ id, order, date: null, ...extra });
const place = (id, lng, lat) => ({ id, name: id.toUpperCase(), lng, lat });
const visit = (id, dayId, placeId, order, extra = {}) => ({ id, dayId, placeId, order, ...extra });
// A rough grid around Paris: one unit is ~0.01°.
const p = (id, x, y) => place(id, 2.3 + x * 0.01, 48.85 + y * 0.01);

describe('trip model', () => {
  it('merges visits, placed and timed bookings, and derives arriving modes', () => {
    const model = createTripModel({
      days: [day('d1', 'a', { date: '2026-05-01', mode: 'drive' })],
      places: [p('a', 0, 0), p('b', 1, 0), p('c', 2, 0)],
      visits: [visit('v1', 'd1', 'a', 'a', { legMode: 'walk', start: '09:00' }), visit('v2', 'd1', 'b', 'c'), visit('v3', 'd1', 'c', 'e', { start: '15:00', inMode: 'bike' })],
      reservations: [
        { id: 'r1', type: 'restaurant', status: 'confirmed', title: 'Lunch', location: { lat: 48.86, lng: 2.31 }, dayPos: { d1: 'b' } },
        { id: 'r2', type: 'event', status: 'pending', title: 'Show', location: { lat: 48.87, lng: 2.32 }, start: { date: '2026-05-01', time: '13:00' } },
        { id: 'r3', type: 'tour', status: 'cancelled', title: 'Gone', location: { lat: 48.87, lng: 2.32 }, start: { date: '2026-05-01' } },
      ],
    });
    const stops = model.dayStops('d1');
    expect(stops.items.map((item) => item.id)).toEqual(['v1', 'r1', 'v2', 'r2', 'v3']);
    expect(stops.items.map((item) => item.mode)).toEqual(['drive', 'walk', 'walk', 'drive', 'bike']);
    expect(stops.input.stops.map((stop) => stop.id)).toEqual(['visit:v1', 'res:r1', 'visit:v2', 'res:r2', 'visit:v3']);
  });

  it('starts and ends days at the stays around them, including transfer days', () => {
    const model = createTripModel({
      days: [day('d1', 'a'), day('d2', 'b'), day('d3', 'c'), day('d4', 'd')],
      places: [p('h1', 0, 0), p('x', 1, 1)],
      visits: [visit('v1', 'd2', 'x', 'a'), visit('v2', 'd3', 'x', 'a')],
      reservations: [
        { id: 'hotel1', type: 'lodging', status: 'confirmed', title: 'One', placeId: 'h1', stay: { fromDayId: 'd1', toDayId: 'd3' } },
        { id: 'hotel2', type: 'lodging', status: 'confirmed', title: 'Two', location: { lat: 48.9, lng: 2.4 }, stay: { fromDayId: 'd3', toDayId: 'd4' } },
      ],
    });
    expect(model.dayStops('d1').start).toBeNull();
    expect(model.dayStops('d1').end.res.id).toBe('hotel1');
    const middle = model.dayStops('d2');
    expect([middle.start.res.id, middle.end.res.id]).toEqual(['hotel1', 'hotel1']);
    expect(middle.input.start.id).toBe('stay:hotel1');
    expect(middle.input.stops.at(-1).id).toBe('stay:hotel1');
    const transfer = model.dayStops('d3');
    expect([transfer.start.res.id, transfer.end.res.id]).toEqual(['hotel1', 'hotel2']);
    expect(model.dayStops('d4').end).toBeNull();
  });

  it('places stays by date when day ids are missing and clamps stays that begin before the trip', () => {
    const model = createTripModel({
      days: [day('d1', 'a', { date: '2026-05-01' }), day('d2', 'b', { date: '2026-05-02' })],
      reservations: [{ id: 'h', type: 'lodging', status: 'confirmed', title: 'H', location: { lat: 1, lng: 1 }, start: { date: '2026-04-29' }, end: { date: '2026-05-02' } }],
    });
    expect(model.dayStops('d1').start.res.id).toBe('h');
    expect(model.dayStops('d1').end.res.id).toBe('h');
    expect(model.dayStops('d2').end).toBeNull();
  });

  it('resets road legs at transport bookings and adds arrivals on later days', () => {
    const model = createTripModel({
      days: [day('d1', 'a', { date: '2026-05-01' }), day('d2', 'b', { date: '2026-05-02' })],
      places: [p('a', 0, 0), p('b', 1, 0), p('c', 50, 50)],
      visits: [visit('v1', 'd1', 'a', 'a'), visit('v2', 'd1', 'b', 'c'), visit('v3', 'd2', 'c', 'a')],
      reservations: [{
        id: 'f1', type: 'flight', status: 'confirmed', title: 'Night flight', dayPos: { d1: 'b' },
        legs: [{ from: { code: 'CDG', lat: 49, lng: 2.55 }, to: { code: 'NRT', lat: 35.77, lng: 140.39 }, dep: { date: '2026-05-01', time: '22:00' }, arr: { date: '2026-05-02', time: '17:00' } }],
      }],
    });
    const plan = planDay(model.dayStops('d1').input);
    expect(plan.segments.map((segment) => segment.kind)).toEqual(['road', 'transport', 'road']);
    expect(plan.segments[0].ids).toEqual(['visit:v1', 'res:f1']);
    expect(plan.segments[2].ids).toEqual(['res:f1', 'visit:v2']);
    const second = model.dayStops('d2');
    expect(second.items.map((item) => `${item.kind ?? item.t}:${item.id}`)).toEqual(['arrival:f1', 'visit:v3']);
  });

  it('turns estimates into legs keyed by entity', () => {
    const model = createTripModel({ days: [day('d1', 'a', { mode: 'walk' })], places: [p('a', 0, 0), p('b', 1, 0)], visits: [visit('v1', 'd1', 'a', 'a'), visit('v2', 'd1', 'b', 'b')] });
    const result = estimateStops(model.dayStops('d1'));
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]).toMatchObject({ from: { t: 'visit', id: 'v1' }, to: { t: 'visit', id: 'v2' }, mode: 'walk', estimated: true });
    const straight = pathLength([[2.3, 48.85], [2.31, 48.85]]);
    expect(result.distance).toBeCloseTo(straight * 1.25, 3);
    expect(result.duration).toBeCloseTo(result.distance / (4.5 / 3.6), 3);
  });
});

describe('optimize', () => {
  it('untangles a crossing path and keeps the identity when nothing is shorter', () => {
    const points = [[0, 0], [1, 1], [1, 0], [0, 1]].map(([x, y]) => [2.3 + x * 0.01, 48.85 + y * 0.01]);
    const order = optimizeOpenPath(points);
    expect(pathLength(order.map((i) => points[i]))).toBeLessThan(pathLength(points) - 1);
    const line = [0, 1, 2, 3].map((x) => [2.3 + x * 0.01, 48.85]);
    expect(optimizeOpenPath(line)).toEqual([0, 1, 2, 3]);
  });

  it('keeps pinned, timed and booking stops in place and reuses order keys', () => {
    const model = createTripModel({
      days: [day('d1', 'a')],
      places: [p('a', 0, 0), p('b', 3, 0), p('c', 1, 0), p('d', 2, 0), p('e', 9, 0), p('f', 4, 0), p('g', 6, 0), p('h', 5, 0)],
      visits: [
        visit('va', 'd1', 'a', 'a'), visit('vb', 'd1', 'b', 'b'), visit('vc', 'd1', 'c', 'c'), visit('vd', 'd1', 'd', 'd'),
        visit('ve', 'd1', 'e', 'e', { pinned: true }), visit('vf', 'd1', 'f', 'f'), visit('vg', 'd1', 'g', 'g', { start: '15:00' }), visit('vh', 'd1', 'h', 'h'),
      ],
    });
    const proposal = proposeOrder(model.dayStops('d1'));
    expect(proposal.changed).toBe(true);
    expect(proposal.order.indexOf('ve')).toBe(4);
    expect(proposal.order.indexOf('vg')).toBe(6);
    expect(proposal.order.slice(0, 4)).toEqual(['va', 'vc', 'vd', 'vb']);
    expect(proposal.after).toBeLessThan(proposal.before);
    expect(proposal.patches).toEqual([{ id: 'vc', order: 'b' }, { id: 'vd', order: 'c' }, { id: 'vb', order: 'd' }]);
  });

  it('anchors at the hotel for a loop when asked', () => {
    const model = createTripModel({
      days: [day('d0', 'a'), day('d1', 'b'), day('d2', 'c')],
      places: [p('hotel', 0, 0), p('far', 10, 0), p('near', 1, 0), p('mid', 5, 0)],
      visits: [visit('v1', 'd1', 'far', 'a'), visit('v2', 'd1', 'near', 'b'), visit('v3', 'd1', 'mid', 'c')],
      reservations: [{ id: 'h', type: 'lodging', status: 'confirmed', title: 'H', placeId: 'hotel', stay: { fromDayId: 'd0', toDayId: 'd2' } }],
    });
    const free = proposeOrder(model.dayStops('d1'));
    expect(free.order).toEqual(['v1', 'v3', 'v2']);
    const anchored = proposeOrder(model.dayStops('d1'), { anchorHotel: true });
    expect(anchored.order[0]).toBe('v2');
    expect(anchored.after).toBeLessThan(anchored.before);
  });

  it('gives duplicate keys fresh ones between the neighbours', () => {
    const items = ['x', 'y'].map((id) => ({ t: 'visit', id, entity: { order: 'm' } }));
    const patches = orderPatches(items, [items[1], items[0]], { left: 'a', right: 'z' });
    const keys = Object.fromEntries(items.map((item) => [item.id, item.entity.order]));
    for (const patch of patches) keys[patch.id] = patch.order;
    expect(keys.y < keys.x).toBe(true);
    expect(Object.values(keys).every((key) => key > 'a' && key < 'z')).toBe(true);
  });
});

describe('booking overlays', () => {
  it('draws arcs for flights, routable lines for cars and chained lines for trains', () => {
    const model = createTripModel({
      reservations: [
        { id: 'f', type: 'flight', status: 'pending', title: 'F', legs: [
          { from: { code: 'LHR', lat: 51.47, lng: -0.45 }, to: { code: 'FRA', lat: 50.03, lng: 8.56 }, dep: { date: '2026-05-01' }, arr: { date: '2026-05-01' } },
          { from: { code: 'FRA', lat: 50.03, lng: 8.56 }, to: { code: 'HND', lat: 35.55, lng: 139.78 }, dep: { date: '2026-05-01' }, arr: { date: '2026-05-02' } },
        ] },
        { id: 'c', type: 'car', status: 'confirmed', title: 'C', legs: [{ from: { lat: 1, lng: 1 }, to: { lat: 1.1, lng: 1.1 }, dep: { date: '2026-05-01' }, arr: { date: '2026-05-01' } }] },
        { id: 't', type: 'train', status: 'confirmed', title: 'T', legs: [
          { from: { name: 'A', lat: 2, lng: 2 }, to: { name: 'B', lat: 2.1, lng: 2.1 }, dep: { date: '2026-05-01' }, arr: { date: '2026-05-01' } },
          { from: { name: 'B', lat: 2.1, lng: 2.1 }, to: { name: 'C', lat: 2.2, lng: 2.3 }, dep: { date: '2026-05-01' }, arr: { date: '2026-05-01' } },
        ] },
        { id: 'x', type: 'flight', status: 'cancelled', title: 'X', legs: [{ from: { lat: 0, lng: 0 }, to: { lat: 1, lng: 1 }, dep: { date: '2026-05-01' }, arr: { date: '2026-05-01' } }] },
        { id: 'l', type: 'lodging', status: 'confirmed', title: 'L', location: { lat: 3, lng: 3 } },
      ],
    });
    const overlays = bookingOverlays(model);
    expect(overlays.arcs).toHaveLength(2);
    expect(overlays.arcs[0].properties).toMatchObject({ id: 'f', status: 'pending' });
    expect(overlays.lines.map((line) => [line.id, line.mode ?? null, line.points.length])).toEqual([['c', 'drive', 2], ['t', null, 3]]);
    expect(overlays.endpoints.map((feature) => feature.properties.label)).toEqual(['LHR', 'FRA', 'HND', 'A', 'B', 'C']);
    expect(overlays.stays.map((stay) => stay.res.id)).toEqual(['l']);
  });
});

describe('deep links', () => {
  const points = Array.from({ length: 13 }, (_, i) => [2 + i / 100, 48]);
  it('builds Google directions with at most nine waypoints', () => {
    const { url, truncated } = googleDirections(points, 'drive');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://www.google.com/maps/dir/');
    expect(parsed.searchParams.get('api')).toBe('1');
    expect(parsed.searchParams.get('origin')).toBe('48,2');
    expect(parsed.searchParams.get('destination')).toBe('48,2.12');
    expect(parsed.searchParams.get('waypoints').split('|')).toHaveLength(GOOGLE_MAX_WAYPOINTS);
    expect(parsed.searchParams.get('travelmode')).toBe('driving');
    expect(truncated).toBe(true);
    expect(googleDirections([points[0]])).toBeNull();
  });
  it('builds Apple, CoMaps and transit links', () => {
    expect(appleDirections([2, 48], [2.1, 48.1], 'transit')).toBe('https://maps.apple.com/?saddr=48%2C2&daddr=48.1%2C2.1&dirflg=r');
    const comaps = new URL(comapsRoute([2, 48], [2.1, 48.1], 'bike', { fromName: 'Hotel', toName: 'Museum' }));
    expect(comaps.protocol).toBe('cm:');
    expect(Object.fromEntries(comaps.searchParams)).toEqual({ sll: '48,2', saddr: 'Hotel', dll: '48.1,2.1', daddr: 'Museum', type: 'bicycle' });
    const transit = new URL(transitLinks([2, 48], [2.1, 48.1]).google);
    expect(transit.searchParams.get('travelmode')).toBe('transit');
    expect(transit.searchParams.has('waypoints')).toBe(false);
    const links = dayLinks([{ point: [2, 48], name: 'A' }, { point: null }, { point: [2.1, 48.1], name: 'B' }], 'walk');
    expect(links.google.url).toContain('travelmode=walking');
    expect(dayLinks([{ point: [2, 48] }])).toBeNull();
  });
});

describe('route planner', () => {
  const space = (entities) => ({ select: Object.fromEntries(['day', 'visit', 'place', 'res'].map((type) => [type, { all: () => entities[type] ?? [] }])) });
  const entities = {
    day: [day('d1', 'a', { mode: 'drive' })],
    place: [p('a', 0, 0), p('b', 1, 0)],
    visit: [visit('v1', 'd1', 'a', 'a'), visit('v2', 'd1', 'b', 'b')],
  };

  it('shares one routing job per input, notifies subscribers and serves the result as latest', async () => {
    let release;
    const route = { route: vi.fn(() => new Promise((resolve) => { release = resolve; })) };
    const planner = createRoutePlanner({ space: space(entities), route });
    const heard = vi.fn(); planner.subscribe(heard);
    expect(planner.latest('d1').routed).toBe(false);
    const first = planner.day('d1'); const second = planner.day('d1');
    await Promise.resolve(); await Promise.resolve();
    expect(route.route).toHaveBeenCalledTimes(1);
    release({ data: { distance: 1234, duration: 99, geometry: { type: 'LineString', coordinates: [[2.3, 48.85], [2.31, 48.85]] }, legs: [{ distance: 1234, duration: 99 }], estimated: false }, attribution: [] });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.legs[0]).toMatchObject({ from: { t: 'visit', id: 'v1' }, to: { t: 'visit', id: 'v2' }, distance: 1234, duration: 99, estimated: false });
    expect(heard).toHaveBeenCalledWith('d1', a);
    expect(planner.latest('d1')).toBe(a);
    await planner.day('d1');
    expect(route.route).toHaveBeenCalledTimes(1);
  });

  it('aborts the shared job only when every caller aborted', async () => {
    const signals = [];
    const route = { route: vi.fn((_points, _mode, { signal }) => { signals.push(signal); return new Promise(() => {}); }) };
    const planner = createRoutePlanner({ space: space(entities), route });
    const one = new AbortController(); const two = new AbortController();
    const a = planner.day('d1', { signal: one.signal }); const b = planner.day('d1', { signal: two.signal });
    await Promise.resolve(); await Promise.resolve();
    one.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals[0].aborted).toBe(false);
    two.abort();
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals[0].aborted).toBe(true);
  });

  it('estimates without a route adapter', async () => {
    const planner = createRoutePlanner({ space: space(entities) });
    const result = await planner.day('d1');
    expect(result.estimated).toBe(true);
    expect(planner.stops('missing')).toBeNull();
    expect((await planner.trip()).days).toHaveLength(1);
  });
});
