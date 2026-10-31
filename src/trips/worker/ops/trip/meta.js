// Type hook for trip meta: rules the schema cannot express. Runs on create (space.create) and every patch.
import { invariant } from '../../../src/shared/errors.js';

const fold = (value) => value.trim().toLocaleLowerCase();

export default Object.freeze({
  check({ after }) {
    if (!after) return;
    invariant(typeof after.title === 'string' && after.title.trim(), 'invalid_title');
    if (after.tags) {
      invariant(after.tags.every((tag) => tag.trim()) && new Set(after.tags.map(fold)).size === after.tags.length, 'invalid_tags');
    }
    if (after.reminderDays) invariant(new Set(after.reminderDays).size === after.reminderDays.length, 'invalid_reminders');
  },
});
