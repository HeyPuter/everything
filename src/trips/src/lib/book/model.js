// Pure photo-book model: book structure, page numbers, elements and applying layouts.
import { BOOK_LIMITS, SINGLE_KINDS } from './constants.js';
import { sheetSize } from './formats.js';
import { bestLayout, layoutById, roleText, slotBox } from './layouts.js';

const RANK = Object.freeze({ cover: 0, first: 1, spread: 2, last: 3, back: 4 });
const live = (page) => page && !page.deleted;
export const round = (value) => Math.round(value * 10_000) / 10_000;

/** Live pages of one book in book order: cover, first page, spreads by `order`, last page, back cover. */
export function bookPages(pages, bookId) {
  return pages.filter((page) => live(page) && page.book === bookId && Object.hasOwn(RANK, page.kind)).sort((a, b) => (
    RANK[a.kind] - RANK[b.kind] || (a.order < b.order ? -1 : a.order > b.order ? 1 : 0) || (a.cr ?? 0) - (b.cr ?? 0) || (a.id < b.id ? -1 : 1)));
}

/**
 * `{cover, first, spreads, last, back, sheets}` with one page per single kind (the oldest wins if two members
 * created one at once; the extra is listed in `extras`). `sheets` carry printed page numbers: none on the covers,
 * 1 on the first page, two per spread.
 */
export function structure(pages, bookId) {
  const ordered = bookPages(pages, bookId);
  const singles = {};
  const extras = [];
  const spreads = [];
  for (const page of ordered) {
    if (page.kind === 'spread') spreads.push(page);
    else if (!singles[page.kind] || (page.cr ?? 0) < (singles[page.kind].cr ?? 0)) { if (singles[page.kind]) extras.push(singles[page.kind]); singles[page.kind] = page; }
    else extras.push(page);
  }
  const sheets = [];
  let number = 1;
  const push = (page) => {
    if (!page) return;
    const numbers = page.kind === 'cover' || page.kind === 'back' ? [] : page.kind === 'spread' ? [number, number + 1] : [number];
    number += numbers.length;
    sheets.push({ page, numbers, index: sheets.length });
  };
  push(singles.cover); push(singles.first);
  for (const page of spreads) push(page);
  push(singles.last); push(singles.back);
  return { cover: singles.cover ?? null, first: singles.first ?? null, spreads, last: singles.last ?? null, back: singles.back ?? null, sheets, extras };
}

/** Single kinds the book lacks (a new book, or one whose page was deleted elsewhere). */
export const missingKinds = (shape) => SINGLE_KINDS.filter((kind) => !shape[kind]);

/** Elements as `[{id, ...element}]`, bottom first. */
export function elementsOf(page) {
  return Object.entries(page?.els ?? {}).map(([id, value]) => ({ ...value, id })).sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || (a.id < b.id ? -1 : 1));
}

export const topZ = (page) => elementsOf(page).reduce((max, item) => Math.max(max, item.z ?? 0), 0);
export const isEmptyPhoto = (item) => item?.k === 'photo' && !item.file;
export const isEmptyText = (item) => item?.k === 'text' && !String(item.text ?? '').trim();
export const hasContent = (item) => !isEmptyPhoto(item) && !isEmptyText(item);

/** Stored element fields: the id is the record key, geometry rounded. */
export function stored(item) {
  const { id: _id, ...rest } = item;
  for (const key of Object.keys(rest)) if (rest[key] === undefined) delete rest[key];
  for (const key of ['x', 'y', 'w', 'h']) if (Number.isFinite(rest[key])) rest[key] = round(rest[key]);
  return rest;
}

/** Keeps a box on or near the sheet: at least 1% wide and high, never more than a third of it off an edge. */
export function clampBox({ x, y, w, h }) {
  const width = Math.min(1.2, Math.max(0.01, w));
  const height = Math.min(1.2, Math.max(0.01, h));
  return { x: round(Math.min(1 - width / 3, Math.max(-width * 2 / 3, x))), y: round(Math.min(1 - height / 3, Math.max(-height * 2 / 3, y))), w: round(width), h: round(height) };
}

// Reading order: rows by the box centre in tenths of the sheet, then left to right.
const reading = (a, b) => (Math.floor((a.y + a.h / 2) * 10) - Math.floor((b.y + b.h / 2) * 10)) || (a.x - b.x) || (a.z ?? 0) - (b.z ?? 0);
const ROLE_FOR_STYLE = Object.freeze({ title: 'title', heading: 'title', subtitle: 'subtitle', body: 'body', caption: 'caption', quote: 'quote' });

/**
 * Re-places a page's photos and texts into a layout's slots. Filled photos and texts with words are placed first;
 * texts go to slots of their own role before any other. Content beyond the slots stays where it was, empty
 * leftovers are dropped, and empty slots get placeholders. Decorations keep their place above the slots.
 * Returns `{layout, els}`.
 */
export function applyLayout(page, layoutId, { book, makeId }) {
  const target = layoutById(layoutId);
  if (!target) throw new RangeError('unknown_layout');
  const sheet = sheetSize(book, page.kind);
  const items = elementsOf(page);
  const photos = items.filter((item) => item.k === 'photo').sort((a, b) => Number(isEmptyPhoto(a)) - Number(isEmptyPhoto(b)) || reading(a, b));
  const texts = items.filter((item) => item.k === 'text').sort((a, b) => Number(isEmptyText(a)) - Number(isEmptyText(b)) || reading(a, b));
  const others = items.filter((item) => item.k !== 'photo' && item.k !== 'text');
  const used = new Set();
  const els = {};
  let z = 0;
  const textSlots = target.slots.filter((item) => item.k === 'text');
  const textFor = new Map();
  for (const item of textSlots) {
    const match = texts.find((entry) => !used.has(entry.id) && !isEmptyText(entry) && ROLE_FOR_STYLE[entry.style] === item.role);
    if (match) { used.add(match.id); textFor.set(item, match); }
  }
  for (const item of textSlots) {
    if (textFor.has(item)) continue;
    const match = texts.find((entry) => !used.has(entry.id));
    if (match) { used.add(match.id); textFor.set(item, match); }
  }
  for (const item of target.slots) {
    z += 1;
    const box = slotBox(item, sheet);
    if (item.k === 'photo') {
      const match = photos.find((entry) => !used.has(entry.id));
      if (match) { used.add(match.id); els[match.id] = stored({ ...match, ...box, z }); }
      else els[makeId()] = stored({ k: 'photo', fit: 'fill', ...box, z });
      continue;
    }
    const match = textFor.get(item);
    const defaults = { ...roleText(item.role, page.kind), ...(item.align ? { align: item.align } : {}), ...(item.color ? { color: item.color } : {}) };
    if (match) els[match.id] = stored({ ...defaults, ...match, ...(isEmptyText(match) ? defaults : {}), ...box, z, ...(item.color ? { color: item.color } : {}) });
    else els[makeId()] = stored({ k: 'text', text: '', ...defaults, ...box, z });
  }
  const leftovers = [...photos, ...texts].filter((item) => !used.has(item.id) && hasContent(item));
  for (const item of [...leftovers, ...others].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))) {
    z += 1;
    els[item.id] = stored({ ...item, z });
  }
  return { layout: target.id, els: trimElements(els) };
}

/** The layout that fits a page's own content, applied. */
export function autoLayout(page, { book, makeId, variant = 0 }) {
  const items = elementsOf(page);
  const photos = items.filter((item) => item.k === 'photo' && item.file).length;
  const texts = items.filter((item) => item.k === 'text' && !isEmptyText(item)).length;
  return applyLayout(page, bestLayout(page.kind, { photos, texts }, { variant }).id, { book, makeId });
}

/** At most `BOOK_LIMITS.elements`, keeping the topmost. */
export function trimElements(els) {
  const entries = Object.entries(els);
  if (entries.length <= BOOK_LIMITS.elements) return els;
  return Object.fromEntries(entries.sort(([, a], [, b]) => (b.z ?? 0) - (a.z ?? 0)).slice(0, BOOK_LIMITS.elements));
}

/** New z for moving one element to the front, back, or one step up or down. Returns `{<id>: z}` changes. */
export function restack(page, id, where) {
  const items = elementsOf(page);
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return {};
  const order = items.map((item) => item.id);
  order.splice(index, 1);
  const target = where === 'front' ? order.length : where === 'back' ? 0 : where === 'up' ? Math.min(order.length, index + 1) : Math.max(0, index - 1);
  order.splice(target, 0, id);
  const changes = {};
  order.forEach((eid, position) => { const z = position + 1; if ((page.els[eid]?.z ?? 0) !== z) changes[eid] = z; });
  return changes;
}

/** Photo ids used anywhere in a book's pages. */
export function usedPhotos(pages) {
  const ids = new Set();
  for (const page of pages) for (const item of Object.values(page.els ?? {})) if (item.k === 'photo' && item.file) ids.add(item.file);
  return ids;
}

/** Entry ids any element names. */
export function usedEntries(pages) {
  const ids = new Set();
  for (const page of pages) for (const item of Object.values(page.els ?? {})) if (item.entry) ids.add(item.entry);
  return ids;
}
