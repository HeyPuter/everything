// Collection meta rules (blank names fail the schema): a short name, a day-token color, an icon the views can draw and distinct web links.
import { DomainError } from '../../../src/shared/errors.js';
import { touchedFields } from '../trip/place.js';

// Matches COLLECTION_ICONS in src/views/collections/icons.js (tests/worker/collections.test.js checks it).
export const COLLECTION_ICONS = Object.freeze([
  'heart', 'star', 'bookmark', 'map-pin', 'utensils', 'coffee', 'wine', 'landmark', 'mountain', 'trees',
  'waves', 'camera', 'shopping-bag', 'music', 'ticket', 'bed-double', 'plane', 'flag', 'gem', 'sparkles',
]);
export const NAME_MAX = 200;
const reject = (code) => { throw new DomainError(code, 400); };

export const validColor = (color) => Number.isInteger(color) && color >= 1 && color <= 8;

export default Object.freeze({
  check({ op, after }) {
    if (!after) return;
    const touched = touchedFields(op);
    if (touched.has('name') && after.name.trim().length > NAME_MAX) reject('name_too_long');
    if (touched.has('color') && after.color !== undefined && !validColor(after.color)) reject('invalid_color');
    if (touched.has('icon') && after.icon !== undefined && !COLLECTION_ICONS.includes(after.icon)) reject('invalid_icon');
    if (touched.has('urls') && after.urls) {
      const seen = new Set();
      for (const link of after.urls) {
        if (seen.has(link.url)) reject('duplicate_url');
        seen.add(link.url);
      }
    }
  },
});
