// Values the worker checks (worker/ops/journey/book*.js; tests/worker/book.test.js keeps both copies equal).
export const PAGE_KINDS = Object.freeze(['cover', 'first', 'spread', 'last', 'back']);
export const SINGLE_KINDS = Object.freeze(['cover', 'first', 'last', 'back']);
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
export const FORMAT_IDS = Object.freeze(['sq21', 'sq30', 'a4l', 'a4p', 'a5l', 'custom']);
export const ICONS = Object.freeze([
  'plane', 'train-front', 'car', 'ship', 'bus', 'bike', 'footprints', 'mountain', 'mountain-snow', 'tent', 'tree-palm', 'trees',
  'sun', 'sunset', 'moon', 'cloud-sun', 'snowflake', 'umbrella', 'waves', 'camera', 'map-pin', 'compass', 'globe', 'heart', 'star',
  'coffee', 'utensils', 'wine', 'ice-cream-cone', 'landmark', 'castle', 'hotel', 'anchor', 'sailboat', 'luggage', 'ticket', 'music',
  'sparkles', 'flag', 'gift',
]);
export const BOOK_LIMITS = Object.freeze({ elements: 80, spreads: 100, text: 4000, title: 200, minMm: 50, maxMm: 600 });
