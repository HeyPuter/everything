// To-do rules beyond the schema: a visible name.
import { invariant } from '../../../src/shared/errors.js';

const touched = (op, field) => Boolean(op.put) || Object.hasOwn(op.set ?? {}, field) || (op.unset ?? []).includes(field);

export default Object.freeze({
  check({ op, after }) {
    if (after && touched(op, 'name')) invariant(after.name.trim(), 'invalid_name');
  },
});
