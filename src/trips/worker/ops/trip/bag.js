// Bag rules beyond the schema: a visible name and each person once.
import { invariant } from '../../../src/shared/errors.js';

const touched = (op, field) => Boolean(op.put) || Object.hasOwn(op.set ?? {}, field) || (op.unset ?? []).includes(field);

export default Object.freeze({
  check({ op, after }) {
    if (!after) return;
    if (touched(op, 'name')) invariant(after.name.trim(), 'invalid_name');
    if (touched(op, 'people') && after.people) invariant(new Set(after.people).size === after.people.length, 'invalid_people');
  },
});
