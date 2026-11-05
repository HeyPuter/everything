/**
 * Times for "send later" and "remind me": presets in the user's local zone,
 * and approximate delivery wording: background wake-ups and polls may arrive late.
 */

const HOUR = 3600_000;

/**
 * `hour:minute` on the calendar day `days` after `base`'s, in the local zone.
 * Days are stepped on the calendar, not by 24 hours: the night the clocks
 * change has 23 or 25, and 24 hours from just after midnight (or just
 * before) lands on the wrong date.
 */
function at(base, hour, minute = 0, days = 0) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/** Whether `ts` falls on the calendar day `days` after `now`'s. */
function onDay(ts, now, days) {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return d.toDateString() === new Date(ts).toDateString();
}

/** Presets for sending a message later. */
export function sendPresets(now = Date.now()) {
  const d = new Date(now);
  const day = d.getDay();
  const untilMonday = ((8 - day) % 7) || 7;
  const list = [
    { key: 'hour', label: 'In an hour', at: now + HOUR },
    d.getHours() < 17 ? { key: 'tonight', label: 'Tonight at 6', at: at(now, 18) } : null,
    { key: 'tomorrow', label: 'Tomorrow at 9', at: at(now, 9, 0, 1) },
    { key: 'monday', label: 'Monday at 9', at: at(now, 9, 0, untilMonday) },
  ];
  // Each time once: on a Sunday "tomorrow" is Monday, and the two presets
  // would offer the same moment twice under two names.
  const seen = new Set();
  return list.filter(Boolean).filter((p) => p.at > now + 60_000 && !seen.has(p.at) && seen.add(p.at));
}

/** Presets for a reminder. */
export function remindPresets(now = Date.now()) {
  return [
    { key: '30m', label: 'In 30 minutes', at: now + 30 * 60_000 },
    { key: '3h', label: 'In 3 hours', at: now + 3 * HOUR },
    { key: 'tomorrow', label: 'Tomorrow at 9', at: at(now, 9, 0, 1) },
    { key: 'week', label: 'Next week', at: at(now, 9, 0, 7) },
  ].filter((p) => p.at > now + 60_000);
}

/** "around 9:00 AM tomorrow" style phrase for a due time. */
export function aroundText(ts, now = Date.now(), locale) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  if (onDay(ts, now, 0)) return `around ${time} today`;
  if (onDay(ts, now, 1)) return `around ${time} tomorrow`;
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return `around ${time} on ${d.toLocaleDateString(locale, opts)}`;
}

/** Value for a datetime-local input, local time, minutes precision. */
export function toLocalInput(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const DELIVERY_NOTE = 'Background delivery usually starts within a minute. Without background access, it waits for someone to open the workspace.';
