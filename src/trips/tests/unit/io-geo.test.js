import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { readGeoFile, detectFormat } from '../../src/lib/io/geo-import.js';
import { tripGeo, toGpx, toKml, toKmz } from '../../src/lib/io/geo-export.js';
import { simplifySegments, lengthKm } from '../../src/lib/io/geo.js';
import { htmlToText, slug } from '../../src/lib/io/text.js';

const fixture = (name) => new Uint8Array(readFileSync(join(process.cwd(), 'tests/unit/fixtures/io', name)));
const bytes = (text) => strToU8(text);

describe('GPX import', () => {
  const result = readGeoFile({ name: 'hike.gpx', bytes: fixture('hike.gpx') });

  it('reads waypoints with names, comments, links and symbols', () => {
    expect(result.format).toBe('gpx');
    const waypoints = result.items.filter((item) => item.kind === 'waypoint');
    expect(waypoints.map((item) => item.name)).toEqual(['Café & Bakery', 'Viewpoint', '']);
    expect(waypoints[0]).toMatchObject({ lat: 46.5197, lng: 6.6323, sym: 'Restaurant', web: 'https://example.com/cafe' });
    expect(waypoints[0].desc).toContain('Fresh <b>croissants</b>');
    expect(waypoints[0].desc).toContain('Rue du Lac 1');
    expect(waypoints[2].web).toBeUndefined();
    expect(result.skipped.invalid).toBe(1);
  });

  it('reads tracks and routes with start, end, length and colour', () => {
    const tracks = result.items.filter((item) => item.kind === 'track');
    expect(tracks.map((item) => [item.name, item.source])).toEqual([['Morning loop', 'trk'], ['Garmin colour', 'trk'], ['Ferry', 'rte']]);
    const loop = tracks[0];
    expect(loop.geometry.type).toBe('MultiLineString');
    expect(loop.start).toEqual([6.6, 46.5]);
    expect(loop.end).toEqual([6.62, 46.52]);
    expect(loop.color).toBe('#ff0000');
    expect(loop.km).toBeGreaterThan(1.5);
    expect(loop.geometry.coordinates[0][0]).toEqual([6.6, 46.5, 380.3]);
    expect(tracks[1].color).toBe(7);
    expect(tracks[2].geometry.type).toBe('LineString');
  });
});

describe('KML and KMZ import', () => {
  it('reads placemarks, folders, multi-geometry, styles and gx:Track, skipping polygons', () => {
    const { format, items, skipped } = readGeoFile({ name: 'city.kml', bytes: fixture('city.kml') });
    expect(format).toBe('kml');
    const hall = items.find((item) => item.name === 'Old Town Hall');
    expect(hall).toMatchObject({ kind: 'waypoint', lat: 50.0875, lng: 14.4207, address: 'Main Square 1', category: 'attraction' });
    expect(hall.desc).toBe('Built in 1420.\nTours daily & free');
    expect(items.filter((item) => item.name === 'Market').map((item) => item.kind).sort()).toEqual(['track', 'waypoint']);
    expect(items.find((item) => item.name === 'River path')).toMatchObject({ kind: 'track', color: '#ff0000' });
    expect(items.find((item) => item.name === 'GPS log')).toMatchObject({ kind: 'track', start: [14.42, 50.08] });
    expect(skipped).toMatchObject({ shapes: 1, empty: 1 });
  });

  it('reads doc.kml from a KMZ and refuses archives without KML', () => {
    const kmz = zipSync({ 'files/icon.png': new Uint8Array([1, 2, 3]), 'doc.kml': fixture('city.kml') });
    expect(detectFormat('trip.kmz', kmz)).toBe('kmz');
    expect(readGeoFile({ name: 'trip.kmz', bytes: kmz }).items.length).toBeGreaterThan(3);
    const empty = zipSync({ 'readme.txt': bytes('hi') });
    expect(() => readGeoFile({ name: 'x.kmz', bytes: empty })).toThrow(expect.objectContaining({ code: 'invalid_kmz' }));
    expect(() => readGeoFile({ name: 'x.kmz', bytes: bytes('PK\u0003\u0004garbage') })).toThrow(expect.objectContaining({ code: 'invalid_kmz' }));
  });

  it.each([
    ['empty.gpx', '', 'file_empty'],
    ['notes.txt', 'hello', 'unsupported_format'],
    ['bad.gpx', '<gpx><wpt></gpx>', 'invalid_xml'],
    ['html.gpx', '<html><body/></html>', 'unsupported_format'],
    ['none.gpx', '<gpx version="1.1"><metadata/></gpx>', 'no_features'],
  ])('rejects %s', (name, text, code) => {
    expect(() => readGeoFile({ name, bytes: bytes(text) })).toThrow(expect.objectContaining({ code }));
  });

  it('detects the format from content and honours a declared encoding', () => {
    const latin = new Uint8Array([...bytes('<?xml version="1.0" encoding="ISO-8859-1"?><gpx><wpt lat="1" lon="2"><name>Z'), 0xfc, ...bytes('rich</name></wpt></gpx>')]);
    const result = readGeoFile({ name: 'export', bytes: latin });
    expect(result.items[0].name).toBe('Zürich');
  });
});

describe('geometry helpers', () => {
  it('thins dense tracks under the point cap and keeps the ends', () => {
    const line = Array.from({ length: 50_000 }, (_, i) => [6 + i * 0.00001, 46 + Math.sin(i / 50) * 0.001]);
    const [thin] = simplifySegments([line], 2_000);
    expect(thin.length).toBeLessThanOrEqual(2_000);
    expect(thin[0]).toEqual(line[0]);
    expect(thin.at(-1)).toEqual(line.at(-1));
    expect(lengthKm([[[0, 0], [0, 1]]])).toBeCloseTo(111.19, 1);
  });

  it('turns HTML into text without markup and makes file stems', () => {
    expect(htmlToText('<p>a<br>b</p><style>x{}</style><img src=x onerror=1>&nbsp;c &lt;d&gt;')).toBe('a\nb\nc <d>');
    expect(slug('Ünïcode Trip: Zürich → Bern!')).toBe('unicode-trip-zurich-bern');
    expect(slug('***')).toBe('trip');
  });
});

const trip = {
  places: [
    { id: 'p1', name: 'Hotel Rive', lat: 46.2, lng: 6.15, cat: 'hotel', web: 'https://hotel.example', address: 'Quai 1', desc: 'Lake view' },
    { id: 'p2', name: 'Jet d\'eau', lat: 46.207, lng: 6.155, cat: 'c1' },
    { id: 'p3', name: 'Salève hike', lat: 46.1, lng: 6.2, track: { fileId: 'f1', color: '#00aa00', km: 3 } },
    { id: 'p4', name: 'No location' },
  ],
  days: [{ id: 'd1', order: 'a', date: '2026-06-01' }, { id: 'd2', order: 'b', date: '2026-06-02' }],
  visits: [
    { id: 'v1', dayId: 'd1', placeId: 'p2', order: 'a' },
    { id: 'v2', dayId: 'd1', placeId: 'p3', order: 'b' },
    { id: 'v3', dayId: 'd2', placeId: null, title: 'Free time', order: 'a' },
  ],
  reservations: [],
  notes: [],
};
const tracks = new Map([['f1', { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[6.2, 46.1, 500], [6.21, 46.11, 900]] } }]]);
const category = (place) => (place.cat === 'hotel' ? { id: 'hotel', name: 'Hotel', color: 5 } : place.cat === 'c1' ? { id: 'c1', name: 'Fountains' } : null);
const resolveColor = (value) => (value === 5 ? '#4f52c9' : typeof value === 'string' ? value : null);

describe('GPX and KML export', () => {
  it('collects waypoints, day routes and tracks per scope', () => {
    const all = tripGeo(trip, { tracks, category, dayName: (entry) => `Day ${entry.number}` });
    expect(all.waypoints.map((item) => item.name)).toEqual(['Hotel Rive', 'Jet d\'eau']);
    expect(all.tracks.map((item) => item.name)).toEqual(['Salève hike']);
    expect(all.routes).toEqual([{ name: 'Day 1', points: [{ name: 'Jet d\'eau', lat: 46.207, lng: 6.155 }, { name: 'Salève hike', lat: 46.1, lng: 6.2 }] }]);
    const places = tripGeo(trip, { scope: 'places', tracks, category });
    expect(places.waypoints).toHaveLength(3);
    expect(places.routes).toEqual([]);
    expect(tripGeo(trip, { scope: 'days', tracks, category }).waypoints).toEqual([]);
  });

  it('round-trips GPX with symbols, links, routes and track colours', () => {
    const geo = tripGeo(trip, { tracks, category, dayName: (entry) => `Day ${entry.number}` });
    const text = toGpx(geo, { name: 'Geneva & lake', resolveColor });
    expect(text).toContain('<sym>Lodging</sym>');
    expect(text).toContain('<sym>Fountains</sym>');
    expect(text.indexOf('<rte>')).toBeLessThan(text.indexOf('<trk>'));
    const back = readGeoFile({ name: 'out.gpx', bytes: bytes(text) });
    const hotel = back.items.find((item) => item.name === 'Hotel Rive');
    expect(hotel).toMatchObject({ lat: 46.2, lng: 6.15, sym: 'Lodging', type: 'Hotel', web: 'https://hotel.example' });
    expect(hotel.desc).toContain('Lake view');
    expect(back.items.find((item) => item.name === 'Salève hike')).toMatchObject({ kind: 'track', color: '#00aa00', source: 'trk' });
    expect(back.items.find((item) => item.name === 'Day 1')).toMatchObject({ kind: 'track', source: 'rte', start: [6.155, 46.207] });
  });

  it('round-trips KML and KMZ with categories, colours and folders', () => {
    const geo = tripGeo(trip, { tracks, category, dayName: (entry) => `Day ${entry.number}` });
    const text = toKml(geo, { name: 'Geneva <lake>', resolveColor, labels: { places: 'Places', days: 'Days', tracks: 'Tracks' } });
    expect(text).toContain('<name>Geneva &lt;lake&gt;</name>');
    const back = readGeoFile({ name: 'out.kml', bytes: bytes(text) });
    expect(back.items.find((item) => item.name === 'Hotel Rive')).toMatchObject({ category: 'Hotel', address: 'Quai 1' });
    expect(back.items.find((item) => item.name === 'Salève hike')).toMatchObject({ kind: 'track', color: '#00aa00' });
    const kmz = readGeoFile({ name: 'out.kmz', bytes: toKmz(text) });
    expect(kmz.format).toBe('kmz');
    expect(kmz.items).toHaveLength(back.items.length);
  });
});
