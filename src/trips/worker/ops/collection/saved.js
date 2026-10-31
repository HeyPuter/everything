// Saved places: the trip place rules (prices, per-user tags), distinct labels and a trip as the source.
import { DomainError } from '../../../src/shared/errors.js';
import placeRules, { touchedFields } from '../trip/place.js';

const reject = (code) => { throw new DomainError(code, 400); };

export default Object.freeze({
  check(context) {
    const { op, after } = context;
    if (!after) return;
    placeRules.check(context);
    const touched = touchedFields(op);
    if (touched.has('labels') && after.labels && new Set(after.labels).size !== after.labels.length) reject('duplicate_label');
    if (touched.has('src') && after.src && after.src.trip.k !== 'trip') reject('invalid_source');
  },
});
