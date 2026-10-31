// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { K } from '../../worker/keys.js';
import { stripLocation } from '../../worker/engine/exif.js';
import { JOURNEY_STATUSES } from '../../worker/ops/journey/meta.js';
import { ENTRY_LIMITS, ENTRY_TYPES, MOODS, VISIBILITY, WEATHER } from '../../worker/ops/journey/entry.js';
import { JOURNEY_LINK_TYPES } from '../../worker/ops/journey/file.js';
import * as constants from '../../src/views/journey/constants.js';
import { journeyMetaFromTrip, suggestionsFromTrip } from '../../src/views/journey/model.js';
import { ORIGIN, USERS, WORKER, createHarness, expectError, id } from './harness.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const anonymous = async (h, path) => (await h.client('dave')).puter.workers.exec(ORIGIN + path, { headers: { 'x-puter-no-auth': '1' } });
const put = (t, fields, eid = id(t)) => ({ opId: id('o'), t, id: eid, put: fields });
const set = (t, eid, fields) => ({ opId: id('o'), t, id: eid, set: fields });
const del = (t, eid) => ({ opId: id('o'), t, id: eid, del: true });
const OWNER = USERS.alice.uuid;
const kvCalls = (h) => Object.entries(h.world.counters().byUser[OWNER]?.calls ?? {}).filter(([method]) => method.startsWith('kv.') && method !== 'kv.share').reduce((n, [, count]) => n + count, 0);
const tripRef = { w: WORKER, s: '0123456789abcdef', k: 'trip' };
const entry = (fields = {}) => ({ type: 'moment', date: '2027-05-02', title: 'Tram 28', order: 'V', ...fields });

/** Uploads a proxied file as `client` and registers it. */
async function upload(client, space, { fileId = id('f'), bytes = PNG, name = 'pic.png', mime = 'image/png', thumb = false } = {}) {
  await client.raw('PUT', `/files/${space}/${fileId}`, { body: bytes, signed: `PUT /files/${space}/${fileId}` });
  await client.in(space).call('file.put', { fileId, name, mime, sha256: 'a'.repeat(64), kind: 'user' });
  if (thumb) await client.raw('PUT', `/files/${space}/${fileId}/thumb`, { body: WEBP, signed: `PUT /files/${space}/${fileId}/thumb` });
  return fileId;
}

async function journey(meta = { title: 'Portugal', trips: [tripRef] }) {
  const h = await createHarness({ ownerVerified: false });
  const alice = await h.client('alice');
  const { space } = await alice.call('space.create', { kind: 'journey', meta });
  for (const [name, role] of Object.entries({ bob: 'editor', carol: 'viewer' })) {
    const { token } = await alice.in(space).call('invite.create', { role });
    await (await h.client(name)).in(space).call('join', { token });
  }
  const [bob, carol] = await Promise.all(['bob', 'carol'].map((name) => h.client(name)));
  const as = (client) => (ops) => client.in(space).call('commit', { ops });
  return { h, space, alice: as(alice), bob: as(bob), carol: as(carol), clients: { alice, bob, carol } };
}

describe('journey public link contract', () => {
  it('stamps since and keeps the expiry in journey meta', async () => {
    const h = await createHarness();
    const alice = await h.client('alice');
    const { space } = await alice.call('space.create', { kind: 'journey', meta: { title: 'Portugal' } });
    const exp = h.now() + 86_400_000;
    const first = await alice.in(space).call('share.set', { on: true, gallery: true, exp });
    expect(first.token).toMatch(/^[0-9a-f]{32}$/);
    expect(first.share).toMatchObject({ on: true, gallery: true, exp, since: h.now() });
    h.advance(1000);
    const rotated = await alice.in(space).call('share.set', { rotate: true });
    expect(rotated.share.since).toBe(h.now());
    expect(h.kv()[K.secrets(space)].shareExp).toBe(exp);
  });

  it('serves thumbnails of servable images only', async () => {
    const h = await createHarness({ ownerVerified: false });
    const space = await h.team({ bob: 'editor' });
    const bob = await h.client('bob');
    const alice = (await h.client('alice')).in(space);
    const withThumb = await upload(bob, space, { thumb: true });
    const bare = await upload(bob, space);
    await bob.in(space).call('commit', { ops: [
      put('place', { name: 'Belém', img: { fileId: withThumb } }),
      put('place', { name: 'Alfama', img: { fileId: bare } }),
    ] });
    const { token } = await alice.call('share.set', { on: true, plan: true });
    h.advance(121_000);
    const thumb = await anonymous(h, `/pub/${space}/${token}/f/${withThumb}/thumb`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    expect((await anonymous(h, `/pub/${space}/${token}/f/${bare}/thumb`)).status).toBe(404);
    const loose = await upload(bob, space, { thumb: true });
    expect((await anonymous(h, `/pub/${space}/${token}/f/${loose}/thumb`)).status).toBe(404);
    expect((await anonymous(h, `/pub/${space}/${'0'.repeat(32)}/f/${withThumb}/thumb`)).status).toBe(404);
  });
});

describe('journey rules', () => {
  it('keeps the worker and client value lists equal', () => {
    expect(constants.JOURNEY_STATUSES).toEqual(JOURNEY_STATUSES);
    expect(constants.ENTRY_TYPES).toEqual(ENTRY_TYPES);
    expect(constants.MOODS).toEqual(MOODS);
    expect(constants.WEATHER).toEqual(WEATHER);
    expect(constants.VISIBILITY).toEqual(VISIBILITY);
    expect(constants.ENTRY_LIMITS).toEqual(ENTRY_LIMITS);
    expect(constants.LINK_TYPES).toEqual(JOURNEY_LINK_TYPES);
  });

  it('validates meta on create and lets only the owner edit it', async () => {
    const h = await createHarness();
    const alice = await h.client('alice');
    await expectError(alice.call('space.create', { kind: 'journey', meta: { title: ' ' } }), 400);
    await expectError(alice.call('space.create', { kind: 'journey', meta: { title: 'x'.repeat(201) } }), 400, 'title_too_long');
    await expectError(alice.call('space.create', { kind: 'journey', meta: { title: 'J', status: 'paused' } }), 400, 'invalid_status');
    await expectError(alice.call('space.create', { kind: 'journey', meta: { title: 'J', trips: [tripRef, tripRef] } }), 400, 'duplicate_trip');
    await expectError(alice.call('space.create', { kind: 'journey', meta: { title: 'J', trips: [{ ...tripRef, k: 'collection' }] } }), 400, 'invalid_trip');
    const { space, kind } = await alice.call('space.create', { kind: 'journey', meta: { title: 'Portugal', subtitle: 'Spring', status: 'upcoming' } });
    expect(kind).toBe('journey');
    expect((await alice.call('heads', { spaces: [space] })).heads[space].title).toBe('Portugal');

    const { alice: owner, bob, carol } = await journey();
    await expectError(bob([set('meta', 'meta', { title: 'Mine' })]), 403, 'forbidden');
    await expectError(carol([set('meta', 'meta', { subtitle: 'Hi' })]), 403, 'forbidden');
    await expectError(owner([set('meta', 'meta', { subtitle: 'y'.repeat(301) })]), 400, 'subtitle_too_long');
    const many = Array.from({ length: 21 }, (_, i) => ({ ...tripRef, s: `0123456789ab${String(i).padStart(4, '0')}` }));
    await expectError(owner([set('meta', 'meta', { trips: many })]), 400, 'too_many_trips');
    const ok = await owner([set('meta', 'meta', { status: 'ongoing', fields: { mood: true, weather: false } })]);
    expect(ok.ents[0]).toMatchObject({ status: 'ongoing', fields: { mood: true, weather: false } });
    await expectError(owner([del('meta', 'meta')]), 403);
  });

  it('needs plan.edit for entries', async () => {
    const { bob, carol } = await journey();
    const eid = id('e');
    await expectError(carol([put('entry', entry(), eid)]), 403, 'forbidden');
    const created = await bob([put('entry', entry({ mood: 'great', weather: 'clear', tags: ['Tram'], loc: { name: 'Lisbon', lat: 38.71, lng: -9.14, cc: 'PT' } }), eid)]);
    expect(created.ents[0]).toMatchObject({ title: 'Tram 28', mood: 'great', by: USERS.bob.uuid });
    await expectError(carol([set('entry', eid, { title: 'Mine' })]), 403, 'forbidden');
    await expectError(carol([del('entry', eid)]), 403, 'forbidden');
    expect((await bob([set('entry', eid, { dismissed: true })])).ents[0].dismissed).toBe(true);
    expect((await bob([del('entry', eid)])).del).toEqual([expect.objectContaining({ t: 'entry', id: eid })]);
  });

  it('rejects unknown values and malformed fields', async () => {
    const { bob } = await journey();
    const eid = id('e');
    await expectError(bob([put('entry', entry({ type: 'diary' }))]), 400, 'invalid_type');
    await expectError(bob([put('entry', entry({ type: 'suggestion' }))]), 400, 'invalid_source');
    await expectError(bob([put('entry', entry({ mood: 'ecstatic' }))]), 400, 'invalid_mood');
    await expectError(bob([put('entry', entry({ weather: 'hail' }))]), 400, 'invalid_weather');
    await expectError(bob([put('entry', entry({ vis: 'private' }))]), 400, 'invalid_visibility');
    await expectError(bob([put('entry', entry({ title: 'x'.repeat(301) }))]), 400, 'title_too_long');
    await expectError(bob([put('entry', entry({ tags: ['Food', 'food'] }))]), 400, 'duplicate_tag');
    await expectError(bob([put('entry', entry({ tags: ['x'.repeat(51)] }))]), 400, 'invalid_tag');
    await expectError(bob([put('entry', entry({ pros: ['  '] }))]), 400, 'invalid_list');
    await expectError(bob([put('entry', entry({ cons: Array.from({ length: 21 }, (_, i) => `c${i}`) }))]), 400, 'invalid_list');
    const media = id('f');
    await expectError(bob([put('entry', entry({ media: [media, media] }))]), 400, 'duplicate_media');
    await expectError(bob([put('entry', entry({ loc: { name: 'Sea', lat: 1 } }))]), 400, 'invalid_location');
    await expectError(bob([put('entry', entry({ src: { trip: { ...tripRef, k: 'journey' }, placeId: id('p') } }))]), 400, 'invalid_source');
    await expectError(bob([put('entry', entry({ date: '2027-02-30' }))]), 400);
    await expectError(bob([put('entry', { type: 'moment', date: '2027-05-02', title: 'No order' })]), 400);
    await bob([put('entry', entry({ type: 'suggestion', src: { trip: tripRef, placeId: id('p'), visitId: id('v') } }), eid)]);
    await expectError(bob([set('entry', eid, { mood: 'ecstatic' })]), 400, 'invalid_mood');
    expect((await bob([set('entry', eid, { type: 'checkin', story: 'We walked up.' })])).ents[0].type).toBe('checkin');
  });

  it('limits journey file links to entries and the cover', async () => {
    const { space, bob, clients } = await journey();
    const fileId = await upload(clients.bob, space);
    await expectError(bob([set('file', fileId, { links: [{ t: 'place', id: id('p') }] })]), 400, 'invalid_links');
    await expectError(bob([set('file', fileId, { links: [{ t: 'meta', id: id('x') }] })]), 400, 'invalid_links');
    const eid = id('e');
    await expectError(bob([set('file', fileId, { links: [{ t: 'entry', id: eid }, { t: 'entry', id: eid }] })]), 400, 'invalid_links');
    expect((await bob([set('file', fileId, { links: [{ t: 'entry', id: eid }], desc: 'Sunset' })])).ents[0].desc).toBe('Sunset');
  });

  it('replays a retried entry commit without new writes, within the commit budget', async () => {
    const { h, bob } = await journey();
    const op = put('entry', entry({ story: 'Hills.' }));
    h.world.resetCounters();
    const first = await bob([op]);
    expect(kvCalls(h)).toBeLessThanOrEqual(8);
    const writes = h.world.counters().calls['kv.set'];
    const again = await bob([op]);
    expect(again).toMatchObject({ rev: first.rev, done: first.done });
    expect(h.world.counters().calls['kv.set']).toBe(writes);
  });

  it('accepts a journey made from a trip with its visits as suggestions', async () => {
    const h = await createHarness();
    const alice = await h.client('alice');
    const tripSpace = await h.trip();
    const day = { t: 'day', id: id('d'), order: 'V', date: '2027-05-01' };
    const place = { t: 'place', id: id('p'), name: 'Belém Tower', lat: 38.69, lng: -9.21, cc: 'PT' };
    const visits = [
      { t: 'visit', id: id('v'), dayId: day.id, placeId: place.id, order: 'V', start: '10:00' },
      { t: 'visit', id: id('v'), dayId: day.id, placeId: null, title: 'River walk', order: 'W' },
    ];
    await alice.in(tripSpace).call('commit', { ops: [day, place, ...visits].map(({ t, id: eid, ...fields }) => put(t, fields, eid)) });
    const ref = { w: WORKER, s: tripSpace, k: 'trip' };
    const meta = journeyMetaFromTrip({ title: 'Lisbon', start: '2027-05-01', end: '2027-05-04' }, ref, '2027-04-01');
    const { space } = await alice.call('space.create', { kind: 'journey', meta });
    const items = suggestionsFromTrip({ ref, days: [day], places: [place], visits });
    const result = await alice.in(space).call('commit', { ops: items.map((fields) => put('entry', fields)) });
    expect(result.ents.map((entity) => [entity.type, entity.title, entity.src.visitId])).toEqual([['suggestion', 'Belém Tower', visits[0].id], ['suggestion', 'River walk', visits[1].id]]);
    expect(h.kv()[K.entity(space, 'meta', 'meta')]).toMatchObject({ title: 'Lisbon', status: 'upcoming', trips: [ref] });
  });

  it('lets only share.manage change the public link', async () => {
    const { space, clients } = await journey();
    await expectError(clients.bob.in(space).call('share.set', { on: true }), 403, 'forbidden');
    await expectError(clients.carol.in(space).call('share.set', { on: true }), 403, 'forbidden');
    await expectError(clients.alice.in(space).call('share.set', { on: true, gallery: 'yes' }), 400, 'invalid_share');
    const { share } = await clients.alice.in(space).call('share.set', { on: true, timeline: true, gallery: true, map: false, newestFirst: true, plan: true });
    expect(share).toMatchObject({ on: true, timeline: true, gallery: true, map: false, newestFirst: true });
    expect(share.plan).toBeUndefined();
  });
});

describe('the public journey link', () => {
  async function shared() {
    const ctx = await journey();
    const { space, bob, clients } = ctx;
    const photo = await upload(clients.bob, space, { thumb: true });
    const hidden = await upload(clients.bob, space, { thumb: true });
    const doc = await upload(clients.bob, space, { bytes: new TextEncoder().encode('%PDF-1.7\n'), name: 'plan.pdf', mime: 'application/pdf' });
    const ids = { open: id('e'), members: id('e'), suggestion: id('e'), dismissed: id('e') };
    await bob([
      put('entry', entry({ title: 'Miradouro', story: 'Golden hour.', mood: 'great', loc: { name: 'Graça', lat: 38.72, lng: -9.13, cc: 'PT' }, media: [photo, doc], tags: ['view'] }), ids.open),
      put('entry', entry({ title: 'Family dinner', vis: 'members', media: [hidden], loc: { name: 'Home', lat: 38.7, lng: -9.1 } }), ids.members),
      put('entry', entry({ type: 'suggestion', title: 'Belém', src: { trip: tripRef, placeId: id('p') } }), ids.suggestion),
      put('entry', entry({ title: 'Skipped', dismissed: true }), ids.dismissed),
      set('file', photo, { desc: 'From the top', links: [{ t: 'entry', id: ids.open }] }),
      set('file', hidden, { links: [{ t: 'entry', id: ids.members }] }),
    ]);
    return { ...ctx, photo, hidden, doc, ids };
  }

  it('shows only public written entries and hides coordinates without the map', async () => {
    const { h, space, clients, photo, hidden, doc, ids } = await shared();
    const { token } = await clients.alice.in(space).call('share.set', { on: true, timeline: true, gallery: true });
    h.advance(121_000);
    const view = await (await anonymous(h, `/pub/${space}/${token}`)).json();
    expect(view.kind).toBe('journey');
    expect(view.share).toMatchObject({ timeline: true, gallery: true, map: false });
    const entries = view.ents.filter((item) => item.t === 'entry');
    expect(entries.map((item) => item.id)).toEqual([ids.open]);
    expect(entries[0]).toMatchObject({ title: 'Miradouro', story: 'Golden hour.', mood: 'great', loc: { name: 'Graça', cc: 'PT' }, media: [photo] });
    expect(entries[0].loc.lat).toBeUndefined();
    expect(view.files).toEqual([photo]);
    expect(view.ents.find((item) => item.t === 'file')).toMatchObject({ id: photo, desc: 'From the top', thumb: true });
    const text = JSON.stringify(view);
    for (const leak of [hidden, doc, 'Family dinner', 'Belém', 'Skipped', WORKER, USERS.bob.uuid, '"trips"', '38.72']) expect(text).not.toContain(leak);
    expect((await anonymous(h, `/pub/${space}/${token}/f/${hidden}`)).status).toBe(404);
    expect((await anonymous(h, `/pub/${space}/${token}/f/${hidden}/thumb`)).status).toBe(404);
    expect((await anonymous(h, `/pub/${space}/${token}/f/${doc}`)).status).toBe(404);
    expect((await anonymous(h, `/pub/${space}/${token}/f/${photo}/thumb`)).status).toBe(200);
  });

  it('adds coordinates with the map and drops photos without timeline or gallery', async () => {
    const { h, space, clients, ids } = await shared();
    const { token } = await clients.alice.in(space).call('share.set', { on: true, timeline: false, map: true });
    h.advance(121_000);
    const view = await (await anonymous(h, `/pub/${space}/${token}`)).json();
    expect(view.ents).toEqual([{ t: 'entry', id: ids.open, title: 'Miradouro', date: '2027-05-02', type: 'moment', order: 'V', cr: expect.any(Number), loc: { name: 'Graça', cc: 'PT', lat: 38.72, lng: -9.13 } }]);
    expect(view.files).toEqual([]);
  });

  it('strips GPS from served photos when the map is hidden and keeps it when shown', async () => {
    const { h, space, bob, clients } = await journey();
    const photo = await upload(clients.bob, space, { bytes: jpegWithGps(), name: 'gps.jpg', mime: 'image/jpeg' });
    await bob([put('entry', entry({ media: [photo] }))]);
    const { token } = await clients.alice.in(space).call('share.set', { on: true, gallery: true });
    h.advance(121_000);
    const response = await anonymous(h, `/pub/${space}/${token}/f/${photo}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    const hiddenMap = new Uint8Array(await response.arrayBuffer());
    expect(hiddenMap.slice(0, 4)).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe1]));
    expect(hasGpsValues(hiddenMap)).toBe(false);
    expect(new TextDecoder().decode(hiddenMap)).not.toContain('xmp');
    await clients.alice.in(space).call('share.set', { map: true });
    h.advance(121_000);
    const shownMap = new Uint8Array(await (await anonymous(h, `/pub/${space}/${token}/f/${photo}`)).arrayBuffer());
    expect(hasGpsValues(shownMap)).toBe(true);
  });
});

describe('stripLocation', () => {
  it('empties the JPEG GPS directory and drops XMP and IPTC but keeps the rest', () => {
    const input = jpegWithGps();
    const out = stripLocation(input, 'image/jpeg');
    expect(hasGpsValues(input)).toBe(true);
    expect(hasGpsValues(out)).toBe(false);
    const text = new TextDecoder().decode(out);
    expect(text).not.toContain('xmp');
    expect(text).not.toContain('Photoshop');
    expect(text).toContain('Exif');
    expect(out.slice(-6)).toEqual(input.slice(-6));
  });

  it('drops PNG text and eXIf chunks and WebP EXIF and XMP chunks', () => {
    const encode = (text) => new TextEncoder().encode(text);
    const chunk = (type, data) => {
      const out = new Uint8Array(12 + data.length);
      new DataView(out.buffer).setUint32(0, data.length);
      out.set(encode(type), 4); out.set(data, 8);
      return out;
    };
    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const png = concat([sig, chunk('IHDR', new Uint8Array(13)), chunk('eXIf', new Uint8Array([1, 2])), chunk('tEXt', encode('GPS')), chunk('IDAT', new Uint8Array(4)), chunk('IEND', new Uint8Array(0))]);
    const strippedPng = new TextDecoder().decode(stripLocation(png, 'image/png'));
    expect(strippedPng).not.toMatch(/eXIf|tEXt/);
    expect(strippedPng).toContain('IDAT');
    const riff = (type, data) => {
      const out = new Uint8Array(8 + data.length + (data.length % 2));
      out.set(encode(type));
      new DataView(out.buffer).setUint32(4, data.length, true);
      out.set(data, 8);
      return out;
    };
    const body = concat([encode('WEBP'), riff('VP8X', new Uint8Array([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0])), riff('VP8 ', new Uint8Array(6)), riff('EXIF', new Uint8Array(5)), riff('XMP ', new Uint8Array(4))]);
    const webp = concat([encode('RIFF'), new Uint8Array(4), body]);
    new DataView(webp.buffer).setUint32(4, webp.length - 8, true);
    const strippedWebp = stripLocation(webp, 'image/webp');
    expect(new TextDecoder().decode(strippedWebp)).not.toMatch(/EXIF|XMP /);
    expect(new DataView(strippedWebp.buffer).getUint32(4, true)).toBe(strippedWebp.length - 8);
    expect(strippedWebp[20] & 0x0c).toBe(0);
    expect(stripLocation(new Uint8Array([0xff, 0xd8, 0x00]), 'image/jpeg')).toBeNull();
  });
});

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** A tiny JPEG: SOI, an Exif APP1 with orientation and a GPS directory, an XMP APP1, an IPTC APP13, then SOS and EOI. */
function jpegWithGps() {
  const gps = 8 + 2 + 24 + 4;
  const values = gps + 2 + 24 + 4;
  const tiff = new Uint8Array(values + 24);
  const view = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 0x2a, 0x00]);
  view.setUint32(4, 8, true);
  view.setUint16(8, 2, true);
  const field = (at, tag, type, count, value) => { view.setUint16(at, tag, true); view.setUint16(at + 2, type, true); view.setUint32(at + 4, count, true); view.setUint32(at + 8, value, true); };
  field(10, 0x0112, 3, 1, 6);
  field(22, 0x8825, 4, 1, gps);
  view.setUint16(gps, 2, true);
  field(gps + 2, 0x0002, 5, 3, values);
  field(gps + 14, 0x0001, 2, 2, 0x4e);
  tiff.fill(0x5a, values, values + 24);
  const segment = (marker, payload) => {
    const out = new Uint8Array(4 + payload.length);
    out.set([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
    out.set(payload, 4);
    return out;
  };
  const encode = (text) => new TextEncoder().encode(text);
  const exif = segment(0xe1, concat([encode('Exif\0\0'), tiff]));
  const xmp = segment(0xe1, encode('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta exif:GPSLatitude="38"/>'));
  const iptc = segment(0xed, encode('Photoshop 3.0\0city'));
  return concat([new Uint8Array([0xff, 0xd8]), exif, xmp, iptc, new Uint8Array([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9])]);
}
const hasGpsValues = (bytes) => bytes.some((byte, i) => byte === 0x5a && bytes[i + 1] === 0x5a && bytes[i + 2] === 0x5a);
