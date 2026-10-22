import { parseModelXml, modelChildren } from './data-model-metadata.js';
import { decodeXlsxString } from './xlsx-string.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const children = (node, name, ns = MAIN) => modelChildren(node, name, ns);
const elements = node => Array.from(node?.childNodes || []).filter(n => n.nodeType === 1);
const fail = message => { throw new Error(`Invalid pivot cache: ${message}`); };
const child = (node, name) => {
  const found = children(node, name);
  if (found.length > 1) fail(`duplicate ${name}`);
  return found[0];
};
function integer(node, name, fallback = null) {
  if (!node?.hasAttribute(name)) return fallback;
  const raw = node.getAttribute(name).trim(), value = Number(raw);
  if (!/^\+?\d+$/.test(raw) || !Number.isSafeInteger(value) || value > 4294967295) fail(name);
  return value;
}
function boolean(node, name, fallback) {
  if (!node.hasAttribute(name)) return fallback;
  const raw = node.getAttribute(name).trim();
  if (!['true', 'false', '0', '1'].includes(raw)) fail(name);
  return raw === 'true' || raw === '1';
}
function counted(node, name) {
  const list = children(node, name);
  if (integer(node, 'count', list.length) !== list.length) fail(`${name} count`);
  return list;
}

/** The same typed values occur in shared items and inline cache records.
 * Dates remain native date/time strings; converting them to worksheet serials
 * requires the workbook date system. Decode ST_Xstring exactly once.
 */
/** A PivotCache date (an ISO date-time such as 2024-03-05T00:00:00) as a 1900-system serial, or null. */
export function pivotDateSerial(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?Z?$/.exec(String(iso ?? '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(v => Number(v ?? 0));
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!Number.isFinite(ms)) return null;
  const serial = ms / 86400000 + 25569;
  // Excel's serials count a 29 February 1900 that never was: dates before March 1900 are one less.
  return serial < 61 ? serial - 1 : serial;
}

export function nativePivotItemValue(node) {
  if (node.namespaceURI !== MAIN) fail('value namespace');
  const type = node.localName, raw = node.getAttribute('v');
  if (type === 'm') return { type: 'blank', value: null };
  if (!node.hasAttribute('v')) fail('missing value');
  if (type === 's') return { type: 'string', value: decodeXlsxString(raw) };
  if (type === 'e') return { type: 'error', value: raw };
  if (type === 'd') return { type: 'date', value: raw };
  if (type === 'n' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()) && Number.isFinite(Number(raw))) return { type: 'number', value: Number(raw) };
  if (type === 'b' && ['0', '1', 'false', 'true'].includes(raw.trim())) return { type: 'boolean', value: ['1', 'true'].includes(raw.trim()) };
  fail('unsupported value');
}

const DATE_GROUPS = ['seconds', 'minutes', 'hours', 'days', 'months', 'quarters', 'years'];
const number = (node, name) => {
  const raw = node.getAttribute(name)?.trim(), value = Number(raw);
  return raw && Number.isFinite(value) ? value : null;
};
// The day of a leap year (1 January is 1, 29 February is 60): Excel's day groups run over all 366.
const leapDay = (month, day) => Math.round((Date.UTC(2000, month - 1, day) - Date.UTC(2000, 0, 1)) / 86400000) + 1;

/**
 * A field grouped where it stands, as Excel groups dates by month or numbers by tens: its members are
 * the group items (before the start, Jan … Dec, after the end), and each value falls in one of them.
 * Returns { items, member(value), of }: member gives a value's group item index (or null), and `of` the
 * one each shared item falls in. Null for a field not grouped so: a fieldGroup that only names a parent,
 * one grouping another field into a field of its own, and manual groups keep the field's own items, and
 * so does a grouping this reader cannot read or that does not place every shared item.
 */
export function nativePivotFieldGroup(field, index, items) {
  const groups = modelChildren(field, 'fieldGroup', MAIN);
  if (groups.length !== 1 || !items.length) return null;
  const node = groups[0], list = modelChildren(node, 'groupItems', MAIN)[0], range = modelChildren(node, 'rangePr', MAIN)[0];
  if (!list || !range || modelChildren(node, 'discretePr', MAIN).length) return null;
  if (node.hasAttribute('base') && node.getAttribute('base').trim() !== String(index)) return null;
  const nodes = elements(list);
  if (list.getAttribute('count') != null && list.getAttribute('count').trim() !== String(nodes.length) || nodes.length < 3) return null;
  let groupItems;
  try { groupItems = nodes.map(n => ({ ...nativePivotItemValue(n), ...(n.hasAttribute('c') ? { caption: decodeXlsxString(n.getAttribute('c')) } : {}) })); }
  catch { return null; }
  const last = groupItems.length - 1, by = range.getAttribute('groupBy') || 'range';
  const interval = number(range, 'groupInterval') ?? 1;
  if (!(interval > 0)) return null;
  // Before the start is the first item, after the end the last; the groups lie between.
  const place = (k) => (Number.isInteger(k) && k >= 1 && k < last ? k : null);
  let member;
  if (DATE_GROUPS.includes(by) || range.hasAttribute('startDate')) {
    const start = pivotDateSerial(range.getAttribute('startDate')), end = pivotDateSerial(range.getAttribute('endDate'));
    if (start == null || end == null) return null;
    member = (value) => {
      const m = value?.type === 'date' && /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(value.value);
      const serial = m && pivotDateSerial(value.value);
      if (serial == null) return null;
      if (serial < start) return 0;
      if (serial > end) return last;
      const [y, mo, d, h, mi, sec] = m.slice(1).map(v => Number(v ?? 0));
      if (by === 'months') return place(mo);
      if (by === 'quarters') return place(Math.ceil(mo / 3));
      if (by === 'years') return place(y - Number(range.getAttribute('startDate').slice(0, 4)) + 1);
      if (by === 'hours') return place(h + 1);
      if (by === 'minutes') return place(mi + 1);
      if (by === 'seconds') return place(sec + 1);
      // Days one by one are days of the year; days n at a time (or a date range) count from the start.
      if (by === 'days' && interval === 1) return place(leapDay(mo, d));
      return place(Math.floor((Math.floor(serial) - Math.floor(start)) / interval) + 1);
    };
  } else if (by === 'range') {
    const start = number(range, 'startNum'), end = number(range, 'endNum');
    if (start == null || end == null) return null;
    member = (value) => {
      if (value?.type !== 'number') return null;
      if (value.value < start) return 0;
      if (value.value > end) return last;
      return place(Math.min(Math.floor((value.value - start) / interval) + 1, last - 1));
    };
  } else return null;
  const of = items.map(member);
  return of.every(k => k != null) ? { items: groupItems, member, of } : null;
}

/** Decode persisted data without refreshing the source or evaluating calculated
 * fields. Records are keyed by their database-field positions, not all fields:
 * MS-OI29500 2.1.790 excludes fields whose databaseField is false.
 * Null records means absent saved data, distinct from a saved empty cache.
 */
export function readNativePivotCache(cache, { maxCells = 1000000, includeRecords = true } = {}) {
  if (!Number.isSafeInteger(maxCells) || maxCells < 0) fail('cell limit');
  if (typeof cache?.xml !== 'string' || cache.xml.length > 16 * 1024 * 1024
    || typeof (cache.records ?? '') !== 'string' || (cache.records?.length || 0) > 128 * 1024 * 1024) fail('metadata size');
  const root = parseModelXml(cache.xml);
  if (root.namespaceURI !== MAIN || root.localName !== 'pivotCacheDefinition') fail('definition root');
  let cells = 0;
  const budget = n => { cells += n; if (cells > maxCells) fail('cell limit exceeded'); };
  const groups = [];
  const fields = counted(child(root, 'cacheFields'), 'cacheField').map(field => {
    budget(1);
    const shared = child(field, 'sharedItems'), nodes = elements(shared);
    if (integer(shared, 'count', nodes.length) !== nodes.length) fail('shared item count');
    budget(nodes.length);
    const items = nodes.map(node => ({ ...nativePivotItemValue(node), ...(node.hasAttribute('c') ? { caption: decodeXlsxString(node.getAttribute('c')) } : {}) }));
    // A field grouped by month (say) has the groups for members, and its records are read into them.
    const group = nativePivotFieldGroup(field, groups.length, items);
    if (group) budget(group.items.length);
    groups.push(group && { ...group, base: items });
    return { name: decodeXlsxString(field.getAttribute('name')), databaseField: boolean(field, 'databaseField', true), serverField: boolean(field, 'serverField', false),
      ...(field.hasAttribute('numFmtId') ? { numFmtId: integer(field, 'numFmtId') } : {}),
      ...(group ? { grouped: true, items: group.items, unused: group.items.map(() => false) } : { items, unused: nodes.map(node => boolean(node, 'u', false)) }) };
  });
  const recordFields = fields.flatMap((field, i) => field.databaseField ? [i] : []);
  // This is the slicer identity, distinct from the core workbook cacheId.
  const extensions = children(child(root, 'extLst'), 'ext').flatMap(ext => children(ext, 'pivotCacheDefinition', X14));
  if (extensions.length > 1) fail('duplicate extended cache identity');
  const slicerCacheId = extensions.length ? integer(extensions[0], 'pivotCacheId') : null;
  let records = null;
  if (includeRecords && cache.records) {
    const data = parseModelXml(cache.records);
    if (data.namespaceURI !== MAIN || data.localName !== 'pivotCacheRecords') fail('records root');
    const rows = counted(data, 'r');
    if (integer(root, 'recordCount', rows.length) !== rows.length) fail('record count');
    budget(rows.length * Math.max(1, recordFields.length));
    records = rows.map(row => {
      const values = elements(row);
      if (values.length !== recordFields.length) fail('record width');
      return values.map((value, column) => {
        const group = groups[recordFields[column]];
        if (value.namespaceURI === MAIN && value.localName === 'x') {
          const index = integer(value, 'v'), items = group ? group.base : fields[recordFields[column]].items;
          if (index == null || index >= items.length) fail('shared item index');
          if (!group) return { ...items[index], index };
          const at = group.of[index];
          return { ...fields[recordFields[column]].items[at], index: at };
        }
        const item = nativePivotItemValue(value);
        if (!group) return item;
        const at = group.member(item);
        if (at == null) fail('grouped value');
        return { ...fields[recordFields[column]].items[at], index: at };
      });
    });
  }
  return { fields, recordFields, records, slicerCacheId };
}
