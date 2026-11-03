// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { validateEntity } from '../../src/shared/schema/index.js';
import {
  appendOrders, copySaved, exportGpx, exportJson, filterSaved, fromPlace, gpxFields, moveOrder, orderCollections, parseGpx, parseJson,
  samePlace, sortSaved, toPlace,
} from '../../src/views/collections/model.js';

const ME = '11111111-1111-4111-8111-111111111111';
const YOU = '22222222-2222-4222-8222-222222222222';
const TRIP = { w: 'trips-abcdefghij', s: '0123456789abcdef', k: 'trip' };
const placeId = '0123456789abcdeg';

describe('matching places', () => {
  it('matches by shared ids, or the same name within 100 m, ignoring case and accents', () => {
    expect(samePlace({ name: 'A', ids: { osm: 'node/1' } }, { name: 'B', ids: { osm: 'node/1' } })).toBe(true);
    expect(samePlace({ name: 'Café Nicola', lat: 38.7139, lng: -9.1396 }, { name: 'cafe  nicola', lat: 38.7142, lng: -9.1398 })).toBe(true);
    expect(samePlace({ name: 'Café Nicola', lat: 38.7139, lng: -9.1396 }, { name: 'Café Nicola', lat: 38.72, lng: -9.1396 })).toBe(false);
    expect(samePlace({ name: 'Bar', address: 'Rua 1' }, { name: 'bar', address: 'rua 1' })).toBe(true);
    expect(samePlace({ name: 'Bar', lat: 1, lng: 1 }, { name: 'Bar' })).toBe(false);
  });
});

describe('filters and order', () => {
  const items = [
    { id: 'a', name: 'Zoo', status: 'want', cat: 'nature', labels: ['l1'], order: 'b', cr: 3, rating: { [ME]: 2 } },
    { id: 'b', name: 'Alfama walk', status: 'visited', labels: [], order: 'a', cr: 1, tags: { [ME]: ['evening'], [YOU]: ['secret'] }, rating: { [ME]: 5, [YOU]: 4 } },
    { id: 'c', name: 'Museu', status: 'idea', cat: 'attraction', order: 'c', cr: 2 },
  ];
  it('filters by status, category (none as empty), label and words including my own tags only', () => {
    expect(filterSaved(items, { statuses: new Set(['want', 'idea']) }).map((item) => item.id)).toEqual(['a', 'c']);
    expect(filterSaved(items, { cats: new Set(['']) }).map((item) => item.id)).toEqual(['b']);
    expect(filterSaved(items, { labels: new Set(['l1']) }).map((item) => item.id)).toEqual(['a']);
    expect(filterSaved(items, { query: 'EVENING', uid: ME }).map((item) => item.id)).toEqual(['b']);
    expect(filterSaved(items, { query: 'secret', uid: ME })).toEqual([]);
  });
  it('sorts by order, name, recency and average rating', () => {
    expect(sortSaved(items).map((item) => item.id)).toEqual(['b', 'a', 'c']);
    expect(sortSaved(items, 'name').map((item) => item.id)).toEqual(['b', 'c', 'a']);
    expect(sortSaved(items, 'recent').map((item) => item.id)).toEqual(['a', 'c', 'b']);
    expect(sortSaved(items, 'rating').map((item) => item.id)).toEqual(['b', 'a', 'c']);
  });
  it('makes order keys after the last item and between neighbours', () => {
    const [first, second] = appendOrders(items, 2);
    expect(first > 'c' && second > first).toBe(true);
    const sorted = sortSaved(items);
    const key = moveOrder(sorted, 2, 0);
    expect(key < 'a').toBe(true);
  });
  it('orders collections by the saved order, then by name', () => {
    const entries = [{ ref: { s: 'x' }, title: 'beta' }, { ref: { s: 'y' }, title: 'Alpha' }, { ref: { s: 'z' }, title: 'gamma' }];
    expect(orderCollections(entries, ['z']).map((entry) => entry.ref.s)).toEqual(['z', 'y', 'x']);
  });
});

describe('copies between trips and collections', () => {
  const place = {
    id: placeId, name: 'Time Out Market', lat: 38.7069, lng: -9.1459, cat: 'restaurant', price: { amount: 1200, currency: 'EUR' },
    img: { url: 'https://images.example/market.jpg', credit: 'Ana' }, ids: { osm: 'node/9' }, src: 'search',
    rating: { [ME]: 4, [YOU]: 2 }, tags: { [ME]: ['food'], [YOU]: ['hidden'] }, visited: { [YOU]: true }, v: 'x', rev: 3, by: YOU,
  };
  it('saves a trip place with my own per-user data, a trip source and a valid shape', () => {
    const fields = fromPlace(place, { uid: ME, trip: TRIP, order: 'V', builtin: (id) => id === 'restaurant' });
    expect(fields).toMatchObject({ name: 'Time Out Market', status: 'want', cat: 'restaurant', rating: { [ME]: 4 }, tags: { [ME]: ['food'] }, src: { trip: TRIP, placeId } });
    expect(fields).not.toHaveProperty('visited');
    expect(fields).not.toHaveProperty('rev');
    expect(() => validateEntity('collection', 'saved', fields)).not.toThrow();
    expect(fromPlace({ ...place, cat: '0123456789abcdeh' }, { uid: ME, trip: TRIP, order: 'V' })).not.toHaveProperty('cat');
    expect(fromPlace({ ...place, visited: { [ME]: true } }, { uid: ME, trip: TRIP, order: 'V' }).status).toBe('visited');
  });
  it('adds a saved place to a trip with photo, my tags and rating, never a file image', () => {
    const saved = { ...fromPlace(place, { uid: ME, trip: TRIP, order: 'V', builtin: () => true }), status: 'visited', rating: { [ME]: 5, [YOU]: 1 } };
    const fields = toPlace(saved, { uid: ME });
    expect(fields).toMatchObject({ img: place.img, rating: { [ME]: 5 }, tags: { [ME]: ['food'] }, visited: { [ME]: true }, src: 'collection' });
    expect(() => validateEntity('trip', 'place', fields)).not.toThrow();
    expect(toPlace({ name: 'X', status: 'idea', order: 'V', img: { fileId: placeId } }, { uid: ME })).not.toHaveProperty('img');
  });
  it('copies between collections with mapped labels', () => {
    const fields = copySaved({ name: 'X', status: 'revisit', order: 'a', labels: ['l1', 'l2'], rating: { [YOU]: 3 } }, { uid: ME, order: 'V', labelIds: new Map([['l1', 't1']]) });
    expect(fields).toEqual({ name: 'X', status: 'revisit', order: 'V', labels: ['t1'] });
  });
});

describe('JSON import and export', () => {
  const labels = [{ id: 'l1', name: 'Food', color: 3 }];
  const saved = [
    { id: 'a', name: 'Taberna', status: 'want', order: 'a', lat: 38.71, lng: -9.14, labels: ['l1'], rating: { [ME]: 4, [YOU]: 1 }, tags: { [YOU]: ['private'] }, src: { trip: TRIP, placeId } },
    { id: 'b', name: 'Bookshop', status: 'idea', order: 'b', visited: { [ME]: true } },
  ];
  it('exports without other members’ data and reads back valid places', () => {
    const data = exportJson({ meta: { name: 'Lisbon', icon: 'heart' }, labels, saved, uid: ME });
    const text = JSON.stringify(data);
    expect(text).not.toContain('private');
    expect(text).not.toContain(YOU);
    expect(data.places[0]).toMatchObject({ name: 'Taberna', labels: ['Food'], rating: 4 });
    expect(data.places[0]).not.toHaveProperty('src');
    const parsed = parseJson(text, { uid: YOU });
    expect(parsed.meta).toMatchObject({ name: 'Lisbon', icon: 'heart' });
    expect(parsed.labels).toEqual([{ name: 'Food', color: 3 }]);
    expect(parsed.places[0]).toEqual({ fields: { name: 'Taberna', lat: 38.71, lng: -9.14, status: 'want', rating: { [YOU]: 4 } }, labels: ['Food'] });
    expect(parsed.places[1].fields.visited).toEqual({ [YOU]: true });
  });
  it('skips invalid places and refuses other files', () => {
    const parsed = parseJson(JSON.stringify({ format: 'trips-collection', version: 1, name: 'X', places: [{ name: 'ok' }, { name: '' }, { name: 'bad', lat: 200, lng: 0 }, { name: 'link', web: 'javascript:1' }, 7] }), { uid: ME });
    expect(parsed.places.map((place) => place.fields.name)).toEqual(['ok']);
    expect(parsed.skipped).toBe(4);
    expect(() => parseJson('{"places": []}', { uid: ME })).toThrow('import_unreadable');
    expect(() => parseJson('nope', { uid: ME })).toThrow('import_unreadable');
  });
});

describe('GPX import and export', () => {
  it('escapes names, skips places without coordinates and reads its own output back', () => {
    const saved = [
      { name: 'Tom & Jerry’s <bar>', lat: 38.7, lng: -9.1, labels: ['l1'], web: 'https://x.example/?a=1&b=2', address: 'Rua "A"', desc: 'One', notes: 'Two' },
      { name: 'Nowhere', status: 'idea' },
    ];
    const { text, count, skipped } = exportGpx({ meta: { name: 'Lisbon' }, labels: [{ id: 'l1', name: 'Bars' }], saved });
    expect([count, skipped]).toEqual([1, 1]);
    expect(text).toContain('Tom &amp; Jerry’s &lt;bar&gt;');
    expect(text).not.toContain('<bar>');
    const parsed = parseGpx(text);
    expect(parsed.name).toBe('Lisbon');
    expect(parsed.places).toEqual([{ name: 'Tom & Jerry’s <bar>', lat: 38.7, lng: -9.1, desc: 'One Two', address: 'Rua "A"', web: 'https://x.example/?a=1&b=2', group: 'Bars' }]);
  });
  it('reads OsmAnd favourites with groups, CDATA, entities and self-closing points', () => {
    const text = `<?xml version="1.0"?>
      <gpx version="1.1" creator="OsmAnd" xmlns="http://www.topografix.com/GPX/1/1" xmlns:osmand="https://osmand.net">
        <!-- <wpt lat="1" lon="1"><name>commented</name></wpt> -->
        <wpt lat="52.3676" lon="4.9041"><name><![CDATA[Café <Amsterdam> & co]]></name><type>Coffee</type>
          <extensions><osmand:address>Dam 1</osmand:address><osmand:icon>cafe</osmand:icon><osmand:color>x</osmand:color></extensions></wpt>
        <wpt lat='48.8584' lon='2.2945'><name>Eiffel &#x26; &#38; tower</name><cmt>Tall</cmt><link href="javascript:alert(1)"/></wpt>
        <wpt lat="95" lon="0"><name>Bad</name></wpt>
        <wpt lat="10" lon="20"/>
      </gpx>`;
    const parsed = parseGpx(text);
    expect(parsed.places).toEqual([
      { name: 'Café <Amsterdam> & co', lat: 52.3676, lng: 4.9041, address: 'Dam 1', group: 'Coffee' },
      { name: 'Eiffel & & tower', lat: 48.8584, lng: 2.2945, desc: 'Tall' },
      { name: '', lat: 10, lng: 20 },
    ]);
    expect(parsed.skipped).toBe(1);
    expect(gpxFields(parsed.places[2])).toMatchObject({ name: '10, 20', status: 'idea' });
    expect(() => parseGpx('<kml></kml>')).toThrow('import_unreadable');
  });
});
