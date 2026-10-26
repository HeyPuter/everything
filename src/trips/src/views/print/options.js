// Print options: which sections, which days, and how the pages look. Pure apart from the device storage helpers.

export const SECTIONS = Object.freeze(['overview', 'days', 'map', 'bookings', 'packing', 'costs', 'notes']);
export const DETAILS = Object.freeze(['compact', 'detailed']);
export const ORIENTATIONS = Object.freeze(['portrait', 'landscape']);
export const FONTS = Object.freeze(['small', 'medium', 'large']);
// Sections that belong to a trip add-on; a trip that turned the add-on off does not offer them.
const ADDONS = Object.freeze({ packing: 'lists', costs: 'costs', notes: 'collab' });
const DEFAULTS = Object.freeze({
  sections: ['overview', 'days', 'map', 'bookings'], detail: 'detailed', orientation: 'portrait', font: 'medium',
  pageBreak: true, photos: true, compress: true,
});
const KEY = 'trips:print';
const STORED = ['sections', 'detail', 'orientation', 'font', 'pageBreak', 'photos', 'compress'];

/** Sections this trip offers, from `meta.settings.addons`. */
export function availableSections(meta) {
  const addons = meta?.settings?.addons ?? {};
  return SECTIONS.filter((section) => !ADDONS[section] || addons[ADDONS[section]] !== false);
}

const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);
const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

/**
 * Valid options for the given days (plan order). `from`/`to` are day ids, swapped when reversed and widened to the
 * whole trip when unknown; they are null for a trip without days.
 */
export function normalizeOptions(value = {}, { days = [], available = SECTIONS } = {}) {
  const wanted = Array.isArray(value?.sections) ? value.sections : DEFAULTS.sections;
  const ids = days.map((day) => day.id);
  let from = ids.indexOf(value?.from);
  let to = ids.indexOf(value?.to);
  if (from === -1) from = 0;
  if (to === -1) to = ids.length - 1;
  if (from > to) [from, to] = [to, from];
  return {
    sections: SECTIONS.filter((section) => wanted.includes(section) && available.includes(section)),
    detail: pick(value?.detail, DETAILS, DEFAULTS.detail),
    orientation: pick(value?.orientation, ORIENTATIONS, DEFAULTS.orientation),
    font: pick(value?.font, FONTS, DEFAULTS.font),
    pageBreak: flag(value?.pageBreak, DEFAULTS.pageBreak),
    photos: flag(value?.photos, DEFAULTS.photos),
    compress: flag(value?.compress, DEFAULTS.compress),
    from: ids[from] ?? null,
    to: ids[to] ?? null,
  };
}

/** Days from `from` to `to` inclusive, in plan order. */
export function daysInRange(days, { from, to }) {
  const start = days.findIndex((day) => day.id === from);
  const end = days.findIndex((day) => day.id === to);
  if (start === -1 || end === -1) return days.slice();
  return days.slice(Math.min(start, end), Math.max(start, end) + 1);
}

export const has = (options, section) => options.sections.includes(section);

/** Layout choices remembered on this device; the day range is per print. */
export function loadOptions(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(KEY) ?? 'null');
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}
export function saveOptions(options, storage = globalThis.localStorage) {
  try { storage?.setItem(KEY, JSON.stringify(Object.fromEntries(STORED.map((key) => [key, options[key]])))); } catch { /* A convenience only. */ }
}
