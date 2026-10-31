// Book formats in millimetres, bleed and safe margin.
import { BOOK_LIMITS } from './constants.js';

export const BLEED_MM = 3;
export const SAFE_MM = 5;
export const PT_MM = 25.4 / 72;
export const FORMATS = Object.freeze({
  sq21: Object.freeze({ w: 210, h: 210 }),
  sq30: Object.freeze({ w: 300, h: 300 }),
  a4l: Object.freeze({ w: 297, h: 210 }),
  a4p: Object.freeze({ w: 210, h: 297 }),
  a5l: Object.freeze({ w: 210, h: 148 }),
});
export const DEFAULT_FORMAT = 'sq21';

const clampMm = (value, fallback) => (Number.isFinite(value) ? Math.min(BOOK_LIMITS.maxMm, Math.max(BOOK_LIMITS.minMm, Math.round(value))) : fallback);

/** Trim size of one page in mm. */
export function pageSize(book) {
  if (book?.fmt === 'custom') return { w: clampMm(book.w, 210), h: clampMm(book.h, 210) };
  return { ...(FORMATS[book?.fmt] ?? FORMATS[DEFAULT_FORMAT]) };
}

/** Trim size of a sheet: a spread is two pages side by side. */
export function sheetSize(book, kind) {
  const page = pageSize(book);
  return kind === 'spread' ? { w: page.w * 2, h: page.h } : page;
}

/** Book fields for a format choice; custom sizes are clamped to 50–600 mm. */
export function formatFields(fmt, { w, h } = {}) {
  if (fmt === 'custom') return { fmt, w: clampMm(Number(w), 210), h: clampMm(Number(h), 210) };
  return { fmt: Object.hasOwn(FORMATS, fmt) ? fmt : DEFAULT_FORMAT };
}

/** A length in mm as a share of the sheet width, in `cqw` (the sheet is the size container). */
export const mmToCqw = (mm, sheetWidthMm) => (mm / sheetWidthMm) * 100;
export const ptToCqw = (pt, sheetWidthMm) => mmToCqw(pt * PT_MM, sheetWidthMm);
