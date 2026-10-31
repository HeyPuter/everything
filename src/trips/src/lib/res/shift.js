import { addDays, isDate } from '../../shared/dates.js';
import { dayForDate, resEntries } from './days.js';
import { isLodging } from './types.js';

const shiftPoint = (point, days) => (isDate(point?.date) ? { ...point, date: addDays(point.date, days) } : point);

/** `{set}` moving every date of a reservation by `days` (trip re-dating with "shift bookings"), or null when it has none. */
export function shiftPatch(res, days) {
  if (!days) return null;
  const set = {};
  if (isDate(res.start?.date)) set.start = shiftPoint(res.start, days);
  if (isDate(res.end?.date)) set.end = shiftPoint(res.end, days);
  if (res.legs?.length) set.legs = res.legs.map((leg) => ({ ...leg, dep: shiftPoint(leg.dep, days), arr: shiftPoint(leg.arr, days) }));
  return Object.keys(set).length ? { set } : null;
}

/**
 * Stay day ids matching a lodging's dates on dated days: `{set: {stay}}` when they change, null otherwise. Day ids are
 * kept only when both check-in and check-out dates are trip days; a partial overlap falls back to the dates.
 */
export function stayDaysPatch(res, days) {
  if (!isLodging(res.type)) return null;
  const from = dayForDate(days, res.start?.date);
  const to = dayForDate(days, res.end?.date ?? res.start?.date);
  const stay = { ...res.stay };
  if (from && to) Object.assign(stay, { fromDayId: from, toDayId: to });
  else { delete stay.fromDayId; delete stay.toDayId; }
  if (stay.fromDayId === res.stay?.fromDayId && stay.toDayId === res.stay?.toDayId) return null;
  return Object.keys(stay).length ? { set: { stay } } : { unset: ['stay'] };
}

/**
 * What deleting a day does to reservations, for the impact preview and the `day.remove` adapter:
 * `[{res, action, patch}]` with `action` `cancel` (a stay checking in or out that day), `shorten` (a stay spanning it,
 * one night less) or `unassign` (other bookings shown on it). `patch` is `{set?, unset?}` or null.
 */
export function dayRemovalImpact(list, days, dayId) {
  const impact = [];
  for (const res of list) {
    const here = resEntries(res, days).filter((entry) => entry.dayId === dayId);
    const position = Object.hasOwn(res.dayPos ?? {}, dayId) ? [`dayPos.${dayId}`] : [];
    if (!position.length && (!here.length || res.status === 'cancelled')) continue;
    if (isLodging(res.type) && here.length && res.status !== 'cancelled') {
      if (here.some((entry) => entry.phase !== 'middle')) {
        impact.push({ res, action: 'cancel', patch: { set: { status: 'cancelled' }, ...(position.length ? { unset: position } : {}) } });
      } else {
        const set = isDate(res.end?.date) ? { end: shiftPoint(res.end, -1) } : {};
        impact.push({ res, action: 'shorten', patch: Object.keys(set).length || position.length ? { ...(Object.keys(set).length ? { set } : {}), ...(position.length ? { unset: position } : {}) } : null });
      }
      continue;
    }
    impact.push({ res, action: 'unassign', patch: position.length ? { unset: position } : null });
  }
  return impact;
}
