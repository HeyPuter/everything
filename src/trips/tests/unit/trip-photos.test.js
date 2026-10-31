import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPhotoStore, folderImages, photoKey, photoMeta, photoPool, photosByDay, readPhotos } from '../../src/lib/photos/index.js';
import { personalKeys } from '../../src/lib/io/data-export.js';
import { mountTripPhotos, mountWithPhotos } from '../../src/views/trip/files/photos/index.js';
import { createSelectors } from '../../src/lib/store/query.js';
import { exifJpeg } from './helpers/exif-jpeg.js';

const SPACE = '0000000000000001';
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

describe('photo details', () => {
  it('reads the capture time and place from EXIF', () => {
    const meta = photoMeta(exifJpeg());
    expect(meta.taken).toEqual({ date: '2027-05-02', time: '14:30' });
    expect(meta.lat).toBeCloseTo(38.7, 3);
    expect(meta.lng).toBeCloseTo(-9.14, 2);
    expect(photoMeta(new Uint8Array([1, 2, 3]))).toEqual({});
  });
});

describe('private photo store', () => {
  function personalStub(initial = {}) {
    const values = { ...initial };
    return { values, get: async (key) => values[key] ?? null, set: async (key, value) => { values[key] = structuredClone(value); } };
  }
  let n = 0;
  const makeId = () => `ab${String(++n).padStart(14, '0')}`;

  it('adds drive files once, indexes the trip and keeps unknown junk out', async () => {
    const personal = personalStub();
    const puter = { kv: { update: vi.fn(async () => true) } };
    const store = createPhotoStore({ personal, puter, spaceId: SPACE, makeId, now: () => 5 });
    await store.add([{ uid: 'u1', name: 'a.jpg', path: '/me/a.jpg', taken: { date: '2027-05-02', time: '10:00' }, lat: 1, lng: 2 }, { uid: 'u1', name: 'dup.jpg' }, { name: 'no uid' }]);
    const value = personal.values[photoKey(SPACE)];
    expect(Object.values(value.items)).toEqual([{ uid: 'u1', name: 'a.jpg', path: '/me/a.jpg', taken: { date: '2027-05-02', time: '10:00' }, lat: 1, lng: 2, upd: 5 }]);
    expect(puter.kv.update).toHaveBeenCalledWith('me:photos', { [SPACE]: 5 });
    const [id] = Object.keys(value.items);
    await store.setShared(id, '0000000000000009');
    expect(readPhotos(personal.values[photoKey(SPACE)]).items.get(id).shared).toBe('0000000000000009');
    await store.setFolder({ uid: 'f', path: '/me/Trip', name: 'Trip' });
    expect(readPhotos(personal.values[photoKey(SPACE)]).folder).toEqual({ uid: 'f', path: '/me/Trip', name: 'Trip' });
    await store.remove(id);
    expect(readPhotos(personal.values[photoKey(SPACE)]).items.size).toBe(0);
  });

  it('reads stored values defensively', () => {
    expect(readPhotos(null)).toEqual({ folder: null, items: new Map() });
    expect(readPhotos({ v: 1, items: { bad: { uid: 'x' }, abababababababab: { uid: 'y', taken: { date: 'nope' }, lat: 99, lng: 0 } } }).items.get('abababababababab')).toEqual({ uid: 'y', name: 'photo', upd: 0 });
  });

  it('is part of "download all my data"', () => {
    const keys = personalKeys({ spaces: [{ ref: { s: SPACE } }], photos: { '0000000000000002': 1, bad: 1 } });
    expect(keys).toEqual(expect.arrayContaining(['me:photos', `me:photos:${SPACE}`, 'me:photos:0000000000000002']));
    expect(keys).not.toContain('me:photos:bad');
  });
});

describe('the pool', () => {
  const files = [
    { id: '0000000000000011', kind: 'photo', name: 'beach.jpg', taken: { date: '2027-05-02', time: '18:00' }, geo: { lat: 1, lng: 2 } },
    { id: '0000000000000012', kind: 'photo', name: 'gone.jpg', trashed: 5 },
    { id: '0000000000000013', kind: 'user', name: 'ticket.pdf' },
    { id: '0000000000000014', kind: 'photo', name: 'mine.jpg', taken: { date: '2027-05-01' } },
  ];
  const items = new Map([
    ['abababababababa1', { uid: 'u1', name: 'mine.jpg', shared: '0000000000000014', taken: { date: '2027-05-01' } }],
    ['abababababababa2', { uid: 'u2', name: 'private.jpg', taken: { date: '2027-05-02', time: '09:00' } }],
    ['abababababababa3', { uid: 'u3', name: 'old.jpg', taken: { date: '2019-01-01' } }],
  ]);
  const folderItems = [{ uid: 'u2', name: 'private.jpg' }, { uid: 'u4', name: 'undated.png' }];

  it('merges shared, private and folder photos once, by capture time', () => {
    const pool = photoPool({ files, items, folderItems });
    expect(pool.map((photo) => [photo.source, photo.name])).toEqual([
      ['private', 'old.jpg'], ['shared', 'mine.jpg'], ['private', 'private.jpg'], ['shared', 'beach.jpg'], ['folder', 'undated.png'],
    ]);
    expect(pool.find((photo) => photo.name === 'mine.jpg').mine).toBe('abababababababa1');
  });

  it('groups by trip day, then other dates and undated', () => {
    const groups = photosByDay(photoPool({ files, items, folderItems }), [{ id: 'd1', date: '2027-05-01' }, { id: 'd2', date: '2027-05-02' }]);
    expect(groups.map((group) => [group.dayId, group.photos.length])).toEqual([['d1', 1], ['d2', 2], ['other', 1], ['none', 1]]);
  });

  it('keeps only images from a linked folder', () => {
    expect(folderImages([{ uid: 'a', name: 'a.JPG', path: '/x/a.JPG' }, { uid: 'b', name: 'b.pdf' }, { uid: 'c', name: 'c', is_dir: true }])).toEqual([{ uid: 'a', name: 'a.JPG', path: '/x/a.JPG' }]);
  });
});

describe('photos in the Files tab', () => {
  const space = (fileList = []) => ({
    ref: { w: 'trips-abcdefghij', s: SPACE, k: 'trip' },
    select: createSelectors({ kind: 'trip', source: (type) => (type === 'file' ? fileList : type === 'day' ? [{ id: 'dddddddddddddddd', date: '2027-05-02', order: 'a' }] : []), get: () => null, subscribe: () => () => {} }),
    can: () => true, subscribe: () => () => {},
  });

  it('switches between files and photos and remembers the choice', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const files = vi.fn(() => () => {});
    const stop = mountWithPhotos(container, { space: space() }, (host) => { host.append('FILES'); return files(); });
    expect(container.textContent).toContain('FILES');
    const photosButton = [...container.querySelectorAll('.seg button')].find((node) => node.textContent === 'Photos');
    photosButton.click();
    expect(container.querySelector('.photos-view')).not.toBeNull();
    expect(localStorage.getItem(`trips:files:view:${SPACE}`)).toBe('photos');
    stop();
  });

  it('lists shared photos by day and private ones from the drive', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const personal = { get: async () => ({ v: 1, items: { abababababababa2: { uid: 'u2', name: 'private.jpg', taken: { date: '2027-05-02', time: '09:00' } } } }), set: async () => {} };
    const puter = { kv: { update: async () => {} }, fs: { read: async () => new Blob(['x']) } };
    const stop = mountTripPhotos(host, { space: space([{ id: '0000000000000011', kind: 'photo', name: 'beach.jpg', taken: { date: '2027-05-02', time: '18:00' } }]), personal, puter });
    await vi.waitFor(() => expect(host.querySelectorAll('.photos-tile')).toHaveLength(2));
    expect([...host.querySelectorAll('.photos-badge')].map((node) => node.textContent)).toEqual(['Only you', 'Shared']);
    expect(host.querySelector('.photos-day-title').textContent).toContain('2 photos');
    stop();
  });
});
