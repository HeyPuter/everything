// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createTripModel } from '../../src/lib/route-plan/index.js';
import {
  buildChain, scheduleRoad, planFuel, readPrefs, rangeKm, prefsChange, fuelEstimate, expenseDraft, routeFlags, driveRuns,
  legForDayEnd, detectLeg, pointAt, project, slice, splitAtWaypoints, corridorBoxes, withinCorridor, lineLength, densify,
  hazardsNearRoute, DAY, ROAD_PREFS_ID,
} from '../../src/lib/road/index.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import { isId } from '../../src/shared/ids.js';

const day = (id, order, extra = {}) => ({ id, order, date: null, mode: 'drive', ...extra });
// One unit is 0.1° of longitude at the equator, about 11 km.
const place = (id, x, extra = {}) => ({ id, name: id.toUpperCase(), lng: x * 0.1, lat: 0, ...extra });
const visit = (id, dayId, placeId, order, extra = {}) => ({ id, dayId, placeId, order, ...extra });
const lodging = (id, x, fromDayId, toDayId, extra = {}) => ({ id, type: 'lodging', status: 'confirmed', title: id, location: { lat: 0, lng: x * 0.1 }, stay: { fromDayId, toDayId }, ...extra });

function chainOf({ days, places = [], visits = [], reservations = [], vias = [] }) {
  return buildChain({ model: createTripModel({ days, places, visits, reservations }), vias });
}
// Legs take `minutes` each unless listed, at 1 km per minute.
const timing = (minutes = {}) => (leg) => {
  const value = minutes[leg.key] ?? 60;
  return { minutes: value, meters: value * 1000, estimated: false };
};
const prefs = (extra = {}) => readPrefs({ start: '08:00', end: '20:00', stint: 120, daily: 480, pause: 20, ...extra });
const at = (dayIndex, time) => dayIndex * DAY + Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

describe('road prefs', () => {
  it('fills defaults and drops invalid values', () => {
    const value = readPrefs({ fuel: 'diesel', stint: 5, start: '21:00', end: '07:00', avoid: ['toll', 'x', 'ferry'], dayAvoid: { d1: ['motorway', 'y'] }, price: '1.7e3' });
    expect(value.fuel).toBe('petrol');
    expect(value.stint).toBe(120);
    expect(value.end).toBe('23:59');
    expect(value.avoid).toEqual(['toll', 'ferry']);
    expect(value.dayAvoid).toEqual({ d1: ['motorway'] });
    expect(value.price).toBeNull();
    expect(readPrefs({ fuel: 'electric' }).fill).toBe(80);
    expect(isId(ROAD_PREFS_ID)).toBe(true);
  });

  it('computes the range from the stated range, the tank or the battery', () => {
    expect(rangeKm(readPrefs({ range: 420, tank: 50, use: 5 }))).toBe(420);
    expect(rangeKm(readPrefs({ tank: 50, use: 6.25 }))).toBe(800);
    expect(rangeKm(readPrefs({ fuel: 'electric', battery: 75, use: 18, degrade: 10 }))).toBe(375);
    expect(rangeKm(readPrefs({ fuel: 'electric' }))).toBe(350);
  });

  it('turns changes into a create, a path patch or nothing', () => {
    expect(prefsChange(null, { stint: 90, range: null })).toEqual({ create: { stint: 90 } });
    expect(prefsChange({ stint: 90, range: 400 }, { stint: 90, range: null, avoid: ['toll'] })).toEqual({ set: { avoid: ['toll'] }, unset: ['range'] });
    expect(prefsChange({ stint: 90 }, { stint: 90 })).toBeNull();
    expect(prefsChange(null, { unknown: 1 })).toBeNull();
  });
});

describe('road chain', () => {
  it('chains days through their stays, with vias, unlocated visits and booked transport', () => {
    const chain = chainOf({
      days: [day('d1', 'a'), day('d2', 'b')],
      places: [place('a', 0), place('b', 2), place('c', 5, { stop: { type: 'fuel' } }), place('x', 0, { lat: undefined, lng: undefined })],
      visits: [visit('v1', 'd1', 'a', 'a'), visit('v2', 'd1', 'b', 'b', { pinned: true, start: '11:00' }), visit('v3', 'd2', 'c', 'a'), visit('v4', 'd2', 'x', 'b')],
      reservations: [
        lodging('h1', 3, 'd1', 'd2'),
        { id: 'f1', type: 'ferry', status: 'confirmed', title: 'Ferry', start: { date: null, time: '15:00' }, end: { time: '17:00' }, legs: [{ from: { lat: 0, lng: 0.6 }, to: { lat: 0, lng: 0.9 }, dep: { date: '2026-01-01', time: '15:00' }, arr: { date: '2026-01-01', time: '17:00' } }], dayPos: { d2: 'c' } },
      ],
      vias: [{ id: 'w1', dayId: 'd1', after: 'v1', order: 'a', lat: 0.01, lng: 0.1 }],
    });
    expect(chain.nodes.map((node) => node.key)).toEqual(['visit:v1', 'visit:v2', 'stay:h1@0', 'visit:v3', 'depart:f1@1', 'arrive:f1@1']);
    const stay = chain.nodes[2];
    expect([stay.day, stay.leaveDay, stay.nights]).toEqual([0, 1, 1]);
    expect(chain.nodes[1]).toMatchObject({ fixed: 660, pinned: true });
    expect(chain.nodes[3]).toMatchObject({ service: 'fuel', day: 1 });
    expect(chain.nodes[4]).toMatchObject({ fixed: 900, buffer: 30 });
    expect(chain.legs.map((leg) => leg.kind)).toEqual(['drive', 'drive', 'drive', 'drive', 'transport']);
    expect(chain.legs[0].vias).toEqual([{ id: 'w1', point: [0.1, 0.01] }]);
    expect(chain.legs[2].dayIndex).toBe(1);
    expect(chain.unlocated.map((item) => item.visit.id)).toEqual(['v4']);
    expect(driveRuns(chain).map((run) => run.legs.length)).toEqual([2, 2]);
  });

  it('keeps a multi-night stay as one stop and starts hire cars as stops', () => {
    const chain = chainOf({
      days: [day('d1', 'a'), day('d2', 'b'), day('d3', 'c')],
      places: [place('a', 0), place('b', 4)],
      visits: [visit('v1', 'd1', 'a', 'a'), visit('v2', 'd3', 'b', 'a')],
      reservations: [lodging('h1', 2, 'd1', 'd3'), { id: 'c1', type: 'car', status: 'confirmed', title: 'Car', location: { lat: 0, lng: 0.05 }, dayPos: { d1: '0' } }],
    });
    expect(chain.nodes.map((node) => node.key)).toEqual(['pickup:c1@0', 'visit:v1', 'stay:h1@0', 'visit:v2']);
    expect(chain.nodes[2]).toMatchObject({ day: 0, leaveDay: 2, nights: 2 });
  });

  it('finds the leg a day end points at and the leg nearest a point', () => {
    const chain = chainOf({ days: [day('d1', 'a')], places: [place('a', 0), place('b', 1), place('c', 2)], visits: [visit('v1', 'd1', 'a', 'a'), visit('v2', 'd1', 'b', 'b'), visit('v3', 'd1', 'c', 'c')] });
    expect(legForDayEnd(chain, { day: 'd1', fromVisit: 'v2', toVisit: 'v3' })?.key).toBe('visit:v2>visit:v3');
    expect(legForDayEnd(chain, { day: 'd1', fromVisit: 'v1', toVisit: 'v3' })).toBeNull();
    const near = detectLeg(chain, new Map(), [0.15, 0.01], project);
    expect(near.leg.key).toBe('visit:v2>visit:v3');
    expect(near.fraction).toBeCloseTo(0.5, 1);
  });
});

describe('road schedule', () => {
  const twoStops = (legMinutes, extra = {}) => {
    const chain = chainOf({ days: [day('d1', 'a'), day('d2', 'b')], places: [place('a', 0), place('b', 3)], visits: [visit('v1', 'd1', 'a', 'a', { dwell: 60 }), visit('v2', 'd1', 'b', 'b', { dwell: 30 })], ...extra });
    return { chain, key: chain.legs[0].key, run: (p = prefs(), dayEnds) => scheduleRoad({ chain, legTime: timing({ [chain.legs[0].key]: legMinutes }), prefs: p, dayEnds }) };
  };

  it('times stops from the window start with stay per stop', () => {
    const { run } = twoStops(60);
    const result = run();
    expect(result.stops.get('visit:v1')).toMatchObject({ arrive: at(0, '08:00'), depart: at(0, '09:00') });
    expect(result.stops.get('visit:v2')).toMatchObject({ arrive: at(0, '10:00'), depart: at(0, '10:30') });
    expect(result.totals).toMatchObject({ drive: 60, distance: 60_000, stops: 2 });
    expect(result.warnings).toEqual([]);
  });

  it('adds breaks after the longest drive at once', () => {
    const { run, key } = twoStops(300);
    const result = run();
    expect(result.drives.get(key).breaks.map((item) => item.at)).toEqual([0.4, 0.8]);
    expect(result.stops.get('visit:v2').arrive).toBe(at(0, '09:00') + 300 + 40);
  });

  it('pauses for the night at the daily limit and resumes at the window start', () => {
    const { run, key } = twoStops(600, { visits: [visit('v1', 'd1', 'a', 'a', { dwell: 0 }), visit('v2', 'd2', 'b', 'a')] });
    // v2 is planned on day 2, so the planned night comes first; drive the leg the same day with a manual day end late.
    const result = run(prefs({ stint: 720, end: '23:00' }), new Map([[key, [{ fraction: 0.95 }]]]));
    const drive = result.drives.get(key);
    expect(drive.nights.map((night) => night.source)).toEqual(['manual']);
    expect(result.days[0].overDaily).toBe(true);
    expect(result.warnings.some((warning) => warning.code === 'overDaily')).toBe(true);
    const auto = twoStops(600, { visits: [visit('v1', 'd1', 'a', 'a', { dwell: 0 }), visit('v2', 'd1', 'b', 'b')] }).run(prefs({ stint: 720 }));
    const night = [...auto.drives.values()][0].nights[0];
    expect(night).toMatchObject({ source: 'daily', count: 1, resume: at(1, '08:00') });
    expect(night.at).toBeCloseTo(0.8);
    expect(auto.stops.get('visit:v2').arrive).toBe(at(1, '10:00'));
    expect(auto.warnings).toContainEqual({ code: 'behind', node: 'visit:v2', days: 1 });
  });

  it('pauses at the end of the daily window', () => {
    const { run, key } = twoStops(240, { visits: [visit('v1', 'd1', 'a', 'a', { start: '16:00', dwell: 60 }), visit('v2', 'd1', 'b', 'b')] });
    const drive = run().drives.get(key);
    expect(drive.nights).toHaveLength(1);
    expect(drive.nights[0]).toMatchObject({ source: 'window' });
    // 17:00 departure, a break at 19:00, then 40 minutes to the window end.
    expect(drive.nights[0].at).toBeCloseTo(160 / 240);
  });

  it('drives on to a booked night and warns instead of pausing', () => {
    const chain = chainOf({ days: [day('d1', 'a'), day('d2', 'b')], places: [place('a', 0)], visits: [visit('v1', 'd1', 'a', 'a', { dwell: 0 })], reservations: [lodging('h1', 9, 'd1', 'd2')] });
    const result = scheduleRoad({ chain, legTime: timing({ [chain.legs[0].key]: 600 }), prefs: prefs({ stint: 720 }) });
    expect(result.drives.get(chain.legs[0].key).nights).toEqual([]);
    expect(result.days[0].overDaily).toBe(true);
    expect(result.days[0].overWindow).toBe(false);
  });

  it('sleeps at the start of a leg to the next day, or where the day end puts it', () => {
    const { run, key } = twoStops(120, { visits: [visit('v1', 'd1', 'a', 'a', { dwell: 0 }), visit('v2', 'd2', 'b', 'a')] });
    const planned = run();
    expect(planned.drives.get(key).nights).toEqual([{ at: 0, source: 'plan', count: 1, resume: at(1, '08:00') }]);
    expect(planned.stops.get('visit:v2').arrive).toBe(at(1, '10:00'));
    const placed = run(prefs(), new Map([[key, [{ fraction: 0.5 }]]]));
    expect(placed.drives.get(key).nights).toEqual([{ at: 0.5, source: 'manual', count: 1, resume: at(1, '08:00') }]);
    expect(placed.stops.get('visit:v2').arrive).toBe(at(1, '09:00'));
    const atEnd = run(prefs(), new Map([[key, [{ fraction: 1 }]]]));
    expect(atEnd.drives.get(key).nights[0].at).toBe(1);
    expect(atEnd.stops.get('visit:v2').arrive).toBe(at(1, '08:00'));
  });

  it('warns about late fixed times and moves early waits back to the previous stop', () => {
    const late = twoStops(180, { visits: [visit('v1', 'd1', 'a', 'a', { dwell: 0 }), visit('v2', 'd1', 'b', 'b', { pinned: true, start: '10:00' })] }).run();
    expect(late.warnings).toContainEqual({ code: 'late', node: 'visit:v2', minutes: 80 });
    const { run, key } = twoStops(60, { visits: [visit('v1', 'd1', 'a', 'a', { dwell: 30 }), visit('v2', 'd1', 'b', 'b', { pinned: true, start: '15:00' })] });
    const early = run();
    expect(early.stops.get('visit:v1').leaveBy).toBe(at(0, '14:00'));
    expect(early.stops.get('visit:v2')).toMatchObject({ arrive: at(0, '15:00'), start: at(0, '15:00') });
    expect(early.drives.get(key).start).toBe(at(0, '14:00'));
  });

  it('leaves a night stop early to make a fixed departure', () => {
    const chain = chainOf({
      days: [day('d1', 'a'), day('d2', 'b')], places: [place('a', 0)], visits: [visit('v1', 'd1', 'a', 'a')],
      reservations: [lodging('h1', 1, 'd1', 'd2'), { id: 'f1', type: 'flight', status: 'confirmed', title: 'Flight', location: { lat: 0, lng: 0.3 }, dayPos: { d2: 'a' }, start: { time: '07:00' } }],
    });
    const result = scheduleRoad({ chain, legTime: timing(), prefs: prefs() });
    expect(result.warnings.filter((warning) => warning.code === 'missed')).toEqual([]);
    expect(result.stops.get('stay:h1@0').depart).toBe(at(1, '04:30'));
  });
});

describe('range planning', () => {
  it('starts a band at the reserve and ends it where the range runs out', () => {
    const chain = chainOf({ days: [day('d1', 'a')], places: [place('a', 0), place('b', 1), place('c', 2)], visits: [visit('v1', 'd1', 'a', 'a'), visit('v2', 'd1', 'b', 'b'), visit('v3', 'd1', 'c', 'c')] });
    const [first, second] = chain.legs;
    const plan = planFuel({ chain, legTime: timing({ [first.key]: 300, [second.key]: 300 }), prefs: readPrefs({ range: 500, reserve: 10 }) });
    expect(plan.bands).toHaveLength(1);
    expect(plan.bands[0]).toMatchObject({ startKm: 450, endKm: 500, start: { leg: second.key }, end: { leg: second.key } });
    expect(plan.bands[0].start.fraction).toBeCloseTo(0.5);
    expect(plan.bands[0].pieces).toEqual([{ leg: second.key, from: 0.5, to: expect.closeTo(2 / 3) }]);
  });

  it('fills up at service stops and only counts matching ones', () => {
    const days = [day('d1', 'a')];
    const visits = [visit('v1', 'd1', 'a', 'a'), visit('v2', 'd1', 'b', 'b'), visit('v3', 'd1', 'c', 'c')];
    const legs = (chain) => timing({ [chain.legs[0].key]: 400, [chain.legs[1].key]: 400 });
    const fuel = chainOf({ days, visits, places: [place('a', 0), place('b', 1, { stop: { type: 'fuel' } }), place('c', 2)] });
    expect(planFuel({ chain: fuel, legTime: legs(fuel), prefs: readPrefs({ range: 500 }) }).bands).toEqual([]);
    expect(planFuel({ chain: fuel, legTime: legs(fuel), prefs: readPrefs({ range: 500 }) }).refills).toHaveLength(1);
    const charge = chainOf({ days, visits, places: [place('a', 0), place('b', 1, { stop: { type: 'charge', fill: 0.5 } }), place('c', 2)] });
    expect(planFuel({ chain: charge, legTime: legs(charge), prefs: readPrefs({ range: 500 }) }).bands).toHaveLength(1);
    const ev = planFuel({ chain: charge, legTime: legs(charge), prefs: readPrefs({ range: 500, fuel: 'electric' }) });
    expect(ev.refills[0]).toMatchObject({ before: 100, after: 250 });
    expect(ev.bands[0].startKm).toBeCloseTo(600);
  });

  it('plans one band per fill-up on long drives', () => {
    const chain = chainOf({ days: [day('d1', 'a')], places: [place('a', 0), place('b', 1)], visits: [visit('v1', 'd1', 'a', 'a'), visit('v2', 'd1', 'b', 'b')] });
    const plan = planFuel({ chain, legTime: timing({ [chain.legs[0].key]: 1500 }), prefs: readPrefs({ range: 500, reserve: 20, fill: 100 }) });
    expect(plan.bands.map((band) => Math.round(band.startKm))).toEqual([400, 800, 1200]);
  });
});

describe('road costs', () => {
  it('estimates fuel in minor units from consumption and price', () => {
    expect(fuelEstimate({ meters: 412_000, prefs: readPrefs({ use: 6.5, price: '1.789', currency: 'EUR' }) })).toMatchObject({ units: expect.closeTo(26.78), unit: 'l', amount: 4791, currency: 'EUR' });
    expect(fuelEstimate({ meters: 100_000, prefs: readPrefs({ fuel: 'electric', use: 18, price: '0.4', currency: 'JPY' }) })).toMatchObject({ unit: 'kwh', amount: 7 });
    expect(fuelEstimate({ meters: 100_000, prefs: readPrefs({ use: 6 }) })).toMatchObject({ units: 6, amount: null });
    expect(fuelEstimate({ meters: 100_000, prefs: readPrefs({}) })).toBeNull();
  });

  it('drafts an expense the trip schema accepts', () => {
    const draft = expenseDraft({ name: 'Fuel', amount: 4791, currency: 'EUR', people: ['0123456789abcdef', 'fedcba9876543210'], payer: '0123456789abcdef', date: '2026-05-01' });
    expect(() => validateEntity('trip', 'exp', { ...draft, links: undefined })).not.toThrow();
    expect(draft.split.parts).toHaveLength(2);
  });

  it('lists legs with tolls and ferries', () => {
    const chain = chainOf({ days: [day('d1', 'a')], places: [place('a', 0), place('b', 1), place('c', 2)], visits: [visit('v1', 'd1', 'a', 'a'), visit('v2', 'd1', 'b', 'b'), visit('v3', 'd1', 'c', 'c')] });
    const flags = routeFlags(chain, new Map([[chain.legs[0].key, { toll: true, ferry: false, motorway: true }]]));
    expect(flags).toEqual({ toll: [chain.legs[0].key], ferry: [], motorway: [chain.legs[0].key], unknown: 1 });
  });
});

describe('route geometry', () => {
  const line = [[0, 0], [1, 0], [1, 1]];

  it('finds points along a line and the nearest point to one', () => {
    expect(pointAt(line, 0.5)[0]).toBeCloseTo(1, 2);
    expect(pointAt(line, 0.25)).toEqual([expect.closeTo(0.5, 2), 0]);
    const near = project(line, [0.5, 0.1]);
    expect(near.fraction).toBeCloseTo(0.25, 2);
    expect(near.distance).toBeCloseTo(11_120, -2);
    expect(slice(line, 0.25, 0.75)).toHaveLength(3);
    expect(densify([[0, 0], [0.5, 0]], 10).length).toBeGreaterThan(5);
  });

  it('splits a routed line at its waypoints', () => {
    const routed = [[0, 0], [0.5, 0.01], [1, 0], [1.5, 0.01], [2, 0]];
    expect(splitAtWaypoints(routed, [[0, 0], [1, 0.001], [2, 0]])).toEqual([[[0, 0], [0.5, 0.01], [1, 0]], [[1, 0], [1.5, 0.01], [2, 0]]]);
  });

  it('covers a corridor with bounded boxes and keeps results inside it', () => {
    const long = [[0, 0], [10, 0]];
    const { boxes, truncated } = corridorBoxes(long, 5, { maxBoxes: 12 });
    expect(boxes.length).toBeLessThanOrEqual(12);
    expect(truncated).toBe(false);
    expect(boxes.every(([w, s, e, n]) => e - w <= 2 && n - s <= 2)).toBe(true);
    expect(boxes[0][0]).toBeLessThan(0);
    expect(boxes.at(-1)[2]).toBeGreaterThan(10 - 1e-9);
    const hits = withinCorridor([{ id: 'a', lat: 0.02, lng: 5 }, { id: 'b', lat: 0.2, lng: 5 }, { id: 'c', lat: -0.01, lng: 1 }, { id: 'a', lat: 0.02, lng: 5 }], long, 5);
    expect(hits.map((hit) => hit.id)).toEqual(['c', 'a']);
    expect(lineLength(long)).toBeCloseTo(1_111_951, -3);
  });

  it('matches hazards by distance or area', () => {
    const lines = [{ leg: 'l1', line: densify([[0, 0], [1, 0]], 5) }];
    const found = hazardsNearRoute([
      { id: 'q', type: 'EQ', level: 'green', point: [0.5, 1] },
      { id: 'f', type: 'FL', level: 'red', point: [0.5, 0.5] },
      { id: 'w', source: 'dwd', level: 'orange', polygons: [[[[0.2, -0.1], [0.4, -0.1], [0.4, 0.1], [0.2, 0.1], [0.2, -0.1]]]] },
    ], lines);
    expect(found.map((item) => item.event.id)).toEqual(['f', 'w']);
    expect(found[1].distance).toBe(0);
  });
});
