/**
 * Get & Transform (a compact Power Query): queries stored with the workbook, each a source and an ordered
 * list of applied steps, evaluated here into a table of columns, column types and rows. The editor previews
 * any step's result; Close & Load writes the last one into the sheet as an ordinary table, which Refresh
 * rewrites from the source. The definitions travel in the app's own XLSX metadata; Excel opens the loaded
 * table as plain data (the DataMashup query part is not written).
 *
 * A table here is { columns: string[], types: string[], rows: any[][] }. A value is null, a string, a number
 * (a date is its serial, the column's type says it is a date), a boolean, or a cell error { error, message }.
 */
import { parseDelimited } from './tsv.js';
import { parseInput, parseDate, serialToYMD, typedDateKind } from './format.js';
import { tableRows } from './tables.js';
import { maxOf } from './numeric.js';

export const TYPES = ['any', 'text', 'int', 'decimal', 'datetime', 'date', 'time', 'bool'];
export const TYPE_LABELS = { any: 'Any', text: 'Text', int: 'Whole Number', decimal: 'Decimal Number', datetime: 'Date/Time', date: 'Date', time: 'Time', bool: 'True/False' };
/** The marks the editor puts before a column name, as Power Query's header icons read. */
export const TYPE_MARKS = { any: 'ABC\n123', text: 'ABC', int: '123', decimal: '1.2', datetime: '▦◷', date: '▦', time: '◷', bool: '✓✗' };
const M_TYPES = { any: 'type any', text: 'type text', int: 'Int64.Type', decimal: 'type number', datetime: 'type datetime', date: 'type date', time: 'type time', bool: 'type logical' };
/** The types whose values are date serials: a date, a date with its time of day, or a time of day alone. */
export const DATE_TYPES = new Set(['date', 'datetime', 'time']);

export const SOURCE_KINDS = ['csv', 'web', 'workbook', 'table', 'query', 'blank'];
/** Step types and the name Power Query gives a step of each kind. */
export const STEP_NAMES = {
  promoteHeaders: 'Promoted Headers', demoteHeaders: 'Demoted Headers', changeType: 'Changed Type', removeColumns: 'Removed Columns',
  selectColumns: 'Removed Other Columns', renameColumns: 'Renamed Columns', filterRows: 'Filtered Rows', sortRows: 'Sorted Rows',
  removeDuplicates: 'Removed Duplicates', replaceValues: 'Replaced Value', splitColumn: 'Split Column by Delimiter', addIndex: 'Added Index',
  groupBy: 'Grouped Rows', keepFirst: 'Kept First Rows', keepLast: 'Kept Last Rows', removeFirst: 'Removed Top Rows', removeLast: 'Removed Bottom Rows',
  removeBlankRows: 'Removed Blank Rows', merge: 'Merged Queries', fillDown: 'Filled Down', fillUp: 'Filled Up', transformText: 'Transformed Text',
  duplicateColumn: 'Duplicated Column', reorderColumns: 'Reordered Columns', removeErrors: 'Removed Errors', addTextColumn: 'Inserted Text',
};
const TEXT_OP_NAMES = { lower: 'Lowercased Text', upper: 'Uppercased Text', proper: 'Capitalized Each Word', trim: 'Trimmed Text', clean: 'Cleaned Text' };
/** The column Add Column ▸ Format adds is named after the format, as Power Query names it. */
export const TEXT_COLUMN_NAMES = { lower: 'lowercase', upper: 'UPPERCASE', proper: 'Capitalize Each Word', trim: 'Trim', clean: 'Clean' };
export const FILTER_OPS = {
  equals: 'equals', notEquals: 'does not equal', beginsWith: 'begins with', notBeginsWith: 'does not begin with', endsWith: 'ends with',
  notEndsWith: 'does not end with', contains: 'contains', notContains: 'does not contain', gt: 'is greater than', gte: 'is greater than or equal to',
  lt: 'is less than', lte: 'is less than or equal to', isNull: 'is null', notNull: 'is not null', isBlank: 'is blank', notBlank: 'is not blank',
  after: 'is after', onOrAfter: 'is after or equal to', before: 'is before', onOrBefore: 'is before or equal to',
};
export const AGGREGATIONS = { sum: 'Sum', avg: 'Average', median: 'Median', min: 'Min', max: 'Max', count: 'Count Rows', countDistinct: 'Count Distinct Rows' };
export const JOIN_KINDS = { leftOuter: 'Left Outer (all from first, matching from second)', rightOuter: 'Right Outer (all from second, matching from first)',
  fullOuter: 'Full Outer (all rows from both)', inner: 'Inner (only matching rows)', leftAnti: 'Left Anti (rows only in first)', rightAnti: 'Right Anti (rows only in second)' };

export const PREVIEW_ROWS = 200;
const MAX_QUERIES = 200, MAX_STEPS = 500, MAX_SOURCE_CHARS = 8_000_000, MAX_CELLS = 2_000_000;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isErr = (v) => isObj(v) && typeof v.error === 'string';
const str = (v, max = 4096) => (typeof v === 'string' ? v.slice(0, max) : '');
const newId = () => (globalThis.crypto?.randomUUID?.() || `q${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
const dataError = (message) => ({ error: 'DataFormat.Error', message });

/* ---------- The stored model ---------- */

function normalizeValue(v) {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return null;
}

function normalizeSource(raw) {
  if (!isObj(raw) || !SOURCE_KINDS.includes(raw.kind)) return { kind: 'blank' };
  const s = { kind: raw.kind };
  if (raw.kind === 'csv') {
    s.name = str(raw.name, 260) || 'data.csv';
    s.text = typeof raw.text === 'string' ? raw.text.slice(0, MAX_SOURCE_CHARS) : '';
    if (typeof raw.delimiter === 'string' && raw.delimiter.length <= 4) s.delimiter = raw.delimiter;
    if (typeof raw.path === 'string') s.path = str(raw.path, 2048);
  } else if (raw.kind === 'web') {
    s.url = str(raw.url, 2048);
    if (typeof raw.item === 'string') s.item = str(raw.item, 260);
  } else if (raw.kind === 'workbook') {
    s.name = str(raw.name, 260) || 'Workbook';
    s.item = str(raw.item, 260);
    if (typeof raw.path === 'string') s.path = str(raw.path, 2048);
    let cells = 0;
    s.rows = Array.isArray(raw.rows) ? raw.rows.filter(Array.isArray).map((row) => row.slice(0, 16384).map(normalizeValue))
      .filter((row) => (cells += row.length) <= MAX_CELLS) : [];
  } else if (raw.kind === 'table') {
    s.table = str(raw.table, 255);
  } else if (raw.kind === 'query') {
    s.query = str(raw.query, 255);
  }
  return s;
}

const names = (v) => (Array.isArray(v) ? v.filter((n) => typeof n === 'string').map((n) => n.slice(0, 1024)) : []);

function normalizeStep(raw) {
  if (!isObj(raw) || !STEP_NAMES[raw.type]) return null;
  const step = { id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : newId(), type: raw.type };
  if (typeof raw.name === 'string' && raw.name.trim()) step.name = raw.name.trim().slice(0, 255);
  switch (raw.type) {
    case 'changeType': {
      step.columns = {};
      for (const [k, t] of Object.entries(isObj(raw.columns) ? raw.columns : {})) if (TYPES.includes(t)) step.columns[k] = t;
      break;
    }
    case 'removeColumns': case 'selectColumns': case 'reorderColumns': case 'removeErrors': step.columns = names(raw.columns); break;
    case 'removeDuplicates': step.columns = Array.isArray(raw.columns) ? names(raw.columns) : null; break;
    case 'renameColumns': step.renames = (Array.isArray(raw.renames) ? raw.renames : []).filter((p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string').map(([a, b]) => [a, b]); break;
    case 'filterRows': {
      step.column = str(raw.column, 1024);
      step.join = raw.join === 'or' ? 'or' : 'and';
      step.conditions = (Array.isArray(raw.conditions) ? raw.conditions : []).slice(0, 50).map((c) => {
        if (!isObj(c)) return null;
        if (c.op === 'in' || c.op === 'notIn') return { op: c.op, values: (Array.isArray(c.values) ? c.values : []).slice(0, 100000).map(normalizeValue) };
        if (!FILTER_OPS[c.op]) return null;
        return { op: c.op, value: normalizeValue(c.value) };
      }).filter(Boolean);
      break;
    }
    case 'sortRows': step.keys = (Array.isArray(raw.keys) ? raw.keys : []).filter((k) => isObj(k) && typeof k.column === 'string').map((k) => ({ column: k.column, desc: k.desc === true })); break;
    case 'replaceValues':
      step.columns = names(raw.columns); step.find = normalizeValue(raw.find); step.replace = normalizeValue(raw.replace);
      step.matchEntire = raw.matchEntire === true;
      break;
    case 'splitColumn':
      step.column = str(raw.column, 1024); step.delimiter = typeof raw.delimiter === 'string' ? raw.delimiter.slice(0, 64) : ',';
      step.mode = ['each', 'left', 'right'].includes(raw.mode) ? raw.mode : 'each';
      if (Number.isInteger(raw.count) && raw.count > 0) step.count = Math.min(raw.count, 1000);
      break;
    case 'addIndex':
      step.column = str(raw.column, 1024) || 'Index';
      step.start = Number.isFinite(raw.start) ? raw.start : 0; step.increment = Number.isFinite(raw.increment) ? raw.increment : 1;
      break;
    case 'groupBy':
      step.keys = names(raw.keys);
      step.aggregations = (Array.isArray(raw.aggregations) ? raw.aggregations : []).filter((a) => isObj(a) && AGGREGATIONS[a.op])
        .map((a) => ({ name: str(a.name, 1024) || AGGREGATIONS[a.op], op: a.op, column: str(a.column, 1024) }));
      break;
    case 'keepFirst': case 'keepLast': case 'removeFirst': case 'removeLast':
      step.count = Number.isInteger(raw.count) && raw.count >= 0 ? raw.count : 1; break;
    case 'merge':
      step.query = str(raw.query, 255); step.left = names(raw.left); step.right = names(raw.right);
      step.kind = JOIN_KINDS[raw.kind] ? raw.kind : 'leftOuter';
      step.column = str(raw.column, 1024) || step.query; step.expand = names(raw.expand);
      break;
    case 'fillDown': case 'fillUp': step.columns = names(raw.columns); break;
    case 'transformText': step.columns = names(raw.columns); step.op = TEXT_OP_NAMES[raw.op] ? raw.op : 'trim'; break;
    case 'addTextColumn':
      step.column = str(raw.column, 1024); step.op = TEXT_OP_NAMES[raw.op] ? raw.op : 'trim';
      step.as = str(raw.as, 1024) || TEXT_COLUMN_NAMES[step.op];
      break;
    case 'duplicateColumn': step.column = str(raw.column, 1024); step.as = str(raw.as, 1024); break;
    default: break;
  }
  return step;
}

function normalizeLoad(raw) {
  if (!isObj(raw) || raw.kind !== 'table') return { kind: 'connection' };
  // `columns`: the query's own columns as last loaded, which tells them from columns added to the table by hand.
  return { kind: 'table', table: str(raw.table, 255), ...(typeof raw.sheet === 'string' ? { sheet: str(raw.sheet, 31) } : {}),
    ...(Array.isArray(raw.columns) ? { columns: names(raw.columns).slice(0, 16384) } : {}) };
}

export function normalizeQuery(raw) {
  if (!isObj(raw) || typeof raw.name !== 'string' || !raw.name.trim()) return null;
  const query = { id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : newId(), name: raw.name.trim().slice(0, 255),
    source: normalizeSource(raw.source), steps: (Array.isArray(raw.steps) ? raw.steps : []).slice(0, MAX_STEPS).map(normalizeStep).filter(Boolean),
    load: normalizeLoad(raw.load) };
  if (typeof raw.description === 'string' && raw.description) query.description = raw.description.slice(0, 4096);
  if (Number.isFinite(raw.refreshed)) query.refreshed = raw.refreshed;
  if (Number.isInteger(raw.rowCount) && raw.rowCount >= 0) query.rowCount = raw.rowCount;
  if (Number.isInteger(raw.errorCount) && raw.errorCount > 0) query.errorCount = raw.errorCount;
  return query;
}

/** The stored list, cleaned up: unknown shapes are dropped, and names are unique (case-insensitively), as Power Query keeps them. */
export function normalizeQueries(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [], seen = new Set();
  for (const item of raw.slice(0, MAX_QUERIES)) {
    const q = normalizeQuery(item);
    if (!q || seen.has(q.name.toLowerCase())) continue;
    seen.add(q.name.toLowerCase());
    out.push(q);
  }
  return out;
}

/** The queries as saved: the table each one loads to under its current name (a renamed table is followed by id while the book is open). */
export function serializeQueries(wb) {
  return (wb.queries || []).map((q) => {
    const target = q.load?.kind === 'table' ? loadedTable(wb, q) : null;
    const copy = { ...q, source: { ...q.source }, steps: q.steps.map((s) => ({ ...s })), load: { ...q.load } };
    delete copy.load.tableId;
    if (target) { copy.load.table = target.table.name; copy.load.sheet = target.sheet.name; }
    return normalizeQuery(copy);
  }).filter(Boolean);
}

/* ---------- Workbook state ---------- */

function changed(wb) {
  wb.dirty = true; wb.version++;
  wb._announce?.('queries', null);
}

export function queryByName(wb, name) {
  const key = String(name ?? '').toLowerCase();
  return (wb.queries || []).find((q) => q.name.toLowerCase() === key) || null;
}
export const queryById = (wb, id) => (wb.queries || []).find((q) => q.id === id) || null;

/** A query name that is free: `base`, else `base (2)`, `base (3)`… as Power Query numbers duplicates. */
export function uniqueQueryName(wb, base, exceptId = null) {
  const clean = String(base || 'Query').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200) || 'Query';
  const taken = new Set((wb.queries || []).filter((q) => q.id !== exceptId).map((q) => q.name.toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean} (${i})`.toLowerCase())) return `${clean} (${i})`;
}

export function queryNameProblem(wb, name, exceptId = null) {
  const t = String(name ?? '').trim();
  if (!t) return 'Enter a name for the query';
  if (t.length > 255) return 'That name is too long';
  if (/[\u0000-\u001f"]/.test(t)) return 'A query name cannot contain quotation marks or control characters';
  if ((wb.queries || []).some((q) => q.id !== exceptId && q.name.toLowerCase() === t.toLowerCase())) return 'A query with that name already exists';
  return null;
}

/** Add or replace a query (matched by id); returns the stored copy. */
export function saveQuery(wb, query) {
  const q = normalizeQuery(query);
  if (!q) return null;
  if (query.load?.tableId) q.load.tableId = query.load.tableId;
  const list = [...(wb.queries || [])];
  const at = list.findIndex((x) => x.id === q.id);
  const old = at >= 0 ? list[at] : null;
  if (old && old.name !== q.name) {
    // Other queries that reference or merge this one follow its new name.
    for (const other of list) {
      if (other.id === q.id) continue;
      if (other.source.kind === 'query' && other.source.query.toLowerCase() === old.name.toLowerCase()) other.source.query = q.name;
      for (const s of other.steps) if (s.type === 'merge' && s.query.toLowerCase() === old.name.toLowerCase()) s.query = q.name;
    }
  }
  if (at >= 0) list[at] = q; else list.push(q);
  wb.queries = list;
  changed(wb);
  return q;
}

export function deleteQuery(wb, id) {
  const before = (wb.queries || []).length;
  wb.queries = (wb.queries || []).filter((q) => q.id !== id);
  if (wb.queries.length !== before) changed(wb);
}

/** The table a query loads to, followed by id first (a rename keeps it), then by name: { sheet, table } or null. */
export function loadedTable(wb, query) {
  if (query?.load?.kind !== 'table') return null;
  if (query.load.tableId) for (const sheet of wb.sheets) {
    const table = sheet.tables.find((t) => t.id === query.load.tableId);
    if (table) return { sheet, table };
  }
  const found = query.load.table ? wb.tableByName(query.load.table) : null;
  if (found) query.load.tableId = found.table.id;
  return found;
}

/** The query whose output is this table, if any. */
export function queryForTable(wb, sheetId, tableId) {
  const sheet = wb.sheet(sheetId);
  const table = sheet?.tables.find((t) => t.id === tableId);
  if (!table) return null;
  return (wb.queries || []).find((q) => { const hit = loadedTable(wb, q); return hit && hit.table.id === tableId; }) || null;
}

/* ---------- Values and types ---------- */

const bankers = (n) => {
  const r = Math.round(n);
  return Math.abs(n % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

function numberFromText(text) {
  const t = String(text).trim();
  if (t === '') return null;
  const parsed = parseInput(t, 'en-US');
  if (typeof parsed.v === 'number' && !typedDateKind(parsed)) return parsed.v;
  return undefined;
}

function dateFromText(text) {
  const t = String(text).trim();
  if (t === '') return null;
  const hit = parseDate(t, new Date(), 'en-US');
  if (hit && Number.isFinite(hit.serial)) return Math.floor(hit.serial);
  const parsed = parseInput(t, 'en-US');
  if (['date', 'datetime'].includes(typedDateKind(parsed))) return Math.floor(parsed.v);
  return undefined;
}

/** Text as a date-time serial (a date alone is its midnight): null for blank text, undefined for text that is neither. */
function dateTimeFromText(text) {
  const t = String(text).trim();
  if (t === '') return null;
  const hit = parseDate(t, new Date(), 'en-US');
  if (hit && Number.isFinite(hit.serial)) return hit.serial;
  const parsed = parseInput(t, 'en-US');
  if (typeof parsed.v === 'number' && ['date', 'datetime'].includes(parsed.fmt)) return parsed.v;
  return undefined;
}

/** Text as a time of day (a fraction of a day; a date-time gives its time): null for blank text, undefined for text that is neither. */
function timeFromText(text) {
  const t = String(text).trim();
  if (t === '') return null;
  const parsed = parseInput(t, 'en-US');
  if (typeof parsed.v === 'number' && ['time', 'datetime'].includes(parsed.fmt)) return parsed.v - Math.floor(parsed.v);
  return undefined;
}

/** A date serial as Power Query writes a date in text (en-US): m/d/yyyy. */
export function dateText(serial) {
  const { y, m, d } = serialToYMD(Math.floor(serial));
  return `${m}/${d}/${y}`;
}

/** The time of day of a serial as Power Query writes it (en-US): h:mm:ss AM. */
export function timeText(serial) {
  const seconds = Math.round((serial - Math.floor(serial)) * 86400) % 86400;
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, sec = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${h % 12 || 12}:${pad(m)}:${pad(sec)} ${h < 12 ? 'AM' : 'PM'}`;
}

/** A serial as Power Query writes a date-time in text (en-US): m/d/yyyy h:mm:ss AM, the date taking a second that rounds to midnight. */
export function dateTimeText(serial) {
  const day = Math.floor(serial) + (Math.round((serial - Math.floor(serial)) * 86400) >= 86400 ? 1 : 0);
  return `${dateText(day)} ${timeText(serial)}`;
}

/** A value of one of the date types as text. */
const serialText = (v, type) => (type === 'datetime' ? dateTimeText(v) : type === 'time' ? timeText(v) : dateText(v));

/** Convert a value of type `from` to type `to`, or a DataFormat.Error, as Table.TransformColumnTypes does. */
export function convertValue(v, from, to) {
  if (v == null || isErr(v) || to === 'any') return v ?? null;
  const text = typeof v === 'string';
  switch (to) {
    case 'text':
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (typeof v === 'number') return DATE_TYPES.has(from) ? serialText(v, from) : String(v);
      return v;
    case 'int': case 'decimal': {
      let n;
      if (typeof v === 'boolean') n = v ? 1 : 0;
      else if (typeof v === 'number') n = v;
      else if (text) { n = numberFromText(v); if (n === null) return null; }
      if (typeof n !== 'number' || !Number.isFinite(n)) return dataError(`We couldn't convert to Number.`);
      return to === 'int' ? bankers(n) : n;
    }
    case 'date': {
      if (typeof v === 'number') return Math.floor(v);
      if (text) {
        const d = dateFromText(v);
        if (d === null) return null;
        return d === undefined ? dataError(`We couldn't parse the input provided as a Date value.`) : d;
      }
      return dataError(`We cannot convert the value ${v} to type Date.`);
    }
    // A date-time keeps its time of day; a time keeps only that (a date alone is midnight, 12:00:00 AM).
    case 'datetime': case 'time': {
      if (typeof v === 'number') return to === 'time' ? v - Math.floor(v) : v;
      if (text) {
        const d = to === 'time' ? timeFromText(v) : dateTimeFromText(v);
        if (d === null) return null;
        return d === undefined ? dataError(`We couldn't parse the input provided as a ${to === 'time' ? 'Time' : 'DateTime'} value.`) : d;
      }
      return dataError(`We cannot convert the value ${v} to type ${to === 'time' ? 'Time' : 'DateTime'}.`);
    }
    case 'bool': {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      const t = v.trim().toLowerCase();
      if (t === '') return null;
      if (t === 'true') return true;
      if (t === 'false') return false;
      return dataError(`We couldn't convert to Logical.`);
    }
    default: return v;
  }
}

/** Detect a column's type from its first 200 values, as Power Query's automatic type detection does. */
export function detectType(values, hint = null) {
  const sample = values.slice(0, PREVIEW_ROWS).filter((v) => v != null && v !== '' && !isErr(v));
  if (!sample.length) return hint || 'any';
  if (DATE_TYPES.has(hint) && sample.every((v) => typeof v === 'number')) return hint;
  if (sample.every((v) => typeof v === 'boolean')) return 'bool';
  if (sample.every((v) => typeof v === 'number')) return sample.every(Number.isInteger) ? 'int' : 'decimal';
  if (sample.every((v) => typeof v === 'string')) {
    if (sample.every((v) => /^\s*(true|false)\s*$/i.test(v))) return 'bool';
    const nums = sample.map(numberFromText);
    if (nums.every((n) => typeof n === 'number')) return nums.every(Number.isInteger) && sample.every((v) => !/[.eE%]/.test(v)) ? 'int' : 'decimal';
    // A time of day on every row is a time; dates are dates, or date-times where any of them gives a time.
    if (sample.every((v) => typeof timeFromText(v) === 'number' && parseInput(v.trim(), 'en-US').fmt === 'time')) return 'time';
    if (sample.every((v) => /\d/.test(v) && /[/\-.]|[A-Za-z]{3}/.test(v)) && sample.map(dateTimeFromText).every((d) => typeof d === 'number')) {
      return sample.some((v) => typeof timeFromText(v) === 'number') ? 'datetime' : 'date';
    }
    return 'text';
  }
  return 'any';
}

/** A Changed Type step for every column whose type detection settles on one (none when all are untyped). */
export function detectedTypeStep(table, onlyColumns = null) {
  const columns = {};
  table.columns.forEach((name, i) => {
    if (onlyColumns && !onlyColumns.includes(name)) return;
    const t = detectType(table.rows.map((r) => r[i]), DATE_TYPES.has(table.types[i]) ? table.types[i] : null);
    if (t !== 'any') columns[name] = t;
  });
  return Object.keys(columns).length ? { id: newId(), type: 'changeType', columns } : null;
}

export const keyOf = (v) => (v == null ? 'null' : isErr(v) ? 'error' : `${typeof v}:${v}`);
/** Power Query's default order: null first, then numbers, then text (ordinal), then logicals. */
function compareValues(a, b) {
  const rank = (v) => (v == null ? 0 : isErr(v) ? 5 : typeof v === 'number' ? 1 : typeof v === 'string' ? 3 : typeof v === 'boolean' ? 4 : 6);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number') return a - b;
  if (typeof a === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  return 0;
}

/** A value shown in the preview or in a dialog. */
export function displayValue(v, type) {
  if (v == null) return 'null';
  if (isErr(v)) return 'Error';
  if (DATE_TYPES.has(type) && typeof v === 'number') return serialText(v, type);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/** Text typed into a dialog as a value of the column's type (a number for a number column, a date serial for a date one). */
export function parseTyped(text, type) {
  if (text == null) return null;
  const t = String(text);
  if (type === 'int' || type === 'decimal') { const n = numberFromText(t); return typeof n === 'number' ? n : t; }
  if (type === 'date') { const d = dateFromText(t); return typeof d === 'number' ? d : t; }
  if (type === 'datetime' || type === 'time') { const d = type === 'time' ? timeFromText(t) : dateTimeFromText(t); return typeof d === 'number' ? d : t; }
  if (type === 'bool') { const l = t.trim().toLowerCase(); return l === 'true' ? true : l === 'false' ? false : t; }
  return t;
}

/* ---------- Sources ---------- */

const plainColumns = (n) => Array.from({ length: n }, (_, i) => `Column${i + 1}`);
const square = (rows) => {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return { width, rows: rows.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill(null)] : r)) };
};
function rawTable(rows) {
  const sq = square(rows);
  return { columns: plainColumns(sq.width), types: Array(sq.width).fill('any'), rows: sq.rows };
}

function simpleDelimiter(text) {
  const head = text.split(/\r?\n/, 5).join('\n');
  const counts = [',', ';', '\t', '|'].map((d) => [d, head.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ',';
}

/** Delimited text as Csv.Document reads it: every field text, Column1… */
export function csvTable(text, delimiter = null, detect = simpleDelimiter) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const delim = delimiter || detect(src, '') || ',';
  const rows = parseDelimited(src, delim) || [];
  while (rows.length && rows.at(-1).every((f) => f === '' || f == null)) rows.pop();
  return rawTable(rows.map((r) => r.map((f) => (f == null ? null : String(f)))));
}

/** A table of this workbook as Excel.CurrentWorkbook() gives it: its header names, its data rows, date columns marked. */
export function workbookTable(wb, name) {
  const found = wb.tableByName(name);
  if (!found) return { error: `Expression.Error: No table named '${name}' was found in this workbook.` };
  const { sheet, table } = found;
  const columns = wb.tableColumns(sheet.id, table);
  const { dataStart, dataEnd } = tableRows(table);
  const rows = [];
  for (let r = dataStart; r <= dataEnd; r++) {
    const row = [];
    for (let c = table.range.c1; c <= table.range.c2; c++) {
      const v = wb.getValue(sheet.id, r, c);
      row.push(v == null || v === '' ? null : isObj(v) && v.error ? { error: 'DataFormat.Error', message: v.error } : isObj(v) ? String(v.text ?? v.value ?? '') : v);
    }
    rows.push(row);
  }
  const types = columns.map((_, i) => {
    const c = table.range.c1 + i;
    const fmt = dataStart <= dataEnd ? wb.styleAt?.(sheet.id, dataStart, c)?.fmt : null;
    return DATE_TYPES.has(fmt) ? fmt : 'any';
  });
  return { columns, types, rows };
}

/** The values of a sheet of another workbook (the used range), for a From Workbook source snapshot. */
export function sheetRows(other, sheetId) {
  const used = other.usedRange(sheetId);
  if (!used) return [];
  const rows = [];
  for (let r = 0; r <= used.r2; r++) {
    const row = [];
    for (let c = 0; c <= used.c2; c++) {
      const v = other.getValue(sheetId, r, c);
      row.push(v == null || v === '' ? null : isObj(v) ? (v.error ? null : String(v.text ?? v.value ?? '')) : v);
    }
    rows.push(row);
  }
  return rows;
}

const sniff = (bytes) => (bytes?.[0] === 0x50 && bytes?.[1] === 0x4b ? 'zip' : bytes?.[0] === 0xd0 && bytes?.[1] === 0xcf ? 'cfb' : 'text');

/**
 * What a web address answers, read as tables: a page's HTML tables, a workbook's sheets, or delimited text.
 * Returns [{ name, rows }] (rows raw, the first maybe headers) for the Navigator and the Source step.
 */
export async function webItems(bytes, url, io = {}) {
  const kind = sniff(bytes);
  if (kind !== 'text') {
    if (!io.workbookFromFile) throw new Error('Workbooks cannot be read here');
    const other = await io.workbookFromFile(bytes, String(url).split(/[?#]/)[0].split('/').pop() || 'download.xlsx');
    return other.sheets.filter((s) => s.kind !== 'chart').map((s) => ({ name: s.name, rows: sheetRows(other, s.id) }));
  }
  const text = io.decodeText ? io.decodeText(bytes) : new TextDecoder().decode(bytes);
  if (/<table[\s>]/i.test(text) && typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const tables = [...doc.querySelectorAll('table')].filter((t) => !t.parentElement?.closest('table'));
    if (tables.length) return tables.map((t, i) => ({ name: t.querySelector('caption')?.textContent.trim() || t.id || `Table ${i}`, rows: htmlRows(t) }));
  }
  return [{ name: 'Document', rows: csvTable(text, null, io.detectDelimiter).rows, csv: true }];
}

function htmlRows(table) {
  const rows = [];
  for (const tr of table.querySelectorAll('tr')) {
    if (tr.closest('table') !== table) continue;
    const row = [];
    for (const cell of tr.children) if (cell.tagName === 'TD' || cell.tagName === 'TH') {
      const text = cell.textContent.replace(/\s+/g, ' ').trim();
      for (let i = 0; i < Math.max(1, cell.colSpan || 1); i++) row.push(i ? null : text || null);
    }
    if (row.length) rows.push(row);
  }
  return rows;
}

/** The first steps Power Query adds for a source: headers promoted where the source has none, then the detected types. */
export function initialSteps(base, { promote = true } = {}) {
  const steps = [];
  let table = base;
  if (promote && base.rows.length) {
    const step = { id: newId(), type: 'promoteHeaders' };
    steps.push(step);
    table = applyStep(table, step, {});
  }
  const types = detectedTypeStep(table);
  if (types) steps.push(types);
  return steps;
}

/**
 * The Source step's table. `io` reaches outside the workbook: fetchBytes(url), workbookFromFile(bytes, name),
 * decodeText(bytes), detectDelimiter(text); `stack` holds the queries being evaluated (to refuse a cycle).
 */
export async function sourceTable(wb, query, io = {}, stack = []) {
  const s = query.source;
  switch (s.kind) {
    case 'csv': {
      // A file picked from the drive is read again on refresh (its text kept in the query stands in when it cannot be).
      if (s.path && io.readFile) {
        try {
          const bytes = await io.readFile(s.path);
          const text = io.decodeText ? io.decodeText(new Uint8Array(bytes)) : new TextDecoder().decode(bytes);
          if (text.length <= MAX_SOURCE_CHARS) s.text = text;
          return csvTable(text, s.delimiter, io.detectDelimiter);
        } catch { /* the stored text below */ }
      }
      return csvTable(s.text, s.delimiter, io.detectDelimiter);
    }
    case 'workbook': return rawTable(s.rows.map((r) => r.slice()));
    case 'table': {
      const t = workbookTable(wb, s.table);
      if (t.error) throw new Error(t.error);
      return t;
    }
    case 'query': {
      const other = lookupQuery(wb, io, s.query);
      if (!other) throw new Error(`Expression.Error: The name '${s.query}' wasn't recognized.`);
      const result = await evaluateQuery(wb, other, io, { stack: [...stack, query.id] });
      if (result.error) throw new Error(result.error.message);
      return result.table;
    }
    case 'web': {
      if (!io.fetchBytes) throw new Error('DataSource.Error: Web content cannot be fetched here.');
      const bytes = await io.fetchBytes(s.url);
      const items = await webItems(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes, s.url, io);
      const item = (s.item && items.find((i) => i.name === s.item)) || items[0];
      if (!item) throw new Error('DataSource.Error: The address returned no table.');
      return rawTable(item.rows);
    }
    default: return { columns: [], types: [], rows: [] };
  }
}

/* ---------- Steps ---------- */

const colIndex = (table, name) => {
  const i = table.columns.indexOf(name);
  if (i < 0) throw new Error(`Expression.Error: The column '${name}' of the table wasn't found.`);
  return i;
};

function uniqueNames(list) {
  const seen = new Set();
  return list.map((n) => {
    let name = n, k = 1;
    while (seen.has(name)) name = `${n}_${k++}`;
    seen.add(name);
    return name;
  });
}

function textOf(v) {
  return typeof v === 'string' ? v : null;
}

/** The keys of a list condition's values, worked out once per condition rather than once per row. */
const listKeys = new WeakMap();
const keysOf = (cond) => {
  let keys = listKeys.get(cond);
  if (!keys) listKeys.set(cond, keys = new Set(cond.values.map(keyOf)));
  return keys;
};

function matches(cond, v, type) {
  const { op } = cond;
  // The values ticked in a column's filter list (in), or those cleared when the list did not hold them all (notIn).
  if (op === 'in') return keysOf(cond).has(keyOf(v));
  if (op === 'notIn') return !keysOf(cond).has(keyOf(v));
  if (op === 'isNull') return v == null;
  if (op === 'notNull') return v != null;
  if (op === 'isBlank') return v == null || v === '';
  if (op === 'notBlank') return !(v == null || v === '');
  if (isErr(v)) return false;
  const want = typeof cond.value === 'string' && type !== 'text' && type !== 'any' ? parseTyped(cond.value, type) : cond.value;
  switch (op) {
    case 'equals': return keyOf(v) === keyOf(want);
    case 'notEquals': return keyOf(v) !== keyOf(want);
    case 'beginsWith': case 'notBeginsWith': case 'endsWith': case 'notEndsWith': case 'contains': case 'notContains': {
      const t = textOf(v) ?? (v == null ? null : displayValue(v, type));
      const w = String(want ?? '');
      if (t == null) return op.startsWith('not');
      const hit = op.includes('egins') ? t.startsWith(w) : op.includes('nds') ? t.endsWith(w) : t.includes(w);
      return op.startsWith('not') ? !hit : hit;
    }
    default: {
      if (v == null || want == null) return false;
      const c = compareValues(v, want);
      if (typeof v !== typeof want) return false;
      return { gt: c > 0, after: c > 0, gte: c >= 0, onOrAfter: c >= 0, lt: c < 0, before: c < 0, lte: c <= 0, onOrBefore: c <= 0 }[op] ?? false;
    }
  }
}

function aggregate(op, values, type) {
  if (op === 'count') return values.length;
  // Count Distinct Rows counts the group's distinct rows, every column compared (Table.RowCount(Table.Distinct(_))).
  if (op === 'countDistinct') return new Set(values.map((row) => row.map(keyOf).join('\u0001'))).size;
  const nums = values.filter((v) => typeof v === 'number');
  if (op === 'min' || op === 'max') {
    const present = values.filter((v) => v != null && !isErr(v));
    if (!present.length) return null;
    return present.reduce((a, b) => (op === 'min' ? (compareValues(b, a) < 0 ? b : a) : (compareValues(b, a) > 0 ? b : a)));
  }
  if (!nums.length) return null;
  if (op === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (op === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (op === 'median') {
    const s = nums.slice().sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  return null;
}

/**
 * Text cut at each delimiter as Splitter.SplitTextByDelimiter(d, QuoteStyle.Csv) cuts it: a part that opens with a
 * double quote runs to its closing quote, delimiters inside it included, a doubled quote standing for one.
 */
function csvSplit(text, d) {
  const out = [];
  let field = '', quoted = false, fresh = true;
  for (let i = 0; i < text.length;) {
    if (quoted) {
      if (text[i] !== '"') { field += text[i++]; continue; }
      if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
      quoted = false; i++; continue;
    }
    if (fresh && text[i] === '"') { quoted = true; fresh = false; i++; continue; }
    if (text.startsWith(d, i)) { out.push(field); field = ''; fresh = true; i += d.length; continue; }
    field += text[i++]; fresh = false;
  }
  out.push(field);
  return out;
}

const TEXT_OPS = {
  lower: (s) => s.toLowerCase(), upper: (s) => s.toUpperCase(), trim: (s) => s.trim(),
  clean: (s) => s.replace(/[\u0000-\u001f\u007f]/g, ''),
  proper: (s) => s.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()),
};

/** One step applied to a table. `refs` maps query names to their evaluated tables (for Merge). Throws an Error a step fails with. */
export function applyStep(table, step, refs = {}) {
  const { columns, types, rows } = table;
  switch (step.type) {
    case 'promoteHeaders': {
      if (!rows.length) return { columns, types, rows };
      const head = rows[0].map((v, i) => (v == null || v === '' ? `Column${i + 1}` : isErr(v) ? `Column${i + 1}` : displayValue(v, types[i])));
      return { columns: uniqueNames(head), types: types.map(() => 'any'), rows: rows.slice(1) };
    }
    case 'demoteHeaders':
      return { columns: plainColumns(columns.length), types: types.map(() => 'any'), rows: [columns.slice(), ...rows] };
    case 'changeType': {
      const plan = Object.entries(step.columns).map(([name, t]) => [colIndex(table, name), t]);
      const nextTypes = types.slice();
      for (const [i, t] of plan) nextTypes[i] = t;
      return { columns, types: nextTypes, rows: rows.map((r) => {
        const out = r.slice();
        for (const [i, t] of plan) out[i] = convertValue(r[i], types[i], t);
        return out;
      }) };
    }
    case 'removeColumns': {
      const drop = new Set(step.columns.map((n) => colIndex(table, n)));
      const keep = columns.map((_, i) => i).filter((i) => !drop.has(i));
      return pick(table, keep);
    }
    case 'selectColumns': case 'reorderColumns': {
      const keep = step.columns.map((n) => colIndex(table, n));
      if (step.type === 'reorderColumns') for (let i = 0; i < columns.length; i++) if (!keep.includes(i)) keep.push(i);
      return pick(table, keep);
    }
    case 'renameColumns': {
      const next = columns.slice();
      for (const [from, to] of step.renames) next[colIndex(table, from)] = to;
      if (new Set(next).size !== next.length) throw new Error('Expression.Error: The field names would not be unique.');
      return { columns: next, types, rows };
    }
    case 'filterRows': {
      const i = colIndex(table, step.column), t = types[i];
      if (!step.conditions.length) return table;
      const test = (v) => (step.join === 'or' ? step.conditions.some((c) => matches(c, v, t)) : step.conditions.every((c) => matches(c, v, t)));
      return { columns, types, rows: rows.filter((r) => test(r[i])) };
    }
    case 'sortRows': {
      const keys = step.keys.map((k) => [colIndex(table, k.column), k.desc ? -1 : 1]);
      const order = rows.map((r, n) => [r, n]);
      order.sort(([a, na], [b, nb]) => {
        for (const [i, dir] of keys) { const c = compareValues(a[i], b[i]); if (c) return c * dir; }
        return na - nb;
      });
      return { columns, types, rows: order.map(([r]) => r) };
    }
    case 'removeDuplicates': {
      const idx = step.columns?.length ? step.columns.map((n) => colIndex(table, n)) : columns.map((_, i) => i);
      const seen = new Set();
      return { columns, types, rows: rows.filter((r) => {
        const k = idx.map((i) => keyOf(r[i])).join('\u0001');
        if (seen.has(k)) return false;
        seen.add(k); return true;
      }) };
    }
    case 'replaceValues': {
      const idx = step.columns.map((n) => colIndex(table, n));
      return { columns, types, rows: rows.map((r) => {
        const out = r.slice();
        for (const i of idx) {
          const v = r[i], t = types[i];
          const textual = t === 'text' || (t === 'any' && typeof v === 'string');
          if (textual && !step.matchEntire && typeof step.find === 'string' && step.find !== '' && typeof v === 'string') {
            out[i] = v.split(step.find).join(step.replace == null ? '' : String(step.replace));
          } else {
            const find = typeof step.find === 'string' && !textual ? parseTyped(step.find, t) : step.find;
            if (keyOf(v) === keyOf(find) || (find === '' && v == null)) out[i] = typeof step.replace === 'string' && !textual ? parseTyped(step.replace, t) : step.replace;
          }
        }
        return out;
      }) };
    }
    case 'splitColumn': {
      const i = colIndex(table, step.column);
      const d = step.delimiter;
      const parts = rows.map((r) => {
        const v = r[i];
        if (v == null || isErr(v)) return [v];
        const s = displayValue(v, types[i]);
        if (!d) return [s];
        if (step.mode === 'left') { const k = s.indexOf(d); return k < 0 ? [s] : [s.slice(0, k), s.slice(k + d.length)]; }
        if (step.mode === 'right') { const k = s.lastIndexOf(d); return k < 0 ? [s] : [s.slice(0, k), s.slice(k + d.length)]; }
        return csvSplit(s, d);
      });
      const n = step.count || maxOf(parts.map((p) => p.length), 1);
      const names = Array.from({ length: n }, (_, k) => `${step.column}.${k + 1}`);
      return {
        columns: [...columns.slice(0, i), ...names, ...columns.slice(i + 1)],
        types: [...types.slice(0, i), ...names.map(() => 'text'), ...types.slice(i + 1)],
        rows: rows.map((r, k) => {
          const p = parts[k];
          // Parts past the columns asked for are dropped, as Table.SplitColumn drops them.
          const cells = Array.from({ length: n }, (_, j) => (j < p.length ? p[j] : null));
          return [...r.slice(0, i), ...cells, ...r.slice(i + 1)];
        }),
      };
    }
    case 'addIndex': {
      if (columns.includes(step.column)) throw new Error(`Expression.Error: The field '${step.column}' already exists in the record.`);
      const isInt = Number.isInteger(step.start) && Number.isInteger(step.increment);
      return { columns: [...columns, step.column], types: [...types, isInt ? 'int' : 'decimal'], rows: rows.map((r, n) => [...r, step.start + n * step.increment]) };
    }
    case 'groupBy': {
      const keys = step.keys.map((n) => colIndex(table, n));
      // Count Rows and Count Distinct Rows read the group's whole rows, not one column.
      const aggs = step.aggregations.map((a) => ({ ...a, i: a.op === 'count' || a.op === 'countDistinct' ? -1 : colIndex(table, a.column) }));
      const groups = new Map();
      for (const r of rows) {
        const k = keys.map((i) => keyOf(r[i])).join('\u0001');
        if (!groups.has(k)) groups.set(k, { key: keys.map((i) => r[i]), rows: [] });
        groups.get(k).rows.push(r);
      }
      const outTypes = [...keys.map((i) => types[i]), ...aggs.map((a) => (a.op === 'count' || a.op === 'countDistinct' ? 'int'
        : a.op === 'min' || a.op === 'max' ? types[a.i] : types[a.i] === 'int' && a.op === 'sum' ? 'int' : 'decimal'))];
      return {
        columns: uniqueNames([...step.keys, ...aggs.map((a) => a.name)]), types: outTypes,
        rows: [...groups.values()].map((g) => [...g.key, ...aggs.map((a) => aggregate(a.op, a.i < 0 ? g.rows : g.rows.map((r) => r[a.i]), types[a.i]))]),
      };
    }
    case 'keepFirst': return { columns, types, rows: rows.slice(0, step.count) };
    case 'keepLast': return { columns, types, rows: step.count ? rows.slice(-step.count) : [] };
    case 'removeFirst': return { columns, types, rows: rows.slice(step.count) };
    case 'removeLast': return { columns, types, rows: step.count ? rows.slice(0, -step.count) : rows };
    case 'removeBlankRows': return { columns, types, rows: rows.filter((r) => r.some((v) => !(v == null || v === ''))) };
    case 'removeErrors': {
      const idx = step.columns.length ? step.columns.map((n) => colIndex(table, n)) : columns.map((_, i) => i);
      return { columns, types, rows: rows.filter((r) => !idx.some((i) => isErr(r[i]))) };
    }
    case 'fillDown': case 'fillUp': {
      const idx = step.columns.map((n) => colIndex(table, n));
      const out = rows.map((r) => r.slice());
      const order = step.type === 'fillDown' ? out : out.slice().reverse();
      for (const i of idx) { let last = null; for (const r of order) { if (r[i] == null) r[i] = last; else last = r[i]; } }
      return { columns, types, rows: out };
    }
    case 'transformText': {
      const idx = step.columns.map((n) => colIndex(table, n)), fn = TEXT_OPS[step.op];
      return { columns, types, rows: rows.map((r) => { const out = r.slice(); for (const i of idx) if (typeof r[i] === 'string') out[i] = fn(r[i]); return out; }) };
    }
    case 'addTextColumn': {
      // Add Column ▸ Format: a new text column holding the column's text in that format; the column itself stays.
      const i = colIndex(table, step.column), fn = TEXT_OPS[step.op];
      const name = uniqueNames([...columns, step.as]).at(-1);
      const shown = (v) => (v == null || isErr(v) ? v ?? null : fn(typeof v === 'string' ? v : displayValue(v, types[i])));
      return { columns: [...columns, name], types: [...types, 'text'], rows: rows.map((r) => [...r, shown(r[i])]) };
    }
    case 'duplicateColumn': {
      const i = colIndex(table, step.column);
      const name = uniqueNames([...columns, step.as || `${step.column} - Copy`]).at(-1);
      return { columns: [...columns, name], types: [...types, types[i]], rows: rows.map((r) => [...r, r[i]]) };
    }
    case 'merge': {
      const other = refs[step.query.toLowerCase()];
      if (!other) throw new Error(`Expression.Error: The name '${step.query}' wasn't recognized.`);
      const li = step.left.map((n) => colIndex(table, n)), ri = step.right.map((n) => colIndex(other, n));
      if (!li.length || li.length !== ri.length) throw new Error('Expression.Error: Choose the same number of matching columns in both tables.');
      const expand = step.expand.map((n) => colIndex(other, n));
      const added = uniqueNames([...columns, ...step.expand.map((n) => `${step.column}.${n}`)]).slice(columns.length);
      const index = new Map();
      other.rows.forEach((r, n) => { const k = ri.map((i) => keyOf(r[i])).join('\u0001'); if (!index.has(k)) index.set(k, []); index.get(k).push(n); });
      const used = new Set();
      const out = [];
      const blank = expand.map(() => null);
      const kind = step.kind;
      for (const r of rows) {
        const hits = index.get(li.map((i) => keyOf(r[i])).join('\u0001')) || [];
        hits.forEach((n) => used.add(n));
        if (kind === 'leftAnti') { if (!hits.length) out.push([...r, ...blank]); continue; }
        if (kind === 'rightAnti') continue;
        if (hits.length) for (const n of hits) out.push([...r, ...expand.map((i) => other.rows[n][i])]);
        else if (kind === 'leftOuter' || kind === 'fullOuter') out.push([...r, ...blank]);
      }
      if (kind === 'rightOuter' || kind === 'fullOuter' || kind === 'rightAnti') {
        if (kind === 'rightOuter') {
          out.length = 0;
          for (const r of rows) {
            const hits = index.get(li.map((i) => keyOf(r[i])).join('\u0001')) || [];
            for (const n of hits) out.push([...r, ...expand.map((i) => other.rows[n][i])]);
          }
        }
        other.rows.forEach((r, n) => { if (!used.has(n)) out.push([...columns.map(() => null), ...expand.map((i) => r[i])]); });
      }
      return { columns: [...columns, ...added], types: [...types, ...expand.map((i) => other.types[i])], rows: out };
    }
    default: return table;
  }
}

function pick(table, idx) {
  return { columns: idx.map((i) => table.columns[i]), types: idx.map((i) => table.types[i]), rows: table.rows.map((r) => idx.map((i) => r[i])) };
}

/** A query by name: from `io.queries` when given (the editor's unsaved drafts), else the workbook's. */
function lookupQuery(wb, io, name) {
  if (!io.queries) return queryByName(wb, name);
  const key = String(name ?? '').toLowerCase();
  return io.queries.find((q) => q.name.toLowerCase() === key) || null;
}

/** The queries a query's steps merge with, by lower-case name. */
const mergeNames = (query) => [...new Set(query.steps.filter((s) => s.type === 'merge').map((s) => s.query.toLowerCase()))];

/**
 * Evaluate a query, through `upTo` steps (all by default; 0 is the Source step alone). Never throws:
 * { table, error: null } or { table: <the last good table or null>, error: { step, message } } where step is the
 * index of the failing step (-1 for the source).
 */
export async function evaluateQuery(wb, query, io = {}, { upTo = Infinity, stack = [], base = null } = {}) {
  if (stack.includes(query.id)) return { table: null, error: { step: -1, message: 'Expression.Error: A cyclic reference was encountered during evaluation.' } };
  let table;
  try { table = base || await sourceTable(wb, query, io, stack); } catch (e) { return { table: null, error: { step: -1, message: e?.message || String(e) } }; }
  const steps = query.steps.slice(0, Math.max(0, upTo));
  const refs = {};
  for (const name of mergeNames({ steps })) {
    const other = lookupQuery(wb, io, name);
    if (!other) continue;
    const result = await evaluateQuery(wb, other, io, { stack: [...stack, query.id] });
    if (result.table && !result.error) refs[name] = result.table;
  }
  for (let i = 0; i < steps.length; i++) {
    try { table = applyStep(table, steps[i], refs); } catch (e) { return { table, error: { step: i, message: e?.message || String(e) } }; }
  }
  return { table, error: null };
}

/** The step names Power Query shows: each kind's name, numbered from the second (Changed Type, Changed Type1…), or the user's own. */
export function stepNames(query) {
  const counts = new Map();
  return ['Source', ...query.steps.map((s) => {
    if (s.name) return s.name;
    const base = s.type === 'transformText' ? TEXT_OP_NAMES[s.op] : s.type === 'addTextColumn' ? `Inserted ${TEXT_OP_NAMES[s.op]}` : STEP_NAMES[s.type];
    const n = counts.get(base) || 0;
    counts.set(base, n + 1);
    return n ? `${base}${n}` : base;
  })];
}

/** The step's formula as Power Query's formula bar would show it (for reading; it is not run). */
export function stepFormula(query, index) {
  const all = stepNames(query);
  const ref = (n) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `#"${n.replace(/"/g, '""')}"`);
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const list = (xs) => `{${xs.map(q).join(', ')}}`;
  const val = (v) => (typeof v === 'string' ? q(v) : v == null ? 'null' : String(v));
  if (index === 0) {
    const s = query.source;
    switch (s.kind) {
      case 'csv': return `= Csv.Document(File.Contents(${q(s.path || s.name)}),[Delimiter=${q(s.delimiter || ',')}, Encoding=65001, QuoteStyle=QuoteStyle.Csv])`;
      case 'web': return `= Web.Page(Web.Contents(${q(s.url)}))${s.item ? `{[Caption=${q(s.item)}]}[Data]` : ''}`;
      case 'workbook': return `= Excel.Workbook(File.Contents(${q(s.path || s.name)}), null, true){[Item=${q(s.item)}]}[Data]`;
      case 'table': return `= Excel.CurrentWorkbook(){[Name=${q(s.table)}]}[Content]`;
      case 'query': return `= ${ref(s.query)}`;
      default: return '= #table({}, {})';
    }
  }
  const step = query.steps[index - 1], prev = ref(all[index - 1]);
  switch (step.type) {
    case 'promoteHeaders': return `= Table.PromoteHeaders(${prev}, [PromoteAllScalars=true])`;
    case 'demoteHeaders': return `= Table.DemoteHeaders(${prev})`;
    case 'changeType': return `= Table.TransformColumnTypes(${prev},{${Object.entries(step.columns).map(([k, t]) => `{${q(k)}, ${M_TYPES[t]}}`).join(', ')}})`;
    case 'removeColumns': return `= Table.RemoveColumns(${prev},${list(step.columns)})`;
    case 'selectColumns': return `= Table.SelectColumns(${prev},${list(step.columns)})`;
    case 'reorderColumns': return `= Table.ReorderColumns(${prev},${list(step.columns)})`;
    case 'renameColumns': return `= Table.RenameColumns(${prev},{${step.renames.map(([a, b]) => `{${q(a)}, ${q(b)}}`).join(', ')}})`;
    case 'filterRows': {
      const fn = { equals: (v) => `[${step.column}] = ${val(v)}`, notEquals: (v) => `[${step.column}] <> ${val(v)}`, gt: (v) => `[${step.column}] > ${val(v)}`,
        gte: (v) => `[${step.column}] >= ${val(v)}`, lt: (v) => `[${step.column}] < ${val(v)}`, lte: (v) => `[${step.column}] <= ${val(v)}`,
        after: (v) => `[${step.column}] > ${val(v)}`, onOrAfter: (v) => `[${step.column}] >= ${val(v)}`, before: (v) => `[${step.column}] < ${val(v)}`, onOrBefore: (v) => `[${step.column}] <= ${val(v)}`,
        beginsWith: (v) => `Text.StartsWith([${step.column}], ${val(v)})`, notBeginsWith: (v) => `not Text.StartsWith([${step.column}], ${val(v)})`,
        endsWith: (v) => `Text.EndsWith([${step.column}], ${val(v)})`, notEndsWith: (v) => `not Text.EndsWith([${step.column}], ${val(v)})`,
        contains: (v) => `Text.Contains([${step.column}], ${val(v)})`, notContains: (v) => `not Text.Contains([${step.column}], ${val(v)})`,
        isNull: () => `[${step.column}] = null`, notNull: () => `[${step.column}] <> null`, isBlank: () => `[${step.column}] = null or [${step.column}] = ""`,
        notBlank: () => `[${step.column}] <> null and [${step.column}] <> ""` };
      const list = (c) => `List.Contains({${c.values.map(val).join(', ')}}, [${step.column}])`;
      const parts = step.conditions.map((c) => (c.op === 'in' ? list(c) : c.op === 'notIn' ? `not ${list(c)}` : fn[c.op](c.value)));
      return `= Table.SelectRows(${prev}, each ${parts.join(` ${step.join} `) || 'true'})`;
    }
    case 'sortRows': return `= Table.Sort(${prev},{${step.keys.map((k) => `{${q(k.column)}, Order.${k.desc ? 'Descending' : 'Ascending'}}`).join(', ')}})`;
    case 'removeDuplicates': return `= Table.Distinct(${prev}${step.columns?.length ? `, ${list(step.columns)}` : ''})`;
    case 'replaceValues': return `= Table.ReplaceValue(${prev},${val(step.find)},${val(step.replace)},Replacer.Replace${step.matchEntire ? 'Value' : 'Text'},${list(step.columns)})`;
    case 'splitColumn': return `= Table.SplitColumn(${prev}, ${q(step.column)}, Splitter.SplitTextByDelimiter(${q(step.delimiter)}, QuoteStyle.Csv))`;
    case 'addIndex': return `= Table.AddIndexColumn(${prev}, ${q(step.column)}, ${step.start}, ${step.increment}, Int64.Type)`;
    case 'groupBy': {
      const agg = (a) => ({ count: `each Table.RowCount(_), Int64.Type`, countDistinct: `each Table.RowCount(Table.Distinct(_)), Int64.Type`,
        sum: `each List.Sum([${a.column}]), type number`, avg: `each List.Average([${a.column}]), type number`, median: `each List.Median([${a.column}]), type number`,
        min: `each List.Min([${a.column}]), type number`, max: `each List.Max([${a.column}]), type number` })[a.op];
      return `= Table.Group(${prev}, ${list(step.keys)}, {${step.aggregations.map((a) => `{${q(a.name)}, ${agg(a)}}`).join(', ')}})`;
    }
    case 'keepFirst': return `= Table.FirstN(${prev},${step.count})`;
    case 'keepLast': return `= Table.LastN(${prev},${step.count})`;
    case 'removeFirst': return `= Table.Skip(${prev},${step.count})`;
    case 'removeLast': return `= Table.RemoveLastN(${prev},${step.count})`;
    case 'removeBlankRows': return `= Table.SelectRows(${prev}, each not List.IsEmpty(List.RemoveMatchingItems(Record.FieldValues(_), {"", null})))`;
    case 'removeErrors': return `= Table.RemoveRowsWithErrors(${prev}${step.columns.length ? `, ${list(step.columns)}` : ''})`;
    case 'fillDown': return `= Table.FillDown(${prev},${list(step.columns)})`;
    case 'fillUp': return `= Table.FillUp(${prev},${list(step.columns)})`;
    case 'transformText': {
      const fn = { lower: 'Text.Lower', upper: 'Text.Upper', proper: 'Text.Proper', trim: 'Text.Trim', clean: 'Text.Clean' }[step.op];
      return `= Table.TransformColumns(${prev},{${step.columns.map((c) => `{${q(c)}, ${fn}, type text}`).join(', ')}})`;
    }
    case 'addTextColumn': {
      const fn = { lower: 'Text.Lower', upper: 'Text.Upper', proper: 'Text.Proper', trim: 'Text.Trim', clean: 'Text.Clean' }[step.op];
      return `= Table.AddColumn(${prev}, ${q(step.as)}, each ${fn}([${step.column}]), type text)`;
    }
    case 'duplicateColumn': return `= Table.DuplicateColumn(${prev}, ${q(step.column)}, ${q(step.as || `${step.column} - Copy`)})`;
    case 'merge': {
      const kind = { leftOuter: 'LeftOuter', rightOuter: 'RightOuter', fullOuter: 'FullOuter', inner: 'Inner', leftAnti: 'LeftAnti', rightAnti: 'RightAnti' }[step.kind];
      return `= Table.ExpandTableColumn(Table.NestedJoin(${prev}, ${list(step.left)}, ${ref(step.query)}, ${list(step.right)}, ${q(step.column)}, JoinKind.${kind}), ${q(step.column)}, ${list(step.expand)}, ${list(step.expand.map((n) => `${step.column}.${n}`))})`;
    }
    default: return '';
  }
}

/** A short line on what the source is, for the Queries & Connections pane's tooltip. */
export function sourceSummary(query) {
  const s = query.source;
  return { csv: () => `Text/CSV: ${s.name}`, web: () => `Web: ${s.url}`, workbook: () => `Workbook: ${s.name} (${s.item})`, table: () => `Table: ${s.table}`,
    query: () => `Query: ${s.query}`, blank: () => 'Blank query' }[s.kind]?.() || '';
}

/* ---------- Loading into the sheet ---------- */

/** A table name made from a query name (spaces and other characters become _). */
export function tableNameFor(wb, queryName) {
  let base = String(queryName).replace(/[^A-Za-z0-9_.\\]/g, '_');
  if (!/^[A-Za-z_\\]/.test(base)) base = `_${base}`;
  base = base.slice(0, 200);
  if (!wb.validateTableName(base)) return base;
  for (let i = 2; ; i++) if (!wb.validateTableName(`${base}_${i}`)) return `${base}_${i}`;
}

/** A sheet name from a query name: characters a sheet name cannot hold dropped, numbered when taken (Sales, Sales (2)). */
export function sheetNameFor(wb, queryName) {
  const base = String(queryName).replace(/[[\]:*?/\\]/g, '').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Query';
  if (!wb.validateSheetName(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const name = `${base.slice(0, 31 - String(i).length - 3)} (${i})`;
    if (!wb.validateSheetName(name)) return name;
  }
  return null;
}

/** The cells for a result: the header row, then each row (an error becomes an empty cell). */
export function resultCells(table, r0, c0, at = null) {
  const entries = [];
  let errors = 0;
  // `at` places each of the result's columns at an offset of its own (columns of the table's between them).
  const col = (j) => c0 + (at ? at[j] : j);
  table.columns.forEach((name, j) => entries.push({ r: r0, c: col(j), cell: { v: name, f: null } }));
  table.rows.forEach((row, i) => row.forEach((v, j) => {
    if (isErr(v)) errors++;
    if (v == null || isErr(v)) return;
    const cell = { v, f: null };
    if (DATE_TYPES.has(table.types[j]) && typeof v === 'number') cell.s = { fmt: table.types[j] };
    entries.push({ r: r0 + 1 + i, c: col(j), cell });
  }));
  return { entries, errors };
}

/** Does any cell of a range hold something: a value, a formula, or part of a spilled result? */
function occupied(wb, sheetId, range) {
  const sheet = wb.sheet(sheetId);
  for (const [key, cell] of sheet.cells) {
    if (!cell || ((cell.v == null || cell.v === '') && cell.f == null)) continue;
    const [r, c] = key.split(',').map(Number);
    if (r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2) return true;
  }
  for (const a of wb._ensureSpills(sheet).anchors.values()) {
    if (a.r <= range.r2 && a.r + a.rows - 1 >= range.r1 && a.c <= range.c2 && a.c + a.cols - 1 >= range.c1) return true;
  }
  return false;
}

const PROTECTED = 'Part of the place the data goes is protected. Choose another location, or unprotect it first.';

const blockedMessage = (direction) => (direction === 'left'
  ? 'A column the query no longer gives could not be taken out of the table (a PivotTable, a protected sheet, merged cells or an array formula is in the way).'
  : `The refreshed data needs more ${direction === 'down' ? 'rows' : 'columns'}, but the cells ${direction === 'down' ? 'below' : 'beside'} the table could not be moved (a PivotTable, a protected sheet, merged cells or an array formula is in the way).`);

/**
 * Write a query's result into the workbook as a table:a new sheet named after the query, or at `at`
 * ({ sheetId, r, c }), or over the table it loaded before (a refresh), resized to the new rows and columns.
 * Returns { sheetId, tableId, rows, errors } or { error }.
 */
/**
 * The header names a result's columns take in a table: a table's names differ without regard to case (M's need only
 * differ), so a later "name" beside "Name" reads "name2", and a blank one is ColumnN, as a table names them.
 */
function tableHeaderNames(columns) {
  const present = new Set(columns.map((n) => String(n ?? '').toLowerCase()).filter(Boolean));
  const seen = new Set();
  return columns.map((name, i) => {
    let text = String(name ?? '');
    const free = (n) => !seen.has(n.toLowerCase()) && !present.has(n.toLowerCase());
    if (!text) { let k = i + 1; while (!free(`Column${k}`)) k++; text = `Column${k}`; }
    else if (seen.has(text.toLowerCase())) { let k = 2; while (!free(`${text}${k}`)) k++; text = `${text}${k}`; }
    seen.add(text.toLowerCase());
    return text;
  });
}

export function loadResult(wb, query, table, { at = null } = {}) {
  if (!table.columns.length) return { error: 'The query returned no columns to load.' };
  // The result is laid out under the names its columns take in the table, so a refresh finds each column again
  // (a "name2" the table gave the query's second "name" is the query's, not a column added by hand).
  const headers = tableHeaderNames(table.columns);
  if (headers.some((n, i) => n !== table.columns[i])) table = { ...table, columns: headers };
  const height = table.rows.length;
  const existing = loadedTable(wb, query);
  let result = null;
  const label = existing ? 'Refresh' : 'Load query';
  // What the query records of its table (the columns it loaded, which tell them from columns added by hand, and the
  // rows) goes back and forth with the step, so a refresh undone leaves no record of columns the table no longer has.
  // It goes first among the step's entries: those after a structural one are not replayed (see Workbook.transaction).
  const record = (q) => ({ load: { ...q.load }, rowCount: q.rowCount, errorCount: q.errorCount });
  const restore = (state) => {
    const live = queryById(wb, query.id);
    if (!live) return;
    live.load = { ...state.load };
    for (const key of ['rowCount', 'errorCount']) if (state[key] === undefined) delete live[key]; else live[key] = state[key];
    wb._announce?.('queries', null);
  };
  const before = record(query);
  let after = before;
  const write = () => {
    if (existing) {
      const { sheet } = existing;
      let t = existing.table;
      const { r1, c1 } = t.range;
      // Columns added to the table by hand (a calculated Total beside the query's columns) are the table's own, as in
      // Excel: a refresh keeps them, their formulas and values, and lays the query's columns out around them. They are
      // told apart by the columns the query loaded last time; a table loaded before that was recorded keeps its
      // calculated columns. Columns the query no longer gives are taken out of the table, so the rest close up.
      const resultNames = new Set(table.columns);
      const loaded = query.load?.columns;
      const handmade = (names, tt) => names.map((n, i) => !resultNames.has(n) && (loaded ? !loaded.includes(n) : tt.calc?.[i] != null));
      let names = wb.tableColumns(sheet.id, t);
      let own = handmade(names, t);
      const keep = own.some(Boolean);
      if (keep) {
        for (let i = names.length - 1; i >= 0; i--) {
          if (own[i] || resultNames.has(names[i])) continue;
          if (!wb.deleteCells(sheet.id, { r1: t.range.r1, c1: t.range.c1 + i, r2: t.range.r2, c2: t.range.c1 + i }, 'left')) { result = { error: blockedMessage('left') }; return; }
          t = wb.tableById(sheet.id, t.id);
        }
        names = wb.tableColumns(sheet.id, t);
        own = handmade(names, t);
      }
      const layout = keep ? [...names, ...table.columns.filter((n) => !names.includes(n))] : table.columns;
      const at = keep ? table.columns.map((n) => layout.indexOf(n)) : null;
      const old = { ...t.range };
      // A totals row stays the table's last row, under the fresh data: the resize below carries it (and its formulas) along.
      const foot = t.totalsRow ? 1 : 0;
      const next = { r1, c1, r2: r1 + Math.max(1, height) + foot, c2: c1 + layout.length - 1 };
      if (wb.lockedIn(sheet.id, { r1, c1, r2: Math.max(old.r2, next.r2), c2: Math.max(old.c2, next.c2) })) { result = { error: PROTECTED }; return; }
      // A table that grows makes room for its new rows and columns, as Excel's refresh inserts cells for new
      // data: what stands beside or below it (a note, a total, another table) moves along instead of being
      // written over. Nothing has changed yet when the cells cannot move, so the refresh stops there.
      const right = { r1, c1: old.c2 + 1, r2: Math.max(old.r2, next.r2), c2: next.c2 };
      if (next.c2 > old.c2 && occupied(wb, sheet.id, right) && !wb.insertCells(sheet.id, right, 'right')) { result = { error: blockedMessage('right') }; return; }
      const below = { r1: old.r2 + 1, c1, r2: next.r2, c2: Math.max(old.c2, next.c2) };
      if (next.r2 > old.r2 && occupied(wb, sheet.id, below) && !wb.insertCells(sheet.id, below, 'down')) { result = { error: blockedMessage('down') }; return; }
      if (next.r2 !== old.r2 || next.c2 !== old.c2) {
        let problem = null;
        if (!wb.resizeTable(sheet.id, t.id, next, { onInvalid: (m) => { problem = m; } })) { result = { error: problem || 'The table could not be resized for the new data.' }; return; }
      }
      // The rows that held the old data: up to the old last row, less the totals row now at the new last row.
      const clearData = (cols) => {
        wb.clearRange(sheet.id, { r1: r1 + 1, r2: Math.min(old.r2, next.r2 - foot), ...cols });
        if (old.r2 > next.r2) wb.clearRange(sheet.id, { r1: next.r2 + 1, r2: old.r2, ...cols });
      };
      if (keep) {
        // The query's columns are written afresh; the table's own keep their cells, but for the rows it no longer has.
        for (const p of at) if (p < names.length) clearData({ c1: c1 + p, c2: c1 + p });
        if (old.r2 > next.r2) own.forEach((mine, p) => { if (mine) wb.clearRange(sheet.id, { r1: next.r2 + 1, c1: c1 + p, r2: old.r2, c2: c1 + p }); });
        // Rows the table gained take its calculated columns' formulas, as rows typed under a table do.
        for (let r = old.r2 - foot + 1; r <= next.r2 - foot; r++) wb._fillCalculatedRow(sheet, wb.tableById(sheet.id, t.id), r);
      } else {
        clearData({ c1: old.c1, c2: old.c2 });
        if (next.c2 < old.c2) wb.clearRange(sheet.id, { r1, c1: next.c2 + 1, r2: r1, c2: old.c2 });
        // Columns the table no longer has did not move with its totals row: their cell on that row's new place is cleared too.
        if (foot && next.c2 < old.c2 && next.r2 <= old.r2) wb.clearRange(sheet.id, { r1: next.r2, c1: next.c2 + 1, r2: next.r2, c2: old.c2 });
      }
      const { entries, errors } = resultCells(table, r1, c1, at);
      // The cells keep the formatting given to them (a currency, bold, a date format), as Excel's refresh preserves
      // cell formatting; a row the table gains takes its column's formatting from the last row it had.
      // The formatted cells are gathered in one pass over the sheet's cells, by column, rather than looked up one by
      // one: a refresh of 100,000 rows writes 600,000 cells, few of them formatted, or whole columns alike.
      const formatted = new Map();
      for (const [key, cell] of sheet.cells) {
        if (!cell?.s) continue;
        const comma = key.indexOf(','), r = Number(key.slice(0, comma)), c = Number(key.slice(comma + 1));
        if (r < r1 || r > old.r2 || c < c1 || c > next.c2) continue;
        if (!formatted.has(c)) formatted.set(c, []);
        formatted.get(c)[r - r1] = cell.s;
      }
      const lastRow = old.r2 - foot > r1 ? old.r2 - foot - r1 : null;
      if (formatted.size) for (const e of entries) {
        const column = formatted.get(e.c);
        const kept = column && (column[e.r - r1] || (e.r > old.r2 - foot && lastRow != null ? column[lastRow] : null));
        if (kept) e.cell.s = e.cell.s && !kept.fmt ? { ...kept, ...e.cell.s } : kept;
      }
      wb.setCells(sheet.id, entries, label);
      // A filter on the table judges the fresh rows, as Excel's refresh applies it again (Preserve column
      // sort/filter/layout): the rows it hid were picked by position, and now hold other records.
      wb._refilterRearranged(sheet, { r1, r2: Math.max(old.r2, next.r2) }, label);
      query.load = { kind: 'table', table: t.name, sheet: sheet.name, tableId: t.id, columns: [...table.columns] };
      result = { sheetId: sheet.id, tableId: t.id, rows: height, errors };
      return;
    }
    let sheetId, r0 = 0, c0 = 0;
    if (at) { sheetId = at.sheetId; r0 = at.r; c0 = at.c; }
    else {
      const sheet = wb.addSheet(sheetNameFor(wb, query.name));
      if (!sheet) { result = { error: 'A sheet could not be added (is the workbook protected?).' }; return; }
      sheetId = sheet.id;
    }
    const range = { r1: r0, c1: c0, r2: r0 + Math.max(1, height), c2: c0 + table.columns.length - 1 };
    if (wb.sheet(sheetId).tables.some((t) => !(range.r2 < t.range.r1 || range.r1 > t.range.r2 || range.c2 < t.range.c1 || range.c1 > t.range.c2))) {
      result = { error: 'The data would overlap another table. Choose another location.' }; return;
    }
    // A protected cell there refuses the data, which left an empty table behind reported as loaded.
    if (at && wb.lockedIn(sheetId, range)) { result = { error: PROTECTED }; return; }
    // Loading over cells that hold something would write over them without a word: the location must be empty.
    if (at && occupied(wb, sheetId, range)) { result = { error: 'There is data where the table would go. Choose an empty location, or a new worksheet.' }; return; }
    const { entries, errors } = resultCells(table, r0, c0);
    wb.setCells(sheetId, entries, label);
    const name = tableNameFor(wb, query.name);
    const tableId = wb.addTable(sheetId, range, { name });
    if (!tableId) { result = { error: 'A table could not be created there.' }; return; }
    query.load = { kind: 'table', table: name, sheet: wb.sheet(sheetId).name, tableId, columns: [...table.columns] };
    result = { sheetId, tableId, rows: height, errors };
  };
  wb.transaction(label, () => {
    write();
    if (result && !result.error) wb._group.unshift({ label, undo: () => restore(before), redo: () => restore(after) });
  });
  if (result && !result.error) {
    query.refreshed = Date.now(); query.rowCount = height;
    if (result.errors) query.errorCount = result.errors; else delete query.errorCount;
    after = record(saveQuery(wb, query));
  }
  return result || { error: 'Nothing was loaded.' };
}

/** Evaluate a query and write it over its table (or only record its row count, for a connection-only query). */
export async function refreshQuery(wb, query, io = {}) {
  const { table, error } = await evaluateQuery(wb, query, io);
  if (error) return { error: error.message };
  if (query.load.kind !== 'table') {
    query.refreshed = Date.now(); query.rowCount = table.rows.length;
    saveQuery(wb, query);
    return { rows: table.rows.length, errors: 0 };
  }
  return loadResult(wb, query, table);
}

/** Refresh every query in order; a query that fails does not stop the others. Returns { refreshed, failed: [{ name, error }] }. */
export async function refreshAll(wb, io = {}) {
  const failed = [];
  let refreshed = 0;
  for (const q of [...(wb.queries || [])]) {
    const live = queryById(wb, q.id);
    if (!live) continue;
    const res = await refreshQuery(wb, live, io);
    if (res.error) failed.push({ name: live.name, error: res.error }); else refreshed++;
  }
  return { refreshed, failed };
}

/** Stop loading a query to a sheet (Load To ▸ Only Create Connection): its table goes. */
export function unloadQuery(wb, query) {
  const hit = loadedTable(wb, query);
  if (hit) {
    wb.transaction('Load query', () => {
      const range = { ...hit.table.range };
      wb.deleteTable(hit.sheet.id, hit.table.id);
      wb.clearRange(hit.sheet.id, range, { styles: true });
    });
  }
  query.load = { kind: 'connection' };
  saveQuery(wb, query);
}
