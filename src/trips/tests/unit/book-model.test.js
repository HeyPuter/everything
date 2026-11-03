// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createIdGenerator, isId } from '../../src/shared/ids.js';
import { isOrder } from '../../src/shared/order.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import { validateOperation } from '../../src/shared/operations.js';
import { BLEED_MM, formatFields, pageSize, sheetSize } from '../../src/lib/book/formats.js';
import { COVER_LAYOUTS, SPREAD_LAYOUTS, bestLayout, layoutsFor, slotBox } from '../../src/lib/book/layouts.js';
import { applyLayout, autoLayout, bookPages, clampBox, elementsOf, missingKinds, restack, structure, trimElements, usedPhotos } from '../../src/lib/book/model.js';
import { duplicateFields, insertOrders, moveOrder, spreadIndex } from '../../src/lib/book/order.js';
import { createBookOps, elementChange, replacePage, withoutBase } from '../../src/lib/book/ops.js';
import { autofillPlan, clip, dayStories, plainText } from '../../src/lib/book/autofill.js';
import { exportDesign, parseDesign } from '../../src/lib/book/design.js';
import { photoRect, wrapText } from '../../src/lib/book/raster.js';
import { fitView, flagEmoji, projector, scopedPoints } from '../../src/lib/book/travel.js';

const makeId = createIdGenerator({ now: () => 1_800_000_000_000, random: (bytes) => bytes.fill(7) });
const book = { fmt: 'sq21' };
const BOOK = makeId();
const page = (kind, els = {}, extra = {}) => ({ id: makeId(), book: BOOK, kind, order: 'V', els, ...extra });
const F = (name) => name.padStart(16, '0');
const photo = (file, x = 0.1, y = 0.1, extra = {}) => ({ k: 'photo', ...(file ? { file: F(file) } : {}), x, y, w: 0.3, h: 0.3, z: 1, ...extra });
const text = (value, style = 'body', extra = {}) => ({ k: 'text', text: value, style, x: 0.1, y: 0.6, w: 0.3, h: 0.1, z: 2, ...extra });
const valid = (fields) => validateEntity('journey', 'bookPage', fields);

describe('book formats', () => {
  it('sizes pages and spreads in mm and clamps custom sizes', () => {
    expect(pageSize({ fmt: 'a4l' })).toEqual({ w: 297, h: 210 });
    expect(pageSize({})).toEqual({ w: 210, h: 210 });
    expect(sheetSize({ fmt: 'a5l' }, 'spread')).toEqual({ w: 420, h: 148 });
    expect(pageSize({ fmt: 'custom', w: 10, h: 9000 })).toEqual({ w: 50, h: 600 });
    expect(formatFields('custom', { w: '180.4', h: 'x' })).toEqual({ fmt: 'custom', w: 180, h: 210 });
    expect(formatFields('nope')).toEqual({ fmt: 'sq21' });
  });
});

describe('book layouts', () => {
  it('has 13 spread layouts and 5 cover layouts with slots inside the sheet', () => {
    expect(SPREAD_LAYOUTS).toHaveLength(13);
    expect(COVER_LAYOUTS).toHaveLength(5);
    expect(new Set([...SPREAD_LAYOUTS, ...COVER_LAYOUTS].map((item) => item.id)).size).toBe(18);
    for (const item of [...SPREAD_LAYOUTS, ...COVER_LAYOUTS]) {
      for (const slot of item.slots) {
        expect(slot.x).toBeGreaterThanOrEqual(0);
        expect(slot.y).toBeGreaterThanOrEqual(0);
        expect(slot.x + slot.w).toBeLessThanOrEqual(1.0001);
        expect(slot.y + slot.h).toBeLessThanOrEqual(1.0001);
      }
    }
    expect(layoutsFor('first')).toBe(COVER_LAYOUTS);
    expect(layoutsFor('spread')).toBe(SPREAD_LAYOUTS);
  });

  it('keeps spread text off the gutter', () => {
    for (const item of SPREAD_LAYOUTS) {
      for (const slot of item.slots.filter((entry) => entry.k === 'text')) expect(slot.x >= 0.5 || slot.x + slot.w <= 0.5).toBe(true);
    }
  });

  it('grows full-bleed slots into the bleed on outer edges only', () => {
    const sheet = { w: 420, h: 210 };
    const panorama = SPREAD_LAYOUTS.find((item) => item.id === 'spread-panorama').slots[0];
    const box = slotBox(panorama, sheet);
    expect(box.x).toBeCloseTo(-BLEED_MM / 420);
    expect(box.w).toBeCloseTo(1 + 2 * BLEED_MM / 420);
    expect(box.h).toBeCloseTo(1 + 2 * BLEED_MM / 210);
    const leftHalf = SPREAD_LAYOUTS.find((item) => item.id === 'spread-pair').slots[0];
    const half = slotBox(leftHalf, sheet);
    expect(half.x + half.w).toBeCloseTo(0.5);
  });

  it('picks the layout that fits the content and rotates between equal ones', () => {
    expect(bestLayout('spread', { photos: 1 }).id).toBe('spread-panorama');
    expect(bestLayout('spread', { photos: 8 }).id).toBe('spread-eight');
    expect(bestLayout('spread', { photos: 6 }).id).toBe('spread-six');
    expect(bestLayout('spread', { photos: 1, texts: 2 }).id).toMatch(/^spread-(photo-story|story-photo)$/);
    expect(bestLayout('spread', { photos: 1, texts: 2 }, { variant: 0 }).id).not.toBe(bestLayout('spread', { photos: 1, texts: 2 }, { variant: 1 }).id);
    expect(bestLayout('cover', { photos: 1, texts: 2 }).id).toBe('cover-full');
    expect(bestLayout('cover', { photos: 4, texts: 2 }).id).toBe('cover-grid');
    expect(bestLayout('spread', { photos: 30 }).id).toBe('spread-eight');
  });
});

describe('applying layouts', () => {
  it('places photos and texts into slots and fills empty slots with placeholders', () => {
    const source = page('spread', { [makeId()]: photo('f1', 0.6, 0.1), [makeId()]: photo('f2', 0.1, 0.1), [makeId()]: text('Story'), [makeId()]: text('Day 1', 'title') });
    const result = applyLayout(source, 'spread-journal', { book, makeId });
    expect(result.layout).toBe('spread-journal');
    const items = elementsOf({ els: result.els });
    expect(items).toHaveLength(5);
    const photos = items.filter((item) => item.k === 'photo');
    expect(photos.map((item) => item.file ?? null)).toEqual([F('f2'), F('f1'), null]);
    const title = items.find((item) => item.text === 'Day 1');
    expect(title.x).toBeLessThan(0.5);
    expect(title.y).toBeCloseTo(0.1);
    expect(items.find((item) => item.text === 'Story').y).toBeCloseTo(0.22);
    expect(valid({ book: BOOK, kind: 'spread', order: 'V', layout: result.layout, els: result.els })).toBeTruthy();
  });

  it('keeps extra content and decorations, drops empty leftovers', () => {
    const decoration = makeId();
    const els = { [decoration]: { k: 'icon', icon: 'plane', x: 0.4, y: 0.4, w: 0.05, h: 0.05, z: 9 } };
    for (let index = 0; index < 3; index++) els[makeId()] = photo(`f${index}`, index * 0.2);
    els[makeId()] = photo(undefined, 0.9);
    els[makeId()] = text('', 'caption');
    const result = applyLayout(page('spread', els), 'spread-panorama', { book, makeId });
    const items = elementsOf({ els: result.els });
    expect(items.filter((item) => item.k === 'photo')).toHaveLength(3);
    expect(items.some((item) => item.k === 'text')).toBe(false);
    expect(items.at(-1).id).toBe(decoration);
    expect(items.find((item) => item.file === F('f0')).w).toBeGreaterThan(1);
  });

  it('auto layout counts only filled content', () => {
    const els = { [makeId()]: photo('a'), [makeId()]: photo(undefined), [makeId()]: text('  ') };
    expect(autoLayout(page('spread', els), { book, makeId }).layout).toBe('spread-panorama');
  });

  it('rejects unknown layouts', () => {
    expect(() => applyLayout(page('spread'), 'nope', { book, makeId })).toThrow('unknown_layout');
  });

  it('restacks, clamps and trims', () => {
    const [a, b, c] = [makeId(), makeId(), makeId()];
    const target = page('spread', { [a]: photo('a', 0, 0, { z: 1 }), [b]: photo('b', 0, 0, { z: 2 }), [c]: photo('c', 0, 0, { z: 3 }) });
    expect(restack(target, a, 'front')).toEqual({ [b]: 1, [c]: 2, [a]: 3 });
    expect(restack(target, c, 'back')).toEqual({ [c]: 1, [a]: 2, [b]: 3 });
    expect(restack(target, b, 'up')).toEqual({ [c]: 2, [b]: 3 });
    expect(restack(target, a, 'down')).toEqual({});
    expect(clampBox({ x: 5, y: -5, w: 0, h: 9 })).toEqual({ x: 0.9967, y: -0.8, w: 0.01, h: 1.2 });
    const many = Object.fromEntries(Array.from({ length: 90 }, (_, z) => [makeId(), photo('x', 0, 0, { z })]));
    expect(Object.keys(trimElements(many))).toHaveLength(80);
  });
});

describe('book structure and page order', () => {
  it('orders pages, numbers them and reports missing singles', () => {
    const spreads = ['b', 'a', 'c'].map((order) => page('spread', {}, { order }));
    const pages = [page('back'), ...spreads, page('last'), page('cover', {}, { cr: 2 }), page('first'), page('cover', {}, { cr: 1 }), { ...page('spread'), deleted: true }, page('spread', {}, { book: makeId() })];
    expect(bookPages(pages, BOOK).map((item) => item.kind)).toEqual(['cover', 'cover', 'first', 'spread', 'spread', 'spread', 'last', 'back']);
    const shape = structure(pages, BOOK);
    expect(shape.spreads.map((item) => item.order)).toEqual(['a', 'b', 'c']);
    expect(shape.cover.cr).toBe(1);
    expect(shape.extras).toHaveLength(1);
    expect(shape.sheets.map((sheet) => sheet.numbers)).toEqual([[], [1], [2, 3], [4, 5], [6, 7], [8], []]);
    expect(spreadIndex(shape, 3)).toBe(1);
    expect(spreadIndex(shape, 0)).toBe(-1);
    expect(missingKinds(structure([page('cover'), page('last')], BOOK))).toEqual(['first', 'back']);
  });

  it('computes order keys for moves and inserts', () => {
    const spreads = ['B', 'M', 'T'].map((order) => ({ order }));
    expect(moveOrder(spreads, 0, 2) > 'T').toBe(true);
    const middle = moveOrder(spreads, 2, 0);
    expect(middle < 'B' && isOrder(middle)).toBe(true);
    const between = moveOrder(spreads, 0, 1);
    expect(between > 'M' && between < 'T').toBe(true);
    expect(moveOrder(spreads, 1, 1)).toBeNull();
    const inserted = insertOrders(spreads, 1, 3);
    expect(inserted).toHaveLength(3);
    expect(inserted.every((key) => key > 'B' && key < 'M')).toBe(true);
    expect([...inserted].sort()).toEqual(inserted);
    expect(insertOrders([], 0, 2)).toHaveLength(2);
    // Crossed keys from concurrent moves still give a usable key.
    expect(isOrder(moveOrder([{ order: 'M' }, { order: 'M' }, { order: 'A' }], 2, 1))).toBe(true);
  });

  it('duplicates a spread with fresh element ids', () => {
    const id = makeId();
    const source = page('spread', { [id]: photo('a') }, { layout: 'spread-pair', bg: 'surface-2' });
    const copy = duplicateFields(source, { makeId, order: 'X' });
    expect(Object.keys(copy.els)).toHaveLength(1);
    expect(Object.keys(copy.els)[0]).not.toBe(id);
    expect(copy).toMatchObject({ book: BOOK, kind: 'spread', order: 'X', layout: 'spread-pair', bg: 'surface-2' });
    expect(valid(copy)).toBeTruthy();
  });
});

describe('book ops', () => {
  const ops = {
    create: (t, put) => ({ opId: makeId(), t, id: makeId(), put }),
    patch: (t, id, { set, unset } = {}, { base = false } = {}) => ({ opId: makeId(), t, id, ...(set && Object.keys(set).length ? { set } : {}), ...(unset?.length ? { unset } : {}), ...(base ? { base: '00cre66i9s:000000:1m5s565zesh4tfkm' } : {}) }),
  };

  it('creates a book with four singles and ordered spreads that validate', () => {
    const { id, ops: list } = createBookOps(ops, { title: 'Lisbon', fmt: 'a4l' }, { spreads: [{ layout: 'spread-pair' }, {}] });
    expect(isId(id)).toBe(true);
    expect(list.map((op) => op.put.kind ?? 'book')).toEqual(['book', 'cover', 'first', 'last', 'back', 'spread', 'spread']);
    for (const op of list) expect(() => validateOperation(op, { kind: 'journey' })).not.toThrow();
    expect(list[5].put.order < list[6].put.order).toBe(true);
  });

  it('writes element fields as paths and replaces pages with a base', () => {
    const pid = makeId();
    const eid = makeId();
    const change = elementChange(ops, pid, eid, { x: 0.2, lock: undefined });
    expect(change.set).toEqual({ [`els.${eid}.x`]: 0.2 });
    expect(change.unset).toEqual([`els.${eid}.lock`]);
    expect(() => validateOperation(change, { kind: 'journey' })).not.toThrow();
    const replace = replacePage(ops, pid, { layout: 'spread-pair', els: { [eid]: photo('f') } });
    expect(replace.base).toBeTruthy();
    expect(() => validateOperation(replace, { kind: 'journey' })).not.toThrow();
    expect(withoutBase([replace])[0].base).toBeUndefined();
    expect(replacePage(ops, pid, { els: {} }).unset).toEqual(['els', 'layout']);
  });
});

describe('auto-fill from a journey', () => {
  const entries = [
    { id: F('e1'), type: 'day', date: '2027-05-01', title: 'Arrival', story: '# Hello\nWe **landed** in [Lisbon](https://x.example).', media: ['p1', 'p2', 'v1'].map(F), loc: { lat: 38.7, lng: -9.1 } },
    { id: F('e2'), type: 'moment', date: '2027-05-01', title: 'Tram 28', story: 'Rattling *uphill*.', media: ['p2', 'p3'].map(F) },
    { id: F('e3'), type: 'moment', date: '2027-05-02', title: 'Sintra', media: Array.from({ length: 13 }, (_, i) => F(`s${i}`)) },
    { id: F('e4'), type: 'moment', date: '2027-05-03', title: 'Quiet day' },
  ];
  const isPhoto = (id) => !id.endsWith('v1');

  it('turns markdown into plain text and clips long text at a word', () => {
    expect(plainText('# Title\n- one\n- two\n> quote *em* `code` [link](https://a.b)')).toBe('Title\n• one\n• two\nquote em code link');
    expect(clip('alpha beta gamma delta', 12)).toBe('alpha beta…');
    expect(clip('short', 12)).toBe('short');
  });

  it('groups photos by day once each and skips what the book already has', () => {
    const days = dayStories(entries, { isPhoto });
    expect(days.map((day) => day.photos.length)).toEqual([3, 13, 0]);
    expect(days[0].title).toBe('2027-05-01 · Arrival');
    expect(days[0].body).toBe('Arrival\nHello\nWe landed in Lisbon.\n\nTram 28\nRattling uphill.');
    const later = dayStories(entries, { isPhoto, used: new Set(['p1', 'p2', 'p3'].map(F)), usedEntries: new Set(['e1', 'e2', 'e4'].map(F)) });
    expect(later.map((day) => day.date)).toEqual(['2027-05-02']);
  });

  it('plans spreads per day, splitting big days, and the single pages', () => {
    const plan = autofillPlan({ entries, meta: { title: 'Portugal' }, book, makeId, isPhoto, range: 'May 2027' });
    expect(plan.spreads.map((item) => Object.values(item.els).filter((el) => el.k === 'photo' && el.file).length)).toEqual([3, 4, 8, 1, 0]);
    expect(Object.values(plan.spreads[0].els).some((el) => el.k === 'text' && el.text.startsWith('2027-05-01'))).toBe(true);
    expect(Object.values(plan.spreads[2].els).some((el) => el.k === 'text')).toBe(false);
    expect(plan.singles.cover.layout).toBe('cover-full');
    expect(Object.values(plan.singles.cover.els).find((el) => el.k === 'photo').file).toBe(F('p1'));
    expect(Object.values(plan.singles.first.els).every((el) => el.k === 'text')).toBe(true);
    expect(Object.values(plan.singles.last.els).map((el) => el.k)).toEqual(['map', 'stats']);
    const { ops: list } = createBookOps({ create: (t, put) => ({ opId: makeId(), t, id: makeId(), put }) }, { title: 'Portugal' }, plan);
    for (const op of list) expect(() => validateOperation(op, { kind: 'journey' })).not.toThrow();
    expect(usedPhotos(list.filter((op) => op.t === 'bookPage').map((op) => op.put)).size).toBe(16);
  });

  it('respects the spread room', () => {
    expect(autofillPlan({ entries, book, makeId, isPhoto, room: 2, singles: false }).spreads).toHaveLength(2);
  });
});

describe('spread design files', () => {
  it('round-trips a design and cleans what does not belong', () => {
    const els = { [makeId()]: photo('aaa'), [makeId()]: text('Hi', 'title') };
    const design = exportDesign(page('spread', els, { layout: 'spread-pair', bg: 'day-2' }), { book });
    const raw = JSON.stringify({ ...design, els: [...design.els, { k: 'photo', x: 0, y: 0, w: 1, h: 1, z: 1, file: '0000000000000bbb' }, { k: 'virus', x: 0, y: 0, w: 1, h: 1, z: 1 }, { k: 'text', x: 0, y: 0, w: 1, h: 1, z: 1, color: 'red' }, 'x'] });
    const parsed = parseDesign(raw, { kind: 'spread', makeId, hasFile: (id) => id === '0000000000000aaa' });
    expect(parsed.layout).toBe('spread-pair');
    expect(parsed.bg).toBe('day-2');
    expect(parsed.skipped).toBe(3);
    const items = Object.values(parsed.els);
    expect(items).toHaveLength(3);
    expect(items.filter((item) => item.file)).toHaveLength(1);
    expect(() => parseDesign(raw, { kind: 'cover', makeId })).toThrow('design_kind');
    expect(() => parseDesign('{', { kind: 'spread', makeId })).toThrow('design_invalid');
    expect(() => parseDesign(JSON.stringify({ format: 'other', version: 1, els: [] }), { kind: 'spread', makeId })).toThrow('design_invalid');
  });
});

describe('export drawing helpers', () => {
  it('places photos like object-fit with a focal point and zoom', () => {
    expect(photoRect({ w: 200, h: 100 }, { w: 100, h: 100 })).toEqual({ x: -50, y: 0, w: 200, h: 100 });
    expect(photoRect({ w: 200, h: 100 }, { w: 100, h: 100 }, { fx: 0 })).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(photoRect({ w: 200, h: 100 }, { w: 100, h: 100 }, { fit: 'fit' })).toEqual({ x: 0, y: 25, w: 100, h: 50 });
    expect(photoRect({ w: 100, h: 100 }, { w: 100, h: 100 }, { zoom: 2, fx: 1, fy: 1 })).toEqual({ x: -100, y: -100, w: 200, h: 200 });
  });

  it('wraps text at spaces and inside long words', () => {
    const measure = (value) => value.length;
    expect(wrapText('one two three', 7, measure)).toEqual(['one two', 'three']);
    expect(wrapText('abcdefghij', 4, measure)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText('a\n\nb', 4, measure)).toEqual(['a', '', 'b']);
  });

  it('fits maps around points and scopes them to a page', () => {
    const entries = [{ id: 'a', loc: { lat: 38.7, lng: -9.1 } }, { id: 'b', loc: { lat: 41.1, lng: -8.6 } }, { id: 'c' }];
    const view = fitView(scopedPoints(entries, null, 'book'), 2);
    expect(view.spanX / view.spanY).toBeCloseTo(2);
    const project = projector(view, 200, 100);
    for (const entry of entries.slice(0, 2)) {
      const [x, y] = project(entry.loc.lng, entry.loc.lat);
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(200); expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(100);
    }
    expect(scopedPoints(entries, { els: { x: { entry: 'b' } } }, 'page').map((point) => point.id)).toEqual(['b']);
    expect(scopedPoints(entries, { els: {} }, 'page')).toHaveLength(2);
    expect(flagEmoji('PT')).toBe('🇵🇹');
    expect(flagEmoji('pt')).toBe('');
  });
});
