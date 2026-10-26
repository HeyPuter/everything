// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resIssues, entriesByDay } from '../../src/lib/res/index.js';
import { decodePolyline } from '../../src/services/route.js';
import { newId } from '../../src/shared/ids.js';
import { encodePolyline } from '../../src/services/transit.js';
import { connectionDraft, defaultSearch, localTime, searchInstant, stopsNeedingZones } from '../../src/views/trip/plan/transit/model.js';

const DAY = newId();
const day = { id: DAY, date: '2026-11-02' };
const visit = (id, extra = {}) => ({ id, dayId: DAY, placeId: `p-${id}`, order: id === 'a' ? 'a0V' : 'a1', ...extra });

describe('transit search defaults', () => {
  const now = Date.UTC(2026, 10, 1, 23, 30);
  it('leaves at the first visit’s end, set or scheduled', () => {
    expect(defaultSearch({ from: visit('a', { end: '11:30' }), to: visit('b', { start: '13:00' }), day, now })).toEqual({ date: '2026-11-02', time: '11:30', arriveBy: false });
    const info = new Map([['visit:a', { endWall: { time: '10:45', offset: 0 } }]]);
    expect(defaultSearch({ from: visit('a'), to: visit('b'), day, info, now })).toEqual({ date: '2026-11-02', time: '10:45', arriveBy: false });
    const late = new Map([['visit:a', { endWall: { time: '00:30', offset: 1 } }]]);
    expect(defaultSearch({ from: visit('a'), to: visit('b'), day, info: late, now }).time).toBe('09:00');
  });
  it('arrives by the next visit’s start, then falls back to start plus dwell and the day start', () => {
    expect(defaultSearch({ from: visit('a'), to: visit('b', { start: '13:00' }), day, now })).toEqual({ date: '2026-11-02', time: '13:00', arriveBy: true });
    expect(defaultSearch({ from: visit('a', { start: '10:00', dwell: 90 }), to: visit('b'), day, now }).time).toBe('11:30');
    expect(defaultSearch({ from: visit('a', { start: '10:00' }), to: visit('b'), day, now }).time).toBe('11:00');
    expect(defaultSearch({ from: visit('a', { start: '23:30' }), to: visit('b'), day, now }).time).toBe('09:00');
    expect(defaultSearch({ from: visit('a'), to: visit('b'), day, now })).toEqual({ date: '2026-11-02', time: '09:00', arriveBy: false });
  });
  it('uses today in the departure zone on undated days', () => {
    expect(defaultSearch({ from: visit('a'), to: visit('b'), day: { id: 'd', date: null }, now, zone: 'Europe/Berlin' }).date).toBe('2026-11-02');
    expect(defaultSearch({ from: visit('a'), to: visit('b'), day: { id: 'd', date: null }, now, zone: 'America/New_York' }).date).toBe('2026-11-01');
  });
  it('reads search times in the departure zone, across DST', () => {
    expect(searchInstant({ date: '2026-11-02', time: '09:00' }, 'Europe/Berlin')).toBe(Date.UTC(2026, 10, 2, 8));
    expect(searchInstant({ date: '2026-07-02', time: '09:00' }, 'Europe/Berlin')).toBe(Date.UTC(2026, 6, 2, 7));
    expect(searchInstant({ date: '2026-03-29', time: '02:30' }, 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 29, 1, 30));
    expect(searchInstant({ date: '2026-11-02', time: '' }, 'Europe/Berlin')).toBeNull();
    expect(localTime(Date.UTC(2026, 10, 2, 23, 30), 'Europe/Berlin', '2026-11-02')).toEqual({ date: '2026-11-03', time: '00:30', offset: 1 });
  });
});

const shape = encodePolyline([[13.3777, 52.5163], [13.39, 52.518], [13.4019, 52.5208]], 5);
const itinerary = {
  start: Date.UTC(2026, 10, 2, 8, 2), end: Date.UTC(2026, 10, 2, 8, 27), duration: 1500, transfers: 1, walk: 300,
  legs: [
    { mode: 'walk', from: { name: 'Start', lat: 52.5163, lng: 13.3777, tz: null }, to: { name: 'Brandenburger Tor', lat: 52.5163, lng: 13.379, tz: null }, start: Date.UTC(2026, 10, 2, 8, 2), end: Date.UTC(2026, 10, 2, 8, 5), duration: 180 },
    {
      mode: 'bus', from: { name: 'Brandenburger Tor', lat: 52.5163, lng: 13.3777, tz: 'Europe/Berlin', track: '2' }, to: { name: 'Museumsinsel', lat: 52.5208, lng: 13.4019, tz: 'Europe/Berlin', track: null },
      start: Date.UTC(2026, 10, 2, 8, 7), end: Date.UTC(2026, 10, 2, 8, 17), duration: 600, route: '100', agency: 'BVG', color: '#a5027d', shape,
    },
    {
      mode: 'tram', from: { name: 'Hackescher Markt', lat: 52.5225, lng: 13.4024, tz: null, track: null }, to: { name: 'Alexanderplatz', lat: 52.5219, lng: 13.4132, tz: null, track: null },
      start: Date.UTC(2026, 10, 2, 22, 50), end: Date.UTC(2026, 10, 2, 23, 5), duration: 900, route: 'M4', agency: 'BVG', color: null, shape: null,
    },
  ],
};

describe('saving a connection', () => {
  it('becomes a confirmed transit booking with one leg per ride in local stop times', () => {
    const zones = new Map([['52.52250,13.40240', 'Europe/Berlin']]);
    const fields = connectionDraft(itinerary, { title: 'Hotel → Museum', zones, zone: 'Europe/London', dayId: DAY, fromOrder: 'a0V', toOrder: 'a1' });
    expect(resIssues(fields)).toEqual([]);
    expect(fields).toMatchObject({ type: 'transit', title: 'Hotel → Museum', status: 'confirmed' });
    expect(fields.legs).toHaveLength(2);
    expect(fields.legs[0]).toEqual({
      from: { name: 'Brandenburger Tor', lat: 52.5163, lng: 13.3777, tz: 'Europe/Berlin' }, to: { name: 'Museumsinsel', lat: 52.5208, lng: 13.4019, tz: 'Europe/Berlin' },
      dep: { date: '2026-11-02', time: '09:07' }, arr: { date: '2026-11-02', time: '09:17' },
      carrier: 'BVG', number: '100', mode: 'bus', platform: '2', color: '#a5027d', shape,
    });
    // Looked-up zone for the tram stop; the arrival stop falls back to the search zone.
    expect(fields.legs[1]).toMatchObject({ from: { tz: 'Europe/Berlin' }, to: { tz: 'Europe/London' }, dep: { date: '2026-11-02', time: '23:50' }, arr: { date: '2026-11-02', time: '23:05' }, number: 'M4' });
    expect(fields.legs[1]).not.toHaveProperty('color');
    expect(fields.start).toEqual({ date: '2026-11-02', time: '09:07', tz: 'Europe/Berlin' });
    expect(fields.end).toEqual({ date: '2026-11-02', time: '23:05', tz: 'Europe/London' });
    expect(fields.dayPos[DAY] > 'a0V' && fields.dayPos[DAY] < 'a1').toBe(true);
    expect(decodePolyline(fields.legs[0].shape, 5)[0][1]).toBeCloseTo(52.5163, 4);
  });
  it('lands on the searched day between the two visits', () => {
    const fields = connectionDraft(itinerary, { title: 'A → B', zone: 'Europe/Berlin', dayId: DAY, fromOrder: 'a0V', toOrder: 'a1' });
    const entries = entriesByDay([{ id: 'r1', ...fields }], [day]).get(DAY);
    expect(entries.map((entry) => entry.leg)).toEqual([0, 1]);
  });
  it('leaves the position out when the visits are not in order', () => {
    expect(connectionDraft(itinerary, { title: 'A → B', zone: 'UTC', dayId: DAY, fromOrder: 'a1', toOrder: 'a0V' }).dayPos).toBeUndefined();
    expect(connectionDraft(itinerary, { title: 'A → B', zone: 'UTC', dayId: DAY, fromOrder: 'a1', toOrder: null }).dayPos[DAY] > 'a1').toBe(true);
  });
  it('lists only ride stops without a zone for lookup', () => {
    expect(stopsNeedingZones(itinerary).map((stop) => stop.name)).toEqual(['Hackescher Markt', 'Alexanderplatz']);
  });
});
