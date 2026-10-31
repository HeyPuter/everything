import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { ApiError } from '../../src/lib/api.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createClock } from '../../src/shared/hlc.js';
import { newId } from '../../src/shared/ids.js';
import { openTrackImport, openTripImport, buildExport } from '../../src/views/io/index.js';
import { parseSpaceExport } from '../../src/lib/io/space-format.js';
import { encodeTrack } from '../../src/lib/io/track-file.js';
import { createTrackLayer } from '../../src/views/io/tracks.js';
import { fileLinks } from '../../src/shared/file-links.js';

const uid = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
const clock = createClock({ node: '0000000000000007', now: () => 1_000_000 });
const server = (t, id, fields) => ({ t, id, ...fields, v: clock.tick(), rev: 1, upd: 1000, by: bob, cr: 1000 });
const byText = (text) => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === text);
const open = [];
const dialogs = [];

beforeAll(() => {
  // jsdom's Blob has no arrayBuffer(); browsers do.
  if (!Blob.prototype.arrayBuffer) {
    Blob.prototype.arrayBuffer = function arrayBuffer() {
      return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsArrayBuffer(this); });
    };
  }
});

const day = '1000000000000001';
const place = '1000000000000002';
async function setup({ role = 'editor' } = {}) {
  const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
  const puter = world.client(uid);
  const db = await openDatabase(uid, { indexedDB: new IDBFactory() });
  const api = {
    commit: vi.fn(async () => { throw new ApiError(0, 'network'); }),
    snapshot: vi.fn(),
    upload: vi.fn(async () => ({ ok: true })),
    download: vi.fn(),
    call: vi.fn(async (_ref, op, input) => (op === 'file.put'
      ? { rev: 2, ents: [{ t: 'file', id: input.fileId, name: input.name, mime: input.mime, size: 10, sha256: input.sha256, kind: 'track', loc: { mode: 'proxied' }, v: clock.tick(), rev: 2, upd: 1, by: uid, cr: 1 }], del: [] }
      : { rev: 1, changes: [] })),
  };
  const personal = createPersonalStore({ puter, db });
  const space = await openSpace({ ref, db, api, puter, personal, role, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false });
  await space.store.replace({ rev: 1, ents: [
    server('meta', 'meta', { title: 'Lisbon', currency: 'EUR' }), server('member', uid, { name: 'Me', role }), server('member', bob, { name: 'Bob', role: 'editor' }),
    server('day', day, { order: 'a', date: '2026-06-01' }),
    server('place', place, { name: 'Belém Tower', lat: 38.6916, lng: -9.216, tags: { [uid]: ['mine'], [bob]: ['bob only'] } }),
  ] });
  open.push(space);
  return { space, api, personal, puter, context: { space, account: { uuid: uid }, personal, puter, session: { api, personal }, app: { navigate: vi.fn() } } };
}
afterEach(() => {
  for (const dialog of dialogs.splice(0)) dialog.close();
  for (const space of open.splice(0)) space.close();
  document.body.replaceChildren();
});

const gpx = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="38.6916" lon="-9.2160"><name>Belém Tower</name></wpt>
  <wpt lat="38.7139" lon="-9.1335"><name>Castelo</name><sym>Scenic Area</sym></wpt>
  <trk><name>Tram 28</name><trkseg><trkpt lat="38.71" lon="-9.13"/><trkpt lat="38.72" lon="-9.14"/></trkseg></trk>
</gpx>`;

describe('import dialogs', () => {
  it('imports GPX waypoints and tracks as places, marks duplicates and adds them to a day', async () => {
    const { space, api, context } = await setup();
    dialogs.push(openTrackImport(context, { file: new File([gpx], 'lisbon.gpx') }));
    await vi.waitFor(() => expect(document.querySelectorAll('.io-item')).toHaveLength(3));
    const rows = [...document.querySelectorAll('.io-item')];
    expect(rows.map((row) => row.querySelector('.io-item-name').textContent)).toEqual(['Tram 28', 'Belém Tower', 'Castelo']);
    expect(rows[1].querySelector('input').checked).toBe(false);
    expect(rows[1].textContent).toContain('Already in this trip');
    const select = document.querySelector('.io-dialog select');
    select.value = day;
    byText('Import 2 items').click();
    await vi.waitFor(() => expect(document.querySelector('.io-dialog')).toBeNull());
    const places = space.select.place.all();
    const tram = places.find((item) => item.name === 'Tram 28');
    expect(tram).toMatchObject({ lat: 38.71, lng: -9.13, src: 'gpx', track: { km: expect.any(Number) } });
    expect(places.find((item) => item.name === 'Castelo').cat).toBe('attraction');
    expect(api.upload).toHaveBeenCalledTimes(1);
    const put = api.call.mock.calls.filter((call) => call[1] === 'file.put');
    expect(put).toHaveLength(1);
    expect(put[0][2]).toMatchObject({ mime: 'application/gzip', kind: 'track', name: 'tram-28.geojson.gz' });
    expect(fileLinks(space.get('file', tram.track.fileId))).toEqual([{ t: 'place', id: tram.id }]);
    expect(space.select.visit.all().map((visit) => visit.dayId)).toEqual([day, day]);
    expect(space.history.label).toBe('Import lisbon.gpx');
    expect(document.querySelector('.io-dialog')).toBeNull();
  });

  it('refuses GPX for viewers and reads Trips files into the open trip', async () => {
    const viewer = await setup({ role: 'viewer' });
    dialogs.push(openTrackImport(viewer.context, { file: new File([gpx], 'lisbon.gpx') }));
    await vi.waitFor(() => expect(document.querySelector('.io-error')?.textContent).toContain('permission'));
    expect(document.querySelector('.io-items')).toBeNull();
    dialogs.pop().close();

    const { space, context } = await setup();
    const data = { format: 'trips-space', version: 1, kind: 'trip', exportedBy: uid, meta: { title: 'Porto', currency: 'EUR' },
      members: [{ id: bob, name: 'Bob', role: 'editor' }],
      entities: { place: [{ id: newId(), name: 'Belém Tower', lat: 38.6917, lng: -9.2161 }, { id: newId(), name: 'Ribeira', lat: 41.14, lng: -8.61 }],
        guest: [], todo: [{ id: newId(), name: 'Book train', order: 'a', who: bob }] } };
    dialogs.push(openTripImport(context, { file: new File([JSON.stringify(data)], 'porto.json') }));
    await vi.waitFor(() => expect(document.querySelector('.io-summary')?.textContent).toContain('Porto'));
    const merge = [...document.querySelectorAll('.choice')].find((node) => node.textContent.includes('Add to this trip'));
    expect(merge.disabled).toBe(false);
    byText('Import').click();
    await vi.waitFor(() => expect(space.select.place.all().map((item) => item.name).sort()).toEqual(['Belém Tower', 'Ribeira']));
    expect(space.select.todo.all()[0].who).toBe(bob);
    expect(space.history.label).toBe('Import porto.json');
  });
});

describe('import as a new trip', () => {
  it('creates the trip on the owner’s worker, fills it in batches and opens it', async () => {
    const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
    const puter = world.client(uid);
    const db = await openDatabase(uid, { indexedDB: new IDBFactory() });
    const personal = createPersonalStore({ puter, db });
    const created = '0000000000000009';
    const api = {
      request: vi.fn(async (worker, body) => ({ ok: true, space: JSON.parse(body).space && created, kind: 'trip', rev: 1 })),
      commit: vi.fn(async () => { throw new ApiError(0, 'network'); }),
      call: vi.fn(async () => ({ rev: 1, changes: [] })), snapshot: vi.fn(), upload: vi.fn(), download: vi.fn(),
    };
    const navigate = vi.fn();
    const context = { account: { uuid: uid }, puter, personal, app: { navigate }, session: { api, db, personal, deployer: { ensure: async () => ({ worker: { name: 'trips-012345abcd' } }) } } };
    const days = Array.from({ length: 3 }, (_, i) => ({ id: newId(), order: `a${i + 1}`, date: `2026-07-0${i + 1}` }));
    const places = Array.from({ length: 250 }, (_, i) => ({ id: newId(), name: `Place ${i}`, lat: 41 + i / 1000, lng: -8 }));
    const data = { format: 'trips-space', version: 1, kind: 'trip', exportedBy: uid, meta: { title: 'Porto', currency: 'EUR', start: '2026-07-01', end: '2026-07-03', share: { on: true } },
      entities: { day: days, place: places, visit: [{ id: newId(), dayId: days[0].id, placeId: places[0].id, order: 'a' }] }, private: { pack: [{ id: newId(), name: 'Passport', order: 'a' }] } };
    dialogs.push(openTripImport(context, { file: new File([JSON.stringify(data)], 'porto.json') }));
    await vi.waitFor(() => expect(byText('Import')).toBeDefined());
    expect([...document.querySelectorAll('.choice')]).toHaveLength(0);
    document.querySelector('.io-dialog input[type=text], .io-dialog input:not([type])').value = 'Porto again';
    byText('Import').click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled(), { timeout: 3000 });
    const create = JSON.parse(api.request.mock.calls[0][1]);
    expect(create).toMatchObject({ op: 'space.create', kind: 'trip', meta: { title: 'Porto again', currency: 'EUR', start: '2026-07-01', end: '2026-07-03' } });
    expect(create.meta).not.toHaveProperty('share');
    expect(navigate).toHaveBeenCalledWith(`#/t/trips-012345abcd/${created}/plan`);
    expect((await personal.spaces.list()).map((entry) => entry.title)).toEqual(['Porto again']);
    expect(Object.values(await personal.privateItems(created, 'pack').list()).map((item) => item.name)).toEqual(['Passport']);
    expect(api.commit).toHaveBeenCalled();
    expect([...document.querySelectorAll('.toast')].some((node) => node.textContent.includes('sync when you’re online'))).toBe(true);
  });
});

describe('export', () => {
  it('builds a Trips file with the viewer’s own tags and private items, and a GPX file', async () => {
    const { space, context } = await setup();
    await space.privateItems('pack').put({ name: 'Passport', order: 'a' }, newId());
    const json = await buildExport(context, { format: 'json' });
    expect(json.name).toMatch(/^lisbon-\d{4}-\d{2}-\d{2}\.json$/);
    const parsed = parseSpaceExport(new TextDecoder().decode(await json.blob.arrayBuffer()));
    expect(parsed.entities.place[0].tags).toEqual({ [uid]: ['mine'] });
    expect(parsed.private.pack.map((item) => item.name)).toEqual(['Passport']);
    const gpxFile = await buildExport(context, { format: 'gpx', scope: 'places' });
    const text = new TextDecoder().decode(await gpxFile.blob.arrayBuffer());
    expect(text).toContain('<name>Belém Tower</name>');
    expect(text).toContain('<sym>Flag, Blue</sym>');
  });
});

describe('map track layer', () => {
  it('downloads a track once and draws it as plain positions with its colour', async () => {
    const { space, api } = await setup();
    const fileId = newId();
    await space.store.merge([server('file', fileId, { name: 'loop.geojson.gz', mime: 'application/gzip', size: 10, sha256: 'b'.repeat(64), kind: 'track', loc: { mode: 'proxied' } }),
      server('place', '1000000000000003', { name: 'Loop', lat: 38.7, lng: -9.1, track: { fileId, color: 4, km: 1 } })]);
    api.download = vi.fn(async () => new Blob([encodeTrack({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-9.1, 38.7, 12], [-9.2, 38.8, 15]] } })]));
    const tripMap = { setTracks: vi.fn() };
    const changed = vi.fn();
    const layer = createTrackLayer({ space, api, onChange: changed });
    layer.render(tripMap, null);
    expect(tripMap.setTracks).toHaveBeenCalledWith('tracks', { type: 'FeatureCollection', features: [] });
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    layer.render(tripMap, null);
    layer.render(tripMap, null);
    expect(api.download).toHaveBeenCalledTimes(1);
    expect(tripMap.setTracks).toHaveBeenCalledTimes(2);
    expect(tripMap.setTracks.mock.calls[1][1].features[0]).toEqual({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-9.1, 38.7], [-9.2, 38.8]] }, properties: { id: '1000000000000003', tone: 4 } });
    layer.render(tripMap, { items: [] });
    expect(tripMap.setTracks.mock.calls[2][1].features).toEqual([]);
  });
});
