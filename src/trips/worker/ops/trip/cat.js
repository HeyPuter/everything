// Trip category rules: a short name, a day-token color and an icon the planner can draw.
import { DomainError } from '../../../src/shared/errors.js';
import { touchedFields } from './place.js';

// Matches CAT_ICONS in src/lib/categories.js (tests/worker/places.test.js checks it).
export const CAT_ICONS = Object.freeze([
  'map-pin', 'utensils', 'coffee', 'wine', 'bed-double', 'landmark', 'mountain', 'trees',
  'waves', 'camera', 'ticket', 'shopping-bag', 'music', 'baby', 'dumbbell', 'church', 'bus',
]);
const NAME_MAX = 100;
const reject = (code) => { throw new DomainError(code, 400); };

export default Object.freeze({
  check({ op, after }) {
    if (!after) return;
    const touched = touchedFields(op);
    if (touched.has('name') && after.name.trim().length > NAME_MAX) reject('name_too_long');
    if (touched.has('color') && !(Number.isInteger(after.color) && after.color >= 1 && after.color <= 8)) reject('invalid_color');
    if (touched.has('icon') && !CAT_ICONS.includes(after.icon)) reject('invalid_icon');
  },
});
