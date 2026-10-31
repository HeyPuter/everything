// Journey meta rules (blank titles fail the schema): length caps, a known status and distinct linked trips.
import { DomainError } from '../../../src/shared/errors.js';
import { touchedFields } from '../trip/place.js';

// Matches src/views/journey/constants.js (tests/worker/journey.test.js checks it).
export const JOURNEY_STATUSES = Object.freeze(['upcoming', 'ongoing', 'completed']);
export const TITLE_MAX = 200;
export const SUBTITLE_MAX = 300;
export const TRIPS_MAX = 20;
const reject = (code) => { throw new DomainError(code, 400); };

export default Object.freeze({
  check({ op, after }) {
    if (!after) return;
    const touched = touchedFields(op);
    if (touched.has('title') && after.title.trim().length > TITLE_MAX) reject('title_too_long');
    if (touched.has('subtitle') && (after.subtitle ?? '').trim().length > SUBTITLE_MAX) reject('subtitle_too_long');
    if (touched.has('status') && after.status !== undefined && !JOURNEY_STATUSES.includes(after.status)) reject('invalid_status');
    if (touched.has('trips') && after.trips) {
      if (after.trips.length > TRIPS_MAX) reject('too_many_trips');
      const seen = new Set();
      for (const ref of after.trips) {
        if (ref.k !== 'trip') reject('invalid_trip');
        const key = `${ref.w}/${ref.s}`;
        if (seen.has(key)) reject('duplicate_trip');
        seen.add(key);
      }
    }
  },
});
