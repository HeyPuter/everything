// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildTimeline, indexForTime, placeAt, sortRows, stopNumbers, upcoming } from '../../src/lib/timeline/index.js';

const row = (key, order, time = null, extra = {}) => ({ key, kind: 'visit', id: key, order, time, phase: null, primary: true, ...extra });
const keys = (rows) => rows.map((item) => item.key);
const days = [
  { id: 'd1', order: 'a1', date: '2027-05-01' },
  { id: 'd2', order: 'a2', date: '2027-05-02' },
  { id: 'd3', order: 'a3', date: '2027-05-03' },
  { id: 'u1', order: 'a4', date: null },
];

describe('sortRows', () => {
  it('keeps manual positions and slots unpositioned rows in by time', () => {
    const rows = [row('a', 'a1', '09:00'), row('b', 'a2'), row('c', 'a3', '14:00'),
      row('noon', null, '12:00', { kind: 'res' }), row('early', null, '08:00', { kind: 'res' }),
      row('later', null, null, { kind: 'res' }), row('ongoing', null, null, { kind: 'res', phase: 'middle' }), row('lands', null, null, { kind: 'res', phase: 'end' })];
    expect(keys(sortRows(rows))).toEqual(['ongoing', 'lands', 'early', 'a', 'b', 'noon', 'c', 'later']);
  });
  it('lets manual order win over times on positioned rows', () => {
    expect(keys(sortRows([row('late', 'a1', '18:00'), row('early', 'a2', '07:00')]))).toEqual(['late', 'early']);
  });
  it('puts an unpositioned morning booking above untimed visits at the top of the day', () => {
    const res = (key, time, extra = {}) => row(key, null, time, { kind: 'res', ...extra });
    expect(keys(sortRows([row('v1', 'a1'), row('v2', 'a2', '10:00'), res('train', '08:00')]))).toEqual(['train', 'v1', 'v2']);
    expect(keys(sortRows([row('v1', 'a1'), res('train', '08:00')]))).toEqual(['train', 'v1']);
    expect(keys(sortRows([row('v1', 'a1'), res('dinner', '19:00')]))).toEqual(['v1', 'dinner']);
    expect(keys(sortRows([row('v1', 'a1'), row('v2', 'a2', '07:00'), res('early', '06:30')]))).toEqual(['early', 'v1', 'v2']);
  });
  it('puts arrivals of trips from earlier days first', () => {
    const res = (key, time, extra = {}) => row(key, null, time, { kind: 'res', phase: 'end', ...extra });
    expect(keys(sortRows([row('v1', 'a1', '08:00'), res('lands', '10:00', { family: 'travel' }), res('back', '09:00', { family: 'rental' })]))).toEqual(['lands', 'v1', 'back']);
  });
});

describe('buildTimeline', () => {
  const visits = [
    { id: 'v1', dayId: 'd1', placeId: 'p1', order: 'b', start: '10:00' },
    { id: 'v2', dayId: 'd1', placeId: null, title: 'Hike', order: 'c', endDayId: 'd3', end: '16:00' },
    { id: 'v3', dayId: 'gone', placeId: 'p2', order: 'a' },
  ];
  const notes = [{ id: 'n1', dayId: 'd2', order: 'a', title: 'Rest', time: '20:00' }, { id: 'n2', dayId: 'gone', order: 'a', title: 'Lost' }];
  const reservations = [
    { id: 'f1', type: 'flight', title: 'Night flight', status: 'confirmed', start: { date: '2027-05-01', time: '22:00' }, end: { date: '2027-05-02', time: '06:00' } },
    { id: 'f2', type: 'flight', title: 'Two legs', status: 'confirmed', legs: [
      { from: {}, to: {}, dep: { date: '2027-05-02', time: '09:00' }, arr: { date: '2027-05-02', time: '11:00' } },
      { from: {}, to: {}, dep: { date: '2027-05-02', time: '13:00' }, arr: { date: '2027-05-03', time: '01:00' } },
    ] },
    { id: 'c1', type: 'car', title: 'Rental', status: 'pending', start: { date: '2027-05-01', time: '12:00' }, end: { date: '2027-05-03', time: '09:00' } },
    { id: 'h1', type: 'lodging', title: 'Hotel', status: 'confirmed', start: { date: '2027-05-01' }, end: { date: '2027-05-03' } },
    { id: 't1', type: 'tour', title: 'Walking tour', status: 'confirmed', dayPos: { u1: 'm' } },
  ];
  const timeline = buildTimeline({ days, visits, notes, reservations });
  const at = (dayId) => timeline.byDay.get(dayId).rows.map((item) => [item.key, item.phase]);

  it('merges visits, notes and bookings with phase rows across days', () => {
    expect(at('d1')).toEqual([['visit:v1', null], ['visit:v2', 'start'], ['res:c1', 'start'], ['res:f1', 'start']]);
    expect(at('d2')).toEqual([['res:c1', 'middle'], ['visit:v2:1', 'middle'], ['res:f1', 'end'], ['res:f2:0', null], ['res:f2:1', 'start'], ['note:n1', null]]);
    expect(at('d3')).toEqual([['res:f2:1', 'end'], ['res:c1', 'end'], ['visit:v2:2', 'end']]);
    expect(at('u1')).toEqual([['res:t1', null]]);
    expect(timeline.byDay.get('d3').rows.find((item) => item.key === 'visit:v2:2')).toMatchObject({ time: '16:00', primary: false });
  });

  it('lists stays per day and keeps orphans apart', () => {
    expect(timeline.days.map((entry) => entry.stays.map((stay) => stay.phase))).toEqual([['checkin'], ['night'], ['checkout'], []]);
    expect(timeline.orphans.visits.map((visit) => visit.id)).toEqual(['v3']);
    expect(timeline.orphans.notes.map((note) => note.id)).toEqual(['n2']);
    expect(timeline.days.map((entry) => [entry.number, entry.color])).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
  });

  it('places stays by day references on undated trips', () => {
    const undated = [{ id: 'x1', order: 'a', date: null }, { id: 'x2', order: 'b', date: null }];
    const result = buildTimeline({ days: undated, reservations: [{ id: 'h', type: 'lodging', title: 'Inn', status: 'confirmed', stay: { fromDayId: 'x1', toDayId: 'x2' } }] });
    expect(result.days.map((entry) => entry.stays.map((stay) => stay.phase))).toEqual([['checkin'], ['checkout']]);
  });

  it('numbers located stops in order', () => {
    expect([...stopNumbers(timeline.byDay.get('d1').rows)]).toEqual([['v1', 1]]);
  });
});

describe('placeAt', () => {
  it('puts a key between neighbours and at either end', () => {
    const rows = [row('a', 'a1'), row('b', 'a3')];
    const middle = placeAt(rows, 1, 'd1');
    expect(middle.order > 'a1' && middle.order < 'a3').toBe(true);
    expect(placeAt(rows, 0, 'd1').order < 'a1').toBe(true);
    expect(placeAt(rows, 9, 'd1').order > 'a3').toBe(true);
    expect(middle.writes).toEqual([]);
  });
  it('excludes the moved row and positions unpositioned bookings it passes', () => {
    const rows = [row('a', 'a1'), { ...row('r', null, '12:00'), kind: 'res', id: 'r1' }, row('b', 'a3')];
    const result = placeAt(rows, 1, 'd1', { skip: 'a' });
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]).toMatchObject({ t: 'res', id: 'r1' });
    expect(result.writes[0].set['dayPos.d1'] < result.order && result.order < 'a3').toBe(true);
  });
  it('gives several new items keys in sequence', () => {
    const result = placeAt([row('a', 'a1'), row('b', 'a3')], 1, 'd1', { count: 3 });
    expect(result.orders).toHaveLength(3);
    expect(['a1', ...result.orders, 'a3'].every((key, index, all) => index === 0 || all[index - 1] < key)).toBe(true);
    expect(placeAt([], -1, 'd1', { count: 2 }).orders.every(Boolean)).toBe(true);
  });
  it('skips rows that cannot take a position and renumbers colliding keys', () => {
    const rows = [row('a', 'a1'), row('cont', null, null, { primary: false, phase: 'middle' }), row('b', 'a1')];
    const result = placeAt(rows, 2, 'd1');
    const orders = Object.fromEntries(result.writes.map((write) => [write.id, write.set.order]));
    expect(orders.a < result.order && result.order < orders.b).toBe(true);
    expect(orders).not.toHaveProperty('cont');
  });
});

describe('indexForTime and upcoming', () => {
  it('finds the slot for a time', () => {
    const rows = [row('a', 'a1', '09:00'), row('b', 'a2'), row('c', 'a3', '14:00')];
    expect(indexForTime(rows, '12:00')).toBe(2);
    expect(indexForTime(rows, '07:00')).toBe(0);
    expect(indexForTime(rows, null)).toBe(3);
    expect(indexForTime(rows, '15:00', { skip: 'c' })).toBe(2);
    expect(indexForTime([row('a', 'a1'), row('b', 'a2')], '07:30')).toBe(0);
    expect(indexForTime([row('a', 'a1'), row('b', 'a2')], '12:00')).toBe(2);
  });
  it('lists the next timed items across days from now', () => {
    const timeline = buildTimeline({ days, visits: [
      { id: 'v1', dayId: 'd1', placeId: null, title: 'Past', order: 'a', start: '08:00' },
      { id: 'v2', dayId: 'd2', placeId: null, title: 'Soon', order: 'a', start: '09:00' },
      { id: 'v3', dayId: 'd1', placeId: null, title: 'Tonight', order: 'b', start: '21:00' },
      { id: 'v4', dayId: 'u1', placeId: null, title: 'Undated', order: 'a', start: '10:00' },
    ] });
    expect(upcoming(timeline, { now: '2027-05-01T12:00' }).map((item) => item.row.id)).toEqual(['v3', 'v2']);
    expect(upcoming(timeline, { now: '2027-05-01T00:00', limit: 1 }).map((item) => item.row.id)).toEqual(['v1']);
  });
});
