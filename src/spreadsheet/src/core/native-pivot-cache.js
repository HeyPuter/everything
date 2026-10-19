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
  const fields = counted(child(root, 'cacheFields'), 'cacheField').map(field => {
    budget(1);
    const shared = child(field, 'sharedItems'), nodes = elements(shared);
    if (integer(shared, 'count', nodes.length) !== nodes.length) fail('shared item count');
    budget(nodes.length);
    return { name: decodeXlsxString(field.getAttribute('name')), databaseField: boolean(field, 'databaseField', true), serverField: boolean(field, 'serverField', false),
      ...(field.hasAttribute('numFmtId') ? { numFmtId: integer(field, 'numFmtId') } : {}),
      items: nodes.map(node => ({ ...nativePivotItemValue(node), ...(node.hasAttribute('c') ? { caption: decodeXlsxString(node.getAttribute('c')) } : {}) })), unused: nodes.map(node => boolean(node, 'u', false)) };
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
        if (value.namespaceURI === MAIN && value.localName === 'x') {
          const index = integer(value, 'v'), items = fields[recordFields[column]].items;
          if (index == null || index >= items.length) fail('shared item index');
          return { ...items[index], index };
        }
        return nativePivotItemValue(value);
      });
    });
  }
  return { fields, recordFields, records, slicerCacheId };
}
