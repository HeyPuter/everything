/** Worksheet page setup, independent of browser/account print preferences. */
import { MAX_ROW, MAX_COL } from './refs.js';

export const PRINT_MARGINS = { left: .7, right: .7, top: .75, bottom: .75, header: .3, footer: .3 };
const TOKENS = { page: 'P', pages: 'N', date: 'D', time: 'T', tab: 'A', file: 'F' };
const nativeText = text => text.replace(/&&|&\[(page|pages|date|time|tab|file)\]/gi, (match, name) => name ? `&${TOKENS[name.toLowerCase()]}` : match).slice(0, 255);

export function normalizePrintSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const number = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  const margins = Object.fromEntries(Object.entries(PRINT_MARGINS).map(([key, fallback]) => [key, number(raw.margins?.[key], fallback, 0, 100)]));
  const areas = (Array.isArray(raw.areas) ? raw.areas : []).slice(0, 1024).filter(r => r &&
    ['r1', 'r2', 'c1', 'c2'].every(k => Number.isInteger(r[k])) && r.r1 >= 0 && r.c1 >= 0 &&
    r.r2 >= r.r1 && r.c2 >= r.c1 && r.r2 <= MAX_ROW && r.c2 <= MAX_COL).map(({ r1, c1, r2, c2 }) => ({ r1, c1, r2, c2 }));
  const titles = {};
  for (const [key, max] of [['titleRows', MAX_ROW], ['titleCols', MAX_COL]]) {
    const range = raw[key];
    if (Array.isArray(range) && range.length === 2 && range.every(Number.isInteger) && range[0] >= 0 && range[1] >= range[0] && range[1] <= max) titles[key] = [...range];
  }
  return { areas, ...titles, margins, pageOrder: raw.pageOrder === 'overThenDown' ? 'overThenDown' : 'downThenOver', orientation: raw.orientation === 'landscape' ? 'landscape' : 'portrait',
    // An omitted paper size uses the reader's locale/printer default, which need not
    // equal an explicit Letter selection (MS-OI29500 §2.1.638(h)). Preserve it.
    paperSize: raw.paperSize == null ? null : Math.trunc(number(raw.paperSize, 1, 1, 118)), scale: number(raw.scale, 100, 10, 400),
    // SpreadsheetML uses unsignedInt, including zero. Retain a dormant start
    // value when automatic numbering is selected.
    firstPageNumber: Number.isInteger(raw.firstPageNumber) ? number(raw.firstPageNumber, 1, 0, 4294967295) : 1,
    useFirstPageNumber: raw.useFirstPageNumber === true,
    fitToPage: raw.fitToPage === true, fitWidth: Math.trunc(number(raw.fitWidth, 1, 0, 32767)), fitHeight: Math.trunc(number(raw.fitHeight, 1, 0, 32767)),
    horizontalCentered: raw.horizontalCentered === true, verticalCentered: raw.verticalCentered === true,
    gridlines: raw.gridlines === true, headings: raw.headings === true,
    differentFirst: raw.differentFirst === true, differentOddEven: raw.differentOddEven === true,
    alignWithMargins: raw.alignWithMargins !== false,
    scaleWithDoc: raw.scaleWithDoc !== false,
    ...Object.fromEntries(['header', 'footer', 'evenHeader', 'evenFooter', 'firstHeader', 'firstFooter']
      .filter(key => typeof raw[key] === 'string').map(key => [key, nativeText(raw[key])])),
    ...(typeof raw.title === 'boolean' ? { title: raw.title } : {}),
    ...(typeof raw.repeatFrozen === 'boolean' ? { repeatFrozen: raw.repeatFrozen } : {}),
    ...pageBreakFields(raw) };
}

/** The most manual breaks a worksheet keeps on each axis (CT_PageBreak allows 1026). */
export const MAX_PAGE_BREAKS = 1026;

/**
 * Manual page breaks, each the index of the first row (or column) of a new page, ascending and without
 * repeats. Row 0 and column 0 start the first page already, so a break there means nothing.
 */
export function normalizePageBreaks(list, max) {
  if (!Array.isArray(list)) return [];
  const out = [...new Set(list.filter(n => Number.isInteger(n) && n > 0 && n <= max))].sort((a, b) => a - b);
  return out.slice(0, MAX_PAGE_BREAKS);
}

// Only a sheet with breaks carries the fields, so settings without any compare and save as before.
function pageBreakFields(raw) {
  const rows = normalizePageBreaks(raw.rowBreaks, MAX_ROW), cols = normalizePageBreaks(raw.colBreaks, MAX_COL);
  return { ...(rows.length ? { rowBreaks: rows } : {}), ...(cols.length ? { colBreaks: cols } : {}) };
}

/** Structural edits keep the saved print areas attached to their cells. */
export function mapPrintAreas(sheet, map, axis) {
  if (!sheet.printSettings) return;
  const p = { ...sheet.printSettings, areas: sheet.printSettings.areas.map(map).filter(Boolean) };
  // Title ranges are whole lines: an edit on the other axis cannot change them.
  const key = axis === 'row' ? 'titleRows' : 'titleCols', range = p[key];
  if (range) {
    const moved = map(axis === 'row' ? { r1: range[0], r2: range[1], c1: 0, c2: MAX_COL }
      : { c1: range[0], c2: range[1], r1: 0, r2: MAX_ROW });
    p[key] = moved ? axis === 'row' ? [moved.r1, moved.r2] : [moved.c1, moved.c2] : null;
  }
  // A manual break stays above (or left of) the line it was above as lines are inserted, deleted or
  // moved; a break whose line is deleted moves to the next line kept.
  const breaks = axis === 'row' ? 'rowBreaks' : 'colBreaks';
  if (p[breaks]?.length) {
    const lo = axis === 'row' ? 'r1' : 'c1';
    p[breaks] = p[breaks].map(at => map(axis === 'row' ? { r1: at, r2: at, c1: 0, c2: 0 } : { c1: at, c2: at, r1: 0, r2: 0 })?.[lo]).filter(Number.isInteger);
  }
  sheet.printSettings = normalizePrintSettings(p);
}
