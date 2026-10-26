import { describe, expect, it } from 'vitest';
import { isOrder } from '../../src/shared/order.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import {
  cleanList, cleanTags, connector, galleryItems, groupByDate, journeyMetaFromTrip, journeyStats, lastOrders, moveOrder, openingDate, orderedSiblings, statusFor,
  suggestionsFromTrip, untouchedSuggestions, visibleEntries, weatherFromCondition,
} from '../../src/views/journey/model.js';

const ref = { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' };
const other = { w: 'trips-abcdefghij', s: '0000000000000009', k: 'trip' };
const id = (n) => `ab${String(n).padStart(14, '0')}`;
const entry = (n, fields = {}) => ({ id: id(n), type: 'moment', date: '2027-05-02', title: `E${n}`, order: 'V', cr: n, ...fields });

function tripData() {
  return {
    ref,
    days: [
      { id: id(101), order: 'b', date: '2027-05-02' },
      { id: id(100), order: 'a', date: '2027-05-01' },
      { id: id(102), order: 'c', date: null },
      { id: id(103), order: 'd', date: '2027-05-03', deleted: true },
    ],
    places: [
      { id: id(201), name: 'Belém Tower', lat: 38.69, lng: -9.21, cc: 'PT' },
      { id: id(202), name: 'Pastéis', cc: 'PT' },
      { id: id(203), name: 'Gone', deleted: true },
    ],
    visits: [
      { id: id(301), dayId: id(100), placeId: id(201), order: 'b', start: '10:00' },
      { id: id(302), dayId: id(100), placeId: null, title: 'Walk by the river', order: 'a' },
      { id: id(303), dayId: id(101), placeId: id(202), order: 'a' },
      { id: id(304), dayId: id(101), placeId: id(202), order: 'b' },
      { id: id(305), dayId: id(102), placeId: id(201), order: 'a' },
      { id: id(306), dayId: id(101), placeId: id(203), order: 'c' },
      { id: id(307), dayId: id(101), placeId: id(201), order: 'd', alt: id(301) },
      { id: id(308), dayId: id(100), placeId: null, title: '  ', order: 'c' },
    ],
  };
}

describe('suggestions from a linked trip', () => {
  it('makes one valid suggestion per scheduled visit on dated days, in day and visit order', () => {
    const out = suggestionsFromTrip(tripData());
    expect(out.map((item) => [item.date, item.title, item.time ?? null])).toEqual([
      ['2027-05-01', 'Walk by the river', null],
      ['2027-05-01', 'Belém Tower', '10:00'],
      ['2027-05-02', 'Pastéis', null],
    ]);
    expect(out[1]).toMatchObject({ type: 'suggestion', loc: { name: 'Belém Tower', lat: 38.69, lng: -9.21, cc: 'PT' }, src: { trip: ref, placeId: id(201), visitId: id(301) } });
    expect(out[2].loc).toEqual({ name: 'Pastéis', cc: 'PT' });
    expect(out[0].src).toEqual({ trip: ref, visitId: id(302) });
    expect(out[0].order < out[1].order).toBe(true);
    for (const item of out) {
      expect(isOrder(item.order)).toBe(true);
      expect(() => validateEntity('journey', 'entry', item)).not.toThrow();
    }
  });

  it('skips visits already suggested, dismissed or written up, and keeps other trips apart', () => {
    const existing = [
      entry(1, { type: 'suggestion', dismissed: true, src: { trip: ref, visitId: id(301), placeId: id(201) }, date: '2027-05-01' }),
      entry(2, { type: 'checkin', story: 'Lovely', src: { trip: ref, placeId: id(202) }, date: '2027-05-02' }),
      entry(3, { type: 'suggestion', src: { trip: other, visitId: id(302) }, date: '2027-05-01' }),
    ];
    const out = suggestionsFromTrip(tripData(), existing);
    expect(out.map((item) => item.src.visitId)).toEqual([id(302)]);
    expect(suggestionsFromTrip(tripData(), [...existing, ...out.map((item, n) => entry(10 + n, item))])).toEqual([]);
  });

  it('appends after the orders already used on each day', () => {
    const out = suggestionsFromTrip(tripData(), [], { after: (date) => (date === '2027-05-02' ? 'x' : null) });
    expect(out.find((item) => item.date === '2027-05-02').order > 'x').toBe(true);
  });

  it('names the journey after the trip with a status, its link and a web cover', () => {
    expect(journeyMetaFromTrip({ title: '  Lisbon  ', start: '2027-05-01', end: '2027-05-04', cover: { url: 'https://img.example/a.jpg', credit: 'Ana' } }, ref, '2027-04-01')).toEqual({
      title: 'Lisbon', trips: [ref], fields: { mood: true, weather: true, prosCons: true }, status: 'upcoming', cover: { url: 'https://img.example/a.jpg', credit: 'Ana' },
    });
    const meta = journeyMetaFromTrip({ title: '', cover: 'fileid0000000000' }, ref, '2027-04-01');
    expect(meta.title).toBe('Journey');
    expect(meta.status).toBeUndefined();
    expect(meta.cover).toBeUndefined();
    expect(() => validateEntity('journey', 'meta', journeyMetaFromTrip({ title: 'x'.repeat(400) }, ref, '2027-04-01'))).not.toThrow();
    expect(statusFor('2027-05-01', '2027-05-04', '2027-05-04')).toBe('ongoing');
    expect(statusFor('2027-05-01', '2027-05-04', '2027-05-05')).toBe('completed');
  });

  it('finds untouched suggestions of one trip for unlinking', () => {
    const entries = [
      entry(1, { type: 'suggestion', src: { trip: ref, visitId: id(1) } }),
      entry(2, { type: 'suggestion', src: { trip: ref, visitId: id(2) }, dismissed: true }),
      entry(3, { type: 'suggestion', src: { trip: ref, visitId: id(3) }, media: [id(9)] }),
      entry(4, { type: 'suggestion', src: { trip: other, visitId: id(4) } }),
      entry(5, { type: 'checkin', src: { trip: ref, visitId: id(5) } }),
    ];
    expect(untouchedSuggestions(entries, ref).map((item) => item.id)).toEqual([id(1)]);
  });
});

describe('timeline helpers', () => {
  const entries = [
    entry(1, { date: '2027-05-02', time: '18:00', title: 'Dinner', tags: ['Food'] }),
    entry(2, { date: '2027-05-02', type: 'day', title: 'Day two', order: 'Z' }),
    entry(3, { date: '2027-05-01', title: 'Arrival', story: 'Café com leite' }),
    entry(4, { date: '2027-05-02', time: '09:00', title: 'Breakfast' }),
    entry(5, { date: '2027-05-02', title: 'Note', order: 'W' }),
    entry(6, { date: '2027-05-03', type: 'suggestion', title: 'Belém', src: { trip: ref } }),
    entry(7, { date: '2027-05-03', title: 'Skipped', dismissed: true }),
  ];

  it('orders day summaries, timed and untimed entries and reverses days for newest first', () => {
    expect(visibleEntries(entries).map((item) => item.title)).toEqual(['Arrival', 'Day two', 'Breakfast', 'Dinner', 'Note', 'Belém']);
    expect(visibleEntries(entries, { newestFirst: true }).map((item) => item.title)).toEqual(['Belém', 'Day two', 'Breakfast', 'Dinner', 'Note', 'Arrival']);
    expect(visibleEntries(entries, { hideSuggestions: true, showDismissed: true }).map((item) => item.title)).toContain('Skipped');
    expect(visibleEntries(entries, { hideSuggestions: true }).map((item) => item.title)).not.toContain('Belém');
    expect(groupByDate(visibleEntries(entries)).map((group) => [group.date, group.entries.length])).toEqual([['2027-05-01', 1], ['2027-05-02', 4], ['2027-05-03', 1]]);
  });

  it('shows a visit suggested twice by concurrent imports once', () => {
    const twice = [entry(20, { type: 'suggestion', src: { trip: ref, visitId: id(9) } }), entry(21, { type: 'suggestion', src: { trip: ref, visitId: id(9) } })];
    expect(visibleEntries(twice).map((item) => item.id)).toEqual([id(20)]);
  });

  it('searches titles, stories and tags without case or accents', () => {
    expect(visibleEntries(entries, { query: 'cafe' }).map((item) => item.title)).toEqual(['Arrival']);
    expect(visibleEntries(entries, { query: 'FOOD' }).map((item) => item.title)).toEqual(['Dinner']);
  });

  it('opens on today, the closest earlier day inside the span, else the first day', () => {
    const dates = ['2027-05-01', '2027-05-03', '2027-05-07'];
    expect(openingDate(dates, '2027-05-03')).toBe('2027-05-03');
    expect(openingDate(dates, '2027-05-05')).toBe('2027-05-03');
    expect(openingDate(dates, '2027-06-01')).toBe('2027-05-01');
    expect(openingDate(dates, '2026-01-01')).toBe('2027-05-01');
    expect(openingDate([], '2027-05-01')).toBeNull();
  });

  it('counts stats over written entries not excluded, with the route distance', () => {
    const list = [
      entry(1, { date: '2027-05-01', loc: { name: 'Lisbon', lat: 38.7223, lng: -9.1393, cc: 'PT' }, mood: 'great', tags: ['Food', 'tram'], story: 'Two words', media: [id(50), id(51)] }),
      entry(2, { date: '2027-05-03', loc: { name: 'Porto', lat: 41.1579, lng: -8.6291, cc: 'PT' }, mood: 'great', weather: 'rain', tags: ['food'] }),
      entry(3, { date: '2027-05-04', loc: { name: 'Vigo', lat: 42.2406, lng: -8.7207, cc: 'ES' }, excluded: true }),
      entry(4, { date: '2027-05-05', type: 'suggestion', src: { trip: ref } }),
    ];
    const stats = journeyStats(list, { isPhoto: (fileId) => fileId === id(50) });
    expect(stats).toMatchObject({ entries: 2, days: 2, places: 2, countries: ['PT'], photos: 1, moods: { great: 2 }, weather: { rain: 1 }, first: '2027-05-01', last: '2027-05-03', span: 3 });
    expect(stats.tags[0]).toEqual({ tag: 'Food', count: 2 });
    expect(stats.words).toBe(4);
    expect(stats.meters).toBeGreaterThan(270_000);
    expect(stats.meters).toBeLessThan(290_000);
  });

  it('lists gallery photos once in story order and draws the connector through located entries', () => {
    const list = [
      entry(1, { date: '2027-05-02', media: [id(52), id(50)], loc: { lat: 2, lng: 3 } }),
      entry(2, { date: '2027-05-01', media: [id(50), id(51), id(53)], loc: { name: 'Nowhere' } }),
      entry(3, { date: '2027-05-03', type: 'suggestion', media: [id(54)], src: { trip: ref }, loc: { lat: 9, lng: 9 } }),
      entry(4, { date: '2027-05-04', loc: { lat: 4, lng: 5 } }),
    ];
    const isImage = (fileId) => fileId !== id(53);
    expect(galleryItems(list, isImage).map((item) => item.fileId)).toEqual([id(50), id(51), id(52)]);
    expect(galleryItems(list, isImage, { newestFirst: true }).map((item) => item.fileId)).toEqual([id(52), id(50), id(51)]);
    expect(connector(list)).toEqual([[3, 2], [5, 4]]);
    expect(lastOrders(list).get('2027-05-02')).toBe('V');
  });

  it('moves untimed entries within a day, re-keying when orders tie', () => {
    const list = [entry(1, { order: 'a' }), entry(2, { order: 'b' }), entry(3, { order: 'c' }), entry(4, { time: '09:00', order: 'd' }), entry(5, { type: 'day', order: 'e' })];
    const siblings = orderedSiblings(list, '2027-05-02');
    expect(siblings.map((item) => item.id)).toEqual([id(1), id(2), id(3)]);
    const [write] = moveOrder(siblings, 2, -1);
    expect(write.id).toBe(id(3));
    expect(write.order > 'a' && write.order < 'b').toBe(true);
    expect(moveOrder(siblings, 0, -1)).toEqual([]);
    const tied = orderedSiblings([entry(6, { order: 'V' }), entry(7, { order: 'V' }), entry(8, { order: 'V' })], '2027-05-02');
    const writes = moveOrder(tied, 2, -1);
    const orders = new Map(tied.map((item) => [item.id, item.order]));
    for (const item of writes) orders.set(item.id, item.order);
    expect([...orders.entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([key]) => key)).toEqual([id(6), id(8), id(7)]);
  });

  it('cleans tags, lists and forecast conditions', () => {
    expect(cleanTags([' Food ', 'food', '', 'x'.repeat(60)])).toEqual(['Food', 'x'.repeat(50)]);
    expect(cleanList([' a ', ' ', 'b'])).toEqual(['a', 'b']);
    expect(weatherFromCondition('drizzle')).toBe('rain');
    expect(weatherFromCondition('clear', 12)).toBe('wind');
    expect(weatherFromCondition('unknown')).toBeNull();
  });
});
