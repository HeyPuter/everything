/**
 * What a worksheet's own XML says of the settings this app's private record (the sidecar) also
 * holds. A save notes it beside those settings. Excel keeps the record when it saves the file
 * again, so a reopened file whose XML no longer says the same had that setting changed in another
 * program, and the XML's word wins over the record, which would otherwise undo the change (see
 * importSheet). The projection is of meaning, not spelling: Excel writing the same state its own
 * way (attributes in another order, defaults left out, column runs split or joined) is no change.
 */
import { readXlsxValidations } from './xlsx-validation.js';

const on = (value) => ['1', 'true'].includes(String(value ?? '').trim());
const off = (value) => ['0', 'false'].includes(String(value ?? '').trim());

/** A tag's attributes by name, as written (entities left alone). */
function attributes(tag) {
  const out = {};
  for (const m of String(tag || '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

// A row hidden, or given no height, which Excel shows as hidden too.
const HIDDEN_ROW = /\s(?:hidden\s*=\s*["']\s*(?:1|true)\s*["']|ht\s*=\s*["']\s*(?:0+(?:\.0*)?|\.0+)\s*["'])/;

/** Sorted line indices as runs, [[from, to], …]. */
function runs(lines) {
  const out = [];
  for (const i of [...new Set(lines)].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && last[1] === i - 1) last[1] = i;
    else out.push([i, i]);
  }
  return out;
}

/** Runs of lines sharing one outline level, [[from, to, level], …]. */
function levelRuns(levels) {
  const out = [];
  for (const [i, level] of [...levels].sort(([a], [b]) => a - b)) {
    const last = out.at(-1);
    if (last && last[1] === i - 1 && last[2] === level) last[1] = i;
    else out.push([i, i, level]);
  }
  return out;
}

const outlineLevel = (value) => Math.max(0, Math.min(7, Math.trunc(Number(value) || 0)));

/**
 * The state of a worksheet (or chart sheet) part: whether it is protected, its tab colour, its
 * first view's gridlines and zoom (a chart sheet's zoom to fit the window as well), its hidden
 * rows and columns, and their outline: the levels of the grouped lines and the summary lines
 * marked collapsed.
 */
export function nativeSheetState(xml) {
  xml = String(xml || '');
  if (xml.includes('<!--')) xml = xml.replace(/<!--[\s\S]*?-->/g, '');
  const start = xml.search(/<(?:\w+:)?sheetData[\s>/]/);
  const head = start < 0 ? xml : xml.slice(0, start);
  const chart = /<(?:\w+:)?chartsheet\b/.test(head);
  // The last tag naming sheetData closes it (or is the empty one); searched from the end, past the cells.
  const close = start < 0 ? -1 : xml.lastIndexOf('<', xml.lastIndexOf('sheetData'));
  const tail = close < 0 ? chart ? xml : '' : xml.slice(close);
  const protection = attributes(tail.match(/<(?:\w+:)?sheetProtection\b[^>]*>/)?.[0]);
  // A tab colour as its attributes give it: RGB, or a theme or palette colour with its tint.
  const tab = attributes(head.match(/<(?:\w+:)?tabColor\b[^>]*>/)?.[0]);
  const color = Object.keys(tab).length ? ['rgb', 'theme', 'indexed', 'tint', 'auto']
    .map(key => tab[key] == null ? '' : key === 'rgb' ? tab[key].slice(-6).toUpperCase() : key === 'tint' ? String(Number(tab[key]) || 0) : tab[key].trim()).join('|') : null;
  const view = attributes(head.match(/<(?:\w+:)?sheetView\b[^>]*>/)?.[0]);
  // A row or column hidden, or given no height or width, which Excel shows as hidden too.
  const hiddenRows = [], hiddenCols = [], collapsedRows = [], collapsedCols = [], rowLevels = new Map(), colLevels = new Map();
  let r = -1;
  // Every row is looked at on each opening of a file saved here, a million of them on a big sheet: cheaply.
  const rowTags = /<(?:\w+:)?row\b([^>]*)>/g;
  rowTags.lastIndex = Math.max(0, start);
  for (let m; close >= 0 && (m = rowTags.exec(xml)) && m.index < close;) {
    // A row without a number follows the one before (CT_Row's r is optional).
    const attrs = m[1], at = attrs.indexOf(' r="');
    const n = at >= 0 ? parseInt(attrs.slice(at + 4), 10) : Number(/\sr\s*=\s*["']\s*(\d+)/.exec(attrs)?.[1]);
    r = n > 0 ? n - 1 : r + 1;
    if ((attrs.includes('hidden') || attrs.includes('ht')) && HIDDEN_ROW.test(attrs)) hiddenRows.push(r);
    if (!attrs.includes('outlineLevel') && !attrs.includes('collapsed')) continue;
    const a = attributes(attrs);
    if (outlineLevel(a.outlineLevel)) rowLevels.set(r, outlineLevel(a.outlineLevel));
    if (on(a.collapsed)) collapsedRows.push(r);
  }
  for (const m of head.matchAll(/<(?:\w+:)?col\b[^>]*>/g)) {
    const a = attributes(m[0]), min = Number(a.min), max = Number(a.max);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 16384) continue;
    for (let c = min - 1; c < max; c++) {
      if (on(a.hidden) || (a.width != null && Number(a.width) === 0)) hiddenCols.push(c);
      if (outlineLevel(a.outlineLevel)) colLevels.set(c, outlineLevel(a.outlineLevel));
      if (on(a.collapsed)) collapsedCols.push(c);
    }
  }
  return {
    protected: chart ? on(protection.content) || on(protection.objects) : on(protection.sheet),
    color,
    gridlines: !off(view.showGridLines),
    // CT_SheetView's zoomScale is 100 when left out (and taken as that when out of Excel's range).
    zoom: Number(view.zoomScale) >= 10 && Number(view.zoomScale) <= 400 ? Number(view.zoomScale) : 100,
    ...(chart ? { zoomToFit: on(view.zoomToFit) } : {}),
    hiddenRows: runs(hiddenRows),
    hiddenCols: runs(hiddenCols),
    rowLevels: levelRuns(rowLevels),
    colLevels: levelRuns(colLevels),
    collapsedRows: runs(collapsedRows),
    collapsedCols: runs(collapsedCols),
  };
}

/** Whether the part's `key` no longer says what the record noted it said at the last save here. */
export function nativeStateChanged(saved, current, key) {
  return !!saved && typeof saved === 'object' && Object.hasOwn(saved, key) && JSON.stringify(saved[key]) !== JSON.stringify(current?.[key]);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text) => String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, name) => {
  if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? m;
  const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
});
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/**
 * The data validations of a worksheet part, as the reader takes them in (so Excel leaving out an
 * attribute at its default is no change), hashed: a sheet can carry thousands of rules. A part with
 * none is '' at once, with no hashing to wait for, as most sheets have none.
 */
export function nativeValidationsSignature(xml) {
  xml = String(xml || '');
  const end = xml.lastIndexOf('sheetData'), close = end < 0 ? -1 : xml.lastIndexOf('<', end);
  const tail = close < 0 ? '' : xml.slice(close);
  if (!tail.includes('dataValidation')) return '';
  const root = xml.match(/<(?:\w+:)?worksheet\b(?:[^<>"']|"[^"]*"|'[^']*')*>/)?.[0] || '';
  const rules = readXlsxValidations(tail, root, { attributes, decode,
    decodeString: (text) => decode(text).replace(/_x([0-9a-f]{4})_/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16))) });
  return rules.length ? hashRules(rules) : '';
}

async function hashRules(rules) {
  const { sha256 } = await import('@noble/hashes/sha2.js');
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify(canonical(rules)))), n => n.toString(16).padStart(2, '0')).join('');
}
