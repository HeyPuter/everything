// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/shared/limits.js';
import { immichClient, photoFromAsset, photoOriginal, photoThumbnail, searchPhotos, verifyImmich } from '../../src/lib/integrations/immich.js';
import { fakeNet, fixture } from './helpers/fake-net.js';

const config = { url: 'https://photos.example.com/', key: 'immich-key' };

describe('Immich adapter', () => {
  it('verifies the key with the x-api-key header', async () => {
    const net = fakeNet({ 'GET /api/users/me': () => ({ json: { id: 'f1e2', name: 'Alice', email: 'a@example.com' } }) });
    expect(await verifyImmich(immichClient(net.puter, config))).toEqual({ user: { id: 'f1e2', name: 'Alice' } });
    expect(net.calls[0].headers['x-api-key']).toBe('immich-key');
    expect(net.calls[0].headers.authorization).toBeUndefined();
  });

  it('searches photos by capture date with a day of slack and pages on', async () => {
    const net = fakeNet({ 'POST /api/search/metadata': () => ({ json: fixture('immich-search.json') }) });
    const { photos, next } = await searchPhotos(immichClient(net.puter, config), { from: '2026-05-02', to: '2026-05-09', page: 1 });
    expect(net.calls[0].body).toEqual({ takenAfter: '2026-05-01T00:00:00.000Z', takenBefore: '2026-05-11T00:00:00.000Z', page: 1, size: 100, withExif: true, order: 'asc', type: 'IMAGE' });
    expect(next).toBe(2);
    expect(photos).toEqual([
      { id: '4f0c1a52-1b2e-4c0a-9a33-0d8e1f2b3c4d', name: 'IMG_2041.HEIC', mime: 'image/heic', takenAt: '2026-05-03T09:12:44.000Z', date: '2026-05-03', time: '05:12', lat: 40.7484, lng: -73.9857, size: 2483112, video: false },
      { id: '8a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'clip_.._evil.mov', mime: 'video/quicktime', takenAt: '2026-05-04T14:00:00.000Z', date: '2026-05-04', time: '14:00', lat: null, lng: null, size: 81234567, video: true },
    ]);
    await expect(searchPhotos(immichClient(net.puter, config), { from: '2026-05-09', to: '2026-05-02' })).rejects.toMatchObject({ code: 'rejected' });
  });

  it('drops assets with unsafe ids and trashed ones', () => {
    expect(photoFromAsset({ id: '../../admin' })).toBeNull();
    expect(photoFromAsset({ id: 'abc', isTrashed: true })).toBeNull();
    expect(photoFromAsset({ id: 'abc' })).toMatchObject({ name: 'abc.jpg', takenAt: null, date: null, time: null });
  });

  it('downloads thumbnails and originals, refusing files over the trip limit', async () => {
    const id = '4f0c1a52-1b2e-4c0a-9a33-0d8e1f2b3c4d';
    const net = fakeNet({
      [`GET /api/assets/${id}/thumbnail`]: () => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/webp' } }),
      [`GET /api/assets/${id}/original`]: () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'image/heic' } }),
    });
    const client = immichClient(net.puter, config);
    const thumb = await photoThumbnail(client, id);
    expect(thumb.type).toBe('image/webp');
    expect(net.calls[0].url.search).toBe('?size=thumbnail');
    const file = await photoOriginal(client, { id, name: 'IMG.HEIC', mime: 'image/heic', size: 4 });
    expect(file).toBeInstanceOf(File);
    expect([file.name, file.size, file.type]).toEqual(['IMG.HEIC', 4, 'image/heic']);
    await expect(photoOriginal(client, { id, name: 'big.mov', size: LIMITS.fileBytes + 1 })).rejects.toMatchObject({ code: 'too_large' });
    await expect(photoThumbnail(client, '../x')).rejects.toMatchObject({ code: 'rejected' });
  });
});
