// Page and spread layouts: slots in fractions of the sheet, matched against a page's photos and texts.
import { BLEED_MM } from './formats.js';

const M = 0.08;
const slot = (k, x, y, w, h, extra = {}) => Object.freeze({ k, x, y, w, h, ...extra });
const photo = (x, y, w, h, extra) => slot('photo', x, y, w, h, extra);
const text = (role, x, y, w, h, extra) => slot('text', x, y, w, h, { role, ...extra });
// Spread helpers: page-relative boxes on the left or right half.
const left = (s) => Object.freeze({ ...s, x: s.x / 2, w: s.w / 2 });
const right = (s) => Object.freeze({ ...s, x: 0.5 + s.x / 2, w: s.w / 2 });
const full = { bleed: true };
const onPhoto = { color: 'surface' };
const centered = { align: 'center' };

const layout = (id, slots) => Object.freeze({ id, slots: Object.freeze(slots), photos: slots.filter((item) => item.k === 'photo').length, texts: slots.filter((item) => item.k === 'text').length });

export const COVER_LAYOUTS = Object.freeze([
  layout('cover-full', [photo(0, 0, 1, 1, full), text('title', M, 0.66, 1 - 2 * M, 0.14, onPhoto), text('subtitle', M, 0.81, 1 - 2 * M, 0.07, onPhoto)]),
  layout('cover-framed', [photo(0.1, 0.1, 0.8, 0.6), text('title', 0.1, 0.74, 0.8, 0.11), text('subtitle', 0.1, 0.86, 0.8, 0.06)]),
  layout('cover-split', [photo(0, 0, 1, 0.6, full), text('title', M, 0.66, 1 - 2 * M, 0.13), text('subtitle', M, 0.8, 1 - 2 * M, 0.07), text('caption', M, 0.88, 1 - 2 * M, 0.05)]),
  layout('cover-type', [text('title', 0.1, 0.28, 0.8, 0.2, centered), text('subtitle', 0.1, 0.5, 0.8, 0.08, centered), photo(0.32, 0.64, 0.36, 0.24)]),
  layout('cover-grid', [photo(0.07, 0.07, 0.42, 0.34), photo(0.51, 0.07, 0.42, 0.34), photo(0.07, 0.43, 0.42, 0.34), photo(0.51, 0.43, 0.42, 0.34),
    text('title', 0.07, 0.8, 0.86, 0.1), text('subtitle', 0.07, 0.9, 0.86, 0.05)]),
]);

const half = (x, y, w, h) => [left(photo(x, y, w, h)), right(photo(x, y, w, h))];
export const SPREAD_LAYOUTS = Object.freeze([
  layout('spread-panorama', [photo(0, 0, 1, 1, full)]),
  layout('spread-pair', [left(photo(0, 0, 1, 1, full)), right(photo(0, 0, 1, 1, full))]),
  layout('spread-photo-story', [left(photo(0, 0, 1, 1, full)), right(text('title', 0.1, 0.12, 0.8, 0.12)), right(text('body', 0.1, 0.27, 0.8, 0.6))]),
  layout('spread-story-photo', [left(text('title', 0.1, 0.12, 0.8, 0.12)), left(text('body', 0.1, 0.27, 0.8, 0.6)), right(photo(0, 0, 1, 1, full))]),
  layout('spread-framed', [left(photo(0.1, 0.1, 0.8, 0.68)), left(text('caption', 0.1, 0.81, 0.8, 0.08)), right(photo(0.1, 0.1, 0.8, 0.68)), right(text('caption', 0.1, 0.81, 0.8, 0.08))]),
  layout('spread-one-two', [left(photo(0, 0, 1, 1, full)), right(photo(M, M, 1 - 2 * M, 0.41)), right(photo(M, 0.51, 1 - 2 * M, 0.41))]),
  layout('spread-two-two', [...half(M, M, 1 - 2 * M, 0.41), ...half(M, 0.51, 1 - 2 * M, 0.41)]),
  layout('spread-six', [left(photo(M, M, 1 - 2 * M, 0.5)), left(photo(M, 0.6, 0.41, 0.32)), left(photo(0.51, 0.6, 0.41, 0.32)),
    right(photo(M, M, 0.41, 0.32)), right(photo(0.51, M, 0.41, 0.32)), right(photo(M, 0.42, 1 - 2 * M, 0.5))]),
  layout('spread-mosaic', [left(photo(M, M, 1 - 2 * M, 1 - 2 * M)), right(photo(M, M, 0.41, 0.41)), right(photo(0.51, M, 0.41, 0.41)),
    right(photo(M, 0.51, 0.41, 0.41)), right(photo(0.51, 0.51, 0.41, 0.41))]),
  layout('spread-hero-strip', [photo(0, 0, 1, 0.55, full), left(photo(M, 0.61, 0.4, 0.31)), left(photo(0.52, 0.61, 0.4, 0.31)), right(photo(M, 0.61, 0.4, 0.31)),
    right(text('title', 0.52, 0.61, 0.4, 0.09)), right(text('body', 0.52, 0.71, 0.4, 0.21))]),
  layout('spread-journal', [left(text('title', 0.1, 0.1, 0.8, 0.1)), left(text('body', 0.1, 0.22, 0.8, 0.4)), left(photo(0.1, 0.65, 0.8, 0.27)),
    right(photo(M, M, 1 - 2 * M, 0.41)), right(photo(M, 0.51, 1 - 2 * M, 0.41))]),
  layout('spread-eight', [...half(M, M, 0.41, 0.41), ...half(0.51, M, 0.41, 0.41), ...half(M, 0.51, 0.41, 0.41), ...half(0.51, 0.51, 0.41, 0.41)]),
  layout('spread-quote', [left(text('quote', 0.12, 0.3, 0.76, 0.4, centered)), right(photo(0, 0, 1, 1, full))]),
]);

const BY_ID = new Map([...COVER_LAYOUTS, ...SPREAD_LAYOUTS].map((item) => [item.id, item]));
export const layoutById = (id) => BY_ID.get(id) ?? null;
/** Layouts that fit a page kind: spread layouts for spreads, cover layouts for every single page. */
export const layoutsFor = (kind) => (kind === 'spread' ? SPREAD_LAYOUTS : COVER_LAYOUTS);

// Text defaults per slot role, in points; covers use a larger title.
const ROLE_STYLE = Object.freeze({
  title: { style: 'title', size: 26 }, subtitle: { style: 'subtitle', size: 13 }, body: { style: 'body', size: 10 },
  caption: { style: 'caption', size: 8 }, quote: { style: 'quote', size: 18, font: 'serif', italic: true },
});
export function roleText(role, kind) {
  const base = ROLE_STYLE[role] ?? ROLE_STYLE.body;
  return kind !== 'spread' && role === 'title' ? { ...base, size: 34 } : { ...base };
}

/** Slot geometry for a sheet; full-bleed slots grow into the bleed on the sheet edges they touch. */
export function slotBox(item, sheet) {
  const box = { x: item.x, y: item.y, w: item.w, h: item.h };
  if (!item.bleed || !sheet) return box;
  const bx = BLEED_MM / sheet.w;
  const by = BLEED_MM / sheet.h;
  if (item.x <= 0.0001) { box.x -= bx; box.w += bx; }
  if (item.y <= 0.0001) { box.y -= by; box.h += by; }
  if (item.x + item.w >= 0.9999) box.w += bx;
  if (item.y + item.h >= 0.9999) box.h += by;
  return box;
}

/**
 * The layout that best fits `photos` and `texts`: overflowing slots cost most, then missing text room, then empty
 * slots. `variant` rotates between equally good layouts so a whole book does not repeat one design.
 */
export function bestLayout(kind, { photos = 0, texts = 0 } = {}, { variant = 0 } = {}) {
  const scored = layoutsFor(kind).map((item, index) => ({
    item, index,
    score: Math.max(0, photos - item.photos) * 6 + Math.max(0, item.photos - photos) * 2
      + Math.max(0, texts - item.texts) * 3 + Math.max(0, item.texts - texts) * 0.75,
  }));
  const best = Math.min(...scored.map((entry) => entry.score));
  const ties = scored.filter((entry) => entry.score === best);
  return ties[Math.abs(Math.trunc(variant)) % ties.length].item;
}
