import { describe, expect, it } from 'vitest';
import { createSelectors } from '../../src/lib/store/query.js';
import { createRoutePlanner } from '../../src/lib/route-plan/index.js';
import { availableSections, daysInRange, normalizeOptions } from '../../src/views/print/options.js';
import { buildPrintModel, readTrip } from '../../src/views/print/model.js';
import { buildDocument, cssString, pageStyle } from '../../src/views/print/document.js';
import { mapJobs } from '../../src/views/print/snapshots.js';

const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const id = (prefix, n) => `${prefix}${String(n).padStart(15, '0')}`;
const D = [1, 2, 3].map((n) => id('d', n));
const P = [1, 2, 3].map((n) => id('p', n));

/** A read-only `space` facade over plain entities, with the caller's private items in `query`. */
function stubSpace(ents, privates = []) {
  const data = new Map();
  for (const { t, ...entity } of ents) {
    if (!data.has(t)) data.set(t, new Map());
    data.get(t).set(entity.id, Object.freeze({ cr: 1, ...entity }));
  }
  const arrays = new Map();
  const source = (type) => {
    if (!arrays.has(type)) arrays.set(type, Object.freeze([...(data.get(type)?.values() ?? [])]));
    return arrays.get(type);
  };
  const get = (type, key) => data.get(type)?.get(key);
  const select = createSelectors({ kind: 'trip', source, get, subscribe: () => () => {} });
  return {
    select, get,
    query: (type, { includePrivate = false } = {}) => [...select[type].all(), ...(includePrivate ? privates.filter((item) => item.t === type).map(({ t, ...item }) => ({ ...item, private: true })) : [])],
    subscribe: () => () => {},
  };
}

const ents = [
  { t: 'meta', id: 'meta', title: 'Lisbon & Porto', currency: 'EUR', start: '2027-05-01', end: '2027-05-03', description: 'Sun **and** tiles' },
  { t: 'member', id: ALICE, name: 'Alice', role: 'owner' },
  { t: 'member', id: BOB, name: 'Bob', role: 'editor' },
  { t: 'guest', id: id('g', 1), name: 'Gus' },
  ...D.map((day, index) => ({ t: 'day', id: day, order: `a${index}`, date: `2027-05-0${index + 1}` })),
  { t: 'place', id: P[0], name: 'Belém Tower', lat: 38.6916, lng: -9.216, address: 'Av. Brasília', img: { url: 'https://example.com/belem.jpg' } },
  { t: 'place', id: P[1], name: '<img src=x onerror=alert(1)>', lat: 38.7139, lng: -9.1335 },
  { t: 'place', id: P[2], name: 'No coordinates' },
  { t: 'visit', id: id('v', 1), dayId: D[0], placeId: P[0], order: 'a0', start: '09:00', end: '10:30', notes: 'Buy **tickets** online' },
  { t: 'visit', id: id('v', 2), dayId: D[0], placeId: P[2], order: 'a1' },
  { t: 'visit', id: id('v', 3), dayId: D[0], placeId: P[1], order: 'a2' },
  { t: 'visit', id: id('v', 4), dayId: D[2], placeId: P[1], order: 'a0' },
  { t: 'dayNote', id: id('n', 1), dayId: D[1], order: 'a0', title: 'Rest day', text: 'Nothing *planned*' },
  { t: 'res', id: id('r', 1), type: 'train', title: 'Train to Porto', status: 'confirmed', code: 'PT123', legs: [{ from: { name: 'Lisboa', lat: 38.71, lng: -9.12 }, to: { name: 'Porto', lat: 41.15, lng: -8.61 }, dep: { date: '2027-05-03', time: '08:00' }, arr: { date: '2027-05-03', time: '11:00' } }] },
  { t: 'res', id: id('r', 2), type: 'lodging', title: 'Hotel Lisboa', status: 'confirmed', start: { date: '2027-05-01' }, end: { date: '2027-05-03' }, location: { lat: 38.72, lng: -9.14 } },
  { t: 'res', id: id('r', 3), type: 'restaurant', title: 'Cancelled dinner', status: 'cancelled', start: { date: '2027-05-01', time: '20:00' } },
  { t: 'res', id: id('r', 4), type: 'event', title: 'Undated show', status: 'pending' },
  { t: 'pack', id: id('k', 1), name: 'Socks', qty: 4, list: 'Clothes', order: 'a0', done: true },
  { t: 'pack', id: id('k', 2), name: 'Charger', list: 'Tech', order: 'a1' },
  { t: 'exp', id: id('e', 1), name: 'Dinner', amount: 6000, currency: 'EUR', cat: 'food', payers: [{ who: ALICE, amount: 6000 }], split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB }] } },
  { t: 'note', id: id('n', 2), title: 'Ideas', body: 'Try *pastéis*', pinned: true },
];
const privates = [
  { t: 'pack', id: id('k', 3), name: 'Diary', order: 'a2', list: 'Clothes' },
  { t: 'exp', id: id('e', 2), name: 'Gift', amount: 1500, currency: 'EUR', payers: [{ who: ALICE, amount: 1500 }], split: { mode: 'equal', parts: [{ who: ALICE }] } },
];
const space = stubSpace(ents, privates);
const trip = readTrip(space);
const all = ['overview', 'days', 'map', 'bookings', 'packing', 'costs', 'notes'];

describe('print options', () => {
  const days = trip.days;
  it('fills defaults, drops unknown values and keeps the range in plan order', () => {
    const options = normalizeOptions({ sections: ['days', 'bogus', 'costs'], detail: 'huge', from: D[2], to: D[0] }, { days });
    expect(options).toMatchObject({ sections: ['days', 'costs'], detail: 'detailed', orientation: 'portrait', font: 'medium', pageBreak: true, from: D[0], to: D[2] });
    expect(normalizeOptions({ from: 'gone' }, { days }).from).toBe(D[0]);
    expect(normalizeOptions({}, { days: [] })).toMatchObject({ from: null, to: null });
    expect(daysInRange(days, { from: D[1], to: D[1] }).map((day) => day.id)).toEqual([D[1]]);
  });
  it('offers only the sections of add-ons the trip keeps', () => {
    expect(availableSections({ settings: { addons: { costs: false, lists: false } } })).toEqual(['overview', 'days', 'map', 'bookings', 'notes']);
    expect(normalizeOptions({ sections: all }, { days, available: ['days', 'notes'] }).sections).toEqual(['days', 'notes']);
  });
});

describe('print model', () => {
  const options = (extra = {}) => normalizeOptions({ sections: all, ...extra }, { days: trip.days });

  it('builds the days with stop numbers for located visits and leaves cancelled bookings out of the timeline', () => {
    const model = buildPrintModel(trip, options(), { uid: ALICE });
    const [first, second, third] = model.days;
    expect(first.rows.filter((row) => row.kind === 'visit').map((row) => row.stop)).toEqual([1, null, 2]);
    expect(first.rows.some((row) => row.id === id('r', 3))).toBe(false);
    expect(first.stays.map((stay) => stay.phase)).toEqual(['checkin']);
    expect(second.rows.map((row) => row.kind)).toEqual(['note']);
    expect(third.rows.map((row) => row.kind)).toEqual(['res', 'visit']);
    expect(first.photos.map((photo) => photo.place.id)).toEqual([P[0]]);
    expect(model.stats).toMatchObject({ days: 3, places: 3, bookings: 3, travelers: 3 });
  });

  it('lists every booking for the whole trip but only the shown ones for a range', () => {
    const full = buildPrintModel(trip, options());
    expect(full.full).toBe(true);
    expect(full.bookings.other.map((res) => res.title)).toEqual(expect.arrayContaining(['Cancelled dinner', 'Undated show']));
    const range = buildPrintModel(trip, options({ from: D[2], to: D[2] }));
    expect(range.full).toBe(false);
    expect(range.range).toMatchObject({ first: 3, last: 3, start: '2027-05-03', end: '2027-05-03' });
    expect([...range.bookings.transport, ...range.bookings.stays, ...range.bookings.other].map((res) => res.id).sort()).toEqual([id('r', 1), id('r', 2)]);
  });

  it('includes the viewer’s private packing items and keeps private spend out of the balances', () => {
    const model = buildPrintModel(trip, options(), { uid: ALICE });
    expect(model.packing.lists.map((list) => [list.name, list.items.map((entry) => entry.item.name)])).toEqual([['Clothes', ['Socks', 'Diary']], ['Tech', ['Charger']]]);
    expect(model.packing).toMatchObject({ done: 1, total: 3 });
    expect(model.costs).toMatchObject({ spend: 6000, count: 1, transfers: [{ from: BOB, to: ALICE, amount: 3000 }] });
    expect(model.costs.personal.total).toBe(1500);
    expect(model.stats.spend).toEqual({ amount: 6000, currency: 'EUR' });
    expect(buildPrintModel(trip, options(), { available: ['days'] }).stats.spend).toBeNull();
  });

  it('adds route totals when routes are known', () => {
    const routes = new Map([[D[0], { distance: 2500, duration: 1800, estimated: true, legs: [] }]]);
    const model = buildPrintModel(trip, options(), { routes });
    expect(model.days[0].route.distance).toBe(2500);
    expect(model.stats.distance).toEqual({ meters: 2500, estimated: true });
  });
});

describe('print document', () => {
  const build = (extra = {}, assets = {}) => {
    const options = normalizeOptions({ sections: all, ...extra }, { days: trip.days });
    return buildDocument(buildPrintModel(trip, options, { uid: ALICE }), options, assets, { space });
  };

  it('renders the chosen sections only, with user text kept as text', () => {
    const doc = build({ sections: ['days', 'bookings'] });
    expect(doc.querySelector('.pr-cover')).toBeNull();
    expect(doc.querySelector('.pr-costs')).toBeNull();
    expect(doc.querySelectorAll('.pr-day')).toHaveLength(3);
    expect(doc.querySelector('img[onerror]')).toBeNull();
    expect(doc.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('shows notes, photos and markdown only in detailed mode', () => {
    const detailed = build({ detail: 'detailed', photos: true });
    expect(detailed.querySelector('.pr-day .pr-rich strong')?.textContent).toBe('tickets');
    expect(detailed.querySelector('.pr-photo img')?.getAttribute('src')).toBe('https://example.com/belem.jpg');
    expect(detailed.querySelector('.pr-res')).not.toBeNull();
    const compact = build({ detail: 'compact' });
    expect(compact.querySelector('.pr-day .pr-rich')).toBeNull();
    expect(compact.querySelector('.pr-photo')).toBeNull();
    expect(compact.querySelector('.pr-bookings table')).not.toBeNull();
  });

  it('falls back to a route summary when the map picture is missing', () => {
    const offline = build({ sections: ['map'] }, { mapState: 'offline' });
    expect(offline.querySelector('.pr-note')).not.toBeNull();
    expect(offline.querySelector('.pr-route-summary').textContent).toContain('Belém Tower');
    const ready = build({ sections: ['map'] }, { mapState: 'ready', maps: new Map([['trip', { src: 'data:image/jpeg;base64,AA', width: 960, height: 540 }]]), credits: ['OpenFreeMap'] });
    expect(ready.querySelector('.pr-figure img').getAttribute('src')).toBe('data:image/jpeg;base64,AA');
    expect(ready.querySelector('figcaption').textContent).toContain('OpenFreeMap');
  });

  it('escapes page-box strings so a trip name cannot break out of the rule', () => {
    expect(cssString('a"b\\c}\n')).toBe('"a\\22 b\\5c c\\7d \\a "');
    const css = pageStyle({ orientation: 'landscape' }, { title: '"; } body { display: none } @page { content: "' });
    expect(css).toContain('size: landscape');
    expect(css.match(/\{/g)).toHaveLength(3);
    expect(css).toContain('counter(page)');
  });
});

describe('print maps', () => {
  it('numbers each day’s stops like the itinerary and tints the overview by day', () => {
    const planner = createRoutePlanner({ space });
    const routes = new Map(D.map((day) => [day, planner.estimate(day)]));
    const jobs = mapJobs({ planner, dayIds: D, routes, resIds: new Set([id('r', 1), id('r', 2)]), overview: true, perDay: true });
    const trip = jobs.find((job) => job.key === 'trip');
    expect(new Set(trip.layers.stops.features.map((feature) => feature.properties.tone))).toEqual(new Set([1, 3]));
    expect(trip.layers.stays.features).toHaveLength(1);
    const first = jobs.find((job) => job.key === `day:${D[0]}`);
    expect(first.layers.stops.features.map((feature) => feature.properties.order)).toEqual([1, 2]);
    expect(jobs.some((job) => job.key === `day:${D[1]}`)).toBe(true);
    expect(trip.points.length).toBeGreaterThan(3);
  });
});
