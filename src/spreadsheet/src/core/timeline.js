/**
 * Insert ▸ Timeline: a date filter for a PivotTable, shown as a strip of periods (years,
 * quarters, months or days) on which a range is chosen. The range filters the report through the
 * date field's member selection, the same report state a slicer writes, so the PivotTable keeps
 * the filter wherever it is opened. A timeline control is this app's own drawing object
 * { type: 'timeline', report: { owner, name }, field, level, start, end } kept in the workbook's
 * own data; in an .xlsx it travels in the app's sidecar, not as an Excel timeline part.
 */
import { readNativePivotCache, pivotDateSerial } from './native-pivot-cache.js';
import { planNativePivotReport } from './native-pivot-report.js';
import { prepareNativePivotReportUpdates } from './native-pivot-refresh-plan.js';
import { commitNativePivotReports } from './native-pivot-commit.js';
import { indexNativePivotField, withFieldItems } from './native-pivot-index-field.js';
import { syncNativePivotSlicers } from './native-pivot-slicer-sync.js';
import { effectiveColorPalette } from './font-color.js';
import { parseModelXml, modelChildren } from './data-model-metadata.js';
import { decodeXlsxString } from './xlsx-string.js';
import { parseRefText, sheetKey } from './refs.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

export const TIMELINE_LEVELS = [['years', 'YEARS'], ['quarters', 'QUARTERS'], ['months', 'MONTHS'], ['days', 'DAYS']];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const TIMELINE_DEFAULTS = { w: 336, h: 140 };

export { pivotDateSerial };

const toUtc = serial => new Date(((serial < 61 ? serial + 1 : serial) - 25569) * 86400000);
const fromUtc = (y, m, d) => pivotDateSerial(`${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
/** Calendar parts of a serial: { y, m (0–11), d }. */
export function serialParts(serial) {
  const t = toUtc(Math.floor(serial));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

/** The first and last day (serials) of the period of `level` holding `serial`. */
export function periodBounds(serial, level) {
  const { y, m } = serialParts(serial), day = Math.floor(serial);
  if (level === 'days') return { start: day, end: day };
  if (level === 'years') return { start: fromUtc(y, 0, 1), end: fromUtc(y + 1, 0, 1) - 1 };
  const first = level === 'quarters' ? m - (m % 3) : m, months = level === 'quarters' ? 3 : 1;
  const nextY = y + Math.floor((first + months) / 12), nextM = (first + months) % 12;
  return { start: fromUtc(y, first, 1), end: fromUtc(nextY, nextM, 1) - 1 };
}

/** Every period of `level` from the one holding `min` to the one holding `max`, with its label and group. */
export function timelinePeriods(min, max, level, limit = 5000) {
  if (min == null || max == null) return [];
  const out = [];
  for (let at = periodBounds(min, level).start; at <= max && out.length < limit;) {
    const { start, end } = periodBounds(at, level), { y, m, d } = serialParts(start);
    const label = level === 'years' ? String(y) : level === 'quarters' ? `Q${m / 3 + 1}` : level === 'months' ? MONTHS[m].toUpperCase() : String(d);
    const group = level === 'years' ? '' : level === 'days' ? `${MONTHS[m].toUpperCase()} ${y}` : String(y);
    out.push({ start, end, label, group });
    at = end + 1;
  }
  return out;
}

/** The selection as the timeline's caption line reads it: "Mar 2024", "Q1 - Q3 2024", "All Periods". */
export function timelineSelectionLabel(start, end, level) {
  if (start == null || end == null) return 'All Periods';
  const a = serialParts(start), b = serialParts(end);
  const one = (p, lvl) => lvl === 'years' ? `${p.y}` : lvl === 'quarters' ? `Q${Math.floor(p.m / 3) + 1} ${p.y}` : lvl === 'months' ? `${MONTHS[p.m]} ${p.y}` : `${MONTHS[p.m]} ${p.d}, ${p.y}`;
  const first = one(a, level), last = one(b, level);
  if (first === last) return first;
  if (a.y === b.y && level !== 'years') {
    const short = p => level === 'quarters' ? `Q${Math.floor(p.m / 3) + 1}` : level === 'months' ? MONTHS[p.m] : `${MONTHS[p.m]} ${p.d}`;
    return `${short(a)} - ${short(b)} ${a.y}`;
  }
  return `${first} - ${last}`;
}

export function normalizeTimeline(raw) {
  if (!raw?.anchor || typeof raw.field !== 'string' || !raw.field || typeof raw.report?.name !== 'string') return null;
  const finite = (v, fallback) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const anchor = { r: Math.max(0, Math.min(1048575, Math.trunc(finite(raw.anchor.r, 0)))), c: Math.max(0, Math.min(16383, Math.trunc(finite(raw.anchor.c, 0)))) };
  const start = finite(raw.start, null), end = finite(raw.end, null);
  return { id: raw.id, type: 'timeline', anchor, range: { r1: anchor.r, c1: anchor.c, r2: anchor.r, c2: anchor.c },
    report: { owner: raw.report.owner == null ? null : String(raw.report.owner), name: raw.report.name }, field: raw.field,
    level: TIMELINE_LEVELS.some(([key]) => key === raw.level) ? raw.level : 'months',
    ...(start != null && end != null && start <= end ? { start, end } : { start: null, end: null }),
    title: typeof raw.title === 'string' ? raw.title.slice(0, 32767) : raw.field,
    dx: finite(raw.dx, 0), dy: finite(raw.dy, 0), w: Math.max(0, finite(raw.w, TIMELINE_DEFAULTS.w)), h: Math.max(0, finite(raw.h, TIMELINE_DEFAULTS.h)),
    ...(raw.anchorMode === 'absolute' ? { anchorMode: 'absolute' } : {}),
    showHeader: raw.showHeader !== false, showSelectionLabel: raw.showSelectionLabel !== false,
    showTimeLevel: raw.showTimeLevel !== false, showHorizontalScrollbar: raw.showHorizontalScrollbar !== false,
    lockedPosition: raw.lockedPosition === true, print: raw.print !== false };
}

/** The values a cache field holds as dates: shared items, or else the inline values of the records. */
function fieldDates(cache, index) {
  const data = readNativePivotCache(cache, { includeRecords: !readNativePivotCache(cache, { includeRecords: false }).fields[index]?.items.length });
  const field = data.fields[index];
  if (field.items.length) return field.items.map(item => (item.type === 'date' ? pivotDateSerial(item.value) : null));
  const column = data.recordFields.indexOf(index);
  return (data.records || []).map(row => (row[column]?.type === 'date' ? pivotDateSerial(row[column].value) : null));
}

/** The report's fields a timeline can filter: those whose values are all dates (blanks aside). */
export function pivotDateFields(wb, pivot) {
  const cache = wb.nativePivots?.caches.find(c => c.key === pivot.cache);
  if (!cache) return [];
  const data = readNativePivotCache(cache, { includeRecords: false });
  const root = parseModelXml(cache.xml), cacheFields = modelChildren(modelChildren(root, 'cacheFields', MAIN)[0], 'cacheField', MAIN);
  return data.fields.flatMap((field, index) => {
    if (!field.databaseField || field.serverField) return [];
    const shared = modelChildren(cacheFields[index], 'sharedItems', MAIN)[0];
    const declared = shared?.getAttribute('containsDate') === '1' && shared.getAttribute('containsNonDate') === '0';
    const dated = field.items.length ? field.items.every(item => item.type === 'date' || item.type === 'blank') && field.items.some(item => item.type === 'date') : declared;
    return dated ? [{ index, name: field.name }] : [];
  });
}

/** The report a timeline filters, its cache, and the date field's index, or null when any is gone. */
export function timelineSource(wb, control) {
  const pivots = wb.nativePivots;
  const named = (pivots?.tables || []).filter(p => sheetKey(decodeXlsxString(p.name)) === sheetKey(decodeXlsxString(control.report.name)));
  // Sheet identities are renewed when a file is opened: then the report's name alone, when it is unique, finds it.
  const pivot = named.find(p => p.owner === control.report.owner) || (named.length === 1 ? named[0] : null);
  const cache = pivot && pivots.caches.find(c => c.key === pivot.cache);
  if (!cache) return null;
  const index = readNativePivotCache(cache, { includeRecords: false }).fields.findIndex(f => sheetKey(f.name) === sheetKey(control.field));
  return index < 0 ? null : { pivots, pivot, cache, index };
}

/** What a timeline view draws: the data's first and last day, the chosen range, and the days that have data. */
export function timelineState(wb, control) {
  const source = timelineSource(wb, control);
  if (!source) return null;
  const dates = fieldDates(source.cache, source.index).filter(v => v != null);
  if (!dates.length) return { min: null, max: null, start: control.start, end: control.end, days: new Set() };
  let min = Infinity, max = -Infinity;
  for (const d of dates) { if (d < min) min = d; if (d > max) max = d; }
  return { min: Math.floor(min), max: Math.floor(max), start: control.start, end: control.end, days: new Set(dates.map(Math.floor)) };
}

function paintContext(wb) {
  const palette = effectiveColorPalette(wb.colorPalette);
  return { themes: { fontTheme: wb.fontTheme, themeElements: { clrScheme: palette.theme.map(rgb => ({ rgb: rgb?.slice(1) })) }, indexedColors: palette.indexed.map(rgb => rgb?.slice(1)) },
    numberFormats: wb.nativePivots.formats };
}

/** Apply a date range (serials, inclusive by day; null clears) to the report and the control, as one step. */
export function setTimelineSelection(wb, sheetId, id, start, end) {
  const control = wb.chartById(sheetId, id), owner = wb.sheet(sheetId);
  if (control?.type !== 'timeline' || !owner || wb._locked(owner)) return false;
  const source = timelineSource(wb, control);
  if (!source) throw new Error('The PivotTable or date field this timeline filters is no longer there.');
  if ((start == null) !== (end == null) || start != null && (!Number.isFinite(start) || !Number.isFinite(end) || start > end)) return false;
  const pivots = indexNativePivotField(source.pivots, source.pivot.cache, source.index);
  const cache = pivots.caches.find(c => c.key === source.pivot.cache);
  const items = start == null ? null : readNativePivotCache(cache, { includeRecords: false }).fields[source.index].items
    .flatMap((item, i) => { const d = item.type === 'date' ? pivotDateSerial(item.value) : null; return d != null && d >= start && d < end + 1 ? [i] : []; });
  const sheet = wb.sheet(source.pivot.owner);
  if (!sheet || sheet.kind === 'chart') throw new Error('The PivotTable is not on a worksheet.');
  // The date field gets its full item list (with its default subtotal) before members are hidden.
  const report = { ...source.pivot, xml: withFieldItems(source.pivot.xml, source.index, readNativePivotCache(cache, { includeRecords: false }).fields[source.index].items.length) };
  const plan = planNativePivotReport(report, cache, { nativePivots: pivots, selections: [{ field: source.index, items }],
    paintContext: paintContext(wb), conditionalRules: sheet.rules, sheetName: sheet.name });
  const { updates, rules } = prepareNativePivotReportUpdates(wb, [{ pivot: source.pivot, cache: source.cache, plan, nextCache: cache === source.cache ? null : cache }]);
  // Slicers on the same report show which of their items still have data in the new range.
  const prepared = { ...pivots, tables: pivots.tables.map(p => (p === source.pivot ? plan.pivot : p)) };
  const slicerUpdates = syncNativePivotSlicers(source.pivots, prepared, wb.sheets, [source.pivot]);
  if (cache !== source.cache) for (const s of source.pivots.slicers || []) if (s.cache === cache.key && !slicerUpdates.has(s)) slicerUpdates.set(s, s);
  wb.transaction('Timeline', () => {
    commitNativePivotReports(wb, updates, { rules, slicerUpdates, ...(cache === source.cache ? {} : { cacheUpdates: new Map([[source.cache, cache]]) }) });
    // Every view of the same field (a duplicated timeline) shows the one filter.
    const range = { start: start == null ? null : Math.floor(start), end: end == null ? null : Math.floor(end) };
    for (const other of wb.sheets) for (const view of other.charts) {
      if (view.type !== 'timeline' || sheetKey(view.field) !== sheetKey(control.field)) continue;
      const shared = timelineSource(wb, view);
      if (view.id === id || shared?.pivot === source.pivot || shared?.pivot.name === source.pivot.name && shared?.pivot.owner === source.pivot.owner) wb.updateChart(other.id, view.id, range, 'Timeline');
    }
  });
  return true;
}

/** Put a timeline for a date field of a report on the report's sheet, beside it. Returns its id. */
export function insertTimeline(wb, sheetId, pivot, fieldIndex, { at = null } = {}) {
  if (wb.isProtected?.(sheetId)) throw new Error('Unprotect the sheet to insert a timeline.');
  const field = pivotDateFields(wb, pivot).find(f => f.index === fieldIndex);
  if (!field) throw new Error('Choose a date field of the PivotTable.');
  const range = parseRefText(pivot.ref || '');
  const anchor = at || { r: range ? range.r1 : 0, c: range ? range.c2 + 2 : 0 };
  const taken = wb.sheet(sheetId).charts.filter(c => c.type === 'timeline' || c.type === 'slicer').length;
  const control = normalizeTimeline({ type: 'timeline', anchor, dx: 0, dy: 24 * taken, report: { owner: pivot.owner, name: pivot.name }, field: field.name, title: field.name, level: 'months' });
  return wb.addChart(sheetId, control);
}

/** Deleting a timeline takes its filter off the PivotTable first, so no hidden filter is left behind. */
export function deleteTimeline(wb, sheetId, id) {
  const control = wb.chartById(sheetId, id);
  if (control?.type !== 'timeline') return false;
  let done = false;
  wb.transaction('Delete timeline', () => {
    if (control.start != null && timelineSource(wb, control)) {
      try { setTimelineSelection(wb, sheetId, id, null, null); } catch { /* the report cannot be rebuilt: leave its filter */ }
    }
    done = wb.deleteChart(sheetId, id);
  });
  return done;
}
