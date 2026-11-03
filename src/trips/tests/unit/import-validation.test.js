// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { candidateFromItem, coerceTime, coerceType, extractionItems, matchPerson } from '../../src/lib/ai/import/schema.js';
import { checkCandidate } from '../../src/lib/ai/import/checks.js';
import { compareBookings, fillMissing, findDuplicate, markDuplicates, mergeDrafts } from '../../src/lib/ai/import/dedupe.js';
import { validateEntity } from '../../src/shared/schema/index.js';

const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const people = [{ id: ALICE, name: 'Alice Martins' }, { id: BOB, name: 'Bob' }];
const AIRPORTS = {
  LIS: { iata: 'LIS', name: 'Humberto Delgado Airport', lat: 38.77, lng: -9.13, tz: 'Europe/Lisbon' },
  JFK: { iata: 'JFK', name: 'John F. Kennedy International Airport', lat: 40.64, lng: -73.78, tz: 'America/New_York' },
  MAD: { iata: 'MAD', name: 'Adolfo Suárez Madrid–Barajas Airport', lat: 40.47, lng: -3.56, tz: 'Europe/Madrid' },
  NRT: { iata: 'NRT', name: 'Narita International Airport', lat: 35.77, lng: 140.39, tz: 'Asia/Tokyo' },
};
const services = { airports: { byCode: async (code) => AIRPORTS[code] ?? null }, tz: { zoneAt: async () => 'Europe/Lisbon' } };
const days = ['2026-05-03', '2026-05-04', '2026-05-05'].map((date, index) => ({ id: `d00000000000000${index}`, date, order: `a${index}` }));
const flight = (legs, extra = {}) => ({ type: 'flight', title: '', status: 'confirmed', code: 'X7K2LM', legs, ...extra });

describe('coercion of model output', () => {
  it('reads times, types and people', () => {
    expect(coerceTime('7:05 PM')).toBe('19:05');
    expect(coerceTime('12 am')).toBe('00:00');
    expect(coerceTime('19h05')).toBe('19:05');
    expect(coerceTime('07:05:00')).toBe('07:05');
    expect(coerceTime('25:00')).toBeUndefined();
    expect(coerceTime('noon')).toBeUndefined();
    expect(coerceType('Hotel')).toBe('lodging');
    expect(coerceType('car rental')).toBe('car');
    expect(coerceType('spaceship')).toBe('other');
    expect(matchPerson('MS ALICE MARTINS', people)).toBe(ALICE);
    expect(matchPerson('Bob Smith', people)).toBe(BOB);
    expect(matchPerson('Carol', people)).toBeNull();
  });

  it('builds a valid reservation draft and keeps only known fields', () => {
    const candidate = candidateFromItem({
      type: 'flight', title: ' ', status: 'booked', provider: 'TAP', code: 'x7k2lm',
      legs: [{ from: { code: 'lis', name: 'Lisbon' }, to: { code: 'JFK' }, dep: { date: '2026-05-03', time: '10:30 PM' }, arr: { date: '2026-05-04', time: '01:10' }, number: 'TP 209', seat: '23A' }],
      travelers: ['Alice Martins', 'Dana Who'], url: 'javascript:alert(1)', notes: 'Bag\u0000 included‮',
      id: 'injected', dayPos: { x: 'a' }, placeId: 'zzzzzzzzzzzzzzzz', review: false, src: { kind: 'manual' },
    }, { people, hash: 'abc', label: (key) => ({ travelers: 'Travelers' })[key] ?? key });
    expect(candidate.issues).toEqual([]);
    const { draft } = candidate;
    expect(() => validateEntity('trip', 'res', draft)).not.toThrow();
    expect(draft).toMatchObject({ type: 'flight', status: 'confirmed', code: 'x7k2lm', title: 'LIS → JFK', people: [ALICE], review: true, src: { kind: 'ai', hash: 'abc' } });
    expect(draft.legs[0]).toMatchObject({ from: { code: 'LIS', name: 'Lisbon' }, dep: { date: '2026-05-03', time: '22:30' }, carrier: 'TAP', number: 'TP 209', seat: '23A' });
    expect(draft.url).toBeUndefined();
    expect(draft.notes).toBe('Bag included\nTravelers: Dana Who');
    for (const key of ['id', 'dayPos', 'placeId']) expect(draft[key]).toBeUndefined();
  });

  it('reports schema issues instead of dropping incomplete items', () => {
    const missing = candidateFromItem({ type: 'train', title: 'Porto', legs: [{ from: { name: 'Lisboa' }, to: { name: 'Porto' }, dep: { date: 'tomorrow' } }] });
    expect(missing.issues.map((issue) => issue.path)).toContain('$.legs.0.dep.date');
    const lodging = candidateFromItem({ type: 'hotel', title: 'Hotel Sol', provider: 'Booking.com', start: { date: '2026-05-03', tz: 'Europe/Lisbon' }, end: { date: '2026-05-05', tz: 'Mars/Base' }, checkIn: '3 pm', checkOut: '11:00', location: { address: 'Rua 1' } });
    expect(lodging.issues).toEqual([]);
    expect(lodging.draft).toMatchObject({ type: 'lodging', start: { date: '2026-05-03', tz: 'Europe/Lisbon' }, end: { date: '2026-05-05', tz: 'Europe/Lisbon' }, stay: { checkInFrom: '15:00', checkOut: '11:00' }, location: { name: 'Booking.com', address: 'Rua 1' } });
  });

  it('accepts parser instants only from trusted items', () => {
    const item = flight([{ from: { code: 'LIS' }, to: { code: 'JFK' }, dep: { date: '2026-05-03', time: '21:00', at: 1 } }]);
    expect(candidateFromItem(item).hints).toEqual({});
    expect(candidateFromItem(item, { trusted: true }).hints).toEqual({ legs: [{ depAt: 1, arrAt: undefined }] });
  });

  it('reads model replies defensively', () => {
    expect(extractionItems('```json\n{"bookings":[{"type":"event","title":"A"}]}\n```')).toHaveLength(1);
    expect(extractionItems('Sure! {"bookings": []} hope this helps')).toEqual([]);
    expect(extractionItems([{ type: 'tour' }, 'junk', null])).toEqual([{ type: 'tour' }]);
    expect(() => extractionItems('no json here')).toThrow(expect.objectContaining({ code: 'unreadable' }));
  });
});

describe('post-extraction checks', () => {
  it('fills airports and zones and restates parser instants locally', async () => {
    const item = flight([{ from: { code: 'LIS' }, to: { code: 'JFK' }, dep: { date: '2026-05-03', time: '21:00', at: Date.UTC(2026, 4, 3, 21, 0) } }]);
    const checked = await checkCandidate(candidateFromItem(item, { trusted: true }), { services, days });
    expect(checked.draft.legs[0].from).toMatchObject({ code: 'LIS', name: 'Humberto Delgado Airport', tz: 'Europe/Lisbon', lat: 38.77 });
    expect(checked.draft.legs[0].dep).toEqual({ date: '2026-05-03', time: '22:00' });
    expect(checked.warnings).toEqual([]);
  });

  it('fixes overnight arrivals and AM/PM slips, picking the shortest plausible flight', async () => {
    const overnight = await checkCandidate(candidateFromItem(flight([{ from: { code: 'LIS' }, to: { code: 'MAD' }, dep: { date: '2026-05-03', time: '23:30' }, arr: { date: '2026-05-03', time: '01:45' } }])), { services, days });
    expect(overnight.draft.legs[0].arr).toEqual({ date: '2026-05-04', time: '01:45' });
    expect(overnight.warnings).toEqual([{ code: 'arrival_next_day', leg: 0 }]);
    const ampm = await checkCandidate(candidateFromItem(flight([{ from: { code: 'LIS' }, to: { code: 'MAD' }, dep: { date: '2026-05-03', time: '09:00' }, arr: { date: '2026-05-03', time: '01:15' } }])), { services, days });
    expect(ampm.draft.legs[0].arr).toEqual({ date: '2026-05-03', time: '13:15' });
    expect(ampm.warnings).toEqual([{ code: 'ampm_fixed', leg: 0 }]);
    const westward = await checkCandidate(candidateFromItem(flight([{ from: { code: 'LIS' }, to: { code: 'JFK' }, dep: { date: '2026-05-03', time: '11:00' }, arr: { date: '2026-05-03', time: '13:30' } }])), { services, days });
    expect(westward.warnings).toEqual([]);
  });

  it('orders legs, removes repeated ones and flags unknown airports and dates outside the trip', async () => {
    const legA = { from: { code: 'LIS' }, to: { code: 'MAD' }, dep: { date: '2026-05-03', time: '07:00' }, arr: { date: '2026-05-03', time: '09:15' }, number: 'IB1' };
    const legB = { from: { code: 'MAD' }, to: { code: 'NRT' }, dep: { date: '2026-05-03', time: '12:00' }, arr: { date: '2026-05-04', time: '08:00' }, number: 'IB2' };
    const checked = await checkCandidate(candidateFromItem(flight([legB, legA, { ...legA }])), { services, days });
    expect(checked.draft.legs.map((leg) => leg.number)).toEqual(['IB1', 'IB2']);
    expect(checked.warnings.map((warning) => warning.code)).toEqual(['duplicate_leg', 'legs_reordered']);
    const odd = await checkCandidate(candidateFromItem(flight([{ from: { code: 'XYZ' }, to: { code: 'LIS' }, dep: { date: '2026-08-01' } }])), { services, days });
    expect(odd.warnings).toEqual([{ code: 'unknown_airport', leg: 0, value: 'XYZ' }, { code: 'outside_trip' }]);
  });

  it('still checks without services', async () => {
    const checked = await checkCandidate(candidateFromItem(flight([{ from: { code: 'LIS' }, to: { code: 'JFK' }, dep: { date: '2026-05-03' } }])), {});
    expect(checked.issues).toEqual([]);
    expect(checked.warnings).toEqual([]);
  });
});

describe('dedupe and merge', () => {
  const existing = {
    id: 'r000000000000001', type: 'flight', title: 'LIS → JFK', status: 'confirmed', code: 'X7K-2LM',
    legs: [{ from: { code: 'LIS' }, to: { code: 'JFK' }, dep: { date: '2026-05-03', time: '22:00' }, arr: { date: '2026-05-04' }, carrier: 'TAP Air Portugal', number: 'TP209' }],
  };
  const hotel = { id: 'r000000000000002', type: 'lodging', title: 'Hotel Sol', status: 'pending', start: { date: '2026-05-04' }, end: { date: '2026-05-06' }, location: { name: 'Hotel Sol Lisboa' } };
  const cand = (draft, provider) => ({ id: Math.random().toString(36).slice(2), draft, provider });

  it('matches by confirmation code, legs and dates', () => {
    expect(compareBookings({ type: 'flight', code: 'x7k2lm', legs: [] }, existing, { provider: 'TAP Air Portugal' })).toEqual({ reason: 'code', strength: 'exact' });
    expect(compareBookings({ type: 'flight', code: 'X7K2LM', legs: [] }, existing, { provider: 'Lufthansa' })).toEqual({ reason: 'code', strength: 'likely' });
    expect(compareBookings({ type: 'flight', legs: [{ from: { code: 'LIS' }, to: { code: 'JFK' }, dep: { date: '2026-05-03' }, number: 'TP 209' }] }, existing)).toEqual({ reason: 'legs', strength: 'exact' });
    expect(compareBookings({ type: 'flight', legs: [{ from: { code: 'LIS' }, to: { code: 'JFK' }, dep: { date: '2026-05-03' } }] }, existing)).toEqual({ reason: 'legs', strength: 'likely' });
    expect(compareBookings({ type: 'flight', legs: [{ from: { code: 'LIS' }, to: { code: 'JFK' }, dep: { date: '2026-05-03' }, number: 'TP201' }] }, existing)).toBeNull();
    expect(compareBookings({ type: 'lodging', title: 'Sol', start: { date: '2026-05-04' } }, hotel)).toEqual({ reason: 'dates', strength: 'likely' });
    expect(compareBookings({ type: 'lodging', code: 'X7K2LM', start: { date: '2026-05-04' } }, existing)).toBeNull();
    expect(findDuplicate(cand({ type: 'flight', code: 'X7K2LM', legs: existing.legs }), [hotel, existing])).toEqual({ resId: existing.id, reason: 'code', strength: 'exact' });
  });

  it('sets default actions and finds repeats among candidates', () => {
    const list = markDuplicates([
      cand({ type: 'flight', code: 'X7K2LM', legs: existing.legs }, 'TAP'),
      cand({ type: 'lodging', title: 'Sol', start: { date: '2026-05-04' } }),
      cand({ type: 'event', title: 'Fado', code: 'EVT-9981', start: { date: '2026-05-05' } }),
      cand({ type: 'event', title: 'Fado night', code: 'evt9981', start: { date: '2026-05-05' } }),
    ], [existing, hotel]);
    expect(list.map((item) => item.action)).toEqual(['skip', 'create', 'create', 'skip']);
    expect(list[1].duplicate).toMatchObject({ resId: hotel.id, strength: 'likely' });
    expect(list[3].duplicateOf).toBe(list[2].id);
    const kept = markDuplicates([{ ...list[0], action: 'update' }], []);
    expect(kept[0].action).toBe('create');
  });

  it('merges legs in travel order and fills gaps in an existing booking', () => {
    const outbound = { type: 'flight', title: 'Out', status: 'pending', code: 'ABC123', legs: [{ from: { code: 'LIS' }, to: { code: 'MAD' }, dep: { date: '2026-05-03', time: '07:00' }, arr: { date: '2026-05-03' } }] };
    const second = { type: 'flight', title: 'Second', status: 'confirmed', notes: 'Meal', legs: [{ from: { code: 'MAD' }, to: { code: 'NRT' }, dep: { date: '2026-05-03', time: '12:00' }, arr: { date: '2026-05-04' } }, outbound.legs[0]] };
    const merged = mergeDrafts([second, outbound]);
    expect(merged.legs.map((leg) => leg.from.code)).toEqual(['LIS', 'MAD']);
    expect(merged).toMatchObject({ status: 'confirmed', code: 'ABC123', notes: 'Meal', start: { date: '2026-05-03', time: '07:00' } });
    expect(() => mergeDrafts([outbound, hotel])).toThrow('merge_mixed');
    const filled = fillMissing(existing, { type: 'flight', title: 'x', status: 'confirmed', url: 'https://tap.example/manage', legs: [{ ...existing.legs[0], seat: '23A', number: 'TP999', dep: { date: '2026-05-03', time: '21:00' } }] });
    expect(filled.legs[0]).toMatchObject({ seat: '23A', number: 'TP209', dep: { time: '22:00' } });
    expect(filled).toMatchObject({ url: 'https://tap.example/manage', code: 'X7K-2LM', review: true });
    expect(() => validateEntity('trip', 'res', filled)).not.toThrow();
  });
});
