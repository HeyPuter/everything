// Collection labels: a non-blank short name and a day-token color.
import { DomainError } from '../../../src/shared/errors.js';
import { touchedFields } from '../trip/place.js';
import { validColor } from './meta.js';

export const LABEL_MAX = 100;
const reject = (code) => { throw new DomainError(code, 400); };

export default Object.freeze({
  check({ op, after }) {
    if (!after) return;
    const touched = touchedFields(op);
    if (touched.has('name') && after.name.trim().length > LABEL_MAX) reject('name_too_long');
    if (touched.has('color') && after.color !== undefined && !validColor(after.color)) reject('invalid_color');
  },
});
