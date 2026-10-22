/**
 * Autofilter conditions, the filterColumn elements of a sheet's or a
 * table's autoFilter, as this app's filter criteria and back. Excel matches
 * a value list against the text shown in the cell, as this app does, and a
 * custom filter's text with * and ? as wildcards, ~ escaping either.
 */

import { ymdToSerial, serialToYMD, todaySerial } from './format.js';

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (text) => String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, entity) => {
  if (entity[0] !== '#') return XML_ENTITIES[entity.toLowerCase()] ?? m;
  const hex = /^#x/i.test(entity);
  const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
});
const attr = (tag, name) => {
  const m = tag?.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
};
const escapeAttr = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\t\n\r]/g, (ch) => `&#${ch.charCodeAt(0)};`);

const COLUMN = /<(?:\w+:)?filterColumn\b([^<>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?filterColumn>)/g;
const CHILD = /<(?:\w+:)?(\w+)\b([^<>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?\1>)/;
const ITEM = /<(?:\w+:)?(\w+)\b([^<>]*?)\/?>/g;
const OPERATORS = { equal: 'eq', notEqual: 'neq', greaterThan: 'gt', greaterThanOrEqual: 'gte', lessThan: 'lt', lessThanOrEqual: 'lte' };
const numeric = (text) => /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*$/.test(text) && Number.isFinite(Number(text));

/**
 * A custom filter's text pattern as a condition: *x* contains, x* begins with,
 * *x ends with, otherwise an exact comparison. Null for a pattern this app's
 * conditions cannot express (a wildcard inside the text, "not begins with").
 */
function pattern(val, negate) {
  let leading = false;
  let trailing = false;
  let text = '';
  for (let i = 0; i < val.length; i++) {
    const ch = val[i];
    if (ch === '~' && i + 1 < val.length) { text += val[++i]; continue; }
    if (ch === '*') {
      if (!text && !leading) { leading = true; continue; }
      if (i === val.length - 1) { trailing = true; continue; }
      return null;
    }
    if (ch === '?') return null;
    text += ch;
  }
  if (!text) return null;
  if (leading && trailing) return { op: negate ? 'notContains' : 'contains', value: text };
  if (negate) return leading || trailing ? null : { op: 'neq', value: text };
  if (leading) return { op: 'endsWith', value: text };
  if (trailing) return { op: 'beginsWith', value: text };
  return { op: 'eq', value: text };
}

function customFilters(body, and) {
  const items = [...body.matchAll(ITEM)].filter((m) => m[1] === 'customFilter').map((m) => ({ op: attr(m[0], 'operator') || 'equal', val: attr(m[0], 'val') ?? '' }));
  if (!items.length || items.length > 2) return null;
  if (items.length === 2) {
    // "Between" is written as two bounds joined by and.
    const bounds = { greaterThanOrEqual: 'value', lessThanOrEqual: 'value2' };
    if (!and || !items.every((item) => bounds[item.op] && numeric(item.val)) || items[0].op === items[1].op) return null;
    const between = { op: 'between' };
    for (const item of items) between[bounds[item.op]] = Number(item.val);
    return between;
  }
  const [{ op, val }] = items;
  if (!Object.hasOwn(OPERATORS, op)) return null;
  const kind = OPERATORS[op];
  // Excel writes "not equal to a space" for its non-blanks filter.
  if (kind === 'neq' && val === ' ') return { op: 'notEmpty' };
  if (kind === 'eq' || kind === 'neq') {
    // Only a number's own spelling is that number: "007" and "1.50" are text codes, which Excel
    // matches as the text they are and this app would otherwise look for as 7 and 1.5.
    if (numeric(val) && String(Number(val)) === val.trim()) return { op: kind, value: Number(val) };
    return pattern(val, kind === 'neq');
  }
  return numeric(val) ? { op: kind, value: Number(val) } : null;
}

/** A filterColumn's condition markup without namespace prefixes, to be written inside this app's own worksheet. */
const plainMarkup = (markup) => String(markup).replace(/<(\/?)\w+:/g, '<$1').replace(/\s+xmlns(?::\w+)?="[^"]*"/g, '');

/**
 * The criteria of an autoFilter element, keyed by sheet column, or null when a
 * column's position is not in the range. A condition this app has no criterion for
 * (a top ten, a dynamic or date-group filter, a colour, an icon, a pattern) is kept
 * as the file wrote it, as { native }: it goes back into the file unchanged, and
 * nativeFilterJudge judges the rows by it where it can.
 */
export function readXlsxFilter(xml, range) {
  const criteria = {};
  for (const [, open, body = ''] of String(xml).matchAll(COLUMN)) {
    const colId = Number(attr(`<c ${open}>`, 'colId'));
    if (!Number.isInteger(colId) || colId < 0 || range.c1 + colId > range.c2) return null;
    const child = body.match(CHILD);
    if (!child) continue;
    const [, name, attrs, inner = ''] = child;
    let criterion = null;
    if (name === 'filters') {
      const items = [...inner.matchAll(ITEM)];
      if (items.some((m) => m[1] !== 'filter')) { criteria[range.c1 + colId] = { native: plainMarkup(body.trim()) }; continue; }
      const values = items.map((m) => attr(m[0], 'val') ?? '');
      if (['1', 'true'].includes(attr(`<f ${attrs}>`, 'blank') ?? '')) values.push('');
      criterion = { values, caseSensitive: false };
    } else if (name === 'customFilters') criterion = customFilters(inner, ['1', 'true'].includes(attr(`<f ${attrs}>`, 'and') ?? ''));
    criteria[range.c1 + colId] = criterion || { native: plainMarkup(body.trim()) };
  }
  return criteria;
}

const DAY_FIELDS = ['year', 'month', 'day', 'hour', 'minute', 'second'];

/** The [start, end) serials of a relative date period, from `today`: Excel's weeks start on Sunday. */
function relativePeriod(type, today) {
  const { y, m, weekday } = serialToYMD(today);
  const quarter = Math.floor((m - 1) / 3);
  const span = {
    yesterday: [today - 1, today], today: [today, today + 1], tomorrow: [today + 1, today + 2],
    lastWeek: [today - weekday - 7, today - weekday], thisWeek: [today - weekday, today - weekday + 7], nextWeek: [today - weekday + 7, today - weekday + 14],
    lastMonth: [ymdToSerial(y, m - 1, 1), ymdToSerial(y, m, 1)], thisMonth: [ymdToSerial(y, m, 1), ymdToSerial(y, m + 1, 1)], nextMonth: [ymdToSerial(y, m + 1, 1), ymdToSerial(y, m + 2, 1)],
    lastQuarter: [ymdToSerial(y, quarter * 3 - 2, 1), ymdToSerial(y, quarter * 3 + 1, 1)], thisQuarter: [ymdToSerial(y, quarter * 3 + 1, 1), ymdToSerial(y, quarter * 3 + 4, 1)],
    nextQuarter: [ymdToSerial(y, quarter * 3 + 4, 1), ymdToSerial(y, quarter * 3 + 7, 1)],
    lastYear: [ymdToSerial(y - 1, 1, 1), ymdToSerial(y, 1, 1)], thisYear: [ymdToSerial(y, 1, 1), ymdToSerial(y + 1, 1, 1)], nextYear: [ymdToSerial(y + 1, 1, 1), ymdToSerial(y + 2, 1, 1)],
    yearToDate: [ymdToSerial(y, 1, 1), today + 1],
  };
  return span[type] || null;
}

/** Excel's customFilter text with * and ? as wildcards (~ escaping either) as a whole-text pattern. */
const wildcardPattern = (val) => {
  const source = String(val).replace(/~([*?~])|([*?])|[.+^$(){}|[\]\\]/g, (m, escaped, wild) => (escaped ? `\\${escaped}` : wild === '*' ? '[^]*' : wild ? '[^]' : `\\${m}`));
  return new RegExp(`^${source}$`, 'i');
};

/**
 * A judge of the rows for a condition kept as the file wrote it ({ native }), from the column's values
 * (`values`, every row of the list's data, hidden or not, as Excel ranks a top ten among them): `(value, text)
 * => keep`. A top ten (items or percent), above or below average, a relative date or a quarter or month,
 * a date group with or without listed values, and any custom pair of conditions are judged; a colour or an
 * icon cannot be, and keeps every row (null).
 */
export function nativeFilterJudge(native, values, today = todaySerial()) {
  const child = String(native || '').match(CHILD);
  if (!child) return null;
  const [, name, attrs, inner = ''] = child;
  const tag = `<f ${attrs}>`;
  const numbers = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
  if (name === 'top10') {
    const top = !['0', 'false'].includes(attr(tag, 'top') ?? '1'), percent = ['1', 'true'].includes(attr(tag, 'percent') ?? '0');
    const n = Number(attr(tag, 'val') ?? 10);
    if (!Number.isFinite(n) || n <= 0 || !numbers.length) return () => false;
    const count = Math.max(1, Math.min(numbers.length, percent ? Math.floor(numbers.length * n / 100) : Math.floor(n)));
    const sorted = numbers.slice().sort((a, b) => (top ? b - a : a - b));
    const bound = sorted[count - 1];
    return (v) => isNumber(v) && (top ? v >= bound : v <= bound);
  }
  if (name === 'dynamicFilter') {
    const type = attr(tag, 'type') || '';
    if (type === 'aboveAverage' || type === 'belowAverage') {
      const average = numbers.reduce((a, b) => a + b, 0) / (numbers.length || 1);
      return (v) => isNumber(v) && (type === 'aboveAverage' ? v > average : v < average);
    }
    const quarter = /^Q([1-4])$/.exec(type), month = /^M(1[0-2]|[1-9])$/.exec(type);
    if (quarter || month) return (v) => isNumber(v) && v >= 1 && (({ m }) => (quarter ? Math.ceil(m / 3) === Number(quarter[1]) : m === Number(month[1])))(serialToYMD(v));
    const period = relativePeriod(type, today);
    return period ? (v) => isNumber(v) && v >= period[0] && v < period[1] : null;
  }
  if (name === 'filters') {
    const texts = new Set([...inner.matchAll(ITEM)].filter((m) => m[1] === 'filter').map((m) => (attr(m[0], 'val') ?? '').toLowerCase()));
    const groups = [...inner.matchAll(ITEM)].filter((m) => m[1] === 'dateGroupItem').map((m) => {
      const level = DAY_FIELDS.indexOf(attr(m[0], 'dateTimeGrouping') || 'year');
      return DAY_FIELDS.slice(0, level + 1).map((field) => Number(attr(m[0], field) ?? NaN));
    });
    const blank = ['1', 'true'].includes(attr(tag, 'blank') ?? '');
    return (v, text) => {
      if (v == null || v === '') return blank;
      if (texts.has(String(text).toLowerCase())) return true;
      if (!isNumber(v) || v < 1) return false;
      const { y, m, d } = serialToYMD(v);
      const seconds = Math.round((v - Math.floor(v)) * 86400);
      const parts = [y, m, d, Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
      return groups.some((group) => group.every((value, i) => value === parts[i]));
    };
  }
  if (name === 'customFilters') {
    const and = ['1', 'true'].includes(attr(tag, 'and') ?? '');
    const tests = [...inner.matchAll(ITEM)].filter((m) => m[1] === 'customFilter').map((m) => {
      const op = attr(m[0], 'operator') || 'equal', val = attr(m[0], 'val') ?? '';
      if (op === 'equal' || op === 'notEqual') {
        const same = numeric(val) ? (v, text) => (isNumber(v) ? v === Number(val) : wildcardPattern(val).test(text)) : (v, text) => wildcardPattern(val).test(text);
        return op === 'equal' ? same : (v, text) => !same(v, text);
      }
      const compare = { greaterThan: (a, b) => a > b, greaterThanOrEqual: (a, b) => a >= b, lessThan: (a, b) => a < b, lessThanOrEqual: (a, b) => a <= b }[op];
      if (!compare) return null;
      return numeric(val) ? (v) => isNumber(v) && compare(v, Number(val)) : (v, text) => compare(String(text).toLowerCase(), val.toLowerCase());
    });
    if (!tests.length || tests.includes(null)) return null;
    return (v, text) => (and ? tests.every((t) => t(v, text)) : tests.some((t) => t(v, text)));
  }
  return null;
}

/** Button visibility is independent of whether a column has a filter condition. */
export function readXlsxFilterButtons(xml, range) {
  const hidden = new Set();
  for (const [, open] of String(xml || '').replace(/<!--[\s\S]*?-->/g, '').matchAll(COLUMN)) {
    const tag = `<c ${open}>`, id = attr(tag, 'colId');
    if (id == null || !/^\d+$/.test(id)) continue;
    const c = range.c1 + Number(id);
    if (c > range.c2) continue;
    if (['1', 'true'].includes(attr(tag, 'hiddenButton')) || ['0', 'false'].includes(attr(tag, 'showButton'))) hidden.add(c);
  }
  if (hidden.size === range.c2 - range.c1 + 1) return { showButtons: false };
  return hidden.size ? { hiddenButtons: [...hidden].sort((a, b) => a - b) } : {};
}

/** A value as a custom filter's text: its wildcards made literal. */
const literal = (value) => String(value).replace(/[~*?]/g, (ch) => `~${ch}`);

/**
 * The filterColumn elements for a filter's criteria and button visibility, for the inside of its
 * autoFilter element. A criterion Excel has no condition for (a formula, a
 * colour) is left out; it travels in the sidecar, and the rows it hides are
 * hidden rows in the file either way.
 *
 * Excel judges a value list by the cell's value, not by the text it shows, so
 * `numbersByText(col)` may answer a Map from a listed text to the numbers the
 * column shows as that text; those numbers are written instead of the text,
 * and a text several numbers show as gets one element each.
 */
export function writeXlsxFilter(filter, numbersByText = null) {
  const range = filter?.range;
  if (!range) return '';
  const out = [];
  const custom = (items, and) => `<customFilters${and ? ' and="1"' : ''}>${items.map(([operator, val]) => `<customFilter operator="${operator}" val="${escapeAttr(val)}"/>`).join('')}</customFilters>`;
  const number = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN);
  // Button visibility belongs to each native filterColumn, even when that
  // column has no condition. Omitting it makes Excel show buttons that were
  // hidden in an imported table or worksheet filter.
  const columns = new Set(Object.keys(filter.criteria || {}));
  const hidden = new Set(filter.hiddenButtons || []);
  for (const c of hidden) if (Number.isInteger(c)) columns.add(String(c));
  if (filter.showButtons === false) {
    for (let c = range.c1; c <= range.c2; c++) columns.add(String(c));
  }
  for (const key of columns) {
    const crit = filter.criteria?.[key] || {};
    const colId = Number(key) - range.c1;
    if (!Number.isInteger(colId) || colId < 0 || colId > range.c2 - range.c1 || !crit) continue;
    let body = null;
    // A condition kept as the file wrote it goes back as it came. A colour filter's format was the file's, and is
    // named here by its colour (crit.ink for a font colour), for the writer to give the format this file has for it;
    // one whose colour was never known has no format to name and is left out, its rows still hidden.
    if (typeof crit.native === 'string' && crit.native) {
      const colour = /^<colorFilter\b/.test(crit.native) ? (['0', 'false'].includes(attr(crit.native.match(/^<[^>]*>/)[0], 'cellColor')) ? ['ink', crit.ink] : ['fill', crit.color]) : null;
      if (!colour) body = crit.native;
      else if (/^#[\da-f]{6}$/i.test(colour[1] || '')) body = crit.native.replace(/\bdxfId="[^"]*"/, `dxfId="puter-${colour[0]}-${colour[1].slice(1).toLowerCase()}"`);
    }
    else if (Array.isArray(crit.values)) {
      const shown = crit.values.filter((value) => value !== '');
      const numbers = shown.length ? numbersByText?.(Number(key)) : null;
      const vals = shown.flatMap((value) => {
        const behind = numbers?.get(value);
        return behind?.length ? behind.map(String) : [String(value)];
      });
      body = `<filters${shown.length < crit.values.length ? ' blank="1"' : ''}>${vals.map((value) => `<filter val="${escapeAttr(value)}"/>`).join('')}</filters>`;
    } else if (crit.op === 'empty') body = '<filters blank="1"/>';
    else if (crit.op === 'notEmpty') body = custom([['notEqual', ' ']]);
    else if (crit.op === 'eq' || crit.op === 'neq') {
      // Equality takes either spelling here, so a criterion typed as text goes into the file as
      // that text: read as a number, "equals 007" became "equals 7" and Excel hid every 007 row.
      // A comparison below is numeric on both sides and keeps its coercion.
      const value = typeof crit.value === 'number' ? String(crit.value) : literal(crit.value ?? '');
      body = custom([[crit.op === 'eq' ? 'equal' : 'notEqual', value]]);
    } else if (['gt', 'gte', 'lt', 'lte'].includes(crit.op)) {
      if (Number.isFinite(number(crit.value))) body = custom([[{ gt: 'greaterThan', gte: 'greaterThanOrEqual', lt: 'lessThan', lte: 'lessThanOrEqual' }[crit.op], String(number(crit.value))]]);
    } else if (crit.op === 'between') {
      const a = number(crit.value), b = number(crit.value2);
      if (Number.isFinite(a) && Number.isFinite(b)) body = custom([['greaterThanOrEqual', String(Math.min(a, b))], ['lessThanOrEqual', String(Math.max(a, b))]], true);
    } else if (['contains', 'notContains', 'beginsWith', 'endsWith'].includes(crit.op) || (crit.text != null && !crit.formula && crit.color == null)) {
      const text = literal(crit.op ? crit.value ?? '' : crit.text);
      if (text) {
        const val = crit.op === 'beginsWith' ? `${text}*` : crit.op === 'endsWith' ? `*${text}` : `*${text}*`;
        body = custom([[crit.op === 'notContains' ? 'notEqual' : 'equal', val]]);
      }
    }
    const visibility = filter.showButtons === false || hidden.has(Number(key)) ? ' hiddenButton="1"' : '';
    if (body) out.push(`<filterColumn colId="${colId}"${visibility}>${body}</filterColumn>`);
    else if (visibility) out.push(`<filterColumn colId="${colId}"${visibility}/>`);
  }
  return out.join('');
}
