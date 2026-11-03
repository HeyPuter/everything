/**
 * What a worksheet's own XML says of the settings this app's private record (the sidecar) also
 * holds. A save notes it beside those settings. Excel keeps the record when it saves the file
 * again, so a reopened file whose XML no longer says the same had that setting changed in another
 * program, and the XML's word wins over the record, which would otherwise undo the change (see
 * importSheet). The projection is of meaning, not spelling: Excel writing the same state its own
 * way (attributes in another order, defaults left out, column runs split or joined) is no change.
 */

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

/**
 * The state of a worksheet (or chart sheet) part: whether it is protected, its tab colour,
 * whether its first view shows gridlines, and its hidden rows and columns.
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
  const hiddenRows = [], hiddenCols = [];
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
  }
  for (const m of head.matchAll(/<(?:\w+:)?col\b[^>]*>/g)) {
    const a = attributes(m[0]), min = Number(a.min), max = Number(a.max);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 16384) continue;
    if (on(a.hidden) || (a.width != null && Number(a.width) === 0)) for (let c = min - 1; c < max; c++) hiddenCols.push(c);
  }
  return {
    protected: chart ? on(protection.content) || on(protection.objects) : on(protection.sheet),
    color,
    gridlines: !off(view.showGridLines),
    hiddenRows: runs(hiddenRows),
    hiddenCols: runs(hiddenCols),
  };
}

/** Whether the part's `key` no longer says what the record noted it said at the last save here. */
export function nativeStateChanged(saved, current, key) {
  return !!saved && typeof saved === 'object' && Object.hasOwn(saved, key) && JSON.stringify(saved[key]) !== JSON.stringify(current?.[key]);
}
