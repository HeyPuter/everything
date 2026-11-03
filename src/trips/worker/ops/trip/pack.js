// Packing item rules beyond the schema: `owner` is the creator and never changes; assigned items name someone.
import { invariant } from '../../../src/shared/errors.js';

const touched = (op, field) => Boolean(op.put) || Object.hasOwn(op.set ?? {}, field) || (op.unset ?? []).includes(field);

export default Object.freeze({
  check({ op, before, after, uid }) {
    if (!after) return;
    if (touched(op, 'name')) invariant(after.name.trim(), 'invalid_name');
    if (!before) invariant(after.owner === undefined || after.owner === uid, 'forbidden', 403);
    else invariant(after.owner === before.owner, 'forbidden', 403);
    if (touched(op, 'vis') || touched(op, 'for')) {
      if (after.vis === 'people') invariant(after.for?.length > 0, 'invalid_visibility');
      if (after.for) invariant(new Set(after.for).size === after.for.length, 'invalid_people');
    }
    if (touched(op, 'qty') && after.qty !== undefined) invariant(Number.isInteger(after.qty) && after.qty >= 1, 'invalid_qty');
  },
});
