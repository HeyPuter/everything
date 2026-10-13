// Sparse exceptions to inherited formats. The historical `styleResets` field
// keeps its JSON shape: keys absent from `values` restore Normal; a supplied
// value overrides that property. Records and arrays are immutable snapshots.
import { readRangeFlags, compactRangeFlags } from './range-flags.js';
import { cloneStyle, BORDER_STYLE_KEYS } from './style-values.js';
export { BORDER_STYLE_KEYS } from './style-values.js';
import { normalizeFontColor } from './font-color.js';
import { MAX_FORMAT_CODE_LENGTH } from './numfmt.js';
import { GRID_RANGE, rowRuns, mapRangeRecords, compactRangeRecords,
  shiftRangeRecords, permuteRangeRecords, moveLineRangeRecords, moveRangeRecords,
  forEachRangeRecordAt, forEachRangeRecordIn } from './range-records.js';
export { GRID_RANGE, intersection, rowRuns, mapRangeRecords as mapStyleResets } from './range-records.js';

export const STYLE_KEYS = ['bold', 'italic', 'underline', 'strike', 'align', 'color', 'bg', 'nativeFill', 'fmt', 'dec', 'cur', 'wrap', ...BORDER_STYLE_KEYS, 'size', 'valign', 'dateStyle', 'sec', 'group', 'font', 'scheme', 'code', 'indent', 'rot', 'clip', 'shrink', 'locked', 'formulaHidden', 'cellStyle'];
const sideKeys = new Set(['btBorder', 'bbBorder', 'blBorder', 'brBorder']);

function valueFor(key, value) {
  if (value == null) return null;
  if (key === 'shrink') return typeof value === 'boolean' ? value : undefined;
  if (key === 'scheme') return ['major', 'minor', 'none'].includes(value) ? value : undefined;
  if (key === 'color') return normalizeFontColor(value) || undefined;
  if (sideKeys.has(key)) {
    if (typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    for (const k of ['bs', 'bc']) if (Object.hasOwn(value, k)) {
      if (value[k] != null && typeof value[k] !== 'string') return undefined;
      out[k] = value[k] ?? null;
    }
    return out;
  }
  if (key === 'code' && (typeof value !== 'string' || value.length > MAX_FORMAT_CODE_LENGTH)) return undefined;
  return ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// Keep the values dictionary in step with its key set after partial removals.
function withKeys(record, keys) {
  const values = Object.fromEntries(keys.filter(k => record.values && record.values[k] != null)
    .map(k => [k, record.values[k]]));
  return { range: record.range, keys, ...(Object.keys(values).length ? { values } : {}) };
}

export function removeStyleResets(records, area, keys = null, skipRow = null) {
  const removed = keys && new Set(keys);
  return mapRangeRecords(records, area, record => {
    const keep = removed ? record.keys.filter(k => !removed.has(k)) : [];
    if (keep.length === record.keys.length) return [record];
    return [...(keep.length ? [withKeys(record, keep)] : []),
      ...(skipRow ? rowRuns(record.range, skipRow).map(range => ({ ...record, range })) : [])];
  });
}

/** Records must already be disjoint per property, or overlap with equal values.
 * All updates below remove the previous property in their rectangle first. */
export function compactStyleResets(records) {
  if (!records.some(record => record.values)) return compactRangeFlags(records);
  const normalized = records.filter(record => record.keys.length).map(record => withKeys(record, [...new Set(record.keys)].sort()));
  return compactRangeRecords(normalized, record => JSON.stringify(record.keys.map(k => [k, record.values?.[k] ?? null])));
}

/** Last assignment wins independently per property, preserving unrelated keys. */
export function assignStyleExceptions(records, range, values) {
  const keys = Object.keys(values).filter(k => STYLE_KEYS.includes(k));
  if (!keys.length) return records;
  const kept = removeStyleResets(records, range, keys);
  const concrete = Object.fromEntries(keys.filter(k => values[k] != null).map(k => [k, values[k]]));
  return compactStyleResets([...kept, { range: { ...range }, keys, ...(Object.keys(concrete).length ? { values: cloneStyle(concrete) } : {}) }]);
}

/** Assign a batch of nonoverlapping rectangles without scanning every old
 * record for each new rectangle. Used by sparse inherited-border edits. */
export function assignStyleExceptionRegions(records, regions) {
  if (!regions.length) return records;
  const added = regions.map(({ range, values }) => ({ range: { ...range }, keys: Object.keys(values), values: cloneStyle(values) }));
  const kept = records.flatMap(record => {
    let pieces = [record];
    forEachRangeRecordIn(added, record.range, next => { pieces = removeStyleResets(pieces, next.range, next.keys); });
    return pieces;
  });
  return compactStyleResets([...kept, ...added]);
}

export function readStyleResets(raw) {
  if (!Array.isArray(raw)) return [];
  if (!raw.some(record => record?.values != null)) return readRangeFlags(raw, STYLE_KEYS);
  const records = [];
  for (const record of raw) {
    const valid = readRangeFlags([record], STYLE_KEYS)[0];
    if (!valid || record.values != null && (typeof record.values !== 'object' || Array.isArray(record.values))) continue;
    const values = {};
    for (const key of valid.keys) {
      const value = record.values && Object.hasOwn(record.values, key) ? valueFor(key, record.values[key]) : null;
      if (value !== undefined) values[key] = value;
    }
    const keys = Object.keys(values);
    if (keys.length) records.push(withKeys({ range: valid.range, values: cloneStyle(values) }, keys));
  }
  // App snapshots are already disjoint per property. Replaying every record
  // through assignment would repeatedly compact the growing prefix, making
  // reopening a workbook with many small edits quadratic.
  const overlaps = records.some((record, i) => {
    let found = false;
    forEachRangeRecordIn(records, record.range, (other, j) => {
      if (j < i && other.keys.some(k => record.keys.includes(k))) found = true;
    });
    return found;
  });
  if (!overlaps) return compactStyleResets(records);
  // External metadata may overlap: retain the historical last-assignment
  // rule independently for each property.
  let out = [];
  for (const record of records) out = assignStyleExceptions(out, record.range, Object.fromEntries(record.keys.map(k => [k, record.values?.[k] ?? null])));
  return out;
}

export const shiftStyleResets = (records, axis, at, count, remove, band = GRID_RANGE) =>
  compactStyleResets(shiftRangeRecords(records, axis, at, count, remove, band));
export const permuteStyleResets = (records, area, axis, map) =>
  compactStyleResets(permuteRangeRecords(records, area, axis, map));
export const moveLineStyleResets = (records, axis, edges, map) =>
  compactStyleResets(moveLineRangeRecords(records, axis, edges, map));
export const moveStyleResets = (records, src, dst) => compactStyleResets(moveRangeRecords(records, src, dst));

export function styleResetAt(records, r, c) {
  if (!records.length) return null;
  let style = null;
  forEachRangeRecordAt(records, r, c, record => {
    style ??= {};
    for (const key of record.keys) style[key] = record.values && Object.hasOwn(record.values, key)
      ? record.values[key] : key === 'code' ? '' : null;
  });
  return style;
}
