// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { newId } from '../../src/shared/ids.js';
import { ROAD_PREFS_ID } from '../../src/shared/schema/trip.js';
import { validateOperation } from '../../src/shared/operations.js';
import { buildSpaceExport, cleanMeta, fromWorkerExport, parseSpaceExport, SPACE_FORMAT } from '../../src/lib/io/space-format.js';
import { batches, duplicateOf, groupCounts, planGeoImport, planSpaceImport, withTracks } from '../../src/lib/io/plan.js';
import { decodeTrack, encodeTrack, trackFileName } from '../../src/lib/io/track-file.js';
import { personalKeys } from '../../src/lib/io/data-export.js';
import { strToU8, gzipSync } from 'fflate';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAROL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const stamps = (id) => ({ id, v: '0000000000001:0000:aaaaaaaaaaaaaaaa', rev: 3, upd: 1, by: BOB, cr: 1 });
const ids = Object.fromEntries(['d1', 'd2', 'p1', 'p2', 'v1', 'v2', 'n1', 'r1', 'r2', 'e1', 's1', 'k1', 'b1', 'g1', 'c1', 'q1', 'o1', 'f1', 'm1', 'x1', 'l1', 't1'].map((key) => [key, newId()]));
const track = { type: 'Feature', properties: { name: 'Ridge', source: 'trk', km: 2 }, geometry: { type: 'LineString', coordinates: [[6.1, 46.1, 500], [6.2, 46.2, 600]] } };

function tripEntities() {
  const e = (key, fields) => ({ ...stamps(ids[key]), ...fields });
  return {
    day: [e('d1', { order: 'a', date: '2026-06-01', title: 'Arrive' }), e('d2', { order: 'b', date: '2026-06-02' })],
    place: [
      e('p1', { name: 'Hotel', lat: 46.2, lng: 6.15, cat: ids.c1, tags: { [ME]: ['mine'], [BOB]: ['bob secret'] }, rating: { [ME]: 4, [BOB]: 2 }, img: { fileId: ids.f1 } }),
      e('p2', { name: 'Ridge walk', lat: 46.1, lng: 6.1, track: { fileId: ids.f1, color: 3, km: 2 } }),
    ],
    cat: [e('c1', { name: 'Stays', color: 2, icon: 'not-an-icon' })],
    guest: [e('g1', { name: 'Tom', color: 3 })],
    visit: [e('v1', { dayId: ids.d1, placeId: ids.p1, order: 'a', people: [ME, BOB, ids.g1], stayId: ids.r1 }), e('v2', { dayId: ids.d2, placeId: ids.p2, order: 'a', endDayId: ids.d1 })],
    dayNote: [e('n1', { dayId: ids.d1, order: 'b', title: 'Check in after 3' })],
    res: [
      e('r1', { type: 'lodging', title: 'Hotel stay', status: 'confirmed', placeId: ids.p1, stay: { fromDayId: ids.d1, toDayId: ids.d2 }, people: [CAROL] }),
      e('r2', { type: 'event', title: 'Concert', status: 'pending', visitId: ids.v2, dayPos: { [ids.d2]: 'c' } }),
    ],
    exp: [e('e1', { name: 'Dinner', amount: 9000, currency: 'EUR', payers: [{ who: BOB, amount: 9000 }], split: { mode: 'equal', parts: [{ who: ME }, { who: BOB }, { who: ids.g1 }] }, links: [{ t: 'place', id: ids.p1 }, { t: 'res', id: newId() }] })],
    settle: [e('s1', { from: ME, to: BOB, amount: 3000, currency: 'EUR' })],
    bag: [e('b1', { name: 'Blue bag', order: 'a', people: [BOB] })],
    pack: [e('k1', { name: 'Charger', order: 'a', bagId: ids.b1, owner: BOB, vis: 'people', for: [BOB], doneBy: { [ME]: true, [BOB]: false } })],
    poll: [e('q1', { question: 'Lunch?', options: ['Yes', 'No'], deadline: 1_000, votes: { [ME]: [0], [BOB]: [1] }, author: BOB })],
    note: [e('o1', { title: 'Ideas', body: 'x', author: ME }), e('x1', { title: 'Bob note', author: BOB })],
    file: [e('f1', { name: 'ridge.geojson.gz', mime: 'application/gzip', size: 10, sha256: 'a'.repeat(64), kind: 'track', loc: { mode: 'proxied' } })],
    msg: [e('m1', { text: 'hello' })],
    link: [e('l1', { title: 'Site', url: 'https://example.com' })],
  };
}

function exported(extra = {}) {
  return buildSpaceExport({
    meta: { ...stamps('meta'), title: 'Geneva', currency: 'EUR', start: '2026-06-01', end: '2026-06-02', share: { on: true }, archived: true, cover: ids.f1 },
    entities: tripEntities(),
    members: [{ uid: ME, name: 'Alice', role: 'owner', color: 1 }, { uid: BOB, name: 'Bob', role: 'editor', color: 4 }],
    uid: ME,
    privateItems: { pack: [{ id: ids.t1, upd: 2, name: 'Passport', order: 'a', private: true }], exp: [] },
    tracks: { [ids.f1]: track },
    source: { space: newId(), rev: 9 },
    now: Date.UTC(2026, 5, 1),
    ...extra,
  });
}

describe('trips-space export file', () => {
  it('drops server stamps, keeps the exporter’s own tags and private items only', () => {
    const data = exported();
    expect(data).toMatchObject({ format: SPACE_FORMAT, version: 1, kind: 'trip', exportedBy: ME });
    const hotel = data.entities.place.find((place) => place.id === ids.p1);
    expect(hotel).not.toHaveProperty('v');
    expect(hotel).not.toHaveProperty('by');
    expect(hotel.tags).toEqual({ [ME]: ['mine'] });
    expect(hotel.rating).toEqual({ [ME]: 4, [BOB]: 2 });
    expect(data.meta).not.toHaveProperty('share');
    expect(data.private.pack).toEqual([{ id: ids.t1, name: 'Passport', order: 'a' }]);
    expect(data.entities.msg[0]).toMatchObject({ text: 'hello', at: 1, by: BOB });
    expect(JSON.stringify(data)).not.toContain('bob secret');
    expect(exported({ includeChat: false }).entities.msg).toBeUndefined();
  });

  it('round-trips through the parser and validates every entity', () => {
    const data = exported();
    data.entities.place.push({ id: newId(), name: '', lat: 1 }, { id: ids.p1, name: 'Duplicate id' }, 'junk');
    data.entities.unknownType = [{ id: newId() }];
    const parsed = parseSpaceExport(JSON.stringify(data));
    expect(parsed.entities.place.map((place) => place.id)).toEqual([ids.p1, ids.p2]);
    expect(parsed.invalid).toMatchObject({ place: 3, unknownType: 1 });
    expect(parsed.meta).toEqual({ title: 'Geneva', currency: 'EUR', start: '2026-06-01', end: '2026-06-02' });
    expect(parsed.tracks[ids.f1].geometry.coordinates).toHaveLength(2);
    expect(parsed.private.pack).toHaveLength(1);
    expect(parsed.members.map((member) => member.name)).toEqual(['Alice', 'Bob']);
    expect(groupCounts(parsed)).toMatchObject({ plan: 5, places: 3, bookings: 2, costs: 2, lists: 2, collab: 4, private: 1, chat: 1, files: 0, tracks: 1 });
  });

  it.each([
    ['{', 'invalid_json'],
    ['[]', 'not_trip_export'],
    [JSON.stringify({ format: 'other' }), 'not_trip_export'],
    [JSON.stringify({ format: SPACE_FORMAT, version: 2, kind: 'trip', meta: { title: 'x', currency: 'EUR' } }), 'newer_version'],
    [JSON.stringify({ format: SPACE_FORMAT, version: 1, kind: 'journey', meta: { title: 'x' } }), 'unsupported_kind'],
    [JSON.stringify({ format: SPACE_FORMAT, version: 1, kind: 'trip', meta: { title: '' } }), 'not_trip_export'],
    [JSON.stringify({ format: SPACE_FORMAT, version: 1, kind: 'trip', meta: { title: 'x', currency: 'EUR' }, entities: { day: Array.from({ length: 1000 }, (_, i) => ({ id: newId(), order: `a${i}1`, date: null })) } }), 'too_many_items'],
  ])('rejects malformed files (%#)', (text, code) => {
    expect(() => parseSpaceExport(text)).toThrow(expect.objectContaining({ code }));
  });

  it('reads the worker’s owner export and keeps meta fields only when valid', () => {
    const raw = { format: 'trips-export', version: 1, space: newId(), rev: 4, kind: 'trip',
      ents: [{ t: 'meta', id: 'meta', title: 'Raw', currency: 'CHF' }, { t: 'member', id: ME, name: 'Alice', role: 'owner' }, { t: 'day', ...stamps(ids.d1), order: 'a', date: null }],
      tombstones: [], members: [{ uuid: ME, role: 'owner', username: 'alice' }] };
    const parsed = parseSpaceExport(raw);
    expect(parsed.meta).toEqual({ title: 'Raw', currency: 'CHF' });
    expect(parsed.entities.day).toHaveLength(1);
    expect(fromWorkerExport(raw, { uid: ME }).members).toEqual([{ id: ME, name: 'Alice', role: 'owner' }]);
    expect(cleanMeta({ title: 'T', currency: 'EUR', start: '2026-01-05', end: '2026-01-01', cover: { url: 'https://x.example/a.jpg' }, archived: true }))
      .toEqual({ title: 'T', currency: 'EUR', start: '2026-01-05', cover: { url: 'https://x.example/a.jpg' } });
  });
});

const isValid = (draft) => { validateOperation({ opId: newId(), ...draft }, { kind: 'trip' }); return true; };

describe('trip import planning', () => {
  const parsed = parseSpaceExport(exported());
  const now = Date.UTC(2026, 5, 1);

  it('creates a new trip with fresh ids, remapped references and members as guests', () => {
    const plan = planSpaceImport(parsed, { uid: ME, now, formerName: (n) => `Former ${n}`, catIcons: ['map-pin', 'bed-double'] });
    const by = (t) => plan.drafts.filter((draft) => draft.t === t);
    const oldIds = new Set(Object.values(ids));
    expect(plan.drafts.every((draft) => !oldIds.has(draft.id) && isValid(draft))).toBe(true);
    const days = by('day'); const places = by('place'); const res = by('res');
    const guestNames = Object.fromEntries(by('guest').map((draft) => [draft.put.name, draft.id]));
    expect(Object.keys(guestNames).sort()).toEqual(['Bob', 'Former 1', 'Tom']);
    const visit = by('visit')[0].put;
    expect(visit.dayId).toBe(days[0].id);
    expect(visit.placeId).toBe(places[0].id);
    expect(visit.stayId).toBe(res[0].id);
    expect(visit.people).toEqual([ME, guestNames.Bob, guestNames.Tom]);
    expect(by('visit')[1].put.endDayId).toBe(days[0].id);
    expect(res[0].put.stay).toEqual({ fromDayId: days[0].id, toDayId: days[1].id });
    expect(res[0].put.people).toEqual([guestNames['Former 1']]);
    expect(res[1].put.dayPos).toEqual({ [days[1].id]: 'c' });
    expect(res[1].put.visitId).toBe(by('visit')[1].id);
    const hotel = places[0].put;
    expect(hotel.cat).toBe(by('cat')[0].id);
    expect(by('cat')[0].put.icon).toBe('map-pin');
    expect(hotel).not.toHaveProperty('img');
    expect(hotel.rating).toEqual({ [ME]: 4 });
    expect(hotel.tags).toEqual({ [ME]: ['mine'] });
    const exp = by('exp')[0].put;
    expect(exp.payers).toEqual([{ who: guestNames.Bob, amount: 9000 }]);
    expect(exp.split.parts.map((part) => part.who)).toEqual([ME, guestNames.Bob, guestNames.Tom]);
    expect(exp.links).toEqual([{ t: 'place', id: places[0].id }]);
    expect(by('settle')[0].put).toMatchObject({ from: ME, to: guestNames.Bob });
    const pack = by('pack')[0].put;
    expect(pack).toMatchObject({ bagId: by('bag')[0].id, for: [guestNames.Bob], doneBy: { [ME]: true } });
    expect(pack).not.toHaveProperty('owner');
    const poll = by('poll')[0].put;
    expect(poll).toMatchObject({ closed: true, votes: { [ME]: [0] } });
    expect(poll).not.toHaveProperty('author');
    expect(by('note').map((draft) => draft.put.author)).toEqual([ME, undefined]);
    expect(plan.tracks).toEqual([{ placeId: places[1].id, fileId: ids.f1, color: 3, km: 2, feature: parsed.tracks[ids.f1] }]);
    expect(places[1].put).not.toHaveProperty('track');
    expect(plan.skipped).toMatchObject({ msg: 1, file: 1 });
    expect(plan.private.pack).toHaveLength(1);
    expect(plan.drafts.findIndex((draft) => draft.t === 'guest')).toBe(0);
  });

  it('merges into an open trip: keeps members, reuses places and guests, orders after existing items', () => {
    const existing = newId();
    const plan = planSpaceImport(parsed, {
      uid: CAROL, mode: 'merge', now, groups: ['plan', 'places', 'costs', 'lists'], can: (action) => action !== 'lists.edit',
      target: { members: [{ uid: BOB }], guests: [{ id: newId(), name: 'tom' }], places: [{ id: existing, name: 'hotel', lat: 46.2004, lng: 6.1503 }], orders: { day: 'm' } },
    });
    const by = (t) => plan.drafts.filter((draft) => draft.t === t);
    expect(plan.deduped).toBe(1);
    expect(by('place').map((draft) => draft.put.name)).toEqual(['Ridge walk']);
    expect(by('visit')[0].put.placeId).toBe(existing);
    expect(by('day').every((draft) => draft.put.order > 'm')).toBe(true);
    expect(by('day')[0].put.order < by('day')[1].put.order).toBe(true);
    expect(by('exp')[0].put.payers[0].who).toBe(BOB);
    expect(by('guest').map((draft) => draft.put.name)).toEqual(['Alice']);
    expect(by('pack')).toEqual([]);
    expect(by('res')).toEqual([]);
    expect(by('visit')[0].put).not.toHaveProperty('stayId');
    expect(plan.skipped).toMatchObject({ pack: 1, bag: 1, res: 2, note: 2, private: 1 });
    expect(plan.drafts.every(isValid)).toBe(true);
  });

  it('exports road-trip settings and imports them under their fixed id with remapped day routes', () => {
    const prefs = { ...stamps(ROAD_PREFS_ID), fuel: 'electric', range: 420, avoid: ['toll'], dayAvoid: { [ids.d2]: ['ferry'], [newId()]: ['motorway'] } };
    const file = parseSpaceExport(exported({ entities: { ...tripEntities(), rtPrefs: [prefs] } }));
    expect(file.entities.rtPrefs).toEqual([{ id: ROAD_PREFS_ID, fuel: 'electric', range: 420, avoid: ['toll'], dayAvoid: prefs.dayAvoid }]);
    const fresh = planSpaceImport(file, { uid: ME, now });
    const day2 = fresh.drafts.filter((draft) => draft.t === 'day')[1].id;
    expect(fresh.drafts.filter((draft) => draft.t === 'rtPrefs')).toEqual([{ t: 'rtPrefs', id: ROAD_PREFS_ID, put: { fuel: 'electric', range: 420, avoid: ['toll'], dayAvoid: { [day2]: ['ferry'] } } }]);
    expect(fresh.created.rtPrefs).toBe(1);
    // A trip with its own settings keeps them and only gains the imported days' routes.
    const merged = planSpaceImport(file, { uid: ME, mode: 'merge', now, target: { rtPrefs: { id: ROAD_PREFS_ID, fuel: 'petrol' } } });
    const mergedDay = merged.drafts.filter((draft) => draft.t === 'day')[1].id;
    expect(merged.drafts.filter((draft) => draft.t === 'rtPrefs')).toEqual([{ t: 'rtPrefs', id: ROAD_PREFS_ID, set: { [`dayAvoid.${mergedDay}`]: ['ferry'] } }]);
    expect(merged.drafts.every(isValid)).toBe(true);
    expect(planSpaceImport(file, { uid: ME, now, groups: ['places'] }).skipped.rtPrefs).toBe(1);
  });

  it('skips expenses whose people cannot be represented', () => {
    const plan = planSpaceImport(parsed, { uid: ME, mode: 'merge', groups: ['costs'], can: (action) => action === 'costs.edit', now });
    expect(plan.drafts.filter((draft) => draft.t === 'exp')).toEqual([]);
    expect(plan.skipped.exp).toBe(1);
  });

  it('adds uploaded tracks and links, and batches drafts', () => {
    const plan = planSpaceImport(parsed, { uid: ME, now });
    const fileId = newId();
    const drafts = withTracks(plan.drafts, plan.tracks, new Map([[ids.f1, fileId]]));
    const place = drafts.find((draft) => draft.id === plan.tracks[0].placeId);
    expect(place.put.track).toEqual({ fileId, color: 3, km: 2 });
    expect(drafts.at(-1)).toEqual({ t: 'file', id: fileId, set: { [`linked.place_${place.id}`]: true } });
    expect(drafts.every(isValid)).toBe(true);
    expect(batches(Array.from({ length: 450 }, (_, i) => i)).map((batch) => batch.length)).toEqual([200, 200, 50]);
  });
});

describe('geo import planning', () => {
  const items = [
    { kind: 'waypoint', format: 'gpx', name: 'Café', lat: 46.5, lng: 6.6, sym: 'Restaurant', web: 'https://x.example' },
    { kind: 'waypoint', format: 'kmz', name: '', lat: 46.6, lng: 6.7, category: 'my stays' },
    { kind: 'track', format: 'gpx', source: 'trk', name: 'Loop', km: 3.2, start: [6.6, 46.5], end: [6.7, 46.6], color: '#ff0000', geometry: { type: 'LineString', coordinates: [[6.6, 46.5], [6.7, 46.6]] } },
  ];
  it('creates places with categories, day visits and track jobs', () => {
    const dayId = newId();
    const plan = planGeoImport(items, [0, 1, 2], { cats: [{ id: 'cat0000000000001', name: 'My stays' }], dayId, dayAfter: 'b', names: { waypoint: (n) => `Waypoint ${n}`, track: (n) => `Track ${n}` } });
    const places = plan.drafts.filter((draft) => draft.t === 'place');
    expect(places.map((draft) => [draft.put.name, draft.put.cat, draft.put.src])).toEqual([['Café', 'restaurant', 'gpx'], ['Waypoint 1', 'cat0000000000001', 'kml'], ['Loop', undefined, 'gpx']]);
    expect(places[2].put).toMatchObject({ lat: 46.5, lng: 6.6 });
    const visits = plan.drafts.filter((draft) => draft.t === 'visit');
    expect(visits.map((draft) => draft.put.placeId)).toEqual(places.map((draft) => draft.id));
    expect(visits.every((draft) => draft.put.dayId === dayId && draft.put.order > 'b')).toBe(true);
    expect(plan.tracks[0]).toMatchObject({ placeId: places[2].id, color: '#ff0000', km: 3.2 });
    const drafts = withTracks(plan.drafts, plan.tracks, new Map([[places[2].id, newId()]]));
    expect(drafts.every(isValid)).toBe(true);
  });
  it('finds duplicates by name and distance', () => {
    const places = [{ id: 'a', name: 'Café', lat: 46.5005, lng: 6.6 }, { id: 'b', name: 'Far café', lat: 40, lng: 6 }];
    expect(duplicateOf({ name: ' café ', lat: 46.5, lng: 6.6 }, places)).toBe('a');
    expect(duplicateOf({ name: 'Café', lat: 46.6, lng: 6.6 }, places)).toBeUndefined();
  });
});

describe('track files and personal keys', () => {
  it('round-trips a track file and rejects malformed ones', () => {
    const bytes = encodeTrack(track);
    expect(decodeTrack(bytes).geometry.coordinates).toEqual(track.geometry.coordinates);
    expect(trackFileName('Ridge walk: day 1')).toBe('ridge-walk-day-1.geojson.gz');
    expect(() => decodeTrack(strToU8('{"type":"Feature"}'))).toThrow(expect.objectContaining({ code: 'invalid_track' }));
    expect(() => decodeTrack(gzipSync(strToU8('not json')))).toThrow(expect.objectContaining({ code: 'invalid_track' }));
    expect(() => decodeTrack(gzipSync(strToU8(JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } }))))).toThrow(expect.objectContaining({ code: 'invalid_track' }));
  });
  it('lists indexed personal keys and never credentials', () => {
    const s = newId(); const tpl = newId(); const wish = newId();
    const keys = personalKeys({ spaces: [{ ref: { s } }, { ref: { s: 'bad' } }], templates: { [tpl]: {} }, buckets: { [wish]: {}, 'not-an-id': {} } });
    expect(keys).toEqual(expect.arrayContaining(['me:prefs', 'me:vault', 'me:buckets', `me:priv:${s}:pack`, `me:priv:${s}:exp`, `me:seen:${s}`, `me:tpl:${tpl}`, `me:bucket:${wish}`]));
    expect(keys.filter((key) => key.startsWith('me:bucket:'))).toEqual([`me:bucket:${wish}`]);
    expect(keys.some((key) => key.startsWith('me:cred'))).toBe(false);
    expect(keys.some((key) => key.includes('bad'))).toBe(false);
  });
});
