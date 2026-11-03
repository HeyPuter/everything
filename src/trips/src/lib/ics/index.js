// iCalendar export shared by the client (file export, Calendar hand-off) and the worker (subscribed feed). Pure.
import { serializeCalendar } from './calendar.js';
import { tripEvents } from './trip.js';

export { serializeCalendar } from './calendar.js';
export { dateValue, durationValue, escapeText, foldLine, localValue, offsetValue, utcValue } from './text.js';
export { DEFAULT_LABELS, tripData, tripEvents } from './trip.js';
export { offsetAt, transitions, vtimezone } from './zones.js';

/**
 * A trip as iCalendar text. `data` is `{meta, day, visit, place, res, todo, listMeta}`; options are those of
 * `tripEvents` plus `name` (calendar name, defaults to the trip title), `stamp`, `zones` and `refresh`.
 */
export function tripCalendar(data, { name, stamp, zones, refresh, ...options } = {}) {
  const title = typeof data?.meta?.title === 'string' ? data.meta.title.trim() : '';
  return serializeCalendar({ name: name ?? title, events: tripEvents(data, options), stamp, zones, refresh });
}
