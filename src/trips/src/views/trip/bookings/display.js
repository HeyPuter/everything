import { t, strings } from '../../../lib/i18n/index.js';
import { formatDate, formatDuration, formatTime } from '../../../lib/format.js';
import { displayLocale } from '../../../lib/prefs.js';
import { browserTimeZone, isTimeZone } from '../../../shared/dates.js';
import { LEG_FIELDS, isTransport, legDayOffset, legDuration, pointZoneLabel } from '../../../lib/res/index.js';

export const typeLabel = (type) => t(`bookings.type.${type}`);
export const statusLabel = (status) => t(`bookings.status.${status}`);
export const phaseLabel = (name) => t(`bookings.phase.${name}`);
export function legFieldLabel(field, type) {
  const key = `bookings.leg.${field}.${type}`;
  return Object.hasOwn(strings, key) ? t(key) : t(`bookings.leg.${field}`);
}
export function fieldLabel(name) {
  const key = `bookings.field.${name}`;
  return Object.hasOwn(strings, key) ? t(key) : name;
}
const signed = (value) => new Intl.NumberFormat(displayLocale(), { signDisplay: 'always' }).format(value);
const zoneOf = (point) => pointZoneLabel(point, displayLocale());

/** Zones a reservation's times are in. */
export function zonesOf(res) {
  const zones = new Set();
  if (isTransport(res.type) && res.legs?.length) for (const leg of res.legs) { zones.add(leg.from?.tz); zones.add(leg.to?.tz); }
  else { zones.add(res.start?.tz); zones.add(res.end?.tz); }
  zones.delete(undefined);
  return new Set([...zones].filter(isTimeZone));
}
/** Zone labels are printed when a booking spans zones or happens outside the viewer's zone. */
export function showZones(res) {
  const zones = zonesOf(res);
  return zones.size > 1 || (zones.size === 1 && !zones.has(browserTimeZone()));
}

export function pointText(point, { zone = false, date = true } = {}) {
  if (!point?.date) return '';
  const text = [date && formatDate(point.date, { weekday: true, year: false }), point.time && formatTime(point.time)].filter(Boolean).join(' ');
  const label = zone ? zoneOf(point) : '';
  return label ? `${text} ${label}` : text;
}
export const endpointText = (end) => end?.code || end?.name || t('bookings.untitledEndpoint');
// "A → B"; right-to-left locales isolate both ends so the arrow points the right way whatever their script.
const arrow = (from, to) => (from && to ? t('bookings.routeArrow', { from, to }) : from || to);
export const legRoute = (leg) => arrow(endpointText(leg.from), endpointText(leg.to));

/** "Sat 3 May 22:00 → 06:30 +1", with zone labels when asked. */
export function legTimes(leg, { zone = false } = {}) {
  const dep = pointText({ date: leg.dep?.date, time: leg.dep?.time, tz: leg.from?.tz }, { zone });
  const arrPoint = { date: leg.arr?.date, time: leg.arr?.time, tz: leg.to?.tz };
  const offset = legDayOffset(leg);
  const arr = [arrPoint.time && formatTime(arrPoint.time), zone && zoneOf(arrPoint), offset !== 0 && signed(offset)].filter(Boolean).join(' ');
  return arrow(dep, arr);
}
export function legDurationText(leg) {
  const minutes = legDuration(leg);
  return minutes !== null && minutes >= 0 ? formatDuration(minutes) : '';
}

/** Short labelled details of a leg ("TAP 1234", "Seat 12A", …) for the fields its type uses. */
export function legDetails(leg, type) {
  const fields = LEG_FIELDS[type] ?? [];
  const parts = [];
  const service = [leg.carrier, leg.number].filter(Boolean).join(' ');
  if (service) parts.push(service);
  for (const field of fields) {
    if (field === 'carrier' || field === 'number' || !leg[field]) continue;
    parts.push(t('bookings.labelValue', { label: legFieldLabel(field, type), value: leg[field] }));
  }
  return parts;
}

/** When a reservation happens, from its first point to its last. */
export function whenText(res) {
  const zone = showZones(res);
  if (isTransport(res.type) && res.legs?.length) {
    const first = res.legs[0];
    const last = res.legs.at(-1);
    if (res.legs.length === 1) return legTimes(first, { zone });
    const start = pointText({ date: first.dep?.date, time: first.dep?.time, tz: first.from?.tz }, { zone });
    const end = pointText({ date: last.arr?.date, time: last.arr?.time, tz: last.to?.tz }, { zone, date: last.arr?.date !== first.dep?.date });
    return arrow(start, end);
  }
  const start = pointText(res.start, { zone });
  const sameDay = res.end?.date === res.start?.date;
  const end = res.end?.date ? pointText(res.end, { zone, date: !sameDay }) : '';
  return arrow(start, end);
}

export function personName(id, members, guests) {
  const member = members.find((item) => item.uid === id);
  if (member) return member.name;
  const guest = guests.find((item) => item.id === id);
  return guest ? t('bookings.guestName', { name: guest.name }) : t('bookings.unknownPerson');
}
