import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { ApiError } from '../../src/lib/api.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createClock } from '../../src/shared/hlc.js';
import { structure } from '../../src/lib/book/model.js';
import { mount } from '../../src/views/journey/book/index.js';
import { booksOf, createBook } from '../../src/views/journey/book/editor.js';

const uid = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'journey' };
const clock = createClock({ node: '0000000000000007', now: () => 1_000_000 });
const server = (t, id, fields) => ({ t, id, ...fields, v: clock.tick(), rev: 1, upd: 1000, by: bob, cr: 1000 });
const photo = (id, name) => server('file', id, { name, mime: 'image/jpeg', size: 10, sha256: 'a'.repeat(64), kind: 'user', loc: { mode: 'proxied' }, links: [{ t: 'entry', id: '1000000000000001' }] });
const open = [];
const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
const byText = (root, text, selector = 'button') => [...root.querySelectorAll(selector)].find((node) => node.textContent.trim().startsWith(text));

async function setup(role = 'editor') {
  const fake = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
  const puter = fake.client(uid);
  const db = await openDatabase(uid, { indexedDB: new IDBFactory() });
  const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 1, changes: [] })), snapshot: vi.fn(), request: vi.fn(),
    download: vi.fn(async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0])], { type: 'image/jpeg' })) };
  const personal = createPersonalStore({ puter, db });
  const space = await openSpace({ ref, db, api, puter, personal, role, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false });
  await space.store.replace({ rev: 1, ents: [
    server('member', uid, { name: 'Me', role }),
    server('meta', 'meta', { title: 'Portugal', subtitle: 'Spring walk' }),
    server('entry', '1000000000000001', { type: 'day', date: '2027-05-01', title: 'Arrival', story: 'We **landed**.', order: 'V', media: ['2000000000000001', '2000000000000002'], loc: { lat: 38.7, lng: -9.1, cc: 'PT' } }),
    server('entry', '1000000000000002', { type: 'moment', date: '2027-05-02', title: 'Sintra', order: 'V', loc: { lat: 38.8, lng: -9.4, cc: 'PT' } }),
    photo('2000000000000001', 'a.jpg'), photo('2000000000000002', 'b.jpg'),
  ] });
  const container = document.createElement('div');
  document.body.append(container);
  const context = { space, ref, route: { name: 'space', ref, tab: 'book' }, account: { uuid: uid }, personal, puter, session: { api, db, personal }, app: { navigate: vi.fn(), setSyncState: vi.fn() } };
  const cleanup = mount(container, { space, context, ref });
  open.push({ cleanup, space });
  await frame();
  return { space, container, context };
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); })); });
afterEach(() => {
  for (const entry of open.splice(0)) { entry.cleanup?.(); entry.space?.close(); }
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('photo-book tab', () => {
  it('offers to create a book, and only to editors', async () => {
    const { container } = await setup();
    expect(byText(container, 'Create photo book')).toBeTruthy();
    const viewer = await setup('viewer');
    expect(byText(viewer.container, 'Create photo book')).toBeFalsy();
    expect(viewer.container.textContent).toContain('An editor of this journey');
  });

  it('fills a new book from the journey and opens it in the editor', async () => {
    const { space, container } = await setup();
    const id = await createBook(space, { title: 'Portugal', fmt: 'a4l', fill: true });
    await vi.waitFor(() => expect(container.querySelector('.bk-editor')).toBeTruthy());
    expect(booksOf(space).map((book) => book.id)).toEqual([id]);
    const shape = structure(space.select.bookPage.all(), id);
    expect(shape.sheets.map((sheet) => sheet.page.kind)).toEqual(['cover', 'first', 'spread', 'spread', 'last', 'back']);
    expect(container.querySelectorAll('.bk-pages .bk-page')).toHaveLength(6);
    expect(container.querySelector('.bk-title').textContent).toContain('Portugal');
    const cover = Object.values(shape.cover.els);
    expect(cover.find((item) => item.k === 'photo').file).toBe('2000000000000001');
    expect(container.querySelector('.bk-stage .bk-sheet[data-kind="cover"]')).toBeTruthy();
    expect(container.querySelector('.bk-stage .bk-text').textContent).toBe('Portugal');
  });

  it('adds elements from the rail, undoes them and applies a layout with a base version', async () => {
    const { space, container } = await setup();
    const id = await createBook(space, { title: 'Portugal', fmt: 'sq21', fill: false });
    await vi.waitFor(() => expect(container.querySelector('.bk-editor')).toBeTruthy());
    byText(container, 'Pages 2–3').click();
    await frame();
    const spread = () => structure(space.select.bookPage.all(), id).spreads[0];
    const before = Object.keys(spread().els ?? {}).length;
    byText(container, 'Elements', '.tab').click();
    await frame();
    byText(container, 'Quote').click();
    await vi.waitFor(() => expect(Object.keys(spread().els).length).toBe(before + 1));
    expect(Object.values(spread().els).some((item) => item.k === 'text' && item.style === 'quote')).toBe(true);
    expect(container.querySelector('.bk-props h3').textContent).toContain('Text');
    container.querySelector('[aria-label="Undo"]').click();
    await vi.waitFor(() => expect(Object.keys(spread().els).length).toBe(before));
    byText(container, 'Layouts', '.tab').click();
    await frame();
    container.querySelector('[aria-label="Apply layout: Mosaic"]').click();
    await vi.waitFor(() => expect(spread().layout).toBe('spread-mosaic'));
    expect(Object.values(spread().els).filter((item) => item.k === 'photo')).toHaveLength(5);
  });

  it('adds journey photos into empty frames from the content rail', async () => {
    const { space, container } = await setup();
    const id = await createBook(space, { title: 'Portugal', fmt: 'sq21', fill: false });
    await vi.waitFor(() => expect(container.querySelector('.bk-editor')).toBeTruthy());
    byText(container, 'Pages 2–3').click();
    byText(container, 'Content', '.tab').click();
    await frame();
    container.querySelector('[aria-label^="Add photo b.jpg"]').click();
    const spread = () => structure(space.select.bookPage.all(), id).spreads[0];
    await vi.waitFor(() => expect(Object.values(spread().els).filter((item) => item.file === '2000000000000002')).toHaveLength(1));
    expect(Object.values(spread().els).filter((item) => item.k === 'photo')).toHaveLength(2);
  });
});
