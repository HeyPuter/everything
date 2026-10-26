import { addDays, isDate, localDate as localToday } from '../../shared/dates.js';

/** Days after its end that a trip stays on the device. */
export const GRACE_DAYS = 7;
export const MODES = Object.freeze(['auto', 'on', 'off']);
const RECENT = 24 * 60 * 60_000;

export { localToday };

const lastDay = ({ start, end } = {}) => (isDate(end) ? end : isDate(start) ? start : null);

/** Ongoing and future trips, and those that ended within the grace period. Undated trips are not kept automatically. */
export function autoKeep(dates, today) {
  const last = lastDay(dates);
  return last !== null && last >= addDays(today, -GRACE_DAYS);
}

/** True when the trip ended more than the grace period ago. */
export function ended(dates, today) {
  const last = lastDay(dates);
  return last !== null && last < addDays(today, -GRACE_DAYS);
}

/**
 * What the device keeps for one trip. `keep`: download the replica, files and tiles; `evictFiles`: drop files and tiles;
 * `evictReplica`: also drop the replica (the caller still refuses while writes are pending).
 */
export function decide({ dates, mode = 'auto', opened = null }, { today, now = Date.now() }) {
  const keep = mode === 'on' || (mode === 'auto' && autoKeep(dates, today));
  const old = ended(dates, today);
  const recentlyOpened = Number.isFinite(opened) && now - opened < RECENT;
  return { keep, evictFiles: !keep, evictReplica: !keep && mode !== 'on' && old && !recentlyOpened };
}
