// Spread design files: one page or spread's layout and elements as JSON, to reuse in another book.
import { schemas, validate } from '../../shared/schema/index.js';
import { isId } from '../../shared/ids.js';
import { ALIGNS, COLORS, ELEMENT_KINDS, FILTERS, FITS, FONTS, ICONS, SCOPES, SHAPES, STATS, TEXT_STYLES } from './constants.js';
import { elementsOf, stored, trimElements } from './model.js';

export const DESIGN_FORMAT = 'trips-book-spread';
export const DESIGN_VERSION = 1;
export const DESIGN_BYTES = 512 * 1024;
const elementSchema = schemas.journey.bookPage.fields.els.item;
const LISTS = Object.freeze({
  k: ELEMENT_KINDS, fit: FITS, filter: FILTERS, style: TEXT_STYLES, font: FONTS, align: ALIGNS, shape: SHAPES, scope: SCOPES, stat: STATS,
  color: COLORS, fill: COLORS, frameColor: COLORS, icon: ICONS,
});

/** True when every listed field holds a known value (the worker applies the same lists). */
export function knownValues(item) {
  return Object.entries(LISTS).every(([field, list]) => item[field] === undefined || list.includes(item[field]));
}

/** The design of a page as a plain object; file ids are kept and resolve only inside the same journey. */
export function exportDesign(page, { book } = {}) {
  return {
    format: DESIGN_FORMAT, version: DESIGN_VERSION, kind: page.kind === 'spread' ? 'spread' : 'page',
    ...(book?.fmt ? { fmt: book.fmt } : {}), ...(page.layout ? { layout: page.layout } : {}), ...(page.bg ? { bg: page.bg } : {}),
    els: elementsOf(page).map(({ id: _id, ...item }) => item),
  };
}

/**
 * Reads a design file for a page of `kind`. Throws `RangeError` with a code (`design_invalid`, `design_kind`,
 * `design_large`). Invalid elements are skipped, photos missing from this journey become empty frames, ids are new.
 * Returns `{layout, bg, els, skipped}`.
 */
export function parseDesign(text, { kind, makeId, hasFile = () => false }) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > DESIGN_BYTES) throw new RangeError('design_large');
  let value;
  try { value = JSON.parse(text); } catch { throw new RangeError('design_invalid'); }
  if (!value || typeof value !== 'object' || value.format !== DESIGN_FORMAT || value.version !== DESIGN_VERSION || !Array.isArray(value.els)) throw new RangeError('design_invalid');
  if ((value.kind === 'spread') !== (kind === 'spread')) throw new RangeError('design_kind');
  const els = {};
  let skipped = 0;
  for (const raw of value.els.slice(0, 200)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { skipped += 1; continue; }
    const item = { ...raw };
    if (item.k === 'photo' && item.file !== undefined && !(isId(item.file) && hasFile(item.file))) delete item.file;
    if (item.entry !== undefined && !isId(item.entry)) delete item.entry;
    try { validate(elementSchema, item); } catch { skipped += 1; continue; }
    if (!knownValues(item)) { skipped += 1; continue; }
    els[makeId()] = stored(item);
  }
  const bg = COLORS.includes(value.bg) ? value.bg : undefined;
  const layout = typeof value.layout === 'string' && /^[a-z0-9-]{1,32}$/.test(value.layout) ? value.layout : undefined;
  return { layout, bg, els: trimElements(els), skipped };
}

/** A download name for a design file. */
export const designFileName = (title, index) => `${String(title || 'book').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'book'}-${index + 1}.json`;
