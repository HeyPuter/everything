import { t } from '../i18n/index.js';
import { displayLocale } from '../prefs.js';
import { formatDate, formatInstant } from '../format.js';
import { daysBetween } from '../../shared/dates.js';
import { routeHash } from '../router.js';
import { todayIn } from './schedule.js';

const HOUR = 3_600_000;
const pluralKey = (count, one, other) => (new Intl.PluralRules(displayLocale()).select(count) === 'one' ? one : other);
const number = (value) => new Intl.NumberFormat(displayLocale()).format(value);

/** Labels `tripEvents` puts into reminder titles. */
export const reminderLabels = Object.freeze({
  trip: () => t('notify.untitledTrip'),
  todo: (name) => name || t('notify.untitledTodo'),
  type: (type) => t(`bookings.type.${type}`),
});

function relative(ms) {
  const format = new Intl.RelativeTimeFormat(displayLocale(), { numeric: 'auto' });
  return ms >= HOUR ? format.format(Math.round(ms / HOUR), 'hour') : format.format(Math.max(1, Math.round(ms / 60_000)), 'minute');
}

/** `{title, body}` for a reminder shown at `now`. */
export function reminderText(item, { now = Date.now(), zone } = {}) {
  const trip = item.trip || t('notify.untitledTrip');
  if (item.kind === 'trip') {
    const days = Math.round(daysBetween(todayIn(now, zone), item.start.date));
    const body = days <= 0 ? t('notify.tripToday') : days === 1 ? t('notify.tripTomorrow') : t('notify.tripIn', { count: number(days) });
    return { title: trip, body: `${body} · ${formatDate(item.start.date, { weekday: true })}` };
  }
  if (item.kind === 'booking') {
    const time = formatInstant(item.startAt, item.start.tz || zone, { date: false });
    const ahead = item.startAt - now;
    return { title: item.title, body: t('notify.bookingAt', { when: ahead > 0 ? relative(ahead) : t('notify.now'), time, trip }) };
  }
  if (item.kind === 'todo') return { title: item.title, body: t('notify.todoDue', { trip }) };
  return { title: trip, body: t(pluralKey(item.count, 'notify.overdueOne', 'notify.overdue'), { count: number(item.count) }) };
}

/** Where a reminder leads: the trip tab that holds the item. */
export function reminderHash(item) {
  try { return routeHash({ name: 'space', ref: item.ref, tab: item.tab }); } catch { return null; }
}
