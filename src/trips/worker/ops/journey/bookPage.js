// Photo-book page rules beyond the shared schema: known kinds and element values; `kind` and `book` never change.
// Only elements an op touches are checked, so pages written by older clients stay editable.
import { DomainError } from '../../../src/shared/errors.js';

// Match src/lib/book/constants.js (tests/worker/book.test.js checks them).
export const PAGE_KINDS = Object.freeze(['cover', 'first', 'spread', 'last', 'back']);
export const ELEMENT_KINDS = Object.freeze(['photo', 'text', 'shape', 'line', 'icon', 'flag', 'country', 'map', 'route', 'stats']);
export const COLORS = Object.freeze(['none', 'ink', 'ink-2', 'ink-3', 'surface', 'surface-2', 'surface-3', 'day-1', 'day-2', 'day-3', 'day-4', 'day-5', 'day-6', 'day-7', 'day-8']);
export const FILTERS = Object.freeze(['none', 'bw', 'sepia', 'warm', 'cool', 'fade', 'vivid']);
export const FITS = Object.freeze(['fill', 'fit']);
export const TEXT_STYLES = Object.freeze(['title', 'subtitle', 'heading', 'body', 'caption', 'quote']);
export const FONTS = Object.freeze(['sans', 'serif', 'mono', 'hand']);
export const ALIGNS = Object.freeze(['start', 'center', 'end']);
export const SHAPES = Object.freeze(['rect', 'ellipse']);
export const SCOPES = Object.freeze(['book', 'page']);
export const STATS = Object.freeze(['entries', 'days', 'places', 'countries', 'photos', 'distance', 'words']);
export const ICONS = Object.freeze([
  'plane', 'train-front', 'car', 'ship', 'bus', 'bike', 'footprints', 'mountain', 'mountain-snow', 'tent', 'tree-palm', 'trees',
  'sun', 'sunset', 'moon', 'cloud-sun', 'snowflake', 'umbrella', 'waves', 'camera', 'map-pin', 'compass', 'globe', 'heart', 'star',
  'coffee', 'utensils', 'wine', 'ice-cream-cone', 'landmark', 'castle', 'hotel', 'anchor', 'sailboat', 'luggage', 'ticket', 'music',
  'sparkles', 'flag', 'gift',
]);
const LISTS = Object.freeze({
  k: ELEMENT_KINDS, fit: FITS, filter: FILTERS, style: TEXT_STYLES, font: FONTS, align: ALIGNS, shape: SHAPES, scope: SCOPES, stat: STATS,
  color: COLORS, fill: COLORS, frameColor: COLORS, icon: ICONS,
});
const reject = (code) => { throw new DomainError(code, 400); };

/** Element ids an op writes (all of them for a create or a whole `els` replacement). */
function touchedElements(op, after) {
  if (op.put || Object.hasOwn(op.set ?? {}, 'els')) return Object.keys(after.els ?? {});
  const ids = new Set();
  for (const path of Object.keys(op.set ?? {})) {
    const [field, id] = path.split('.');
    if (field === 'els' && id) ids.add(id);
  }
  return [...ids];
}

export function checkElement(item) {
  for (const [field, list] of Object.entries(LISTS)) if (item[field] !== undefined && !list.includes(item[field])) reject('invalid_element');
}

export default Object.freeze({
  check({ op, before, after }) {
    if (!after) return;
    if (!PAGE_KINDS.includes(after.kind)) reject('invalid_kind');
    if (before && (before.kind !== after.kind || before.book !== after.book)) reject('immutable_field');
    if (after.bg !== undefined && !COLORS.includes(after.bg)) reject('invalid_color');
    for (const id of touchedElements(op, after)) {
      const item = after.els?.[id];
      if (item) checkElement(item);
    }
  },
});
