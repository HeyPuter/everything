import { describe, expect, it } from 'vitest';
import { copyEntities } from '../../src/views/trip/settings/copy.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import { cleanMeta, initialDays } from '../../src/views/trip/settings/actions.js';
import { matchesFilter, spotlightTrip } from '../../src/views/dashboard/index.js';
import { compareTrips, tripStatus } from '../../src/views/trip/settings/meta.js';

const ME = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const ids = { day1: 'd000000000000001', day2: 'd000000000000002', place: 'p000000000000001', visit: 'v000000000000001', res: 'r000000000000001', guest: 'g000000000000001', bag: 'b000000000000001', pack: 'k000000000000001', cat: 'c000000000000001' };
const source = {
  day: [{ id: ids.day1, order: 'a', date: '2027-05-01' }, { id: ids.day2, order: 'b', date: '2027-05-02' }],
  place: [{ id: ids.place, name: 'Museum', cat: ids.cat, rating: { [ME]: 5, [BOB]: 2 }, tags: { [ME]: ['art'], [BOB]: ['x'] }, img: { fileId: 'f000000000000001' } }],
  cat: [{ id: ids.cat, name: 'Art', color: 1, icon: 'landmark' }],
  visit: [{ id: ids.visit, dayId: ids.day2, placeId: ids.place, order: 'a', people: [ME, BOB, ids.guest], stayId: ids.res }],
  res: [{ id: ids.res, type: 'lodging', title: 'Inn', status: 'confirmed', start: { date: '2027-05-01' }, stay: { fromDayId: ids.day1, toDayId: ids.day2 }, dayPos: { [ids.day1]: 'a' }, people: [BOB] }],
  guest: [{ id: ids.guest, name: 'Sam' }],
  bag: [{ id: ids.bag, name: 'Carry-on', order: 'a', people: [BOB] }],
  pack: [{ id: ids.pack, name: 'Socks', order: 'a', bagId: ids.bag, done: true, doneBy: { [BOB]: true }, bring: { [BOB]: 'yes' }, owner: BOB }],
  listMeta: [], todo: [], note: [], link: [], dayNote: [],
};
let n = 0;
const makeId = () => `n${String(++n).padStart(15, '0')}`;

describe('trip copy', () => {
  it('remaps references, moves dates and drops other members’ data', () => {
    const out = copyEntities((type) => source[type] ?? [], ['days', 'bookings', 'packing'], { uid: ME, delta: 10, makeId });
    const by = (t) => out.filter((item) => item.t === t);
    for (const item of out) expect(() => validateEntity('trip', item.t, item.put)).not.toThrow();
    const [day1, day2] = by('day');
    expect(day1.put.date).toBe('2027-05-11');
    const [place] = by('place');
    expect(place.put).toMatchObject({ name: 'Museum', cat: by('cat')[0].id, tags: { [ME]: ['art'] } });
    expect(place.put.rating).toBeUndefined(); expect(place.put.img).toBeUndefined();
    const [visit] = by('visit');
    expect(visit.put).toMatchObject({ dayId: day2.id, placeId: place.id, stayId: by('res')[0].id, people: [ME, by('guest')[0].id] });
    const [res] = by('res');
    expect(res.put).toMatchObject({ start: { date: '2027-05-11' }, stay: { fromDayId: day1.id, toDayId: day2.id }, dayPos: { [day1.id]: 'a' } });
    expect(res.put.people).toBeUndefined();
    const [pack] = by('pack');
    expect(pack.put).toMatchObject({ bagId: by('bag')[0].id, done: false });
    expect(pack.put.doneBy).toBeUndefined(); expect(pack.put.owner).toBeUndefined();
    expect(new Set(out.map((item) => item.id)).size).toBe(out.length);
    expect(out.some((item) => Object.values(ids).includes(item.id))).toBe(false);
  });

  it('copies the itinerary only with its places and leaves out unchosen groups', () => {
    const out = copyEntities((type) => source[type] ?? [], ['places'], { uid: ME, makeId });
    expect([...new Set(out.map((item) => item.t))].sort()).toEqual(['cat', 'guest', 'place']);
  });

  it('starts new trips with one day per date or the undated day count', () => {
    expect(initialDays(cleanMeta({ title: 'T', currency: 'EUR', start: '2027-05-01', end: '2027-05-03' })).map((day) => day.date)).toEqual(['2027-05-01', '2027-05-02', '2027-05-03']);
    const undated = cleanMeta({ title: 'T', currency: 'EUR', start: '2027-05-01', dayCount: 4, tags: [] });
    expect(undated).toEqual({ title: 'T', currency: 'EUR', start: '2027-05-01', dayCount: 4 });
    expect(initialDays(undated).map((day) => day.date)).toEqual([null, null, null, null]);
  });
});

describe('dashboard ordering and filters', () => {
  const day = '2027-05-10';
  const trips = [
    { title: 'Past', start: '2027-01-01', end: '2027-01-05', archived: false },
    { title: 'Later', start: '2027-08-01', end: '2027-08-03', archived: false },
    { title: 'Now', start: '2027-05-08', end: '2027-05-12', archived: false },
    { title: 'Soon', start: '2027-06-01', end: '2027-06-02', archived: false },
    { title: 'Someday', start: null, end: null, archived: false },
    { title: 'Old', start: '2026-01-01', end: '2026-01-02', archived: true },
  ];
  it('sorts ongoing, upcoming, undated, then past', () => {
    expect([...trips].sort((a, b) => compareTrips(a, b, day)).map((trip) => trip.title)).toEqual(['Now', 'Soon', 'Later', 'Someday', 'Past', 'Old']);
    expect(tripStatus({ start: '2027-05-11', dayCount: 3 }, day)).toBe('upcoming');
    expect(tripStatus({ start: '2027-05-08', dayCount: 3 }, day)).toBe('ongoing');
  });
  it('filters planned, completed and archived and picks the spotlight', () => {
    const titles = (filter) => trips.filter((trip) => matchesFilter(trip, filter, day)).map((trip) => trip.title);
    expect(titles('planned')).toEqual(['Later', 'Now', 'Soon', 'Someday']);
    expect(titles('completed')).toEqual(['Past']);
    expect(titles('archived')).toEqual(['Old']);
    expect(spotlightTrip(trips, day).title).toBe('Now');
    expect(spotlightTrip(trips.filter((trip) => trip.title !== 'Now'), day).title).toBe('Soon');
  });
});
