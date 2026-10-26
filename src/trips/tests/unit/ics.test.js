// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  durationValue, escapeText, foldLine, offsetValue, serializeCalendar, transitions, tripCalendar, tripData, tripEvents, vtimezone,
} from '../../src/lib/ics/index.js';

const STAMP = Date.UTC(2027, 0, 15, 8, 0, 0);
const ME = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';
const encoder = new TextEncoder();

const unfold = (text) => text.replace(/\r\n[ \t]/g, '');
const lines = (text) => unfold(text).split('\r\n');
/** VEVENT property maps by UID, with VALARM triggers collected under `alarms`. */
function events(text) {
  const out = {};
  let current = null;
  let depth = 0;
  for (const line of lines(text)) {
    if (line === 'BEGIN:VEVENT') { current = { alarms: [] }; continue; }
    if (line === 'END:VEVENT') { out[current.UID] = current; current = null; continue; }
    if (!current) continue;
    if (line === 'BEGIN:VALARM') { depth++; continue; }
    if (line === 'END:VALARM') { depth--; continue; }
    const colon = line.indexOf(':');
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (depth) { if (name === 'TRIGGER') current.alarms.push(value); continue; }
    current[name] = value;
  }
  return out;
}
const uid = (kind, id, suffix = '') => `s1-${kind}${id ? `-${id}` : ''}${suffix}@trips.puter.com`;
const build = (data, options = {}) => tripCalendar(data, { space: 's1', stamp: STAMP, member: ME, ...options });

describe('ICS text', () => {
  it('escapes text and drops control characters', () => {
    expect(escapeText('a, b; c\\d')).toBe('a\\, b\\; c\\\\d');
    expect(escapeText('one\r\ntwo\rthree\nfour')).toBe('one\\ntwo\\nthree\\nfour');
    expect(escapeText('x\u0000\u0007\u000b\u001f\u007fy\tz')).toBe('xy\tz');
    expect(escapeText('bad \uD800 pair')).toBe('bad � pair');
    expect(escapeText('abcdefgh', 5)).toBe('abcd…');
    expect(escapeText('😀😀😀', 2)).toBe('😀…');
  });

  it('folds at 75 octets without splitting characters', () => {
    const ascii = `SUMMARY:${'a'.repeat(200)}`;
    const folded = foldLine(ascii);
    expect(folded.split('\r\n').every((line) => encoder.encode(line).length <= 75)).toBe(true);
    expect(folded.split('\r\n').slice(1).every((line) => line.startsWith(' '))).toBe(true);
    expect(unfold(folded)).toBe(ascii);
    const wide = `SUMMARY:${'é😀日'.repeat(40)}`;
    const parts = foldLine(wide).split('\r\n');
    expect(parts.every((line) => encoder.encode(line).length <= 75)).toBe(true);
    expect(parts.join('')).not.toContain('�');
    expect(unfold(foldLine(wide))).toBe(wide);
    expect(foldLine('SHORT:1')).toBe('SHORT:1');
  });

  it('writes durations and offsets', () => {
    expect(durationValue(0)).toBe('PT0S');
    expect(durationValue(-90)).toBe('-PT1H30M');
    expect(durationValue(-1440)).toBe('-P1D');
    expect(durationValue(-2340)).toBe('-P1DT15H');
    expect(durationValue(540)).toBe('PT9H');
    expect(offsetValue(0)).toBe('+0000');
    expect(offsetValue(-210)).toBe('-0330');
    expect(offsetValue(345)).toBe('+0545');
  });

  it('keeps every line short and ends with CRLF', () => {
    const text = serializeCalendar({ name: `Long ${'名前'.repeat(60)}`, stamp: STAMP, events: [{ uid: 'u', summary: 'é'.repeat(300), start: { date: '2027-01-01' } }] });
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text.split('\r\n').every((line) => encoder.encode(line).length <= 75)).toBe(true);
    expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
  });
});

describe('ICS time zones', () => {
  it('finds DST changes to the minute', () => {
    const lisbon = transitions('Europe/Lisbon', Date.UTC(2027, 2, 1), Date.UTC(2027, 10, 30));
    expect(lisbon.initial).toBe(0);
    expect(lisbon.transitions).toEqual([
      { at: Date.UTC(2027, 2, 28, 1), from: 0, to: 60 },
      { at: Date.UTC(2027, 9, 31, 1), from: 60, to: 0 },
    ]);
    expect(transitions('Asia/Tokyo', Date.UTC(2027, 0, 1), Date.UTC(2027, 11, 31))).toEqual({ initial: 540, transitions: [] });
    expect(transitions('Asia/Kolkata', Date.UTC(2027, 0, 1), Date.UTC(2027, 0, 2)).initial).toBe(330);
  });

  it('writes VTIMEZONE observances with local start times', () => {
    const ny = vtimezone('America/New_York', Date.UTC(2027, 10, 1), Date.UTC(2027, 10, 20));
    expect(ny).toEqual([
      'BEGIN:VTIMEZONE', 'TZID:America/New_York',
      'BEGIN:DAYLIGHT', 'DTSTART:19700101T000000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0400', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'DTSTART:20271107T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD',
      'END:VTIMEZONE',
    ]);
    // Southern hemisphere: April is the end of daylight time.
    const sydney = vtimezone('Australia/Sydney', Date.UTC(2027, 3, 1), Date.UTC(2027, 3, 10));
    expect(sydney).toContain('BEGIN:DAYLIGHT');
    expect(sydney.slice(-6)).toEqual(['BEGIN:STANDARD', 'DTSTART:20270404T030000', 'TZOFFSETFROM:+1100', 'TZOFFSETTO:+1000', 'END:STANDARD', 'END:VTIMEZONE']);
    expect(vtimezone('Not/AZone', 0, 1)).toEqual([]);
  });

  it('writes TZID times with one VTIMEZONE per zone, or UTC on request', () => {
    const event = (id, tz, time = '10:00') => ({ uid: id, summary: id, start: { date: '2027-05-01', time, tz }, end: { date: '2027-05-01', time: '11:30', tz } });
    const list = [event('a', 'Europe/Lisbon'), event('b', 'Europe/Lisbon'), event('c', 'Asia/Tokyo'), event('d', null)];
    const text = serializeCalendar({ events: list, stamp: STAMP });
    expect(text.match(/BEGIN:VTIMEZONE/g)).toHaveLength(2);
    expect(text.indexOf('TZID:Asia/Tokyo')).toBeLessThan(text.indexOf('TZID:Europe/Lisbon'));
    const parsed = events(text);
    expect(parsed.a['DTSTART;TZID=Europe/Lisbon']).toBe('20270501T100000');
    expect(parsed.a['DTEND;TZID=Europe/Lisbon']).toBe('20270501T113000');
    expect(parsed.d.DTSTART).toBe('20270501T100000');
    const utc = events(serializeCalendar({ events: list, stamp: STAMP, zones: 'utc' }));
    expect(utc.a.DTSTART).toBe('20270501T090000Z');
    expect(utc.c.DTSTART).toBe('20270501T010000Z');
    expect(utc.d.DTSTART).toBe('20270501T100000');
    expect(serializeCalendar({ events: list, zones: 'utc' })).not.toContain('VTIMEZONE');
  });

  it('treats an invalid zone as floating', () => {
    const text = serializeCalendar({ stamp: STAMP, events: [{ uid: 'x', summary: 'x', start: { date: '2027-05-01', time: '10:00', tz: 'Mars/Base;X=1' } }] });
    expect(text).toContain('DTSTART:20270501T100000\r\n');
    expect(text).not.toContain('Mars');
  });
});

const TRIP = Object.freeze({
  meta: { title: 'Lisbon, Porto', start: '2027-05-01', end: '2027-05-03', reminderDays: [7, 1, 1, 400], upd: STAMP - 5000 },
  day: [
    { id: 'd2', order: 'b', date: '2027-05-02' },
    { id: 'd1', order: 'a', date: '2027-05-01', title: 'Arrive' },
    { id: 'd3', order: 'c', date: '2027-05-03' },
  ],
  place: [
    { id: 'p1', name: 'Belém Tower', address: 'Av. Brasília, Lisboa', tz: 'Europe/Lisbon' },
    { id: 'p2', name: 'Livraria', tz: 'Europe/Lisbon' },
  ],
  visit: [
    { id: 'v1', dayId: 'd1', placeId: 'p1', order: 'a', start: '10:00', end: '11:30' },
    { id: 'v2', dayId: 'd1', order: 'b', title: 'Lunch' },
    { id: 'v3', dayId: 'd1', order: 'c', title: 'Coffee', start: '15:00', dwell: 20 },
    { id: 'v4', dayId: 'd2', placeId: 'p2', order: 'a', start: '23:00', end: '01:00' },
    { id: 'v5', dayId: 'd2', order: 'b', title: 'Walk', start: '09:00' },
    { id: 'v6', dayId: 'd3', order: 'a', title: 'Fado', start: '20:00', end: '19:00', endDayId: 'd3' },
    { id: 'gone', dayId: 'd1', order: 'z', title: 'Removed', start: '12:00', deleted: true },
  ],
  res: [
    {
      id: 'r1', type: 'flight', status: 'confirmed', title: '', code: 'SECRET1', notes: 'gate code 4411',
      legs: [
        { from: { code: 'JFK', name: 'John F. Kennedy', tz: 'America/New_York' }, to: { code: 'LIS', tz: 'Europe/Lisbon' }, dep: { date: '2027-04-30', time: '22:00' }, arr: { date: '2027-05-01', time: '10:00' }, carrier: 'TP', number: '202', seat: '12A' },
        { from: { code: 'LIS', tz: 'Europe/Lisbon' }, to: { code: 'OPO', tz: 'Europe/Lisbon' }, dep: { date: '2027-05-01', time: '12:00' }, arr: { date: '2027-05-01', time: '12:55' } },
      ],
    },
    { id: 'r2', type: 'flight', title: 'Home', legs: [{ from: { code: 'LIS', tz: 'Europe/Lisbon' }, to: { code: 'JFK', tz: 'America/New_York' }, dep: { date: '2027-05-03', time: '15:00' }, arr: { date: '2027-05-03', time: '17:30' } }] },
    { id: 'r3', type: 'lodging', title: 'Hotel Sol', start: { date: '2027-05-01', time: '15:00' }, end: { date: '2027-05-03', time: '11:00' }, location: { name: 'Hotel Sol', address: 'Rua 1, Lisboa' } },
    { id: 'r4', type: 'restaurant', title: 'Dinner', start: { date: '2027-05-02', time: '20:00' }, location: { name: 'Tasca' } },
    { id: 'r5', type: 'tour', title: 'Cancelled tour', status: 'cancelled', start: { date: '2027-05-02', time: '10:00' } },
    { id: 'r6', type: 'event', title: 'Festival', start: { date: '2027-05-02' }, end: { date: '2027-05-03' } },
    { id: 'r7', type: 'train', title: 'Train', legs: [{ from: { name: 'Porto' }, to: { name: 'Braga' }, dep: { date: '2027-05-03' }, arr: { date: '2027-05-03' } }] },
  ],
  todo: [
    { id: 't1', name: 'Buy tickets', due: '2027-04-20' },
    { id: 't2', name: 'Theirs', due: '2027-04-21', who: OTHER },
    { id: 't3', name: 'Mine', due: '2027-04-22', who: ME },
    { id: 't4', name: 'Done', due: '2027-04-23', done: true },
    { id: 't5', name: 'No date' },
    { id: 't6', name: 'Team list', due: '2027-04-24', list: 'Bob stuff' },
  ],
  listMeta: [{ id: 'l1', kind: 'todo', name: 'bob  STUFF', assignees: [OTHER] }],
});

describe('trip calendar', () => {
  it('spans the trip as an all-day event with reminders from the trip settings', () => {
    const trip = events(build(TRIP))[uid('trip')];
    expect(trip['DTSTART;VALUE=DATE']).toBe('20270501');
    expect(trip['DTEND;VALUE=DATE']).toBe('20270504');
    expect(trip.SUMMARY).toBe('Lisbon\\, Porto');
    expect(trip.TRANSP).toBe('TRANSPARENT');
    expect(trip.DTSTAMP).toBe('20270115T080000Z');
    expect(trip['LAST-MODIFIED']).toBe('20270115T075955Z');
    // 09:00 one and seven days before; duplicates and out-of-range values are dropped.
    expect(trip.alarms).toEqual(['-PT15H', '-P6DT15H']);
  });

  it('places timed visits in their zone with their real length', () => {
    const parsed = events(build(TRIP));
    expect(parsed[uid('visit', 'v1')]).toMatchObject({
      'DTSTART;TZID=Europe/Lisbon': '20270501T100000', 'DTEND;TZID=Europe/Lisbon': '20270501T113000', SUMMARY: 'Belém Tower', LOCATION: 'Av. Brasília\\, Lisboa',
    });
    // Dwell gives the length; a free-form visit borrows the day's zone.
    expect(parsed[uid('visit', 'v3')]).toMatchObject({ 'DTSTART;TZID=Europe/Lisbon': '20270501T150000', 'DTEND;TZID=Europe/Lisbon': '20270501T152000' });
    // An end before the start without an end day runs past midnight.
    expect(parsed[uid('visit', 'v4')]['DTEND;TZID=Europe/Lisbon']).toBe('20270503T010000');
    // No end and no dwell: one hour.
    expect(parsed[uid('visit', 'v5')]['DTEND;TZID=Europe/Lisbon']).toBe('20270502T100000');
    // An end before the start on the same end day is ignored.
    expect(parsed[uid('visit', 'v6')]['DTEND;TZID=Europe/Lisbon']).toBe('20270503T210000');
    expect(parsed[uid('visit', 'gone')]).toBeUndefined();
    expect(parsed[uid('visit', 'v2')]).toBeUndefined();
  });

  it('adds a day event per dated day listing untimed items, unless turned off', () => {
    const parsed = events(build(TRIP));
    expect(parsed[uid('day', 'd1')]).toMatchObject({ SUMMARY: 'Day 1: Arrive', DESCRIPTION: 'Lunch', 'DTSTART;VALUE=DATE': '20270501', 'DTEND;VALUE=DATE': '20270502' });
    expect(parsed[uid('day', 'd2')].SUMMARY).toBe('Day 2');
    const labels = { day: (number, title) => `Tag ${number}${title ? ` – ${title}` : ''}` };
    expect(events(build(TRIP, { labels }))[uid('day', 'd1')].SUMMARY).toBe('Tag 1 – Arrive');
    expect(Object.keys(events(build(TRIP, { days: false }))).some((key) => key.includes('-day-'))).toBe(false);
  });

  it('writes each leg in its endpoint zones and alarms only the first timed leg', () => {
    const parsed = events(build(TRIP));
    const first = parsed[uid('res', 'r1', '-0')];
    expect(first).toMatchObject({
      'DTSTART;TZID=America/New_York': '20270430T220000', 'DTEND;TZID=Europe/Lisbon': '20270501T100000',
      SUMMARY: 'TP 202 · JFK → LIS', LOCATION: 'John F. Kennedy', STATUS: 'CONFIRMED',
    });
    expect(first.alarms).toEqual(['-PT3H']);
    const second = parsed[uid('res', 'r1', '-1')];
    expect(second.SUMMARY).toBe('LIS → OPO');
    expect(second.alarms).toEqual([]);
    // East to west: lands at an earlier local time than it left, and stays valid.
    const home = parsed[uid('res', 'r2', '-0')];
    expect(home).toMatchObject({ 'DTSTART;TZID=Europe/Lisbon': '20270503T150000', 'DTEND;TZID=America/New_York': '20270503T173000', SUMMARY: 'Home', DESCRIPTION: 'LIS → JFK' });
    expect(home.STATUS).toBeUndefined();
    const train = parsed[uid('res', 'r7', '-0')];
    expect(train).toMatchObject({ 'DTSTART;VALUE=DATE': '20270503', 'DTEND;VALUE=DATE': '20270504', SUMMARY: 'Train', DESCRIPTION: 'Porto → Braga' });
  });

  it('writes stays as all-day spans and skips cancelled bookings', () => {
    const parsed = events(build(TRIP));
    expect(parsed[uid('res', 'r3')]).toMatchObject({
      'DTSTART;VALUE=DATE': '20270501', 'DTEND;VALUE=DATE': '20270504', SUMMARY: 'Hotel Sol', LOCATION: 'Rua 1\\, Lisboa',
      DESCRIPTION: 'Check-in 15:00\\nCheck-out 11:00', TRANSP: 'TRANSPARENT',
    });
    expect(parsed[uid('res', 'r3')].alarms).toEqual([]);
    expect(parsed[uid('res', 'r4')]).toMatchObject({ 'DTSTART;TZID=Europe/Lisbon': '20270502T200000', 'DTEND;TZID=Europe/Lisbon': '20270502T210000', LOCATION: 'Tasca' });
    expect(parsed[uid('res', 'r4')].alarms).toEqual(['-PT1H']);
    expect(parsed[uid('res', 'r5')]).toBeUndefined();
    expect(parsed[uid('res', 'r6')]).toMatchObject({ 'DTSTART;VALUE=DATE': '20270502', 'DTEND;VALUE=DATE': '20270504' });
  });

  it('places a stay by its days when both are set', () => {
    const data = { ...TRIP, res: [{ id: 's', type: 'lodging', title: 'Flat', start: { date: '2027-04-01' }, stay: { fromDayId: 'd2', toDayId: 'd3' } }] };
    expect(events(build(data))[uid('res', 's')]).toMatchObject({ 'DTSTART;VALUE=DATE': '20270502', 'DTEND;VALUE=DATE': '20270504' });
  });

  it('lists the member’s open to-dos with a reminder on the due morning', () => {
    const parsed = events(build(TRIP));
    const todos = Object.values(parsed).filter((event) => event.UID.includes('-todo-'));
    expect(todos.map((event) => event.SUMMARY).sort()).toEqual(['To-do: Buy tickets', 'To-do: Mine']);
    expect(parsed[uid('todo', 't1')]).toMatchObject({ 'DTSTART;VALUE=DATE': '20270420', 'DTEND;VALUE=DATE': '20270421', alarms: ['PT9H'] });
    const all = tripEvents(TRIP, { space: 's1' }).filter((event) => event.uid.includes('-todo-'));
    expect(all).toHaveLength(4);
  });

  it('leaves alarms out on request', () => {
    expect(build(TRIP, { alarms: false })).not.toContain('VALARM');
  });

  it('keeps private and per-person details out', () => {
    const text = build(TRIP);
    expect(text).not.toMatch(/SECRET1|4411|12A/);
  });

  it('is stable for the same data and stamp', () => {
    expect(build(TRIP)).toBe(build(structuredClone(TRIP)));
    const ids = Object.keys(events(build(TRIP)));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('falls back to the trip zone, then floating time', () => {
    const data = { meta: { title: 'T', settings: { homeTz: 'Asia/Tokyo' } }, day: [{ id: 'd', order: 'a', date: '2027-05-01' }], visit: [{ id: 'v', dayId: 'd', order: 'a', title: 'X', start: '08:00' }] };
    expect(events(build(data))[uid('visit', 'v')]['DTSTART;TZID=Asia/Tokyo']).toBe('20270501T080000');
    const floating = events(build({ ...data, meta: { title: 'T' } }))[uid('visit', 'v')];
    expect(floating.DTSTART).toBe('20270501T080000');
    expect(floating.DTEND).toBe('20270501T090000');
  });

  it('keeps a real hour across a DST change', () => {
    const data = { meta: {}, day: [{ id: 'd', order: 'a', date: '2027-03-28' }], place: [{ id: 'p', name: 'P', tz: 'Europe/Lisbon' }], visit: [{ id: 'v', dayId: 'd', placeId: 'p', order: 'a', start: '00:30' }] };
    // 00:30 plus one hour lands after the 01:00 → 02:00 jump.
    expect(events(build(data))[uid('visit', 'v')]['DTEND;TZID=Europe/Lisbon']).toBe('20270328T023000');
  });

  it('writes nothing for an undated trip', () => {
    const text = build({ meta: { title: 'Someday' }, day: [{ id: 'd', order: 'a', date: null }], visit: [{ id: 'v', dayId: 'd', order: 'a', start: '10:00', title: 'X' }] });
    expect(text).not.toContain('BEGIN:VEVENT');
    expect(text).toContain('X-WR-CALNAME:Someday');
  });

  it('groups snapshot entities by type', () => {
    const data = tripData([{ t: 'meta', id: 'meta', title: 'A' }, { t: 'day', id: 'd' }, { t: 'msg', id: 'm' }, { t: 'visit', id: 'v', deleted: true }, null]);
    expect(data.meta.title).toBe('A');
    expect(data.day).toHaveLength(1);
    expect(data.visit).toHaveLength(0);
    expect(data.msg).toBeUndefined();
  });
});
