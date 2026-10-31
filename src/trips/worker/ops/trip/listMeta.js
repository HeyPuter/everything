// List rules beyond the schema: a list keeps its kind, has a visible name and names each assignee once.
import { invariant } from '../../../src/shared/errors.js';

const touched = (op, field) => Boolean(op.put) || Object.hasOwn(op.set ?? {}, field) || (op.unset ?? []).includes(field);

export default Object.freeze({
  check({ op, before, after }) {
    if (!after) return;
    if (before) invariant(after.kind === before.kind, 'invalid_kind');
    if (touched(op, 'name')) invariant(after.name.trim(), 'invalid_name');
    if (touched(op, 'assignees') && after.assignees) invariant(new Set(after.assignees).size === after.assignees.length, 'invalid_people');
  },
});
