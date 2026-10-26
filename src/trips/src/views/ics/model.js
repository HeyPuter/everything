import { t } from '../../lib/i18n/index.js';
import { formatMoney, formatTime } from '../../lib/format.js';
import { tripCalendar } from '../../lib/ics/index.js';
import { workerOrigin } from '../../shared/protocol.js';

const TYPES = ['day', 'visit', 'place', 'res', 'todo', 'listMeta', 'exp'];
const FEED_PATH = /^\/ics\/[0-9a-z]{16}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{32}\.ics$/;
const number = (value) => new Intl.NumberFormat().format(value);

export const isFeedPath = (path) => typeof path === 'string' && FEED_PATH.test(path);

/** Translated event labels for the serializer. */
export const LABELS = Object.freeze({
  trip: () => t('ics.trip'),
  visit: () => t('ics.visit'),
  day: (n, title) => (title ? t('ics.dayTitled', { number: number(n), title }) : t('ics.day', { number: number(n) })),
  todo: (name) => t('ics.todo', { name }),
  checkIn: (time) => t('ics.checkIn', { time }),
  checkOut: (time) => t('ics.checkOut', { time }),
  type: (type) => t(`bookings.type.${type}`),
  time: (time) => formatTime(time),
  payment: (name, amount) => t('ics.paymentDue', { name, amount }),
  money: (amount, currency) => formatMoney(amount, currency),
});

/** The entities the calendar reads, from a live space. */
export function spaceData(space) {
  const data = { meta: space.get('meta', 'meta') ?? {} };
  for (const type of TYPES) data[type] = space.select?.[type]?.all?.() ?? space.query?.(type) ?? [];
  return data;
}

/** The trip as a one-off .ics file for `member` (whose to-dos it includes). */
export function exportCalendar(space, { member = null, days = true, alarms = true, now = Date.now() } = {}) {
  return tripCalendar(spaceData(space), { space: space.ref.s, member, days, alarms, labels: LABELS, stamp: now });
}

/** A file name from the trip title, safe on every platform. */
export function fileName(title) {
  const base = String(title ?? '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${[...base].slice(0, 80).join('').trim() || 'trip'}.ics`;
}

/** Subscribe links for a feed path from `feed.set`: https, `webcal://` and Google Calendar's "add by URL". */
export function feedLinks(worker, path, { days = true, alarms = true } = {}) {
  if (!isFeedPath(path)) return null;
  const query = [!days && 'days=0', !alarms && 'alarms=0'].filter(Boolean).join('&');
  const https = `${workerOrigin(worker)}${path}${query ? `?${query}` : ''}`;
  const webcal = `webcal://${https.slice('https://'.length)}`;
  return { https, webcal, google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}` };
}

/**
 * The member's feed path for one trip, kept on this device only: the worker returns the token once, and other
 * devices see `{exists: true}` until the link is rotated.
 */
export function feedStore(db, ref) {
  const key = `ics:feed:${ref.w}:${ref.s}`;
  let memory = null;
  return {
    async get() {
      try { const value = await db?.get(key); if (isFeedPath(value?.path)) return value.path; } catch { /* storage unavailable */ }
      return memory;
    },
    async set(path) {
      memory = path;
      try { await db?.put(key, { path, at: Date.now() }); } catch { /* kept in memory */ }
    },
    async clear() {
      memory = null;
      try { await db?.remove(key); } catch { /* nothing stored */ }
    },
  };
}

/** A translated message for a `feed.set` failure. */
export function errorMessage(error, { offline = globalThis.navigator?.onLine === false } = {}) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const status = Number.isInteger(error?.status) ? error.status : null;
  if (code === 'owner_credit') return t('ics.errOwnerCredit');
  if (status === 402) return t('ics.errCallerCredit');
  if (code === 'rate_limited' || status === 429) return t('ics.errRateLimited');
  if (code === 'worker_outdated' || status === 426) return t('ics.errOutdated');
  if (status === 403 || status === 404 || code === 'not_member') return t('ics.errForbidden');
  if (offline || status === 0 || code === 'network' || code === 'timeout') return t('ics.errOffline');
  if (status === 503 || code === 'busy') return t('ics.errBusy');
  return t('ics.errGeneric');
}
