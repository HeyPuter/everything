const DATE_LONG = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
const TIME_SHORT = { hour: 'numeric', minute: '2-digit' };

/** "Friday, October 9, 2026", the page header date. */
export function formatPageDate(iso, locale) {
  return new Date(iso).toLocaleDateString(locale, DATE_LONG);
}

/** "12:21 PM", the page header time. */
export function formatPageTime(iso, locale) {
  return new Date(iso).toLocaleTimeString(locale, TIME_SHORT);
}

/** Short dates for lists: time for today, weekday this week, else a date. */
export function formatRelative(iso, now = new Date(), locale) {
  const d = new Date(iso);
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days === 0) return d.toLocaleTimeString(locale, TIME_SHORT);
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return d.toLocaleDateString(locale, { weekday: 'long' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(locale, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The day for a group heading: "Today", "Yesterday", a weekday this week, else a date. */
export function formatDay(iso, now = new Date(), locale) {
  const d = new Date(iso);
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? 'Today' : formatRelative(iso, now, locale);
}

/** The value of an <input type="datetime-local"> for an ISO timestamp, in local time. */
export function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
