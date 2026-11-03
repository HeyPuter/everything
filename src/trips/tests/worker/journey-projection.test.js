// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { project } from '../../worker/engine/projection.js';
import { isPublicEntry } from '../../worker/engine/projection-journey.js';

const BOB = '00000000-0000-4000-8000-000000000002';
const ALICE = '00000000-0000-4000-8000-000000000001';
const trip = { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' };
const file = (id, fields = {}) => ({ t: 'file', id, name: `${id}.jpg`, mime: 'image/jpeg', size: 10, sha256: 'a'.repeat(64), kind: 'user', loc: { mode: 'proxied' }, ...fields });
const entry = (id, fields = {}) => ({ t: 'entry', id, type: 'moment', date: '2027-05-02', title: id, order: 'V', cr: 1, by: BOB, v: 'x', rev: 3, upd: 4, ...fields });

function snapshot() {
  return { rev: 9, at: 5, ents: [
    { t: 'meta', id: 'meta', title: 'Portugal', subtitle: 'Spring', status: 'completed', cover: 'cover00000000000', trips: [trip], fields: { mood: true }, showTracks: true, share: { on: true, since: 3 } },
    { t: 'member', id: ALICE, name: 'alice@example.com', role: 'owner', color: 2, cr: 1 },
    { t: 'member', id: BOB, name: 'bob', role: 'editor', cr: 2 },
    entry('open000000000000', { story: 'Hills.', mood: 'good', weather: 'clear', tags: ['tram'], pros: ['views'], cons: ['steep'], excluded: true, vis: 'public',
      loc: { name: 'Graça', cc: 'PT', lat: 38.7, lng: -9.1 }, media: ['photo00000000000', 'video00000000000', 'trash00000000000', 'gone000000000000'], src: { trip, placeId: 'place00000000000' }, secret: 'x' }),
    entry('member0000000000', { vis: 'members', media: ['private000000000'] }),
    entry('suggest000000000', { type: 'suggestion', src: { trip, placeId: 'place00000000000' } }),
    entry('dismiss000000000', { dismissed: true }),
    { t: 'entry', id: 'deleted000000000', deleted: true },
    { t: 'book', id: 'book000000000000', fileId: 'doc0000000000000' },
    file('cover00000000000'), file('photo00000000000', { desc: 'Top', thumb: 'th00000000000000', links: [{ t: 'entry', id: 'member0000000000' }] }),
    file('video00000000000', { mime: 'video/mp4' }), file('trash00000000000', { trashed: 1 }), file('private000000000', { desc: 'Home' }),
    file('doc0000000000000', { mime: 'application/json', kind: 'book' }),
  ] };
}

describe('journey projection', () => {
  it('lists only written, shared entries', () => {
    expect(isPublicEntry({ t: 'entry', type: 'moment' })).toBe(true);
    for (const hidden of [{ type: 'suggestion' }, { dismissed: true }, { vis: 'members' }, { deleted: true }]) expect(isPublicEntry({ t: 'entry', ...hidden })).toBe(false);
    const view = project(snapshot(), 'journey', { on: true, timeline: true, gallery: true });
    expect(view.ents.filter((item) => item.t === 'entry').map((item) => item.id)).toEqual(['open000000000000']);
  });

  it('copies entry fields by allowlist and strips coordinates without the map', () => {
    const view = project(snapshot(), 'journey', { on: true, timeline: true });
    const [item] = view.ents.filter((entity) => entity.t === 'entry');
    expect(item).toEqual({
      t: 'entry', id: 'open000000000000', title: 'open000000000000', date: '2027-05-02', type: 'moment', order: 'V', cr: 1,
      story: 'Hills.', mood: 'good', weather: 'clear', tags: ['tram'], pros: ['views'], cons: ['steep'], loc: { name: 'Graça', cc: 'PT' }, media: ['photo00000000000'],
    });
    expect(project(snapshot(), 'journey', { on: true, timeline: true, map: true }).ents.find((entity) => entity.t === 'entry').loc).toEqual({ name: 'Graça', cc: 'PT', lat: 38.7, lng: -9.1 });
  });

  it('serves raster photos of public entries and the cover, with captions and no links', () => {
    const view = project(snapshot(), 'journey', { on: true, gallery: true, timeline: false });
    expect(view.files.sort()).toEqual(['cover00000000000', 'photo00000000000']);
    const files = view.ents.filter((entity) => entity.t === 'file');
    expect(files.find((item) => item.id === 'photo00000000000')).toEqual({ t: 'file', id: 'photo00000000000', name: 'photo00000000000.jpg', mime: 'image/jpeg', size: 10, desc: 'Top', thumb: true });
    expect(files.find((item) => item.id === 'cover00000000000').desc).toBeUndefined();
    const [item] = view.ents.filter((entity) => entity.t === 'entry');
    expect(item.story).toBeUndefined();
    expect(item.media).toEqual(['photo00000000000']);
  });

  it('shares nothing but meta and members when every section is off', () => {
    const view = project(snapshot(), 'journey', { on: true, timeline: false });
    expect(view.ents.filter((entity) => entity.t === 'entry')).toEqual([]);
    expect(view.files).toEqual(['cover00000000000']);
  });

  it('keeps meta public fields only and aliases members', () => {
    const view = project(snapshot(), 'journey', { on: true, newestFirst: true });
    expect(view.meta).toEqual({ title: 'Portugal', subtitle: 'Spring', status: 'completed', cover: 'cover00000000000' });
    expect(view.share).toEqual({ timeline: true, gallery: false, map: false, newestFirst: true, exp: null });
    expect(view.members.map((member) => member.name)).toEqual(['A.', 'B.']);
    const text = JSON.stringify(view);
    for (const leak of [ALICE, BOB, 'trips-abcdefghij', 'secret', 'Home', 'private000000000', 'video00000000000', 'book', 'showTracks', 'excluded', '"vis"', '"by"']) expect(text).not.toContain(leak);
  });

  it('keeps a non-image cover out', () => {
    const data = snapshot();
    data.ents[0].cover = 'doc0000000000000';
    expect(project(data, 'journey', { on: true }).meta.cover).toBeUndefined();
    data.ents[0].cover = { url: 'https://images.example/a.jpg', credit: 'A' };
    expect(project(data, 'journey', { on: true }).meta.cover).toEqual({ url: 'https://images.example/a.jpg', credit: 'A' });
  });
});
