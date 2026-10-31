import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { ApiError } from '../../src/lib/api.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createClock } from '../../src/shared/hlc.js';
import { parseRoute } from '../../src/lib/router.js';
import { mount } from '../../src/views/journey/index.js';
import { readIntent, newJourney } from '../../src/views/journey/command.js';
import { entryPatch } from '../../src/views/journey/editor.js';
import { readExif } from '../../src/views/journey/exif.js';
import { nearbyScore } from '../../src/views/journey/nearby.js';
import { cleanJourneyProjection } from '../../src/views/journey/public/data.js';
import { orderedEntries } from '../../src/views/journey/public/index.js';

const uid = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'journey' };
const tripRef = { w: 'trips-012345abcd', s: '0000000000000002', k: 'trip' };
const clock = createClock({ node: '0000000000000007', now: () => 1_000_000 });
const server = (t, id, fields) => ({ t, id, ...fields, v: clock.tick(), rev: 1, upd: 1000, by: bob, cr: 1000 });
const open = [];
const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
const byText = (root, text, selector = 'button') => [...root.querySelectorAll(selector)].find((node) => node.textContent.trim().startsWith(text));

async function page(role = 'editor') {
  const fake = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
  const puter = fake.client(uid);
  const db = await openDatabase(uid, { indexedDB: new IDBFactory() });
  const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 1, changes: [] })), snapshot: vi.fn(), request: vi.fn() };
  const personal = createPersonalStore({ puter, db });
  const space = await openSpace({ ref, db, api, puter, personal, role, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false });
  await space.store.replace({ rev: 1, ents: [
    server('member', uid, { name: 'Me', role }),
    server('meta', 'meta', { title: 'Portugal', subtitle: 'Spring walk', status: 'completed' }),
    server('entry', '1000000000000001', { type: 'moment', date: '2027-05-01', title: 'Arrival', story: 'We **landed**.', order: 'V', mood: 'great', tags: ['flight'] }),
    server('entry', '1000000000000002', { type: 'suggestion', date: '2027-05-02', title: 'Belém Tower', order: 'V', src: { trip: tripRef, placeId: '2000000000000001', visitId: '3000000000000001' } }),
    server('entry', '1000000000000003', { type: 'moment', date: '2027-05-02', title: 'Private dinner', order: 'W', vis: 'members' }),
  ] });
  const container = document.createElement('div');
  document.body.append(container);
  const controller = new AbortController();
  const context = { space, ref, route: { name: 'space', ref, tab: 'timeline' }, account: { uuid: uid }, personal, puter,
    session: { api, db, personal, ownWorker: async () => null }, app: { navigate: vi.fn(), setSyncState: vi.fn() }, signal: controller.signal };
  const cleanup = await mount(container, context);
  open.push({ controller, cleanup, space });
  await frame();
  return { space, container, context };
}

afterEach(() => {
  for (const entry of open.splice(0)) { entry.controller?.abort(); entry.cleanup?.(); entry.space?.close(); }
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

describe('journey page', () => {
  it('shows the header, days, entries, a suggestion and the members-only badge', async () => {
    const { container } = await page();
    expect(container.querySelector('.jr-title').textContent).toBe('Portugal');
    expect(container.querySelector('.jr-sub').textContent).toBe('Spring walk');
    expect(container.querySelector('.jr-title-block').textContent).not.toContain('[object Object]');
    expect([...container.querySelectorAll('.jr-day')].map((node) => node.dataset.date)).toEqual(['2027-05-01', '2027-05-02']);
    expect(container.querySelector('.jr-story-text strong').textContent).toBe('landed');
    const suggestion = container.querySelector('.jr-entry.is-suggestion');
    expect(suggestion.querySelector('.jr-entry-title').textContent).toBe('Belém Tower');
    expect(byText(suggestion, 'Write about it')).toBeTruthy();
    expect(container.querySelector('[data-id="1000000000000003"]').textContent).toContain('Members only');
  });

  it('dismisses and restores suggestions, and hides dismissed ones by default', async () => {
    const { container, space } = await page();
    byText(container.querySelector('.jr-entry.is-suggestion'), 'Dismiss').click();
    await vi.waitFor(() => expect(container.querySelector('.jr-entry.is-suggestion')).toBeNull());
    expect(space.get('entry', '1000000000000002').dismissed).toBe(true);
    expect(container.querySelector('.jr-dismissed-note').textContent).toContain('1');
  });

  it('filters by search and gives viewers no edit controls', async () => {
    const { container } = await page('viewer');
    expect(container.querySelector('.jr-head-actions .btn-primary').hidden).toBe(true);
    expect(byText(container, 'Write about it')).toBeUndefined();
    const search = container.querySelector('.jr-search input');
    search.value = 'arrival';
    search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect([...container.querySelectorAll('.jr-entry-title')].map((node) => node.textContent)).toEqual(['Arrival']));
  });

  it('routes journeys to the timeline by default and keeps the palette intent for one visit', () => {
    expect(parseRoute('#/j/trips-012345abcd/0000000000000001')).toMatchObject({ name: 'space', tab: 'timeline', ref: { k: 'journey' } });
    const app = { navigate: vi.fn(), state: { route: { name: 'space', ref: tripRef, tab: 'plan' } } };
    newJourney(app);
    expect(app.navigate).toHaveBeenCalledWith('#/journeys');
    expect(readIntent()).toEqual({ trip: tripRef });
    expect(readIntent()).toBeNull();
  });
});

describe('editor patch', () => {
  it('sets changed fields and unsets cleared ones', () => {
    const before = { type: 'suggestion', title: 'A', date: '2027-05-01', mood: 'good', tags: ['x'] };
    expect(entryPatch(before, { type: 'checkin', title: 'A', date: '2027-05-01', mood: undefined, tags: ['x'], story: 'Nice' })).toEqual({ set: { type: 'checkin', story: 'Nice' }, unset: ['mood'] });
    expect(entryPatch(before, { ...before })).toEqual({});
  });
});

describe('photos near an entry', () => {
  function jpeg({ date = '2027:05:02 14:30:00', lat = [38, 42, 0], lng = [9, 8, 24] } = {}) {
    const encode = (text) => new TextEncoder().encode(text);
    const tiff = new Uint8Array(512);
    const view = new DataView(tiff.buffer);
    tiff.set([0x4d, 0x4d, 0x00, 0x2a]);
    view.setUint32(4, 8);
    const field = (at, tag, type, count, value) => { view.setUint16(at, tag); view.setUint16(at + 2, type); view.setUint32(at + 4, count); view.setUint32(at + 8, value); };
    view.setUint16(8, 2);
    field(10, 0x8769, 4, 1, 100);
    field(22, 0x8825, 4, 1, 200);
    view.setUint16(100, 1);
    field(102, 0x9003, 2, 20, 300);
    tiff.set(encode(`${date}\0`), 300);
    view.setUint16(200, 4);
    field(202, 1, 2, 2, 0);
    tiff.set(encode('N\0'), 210);
    field(214, 2, 5, 3, 400);
    field(226, 3, 2, 2, 0);
    tiff.set(encode('W\0'), 234);
    field(238, 4, 5, 3, 424);
    [...lat, ...lng].forEach((value, index) => { view.setUint32(400 + index * 8, value); view.setUint32(404 + index * 8, 1); });
    const payload = new Uint8Array([...encode('Exif\0\0'), ...tiff]);
    return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload, 0xff, 0xda, 0, 2]);
  }

  it('reads the capture date and position and scores matches', () => {
    const exif = readExif(jpeg());
    expect(exif.date).toBe('2027-05-02');
    expect(exif.time).toBe('14:30');
    expect(exif.lat).toBeCloseTo(38.7, 3);
    expect(exif.lng).toBeCloseTo(-9.14, 2);
    expect(readExif(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(nearbyScore(exif, { date: '2027-05-02', loc: { lat: 38.71, lng: -9.14 } })).not.toBeNull();
    expect(nearbyScore(exif, { date: '2027-05-04', loc: null })).toBeNull();
    expect(nearbyScore(exif, { date: '2027-05-02', loc: { lat: 41.15, lng: -8.63 } })).toBeNull();
    expect(nearbyScore(exif, { date: '2027-05-03', loc: null })).toBeGreaterThan(nearbyScore(exif, { date: '2027-05-02', loc: null }));
  });
});

describe('public journey data', () => {
  it('keeps well-formed entries and servable raster files, and orders newest days first on request', () => {
    const projection = cleanJourneyProjection({ ok: true, kind: 'journey', rev: 3, share: { timeline: true, gallery: true, newestFirst: true }, meta: { title: 'P', cover: 'f000000000000001', status: 'nope' },
      members: [{ id: '00000000-0000-0000-0000-000000000001', name: 'a…' }],
      files: ['f000000000000001', 'f000000000000002'],
      ents: [
        { t: 'entry', id: '1000000000000001', type: 'moment', date: '2027-05-01', title: 'One', order: 'V', media: ['f000000000000001', 'f000000000000009'] },
        { t: 'entry', id: '1000000000000002', type: 'moment', date: '2027-05-03', title: 'Three', order: 'V', story: 'x' },
        { t: 'entry', id: '1000000000000003', type: 'suggestion', date: '2027-05-02', title: 'S', order: 'V' },
        { t: 'entry', id: 'bad', type: 'moment', date: '2027-05-02', title: 'Bad', order: 'V' },
        { t: 'entry', id: '1000000000000004', type: 'moment', date: '2027-13-02', title: 'Bad date', order: 'V' },
        { t: 'file', id: 'f000000000000001', name: 'a.jpg', mime: 'image/jpeg', size: 4, desc: 'Cap', thumb: true },
        { t: 'file', id: 'f000000000000002', name: 'x.svg', mime: 'image/svg+xml', size: 4 },
      ] });
    expect(projection.entries.map((entry) => entry.id)).toEqual(['1000000000000001', '1000000000000002']);
    expect(projection.entries[0].media).toEqual(['f000000000000001']);
    expect([...projection.files.keys()]).toEqual(['f000000000000001']);
    expect(projection.meta).toEqual({ title: 'P', subtitle: '', status: null, cover: 'f000000000000001' });
    expect(projection.share).toMatchObject({ timeline: true, gallery: true, map: false, newestFirst: true });
    expect(orderedEntries(projection.entries, true).map((entry) => entry.title)).toEqual(['Three', 'One']);
  });
});
