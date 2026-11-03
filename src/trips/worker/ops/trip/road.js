import { invariant } from '../../../src/shared/errors.js';
import { ROAD_PREFS_ID } from '../../../src/shared/schema/trip.js';

/** A trip has one road-trip settings entity, under a fixed id. */
export const rtPrefs = Object.freeze({
  check({ op }) { invariant(op.id === ROAD_PREFS_ID, 'invalid_road_prefs'); },
});

/** A day end sits on a leg between two different stops. */
export const dayEnd = Object.freeze({
  check({ after }) { if (after) invariant(after.fromVisit !== after.toVisit, 'invalid_day_end'); },
});

/** A route point follows a stop, not its own day. */
export const via = Object.freeze({
  check({ after }) { if (after) invariant(after.after !== after.dayId, 'invalid_via'); },
});
