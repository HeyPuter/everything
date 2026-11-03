import { isTime, timeMinutes } from '../../shared/dates.js';

/** Default minutes at a place by built-in category. Custom categories and free-form items use `ITEM_DWELL`. */
export const CATEGORY_DWELL = Object.freeze({
  hotel: 30, restaurant: 90, attraction: 90, shopping: 60, transport: 15, activity: 120, bar: 60, beach: 180, nature: 120, other: 60,
});
export const ITEM_DWELL = 60;
/** Default minutes for bookings without an end time; rentals and parking are a hand-over. */
export const BOOKING_DWELL = Object.freeze({ restaurant: 90, event: 150, tour: 180, other: 60, car: 15, bike: 15, parking: 10 });
/** Minutes to be at a departure early, and to get out after an arrival. */
export const DEPARTURE_BUFFER = Object.freeze({ flight: 90, cruise: 60, ferry: 30, train: 15, bus: 10 });
export const ARRIVAL_BUFFER = Object.freeze({ flight: 30, cruise: 30, ferry: 15, train: 5 });
export const MAX_DWELL = 10080;

const validDwell = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_DWELL;

/** The category default for a visit's place (`ITEM_DWELL` without a place or with a custom category). */
export function defaultDwell(place) {
  return Object.hasOwn(CATEGORY_DWELL, place?.cat ?? '') ? CATEGORY_DWELL[place.cat] : ITEM_DWELL;
}

/**
 * Minutes a visit takes: its own `dwell`, else its start-to-end span when it ends the same day, else the category
 * default. `{minutes, source: 'visit'|'times'|'default'}`.
 */
export function visitDwell(visit, place) {
  if (validDwell(visit?.dwell)) return { minutes: visit.dwell, source: 'visit' };
  if (isTime(visit?.start) && isTime(visit?.end) && !visit.endDayId && visit.end > visit.start) {
    return { minutes: timeMinutes(visit.end) - timeMinutes(visit.start), source: 'times' };
  }
  return { minutes: defaultDwell(place), source: 'default' };
}

export const bookingDwell = (type) => BOOKING_DWELL[type] ?? 0;
