import { invariant } from '../../../src/shared/errors.js';

/** A multi-day visit ends on another day than it starts, and lists each participant once. */
export default Object.freeze({
  check({ after }) {
    if (!after) return;
    invariant(after.endDayId === undefined || after.endDayId !== after.dayId, 'invalid_end_day');
    invariant(!after.people || new Set(after.people).size === after.people.length, 'duplicate_people');
  },
});
