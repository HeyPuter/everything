/**
 * What a worksheet's own XML says of the settings this app's private record (the sidecar) also
 * holds. A save notes it beside those settings. Excel keeps the record when it saves the file
 * again, so a reopened file whose XML no longer says the same had that setting changed in another
 * program, and the XML's word wins over the record, which would otherwise undo the change (see
 * importSheet). The projection is of meaning, not spelling: Excel writing the same state its own
 * way (attributes in another order, defaults left out, column runs split or joined) is no change.
 */
import { readXlsxValidations } from './xlsx-validation.js';
import { MAX_ROW } from './refs.js';

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
  // A part's rows come in order, as a rule, a million of them on a sheet with every row below its data hidden:
  // only lines out of order are sorted.
  let ordered = true;
  for (let k = 1; ordered && k < lines.length; k++) ordered = lines[k] >= lines[k - 1];
  const out = [];
  for (const i of ordered ? lines : [...new Set(lines)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] >= i) continue;
    if (last && last[1] === i - 1) last[1] = i;
    else out.push([i, i]);
  }
  return out;
}

/** The runs of rows up to the sheet's last that sorted, disjoint runs leave out. */
function gaps(shown) {
  const out = [];
  let next = 0;
  for (const [from, to] of shown) {
    if (from > MAX_ROW) break;
    if (from > next) out.push([next, from - 1]);
    next = to + 1;
  }
  if (next <= MAX_ROW) out.push([next, MAX_ROW]);
  return out;
}

/**
 * Whether a worksheet's rows are hidden by default (sheetFormatPr's zeroHeight, "Hidden By Default"):
 * a part with most of its rows hidden can list only the rows it shows instead (ECMA-376 §18.3.1.81),
 * every row it does not list then being hidden.
 */
function rowsHiddenByDefault(head) {
  return on(attributes(head.match(/<(?:\w+:)?sheetFormatPr\b[^>]*>/)?.[0]).zeroHeight);
}

/** Where a part's sheetData starts and where its closing tag is (-1 for none). */
function sheetDataBounds(xml) {
  const start = xml.search(/<(?:\w+:)?sheetData[\s>/]/);
  // The last tag naming sheetData closes it (or is the empty one); searched from the end, past the cells.
  return { start, close: start < 0 ? -1 : xml.lastIndexOf('<', xml.lastIndexOf('sheetData')) };
}

/** Each row tag of sheetData in turn, with its row index and its attributes as written. */
function eachRow(xml, start, close, visit) {
  let r = -1;
  // Every row is looked at on each opening of a file saved here, a million of them on a big sheet: cheaply.
  const rowTags = /<(?:\w+:)?row\b([^>]*)>/g;
  rowTags.lastIndex = Math.max(0, start);
  for (let m; close >= 0 && (m = rowTags.exec(xml)) && m.index < close;) {
    // A row without a number follows the one before (CT_Row's r is optional).
    const attrs = m[1], at = attrs.indexOf(' r="');
    const n = at >= 0 ? parseInt(attrs.slice(at + 4), 10) : Number(/\sr\s*=\s*["']\s*(\d+)/.exec(attrs)?.[1]);
    r = n > 0 ? n - 1 : r + 1;
    visit(r, attrs);
  }
}

/**
 * The rows a worksheet part lists, when its rows are hidden by default (see rowsHiddenByDefault):
 * every other row is hidden. Null for a part whose rows are shown by default, as most are.
 */
export function xlsxRowsListedWhenHidden(xml) {
  xml = String(xml || '');
  if (!xml.includes('zeroHeight')) return null;
  if (xml.includes('<!--')) xml = xml.replace(/<!--[\s\S]*?-->/g, '');
  const { start, close } = sheetDataBounds(xml);
  if (!rowsHiddenByDefault(start < 0 ? xml : xml.slice(0, start))) return null;
  const listed = new Set();
  eachRow(xml, start, close, (r) => listed.add(r));
  return listed;
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
  const { start, close } = sheetDataBounds(xml);
  const head = start < 0 ? xml : xml.slice(0, start);
  const chart = /<(?:\w+:)?chartsheet\b/.test(head);
  const tail = close < 0 ? chart ? xml : '' : xml.slice(close);
  const protection = attributes(tail.match(/<(?:\w+:)?sheetProtection\b[^>]*>/)?.[0]);
  // A tab colour as its attributes give it: RGB, or a theme or palette colour with its tint.
  const tab = attributes(head.match(/<(?:\w+:)?tabColor\b[^>]*>/)?.[0]);
  const color = Object.keys(tab).length ? ['rgb', 'theme', 'indexed', 'tint', 'auto']
    .map(key => tab[key] == null ? '' : key === 'rgb' ? tab[key].slice(-6).toUpperCase() : key === 'tint' ? String(Number(tab[key]) || 0) : tab[key].trim()).join('|') : null;
  const view = attributes(head.match(/<(?:\w+:)?sheetView\b[^>]*>/)?.[0]);
  // A row or column hidden, or given no height or width, which Excel shows as hidden too.
  const hiddenRows = [], hiddenCols = [], collapsedRows = [], collapsedCols = [], rowLevels = new Map(), colLevels = new Map();
  // Rows hidden by default are noted as the rows the part leaves hidden all the same, whichever way it says so.
  const byDefault = rowsHiddenByDefault(head), shownRows = [];
  eachRow(xml, start, close, (r, attrs) => {
    if ((attrs.includes('hidden') || attrs.includes('ht')) && HIDDEN_ROW.test(attrs)) hiddenRows.push(r);
    else if (byDefault) shownRows.push(r);
    if (!attrs.includes('outlineLevel') && !attrs.includes('collapsed')) return;
    const a = attributes(attrs);
    if (outlineLevel(a.outlineLevel)) rowLevels.set(r, outlineLevel(a.outlineLevel));
    if (on(a.collapsed)) collapsedRows.push(r);
  });
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
    hiddenRows: byDefault ? gaps(runs(shownRows)) : runs(hiddenRows),
    hiddenCols: runs(hiddenCols),
    rowLevels: levelRuns(rowLevels),
    colLevels: levelRuns(colLevels),
    collapsedRows: runs(collapsedRows),
    collapsedCols: runs(collapsedCols),
  };
}

/**
 * The version of each setting's note. A save writes them beside the note, and a note made under
 * another version (or before the notes had one) is no note at all: the record keeps the setting, as
 * for a file saved before the notes were made. Bump a setting's number whenever what is noted for it
 * changes for a part that did not, or every file saved before would read as changed in Excel, and the
 * part's word would take over from the record's fuller one. The validations' note is a hash of what
 * readXlsxValidations makes of them: any change to what that reader returns is such a change.
 */
export const NATIVE_STATE_VERSIONS = Object.freeze({
  protected: 1, color: 1, gridlines: 1, zoom: 1, zoomToFit: 1, hiddenRows: 1, hiddenCols: 1,
  rowLevels: 1, colLevels: 1, collapsedRows: 1, collapsedCols: 1, validations: 1,
});

/** Whether the record holds a note of the part's `key` made under this version of the note. */
export function nativeStateNoted(saved, key) {
  return !!saved && typeof saved === 'object' && Object.hasOwn(saved, key)
    && !!saved.versions && typeof saved.versions === 'object' && saved.versions[key] === NATIVE_STATE_VERSIONS[key];
}

/** Whether the part's `key` no longer says what the record noted it said at the last save here. */
export function nativeStateChanged(saved, current, key) {
  return nativeStateNoted(saved, key) && JSON.stringify(saved[key]) !== JSON.stringify(current?.[key]);
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
