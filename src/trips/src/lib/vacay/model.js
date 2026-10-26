// Validation and defaults for Vacay values. Everything read from KV, including the user's own, is untrusted.
import { validateVacay } from '../../shared/schema/index.js';
import { GROUPS } from './keys.js';

export const NOTE_MAX = 200;
export const NAME_MAX = 100;
export const COLORS = 8;
export const MODES = Object.freeze(['fused', 'view']);
export const CALENDAR_TYPES = Object.freeze(['public', 'school', 'custom']);
const INDEX_MAX = { e: 5000, company: 2000, allow: 200, cal: 100, inv: 500 };
const COUNTRY = /^[A-Z]{2}$/;
const REGION = /^[A-Z]{2}-[A-Z0-9]{1,6}(?:-[A-Z0-9]{1,6})?$/;

/** The value when it matches the schema for `type`, else null. */
export function valid(type, value) {
  if (value == null) return null;
  try { return validateVacay(type, value); } catch { return null; }
}

export const isCountry = (value) => typeof value === 'string' && COUNTRY.test(value);
export const isRegion = (value) => typeof value === 'string' && REGION.test(value);
export const colorSlot = (value) => (Number.isInteger(value) && value >= 1 && value <= COLORS ? value : null);
export const clampText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** A plan usable for display: valid stored fields, with an invalid plan read as the defaults. */
export function readPlan(value) {
  const plan = valid('plan', value);
  return plan ? { ...plan, color: colorSlot(plan.color) ?? 1 } : null;
}

/** Keeps the valid ids and stamps of each index group; a damaged group never hides the others. */
export function cleanIndex(value) {
  const index = { e: {}, company: {}, allow: {}, cal: {}, inv: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return index;
  for (const group of Object.keys(index)) {
    const entries = value[group] && typeof value[group] === 'object' && !Array.isArray(value[group]) ? Object.entries(value[group]) : [];
    for (const [id, at] of entries.slice(0, INDEX_MAX[group])) {
      if (GROUPS[group].valid(id) && Number.isSafeInteger(at) && at >= 0) index[group][id] = at;
    }
  }
  return index;
}

export function readEntry(value) {
  const entry = valid('entry', value);
  return entry ? { fraction: entry.fraction, kind: entry.kind, ...(entry.note ? { note: clampText(entry.note, NOTE_MAX) } : {}) } : null;
}
export function readCompany(value) {
  const day = valid('company', value);
  return day ? (day.note ? { note: clampText(day.note, NOTE_MAX) } : {}) : null;
}
export function readAllowance(value) { return valid('allowance', value); }
export function readCalendar(value) {
  const calendar = valid('calendar', value);
  if (!calendar || !CALENDAR_TYPES.includes(calendar.type)) return null;
  const region = calendar.region ?? '';
  if (calendar.type !== 'custom' && !isCountry(region) && !isRegion(region)) return null;
  const periods = calendar.periods.filter((period) => period.start <= period.end);
  return { type: calendar.type, region, label: clampText(calendar.label, NAME_MAX), color: colorSlot(calendar.color) ?? 2, periods };
}
export function readInvite(value) {
  const invite = valid('invite', value);
  return invite ? { ...invite, name: clampText(invite.name, NAME_MAX) } : null;
}

/** A record of `type` ('shares' or 'grants') keeping only valid items. */
export function readRecord(type, value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, item] of Object.entries(value).slice(0, 500)) {
    if (!/^[0-9a-f]{32}$/.test(key)) continue;
    if (valid(type, { [key]: item })) out[key] = { ...item, ...(item.name ? { name: clampText(item.name, NAME_MAX) } : {}) };
  }
  return out;
}
